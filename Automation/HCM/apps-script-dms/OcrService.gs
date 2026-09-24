/**
 * OcrService.gs
 *
 * Reusable OCR service. Takes an uploaded file (PDF / JPG / PNG) and
 * returns plain text. It knows NOTHING about Commercial Registrations or
 * any other document type — parsing structured fields out of the text is
 * the caller's job (see CommercialRegistrationService.gs). Any future
 * document generator that needs OCR reuses this file as-is.
 *
 * === How the OCR actually happens ===
 * Apps Script has no native OCR. The built-in route is Drive's own OCR:
 * uploading an image/PDF with `ocr: true` makes Drive convert it into a
 * Google Doc whose body is the recognized text. That needs the Advanced
 * Drive Service enabled (Services > Drive API v2) — see README.
 *
 * The provider is pluggable on purpose: OCR_PROVIDERS maps a provider name
 * to a function(blob, languageHint) -> string. Today only 'drive' ships.
 * A Cloud Vision provider (materially better on Arabic, but needs a GCP
 * project with billing + an API key) can be added later by adding one
 * entry here — no caller changes.
 */

/**
 * Hard ceiling for an upload.
 *
 * Deliberately low. Drive's OCR degrades sharply past roughly 2 MB and, on
 * large multi-page scans, frequently returns no text at all after a long wait
 * — which reads to the user as a mysterious failure. Rejecting early with
 * instructions is a better experience than a slow silent miss.
 */
var OCR_MAX_BYTES = 4 * 1024 * 1024; // 4 MB

/** Size past which Drive OCR gets unreliable; used to warn rather than reject. */
var OCR_SOFT_LIMIT_BYTES = 2 * 1024 * 1024; // 2 MB

var OCR_ACCEPTED_MIME_PREFIXES = ['image/'];
var OCR_ACCEPTED_MIME_EXACT = ['application/pdf'];

/**
 * Runs OCR on a file and returns the recognized plain text.
 * @param {GoogleAppsScript.Base.Blob} blob The uploaded file.
 * @param {string=} languageHint BCP-47-ish hint, e.g. 'ar'. Defaults to the configured OCR language.
 * @return {{text: string, provider: string, charCount: number}}
 */
function runOcr_(blob, languageHint) {
  validateOcrInput_(blob);

  var providerName = getSetting_(SETTINGS_KEYS.OCR_PROVIDER, false) || 'drive';
  var provider = OCR_PROVIDERS[providerName];
  if (!provider) {
    throw new AppError_(
      'Unknown OCR Provider',
      'The Settings sheet asks for OCR provider "' + providerName + '", which is not registered.\n\n' +
      'Valid values: ' + Object.keys(OCR_PROVIDERS).join(', ') + '.'
    );
  }

  var lang = languageHint || getSetting_(SETTINGS_KEYS.OCR_LANGUAGE, false) || 'ar';
  var text = provider(blob, lang);
  return { text: text || '', provider: providerName, charCount: (text || '').length };
}

/**
 * Rejects inputs we know can't work, with a message that says what to do
 * instead — cheaper and clearer than letting Drive fail obscurely.
 * @param {GoogleAppsScript.Base.Blob} blob
 */
function validateOcrInput_(blob) {
  if (!blob) {
    throw new AppError_('No File', 'No file was received. Choose a PDF, JPG, or PNG and try again.');
  }
  var mime = blob.getContentType() || '';
  var accepted = OCR_ACCEPTED_MIME_EXACT.indexOf(mime) !== -1 ||
    OCR_ACCEPTED_MIME_PREFIXES.some(function (p) { return mime.indexOf(p) === 0; });
  if (!accepted) {
    throw new AppError_(
      'Unsupported File Type',
      'Received "' + mime + '". Upload a PDF, JPG, or PNG.'
    );
  }
  var size = blob.getBytes().length;
  if (size > OCR_MAX_BYTES) {
    var mb = (size / (1024 * 1024)).toFixed(1);
    throw new AppError_(
      'File Too Large For OCR',
      'That file is ' + mb + ' MB. Drive\'s text recognition becomes unreliable above about 2 MB ' +
      'and usually returns nothing at all on large multi-page scans.\n\n' +
      'Upload ONE page — just the certificate page itself:\n\n' +
      '  • Best: a JPG or PNG screenshot of that single page (this dialog shrinks images automatically)\n' +
      '  • Or: open the PDF, extract/print only that page, and upload that\n\n' +
      'A full scanned bundle will not work no matter how long it runs.'
    );
  }
}

/**
 * Registered OCR providers. Each is function(blob, lang) -> recognized text.
 * @type {Object<string, function(GoogleAppsScript.Base.Blob, string): string>}
 */
