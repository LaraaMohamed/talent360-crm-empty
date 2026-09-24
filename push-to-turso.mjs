/**
 * Copy the local database into the hosted one.
 *
 *   TURSO_URL=libsql://…  TURSO_TOKEN=…  node push-to-turso.mjs
 *
 * Run it once, from the machine that holds `data/crm.db`. It reads that file
 * directly and writes to Turso through the ordinary driver, so what lands there
 * is what the CRM will read back.
 *
 * Safe to run again. It compares row counts table by table, finds the first one
 * that is short, and reloads from there onwards — not just that table, because
 * rewriting a parent row can cascade over children that were already copied,
 * and a resume that skipped them would leave the database quietly missing rows.
 *
 *   --verify        compare counts and report, write nothing
 *   --force         reload every table regardless of counts
 *   --source PATH   read a different file (a backup, say)
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

const VERIFY_ONLY = flag('verify');
const FORCE = flag('force');
const SOURCE = path.resolve(option('source', path.join(process.cwd(), 'data', 'crm.db')));

/* Rows per request. Small enough to stay well inside the statement's parameter
 * limit for wide tables, large enough that 44,000 rows is a few hundred
 * requests rather than 44,000. */
const MAX_ROWS_PER_INSERT = 120;
const MAX_PARAMS_PER_INSERT = 900;
const MAX_BYTES_PER_INSERT = 600_000;

const FTS_TABLE = 'search_index';
const FTS_COLUMNS = ['record_id', 'workspace_id', 'object_key', 'title', 'body'];

if (!fs.existsSync(SOURCE)) {
    console.error(`\n  No database at ${SOURCE}\n`);
    process.exit(1);
}

const db = await import('./lib/db.mjs');
if (!db.REMOTE) {
    console.error('\n  TURSO_URL is not set, so there is nothing to push to.\n');
    console.error('  PowerShell:');
    console.error('    $env:TURSO_URL="libsql://your-db.turso.io"');
    console.error('    $env:TURSO_TOKEN="…"');
    console.error('    node push-to-turso.mjs\n');
    process.exit(1);
}

const { writeBlob, localPath } = await import('./lib/document-store.mjs');

const source = new DatabaseSync(SOURCE, { readOnly: true });

console.log('');
console.log(`  from  ${SOURCE}`);
console.log(`  to    ${db.describe()}`);
console.log('');

/* ------------------------------------------------------------- the tables -- */

/** Real tables, in an order where a row's parents are always written first. */
function plan() {
    const names = source.prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).all().map((r) => r.name);

    // FTS5 keeps its own shadow tables. They are an implementation detail of
    // the index and are rebuilt by inserting into the virtual table itself.
    //
    // document_blobs is skipped for a different reason: on this machine the
    // document bytes are files on disk and the table is empty, so copying it
    // would copy nothing. It is filled from `data/storage/` further down.
    const tables = names.filter(
        (n) => n !== FTS_TABLE && !n.startsWith(`${FTS_TABLE}_`) && n !== 'document_blobs',
    );

    const parents = new Map(tables.map((t) => [t, new Set()]));
    const selfRefs = new Map();
    for (const table of tables) {
        for (const fk of source.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(table)) {
            if (fk.table === table) {
                if (!selfRefs.has(table)) selfRefs.set(table, new Set());
                selfRefs.get(table).add(fk.from);
            } else if (parents.has(fk.table)) {
                parents.get(table).add(fk.table);
            }
        }
    }

    const ordered = [];
    const done = new Set();
    const visiting = new Set();
    const visit = (table) => {
        if (done.has(table) || visiting.has(table)) return;
        visiting.add(table);
        for (const parent of parents.get(table)) visit(parent);
        visiting.delete(table);
        done.add(table);
        ordered.push(table);
    };
    for (const table of tables) visit(table);

    return { ordered, selfRefs };
}

const { ordered, selfRefs } = plan();

const localCount = (table) => source.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
const remoteCount = (table) => {
    try { return db.get(`SELECT COUNT(*) AS n FROM "${table}"`)?.n ?? 0; } catch { return null; }
};

/* ------------------------------------------------------------------ verify -- */

