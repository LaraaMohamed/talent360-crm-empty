# 7. Operations

## Running it

```bash
npm start        # node server.mjs — http://127.0.0.1:5180
```

Binds to **127.0.0.1** by default. This holds a customer database and personal
contact data; it does not get a public interface by accident. `HOST` and `PORT`
override it — do not set `HOST=0.0.0.0` without reading
[State of play](09-state-of-play.md) §Deployment first.

`.claude/launch.json` starts the same server for tooling that reads it.

## Deploying it for a team

Everything below assumes more than one person uses this. For a single user on
one laptop, `npm start` is the whole story and you can skip to the next section.

**Production today is Render** (`../render.yaml`), talking to a hosted Turso
database rather than a local file — that is what the general shape below
describes running as a reverse-proxied systemd service. Render terminates TLS
itself and needs none of the nginx/systemd steps below; it is included here
because Render is not the only place this can run, and the next section is
written for wherever it does.

**There is also a worked deployment in [`deploy/`](../deploy/README.md)** — one
Compute Engine VM in `me-central1` (Doha), provisioning script, systemd units,
nginx config and a nightly backup mirrored to a bucket in the same region. The
rest of this section is the general shape; that directory is the specific one.

It is deliberately **not** Firebase. Firebase Hosting serves static files and can
only rewrite to Cloud Run or Cloud Functions, both of which give every instance
an ephemeral filesystem — this app keeps its data in one SQLite file and writes
generated documents to a real directory, so both would be lost on every restart.
Hosting it there means Cloud SQL first, and that means making 350 synchronous
database calls across 39 files async. `lib/db.mjs` being the only module that
touches `node:sqlite` is what will make that possible; it is still a project
rather than a deployment.

**The app speaks plain HTTP and always should.** Put a reverse proxy in front of
it for TLS rather than teaching it certificates. Keep it bound to `127.0.0.1` so
the only way in is through the proxy.

```nginx
server {
    listen 443 ssl;
    server_name crm.example.com;

    ssl_certificate     /etc/letsencrypt/live/crm.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/crm.example.com/privkey.pem;

    # 32MB is the app's own body limit; a smaller one here silently breaks
    # document upload.
    client_max_body_size 32m;

    location / {
        proxy_pass http://127.0.0.1:5180;

        # Host MUST be preserved. The CSRF defence compares the request's
        # Origin against its Host, so a proxy that rewrites Host to
        # 127.0.0.1 makes every write fail with "Cross-origin request
        # refused" — and the error will not point you here.
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For   $remote_addr;
    }
}
```

The service, so it survives a reboot:

```ini
# /etc/systemd/system/crm.service
[Unit]
Description=CRM
After=network.target

[Service]
WorkingDirectory=/srv/crm
ExecStart=/usr/bin/node server.mjs
Restart=always
Environment=HOST=127.0.0.1
Environment=PORT=5180
Environment=CRM_TRUST_PROXY=1
Environment=CRM_SECURE_COOKIES=1
Environment=CRM_BACKUP_DIR=/srv/backups/crm

[Install]
WantedBy=multi-user.target
```

On Windows, the equivalent is a scheduled task with trigger "At startup" or a
service wrapper such as NSSM. The environment variables are the same.

**Before you let anyone in:**

- [ ] `CRM_TRUST_PROXY=1` **and** a proxy that actually sets `X-Forwarded-Proto`
      — the header is only trusted because of that flag
