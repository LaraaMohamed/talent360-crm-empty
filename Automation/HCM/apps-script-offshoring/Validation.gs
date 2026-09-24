/**
 * Validation.gs
 *
 * All pre-flight checks live here. Every check either passes silently or
 * returns/throws a friendly, specific message — never a raw stack trace.
 */

/**
 * Confirms the template document and the data sheet actually exist.
 * Throws AppError_ on failure.
 */
function validateEnvironment_() {
  if (!CONFIG.TEMPLATE_DOC_ID || CONFIG.TEMPLATE_DOC_ID === 'PUT_TEMPLATE_DOCUMENT_ID_HERE') {
    throw new AppError_(
      'Template Not Configured',
      'CONFIG.TEMPLATE_DOC_ID has not been set in Config.gs.\n\n' +
      'Open the proposal template in Google Docs, copy the ID from its URL ' +
      '(.../document/d/<ID>/edit), and paste it into Config.gs.'
    );
  }
  try {
    DriveApp.getFileById(CONFIG.TEMPLATE_DOC_ID);
  } catch (e) {
    throw new AppError_(
      'Template Not Found',
      'Could not open the template document (ID: ' + CONFIG.TEMPLATE_DOC_ID + ').\n\n' +
      'Confirm the ID in Config.gs is correct and that this script has access to it.'
    );
  }

  // getSheet_ already throws a friendly AppError_ if the sheet is missing.
  getSheet_();
}

/**
 * Validates a row is ready to generate a proposal from.
 * @param {Object<string, *>} rowObj Keyed by COLUMNS.* (see Helpers.getRowObject_).
 * @return {Array<string>} Human-readable problems found; empty array = valid.
 */
function validateRowForGeneration_(rowObj) {
  var errors = [];

  var clientName = rowObj[COLUMNS.CLIENT_NAME];
  if (!clientName || String(clientName).trim() === '') {
    errors.push('"' + COLUMNS.CLIENT_NAME + '" is empty — enter the client\'s name before generating.');
  }

  return errors;
}
