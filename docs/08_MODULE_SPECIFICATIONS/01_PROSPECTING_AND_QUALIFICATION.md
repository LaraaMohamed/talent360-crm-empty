# Prospecting & Qualification

**Status:** Exists — in production use · **Phase:** 0–2 · **Owner:** —
**Depends on:** platform (metadata, events, jobs), records, integrations

> This is the only module that already works. **Its behaviour is the
> specification.** Everything below marked ⚑ describes what the system does
> today and must continue to do.

---

## 1. Purpose

Decide which companies are worth approaching, for which service line, and
**show the reasoning**.

It answers one question per rule, honestly: *does the available evidence prove
this company matches this ICP?* — with "the evidence cannot say" as a legitimate
answer.

**Not responsible for:** managing customer relationships (records), outreach
sequencing (out of scope for v1), or contact discovery beyond what a rule needs.

---

## 2. Current state

Working today, in daily use, at `local-scraper/`.

| Component | Role | Disposition |
|---|---|---|
| `lib/hcm.js` | HCM rule: headcount 20–50 AND HR ≤ 1 | **Keep unchanged.** Pure function. |
| `lib/offshoring.js` | Offshoring rule: headcount ≥ 50 AND Egypt ≥ 2 | **Keep unchanged.** Pure function. |
| `lib/signals.js` | Egyptian places/universities, HR title/skill/education/certification dictionaries | **Keep.** Corrected against real data over many iterations. |
| `lib/normalize.js` | Location classification, range parsing, headcount resolution | **Keep.** |
| `lib/labels.mjs` | Strips LinkedIn's screen-reader suffixes | **Keep.** Fixes a bug that silently zeroed every country count. |
| `lib/panels.mjs` | Reads aggregate panels inside the browser | **Keep.** Must stay self-contained — it runs in page context. |
| `lib/verdicts.mjs` | Snapshot → verdict shaping, shared by CLI and UI | **Keep.** |
| `lib/csv.mjs`, `select.mjs` | CSV fidelity and company-level row filtering | **Keep.** Round-trip behaviour verified against Arabic text, embedded newlines, duplicate headers. |
| `scrape.mjs` | Playwright collector: session, pacing, resumability | **Wrap** as a provider. Do not rewrite. |
| `qualify.mjs` | CLI | **Keep working.** Becomes a thin caller. |
| `server.mjs` + `public/` | Upload-and-qualify UI | **Keep working** until replaced feature-for-feature. |
| `snapshots.json` | 223 companies of evidence | **Migrate behind a repository interface.** Back up first. |
| `test-signals.mjs` (24), `test-panels.mjs` (12) | Offline test suites | **Promote to release gates.** |

**Current data:** 223 companies collected, 2 errors. Under the current rules:
HCM 27 qualified / 58 review / 136 rejected; Offshoring 67 / 60 / 94.

**Known limitation:** all 223 were collected before the schools/skills panels and
company-intelligence tabs were added, so the Egyptian-education and HR-skills
signals read as empty for every company. Not a bug in the rules — missing fields
in old snapshots. A backfill collection is needed to light those signals up.

---

## 3. Domain concepts

`Evidence Snapshot` · `Verdict` · `Qualification Rule` · `Coverage` ·
`Verdict Override`. Defined in [03_DOMAIN_MODEL.md §5](../03_DOMAIN_MODEL.md).

---

## 4. Configuration surface

What an admin changes without code. This *is* the product.

| Configurable | Detail | Req |
|---|---|---|
| Rules | Name, service line, enabled, version | FR-QUAL-024/025 |
| Thresholds | Min/max headcount, signal counts, coverage gate | FR-QUAL-024 |
| Claim type | **Presence** or **absence** — determines gate direction | FR-QUAL-004 |
| Signal dictionaries | Which labels count as HR, which places count as Egypt | FR-QUAL-024 |
| Negative screens | Industries and name patterns that disqualify outright | FR-QUAL-024 |
| Staleness | How old a verdict may be before flagged (default 90 days) | FR-QUAL-022 |
| Override reasons | The picklist behind "Disagree?" | FR-QUAL-029 |
| Providers | Which, in what order, with what budget | FR-INT-002/003 |
| Auto-promotion | Whether QUALIFIED creates a Deal, and with which service line | FR-QUAL-031 |

