# Enterprise Readiness

**Status:** Draft v0.1 · **Owner:** Product / Security · **Last reviewed:** 2026-08-03

Created in response to [15 §F](15_TECHNICAL_REVIEW.md) — enterprise identity,
sandbox, and compliance posture were absent.

---

## 1. Why this exists before there is an enterprise customer

These are **procurement gates**, not features. The first customer with an IT
department will send a security questionnaire, and "not yet" ends the deal after
the sales cycle has already been paid for.

Most of them are cheap to design for and expensive to retrofit. The point of this
document is to draw the line between *design for it now* and *build it when
needed* — deliberately, rather than by accident.

| | Design now, build later | Build before first external customer | Build before first enterprise customer |
|---|---|---|---|
| Identity | SCIM, SAML | MFA, session policy | SSO/SAML, SCIM |
| Data | BYOK, legal hold | Retention, erasure, export | Residency, BYOK |
| Ops | Sandbox | Audit export, support access controls | Sandbox, uptime SLA |
| Compliance | SOC 2 | DPA, sub-processors, breach process | SOC 2 Type II, pen test |

---

## 2. Identity and access

| Capability | Tier | Notes |
|---|---|---|
| Email + password with strong hashing | v1 | Argon2id |
| **MFA (TOTP)** | v1 | Per-user; workspace admins can require it |
| Session policy | v1 | Configurable idle and absolute timeouts, device list, remote revoke |
| **SAML 2.0 / OIDC SSO** | Enterprise | Per workspace, with a documented break-glass local admin |
| **SCIM 2.0 provisioning** | Enterprise | Automatic joiner/mover/leaver. The one that actually blocks deals — IT will not manage users twice. |
| Just-in-time provisioning | Enterprise | Role from IdP group mapping |
| IP allowlisting | Enterprise | Per workspace, applied to UI and API |
| API key rotation | v1 | Scoped, rotatable, last-used visible, revocable |
| Service accounts | v2 | Explicit principal, never an admin bypass |

**Break-glass matters.** Every SSO deployment needs one auditable local admin
path, or a misconfigured IdP locks the customer out of their own data
permanently.

### Support access

One of the highest-risk capabilities in any SaaS, and one line in the original
docs.

- Off by default. Requires explicit customer grant.
- Time-boxed, with a hard expiry — no indefinite access
- Per-session written justification
- Fully audited: who, when, what was viewed, what was changed
- **Visibly banner-flagged inside the tenant while active**
- Customer can revoke instantly and can review a history of all past access

Silent support access is how trust is lost permanently. The banner is not
optional.

---

## 3. Data protection

| Capability | Tier | Notes |
|---|---|---|
| TLS 1.2+ everywhere | v1 | HSTS |
| Encryption at rest | v1 | Database and object storage |
| **Envelope encryption with managed KMS** | v1 | Per-tenant data keys |
| **BYOK / customer-managed keys** | Enterprise | Honest cost: complicates restore, key rotation and support. Priced accordingly. |
| Field-level encryption | Enterprise | For designated sensitive fields; breaks filtering on those fields, and that trade-off is stated to the customer |
| Data residency | Enterprise | Regional deployment — `[OPEN: Q-02, Q-07]` |
| Retention policy per object | v1 | Workspace-configurable within regulatory bounds |
| **Legal hold** | Enterprise | Suspends retention and deletion for named records under litigation |
| Data portability export | v1 | Full workspace export in an open format — a GDPR right, and also the honest answer to "what if we leave?" |
| Subject erasure | v1 | Locates a person across every object, snapshot, export and generated document |

**Erasure must reach the copies people forget.** Evidence snapshots, projection
tables, search index, caches, generated PDFs, archived partitions and backups.
Backups are handled by documented retention expiry rather than surgical deletion,
and that is disclosed rather than fudged.

---

## 4. Compliance

