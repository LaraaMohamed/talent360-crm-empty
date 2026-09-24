/**
 * The document type registry — a port of `Automation/HCM/apps-script-dms/
 * DocumentTypeRegistry.gs`, plus the formatting helpers it depends on from
 * `Helpers.gs`.
 *
 * This is the same design decision the Apps Script made, kept: every document
 * type is DATA, and the engine (lib/docx-template.mjs) contains no mention of
 * HCM, Offshoring, English or Arabic. A fifth document type is one entry here
 * and nothing else.
 *
 * Everything in this file is pure — it takes plain objects and returns plain
 * values, with no database and no filesystem — so the parity tests can run the
 * real placeholder maps without standing anything up.
 *
 * ── TWO DEFECTS IN THE SOURCE SYSTEM, FIXED HERE ────────────────────────────
 *
 * Both are in the HCM Agreement, both are provable against
 * `Automation/Draft - HCM Agreement (1).docx` — the hand-authored document its
 * template was built from — and both were agreed before implementation:
 *
 *  1. NUMBER ORDER. The Apps Script assigns numbers by walking SERVICE_REGISTRY
 *     and replacing each service's own {{NUM:KEY}} wherever it sits. The HCM
 *     Agreement's blocks are authored in a different order to the registry, so
 *     it prints 1, 2, 7, 6, 3, 4, 5. The draft reads 1-7. The engine now numbers
 *     by document order, which is identical to the Apps Script for the HCM
 *     Proposal (whose orders agree) and correct for the Agreement.
 *
 *  2. DOUBLE PERIOD. Every Arabic heading is authored as
 *     `{{SEC:KEY}}{{NUM:KEY}}. عنوان` — the period is already in the template.
 *     The Apps Script's numberFormat adds another, producing "1..". The draft
 *     reads "1.". This registry's numberFormat therefore returns the bare
 *     number for that type.
 *
 * See docs/10-automation-port-map.md.
 */

/**
 * The 7 HCM services in canonical order.
 *
 * This order is the shared state both HCM documents read — enable a service and
 * both the proposal's Section 3 and the agreement's Article 1 follow, with no
 * sync step, because there is only one selection per deal.
 */
export const SERVICE_REGISTRY = [
    { key: 'RECRUITMENT', labelEn: 'Recruitment & Selection', labelAr: 'التوظيف والاختيار' },
    { key: 'ONBOARDING', labelEn: 'Employee Onboarding', labelAr: 'أعداد الموظفين الجدد' },
    { key: 'BENEFITS', labelEn: 'Benefits Administration', labelAr: 'إدارة المزايا' },
    { key: 'PERFORMANCE', labelEn: 'Performance Management', labelAr: 'إدارة الأداء' },
    { key: 'RELATIONS', labelEn: 'Employee Relations', labelAr: 'إدارة علاقات الموظفين' },
    { key: 'COMPENSATION', labelEn: 'Compensation Administration', labelAr: 'إدارة التعويضات' },
    { key: 'PERSONNEL', labelEn: 'Personnel Administration', labelAr: 'إدارة شئون الموظفين' },
];

export const SERVICE_KEYS = SERVICE_REGISTRY.map((s) => s.key);

/** Spelled-out counts for the proposal's "{{SERVICE_COUNT_WORD}}" sentence. */
const COUNT_WORDS_EN = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];

/** Field types the generation form renders and the validator checks. */
export const FIELD_TYPE = { TEXT: 'text', NUMBER: 'number', DATE: 'date', TEXTAREA: 'textarea' };

/**
 * Arabic month names, matching the style already used in the Arabic agreements
 * ("1 أبريل 2026م"). Copied from Helpers.gs unchanged — these are the words the
 * existing contracts use, not a locale lookup.
 */
