# 10. Automation → CRM port map (Phase 1–2 inspection)

Inspection of `Automation/` completed **2026-08-07**, before any code was
written. Everything below was verified against the source files and the `.docx`
binaries, not inferred from names.

## What is actually in `Automation/`

Three Apps Script projects, not one:

| Project | Status | What it is |
|---|---|---|
| `HCM/apps-script/` | superseded | The original HCM **proposal-only** generator, sheet-row driven. |
| `HCM/apps-script-offshoring/` | superseded | The same shape for the Offshoring proposal. |
| **`HCM/apps-script-dms/`** | **authoritative** | The Document Management System that replaced both: Opportunity-centric, 4 document types, versioning, history, validation, settings, OCR import. |

`HCM/apps-script-dms/apps-script-dms/` is an **older nested copy** of the same
project (smaller `Config.gs`, `UI.gs`, no `OcrService`/`CommercialRegistrationService`).
`apps-script-dms.zip` is a snapshot of it. The port follows the **outer**
`apps-script-dms/` only; the rest is history.

Also present and unrelated to documents: `HCM/apify-linkedin-people-insights/`
(a LinkedIn scraper actor).

## Templates and their placeholders (verified by reading the OOXML)

| Template | Tokens | Dynamic blocks |
|---|---|---|
| `Talent 360 - Proposal Template.docx` | 23 distinct, 26 occurrences | 7 service blocks, `3.N` numbering, terminal boundary `4. Service Delivery Team` (child 68 of 110) |
| `Talent 360 - HCM Agreement Template.docx` | 28 distinct, 30 occurrences | 7 service blocks, `N.` numbering, Arabic terminal boundary at child 122 of 254 |
| `T360 - Offshoring_Payroll Proposal Template.docx` | `{{CLIENT_NAME}}` ×3, `{{MONTH_YEAR}}` | none |
| `T360 - Offshoring Agreement Template.docx` | 9 distinct | none |

**Two facts that make a faithful port practical:**

1. **No token is split across runs** in any of the four templates. Every
   `{{TOKEN}}` sits inside a single `<w:r>`, so placeholder replacement is a
   plain text substitution inside `word/document.xml` — no run-merging, and
   every font, colour, header, footer, image and table is preserved byte for
   byte because nothing else in the package is touched.
2. **A block is a contiguous run of body children.** `{{SEC:KEY}}` is in a
   heading `<w:p>`; the block continues through following `<w:p>` and `<w:tbl>`
   children until the next `{{SEC:` paragraph or the type's
   `terminalBoundaryText`. Removing a block = deleting those sibling elements.

## The generation pipeline, as implemented

`DocumentEngine.generateDocument_` — the single path all four types take:

```
getSetting_(templateSettingKey)      → the template
duplicateTemplate_(id, name)         → copy into output folder
applyDynamicBlocks_(body, cfg, svcs) → delete disabled blocks, renumber survivors
buildPlaceholderMap(opp, fields, svcs) → the type's own map
applyPlaceholders_(body, map)        → replace every {{KEY}}
doc.saveAndClose() → url
```

File name: `Talent360 - {Company} - {docType.label}`, with `/\:*?"<>|` replaced
by `-`. Deliberately the **English** Opportunity company name even for the
Arabic agreements, so Drive stays scannable.

## Document types, fields, and where the CRM would get them

`resolveFirstParty_` supplies all agreement first-party values from the
Opportunity's imported Commercial Registration, with the Arabic certificate name
taking precedence over the English company name.

### HCM Proposal — `{{...}}` → source

