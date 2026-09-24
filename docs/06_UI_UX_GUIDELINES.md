# UI / UX Guidelines

**Status:** Draft v0.1 · **Owner:** Design · **Last reviewed:** 2026-08-03

Principles and flows. Tokens and components are in [07](07_DESIGN_SYSTEM.md).

---

## 1. What "feels premium" actually means

The brief names HubSpot, Linear, Notion, Raycast, Stripe and Vercel. What they
share is not rounded corners — it is **respect for the user's attention and
time**. Three properties do most of the work:

**Speed you can feel.** Linear feels fast because it responds optimistically and
reconciles later. A 200 ms interaction that never blocks beats a 50 ms one that
freezes the page. Every mutation in this product should update the UI
immediately and roll back visibly on failure.

**No dead ends.** Every empty state, error and permission denial explains what
happened and offers the next action. "No results" is a failure of design;
"No accounts match these 3 filters — clear the industry filter?" is a product.

**Density without noise.** Salespeople scan hundreds of rows. Generous
whitespace in a *record* view is calm; the same whitespace in a *table* wastes
half the screen. Density is contextual, and the table is where this product is
either usable or not.

### The anti-patterns to refuse

| Refuse | Because |
|---|---|
| Modals stacked on modals | Loses context; kills keyboard flow |
| Spinners on the whole page | Skeletons that match final layout prevent reflow jump |
| Confirmation dialogs for reversible actions | Undo is better than "Are you sure?" |
| Toasts as the only feedback | They vanish; state should be visible in place |
| "Something went wrong" | Say what, and what to do |
| Hiding bulk actions behind a menu | The most common power action deserves the most direct path |
| Infinite scroll on data tables | Users need position and totals |

---

## 2. Information architecture

```
Command palette (⌘K)  ─ always available, the fastest path to anything

Sidebar               Main
├ Dashboard           ┌──────────────────────────────────────┐
├ Accounts            │ Object header · view switcher · ⚙    │
├ Contacts            ├──────────────────────────────────────┤
├ Deals               │ Filter bar · saved views · search    │
├ Prospecting  ◄──────├──────────────────────────────────────┤
│  ├ Import           │                                      │
│  ├ Qualification    │  Table / Kanban / Calendar / Cards    │
│  └ Lists            │                                      │
├ Tasks               │                                      │
├ Proposals           ├──────────────────────────────────────┤
├ Agreements          │ Selection bar (on select) · pagination│
├ Reports             └──────────────────────────────────────┘
└ Settings
```

**Prospecting is a top-level destination, not a tab inside Accounts.** It is a
distinct job — building and judging a target list — done by different people at
different times from account management. Burying it would waste the product's
best differentiator.

---

## 3. The flows that decide whether this feels professional

### 3.1 Import → qualify → export

The existing product's core loop, and the first thing any evaluator will try.
It currently works well and the CRM version must not regress it.

```
1  Drop file          Instant local parse. Row/column count before any upload.
2  Pre-flight         "126 rows · 13 columns · 100 companies
                       · 100 already collected · 0 need collecting"
                      Cost and time shown BEFORE the button, not after.
3  Map columns        Auto-detected from values, not header text. Confidence shown.
                      Saveable as a named template.
4  Duplicate check    "12 already exist. Update them / skip them / create anyway."
5  Preview            Exact counts: create, update, skip, reject — with reasons.
6  Run                Live progress, per-company. Cancellable. Resumable.
7  Summary            Persistent, revisitable, with a downloadable error report.
```

**The pre-flight step is the product's signature.** Every competitor makes you
commit before telling you the cost. Showing "this will take 20 minutes and cost
$4.80" beforehand is a small feature that buys enormous trust — and it is
already implemented in the current UI.

### 3.2 Reading a verdict

This is where the product either differentiates or becomes another lead score.

