/**
 * HistoryService.gs
 *
 * Every generation is a new version, never an overwrite. A row in a
 * document type's data sheet (e.g. "HCM Proposal Data") IS a version —
 * regenerating appends a new row with the same Opportunity ID and the next
 * version number, carrying the entered field values with it. The slim
 * cross-cutting "Documents" sheet indexes every version, across all four
 * document types, so "everything generated for this Opportunity" is one
 * lookup instead of four.
 */

/**
 * Returns the next version number for a given Opportunity + document type,
 * i.e. 1 + however many rows already exist for that pair.
 * @param {Object} docType One entry from DOCUMENT_TYPES.
 * @param {string} opportunityId
 * @return {number}
 */
function getNextVersion_(docType, opportunityId) {
  var sheet = getSheet_(docType.dataSheet);
  var headerMap = getHeaderIndexMap_(sheet);
  var rows = findRowsWhere_(sheet, headerMap, COLUMNS.DATA_COMMON.OPPORTUNITY_ID, opportunityId);
  return rows.length + 1;
}

/**
 * Records a completed generation: appends the version row (with field
 * values) to the document type's data sheet, and indexes it into the
 * cross-cutting Documents sheet.
 * @param {Object} docType One entry from DOCUMENT_TYPES.
 * @param {string} opportunityId
 * @param {Object<string, *>} fields Wizard form values, keyed by field key.
 * @param {string} url The generated Google Doc's URL.
 * @return {{documentId: string, version: number}}
 */
function recordGeneratedDocument_(docType, opportunityId, fields, url) {
  var version = getNextVersion_(docType, opportunityId);

  var documentsSheet = getSheet_(SHEETS.DOCUMENTS);
  var documentsHeaderMap = getHeaderIndexMap_(documentsSheet);
  var documentId = generateNextId_(documentsSheet, documentsHeaderMap, COLUMNS.DOCUMENTS.DOCUMENT_ID, CONFIG.ID_PREFIX.DOCUMENT);

  var dataSheet = getSheet_(docType.dataSheet);
  var dataHeaderMap = getHeaderIndexMap_(dataSheet);
  var dataRow = Object.assign({}, fields);
  dataRow[COLUMNS.DATA_COMMON.DOCUMENT_ID] = documentId;
  dataRow[COLUMNS.DATA_COMMON.OPPORTUNITY_ID] = opportunityId;
  dataRow[COLUMNS.DATA_COMMON.VERSION] = version;
  appendRowObject_(dataSheet, dataHeaderMap, dataRow);

  var indexRow = {};
  indexRow[COLUMNS.DOCUMENTS.DOCUMENT_ID] = documentId;
  indexRow[COLUMNS.DOCUMENTS.OPPORTUNITY_ID] = opportunityId;
  indexRow[COLUMNS.DOCUMENTS.DOC_TYPE] = docType.label;
  indexRow[COLUMNS.DOCUMENTS.VERSION] = version;
  indexRow[COLUMNS.DOCUMENTS.GENERATED_DATE] = formatDate_(new Date());
  indexRow[COLUMNS.DOCUMENTS.GENERATED_BY] = Session.getActiveUser().getEmail();
  indexRow[COLUMNS.DOCUMENTS.URL] = url;
  indexRow[COLUMNS.DOCUMENTS.STATUS] = CONFIG.STATUS.DOC_GENERATED;
  appendRowObject_(documentsSheet, documentsHeaderMap, indexRow);

  return { documentId: documentId, version: version };
}

/**
 * Returns every generated document for an Opportunity, across all four
 * document types, newest first — powers the History sidebar.
 * @param {string} opportunityId
 * @return {Array<Object<string,*>>} Rows from the Documents sheet.
 */
function getDocumentHistory_(opportunityId) {
  var sheet = getSheet_(SHEETS.DOCUMENTS);
  var headerMap = getHeaderIndexMap_(sheet);
  var rows = findRowsWhere_(sheet, headerMap, COLUMNS.DOCUMENTS.OPPORTUNITY_ID, opportunityId);
  return rows
    .map(function (rowNumber) { return getRowObject_(sheet, rowNumber, headerMap); })
    .reverse();
}

/**
 * Returns the most recent version's field values for a given Opportunity +
 * document type, so the wizard can pre-fill a regeneration instead of
 * starting blank. Returns null if this document type has never been
 * generated for this Opportunity.
 * @param {Object} docType One entry from DOCUMENT_TYPES.
 * @param {string} opportunityId
 * @return {Object<string,*>|null}
 */
function getLatestFieldValues_(docType, opportunityId) {
  var sheet = getSheet_(docType.dataSheet);
  var headerMap = getHeaderIndexMap_(sheet);
  var rows = findRowsWhere_(sheet, headerMap, COLUMNS.DATA_COMMON.OPPORTUNITY_ID, opportunityId);
  if (rows.length === 0) return null;
  return getRowObject_(sheet, rows[rows.length - 1], headerMap);
}
