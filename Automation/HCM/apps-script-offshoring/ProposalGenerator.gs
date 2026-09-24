/**
 * ProposalGenerator.gs
 *
 * The three user-facing actions wired to the "Proposal Generator" menu.
 * Orchestration only — validation lives in Validation.gs, document
 * mechanics live in TemplateEngine.gs, sheet mechanics live in Helpers.gs.
 */

/**
 * Menu action: "New Proposal".
 * Appends a fresh row with Month Year auto-filled and Status set to Draft.
 * Client Name is left blank for the user to fill in.
 */
function createNewProposalRow() {
  try {
    var sheet = getSheet_();
    ensureHeaders_(sheet);
    var headerMap = getHeaderIndexMap_(sheet);

    var newRow = sheet.getLastRow() + 1;
    if (newRow < 2) newRow = 2; // never write into the header row

    var values = {};
    values[COLUMNS.CLIENT_NAME] = '';
    values[COLUMNS.MONTH_YEAR] = formatMonthYear_(new Date());
    values[COLUMNS.GENERATED_DOC_URL] = '';
    values[COLUMNS.STATUS] = CONFIG.STATUS.DRAFT;

    Object.keys(values).forEach(function (header) {
      setCellByHeader_(sheet, newRow, headerMap, header, values[header]);
    });

    sheet.setActiveSelection(sheet.getRange(newRow, headerMap[COLUMNS.CLIENT_NAME]));
  } catch (err) {
    showError_(err);
  }
}

/**
 * Menu action: "Generate Proposal".
 * Reads the selected row, validates it, duplicates the template, replaces
 * the placeholders, and writes the resulting document URL + status back to
 * the sheet.
 */
function generateProposal() {
  try {
    validateEnvironment_();

    var sheet = getSheet_();
    var headerMap = getHeaderIndexMap_(sheet);
    var rowNumber = getActiveDataRow_(sheet);
    var rowObj = getRowObject_(sheet, rowNumber, headerMap);

    var errors = validateRowForGeneration_(rowObj);
    if (errors.length > 0) {
      showAlert_('Cannot Generate Proposal', errors.join('\n'));
      return;
    }

    var docName = 'Talent 360  - ' + rowObj[COLUMNS.CLIENT_NAME] + ' - ' + 'Offshoring & Payroll Proposal';

    var doc;
    try {
      doc = duplicateTemplate_(docName);
      var body = doc.getBody();

      var placeholderMap = buildPlaceholderMap_(rowObj);
      applyPlaceholders_(body, placeholderMap);

      doc.saveAndClose();
    } catch (genErr) {
      setCellByHeader_(sheet, rowNumber, headerMap, COLUMNS.STATUS, CONFIG.STATUS.ERROR);
      throw genErr;
    }

    setCellByHeader_(sheet, rowNumber, headerMap, COLUMNS.GENERATED_DOC_URL, doc.getUrl());
    setCellByHeader_(sheet, rowNumber, headerMap, COLUMNS.STATUS, CONFIG.STATUS.GENERATED);

    showAlert_('Proposal Generated', 'The proposal for "' + rowObj[COLUMNS.CLIENT_NAME] + '" was created successfully.');
  } catch (err) {
    showError_(err);
  }
}

/**
 * Menu action: "Open Generated Proposal".
 * Opens the Generated Document URL for the selected row in a new tab.
 */
function openGeneratedProposal() {
  try {
    var sheet = getSheet_();
    var headerMap = getHeaderIndexMap_(sheet);
    var rowNumber = getActiveDataRow_(sheet);
    var rowObj = getRowObject_(sheet, rowNumber, headerMap);

    var url = rowObj[COLUMNS.GENERATED_DOC_URL];
    if (!url) {
      showAlert_('No Proposal Yet', 'This row has no generated document yet. Run "Generate Proposal" first.');
      return;
    }

    var html = HtmlService
      .createHtmlOutput(
        '<html><body style="font-family:Arial,sans-serif;padding:16px;">' +
        '<p>Opening the proposal document…</p>' +
        '<p><a href="' + url + '" target="_blank" rel="noopener">Click here if it does not open automatically</a></p>' +
        '<script>window.open("' + url + '", "_blank"); google.script.host.close();</script>' +
        '</body></html>'
      )
      .setWidth(360)
      .setHeight(120);
    SpreadsheetApp.getUi().showModalDialog(html, 'Opening Proposal');
  } catch (err) {
    showError_(err);
  }
}
