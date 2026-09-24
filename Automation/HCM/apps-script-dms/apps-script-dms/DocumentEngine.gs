/**
 * DocumentEngine.gs
 *
 * The one reusable document-generation pipeline. Every document type in
 * DOCUMENT_TYPES flows through the exact same code here: duplicate
 * template -> remove disabled service blocks -> renumber survivors ->
 * replace placeholders -> save -> return URL. Nothing in this file knows
 * about HCM, Offshoring, English, or Arabic specifically — all of that
 * comes in as data from the DocumentTypeRegistry entry it's given.
 */

/**
 * Generates one document. This is the single entry point every menu/UI
 * action should call.
 * @param {Object} docType One entry from DOCUMENT_TYPES.
 * @param {Object<string, *>} opportunity Row object from Opportunities (see Helpers.getRowObject_).
 * @param {Object<string, *>} fields Wizard form values, keyed by docType's field keys.
 * @param {Array<Object>} enabledServices Entries from SERVICE_REGISTRY (empty array if docType.hasServiceSelection is false).
 * @return {{doc: GoogleAppsScript.Document.Document, url: string}}
 */
function generateDocument_(docType, opportunity, fields, enabledServices) {
  var templateId = getSetting_(docType.templateSettingKey);
  var docName = docType.label + ' - ' + opportunity[COLUMNS.OPPORTUNITIES.COMPANY] + ' - ' + formatDate_(new Date());

  var doc = duplicateTemplate_(templateId, docName);
  var body = doc.getBody();

  if (docType.dynamicBlocks) {
    applyDynamicBlocks_(body, docType.dynamicBlocks, enabledServices);
  }

  var placeholderMap = docType.buildPlaceholderMap(opportunity, fields, enabledServices);
  applyPlaceholders_(body, placeholderMap);

  doc.saveAndClose();
  return { doc: doc, url: doc.getUrl() };
}

/**
 * Duplicates a template document into the configured output folder (or
 * the template's own folder if none is configured) and returns it opened.
 * @param {string} templateId
 * @param {string} name
 * @return {GoogleAppsScript.Document.Document}
 */
function duplicateTemplate_(templateId, name) {
  var templateFile = DriveApp.getFileById(templateId);
  var outputFolderId = getSetting_(SETTINGS_KEYS.OUTPUT_FOLDER_ID, false);
  var folder = outputFolderId
    ? DriveApp.getFolderById(outputFolderId)
    : (templateFile.getParents().hasNext() ? templateFile.getParents().next() : DriveApp.getRootFolder());
  var copy = templateFile.makeCopy(name, folder);
  return DocumentApp.openById(copy.getId());
}

/**
 * Removes every disabled service block and renumbers the survivors, using
 * the document-type-specific numbering format and terminal boundary text.
 * See DocumentTypeRegistry.gs's file header for the full design rationale.
 *
 * Two-phase on purpose: all structural removals happen first (re-searched
 * from scratch each time, so shifting indices are never a problem), and
 * only afterwards do we touch text via Body#replaceText, which preserves
 * each heading's existing rich-text formatting because the token lives
 * entirely inside one already-styled run.
 *
 * @param {GoogleAppsScript.Document.Body} body
 * @param {{registry: Array<Object>, numberFormat: function(number):string, terminalBoundaryText: string}} blockConfig
 * @param {Array<Object>} enabledServices Entries from SERVICE_REGISTRY.
 */
function applyDynamicBlocks_(body, blockConfig, enabledServices) {
  var enabledKeys = enabledServices.map(function (svc) { return svc.key; });

  blockConfig.registry.forEach(function (svc) {
    if (enabledKeys.indexOf(svc.key) !== -1) return; // handled in the renumbering pass below

    var startIndex = findParagraphIndexContaining_(body, svc.secToken, 0);
    if (startIndex === -1) return; // already removed / not present

    var endIndex = findNextBlockBoundary_(body, startIndex + 1, blockConfig);
    var removeCount = endIndex - startIndex;
    for (var r = 0; r < removeCount; r++) {
      body.removeChild(body.getChild(startIndex));
    }
  });

  var sequence = 0;
  blockConfig.registry.forEach(function (svc) {
    if (enabledKeys.indexOf(svc.key) === -1) return;
    sequence++;
    body.replaceText(escapeRegex_(svc.numToken), escapeReplacement_(blockConfig.numberFormat(sequence)));
    body.replaceText(escapeRegex_(svc.secToken), '');
  });
}

/**
 * Finds the child index of the next paragraph that starts a new block
 * (any registry entry's secToken) or contains the terminal boundary text —
 * whichever comes first.
 * @param {GoogleAppsScript.Document.Body} body
 * @param {number} fromIndex
 * @param {{terminalBoundaryText: string}} blockConfig
 * @return {number} Child index of the boundary, or body.getNumChildren() if none found.
 */
function findNextBlockBoundary_(body, fromIndex, blockConfig) {
  var n = body.getNumChildren();
  for (var i = fromIndex; i < n; i++) {
    var child = body.getChild(i);
    if (child.getType() === DocumentApp.ElementType.PARAGRAPH) {
      var text = child.asParagraph().getText();
      if (text.indexOf('{{SEC:') !== -1 || text.indexOf(blockConfig.terminalBoundaryText) !== -1) {
        return i;
      }
    }
  }
  return n;
}

/**
 * Finds the child index of the paragraph containing the given literal
 * substring. Re-scans from scratch each call, which is what keeps this
 * safe to call repeatedly as the body's children shift after removals.
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
 * Replaces every {{KEY}} token in the map with its value, escaping both the
 * search pattern and the replacement so arbitrary client data (a company
 * name containing "$", a representative name containing "\") can never
 * corrupt or be misinterpreted by the underlying regex-based replaceText.
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
