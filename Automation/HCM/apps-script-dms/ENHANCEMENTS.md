# Enhancement Release — Commercial Registration Import & Agreement Automation

Enhancement to the existing Talent 360 DMS. **No architectural changes** — the
Opportunity-centric model, the registry-driven document engine, and the module
boundaries are all unchanged. Two new service modules were added alongside the
existing ones, and the four agreement/date/naming behaviours were modified in
place.

---

## ⚠️ Two things to know before you test

### 1. You must enable the Drive API (one-time, 30 seconds)

Apps Script has no built-in OCR. This uses Drive's own OCR, which requires the
Advanced Drive Service:

**Apps Script editor → Services (＋ icon, left sidebar) → "Drive API" → Version
`v2` → Add**

Without this, the import shows a clear "Drive API Not Enabled" message rather
than failing obscurely.

### 2. Your sample certificates are Egyptian, not Saudi

Your brief specified *Saudi* Commercial Registration. Both files you supplied
are **Egyptian** certificates (وزارة التموين والتجارة الداخلية / جهاز تنمية
التجارة الداخلية). I built the parser against the Egyptian layout the samples
actually show — and included Saudi label variants in the same pattern set, so a
Saudi certificate extracts too. Nothing to change if you're staying Egyptian.

**Confirmed from your samples** (both share one layout):

| Field | Label found | Sample 1 | Sample 2 |
|---|---|---|---|
| CR Number | `مستخرج سجل تجارى رقم:` and again at `رقم القيد فى السجل التجارى` | `14449` | `148877` |
| Company Name | `السمة التجارية` | `تالنت للاستشارات والتدريب` | `شركة مجموعة الغانم الزراعية` |
| National No. | `الرقم القومى للمنشآة:` | `623384175` | — |
| Address | `عنوان المركز العام للشركة` | present | absent |

Two things worth flagging about the samples themselves:

- **Sample 1 is Talent 360's own certificate** (CR 14449 — the same number
  hardcoded as the *second* party in your agreement templates). Fine as a
  format sample, but remember the import populates the **first** party (client).
- Numbers print in Eastern Arabic-Indic digits (`٠١٢٣٤٥٦٧٨٩`), so `١٤٤٤٩` is
  converted to `14449` automatically.

### What actually extracts — measured, not hoped

Tested against the real certificates. **This is the honest baseline:**

| Field | Result | Why |
|---|---|---|
| Commercial Registration Number | ✅ **Reliable** | Printed as a true `label: value` pair on a single header line (`مستخرج سجل تجارى رقم:14449`), and repeated in column 1 so it can be cross-checked |
| National Establishment Number | ✅ **Reliable** | Same single-line header pattern |
| Company Name (Arabic) | ⚠️ **Type it** | See below |
| Company Address | ⚠️ **Type it** | See below |

**Why name and address can't be extracted, and why more regex won't fix it:**
the form prints a large block of *column descriptions*, then the actual values
in a spatially distant row far below. Once OCR flattens the page into text, the
description block sits immediately next to the very labels a parser searches
for, and the spatial relationship that distinguishes "description of column 2"
from "value in column 2" is gone. Early versions of this code duly extracted
`إسم التاجر ولقبه وتاريخ ومحل ميلاده وجنسيته` — a column description — as the
company name. Putting that in a signed agreement is worse than extracting
nothing, so `isFormLabelText_()` now rejects such candidates outright and
leaves the field empty.

Instead of guessing, plausible names found on the certificate are offered as
**one-click chips** under the field. This also handles a real case in the
samples: a certificate carrying a name amendment has *two* valid names
(`العنقاء للحلول الالكترونية`, amended to `العنقاء للفندقة`) and only a person
can say which is current.

The name is typed **once per client** and stored on the Opportunity, so every
future document for that client reuses it.

**Also ruled out:** the QR code on these certificates encodes only the request
number (`7327717`), not registry data — checked, dead end.

