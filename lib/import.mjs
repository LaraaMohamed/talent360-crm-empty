/**
 * The import engine.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
 * Getting data in without losing, duplicating or mangling it — and telling the
 * user exactly what will happen BEFORE it happens.
 * (`docs/08_MODULE_SPECIFICATIONS/06_IMPORT_ENGINE.md`.)
 *
 * ── THE FOUR THINGS THAT MUST NOT REGRESS ───────────────────────────────────
 *
 *  1. COLUMN DETECTION READS VALUES, NOT HEADERS. A column of
 *     `linkedin.com/company/…` is the company column whatever it is called, and
 *     a column of `linkedin.com/in/…` never is. Header text is a tie-break only.
 *     Users verify a mapping by recognising their data, so three sample values
 *     travel with every suggestion.
 *
 *  2. THE PARSER IS THE QUALIFIER'S. `lib/csv.mjs` re-exports it rather than
 *     reimplementing it: duplicate headers, blank headers, Arabic, embedded
 *     newlines, doubled quotes and a BOM built from its code point are all
 *     already handled there, and a second implementation would be a second set
 *     of those bugs. Rows stay ARRAYS — an object keyed by header silently
 *     drops a repeated column.
 *
 *  3. PREVIEW COUNTS ARE THE EXECUTION COUNTS. The preview runs the identical
 *     classification the execution does, over the same rows, in the same order.
 *     A preview that is merely similar to the run is worse than no preview,
 *     because it is trusted.
 *
 *  4. RE-UPLOADING THE SAME FILE IS A NO-OP. Idempotency on `external_id` plus
 *     the workspace's match rules. "Re-upload the corrected file" doubling the
 *     database is the single most common CRM data disaster.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 * It does not write records itself. Every row goes through `createRecord` /
 * `updateRecord`, so validation, audit events, the search index and the
 * permission checks are the same ones the API and the UI use. An importer with
 * its own write path is an importer that eventually writes something the rest
 * of the system considers impossible.
 */
import { all, get, run, id, now, json, tx } from './db.mjs';
import { fieldsFor, fieldMap, objectDef, OBJECTS, BILLING_CURRENCIES, ACCOUNT_TYPES } from './objects.mjs';
import { createRecord, updateRecord, deleteRecord, audit, validate, setDealPrice } from './repo.mjs';
import { csv } from './csv.mjs';
import { badRequest, notFound } from './http.mjs';

const MAX_ROWS = 100000;
const SAMPLE_SIZE = 3;

/**
 * Deal-size fields the importer understands but the registry does not carry.
 *
 * A deal's value is NOT a column on the deal — it is a price series written
 * through `setDealPrice`, which is why a CSV of existing customers imported
 * beautifully and forecast at $0. These five keys exist only inside the
 * import wizard: they map from the file, are stripped before validation (the
 * deals table has no such columns), and after each deal is written they go
 * through the same `setDealPrice` the Deal size dialog uses — so the price
 * period, the line-item projection, the rollups and the forecast all happen,
 * with `source: 'import'` meaning the value lands ACTIVE rather than as a
 * rep's proposal awaiting approval.
 */
const DEAL_SIZE_FIELDS = [
    { key: 'unit_price', label: 'Price per unit (deal size)', type: 'currency', importOnly: true },
    { key: 'headcount', label: 'Headcount / seats (deal size)', type: 'number', importOnly: true },
    { key: 'price_currency', label: 'Currency (deal size)', type: 'select', options: BILLING_CURRENCIES, importOnly: true },
    { key: 'term_months', label: 'Term months (recurring)', type: 'number', importOnly: true },
    { key: 'price_effective_from', label: 'Price effective from', type: 'date', importOnly: true },
];

/**
 * The account a deal belongs to, given as a NAME.
 *
 * A deal references accounts by id, but a spreadsheet of existing customers
 * names them. This import-only column resolves against the workspace's
 * accounts by name (or Arabic legal name); an unmatched name REJECTS the row
 * in both preview and execution with the fix stated — import the accounts
 * first. Silently creating companies mid-deal-import would fork the exact
 * duplicates merge exists to kill, and a preview that says "create" while
 * execution invents two accounts is the lie rule 3 forbids.
 */
const DEAL_ACCOUNT_FIELD = { key: 'deal_account_name', label: 'Account name', type: 'text', importOnly: true };

/**
 * The same problem, for a spreadsheet of people: a contact's `account_id`
 * is a reference, but a lead-gen export names the company, not its CRM row
 * id. Mapping a "Company" column straight to the raw reference field used
 * to write the company NAME into `account_id` and fail every such row with
 * a bare SQLite foreign-key error — no explanation, just "rejected". This
 * import-only column resolves by name like DEAL_ACCOUNT_FIELD, but unlike a
 * deal it CREATES the account when no match exists — a lead import is very
 * often the first time that company has ever entered the CRM — rather than
 * rejecting every row for it. `account_id` itself is excluded from the
 * mappable field list (see `importableFields`) so there is no wrong option
 * left to pick.
 */
const CONTACT_ACCOUNT_FIELD = { key: 'contact_account_name', label: 'Account name', type: 'text', importOnly: true };

/**
 * The company facts a contact-primary lead file often carries beside the
 * person — website, LinkedIn, industry, city, account type — same idea as
 * CONTACT_ACCOUNT_FIELD one column over. These only ever apply to an
 * account CREATED by this import (see the row loop): a contact list is not
 * license to overwrite firmographics on a company the CRM already knows,
 * only to give a brand-new one more than just a name.
 */
const ACCOUNT_FIELDS_FOR_CONTACT = [
    { key: 'account_website', label: 'Account website', column: 'website', type: 'url' },
    { key: 'account_linkedin', label: 'Account LinkedIn', column: 'linkedin_slug', type: 'text' },
    { key: 'account_industry', label: 'Account industry', column: 'industry', type: 'text' },
    { key: 'account_city', label: 'Account city', column: 'city', type: 'text' },
    { key: 'account_type', label: 'Account type', column: 'account_type', type: 'select', options: ACCOUNT_TYPES },
];

/**
 * Resolves an account by name (or Arabic legal name) for the by-name import
 * fields above. Shared so "how a name becomes an id" has one answer.
 */
function resolveAccountByName(workspaceId, name) {
    const wanted = String(name).trim();
    const account = get(
        `SELECT id FROM accounts
          WHERE workspace_id = ? AND deleted_at IS NULL
            AND (lower(name) = lower(?) OR lower(COALESCE(legal_name,'')) = lower(?))
          ORDER BY created_at LIMIT 1`,
        [workspaceId, wanted, wanted],
    );
    return { wanted, account };
}