```
┌─────────────────────────────────────────────────────────┐
│ ● QUALIFIED   HCM (HR gap)              computed 2d ago │
│                                                          │
│ headcount 34          in band 20–50              ✓      │
│ HR employees 0        ≤ 1                        ✓      │
│ coverage 100%         aggregate panels are a census      │
│                                                          │
│ Evidence  "What they do" panel · local-browser · 2 Aug   │
│           Engineering 24 · Operations 8 · Sales 2        │
│           Listed functions account for all but 0 staff,  │
│           so HR cannot exceed 1 — arithmetic, not assumed│
│                                                          │
│ Rule v3 · confidence 1.0     [ Re-run ]  [ Disagree? ]  │
└─────────────────────────────────────────────────────────┘
```

Non-negotiable elements:

- **Age is always visible.** A verdict is a claim about a moment.
- **Every check shows its number and its threshold**, not just a tick.
- **Evidence is quoted**, attributed to a provider and a date.
- **The rule version is shown**, so a changed verdict is explicable.
- **"Disagree?"** captures a reason. That is the ICP feedback loop, and it must
  be one click from the verdict, not buried.

### 3.3 REVIEW must be actionable, not a shrug

REVIEW is the most important verdict and the easiest to render badly. A grey
badge that says "review" teaches users to ignore it.

```
┌─────────────────────────────────────────────────────────┐
│ ◐ REVIEW      Offshoring (Egypt footprint)              │
│                                                          │
│ Egypt is not among the 5 locations LinkedIn lists.       │
│ Listed countries account for 214 of 235 employees,       │
│ so at most 21 could be in Egypt — not enough to rule     │
│ it in or out.                                            │
│                                                          │
│ This is not a "no". To settle it:                        │
│   → Filter the People tab by Egypt      [ Open ]        │
│   → Enrich from another provider  ~$0.02 [ Run ]        │
│   → Answer manually                     [ Set ]         │
└─────────────────────────────────────────────────────────┘
```

Every REVIEW offers a route to resolution. If there is no route, say so
plainly — that is still more honest than a false negative.

### 3.4 Triaging REVIEW in bulk

The single-verdict panel above is well designed and, on its own, useless for the
actual job. **REVIEW is 26% of current verdicts — 58 of 223.** A user facing 58
of them needs a queue, not 58 page loads.

Without this, REVIEW becomes a thing users route around, which quietly destroys
the product's core differentiator.

```
┌─────────────────────────────────────────────────────────┐
│ REVIEW queue · Offshoring            12 of 58   ▓▓░░░░░ │
│                                                          │
│ ALMAYAL Co. For Contracting            196 employees     │
│                                                          │
│ Egypt not in top 5 locations. Listed countries cover     │
│ 157 of 196 — up to 39 could be in Egypt.                 │
│                                                          │
│ [ E ] Enrich  ~$0.02    [ Q ] Qualify   [ R ] Reject     │
│ [ S ] Skip              [ O ] Open in LinkedIn           │
│                                                          │
│              ← previous · 46 remaining · next →          │
└─────────────────────────────────────────────────────────┘
```

