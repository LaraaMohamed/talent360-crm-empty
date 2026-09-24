/**
 * The Existing Customers import — Account, Contact, Deal and Agreement from
 * ONE row, in the customer's own already-signed state.
 *
 * ── WHY THIS IS A SEPARATE ENGINE FROM lib/import.mjs ───────────────────────
 *
 * `lib/import.mjs` imports ONE object at a time, deliberately: a spreadsheet
 * of accounts and a spreadsheet of deals are different questions, and mixing
 * them into one mapping was rejected there for good reasons (see its header
 * comment). A file of existing customers is a different shape of problem —
 * one row IS an account, a contact, a deal and a signed agreement, and asking
 * a user to run the same file through the wizard four times, hand-copying the
 * IDs it produces each time to link the next step, is the "manual linking"
 * this feature exists to remove.
 *
 * It reuses everything the generic importer already solved rather than
 * re-solving it: `createRecord`/`updateRecord` for every write (so
 * validation, audit and the search index all agree with the rest of the
 * product), `setDealPrice` for money (so recurrence is the SERVICE's, never
 * the file's — see lib/repo.mjs), and `findDealForAgreement` for the same
 * account+service dedup an agreement created by hand already gets.
 *
 * ── THE ONE DELIBERATE DEPARTURE ─────────────────────────────────────────
 *
 * The generic importer refuses to match an account by NAME — see its
 * `matchersFor`. A cold lead-gen list truly can carry two different "Al
 * Rajhi" companies, and auto-merging them would be a real corruption. A file
 * of EXISTING customers is different: it is typed by someone who already
 * knows these companies, "ABC Company" appearing twice almost always means
 * the same company written two ways, not two companies, and refusing to
 * recognise it would import every customer twice on a re-upload with slightly
 * different casing. So this importer adds a case- and whitespace-insensitive
 * NAME match, after every stronger identifier the generic importer already
 * uses, and only for this workflow.
 */
import { get, run, id, now, tx } from './db.mjs';
import { BILLING_CURRENCIES, ACCOUNT_TYPES } from './objects.mjs';
import {
    createRecord, updateRecord, audit, validate, setDealPrice, findDealForAgreement,
    generatedDealName, serviceLinesFor,
} from './repo.mjs';
import { recurrenceForPricingModel, billingTypeLabel } from './money.mjs';
import { setting } from './settings.mjs';
import { csv } from './csv.mjs';
import { badRequest } from './http.mjs';

const MAX_ROWS = 100000;

/**
 * The columns this workflow understands, grouped by which record they write
 * to. `key` is what travels in the mapping; `group` is display-only, used to
 * cluster the mapping UI exactly as the spec's four sections do.
 */