**Rules are metadata.** Adding a fifth service line with its own ICP must require
zero code.

---

## 5. Behaviour

### 5.1 Three verdicts ⚑

| Verdict | Meaning | Act on it? |
|---|---|---|
| `QUALIFIED` | Evidence proves the rule is met | Yes |
| `REJECTED` | Evidence proves the rule is not met | Yes |
| `REVIEW` | **Evidence cannot answer the question** | No — get more evidence |
| `UNRESOLVED` | No collectable identity (no LinkedIn URL / domain) | Fix the input |
| `ERROR` | Collection failed | Retry if transient |

REVIEW is not a soft rejection and must never be collapsed into one — not in
filters, counts, dashboards, exports or the API (FR-QUAL-001).

**Why it exists:** LinkedIn's panels list only the top ~5 rows. "Egypt is not
listed" means *not in the top five*, not *zero*. Treating those as the same
either discards real leads or ships bad ones.

### REVIEW is correct, and 26% of it is a problem to solve

REVIEW is currently 58 of 223 for HCM and 60 for offshoring. The model is right;
a quarter of output being "cannot tell" is still a **data problem the product's
job is to shrink**, not a feature to present elegantly.

Two consequences, both required:

1. **Every REVIEW carries a machine-readable `review_reason_code`.** An
   undifferentiated 26% is not actionable; *"62% are missing a country row"* is a
   roadmap item and a provider-selection decision.
2. **REVIEW rate is a first-class product health metric** with a target and a
   trend, surfaced on the prospecting dashboard — not buried in a verdict count.

And a bulk triage queue exists, because 58 accounts reviewed one page-load at a
time is a workflow users will route around
([06 §3.4](../06_UI_UX_GUIDELINES.md)).

### 5.2 Claim direction decides the gate ⚑

The deepest idea in the existing code, and the easiest to lose in a rewrite.

**Presence test** — "at least 2 employees in Egypt". Observing 2 proves 2 at any
coverage. Incomplete data can only cause false *negatives*. So coverage gates
the **REJECT**, never the QUALIFY.

**Absence test** — "at most 1 HR employee". Finding none proves nothing unless
you looked everywhere. So coverage gates the **QUALIFY**, never the REJECT.

Every rule declares which it is. This is a property of the *claim*, not of the
data source.

### 5.3 Bounds before conclusions ⚑

A conclusion is only drawn when arithmetic supports it.

```
Offshoring:  maxPossibleInCountry = headcount − Σ(country-level rows)
             reject only if maxPossibleInCountry < threshold
             city rows are SUBSETS of their country — never summed into this

HCM:         maxPossibleHr = headcount − Σ(all function rows)
             qualify only if maxPossibleHr ≤ threshold
             function rows are mutually exclusive — one function per person —
             so they CAN be summed
```

The asymmetry is not a detail. Location rows overlap (a city is inside its
country); function rows do not (a person has one function). Summing the wrong one
produced a real bug: 202 of 223 companies qualified before this was fixed.

### 5.4 Signals combine by MAX, never SUM ⚑

`hrCount` is the maximum across signals, not their sum. The 87 people in the
Human Resources function and the 48 with HR skills are largely the same people;
adding them invents staff. Max is also the conservative choice for an absence
test — any single signal showing 2+ is enough to reject.

### 5.5 Headcount ranges ⚑

When headcount is known only as a range, the lower bound is used, and it
constrains conclusions in both directions:

| Situation | Verdict | Why |
|---|---|---|
| Lower bound below a floor | REVIEW | True figure may still clear it |
| Lower bound above a ceiling | REJECTED | A lower bound over the ceiling proves the true figure is too |
| Lower bound inside a band | REVIEW | Clears the floor but cannot prove the ceiling |

