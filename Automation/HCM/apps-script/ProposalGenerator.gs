/**
 * ProposalGenerator.gs
 *
 * The three user-facing actions wired to the "Proposal Generator" menu.
 * This file is orchestration only — validation lives in Validation.gs,
 * document mechanics live in TemplateEngine.gs, sheet mechanics live in
 * Helpers.gs.
 */

/**
 * Menu action: "New Proposal".
 * Appends a fresh row with Month Year auto-filled, every service checkbox
 * defaulted to TRUE, and Status set to Draft. Client Name and Employees To
 * Hire are left blank for the user to fill in.
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
    values[COLUMNS.RECRUITMENT] = true;
    values[COLUMNS.ONBOARDING] = true;
    values[COLUMNS.BENEFITS] = true;
    values[COLUMNS.PERFORMANCE] = true;
    values[COLUMNS.RELATIONS] = true;
    values[COLUMNS.COMPENSATION] = true;
    values[COLUMNS.PERSONNEL] = true;
    values[COLUMNS.EMPLOYEES_TO_HIRE] = '';
    values[COLUMNS.ONSITE_VISITS_PER_WEEK] = 2;
    values[COLUMNS.MONTHLY_FEE] = '';
    values[COLUMNS.CURRENCY] = 'EGP';
    values[COLUMNS.GENERATED_DOC_URL] = '';
    values[COLUMNS.STATUS] = CONFIG.STATUS.DRAFT;

    // Establish checkbox data validation FIRST — insertCheckboxes() resets
    // the cell to unchecked, so it must run before the TRUE values are
    // written, not after (writing values first would get silently wiped).
    SERVICE_REGISTRY.forEach(function (svc) {
      sheet.getRange(newRow, headerMap[svc.column]).insertCheckboxes();
    });

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
 * Reads the selected row, validates it, duplicates the template, builds
 * Section 3 dynamically, replaces every placeholder, and writes the
 * resulting document URL + status back to the sheet.
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

    var enabledServices = getEnabledServices_(rowObj);
    var docName = 'Talent 360 Proposal - ' + rowObj[COLUMNS.CLIENT_NAME] + ' - ' + normalizeMonthYear_(rowObj[COLUMNS.MONTH_YEAR]);

    var doc;
    try {
      doc = duplicateTemplate_(docName);
      var body = doc.getBody();

      applySection3_(body, rowObj);
      var placeholderMap = buildPlaceholderMap_(rowObj, enabledServices);
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
