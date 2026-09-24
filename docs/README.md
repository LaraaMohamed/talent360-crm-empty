# CRM — developer documentation

This folder documents the CRM **as built**. It is written for the next person to
work on it, and it assumes nothing except that you can read JavaScript.

Everything here was checked against the code on **2026-08-07**. Where a document
states a number (checks, tables, routes), that number was counted, not
remembered.

## Read in this order

| | | |
|---|---|---|
| 1 | [Orientation](01-orientation.md) | Run it, sign in, and understand the shape of the thing in an hour. |
| 2 | [Architecture](02-architecture.md) | A request from socket to SQL and back. What each module owns. |
| 3 | [Data model](03-data-model.md) | Every table, the two planes, and how the schema changes. |
| 4 | [Extending it](04-extending.md) | Recipes: add a field, an object, a view, a widget, a stage, a provider. |
| 5 | [API reference](05-api.md) | Every endpoint, the conventions they share, and the error contract. |
| 6 | [Domain rules](06-domain-rules.md) | The invariants. Break one of these and the product stops being trustworthy. |
| 7 | [Operations](07-operations.md) | Scripts, settings, environment, backups, and the qualifier dependency. |
| 8 | [Testing](08-testing.md) | What `test.mjs` guards and how to add to it. |
| 9 | [State of play](09-state-of-play.md) | **Start here if you are taking this over.** Done, partial, and not started. |
| 10 | [Automation port map](10-automation-port-map.md) | The `Automation/` Apps Script system mapped onto the CRM: templates, placeholders, calculations, two defects found, and what is built so far. |
| — | [Changelog](CHANGELOG.md) | Dated record of migrations that have been run against the live database. |

## The other documentation, and how it differs

There are two sets of documents in this project and they answer different
questions.

Both now live in this folder, told apart by their filenames:

**`NN_UPPERCASE.md`** (`00_EXECUTIVE_SUMMARY.md` … `17_ENTERPRISE_READINESS.md`,
plus `08_MODULE_SPECIFICATIONS/`) — 25 specification documents: product vision,
requirements, domain model, architecture, module specs, permission model,
backlog, roadmap. These describe what was **designed**. They were written before
and alongside the build and they are still the reference for intent — why an
entity exists, what the product is deliberately not.

**`NN-lowercase.md`** (the ten listed above) — what was **built**, where it
lives, and what is still missing. When the two disagree, the code is what runs;
these say so explicitly wherever a deviation is deliberate (see
[Domain rules](06-domain-rules.md) and [State of play](09-state-of-play.md)).

The numbers in the two sets are unrelated — `03_DOMAIN_MODEL.md` and
`03-data-model.md` are not a pair. Worth separating into `specification/` and
`developer/` subfolders when someone next has ten minutes.

**`../HANDOFF.md`** — the original brief, including eleven blocking questions
(Q-01 multi-tenancy, Q-04 scale, Q-11 custom-field count). Most are still open;
[State of play](09-state-of-play.md) says which ones the build has quietly
answered and which are still genuinely open.

**The code itself.** Nearly every file opens with a comment explaining why it is
the way it is, and several of those comments record a bug that was shipped
before it was a rule. Those comments are documentation. Do not delete them to
"tidy up" — read them, and if you change the behaviour they describe, change
them in the same commit.
