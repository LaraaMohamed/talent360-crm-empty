# Development Roadmap

**Status:** Draft v0.1 · **Owner:** Product & Architecture · **Last reviewed:** 2026-08-03

---

## 1. Why the original phasing changes

The brief's ten phases are a sensible feature inventory and a risky build order.
Three problems:

**Phase 1 ships nothing.** Authentication, workspace, roles, navigation, layout
and a design system produce no user value. Meanwhile the tool currently in daily
use presumably stops improving. Weeks pass with the business worse off than
before the project started.

**The dependency graph is violated.** Qualification (Phase 3) is built before the
provider architecture (Phase 4) that it needs — so it gets built twice. Automation
(Phase 9) arrives after five phases whose behaviour *is* automation — so that
logic gets hardcoded eight times and then unpicked.

**The existing system has no protection.** Nothing in the plan says "and the
working tool still works". That is how brownfield projects quietly destroy the
thing that was paying for them.

### The revised approach: strangler fig

The new system grows **around** the working one. The old system keeps running
until each capability is replaced *and verified*, then that piece is retired.

**The release gate, every phase, no exceptions:**

```
✓ test-signals.mjs and test-panels.mjs pass unmodified
✓ Re-qualifying the 223 known companies produces byte-identical output
✓ Upload → qualify → download works end to end
✓ Exported CSV preserves every source column, byte-identical
```

Four checks, all cheap, all automated. They are the difference between evolving
an MVP and gambling with it.

---

## 2. Phases

Durations are **relative effort**, not calendar commitments — sizing needs
`[OPEN: Q-10]` answered.

### Phase 0 · Safety net — *small*

Before anything is built on top of it.

- Back up `snapshots.json` off-machine, with a verified restore
- Existing 36 tests into CI as blocking gates
- Golden-output check over the 223 known companies
- Characterisation tests for the current upload→qualify→download flow

**Exit:** the working system cannot break silently. **Value:** the asset is safe.

> This phase is not overhead. Every later phase depends on being able to prove
> nothing regressed, and that proof does not exist today.

### Phase 1a · Persistence foundation — *medium* · **STOP-THE-LINE GATE**

The original Phase 1 bundled ten workstreams under one heading. That is not a
phase, it is a project, and it hid the one decision that can invalidate
everything above it. Split.

- Tenancy with row-level security
- **`SET LOCAL` transaction scoping, with a blocking CI test that a pooled
  connection retains no tenant context** — this is a data-leak class, not a
  performance concern
