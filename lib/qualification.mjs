/**
 * The bridge to the qualification engine.
 *
 * ── WHAT THIS FILE DOES NOT DO ──────────────────────────────────────────────
 * It does not reimplement, copy, wrap, "clean up" or fork any rule. `hcm.js`,
 * `offshoring.js`, `signals.js` and `normalize.js` in `local-scraper/lib/` are
 * imported and executed exactly as they are. They encode bugs found against
 * real LinkedIn data over many iterations — the a11y-suffix strip, the top-5
 * truncation bounds, "Cairo, Egypt" not being a country row, case-sensitive
 * university abbreviations, hrCount being the MAX across signals rather than
 * the sum — and every one of those was a wrong answer shipped before it was a
 * line of code. Re-deriving them would re-derive the bugs.
 *
 * So the CRM owns exactly two things here:
 *
 *   1. the SNAPSHOT ADAPTER — turning a stored evidence payload into the shape
 *      the rule modules expect. This is a field mapping, not logic. It mirrors
 *      `verdicts.mjs`'s private `toSnapshot`, which is not exported; duplicating
 *      15 lines of mapping is the smaller evil against editing a file the
 *      working system runs from.
 *
 *   2. PERSISTENCE — evidence in, verdicts out, both append-only.
 *
 * ── THE THREE INVARIANTS (docs/03 §5) ───────────────────────────────────────
 *  I1  Evidence and conclusion are separate. Collection is expensive and
 *      rate-limited; evaluation is free and offline. Re-qualifying 223
 *      companies under a changed rule takes seconds and costs nothing — but
 *      only while the raw panels are still stored.
 *  I2  Verdicts are immutable and versioned. Re-running APPENDS. Changing the
 *      HCM band from ">= 20" to "20-50" moved 117 of 223 verdicts and nothing
 *      recorded it; in a CRM with reps working those accounts, that is the
 *      system contradicting itself overnight with no explanation available.
 *  I3  Absence of evidence is never a negative answer. Three verdicts, always.
 *      REVIEW is not a soft REJECTED.
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { all, get, run, tx, id, now, json, ROOT } from './db.mjs';
import { audit, ensureDealForAccount, advanceDealToStage } from './repo.mjs';
import { badRequest } from './http.mjs';

/**
 * Where the qualifier project is.
 *
 * It has lived in two places: beside this one, and — as now — inside it. Both
 * are real layouts on real machines, so both are tried rather than one being
 * declared correct. Nothing changes about the rule that matters: the CRM reads
 * the rules from that folder instead of keeping a copy, so the two can never
 * disagree about what QUALIFIED means.
 *
 * `local-scraper/lib` is tracked by this repository (and only lib — see
 * .gitignore) because a deployed CRM has no sibling checkout to read from, and
 * without it every qualification run fails.
 */
function scraperRoot() {
    const inside = path.join(ROOT, 'local-scraper');
    if (fs.existsSync(path.join(inside, 'lib'))) return inside;
    return path.join(path.dirname(ROOT), 'local-scraper');
}

export const SCRAPER_ROOT = scraperRoot();

export const QUALIFIER_LIB = process.env.QUALIFIER_LIB ?? path.join(SCRAPER_ROOT, 'lib');

/**
 * Evidence collected by the scraper. Optional: every reader checks it exists
 * first, because it is a working file of that project, not a CRM asset, and it
 * carries client data that has no business in this repository.
 */
export const SNAPSHOTS_FILE = process.env.QUALIFIER_SNAPSHOTS
    ?? path.join(SCRAPER_ROOT, 'snapshots.json');

let engines = null;

