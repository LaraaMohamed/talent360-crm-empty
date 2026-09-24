# Talent 360 HCM Proposal Generator — Apps Script Project

Generates client-ready HCM proposals from a Google Sheet, using a Google Docs
template with a dynamically-built, always-correctly-numbered Section 3.

## File structure

| File | Responsibility |
|---|---|
| `Config.gs` | Every environment value: template ID, sheet name, column header names, timezone, date format, status labels. The only file with literal configuration in it. |
| `ServiceRegistry.gs` | The domain model for Section 3 — the ordered list of services, their sheet column, scope label, and template control tokens. Adding a future service means adding one entry here. |
| `Helpers.gs` | Generic utilities: sheet access, header-name → column-index lookup, row↔object conversion, regex-safe escaping, alert dialogs. |
| `Validation.gs` | All pre-flight checks (client name present, employees-to-hire present when Recruitment is checked, at least one service checked, template/sheet exist), each with a friendly error message. |
| `TemplateEngine.gs` | The Google Doc mechanics: duplicating the template, removing unchecked Section-3 blocks, renumbering the rest, replacing every `{{PLACEHOLDER}}`. |
| `ProposalGenerator.gs` | The three menu actions (`New Proposal`, `Generate Proposal`, `Open Generated Proposal`) — orchestration only. |
| `Menu.gs` | `onOpen()` — builds the custom menu. |
| `appsscript.json` | Project manifest (timezone, V8 runtime). |

Each file has exactly one job. If you're looking for "why did a field come out
blank," start in `TemplateEngine.gs`; if you're looking for "why did
validation reject this row," start in `Validation.gs`.

## How Section 3 stays valid no matter what's unchecked

The template does **not** use static "3.1 / 3.2 / ..." text. Instead, each
service's heading paragraph is authored with two invisible control tokens:

```
{{SEC:RECRUITMENT}}{{NUM:RECRUITMENT}} Recruitment & Selection – ({{EMPLOYEES_TO_HIRE}} Positions During The Contract)
```

- `{{SEC:KEY}}` marks where a block starts. A block runs from that heading to
  the next `{{SEC:...}}` heading (or to Section 4), so no separate "end
  marker" is needed.
- `{{NUM:KEY}}` is where the assigned number goes.

At generation time, `TemplateEngine.applySection3_`:
1. Deletes every block whose checkbox is unchecked (heading + description +
   its table, structurally removed — not just hidden).
2. Walks the **same fixed order** defined in `SERVICE_REGISTRY` and assigns
   `3.1, 3.2, 3.3…` only to what's left.

Because the registry order never changes, "Benefits unchecked" always
produces `3.1 Recruitment, 3.2 Onboarding, 3.3 Performance, 3.4 Employee
Relations, 3.5 Compensation, 3.6 Personnel` — never a gap, never a duplicate.

Two other places in the proposal that referenced the service list or count as
static text were made dynamic for the same reason: the "Sections 3.1 through
3.7" reference in Pricing Structure (`{{SECTION_RANGE}}`), and "the
engagement covers eight integrated HR operational functions"
(`{{SERVICE_COUNT_WORD}}`) — both would otherwise have gone stale the moment
a service was unchecked.

## Placeholders in the template

| Placeholder | Source | Notes |
|---|---|---|
| `{{CLIENT_NAME}}` | Sheet: Client Name | |
| `{{MONTH_YEAR}}` | Sheet: Month Year | Auto-filled by "New Proposal", e.g. "July 2026" |
| `{{EMPLOYEES_TO_HIRE}}` | Sheet: Employees To Hire | Only rendered if Recruitment is checked |
| `{{ONSITE_VISITS_PER_WEEK}}` | Sheet: Onsite Visits Per Week | |
| `{{MONTHLY_FEE}}` / `{{CURRENCY}}` | Sheet: Monthly Fee / Currency | Pricing table |
| `{{SERVICE_SCOPE_LIST}}` | Computed | Pipe-separated list of checked services, e.g. `Recruitment & Selection \| Employee Onboarding \| Performance Management` |
| `{{SECTION_RANGE}}` | Computed | "Section 3.1" or "Sections 3.1 through 3.N" |
| `{{SERVICE_COUNT_WORD}}` | Computed | Spelled-out count of checked services ("six", "seven"...) |
| `{{SEC:KEY}}` / `{{NUM:KEY}}` | Control tokens | Not real content — consumed by `applySection3_`, never left in the final document |

### Extending it later (Commercial Terms, Prepared By, Contract Duration, etc.)

