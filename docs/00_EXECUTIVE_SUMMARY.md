# Executive Summary

**Status:** Draft v0.1 · **Date:** 2026-08-03 · **Audience:** Founder, engineering lead, future team

---

## What this is

Product documentation for evolving an existing, working company-qualification
tool into a metadata-driven CRM platform for B2B service businesses — starting
with one HR consultancy, architected to become multi-tenant SaaS.

**This is not a greenfield project.** A qualification engine, CSV pipeline and
web UI are in daily use today. The plan below builds *around* them.

---

## Document map

| # | Document | Answers |
|---|---|---|
| [00](00_EXECUTIVE_SUMMARY.md) | Executive Summary | What did the analysis find, what must be decided now |
| [01](01_PRODUCT_VISION.md) | Product Vision | What we're building, for whom, why anyone would switch |
| [02](02_PRODUCT_REQUIREMENTS.md) | Product Requirements | Every functional & non-functional requirement, with IDs |
| [03](03_DOMAIN_MODEL.md) | Domain Model | The business concepts and their rules, independent of storage |
| [04](04_SYSTEM_ARCHITECTURE.md) | System Architecture | Layers, modules, metadata engine, decision register |
| [05](05_DATABASE_DESIGN.md) | Database Design | Schema, tenancy, custom-field storage, indexing, migration |
| [06](06_UI_UX_GUIDELINES.md) | UI/UX Guidelines | Interaction principles, key flows, states, RTL, accessibility |
| [07](07_DESIGN_SYSTEM.md) | Design System | Tokens, components, patterns |
| [08](08_MODULE_SPECIFICATIONS/) | Module Specifications | One spec per module, with acceptance criteria |
| [09](09_API_ARCHITECTURE.md) | API Architecture | Contracts, versioning, metadata-generated endpoints, webhooks |
| [10](10_AUTOMATION_ENGINE.md) | Automation Engine | Events, triggers, conditions, actions, safety |
| [11](11_INTEGRATIONS.md) | Integrations | Provider abstraction, cost metering, connector catalogue |
| [12](12_PERMISSION_MODEL.md) | Permission Model | RBAC + ABAC, field-level grants over user-defined fields |
| [13](13_PRODUCT_BACKLOG.md) | Product Backlog | Every feature: priority, status, dependencies, acceptance criteria |
| [14](14_DEVELOPMENT_ROADMAP.md) | Development Roadmap | Revised phasing, strangler-fig migration, milestones |
| [15](15_TECHNICAL_REVIEW.md) | **Technical Review** | **Adversarial CTO review of 00–14. 4 product-ending findings, all resolved.** |
| [16](16_SCALABILITY_AND_OPERATIONS.md) | Scalability & Operations | Load model, quotas, scale-out, SLOs, DR, observability, testing, cost |
| [17](17_ENTERPRISE_READINESS.md) | Enterprise Readiness | SSO/SCIM, sandbox, compliance, data protection, procurement gates |

---

## Revision note — v0.2

Documents 00–14 were reviewed adversarially in
[15_TECHNICAL_REVIEW.md](15_TECHNICAL_REVIEW.md). **Four findings were
product-ending** and have been resolved in the documents:

| | Finding | Resolution |
|---|---|---|
| **A1** | Per-workspace expression indexes break at ~24 tenants, and required DDL on user action — the exact criterion on which another option had been rejected | JSONB source of truth + fixed typed slot projection with shared indexes ([05](05_DATABASE_DESIGN.md), ADR-03) |
| **B1** | Session-level RLS context leaks across tenants under connection pooling — a **data leak**, not a performance issue | `SET LOCAL` only, with a blocking CI test (ADR-13) |
| **C1** | No transactional outbox: events lost on crash means automations silently never fire | Outbox table written in the mutation's transaction (ADR-11) |
| **D1** | REST generated from metadata cannot be versioned — a customer adding a required field breaks every API client | Hand-designed routes + discovered property bag (ADR-12) |

Nine S2 and twelve S3 findings were also applied, adding
[16](16_SCALABILITY_AND_OPERATIONS.md) and
[17](17_ENTERPRISE_READINESS.md), and three new blocking questions (Q-11, Q-12,
Q-13).

The domain thinking — evidence/verdict separation, three verdicts, brownfield
preservation — survived review unchanged.

## The ten findings that matter

