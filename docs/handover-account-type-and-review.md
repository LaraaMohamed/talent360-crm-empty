# Account Type, USD reporting, and document review — handover

Branch: `dashboard-service-matrix-and-finance-capability` (7 commits, not pushed)
Test suite: 293 checks passing.

This covers the twenty-part brief on Account Type, Billing Currency, USD
reporting and the document review workflow. It records what was built, what is
deliberately not built, and the three things that still need a human decision.

---

## What needs doing before any of this is visible

**1. Classify the accounts.** The dashboard's Egypt/Regional matrix reads
`accounts.account_type`. Until accounts have one, every cell renders `$0` and
`—`, which looks exactly like a broken feature. Nothing about the code is wrong
in that state; there is simply nothing to report.

**2. Enter the targets.** Settings → Service targets. A cell with no target shows
the figure and says "no target set" rather than a confident 0%, because 0%
against a number nobody agreed is how an argument starts.

**3. Check the legacy deal currencies.** See below — this is the one that can
produce wrong numbers rather than empty ones.

---

## The legacy currency problem

`deals.currency` is `NOT NULL DEFAULT 'SAR'` in the schema. The USD dashboard
converts by that column. So a deal raised on an Egyptian account that nobody
typed a currency into was **stored** as SAR and then divided by 3.75 instead of
50 — reported at roughly thirteen times its real value. Silently, because SAR
has a perfectly good rate and the unconvertible path never fires.

New deals now inherit the account's billing currency at creation. Existing rows
are not repaired, because a genuinely-SAR deal and a defaulted one are
indistinguishable in the data.

To find the suspects:

```bash
node --env-file=data/turso.env -e "import('./lib/db.mjs').then(m=>console.table(m.all(\"SELECT d.id, d.name, d.currency AS deal_ccy, a.name AS account, a.billing_currency AS acct_ccy FROM deals d JOIN accounts a ON a.id=d.account_id WHERE a.billing_currency IS NOT NULL AND a.billing_currency != '' AND d.currency != a.billing_currency\")))"
```

Deals on Egyptian accounts saying SAR are almost certainly defaults rather than
decisions. Some rows will be legitimate — a client billed in EGP can have one
deal deliberately priced in dollars — so this is a review list, not a fix list.

---

## The architecture, in the order it depends on itself

**Account Type** (`accounts.account_type`) — Egypt or Regional. A commercial
grouping, nothing to do with `accounts.country`. Targets are set per type and
the dashboard reports by it.

**Billing Currency** (`accounts.billing_currency`) — USD, EGP or SAR. What the
client actually pays. Account Type supplies the opening default **once**, at
creation (Egypt → EGP, Regional → USD) and never revisits it: a Regional client
on SAR is an ordinary arrangement, not an exception. Changing an account's type
later does not re-price the client.

**Management reporting rates** — `fx_egp_per_usd` and `fx_sar_per_usd` in
settings, editable by owner and admin only under `finance.settings`. Not
settlement rates, not synchronised, no history. Changing one moves every figure
on the dashboard and no stored amount anywhere.

**Deal currency** — inherited from the account at creation, overridable per deal.

**Dashboard** — normalises to USD by each deal's own currency. A deal whose
currency has no rate is counted as unconvertible and reported, never quietly
treated as dollars.

**Documents** — proposals and agreements keep the client's actual currency. The
conversion runs one way only: the dashboard converts for management, a document
never does.

---

## Financial permissions

`finance.read` — manager, admin, owner. Gates every widget declaring `money: true`
in the registry, **checked where the widget is run**, not by which widgets sit on
which layout. That distinction matters: any member can name a stored dashboard by
id, and the workspace-wide one carries `pipeline_by_stage`.

`finance.settings` — owner and admin only. Reading a converted total and re-basing
every total on the screen are different acts.

`record.delete` — manager and above. Enforced on the single-record route, the
bulk route, and permanent purge.

`document.approve` — manager and above. Reps draft and submit; they cannot
approve.

Every capability the front end gates on is asserted to be present in the
`/api/me` response by a test that scans the page sources. A capability the API
does not send reads as `undefined` in `store.can()`, which is falsey, so the
controls it guards render for nobody while the server stays perfectly correct
and nothing errors.

---

## The review workflow

`draft → pending_review → approved / rejected`, on proposals and agreements.

- Submitting is an edit, so it takes the ownership rule, not a capability.
- Approving needs `document.approve`.
- A rejection requires a reason. It is stored on the record, not only in the
  audit trail, because the author has to read it to act on it. Resubmitting
  clears it — last round's verdict is not this round's.
- Issuing a proposal and signing an agreement both require approval first.
- Creating a new version returns the proposal to `draft`, so v2 goes round
  again. Without that the workflow deadlocks: `issued` is neither approvable nor
  submittable.
- Approving a **template-written** proposal issues it directly. Those have no
  versions, so there is no separate freezing step.
- The previous proposal is superseded when its replacement is **approved**, not
  when it was generated. A rejected draft must not knock the client's live
  proposal out of the account on its way past.

**Automation follows the same path.** Generated documents arrive
`pending_review`. They used to be created `issued` — produced from a template,
numbered, filed, and treated as finished with nobody having read them.

### Not enforced: separation of author and reviewer

A manager can approve a proposal they wrote themselves. On a team this size the
alternative deadlocks the moment the only manager writes one. The capability
boundary is the control that was asked for, and the audit trail records who
approved what, so self-approval is visible rather than prevented. If the business
wants the hard rule, it is a few lines in `reviewDocument` plus a decision about
what happens when nobody else is available.

---

## Deliberately not built

Per Part 7 of the brief: no historical FX tables, no daily rate synchronisation,
no currency revaluation, no accounting FX transactions, no stored converted value
per deal. The dashboard computes USD dynamically from the original amount, the
original currency, and the current admin rate. That is the whole design.

---

## Known-good verification

Beyond the suite, these were checked against a running server rather than by
inspection:

- A rep requesting the workspace dashboard **by id** gets both money widgets
  refused and no currency figure anywhere in the response; an admin gets all of
  them.
- A rejected proposal reads back with its note and the reviewer's name.
- A rep gets `document.approve: false` from `/api/me` and a 403 from the review
  endpoint — UI gate and server agreeing.

Screenshots were not taken: signing into the preview browser needs a password,
which the assistant does not enter.
