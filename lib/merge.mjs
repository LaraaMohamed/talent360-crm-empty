/**
 * Duplicate resolution — deciding, field by field, what survives a merge.
 *
 * ── THE ONE RULE THAT MATTERS ───────────────────────────────────────────────
 *
 * A populated value is NEVER replaced by an empty one. Every other rule here is
 * a preference; this one is a guarantee. The most common way a CRM loses data
 * is not a bad merge decision, it is a thin record arriving from an import and
 * blanking fields that took someone a phone call to fill in. Emptiness is the
 * absence of information, never a statement that the old value was wrong.
 *
 * ── PRECEDENCE, IN ORDER ────────────────────────────────────────────────────
 *
 *   1. Non-empty beats empty.                        (the guarantee above)
 *   2. Identical values need no decision.
 *   3. Verified beats unverified.                    (a checked email wins)
 *   4. Enriched beats hand-entered-and-stale.
 *   5. Newer beats older.
 *   6. Anything still tied is a CONFLICT for a human.
 *
 * A conflict is deliberately not resolved by coin-toss. Two different non-empty
 * values both of which look current is exactly the case where guessing quietly
 * destroys the right answer, so it is surfaced and the merge preview refuses to
 * pretend it decided.
 */
import { fieldsFor } from './objects.mjs';

/** Empty means "nobody said", and is never evidence. */
export function isEmpty(value) {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.length === 0;
    return false;
}

function sameValue(a, b) {
    if (isEmpty(a) && isEmpty(b)) return true;
    if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
    return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

function timeOf(value) {
    if (!value) return 0;
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? t : 0;
}

/**
 * How much a record deserves to win a tie, independent of any one field.
 *
 * Verification and enrichment are evidence that a record was CHECKED, not
 * merely touched — which is why they outrank a bare `updated_at`, and why an
 * import that rewrote a row five minutes ago does not beat a record whose email
 * a human verified last week.
 */
function authorityOf(record) {
    return {
        verifiedAt: timeOf(record.verified_at),
        enrichedAt: timeOf(record.enriched_at ?? record.last_enriched_at),
        updatedAt: timeOf(record.updated_at),
    };
}

/**
 * Field-by-field plan for merging `loser` into `survivor`.
 *
 * Returns every field where the two differ, with the winning value and the
 * reason it won. Fields that already agree are omitted: a preview that lists
 * sixty unchanged rows hides the four that matter.
 */
export function mergePlan(objectKey, workspaceId, survivor, loser) {
    const fields = fieldsFor(objectKey, workspaceId)
        .filter((f) => !f.computed && !f.readOnly && f.key !== 'id')
        .filter((f) => !['created_at', 'updated_at'].includes(f.key));

    const a = authorityOf(survivor);
    const b = authorityOf(loser);

    const rows = [];
    for (const field of fields) {
        const read = (record) => (field.custom
            ? record.properties?.[field.key.replace('properties.', '')]
            : record[field.key]);

        const mine = read(survivor);
        const theirs = read(loser);

        if (sameValue(mine, theirs)) continue;

        let chosen;
        let from;
        let reason;
        let conflict = false;

        if (isEmpty(mine) && !isEmpty(theirs)) {
            chosen = theirs; from = 'loser';
            reason = 'The surviving record has nothing here.';
        } else if (!isEmpty(mine) && isEmpty(theirs)) {
            chosen = mine; from = 'survivor';
            reason = 'Kept — an empty value never overwrites a populated one.';
        } else if (b.verifiedAt > a.verifiedAt) {
            chosen = theirs; from = 'loser';
            reason = 'The duplicate carries the more recent verification.';
        } else if (a.verifiedAt > b.verifiedAt) {
            chosen = mine; from = 'survivor';
            reason = 'This record carries the more recent verification.';
        } else if (b.enrichedAt > a.enrichedAt) {
            chosen = theirs; from = 'loser';
            reason = 'The duplicate was enriched more recently.';
        } else if (a.enrichedAt > b.enrichedAt) {
            chosen = mine; from = 'survivor';
            reason = 'This record was enriched more recently.';
        } else if (b.updatedAt > a.updatedAt) {
            chosen = theirs; from = 'loser';
            reason = 'The duplicate was updated more recently.';
            conflict = true;
        } else if (a.updatedAt > b.updatedAt) {
            chosen = mine; from = 'survivor';
            reason = 'This record was updated more recently.';
            conflict = true;
        } else {
            chosen = mine; from = 'survivor';
            reason = 'Both values look equally current. Choose one.';
            conflict = true;
        }

        rows.push({
            key: field.key,
            label: field.label,
            type: field.type,
            custom: Boolean(field.custom),
            survivorValue: mine ?? null,
            loserValue: theirs ?? null,
            chosen: chosen ?? null,
            from,
            reason,
            // A conflict is only a conflict when BOTH sides hold something.
            // "One side is empty" is decided, not disputed.
            conflict: conflict && !isEmpty(mine) && !isEmpty(theirs),
        });
    }

    return rows;
}

/**
 * The subset of a plan that actually changes the survivor, as a
 * `{ fieldKey: value }` map ready to apply.
 *
 * Custom fields are excluded: they live in a JSON column and are written
 * through the record layer, not through a column update.
 */
export function appliedChanges(plan) {
    const out = {};
    for (const row of plan) {
        if (row.from !== 'loser' || row.custom) continue;
        out[row.key] = row.chosen;
    }
    return out;
}
