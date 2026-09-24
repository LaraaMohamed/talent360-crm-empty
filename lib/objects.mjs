/**
 * The object registry — the metadata that makes the platform metadata-driven.
 *
 * One definition per object, and every surface reads it: list columns, the
 * filter builder, the record form, global search, the import mapper and the
 * API. Adding a field here (or as a custom field in `field_defs`) makes it
 * appear in all of them with no other code change. That property is the whole
 * promise of the design docs, and it only holds while this file stays the
 * single source of truth.
 *
 * `filterable` / `sortable` / `searchable` are the index budget, not
 * conveniences. A field that is not filterable is absent from the builder WITH
 * AN EXPLANATION — a silent omission reads as a bug, a stated constraint reads
 * as a design.
 */
import { all, json } from './db.mjs';
// Safe: verification.mjs reaches only db/http/settings, never back to here.
import { STATUSES as VERIFICATION_STATUSES, STATUS_META as VERIFICATION_STATUS_META } from './verification.mjs';

/** Operators available per field type. Shared by the filter builder and the API. */
export const OPERATORS = {
    text: ['is', 'is_not', 'contains', 'not_contains', 'starts_with', 'is_empty', 'is_not_empty'],
    textarea: ['contains', 'not_contains', 'is_empty', 'is_not_empty'],
    email: ['is', 'contains', 'not_contains', 'is_empty', 'is_not_empty'],
    url: ['contains', 'not_contains', 'is_empty', 'is_not_empty'],
    phone: ['contains', 'not_contains', 'is_empty', 'is_not_empty'],
    number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'is_not_empty'],
    currency: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'is_not_empty'],
    percent: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'is_not_empty'],
    date: ['on', 'before', 'after', 'between', 'in_last_days', 'in_next_days', 'is_empty', 'is_not_empty'],
    datetime: ['on', 'before', 'after', 'between', 'in_last_days', 'in_next_days', 'is_empty', 'is_not_empty'],
    select: ['is_any_of', 'is_none_of', 'is_empty', 'is_not_empty'],
    multiselect: ['has_any_of', 'has_all_of', 'has_none_of', 'is_empty', 'is_not_empty'],
    checkbox: ['is'],
    user: ['is_any_of', 'is_none_of', 'is_empty', 'is_not_empty'],
    // `is` stays first so a reference still defaults to the plain text box it
    // has always had; the set operators are added, not substituted.
    reference: ['is', 'is_not', 'is_any_of', 'is_none_of', 'is_empty', 'is_not_empty'],
};

export const OPERATOR_LABELS = {
    is: 'is', is_not: 'is not', contains: 'contains', not_contains: 'does not contain',
    starts_with: 'starts with', is_empty: 'is empty', is_not_empty: 'is not empty',
    eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', between: 'between',
    on: 'on', before: 'before', after: 'after',
    in_last_days: 'in the last (days)', in_next_days: 'in the next (days)',
    is_any_of: 'is any of', is_none_of: 'is none of',
    has_any_of: 'has any of', has_all_of: 'has all of', has_none_of: 'has none of',
};

const LIFECYCLE = ['prospect', 'qualified', 'engaged', 'customer', 'churned', 'disqualified'];
export const LIFECYCLE_STAGES = LIFECYCLE;

/**
 * VERDICT values, in the order they are always presented.
 *
 * REVIEW sits between the two definitive answers because that is what it is:
 * the evidence could not answer. It is never merged into REJECTED, in any
 * filter, count, export or chart.
 */
export const VERDICTS = ['QUALIFIED', 'REVIEW', 'REJECTED', 'UNRESOLVED', 'ERROR'];

/**
 * Where a field's options come from when they are workspace DATA rather than a
 * fixed list — service lines, campaigns, pipelines, stages, activity types,
 * loss reasons, rules, people.
 *
 * Before this existed the client resolved them with a chain of
 * `if (objectKey === 'deal' && fieldKey === 'service_line_key')`, which meant
 * the same field on a second object silently rendered as an empty dropdown. The
 * source belongs to the FIELD, so any object can carry any of them.
 */
export const OPTION_SOURCES = ['service_lines', 'campaigns', 'pipelines', 'stages', 'activity_types', 'loss_reasons', 'rules', 'users'];

/**
 * A LinkedIn company URL reduced to the slug it identifies.
 *
 * The field is presented as a URL because that is what people have in their
 * hand — they copy the address bar. What is STORED is the slug, and that is not
 * cosmetic: the slug is the subject key on every evidence row and every verdict
 * (`api/accounts.mjs`, `api/prospects.mjs` pass `linkedin_slug` straight through
 * as `subjectKey`), and it is what `lib/promotion.mjs` matches a prospect to an
 * account on. Storing the URL instead would orphan 661 accounts' worth of
 * qualification history from the moment it changed.
 *
 * So: type or paste either, store the slug, show the URL. The importer has
 * always done exactly this — `lib/import.mjs` reduces a pasted URL through
 * `normalizeCompanySlug` — and the form was the one way in that did not, which
 * is how a full URL could end up in the column and quietly stop matching.
 *
 * A personal profile (`/in/…`) is not a company and is left alone rather than
 * mangled into something that looks like a slug but identifies nothing.
 */
