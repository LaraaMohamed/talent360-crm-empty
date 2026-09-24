# CRM

A CRM built around the LinkedIn qualification engine rather than beside it.

Zero runtime dependencies. Node's own HTTP server, `node:sqlite`, and a browser
front end served as plain ES modules — no build step, no bundler, no database to
install. `data/crm.db` is one file you can copy as a backup.

```bash
cd "C:\Users\lenovo\Desktop\files\crm"

node setup.mjs                 # first run only — creates the database and an admin
node import-snapshots.mjs      # OPTIONAL — brings in the collected companies
npm start                      # http://127.0.0.1:5180, using data/crm.db
node test.mjs                  # 174 checks, offline, ~3 seconds

node reset-records.mjs         # dry run: what emptying the CRM would remove
```

### Running against the shared database

The deployed CRM keeps its data in Turso, not in a file, because the host it
runs on has no disk that survives a restart. Point this checkout at the same
database and you are working on the live data:

```bash
npm run collect                # http://127.0.0.1:5180, using the hosted database
node pull-from-turso.mjs       # a verified backup of it, as a .db file
```

This is how COLLECTING is done, and why it has a name of its own. Fetching a
company nobody has fetched yet opens a real browser against a signed-in
LinkedIn profile — that only works on a machine that has one, so it is not
something the deployed CRM can do, and should not be: the profile is a live
login. Run it here, and everything it collects lands in the same database the
team is reading.

QUALIFYING a list is a different operation and does **not** need any of this.
Upload a CSV on the Qualification page of the deployed CRM and the rules run
there, against the evidence the database already holds — no browser, nothing to
start. That split is invariant I1: collection is expensive and rate-limited,
evaluation is free and offline.

Both commands need `data/turso.env` (gitignored) holding `TURSO_URL` and
`TURSO_TOKEN`. Without it they stop rather than quietly falling back to the
local file, because collecting into the wrong database is not a mistake you
notice on the day you make it.

**Developer documentation is in [`docs/`](docs/README.md)** — architecture, data
model, API reference, domain rules, operations, and a
[state of play](docs/09-state-of-play.md) saying what is finished, what is half
finished and what was never started. Start there if you are taking this over.

**The lead data is not part of the CRM.** The server never opens
`snapshots.json` or any CSV. Importing is a separate script you run by hand, and
`reset-records.mjs --confirm` undoes it — it clears records while keeping the
workspace, users, pipelines, views, rules and custom fields, and copies the
database file first. Add `--keep-files` to leave uploaded documents on disk.

The one thing the CRM genuinely depends on at runtime is `local-scraper/lib/`,
for the qualification rules. That dependency is the point (§2).

---

## 1. What is here

| | |
|---|---|
| **Accounts** | Organisations at every lifecycle stage from prospect to churned. Merge, unmerge, duplicate detection. |
| **Contacts** | People, with `data_source` / `acquired_at` / `lawful_basis` as first-class fields. |
| **Deals** | Line items, four pricing models, three pipelines ending in Deal Won / Deal Lost, stage rules, loss reasons. **No amount column.** |
| **Tasks** | Polymorphic, assignable, due in UTC and rendered in the viewer's timezone. |
| **Activities** | Typed by workspace metadata. `occurred_at` separate from `created_at`. |
| **Notes** | Free text with author and timestamps kept. |
| **Documents** | On disk, reached through short-lived signed URLs. Never database blobs. |
| **Proposals** | Versioned, immutable once issued, rendered through a template. Agreements with renewal chains. |
| **Qualification** | The existing engine, imported not copied. Evidence, verdicts, rule versions, impact preview, review queue. |
| **Dashboard** | Nine widgets. Every one states its date range and when it was computed. |
| **Search** | FTS5 across every object. `Ctrl/Cmd K`. |
| **Filters / Views / Lists** | Nested AND/OR over system and custom fields. Views are URL-addressable. |
| **Authentication** | scrypt, HttpOnly `SameSite=Strict` sessions, five roles, capability checks. |
| **Responsive UI** | Light and dark, LTR and RTL, phone to desktop. |

---

## 2. How the qualification module is integrated

**The rules are imported, never copied.** `lib/qualification.mjs` loads
`hcm.js`, `offshoring.js`, `signals.js` and `normalize.js` straight out of
`../local-scraper/lib/` and executes them unmodified.

That matters because those files encode bugs found against real LinkedIn data
over many iterations — the `toggle off` suffix strip, the top-5 truncation
bounds, "Cairo, Egypt" not being a country row, case-sensitive university
abbreviations, `hrCount` being the MAX across signals rather than the sum. Every
one of those was a wrong answer shipped before it was a line of code. A second
copy would be a second set of those bugs, drifting apart from the first.

