/**
 * Config.gs
 *
 * Single source of truth for sheet names, column headers, and system
 * enums. Nothing else in the project should contain a literal sheet name
 * or column header — always go through CONFIG / SHEETS / COLUMNS.
 *
 * Template IDs and other environment values (folder ID, default currency,
 * etc.) live in the Settings SHEET, not here — see SettingsService.gs.
 * That's deliberate: template IDs change per-deployment and should be
 * editable by whoever installs this, without opening the script editor.
 */

var CONFIG = {
  TIMEZONE: 'Africa/Cairo',
  MONTH_YEAR_FORMAT: 'MMMM yyyy',
  DATE_FORMAT: 'dd/MM/yyyy',

  ID_PREFIX: {
    OPPORTUNITY: 'OPP',
    DOCUMENT: 'DOC'
  },
  ID_PAD_LENGTH: 5,

  STATUS: {
    OPPORTUNITY_OPEN: 'Open',
    OPPORTUNITY_WON: 'Won',
    OPPORTUNITY_LOST: 'Lost',
    DOC_DRAFT: 'Draft',
    DOC_GENERATED: 'Generated',
    DOC_ERROR: 'Error'
  },

  PRODUCT: {
    HCM: 'HCM',
    OFFSHORING: 'Offshoring'
  },

  PIPELINE_STAGES: ['New', 'Qualifying', 'Proposal Sent', 'Negotiation', 'Won', 'Lost']
};

/** Sheet (tab) names. Every service module reads sheet names from here. */
var SHEETS = {
  SETTINGS: 'Settings',
  OPPORTUNITIES: 'Opportunities',
  COMMERCIAL_REGISTRATION: 'Commercial Registration',
  HCM_SERVICE_SELECTION: 'HCM Service Selection',
  HCM_PROPOSAL_DATA: 'HCM Proposal Data',
  HCM_AGREEMENT_DATA: 'HCM Agreement Data',
  OFFSHORING_PROPOSAL_DATA: 'Offshoring Proposal Data',
  OFFSHORING_AGREEMENT_DATA: 'Offshoring Agreement Data',
  DOCUMENTS: 'Documents'
};

/**
 * Column header names, one block per sheet. Every service module looks up
 * columns BY THIS NAME (see Helpers.gs getHeaderIndexMap_), never by a
 * fixed index — reordering or inserting a column in any sheet never
 * breaks the code.
 */
