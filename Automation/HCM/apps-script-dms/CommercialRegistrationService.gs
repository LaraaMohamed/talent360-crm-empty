/**
 * CommercialRegistrationService.gs
 *
 * Turns OCR text from a Commercial Registration certificate into structured
 * data, and stores that data per Opportunity so every document generator
 * can reuse it for the "First Party" / الطرف الأول block.
 *
 * CR data is stored at the OPPORTUNITY level, not the document level — a
 * company has one Commercial Registration no matter how many documents get
 * generated from it. Same 1:1 pattern as HCM Service Selection, which is
 * also what makes it reusable by future document types (they just read it).
 *
 * === Format notes, derived from the two real sample certificates ===
 * The samples supplied are EGYPTIAN certificates from
 * وزارة التموين والتجارة الداخلية / جهاز تنمية التجارة الداخلية. Layout
 * confirmed identical across both:
 *   - Header:  مستخرج سجل تجارى رقم: <CR number>
 *   - Header:  الرقم القومى للمنشآة: <national establishment no.>
 *   - Header:  الرقم الموحد للسجل التجارى (<grouped unified number>)
 *   - Column (1) item (ج) repeats the CR number, labelled
 *              رقم القيد فى السجل التجارى
 *   - Column (2) item ٢- holds the trade name (السمة التجارية)
 *   - Address:  عنوان المحل الرئيسى / عنوان المركز العام للشركة
 * All numbers print in Eastern Arabic-Indic digits (٠-٩).
 *
 * Because the CR number appears at least twice (header + column 1), the two
 * occurrences are cross-checked; agreement between them is the strongest
 * confidence signal available without a human reading the page.
 *
 * Saudi label variants are included in the pattern sets as well, so a Saudi
 * certificate extracts too — patterns are ordered most-specific-first and
 * simply fall through.
 *
 * IMPORTANT: nothing here is ever trusted blindly. Every parse result goes
 * to the user in a fully editable confirmation dialog before it is saved.
 */

/** Confidence levels reported to the UI. */
var CR_CONFIDENCE = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low', NONE: 'none' };

/**
 * Commercial Registration number patterns, most reliable first.
 *
 * All patterns are matched against NORMALIZED text (see
 * normalizeArabicWithMap_), so they must be written in normalized form:
 * ا not أ/إ/آ, ي not ى, ه not ة, Western digits, no diacritics.
 */
var CR_NUMBER_PATTERNS = [
  /مستخرج\s*سجل\s*تجاري\s*رقم\s*[:：]?\s*(\d{3,12})/,
  /رقم\s*القيد\s*(?:في)?\s*السجل\s*التجاري\s*[:：]?\s*(\d{3,12})/,
  /رقم\s*السجل\s*التجاري\s*[:：]?\s*(\d{3,12})/,
  /السجل\s*التجاري\s*رقم\s*[:：]?\s*(\d{3,12})/,
  /سجل\s*تجاري[^\d]{0,20}(\d{4,12})/
];

/** Company / trade name patterns. */
var CR_COMPANY_NAME_PATTERNS = [
  /السمه\s*التجاريه\s*[:：]?\s*(?:\d\s*[-–]\s*)?([^\n]{3,120})/,
  /الاسم\s*التجاري\s*[:：]?\s*(?:\d\s*[-–]\s*)?([^\n]{3,120})/,
  /اسم\s*الشركه\s*[:：]?\s*([^\n]{3,120})/,
  /عنوان\s*الشركه\s*او\s*اسمها\s*[:：]?\s*([^\n]{3,120})/
];

/** Address patterns. Frequently absent from the certificate — hence "if available". */
var CR_ADDRESS_PATTERNS = [
  /عنوان\s*المركز\s*العام\s*للشركه\s*[:：]?\s*([^\n]{5,200})/,
  /عنوان\s*المحل\s*الرئيسي\s*[:：]?\s*([^\n]{5,200})/,
  /عنوان\s*الشركه\s*[:：]?\s*([^\n]{5,200})/,
  /العنوان\s*[:：]?\s*([^\n]{5,200})/,
  /مقرها\s*[:：]?\s*([^\n]{5,200})/
];

