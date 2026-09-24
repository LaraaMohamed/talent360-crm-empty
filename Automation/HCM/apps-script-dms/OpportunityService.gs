/**
 * OpportunityService.gs
 *
 * CRUD for the Opportunities sheet, Opportunity ID generation, and
 * read/write access to the shared HCM Service Selection table — the one
 * place "which HCM services are enabled" is stored, so the HCM Proposal
 * and HCM Agreement can never drift out of sync with each other.
 */

/**
 * Creates a new Opportunity row and returns its full row object.
 * @param {{company: string, contact: string, product: string, owner: string, notes: string}} input
 * @return {Object<string, *>} The created Opportunity, keyed by COLUMNS.OPPORTUNITIES.*.
 */
function createOpportunity_(input) {
  var sheet = getSheet_(SHEETS.OPPORTUNITIES);
  var headerMap = getHeaderIndexMap_(sheet);
  var id = generateNextId_(sheet, headerMap, COLUMNS.OPPORTUNITIES.ID, CONFIG.ID_PREFIX.OPPORTUNITY);

  var rowObj = {};
  rowObj[COLUMNS.OPPORTUNITIES.ID] = id;
  rowObj[COLUMNS.OPPORTUNITIES.COMPANY] = input.company;
  rowObj[COLUMNS.OPPORTUNITIES.CONTACT] = input.contact || '';
  rowObj[COLUMNS.OPPORTUNITIES.PRODUCT] = input.product;
  rowObj[COLUMNS.OPPORTUNITIES.STAGE] = CONFIG.PIPELINE_STAGES[0];
  rowObj[COLUMNS.OPPORTUNITIES.STATUS] = CONFIG.STATUS.OPPORTUNITY_OPEN;
  rowObj[COLUMNS.OPPORTUNITIES.OWNER] = input.owner || Session.getActiveUser().getEmail();
  rowObj[COLUMNS.OPPORTUNITIES.CREATED] = formatDate_(new Date());
  rowObj[COLUMNS.OPPORTUNITIES.NOTES] = input.notes || '';

  var rowNumber = appendRowObject_(sheet, headerMap, rowObj);

  if (input.product === CONFIG.PRODUCT.HCM) {
    createDefaultHcmServiceSelection_(id);
  }

  sheet.setActiveSelection(sheet.getRange(rowNumber, headerMap[COLUMNS.OPPORTUNITIES.ID]));
  return rowObj;
}

/**
 * Reads the Opportunity row currently selected in the sheet.
 * @return {{row: Object<string,*>, rowNumber: number, headerMap: Object<string,number>, sheet: GoogleAppsScript.Spreadsheet.Sheet}}
 */
function getSelectedOpportunity_() {
  var sheet = getSheet_(SHEETS.OPPORTUNITIES);
  var headerMap = getHeaderIndexMap_(sheet);
  var rowNumber = getActiveDataRow_(sheet);
  var row = getRowObject_(sheet, rowNumber, headerMap);
  if (!row[COLUMNS.OPPORTUNITIES.ID]) {
    throw new AppError_('Empty Row', 'The selected row has no Opportunity ID — select a row that contains an Opportunity.');
  }
  return { row: row, rowNumber: rowNumber, headerMap: headerMap, sheet: sheet };
}

/**
 * Looks up one Opportunity by ID.
 * @param {string} opportunityId
 * @return {Object<string,*>}
 */
function getOpportunityById_(opportunityId) {
  var sheet = getSheet_(SHEETS.OPPORTUNITIES);
  var headerMap = getHeaderIndexMap_(sheet);
  var rows = findRowsWhere_(sheet, headerMap, COLUMNS.OPPORTUNITIES.ID, opportunityId);
  if (rows.length === 0) {
    throw new AppError_('Opportunity Not Found', 'No Opportunity with ID "' + opportunityId + '" was found.');
  }
  return getRowObject_(sheet, rows[0], headerMap);
}