export const CUSTOMER_IMPORT_FIELDS = [
    // Account
    { key: 'account_name', label: 'Account Name', group: 'Account', required: true },
    { key: 'account_website', label: 'Website', group: 'Account' },
    { key: 'account_linkedin', label: 'Company LinkedIn', group: 'Account' },
    { key: 'account_industry', label: 'Industry', group: 'Account' },
    { key: 'account_city', label: 'Company Location', group: 'Account' },
    { key: 'account_type', label: 'Account Type', group: 'Account', options: ACCOUNT_TYPES },
    { key: 'account_service', label: 'Service (Account)', group: 'Account' },
    { key: 'account_owner', label: 'Account Owner', group: 'Account' },
    // Contact
    { key: 'contact_full_name', label: 'Full Name', group: 'Contact' },
    { key: 'contact_first_name', label: 'First Name', group: 'Contact' },
    { key: 'contact_last_name', label: 'Last Name', group: 'Contact' },
    { key: 'contact_email', label: 'Email', group: 'Contact' },
    { key: 'contact_phone', label: 'Phone', group: 'Contact' },
    { key: 'contact_linkedin', label: 'Contact LinkedIn', group: 'Contact' },
    { key: 'contact_title', label: 'Job Title', group: 'Contact' },
    // Commercial
    { key: 'deal_name', label: 'Deal Name', group: 'Commercial' },
    { key: 'deal_size', label: 'Deal Size / Price', group: 'Commercial' },
    { key: 'currency', label: 'Currency', group: 'Commercial', options: BILLING_CURRENCIES },
    { key: 'billing_type', label: 'Recurring / One-Time', group: 'Commercial', options: ['Recurring', 'One-Time'] },
    { key: 'service', label: 'Service', group: 'Commercial' },
    { key: 'deal_owner', label: 'Deal Owner', group: 'Commercial' },
    // Agreement
    { key: 'agreement_type', label: 'Agreement Type', group: 'Agreement', options: ['msa', 'sow', 'renewal', 'amendment'] },
    { key: 'agreement_number', label: 'Agreement Number / Reference', group: 'Agreement' },
    { key: 'agreement_start', label: 'Agreement Start Date', group: 'Agreement', type: 'date' },
    { key: 'agreement_end', label: 'Agreement End Date', group: 'Agreement', type: 'date' },
    { key: 'renewal_date', label: 'Renewal Date / Next Renewal Date', group: 'Agreement', type: 'date' },
    { key: 'agreement_status', label: 'Agreement Status', group: 'Agreement' },
    { key: 'signed_date', label: 'Signed Date', group: 'Agreement', type: 'date' },
    { key: 'notice_days', label: 'Renewal Notice (days)', group: 'Agreement' },
];

const HEADER_ALIASES = {
    account_name: ['account', 'company', 'companyname', 'accountname', 'client'],
    account_website: ['website', 'url', 'companywebsite'],
    account_linkedin: ['companylinkedin', 'linkedincompany'],
    account_industry: ['industry', 'sector'],
    account_city: ['companylocation', 'location', 'city'],
    account_type: ['accounttype'],
    account_service: ['accountservice'],
    account_owner: ['accountowner'],
    contact_full_name: ['contact', 'contactname', 'fullname', 'name'],
    contact_first_name: ['firstname'],
    contact_last_name: ['lastname'],
    contact_email: ['email', 'emailaddress'],
    contact_phone: ['phone', 'mobile'],
    contact_linkedin: ['linkedin', 'contactlinkedin', 'personallinkedin'],
    contact_title: ['jobtitle', 'title', 'role', 'position'],
    deal_name: ['dealname', 'opportunity'],
    deal_size: ['dealsize', 'price', 'value', 'contractvalue', 'amount'],
    currency: ['currency', 'curr'],
    billing_type: ['recurring', 'recurringonetime', 'billingtype', 'dealtype'],
    service: ['service', 'serviceline', 'product'],
    deal_owner: ['dealowner'],
    agreement_type: ['agreementtype'],
    agreement_number: ['agreementnumber', 'agreementreference', 'reference', 'contractnumber'],
    agreement_start: ['agreementstartdate', 'startdate', 'contractstart'],
    agreement_end: ['agreementenddate', 'enddate', 'contractend'],
    renewal_date: ['nextrenewaldate', 'renewaldate', 'nextrenewal'],
    agreement_status: ['agreementstatus', 'status'],
    signed_date: ['signeddate', 'signedon', 'dateSigned'],
    notice_days: ['renewalnotice', 'noticedays', 'noticeperiod'],
};

const normaliseText = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function suggestColumn(headerText) {
    const header = normaliseText(headerText);
    if (!header) return null;
    for (const field of CUSTOMER_IMPORT_FIELDS) {
        if (header === normaliseText(field.label) || header === normaliseText(field.key)) return field.key;
    }
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
        if (aliases.some((a) => normaliseText(a) === header)) return key;
    }
    return null;
}

/* -------------------------------------------------------------- dates --- */

/**
 * Parses `01/01/2026` and `2026-01-01` alike into a real `YYYY-MM-DD`.
 *
 * The generic importer's `date` field just slices the first 10 characters —
 * fine when a file is already ISO, silently wrong on the DD/MM/YYYY a
 * spreadsheet of "existing customers" is actually likely to carry (the
 * spec's own examples are DD/MM/YYYY, and it is the format `dateInput()`
 * already accepts on every date field in this product). Anything that
 * cannot be read as a real calendar date returns `null` — a caller-visible
 * failure — rather than storing whatever slicing happened to produce.
 */