var OCR_PROVIDERS = {

  /**
   * Drive-native OCR: upload the image/PDF asking Drive to convert it via
   * OCR, read the text out of the resulting Google Doc, then bin the Doc.
   *
   * IMPORTANT — do NOT set mimeType on the insert resource. The resource
   * describes the file being UPLOADED, so claiming
   * 'application/vnd.google-apps.document' makes Drive think a Doc is being
   * uploaded and it rejects the request with "OCR is not supported for files
   * of type application/vnd.google-apps.document". The source stays a
   * PDF/image; `convert: true` is what produces the Doc.
   *
   * Known limits, which is why the caller must always let the user review
   * the result: Drive OCR only processes roughly the first 10 pages of a
   * PDF, degrades on low-resolution or rotated scans, and often mangles
   * dense multi-column government forms.
   */
  drive: function (blob, lang) {
    if (typeof Drive === 'undefined' || !Drive.Files) {
      throw new AppError_(
        'Drive API Not Enabled',
        'This feature needs the Advanced Drive Service.\n\n' +
        'In the Apps Script editor: Services (+) > select "Drive API" > Version v2 > Add. Then try again.'
      );
    }

    var tempFileId = null;
    try {
      var inserted = Drive.Files.insert(
        { title: 'TEMP-OCR-' + new Date().getTime() },
        blob,
        { ocr: true, ocrLanguage: lang, convert: true }
      );
      tempFileId = inserted.id;

      // If conversion didn't yield a Doc, openById would throw something far
      // less informative than this.
      if (inserted.mimeType !== 'application/vnd.google-apps.document') {
        throw new AppError_(
          'OCR Produced No Text Document',
          'Drive accepted the file but did not convert it into a readable document ' +
          '(it came back as "' + inserted.mimeType + '").\n\n' +
          'This usually means the file has no recognizable text. Try an upright, ' +
          'higher-resolution scan of just the certificate page — or use ' +
          '"Enter manually instead".'
        );
      }

      return DocumentApp.openById(tempFileId).getBody().getText();
    } catch (e) {
      // Let our own already-friendly errors through untouched.
      if (e instanceof AppError_) throw e;
      throw new AppError_(
        'OCR Failed',
        'Drive could not read text from that file.\n\n' +
        'Technical detail: ' + (e && e.message ? e.message : String(e)) + '\n\n' +
        'Try an upright, higher-resolution scan of just the Commercial Registration page.'
      );
    } finally {
      if (tempFileId) {
        try { DriveApp.getFileById(tempFileId).setTrashed(true); } catch (ignore) {}
      }
    }
  }
};

// ---------------------------------------------------------------------
// Text normalization — shared by any parser built on top of this service
// ---------------------------------------------------------------------

/** Eastern Arabic-Indic digits (٠-٩) in code-point order. */
var ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
/** Extended/Persian Arabic-Indic digits (۰-۹), sometimes produced by OCR instead. */
var EXTENDED_ARABIC_INDIC_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/**
 * Converts Eastern Arabic-Indic and Persian digits to Western 0-9.
 *
 * Egyptian (and Saudi) official documents print numbers as ٠١٢٣٤٥٦٧٨٩, so
 * a Commercial Registration number comes back from OCR as "١٤٤٤٩" rather
 * than "14449". Every numeric field must pass through this before it's
 * pattern-matched or shown to the user.
 * @param {string} str
 * @return {string}
 */
function normalizeArabicDigits_(str) {
  if (str === undefined || str === null) return '';
  var out = String(str);
  for (var i = 0; i < 10; i++) {
    out = out.split(ARABIC_INDIC_DIGITS.charAt(i)).join(String(i));
    out = out.split(EXTENDED_ARABIC_INDIC_DIGITS.charAt(i)).join(String(i));
  }
  return out;
}
/**
 * Tashkeel (diacritics) and tatweel — dropped before matching. Written as
 * \u escapes rather than literal glyphs so the pattern survives any
 * editor/encoding round-trip.
 */
var ARABIC_STRIPPED_CHARS = /[\u064B-\u065F\u0670\u0640]/;

/** Alef variants (آ أ إ ٱ) that all normalize to bare alef (ا). */
var ARABIC_ALEF_VARIANTS = '\u0622\u0623\u0625\u0671';
var ARABIC_PLAIN_ALEF = '\u0627';
var ARABIC_ALEF_MAKSURA = '\u0649';  // ى
var ARABIC_YA = '\u064A';            // ي
var ARABIC_TA_MARBUTA = '\u0629';    // ة
var ARABIC_HA = '\u0647';            // ه

