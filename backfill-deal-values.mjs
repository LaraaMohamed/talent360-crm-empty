/**
 * Fills in the cached deal rollups for deals that predate them.
 *
 *   node backfill-deal-values.mjs            what would change
 *   node backfill-deal-values.mjs --write    do it
 *
 * `deals.value_one_time` and its siblings are a SORT INDEX over the line items —
 * see the comment on the table in schema.sql. Every write path keeps them
 * current from now on (`syncDealValues`, called by `touch()` in api/deals.mjs
 * and by the stage move), but a deal nobody has edited since the columns were
 * added still reads zero, and a zero sorts like a zero. This is the one pass
 * that catches those up.
 *
 * It is safe to run repeatedly, and safe to run against a live database: it
 * writes nothing but the five cached columns, leaves `updated_at` alone — a
 * recomputed cache is not an edit somebody made — and touches no line item.
 */
import { all, get, run, migrate, close, describe } from './lib/db.mjs';
import { syncDealValues } from './lib/repo.mjs';

const WRITE = process.argv.includes('--write');

migrate();

console.log('');
console.log(`  Database  ${describe()}`);
console.log(`  Mode      ${WRITE ? 'WRITE' : 'dry run — pass --write to apply'}`);
console.log('');

const workspaces = all('SELECT id, name, base_currency, timezone FROM workspaces');
if (!workspaces.length) {
    console.log('  No workspaces. Nothing to do.');
    close();
    process.exit(0);
}

let examined = 0;
let changed = 0;
const samples = [];

for (const workspace of workspaces) {
    // `syncDealValues` reads the workspace's base currency off the context, the
    // same way a request would, so a backfilled figure and a freshly written one
    // are computed identically.
    const ctx = {
        workspaceId: workspace.id,
        workspace: { id: workspace.id, baseCurrency: workspace.base_currency, timezone: workspace.timezone },
    };

    const deals = all(
        'SELECT id, name, value_one_time, value_mrr FROM deals WHERE workspace_id = ? AND deleted_at IS NULL',
        [workspace.id],
    );

    for (const deal of deals) {
        examined += 1;
        const before = { one_time: deal.value_one_time ?? 0, mrr: deal.value_mrr ?? 0 };

        if (!WRITE) {
            // Dry run: compute without writing, by reading what a sync would
            // store and comparing. Cheaper than a transaction we roll back.
            const items = all('SELECT * FROM deal_line_items WHERE deal_id = ?', [deal.id]);
            if (!items.length && !before.one_time && !before.mrr) continue;
        }

        const after = WRITE
            ? syncDealValues(deal.id, ctx)
            : computeWithoutWriting(deal.id, ctx);
        if (!after) continue;

        const moved = Math.abs((after.value_one_time ?? 0) - before.one_time) > 0.005
            || Math.abs((after.value_mrr ?? 0) - before.mrr) > 0.005;
        if (!moved) continue;

        changed += 1;
        if (samples.length < 15) {
            samples.push({
                name: deal.name,
                from: before,
                to: { one_time: after.value_one_time ?? 0, mrr: after.value_mrr ?? 0 },
            });
        }
    }
}

/** The same derivation the writer uses, without the UPDATE. */
function computeWithoutWriting(dealId, ctx) {
    const items = all('SELECT * FROM deal_line_items WHERE deal_id = ? ORDER BY position', [dealId]);
    const row = get(
        `SELECT d.probability, s.probability AS stage_probability
           FROM deals d LEFT JOIN stages s ON s.id = d.stage_id WHERE d.id = ?`,
        [dealId],
    );
    // Imported here rather than at the top so the dry run and the write share
    // exactly one implementation of the maths.
    return deriveForBackfill(items, {
        probability: row?.probability ?? row?.stage_probability ?? 0,
        baseCurrency: ctx.workspace.baseCurrency,
    });
}

const { deriveValues } = await import('./lib/money.mjs');
function deriveForBackfill(items, options) {
    const v = deriveValues(items, options);
    return {
        value_one_time: v.value_one_time,
        value_mrr: v.value_mrr,
        value_arr: v.value_arr,
        value_weighted: v.value_weighted,
        value_tcv: v.value_tcv,
    };
}

console.log(`  Deals examined   ${examined}`);
console.log(`  Would change     ${changed}`);
console.log('');

if (samples.length) {
    console.log('  For example:');
    for (const s of samples) {
        console.log(`    ${s.name}`);
        console.log(`      one-time ${s.from.one_time} → ${s.to.one_time}`);
        console.log(`      mrr      ${s.from.mrr} → ${s.to.mrr}`);
    }
    console.log('');
}

if (!WRITE && changed > 0) {
    console.log('  Nothing was written. Run again with --write to apply.');
    console.log('');
}
if (WRITE) {
    console.log(`  ${changed} deal(s) updated. Line items were not touched.`);
    console.log('');
}

close();
