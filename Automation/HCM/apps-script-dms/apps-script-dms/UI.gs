/**
 * UI.gs
 *
 * The controller between the HTML dialogs and the service layer. Every
 * google.script.run call the wizard/dialogs make lands in this file. It
 * translates between "what the browser sent" and "what the services need,"
 * and turns thrown AppError_s into plain {error: message} objects the
 * client-side JS can render — google.script.run's failure handler only
 * gets a generic Error, so we deliberately return errors as data instead
 * of throwing across the bridge.
 */

function include_(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** Wraps a server function so client-visible failures come back as {error} instead of a thrown exception. */
function _safe_(fn) {
  try {
    return { ok: true, data: fn() };
  } catch (err) {
    return { ok: false, error: (err && err.message) ? err.message : String(err), title: err && err.title };
  }
}

// ---------------------------------------------------------------------
// New Opportunity dialog
// ---------------------------------------------------------------------

function showNewOpportunityDialog_() {
  var html = HtmlService.createTemplateFromFile('OpportunityDialog').evaluate()
    .setWidth(420).setHeight(420);
  SpreadsheetApp.getUi().showModalDialog(html, 'New Opportunity');
}

function ui_getNewOpportunityInitData() {
  return _safe_(function () {
    return { products: [CONFIG.PRODUCT.HCM, CONFIG.PRODUCT.OFFSHORING], defaultOwner: Session.getActiveUser().getEmail() };
  });
}

function ui_submitNewOpportunity(formData) {
  return _safe_(function () {
    var errors = [];
    if (!formData.company || !formData.company.trim()) errors.push('Company is required.');
    if ([CONFIG.PRODUCT.HCM, CONFIG.PRODUCT.OFFSHORING].indexOf(formData.product) === -1) errors.push('Product is required.');
    if (errors.length) throw new AppError_('Missing Information', errors.join('\n'));

    var opp = createOpportunity_(formData);
    return { opportunityId: opp[COLUMNS.OPPORTUNITIES.ID] };
  });
}

// ---------------------------------------------------------------------
// Generate Document wizard
// ---------------------------------------------------------------------

function showGenerateDocumentWizard_() {
  try {
    getSelectedOpportunity_(); // fail fast, before opening the dialog, if nothing valid is selected
  } catch (err) {
    showError_(err);
    return;
  }
  var html = HtmlService.createTemplateFromFile('GenerateWizard').evaluate()
    .setWidth(560).setHeight(620);
  SpreadsheetApp.getUi().showModalDialog(html, 'Generate Document');
}

/** Step 1 data: the selected Opportunity + which document types apply to its Product. */
function ui_getWizardInitData() {
  return _safe_(function () {
    var selected = getSelectedOpportunity_();
    var opp = selected.row;
    var product = opp[COLUMNS.OPPORTUNITIES.PRODUCT];
    var docTypes = getDocumentTypesForProduct_(product).map(function (dt) {
      return { key: dt.key, label: dt.label };
    });
    return {
      opportunityId: opp[COLUMNS.OPPORTUNITIES.ID],
      company: opp[COLUMNS.OPPORTUNITIES.COMPANY],
      product: product,
      docTypes: docTypes
    };
  });
}

/** Step 2 data: this doc type's field schema, current service selection (if any), and last version's values for pre-fill. */
function ui_getDocTypeFormSchema(opportunityId, docTypeKey) {
  return _safe_(function () {
    var docType = DOCUMENT_TYPES[docTypeKey];
    if (!docType) throw new AppError_('Unknown Document Type', 'No document type "' + docTypeKey + '" is registered.');

    var settings = getSettings_();
    var fieldsSchema = docType.fields.map(function (f) {
      var value = '';
      if (f.defaultSettingKey && settings[f.defaultSettingKey]) value = settings[f.defaultSettingKey];
      return { key: f.key, label: f.label, type: f.type, required: !!f.required, defaultValue: value };
    });

    var latest = getLatestFieldValues_(docType, opportunityId);
    var latestValues = {};
    if (latest) {
      docType.fields.forEach(function (f) {
        if (latest[f.key] === undefined || latest[f.key] === '') return;
        // <input type="date"> requires ISO yyyy-MM-dd to pre-fill correctly —
        // different from the dd/MM/yyyy shown inside the generated document.
        if (f.type === FIELD_TYPE.DATE && latest[f.key] instanceof Date) {
          latestValues[f.key] = Utilities.formatDate(latest[f.key], CONFIG.TIMEZONE, 'yyyy-MM-dd');
        } else {
          latestValues[f.key] = latest[f.key] instanceof Date ? normalizeDateValue_(latest[f.key]) : latest[f.key];
        }
      });
    }

    var serviceSelection = null;
    if (docType.hasServiceSelection) {
      var selectionRow = getHcmServiceSelection_(opportunityId);
      serviceSelection = SERVICE_REGISTRY.map(function (svc) {
        return { key: svc.key, label: svc.labelEn, enabled: selectionRow[svc.column] === true };
      });
    }

    return {
      label: docType.label,
      fields: fieldsSchema,
      latestValues: latestValues,
      hasServiceSelection: docType.hasServiceSelection,
      serviceSelection: serviceSelection
    };
  });
}

/**
 * Converts each DATE-type field's "yyyy-MM-dd" string (what an
 * <input type="date"> sends) into a real Date object, parsed from its
 * components rather than via `new Date(isoString)` — the latter parses as
 * UTC midnight and can land on the wrong calendar day once shifted into
 * the script's timezone. Leaves every other field untouched.
 * @param {Object} docType One entry from DOCUMENT_TYPES.
 * @param {Object<string, *>} fieldValues
 * @return {Object<string, *>} A new object; the input is not mutated.
 */
function _coerceDateFields_(docType, fieldValues) {
  var result = Object.assign({}, fieldValues);
  docType.fields.forEach(function (f) {
    if (f.type !== FIELD_TYPE.DATE) return;
    var raw = result[f.key];
    if (!raw) return;
    var parts = String(raw).split('-'); // "yyyy-MM-dd"
    if (parts.length === 3) {
      result[f.key] = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    }
  });
  return result;
}

/** Step 3: validate + generate + record history. */
function ui_submitGenerateDocument(opportunityId, docTypeKey, fieldValues, serviceSelectionMap) {
  return _safe_(function () {
    var docType = DOCUMENT_TYPES[docTypeKey];
    if (!docType) throw new AppError_('Unknown Document Type', 'No document type "' + docTypeKey + '" is registered.');

    validateEnvironmentForDocType_(docType);

    var opportunity = getOpportunityById_(opportunityId);
    var oppErrors = validateOpportunity_(opportunity);
    if (oppErrors.length) throw new AppError_('Opportunity Incomplete', oppErrors.join('\n'));

    fieldValues = _coerceDateFields_(docType, fieldValues);

    if (docType.hasServiceSelection && serviceSelectionMap) {
      setHcmServiceSelection_(opportunityId, serviceSelectionMap);
    }
    var enabledServices = docType.hasServiceSelection
      ? getEnabledServices_(getHcmServiceSelection_(opportunityId))
      : [];
    var enabledKeys = enabledServices.map(function (s) { return s.key; });

    var fieldErrors = validateDocumentFields_(docType, fieldValues, enabledKeys);
    if (fieldErrors.length) throw new AppError_('Cannot Generate Document', fieldErrors.join('\n'));

    var result = generateDocument_(docType, opportunity, fieldValues, enabledServices);
    var history = recordGeneratedDocument_(docType, opportunityId, fieldValues, result.url);

    return { url: result.url, version: history.version, documentId: history.documentId };
  });
}

// ---------------------------------------------------------------------
// History sidebar
// ---------------------------------------------------------------------

function showHistorySidebar_() {
  try {
    getSelectedOpportunity_();
  } catch (err) {
    showError_(err);
    return;
  }
  var html = HtmlService.createTemplateFromFile('HistorySidebar').evaluate()
    .setTitle('Document History');
  SpreadsheetApp.getUi().showSidebar(html);
}

function ui_getHistoryInitData() {
  return _safe_(function () {
    var selected = getSelectedOpportunity_();
    var opp = selected.row;
    var history = getDocumentHistory_(opp[COLUMNS.OPPORTUNITIES.ID]).map(function (row) {
      return {
        docType: row[COLUMNS.DOCUMENTS.DOC_TYPE],
        version: row[COLUMNS.DOCUMENTS.VERSION],
        date: normalizeDateValue_(row[COLUMNS.DOCUMENTS.GENERATED_DATE]),
        by: row[COLUMNS.DOCUMENTS.GENERATED_BY],
        url: row[COLUMNS.DOCUMENTS.URL],
        status: row[COLUMNS.DOCUMENTS.STATUS]
      };
    });
    return {
      company: opp[COLUMNS.OPPORTUNITIES.COMPANY],
      opportunityId: opp[COLUMNS.OPPORTUNITIES.ID],
      history: history
    };
  });
}

// ---------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------

function showSettingsDialog_() {
  var html = HtmlService.createTemplateFromFile('SettingsDialog').evaluate()
    .setWidth(480).setHeight(560);
  SpreadsheetApp.getUi().showModalDialog(html, 'Settings');
}

function ui_getSettingsData() {
  return _safe_(function () {
    getSheet_(SHEETS.SETTINGS); // fail fast with a friendly message if setup hasn't run
    var keys = [];
    Object.keys(SETTINGS_KEYS).forEach(function (k) { keys.push(SETTINGS_KEYS[k]); });
    var values = getSettings_();
    return keys.map(function (key) { return { key: key, value: values[key] || '' }; });
  });
}

function ui_submitSettings(settingsArray) {
  return _safe_(function () {
    settingsArray.forEach(function (row) { setSetting_(row.key, row.value); });
    return { saved: true };
  });
}