### 5.6 Verdicts are immutable and versioned

Not current behaviour — **required**, from a real incident:

> Changing the HCM rule from `headcount ≥ 20` to `20–50` changed **117 of 223
> verdicts**, three from QUALIFIED to REJECTED. Nothing recorded it.

- A verdict records rule key, rule version, evidence reference, inputs hash,
  confidence, reasoning and computed-at (FR-QUAL-020)
- Re-running **appends**; it never mutates
- `inputs_hash` distinguishes "the rule changed" from "the company changed"
- Publishing a rule change shows an impact preview first (FR-QUAL-023)
- Overrides are a separate record; the computed verdict is never overwritten

### 5.7 Evidence and rules stay separate ⚑

Collection is expensive, rate-limited and network-bound. Evaluation is cheap and
offline. This is why re-qualifying 223 companies under a new rule takes seconds
and costs nothing in provider spend — and it must survive into the platform
(FR-QUAL-003).

**Precisely what is free is the not-recollecting**, which is the valuable part.
Evaluation itself is not free at scale: 250k accounts × 20 rules is a batch
workload, and impact preview would otherwise compute it twice. So:

- Re-evaluation is a **job**, not a request (NFR-PERF-004b: 250k × 20 in < 30 min)
- Impact preview above a threshold uses **stratified sampling with a stated
  confidence interval**, and says so in the UI
- Accounts with open deals are always evaluated exactly, never sampled — those
  are the ones a human must see by name
- Evaluation is incremental where inputs are unchanged (`inputs_hash`)

### 5.8 Collection ⚑

- Paced 4–9 s between companies, not user-reducible below a safe floor
- Persists after **every** company — stopping loses nothing
- Resumable: already-collected companies are skipped
- Session detection via cookie, not page inspection (OAuth happens in a popup,
  so URL and DOM checks give the wrong answer)
- Company intelligence failures never cost the qualification numbers already
  collected

### 5.9 Export fidelity ⚑

A qualified-list export is the **source file, filtered**: every column, original
order, byte-identical rows. Verified against duplicate headers, blank headers,
Arabic text, embedded commas and newlines, doubled quotes, and BOM handling.

A company's verdict applies to every row referencing it, so a six-contact
company keeps all six rows or none.

---

## 6. Interfaces

**Offers:** run qualification (subject set, rule) · read verdict + history ·
read evidence · test a rule against a sample · preview rule-change impact ·
estimate collection cost · export filtered source.

**Emits:** `evidence.collected` · `verdict.computed` · `verdict.changed` ·
`verdict.overridden` · `rule.published` · `collection.failed`.

**Consumes:** `account.created` (optionally trigger qualification) ·
`account.merged` (re-point verdicts).

**Provider capabilities required:** company lookup, company enrichment,
optionally contact lookup.

---

## 7. UI surfaces

| Surface | Notes |
|---|---|
| Import & qualify wizard | Exists. Pre-flight showing cost and time before running is the signature — preserve it. |
| Verdict panel | Per [06 §3.2](../06_UI_UX_GUIDELINES.md) — checks with numbers, evidence quoted, rule version, age, "Disagree?" |
| REVIEW resolution | Per [06 §3.3](../06_UI_UX_GUIDELINES.md) — always offers a route to settle it |
| Rule editor | Thresholds, signals, claim type, negative screens; test-against-sample before publish |
| Impact preview | Per [06 §3.4](../06_UI_UX_GUIDELINES.md) — transition counts, dangerous transitions named |
| Prospect list | Verdict as a first-class filter with three values |
| Evidence card | Provider, date, raw observation, which parts the rule used |

---

## 8. Edge cases