So the CRM owns only two things: a 15-line snapshot adapter (a field mapping,
not logic), and persistence.

**The engine is proven identical.** Importing all 223 collected companies
reproduces the command line exactly:

```
                CRM              qualify.mjs
HCM         27 / 58 / 136 / 2    27 / 58 / 136 / 2     QUALIFIED/REVIEW/REJECTED/ERROR
Offshoring  67 / 60 /  94 / 2    67 / 60 /  94 / 2
```

`test.mjs` also runs one payload down both paths and asserts the verdict **and
the reasoning, line for line** are the same.

`snapshots.json` is only ever read. It is never written, moved or modified.
Importing does give it a second home, though: every snapshot is copied verbatim
into `evidence_snapshots`, so `crm.db` is now also a backup of the most
expensive asset in the project.

### The three invariants, and where they live in the code

**I1 — Evidence and conclusion are separate.** `evidence_snapshots` holds what
was observed; `verdicts` holds what was concluded. Collection is expensive and
rate-limited; evaluation is free and offline. Re-qualifying all 223 companies
under a changed rule takes about a second and costs nothing — which is what makes
the impact preview possible at all.

**I2 — Verdicts are immutable and versioned.** Re-running appends a row and marks
the previous one superseded. Rules are versioned too: publishing a threshold
change creates version N+1 and leaves old verdicts pointing at the version that
produced them. Changing the HCM band from `>= 20` to `20–50` once moved 117 of
223 verdicts, three of them out of QUALIFIED, and nothing recorded it. Now the
account page answers "why did this change?" with either *the rule changed* or
*the evidence changed*.

**I3 — Absence of evidence is never a negative answer.** REVIEW is not a soft
REJECTED, and the codebase defends that in several places at once:

- the filter compiler treats `UNRESOLVED` as *no verdict row exists*, not a value
- `is_none_of ['QUALIFIED']` uses `NOT EXISTS`, so never-evaluated accounts stay in
- every verdict chart renders all buckets, including zeros
- REVIEW is amber, never grey — grey reads as "ignore me"
- the evidence card distinguishes *not collected* from *collected and empty*
- **disqualifying an account takes unanimity.** One rule saying REJECTED while
  another is still REVIEW is one answer and one non-answer. Treating that pair as
  "no" is the same collapse one level up, so the account stays a prospect and
  sits in the review queue.

That last rule is why the import leaves 118 accounts as prospects rather than
disqualifying them: they are mostly HCM-rejected (too big) with offshoring still
unresolved. They are unfinished work, not rejects.

---

## 3. The decisions worth knowing about

### A deal has no amount

The `deals` table has no `amount` or `value` column, and `test.mjs` asserts it
never grows one. Value comes from **line items**, because this business sells
four structurally different things:

| Service | Pricing | Recurrence |
|---|---|---|
| Recruitment | % of first-year salary × placements | one-time |
| HCM | per seat × months | recurring |
| Offshoring | per headcount × months | recurring |
| Strategy | fixed fee | one-time |

*"3 placements at 15% plus 40 seats at 120 SAR/month for 24 months"* cannot be
written as one number. Five figures are derived and **one-time and recurring are
never summed**:

```
one-time  90,000        Σ non-recurring lines
MRR        4,800        Σ recurring monthly
ARR       57,600        MRR × 12
TCV      205,200        the ONLY combined figure — and it names its assumption
weighted  45,000        one-time × probability (recurring weighted separately)
```

A recurring line with no stated term is treated as 12 months **and flagged as
assumed**, in the rollup and on the proposal.

### Activities and audit events are two stores

| | Activity | Audit event |
|---|---|---|
| Audience | Salespeople | Compliance, support |
| Volume | Low, curated | Every mutation |
| Editable | Yes | **Never** |

Merged, you get a timeline nobody reads (drowned in `custom_field_47: null → ""`)
and an audit log that fails its first review. Selected audit actions *project*
into the timeline, and which ones is configurable in Settings. There is no code
path anywhere that updates or deletes an audit event — `test.mjs` greps for one.

### Custom fields are real

A field created in Settings appears immediately in the list, the record form, the
filter builder, the export and the API. Nothing else changes, because nothing
else contains a list of fields — `lib/objects.mjs` is the single source of truth
and every surface reads it.

`filterable` / `sortable` / `searchable` are the **index budget**, not
conveniences. A field that is not filterable is left out of the filter builder
**with the reason stated** — a silent omission reads as a bug; a stated
constraint reads as a design.

### Money, time and language

- Money is always an amount **plus a currency**. FX rates are frozen on the deal
  at close, so last year's closed revenue does not move when the rate does.
