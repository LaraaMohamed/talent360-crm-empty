/**
 * Take a backup of the hosted database, as an ordinary SQLite file.
 *
 *   TURSO_URL=libsql://…  TURSO_TOKEN=…  node pull-from-turso.mjs
 *
 * This is the other half of push-to-turso.mjs and it exists because a hosted
 * database you cannot get a copy of is not backed up — it is somebody else's
 * problem that has not happened yet. What lands here is a `.db` file you can
 * open with any SQLite tool, restore by copying, or push straight back with
 * `node push-to-turso.mjs --source <file>`.
 *
 * Document bytes come back as real files under `data/storage/`, which is where
 * a local install expects them.
 *
 *   --out PATH      write somewhere specific
 *   --no-documents  database only, skip the files
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const WITH_DOCUMENTS = !flag('no-documents');
const PAGE = 2000;

const db = await import('./lib/db.mjs');
if (!db.REMOTE) {
    console.error('\n  TURSO_URL is not set, so there is nothing to pull from.\n');
    process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
const OUT = path.resolve(option('out', path.join(db.ROOT, 'data', 'backups', `crm-${stamp}.db`)));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.rmSync(OUT, { force: true });

console.log('');
console.log(`  from  ${db.describe()}`);
console.log(`  to    ${OUT}`);
console.log('');

const local = new DatabaseSync(OUT);
local.exec('PRAGMA journal_mode = WAL');
local.exec(fs.readFileSync(path.join(db.ROOT, 'schema.sql'), 'utf8'));

// Foreign keys off for the load: the rows arrive table by table and a child
// copied before its parent is an artefact of the copying, not a broken record.
// The whole file is checked with `foreign_key_check` at the end, which is the
// stronger statement anyway.
//
// After schema.sql, not before — it sets `foreign_keys = ON` itself.
local.exec('PRAGMA foreign_keys = OFF');

const tables = db.all(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
).map((r) => r.name).filter((n) => !n.startsWith('search_index_'));

/**
 * schema.sql is the starting shape; the live database has whatever columns have
 * been added to it since. Take those from the source rather than repeating the
 * migration list here, so a backup keeps working the next time a column is
 * added and nobody remembers this file exists.
 */
for (const table of tables) {
    const here = new Set(local.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((c) => c.name));
    if (!here.size) continue;
    for (const column of db.all('SELECT * FROM pragma_table_info(?)', [table])) {
        if (here.has(column.name)) continue;
        const notNull = column.notnull && column.dflt_value !== null
            ? ` NOT NULL DEFAULT ${column.dflt_value}`
            : '';
        local.exec(`ALTER TABLE "${table}" ADD COLUMN "${column.name}" ${column.type || 'TEXT'}${notNull}`);
    }
}

let copied = 0;
for (const table of tables) {
    const total = db.get(`SELECT COUNT(*) AS n FROM "${table}"`)?.n ?? 0;
    process.stdout.write(`  ${table.padEnd(32)} ${String(total).padStart(7)} rows  `);
    if (!total) { console.log('·'); continue; }

    const columns = db.all('SELECT * FROM pragma_table_info(?)', [table]).map((c) => c.name);
    // An FTS5 table is an index, not a table: it takes a plain INSERT and has
    // no row to replace.
    const verb = table === 'search_index' ? 'INSERT INTO' : 'INSERT OR REPLACE INTO';
    const insert = local.prepare(
        `${verb} "${table}" (${columns.map((c) => `"${c}"`).join(',')})
         VALUES (${columns.map(() => '?').join(',')})`,
    );

    for (let offset = 0; offset < total; offset += PAGE) {
        const rows = db.all(`SELECT * FROM "${table}" LIMIT ${PAGE} OFFSET ${offset}`);
        for (const row of rows) insert.run(...columns.map((c) => normalise(row[c])));
        process.stdout.write('.');
    }
    copied += total;
    console.log(` ${total}`);
}

/* ------------------------------------------------------------- documents -- */

let files = 0;
if (WITH_DOCUMENTS) {
    const keys = db.all('SELECT DISTINCT storage_key FROM document_blobs').map((r) => r.storage_key);
    console.log('');
    process.stdout.write(`  ${'documents & templates'.padEnd(32)} ${String(keys.length).padStart(7)} files  `);
    for (const key of keys) {
        const chunks = db.all('SELECT bytes FROM document_blobs WHERE storage_key = ? ORDER BY seq', [key]);
        const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c.bytes)));
        const file = path.join(db.STORAGE, ...String(key).split(/[\\/]+/).filter(Boolean));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
        files += 1;
        process.stdout.write('.');
    }
    console.log(` ${files}`);
}

/* ---------------------------------------------------------------- verify -- */

console.log('');
console.log('  Checking…');

const problems = [];
for (const row of local.prepare('PRAGMA foreign_key_check').all()) {
    problems.push(`foreign key: ${row.table} row ${row.rowid} -> ${row.parent}`);
}
const integrity = local.prepare('PRAGMA integrity_check').get();
const verdict = Object.values(integrity ?? {})[0];
if (verdict !== 'ok') problems.push(`integrity: ${verdict}`);

for (const table of tables) {
    const there = db.get(`SELECT COUNT(*) AS n FROM "${table}"`)?.n ?? 0;
    const here = local.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
    if (Number(here) !== Number(there)) problems.push(`${table}: hosted ${there}, copy ${here}`);
}

local.close();
db.close();

console.log('');
if (problems.length) {
    for (const problem of problems) console.log(`  ✗ ${problem}`);
    console.log('');
    console.log('  This copy is NOT a good backup. Deleting it rather than leaving it');
    console.log('  somewhere looking reassuring.');
    fs.rmSync(OUT, { force: true });
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${OUT}${suffix}`, { force: true });
    console.log('');
    process.exit(1);
}

const size = fs.statSync(OUT).size;
console.log(`  ${copied.toLocaleString()} rows and ${files} file(s), verified.`);
console.log(`  ${OUT}  (${size > 1e9 ? `${(size / 1e9).toFixed(1)} GB` : `${Math.round(size / 1e6)} MB`})`);
console.log('');
console.log('  To run the CRM from this copy, without the network:');
console.log(`      CRM_DB=${OUT} node server.mjs`);
console.log('');

/**
 * A hosted database answers with 64-bit integers as strings when they are too
 * big for a JS number, and with Buffers for blobs. Both go into a file database
 * unchanged; anything else would be a silent type change halfway through a
 * backup.
 */
function normalise(value) {
    if (value === undefined) return null;
    if (typeof value === 'bigint') return value;
    return value;
}
