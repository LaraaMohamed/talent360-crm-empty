/**
 * Links commercial documents that were left with no deal.
 *
 *   node link-orphaned-documents.mjs            what would change
 *   node link-orphaned-documents.mjs --write    do it
 *
 * ── WHAT IT FIXES ────────────────────────────────────────────────────────────
 *
 * Proposals and agreements used to be creatable without a deal (the wizard
 * path), so production has rows whose `deal_id` is null. A document with no
 * deal never reaches a forecast and its currency can disagree with the account
 * without anything on the dashboard noticing.
 *
 * The rule now is that every proposal and agreement belongs to a deal — found
 * or created for its account, one per opportunity, never a duplicate (see
 * `ensureDealForAgreement` in lib/repo.mjs). This script applies that rule to
 * the rows written before it existed.
 *
 * ── WHAT IT WILL NOT TOUCH ──────────────────────────────────────────────────
 *
 * A document already on a deal is left alone. A document whose account cannot
 * be resolved (no account_id, or an account that no longer exists) is reported
 * and skipped rather than guessed at. Deal prices are not changed.
 */
import { all, get, run, migrate, close, describe, now } from './lib/db.mjs';
import { ensureDealForAgreement, syncDealValues } from './lib/repo.mjs';

const WRITE = process.argv.includes('--write');

migrate();

const workspaces = all('SELECT id, name FROM workspaces');

console.log('');
console.log(`  Database  ${describe()}`);
console.log(`  Mode      ${WRITE ? 'WRITE' : 'dry run — pass --write to apply'}`);
console.log('');

let proposalsLinked = 0;
let agreementsLinked = 0;
let skipped = 0;

for (const workspace of workspaces) {
    const ctx = { workspaceId: workspace.id, userId: null, role: 'owner', workspace: { id: workspace.id, baseCurrency: 'USD' } };

    for (const table of ['proposals', 'agreements']) {
        const label = table === 'proposals' ? 'proposal' : 'agreement';
        const rows = all(
            `SELECT * FROM ${table} WHERE workspace_id = ? AND (deal_id IS NULL OR deal_id = '')`,
            [workspace.id],
        );
        for (const row of rows) {
            if (!row.account_id) {
                console.log(`  ${label} ${row.number}: no account_id — skipped`);
                skipped += 1;
                continue;
            }
            const account = get('SELECT * FROM accounts WHERE id = ? AND workspace_id = ?', [row.account_id, workspace.id]);
            if (!account) {
                console.log(`  ${label} ${row.number}: account ${row.account_id} not found — skipped`);
                skipped += 1;
                continue;
            }

            const deal = ensureDealForAgreement(ctx, {
                accountId: account.id,
                serviceLineKey: row.service_line_key ?? null,
                currency: account.billing_currency ?? row.currency ?? null,
                price: row.contract_value ?? null,
                because: `linking orphaned ${label} ${row.number}`,
            });
            if (!deal) {
                console.log(`  ${label} ${row.number}: no pipeline configured, could not create a deal — skipped`);
                skipped += 1;
                continue;
            }

            if (WRITE) {
                run(`UPDATE ${table} SET deal_id = ?, updated_at = ? WHERE id = ?`, [deal.id, now(), row.id]);
            }
            console.log(`  ${label} ${row.number} -> deal ${deal.id}${WRITE ? '' : ' (dry run)'}`);
            if (table === 'agreements' && deal) syncDealValues(deal.id, ctx);
            if (table === 'proposals') proposalsLinked += 1;
            else agreementsLinked += 1;
        }
    }
}

console.log('');
console.log(`  proposals linked:  ${proposalsLinked}`);
console.log(`  agreements linked: ${agreementsLinked}`);
console.log(`  skipped:           ${skipped}`);
if (!WRITE) {
    console.log('');
    console.log('  Dry run only. Re-run with --write to apply.');
}
close();
