/**
 * Adds the uniqueness checks contacts.email and accounts.cr_number never had.
 *
 *   node apply-contact-account-uniqueness.mjs            report duplicates only
 *   node apply-contact-account-uniqueness.mjs --apply    add the indexes, if clean
 *
 * Neither column has ever stopped a duplicate: `idx_contacts_email` is a plain
 * (non-unique) index, and `accounts.cr_number` — "the strongest natural key
 * here", per its own comment in schema.sql — has no index at all. This is why
 * this is not simply added to schema.sql: an ordinary CREATE UNIQUE INDEX
 * would throw the moment schema.sql runs on a database that already has a
 * duplicate, which is exactly the database this is meant to fix and exactly
 * the moment (server boot) nobody wants that to happen.
 *
 * So this checks first, in both directions:
 *   - dry run (default): always safe, reports what it finds, changes nothing.
 *   - --apply: creates the two indexes ONLY if no duplicates exist. If any do,
 *     it refuses and lists them — merge or clear the duplicates (the CRM
 *     already has merge/unmerge for accounts and contacts), then run again.
 *
 * Email is compared case-insensitively (lower(email)), since "John@Acme.com"
 * and "john@acme.com" are the same duplicate a rep would recognise on sight.
 * Blank/empty email and cr_number are not compared — plenty of real contacts
 * have no email on file, and that is not a collision.
 */
import { all, run, migrate, close, describe } from './lib/db.mjs';

const APPLY = process.argv.includes('--apply');

migrate();

console.log('');
console.log(`  Database  ${describe()}`);
console.log(`  Mode      ${APPLY ? 'APPLY — will add the indexes if clean' : 'dry run — pass --apply to add the indexes'}`);
console.log('');

const emailDupes = all(`
    SELECT workspace_id, lower(email) AS email_lc, COUNT(*) AS n, GROUP_CONCAT(id) AS ids
      FROM contacts
     WHERE deleted_at IS NULL AND email IS NOT NULL AND TRIM(email) != ''
  GROUP BY workspace_id, lower(email)
    HAVING COUNT(*) > 1
  ORDER BY n DESC
`);

const crDupes = all(`
    SELECT workspace_id, cr_number, COUNT(*) AS n, GROUP_CONCAT(id) AS ids
      FROM accounts
     WHERE deleted_at IS NULL AND cr_number IS NOT NULL AND TRIM(cr_number) != ''
  GROUP BY workspace_id, cr_number
    HAVING COUNT(*) > 1
  ORDER BY n DESC
`);

report('contacts sharing the same email', emailDupes, (row) => `${row.email_lc}  (${row.n} contacts: ${row.ids})`);
report('accounts sharing the same CR number', crDupes, (row) => `${row.cr_number}  (${row.n} accounts: ${row.ids})`);

function report(label, rows, describeRow) {
    console.log(`  ${label}: ${rows.length ? rows.length : 'none'}`);
    for (const row of rows.slice(0, 20)) console.log(`    ${describeRow(row)}`);
    if (rows.length > 20) console.log(`    … and ${rows.length - 20} more`);
    console.log('');
}

if (!APPLY) {
    console.log('  Nothing was changed. Pass --apply once the lists above are empty.');
    console.log('');
    close();
    process.exit(0);
}

if (emailDupes.length || crDupes.length) {
    console.log('  Refusing to add the indexes — duplicates still exist (see above).');
    console.log('  Merge or clear them first (the CRM has merge/unmerge for both accounts');
    console.log('  and contacts), then run this again.');
    console.log('');
    close();
    process.exit(1);
}

run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_email_unique
       ON contacts(workspace_id, lower(email))
      WHERE deleted_at IS NULL AND email IS NOT NULL AND TRIM(email) != ''`);
run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_cr_number_unique
       ON accounts(workspace_id, cr_number)
      WHERE deleted_at IS NULL AND cr_number IS NOT NULL AND TRIM(cr_number) != ''`);

console.log('  Added idx_contacts_email_unique and idx_accounts_cr_number_unique.');
console.log('  A future INSERT/UPDATE that would create a duplicate now fails at the');
console.log('  database, not just at whichever application code remembered to check.');
console.log('');

close();
