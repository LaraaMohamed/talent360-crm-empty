/**
 * The network half of the remote database driver. Runs on a worker thread.
 *
 * It speaks the libSQL Hrana v3 "pipeline" protocol over HTTPS and answers on a
 * SharedArrayBuffer instead of postMessage, because the thread that asked is
 * blocked inside Atomics.wait and will not run its message loop until we
 * release it. See lib/turso.mjs for why the caller blocks at all.
 *
 * Nothing here is CRM-aware. It moves statements out and rows back.
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { parentPort, workerData } from 'node:worker_threads';

const { shared, url, token, overflowFile, headerBytes, socketTimeoutMs } = workerData;

/**
 * `fetch` is not used here, and the reason is not taste: measured against a
 * database on loopback it costs ~13ms per request against ~0.4ms for a plain
 * keep-alive http.Agent. Every statement the CRM runs pays that, so a page with
 * thirty of them pays it thirty times.
 *
 * One socket. Requests are issued one at a time by construction — the thread
 * that asked for this one is blocked until it comes back — and a second socket
 * would only mean a second TLS handshake.
 */
const agents = {
    'http:': new http.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 30_000 }),
    'https:': new https.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 30_000 }),
};

const header = new Int32Array(shared, 0, 4);
const inbox = new Uint8Array(shared, headerBytes, shared.byteLength - headerBytes);

const STATUS_INLINE = 1;
const STATUS_OVERFLOW = 2;

/**
 * One stream, held open for the life of the process.
 *
 * The baton identifies it. Everything the CRM does inside `tx()` — BEGIN,
 * the statements, COMMIT — has to land on the same stream or the transaction
 * means nothing, so the baton is not optional bookkeeping.
 */
let baton = null;
let endpoint = normalise(url);
let version = 'v3';

parentPort.on('message', (message) => {
    handle(message).then(reply, (err) => reply({
        error: {
            message: String(err?.message ?? err),
            code: err?.code ?? null,
            transport: Boolean(err?.transport),
        },
    }));
});

async function handle(message) {
    if (message.op === 'close') {
        if (baton) {
            try { await post({ baton, requests: [{ type: 'close' }] }); } catch { /* going away anyway */ }
        }
        baton = null;
        return { results: [] };
    }

    try {
        return await send(message.requests);
    } catch (err) {
        /**
         * A dropped stream is recoverable by starting a new one — unless a
         * transaction was open on it, in which case the writes are gone and
         * quietly retrying would commit a torn version of them. The caller
         * tells us which case this is; it is the only side that knows.
         */
        if (!err.transport || !message.canRetry) throw err;
        baton = null;
        endpoint = normalise(url);
        return send(message.requests);
    }
}

async function send(requests) {
    const body = await post({ baton, requests });
    baton = body.baton ?? null;
    if (body.base_url) endpoint = normalise(body.base_url);

    const responses = [];
    for (const result of body.results ?? []) {
        if (result.type === 'error') throw streamError(result.error);
        responses.push(result.response ?? null);
    }
    return { results: responses };
}

async function post(payload) {
    const target = `${endpoint}/${version}/pipeline`;
    let response;
    try {
        response = await request(target, JSON.stringify(payload));
    } catch (err) {
        throw Object.assign(
            new Error(`Cannot reach the database at ${target}: ${err.message}`),
            { transport: true },
        );
    }

    // Older libSQL servers only speak v2. Ask once, then remember.
    if (response.status === 404 && version === 'v3') {
        version = 'v2';
        return post(payload);
    }

    if (response.status < 200 || response.status >= 300) {
        const text = response.body.toString('utf8');
        throw Object.assign(
            new Error(`Database request failed (HTTP ${response.status}). ${text.slice(0, 400)}`),
            {
                status: response.status,
                // 401/403 are credentials and will not fix themselves; 5xx and a
                // rejected baton will.
                transport: response.status >= 500 || response.status === 409
                    || /baton|stream/i.test(text),
            },
        );
    }

    return JSON.parse(response.body.toString('utf8'));
}

function request(target, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(target);
        const transport = url.protocol === 'https:' ? https : http;

        const req = transport.request({
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || undefined,
            path: `${url.pathname}${url.search}`,
            method: 'POST',
            agent: agents[url.protocol],
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
                'accept-encoding': 'gzip',
                authorization: `Bearer ${token}`,
            },
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                let payload = Buffer.concat(chunks);
                try {
                    if (/gzip/i.test(res.headers['content-encoding'] ?? '')) {
                        payload = zlib.gunzipSync(payload);
                    }
                } catch (err) {
                    reject(new Error(`Unreadable compressed reply: ${err.message}`));
                    return;
                }
                resolve({ status: res.statusCode, body: payload });
            });
            res.on('error', reject);
        });

        req.setNoDelay(true);
        req.setTimeout(socketTimeoutMs, () => {
            req.destroy(new Error(`no reply within ${Math.round(socketTimeoutMs / 1000)}s`));
        });
        req.on('error', reject);
        req.end(body);
    });
}

function streamError(error) {
    const message = error?.message ?? 'The database rejected the statement.';
    const code = error?.code ?? null;
    return Object.assign(new Error(message), {
        code,
        // The server can also report a lost stream in-band, with HTTP 200.
        transport: /stream|baton/i.test(`${code} ${message}`),
    });
}

/** `libsql://host` and `wss://host` are the same host over HTTPS. */
function normalise(raw) {
    const trimmed = String(raw).trim().replace(/\/+$/, '');
    return trimmed
        .replace(/^libsql:\/\//, 'https://')
        .replace(/^wss:\/\//, 'https://')
        .replace(/^ws:\/\//, 'http://');
}

/**
 * Hand the answer back and wake the caller.
 *
 * A reply larger than the shared buffer goes through a file rather than
 * growing the buffer — a SharedArrayBuffer cannot be resized after both
 * threads hold it, and one oversized SELECT should not cost 64MB of resident
 * memory for the rest of the day.
 */
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
