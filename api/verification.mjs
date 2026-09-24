/**
 * Email verification endpoints.
 *
 * One handler pair for both people-objects — CRM contacts and prospecting
 * contacts — because "is this address good?" is the same question either side
 * of the import, and answering it twice in two files is how the two answers
 * start to disagree.
 *
 * Every check appends to `email_verifications` as well as updating the record.
 * The record answers "can I email this person now?"; the history answers "why
 * does it say that, and what did it say before?" — which is the question asked
 * when a campaign bounces and nobody can remember what was checked.
 */
import { getRecord, idsMatching, audit } from '../lib/repo.mjs';
import { objectDef } from '../lib/objects.mjs';
import {
    verifyAddress, isConfigured, activeProvider, describe, SAFE,
} from '../lib/verification.mjs';
import { readJson, badRequest, notFound } from '../lib/http.mjs';
import { require$, can } from '../lib/auth.mjs';
import { all, get, run, id, now } from '../lib/db.mjs';
import { objectFromRoute } from './records.mjs';

/** The two objects that carry an email address a provider can check. */
const VERIFIABLE = new Set(['contact', 'prospecting_contact']);

function assertVerifiable(objectKey) {
    if (!VERIFIABLE.has(objectKey)) {
        throw badRequest(`${objectKey} records do not carry a verifiable email address.`);
    }
}

/**
 * Runs one check and records it in both places.
 *
 * Returns the standardized result rather than the record, so a bulk caller can
 * tally statuses without re-reading every row it just wrote.
 */