export async function loadEngines() {
    if (engines) return engines;

    const required = ['hcm.js', 'offshoring.js', 'signals.js', 'normalize.js', 'labels.mjs'];
    const missing = required.filter((f) => !fs.existsSync(path.join(QUALIFIER_LIB, f)));
    if (missing.length) {
        throw new Error(
            `The qualification engine was not found at ${QUALIFIER_LIB} (missing: ${missing.join(', ')}).\n`
            + 'The CRM reads the rules from the local-scraper project rather than copying them, so the two '
            + 'can never disagree. Set QUALIFIER_LIB to point at that lib/ folder.',
        );
    }

    const load = (file) => import(pathToFileURL(path.join(QUALIFIER_LIB, file)).href);
    const [hcm, offshoring, labels] = await Promise.all([
        load('hcm.js'), load('offshoring.js'), load('labels.mjs'),
    ]);

    engines = {
        hcm: {
            key: 'hcm',
            label: 'HCM (HR gap)',
            engineId: hcm.ID,
            title: hcm.TITLE,
            summary: hcm.SUMMARY,
            defaults: hcm.DEFAULTS,
            // An ABSENCE test: finding no HR proves nothing unless you looked
            // everywhere, so coverage gates the QUALIFY.
            claimType: 'absence',
            run: hcm.run,
        },
        offshoring: {
            key: 'offshoring',
            label: 'Offshoring (Egypt footprint)',
            engineId: offshoring.ID,
            title: offshoring.TITLE,
            summary: offshoring.SUMMARY,
            defaults: offshoring.DEFAULTS,
            // A PRESENCE test: observing 2 people in Egypt proves 2 exist at any
            // coverage, so coverage gates the REJECT instead.
            claimType: 'presence',
            run: offshoring.run,
        },
        cleanFacets: labels.cleanFacets,
    };
    return engines;
}

/**
 * Evidence payload -> the snapshot shape the rule modules read.
 *
 * Facet labels are cleaned here as well as at collection time. LinkedIn appends
 * hidden screen-reader text, so labels arrive as "Egypt toggle off" and match
 * nothing; cleaning on read means snapshots taken before that fix still qualify
 * correctly without re-collecting them.
 */
export function toSnapshot(payload, cleanFacets) {
    const about = payload.about ?? {};
    return {
        universalName: payload.slug,
        companyUrl: payload.companyUrl,
        companyName: payload.companyName ?? payload.slug,
        industry: about.industry ?? null,
        staffCount: null,
        staffCountRangeStart: null,
        totalAssociatedMembers: Number.isFinite(payload.totalMembers) ? payload.totalMembers : null,
        derived: null,
        facets: {
            location: cleanFacets(payload.locations),
            function: cleanFacets(payload.functions),
            school: cleanFacets(payload.schools),
            skill: cleanFacets(payload.skills),
            title: [],
            certification: [],
        },
        provenance: { provider: payload.provider ?? 'local-browser', requests: 1, warnings: [] },
    };
}

/* ------------------------------------------------------------------ rules -- */

export function activeRules(workspaceId) {
    return all(
        `SELECT r.* FROM qualification_rules r
          WHERE r.workspace_id = ? AND r.active = 1
            AND r.version = (SELECT MAX(version) FROM qualification_rules
                              WHERE workspace_id = r.workspace_id AND key = r.key)
          ORDER BY r.key`,
        [workspaceId],
    ).map((r) => ({ ...r, config: json(r.config, {}) }));
}

export function ruleHistory(workspaceId, key) {
    return all(
        'SELECT * FROM qualification_rules WHERE workspace_id = ? AND key = ? ORDER BY version DESC',
        [workspaceId, key],
    ).map((r) => ({ ...r, config: json(r.config, {}) }));
}

export function currentRule(workspaceId, key) {
    const rule = activeRules(workspaceId).find((r) => r.key === key);
    if (!rule) throw badRequest(`No active rule named "${key}".`);
    return rule;
}

/**
 * Publishing a rule change creates a NEW VERSION. It never edits the old one,
 * because verdicts already point at it and "why did this account change?" must
 * always be answerable with either "the rule changed" or "the evidence changed".
 */
export function publishRuleVersion(ctx, key, config, label) {
    const previous = ruleHistory(ctx.workspaceId, key)[0];
    if (!previous) throw badRequest(`No rule named "${key}".`);
    validateRuleConfig(key, config);

    const version = previous.version + 1;
    const ruleId = id('rul');
    run(
        `INSERT INTO qualification_rules
           (id, workspace_id, key, label, engine, claim_type, version, summary, config, active, created_at, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`,
        [
            ruleId, ctx.workspaceId, key, label ?? previous.label, previous.engine, previous.claim_type,
            version, summariseConfig(key, config), JSON.stringify(config), now(), ctx.userId,
        ],
    );
    audit(ctx, {
        objectKey: 'qualification_rule',
        recordId: ruleId,
        action: 'rule_published',
        before: previous.config,
        after: { version, config },
    });
    return currentRule(ctx.workspaceId, key);
}

