/**
 * TemplateEngine.gs
 *
 * Everything that touches the Google Doc lives here: duplicating the
 * template and replacing the two placeholders it contains. Deliberately
 * simple — this proposal has no conditional/removable sections, so there's
 * no need for the block-locating logic the main HCM proposal generator uses.
 */

/**
 * Duplicates the configured template and returns the opened Document.
 * @param {string} name Name for the new file.
 * @return {GoogleAppsScript.Document.Document}
 */
function duplicateTemplate_(name) {
  var templateFile = DriveApp.getFileById(CONFIG.TEMPLATE_DOC_ID);
  var folder = CONFIG.OUTPUT_FOLDER_ID
    ? DriveApp.getFolderById(CONFIG.OUTPUT_FOLDER_ID)
    : templateFile.getParents().hasNext()
      ? templateFile.getParents().next()
      : DriveApp.getRootFolder();
  var copy = templateFile.makeCopy(name, folder);
  return DocumentApp.openById(copy.getId());
}

/**
 * Builds the {token: value} map for every placeholder in the template.
 * This is the one place to extend when adding a brand-new sheet-driven
 * field (see Config.gs COLUMNS doc comment).
 * @param {Object<string, *>} rowObj Keyed by COLUMNS.*.
 * @return {Object<string, string>}
 */
function buildPlaceholderMap_(rowObj) {
  return {
    CLIENT_NAME: rowObj[COLUMNS.CLIENT_NAME],
    MONTH_YEAR: normalizeMonthYear_(rowObj[COLUMNS.MONTH_YEAR])
  };
}

/**
 * Replaces every {{KEY}} token in the map with its value, escaping both the
 * search pattern (regex-special characters) and the replacement (the "$"
 * and "\" back-reference characters) so arbitrary client data can never
 * corrupt or be misinterpreted by the underlying regex-based replaceText call.
 * @param {GoogleAppsScript.Document.Body} body
 * @param {Object<string, string>} placeholderMap
 */
function applyPlaceholders_(body, placeholderMap) {
  Object.keys(placeholderMap).forEach(function (key) {
    var value = placeholderMap[key];
    var pattern = escapeRegex_('{{' + key + '}}');
    body.replaceText(pattern, escapeReplacement_(value === undefined || value === null ? '' : value));
  });
}
