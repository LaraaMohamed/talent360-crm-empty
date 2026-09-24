/**
 * DocumentTypeRegistry.gs
 *
 * The domain model for every document Talent 360 can generate. This is the
 * ONE file DocumentEngine.gs, ValidationService.gs and the wizard UI all
 * read from — none of them contain HCM- or Offshoring-specific logic.
 *
 * To add a 5th document type in the future (a new product, or a 3rd HCM
 * document type): add one entry to DOCUMENT_TYPES. Nothing else changes.
 *
 * === Section 3 / Article 1 background ===
 * Both HCM documents represent their 7 services as removable "blocks" in
 * the template. Each block's heading paragraph carries two control tokens
 * baked in at template-authoring time:
 *   {{SEC:<KEY>}}  - marks/locates the block. Stripped once processed.
 *   {{NUM:<KEY>}}  - replaced with the assigned number, in that
 *                    document's own numbering format.
 * A block runs from its heading to the next block's heading (or to the
 * terminalBoundaryText), so no separate start/end marker pair is needed —
 * see DocumentEngine.applyDynamicBlocks_.
 */

/**
 * The 7 HCM services, canonical order. This order is what guarantees
 * numbering is always assigned consistently (3.1, 3.2... / ١.، ٢....)
 * regardless of which services are unchecked. Shared by both HCM
 * documents — this is also what keeps them "synchronized": there is only
 * ever one enabled/disabled state per Opportunity (see
 * OpportunityService.getHcmServiceSelection_), read by both.
 */
var SERVICE_REGISTRY = [
  {
    key: 'RECRUITMENT',
    column: COLUMNS.HCM_SERVICE_SELECTION.RECRUITMENT,
    labelEn: 'Recruitment & Selection',
    labelAr: 'التوظيف والاختيار',
    secToken: '{{SEC:RECRUITMENT}}',
    numToken: '{{NUM:RECRUITMENT}}'
  },
  {
    key: 'ONBOARDING',
    column: COLUMNS.HCM_SERVICE_SELECTION.ONBOARDING,
    labelEn: 'Employee Onboarding',
    labelAr: 'أعداد الموظفين الجدد',
    secToken: '{{SEC:ONBOARDING}}',
    numToken: '{{NUM:ONBOARDING}}'
  },
  {
    key: 'BENEFITS',
    column: COLUMNS.HCM_SERVICE_SELECTION.BENEFITS,
    labelEn: 'Benefits Administration',
    labelAr: 'إدارة المزايا',
    secToken: '{{SEC:BENEFITS}}',
    numToken: '{{NUM:BENEFITS}}'
  },
  {
    key: 'PERFORMANCE',
    column: COLUMNS.HCM_SERVICE_SELECTION.PERFORMANCE,
    labelEn: 'Performance Management',
    labelAr: 'إدارة الأداء',
    secToken: '{{SEC:PERFORMANCE}}',
    numToken: '{{NUM:PERFORMANCE}}'
  },
  {
    key: 'RELATIONS',
    column: COLUMNS.HCM_SERVICE_SELECTION.RELATIONS,
    labelEn: 'Employee Relations',
    labelAr: 'إدارة علاقات الموظفين',
    secToken: '{{SEC:RELATIONS}}',
    numToken: '{{NUM:RELATIONS}}'
  },
  {
    key: 'COMPENSATION',
    column: COLUMNS.HCM_SERVICE_SELECTION.COMPENSATION,
    labelEn: 'Compensation Administration',
    labelAr: 'إدارة التعويضات',
    secToken: '{{SEC:COMPENSATION}}',
    numToken: '{{NUM:COMPENSATION}}'
  },
  {
    key: 'PERSONNEL',
    column: COLUMNS.HCM_SERVICE_SELECTION.PERSONNEL,
    labelEn: 'Personnel Administration',
    labelAr: 'إدارة شئون الموظفين',
    secToken: '{{SEC:PERSONNEL}}',
    numToken: '{{NUM:PERSONNEL}}'
  }
];

