/**
 * Takes a verified backup of the CRM.
 *
 *   node backup-db.mjs                 take one
 *   node backup-db.mjs --list          show what exists
 *
 *   CRM_BACKUP_DIR      where to write        (default: data/backups)
 *   CRM_BACKUP_KEEP     how many to keep      (default: 14)
 *   CRM_BACKUP_COPY_TO  a second location     (optional — see below)
 *
 * ── WHY THERE IS A SECOND LOCATION RATHER THAN JUST POINTING AT ONE ─────────
 *
 * A sync folder (Google Drive, OneDrive, Dropbox) is the obvious place to put
 * a backup, and the wrong place to WRITE one. Those clients present a virtual
 * filesystem whose writes complete locally and finish somewhere else later;
 * SQLite writing a database file straight into one is the scenario its own
 * documentation warns about. Worse for us: verifying afterwards would read the
 * local cache back, so the check would pass while the copy that actually
 * reached the cloud was truncated.
 *
 * So the snapshot is always written and VERIFIED on local disk, and only then
 * copied — as a plain file copy of bytes already proven good.
 *
 * ── WHY THIS IS NOT `copy crm.db` ───────────────────────────────────────────
 *
 * The database runs in WAL mode, so at any moment some committed data lives in
 * `crm.db-wal` and not yet in `crm.db`. Copying the one file while the server
 * is running produces a file that opens fine and is quietly missing the most
 * recent writes — the worst possible failure, because it is only discovered
 * when it is restored.
 *
 * `VACUUM INTO` asks SQLite itself for a consistent snapshot of the whole
 * database as a single file. It is safe with the server running, it needs no
 * downtime, and the result is a plain `.db` you restore by copying it back.
 *
 * ── WHY IT VERIFIES ─────────────────────────────────────────────────────────
 *
 * A backup nobody has read is a belief, not a backup. Every snapshot is opened,
 * integrity-checked, and its row counts compared against the live database
 * before this script will call it a success. A backup that fails that check is
 * deleted rather than left sitting there looking reassuring.
 *
 * ── WHAT IT COVERS ──────────────────────────────────────────────────────────
 *
 * `crm.db` holds every record AND a verbatim copy of every evidence snapshot —
 * the LinkedIn panels collected at 4-9 seconds a page, which are the most
 * expensive thing in this project and cannot be re-collected cheaply.
 *
 * `data/storage/` holds uploaded and generated documents, which are NOT in the
 * database. It is mirrored alongside, or a restore would come back with every
 * proposal and contract missing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE, STORAGE, ROOT, REMOTE } from './lib/db.mjs';

/**
 * `VACUUM INTO` is how this script gets a consistent snapshot, and it is a
 * thing SQLite does to a file it has open. A hosted database is not that: say
 * so, rather than vacuuming an empty local file and reporting a successful
 * backup of nothing.
 */
if (REMOTE) {
    console.error('');
    console.error('  This CRM is running on a hosted database, not a local file.');
    console.error('');
    console.error('  To back it up:');
    console.error('      node pull-from-turso.mjs');
    console.error('');
    console.error('  That writes a verified .db into data/backups/ and restores the');
    console.error('  documents alongside it, which is what this script would have done.');
    console.error('');
    process.exit(1);
}

const LIST_ONLY = process.argv.includes('--list');
const DEST = process.env.CRM_BACKUP_DIR || path.join(ROOT, 'data', 'backups');
const KEEP = Number(process.env.CRM_BACKUP_KEEP) || 14;

/** Our own snapshots, so hand-made copies sitting in the folder are never pruned. */
const SNAPSHOT = /^crm-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.db$/;

/** The tables whose counts are compared. Cheap, indexed, and meaningful. */
const COUNTED = ['accounts', 'contacts', 'deals', 'prospecting_companies', 'evidence_snapshots', 'prospecting_evidence_snapshots'];

const human = (bytes) => (bytes > 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);

function counts(file) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        const out = {};
        for (const table of COUNTED) {
            const exists = db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', table);
            out[table] = exists ? db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n : null;
        }
        return out;
    } finally {
        db.close();
    }
}

function listBackups(dir = DEST) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter((name) => SNAPSHOT.test(name))
        .map((name) => ({ name, ...fs.statSync(path.join(dir, name)) }))
        .sort((a, b) => b.name.localeCompare(a.name));
}

/** Keeps the newest KEEP snapshots in a directory. Only ever removes its own. */
function prune(dir) {
    const stale = listBackups(dir).slice(KEEP);
    for (const old of stale) fs.rmSync(path.join(dir, old.name), { force: true });
    return stale.length;
}

/* ------------------------------------------------------------------ list -- */

