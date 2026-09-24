/**
 * Where the bytes of an uploaded or generated document actually live.
 *
 * On a laptop that is `data/storage/`, and always has been: a directory of real
 * .docx files you can open, copy and back up without this software.
 *
 * On a host with no persistent disk that directory is a lie. It accepts the
 * write, serves the file all afternoon, and is empty after the next deploy —
 * so every template someone uploaded and every agreement the CRM generated
 * comes back as "The file is missing from storage." The database is the only
 * thing on such a host that survives, so that is where the bytes go, and the
 * directory becomes a cache in front of it.
 *
 * The file stays the primary read either way. Nothing here changes what a local
 * install does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, HOSTED, STORAGE } from './db.mjs';

/**
 * Big enough that a 5MB contract is twenty rows, small enough that one row is
 * a comfortable HTTP request once base64 has made it a third larger again.
 */
const CHUNK = 256 * 1024;

/**
 * Storage keys are stored in the database as they were written, and a key
 * written on Windows carries backslashes into a container running Linux. It is
 * a key first and a path second; treat it that way.
 */
export function localPath(storageKey) {
    return path.join(STORAGE, ...String(storageKey).split(/[\\/]+/).filter(Boolean));
}

export function writeFile(storageKey, buffer) {
    const file = localPath(storageKey);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buffer);
    if (HOSTED) writeBlob(storageKey, buffer);
}

export function readFile(storageKey) {
    const file = localPath(storageKey);
    if (fs.existsSync(file)) return fs.readFileSync(file);

    const bytes = readBlob(storageKey);
    if (!bytes) return null;

    // Put it back on disk, so the second person to open the same contract this
    // morning does not pay for it again.
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
    } catch { /* the cache is optional; the bytes are already in hand */ }
    return bytes;
}

export function hasFile(storageKey) {
    if (fs.existsSync(localPath(storageKey))) return true;
    if (!HOSTED) return false;
    return Boolean(get('SELECT 1 AS present FROM document_blobs WHERE storage_key = ? LIMIT 1', [storageKey]));
}

export function removeFile(storageKey) {
    try { fs.rmSync(localPath(storageKey), { force: true }); } catch { /* already gone */ }
    if (HOSTED) {
        try { run('DELETE FROM document_blobs WHERE storage_key = ?', [storageKey]); } catch { /* already gone */ }
    }
}

/* ------------------------------------------------------------------ blobs -- */

export function writeBlob(storageKey, buffer) {
    run('DELETE FROM document_blobs WHERE storage_key = ?', [storageKey]);
    for (let seq = 0, offset = 0; offset < buffer.length; seq += 1, offset += CHUNK) {
        run(
            'INSERT INTO document_blobs (storage_key, seq, bytes) VALUES (?,?,?)',
            [storageKey, seq, buffer.subarray(offset, Math.min(offset + CHUNK, buffer.length))],
        );
    }
}

function readBlob(storageKey) {
    if (!HOSTED) return null;
    const rows = all('SELECT bytes FROM document_blobs WHERE storage_key = ? ORDER BY seq', [storageKey]);
    if (!rows.length) return null;
    return Buffer.concat(rows.map((row) => Buffer.from(row.bytes)));
}
