/**
 * The qualification module's own endpoints: rules, impact preview, publishing.
 *
 * The preview is the important one. Publishing a rule change without seeing
 * what it does to existing verdicts is exactly how this project's own history
 * went wrong: changing the HCM headcount band moved 117 of 223 verdicts, three
 * of them from QUALIFIED to REJECTED, and nothing recorded it.
 */
import fs from 'node:fs';
import { all, get, HOSTED } from '../lib/db.mjs';
import { readBody, readJson, badRequest } from '../lib/http.mjs';
import { require$ } from '../lib/auth.mjs';
import {
    activeRules, ruleHistory, currentRule, publishRuleVersion, previewRule,
    loadEngines, verdictTally, QUALIFIER_LIB, SNAPSHOTS_FILE,
} from '../lib/qualification.mjs';
import { inspectUpload, qualifyUpload, SELECTORS } from '../lib/qualify-upload.mjs';
import * as qualifierUi from '../lib/qualifier-ui.mjs';

export async function rules({ ctx }) {
    const engines = await loadEngines();
    const list = activeRules(ctx.workspaceId);
    return {
        rules: list.map((rule) => ({
            key: rule.key,
            label: rule.label,
            engine: rule.engine,
            claimType: rule.claim_type,
            version: rule.version,
            summary: rule.summary,
            config: rule.config,
            defaults: engines[rule.key]?.defaults ?? {},
            // Which side of the verdict the coverage gate guards is a property
            // of the CLAIM, not of the data source. Stating it here is what
            // keeps a new rule from being written without deciding.
            coverageGates: rule.claim_type === 'absence' ? 'QUALIFY' : 'REJECT',
            explanation: rule.claim_type === 'absence'
                ? 'An absence test. Finding nothing proves nothing unless you looked everywhere, so coverage gates the QUALIFY. '
                  + 'A REJECT is definitive at any coverage — seeing HR staff proves they exist.'
                : 'A presence test. Observing two people in the country proves at least two exist however much was missed, '
                  + 'so a QUALIFY is definitive at any coverage and the gate sits on the REJECT.',
            history: ruleHistory(ctx.workspaceId, rule.key).map((v) => ({
                version: v.version, summary: v.summary, createdAt: v.created_at, config: v.config,
            })),
        })),
        tally: verdictTally(ctx.workspaceId),
        engineSource: QUALIFIER_LIB,
    };
}

/**
 * The impact preview. Evaluates every account's stored evidence under the
 * PROPOSED config and reports the transitions, without writing anything.
 *
 * Free to run, because evidence and conclusions are stored separately — the
 * whole point of invariant I1.
 */
export async function preview({ req, params, ctx }) {
    require$(ctx, 'qualification.run');
    const body = await readJson(req);
    const rule = currentRule(ctx.workspaceId, params.key);
    const config = { ...rule.config, ...(body.config ?? {}) };
    validateConfig(params.key, config);

    const impact = await previewRule(ctx, params.key, config);
    return {
        rule: params.key,
        currentVersion: rule.version,
        currentConfig: rule.config,
        proposedConfig: config,
        ...impact,
        note: impact.dangerousTotal
            ? `${impact.dangerousTotal} account(s) would stop qualifying`
              + `${impact.withOpenDeals ? `, ${impact.withOpenDeals} of them with an open deal` : ''}.`
            : 'No account would lose its QUALIFIED verdict.',
    };
}

export async function publish({ req, params, ctx }) {
    require$(ctx, 'record.write.all');
    const body = await readJson(req);
    const rule = currentRule(ctx.workspaceId, params.key);
    const config = { ...rule.config, ...(body.config ?? {}) };
    validateConfig(params.key, config);

    if (JSON.stringify(config) === JSON.stringify(rule.config)) {
        throw badRequest('That config is identical to the current version — nothing to publish.');
    }

    const published = publishRuleVersion(ctx, params.key, config, body.label);
    return {
        rule: published,
        note: 'Published as a new version. Existing verdicts still point at the version that produced them, '
            + 'so every account can still answer "why did this change?". Re-run the rule to apply it.',
    };
}

