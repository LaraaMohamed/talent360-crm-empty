# Domain Model

**Status:** Draft v0.1 · **Owner:** Architecture · **Last reviewed:** 2026-08-03

The business concepts, their meaning, and the rules that hold regardless of how
anything is stored or displayed. Storage is [05](05_DATABASE_DESIGN.md).

---

## 1. Correcting the shape

The brief presents the model as a single chain:

```
Workspace ↓ Users ↓ Teams ↓ Accounts ↓ Contacts ↓ Deals ↓ Proposals ↓ … ↓ Integrations
```

That reads as a hierarchy, and it is not one. Three things are wrong with it and
each has schema consequences:

1. **Tasks, Activities, Notes and Documents attach to several parents.** A task
   belongs to an account *or* a contact *or* a deal *or* a proposal. That is
   polymorphic attachment, not a level in a tree.
2. **Lists, Views, Automations and Integrations are workspace configuration**,
   not children of Documents. Putting them in the chain implies a containment
   that does not exist.
3. **Contacts are not owned by Deals.** A contact participates in many deals
   over years. Modelling that as containment loses the history.

The real shape is three distinct planes:

```
CONFIGURATION PLANE          RECORD PLANE                EVIDENCE PLANE
(what the workspace is)      (what the business does)    (what we observed)

Workspace                    Account ──┬── Contact       Evidence Snapshot
 ├ Object Definitions          │       │                        │
 ├ Field Definitions           │       └── Deal ──┬── Proposal  │
 ├ Pipelines & Stages          │                  │      │      │
 ├ Activity Types              │                  │      └── Agreement
 ├ Qualification Rules ────────┼──────────────────┼─────────────┤
 ├ Views & Dashboards          │                  │             │
 ├ Automations                 └── Verdict ◄──────┴─────────────┘
 ├ Roles & Permissions
 ├ Providers                 Attached to any record:
 └ Seed Template Pack        Task · Activity · Note · Document · Audit Event

                             Users · Teams · Memberships
```

The **Evidence Plane** is the part no competitor has, and the part most likely
to be flattened away by accident. Section 5 defends it.

---

## 2. Configuration plane

Everything here is data, versioned, workspace-scoped, and referenced externally
by a stable `key`.

### Workspace

The tenant. The isolation boundary, the billing boundary, and the configuration
boundary. Nothing is shared across workspaces in v1.

Carries: name, base currency, timezone, locale, weekend days, fiscal year start,
date system (Gregorian / Hijri / both), retention policy, provider budgets.

### User, Membership, Team

A **User** is a global identity — one person, one login, possibly several
workspaces. A **Membership** binds a user to a workspace with a role. A **Team**
is an in-workspace grouping used for record scoping and assignment.

> A user's permissions are a property of their *membership*, never of the user.
> Getting this wrong is what makes multi-workspace support a rewrite later.

### Object Definition & Field Definition

Objects (Account, Contact, Deal…) and their fields are themselves data. A field
definition carries type, labels, validation, default, help text, and three
deliberate flags — `filterable`, `sortable`, `searchable` — that decide whether
the platform spends an index on it.

Those flags are not conveniences. They are the mechanism that keeps
"everything configurable" from becoming "nothing is fast".

### Pipeline & Stage

A pipeline is an ordered set of stages scoped to an object (normally Deal).
A stage carries key, label, order, probability, type (`open` / `won` / `lost`),
required-fields-to-enter, and an optional WIP limit.

### Activity Type

Key, label, icon, colour, its own field set, and whether users may log it
manually. `email`, `call`, `meeting` are seed data — not enum members in code.

### Qualification Rule

A named, versioned, testable predicate over evidence, bound to a service line.
Full specification in [08/01](08_MODULE_SPECIFICATIONS/01_PROSPECTING_AND_QUALIFICATION.md).

### Service Line

Recruitment, HCM, Offshoring, Strategy & Performance — **as seed data**. Each
carries a default pricing model, a default qualification rule and a default
pipeline. A workspace can add, rename or remove them without code.

