/**
 * Puts every live calling-queue entry on the ready_to_call deal stage.
 *
 *   node backfill-ready-to-call.mjs            what would change
 *   node backfill-ready-to-call.mjs --write    do it
 *
 * ── WHAT IT FIXES ────────────────────────────────────────────────────────────
 *
 * `assignContacts` moves a contact's account deal to the `ready_to_call` stage
 * at assignment time, so the pipeline reads the same thing the calling queue
 * is doing. Contacts assigned BEFORE that rule existed — or seeded straight
 * into `calling_assignments` — never had it done, so their account deal (if
 * any) is still wherever it was, or there is no deal at all.
 *
 * This finds every ACTIVE queue entry, resolves each one's account, ensures a
 * deal exists for it (one per account, never a duplicate), and moves that deal
 * to `ready_to_call`. It is a no-op for entries with no account, for accounts
 * whose deal is already there, and for stages that do not exist.
 */
import { all, migrate, close, describe } from './lib/db.mjs';
import { ensureReadyToCall } from './lib/calling.mjs';

const WRITE = process.argv.includes('--write');

migrate();

const workspaces = all('SELECT id, name FROM workspaces');

console.log('');
console.log(`  Database  ${describe()}`);
console.log(`  Mode      ${WRITE ? 'WRITE' : 'dry run — pass --write to apply'}`);
console.log('');

let accounts = 0;
let entries = 0;

for (const workspace of workspaces) {
    const ctx = { workspaceId: workspace.id, userId: null, role: 'owner', workspace: { id: workspace.id, baseCurrency: 'USD' } };
    const assignments = all(
        `SELECT DISTINCT account_id FROM calling_assignments
          WHERE workspace_id = ? AND active = 1 AND account_id IS NOT NULL`,
        [workspace.id],
    );
    if (!assignments.length) continue;
    const ids = assignments.map((a) => a.account_id);
    const accountRows = all(
        `SELECT COUNT(*) AS n FROM calling_assignments
          WHERE workspace_id = ? AND active = 1 AND account_id IN (${ids.map(() => '?').join(',')})`,
        [workspace.id, ...ids],
    );
    entries += Number(accountRows[0]?.n) || 0;

    for (const row of assignments) {
        const deal = WRITE ? ensureReadyToCall(ctx, row.account_id) : { id: '?' };
        console.log(`  account ${row.account_id} -> deal ${deal?.id ?? '(none — no pipeline)'}${WRITE ? '' : ' (dry run)'}`);
        accounts += deal ? 1 : 0;
    }
}

console.log('');
console.log(`  accounts ensured ready to cold call:  ${accounts}`);
console.log(`  active queue entries covered:         ${entries}`);
if (!WRITE) {
    console.log('');
    console.log('  Dry run only. Re-run with --write to apply.');
}
close();
