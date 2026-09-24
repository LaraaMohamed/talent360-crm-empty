/**
 * TemplateEngine.gs
 *
 * Everything that touches the Google Doc lives here: duplicating the
 * template, building Section 3 dynamically (removing unchecked services and
 * renumbering the rest), and replacing the remaining simple placeholders.
 *
 * Design note on Section 3:
 * We deliberately do NOT use fragile whole-document find & replace for
 * removable content. Each service's heading paragraph in the template
 * carries two control tokens (see ServiceRegistry.gs for the full
 * explanation): {{SEC:<KEY>}} marks/locates the block, {{NUM:<KEY>}} is
 * where its assigned "3.N" number goes. A block runs from its heading up to
 * (not including) the next block's heading, or Section 4, whichever comes
 * first — so no table or paragraph is ever a fragile, separately-tracked
 * marker pair.
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
 * Finds the index (within body's direct children) of the next paragraph that
 * starts a new Section-3 block, or begins Section 4 — whichever comes first.
 * @param {GoogleAppsScript.Document.Body} body
 * @param {number} fromIndex Search starts at this child index (inclusive).
 * @return {number} Child index of the boundary, or body.getNumChildren() if none found.
 */
function findNextSectionBoundary_(body, fromIndex) {
  var n = body.getNumChildren();
  for (var i = fromIndex; i < n; i++) {
    var child = body.getChild(i);
    if (child.getType() === DocumentApp.ElementType.PARAGRAPH) {
      var text = child.asParagraph().getText();
      if (text.indexOf('{{SEC:') !== -1 || text.indexOf('4. Service Delivery Team') !== -1) {
        return i;
      }
    }
  }
  return n;
}

/**
 * Finds the child index of the paragraph containing the given literal
 * substring. Re-scans from the given start index each call, which is what
 * keeps this safe to call repeatedly as the body's children shift after
 * removals.
 * @param {GoogleAppsScript.Document.Body} body
 * @param {string} substring
 * @param {number} fromIndex
 * @return {number} Child index, or -1 if not found.
 */
function findParagraphIndexContaining_(body, substring, fromIndex) {
  var n = body.getNumChildren();
  for (var i = fromIndex; i < n; i++) {
    var child = body.getChild(i);
    if (child.getType() === DocumentApp.ElementType.PARAGRAPH &&
      child.asParagraph().getText().indexOf(substring) !== -1) {
      return i;
    }
  }
  return -1;
}

/**
 * Removes every service block whose checkbox is unchecked, then renumbers
 * the remaining blocks as 3.1, 3.2, 3.3... in SERVICE_REGISTRY order.
 *
 * Two-phase on purpose: all structural removals happen first (searched fresh
 * each time, so shifting indices are never a problem), and only afterwards
 * do we touch text — via Body#replaceText, which preserves the heading's
 * existing rich-text formatting (bold, color, size) because the token lives
 * entirely inside one already-styled run.
 *
 * @param {GoogleAppsScript.Document.Body} body
 * @param {Object<string, *>} rowObj Keyed by COLUMNS.* (see Helpers.getRowObject_).
 */
function applySection3_(body, rowObj) {
  SERVICE_REGISTRY.forEach(function (svc) {
    var enabled = rowObj[svc.column] === true;
    if (enabled) return; // handled in the renumbering pass below

    var startIndex = findParagraphIndexContaining_(body, svc.secToken, 0);
    if (startIndex === -1) return; // already removed / not present — nothing to do

    var endIndex = findNextSectionBoundary_(body, startIndex + 1);
    var removeCount = endIndex - startIndex;
    for (var r = 0; r < removeCount; r++) {
      body.removeChild(body.getChild(startIndex));
    }
  });

  var sequence = 0;
  SERVICE_REGISTRY.forEach(function (svc) {
    if (rowObj[svc.column] !== true) return;
    sequence++;
    body.replaceText(escapeRegex_(svc.numToken), '3.' + sequence);
    body.replaceText(escapeRegex_(svc.secToken), '');
  });
}

/**
 * Builds the "Sections 3.1 through 3.N" (or singular "Section 3.1") string
 * used in the Pricing Structure paragraph.
 * @param {number} count Number of enabled services.
 * @return {string}
 */
function computeSectionRange_(count) {
  if (count <= 1) return 'Section 3.1';
  return 'Sections 3.1 through 3.' + count;
}

/**
 * Builds the pipe-separated scope list (e.g. used in the Executive Summary
 * table and the Pricing Structure paragraph) from the enabled services only.
 * @param {Array<Object>} enabledServices Entries from SERVICE_REGISTRY.
 * @return {string}
 */
function computeServiceScopeList_(enabledServices) {
  return enabledServices.map(function (svc) { return svc.scopeLabel; }).join(' | ');
}

/**
 * Builds the {token: value} map for every simple (non-Section-3-structural)
 * placeholder in the template. This is the one place to extend when adding
 * a brand-new sheet-driven field (see Config.gs COLUMNS doc comment).
 * @param {Object<string, *>} rowObj Keyed by COLUMNS.*.
 * @param {Array<Object>} enabledServices Entries from SERVICE_REGISTRY.
 * @return {Object<string, string>}
 */
function buildPlaceholderMap_(rowObj, enabledServices) {
  var count = enabledServices.length;
  return {
    CLIENT_NAME: rowObj[COLUMNS.CLIENT_NAME],
    MONTH_YEAR: normalizeMonthYear_(rowObj[COLUMNS.MONTH_YEAR]),
    EMPLOYEES_TO_HIRE: rowObj[COLUMNS.EMPLOYEES_TO_HIRE],
    ONSITE_VISITS_PER_WEEK: rowObj[COLUMNS.ONSITE_VISITS_PER_WEEK],
    MONTHLY_FEE: rowObj[COLUMNS.MONTHLY_FEE],
    CURRENCY: rowObj[COLUMNS.CURRENCY],
    SERVICE_SCOPE_LIST: computeServiceScopeList_(enabledServices),
    SECTION_RANGE: computeSectionRange_(count),
    SERVICE_COUNT_WORD: COUNT_WORDS[count] || String(count)
  };
}

/**
 * Replaces every {{KEY}} token in the map with its value, escaping both the
 * search pattern (regex-special characters) and the replacement (the "$"
 * back-reference character) so arbitrary client data can never corrupt or
 * be misinterpreted by the underlying regex-based replaceText call.
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