- Metadata engine: objects, fields, versioning, deprecation
- **Slot-projection custom-field storage** ([ADR-03](04_SYSTEM_ARCHITECTURE.md#decision-register))
- Transactional outbox
- Partitioning for the unbounded tables
- SOC 2 evidence collection begins ([17](17_ENTERPRISE_READINESS.md)) — the
  constraint is elapsed time, not the controls

**Exit gate — all four, or the phase does not end:**

1. A custom field flows end to end: form → list → filter → sort → API → import
2. **Load test at the outlier profile** (1M accounts) meets NFR-PERF-001/001b
3. Cross-workspace access fails, proven by test, including under pooling
4. Slot allocation validated against the p90 custom-field count (`[OPEN: Q-11]`)

**If gate 2 fails, stop.** Everything built above a storage strategy that cannot
meet its budget is wrong. In Phase 1a that is a week's rework; in Phase 8 it is
the product.

### Phase 1b · Platform services — *medium*

- Background jobs with per-workspace concurrency
- Audit log, complete from the start — gaps cannot be backfilled
- Auth, workspaces, memberships
- **MFA and session policy** — cheap now, awkward to retrofit into an
  established auth flow
- Permission model, including team hierarchy and record sharing
- Design system foundation, RTL-capable from the first component
- Seed template pack
- Observability: metrics, tracing, per-tenant support dashboard

**Exit:** an admin configures a workspace end to end, and support can diagnose
one tenant's health without writing a query.

### Phase 2 · Qualification module — *large*

The strangler fig proper. The existing engine becomes a platform module without
stopping.

- Evidence repository interface, JSON file as first implementation
- PostgreSQL as second implementation; dual-write; compare; cut over
- Immutable versioned verdicts
- Rules as metadata, producing identical results to current code
- Rule impact preview
- Accounts and contacts with lifecycle stages
- Verdict UI: evidence, age, staleness, REVIEW resolution, override with reason
- Provider contract; existing collector wrapped unchanged
- Import engine

**Exit:** the platform does everything the standalone tool does, plus verdict
history and rule authoring. Only then is the standalone server retired.

**Value:** the design partner gains rule authoring and verdict history while
losing nothing.

### Phase 3 · Working CRM — *medium*

The first phase where the product becomes a CRM.

- Activity timeline and audit separation
- Tasks with correct timezone and Fri–Sat weekend handling
- Notifications
- Saved views, filters, data table
- Duplicate detection and reversible merge
- Global search, command palette
- Seeded lifecycle automations (prospect → qualified → engaged → customer)

**Exit:** the consultancy can run its whole prospect-to-relationship workflow
without spreadsheets.

### Phase 4 · Deals — *medium*

- Pipelines and stages as metadata
- **Line items and derived values** — the correction that makes forecasting real
- Multi-currency with FX frozen at close
- Kanban, stage requirements, loss reasons
- Verdict → deal traceability

**Exit:** deals with mixed one-time and recurring revenue forecast correctly.

### Phase 5 · Documents — *medium*

- Document generation provider contract; Google Workspace as first implementation
- Proposal templates, versioning, diff
- Agreements with supersession chains
- Renewal and **notice-period** reminders
- Object storage with signed URLs

**Exit:** quote to signed agreement without leaving the product.

### Phase 6 · Insight — *medium*

- Dashboards and widget framework
- Reports
- Forecasting separating one-time from recurring
- Prospecting dashboard: verdict distribution, **cost per qualified account**

**Exit:** the founder answers "how is the business doing?" in the product.

### Phase 7 · Automation & platform — *medium*

- Rule builder UI with dry run
- Loop protection and execution log
- Public REST API generated from metadata
- Outbound webhooks
- Waterfall enrichment with budgets

**Exit:** customers extend the product without engineering involvement. This is
also the phase that proves nothing was hardcoded.

### Phase 8 · Multi-tenant readiness — *medium*

- Self-serve workspace provisioning from the template pack
- Billing and subscription
- Onboarding
- Data residency and retention per `[OPEN: Q-02, Q-07]`
- Hosted-safe provider set per `[OPEN: Q-03]`
- Support access with time-boxing and audit

**Exit:** a second workspace is provisioned with **no engineering involvement**.
That is the real test of everything above.

### Phase 9 · AI layer — *large*

Deliberately last. AI over an unstable schema produces confident nonsense and
debt that cannot be unpicked.

Ordered by value-to-risk:

1. **Qualification assistant** — draft a rule from a description of the ICP.
   Highest value: the evidence model makes it verifiable rather than magical.
2. **Data extraction** — pull structured facts from unstructured evidence.
3. **Meeting and call summarisation** — well-understood, low risk.
4. **Email drafting** — grounded in real account and verdict context.
5. **Deal health and next-best-action** — needs enough closed history to be
   honest rather than decorative.

**Precondition:** the schema has been stable for a full phase, and there is
enough closed-deal history for predictions to be evaluated rather than believed.

---

## 3. Sequencing rationale

| Decision | Why |
|---|---|
| Phase 0 exists at all | The working system has no protection today |
| Event bus and jobs in Phase 1 | Otherwise Phases 3–6 hardcode what Phase 7 was meant to configure |
| Provider contract with qualification (Phase 2) | The engine already has a provider seam; splitting them means writing it twice |
| Load test in Phase 1 | The storage strategy is the highest architectural risk; a wrong answer invalidates everything above it |
| Qualification before Deals | It is the existing asset and the differentiator; Deals is well-trodden ground |
| Deals before Documents | A proposal needs line items to be worth generating |
| Automation UI late (Phase 7) | The *engine* is early; only the editor is late |
| AI last | Everything else must be stable and measurable first |
| Multi-tenant readiness Phase 8 | Design for it throughout; build the commercial surface once the product is worth selling |

---

## 4. Milestones

| M | Name | Proves |
|---|---|---|
| **M0** | Nothing can break silently | Phase 0. The asset is safe and regressions are caught. |
| **M1a** | **The storage strategy holds** | Phase 1a. A custom field flows end to end at the outlier profile, within budget, with isolation proven. The riskiest decision, settled first. |
| **M1b** | A workspace is configurable and operable | Phase 1b. |
| **M2** | The engine is a module | Phase 2. Rule authoring and verdict history, nothing lost. |
| **M3** | Spreadsheets retired | Phase 3. The design partner's daily workflow lives here. |
| **M4** | Revenue is modelled correctly | Phase 4. Mixed one-time and recurring forecasts hold up. |
| **M5** | Quote to signature | Phase 5. |
| **M6** | The business is measurable | Phase 6. Including cost per qualified account. |
| **M7** | Extensible without us | Phase 7. API and automation prove nothing is hardcoded. |
| **M8** | A second customer is possible | Phase 8. Provisioning with no engineering. |

M0–M3 constitute a genuinely useful product for the design partner. If the
project stopped at M3 it would already have replaced spreadsheets, preserved the
qualification engine, and made it configurable. **That is the real v1.**

---

## 5. What could go wrong

| Risk | Signal it is happening | Response |
|---|---|---|
| **Metadata storage too slow** | Phase 1a load test misses NFR-PERF-001 | Stop-the-line. Revisit ADR-03 before building on it. Cheap now, fatal later. |
| **Slots under-allocated** | A tenant exhausts filterable slots | Cheap to widen before data exists, expensive after. Sized from `[OPEN: Q-11]` in Phase 1a. |
| **Outbox lag unnoticed** | Automations silently stop firing | The outbox-lag alert is the only signal. It is mandatory, not nice-to-have. |
| **Enterprise deal arrives early** | Security questionnaire during a sales cycle | `[OPEN: Q-12]`. If yes, SSO/SCIM/sandbox/SOC 2 move onto the critical path and this plan changes materially. |
| **Scope creep** | Phases growing new bullets mid-flight | Every addition goes to the backlog with a priority, not into the current phase |
| **The working tool breaks** | A release gate fails | Do not proceed. The gates exist for exactly this. |
| **Existing engine gets rewritten** | Someone "cleans up" `hcm.js` or `signals.js` | These encode bugs found against real data. Move them; do not rewrite them. |
| **REVIEW gets collapsed** | A filter, chart or export with two verdict values | Reject in review. This is the product's core idea. |
| **Legal exposure on collection** | External customers asking for LinkedIn data | `[OPEN: Q-03]` must be answered before the first external customer, not after |
| **Blocked questions stay open** | Q-01/03/04/10 unanswered at Phase 1 start | Phase 1 cannot start. Escalate rather than guess. |

---

## 6. Where the existing code goes

| Today | Fate | Phase |
|---|---|---|
| `lib/hcm.js`, `lib/offshoring.js` | **Move unchanged** into the domain layer, driven by metadata | 2 |
| `lib/signals.js`, `normalize.js`, `labels.mjs` | **Keep.** Become configurable dictionaries. | 2 |
| `lib/panels.mjs`, `company.mjs` | **Keep.** Stay self-contained — they run in page context. | 2 |
| `lib/csv.mjs`, `select.mjs` | **Keep.** Become the import/export core. | 2 |
| `lib/verdicts.mjs` | **Evolve** into the verdict service with versioning | 2 |
| `scrape.mjs` | **Wrap** as a provider. Internals unchanged. | 2 |
| `qualify.mjs` | **Keep working** as a thin caller; retire when the platform matches it | 2 |
| `server.mjs`, `public/` | **Keep working** until replaced feature-for-feature and verified | 2 |
| `snapshots.json` | **Migrate** behind the repository interface. Back up first. | 0 → 2 |
| `test-*.mjs` | **Promote** to release gates | 0 |
| `hcm-qualifier-1/`, `offshoring-qualifier-1/` | **Keep deployed.** Become provider implementations. | 2 |
| `li-insights/` | Reference only. No changes. | — |
| Root-level loose `.js` files | Superseded copies. Archive once Phase 2 confirms they are unused. | 2 |

**Nothing in the first column is deleted before its replacement is verified by
the release gate.** That sentence is the whole migration strategy.

---

## 7. Before Phase 1 starts

1. **Back up `snapshots.json`.** Today. Independent of every other decision.
2. Answer **Q-01** (tenancy), **Q-03** (hosted LinkedIn data), **Q-04** (scale),
   **Q-10** (deadline and team size).
3. Sign off the decision register in [04](04_SYSTEM_ARCHITECTURE.md#decision-register).
4. Confirm Phase 0 is accepted as a real phase.
5. Agree the four release gates as **blocking**, not advisory.
