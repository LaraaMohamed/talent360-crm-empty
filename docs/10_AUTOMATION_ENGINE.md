# Automation Engine

**Status:** Draft v0.1 · **Owner:** Architecture · **Last reviewed:** 2026-08-03

---

## 1. Why this is not Phase 9

The brief places the Automation Engine in Phase 9. But Phases 5–8 describe
behaviour that *is* automation:

- stage change → create a task
- proposal sent → log an activity
- renewal date → raise a reminder
- verdict QUALIFIED → promote the account, create a deal
- agreement signed → move deal to won, account to customer

If the engine arrives last, that logic is hand-coded eight times first, then has
to be unpicked. Every one of those hardcoded paths is a violation of the
product's central promise.

**Therefore, split it:**

| Part | Phase | Scope |
|---|---|---|
| **Event bus** | 1 | Domain mutations emit typed events. No UI. |
| **Internal rules** | 3 | Seeded rules for lifecycle transitions, defined as data |
| **Rule builder UI** | 7 | Users author their own automations |

Phases 3–6 then *use* the engine through seeded configuration rather than
bypassing it. The rules exist as data from the start; only the editor is late.

---

## 2. Model

```
TRIGGER          when something happens
   ↓
CONDITIONS       and these are true
   ↓
ACTIONS          then do these
```

A rule is metadata: key, name, trigger, conditions, ordered actions, enabled
flag, version (FR-AUTO-001).

### Triggers

| Trigger | Fires on |
|---|---|
| `record.created` | New record of an object |
| `record.updated` | Any change |
| `field.changed` | A specific field changes, optionally from/to specific values |
| `stage.changed` | Deal stage transition |
| `verdict.computed` | Qualification produced a verdict |
| `verdict.changed` | A verdict differs from its predecessor |
| `date.reached` | A date field arrives, with an offset ("7 days before expiry") |
| `schedule` | Cron-like |
| `webhook.received` | Inbound HTTP |
| `manual` | User-invoked from a record or a bulk selection |

`date.reached` with a **negative offset** is what makes renewal notice periods
work — the reminder fires against the notice date, not the expiry date.

### Conditions

Same filter grammar as views ([08/07](08_MODULE_SPECIFICATIONS/07_VIEWS_LISTS_DASHBOARDS.md)) —
nested AND/OR over system and custom fields, with operators derived from field
type. One grammar, three uses: views, automations, API search. Users learn it
once.

### Actions

| Action | Notes |
|---|---|
| Create record | Any object, with field mapping |
| Update record | Trigger record or a related one |
| Create task | Assignee may be a role, an owner, or a rule |
| Log activity | Typed by workspace activity type |
| Send notification | Respects per-user channel preferences |
| Send email | Templated, through a provider |
| Call webhook | Signed, retried |
| Run qualification | Against the trigger record |
| Assign owner | Round-robin, load-balanced, or by rule |
| Change lifecycle stage | The mechanism behind prospect → qualified → customer |
| Wait | Duration or until a date, then continue |

Actions run **in order**, and a failure stops the chain by default with the
partial state recorded. Continue-on-error is opt-in per action.

---

## 3. Safety

Automation engines fail in exactly three ways. All three are designed against.

### Loops

Rule A updates a field; rule B triggers on that field and updates another; rule
A triggers again.

| Guard | Default |
|---|---|
| Execution depth limit | 5 |
| Per-record executions per rule per hour | 10 |
| Cycle detection at publish time | Static analysis of trigger/action graph |
| Automation-originated changes flagged | Rules can opt out of self-triggering |

The last one matters most: by default, a change made *by* an automation does not
re-trigger the same automation.

### Silent failure

**Prohibited** (FR-AUTO-008). A failed automation surfaces to an admin. A rule
that fails repeatedly is auto-disabled with notification — a broken rule that
keeps half-firing is worse than one that stops.

Every execution is logged: trigger, conditions evaluated with their results,
actions attempted, errors, duration (FR-AUTO-006). "Why didn't my automation
run?" must be answerable from the UI, and the answer is usually "condition 3
was false" — which the log shows.

### Unintended blast radius