Full analysis with consequences and recommendations is in
[02_PRODUCT_REQUIREMENTS.md](02_PRODUCT_REQUIREMENTS.md#appendix-a--requirements-analysis).
These are the ones that change the architecture or the business.

### 1. A verdict is a claim about a moment — and rules rewrite history silently

During development, changing one qualification threshold (`headcount ≥ 20` →
`20–50`) **changed 117 of 223 verdicts**, three of them from QUALIFIED to
REJECTED. Nothing recorded that it happened.

In a spreadsheet that is an inconvenience. In a CRM where salespeople are
working those accounts, the system contradicts itself overnight with no
explanation.

**Decision required:** verdicts become immutable records carrying the rule
version and evidence that produced them. Re-running appends; it never mutates.
Publishing a rule change shows an impact preview first. → [ADR-05](04_SYSTEM_ARCHITECTURE.md#decision-register)

### 2. "Everything configurable" has no storage strategy — this is where these products die

The naive implementation (Entity-Attribute-Value) gives perfect flexibility and
a system that takes eight seconds to filter on two custom fields.

**Decision required:** hybrid storage — typed columns for universal fields,
`JSONB` + generated expression indexes for custom fields, with `filterable` and
`sortable` as *deliberate flags on a field definition* so the index budget stays
bounded. → [05_DATABASE_DESIGN.md](05_DATABASE_DESIGN.md)

### 3. `stage_id = 18` breaks the moment there are two tenants

The principle is right, the example is a trap: sequential integers collide
across tenants, and automations referencing stages by ID break silently when an
admin reorders them.

**Decision required:** workspace-scoped UUIDs for joins, plus a stable
human-readable `key` (`stage.proposal_sent`) that automations, imports, reports
and the API reference. Metadata is deprecated, never deleted.

### 4. Activities and audit logs are two systems, not one

"Every action creates an activity" merges a curated salesperson timeline with a
high-volume immutable compliance log. They have opposite requirements — mutable
vs never, deletable vs never, low volume vs enormous. Merged, you get a timeline
nobody reads and an audit log that fails its first review.

**Decision required:** separate stores, with configurable projection of selected
audit events into the timeline.

### 5. One `estimated_value` cannot express this business

Recruitment bills a percentage of salary per placement. HCM is per-seat monthly.
Offshoring is per-headcount monthly with a ramp. Strategy is a fixed project fee.
A single decimal makes forecasting fiction, and every deal entered before the fix
needs manual repair.

**Decision required:** Deal Line Items from the start. Recurring and one-time
revenue never summed into one dashboard number.

### 6. LinkedIn collection is fine as internal tooling and a real exposure as SaaS

The existing collector automates access to LinkedIn, which its terms don't
permit. As a personal tool that is the owner's own risk. **Offering it as a
hosted feature to paying third parties is a categorically different legal
position.**

**Decision required before the first external customer:** browser-based
collection stays bring-your-own-session and self-hosted; the hosted product
ships only licensed providers. This shapes the entire prospecting roadmap.
→ `[OPEN: Q-03]`

### 7. Personal data has no lifecycle

The product stores names, emails, phones and profiles of people who never
interacted with the customer. Under GDPR and Saudi PDPL, as a multi-tenant
processor, that is the highest-risk data category there is — and retrofitting
erasure across snapshots, exports, caches and generated documents is brutal.

**Decision required:** `data_source` + `acquired_at` on every record, real
hard-delete that reaches every copy, subject-erasure operation, configurable
retention. Cheap now, very expensive in month eighteen. → `[OPEN: Q-07]`

### 8. Arabic and RTL are missing from a Gulf-market product

The live data already contains Arabic company names. The buyers are Arabic-first
organisations. The brief lists dark mode and never mentions RTL.

**Decision required:** RTL is a **v1 design-system constraint** — logical CSS
properties from the first component, bidirectional text handling, locale-aware
sort, Hijri alongside Gregorian, Fri–Sat weekend in SLA maths. Full Arabic
translation can wait; a layout that can accept it cannot be retrofitted cheaply.

### 9. The qualification module and the CRM are not connected

The brief lists "Qualification" as a field on Account and "Qualification Engine"
as a module, and never defines the relationship. If 2,000 companies are uploaded
and 27 qualify, are there now 2,000 accounts?

**Decision required:** one `Account` table with a `lifecycle_stage`
(`prospect → qualified → customer → churned`), prospects hidden from default
views, and a qualified account optionally seeding a Deal with the service line
the rule was written for. That last step is the commercial point of the engine.

### 10. Phase 1 as written ships nothing and freezes a working tool

Auth + workspace + design system delivers no user value, while the tool
currently in daily use presumably stops improving.

**Decision required:** strangler-fig phasing. Every phase ends with
upload→qualify→download still working and its tests passing.
→ [14_DEVELOPMENT_ROADMAP.md](14_DEVELOPMENT_ROADMAP.md)

---

## Where this product can actually win

Not "HubSpot but cheaper". Four defensible positions, all of which fall out of
what the existing engine already does well:

| | Why it's defensible |
|---|---|
| **Evidence, not scores** | Every competitor gives an opaque lead score. This shows the observation, the rule version, the confidence, and says "I can't tell" when it can't. For consultative selling that is a better product, not just a different one. |
| **Free ICP experimentation** | Evidence and rules are separate, so "what if we targeted 50–200 instead of 20–50?" is answerable in seconds across the whole database — with an impact preview. Killer demo, real utility. |
| **Cost transparency on enrichment** | This project already learned it the hard way: $240 vs $0.49 vs free for the same 123 companies. Cost preview before running, and per-workspace budgets, addresses a universal frustration with Apollo/ZoomInfo/Clay that nobody handles well. |
| **Arabic-first B2B CRM** | HubSpot and Salesforce are weak in the Gulf. RTL-native, Hijri-aware, PDPL-conscious, built from real regional data. |

The long-term moat is the **disqualification feedback loop**: when a rep marks a
QUALIFIED account as junk, that is training data. Capturing a "why?" from day one
costs nothing and compounds.

---

## Top risks

| Risk | Mitigation |
|---|---|
| **Scope.** This brief is several years of work for a small team. | Ruthless v1 = the consultancy's own workflow end to end. Everything else deferred with a written reason in [13](13_PRODUCT_BACKLOG.md). |
| **The working tool gets broken during refactor.** | Strangler-fig plan; existing tests are a release gate every phase. |
| **Metadata-driven becomes unusably slow.** | Load test at 100k accounts in Phase 2, not Phase 8. Performance budgets in [02](02_PRODUCT_REQUIREMENTS.md). |
| **`snapshots.json` is a single unbacked file holding the expensive asset.** | **Back it up today**, before any migration work begins. 223 companies of collection is the most valuable thing in the repo. |
| **AI features on an unstable schema.** | No AI layer until the data model is stable. Confident nonsense is worse than no feature. |

---

## What to decide before writing platform code

Four questions block architecture. The rest can be answered during Phase 1.

| ID | Question | Blocks |
|---|---|---|
| **Q-01** | Is v1 single-tenant-deployed, or multi-tenant from day one? | Every table, query, cache key and job |
| **Q-03** | Will the hosted product offer LinkedIn-derived data, or only BYO-session self-hosted? | Prospecting roadmap, legal exposure |
| **Q-04** | Expected scale at 12 months — accounts, contacts, users, workspaces? | Storage strategy, infra sizing |
| **Q-10** | Actual v1 deadline and team size? | All of [14](14_DEVELOPMENT_ROADMAP.md) |
| **Q-11** | Custom fields per object at p90? | **Slot allocation — cheap now, expensive once data exists** |
| **Q-12** | Enterprise buyer expected within 18 months? | Whether SSO/SCIM/sandbox/SOC 2 join the critical path |
| **Q-13** | Target availability and p99 latency? | SLOs cannot be derived from nothing |

Full register: [02_PRODUCT_REQUIREMENTS.md](02_PRODUCT_REQUIREMENTS.md#open-questions-register).

---

## Immediate next steps

1. **Back up `snapshots.json`.** Today. Unrelated to any decision.
2. Answer Q-01, Q-03, Q-04, Q-10, and now **Q-11** (slot sizing), Q-12, Q-13.
3. Read [15_TECHNICAL_REVIEW.md](15_TECHNICAL_REVIEW.md) and sign off the decision register in [04](04_SYSTEM_ARCHITECTURE.md#decision-register) — now 14 ADRs.
4. Confirm the revised phasing in [14](14_DEVELOPMENT_ROADMAP.md): Phase 0 is a real phase, and **Phase 1a's load test is a stop-the-line gate**.
5. Only then: first platform code, starting with the persistence seam behind the existing qualification engine.