/**
 * Turns the account auto-creation's failure into a row rejection, same as
 * every other reason a row does not go in.
 *
 * Creating the account for a brand-new company used to be the one write in
 * this whole function NOT wrapped in the per-row try/catch below — so a
 * database error there (most often two rows resolving to the same LinkedIn
 * slug, website or external ID because a column was mapped to the wrong
 * field) crashed the entire request with a 500 and took the rest of the
 * file down with it, rather than rejecting the one row responsible.
 *
 * The UNIQUE-constraint case is translated into English naming the actual
 * field, because "UNIQUE constraint failed: accounts.workspace_id,
 * accounts.linkedin_slug" is not a sentence anyone can act on, and the fix
 * — "check the column mapped to Account LinkedIn is the right one" — is
 * exactly what a mismapped column like this needs said out loud.
 */
function accountCreationFailureReason(err, workspaceId) {
    const unique = /UNIQUE constraint failed: accounts\.workspace_id, accounts\.(\w+)/.exec(err.message ?? '');
    if (unique) {
        const label = fieldMap('account', workspaceId).get(unique[1])?.label ?? unique[1];
        return `Another account already has this ${label} — check the column mapped to "Account ${label}" is the right one for this row.`;
    }
    return err.message;
}

/* ------------------------------------------------------------- profiling -- */

/**
 * Reads the file and describes it, without writing anything.
 *
 * The counts shown here are the ones the user commits against, so they are
 * computed from the actual parse, never estimated.
 */
export async function profile(text, objectKey, workspaceId) {
    const { parseTable } = await csv();
    const { header, rows } = parseTable(text);
    if (!header.length) return { header: [], rows: 0, columns: [], suggestions: {}, empty: true };
    if (rows.length > MAX_ROWS) {
        throw badRequest(`That file has ${rows.length} rows. The limit is ${MAX_ROWS} — split it and import in parts.`);
    }

    const fields = importableFields(objectKey, workspaceId);
    const columns = header.map((name, index) => {
        const values = rows.map((r) => r[index] ?? '').filter((v) => String(v).trim() !== '');
        const guess = suggestField(name, values, fields);
        return {
            index,
            // A blank header is preserved and addressed positionally rather than
            // dropped — the qualifier's parser keeps it, and so does this.
            name: name || `(column ${index + 1})`,
            blankHeader: !name,
            filled: values.length,
            fillRate: rows.length ? values.length / rows.length : 0,
            // Users verify a mapping by recognising their data, not by reading
            // header names.
            samples: values.slice(0, SAMPLE_SIZE).map((v) => String(v).slice(0, 80)),
            suggestion: guess.field,
            confidence: guess.confidence,
            reason: guess.reason,
        };
    });

    // One target field can only be claimed once, by the column that matched it
    // most confidently. Two columns silently writing the same field is a bug
    // that shows up as "half the emails are wrong".
    const claimed = new Map();
    for (const column of [...columns].sort((a, b) => b.confidence - a.confidence)) {
        if (!column.suggestion) continue;
        const holder = claimed.get(column.suggestion);
        if (holder) {
            // Read the previous claimant BEFORE clearing the suggestion — doing
            // it after produces "another column matched undefined more strongly",
            // which is exactly the kind of message that teaches users to ignore
            // the explanations.
            column.reason = `"${holder}" matched this field more strongly, so this column was left unmapped. Map it by hand if that is wrong.`;
            column.suggestion = null;
            column.confidence = 0;
            continue;
        }
        claimed.set(column.suggestion, column.name);
    }

    const mapping = {};
    for (const column of columns) if (column.suggestion) mapping[column.index] = column.suggestion;

    return {
        objectKey,
        header,
        rows: rows.length,
        columns,
        mapping,
        duplicateHeaders: findDuplicates(header),
        fields: fields.map((f) => ({
            key: f.key, label: f.label, type: f.type, required: f.required, custom: !!f.custom,
            transform: describeTransforms()[f.key] ?? null,
            // Import-only fields such as `account_type` on a contact import
            // (see ACCOUNT_FIELDS_FOR_CONTACT) are not a field of the object
            // being imported, so the client's own field registry has nothing
            // to look options up by. Carrying the list here is what lets the
            // "value for every row" picker offer Egypt/Regional instead of an
            // empty dropdown.
            options: f.options ?? null,
        })),
        matchers: matchersFor(objectKey).map((m) => ({ key: m.key, label: m.label, confidence: m.confidence })),
        // Named up front so a required field with no column is visible before
        // the preview, not as 1,800 rejected rows afterwards.
        //
        // A field with a DEFAULT is not missing: "required" means it must never
        // end up empty, not that every caller has to say it. Lifecycle defaults
        // to `prospect`, and demanding it here would make every import ask for
        // a value the system already knows.
        requiredMissing: fields
            .filter((f) => f.required
                && (f.default === null || f.default === undefined)
                && !Object.values(mapping).includes(f.key))
            .map((f) => ({ key: f.key, label: f.label })),
    };
}

/**
 * The fields an import may write.
 *
 * Read-only fields are excluded — `created_at` is a fact about the database,
 * not a column an uploader gets to assert. Custom fields ARE included, because
 * a field an admin created must be importable the moment it exists; that is the
 * whole promise of the object registry.
 */
function importableFields(objectKey, workspaceId) {
    const base = fieldsFor(objectKey, workspaceId, { includeComputed: false }).filter((f) => !f.readOnly);
    if (objectKey === 'deal') {
        // The raw account_id reference is dropped: a spreadsheet never carries
        // a real account row id, only a name, and leaving the reference field
        // mappable is a foreign-key rejection waiting to happen. The
        // account-name resolver goes FIRST so a spreadsheet's "Account Name"
        // header claims it rather than the deal's own name field, whose alias
        // list overlaps ("company", "account name"...).
        return [DEAL_ACCOUNT_FIELD, ...base.filter((f) => f.key !== 'account_id'), ...DEAL_SIZE_FIELDS];
    }
    if (objectKey === 'contact') {
        return [
            CONTACT_ACCOUNT_FIELD,
            ...base.filter((f) => f.key !== 'account_id'),
            ...ACCOUNT_FIELDS_FOR_CONTACT.map((f) => ({
                key: f.key, label: f.label, type: f.type, options: f.options ?? null, importOnly: true,
            })),
        ];
    }
    return base;
}

