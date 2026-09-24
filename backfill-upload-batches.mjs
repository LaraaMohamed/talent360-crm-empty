/**
 * Gives the pre-Upload-History companies an upload to belong to.
 *
 *   node backfill-upload-batches.mjs              dry run
 *   node backfill-upload-batches.mjs --confirm    apply
 *
 * ── WHY, AND WHAT IS AND IS NOT INVENTED ────────────────────────────────────
 *
 * Upload History reads `prospecting_companies.import_batch_id`. Companies that
 * arrived before that column existed have none, so they would show up nowhere
 * in the history and "Delete Upload" could never find them — 594 companies with
 * no traceable origin, which is precisely what the Prospecting module exists to
 * prevent.
 *
 * These companies did not come from a file upload. They came from the
 * collector, via `import-snapshots.mjs`. Inventing a filename for them would be
 * fabricating history, so the batch is labelled for what it actually was:
 * source `collector`, named after the snapshot file.
 *
 * One batch PER COLLECTION DAY, taken from the evidence's own `collected_at`.
 * That date is a recorded fact, not a guess — it is when Chrome actually
 * visited those LinkedIn pages. It also happens to be the most useful grouping:
 * each collection run is what a person would call "an upload".
 *
 * Companies with no evidence at all fall into a single "unknown origin" batch
 * rather than being silently skipped, because a company that cannot explain
 * where it came from is exactly the thing worth surfacing.
 *
 * Idempotent: rows that already have a batch are left alone.
 */
import path from 'node:path';
import { migrate, all, get, run, tx, id, now, close } from './lib/db.mjs';
import { SNAPSHOTS_FILE } from './lib/qualification.mjs';

const CONFIRM = process.argv.includes('--confirm');

migrate();

const workspace = get('SELECT * FROM workspaces LIMIT 1');
if (!workspace) {
    console.error('  No workspace yet. Run:  node setup.mjs');
    process.exit(1);
}
const admin = get(
    `SELECT u.* FROM users u JOIN memberships m ON m.user_id = u.id
      WHERE m.workspace_id = ? ORDER BY m.created_at LIMIT 1`,
    [workspace.id],
);

/**
 * Each company's collection day, from its EARLIEST evidence — the day it first
 * entered the system, not the last time it was re-observed.
 */
const groups = all(
    `SELECT substr(MIN(e.collected_at), 1, 10) AS day, COUNT(*) AS n
       FROM prospecting_companies c
       LEFT JOIN prospecting_evidence_snapshots e ON e.prospect_id = c.id
      WHERE c.workspace_id = ? AND c.import_batch_id IS NULL AND c.deleted_at IS NULL
      GROUP BY c.id
      HAVING 1`,
    [workspace.id],
);

const byDay = new Map();
for (const row of groups) {
    const key = row.day ?? 'unknown';
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
}

if (!byDay.size) {
    console.log('\n  Every company already belongs to an upload. Nothing to do.\n');
    close();
    process.exit(0);
}

const snapshotName = path.basename(SNAPSHOTS_FILE);

console.log('');
console.log(`  ${groups.length} companies have no upload recorded, across ${byDay.size} collection day(s):`);
for (const [day, n] of [...byDay].sort()) {
    console.log(`    ${String(n).padStart(5)}  ${day === 'unknown' ? 'no evidence on file' : day}`);
}
console.log('');
if (!CONFIRM) {
    console.log('  DRY RUN — nothing written. Re-run with --confirm to apply.\n');
    close();
    process.exit(0);
}

let created = 0;
let linked = 0;

for (const [day, expected] of [...byDay].sort()) {
    tx(() => {
        const batchId = id('imb');
        const label = day === 'unknown'
            ? `${snapshotName} — origin not recorded`
            : `${snapshotName} — collected ${day}`;
        // created_at is the COLLECTION day, not today: the history is meant to
        // say when these companies arrived, and stamping them all with the
        // migration date would erase the only true thing we know about them.
        const createdAt = day === 'unknown' ? now() : `${day}T00:00:00.000Z`;

        run(
            `INSERT INTO import_batches
               (id, workspace_id, object_key, filename, source, status, mapping, options,
                total_rows, created_count, started_at, finished_at, created_by, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
                batchId, workspace.id, 'prospecting_company', label, 'collector', 'completed',
                '{}', JSON.stringify({ backfilled: true, reason: 'predates upload history' }),
                expected, expected, createdAt, createdAt, admin.id, createdAt,
            ],
        );
        created += 1;

        const changes = day === 'unknown'
            ? run(
                `UPDATE prospecting_companies SET import_batch_id = ?
                  WHERE workspace_id = ? AND import_batch_id IS NULL AND deleted_at IS NULL
                    AND id NOT IN (SELECT DISTINCT prospect_id FROM prospecting_evidence_snapshots WHERE prospect_id IS NOT NULL)`,
                [batchId, workspace.id],
            ).changes
            : run(
                `UPDATE prospecting_companies SET import_batch_id = ?
                  WHERE workspace_id = ? AND import_batch_id IS NULL AND deleted_at IS NULL
                    AND id IN (
                        SELECT c.id FROM prospecting_companies c
                          JOIN prospecting_evidence_snapshots e ON e.prospect_id = c.id
                         WHERE c.workspace_id = ?
                         GROUP BY c.id
                        HAVING substr(MIN(e.collected_at), 1, 10) = ?
                    )`,
                [batchId, workspace.id, workspace.id, day],
            ).changes;
        linked += changes;

        // Contacts follow their company, so an upload deleted later takes its
        // people with it rather than orphaning them.
        run(
            `UPDATE prospecting_contacts SET import_batch_id = ?
              WHERE workspace_id = ? AND import_batch_id IS NULL
                AND prospect_id IN (SELECT id FROM prospecting_companies WHERE import_batch_id = ?)`,
            [batchId, workspace.id, batchId],
        );

        console.log(`  ${String(changes).padStart(5)}  ->  ${label}`);
    });
}

const orphans = get(
    'SELECT COUNT(*) AS n FROM prospecting_companies WHERE workspace_id = ? AND import_batch_id IS NULL AND deleted_at IS NULL',
    [workspace.id],
).n;

console.log('');
console.log(`  uploads created   ${created}`);
console.log(`  companies linked  ${linked}`);
console.log(`  still unlinked    ${orphans}`);
console.log('');

close();
