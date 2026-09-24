/**
 * The network half of the Postgres driver. Runs on a worker thread.
 *
 * Mirrors lib/turso-worker.mjs: it holds the one persistent connection and
 * answers on a SharedArrayBuffer instead of postMessage, because the thread
 * that asked is blocked inside Atomics.wait and will not run its message
 * loop until we release it. See lib/postgres.mjs for why the caller blocks
 * at all, and why `pg` is here rather than a hand-rolled wire-protocol
 * client.
 */
import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import pg from 'pg';

const { shared, url, overflowFile, headerBytes } = workerData;

const header = new Int32Array(shared, 0, 4);
const inbox = new Uint8Array(shared, headerBytes, shared.byteLength - headerBytes);

const STATUS_INLINE = 1;
const STATUS_OVERFLOW = 2;

// Railway's public proxy terminates TLS in front of Postgres itself, so the
// certificate the driver sees is not one CA-chained to a store this process
// carries. This is a disposable evaluation database on a throwaway network
// path, not production traffic — see lib/postgres.mjs's file comment.
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const ready = client.connect();

parentPort.on('message', (message) => {
    handle(message).then(reply, (err) => reply({
        error: { message: String(err?.message ?? err), code: err?.code ?? null },
    }));
});

async function handle(message) {
    await ready;

    if (message.op === 'close') {
        await client.end();
        return { results: [] };
    }

    if (message.op === 'sequence') {
        // A plain multi-statement string goes through Postgres's simple query
        // protocol, which — unlike the extended (parameterised) protocol —
        // accepts several `;`-separated statements in one call. That is what
        // lets schema.postgres.sql run as a single round trip, same as
        // turso.mjs's `sequence()` promises, just without needing to split it
        // into pieces first.
        await client.query(message.requests[0].sql);
        return { results: [] };
    }

    const responses = [];
    for (const req of message.requests) {
        const result = await client.query({ text: req.sql, values: req.params, rowMode: 'array' });
        responses.push({
            columns: (result.fields ?? []).map((f) => f.name),
            rows: (result.rows ?? []).map((row) => row.map(encodeCell)),
            changes: result.rowCount ?? 0,
        });
    }
    return { results: responses };
}

/**
 * A `bytea` column comes back from `pg` as a Node Buffer, which JSON has no
 * native representation for — `JSON.stringify` would otherwise silently turn
 * it into `{type:'Buffer',data:[...]}`. Marked explicitly here so the main
 * thread's `decode()` (lib/postgres.mjs) can turn it back into real bytes,
 * the same contract lib/turso.mjs's blob encoding uses.
 */
function encodeCell(value) {
    if (Buffer.isBuffer(value)) return { __buf: value.toString('base64') };
    return value;
}

function reply(payload) {
    let bytes;
    try {
        bytes = Buffer.from(JSON.stringify(payload), 'utf8');
    } catch (err) {
        bytes = Buffer.from(JSON.stringify({ error: { message: `Unreadable database reply: ${err.message}` } }), 'utf8');
    }

    if (bytes.byteLength <= inbox.byteLength) {
        inbox.set(bytes);
        Atomics.store(header, 1, bytes.byteLength);
        Atomics.store(header, 0, STATUS_INLINE);
    } else {
        fs.writeFileSync(overflowFile, bytes);
        Atomics.store(header, 1, bytes.byteLength);
        Atomics.store(header, 0, STATUS_OVERFLOW);
    }
    Atomics.notify(header, 0);
}
