# Views, Lists & Dashboards

**Status:** Planned · **Phase:** 3 (views) · 6 (dashboards) · **Depends on:** platform

---

## 1. Purpose

Let every user shape the same data into the view that suits their job, without
an administrator or an engineer.

This module is the most visible proof that the platform is metadata-driven. If
adding a field requires touching a view component, the promise is already broken.

---

## 2. Domain concepts

**View** — a saved combination of object, view type, filters, sort, visible
columns and layout. Private or shared.

**List** — a named, static or dynamic set of records. Static lists are curated
manually; dynamic lists are a saved filter that re-evaluates.

**Dashboard** — a saved arrangement of widgets.

**Widget** — a metadata-defined visualisation bound to a query.

---

## 3. Configuration surface

View definitions per object · default views per role · which fields are
filterable/sortable/searchable (the index budget) · widget types · dashboard
layouts · sharing scope.

Widget types are **metadata**, so adding "verdict distribution by industry"
requires no schema change (FR-VIEW-007).

---

## 4. Behaviour

### Views

- Unlimited per object; private by default, shareable to a team or workspace
- Types: table, kanban, list, calendar, timeline, cards (FR-VIEW-002)
- Nested AND/OR filter groups over system and custom fields (FR-VIEW-003)
- Operators derive from field type — a date offers "in the last N days", a
  select offers "is any of". One mapping, shared with import and API.
- Only fields flagged `filterable` appear in the builder, and the picker
  **explains why others do not**. A silent omission looks like a bug; a stated
  constraint is a design.
- Views are URL-addressable, so a filtered list can be pasted into a message

### Tables

Full requirements in [06 §4](../06_UI_UX_GUIDELINES.md). The one most often
missed:

> **Select-all-matching-filter**, not just select-all-on-page. Selecting 2,431
> records when 50 are rendered is the difference between a tool and a toy.

Bulk operations over a selection run as background jobs with progress and
partial-failure reporting (FR-VIEW-005).

### Dashboards

- Widget-based, drag-and-drop, resizable, saveable, shareable (FR-VIEW-006)
- Widgets respect the viewer's permissions — two users see different numbers on
  the same dashboard, correctly
- Every widget states its date range and last-refreshed time. An unlabelled
  number on a dashboard is a rumour.

### Reporting rules that are not optional

- **One-time and recurring revenue are never summed** (FR-VIEW-009). Any widget
  showing "pipeline value" must state which it means.
- **Verdict breakdowns always show three values.** A chart with QUALIFIED and
  REJECTED and no REVIEW is a lie by omission — REVIEW is often the largest
  bucket (58 of 223 for HCM, 60 for offshoring in current data).
- Counts of stale verdicts are surfaced, not hidden in an average

---

## 5. Interfaces

**Offers:** CRUD views, execute view query, save/share, bulk action dispatch,
dashboard CRUD, widget data queries, export.

**Emits:** `view.created/shared`, `export.performed` (always audited — export is
a distinct permission, FR-SEC-004).

**Consumes:** field definitions, permissions, record data from every module.

---

## 6. UI surfaces

View switcher · filter builder · column manager · saved view list · kanban board
· calendar · dashboard grid · widget library · widget configuration · export
dialog.

---

## 7. Edge cases

| Case | Behaviour |
|---|---|
| View referencing a deprecated field | Field shown greyed with an explanation; view still loads |
| View referencing a deleted field | Blocked at deletion time (FR-PLAT-004) — this case should be unreachable |
| Shared view whose owner is deactivated | Ownership transfers to a workspace admin |
| Filter returning 500,000 rows | Paginated; export becomes a background job |
| Kanban with 10,000 cards in one column | Column virtualised and capped with "showing 100 of 8,431" |
| Widget query timing out | Widget shows an error state with retry; the dashboard still renders |
| User lacking access to some records in a view | Excluded silently from lists, but counts state "12 hidden by permissions" |
| Dashboard shared across roles | Each viewer's numbers reflect their own permissions |
| Sorting an Arabic text column | Locale-aware collation, not byte order |
| Calendar view under a Fri–Sat weekend | Weekend rendered correctly per workspace config |
| Export of 100,000 rows | Background job, emailed or downloadable link, audited |

---

## 8. Acceptance criteria

- [ ] A user creates a saved view with nested AND/OR filters and no admin help (FR-VIEW-001, 003)
- [ ] A custom field appears in the filter builder with type-appropriate operators, no code change
- [ ] Non-filterable fields are absent from the builder **with an explanation**
- [ ] Select-all-matching-filter selects beyond the rendered page (FR-VIEW-004)
- [ ] Bulk operations run as jobs with progress and partial-failure reports (FR-VIEW-005)
- [ ] Verdict breakdowns show all three verdicts (FR-QUAL-001)
- [ ] No widget sums one-time and recurring revenue (FR-VIEW-009)
- [ ] Dashboard widgets respect per-viewer permissions
- [ ] Every widget states its date range and refresh time
- [ ] List view p95 under 500 ms at 100k records with two custom-field filters (NFR-PERF-001)
- [ ] Exports are audited and permission-gated separately from read (FR-SEC-004)
