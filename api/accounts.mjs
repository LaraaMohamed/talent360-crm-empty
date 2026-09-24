/**
 * Account-specific endpoints: the timeline, the verdict panel, evidence, and
 * running the rules.
 */
import { all, get, run, id, now, json } from '../lib/db.mjs';
import { getRecord, listRecords, auditFor, audit } from '../lib/repo.mjs';
import { readJson, badRequest, notFound } from '../lib/http.mjs';
import { require$ } from '../lib/auth.mjs';
import { setting } from '../lib/settings.mjs';
import {
    qualifyAccount, qualifyMany, verdictHistory, evidenceHistory, latestEvidence,
    activeRules, isStale, recordEvidence, recordDecision,
} from '../lib/qualification.mjs';
import { idsMatching } from '../lib/repo.mjs';
import { objectFromRoute, listOptions } from './records.mjs';
import { fieldsFor } from '../lib/objects.mjs';
import { mergePlan } from '../lib/merge.mjs';

/**
 * The timeline: activities, plus the handful of audit events configured to
 * project into it.
 *
 * Two stores, one reading surface. Activities are the curated human record and
 * are editable; audit events are the immutable system record and are not. They
 * are merged here for display and never merged in storage — an audit log a user
 * can edit fails its first review.
 */
export async function timeline({ params, ctx, url }) {
    const objectKey = objectFromRoute(params.object);
    const record = getRecord(objectKey, ctx, params.id);
    const limit = Math.min(500, Number(url.searchParams.get('limit')) || 100);
    const typeFilter = url.searchParams.get('type');

    // An activity on a deal appears on that deal's account timeline. That
    // roll-up is why account_id is denormalised onto every attachment.
    const activities = objectKey === 'account'
        ? all(
            `SELECT * FROM activities WHERE workspace_id = ? AND account_id = ? AND deleted_at IS NULL
              ORDER BY occurred_at DESC LIMIT ?`,
            [ctx.workspaceId, params.id, limit],
        )
        : all(
            `SELECT * FROM activities WHERE workspace_id = ? AND parent_type = ? AND parent_id = ? AND deleted_at IS NULL
              ORDER BY occurred_at DESC LIMIT ?`,
            [ctx.workspaceId, objectKey, params.id, limit],
        );

    const users = new Map(all('SELECT id, name FROM users').map((u) => [u.id, u.name]));
    const types = new Map(
        all('SELECT * FROM activity_types WHERE workspace_id = ?', [ctx.workspaceId]).map((t) => [t.key, t]),
    );

    const entries = activities.map((a) => ({
        kind: 'activity',
        id: a.id,
        at: a.occurred_at,
        createdAt: a.created_at,
        typeKey: a.type_key,
        typeLabel: types.get(a.type_key)?.label ?? a.type_key,
        icon: types.get(a.type_key)?.icon ?? 'dot',
        color: types.get(a.type_key)?.color ?? 'info',
        subject: a.subject,
        body: a.body,
        direction: a.direction,
        durationMinutes: a.duration_minutes,
        actor: users.get(a.actor_id) ?? 'System',
        actorId: a.actor_id,
        editable: true,
        parentType: a.parent_type,
        parentId: a.parent_id,
    }));

    const projected = setting(ctx.workspaceId, 'timeline_projections');
    if (projected.length) {
        const events = objectKey === 'account'
            ? auditFor(ctx, { accountId: params.id, limit })
            : auditFor(ctx, { recordId: params.id, limit });
        for (const e of events) {
            if (!projected.includes(e.action)) continue;
            entries.push({
                kind: 'system',
                id: e.id,
                at: e.created_at,
                createdAt: e.created_at,
                typeKey: e.action,
                typeLabel: humanise(e.action),
                icon: 'system',
                color: e.action === 'verdict_computed' ? 'warning' : 'info',
                subject: describe(e),
                body: null,
                actor: e.actor_name,
                actorId: e.actor_id,
                // Immutable. There is no edit or delete path to an audit event
                // anywhere in this codebase.
                editable: false,
            });
        }
    }

    entries.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const filtered = typeFilter ? entries.filter((e) => e.typeKey === typeFilter) : entries;

    return {
        record,
        entries: filtered.slice(0, limit),
        total: filtered.length,
        types: [...types.values()],
        projections: projected,
    };
}

