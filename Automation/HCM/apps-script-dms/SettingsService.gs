/**
 * SettingsService.gs
 *
 * Reads/writes the Settings sheet — the only place template IDs, the output
 * folder, and default values live. Cached per-execution so repeated reads
 * during one document generation don't re-hit the sheet.
 */

var _settingsCache_ = null;

/**
 * Returns all Settings as a {key: value} object, cached for this execution.
 * @return {Object<string, string>}
 */
function getSettings_() {
  if (_settingsCache_) return _settingsCache_;

  var sheet = getSheet_(SHEETS.SETTINGS);
  var headerMap = getHeaderIndexMap_(sheet);
  var lastRow = sheet.getLastRow();
  var settings = {};
  if (lastRow >= 2) {
    var keyCol = headerMap[COLUMNS.SETTINGS.KEY];
    var valCol = headerMap[COLUMNS.SETTINGS.VALUE];
    var values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    values.forEach(function (row) {
      var key = row[keyCol - 1];
      if (key) settings[String(key).trim()] = row[valCol - 1];
    });
  }
  _settingsCache_ = settings;
  return settings;
}

/**
 * Returns one Settings value, throwing a friendly error if it's required
 * but missing/blank.
 * @param {string} key One of SETTINGS_KEYS.*.
 * @param {boolean=} required Defaults to true.
 * @return {string}
 */
function getSetting_(key, required) {
  var settings = getSettings_();
  var value = settings[key];
  if ((value === undefined || value === null || value === '') && required !== false) {
    throw new AppError_(
      'Missing Setting',
      '"' + key + '" is not set in the Settings sheet.\n\nOpen the Settings sheet (or Talent 360 DMS > Settings) and fill it in.'
    );
  }
  return value;
}

/**
 * Writes one Settings value, creating the row if the key doesn't exist yet.
 * Invalidates the in-execution cache.
 * @param {string} key
 * @param {*} value
 */
function setSetting_(key, value) {
  var sheet = getSheet_(SHEETS.SETTINGS);
  var headerMap = getHeaderIndexMap_(sheet);
  var rows = findRowsWhere_(sheet, headerMap, COLUMNS.SETTINGS.KEY, key);
  if (rows.length > 0) {
    setCellByHeader_(sheet, rows[0], headerMap, COLUMNS.SETTINGS.VALUE, value);
  } else {
    var rowObj = {};
    rowObj[COLUMNS.SETTINGS.KEY] = key;
    rowObj[COLUMNS.SETTINGS.VALUE] = value;
    appendRowObject_(sheet, headerMap, rowObj);
  }
  _settingsCache_ = null;
}

/**
 * Confirms every setting a document generation needs actually resolves to
 * a usable Drive file. Throws a friendly AppError_ on the first problem.
 * @param {string} templateSettingKey One of SETTINGS_KEYS.*_TEMPLATE_ID.
 */
function validateTemplateSetting_(templateSettingKey) {
  var id = getSetting_(templateSettingKey);
  try {
    DriveApp.getFileById(id);
  } catch (e) {
    throw new AppError_(
      'Template Not Found',
      'The template configured for "' + templateSettingKey + '" (ID: ' + id + ') could not be opened.\n\n' +
      'Confirm the ID in the Settings sheet is correct and that this script has access to it.'
    );
  }
}
