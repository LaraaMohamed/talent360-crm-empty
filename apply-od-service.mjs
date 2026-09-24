/**
 * Renames the "Strategy & Performance" service line to OD.
 *
 *   node apply-od-service.mjs            # show what would change
 *   node apply-od-service.mjs --apply    # write it
 *
 * ── WHY A WRITTEN MIGRATION AND NOT AN UPDATE ───────────────────────────────
 *
 * A service line's KEY is not a foreign key. It is copied as data into six
 * places — two of them JSON arrays — and nothing in the database would complain
 * if one were missed. An account whose `services` still said `strategy` after
 * the rename would simply stop being offered its own documents, and stop
 * appearing under its own service on the dashboard, with no error anywhere.
 *
 * So every reference is found and rewritten together, and the dry run names
 * each row it would touch before anything is written.
 *
 * ── WHAT IS NOT DONE ────────────────────────────────────────────────────────
 *
 * Nothing is deleted and no record loses its service. This is a rename: the row
 * keeps its id, its pricing model, its position and its rule, and every record
 * pointing at it points at it afterwards. `lib/document-types.mjs` references
 * only `hcm` and `offshoring`, so document generation is untouched.
 */
import { migrate, all, get, run, tx, now, json, close } from './lib/db.mjs';

const APPLY = process.argv.includes('--apply');
const FROM = 'strategy';
const TO = 'od';
const LABEL = 'OD';

migrate();

/** Tables holding a single service key in a column. */
const SCALAR = [
    ['deals', 'service_line_key'],
    ['contacts', 'service_line_key'],
    ['campaigns', 'service_line_key'],
    ['prospecting_contacts', 'service_line_key'],
];

/** Tables holding a JSON array of service keys. */
const ARRAYS = [
    ['accounts', 'services'],
    ['prospecting_companies', 'services'],
];

const plan = [];
const line = all('SELECT id, workspace_id, key, label FROM service_lines WHERE key = ?', [FROM]);
const already = all('SELECT id, key, label FROM service_lines WHERE key = ?', [TO]);

if (already.length && !line.length) {
    console.log(`Already renamed: the service line is "${TO}". Nothing to do.`);
    close();
    process.exit(0);
}
if (already.length && line.length) {
    console.error(
        `Both "${FROM}" and "${TO}" exist as service lines. This script renames one into the other `
        + 'and will not merge two live services — decide which records belong where first.',
    );
    close();
    process.exit(1);
}
if (!line.length) {
    console.log(`No service line keyed "${FROM}" exists here. Nothing to do.`);
    close();
    process.exit(0);
}

plan.push(`service_lines: "${FROM}" → "${TO}" (label "${line[0].label}" → "${LABEL}")`);

for (const [table, column] of SCALAR) {
    const rows = all(`SELECT id FROM ${table} WHERE ${column} = ?`, [FROM]);
    if (rows.length) plan.push(`  ${table}.${column}: ${rows.length} row(s)`);
}

const arrayRows = new Map();
for (const [table, column] of ARRAYS) {
    const rows = all(`SELECT id, ${column} AS value FROM ${table} WHERE ${column} LIKE ?`, [`%"${FROM}"%`])
        .filter((r) => json(r.value, []).includes(FROM));
    if (rows.length) {
        arrayRows.set(`${table}.${column}`, rows);
        plan.push(`  ${table}.${column}: ${rows.length} record(s)`);
    }
}

// Saved views can carry the key inside a filter tree, and a view that filters
// on a key nothing has any more silently returns an empty list.
const views = all('SELECT id, name, filter FROM views WHERE filter LIKE ?', [`%"${FROM}"%`]);
for (const v of views) plan.push(`  views: "${v.name}" filters on it`);

console.log(plan.join('\n'));

if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write it, after `npm run backup`.');
    close();
    process.exit(0);
}

tx(() => {
    run('UPDATE service_lines SET key = ?, label = ? WHERE key = ?', [TO, LABEL, FROM]);

    for (const [table, column] of SCALAR) {
        run(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`, [TO, FROM]);
    }

    // Rewritten element by element rather than by string replacement, so a
    // service whose name merely CONTAINS the old key is untouched.
    for (const [key, rows] of arrayRows) {
        const [table, column] = key.split('.');
        for (const row of rows) {
            const next = json(row.value, []).map((s) => (s === FROM ? TO : s));
            run(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [JSON.stringify(next), row.id]);
        }
    }

    for (const v of views) {
        // A filter is a JSON tree; only exact matches of the key are replaced.
        const rewrite = (node) => {
            if (Array.isArray(node)) return node.map(rewrite);
            if (node && typeof node === 'object') {
                return Object.fromEntries(Object.entries(node).map(([k, val]) => [k, rewrite(val)]));
            }
            return node === FROM ? TO : node;
        };
        run('UPDATE views SET filter = ? WHERE id = ?', [JSON.stringify(rewrite(json(v.filter, null))), v.id]);
    }

    run('UPDATE service_targets SET service_line_key = ? WHERE service_line_key = ?', [TO, FROM]);
});

const leftover = SCALAR.reduce((n, [table, column]) => n + get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, [FROM]).n, 0)
    + ARRAYS.reduce((n, [table, column]) => n + get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} LIKE ?`, [`%"${FROM}"%`]).n, 0)
    + get('SELECT COUNT(*) AS n FROM service_lines WHERE key = ?', [FROM]).n;

if (leftover) {
    console.error(`\n⚠ ${leftover} reference(s) to "${FROM}" survived. Investigate before trusting the dashboard.`);
    close();
    process.exit(1);
}

console.log(`\nApplied at ${now()}. Nothing still refers to "${FROM}".`);
close();