| Placeholder | Automation source | CRM source (proposed) |
|---|---|---|
| `CLIENT_NAME` | Opportunity `Company` | `accounts.name` |
| `MONTH_YEAR` | `formatMonthYear_(new Date())`, `MMMM yyyy`, tz `Africa/Cairo` | same, computed at generation |
| `EMPLOYEES_TO_HIRE` | form field, required **iff** Recruitment enabled | **new field** — no CRM equivalent |
| `ONSITE_VISITS_PER_WEEK` | form field, default from Settings | **new field** |
| `MONTHLY_FEE` | form field, one number | **decision needed** — the CRM has no single amount, only line items |
| `CURRENCY` | form field, default from Settings | `deals.currency` |
| `SERVICE_SCOPE_LIST` | enabled service `labelEn`, joined ` \| ` | derived from the new service selection |
| `SECTION_RANGE` | `Section 3.1` / `Sections 3.1 through 3.N` | same function |
| `SERVICE_COUNT_WORD` | `COUNT_WORDS_EN[n]` (`zero`…`seven`) | same table |
| `{{SEC:*}}`/`{{NUM:*}}` | control tokens, never left in output | same |

### HCM Agreement — additionally

`AGREEMENT_DATE` (always today, `dd/MM/yyyy`, Cairo — never user-entered),
`START_DATE`, `END_DATE` (`dd/MM/yyyy`), `CONTRACT_DURATION_TEXT` (Arabic, from
Settings default), `SERVICE_SCOPE_LIST_AR` (`labelAr`), and from the CR:
`CLIENT_NAME` (Arabic name wins), `COMMERCIAL_REGISTRATION`,
`REPRESENTATIVE_NAME`, `COMPANY_ADDRESS`.

### Offshoring Proposal

`CLIENT_NAME` + `MONTH_YEAR` only. No form fields at all.

### Offshoring Agreement

`CLIENT_NAME`/CR trio + `MONTHLY_FEE` + `CURRENCY` (Arabic word) + `START_DATE`
/ `END_DATE` — these two formatted as **Arabic prose** (`1 أبريل 2026م`) by
`formatArabicDate_`, not `dd/MM/yyyy`. Different from the HCM Agreement, and the
difference is deliberate.

## Calculations that exist — and the ones that do not

Verified: the entire automation contains **no subtotal, no discount, no tax, no
line items, and no totals**. `MONTHLY_FEE` is a single number typed into the
wizard and printed. The only computed values in the whole system are:

- `computeContractEndDate_` — start + N years − 1 day (inclusive term; the leap
  case is handled by JS date normalisation and is commented as intentional)
- `buildSectionRange_`, `buildServiceScopeList_`, `COUNT_WORDS_EN[n]`
- the date formatters (`formatMonthYear_`, `formatDate_`, `formatArabicDate_`,
  `todayInConfiguredTimezone_`)
- `generateNextId_` — `OPP-00001` / `DOC-00001`, zero-padded to 5
- version = count of existing rows for (Opportunity, document type) + 1

The task brief's example mapping (`subtotal → discount → tax → total`) has no
counterpart in the source system. Per the brief's own rule — do not invent
calculations — none will be added.

## Versioning and history, as implemented

Every generation appends; nothing is overwritten. Version counters are **per
(Opportunity × document type)**, so an HCM Proposal at v2 and an HCM Agreement at
v1 coexist. Each version row snapshots the field values *and* the CR-sourced
values used at that moment, so re-importing a certificate later cannot rewrite
what an already-issued agreement said. A slim cross-cutting `Documents` sheet
indexes every version with `Generated Date`, `Generated By`, URL and status.

Status vocabulary is small: `Draft`, `Generated`, `Error`. **Nothing in the
automation ever sets a document to Signed** — consistent with the brief's rule.

## Validation, as implemented

- environment: template ID set, required sheets exist
- opportunity: `Company` non-empty; `Product` ∈ {HCM, Offshoring}
- services: at least one HCM service enabled
- fields: `required`, or `requiredIf(enabledKeys)` (Employees To Hire only when
  Recruitment is on); numbers must parse
- CR-backed types: a certificate must be imported **and** carry a representative
  name — because the representative signs ("ويمثلها قانوناً السيد /")

