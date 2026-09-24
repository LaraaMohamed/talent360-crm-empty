# 5. API reference

All routes are registered in `api/index.mjs`. This document is that file with
explanations; when they disagree, the file is right.

## Conventions

**Auth.** A session cookie (`crm_session`, HttpOnly, `SameSite=Strict`, 14 days),
or an `X-Api-Key` header for a caller with no browser — Make, Zapier, a script.
A key acts as whoever created it (`POST /api/api-keys`, `lib/auth.mjs`
`contextForApiKey`): same role, same records, same limits, no separate
permission system to keep in sync with the first. Only
`POST /api/auth/login` and `POST /api/auth/logout` are public. The document
download route authenticates with a signed URL instead of either — the
signature *is* the authorisation, verified inside the handler.

**CSRF.** Any non-GET request with an `Origin` header must match this host.
Browsers send it automatically; nothing needs to attach a token.

**Responses.** `200` with the handler's return value as JSON. Errors are
`{ "error": "<human sentence>" }` plus any extra fields the handler attached —
for example a refused stage move returns `lossReasons` so the client can ask.
Status codes: 400 bad request, 401 no session, 403 no permission or bad origin,
404 unknown record or endpoint, 409 conflict, 500 anything unhandled (logged
server-side, never leaked to the client).

**`:object`** in a path is a *route name*, not an object key: `accounts`,
`contacts`, `deals`, `tasks`, `activities`, `notes`, `documents`, `proposals`,
`agreements`, `campaigns`, `prospects`, `prospecting_contacts`.

## Session and metadata

| | |
|---|---|
| `POST /api/auth/login` | `{ email, password }` → sets the cookie. Public. |
| `POST /api/auth/logout` | Clears the session. Public. |
| `GET /api/me` | The signed-in user, their role and capabilities. |
| `GET /api/meta` | Workspace, users, pipelines, stages, activity types, service lines, loss reasons, field definitions, email-verification statuses (label, classification and what each means for sending), settings. The front end caches this. |
| `PATCH /api/settings` | Workspace settings (see `lib/settings.mjs` `DEFAULTS`). |
| `POST /api/users` | Invite a member. |
| `POST /api/fields` · `DELETE /api/fields/:id` | Custom field definitions. |
| `GET/POST /api/activity-types` | Activity type metadata. |
| `GET /api/notifications` · `POST /api/notifications/read` | Reads work; nothing writes notifications yet. |
| `GET/POST /api/api-keys` · `DELETE /api/api-keys/:id` | Personal integration tokens for external tools — see the Auth section above. List returns your own keys, or every key in the workspace for an admin; delete revokes (own key, or any for an admin). |

## Generic record routes

Registered **last**, once, for every object.

| | |
|---|---|
| `GET /api/:object` | List. Query: `page`, `limit` (max 200), `q`, `view`, `filter` (JSON), `sort` (JSON), `columns`, `list`, `parent_type` + `parent_id`, `account_id`, `deal_id`, `deleted=1` (include) or `deleted=only` (trash). |
| `POST /api/:object` | Create. |
| `GET /api/:object/:id` | Read one. |
| `PATCH /api/:object/:id` | Update. |
| `DELETE /api/:object/:id` | Soft delete. |
| `POST /api/:object/:id/restore` | Undo a soft delete. |
| `GET /api/:object/:id/related` | Child records grouped by object. |
| `GET /api/:object/:id/timeline` | Activities, notes, tasks and projected audit events, merged. |
| `GET /api/:object/:id/audit` | The immutable audit trail for that record. |
| `GET /api/:object/:id/campaigns` | Campaign memberships. |
| `GET /api/:object/export.csv` | The current filter, as CSV. |
| `GET /api/:object/view-counts` | One indexed COUNT per saved view, so the tabs show records, not conditions. |
| `GET /api/:object/field-values` | Distinct values, for filter autocomplete. |
| `POST /api/:object/bulk` | Bulk update / delete over an id set or a filter. |

## Views, lists, filter schema

`GET/POST /api/views`, `PATCH/DELETE /api/views/:id`,
`GET/POST /api/lists`, `PATCH/DELETE /api/lists/:id`,
`POST/DELETE /api/lists/:id/members`, and `GET /api/schema` — the fields and
operators the filter builder is allowed to offer, per object.

## Dashboards

`GET /api/dashboards`, `GET /api/dashboards/:id/data`,
`PATCH /api/dashboards/:id`. Widget payloads are typed (`kpi_tiles`,
`stage_bars`, …) and each carries its own date range and computation time.

## Prospecting and qualification

| | |
|---|---|
| `GET /api/qualification/rules` | Rules and their current versions. |
| `GET /api/qualification/review-queue` | Everything sitting in REVIEW. |
| `POST /api/qualification/rules/:key/preview` | What a config change *would* do, before publishing. |
| `POST /api/qualification/rules/:key/publish` | Creates version N+1. Old verdicts keep pointing at the version that produced them. |
| `POST /api/qualification/run` | Re-qualify in bulk. |
| `POST /api/qualification/list/inspect` | Pre-flight for an uploaded list: columns, companies, and how many of them have stored evidence. Body is the raw CSV; `?column=N` counts against that column instead of the detected one. |
| `POST /api/qualification/list/qualify` | Runs the rules over the list and returns the filtered CSV, a per-company report and the tally. Reads only — no verdicts are recorded. |
| `GET/POST /api/qualification/uploader[...]` | Status, start and stop for the proxied collector. Collection only; qualifying a list does not go through it. |
| `POST /api/prospects/import-preview` · `POST /api/prospects/import` | Promotion preview and execution (`lib/promotion.mjs`). |
| `POST /api/prospects/:id/qualify` · `/evidence` · `GET .../verdicts` · `/evidence` | Per-prospect qualification and evidence. |

