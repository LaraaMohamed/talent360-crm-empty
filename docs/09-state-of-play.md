# 9. State of play

**Read this first if you are taking the project over.** Everything below was
verified against the code and the live database on **2026-08-07**.

## Where the data actually is

| | |
|---|---|
| Accounts | 378 |
| Contacts | 2,170 |
| **Deals** | **0** |
| Workspaces | 1 (`Talent 360`) |

That third row is the most important line in this document. The prospecting
half of the product — upload, qualify, verify, promote — has been used against
real data. **The commercial half has never been exercised with a single real
deal.** Line items, proposals, agreements, forecasting, renewals and the win
rate are all implemented and unit-tested, and none of them has met a user.
Expect to find rough edges there first, and do not read the dashboard's zeroes
as bugs.

## Done and in use

- Prospecting plane: upload history, qualification, review queue, evidence,
  verdict versioning, impact preview.
- Qualification engine integration, proven identical to the standalone
  qualifier.
- Promotion (prospect → account), with its refusals.
- Accounts and contacts: list, record, merge/unmerge, duplicate detection,
  custom fields, saved views, dynamic lists, CSV import with preview and undo.
- Email verification via BounceBan, with the provider-neutral status vocabulary
  and the campaign enrolment gate.
- Search (FTS5), audit trail, timeline projection, documents with signed URLs.
- Authentication, roles, capabilities.
- Responsive UI, light/dark, LTR/RTL.

## Built but never exercised

Implemented, covered by tests, no production use:

- Deals, the board, stages, line items, four pricing models, forecast.
- Proposals and versioning; agreements, renewals and notice dates.
- Campaign attribution rollups.
- The dashboard's commercial widgets (they currently report zeroes truthfully).

## Partial — the specific gaps

### 1. Lead scoring has no UI
`lib/scoring.mjs` and `api/scoring.mjs` are complete: a configurable model,
six explained components, bulk and single scoring, an `explain` endpoint. The
score fields are in the object registry, so they already appear as list columns
and filters.

**Nothing in `public/js` calls any of it.** There is no model editor, no
"rescore" button, and no score card on a record. Until that is built the feature
is unreachable, and the columns will read empty. `lib/scoring.mjs` also has no
tests — see [Testing](08-testing.md).

*Next step:* a Settings → Scoring panel bound to `GET/PUT /api/scoring/model`, a
bulk action on the prospects list calling `POST /api/prospects/score`, and a
score card on the record page rendering `GET /api/prospects/:id/score`.

### 2. Notifications are read-only
The table, the two endpoints and the bell exist. **Nothing writes a
notification anywhere in the codebase**, so it is permanently empty.

*Next step:* decide the handful of events that deserve one (assigned a task, a
deal moved by someone else, an agreement approaching its notice date) and write
them from the places that already audit those actions. Do not make it an
audit-event mirror; that is exactly the mistake `timeline_projections` exists to
avoid.

### 3. Background jobs are not implemented
`jobs` is in the schema with a good comment about work that outlives a request,
and it is never read or written. Long operations — bulk verification, bulk
scoring, large imports — run inside the request today. They work, but a browser
refresh loses the progress display, and a second tab sees nothing.

*Next step:* only if a real operation starts timing out. A job table with no
runner is not a half-built feature, it is a decision that has not been needed
yet.

### 4. Settings without a UI
`verification_provider` and `campaign_email_policy` are real, honoured settings
with no control in Settings — they can only be changed by `PATCH /api/settings`.
`campaign_email_policy` in particular decides who can be enrolled in a campaign,
which is a decision an admin should be able to see and make.

### 5. Automation engine
`../docs/10_AUTOMATION_ENGINE.md` specifies a rules engine. It does not exist.
What exists is a small number of hardcoded automations, each in the handler that
owns the event and each writing `source: 'automation'` into its audit event:
signing an agreement moves the deal to won and the account to customer; a
qualifying verdict moves an account's lifecycle stage. That is deliberate and
sufficient for now; if a rules engine is ever built, these are the behaviours it
must absorb rather than duplicate.

### 6. Integrations
Two: the qualifier (imported and proxied) and BounceBan. Everything else in
`../docs/11_INTEGRATIONS.md` — email sync, calendar, LinkedIn API, accounting —
is unbuilt, and the campaign module is deliberately *not* a sending platform.

