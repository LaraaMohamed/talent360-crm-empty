# Technical Review

**Reviewer stance:** CTO of an established CRM platform, evaluating this design
as if it had been proposed internally.
**Date:** 2026-08-03 · **Documents reviewed:** 00–14 · **Status:** Findings applied

---

## Verdict

The domain thinking is genuinely strong — the evidence/verdict separation and
the three-verdict model are better than what most commercial CRMs do, and the
brownfield preservation discipline is right.

**The platform engineering is not yet at the same standard.** Three findings are
product-ending if discovered after launch, and one of them is an internal
contradiction: the database design rejects an approach on a stated criterion,
then recommends a different approach that fails the same criterion.

| Severity | Count | Meaning |
|---|---|---|
| **S1** | 4 | Product-ending. Cannot proceed without resolution. |
| **S2** | 9 | Major rework if found late. |
| **S3** | 12 | Fix before scale or first enterprise customer. |
| **S4** | 8 | Quality and maintainability. |

All findings below have been applied to the documentation. Where a document
changed, the change is named.

---

## A · Data architecture

### A1 · S1 · Per-workspace expression indexes cannot work

**Claimed** ([05](05_DATABASE_DESIGN.md), original): custom fields in `JSONB`,
with expression indexes "generated per workspace, only for fields flagged
filterable/sortable, capped".

**Why this fails.** Two independent reasons, either of which is fatal:

*Index count.* PostgreSQL's planner considers every index on a table during
planning. Practical ceiling is roughly 30–50 indexes per table before planning
time and write amplification become the dominant cost. The proposal generates:

```
1,000 workspaces × 25 filterable fields = 25,000 partial indexes on `account`
```

That is 500× over the ceiling. It breaks at roughly **two dozen tenants**, not
at a thousand.

*DDL on user action.* Creating a field would issue `CREATE INDEX` against a
shared, multi-tenant table. `CONCURRENTLY` avoids the worst locking but requires
two full table scans, cannot run in a transaction, and can leave an invalid index
on failure. One tenant's admin adding a field degrades every other tenant.

**The contradiction.** The same document rejects "column per custom field" with
the reason *"DDL on user action, lock risk, column limits"* — and then
recommends per-workspace expression indexes, which is DDL on user action with
lock risk. The rejection criterion was correct; it was not applied consistently.

**Resolution — a three-tier model.** [05](05_DATABASE_DESIGN.md) rewritten.

| Tier | Storage | Purpose |
|---|---|---|
| 1 · System fields | Typed columns | Universal fields. Normal indexes, shared across all tenants. |
| 2 · Custom field values | `JSONB` `custom` column | **Source of truth** for every custom field. No slot limit. Never indexed per tenant. |
| 3 · Filter projection | **Fixed typed slot columns** — `n1..n24`, `s1..s48`, `d1..d12`, `b1..b8`, `u1..u8` | Written alongside JSONB for fields flagged filterable/sortable. Metadata maps field key → slot. |

Slot columns carry **shared composite indexes** — `(workspace_id, s1)`,
`(workspace_id, n1)` — created once at schema-migration time, never on user
action. One index serves all tenants using that slot. Index count is fixed at
~100 for the whole table regardless of tenant count.

This is the approach Salesforce arrived at for the same reason, and it is
boring, proven and operationally quiet.

**Costs accepted, and stated in the doc:** slot exhaustion (a per-object limit
that must be surfaced to admins), type changes requiring a slot move with a
backfill, and a projection that must be kept consistent with the JSONB source.
All three are bounded, testable problems. The original design's problem was not.

### A2 · S2 · No answer for filtering on non-projected fields

Fields not flagged filterable are still stored and displayed but cannot be
filtered. At small scale this is fine. At 100k+ records a user *will* want to
filter something un-projected, and "you cannot" is a bad answer.

**Resolution:** documented escalation path — promote the field to a slot (a
backfill job, previewed and estimated), or fall back to a scan with an explicit
row cap and a warning. Never silently slow.