/** Spelled-out counting words for the HCM Proposal's "{{SERVICE_COUNT_WORD}}" sentence. */
var COUNT_WORDS_EN = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];

/**
 * Returns the SERVICE_REGISTRY entries enabled for a given HCM Service
 * Selection row, in canonical registry order.
 * @param {Object<string, *>} serviceSelectionRow Keyed by COLUMNS.HCM_SERVICE_SELECTION.*.
 * @return {Array<Object>}
 */
function getEnabledServices_(serviceSelectionRow) {
  return SERVICE_REGISTRY.filter(function (svc) {
    return serviceSelectionRow[svc.column] === true;
  });
}

/** Field-type constants for wizard form rendering + validation. */
var FIELD_TYPE = { TEXT: 'text', NUMBER: 'number', DATE: 'date', TEXTAREA: 'textarea' };

/**
 * Resolves the "First Party" (الطرف الأول) block for an agreement from the
 * Opportunity's imported Commercial Registration.
 *
 * Single place this mapping lives, so every current and future agreement
 * type gets the same first-party values without duplicating the lookup.
 * The Arabic company name from the certificate takes precedence over the
 * Opportunity's (usually English) Company field, because these agreements
 * are Arabic legal documents — falling back to the Opportunity name only if
 * no CR has been imported.
 *
 * @param {Object<string, *>} opportunity Row from Opportunities.
 * @return {{clientNameAr: string, crNumber: string, address: string}}
 */
function resolveFirstParty_(opportunity) {
  var opportunityId = opportunity[COLUMNS.OPPORTUNITIES.ID];
  var cr = getCommercialRegistration_(opportunityId);
  if (!cr) {
    return {
      clientNameAr: opportunity[COLUMNS.OPPORTUNITIES.COMPANY] || '',
      crNumber: '',
      representativeName: '',
      address: ''
    };
  }
  var nameAr = String(cr[COLUMNS.COMMERCIAL_REGISTRATION.COMPANY_NAME_AR] || '').trim();
  return {
    clientNameAr: nameAr || opportunity[COLUMNS.OPPORTUNITIES.COMPANY] || '',
    crNumber: String(cr[COLUMNS.COMMERCIAL_REGISTRATION.CR_NUMBER] || '').trim(),
    representativeName: String(cr[COLUMNS.COMMERCIAL_REGISTRATION.REPRESENTATIVE_NAME] || '').trim(),
    address: String(cr[COLUMNS.COMMERCIAL_REGISTRATION.ADDRESS] || '').trim()
  };
}

/**
 * The four document types. Each entry fully describes one template: where
 * its data lives, which fields its wizard form should ask for, whether it
 * has HCM's dynamic service blocks, and how to turn (Opportunity + form
 * values + enabled services) into the final placeholder map.
 */
