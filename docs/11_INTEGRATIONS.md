# Integrations

**Status:** Draft v0.1 · **Owner:** Architecture · **Last reviewed:** 2026-08-03

---

## 1. Capabilities, not vendors

The brief lists integrations as vendors: Apollo, Clay, People Data Labs,
LinkedIn, Google. Building against vendors produces code that must change when
pricing changes, an actor is deprecated, or a customer prefers a different tool.

**Business logic names a capability. Never a vendor.**

```
              ┌────────────────────────────────┐
Application ─►│  Capability contract           │
              │  + cost declaration            │
              │  + confidence reporting        │
              │  + rate limit declaration      │
              └───────────────┬────────────────┘
                              │
  ┌──────────┬────────────┬───┴────┬─────────┬──────────┐
  ▼          ▼            ▼        ▼         ▼          ▼
Local     Apify        Apollo    Clay      PDL      Google
browser   actors                                   Workspace
(BYO)
```

### The capabilities

| Capability | Question it answers |
|---|---|
| Company lookup | What do we know about this organisation? |
| Company enrichment | Headcount, industry, location breakdowns, technologies |
| Contact discovery | Who works here in these roles? |
| Contact enrichment | Email, phone, profile for this person |
| Email verification | Is this address deliverable? |
| Document generation | Render this template with this data |
| File storage | Store and serve this file |
| Email sending | Deliver this message |

A vendor may implement several. Apollo does company lookup, contact discovery
and contact enrichment; the application asks for a capability and never knows
which vendor answered.

---

## 2. What every provider must declare

This is the part that makes the abstraction pay for itself.

| Declaration | Why |
|---|---|
| **Cost per unit** | So a run can be priced *before* it executes |
| **Confidence** | So waterfall enrichment knows when to stop |
| **Rate limits** | So the scheduler paces correctly instead of getting throttled |
| **Attribution** | So every evidence snapshot records where it came from and when |
| **Freshness** | So a cached result can be judged stale |
| **Capabilities** | So the router knows what it can be asked |

Without cost and confidence, waterfall enrichment and budget enforcement are
impossible — and those are two of this product's differentiators.

---

## 3. Cost governance

This project already paid for this lesson. For the same 123 companies:

| Approach | Cost |
|---|---|
| Per-employee roster scraping | **~$240** |
| Company data + insights vendor | ~$17.70 — and no country breakdown |
| Aggregate panels vendor | ~$0.49 — but requires a session cookie |
| Local browser collection | **$0** |

A 500× spread between routes to the same answer. That experience becomes a
platform feature, because nobody else does it well:

1. **Estimate before running.** "240 companies · ~$4.80 · ~26 min" shown in the
   UI before the button (FR-INT-002).
2. **Budgets per workspace.** Soft warning, then hard stop (FR-INT-003).
3. **Track actual spend** per provider, run and workspace (FR-INT-004).
4. **Report cost against results** — cost per qualified account is the number
   that actually matters, and no CRM surfaces it.

Anyone who has used Apollo, ZoomInfo or Clay knows the frustration of discovering
consumption after the fact. Fixing it costs little, because the provider contract
must exist anyway.

---

## 4. Waterfall enrichment

Try providers in configured order until a result meets a confidence threshold
(FR-INT-006).

```
for provider in configured_order:
    if budget_exhausted: stop
    result = provider.enrich(subject)
    record_cost(provider, result)
    if result.confidence >= threshold: stop
```

Configurable per workspace and per capability, because the right order depends on
what a customer already pays for. Order, thresholds and budgets are metadata.

Results are cached in the **evidence store** with provider attribution and fetch
time (FR-INT-005), so the same subject is not re-purchased and the history of
what each provider said is preserved.

---

## 5. The LinkedIn boundary

The existing browser collector is architecturally a provider like any other, and
commercially unlike any other.

**The facts.** It automates access to LinkedIn using the operator's own logged-in
session. LinkedIn's terms do not permit automated access. The current pacing
(4–9 s) exists specifically to keep the account safe, and the README already
warns to use a secondary account.