| Case | Required behaviour | Req |
|---|---|---|
| No LinkedIn URL or domain | `UNRESOLVED`, counted and visible — never silently dropped | FR-QUAL-033 |
| Several contacts, one company | Company verdict applies to all rows | FR-QUAL-007 ⚑ |
| Company in list, never collected | Excluded from results, explicitly counted, one-click collect offered | FR-QUAL-033 |
| Collection error | Distinguish transient from permanent; retry transient | FR-QUAL-034 |
| Arabic / URL-encoded slug | Handled; kept in regression fixtures | NFR-I18N-002 |
| Re-upload of the same file | Idempotent on `external_id` — no duplicates | FR-IMP-004 |
| Headcount as a range | Per §5.5 | FR-QUAL-010 ⚑ |
| Company qualifying for two rules | Independent verdicts, never merged into one score | FR-QUAL-026 |
| Rule references a deprecated signal | Publish blocked, referrer named | FR-PLAT-004 |
| Evidence older than staleness threshold | Verdict flagged stale, visually distinct, filterable | FR-QUAL-022 |
| Panels present but matching nothing | Genuine zero at census coverage | ⚑ |
| Panels absent entirely | `null`, not zero — "unknown" never becomes "none" | ⚑ |
| Two workspaces, same company | Separate evidence and verdicts. No cross-tenant sharing in v1. | FR-PLAT-012 |

---

## 9. Acceptance criteria

**Preservation** — these must hold at every phase boundary:

- [ ] `test-signals.mjs` and `test-panels.mjs` pass unmodified (FR-QUAL-012)
- [ ] Re-qualifying the 223 known companies produces byte-identical output to the previous phase
- [ ] Upload → qualify → download works end to end in the UI
- [ ] Exported CSV preserves every source column, byte-identical (FR-QUAL-006)
- [ ] Collection remains resumable; killing mid-run loses nothing (FR-QUAL-008)
- [ ] Qualification runs with no network access (FR-QUAL-011)
- [ ] REVIEW appears nowhere as a synonym for REJECTED (FR-QUAL-001)

**New:**

- [ ] A verdict names the rule version that produced it (FR-QUAL-020)
- [ ] Re-running appends; prior verdicts remain readable (FR-QUAL-020)
- [ ] An account shows verdict history and why it changed (FR-QUAL-021)
- [ ] Publishing a rule change shows an impact preview, including QUALIFIED→REJECTED (FR-QUAL-023)
- [ ] A non-technical admin can create a rule with no code (FR-QUAL-024)
- [ ] A rule can be tested against a sample before publishing (FR-QUAL-032)
- [ ] Every verdict displays its evidence with provider and date (FR-QUAL-027)
- [ ] Every REVIEW offers a resolution action (FR-QUAL-028)
- [ ] An override records a reason and never overwrites the computed verdict (FR-QUAL-029)
- [ ] Collection cost is estimated before running (FR-INT-002)
- [ ] Stale verdicts are visually distinct and filterable (FR-QUAL-022)

---

## 10. Out of scope

| Not here | Where |
|---|---|
| Storing companies as CRM records | Accounts & Contacts ([02](02_ACCOUNTS_AND_CONTACTS.md)) |
| Column mapping and duplicate detection | Import Engine ([06](06_IMPORT_ENGINE.md)) |
| Creating deals from qualified accounts | Deals ([03](03_DEALS_AND_PIPELINE.md)), triggered by `verdict.computed` |
| Outreach sequencing | Out of scope for v1 |
| Provider implementations | Integrations ([11](../11_INTEGRATIONS.md)) |
| Scoring *as a verdict* | Deliberately not built — see [ADR-04](../04_SYSTEM_ARCHITECTURE.md#decision-register) |
| **Ranking within QUALIFIED** | A separate, configurable priority model — see [ADR-14](../04_SYSTEM_ARCHITECTURE.md#decision-register). A rep handed 400 qualified accounts needs an order; refusing to give one moves it into a spreadsheet, where it is worse and invisible. |
| Refresh economics for stale verdicts | A policy engine prioritising by lifecycle stage, deal activity and verdict age, bounded by workspace budget — see [11](../11_INTEGRATIONS.md) |
