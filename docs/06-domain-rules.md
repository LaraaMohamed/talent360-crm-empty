# 6. Domain rules

These are the rules the product's credibility rests on. Each one is enforced in
code, most are asserted by `test.mjs`, and each was written down because getting
it wrong is a known, specific failure — not because it sounded prudent.

## 1. A deal has no amount

`deals` has no `amount` or `value` column, and a test asserts it never grows
one. Value comes from line items, in four pricing models:

| Service | Model | Recurrence |
|---|---|---|
| Recruitment | `placement_fee` — % of first-year salary × placements | one-time |
| Strategy | `fixed_fee` | one-time |
| HCM | `per_seat` — seats × price × months | recurring |
| Offshoring | `per_headcount` — heads × price × months | recurring |

*"3 placements at 15% plus 40 seats at 120 SAR/month for 24 months"* cannot be
written as one number. Five figures are derived, and **one-time and recurring
are never summed**:

```
one-time    Σ non-recurring lines
MRR         Σ recurring monthly
ARR         MRR × 12
TCV         the ONLY combined figure — and it names the term it assumed
weighted    one-time × stage probability
```

A recurring line with no stated term is treated as 12 months **and flagged as
assumed**, in the rollup and on the proposal. `lib/money.mjs`, and the same rule
one level up in `lib/campaigns.mjs` for campaign attribution.

## 2. The commercial pipeline

The default pipeline, and the one the dashboard reports on. As of 2026-08-07:

| # | Stage | Probability | Type |
|---|---|---|---|
| 0 | In campaign | 0 | open |
| 1 | Ready to cold call | 0 | open |
| 2 | Interested | 0 | open |
| 3 | Send profile | 0 | open |
| 4 | Follow up | 0 | open |
| 5 | Meeting scheduled | 10% | open |
| 6 | Proposal preparing | 30% | open |
| 7 | Proposal sent | 50% | open (requires `close_date`) |
| 8 | Negotiation | 70% | open |
| 9 | On hold | 0 | open |
| 10 | **Deal Won** | 100% | won |
| 11 | **Deal Lost** | 0 | lost |

**The first six stages are outreach states, not opportunities.** A company "In
campaign" has not agreed to anything. They carry probability 0 on purpose, so
they appear on the board without inflating the weighted forecast, and the win
rate counts only closed deals so they never enter that denominator either.
Without both, adding a cold list to a campaign would visibly "grow pipeline" and
quietly sink the win rate.

**There is no "Agreement sent" stage.** It was removed on 2026-08-07. The state
it described — a contract out for signature — is an `agreement` record moving
from issued to signed, and recording that signature is what moves the deal into
Deal Won (`api/proposals.mjs`, `signAgreement`). A stage that mirrors another
object's status is two places to update and two places to disagree. If you ever
want the board to show contracts awaiting signature, filter agreements by status
rather than re-adding the stage.

Two other pipelines exist and are untouched by any of this: **Recruitment**
(qualified → brief → shortlist → interviews → offer → placed / lost) and
**Managed services** (qualified → discovery → proposal → negotiation →
contracting → won / lost).

Stage `type` is what drives behaviour, never the label: `won` and `lost` set
`deals.status` and `closed_at`, entering a `lost` stage requires a loss reason,
and the win-rate widget is `won / (won + lost)` — never won over
everything-in-flight, because a deal still being worked has not been lost.

## 3. The three qualification invariants

**I1 — Evidence and conclusion are separate.** `evidence_snapshots` holds what
was observed; `verdicts` holds what was concluded. Collection is expensive and
rate-limited; evaluation is free and offline. Re-qualifying every company under
a changed rule takes about a second, which is what makes the impact preview
possible at all.

**I2 — Verdicts are immutable and versioned.** Re-running appends a row and
marks the previous one superseded. Rules are versioned too: publishing a
threshold change creates version N+1 and leaves old verdicts pointing at the
version that produced them. Changing the HCM band from `>= 20` to `20–50` once
moved 117 of 223 verdicts and nothing recorded it.

**I3 — Absence of evidence is never a negative answer.** REVIEW is not a soft
REJECTED, and the codebase defends that in several places at once:

- the filter compiler treats `UNRESOLVED` as *no verdict row exists*, not a value
- `is_none_of ['QUALIFIED']` uses `NOT EXISTS`, so never-evaluated records stay in
- every verdict chart renders all buckets, including zeros
- REVIEW is amber, never grey — grey reads as "ignore me"
- the evidence card distinguishes *not collected* from *collected and empty*
- **disqualifying takes unanimity.** One rule saying REJECTED while another is
  still REVIEW is one answer and one non-answer; treating that pair as "no" is
  the same collapse one level up.

