# System Architecture

**Status:** Draft v0.1 · **Owner:** Architecture · **Last reviewed:** 2026-08-03

---

## 1. Starting position

This is a brownfield project. The architecture must accommodate what exists.

**What works today and is in daily use:**

| Component | Role | Verdict |
|---|---|---|
| `lib/hcm.js`, `lib/offshoring.js` | Qualification rules — pure functions, no I/O | **Keep as-is.** Move, don't rewrite. |
| `lib/signals.js`, `normalize.js`, `labels.mjs` | Domain dictionaries and normalisation | **Keep.** Hard-won, corrected against real data. |
| `lib/panels.mjs`, `company.mjs` | Browser-side extraction | **Keep.** Must stay self-contained (runs inside the page). |
| `lib/csv.mjs`, `select.mjs`, `verdicts.mjs` | CSV fidelity, filtering, verdict shaping | **Keep.** Round-trip behaviour is tested and correct. |
| `scrape.mjs` | Playwright collector: session, pacing, resumability | **Wrap.** Becomes a provider implementation. |
| `qualify.mjs` | CLI entry point | **Keep working.** Becomes a thin caller. |
| `server.mjs` + `public/` | Upload-and-qualify UI | **Keep working** until replaced feature-for-feature. |
| `snapshots.json` | Evidence store, 223 companies | **Migrate behind a repository interface.** Back up first. |
| `test-signals.mjs`, `test-panels.mjs` | 36 offline checks | **Promote to release gates.** |

The rules and the domain dictionaries are the asset. Everything around them is
replaceable plumbing.

---

## 2. Layering

```
┌─────────────────────────────────────────────────────────┐
│ PRESENTATION    Web UI · CLI · public API · webhooks    │
│                 No business logic. No direct data access.│
├─────────────────────────────────────────────────────────┤
│ APPLICATION     Use cases · orchestration · transactions │
│                 permission checks · event publication    │
├─────────────────────────────────────────────────────────┤
│ DOMAIN          Entities · rules · invariants            │
│                 Pure. No framework, DB or network.       │
├─────────────────────────────────────────────────────────┤
│ INFRASTRUCTURE  Postgres · object storage · queue        │
│                 providers · email · document generation  │
└─────────────────────────────────────────────────────────┘
```

Dependencies point **inward only**. Domain knows nothing of the layers above it.

The existing qualification rules already satisfy the domain-layer contract —
they are pure functions from a snapshot to a verdict, with no imports beyond
their own dictionaries. That is why they can move unchanged.

**Enforced, not merely encouraged:**

| Rule | Enforcement |
|---|---|
| No SQL outside infrastructure | Lint rule on import paths |
| No HTTP calls in components | Lint rule |
| No service-line / stage / activity-type literals outside seeds | CI grep check (FR-PLAT-010) |
| Domain imports nothing framework-shaped | Dependency-cruiser rule in CI |

---

## 3. Module structure

Feature modules, not layer folders. Each module owns its domain, use cases,
persistence and UI, and exposes a documented public interface. Cross-module
access goes through that interface — never into another module's internals.

```
platform/          metadata · tenancy · events · jobs · audit · permissions
records/           accounts · contacts
prospecting/       evidence · rules · verdicts · collection   ← existing engine
deals/             pipelines · stages · line items · forecasting
engagement/        activities · tasks · notes · notifications
documents/         proposals · agreements · files · generation
ingestion/         import wizard · mapping · dedupe · merge
insights/          views · filters · dashboards · reports
automation/        triggers · conditions · actions · execution log
integrations/      provider contracts · connectors · cost metering
```

`platform/` is not a feature. It is the substrate the other nine are built on,
and it is what makes configuration possible rather than customisation.

**Dependency direction:** every module may depend on `platform/`. Modules do not
depend on each other directly — they communicate through domain events. The one
exception is `records/`, which others may read through its public interface,
because an account reference is genuinely universal.

---

## 4. The metadata engine

The mechanism behind "everything configurable, nothing hardcoded".

