/**
 * Lead scoring endpoints.
 *
 * The model is workspace configuration; the scores are derived data. That
 * separation is the point: changing a weight must never silently rewrite
 * history, so publishing a model does NOT rescore anything on its own. A
 * rescore is an explicit act with a visible count, because "why did every lead
 * change overnight?" is a question nobody should have to ask.
 */
import { scoreCompany, resolveModel, DEFAULT_MODEL, SCORE_COLUMNS } from '../lib/scoring.mjs';
import { setting, setSetting } from '../lib/settings.mjs';
import { getRecord, idsMatching, audit } from '../lib/repo.mjs';
import { readJson, badRequest, notFound } from '../lib/http.mjs';
import { require$, can } from '../lib/auth.mjs';
import { all, get, run, now, json } from '../lib/db.mjs';
import { objectFromRoute } from './records.mjs';

/** The two planes a company can live on, and where their bits are kept. */
const PLANES = {
    account: {
        table: 'accounts',
        verdictTable: 'verdicts',
        verdictId: 'account_id',
        contactTable: 'contacts',
        contactFk: 'account_id',
        evidenceTable: 'evidence_snapshots',
        evidenceFk: 'account_id',
    },
    prospecting_company: {
        table: 'prospecting_companies',
        verdictTable: 'prospecting_verdicts',
        verdictId: 'prospect_id',
        contactTable: 'prospecting_contacts',
        contactFk: 'prospect_id',
        // Prospects have their OWN evidence table, mirroring their own verdict
        // table. `evidence_snapshots` is the account plane and is keyed by
        // `account_id`; reading it for a prospect finds nothing, which scored
        // every prospect as "never enriched" while 1,233 snapshots sat in the
        // table next door.
        evidenceTable: 'prospecting_evidence_snapshots',
        evidenceFk: 'prospect_id',
    },
};

export function activeModel(workspaceId) {
    return resolveModel(setting(workspaceId, 'scoring_model'));
}

/**
 * Everything one company's score depends on, read in three queries.
 *
 * Gathered here rather than inside `scoreCompany` so the scoring rules stay
 * pure and testable without a database.
 */
function inputsFor(plane, ctx, record) {
    const verdictRows = all(
        `SELECT rule_key, verdict FROM ${plane.verdictTable}
          WHERE ${plane.verdictId} = ? AND is_current = 1`,
        [record.id],
    );
    const verdicts = {};
    for (const row of verdictRows) verdicts[row.rule_key] = { verdict: row.verdict };

    const contacts = all(
        `SELECT roles, email_verified FROM ${plane.contactTable}
          WHERE ${plane.contactFk} = ? AND deleted_at IS NULL`,
        [record.id],
    ).map((c) => ({ ...c, roles: json(c.roles, []) }));

    const evidence = get(
        `SELECT collected_at FROM ${plane.evidenceTable}
          WHERE ${plane.evidenceFk} = ? ORDER BY collected_at DESC LIMIT 1`,
        [record.id],
    );

    return { verdicts, contacts, evidenceAt: evidence?.collected_at ?? null };
}

/** Score one company and write the result. Returns the computed score. */
export function scoreAndStore(objectKey, ctx, recordId, model = null) {
    const plane = PLANES[objectKey];
    if (!plane) throw badRequest(`${objectKey} records are not scored.`);

    const record = getRecord(objectKey, ctx, recordId);
    if (!record) throw notFound('That company no longer exists.');

    const resolved = model ?? activeModel(ctx.workspaceId);
    const result = scoreCompany(record, inputsFor(plane, ctx, record), resolved);

    const columns = Object.entries(SCORE_COLUMNS);
    run(
        `UPDATE ${plane.table} SET ${columns.map(([, col]) => `${col} = ?`).join(', ')},
                scored_at = ?, score_model_version = ? WHERE id = ? AND workspace_id = ?`,
        [
            ...columns.map(([key]) => (key === 'overall' ? result.overall : result.components[key]?.score ?? null)),
            now(), result.modelVersion, record.id, ctx.workspaceId,
        ],
    );

    return result;
}

/* ----------------------------------------------------------------- model -- */