/**
 * Normalizes Arabic text for reliable matching AND returns an index map
 * back to the original string.
 *
 * Why the map matters: normalization is lossy on purpose (ة->ه, أ->ا,
 * ى->ي) because OCR returns those variants interchangeably, and label
 * matching would silently miss without it. But the normalized form must
 * never be what we write into a document — a real client name like
 * "شركة مجموعة الغانم" would land in a signed legal agreement misspelled
 * as "شركه مجموعه الغانم". So: locate on the normalized text, then slice
 * the value out of the ORIGINAL string via this map.
 *
 * map[i] is the index in the original string of normalized character i.
 * Newlines are preserved (no whitespace collapsing) so patterns can bound
 * a value to one line with [^\n].
 *
 * @param {string} str
 * @return {{text: string, map: Array<number>, original: string}}
 */
function normalizeArabicWithMap_(str) {
  var original = String(str === undefined || str === null ? '' : str);
  var chars = [];
  var map = [];

  for (var i = 0; i < original.length; i++) {
    var ch = original.charAt(i);
    if (ARABIC_STRIPPED_CHARS.test(ch)) continue;

    var c = ch;
    var d = ARABIC_INDIC_DIGITS.indexOf(ch);
    var e = EXTENDED_ARABIC_INDIC_DIGITS.indexOf(ch);
    if (d >= 0) {
      c = String(d);
    } else if (e >= 0) {
      c = String(e);
    } else if (ARABIC_ALEF_VARIANTS.indexOf(ch) >= 0) {
      c = ARABIC_PLAIN_ALEF;
    } else if (ch === ARABIC_ALEF_MAKSURA) {
      c = ARABIC_YA;
    } else if (ch === ARABIC_TA_MARBUTA) {
      c = ARABIC_HA;
    }
    chars.push(c);
    map.push(i);
  }

  return { text: chars.join(''), map: map, original: original };
}

/**
 * Runs an ordered list of patterns against normalized text and returns the
 * first capturing-group hit, sliced from whichever form the caller needs.
 *
 * @param {string} rawText
 * @param {Array<RegExp>} patterns Written against NORMALIZED text.
 * @param {boolean=} preferNormalized True for numeric fields (want Western
 *     digits); false/omitted for prose (want the original Arabic spelling).
 * @return {string} '' if nothing matched.
 */
function matchFromArabic_(rawText, patterns, preferNormalized) {
  var n = normalizeArabicWithMap_(rawText);
  for (var i = 0; i < patterns.length; i++) {
    var m = n.text.match(patterns[i]);
    if (!m || !m[1] || !String(m[1]).trim()) continue;
    if (preferNormalized) return String(m[1]).trim();

    var groupStart = n.text.indexOf(m[1], m.index);
    if (groupStart === -1) return String(m[1]).trim();
    var groupEnd = groupStart + m[1].length;
    var origStart = n.map[groupStart];
    var origEnd = n.map[groupEnd - 1] + 1;
    return n.original.substring(origStart, origEnd).trim();
  }
  return '';
}

/**
 * Convenience wrapper when only the normalized text is needed and no
 * mapping back is required (e.g. a "does this mention X at all" check).
 * @param {string} str
 * @return {string}
 */
function normalizeArabicText_(str) {
  return collapseWhitespace_(normalizeArabicWithMap_(str).text);
}

/**
 * Maps a [start, end) range in normalized space back to the ORIGINAL string,
 * so an extracted value keeps its exact Arabic spelling.
 * @param {{text: string, map: Array<number>, original: string}} n From normalizeArabicWithMap_.
 * @param {number} start Inclusive index in n.text.
 * @param {number} end Exclusive index in n.text.
 * @return {string}
 */
function sliceOriginalRange_(n, start, end) {
  if (start < 0 || start >= n.map.length) return '';
  var e = Math.min(end, n.map.length);
  if (e <= start) return '';
  return n.original.substring(n.map[start], n.map[e - 1] + 1).trim();
}

/**
 * Finds a number near a label, rather than strictly after it.
 *
 * Why proximity instead of adjacency: OCR of a wide RTL table does not
 * preserve reading order. A header like "مستخرج سجل تجارى رقم:٢٢٦٣٨٢" can
 * come back with the digits before the label, separated by text from an
 * adjacent column, or pushed onto the next line. Anchoring on the label and
 * then sweeping a window forward AND backward survives all of those; a
 * label-then-value regex does not.
 *
 * @param {{text: string}} n From normalizeArabicWithMap_.
 * @param {Array<RegExp>} labelPatterns Tried in order, against normalized text.
 * @param {number} minDigits
 * @param {number} maxDigits
 * @param {number=} windowChars How far to sweep either side. Default 120.
 * @return {string} The matched digits, or ''.
 */
