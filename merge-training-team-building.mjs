/**
 * Merges the "Training" and "Team Building" service lines into one:
 * "Training & Team Building" — the business quotes and delivers them
 * together, not as two line items a client chooses between.
 *
 *   node merge-training-team-building.mjs            # what would change
 *   node merge-training-team-building.mjs --apply    # write it
 *
 * ── WHY A WRITTEN MIGRATION AND NOT AN UPDATE ───────────────────────────────
 *
 * Same reasoning as apply-od-service.mjs, which this mirrors: a service
 * line's KEY is copied as data into several places, two of them JSON
 * arrays, and nothing in the database enforces that they agree. Every
 * reference is found and rewritten together, and the dry run names each row
 * it would touch before anything is written.
 *
 * ── WHAT "MERGE" MEANS HERE, SPECIFICALLY ──────────────────────────────────
 *
 * Both source keys already carry `pricing_model: 'fixed_fee'` — quoted
 * once, not per month — so the merged service keeps that with no change in
 * meaning, only in how many rows say it.
 *
 * An account whose `services` array names BOTH old keys ends up with the
 * merged key ONCE, not twice — de-duplicated, not concatenated.
 *
 * `service_targets` is keyed one row per (account type, service): where
 * both old keys have a target for the same account type, the merged row's
 * target is their SUM (the business's total ask for this now-combined
 * line), not one or the other silently discarded.
 */
import { migrate, all, get, run, tx, now, json, close } from './lib/db.mjs';

const APPLY = process.argv.includes('--apply');
const FROM_A = 'training';
const FROM_B = 'team_building';
const TO = 'training_team_building';
const LABEL = 'Training & Team Building';

migrate();

const already = all('SELECT id, key, label FROM service_lines WHERE key = ?', [TO]);
const lineA = all('SELECT id, workspace_id, key, label FROM service_lines WHERE key = ?', [FROM_A]);
const lineB = all('SELECT id, workspace_id, key, label FROM service_lines WHERE key = ?', [FROM_B]);

if (already.length && !lineA.length && !lineB.length) {
    console.log(`Already merged: the service line is "${TO}". Nothing to do.`);
    close();
    process.exit(0);
}
if (!lineA.length && !lineB.length) {
    console.log(`Neither "${FROM_A}" nor "${FROM_B}" exists as a service line here. Nothing to do.`);
    close();
    process.exit(0);
}

const plan = [];
plan.push(`service_lines: "${FROM_A}"${lineB.length ? ` + "${FROM_B}"` : ''} → "${TO}" (label "${LABEL}")`);
if (!lineA.length) plan.push(`  note: "${FROM_A}" does not exist here — merging "${FROM_B}" alone into a new "${TO}" row`);
if (!lineB.length) plan.push(`  note: "${FROM_B}" does not exist here — renaming "${FROM_A}" alone to "${TO}"`);

/** Tables holding a single service key in a column. */
const SCALAR = [
    ['deals', 'service_line_key'],
    ['contacts', 'service_line_key'],
    ['campaigns', 'service_line_key'],
    ['prospecting_contacts', 'service_line_key'],
    ['agreements', 'service_line_key'],
];

/** Tables holding a JSON array of service keys. */
const ARRAYS = [
    ['accounts', 'services'],
    ['prospecting_companies', 'services'],
];

for (const [table, column] of SCALAR) {
    const rows = all(`SELECT id FROM ${table} WHERE ${column} IN (?, ?)`, [FROM_A, FROM_B]);
    if (rows.length) plan.push(`  ${table}.${column}: ${rows.length} row(s)`);
}

const arrayRows = new Map();
for (const [table, column] of ARRAYS) {
    const rows = all(`SELECT id, ${column} AS value FROM ${table} WHERE ${column} LIKE ? OR ${column} LIKE ?`, [`%"${FROM_A}"%`, `%"${FROM_B}"%`])
        .filter((r) => { const arr = json(r.value, []); return arr.includes(FROM_A) || arr.includes(FROM_B); });
    if (rows.length) {
        arrayRows.set(`${table}.${column}`, rows);
        plan.push(`  ${table}.${column}: ${rows.length} record(s)`);
    }
}

