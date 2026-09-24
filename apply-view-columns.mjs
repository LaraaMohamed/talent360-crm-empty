/**
 * Brings the SYSTEM views on an existing workspace up to their current
 * definitions in lib/seed-views.mjs.
 *
 *   node apply-view-columns.mjs            what would change
 *   node apply-view-columns.mjs --write    do it
 *
 * ── WHY THIS SCRIPT HAS TO EXIST ────────────────────────────────────────────
 *
 * `seedViews()` inserts a view only when no view of that name exists, which is
 * what makes it safe to re-run. The cost of that safety is that changing a
 * seeded definition reaches new workspaces only — every database already in use
 * keeps the columns it was created with. So a change to what the Accounts list
 * shows by default was, until this ran, invisible to everybody who already had
 * an Accounts list.
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
 *
 * It touches only `columns` and only on views marked `is_system = 1`. Filters,
 * sorts, names and grouping are left exactly as they are, and any view somebody
 * made themselves is not looked at. A view is configuration, and this is the
 * narrowest possible reach into somebody's configuration that still fixes the
 * problem.
 *
 * It cannot tell a system view you have customised from one you have not — the
 * schema records no such flag. So it prints every change first and writes
 * nothing without --write. Read the list before running it.
 */
import { all, get, run, migrate, close, describe, now } from './lib/db.mjs';
import { systemViews } from './lib/seed-views.mjs';

const WRITE = process.argv.includes('--write');

migrate();

console.log('');
console.log(`  Database  ${describe()}`);
console.log(`  Mode      ${WRITE ? 'WRITE' : 'dry run — pass --write to apply'}`);
console.log('');

const workspaces = all('SELECT id, name FROM workspaces');
let changed = 0;
let identical = 0;
let missing = 0;

for (const workspace of workspaces) {
    if (workspaces.length > 1) console.log(`  ${workspace.name}`);

    for (const wanted of systemViews(workspace.id)) {
        const existing = get(
            'SELECT id, name, object_key, columns, is_system FROM views WHERE workspace_id = ? AND object_key = ? AND name = ?',
            [workspace.id, wanted.object_key, wanted.name],
        );

        // Absent entirely: that is `seedViews`' job, not this one.
        if (!existing) { missing += 1; continue; }

        // Somebody's own view that happens to share a name is not ours to edit.
        if (!existing.is_system) continue;

        const before = existing.columns ?? '[]';
        const after = wanted.columns;
        if (before === after) { identical += 1; continue; }

        changed += 1;
        const list = (json) => { try { return JSON.parse(json).join(', '); } catch { return json; } };
        console.log(`    ${existing.object_key} / ${existing.name}`);
        console.log(`      was  ${list(before)}`);
        console.log(`      now  ${list(after)}`);

        if (WRITE) {
            run('UPDATE views SET columns = ?, updated_at = ? WHERE id = ?', [after, now(), existing.id]);
        }
    }
}

console.log('');
console.log(`  Views already current   ${identical}`);
console.log(`  Views ${WRITE ? 'updated' : 'that would change'}  ${changed}`);
if (missing) console.log(`  Views not present yet   ${missing}  (run node setup.mjs to seed them)`);
console.log('');

if (!WRITE && changed > 0) {
    console.log('  Nothing was written. Run again with --write to apply.');
    console.log('');
}

close();