**Upgrade path if this ever isn't enough:** `OcrService.gs` is
provider-pluggable. Google Cloud Vision returns bounding boxes, which would
allow locating a value *spatially* relative to its label and genuinely solve
name + address. That's one new entry in `OCR_PROVIDERS` with **zero** caller
changes — it needs a GCP project with billing (free tier covers 1000
pages/month).

### File size matters more than anything else

Drive OCR becomes unreliable above roughly **2 MB** and, on large multi-page
scans, typically returns nothing at all after a long wait. Accordingly:

- Uploads over **4 MB are rejected immediately** with instructions, rather than
  spinning and silently failing.
- **Images are downscaled in the browser before upload** (max 2200px edge,
  stepped JPEG quality until under 1.6 MB), so a phone photo or large PNG just
  works.
- **PDFs are not downscaled** — for a multi-page PDF, extract the single
  certificate page first, or screenshot it as a JPG/PNG and upload that.

**Rule of thumb: one page, as an image, and it will work.**

---

## What changed, requirement by requirement

| # | Requirement | Implementation |
|---|---|---|
| 1 | CR import (PDF/JPG/PNG) + editable confirmation | `OcrService.gs` + `CommercialRegistrationService.gs`; UI in `CrImportPartial.html` |
| 2 | Auto-populate Client CR Number | `resolveFirstParty_()` → `{{COMMERCIAL_REGISTRATION}}` |
| 3 | Auto-populate Client Address | `resolveFirstParty_()` → `{{COMPANY_ADDRESS}}` |
| 4 | Agreement Date = today, never manual | Removed from both agreements' `fields[]`; stamped via `todayInConfiguredTimezone_()` |
| 5 | Name = `Talent360 - {Client} - {Type}` | `buildDocumentName_()` in `DocumentEngine.gs` |
| 6 | End Date = Start + 1yr − 1day, overridable | `computeContractEndDate_()`; wizard auto-fills, respects manual override |
| 7 | First Party from CR | `resolveFirstParty_()`, one place, all agreements |
| 8 | Reusable OCR, no duplication | `OcrService.gs` knows nothing about CRs; returns text. CR parsing is separate. Shared UI partial used by both consumers |
| 9 | Prompt → extract → confirm → populate → generate | Inline wizard gate step (see below) |

### New files (2 modules, 2 views)

| File | Responsibility |
|---|---|
| `OcrService.gs` | **Document-type agnostic.** Blob → text. Pluggable providers, MIME/size validation, Arabic digit + text normalization with index mapping. |
| `CommercialRegistrationService.gs` | CR-specific parsing → structured data + confidence; per-Opportunity storage. |
| `CrImportPartial.html` | Shared upload + confirm UI (`CrImport.mount(...)`) used by both the standalone dialog and the wizard — so the markup exists once. |
| `CommercialRegistrationDialog.html` | Thin shell over the partial, for the menu entry. |

### Modified files

`Config.gs` (new sheet + columns + settings) · `Helpers.gs` (Arabic dates, today,
end-date math) · `SetupService.gs` (creates new sheet, seeds settings) ·
`DocumentTypeRegistry.gs` (`resolveFirstParty_`, `dataColumns`,
`requiresCommercialRegistration`, revised agreement fields) ·
`DocumentEngine.gs` (naming) · `ValidationService.gs` (CR gate) · `UI.gs` (CR
endpoints, end-date endpoint, derived-value snapshot) · `GenerateWizard.html`
(CR gate step, First Party panel, auto end date) · `Menu.gs` (new item).

---

## Design decisions worth knowing

**CR data lives at Opportunity level, not document level.** A company has one
Commercial Registration regardless of how many documents you generate. New
`Commercial Registration` sheet, 1:1 with Opportunity — the same pattern as
`HCM Service Selection`. This is what makes it reusable by *all* future
document generators: they just read it. (Requirement 8.)

**The Arabic certificate name wins over the Opportunity's Company field —
inside the document only.** These agreements are Arabic legal instruments, so
`{{CLIENT_NAME}}` gets `شركة مجموعة الغانم الزراعية`, not "Al-Ghanim Group".
But the **Drive filename** deliberately uses the English Company field, because
a Drive folder full of Arabic filenames is far harder for the sales team to
scan. Falls back to the Opportunity name if no CR is imported.

