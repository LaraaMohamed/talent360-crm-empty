/**
 * Database access.
 *
 * Three backends, one API — the third added for the Postgres-on-Railway
 * evaluation (see lib/postgres.mjs); the first two are unchanged.
 *
 *   · No TURSO_URL and no DATABASE_URL — `node:sqlite`, one file on disk.
 *     Zero dependencies, and `crm.db` can be copied as a backup. This is how
 *     the CRM runs on a laptop and how `node test.mjs` runs.
 *
 *   · TURSO_URL set — the same SQLite, hosted. Chosen because a container
 *     filesystem is not storage: on a host that has no persistent disk, a file
 *     database is silently discarded on every restart, taking the accounts and
 *     the login with it.
 *
 *   · DATABASE_URL set (and TURSO_URL is not) — Postgres, for evaluating it
 *     as a Railway-native replacement for the above. See lib/postgres.mjs for
 *     what does and does not translate automatically.
 *
 * All three are SYNCHRONOUS, which is the whole point. See lib/turso.mjs for
 * how the hosted ones manage that and what it costs; the short version is
 * that ~800 call sites and every `tx()` in this codebase keep meaning exactly
 * what they say, instead of being rewritten into promises that fail silently
 * when one `await` is missed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { RemoteDatabase } from './turso.mjs';
import { PostgresDatabase } from './postgres.mjs';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DB_FILE = process.env.CRM_DB || path.join(ROOT, 'data', 'crm.db');
export const STORAGE = process.env.CRM_STORAGE || path.join(ROOT, 'data', 'storage');

const REMOTE_URL = (process.env.TURSO_URL || process.env.LIBSQL_URL || '').trim();
const REMOTE_TOKEN = (process.env.TURSO_TOKEN || process.env.LIBSQL_TOKEN || '').trim();
const POSTGRES_URL = (process.env.DATABASE_URL || '').trim();

/** True when this process is talking to a hosted SQLite database rather than a file. */
export const REMOTE = Boolean(REMOTE_URL);

/** True when this process is talking to Postgres — the evaluation backend. */
export const POSTGRES = !REMOTE && Boolean(POSTGRES_URL);