### A3 · S2 · No table partitioning strategy beyond audit

Only `audit_event` was partitioned. `activity`, `verdict` and
`evidence_snapshot` all grow without bound and are all time-ordered.

**Resolution:** monthly range partitioning for `activity`, `verdict` and
`evidence_snapshot`; documented detach-and-archive policy per object.

### A4 · S3 · Verdict re-evaluation is not free at scale

Claimed in [08/01](08_MODULE_SPECIFICATIONS/01_PROSPECTING_AND_QUALIFICATION.md):
"re-qualifying costs nothing and takes seconds."

True for 223 companies in memory. At 1M accounts × 20 rules it is a serious batch
workload, and the impact-preview feature computes it **twice** — once for the
preview and once for the apply.

**Resolution:** re-evaluation is a job, not a request. Impact preview uses
**stratified sampling with a stated confidence interval** above a threshold set
size, and says so in the UI: *"estimated 1,180 ± 40 verdicts change, from a
5,000-account sample."* Full evaluation runs on apply. Wording corrected in
[08/01](08_MODULE_SPECIFICATIONS/01_PROSPECTING_AND_QUALIFICATION.md) — the
property that is genuinely free is *not re-collecting evidence*, which is the
valuable part and remains true.

### A5 · S3 · `payload_hash` uniqueness defeats change detection

`UNIQUE (workspace_id, subject_key, provider_key, payload_hash)` on evidence
means re-collecting identical data is rejected. But "we checked again on 1 Nov
and nothing had changed" is itself a fact, and the current design cannot record
it — so verdict staleness cannot be refreshed without a payload change.

**Resolution:** drop the unique constraint; add `last_seen_at`, updated on
identical re-collection. Storage is bounded and freshness becomes representable.

---

## B · Multi-tenancy and isolation

### B1 · S1 · RLS as specified breaks under connection pooling

Claimed: *"The connection sets `app.workspace_id` per request."*

Under PgBouncer in transaction mode — which any Postgres deployment at this scale
will use — a session-level `SET` leaks across tenants, because the server
connection is handed to a different client's transaction. **This is a
cross-tenant data leak, not a performance issue.**

**Resolution:** `SET LOCAL` inside the transaction only, never session-level.
Documented as a hard rule with a CI test that asserts a pooled connection does
not retain the setting. [05](05_DATABASE_DESIGN.md) rewritten.

### B2 · S2 · RLS predicates degrade plans

`current_setting()` in an RLS policy is opaque to the planner, which produces
generic plans and can defeat partition pruning.

**Resolution:** RLS remains the **safety net**; the repository layer always adds
an explicit literal `workspace_id` predicate so the planner has a real value.
Belt and braces, documented as such rather than assumed.

### B3 · S2 · No noisy-neighbour controls beyond job concurrency

One tenant running a 500k-row export can saturate I/O and connections.

**Resolution:** [16](16_SCALABILITY_AND_OPERATIONS.md) adds per-tenant quotas
(records, fields, automations, API calls, storage, export rows), statement
timeouts by query class, a separate connection pool and read replica for
analytical and export workloads, and per-tenant resource metrics.

### B4 · S3 · No tenant size classification

A 200-record consultancy and a 2M-record customer cannot share one operational
profile.

**Resolution:** documented tenant tiers with different limits, pool allocation
and, at the top tier, a dedicated-database escape hatch behind the same
repository interface.

---

## C · Events and consistency

### C1 · S1 · No transactional outbox — events can be silently lost

The design says every mutation emits an event, and that automations, audit,
webhooks and search indexing all hang off that. It does not say **how the event
is published atomically with the transaction.**

Commit-then-publish loses events on a crash between the two. Publish-then-commit
emits events for transactions that roll back. Either way, automations silently
fail to fire — the worst class of bug in this kind of product, because nothing
errors and nobody notices for weeks.