if (LIST_ONLY) {
    const backups = listBackups();
    console.log(`\n  ${DEST}\n`);
    if (!backups.length) console.log('   no backups yet — run `node backup-db.mjs`');
    for (const b of backups) console.log(`   ${b.name}   ${human(b.size).padStart(7)}`);
    console.log('');
    process.exit(0);
}

/* ------------------------------------------------------------- take one -- */

if (!fs.existsSync(DB_FILE)) {
    console.error(`\n  No database at ${DB_FILE}. Nothing to back up.\n`);
    process.exit(1);
}

fs.mkdirSync(DEST, { recursive: true });

// An "off-machine" backup that lives beside the thing it is protecting is not
// one. Said once, plainly, rather than failing — a local copy is still better
// than nothing on the day someone runs this by hand.
const offMachine = !path.resolve(DEST).startsWith(path.resolve(ROOT));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
const target = path.join(DEST, `crm-${stamp}.db`);

console.log('');
console.log(`  source   ${DB_FILE}`);
console.log(`  target   ${target}`);

const source = new DatabaseSync(DB_FILE, { readOnly: true });
try {
    // The path is inlined because VACUUM INTO takes no bound parameters;
    // doubling any quote in it keeps a directory name with an apostrophe from
    // ending the string early.
    source.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
} finally {
    source.close();
}

/* --------------------------------------------------------------- verify -- */

let verified = false;
try {
    const check = new DatabaseSync(target, { readOnly: true });
    const integrity = check.prepare('PRAGMA integrity_check').get();
    check.close();

    const result = integrity.integrity_check ?? Object.values(integrity)[0];
    if (result !== 'ok') throw new Error(`integrity_check returned "${result}"`);

    const before = counts(DB_FILE);
    const after = counts(target);
    for (const table of COUNTED) {
        if (before[table] !== after[table]) {
            throw new Error(`${table}: live has ${before[table]}, backup has ${after[table]}`);
        }
    }

    verified = true;
    const size = fs.statSync(target).size;
    console.log(`  verified ${human(size)}, integrity ok`);
    for (const table of COUNTED) {
        if (after[table] !== null) console.log(`             ${String(after[table]).padStart(6)}  ${table}`);
    }
} catch (err) {
    // A backup that cannot be verified is worse than none, because it will be
    // trusted. Remove it rather than leave it looking like a good one.
    fs.rmSync(target, { force: true });
    console.error(`\n  BACKUP FAILED AND WAS DELETED: ${err.message}\n`);
    process.exit(1);
}

/* -------------------------------------------------------------- storage -- */

if (fs.existsSync(STORAGE) && fs.readdirSync(STORAGE).length) {
    const mirror = path.join(DEST, 'storage');
    // Mirrored rather than snapshotted per run: documents are immutable once
    // written, so one current copy is what a restore needs, and versioning them
    // would multiply the disk cost for nothing.
    fs.cpSync(STORAGE, mirror, { recursive: true, force: false, errorOnExist: false });
    const files = fs.readdirSync(mirror, { recursive: true }).length;
    console.log(`  storage  mirrored to ${mirror} (${files} entries)`);
}

/* ------------------------------------------------------------ copy away -- */

const COPY_TO = process.env.CRM_BACKUP_COPY_TO;
let copied = false;

if (COPY_TO) {
    try {
        fs.mkdirSync(COPY_TO, { recursive: true });
        // Copied, not moved: if the sync folder is unavailable or half-mounted,
        // the verified local snapshot must still exist.
        fs.copyFileSync(target, path.join(COPY_TO, path.basename(target)));

        if (fs.existsSync(STORAGE) && fs.readdirSync(STORAGE).length) {
            fs.cpSync(STORAGE, path.join(COPY_TO, 'storage'), { recursive: true, force: false, errorOnExist: false });
        }
        const dropped = prune(COPY_TO);
        copied = true;
        console.log(`  copied   ${COPY_TO}${dropped ? ` (pruned ${dropped})` : ''}`);
    } catch (err) {
        // Not fatal: the verified local backup exists either way, and failing
        // the whole run because a sync folder was offline would mean no backup
        // at all rather than one in fewer places.
        console.error(`  ⚠ copy to ${COPY_TO} failed: ${err.message}`);
        console.error('    The verified local snapshot was still written.');
    }
}

/* ---------------------------------------------------------------- prune -- */

const dropped = prune(DEST);
if (dropped) console.log(`  pruned   ${dropped} older than the last ${KEEP}`);
console.log(`  kept     ${Math.min(listBackups().length, KEEP)} backup(s)`);

if (!offMachine && !copied) {
    console.log('');
    console.log('  ⚠ This backup is on the same machine as the database, so it does not');
    console.log('    survive losing that machine. Set CRM_BACKUP_COPY_TO to a synced');
    console.log('    folder (Google Drive, OneDrive) or a network share.');
}
console.log('');

process.exit(verified ? 0 : 1);