---

## 3. Record plane

### Account

An organisation. The central record; almost everything hangs off it.

**Lifecycle stage** is the field that lets prospecting and CRM share one table:

```
prospect ──► qualified ──► engaged ──► customer ──► churned
    │             │
    └─────────────┴──────► disqualified
```

- `prospect` — imported or discovered, not yet judged. **Hidden from default views.**
- `qualified` — a rule returned QUALIFIED. Eligible for outreach.
- `engaged` — has an open deal.
- `customer` — has a signed agreement.
- `churned` / `disqualified` — terminal, retained for learning.

This is why 2,000 uploaded companies do not pollute the CRM: they are prospects
until a verdict promotes them.

Identity attributes that matter here: domain, LinkedIn slug, **Commercial
Registration number** (a strong natural key in Saudi Arabia), country.

### Contact

A person at an account. Belongs to exactly one account.

Roles are a **set of flags**, not one exclusive type — someone can be both
primary contact and decision maker, and the brief's flat list implied otherwise.

Personal-data attributes are first-class because they carry obligations:
`data_source`, `acquired_at`, `lawful_basis`.

### Deal

A commercial opportunity on one account, in one pipeline, at one stage.

**The deal does not carry a price.** It carries **Line Items**, and its value is
derived from them. This is the single most consequential correction to the brief:

| Service | Pricing model | Recurrence |
|---|---|---|
| Recruitment | % of first-year salary × placements | one-time |
| HCM | per seat × months | recurring |
| Offshoring | per headcount × months, often ramping | recurring |
| Strategy | fixed fee, milestone-billed | one-time |

Derived figures — **one-time total**, **MRR**, **ARR**, **weighted value** —
are computed separately and never added together. A dashboard that shows
"pipeline: 2.4M" mixing a placement fee with 24 months of retainer is lying.

### Proposal

A versioned commercial document belonging to a deal. Each version is immutable
once issued; a change makes v2. Rendered through a document-generation provider.

### Agreement

The executed contract. Belongs to a **deal** (required) and references **zero or
more proposals** (optional) — because MSAs cover many SOWs, renewals consolidate,
and some deals close without a formal proposal.

`supersedes_agreement_id` forms the renewal chain, so contract history is
navigable rather than a pile of similarly-named PDFs.

---

## 4. Attachments — polymorphic across records

### Task

An intention with an owner and a due date. Attaches to any record.

### Activity — the timeline

What happened, for humans. Typed by workspace metadata. **Editable and
deletable**, because a rep who typed the wrong call note must be able to fix it.

Rolls up: an activity on a deal appears on that deal's account timeline.

### Audit Event — the record of record

Every mutation. Actor, timestamp, object, before, after, source (UI / API /
automation / import). **Never editable. Never deletable.** Different audience,
different volume, different retention.

Selected audit events *project* into the timeline — stage changes, owner
changes, verdict changes — and which ones is configurable. This is how the brief's
"every action creates an activity" is honoured without drowning the timeline in
`custom_field_47: null → ""`.

### Note & Document

Free text with @mentions; and files in object storage with signed URLs, never
database blobs.

---

## 5. Evidence plane — the part that must not be flattened

This is the existing system's best idea, and it is invisible in the brief.

### Evidence Snapshot

**What was observed**, verbatim, attributed and timestamped. Raw aggregate
panels, enrichment payloads, uploaded rows. Immutable.

```
{ subject: linkedin.com/company/acme,
  provider: local-browser,  collected_at: 2026-08-02T09:14:00Z,
  payload: { totalMembers: 252, locations: [...], functions: [...] } }
```

### Verdict

**What was concluded**, and by what. Also immutable.

```
{ subject: acme, rule: hcm, rule_version: 3, evidence_ref: snap_881,
  verdict: REJECTED, confidence: 1.0, computed_at: 2026-08-03T11:40:00Z,
  reasoning: ["FAIL: headcount 252 in 20-50", ...] }
```