**Resolution:** transactional outbox. Events are written to an `outbox` table in
the same transaction as the mutation; a relay publishes and marks them. At-least-
once delivery with idempotent consumers. Added to
[04](04_SYSTEM_ARCHITECTURE.md) as ADR-11 and to
[10](10_AUTOMATION_ENGINE.md).

### C2 · S2 · No optimistic concurrency control

Nothing in the design prevents two users overwriting each other. On a
collaborative CRM this happens daily.

**Resolution:** `version` column, `If-Match`/ETag on the API, and a conflict UI
that shows both values rather than silently taking the last write.

### C3 · S2 · Automation idempotency was asserted, not designed

"Actions are designed so re-execution does not duplicate" — with no mechanism.

**Resolution:** every action execution carries a deterministic idempotency key
derived from `(rule_id, rule_version, trigger_event_id, action_index)`, stored
with a uniqueness constraint. Retries become no-ops by construction.

### C4 · S3 · `wait` actions need durable timers

A wait step implies state surviving process restarts, deploys and multi-day
delays. Not addressed.

**Resolution:** waits are persisted as scheduled continuations, not in-memory
timers; documented cancellation semantics when the underlying record changes.

---

## D · API

### D1 · S1 · "REST generated from metadata" is not a viable public API

This was presented as a strength — *"the API is nearly free"*. It is a trap:

- A tenant adding a required custom field **changes validation for every API
  client** with no version bump. That is a breaking change caused by a customer's
  configuration.
- The OpenAPI document differs per tenant, so no single published specification
  exists.
- Deprecation cannot be managed, because the surface is tenant-defined.
- Any generated endpoint is, by definition, unable to have a hand-designed
  contract where the domain needs one.

**Resolution** ([09](09_API_ARCHITECTURE.md) rewritten): endpoints are
**hand-designed and stable**; custom fields travel in a `properties` bag with a
discovery endpoint.

```
GET /api/v1/objects/accounts/{id}?properties=name,industry,custom_x
GET /api/v1/meta/objects/accounts/properties      ← discovery
```

Stable contract, tenant-specific fields, one publishable specification. This is
what every mature CRM API converged on, and the reasons are the ones above.

The valid part of the original argument survives: metadata still drives
validation and the property catalogue. It just does not generate the routes.

### D2 · S3 · Cursor pagination under-specified

"Cursor-based, not offset" without stating stability guarantees or sort
constraints.

**Resolution:** cursors are opaque, encode the sort key plus tie-breaker `id`,
and are invalidated on sort change. Documented.

### D3 · S3 · No bulk read path

`/bulk` covers writes. Exporting 500k records via paginated reads is abusive to
both sides.

**Resolution:** an async export job returning a signed URL, and a documented
incremental-sync endpoint (`updated_since` + cursor) so integrators do not
poll-scan.

---

## E · Performance and scale

### E1 · S2 · Full-text search over metadata-driven fields was hand-waved

"Postgres FTS first, revisit at ~1M records." Maintaining a `tsvector` across
arbitrary JSONB, per tenant, with per-field permissions applied at query time,
is materially harder than that sentence implies — and permission-filtered search
cannot be done correctly by post-filtering results without breaking pagination.

**Resolution:** searchable fields are projected into a dedicated
`record_search` table (record ref, workspace, tsvector, permission tags), one
GIN index shared across tenants, maintained by the outbox relay. Permission tags
are applied in the query, not after it. Escalation to a dedicated search cluster
is a documented trigger, not a vague "revisit".

### E2 · S2 · Performance budgets had no load model

`p95 < 500 ms at 100k records` states no concurrency, no data distribution, no
cardinality.

**Resolution:** [16](16_SCALABILITY_AND_OPERATIONS.md) defines a reference load
model — tenant size distribution, concurrent users, read/write mix, filter
cardinality — and the budgets are restated against it. A budget without a load
model is not testable.

### E3 · S3 · Timeline rollup will not hold at scale

`account_id` denormalised onto attachments is right, but a large account's
timeline (50k+ entries across activities, tasks, notes and projected audit
events) still requires a union across tables per page.

