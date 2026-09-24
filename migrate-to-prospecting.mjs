/**
 * Moves the pre-separation companies out of the CRM and into Prospecting.
 *
 *   node migrate-to-prospecting.mjs              dry run: say what would move
 *   node migrate-to-prospecting.mjs --confirm    do it, after copying the database
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * The Prospecting/CRM separation landed as schema, registry, API routes and a
 * rewritten import script — but nothing ever moved the DATA. 223 companies and
 * their 448 verdicts stayed in `accounts` / `verdicts`, which is the plane the
 * new module does not read. The Prospecting page was therefore empty and
 * correct at the same time, which is the worst kind of bug to look at.
 *
 * This is the missing half of that refactor. Every uploaded company becomes a
 * PROSPECT; the CRM is left holding only what someone deliberately imports.
 *
 * ── WHAT MOVES, AND WHAT IS PRESERVED ───────────────────────────────────────
 *
 *   accounts                       -> prospecting_companies
 *   evidence_snapshots             -> prospecting_evidence_snapshots
 *   verdicts (FULL history)        -> prospecting_verdicts
 *   contacts                       -> prospecting_contacts
 *   notes / documents on those accounts are RE-PARENTED, never dropped
 *
 * The verdict history moves intact — every superseded row, its rule_version,
 * its computed_at, and whether it was an engine run or a human decision. A
 * migration that kept only the current verdict would quietly answer "why did
 * this change?" with "it didn't", which is the exact failure the evidence plane
 * was designed to prevent.
 *
 * `evidence_id` pointers are REMAPPED as the snapshots move, so a migrated
 * verdict still names the observation it was computed from.
 *
 * Original `created_at` is carried over, so "uploaded on" stays truthful.
 *
 * Idempotent: a company already in Prospecting (matched on LinkedIn slug) is
 * matched rather than duplicated, so a half-finished run can simply be re-run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { migrate, all, get, run, tx, id, now, close, DB_FILE } from './lib/db.mjs';
import { reindex } from './lib/repo.mjs';
import { recomputeStatus } from './lib/qualification.mjs';

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');

migrate();

const workspace = get('SELECT * FROM workspaces LIMIT 1');
if (!workspace) {
    console.error('  No workspace yet. Run:  node setup.mjs');
    process.exit(1);
}
const admin = get(
    `SELECT u.* FROM users u JOIN memberships m ON m.user_id = u.id
      WHERE m.workspace_id = ? ORDER BY m.created_at LIMIT 1`,
    [workspace.id],
);
const ctx = {
    workspaceId: workspace.id,
    userId: admin.id,
    role: 'owner',
    workspace: { baseCurrency: workspace.base_currency },
};

/**
 * Which accounts are actually uploaded prospects rather than real CRM accounts.
 *
 * Scoped to the collector's own source so that an account someone typed in by
 * hand is never swept into Prospecting by a migration script. Everything in
 * this database arrived from the LinkedIn import, but that is a fact about
 * today, not a licence to move rows on a wildcard.
 */
const accounts = all(
    `SELECT * FROM accounts
      WHERE workspace_id = ? AND deleted_at IS NULL AND source = 'linkedin-import'
      ORDER BY created_at`,
    [workspace.id],
);

const counts = {
    prospectsCreated: 0, prospectsMatched: 0,
    evidence: 0, verdicts: 0, contacts: 0, notes: 0, documents: 0,
    accountsRemoved: 0, skipped: 0,
};

console.log('');
console.log(`  ${accounts.length} account(s) look like uploaded prospects.`);
if (!CONFIRM) console.log('  DRY RUN — nothing will be written. Add --confirm to apply.');
console.log('');

if (!accounts.length) {
    console.log('  Nothing to move.\n');
    close();
    process.exit(0);
}

/* ------------------------------------------------------------------ backup -- */

