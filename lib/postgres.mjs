/**
 * A synchronous client for a Postgres database — the Postgres-on-Railway
 * evaluation backend (DATABASE_URL). Not wired into the app by default; see
 * lib/db.mjs.
 *
 * WHY SYNCHRONOUS
 * ----------------
 * Same reason as lib/turso.mjs: ~800 call sites in this app (`all`, `get`,
 * `run`, `tx`) are synchronous by design, because `node:sqlite` is
 * synchronous. Making them async was already tried once, for Turso, and
 * reverted — a missed `await` does not fail, it returns a Promise that reads
 * as a truthy object and silently corrupts whatever it touches. So this
 * backend uses the exact same bridge Turso does: a worker thread holds the
 * real connection, the calling thread blocks on `Atomics.wait` until the
 * worker writes the reply into a SharedArrayBuffer.
 *
 * WHY `pg`
 * --------
 * package.json describes this project as having zero runtime dependencies,
 * true for the SQLite/Turso paths this evaluation branch does not touch.
 * Postgres's wire protocol (SCRAM-SHA-256 auth, the extended query protocol)
 * is a materially bigger thing to hand-write correctly than the JSON-over-
 * HTTP Hrana protocol lib/turso.mjs speaks, and getting it wrong is a data-
 * correctness risk, not a style question. `pg` (node-postgres) is the one
 * runtime dependency this branch adds, used only here.
 *
 * WHAT DOES NOT TRANSLATE FOR FREE
 * ---------------------------------
 * The app writes SQL in SQLite's dialect throughout: `?` placeholders (not
 * Postgres's `$1, $2, ...`), and `PRAGMA table_info(x)` to introspect a
 * table's columns (lib/db.mjs's migrations, lib/repo.mjs, lib/doc-
 * generation.mjs, and test.mjs itself all call it). Both are translated
 * transparently here — `toPositional()` rewrites placeholders, `planPragma()`
 * answers `table_info` from `information_schema` in the same shape SQLite's
 * `pragma_table_info` returns (cid, name, type, notnull, dflt_value, pk) —
 * so callers do not need to know which backend is live. What is NOT handled
 * here: `json_extract`/`strftime`-style SQL in lib/query.mjs, lib/
 * renewals.mjs, api/records.mjs, and the fts5 `MATCH`/`bm25()` search in
 * api/search.mjs — those are dialect differences in the SQL text itself, not
 * something a driver layer can paper over, and are ported separately.
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

export class PostgresDatabase {
    #worker;
    #shared;
    #header;
    #overflowFile;
    #closed = false;

    /**
     * Set by lib/db.mjs around `tx()`, for interface parity with
     * RemoteDatabase. Unused here: a single persistent TCP connection has no
     * baton/stream to lose and re-open mid-transaction the way Turso's HTTP
     * transport does, so there is nothing for this backend to act on.
     */
    inTransaction = false;

    constructor(url) {
        if (!url) throw new Error('A Postgres database needs DATABASE_URL.');

        this.#shared = new SharedArrayBuffer(HEADER_BYTES + INLINE_CAPACITY);
        this.#header = new Int32Array(this.#shared, 0, 4);
        this.#overflowFile = path.join(
            os.tmpdir(), `crm-postgres-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`,
        );

        this.#worker = new Worker(new URL('./postgres-worker.mjs', import.meta.url), {
            workerData: {
                shared: this.#shared,
                url,
                overflowFile: this.#overflowFile,
                headerBytes: HEADER_BYTES,
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
        const plan = planPragma(sql);
        if (plan?.skip) return EMPTY;
        if (plan?.synthetic) return plan.synthetic;

        const text = toPositional(translateJsonEach(translateJsonExtract(plan?.sql ?? sql)));
        const { results } = this.#call({
            op: 'execute',
            requests: [{ sql: text, params: plan?.params ?? params }],
        });
        return decodeResult(results[0]);
    }

    /**
     * schema.postgres.sql as one call. Unlike Turso's Hrana pipeline, a plain
     * Postgres connection's simple query protocol accepts several
     * `;`-separated statements in one string, so there is no need to split
     * the script into pieces first — see lib/postgres-worker.mjs.
     */
    sequence(sql) {
        this.#call({ op: 'sequence', requests: [{ sql }] });
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
            throw Object.assign(new Error(payload.error.message), { code: payload.error.code ?? undefined });
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
 * SQLite `json_extract(col, path)` -> Postgres's `->`/`->>` jsonb operators.
 * `properties` is stored as `TEXT` in both schemas (see schema.postgres.sql),
 * so every call casts its column to `jsonb` first. Three shapes appear in
 * this app's SQL (lib/query.mjs, lib/renewals.mjs, api/records.mjs):
 *
 *   json_extract(properties, '$."Deal Source"')  -- one segment, quoted
 *                                                     (key may have spaces)
 *   json_extract(properties, '$.renewal.kind')    -- a plain dotted path
 *   json_extract(properties, '$.' || ?)           -- path built at query
 *                                                     time; the bound value
 *                                                     is already the bare
 *                                                     key `->>` wants
 */
export function translateJsonExtract(sql) {
    sql = sql.replace(
        /json_extract\(\s*([A-Za-z0-9_.]+)\s*,\s*'\$\.'\s*\|\|\s*\?\s*\)/g,
        (_, col) => `((${col})::jsonb ->> ?)`,
    );

    return sql.replace(
        /json_extract\(\s*([A-Za-z0-9_.]+)\s*,\s*'\$\.([^']*)'\s*\)/g,
        (_, col, rawPath) => {
            const segments = rawPath.split('.').map((seg) => seg.replace(/^"|"$/g, ''));
            const last = segments.pop().replace(/'/g, "''");
            const chain = segments.map((seg) => `->'${seg.replace(/'/g, "''")}'`).join('');
            return `((${col})::jsonb${chain} ->> '${last}')`;
        },
    );
}

/**
 * SQLite `json_each(expr) je` -> Postgres's `jsonb_array_elements_text`,
 * aliased `je(value)` so the `je.value` the caller already wrote (lib/
 * query.mjs's `has_any_of`/`has_all_of`/`has_none_of`) needs no rewrite.
 * `expr` is scanned with paren-depth tracking rather than a regex because it
 * may itself be a `json_extract(...)` call already rewritten above.
 */
export function translateJsonEach(sql) {
    const marker = 'json_each(';
    let out = '';
    let i = 0;
    while (i < sql.length) {
        const idx = sql.indexOf(marker, i);
        if (idx === -1) {
            out += sql.slice(i);
            break;
        }
        out += sql.slice(i, idx);
        let depth = 1;
        let j = idx + marker.length;
        while (j < sql.length && depth > 0) {
            if (sql[j] === '(') depth += 1;
            else if (sql[j] === ')') depth -= 1;
            j += 1;
        }
        const inner = sql.slice(idx + marker.length, j - 1);
        out += `jsonb_array_elements_text((${inner})::jsonb) je(value)`;
        i = j;
        if (sql.slice(i, i + 3) === ' je') i += 3;
    }
    return out;
}

/**
 * SQLite's `?` positional placeholders, rewritten to Postgres's `$1, $2, …`.
 * Quote-aware for the same reason lib/turso.mjs's `splitStatements` is: a
 * `?` inside a string literal is data, not a parameter marker.
 */
export function toPositional(sql) {
    let out = '';
    let n = 0;
    let word = '';

    // SQLite gives every table an implicit `rowid` used throughout this app
    // as an insertion-order tiebreaker in `ORDER BY x, rowid` (e.g. picking
    // "the first line item" among ties on `position`). Postgres has no
    // equivalent column, but `ctid` (its physical tuple id) sorts the same
    // way for this purpose — a stable-enough tiebreak for a single read.
    const flushWord = () => {
        if (word) {
            out += /^rowid$/i.test(word) ? 'ctid' : word;
            word = '';
        }
    };

    for (let i = 0; i < sql.length;) {
        const ch = sql[i];

        if (ch === "'" || ch === '"' || ch === '`') {
            flushWord();
            out += ch;
            i += 1;
            while (i < sql.length) {
                if (sql[i] === ch) {
                    if (sql[i + 1] === ch) { out += ch + ch; i += 2; continue; }
                    out += ch;
                    i += 1;
                    break;
                }
                out += sql[i];
                i += 1;
            }
            continue;
        }

        if (ch === '?') {
            flushWord();
            n += 1;
            out += `$${n}`;
            i += 1;
            continue;
        }

        if (/[A-Za-z0-9_]/.test(ch)) {
            word += ch;
            i += 1;
            continue;
        }

        flushWord();
        out += ch;
        i += 1;
    }
    flushWord();

    return out;
}

/**
 * SQLite's `pragma_table_info`, reconstructed from `information_schema` in
 * the same column shape (cid, name, type, notnull, dflt_value, pk) that
 * lib/db.mjs, lib/repo.mjs, lib/doc-generation.mjs, and test.mjs all read.
 * Postgres has no PRAGMA statement at all, so every other PRAGMA the app
 * issues either has no meaning here (WAL mode, busy_timeout — SQLite-only
 * concerns Postgres does not have) or is always true here by construction
 * (foreign_keys — Postgres enforces them unconditionally, and
 * foreign_key_check can never find a violation because nothing is ever
 * allowed to write one).
 */
const TABLE_INFO_QUERY = `
    SELECT (row_number() OVER (ORDER BY c.ordinal_position) - 1)::int AS cid,
           c.column_name AS name,
           c.data_type AS type,
           CASE WHEN c.is_nullable = 'NO' THEN 1 ELSE 0 END AS notnull,
           c.column_default AS dflt_value,
           CASE WHEN pk.column_name IS NOT NULL THEN 1 ELSE 0 END AS pk
      FROM information_schema.columns c
      LEFT JOIN (
             SELECT kcu.column_name
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON tc.constraint_name = kcu.constraint_name
                AND tc.table_schema = kcu.table_schema
              WHERE tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'
           ) pk ON pk.column_name = c.column_name
     WHERE c.table_name = $1
     ORDER BY c.ordinal_position`;

export function planPragma(sql) {
    const head = sql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/, '');
    if (!/^pragma\b/i.test(head)) return null;

    const info = head.match(/^pragma\s+table_x?info\s*\(\s*["'`[]?([A-Za-z0-9_]+)["'`\]]?\s*\)/i);
    if (info) return { sql: TABLE_INFO_QUERY, params: [info[1]] };

    if (/^pragma\s+foreign_keys\s*$/i.test(head)) {
        return { synthetic: { columns: ['foreign_keys'], rows: [[1]], changes: 0, lastInsertRowid: null } };
    }
    if (/^pragma\s+foreign_key_check\b/i.test(head)) {
        return { synthetic: { columns: [], rows: [], changes: 0, lastInsertRowid: null } };
    }
    if (/^pragma\s+(foreign_keys|journal_mode|busy_timeout|synchronous|temp_store|cache_size|wal_checkpoint|optimize|defer_foreign_keys)\b/i.test(head)) {
        return { skip: true };
    }
    return null;
}

/* ----------------------------------------------------------------- values -- */

/** Undoes lib/postgres-worker.mjs's base64 marker for a `bytea` cell. */
function decode(value) {
    if (value && typeof value === 'object' && typeof value.__buf === 'string') return Buffer.from(value.__buf, 'base64');
    return value;
}

function decodeResult(result) {
    if (!result) return EMPTY;
    return {
        columns: result.columns,
        rows: result.rows.map((row) => row.map(decode)),
        changes: result.changes,
        // Every table in this schema uses an app-generated TEXT id (see
        // lib/db.mjs's `id()`), never an autoincrementing rowid — nothing in
        // the app reads lastInsertRowid outside this file and lib/turso.mjs.
        lastInsertRowid: null,
    };
}