function summariseConfig(key, config) {
    if (key === 'hcm') {
        const ceiling = config.maxHeadcount === null || config.maxHeadcount === undefined ? '∞' : config.maxHeadcount;
        return `headcount ${config.minHeadcount ?? 20}-${ceiling} AND HR employees <= ${config.maxHrCount ?? 1}`;
    }
    if (key === 'offshoring') {
        // Matches the field the engine itself reads — `local-scraper/lib/
        // offshoring.js` has only ever read `minEgyptCount`. This used to
        // describe `minHeadcount`/`country`/`minCountryCount`, none of
        // which the engine looks at, so an admin editing this rule read a
        // summary of a threshold that was not the one actually deciding
        // the verdict.
        return `Egypt-based employees >= ${config.minEgyptCount ?? 20}`;
    }
    return '';
}

/**
 * Rejects a config shape the engine cannot evaluate before it reaches
 * `qualification_rules`, rather than after — a malformed number here
 * (`config.maxHeadcount` as the string `"abc"`, say) makes `totalMembers <=
 * maxHeadcount` a `NaN` comparison that is always false, so the rule would
 * have silently REJECTED every account re-qualified under it, with nothing
 * anywhere to say why. Every field is optional (the engine's own `DEFAULTS`
 * fill the gaps); this only refuses a field that was GIVEN and is not the
 * shape the engine can use.
 */
const RULE_CONFIG_SHAPE = {
    hcm: {
        minHeadcount: 'number', maxHeadcount: 'number|null', minHrCount: 'number', maxHrCount: 'number',
    },
    offshoring: {
        minEgyptCount: 'number',
    },
};

function validateRuleConfig(key, config) {
    const shape = RULE_CONFIG_SHAPE[key];
    if (!shape || !config || typeof config !== 'object') return;
    for (const [field, type] of Object.entries(shape)) {
        if (!Object.prototype.hasOwnProperty.call(config, field)) continue;
        const value = config[field];
        const nullable = type.endsWith('|null');
        if (nullable && (value === null || value === undefined)) continue;
        if (type.startsWith('number') && !(typeof value === 'number' && Number.isFinite(value))) {
            throw badRequest(`"${field}" must be a number${nullable ? ' (or empty)' : ''} — got ${JSON.stringify(value)}.`);
        }
    }
}

/* --------------------------------------------------------------- evidence -- */

const SUBJECTS = {
    account: {
        table: 'accounts',
        evidenceTable: 'evidence_snapshots',
        verdictTable: 'verdicts',
        idColumn: 'account_id',
        subjectType: 'account',
    },
    prospect: {
        table: 'prospecting_companies',
        evidenceTable: 'prospecting_evidence_snapshots',
        verdictTable: 'prospecting_verdicts',
        idColumn: 'prospect_id',
        subjectType: 'prospect',
    },
};

function subjectInfo(subjectType) {
    const info = SUBJECTS[subjectType];
    if (!info) throw badRequest(`Unknown subject type "${subjectType}".`);
    return info;
}

function getSubject(ctx, subjectType, subjectId) {
    const info = subjectInfo(subjectType);
    return get(`SELECT * FROM ${info.table} WHERE id = ? AND workspace_id = ?`, [subjectId, ctx.workspaceId]);
}

export function latestEvidence(workspaceId, subjectId, subjectType = 'account') {
    const info = subjectInfo(subjectType);
    return get(
        `SELECT * FROM ${info.evidenceTable}
          WHERE workspace_id = ? AND ${info.idColumn} = ?
          ORDER BY collected_at DESC LIMIT 1`,
        [workspaceId, subjectId],
    );
}

export function evidenceHistory(workspaceId, subjectId, limit = 25, subjectType = 'account') {
    const info = subjectInfo(subjectType);
    return all(
        `SELECT * FROM ${info.evidenceTable} WHERE workspace_id = ? AND ${info.idColumn} = ? ORDER BY collected_at DESC LIMIT ?`,
        [workspaceId, subjectId, limit],
    ).map((row) => ({ ...row, payload: json(row.payload, {}) }));
}