if (CONFIRM) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${DB_FILE}.before-prospecting-migration-${stamp}`;
    // Checkpoint first: with WAL on, copying the .db alone can leave recent
    // writes behind in the -wal file and produce a backup that is quietly stale.
    run('PRAGMA wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(DB_FILE, backup);
    console.log(`  Database copied to  ${path.basename(backup)}`);
    console.log('');
}

/* ----------------------------------------------------------------- migrate -- */

for (const account of accounts) {
    const slug = account.linkedin_slug;
    if (!slug) {
        // Without a slug there is no identity to match on and no way for the
        // qualifier to ever evaluate it. Left alone rather than guessed at.
        counts.skipped += 1;
        console.log(`  ~ ${account.name} — no LinkedIn slug, left in the CRM.`);
        continue;
    }

    if (!CONFIRM) {
        const existing = get(
            'SELECT id FROM prospecting_companies WHERE workspace_id = ? AND linkedin_slug = ?',
            [workspace.id, slug],
        );
        if (existing) counts.prospectsMatched += 1;
        else counts.prospectsCreated += 1;
        counts.evidence += get('SELECT COUNT(*) c FROM evidence_snapshots WHERE account_id = ?', [account.id]).c;
        counts.verdicts += get('SELECT COUNT(*) c FROM verdicts WHERE account_id = ?', [account.id]).c;
        counts.contacts += get('SELECT COUNT(*) c FROM contacts WHERE account_id = ? AND deleted_at IS NULL', [account.id]).c;
        counts.notes += get('SELECT COUNT(*) c FROM notes WHERE parent_type = ? AND parent_id = ?', ['account', account.id]).c;
        counts.documents += get('SELECT COUNT(*) c FROM documents WHERE parent_type = ? AND parent_id = ?', ['account', account.id]).c;
        counts.accountsRemoved += 1;
        continue;
    }

    tx(() => {
        let prospect = get(
            'SELECT * FROM prospecting_companies WHERE workspace_id = ? AND linkedin_slug = ?',
            [workspace.id, slug],
        );

        if (!prospect) {
            const prospectId = id('pro');
            run(
                `INSERT INTO prospecting_companies
                   (id, workspace_id, name, domain, website, linkedin_slug, industry, country, city,
                    employee_count, phone, description, status, owner_id, campaign_id, source, external_id,
                    properties, created_by, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [
                    prospectId, workspace.id, account.name, account.domain, account.website, slug,
                    account.industry, account.country, account.city, account.employee_count,
                    account.phone, account.description,
                    // Left as `uploaded`; recomputeStatus() below derives the real
                    // value from the verdicts once they have been moved across.
                    'uploaded',
                    account.owner_id, account.campaign_id, account.source, account.external_id,
                    account.properties ?? '{}', account.created_by,
                    account.created_at, now(),
                ],
            );
            prospect = get('SELECT * FROM prospecting_companies WHERE id = ?', [prospectId]);
            counts.prospectsCreated += 1;
        } else {
            counts.prospectsMatched += 1;
        }

        /* --- evidence, remembering the id map for the verdicts below -------- */

        const evidenceMap = new Map();
        for (const snap of all('SELECT * FROM evidence_snapshots WHERE account_id = ? ORDER BY collected_at', [account.id])) {
            const already = get(
                'SELECT id FROM prospecting_evidence_snapshots WHERE prospect_id = ? AND provider = ? AND collected_at = ?',
                [prospect.id, snap.provider, snap.collected_at],
            );
            if (already) { evidenceMap.set(snap.id, already.id); continue; }

            const newId = id('evd');
            run(
                `INSERT INTO prospecting_evidence_snapshots
                   (id, workspace_id, subject_type, subject_key, prospect_id, provider, collected_at, payload, error, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`,
                [
                    newId, workspace.id, 'prospect', snap.subject_key ?? slug, prospect.id,
                    snap.provider, snap.collected_at, snap.payload, snap.error, snap.created_at,
                ],
            );
            evidenceMap.set(snap.id, newId);
            counts.evidence += 1;
        }

        /* --- verdicts, the WHOLE history ------------------------------------ */

        for (const v of all('SELECT * FROM verdicts WHERE account_id = ? ORDER BY computed_at', [account.id])) {
            const already = get(
                'SELECT id FROM prospecting_verdicts WHERE prospect_id = ? AND rule_key = ? AND computed_at = ?',
                [prospect.id, v.rule_key, v.computed_at],
            );
            if (already) continue;

            run(
                `INSERT INTO prospecting_verdicts
                   (id, workspace_id, prospect_id, subject_type, subject_key, rule_key, rule_version, evidence_id,
                    verdict, confidence, metrics, reasons, notes, source, decided_by, decision_note,
                    computed_at, is_current, superseded_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [
                    id('vdt'), workspace.id, prospect.id, 'prospect', v.subject_key ?? slug,
                    v.rule_key, v.rule_version,
                    // Remapped, not copied: the old id points into a table this
                    // verdict no longer lives beside.
                    evidenceMap.get(v.evidence_id) ?? null,
                    v.verdict, v.confidence, v.metrics, v.reasons, v.notes,
                    v.source ?? 'engine', v.decided_by, v.decision_note,
                    v.computed_at, v.is_current, v.superseded_at,
                ],
            );
            counts.verdicts += 1;
        }

        /* --- contacts -------------------------------------------------------- */

        for (const c of all('SELECT * FROM contacts WHERE account_id = ? AND deleted_at IS NULL', [account.id])) {
            const already = c.email
                ? get('SELECT id FROM prospecting_contacts WHERE workspace_id = ? AND email = ?', [workspace.id, c.email])
                : get(
                    'SELECT id FROM prospecting_contacts WHERE workspace_id = ? AND prospect_id = ? AND first_name = ? AND last_name = ?',
                    [workspace.id, prospect.id, c.first_name ?? '', c.last_name ?? ''],
                );
            if (already) continue;

            const contactId = id('pct');
            run(
                `INSERT INTO prospecting_contacts
                   (id, workspace_id, prospect_id, first_name, last_name, title, email, phone, linkedin_url,
                    roles, is_active, service_line_key, campaign_id, data_source, acquired_at, lawful_basis,
                    email_verified, verification_status, owner_id, external_id, properties,
                    created_by, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [
                    contactId, workspace.id, prospect.id,
                    c.first_name ?? '', c.last_name ?? '', c.title, c.email, c.phone, c.linkedin_url,
                    c.roles ?? '[]', c.is_active ?? 1, c.service_line_key, c.campaign_id,
                    // data_source is NOT NULL-able in spirit: personal data has to
                    // say where it came from. Migrated rows that never recorded one
                    // say so explicitly rather than inheriting a flattering guess.
                    c.data_source ?? 'migrated:pre-prospecting-crm',
                    c.acquired_at, c.lawful_basis,
                    0, null,
                    c.owner_id, c.external_id, c.properties ?? '{}',
                    c.created_by, c.created_at, now(),
                ],
            );
            run('DELETE FROM search_index WHERE record_id = ?', [c.id]);
            reindex('prospecting_contact', workspace.id, contactId);
            counts.contacts += 1;
        }

        /* --- notes and documents: re-parented, never dropped ----------------- */

        for (const table of ['notes', 'documents']) {
            const rows = all(`SELECT id FROM ${table} WHERE parent_type = ? AND parent_id = ?`, ['account', account.id]);
            for (const row of rows) {
                run(
                    `UPDATE ${table} SET parent_type = ?, parent_id = ?, account_id = NULL WHERE id = ?`,
                    ['prospecting_company', prospect.id, row.id],
                );
                counts[table] += 1;
            }
        }

        /* --- remove the CRM side -------------------------------------------- */

        run('DELETE FROM contacts WHERE account_id = ?', [account.id]);
        run('DELETE FROM verdicts WHERE account_id = ?', [account.id]);
        run('DELETE FROM evidence_snapshots WHERE account_id = ?', [account.id]);
        run('DELETE FROM search_index WHERE record_id = ?', [account.id]);
        run('DELETE FROM accounts WHERE id = ?', [account.id]);
        counts.accountsRemoved += 1;

        reindex('prospecting_company', workspace.id, prospect.id);
        recomputeStatus(ctx, prospect.id);
    });
}

