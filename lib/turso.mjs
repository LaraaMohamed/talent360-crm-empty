/**
 * A synchronous client for a remote libSQL / Turso database.
 *
 * WHY SYNCHRONOUS, WHICH IS THE OBVIOUS QUESTION
 * ----------------------------------------------
 * The CRM is ~800 call sites of `all()`, `get()`, `run()` and `tx()`, none of
 * which await anything, written that way because `node:sqlite` is synchronous
 * and there was no reason for them not to be. Turso is a network hop, so the
 * natural port is to make all 800 async — which was tried, and which broke the
 * codebase, because a missed `await` does not fail: it returns a Promise that
 * reads as a truthy object and silently corrupts whatever it touches.
 *
 * So the network call blocks instead. A worker thread performs the request; the
 * calling thread waits on `Atomics.wait` until the worker writes the reply into
 * a SharedArrayBuffer. Every existing line keeps its meaning, and `tx()` keeps
 * being a real transaction rather than a hopeful one.
 *
 * WHAT THAT COSTS
 * ---------------
 * The event loop stops for the duration of each query, so the server handles
 * one request at a time and every statement pays a round trip. For a handful
 * of people sharing one CRM this is the right trade; for a public, busy service
 * it would not be. Keep the web service in the same region as the database —
 * co-located that round trip is a few milliseconds, across a continent it is
 * forty, and a page that runs thirty statements can feel either.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';

const HEADER_BYTES = 16;
const INLINE_CAPACITY = Number(process.env.CRM_REMOTE_BUFFER) || 8 * 1024 * 1024;
const TIMEOUT_MS = Number(process.env.CRM_REMOTE_TIMEOUT) || 120_000;

const STATUS_PENDING = 0;
const STATUS_INLINE = 1;
const STATUS_OVERFLOW = 2;

const EMPTY = Object.freeze({ columns: [], rows: [], changes: 0, lastInsertRowid: null });

/**
 * Turns the database's own words into the sentence an operator needs.
 *
 * An expired token is the one failure here that is certain to happen, on a
 * schedule, to a service nobody is watching: the CRM dies at `migrate()` on the
 * next boot and Render shows a stack trace whose top line is
 * `Database request failed (HTTP 401)`. That is accurate and tells you nothing
 * about what to do, which for a token that expires once a year is the
 * difference between a two-minute fix and an afternoon.
 *
 * Only the diagnosable cases are rewritten. Anything unrecognised is passed
 * through untouched, because a guessed explanation is worse than a raw one.
 */
function explain(message) {
    const raw = String(message ?? '');

    if (/token expired/i.test(raw)) {
        return `${raw}\n\n`
            + '  The database auth token has expired. Nothing is wrong with the data or the code.\n'
            + '  Mint a new one and set TURSO_TOKEN where this process reads its environment:\n'
            + '    · Render  — Environment tab (it is `sync: false` in render.yaml, so it lives only there)\n'
            + '    · locally — data/turso.env\n'
            + '  A token carries its expiry in its own payload; decode the middle segment to see it.';
    }
    if (/unauthorized|invalid JWT|401/i.test(raw)) {
        return `${raw}\n\n`
            + '  The database refused the credentials. Check TURSO_TOKEN belongs to the database named\n'
            + '  in TURSO_URL — a token minted for a different database fails exactly like a wrong one.';
    }
    return raw;
}

export class RemoteDatabase {
    #worker;
    #shared;
    #header;
    #overflowFile;
    #closed = false;

    /**
     * Set by lib/db.mjs around `tx()`. The driver cannot infer it — BEGIN and
     * COMMIT arrive as ordinary statements — and it decides whether a dropped
     * connection may be retried or has to be reported as a lost transaction.
     */
    inTransaction = false;

    constructor(url, token) {
        if (!url) throw new Error('A remote database needs TURSO_URL.');
        if (!token) {
            throw new Error(
                'A remote database needs TURSO_TOKEN. Set it in the host\'s environment '
                + '(on Render: Settings → Environment) — never in the repository.',
            );
        }

        this.#shared = new SharedArrayBuffer(HEADER_BYTES + INLINE_CAPACITY);
        this.#header = new Int32Array(this.#shared, 0, 4);
        this.#overflowFile = path.join(
            os.tmpdir(), `crm-libsql-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`,
        );