**Why the distinction matters.** As personal internal tooling this is the
operator's own risk, knowingly taken. **Offering it as a hosted feature to paying
third parties is a categorically different legal position** — the platform would
be inducing and facilitating the same breach at scale, for profit, on accounts it
does not own.

**The decision** ([ADR-08](04_SYSTEM_ARCHITECTURE.md#decision-register), FR-INT-008):

| | Self-hosted / single-tenant | Hosted multi-tenant SaaS |
|---|---|---|
| Browser collection with own session | Available | **Not offered** |
| Licensed data providers | Available | Available |
| Uploaded and first-party data | Available | Available |

This shapes the prospecting roadmap, not just a config flag: the hosted product
needs at least one licensed provider that supplies employee-count-by-country
before prospecting is viable for external customers. Research so far indicates
that panel is authenticated-only, so this is an open commercial question, not a
technical one.

**`[OPEN: Q-03]` — must be answered before the first external customer.**

---

## 6. Connector catalogue

| Connector | Capability | Priority | Notes |
|---|---|---|---|
| Local browser | Company enrichment | **Exists** | BYO session, self-hosted only |
| Apify actors | Company enrichment | **Exists** | Two actors deployed; per-result pricing |
| Google Workspace | Document generation, storage | P0 | First document provider |
| Apollo | Contact discovery, enrichment | P1 | Verify pricing before depending on it |
| People Data Labs | Company & contact enrichment | P1 | |
| Clay | Enrichment orchestration | P2 | Overlaps our own waterfall |
| Email (SMTP/API) | Email sending | P0 | Notifications and proposals |
| Microsoft 365 | Document generation, storage | P2 | `[OPEN: Q-06]` |
| E-signature | Signing | P2 | v2 |
| Calendar sync | Activity ingestion | P2 | Designed for, not built in v1 |

**At least two implementations exist before any capability becomes a
dependency** (FR-INT-007). A single-provider capability is a single point of
commercial failure — as the store-actor deprecation risk already demonstrated.

---

## 7. Credentials and security

- Encrypted at rest, scoped per workspace, **never logged** (FR-INT-010)
- OAuth tokens refreshed automatically; refresh failure notifies an admin
  rather than failing silently
- A connector can be disconnected without losing the data it produced — evidence
  outlives its source
- Per-workspace credentials only. No shared platform credentials for
  customer-facing enrichment, ever.

---

## 8. Failure handling

| Failure | Behaviour |
|---|---|
| Provider down | Retry with backoff; fall through the waterfall; log |
| Rate limited | Respect `Retry-After`; pace subsequent calls |
| Budget exhausted | Stop, notify, leave partial results usable |
| Malformed response | Record raw payload as failed evidence; never crash the run |
| Credential expired | Notify admin; disable the connector; do not retry blindly |
| Partial batch failure | Successes persist; failures are individually reported |
| Provider deprecated | Capability routes to alternatives; admin notified |

**A collection run must always be resumable**, as the existing collector already
is. Persisting after every item is the standard for the whole platform, not an
exception.

---

## 9. Acceptance criteria

- [ ] No vendor name appears in business logic (FR-INT-001)
- [ ] Every provider declares cost, confidence and rate limits
- [ ] Estimated cost is shown before any consuming run (FR-INT-002)
- [ ] Workspace budgets enforce a soft warning and a hard stop (FR-INT-003)
- [ ] Actual spend is tracked and reportable per provider and run (FR-INT-004)
- [ ] Provider results are cached as attributed evidence (FR-INT-005)
- [ ] Waterfall order and thresholds are configurable per workspace (FR-INT-006)
- [ ] Swapping a provider requires no change to qualification logic
- [ ] Browser collection is unavailable in the hosted product (FR-INT-008)
- [ ] Credentials are encrypted, workspace-scoped and absent from logs (FR-INT-010)
- [ ] A disconnected connector leaves its evidence intact
