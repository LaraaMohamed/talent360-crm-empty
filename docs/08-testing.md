# 8. Testing

```bash
node test.mjs        # 103 checks, offline, a couple of seconds
```

One file, no framework, no dependencies. It runs against a throwaway database in
the OS temp directory (`CRM_DB` is set before `lib/db.mjs` is imported), so it
never touches `data/crm.db` and never reads or writes the qualifier's
`snapshots.json`. Exit code 1 on any failure.

## What it is for

The suite is deliberately weighted towards **things that are expensive to get
wrong**, not things that are easy to test. Coverage percentage is not a goal
here; the goal is that the five invariants below cannot regress silently.

- REVIEW never collapses into REJECTED, anywhere
- one-time and recurring money are never summed
- verdicts are append-only and versioned
- audit events have no update or delete path
- the CRM reproduces the standalone qualifier's verdicts *and reasoning* exactly
- qualifying an uploaded list writes nothing, and reports a company nobody has
  collected as UNRESOLVED rather than shipping it — or rejecting it

Some checks are structural rather than behavioural, and that is on purpose: one
greps the source for an `UPDATE audit_events`, another greps the CSS for a
physical `margin-left`, another asserts `deals` has no `amount` column. A rule
that only exists in a document is a rule that gets broken by someone who never
read it.

## Layout

Numbered sections, in dependency order:

| | Section | Covers |
|---|---|---|
| 1 | Auth | scrypt round trip, sessions, capability matrix, own-record writes |
| 2 | Money | four pricing models, assumed terms, the no-blending rule |
| 3 | Filter compiler | every operator, parameterisation, `UNRESOLVED` as absence |
| 4 | Repository | validation, audit, search index, soft delete, delete guards |
| 5 | Qualification | rule versioning, verdict history, engine parity |
| 6 | Views | filters, sorts, columns, system views |
| 7 | Deals | stages, required fields, loss reasons, board totals |
| 8 | Objects | the registry's own consistency |
| 9 | CSS | logical properties only |
| 10 | Campaigns | membership history, attribution, the email gate |
| 11 | Bulk operations | id sets and filters |
| 12 | Import engine | preview equals execution, idempotency, undo |
| 13 | Qualifying by hand | recorded human verdicts |
| 14 | The metadata promise | a custom field reaching every surface |
| — | Prospecting | the two planes, promotion, refusals |
| — | Upload history | batches, deletion, restore |

## Writing a check

```js
describe('deals');

check('a lost stage requires a reason', () => {
    throws(() => moveStage(ctx, deal.id, lostStage.id), /reason/, 'and says why');
});

await checkAsync('bulk verification labels without dropping', async () => { ... });
```

`check` / `checkAsync` record a failure and keep going, so one broken thing does
not hide the next five. Assertions are the small helpers at the top of the file —
`eq`, `throws`, and friends. Add to the section your change belongs to rather
than appending at the end; the numbering is the reading order.

## What is not tested

Worth knowing before you trust a green run:

- **No HTTP-level tests.** Handlers are exercised through the library functions
  they call, not through a live server — no request is ever made, so middleware,
  status codes and body parsing are unverified. Route *resolution* is covered
  (§17 builds the real router and asserts which handler each path reaches,
  which is what catches a specific route registered below the generic
  `/api/:object/:id` block), but everything else about the HTTP layer is not.
- **No browser tests.** Everything in `public/` is unverified by the suite
  except the CSS grep.
- **The engine parity check needs `../local-scraper/`.** Without it that section
  cannot run.
- **`lib/scoring.mjs` has no tests at all.** It is not even imported by
  `test.mjs`. Every component function in it is pure and takes plain inputs, so
  this is cheap to fix and worth doing before the module gets a UI.
- **Verification** is covered at the translation layer with a stubbed `fetch`;
  the provider transport is never exercised against the live API, on purpose —
  it costs credits.