const ARABIC_MONTHS = [
    'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
    'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];

/* ------------------------------------------------------------ formatting -- */

/**
 * The calendar parts of an instant, in a named timezone.
 *
 * Built through Intl rather than string-slicing an ISO date for the reason the
 * Apps Script's todayInConfiguredTimezone_ gives: a late-evening run near a UTC
 * boundary must not stamp tomorrow's date onto an agreement.
 */
function partsIn(date, timeZone) {
    const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
    return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/** "July 2026" — Apps Script's MMMM yyyy. */
export function formatMonthYear(date, timeZone) {
    return new Intl.DateTimeFormat('en-US', { timeZone, month: 'long', year: 'numeric' }).format(date);
}

/** "29/07/2026" — Apps Script's dd/MM/yyyy. */
export function formatDate(date, timeZone) {
    const { year, month, day } = partsIn(date, timeZone);
    return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
}

/**
 * An amount, grouped in threes: 52000 → "52,000".
 *
 * This is how the authored drafts write money — `Talent 360 - Draft - HCM
 * Proposal.docx` reads "45,000", not "45000" — and in the Apps Script it
 * happened by accident: the fee was typed into a Sheets cell as "45,000" and
 * printed verbatim. A number field cannot carry a comma, so the grouping is
 * applied here instead, at the point the value becomes document text.
 *
 * Deliberately NOT a currency format. The currency is its own placeholder, the
 * templates place it themselves, and two of them want an Arabic word rather
 * than a symbol. This adds separators to a number and nothing else.
 *
 * Western digits and a comma in every locale, on purpose: the Arabic agreements
 * are authored with Western numerals throughout, so a locale-aware format would
 * make one paragraph disagree with the rest of its own contract.
 *
 * Anything that is not a plain number — an empty field, a range, a word — is
 * returned untouched rather than mangled into NaN.
 */
export function formatAmount(value) {
    if (value === undefined || value === null) return '';
    const text = String(value).trim();
    if (text === '') return '';

    // Separators the user may already have typed are removed before regrouping,
    // so re-generating from a previous version cannot produce "5,2,000".
    const bare = text.replace(/[, \s]/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(bare)) return text;

    const negative = bare.startsWith('-');
    const [whole, fraction] = bare.replace('-', '').split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${negative ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}`;
}

/** "1 أبريل 2026م" — how the Arabic agreements write a date in prose. */
export function formatArabicDate(date, timeZone) {
    const { year, month, day } = partsIn(date, timeZone);
    return `${day} ${ARABIC_MONTHS[month - 1]} ${year}م`;
}

/**
 * Accepts what a date field actually arrives as — a Date, an ISO date string,
 * or already-formatted text — and returns dd/MM/yyyy.
 *
 * The Apps Script needed this because Sheets silently converts date-looking
 * text into a Date. Here the equivalent hazard is an ISO string from a form, a
 * Date from SQLite, or a value the user typed by hand; all three must land as
 * the same printed string.
 */
export function normalizeDateValue(value, timeZone, formatter = formatDate) {
    if (value === undefined || value === null || value === '') return '';
    if (value instanceof Date) return formatter(value, timeZone);
    const text = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
        // A bare ISO date is a calendar date, not an instant. Parsed at noon UTC
        // so no timezone the workspace might use can shift it to the day before.
        return formatter(new Date(`${text.slice(0, 10)}T12:00:00Z`), timeZone);
    }
    return text;
}

/**
 * A calendar date, read the way the generation form types one, as an ISO string.
 *
 * The same contract as the client's `parseTypedDate` (public/js/core.js): an
 * ISO date or a dd/mm/yyyy date, verified by round-tripping through a real
 * Date so 31 February is refused rather than rolled into March. Anything it
 * cannot read confidently comes back null.
 *
 * The server holds this because the form is not the only caller: the review
 * step lets a date be edited in place, and a direct POST is a client too. A
 * date field that stores whatever text was typed would land in the record's
 * `effective_date` and print into the contract — this keeps both real.
 */
export function parseDateValue(value) {
    if (value === undefined || value === null) return null;
    const raw = String(value).trim();
    if (!raw) return null;

    const iso = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    const dmy = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (!iso && !dmy) return null;

    const [y, m, d] = iso
        ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
        : [Number(dmy[3]), Number(dmy[2]), Number(dmy[1])];

    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const at = new Date(Date.UTC(y, m - 1, d));
    if (at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return null;
    return at.toISOString().slice(0, 10);
}

/** Today, as a Date fixed to midnight of the calendar day in `timeZone`. */
export function todayIn(timeZone, now = new Date()) {
    const { year, month, day } = partsIn(now, timeZone);
    return new Date(Date.UTC(year, month - 1, day, 12));
}

/**
 * Contract end date: start + N years − 1 day, the inclusive-term convention.
 *
 * 04/05/2026 + 1 year − 1 day = 03/05/2027. A 29 February start normalises to
 * 1 March before the day is subtracted, giving 28 February — the correct
 * inclusive end date, and the same result the Apps Script produces.
 */
export function computeContractEndDate(startDate, years = 1) {
    if (!(startDate instanceof Date) || Number.isNaN(startDate.getTime())) return null;
    const n = Number.isFinite(Number(years)) ? Number(years) : 1;
    const end = new Date(Date.UTC(
        startDate.getUTCFullYear() + n, startDate.getUTCMonth(), startDate.getUTCDate(), 12,
    ));
    end.setUTCDate(end.getUTCDate() - 1);
    return end;
}

/** "Section 3.1" when there is one, "Sections 3.1 through 3.N" otherwise. */
export function buildSectionRange(count) {
    if (count <= 1) return 'Section 3.1';
    return `Sections 3.1 through 3.${count}`;
}

/** The enabled services' labels, pipe separated, in the requested locale. */
export function buildServiceScopeList(enabledServices, locale) {
    const field = locale === 'ar' ? 'labelAr' : 'labelEn';
    return enabledServices.map((s) => s[field]).join(' | ');
}

/** SERVICE_REGISTRY entries for the given keys, always in canonical order. */
export function enabledServicesFor(enabledKeys) {
    const set = new Set(enabledKeys ?? []);
    return SERVICE_REGISTRY.filter((s) => set.has(s.key));
}

/* -------------------------------------------------------- document types -- */

const number = (key, label, extra = {}) => ({ key, label, type: FIELD_TYPE.NUMBER, ...extra });
const text = (key, label, extra = {}) => ({ key, label, type: FIELD_TYPE.TEXT, ...extra });
const date = (key, label, extra = {}) => ({ key, label, type: FIELD_TYPE.DATE, ...extra });

/* --------------------------------------------------- variable provenance -- */

/**
 * Where a placeholder's value comes from.
 *
 * This is DESCRIPTION, not behaviour: `buildPlaceholders` below is still the
 * only thing that produces a value, and nothing here can change one. It exists
 * so the generation screen can show, before a document is written, which
 * variables the template needs, which record each is being read from, and which
 * are still empty — the difference between "generate and see what comes out"
 * and knowing what the client is about to receive.
 *
 * `SOURCE.FIELD` names the form field that fills it, so a blank value in the
 * review table can be corrected in place instead of sending the user back a
 * step.
 */
export const SOURCE = {
    ACCOUNT: 'account',
    REGISTRATION: 'registration',
    SERVICES: 'services',
    FIELD: 'field',
    COMPUTED: 'computed',
};

export const SOURCE_LABEL = {
    [SOURCE.ACCOUNT]: 'Account',
    [SOURCE.REGISTRATION]: 'Commercial registration',
    [SOURCE.SERVICES]: 'Service scopes',
    [SOURCE.FIELD]: 'Entered here',
    [SOURCE.COMPUTED]: 'Computed',
};

const v = (label, source, detail, extra = {}) => ({ label, source, detail, ...extra });
/** A variable filled by one of the type's own form fields. */
const fromField = (label, fieldKey, detail, extra = {}) => v(label, SOURCE.FIELD, detail ?? label, { fieldKey, ...extra });

/**
 * A variable that renders a commercial figure — the number itself, or a
 * currency that only means something beside one.
 *
 * The single flag `generate()` (lib/doc-generation.mjs) reads to redact the
 * Internal Team Proposal: every variable marked `money: true` is blanked in
 * the PLACEHOLDERS, after `buildPlaceholders` has run and required-field
 * validation has already passed against the real figures, so a required
 * price field is never rejected as missing on the way to being hidden. Data-
 * driven rather than a hardcoded list of token names, so a document type
 * added later only has to mark its own money variables this way — nothing
 * else has to learn about it.
 */
const moneyField = (label, fieldKey, detail) => fromField(label, fieldKey, detail, { money: true });

/** The three first-party variables every agreement shares, plus its client name. */
const FIRST_PARTY_VARIABLES = {
    CLIENT_NAME: v('Client name', SOURCE.REGISTRATION,
        'Arabic company name on the certificate, falling back to the account name'),
    COMMERCIAL_REGISTRATION: v('Commercial registration number', SOURCE.REGISTRATION, 'Registration number'),
    REPRESENTATIVE_NAME: v('Representative name', SOURCE.REGISTRATION, 'The person who signs'),
    COMPANY_ADDRESS: v('Company address', SOURCE.REGISTRATION, 'Address'),
};

const MONTH_YEAR = v('Month and year', SOURCE.COMPUTED, 'Today, as "July 2026"');
const AGREEMENT_DATE = v('Agreement date', SOURCE.COMPUTED, 'Always today — never entered by hand');

/**
 * The four document types.
 *
 * `product` maps to the CRM's service line keys rather than the automation's
 * 'HCM' / 'Offshoring' strings, because the CRM already has that vocabulary in
 * `service_lines` and a second one would be a second thing to keep in step.
 */
export const DOCUMENT_TYPES = {
    HCM_PROPOSAL: {
        key: 'HCM_PROPOSAL',
        label: 'HCM Proposal',
        category: 'proposal',
        product: 'hcm',
        templateKey: 'hcm_proposal',
        hasServiceSelection: true,
        requiresCommercialRegistration: false,
        dynamicBlocks: {
            registry: SERVICE_REGISTRY,
            numberFormat: (n) => `3.${n}`,
            terminalBoundaryText: '4. Service Delivery Team',
        },
        fields: [
            number('employees_to_hire', 'Employees To Hire', {
                requiredIf: (keys) => keys.includes('RECRUITMENT'),
            }),
            // The LABEL lost "Onsite" when the proposal template did. The KEY,
            // the placeholder and the setting keep it, and must: `fields` and
            // `placeholders` on every generation already recorded are frozen
            // snapshots written under the old names, and a version row whose
            // keys no longer match the registry is a contract whose inputs can
            // no longer be read back.
            number('onsite_visits_per_week', 'Visits Per Week', { required: true, settingKey: 'doc_default_onsite_visits' }),
            number('monthly_fee', 'Monthly Fee', { required: true, prefillFrom: 'deal_mrr' }),
            // Setting first, then the deal's own currency, then the workspace's
            // base — so an account-level proposal with no deal behind it still
            // opens with a currency rather than an empty required field.
            text('currency', 'Currency', {
                required: true, settingKey: 'doc_default_currency', prefillFrom: 'deal_currency',
            }),
            number('validity_days', 'Proposal Validity (Days)', { required: true, settingKey: 'doc_default_validity_days' }),
        ],
        variables: {
            CLIENT_NAME: v('Client name', SOURCE.ACCOUNT, 'Account name'),
            MONTH_YEAR,
            EMPLOYEES_TO_HIRE: fromField('Employees to hire', 'employees_to_hire'),
            ONSITE_VISITS_PER_WEEK: fromField('Visits per week', 'onsite_visits_per_week'),
            MONTHLY_FEE: moneyField('Monthly fee', 'monthly_fee'),
            CURRENCY: moneyField('Currency', 'currency'),
            SERVICE_SCOPE_LIST: v('Service scope list', SOURCE.SERVICES, 'Selected HCM scopes, English'),
            SECTION_RANGE: v('Section range', SOURCE.COMPUTED, 'From the number of selected scopes'),
            SERVICE_COUNT_WORD: v('Number of scopes, spelled out', SOURCE.COMPUTED, 'From the number of selected scopes'),
        },
        buildPlaceholders({ account, fields, enabledServices, timeZone, now }) {
            const count = enabledServices.length;
            return {
                CLIENT_NAME: account.name ?? '',
                MONTH_YEAR: formatMonthYear(now, timeZone),
                EMPLOYEES_TO_HIRE: fields.employees_to_hire,
                ONSITE_VISITS_PER_WEEK: fields.onsite_visits_per_week,
                MONTHLY_FEE: formatAmount(fields.monthly_fee),
                CURRENCY: fields.currency,
                SERVICE_SCOPE_LIST: buildServiceScopeList(enabledServices, 'en'),
                SECTION_RANGE: buildSectionRange(count),
                SERVICE_COUNT_WORD: COUNT_WORDS_EN[count] ?? String(count),
            };
        },
    },

    HCM_AGREEMENT: {
        key: 'HCM_AGREEMENT',
        label: 'HCM Agreement',
        category: 'agreement',
        product: 'hcm',
        templateKey: 'hcm_agreement',
        hasServiceSelection: true,
        requiresCommercialRegistration: true,
        dynamicBlocks: {
            registry: SERVICE_REGISTRY,
            // Bare number: the template already carries the period. See the
            // file header, defect 2.
            numberFormat: (n) => String(n),
            terminalBoundaryText: 'يجب على شركة الاستشارات تنفيذ المهام والخدمات المطلوبة',
        },
        fields: [
            number('employees_to_hire', 'Employees To Hire', {
                requiredIf: (keys) => keys.includes('RECRUITMENT'),
            }),
            number('onsite_visits_per_week', 'Visits Per Week', { required: true, settingKey: 'doc_default_onsite_visits' }),
            number('monthly_fee', 'Monthly Fee', { required: true, prefillFrom: 'deal_mrr' }),
            text('currency', 'Currency (Arabic word, e.g. جنيه)', { required: true, settingKey: 'doc_default_currency_ar' }),
            date('start_date', 'Contract Start Date', { required: true }),
            date('end_date', 'Contract End Date', {
                required: true,
                autoCalcFrom: 'start_date',
                hint: 'Calculated as start date + 1 year − 1 day. Change it only if this contract runs a different term.',
            }),
            text('contract_duration_text', 'Contract Duration (Arabic text)', { required: true, settingKey: 'doc_default_contract_duration_text' }),
        ],
        variables: {
            ...FIRST_PARTY_VARIABLES,
            MONTH_YEAR,
            AGREEMENT_DATE,
            START_DATE: fromField('Contract start date', 'start_date'),
            END_DATE: fromField('Contract end date', 'end_date'),
            EMPLOYEES_TO_HIRE: fromField('Employees to hire', 'employees_to_hire'),
            ONSITE_VISITS_PER_WEEK: fromField('Visits per week', 'onsite_visits_per_week'),
            MONTHLY_FEE: moneyField('Monthly fee', 'monthly_fee'),
            CURRENCY: moneyField('Currency (Arabic word)', 'currency'),
            CONTRACT_DURATION_TEXT: fromField('Contract duration (Arabic)', 'contract_duration_text'),
            SERVICE_SCOPE_LIST_AR: v('Service scope list', SOURCE.SERVICES, 'Selected HCM scopes, Arabic'),
        },
        buildPlaceholders({ account, fields, enabledServices, registration, timeZone, now }) {
            const firstParty = resolveFirstParty(account, registration);
            return {
                // An Arabic legal document: the certificate's Arabic name wins
                // over the account's (usually English) name.
                CLIENT_NAME: firstParty.clientName,
                MONTH_YEAR: formatMonthYear(now, timeZone),
                // Always today, never user-entered.
                AGREEMENT_DATE: formatDate(todayIn(timeZone, now), timeZone),
                START_DATE: normalizeDateValue(fields.start_date, timeZone),
                END_DATE: normalizeDateValue(fields.end_date, timeZone),
                EMPLOYEES_TO_HIRE: fields.employees_to_hire,
                ONSITE_VISITS_PER_WEEK: fields.onsite_visits_per_week,
                MONTHLY_FEE: formatAmount(fields.monthly_fee),
                CURRENCY: fields.currency,
                COMMERCIAL_REGISTRATION: firstParty.crNumber,
                REPRESENTATIVE_NAME: firstParty.representativeName,
                COMPANY_ADDRESS: firstParty.address,
                CONTRACT_DURATION_TEXT: fields.contract_duration_text,
                SERVICE_SCOPE_LIST_AR: buildServiceScopeList(enabledServices, 'ar'),
            };
        },
    },

    OFFSHORING_PROPOSAL: {
        key: 'OFFSHORING_PROPOSAL',
        label: 'Offshoring Proposal',
        category: 'proposal',
        product: 'offshoring',
        templateKey: 'offshoring_proposal',
        hasServiceSelection: false,
        requiresCommercialRegistration: false,
        dynamicBlocks: null,
        // One number, and it is the price. It was a literal 65 in the template
        // highlighted yellow — the convention for "edit this by hand before
        // sending", which is the same thing as "this should have been a field".
        fields: [
            number('talent_fee', 'Talent Fee (USD per employee / month)', {
                required: true, settingKey: 'doc_default_talent_fee',
            }),
        ],
        variables: {
            CLIENT_NAME: v('Client name', SOURCE.ACCOUNT, 'Account name'),
            MONTH_YEAR,
            TALENT_FEE: moneyField('Talent fee, per employee per month', 'talent_fee'),
        },
        buildPlaceholders({ account, fields, timeZone, now }) {
            return {
                CLIENT_NAME: account.name ?? '',
                MONTH_YEAR: formatMonthYear(now, timeZone),
                TALENT_FEE: formatAmount(fields.talent_fee),
            };
        },
    },

    OFFSHORING_AGREEMENT: {
        key: 'OFFSHORING_AGREEMENT',
        label: 'Offshoring Agreement',
        category: 'agreement',
        product: 'offshoring',
        templateKey: 'offshoring_agreement',
        hasServiceSelection: false,
        requiresCommercialRegistration: true,
        dynamicBlocks: null,
        fields: [
            // Same number as the proposal's `talent_fee` — the agreement's
            // own template just calls it a fee rather than a quote.
            // `siblingKey` tells prefillFields() the two are one value
            // despite the different name, so signing the agreement does not
            // ask for the rate a second time.
            number('monthly_fee', 'Fee (per employee / month)', { required: true, prefillFrom: 'deal_mrr', siblingKey: 'talent_fee' }),
            text('currency', 'Currency (Arabic word, e.g. دولار)', { required: true, settingKey: 'doc_default_currency_ar' }),
            date('start_date', 'Contract Start Date', { required: true }),
            date('end_date', 'Contract End Date', {
                required: true,
                autoCalcFrom: 'start_date',
                hint: 'Calculated as start date + 1 year − 1 day. Change it only if this contract runs a different term.',
            }),
        ],
        variables: {
            ...FIRST_PARTY_VARIABLES,
            AGREEMENT_DATE,
            START_DATE: fromField('Contract start date', 'start_date'),
            END_DATE: fromField('Contract end date', 'end_date'),
            MONTHLY_FEE: moneyField('Fee per employee / month', 'monthly_fee'),
            CURRENCY: moneyField('Currency (Arabic word)', 'currency'),
        },
        buildPlaceholders({ account, fields, registration, timeZone, now }) {
            const firstParty = resolveFirstParty(account, registration);
            return {
                CLIENT_NAME: firstParty.clientName,
                AGREEMENT_DATE: formatDate(todayIn(timeZone, now), timeZone),
                // This template writes its term in Arabic prose, so the dates
                // are formatted that way rather than dd/MM/yyyy. The difference
                // from the HCM Agreement is deliberate and comes from the
                // templates themselves.
                START_DATE: normalizeDateValue(fields.start_date, timeZone, formatArabicDate),
                END_DATE: normalizeDateValue(fields.end_date, timeZone, formatArabicDate),
                MONTHLY_FEE: formatAmount(fields.monthly_fee),
                CURRENCY: fields.currency,
                COMMERCIAL_REGISTRATION: firstParty.crNumber,
                REPRESENTATIVE_NAME: firstParty.representativeName,
                COMPANY_ADDRESS: firstParty.address,
            };
        },
    },
};

/**
 * The First Party (الطرف الأول) block, from the account's commercial
 * registration.
 *
 * One place this mapping lives, so every current and future agreement type gets
 * the same values. The Arabic certificate name takes precedence over the
 * account's name; without a registration it falls back, and validation will
 * have refused the generation before this is reached.
 */
export function resolveFirstParty(account, registration) {
    if (!registration) {
        return { clientName: account?.name ?? '', crNumber: '', representativeName: '', address: '' };
    }
    return {
        clientName: (registration.company_name_ar ?? '').trim() || account?.name || '',
        crNumber: (registration.cr_number ?? '').trim(),
        representativeName: (registration.representative_name ?? '').trim(),
        address: (registration.address ?? '').trim(),
    };
}

/** The document types available for a service line, proposal first. */
export function documentTypesForProduct(product) {
    return Object.values(DOCUMENT_TYPES)
        .filter((dt) => dt.product === product)
        .sort((a, b) => (a.category === b.category ? 0 : a.category === 'proposal' ? -1 : 1));
}

export function documentType(key) {
    return DOCUMENT_TYPES[key] ?? null;
}

/* ---------------------------------------------------------- validation -- */

/**
 * The variable-mapping table: one row per placeholder this document will fill.
 *
 * Built from the SAME placeholder map the renderer is given, so what the review
 * screen shows is what the document gets — not a second computation that agrees
 * with it today and drifts tomorrow. The registry only adds the provenance and
 * the "is this required" answer.
 *
 * @param {object} docType One entry from DOCUMENT_TYPES.
 * @param {object} placeholders The output of `docType.buildPlaceholders`.
 * @param {Array<string>} enabledKeys The selected service scope keys.
 * @returns {Array<{key,label,source,sourceLabel,detail,value,missing,required,fieldKey}>}
 */
export function describeVariables(docType, placeholders, enabledKeys = []) {
    const fieldByKey = new Map(docType.fields.map((f) => [f.key, f]));

    return Object.entries(placeholders).map(([key, value]) => {
        const meta = docType.variables?.[key]
            // A placeholder with no declared provenance is a registry oversight,
            // not a reason to hide the row: it is shown, honestly labelled.
            ?? { label: key, source: SOURCE.COMPUTED, detail: 'Not described in the registry' };

        const field = meta.fieldKey ? fieldByKey.get(meta.fieldKey) : null;
        const required = field
            ? field.required === true
                || (typeof field.requiredIf === 'function' && field.requiredIf(enabledKeys))
            // Everything not typed on the form comes from a record the document
            // cannot be written without, and validateGeneration refuses those.
            : true;

        return {
            key,
            label: meta.label,
            source: meta.source,
            sourceLabel: SOURCE_LABEL[meta.source] ?? meta.source,
            detail: meta.detail,
            value: value === undefined || value === null ? '' : String(value),
            missing: value === undefined || value === null || String(value).trim() === '',
            required,
            fieldKey: meta.fieldKey ?? null,
        };
    });
}

/**
 * Everything wrong with a generation request, as sentences a user can act on.
 *
 * Collected rather than thrown one at a time: being told about the missing
 * contact email only after fixing the address is how a five-second correction
 * becomes five round trips. Ported from ValidationService.gs, which does the
 * same.
 */
export function validateGeneration({ docType, account, fields, enabledKeys, registration }) {
    const problems = [];

    if (!account?.name || String(account.name).trim() === '') {
        problems.push('This account has no company name.');
    }

    if (docType.hasServiceSelection && (enabledKeys ?? []).length === 0) {
        problems.push('No HCM services are selected — at least one must stay selected.');
    }

    if (docType.requiresCommercialRegistration) {
        if (!registration) {
            problems.push(
                'No commercial registration has been recorded for this account yet. '
                + 'Add it so the first-party details (Arabic company name, registration number, '
                + 'representative, address) can be filled in automatically.',
            );
        } else {
            if (!String(registration.representative_name ?? '').trim()) {
                // The representative signs on the client's behalf
                // ("ويمثلها قانوناً السيد /"), so a blank one has to be caught here
                // rather than producing an agreement with a gap where a name goes.
                problems.push('No representative name is recorded for this client, and the agreement is signed by them.');
            }
            if (!String(registration.company_name_ar ?? '').trim()) {
                /**
                 * `resolveFirstParty` falls back to the account's name when the
                 * Arabic one is blank — which on an Arabic contract means the
                 * English trading name appears as الطرف الأول, where the
                 * registered legal name belongs. A fallback is the right
                 * behaviour for a proposal and the wrong one for a signed
                 * agreement, so the agreement asks for the real thing instead of
                 * quietly substituting a different field.
                 */
                problems.push(
                    'No Arabic company name is recorded for this client. It is what appears as '
                    + 'الطرف الأول on the agreement, and the account\'s English name is not a substitute for it.',
                );
            }
        }
    }

    for (const field of docType.fields) {
        const required = field.required === true
            || (typeof field.requiredIf === 'function' && field.requiredIf(enabledKeys ?? []));
        if (!required) continue;

        const value = fields?.[field.key];
        const missing = value === undefined || value === null || String(value).trim() === '';
        if (missing) {
            problems.push(`"${field.label}" is required.`);
        } else if (field.type === FIELD_TYPE.NUMBER && Number.isNaN(Number(String(value).replace(/[,\s]/g, '')))) {
            // Separators are stripped before the check: a fee pasted in as
            // "45,000" is a number a person typed, and refusing it teaches them
            // the field is fussy rather than that it is numeric.
            problems.push(`"${field.label}" must be a number.`);
        } else if (field.type === FIELD_TYPE.DATE && !parseDateValue(value)) {
            problems.push(`"${field.label}" must be a date — e.g. 31/08/2027 or 2027-08-31.`);
        }
    }

    // The contract term has to describe a real interval: an end before its
    // start is a slip that would otherwise be stored, printed and sent.
    const start = docType.fields.find((f) => f.key === 'start_date');
    const end = docType.fields.find((f) => f.key === 'end_date');
    if (start && end) {
        const startAt = parseDateValue(fields?.[start.key]);
        const endAt = parseDateValue(fields?.[end.key]);
        if (startAt && endAt && endAt <= startAt) {
            problems.push(`"${end.label}" must be after "${start.label}".`);
        }
    }

    return problems;
}

/**
 * The generated file's name: `Talent360 - {Account} - {Document type}.docx`.
 *
 * Deliberately the account's own (usually English) name even for the Arabic
 * agreements — the same choice buildDocumentName_ made, for the same reason: a
 * list of Arabic filenames is far harder to scan. Characters that are illegal
 * in a filename on Windows or in Drive are replaced, and the result is capped
 * so a long legal name cannot produce an unopenable path.
 */
export function buildDocumentName(docType, account) {
    const raw = String(account?.name ?? 'Unnamed Client').replace(/\s+/g, ' ').trim();
    const safe = raw.replace(/[/\\:*?"<>|]/g, '-').slice(0, 80).trim();
    return `Talent360 - ${safe || 'Unnamed Client'} - ${docType.label}.docx`;
}
