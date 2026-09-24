/**
 * ValidationService.gs
 *
 * All pre-flight checks live here. Field-level rules are schema-driven
 * from DOCUMENT_TYPES — adding a required field to a template's wizard
 * form (in DocumentTypeRegistry.gs) automatically gets validated here with
 * no code change needed in this file.
 */

/**
 * Confirms the environment a generation run depends on: the template for
 * this specific document type, and the sheets it will read/write. Throws
 * AppError_ on the first problem found.
 * @param {Object} docType One entry from DOCUMENT_TYPES.
 */
function validateEnvironmentForDocType_(docType) {
  validateTemplateSetting_(docType.templateSettingKey);
  getSheet_(SHEETS.OPPORTUNITIES);
  getSheet_(docType.dataSheet);
  getSheet_(SHEETS.DOCUMENTS);
  if (docType.hasServiceSelection) {
    getSheet_(SHEETS.HCM_SERVICE_SELECTION);
  }
}

/**
 * Validates the Opportunity itself is ready to generate any document from.
 * @param {Object<string, *>} opportunity Row object from Opportunities.
 * @return {Array<string>} Human-readable problems found; empty = valid.
 */
function validateOpportunity_(opportunity) {
  var errors = [];
  var company = opportunity[COLUMNS.OPPORTUNITIES.COMPANY];
  if (!company || String(company).trim() === '') {
    errors.push('"' + COLUMNS.OPPORTUNITIES.COMPANY + '" is empty on this Opportunity.');
  }
  var product = opportunity[COLUMNS.OPPORTUNITIES.PRODUCT];
  if ([CONFIG.PRODUCT.HCM, CONFIG.PRODUCT.OFFSHORING].indexOf(product) === -1) {
    errors.push('"' + COLUMNS.OPPORTUNITIES.PRODUCT + '" must be either "' + CONFIG.PRODUCT.HCM + '" or "' + CONFIG.PRODUCT.OFFSHORING + '".');
  }
  return errors;
}

/**
 * Validates the wizard form values against a document type's field schema.
 * @param {Object} docType One entry from DOCUMENT_TYPES.
 * @param {Object<string, *>} fields Wizard form values, keyed by field key.
 * @param {Array<string>} enabledServiceKeys Keys from SERVICE_REGISTRY enabled for this Opportunity.
 * @return {Array<string>} Human-readable problems found; empty = valid.
 */
function validateDocumentFields_(docType, fields, enabledServiceKeys) {
  var errors = [];

  if (docType.hasServiceSelection && enabledServiceKeys.length === 0) {
    errors.push('No HCM services are checked — at least one must remain checked.');
  }

  docType.fields.forEach(function (field) {
    var isRequired = field.required === true ||
      (typeof field.requiredIf === 'function' && field.requiredIf(enabledServiceKeys));
    if (!isRequired) return;

    var value = fields[field.key];
    var missing = value === undefined || value === null || String(value).trim() === '';
    var invalidNumber = field.type === FIELD_TYPE.NUMBER && !missing && isNaN(Number(value));

    if (missing) {
      errors.push('"' + field.label + '" is required.');
    } else if (invalidNumber) {
      errors.push('"' + field.label + '" must be a number.');
    }
  });

  return errors;
}
