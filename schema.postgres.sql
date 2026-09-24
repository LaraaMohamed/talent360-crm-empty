-- ============================================================================
--  CRM core schema
--
--  Follows docs/03_DOMAIN_MODEL.md. Three planes, kept apart on purpose:
--
--    CONFIGURATION   what the workspace is   (field_defs, pipelines, rules...)
--    RECORD          what the business does  (accounts, contacts, deals...)
--    EVIDENCE        what we observed        (evidence_snapshots, verdicts)
--
--  Two deviations from the docs, both deliberate and both documented in
--  README.md:
--
--   1. Custom fields use a JSON `properties` column plus `field_defs`, not the
--      typed slot columns of ADR-03. Slots exist to make per-tenant indexes
--      possible in Postgres; this is single-file SQLite, so json_extract with
--      an expression index is the same trade at a fraction of the complexity.
--      Migrating slots in later is additive.
--   2. Domain events are written in the same transaction as the mutation
--      (audit_events doubles as the outbox) rather than to a separate outbox
--      table. Same crash-safety guarantee; one table instead of two.
-- ============================================================================
--
--  THIS FILE IS A POSTGRES PORT OF schema.sql, for the Postgres-on-Railway
--  evaluation (lib/postgres.mjs / DATABASE_URL). schema.sql itself is
--  untouched and remains what SQLite/Turso deployments load.
--
--  Mechanical differences from schema.sql:
--   - No `PRAGMA` lines (SQLite-only; Postgres has no equivalent need here).
--   - `BLOB` -> `BYTEA` (document_blobs.bytes).
--  One non-mechanical difference:
--   - `search_index` was a SQLite `fts5` virtual table. Postgres has no such
--     thing, so it's a real table here with a generated `tsvector` column and
--     a GIN index. Row-level INSERT/DELETE by record_id (lib/repo.mjs) work
--     unchanged; the ranked search queries in api/search.mjs do not, and
--     need a Postgres-specific branch (`@@`/`ts_rank()` in place of SQLite's
--     `MATCH`/`bm25()`).
-- ============================================================================


-- ---------------------------------------------------------------- identity --

CREATE TABLE IF NOT EXISTS workspaces (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    base_currency       TEXT NOT NULL DEFAULT 'USD',
    timezone            TEXT NOT NULL DEFAULT 'Asia/Riyadh',
    locale              TEXT NOT NULL DEFAULT 'en',
    -- 0=Sunday. Gulf default is Friday+Saturday, not Saturday+Sunday. Task
    -- scheduling reads this; getting it wrong makes every "due in 3 working
    -- days" wrong for this market.
    weekend_days        TEXT NOT NULL DEFAULT '[5,6]',
    verdict_stale_days  INTEGER NOT NULL DEFAULT 180,
    created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id             TEXT PRIMARY KEY,
    email          TEXT NOT NULL UNIQUE,
    name           TEXT NOT NULL,
    password_hash  TEXT NOT NULL,
    timezone       TEXT,
    status         TEXT NOT NULL DEFAULT 'active',
    created_at     TEXT NOT NULL
);

-- Permissions belong to the MEMBERSHIP, never to the user. One person can hold
-- different roles in different workspaces; putting `role` on `users` is what
-- makes multi-workspace support a rewrite later.
CREATE TABLE IF NOT EXISTS memberships (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    user_id       TEXT NOT NULL REFERENCES users(id),
    role          TEXT NOT NULL,          -- owner | admin | manager | rep | readonly
    team          TEXT,
    created_at    TEXT NOT NULL,
    UNIQUE (workspace_id, user_id)
);

-- Which database this file is, and whether it is still the live one.
--
-- Exactly one row, enforced by the CHECK. It exists to make "there is only one
-- database" a property the software enforces rather than something everybody
-- has to remember.
--
-- The failure it prevents: the CRM is moved to a server, and weeks later
-- someone runs `npm start` on the old laptop, works in it for a day, and now
-- two databases have both changed. Merging those is not a restore — it is
-- reconciling two histories by hand, and some of it is simply lost.
--
-- `retire-database.mjs` marks a copy retired; the server refuses to boot on it.
-- Scripts still run, so a retired copy can still be backed up or inspected.
CREATE TABLE IF NOT EXISTS database_identity (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    instance_id  TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'primary',   -- primary | retired
    moved_to     TEXT,
    retired_at   TEXT,
    note         TEXT,
    created_at   TEXT NOT NULL
);

-- Which of the one-off apply-*/backfill-*.mjs scripts in the repo root have
-- actually been run against THIS database, and when.
--
-- Those scripts are how a structural change reaches the data (renaming a
-- pipeline stage, backfilling a new column) — schema.sql only ever adds,
-- never rewrites. Nothing recorded which of them had already run against the
-- live database, so nobody could look at production and know its true state
-- with confidence, only trust institutional memory. See migration-log.mjs.
CREATE TABLE IF NOT EXISTS schema_migrations (
    name         TEXT PRIMARY KEY,   -- the script's filename, e.g. apply-won-lost-stages.mjs
    applied_at   TEXT NOT NULL,
    note         TEXT                -- optional: who ran it, or why, in their own words
);

CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,       -- sha256 of the cookie token, never the token
    user_id       TEXT NOT NULL REFERENCES users(id),
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- One-time password reset links.
--
-- Same discipline as sessions: only the SHA-256 of the token is stored, so a
-- leaked database backup cannot be turned into a working reset link. Issued by
-- an admin and handed to the person directly, because this system sends no
-- email — see docs/07-operations.md.
--
-- Rows are kept after use rather than deleted: "who reset whose password, and
-- when" is exactly the question an account dispute asks later.
CREATE TABLE IF NOT EXISTS password_resets (
    id            TEXT PRIMARY KEY,       -- sha256 of the link token, never the token
    user_id       TEXT NOT NULL REFERENCES users(id),
    issued_by     TEXT REFERENCES users(id),
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    used_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id, created_at DESC);