var DOCUMENT_TYPES = {

  HCM_PROPOSAL: {
    key: 'HCM_PROPOSAL',
    label: 'HCM Proposal',
    product: CONFIG.PRODUCT.HCM,
    dataSheet: SHEETS.HCM_PROPOSAL_DATA,
    dataColumns: COLUMNS.HCM_PROPOSAL_DATA,
    templateSettingKey: SETTINGS_KEYS.HCM_PROPOSAL_TEMPLATE_ID,
    hasServiceSelection: true,
    dynamicBlocks: {
      registry: SERVICE_REGISTRY,
      numberFormat: function (n) { return '3.' + n; },
      terminalBoundaryText: '4. Service Delivery Team',
      scopeListLocale: 'en'
    },
    fields: [
      { key: COLUMNS.HCM_PROPOSAL_DATA.EMPLOYEES_TO_HIRE, label: 'Employees To Hire', type: FIELD_TYPE.NUMBER,
        requiredIf: function (enabledKeys) { return enabledKeys.indexOf('RECRUITMENT') !== -1; } },
      { key: COLUMNS.HCM_PROPOSAL_DATA.ONSITE_VISITS_PER_WEEK, label: 'Onsite Visits Per Week', type: FIELD_TYPE.NUMBER, required: true,
        defaultSettingKey: SETTINGS_KEYS.DEFAULT_ONSITE_VISITS_PER_WEEK },
      { key: COLUMNS.HCM_PROPOSAL_DATA.MONTHLY_FEE, label: 'Monthly Fee', type: FIELD_TYPE.NUMBER, required: true },
      { key: COLUMNS.HCM_PROPOSAL_DATA.CURRENCY, label: 'Currency', type: FIELD_TYPE.TEXT, required: true,
        defaultSettingKey: SETTINGS_KEYS.DEFAULT_CURRENCY },
      { key: COLUMNS.HCM_PROPOSAL_DATA.VALIDITY_DAYS, label: 'Proposal Validity (Days)', type: FIELD_TYPE.NUMBER, required: true,
        defaultSettingKey: SETTINGS_KEYS.DEFAULT_VALIDITY_DAYS }
    ],
    buildPlaceholderMap: function (opportunity, fields, enabledServices) {
      var count = enabledServices.length;
      return {
        CLIENT_NAME: opportunity[COLUMNS.OPPORTUNITIES.COMPANY],
        MONTH_YEAR: formatMonthYear_(new Date()),
        EMPLOYEES_TO_HIRE: fields[COLUMNS.HCM_PROPOSAL_DATA.EMPLOYEES_TO_HIRE],
        ONSITE_VISITS_PER_WEEK: fields[COLUMNS.HCM_PROPOSAL_DATA.ONSITE_VISITS_PER_WEEK],
        MONTHLY_FEE: fields[COLUMNS.HCM_PROPOSAL_DATA.MONTHLY_FEE],
        CURRENCY: fields[COLUMNS.HCM_PROPOSAL_DATA.CURRENCY],
        SERVICE_SCOPE_LIST: buildServiceScopeList_(enabledServices, 'en'),
        SECTION_RANGE: buildSectionRange_(count),
        SERVICE_COUNT_WORD: COUNT_WORDS_EN[count] || String(count)
      };
    }
  },

  HCM_AGREEMENT: {
    key: 'HCM_AGREEMENT',
    label: 'HCM Agreement',
    product: CONFIG.PRODUCT.HCM,
    dataSheet: SHEETS.HCM_AGREEMENT_DATA,
    dataColumns: COLUMNS.HCM_AGREEMENT_DATA,
    templateSettingKey: SETTINGS_KEYS.HCM_AGREEMENT_TEMPLATE_ID,
    hasServiceSelection: true,
    dynamicBlocks: {
      registry: SERVICE_REGISTRY,
      // The bare number: every heading in this template is authored as
      // "{{SEC:KEY}}{{NUM:KEY}}. العنوان" — the period is already there. This
      // returned n + '.' until 2026-08-07, which printed "1..", "2.." into
      // signed contracts. "Draft - HCM Agreement (1).docx" reads "1.", "2.".
      numberFormat: function (n) { return String(n); },
      terminalBoundaryText: 'يجب على شركة الاستشارات تنفيذ المهام والخدمات المطلوبة',
      scopeListLocale: 'ar'
    },
    requiresCommercialRegistration: true,
    fields: [
      { key: COLUMNS.HCM_AGREEMENT_DATA.EMPLOYEES_TO_HIRE, label: 'Employees To Hire', type: FIELD_TYPE.NUMBER,
        requiredIf: function (enabledKeys) { return enabledKeys.indexOf('RECRUITMENT') !== -1; } },
      { key: COLUMNS.HCM_AGREEMENT_DATA.ONSITE_VISITS_PER_WEEK, label: 'Onsite Visits Per Week', type: FIELD_TYPE.NUMBER, required: true,
        defaultSettingKey: SETTINGS_KEYS.DEFAULT_ONSITE_VISITS_PER_WEEK },
      { key: COLUMNS.HCM_AGREEMENT_DATA.MONTHLY_FEE, label: 'Monthly Fee', type: FIELD_TYPE.NUMBER, required: true },
      { key: COLUMNS.HCM_AGREEMENT_DATA.CURRENCY, label: 'Currency (Arabic word, e.g. جنيه)', type: FIELD_TYPE.TEXT, required: true,
        defaultSettingKey: SETTINGS_KEYS.DEFAULT_CURRENCY_AR },
      { key: COLUMNS.HCM_AGREEMENT_DATA.START_DATE, label: 'Contract Start Date', type: FIELD_TYPE.DATE, required: true },
      { key: COLUMNS.HCM_AGREEMENT_DATA.END_DATE, label: 'Contract End Date', type: FIELD_TYPE.DATE, required: true,
        autoCalcFrom: COLUMNS.HCM_AGREEMENT_DATA.START_DATE,
        hint: 'Calculated as start date + 1 year - 1 day. Change it only if this contract runs a different term.' },
      { key: COLUMNS.HCM_AGREEMENT_DATA.CONTRACT_DURATION_TEXT, label: 'Contract Duration (Arabic text)', type: FIELD_TYPE.TEXT, required: true,
        defaultSettingKey: SETTINGS_KEYS.DEFAULT_CONTRACT_DURATION_TEXT }
    ],
    buildPlaceholderMap: function (opportunity, fields, enabledServices) {
      var firstParty = resolveFirstParty_(opportunity);
      return {
        // Arabic legal document: the certificate's Arabic name wins over the
        // Opportunity's (usually English) Company field.
        CLIENT_NAME: firstParty.clientNameAr,
        MONTH_YEAR: formatMonthYear_(new Date()),
        // Always today, in the spreadsheet's timezone — never user-entered.
        AGREEMENT_DATE: formatDate_(todayInConfiguredTimezone_()),
        START_DATE: normalizeDateValue_(fields[COLUMNS.HCM_AGREEMENT_DATA.START_DATE]),
        END_DATE: normalizeDateValue_(fields[COLUMNS.HCM_AGREEMENT_DATA.END_DATE]),
        EMPLOYEES_TO_HIRE: fields[COLUMNS.HCM_AGREEMENT_DATA.EMPLOYEES_TO_HIRE],
        ONSITE_VISITS_PER_WEEK: fields[COLUMNS.HCM_AGREEMENT_DATA.ONSITE_VISITS_PER_WEEK],
        MONTHLY_FEE: fields[COLUMNS.HCM_AGREEMENT_DATA.MONTHLY_FEE],
        CURRENCY: fields[COLUMNS.HCM_AGREEMENT_DATA.CURRENCY],
        COMMERCIAL_REGISTRATION: firstParty.crNumber,
        REPRESENTATIVE_NAME: firstParty.representativeName,
        COMPANY_ADDRESS: firstParty.address,
        CONTRACT_DURATION_TEXT: fields[COLUMNS.HCM_AGREEMENT_DATA.CONTRACT_DURATION_TEXT],
        SERVICE_SCOPE_LIST_AR: buildServiceScopeList_(enabledServices, 'ar')
      };
    }
  },

  OFFSHORING_PROPOSAL: {
    key: 'OFFSHORING_PROPOSAL',
    label: 'Offshoring Proposal',
    product: CONFIG.PRODUCT.OFFSHORING,
    dataSheet: SHEETS.OFFSHORING_PROPOSAL_DATA,
    dataColumns: COLUMNS.OFFSHORING_PROPOSAL_DATA,
    templateSettingKey: SETTINGS_KEYS.OFFSHORING_PROPOSAL_TEMPLATE_ID,
    hasServiceSelection: false,
    dynamicBlocks: null,
    fields: [],
    buildPlaceholderMap: function (opportunity) {
      return {
        CLIENT_NAME: opportunity[COLUMNS.OPPORTUNITIES.COMPANY],
        MONTH_YEAR: formatMonthYear_(new Date())
      };
    }
  },

  OFFSHORING_AGREEMENT: {
    key: 'OFFSHORING_AGREEMENT',
    label: 'Offshoring Agreement',
    product: CONFIG.PRODUCT.OFFSHORING,
    dataSheet: SHEETS.OFFSHORING_AGREEMENT_DATA,
    dataColumns: COLUMNS.OFFSHORING_AGREEMENT_DATA,
    templateSettingKey: SETTINGS_KEYS.OFFSHORING_AGREEMENT_TEMPLATE_ID,
    hasServiceSelection: false,
    dynamicBlocks: null,
    requiresCommercialRegistration: true,
    fields: [
      { key: COLUMNS.OFFSHORING_AGREEMENT_DATA.MONTHLY_FEE, label: 'Fee (per employee / month)', type: FIELD_TYPE.NUMBER, required: true },
      { key: COLUMNS.OFFSHORING_AGREEMENT_DATA.CURRENCY, label: 'Currency (Arabic word, e.g. دولار)', type: FIELD_TYPE.TEXT, required: true,
        defaultSettingKey: SETTINGS_KEYS.DEFAULT_CURRENCY_AR },
      { key: COLUMNS.OFFSHORING_AGREEMENT_DATA.START_DATE, label: 'Contract Start Date', type: FIELD_TYPE.DATE, required: true },
      { key: COLUMNS.OFFSHORING_AGREEMENT_DATA.END_DATE, label: 'Contract End Date', type: FIELD_TYPE.DATE, required: true,
        autoCalcFrom: COLUMNS.OFFSHORING_AGREEMENT_DATA.START_DATE,
        hint: 'Calculated as start date + 1 year - 1 day. Change it only if this contract runs a different term.' }
    ],
    buildPlaceholderMap: function (opportunity, fields) {
      var firstParty = resolveFirstParty_(opportunity);
      return {
        CLIENT_NAME: firstParty.clientNameAr,
        // Always today, in the spreadsheet's timezone — never user-entered.
        AGREEMENT_DATE: formatDate_(todayInConfiguredTimezone_()),
        // This template writes the term in Arabic prose ("1 أبريل 2026م"),
        // so the picked dates are formatted accordingly rather than dd/MM/yyyy.
        START_DATE: formatArabicDate_(fields[COLUMNS.OFFSHORING_AGREEMENT_DATA.START_DATE]),
        END_DATE: formatArabicDate_(fields[COLUMNS.OFFSHORING_AGREEMENT_DATA.END_DATE]),
        MONTHLY_FEE: fields[COLUMNS.OFFSHORING_AGREEMENT_DATA.MONTHLY_FEE],
        CURRENCY: fields[COLUMNS.OFFSHORING_AGREEMENT_DATA.CURRENCY],
        COMMERCIAL_REGISTRATION: firstParty.crNumber,
        REPRESENTATIVE_NAME: firstParty.representativeName,
        COMPANY_ADDRESS: firstParty.address
      };
    }
  }
};