async function runOne(objectKey, ctx, recordId) {
    const record = getRecord(objectKey, ctx, recordId);
    if (!record) throw notFound('That contact no longer exists.');

    const result = await verifyAddress(record.email, ctx);

    /**
     * Written with SQL, not `updateRecord`.
     *
     * These fields are `readOnly` in the field registry — deliberately, so
     * nobody can type "verified" into a form — and `updateRecord` silently
     * SKIPS read-only fields (lib/repo.mjs). Routing the provider's answer
     * through it therefore recorded the history and dropped the record update,
     * leaving contacts that had been checked still looking unchecked, and the
     * import policy with nothing to act on. Derived, system-written columns go
     * straight to the table, exactly as lead scores do.
     */
    const table = objectDef(objectKey).table;
    run(
        `UPDATE ${table}
            SET email_verified = ?, verification_status = ?, verification_provider = ?,
                verification_confidence = ?, verified_at = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ?`,
        [
            SAFE.has(result.status) ? 1 : 0, result.status, result.provider,
            result.confidence, result.checkedAt, now(), recordId, ctx.workspaceId,
        ],
    );

    audit(ctx, {
        objectKey, recordId, action: 'email_verified',
        after: { status: result.status, provider: result.provider, confidence: result.confidence },
    });

    run(
        `INSERT INTO email_verifications
           (id, workspace_id, subject_type, subject_id, email, status, confidence, provider, raw, checked_by, checked_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
            id('evr'), ctx.workspaceId, objectKey, recordId, result.email, result.status,
            result.confidence, result.provider, JSON.stringify(result.raw ?? {}),
            ctx.userId ?? null, result.checkedAt,
        ],
    );

    return result;
}

/* --------------------------------------------------------------- single -- */

export async function verifyOne({ params, ctx }) {
    const objectKey = objectFromRoute(params.object);
    assertVerifiable(objectKey);
    require$(ctx, can(ctx, 'record.write.all') ? 'record.write.all' : 'record.write.own');

    const result = await runOne(objectKey, ctx, params.id);
    return {
        verification: {
            ...result,
            ...describe(result.status),
            // Stated explicitly rather than left to be inferred from the status.
            // "Accept-all" is a successful check that still is not safe to send,
            // and the caller should not have to know which statuses those are.
            safeToSend: SAFE.has(result.status),
            // The raw payload is deliberately not returned to the browser. It
            // is provider-shaped, and anything reading it in the UI would be a
            // second place that has to change when the provider does.
            raw: undefined,
        },
    };
}

/* ----------------------------------------------------------------- bulk -- */

/**
 * Verify many at once.
 *
 * Accepts either explicit `ids` or `all: true` with the caller's filter, so
 * "verify every contact in this view" is one request rather than the browser
 * firing five hundred. Runs sequentially on purpose: these are paid API calls
 * against a third party with its own rate limits, and a burst of parallel
 * requests is the fastest way to get a workspace throttled or billed twice for
 * retries.
 */
export async function verifyBulk({ req, params, ctx }) {
    const objectKey = objectFromRoute(params.object);
    assertVerifiable(objectKey);
    require$(ctx, can(ctx, 'record.write.all') ? 'record.write.all' : 'record.write.own');

    if (!isConfigured(ctx.workspaceId)) {
        throw badRequest('No verification provider is configured. Add an API key in Settings first.');
    }

    const body = await readJson(req);
    const MAX = 500;

    let ids = Array.isArray(body.ids) ? body.ids : [];
    if (body.all) {
        // `.ids` — idsMatching returns { ids, total }, not an array.
        ids = idsMatching(objectKey, ctx, { filter: body.filter ?? null, listId: body.listId ?? null, q: body.q ?? null }).ids;
    }
    if (!ids.length) throw badRequest('Select some contacts to verify.');
    if (ids.length > MAX) {
        throw badRequest(`That is ${ids.length} contacts. Verification is a paid, rate-limited call, so it is capped at ${MAX} per run — narrow the selection and repeat.`);
    }

    // Already-checked addresses are skipped unless asked for, so re-running a
    // view does not re-bill every contact in it.
    const reverify = body.reverify === true;

    const tally = {};
    const failures = [];
    let checked = 0;
    let skipped = 0;

    for (const recordId of ids) {
        try {
            const record = getRecord(objectKey, ctx, recordId);
            if (!record) { skipped += 1; continue; }
            if (!reverify && record.verification_status) { skipped += 1; continue; }

            const result = await runOne(objectKey, ctx, recordId);
            tally[result.status] = (tally[result.status] ?? 0) + 1;
            checked += 1;
        } catch (err) {
            failures.push({ id: recordId, error: err.message });
        }
    }

    return {
        checked,
        skipped,
        failures,
        provider: activeProvider(ctx.workspaceId).label,
        tally: Object.entries(tally).map(([status, count]) => ({ ...describe(status), count }))
            .sort((a, b) => b.count - a.count),
        note: skipped
            ? `${skipped} were skipped because they already had a result. Re-run with "re-verify" to check them again.`
            : null,
    };
}

/* -------------------------------------------------------------- history -- */

export async function history({ params, ctx }) {
    const objectKey = objectFromRoute(params.object);
    assertVerifiable(objectKey);

    const rows = all(
        `SELECT v.*, u.name AS checked_by_name
           FROM email_verifications v
           LEFT JOIN users u ON u.id = v.checked_by
          WHERE v.workspace_id = ? AND v.subject_type = ? AND v.subject_id = ?
          ORDER BY v.checked_at DESC
          LIMIT 50`,
        [ctx.workspaceId, objectKey, params.id],
    );

    return {
        configured: isConfigured(ctx.workspaceId),
        entries: rows.map((r) => ({
            id: r.id,
            email: r.email,
            ...describe(r.status),
            confidence: r.confidence,
            provider: r.provider,
            checkedAt: r.checked_at,
            checkedBy: r.checked_by_name ?? 'Automatic',
        })),
    };
}

/**
 * Workspace-wide email quality, for the dashboard.
 */
export function emailQuality(ctx) {
    const counts = (table) => all(
        `SELECT verification_status AS status, COUNT(*) AS n
           FROM ${table}
          WHERE workspace_id = ? AND deleted_at IS NULL AND email IS NOT NULL AND TRIM(email) <> ''
          GROUP BY verification_status`,
        [ctx.workspaceId],
    );
    const merged = new Map();
    for (const row of [...counts('contacts'), ...counts('prospecting_contacts')]) {
        const key = row.status ?? 'unchecked';
        merged.set(key, (merged.get(key) ?? 0) + row.n);
    }
    return merged;
}
