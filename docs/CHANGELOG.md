# Changelog

Migrations and structural changes that have been run against the live database
(`data/crm.db`). One entry per thing that was actually applied — not a plan, and
not every commit.

Add an entry when you run a migration. A database whose history is only in the
scripts folder cannot tell you which of them it has been through.

---

## 2026-08-13 — Workspace owner moved to talent15@talent-360.me

**Applied to:** `data/crm.db` and Turso. Done by script, not through Settings →
People, because `patchMember` refuses to change your OWN role — a guard against
an admin demoting themselves with no way back — and a transfer is exactly that.

| | Before | After |
|---|---|---|
| `talent15@talent-360.me` | admin | **owner** |
| `business-growth@talent-360.me` | owner | **admin** |

Nobody gained or lost a capability: `owner` and `admin` both hold `*` in
`lib/auth.mjs`. What changed is which account is the one others cannot demote.
Both changes are in `audit_events` as `role_changed`.

---

## 2026-08-13 — Proposals and Agreements become a view of the account's documents

**Scripts:** `apply-generated-records.mjs --apply`, `apply-offshoring-talent-fee.mjs --apply`
**Applied to:** `data/crm.db` **and Turso** (`--env-file=data/turso.env`).
**Backups taken:** `npm run backup` for the local file; for the hosted database,
`node pull-from-turso.mjs --out data/backups/turso.before-generated-records-2026-08-13.db`
— 50,291 rows, verified, restorable with `push-to-turso.mjs --source`.

Turso holds more than the local file did (18 generations against 10), so the
counts below differ per database: **10 records** locally, **18** on Turso.
`proposal_versions` and `agreement_proposals` were both empty on Turso, which is
what made the table rebuild safe there — `PRAGMA foreign_keys = OFF` is a no-op
against it (`lib/turso.mjs` skips the pragma; the server decides), so the
cascade protection the script relies on locally does not exist on the host.
**Check those two tables are empty before ever rebuilding them on Turso again.**

### What was wrong

Generating a proposal wrote a `documents` row and a `document_generations` row
and nothing else. The account listed the documents it had generated; the sidebar
listed `proposals` records built from a deal's line items; the two never held the
same thing. `agreements` was worse — nothing outside the tests ever wrote a row,
so that list was permanently empty and the renewals report had nothing to read
while signed contracts with end dates sat in the document table.

The account's view was the correct one. The sidebar is now wired to it.

### What changed in the database

| Table | Change |
|---|---|
| `proposals`, `agreements` | `deal_id` no longer `NOT NULL` — a document is generated for an ACCOUNT. Gained `document_type` and `document_id`. |
| both | Partial unique index on `document_id`: one record per document, one document per record. |
| backfill | One record per existing generation, numbered in the order the documents were produced. Local: 10 (9 proposals, 1 agreement). Turso: 18 (13 proposals, 5 agreements). |
| `proposals` | Earlier versions marked `superseded`, leaving the newest of each type `issued` — 5 locally, 7 on Turso. Never over a status a person set. |
| `document_templates` | `offshoring_proposal` **v2** installed; v1 retired and still readable, so every proposal already generated keeps the bytes that produced it. |

The one pre-existing row, `P-2026-0001`, was already soft-deleted and was not
touched.

### Corrected the same day: records for deleted accounts

The first run created a live record for every generated document, including
documents belonging to accounts somebody had deleted — on Turso that was **10 of
13 proposals and 1 of 5 agreements**, so a Proposals list that had been empty
came back as mostly rows for companies that are gone. A backfilled record now
takes its account's `deleted_at`, and re-running the script repairs a database
left that way, dropping the repaired rows from the search index too. Applied to
Turso; the local file had none. The hosted lists are now 3 proposals and 4
agreements, all for live accounts.

Deleting an account still does not cascade to its children — deals and contacts
behave the same way — and this migration did not change that.

### A template that predates a field is now refused

Generation reads the installed template and checks that every variable fed by a
form field is actually in it. Leftover-token checking could never catch the
opposite problem — a form collecting a price the template has no slot for, so
the document goes out quoting the number baked into the .docx. That is what the
talent fee was, and it would have happened again on the next field added to an
older template.

### The offshoring talent fee

The template read "-Talent fees:  **65** USD per employee / month" with the 65
highlighted yellow — the convention for "edit this by hand before sending",
which is the same thing as saying it should have been a field. It is now
`{{TALENT_FEE}}`, the highlight is gone, and `doc_default_talent_fee` (65) is
what the form opens with. The source file under `Automation/HCM/` was patched
too, so `install-templates.mjs` reproduces it.

Re-running either script is a no-op. `node test.mjs` — 213 passed.

---

## 2026-08-07 — Deal Won / Deal Lost; "Agreement sent" removed

**Script:** `apply-won-lost-stages.mjs --apply`
**Scope:** the `commercial` pipeline only. Recruitment and Managed services
untouched.
**Backup taken:** `data/crm.db.before-won-lost-stages-2026-08-07`

| Before | After |
|---|---|
| `won` — "Deal won" | `won` — **"Deal Won"** |
| `lost` — "Lost" | `lost` — **"Deal Lost"** |
| `agreement_sent` — "Agreement sent" (90%) | *removed* |
| order: … Negotiation, Agreement sent, Deal won, On hold, Lost | order: … Negotiation, On hold, **Deal Won, Deal Lost** |

Stage **keys, ids and types are unchanged** — only labels and positions moved,
so every filter, view, dashboard widget and code path that keys on `won` /
`lost` / `type` still works.

"Agreement sent" held **0 deals** at the time (the pipeline had no deals at
all), so removing it moved nothing. The script refuses to remove it when it
holds any, and says how many.

*Why it went:* the state it described — a contract out for signature — is an
`agreement` record moving from issued to signed, and recording that signature is
already what moves the deal into the won stage (`api/proposals.mjs`,
`signAgreement`). A stage that mirrors another object's status is two places to
update and two places to disagree.

Also changed, so fresh installs and re-runs agree with the live database:

- `setup.mjs` — the seeded commercial stage list.
- `apply-commercial-pipeline.mjs` — now seeds stages **only into a pipeline it
  creates**, so re-running it can no longer resurrect a stage a later migration
  removed. Its own stage list is left as it was, on purpose: a migration records
  what was true when it ran.

Re-running `apply-won-lost-stages.mjs` is a no-op. `node test.mjs` — 103 passed.

---

## Earlier (dates from the scripts and file timestamps, not from git)

There are no commits in this repository, so the record below is reconstructed
from the migration scripts themselves. Each says in its own header what it did
and why.

| Script | What it did |
|---|---|
| `migrate-to-prospecting.mjs --confirm` | Moved 223 pre-separation companies and their full verdict history out of `accounts` / `verdicts` into the prospecting plane. Backup: `data/crm.db.before-prospecting-migration-2026-08-04T11-37-29-043Z`. |
| `backfill-upload-batches.mjs --confirm` | Gave pre-Upload-History companies an upload batch to belong to — one per collection day, taken from the evidence's own `collected_at`, labelled source `collector` rather than inventing a filename. |
| `apply-commercial-pipeline.mjs --apply` | Created the 13-stage Commercial pipeline, made it the default, and replaced the default dashboard's layout. Touched no deals. |
| `import-snapshots.mjs` | Brought the collected companies in as prospects, evidence and verdicts. Reads `snapshots.json`; never writes it. |