/**
 * Returns the two document types valid for a given Product, in a stable
 * order (Proposal first, Agreement second) — this is what powers the
 * "choose Proposal or Agreement" step of the wizard.
 * @param {string} product One of CONFIG.PRODUCT.*.
 * @return {Array<Object>}
 */
function getDocumentTypesForProduct_(product) {
  return Object.keys(DOCUMENT_TYPES)
    .map(function (k) { return DOCUMENT_TYPES[k]; })
    .filter(function (dt) { return dt.product === product; })
    .sort(function (a, b) { return a.key.indexOf('AGREEMENT') - b.key.indexOf('AGREEMENT'); });
}

/**
 * Builds the "Sections 3.1 through 3.N" (or singular "Section 3.1") string
 * for the HCM Proposal's Pricing Structure paragraph.
 * @param {number} count
 * @return {string}
 */
function buildSectionRange_(count) {
  if (count <= 1) return 'Section 3.1';
  return 'Sections 3.1 through 3.' + count;
}

/**
 * Builds the pipe-separated scope list from enabled services only, in the
 * requested locale.
 * @param {Array<Object>} enabledServices Entries from SERVICE_REGISTRY.
 * @param {string} locale 'en' or 'ar'.
 * @return {string}
 */
function buildServiceScopeList_(enabledServices, locale) {
  var labelField = locale === 'ar' ? 'labelAr' : 'labelEn';
  return enabledServices.map(function (svc) { return svc[labelField]; }).join(' | ');
}
