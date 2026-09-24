/**
 * Upload a lead list and qualify it — on the server, with no browser involved.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The Qualifier page used to be a proxy to `local-scraper/server.mjs`, and that
 * program cannot run on the hosted CRM: its qualify step is welded to a collect
 * step that drives a signed-in Chrome. So the hosted page had nothing to offer
 * but an instruction to go and use a laptop, and the whole upload-and-qualify
 * flow — the thing people actually do with this product — was unavailable to
 * everyone except the one person with the browser profile.
 *
 * That conflated two operations invariant I1 keeps apart:
 *
 *   COLLECTION   expensive, rate-limited, needs a real browser and a real
 *                login. Genuinely a laptop activity. Still is.
 *   EVALUATION   free and offline. Runs the rules over evidence that is
 *                already stored.
 *
 * Only the first needs a machine with Chrome on it. This module is the second,
 * driven from a CSV, and the hosted CRM can do it perfectly well: the shared
 * database already holds the evidence, and `lib/qualification.mjs` already
 * loads the rule modules there.
 *
 * ── WHERE THE EVIDENCE COMES FROM ───────────────────────────────────────────
 * The DATABASE, not `snapshots.json`. That file is a working file of the
 * scraper project on someone's laptop and is deliberately not deployed; the
 * evidence tables are the shared copy every user already reads. Looking a slug
 * up there means a company collected by one person is instantly qualifiable by
 * everybody, which is the whole argument for the CRM holding the evidence.
 *
 * Both planes are searched — a slug may have been collected against an account
 * or against a prospecting company, and from a lead list's point of view that
 * distinction is invisible and irrelevant.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 * It writes NOTHING. No evidence rows, no verdicts, no lifecycle moves. This is
 * a question asked of a spreadsheet ("which of these are worth calling?"), not
 * a judgement recorded against a record — and appending 2,000 verdict rows
 * because somebody dropped a CSV on a page would bury the real ones, which
 * invariant I2 exists to keep readable. Verdicts are recorded by qualifying a
 * record, which is a separate and deliberate act.
 *
 * It also does not collect. A company nobody has ever collected cannot be
 * judged here, and is reported as exactly that rather than being quietly
 * dropped or, worse, counted as a rejection — I3 again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { all } from './db.mjs';
import { badRequest } from './http.mjs';
import { QUALIFIER_LIB, loadEngines, toSnapshot, activeRules } from './qualification.mjs';

/**
 * How a company's rows are kept or dropped.
 *
 * The set is closed at these four because the engine registry is: `loadEngines`
 * knows `hcm` and `offshoring` and nothing else, so a rule outside that pair
 * cannot exist to select on.
 */
export const SELECTORS = {
    hcm: 'Qualified for HCM',
    offshoring: 'Qualified for offshoring',
    either: 'Qualified for either service',
    both: 'Qualified for both services',
};

/* ------------------------------------------------------------------ tools -- */

let tools = null;

/**
 * The CSV reader and the row selector, imported from the qualifier project for
 * the same reason the rules are: they are working code with the edge cases
 * already found in them — the BOM handling, the values-not-headers column
 * detection, and the rule that a six-contact company keeps all six rows or
 * none. A second copy here would drift from the one the command line uses.
 */
async function loadTools() {
    if (tools) return tools;

    const required = ['csv.mjs', 'select.mjs'];
    const missing = required.filter((f) => !fs.existsSync(path.join(QUALIFIER_LIB, f)));
    if (missing.length) {
        throw new Error(
            `The CSV tools were not found at ${QUALIFIER_LIB} (missing: ${missing.join(', ')}). `
            + 'The CRM reads them from the local-scraper project rather than copying them. '
            + 'Set QUALIFIER_LIB to point at that lib/ folder.',
        );
    }

    const load = (file) => import(pathToFileURL(path.join(QUALIFIER_LIB, file)).href);
    const [csv, select] = await Promise.all([load('csv.mjs'), load('select.mjs')]);
    tools = { ...csv, selectQualified: select.selectQualified };
    return tools;
}

/* --------------------------------------------------------------- evidence -- */

/**
 * SQLite takes a bounded number of bound parameters per statement, and a lead
 * list can carry thousands of companies. Chunking keeps one oversized upload
 * from failing at the driver instead of at a message anybody can act on.
 */
