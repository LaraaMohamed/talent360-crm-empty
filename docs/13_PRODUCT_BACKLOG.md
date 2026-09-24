# Product Backlog

**Status:** Draft v0.1 · **Owner:** Product · **Last reviewed:** 2026-08-03

---

## How this works

| Field | Meaning |
|---|---|
| **ID** | Stable, permanent. Referenced by commits, branches and tests. |
| **Priority** | `P0` blocks the release · `P1` important, deferrable · `P2` valuable later |
| **Status** | `Planned` · `In Progress` · `Done` · `Blocked` · `Deferred` |
| **Phase** | Target phase from [14](14_DEVELOPMENT_ROADMAP.md) |
| **Deps** | Backlog IDs that must complete first |
| **Req** | Requirement IDs from [02](02_PRODUCT_REQUIREMENTS.md) |

**P0 means the release does not ship without it.** If everything is P0, nothing
is. Current P0 count is deliberately small.

Acceptance criteria are written as checkable statements. "Works well" is not one.

---

## Phase 0 — Safety net

Nothing is built on top of an unbacked single file.

### B-001 · Back up the evidence store · **P0** · Planned · Phase 0
`snapshots.json` holds 223 collected companies — the most expensive asset in the
repository — with no backup.
**Deps:** none · **Req:** NFR-OPS-002
- [ ] Off-machine copy exists
- [ ] Restore verified by re-qualifying from the copy and matching current output
- [ ] Repeatable, documented, ideally scheduled

### B-002 · Promote existing tests to release gates · **P0** · Planned · Phase 0
36 offline checks exist and pass. They become the contract that protects the
working system through every refactor.
**Deps:** none · **Req:** FR-QUAL-012, NFR-MNT-003
- [ ] `test-signals.mjs` and `test-panels.mjs` run in CI
- [ ] A golden-output check re-qualifies the 223 known companies and asserts byte-identical results
- [ ] A failing gate blocks merge

### B-003 · Characterisation tests for current UI behaviour · **P0** · Planned · Phase 0
The upload→qualify→download flow has no automated test. It is the thing most
likely to break silently.
**Deps:** B-002 · **Req:** FR-QUAL-006, FR-QUAL-012
- [ ] End-to-end test: upload → qualify → download, asserting byte-identical export
- [ ] Fidelity cases covered: duplicate headers, blank header, Arabic, embedded newlines, doubled quotes, BOM
- [ ] Pre-flight counts asserted

---

## Phase 1 — Platform substrate

### B-010 · Tenancy foundation · **P0** · Blocked · Phase 1
**Blocked by `[OPEN: Q-01]`** — single-tenant or multi-tenant from day one.
**Deps:** none · **Req:** FR-PLAT-012, NFR-SEC-002/003
- [ ] `workspace_id` on every tenant-scoped table
- [ ] Row-level security enforced in the database
- [ ] CI test attempts cross-workspace access and asserts failure
- [ ] Repository layer scopes explicitly as well

### B-011 · Metadata engine — objects and fields · **P0** · Planned · Phase 1
**Deps:** B-010 · **Req:** FR-PLAT-001/002/007/008
- [ ] Object and field definitions stored as data
- [ ] Workspace-scoped UUID plus immutable `key` on every metadata object
- [ ] All field types from FR-PLAT-008 supported
- [ ] `filterable` / `sortable` / `searchable` flags exist and are enforced
- [ ] A field created by an admin appears in form, list, filter, API and import with no code change

### B-012 · Metadata versioning and deprecation · **P0** · Planned · Phase 1
**Deps:** B-011 · **Req:** FR-PLAT-003/004/005
- [ ] Every change versioned with author, timestamp and diff
- [ ] Deletion blocked while referenced, with referrers named
- [ ] Deprecation is a state; keys are never reused

