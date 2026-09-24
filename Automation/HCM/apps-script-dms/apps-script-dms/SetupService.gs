/**
 * SetupService.gs
 *
 * Builds and repairs the entire 8-sheet spreadsheet in one click —
 * headers, frozen header rows, checkbox/dropdown data validation, and a
 * starter Settings sheet. Idempotent: safe to run repeatedly. Never
 * deletes or overwrites a sheet that already has data; it only creates
 * what's missing.
 */

/** Ordered header row for each data sheet that isn't a straight COLUMNS.* block. */
function _dataSheetHeaders_(extraColumnsBlock) {
  return [COLUMNS.DATA_COMMON.DOCUMENT_ID, COLUMNS.DATA_COMMON.OPPORTUNITY_ID, COLUMNS.DATA_COMMON.VERSION]
    .concat(Object.keys(extraColumnsBlock).map(function (k) { return extraColumnsBlock[k]; }));
}

/**
 * Menu action: "Initialize / Repair Sheets". Creates every sheet this
 * project needs if it doesn't already exist, with the correct header row,
 * frozen row 1, and data validation. Existing sheets/data are untouched.
 */
function setupSpreadsheet_() {
  try {
    _ensureSheetWithHeaders_(SHEETS.SETTINGS, [COLUMNS.SETTINGS.KEY, COLUMNS.SETTINGS.VALUE]);
    _seedDefaultSettings_();

    _ensureSheetWithHeaders_(SHEETS.OPPORTUNITIES, [
      COLUMNS.OPPORTUNITIES.ID, COLUMNS.OPPORTUNITIES.COMPANY, COLUMNS.OPPORTUNITIES.CONTACT,
      COLUMNS.OPPORTUNITIES.PRODUCT, COLUMNS.OPPORTUNITIES.STAGE, COLUMNS.OPPORTUNITIES.STATUS,
      COLUMNS.OPPORTUNITIES.OWNER, COLUMNS.OPPORTUNITIES.CREATED, COLUMNS.OPPORTUNITIES.NOTES
    ]);
    _applyOpportunityValidation_();

    _ensureSheetWithHeaders_(SHEETS.HCM_SERVICE_SELECTION, [
      COLUMNS.HCM_SERVICE_SELECTION.OPPORTUNITY_ID, COLUMNS.HCM_SERVICE_SELECTION.RECRUITMENT,
      COLUMNS.HCM_SERVICE_SELECTION.ONBOARDING, COLUMNS.HCM_SERVICE_SELECTION.BENEFITS,
      COLUMNS.HCM_SERVICE_SELECTION.PERFORMANCE, COLUMNS.HCM_SERVICE_SELECTION.RELATIONS,
      COLUMNS.HCM_SERVICE_SELECTION.COMPENSATION, COLUMNS.HCM_SERVICE_SELECTION.PERSONNEL,
      COLUMNS.HCM_SERVICE_SELECTION.UPDATED
    ]);

    _ensureSheetWithHeaders_(SHEETS.HCM_PROPOSAL_DATA, _dataSheetHeaders_(COLUMNS.HCM_PROPOSAL_DATA));
    _ensureSheetWithHeaders_(SHEETS.HCM_AGREEMENT_DATA, _dataSheetHeaders_(COLUMNS.HCM_AGREEMENT_DATA));
    _ensureSheetWithHeaders_(SHEETS.OFFSHORING_PROPOSAL_DATA, _dataSheetHeaders_(COLUMNS.OFFSHORING_PROPOSAL_DATA));
    _ensureSheetWithHeaders_(SHEETS.OFFSHORING_AGREEMENT_DATA, _dataSheetHeaders_(COLUMNS.OFFSHORING_AGREEMENT_DATA));

    _ensureSheetWithHeaders_(SHEETS.DOCUMENTS, [
      COLUMNS.DOCUMENTS.DOCUMENT_ID, COLUMNS.DOCUMENTS.OPPORTUNITY_ID, COLUMNS.DOCUMENTS.DOC_TYPE,
      COLUMNS.DOCUMENTS.VERSION, COLUMNS.DOCUMENTS.GENERATED_DATE, COLUMNS.DOCUMENTS.GENERATED_BY,
      COLUMNS.DOCUMENTS.URL, COLUMNS.DOCUMENTS.STATUS
    ]);

    // Put Opportunities first and Settings last, for a sensible tab order.
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var opp = ss.getSheetByName(SHEETS.OPPORTUNITIES);
    if (opp) ss.setActiveSheet(opp);

    showAlert_('Setup Complete', 'All sheets are created and ready.\n\nNext: open the Settings sheet and fill in the 4 template IDs and the output folder ID before generating documents.');
  } catch (err) {
    showError_(err);
  }
}

