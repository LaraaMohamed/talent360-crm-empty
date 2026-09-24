# 2. Architecture

## The whole thing on one page

```
browser  ──HTTP──►  server.mjs
                      │  CSRF (Origin check on non-GET)
                      │  /qualifier/*  ─────────────►  lib/qualifier-ui.mjs ──► local-scraper (proxied)
                      │  /api/*        ─────────────►  lib/http.mjs router
                      │                                   │
                      │                                   ▼
                      │                                api/*.mjs handlers
                      │                                   │
                      │                                   ▼
                      │                                lib/repo.mjs ──► lib/objects.mjs (registry)
                      │                                   │        └──► lib/query.mjs   (filter → SQL)
                      │                                   ▼
                      │                                lib/db.mjs ──► data/crm.db (node:sqlite, WAL)
                      │
                      └─ anything else ───────────────►  public/  (index.html + ES modules, no build)
```

## The request lifecycle

`server.mjs` is 130 lines and does exactly five things, in order:

1. **CSRF.** Any non-GET/HEAD/OPTIONS request carrying an `Origin` header must
   have one matching this host. Combined with the `SameSite=Strict` session
   cookie, that closes CSRF without a token the client has to remember.
2. **Collector proxy.** `matchQualifierRoute` claims the handful of paths the
   collector's own page asks for (`/qualifier`, `/api/inspect`, `/api/qualify`,
   `/api/progress/:id`, `/api/download/:id`). Matched *before* the API router,
   behind the CRM session. See `lib/qualifier-ui.mjs` for why it is proxied and
   not reimplemented. It covers COLLECTION only: qualifying an uploaded list is
   `/api/qualification/list/*`, which runs in this process and never reaches the
   proxy — deliberately named out of its way, since the two would otherwise
   collide on `/api/qualify`.
3. **API.** `/api/*` goes to the router. The session cookie is resolved into a
   `ctx`; anything not in `PUBLIC_ROUTES` or `SIGNED_ROUTES` without one is a
   401.
4. **Handler.** Handlers receive `{ req, res, url, params, ctx, token }`. A
   returned value is sent as JSON 200. A thrown `HttpError` becomes its own
   status and message. Anything else is logged and becomes a generic 500 — the
   client never sees a stack trace.
5. **Static.** Everything else serves `public/`, and any path without an
   extension serves `index.html`, so deep links like `/accounts/acc_123` are
   routed in the browser.

### `ctx` — the only authority on who is asking

```js
ctx = { workspaceId, userId, role, ... }   // from lib/auth.mjs sessionFor(token)
```

Every query filters on `ctx.workspaceId`. Nothing reads a workspace id from the
request body. This is what makes the second workspace a signup form rather than
a schema change, even though the product is single-workspace today.

## Module map

### `lib/` — the platform

| Module | Owns | Never does |
|---|---|---|
| `db.mjs` | Connection, `migrate()`, transactions, id generation, `now()` | Business logic |
| `http.mjs` | Router, body parsing, cookies, typed errors, static files | Know about objects |
| `auth.mjs` | scrypt passwords, sessions, roles, capabilities | Store a role on a user (it lives on the membership) |
| `objects.mjs` | **The registry.** Objects, fields, types, operators, planes | Query the database for records |
| `repo.mjs` | Generic list/read/create/update/delete + audit + search | Contain per-object branches |
| `query.mjs` | Filter AST → parameterised SQL, sorting | Interpolate user input into SQL |
| `money.mjs` | Line-item maths, four pricing models, derived deal values | Produce one blended number |
| `qualification.mjs` | Bridge to the imported engine; evidence and verdict persistence | Reimplement a rule |
| `qualify-upload.mjs` | Qualifying an uploaded CSV against stored evidence, in this process | Write anything, or collect |
| `promotion.mjs` | Prospect → Account, the only door | Delete or move a prospect |
| `scoring.mjs` | Lead-score components, weights, explanations | Change a verdict |
| `verification.mjs` | Provider-neutral email statuses | Let a provider's vocabulary reach the database |
| `bounceban.mjs` | One provider's transport | Interpret a result |
| `merge.mjs` | Field-by-field merge precedence and conflicts | Resolve a genuine conflict by guessing |
| `names.mjs` | Full/first/last name reconciliation | Assume a Western name shape |
| `campaigns.mjs` | Membership and attribution rollups | Send anything |
| `import.mjs` | CSV profiling, mapping, preview, execute, undo | Write records directly |
| `csv.mjs` | Re-export of the qualifier's parser | Reimplement CSV parsing |
| `settings.mjs` | Workspace key/value config with defaults in one place | Scatter defaults |
| `seed-views.mjs` | The system views every workspace starts with | Make them undeletable |
| `qualifier-ui.mjs` | Proxy and supervision of the collector's UI | Fork the collector, or stand in the way of qualifying |

### `api/` — one module per area

All routes are registered in `api/index.mjs`, and **registration order is
load-bearing**: specific routes come before the generic `/api/:object/...` ones,
or `/api/accounts/board` is read as "the account with id `board`".

### `public/` — the front end

No framework, no build step. `js/core.js` is a ~400-line micro-library:
`h()` for elements, a hash-free history router, formatting (money, dates,
relative time), `modal()`, `toast()`, theme and direction. `js/components.js`
holds the shared UI: `dataTable`, `filterBuilder`, `recordForm`, `fieldControl`,
`verdictBadge`, `timelineList`, `emptyState`. `js/pages/*.js` is one module per
screen. `js/store.js` caches `/api/me` and `/api/meta` — capabilities, users,
field definitions — because re-fetching metadata per keystroke is how a local
app starts feeling remote.

## The layering rules

These are the rules that keep the design honest. All four are enforced by
`test.mjs`, not by convention alone.

1. **The registry is the only list of fields.** If you find yourself writing a
   second one — in the importer, in the export, in a page — you are about to
   break the metadata promise. Read from `objects.mjs` instead.
2. **Everything writes through `repo.mjs`.** The importer, the API, promotion,
   scoring, qualification. A writer with its own path is a writer that
   eventually stores something the rest of the system considers impossible.
3. **`audit_events` is append-only.** There is no update or delete path
   anywhere in the codebase, and a test greps for one.
4. **`lib/` never imports from `api/`.** The platform does not know about
   endpoints. (`setup.mjs` importing `DEFAULT_DASHBOARD` from `api/dashboard.mjs`
   is the one exception, and it is a seed script, not the platform.)

## Why there is no framework

The whole product is one local page and a JSON API. A dependency tree buys
nothing here and costs upgrades, audit surface and a build step forever. The
qualifier in `../local-scraper/` already proved the approach in this project.
This is a deliberate choice, recorded so the next person does not have to
re-litigate it — but it is also not sacred: if this ever needs multi-tenancy,
Postgres and a real deployment story, revisit it (see
[State of play](09-state-of-play.md)).