**Dry run is mandatory before publish** (FR-AUTO-005). It shows what *would*
happen across the current data without side effects — the same pattern as the
qualification impact preview, for the same reason.

A rule triggering on `record.updated` for all accounts, published without a dry
run, can generate 50,000 tasks in a minute.

---

## 4. Execution

Asynchronous, queued, per-workspace concurrency limits so one tenant's rule
storm cannot degrade another's page loads.

```
Domain mutation → event → matching rules → job per rule execution
```

Ordering is guaranteed per record, not globally. Two rules on the same record run
in rule-priority order; rules on different records may interleave.

**Idempotency:** actions are designed so that re-execution after a retry does not
duplicate. Creating a task carries a deterministic key derived from the trigger
event, so a retry updates rather than duplicates.

---

## 5. References and lifecycle

Automations reference metadata by **stable `key`**, never UUID or label
(FR-AUTO-007). Renaming a stage's label does not break a rule; the key never
changes.

Deleting metadata that a rule references is **blocked**, with the referring rules
named (FR-PLAT-004). This is the single most common cause of mysterious
automation failure in other products, and it is entirely preventable.

Rules are versioned. An execution log entry records which version ran, so
"it worked last week" is checkable.

---

## 6. Seeded automations

Ship in the template pack, visible and editable — **not hidden platform
behaviour**. This is the difference between a configurable product and one that
merely claims to be.

| Seeded rule | Trigger → action |
|---|---|
| Promote on qualify | `verdict.computed` = QUALIFIED → lifecycle `qualified` |
| Disqualify | `verdict.computed` = REJECTED → lifecycle `disqualified` |
| Engage on deal | `deal.created` → lifecycle `engaged` |
| Customer on signature | `agreement.signed` → lifecycle `customer`, deal won |
| Renewal notice | `date.reached` notice date → task for owner |
| Stale verdict | `schedule` daily → flag verdicts past threshold |
| Deal idle | `schedule` daily → task if no activity in N days |
| Welcome task | `account.lifecycle_changed` → qualified → research task |

A workspace that works differently edits or deletes them. None of this logic
exists in application code.

---

## 7. UI surfaces

Rule list with enabled state, last run and failure count · rule builder (trigger,
condition tree, action sequence) · **dry-run preview** · execution log with
filtering · per-record automation history · a workspace-level "recent automation
activity" feed.

The execution log is the most important screen. Automation is trusted only when
it is inspectable.

---

## 8. Edge cases

| Case | Behaviour |
|---|---|
| Rule triggers itself | Blocked by default; explicit opt-in required |
| Two rules update the same field | Priority order; both logged; last write wins and says so |
| Rule references a deprecated field | Publish blocked, referrer named |
| Rule enabled while 10,000 records already match | Applies to future events only unless explicitly backfilled — backfill is a separate, previewed job |
| Wait action, record deleted meanwhile | Execution cancelled, logged |
| Wait crossing a weekend | Working-day maths uses the workspace weekend |
| Provider unavailable during a send action | Retried with backoff; failure surfaces after final attempt |
| Rule authored by a deactivated user | Continues running; ownership transfers to admin |
| Automation writing a field the author cannot see | Blocked — automations do not escalate privilege |
| Rule storm from a bulk import | Import-originated events are batched and rate-limited |

---

## 9. Acceptance criteria

- [ ] Every domain mutation emits a typed event (FR-PLAT-014)
- [ ] Lifecycle transitions are seeded rules, not code (FR-AUTO-001)
- [ ] Dry run shows exact effects with no side effects (FR-AUTO-005)
- [ ] Loop protection stops runaway chains (FR-AUTO-004)
- [ ] Every execution is logged with conditions and results (FR-AUTO-006)
- [ ] Failed automations surface to an admin; none fail silently (FR-AUTO-008)
- [ ] Rules reference metadata by key, and renaming a label breaks nothing (FR-AUTO-007)
- [ ] Deleting referenced metadata is blocked with the referrers named
- [ ] An automation cannot write a field its author cannot see
- [ ] Enabling a rule does not retroactively fire on existing records without an explicit, previewed backfill
