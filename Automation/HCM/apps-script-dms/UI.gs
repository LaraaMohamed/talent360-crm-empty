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
      return {
        key: f.key,
        label: f.label,
        type: f.type,
        // A conditionally-required field still shows the required marker, so the
        // user isn't surprised by a validation error after pressing Generate.
        required: !!f.required || typeof f.requiredIf === 'function',
        defaultValue: value,
        // Both of these drive the wizard's auto-calculation UI, so they have to
        // cross the bridge — without them the end date never auto-fills.
        autoCalcFrom: f.autoCalcFrom || '',
        hint: f.hint || ''
      };
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

    // First Party block, sourced from the imported Commercial Registration.
    // Shown read-only in the wizard with an "Update" affordance — these are
    // never typed into the agreement form by hand.
    var firstParty = null;
    if (docType.requiresCommercialRegistration) {
      var cr = getCommercialRegistration_(opportunityId);
      firstParty = cr ? {
        imported: true,
        companyNameAr: cr[COLUMNS.COMMERCIAL_REGISTRATION.COMPANY_NAME_AR] || '',
        crNumber: String(cr[COLUMNS.COMMERCIAL_REGISTRATION.CR_NUMBER] || ''),
        representativeName: cr[COLUMNS.COMMERCIAL_REGISTRATION.REPRESENTATIVE_NAME] || '',
        address: cr[COLUMNS.COMMERCIAL_REGISTRATION.ADDRESS] || '',
        confidence: cr[COLUMNS.COMMERCIAL_REGISTRATION.CONFIDENCE] || '',
        importedAt: normalizeDateValue_(cr[COLUMNS.COMMERCIAL_REGISTRATION.IMPORTED_AT])
      } : { imported: false };
    }

    return {
      label: docType.label,
      fields: fieldsSchema,
      latestValues: latestValues,
      hasServiceSelection: docType.hasServiceSelection,
      serviceSelection: serviceSelection,
      requiresCommercialRegistration: !!docType.requiresCommercialRegistration,
      firstParty: firstParty,
      // Agreement Date is stamped at generation time, never entered — surfaced
      // so the wizard can show the user what will be written.
      agreementDateToday: formatDate_(todayInConfiguredTimezone_())
    };
  });
}

/**
 * Computes the contract end date for a chosen start date, so the wizard can
 * auto-fill it as the user picks. Kept server-side so the "+1 year - 1 day"
 * rule and the configurable term length live in exactly one place.
 * @param {string} startIso "yyyy-MM-dd" from an <input type="date">.
 * @return {Object} {ok, data: {endIso}}
 */
function ui_computeContractEndDate(startIso) {
  return _safe_(function () {
    var parts = String(startIso || '').split('-');
    if (parts.length !== 3) return { endIso: '' };
    var start = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    var years = Number(getSetting_(SETTINGS_KEYS.DEFAULT_CONTRACT_YEARS, false) || 1);
    var end = computeContractEndDate_(start, years);
    return { endIso: Utilities.formatDate(end, CONFIG.TIMEZONE, 'yyyy-MM-dd') };
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

    var crErrors = validateCommercialRegistrationFor_(docType, opportunityId);
    if (crErrors.length) throw new AppError_('Commercial Registration Required', crErrors.join('\n'));

    var fieldErrors = validateDocumentFields_(docType, fieldValues, enabledKeys);
    if (fieldErrors.length) throw new AppError_('Cannot Generate Document', fieldErrors.join('\n'));

    var result = generateDocument_(docType, opportunity, fieldValues, enabledServices);

    // Snapshot the auto-derived values into the version row alongside the
    // typed ones, so a stored version always shows exactly what was written
    // into that document — even if the CR is re-imported later.
    var recorded = _withDerivedValues_(docType, opportunity, fieldValues);
    var history = recordGeneratedDocument_(docType, opportunityId, recorded, result.url);

    return { url: result.url, version: history.version, documentId: history.documentId };
  });
}

/**
 * Returns a copy of the wizard's field values with the system-derived
 * agreement fields folded in (today's agreement date, plus the First Party
 * values pulled from the Commercial Registration).
 * @param {Object} docType One entry from DOCUMENT_TYPES.
 * @param {Object<string, *>} opportunity
 * @param {Object<string, *>} fieldValues
 * @return {Object<string, *>} A new object; the input is not mutated.
 */
