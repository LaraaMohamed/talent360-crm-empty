/**
 * Helpers.gs
 *
 * Generic, reusable utilities shared across every service module: sheet
 * access, header-name-based column lookup, row <-> object conversion, ID
 * generation, date handling, and small UI helpers. Nothing product- or
 * document-type-specific lives here.
 */

/**
 * Opens a sheet by name. Does not auto-create — run "Talent 360 DMS >
 * Initialize / Repair Sheets" (SetupService.gs's setupSpreadsheet_()) for
 * that. This getter is intentionally strict so a missing sheet fails
 * loudly and immediately, right where the caller can explain what to do.
 * @param {string} sheetName One of SHEETS.*.
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getSheet_(sheetName) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) {
    throw new AppError_(
      'Sheet Not Found',
      'No sheet named "' + sheetName + '" exists in this spreadsheet.\n\n' +
      'Run "Talent 360 DMS > Initialize / Repair Sheets" from the menu to create it.'
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
      'The "' + sheet.getName() + '" sheet has no header row.\n\n' +
      'Run "Talent 360 DMS > Initialize / Repair Sheets" from the menu.'
    );
  }
  var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  headerRow.forEach(function (header, i) {
    if (header) map[String(header).trim()] = i + 1;
  });
  return map;
}

/**
 * Reads a single data row into an object keyed by column header name.
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
 * @param {string} headerName
 * @param {*} value
 */
function setCellByHeader_(sheet, rowNumber, headerMap, headerName, value) {
  var col = headerMap[headerName];
  if (!col) {
    throw new AppError_('Missing Column', 'Expected a column named "' + headerName + '" in "' + sheet.getName() + '" but it was not found in row 1.');
  }
  sheet.getRange(rowNumber, col).setValue(value);
}

/**
 * Appends a full row built from a {header: value} object, in whatever
 * column order the sheet's actual headers are in (not the object's key
 * order) — so column reordering never scrambles a write.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Object<string, number>} headerMap From getHeaderIndexMap_.
 * @param {Object<string, *>} rowObj
 * @return {number} The 1-based row number written to.
 */
function appendRowObject_(sheet, headerMap, rowObj) {
  var newRow = sheet.getLastRow() + 1;
  if (newRow < 2) newRow = 2;
  Object.keys(rowObj).forEach(function (header) {
    if (headerMap[header]) {
      setCellByHeader_(sheet, newRow, headerMap, header, rowObj[header]);
    }
  });
  return newRow;
}

/**
 * Finds every row number (1-based) in a sheet whose value under the given
 * header matches matchValue. Used for "all versions of this document" /
 * "all documents for this Opportunity" style lookups.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Object<string, number>} headerMap
 * @param {string} headerName
 * @param {*} matchValue
 * @return {Array<number>}
 */
function findRowsWhere_(sheet, headerMap, headerName, matchValue) {
  var col = headerMap[headerName];
  if (!col) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  var rows = [];
  values.forEach(function (row, i) {
    if (row[0] === matchValue) rows.push(i + 2);
  });
  return rows;
}

/**
 * Generates the next sequential ID for a given prefix by scanning the
 * given sheet's ID column for the current max, e.g. "OPP-00042" -> next
 * is "OPP-00043". Zero-padded to CONFIG.ID_PAD_LENGTH.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Object<string, number>} headerMap
 * @param {string} idHeaderName
 * @param {string} prefix e.g. CONFIG.ID_PREFIX.OPPORTUNITY.
 * @return {string}
 */
function generateNextId_(sheet, headerMap, idHeaderName, prefix) {
  var col = headerMap[idHeaderName];
  var lastRow = sheet.getLastRow();
  var max = 0;
  if (col && lastRow >= 2) {
    var values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
    values.forEach(function (row) {
      var id = String(row[0] || '');
      var match = id.match(new RegExp('^' + prefix + '-(\\d+)$'));
      if (match) {
        var n = parseInt(match[1], 10);
        if (n > max) max = n;
      }
    });
  }
  var next = max + 1;
  var padded = String(next);
  while (padded.length < CONFIG.ID_PAD_LENGTH) padded = '0' + padded;
  return prefix + '-' + padded;
}

/**
 * Formats a Date as e.g. "July 2026" using the configured timezone/pattern.
 * @param {Date} date
 * @return {string}
 */
function formatMonthYear_(date) {
  return Utilities.formatDate(date, CONFIG.TIMEZONE, CONFIG.MONTH_YEAR_FORMAT);
}

/** Formats a Date as e.g. "29/07/2026". */
function formatDate_(date) {
  return Utilities.formatDate(date, CONFIG.TIMEZONE, CONFIG.DATE_FORMAT);
}

/**
 * Normalizes any date-ish cell value to a plain formatted string.
 *
 * Sheets silently auto-converts text that looks like a date into a real
 * Date object, even when the cell was written with a plain string. Reading
 * that cell back then returns a JS Date, and String(date) produces
 * something like "Wed Jul 01 2026 00:00:00 GMT+0300 (...)" if not caught.
 * Every date-shaped field must be routed through this before use.
 * @param {*} value
 * @param {string=} pattern Utilities.formatDate pattern; defaults to CONFIG.DATE_FORMAT.
 * @return {string}
 */
function normalizeDateValue_(value, pattern) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, CONFIG.TIMEZONE, pattern || CONFIG.DATE_FORMAT);
  }
  return value === undefined || value === null ? '' : String(value).trim();
}

/** Same idea as normalizeDateValue_, defaulted to the Month/Year pattern. */
function normalizeMonthYear_(value) {
  return normalizeDateValue_(value, CONFIG.MONTH_YEAR_FORMAT);
}

/** Escapes a string so it is safe to use as a literal in a RegExp search pattern. */
function escapeRegex_(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Escapes a string so it is safe to use as a Body#replaceText replacement —
 * that API's replacement string follows Java Matcher rules, where both "\"
 * and "$" are special (back-reference markers).
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

/**
 * Returns the 1-based row number the user currently has selected in the
 * given sheet, validated to be an actual data row (not the header).
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @return {number}
 */
function getActiveDataRow_(sheet) {
  var range = sheet.getActiveRange();
  if (!range || range.getSheet().getSheetId() !== sheet.getSheetId()) {
    throw new AppError_('No Row Selected', 'Click on a row in the "' + sheet.getName() + '" sheet first, then try again.');
  }
  var row = range.getRow();
  if (row < 2) {
    throw new AppError_('Invalid Selection', 'Please select a data row (row 2 or below), not the header row.');
  }
  return row;
}