var COLUMNS = {
  SETTINGS: {
    KEY: 'Key',
    VALUE: 'Value'
  },

  OPPORTUNITIES: {
    ID: 'Opportunity ID',
    COMPANY: 'Company',
    CONTACT: 'Primary Contact',
    PRODUCT: 'Product',
    STAGE: 'Pipeline Stage',
    STATUS: 'Status',
    OWNER: 'Owner',
    CREATED: 'Creation Date',
    NOTES: 'Notes'
  },

  /**
   * Extracted (and user-confirmed) Commercial Registration data, one row per
   * Opportunity. Feeds the "First Party" / الطرف الأول block of every
   * agreement, so it lives at Opportunity level rather than per-document.
   */
  COMMERCIAL_REGISTRATION: {
    OPPORTUNITY_ID: 'Opportunity ID',
    COMPANY_NAME_AR: 'Company Name (Arabic)',
    CR_NUMBER: 'Commercial Registration Number',
    REPRESENTATIVE_NAME: 'Representative Name',
    ADDRESS: 'Company Address',
    NATIONAL_NUMBER: 'National Establishment Number',
    CONFIDENCE: 'OCR Confidence',
    SOURCE_FILE_URL: 'Source File URL',
    IMPORTED_BY: 'Imported By',
    IMPORTED_AT: 'Imported At'
  },

  HCM_SERVICE_SELECTION: {
    OPPORTUNITY_ID: 'Opportunity ID',
    RECRUITMENT: 'Recruitment',
    ONBOARDING: 'Employee Onboarding',
    BENEFITS: 'Benefits Administration',
    PERFORMANCE: 'Performance Management',
    RELATIONS: 'Employee Relations',
    COMPENSATION: 'Compensation Administration',
    PERSONNEL: 'Personnel Administration',
    UPDATED: 'Last Updated'
  },

  // Shared column names reused across every "*_DATA" sheet.
  DATA_COMMON: {
    DOCUMENT_ID: 'Document ID',
    OPPORTUNITY_ID: 'Opportunity ID',
    VERSION: 'Version'
  },

  HCM_PROPOSAL_DATA: {
    EMPLOYEES_TO_HIRE: 'Employees To Hire',
    ONSITE_VISITS_PER_WEEK: 'Onsite Visits Per Week',
    MONTHLY_FEE: 'Monthly Fee',
    CURRENCY: 'Currency',
    VALIDITY_DAYS: 'Proposal Validity (Days)'
  },

  /**
   * Note on the CR-sourced columns (CLIENT_NAME_AR, COMMERCIAL_REGISTRATION,
   * COMPANY_ADDRESS): these are NOT typed by the user. They're copied from
   * the Commercial Registration sheet at generation time, so each version
   * row snapshots exactly what went into that document even if the
   * Opportunity's CR is re-imported later.
   */
  HCM_AGREEMENT_DATA: {
    EMPLOYEES_TO_HIRE: 'Employees To Hire',
    ONSITE_VISITS_PER_WEEK: 'Onsite Visits Per Week',
    MONTHLY_FEE: 'Monthly Fee',
    CURRENCY: 'Currency',
    CLIENT_NAME_AR: 'Client Name (Arabic)',
    COMMERCIAL_REGISTRATION: 'Commercial Registration',
    REPRESENTATIVE_NAME: 'Representative Name',
    COMPANY_ADDRESS: 'Company Address',
    AGREEMENT_DATE: 'Agreement Date',
    START_DATE: 'Start Date',
    END_DATE: 'End Date',
    CONTRACT_DURATION_TEXT: 'Contract Duration Text'
  },

  OFFSHORING_PROPOSAL_DATA: {
    // No template-specific fields — this document is generated entirely
    // from Opportunity data (Client Name) + the generation date.
  },

  OFFSHORING_AGREEMENT_DATA: {
    CLIENT_NAME_AR: 'Client Name (Arabic)',
    COMMERCIAL_REGISTRATION: 'Commercial Registration',
    REPRESENTATIVE_NAME: 'Representative Name',
    COMPANY_ADDRESS: 'Company Address',
    AGREEMENT_DATE: 'Agreement Date',
    START_DATE: 'Start Date',
    END_DATE: 'End Date',
    MONTHLY_FEE: 'Monthly Fee',
    CURRENCY: 'Currency'
  },

  DOCUMENTS: {
    DOCUMENT_ID: 'Document ID',
    OPPORTUNITY_ID: 'Opportunity ID',
    DOC_TYPE: 'Document Type',
    VERSION: 'Version',
    GENERATED_DATE: 'Generated Date',
    GENERATED_BY: 'Generated By',
    URL: 'Google Doc URL',
    STATUS: 'Status'
  }
};

/** Settings-sheet key names (values live in the sheet, not here). */
var SETTINGS_KEYS = {
  HCM_PROPOSAL_TEMPLATE_ID: 'HCM Proposal Template ID',
  HCM_AGREEMENT_TEMPLATE_ID: 'HCM Agreement Template ID',
  OFFSHORING_PROPOSAL_TEMPLATE_ID: 'Offshoring Proposal Template ID',
  OFFSHORING_AGREEMENT_TEMPLATE_ID: 'Offshoring Agreement Template ID',
  OUTPUT_FOLDER_ID: 'Output Folder ID',
  CR_ARCHIVE_FOLDER_ID: 'Commercial Registration Archive Folder ID',
  OCR_PROVIDER: 'OCR Provider',
  OCR_LANGUAGE: 'OCR Language',
  DEFAULT_CONTRACT_YEARS: 'Default Contract Duration (Years)',
  DEFAULT_CURRENCY: 'Default Currency',
  DEFAULT_CURRENCY_AR: 'Default Currency (Arabic)',
  DEFAULT_ONSITE_VISITS_PER_WEEK: 'Default Onsite Visits Per Week',
  DEFAULT_VALIDITY_DAYS: 'Default Proposal Validity (Days)',
  DEFAULT_CONTRACT_DURATION_TEXT: 'Default Contract Duration Text (Arabic)'
};