function validateConfig(key, config) {
    const positive = (name, value, { allowNull = false } = {}) => {
        if (value === null || value === undefined) {
            if (allowNull) return;
            throw badRequest(`${name} is required.`);
        }
        if (!Number.isFinite(Number(value)) || Number(value) < 0) throw badRequest(`${name} must be a number of 0 or more.`);
    };

    if (key === 'hcm') {
        positive('Minimum headcount', config.minHeadcount);
        positive('Maximum headcount', config.maxHeadcount, { allowNull: true });
        positive('Maximum HR employees', config.maxHrCount);
        if (config.maxHeadcount !== null && config.maxHeadcount !== undefined
            && Number(config.maxHeadcount) < Number(config.minHeadcount)) {
            throw badRequest('The headcount ceiling cannot be below the floor.');
        }
    }
    if (key === 'offshoring') {
        // Matches what the engine actually reads (`local-scraper/lib/
        // offshoring.js`: `config?.minEgyptCount`) — this used to validate
        // `minHeadcount`/`minCountryCount`/`country`, none of which the
        // engine looks at, so a config that passed validation here could
        // still have zero effect on any verdict.
        positive('Minimum Egypt-based employees', config.minEgyptCount);
    }
    if (config.minCoverage !== undefined) {
        const c = Number(config.minCoverage);
        if (!Number.isFinite(c) || c < 0 || c > 1) throw badRequest('Coverage must be between 0 and 1.');
    }
}

/* -------------------------------------------------- upload and qualify -- */

/**
 * Pre-flight for an uploaded lead list.
 *
 * Takes the file as the raw body rather than a JSON string, for the reason the
 * importer's profile step does: a 20 MB list should not be inflated by escaping
 * every newline to be handed to a server that only wants to parse it.
 *
 * Nothing is written, here or in `qualifyList`. Both only read evidence the
 * database already holds — evaluation is free and offline, which is invariant
 * I1 and the reason this can run on a server at all.
 */
export async function inspectList({ req, url, ctx }) {
    require$(ctx, 'qualification.run');
    const text = (await readBody(req)).toString('utf8');
    if (!text.trim()) throw badRequest('That file is empty.');

    // The column travels in the query string because the BODY is the file.
    const raw = url?.searchParams?.get('column');
    const columnIndex = raw === null || raw === undefined || raw === '' ? null : Number(raw);

    const result = await inspectUpload(ctx, text, {
        columnIndex: Number.isInteger(columnIndex) ? columnIndex : null,
    });
    return {
        ...result,
        selectors: SELECTORS,
        note: result.missing
            ? `${result.missing} of ${result.companies} companies have no stored evidence, so the rules cannot judge `
              + 'them. They will not appear in the filtered list — as unjudged, not as rejected.'
            : null,
    };
}

/**
 * Runs the rules over the list and returns the filtered CSV.
 *
 * One request, no job to poll. Collection is what made the local version need a
 * progress stream; evaluating stored evidence is arithmetic.
 */
export async function qualifyList({ req, ctx }) {
    require$(ctx, 'qualification.run');
    const body = await readJson(req);
    if (!body.text) throw badRequest('Send the file contents as `text`.');

    const result = await qualifyUpload(ctx, {
        text: body.text,
        columnIndex: Number.isInteger(body.columnIndex) ? body.columnIndex : null,
        selector: body.selector ?? 'hcm',
        filename: body.filename ?? 'leads.csv',
    });

    const { stats } = result;
    return {
        ...result,
        // Only the first slice of per-company detail travels back for display;
        // the full set is already in the report CSV, and 3,000 objects would
        // make the response slower than the qualification.
        companies: result.companies.slice(0, 200),
        companiesTruncated: result.companies.length > 200,
        note: `${stats.outputRows} of ${stats.inputRows} rows kept, from `
            + `${stats.companiesQualified} of ${stats.companies} companies`
            + `${stats.companiesNotCollected
                ? `. ${stats.companiesNotCollected} could not be judged because no evidence has been collected for them`
                : ''}.`,
        wrote: 'nothing',
        writesNote: 'No verdicts were recorded. This filtered a spreadsheet; it did not judge any record in the CRM. '
            + 'To record a verdict against a company, qualify it on its own page.',
    };
}

/* ------------------------------------------------- the collector's own UI -- */

/**
 * Status of the COLLECTOR — the part that still needs a laptop.
 *
 * Qualifying an uploaded list no longer goes through here: that runs in this
 * process against the shared evidence tables (see lib/qualify-upload.mjs).
 * What this endpoint reports is the local-scraper page, which is still the only
 * way to collect a company nobody has collected yet, because collection drives
 * a real Chrome through a signed-in profile.
 */
