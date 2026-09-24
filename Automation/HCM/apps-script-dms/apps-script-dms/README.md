# Talent 360 — Document Management System

An Opportunity-centric system for generating HCM and Offshoring proposals
and agreements. See the [architecture review](../t360-dms-architecture.html)
for the full design rationale — this file is the practical install guide.

## File structure

| File | Responsibility |
|---|---|
| `Config.gs` | Sheet names, column headers (per sheet), status/product enums, ID formats. The only file with literal sheet/column names in it. |
| `DocumentTypeRegistry.gs` | The domain model for all 4 document types — fields, template setting key, dynamic-block config. Add a 5th document type here, nowhere else. |
| `Helpers.gs` | Generic sheet utilities: header-name lookup, row↔object conversion, ID generation, date normalization. |
| `SettingsService.gs` | Reads/writes the Settings sheet; the only place template IDs live. |
| `OpportunityService.gs` | CRUD for Opportunities + the shared HCM Service Selection table. |
| `DocumentEngine.gs` | The one reusable generation pipeline every document type flows through. |
| `ValidationService.gs` | Schema-driven field validation, sourced from DocumentTypeRegistry. |
| `HistoryService.gs` | Versioned writes to each data sheet + the cross-cutting Documents index. |
| `SetupService.gs` | One-click creation/repair of all 8 sheets, with headers, checkboxes, dropdowns. |
| `UI.gs` | Controller between the HTML dialogs and the service layer. |
| `Menu.gs` | `onOpen()` — the "Talent 360 DMS" menu. |
| `Styles.html` | Shared CSS, included into every dialog. |
| `OpportunityDialog.html` | "New Opportunity" modal. |
| `GenerateWizard.html` | The 3-step "Generate Document" wizard. |
| `HistorySidebar.html` | "View Document History" sidebar. |
| `SettingsDialog.html` | "Settings" modal. |

## How the shared document engine works

Every document type is described once, as data, in `DocumentTypeRegistry.gs`.
`DocumentEngine.gs` never mentions HCM, Offshoring, English, or Arabic —
it just reads whatever `DOCUMENT_TYPES[key]` gives it:

1. Duplicate that type's template (`templateSettingKey` → Settings sheet).
2. If it has removable service blocks (`dynamicBlocks`), delete the
   disabled ones and renumber the survivors using that type's own
   `numberFormat` function (`n => "3." + n` for the English Proposal,
   `n => n + "."` for the Arabic Agreement's plain numbering).
3. Replace every `{{PLACEHOLDER}}` from `buildPlaceholderMap(...)`.
4. Save, return the URL.

Both HCM documents read the *same* `HCM Service Selection` row for a given
Opportunity — there's no sync step, because there's nothing to keep in
sync; they read one shared source.

## Installation

### 1. Create the spreadsheet

Create a new Google Sheet. Nothing else needs to be done by hand — the
sheets, headers, checkboxes, and dropdowns are all created by the script.

### 2. Install the script

1. **Extensions > Apps Script** from that Sheet.
2. Delete the default empty `Code.gs`.
3. Create each `.gs` and `.html` file listed above and paste in its
   contents.
4. **Project Settings > Show "appsscript.json" manifest file in editor**,
   replace its contents with this project's `appsscript.json`.
5. Save the project.

### 3. Initialize the spreadsheet

1. Reload the Sheet. The **Talent 360 DMS** menu appears after a few
   seconds.
2. **Talent 360 DMS > Initialize / Repair Sheets.** Authorize when
   prompted (Advanced > Go to [project] > Allow — normal for a
   self-authored script).
3. This creates all 8 sheets: `Settings`, `Opportunities`,
   `HCM Service Selection`, `HCM Proposal Data`, `HCM Agreement Data`,
   `Offshoring Proposal Data`, `Offshoring Agreement Data`, `Documents` —
   with headers, frozen header rows, and dropdown/checkbox validation
   already applied. Safe to re-run any time; it only adds what's missing.

### 4. Connect the four templates

1. Upload all four templates to Drive (they're alongside this project):
   `Talent 360 - Proposal Template.docx`, `Talent 360 - HCM Agreement
   Template.docx`, `T360 - Offshoring_Payroll Proposal Template.docx`,
   `T360 - Offshoring Agreement Template.docx`. Opening each converts it
   to a native Google Doc automatically.
2. Copy each one's document ID from its URL
   (`.../document/d/`**`THIS_PART`**`/edit`).
3. **Talent 360 DMS > Settings**, paste each ID into its matching row
   (`HCM Proposal Template ID`, `HCM Agreement Template ID`,
   `Offshoring Proposal Template ID`, `Offshoring Agreement Template ID`),
   and set `Output Folder ID` to a Drive folder ID if you want generated
   docs saved somewhere specific (leave blank to save next to each
   template). Review the pre-filled defaults (currency, onsite visits,
   validity days, Arabic contract-duration text) and adjust if needed.
   **Save.**

## Testing walkthrough

1. **Talent 360 DMS > New Opportunity** — Company "Acme Corp", Product
   "HCM". Creates `OPP-00001`, defaults Pipeline Stage to "New", and
   silently creates an all-services-enabled row in `HCM Service Selection`.
2. Select that row, **Generate Document** — step 1 offers HCM Proposal /
   HCM Agreement only (not Offshoring's). Choose **HCM Proposal**.
3. Step 2 shows only HCM Proposal's fields (Employees To Hire, Onsite
   Visits, Monthly Fee, Currency, Validity) plus the 7 service checkboxes,
   all pre-checked. Uncheck **Benefits Administration**, fill in the
   fields, **Generate**.
4. Confirm the result screen's link opens a doc where Section 3 reads
   `3.1 Recruitment, 3.2 Onboarding, 3.3 Performance Management, 3.4
   Employee Relations, 3.5 Compensation, 3.6 Personnel` — no `3.7`, no gap.
5. **Generate Document** again on the same Opportunity, choose **HCM
   Agreement** this time. Confirm the service checkboxes already reflect
   Benefits being unchecked (shared state, not re-asked) — and that its
   Article 1 is missing the Benefits sub-clause with Arabic numbering
   `١.`–`٦.` running cleanly with no gap either.
6. **View Document History** — sidebar shows both documents for this
   Opportunity, versions 1 and 1 (different types, independent version
   counters), with working links.
7. Regenerate the HCM Proposal (**Generate Document > HCM Proposal**
   again) — confirm the form pre-fills with your previous entries, and
   after generating, History shows the Proposal at version **2**, the
   original version 1 row untouched in `HCM Proposal Data`.
8. Repeat steps 1–4 with a Product = "Offshoring" Opportunity — confirm
   step 1 only offers Offshoring Proposal / Offshoring Agreement, and the
   Offshoring Agreement's wizard form asks for Commercial Registration,
   Representative, Address, dates, and Fee — nothing HCM-related.
9. **Validation check**: start a Generate Document flow, leave a required
   field blank, click Generate — confirm a specific, friendly error
   listing exactly what's missing, and that no document gets created.
