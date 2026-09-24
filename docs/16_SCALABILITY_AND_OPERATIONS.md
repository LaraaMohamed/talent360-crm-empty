# Scalability & Operations

**Status:** Draft v0.1 · **Owner:** Architecture / SRE · **Last reviewed:** 2026-08-03

Created in response to [15 §E, §G, §J1](15_TECHNICAL_REVIEW.md) — performance
budgets with no load model, no SLOs, no DR targets, no observability design, and
a testing strategy that stopped at the preserved suites.

---

## 1. Reference load model

A performance budget without a load model is not testable. All budgets in this
document and in [02](02_PRODUCT_REQUIREMENTS.md) are stated against this model.

### Tenant distribution at 18 months (planning assumption — `[OPEN: Q-04]`)

| Tier | Tenants | Accounts | Contacts | Users | Share of load |
|---|---|---|---|---|---|
| Trial | 400 | < 1k | < 2k | 1–2 | 5% |
| Small | 300 | 5k | 15k | 3–10 | 20% |
| Medium | 80 | 50k | 200k | 10–40 | 45% |
| Large | 15 | 250k | 1M | 40–150 | 25% |
| **Outlier** | 2 | **1M** | **5M** | 200+ | 5% |

**The outlier drives the architecture.** Designing for the median produces a
system that falls over for the customers who pay most.

### Concurrency and mix

| Dimension | Assumption |
|---|---|
| Peak concurrent users | 8% of licensed users, clustered 09:00–11:00 local |
| Read : write | 20 : 1 |
| Filter cardinality | Median filter returns 2–5% of a tenant's records |
| Sort | ~70% of list views sort on a non-default column |
| Import peak | 3 concurrent imports per medium tenant, 50k rows each |
| Qualification | Weekly full re-evaluation per tenant; ad-hoc rule previews daily |
| Custom fields | p50 12 per object, **p90 35**, p99 80 — `[OPEN: Q-11]` |

That p90 figure is what sizes the slot allocation in
[05](05_DATABASE_DESIGN.md). It is the cheapest decision to get right now and
among the most expensive to change later.

### Restated budgets

| ID | Operation | Budget | At |
|---|---|---|---|
| NFR-PERF-001 | List, 50 rows, 2 slot-projected filters + sort | p95 < 500 ms | Medium tenant under peak concurrency |
| NFR-PERF-001b | Same, outlier tenant (1M accounts) | p95 < 1200 ms | Peak |
| NFR-PERF-002 | Record detail with timeline first page | p95 < 300 ms | Any tier |
| NFR-PERF-003 | Global search, first results | p95 < 400 ms | Medium |
| NFR-PERF-004 | Qualify 1,000 cached companies | < 5 s | Any |
| NFR-PERF-004b | Full re-evaluation, 250k accounts × 20 rules | < 30 min as a job | Large |
| NFR-PERF-005 | Import 10,000 rows | < 60 s as a job | Any |
| NFR-PERF-006 | Dashboard, 8 widgets, from rollups | p95 < 1.5 s | Medium |
| NFR-PERF-007 | Job start latency (queue → running) | p95 < 10 s | Any |

**Load test at the outlier profile in Phase 1a.** If the storage strategy misses
these, everything built on it is wrong. Finding out in Phase 8 is fatal; in
Phase 1a it is a week.

---

## 2. Tenant quotas

Every SaaS needs these, or one tenant degrades all of them. Enforced, surfaced in
the UI, and raisable by plan.

| Quota | Small | Medium | Large | Enterprise |
|---|---|---|---|---|
| Records per object | 25k | 250k | 2M | Negotiated |
| Custom fields per object | 40 | 100 | 200 | Negotiated |
| **Filterable (slot) fields per object** | 24 | 24 | 24 | 24 — a schema limit, not a plan lever |
| Active automations | 20 | 100 | 400 | Negotiated |
| Automation executions / day | 10k | 100k | 1M | Negotiated |
| API calls / day | 25k | 250k | 2M | Negotiated |
| Concurrent jobs | 2 | 5 | 15 | 30 |
| Export rows per request | 50k | 250k | 1M | 1M |
| File storage | 10 GB | 100 GB | 1 TB | Negotiated |
| Webhook subscriptions | 10 | 50 | 200 | Negotiated |