## Not started, and the open questions behind them

**Multi-tenancy (HANDOFF Q-01).** Single-workspace by data, but every table
carries `workspace_id` and every query filters on it, so the second workspace is
a signup form and an invitation flow rather than a schema change. Nothing has
been tested with two.

**Scale (Q-04).** SQLite, one file, one process. Fine at 378 accounts and 2,170
contacts. There is no benchmark at 100× that, no connection pooling question to
answer (there is one connection), and no read-replica story. When it matters,
the shape of the port is Postgres + the same registry, and ADR-03's typed slot
columns become worth having.

**Custom-field count (Q-11).** Custom fields are a JSON `properties` column, not
typed slot columns. Deliberate — see README §5. Filtering on one uses
`json_extract`; there is no expression index yet. If a workspace defines dozens
of filterable custom fields, add the index before assuming the design is wrong.

**Deployment.** Still not done, but no longer unprepared. As of 2026-08-07 the
application side is ready for it: cookies take the `Secure` flag behind TLS
(`CRM_SECURE_COOKIES`), `X-Forwarded-Proto` is honoured only when
`CRM_TRUST_PROXY=1`, password reset exists so people can be onboarded without an
admin editing the database, and `backup-db.mjs` takes verified snapshots.

What is left is infrastructure, not code: a host, a reverse proxy with TLS, a
service definition that survives reboot, log rotation, and a scheduled backup
pointed off the machine. [Operations §Deploying it for a team](07-operations.md)
has a working nginx config, a systemd unit and the pre-flight checklist. The one
trap worth repeating: the proxy must preserve the `Host` header or every write
fails the CSRF check.

**Known scale limit at 5–30 users.** Bulk verification, bulk scoring and import
execution all run inside the request. Bulk verification is capped at 500 ids per
call, and BounceBan's waterfall endpoint holds a connection for 30–300 seconds
per address, so a large run is a request that cannot complete sensibly. This is
what the unused `jobs` table is for, and it is the first thing to build if more
than a couple of people start using those features at once.

## The git situation — deal with this first

The repository has **no commits at all**. `main` exists with a fully staged tree
and nothing recorded, and several of the newest modules
(`api/scoring.mjs`, `api/verification.mjs`, `lib/scoring.mjs`,
`lib/verification.mjs`, `lib/merge.mjs`, `lib/names.mjs`, `lib/promotion.mjs`,
the migration scripts, and this `docs/` folder) are not even staged.

Every "why is this like this?" answer currently lives in a file comment, because
there are no commit messages to hold it. Before writing any code:

```bash
git add -A && git commit
```

Then commit in small pieces with real messages. The file comments are excellent
and should stay, but they are not a substitute for history — and a project with
one commit called "initial" loses the same information as a project with none.

## Done since this document was written

- **The tree is committed.** Six commits on `main`, local only — no remote is
  configured, so the repository still does not survive losing the machine.
- **Verified backups** (`npm run backup`), with a rehearsed restore.
- **Password reset and change**, plus `Secure` cookies behind TLS.
- **The pipeline ends in Deal Won / Deal Lost**, and "Agreement sent" is gone.
- **The document automation port** has its engine, registry and regression
  tests; the CRM-facing half is not built (see
  [the port map](10-automation-port-map.md)).

## Suggested order of work

1. ~~**Commit the tree.**~~ Done.
2. **Put a real deal through the pipeline end to end** — create it, add line
   items in two pricing models, issue a proposal, sign an agreement, watch it
   land in Deal Won, then check the dashboard, the forecast and the win rate
   against what you expect. This is the highest-value hour available, because
   that path has never run against real data.
3. **Finish lead scoring** (§1). It is one UI away from being usable, and the
   empty score columns are visible in the product today.
4. **Add tests for `lib/scoring.mjs`** while its behaviour is still fresh.
5. **Expose `campaign_email_policy` in Settings** (§4).
6. **Decide about notifications** (§2) — build the few that matter, or remove
   the bell. An empty bell is worse than no bell.
7. Everything under "Not started" is a business decision, not a backlog item.
   Do not start it because it is listed here.
