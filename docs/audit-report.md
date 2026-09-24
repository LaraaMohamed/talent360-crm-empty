# Talent 360 CRM — Final Audit Report

Status: READ-ONLY audit of commit `606933c` (tree clean). No files modified by the audit.

## Overall Assessment: 62 / 100

**What earns the score.** This is an unusually well-engineered small codebase: a metadata-driven engine (`lib/objects.mjs` + `lib/repo.mjs`) where objects, operators, verdicts, and stages are data, not branches; a qualification engine that genuinely separates evidence from conclusion (append-only verdicts, re-run never mutates); ~174 passing offline tests; zero runtime dependencies; and honest documentation that names its own limits. The "show your work" philosophy is not marketing — it is implemented.

**What costs the points.** The security posture is not production-safe (a live read-write cloud DB token is committed to git). There are **three competing deployment stories** (Render free tier is live; a GCP Doha VM is fully specced and never applied; legacy Firebase config remains permissive and unused). The commercial half of the product — deals, proposals, agreements, revenue — is built and unit-tested but has **zero production data** (0 deals, 0 docs). The remote-database driver blocks the Node event loop, making the server effectively single-request-at-a-time. And a known qualification regression (the HCM band incident) silently moved 117 verdicts including 3 QUALIFIED→REJECTED with **no audit record** — a direct violation of the project's own immutability principle.

Score rationale: +40 architecture & code quality, +15 documentation & testing honesty, +15 metadata/qualification design = 70 ceiling; −8 security (tracked token, permissive Firestore rules, unauthenticated scraper UI), −6 operational divergence (three deploy stories, single-threaded remote driver), −4 commercial half unvalidated with real data, +5 remaining = **62**.

## Top 10 Issues (by urgency)

1. **P0** — Live Turso read-write token committed in tracked `.env`
2. **P0** — Remote (Turso) driver blocks the event loop → single-request server
3. **P1** — Three divergent deployment stories; the live one (Render free) contradicts the documented one (GCP Doha)
4. **P1** — HCM band regression silently moved 117 verdicts; 3 QUALIFIED→REJECTED with no audit trail
5. **P1** — `firestore.rules` allows any authenticated user full read/write (legacy, but present and committed)
6. **P1** — Commercial half (deals/pipeline/revenue/documents) never exercised with real data — 0 deals in production
7. **P1** — `lib/automation.mjs` is referenced as a platform pillar in the vision but does not exist
8. **P2** — Local scraper UI (`server.mjs`) binds loopback with zero auth, one job at a time, no rate limiting
9. **P2** — Campaigns/upload lists capped at 200 via `?limit=200` in `store.js` refresh with silent truncation
10. **P2** — Duplicated/legacy artifacts inflate the repo: nested `apps-script-dms/apps-script-dms/`, 3 overlapping Apps Script generators, legacy Firebase/`.firebase/`

## DISASTER list

### [DISASTER — P0] Live database token committed to git
- **Location:** `.env` (tracked; tree clean at `606933c`) → `lib/turso.mjs` reads `TURSO_TOKEN`
- **What I found:** `.env` contains a Turso **read-write** token (`"a":"rw"`, exp ≈ 2027) for `libsql://crm-laraamohamed.aws-us-east-2.turso.io`. `.gitignore` ignores `data/` but **not** `.env`. The token has full write access to the production cloud database.
- **Why it matters:** Anyone with repo access (or a leaked clone) can read, modify, or destroy the entire production dataset — accounts, contacts, deals, verdicts.
- **Business impact:** Total data-loss/breach exposure with no recovery story. GDPR/PDPL exposure for contact data.
- **Technical impact:** Every future fork/clone inherits live prod credentials; cannot be "un-committed" without rotation.
- **Recommended direction:** Immediately rotate the Turso token, purge `.env` from history (`git filter-repo`/BFG), add `.env` to `.gitignore`, and move secrets to the host env (Render dashboard / systemd unit as `deploy/crm.service` already does for TURSO on GCP).
- **Priority:** **P0**