Keyboard-driven, one decision per screen, evidence in view, progress always
visible. Bulk actions available for a filtered subset ("enrich all 41 missing a
country row").

Every REVIEW carries a **machine-readable reason code**, so the aggregate becomes
actionable: *"62% of REVIEWs are missing a country row"* is a roadmap item; an
undifferentiated 26% is not.

### 3.5 Publishing a rule change

Directly from the incident that motivated ADR-05.

```
┌─────────────────────────────────────────────────────────┐
│ Publish "HCM (HR gap)" v4?                               │
│                                                          │
│ headcount:  20–50   →   20–80                            │
│                                                          │
│ This will change 117 of 223 verdicts:                    │
│                                                          │
│   REJECTED → QUALIFIED     41    ▲ new leads             │
│   REVIEW   → QUALIFIED     14                            │
│   QUALIFIED → REJECTED      3    ▼ 2 have open deals ⚠   │
│   other transitions        59                            │
│                                                          │
│ Accounts losing QUALIFIED with open deals:               │
│   ISYS · James Cubitt MENA                               │
│                                                          │
│        [ Cancel ]   [ Preview all ]   [ Publish v4 ]     │
└─────────────────────────────────────────────────────────┘
```

Nobody else does this. It turns the single most dangerous admin action into the
most reassuring one.

**At scale it is an estimate, and must say so.** Re-evaluating 250k accounts to
preview a change is a batch job, not a dialog. Above a threshold the preview uses
stratified sampling and states its confidence:

> *estimated 1,180 ± 40 verdicts change · from a 5,000-account sample*

Accounts with open deals are always resolved exactly, never sampled — those are
the ones a human needs to see by name.

---

## 4. Tables

Where salespeople live. Everything here is a hard requirement.

| Behaviour | Detail |
|---|---|
| Sticky header | Plus sticky first column when horizontally scrolled |
| Column control | Resize, reorder, hide, pin — persisted per view, per user |
| Sort | Multi-column, only on fields flagged sortable |
| Inline edit | Single click to edit, Enter commits, Escape reverts, Tab advances |
| Selection | Click, shift-click range, select-all-matching-filter (not just page) |
| Bulk actions | Visible in a selection bar, not a hidden menu. Background job with progress. |
| Row count | Always shown: "1–50 of 2,431" — never infinite scroll |
| Keyboard | `j`/`k` to move, `x` to select, `Enter` to open, `e` to edit |
| Loading | Skeleton rows matching final layout and count — no layout shift |
| Density | User-selectable: comfortable / compact |

**Select-all-matching-filter is the one most often missed.** Selecting 2,431
records when only 50 are rendered is the difference between a toy and a tool.

---

## 5. Filters

Airtable-grade or it is not worth building.

- Nested AND/OR groups, visually indented
- Operators derived from field type — a date field offers "in the last N days",
  a select offers "is any of"
- Only fields flagged `filterable` appear, and the picker explains why others
  do not (see [05](05_DATABASE_DESIGN.md#7-indexing-strategy))
- Filters are shareable as URLs, saveable as views, and recent filters are recalled
- **Verdict is always a first-class filter** with three values, never two

---

## 6. States

Every screen designs five states, not one. This table is the review checklist.

| State | Requirement |
|---|---|
| **Loading** | Skeleton matching final layout. Never a centred spinner on a full page. |
| **Empty (new)** | Explain the object, show an example, offer the primary action. |
| **Empty (filtered)** | Name the filters causing it, offer to clear them. |
| **Error** | What failed, whether data was lost, what to do, how to retry. Never "something went wrong". |
| **Partial failure** | Bulk ops: "1,847 updated · 12 failed" with a downloadable report. |
| **Permission denied** | Say the record exists but is not visible, and who to ask. Silent omission breeds distrust. |
| **Offline** | Detect, show a persistent banner, queue nothing silently. |

---

## 6a. Undo — scoped honestly

§1 says "undo is better than *Are you sure?*". That is only true if undo is
designed, and undo after automations have fired is genuinely hard.

**What undo covers:** the user's own direct mutation, within a time window
(default 30 s for inline edits, 24 h for imports and bulk operations).

**What it does not cover:** downstream automation effects. If changing a deal
stage fired an automation that created a task and sent an email, undoing the
stage change does **not** unsend the email.

The UI must say so rather than implying a clean rollback:

> *Reverted stage to Qualified. 1 automation had already run — the task it
> created was not removed.* [ view ]

Actions that are genuinely irreversible — hard delete, sending, publishing a
rule, exporting — still confirm. "Undo over confirm" is a default, not a law.

## 6b. Concurrent editing

Two users on the same record is a daily occurrence and was unaddressed. Records
carry a version; a conflicting save shows **both values** and asks, rather than
silently taking the last write.

## 7. Keyboard and command palette

`⌘K` / `Ctrl-K` is the primary navigation surface, not a shortcut.

Global: `⌘K` palette · `/` search · `g` then `a/c/d/t` to navigate ·
`c` create · `?` shortcuts

The palette searches records, actions, views, settings and help in one ranked
list, with recents first. It should be possible to create an account, run a
qualification and open a deal without touching the mouse.

**Every action reachable by mouse is reachable by keyboard** (NFR-A11Y-002).

**Under RTL**, vertical shortcuts (`j`/`k`) are unchanged; horizontal ones follow
reading direction, so "next" is still physically forward for the reader.

## 7a. First run

Empty states are specified per screen. The first ten minutes of a brand-new
workspace were not — and that is where a second customer's evaluation is won or
lost.

A guided path to one real result: **import a file → run a qualification → see a
verdict with its evidence.** Sample data offered but skippable, because a
prospect wants to see *their* list qualified, not a demo account.

## 7b. Mobile

[01](01_PRODUCT_VISION.md) lists "no mobile app" as a v1 non-goal. That is
defensible but **not neutral** — field salespeople work from phones, and mobile
usage is a major retention driver for the incumbents. Recorded as a competitive
risk with a v2 commitment.

For v1, four tasks must be genuinely usable on a phone, not merely rendered:

1. Look up an account and see its verdict
2. Log an activity
3. Complete a task
4. Check today's list

Everything else may degrade to "works, awkwardly". Those four are the ones that
happen between meetings, and getting them wrong means the CRM does not get
updated at all.

**Connectivity.** Intermittent mobile data is the real Gulf field condition, not
clean offline. Mutations queue with a visible pending state and explicit retry,
short of full offline support.

---

## 8. RTL and Arabic

Not a later feature. A v1 constraint, because it cannot be retrofitted into a
component library cheaply.

| Rule | Detail |
|---|---|
| **Logical properties only** | `margin-inline-start`, `padding-inline-end`, `inset-inline`. No `left`/`right` in any component. CI-enforced by lint. |
| **Directional icons flip** | Arrows, chevrons, progress. Logos and brand marks do not. |
| **Bidirectional text** | Arabic names beside Latin URLs and numbers must render correctly. Use `dir="auto"` on user content, isolate with `bdi`. |
| **Numerals** | Configurable Western / Eastern Arabic. Always Western in exported CSV for tool compatibility. |
| **Sort and search** | Locale-aware collation. Naive `ORDER BY` puts Arabic in the wrong place. |
| **Dates** | Hijri displayable alongside Gregorian; workspace-configurable. |
| **Weekend** | Default Fri–Sat. Affects calendars, SLA maths, "due this week", reporting periods. |
| **Testing** | Every screen reviewed in both directions before merge. |

The live data already contains `BRTQ GROUP | المجموعة البرتقالية`. The product
mishandles it today only because there is no UI to mishandle it in yet.

---

## 9. Accessibility

WCAG 2.1 AA is the floor, not the goal.

- Semantic HTML first; ARIA only where semantics genuinely fall short
- Visible focus indicators, never `outline: none` without a replacement
- Focus trapped in modals, restored on close
- 4.5:1 contrast for text, 3:1 for UI boundaries — **in both themes**
- Status never conveyed by colour alone: verdicts carry an icon and a word
- Live regions announce async results
- Respect `prefers-reduced-motion`
- Full keyboard operability, tested without a mouse

Verdict colours specifically: green/amber/red is unreadable for the most common
form of colour blindness. `● QUALIFIED` / `◐ REVIEW` / `○ REJECTED` — shape and
word, with colour as reinforcement only.

---

## 10. Performance as a design constraint

Budgets are in [02](02_PRODUCT_REQUIREMENTS.md#performance). Design decisions
that keep them:

- Optimistic updates for every mutation, with visible rollback
- Virtualised rendering above 100 rows
- Debounced search, cancelled in-flight requests on new input
- Skeletons sized to real content to prevent layout shift
- Paginate, never infinite-scroll, on data tables
- Long operations become background jobs with progress, not blocked requests

**A design that requires more than one round trip to show a list is a design
problem, not a backend problem.**
