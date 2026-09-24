# Deploying the CRM to Doha

> **Status: written, never provisioned.** Production today is Render
> (`../render.yaml`), talking to a hosted Turso database — that is what the
> ~20 people using this CRM are actually reaching. Everything below is a
> real, ready-to-run alternative plan, kept deliberately current so it is an
> option rather than a scramble if Render ever stops being the right home for
> this. Nobody should assume the VM described here is live without checking
> `gcloud compute instances list` first.

One Compute Engine VM in **`me-central1`** (Doha, Qatar), running the app exactly
as it runs locally. About 30 minutes of work, roughly **$21/month**.

## Why this is not on Firebase

Firebase Hosting serves static files. This app is a Node server that keeps its
data in a single SQLite file, writes generated `.docx` documents to a real
directory, and renders them server-side. Firebase Hosting can only rewrite to
**Cloud Run** or **Cloud Functions**, and both give every instance an *ephemeral*
filesystem — the database would be lost on each restart and never shared between
instances, and so would every contract in `data/storage`.

Hosting on Firebase therefore means moving to Cloud SQL first, which means
converting 350 synchronous database calls across 39 files to async, replacing
FTS5 search, and moving `json_extract` to JSONB. That is a project, not a
deployment. It is the right project eventually — `lib/db.mjs` is the only module
that touches `node:sqlite`, which is what makes it possible at all — but it is
not what gets this live this week.

`talent360crm-v1` stays as the GCP project. Firebase itself is simply not used.

## What gets created

| | | |
|---|---|---|
| `e2-small` VM | `me-central1-a` | ~$14/mo |
| 30 GB balanced PD, **separate from the boot disk** | `me-central1-a` | ~$4/mo |
| Static external IP | `me-central1` | ~$3/mo |
| Cloud Storage bucket, versioned | `ME-CENTRAL1` | pennies |

The data disk is deliberately its own disk. The VM can be rebuilt, resized or
replaced without going near the database, and the daily snapshot schedule is
attached to exactly the thing that matters.

## From your machine

```bash
gcloud auth login
bash deploy/provision.sh            # shows what it would create
bash deploy/provision.sh --apply
```

Then point `crm.<your-domain>` at the address it prints:

```bash
gcloud compute addresses describe crm-ip --region=me-central1 --format='value(address)'
```

Wait for DNS before running certbot, or the challenge fails and you will be rate
limited for an hour.

## On the VM

```bash
gcloud compute ssh crm --zone=me-central1-a
```

```bash
sudo timedatectl set-timezone Asia/Qatar

sudo -u crm git clone https://github.com/LaraaMohamed/talent-360-crm.git /srv/crm
cd /srv/crm

# There are no dependencies to install. That is the point of the project.
node --version          # must be 22.5 or later, for node:sqlite
```

Seed the database, or restore the one you already have — **do not do both**:

```bash
sudo -u crm CRM_DB=/srv/crm-data/db/crm.db CRM_STORAGE=/srv/crm-data/storage node setup.mjs
```

Then the service, the proxy and the timer:

```bash
sudo cp deploy/crm.service /etc/systemd/system/
sudo cp deploy/crm-backup.service deploy/crm-backup.timer /etc/systemd/system/
sudo cp deploy/crm.nginx.conf /etc/nginx/sites-available/crm
sudo sed -i "s/crm.example.com/crm.$(hostname -d)/g" /etc/nginx/sites-available/crm   # or edit it
sudo ln -sf /etc/nginx/sites-available/crm /etc/nginx/sites-enabled/crm
sudo rm -f /etc/nginx/sites-enabled/default

sudo certbot --nginx -d crm.<your-domain>
sudo nginx -t && sudo systemctl reload nginx

sudo systemctl daemon-reload
sudo systemctl enable --now crm crm-backup.timer
```

Templates, so document generation works at all:

```bash
sudo -u crm CRM_DB=/srv/crm-data/db/crm.db CRM_STORAGE=/srv/crm-data/storage \
    node install-templates.mjs --apply
```

## Moving the database you already have

`crm.db` is a live SQLite file with a WAL beside it. Copying it while the app is
running gives you a torn database that opens fine and is missing the last few
writes. Take a **verified** snapshot instead — `backup-db.mjs` checks it opens
and holds the rows it should:

```bash
# on the machine that has the data today
npm run backup
gcloud storage cp data/backups/<newest>.db gs://talent360crm-v1-crm-backups/seed/
gcloud storage cp -r data/storage gs://talent360crm-v1-crm-backups/seed/storage

# on the VM, with the app stopped
sudo systemctl stop crm
sudo -u crm gcloud storage cp gs://talent360crm-v1-crm-backups/seed/<newest>.db /srv/crm-data/db/crm.db
sudo -u crm gcloud storage rsync -r gs://talent360crm-v1-crm-backups/seed/storage /srv/crm-data/storage
sudo systemctl start crm
```

**One live database.** The app stamps each file with an `instance_id` and a
status, and refuses to boot on a copy marked retired. Once the VM is the real
one, retire the laptop's copy so two people cannot work in two databases that
have both diverged:

```bash
# on the old machine, AFTER the VM is serving
node retire-database.mjs --moved-to https://crm.<your-domain>
```

## Before you let anyone in

- [ ] `https://crm.<your-domain>` loads and you can sign in
- [ ] the session cookie shows **Secure** in devtools
- [ ] a write succeeds — rename an account. If it fails with *"Cross-origin
      request refused"*, nginx is not preserving the `Host` header
- [ ] `systemctl start crm-backup.service` once by hand, then check the bucket
- [ ] **restore that backup into a scratch copy and open it** — an unrehearsed
      backup is a hope
- [ ] `curl http://<external-ip>:5180` times out — the app port must not be
      reachable from outside
- [ ] document generation works end to end: an account → Generate document →
      Review → Generate → the file downloads

## Costs this does not cover

Egress is billed. A 2.5 MB proposal downloaded 200 times a month is about 0.5 GB,
which is cents — but "download all" over a large account, repeatedly, is the one
thing here that can surprise you on a bill.

## When to revisit this

The known limits are in [state of play](../docs/09-state-of-play.md): bulk
verification, bulk scoring and import all run inside the request, and the app is
one process against one file. That is fine at 5–30 users. The signals that it is
time for Cloud Run and Cloud SQL are a request that cannot finish, or a second
person needing to write while a long one is running — not a page that feels slow.