if (VERIFY_ONLY) {
    let short = 0;
    for (const table of [...ordered, FTS_TABLE]) {
        const here = localCount(table);
        const there = remoteCount(table);
        const ok = there === here;
        if (!ok) short += 1;
        console.log(`  ${ok ? '·' : '✗'} ${table.padEnd(32)} local ${String(here).padStart(7)}   hosted ${there === null ? 'missing' : String(there).padStart(7)}`);
    }
    const files = new Set([
        ...source.prepare("SELECT storage_key FROM documents WHERE storage_key NOT LIKE 'proposal:%'").all().map((r) => r.storage_key),
        ...source.prepare('SELECT storage_key FROM document_templates').all().map((r) => r.storage_key),
    ]);
    const hosted = db.get('SELECT COUNT(DISTINCT storage_key) AS n FROM document_blobs')?.n ?? 0;
    const ok = Number(hosted) >= files.size;
    console.log(`  ${ok ? '·' : '✗'} ${'document bytes'.padEnd(32)} local ${String(files.size).padStart(7)}   hosted ${String(hosted).padStart(7)}`);

    console.log('');
    console.log(short || !ok ? `  ${short} table(s) do not match.` : '  Every table matches.');
    console.log('');
    db.close();
    process.exit(short ? 1 : 0);
}

/* -------------------------------------------------------------- the schema -- */

console.log('  Creating the schema…');
db.migrate();

/* ---------------------------------------------------------------- the rows -- */

/**
 * Where to start. A table that already holds every row is left alone, but only
 * while every table before it is also complete — see the note at the top.
 */
let startAt = FORCE ? 0 : ordered.length;
if (!FORCE) {
    for (let i = 0; i < ordered.length; i += 1) {
        if (remoteCount(ordered[i]) !== localCount(ordered[i])) { startAt = i; break; }
    }
}

if (startAt >= ordered.length && !FORCE) {
    console.log('  Every table already matches. Nothing to copy.');
} else {
    if (startAt > 0) console.log(`  Resuming at "${ordered[startAt]}" (${startAt} table(s) already complete).`);
    console.log('');
}

for (let i = startAt; i < ordered.length; i += 1) {
    copyTable(ordered[i]);
}

copySearchIndex();
restoreSelfReferences();
const documents = copyDocuments();

console.log('');
console.log('  Checking…');
let mismatched = 0;
for (const table of [...ordered, FTS_TABLE]) {
    const here = localCount(table);
    const there = remoteCount(table);
    if (there !== here) {
        mismatched += 1;
        console.log(`  ✗ ${table}: local ${here}, hosted ${there}`);
    }
}

console.log('');
if (mismatched) {
    console.log(`  ${mismatched} table(s) did not come across. Run again to retry.`);
} else {
    console.log('  Done. Every table matches.');
}
if (documents.missing.length) {
    console.log('');
    console.log(`  ${documents.missing.length} document(s) have a row but no file on this machine,`);
    console.log('  so there were no bytes to send. They were already lost here:');
    for (const key of documents.missing.slice(0, 10)) console.log(`      ${key}`);
    if (documents.missing.length > 10) console.log(`      … and ${documents.missing.length - 10} more`);
}
console.log('');
console.log('  Take a backup of the hosted database from time to time:');
console.log('      node pull-from-turso.mjs');
console.log('');

db.close();
source.close();
process.exit(mismatched ? 1 : 0);

/* ----------------------------------------------------------------- copying -- */

function copyTable(table) {
    const total = localCount(table);
    const columns = source.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((c) => c.name);
    if (!columns.length) return;

    // A row that points at its own table cannot be written before the row it
    // points at. Blank those columns now and fill them in at the end, rather
    // than trying to sort 1,200 rows into parent-first order.
    const deferred = selfRefs.get(table) ?? new Set();
    const writable = columns.map((c) => (deferred.has(c) ? null : c));

    process.stdout.write(`  ${table.padEnd(32)} ${String(total).padStart(7)} rows  `);
    if (!total) { console.log('·'); return; }

    if (FORCE) db.run(`DELETE FROM "${table}"`);

    let written = 0;
    const pageSize = 2000;
    for (let offset = 0; offset < total; offset += pageSize) {
        const page = source.prepare(
            `SELECT * FROM "${table}" LIMIT ${pageSize} OFFSET ${offset}`,
        ).all();

        for (const batch of batches(page, columns.length)) {
            const values = batch.map((row) => columns.map(
                (name, i) => (writable[i] === null ? null : row[name]),
            ));
            insert(table, columns, values);
            written += batch.length;
            process.stdout.write('.');
        }
    }
    console.log(` ${written}`);
}

/**
 * The full-text index is not copied as data — it is rebuilt by inserting the
 * indexed text, which is what an FTS5 table's contents actually are. Copying
 * the shadow tables instead would move an index built by another SQLite build
 * and hope it is byte-compatible.
 */
function copySearchIndex() {
    const total = localCount(FTS_TABLE);
    process.stdout.write(`  ${FTS_TABLE.padEnd(32)} ${String(total).padStart(7)} rows  `);
    if (!total) { console.log('·'); return; }

    if (remoteCount(FTS_TABLE) === total && !FORCE) { console.log('· already there'); return; }

    db.run(`DELETE FROM "${FTS_TABLE}"`);
    const rows = source.prepare(`SELECT ${FTS_COLUMNS.join(', ')} FROM "${FTS_TABLE}"`).all();
    let written = 0;
    for (const batch of batches(rows, FTS_COLUMNS.length)) {
        insert(FTS_TABLE, FTS_COLUMNS, batch.map((row) => FTS_COLUMNS.map((c) => row[c])), 'INSERT INTO');
        written += batch.length;
        process.stdout.write('.');
    }
    console.log(` ${written}`);
}

