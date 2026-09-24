# API Architecture

**Status:** Draft v0.2 · **Owner:** Architecture · **Last reviewed:** 2026-08-03
**Revision note:** v0.2 replaces "REST generated from metadata", which cannot be
versioned. See [15 D1](15_TECHNICAL_REVIEW.md#d1--s1--rest-generated-from-metadata-is-not-a-viable-public-api).

---

## 1. Why the API exists in v1

Competing with the incumbents means customers extend the product **without you**.
An integration surface is not a v3 feature; it is the reason a customer can say
yes without a services engagement.

There is a second reason, and it is the stronger one: **the API is the best
available test that nothing is hardcoded.** If a customer adds a field and the
API needs hand-editing, the metadata engine is a fiction — and you find out in
week three instead of month eighteen.

---

## 2. The correction: designed endpoints, discovered properties

The previous revision proposed generating REST routes from metadata. That is a
trap:

- A tenant adding a **required** custom field changes validation for every API
  client — a breaking change caused by a customer's configuration, with no
  version to bump.
- The OpenAPI document would differ per tenant, so no single specification could
  be published.
- Deprecation becomes unmanageable, because the surface is tenant-defined.
- Endpoints that genuinely need a hand-designed contract cannot have one.

**Endpoints are hand-designed and stable. Tenant-specific fields travel in a
`properties` bag, with a discovery endpoint.**

```
GET  /api/v1/objects/accounts?properties=name,industry,annual_revenue
GET  /api/v1/objects/accounts/{id}
POST /api/v1/objects/accounts
GET  /api/v1/meta/objects/accounts/properties     ← discovery
```

```json
{ "id": "acc_01H...", "version": 7,
  "properties": {
    "name": "AFCO Steel",
    "lifecycle_stage": "qualified",
    "annual_revenue": 4200000          // custom, tenant-defined
  } }
```

Stable contract, tenant-specific data, one publishable specification. The valid
part of the original argument survives: metadata still drives validation, the
property catalogue and the field mask. It just does not generate the routes.

---

## 3. Surface

### Records

```
GET    /api/v1/objects/{object}                list
POST   /api/v1/objects/{object}                create
GET    /api/v1/objects/{object}/{id}           read
PATCH  /api/v1/objects/{object}/{id}           update
DELETE /api/v1/objects/{object}/{id}           soft delete
GET    /api/v1/objects/{object}/{id}/{assoc}   associations
POST   /api/v1/objects/{object}/batch          batch → job
POST   /api/v1/objects/{object}/search         complex query
```

`{object}` is the metadata `key`, including custom objects. The *route shape* is
fixed; the object set is not.

### Discovery

```
GET /api/v1/meta/objects
GET /api/v1/meta/objects/{key}/properties      types, operators, options
GET /api/v1/meta/pipelines
GET /api/v1/meta/activity-types
```

A client discovers the tenant's schema at runtime. This is what lets an
integration survive a customer adding fields.

### Domain operations

Not everything is CRUD. Genuine verbs get verb endpoints:

```
POST /api/v1/qualification/runs                 run rules over a subject set → job
GET  /api/v1/qualification/verdicts             current verdicts, filterable
GET  /api/v1/objects/accounts/{id}/verdicts     history with rule versions
POST /api/v1/qualification/rules/{key}/preview  impact preview → job
POST /api/v1/objects/accounts/{id}/merge
POST /api/v1/imports
GET  /api/v1/jobs/{id}
```

### Incremental sync

```
GET /api/v1/objects/{object}?updated_since=…&cursor=…
```

Without this, integrators poll-scan the whole dataset. Explicitly supported so
they do not have to.

### Bulk export

```
POST /api/v1/exports        → job → signed URL
```

Paginating 500k records through the read API is abusive to both sides.

---

## 4. Contracts

### Identity

External references use the **stable `key`**, never the UUID and never the label
(FR-PLAT-002). `"stage": "proposal_sent"`. Renaming the stage's label does not
break the integration.

### Consistency

- `snake_case` throughout, matching metadata keys
- ISO 8601 UTC timestamps with explicit offset
- Money is always `{ "amount": "12000.00", "currency": "SAR" }` — never a bare number
- **Verdicts are always one of five strings.** Never a boolean. An API returning
  `qualified: true` has destroyed the model's entire point.
- A hidden field is **absent**, not null — so "hidden" and "empty" stay distinct

### Optimistic concurrency

Every mutable record carries `version`. Updates require it:

```
PATCH /api/v1/objects/accounts/{id}
If-Match: 7
→ 409 Conflict  { "error": { "code": "version_conflict",
                             "current_version": 9, "conflicting_fields": [...] } }
```

Without this, two users silently overwrite each other — which on a collaborative
CRM happens daily.

### Errors

```json
{ "error": { "code": "validation_failed",
             "message": "2 fields failed validation",
             "details": [ { "property": "email", "code": "invalid_format",
                            "message": "Enter a valid email address" } ],
             "request_id": "req_01H..." } }
```

Machine-readable `code`, human `message`, per-field `details`, and a `request_id`
that appears in logs and traces.

### Pagination

Cursor-based. Cursors are **opaque**, encode the sort key plus `id` as a
tie-breaker, and are invalidated when the sort changes. Offset pagination
silently skips and repeats rows when data changes mid-scan — which it always does
during a large export.

---

## 5. Versioning

URL-versioned (`/api/v1/`). Breaking changes mean a new version; the previous is
supported for a stated period.

**Additive changes are not breaking**, and clients must tolerate them — a new
property appearing is normal and happens whenever a customer adds a field. This
is stated prominently in the integrator documentation, because it is the one
expectation that differs from a fixed-schema API.

```
Deprecation: true
Sunset: Wed, 01 Jul 2027 00:00:00 GMT
Link: <https://.../migrations/v2>; rel="deprecation"
```

---

## 6. Authentication and authorisation

| Client | Mechanism |
|---|---|
| First-party UI | Session cookie, CSRF-protected |
| Server-to-server | API key, workspace-scoped, hashed at rest, rotatable |
| Third-party apps | OAuth 2.0 with scopes (v2) |

**Every call runs under a principal with the same permission model as the UI**
([12](12_PERMISSION_MODEL.md)). No admin bypass. No service account that sees
everything. An API key that outranks the permission system is how tenant
isolation gets breached.

The permission set resolves **once per request** into a cached field mask,
applied at the serialisation boundary in one place — not scattered across
handlers ([15 F4](15_TECHNICAL_REVIEW.md)).

---

## 7. Rate limits and quotas

Per workspace and per key, never per IP. Tiered by cost:

| Class | Example | Shape |
|---|---|---|
| Read | list, read | Generous |
| Write | create, update | Moderate |
| Expensive | search, export, qualification run | Strict, queue-backed |
| Provider-consuming | enrichment, collection | Governed by **budget**, not rate |

Always returns `X-RateLimit-Limit`, `-Remaining`, `-Reset`; `429` includes
`Retry-After`. Rate limiting without headers is a trap for integrators.

Plan-level quotas are in [16](16_SCALABILITY_AND_OPERATIONS.md).

---

## 8. Webhooks

- Subscribe to any event (`verdict.computed`, `deal.stage_changed`, …)
- Delivered from the **transactional outbox**, so no event is lost on crash
  ([05 §6](05_DATABASE_DESIGN.md))
- **At-least-once — consumers must be idempotent.** Stated prominently, with an
  `event_id` for deduplication.
- Signed per subscription, timestamped against replay
- Retried with exponential backoff; delivery log visible to the customer
- Auto-disabled after sustained failure, with notification — a dead endpoint must
  not consume the queue forever

Payloads never carry fields the subscription's principal cannot see.

---

## 9. Long-running operations

Imports, bulk updates, exports, collection runs and qualification return a job:

```
202 Accepted
{ "job_id": "job_01H...", "status": "queued",
  "status_url": "/api/v1/jobs/job_01H..." }
```

Jobs report progress, partial results and per-item errors — the same mechanism
the UI uses. One implementation, not two.

---

## 10. Internal module interfaces

Modules do not call each other's HTTP endpoints. They communicate through:

1. **Domain events** via the outbox — the default. Loose, asynchronous.
2. **Published module interfaces** — synchronous reads where genuinely needed.

Never by reaching into another module's tables. Enforced by lint rules on import
paths, not convention — conventions do not survive deadlines.

**This is also the extraction seam.** Because modules only communicate by events
and published interfaces, pulling one into its own service means replacing the
in-process bus with a network one — not untangling shared state.

---

## 11. Documentation

- OpenAPI generated from the **hand-designed** route definitions — one spec,
  publishable, stable
- Property catalogue documented as a runtime discovery call, not baked into the spec
- Interactive explorer against a sandbox workspace ([17](17_ENTERPRISE_READINESS.md))
- Every endpoint documents required scopes and permissions
- A dated changelog, because integrators plan around them
