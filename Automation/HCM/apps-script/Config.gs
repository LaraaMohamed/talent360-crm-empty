/**
 * Config.gs
 *
 * Single source of truth for every environment-specific value the project needs:
 * the template document, the sheet layout, and locale settings.
 *
 * Nothing else in the project should contain a literal ID, sheet name, column
 * header, or date pattern — always go through CONFIG / COLUMNS so there is
 * exactly one place to update when something changes.
 */

/**
 * @typedef {Object} AppConfig
 */
var CONFIG = {
  // The Google Doc to duplicate for every generated proposal.
  // Get this from the template's URL: https://docs.google.com/document/d/<THIS_PART>/edit
  TEMPLATE_DOC_ID: '1KgOVJLQykkB1MOJtOaI1JdwboPcYRXTpLL3E9bIU3qA',

  // Optional: a Drive folder ID where generated proposals should be saved.
  // Leave as '' to save generated docs in the same folder as the template.
  OUTPUT_FOLDER_ID: '',

  // The sheet (tab) that holds the proposal data.
  SHEET_NAME: 'Proposals',

  // Used for formatting the auto-generated Month Year value and any future
  // date-based placeholders.
  TIMEZONE: 'Africa/Cairo',
  MONTH_YEAR_FORMAT: 'MMMM yyyy', // e.g. "July 2026"

  STATUS: {
    DRAFT: 'Draft',
    GENERATED: 'Generated',
    ERROR: 'Error'
  }
};

/**
 * Column header names as they must appear in row 1 of the sheet.
 *
 * The rest of the codebase looks columns up BY THIS NAME (see Helpers.gs
 * getHeaderIndexMap_), never by a fixed index. That means you can reorder,
 * insert, or add columns in the sheet at any time without touching code —
 * as long as the header text still matches the value below.
 *
 * To add a brand-new sheet-driven field in the future (e.g. Commercial Terms,
 * Prepared By, Contract Duration):
 *   1. Add a header to the sheet.
 *   2. Add a key here pointing at that header text.
 *   3. Add the matching {{PLACEHOLDER}} in the Google Doc template.
 *   4. Add one line to TemplateEngine.buildPlaceholderMap_.
 * No other file needs to change.
 */
var COLUMNS = {
  CLIENT_NAME: 'Client Name',
  MONTH_YEAR: 'Month Year',

  // Section 3 service toggles — keys here must match ServiceRegistry.gs SERVICE_REGISTRY[].column
  RECRUITMENT: 'Recruitment',
  ONBOARDING: 'Employee Onboarding',
  BENEFITS: 'Benefits Administration',
  PERFORMANCE: 'Performance Management',
  RELATIONS: 'Employee Relations',
  COMPENSATION: 'Compensation Administration',
  PERSONNEL: 'Personnel Administration',

  EMPLOYEES_TO_HIRE: 'Employees To Hire',
  ONSITE_VISITS_PER_WEEK: 'Onsite Visits Per Week',
  MONTHLY_FEE: 'Monthly Fee',
  CURRENCY: 'Currency',

  GENERATED_DOC_URL: 'Generated Document URL',
  STATUS: 'Status'
};

/** Ordered header row used when creating the sheet from scratch. */
var SHEET_HEADERS = [
  COLUMNS.CLIENT_NAME,
  COLUMNS.MONTH_YEAR,
  COLUMNS.RECRUITMENT,
  COLUMNS.ONBOARDING,
  COLUMNS.BENEFITS,
  COLUMNS.PERFORMANCE,
  COLUMNS.RELATIONS,
  COLUMNS.COMPENSATION,
  COLUMNS.PERSONNEL,
  COLUMNS.EMPLOYEES_TO_HIRE,
  COLUMNS.ONSITE_VISITS_PER_WEEK,
  COLUMNS.MONTHLY_FEE,
  COLUMNS.CURRENCY,
  COLUMNS.GENERATED_DOC_URL,
  COLUMNS.STATUS
];