The account plane has the same set under `/api/accounts/:id/…`, plus
`/api/accounts/:id/decision` for a recorded human verdict and
`/api/accounts/:id/duplicates`.

## Accounts — merge

`POST /api/accounts/merge-preview` → field-by-field survivor, with conflicts
listed rather than resolved. `POST /api/accounts/merge`, `POST /api/accounts/unmerge`.
Precedence is in `lib/merge.mjs`; the guarantee is that a populated value is
never replaced by an empty one.

## Deals

| | |
|---|---|
| `GET /api/deals/board` | Columns from stages, two totals per column (one-time and MRR), never one. |
| `GET /api/deals/forecast?days=90` | Open, weighted and won figures, plus the assumption note. |
| `GET/POST /api/deals/:id/line-items`, `PATCH`/`DELETE .../:itemId` | Where deal value lives. |
| `POST /api/deals/:id/stage` | `{ stageId, lossReason? }`. Refuses with `lossReasons` when the target stage is a lost stage and no reason was given, and with the missing field names when the stage has required fields. |

## Proposals and agreements

`POST /api/proposals`, `GET /api/proposals/:id/detail`,
`POST /api/proposals/:id/versions`,
`POST /api/proposals/:id/versions/:version/issue` (immutable from then on),
`POST .../sent`, `GET .../render`, `GET /api/proposals/:id/diff`,
`GET /api/agreements/renewals` (sorted by **notice** date, not expiry),
`POST /api/agreements/:id/sign` — signing is what moves the deal into its won
stage and the account to `customer`.

## Import

`POST /api/import/profile` (detect columns from values, not headers) →
`POST /api/import/preview` (the identical classification the execution runs) →
`POST /api/import/execute`. Then `GET /api/import/batches[/:id]`,
`GET /api/import/batches/:id/errors.csv`, `POST /api/import/batches/:id/undo`
(removes what the batch created, leaves what it merely updated),
`GET /api/import/uploads`, `DELETE`/`POST .../restore`, and
`GET/POST/DELETE /api/import/templates`.

## Campaigns

`GET/POST/DELETE/PATCH /api/campaigns/:id/members` and
`GET /api/campaigns/:id/performance`. Enrolment is gated by the workspace's
`campaign_email_policy` against the contact's verification status.

## Email verification

`POST /api/:object/verify-emails` (bulk), `POST /api/:object/:id/verify-email`,
`GET /api/:object/:id/verification-history`. Works on both contact planes.

## Lead scoring

`GET/PUT /api/scoring/model`, `POST /api/:object/score` (bulk),
`POST /api/:object/:id/score`, `GET /api/:object/:id/score` (the explanation —
every component with its reason). No UI calls any of these yet.

## Documents

`POST /api/documents/upload` (multipart, stored on disk under `data/storage/`),
`GET /api/documents/:id/link` (a short-lived signed URL),
`GET /api/documents/:id/download` (authorised by that signature).

## Document generation

The account is the subject. A deal is optional context — pass `dealId` in the
body (or `?deal=` on the options call) and the generation is recorded against
both; everything else is identical, which is what stops the two entry points
from drifting.

| | |
|---|---|
| `GET /api/accounts/:id/document-options` | Everything the dialog needs in one call: the service gate, the document types this account's services allow (each with its own blockers), the 7 HCM scopes, the current selection, the contacts, and a prefill per type. |
| `POST /api/accounts/:id/documents/preview` | The review step. Takes the proposed `documentType`, `fields` and `services`; returns the variable map — every placeholder with its source, its resolved value and whether it is missing — plus the problems and any leftover `{{TOKEN}}`. **Writes nothing.** |
| `POST /api/accounts/:id/documents` | Generates, versions, stores and associates. Refuses with the whole list of problems rather than the first. |
| `GET /api/accounts/:id/documents` | The version history. `?category=proposal\|agreement` is what the account's two tabs ask for. |
| `GET /api/accounts/:id/documents/archive` | Every file on the account as one ZIP, same `?category=` filter. Each generated file in it is counted as a download individually. `X-Missing-Files` reports anything absent from storage rather than leaving a silent gap. |
| `GET/PUT /api/accounts/:id/services` | The HCM scope selection. `dealId` in the PUT body scopes it to one deal instead of the account. |
| `GET/PUT /api/accounts/:id/commercial-registration` | The first-party block every Arabic agreement reads. |
| `GET /api/deals/:id/document-options`, `POST /api/deals/:id/documents`, `GET /api/deals/:id/documents`, `GET/PUT /api/deals/:id/services` | The same, entered from a deal. |
| `GET/POST /api/document-templates` | The four `.docx` templates. `POST ?key=hcm_proposal&name=…` with the raw file as the body; uploading retires the previous version rather than replacing it. |

Nothing is generated until a template is installed. `node install-templates.mjs
--apply` registers the four in `Automation/HCM/`; after that they are managed in
Settings → Documents.

## Search

`GET /api/search?q=` across every object via FTS5, ranked by object type.
`POST /api/search/reindex` rebuilds the index.
