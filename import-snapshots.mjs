/**
 * Brings the collected companies into the CRM.
 *
 *   node import-snapshots.mjs
 *   node import-snapshots.mjs --file "../local-scraper/snapshots.json"
 *   node import-snapshots.mjs --csv "../local-scraper/Marketing Enriched.csv"
 *   node import-snapshots.mjs --dry-run
 *
 * `snapshots.json` is the most expensive asset in this project — 223 companies
 * of collected LinkedIn evidence, gathered a page at a time at 4-9 seconds each.
 * This script READS it and never writes to it.
 *
 * What each snapshot becomes:
 *
 *   the raw panels   -> a PROSPECTING EVIDENCE SNAPSHOT, stored verbatim and immutable
 *   the company      -> a PROSPECTING COMPANY record, held in the prospecting pool
 *   each rule's call -> a VERDICT attached to the prospect, appended and versioned
 *
 * Evidence and conclusion stay separate (invariant I1), which is what makes
 * re-qualifying all 223 under a changed rule a free, offline, seconds-long
 * operation instead of a re-collection.
 *
 * Re-running is safe: prospects match on LinkedIn slug, and a snapshot whose
 * `collectedAt` is already on file is skipped rather than duplicated.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrate, get, run, all, id, now, close } from './lib/db.mjs';
import { SNAPSHOTS_FILE, QUALIFIER_LIB, qualifyProspect, loadEngines } from './lib/qualification.mjs';
import { reindex } from './lib/repo.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const DRY = args.includes('--dry-run');
const FILE = arg('file', SNAPSHOTS_FILE);
const CSV = arg('csv', null);

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
const ctx = { workspaceId: workspace.id, userId: admin.id, role: 'owner', workspace: { baseCurrency: workspace.base_currency } };

if (!fs.existsSync(FILE)) {
    console.error(`  No snapshot file at ${FILE}`);
    console.error('  Point at it with --file, or set QUALIFIER_SNAPSHOTS.');
    process.exit(1);
}

const snapshots = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const entries = Object.values(snapshots);
console.log(`\n  Reading ${entries.length} collected companies from ${FILE}`);
if (DRY) console.log('  DRY RUN — nothing will be written.\n');

await loadEngines();

/* -------------------------------------------- optional CSV enrichment pass -- */

/**
 * A lead list carries columns LinkedIn's panels do not: website, phone,
 * industry as the vendor recorded it, the person's name and email. When one is
 * supplied, its rows are matched to companies by slug so contacts come across
 * with their account rather than being typed in later.
 */
let csvBySlug = new Map();
if (CSV) {
    // The qualifier's own CSV parser, not a second one. It round-trips
    // duplicate headers, blank headers, Arabic, embedded newlines, doubled
    // quotes and BOMs — all of which this project has already hit in real files.
    const { parseTable, normalizeCompanySlug, detectCompanyColumn } =
        await import(pathToFileURL(path.join(QUALIFIER_LIB, 'csv.mjs')).href);

    const text = fs.readFileSync(CSV, 'utf8');
    const { header, rows } = parseTable(text);
    const col = detectCompanyColumn(header, rows).index;
    if (col < 0) {
        console.log('  The CSV has no LinkedIn company-URL column; skipping enrichment.');
    } else {
        for (const row of rows) {
            const slug = normalizeCompanySlug(row[col]);
            if (!slug) continue;
            if (!csvBySlug.has(slug)) csvBySlug.set(slug, []);
            csvBySlug.get(slug).push(Object.fromEntries(header.map((h, i) => [h, row[i] ?? ''])));
        }
        console.log(`  Enriching from ${CSV} (${rows.length} rows, ${csvBySlug.size} companies).`);
    }
}

/* ---------------------------------------------------------------- import -- */

const stats = {
    prospectsCreated: 0, prospectsUpdated: 0, evidenceAdded: 0, evidenceSkipped: 0,
    contactsCreated: 0, errors: 0,
};