### How a field comes to exist

```
Admin defines a field
        ↓
Field Definition stored (type, validation, flags, permissions)
        ↓
   ┌────┴────┬──────────┬──────────┬─────────┐
   ▼         ▼          ▼          ▼         ▼
 Form     Table     Filter      API      Import
 renders  column    operators   schema   mapping
 control  offered   derived     exposed  target
```

One definition drives every surface. Nothing is registered twice. This is the
property that makes the promise real: if adding a field required touching a form
component, an API schema and a filter list, it would not survive contact with
a deadline.

It is also why the public API is cheap: routes are hand-designed and stable, but
validation, the property catalogue and the field mask all come from this same
definition. The API remains the best available test that nothing is hardcoded —
if a customer adds a field and the API needs hand-editing, the engine is a
fiction.

### Resolution and caching

Metadata is read on nearly every request and changes rarely. It is cached per
workspace with an explicit version stamp; a metadata change bumps the stamp and
invalidates. Records store `stage_id`; display resolves through the cache.

### Safety rails

| Rail | Why |
|---|---|
| Metadata is deprecated, never deleted, while referenced | Prevents dangling references in automations, views and reports |
| Deletion is blocked with the list of referrers | Turns a silent breakage into a clear message |
| Changes are versioned with author and diff | Answers "who broke the pipeline on Tuesday" |
| Impact preview before publishing | The 117-verdict incident (§ Decision Register, ADR-05) |
| `key` is immutable and never reused | External references stay valid across renames |

---

## 5. Provider architecture

Every external capability sits behind a contract. Business logic never names a
vendor.

```
                  ┌──────────────────────────┐
   Application ──►│  Capability contract     │
                  │  + cost declaration      │
                  │  + confidence reporting  │
                  └────────────┬─────────────┘
                               │
   ┌──────────┬────────────┬───┴──────┬────────────┬──────────┐
   ▼          ▼            ▼          ▼            ▼          ▼
 Local     Apify       Apollo      Clay          PDL      Google
 browser   actors                                        Workspace
 (BYO)                                                   (documents)
```

**Capabilities**, not vendors: company lookup, contact lookup, email finding,
company enrichment, document generation, file storage, email sending.

Every provider declares:

- **Cost per unit** — so a run can be priced *before* it executes
- **Confidence** — so waterfall enrichment can stop when a result is good enough
- **Rate limits** — so the scheduler can pace correctly
- **Attribution** — so every evidence snapshot knows where it came from

### Cost metering is a first-class concern

This project has already paid for the lesson: the same 123 companies cost **$240**
by one route, **$17.70** by another, **$0.49** by a third, and **$0** by the
local browser. That experience becomes a platform feature —

1. Estimate cost before running, shown in the UI
2. Track actual spend per provider, run and workspace
3. Enforce per-workspace budgets with soft warning and hard stop
4. Report spend against results

No competitor does this well. It is a genuine differentiator that costs little
because the provider contract has to exist anyway.

### The LinkedIn boundary

The existing browser collector is a provider like any other **architecturally**,
and unlike any other **commercially**. Automated LinkedIn access is against
LinkedIn's terms. Acceptable as personal internal tooling; a different legal
position when sold to third parties.

**Therefore:** it is a self-hosted, bring-your-own-session provider. The hosted
multi-tenant product ships only licensed providers. See ADR-08 and `[OPEN: Q-03]`.

---

## 6. Events and automation

Every domain mutation emits a typed event. Events are the integration seam
between modules, the trigger source for automations, and the payload for outbound
webhooks — one mechanism, three uses.

```
Domain mutation ──┐
                  ├─ SAME TRANSACTION ─► outbox table
                  ┘
                         ↓ (relay, after commit)
                    Domain event ──┬──► Audit log (always, immutable)
                                   ├──► Activity / timeline projection
                                   ├──► Automation engine
                                   ├──► Outbound webhooks
                                   └──► Search projection
```