### [DISASTER — P0] Turso driver blocks the event loop
- **Location:** `lib/turso.mjs` / `lib/turso-worker.mjs` (worker thread + `Atomics.wait`); used behind the same sync API in `lib/db.mjs`
- **What I found:** Remote DB access runs queries in a worker thread but **synchronously waits** via `Atomics.wait`, parking the main thread. The HTTP server is therefore effectively one request at a time whenever the DB is remote — the configured live backend.
- **Why it matters:** The documented "one process against one file" limit is acceptable at 5–30 users; a process that *parks the event loop* degrades to near-zero concurrency and stalls all other requests (including `/api/progress` SSE, health checks) during a long query.
- **Business impact:** Render free tier + single-threaded DB = likely timeouts under real SDR use; dashboard/import/verification already run inside requests.
- **Technical impact:** Blocks the stated path to Cloud Run/Cloud SQL (which needs async); no benefit over running queries in the main thread.
- **Recommended direction:** Either run remote queries as true async (restructure `db.mjs` sync API), or — for the current single-operator reality — prefer the local `data/crm.db` file and treat Turso as offline sync rather than the live serving backend.
- **Priority:** **P0**

## PROBLEM list

### [PROBLEM — P1] Three divergent deployment stories; live ≠ documented
- **Location:** `render.yaml` (live) vs `deploy/` (GCP Doha VM, fully specced, not applied) vs `firebase.json`/`firestore.rules`/`.firebase/` (legacy, unused)
- **What I found:** Render free region ohio runs the app today with `CRM_TRUST_PROXY=1`, `CRM_SECURE_COOKIES=1`, Node 24. The `deploy/` folder documents a Doha VM (me-central1, ~$21/mo) as *the* deployment and explains at length why Firebase cannot host this app. Legacy Firebase config remains with a rewrite to a nonexistent `api` function and Firestore rules granting **any authenticated user full read/write**.
- **Why it matters:** Nobody can tell which environment is authoritative; three configs drift independently. The Firestore rules are a liability sitting in the repo even if unused.
- **Business impact:** Ops confusion, untestable "does it work in prod" questions, and a potential future misconfiguration if someone wires Firebase back in.
- **Technical impact:** Render free tier has no persistent disk story for `data/storage` (docx output) and the Turso backend is the only durable store — reinforcing the event-loop finding.
- **Recommended direction:** Delete or clearly mark legacy Firebase artifacts; pick one target (GCP Doha if real multi-user use arrives) and delete/archive the other; document the live truth in `docs/09-state-of-play.md`.
- **Priority:** **P1**

### [PROBLEM — P1] Qualification regression with no audit trail
- **Location:** `migrate-to-prospecting.mjs` + `lib/qualification.mjs` (I2 immutability contract)
- **What I found:** The HCM band migration moved 117/223 verdicts, including 3 that flipped QUALIFIED→REJECTED, with nothing written to the audit log. The project's own I2 principle ("verdicts immutable/versioned, re-run APPENDS") was violated by a one-shot migration.
- **Why it matters:** The product's core differentiator is "show your work" and "refuses to state a conclusion it cannot support." A silent flip with no record is precisely the black-box behavior the vision says it avoids.
- **Business impact:** A rep's hard-earned QUALIFIED account became REJECTED with no way to explain or challenge it.
- **Technical impact:** No way to reconstruct the 117 decisions; no version bump; future diffs of verdict state are impossible.
- **Recommended direction:** For one-off migrations, write the same append-only audit records the engine would, or gate the migration behind `--confirm` plus a recorded "bulk verdict event". Treat this as a documented exception with a post-mortem.
- **Priority:** **P1**

### [PROBLEM — P1] Commercial half of the product is unvalidated
- **Location:** `docs/09-state-of-play.md` (378 accounts, 2,170 contacts, **0 deals**); deal/dashboard/board/proposal/agreement/campaign code paths
- **What I found:** Deals, pipeline stages, proposals, agreements, document generation, revenue computations, and the board are fully built and unit-tested but have never seen a real row. One-time vs recurring revenue is never summed; deal money fields are computed and non-filterable.
- **Why it matters:** Vision v1 success criteria (90 days real use, <10% disputed verdicts) are unmeasurable. Forecast logic, doc templates, and the multi-service-line promise are all unproven against real consultant workflows.
- **Business impact:** The thing that pays the bills (selling HCM/offshoring services) has never been exercised.
- **Technical impact:** High risk the "obvious" integration points (qualify → promote → deal → proposal → agreement) don't match reality.
- **Recommended direction:** The single highest-value action in the whole audit: **enter one real deal end-to-end** through the UI before any further feature work. Then compare doc output against the Automation Google-Sheets DMS output for parity.
- **Priority:** **P1**

