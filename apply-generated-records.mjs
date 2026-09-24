/**
 * Wires the Proposals and Agreements lists to the documents an account has
 * actually generated.
 *
 *   node apply-generated-records.mjs            # show what would change
 *   node apply-generated-records.mjs --apply    # write it
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 *
 * Generating an HCM Proposal for an account produced a row in `documents` and a
 * row in `document_generations`, and nothing in `proposals`. So the account
 * listed the documents it had generated, the Proposals list in the sidebar
 * listed records built from a deal's line items, and the two never contained the
 * same thing. `agreements` was worse: no code path outside the tests ever wrote
 * a row, so the Agreements list was permanently empty and the renewal report —
 * which reads `expiry_date` — had nothing to read, while contracts with end
 * dates in them sat in the document table.
 *
 * The account's view is the one that was right. This makes the sidebar's lists
 * a view of the same documents: one record per generated document, joined by
 * `document_id`.
 *
 * ── WHAT THIS DOES ──────────────────────────────────────────────────────────
 *
 * `proposals`, `agreements`   `deal_id` stops being NOT NULL, because a document
 *                             is generated for an ACCOUNT and a deal is optional
 *                             context. `document_type` and `document_id` are
 *                             added by the boot migration; the rebuild carries
 *                             them.
 *
 * backfill                    One record per generated document, in the order
 *                             the documents were produced — carrying the deal it
 *                             came from and, for agreements, the contract dates
 *                             typed into it. Those dates are what put an
 *                             existing contract into the renewals report.
 *
 *                             Only the newest proposal of each type on an
 *                             account is left `issued`; the ones it replaced are
 *                             `superseded`, which is the difference between a
 *                             readable list and six identical-looking rows.
 *
 * Nothing is deleted and no generated document's CONTENT is touched: every
 * generation keeps its own frozen `fields` and `placeholders`. Agreements are
 * backfilled as drafts because signing is a human act this script has no
 * evidence of.
 */
import { migrate, get, all, run, exec, tx, id, now, json, close } from './lib/db.mjs';
import { insert, reindex } from './lib/repo.mjs';
import { DOCUMENT_TYPES } from './lib/document-types.mjs';

const APPLY = process.argv.includes('--apply');

migrate();

/** The declared SQL of a table, or '' when it does not exist. */
function tableSql(table) {
    return all("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?", [table])[0]?.sql ?? '';
}

const needsRebuild = {
    proposals: /deal_id\s+TEXT\s+NOT\s+NULL/i.test(tableSql('proposals')),
    agreements: /deal_id\s+TEXT\s+NOT\s+NULL/i.test(tableSql('agreements')),
};

/**
 * Every generated document that has no record yet, oldest first.
 *
 * Oldest first because the numbering follows it: P-2026-0002 should be the
 * proposal written before P-2026-0003, whichever order this happens to read
 * them in.
 */
function orphans() {
    const claimed = new Set([
        ...all('SELECT document_id FROM proposals WHERE document_id IS NOT NULL AND deleted_at IS NULL'),
        ...all('SELECT document_id FROM agreements WHERE document_id IS NOT NULL AND deleted_at IS NULL'),
    ].map((r) => r.document_id));

    return all(
        `SELECT g.*, a.name AS account_name, a.deleted_at AS account_deleted_at
           FROM document_generations g
           LEFT JOIN accounts a ON a.id = g.account_id
          WHERE g.status = 'generated' AND g.document_id IS NOT NULL
          ORDER BY g.created_at, g.id`,
    ).flatMap((row) => {
        if (claimed.has(row.document_id)) return [];
        const docType = DOCUMENT_TYPES[row.document_type];
        // A generation whose type is no longer in the registry has no category,
        // so there is no list it belongs in. Reported, never guessed at.
        if (!docType) return [{ ...row, problem: `unknown document type "${row.document_type}"` }];
        if (!row.account_name) return [{ ...row, problem: 'its account no longer exists' }];
        return [{ ...row, docType, table: docType.category === 'agreement' ? 'agreements' : 'proposals' }];
    });
}

/**
 * Records that are live while the account they belong to is deleted.
 *
 * An earlier version of this script created them that way, which resurrected
 * proposals into a list they had never been in — the account was deleted, and
 * everything hanging off it went with it.
 */
function strays(table) {
    return all(
        `SELECT t.id, t.workspace_id, t.number, a.deleted_at AS account_deleted_at, a.name AS account_name
           FROM ${table} t JOIN accounts a ON a.id = t.account_id
          WHERE t.document_type IS NOT NULL AND t.deleted_at IS NULL AND a.deleted_at IS NOT NULL`,
    );
}