/** Evidence is immutable: a new observation is a new row, never an overwrite. */
export function recordEvidence(ctx, { accountId = null, prospectId = null, subjectKey, provider, collectedAt, payload, error = null }) {
    const subjectType = prospectId ? 'prospect' : 'account';
    const subjectId = prospectId ?? accountId;
    const info = subjectInfo(subjectType);
    const evidenceId = id('evd');
    run(
        `INSERT INTO ${info.evidenceTable}
           (id, workspace_id, subject_type, subject_key, ${info.idColumn}, provider, collected_at, payload, error, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
            evidenceId, ctx.workspaceId, info.subjectType, subjectKey, subjectId,
            provider, collectedAt ?? now(), JSON.stringify(payload ?? {}), error, now(),
        ],
    );
    return evidenceId;
}

export async function qualifyProspect(ctx, prospectId, ruleKey, options = {}) {
    return qualifySubject(ctx, 'prospect', prospectId, ruleKey, options);
}

export async function qualifyAccount(ctx, accountId, ruleKey, options = {}) {
    return qualifySubject(ctx, 'account', accountId, ruleKey, options);
}

export function verdictHistory(workspaceId, subjectId, subjectType = 'account') {
    const info = subjectInfo(subjectType);
    return all(
        `SELECT * FROM ${info.verdictTable} WHERE workspace_id = ? AND ${info.idColumn} = ? ORDER BY computed_at DESC`,
        [workspaceId, subjectId],
    ).map((row) => ({ ...row, metrics: json(row.metrics, {}), reasons: json(row.reasons, []), notes: json(row.notes, []) }));
}

/* --------------------------------------------------------------- verdicts -- */

/**
 * Evaluates one subject under one rule and appends the verdict.
 *
 * Returns `{ verdict, changed, previous }` so a bulk run can report what
 * actually moved — which is the report nobody had when 117 verdicts changed
 * silently.
 */
export async function qualifySubject(ctx, subjectType, subjectId, ruleKey, { source = 'ui', evidence = null } = {}) {
    const eng = await loadEngines();
    const engine = eng[ruleKey];
    if (!engine) throw badRequest(`No qualification engine named "${ruleKey}".`);

    const rule = currentRule(ctx.workspaceId, ruleKey);
    const info = subjectInfo(subjectType);
    const subject = getSubject(ctx, subjectType, subjectId);
    if (!subject) throw badRequest(`That ${info.subjectType} does not exist.`);

    const snap = evidence ?? latestEvidence(ctx.workspaceId, subjectId, subjectType);
    const previous = get(
        `SELECT * FROM ${info.verdictTable} WHERE ${info.idColumn} = ? AND rule_key = ? AND is_current = 1`,
        [subjectId, ruleKey],
    );

    let result;
    if (!snap) {
        result = {
            verdict: 'UNRESOLVED',
            confidence: 0,
            metrics: {},
            reasons: [subject.linkedin_slug
                ? `No evidence has been collected for this ${info.subjectType} yet.`
                : `This ${info.subjectType} has no LinkedIn slug or domain, so there is no identity to collect against.`],
            notes: [],
        };
    } else if (snap.error) {
        result = { verdict: 'ERROR', confidence: 0, metrics: {}, reasons: [snap.error], notes: [] };
    } else {
        const payload = json(snap.payload, {});
        const snapshot = toSnapshot(payload, eng.cleanFacets);
        const outcome = engine.run(snapshot, rule.config);
        result = {
            verdict: outcome.verdict,
            confidence: outcome.confidence,
            metrics: outcome.metrics,
            reasons: outcome.reasons,
            notes: outcome.notes,
        };
    }

    const verdictId = id('vdt');
    const stamp = now();
    const changed = !previous
        || previous.verdict !== result.verdict
        || previous.rule_version !== rule.version;

    tx(() => {
        if (previous) {
            run(`UPDATE ${info.verdictTable} SET is_current = 0, superseded_at = ? WHERE id = ?`, [stamp, previous.id]);
        }
        run(
            `INSERT INTO ${info.verdictTable}
               (id, workspace_id, subject_type, subject_key, ${info.idColumn}, rule_key, rule_version, evidence_id,
                verdict, confidence, metrics, reasons, notes, computed_at, is_current)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
            [
                verdictId, ctx.workspaceId, info.subjectType,
                subject.linkedin_slug ?? subject.domain ?? subject.id,
                subjectId, ruleKey, rule.version, snap?.id ?? null,
                result.verdict, result.confidence ?? null,
                JSON.stringify(result.metrics ?? {}),
                JSON.stringify(result.reasons ?? []),
                JSON.stringify(result.notes ?? []),
                stamp,
            ],
        );

        if (changed) {
            audit(ctx, {
                objectKey: 'verdict',
                recordId: verdictId,
                accountId: subjectType === 'account' ? subjectId : null,
                action: 'verdict_computed',
                before: previous ? { verdict: previous.verdict, rule_version: previous.rule_version } : null,
                after: { verdict: result.verdict, rule_version: rule.version, rule_key: ruleKey },
                source,
            });
        }
        if (subjectType === 'account') {
            applyLifecycle(ctx, subject, ruleKey, result.verdict, source);
        } else {
            recomputeStatus(ctx, subjectId);
        }
    });

    return {
        id: verdictId,
        [info.idColumn === 'account_id' ? 'accountId' : 'prospectId']: subjectId,
        subjectType,
        rule: ruleKey,
        ruleVersion: rule.version,
        verdict: result.verdict,
        previous: previous?.verdict ?? null,
        changed,
        confidence: result.confidence,
        metrics: result.metrics,
        reasons: result.reasons,
        notes: result.notes,
        computedAt: stamp,
    };
}