/**
 * Creates a sheet with the given header row if it doesn't already exist.
 * If it exists but is missing some of the given headers (e.g. after an
 * upgrade added a new field), appends the missing ones to the end rather
 * than reordering anything.
 * @param {string} sheetName
 * @param {Array<string>} headers
 */
function _ensureSheetWithHeaders_(sheetName, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    return;
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    return;
  }

  var existingHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  var missing = headers.filter(function (h) { return existingHeaders.indexOf(h) === -1; });
  if (missing.length > 0) {
    sheet.getRange(1, sheet.getLastColumn() + 1, 1, missing.length).setValues([missing]);
    sheet.getRange(1, sheet.getLastColumn() - missing.length + 1, 1, missing.length).setFontWeight('bold');
  }
}

/** Adds dropdown validation to Product/Stage/Status and checkbox-friendly formatting on Opportunities. */
function _applyOpportunityValidation_() {
  var sheet = getSheet_(SHEETS.OPPORTUNITIES);
  var headerMap = getHeaderIndexMap_(sheet);
  var maxRows = Math.max(sheet.getMaxRows() - 1, 500);

  var productRule = SpreadsheetApp.newDataValidation()
    .requireValueInList([CONFIG.PRODUCT.HCM, CONFIG.PRODUCT.OFFSHORING], true).setAllowInvalid(false).build();
  sheet.getRange(2, headerMap[COLUMNS.OPPORTUNITIES.PRODUCT], maxRows, 1).setDataValidation(productRule);

  var stageRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(CONFIG.PIPELINE_STAGES, true).setAllowInvalid(false).build();
  sheet.getRange(2, headerMap[COLUMNS.OPPORTUNITIES.STAGE], maxRows, 1).setDataValidation(stageRule);

  var statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList([CONFIG.STATUS.OPPORTUNITY_OPEN, CONFIG.STATUS.OPPORTUNITY_WON, CONFIG.STATUS.OPPORTUNITY_LOST], true)
    .setAllowInvalid(false).build();
  sheet.getRange(2, headerMap[COLUMNS.OPPORTUNITIES.STATUS], maxRows, 1).setDataValidation(statusRule);
}

/** Seeds the Settings sheet with every expected key (blank Value) if the key row doesn't exist yet. */
function _seedDefaultSettings_() {
  var sheet = getSheet_(SHEETS.SETTINGS);
  var headerMap = getHeaderIndexMap_(sheet);

  var defaults = {};
  defaults[SETTINGS_KEYS.HCM_PROPOSAL_TEMPLATE_ID] = '';
  defaults[SETTINGS_KEYS.HCM_AGREEMENT_TEMPLATE_ID] = '';
  defaults[SETTINGS_KEYS.OFFSHORING_PROPOSAL_TEMPLATE_ID] = '';
  defaults[SETTINGS_KEYS.OFFSHORING_AGREEMENT_TEMPLATE_ID] = '';
  defaults[SETTINGS_KEYS.OUTPUT_FOLDER_ID] = '';
  defaults[SETTINGS_KEYS.DEFAULT_CURRENCY] = 'EGP';
  defaults[SETTINGS_KEYS.DEFAULT_CURRENCY_AR] = 'جنيه';
  defaults[SETTINGS_KEYS.DEFAULT_ONSITE_VISITS_PER_WEEK] = '2';
  defaults[SETTINGS_KEYS.DEFAULT_VALIDITY_DAYS] = '10';
  defaults[SETTINGS_KEYS.DEFAULT_CONTRACT_DURATION_TEXT] = 'سنة ميلادية واحدة';

  var existingKeys = {};
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var keyCol = headerMap[COLUMNS.SETTINGS.KEY];
    sheet.getRange(2, keyCol, lastRow - 1, 1).getValues().forEach(function (row) {
      if (row[0]) existingKeys[String(row[0]).trim()] = true;
    });
  }

  Object.keys(defaults).forEach(function (key) {
    if (existingKeys[key]) return;
    var rowObj = {};
    rowObj[COLUMNS.SETTINGS.KEY] = key;
    rowObj[COLUMNS.SETTINGS.VALUE] = defaults[key];
    appendRowObject_(sheet, headerMap, rowObj);
  });

  _settingsCache_ = null;
}
