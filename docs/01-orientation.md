# 1. Orientation

## What this is

A CRM for a recruitment and HR-services consultancy, built around an existing
LinkedIn qualification engine rather than beside it. It has no runtime
dependencies: Node's own HTTP server, `node:sqlite`, and a browser front end
served as plain ES modules. No build step, no bundler, no database server.

Requires **Node 22.5 or newer** (`node:sqlite` ships from that version).

## Run it

```bash
cd "C:\Users\lenovo\Desktop\files\crm"
node setup.mjs
```

`setup.mjs` creates `data/crm.db`, seeds a workspace, three pipelines, activity
types, service lines, loss reasons, qualification rules, system views, a default
dashboard and one example custom field. It prints a generated admin password
**once** — only its scrypt hash is stored, so nobody can read it back
afterwards. It is safe to re-run: it only ever adds what is missing.

```bash
npm start          # http://127.0.0.1:5180
node test.mjs      # 103 checks, offline, a few seconds
```

Optionally bring in the collected companies (see
[Operations](07-operations.md)):

```bash
node import-snapshots.mjs
```

## The mental model, in five sentences

1. **Two planes.** Everything uploaded lives in the *prospecting* tables and is
   history; only what a human deliberately promotes becomes an *account* in the
   CRM proper. `lib/promotion.mjs` is the only door between them.
2. **One registry.** `lib/objects.mjs` defines every object and every field, and
   the list view, the record form, the filter builder, search, import and the
   API all read it. There is no second list of fields anywhere.
3. **One write path.** `lib/repo.mjs` validates, writes, appends an immutable
   audit event and refreshes the search index — in one transaction, for every
   object, from every caller.
4. **Evidence and conclusion are separate.** Collected LinkedIn panels are
   stored verbatim and never edited; verdicts are appended, versioned and never
   updated in place.
5. **A deal has no amount.** Value comes from line items in four pricing models,
   and one-time revenue is never added to recurring revenue.

If you internalise only those five things, most of the code will look inevitable
rather than arbitrary.

## The first hour

Read these five files, in this order. They are about 1,500 lines together and
they carry most of the design:

| File | What it will teach you |
|---|---|
| `lib/objects.mjs` | The registry, field types, operators, the two planes. |
| `lib/repo.mjs` | The single write path, audit, search, permission checks. |
| `api/index.mjs` | Every route in the system, in registration order. |
| `lib/money.mjs` | Why deals have no amount column. |
| `lib/promotion.mjs` | The prospecting → CRM door, and what it refuses to do. |

Then open the app and click through Prospecting → Accounts → a record → Deals →
Dashboard. The nav in `public/js/app.js` is grouped in the order the work
actually happens.

## Vocabulary

| Term | Means |
|---|---|
| **Prospect / prospecting company** | An uploaded company in `prospecting_companies`. Not in the CRM. History, kept forever. |
| **Account** | A company someone deliberately promoted into the CRM. |
| **Promotion** | Prospect → Account. The one-way door in `lib/promotion.mjs`. |
| **Evidence snapshot** | Raw collected LinkedIn panels, stored verbatim, immutable. |
| **Verdict** | A rule's answer about a claim: QUALIFIED / REVIEW / REJECTED. Appended, versioned, never updated. |
| **Rule** | A versioned qualification configuration (`hcm`, `offshoring`) executed by the imported engine. |
| **Score** | A priority number, 0–100, derived from a configurable model. Not a verdict, and never treated as one. |
| **Verification status** | The CRM's own email-deliverability vocabulary, translated from whichever provider is active. |
| **Plane** | Either the prospecting tables or the CRM tables. Several modules take a `plane` argument for exactly this reason. |
| **Object** | An entry in the registry (`account`, `deal`, `task`…). Twelve of them today. |
| **View** | A saved filter + sort + columns, URL-addressable, stored as configuration. |
| **List** | A named membership of records — static, or dynamic from a filter. |
