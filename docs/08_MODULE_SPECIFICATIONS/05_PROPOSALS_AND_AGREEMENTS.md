# Proposals & Agreements

**Status:** Planned · **Phase:** 5 · **Depends on:** platform, deals, documents, integrations

---

## 1. Purpose

Turn a deal into a document, and a signed document into a tracked commitment
with renewal dates that do not get missed.

---

## 2. Two corrections to the brief

### 2.1 Document generation is a provider, not Google

The brief specifies "Google Docs, Apps Script, Drive" inside a core module, in a
document whose central principle is vendor abstraction (contradiction A7).

**Therefore:** a **Document Generation Provider** contract — render template +
data → document + PDF + storage URI. Google Workspace is the first
implementation, not a dependency (FR-DOC-002). Cheap now; very expensive when a
customer requires Microsoft 365 or on-premise storage.

### 2.2 An agreement is not one proposal

The brief says Agreement → belongs to one Proposal. Real service contracting
does not work that way:

- An MSA covers many SOWs
- A renewal supersedes an earlier agreement, sometimes consolidating several
- Some agreements never had a proposal — inbound, referral, verbal

**Therefore:** Agreement links to a **Deal** (required) and **zero or more
Proposals** (optional), with `supersedes_agreement_id` forming the renewal chain
(FR-DOC-004, 005).

---

## 3. Configuration surface

Proposal templates and merge fields · agreement types · signing statuses ·
renewal notice periods · reminder schedules · numbering schemes · approval
requirements by value threshold · storage and generation providers.

---

## 4. Behaviour

### Proposals

- Belong to one deal; content is generated from a template plus record data
- **Versioned**: each issued version is immutable; a change creates v2
- Versions are individually viewable and diffable (FR-DOC-001)
- Merge fields resolve from any record field, including custom ones — falling
  out of the metadata engine for free
- Line items flow from the deal, so the proposal cannot silently disagree with
  the pipeline
- Optional approval before sending, by value threshold

### Agreements

- Track signing status, signature dates, effective and expiry dates, renewal
  terms, notice periods (FR-DOC-006)
- **Renewal and notice dates generate reminders** (FR-DOC-007). Notice periods
  are the ones actually missed — a 90-day notice on a 12-month contract means
  the decision point is month nine, not month twelve, and the reminder must fire
  against the notice date.
- `supersedes_agreement_id` makes contract history navigable rather than a pile
  of similarly-named PDFs
- Signing an agreement moves the deal to won and the account to `customer`

### Files

Object storage with signed, expiring URLs. Never database blobs (FR-DOC-008).

---

## 5. Interfaces

**Offers:** generate proposal, create version, compare versions, send, record
signature, create renewal, query expiring agreements.

**Emits:** `proposal.created/versioned/sent/viewed`,
`agreement.created/signed/expiring/expired/renewed`.

**Consumes:** `deal.stage_changed` (optionally trigger generation),
`deal.won`.

**Provider capabilities:** document generation, file storage, e-signature (v2).

---

## 6. UI surfaces

Proposal list and detail with version history · template editor with merge-field
picker · version diff · agreement detail with signing status and dates ·
renewal pipeline (expiring in 30/60/90 days) · document preview.

The **renewal pipeline** is quietly one of the highest-value screens in the
product for a consultancy — recurring revenue lost to a missed notice date is
pure, avoidable loss.

---

## 7. Edge cases

| Case | Behaviour |
|---|---|
| Deal changes after a proposal is issued | Proposal keeps its issued figures; a banner flags divergence |
| Proposal sent then deal reopened | Proposal remains valid; new version required to change terms |
| Agreement with no proposal | Allowed — inbound and verbal deals are real |
| Agreement superseding several | Many-to-one supersession supported; chain navigable |
| Renewal with different terms | New agreement, superseding, with its own line items |
| Expiry passing with no action | Account moves to `churned` by configurable automation, not silently |
| Notice period longer than remaining term | Reminder fires immediately, flagged |
| Generation provider unavailable | Job retries; failure surfaces to the owner, never silent |
| Template referencing a deleted field | Publish blocked, referrer named (FR-PLAT-004) |
| Arabic contract text | RTL preserved through generation and PDF export |
| Signed PDF must never change | Immutable once signature is recorded; corrections require a new version |

---

## 8. Acceptance criteria

- [ ] Proposal generation goes through a provider contract with no vendor name in business logic (FR-DOC-002)
- [ ] Proposal versions are immutable and diffable (FR-DOC-001)
- [ ] An agreement links to zero or more proposals, and standalone agreements are creatable (FR-DOC-004)
- [ ] Renewal chains are navigable via supersession (FR-DOC-005)
- [ ] Notice-period reminders fire against the notice date, not the expiry date (FR-DOC-007)
- [ ] Files are in object storage with signed URLs (FR-DOC-008)
- [ ] Merge fields resolve custom fields with no code change
- [ ] Arabic content survives generation and PDF export with correct direction
- [ ] Signing moves the deal to won and the account to `customer` by configurable automation