All failures are collected and shown as a list; no document is created.

## What has no CRM equivalent today

| Automation concept | CRM today | Verdict |
|---|---|---|
| Opportunity | `deals` (+ `accounts`) | maps, with care — CRM deals are richer |
| Product HCM / Offshoring | `service_lines` (`hcm`, `offshoring`, …) | maps |
| HCM Service Selection (7 booleans, per Opportunity) | — | **new table** |
| Commercial Registration (Arabic name, CR number, representative, address, OCR confidence, source file) | — | **new table** |
| Employees To Hire / Onsite Visits / Validity Days / Contract Duration Text | — | **new fields** |
| Monthly Fee (one number) | line items in four pricing models | **semantic conflict** |
| Settings: template IDs, defaults | `settings` table | maps |
| Documents index | `documents` + `proposals`/`proposal_versions`/`agreements` | reuse, do not duplicate |
| Google Doc output | `data/storage` + signed URLs | maps |
| OCR import of CR certificates | — | **new integration** |

## Defect found: HCM Agreement numbering does not match its own reference draft

`applyDynamicBlocks_` assigns numbers by walking `SERVICE_REGISTRY` order and
replacing each service's own `{{NUM:KEY}}` token wherever it physically sits.
That is correct **only if the template's block order matches the registry
order**. It does for the HCM Proposal. It does **not** for the HCM Agreement:

| | Order |
|---|---|
| `SERVICE_REGISTRY` | Recruitment, Onboarding, **Benefits, Performance, Relations, Compensation, Personnel** |
| HCM Agreement template blocks | Recruitment, Onboarding, **Personnel, Compensation, Benefits, Performance, Relations** |
| Numbers the script therefore prints | 1, 2, **7, 6, 3, 4, 5** |
| `Draft - HCM Agreement (1).docx` (the authored reference) | 1, 2, **3, 4, 5, 6, 7** |

So with all seven services enabled, the current script produces an agreement
whose Arabic articles read 1، 2، 7، 6، 3، 4، 5 — while the hand-authored draft
the template was built from reads 1–7 in order. The HCM Proposal is unaffected
(3.1–3.7 matches its draft exactly).

The project README claims this case renders "١.–٦. running cleanly with no gap",
which is inaccurate on two counts: the numerals produced are Western
(`n => n + '.'`), and the sequence is out of order.

This is the one place where "reproduce the existing behaviour exactly" and
"reproduce the existing document exactly" give different answers.

## Second defect, same document: `1..`

Found while running the ported engine against the real template. Every Arabic
heading is authored with the period already in place:

```
{{SEC:RECRUITMENT}}{{NUM:RECRUITMENT}}. التوظيف والاختيار
```

and the registry's `numberFormat` for that type is `n => n + '.'`. The two
combine to print **`1..`**, `2..`, `3..`. The authored draft reads `1.`, `2.`,
`3.`. Confirmed against all seven headings in the template.

## Decisions taken before implementation

| Question | Decision |
|---|---|
| Numbering | **Number by document order**, matching the authored draft. Identical to the Apps Script for the HCM Proposal (its orders agree); fixes the Agreement. |
| `1..` | `numberFormat` returns the bare number for the HCM Agreement — the template supplies the period. |
| `MONTHLY_FEE` | Prefilled from the deal's recurring MRR via `lib/money.mjs` when unambiguous, shown in the form, user-correctable. No new calculation invented. |
| Commercial Registration | Modelled and validated now; the OCR certificate import is a documented follow-up, not in this pass. |
| Output | `.docx` only, matching what the automation effectively produces. No PDF. |

Both defects should be fixed in the Apps Script too, or the two systems will
disagree for as long as both are in use.

## Built so far

