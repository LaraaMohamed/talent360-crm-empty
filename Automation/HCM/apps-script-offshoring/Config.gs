/**
 * Config.gs
 *
 * Single source of truth for every environment-specific value: the template
 * document, the sheet layout, and locale settings. Nothing else in the
 * project should contain a literal ID, sheet name, column header, or date
 * pattern — always go through CONFIG / COLUMNS.
 */
var CONFIG = {
  // The Google Doc to duplicate for every generated proposal.
  // Get this from the template's URL: https://docs.google.com/document/d/<THIS_PART>/edit
  TEMPLATE_DOC_ID: 'PUT_TEMPLATE_DOCUMENT_ID_HERE',

  // Optional: a Drive folder ID where generated proposals should be saved.
  // Leave as '' to save generated docs in the same folder as the template.
  OUTPUT_FOLDER_ID: '',

  // The sheet (tab) that holds the proposal data.
  SHEET_NAME: 'Proposals',

  TIMEZONE: 'Africa/Cairo',
  MONTH_YEAR_FORMAT: 'MMMM yyyy', // e.g. "July 2026"

  STATUS: {
    DRAFT: 'Draft',
    GENERATED: 'Generated',
    ERROR: 'Error'
  }
};

/**
 * Column header names as they must appear in row 1 of the sheet. The rest
 * of the codebase looks columns up BY THIS NAME (see Helpers.gs
 * getHeaderIndexMap_), never by a fixed index — reordering or inserting
 * sheet columns never breaks the code.
 *
 * To add a future field (e.g. Fee, Contract Duration, Prepared By):
 *   1. Add a header to the sheet.
 *   2. Add a key here pointing at that header text.
 *   3. Add the matching {{PLACEHOLDER}} in the Google Doc template.
 *   4. Add one line to TemplateEngine.buildPlaceholderMap_.
 * No other file needs to change.
 */
var COLUMNS = {
  CLIENT_NAME: 'Client Name',
  MONTH_YEAR: 'Month Year',
  GENERATED_DOC_URL: 'Generated Document URL',
  STATUS: 'Status'
};

/** Ordered header row used when creating the sheet from scratch. */
var SHEET_HEADERS = [
  COLUMNS.CLIENT_NAME,
  COLUMNS.MONTH_YEAR,
  COLUMNS.GENERATED_DOC_URL,
  COLUMNS.STATUS
];
