# Product Requirements

**Status:** Draft v0.1 · **Owner:** Product · **Last reviewed:** 2026-08-03

---

## How to read this

**Requirement IDs are stable and permanent.** `FR-QUAL-012` means the same thing
forever. Backlog items, tests, ADRs and commit messages reference IDs, never
headings or page numbers. Retired requirements are marked `WITHDRAWN`, never
deleted or renumbered.

**Priority is scoped to a release.** `MUST (v1)` is a commitment. `WON'T (v1)`
is a decision, and a useful one. Unqualified `MUST` is meaningless and is not
used here.

**`[OPEN: Q-nn]`** marks a genuine open decision, collected in the
[register](#open-questions-register) at the end. An open question has an owner
and a date, or it is not a question — it is a wish.

**Prefixes**

| Prefix | Area |
|---|---|
| `FR-PLAT` | Platform: metadata, tenancy, config |
| `FR-QUAL` | Prospecting & Qualification |
| `FR-REC` | Records: accounts, contacts |
| `FR-DEAL` | Deals, pipelines, revenue |
| `FR-ACT` | Activities, tasks, timeline |
| `FR-DOC` | Proposals, agreements, documents |
| `FR-IMP` | Import & data ingestion |
| `FR-VIEW` | Views, lists, filters, dashboards |
| `FR-AUTO` | Automation engine |
| `FR-INT` | Integrations & providers |
| `FR-SEC` | Permissions, audit, compliance |
| `NFR-*` | Non-functional |

---

## 1. Platform & metadata

The substrate. Everything else depends on these.

| ID | Requirement | Priority |
|---|---|---|
| FR-PLAT-001 | Every configurable object (field, pipeline, stage, activity type, view, role, automation, rule) is stored as **data**, not code. | MUST (v1) |
| FR-PLAT-002 | Every metadata object has a workspace-scoped UUID **and** a stable human-readable `key` unique within its workspace. External references — automations, imports, reports, API, exports — use the `key`. | MUST (v1) |
| FR-PLAT-003 | A metadata `key` is never reused after deprecation, even if the object is deleted from the UI. | MUST (v1) |
| FR-PLAT-004 | Metadata objects are **deprecated, not deleted**, when referenced by records or automations. Deletion is blocked with an explanation naming the referrers. | MUST (v1) |
| FR-PLAT-005 | Metadata changes are versioned with author, timestamp and diff. | MUST (v1) |
| FR-PLAT-006 | Publishing a metadata change that affects existing records shows an **impact preview** — how many records change, and how — before it is applied. | MUST (v1) — qualification rules; SHOULD (v1) — elsewhere |
| FR-PLAT-007 | Field definitions declare: type, label(s), required, default, validation, help text, `filterable`, `sortable`, `searchable`, visibility default. | MUST (v1) |
| FR-PLAT-008 | Supported field types: text, long text, number, currency, percent, date, datetime, boolean, single-select, multi-select, user, record reference, URL, email, phone, file, formula (read-only), rollup (read-only). | MUST (v1) except formula/rollup — SHOULD (v1) |
| FR-PLAT-009 | A workspace is provisioned from a versioned **seed template pack** containing all default metadata. The design partner's workspace uses the same mechanism any customer would. | MUST (v1) |
| FR-PLAT-010 | No service line, pipeline stage or activity type name appears as a string literal in application code. Enforced by a CI check. | MUST (v1) |
| FR-PLAT-011 | Workspace-level settings: base currency, timezone, locale, weekend days, fiscal year start, date display (Gregorian / Hijri / both). | MUST (v1) |
| FR-PLAT-012 | Every tenant-scoped table carries `workspace_id`, enforced by database row-level security rather than application discipline. | MUST (v1) |
| FR-PLAT-013 | A background job framework exists from Phase 1: queued, retryable, observable, with per-workspace concurrency limits. | MUST (v1) |
| FR-PLAT-014 | An internal event bus exists from Phase 1. Every domain mutation emits a typed event. | MUST (v1) |

---

## 2. Prospecting & qualification

The existing engine. **Preservation requirements are marked ⚑ — these describe
behaviour that works today and must not regress.** Full detail:
[08/01](08_MODULE_SPECIFICATIONS/01_PROSPECTING_AND_QUALIFICATION.md).

### 2.1 Preservation

| ID | Requirement | Priority |
|---|---|---|
| FR-QUAL-001 ⚑ | Three verdicts — `QUALIFIED`, `REJECTED`, `REVIEW` — are preserved as first-class platform values. REVIEW is never collapsed into REJECTED anywhere: not in filters, counts, dashboards, exports or the API. | MUST (v1) |
| FR-QUAL-002 ⚑ | REVIEW means *the available evidence cannot answer the question*. Absence of data must never be presented as a negative answer. | MUST (v1) |
| FR-QUAL-003 ⚑ | Expensive evidence collection is stored separately from rule evaluation, so re-running rules over collected evidence costs nothing and requires no network access. | MUST (v1) |
| FR-QUAL-004 ⚑ | Presence tests (offshoring) and absence tests (HCM) apply coverage gating in mirror directions: coverage gates the REJECT for presence tests, and the QUALIFY for absence tests. | MUST (v1) |
| FR-QUAL-005 ⚑ | Arithmetic bounds are computed before any absence conclusion. A conclusion is only drawn when the numbers prove it. | MUST (v1) |
| FR-QUAL-006 ⚑ | A qualified-list export preserves **every column of the source file**, in original order, byte-identical, filtered to qualified rows. Duplicate headers, blank headers, Arabic text, embedded commas and newlines all round-trip. | MUST (v1) |
| FR-QUAL-007 ⚑ | A company's verdict applies to every row referencing that company. | MUST (v1) |
| FR-QUAL-008 ⚑ | Collection is resumable and interruptible. Progress persists after every company; stopping loses nothing. | MUST (v1) |
| FR-QUAL-009 ⚑ | Collection is paced to a human-plausible rate. The pacing is not user-reducible below a safe floor. | MUST (v1) |
| FR-QUAL-010 ⚑ | Headcount known only as a range never drives a rejection where the true figure could clear the threshold, and never confirms a band it cannot prove. | MUST (v1) |
| FR-QUAL-011 ⚑ | Qualification runs entirely offline against collected evidence. | MUST (v1) |
| FR-QUAL-012 ⚑ | Existing offline test suites pass unmodified at every phase boundary, except where a requirement here deliberately changes behaviour. | MUST (v1) |

### 2.2 New

| ID | Requirement | Priority |
|---|---|---|
| FR-QUAL-020 | A **Verdict** is an immutable record: rule key, rule version, evidence reference, inputs hash, verdict, confidence, notes, computed-at. Re-running appends a new verdict; it never mutates an existing one. | MUST (v1) |
| FR-QUAL-021 | An account shows its current verdict, its history, and — when it changed — what changed it (rule version vs new evidence). | MUST (v1) |
| FR-QUAL-022 | Verdicts have a configurable **staleness threshold** (default 90 days). Age is always visible; stale verdicts are visually distinct and filterable. | MUST (v1) |
| FR-QUAL-023 | Publishing a rule change shows an impact preview: how many verdicts change, and the QUALIFIED→REJECTED transitions specifically. | MUST (v1) |
| FR-QUAL-024 | Qualification rules are authored in the UI by a non-technical admin: thresholds, signals, coverage gates, negative screens. | MUST (v1) |
| FR-QUAL-025 | Rules are workspace-scoped metadata. Multiple rules may exist per workspace, each bound to a service line. | MUST (v1) |
| FR-QUAL-026 | A company may hold independent verdicts from multiple rules. Verdicts are never merged into a single score. | MUST (v1) |
| FR-QUAL-027 | Every verdict displays its evidence: which signal, what it matched, what it contributes, from which provider and when. | MUST (v1) |
| FR-QUAL-028 | A REVIEW verdict offers a **resolution action** — what would settle it (collect more evidence, filter the source, answer manually). | SHOULD (v1) |
| FR-QUAL-029 | A rep may override a verdict with a reason. Overrides are recorded, never silent, and never overwrite the computed verdict. | MUST (v1) |
| FR-QUAL-030 | Override reasons are queryable as rule-tuning input. | SHOULD (v2) |
| FR-QUAL-031 | A qualified account can optionally auto-create a Deal seeded with the service line its rule targets. | SHOULD (v1) |
| FR-QUAL-032 | Rules can be tested against a sample before publishing, showing verdicts and reasoning per company. | SHOULD (v1) |
| FR-QUAL-033 | Companies that cannot be resolved to a collectable identity are `UNRESOLVED` — explicitly counted and visible, never silently dropped. | MUST (v1) |
| FR-QUAL-034 | Collection errors distinguish transient from permanent, with a retry policy for transient. | SHOULD (v1) |

---

## 3. Records — accounts & contacts

| ID | Requirement | Priority |
|---|---|---|
| FR-REC-001 | One `Account` object with a `lifecycle_stage` (`prospect`, `qualified`, `engaged`, `customer`, `churned`, `disqualified`). Prospects are excluded from default views. | MUST (v1) |
| FR-REC-002 | Account carries system fields (name, domain, LinkedIn, industry, headcount, country, commercial registration, owner, lifecycle stage) plus unlimited workspace-defined custom fields. | MUST (v1) |
| FR-REC-003 | Contacts belong to one account, with a role flag set (primary, decision maker, influencer, gatekeeper) rather than a single exclusive type. | MUST (v1) |
| FR-REC-004 | Every record has `external_id` supporting idempotent upsert. Re-importing the same source is a no-op, not a duplicate. | MUST (v1) |
| FR-REC-005 | Every record carries `data_source` and `acquired_at`. | MUST (v1) |
| FR-REC-006 | Configurable duplicate-match rules per object with a confidence score. Commercial Registration is a first-class matcher for Saudi entities. | MUST (v1) |
| FR-REC-007 | Merge is a first-class, **reversible** operation with a full audit trail, defining what happens to deals, activities, documents and verdicts. | MUST (v1) |
| FR-REC-008 | Soft delete everywhere, with a hard-delete job that also reaches evidence snapshots, caches, exports and generated documents. | MUST (v1) |
| FR-REC-009 | Ownership transfer, individually and in bulk, with an audit entry. | MUST (v1) |
| FR-REC-010 | Contacts store a lawful-basis / consent field. | MUST (v1) |
| FR-REC-011 | Subject-erasure operation locating a person across every object and copy. | MUST (v1) if selling into GDPR/PDPL jurisdictions — `[OPEN: Q-07]` |

---

## 4. Deals, pipelines & revenue

| ID | Requirement | Priority |
|---|---|---|
| FR-DEAL-001 | Multiple pipelines per workspace, each with its own ordered stages. | MUST (v1) |
| FR-DEAL-002 | Stages carry: key, label, order, probability, type (open/won/lost), required fields to enter, WIP limit. | MUST (v1) |
| FR-DEAL-003 | **Deal Line Items.** Each carries service line, pricing model, quantity, unit price, currency, recurrence, term, discount. | MUST (v1) |
| FR-DEAL-004 | Pricing models: one-time fixed, percentage-of-salary, per-seat recurring, per-headcount recurring, milestone-billed. Extensible as metadata. | MUST (v1) |
| FR-DEAL-005 | Deal value is **derived** from line items: one-time total, MRR, ARR, weighted pipeline value. Recurring and one-time revenue are never summed into one figure. | MUST (v1) |
| FR-DEAL-006 | Multi-currency with a workspace base currency; FX rate captured at close and stored on the record. | MUST (v1) |
| FR-DEAL-007 | Stage transitions may require fields, and may be restricted by role. | SHOULD (v1) |
| FR-DEAL-008 | Loss requires a reason from a configurable list. | MUST (v1) |
| FR-DEAL-009 | Stage-duration tracking for cycle-time and bottleneck reporting. | SHOULD (v1) |
| FR-DEAL-010 | A deal links to the qualification verdict(s) that originated it. | SHOULD (v1) |

---

## 5. Activities, tasks & timeline

| ID | Requirement | Priority |
|---|---|---|
| FR-ACT-001 | **Activity** (user-facing timeline) and **Audit Event** (immutable system log) are separate stores with separate retention. | MUST (v1) |
| FR-ACT-002 | Activity types are workspace metadata: key, label, icon, colour, fields, whether it is loggable manually. | MUST (v1) |
| FR-ACT-003 | Activities are editable and deletable by permitted users. Audit events are neither, ever. | MUST (v1) |
| FR-ACT-004 | Selected audit events project into the timeline (stage change, owner change, verdict change). Which ones is configurable. | MUST (v1) |
| FR-ACT-005 | Activities attach polymorphically to account, contact, deal, proposal or agreement, and roll up to the parent account timeline. | MUST (v1) |
| FR-ACT-006 | Tasks attach polymorphically, with assignee, due date & time, priority, status, reminder. | MUST (v1) |
| FR-ACT-007 | Due dates are stored UTC and rendered in the user's timezone. Automation date maths is explicit about timezone. | MUST (v1) |
| FR-ACT-008 | Task and reminder scheduling respects the workspace weekend (default Fri–Sat) and holiday calendar. | SHOULD (v1) |
| FR-ACT-009 | Timeline supports filtering by type, user and date range, with rich previews. | MUST (v1) |
| FR-ACT-010 | Notes support @mentions, which generate notifications. | SHOULD (v1) |
| FR-ACT-011 | Notification is a first-class object with per-user channel preferences (in-app, email). | MUST (v1) |

---

## 6. Proposals, agreements & documents

| ID | Requirement | Priority |
|---|---|---|
| FR-DOC-001 | Proposals belong to a deal and support immutable versioning; each version is separately viewable and diffable. | MUST (v1) |
| FR-DOC-002 | Proposal generation goes through a **Document Generation Provider** contract. Google Workspace is the first implementation, not a hardcoded dependency. | MUST (v1) |
| FR-DOC-003 | Proposal templates are workspace metadata with merge fields resolved from record data. | MUST (v1) |
| FR-DOC-004 | Agreements link to a deal (required) and zero or more proposals (optional). Standalone agreements are creatable. | MUST (v1) |
| FR-DOC-005 | `supersedes_agreement_id` models renewals and consolidations. | MUST (v1) |
| FR-DOC-006 | Agreements track signing status, signature dates, effective and expiry dates, renewal terms and notice periods. | MUST (v1) |
| FR-DOC-007 | Renewal and expiry dates generate configurable reminders. | MUST (v1) |
| FR-DOC-008 | Files are stored in object storage with signed, expiring URLs. Never database blobs. | MUST (v1) |
| FR-DOC-009 | E-signature integration via provider contract. | WON'T (v1) — design for it |

---

## 7. Import & data ingestion

| ID | Requirement | Priority |
|---|---|---|
| FR-IMP-001 | Wizard: upload → auto-map → review → duplicate check → preview → import → summary. | MUST (v1) |
| FR-IMP-002 | Column auto-mapping infers from **values**, not just header text, and reports confidence. | MUST (v1) |
| FR-IMP-003 | Mapping templates are saveable, named and reusable. | MUST (v1) |
| FR-IMP-004 | Import is idempotent on `external_id` — re-uploading the same file changes nothing. | MUST (v1) |
| FR-IMP-005 | Preview shows exactly what will be created, updated, skipped and rejected, with reasons, before anything is written. | MUST (v1) |
| FR-IMP-006 | Imports are transactional per batch and reversible for a configurable window. | SHOULD (v1) |
| FR-IMP-007 | CSV and Excel, UTF-8 with and without BOM, CRLF and LF, quoted fields with embedded delimiters and newlines, Arabic text. | MUST (v1) |
| FR-IMP-008 | Large imports run as background jobs with progress and a downloadable error report. | MUST (v1) |
| FR-IMP-009 | Import summary is retained and viewable later, not just shown once. | SHOULD (v1) |

---

## 8. Views, lists & dashboards

| ID | Requirement | Priority |
|---|---|---|
| FR-VIEW-001 | Unlimited saved views per object, private or shared, with layout, filters, sort and columns. | MUST (v1) |
| FR-VIEW-002 | View types: table, kanban, list, calendar, timeline, cards. | MUST (v1) — table & kanban; SHOULD (v1) — rest |
| FR-VIEW-003 | Nested AND/OR filter groups over system and custom fields. | MUST (v1) |
| FR-VIEW-004 | Table: sticky header, resizable / reorderable / hideable / pinnable columns, saved layouts, bulk select, inline edit. | MUST (v1) |
| FR-VIEW-005 | Bulk operations over a filtered set run as background jobs with progress and partial-failure reporting. | MUST (v1) |
| FR-VIEW-006 | Dashboards are widget-based with drag-drop and resize; layouts are saveable and shareable. | MUST (v1) |
| FR-VIEW-007 | Widgets are metadata-defined; adding a widget type requires no schema change. | MUST (v1) |
| FR-VIEW-008 | Reports support grouping, aggregation, and time comparison; exportable to CSV/Excel. | SHOULD (v1) |
| FR-VIEW-009 | Forecasting distinguishes one-time from recurring revenue and never sums them. | MUST (v1) |
| FR-VIEW-010 | Global search across objects, honouring permissions, with keyboard-first invocation. | MUST (v1) |

---

## 9. Automation

Detail in [10_AUTOMATION_ENGINE.md](10_AUTOMATION_ENGINE.md).

| ID | Requirement | Priority |
|---|---|---|
| FR-AUTO-001 | Rules are metadata: trigger, conditions, actions, enabled state, version. | MUST (v1) |
| FR-AUTO-002 | Triggers: record created/updated/deleted, field changed, stage changed, verdict changed, date reached, schedule, inbound webhook, manual. | MUST (v1) |
| FR-AUTO-003 | Actions: create/update record, create task, log activity, send notification, send email, call webhook, run qualification, assign owner. | MUST (v1) |
| FR-AUTO-004 | Loop protection: depth limit, per-record execution cap, cycle detection. | MUST (v1) |
| FR-AUTO-005 | Dry-run mode showing what would happen, without side effects. | MUST (v1) |
| FR-AUTO-006 | Full execution log: trigger, conditions evaluated, actions taken, errors. Retained and searchable. | MUST (v1) |
| FR-AUTO-007 | Automations reference metadata by stable `key`, never by UUID or label. | MUST (v1) |
| FR-AUTO-008 | Failed automations surface to an admin. Silent failure is prohibited. | MUST (v1) |

---

## 10. Integrations & providers

Detail in [11_INTEGRATIONS.md](11_INTEGRATIONS.md).

| ID | Requirement | Priority |
|---|---|---|
| FR-INT-001 | Every external data source implements a **capability contract** (company lookup, contact lookup, email finding, enrichment, document generation, storage). Business logic never names a vendor. | MUST (v1) |
| FR-INT-002 | Providers declare cost per unit. A run shows **estimated cost before execution**. | MUST (v1) |
| FR-INT-003 | Per-workspace spend budgets with soft warning and hard stop. | MUST (v1) |
| FR-INT-004 | Actual spend is tracked per provider, per run, per workspace, and reportable. | MUST (v1) |
| FR-INT-005 | Provider results are cached in the evidence store and attributed to their provider and fetch time. | MUST (v1) |
| FR-INT-006 | Waterfall enrichment: try providers in configured order until a result meets a confidence threshold. | SHOULD (v1) |
| FR-INT-007 | At least two implementations exist for any capability the product depends on, before that dependency ships. | SHOULD (v1) |
| FR-INT-008 | Browser-based LinkedIn collection is bring-your-own-session and self-hosted only. It is not offered as a hosted service. | MUST — see `[OPEN: Q-03]` |
| FR-INT-009 | Outbound webhooks on any internal event, with retry, signing and delivery log. | MUST (v1) |
| FR-INT-010 | Credentials are encrypted at rest, scoped per workspace, and never logged. | MUST (v1) |

---

## 11. Permissions, audit & compliance

Detail in [12_PERMISSION_MODEL.md](12_PERMISSION_MODEL.md).

| ID | Requirement | Priority |
|---|---|---|
| FR-SEC-001 | Roles are workspace metadata composed of action permissions. | MUST (v1) |
| FR-SEC-002 | Record scope per object: own / team / workspace. | MUST (v1) |
| FR-SEC-003 | Field-level visibility: every field definition has a default; roles may override per field. A newly created field inherits the object baseline and never leaks by default. | MUST (v1) |
| FR-SEC-004 | Export is a distinct permission from read. | MUST (v1) |
| FR-SEC-005 | Deny overrides allow. No implicit inheritance. | MUST (v1) |
| FR-SEC-006 | Immutable audit log of every mutation: actor, timestamp, object, before, after, source (UI/API/automation/import). | MUST (v1) |
| FR-SEC-007 | Audit covers permission changes, exports, logins, integration credential changes and automation publishes. | MUST (v1) |
| FR-SEC-008 | Configurable data retention per workspace. | SHOULD (v1) |
| FR-SEC-009 | Documented data residency. | `[OPEN: Q-02, Q-07]` |

---

## 12. Non-functional requirements

### Performance

| ID | Requirement | Budget |
|---|---|---|
| NFR-PERF-001 | List view, 50 rows, filtered on two custom fields | p95 < 500 ms at 100k records |
| NFR-PERF-002 | Record detail page | p95 < 300 ms |
| NFR-PERF-003 | Global search first results | p95 < 400 ms |
| NFR-PERF-004 | Qualification of 1,000 cached companies | < 5 s, no network |
| NFR-PERF-005 | Import of 10,000 rows | < 60 s as a background job |
| NFR-PERF-006 | Dashboard with 8 widgets | p95 < 1.5 s |
| NFR-PERF-007 | Load tested at 100k accounts / 500k contacts **in Phase 2**, not before launch | — |

### Reliability & operations

| ID | Requirement |
|---|---|
| NFR-OPS-001 | Automated daily backups with a tested, documented restore procedure. |
| NFR-OPS-002 | The evidence store is backed up independently — it is the most expensive asset to reacquire. |
| NFR-OPS-003 | Zero-downtime schema migrations; expand-contract, never destructive-in-place. |
| NFR-OPS-004 | Structured logging with workspace and request correlation IDs. |
| NFR-OPS-005 | Per-workspace job concurrency limits so one tenant cannot degrade another. |
| NFR-OPS-006 | Health checks and error alerting before the first external customer. |

### Security

| ID | Requirement |
|---|---|
| NFR-SEC-001 | TLS everywhere; encryption at rest for database and object storage. |
| NFR-SEC-002 | Row-level security enforcing tenant isolation at the database, not only in application code. |
| NFR-SEC-003 | Automated tenant-isolation tests in CI — attempt cross-workspace access and assert failure. |
| NFR-SEC-004 | Secrets in a managed store, never in source or environment files in the repo. |
| NFR-SEC-005 | Rate limiting per workspace and per user on API and expensive operations. |
| NFR-SEC-006 | Dependency vulnerability scanning in CI. |

### Internationalisation & accessibility

| ID | Requirement |
|---|---|
| NFR-I18N-001 | RTL layout is a v1 design-system constraint. Logical CSS properties only — no physical `left`/`right` in components. |
| NFR-I18N-002 | Bidirectional text renders correctly where Arabic names mix with Latin URLs and numbers. |
| NFR-I18N-003 | UTF-8 end to end: storage, import, export, generated documents, file names. |
| NFR-I18N-004 | Locale-aware sorting and search for Arabic. |
| NFR-I18N-005 | All user-facing strings externalised from day one, even while only English ships. |
| NFR-I18N-006 | Hijri dates displayable alongside Gregorian; workspace-configurable. |
| NFR-I18N-007 | Configurable weekend, default Fri–Sat, honoured in SLA, reminders and reporting periods. |
| NFR-A11Y-001 | WCAG 2.1 AA: keyboard operability, focus management, contrast, semantic markup, screen-reader labels. |
| NFR-A11Y-002 | Every interactive flow completable by keyboard alone. |

### Maintainability

| ID | Requirement |
|---|---|
| NFR-MNT-001 | Domain logic has no dependency on framework, database or transport. |
| NFR-MNT-002 | Qualification rule logic is pure and testable with no I/O — as it is today. |
| NFR-MNT-003 | Existing offline test suites run in CI and gate every release. |
| NFR-MNT-004 | Every module exposes a documented public interface; cross-module access goes through it. |
| NFR-MNT-005 | CI fails on hardcoded service-line, stage or activity-type literals outside seed data. |

---

## Appendix A — Requirements analysis

The full critical read of the original brief: contradictions, load-bearing gaps,
edge cases and opportunities.

### A. Contradictions in the brief

| # | Contradiction | Resolution |
|---|---|---|
| A1 | "Nothing hardcoded" vs "ship optimized for Recruitment / HCM / Offshoring / Strategy" | Service lines ship as a **seed template pack**, never code branches. CI-enforced (FR-PLAT-009, FR-PLAT-010). |
| A2 | "Everything versioned" stated once, honoured only for proposals | Three distinct mechanisms named separately: document revisions, config versions, record history (FR-PLAT-005, FR-DOC-001, FR-SEC-006). |
| A3 | `stage_id = 18` | Correct principle, dangerous example. Workspace-scoped UUIDs for joins + stable `key` for all external references (FR-PLAT-002). |
| A4 | "Multiple services" per deal vs one `estimated_value` | Deal Line Items; derived values; recurring never summed with one-time (FR-DEAL-003 → 005). |
| A5 | "Agreement belongs to one Proposal" | Too narrow for MSA/SOW, renewals, consolidations, inbound deals. Agreement → Deal required, → Proposals optional (FR-DOC-004, 005). |
| A6 | Phase order vs dependency graph — provider architecture *after* qualification; automation in Phase 9 while Phases 5–8 need it | Restructured in [14](14_DEVELOPMENT_ROADMAP.md): event bus in Phase 1, provider contract with qualification. |
| A7 | "Google Docs / Apps Script" inside a vendor-abstraction brief | Document Generation Provider contract (FR-DOC-002). |

### B. Load-bearing gaps

| # | Gap | Resolution |
|---|---|---|
| B1 | No storage strategy for custom fields | [05_DATABASE_DESIGN.md](05_DATABASE_DESIGN.md) — hybrid columns + JSONB, bounded index budget |
| B2 | Activities conflated with audit | FR-ACT-001 → 004 |
| B3 | Workspace / tenant / team undefined | [04](04_SYSTEM_ARCHITECTURE.md#decision-register) ADR-02; FR-PLAT-012 |
| B4 | Permissions named but not modelled — especially field-level over *user-defined* fields | [12_PERMISSION_MODEL.md](12_PERMISSION_MODEL.md); FR-SEC-003 |
| B5 | Personal data has no lifecycle (GDPR / PDPL) | FR-REC-005, 008, 010, 011; FR-SEC-008, 009 |
| B6 | No merge / dedupe / record-identity strategy beyond import | FR-REC-004, 006, 007 |
| B7 | Qualification module not connected to CRM records | FR-REC-001; FR-QUAL-031 |
| B8 | Arabic and RTL entirely absent from a Gulf-market product | NFR-I18N-001 → 007 |
| B9 | Integrations listed as vendors; no platform (API, webhooks, events) | [09_API_ARCHITECTURE.md](09_API_ARCHITECTURE.md); FR-INT-009 |
| B10 | Multi-currency, timezone, notifications, search strategy, rate limits, sandbox, bulk ops, failure states, attachment storage | Covered across §3–§12 |

### C. Edge cases

Drawn from the existing engine's real behaviour on real data, not hypotheticals.

| # | Case | Requirement |
|---|---|---|
| C1 | **A rule change silently rewrote 117 of 223 verdicts, 3 from QUALIFIED to REJECTED, with no record.** | FR-QUAL-020 → 023 |
| C2 | REVIEW will be under constant pressure to collapse into a binary | FR-QUAL-001, 002, 028 |
| C3 | Collection and rules must stay separable — this is what makes re-qualification free | FR-QUAL-003 |
| C4 | Company with no LinkedIn URL — currently dropped silently | FR-QUAL-033 |
| C5 | Several contacts at one company — verdict applies to all rows | FR-QUAL-007 |
| C6 | Company in list but never collected — excluded but counted | FR-QUAL-033 |
| C7 | Collection errors (2 of 223 today) — transient vs permanent | FR-QUAL-034 |
| C8 | Arabic and URL-encoded company slugs | NFR-I18N-002; regression fixtures |
| C9 | Re-upload of the same file | FR-IMP-004, FR-REC-004 |
| C10 | Headcount known only as a range | FR-QUAL-010 |
| C11 | A company qualifying for two service lines | FR-QUAL-026 |

### D. Opportunities

| # | Opportunity | Requirement |
|---|---|---|
| D1 | Evidence-based qualification instead of opaque scores | FR-QUAL-027 |
| D2 | Free ICP experimentation with impact preview | FR-QUAL-003, 023, 032 |
| D3 | Cost transparency and budgets on enrichment | FR-INT-002 → 004 |
| D4 | Disqualification feedback loop as ICP training data | FR-QUAL-029, 030 |
| D5 | Arabic-first B2B CRM for an under-served market | NFR-I18N-* |
| D6 | Natively multi-service deals | FR-DEAL-003 → 005 |

### E. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | LinkedIn collection terms — acceptable internally, a different position when sold | FR-INT-008; `[OPEN: Q-03]` |
| R2 | Metadata-driven becomes unusably slow | NFR-PERF-001 → 007 |
| R3 | Scope — several years of work for a small team | Ruthless v1 in [14](14_DEVELOPMENT_ROADMAP.md) |
| R4 | The working tool breaks during refactor | FR-QUAL-012; strangler-fig phasing |
| R5 | Provider pricing or access changes | FR-INT-007 |
| R6 | `snapshots.json` is a single unbacked file holding the expensive asset | NFR-OPS-002 — **back up today** |

---

## Open questions register

| ID | Question | Blocks | Owner | Due |
|---|---|---|---|---|
| **Q-01** | Is v1 single-tenant-deployed or multi-tenant from day one? | All schema work, ADR-02 | — | — |
| Q-02 | Which markets and jurisdictions will be sold into? | FR-SEC-009, data residency | — | — |
| **Q-03** | Will the hosted product offer LinkedIn-derived data, or only BYO-session self-hosted? | FR-INT-008, prospecting roadmap | — | — |
| **Q-04** | Expected scale at 12 months — accounts, contacts, users, workspaces? | Storage strategy, infra | — | — |
| Q-05 | Arabic UI in v1, or only RTL-capable layout? | Design system, translation pipeline | — | — |
| Q-06 | Google Workspace only, or must Microsoft 365 be supported? | FR-DOC-002 | — | — |
| Q-07 | Target compliance regime — GDPR, PDPL, both? | FR-REC-011, FR-SEC-008/009 | — | — |
| Q-08 | Is SSO/SAML needed for the target buyer? | Phase 1 auth build-vs-buy | — | — |
| Q-09 | Is there a second design partner besides the consultancy? | Prioritisation, template pack design | — | — |
| **Q-10** | Actual v1 deadline and team size? | All of [14](14_DEVELOPMENT_ROADMAP.md) | — | — |

**Bold questions block implementation.** The rest can be resolved during Phase 1
without rework.