export function parseDateLoose(raw) {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).trim();
    if (!s) return null;

    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return isoIfValid(Number(m[1]), Number(m[2]), Number(m[3]));

    m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (m) return isoIfValid(Number(m[3]), Number(m[2]), Number(m[1])); // DD/MM/YYYY

    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return null;
}

function isoIfValid(year, month, day) {
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return d.toISOString().slice(0, 10);
}

/* --------------------------------------------------------------- users --- */

/** A name or an email, resolved to a user id in this workspace. Unmatched returns null — never guessed. */
function resolveOwner(workspaceId, raw) {
    const wanted = String(raw ?? '').trim();
    if (!wanted) return null;
    const byEmail = wanted.includes('@')
        ? get(
            `SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id
              WHERE m.workspace_id = ? AND lower(u.email) = lower(?)`,
            [workspaceId, wanted],
        )
        : null;
    if (byEmail) return byEmail.id;
    const byName = get(
        `SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id
          WHERE m.workspace_id = ? AND lower(u.name) = lower(?)`,
        [workspaceId, wanted],
    );
    return byName?.id ?? null;
}

/* ------------------------------------------------------------ accounts --- */

function findAccount(workspaceId, { name, website, linkedin }) {
    if (website) {
        const domain = String(website).trim().toLowerCase()
            .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
        const row = get(
            'SELECT * FROM accounts WHERE workspace_id = ? AND deleted_at IS NULL AND lower(domain) = ?',
            [workspaceId, domain],
        );
        if (row) return { account: row, matcher: 'domain' };
    }
    if (linkedin) {
        const row = get(
            'SELECT * FROM accounts WHERE workspace_id = ? AND deleted_at IS NULL AND lower(linkedin_slug) = lower(?)',
            [workspaceId, linkedin],
        );
        if (row) return { account: row, matcher: 'LinkedIn' };
    }
    if (name) {
        // The one departure from the generic importer's rules — see the file
        // header. Case- and whitespace-insensitive, deliberately.
        const row = get(
            `SELECT * FROM accounts WHERE workspace_id = ? AND deleted_at IS NULL
              AND lower(trim(name)) = lower(trim(?))`,
            [workspaceId, name],
        );
        if (row) return { account: row, matcher: 'name' };
    }
    return null;
}

function findContact(workspaceId, accountId, { email, linkedin }) {
    if (email) {
        const row = get(
            'SELECT * FROM contacts WHERE workspace_id = ? AND deleted_at IS NULL AND lower(email) = lower(?)',
            [workspaceId, email],
        );
        if (row) return { contact: row, matcher: 'email' };
    }
    if (linkedin) {
        const row = get(
            'SELECT * FROM contacts WHERE workspace_id = ? AND deleted_at IS NULL AND lower(linkedin_url) LIKE lower(?)',
            [workspaceId, `%${linkedin.replace(/^https?:\/\//, '').replace(/\/$/, '')}%`],
        );
        if (row) return { contact: row, matcher: 'LinkedIn' };
    }
    return null;
}

const STATUS_ALIASES = {
    active: 'signed', signed: 'signed', current: 'signed',
    draft: 'draft', pending: 'pending_review', 'pending review': 'pending_review',
    'out for signature': 'out_for_signature', approved: 'approved',
    expired: 'expired', terminated: 'terminated', cancelled: 'terminated', canceled: 'terminated',
    rejected: 'rejected',
};

function resolveAgreementStatus(raw) {
    if (!raw) return 'signed'; // an existing customer's contract is, by definition, in force
    const key = String(raw).trim().toLowerCase();
    return STATUS_ALIASES[key] ?? null;
}

/* ------------------------------------------------------------- profile --- */