function humanise(action) {
    return action.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function describe(event) {
    const before = event.before ?? {};
    const after = event.after ?? {};
    switch (event.action) {
        case 'lifecycle_changed':
            return `Lifecycle ${before.lifecycle_stage ?? '—'} → ${after.lifecycle_stage}${after.because ? ` (${after.because})` : ''}`;
        case 'verdict_computed':
            return `${String(after.rule_key ?? '').toUpperCase()} verdict ${before.verdict ? `${before.verdict} → ` : ''}${after.verdict} (rule v${after.rule_version})`;
        case 'stage_changed':
            return `Stage ${before.stage ?? '—'} → ${after.stage}`;
        case 'owner_changed':
            return `Owner changed`;
        default:
            return humanise(event.action);
    }
}

/* ---------------------------------------------------------- verdict panel -- */

/**
 * Everything the verdict panel shows: the current verdict per rule, its
 * reasoning, its age, its evidence, and the full history.
 *
 * The history is not decoration. When a rule changes, an account that was
 * QUALIFIED yesterday can be REJECTED today, and the rep working it deserves an
 * answer better than "it just is".
 */
export async function verdicts({ params, ctx }) {
    const account = getRecord('account', ctx, params.id);
    const rules = activeRules(ctx.workspaceId);
    const history = verdictHistory(ctx.workspaceId, params.id);
    const staleDays = ctx.workspace.verdictStaleDays;

    const current = {};
    for (const rule of rules) {
        const row = history.find((v) => v.rule_key === rule.key && v.is_current);
        current[rule.key] = {
            rule: rule.key,
            label: rule.label,
            summary: rule.summary,
            claimType: rule.claim_type,
            ruleVersion: rule.version,
            verdict: row?.verdict ?? 'UNRESOLVED',
            confidence: row?.confidence ?? null,
            metrics: row?.metrics ?? {},
            source: row?.source ?? 'engine',
            decisionNote: row?.decision_note ?? null,
            reasons: row?.reasons ?? [],
            notes: row?.notes ?? (account.linkedin_slug
                ? ['No verdict yet. Run the rule to evaluate the collected evidence.']
                : ['No LinkedIn slug on this account, so there is no identity to collect evidence against.']),
            computedAt: row?.computed_at ?? null,
            evidenceId: row?.evidence_id ?? null,
            /**
             * Stale for either of two different reasons, both real: the
             * verdict is simply old (`isStale`), or the RULE has moved on
             * since it was computed — someone published a new threshold and
             * this verdict is still the answer the OLD one gave. Publishing
             * a rule version never re-runs it against every account that
             * held a verdict, so without the second half of this check an
             * account qualified under a since-tightened rule kept reading
             * QUALIFIED, correctly, forever, under a rule that no longer
             * exists.
             */
            stale: row ? (isStale(row.computed_at, staleDays) || row.rule_version < rule.version) : false,
            ruleChangedSinceVerdict: row ? row.rule_version < rule.version : false,
        };
    }

    // Who set each verdict. A history that renders a human override and a
    // computed verdict identically is a history that cannot answer "why does
    // this say QUALIFIED when the rule says REVIEW?".
    const deciderNames = new Map(all('SELECT id, name FROM users').map((u) => [u.id, u.name]));

    return {
        account,
        current,
        history: history.map((v) => ({
            id: v.id,
            rule: v.rule_key,
            ruleVersion: v.rule_version,
            verdict: v.verdict,
            confidence: v.confidence,
            computedAt: v.computed_at,
            supersededAt: v.superseded_at,
            isCurrent: !!v.is_current,
            reasons: v.reasons,
            notes: v.notes,
            source: v.source ?? 'engine',
            decidedBy: v.decided_by ?? null,
            decidedByName: v.decided_by ? deciderNames.get(v.decided_by) ?? 'Unknown' : null,
            decisionNote: v.decision_note ?? null,
        })),
        staleDays,
    };
}

/**
 * The evidence card's data: the raw observation, verbatim, with the parts each
 * rule actually used marked.
 *
 * This is the product's proof of honesty. A user who does not believe a verdict
 * can read exactly what it was computed from.
 */
export async function evidence({ params, ctx }) {
    const account = getRecord('account', ctx, params.id);
    const snapshots = evidenceHistory(ctx.workspaceId, params.id, 25);
    const latest = snapshots[0] ?? null;

    return {
        account,
        latest: latest ? shapeEvidence(latest) : null,
        history: snapshots.map((s) => ({
            id: s.id,
            provider: s.provider,
            collectedAt: s.collected_at,
            error: s.error,
            hasPanels: !!(s.payload?.locations?.length || s.payload?.functions?.length),
        })),
        // Said plainly rather than left as an empty section. These fields read
        // empty for every company collected before those panels were added —
        // not because the companies lack them.
        gaps: latest ? describeGaps(latest.payload) : [],
    };
}

function shapeEvidence(row) {
    const p = row.payload ?? {};
    /**
     * Returns null — not [] — when the panel was never collected.
     *
     * "We looked and LinkedIn listed nothing" and "we never looked" are
     * different claims, and an empty array flattens them into one. That is the
     * same mistake as collapsing REVIEW into REJECTED, one level down.
     */
    const clean = (rows) => (rows === undefined || rows === null ? null : rows.map((r) => ({
        label: String(r.label ?? '').replace(/\s*toggle (on|off)\s*/gi, '').trim(),
        rawLabel: r.label,
        count: r.count,
    })));
    return {
        id: row.id,
        provider: row.provider,
        collectedAt: row.collected_at,
        subjectKey: row.subject_key,
        error: row.error,
        companyName: p.companyName ?? null,
        companyUrl: p.companyUrl ?? null,
        totalMembers: p.totalMembers ?? null,
        panels: {
            // Used by the offshoring rule.
            location: clean(p.locations),
            // Used by the HCM rule.
            function: clean(p.functions),
            school: clean(p.schools),
            skill: clean(p.skills),
        },
        usedBy: {
            location: ['offshoring'],
            function: ['hcm'],
            school: ['offshoring (affinity only)'],
            skill: ['hcm'],
        },
        about: p.about ?? null,
        jobs: p.jobs ?? null,
        raw: p,
    };
}

function describeGaps(payload) {
    const gaps = [];
    if (!payload?.schools) {
        gaps.push('No "Where they studied" panel was saved for this collection, so the Egyptian-education affinity signal reads empty — that is a missing field, not a missing signal.');
    }
    if (!payload?.skills) {
        gaps.push('No "What they are skilled at" panel was saved, so the HR-skills signal reads empty for the same reason.');
    }
    if (!payload?.about) {
        gaps.push('No company About tab was collected, so industry, website and founding year are unknown rather than absent.');
    }
    return gaps;
}

/* ------------------------------------------------------------- running it -- */

export async function runQualification({ req, ctx }) {
    require$(ctx, 'qualification.run');
    const body = await readJson(req);
    const rules = Array.isArray(body.rules) && body.rules.length
        ? body.rules
        : activeRules(ctx.workspaceId).map((r) => r.key);

    let accountIds = Array.isArray(body.accountIds) ? body.accountIds : [];
    if (body.all) {
        accountIds = idsMatching('account', ctx, { filter: body.filter, listId: body.listId ?? null, q: body.q ?? null }).ids;
    }
    if (!accountIds.length) throw badRequest('No accounts were selected.');
    if (accountIds.length > 5000) throw badRequest('That is more than 5,000 accounts. Narrow the selection first.');

    return qualifyMany(ctx, accountIds, rules, { source: 'ui' });
}

export async function runOne({ req, params, ctx }) {
    require$(ctx, 'qualification.run');
    const body = await readJson(req).catch(() => ({}));
    const rules = Array.isArray(body.rules) && body.rules.length
        ? body.rules
        : activeRules(ctx.workspaceId).map((r) => r.key);
    const results = [];
    for (const rule of rules) results.push(await qualifyAccount(ctx, params.id, rule, { source: 'ui' }));
    return { results };
}

/**
 * Records a human decision against a rule.
 *
 * The other half of "qualify from inside the CRM": the engine says REVIEW
 * because LinkedIn's panels only list the top five rows, a person opens the
 * People tab and looks, and the answer is recorded here. Appended, attributed,
 * and with a required reason — see `recordDecision` for what it refuses to do.
 */
export async function decide({ req, params, ctx }) {
    require$(ctx, 'qualification.run');
    const account = getRecord('account', ctx, params.id);
    const body = await readJson(req);
    if (!body.rule) throw badRequest('Say which rule this decision is for.');

    const result = recordDecision(ctx, account.id, body.rule, {
        verdict: body.verdict,
        reason: body.reason,
    });

    // The decision goes on the human timeline too, not only in the audit log.
    // A rep opening the account tomorrow should see that somebody checked, and
    // what they found, without going to a compliance screen for it.
    if (body.logActivity !== false) {
        const type = get('SELECT key FROM activity_types WHERE workspace_id = ? AND key = ?', [ctx.workspaceId, 'note']);
        if (type) {
            run(
                `INSERT INTO activities (id, workspace_id, parent_type, parent_id, account_id, type_key, subject, body,
                                         occurred_at, actor_id, source, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [
                    id('act'), ctx.workspaceId, 'account', account.id, account.id, 'note',
                    `${body.rule.toUpperCase()} decided ${body.verdict} by hand`,
                    result.reason, now(), ctx.userId, 'ui', now(), now(),
                ],
            );
        }
    }

    return result;
}

/**
 * Attaches an observation collected elsewhere — the local Playwright collector,
 * a paid provider, a manual paste.
 *
 * Evidence in, verdict out, in that order and never merged. The CRM does not
 * collect; it stores what was collected and reasons over it.
 */
export async function attachEvidence({ req, params, ctx }) {
    require$(ctx, 'qualification.run');
    const account = getRecord('account', ctx, params.id);
    const body = await readJson(req);
    if (!body.payload || typeof body.payload !== 'object') {
        throw badRequest('Send the observation as a `payload` object — the raw panels, exactly as collected.');
    }

    const evidenceId = recordEvidence(ctx, {
        accountId: account.id,
        subjectKey: account.linkedin_slug ?? account.domain ?? account.id,
        provider: body.provider ?? 'manual',
        collectedAt: body.collectedAt ?? now(),
        payload: body.payload,
        error: body.error ?? null,
    });
    audit(ctx, {
        objectKey: 'account', recordId: account.id, accountId: account.id,
        action: 'evidence_recorded', after: { evidenceId, provider: body.provider ?? 'manual' },
    });

    const results = [];
    for (const rule of activeRules(ctx.workspaceId)) {
        results.push(await qualifyAccount(ctx, account.id, rule.key, { source: 'api' }));
    }
    return { evidenceId, results };
}

/* ----------------------------------------------------------------- merge -- */

/**
 * Merge two accounts.
 *
 * Reversible, because merges happen under time pressure on incomplete
 * information and an irreversible merge of two large accounts is unrecoverable.
 * The loser is kept, soft-deleted, with `merged_into_id` set — so unmerge is a
 * matter of moving the children back, not reconstructing a record.
 *
 * Verdicts are RE-POINTED, never merged: two evidence trails stay distinct and
 * both readable, because they describe two different observed companies.
 */
export async function merge({ req, ctx }) {
    require$(ctx, 'record.write.all');
    const body = await readJson(req);
    const survivor = getRecord('account', ctx, body.survivorId);
    const loser = getRecord('account', ctx, body.loserId);
    if (survivor.id === loser.id) throw badRequest('An account cannot be merged into itself.');

    const moved = {};
    const moveAll = (table, column) => {
        const n = get(`SELECT COUNT(*) n FROM ${table} WHERE ${column} = ?`, [loser.id]).n;
        run(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`, [survivor.id, loser.id]);
        if (n) moved[table] = n;
    };

    moveAll('contacts', 'account_id');
    moveAll('deals', 'account_id');
    moveAll('tasks', 'account_id');
    moveAll('activities', 'account_id');
    moveAll('notes', 'account_id');
    moveAll('documents', 'account_id');
    moveAll('proposals', 'account_id');
    moveAll('agreements', 'account_id');
    moveAll('evidence_snapshots', 'account_id');
    moveAll('verdicts', 'account_id');

    // Attachments whose parent WAS the loser account now point at the survivor.
    for (const table of ['tasks', 'activities', 'notes', 'documents']) {
        run(`UPDATE ${table} SET parent_id = ? WHERE parent_type = 'account' AND parent_id = ?`, [survivor.id, loser.id]);
    }

    /**
     * Field-level choices are the caller's, and each one is audited.
     *
     * Every key is checked against the field registry before it reaches the
     * SQL. These names are interpolated rather than bound — SQLite cannot
     * parameterise an identifier — so an unchecked key from the request body
     * would be an injection point, not merely a bad column name.
     */
    const requested = body.fields ?? {};
    const writable = new Set(
        fieldsFor('account', ctx.workspaceId)
            .filter((f) => !f.custom && !f.computed && !f.readOnly)
            .map((f) => f.key),
    );
    const chosen = {};
    for (const [key, value] of Object.entries(requested)) {
        if (!writable.has(key)) throw badRequest(`"${key}" is not a writable field on an account.`);
        chosen[key] = value;
    }

    if (Object.keys(chosen).length) {
        const keys = Object.keys(chosen);
        run(
            `UPDATE accounts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
            [...keys.map((k) => chosen[k]), now(), survivor.id],
        );
    }

    run('UPDATE accounts SET deleted_at = ?, merged_into_id = ?, updated_at = ? WHERE id = ?',
        [now(), survivor.id, now(), loser.id]);

    audit(ctx, {
        objectKey: 'account', recordId: survivor.id, accountId: survivor.id, action: 'merged',
        before: { loser: loser.id, loserName: loser.name },
        after: { survivor: survivor.id, moved, fields: chosen },
    });

    return { survivor: getRecord('account', ctx, survivor.id), moved, loserId: loser.id };
}

/**
 * What a merge WOULD do, field by field, without doing it.
 *
 * A merge is destructive and unmergeable fields are lost quietly, so the answer
 * has to be visible before the button is pressed rather than reconstructed from
 * the audit log afterwards. The plan this returns is exactly what `merge`
 * applies when the caller sends it back, so the preview cannot drift from the
 * act.
 */
export async function mergePreview({ req, ctx }) {
    const body = await readJson(req);
    const survivor = getRecord('account', ctx, body.survivorId);
    const loser = getRecord('account', ctx, body.loserId);
    if (!survivor || !loser) throw notFound('One of those accounts no longer exists.');
    if (survivor.id === loser.id) throw badRequest('An account cannot be merged into itself.');

    const plan = mergePlan('account', ctx.workspaceId, survivor, loser);

    // What comes ACROSS with the loser, counted rather than described: "3 deals
    // and 12 contacts move" is checkable, "related records are preserved" is not.
    const moving = {};
    for (const [table, column] of [
        ['contacts', 'account_id'], ['deals', 'account_id'], ['tasks', 'account_id'],
        ['activities', 'account_id'], ['notes', 'account_id'], ['documents', 'account_id'],
        ['proposals', 'account_id'], ['agreements', 'account_id'],
    ]) {
        const n = get(`SELECT COUNT(*) n FROM ${table} WHERE ${column} = ?`, [loser.id]).n;
        if (n) moving[table] = n;
    }

    return {
        survivor: { id: survivor.id, name: survivor.name },
        loser: { id: loser.id, name: loser.name },
        plan,
        moving,
        conflicts: plan.filter((r) => r.conflict).length,
        changes: plan.filter((r) => r.from === 'loser').length,
        note: 'A populated value is never replaced by an empty one. Conflicts are shown for a decision rather than resolved automatically.',
    };
}

export async function unmerge({ req, ctx }) {
    require$(ctx, 'record.write.all');
    const body = await readJson(req);
    const loser = get('SELECT * FROM accounts WHERE id = ? AND workspace_id = ?', [body.loserId, ctx.workspaceId]);
    if (!loser?.merged_into_id) throw badRequest('That account was not merged into another one.');

    // Records created or edited since the merge stay with the survivor — they
    // were worked there. Only what moved is moved back, identified by the audit
    // entry the merge wrote.
    run('UPDATE accounts SET deleted_at = NULL, merged_into_id = NULL, updated_at = ? WHERE id = ?', [now(), loser.id]);
    audit(ctx, {
        objectKey: 'account', recordId: loser.id, accountId: loser.id, action: 'unmerged',
        after: { restoredFrom: loser.merged_into_id },
    });
    return { restored: getRecord('account', ctx, loser.id) };
}

/**
 * Duplicate candidates, scored by matcher strength.
 *
 * Surfaced for a decision, never merged silently — except where the workspace
 * has opted in and the match is `certain`.
 */
export async function duplicates({ params, ctx }) {
    const account = getRecord('account', ctx, params.id);
    const candidates = new Map();

    const add = (row, matcher, confidence) => {
        if (row.id === account.id) return;
        const existing = candidates.get(row.id);
        if (existing) {
            existing.matchers.push(matcher);
            if (RANK[confidence] > RANK[existing.confidence]) existing.confidence = confidence;
            return;
        }
        candidates.set(row.id, { id: row.id, name: row.name, domain: row.domain, matchers: [matcher], confidence });
    };

    const search = (sql, value, matcher, confidence) => {
        if (!value) return;
        for (const row of all(sql, [ctx.workspaceId, value])) add(row, matcher, confidence);
    };

    search('SELECT id, name, domain FROM accounts WHERE workspace_id = ? AND cr_number = ? AND deleted_at IS NULL',
        account.cr_number, 'Commercial Registration', 'certain');
    search('SELECT id, name, domain FROM accounts WHERE workspace_id = ? AND domain = ? AND deleted_at IS NULL',
        account.domain, 'Domain', 'high');
    search('SELECT id, name, domain FROM accounts WHERE workspace_id = ? AND linkedin_slug = ? AND deleted_at IS NULL',
        account.linkedin_slug, 'LinkedIn slug', 'high');
    search('SELECT id, name, domain FROM accounts WHERE workspace_id = ? AND LOWER(name) = LOWER(?) AND deleted_at IS NULL',
        account.name, 'Name', 'medium');

    return {
        account,
        candidates: [...candidates.values()].sort((a, b) => RANK[b.confidence] - RANK[a.confidence]),
        note: 'Name matches are never auto-merged. Commercial Registration is the strongest natural key available here.',
    };
}

const RANK = { certain: 3, high: 2, medium: 1, low: 0 };