/** Where the data actually is, for the log line and for error messages. */
export function describe() {
    if (POSTGRES) return POSTGRES_URL.replace(/:\/\/[^@]*@/, '://***@');
    return REMOTE ? REMOTE_URL.replace(/^libsql:\/\//, '') : DB_FILE;
}

let backend = null;

export function open() {
    if (backend) return backend;
    backend = POSTGRES ? openPostgres() : REMOTE ? openRemote() : openLocal();
    return backend;
}

function openLocal() {
    /**
     * Required here rather than imported at the top, so that a host running the
     * hosted database never loads it at all. `node:sqlite` is only unflagged
     * from Node 24; a top-level import of it is an immediate crash on Node 22,
     * which is a strange way for a deployment that touches no file database to
     * fail.
     */
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.mkdirSync(STORAGE, { recursive: true });
    const conn = new DatabaseSync(DB_FILE);
    conn.exec('PRAGMA foreign_keys = ON');
    conn.exec('PRAGMA journal_mode = WAL');
    conn.exec('PRAGMA busy_timeout = 5000');

    return {
        remote: false,
        begin: 'BEGIN IMMEDIATE',
        all: (sql, params) => conn.prepare(sql).all(...params).map(toPlain),
        get: (sql, params) => {
            const row = conn.prepare(sql).get(...params);
            return row === undefined ? null : toPlain(row);
        },
        run: (sql, params) => conn.prepare(sql).run(...params),
        exec: (sql) => conn.exec(sql),
        transaction: () => {},
        close: () => conn.close(),
    };
}

/**
 * When the database token runs out, read from the token itself.
 *
 * A token is a JWT: three dot-separated segments, the middle one a base64
 * payload carrying `exp` as a unix timestamp. Nothing secret is decoded here —
 * `exp` is metadata anyone holding the token can already read, and the token is
 * never logged or returned.
 *
 * Returns null when there is nothing to say: no token, not a JWT, or no `exp`
 * claim at all. That last case is a token minted with `--expiration none`,
 * which is the one that never causes this problem.
 */
export function tokenExpiry(token = REMOTE_TOKEN) {
    const parts = String(token ?? '').split('.');
    if (parts.length !== 3) return null;
    try {
        const payload = JSON.parse(
            Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
        );
        if (!payload.exp) return null;
        const at = new Date(payload.exp * 1000);
        return { at, days: Math.floor((at.getTime() - Date.now()) / 86_400_000) };
    } catch {
        return null;
    }
}

/**
 * Says so at boot, while there is still time to act.
 *
 * The failure this exists for is not subtle and not rare: the token expires,
 * the CRM dies at `migrate()` on the next restart, and nobody learns about it
 * until somebody tries to log in. The expiry was knowable the whole time — it
 * is written inside the credential the process is already holding.
 *
 * On a free host that sleeps and restarts many times a day, this runs many
 * times a day, which is exactly the property that makes a log line enough.
 */
function warnAboutExpiry() {
    const expiry = tokenExpiry();
    if (!expiry) {
        console.log('  Database token: no expiry — good, this one cannot lapse.');
        return;
    }
    const on = expiry.at.toISOString().slice(0, 10);
    if (expiry.days < 0) {
        // Unreachable in practice: an expired token fails the first statement.
        // Here so the message exists if it ever is reached.
        console.warn(`  !! The database token EXPIRED on ${on}. Replace TURSO_TOKEN.`);
    } else if (expiry.days <= 30) {
        console.warn(
            `\n  !! The database token expires in ${expiry.days} day${expiry.days === 1 ? '' : 's'} (${on}).\n`
            + '     When it does, this CRM stops starting at all — it is the same failure\n'
            + '     as a wrong password, and it happens without anybody touching the code.\n'
            + '     Mint a replacement (Turso dashboard -> the database -> Tokens, expiry\n'
            + '     "Never") and paste it into Render -> Environment -> TURSO_TOKEN.\n',
        );
    } else {
        console.log(`  Database token: valid until ${on} (${expiry.days} days).`);
    }
}

function openRemote() {
    // Generated documents still land here. They are not durable on a host
    // without a disk — see lib/document-store.mjs, which keeps the bytes in the
    // database and treats this directory as a cache.
    fs.mkdirSync(STORAGE, { recursive: true });
    warnAboutExpiry();
    const conn = new RemoteDatabase(REMOTE_URL, REMOTE_TOKEN);

    const objects = (result) => result.rows.map(
        (row) => Object.fromEntries(result.columns.map((name, i) => [name, row[i]])),
    );

    return {
        remote: true,
        begin: 'BEGIN IMMEDIATE',
        all: (sql, params) => objects(conn.execute(sql, params)),
        get: (sql, params) => objects(conn.execute(sql, params))[0] ?? null,
        run: (sql, params) => {
            const result = conn.execute(sql, params);
            return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
        },
        exec: (sql) => conn.sequence(sql),
        transaction: (isOpen) => { conn.inTransaction = isOpen; },
        close: () => conn.close(),
    };
}

function openPostgres() {
    fs.mkdirSync(STORAGE, { recursive: true });
    const conn = new PostgresDatabase(POSTGRES_URL);

    const objects = (result) => result.rows.map(
        (row) => Object.fromEntries(result.columns.map((name, i) => [name, row[i]])),
    );

    return {
        remote: true,
        // Postgres has no "BEGIN IMMEDIATE" — its MVCC already serialises
        // writes the way that SQLite modifier exists to force. A plain BEGIN
        // is correct here, not a fallback (contrast openRemote's `begin()`,
        // which discovers this by trial and error against a backend that
        // might still be file SQLite underneath).
        begin: 'BEGIN',
        all: (sql, params) => objects(conn.execute(sql, params)),
        get: (sql, params) => objects(conn.execute(sql, params))[0] ?? null,
        run: (sql, params) => {
            const result = conn.execute(sql, params);
            return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
        },
        exec: (sql) => conn.sequence(sql),
        transaction: () => {}, // no baton/stream to track — see PostgresDatabase#inTransaction
        close: () => conn.close(),
    };
}

export function migrate() {
    const conn = open();
    const schemaFile = POSTGRES ? 'schema.postgres.sql' : 'schema.sql';
    conn.exec(fs.readFileSync(path.join(ROOT, schemaFile), 'utf8'));
    applyColumnMigrations();
    applyIndexMigrations();
    ensureIdentity();
    ensureContractingStage();
    migrateLegacyPriorities();
    normalizeAccounts();
    backfillLastCalledBy();
    return conn;
}

/**
 * `last_called_by` did not exist before this column was added, so every
 * assignment somebody had already worked carries the fact of who called it
 * (`activities.actor_id`, on the type `'call'` row nearest `last_called_at`)
 * without it being ON the row. Filtering "who has been ringing this list" by
 * a manager would silently exclude every assignment worked before today.
 *
 * Idempotent by construction: only rows still NULL are touched, so a second
 * boot costs one no-op scan rather than re-deriving anything already set by
 * a real call.
 */
function backfillLastCalledBy() {
    run(
        `UPDATE calling_assignments
            SET last_called_by = (
                SELECT actor_id FROM activities
                 WHERE assignment_id = calling_assignments.id AND type_key = 'call' AND deleted_at IS NULL
                 ORDER BY occurred_at DESC LIMIT 1
            )
          WHERE last_called_by IS NULL AND last_called_at IS NOT NULL`,
    );
}

function normalizeAccounts() {
    run("UPDATE accounts SET account_type = 'Regional' WHERE account_type IS NULL OR TRIM(account_type) = ''");
    run("UPDATE accounts SET billing_currency = 'EGP' WHERE account_type = 'Egypt' AND (billing_currency IS NULL OR TRIM(billing_currency) = '')");
    run("UPDATE accounts SET billing_currency = 'USD' WHERE account_type = 'Regional' AND (billing_currency IS NULL OR TRIM(billing_currency) = '')");
}

/**
 * The priority scale became A / B / C, and existing rows must follow.
 *
 * The columns' defaults changed (`schema.sql` now says 'B'), which only helps
 * records created from now on. Rows written under the old scale — tasks at
 * high/medium/low, calling assignments at high/medium/low — kept their old
 * values, and the new forms validate against the new scale, so editing one of
 * them would fail. Nothing qualifies as "a one-off": callers assign these two
 * columns by hand, so the correct shape of the data can be asserted before any
 * request handler reads it.
 *
 * Idempotent: the UPDATEs match exactly the values that are still on the old
 * scale, so a second boot changes nothing.
 */
function migrateLegacyPriorities() {
    const map = [{ old: 'high', next: 'A' }, { old: 'medium', next: 'B' }, { old: 'low', next: 'C' }];
    for (const { old, next } of map) {
        run('UPDATE tasks SET priority = ? WHERE priority = ?', [next, old]);
        run('UPDATE calling_assignments SET priority = ? WHERE priority = ?', [next, old]);
    }
    // Task form and follow-up sequence used 'normal'/'urgent' under the same
    // scale the priority dropdown replaced.
    run("UPDATE tasks SET priority = 'B' WHERE priority = 'normal'");
    run("UPDATE tasks SET priority = 'A' WHERE priority = 'urgent'");
}

/**
 * Every deal pipeline has a Contracting stage.
 *
 * ── WHY THIS RUNS ON BOOT, WHEN THE OTHER STAGE CHANGES ARE SCRIPTS ─────────
 *
 * Because nothing moves a deal into this stage by hand. Creating an agreement
 * moves it there, signing moves it to Won, and terminating moves it to Lost —
 * all in lib/repo.mjs, from the agreement's own status. `moveDealForAgreement`
 * looks the stage up BY KEY and does nothing when it is absent, deliberately:
 * landing a card on whichever open stage came first would move deals for a
 * reason nobody could read.
 *
 * The consequence is that a workspace without this stage silently loses the
 * automation. It does not error and it does not warn; agreements are created
 * and their deals sit where they were. That is not a state a deployment should
 * be able to be in because somebody did not run a script, so the stage is part
 * of the schema's shape rather than an optional migration.
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
 *
 * It adds a stage and nothing else. No deal is moved, no stage is renamed or
 * removed, and a pipeline that already has one — under this key — is left
 * exactly alone. Positions after the anchor shift down one so the board reads
 * in the order the sale runs in; a pipeline with no Negotiation stage is
 * skipped rather than guessed at.
 */
const CONTRACTING = { key: 'contracting', label: 'Contracting', after: 'negotiation', probability: 85 };

function ensureContractingStage() {
    const pipelines = all(
        "SELECT id, workspace_id FROM pipelines WHERE object_key = 'deal'",
    );
    for (const pipeline of pipelines) {
        const stages = all(
            'SELECT id, key, position FROM stages WHERE pipeline_id = ? ORDER BY position',
            [pipeline.id],
        );
        if (!stages.length) continue;
        if (stages.some((stage) => stage.key === CONTRACTING.key)) continue;
        const anchor = stages.find((stage) => stage.key === CONTRACTING.after);
        if (!anchor) continue;

        // Highest first, so no two rows collide on a position on the way past.
        for (const stage of stages.filter((s) => s.position > anchor.position).reverse()) {
            run('UPDATE stages SET position = ? WHERE id = ?', [stage.position + 1, stage.id]);
        }
        run(
            `INSERT INTO stages (id, workspace_id, pipeline_id, key, label, position, probability,
                                 type, wip_limit, required_fields)
             VALUES (?,?,?,?,?,?,?,'open',NULL,'[]')`,
            [
                `stg_${crypto.randomBytes(9).toString('base64url')}`,
                pipeline.workspace_id, pipeline.id, CONTRACTING.key, CONTRACTING.label,
                anchor.position + 1, CONTRACTING.probability,
            ],
        );
    }
}

function ensureIdentity() {
    if (get('SELECT id FROM database_identity WHERE id = 1')) return;
    run(
        'INSERT INTO database_identity (id, instance_id, status, created_at) VALUES (1, ?, ?, ?)',
        [`dbi_${crypto.randomBytes(9).toString('base64url')}`, 'primary', new Date().toISOString()],
    );
}

export function identity() {
    return get('SELECT * FROM database_identity WHERE id = 1');
}

const SCORE_MIGRATION = {
    score_overall: 'INTEGER',
    score_qualification: 'INTEGER',
    score_icp: 'INTEGER',
    score_size: 'INTEGER',
    score_industry: 'INTEGER',
    score_decision_maker: 'INTEGER',
    score_enrichment: 'INTEGER',
    scored_at: 'TEXT',
    score_model_version: 'INTEGER',
};

/**
 * Exported so the test suite can assert that no index in schema.sql names one
 * of these. That file runs BEFORE these columns are added, so such an index is
 * fatal on every existing database — see INDEX_MIGRATIONS below.
 */
export const COLUMN_MIGRATIONS = {
    contacts: {
        // Superseded by `services` below (multiple, same shape as
        // accounts.services) — kept only so a workspace that predates the
        // change still has its old single value on disk; the field
        // registry (lib/objects.mjs) no longer reads or writes it.
        // apply-contact-services-migration.mjs backfilled `services` from
        // it once.
        service_line_key: 'TEXT',
        services: 'TEXT',
        campaign_id: 'TEXT',
        full_name: 'TEXT',
        email_verified: 'INTEGER NOT NULL DEFAULT 0',
        verification_status: 'TEXT',
        verification_provider: 'TEXT',
        verification_confidence: 'REAL',
        verified_at: 'TEXT',
    },
    /**
     * The value columns are a SORT INDEX, not a source of truth — see the
     * comment on the table in schema.sql. They default to 0, which reads as
     * "not computed yet"; `syncDealValues` fills them on the next write, and
     * `node backfill-deal-values.mjs` does the existing rows in one pass.
     */
    deals: {
        campaign_id: 'TEXT',
        value_one_time: 'REAL NOT NULL DEFAULT 0',
        value_mrr: 'REAL NOT NULL DEFAULT 0',
        value_arr: 'REAL NOT NULL DEFAULT 0',
        value_weighted: 'REAL NOT NULL DEFAULT 0',
        value_tcv: 'REAL NOT NULL DEFAULT 0',
    },
    accounts: {
        campaign_id: 'TEXT',
        ...SCORE_MIGRATION,
        services: 'TEXT',
        /**
         * Two separate facts, kept separate on purpose.
         *
         * `account_type` is the commercial grouping — Egypt or Regional — and
         * `billing_currency` is what the client actually pays in. Collapsing
         * them into one field is exactly what the business asked us not to do:
         * a Regional client can pay in SAR, and the grouping still says
         * Regional. Type only supplies the opening default.
         */
        account_type: 'TEXT',
        billing_currency: 'TEXT',
    },
    verdicts: {
        source: "TEXT NOT NULL DEFAULT 'engine'",
        decided_by: 'TEXT',
        decision_note: 'TEXT',
        subject_type: "TEXT NOT NULL DEFAULT 'account'",
        subject_key: 'TEXT',
    },
    prospecting_verdicts: {
        subject_type: "TEXT NOT NULL DEFAULT 'prospect'",
        subject_key: 'TEXT',
    },
    prospecting_companies: { import_batch_id: 'TEXT', ...SCORE_MIGRATION, services: 'TEXT' },
    prospecting_contacts: {
        import_batch_id: 'TEXT',
        full_name: 'TEXT',
        verification_provider: 'TEXT',
        verification_confidence: 'REAL',
        verified_at: 'TEXT',
    },
    import_batches: { deleted_at: 'TEXT' },
    /**
     * Outreach state on a campaign membership.
     *
     * A membership row already answers "who is in which push"; these columns
     * answer "what has outreach done to them since", whatever provider runs the
     * sending. The vocabulary is deliberately neutral — `outreach_status`
     * never stores a vendor's word for it, the same rule
     * lib/verification.mjs applies to email statuses. The provider's own
     * identifiers and untranslated extras live in `external_key` and
     * `outreach_metadata` (JSON), where a provider swap cannot corrupt them.
     *
     * Counters are denormalised for the same reason calling_assignments'
     * call_count is: drawing a member list is one query, not one per row.
     */
    campaign_members: {
        external_key: 'TEXT',
        outreach_status: 'TEXT',
        current_sequence: 'INTEGER',
        total_emails_sent: 'INTEGER NOT NULL DEFAULT 0',
        total_opens: 'INTEGER NOT NULL DEFAULT 0',
        total_clicks: 'INTEGER NOT NULL DEFAULT 0',
        total_replies: 'INTEGER NOT NULL DEFAULT 0',
        first_sent_at: 'TEXT',
        last_sent_at: 'TEXT',
        last_event_at: 'TEXT',
        last_event_type: 'TEXT',
        replied_at: 'TEXT',
        bounced_at: 'TEXT',
        unsubscribed_at: 'TEXT',
        categorized_at: 'TEXT',
        lead_category: 'TEXT',
        outreach_metadata: 'TEXT',
    },
    // Which role a dashboard is for. NULL keeps the existing workspace-wide
    // one working exactly as it did, so this migration changes nothing on its
    // own — api/dashboard.mjs picks a role layout only where one exists.
    dashboards: { role: 'TEXT' },
    /**
     * The CRM record a generated document belongs to.
     *
     * Adding the column is all this can do from here. Dropping `deal_id`'s NOT
     * NULL is a table rebuild, which `apply-generated-records.mjs` does when a
     * human asks — so on an un-migrated database the column exists and only
     * account-level generation (the case that needs a null deal) is refused.
     */
    /**
     * Who reviewed this document, when, and what they said.
     *
     * The verdict lives in `status` — that column already existed and already
     * had a vocabulary, so review is three more values in it rather than a
     * parallel state field that can disagree with it. These three columns are
     * the evidence behind whichever value it holds: a rejection with no reason
     * sends the author back to guess.
     *
     * `review_note` is deliberately kept on the record and not in the audit
     * trail alone. The author has to READ it to act on it, and an audit event
     * is not a thing the product shows them.
     */
    proposals: {
        document_type: 'TEXT', document_id: 'TEXT',
        reviewed_by: 'TEXT', reviewed_at: 'TEXT', review_note: 'TEXT', submitted_at: 'TEXT',
        /**
         * What KIND of proposal this is — the normal, commercial one a
         * customer reads, or the Internal Team Proposal automatically raised
         * when the agreement it comes from is signed.
         *
         * A column, not a naming convention: "identify it by its title" is
         * exactly the trap `lib/repo.mjs`'s own header warns about elsewhere
         * in this file — a proposal titled "Internal Team Proposal" by a rep,
         * by hand, must not be mistaken for the system's own automation, and
         * the reverse mistake (treating a real quote as internal because
         * somebody renamed it) is just as costly. `source_proposal_id` and
         * `source_agreement_id` are the traceable relationship; the partial
         * unique index below (see INDEX_MIGRATIONS) is what makes "exactly
         * one Internal Team Proposal per Agreement" a database fact instead
         * of a hope.
         */
        type: "TEXT NOT NULL DEFAULT 'standard'",
        source_proposal_id: 'TEXT',
        source_agreement_id: 'TEXT',
    },
    /**
     * What a contract is actually worth, and when it comes up for renewal.
     *
     * An agreement recorded who signed what and when it expires, but not what
     * the client pays or which service they pay it for — so "map the existing
     * HCM clients and what they are worth" could not be answered from the CRM
     * at all. These four make an agreement a revenue record rather than only a
     * document.
     *
     * `renewal_date` is separate from `expiry_date` even though it starts equal
     * to it. They answer different questions: expiry is when the contract ends,
     * renewal is when somebody has to have made the decision. A 90-day notice
     * period moves the second and not the first, and once one contract in the
     * book is renewed early the two have permanently parted company.
     */
    agreements: {
        document_type: 'TEXT', document_id: 'TEXT',
        reviewed_by: 'TEXT', reviewed_at: 'TEXT', review_note: 'TEXT', submitted_at: 'TEXT',
        service_line_key: 'TEXT',
        contract_value: 'REAL',
        currency: 'TEXT',
        renewal_date: 'TEXT',
        /**
         * The renewal sweep's idempotency marker (lib/renewals.mjs).
         *
         * Set the first time the notice-due task/notification are raised for
         * THIS agreement's current expiry date. A sweep that runs every few
         * hours must recognise "already handled" without re-reading the task
         * table each time, and must reset automatically the moment the
         * expiry date changes — renewing or amending the contract is a new
         * cycle, not a continuation of the old notice.
         */
        renewal_notice_sent_at: 'TEXT',
        renewal_notice_expiry: 'TEXT',
        /**
         * Whether this contract is EVER meant to renew. The one renewal
         * concept this schema exposes to anyone — `auto_renew` (below) was
         * a second, unused one and was removed from the object registry, so
         * this is what the notice sweep and every UI actually read. Defaults
         * to 1 so agreements written before this column existed, and any new
         * one nobody touches the box on, keep getting a renewal notice
         * rather than silently losing it.
         */
        renewable: 'INTEGER NOT NULL DEFAULT 1',
    },
    email_messages: {
        // Why a queued send failed — SMTP rejected it, the recipient bounced
        // at RCPT TO, storage had no bytes for an attachment. Shown next to
        // the message wherever it appears; never silently retried.
        error: 'TEXT',
    },
    /**
     * A call is an activity, not a second kind of thing.
     *
     * Cold calling needs four facts the generic activity did not carry. They
     * live as columns rather than inside `properties` because every number on
     * the calling dashboard groups by outcome and date over what will become
     * tens of thousands of rows, and JSON extraction cannot use an index.
     *
     * All four are NULL for every activity that is not a call.
     */
    /**
     * Where a lead is in the four-step follow-up sequence, and whether it died.
     *
     * Columns rather than JSON on the assignment because the queue filters on
     * them on every read: "alive", "in sequence", "dead" are three questions
     * the calling screen asks before it can draw, and a JSON extraction cannot
     * use an index. `sequence_step` counts COMPLETED steps, 0..4; `dead_at` is
     * stamped by lib/follow-up.mjs when step four is done and by nothing else.
     */
    calling_assignments: {
        sequence_started_at: 'TEXT',
        sequence_step: 'INTEGER',
        dead_at: 'TEXT',
        dead_reason: 'TEXT',
        /**
         * Unanswered calls in a row. Three of them retires the lead.
         *
         * Defaults to 0 on an existing row, which reads as "no streak known" and
         * is the safe direction: a lead that has already been rung twice without
         * answer gets one more attempt than the rule strictly allows, rather than
         * being retired by a migration nobody asked for.
         * `node apply-no-answer-death.mjs` recomputes it from the call history.
         */
        no_answer_streak: 'INTEGER NOT NULL DEFAULT 0',
        /**
         * When the sequence finished because the lead ANSWERED.
         *
         * Distinct from `dead_at`, which is the sequence running out. A lead that
         * engaged on the second follow-up and one that ignored all four are
         * opposite results, and a single "sequence over" column would have made
         * them the same row. See `completeSequence` in lib/follow-up.mjs.
         */
        sequence_completed_at: 'TEXT',
        /**
         * Who actually made the last call — as distinct from `assigned_to`,
         * whose queue it is.
         *
         * A manager covering one call on somebody's list still owns the queue
         * row through `assigned_to`; this is the other question, "who has
         * actually been ringing this list", which `assigned_to` cannot answer
         * once more than one person has touched an assignment. Stamped in the
         * same UPDATE `logCall` already writes `last_called_at`/`last_outcome`
         * in, so it can never disagree with them about which call was last.
         */
        last_called_by: 'TEXT',
    },
    /**
     * Who typed the note in, as distinct from whose note it is.
     *
     * `author_id` is whose words these are. A note entered on somebody's behalf
     * — dictated after a meeting, carried in by an import — has an author and a
     * different person who keyed it, and the manager filter asks about both.
     */
    notes: { created_by: 'TEXT' },
    activities: {
        /**
         * Who TYPED it in, as distinct from who did it.
         *
         * `actor_id` is who made the call — the fact being recorded. This is
         * who entered the record, which is a different person whenever a
         * manager logs a meeting on a rep's behalf or an import carries
         * somebody else's work in. Without it "filter activities by who created
         * them" had nothing to filter on, and the two questions collapsed into
         * one answer that was right about half the time.
         *
         * Written by `createRecord`, which fills `created_by` on any object
         * whose table has the column.
         */
        created_by: 'TEXT',
        outcome: 'TEXT',
        next_follow_up_at: 'TEXT',
        assignment_id: 'TEXT',
        /**
         * A meeting's own date and own state — see the comment in schema.sql.
         *
         * `meeting_at` is when the meeting IS; `occurred_at` is when the call
         * that booked it happened, and a report about meetings has to use the
         * first. `meeting_status` is scheduled | done | no_show, because a no
         * show is a fact somebody records and not the absence of a "done".
         *
         * Existing rows are filled from `properties.meetingAt` and the call
         * history by `node apply-meeting-outcomes.mjs`.
         */
        meeting_at: 'TEXT',
        meeting_status: 'TEXT',
        // One deliberate submission is one call, however many times the button
        // was clicked. See the unique index below.
        idempotency_key: 'TEXT',
        /**
         * The due-reminder sweep's idempotency marker for a meeting
         * (lib/reminders.mjs) — same shape as agreements.renewal_notice_sent_at
         * above. Set once, the first time this meeting's own reminder fires;
         * a meeting rescheduled to a new `meeting_at` is a new thing to be
         * reminded about, so the sweep clears this the moment that column
         * changes rather than trusting a second write to remember to.
         */
        meeting_reminder_sent_at: 'TEXT',
    },
    /**
     * The due-reminder sweep's idempotency marker for a task
     * (lib/reminders.mjs) — one notification per task, the moment it
     * actually becomes due, never a fresh one on every sweep tick just
     * because the task is still open.
     */
    tasks: {
        reminder_sent_at: 'TEXT',
    },
};

/**
 * Indexes over columns that `COLUMN_MIGRATIONS` adds.
 *
 * They cannot live in schema.sql. That file runs FIRST, before the ALTER TABLEs
 * below it, so on a database that predates the column an index naming it would
 * fail before the column had been added — taking the whole migration down.
 */
const INDEX_MIGRATIONS = [
    /**
     * Sorting a pipeline by what it is worth.
     *
     * These belong here rather than in schema.sql because that file is executed
     * BEFORE `applyColumnMigrations`, so on any database that predates the value
     * columns an index naming them fails — and a failed migration takes the
     * server down on start, for every existing deployment at once.
     */
    `CREATE INDEX IF NOT EXISTS idx_deals_value
        ON deals(workspace_id, value_one_time)`,
    /**
     * Meeting analytics: a date range of meetings, grouped by person.
     *
     * `meeting_at` is added by the column migration above, so the index has to
     * be created after it — the same reason the deal value indexes are here.
     */
    `CREATE INDEX IF NOT EXISTS idx_activities_meeting
        ON activities(workspace_id, meeting_at)`,
    `CREATE INDEX IF NOT EXISTS idx_deals_mrr
        ON deals(workspace_id, value_mrr)`,
    `CREATE INDEX IF NOT EXISTS idx_activities_outcome
        ON activities(workspace_id, outcome, occurred_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_activities_actor
        ON activities(workspace_id, actor_id, occurred_at DESC)`,
    // "What did Sara enter this week" is a manager's question and, without
    // this, a full scan of every activity in the workspace.
    `CREATE INDEX IF NOT EXISTS idx_activities_created_by
        ON activities(workspace_id, created_by, occurred_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_created_by
        ON tasks(workspace_id, created_by, due_at)`,
    // Partial, so the millions of activities that are not calls do not each
    // need a unique NULL slot.
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_idempotency
        ON activities(workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL`,
    /**
     * One record per generated document, and one document per record.
     *
     * This is what keeps the account's list and the sidebar's list the same
     * rows: neither a document with two proposals pointing at it nor a second
     * record for a file that already has one. Partial — a proposal built from a
     * deal's line items has no document, and a deleted record must not keep the
     * slot it no longer occupies.
     */
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_document
        ON proposals(document_id)
     WHERE document_id IS NOT NULL AND deleted_at IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_agreements_document
        ON agreements(document_id)
     WHERE document_id IS NOT NULL AND deleted_at IS NULL`,
    /**
     * One outreach identity per membership. The provider addresses people by
     * its own ids; this index is what turns an incoming event into exactly one
     * membership row, and a redelivered link into a no-op.
     */
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_members_external
        ON campaign_members(campaign_id, external_key) WHERE external_key IS NOT NULL`,
    /**
     * Exactly one Internal Team Proposal per signed Agreement, as a database
     * fact rather than a hope. `ensureInternalTeamProposal` (lib/internal-
     * proposal.mjs) checks before it inserts, which closes the ordinary race;
     * this closes the one a check-then-insert cannot — two requests landing
     * in the gap between the check and the write. Partial, because only rows
     * of this type carry the constraint at all: a workspace can have many
     * ordinary proposals against one agreement's deal, and a proposal that
     * predates this feature has no source agreement to be unique against.
     */
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_internal_team_per_agreement
        ON proposals(source_agreement_id)
     WHERE type = 'internal_team' AND deleted_at IS NULL`,
];

function applyColumnMigrations() {
    for (const [table, columns] of Object.entries(COLUMN_MIGRATIONS)) {
        const existing = new Set(all(`PRAGMA table_info(${table})`).map((c) => c.name));
        if (!existing.size) continue;
        for (const [column, type] of Object.entries(columns)) {
            if (existing.has(column)) continue;
            exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        }
    }
}

function applyIndexMigrations() {
    for (const statement of INDEX_MIGRATIONS) exec(statement);
}

/* -------------------------------------------------------------- querying -- */

/**
 * How many statements have been executed, and what they were.
 *
 * ── WHY THE SERVER COUNTS ITS OWN QUERIES ───────────────────────────────────
 *
 * Against the live backend every statement is a BLOCKING round trip to Turso —
 * the driver parks the thread on `Atomics.wait` until the worker answers. So
 * the cost of a request is not how much work it does, it is how many times it
 * asks. A handler that runs a hundred cheap queries is slower than one that
 * runs three expensive ones, by a margin nothing about the SQL would predict.
 *
 * That makes "statements per request" the number worth watching, and it is
 * invisible without counting. An integer increment per query costs nothing;
 * `CRM_QUERY_LOG=1` additionally keeps the text, which is how you find the one
 * that runs fifty-seven times.
 */
let queryCount = 0;
const LOGGING = process.env.CRM_QUERY_LOG === '1';
let queryLog = [];

export function queryStats() {
    return { count: queryCount, log: LOGGING ? queryLog : null };
}

export function resetQueryStats() {
    queryCount = 0;
    queryLog = [];
}

function counted(sql) {
    queryCount += 1;
    if (LOGGING) queryLog.push(String(sql).replace(/\s+/g, ' ').trim().slice(0, 160));
}

export function all(sql, params = []) {
    counted(sql);
    return open().all(sql, params);
}

export function get(sql, params = []) {
    counted(sql);
    return open().get(sql, params);
}

export function run(sql, params = []) {
    counted(sql);
    return open().run(sql, params);
}

export function exec(sql) {
    counted(sql);
    return open().exec(sql);
}

function toPlain(row) {
    return { ...row };
}

let txDepth = 0;

export function tx(fn) {
    const conn = open();
    const nested = txDepth > 0;
    const savepoint = `sp_${txDepth}`;

    if (nested) statement(conn, `SAVEPOINT ${savepoint}`);
    else begin(conn);
    txDepth += 1;
    conn.transaction(true);
    try {
        const out = fn();
        statement(conn, nested ? `RELEASE ${savepoint}` : 'COMMIT');
        txDepth -= 1;
        conn.transaction(txDepth > 0);
        return out;
    } catch (err) {
        txDepth -= 1;
        try {
            if (nested) {
                statement(conn, `ROLLBACK TO ${savepoint}`);
                statement(conn, `RELEASE ${savepoint}`);
            } else {
                statement(conn, 'ROLLBACK');
            }
        } catch { /* already rolled back */ }
        conn.transaction(txDepth > 0);
        throw err;
    }
}

/**
 * Transaction control goes one statement at a time. A hosted database runs each
 * statement as its own request, and a rollback bundled with a release is two
 * requests whether it looks like one line or not.
 */
function statement(conn, sql) {
    conn.run(sql, []);
}

/**
 * `BEGIN IMMEDIATE` is what a file database needs to avoid a deadlock when a
 * read transaction tries to become a write. A hosted one may not accept the
 * modifier — it is already serialising writes for us — so if it refuses, drop
 * to a plain BEGIN and remember that for the rest of the process.
 */
function begin(conn) {
    try {
        statement(conn, conn.begin);
    } catch (err) {
        if (conn.begin !== 'BEGIN IMMEDIATE' || !/immediate|syntax|parse/i.test(err.message)) throw err;
        conn.begin = 'BEGIN';
        statement(conn, conn.begin);
    }
}

/* ---------------------------------------------------------------- values -- */

export function id(prefix) {
    return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

export function now() {
    return new Date().toISOString();
}

export function json(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch { return fallback; }
}

export function bind(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') return JSON.stringify(value);
    return value;
}

export function close() {
    if (backend) {
        backend.close();
        backend = null;
    }
}