### The three invariants

**I1 — Evidence and conclusion are separate.** Collection is expensive and
rate-limited; evaluation is free and offline. Because of this, re-qualifying 223
companies under a new rule took seconds and cost nothing during development.
Collapsing them — storing "qualified: true" on the account and discarding the
panels — destroys the property permanently.

**I2 — Verdicts are immutable and versioned.** Re-running appends. This is not
theoretical hygiene:

> Changing the HCM headcount rule from `≥ 20` to `20–50` changed **117 of 223
> verdicts**, three from QUALIFIED to REJECTED. Nothing recorded it. In a CRM
> with reps working those accounts, the system would have contradicted itself
> overnight with no explanation available to anyone.

An account therefore shows its current verdict *and* its history, and can always
answer "why did this change?" with either "the rule changed" or "the evidence
changed".

**I3 — Absence of evidence is never a negative answer.** Three verdicts, always:

| Verdict | Meaning | Safe to act on? |
|---|---|---|
| `QUALIFIED` | The evidence proves the rule is met | Yes |
| `REJECTED` | The evidence proves the rule is not met | Yes |
| `REVIEW` | **The evidence cannot answer the question** | No — get more evidence |

REVIEW exists because LinkedIn's panels list only the top few rows. "Egypt is
not listed" means *not in the top five*, not *zero*. Collapsing those two either
discards real leads or ships bad ones.

The direction of the coverage gate mirrors the kind of claim:

- **Presence test** ("≥ 2 employees in Egypt") — observing 2 proves 2 at any
  coverage. Incomplete data can only cause false negatives, so coverage gates
  the **REJECT**.
- **Absence test** ("≤ 1 HR employee") — finding none proves nothing unless you
  looked everywhere. So coverage gates the **QUALIFY**.

Any new rule type must declare which kind it is. This is a property of the
*claim*, not of the data source, and it is the deepest idea in the existing
codebase.

---

## 6. Cross-cutting rules

**Ownership.** Every record has exactly one owner. Ownership drives record-scope
permissions and default assignment. Transfer is audited.

**Soft delete.** Nothing is destroyed on user action. Hard delete is a separate,
audited job that must also reach evidence snapshots, caches, exports and
generated documents — the copies people forget.

**Idempotent identity.** Every record carries `external_id`. Re-importing the
same source is a no-op. Without this, "re-upload the corrected file" doubles the
database.

**Temporal honesty.** Anything derived from an observation carries the time of
observation and is presented with its age. A two-year-old QUALIFIED is not a
lead.

**Currency.** Money is an amount plus a currency, always. The FX rate used is
stored on the record at close, never re-derived — otherwise last year's closed
revenue changes when the exchange rate moves.

---

## 7. Glossary of the ambiguous terms

Terms that mean different things to different people, pinned down.

| Term | In this product |
|---|---|
| **Workspace** | The tenant. Isolation, billing and configuration boundary. |
| **Team** | A grouping of members *inside* a workspace, for scoping and assignment. |
| **Account** | An organisation, at any lifecycle stage from prospect to churned. |
| **Prospect** | An account at lifecycle stage `prospect` — not a separate object. |
| **Lead** | Deliberately unused. It means five different things across the competitors. |
| **Qualification** | Evaluating a rule against evidence to produce a verdict. |
| **Verdict** | An immutable QUALIFIED / REJECTED / REVIEW, with its rule version and evidence. |
| **Evidence** | Raw observed data, attributed to a provider and a moment. |
| **Coverage** | The fraction of a population actually observed. Gates conclusions. |
| **Activity** | A user-facing timeline entry. Editable. |
| **Audit event** | An immutable system record of a mutation. Never editable. |
| **Provider** | An implementation of an external-capability contract. |
| **Service line** | A category of work sold. Seed data, not code. |
| **Line item** | One priced component of a deal. |
| **Template pack** | A versioned bundle of seed metadata used to provision a workspace. |