function findNumberNearLabel_(n, labelPatterns, minDigits, maxDigits) {
  var digitRe = new RegExp('\\d{' + minDigits + ',' + maxDigits + '}', 'g');

  for (var i = 0; i < labelPatterns.length; i++) {
    var m = n.text.match(labelPatterns[i]);
    if (!m) continue;

    var bounds = lineBoundsAt_(n.text, m.index);
    var labelEnd = m.index + m[0].length;

    // 1. Same line, forward. Staying inside the line matters: an unbounded
    //    forward sweep crosses into the NEXT label's row and returns that
    //    field's number instead (e.g. the national number for the CR number).
    var f = n.text.substring(labelEnd, bounds.end).match(digitRe);
    if (f && f.length) return f[0];

    // 2. Same line, backward — RTL output often puts the digits first. Take
    //    the one closest to the label.
    var b = n.text.substring(bounds.start, m.index).match(digitRe);
    if (b && b.length) return b[b.length - 1];

    // 3. Following lines, for when the value was pushed onto its own line.
    var cursor = bounds.end;
    for (var guard = 0; guard < 3 && cursor < n.text.length; guard++) {
      var start = cursor + 1;
      var nl = n.text.indexOf('\n', start);
      var end = nl === -1 ? n.text.length : nl;
      var nxt = n.text.substring(start, end).match(digitRe);
      if (nxt && nxt.length) return nxt[0];
      cursor = end;
      if (nl === -1) break;
    }
  }
  return '';
}

/**
 * Returns the [start, end) bounds of the line containing the given index.
 * @param {string} text
 * @param {number} index
 * @return {{start: number, end: number}}
 */
function lineBoundsAt_(text, index) {
  var start = text.lastIndexOf('\n', index) + 1;
  var nl = text.indexOf('\n', index);
  return { start: start, end: nl === -1 ? text.length : nl };
}

/** Arabic letter range, used to tell a real value from OCR column debris. */
var ARABIC_LETTER_RE = /[ء-ي]/g;

/** Counts Arabic letters in a string. */
function countArabicLetters_(str) {
  var m = String(str || '').match(ARABIC_LETTER_RE);
  return m ? m.length : 0;
}

/**
 * Finds a prose value near a label: the remainder of the label's own line,
 * falling back to the next non-empty line when the label sits alone (which is
 * what happens when OCR breaks a table cell across lines).
 *
 * Returns the ORIGINAL text, not the normalized form, so Arabic spelling is
 * preserved verbatim for the legal document.
 *
 * @param {{text: string, map: Array<number>, original: string}} n
 * @param {Array<RegExp>} labelPatterns
 * @param {number=} minLength Ignore candidates shorter than this. Default 3.
 * @return {string}
 */
function findTextNearLabel_(n, labelPatterns, minLetters) {
  var minLtr = minLetters || 3;

  // A candidate must carry real Arabic words. Length alone is not enough:
  // sweeping past a label often picks up debris from the neighbouring table
  // column ("١١٩٩٢- أ"), which passes a length test but is not a value.
  function acceptable(value) {
    return countArabicLetters_(stripLeadingListMarker_(value)) >= minLtr;
  }

  for (var i = 0; i < labelPatterns.length; i++) {
    var m = n.text.match(labelPatterns[i]);
    if (!m) continue;

    var bounds = lineBoundsAt_(n.text, m.index);
    var labelEnd = m.index + m[0].length;

    // Rest of the label's own line.
    var candidate = sliceOriginalRange_(n, labelEnd, bounds.end);
    if (acceptable(candidate)) return candidate;

    // Otherwise walk forward until a line looks like a real value.
    var cursor = bounds.end;
    for (var guard = 0; guard < 5 && cursor < n.text.length; guard++) {
      var start = cursor + 1;
      var next = n.text.indexOf('\n', start);
      var end = next === -1 ? n.text.length : next;
      var line = sliceOriginalRange_(n, start, end);
      if (acceptable(line)) return line;
      cursor = end;
      if (next === -1) break;
    }
  }
  return '';
}

/** Strips a leading "٢- " / "2. " list marker from an extracted value. */
function stripLeadingListMarker_(value) {
  return String(value || '').replace(/^\s*[0-9٠-٩]+\s*[-–.]\s*/, '');
}

/** Collapses runs of whitespace/newlines into single spaces. Keeps original characters. */
function collapseWhitespace_(str) {
  return String(str === undefined || str === null ? '' : str).replace(/\s+/g, ' ').trim();
}