**The outbox is not optional.** Committing then publishing loses events on a
crash between the two; publishing then committing emits events for transactions
that roll back. Either way automations silently fail to fire — the worst failure
mode in this product, because nothing errors and nobody notices for weeks. The
event is written in the same transaction as the mutation, and a relay publishes
it. Delivery is at-least-once; consumers are idempotent by construction. See
ADR-11.

**This lands in Phase 1**, not Phase 9. Not the rules UI — just the bus. Without
it, the behaviours described in Phases 5–8 (stage change creates a task, proposal
sent logs an activity, renewal date raises a reminder) get hand-coded eight times
and then have to be unpicked.

Automation execution is asynchronous, logged end to end, loop-protected, and
supports dry run. Details in [10_AUTOMATION_ENGINE.md](10_AUTOMATION_ENGINE.md).

---

## 7. Background jobs

Also Phase 1. Imports, bulk edits, collection runs, exports, recalculations and
scheduled automations are all jobs.

Requirements: durable queue, retry with backoff, progress reporting, cancellation,
**per-workspace concurrency limits** so one tenant's 50,000-row import cannot
degrade another's page loads.

The existing collector already models the important part — it persists after
every company and is fully resumable. That behaviour is the standard for every
long-running job in the platform, not an exception.

---

## 8. Tenancy

**Workspace = tenant.** Single database, shared schema, row-level security.

Every tenant-scoped table carries `workspace_id`. Isolation is enforced by the
database, not by remembering a `WHERE` clause — and CI contains tests that
attempt cross-workspace access and assert failure.

Why not schema-per-tenant or database-per-tenant: with thousands of small
workspaces, migration time and connection overhead dominate, and the metadata
engine already provides the per-tenant variability that schema separation would
otherwise be buying. Revisit if a customer requires physical isolation for
compliance — see ADR-02.

---

## 9. Data flow: upload to qualified list

The existing flow, mapped onto the target architecture. This is the reference
example — every module should read this cleanly.

```
1. Upload            Presentation   file → application
2. Parse & profile   Application    columns, types, LinkedIn-column detection
3. Map               Application    saved template or inferred, user-confirmable
4. Resolve identity  Records        dedupe, upsert on external_id → Accounts (prospect)
5. Plan collection   Prospecting    which subjects lack fresh evidence
6. Estimate cost     Integrations   per provider, shown before running
7. Collect           Infrastructure provider(s), paced, resumable, per-item persistence
8. Store evidence    Prospecting    immutable snapshots, attributed
9. Evaluate          Domain         pure rules over evidence → verdicts (no I/O)
10. Persist verdicts Prospecting    append-only, rule version recorded
11. Promote          Records        QUALIFIED → lifecycle stage, optional Deal creation
12. Emit events      Platform       audit, timeline, automations, webhooks
13. Export           Presentation   original columns preserved, filtered
```

Steps 9 and 13 are the ones users experience as instant. Both are already
correct in the existing code and must stay that way: step 9 because evidence and
rules are separate, step 13 because rows are kept as arrays and round-tripped
verbatim.

---

## 10. Technology direction

Not prescriptive, but these constrain the design.

| Concern | Direction | Why |
|---|---|---|
| Database | PostgreSQL | JSONB + partitioning + RLS + full-text in one engine. Custom-field storage uses slot projection, not per-tenant indexes — see ADR-03. |
| Storage | S3-compatible object storage | Signed URLs; never blobs in the database |
| Queue | Durable, Postgres-backed or Redis-backed | Fewer moving parts matters more than throughput at this scale |
| Search | Postgres FTS first | Defer a search cluster until a measured limit; revisit at ~1M records |
| Frontend | Single-page app, typed end to end | Metadata-driven rendering needs a rich client |
| API | Hand-designed REST + discovered property bag, plus webhooks | Generated routes cannot be versioned when tenants define the surface — see ADR-12 |
| Language | TypeScript across the stack | Shared types between metadata, API and UI. The existing engine is already JavaScript — migration is incremental, not a rewrite. |