/** National establishment number (Egyptian certificates). */
var CR_NATIONAL_NUMBER_PATTERNS = [
  /الرقم\s*القومي\s*للمنشاه\s*[:：]?\s*(\d{5,15})/
];

/*
 * LABEL-ONLY patterns for the proximity pass. These deliberately capture no
 * value — findNumberNearLabel_ / findTextNearLabel_ anchor on the label and
 * then sweep nearby text, which is what rescues a table whose reading order
 * OCR scrambled. Ordered most-specific first.
 */
var CR_NUMBER_LABELS = [
  /مستخرج\s*سجل\s*تجاري\s*رقم/,
  /رقم\s*القيد\s*(?:في)?\s*السجل\s*التجاري/,
  /رقم\s*السجل\s*التجاري/,
  /السجل\s*التجاري/
];

var CR_NATIONAL_NUMBER_LABELS = [
  /الرقم\s*القومي\s*للمنشاه/,
  /الرقم\s*القومي/
];

var CR_COMPANY_NAME_LABELS = [
  /السمه\s*التجاريه/,
  /الاسم\s*التجاري/,
  /اسم\s*الشركه/
];

var CR_ADDRESS_LABELS = [
  /عنوان\s*المركز\s*العام\s*للشركه/,
  /عنوان\s*المحل\s*الرئيسي/,
  /تعديل\s*العنوان/,
  /عنوان\s*الشركه/,
  /العنوان/
];

/**
 * Marker that reliably follows a person's name on this form: every named
 * individual is printed as "<full name> مواليد<date of birth>". Anchoring on
 * "مواليد" and taking the text BEFORE it is far more dependable than trying to
 * match the column label, which sits in the distant description block.
 */
var CR_BIRTH_MARKER = /مواليد/;

/**
 * An amended trade name is introduced by "ليصبح" ("to become") and usually
 * quoted: تعديل الاسم التجارى ليصبح " العنقاء للفندقة ".
 * Matched against NORMALIZED text.
 */