- Due dates are stored UTC and rendered in the viewer's timezone. The workspace
  weekend defaults to **Friday–Saturday**.
- Every text input carries `dir="auto"`, so an Arabic legal name inside an
  English form renders right-to-left on its own. The whole interface mirrors
  under `dir="rtl"` — `test.mjs` fails the build if a physical `margin-left`
  appears in the CSS.
- Agreements sort by **notice date**, not expiry. A 90-day notice on a 12-month
  contract means the decision is due in month nine.

---

## 4. Layout

```
crm/
  server.mjs              HTTP server, routing, CSRF, static files
  setup.mjs               first-run: workspace, admin, pipelines, views, rules
  import-snapshots.mjs    snapshots.json -> prospects + evidence + verdicts
  test.mjs                103 checks
  schema.sql              the whole database
  apply-*.mjs             one-off migrations, dry-run by default
  migrate-*.mjs           "
  backfill-*.mjs          "
  reset-records.mjs       empty the records, keep the configuration

  lib/
    db.mjs                node:sqlite, transactions, ids, column migrations
    auth.mjs              scrypt, sessions, roles, capabilities
    http.mjs              router, body parsing, cookies, typed errors
    objects.mjs           THE OBJECT REGISTRY — every surface reads this
    query.mjs             filter AST -> parameterised SQL
    repo.mjs              generic CRUD + audit + search indexing
    money.mjs             derived deal values
    qualification.mjs     the bridge to ../local-scraper/lib
    qualify-upload.mjs    upload a list, qualify it here — no browser
    qualifier-ui.mjs      the collector's own page, proxied
    promotion.mjs         prospecting -> CRM, the one door
    scoring.mjs           lead scoring model and explanations
    verification.mjs      provider-neutral email statuses
    bounceban.mjs         one verification provider's transport
    merge.mjs             duplicate resolution precedence
    names.mjs             full / first / last name reconciliation
    campaigns.mjs         membership and attribution
    import.mjs            CSV profiling, preview, execute, undo
    settings.mjs          workspace key/value config
    seed-views.mjs        the system views a workspace starts with
    csv.mjs               re-exports the qualifier's CSV parser

  api/                    one module per area, all routes in index.mjs
  public/                 css/tokens.css, css/app.css, js/ (no build step)
  docs/                   developer documentation — start at docs/README.md
  data/                   crm.db + storage/   (created on first run)
```

---

## 5. Deviations from the specifications

(The specification documents are the `NN_UPPERCASE.md` files in `docs/`, plus
`../HANDOFF.md` one level up. The `NN-lowercase.md` files in `docs/` document
what was actually built — start at [docs/README.md](docs/README.md).)

Both deliberate, both cheap to reverse:

1. **Custom fields use a JSON `properties` column, not ADR-03's typed slot
   columns.** Slots exist to make per-tenant indexes possible in Postgres. This
   is single-file SQLite, where `json_extract` with an expression index is the
   same trade at a fraction of the complexity. Adding slots later is additive.

2. **Domain events are written in the same transaction as the mutation**
   (`audit_events` doubles as the outbox) rather than to a separate outbox table
   as in ADR-11. Same crash-safety guarantee, one table instead of two. Splitting
   it out is a migration, not a rewrite.

The blocking questions in `../HANDOFF.md` (Q-01 multi-tenancy, Q-04 scale, Q-11
custom-field count) are **not** answered by this build. It is single-workspace by
data, but every table carries `workspace_id` and every query filters on it, so
the second workspace is a signup form rather than a schema change.

---

## 6. Rules for changing this

1. **Never break the qualifier.** These pass before and after any change:
   ```bash
   cd ../local-scraper && node test-signals.mjs && node test-panels.mjs
   node qualify.mjs --input "Marketing Enriched.csv"      # 27 HCM / 67 offshoring
   cd ../crm && node test.mjs                             # 103 checks
   ```
2. **Move the rule files, never rewrite them.** If `local-scraper/` moves, set
   `QUALIFIER_LIB` and `QUALIFIER_SNAPSHOTS` rather than copying anything.
3. **Never collapse REVIEW into REJECTED** — not in a filter, a count, an export,
   a chart or a lifecycle transition.
4. **Never sum one-time and recurring revenue.**
5. **Never add an update or delete path to `audit_events`.**
6. **Logical CSS properties only.** `margin-inline-start`, never `margin-left`.

---

## 7. Passwords

`setup.mjs` prints a generated admin password once and stores only its scrypt
hash. Nobody, including you, can read it back. To set a new one:

```bash
node setup.mjs --email you@example.com --password "something long" --name "Your Name"
```

Everyone else is added from **Settings → People**.
