# 3. Data model

One SQLite file: `data/crm.db`, WAL mode, foreign keys on. `schema.sql` is the
whole database and is executed on every boot (`migrate()` in `lib/db.mjs`) —
every statement is `CREATE ... IF NOT EXISTS`, so it is idempotent.

**42 tables and one FTS5 virtual table.** Every one carries `workspace_id`, and
every query filters on it.

## The two planes

This is the single most important thing to understand about the schema.

```
PROSPECTING PLANE                        CRM PLANE
history — everything ever uploaded       the working set — deliberately promoted

prospecting_companies          ──┐       accounts
prospecting_contacts             │       contacts
prospecting_evidence_snapshots   │       evidence_snapshots
prospecting_verdicts             │       verdicts
                                 │
                    lib/promotion.mjs ───┘   the ONE door
```

A prospect is **never deleted or moved** when it is promoted. It stays, pointing
at the account it became. History that disappears when it is acted on is not
history — and a pipeline number only means something because everything in the
CRM plane arrived on purpose.

Several modules (`scoring.mjs`, `qualification.mjs`, `verification.mjs`, the
object registry) take a *plane* argument for this reason. When you add a feature
to one plane, ask whether it belongs on the other; the most common bug in this
area is reading the account plane's table for a prospect and silently finding
nothing. (That exact bug scored every prospect as "never enriched" while 1,233
snapshots sat in the table next door — the comment recording it is in
`api/scoring.mjs`.)

## Tables by area

### Workspace and identity
| Table | Notes |
|---|---|
| `workspaces` | Base currency, timezone, locale, weekend days, verdict staleness. |
| `users` | Email, name, scrypt hash. **No role column** — roles live on the membership. |
| `memberships` | user × workspace × role. |
| `sessions` | Only the SHA-256 of the token is stored; a leaked backup cannot be replayed. |
| `settings` | Workspace key/value config. Adding one is a write, not a migration. |

### Metadata (configuration, not code)
| Table | Notes |
|---|---|
| `field_defs` | Custom fields. Appear everywhere immediately — see [Extending](04-extending.md). |
| `pipelines`, `stages` | Three pipelines. Stage `type` is `open` / `won` / `lost`. |
| `activity_types` | "Kickoff" is a row, not an enum member. |
| `service_lines` | Recruitment, HCM, Offshoring, Strategy — with their pricing model. |
| `loss_reasons` | Required when a deal enters a `lost` stage. |
| `qualification_rules` | Versioned rule configuration; publishing creates version N+1. |
| `views`, `lists`, `list_members`, `dashboards` | Saved configuration, all user-editable. |

### Prospecting
| Table | Notes |
|---|---|
| `prospecting_companies` | Every company ever uploaded. `status` drives the funnel tabs. |
| `prospecting_contacts` | People attached to prospects. |
| `prospecting_evidence_snapshots` | Raw collected panels, verbatim, immutable. |
| `prospecting_verdicts` | Append-only, versioned, `is_current` flags the latest. |

### CRM records
| Table | Notes |
|---|---|
| `accounts` | Lifecycle from prospect to churned; `services` is a JSON array (a company can be both Recruitment and Offshoring). |
| `contacts` | `data_source` / `acquired_at` / `lawful_basis` are first-class. |
| `deals` | **No `amount` column** — see [Domain rules](06-domain-rules.md). |
| `deal_line_items` | Where value actually lives. Four pricing models. |
| `deal_stage_history` | `entered_at` / `exited_at` per stage. Not FK-constrained to `stages`, on purpose: history survives a stage being retired. |
| `deal_contacts` | Roles on a deal. |
| `tasks`, `activities`, `notes`, `documents` | Documents are on disk, reached by short-lived signed URLs — never blobs. |
| `proposals`, `proposal_versions` | Versioned; a version becomes immutable when issued. A row with a `document_id` is the sidebar's view of one document the account generated — one record per document, never edited by a later version. `deal_id` is nullable because a document is generated for an account. |
| `agreements`, `agreement_proposals` | Zero or more proposals per agreement: an MSA covers many SOWs, and inbound deals close with none. Same `document_id` rule as proposals; a generated agreement carries the contract term typed into the document, which is what the renewals report reads. |
| `campaigns`, `campaign_members` | Membership is history: `removed_at`, never a delete. |
| `evidence_snapshots`, `verdicts` | The account-plane mirrors of the prospecting pair. |
| `email_verifications` | Full history of how a status was reached, plus the provider's untranslated `raw` payload. |

### Machinery
| Table | Notes |
|---|---|
| `audit_events` | Every mutation. Append-only, no update or delete path anywhere. Doubles as the outbox. |
| `search_index` | FTS5 across every object, refreshed inside the same transaction as the write. |
| `import_batches`, `import_rows`, `import_templates` | One row per source row, which is what makes per-row partial success reportable and undo possible. |
| `notifications` | Read endpoints exist; **nothing writes to it yet** — see [State of play](09-state-of-play.md). |
| `jobs` | Intended for work that outlives a request. **Unused today** — same. |

## How the schema changes

Two mechanisms, and you should know which one you want.

**New tables, indexes, FTS** → add to `schema.sql` with `IF NOT EXISTS`. Every
boot applies it. Nothing else to do.

**New column on an existing table** → add it to `COLUMN_MIGRATIONS` in
`lib/db.mjs`. `applyColumnMigrations()` reads `PRAGMA table_info`, adds anything
missing, and skips tables that do not exist yet. Do **not** edit the original
`CREATE TABLE` and expect existing databases to pick it up — `IF NOT EXISTS`
means an existing table is left exactly as it is, and the change would only
reach fresh installs.

**Data that must move** → a one-off script at the repo root, dry-run by default,
`--apply` / `--confirm` to write, and a copy of the database taken first. The
existing ones are the pattern to copy: `migrate-to-prospecting.mjs`,
`backfill-upload-batches.mjs`, `apply-commercial-pipeline.mjs`,
`apply-won-lost-stages.mjs`. Record what you ran in [CHANGELOG.md](CHANGELOG.md).

A migration writes out the values it depends on rather than importing a
constant, so it keeps meaning what it meant on the day it ran. `apply-commercial-pipeline.mjs`
says this in its own header and it is a rule worth keeping.

## Conventions

- **Ids** are `prefix_<random>`: `acc_`, `con_`, `dea_`, `tsk_`, `pip_`, `stg_`,
  `viw_`, `rul_`. `id('acc')` in `lib/db.mjs`; the prefix map is in `repo.mjs`.
- **Timestamps** are ISO-8601 UTC strings, always. Rendering in the viewer's
  timezone is the front end's job.
- **Soft delete** is `deleted_at`, and every list query excludes it. The hard
  delete is `reset-records.mjs`, which is a hand-run script, not an app path.
- **JSON columns** (`properties`, `services`, `filter`, `layout`, `config`) are
  read through `json(value, fallback)` so a malformed value degrades instead of
  throwing.
- **Money** is always an amount plus a currency, plus the FX rate frozen at
  close, so last year's revenue does not move when the rate does.