1. Add a column to the sheet and a matching entry in `Config.gs` → `COLUMNS`
   (and `SHEET_HEADERS` if it should exist by default on new sheets).
2. Add the `{{PLACEHOLDER}}` wherever it belongs in the Google Doc template.
3. Add one line to `TemplateEngine.buildPlaceholderMap_`.

No other file changes. This is deliberate — it's the whole reason
`Config.gs`/`ServiceRegistry.gs` are split out from the engine.

## Installation

### 1. Create the Google Sheet

1. Create a new Google Sheet (or use an existing one).
2. Rename its first tab to **Proposals** (or change `CONFIG.SHEET_NAME` in
   `Config.gs` to match whatever you name it).
3. Leave row 1 empty — the script will write the header row for you the
   first time you run **New Proposal**. (If you'd rather set it up by hand,
   use these exact headers in this order: Client Name, Month Year,
   Recruitment, Employee Onboarding, Benefits Administration, Performance
   Management, Employee Relations, Compensation Administration, Personnel
   Administration, Employees To Hire, Onsite Visits Per Week, Monthly Fee,
   Currency, Generated Document URL, Status.)

### 2. Connect the Google Doc template

1. In Google Drive, upload **`Talent 360 - Proposal Template.docx`**
   (included alongside this project) and open it — Drive converts it to a
   native Google Doc automatically. Alternatively, right-click the uploaded
   file → **Open with > Google Docs**, then **File > Save as Google Docs**.
2. Skim the doc once: the highlighted-field placeholders from the original
   draft are now `{{CLIENT_NAME}}`, `{{MONTH_YEAR}}`, etc. The original
   branding, colors, header/footer, and images are untouched.
3. Copy the document ID from its URL:
   `https://docs.google.com/document/d/`**`THIS_PART`**`/edit`
4. Paste it into `CONFIG.TEMPLATE_DOC_ID` in `Config.gs`.

### 3. Install the script

1. In the Google Sheet, open **Extensions > Apps Script**.
2. Delete the default empty `Code.gs`.
3. Create each file listed in the table above (**File > New > Script file**
   for `.gs` files) and paste in the matching contents from this project.
4. Open the project's manifest via **Project Settings > Show
   "appsscript.json" manifest file in editor**, then replace its contents
   with this project's `appsscript.json`.
5. Save the project (a name like "Talent 360 Proposal Generator" is fine).

### 4. Authorize the script

1. Reload the Google Sheet. A **Proposal Generator** menu should appear
   after a few seconds.
2. Click **Proposal Generator > New Proposal**. Google will prompt for
   authorization the first time.
3. Click **Continue**, choose your account, then **Advanced > Go to
   [project name] (unsafe)** — this warning is normal for scripts you wrote
   yourself/that aren't published to the Marketplace. Click **Allow**.
4. The scopes requested are exactly what the code uses: edit this
   spreadsheet, create/edit Docs, and read/copy the template file in Drive.

## Testing walkthrough

1. **New Proposal** — click it. A new row appears with Month Year filled in
   (e.g. "July 2026"), all seven service checkboxes TRUE, Status = Draft,
   and Client Name / Employees To Hire blank.
2. Fill in **Client Name** (e.g. "Acme Corp") and **Employees To Hire**
   (e.g. 10). Leave all services checked.
3. Select that row and click **Generate Proposal**. You should see a success
   dialog, and the **Generated Document URL** / **Status** columns fill in
   (Status becomes "Generated").
4. Click **Open Generated Proposal** — the doc opens in a new tab. Confirm:
   - Cover page shows the client name and "July 2026".
   - Section 3 shows `3.1` through `3.7`, all seven services present.
   - Pricing Structure references "Sections 3.1 through 3.7" and lists all
     seven services.
5. **Test the renumbering**: go back to the sheet, create another New
   Proposal row, fill in Client Name, uncheck **Benefits Administration**,
   and Generate. In the resulting doc, confirm Section 3 now reads `3.1
   Recruitment, 3.2 Onboarding, 3.3 Performance Management, 3.4 Employee
   Relations, 3.5 Compensation Administration, 3.6 Personnel
   Administration` — no gap, no `3.7`, and the Benefits table is gone
   entirely (not just hidden).
6. **Test validation**: create a New Proposal row, leave Client Name blank,
   and click Generate — you should get a friendly dialog listing exactly
   what's missing, and no document should be created. Try again with
   Recruitment checked but Employees To Hire blank — same result, different
   message.
7. **Test single-service edge case**: uncheck everything except Recruitment
   and Generate. Confirm the doc shows "Section 3.1" (singular) rather than
   "Sections 3.1 through 3.1" in the Pricing paragraph.