export async function profileCustomers(text) {
    const { parseTable } = await csv();
    const { header, rows } = parseTable(text);
    if (!header.length) return { header: [], rows: 0, columns: [], mapping: {}, fields: CUSTOMER_IMPORT_FIELDS, empty: true };
    if (rows.length > MAX_ROWS) {
        throw badRequest(`That file has ${rows.length} rows. The limit is ${MAX_ROWS} — split it and import in parts.`);
    }

    const claimed = new Set();
    const columns = header.map((name, index) => {
        const values = rows.map((r) => r[index] ?? '').filter((v) => String(v).trim() !== '');
        let suggestion = suggestColumn(name);
        if (suggestion && claimed.has(suggestion)) suggestion = null;
        if (suggestion) claimed.add(suggestion);
        return {
            index, name: name || `(column ${index + 1})`,
            filled: values.length,
            samples: values.slice(0, 3).map((v) => String(v).slice(0, 80)),
            suggestion,
        };
    });
    const mapping = {};
    for (const c of columns) if (c.suggestion) mapping[c.index] = c.suggestion;

    return {
        header, rows: rows.length, columns, mapping,
        fields: CUSTOMER_IMPORT_FIELDS,
        requiredMissing: CUSTOMER_IMPORT_FIELDS
            .filter((f) => f.required && !Object.values(mapping).includes(f.key))
            .map((f) => ({ key: f.key, label: f.label })),
    };
}

/* -------------------------------------------------------------- engine --- */

/**
 * Classifies and — if `apply` — writes every row: Account, then its Contact,
 * then its Deal, then its Agreement. Preview and execute run the identical
 * walk, for the identical reason `lib/import.mjs` does: the counts a person
 * decides against must be the counts that happen.
 */