/* ------------------------------------------------------------------ report -- */

console.log(`  prospects created    ${counts.prospectsCreated}`);
console.log(`  prospects matched    ${counts.prospectsMatched}`);
console.log(`  evidence moved       ${counts.evidence}`);
console.log(`  verdicts moved       ${counts.verdicts}   (full history, not just the current one)`);
console.log(`  contacts moved       ${counts.contacts}`);
if (counts.notes) console.log(`  notes re-parented    ${counts.notes}`);
if (counts.documents) console.log(`  documents re-parented ${counts.documents}`);
console.log(`  accounts removed     ${counts.accountsRemoved}`);
if (counts.skipped) console.log(`  left alone           ${counts.skipped}  (no LinkedIn slug)`);
console.log('');

if (CONFIRM) {
    const status = all(
        'SELECT status, COUNT(*) c FROM prospecting_companies WHERE workspace_id = ? GROUP BY status ORDER BY c DESC',
        [workspace.id],
    );
    console.log('  Prospecting now holds:');
    for (const row of status) console.log(`    ${String(row.c).padStart(5)}  ${row.status}`);
    console.log('');
    console.log('  The CRM holds only what gets imported from here — currently '
        + `${get('SELECT COUNT(*) c FROM accounts WHERE deleted_at IS NULL').c} account(s).`);
    console.log('');
    console.log('  Next:  node import-snapshots.mjs     brings in everything collected since,');
    console.log('                                       and re-runs the rules over stored evidence.');
} else {
    console.log('  Re-run with --confirm to apply. The database is copied first.');
}
console.log('');

close();