export function companySlug(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    if (/linkedin\.com\/in\//i.test(raw)) return raw;      // not a company; let validation speak

    return raw
        .replace(/^https?:\/\//i, '')
        .replace(/^[\w-]*\.?linkedin\.com\/company\//i, '')
        .replace(/[?#].*$/, '')
        .replace(/\/.*$/, '')
        .trim() || null;
}

/**
 * The commercial grouping, and the currencies a client can pay in.
 *
 * `ACCOUNT_TYPES` is a business classification and nothing to do with where a
 * company is registered — `accounts.country` is the address. The dashboard
 * reports Egypt and Regional performance separately, and targets are set per
 * type, which is what this exists for.
 *
 * `DEFAULT_BILLING_CURRENCY` is applied ONCE, when an account is created
 * without one. It is not a rule the system re-applies: Egypt does not mean EGP
 * forever, and `lib/repo.mjs` never revisits the currency when the type changes.
 */
/**
 * What a status MEANS, in one place, for everything that draws one.
 *
 * ── WHY THIS IS NOT IN THE CLIENT ───────────────────────────────────────────
 *
 * It was: a literal object inside `cellContent` mapping fourteen values to a
 * badge class. Fourteen, out of the sixty-odd this registry declares — so the
 * entire approval workflow (`pending_review`, `approved`, `out_for_signature`,
 * `signed`, `expired`, `terminated`) rendered as identical grey badges, and a
 * contract that had EXPIRED looked exactly like one waiting to be read.
 *
 * A status is a fact about the domain, and the domain is defined here. Putting
 * the meaning beside the values means adding a status and forgetting to say
 * what it signifies is a test failure rather than a grey pill nobody notices.
 *
 * ── THE FOUR TONES ──────────────────────────────────────────────────────────
 *
 *   success  a good end state, or something healthy right now
 *   accent   in flight — somebody is working it, nothing is wrong
 *   warning  waiting on a person, or true but not proven
 *   danger   a bad end state, or something that needs intervening in
 *
 * Anything absent is deliberately NEUTRAL: `draft`, `open`, `prospect` and
 * `planned` are the ordinary beginning of their workflow and colouring them
 * would spend the reader's attention on the unremarkable.
 */
export const NEUTRAL_STATUSES = [
    'draft', 'open', 'prospect', 'planned', 'uploaded', 'imported',
    // The middle of a priority scale, and the bottom of it. Colouring "medium"
    // would mean three of three priorities are coloured, which is none of them.
    'C', 'normal', 'medium', 'low',
    'superseded', 'file', 'other',
];

const WORKFLOW_TONES = {
    /* good end states, and healthy current ones */
    qualified: 'success',
    customer: 'success',
    won: 'success',
    signed: 'success',
    accepted: 'success',
    approved: 'success',
    done: 'success',
    active: 'success',

    /* in flight — being worked, nothing wrong */
    engaged: 'accent',
    qualifying: 'accent',
    in_progress: 'accent',
    issued: 'accent',
    sent: 'accent',
    out_for_signature: 'accent',
    completed: 'accent',

    /**
     * Waiting on a person. `review_required` is amber for the same reason
     * REVIEW is amber in the verdict palette: it is a queue to work, and grey
     * would read as "ignore me".
     */
    review_required: 'warning',
    pending_review: 'warning',
    paused: 'warning',
    high: 'warning',
    B: 'warning',

    /* bad end states, and things to intervene in */
    lost: 'danger',
    rejected: 'danger',
    declined: 'danger',
    disqualified: 'danger',
    churned: 'danger',
    cancelled: 'danger',
    terminated: 'danger',
    expired: 'danger',
    urgent: 'danger',
    A: 'danger',
};

/**
 * Email verification tones are DERIVED from the classification that already
 * exists, never restated.
 *
 * `lib/verification.mjs` decides what each status means for sending — safe,
 * review, blocked — and that decision has been argued over. A second table
 * here saying "accept_all is amber" would be a copy of it that can drift, and
 * the drift would show up as a colour disagreeing with the words beside it.
 */
const VERIFICATION_TONES = Object.fromEntries(
    VERIFICATION_STATUS_META.map((s) => [
        s.status,
        { safe: 'success', review: 'warning', blocked: 'danger' }[s.classification] ?? null,
    ]).filter(([, tone]) => tone),
);

export const STATUS_TONES = { ...WORKFLOW_TONES, ...VERIFICATION_TONES };

/** The tone for a stored value, or null when it is deliberately unremarkable. */
export function toneFor(value) {
    return STATUS_TONES[String(value ?? '')] ?? null;
}

export const ACCOUNT_TYPES = ['Egypt', 'Regional'];
export const BILLING_CURRENCIES = ['USD', 'EGP', 'SAR'];
export const DEFAULT_BILLING_CURRENCY = { Egypt: 'EGP', Regional: 'USD' };

/**
 * The calling enums, restated rather than imported.
 *
 * `lib/calling.mjs` owns them, but importing it here would close a cycle —
 * calling imports repo, repo imports this file — and whichever module loaded
 * first would read the other's constants before they existed. Restating three
 * short lists is the lesser evil; `test.mjs` asserts these match their source,
 * so the copies cannot drift in silence.
 */
const CALLING_PRIORITIES = ['A', 'B', 'C'];
const CALLING_QUEUE_STATUSES = ['queued', 'working', 'done', 'closed'];
const CALLING_OUTCOME_KEYS = [
    'not_interested', 'no_answer', 'wrong_number', 'follow_up', 'send_profile',
    'qualified', 'meeting_scheduled', 'meeting_done', 'no_show',
];

/** The URL a stored slug stands for. The inverse of `companySlug`, for display. */
export function companyUrl(slug) {
    const value = String(slug ?? '').trim();
    return value ? `https://www.linkedin.com/company/${value}/` : '';
}

/**
 * Which evidence plane an object's verdicts live in.
 *
 * Accounts and prospects are both qualified by the same engine against the same
 * rules, but into separate tables — an account's verdict history must not be
 * rewritten when the prospect it came from is re-qualified. Before this map
 * existed, the filter compiler, the sort compiler and the row hydrator each
 * hardcoded `verdicts` / `account_id`, so a prospecting list could show a
 * verdict column that was permanently UNRESOLVED and filter on it to zero rows
 * with no error anywhere. The plane belongs to the OBJECT, so adding a third
 * qualifiable subject is one entry here rather than three greps.
 */
export function verdictPlane(objectKey) {
    return objectDef(objectKey).verdicts ?? null;
}

const f = (key, label, type, extra = {}) => ({
    key,
    label,
    type,
    // `'column' in extra` rather than `??`, so a field can say it has NO
    // column and mean it — a form-only field stored somewhere else entirely.
    column: 'column' in extra ? extra.column : key,
    optionsSource: extra.optionsSource ?? null,
    // The table a reference column points at. The repository checks the target
    // exists in the same workspace before writing, so a bad id from an import or
    // an API caller fails at the write rather than as a blank name on a page.
    references: extra.references ?? null,
    // A field can be required AND have a default: "required" means it must
    // never be empty, not that every caller has to say it. An import that omits
    // lifecycle should get `prospect`, not an error.
    default: extra.default ?? null,
    filterable: extra.filterable ?? true,
    sortable: extra.sortable ?? true,
    searchable: extra.searchable ?? false,
    options: extra.options ?? null,
    required: extra.required ?? false,
    readOnly: extra.readOnly ?? false,
    help: extra.help ?? null,
    // Set when a field is deliberately excluded from filtering, so the builder
    // can say why instead of just not showing it.
    excludedBecause: extra.excludedBecause ?? null,
    listDefault: extra.listDefault ?? false,
    form: extra.form ?? true,
    /**
     * A field stored in one shape and shown in another.
     *
     * `normalise` runs on the server on every write, so the API, the form and an
     * import all reduce a value the same way. `format` is a NAME rather than a
     * function because a field definition reaches the browser as JSON — the
     * client resolves it (see `FORMATS` in public/js/components.js).
     */
    normalise: extra.normalise ?? null,
    format: extra.format ?? null,

    /**
     * How the field is presented in a FORM, as opposed to what it holds.
     *
     * Every form in this product was a flat dump of the field list in registry
     * order, so creating an account asked for twenty things in one column with
     * External ID sitting at the same weight as Name. These three make a form
     * follow the shape of the work instead of the shape of the table.
     *
     * `group`    which section it belongs in. Fields with no group fall into
     *            the first section, so adding a group somewhere does not
     *            silently hide anything that has not been grouped yet.
     *
     * `advanced` true for the fields that exist for imports, integrations and
     *            the occasional correction. Rendered behind a disclosure, not
     *            removed — "where did External ID go" is a worse question than
     *            the field being one click away.
     *
     * `showWhen` a DECLARATION, never a function: a field definition crosses to
     *            the browser as JSON. `{ field, in: [...] }` means "show this
     *            only while that field holds one of these values". A loss
     *            reason on an open deal is a question with no answer, and a
     *            form that always asks it teaches people to ignore it.
     */
    group: extra.group ?? null,
    advanced: extra.advanced ?? false,
    showWhen: extra.showWhen ?? null,
});

/**
 * Email verification, identical on both people-objects.
 *
 * Shared rather than repeated because a contact does not change what
 * "accept-all" means by crossing the import boundary — and because the two
 * copies had already drifted: prospecting contacts carried a status, CRM
 * contacts carried nothing at all.
 *
 * All five are read-only in forms. They are the provider's answer, not an
 * opinion: someone typing "verified" into a box is exactly the fiction this
 * whole module exists to prevent. They change by running a check.
 */
/**
 * Lead scores, identical on accounts and prospecting companies.
 *
 * All read-only: a score is derived, and a hand-typed one is a lie that
 * outranks the model in every sorted list it appears in. They change by
 * rescoring.
 *
 * Only the overall score is a default column. Six score columns in one table
 * is a spreadsheet, not a list — the breakdown belongs on the record, where
 * there is room to say WHY.
 */
/**
 * `listDefault` on the headline score is a per-object decision, not a property
 * of scoring.
 *
 * On a prospecting company the lead score IS the point of the row — it is how a
 * list of uploaded companies gets triaged. On an Account the company has
 * already been chosen and imported, and the score is a number nobody acts on
 * again; it was taking a column from the facts that decide what to sell.
 */
function scoreFields({ listDefault = false } = {}) {
    const s = (key, label, extra = {}) => f(key, label, 'number', { readOnly: true, form: false, ...extra });
    return [
        s('score_overall', 'Lead score', { listDefault, help: 'Weighted from the components below, using the workspace scoring model.' }),
        s('score_qualification', 'Qualification score'),
        s('score_icp', 'ICP score'),
        s('score_size', 'Company size score'),
        s('score_industry', 'Industry score'),
        s('score_decision_maker', 'Decision maker score'),
        s('score_enrichment', 'Enrichment confidence'),
        f('scored_at', 'Scored at', 'datetime', { readOnly: true, form: false }),
    ];
}

function verificationFields() {
    return [
        /**
         * Named "Safe to send", not "Email verified".
         *
         * It is a boolean derived from the status, and only `verified` and
         * `deliverable` set it. Called "Email verified" it flatly contradicted
         * the column beside it: a check that came back `accept_all` SUCCEEDED —
         * the address was verified, and the answer was "this domain accepts
         * everything, so the mailbox is unproven". Reading "Accept-all" and
         * "Email verified: No" on one row makes the check look broken when it
         * worked. "Safe to send: No" is the same fact without the contradiction.
         */
        f('email_verified', 'Safe to send', 'checkbox', {
            // Not a default column: the status column beside it says everything
            // this one does and more. Still available to pick, filter and sort.
            readOnly: true,
            help: 'Derived from the verification status: only Verified and Deliverable count as safe. '
                + 'Accept-all, risky and unknown are real answers that are deliberately not treated as '
                + 'safe — the status column says which.',
        }),
        f('verification_status', 'Verification status', 'select', {
            options: VERIFICATION_STATUSES,
            // So the CRM's own wording ("Accept-all") is used everywhere rather
            // than a humanised key ("Accept all") in the table and a label in
            // the panel beside it.
            optionsSource: 'verification_statuses',
            listDefault: true,
            readOnly: true,
            help: 'The CRM\'s own vocabulary, mapped from whichever provider ran the check. Empty means '
                + 'nobody has checked yet, which is not the same as a bad address.',
        }),
        f('verification_provider', 'Verified by', 'text', { readOnly: true, form: false }),
        f('verification_confidence', 'Verification confidence', 'percent', { readOnly: true, form: false }),
        f('verified_at', 'Verified at', 'datetime', { readOnly: true, form: false }),
    ];
}

export const OBJECTS = {
    account: {
        key: 'account',
        label: 'Account',
        plural: 'Accounts',
        table: 'accounts',
        icon: 'building',
        titleField: 'name',
        route: 'accounts',
        verdicts: { table: 'verdicts', idColumn: 'account_id', subjectType: 'account' },
        // An Account is a company that has been through Prospecting and been
        // deliberately imported. Uploaded companies are NOT accounts — they live
        // in `prospecting_companies` until someone imports them, which is what
        // keeps the CRM clean enough for its numbers to be trusted.
        defaultFilter: { op: 'and', children: [{ field: 'lifecycle_stage', operator: 'is_none_of', value: ['disqualified'] }] },
        fields: [
            f('name', 'Name', 'text', { required: true, searchable: true, listDefault: true, group: 'Identity' }),
            f('legal_name', 'Legal name', 'text', { searchable: true, group: 'Identity', help: 'The registered name, often in Arabic.' }),
            f('lifecycle_stage', 'Lifecycle', 'select', { options: LIFECYCLE, listDefault: true, required: true, default: 'prospect', group: 'Identity' }),
            // Not a default column. A domain identifies a company to a machine;
            // the name already identifies it to the person reading the row.
            f('domain', 'Domain', 'text', { searchable: true, group: 'Identity' }),
            f('website', 'Website', 'url', { group: 'Identity' }),
            f('linkedin_slug', 'LinkedIn URL', 'text', {
                searchable: true, group: 'Identity',
                normalise: companySlug,
                format: 'linkedin_company',
                help: 'Paste the company page URL — linkedin.com/company/… — or just the slug. '
                    + 'It is stored as the slug, which is the identity the qualification engine collects against.',
            }),
            f('cr_number', 'CR number', 'text', { searchable: true, group: 'Identity', help: 'Commercial Registration — the strongest natural key for Saudi entities.' }),
            /**
             * The commercial grouping, and the currency, as two fields.
             *
             * Account Type is NOT location — `country` below is the address.
             * This is which side of the business owns the relationship, and it
             * is what the dashboard groups performance by.
             *
             * Billing Currency is what the client pays in. The type supplies a
             * default when an account is created (Egypt → EGP, Regional → USD)
             * and never overrides it afterwards, because a Regional client on
             * SAR is an ordinary arrangement rather than an exception.
             */
            /**
             * Mandatory, so "unassigned" stops being a state the business can
             * be in.
             *
             * `required` with a `default` rather than `required` alone, and the
             * difference matters. A bare requirement would refuse every write
             * that does not name a type — including `lib/promotion.mjs`, which
             * is how a qualified prospect becomes an account, and every
             * importer. The invariant would be bought by breaking the main way
             * accounts are created.
             *
             * With a default, the requirement is satisfied on create and
             * enforced on update: nothing can be SET to empty, and nothing
             * arrives empty. The form still marks it required, so a person
             * chooses rather than accepts. Same shape as `lifecycle_stage`
             * directly above.
             *
             * Regional is the default because most new accounts are. Anything
             * mis-typed is fixed in bulk from the accounts list — select the
             * rows, Edit, set the type — and the billing currency follows the
             * correction on its own unless somebody has already chosen one.
             * Change this one word if the balance of new business moves;
             * nothing else reads it.
             *
             * The existing book was backfilled to Regional before this, by
             * apply-account-type-backfill.mjs, which is a separate statement
             * about history and is not affected by the default for new rows.
             */
            f('account_type', 'Account type', 'select', {
                group: 'Commercial',
                options: ACCOUNT_TYPES, listDefault: true, required: true, default: 'Regional',
                help: 'Egypt or Regional — the commercial grouping the dashboard reports by. '
                    + 'Not the country: a company registered anywhere can be either.',
            }),
            f('billing_currency', 'Billing currency', 'select', {
                group: 'Commercial',
                options: BILLING_CURRENCIES, listDefault: true,
                help: 'What this client actually pays in. Defaults from the account type when the '
                    + 'account is created — Egypt to EGP, Regional to USD — and is freely editable after that.',
            }),
            // Multiple, because a company can genuinely buy Recruitment AND
            // Offshoring. A single service column forced a false choice that
            // every report then inherited.
            f('services', 'Services', 'multiselect', {
                group: 'Commercial',
                optionsSource: 'service_lines', listDefault: true,
                help: 'Every service this account qualifies for or buys. Not exclusive.',
            }),
            ...scoreFields(),
            f('industry', 'Industry', 'text', { listDefault: true, group: 'Firmographics' }),
            /**
             * Country and headcount are enrichment, not the row's identity.
             *
             * The account list opened with thirteen columns, and the three that
             * decide what can be SOLD to a company — its type, its currency and
             * the services it buys — were sitting among them at the same weight
             * as its employee count. Both stay one click away in the column
             * picker, and both are still filterable.
             */
            f('country', 'Country', 'text', { group: 'Firmographics' }),
            f('city', 'City', 'text', { group: 'Firmographics' }),
            f('employee_count', 'Employees', 'number', { group: 'Firmographics' }),
            f('phone', 'Phone', 'phone', { group: 'Firmographics' }),
            /**
             * THE PERSON AT THIS COMPANY — typed here, stored as a CONTACT.
             *
             * `column: null` is the whole point. These four are on the account
             * FORM, because "who do we know there" is the first thing anyone
             * enters when they add a company, and making them open a second screen
             * to record it is how a CRM fills up with accounts nobody can ring.
             * But an account does not OWN a person: a company has many contacts,
             * they move on, and a copy of a name on the accounts table is a second
             * answer to "what is their email" that starts disagreeing the day
             * somebody edits the contact.
             *
             * So they are validated like any other field, written to no column,
             * and `syncPrimaryContact` turns them into the account's contact —
             * created the first time, updated after that. On an account that
             * already has contacts they fill in from the earliest one, so opening
             * the form does not offer to make a duplicate.
             */
            // Listed before the parts so a file with a single name column
            // maps to the whole name rather than losing everything after the
            // first space — same reasoning as `contact.full_name` itself.
            f('contact_full_name', 'Contact name', 'text', {
                column: null, excludedBecause: 'it belongs to the contact — filter contacts by it',
                 filterable: false, sortable: false, group: 'Primary contact',
                help: 'Saved as a contact on this account, not on the account itself. First and last are derived from it automatically.',
            }),
            f('contact_first_name', 'First name', 'text', {
                column: null, excludedBecause: 'it belongs to the contact — filter contacts by it',
                 filterable: false, sortable: false, group: 'Primary contact',
                help: 'Saved as a contact on this account, not on the account itself.',
            }),
            f('contact_last_name', 'Last name', 'text', {
                column: null, excludedBecause: 'it belongs to the contact — filter contacts by it',
                 filterable: false, sortable: false, group: 'Primary contact',
            }),
            f('contact_title', 'Job Title', 'text', {
                column: null, excludedBecause: 'it belongs to the contact — filter contacts by it',
                 filterable: false, sortable: false, group: 'Primary contact',
            }),
            f('contact_email', 'Email', 'email', {
                column: null, excludedBecause: 'it belongs to the contact — filter contacts by it',
                 filterable: false, sortable: false, group: 'Primary contact',
            }),
            // Labelled distinctly from the account's own Phone/LinkedIn URL
            // above — both pairs sit in the same flat mapping dropdown during
            // import, and "Phone" twice with nothing to tell them apart is a
            // column mapped to the wrong one every time.
            f('contact_phone', 'Contact phone', 'phone', {
                column: null, excludedBecause: 'it belongs to the contact — filter contacts by it',
                 filterable: false, sortable: false, group: 'Primary contact',
            }),
            f('contact_linkedin_url', 'Contact LinkedIn', 'url', {
                column: null, excludedBecause: 'it belongs to the contact — filter contacts by it',
                 filterable: false, sortable: false, group: 'Primary contact',
                help: 'The person’s own LinkedIn profile — not the company page, which is the account’s LinkedIn URL above.',
            }),
            f('campaign_id', 'Source campaign', 'select', {
                group: 'Commercial', advanced: true,
                optionsSource: 'campaigns', references: 'campaigns',
                help: 'The campaign this company came from. Attribution stays on the record it applies to.',
            }),
            f('description', 'Description', 'textarea', { searchable: true, filterable: false, sortable: false, group: 'Firmographics', excludedBecause: 'Long free text is searched, not filtered.' }),
            f('owner_id', 'Owner', 'user', { listDefault: true, group: 'Identity' }),
            // The plumbing: written by imports and integrations, corrected by hand
            // about once a year. Present, and out of the way. Named to match the
            // contact object's own required field — a contact created under this
            // account with no data source of its own inherits this value (see
            // `createRecord` in lib/repo.mjs).
            f('source', 'Data source', 'text', { group: 'Firmographics', advanced: true }),
            f('external_id', 'External ID', 'text', { group: 'Firmographics', advanced: true, help: 'Re-importing the same source with the same ID updates instead of duplicating.' }),
            // A default column so sorting the list by when an account arrived
            // — newest first to see what just came in, oldest first to see
            // what has been sitting the longest — is one click on the column
            // header, not a trip through the column picker first.
            f('created_at', 'Created', 'datetime', { readOnly: true, form: false, listDefault: true }),
            f('updated_at', 'Updated', 'datetime', { readOnly: true, form: false }),
        ],
        // Computed columns joined in by the repository. Filterable through
        // dedicated SQL, never through the generic column path.
        /**
         * Verdicts are not default columns on an ACCOUNT.
         *
         * They are on prospecting companies, where the verdict is the whole
         * reason the row is on screen. An Account has already passed that gate
         * — somebody read the verdict and deliberately imported the company —
         * and from then on the questions are commercial. Two verdict columns on
         * a signed customer are two columns of history.
         *
         * Nothing is hidden: both remain sortable, filterable and one click
         * away in the column picker, the account page still shows the verdict
         * panel, and the Prospecting list is unchanged.
         */
        computed: {
            verdict_hcm: { label: 'HCM verdict', type: 'select', options: VERDICTS, kind: 'verdict', rule: 'hcm', sortable: true },
            verdict_offshoring: { label: 'Offshoring verdict', type: 'select', options: VERDICTS, kind: 'verdict', rule: 'offshoring', sortable: true },
            // Promoted to a default: "does anyone owe this company anything" is
            // the question a rep scanning the list is actually asking.
            open_deals: { label: 'Open deals', type: 'number', kind: 'count', listDefault: true, sortable: false, filterable: false, excludedBecause: 'Derived per row; filter on Deals instead.' },
        },
    },

    prospecting_company: {
        key: 'prospecting_company',
        label: 'Prospecting company',
        plural: 'Prospecting companies',
        table: 'prospecting_companies',
        icon: 'building',
        titleField: 'name',
        route: 'prospects',
        verdicts: { table: 'prospecting_verdicts', idColumn: 'prospect_id', subjectType: 'prospect' },
        // No default filter, deliberately. Prospecting is the historical record
        // of every company ever uploaded; hiding any of it by default is how a
        // company goes missing and the upload gets blamed.
        defaultFilter: { op: 'and', children: [] },
        fields: [
            f('name', 'Name', 'text', { required: true, searchable: true, listDefault: true }),
            f('domain', 'Domain', 'text', { searchable: true, listDefault: true }),
            f('website', 'Website', 'url'),
            f('linkedin_slug', 'LinkedIn URL', 'text', {
                searchable: true,
                normalise: companySlug,
                format: 'linkedin_company',
                help: 'Paste the company page URL, or just the slug. Stored as the slug, which is what '
                    + 'qualification and collection use.',
            }),
            f('services', 'Services', 'multiselect', {
                optionsSource: 'service_lines',
                help: 'Every service this company qualifies for. Carried across on import.',
            }),
            // Here the score IS the row's purpose — this is the list somebody
            // triages. On an Account it is not; see scoreFields().
            ...scoreFields({ listDefault: true }),
            f('industry', 'Industry', 'text', { listDefault: true }),
            f('country', 'Country', 'text', { listDefault: true }),
            f('city', 'City', 'text'),
            f('employee_count', 'Employees', 'number', { listDefault: true }),
            f('phone', 'Phone', 'phone'),
            f('campaign_id', 'Campaign', 'select', { optionsSource: 'campaigns', references: 'campaigns' }),
            f('owner_id', 'Owner', 'user', { listDefault: true }),
            f('source', 'Source', 'text'),
            f('external_id', 'External ID', 'text'),
            // System-set by the importer, never by hand — the link Upload History
            // uses to answer "which companies did this file bring in?" as a plain
            // filter rather than a bespoke join, and it is what makes deleting an
            // upload (lib/import.mjs deleteUpload) able to find its own rows.
            f('import_batch_id', 'Upload', 'reference', {
                references: 'import_batches', readOnly: true, form: false, sortable: false,
                help: 'The upload this company arrived in.',
            }),
            /**
             * DERIVED, never typed. A single writer — recomputeStatus() in
             * lib/qualification.mjs — owns this column, and it is a cache of the
             * per-service verdicts, not a second opinion about them.
             *
             * It has to be derived because qualification is PER SERVICE. This
             * dataset has 67 companies qualifying for Offshoring and 27 for HCM,
             * with a small overlap; a company that is QUALIFIED for one and
             * REJECTED for the other cannot be written into one column without
             * destroying the more valuable answer. So the rollup states the
             * optimistic truth — "qualified" means qualified for AT LEAST ONE
             * service — and the per-rule verdicts underneath stay authoritative
             * for every decision that matters (which campaign, which pitch).
             *
             * It is a stored column rather than a SQL expression only so the
             * six Prospecting tabs stay an indexed equality filter at 50k rows.
             */
            f('status', 'Status', 'select', {
                options: ['uploaded', 'qualifying', 'qualified', 'review_required', 'rejected', 'imported'],
                listDefault: true, readOnly: true, form: false, default: 'uploaded',
                help: 'Derived from the per-service verdicts. "Qualified" means qualified for at least one service — '
                    + 'open the record to see which. Set by the engine, never by hand.',
            }),
            f('score', 'Lead score', 'number'),
            f('duplicated', 'Duplicate status', 'text'),
            f('duplicate_of_id', 'Duplicate of', 'reference', { references: 'prospecting_companies' }),
            f('imported_account_id', 'Imported account', 'reference', { references: 'accounts' }),
            f('imported_at', 'Imported at', 'datetime', { readOnly: true, form: false }),
            f('created_at', 'Created', 'datetime', { readOnly: true, form: false }),
            f('updated_at', 'Updated', 'datetime', { readOnly: true, form: false }),
        ],
        computed: {
            verdict_hcm: { label: 'HCM verdict', type: 'select', options: VERDICTS, kind: 'verdict', rule: 'hcm', listDefault: true, sortable: true },
            verdict_offshoring: { label: 'Offshoring verdict', type: 'select', options: VERDICTS, kind: 'verdict', rule: 'offshoring', listDefault: true, sortable: true },
        },
    },

    contact: {
        key: 'contact',
        label: 'Contact',
        plural: 'Contacts',
        table: 'contacts',
        icon: 'user',
        titleField: 'full_name',
        route: 'contacts',
        /**
         * What this object looks like when it is listed INSIDE its parent.
         *
         * A related table used to take the first six `listDefault` columns,
         * which put an "Account" column on the account's own Contacts tab —
         * the same company name repeated down a page already headed by it.
         * Here the parent is the context, so the columns are the ones that
         * distinguish these children FROM EACH OTHER.
         */
        relatedColumns: ['full_name', 'title', 'email', 'phone', 'services'],
        fields: [
            f('full_name', 'Full name', 'text', {
                searchable: true, listDefault: true,
                help: 'The name as it is actually written. First and last are derived from it for sorting and greetings; this one is what the person is called.',
            }),
            f('first_name', 'First name', 'text', { searchable: true }),
            // Full name is already a default column, and it contains this one.
            // Showing both spent a column saying the same thing twice.
            f('last_name', 'Last name', 'text', { searchable: true }),
            f('title', 'Job title', 'text', { searchable: true, listDefault: true }),
            f('account_id', 'Account', 'reference', { listDefault: true, filterable: true, sortable: false }),
            f('email', 'Email', 'email', { searchable: true, listDefault: true }),
            // A contact list without a phone number is a list you cannot work
            // from — and this is the object the calling queue is built out of.
            f('phone', 'Phone', 'phone', { listDefault: true }),
            f('linkedin_url', 'LinkedIn', 'url'),
            f('roles', 'Roles', 'multiselect', {
                options: ['primary', 'decision_maker', 'champion', 'influencer', 'blocker', 'billing', 'technical'],
                help: 'Flags, not one exclusive type — someone is often both the primary contact and a decision maker.',
            }),
            // Which service(s) this person is a buyer for — multiple, same
            // shape as the account's own `services` (not exclusive: a
            // contact can be the HCM AND the Recruitment buyer). The same
            // company often has one contact for Recruitment and a different
            // one for HCM, which is why this belongs on the person at all
            // and not only on the account; it used to be a single select,
            // which forced a false either/or choice the account's own
            // field never had.
            f('services', 'Services', 'multiselect', {
                optionsSource: 'service_lines', listDefault: true,
                help: 'Every service this person is a buyer for. Not exclusive — someone can be the HCM contact at a company you also recruit for.',
            }),
            // Where they came from is attribution — a reporting question, not
            // one asked while scanning a list of people to contact.
            f('campaign_id', 'Campaign', 'select', {
                optionsSource: 'campaigns', references: 'campaigns',
                help: 'The campaign that sourced this contact. Membership of other campaigns is tracked separately — this is where they came from.',
            }),
            f('is_active', 'Active', 'checkbox', { listDefault: true }),
            f('data_source', 'Data source', 'text', { required: true, help: 'Where this person’s details came from. Required: personal data carries obligations a company record does not.' }),
            f('acquired_at', 'Acquired', 'date'),
            ...verificationFields(),
            // Every other object shows its owner by default. "Whose contact is
            // this?" is asked before anybody rings it.
            f('owner_id', 'Owner', 'user', { listDefault: true }),
            // A default column for the same reason as `account.created_at`:
            // one click on the header sorts contacts newest- or oldest-first.
            f('created_at', 'Created', 'datetime', { readOnly: true, form: false, listDefault: true }),
            f('updated_at', 'Updated', 'datetime', { readOnly: true, form: false }),
        ],
        computed: {
            /**
             * Whether this contact currently has a LIVE row on someone's
             * cold calling queue — not a column, because "on the queue" is
             * a fact about `calling_assignments`, not about the contact row
             * itself, and a contact can move on and off it many times over
             * its life. Filterable so a manager can ask "which contacts have
             * never been added" or "which are currently being worked"
             * straight from the Contacts list, without opening Cold Calling
             * at all.
             */
            in_calling_queue: {
                label: 'Cold calling queue', type: 'select', options: ['in_queue', 'not_in_queue'],
                kind: 'calling_queue', sortable: false,
            },
        },
    },

    prospecting_contact: {
        key: 'prospecting_contact',
        label: 'Prospecting contact',
        plural: 'Prospecting contacts',
        table: 'prospecting_contacts',
        icon: 'user',
        titleField: 'full_name',
        route: 'prospecting_contacts',
        fields: [
            f('full_name', 'Full name', 'text', {
                searchable: true, listDefault: true,
                help: 'The name as it is actually written. First and last are derived from it for sorting and greetings; this one is what the person is called.',
            }),
            f('first_name', 'First name', 'text', { searchable: true }),
            f('last_name', 'Last name', 'text', { searchable: true, listDefault: true }),
            f('title', 'Job title', 'text', { searchable: true, listDefault: true }),
            f('prospect_id', 'Prospect', 'reference', { listDefault: true, sortable: false, references: 'prospecting_companies' }),
            f('email', 'Email', 'email', { searchable: true, listDefault: true }),
            f('phone', 'Phone', 'phone'),
            f('linkedin_url', 'LinkedIn', 'url'),
            f('roles', 'Roles', 'multiselect', {
                options: ['primary', 'decision_maker', 'champion', 'influencer', 'blocker', 'billing', 'technical'],
                help: 'Flags, not one exclusive type — someone is often both the primary contact and a decision maker.',
            }),
            f('service_line_key', 'Service', 'select', { optionsSource: 'service_lines', listDefault: true }),
            f('campaign_id', 'Campaign', 'select', { optionsSource: 'campaigns', references: 'campaigns', listDefault: true }),
            f('data_source', 'Data source', 'text', { required: true, help: 'Where this person’s details came from.' }),
            f('acquired_at', 'Acquired', 'date'),
            ...verificationFields(),
            f('owner_id', 'Owner', 'user'),
            /**
             * The provider's own id for this person — Apollo's, when that is
             * where they came from.
             *
             * Not typed by hand: it exists so a second search that surfaces the
             * same person again can be recognised as the same person rather
             * than filed as a new one, the same reason accounts and companies
             * carry one. See prospecting_company's own `external_id`.
             */
            f('external_id', 'External ID', 'text', { form: false }),
            f('import_batch_id', 'Upload', 'reference', {
                references: 'import_batches', readOnly: true, form: false, sortable: false,
            }),
            f('created_at', 'Created', 'datetime', { readOnly: true, form: false }),
            f('updated_at', 'Updated', 'datetime', { readOnly: true, form: false }),
        ],
    },

    deal: {
        key: 'deal',
        label: 'Deal',
        plural: 'Deals',
        table: 'deals',
        icon: 'target',
        titleField: 'name',
        route: 'deals',
        // On an account, what distinguishes one deal from another is where it
        // is and what it is worth — not which company it belongs to.
        relatedColumns: ['name', 'service_line_key', 'stage_id', 'status', 'price', 'billing_type'],
        fields: [
            /**
             * Generated as `Company Name - Service Name`, and therefore not
             * required: `createRecord` fills it from the account and the
             * service before the not-null check runs. Still editable, because
             * a second HCM deal with the same client needs a way to be told
             * apart — and a name somebody typed is never regenerated.
             */
            f('name', 'Name', 'text', {
                searchable: true, listDefault: true, group: 'The deal',
                help: 'Leave empty and it becomes "Company - Service".',
            }),
            f('account_id', 'Account', 'reference', { listDefault: true, sortable: false, references: 'accounts', group: 'The deal' }),
            /**
             * Not on the form. There is one pipeline, so it is not a question.
             *
             * It was a required-looking dropdown offering a single choice, on
             * every deal anybody created. The column stays — deals live in a
             * pipeline and the board reads it — and `createRecord` fills it
             * with the workspace default, so raising a deal the moment a
             * meeting is booked asks for a name and a stage and nothing else.
             *
             * Still filterable and sortable: a workspace that adds a second
             * pipeline later can slice by it without this changing back.
             */
            f('pipeline_id', 'Pipeline', 'reference', {
                optionsSource: 'pipelines', group: 'Where it is', form: false,
            }),
            f('stage_id', 'Stage', 'reference', { listDefault: true, sortable: false, optionsSource: 'stages', group: 'Where it is' }),
            f('status', 'Status', 'select', { options: ['open', 'won', 'lost'], listDefault: true, group: 'Where it is' }),
            f('service_line_key', 'Service line', 'select', { optionsSource: 'service_lines', listDefault: true, group: 'The deal' }),
            f('campaign_id', 'Campaign', 'select', {
                optionsSource: 'campaigns', references: 'campaigns', group: 'The deal', advanced: true,
                help: 'Which campaign this deal is attributed to. A campaign that cannot be traced to revenue is a cost centre with a chart.',
            }),
            /**
             * A currency is CHOSEN, not typed.
             *
             * It was free text, so "SR", "usd" and "Dollar" were all accepted
             * and none of them matches a reporting rate — the dashboard
             * converts to USD from a rate keyed by exactly these three codes,
             * so a typo did not fail loudly, it quietly dropped the deal out
             * of the converted total. The list is the same one the account's
             * billing currency uses, and `reportingRates` has a rate for every
             * member of it.
             */
            f('currency', 'Currency', 'select', {
                options: BILLING_CURRENCIES, group: 'The deal', readOnly: true,
                help: 'Locked to the account\'s billing currency.',
            }),
            f('probability', 'Probability override', 'percent', {
                group: 'Where it is', advanced: true,
                help: 'Leave empty to use the stage probability.',
            }),
            // Only worth asking once there IS an override to explain.
            f('probability_reason', 'Override reason', 'text', {
                group: 'Where it is', advanced: true,
                showWhen: { field: 'probability', isNotEmpty: true },
            }),
            f('close_date', 'Expected close', 'date', { listDefault: true, group: 'Where it is' }),
            f('closed_at', 'Closed', 'datetime', { readOnly: true, form: false }),
            /**
             * Asked when the deal is lost, and not before.
             *
             * The stage move already refuses to close a deal as lost without
             * one — this is the same rule expressed in the form, so the field
             * stops sitting on every open deal as a question nobody can answer.
             */
            f('loss_reason', 'Loss reason', 'select', {
                optionsSource: 'loss_reasons', group: 'Where it is',
                showWhen: { field: 'status', in: ['lost'] },
            }),
            f('owner_id', 'Owner', 'user', { listDefault: true, group: 'The deal' }),
            f('created_by', 'Created by', 'user', {
                form: false, group: 'The deal',
                help: 'Who raised this deal. An automatically created one says so — it is stamped with whoever '
                    + 'generated the agreement that needed it.',
            }),
            f('external_id', 'External ID', 'text', { group: 'Where it is', advanced: true }),
            f('created_at', 'Created', 'datetime', { readOnly: true, form: false }),
            f('updated_at', 'Updated', 'datetime', { readOnly: true, form: false }),
        ],
        /**
         * Four separate figures, never one. A single "value" column is how a
         * dashboard ends up adding a placement fee to 24 months of retainer.
         *
         * Each names the column it is CACHED into, which is what makes "my
         * biggest open deals" a sort rather than an impossibility. The value
         * displayed is still derived from the line items on every read — see
         * `syncDealValues` in lib/repo.mjs for why that ordering is what makes
         * caching money safe.
         */
        computed: {
            /**
             * DEAL SIZE. One price, in one currency.
             *
             * It has no column of its own — it lives in the deal's single line
             * item — so it cannot be sorted or filtered in SQL, and says so
             * rather than offering a filter that would quietly match nothing.
             * The rollups below are the sortable projections of it.
             */
            price: {
                label: 'Deal size', type: 'currency', kind: 'money', listDefault: true,
                filterable: false, sortable: false,
                excludedBecause: 'Deal size is held on the deal\'s priced line. Filter or sort on One-time or MRR, which are cached columns.',
            },
            /**
             * Recurring or one-time, decided by the SERVICE.
             *
             * Not a stored field and not a choice: HCM and Offshoring repeat,
             * Recruitment and OD do not, and `service_lines.pricing_model` is
             * where that is written down. Filter on Service line instead —
             * there is no state here a filter could find that the service does
             * not already answer.
             */
            billing_type: {
                label: 'Billing', type: 'select', kind: 'text', listDefault: true,
                options: ['one_time', 'recurring'],
                filterable: false, sortable: false,
                excludedBecause: 'Billing follows the service. Filter on Service line.',
            },
            value_one_time: { label: 'One-time', type: 'currency', kind: 'money', column: 'value_one_time', filterable: true, sortable: true },
            value_mrr: { label: 'MRR', type: 'currency', kind: 'money', column: 'value_mrr', listDefault: true, filterable: true, sortable: true },
            value_arr: { label: 'ARR', type: 'currency', kind: 'money', column: 'value_arr', filterable: true, sortable: true },
            value_weighted: { label: 'Weighted one-time', type: 'currency', kind: 'money', column: 'value_weighted', filterable: true, sortable: true },
            deal_value: {
                label: 'Deal value', type: 'currency', kind: 'money', listDefault: true,
                filterable: false, sortable: false,
                excludedBecause: 'Deal value is derived dynamically from the most recent associated proposal or agreement.',
            },
        },
    },

    task: {
        key: 'task',
        label: 'Task',
        plural: 'Tasks',
        table: 'tasks',
        icon: 'check',
        titleField: 'title',
        route: 'tasks',
        fields: [
            f('title', 'Title', 'text', { required: true, searchable: true, listDefault: true }),
            f('description', 'Description', 'textarea', { searchable: true, filterable: false, sortable: false, excludedBecause: 'Long free text is searched, not filtered.' }),
            f('status', 'Status', 'select', { options: ['open', 'in_progress', 'done', 'cancelled'], listDefault: true }),
            f('priority', 'Priority', 'select', { options: ['A', 'B', 'C'], listDefault: true }),
            f('assignee_id', 'Assignee', 'user', { listDefault: true }),
            f('due_at', 'Due', 'datetime', { listDefault: true }),
            f('account_id', 'Account', 'reference', { listDefault: true, sortable: false }),
            /**
             * WHO IT IS FOR and WHO ASKED, as two separate questions.
             *
             * "Show me Ahmed's tasks" and "show me the tasks Sara raised" are
             * different questions with different answers, and a manager needs
             * both — one is workload, the other is who is generating it. Only
             * `assignee_id` existed, so the second could not be asked at all.
             *
             * Not on the form: it is stamped by the write, and a "created by"
             * box somebody can set is not a record of who created it.
             */
            f('created_by', 'Created by', 'user', {
                form: false, listDefault: false,
                help: 'Who raised this task. Stamped on creation and never edited.',
            }),
            f('completed_at', 'Completed', 'datetime', { readOnly: true, form: false }),
            f('created_at', 'Created', 'datetime', { readOnly: true, form: false }),
        ],
    },

    activity: {
        key: 'activity',
        label: 'Activity',
        plural: 'Activities',
        table: 'activities',
        icon: 'activity',
        titleField: 'subject',
        route: 'activities',
        fields: [
            f('type_key', 'Type', 'select', { optionsSource: 'activity_types', listDefault: true }),
            f('subject', 'Subject', 'text', { searchable: true, listDefault: true }),
            f('body', 'Details', 'textarea', { searchable: true, filterable: false, sortable: false, excludedBecause: 'Long free text is searched, not filtered.' }),
            f('occurred_at', 'Occurred', 'datetime', { listDefault: true, required: true, help: 'When it actually happened — not when it was typed in.' }),
            f('direction', 'Direction', 'select', { options: ['inbound', 'outbound'] }),
            f('duration_minutes', 'Duration (min)', 'number'),
            f('account_id', 'Account', 'reference', { listDefault: true, sortable: false }),
            /**
             * `actor_id` is who DID it. `created_by` is who typed it in.
             *
             * They are the same person most of the time and diverge exactly
             * when it matters: a manager logging a meeting on a rep's behalf,
             * an import carrying somebody else's week in. Filtering by
             * "performed by" and by "created by" are both offered because both
             * are asked.
             */
            f('actor_id', 'Performed by', 'user', {
                listDefault: true,
                help: 'Who made the call or took the meeting — not necessarily who typed it in.',
            }),
            f('created_by', 'Created by', 'user', {
                form: false,
                help: 'Who entered this activity. Stamped on creation and never edited.',
            }),
            f('created_at', 'Created', 'datetime', { readOnly: true, form: false }),
        ],
    },

    note: {
        key: 'note',
        label: 'Note',
        plural: 'Notes',
        table: 'notes',
        icon: 'note',
        titleField: 'body',
        route: 'notes',
        fields: [
            f('body', 'Note', 'textarea', { required: true, searchable: true, filterable: false, sortable: false, excludedBecause: 'Long free text is searched, not filtered.' }),
            f('pinned', 'Pinned', 'checkbox', { listDefault: true }),
            f('account_id', 'Account', 'reference', { listDefault: true, sortable: false }),
            f('author_id', 'Author', 'user', { listDefault: true }),
            f('created_by', 'Created by', 'user', {
                form: false,
                help: 'Who entered this note. Usually the author, and not always.',
            }),
            f('created_at', 'Created', 'datetime', { readOnly: true, listDefault: true, form: false }),
        ],
    },

    document: {
        key: 'document',
        label: 'Document',
        plural: 'Documents',
        table: 'documents',
        icon: 'file',
        titleField: 'name',
        route: 'documents',
        fields: [
            f('name', 'Name', 'text', { required: true, searchable: true, listDefault: true }),
            f('kind', 'Kind', 'select', { options: ['file', 'proposal', 'agreement', 'generated'], listDefault: true }),
            f('mime', 'Type', 'text', { listDefault: true }),
            f('size_bytes', 'Size', 'number', { listDefault: true }),
            f('account_id', 'Account', 'reference', { listDefault: true, sortable: false }),
            f('uploaded_by', 'Uploaded by', 'user', { listDefault: true }),
            f('created_at', 'Uploaded', 'datetime', { readOnly: true, listDefault: true, form: false }),
        ],
    },

    proposal: {
        key: 'proposal',
        label: 'Proposal',
        plural: 'Proposals',
        table: 'proposals',
        icon: 'doc',
        titleField: 'title',
        route: 'proposals',
        // Listed under a deal, so neither the deal nor the account is news.
        relatedColumns: ['number', 'title', 'type', 'status', 'current_version', 'created_at'],
        fields: [
            f('number', 'Number', 'text', { listDefault: true, readOnly: true }),
            f('title', 'Title', 'text', { required: true, searchable: true, listDefault: true }),
            /**
             * `pending_review`, `approved` and `rejected` sit between drafting
             * and issuing, because the person who writes a proposal is not the
             * person who commits the company to it.
             *
             * They are values in THIS column rather than a second review field,
             * so there is exactly one answer to "where is this document" and no
             * way for two fields to disagree. Everything from `issued` onward is
             * unchanged — those statuses record things that happened between two
             * companies, and review happens before any of them.
             */
            f('status', 'Status', 'select', {
                options: ['draft', 'pending_review', 'approved', 'rejected', 'issued', 'sent', 'accepted', 'declined', 'superseded'],
                listDefault: true,
            }),
            f('current_version', 'Version', 'number', { listDefault: true, readOnly: true }),
            // Set when this proposal is written from a .docx template, empty
            // when it is built from a deal's line items. Read-only either way:
            // it is what the record IS, not a property somebody picks.
            f('document_type', 'Template', 'text', { readOnly: true, listDefault: true }),
            f('deal_id', 'Deal', 'reference', { listDefault: true, sortable: false }),
            f('account_id', 'Account', 'reference', { listDefault: true, sortable: false }),
            f('currency', 'Currency', 'select', { options: BILLING_CURRENCIES }),
            f('owner_id', 'Owner', 'user', { listDefault: true }),
            /**
             * The normal, commercial proposal a customer reads — or the
             * Internal Team Proposal `ensureInternalTeamProposal`
             * (lib/internal-proposal.mjs) raises automatically once the
             * agreement it comes from is signed. System-set, never a form
             * choice: a rep renaming a proposal to "Internal Team Proposal"
             * must not make the UI treat it as the automation's own record,
             * and the reverse — the automation's record read as an ordinary
             * quote — is exactly the mistake that would leak a price.
             */
            f('type', 'Type', 'select', {
                options: ['standard', 'internal_team'], readOnly: true, form: false, listDefault: true,
            }),
            f('source_proposal_id', 'Source proposal', 'reference', {
                references: 'proposals', readOnly: true, form: false, sortable: false,
                help: 'The customer-facing proposal this Internal Team Proposal was generated from.',
            }),
            f('source_agreement_id', 'Source agreement', 'reference', {
                references: 'agreements', readOnly: true, form: false, sortable: false,
                help: 'The agreement whose signing raised this Internal Team Proposal.',
            }),
            f('created_at', 'Created', 'datetime', { readOnly: true, form: false }),
        ],
    },

    /**
     * Campaigns.
     *
     * A record, not a picklist — it has an owner, a budget, a membership and a
     * result. Source attribution only: this system does not send anything, it
     * records that an outbound push happened, who it reached and what it
     * produced. That boundary is what keeps it a CRM rather than a half-built
     * marketing platform.
     */
    campaign: {
        key: 'campaign',
        label: 'Campaign',
        plural: 'Campaigns',
        table: 'campaigns',
        icon: 'megaphone',
        titleField: 'name',
        route: 'campaigns',
        fields: [
            f('name', 'Name', 'text', { required: true, searchable: true, listDefault: true }),
            f('status', 'Status', 'select', {
                options: ['planned', 'active', 'paused', 'completed', 'cancelled'],
                listDefault: true, required: true, default: 'planned',
            }),
            f('channel', 'Channel', 'select', {
                options: ['linkedin', 'email', 'event', 'referral', 'paid', 'partner', 'other'],
                listDefault: true,
            }),
            f('service_line_key', 'Service', 'select', { optionsSource: 'service_lines', listDefault: true }),
            f('rule_key', 'Built from rule', 'select', {
                optionsSource: 'rules',
                help: 'Set when the audience was drawn from a qualification rule. This is what closes the loop from ICP rule to revenue.',
            }),
            f('start_date', 'Starts', 'date', { listDefault: true }),
            f('end_date', 'Ends', 'date', { listDefault: true }),
            f('budget_amount', 'Budget', 'currency'),
            f('currency', 'Currency', 'select', { options: BILLING_CURRENCIES, default: null }),
            f('goal', 'Goal', 'text', { help: 'What this campaign is for, in one line. Reported against, not decoration.' }),
            f('description', 'Description', 'textarea', {
                searchable: true, filterable: false, sortable: false,
                excludedBecause: 'Long free text is searched, not filtered.',
            }),
            f('owner_id', 'Owner', 'user', { listDefault: true }),
            f('key', 'Key', 'text', { help: 'An optional stable handle, so an import can name this campaign without knowing its id.' }),
            f('external_id', 'External ID', 'text'),
            f('created_at', 'Created', 'datetime', { readOnly: true, form: false }),
            f('updated_at', 'Updated', 'datetime', { readOnly: true, form: false }),
        ],
        computed: {
            member_count: {
                label: 'Members', type: 'number', kind: 'count', listDefault: true,
                filterable: false, sortable: false,
                excludedBecause: 'Derived per row; filter on campaign membership from the Contacts list instead.',
            },
            // One-time and recurring are SEPARATE figures here for the same
            // reason they are on a deal: a placement fee and 24 months of
            // retainer are not one number, and a campaign ROI that adds them is
            // wrong in the direction that flatters the campaign.
            influenced_one_time: {
                label: 'Won one-time', type: 'currency', kind: 'money',
                filterable: false, sortable: false, excludedBecause: 'Derived from attributed deals.',
            },
            influenced_mrr: {
                label: 'Won MRR', type: 'currency', kind: 'money',
                filterable: false, sortable: false, excludedBecause: 'Derived from attributed deals.',
            },
        },
    },

    agreement: {
        key: 'agreement',
        label: 'Agreement',
        plural: 'Agreements',
        table: 'agreements',
        icon: 'shield',
        titleField: 'title',
        route: 'agreements',
        fields: [
            f('number', 'Number', 'text', { listDefault: true }),
            f('title', 'Title', 'text', { required: true, searchable: true, listDefault: true }),
            f('type', 'Type', 'select', { options: ['msa', 'sow', 'renewal', 'amendment'], listDefault: true }),
            // Review comes before signature, for the same reason it comes
            // before issuing a proposal: a signed agreement is a commitment.
            f('status', 'Status', 'select', {
                options: ['draft', 'pending_review', 'approved', 'rejected', 'out_for_signature', 'signed', 'expired', 'terminated'],
                listDefault: true,
            }),
            // As on proposals: set when this agreement is written from a .docx
            // template, and read-only because it is what the record is.
            f('document_type', 'Template', 'text', { readOnly: true, listDefault: true }),
            f('account_id', 'Account', 'reference', { listDefault: true, sortable: false }),
            f('deal_id', 'Deal', 'reference', { sortable: false }),
            f('effective_date', 'Effective', 'date', { listDefault: true }),
            f('expiry_date', 'Expires', 'date', { listDefault: true }),
            /**
             * What the client pays, for which service, in which currency.
             *
             * This is what makes an agreement answer "map the HCM clients and
             * what they are worth" — a question the CRM could not previously be
             * asked, because a contract recorded its dates and its signature
             * and never its value.
             *
             * The currency is the CLIENT'S, copied from the account when the
             * agreement is created. It is not converted here and never will be:
             * the dashboard converts to USD for management, a contract keeps
             * what was signed.
             */
            f('service_line_key', 'Service', 'select', { optionsSource: 'service_lines', listDefault: true }),
            f('contract_value', 'Contract value', 'currency', {
                kind: 'money', listDefault: true,
                help: 'What the client pays under this contract, in their billing currency.',
            }),
            // A select, not free text: this column is what the USD dashboard
            // converts by, and a currency nobody holds a rate for is a contract
            // that silently vanishes from the converted total.
            f('currency', 'Billing currency', 'select', {
                options: BILLING_CURRENCIES,
                help: 'Copied from the account when the agreement is created, and editable if this one contract differs.',
            }),
            /**
             * Starts equal to the expiry date and then goes its own way.
             *
             * They are different questions — expiry is when the contract ends,
             * renewal is when the decision has to have been made — and the
             * moment one contract is renewed early, or a notice period is
             * negotiated, they part company for good. Defaulting one to the
             * other on creation is convenience; making them the same field
             * would be a modelling error.
             */
            f('renewal_date', 'Renewal date', 'date', {
                listDefault: true,
                help: 'When the renewal decision is due. Starts at the expiry date and can be moved.',
            }),
            f('notice_days', 'Notice (days)', 'number', { help: 'A 90-day notice on a 12-month contract means the decision point is month nine.' }),
            // `auto_renew` (whether a contract renews WITHOUT anyone acting)
            // was removed as a user-facing field — one renewal concept, not
            // two, and the one that actually drives the notice sweep. Off
            // retires this contract from it entirely, for a fixed-term
            // engagement that ends for good. Defaults on, because most
            // contracts are meant to renew and the common case should not
            // require a click. The `auto_renew` column itself is left in the
            // schema, unused, rather than dropped.
            f('renewable', 'Renewable', 'checkbox', {
                default: true,
                help: 'Off means this contract never raises a renewal notice — used when it is ending for good.',
            }),
            f('signed_at', 'Signed', 'datetime'),
            f('created_at', 'Created', 'datetime', { readOnly: true, form: false }),
        ],
    },
    /**
     * The cold calling queue.
     *
     * ── REGISTERED, BUT DELIBERATELY NOT ROUTED ─────────────────────────────
     *
     * This exists so the queue gets the SAME filter builder and column picker
     * every list has, both of which are driven from this registry. It is NOT in
     * `ROUTES` (api/records.mjs), so no `/api/calling_assignments` endpoint
     * appears: the rows keep coming from `/api/calling/queue`, which scopes
     * every read to the SDR who owns them. That matters — `lib/auth.mjs` confines
     * the `sdr` role to `/api/calling/*` precisely so the generic record API is
     * out of reach, and routing this object would have handed it back.
     *
     * `internal: true` also keeps it out of the two pickers that offer the user
     * a choice of object: which one a List targets, and which one a custom field
     * belongs to. Neither makes sense for a queue.
     *
     * ── THE JOINED COLUMNS ──────────────────────────────────────────────────
     *
     * A `column` carrying a dot is used verbatim by the query compiler, so the
     * fields people actually want to filter on — the contact's name and phone,
     * the company, the SDR — are filterable even though they live in tables the
     * queue joins rather than in `calling_assignments`. The aliases are the ones
     * `queue()` in lib/calling.mjs uses: c, acc, u.
     */
    calling_assignment: {
        key: 'calling_assignment',
        label: 'Queue entry',
        plural: 'Calling queue',
        table: 'calling_assignments',
        icon: 'phone',
        titleField: 'full_name',
        route: null,
        internal: true,
        /**
         * The aliases the fields below reach through, and the tables behind
         * them. Declared rather than implied so "every field maps to a real
         * column" stays checkable — the test resolves `c.full_name` to
         * `contacts.full_name` and confirms it exists. They match the joins in
         * `queue()`, lib/calling.mjs.
         */
        joins: { c: 'contacts', acc: 'accounts', u: 'users' },
        fields: [
            f('full_name', 'Contact', 'text', { column: 'c.full_name', searchable: true, listDefault: true }),
            f('account_name', 'Company', 'text', { column: 'acc.name', searchable: true, listDefault: true }),
            f('phone', 'Phone', 'phone', { column: 'c.phone', listDefault: true }),
            f('title', 'Job title', 'text', { column: 'c.title' }),
            f('email', 'Email', 'email', { column: 'c.email' }),
            // Lives on the contact (c.data_source — same field, same values
            // as the Contacts filter), so "show me the LinkedIn export" or
            // "just the cold-calling list" works from the queue exactly as
            // it does from Contacts, without opening the record.
            f('data_source', 'Data source', 'text', { column: 'c.data_source' }),
            /**
             * Which service(s) this lead is being called FOR.
             *
             * Lives on the contact (c.services — a contact can buy more than
             * one), so the queue shows the same services the record page
             * does — including on the Completed tab, where "what were we
             * selling when we worked this list" is half of what the tab is
             * for. Filterable like every other joined column, so "the HCM
             * queue" is a filter, not five queues.
             */
            f('services', 'Services', 'multiselect', {
                column: 'c.services', optionsSource: 'service_lines', listDefault: true,
            }),
            f('priority', 'Priority', 'select', { options: CALLING_PRIORITIES, listDefault: true }),
            f('queue_status', 'Queue status', 'select', { options: CALLING_QUEUE_STATUSES }),
            f('last_outcome', 'Last outcome', 'select', { options: CALLING_OUTCOME_KEYS, listDefault: true }),
            f('call_count', 'Calls', 'number'),
            f('last_called_at', 'Last called', 'datetime', { listDefault: true }),
            f('next_follow_up_at', 'Next follow-up', 'datetime', { listDefault: true }),
            f('sdr_name', 'Assigned to', 'text', { column: 'u.name', listDefault: true }),
            /**
             * The same fact as `sdr_name`, as a PERSON rather than as a string.
             *
             * A manager asking "what is Omar's queue doing" was filtering on a
             * name by substring — which picks a different Omar, misses the one
             * whose display name was edited, and offers a text box where every
             * other object offers a list of people. The name column stays
             * because it is what the table shows; this is what the filter
             * builder should reach for.
             */
            f('assigned_to', 'Assigned to (filter by person)', 'user', {
                form: false,
                help: '"Assigned to" is the column shown in the table. This is the same fact, as a person '
                    + 'to pick from a list rather than a name to search for — use this one to filter.',
            }),
            /**
             * WHO ACTUALLY RANG, as distinct from `assigned_to`.
             *
             * A manager covering one call on a colleague's queue, or a lead
             * reassigned after it was first worked, means the two can name
             * different people — "assigned to" is whose it is now, this is
             * who has actually been on the phone.
             */
            f('last_called_by', 'Performed by', 'user', {
                form: false,
                help: 'Whoever made the most recent call — not necessarily whoever it is assigned to now.',
            }),
            // A default column so the queue can be sorted newest- or
            // oldest-assigned in one click — the closest thing a queue entry
            // has to a "created" date, since the assignment IS when the lead
            // entered this queue.
            f('assigned_at', 'Assigned', 'datetime', { listDefault: true }),
            /**
             * Where this lead is in its follow-up sequence, and whether it is dead.
             *
             * Filterable because "show me the leads that have gone quiet" and
             * "show me who is mid-sequence" are the two questions a manager
             * asks of a calling floor, and neither could be asked of a column
             * that did not exist. See lib/follow-up.mjs.
             */
            f('sequence_step', 'Follow-ups done', 'number', {
                form: false,
                help: 'How many of the four follow-up activities are complete.',
            }),
            f('dead_at', 'Dead', 'datetime', {
                form: false,
                help: 'When the four-step sequence finished without converting. Empty means the lead is alive.',
            }),
        ],
        // Computed, same as account's verdict/count columns above: filled in
        // by the query in `queue()` (lib/calling.mjs), never through the
        // generic column path, so it has no `column` for the registry test
        // to chase.
        computed: {
            /**
             * Whichever of the contact's note, the account's note, and the
             * last call's note is most recent — not a list of the three, and
             * not always the same source from row to row, so a rep scanning
             * the queue sees what a colleague already found out ("gatekeeper
             * screens calls, try after 3pm" on the contact, "renewing in Q3"
             * on the account, or "asked us to call back Thursday" from the
             * last call) without opening the contact first. `queue()` fills
             * it with a UNION of all three ranked by when each landed, not a
             * LEFT JOIN: any one of them can have many rows, and a join
             * would multiply this one (or need its own GROUP BY/window
             * function to collapse back down), where the subquery just
             * answers "the latest of all three" directly.
             */
            notes: {
                label: 'Notes', type: 'text', listDefault: true, filterable: false, sortable: false,
                excludedBecause: 'Shows only the single latest note. Filter or sort from Notes instead.',
            },
        },
    },
};

export function objectDef(key) {
    const def = OBJECTS[key];
    if (!def) throw new Error(`Unknown object "${key}"`);
    return def;
}

/**
 * System fields plus this workspace's custom fields, merged.
 *
 * Custom fields live in the record's `properties` JSON and are addressed as
 * `properties.<key>` everywhere — filters, sorts, forms and the API all take
 * the same path, so nothing downstream needs to know which kind it is.
 */
/**
 * The custom fields, read once per workspace and object rather than per call.
 *
 * `fieldsFor` is called by every `listRecords`, every `fieldMap`, every filter
 * and sort compilation -- so one dashboard load asked the database for the same
 * `field_defs` rows fifty-seven times. On a file database that is free. In
 * production every statement is a blocking round trip to Turso, and fifty-seven
 * of them is most of the time the screen takes to appear.
 *
 * Safe to hold because this table is written from exactly two places, both in
 * api/meta.mjs, and both call `invalidateFieldDefs`. The cache is per process:
 * a script that writes custom fields out of band is not seen until the server
 * restarts, which is the same thing that was already true of anything else this
 * module holds in memory.
 */
const fieldDefCache = new Map();

/** Called whenever field_defs is written. Drops the whole workspace's entry. */
export function invalidateFieldDefs(workspaceId) {
    if (!workspaceId) { fieldDefCache.clear(); return; }
    for (const key of [...fieldDefCache.keys()]) {
        if (key.startsWith(`${workspaceId}:`)) fieldDefCache.delete(key);
    }
}

function customFieldRows(objectKey, workspaceId) {
    const key = `${workspaceId}:${objectKey}`;
    if (fieldDefCache.has(key)) return fieldDefCache.get(key);
    const rows = all(
        `SELECT * FROM field_defs
          WHERE workspace_id = ? AND object_key = ? AND deleted_at IS NULL AND is_system = 0
          ORDER BY position, label`,
        [workspaceId, objectKey],
    );
    fieldDefCache.set(key, rows);
    return rows;
}

export function fieldsFor(objectKey, workspaceId, { includeComputed = true } = {}) {
    const def = objectDef(objectKey);
    const custom = workspaceId
        ? customFieldRows(objectKey, workspaceId).map((row) => ({
            id: row.id,
            key: `properties.${row.key}`,
            label: row.label,
            type: row.type,
            column: null,
            property: row.key,
            custom: true,
            filterable: !!row.filterable,
            sortable: !!row.sortable,
            searchable: !!row.searchable,
            required: !!row.required,
            options: json(row.options, null),
            help: row.help,
            readOnly: false,
            form: true,
            listDefault: false,
            excludedBecause: row.filterable ? null : 'This custom field was created without filtering enabled.',
        }))
        : [];

    const computed = includeComputed && def.computed
        ? Object.entries(def.computed).map(([key, c]) => ({
            key,
            label: c.label,
            type: c.type,
            /**
             * A computed field may name a real column it is CACHED into.
             *
             * The value shown is still derived on read — that never changes.
             * But a figure the database also stores can be sorted and filtered
             * through the ordinary column path, which is the difference between
             * "the biggest open deals" being a question and being impossible.
             * Null keeps the old behaviour for everything that has no cache.
             */
            column: c.column ?? null,
            computed: c.kind,
            rule: c.rule ?? null,
            options: c.options ?? null,
            filterable: c.filterable ?? true,
            sortable: c.sortable ?? false,
            searchable: false,
            required: false,
            readOnly: true,
            form: false,
            listDefault: c.listDefault ?? false,
            excludedBecause: c.excludedBecause ?? null,
        }))
        : [];

    return [...def.fields, ...custom, ...computed];
}

export function fieldMap(objectKey, workspaceId) {
    const map = new Map();
    for (const field of fieldsFor(objectKey, workspaceId)) map.set(field.key, field);
    return map;
}

export function operatorsFor(type) {
    return OPERATORS[type] ?? OPERATORS.text;
}

export function defaultColumns(objectKey, workspaceId) {
    return fieldsFor(objectKey, workspaceId).filter((x) => x.listDefault).map((x) => x.key);
}