function restoreSelfReferences() {
    for (const [table, columns] of selfRefs) {
        const rows = source.prepare(
            `SELECT * FROM "${table}" WHERE ${[...columns].map((c) => `"${c}" IS NOT NULL`).join(' OR ')}`,
        ).all();
        if (!rows.length) continue;

        const pk = source.prepare('SELECT name FROM pragma_table_info(?)').all(table)
            .filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
        if (!pk.length) continue;

        process.stdout.write(`  ${`${table} (self-references)`.padEnd(32)} ${String(rows.length).padStart(7)} rows  `);
        for (const row of rows) {
            db.run(
                `UPDATE "${table}" SET ${[...columns].map((c) => `"${c}" = ?`).join(', ')}
                  WHERE ${pk.map((c) => `"${c}" = ?`).join(' AND ')}`,
                [...[...columns].map((c) => row[c]), ...pk.map((c) => row[c])],
            );
        }
        console.log(` ${rows.length}`);
    }
}

/**
 * The document bytes.
 *
 * On this machine they are files under `data/storage/`; on a host with no
 * persistent disk that directory does not survive a restart, so they travel
 * into the database instead. Keyed by the storage_key already recorded on the
 * row, which is also how the CRM will ask for them back — including the
 * backslashes in keys written on Windows, which are a key and not a path.
 */
function copyDocuments() {
    const keys = new Set();
    for (const row of source.prepare(
        "SELECT storage_key FROM documents WHERE storage_key NOT LIKE 'proposal:%'",
    ).all()) keys.add(row.storage_key);
    for (const row of source.prepare('SELECT storage_key FROM document_templates').all()) {
        keys.add(row.storage_key);
    }

    console.log('');
    process.stdout.write(`  ${'documents & templates'.padEnd(32)} ${String(keys.size).padStart(7)} files  `);
    if (!keys.size) { console.log('·'); return { sent: 0, missing: [] }; }

    const missing = [];
    let sent = 0;
    let bytes = 0;
    for (const key of keys) {
        const file = localPath(key);
        if (!fs.existsSync(file)) { missing.push(key); continue; }

        const size = fs.statSync(file).size;
        const stored = db.get(
            'SELECT COALESCE(SUM(LENGTH(bytes)), 0) AS n FROM document_blobs WHERE storage_key = ?',
            [key],
        )?.n ?? 0;
        if (!FORCE && Number(stored) === size) { process.stdout.write('·'); continue; }

        writeBlob(key, fs.readFileSync(file));
        sent += 1;
        bytes += size;
        process.stdout.write('.');
    }
    console.log(` ${sent} sent${bytes ? ` (${Math.round(bytes / 1e6)} MB)` : ''}${missing.length ? `, ${missing.length} missing` : ''}`);
    return { sent, missing };
}

/** Group rows so no single request is too wide, too long, or too large. */
function* batches(rows, columnCount) {
    const maxRows = Math.max(1, Math.min(MAX_ROWS_PER_INSERT, Math.floor(MAX_PARAMS_PER_INSERT / columnCount)));
    let batch = [];
    let bytes = 0;
    for (const row of rows) {
        const size = estimate(row);
        if (batch.length && (batch.length >= maxRows || bytes + size > MAX_BYTES_PER_INSERT)) {
            yield batch;
            batch = [];
            bytes = 0;
        }
        batch.push(row);
        bytes += size;
    }
    if (batch.length) yield batch;
}

function estimate(row) {
    let bytes = 0;
    for (const value of Object.values(row)) {
        if (value === null || value === undefined) bytes += 8;
        else if (typeof value === 'string') bytes += value.length + 8;
        else if (value instanceof Uint8Array) bytes += Math.ceil(value.length * 1.34) + 8;
        else bytes += 24;
    }
    return bytes;
}

function insert(table, columns, rows, verb = 'INSERT OR REPLACE INTO') {
    const placeholders = `(${columns.map(() => '?').join(',')})`;
    const sql = `${verb} "${table}" (${columns.map((c) => `"${c}"`).join(',')}) VALUES `
        + rows.map(() => placeholders).join(',');
    try {
        db.run(sql, rows.flat());
    } catch (err) {
        // One bad row should say which table and what went wrong, not just fail.
        throw new Error(`Copying "${table}" failed: ${err.message}`);
    }
}