### [PROBLEM — P1] Vision promises automations; none exist
- **Location:** `lib/automation.mjs` (referenced, absent); `docs/01_PRODUCT_VISION.md` Platform group lists "Automations"
- **What I found:** The Platform module list and the vision's "everything configurable" promise include Automations as a first-class substrate, but there is no automation engine in `lib/`. Document generation lives in the API layer, not in an engine.
- **Why it matters:** Scope ambiguity: either the vision is aspirational (fine — then say so) or the roadmap is missing a pillar.
- **Business impact:** Users are told "configuration is the product" but can't yet configure a single automated action.
- **Technical impact:** None today; but anything built now will shape the eventual engine.
- **Recommended direction:** Name it explicitly as a v2/non-goal in the roadmap, or build the minimal trigger→action skeleton before users need it.
- **Priority:** **P1**

### [PROBLEM — P2] Local scraper UI: unauthenticated, single-job, unthrottled
- **Location:** `local-scraper/server.mjs` (binds `127.0.0.1:5173`, no auth, `jobs` map, one `activeJob`)
- **What I found:** The upload-and-qualify page has no authentication, no per-IP rate limiting, a hard 32 MB body cap (fine) but no concurrency limits beyond "one job", and the output CSV is served from an in-memory job map (lost on restart). It deliberately re-spawns `scrape.mjs` (Playwright) as a child.
- **Why it matters:** Loopback-only reduces but does not remove risk on a shared workstation; more importantly the design is explicitly single-operator.
- **Business impact:** Only one person can collect at a time; a browser profile is shared.
- **Technical impact:** Playwright child process spawn per job; no resume of the in-memory job state after a crash (snapshots survive, jobs don't).
- **Recommended direction:** Accept the single-user reality and document it; add token auth if it is ever exposed beyond localhost. Do not over-engineer.
- **Priority:** **P2**

### [PROBLEM — P2] Silent 200-row caps on campaign and list data
- **Location:** `public/js/store.js` (`refreshCampaigns()` = `GET /api/campaigns?limit=200` then mutates `state.meta.campaigns`), `lib/repo.mjs` `MAX_LIMIT=200`, uploads funnel
- **What I found:** Several surfaces fetch with `limit=200` and mutate shared state without surfacing truncation. The search page is honest about it ("Showing the best 200 of 1,400"); campaigns and upload history are not.
- **Why it matters:** A >200-member campaign silently shows a partial list — exactly the kind of quiet data loss the product ethos condemns.
- **Business impact:** A rep reads a truncated member list as complete.
- **Technical impact:** Simple; the plumbing for honest counts already exists in `search.js`.
- **Recommended direction:** Add count/total alongside capped fetches and a "showing X of Y" banner, matching search's pattern.
- **Priority:** **P2**

### [PROBLEM — P2] Frontend view counts deliberately not awaited
- **Location:** `public/js/list.js` (`viewCounts` fetched without await)
- **What I found:** The trash/deleted-count numbers update asynchronously and can render stale or never; a deliberate tradeoff with no indicator.
- **Why it matters:** Trash tab counts that lie undermine the audit-friendly design.
- **Business impact:** Minor; cosmetic correctness.
- **Technical impact:** Low.
- **Recommended direction:** Add a subtle "…" placeholder or refetch-on-interaction; document the tradeoff.
- **Priority:** **P2**

### [PROBLEM — P2] FTS/search bounded with per-object full-match counts is right but fragile
- **Location:** `lib/objects.mjs` (account searchable fields incl. description explicitly `filterable:false`), `public/js/search.js`
- **What I found:** Search is index-budgeted and deliberately scoped — good. But the ceiling ("best 200") with per-object full counts can mislead when a field is searchable yet not filterable (can't narrow).
- **Why it matters:** Users may not realize narrowing is unavailable on certain fields.
- **Business impact:** Low-moderate.
- **Recommended direction:** Surface "why can't I filter description" in UI copy; keep budget boundaries documented.
- **Priority:** **P2**

## IMPROVEMENT list

### [IMPROVEMENT — P2] Three overlapping Apps Script generators
- **Location:** `Automation/HCM/apps-script/`, `apps-script-offshoring/`, `apps-script-dms/` (+ nested duplicate `apps-script-dms/apps-script-dms/`)
- **What I found:** Three generations of Google Apps Script document generators coexist; `apps-script-dms` is the current, unified engine (documented, 8 sheets, shared `DocumentEngine.gs`). The older two and the nested duplicate are dead weight and a drift hazard.
- **Why it matters:** Next person may edit the wrong copy; parity claims (vision: "a new service line with zero code changes") live in the newest one.
- **Business impact:** None functional; a maintenance tax.
- **Recommended direction:** Archive old generators out of the repo (git history keeps them); delete the nested duplicate.
- **Priority:** **P2**

### [IMPROVEMENT — P3] Deal money fields non-filterable/non-sortable
- **Location:** `lib/objects.mjs` deal `value_one_time|value_mrr|value_arr|value_weighted` (computed, not filterable/sortable)
- **What I found:** Revenue fields exist but can't be sliced in lists/dashboards; board totals show one-time AND MRR separately (good) but can't be filtered.
- **Why it matters:** Forecasting needs MRR/ARR slicing.
- **Business impact:** Moderately limits the revenue half that's already unvalidated.
- **Recommended direction:** After a real deal exists, enable filter/sort on computed money fields via FTS-eligible stored columns.
- **Priority:** **P3**

### [IMPROVEMENT — P3] One-time vs recurring revenue never summed
- **Location:** `lib/money.mjs` / deal pipeline reporting
- **What I found:** Correctly avoids summing across pricing models, but there's no headline "pipeline by model" view; the vision promises "forecast correctly instead of adding a retainer to a placement fee" — implemented, but no aggregate surface.
- **Recommended direction:** Add a model-aware pipeline total on the board when deals exist.
- **Priority:** **P3**

### [IMPROVEMENT — P3] Session cookie 14-day lifetime with no inactivity cap
- **Location:** `lib/auth.mjs` (scrypt, HttpOnly SameSite=Strict, SHA-256 token, 14 days)
- **What I found:** Sessions last 14 days absolute; no sliding expiry or revocation on role change.
- **Why it matters:** A departed SDR's cookie stays valid ~2 weeks.
- **Business impact:** Low; roles are few and the team is small.
- **Recommended direction:** Add a `--revoke` admin action and consider 7-day absolute + 30-min idle.
- **Priority:** **P3**

### [IMPROVEMENT — P3] `backfill-upload-batches.mjs` depends on evidence timestamps
- **Location:** `backfill-upload-batches.mjs` (one batch per collection day from `collected_at`; "unknown origin" for no-evidence)
- **What I found:** Correctly idempotent and honest about unknown origin — good. But batching by wall-clock day can split one real upload across two batches.
- **Why it matters:** Cosmetic history accuracy.
- **Recommended direction:** Accept; note in docs.
- **Priority:** **P3**

## NICE-TO-HAVE list

- **Uploads "TOTAL RECORDS" frozen vs live funnel** — `public/js/uploads.js` does this well; could add a tooltip explaining the distinction (P3).
- **`--headless` / `--no-intel` flags on the scraper** — already there; nice-to-have: a `--cookie` env var for CI use (P3).
- **`apply-won-lost-stages.mjs` keeps a stage only if deals exist** — good safety; nice-to-have: dry-run diff output (P3).
- **Backup rotation (keep 14) + `VACUUM INTO`** — already solid; nice-to-have: scheduled backup check that reports last-success (P3).
- **`push-to-turso.mjs` resume-by-row-counts + FTS special-casing** — excellent; nice-to-have: a `--dry-run` parity report (P3).
- **Installer `--checksum-skip`/retire-old-row on reinstall** — good; nice-to-have: a rendered-doc regression fixture in `test.mjs` (P3).

## Unfinished features

| Feature | State | Gap |
|---|---|---|
| Qualification engine | Complete | I2 violated once (HCM migration); no bulk re-run UI impact preview (vision #3 promises it) |
| Deals / pipeline | Built, unit-tested | **0 real deals**; money fields not filterable |
| Proposals & agreements | Built (docx, `lib/qualification.mjs` snapshot adapter) | Never run against a real account end-to-end |
| Campaigns | Built | 200-cap silent truncation; membership history good |
| Automations | **Absent** | Referenced in vision; no engine |
| Email/calendar sync | Non-goal (explicit) | Correct |
| Arabic-first (RTL, Hijri, PDPL) | Vision promise | No evidence in code/schema — **unstarted** |
| Cost visibility for enrichment (vision #4) | No evidence | Unstarted |
| Impact preview before re-qualifying (vision #3) | Unstarted | Only one-shot migrations exist |
| Cloud SQL / Cloud Run migration | Documented as "eventually" | Requires async refactor of 350 sync DB calls / 39 files |

## Architecture map

```
public/  (no-framework SPA: core.js h()/mount, manual re-paint)
   │  fetch /api/* via api.js (ApiError, 401→/login)
   ▼
server.mjs  (Node http, zero deps, ESM, Node ≥22.5 for node:sqlite)
   │
   ├─ lib/http.mjs ─ routing/auth/cookies/CSRF
   ├─ api/*.mjs ── records, deals, accounts, prospects, meta,
   │               dashboard, qualification, documents,
   │               generation, views, imports, search
   ├─ lib/repo.mjs ─ generic CRUD (MAX_LIMIT=200, one tx per
   │                  mutation = validate + write + audit + FTS)
   ├─ lib/objects.mjs ─ metadata registry (12 objects, 15 field
   │                  types, OPERATORS per type; verdictPlane())
   ├─ lib/qualification.mjs ─ gate into accounts; imports rules
   │                  from local-scraper/lib (NEVER reimplements)
   ├─ lib/{auth,verification,calling,campaigns,promotion,money,merge}.mjs
   └─ lib/db.mjs ── dual backend, same sync API:
        ├─ local  data/crm.db  (node:sqlite, FTS5)
        └─ remote lib/turso.mjs ─ worker thread + Atomics.wait ⚠ blocks loop

local-scraper/  (dependency: playwright ^1.49.0 only)
   scrape.mjs (persistent profile, li_at cookie, ≤8 carousel slides,
               4–9s pacing, snapshots.json after every company)
   server.mjs (127.0.0.1:5173 upload→qualify→download UI, single job)
   lib/hcm.js | offshoring.js | signals.js | verdicts.mjs | panels.mjs

Automation/  (Google Apps Script, offline of the CRM)
   apps-script-dms/  ─ current unified document engine (8 sheets)
   apps-script/ + apps-script-offshoring/ + nested duplicate ─ legacy
   apify-linkedin-people-insights/ ─ legacy crawl source

Ops: render.yaml (live) · deploy/ GCP Doha VM (documented) ·
     firebase.json + firestore.rules (legacy, permissive) ·
     scripts/: setup, backup-db (VACUUM INTO, keep 14),
     push/pull-to-turso, retire-database, migrate-to-prospecting,
     apply-*-pipeline/widgets, backfill-upload-batches,
     reset-records, install-templates · test.mjs (174 tests, offline)
```

**One sync API, two backends, one of which parks the event loop.** That single line is the scaling constraint of the entire system.

## Data model map

- **Configuration plane:** `object_metadata`, `field_metadata`, pipelines/stages, views, dashboard layouts, templates, users+roles — all data, not code.
- **Record plane:** `accounts`, `contacts`, `deals`, `tasks`, `activities`, `notes`, `documents`, `proposals`, `campaigns`, `agreements`.
- **Evidence plane:** `verdicts` (append-only, per (account, rule-version)), `prospecting_verdicts`; audit table (append-only, separate from timeline); `upload_batches` backfilled from evidence `collected_at`.
- **Prospecting plane:** `prospecting_company` / `prospecting_contact`; `lib/promotion.mjs` is the single gate into accounts.
- **Money:** 4 computed deal fields (`value_one_time|mrr|arr|weighted`), never summed across models; board totals one-time and MRR separately.
- **Search:** FTS5, deliberately index-budgeted; `account.description` searchable but not filterable.
- **Storage:** `data/crm.db` + `data/storage/` (docx) + `data/backups/`; files also live on Turso remote.

## Permission matrix

| Capability | admin | manager | sdr | rep | Enforcement |
|---|---|---|---|---|---|
| Users, roles, config, metadata, pipelines, views, templates | ✅ | — | — | — | role checks in `api/*` |
| All records read/write | ✅ | ✅ | scope: own queue | ✅ (own) | `lib/calling.mjs scopeFor()` applied in SQL |
| `record.read.all` | ✅ | ✅ | ❌ | ❌ | generic routes refuse SDRs |
| Campaign members / lists | ✅ | ✅ | ✅ | ✅ | MEMBER_STATUSES workflow |
| Qualification / verdict re-run | ✅ | ✅ | — | — | `api/qualification.mjs` |
| Document generation | ✅ | ✅ | ✅ | ✅ | templates via `api/documents.mjs` |
| Import / uploads | ✅ | ✅ | — | — | import step UI |
| Audit log read | ✅ | ✅ | — | — | not exposed to SDR/rep |
| Role default on user creation | — | — | — | — | `createUser` defaults to `rep` |

Notes: SDR scope is a *deny-by-missing-permission* design (correct). 14-day cookies are not revocable per-user in the UI (P3).

## Scalability report

**Current ceiling (by design):** one process, one SQLite file. Documented as fine for 5–30 users (`docs/09-state-of-play.md`, `deploy/README.md`).

**The real constraint is worse than documented:** with the Turso backend configured, `Atomics.wait` parks the event loop per query → the server is *single-request-at-a-time*, which breaks the "fine at 5–30 users" claim. Mitigation options: (a) serve from local SQLite and use Turso only for offsite copy (already supported by push/pull scripts), or (b) async refactor toward Cloud SQL (350 sync calls / 39 files — the documented cost).

**Hot paths that run inside the request:** bulk verification, bulk scoring, import. A long import blocks everything. The systemd unit and Render both run one instance — there is no horizontal scaling story.

**Tiering for the future:**
- 5–30 users: local SQLite file, one instance, `backup-db.mjs` daily — works today.
- >30 or second writer during long ops: async DB layer → Cloud SQL/Postgres, then Cloud Run. This is the documented "eventually" and the code structure (`lib/db.mjs` is the only `node:sqlite` touchpoint) genuinely prepares for it.
- Multi-tenant (v2): not started; every schema table and every metadata registry would need `workspace_id`. The vision's "second workspace with no engineering" bar is far away.

## DO NOT FIX YET roadmap (deferred deliberately)

1. **Cloud SQL / Cloud Run migration** — a project, not a sprint. Revisit only when a request *cannot finish* or two people need to write concurrently. Keep `lib/db.mjs` as the single seam.
2. **AI features** — explicitly deferred by the vision ("AI on an unstable schema produces confident nonsense"). The schema is still unstable (0 real deals). Revisit after v1 metrics are met.
3. **Multi-tenant / v2** — the biggest lift; anything multi-workspace built now would churn. Requires the v1 success criteria to pass first.
4. **Email/calendar sync, mobile app, offline** — named non-goals. Do not build.
5. **Automations engine** — do not build the full platform until the qualification→deal→document chain has been walked by hand with real data; learn the real triggers first.
6. **Enrichment cost-visibility (vision #4)** — only matters when paid providers are wired in; nothing is wired in yet.
7. **Arabic-first / RTL / Hijri / PDPL** — a vision promise with zero implementation. High effort, low current users; keep as v2, but do not let it creep into v1 scope.

**The one thing to fix this week (everything else waits):** rotate and remove the committed Turso token (P0 #1). The rest of the roadmap should start with **one real deal walked end-to-end**, not more scaffolding.