        this.#worker = new Worker(new URL('./turso-worker.mjs', import.meta.url), {
            workerData: {
                shared: this.#shared,
                url,
                token,
                overflowFile: this.#overflowFile,
                headerBytes: HEADER_BYTES,
                // Comfortably inside the wait below, so a dead socket reports
                // itself as a network error rather than as a mystery timeout.
                socketTimeoutMs: Math.max(10_000, TIMEOUT_MS - 20_000),
            },
        });
        // A crashed worker must not leave the next call waiting the full timeout.
        this.#worker.on('error', (err) => this.#fail(`The database worker stopped: ${err.message}`));
        this.#worker.on('exit', (code) => {
            if (!this.#closed) this.#fail(`The database worker exited (code ${code}).`);
        });
    }

    /* ------------------------------------------------------------ queries -- */

    execute(sql, params = []) {
        const plan = plan_(sql, params);
        if (plan.skip) return EMPTY;

        const { results } = this.#call({
            op: 'execute',
            inTransaction: this.inTransaction,
            canRetry: !this.inTransaction && readOnly(plan.sql),
            requests: [{
                type: 'execute',
                stmt: { sql: plan.sql, args: plan.params.map(encode), want_rows: true },
            }],
        });
        return decodeResult(results[0]?.result);
    }

    /**
     * Several statements separated by semicolons, results discarded.
     *
     * Not sent as Hrana's `sequence`: Turso rejects a blob that opens with a
     * comment ("SQL not allowed statement"), and schema.sql opens with thirty
     * lines of them. Split here instead and send the statements as one
     * pipeline — one round trip, not one per statement, which matters because
     * this runs at every cold start.
     */
    sequence(sql) {
        const statements = splitStatements(sql)
            .map((statement) => plan_(statement, []))
            .filter((step) => !step.skip);
        if (!statements.length) return;

        // Bounded so a very large schema cannot become one enormous request.
        for (let i = 0; i < statements.length; i += 100) {
            this.#call({
                op: 'execute',
                inTransaction: this.inTransaction,
                canRetry: false,
                requests: statements.slice(i, i + 100).map((step) => ({
                    type: 'execute',
                    stmt: { sql: step.sql, args: step.params.map(encode), want_rows: false },
                })),
            });
        }
    }

    close() {
        if (this.#closed) return;
        this.#closed = true;
        try { this.#call({ op: 'close', requests: [] }); } catch { /* nothing to close */ }
        this.#worker.terminate();
        fs.rmSync(this.#overflowFile, { force: true });
    }

    /* ------------------------------------------------------------ waiting -- */

    #call(message) {
        if (this.#closed && message.op !== 'close') throw new Error('The database connection is closed.');

        Atomics.store(this.#header, 0, STATUS_PENDING);
        this.#worker.postMessage(message);

        // 'not-equal' means the worker finished before we got here, which is a
        // success, not a miss.
        if (Atomics.wait(this.#header, 0, STATUS_PENDING, TIMEOUT_MS) === 'timed-out') {
            throw new Error(`The database did not answer within ${Math.round(TIMEOUT_MS / 1000)}s.`);
        }

        const status = Atomics.load(this.#header, 0);
        const length = Atomics.load(this.#header, 1);
        const text = status === STATUS_OVERFLOW
            ? fs.readFileSync(this.#overflowFile, 'utf8')
            : Buffer.from(this.#shared, HEADER_BYTES, length).toString('utf8');

        const payload = JSON.parse(text);
        if (payload.error) {
            throw Object.assign(new Error(explain(payload.error.message)), {
                code: payload.error.code ?? undefined,
            });
        }
        return payload;
    }

    /** Wake a blocked caller with an error rather than letting it hang. */
    #fail(message) {
        const bytes = Buffer.from(JSON.stringify({ error: { message } }), 'utf8');
        new Uint8Array(this.#shared, HEADER_BYTES, bytes.byteLength).set(bytes);
        Atomics.store(this.#header, 1, bytes.byteLength);
        Atomics.store(this.#header, 0, STATUS_INLINE);
        Atomics.notify(this.#header, 0);
    }
}

/* ------------------------------------------------------------- statements -- */

/**
 * PRAGMAs are a local-file idea. The ones the CRM sets are the server's
 * business and it does not accept them; the one it reads for schema migrations
 * has a table-valued equivalent that does travel.
 */
function plan_(sql, params) {
    const head = sql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/, '');
    if (!/^pragma\b/i.test(head)) return { sql, params, skip: false };

    const info = head.match(/^pragma\s+table_x?info\s*\(\s*["'`\[]?([A-Za-z0-9_]+)["'`\]]?\s*\)/i);
    if (info) return { sql: 'SELECT * FROM pragma_table_info(?)', params: [info[1]], skip: false };

    // foreign_keys, journal_mode, busy_timeout, synchronous … the server
    // decides these, and asking it to change them is an error, not a no-op.
    if (/^pragma\s+(foreign_keys|journal_mode|busy_timeout|synchronous|temp_store|cache_size|wal_checkpoint|optimize)\b/i.test(head)) {
        return { skip: true };
    }
    return { sql, params, skip: false };
}

/**
 * Split a script into statements, dropping comments.
 *
 * Semicolons inside string literals and quoted identifiers do not end a
 * statement, which is the only reason this is not `sql.split(';')`.
 */
export function splitStatements(sql) {
    const statements = [];
    let current = '';

    for (let i = 0; i < sql.length;) {
        const ch = sql[i];
        const next = sql[i + 1];

        if (ch === '-' && next === '-') {
            while (i < sql.length && sql[i] !== '\n') i += 1;
            continue;
        }
        if (ch === '/' && next === '*') {
            i += 2;
            while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
            i += 2;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            current += ch;
            i += 1;
            while (i < sql.length) {
                if (sql[i] === ch) {
                    // A doubled quote is an escaped one, not the end.
                    if (sql[i + 1] === ch) { current += ch + ch; i += 2; continue; }
                    current += ch;
                    i += 1;
                    break;
                }
                current += sql[i];
                i += 1;
            }
            continue;
        }
        if (ch === '[') {
            while (i < sql.length && sql[i] !== ']') { current += sql[i]; i += 1; }
            current += ']';
            i += 1;
            continue;
        }
        if (ch === ';') {
            if (current.trim()) statements.push(current.trim());
            current = '';
            i += 1;
            continue;
        }
        current += ch;
        i += 1;
    }
    if (current.trim()) statements.push(current.trim());

    return mergeTriggerBodies(statements);
}

/**
 * A trigger body is full of semicolons that are not statement ends, so the
 * split above tears one apart. Put it back together. This schema has no
 * triggers today; the next one to add a trigger should not have to discover
 * this file.
 */
function mergeTriggerBodies(statements) {
    const merged = [];
    for (const statement of statements) {
        const open = merged.length && /^create\s+(temp\s+|temporary\s+)?trigger\b/i.test(merged.at(-1))
            && !/\bend$/i.test(merged.at(-1));
        if (open) merged[merged.length - 1] += `; ${statement}`;
        else merged.push(statement);
    }
    return merged;
}

/**
 * Whether re-sending the statement after a lost connection is safe. Only reads
 * qualify: a write that may or may not have committed must be reported, not
 * repeated.
 */
function readOnly(sql) {
    const head = sql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/, '');
    return /^(select|pragma|explain)\b/i.test(head);
}

/* ----------------------------------------------------------------- values -- */

function encode(value) {
    if (value === null || value === undefined) return { type: 'null' };
    if (typeof value === 'boolean') return { type: 'integer', value: value ? '1' : '0' };
    if (typeof value === 'bigint') return { type: 'integer', value: value.toString() };
    if (typeof value === 'number') {
        return Number.isInteger(value)
            ? { type: 'integer', value: String(value) }
            : { type: 'float', value };
    }
    if (typeof value === 'string') return { type: 'text', value };
    if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
        return { type: 'blob', base64: Buffer.from(value).toString('base64') };
    }
    if (value instanceof Date) return { type: 'text', value: value.toISOString() };
    return { type: 'text', value: String(value) };
}

function decode(value) {
    switch (value?.type) {
        case 'null': return null;
        case 'text': return value.value;
        case 'float': return value.value;
        case 'blob': return Buffer.from(value.base64 ?? '', 'base64');
        case 'integer': {
            // Hrana sends 64-bit integers as strings. Anything the CRM stores
            // fits a JS number; only refuse to lie when it genuinely does not.
            const n = Number(value.value);
            return Number.isSafeInteger(n) ? n : BigInt(value.value);
        }
        default: return null;
    }
}

function decodeResult(result) {
    if (!result) return EMPTY;
    return {
        columns: (result.cols ?? []).map((c) => c.name),
        rows: (result.rows ?? []).map((row) => row.map(decode)),
        changes: Number(result.affected_row_count ?? 0),
        lastInsertRowid: result.last_insert_rowid == null ? null : Number(result.last_insert_rowid),
    };
}