const found = orphans();
const backfill = found.filter((row) => !row.problem);
const skipped = found.filter((row) => row.problem);
const stray = [...strays('proposals'), ...strays('agreements')];

const plan = [];
if (needsRebuild.proposals) plan.push('proposals: rebuild with a nullable deal_id');
if (needsRebuild.agreements) plan.push('agreements: rebuild with a nullable deal_id');
for (const row of backfill) {
    plan.push(`${row.table}: + ${row.docType.label} v${row.version} — ${row.account_name}`
        + (row.account_deleted_at ? ' (account deleted — record created deleted too)' : ''));
}
for (const row of stray) {
    plan.push(`${row.number}: account "${row.account_name}" is deleted — deleting the record to match`);
}
for (const row of skipped) {
    plan.push(`  ⚠ skipped a generation from ${row.created_at.slice(0, 10)}: ${row.problem}`);
}

if (!plan.length) {
    console.log('Every generated document already has its record. Nothing to do.');
    close();
    process.exit(0);
}

console.log(plan.join('\n'));

if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write it, after `npm run backup`.');
    close();
    process.exit(0);
}

/**
 * Foreign keys OFF for the rebuild, and only for the rebuild.
 *
 * `proposal_versions.proposal_id` and `agreement_proposals.agreement_id` are
 * declared ON DELETE CASCADE. With foreign keys enforced, DROP TABLE proposals
 * would take every issued version with it — the rebuild would destroy the frozen
 * documents it was not asked to touch. The pragma is a no-op inside a
 * transaction, so it is set here, outside one, and `foreign_key_check` below
 * proves nothing was left dangling.
 */
exec('PRAGMA foreign_keys = OFF');