### B-013 · Hybrid custom-field storage · **P0** · Planned · Phase 1
**Deps:** B-011 · **Req:** NFR-PERF-001
- [ ] Universal fields are typed columns; custom fields are JSONB
- [ ] Expression indexes generated for filterable/sortable fields
- [ ] Per-workspace index budget enforced with a clear message at the limit
- [ ] p95 < 500 ms filtering two custom fields at 100k records

### B-014 · Event bus · **P0** · Planned · Phase 1
Early on purpose — see [10 §1](10_AUTOMATION_ENGINE.md).
**Deps:** B-010 · **Req:** FR-PLAT-014
- [ ] Every domain mutation emits a typed event
- [ ] Subscribers registerable in-process
- [ ] Events carry actor, workspace, object, before/after

### B-015 · Background job framework · **P0** · Planned · Phase 1
**Deps:** B-010 · **Req:** FR-PLAT-013
- [ ] Durable queue, retry with backoff, progress, cancellation
- [ ] Per-workspace concurrency limits
- [ ] Jobs survive restart and resume

### B-016 · Audit log · **P0** · Planned · Phase 1
**Deps:** B-014 · **Req:** FR-SEC-006/007
- [ ] Immutable, partitioned by month
- [ ] No UPDATE/DELETE grant to the application role
- [ ] Covers mutations, exports, permission changes, logins, publishes

### B-017 · Authentication and workspace membership · **P0** · Planned · Phase 1
**Deps:** B-010 · **Req:** FR-PLAT-011
- [ ] Users are global identities with per-workspace memberships
- [ ] Permissions attach to the membership, never the user
- [ ] Workspace settings: currency, timezone, locale, weekend, fiscal year, date system

### B-018 · Permission model · **P0** · Planned · Phase 1
**Deps:** B-011, B-017 · **Req:** FR-SEC-001→005
- [ ] Action / record-scope / field-grant layers all enforced
- [ ] New fields inherit the object baseline and never leak
- [ ] Hidden fields absent from filters, search, export, API and webhooks
- [ ] Export is a separate permission
- [ ] Deny overrides allow

### B-019 · Design system foundation · **P0** · Planned · Phase 1
**Deps:** none · **Req:** NFR-I18N-001, NFR-A11Y-001
- [ ] Token set, light and dark
- [ ] Logical properties enforced by lint — no `left`/`right`
- [ ] Primitives and layout components from [07 §5](07_DESIGN_SYSTEM.md)
- [ ] Every component passes the [07 §10](07_DESIGN_SYSTEM.md) checklist

### B-020 · Seed template pack · **P1** · Planned · Phase 1
**Deps:** B-011, B-012 · **Req:** FR-PLAT-009/010
- [ ] Four service lines, pipelines, stages, activity types, roles, rules as seed data
- [ ] The design partner's workspace provisions from the same pack a customer would
- [ ] CI fails on service-line/stage/activity-type literals outside seeds

---

## Phase 2 — Qualification module migration

The strangler-fig phase. The working system keeps working throughout.

### B-030 · Evidence repository interface · **P0** · Planned · Phase 2
**Deps:** B-001 · **Req:** FR-QUAL-003
- [ ] Interface introduced; the JSON file is its first implementation
- [ ] Existing tests pass unchanged
- [ ] Golden-output check passes

### B-031 · PostgreSQL evidence store · **P0** · Planned · Phase 2
**Deps:** B-030, B-013 · **Req:** FR-QUAL-003
- [ ] Second implementation behind the same interface
- [ ] Dual-write with output comparison on every run
- [ ] Cutover, then retire the JSON writer
- [ ] Golden-output check passes at every step

### B-032 · Immutable versioned verdicts · **P0** · Planned · Phase 2
The 117-verdict incident.
**Deps:** B-031, B-012 · **Req:** FR-QUAL-020/021
- [ ] Verdict records rule key, rule version, evidence ref, inputs hash, computed-at
- [ ] Re-running appends; prior verdicts remain readable
- [ ] Account shows history and distinguishes "rule changed" from "evidence changed"

