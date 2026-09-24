/**
 * Contacts move from a single `service_line_key` to a multi-value `services`
 * field — the same shape accounts.services already has, and for the same
 * reason: a contact can be the buyer for more than one service line, and a
 * single column forced a false either/or choice the account's own field
 * never had. See lib/objects.mjs's contact field for the field definition.
 *
 * This does two things:
 *
 *   1. Backfills `services` from the existing `service_line_key` for every
 *      contact that has one and no `services` yet. It does not touch
 *      `service_line_key` itself — that column stays on disk, unread by the
 *      field registry from here on, in case anything still needs the old
 *      value.
 *   2. Renames `service_line_key` to `services` inside any saved contact
 *      VIEW's `columns` array or `group_by`, so a view built before this
 *      migration does not quietly lose its Service column — an unrecognised
 *      column key is dropped silently by the table renderer rather than
 *      erroring, which reads as "the column vanished" with no explanation.
 *
 *   node apply-contact-services-migration.mjs            # what would change
 *   node apply-contact-services-migration.mjs --apply    # write it
 */
import { migrate, all, get, run, tx, now, close } from './lib/db.mjs';

const APPLY = process.argv.includes('--apply');

migrate();

const rows = all(
    `SELECT id, service_line_key FROM contacts
      WHERE service_line_key IS NOT NULL AND TRIM(service_line_key) != ''
        AND (services IS NULL OR services = '' OR services = '[]')`,
);

const views = all(`SELECT id, name, columns, group_by FROM views WHERE object_key = 'contact'`)
    .filter((v) => (v.columns ?? '').includes('service_line_key') || v.group_by === 'service_line_key');

if (!rows.length && !views.length) {
    console.log('Nothing to do — no contact needs backfilling and no view still names service_line_key.');
    close();
    process.exit(0);
}

if (rows.length) {
    console.log(`Would backfill services for ${rows.length} contact(s):`);
    for (const r of rows.slice(0, 20)) console.log(`  ${r.id} -> ["${r.service_line_key}"]`);
    if (rows.length > 20) console.log(`  …and ${rows.length - 20} more.`);
}
if (views.length) {
    console.log(`Would rename service_line_key -> services in ${views.length} view(s):`);
    for (const v of views) console.log(`  ${v.name} (${v.id})`);
}

if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write it, after `npm run backup`.');
    close();
    process.exit(0);
}

tx(() => {
    for (const r of rows) {
        run('UPDATE contacts SET services = ? WHERE id = ?', [JSON.stringify([r.service_line_key]), r.id]);
    }
    for (const v of views) {
        const columns = JSON.parse(v.columns ?? '[]').map((c) => (c === 'service_line_key' ? 'services' : c));
        const groupBy = v.group_by === 'service_line_key' ? 'services' : v.group_by;
        run('UPDATE views SET columns = ?, group_by = ? WHERE id = ?', [JSON.stringify(columns), groupBy, v.id]);
    }
});

const leftoverContacts = all(
    `SELECT COUNT(*) AS n FROM contacts
      WHERE service_line_key IS NOT NULL AND TRIM(service_line_key) != ''
        AND (services IS NULL OR services = '' OR services = '[]')`,
)[0]?.n ?? 0;
const leftoverViews = get(
    `SELECT COUNT(*) AS n FROM views WHERE object_key = 'contact' AND (columns LIKE '%service_line_key%' OR group_by = 'service_line_key')`,
)?.n ?? 0;

if (leftoverContacts || leftoverViews) {
    console.error(`\n⚠ ${leftoverContacts} contact(s) and ${leftoverViews} view(s) still reference the old field. Investigate before trusting it.`);
    close();
    process.exit(1);
}

console.log(`\nBackfilled ${rows.length} contact(s) and fixed ${views.length} view(s) at ${now()}.`);
close();