**Resolution:** a `timeline_entry` projection table maintained by the relay —
one indexed, partitioned table per workspace-account-time. Source tables remain
authoritative.

### E4 · S3 · Dashboard queries have no aggregation strategy

Eight widgets each running an aggregate over a large table, per viewer, with
per-viewer permission filtering, at a 1.5 s budget.

**Resolution:** documented rollup tables for common aggregates, refreshed
incrementally; widget-level caching keyed by `(workspace, permission set, filter
hash)`; explicit "as of" labelling so a cached number is never presented as live.

---

## F · Security and enterprise readiness

### F1 · S2 · Enterprise identity is entirely missing

No SAML, no SCIM, no MFA enforcement, no session policy, no IP allowlisting.
These are not v3 luxuries — they are procurement gates. The first customer with
an IT department will ask, and "not yet" ends the deal.

**Resolution:** [17](17_ENTERPRISE_READINESS.md) added, covering identity,
compliance, tenancy controls and their sequencing.

### F2 · S2 · No sandbox or test environment

The design tells admins to build automations and rules that act on live data,
with only a dry run for safety. Every mature platform provides a sandbox.

**Resolution:** documented as a Phase 8 requirement with the data-copy and
refresh model specified, plus dry-run as the interim mitigation.

### F3 · S2 · Compliance posture is aspirational

GDPR and PDPL are named; SOC 2, DPAs, sub-processor disclosure, pen-test cadence,
vulnerability disclosure, breach notification and data-processing records are
absent.

**Resolution:** [17](17_ENTERPRISE_READINESS.md) sets out the control set and
what must exist before the first external customer versus before the first
enterprise customer.

### F4 · S3 · Field-level permission enforcement was asserted, not costed

Stripping hidden fields from responses, exports, search, filters and webhooks —
per user, per request, over JSONB — is real work on every read path.

**Resolution:** the permission set resolves once per request into a cached field
mask; projection happens at the serialisation boundary in one place, not
scattered across handlers. Benchmarked as part of the E2 load model.

### F5 · S3 · No record-level sharing or team hierarchy

Scopes are flat: own / team / workspace. Real organisations need a manager to see
their reports' records, and need to share one record with one person.

**Resolution:** hierarchical teams with roll-up visibility, plus explicit
per-record shares with an audit trail. Added to
[12](12_PERMISSION_MODEL.md).

### F6 · S3 · Admin impersonation and support access under-specified

Mentioned once. It is one of the highest-risk capabilities in any SaaS.

**Resolution:** time-boxed, customer-approved, per-session justification,
fully audited, visibly banner-flagged to the tenant while active, and never
silent.

### F7 · S4 · No encryption key management story

**Resolution:** envelope encryption with a managed KMS; per-tenant data keys;
BYOK named as an enterprise-tier item with its operational cost stated honestly.

---

## G · Operations

### G1 · S2 · No SLOs, no error budget, no DR targets

"Automated daily backups" with no RPO or RTO. "Health checks and error alerting"
is not an operational plan.

**Resolution:** [16](16_SCALABILITY_AND_OPERATIONS.md) defines availability and
latency SLOs, an error-budget policy that gates releases, RPO 15 min via PITR,
RTO 4 h, and quarterly tested restores.

### G2 · S3 · No observability design

Structured logging and correlation IDs were mentioned. No metrics taxonomy, no
tracing, no per-tenant diagnostics.

**Resolution:** RED metrics per endpoint and job class, distributed tracing with
`workspace_id` and `request_id` on every span, per-tenant support dashboards, and
a documented alert catalogue tied to the SLOs.

### G3 · S3 · Migration and backfill strategy is thin

"Expand-contract" is stated. Backfilling a slot projection across 1,000 tenants,
or migrating a field's type, is a genuine operational procedure.

**Resolution:** documented backfill framework — chunked, resumable, rate-limited,
progress-reported, safe to run during business hours — which is the same job
framework the product already needs.

