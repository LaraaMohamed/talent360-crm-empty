# Import Engine

**Status:** Partially exists · **Phase:** 2 · **Depends on:** platform, records, jobs

---

## 1. Purpose

Get data in without losing, duplicating or mangling it — and tell the user
exactly what will happen before it happens.

The brief calls this "probably the most polished page". Correct: it is the first
thing an evaluator tries and the first thing that loses their trust.

---

## 2. Current state

Working today in `local-scraper/`, and better than most commercial importers in
three specific respects. **These must not regress.**

| Behaviour | Status |
|---|---|
| Column detection from **values, not header text** — finds "Company LinkedIn" and correctly ignores "Personal LinkedIn" | ⚑ Works, reports confidence |
| **Byte-identical round-trip** — duplicate headers, blank headers, Arabic, embedded commas and newlines, doubled quotes, BOM | ⚑ Works, verified |
| **Pre-flight before commitment** — row/column/company counts, how many already collected, estimated time | ⚑ Works |
| CSV parsing: CRLF/LF, quoted fields, UTF-8 with and without BOM | ⚑ Works |
| Rows kept as arrays, never objects keyed by header | ⚑ Deliberate — an object silently drops duplicate columns |

Missing: Excel, mapping templates, duplicate detection, upsert, rollback,
background execution, persistent summaries.

---

## 3. The flow

```
1  Upload         Local parse first. Counts shown before any network call.
2  Profile        Detect delimiter, encoding, header row, column types, company column
3  Map            Auto-mapped with confidence; user adjusts; saveable as a template
4  Validate       Per-row type and rule validation; errors previewed, not thrown
5  Deduplicate    Match against existing records; user chooses update / skip / create
6  Preview        Exact counts: create · update · skip · reject, with reasons
7  Execute        Background job, progress, cancellable, resumable
8  Summarise      Persistent record, downloadable error report, undo window
```

**Steps 1, 2 and 6 are where trust is won.** Every competitor makes the user
commit before revealing consequences. Showing "1,847 create · 12 update ·
3 reject (missing required field)" before anything is written is a small feature
with outsized effect — and it already exists in the current UI.

---

## 4. Configuration surface

Mapping templates (named, reusable, per object) · duplicate-match rules and
thresholds · default values for unmapped required fields · value transformations
(trim, case, phone and date formats) · picklist auto-creation policy · undo
window.

---

## 5. Behaviour

- **Idempotent on `external_id`** (FR-IMP-004). Re-uploading the same file
  changes nothing. Without this, "re-upload the corrected file" doubles the
  database — the single most common CRM data disaster.
- **Transactional per batch**, reversible for a configurable window (FR-IMP-006)
- Large imports are background jobs with progress and a downloadable error
  report (FR-IMP-008)
- Partial success is normal and reported precisely — never all-or-nothing on a
  10,000-row file
- Summaries are retained and revisitable, not shown once and lost (FR-IMP-009)
- Every imported record carries `data_source` and `acquired_at` (FR-REC-005)
- Import runs under the importing user's permissions — an import cannot write
  fields the user cannot see

---

## 6. Interfaces

**Offers:** profile file, suggest mapping, save/load template, validate, preview,
execute, undo, fetch summary.

**Emits:** `import.started/completed/failed`, `record.imported`,
`duplicate.detected`.

**Consumes:** field definitions and match rules from platform and records.

---

## 7. UI surfaces

Drop zone with instant local parse · **pre-flight summary panel** · mapping table
with confidence indicators and sample values · duplicate review · preview with
per-reason counts · progress with live counters · persistent summary with error
download.

The mapping table should show **three sample values per column** beside the
suggested target. Users verify mapping by recognising data, not by reading
header names.

---

## 8. Edge cases

Most of these are already handled and must stay handled.

| Case | Behaviour |
|---|---|
| Duplicate header names | ⚑ Preserved; both columns mappable independently |
| Blank header | ⚑ Preserved, addressable positionally |
| Embedded newline in a quoted field | ⚑ Parsed correctly, round-trips |
| Arabic text and RTL content | ⚑ Preserved through import and export |
| BOM present or absent | ⚑ Both handled; BOM written on export for Excel |
| CRLF and LF mixed | ⚑ Both handled |
| Trailing blank line | ⚑ Ignored, not imported as an empty row |
| File with headers only | Accepted; reports zero rows rather than erroring |
| Column mapped to a deprecated field | Blocked with explanation |
| Value not in a picklist | Configurable: reject, create option, or set null |
| Required field missing for some rows | Those rows rejected with reasons; the rest import |
| Same file uploaded twice | No-op (FR-IMP-004) |
| 500,000-row file | Streamed, chunked, never fully in memory; hard cap with clear message |
| Encoding is not UTF-8 | Detected, converted, flagged in the summary |
| Numeric-looking IDs with leading zeros | Preserved as text — never coerced to number |
| Excel dates as serial numbers | Detected and converted with the ambiguity flagged |
| Cancel mid-import | Committed batches stay; the rest is not applied; summary reflects reality |

---

## 9. Acceptance criteria

- [ ] Column detection uses values, not header text, and reports confidence (FR-IMP-002) ⚑
- [ ] Round-trip is byte-identical for duplicate headers, blank headers, Arabic, embedded newlines and doubled quotes (FR-QUAL-006) ⚑
- [ ] Pre-flight shows counts and estimated cost/time before commitment ⚑
- [ ] Re-uploading the same file is a no-op (FR-IMP-004)
- [ ] Preview counts exactly match what execution does (FR-IMP-005)
- [ ] Mapping templates are saveable and reusable (FR-IMP-003)
- [ ] 10,000 rows import in under 60 s as a background job (NFR-PERF-005)
- [ ] Partial failure reports every rejected row with a reason (FR-IMP-008)
- [ ] Summaries are retrievable after the fact (FR-IMP-009)
- [ ] Import cannot write fields the importing user cannot see
