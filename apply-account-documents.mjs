/**
 * Moves document generation off the Deal and onto the Account.
 *
 *   node apply-account-documents.mjs            # show what would change
 *   node apply-account-documents.mjs --apply    # write it
 *
 * ── WHY THIS IS A WRITTEN MIGRATION AND NOT AN AUTOMATIC ONE ────────────────
 *
 * `lib/db.mjs` applies additive column migrations on every boot, deliberately
 * limited to adding columns. This changes two constraints — `deal_id` stops
 * being NOT NULL, and version uniqueness moves from the deal to the account —
 * and SQLite can only do that by rebuilding the table. Anything that rebuilds a
 * table runs when a human asks it to, with a backup taken first, not silently at
 * startup.
 *
 * ── WHAT IT DOES ────────────────────────────────────────────────────────────
 *
 * `hcm_service_selections`  keyed by (workspace, account, deal_id) where an
 *                           empty deal_id is the ACCOUNT'S own scope selection.
 *                           Existing per-deal rows keep their deal_id and gain
 *                           the account it belongs to, so no selection is lost.
 *
 * `document_generations`    `account_id` first and required, `deal_id` optional,
 *                           and UNIQUE(account, type, version) instead of
 *                           UNIQUE(deal, type, version).
 *
 * Version numbers are RENUMBERED per (account, document type) in creation
 * order, because the new uniqueness constraint is per account: two deals on one
 * account could each hold a "v1" under the old rule. Renumbering preserves the
 * order documents were issued in, which is the thing a version number means.
 * Every generation keeps its own frozen `fields`/`placeholders`, so no issued
 * document's CONTENT is touched by any of this.
 */
import { migrate, get, all, run, exec, tx, close } from './lib/db.mjs';

const APPLY = process.argv.includes('--apply');

migrate();

/** Column names of a table, or null when the table does not exist. */
function columns(table) {
    const rows = all(`PRAGMA table_info(${table})`);
    return rows.length ? rows.map((r) => r.name) : null;
}

const selectionColumns = columns('hcm_service_selections');
const generationColumns = columns('document_generations');

const plan = [];
const selectionsNeedWork = selectionColumns && !selectionColumns.includes('account_id');
const generationsNeedWork = generationColumns
    && !all("SELECT sql FROM sqlite_master WHERE type='table' AND name='document_generations'")[0]
        ?.sql?.includes('UNIQUE (account_id, document_type, version)');

if (selectionsNeedWork) {
    const n = get('SELECT COUNT(*) AS c FROM hcm_service_selections').c;
    plan.push(`hcm_service_selections: rebuild account-scoped, carrying ${n} existing selection(s)`);
}
if (generationsNeedWork) {
    const n = get('SELECT COUNT(*) AS c FROM document_generations').c;
    const orphans = get(
        `SELECT COUNT(*) AS c FROM document_generations g
          LEFT JOIN accounts a ON a.id = g.account_id WHERE a.id IS NULL`,
    ).c;
    plan.push(`document_generations: rebuild account-scoped, carrying ${n} generation(s)`);
    if (orphans) plan.push(`  ⚠ ${orphans} generation(s) point at an account that no longer exists`);
}

if (!plan.length) {
    console.log('Already account-scoped. Nothing to do.');
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
 * `document_events.generation_id` is declared ON DELETE CASCADE. With foreign
 * keys enforced, DROP TABLE document_generations would cascade every open and
 * download event into oblivion — the table rebuild would quietly destroy the
 * engagement history it was not asked to touch. The pragma is a no-op inside a
 * transaction, so it is set here, outside one, and `foreign_key_check` below
 * proves nothing was left dangling.
 */
exec('PRAGMA foreign_keys = OFF');

tx(() => {
    if (selectionsNeedWork) {
        run(`CREATE TABLE hcm_service_selections_new (
                workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
                account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                deal_id       TEXT NOT NULL DEFAULT '',
                services      TEXT NOT NULL DEFAULT '[]',
                updated_at    TEXT NOT NULL,
                updated_by    TEXT REFERENCES users(id),
                PRIMARY KEY (workspace_id, account_id, deal_id)
            )`);
        // A selection whose deal has been hard-deleted has no account to hang
        // off and no deal to describe, so it is dropped rather than guessed at.
        run(`INSERT INTO hcm_service_selections_new
                 (workspace_id, account_id, deal_id, services, updated_at, updated_by)
             SELECT s.workspace_id, d.account_id, s.deal_id, s.services, s.updated_at, s.updated_by
               FROM hcm_service_selections s
               JOIN deals d ON d.id = s.deal_id`);
        run('DROP TABLE hcm_service_selections');
        run('ALTER TABLE hcm_service_selections_new RENAME TO hcm_service_selections');
    }

    if (generationsNeedWork) {
        run(`CREATE TABLE document_generations_new (
                id             TEXT PRIMARY KEY,
                workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
                account_id     TEXT NOT NULL REFERENCES accounts(id),
                deal_id        TEXT REFERENCES deals(id) ON DELETE SET NULL,
                contact_id     TEXT REFERENCES contacts(id),
                document_type  TEXT NOT NULL,
                version        INTEGER NOT NULL,
                document_id    TEXT REFERENCES documents(id),
                template_id    TEXT REFERENCES document_templates(id),
                template_checksum TEXT,
                fields         TEXT NOT NULL DEFAULT '{}',
                placeholders   TEXT NOT NULL DEFAULT '{}',
                services       TEXT NOT NULL DEFAULT '[]',
                status         TEXT NOT NULL DEFAULT 'generated',
                error          TEXT,
                generated_by   TEXT REFERENCES users(id),
                created_at     TEXT NOT NULL,
                UNIQUE (account_id, document_type, version)
            )`);
        // ROW_NUMBER over (account, type) in creation order is the renumbering
        // described in the header: order preserved, collisions removed.
        run(`INSERT INTO document_generations_new
                 (id, workspace_id, account_id, deal_id, contact_id, document_type, version,
                  document_id, template_id, template_checksum, fields, placeholders, services,
                  status, error, generated_by, created_at)
             SELECT id, workspace_id, account_id, deal_id, contact_id, document_type,
                    ROW_NUMBER() OVER (PARTITION BY account_id, document_type ORDER BY created_at, id),
                    document_id, template_id, template_checksum, fields, placeholders, services,
                    status, error, generated_by, created_at
               FROM document_generations`);
        run('DROP TABLE document_generations');
        run('ALTER TABLE document_generations_new RENAME TO document_generations');
        run('CREATE INDEX IF NOT EXISTS idx_doc_generations_deal ON document_generations(deal_id, created_at DESC)');
        run('CREATE INDEX IF NOT EXISTS idx_doc_generations_account ON document_generations(account_id, created_at DESC)');
    }
});

exec('PRAGMA foreign_keys = ON');

const dangling = all('PRAGMA foreign_key_check');
if (dangling.length) {
    console.error(`\n⚠ ${dangling.length} dangling foreign key reference(s) after the rebuild:`);
    console.error(dangling.slice(0, 10));
    close();
    process.exit(1);
}

console.log('\nApplied.');
close();
