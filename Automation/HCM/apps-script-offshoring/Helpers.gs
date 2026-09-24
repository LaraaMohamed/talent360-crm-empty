/**
 * Helpers.gs
 *
 * Generic, reusable utilities: sheet access, header-name-based column
 * lookup, row <-> object conversion, and small UI helpers. Nothing
 * proposal-specific lives here.
 */

/**
 * Opens the configured sheet.
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getSheet_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    throw new AppError_(
      'Sheet Not Found',
      'No sheet named "' + CONFIG.SHEET_NAME + '" exists in this spreadsheet.\n\n' +
      'Create it (Insert > Sheet) and name it exactly "' + CONFIG.SHEET_NAME + '", ' +
      'or update CONFIG.SHEET_NAME in Config.gs to match your sheet name.'
    );
  }
  return sheet;
}

/**
 * Reads row 1 and returns a map of header text -> 1-based column index.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @return {Object<string, number>}
 */
function getHeaderIndexMap_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) {
    throw new AppError_(
      'Sheet Not Set Up',
      'The "' + sheet.getName() + '" sheet has no header row yet.\n\n' +
      'Run "Proposal Generator > New Proposal" once the header row (' +
      SHEET_HEADERS.join(', ') + ') has been added, or call ensureHeaders_(sheet) once.'
    );
  }
  var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  headerRow.forEach(function (header, i) {
    if (header) map[String(header).trim()] = i + 1; // 1-based column index
  });
  return map;
}

/**
 * Ensures the sheet has the expected header row. Writes it if the sheet is
 * completely empty; otherwise leaves existing headers untouched.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function ensureHeaders_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, SHEET_HEADERS.length).setValues([SHEET_HEADERS]);
    sheet.setFrozenRows(1);
  }
}

/**
 * Reads a single data row into an object keyed by column header name
 * (i.e. keyed by the values in COLUMNS.*).
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} rowNumber 1-based row number.
 * @param {Object<string, number>} headerMap From getHeaderIndexMap_.
 * @return {Object<string, *>}
 */
function getRowObject_(sheet, rowNumber, headerMap) {
  var lastCol = sheet.getLastColumn();
  var values = sheet.getRange(rowNumber, 1, 1, lastCol).getValues()[0];
  var obj = {};
  Object.keys(headerMap).forEach(function (header) {
    obj[header] = values[headerMap[header] - 1];
  });
  return obj;
}

/**
 * Writes a single value into a row under the given header name.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} rowNumber 1-based row number.
 * @param {Object<string, number>} headerMap From getHeaderIndexMap_.
 * @param {string} headerName One of COLUMNS.*.
 * @param {*} value
 */
function setCellByHeader_(sheet, rowNumber, headerMap, headerName, value) {
  var col = headerMap[headerName];
  if (!col) {
    throw new AppError_(
      'Missing Column',
      'Expected a column named "' + headerName + '" but it was not found in row 1.'
    );
  }
  sheet.getRange(rowNumber, col).setValue(value);
}

/**
 * Formats a Date as e.g. "July 2026" using the configured timezone/pattern.
 * @param {Date} date
 * @return {string}
 */
function formatMonthYear_(date) {
  return Utilities.formatDate(date, CONFIG.TIMEZONE, CONFIG.MONTH_YEAR_FORMAT);
}

/**
 * Normalizes a "Month Year" cell value to the "July 2026" string form.
 *
 * Sheets silently auto-converts text that looks like a date (e.g. a value
 * typed or pasted as "July 2026") into a real Date, even though the cell
 * was written with a plain string. Reading that cell back then returns a
 * JS Date object instead of text, and String(date) produces something like
 * "Wed Jul 01 2026 00:00:00 GMT+0300 (...)" if not caught. Always route the
 * value through this before using it, regardless of how it got into the cell.
 * @param {*} value Raw cell value — expected to be a string, but may be a Date.
 * @return {string}
 */
function normalizeMonthYear_(value) {
  if (value instanceof Date) return formatMonthYear_(value);
  return value === undefined || value === null ? '' : String(value).trim();
}

/**
 * Returns the 1-based row number the user currently has selected in the
 * sheet, validated to be an actual data row (not the header).
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @return {number}
 */
function getActiveDataRow_(sheet) {
  var range = sheet.getActiveRange();
  if (!range || range.getSheet().getSheetId() !== sheet.getSheetId()) {
    throw new AppError_(
      'No Row Selected',
      'Click on a row in the "' + sheet.getName() + '" sheet first, then run this command again.'
    );
  }
  var row = range.getRow();
  if (row < 2) {
    throw new AppError_(
      'Invalid Selection',
      'Please select a proposal data row (row 2 or below), not the header row.'
    );
  }
  return row;
}

/** Escapes a string so it is safe to use as a literal in a RegExp search pattern. */
function escapeRegex_(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Escapes a string so it is safe to use as a Body#replaceText replacement —
 * that API's replacement string follows Java Matcher rules, where both "\"
 * and "$" are special (back-reference markers), so any literal occurrence in
 * client-supplied data (a company name) must be doubled.
 */
function escapeReplacement_(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/\$/g, '$$$$');
}

/** A small Error subclass carrying a user-friendly title, shown via showError_. */
function AppError_(title, message) {
  this.name = 'AppError_';
  this.title = title;
  this.message = message;
}
AppError_.prototype = Object.create(Error.prototype);

/** Shows a friendly alert dialog. */
function showAlert_(title, message) {
  SpreadsheetApp.getUi().alert(title, message, SpreadsheetApp.getUi().ButtonSet.OK);
}

/** Shows an error dialog, using the AppError_'s own title when available. */
function showError_(err) {
  var title = err && err.title ? err.title : 'Something Went Wrong';
  var message = err && err.message ? err.message : String(err);
  showAlert_(title, message);
}