### G4 · S4 · No infrastructure cost model

Unit economics per tenant are unknown, which makes pricing guesswork.

**Resolution:** cost-per-tenant model added to
[16](16_SCALABILITY_AND_OPERATIONS.md), including the enrichment pass-through
that this product uniquely has to reason about.

---

## H · User experience

### H1 · S2 · No mobile story, and it is a competitive risk

"Responsive web only, no mobile app" is defensible for v1 but was recorded as a
neutral non-goal. It is not neutral: field salespeople log calls and check
accounts on phones, and mobile usage is a major retention driver for the
incumbents.

**Resolution:** restated as an explicit competitive risk with a v2 commitment,
and a v1 requirement that the four highest-frequency mobile tasks — look up an
account, log an activity, complete a task, check today's list — are genuinely
usable on a phone rather than merely rendering.

### H2 · S2 · No bulk triage UX for REVIEW

REVIEW is 26% of current verdicts (58 of 223). The design shows a beautiful
single-verdict panel and no way to work through 58 of them.

**Resolution:** a keyboard-driven triage queue — one account per screen, evidence
shown, resolve/skip/escalate, progress indicator. Without this, REVIEW is a good
idea that users route around, which would quietly destroy the product's core
differentiator. Added to
[06](06_UI_UX_GUIDELINES.md) and [08/01](08_MODULE_SPECIFICATIONS/01_PROSPECTING_AND_QUALIFICATION.md).

### H3 · S2 · Undo was promised and never designed

"Undo is better than *Are you sure?*" — with no undo model. Undo after
automations have fired is genuinely hard.

**Resolution:** scoped honestly. Undo covers the user's direct mutation within a
time window. **Downstream automation effects are not undone**, and the UI says so
explicitly rather than implying a clean rollback. Destructive and irreversible
actions still confirm.

### H4 · S3 · No first-run experience

Empty states are specified per screen; the first ten minutes of a brand-new
workspace are not.

**Resolution:** guided first-run — import a file, run a qualification, see a
result — designed as a product surface, since it is where the design partner's
own evaluation of a second customer will be won or lost.

### H5 · S3 · RTL and keyboard shortcuts interact

`j`/`k` navigation and directional shortcuts were specified without reference to
RTL, where horizontal semantics invert.

**Resolution:** vertical shortcuts unchanged; horizontal shortcuts follow reading
direction; documented in [07](07_DESIGN_SYSTEM.md).

### H6 · S4 · Poor-connectivity behaviour

An offline banner is specified. Intermittent mobile connectivity — the actual
Gulf field condition — is not.

**Resolution:** mutation queue with visible pending state and explicit retry,
short of full offline support.

---

## I · Product and domain challenges

### I1 · S2 · A 26% REVIEW rate is a data problem the docs treat as a feature

The three-verdict model is right, and the documentation is a little in love with
it. If a quarter of output is "cannot tell", the product's job is to **shrink
that number**, not to present it elegantly.

**Resolution:** REVIEW rate becomes a first-class product health metric with a
target and a trend, surfaced on the prospecting dashboard. Each REVIEW carries a
machine-readable *reason* so the aggregate is actionable: "62% of REVIEWs are
missing a country row" is a roadmap item; an undifferentiated 26% is not.

### I2 · S3 · Reps will want ranking within QUALIFIED, and the docs refuse it