**Normalization is lossy, so values are sliced from the original text.** Arabic
OCR returns أ/ا/إ and ة/ه interchangeably, so matching *must* normalize. But
returning the normalized value would write `شركه مجموعه` into a signed
contract instead of `شركة مجموعة`. `normalizeArabicWithMap_()` therefore keeps
an index map: **locate** on normalized text, **slice** from the original. Numeric
fields take the normalized form (Western digits); prose fields keep original
spelling verbatim. This was a real bug caught during testing, not a
hypothetical.

**Version rows snapshot the derived values.** `_withDerivedValues_()` writes the
agreement date and the three CR-sourced values into the version row alongside
the typed ones — so a stored version always shows exactly what went into that
document, even after the CR is re-imported.

**Cross-checking gives a real confidence signal.** The CR number appears twice
in the Egyptian layout (header + column 1). Agreement between the two
occurrences is the strongest signal available without human review, and drives
the `high`/`medium`/`low` badge.

---

## New Settings keys

Run **Initialize / Repair Sheets** once; these appear pre-seeded:

| Key | Default | Notes |
|---|---|---|
| `OCR Provider` | `drive` | Only `drive` ships today |
| `OCR Language` | `ar` | Passed to Drive OCR |
| `Commercial Registration Archive Folder ID` | *(blank)* | Where uploaded certificates are archived. Falls back to Output Folder; blank = don't archive |
| `Default Contract Duration (Years)` | `1` | Drives the end-date rule |

---

## Testing walkthrough

**Setup:** enable Drive API v2 (above) → **Initialize / Repair Sheets** →
confirm a new `Commercial Registration` tab exists with 9 columns.

1. **Import via menu.** Select an HCM Opportunity → **Import Commercial
   Registration**. Upload **a single certificate page as a JPG/PNG** (not a
   full PDF bundle — see the size section above).
   Expect: registration number and national number filled in automatically, a
   confidence badge, and name suggestions offered as chips. Pick or type the
   Arabic name, then **Save**. Confirm the sheet row was written.

   Ground truth for the samples — registration numbers `14449` (Talent 360's
   own), `148877` (Al-Ghanim), `226382` (Al-Anqa).

2. **The gate (requirement 9).** Pick an HCM Opportunity with **no** CR yet →
   **Generate Document** → **HCM Agreement**. Expect: the wizard routes
   straight to *"Commercial Registration Needed"* rather than the form. Import
   there; on save it advances to the form automatically with the First Party
   panel filled in. No copy-pasting anywhere.

3. **Auto end date (requirement 6).** In the form, set **Contract Start Date**
   to `2026-05-04`. Expect **Contract End Date** to auto-fill `2027-05-03`
   (verified: `04/05/2026 → 03/05/2027`). Now type a different end date — then
   change the start date again and confirm your override is **kept**.

4. **Agreement date + naming (4 & 5).** Generate. Expect the Drive file named
   exactly `Talent360 - {Company} - HCM Agreement`, and the agreement date
   inside showing **today**. There is no Agreement Date input anywhere.

5. **First Party in the document (7).** Open the generated Doc and check
   الطرف الأول shows the Arabic company name, registration number, and address
   from the certificate.

6. **Renumbering still works.** Uncheck *Benefits Administration*, regenerate,
   and confirm Article 1 runs `1.` → `6.` with no gap and the Benefits clause
   fully gone.

7. **Manual fallback.** Upload a blank/garbage image. Expect a low-confidence
   badge with warnings and empty editable fields — plus **Enter manually
   instead** on the upload step for when there's no scan at all.

8. **Reuse check (8).** Generate an **Offshoring Agreement** for an Offshoring
   Opportunity. It uses the *same* CR data and the *same* gate with no
   Offshoring-specific OCR code — confirming the module is genuinely shared.