const CHUNK = 400;

function chunked(items, size = CHUNK) {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

/**
 * The most recent evidence for each of these slugs, from either plane.
 *
 * Latest wins across BOTH tables, not per table: if a company was collected as
 * a prospect in March and again as an account in July, July is what the rules
 * should see. `collected_at` is an ISO-8601 string, so comparing as text and
 * comparing as time are the same ordering.
 */
function evidenceBySlug(workspaceId, slugs) {
    const found = new Map();
    for (const chunk of chunked(slugs)) {
        const marks = chunk.map(() => '?').join(',');
        const rows = all(
            `SELECT subject_key, collected_at, payload, error, 'prospect' AS plane
               FROM prospecting_evidence_snapshots
              WHERE workspace_id = ? AND subject_key IN (${marks})
             UNION ALL
             SELECT subject_key, collected_at, payload, error, 'account' AS plane
               FROM evidence_snapshots
              WHERE workspace_id = ? AND subject_key IN (${marks})`,
            [workspaceId, ...chunk, workspaceId, ...chunk],
        );
        for (const row of rows) {
            const seen = found.get(row.subject_key);
            if (!seen || String(row.collected_at) > String(seen.collected_at)) found.set(row.subject_key, row);
        }
    }
    return found;
}

/* ---------------------------------------------------------------- inspect -- */

/**
 * Pre-flight: what is in this file, and how much of it can actually be judged.
 *
 * The `missing` count is the number that decides whether this upload is worth
 * pressing the button on, and it is shown BEFORE the button rather than
 * discovered afterwards — on a server those companies cannot be collected at
 * all, so a file that is 90% uncollected is a file to take to a laptop.
 */
export async function inspectUpload(ctx, text, { columnIndex = null } = {}) {
    const { parseTable, detectCompanyColumn, normalizeCompanySlug, isCompanyUrl } = await loadTools();
    const { header, rows } = parseTable(text);
    if (!header.length) throw badRequest('That file has no rows.');

    const detected = detectCompanyColumn(header, rows);

    // Only cells that look like LinkedIn company URLs are counted, so the
    // picker does not claim "3 companies" for a Notes column that happens to
    // have three non-empty cells.
    const columns = header.map((name, index) => {
        const slugs = new Set();
        for (const row of rows) {
            if (!isCompanyUrl(row[index])) continue;
            const slug = normalizeCompanySlug(row[index]);
            if (slug) slugs.add(slug);
        }
        return { index, name: name || `(column ${index + 1})`, companies: slugs.size };
    });

    /**
     * The counts describe the column that will actually be used, which is the
     * caller's choice when it made one. Reporting the auto-detected column's
     * figures beside a picker set to something else is a quiet lie, and the
     * numbers here are the ones the decision to press the button rests on.
     */
    const chosen = Number.isInteger(columnIndex) && columnIndex >= 0 && columnIndex < header.length
        ? columnIndex
        : detected.index;

    let stats = null;
    if (chosen >= 0) {
        const slugs = uniqueSlugs(rows, chosen, normalizeCompanySlug);
        const evidence = evidenceBySlug(ctx.workspaceId, slugs);
        stats = {
            companies: slugs.length,
            collected: slugs.filter((s) => evidence.has(s)).length,
            missing: slugs.filter((s) => !evidence.has(s)).length,
        };
    }

    return {
        rowCount: rows.length,
        columnCount: header.length,
        columns,
        column: chosen,
        columnName: chosen >= 0 ? (header[chosen] || `column ${chosen + 1}`) : null,
        detectedColumn: detected.index,
        detectedName: detected.name,
        rules: activeRules(ctx.workspaceId).map((r) => ({
            key: r.key, label: r.label, version: r.version, summary: r.summary,
        })),
        ...(stats ?? {}),
    };
}

/* --------------------------------------------------------------- qualify -- */

/**
 * Runs the rules over the file and returns the filtered list.
 *
 * Synchronous, and fast enough to be: evaluation is arithmetic over rows the
 * database already has, so there is no job to poll and no progress stream to
 * keep open. The local version needed both only because it might be driving a
 * browser for twenty minutes first.
 */
export async function qualifyUpload(ctx, { text, columnIndex, selector = 'hcm', filename = 'leads.csv' }) {
    if (!SELECTORS[selector]) {
        throw badRequest(`Unknown selection "${selector}". Choose one of: ${Object.keys(SELECTORS).join(', ')}.`);
    }

    const { parseTable, toCsv, detectCompanyColumn, normalizeCompanySlug, isCompanyUrl, selectQualified } = await loadTools();
    const { header, rows } = parseTable(text);
    if (!header.length) throw badRequest('That file has no rows.');

    const index = Number.isInteger(columnIndex) && columnIndex >= 0
        ? columnIndex
        : detectCompanyColumn(header, rows).index;
    if (index < 0 || index >= header.length) {
        throw badRequest('No LinkedIn company-URL column was found. Pick one from the list.');
    }

    const slugs = uniqueSlugs(rows, index, normalizeCompanySlug);
    const evidence = evidenceBySlug(ctx.workspaceId, slugs);

    /**
     * Refuse a column that identifies no company.
     *
     * `normalizeCompanySlug` accepts a bare slug as well as a URL, deliberately,
     * so any text column looks like slugs. Without this check, picking "Full
     * Name" would run happily and report every row as uncollected instead of
     * saying the column is wrong.
     */
    const usable = rows.filter((row) => isCompanyUrl(row[index]) || evidence.has(normalizeCompanySlug(row[index]))).length;
    if (!usable) {
        throw badRequest(
            `The column "${header[index] || `column ${index + 1}`}" holds no LinkedIn company URLs. `
            + 'Pick the column with links like linkedin.com/company/…',
        );
    }

    const { bySlug, companies, tally, ruleVersions } = await evaluate(ctx, slugs, evidence);
    const selected = selectQualified(header, rows, index, bySlug, selector);

    return {
        selector,
        selectorLabel: SELECTORS[selector],
        column: header[index] || `column ${index + 1}`,
        columnIndex: index,
        // Which version of each rule produced these answers. A verdict whose
        // rule version is not recorded cannot answer "why did this change?",
        // and a downloaded CSV outlives the config that produced it.
        ruleVersions,
        stats: selected.stats,
        tally,
        // Named, not just counted. "412 companies had no evidence" is a
        // statistic; the list of which ones is the thing you take to a laptop.
        companies,
        csv: toCsv(selected.header, selected.rows),
        filename: qualifiedFilename(filename, selector),
        reportCsv: toCsv(REPORT_COLUMNS, companies.map(reportRow)),
        reportFilename: reportFilename(filename),
    };
}

/**
 * Evaluates every company in the file under this workspace's CURRENT rule
 * versions.
 *
 * Not `verdicts.mjs`'s `evaluateAll`, which is the standalone qualifier's own
 * entry point and hard-codes the rule DEFAULTS. In the CRM the published rule
 * version is the authority — that is the entire point of the rules table and
 * of the impact preview that guards changes to it — so a CSV qualified here and
 * an account qualified on its record page must be answering under the same
 * config. Using the defaults would silently make this page disagree with the
 * rest of the product.
 */
async function evaluate(ctx, slugs, evidence) {
    const eng = await loadEngines();
    // `activeRules` already returns the highest version of each key with its
    // config parsed, which is exactly what `currentRule` would look up again.
    const configs = activeRules(ctx.workspaceId)
        .filter((rule) => eng[rule.key])
        .map((rule) => ({ rule, engine: eng[rule.key], config: rule.config }));

    const bySlug = new Map();
    const companies = [];
    const tally = {};
    const ruleVersions = {};
    for (const { rule } of configs) {
        tally[rule.key] = { QUALIFIED: 0, REVIEW: 0, REJECTED: 0, ERROR: 0, UNRESOLVED: 0 };
        ruleVersions[rule.key] = rule.version;
    }

    for (const slug of slugs) {
        const row = evidence.get(slug);

        /**
         * No evidence is UNRESOLVED, never REJECTED. Absence of evidence is not
         * a negative answer (I3), and a lead list that quietly rejected every
         * company nobody had got round to collecting would be worse than
         * useless — it would look like an answer.
         */
        if (!row) {
            const entry = { slug, verdicts: {}, collected: false, error: null };
            for (const { rule } of configs) {
                entry.verdicts[rule.key] = {
                    verdict: 'UNRESOLVED',
                    reasons: ['No evidence has been collected for this company yet.'],
                };
                tally[rule.key].UNRESOLVED += 1;
            }
            companies.push({ ...entry, name: slug, headcount: null });
            continue;
        }

        const payload = safeJson(row.payload);

        if (row.error) {
            const entry = { slug, name: payload.companyName ?? slug, verdicts: {}, collected: true, error: row.error, headcount: null, collectedAt: row.collected_at };
            for (const { rule } of configs) {
                entry.verdicts[rule.key] = { verdict: 'ERROR', reasons: [row.error] };
                tally[rule.key].ERROR += 1;
            }
            companies.push(entry);
            // Present in bySlug so the selector treats it as judged-and-not-
            // qualified rather than as never collected; ERROR is a fact about a
            // company we DID look at.
            bySlug.set(slug, Object.fromEntries(configs.map(({ rule }) => [rule.key, 'ERROR'])));
            continue;
        }

        const snapshot = toSnapshot(payload, eng.cleanFacets);
        const entry = {
            slug,
            name: snapshot.companyName ?? slug,
            url: snapshot.companyUrl ?? `https://www.linkedin.com/company/${slug}/`,
            collected: true,
            collectedAt: row.collected_at,
            error: null,
            headcount: null,
            verdicts: {},
            metrics: {},
        };
        const verdicts = {};

        for (const { rule, engine, config } of configs) {
            const outcome = engine.run(snapshot, config);
            verdicts[rule.key] = outcome.verdict;
            tally[rule.key][outcome.verdict] = (tally[rule.key][outcome.verdict] ?? 0) + 1;
            /**
             * Every reason line, not just the first.
             *
             * The engines return one line per check, and the first is often a
             * PASS on a REVIEW verdict — "PASS: headcount 8573 >= 50" beside the
             * word REVIEW reads as a contradiction unless the line that actually
             * decided it is there too.
             */
            entry.verdicts[rule.key] = {
                verdict: outcome.verdict,
                confidence: outcome.confidence ?? null,
                reasons: outcome.reasons ?? [],
            };
            entry.metrics[rule.key] = outcome.metrics ?? {};
            if (entry.headcount === null && Number.isFinite(outcome.metrics?.headcount)) {
                entry.headcount = outcome.metrics.headcount;
            }
        }

        bySlug.set(slug, verdicts);
        companies.push(entry);
    }

    return { bySlug, companies, tally, ruleVersions };
}

/* ---------------------------------------------------------------- report -- */

/**
 * Every company in the file with its verdict — including the ones that were
 * dropped, and why.
 *
 * The filtered list answers "who do I call?"; this one answers "what happened
 * to the other 300 rows?", which is the immediate next question and the one
 * that decides whether the answer is trusted.
 */
const REPORT_COLUMNS = [
    'Company', 'LinkedIn', 'Slug', 'Collected', 'Collected at', 'Headcount',
    'HCM', 'HCM reason', 'Offshoring', 'Offshoring reason',
];

function reportRow(company) {
    const hcm = company.verdicts?.hcm ?? {};
    const off = company.verdicts?.offshoring ?? {};
    const why = (v) => (v.reasons ?? []).join(' | ');
    return [
        company.name ?? company.slug,
        company.url ?? `https://www.linkedin.com/company/${company.slug}/`,
        company.slug,
        company.collected ? 'yes' : 'no',
        company.collectedAt ?? '',
        company.headcount ?? '',
        hcm.verdict ?? '',
        why(hcm),
        off.verdict ?? '',
        why(off),
    ];
}

/* --------------------------------------------------------------- helpers -- */

function uniqueSlugs(rows, index, normalize) {
    const set = new Set();
    for (const row of rows) {
        const slug = normalize(row[index]);
        if (slug) set.add(slug);
    }
    return [...set];
}

function safeJson(value) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(value ?? '{}'); } catch { return {}; }
}

function qualifiedFilename(original, selector) {
    return `${String(original).replace(/\.csv$/i, '')} - ${selector} qualified.csv`;
}

function reportFilename(original) {
    return `${String(original).replace(/\.csv$/i, '')} - qualification report.csv`;
}