### B-033 · Rules as metadata · **P0** · Planned · Phase 2
**Deps:** B-011, B-032 · **Req:** FR-QUAL-024/025
- [ ] Existing HCM and offshoring rules expressed as seeded metadata
- [ ] Rule evaluation produces identical verdicts to the current code
- [ ] A non-technical admin creates a rule with no code

### B-034 · Rule impact preview · **P0** · Planned · Phase 2
**Deps:** B-033 · **Req:** FR-QUAL-023
- [ ] Publishing shows transition counts before applying
- [ ] QUALIFIED→REJECTED called out separately
- [ ] Affected accounts with open deals named

### B-035 · Accounts and contacts · **P0** · Planned · Phase 2
**Deps:** B-011, B-018 · **Req:** FR-REC-001→005
- [ ] Lifecycle stages; prospects hidden from default views
- [ ] `external_id`, `data_source`, `acquired_at` on every record
- [ ] Custom fields work end to end

### B-036 · Verdict UI · **P0** · Planned · Phase 2
**Deps:** B-032, B-019 · **Req:** FR-QUAL-022/027/028/029
- [ ] Verdict panel: checks with numbers, evidence quoted, rule version, age
- [ ] Stale verdicts visually distinct and filterable
- [ ] Every REVIEW offers a resolution action
- [ ] "Disagree?" captures a reason without overwriting the computed verdict

### B-037 · Provider contract + browser collector · **P0** · Planned · Phase 2
**Deps:** B-015 · **Req:** FR-INT-001/002/005
- [ ] Capability contract defined
- [ ] Existing collector wrapped as a provider, unchanged internally
- [ ] Resumability and pacing preserved
- [ ] Cost estimated before running

### B-038 · Retire the standalone UI · **P1** · Planned · Phase 2
**Deps:** B-036, B-039 · **Req:** —
- [ ] Every capability of the current UI exists in the platform
- [ ] Verified by the Phase 0 characterisation tests
- [ ] Only then is the standalone server retired

### B-039 · Import engine · **P0** · Planned · Phase 2
**Deps:** B-015, B-035 · **Req:** FR-IMP-001→009
- [ ] Full wizard flow
- [ ] Value-based column detection with confidence, preserved from current behaviour
- [ ] Byte-identical round-trip preserved
- [ ] Idempotent on `external_id`
- [ ] Preview counts exactly match execution
- [ ] 10,000 rows in under 60 s

---

## Phase 3 — Working CRM

| ID | Item | P | Deps | Req |
|---|---|---|---|---|
| B-050 | Activity and audit separation | P0 | B-016 | FR-ACT-001→004 |
| B-051 | Timeline with rollup | P0 | B-050 | FR-ACT-005/009 |
| B-052 | Tasks with timezone and weekend handling | P0 | B-015 | FR-ACT-006→008 |
| B-053 | Notifications with channel preferences | P0 | B-014 | FR-ACT-011 |
| B-054 | Saved views, filters, table | P0 | B-013 | FR-VIEW-001→005 |
| B-055 | Global search | P1 | B-013 | FR-VIEW-010 |
| B-056 | Duplicate detection and reversible merge | P0 | B-035 | FR-REC-006/007 |
| B-057 | Command palette | P1 | B-019 | — |
| B-058 | Seeded lifecycle automations | P0 | B-014 | FR-AUTO-001 |

---

## Phase 4 — Deals

| ID | Item | P | Deps | Req |
|---|---|---|---|---|
| B-070 | Pipelines and stages as metadata | P0 | B-011 | FR-DEAL-001/002 |
| B-071 | Deal line items and derived values | P0 | B-070 | FR-DEAL-003→005 |
| B-072 | Multi-currency with frozen close rate | P0 | B-071 | FR-DEAL-006 |
| B-073 | Kanban board | P0 | B-054 | FR-VIEW-002 |
| B-074 | Stage requirements and loss reasons | P1 | B-070 | FR-DEAL-007/008 |
| B-075 | Verdict → deal traceability | P1 | B-032, B-071 | FR-DEAL-010 |