[ADR-04](04_SYSTEM_ARCHITECTURE.md#decision-register) rejects scoring. The
epistemic argument is sound, but a rep handed 400 qualified accounts needs an
order, and if the product does not provide one they will invent a worse one in a
spreadsheet.

**Resolution:** the *verdict* stays categorical and unranked — that is the
principle worth defending. Ranking is a **separate, explicit, configurable
priority model** over qualified accounts (fit signals, recency, engagement),
clearly labelled as a heuristic and never rendered as a verdict. Both things can
be true.

### I3 · S3 · Evidence staleness has no refresh economics

Verdicts go stale at 90 days. Nothing says who pays to refresh 40,000 accounts,
or in what order.

**Resolution:** a refresh policy engine — prioritise by lifecycle stage, deal
activity and verdict age, bounded by workspace budget, with cost shown before
running. This is where the cost-metering differentiator earns its keep.

### I4 · S4 · No competitive migration path

Nothing addresses importing from HubSpot, Pipedrive or Salesforce. Switching
cost is the main obstacle to every deal.

**Resolution:** named as a v2 requirement, with the import engine's mapping
templates as the foundation.

---

## J · Delivery and maintainability

### J1 · S2 · No testing strategy beyond the preserved suites

Promoting 36 existing checks to release gates is right and insufficient. Nothing
covers contract testing, tenant-isolation fuzzing, migration testing, load
testing as a gate, or permission-matrix testing.

**Resolution:** test strategy added to
[16](16_SCALABILITY_AND_OPERATIONS.md), including a permission matrix generated
from metadata — the only tractable way to test a configurable permission model —
and tenant-isolation tests as a blocking gate.

### J2 · S3 · Phase 1 is enormous and has no internal ordering

"Large" covers tenancy, metadata, storage, events, jobs, audit, auth,
permissions, design system and seeds. That is not a phase; it is a project.

**Resolution:** [14](14_DEVELOPMENT_ROADMAP.md) splits Phase 1 into 1a
(persistence, tenancy, metadata, storage — gated by the load test) and 1b
(events, jobs, audit, auth, permissions, design system), with 1a's load test as a
**stop-the-line gate**.

### J3 · S3 · Backlog has no estimates or critical path

Priorities and dependencies exist; sequencing under a real team size does not.

**Resolution:** dependency-ordered critical path added, with the caveat that
estimates require `[OPEN: Q-10]`.

### J4 · S4 · "No microservices" needs a stated extraction seam

Correct decision, but a modular monolith drifts unless the seam is named.

**Resolution:** documented — modules communicate only by events and published
interfaces, so extraction means replacing the in-process bus with a network one.
CI enforces the import boundaries that make this true.

---

## What survived review unchanged

Worth stating, because the review is otherwise relentless:

- **Evidence/verdict separation.** Structurally correct and genuinely
  differentiating. Only the cost claims needed correcting.
- **Three verdicts.** Right, and rightly defended — with I1 and I2 as necessary
  additions rather than retreats.
- **Immutable versioned verdicts with impact preview.** The strongest idea in the
  documents. Only the *scale* mechanism needed work.
- **Brownfield preservation discipline.** Release gates on the existing test
  suites, and "move `hcm.js`, do not rewrite it", are exactly right.
- **Provider abstraction with cost metering.** A real differentiator, correctly
  motivated by real spend data.
- **The LinkedIn commercial boundary.** Correctly identified and correctly
  handled.
- **Activity/audit separation, deal line items, RTL as a v1 constraint.** All
  correct.

---

## Revised blocking questions

The original four stand. Three more are now blocking:

| ID | Question | Blocks |
|---|---|---|
| **Q-01** | Single-tenant or multi-tenant from day one? | All schema |
| **Q-03** | Hosted LinkedIn-derived data, or self-hosted only? | Prospecting roadmap |
| **Q-04** | Scale at 12 months? | A1 slot sizing, E2 load model |
| **Q-10** | Deadline and team size? | All of [14](14_DEVELOPMENT_ROADMAP.md) |
| **Q-11** | Expected custom fields per object at the 90th percentile? | A1 — determines slot allocation, which is expensive to change later |
| **Q-12** | Is an enterprise buyer (SSO/SCIM/SOC 2) in the first 18 months? | [17](17_ENTERPRISE_READINESS.md) sequencing |
| **Q-13** | Acceptable p99 latency and availability target? | E2, G1 — SLOs cannot be derived from nothing |

**Q-11 is the new one that matters most.** Slot allocation is a schema decision
that is cheap now and expensive after data exists.