Slot count is deliberately **not** a plan lever — it is a physical schema
property, and pretending otherwise would sell something that cannot be delivered
without a migration.

Approaching a quota warns at 80% and 95%. Hitting one produces a clear,
actionable message — never a silent failure or an unexplained slowdown.

---

## 3. Noisy-neighbour controls

| Control | Mechanism |
|---|---|
| Job concurrency | Per-workspace limit; a fair scheduler across tenants |
| Statement timeouts | By query class: interactive 5 s, report 60 s, job 300 s |
| Connection pools | Separate pools for interactive, job and analytical traffic |
| Read replicas | Reports, exports and analytics never touch the primary |
| Rate limits | Per workspace and key, tiered by cost ([09 §7](09_API_ARCHITECTURE.md)) |
| Backfill throttling | Paced against replica lag; automatically slows under load |
| Per-tenant metrics | Query time, job time, storage, provider spend — visible to support |

---

## 4. Scale-out path

| Stage | Trigger | Move |
|---|---|---|
| 1 | Launch | Single primary + PITR |
| 2 | Read load > 60% of primary | Read replicas; route reports, exports, analytics |
| 3 | Outlier tenant dominates | Dedicated database for top-tier tenants, behind the same repository interface — no application change |
| 4 | Search CPU or FTS maintenance cost | Dedicated search cluster replaces `record_search` |
| 5 | Write ceiling on the primary | Shard by `workspace_id` |

Stage 5 stays open only because **nothing in the schema joins across
workspaces**. That is a deliberate constraint, enforced in review, not an
accident to be discovered later.

---

## 5. Service levels

| SLO | Target | Window |
|---|---|---|
| API availability | 99.9% (≈43 min/month) | 30 days rolling |
| UI availability | 99.9% | 30 days rolling |
| Interactive read latency | p95 < 500 ms, p99 < 1.5 s | 30 days |
| Write latency | p95 < 800 ms | 30 days |
| Job start latency | p95 < 10 s | 30 days |
| Webhook delivery | 99.5% within 60 s | 30 days |
| Data durability | No confirmed write lost | Always |

`[OPEN: Q-13]` — an enterprise contract may require 99.95%, which changes the
deployment topology and its cost.

### Error budget policy

0.1% monthly is ~43 minutes. When 50% is consumed, feature releases pause and
reliability work takes priority until the budget recovers. Stated now, because a
policy adopted after the first bad month is negotiated under pressure.

### Disaster recovery

| Target | Value |
|---|---|
| **RPO** | 15 minutes (continuous archiving + PITR) |
| **RTO** | 4 hours |
| Backup retention | 35 days PITR; monthly archives 12 months |
| **Restore testing** | Quarterly, to a scratch environment, timed and recorded |
| Evidence store | Backed up **independently** — it is the most expensive asset to reacquire |

An untested restore is a hope, not a backup. The quarterly test is a calendar
commitment with a named owner.

---

## 6. Observability

### Metrics — RED per endpoint and job class

Rate, Errors, Duration, plus saturation: pool utilisation, queue depth, replica
lag, storage growth. Every metric carries `workspace_id` where cardinality
permits, and a tenant-tier label where it does not.

### Tracing

Distributed tracing with `workspace_id`, `user_id`, `request_id` on every span.
The question that must be answerable in under a minute: *"why was this one
request slow for this one customer?"*

### Logging

Structured, correlated by `request_id`, with **no personal data and no
credentials** in log bodies. Retention: 30 days hot, 12 months cold.

### Per-tenant support dashboard

Support must see one tenant's health without a query: record counts against
quota, slow queries, failed jobs, failed automations, webhook failures, provider
spend, recent errors. Absence of this is what makes SaaS support unscalable.

### Alert catalogue

Every alert maps to an SLO and a runbook. Alerts with neither are deleted —
they train people to ignore the pager.