/**
 * Creates the HCM Service Selection row for a new HCM Opportunity, with
 * every service defaulted to TRUE (per the product brief — the user only
 * removes unwanted services, never opts in from a blank state).
 * @param {string} opportunityId
 */
function createDefaultHcmServiceSelection_(opportunityId) {
  var sheet = getSheet_(SHEETS.HCM_SERVICE_SELECTION);
  var headerMap = getHeaderIndexMap_(sheet);

  var existing = findRowsWhere_(sheet, headerMap, COLUMNS.HCM_SERVICE_SELECTION.OPPORTUNITY_ID, opportunityId);
  if (existing.length > 0) return; // already has a selection row

  var rowObj = {};
  rowObj[COLUMNS.HCM_SERVICE_SELECTION.OPPORTUNITY_ID] = opportunityId;
  SERVICE_REGISTRY.forEach(function (svc) { rowObj[svc.column] = true; });
  rowObj[COLUMNS.HCM_SERVICE_SELECTION.UPDATED] = formatDate_(new Date());

  var rowNumber = appendRowObject_(sheet, headerMap, rowObj);
  SERVICE_REGISTRY.forEach(function (svc) {
    sheet.getRange(rowNumber, headerMap[svc.column]).insertCheckboxes();
    sheet.getRange(rowNumber, headerMap[svc.column]).setValue(true);
  });
}

/**
 * Reads the HCM Service Selection row for an Opportunity, creating a
 * default (all-enabled) one if it doesn't exist yet — defensive, in case
 * an Opportunity's Product was changed to HCM after creation.
 * @param {string} opportunityId
 * @return {Object<string, *>} Keyed by COLUMNS.HCM_SERVICE_SELECTION.*.
 */
function getHcmServiceSelection_(opportunityId) {
  var sheet = getSheet_(SHEETS.HCM_SERVICE_SELECTION);
  var headerMap = getHeaderIndexMap_(sheet);
  var rows = findRowsWhere_(sheet, headerMap, COLUMNS.HCM_SERVICE_SELECTION.OPPORTUNITY_ID, opportunityId);
  if (rows.length === 0) {
    createDefaultHcmServiceSelection_(opportunityId);
    rows = findRowsWhere_(sheet, headerMap, COLUMNS.HCM_SERVICE_SELECTION.OPPORTUNITY_ID, opportunityId);
  }
  return getRowObject_(sheet, rows[0], headerMap);
}

/**
 * Writes an updated HCM Service Selection for an Opportunity (called from
 * the Generate Document wizard when the user changes which services are
 * checked). Both HCM documents will pick up this same state on their next
 * generation.
 * @param {string} opportunityId
 * @param {Object<string, boolean>} enabledMap Keyed by SERVICE_REGISTRY[].key (e.g. "RECRUITMENT").
 */
function setHcmServiceSelection_(opportunityId, enabledMap) {
  var sheet = getSheet_(SHEETS.HCM_SERVICE_SELECTION);
  var headerMap = getHeaderIndexMap_(sheet);
  var rows = findRowsWhere_(sheet, headerMap, COLUMNS.HCM_SERVICE_SELECTION.OPPORTUNITY_ID, opportunityId);
  if (rows.length === 0) {
    createDefaultHcmServiceSelection_(opportunityId);
    rows = findRowsWhere_(sheet, headerMap, COLUMNS.HCM_SERVICE_SELECTION.OPPORTUNITY_ID, opportunityId);
  }
  var rowNumber = rows[0];
  SERVICE_REGISTRY.forEach(function (svc) {
    if (Object.prototype.hasOwnProperty.call(enabledMap, svc.key)) {
      setCellByHeader_(sheet, rowNumber, headerMap, svc.column, enabledMap[svc.key] === true);
    }
  });
  setCellByHeader_(sheet, rowNumber, headerMap, COLUMNS.HCM_SERVICE_SELECTION.UPDATED, formatDate_(new Date()));
}
