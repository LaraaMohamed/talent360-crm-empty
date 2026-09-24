# Deals & Pipeline

**Status:** Planned · **Phase:** 4 · **Depends on:** platform, records, automation

---

## 1. Purpose

Track commercial opportunities from qualified account to signed agreement, and
forecast revenue **correctly** for a business that sells four structurally
different things.

**Not responsible for:** documents (proposals/agreements), qualification, or
delivery.

---

## 2. The correction that defines this module

The brief gives a Deal a single `Estimated Value`. That cannot represent this
business:

| Service | Pricing | Recurrence |
|---|---|---|
| Recruitment | % of first-year salary × placements | one-time |
| HCM | per seat × months | recurring |
| Offshoring | per headcount × months, often ramping | recurring |
| Strategy & Performance | fixed fee, milestone-billed | one-time |

A single decimal cannot express *"3 placements at 15% plus 40 seats at 120
SAR/month for 24 months"*. Forecasting, quota and pipeline value all become
guesses — and every deal entered before the fix needs manual repair.

**Therefore: Deal Line Items, from the start.** The deal has no amount column.

### Derived values, never conflated

| Figure | Definition |
|---|---|
| One-time value | Σ non-recurring line totals |
| MRR | Σ recurring line monthly totals |
| ARR | MRR × 12 |
| Total contract value | one-time + (MRR × term) |
| Weighted pipeline | one-time × stage probability |

**Recurring and one-time revenue are never summed into one headline number**
(FR-DEAL-005). A dashboard adding a placement fee to 24 months of retainer is
not reporting — it is fiction, and it is the single most common CRM reporting
error in service businesses.

---

## 3. Configuration surface

Pipelines and their stages · stage probability, type, required fields, WIP limit
· pricing models · service lines · loss reasons · currencies · custom fields ·
assignment rules · stage-transition permissions.

Multiple pipelines per workspace: recruitment and managed services genuinely
have different shapes, and forcing them into one is why consultancies abandon
generic CRMs.

---

## 4. Behaviour

- A deal belongs to one account, one pipeline, one stage.
- Stage carries a default probability; a deal may override with a reason.
- Entering a stage may require fields to be populated (FR-DEAL-007) — this is
  how data quality is enforced without nagging.
- Closing as lost requires a reason from a configurable list (FR-DEAL-008).
  Loss reasons are the second-most valuable ICP signal after verdict overrides.
- Stage duration is tracked for cycle-time and bottleneck reporting.
- Money is always an amount **plus a currency**. FX rate is captured at close and
  stored on the record, so last year's closed revenue does not move when the
  exchange rate does (FR-DEAL-006).
- A deal links to the verdict(s) that originated it (FR-DEAL-010) — closing the
  loop from ICP to revenue, which is what makes the qualification engine
  measurable rather than merely interesting.

---

## 5. Interfaces

**Offers:** CRUD, stage transition, line item management, forecast queries,
pipeline metrics.

**Emits:** `deal.created/updated/won/lost`, `deal.stage_changed`,
`deal.owner_changed`, `deal.value_changed`.

**Consumes:** `verdict.computed` (optionally auto-create a seeded deal),
`agreement.signed` (→ won), `account.merged` (re-point).

---

## 6. UI surfaces

Kanban board (drag between stages, WIP limits, collapsed columns) · deal table ·
deal detail with line items, timeline, tasks, proposals · line item editor with
live derived totals · forecast view separating one-time from recurring ·
pipeline funnel and velocity reports.

The **line item editor** is the module's signature component. It must make a
mixed one-time/recurring deal legible at a glance, with the derived figures
updating live and clearly labelled.

---

## 7. Edge cases

| Case | Behaviour |
|---|---|
| Deal with no line items | Allowed while early-stage; a stage can require at least one |
| Line items in different currencies | Each converts to base at current rate for display; rate frozen at close |
| Deal moved backwards | Allowed, audited; stage duration records both visits |
| Deal reopened after close | New stage history entry; original close preserved |
| Recurring line with no term | Treated as 12 months for TCV, flagged in reports |
| Deal won with zero value | Allowed — pilots and pro-bono exist; flagged in reporting |
| Pipeline deleted with open deals | Blocked; deals must be moved first |
| Stage removed from a pipeline | Blocked while occupied; deprecate instead |
| Account merged, both had deals | Both deals survive on the survivor; never auto-merged |
| Probability override without reason | Blocked if the workspace requires reasons |

---

## 8. Acceptance criteria

- [ ] A deal carries multiple line items with different pricing models and currencies (FR-DEAL-003)
- [ ] Deal value is derived, never stored as a single amount (FR-DEAL-005)
- [ ] One-time and recurring revenue are never summed in any view, report or export (FR-DEAL-005)
- [ ] MRR, ARR, one-time and weighted values are separately reportable
- [ ] FX rate is frozen at close and historical revenue does not move (FR-DEAL-006)
- [ ] Multiple pipelines with independent stages exist (FR-DEAL-001)
- [ ] Loss requires a reason (FR-DEAL-008)
- [ ] Stage transitions can require fields and be role-restricted (FR-DEAL-007)
- [ ] A deal traces back to the verdict that originated it (FR-DEAL-010)
- [ ] Adding a fifth service line with a new pricing model requires no code change