---

## Phase 5 — Documents

| ID | Item | P | Deps | Req |
|---|---|---|---|---|
| B-090 | Document generation provider contract | P0 | B-037 | FR-DOC-002 |
| B-091 | Proposal templates and merge fields | P0 | B-090 | FR-DOC-003 |
| B-092 | Proposal versioning and diff | P0 | B-091 | FR-DOC-001 |
| B-093 | Agreements with supersession | P0 | B-092 | FR-DOC-004/005 |
| B-094 | Renewal and notice-period reminders | P0 | B-093, B-058 | FR-DOC-007 |
| B-095 | Object storage with signed URLs | P0 | — | FR-DOC-008 |

---

## Phase 6 — Insight

| ID | Item | P | Deps | Req |
|---|---|---|---|---|
| B-110 | Dashboard grid and widget framework | P0 | B-054 | FR-VIEW-006/007 |
| B-111 | Reports with grouping and aggregation | P1 | B-110 | FR-VIEW-008 |
| B-112 | Forecasting separating one-time from recurring | P0 | B-071 | FR-VIEW-009 |
| B-113 | Prospecting dashboard — verdict distribution, cost per qualified account | P1 | B-110 | D1, D3 |

---

## Phase 7 — Automation & platform

| ID | Item | P | Deps | Req |
|---|---|---|---|---|
| B-130 | Rule builder UI | P0 | B-058 | FR-AUTO-001→003 |
| B-131 | Dry run | P0 | B-130 | FR-AUTO-005 |
| B-132 | Loop protection and execution log | P0 | B-130 | FR-AUTO-004/006/008 |
| B-133 | Public REST API from metadata | P0 | B-011 | FR-INT-009 |
| B-134 | Outbound webhooks | P0 | B-014 | FR-INT-009 |
| B-135 | Waterfall enrichment and budgets | P1 | B-037 | FR-INT-003/006 |

---

## Deferred — with reasons

Saying no is what makes v1 shippable.

| Item | Why deferred | Revisit |
|---|---|---|
| AI layer | Requires a stable schema. AI over a moving data model produces confident nonsense and unpickable debt. | After Phase 6 |
| Email & calendar sync | Large surface, high maintenance. Activity is designed so a synced email is just an activity type. | v2 |
| E-signature | Provider contract exists; integration is not v1-critical | v2 |
| Mobile app | Responsive web covers the v1 use case | v2+ |
| Custom objects | Metadata engine supports it; UI and permission surface are significant | v2 |
| GraphQL | REST from metadata is sufficient; no client need | Only on demand |
| Plugin runtime | Webhooks and API cover extension until there is an ecosystem | v3 |
| Marketplace | Requires an ecosystem first | v3 |
| Territory management | Team scoping covers SMB needs | v2 |
| Multi-language UI | RTL-capable layout ships in v1; translation follows | `[OPEN: Q-05]` |
| Offline mode | Very high cost, low SMB demand | Not planned |
| Hosted LinkedIn collection | Legal position. See [11 §5](11_INTEGRATIONS.md) | `[OPEN: Q-03]` |

---

## Blocked

| ID | Item | Blocked by |
|---|---|---|
| B-010 | Tenancy foundation | `[OPEN: Q-01]` |
| — | Data residency design | `[OPEN: Q-02, Q-07]` |
| — | Hosted prospecting roadmap | `[OPEN: Q-03]` |
| — | Infrastructure sizing | `[OPEN: Q-04]` |
| — | Auth build-vs-buy | `[OPEN: Q-08]` |

Full register: [02 Open Questions](02_PRODUCT_REQUIREMENTS.md#open-questions-register).
