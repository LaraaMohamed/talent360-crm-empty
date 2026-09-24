# Product Vision

**Status:** Draft v0.1 · **Owner:** Product · **Last reviewed:** 2026-08-03

---

## The one-sentence version

A metadata-driven CRM for B2B service businesses that can **show its work** —
where every qualified lead comes with the evidence, the rule, and the confidence
behind it, and where the system says "I don't know" instead of guessing.

## The problem

Small and medium B2B service companies — recruitment firms, HR consultancies,
offshoring providers, advisory practices — are badly served by the incumbents:

- **HubSpot / Salesforce** are built around a product-sales motion. Configuring
  them for a multi-service consultancy means fighting the tool, and the
  configuration ceiling arrives fast in the cheap tiers.
- **Pipedrive** is pleasant and shallow. It runs out of room the moment a deal
  has more than one service line.
- **Monday CRM** is flexible and structurally weak — it is a spreadsheet that
  learned to look like a CRM, with no real domain model underneath.
- **All of them** treat prospecting as an opaque score. You get a number, not a
  reason. When the number is wrong, you cannot tell why, and you cannot change
  how it is calculated.

Meanwhile the actual work of a consultancy — deciding which companies are worth
approaching, and for which service — is the part these tools help with least.

## What we are building

A CRM in which **configuration is the product**. Pipelines, fields, activity
types, dashboards, permissions, import mappings, automations and qualification
rules are all data, editable by an administrator, versioned, and auditable.

Around a core that the incumbents do not have: a **qualification engine that
reasons from evidence**, separates what it observed from what it concluded, and
refuses to state a conclusion the data cannot support.

## Who it is for

| Horizon | User | Shape |
|---|---|---|
| **v1** | One HR consultancy — the design partner | Single workspace, ~5–15 users, real daily use |
| **v2** | Similar consultancies in the Gulf and Egypt | Multi-tenant SaaS, self-serve onboarding |
| **v3** | B2B service SMBs generally | Template packs per vertical, partner ecosystem |

v1 is a real product used in anger by real salespeople, not a demo. That is the
point: the design partner is the quality bar.

## What makes it different

Ranked by defensibility, not by demo appeal.

**1. Evidence, not scores.** Every verdict cites what was observed, which rule
version produced it, how confident it is, and when it was computed. A
salesperson can argue with it. An administrator can change it. That is a
fundamentally different relationship with the tool than a black-box score.

**2. Three verdicts, not two.** `QUALIFIED` / `REJECTED` / `REVIEW`. REVIEW
means *the available data cannot answer the question* — which is not "no". This
sounds like a detail; it is the difference between a list you can trust and one
you cannot. See [ADR-0004](adr/0004-three-verdict-qualification.md).

**3. Rules are free to change.** Because expensive evidence collection is
separated from cheap rule evaluation, re-qualifying the whole database under a
new ICP costs nothing and takes seconds — with an impact preview before you
commit. Competitors charge you, in time or credits, to change your mind.

**4. Cost is visible before you spend it.** Enrichment shows what a run will
cost before it runs, tracks spend per provider, and enforces per-workspace
budgets. Everyone who has used Apollo, ZoomInfo or Clay knows why this matters.

**5. Arabic-first is a first-class option.** RTL layout, bidirectional text,
Hijri dates alongside Gregorian, Fri–Sat weekends, PDPL-aware data handling.
Not a translation bolted on later.

**6. Multi-service deals are native.** A deal can carry recruitment, HCM and
offshoring lines with different pricing models, and forecast them correctly
instead of adding a retainer to a placement fee.

## Design philosophy

> Everything configurable. Nothing hardcoded. Everything versioned. Everything
> searchable. Everything auditable.

Held honestly, with the sharp edges named:

| Principle | The honest version |
|---|---|
| Everything configurable | Within a **typed, validated metadata model**. Configurability is not "anything goes" — an admin cannot create an invalid state. |
| Nothing hardcoded | Service lines, stages and fields ship as **seed data**, never as code branches. Enforced in CI. |
| Everything versioned | Three distinct mechanisms — document revisions, config versions, record history — not one. |
| Everything searchable | Bounded by an index budget. Fields are marked searchable/filterable deliberately. |
| Everything auditable | Audit is a **separate, immutable store** from the user-facing timeline. |

And one principle the brief did not state, which the existing engine already
embodies and which should be adopted platform-wide:

> **Never let missing data masquerade as a negative answer.**

## Success criteria

**v1 is successful if,** after 90 days of real use by the design partner:

| Measure | Target |
|---|---|
| The consultancy has stopped using spreadsheets for pipeline | Yes/no |
| Qualification runs are self-serve by a non-technical admin | Yes/no |
| A new service line can be added with zero code changes | Yes/no |
| Time from CSV upload to a working qualified list | < 5 minutes for cached companies |
| Verdicts a rep disputes | < 10% of QUALIFIED |
| The existing upload→qualify→download flow still works | Every phase, verified by tests |

**v2 readiness** is a separate bar: a second workspace can be provisioned from
the template pack with no engineering involvement.

## Explicit non-goals for v1

Saying no here is what makes v1 shippable.

- **Not** an ATS or recruitment delivery system. It manages the sale, not the placement.
- **Not** a marketing automation platform. No campaigns, no landing pages, no lead scoring by email opens.
- **Not** an accounting or invoicing system. It ends at signed agreement.
- **Not** email or calendar sync in v1 — designed for, not delivered.
- **Not** a mobile app. Responsive web only.
- **Not** offline-capable.
- **No** AI features until the data model is stable. See [08](14_DEVELOPMENT_ROADMAP.md); AI on an unstable schema produces confident nonsense and unpickable technical debt.

## The modules

Grouped by purpose rather than listed flat, because the grouping *is* the
architecture.

**Records** — Accounts, Contacts, Deals, Documents
**Sales execution** — Tasks, Activities, Proposals, Agreements
**Acquisition** — Prospecting, Qualification Engine, Lists, Import
**Insight** — Dashboards, Reports, Views
**Platform** — Automations, Integrations, Settings, Permissions, Audit

The Platform group is not a feature area. It is the substrate every other module
is built on, and it is why the product can be configured rather than customised.