## 4. The rules are imported, never copied

`lib/qualification.mjs` loads `hcm.js`, `offshoring.js`, `signals.js` and
`normalize.js` from `../local-scraper/lib/` and executes them unmodified. Those
files encode bugs found against real LinkedIn data over many iterations. A
second copy would be a second set of those bugs, drifting apart from the first.

If `local-scraper/` moves, set `QUALIFIER_LIB` and `QUALIFIER_SNAPSHOTS` — do
not copy anything. `test.mjs` runs one payload down both paths and asserts the
verdict *and the reasoning, line for line*, are identical.

## 5. Prospecting is not the CRM

Everything uploaded lives in the prospecting plane. Only what a human
deliberately promotes becomes an account. `lib/promotion.mjs` is the only door,
and it refuses to promote an unqualified company unless explicitly forced,
refuses to create a second account for a company already promoted, and never
deletes or moves the prospect.

**Import is lossless.** A contact whose email bounces is still a real person
with a phone number, a title and a LinkedIn profile. The deliverability gate is
at campaign enrolment, where a bad address actually costs something — not at
import, where refusing it throws away the relationship to solve a problem you do
not have yet.

## 6. A score is not a verdict

A verdict answers a claim ("this company has an HR gap"), from evidence. A score
answers a priority ("work this one first"). A verdict can be REJECTED and the
company still worth a call; a score of 78 proves nothing about anything. Scores
live beside verdicts, never inside them, and a score never changes a verdict.

Every score component returns its number **and the reason for it**. `explain` is
not a debug feature — a lead score nobody can account for is a number people
stop trusting the first time it disagrees with them.

## 7. A provider's vocabulary never reaches the database

BounceBan says "deliverable"; ZeroBounce says "valid"; NeverBounce means
something subtly different by "catchall". Answers are translated into the CRM's
own statuses at the edge, once, and the raw payload is kept alongside for audit.
Business logic reads `status`; nothing outside `lib/verification.mjs` reads
`raw`.

The vocabulary is deliberately more than a boolean: "we could not tell"
(`unknown`) and "anything at this domain accepts mail" (`accept_all`) are
genuinely different from both good and bad. `campaign_email_policy` (`safe` /
`review` / `all`) decides which are allowed into a campaign; invalid, disposable
and do-not-email are refused under every setting including `all`.

## 8. Activities and audit events are two stores

| | Activity | Audit event |
|---|---|---|
| Audience | Salespeople | Compliance, support |
| Volume | Low, curated | Every mutation |
| Editable | Yes | **Never** |

Merged, you get a timeline nobody reads (drowned in `custom_field_47: null → ""`)
and an audit log that fails its first review. Selected audit actions *project*
into the timeline, and which ones is the `timeline_projections` setting. There
is no code path anywhere that updates or deletes an audit event — `test.mjs`
greps for one.

## 9. Merges never lose data

A populated value is never replaced by an empty one. Everything else is
precedence: identical values need no decision, verified beats unverified,
enriched beats stale, newer beats older — and anything still tied is a
**conflict for a human**, surfaced rather than coin-tossed. `lib/merge.mjs`.

## 10. Names, money, time and direction

- **The full name is the authority.** First and last are derived conveniences.
  Most people here are named in Arabic, where three- and four-part names are
  ordinary; splitting and rebuilding returns a different name to the person it
  belongs to. An edited full name is never silently rewritten. `lib/names.mjs`.
- **Money is an amount plus a currency**, with the FX rate frozen at close.
- **Due dates are UTC**, rendered in the viewer's timezone. The workspace
  weekend defaults to Friday–Saturday.
- **Logical CSS properties only.** Every text input carries `dir="auto"`; the
  interface mirrors under `dir="rtl"`, and a physical `margin-left` fails the
  test suite.
- **Agreements sort by notice date, not expiry.** A 90-day notice on a 12-month
  contract means the decision is due in month nine.

## 11. Permissions

Five roles, carried by the **membership**, never by the user.

| Role | Holds |
|---|---|
| `owner`, `admin` | Everything. |
| `manager` | Read/write all records, delete, stage changes, qualification, export, share views, issue proposals, sign agreements. |
| `rep` | Read all, write **own**, stage changes, qualification, share views, issue proposals. No export, no delete, no signing. |
| `readonly` | Read records and members. |

`export` is deliberately its own capability rather than implied by read. Reading
one record on screen and walking out with the whole database as a CSV are
different acts.