tx(() => {
    if (needsRebuild.proposals) {
        run(`CREATE TABLE proposals_new (
                id               TEXT PRIMARY KEY,
                workspace_id     TEXT NOT NULL REFERENCES workspaces(id),
                deal_id          TEXT REFERENCES deals(id),
                account_id       TEXT NOT NULL REFERENCES accounts(id),
                document_type    TEXT,
                document_id      TEXT REFERENCES documents(id),
                number           TEXT NOT NULL,
                title            TEXT NOT NULL,
                currency         TEXT NOT NULL DEFAULT 'USD',
                status           TEXT NOT NULL DEFAULT 'draft',
                current_version  INTEGER NOT NULL DEFAULT 0,
                owner_id         TEXT REFERENCES users(id),
                created_at       TEXT NOT NULL,
                updated_at       TEXT NOT NULL,
                deleted_at       TEXT
            )`);
        run(`INSERT INTO proposals_new
                 (id, workspace_id, deal_id, account_id, document_type, document_id, number, title,
                  currency, status, current_version, owner_id, created_at, updated_at, deleted_at)
             SELECT id, workspace_id, deal_id, account_id, document_type, document_id, number, title,
                    currency, status, current_version, owner_id, created_at, updated_at, deleted_at
               FROM proposals`);
        run('DROP TABLE proposals');
        run('ALTER TABLE proposals_new RENAME TO proposals');
        run('CREATE INDEX IF NOT EXISTS idx_proposals_deal ON proposals(deal_id)');
    }

    if (needsRebuild.agreements) {
        run(`CREATE TABLE agreements_new (
                id                      TEXT PRIMARY KEY,
                workspace_id            TEXT NOT NULL REFERENCES workspaces(id),
                deal_id                 TEXT REFERENCES deals(id),
                account_id              TEXT NOT NULL REFERENCES accounts(id),
                document_type           TEXT,
                document_id             TEXT REFERENCES documents(id),
                number                  TEXT NOT NULL,
                title                   TEXT NOT NULL,
                type                    TEXT NOT NULL DEFAULT 'sow',
                status                  TEXT NOT NULL DEFAULT 'draft',
                signed_at               TEXT,
                effective_date          TEXT,
                expiry_date             TEXT,
                notice_days             INTEGER NOT NULL DEFAULT 0,
                auto_renew              INTEGER NOT NULL DEFAULT 0,
                supersedes_agreement_id TEXT REFERENCES agreements(id),
                created_at              TEXT NOT NULL,
                updated_at              TEXT NOT NULL,
                deleted_at              TEXT
            )`);
        run(`INSERT INTO agreements_new
                 (id, workspace_id, deal_id, account_id, document_type, document_id, number, title,
                  type, status, signed_at, effective_date, expiry_date, notice_days, auto_renew,
                  supersedes_agreement_id, created_at, updated_at, deleted_at)
             SELECT id, workspace_id, deal_id, account_id, document_type, document_id, number, title,
                    type, status, signed_at, effective_date, expiry_date, notice_days, auto_renew,
                    supersedes_agreement_id, created_at, updated_at, deleted_at
               FROM agreements`);
        run('DROP TABLE agreements');
        run('ALTER TABLE agreements_new RENAME TO agreements');
        run('CREATE INDEX IF NOT EXISTS idx_agreements_deal ON agreements(deal_id)');
    }

    // The partial unique indexes live in lib/db.mjs so a fresh boot creates
    // them too; recreated here because the rebuild dropped them with the table.
    run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_document
            ON proposals(document_id) WHERE document_id IS NOT NULL AND deleted_at IS NULL`);
    run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agreements_document
            ON agreements(document_id) WHERE document_id IS NOT NULL AND deleted_at IS NULL`);

    // Numbering continues from what each workspace already has, so a backfilled
    // record never collides with a number somebody has already quoted.
    const counters = new Map();
    const nextNumber = (workspaceId, table, prefix) => {
        const key = `${workspaceId}:${table}`;
        if (!counters.has(key)) {
            counters.set(key, get(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`, [workspaceId]).n);
        }
        const n = counters.get(key) + 1;
        counters.set(key, n);
        return `${prefix}-${String(now()).slice(0, 4)}-${String(n).padStart(4, '0')}`;
    };
    const dateField = (value) => {
        const text = String(value ?? '').trim();
        return text ? text.slice(0, 10) : null;
    };

    for (const row of backfill) {
        const agreement = row.table === 'agreements';
        const fields = json(row.fields, {});
        const recordId = id(agreement ? 'agr' : 'pro');
        insert(row.table, {
            id: recordId,
            workspace_id: row.workspace_id,
            account_id: row.account_id,
            deal_id: row.deal_id ?? null,
            document_type: row.document_type,
            document_id: row.document_id,
            number: nextNumber(row.workspace_id, row.table, agreement ? 'A' : 'P'),
            title: `${row.docType.label} v${row.version} — ${row.account_name}`,
            status: agreement ? 'draft' : 'issued',
            ...(agreement
                ? {
                    type: 'msa',
                    effective_date: dateField(fields.start_date),
                    expiry_date: dateField(fields.end_date),
                }
                : {
                    current_version: row.version,
                    currency: String(fields.currency ?? '').trim() || 'USD',
                    owner_id: row.generated_by ?? null,
                }),
            // A deleted account's documents stay with it. Creating these live
            // would resurrect proposals into a list they were never in — the
            // account was deleted, and so was everything hanging off it.
            deleted_at: row.account_deleted_at ?? null,
            // The record is as old as the document it stands for.
            created_at: row.created_at,
            updated_at: row.created_at,
        });
        // `reindex` drops a deleted row from the search index by itself, so a
        // record for a deleted account is never searchable.
        reindex(agreement ? 'agreement' : 'proposal', row.workspace_id, recordId);
    }

    // Repair, for a database an earlier run of this script left with live
    // records on deleted accounts.
    for (const [table, objectKey] of [['proposals', 'proposal'], ['agreements', 'agreement']]) {
        for (const row of strays(table)) {
            run(`UPDATE ${table} SET deleted_at = ? WHERE id = ?`, [row.account_deleted_at, row.id]);
            // The row is deleted now, and `reindex` drops a deleted row rather
            // than indexing it — without this it stays findable in search.
            reindex(objectKey, row.workspace_id, row.id);
        }
    }

    // Only the newest proposal of each type on an account is still the live one.
    // Done in one pass at the end rather than per row, so it also tidies any
    // record a previous run of this script left marked issued.
    const superseded = run(
        `UPDATE proposals SET status = 'superseded', updated_at = ?
          WHERE document_type IS NOT NULL AND status = 'issued' AND deleted_at IS NULL
            AND current_version < (
                SELECT MAX(p2.current_version) FROM proposals p2
                 WHERE p2.workspace_id = proposals.workspace_id
                   AND p2.account_id = proposals.account_id
                   AND p2.document_type = proposals.document_type
                   AND p2.deleted_at IS NULL)`,
        [now()],
    );
    if (superseded.changes) console.log(`\n${superseded.changes} earlier proposal(s) marked superseded.`);
});

exec('PRAGMA foreign_keys = ON');

const dangling = all('PRAGMA foreign_key_check');
if (dangling.length) {
    console.error(`\n⚠ ${dangling.length} dangling foreign key reference(s) after the rebuild:`);
    console.error(dangling.slice(0, 10));
    close();
    process.exit(1);
}

console.log(`\nApplied. ${backfill.length} record(s) created.`);
close();