The existing code is dependency-free ES modules with Playwright. That discipline
is worth preserving in the domain layer: **rules should stay pure and
dependency-free** so they remain trivially testable offline, which is exactly why
the current test suites run in milliseconds with no network.

---

## 11. Decision register

Decisions with rationale, alternatives rejected, and what would make us revisit.

### ADR-01 · Record architecture decisions
Decisions are captured in this register with context and consequences. Anything
that would surprise a new engineer in six months gets an entry.

### ADR-02 · Workspace is the tenant; row-level security
**Decision.** Single database, shared schema, `workspace_id` on every tenant
table, enforced by RLS. Users are global identities with per-workspace
memberships. No cross-workspace sharing in v1.
**Rejected.** Schema-per-tenant (migration cost at scale), database-per-tenant
(operational overhead disproportionate to SMB pricing).
**Revisit if.** A customer contractually requires physical isolation, or a single
workspace exceeds the size where shared tables are practical.
→ blocked by `[OPEN: Q-01]`

### ADR-03 · JSONB source of truth with a fixed typed slot projection
**Superseded ADR-03a** (JSONB + per-workspace expression indexes), which does not
scale: 1,000 workspaces × 25 filterable fields = 25,000 partial indexes on one
table, roughly 500× Postgres's practical ceiling, and it required `CREATE INDEX`
on a shared table as a user action — the exact criterion on which
column-per-field had been rejected.

**Decision.** Three tiers. System fields are typed columns. All custom values
live in one `JSONB` column as the source of truth. Fields flagged `filterable` or
`sortable` are additionally **projected into fixed typed slot columns**
(`n1..n24`, `s1..s48`, `d1..d12`, `b1..b8`, `u1..u8`) carrying shared composite
indexes `(workspace_id, slot)` created once at migration time.

**Consequence.** Index count is constant regardless of tenant count. No DDL on
user action. Costs accepted: slot exhaustion as a visible admin budget, type
changes requiring a backfill, and a projection that must be kept consistent —
all bounded, testable problems.

**Revisit if.** p90 custom-field count exceeds the slot allocation
(`[OPEN: Q-11]`), or p95 list latency misses the NFR-PERF-001 budget at the
outlier tenant profile.

### ADR-04 · Three verdicts are a platform primitive
**Decision.** `QUALIFIED` / `REJECTED` / `REVIEW` throughout — data model, API,
filters, dashboards, exports. REVIEW is never collapsed into REJECTED.
**Rejected.** Boolean qualified flag with a separate confidence score — it
reintroduces exactly the ambiguity the model exists to remove, and every
downstream consumer would resolve it differently.
**Revisit if.** Never, without a written argument that addresses the false-negative
cost.

### ADR-05 · Verdicts are immutable and carry their rule version
**Decision.** A verdict records rule key, rule version, evidence reference,
inputs hash and computed-at. Re-running appends. Publishing a rule change shows
an impact preview first.
**Context.** During development, changing one threshold changed 117 of 223
verdicts — 3 from QUALIFIED to REJECTED — with no record that it happened.
**Rejected.** Storing the current verdict only (cannot explain changes,
cannot audit, cannot learn).

### ADR-06 · All external capability behind provider contracts, with cost metering
**Decision.** Capability contracts, not vendor integrations. Every provider
declares cost, confidence and rate limits. Cost is estimated before execution and
tracked after. Two implementations exist before any capability becomes a
dependency.
**Rejected.** Direct vendor SDK use in application code — the failure mode is
well documented in this repo's own history, where fictional field names for a
store actor would have failed on first real call.

### ADR-07 · Activity timeline and audit log are separate systems
**Decision.** Two stores. Activities are typed, curated, editable. Audit events
are uniform, immutable, complete. Configurable projection of selected audit
events into the timeline.
**Rejected.** One activity stream for both — produces a timeline nobody reads and
an audit log that fails its first compliance review.