| | |
|---|---|
| `lib/docx.mjs` | ZIP read/write over `node:zlib`. Unmodified parts are copied as their original compressed bytes. |
| `lib/docx-template.mjs` | The `DocumentEngine.gs` port: block removal, document-order renumbering, placeholder replacement, split-token refusal, leftover-token reporting. |
| `lib/document-types.mjs` | The `DocumentTypeRegistry.gs` + `Helpers.gs` port: 4 document types, 7 services, validation, date/format helpers, file naming. |
| `test.mjs` §15 | 24 checks: 17 unit, 7 regression against the real templates and the authored drafts. |

**Proven, not asserted:** rendering the HCM Proposal and re-packing it leaves
**29 of 30 parts byte-identical** to the template — only `word/document.xml`
differs. Fonts, images, styles, theme, header and footer are never decoded, so
they cannot drift.

## The Opportunity maps to the ACCOUNT, not the deal (2026-08-09)

The first CRM-facing pass mapped the automation's Opportunity onto `deals`,
because an Opportunity has a pipeline stage and a deal has a pipeline stage. The
result did not work in practice, and the reason is worth recording:

- **Every route was `/api/deals/:id/…`.** Generation was unreachable without a
  deal, and this workspace has 378 accounts and one deal. There was no button on
  the account page at all.
- **No template was ever installed**, so even the deal that did exist ended at
  "No templates installed" — a dead end indistinguishable from a broken feature.
- `document_generations.deal_id` was `NOT NULL`, and versions counted per deal,
  so one client's second proposal written from a different deal would have been
  a second "v1".

Everything a proposal needs — the company name, the commercial registration, the
services bought, the contacts — is a fact about the **company**. The Opportunity
was the only record the Apps Script had; it is not the closest thing the CRM has.

| Automation | Now maps to | Was |
|---|---|---|
| Opportunity | `accounts` | `deals` |
| Product HCM / Offshoring | `accounts.services` (service-line keys) | `deals.service_line_key` |
| HCM Service Selection row | `hcm_service_selections` per (account, deal-or-`''`) | per deal |
| Documents sheet | `document_generations`, versioned per (account, type) | per (deal, type) |

A deal is now **optional context**: pass one and the generation is recorded
against it and its own scope selection wins, falling back to the account's.
`apply-account-documents.mjs` migrates an existing database;
`install-templates.mjs` registers the four `.docx` files.

## Added beyond the automation: the variable map

The Apps Script's wizard asked for the form fields and generated. There was no
way to see, beforehand, what the other twenty-odd placeholders would resolve to —
you generated the document and opened it to find out.

`describeVariables` (lib/document-types.mjs) declares, per document type, where
each placeholder comes from: the account, the commercial registration, the scope
selection, a form field, or a computation. `previewGeneration` runs the **same**
`buildPlaceholders` the generation runs and annotates its output, so the review
table is the document's actual contents rather than a second opinion about them.
A test asserts the two agree in both directions, so a new placeholder cannot
reach a user as an undescribed row.

This adds no business rule. Every value shown is one the automation already
produced.

## Money is printed grouped (2026-08-09)

`MONTHLY_FEE` reached the document exactly as typed, so a fee entered as
`52000` printed as `52000`. The authored drafts read `45,000` — in the Apps
Script that happened by accident, because the fee was typed into a Sheets cell
already carrying the comma and printed verbatim. A number field cannot hold one.

`formatAmount` now groups the value in threes at the point it becomes document
text. The **raw number is still what is stored** in the generation's `fields`,
so regenerating prefills a number rather than text, and validation accepts a fee
pasted in as `45,000`. It is a format, not a currency: the currency is its own
placeholder, and two templates want an Arabic word rather than a symbol. Western
digits in every locale, because the Arabic agreements are authored that way
throughout and a locale-aware format would make one paragraph disagree with the
rest of its own contract.

## Not built yet

OCR import of commercial-registration certificates (they are typed by hand), and
a Settings panel for the `doc_default_*` values — they are honoured today but can
only be changed through `PATCH /api/settings`.