export async function processCustomers(ctx, { text, mapping, apply = false, batchId = null }) {
    const { parseTable } = await csv();
    const { header, rows } = parseTable(text);
    if (!header.length) throw badRequest('That file has no rows.');

    const pairs = Object.entries(mapping ?? {}).map(([index, key]) => ({ index: Number(index), key }));
    if (!pairs.length) throw badRequest('No columns are mapped, so there is nothing to import.');

    const counts = {
        rows: { create: 0, reject: 0, warn: 0 },
        accounts: { new: 0, existing: 0 },
        contacts: { new: 0, existing: 0, skipped: 0 },
        deals: { created: 0, updated: 0 },
        agreements: { created: 0, updated: 0 },
        renewals: 0,
    };
    const results = [];
    const noticeDaysDefault = Number(setting(ctx.workspaceId, 'default_renewal_notice_days')) || 45;

    rows.forEach((row, i) => {
        const rowNumber = i + 2;
        const v = {};
        for (const { index, key } of pairs) {
            const raw = row[index];
            if (raw === undefined) continue;
            const value = String(raw).trim();
            if (value) v[key] = value;
        }
        if (!Object.keys(v).length) {
            const blank = row.every((cell) => String(cell ?? '').trim() === '');
            results.push({ rowNumber, outcome: blank ? 'skipped' : 'rejected', reason: blank ? 'The row was blank.' : 'Every mapped column was empty on this row.' });
            if (!blank) counts.rows.reject += 1;
            return;
        }

        const reject = (reason) => {
            counts.rows.reject += 1;
            results.push({ rowNumber, outcome: 'rejected', reason });
            return results[results.length - 1];
        };

        if (!v.account_name) return reject('Missing Account Name.');

        // ---- dates, validated up front so a bad date never reaches the DB ----
        const dates = {};
        for (const [key, label] of [['agreement_start', 'Agreement Start Date'], ['agreement_end', 'Agreement End Date'], ['renewal_date', 'Next Renewal Date'], ['signed_date', 'Signed Date']]) {
            if (v[key] === undefined) continue;
            const parsed = parseDateLoose(v[key]);
            if (!parsed) return reject(`"${v[key]}" is not a valid date for ${label}. Use DD/MM/YYYY or YYYY-MM-DD.`);
            dates[key] = parsed;
        }

        // ---- currency ----
        if (v.currency && !BILLING_CURRENCIES.includes(v.currency.toUpperCase())) {
            return reject(`"${v.currency}" is not a currency this workspace bills in (${BILLING_CURRENCIES.join(', ')}).`);
        }

        // ---- deal size ----
        let dealSize = null;
        if (v.deal_size !== undefined) {
            dealSize = Number(String(v.deal_size).replace(/,/g, ''));
            if (!Number.isFinite(dealSize) || dealSize < 0) return reject(`"${v.deal_size}" is not a number we can read for Deal Size.`);
        }

        // ---- service + recurring/one-time cross-check ----
        const serviceRaw = v.service ?? v.account_service ?? null;
        let serviceKey = null;
        if (serviceRaw) {
            const lines = serviceLinesFor(ctx.workspaceId);
            serviceKey = [...lines.keys()].find((k) => normaliseText(k) === normaliseText(serviceRaw))
                ?? [...lines.values()].find((l) => normaliseText(l.label) === normaliseText(serviceRaw))?.key
                ?? null;
            if (!serviceKey) return reject(`"${serviceRaw}" is not a service this workspace sells.`);
        }
        if (v.billing_type && serviceKey) {
            const wanted = /^rec/i.test(v.billing_type) ? 'monthly' : 'one_time';
            const line = serviceLinesFor(ctx.workspaceId).get(serviceKey);
            const actual = recurrenceForPricingModel(line?.pricing_model);
            if (wanted !== actual) {
                return reject(
                    `"${v.billing_type}" contradicts ${line?.label ?? serviceKey}, which is always `
                    + `${billingTypeLabel(recurrenceForPricingModel(line?.pricing_model) === 'monthly' ? 'recurring' : 'one_time')}.`,
                );
            }
        }

        // ---- agreement status ----
        const agreementStatus = resolveAgreementStatus(v.agreement_status);
        if (v.agreement_status && !agreementStatus) {
            return reject(`"${v.agreement_status}" is not a status this importer understands (Active, Draft, Pending, Signed, Expired, Terminated).`);
        }
        if (v.agreement_type && !['msa', 'sow', 'renewal', 'amendment'].includes(v.agreement_type.toLowerCase())) {
            return reject(`"${v.agreement_type}" is not a recognised Agreement Type (MSA, SOW, Renewal, Amendment).`);
        }
        /**
         * A signed/active contract with no end date breaks the whole renewal
         * engine silently — refused in words rather than accepted and never
         * renewed. Required only for a RECURRING service (or one whose
         * recurrence this importer cannot determine): a one-time placement
         * fee or OD engagement has nothing to renew, so a missing end date
         * there is not a data problem worth blocking the row for.
         */
        const serviceRecurs = serviceKey
            ? recurrenceForPricingModel(serviceLinesFor(ctx.workspaceId).get(serviceKey)?.pricing_model) === 'monthly'
            : true;
        const isTerminal = agreementStatus === 'signed' || agreementStatus === 'expired';
        if (isTerminal && serviceRecurs && !dates.agreement_end && !v.agreement_end && v.agreement_status) {
            return reject('Agreement Status is Active but no Agreement End Date was given — a contract with no end date can never be renewed on schedule.');
        }

        if (!apply) {
            // Dry run: classify without writing. An account/contact/deal each
            // separately previews as new or existing.
            const acct = findAccount(ctx.workspaceId, { name: v.account_name, website: v.account_website, linkedin: v.account_linkedin });
            if (acct) counts.accounts.existing += 1; else counts.accounts.new += 1;
            const wantsContact = v.contact_full_name || v.contact_first_name || v.contact_email;
            if (wantsContact) {
                const existingContact = findContact(ctx.workspaceId, acct?.account?.id ?? null, { email: v.contact_email, linkedin: v.contact_linkedin });
                if (existingContact) counts.contacts.existing += 1; else counts.contacts.new += 1;
            }
            const existingDeal = acct?.account && serviceKey ? findDealForAgreement(ctx, { accountId: acct.account.id, serviceLineKey: serviceKey }) : null;
            if (existingDeal) counts.deals.updated += 1; else counts.deals.created += 1;
            const existingAgreement = acct?.account
                ? (v.agreement_number
                    ? get('SELECT id FROM agreements WHERE workspace_id = ? AND account_id = ? AND number = ? AND deleted_at IS NULL', [ctx.workspaceId, acct.account.id, v.agreement_number])
                    : (dates.agreement_start
                        ? get('SELECT id FROM agreements WHERE workspace_id = ? AND account_id = ? AND effective_date = ? AND deleted_at IS NULL', [ctx.workspaceId, acct.account.id, dates.agreement_start])
                        : null))
                : null;
            if (existingAgreement) counts.agreements.updated += 1; else counts.agreements.created += 1;
            if (agreementStatus === 'signed' && (dates.agreement_end || v.agreement_end)) counts.renewals += 1;
            counts.rows.create += 1;
            results.push({ rowNumber, outcome: 'created', account: v.account_name, service: serviceRaw });
            return;
        }

        // ---- the real write, in order: account -> contact -> deal -> agreement ----
        try {
            const written = tx(() => writeCustomerRow(ctx, {
                v, dates, dealSize, serviceKey, agreementStatus, noticeDaysDefault, batchId,
            }));
            counts.rows.create += 1;
            if (written.accountCreated) counts.accounts.new += 1; else counts.accounts.existing += 1;
            if (written.contactCreated) counts.contacts.new += 1;
            else if (written.contactMatched) counts.contacts.existing += 1;
            if (written.dealCreated) counts.deals.created += 1; else counts.deals.updated += 1;
            if (written.agreementCreated) counts.agreements.created += 1; else counts.agreements.updated += 1;
            if (agreementStatus === 'signed' && dates.agreement_end) counts.renewals += 1;
            results.push({
                rowNumber, outcome: 'created',
                accountId: written.accountId, contactId: written.contactId,
                dealId: written.dealId, agreementId: written.agreementId,
            });
            if (batchId) {
                run(
                    'INSERT INTO import_rows (id, batch_id, row_number, outcome, record_id, reason, raw) VALUES (?,?,?,?,?,?,?)',
                    [id('imr'), batchId, rowNumber, 'created', written.agreementId, null, JSON.stringify(row)],
                );
            }
        } catch (err) {
            reject(err.message);
            if (batchId) {
                run(
                    'INSERT INTO import_rows (id, batch_id, row_number, outcome, record_id, reason, raw) VALUES (?,?,?,?,?,?,?)',
                    [id('imr'), batchId, rowNumber, 'rejected', null, err.message, JSON.stringify(row)],
                );
            }
        }
    });

    return { total: rows.length, counts, results };
}