| Item | When | Notes |
|---|---|---|
| DPA template | Before first external customer | Standard, reviewed by counsel |
| Sub-processor list | Before first external customer | Public, versioned, with change notification |
| Records of processing | Before first external customer | GDPR Art. 30 |
| Breach notification process | Before first external customer | Written, rehearsed, with named roles and a 72-hour clock |
| Vulnerability disclosure policy | Before first external customer | Public contact, stated response times |
| Dependency scanning | v1 | CI, blocking on critical |
| Penetration test | Before first enterprise customer | Annual, third-party, summary shareable |
| **SOC 2 Type I → II** | Before first enterprise customer | 6–12 months of evidence. Start collecting evidence early, because the clock is the constraint, not the controls. |
| ISO 27001 | On demand | Only if the market requires it |
| **Saudi PDPL** | Before first Saudi customer | Registration, residency, transfer rules — `[OPEN: Q-07]` |
| GDPR | If selling into the EU | `[OPEN: Q-02]` |

**The enrichment problem deserves naming.** This product stores personal data
about people who never interacted with the customer, obtained from third-party
providers. That is the highest-risk category under both GDPR and PDPL, and it is
the product's core function. Required, and cheap if done now:

- `data_source` and `acquired_at` on every contact — already specified
- Lawful basis recorded, defaulting to legitimate interest for B2B, per workspace
- A legitimate-interest assessment template offered to customers
- Suppression list: a person who objects is never re-enriched, even if they
  reappear in a later import. Without this, erasure is undone by the next CSV.

That last point is the one most often missed and the one most likely to produce a
complaint.

---

## 5. Sandbox

The design asks admins to build automations and qualification rules that act on
live data, with dry run as the only safety net. Every mature platform provides a
sandbox, and enterprise buyers ask for it by name.

| Property | Decision |
|---|---|
| Content | Metadata copy always; data copy optional and subsettable |
| Personal data | **Masked by default** in the copy |
| Refresh | On demand, rate-limited, destructive to the sandbox only |
| Promotion | Metadata changes promotable sandbox → production, with a diff and approval |
| Isolation | A separate workspace with a sandbox flag. No production writes, no outbound email, no webhooks, no provider spend. |
| Tier | Enterprise; dry run remains the v1 mitigation for everyone else |

The no-outbound rule is the important one: a sandbox that can email real
customers is worse than no sandbox.

---

## 6. Administration

| Capability | Tier |
|---|---|
| Audit log UI with filtering | v1 |
| **Audit export** (CSV / SIEM) | Enterprise — required by any customer with a security team |
| Login and session history | v1 |
| Permission change history | v1 |
| Bulk user management | v1 |
| Ownership reassignment on departure | v1 |
| Usage and quota dashboard | v1 |
| Provider spend reporting | v1 |
| Custom domain | Enterprise |
| White-labelling | Not planned — accent colour only, and never the verdict tokens |

Verdict colours are excluded from branding deliberately: a customer must not be
able to make REJECTED look like QUALIFIED.

---

## 7. Contractual and operational commitments

| Commitment | v1 | Enterprise |
|---|---|---|
| Uptime SLA | Best effort, published SLOs | 99.9% with credits; 99.95% negotiable at a cost |
| Support response | Business hours | Tiered with defined response times |
| Maintenance windows | Announced | Announced, with a customer-selectable window |
| Deprecation notice | 6 months on API | 12 months, negotiable |
| Status page | v1 | v1 — with incident history retained |
| Security questionnaire pack | — | Pre-prepared, kept current |

A prepared questionnaire pack sounds like paperwork. It is the difference between
a two-week and a two-month enterprise sales cycle.

---

## 8. What this changes in the roadmap

Most of this lands in Phase 8, with four exceptions that are much cheaper now:

| Item | Do now | Why |
|---|---|---|
| `data_source`, `acquired_at`, lawful basis, suppression list | Phase 2 | Retrofitting provenance across existing records is impractical |
| Audit completeness including exports | Phase 1b | An audit log with gaps cannot be backfilled |
| MFA and session policy | Phase 1b | Cheap early; awkward to add to an established auth flow |
| SOC 2 evidence collection | Phase 1a | The constraint is elapsed time, not the controls |

**Blocking:** `[OPEN: Q-12]` — is an enterprise buyer expected within 18 months?
If yes, SSO, SCIM, sandbox and SOC 2 move from Phase 8 into the critical path,
which materially changes the plan in [14](14_DEVELOPMENT_ROADMAP.md).