/**
 * Which field a column probably holds, judged from its VALUES.
 *
 * Header text is worth a little — enough to break a tie between two columns
 * that both look like text — and never enough to override what the data says.
 * This is why "Personal LinkedIn" does not win the company-URL slot.
 */
/**
 * `strict: true` means the rule will only ever claim one of its HINTED fields.
 *
 * Without it, a column of `linkedin.com/in/…` profile URLs on an object with no
 * personal-LinkedIn field falls through to "it is a URL, so it must be the
 * website" — and then wins the website slot from the column that actually holds
 * websites. A rule that recognises something specific must decline rather than
 * settle for something general.
 */
const VALUE_TESTS = [
    { test: (v) => /^https?:\/\/(www\.)?linkedin\.com\/company\//i.test(v), types: [], hints: ['linkedin_slug', 'linkedin_url'], strict: true, weight: 0.95, reason: 'LinkedIn company URLs' },
    { test: (v) => /^https?:\/\/(www\.)?linkedin\.com\/in\//i.test(v), types: [], hints: ['linkedin_url', 'contact_linkedin_url'], strict: true, weight: 0.95, reason: 'LinkedIn personal profile URLs' },
    { test: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(v), types: ['email'], hints: ['email'], weight: 0.95, reason: 'email addresses' },
    { test: (v) => /^\+?[\d\s().-]{7,}$/.test(v), types: ['phone'], hints: ['phone'], weight: 0.7, reason: 'phone numbers' },
    { test: (v) => /^https?:\/\//i.test(v), types: ['url'], hints: ['website'], weight: 0.7, reason: 'URLs' },
    { test: (v) => /^\d{4}-\d{2}-\d{2}/.test(v), types: ['date', 'datetime'], hints: [], weight: 0.8, reason: 'ISO dates' },
    { test: (v) => /^-?\d+(\.\d+)?$/.test(v), types: ['number', 'currency', 'percent'], hints: [], weight: 0.5, reason: 'numbers' },
];

/**
 * Header words that mean a field without spelling it the same way.
 *
 * Lead lists arrive with "Company", "Organisation", "Account Name" and "Ref"
 * meaning the same four things every time. Header text is still only ever a
 * tie-break — it cannot beat what the values say — but a column of plain text
 * has no values to judge, and this is the difference between mapping it and
 * making the user map it.
 */
const HEADER_ALIASES = {
    name: ['company', 'companyname', 'organisation', 'organization', 'businessname', 'employer', 'dealname', 'deal'],
    legal_name: ['legalname', 'registeredname', 'arabicname'],
    domain: ['domain', 'companydomain', 'websitedomain'],
    website: ['website', 'url', 'homepage', 'site', 'companywebsite'],
    linkedin_slug: ['companylinkedin', 'linkedin', 'linkedinurl', 'companylinkedinurl', 'lipage'],
    linkedin_url: ['personallinkedin', 'profile', 'profileurl', 'linkedinprofile'],
    employee_count: ['employees', 'headcount', 'staff', 'size', 'employeecount', 'numberofemployees'],
    external_id: ['ref', 'reference', 'externalid', 'sourceid', 'recordid', 'id'],
    // Listed before the parts so a file with a single name column maps to the
    // whole name rather than losing everything after the first space.
    full_name: ['fullname', 'name', 'contactname', 'personname', 'displayname', 'completename'],
    first_name: ['firstname', 'given', 'givenname', 'forename'],
    last_name: ['lastname', 'surname', 'familyname'],
    title: ['title', 'jobtitle', 'position', 'role', 'designation'],
    phone: ['phone', 'mobile', 'telephone', 'tel', 'contactnumber'],
    email: ['email', 'emailaddress', 'workemail', 'businessemail'],
    industry: ['industry', 'sector', 'vertical'],
    country: ['country', 'countryname'],
    city: ['city', 'town', 'location'],
    cr_number: ['crnumber', 'cr', 'commercialregistration', 'registrationnumber'],
    service_line_key: ['service', 'serviceline', 'product'],
    campaign_id: ['campaign', 'campaignname', 'source campaign'],
    // A contact's own account-name column (see CONTACT_ACCOUNT_FIELD) — not
    // aliased under `name`, which is a deal's own title, not a contact's.
    contact_account_name: ['company', 'companyname', 'employer', 'organization', 'organisation', 'accountname', 'account'],
    // An account import's primary-contact columns (see PRIMARY_CONTACT_FIELDS
    // in lib/repo.mjs). Aliased separately from `full_name`/`phone`/
    // `linkedin_url` above: those keys never appear in an ACCOUNT import's
    // field list, so there is no collision, but the two objects' fields are
    // never mixed into one `fields` array for `headerMatches` to confuse.
    contact_full_name: ['contactname', 'personname', 'fullname', 'displayname', 'completename'],
    // A contact import's own company-detail columns (see
    // ACCOUNT_FIELDS_FOR_CONTACT above) — separately aliased from the plain
    // `website`/`industry`/`city`/`account_type` entries for the same reason
    // as contact_full_name: those keys never appear in a CONTACT import's
    // field list, so there is no collision, only two objects' aliases living
    // in one lookup table.
    account_website: ['companywebsite', 'website', 'url', 'companyurl', 'companysite'],
    account_linkedin: ['companylinkedin', 'companylinkedinurl', 'linkedincompany'],
    account_industry: ['companyindustry', 'industry', 'sector', 'vertical'],
    account_city: ['companycity', 'companylocation', 'city', 'location'],
    contact_phone: ['contactphone', 'personalphone', 'directphone', 'mobilephone', 'cellphone', 'cell'],
    contact_linkedin_url: ['personallinkedin', 'profile', 'profileurl', 'linkedinprofile', 'contactlinkedin'],
    // Deal-size columns (import-only — see DEAL_SIZE_FIELDS).
    unit_price: ['price', 'rate', 'monthlyprice', 'priceperhead', 'priceperse', 'priceperunit', 'contractvalue', 'value', 'dealvalue', 'amount'],
    headcount: ['headcount', 'seats', 'employees', 'users', 'count', 'qty', 'quantity', 'people'],
    price_currency: ['currency', 'curr'],
    term_months: ['term', 'termmonths', 'months', 'durationmonths', 'contractmonths'],
    price_effective_from: ['effectivefrom', 'pricefrom', 'pricestartdate'],
};

function suggestField(headerText, values, fields) {
    if (!values.length) {
        // No values to judge from, so the header is all there is. Said plainly
        // rather than silently guessing.
        const byHeader = fields.find((f) => headerMatches(headerText, f));
        return byHeader
            ? { field: byHeader.key, confidence: 0.3, reason: `The column is empty; matched on its name "${headerText}".` }
            : { field: null, confidence: 0, reason: 'No values to judge from.' };
    }
    const sample = values.slice(0, 50).map((v) => String(v).trim());

    let best = { field: null, confidence: 0, reason: null };

    for (const rule of VALUE_TESTS) {
        const hits = sample.filter((v) => rule.test(v)).length / sample.length;
        if (hits < 0.6) continue;

        const hinted = fields.filter((f) => rule.hints.includes(fieldName(f)));
        // A strict rule takes a hinted field or nothing at all.
        const candidates = rule.strict ? hinted : [...hinted, ...fields.filter((f) => rule.types.includes(f.type))];
        if (!candidates.length) continue;

        const chosen = candidates.find((f) => headerMatches(headerText, f)) ?? candidates[0];
        const confidence = Math.min(0.99, rule.weight * hits + (headerMatches(headerText, chosen) ? 0.04 : 0));
        if (confidence > best.confidence) {
            best = { field: chosen.key, confidence, reason: `${Math.round(hits * 100)}% of values look like ${rule.reason}.` };
        }
    }

    // Nothing in the values was decisive: fall back to the header, at a
    // confidence that says so.
    if (!best.field) {
        const byHeader = fields.find((f) => headerMatches(headerText, f));
        if (byHeader) {
            return { field: byHeader.key, confidence: 0.45, reason: `Matched on the column name "${headerText}", not on its values.` };
        }
    }
    return best;
}

const normaliseText = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const fieldName = (field) => field.key.replace('properties.', '');

function headerMatches(headerText, field) {
    const header = normaliseText(headerText);
    if (!header) return false;
    const key = fieldName(field);
    if (header === normaliseText(field.label) || header === normaliseText(key)) return true;
    return (HEADER_ALIASES[key] ?? []).some((alias) => header === normaliseText(alias));
}

function findDuplicates(header) {
    const seen = new Map();
    const dupes = [];
    header.forEach((name, index) => {
        const key = name.trim().toLowerCase();
        if (!key) return;
        if (seen.has(key)) dupes.push({ name, indexes: [seen.get(key), index] });
        else seen.set(key, index);
    });
    return dupes;
}

/* ---------------------------------------------------------- normalising --- */

/**
 * Value transforms applied on the way in, per target field.
 *
 * `linkedin_slug` is the one that genuinely matters. Lead lists carry the full
 * URL, the qualification engine keys on the bare slug, and storing
 * `https://www.linkedin.com/company/afco-steel/` in that column would leave the
 * account permanently unmatchable against its own collected evidence — with no
 * error anywhere, just a verdict of UNRESOLVED that nobody can explain.
 *
 * The slug parser is the qualifier's own, imported not copied, so the CRM and
 * the collector can never disagree about what a company's identity is.
 *
 * `email`/`contact_email` guard against the other common lead-list shape: a
 * column that is not actually blank, but carries a placeholder — "N/A", "-",
 * "no email" — for a person nobody has an address for. Treated as a real
 * value, that placeholder would both fail email validation (rejecting a lead
 * that is otherwise perfectly importable) and, worse, match every OTHER row
 * carrying the same placeholder as the same "duplicate" email. Anything that
 * does not parse as an email is treated exactly like a blank cell instead:
 * dropped here, before it ever reaches validation or the duplicate matchers.
 */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const emailOrNull = (value) => {
    const s = String(value).trim().toLowerCase();
    return EMAIL_RE.test(s) ? s : null;
};
const TRANSFORMS = {
    linkedin_slug: (value, helpers) => helpers.normalizeCompanySlug(value) || null,
    domain: (value) => String(value)
        .trim().toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/\/.*$/, '')
        .replace(/:\d+$/, '') || null,
    email: emailOrNull,
    contact_email: emailOrNull,
};

export function describeTransforms() {
    return {
        linkedin_slug: 'A full LinkedIn URL is reduced to the company slug, which is the identity the qualification engine collects against.',
        domain: 'Protocol, www and any path are stripped, so acme.sa and https://www.acme.sa/about are the same company.',
        email: 'Anything that is not a real email address — blank, "N/A", "no email" — is treated as no email at all, so it is accepted rather than rejected and never matches another lead as a duplicate.',
        contact_email: 'Anything that is not a real email address — blank, "N/A", "no email" — is treated as no email at all, so it is accepted rather than rejected and never matches another lead as a duplicate.',
    };
}

/* ------------------------------------------------------------- deduping --- */

/**
 * Match rules, strongest first.
 *
 * Commercial Registration is first-class for Saudi entities — it is the
 * strongest natural key available in this market. A NAME match is deliberately
 * absent: it is medium confidence at best and auto-merging on it is how two
 * different "Al Rajhi" companies become one.
 */
export function matchersFor(objectKey) {
    if (objectKey === 'account' || objectKey === 'prospecting_company') {
        return [
            { key: 'external_id', column: 'external_id', label: 'External ID', confidence: 'certain' },
            { key: 'cr_number', column: 'cr_number', label: 'Commercial Registration', confidence: 'certain' },
            { key: 'linkedin_slug', column: 'linkedin_slug', label: 'LinkedIn slug', confidence: 'high' },
            { key: 'domain', column: 'domain', label: 'Domain', confidence: 'high' },
        ];
    }
    if (objectKey === 'contact' || objectKey === 'prospecting_contact') {
        return [
            { key: 'external_id', column: 'external_id', label: 'External ID', confidence: 'certain' },
            { key: 'email', column: 'email', label: 'Email', confidence: 'certain' },
        ];
    }
    if (objectKey === 'deal') {
        return [
            { key: 'external_id', column: 'external_id', label: 'External ID', confidence: 'certain' },
        ];
    }
    return [{ key: 'external_id', column: 'external_id', label: 'External ID', confidence: 'certain' }];
}

function findExisting(objectKey, workspaceId, values, matchers) {
    const table = objectDef(objectKey).table;
    for (const matcher of matchers) {
        const value = values[matcher.column];
        if (value === null || value === undefined || value === '') continue;
        const row = get(
            `SELECT id FROM ${table} WHERE workspace_id = ? AND ${matcher.column} = ? AND deleted_at IS NULL`,
            [workspaceId, value],
        );
        if (row) return { id: row.id, matcher: matcher.label, confidence: matcher.confidence };
    }
    return null;
}

/* ------------------------------------------------------------ the engine -- */

/**
 * Classifies every row exactly as execution will.
 *
 * `apply: false` writes nothing and returns the counts; `apply: true` performs
 * the same walk and writes. One function, so the preview cannot drift from the
 * run — which is the promise the preview makes.
 */
export async function process(ctx, {
    text, objectKey, mapping, defaults = {}, duplicateStrategy = 'update', apply = false, batchId = null,
}) {
    const { parseTable, normalizeCompanySlug } = await csv();
    const { header, rows } = parseTable(text);
    if (!header.length) throw badRequest('That file has no rows.');

    const helpers = { normalizeCompanySlug };
    const fields = importableFields(objectKey, ctx.workspaceId);
    const byKey = new Map(fields.map((f) => [f.key, f]));
    const matchers = matchersFor(objectKey);

    const pairs = Object.entries(mapping ?? {})
        .map(([index, key]) => ({ index: Number(index), field: byKey.get(key) }))
        .filter((p) => p.field);
    if (!pairs.length) throw badRequest('No columns are mapped, so there is nothing to import.');

    const counts = { create: 0, update: 0, skip: 0, reject: 0 };
    const reasons = new Map();
    const results = [];
    // Duplicates WITHIN the file, not just against the database. A file listing
    // the same company twice is common, and the second row silently updating
    // the first is not a helpful surprise.
    const seenInFile = new Map();

    rows.forEach((row, i) => {
        const rowNumber = i + 2;          // 1-based, and the header is row 1
        const input = { properties: {} };
        /**
         * How many mapped columns this ROW actually supplied.
         *
         * Counted before defaults are merged, and it is what decides whether
         * there is a record here at all. A default fills a gap in a row that
         * exists; it must never be the only thing in one. Deciding after the
         * merge meant a blank line in the middle of a file — or a row of bare
         * commas, which every spreadsheet export produces — became a real
         * contact whose only content was the default somebody set two steps
         * earlier in the wizard.
         */
        let fromFile = 0;
        for (const { index, field } of pairs) {
            const raw = row[index];
            if (raw === undefined) continue;
            let value = String(raw).trim();
            if (value === '') continue;
            const transform = field.custom ? null : TRANSFORMS[field.key];
            if (transform) {
                value = transform(value, helpers);
                if (value === null || value === '') continue;
            }
            fromFile += 1;
            if (field.custom) input.properties[field.key.replace('properties.', '')] = value;
            else input[field.key] = value;
        }
        for (const [key, value] of Object.entries(defaults)) {
            if (value === null || value === undefined || value === '') continue;
            if (input[key] === undefined) input[key] = value;
        }

        const record = (outcome, extra = {}) => {
            counts[outcome === 'created' ? 'create' : outcome === 'updated' ? 'update' : outcome === 'skipped' ? 'skip' : 'reject'] += 1;
            if (extra.reason) reasons.set(extra.reason, (reasons.get(extra.reason) ?? 0) + 1);
            const entry = { rowNumber, outcome, ...extra };
            results.push(entry);
            if (apply && batchId) {
                run(
                    'INSERT INTO import_rows (id, batch_id, row_number, outcome, record_id, reason, raw) VALUES (?,?,?,?,?,?,?)',
                    [id('imr'), batchId, rowNumber, outcome, extra.recordId ?? null, extra.reason ?? null, JSON.stringify(row)],
                );
            }
            return entry;
        };

        /**
         * Nothing came from the file, so there is nothing to import.
         *
         * Two different situations, told apart because the answer differs. A
         * row that is blank end to end is noise in the file and is SKIPPED —
         * calling it a rejection makes a clean import look like it had 40
         * failures. A row that has content in columns nobody mapped is a
         * REJECTION, because the data is there and the mapping is what lost it.
         */
        if (!fromFile) {
            const blank = row.every((cell) => String(cell ?? '').trim() === '');
            return blank
                ? record('skipped', { reason: 'The row was blank.' })
                : record('rejected', { reason: 'Every mapped column was empty on this row.' });
        }

        /**
         * Deal-size columns come OFF the record input and travel separately.
         *
         * They are import-only keys (DEAL_SIZE_FIELDS) — the deals table has
         * no such columns, so validate() would reject them like any unknown
         * field. Pulled out here, then applied through `setDealPrice` after
         * the deal is written, which is the one door every other price write
         * goes through: the period series, the line-item projection, the
         * rollups and the forecast all happen exactly as they do from the
         * Deal size dialog.
         */
        const dealSize = {};
        if (objectKey === 'deal') {
            for (const key of DEAL_SIZE_FIELDS.map((f) => f.key)) {
                if (input[key] === undefined) continue;
                dealSize[key] = input[key];
                delete input[key];
            }

            /**
             * Resolve the account by NAME, identically in preview and
             * execution: name → id, or a rejection that says what to do.
             * A row carrying an explicit account_id skips the lookup.
             */
            const dealAccountName = input.deal_account_name;
            delete input.deal_account_name;
            if (dealAccountName !== undefined && input.account_id === undefined) {
                const { wanted, account } = resolveAccountByName(ctx.workspaceId, dealAccountName);
                if (!account) {
                    return record('rejected', {
                        reason: `No account named "${wanted.slice(0, 80)}" — import or create it first, then re-run.`,
                    });
                }
                input.account_id = account.id;
            }
        }

        /**
         * Same by-name resolution, for a contact's own account name column —
         * but unlike a deal, a contact's account is CREATED when no match
         * exists rather than rejecting the row. A deal is a commercial
         * commitment against a specific, already-known company; a contact
         * import is very often the FIRST time that company has ever entered
         * the CRM, and making every lead import a two-step "create the
         * accounts, then re-run" chore was the friction rule 4 exists to
         * remove. Only on the real write pass — a preview must not create
         * data — and only for a name that reads as one: an implausibly long
         * value is a mismapped column, not a company, and still rejects.
         */
        if (objectKey === 'contact') {
            // Pulled off `input` before the account branch runs, whatever
            // happens to the account: these belong to it, never to the
            // contact record itself, and an existing-account match (no
            // create) must not leave them behind to be written nowhere.
            const accountExtras = {};
            for (const f of ACCOUNT_FIELDS_FOR_CONTACT) {
                if (input[f.key] === undefined) continue;
                const value = String(input[f.key] ?? '').trim();
                delete input[f.key];
                if (value) accountExtras[f.column] = value;
            }

            const contactAccountName = input.contact_account_name;
            delete input.contact_account_name;
            if (contactAccountName !== undefined && input.account_id === undefined) {
                const { wanted, account } = resolveAccountByName(ctx.workspaceId, contactAccountName);
                if (account) {
                    input.account_id = account.id;
                } else if (wanted.length > 200) {
                    return record('rejected', {
                        reason: `"${wanted.slice(0, 80)}…" is too long to be an account name — check this column is mapped correctly.`,
                    });
                } else if (apply) {
                    try {
                        const createdAccount = createRecord(
                            'account', ctx, { name: wanted, ...accountExtras }, { source: 'import' },
                        );
                        input.account_id = createdAccount.id;
                    } catch (err) {
                        return record('rejected', { reason: accountCreationFailureReason(err, ctx.workspaceId) });
                    }
                }
                // Preview, no match: account_id stays unset. account_id is not
                // required on a contact, so the row still previews as create/
                // update — the account itself appears once the import runs.
            }
        }

        // Identity within the file.
        const fingerprint = matchers
            .map((m) => (input[m.column] ? `${m.column}=${input[m.column]}` : null))
            .filter(Boolean)[0] ?? null;
        if (fingerprint && seenInFile.has(fingerprint)) {
            return record('skipped', { reason: `A row earlier in this file has the same ${fingerprint.split('=')[0]} (row ${seenInFile.get(fingerprint)}).` });
        }
        if (fingerprint) seenInFile.set(fingerprint, rowNumber);

        const existing = findExisting(objectKey, ctx.workspaceId, input, matchers);

        if (existing && duplicateStrategy === 'skip') {
            return record('skipped', { recordId: existing.id, reason: `Already exists — matched on ${existing.matcher}.` });
        }

        if (!apply) {
            // Dry run: the SAME validation the write path runs, just without
            // the write. Anything less and the preview's "1,847 create" is a
            // guess that execution is free to contradict.
            try {
                validate(objectKey, ctx, input, { creating: !existing });
                // The deal-size number gets the same treatment the execution's
                // setDealPrice will give it, so a bad Price column rejects in
                // the preview and not only on the day.
                if (objectKey === 'deal' && dealSize.unit_price !== undefined
                    && (!Number.isFinite(Number(dealSize.unit_price)) || Number(dealSize.unit_price) < 0)) {
                    throw badRequest(`Price "${dealSize.unit_price}" is not a number we can read.`);
                }
            } catch (err) {
                return record('rejected', { reason: err.message });
            }
            return existing && duplicateStrategy === 'update'
                ? record('updated', { recordId: existing.id, reason: `Matched on ${existing.matcher}.` })
                : record('created');
        }

        try {
            let written;
            if (existing && duplicateStrategy === 'update') {
                written = updateRecord(objectKey, ctx, existing.id, input, { source: 'import' });
                var matchedOn = existing.matcher;
            } else {
                written = createRecord(objectKey, ctx, input, { source: 'import' });
            }

            /**
             * Price the deal through the front door.
             *
             * Only when a price column was actually mapped AND supplied — an
             * update row that touches only the owner must not re-write the
             * price series. `source: 'import'` is deliberately not 'ui', so
             * the value lands as an ACTIVE period rather than as a proposal
             * awaiting approval: an import of EXISTING customers is recording
             * prices someone already agreed, not proposing new ones.
             */
            if (objectKey === 'deal' && dealSize.unit_price !== undefined) {
                const amount = Number(dealSize.unit_price);
                if (!Number.isFinite(amount) || amount < 0) {
                    throw badRequest(`Price "${dealSize.unit_price}" is not a number we can read.`);
                }
                /**
                 * A re-upload that repeats the same price is a no-op here.
                 * setDealPrice always writes a period; without this guard,
                 * "re-upload the corrected file" (rule 4) would stack an
                 * identical period under every unchanged row forever.
                 */
                const current = get(
                    'SELECT quantity, unit_amount, currency, term_months FROM deal_line_items WHERE deal_id = ? ORDER BY position, rowid LIMIT 1',
                    [written.id],
                );
                const wantedQty = dealSize.headcount !== undefined ? Number(dealSize.headcount) : Number(current?.quantity ?? 1);
                const wantedCurrency = String(dealSize.price_currency || current?.currency || '').toUpperCase();
                const wantedTerm = dealSize.term_months !== undefined ? (Number(dealSize.term_months) || null) : (current?.term_months ?? null);
                const unchanged = current
                    && Number(current.unit_amount) === amount
                    && Number(current.quantity ?? 1) === wantedQty
                    && String(current.currency).toUpperCase() === wantedCurrency
                    && (current.term_months ?? null) === wantedTerm;
                if (!unchanged) {
                    setDealPrice(ctx, get('SELECT * FROM deals WHERE id = ?', [written.id]), {
                        price: amount,
                        count: dealSize.headcount ?? null,
                        currency: dealSize.price_currency ?? null,
                        termMonths: dealSize.term_months ?? null,
                        effectiveFrom: dealSize.price_effective_from ?? null,
                        source: 'import',
                        reason: 'imported from a file of existing deals',
                    });
                }
            }

            if (matchedOn) return record('updated', { recordId: written.id, reason: `Matched on ${matchedOn}.` });

            // import_batch_id is `readOnly` in the object registry — deliberately,
            // so nobody can hand-edit which upload a company came from — and
            // validate() therefore strips it out of `input` like any other
            // read-only field. It is stamped here, directly, the same way
            // migrate-to-prospecting.mjs and import-snapshots.mjs already write
            // this table: the ONE place besides the importer that is allowed to.
            if (batchId && (objectKey === 'prospecting_company' || objectKey === 'prospecting_contact')) {
                run(`UPDATE ${objectDef(objectKey).table} SET import_batch_id = ? WHERE id = ?`, [batchId, written.id]);
            }
            return record('created', { recordId: written.id });
        } catch (err) {
            return record('rejected', { reason: err.message });
        }
    });

    return {
        objectKey,
        total: rows.length,
        counts,
        // Grouped, because "412 rejected" is a number and "412 rejected: Data
        // source is required" is a fix.
        reasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
        results,
    };
}

/* ------------------------------------------------------------- batches --- */

export function createBatch(ctx, { objectKey, filename, source, mapping, options, totalRows }) {
    const batchId = id('imb');
    run(
        `INSERT INTO import_batches
           (id, workspace_id, object_key, filename, source, status, mapping, options, total_rows, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
            batchId, ctx.workspaceId, objectKey, filename ?? null, source ?? 'upload', 'running',
            JSON.stringify(mapping ?? {}), JSON.stringify(options ?? {}), totalRows ?? 0, ctx.userId, now(),
        ],
    );
    return batchId;
}

export function finishBatch(ctx, batchId, counts, error = null) {
    run(
        `UPDATE import_batches
            SET status = ?, created_count = ?, updated_count = ?, skipped_count = ?, rejected_count = ?,
                finished_at = ?, error = ?
          WHERE id = ? AND workspace_id = ?`,
        [
            error ? 'failed' : 'completed',
            counts.create, counts.update, counts.skip, counts.reject,
            now(), error, batchId, ctx.workspaceId,
        ],
    );
}

export function listBatches(ctx, limit = 30) {
    const rows = all(
        `SELECT b.*, u.name AS created_by_name FROM import_batches b
           LEFT JOIN users u ON u.id = b.created_by
          WHERE b.workspace_id = ? ORDER BY b.created_at DESC LIMIT ?`,
        [ctx.workspaceId, limit],
    );
    return rows.map((r) => ({ ...r, mapping: json(r.mapping, {}), options: json(r.options, {}) }));
}

/* ------------------------------------------------------ upload history --- */

/**
 * Every upload ever made, with what became of the companies it brought in.
 *
 * ── WHY THE COUNTS ARE DERIVED AND NOT STORED ───────────────────────────────
 *
 * `import_batches` already carries created/updated/skipped/rejected. Those are
 * ROW OUTCOMES — what the importer did with each line of the file — and they
 * are correctly frozen, because what the import did is history.
 *
 * Qualified / Review required / Rejected / Imported are something else
 * entirely: they are the CURRENT STATE of the companies, and that state keeps
 * moving long after the upload finished. Re-running a rule, settling a review
 * by hand, or importing a company into the CRM all change it. Stored on the
 * batch, these numbers would be wrong within a day and there would be no way
 * to tell which of the two disagreeing figures to believe.
 *
 * So they are counted from `prospecting_companies` on read. One indexed GROUP
 * BY per page of history, not per row.
 *
 * Deliberately NOT a column on the batch, and deliberately NOT cached.
 */
export function uploadHistory(ctx, { limit = 50, page = 1, includeDeleted = false } = {}) {
    const where = `b.workspace_id = ? AND b.object_key = 'prospecting_company'
            ${includeDeleted ? '' : 'AND b.deleted_at IS NULL'}`;

    const { n: total } = get(
        `SELECT COUNT(*) AS n FROM import_batches b WHERE ${where}`,
        [ctx.workspaceId],
    );
    const pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(1, page), pages);
    const offset = (safePage - 1) * limit;

    const batches = all(
        `SELECT b.*, u.name AS uploaded_by_name
           FROM import_batches b
           LEFT JOIN users u ON u.id = b.created_by
          WHERE ${where}
          ORDER BY b.created_at DESC LIMIT ? OFFSET ?`,
        [ctx.workspaceId, limit, offset],
    );
    if (!batches.length) return { records: [], total, page: safePage, pages, limit };

    const ids = batches.map((b) => b.id);
    const placeholders = ids.map(() => '?').join(',');

    const statusRows = all(
        `SELECT import_batch_id AS batch, status, COUNT(*) AS n
           FROM prospecting_companies
          WHERE workspace_id = ? AND deleted_at IS NULL AND import_batch_id IN (${placeholders})
          GROUP BY import_batch_id, status`,
        [ctx.workspaceId, ...ids],
    );
    const contactRows = all(
        `SELECT import_batch_id AS batch, COUNT(*) AS n
           FROM prospecting_contacts
          WHERE workspace_id = ? AND deleted_at IS NULL AND import_batch_id IN (${placeholders})
          GROUP BY import_batch_id`,
        [ctx.workspaceId, ...ids],
    );

    const byBatch = new Map();
    for (const row of statusRows) {
        if (!byBatch.has(row.batch)) byBatch.set(row.batch, {});
        byBatch.get(row.batch)[row.status] = row.n;
    }
    const contactsByBatch = new Map(contactRows.map((r) => [r.batch, r.n]));

    const records = batches.map((b) => {
        const s = byBatch.get(b.id) ?? {};
        const companies = Object.values(s).reduce((a, n) => a + n, 0);
        return {
            id: b.id,
            filename: b.filename ?? 'Untitled upload',
            source: b.source,
            status: b.status,
            uploadedAt: b.created_at,
            uploadedBy: b.uploaded_by_name ?? 'Unknown',
            deletedAt: b.deleted_at,
            // What the file contained, versus what is still on file from it. The
            // two differ when rows were rejected at parse time, and the gap is
            // the interesting number.
            totalRows: b.total_rows,
            companies,
            contacts: contactsByBatch.get(b.id) ?? 0,
            uploaded: s.uploaded ?? 0,
            qualifying: s.qualifying ?? 0,
            qualified: s.qualified ?? 0,
            reviewRequired: s.review_required ?? 0,
            rejected: s.rejected ?? 0,
            imported: s.imported ?? 0,
        };
    });
    return { records, total, page: safePage, pages, limit };
}

/**
 * Deletes an upload and everything it brought in — softly, together.
 *
 * The upload and its companies share one fate on purpose. Deleting the batch
 * while leaving 371 companies behind with a dangling `import_batch_id` would
 * produce prospects nobody can explain the origin of, which is the failure this
 * whole module exists to prevent.
 *
 * Companies already IMPORTED into the CRM are left alone and reported. Their
 * Account is being worked by a salesperson; withdrawing it because someone
 * tidied up an old upload would take a live opportunity off a desk.
 */
export function deleteUpload(ctx, batchId, { permanent = false } = {}) {
    const batch = get('SELECT * FROM import_batches WHERE id = ? AND workspace_id = ?', [batchId, ctx.workspaceId]);
    if (!batch) throw notFound('That upload does not exist.');

    const stamp = now();
    const kept = get(
        `SELECT COUNT(*) AS n FROM prospecting_companies
          WHERE workspace_id = ? AND import_batch_id = ? AND imported_at IS NOT NULL`,
        [ctx.workspaceId, batchId],
    ).n;

    const removed = tx(() => {
        const affected = run(
            `UPDATE prospecting_companies SET deleted_at = ?, updated_at = ?
              WHERE workspace_id = ? AND import_batch_id = ? AND imported_at IS NULL AND deleted_at IS NULL`,
            [stamp, stamp, ctx.workspaceId, batchId],
        ).changes;
        run(
            `UPDATE prospecting_contacts SET deleted_at = ?, updated_at = ?
              WHERE workspace_id = ? AND import_batch_id = ? AND deleted_at IS NULL`,
            [stamp, stamp, ctx.workspaceId, batchId],
        );
        run('UPDATE import_batches SET deleted_at = ? WHERE id = ?', [stamp, batchId]);
        audit(ctx, {
            objectKey: 'import_batch',
            recordId: batchId,
            action: 'deleted',
            after: { filename: batch.filename, companiesRemoved: affected, importedKept: kept },
        });
        return affected;
    });

    return { removed, keptBecauseImported: kept };
}

/** Puts an upload and its companies back. The exact inverse of deleteUpload. */
export function restoreUpload(ctx, batchId) {
    const batch = get('SELECT * FROM import_batches WHERE id = ? AND workspace_id = ?', [batchId, ctx.workspaceId]);
    if (!batch) throw notFound('That upload does not exist.');
    if (!batch.deleted_at) throw badRequest('That upload is not in the Recycle Bin.');

    // Matched on the deletion timestamp, so a company deleted separately AFTER
    // the upload was binned stays deleted. Restoring an upload must not
    // resurrect rows somebody removed for their own reasons.
    const stamp = batch.deleted_at;
    const restored = tx(() => {
        const affected = run(
            `UPDATE prospecting_companies SET deleted_at = NULL, updated_at = ?
              WHERE workspace_id = ? AND import_batch_id = ? AND deleted_at = ?`,
            [now(), ctx.workspaceId, batchId, stamp],
        ).changes;
        run(
            `UPDATE prospecting_contacts SET deleted_at = NULL, updated_at = ?
              WHERE workspace_id = ? AND import_batch_id = ? AND deleted_at = ?`,
            [now(), ctx.workspaceId, batchId, stamp],
        );
        run('UPDATE import_batches SET deleted_at = NULL WHERE id = ?', [batchId]);
        audit(ctx, {
            objectKey: 'import_batch', recordId: batchId, action: 'restored',
            after: { filename: batch.filename, companiesRestored: affected },
        });
        return affected;
    });

    return { restored };
}

export function batchDetail(ctx, batchId) {
    const batch = get('SELECT * FROM import_batches WHERE id = ? AND workspace_id = ?', [batchId, ctx.workspaceId]);
    if (!batch) throw notFound('That import does not exist.');
    const rows = all('SELECT * FROM import_rows WHERE batch_id = ? ORDER BY row_number', [batchId]);
    return {
        batch: { ...batch, mapping: json(batch.mapping, {}), options: json(batch.options, {}) },
        rows,
        rejected: rows.filter((r) => r.outcome === 'rejected'),
        // Undo is bounded by what the batch CREATED. Records it merely updated
        // are left alone: their previous values are in the audit log, but
        // reverting them would also revert every edit made since.
        undoable: !batch.undone_at && rows.some((r) => r.outcome === 'created'),
    };
}

/**
 * Undo: deletes the records this batch created.
 *
 * Soft deletes, so an undo is itself recoverable. Updates are NOT reverted, and
 * the API says so rather than implying a full rollback — an undo that silently
 * discards three days of edits made after the import would be worse than no
 * undo at all.
 */
export function undoBatch(ctx, batchId) {
    const { batch, rows } = batchDetail(ctx, batchId);
    if (batch.undone_at) throw badRequest('That import has already been undone.');

    const created = rows.filter((r) => r.outcome === 'created' && r.record_id);
    let removed = 0;
    const failed = [];
    for (const row of created) {
        try {
            deleteRecord(batch.object_key, ctx, row.record_id, { source: 'import' });
            removed += 1;
        } catch (err) {
            failed.push({ id: row.record_id, error: err.message });
        }
    }

    run('UPDATE import_batches SET status = ?, undone_at = ? WHERE id = ?', ['undone', now(), batchId]);
    audit(ctx, {
        objectKey: batch.object_key,
        recordId: null,
        action: 'import_undone',
        after: { batchId, removed, failed: failed.length },
    });

    return {
        removed,
        failed,
        updatedNotReverted: rows.filter((r) => r.outcome === 'updated').length,
        note: 'Only the records this import CREATED were removed, and they were soft-deleted so they can be restored. '
            + 'Records it updated keep their current values — reverting those would also discard every edit made since.',
    };
}

/* ------------------------------------------------------------ templates -- */

export function saveTemplate(ctx, { objectKey, name, mapping, options }) {
    const existing = get(
        'SELECT id FROM import_templates WHERE workspace_id = ? AND object_key = ? AND name = ?',
        [ctx.workspaceId, objectKey, name],
    );
    if (existing) {
        run('UPDATE import_templates SET mapping = ?, options = ?, updated_at = ? WHERE id = ?',
            [JSON.stringify(mapping), JSON.stringify(options ?? {}), now(), existing.id]);
        return existing.id;
    }
    const templateId = id('imt');
    run(
        `INSERT INTO import_templates (id, workspace_id, object_key, name, mapping, options, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [templateId, ctx.workspaceId, objectKey, name, JSON.stringify(mapping), JSON.stringify(options ?? {}), ctx.userId, now(), now()],
    );
    return templateId;
}

export function listTemplates(ctx, objectKey = null) {
    const rows = objectKey
        ? all('SELECT * FROM import_templates WHERE workspace_id = ? AND object_key = ? ORDER BY name', [ctx.workspaceId, objectKey])
        : all('SELECT * FROM import_templates WHERE workspace_id = ? ORDER BY object_key, name', [ctx.workspaceId]);
    return rows.map((r) => ({ ...r, mapping: json(r.mapping, {}), options: json(r.options, {}) }));
}

export function deleteTemplate(ctx, templateId) {
    const row = get('SELECT id FROM import_templates WHERE id = ? AND workspace_id = ?', [templateId, ctx.workspaceId]);
    if (!row) throw notFound('That template does not exist.');
    run('DELETE FROM import_templates WHERE id = ?', [templateId]);
    return { ok: true };
}

export const IMPORTABLE_OBJECTS = Object.values(OBJECTS)
    .filter((def) => ['account', 'contact', 'deal', 'campaign', 'task', 'prospecting_company', 'prospecting_contact'].includes(def.key))
    .map((def) => ({ key: def.key, label: def.label, plural: def.plural }));