export async function getModel({ ctx }) {
    return {
        model: activeModel(ctx.workspaceId),
        defaults: DEFAULT_MODEL,
        note: 'Weights are relative and normalised, so they need not sum to 100. '
            + 'Saving a model does not rescore anything — run a rescore when you are ready.',
    };
}

export async function putModel({ req, ctx }) {
    require$(ctx, 'record.write.all');
    const body = await readJson(req);
    const model = resolveModel(body.model ?? body);

    for (const [key, weight] of Object.entries(model.weights ?? {})) {
        if (Number(weight) < 0) throw badRequest(`Weight for "${key}" cannot be negative.`);
    }
    const total = Object.values(model.weights ?? {}).reduce((a, w) => a + (Number(w) || 0), 0);
    if (total <= 0) throw badRequest('At least one component must carry a weight, or every score would be zero.');

    // Bumped on every save so a stored score can be traced to the model that
    // produced it, and a stale score is recognisable rather than merely old.
    model.version = (activeModel(ctx.workspaceId).version ?? 1) + 1;
    setSetting(ctx.workspaceId, 'scoring_model', model);

    audit(ctx, {
        objectKey: 'account', recordId: null, action: 'scoring_model_published',
        after: { version: model.version, weights: model.weights },
    });

    return {
        model,
        note: 'Saved. Existing scores are unchanged until you rescore — a weight change must not silently rewrite history.',
    };
}

/* --------------------------------------------------------------- scoring -- */

export async function scoreOne({ params, ctx }) {
    const objectKey = objectFromRoute(params.object);
    require$(ctx, can(ctx, 'record.write.all') ? 'record.write.all' : 'record.write.own');
    const result = scoreAndStore(objectKey, ctx, params.id);
    return { score: result };
}

/**
 * Rescore many.
 *
 * Cheap and local — no third-party calls — so unlike verification this runs
 * over a whole selection without a cap worth arguing about. It is still an
 * explicit act rather than a side effect of saving the model.
 */
export async function scoreBulk({ req, params, ctx }) {
    const objectKey = objectFromRoute(params.object);
    require$(ctx, can(ctx, 'record.write.all') ? 'record.write.all' : 'record.write.own');

    const body = await readJson(req);
    const model = activeModel(ctx.workspaceId);

    let ids = Array.isArray(body.ids) ? body.ids : [];
    if (body.all) ids = idsMatching(objectKey, ctx, { filter: body.filter ?? null, listId: body.listId ?? null, q: body.q ?? null }).ids;
    if (!ids.length) throw badRequest('Select some companies to score.');

    let scored = 0;
    const failures = [];
    const buckets = { hot: 0, warm: 0, cool: 0, cold: 0 };

    for (const id of ids) {
        try {
            const result = scoreAndStore(objectKey, ctx, id, model);
            scored += 1;
            const s = result.overall;
            if (s >= 75) buckets.hot += 1;
            else if (s >= 50) buckets.warm += 1;
            else if (s >= 25) buckets.cool += 1;
            else buckets.cold += 1;
        } catch (err) {
            failures.push({ id, error: err.message });
        }
    }

    return {
        scored,
        failures,
        modelVersion: model.version ?? 1,
        buckets,
        note: `${buckets.hot} scored 75+, ${buckets.warm} scored 50-74.`,
    };
}

/** The breakdown behind one company's score, for the record page. */
export async function explain({ params, ctx }) {
    const objectKey = objectFromRoute(params.object);
    const plane = PLANES[objectKey];
    if (!plane) throw badRequest(`${objectKey} records are not scored.`);

    const record = getRecord(objectKey, ctx, params.id);
    if (!record) throw notFound('That company no longer exists.');

    const model = activeModel(ctx.workspaceId);
    const result = scoreCompany(record, inputsFor(plane, ctx, record), model);

    return {
        // Recomputed live, so the breakdown always explains the CURRENT inputs.
        // The stored figure is returned beside it: when they disagree, the
        // record simply has not been rescored, and saying so is more useful
        // than silently showing either one.
        live: result,
        stored: {
            overall: record.score_overall ?? null,
            scoredAt: record.scored_at ?? null,
            modelVersion: record.score_model_version ?? null,
        },
        stale: record.score_overall !== null && record.score_overall !== result.overall,
    };
}