- [ ] `CRM_SECURE_COOKIES=1` once the site is HTTPS-only
- [ ] `CRM_BACKUP_DIR` pointing off this machine, and a scheduled `npm run backup`
      (on Render/Turso this is `.github/workflows/backup.yml` instead — see
      that file's own header)
- [ ] a restore rehearsed from one of those backups
- [ ] `HOST` still `127.0.0.1`, so the app is not separately reachable
- [ ] sign in once and confirm the session cookie shows `Secure`
- [ ] an uptime monitor pointed at `GET /api/health` — it checks the database
      is actually reachable, not just that the process is answering
- [ ] `PUBLIC_BASE_URL` set, if Smartlead or Apollo phone reveal is in use

**Onboarding people.** Settings → People → *Add person* creates the account with
a password you choose and hand over. There is no email in this system, so
password reset works the same way: *Reset link* issues a one-time URL, valid 24
hours, shown to you once — you pass it to them. They set their own password at
`/reset`, which signs them out everywhere else.

Roles are on the membership, not the person; see
[Domain rules §11](06-domain-rules.md).

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `5180` | HTTP port. |
| `HOST` | `127.0.0.1` | Bind address. Leave it as-is behind a proxy. |
| `CRM_TRUST_PROXY` | *(unset)* | `1` trusts `X-Forwarded-Proto`. Only set it when something in front of the app really does set that header. |
| `CRM_SECURE_COOKIES` | `auto` | `auto` follows the request, `1` forces the `Secure` flag on, `0` off. |
| `CRM_SETUP_TOKEN` | *(unset)* | Gates `POST /api/setup`. **Required** on a hosted (`TURSO_URL`) deployment — that endpoint refuses to run without it once there is a real database it could claim. Optional locally, since only this machine can reach it there. |
| `PUBLIC_BASE_URL` | *(unset)* | This server's real public URL. Required before Smartlead or Apollo webhook registration will work — both fail with a clear error rather than silently guessing at a URL. The server logs a warning at boot if this is missing on a hosted deployment. |
| `CRM_BACKUP_DIR` | `data/backups` | Where `backup-db.mjs` writes. Point it off this machine. |
| `CRM_BACKUP_KEEP` | `14` | Snapshots retained. |
| `CRM_DB` | `data/crm.db` | Database file. Useful for a scratch copy. |
| `CRM_STORAGE` | `data/storage` | Uploaded documents on disk. |
| `QUALIFIER_LIB` | `../local-scraper/lib` | Where the qualification rules are imported from. |
| `QUALIFIER_SNAPSHOTS` | `../local-scraper/snapshots.json` | The collected evidence file. Read only, never written. |
| `QUALIFIER_DIR` | `../local-scraper` | Working directory when the CRM supervises the collector. |
| `QUALIFIER_PORT` | the collector's own | Port the proxy talks to. |

## Scripts

Every script that writes is **dry-run by default**. `--apply` or `--confirm`
makes it write, and the destructive ones copy the database first.

| Script | What it does |
|---|---|
| `setup.mjs` | First run, and safe to re-run. Creates the database, workspace, admin, pipelines, activity types, service lines, loss reasons, rules, system views, dashboard, one example custom field. `--email`, `--password`, `--name`, `--workspace`. |
| `import-snapshots.mjs` | Brings collected companies in as prospects + evidence + verdicts. `--file`, `--csv`, `--dry-run`. Never writes to `snapshots.json`. |
| `test.mjs` | 103 offline checks, a few seconds. |
| `reset-records.mjs` | Empties records, keeps configuration. `--dry-run` / `--confirm`, `--keep-files`. Hard delete; copies the database first. |
| `apply-commercial-pipeline.mjs` | Historical: created the Commercial pipeline and repointed the default dashboard. Partly superseded — it now seeds stages only into a pipeline it creates. |
| `apply-won-lost-stages.mjs` | 2026-08-07: renamed the terminals to Deal Won / Deal Lost and removed "Agreement sent". Idempotent; refuses to remove a stage holding deals. |
| `migrate-to-prospecting.mjs` | Historical: moved pre-separation companies and their full verdict history out of the CRM plane into prospecting. |
| `backfill-upload-batches.mjs` | Historical: gave pre-Upload-History companies an upload to belong to, one batch per collection day. |
| `migration-log.mjs` | Ledger of which of the scripts above have actually run against a given database — `--mark <script> "note"` records one. Nothing wired these scripts to record themselves; this is where "did X already run against production" gets a real answer instead of institutional memory. Run against production (`TURSO_URL`/`TURSO_TOKEN` set) the same way any other script here does. |
| `apply-contact-account-uniqueness.mjs` | Adds the uniqueness checks `contacts.email` and `accounts.cr_number` never had. Dry-run reports duplicates; `--apply` only adds the indexes if none exist. Run the dry run against production before ever passing `--apply` there. |

Record anything you run against the live database in [CHANGELOG.md](CHANGELOG.md)
and in `migration-log.mjs`.

## Backups

```bash
npm run backup
```

`backup-db.mjs` takes a **verified** snapshot. Do not hand-copy `crm.db`
instead: the database runs in WAL mode, so at any moment some committed data is
in `crm.db-wal` and not yet in `crm.db`, and a file copy taken while the server
runs produces a database that opens fine and is quietly missing the newest
writes. That failure is only ever discovered during a restore.

The script instead asks SQLite for a consistent snapshot (`VACUUM INTO`), which
is safe with the server running and needs no downtime. It then **opens the
result**, runs `PRAGMA integrity_check`, and compares row counts against the
live database — a snapshot that fails is deleted rather than left looking
reassuring. `data/storage/` is mirrored alongside, because uploaded and
generated documents are not in the database and a restore without them comes
back with every contract missing.

| Variable | Default | |
|---|---|---|
| `CRM_BACKUP_DIR` | `data/backups` | Where the snapshot is written and verified. Keep this on **local disk**. |
| `CRM_BACKUP_COPY_TO` | *(unset)* | **Set this.** A second location the verified snapshot is copied to — a Google Drive or OneDrive folder, or a network share. |
| `CRM_BACKUP_KEEP` | `14` | Snapshots kept, in both locations. Only files it created are pruned. |

**Write locally, copy to the cloud — not the other way round.** Google Drive,
OneDrive and Dropbox present a virtual filesystem whose writes complete locally
and finish somewhere else later. SQLite writing a database straight into one is
the case its own documentation warns about, and worse here: verifying afterwards
would read the local cache back, so the check would pass while the copy that
reached the cloud was truncated. `CRM_BACKUP_COPY_TO` copies bytes already
proven good. If that destination is offline the run still succeeds with a
verified local snapshot, because a backup in one place beats none.

**Before putting client data in a cloud account**, use the organisation's
Workspace/365 account rather than a personal one. `crm.db` holds 2,170 contacts'
personal data along with the `lawful_basis` and `acquired_at` fields recorded
against them; a consumer account carries no data processing agreement.

```bash
node backup-db.mjs --list
```

**Restoring** is a file copy: stop the server, copy a snapshot over
`data/crm.db`, delete any stale `crm.db-wal` / `crm.db-shm`, copy
`storage/` back, start the server. Rehearse it on a copy before you need it —
the snapshot taken on 2026-08-07 was verified this way, opening through the
application's own `migrate()` with all 378 accounts and 1,233 evidence
snapshots intact.

`crm.db` is also the only copy of the most expensive asset in the project:
every collected LinkedIn panel is stored verbatim in the evidence tables, at
4–9 seconds of collection per page.

Pre-migration copies live beside it (`crm.db.before-*`). They are excluded from
git along with the rest of `data/`, and the pruner leaves them alone.

## Background sweeps

There is no separate worker process or job queue (`jobs` is unused schema —
see [State of play](09-state-of-play.md)). Instead `server.mjs` runs three
plain `setInterval` timers inside the same single process that serves
requests:

| Sweep | Interval | Kill switch | What it does |
|---|---|---|---|
| Outreach sync | 15 min | `SMARTLEAD_SYNC_DISABLED=1` | Pulls Smartlead campaign state (opens, replies, bounces) back onto contacts. |
| Renewal notices | 1 hour | `RENEWAL_SYNC_DISABLED=1` | Raises a task + notification once a signed agreement enters its renewal notice window. |
| Reminder sweep | 5 min | `REMINDER_SWEEP_DISABLED=1` | Fires the "due now" bell for overdue tasks and meetings. |

All three are idempotent — a second run inside the same window is a no-op, by
design (their own doc comments in `server.mjs` and `lib/renewals.mjs` /
`lib/reminders.mjs` cover exactly how). **This only matters if this CRM is
ever run as more than one instance at once**: two processes each running
these sweeps would do the same work twice, and for the outreach sync
specifically that means twice the Smartlead API calls against a shared rate
limit. Scaling to more than one instance needs exactly one of them running
these three sweeps — set the other instance's kill-switch env vars, or move
the sweeps to a dedicated single worker. Today, on Render's single free-tier
instance, none of this applies and the kill switches should stay unset.

On Render's free tier the process can also sleep between requests — the
sweeps do not run while asleep, so a reminder can be a few minutes late (fired
on the next request that wakes it) but is never lost, since it only ever
compares against `now()` rather than counting elapsed intervals.

## Workspace settings

Stored in the `settings` table, defaults in `lib/settings.mjs`. `allSettings()`
returns exactly the keys in `DEFAULTS`, so a key not listed there will not
appear in `/api/meta`.

| Key | Default | Meaning |
|---|---|---|
| `timeline_projections` | 8 actions | Which audit actions reach the human timeline. |
| `verdict_stale_days` | 180 | Age past which a verdict is shown with reduced emphasis. |
| `verification_provider` | `bounceban` | Active email-verification provider. |
| `bounceban_api_key` | `null` | Set in Settings → Integrations. |
| `bounceban_api_url` | `null` | Override the endpoint. |
| `campaign_email_policy` | `review` | Which verification outcomes may be enrolled in a campaign: `safe`, `review`, `all`. |
| `scoring_model` | *(not in `DEFAULTS`)* | Written by `PUT /api/scoring/model`; falls back to `DEFAULT_MODEL` in `lib/scoring.mjs`. |

Only `bounceban_api_key` has a UI today. The rest are `PATCH /api/settings`.

## The qualifier dependency

The one thing the CRM genuinely needs at runtime is `../local-scraper/lib/`, for
the qualification rules. That dependency is deliberate — see
[Domain rules §4](06-domain-rules.md).

**Qualifying an uploaded list runs in the CRM** (`lib/qualify-upload.mjs`), on
any host including the deployed one. It reads the evidence tables, applies the
workspace's published rule versions and returns the filtered CSV; it writes
nothing. No browser, no child process, nothing to start.

**Collecting** is the part that still needs a laptop, because it drives a real
Chrome through a signed-in LinkedIn profile. The collector's own page is
**proxied**, not reimplemented, at `/qualifier`. It arrives same-origin, so it
can be framed inside the CRM shell and sits behind the CRM session instead of
being an open port. If nothing is listening on the qualifier's port, the CRM can
start it as a supervised child; one already running from a terminal is adopted
rather than duplicated, and stopping the CRM stops only the child it started. On
the deployed CRM there is nothing to start, and the page says so — scoped to
collection, which is the only thing it blocks.

## Before you change anything

These all pass before and after any change:

```bash
cd ../local-scraper && node test-signals.mjs && node test-panels.mjs
node qualify.mjs --input "Marketing Enriched.csv"
cd ../crm && node test.mjs
```

## Passwords

`setup.mjs` prints a generated admin password once and stores only its scrypt
hash. Nobody, including you, can read it back. To set a new one:

```bash
node setup.mjs --email you@example.com --password "something long" --name "Your Name"
```

Everyone else is added from Settings → People.