function _withDerivedValues_(docType, opportunity, fieldValues) {
  var out = Object.assign({}, fieldValues);
  // Registry-driven: each document type declares its own data-column block,
  // so adding a future agreement type needs no change here.
  var cols = docType.dataColumns;
  if (!cols || !cols.AGREEMENT_DATE) return out;

  out[cols.AGREEMENT_DATE] = formatDate_(todayInConfiguredTimezone_());
  if (docType.requiresCommercialRegistration) {
    var fp = resolveFirstParty_(opportunity);
    out[cols.CLIENT_NAME_AR] = fp.clientNameAr;
    out[cols.COMMERCIAL_REGISTRATION] = fp.crNumber;
    out[cols.REPRESENTATIVE_NAME] = fp.representativeName;
    out[cols.COMPANY_ADDRESS] = fp.address;
  }
  return out;
}

// ---------------------------------------------------------------------
// Commercial Registration import
// ---------------------------------------------------------------------

function showCommercialRegistrationDialog_() {
  try {
    getSelectedOpportunity_(); // fail fast before opening the dialog
  } catch (err) {
    showError_(err);
    return;
  }
  var html = HtmlService.createTemplateFromFile('CommercialRegistrationDialog').evaluate()
    .setWidth(560).setHeight(640);
  SpreadsheetApp.getUi().showModalDialog(html, 'Import Commercial Registration');
}

/** Init data: which Opportunity, and whatever CR is already on file. */
function ui_getCrInitData(opportunityIdOverride) {
  return _safe_(function () {
    var opportunityId = opportunityIdOverride;
    var company = '';
    if (opportunityId) {
      var opp = getOpportunityById_(opportunityId);
      company = opp[COLUMNS.OPPORTUNITIES.COMPANY];
    } else {
      var selected = getSelectedOpportunity_();
      opportunityId = selected.row[COLUMNS.OPPORTUNITIES.ID];
      company = selected.row[COLUMNS.OPPORTUNITIES.COMPANY];
    }

    var cr = getCommercialRegistration_(opportunityId);
    return {
      opportunityId: opportunityId,
      company: company,
      existing: cr ? {
        companyNameAr: cr[COLUMNS.COMMERCIAL_REGISTRATION.COMPANY_NAME_AR] || '',
        crNumber: String(cr[COLUMNS.COMMERCIAL_REGISTRATION.CR_NUMBER] || ''),
        address: cr[COLUMNS.COMMERCIAL_REGISTRATION.ADDRESS] || '',
        nationalNumber: String(cr[COLUMNS.COMMERCIAL_REGISTRATION.NATIONAL_NUMBER] || ''),
        confidence: cr[COLUMNS.COMMERCIAL_REGISTRATION.CONFIDENCE] || '',
        importedAt: normalizeDateValue_(cr[COLUMNS.COMMERCIAL_REGISTRATION.IMPORTED_AT])
      } : null
    };
  });
}

/**
 * Runs OCR + extraction on an uploaded certificate and returns the parsed
 * values for review. Does NOT save — the user confirms first.
 * @param {string} opportunityId
 * @param {{bytes: Array<number>, mimeType: string, fileName: string}} filePayload
 *     Sent from the browser as a plain byte array, since google.script.run
 *     cannot carry a File/Blob across the bridge.
 */
function ui_extractCommercialRegistration(opportunityId, filePayload) {
  return _safe_(function () {
    if (!filePayload || !filePayload.bytes || !filePayload.bytes.length) {
      throw new AppError_('No File', 'No file was received. Choose a PDF, JPG, or PNG and try again.');
    }
    var blob = Utilities.newBlob(filePayload.bytes, filePayload.mimeType, filePayload.fileName || 'commercial-registration');
    return importCommercialRegistration_(blob, opportunityId);
  });
}

/** Saves the user-confirmed Commercial Registration values. */
function ui_saveCommercialRegistration(opportunityId, data) {
  return _safe_(function () {
    var errors = [];
    if (!data || !String(data.companyNameAr || '').trim()) errors.push('Company Name (Arabic) is required.');
    if (!data || !String(data.crNumber || '').trim()) errors.push('Commercial Registration Number is required.');
    if (!data || !String(data.representativeName || '').trim()) errors.push('Representative Name is required.');
    if (errors.length) throw new AppError_('Missing Information', errors.join('\n'));

    saveCommercialRegistration_(opportunityId, data);
    return { saved: true };
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