/**
 * A human decision, recorded as a verdict.
 *
 * This is how a REVIEW gets settled from inside the CRM. Someone opens the
 * company's People tab, filters by country or function, sees what the panels
 * could not show, and records the answer.
 *
 * Four things it deliberately does NOT do:
 *
 *  1. It does not edit the engine's verdict. The decision is APPENDED and
 *     supersedes, exactly like a re-run, so the rule's own answer stays
 *     readable underneath it forever. `source` says which is which.
 *  2. It does not pretend to be the engine. `source = 'manual'`, the decider is
 *     named, and a reason is REQUIRED — an override with no stated reason is
 *     indistinguishable from a mis-click three months later.
 *  3. It does not survive a re-run silently. A later engine run supersedes it
 *     in turn, which is correct: new evidence beats an old judgement, and the
 *     history shows both.
 *  4. It does not accept UNRESOLVED. That verdict means "there is no identity
 *     to collect against", which is a fact about the data, not a decision a
 *     person can make.
 */
const DECIDABLE = ['QUALIFIED', 'REVIEW', 'REJECTED'];

export function recordDecision(ctx, accountId, ruleKey, { verdict, reason, source = 'manual' }) {
    if (!DECIDABLE.includes(verdict)) {
        throw badRequest(`A person can decide ${DECIDABLE.join(', ')} — not "${verdict}". `
            + 'UNRESOLVED and ERROR describe the data, not a judgement.');
    }
    const clean = String(reason ?? '').trim();
    if (clean.length < 3) {
        throw badRequest('Give a reason. A verdict a person set by hand, with no reason recorded, cannot be explained later.');
    }

    const rule = currentRule(ctx.workspaceId, ruleKey);
    const account = get('SELECT * FROM accounts WHERE id = ? AND workspace_id = ?', [accountId, ctx.workspaceId]);
    if (!account) throw badRequest('That account does not exist.');

    const previous = get(
        'SELECT * FROM verdicts WHERE account_id = ? AND rule_key = ? AND is_current = 1',
        [accountId, ruleKey],
    );
    const latest = latestEvidence(ctx.workspaceId, accountId);
    const verdictId = id('vdt');
    const stamp = now();

    tx(() => {
        if (previous) {
            run('UPDATE verdicts SET is_current = 0, superseded_at = ? WHERE id = ?', [stamp, previous.id]);
        }
        run(
            `INSERT INTO verdicts
               (id, workspace_id, account_id, rule_key, rule_version, evidence_id, verdict, confidence,
                metrics, reasons, notes, source, decided_by, decision_note, computed_at, is_current)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
            [
                verdictId, ctx.workspaceId, accountId, ruleKey, rule.version, latest?.id ?? null,
                verdict,
                // No confidence figure. A person's judgement does not carry the
                // engine's coverage arithmetic, and inventing a number for it
                // would make a manual verdict look computed.
                null,
                JSON.stringify({}),
                JSON.stringify([`DECIDED: ${ctx.user?.name ?? 'A user'} recorded this verdict by hand — ${clean}`]),
                JSON.stringify([
                    'Set by a person, not by the rule. The engine\'s own verdict is still in this account\'s history.',
                    previous ? `It replaced ${previous.verdict} from rule v${previous.rule_version}.` : 'There was no previous verdict.',
                ]),
                source, ctx.userId, clean, stamp,
            ],
        );
        audit(ctx, {
            objectKey: 'verdict',
            recordId: verdictId,
            accountId,
            action: 'verdict_decided',
            before: previous ? { verdict: previous.verdict, source: previous.source ?? 'engine' } : null,
            after: { verdict, rule_key: ruleKey, rule_version: rule.version, source, reason: clean },
        });
        applyLifecycle(ctx, account, ruleKey, verdict, 'manual');
    });

    return {
        id: verdictId,
        accountId,
        rule: ruleKey,
        verdict,
        previous: previous?.verdict ?? null,
        source,
        reason: clean,
        computedAt: stamp,
        note: 'Recorded as a new verdict. The engine\'s answer is unchanged and still visible in the history. '
            + 'Re-running the rule will supersede this decision with a fresh computed verdict.',
    };
}

/**
 * Recomputes a prospect's rollup status from its per-service verdicts.
 *
 * THE SINGLE WRITER of `prospecting_companies.status`. Nothing else may set that
 * column, which is why the field is `readOnly` in the object registry.
 *
 * The collapse rule, stated once here so it cannot drift:
 *
 *   imported        the prospect has been imported into the CRM. Terminal, and
 *                   checked FIRST — a re-qualification must never drag a company
 *                   the sales team is already working back into the queue.
 *   qualified       QUALIFIED by AT LEAST ONE active rule. Optimistic on purpose:
 *                   this business sells four services, and a company that is
 *                   right for offshoring is a lead even if HCM rejected it.
 *   review_required at least one rule returned REVIEW and none QUALIFIED. The
 *                   evidence could not answer; a person still can.
 *   rejected        EVERY active rule returned REJECTED. Unanimity, the same bar
 *                   applyLifecycle() uses, for the same reason: one REJECTED
 *                   beside one REVIEW is one answer and one non-answer.
 *   uploaded        nothing has been evaluated yet.
 *
 * ERROR and UNRESOLVED deliberately land in `uploaded` rather than a status of
 * their own: both mean "we have not managed to judge this", which is a work
 * queue, not a verdict. The per-rule verdict still says which it was.
 */
export function recomputeStatus(ctx, prospectId) {
    const prospect = get('SELECT * FROM prospecting_companies WHERE id = ? AND workspace_id = ?',
        [prospectId, ctx.workspaceId]);
    if (!prospect) return null;
    if (prospect.imported_at) return prospect.status;

    const ruleKeys = all(
        'SELECT key FROM qualification_rules WHERE workspace_id = ? AND active = 1 GROUP BY key',
        [ctx.workspaceId],
    ).map((r) => r.key);
    const current = new Map(
        all('SELECT rule_key, verdict FROM prospecting_verdicts WHERE prospect_id = ? AND is_current = 1', [prospectId])
            .map((v) => [v.rule_key, v.verdict]),
    );
    const verdicts = ruleKeys.map((key) => current.get(key) ?? 'UNRESOLVED');

    let next = 'uploaded';
    if (verdicts.includes('QUALIFIED')) next = 'qualified';
    else if (ruleKeys.length && verdicts.every((v) => v === 'REJECTED')) next = 'rejected';
    else if (verdicts.includes('REVIEW')) next = 'review_required';

    if (next === prospect.status) return next;
    run('UPDATE prospecting_companies SET status = ?, updated_at = ? WHERE id = ?', [next, now(), prospectId]);
    audit(ctx, {
        objectKey: 'prospecting_company',
        recordId: prospectId,
        action: 'status_changed',
        before: { status: prospect.status },
        after: { status: next, from: Object.fromEntries(current) },
        source: 'automation',
    });
    return next;
}

/**
 * Lifecycle promotion on a verdict.
 *
 * Deliberately conservative:
 *
 *  - a QUALIFIED verdict promotes a `prospect` OR a `disqualified` account to
 *    `qualified`
 *  - a REJECTED verdict disqualifies a `prospect`, and only while no other rule
 *    still qualifies it
 *  - REVIEW never moves anything, because REVIEW is not an answer
 *
 * The `disqualified -> qualified` direction matters more than it looks. Rules
 * are evaluated one at a time, so an account rejected by HCM and then qualified
 * by offshoring would otherwise be stuck at disqualified purely because of the
 * order the two rules happened to run in. An account that qualifies for ANY
 * service line is qualified.
 *
 * An account a rep is already working (`engaged`, `customer`, `churned`) is
 * NEVER moved by a rule. A re-run at 2am must not pull an account out from
 * under the person negotiating with it.
 */
function applyLifecycle(ctx, account, ruleKey, verdict, source) {
    const movable = verdict === 'QUALIFIED' ? ['prospect', 'disqualified'] : ['prospect'];
    if (!movable.includes(account.lifecycle_stage)) return;

    let next = null;
    if (verdict === 'QUALIFIED') next = 'qualified';
    else if (verdict === 'REJECTED') next = 'disqualified';
    if (!next || next === account.lifecycle_stage) return;

    /**
     * Disqualifying takes UNANIMITY across every active rule.
     *
     * One rule saying REJECTED while another is still REVIEW is not a
     * rejection — it is one answer and one non-answer, and treating that pair
     * as "no" is precisely the collapse the three-verdict model exists to
     * prevent. An account nobody has qualified and somebody has not finished
     * judging stays a prospect: unjudged, hidden from the working views, and
     * sitting in the review queue where it can be settled.
     */
    if (next === 'disqualified') {
        const rules = all(
            'SELECT key FROM qualification_rules WHERE workspace_id = ? AND active = 1 GROUP BY key',
            [ctx.workspaceId],
        ).map((r) => r.key);
        const current = new Map(
            all('SELECT rule_key, verdict FROM verdicts WHERE account_id = ? AND is_current = 1', [account.id])
                .map((v) => [v.rule_key, v.verdict]),
        );
        current.set(ruleKey, verdict);
        const allRejected = rules.every((key) => current.get(key) === 'REJECTED');
        if (!allRejected) return;
    }

    run('UPDATE accounts SET lifecycle_stage = ?, updated_at = ? WHERE id = ?', [next, now(), account.id]);
    audit(ctx, {
        objectKey: 'account',
        recordId: account.id,
        accountId: account.id,
        action: 'lifecycle_changed',
        before: { lifecycle_stage: account.lifecycle_stage },
        after: { lifecycle_stage: next, because: `${ruleKey} verdict ${verdict}` },
        source: source === 'ui' ? 'automation' : source,
    });

    /**
     * A qualified account is an interested one, in pipeline vocabulary — the
     * same stage a call outcome of "Qualified" already lands a deal on (see
     * `OUTCOME_STAGES` in lib/calling.mjs). Without this, an account qualified
     * by the engine sat at `interested` in name only on the account record,
     * while its deal — the thing the commercial pipeline actually reports
     * by — never moved. Forward-only, like every other automated move: a
     * deal already past `interested` does not lose ground because a rule
     * re-ran.
     */
    if (next === 'qualified') {
        const deal = ensureDealForAccount(ctx, account.id, `qualified by ${ruleKey}`);
        if (deal) advanceDealToStage(ctx, deal.id, 'interested', `qualified by ${ruleKey}`);
    }
}

/**
 * Re-qualifies many accounts and reports the transitions.
 *
 * The `changes` array is the point of this function. Publishing a rule change
 * without seeing "3 accounts go QUALIFIED -> REJECTED, two of them have open
 * deals" is how a CRM contradicts itself overnight.
 */
export async function qualifyMany(ctx, accountIds, ruleKeys, { source = 'ui' } = {}) {
    const summary = {};
    const changes = [];

    for (const ruleKey of ruleKeys) {
        summary[ruleKey] = { QUALIFIED: 0, REVIEW: 0, REJECTED: 0, UNRESOLVED: 0, ERROR: 0, changed: 0 };
        for (const accountId of accountIds) {
            const out = await qualifyAccount(ctx, accountId, ruleKey, { source });
            summary[ruleKey][out.verdict] = (summary[ruleKey][out.verdict] ?? 0) + 1;
            if (out.changed && out.previous) {
                summary[ruleKey].changed += 1;
                changes.push({
                    accountId,
                    rule: ruleKey,
                    from: out.previous,
                    to: out.verdict,
                    // The transitions that actually hurt: an account someone was
                    // told to call, now told not to.
                    dangerous: out.previous === 'QUALIFIED' && out.verdict !== 'QUALIFIED',
                });
            }
        }
    }

    if (changes.length) {
        const withDeals = all(
            `SELECT DISTINCT a.id, a.name FROM accounts a
               JOIN deals d ON d.account_id = a.id AND d.status = 'open' AND d.deleted_at IS NULL
              WHERE a.id IN (${changes.map(() => '?').join(',')})`,
            changes.map((c) => c.accountId),
        );
        const dealAccounts = new Map(withDeals.map((r) => [r.id, r.name]));
        for (const c of changes) {
            c.hasOpenDeal = dealAccounts.has(c.accountId);
            c.accountName = dealAccounts.get(c.accountId) ?? null;
        }
    }

    return { summary, changes, accounts: accountIds.length };
}

/**
 * A dry run: what WOULD change if this config were published, without writing
 * anything. This is the impact preview the design docs require before any
 * metadata change that alters existing records.
 */
export async function previewRule(ctx, ruleKey, config) {
    const eng = await loadEngines();
    const engine = eng[ruleKey];
    if (!engine) throw badRequest(`No qualification engine named "${ruleKey}".`);

    const rows = all(
        `SELECT e.id AS evidence_id, e.payload, e.error, a.id AS account_id, a.name, a.lifecycle_stage,
                (SELECT v.verdict FROM verdicts v
                  WHERE v.account_id = a.id AND v.rule_key = ? AND v.is_current = 1) AS current_verdict
           FROM accounts a
           JOIN evidence_snapshots e ON e.id = (
                SELECT id FROM evidence_snapshots
                 WHERE account_id = a.id ORDER BY collected_at DESC LIMIT 1)
          WHERE a.workspace_id = ? AND a.deleted_at IS NULL`,
        [ruleKey, ctx.workspaceId],
    );

    const transitions = new Map();
    const dangerous = [];
    const tally = { QUALIFIED: 0, REVIEW: 0, REJECTED: 0, ERROR: 0 };

    for (const row of rows) {
        let verdict = 'ERROR';
        if (!row.error) {
            const snapshot = toSnapshot(json(row.payload, {}), eng.cleanFacets);
            verdict = engine.run(snapshot, config).verdict;
        }
        tally[verdict] = (tally[verdict] ?? 0) + 1;

        const from = row.current_verdict ?? 'UNRESOLVED';
        if (from !== verdict) {
            const key = `${from} → ${verdict}`;
            transitions.set(key, (transitions.get(key) ?? 0) + 1);
            if (from === 'QUALIFIED' && verdict !== 'QUALIFIED') {
                dangerous.push({ accountId: row.account_id, name: row.name, from, to: verdict });
            }
        }
    }

    const openDeals = dangerous.length
        ? all(
            `SELECT DISTINCT account_id FROM deals
              WHERE status = 'open' AND deleted_at IS NULL
                AND account_id IN (${dangerous.map(() => '?').join(',')})`,
            dangerous.map((d) => d.accountId),
        ).map((r) => r.account_id)
        : [];
    const openSet = new Set(openDeals);
    for (const d of dangerous) d.hasOpenDeal = openSet.has(d.accountId);

    return {
        evaluated: rows.length,
        tally,
        transitions: [...transitions.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
        // Named, not counted. "3 accounts will stop qualifying" is a statistic;
        // "AFCO STEEL, which has an open deal, will stop qualifying" is a decision.
        dangerous: dangerous.slice(0, 50),
        dangerousTotal: dangerous.length,
        withOpenDeals: dangerous.filter((d) => d.hasOpenDeal).length,
    };
}

/**
 * Verdict counts for a workspace, per rule.
 *
 * ALWAYS returns all three answers plus the two non-answers, even when a bucket
 * is zero. A chart with QUALIFIED and REJECTED and no REVIEW is a lie by
 * omission, and REVIEW is frequently the largest bucket.
 */
export function verdictTally(workspaceId) {
    const rows = all(
        `SELECT rule_key, verdict, COUNT(*) AS n
           FROM verdicts v
           JOIN accounts a ON a.id = v.account_id AND a.deleted_at IS NULL
          WHERE v.workspace_id = ? AND v.is_current = 1
          GROUP BY rule_key, verdict`,
        [workspaceId],
    );
    const out = {};
    for (const rule of activeRules(workspaceId)) {
        out[rule.key] = { label: rule.label, summary: rule.summary, version: rule.version, QUALIFIED: 0, REVIEW: 0, REJECTED: 0, UNRESOLVED: 0, ERROR: 0 };
    }
    for (const row of rows) {
        if (!out[row.rule_key]) out[row.rule_key] = { label: row.rule_key, QUALIFIED: 0, REVIEW: 0, REJECTED: 0, UNRESOLVED: 0, ERROR: 0 };
        out[row.rule_key][row.verdict] = row.n;
    }
    return out;
}

/**
 * How old a verdict is allowed to be before it is shown with reduced emphasis.
 * A two-year-old QUALIFIED is not a lead, and it must not look like a fresh one.
 */
export function isStale(computedAt, staleDays) {
    if (!computedAt) return true;
    return Date.now() - new Date(computedAt).getTime() > staleDays * 864e5;
}