for (const entry of entries) {
    const slug = entry.slug;
    if (!slug) continue;

    const name = entry.companyName || slug;
    const csvRows = csvBySlug.get(slug) ?? [];
    const first = csvRows[0] ?? {};

    let prospect = get('SELECT * FROM prospecting_companies WHERE workspace_id = ? AND linkedin_slug = ?', [workspace.id, slug]);

    if (!prospect) {
        if (!DRY) {
            const prospectId = id('acc');
            run(
                // 19 columns, 19 placeholders. Counted, not eyeballed: the
                // previous line had 18 and failed on the first company that was
                // not already in the database, which is why it survived every
                // re-run over an already-imported snapshot.
                `INSERT INTO prospecting_companies
                   (id, workspace_id, name, domain, website, linkedin_slug, industry, country, city,
                    employee_count, description, status, owner_id, source, external_id,
                    properties, created_by, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [
                    prospectId, workspace.id, name,
                    pick(first, ['Website', 'website', 'Domain', 'domain']) || domainFrom(entry.about?.website),
                    entry.about?.website ?? null,
                    slug,
                    entry.about?.industry ?? pick(first, ['Industry', 'industry']) ?? null,
                    countryFrom(entry) ?? pick(first, ['Country', 'country']) ?? null,
                    pick(first, ['City', 'city']) ?? null,
                    Number.isFinite(entry.totalMembers) ? entry.totalMembers : null,
                    (entry.about?.description ?? '').slice(0, 2000) || null,
                    'uploaded',
                    admin.id, 'linkedin-import',
                    `linkedin:${slug}`,
                    '{}', admin.id, now(), now(),
                ],
            );
            prospect = get('SELECT * FROM prospecting_companies WHERE id = ?', [prospectId]);
            reindex('prospecting_company', workspace.id, prospectId);
        }
        stats.prospectsCreated += 1;
    } else {
        if (!DRY && Number.isFinite(entry.totalMembers) && prospect.employee_count !== entry.totalMembers) {
            run('UPDATE prospecting_companies SET employee_count = ?, updated_at = ? WHERE id = ?',
                [entry.totalMembers, now(), prospect.id]);
        }
        stats.prospectsUpdated += 1;
    }

    if (DRY || !prospect) continue;

    /* --- evidence ---------------------------------------------------------- */

    const collectedAt = entry.collectedAt ?? now();
    const already = get(
        'SELECT id FROM prospecting_evidence_snapshots WHERE prospect_id = ? AND provider = ? AND collected_at = ?',
        [prospect.id, 'local-browser', collectedAt],
    );

    let evidenceId = already?.id ?? null;
    if (!already) {
        evidenceId = id('evd');
        run(
            `INSERT INTO prospecting_evidence_snapshots
               (id, workspace_id, subject_type, subject_key, prospect_id, provider, collected_at, payload, error, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [
                evidenceId, workspace.id, 'prospect', slug, prospect.id, 'local-browser', collectedAt,
                JSON.stringify(entry),
                entry.error ?? null, now(),
            ],
        );
        stats.evidenceAdded += 1;
    } else {
        stats.evidenceSkipped += 1;
    }

    /* --- contacts from the lead list --------------------------------------- */

    for (const row of csvRows) {
        const email = pick(row, ['Email', 'email', 'Work Email', 'work_email']);
        const fullName = pick(row, ['Full Name', 'Name', 'full_name', 'name']);
        const firstName = pick(row, ['First Name', 'first_name']) ?? (fullName ? fullName.split(' ')[0] : null);
        const lastName = pick(row, ['Last Name', 'last_name']) ?? (fullName ? fullName.split(' ').slice(1).join(' ') : null);
        if (!email && !firstName) continue;

        const exists = email
            ? get('SELECT id FROM prospecting_contacts WHERE workspace_id = ? AND email = ?', [workspace.id, email.toLowerCase()])
            : get('SELECT id FROM prospecting_contacts WHERE workspace_id = ? AND prospect_id = ? AND first_name = ? AND last_name = ?',
                [workspace.id, prospect.id, firstName ?? '', lastName ?? '']);
        if (exists) continue;

        const contactId = id('con');
        // 24 columns; is_active is the literal 1, so 23 bound values follow.
        run(
            `INSERT INTO prospecting_contacts
               (id, workspace_id, prospect_id, first_name, last_name, title, email, phone, linkedin_url,
                roles, is_active, service_line_key, campaign_id, data_source, acquired_at, lawful_basis, email_verified,
                verification_status, owner_id, external_id, properties, created_by, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
                contactId, workspace.id, prospect.id,
                firstName ?? '', lastName ?? '',
                pick(row, ['Title', 'Job Title', 'title', 'position']) ?? null,
                email ? email.toLowerCase() : null,
                pick(row, ['Phone', 'phone', 'Mobile']) ?? null,
                pick(row, ['LinkedIn', 'Profile', 'linkedin', 'Person Linkedin Url']) ?? null,
                '[]',
                pick(row, ['Service', 'service', 'service_line_key']) ?? null,
                pick(row, ['Campaign', 'campaign', 'campaign_id']) ?? null,
                `imported:${path.basename(CSV ?? 'lead-list')}`,
                new Date().toISOString().slice(0, 10),
                'legitimate_interest',
                0,
                null,
                admin.id, email ? `email:${email.toLowerCase()}` : null,
                '{}', admin.id, now(), now(),
            ],
        );
        reindex('prospecting_contact', workspace.id, contactId);
        stats.contactsCreated += 1;
    }
}

/* -------------------------------------------------------------- qualify -- */

if (!DRY) {
    console.log('\n  Applying the rules…');
    const prospects = all(
        'SELECT id FROM prospecting_companies WHERE workspace_id = ? AND linkedin_slug IS NOT NULL AND deleted_at IS NULL',
        [workspace.id],
    );
    const tally = {
        hcm: { QUALIFIED: 0, REVIEW: 0, REJECTED: 0, UNRESOLVED: 0, ERROR: 0 },
        offshoring: { QUALIFIED: 0, REVIEW: 0, REJECTED: 0, UNRESOLVED: 0, ERROR: 0 },
    };

    for (const prospect of prospects) {
        for (const rule of ['hcm', 'offshoring']) {
            try {
                const out = await qualifyProspect(ctx, prospect.id, rule, { source: 'import' });
                tally[rule][out.verdict] += 1;
            } catch (err) {
                stats.errors += 1;
                console.error(`    ${prospect.id} / ${rule}: ${err.message}`);
            }
        }
    }

    console.log('');
    for (const [rule, counts] of Object.entries(tally)) {
        console.log(
            `  ${rule.padEnd(11)}QUALIFIED ${String(counts.QUALIFIED).padStart(3)}   `
            + `REVIEW ${String(counts.REVIEW).padStart(3)}   `
            + `REJECTED ${String(counts.REJECTED).padStart(3)}   `
            + `ERROR ${counts.ERROR}`,
        );
    }
    console.log('\n  REVIEW is not a soft REJECTED — it means the panels could not answer.');
    console.log('  Those rows are a queue to work, not a bin. Each one has its own view.');
}

console.log('');
console.log(`  prospects created   ${stats.prospectsCreated}`);
console.log(`  prospects matched   ${stats.prospectsUpdated}`);
console.log(`  evidence stored    ${stats.evidenceAdded}  (${stats.evidenceSkipped} already on file)`);
if (CSV) console.log(`  contacts created   ${stats.contactsCreated}`);
if (stats.errors) console.log(`  errors             ${stats.errors}`);
console.log('');
console.log('  Everything imported into Prospecting. A QUALIFIED verdict is now a signal for review and import, not an automatic CRM account.');
console.log('  Start the CRM:  npm start\n');

close();

/* --------------------------------------------------------------- helpers -- */

function pick(row, keys) {
    for (const key of keys) {
        const value = row[key];
        if (value !== undefined && String(value).trim() !== '') return String(value).trim();
    }
    return null;
}

function domainFrom(website) {
    if (!website) return null;
    try {
        return new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.replace(/^www\./, '');
    } catch {
        return null;
    }
}

/**
 * The company's own country, taken from the largest COUNTRY-level location row.
 *
 * City rows are subsets of their country and must never be treated as one:
 * "Cairo, Egypt" is a city, "Egypt" is a country. Getting that wrong is a bug
 * this project has already paid for once.
 */
function countryFrom(entry) {
    const rows = entry.locations ?? [];
    let best = null;
    for (const row of rows) {
        const label = String(row.label ?? '').replace(/\s*toggle (on|off)\s*/gi, '').trim();
        if (!label || label.includes(',')) continue;
        const count = Number(row.count) || 0;
        if (!best || count > best.count) best = { label, count };
    }
    return best?.label ?? null;
}