var CR_AMENDED_NAME_PATTERNS = [
  /ليصبح\s*["'«“”‘’]?\s*([^"'«»“”‘’\n]{3,80})/
];

/** An amended address is introduced by "تعديل العنوان". */
var CR_AMENDED_ADDRESS_PATTERNS = [
  /تعديل\s*العنوان\s*[:：]?\s*([^\n]{5,200})/
];

/**
 * Words that mark a line as an address on Egyptian certificates. Used to
 * surface address candidates, since the address column has no usable label
 * anchor once OCR flattens the page.
 */
var CR_ADDRESS_HINTS = [
  /شارع/, /الدور/, /شقه/, /محافظه/, /مدينه/, /عقار/, /وحده\s*اداريه/,
  /القاهره/, /الجيزه/, /الاسكندريه/, /مصر\s*الجديده/, /المعادي/, /قصر\s*النيل/,
  /جاردن\s*سيتي/, /مدينه\s*نصر/
];

/*
 * BLANK-FORM LABEL MARKERS.
 *
 * The Egyptian certificate prints a large block of column DESCRIPTIONS, then
 * the actual values in a spatially separate row far below. Once OCR
 * linearizes the page, that description block sits right next to the very
 * labels we search for — so a proximity sweep happily returns
 * "إسم التاجر ولقبه وتاريخ ومحل ميلاده وجنسيته" (a column description) as if
 * it were the company name.
 *
 * Writing that into a signed agreement is far worse than extracting nothing,
 * so any candidate matching one of these markers is rejected outright and the
 * field is left for the user. Matched against NORMALIZED text.
 */
var CR_FORM_LABEL_MARKERS = [
  /اسم\s*التاجر\s*ولقبه/,
  /ولقبه\s*وتاريخ\s*ومحل\s*ميلاده/,
  /محل\s*ميلاده\s*وجنسيته/,
  /اسماء\s*والقاب/,
  /ومدي\s*سلطتهم/,
  /مجلس\s*الاداره\s*في\s*شركات\s*المساهمه/,
  /عناوين\s*الفروع\s*والوكالات/,
  /التاريخ\s*الذي\s*بدا\s*فيه\s*التاجر/,
  /تاريخ\s*الترخيص\s*بمزاوله/,
  /الغرض\s*من\s*تاسيس/,
  /يباشر\s*به\s*التاجر/,
  /او\s*اسمها\s*او\s*اسم/,
  /موافقه\s*هيئه\s*الاستثمار/,
  /تاريخ\s*افتتاح\s*الفرع/,
  /رقم\s*قيد\s*المحل\s*الرئيسي/,
  /الجمعيه\s*التعاونيه\s*ووكلائها/,
  /في\s*حاله\s*قيد\s*الفرع/,
  /نهايه\s*البيانات/,
  /^\s*نوع\s*التجاره\s*$/,
  /^\s*رقم\s*الايداع\s*$/,
  /^\s*تاريخ\s*الايداع\s*$/,
  // The bare amendment heading, as opposed to the amended value itself, which
  // is captured separately from the "ليصبح" clause.
  /^\s*تعديل\s*الاسم\s*التجاري\s*$/,
  /^\s*تعديل\s*العنوان\s*$/,
  // The issuing registry office is not the client's address.
  /مكتب\s*سجل\s*تجاري/,
  /الاداره\s*المركزيه\s*للسجل/,
  /وزاره\s*التموين/,
  /جهاز\s*تنميه\s*التجاره/
];

/**
 * Length past which a candidate is treated as a form description rather than a
 * value. Names are short; addresses are legitimately long, so they get a much
 * higher ceiling — a single shared limit would silently discard real addresses.
 */
var CR_MAX_NAME_LENGTH = 90;
var CR_MAX_ADDRESS_LENGTH = 220;

/**
 * True if a candidate value is really a blank-form column description rather
 * than data. See CR_FORM_LABEL_MARKERS for why this matters.
 * @param {string} value
 * @return {boolean}
 */
function isFormLabelText_(value, maxLength) {
  var norm = normalizeArabicText_(stripLeadingListMarker_(value));
  if (!norm) return true;
  for (var i = 0; i < CR_FORM_LABEL_MARKERS.length; i++) {
    if (CR_FORM_LABEL_MARKERS[i].test(norm)) return true;
  }
  // Column descriptions are long, connective runs of Arabic prose, so length is
  // a useful signal — but the ceiling must suit the field, since a real address
  // easily exceeds what a real trade name ever would.
  return norm.length > (maxLength || CR_MAX_NAME_LENGTH);
}

/** OCR noise commonly left attached to an extracted value. */
var CR_VALUE_NOISE = [
  /\(\s*نهايه\s*البيانات\s*\)/g,
  /\*{2,}/g,
  /\|+/g,
  /_{2,}/g
];

/**
 * Extracts structured Commercial Registration data from OCR'd text.
 *
 * Never throws on a failed match — an unreadable field comes back empty
 * with a warning attached, because the user always gets an editable
 * confirmation dialog and can simply type it in.
 *
 * @param {string} rawText Text as returned by runOcr_.
 * @return {{companyNameAr: string, crNumber: string, address: string,
 *           nationalNumber: string, confidence: string,
 *           warnings: Array<string>, matchedCrOccurrences: number}}
 */
function parseCommercialRegistration_(rawText) {
  var text = String(rawText || '').replace(/\r/g, '');
  var n = normalizeArabicWithMap_(text);
  var warnings = [];

  // Two-pass strategy per field. Pass 1 is the strict label-then-value regex,
  // which is precise when OCR preserved reading order. Pass 2 anchors on the
  // label alone and sweeps nearby text — necessary because OCR of a wide RTL
  // table routinely separates a label from its value or reverses their order.
  var crNumber = matchFromArabic_(text, CR_NUMBER_PATTERNS, true) ||
    findNumberNearLabel_(n, CR_NUMBER_LABELS, 3, 12);

  var nationalNumber = matchFromArabic_(text, CR_NATIONAL_NUMBER_PATTERNS, true) ||
    findNumberNearLabel_(n, CR_NATIONAL_NUMBER_LABELS, 5, 15);

  // Prose fields: keep the ORIGINAL Arabic so spelling survives verbatim into
  // the legal document (ة stays ة, أ stays أ). Every candidate is screened
  // against the blank form's own column descriptions — returning nothing is
  // strictly better than writing a form label into a contract.
  var companyNameAr = _firstNonLabel_([
    matchFromArabic_(text, CR_COMPANY_NAME_PATTERNS, false),
    findTextNearLabel_(n, CR_COMPANY_NAME_LABELS, 3)
  ]);

  var address = _firstNonLabel_([
    matchFromArabic_(text, CR_ADDRESS_PATTERNS, false),
    findTextNearLabel_(n, CR_ADDRESS_LABELS, 5)
  ]);

  // Candidates for every prose field. These are OFFERED, never auto-applied:
  // certificates routinely carry amendments (a superseded trade name, a former
  // address) and list several managers, and choosing wrongly would put the
  // wrong legal party into a signed contract. A person decides.
  var nameCandidates = _collectNameCandidates_(n, companyNameAr);
  var representativeCandidates = _collectPersonCandidates_(n);
  var addressCandidates = _collectAddressCandidates_(n, address);

  // With more than one plausible value there is no safe default, so clear the
  // pre-filled guess and let the user pick from the chips.
  if (nameCandidates.length > 1) companyNameAr = '';
  if (addressCandidates.length > 1) address = '';

  // Cross-check the CR number against the whole normalized document.
  var occurrences = 0;
  if (crNumber) {
    var found = n.text.match(new RegExp(escapeRegex_(crNumber), 'g'));
    occurrences = found ? found.length : 0;
  }

  if (!crNumber) warnings.push('Registration number could not be read — please enter it.');
  if (!companyNameAr) {
    warnings.push(nameCandidates.length
      ? 'Company name could not be identified with confidence. Pick one of the suggestions below, or type it.'
      : 'Company name (Arabic) could not be read — please type it from the certificate.');
  }
  if (!address) {
    warnings.push(addressCandidates.length
      ? 'More than one address appears on the certificate (it has been amended). Pick the correct one below.'
      : 'Address could not be read reliably — type it if the agreement needs one.');
  }
  if (representativeCandidates.length) {
    warnings.push('Pick the manager who signs on the client\'s behalf from the suggestions below.');
  }
  if (crNumber && occurrences < 2) {
    warnings.push('The registration number appeared only once, so it could not be cross-checked. Please verify it against the certificate.');
  }

  return {
    companyNameAr: companyNameAr,
    crNumber: crNumber,
    representativeName: '',
    address: address,
    nationalNumber: nationalNumber,
    nameCandidates: nameCandidates,
    representativeCandidates: representativeCandidates,
    addressCandidates: addressCandidates,
    confidence: _scoreCrConfidence_(crNumber, companyNameAr, occurrences),
    warnings: warnings,
    matchedCrOccurrences: occurrences
  };
}

/**
 * Grades extraction quality so the dialog knows how hard to push the user
 * to check the values.
 *   high   - number read AND corroborated by a second occurrence AND a name read
 *   medium - number read, but either uncorroborated or the name is missing
 *   low    - only one of the two key fields came through
 *   none   - nothing usable
 * @param {string} crNumber
 * @param {string} companyNameAr
 * @param {number} occurrences
 * @return {string} One of CR_CONFIDENCE.*.
 */
function _scoreCrConfidence_(crNumber, companyNameAr, occurrences) {
  // A cross-checked registration number is a genuine win even when the trade
  // name has to be typed — on this form layout that is the expected outcome,
  // so it must not be reported as outright failure.
  if (!crNumber && !companyNameAr) return CR_CONFIDENCE.NONE;
  if (crNumber && companyNameAr && occurrences >= 2) return CR_CONFIDENCE.HIGH;
  if (crNumber && occurrences >= 2) return CR_CONFIDENCE.MEDIUM;
  if (crNumber || companyNameAr) return CR_CONFIDENCE.LOW;
  return CR_CONFIDENCE.LOW;
}

/**
 * Returns the first candidate that survives cleaning and is not a blank-form
 * column description. '' if none qualify.
 * @param {Array<string>} candidates In priority order.
 * @return {string}
 */
function _firstNonLabel_(candidates) {
  for (var i = 0; i < candidates.length; i++) {
    var cleaned = _cleanCrValue_(candidates[i]);
    if (cleaned && !isFormLabelText_(cleaned)) return cleaned;
  }
  return '';
}

/**
 * Collects plausible trade-name candidates so the dialog can offer them as
 * one-click choices rather than the code guessing wrong.
 *
 * Rationale: on this form the trade name appears as the item numbered "٢-"
 * within the name column ("٢- تالنت للاستشارات والتدريب",
 * "٢- العنقاء للحلول الالكترونية"). A certificate carrying a name amendment
 * has more than one such line, and only a human can say which is current —
 * so we surface them all instead of picking.
 *
 * @param {{text: string, map: Array<number>, original: string}} n
 * @param {string} alreadyChosen Excluded from the list to avoid a duplicate.
 * @return {Array<string>} Up to 6 candidates, de-duplicated.
 */
function _collectNameCandidates_(n, alreadyChosen) {
  var acc = _newCandidateAccumulator_(alreadyChosen);

  // Amended names first — an amendment supersedes the original, so it is the
  // more likely answer and should head the list.
  CR_AMENDED_NAME_PATTERNS.forEach(function (re) {
    var m = n.text.match(re);
    if (!m) return;
    var g = n.text.indexOf(m[1], m.index);
    if (g === -1) return;
    acc.add(sliceOriginalRange_(n, g, g + m[1].length), 4);
  });

  // Then lines presented as a numbered item in the name column ("٢- ...").
  _forEachLine_(n, function (lineStart, lineEnd, normLine) {
    if (/^\s*[0-9]\s*[-–]/.test(normLine)) {
      acc.add(sliceOriginalRange_(n, lineStart, lineEnd), 4);
    }
  });

  return acc.values(6);
}

/**
 * Collects person-name candidates for the client's legal representative,
 * anchored on the "مواليد" (date of birth) marker that follows every named
 * individual on this form.
 *
 * Returned as candidates rather than a single value because a company may list
 * several managers or partners, and only a person can say which one signs.
 * @param {{text: string, map: Array<number>, original: string}} n
 * @return {Array<string>}
 */
function _collectPersonCandidates_(n) {
  var acc = _newCandidateAccumulator_('');

  _forEachLine_(n, function (lineStart, lineEnd, normLine) {
    var at = normLine.search(CR_BIRTH_MARKER);
    if (at === -1) return;
    var value = sliceOriginalRange_(n, lineStart, lineStart + at);
    // A full name is at least two words; this also rejects a bare label.
    if (collapseWhitespace_(value).split(/\s+/).length >= 2) acc.add(value, 6);
  });

  return acc.values(5);
}

/**
 * Collects address candidates. The address column has no label anchor that
 * survives OCR flattening, so lines are scored on address vocabulary instead.
 * Amended addresses ("تعديل العنوان") lead the list.
 * @param {{text: string, map: Array<number>, original: string}} n
 * @return {Array<string>}
 */
function _collectAddressCandidates_(n) {
  var acc = _newCandidateAccumulator_('');

  CR_AMENDED_ADDRESS_PATTERNS.forEach(function (re) {
    var m = n.text.match(re);
    if (!m) return;
    var g = n.text.indexOf(m[1], m.index);
    if (g === -1) return;
    acc.add(sliceOriginalRange_(n, g, g + m[1].length), 6, CR_MAX_ADDRESS_LENGTH);
  });

  _forEachLine_(n, function (lineStart, lineEnd, normLine) {
    for (var i = 0; i < CR_ADDRESS_HINTS.length; i++) {
      if (CR_ADDRESS_HINTS[i].test(normLine)) {
        acc.add(sliceOriginalRange_(n, lineStart, lineEnd), 6, CR_MAX_ADDRESS_LENGTH);
        return;
      }
    }
  });

  return acc.values(6);
}

/**
 * Shared de-duplicating candidate collector. Rejects blank-form column
 * descriptions and anything too short to be a real value.
 * @param {string} alreadyChosen Excluded so it isn't offered twice.
 * @return {{add: function(string, number), values: function(number): Array<string>}}
 */
function _newCandidateAccumulator_(alreadyChosen) {
  var out = [];
  var seen = {};
  if (alreadyChosen) seen[collapseWhitespace_(alreadyChosen)] = true;

  return {
    add: function (raw, minLetters, maxLength) {
      var value = _cleanCrValue_(raw);
      var key = collapseWhitespace_(value);
      if (!key || seen[key]) return;
      if (isFormLabelText_(value, maxLength)) return;
      if (countArabicLetters_(value) < minLetters) return;
      seen[key] = true;
      out.push(value);
    },
    values: function (cap) { return out.slice(0, cap); }
  };
}

/**
 * Walks every line of normalized text, handing the callback the line's bounds
 * (in normalized space) and its normalized content.
 * @param {{text: string}} n
 * @param {function(number, number, string)} fn
 */
function _forEachLine_(n, fn) {
  var lineStart = 0;
  var guard = 0;
  while (lineStart <= n.text.length && guard++ < 6000) {
    var nl = n.text.indexOf('\n', lineStart);
    var lineEnd = nl === -1 ? n.text.length : nl;
    fn(lineStart, lineEnd, n.text.substring(lineStart, lineEnd));
    if (nl === -1) break;
    lineStart = lineEnd + 1;
  }
}

/** Strips OCR noise and leading list markers ("٢- ", "2. ") from a value. */
function _cleanCrValue_(value) {
  var out = String(value || '');
  CR_VALUE_NOISE.forEach(function (re) { out = out.replace(re, ' '); });
  out = stripLeadingListMarker_(out);
  out = out.replace(/\s*[-–]\s*$/, '');
  return collapseWhitespace_(out);
}

// ---------------------------------------------------------------------
// Per-Opportunity storage
// ---------------------------------------------------------------------

/**
 * Reads the stored Commercial Registration for an Opportunity.
 * @param {string} opportunityId
 * @return {Object<string, *>|null} Row keyed by COLUMNS.COMMERCIAL_REGISTRATION.*, or null if never imported.
 */
function getCommercialRegistration_(opportunityId) {
  var sheet = getSheet_(SHEETS.COMMERCIAL_REGISTRATION);
  var headerMap = getHeaderIndexMap_(sheet);
  var rows = findRowsWhere_(sheet, headerMap, COLUMNS.COMMERCIAL_REGISTRATION.OPPORTUNITY_ID, opportunityId);
  if (rows.length === 0) return null;
  return getRowObject_(sheet, rows[rows.length - 1], headerMap);
}

/**
 * True if this Opportunity has usable CR data on file — at minimum a
 * registration number and an Arabic company name, the two fields the
 * Arabic agreements cannot be produced without.
 * @param {string} opportunityId
 * @return {boolean}
 */
function hasCommercialRegistration_(opportunityId) {
  var cr = getCommercialRegistration_(opportunityId);
  if (!cr) return false;
  var num = String(cr[COLUMNS.COMMERCIAL_REGISTRATION.CR_NUMBER] || '').trim();
  var name = String(cr[COLUMNS.COMMERCIAL_REGISTRATION.COMPANY_NAME_AR] || '').trim();
  return num !== '' && name !== '';
}

/**
 * Upserts the user-CONFIRMED Commercial Registration for an Opportunity.
 * These are the values the user approved in the dialog, not raw OCR output.
 * @param {string} opportunityId
 * @param {{companyNameAr: string, crNumber: string, address: string,
 *          nationalNumber: string, confidence: string, sourceFileUrl: string}} data
 */
function saveCommercialRegistration_(opportunityId, data) {
  var sheet = getSheet_(SHEETS.COMMERCIAL_REGISTRATION);
  var headerMap = getHeaderIndexMap_(sheet);

  var rowObj = {};
  rowObj[COLUMNS.COMMERCIAL_REGISTRATION.OPPORTUNITY_ID] = opportunityId;
  rowObj[COLUMNS.COMMERCIAL_REGISTRATION.COMPANY_NAME_AR] = data.companyNameAr || '';
  rowObj[COLUMNS.COMMERCIAL_REGISTRATION.CR_NUMBER] = data.crNumber || '';
  rowObj[COLUMNS.COMMERCIAL_REGISTRATION.REPRESENTATIVE_NAME] = data.representativeName || '';
  rowObj[COLUMNS.COMMERCIAL_REGISTRATION.ADDRESS] = data.address || '';
  rowObj[COLUMNS.COMMERCIAL_REGISTRATION.NATIONAL_NUMBER] = data.nationalNumber || '';
  rowObj[COLUMNS.COMMERCIAL_REGISTRATION.CONFIDENCE] = data.confidence || '';
  rowObj[COLUMNS.COMMERCIAL_REGISTRATION.SOURCE_FILE_URL] = data.sourceFileUrl || '';
  rowObj[COLUMNS.COMMERCIAL_REGISTRATION.IMPORTED_BY] = Session.getActiveUser().getEmail();
  rowObj[COLUMNS.COMMERCIAL_REGISTRATION.IMPORTED_AT] = formatDate_(new Date());

  var existing = findRowsWhere_(sheet, headerMap, COLUMNS.COMMERCIAL_REGISTRATION.OPPORTUNITY_ID, opportunityId);
  if (existing.length > 0) {
    var rowNumber = existing[existing.length - 1];
    Object.keys(rowObj).forEach(function (header) {
      if (headerMap[header]) setCellByHeader_(sheet, rowNumber, headerMap, header, rowObj[header]);
    });
  } else {
    appendRowObject_(sheet, headerMap, rowObj);
  }
}

/**
 * Archives the uploaded certificate to Drive so an extraction can be
 * audited later, and returns its URL.
 *
 * Best-effort by design: if no folder is configured or the write fails we
 * return '' rather than failing the import — the extracted data is the
 * deliverable, the archived copy is a convenience.
 * @param {GoogleAppsScript.Base.Blob} blob
 * @param {string} opportunityId
 * @return {string} File URL, or '' if not archived.
 */
function archiveCommercialRegistrationFile_(blob, opportunityId) {
  try {
    var folderId = getSetting_(SETTINGS_KEYS.CR_ARCHIVE_FOLDER_ID, false) ||
      getSetting_(SETTINGS_KEYS.OUTPUT_FOLDER_ID, false);
    if (!folderId) return '';
    var copy = blob.copyBlob();
    copy.setName('CR - ' + opportunityId + ' - ' + formatDate_(new Date()).replace(/\//g, '-'));
    return DriveApp.getFolderById(folderId).createFile(copy).getUrl();
  } catch (e) {
    return '';
  }
}

/**
 * Full import pipeline: OCR the file, parse it, archive the original, and
 * return parsed values for the user to confirm.
 *
 * Deliberately does NOT save — saving happens only once the user approves
 * the values in the confirmation dialog.
 * @param {GoogleAppsScript.Base.Blob} blob
 * @param {string} opportunityId
 * @return {Object} Parsed CR data plus sourceFileUrl and OCR diagnostics.
 */
function importCommercialRegistration_(blob, opportunityId) {
  var ocr = runOcr_(blob);
  var parsed = parseCommercialRegistration_(ocr.text);
  parsed.sourceFileUrl = archiveCommercialRegistrationFile_(blob, opportunityId);
  parsed.ocrProvider = ocr.provider;
  parsed.ocrCharCount = ocr.charCount;

  // Ship the recognized text back for the dialog's diagnostic panel. Without
  // it, a failed extraction is indistinguishable from a failed OCR — one is a
  // pattern problem, the other a scan problem, and they need opposite fixes.
  parsed.ocrRawText = String(ocr.text || '').substring(0, 6000);

  if (ocr.charCount < 50) {
    parsed.warnings.unshift(
      'Almost no text was recognized, so this looks like a scan problem rather than ' +
      'a matching problem. Try an upright, higher-resolution scan of just the certificate page.'
    );
  } else if (!parsed.crNumber && !parsed.companyNameAr) {
    parsed.warnings.unshift(
      'Text WAS recognized (' + ocr.charCount + ' characters) but no fields could be located in it. ' +
      'Open "Show recognized text" below, fill the fields in by hand, and send that text over so ' +
      'the matching rules can be tuned to this certificate layout.'
    );
  }
  return parsed;
}
