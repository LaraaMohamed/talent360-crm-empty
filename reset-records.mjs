/**
 * Empties the CRM of RECORDS while keeping its CONFIGURATION.
 *
 *   node reset-records.mjs --dry-run     say what would go, change nothing
 *   node reset-records.mjs --confirm     actually do it
 *
 * Kept:     workspace, users and their roles, pipelines and stages, activity
 *           types, service lines, loss reasons, qualification rules and their
 *           versions, saved views, dashboards, import mapping templates,
 *           document templates, email templates, settings.
 *
 * Removed:  EVERYTHING else — accounts, prospecting companies, contacts,
 *           prospecting contacts, deals and their line items/pricing/stage
 *           history, tasks, activities, notes, documents (uploaded and
 *           generated) and their generation/event history, proposals,
 *           agreements, commercial registrations, HCM service selections,
 *           evidence snapshots, verdicts (both planes), campaigns and their
 *           membership, calling-queue assignments, outreach/Smartlead
 *           events, Apollo phone reveals, email verification history, sent/
 *           queued email messages, import batches and their rows, list
 *           membership, custom field DEFINITIONS (not just their values),
 *           the search index and the audit trail.
 *
 * This is a HARD delete, not the soft delete the app does — the point is to
 * hand back a CRM that looks like day one, and a soft delete would leave
 * everything restorable and still counted. It cannot be undone from inside
 * the app — that is what the automatic backup below is for.
 *
 * `snapshots.json` is not touched. Re-importing is one command:
 *
 *   node import-snapshots.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { migrate, all, get, run, tx, close, DB_FILE, STORAGE } from './lib/db.mjs';

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const KEEP_FILES = args.includes('--keep-files');

migrate();

/**
 * Ordered so children go before the rows they reference. `defer_foreign_keys`
 * (below) means this order is a courtesy, not a requirement — SQLite only
 * checks FK integrity at COMMIT, once every DELETE in the transaction has
 * run — but a courtesy that makes the list readable as "leaves toward root"
 * is worth keeping.
 */
const TABLES = [
    'list_members',
    'phone_reveals',
    'outreach_events',
    'email_verifications',
    'campaign_members',
    'document_events',
    'document_generations',
    'hcm_service_selections',
    'commercial_registrations',
    'agreement_proposals',
    'deal_line_items',
    'deal_price_periods',
    'deal_stage_history',
    'deal_contacts',
    'proposal_versions',
    'agreements',
    'proposals',
    'documents',
    'document_blobs',
    'notes',
    'activities',
    'tasks',
    'verdicts',
    'evidence_snapshots',
    'prospecting_verdicts',
    'prospecting_evidence_snapshots',
    'deals',
    'contacts',
    'prospecting_contacts',
    'accounts',
    'prospecting_companies',
    'campaigns',
    'import_rows',
    'import_batches',
    'email_messages',
    'calling_assignments',
    'audit_events',
    'notifications',
    'search_index',
    // Definitions, not values — a custom field nobody has any data in any
    // more is not a fresh-start CRM's problem to remember.
    'field_defs',
];

const counts = {};
for (const table of TABLES) {
    counts[table] = get(`SELECT COUNT(*) AS n FROM ${table}`).n;
}
const total = Object.values(counts).reduce((a, n) => a + n, 0);

console.log(`\n  Database   ${DB_FILE}\n`);
for (const [table, n] of Object.entries(counts)) {
    if (n) console.log(`    ${table.padEnd(22)}${String(n).padStart(6)}`);
}
console.log(`\n  ${total} row(s) would be removed.\n`);

console.log('  Kept:');
for (const [table, label] of [
    ['workspaces', 'workspace'], ['users', 'users'], ['memberships', 'memberships'],
    ['pipelines', 'pipelines'], ['stages', 'stages'], ['activity_types', 'activity types'],
    ['service_lines', 'service lines'], ['loss_reasons', 'loss reasons'],
    ['qualification_rules', 'rule versions'], ['views', 'saved views'],
    ['lists', 'lists (emptied, not deleted)'], ['dashboards', 'dashboards'],
    ['email_templates', 'email templates'], ['document_templates', 'document templates'],
    ['import_templates', 'import mapping templates'], ['settings', 'settings'],
]) {
    console.log(`    ${label.padEnd(30)}${String(get(`SELECT COUNT(*) AS n FROM ${table}`).n).padStart(4)}`);
}

if (!CONFIRM) {
    console.log('\n  Nothing was changed. Re-run with --confirm to do it.\n');
    close();
    process.exit(0);
}

/**
 * A copy of the database file before touching it. Cheap insurance against a
 * mistyped command, and the only way back once the rows are gone.
 */
const backup = `${DB_FILE}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.copyFileSync(DB_FILE, backup);

tx(() => {
    run('PRAGMA defer_foreign_keys = ON');
    for (const table of TABLES) run(`DELETE FROM ${table}`);
});

// Uploaded files are on disk, so clearing the rows alone would orphan them.
let filesRemoved = 0;
if (!KEEP_FILES && fs.existsSync(STORAGE)) {
    for (const entry of fs.readdirSync(STORAGE, { withFileTypes: true })) {
        const target = path.join(STORAGE, entry.name);
        const before = entry.isDirectory() ? fs.readdirSync(target).length : 1;
        fs.rmSync(target, { recursive: true, force: true });
        filesRemoved += before;
    }
}

console.log(`\n  Removed ${total} row(s)${filesRemoved ? ` and ${filesRemoved} stored file(s)` : ''}.`);
console.log(`  Backup   ${backup}`);
console.log('\n  The CRM is empty and ready to use. To bring the collected companies back:');
console.log('    node import-snapshots.mjs\n');

close();