| Alert | Condition |
|---|---|
| Availability burn | Error budget consuming faster than 2× |
| Latency regression | p95 above budget for 10 min |
| Queue depth | Job start latency above budget |
| Outbox lag | Unpublished events older than 60 s — **automations are silently not firing** |
| Replica lag | Above 30 s |
| Automation failure rate | Above 5% for a workspace |
| Provider budget | Workspace at 95% |
| Isolation | Any cross-workspace access attempt — page immediately |

The outbox-lag alert matters most. It is the only signal that automations have
stopped working, and without it the failure is invisible.

---

## 7. Migration and backfill

Slot promotion, type change, projection rebuild and retention sweeps are one
operation with different parameters: a chunked, resumable, rate-limited job safe
to run during business hours.

**Requirements:** bounded batch size, checkpointed progress, cancellable,
throttled against replica lag, dry-run row counts before starting, and a
per-tenant progress report.

**Schema migrations** are expand-contract only:

```
1  Add new structure           (additive, safe)
2  Dual-write old and new      (deploy)
3  Backfill                    (job, throttled)
4  Verify equivalence          (automated comparison)
5  Read from new               (deploy)
6  Stop writing old            (deploy)
7  Drop old                    (separate, later, deliberate)
```

Never steps 1 and 7 in one release. The gap between them is what makes rollback
possible.

---

## 8. Testing strategy

Promoting the existing 36 checks to release gates is right and insufficient.

| Layer | Coverage | Gate |
|---|---|---|
| **Domain unit** | Rules, verdicts, pricing, coverage maths — pure, no I/O | Every commit |
| **Golden output** | Re-qualify the 223 known companies, assert byte-identical | Every commit |
| **Preserved suites** | `test-signals.mjs`, `test-panels.mjs` unmodified | Every commit |
| **Contract** | API request/response against the published OpenAPI spec | Every commit |
| **Tenant isolation** | Attempt cross-workspace access by every route; **assert failure** | Every commit — blocking |
| **Pooling isolation** | Assert a pooled connection retains no `app.workspace_id` | Every commit — blocking |
| **Permission matrix** | Generated from metadata: every role × object × field × action | Nightly |
| **Migration** | Every migration applied to a production-shaped snapshot, forward and rollback | Every migration |
| **Load** | Reference model at outlier profile | Weekly + before release |
| **RTL / a11y** | Automated axe checks; both directions | Every commit |
| **E2E** | Upload → qualify → download; import → deal → proposal → agreement | Every release |

**The permission matrix is generated, not written.** A configurable permission
model has a combinatorial surface no human can enumerate, and hand-written
permission tests give false confidence.

**Tenant isolation and pooling isolation are blocking gates.** They are the two
failures that end a company rather than causing an incident.

---

## 9. Cost model

Unit economics per tenant, because pricing without them is guesswork.

| Component | Driver | Note |
|---|---|---|
| Database | Storage + IOPS | Dominated by `activity`, `audit_event`, `evidence_snapshot` — all partitioned and archivable |
| Object storage | Files + archived partitions | Cheap; grows monotonically |
| Compute | Concurrent users + job load | Job load is spikier than user load |
| Search | Index size | Moves to a dedicated cluster at stage 4 |
| **Enrichment** | **Pass-through, highly variable** | The one this product must reason about explicitly |

Enrichment is the unusual line. The same 123 companies cost **$240, $17.70,
$0.49 or $0** depending on route ([11](11_INTEGRATIONS.md)). Per-workspace
budgets and cost-per-qualified-account reporting are therefore not just a
customer feature — they are how the business avoids selling below cost.

**Metric to track from day one:** infrastructure cost per tenant per month, by
tier, and enrichment spend as a share of subscription revenue.

---

## 10. Environments

| Environment | Purpose | Data |
|---|---|---|
| Development | Local | Synthetic |
| CI | Automated gates | Synthetic + the 223-company fixture |
| Staging | Pre-release, load testing | Production-shaped synthetic; **never production personal data** |
| Production | Live | Live |
| **Customer sandbox** | Customers test automations and rules safely | Subset copy, refreshable — see [17](17_ENTERPRISE_READINESS.md) |

Production personal data never enters a lower environment. If a bug needs
production data to reproduce, it is reproduced in production under audited
support access, not by copying the data out.
