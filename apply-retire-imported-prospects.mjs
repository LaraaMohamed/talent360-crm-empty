/**
 * Retires prospects that were already imported, under the old behaviour.
 *
 *   node apply-retire-imported-prospects.mjs            # show what would change
 *   node apply-retire-imported-prospects.mjs --apply    # write it
 *   node --env-file=data/turso.env apply-retire-imported-prospects.mjs --apply
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 *
 * Promotion used to set `status = 'imported'` and leave the row in the list, so
 * every company anybody ever imported went on appearing in Prospecting — and
 * the question that book exists to answer, "who is left to qualify", got harder
 * to read with every success. lib/promotion.mjs now retires them on import.
 * This does the same for the ones already through.
 *
 * ── WHAT IT DOES AND DOES NOT DO ────────────────────────────────────────────
 *
 * Sets `deleted_at` on prospecting companies whose status is `imported`, and on
 * their prospecting contacts. That is a SOFT delete: the rows stay, so the
 * verdicts and evidence snapshots that reference them stay valid — that chain
 * is how a deal traces back to the verdict that sourced it — and an import can
 * still be undone.
 *
 * It touches nothing in the CRM. The Accounts and Contacts these became are not
 * read, let alone written.
 *
 * A prospect that is `imported` but has no `imported_account_id` is REFUSED
 * rather than retired: that is a row claiming to have become something it
 * cannot name, and hiding it would hide the inconsistency with it.
 */
import { migrate, all, get, run, tx, now, close } from './lib/db.mjs';

const APPLY = process.argv.includes('--apply');

migrate();

const orphans = all(
    `SELECT id, name FROM prospecting_companies
      WHERE status = 'imported' AND deleted_at IS NULL AND imported_account_id IS NULL`,
);

const ready = all(
    `SELECT p.id, p.name, p.workspace_id, p.imported_account_id, p.imported_at,
            (SELECT COUNT(*) FROM prospecting_contacts c
              WHERE c.prospect_id = p.id AND c.deleted_at IS NULL) AS contacts
       FROM prospecting_companies p
      WHERE p.status = 'imported' AND p.deleted_at IS NULL AND p.imported_account_id IS NOT NULL
      ORDER BY p.name`,
);

if (orphans.length) {
    console.log(`\nREFUSED — imported, but naming no account (${orphans.length}):\n`);
    for (const row of orphans.slice(0, 20)) console.log(`  ${row.name}  (${row.id})`);
    if (orphans.length > 20) console.log(`  … and ${orphans.length - 20} more`);
    console.log('\n  These claim to have been imported but do not say into what. Left alone —');
    console.log('  hiding them would hide the inconsistency too.');
}

if (!ready.length) {
    console.log('\nNothing to retire. Every imported prospect is already out of the list.');
    close();
    process.exit(orphans.length ? 1 : 0);
}

const contactTotal = ready.reduce((a, r) => a + r.contacts, 0);
console.log(`\n${ready.length} imported prospect(s) to retire, with ${contactTotal} prospecting contact(s):\n`);
for (const row of ready.slice(0, 25)) {
    console.log(`  ${row.name}${row.contacts ? `  (${row.contacts} contact${row.contacts === 1 ? '' : 's'})` : ''}`);
}
if (ready.length > 25) console.log(`  … and ${ready.length - 25} more`);

console.log('\nThey stay in the database and keep their verdicts and evidence.');
console.log('They stop appearing in Prospecting, which is where they no longer belong.');

if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write it.');
    close();
    process.exit(0);
}

let companies = 0;
let contacts = 0;
for (const row of ready) {
    tx(() => {
        // The date it was imported, where that is known — a row retired today
        // that was imported in March should not claim to have left in August.
        const stamp = row.imported_at || now();
        run('UPDATE prospecting_companies SET deleted_at = ?, updated_at = ? WHERE id = ?',
            [stamp, now(), row.id]);
        const result = run(
            `UPDATE prospecting_contacts SET deleted_at = ?, updated_at = ?
              WHERE prospect_id = ? AND workspace_id = ? AND deleted_at IS NULL`,
            [stamp, now(), row.id, row.workspace_id],
        );
        contacts += Number(result?.changes ?? 0);
        companies += 1;
    });
}

console.log(`\nRetired ${companies} prospect(s) and ${contacts} prospecting contact(s).`);
console.log('The prospecting lists now show only what is still to be worked.');

const left = get(
    "SELECT COUNT(*) AS n FROM prospecting_companies WHERE status = 'imported' AND deleted_at IS NULL",
).n;
console.log(`Imported prospects still in the list: ${left}`);

close();
process.exit(orphans.length ? 1 : 0);