/** The actual writes for one row. Called inside a transaction. */
function writeCustomerRow(ctx, { v, dates, dealSize, serviceKey, agreementStatus, noticeDaysDefault, batchId }) {
    // ---- account ----
    const accountOwnerId = v.account_owner ? resolveOwner(ctx.workspaceId, v.account_owner) : null;
    const found = findAccount(ctx.workspaceId, { name: v.account_name, website: v.account_website, linkedin: v.account_linkedin });
    let accountId; let accountCreated = false;
    const accountInput = {
        name: v.account_name,
        // Forced, always — an existing-customer import must never leave a
        // company in Prospecting. See the file header on why this is the
        // one field this importer never takes from the mapping.
        lifecycle_stage: 'customer',
        ...(v.account_website ? { website: v.account_website } : {}),
        ...(v.account_linkedin ? { linkedin_slug: v.account_linkedin } : {}),
        ...(v.account_industry ? { industry: v.account_industry } : {}),
        ...(v.account_city ? { city: v.account_city } : {}),
        ...(v.account_type && ACCOUNT_TYPES.includes(v.account_type) ? { account_type: v.account_type } : {}),
        ...(accountOwnerId ? { owner_id: accountOwnerId } : {}),
        ...(serviceKey ? { services: [serviceKey] } : {}),
        // What the client actually pays in, asserted from the file — an
        // agreement or deal carrying a currency the account disagrees with
        // is refused elsewhere in the system (enforceCurrencyConsistency),
        // and a brand-new account has no billing currency of its own yet to
        // disagree with. Only on CREATE: an account this import MATCHES
        // already has a billing currency on file, and a second contract in
        // a different currency does not get to silently rewrite it.
        ...(v.currency && !found ? { billing_currency: v.currency.toUpperCase() } : {}),
    };
    if (found) {
        accountId = found.account.id;
        const patch = { ...accountInput };
        delete patch.name; // never overwrite an existing account's name from a match
        if (found.account.lifecycle_stage !== 'customer' || Object.keys(patch).length > 1) {
            updateRecord('account', ctx, accountId, patch, { source: 'import' });
        }
    } else {
        const createdAccount = createRecord('account', ctx, accountInput, { source: 'import' });
        accountId = createdAccount.id;
        accountCreated = true;
    }

    // ---- contact ----
    let contactId = null; let contactCreated = false; let contactMatched = false;
    const wantsContact = v.contact_full_name || v.contact_first_name || v.contact_email;
    if (wantsContact) {
        const existingContact = findContact(ctx.workspaceId, accountId, { email: v.contact_email, linkedin: v.contact_linkedin });
        const contactInput = {
            account_id: accountId,
            ...(v.contact_full_name ? { full_name: v.contact_full_name } : {}),
            ...(v.contact_first_name ? { first_name: v.contact_first_name } : {}),
            ...(v.contact_last_name ? { last_name: v.contact_last_name } : {}),
            ...(v.contact_email ? { email: v.contact_email } : {}),
            ...(v.contact_phone ? { phone: v.contact_phone } : {}),
            ...(v.contact_linkedin ? { linkedin_url: v.contact_linkedin } : {}),
            ...(v.contact_title ? { title: v.contact_title } : {}),
            data_source: 'Existing customer import',
        };
        if (existingContact) {
            contactId = existingContact.contact.id;
            contactMatched = true;
            const patch = { ...contactInput };
            delete patch.data_source;
            updateRecord('contact', ctx, contactId, patch, { source: 'import' });
        } else {
            const createdContact = createRecord('contact', ctx, contactInput, { source: 'import' });
            contactId = createdContact.id;
            contactCreated = true;
        }
    }

    // ---- deal ----
    const dealOwnerId = v.deal_owner ? resolveOwner(ctx.workspaceId, v.deal_owner) : null;
    let deal = serviceKey ? findDealForAgreement(ctx, { accountId, serviceLineKey: serviceKey }) : null;
    let dealCreated = false;
    if (!deal) {
        const pipeline = get(`SELECT * FROM pipelines WHERE workspace_id = ? AND object_key = 'deal' ORDER BY is_default DESC, position LIMIT 1`, [ctx.workspaceId]);
        if (!pipeline) throw badRequest('This workspace has no deal pipeline configured.');
        // Represented as WON, not sent through the open pipeline — this is a
        // customer's existing commercial state, not a fresh opportunity. See
        // section 3/4 of the request this importer implements.
        const wonStage = get(`SELECT * FROM stages WHERE pipeline_id = ? AND type = 'won' LIMIT 1`, [pipeline.id]);
        if (!wonStage) throw badRequest('This workspace has no "won" stage configured on its deal pipeline.');
        const closedAt = dates.signed_date ?? dates.agreement_start ?? now();
        const dealId = id('dea');
        const stamp = now();
        const account = get('SELECT billing_currency FROM accounts WHERE id = ?', [accountId]);
        run(
            `INSERT INTO deals
               (id, workspace_id, account_id, name, pipeline_id, stage_id, status, currency, service_line_key,
                owner_id, close_date, closed_at, created_by, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
                dealId, ctx.workspaceId, accountId,
                v.deal_name || generatedDealName(ctx, { accountId, serviceLineKey: serviceKey }) || v.account_name,
                pipeline.id, wonStage.id, 'won',
                (v.currency || account?.billing_currency || 'USD').toUpperCase(),
                serviceKey, dealOwnerId, closedAt.slice(0, 10), closedAt,
                ctx.userId ?? null, stamp, stamp,
            ],
        );
        run(
            'INSERT INTO deal_stage_history (id, workspace_id, deal_id, from_stage_id, to_stage_id, entered_at, actor_id) VALUES (?,?,?,?,?,?,?)',
            [id('dsh'), ctx.workspaceId, dealId, null, wonStage.id, stamp, ctx.userId ?? null],
        );
        audit(ctx, { objectKey: 'deal', recordId: dealId, accountId, action: 'created', source: 'import', after: { because: 'existing customer import', service_line_key: serviceKey } });
        deal = get('SELECT * FROM deals WHERE id = ?', [dealId]);
        dealCreated = true;
    } else if (dealOwnerId && deal.owner_id !== dealOwnerId) {
        updateRecord('deal', ctx, deal.id, { owner_id: dealOwnerId }, { source: 'import' });
        deal = get('SELECT * FROM deals WHERE id = ?', [deal.id]);
    }

    if (dealSize !== null) {
        // The recurrence is never taken from this file — it is the service's
        // (setDealPrice), which is what makes the automatic HCM/Offshoring
        // recurring vs Recruitment/OD one-time rule real instead of a
        // suggestion.
        setDealPrice(ctx, deal, {
            price: dealSize, currency: v.currency ?? null, source: 'import',
            reason: 'existing customer import', effectiveFrom: dates.agreement_start ?? null,
        });
    }

    // ---- agreement ----
    const agreementInput = {
        account_id: accountId,
        deal_id: deal.id,
        title: v.deal_name || generatedDealName(ctx, { accountId, serviceLineKey: serviceKey }) || v.account_name,
        type: v.agreement_type ? v.agreement_type.toLowerCase() : 'msa',
        status: agreementStatus ?? 'signed',
        ...(v.agreement_number ? { number: v.agreement_number } : {}),
        ...(dates.agreement_start ? { effective_date: dates.agreement_start } : {}),
        ...(dates.agreement_end ? { expiry_date: dates.agreement_end } : {}),
        ...(dates.renewal_date ? { renewal_date: dates.renewal_date } : {}),
        ...(dates.signed_date ? { signed_at: dates.signed_date } : {}),
        notice_days: v.notice_days !== undefined && Number.isFinite(Number(v.notice_days)) ? Number(v.notice_days) : noticeDaysDefault,
        ...(serviceKey ? { service_line_key: serviceKey } : {}),
        ...(dealSize !== null ? { contract_value: dealSize } : {}),
        ...(v.currency ? { currency: v.currency.toUpperCase() } : {}),
    };
    // Dedup: a re-uploaded file is an update, not a second contract. Matched
    // by NUMBER first when the file gives one — the strongest identifier a
    // contract has — falling back to the same account+deal+start date, since
    // an existing customer's spreadsheet very often has no reference number
    // at all.
    const existingAgreement = agreementInput.number
        ? get('SELECT id FROM agreements WHERE workspace_id = ? AND account_id = ? AND number = ? AND deleted_at IS NULL', [ctx.workspaceId, accountId, agreementInput.number])
        : (dates.agreement_start
            ? get('SELECT id FROM agreements WHERE workspace_id = ? AND account_id = ? AND deal_id = ? AND effective_date = ? AND deleted_at IS NULL', [ctx.workspaceId, accountId, deal.id, dates.agreement_start])
            : null);
    let agreement; let agreementCreated;
    if (existingAgreement) {
        agreement = updateRecord('agreement', ctx, existingAgreement.id, agreementInput, { source: 'import' });
        agreementCreated = false;
    } else {
        agreement = createRecord('agreement', ctx, agreementInput, { source: 'import' });
        agreementCreated = true;
    }

    return {
        accountId, accountCreated,
        contactId, contactCreated, contactMatched,
        dealId: deal.id, dealCreated,
        agreementId: agreement.id, agreementCreated,
    };
}