-- Personal integration tokens (lib/auth.mjs `contextForApiKey`) — the
-- credential a tool like Make or Zapier presents in an `X-Api-Key` header
-- instead of a session cookie. A key acts as whoever created it, so it
-- carries no role of its own. Same discipline as `sessions` above: only the
-- SHA-256 of the raw key is stored, so a leaked database backup cannot be
-- replayed as a working key. `key_prefix` keeps enough of the raw key in the
-- clear for the owner to tell keys apart in a list, and nothing more.
CREATE TABLE IF NOT EXISTS api_keys (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    user_id       TEXT NOT NULL REFERENCES users(id),
    name          TEXT NOT NULL,
    key_hash      TEXT NOT NULL UNIQUE,
    key_prefix    TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    last_used_at  TEXT,
    revoked_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_workspace ON api_keys(workspace_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

-- ----------------------------------------------------- configuration plane --

CREATE TABLE IF NOT EXISTS field_defs (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    object_key    TEXT NOT NULL,          -- account | contact | deal | ...
    key           TEXT NOT NULL,
    label         TEXT NOT NULL,
    type          TEXT NOT NULL,          -- text|textarea|number|currency|date|datetime|select|multiselect|checkbox|url|email|phone|user|percent
    options       TEXT,                   -- JSON array for select types
    required      INTEGER NOT NULL DEFAULT 0,
    -- The index budget. A field is only offered in the filter builder when
    -- `filterable`; the builder explains the omission rather than hiding it.
    filterable    INTEGER NOT NULL DEFAULT 1,
    sortable      INTEGER NOT NULL DEFAULT 1,
    searchable    INTEGER NOT NULL DEFAULT 0,
    is_system     INTEGER NOT NULL DEFAULT 0,
    help          TEXT,
    position      INTEGER NOT NULL DEFAULT 0,
    deleted_at    TEXT,
    created_at    TEXT NOT NULL,
    UNIQUE (workspace_id, object_key, key)
);

CREATE TABLE IF NOT EXISTS pipelines (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    key           TEXT NOT NULL,
    label         TEXT NOT NULL,
    object_key    TEXT NOT NULL DEFAULT 'deal',
    is_default    INTEGER NOT NULL DEFAULT 0,
    position      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    UNIQUE (workspace_id, key)
);

CREATE TABLE IF NOT EXISTS stages (
    id               TEXT PRIMARY KEY,
    workspace_id     TEXT NOT NULL REFERENCES workspaces(id),
    pipeline_id      TEXT NOT NULL REFERENCES pipelines(id),
    key              TEXT NOT NULL,
    label            TEXT NOT NULL,
    position         INTEGER NOT NULL DEFAULT 0,
    probability      REAL NOT NULL DEFAULT 0,
    type             TEXT NOT NULL DEFAULT 'open',   -- open | won | lost
    required_fields  TEXT NOT NULL DEFAULT '[]',     -- JSON array of field keys
    wip_limit        INTEGER,
    UNIQUE (pipeline_id, key)
);

CREATE TABLE IF NOT EXISTS activity_types (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    key           TEXT NOT NULL,
    label         TEXT NOT NULL,
    icon          TEXT NOT NULL DEFAULT 'dot',
    color         TEXT NOT NULL DEFAULT 'info',
    manual        INTEGER NOT NULL DEFAULT 1,
    position      INTEGER NOT NULL DEFAULT 0,
    UNIQUE (workspace_id, key)
);

CREATE TABLE IF NOT EXISTS service_lines (
    id             TEXT PRIMARY KEY,
    workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
    key            TEXT NOT NULL,
    label          TEXT NOT NULL,
    pricing_model  TEXT NOT NULL,          -- placement_fee | per_seat | per_headcount | fixed_fee
    rule_key       TEXT,                   -- default qualification rule
    position       INTEGER NOT NULL DEFAULT 0,
    UNIQUE (workspace_id, key)
);

/**
 * What each part of the business is aiming at, per service.
 *
 * Configuration, not code: the business changes a target by editing a row, and
 * the dashboard reads it. One row per (account type, service) — the spec asks
 * for a target per combination and nothing more, so there is no period column
 * and no history. A combination with no row is NOT a target of zero; it is a
 * target nobody has set, and the dashboard says so rather than reporting 0%.
 *
 * Held in USD, the reporting currency, because that is what it is compared
 * against once EGP and SAR figures have been normalised.
 */
CREATE TABLE IF NOT EXISTS service_targets (
    workspace_id     TEXT NOT NULL REFERENCES workspaces(id),
    account_type     TEXT NOT NULL,          -- Egypt | Regional
    service_line_key TEXT NOT NULL,
    target_amount    REAL NOT NULL DEFAULT 0,
    updated_at       TEXT NOT NULL,
    updated_by       TEXT REFERENCES users(id),
    PRIMARY KEY (workspace_id, account_type, service_line_key)
);

CREATE TABLE IF NOT EXISTS loss_reasons (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    key           TEXT NOT NULL,
    label         TEXT NOT NULL,
    position      INTEGER NOT NULL DEFAULT 0,
    UNIQUE (workspace_id, key)
);

-- A rule is data: key + version + config. Changing a threshold publishes a NEW
-- version, so a verdict can always name the exact rule that produced it.
CREATE TABLE IF NOT EXISTS qualification_rules (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    key           TEXT NOT NULL,           -- hcm | offshoring
    label         TEXT NOT NULL,
    engine        TEXT NOT NULL,           -- which rule module evaluates it
    claim_type    TEXT NOT NULL,           -- presence | absence  (gates which side coverage guards)
    version       INTEGER NOT NULL DEFAULT 1,
    summary       TEXT NOT NULL DEFAULT '',
    config        TEXT NOT NULL DEFAULT '{}',
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL,
    created_by    TEXT,
    UNIQUE (workspace_id, key, version)
);

-- ------------------------------------------------------------ record plane --

-- Campaigns are a RECORD, not a picklist: they have an owner, a budget, a
-- membership and a result. Declared before accounts and contacts because both
-- carry a campaign_id foreign key.
--
-- This is source attribution, not marketing automation. There is no sending, no
-- landing page and no open tracking here — a campaign records that an outbound
-- push happened, who it reached, and what it produced. Everything downstream
-- reads it as metadata, so "LinkedIn Q3 HCM push" is a row, never an enum.
CREATE TABLE IF NOT EXISTS campaigns (
    id                TEXT PRIMARY KEY,
    workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
    key               TEXT,                              -- optional stable handle for imports
    name              TEXT NOT NULL,
    description       TEXT,
    status            TEXT NOT NULL DEFAULT 'planned',   -- planned|active|paused|completed|cancelled
    channel           TEXT,                              -- linkedin|email|event|referral|paid|partner|other
    -- Which service line the campaign sells. This is what lets "HCM campaigns"
    -- be a filter rather than a naming convention.
    service_line_key  TEXT,
    -- The rule a campaign's audience was drawn from, when it was built from a
    -- qualification run. Closes the loop from ICP rule -> outreach -> revenue.
    rule_key          TEXT,
    start_date        TEXT,
    end_date          TEXT,
    budget_amount     REAL,
    currency          TEXT NOT NULL DEFAULT 'USD',
    goal              TEXT,
    owner_id          TEXT REFERENCES users(id),
    external_id       TEXT,
    properties        TEXT NOT NULL DEFAULT '{}',
    created_by        TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    deleted_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_campaigns_ws ON campaigns(workspace_id, deleted_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_ext ON campaigns(workspace_id, external_id) WHERE external_id IS NOT NULL;

-- Membership is polymorphic (a campaign targets accounts AND contacts) and
-- carries its own status, because "added to the list" and "replied" are
-- different facts about the same person and collapsing them loses the funnel.
--
-- added_at is kept even when the member is removed later: a campaign's reach is
-- a historical fact, and rewriting it makes past reporting move.
CREATE TABLE IF NOT EXISTS campaign_members (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    campaign_id   TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    member_type   TEXT NOT NULL,          -- contact | account
    member_id     TEXT NOT NULL,
    account_id    TEXT,                   -- denormalised for account-level rollups
    status        TEXT NOT NULL DEFAULT 'targeted',   -- targeted|contacted|engaged|responded|converted|excluded
    added_at      TEXT NOT NULL,
    added_by      TEXT,
    removed_at    TEXT,
    notes         TEXT,
    UNIQUE (campaign_id, member_type, member_id)
);
CREATE INDEX IF NOT EXISTS idx_campaign_members_campaign ON campaign_members(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_campaign_members_member   ON campaign_members(member_type, member_id);
CREATE INDEX IF NOT EXISTS idx_campaign_members_account  ON campaign_members(account_id);

CREATE TABLE IF NOT EXISTS accounts (
    id               TEXT PRIMARY KEY,
    workspace_id     TEXT NOT NULL REFERENCES workspaces(id),
    name             TEXT NOT NULL,
    legal_name       TEXT,                 -- e.g. the Arabic legal name
    domain           TEXT,
    linkedin_slug    TEXT,
    cr_number        TEXT,                 -- Commercial Registration: strongest natural key here
    -- The COMMERCIAL grouping — Egypt | Regional — not where the company sits.
    -- `country` below is the address; this is which side of the business owns
    -- the relationship, and a UK-registered entity can be Egypt business.
    account_type     TEXT,
    -- What the client actually pays in. Deliberately its own column and NOT
    -- derived from account_type: a Regional client may pay in SAR or USD, and
    -- an Egypt account may have its own arrangement. Account type only supplies
    -- the opening default (see lib/repo.mjs).
    billing_currency TEXT,
    country          TEXT,
    city             TEXT,
    industry         TEXT,
    employee_count   INTEGER,
    website          TEXT,
    phone            TEXT,
    description      TEXT,
    lifecycle_stage  TEXT NOT NULL DEFAULT 'prospect',
    owner_id         TEXT REFERENCES users(id),
    campaign_id      TEXT REFERENCES campaigns(id),   -- the campaign that sourced it
    source           TEXT,
    external_id      TEXT,                 -- idempotent re-import
    properties       TEXT NOT NULL DEFAULT '{}',
    merged_into_id   TEXT,
    created_by       TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    deleted_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_accounts_ws        ON accounts(workspace_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_accounts_lifecycle ON accounts(workspace_id, lifecycle_stage);
CREATE INDEX IF NOT EXISTS idx_accounts_owner     ON accounts(workspace_id, owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_slug ON accounts(workspace_id, linkedin_slug) WHERE linkedin_slug IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_ext  ON accounts(workspace_id, external_id)   WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS prospecting_companies (
    id               TEXT PRIMARY KEY,
    workspace_id     TEXT NOT NULL REFERENCES workspaces(id),
    name             TEXT NOT NULL,
    domain           TEXT,
    website          TEXT,
    linkedin_slug    TEXT,
    industry         TEXT,
    country          TEXT,
    city             TEXT,
    employee_count   INTEGER,
    phone            TEXT,
    description      TEXT,
    status           TEXT NOT NULL DEFAULT 'uploaded',
    -- The upload this company arrived in. Prospecting is a historical record, so
    -- "which file did this come from, and who uploaded it?" must stay answerable
    -- for the life of the row — including after the company has been imported
    -- into the CRM and is being worked as an Account.
    import_batch_id  TEXT REFERENCES import_batches(id),
    imported_account_id TEXT REFERENCES accounts(id),
    imported_at      TEXT,
    owner_id         TEXT REFERENCES users(id),
    campaign_id      TEXT REFERENCES campaigns(id),
    source           TEXT,
    external_id      TEXT,
    score            REAL,
    duplicated       TEXT,
    duplicate_of_id  TEXT REFERENCES prospecting_companies(id),
    properties       TEXT NOT NULL DEFAULT '{}',
    created_by       TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    deleted_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_prospecting_companies_ws       ON prospecting_companies(workspace_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_prospecting_companies_status   ON prospecting_companies(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_prospecting_companies_owner    ON prospecting_companies(workspace_id, owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prospecting_companies_slug ON prospecting_companies(workspace_id, linkedin_slug) WHERE linkedin_slug IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_prospecting_companies_ext  ON prospecting_companies(workspace_id, external_id)   WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS contacts (
    id             TEXT PRIMARY KEY,
    workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
    account_id     TEXT REFERENCES accounts(id),
    first_name     TEXT NOT NULL DEFAULT '',
    last_name      TEXT NOT NULL DEFAULT '',
    title          TEXT,
    email          TEXT,
    phone          TEXT,
    linkedin_url   TEXT,
    -- Roles are FLAGS, not one exclusive type: a person is often both the
    -- primary contact and a decision maker.
    roles          TEXT NOT NULL DEFAULT '[]',
    is_active      INTEGER NOT NULL DEFAULT 1,
    -- Which service this person is a buyer for, and which campaign brought them
    -- in. Both are keys into configuration tables rather than free text, so a
    -- renamed service or campaign does not orphan the contacts pointing at it.
    service_line_key TEXT,
    campaign_id      TEXT REFERENCES campaigns(id),
    -- Personal-data obligations are first class, not an afterthought.
    data_source    TEXT,
    acquired_at    TEXT,
    lawful_basis   TEXT,
    owner_id       TEXT REFERENCES users(id),
    external_id    TEXT,
    properties     TEXT NOT NULL DEFAULT '{}',
    created_by     TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    deleted_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_contacts_ws      ON contacts(workspace_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id);
CREATE INDEX IF NOT EXISTS idx_contacts_email   ON contacts(workspace_id, email);

CREATE TABLE IF NOT EXISTS prospecting_contacts (
    id                TEXT PRIMARY KEY,
    workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
    prospect_id       TEXT NOT NULL REFERENCES prospecting_companies(id),
    import_batch_id   TEXT REFERENCES import_batches(id),
    first_name        TEXT NOT NULL DEFAULT '',
    last_name         TEXT NOT NULL DEFAULT '',
    title             TEXT,
    email             TEXT,
    phone             TEXT,
    linkedin_url      TEXT,
    roles             TEXT NOT NULL DEFAULT '[]',
    is_active         INTEGER NOT NULL DEFAULT 1,
    service_line_key  TEXT,
    campaign_id       TEXT REFERENCES campaigns(id),
    data_source       TEXT,
    acquired_at       TEXT,
    lawful_basis      TEXT,
    email_verified    INTEGER NOT NULL DEFAULT 0,
    verification_status TEXT,
    owner_id          TEXT REFERENCES users(id),
    external_id       TEXT,
    properties        TEXT NOT NULL DEFAULT '{}',
    created_by        TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    deleted_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_prospecting_contacts_ws      ON prospecting_contacts(workspace_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_prospecting_contacts_prospect ON prospecting_contacts(prospect_id);
CREATE INDEX IF NOT EXISTS idx_prospecting_contacts_email   ON prospecting_contacts(workspace_id, email);

-- NOTE: there is deliberately no `amount` column. A deal's value is derived
-- from its line items (see deal_line_items and lib/money.mjs). A single decimal
-- cannot express "3 placements at 15% plus 40 seats at 120 SAR/month for 24
-- months", and every deal entered before that is discovered needs manual repair.
CREATE TABLE IF NOT EXISTS deals (
    id                  TEXT PRIMARY KEY,
    workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
    account_id          TEXT NOT NULL REFERENCES accounts(id),
    name                TEXT NOT NULL,
    pipeline_id         TEXT NOT NULL REFERENCES pipelines(id),
    stage_id            TEXT NOT NULL REFERENCES stages(id),
    status              TEXT NOT NULL DEFAULT 'open',    -- open | won | lost
    currency            TEXT NOT NULL DEFAULT 'USD',
    probability         REAL,                            -- override; NULL = use stage
    probability_reason  TEXT,
    close_date          TEXT,
    closed_at           TEXT,
    close_fx_rate       TEXT,                            -- JSON {CUR: rate} frozen at close
    loss_reason         TEXT,
    service_line_key    TEXT,
    -- Attribution. A campaign that cannot be traced to revenue is a cost centre
    -- with a nice chart.
    campaign_id         TEXT REFERENCES campaigns(id),
    owner_id            TEXT REFERENCES users(id),
    source_verdict_id   TEXT,                            -- closes the loop ICP -> revenue
    external_id         TEXT,
    /**
     * The line-item rollups, cached so SQL can ORDER BY and WHERE on them.
     *
     * THE LINE ITEMS REMAIN AUTHORITATIVE. Nothing displays these columns —
     * every read path still derives the figures from `deal_line_items` through
     * `deriveValues`, so a stale cache can never put a wrong number in front of
     * anybody. They exist because "show me my biggest open deals" is a sort, a
     * sort happens in SQL, and SQL cannot see a value that is computed in
     * JavaScript after the page has been fetched.
     *
     * Written only by `syncDealValues` in lib/repo.mjs, from the same
     * `deriveValues` the display path uses, so there is one implementation of
     * the maths and this is a projection of it rather than a second opinion.
     */
    value_one_time      REAL NOT NULL DEFAULT 0,
    value_mrr           REAL NOT NULL DEFAULT 0,
    value_arr           REAL NOT NULL DEFAULT 0,
    value_weighted      REAL NOT NULL DEFAULT 0,
    value_tcv           REAL NOT NULL DEFAULT 0,
    properties          TEXT NOT NULL DEFAULT '{}',
    created_by          TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    deleted_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_deals_ws      ON deals(workspace_id, deleted_at);
-- The indexes on the value columns are NOT here. This file runs before the
-- column migrations, so on an existing database `deals` has no value_one_time
-- yet and an index naming it fails the whole migration on boot. They live in
-- INDEX_MIGRATIONS in lib/db.mjs, which runs after the columns are added.
CREATE INDEX IF NOT EXISTS idx_deals_account ON deals(account_id);
CREATE INDEX IF NOT EXISTS idx_deals_stage   ON deals(stage_id);
CREATE INDEX IF NOT EXISTS idx_deals_owner   ON deals(workspace_id, owner_id);

CREATE TABLE IF NOT EXISTS deal_line_items (
    id                TEXT PRIMARY KEY,
    workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
    deal_id           TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    label             TEXT NOT NULL,
    service_line_key  TEXT,
    pricing_model     TEXT NOT NULL,      -- placement_fee | per_seat | per_headcount | fixed_fee
    recurrence        TEXT NOT NULL,      -- one_time | monthly
    quantity          REAL NOT NULL DEFAULT 1,
    unit_amount       REAL NOT NULL DEFAULT 0,   -- per unit, per period for recurring
    percent_rate      REAL,               -- placement_fee: % of basis_amount
    basis_amount      REAL,               -- placement_fee: first-year salary
    term_months       INTEGER,            -- recurring only
    currency          TEXT NOT NULL DEFAULT 'USD',
    fx_rate           REAL NOT NULL DEFAULT 1,   -- to workspace base currency
    notes             TEXT,
    position          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_line_items_deal ON deal_line_items(deal_id);

/**
 * WHAT A DEAL WAS WORTH, AND FROM WHEN.
 *
 * ── THE PROBLEM WITH ONE PRICE PER DEAL ─────────────────────────────────────
 *
 * A retainer is re-quoted mid-contract: twelve people at 3,000 for the first
 * quarter, then eight at 5,000 for the rest of the year. With a single price on
 * the deal, typing the new figure OVERWRITES the old one — and the year's
 * forecast retrospectively claims the first quarter was worth what the second
 * one is. The number that was true in March stops having ever been true.
 *
 * So a deal's price is a SERIES. Each row is "from this date, this is what it
 * costs", nothing is ever updated in place, and any period of the year is
 * valued with the row in force during it. Re-quoting appends; it does not edit.
 *
 * ── WHY THE CURRENT PRICE STILL LIVES IN deal_line_items ────────────────────
 *
 * Because every read path in the product already goes through it, and a second
 * source of truth for "what is this deal worth now" is exactly the split this
 * schema avoids elsewhere. The line item is a PROJECTION of the row in force
 * today, written only by `setDealPrice` — the same relationship `deals.value_*`
 * has to the line items themselves.
 *
 * ── STATUS ──────────────────────────────────────────────────────────────────
 *
 * `pending_approval` is a price a rep has proposed and a manager has not yet
 * agreed to. It is stored, so nothing is lost and the proposal is visible, and
 * it is NOT in force: `priceInForce` reads only `active`. Approving flips it;
 * rejecting leaves it as evidence of what was asked for.
 */
CREATE TABLE IF NOT EXISTS deal_price_periods (
    id              TEXT PRIMARY KEY,
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
    deal_id         TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    -- The date this price starts applying. A deal's first price starts the day
    -- the deal was priced, so there is never a gap before the earliest row.
    effective_from  TEXT NOT NULL,
    -- The same two halves the line item carries: a rate, and how many of them.
    unit_amount     REAL NOT NULL DEFAULT 0,
    quantity        REAL NOT NULL DEFAULT 1,
    currency        TEXT NOT NULL DEFAULT 'USD',
    fx_rate         REAL NOT NULL DEFAULT 1,
    recurrence      TEXT NOT NULL DEFAULT 'one_time',
    term_months     INTEGER,
    status          TEXT NOT NULL DEFAULT 'active',   -- active | pending_approval | rejected
    note            TEXT,
    created_by      TEXT REFERENCES users(id),
    created_at      TEXT NOT NULL,
    approved_by     TEXT REFERENCES users(id),
    approved_at     TEXT,
    review_note     TEXT
);
CREATE INDEX IF NOT EXISTS idx_price_periods_deal
    ON deal_price_periods(deal_id, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_price_periods_pending
    ON deal_price_periods(workspace_id, status);

CREATE TABLE IF NOT EXISTS deal_stage_history (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL,
    deal_id       TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    from_stage_id TEXT,
    to_stage_id   TEXT NOT NULL,
    entered_at    TEXT NOT NULL,
    exited_at     TEXT,
    actor_id      TEXT
);
CREATE INDEX IF NOT EXISTS idx_stage_hist_deal ON deal_stage_history(deal_id);

CREATE TABLE IF NOT EXISTS deal_contacts (
    deal_id     TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    role        TEXT,
    PRIMARY KEY (deal_id, contact_id)
);

-- ------------------------------------------- attachments (polymorphic + rollup) --
--
--  parent_type / parent_id is the true parent. account_id is DENORMALISED so
--  that an activity logged on a deal shows on the account timeline without a
--  join per row — the most frequent read in the product.

CREATE TABLE IF NOT EXISTS tasks (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    parent_type   TEXT,
    parent_id     TEXT,
    account_id    TEXT REFERENCES accounts(id),
    title         TEXT NOT NULL,
    description   TEXT,
    assignee_id   TEXT REFERENCES users(id),
    due_at        TEXT,                    -- always UTC; rendered in the viewer's timezone
    priority      TEXT NOT NULL DEFAULT 'B',   -- A | B | C
    status        TEXT NOT NULL DEFAULT 'open',     -- open | in_progress | done | cancelled
    completed_at  TEXT,
    properties    TEXT NOT NULL DEFAULT '{}',
    created_by    TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_ws       ON tasks(workspace_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(workspace_id, assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent   ON tasks(parent_type, parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_account  ON tasks(account_id);

CREATE TABLE IF NOT EXISTS activities (
    id                TEXT PRIMARY KEY,
    workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
    parent_type       TEXT NOT NULL,
    parent_id         TEXT NOT NULL,
    account_id        TEXT REFERENCES accounts(id),
    type_key          TEXT NOT NULL,
    subject           TEXT,
    body              TEXT,
    -- occurred_at is when it happened; created_at is when it was typed in.
    -- Logging Tuesday's call on Thursday must place it on Tuesday.
    occurred_at       TEXT NOT NULL,
    duration_minutes  INTEGER,
    direction         TEXT,                -- inbound | outbound
    actor_id          TEXT REFERENCES users(id),
    source            TEXT NOT NULL DEFAULT 'ui',   -- ui | api | automation | import | system
    properties        TEXT NOT NULL DEFAULT '{}',
    -- ── A MEETING'S OWN DATE AND OWN STATE ──────────────────────────────────
    --
    -- A booked meeting is an activity with meeting_at set. Both columns exist
    -- because the two questions a meeting is asked cannot be answered from the
    -- call that booked it:
    --
    --   meeting_at      WHEN the meeting is, which is not occurred_at. The call
    --                   happened on Monday; the meeting is on Thursday, and a
    --                   report about meetings has to date them by Thursday.
    --                   It lived in properties JSON, which no index can reach.
    --
    --   meeting_status  scheduled | done | no_show. A NO SHOW IS A FACT, and
    --                   inferring it from the absence of "done" would count
    --                   every meeting that has not happened yet as one — which
    --                   is why the show rate needs this column rather than a
    --                   clever query. Upcoming is `scheduled` with meeting_at
    --                   in the future; nothing writes "no_show" but a person.
    meeting_at        TEXT,
    meeting_status    TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    deleted_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_activities_parent  ON activities(parent_type, parent_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_account ON activities(account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_ws      ON activities(workspace_id, occurred_at DESC);
-- The index on meeting_at is NOT here. This file is executed in full before
-- applyColumnMigrations, so an index naming a migrated column fails on every
-- database that predates it — and a failed migration takes the server down on
-- start. It lives in INDEX_MIGRATIONS in lib/db.mjs, which runs after.

CREATE TABLE IF NOT EXISTS notes (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    parent_type   TEXT NOT NULL,
    parent_id     TEXT NOT NULL,
    account_id    TEXT REFERENCES accounts(id),
    body          TEXT NOT NULL,
    mentions      TEXT NOT NULL DEFAULT '[]',
    pinned        INTEGER NOT NULL DEFAULT 0,
    author_id     TEXT REFERENCES users(id),
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_parent  ON notes(parent_type, parent_id);
CREATE INDEX IF NOT EXISTS idx_notes_account ON notes(account_id);

CREATE TABLE IF NOT EXISTS documents (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    parent_type   TEXT NOT NULL,
    parent_id     TEXT NOT NULL,
    account_id    TEXT REFERENCES accounts(id),
    name          TEXT NOT NULL,
    kind          TEXT NOT NULL DEFAULT 'file',   -- file | proposal | agreement | generated
    mime          TEXT,
    size_bytes    INTEGER NOT NULL DEFAULT 0,
    -- Files live on disk under storage/. The row holds the key; the bytes are
    -- served through a short-lived signed URL. On a host with no persistent
    -- disk they are ALSO kept in document_blobs below, because there the
    -- directory does not survive a restart.
    storage_key   TEXT NOT NULL,
    checksum      TEXT,
    uploaded_by   TEXT REFERENCES users(id),
    created_at    TEXT NOT NULL,
    deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_parent  ON documents(parent_type, parent_id);
CREATE INDEX IF NOT EXISTS idx_documents_account ON documents(account_id);

-- The bytes of an uploaded or generated file, in chunks, for deployments where
-- the filesystem is discarded on every restart. Keyed by storage_key rather
-- than by document id because templates use the same store and are not rows in
-- `documents`. See lib/document-store.mjs.
--
-- No foreign key: a chunk outliving its row for a moment during a delete is
-- harmless, whereas a cascade firing halfway through a 5MB write is not.
CREATE TABLE IF NOT EXISTS document_blobs (
    storage_key   TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    bytes         BYTEA NOT NULL,
    PRIMARY KEY (storage_key, seq)
);

-- --------------------------------------------------- proposals & agreements --
--
--  THE ACCOUNT'S DOCUMENTS ARE THE THING; THESE LISTS ARE WIRED TO THEM.
--
--  An account lists every generated proposal and agreement, one row per
--  version. The sidebar's Proposals and Agreements lists show the same rows —
--  one record here for one generated document there, joined by `document_id`.
--  Generating a new version produces a new document and therefore a new record;
--  it never edits the one already made, because that one is still the file
--  somebody was sent.
--
--  What the record adds is what a file cannot carry: a number, an owner, a
--  status, and on an agreement the contract term the renewals report reads.
--
--  `document_type` is the DOCUMENT_TYPES key, and `document_id` the file. Both
--  are NULL on a proposal built from a deal's line items (`proposal_versions`
--  below), which is the other, older way of producing one.
--
--  `deal_id` is nullable because a document is generated FOR AN ACCOUNT — the
--  company, its registration and its services are what a proposal is written
--  from, and requiring a deal first put a second record between a user and a
--  document that never needed one. A deal is recorded when there was one.

CREATE TABLE IF NOT EXISTS proposals (
    id               TEXT PRIMARY KEY,
    workspace_id     TEXT NOT NULL REFERENCES workspaces(id),
    deal_id          TEXT REFERENCES deals(id),
    account_id       TEXT NOT NULL REFERENCES accounts(id),
    document_type    TEXT,
    document_id      TEXT REFERENCES documents(id),
    number           TEXT NOT NULL,
    title            TEXT NOT NULL,
    currency         TEXT NOT NULL DEFAULT 'USD',
    status           TEXT NOT NULL DEFAULT 'draft',   -- draft|issued|sent|accepted|declined|superseded
    current_version  INTEGER NOT NULL DEFAULT 0,
    owner_id         TEXT REFERENCES users(id),
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    deleted_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_proposals_deal ON proposals(deal_id);

-- Immutable once issued. A change makes v2 — it never rewrites v1, because the
-- customer is holding v1.
CREATE TABLE IF NOT EXISTS proposal_versions (
    id             TEXT PRIMARY KEY,
    workspace_id   TEXT NOT NULL,
    proposal_id    TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
    version        INTEGER NOT NULL,
    status         TEXT NOT NULL DEFAULT 'draft',   -- draft | issued
    issued_at      TEXT,
    sent_at        TEXT,
    valid_until    TEXT,
    -- A frozen copy of the deal's line items and merge data at issue time, so
    -- the proposal can never silently disagree with what the customer received.
    content        TEXT NOT NULL,
    rendered_html  TEXT,
    total_one_time REAL NOT NULL DEFAULT 0,
    total_mrr      REAL NOT NULL DEFAULT 0,
    term_months    INTEGER,
    created_by     TEXT,
    created_at     TEXT NOT NULL,
    UNIQUE (proposal_id, version)
);

CREATE TABLE IF NOT EXISTS agreements (
    id                      TEXT PRIMARY KEY,
    workspace_id            TEXT NOT NULL REFERENCES workspaces(id),
    -- Nullable, and `document_type` / `document_id` present, for the reasons
    -- given above the proposals table: an agreement is generated for an
    -- account, and the record is the sidebar's view of that document.
    deal_id                 TEXT REFERENCES deals(id),
    account_id              TEXT NOT NULL REFERENCES accounts(id),
    document_type           TEXT,
    document_id             TEXT REFERENCES documents(id),
    number                  TEXT NOT NULL,
    title                   TEXT NOT NULL,
    type                    TEXT NOT NULL DEFAULT 'sow',    -- msa | sow | renewal | amendment
    status                  TEXT NOT NULL DEFAULT 'draft',  -- draft|out_for_signature|signed|expired|terminated
    signed_at               TEXT,
    effective_date          TEXT,
    expiry_date             TEXT,
    notice_days             INTEGER NOT NULL DEFAULT 0,
    auto_renew              INTEGER NOT NULL DEFAULT 0,
    -- The renewal chain. Without it, contract history is a pile of
    -- similarly-named PDFs.
    supersedes_agreement_id TEXT REFERENCES agreements(id),
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL,
    deleted_at              TEXT
);
CREATE INDEX IF NOT EXISTS idx_agreements_deal ON agreements(deal_id);

-- Zero or more: an MSA covers many SOWs, and inbound deals close with no
-- proposal at all.
CREATE TABLE IF NOT EXISTS agreement_proposals (
    agreement_id         TEXT NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
    proposal_version_id  TEXT NOT NULL REFERENCES proposal_versions(id),
    PRIMARY KEY (agreement_id, proposal_version_id)
);

-- ------------------------------------------------- document generation --
--
--  The port of the Apps Script DMS (see docs/10-automation-port-map.md).
--
--  WHAT IS DELIBERATELY NOT HERE: a second document store, and a second file
--  table. A generated document IS a row in `documents` like any other file —
--  same storage, same signed URLs, same authorisation — and it hangs off the
--  ACCOUNT, so it already appears there with no new plumbing. The tables below
--  add only what `documents` cannot answer: which template and which data
--  produced this file, which version it is, and who has opened it.
--
--  WHY THE ACCOUNT AND NOT THE DEAL. The Apps Script generated from an
--  Opportunity because an Opportunity was the only record it had. This CRM has
--  a real account spine — the company, its commercial registration, its
--  services, its contacts — and that is where a proposal is written from. A
--  deal is OPTIONAL context, recorded when the generation came from one, so a
--  document can still be traced to the deal it was written for.

-- The .docx templates, on disk, one row per template.
--
-- `checksum` is recorded on every generation, so "which exact template made
-- this contract?" survives the template being re-uploaded later. That question
-- is asked precisely when a client disputes a clause.
CREATE TABLE IF NOT EXISTS document_templates (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    key           TEXT NOT NULL,               -- hcm_proposal | hcm_agreement | offshoring_proposal | offshoring_agreement
    label         TEXT NOT NULL,
    version       INTEGER NOT NULL DEFAULT 1,
    storage_key   TEXT NOT NULL,
    checksum      TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL DEFAULT 0,
    uploaded_by   TEXT REFERENCES users(id),
    created_at    TEXT NOT NULL,
    retired_at    TEXT,
    UNIQUE (workspace_id, key, version)
);

-- The First Party (الطرف الأول) block of every Arabic agreement.
--
-- At ACCOUNT level, not per document: it is a fact about the company, and both
-- agreement types read the same one. The Arabic name here outranks the
-- account's usually-English name inside those contracts.
--
-- OCR import of the certificate is not built; these are entered by hand today.
CREATE TABLE IF NOT EXISTS commercial_registrations (
    id                   TEXT PRIMARY KEY,
    workspace_id         TEXT NOT NULL REFERENCES workspaces(id),
    account_id           TEXT NOT NULL REFERENCES accounts(id),
    company_name_ar      TEXT,
    cr_number            TEXT,
    representative_name  TEXT,
    address              TEXT,
    source_document_id   TEXT REFERENCES documents(id),
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    UNIQUE (workspace_id, account_id)
);

-- Which of the 7 HCM service scopes this client is buying.
--
-- Held per (account, deal) with `deal_id = ''` meaning the ACCOUNT'S OWN
-- selection — the one the account-level generate flow reads and writes, and the
-- one a deal falls back to until that deal chooses differently. SQLite cannot
-- put NULL in a primary key and have it compare equal, hence the empty string
-- rather than a nullable column.
--
-- Both HCM documents read whichever single row applies, which is what keeps the
-- proposal's Section 3 and the agreement's Article 1 in step without a sync
-- step: there is nothing to sync, they read one row.
CREATE TABLE IF NOT EXISTS hcm_service_selections (
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    deal_id       TEXT NOT NULL DEFAULT '',      -- '' = the account's own selection
    services      TEXT NOT NULL DEFAULT '[]',    -- JSON array of SERVICE_REGISTRY keys
    updated_at    TEXT NOT NULL,
    updated_by    TEXT REFERENCES users(id),
    PRIMARY KEY (workspace_id, account_id, deal_id)
);

-- One row per generated document. This IS the version history.
--
-- Version counts per (account, document type), so an HCM Proposal at v3 and an
-- HCM Agreement at v1 coexist — the same rule the Apps Script used, moved from
-- its Opportunity onto this CRM's account spine. Nothing is ever overwritten:
-- regenerating appends.
--
-- `fields` and `placeholders` are frozen copies of what went in, including the
-- commercial-registration values, so re-importing a certificate later cannot
-- rewrite what an already-issued agreement said.
CREATE TABLE IF NOT EXISTS document_generations (
    id             TEXT PRIMARY KEY,
    workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
    account_id     TEXT NOT NULL REFERENCES accounts(id),
    -- Optional: the deal this was generated for, when it was generated from one.
    deal_id        TEXT REFERENCES deals(id) ON DELETE SET NULL,
    contact_id     TEXT REFERENCES contacts(id),
    document_type  TEXT NOT NULL,               -- a DOCUMENT_TYPES key
    version        INTEGER NOT NULL,
    -- The produced file. NULL only while a generation is being recorded as
    -- failed — a row without a document is never presented as a document.
    document_id    TEXT REFERENCES documents(id),
    template_id    TEXT REFERENCES document_templates(id),
    template_checksum TEXT,
    fields         TEXT NOT NULL DEFAULT '{}',
    placeholders   TEXT NOT NULL DEFAULT '{}',
    services       TEXT NOT NULL DEFAULT '[]',
    status         TEXT NOT NULL DEFAULT 'generated',  -- generated | failed | superseded
    error          TEXT,
    generated_by   TEXT REFERENCES users(id),
    created_at     TEXT NOT NULL,
    UNIQUE (account_id, document_type, version)
);
CREATE INDEX IF NOT EXISTS idx_doc_generations_deal ON document_generations(deal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_doc_generations_account ON document_generations(account_id, created_at DESC);

-- What has actually happened to a document.
--
-- Separate from audit_events on purpose. Audit answers "what changed in the
-- database"; this answers "did the client's copy get opened, and how often".
-- Counting audit rows would report our own writes as customer engagement.
--
-- Append only, like audit_events. Counters are derived from these rows rather
-- than stored, so they cannot drift from the events they claim to summarise.
CREATE TABLE IF NOT EXISTS document_events (
    id             TEXT PRIMARY KEY,
    workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
    generation_id  TEXT NOT NULL REFERENCES document_generations(id) ON DELETE CASCADE,
    document_id    TEXT REFERENCES documents(id),
    event_type     TEXT NOT NULL,               -- generated | opened | downloaded | version_created | failed
    user_id        TEXT REFERENCES users(id),
    metadata       TEXT,
    created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_document_events_gen ON document_events(generation_id, created_at DESC);

-- ---------------------------------------------------------- evidence plane --
--
--  The part with no equivalent in a generic CRM, and the part most easily
--  flattened away by accident. Both tables are APPEND ONLY.

CREATE TABLE IF NOT EXISTS evidence_snapshots (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    subject_type  TEXT NOT NULL DEFAULT 'account',
    subject_key   TEXT NOT NULL,           -- the linkedin slug / domain observed
    account_id    TEXT REFERENCES accounts(id),
    provider      TEXT NOT NULL,
    collected_at  TEXT NOT NULL,
    payload       TEXT NOT NULL,           -- verbatim observation, never edited
    error         TEXT,
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_subject ON evidence_snapshots(workspace_id, subject_key, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_account ON evidence_snapshots(account_id, collected_at DESC);

CREATE TABLE IF NOT EXISTS prospecting_evidence_snapshots (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    subject_type  TEXT NOT NULL DEFAULT 'prospect',
    subject_key   TEXT NOT NULL,
    prospect_id   TEXT REFERENCES prospecting_companies(id),
    provider      TEXT NOT NULL,
    collected_at  TEXT NOT NULL,
    payload       TEXT NOT NULL,
    error         TEXT,
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prospecting_evidence_subject ON prospecting_evidence_snapshots(workspace_id, subject_key, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_prospecting_evidence_prospect ON prospecting_evidence_snapshots(prospect_id, collected_at DESC);

CREATE TABLE IF NOT EXISTS verdicts (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    account_id    TEXT NOT NULL REFERENCES accounts(id),
    -- Redundant with the table itself (this table only ever holds accounts), and
    -- kept anyway so a verdict row is self-describing when it is exported, and so
    -- one INSERT in lib/qualification.mjs serves both planes. subject_key is NOT
    -- redundant: it is the slug/domain as observed AT DECISION TIME, so renaming
    -- a company later does not rewrite the identity a past verdict was made
    -- against. Nullable because rows written before it existed cannot be invented.
    subject_type  TEXT NOT NULL DEFAULT 'account',
    subject_key   TEXT,
    rule_key      TEXT NOT NULL,
    rule_version  INTEGER NOT NULL,
    evidence_id   TEXT REFERENCES evidence_snapshots(id),
    -- QUALIFIED | REVIEW | REJECTED | UNRESOLVED | ERROR.
    -- REVIEW is not a soft REJECTED. It means the evidence could not answer.
    -- Never collapse it into REJECTED in a filter, count, export or chart.
    verdict       TEXT NOT NULL,
    confidence    REAL,
    metrics       TEXT NOT NULL DEFAULT '{}',
    reasons       TEXT NOT NULL DEFAULT '[]',
    notes         TEXT NOT NULL DEFAULT '[]',
    -- 'engine' when a rule produced it, 'manual' when a person settled it from
    -- inside the CRM. A human decision is APPENDED like any other verdict — it
    -- supersedes, it never edits, and the engine's answer stays readable
    -- underneath it. Without this column a manual override is indistinguishable
    -- from the rule agreeing with you.
    source        TEXT NOT NULL DEFAULT 'engine',
    decided_by    TEXT,
    decision_note TEXT,
    computed_at   TEXT NOT NULL,
    is_current    INTEGER NOT NULL DEFAULT 1,
    superseded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_verdicts_account ON verdicts(account_id, rule_key, computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_verdicts_current ON verdicts(workspace_id, rule_key, verdict, is_current);

CREATE TABLE IF NOT EXISTS prospecting_verdicts (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    prospect_id   TEXT NOT NULL REFERENCES prospecting_companies(id),
    subject_type  TEXT NOT NULL DEFAULT 'prospect',
    subject_key   TEXT,
    rule_key      TEXT NOT NULL,
    rule_version  INTEGER NOT NULL,
    evidence_id   TEXT REFERENCES prospecting_evidence_snapshots(id),
    verdict       TEXT NOT NULL,
    confidence    REAL,
    metrics       TEXT NOT NULL DEFAULT '{}',
    reasons       TEXT NOT NULL DEFAULT '[]',
    notes         TEXT NOT NULL DEFAULT '[]',
    source        TEXT NOT NULL DEFAULT 'engine',
    decided_by    TEXT,
    decision_note TEXT,
    computed_at   TEXT NOT NULL,
    is_current    INTEGER NOT NULL DEFAULT 1,
    superseded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_prospecting_verdicts_prospect ON prospecting_verdicts(prospect_id, rule_key, computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_prospecting_verdicts_current ON prospecting_verdicts(workspace_id, rule_key, verdict, is_current);

-- ------------------------------------------------- views, lists, dashboards --

CREATE TABLE IF NOT EXISTS views (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    object_key    TEXT NOT NULL,
    name          TEXT NOT NULL,
    view_type     TEXT NOT NULL DEFAULT 'table',   -- table | kanban | cards | calendar
    filter        TEXT NOT NULL DEFAULT '{"op":"and","children":[]}',
    sort          TEXT NOT NULL DEFAULT '[]',
    columns       TEXT NOT NULL DEFAULT '[]',
    group_by      TEXT,
    owner_id      TEXT REFERENCES users(id),
    scope         TEXT NOT NULL DEFAULT 'private', -- private | workspace
    is_default    INTEGER NOT NULL DEFAULT 0,
    is_system     INTEGER NOT NULL DEFAULT 0,
    position      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_views_object ON views(workspace_id, object_key);

CREATE TABLE IF NOT EXISTS lists (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    object_key    TEXT NOT NULL,
    name          TEXT NOT NULL,
    description   TEXT,
    kind          TEXT NOT NULL DEFAULT 'static',  -- static (curated) | dynamic (saved filter, re-evaluates)
    filter        TEXT NOT NULL DEFAULT '{"op":"and","children":[]}',
    owner_id      TEXT REFERENCES users(id),
    scope         TEXT NOT NULL DEFAULT 'workspace',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS list_members (
    list_id    TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    record_id  TEXT NOT NULL,
    added_at   TEXT NOT NULL,
    added_by   TEXT,
    PRIMARY KEY (list_id, record_id)
);

CREATE TABLE IF NOT EXISTS dashboards (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    name          TEXT NOT NULL,
    layout        TEXT NOT NULL DEFAULT '[]',      -- JSON [{widget, title, size, options}]
    owner_id      TEXT REFERENCES users(id),
    scope         TEXT NOT NULL DEFAULT 'workspace',
    -- Which role this dashboard is FOR. NULL is the workspace-wide one.
    -- A manager and a rep do not need the same screen: the manager's question
    -- is "how is the team doing", the rep's is "what do I do next", and one
    -- layout answering both means each of them scrolls past most of it.
    role          TEXT,
    is_default    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

-- ------------------------------------------------------------- import plane --
--
--  An import is a RECORD of what happened, not a transient wizard state. The
--  summary outlives the browser tab: "what did that upload actually do?" is
--  asked days later, usually by someone who was not the uploader.

CREATE TABLE IF NOT EXISTS import_batches (
    id             TEXT PRIMARY KEY,
    workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
    object_key     TEXT NOT NULL,
    filename       TEXT,
    source         TEXT NOT NULL DEFAULT 'upload',   -- upload | paste | api
    status         TEXT NOT NULL DEFAULT 'preview',  -- preview|running|completed|failed|undone
    -- The mapping and options actually used, so a summary can explain a result
    -- without the original file.
    mapping        TEXT NOT NULL DEFAULT '{}',
    options        TEXT NOT NULL DEFAULT '{}',
    total_rows     INTEGER NOT NULL DEFAULT 0,
    created_count  INTEGER NOT NULL DEFAULT 0,
    updated_count  INTEGER NOT NULL DEFAULT 0,
    skipped_count  INTEGER NOT NULL DEFAULT 0,
    rejected_count INTEGER NOT NULL DEFAULT 0,
    started_at     TEXT,
    finished_at    TEXT,
    undone_at      TEXT,
    error          TEXT,
    created_by     TEXT,
    created_at     TEXT NOT NULL,
    -- Deleting an upload is a SOFT delete, like every other record: it and the
    -- companies it brought in go to the Recycle Bin together and come back
    -- together. A hard delete here would silently destroy evidence that cost
    -- hours of browser time to collect.
    deleted_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_import_batches_ws ON import_batches(workspace_id, created_at DESC);

-- One row per source row that was written or refused. This is what makes
-- "partial success" reportable per row instead of as a number, and what makes
-- undo possible: it remembers which records the batch CREATED, so an undo
-- removes those and leaves records it merely updated alone.
CREATE TABLE IF NOT EXISTS import_rows (
    id           TEXT PRIMARY KEY,
    batch_id     TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
    row_number   INTEGER NOT NULL,
    outcome      TEXT NOT NULL,        -- created | updated | skipped | rejected
    record_id    TEXT,
    reason       TEXT,
    raw          TEXT                  -- the source row, for the error report
);
CREATE INDEX IF NOT EXISTS idx_import_rows_batch ON import_rows(batch_id, outcome);

-- A named, reusable mapping. The same lead-list format arrives every month.
CREATE TABLE IF NOT EXISTS import_templates (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    object_key    TEXT NOT NULL,
    name          TEXT NOT NULL,
    mapping       TEXT NOT NULL DEFAULT '{}',
    options       TEXT NOT NULL DEFAULT '{}',
    created_by    TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE (workspace_id, object_key, name)
);

-- --------------------------------------------------------------- email templates --
--
-- Reusable defaults for the CRM's own business communication — proposal to
-- client, agreement to client, agreement-signed to finance, agreement-signed
-- to internal team. This is NOT a marketing/bulk-send system (see
-- lib/email-templates.mjs); the four categories are the only ones a system
-- template may claim, and a system template's category can never change.
CREATE TABLE IF NOT EXISTS email_templates (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    -- proposal_client | agreement_client | agreement_signed_finance | agreement_signed_internal
    category      TEXT NOT NULL,
    name          TEXT NOT NULL,
    subject       TEXT NOT NULL,
    body          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'draft',  -- draft | active | inactive
    -- Seeded by the product, not a user. The category (and the automation
    -- that fires it) cannot be edited on a system template — only its
    -- subject, body and status can. A user's own template can be deleted;
    -- a system one is only ever deactivated, so a category is never left
    -- with zero templates and an automation with nothing to send.
    is_system     INTEGER NOT NULL DEFAULT 0,
    created_by    TEXT REFERENCES users(id),
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_templates_ws ON email_templates(workspace_id, category, status);

-- ------------------------------------------------------------- email messages --
--
-- One row per email INSTANCE — a resolved, editable copy of a template
-- against one specific record, whether typed by a person (a proposal or
-- agreement send) or raised by automation (agreement signed -> finance /
-- internal team). `template.subject`/`body` are the reusable default;
-- `email_messages.subject`/`body` are what actually goes out for THIS
-- record, editable without touching the template it came from.
--
-- Sending is not implemented yet. 'queued' is as far as this phase goes —
-- the row, the resolved content and the attachments all exist, ready for
-- the next phase's provider connection to pick up, rather than inventing
-- this model at delivery time.
CREATE TABLE IF NOT EXISTS email_messages (
    id                       TEXT PRIMARY KEY,
    workspace_id             TEXT NOT NULL REFERENCES workspaces(id),
    template_id              TEXT REFERENCES email_templates(id),
    category                 TEXT NOT NULL,
    status                   TEXT NOT NULL DEFAULT 'draft',  -- draft | queued | sent | failed | cancelled
    subject                  TEXT NOT NULL,
    body                     TEXT NOT NULL,
    recipient_email          TEXT,
    recipient_name           TEXT,
    recipient_contact_id     TEXT REFERENCES contacts(id),
    cc_emails                TEXT NOT NULL DEFAULT '[]',   -- JSON array — configured Finance/Internal recipients
    account_id               TEXT REFERENCES accounts(id),
    deal_id                  TEXT REFERENCES deals(id),
    proposal_id               TEXT REFERENCES proposals(id),
    agreement_id              TEXT REFERENCES agreements(id),
    attachment_document_ids  TEXT NOT NULL DEFAULT '[]',   -- JSON array of documents.id
    missing_variables         TEXT NOT NULL DEFAULT '[]',  -- JSON array — what could not resolve, at build time
    source                    TEXT NOT NULL DEFAULT 'ui',  -- ui | automation
    -- Idempotency key for an automation-raised email — e.g.
    -- "agreement_signed:{agreementId}:finance". NULL for a person-sent
    -- email, which has no cycle to be idempotent against.
    trigger_event_key         TEXT,
    created_by                TEXT REFERENCES users(id),
    created_at                TEXT NOT NULL,
    updated_at                TEXT NOT NULL,
    sent_at                   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_messages_trigger
    ON email_messages(workspace_id, trigger_event_key) WHERE trigger_event_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_messages_agreement ON email_messages(agreement_id);
CREATE INDEX IF NOT EXISTS idx_email_messages_deal       ON email_messages(deal_id);
CREATE INDEX IF NOT EXISTS idx_email_messages_proposal   ON email_messages(proposal_id);

-- --------------------------------------------------------------------- jobs --
--
--  Work that outlives a request: a collection run against LinkedIn, a large
--  import. The row is the source of truth for progress, so a browser refresh
--  does not lose the run and a second tab sees the same state.

CREATE TABLE IF NOT EXISTS jobs (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    kind          TEXT NOT NULL,                    -- collect_evidence | import | qualify
    status        TEXT NOT NULL DEFAULT 'queued',   -- queued|running|completed|failed|cancelled
    total         INTEGER NOT NULL DEFAULT 0,
    processed     INTEGER NOT NULL DEFAULT 0,
    succeeded     INTEGER NOT NULL DEFAULT 0,
    failed        INTEGER NOT NULL DEFAULT 0,
    input         TEXT NOT NULL DEFAULT '{}',
    result        TEXT NOT NULL DEFAULT '{}',
    log           TEXT NOT NULL DEFAULT '[]',
    error         TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    created_by    TEXT,
    created_at    TEXT NOT NULL,
    started_at    TEXT,
    finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_ws ON jobs(workspace_id, created_at DESC);

-- ---------------------------------------------- audit, notifications, search --

-- Separate store from `activities` on purpose. Different audience, different
-- volume, different retention — and this one is append-only for every user,
-- including admins. There is no UPDATE or DELETE path to it in the codebase.
CREATE TABLE IF NOT EXISTS audit_events (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL,
    object_key    TEXT NOT NULL,
    record_id     TEXT,
    account_id    TEXT,
    action        TEXT NOT NULL,           -- created | updated | deleted | stage_changed | exported ...
    actor_id      TEXT,
    source        TEXT NOT NULL DEFAULT 'ui',
    before        TEXT,
    after         TEXT,
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_record  ON audit_events(record_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_account ON audit_events(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_ws      ON audit_events(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL,
    user_id       TEXT NOT NULL REFERENCES users(id),
    kind          TEXT NOT NULL,
    title         TEXT NOT NULL,
    body          TEXT,
    link          TEXT,
    read_at       TEXT,
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, created_at DESC);

-- Workspace configuration that does not deserve its own table yet: which audit
-- events project into the timeline, notification defaults, and so on. Keeping
-- it here rather than as columns means adding one is a write, not a migration.
CREATE TABLE IF NOT EXISTS settings (
    workspace_id  TEXT NOT NULL,
    key           TEXT NOT NULL,
    value         TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY (workspace_id, key)
);

-- Postgres port of the SQLite fts5 virtual table above. Same columns, same
-- row shape (INSERT/DELETE by record_id work unchanged from lib/repo.mjs),
-- but ranked search itself is not drop-in: SQLite's `MATCH`/`bm25()` become
-- Postgres's `@@`/`ts_rank()` against `search_vector` — see api/search.mjs,
-- which needs a Postgres-specific branch for its two ranked queries.
CREATE TABLE IF NOT EXISTS search_index (
    record_id     TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL,
    object_key    TEXT NOT NULL,
    title         TEXT,
    body          TEXT,
    search_vector TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(title, '')), 'A')
        || setweight(to_tsvector('simple', coalesce(body, '')), 'B')
    ) STORED
);
CREATE INDEX IF NOT EXISTS idx_search_index_vector ON search_index USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_search_index_ws ON search_index(workspace_id, object_key);

-- Every email verification ever run, append-only.
--
-- The contact carries only the CURRENT answer. This table carries how that
-- answer was reached and what it used to be, because "risky" six months ago and
-- "risky" this morning are not the same fact when deciding whether to email
-- someone, and because a provider swap must be visible rather than inferred.
--
-- `raw` keeps the provider's untranslated payload. Nothing outside
-- lib/verification.mjs reads it; it exists so a disputed status can be
-- explained after the fact without re-running and paying for the check again.
CREATE TABLE IF NOT EXISTS email_verifications (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    subject_type  TEXT NOT NULL,          -- contact | prospecting_contact
    subject_id    TEXT NOT NULL,
    email         TEXT NOT NULL,
    status        TEXT NOT NULL,          -- the CRM's vocabulary, never the provider's
    confidence    REAL,
    provider      TEXT NOT NULL,
    raw           TEXT,
    checked_by    TEXT,
    checked_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_verifications_subject
    ON email_verifications(workspace_id, subject_type, subject_id, checked_at DESC);

-- ------------------------------------------------------------ cold calling --
--
-- WHO IS RESPONSIBLE FOR CALLING A CONTACT — which is not the contact's status,
-- and not what happened on any one call. Those are three separate facts and the
-- module depends on keeping them apart:
--
--   contacts.lifecycle / verdicts   what the CRM thinks of this company
--   calling_assignments             whose list it is on right now
--   activities (type_key = 'call')  what happened, once per attempt, forever
--
-- One ACTIVE assignment per contact, enforced by the partial unique index
-- below rather than by a check in application code — two SDRs calling the same
-- person is the failure this module exists to prevent, and a race between two
-- managers assigning at once would slip past any check written in JavaScript.
--
-- Reassigning UPDATES this row rather than inserting another, so the call count
-- and follow-up date follow the contact rather than resetting. Removing sets
-- active = 0 and keeps the row, so the history of who once owned it survives
-- and the contact can be added again later.
CREATE TABLE IF NOT EXISTS calling_assignments (
    id                TEXT PRIMARY KEY,
    workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
    contact_id        TEXT NOT NULL REFERENCES contacts(id),
    account_id        TEXT REFERENCES accounts(id),
    assigned_to       TEXT NOT NULL REFERENCES users(id),
    assigned_by       TEXT REFERENCES users(id),
    assigned_at       TEXT NOT NULL,
    -- queued: never called. working: called at least once, still live.
    -- done: worked to a conclusion. closed: not interested.
    queue_status      TEXT NOT NULL DEFAULT 'queued',
    priority          TEXT NOT NULL DEFAULT 'B',   -- A | B | C
    campaign_id       TEXT REFERENCES campaigns(id),
    -- Denormalised from the activities below, for the queue list only. The
    -- activities remain the source of truth for every count on the dashboard;
    -- these exist so drawing a 200-row queue is one query rather than 201.
    call_count        INTEGER NOT NULL DEFAULT 0,
    last_called_at    TEXT,
    last_outcome      TEXT,
    next_follow_up_at TEXT,
    -- How many unanswered calls have landed IN A ROW, right now.
    --
    -- A counter and not a query, for two reasons. It is read while drawing every
    -- queue row ("2 of 3 unanswered"), which a correlated subquery over the
    -- activities would make the most expensive column on the screen. And the
    -- streak has to be exact: two calls logged in the same millisecond — which
    -- happens, the stamps are ISO milliseconds — cannot be ordered by time, so a
    -- rule that counted "the last three activities" would occasionally count them
    -- in the wrong order and retire a lead that had just answered.
    --
    -- Incremented by a No Answer and reset to 0 by any other outcome, in the same
    -- UPDATE that records the call. `no_answer_streak` reaching the workspace's
    -- limit is what marks the lead dead. See logCall in lib/calling.mjs.
    no_answer_streak  INTEGER NOT NULL DEFAULT 0,
    -- When the four-step sequence finished because the lead ANSWERED, as opposed
    -- to dead_at, which is the sequence running out. Opposite results, so they
    -- are not one column. See completeSequence in lib/follow-up.mjs.
    sequence_completed_at TEXT,
    active            INTEGER NOT NULL DEFAULT 1,
    completed_at      TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_calling_active_contact
    ON calling_assignments(workspace_id, contact_id) WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_calling_sdr
    ON calling_assignments(workspace_id, assigned_to, queue_status);
CREATE INDEX IF NOT EXISTS idx_calling_follow_up
    ON calling_assignments(workspace_id, assigned_to, next_follow_up_at);

-- ------------------------------------------------------------- outreach ----
--
-- Every event an outreach provider pushes at us, append-only.
--
-- This is the webhook's own memory, and it exists for three reasons. First,
-- IDEMPOTENCY: the UNIQUE (workspace_id, provider, idempotency_key) below is
-- what makes a redelivered event a no-op at the database level, not by a check
-- that a race can slip past. Second, DEBUGGING: "why did this reply not appear?"
-- is answered by reading the row, not the server logs. Third, RECONCILIATION:
-- failed rows keep their payload so they can be replayed after the thing that
-- broke them is fixed.
--
-- `payload` keeps the provider's untranslated JSON — same rule as
-- email_verifications.raw above: the raw answer is kept beside the interpreted
-- one, and only lib/outreach.mjs reads it.
--
-- `processing_status`: received (not yet looked at), processed (applied to
-- memberships/activities), ignored (nothing to apply it to — unlinked campaign,
-- unknown contact), failed (apply threw; retryable from Integration health).
CREATE TABLE IF NOT EXISTS outreach_events (
    id                TEXT PRIMARY KEY,
    workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
    provider          TEXT NOT NULL DEFAULT 'smartlead',
    -- The provider's request id when it sends one; otherwise a deterministic
    -- fingerprint of the event itself. Either way: same key twice, one row.
    idempotency_key   TEXT NOT NULL,
    event_type        TEXT,
    external_campaign_id TEXT,
    campaign_id       TEXT,               -- CRM campaign once resolved
    member_id         TEXT,               -- CRM membership once resolved
    contact_id        TEXT,
    occurred_at       TEXT,
    payload           TEXT,
    processing_status TEXT NOT NULL DEFAULT 'received',
    error_message     TEXT,
    retry_count       INTEGER NOT NULL DEFAULT 0,
    received_at       TEXT NOT NULL,
    processed_at      TEXT,
    UNIQUE (workspace_id, provider, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_outreach_events_status
    ON outreach_events(workspace_id, processing_status, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_events_campaign
    ON outreach_events(campaign_id, received_at DESC);

-- ---------------------------------------------------------- phone reveals ----
--
-- Apollo delivers phone numbers asynchronously via webhook — the bulk_match
-- call returns immediately with email only; the phone arrives LATER at a
-- webhook URL.  This table holds those pending deliveries until they can be
-- matched to a contact (by email or Apollo person id) and consumed.
--
-- `consumed_at` is set the moment the phone is patched onto a contact; until
-- then the row is "pending" and visible in the Integration health tab.
CREATE TABLE IF NOT EXISTS phone_reveals (
    id                TEXT PRIMARY KEY,
    workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
    provider          TEXT NOT NULL DEFAULT 'apollo',
    provider_person_id TEXT,
    email             TEXT,
    phone             TEXT NOT NULL,
    raw               TEXT,
    consumed_at       TEXT,
    created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_phone_reveals_workspace
    ON phone_reveals(workspace_id, consumed_at);
CREATE INDEX IF NOT EXISTS idx_phone_reveals_email
    ON phone_reveals(workspace_id, lower(email), consumed_at);
CREATE INDEX IF NOT EXISTS idx_phone_reveals_provider_id
    ON phone_reveals(workspace_id, provider_person_id, consumed_at);

-- ------------------------------------------------- people enrich requests ----
--
-- A rep holds `people_search.use` (search + import Apollo results, both
-- free) but not `record.write.all`, so revealing a found person's email or
-- phone — billable — is refused outright at api/people-search.mjs's
-- enrich(). This is the request they raise instead: which already-imported
-- contacts, and which of email/phone, they want revealed. See
-- api/people-search.mjs's requestEnrich/reviewEnrichRequest and the
-- 'people_enrich' kind in lib/approvals.mjs.
--
-- Apollo credits are spent at REVIEW time, never at request time — `people`
-- carries everything needed to make that call later ({providerId, contactId,
-- name} per person), and `result` holds what came back once it has run.
-- Rejected or never reviewed, nothing is ever spent.
CREATE TABLE IF NOT EXISTS people_enrich_requests (
    id             TEXT PRIMARY KEY,
    workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
    subject_type   TEXT NOT NULL,               -- account | prospecting_company
    subject_id     TEXT NOT NULL,
    requested_by   TEXT NOT NULL REFERENCES users(id),
    people         TEXT NOT NULL,               -- JSON [{providerId, contactId, name}]
    reveal_email   INTEGER NOT NULL DEFAULT 1,
    reveal_phone   INTEGER NOT NULL DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'pending_approval',  -- pending_approval | approved | rejected
    result         TEXT,                        -- JSON {providerId: {email, phone}}, once reviewed
    reviewed_by    TEXT REFERENCES users(id),
    reviewed_at    TEXT,
    review_note    TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_people_enrich_requests_ws
    ON people_enrich_requests(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_people_enrich_requests_requester
    ON people_enrich_requests(workspace_id, requested_by, status);

-- ----------------------------------------------- contact reassign requests ----
--
-- An SDR holds only `calling.work` and a rep holds `calling.assign_own` —
-- enough to work a queue, or put a contact on their OWN, but neither may
-- move a contact onto somebody ELSE's (see `assignContacts` in
-- lib/calling.mjs, which forces `assignedTo = ctx.userId` for both). This is
-- the request they raise instead: which contact, and who they think should
-- be calling it. See api/calling.mjs's requestReassign/reviewReassignRequest
-- and the 'contact_reassign' kind in lib/approvals.mjs.
--
-- Nothing moves at request time — the contact stays exactly where it is
-- until a manager (`calling.manage`) approves, at which point the review
-- calls the same `assignContacts` a manual reassignment would.
CREATE TABLE IF NOT EXISTS contact_reassign_requests (
    id             TEXT PRIMARY KEY,
    workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
    contact_id     TEXT NOT NULL REFERENCES contacts(id),
    requested_by   TEXT NOT NULL REFERENCES users(id),
    requested_to   TEXT NOT NULL REFERENCES users(id),
    note           TEXT,
    status         TEXT NOT NULL DEFAULT 'pending_approval',  -- pending_approval | approved | rejected
    reviewed_by    TEXT REFERENCES users(id),
    reviewed_at    TEXT,
    review_note    TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contact_reassign_requests_ws
    ON contact_reassign_requests(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_contact_reassign_requests_requester
    ON contact_reassign_requests(workspace_id, requested_by, status);
CREATE INDEX IF NOT EXISTS idx_contact_reassign_requests_contact
    ON contact_reassign_requests(workspace_id, contact_id, status);