const views = all('SELECT id, name, filter FROM views WHERE filter LIKE ? OR filter LIKE ?', [`%"${FROM_A}"%`, `%"${FROM_B}"%`]);
for (const v of views) plan.push(`  views: "${v.name}" filters on it`);

const targets = all('SELECT * FROM service_targets WHERE service_line_key IN (?, ?)', [FROM_A, FROM_B]);
if (targets.length) plan.push(`  service_targets: ${targets.length} row(s)`);

console.log(plan.join('\n'));

if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write it, after `npm run backup`.');
    close();
    process.exit(0);
}

tx(() => {
    if (lineA.length) {
        run('UPDATE service_lines SET key = ?, label = ? WHERE key = ?', [TO, LABEL, FROM_A]);
        if (lineB.length) run('DELETE FROM service_lines WHERE key = ?', [FROM_B]);
    } else if (lineB.length) {
        run('UPDATE service_lines SET key = ?, label = ? WHERE key = ?', [TO, LABEL, FROM_B]);
    }

    for (const [table, column] of SCALAR) {
        run(`UPDATE ${table} SET ${column} = ? WHERE ${column} IN (?, ?)`, [TO, FROM_A, FROM_B]);
    }

    // Rewritten element by element and de-duplicated, so a record naming
    // BOTH old keys ends up with the merged one once, not twice.
    for (const [key, rows] of arrayRows) {
        const [table, column] = key.split('.');
        for (const row of rows) {
            const merged = json(row.value, []).map((s) => ((s === FROM_A || s === FROM_B) ? TO : s));
            const deduped = [...new Set(merged)];
            run(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [JSON.stringify(deduped), row.id]);
        }
    }

    for (const v of views) {
        const rewrite = (node) => {
            if (Array.isArray(node)) return node.map(rewrite);
            if (node && typeof node === 'object') {
                return Object.fromEntries(Object.entries(node).map(([k, val]) => [k, rewrite(val)]));
            }
            return (node === FROM_A || node === FROM_B) ? TO : node;
        };
        run('UPDATE views SET filter = ? WHERE id = ?', [JSON.stringify(rewrite(json(v.filter, null))), v.id]);
    }

    // Summed per (workspace, account type) — the business's total ask for
    // this now-combined line, not one figure silently winning over the
    // other.
    const byGroup = new Map();
    for (const t of targets) {
        const groupKey = `${t.workspace_id}::${t.account_type}`;
        byGroup.set(groupKey, (byGroup.get(groupKey) ?? 0) + Number(t.target_amount || 0));
    }
    run('DELETE FROM service_targets WHERE service_line_key IN (?, ?)', [FROM_A, FROM_B]);
    for (const [groupKey, amount] of byGroup) {
        const [workspaceId, accountType] = groupKey.split('::');
        const existing = get(
            'SELECT target_amount FROM service_targets WHERE workspace_id = ? AND account_type = ? AND service_line_key = ?',
            [workspaceId, accountType, TO],
        );
        const total = amount + Number(existing?.target_amount || 0);
        run(
            `INSERT INTO service_targets (workspace_id, account_type, service_line_key, target_amount, updated_at)
             VALUES (?,?,?,?,?)
             ON CONFLICT(workspace_id, account_type, service_line_key) DO UPDATE SET target_amount = excluded.target_amount, updated_at = excluded.updated_at`,
            [workspaceId, accountType, TO, total, now()],
        );
    }
});

const leftover = SCALAR.reduce((n, [table, column]) => n + get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IN (?, ?)`, [FROM_A, FROM_B]).n, 0)
    + ARRAYS.reduce((n, [table, column]) => n + get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} LIKE ? OR ${column} LIKE ?`, [`%"${FROM_A}"%`, `%"${FROM_B}"%`]).n, 0)
    + get('SELECT COUNT(*) AS n FROM service_lines WHERE key IN (?, ?)', [FROM_A, FROM_B]).n
    + get('SELECT COUNT(*) AS n FROM service_targets WHERE service_line_key IN (?, ?)', [FROM_A, FROM_B]).n;

if (leftover) {
    console.error(`\n⚠ ${leftover} reference(s) to "${FROM_A}"/"${FROM_B}" survived. Investigate before trusting the dashboard.`);
    close();
    process.exit(1);
}

console.log(`\nApplied at ${now()}. Nothing still refers to "${FROM_A}" or "${FROM_B}".`);
close();