### ADR-08 · Browser-based LinkedIn collection stays bring-your-own-session
**Decision.** The browser collector is a self-hosted provider using the
operator's own session. The hosted multi-tenant product ships only licensed
providers.
**Context.** Automated LinkedIn access violates LinkedIn's terms. Personal
internal use is the operator's own risk; offering it as a hosted service to
paying third parties is a categorically different exposure.
**Revisit.** Before the first external customer — this shapes the prospecting
roadmap. → `[OPEN: Q-03]`

### ADR-09 · PostgreSQL, migrating off `snapshots.json` behind a repository interface
**Decision.** Introduce an evidence-repository interface first, with the existing
JSON file as its first implementation. Swap to Postgres behind the same
interface. The engine never learns which it is talking to.
**Rejected.** Direct migration with a rewrite of the engine (breaks a working
system for no interim benefit).
**Prerequisite.** Back up `snapshots.json` before any of this begins.

### ADR-11 · Transactional outbox for all domain events
**Decision.** Events are written to an `outbox` table in the same transaction as
the mutation; a relay publishes them and marks them sent. At-least-once
delivery with idempotent consumers.
**Rejected.** Direct in-process publication after commit — loses events on crash,
and the loss is invisible.
**Consequence.** Outbox lag becomes a first-class alert: it is the only signal
that automations have stopped firing.

### ADR-12 · Hand-designed API endpoints with a discovered property bag
**Superseded** the earlier "REST generated from metadata". A tenant adding a
required custom field would have changed validation for every API client with no
version to bump; the OpenAPI document would have differed per tenant, so no
single specification could be published.
**Decision.** Stable hand-designed routes; tenant fields travel in a `properties`
bag with a runtime discovery endpoint.
**Consequence.** One publishable spec. Metadata still drives validation and the
property catalogue — it just does not generate routes.

### ADR-13 · `SET LOCAL` only, never session-level, for tenant context
**Decision.** The RLS workspace setting is applied with `SET LOCAL` inside each
transaction.
**Context.** Under PgBouncer transaction pooling, a session-level `SET` persists
on the server connection after it returns to the pool and is handed to a
different tenant's transaction. That is a cross-tenant data leak, not a
performance concern.
**Consequence.** A blocking CI test asserts that a pooled connection retains no
tenant setting across transactions.

### ADR-14 · Verdicts stay categorical; ranking is a separate, labelled model
**Decision.** ADR-04's refusal to score verdicts stands. Ranking *within*
QUALIFIED is a distinct, configurable priority model, clearly labelled as a
heuristic and never rendered as a verdict.
**Context.** A rep handed 400 qualified accounts needs an order. Refusing to
provide one does not prevent ranking — it moves it into a spreadsheet, where it
is worse and invisible.

### ADR-10 · Prospects are a lifecycle stage of Account, not a separate object
**Decision.** One `Account` table with `lifecycle_stage`. Prospects excluded from
default views.
**Rejected.** A separate `Prospect` table requiring a promote-and-copy step —
duplicates schema, loses history across the boundary, and forces every
integration to handle two shapes of the same concept.

---

## 12. What this architecture deliberately does not do

- **No microservices.** A modular monolith with enforced boundaries. The
  **extraction seam is named**: modules communicate only through the outbox and
  published interfaces, so pulling one into its own service means replacing the
  in-process relay with a network one — not untangling shared state. CI enforces
  the import boundaries that keep this true. Premature distribution is not
  recoverable; an unnamed seam is how a monolith becomes permanent.
- **No event sourcing** for general records. Audit log plus field history covers
  the requirement at a fraction of the complexity. The evidence/verdict model is
  append-only where it needs to be, which is the part that actually benefits.
- **No GraphQL in v1.** Hand-designed REST with a property bag is simpler to
  version, cache, rate-limit and audit, and no client requirement here needs more.
- **No plugin runtime in v1.** Webhooks and API cover extension needs until
  there is a partner ecosystem to justify more.
- **No AI features until the schema is stable.** AI over an unstable data model
  produces confident nonsense and unpickable debt.
