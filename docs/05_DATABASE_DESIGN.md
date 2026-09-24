# Database Design

**Status:** Draft v0.2 · **Owner:** Architecture · **Last reviewed:** 2026-08-03
**Revision note:** v0.2 replaces the per-workspace expression-index strategy,
which does not scale past ~24 tenants. See
[15_TECHNICAL_REVIEW.md A1](15_TECHNICAL_REVIEW.md#a1--s1--per-workspace-expression-indexes-cannot-work).

Schemas below are **illustrative of decisions**, not DDL to be typed in.

---

## 1. The decision that determines whether this product works

User-defined fields must be stored, filtered, sorted and searched as fast as
built-in ones, across thousands of tenants. This is where metadata-driven CRMs
die.

### Options, with the rejection criteria applied consistently

| Approach | Flexibility | Query performance | DDL on user action? | Verdict |
|---|---|---|---|---|
| **EAV** | Total | Catastrophic — two self-joins and a pivot to filter two fields | No | **Rejected** |
| **Column per custom field** | Good | Excellent | **Yes** | **Rejected** |
| **JSONB + per-workspace expression index** | Good | Good in isolation | **Yes** | **Rejected** — see below |
| **Document store** | Total | Good for reads | No | **Rejected** — loses relational integrity deals and agreements need |
| **JSONB source + fixed typed slot projection** | Good | Good | **No** | **Chosen** |

**Why per-workspace expression indexes were rejected**, having been the previous
recommendation:

*Index count.* PostgreSQL's planner considers every index on a table. The
practical ceiling is ~30–50 per table before planning time and write
amplification dominate. 1,000 workspaces × 25 filterable fields = **25,000
partial indexes on `account`** — roughly 500× over the ceiling. It breaks at
about two dozen tenants.

*DDL on user action.* Creating a field would issue `CREATE INDEX` on a shared
multi-tenant table. `CONCURRENTLY` avoids the worst locking but needs two full
table scans, cannot run in a transaction, and can leave an invalid index behind.
One tenant's admin degrades every tenant.

That second reason is exactly why "column per custom field" was rejected. The
criterion was right; it simply was not applied to the recommendation.

---

## 2. The chosen model — three tiers

| Tier | Storage | Role |
|---|---|---|
| **1 · System fields** | Real typed columns | Universal fields. Normal shared indexes. |
| **2 · Custom values** | One `JSONB` column | **Source of truth** for every custom field. Unlimited. Never indexed per tenant. |
| **3 · Filter projection** | **Fixed typed slot columns** | Written alongside JSONB for fields flagged filterable/sortable. Shared indexes. |

```sql
CREATE TABLE account (
  id              uuid PRIMARY KEY,                 -- uuid v7, time-ordered
  workspace_id    uuid NOT NULL REFERENCES workspace(id),

  -- TIER 1 — universal, typed, constrained
  name            text NOT NULL,
  domain          citext,
  linkedin_slug   citext,
  commercial_reg  text,
  country_code    char(2),
  headcount       integer,
  lifecycle_stage text NOT NULL DEFAULT 'prospect',
  owner_id        uuid REFERENCES app_user(id),
  team_id         uuid REFERENCES team(id),

  data_source     text,
  acquired_at     timestamptz,
  external_id     text,

  -- TIER 2 — source of truth for all custom fields, no limit
  custom          jsonb NOT NULL DEFAULT '{}',

  -- TIER 3 — projection of filterable/sortable custom fields only
  n1 numeric, n2 numeric, /* … */ n24 numeric,
  s1 text,    s2 text,    /* … */ s48 text,
  d1 timestamptz, /* … */ d12 timestamptz,
  b1 boolean, /* … */ b8 boolean,
  u1 uuid,    /* … */ u8 uuid,

  version    integer NOT NULL DEFAULT 1,            -- optimistic concurrency
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,

  UNIQUE (workspace_id, external_id),
  UNIQUE (workspace_id, linkedin_slug)
);

-- Created ONCE, at schema migration time. Never on user action.
-- One index serves every tenant that uses that slot.
CREATE INDEX account_ws_s1 ON account (workspace_id, s1) WHERE deleted_at IS NULL;
CREATE INDEX account_ws_n1 ON account (workspace_id, n1) WHERE deleted_at IS NULL;
-- … one per slot: ~100 indexes total, fixed, regardless of tenant count
```

Field metadata records the mapping:

```
field_definition: key='annual_revenue', storage='slot', slot='n3'
→ filter on custom annual_revenue  ⇒  WHERE workspace_id = $1 AND n3 > $2
```

**Index count is constant.** Tenant 1 and tenant 900 both use `s1` for entirely
different fields, and both are served by the same index, because
`workspace_id` leads it.

This is the shape Salesforce arrived at for the same reasons. It is boring,
proven, and operationally quiet.

### Costs, stated honestly

| Cost | Mitigation |
|---|---|
| **Slot exhaustion** — a fixed number of filterable fields per object | Surfaced in the admin UI as a visible budget: "18 of 24 numeric filter slots used". Better a clear limit than an unexplained slowdown. |
| **Type change requires a slot move** | Backfill job, previewed and estimated, using the standard job framework |
| **Projection must stay consistent with JSONB** | Written in the same transaction; a nightly consistency check reports drift |
| **Slot allocation is a schema decision** | Sized from `[OPEN: Q-11]` — expected custom fields per object at p90. Cheap now, expensive after data exists. |

### Fields that are not projected

Stored and displayed, but not filterable. When a user needs to filter one:

1. **Promote it** to a slot — a previewed, estimated backfill job, or
2. **Scan with an explicit cap** — bounded row limit, visible warning, never
   silently slow

The system never pretends a query is cheap when it is not.

---

## 3. Tenancy and row-level security

```sql
ALTER TABLE account ENABLE ROW LEVEL SECURITY;

CREATE POLICY account_tenant_isolation ON account
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
```

### The pooling rule — this one is a data-leak risk, not a performance note

> **`SET LOCAL`, inside the transaction. Never session-level `SET`.**

Under PgBouncer in transaction mode — which any deployment at this scale will
use — a session-level setting persists on the server connection after it is
returned to the pool and handed to a *different tenant's* transaction. That is a
cross-tenant data leak.

```sql
BEGIN;
  SET LOCAL app.workspace_id = '...';   -- scoped to this transaction only
  -- queries
COMMIT;
```

**CI must assert** that a pooled connection does not retain the setting across
transactions (NFR-SEC-003).

### RLS is the safety net, not the mechanism

`current_setting()` is opaque to the planner, which produces generic plans and
can defeat partition pruning. So the repository layer **also** adds an explicit
literal predicate:

```sql
SELECT … FROM account WHERE workspace_id = $1 AND …   -- planner sees a value
```

Belt and braces, deliberately. RLS catches the query someone forgets to scope;
the explicit predicate keeps the plans good.

### Composite keys everywhere

Every unique constraint on tenant data includes `workspace_id`. Two workspaces
must be able to have an account with the same domain and a stage with the same
key.

---

## 4. Metadata tables

```sql
CREATE TABLE field_definition (
  id uuid PRIMARY KEY,  workspace_id uuid NOT NULL,
  object_id uuid NOT NULL REFERENCES object_definition(id),
  key text NOT NULL,                    -- immutable, never reused
  label jsonb NOT NULL,                 -- {"en":"…","ar":"…"}
  type text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}',

  storage text NOT NULL,                -- 'column' | 'jsonb' | 'slot'
  column_name text,                     -- storage='column'
  slot text,                            -- storage='slot' → 'n3', 's12'

  filterable boolean NOT NULL DEFAULT false,
  sortable   boolean NOT NULL DEFAULT false,
  searchable boolean NOT NULL DEFAULT false,

  default_visibility text NOT NULL DEFAULT 'all',
  deprecated_at timestamptz,
  UNIQUE (workspace_id, object_id, key),
  UNIQUE (workspace_id, object_id, slot)     -- one field per slot per workspace
);
```

Same shape for `pipeline`, `stage`, `activity_type`, `service_line`,
`qualification_rule`, `view_definition`, `automation_rule`, `role`: workspace-
scoped UUID, immutable `key`, localisable label, `deprecated_at` rather than
deletion.

### Metadata versioning

```sql
CREATE TABLE metadata_version (
  id uuid PRIMARY KEY,  workspace_id uuid NOT NULL,
  entity_type text NOT NULL,  entity_id uuid NOT NULL,
  version integer NOT NULL,
  snapshot jsonb NOT NULL,              -- the full definition at this version
  changed_by uuid NOT NULL,  changed_at timestamptz NOT NULL DEFAULT now(),
  change_note text,
  UNIQUE (workspace_id, entity_type, entity_id, version)
);
```

This is what lets a verdict reference rule version 3 and have version 3 still be
readable after the rule reaches version 7.

---

## 5. The evidence plane

```sql
CREATE TABLE evidence_snapshot (
  id uuid PRIMARY KEY,  workspace_id uuid NOT NULL,
  subject_type text NOT NULL,
  subject_key  text NOT NULL,           -- linkedin slug / domain
  account_id   uuid REFERENCES account(id),   -- nullable: evidence can precede the record

  provider_key text NOT NULL,
  collected_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,    -- updated on identical re-collection
  payload      jsonb NOT NULL,
  payload_hash text NOT NULL,
  cost_units   numeric(12,4),
  error        text
) PARTITION BY RANGE (collected_at);

CREATE INDEX ON evidence_snapshot (workspace_id, subject_key, collected_at DESC);
```

**`last_seen_at` matters.** The previous design made `payload_hash` unique, which
rejected identical re-collection — but "we checked again on 1 November and
nothing had changed" is itself a fact, and without it verdict staleness could
never be refreshed without a payload change.

```sql
CREATE TABLE verdict (
  id uuid PRIMARY KEY,  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES account(id),
  rule_key text NOT NULL,
  rule_version integer NOT NULL,        -- → metadata_version
  evidence_id uuid REFERENCES evidence_snapshot(id),
  inputs_hash text NOT NULL,            -- did the rule change, or the data?

  verdict text NOT NULL CHECK (verdict IN
    ('QUALIFIED','REJECTED','REVIEW','UNRESOLVED','ERROR')),
  review_reason_code text,              -- WHY it could not answer — see below
  confidence numeric(3,2),
  metrics   jsonb NOT NULL DEFAULT '{}',
  reasoning jsonb NOT NULL DEFAULT '[]',

  computed_at   timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz
) PARTITION BY RANGE (computed_at);

CREATE INDEX ON verdict (workspace_id, account_id, rule_key, computed_at DESC);
CREATE INDEX ON verdict (workspace_id, rule_key, verdict) WHERE superseded_at IS NULL;
```

**`review_reason_code` is new and important.** An undifferentiated 26% REVIEW
rate is not actionable; *"62% of REVIEWs are missing a country row"* is a roadmap
item. See [15 I1](15_TECHNICAL_REVIEW.md#i1--s2--a-26-review-rate-is-a-data-problem-the-docs-treat-as-a-feature).

Append-only. Re-running inserts; the current verdict is the one with
`superseded_at IS NULL`. Overrides are a separate table and never mutate the
computed verdict.

---

## 6. Transactional outbox

Events must be published atomically with the mutation that caused them.
Commit-then-publish loses events on a crash; publish-then-commit emits events for
rolled-back transactions. Either way automations silently do not fire — the worst
failure mode in this product, because nothing errors.

```sql
CREATE TABLE outbox (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL,
  event_type text NOT NULL,
  aggregate_type text NOT NULL,  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX ON outbox (published_at, id) WHERE published_at IS NULL;
```

Written **in the same transaction** as the mutation. A relay publishes and marks
them, feeding automations, webhooks, the search projection and the timeline
projection. At-least-once delivery; consumers are idempotent by construction.

---

## 7. Derived projections

Three read-optimised tables maintained by the outbox relay. Source tables remain
authoritative; projections are rebuildable from scratch.

| Projection | Why it exists |
|---|---|
| `timeline_entry` | A large account's timeline unions activities, tasks, notes and projected audit events. Doing that per page at 50k entries does not hold. |
| `record_search` | Record ref + `tsvector` + permission tags, one shared GIN index. Permission tags are applied **in** the query — post-filtering search results breaks pagination. |
| `metric_rollup` | Dashboard aggregates, refreshed incrementally. Eight widgets each scanning a large table per viewer will not meet a 1.5 s budget. |

---

## 8. Activity vs audit

```sql
CREATE TABLE activity (             -- timeline: curated, editable
  id uuid PRIMARY KEY,  workspace_id uuid NOT NULL,
  activity_type_id uuid NOT NULL,
  parent_type text NOT NULL,  parent_id uuid NOT NULL,
  account_id uuid,                  -- denormalised for rollup
  occurred_at timestamptz NOT NULL, -- distinct from created_at, deliberately
  created_by uuid,  deleted_at timestamptz,
  custom jsonb NOT NULL DEFAULT '{}'
) PARTITION BY RANGE (occurred_at);

CREATE TABLE audit_event (          -- record of record: immutable
  id bigserial PRIMARY KEY,  workspace_id uuid NOT NULL,
  object_type text NOT NULL,  object_id uuid NOT NULL,
  action text NOT NULL,
  actor_id uuid,  actor_type text NOT NULL,
  changes jsonb,  source text,  request_id text,
  occurred_at timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (occurred_at);
```

No `UPDATE` or `DELETE` grant on `audit_event` is issued to the application role.
Not policy — a database permission.

---

## 9. Partitioning

Every unbounded, time-ordered table is range-partitioned by month:
`audit_event`, `activity`, `verdict`, `evidence_snapshot`, `outbox` (archived),
`timeline_entry`.

Old partitions detach and archive to object storage. Retention is per workspace
where policy allows, and detaching a partition is near-instant compared with
deleting rows.

---

## 10. Indexing strategy

| Class | Applied to |
|---|---|
| Tenant-leading composite | `(workspace_id, …)` on every tenant table — always leading |
| Slot indexes | One per slot per object, created at migration time, shared across tenants |
| Partial | `WHERE deleted_at IS NULL`; `WHERE superseded_at IS NULL` |
| GIN on JSONB | `custom` only, `jsonb_path_ops`, for containment lookups — not for range or sort |
| Full-text | On `record_search`, one shared GIN index |
| Foreign keys | Every FK indexed — Postgres does not do this automatically |

**Total index count per table is fixed and known at migration time.** That is the
property the previous design lacked.

---

## 11. Scale-out path

Documented now so it is not improvised later. See
[16](16_SCALABILITY_AND_OPERATIONS.md).

| Stage | Trigger | Move |
|---|---|---|
| 1 | Launch | Single primary, PITR |
| 2 | Read load | Read replicas for reports, exports, analytics — separate pool |
| 3 | Large tenants | Dedicated database for top-tier tenants, behind the same repository interface |
| 4 | Search cost | Dedicated search cluster replacing `record_search` |
| 5 | Write ceiling | Shard by `workspace_id` — practical because nothing joins across workspaces |

Nothing in the schema joins across workspaces, which is what keeps stage 5 open.
That is a deliberate constraint, not an accident.

---

## 12. Migration from `snapshots.json`

**Step 0, before anything: back it up off-machine.**

| Step | Action | Existing behaviour |
|---|---|---|
| 1 | Back up | Untouched |
| 2 | Evidence repository interface; JSON file as first implementation | Identical |
| 3 | Postgres as second implementation behind the same interface | Identical, config-selectable |
| 4 | Dual-write, comparing output on every run | Identical, with a consistency check |
| 5 | Read from Postgres, JSON as backup writer | Identical |
| 6 | Retire the JSON writer | Identical |

**Gate at every step:** existing test suites pass unchanged, and re-qualifying
the 223 known companies produces byte-identical output to the previous step.

The engine never learns which store it is talking to, which is why this
migration does not require touching `hcm.js` or `offshoring.js` at all.

---

## 13. Backfill framework

Slot promotions, type changes, projection rebuilds and retention sweeps are all
the same operation: a chunked, resumable, rate-limited job that is safe to run
during business hours.

Requirements: bounded batch size, checkpointed progress, cancellable, throttled
against replica lag, and dry-run row counts before starting. This is the same job
framework the product already needs — not a separate mechanism.

---

## 14. Conventions

| Concern | Rule |
|---|---|
| Primary keys | `uuid` v7 — time-ordered, preserving index locality |
| Timestamps | `timestamptz`, UTC, `_at` suffix |
| Money | `numeric(14,2)` plus an explicit currency column. Never float. |
| Concurrency | `version` integer on every mutable record; `If-Match` on the API |
| Soft delete | `deleted_at`; partial indexes exclude |
| Enums | `text` + `CHECK`, not Postgres enum types — altering a check is not a migration |
| Localised labels | `jsonb` keyed by locale, never parallel `_en` / `_ar` columns |
| Migrations | Expand-contract only, never destructive in place |
| Naming | `snake_case`, singular table names |
