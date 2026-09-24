# 4. Extending it

Recipes, shortest first. Each one names every file you touch — if your change
needs more files than the recipe lists, something has probably grown a second
source of truth.

## Add a custom field (no code at all)

Settings → Custom fields. It appears immediately in the list view, the record
form, the filter builder, the CSV export, the import mapper and the API,
because none of those contain a list of fields. This is the metadata promise and
`test.mjs` asserts it end to end.

`filterable` / `sortable` / `searchable` are an **index budget**, not
conveniences. A field that is not filterable is left out of the filter builder
*with the reason shown* — a silent omission reads as a bug, a stated constraint
reads as a design.

## Add a built-in field to an object

1 file: `lib/objects.mjs` — add an `f(...)` to that object's `fields`.
1 file: `lib/db.mjs` — add the column to `COLUMN_MIGRATIONS` so existing
databases get it.

That is the whole change. Do not touch the list page, the form, the API or the
importer.

## Add an object

1. `schema.sql` — the table (`IF NOT EXISTS`, `workspace_id`, `deleted_at`,
   `created_at` / `updated_at`).
2. `lib/objects.mjs` — the registry entry: `key`, `label`, `plural`, `table`,
   `route`, `icon`, `fields`, and optionally `verdicts` if it has a plane.
3. `lib/repo.mjs` — one line in the id-prefix map.
4. `public/js/app.js` — one entry in `OBJECT_ROUTES` and one in `NAV`.

The generic routes (`/api/:object`, list, read, create, patch, delete, restore,
related, timeline, audit, export, bulk) work immediately — they are registered
once for every object.

## Add an API endpoint

`api/<area>.mjs` for the handler, `api/index.mjs` to register it. **Registration
order matters**: anything more specific than `/api/:object/:id` must be
registered above the generic block, or `/api/deals/board` is read as "the deal
with id `board`".

A handler returns a plain object (sent as JSON 200) or throws one of
`badRequest` / `unauthorized` / `forbidden` / `notFound` / `conflict` from
`lib/http.mjs`. Extra fields on the error reach the client — that is how the
board offers a loss-reason picker when a move is refused.

Guard capabilities with `require$(ctx, 'deal.stage.change')`; the capability
list is in `lib/auth.mjs` and surfaced by `/api/meta`.

## Add a page

`public/js/pages/<name>.js` exporting an async function that mounts into
`content`, plus a `route()` in `public/js/app.js` and a `NAV` entry if it needs
one. Use `h()` from `core.js` and the shared components — do not hand-roll a
table, `dataTable` already handles selection, sorting, sticky headers and the
empty state.

## Add a dashboard widget

1. `api/dashboard.mjs` — an entry in `WIDGETS` with `label`, `description` and
   `async run(ctx, options)` returning a typed payload (`kpi_tiles`,
   `stage_bars`, …).
2. `public/js/pages/dashboard.js` — a renderer for that payload type, if it is a
   new one.
3. `DEFAULT_DASHBOARD` in `api/dashboard.mjs` if it should ship on by default.

Every widget states its date range and when it was computed. Keep that.

## Add or change a pipeline stage

Stages are rows, not code. For a live workspace, use the UI or write a small
migration script; for the shape every new install gets, edit the `PIPELINES`
list in `setup.mjs`.

Changing an existing workspace needs both: the seed for fresh installs, and a
script for the database that already exists. `apply-won-lost-stages.mjs` is the
worked example — dry-run by default, idempotent, and it refuses to delete a
stage that still holds deals rather than guessing where those deals should go.

Stage `type` drives real behaviour: `won` and `lost` set `deals.status` and
`closed_at`, `lost` requires a loss reason, and the win-rate widget counts
`won / (won + lost)`. A stage with `probability` 0 appears on the board without
inflating the weighted forecast.

## Add a system view

`lib/seed-views.mjs`. `seedViews()` is idempotent and is called by `setup.mjs`,
so a view added there reaches databases that already exist the next time setup
runs — which is why the definitions do not live inline in `setup.mjs`.

## Add an email-verification provider

`lib/verification.mjs` — one entry in `PROVIDERS` with
`verify(email, apiKey, options)` returning `{ status, confidence, raw }`, where
`status` is one of the CRM's own statuses. Transport goes in its own file, like
`lib/bounceban.mjs`.

Nothing else changes: the active provider is a workspace setting, not an import.
A provider's own vocabulary must never reach the database — that is the whole
reason this seam exists.

## Change the lead-scoring model

`lib/scoring.mjs` holds `DEFAULT_MODEL`; a workspace's own model is the
`scoring_model` setting, written by `PUT /api/scoring/model`. Weights are
relative and normalised, so an admin can set one to 40 without making the rest
sum to 60.

Publishing a model deliberately **does not** rescore anything. A rescore is an
explicit call with a visible count, because "why did every lead change
overnight?" is a question nobody should have to ask.

There is no UI for any of this yet — see [State of play](09-state-of-play.md).

## Add a workspace setting

`lib/settings.mjs` — one key in `DEFAULTS`, with a comment saying what it means
and why the default is the default. `allSettings()` returns everything in
`DEFAULTS`, so a key that is not listed there will not appear in `/api/meta`.

## What not to do

- Do not add a second list of fields. Read the registry.
- Do not add a second write path. Go through `repo.mjs`.
- Do not copy a qualification rule out of `../local-scraper/lib/`. Import it.
- Do not add an update or delete path to `audit_events`.
- Do not use physical CSS properties (`margin-left`). The UI mirrors under
  `dir="rtl"` and `test.mjs` fails the build for it.
