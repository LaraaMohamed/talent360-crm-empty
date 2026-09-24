/**
 * Puts the right exchange rate on line items written before there was one.
 *
 *   node backfill-line-item-fx.mjs            what would change
 *   node backfill-line-item-fx.mjs --write    do it
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 *
 * `fx_rate` on a line item defaulted to 1 whatever currency the line was in.
 * A 1,000 USD line inside a workspace based in SAR therefore contributed 1,000
 * to a SAR total instead of 3,750 — every base-currency figure in the product
 * was adding dollars to riyals and calling the answer riyals. New and edited
 * lines now take the rate from the workspace's own reporting rates; this is
 * the pass for everything written before that.
 *
 * ── WHAT IT WILL NOT TOUCH ──────────────────────────────────────────────────
 *
 * A line whose currency IS the base currency is already correct at 1 and is
 * left alone. A line carrying a rate that is neither 1 nor the current rate
 * was deliberately set by somebody — a contract can fix a rate on the day it
 * is signed — and is reported but never overwritten. Only the lines still
 * sitting at the old default are changed.
 *
 * Amounts are not touched. `unit_amount` is what the client is charged in
 * their own currency and does not become a different number because the
 * reporting improved.
 */
import { all, get, run, migrate, close, describe, now } from './lib/db.mjs';
import { reportingRates } from './lib/money.mjs';
import { setting } from './lib/settings.mjs';
import { syncDealValues } from './lib/repo.mjs';

const WRITE = process.argv.includes('--write');

migrate();

console.log('');
console.log(`  Database  ${describe()}`);
console.log(`  Mode      ${WRITE ? 'WRITE' : 'dry run — pass --write to apply'}`);
console.log('');

let examined = 0;
let corrected = 0;
let deliberate = 0;
const touchedDeals = new Set();
const samples = [];

for (const workspace of all('SELECT id, name, base_currency FROM workspaces')) {
    const base = workspace.base_currency || 'SAR';
    const rates = reportingRates((key) => setting(workspace.id, key));
    const perUsdBase = Number(rates[base]);

    if (!(perUsdBase > 0)) {
        console.log(`  ${workspace.name}: no rate for the base currency ${base} — skipped`);
        continue;
    }

    const lines = all(
        `SELECT li.id, li.deal_id, li.label, li.currency, li.fx_rate, d.name AS deal_name
           FROM deal_line_items li
           JOIN deals d ON d.id = li.deal_id
          WHERE li.workspace_id = ? AND d.deleted_at IS NULL`,
        [workspace.id],
    );

    for (const line of lines) {
        examined += 1;
        const currency = line.currency || base;
        if (currency === base) continue;               // 1 is already right

        const perUsdFrom = Number(rates[currency]);
        if (!(perUsdFrom > 0)) continue;               // no rate to apply

        const wanted = perUsdBase / perUsdFrom;
        const current = Number(line.fx_rate);

        // Anything that is not the old default was somebody's decision.
        if (Math.abs(current - 1) > 1e-9) { deliberate += 1; continue; }
        if (Math.abs(wanted - 1) < 1e-9) continue;

        corrected += 1;
        touchedDeals.add(line.deal_id);
        if (samples.length < 15) {
            samples.push({
                deal: line.deal_name, label: line.label,
                currency, from: current, to: Math.round(wanted * 10000) / 10000,
            });
        }
        if (WRITE) run('UPDATE deal_line_items SET fx_rate = ? WHERE id = ?', [wanted, line.id]);
    }

    // The cached rollups are derived from these lines, so they are stale the
    // moment a rate changes. Same writer the API uses, so there is one
    // implementation of the maths.
    if (WRITE) {
        const ctx = {
            workspaceId: workspace.id,
            workspace: { id: workspace.id, baseCurrency: base },
        };
        for (const dealId of touchedDeals) syncDealValues(dealId, ctx);
    }
}

console.log(`  Line items examined        ${examined}`);
console.log(`  ${WRITE ? 'Corrected' : 'Would correct'}              ${corrected}`);
console.log(`  Left alone (rate was set)  ${deliberate}`);
console.log(`  Deals affected             ${touchedDeals.size}`);
console.log('');

if (samples.length) {
    console.log('  For example:');
    for (const s of samples) {
        console.log(`    ${s.deal} — ${s.label} (${s.currency})`);
        console.log(`      fx_rate ${s.from} → ${s.to}`);
    }
    console.log('');
}

if (!WRITE && corrected > 0) {
    console.log('  Nothing was written. Run again with --write to apply.');
    console.log('');
}
if (WRITE && corrected > 0) {
    console.log('  Amounts were not touched — only the rate used to convert them.');
    console.log('');
}

close();