export async function uploaderStatus({ ctx }) {
    const state = await qualifierUi.status();
    let snapshots = null;
    try {
        if (fs.existsSync(SNAPSHOTS_FILE)) {
            snapshots = Object.keys(JSON.parse(fs.readFileSync(SNAPSHOTS_FILE, 'utf8'))).length;
        }
    } catch {
        snapshots = null;   // an unreadable snapshots file is not a fatal error here
    }

    /**
     * The number that actually matters to an upload, and the reason it is
     * counted from the DATABASE rather than from snapshots.json: this is the
     * shared corpus every user can qualify against, wherever they are. The
     * file is one laptop's copy and is not deployed.
     */
    const collected = get(
        `SELECT COUNT(*) AS n FROM (
             SELECT subject_key FROM prospecting_evidence_snapshots WHERE workspace_id = ?
              UNION
             SELECT subject_key FROM evidence_snapshots WHERE workspace_id = ?)`,
        [ctx.workspaceId, ctx.workspaceId],
    )?.n ?? 0;

    return {
        ...state,
        // Whether this CRM is the hosted one. "Not installed" means something
        // different there: not a folder to go and find, but a thing that
        // deliberately does not run on a server.
        remote: HOSTED,
        snapshotsFile: SNAPSHOTS_FILE,
        snapshots,
        collected,
        embedPath: '/qualifier',
        note: 'Qualifying a list runs here, against the evidence this database already holds. Collecting a company '
            + 'nobody has collected yet opens a signed-in Chrome, so that part runs on a computer with one.',
    };
}

export async function startUploader({ ctx }) {
    require$(ctx, 'qualification.run');
    const result = await qualifierUi.ensureRunning();
    return { ...result, ...(await qualifierUi.status()) };
}

export async function stopUploader({ ctx }) {
    require$(ctx, 'qualification.run');
    return { ...qualifierUi.stop(), ...(await qualifierUi.status()) };
}

/**
 * Accounts whose verdict is REVIEW, ordered so the most promising manual check
 * comes first.
 *
 * REVIEW is a queue to work, not a bin. Egyptian-alumni affinity is the best
 * available tie-breaker for offshoring — the rule cannot count it as location,
 * but it is genuine evidence that the manual check is worth the minute.
 */
export async function reviewQueue({ url, ctx }) {
    const ruleKey = url.searchParams.get('rule') ?? 'hcm';
    const limit = Number(url.searchParams.get('limit')) || 100;
    const page = Number(url.searchParams.get('page')) || 1;
    const rows = all(
        `SELECT v.*, a.id AS account_id, a.name, a.employee_count, a.industry, a.country, a.linkedin_slug
           FROM verdicts v JOIN accounts a ON a.id = v.account_id AND a.deleted_at IS NULL
          WHERE v.workspace_id = ? AND v.rule_key = ? AND v.is_current = 1 AND v.verdict = 'REVIEW'`,
        [ctx.workspaceId, ruleKey],
    );

    const items = rows.map((row) => {
        const metrics = JSON.parse(row.metrics || '{}');
        const notes = JSON.parse(row.notes || '[]');
        const affinity = Number(metrics.egyptEducationCount) || 0;
        const unaccounted = Number(metrics.maxPossibleInCountry ?? metrics.maxPossibleHr) || 0;
        return {
            accountId: row.account_id,
            name: row.name,
            employeeCount: row.employee_count,
            industry: row.industry,
            country: row.country,
            linkedinSlug: row.linkedin_slug,
            computedAt: row.computed_at,
            notes,
            metrics,
            affinity,
            unaccounted,
            // Highest-signal first: alumni evidence, then how much headcount the
            // panels left unexplained — the bigger that gap, the more a manual
            // look can change.
            score: affinity * 10 + unaccounted,
            nextStep: ruleKey === 'offshoring'
                ? `Open the People tab for ${row.linkedin_slug ?? 'this company'} and filter by country.`
                : `Open the People tab for ${row.linkedin_slug ?? 'this company'} and filter by "Human Resources".`,
        };
    }).sort((a, b) => b.score - a.score);

    const total = items.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(1, page), pages);

    return {
        rule: ruleKey,
        total,
        page: safePage,
        pages,
        limit,
        items: items.slice((safePage - 1) * limit, safePage * limit),
        note: 'REVIEW means the evidence could not answer the question. These are unresolved leads, not rejections.',
    };
}
