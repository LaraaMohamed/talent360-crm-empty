# Design System

**Status:** Draft v0.1 · **Owner:** Design · **Last reviewed:** 2026-08-03

Tokens, components and patterns. Principles are in [06](06_UI_UX_GUIDELINES.md).

Values below are a **starting specification**, not a finished palette. They are
here so the first component has something to reference instead of inventing one.

---

## 1. Rules that outrank taste

1. **Tokens only.** No raw hex, pixel or millisecond values in a component. If a
   token does not exist, add one — do not inline.
2. **Logical properties only.** `margin-inline-start`, never `margin-left`.
   Lint-enforced. This is what makes RTL possible.
3. **Both themes, always.** Every token has a light and dark value. A component
   is not done until it has been seen in both.
4. **Semantic naming.** `--color-danger`, not `--color-red`. The red may change;
   the meaning will not.
5. **Contrast is a constraint, not a review note.** 4.5:1 text, 3:1 boundaries,
   verified in CI where possible.

---

## 2. Colour

Semantic tokens map onto a small primitive palette. Components only ever
reference the semantic layer.

```
--color-bg-canvas        page background
--color-bg-surface       cards, panels, table rows
--color-bg-raised        modals, popovers, dropdowns
--color-bg-sunken        wells, code blocks, inset areas
--color-bg-hover         row and control hover
--color-bg-selected      selected row, active nav

--color-fg-primary       body text
--color-fg-secondary     labels, metadata
--color-fg-tertiary      placeholders, disabled
--color-fg-on-accent     text on accent fills

--color-border-subtle    table row dividers
--color-border-default   inputs, cards
--color-border-strong    focus, active

--color-accent           primary actions, links, active nav
--color-success          won, qualified, healthy
--color-warning          review, stale, at risk
--color-danger           lost, rejected, destructive
--color-info             neutral system messaging
```

### Verdict colours

The product's signature semantic. Independent tokens, because these must never
drift with a general palette change.

| Verdict | Token | Shape | Meaning |
|---|---|---|---|
| QUALIFIED | `--color-verdict-qualified` | `●` filled | Evidence proves the rule is met |
| REVIEW | `--color-verdict-review` | `◐` half | **Evidence cannot answer** |
| REJECTED | `--color-verdict-rejected` | `○` hollow | Evidence proves the rule is not met |
| UNRESOLVED | `--color-verdict-unresolved` | `◌` dotted | No identity to collect against |
| ERROR | `--color-verdict-error` | `⊘` | Collection failed |

**Shape and word always accompany colour.** Green/amber/red alone is unreadable
for the most common colour blindness, and this is the one distinction in the
product a user cannot afford to misread.

REVIEW is amber, not grey. Grey reads as "ignore me", and the entire argument
for the three-verdict model is that REVIEW deserves attention.

---

## 3. Typography

```
--font-sans     system stack, with an Arabic-capable fallback
--font-mono     tabular data, IDs, code

--text-xs    12px / 16    labels, table metadata
--text-sm    13px / 20    table body, secondary — the workhorse
--text-base  14px / 22    body, form inputs
--text-lg    16px / 24    section headings
--text-xl    20px / 28    page titles
--text-2xl   24px / 32    dashboard figures

--weight-normal 400 · --weight-medium 500 · --weight-semibold 600
```

**14px base, 13px in tables.** Sales tools are read for hours at a time in dense
grids; 16px body is a marketing-site default that wastes a third of the row
budget.

**Numbers use tabular figures** (`font-variant-numeric: tabular-nums`) in every
table, metric and currency display, so digits align down a column.

**Arabic needs its own line-height.** Arabic script has taller ascenders and
deeper descenders; the Latin line-height crowds it. The Arabic font stack
carries a multiplier.

---

## 4. Space, radius, elevation, motion

```
--space-1  4px    --space-2  8px    --space-3 12px   --space-4 16px
--space-5 24px    --space-6 32px    --space-8 48px   --space-10 64px

--radius-sm  4px   inputs, badges
--radius-md  6px   buttons, cards
--radius-lg  8px   modals, panels
--radius-full      pills, avatars

--shadow-sm   subtle lift: cards
--shadow-md   dropdowns, popovers
--shadow-lg   modals
--shadow-none flat surfaces — the default

--duration-instant  100ms  hover, focus
--duration-fast     150ms  dropdowns, tooltips
--duration-normal   200ms  modals, drawers
--ease-out    cubic-bezier(0.16, 1, 0.3, 1)
```

4px base grid. Everything is a multiple.

**Shadows are for elevation, not decoration.** A table row has no shadow. A
dropdown floating above it does. Overusing shadow is the fastest way to look
dated.

**Nothing exceeds 200 ms.** Above that, an interface feels like it is thinking.
All motion respects `prefers-reduced-motion`.

---

## 5. Component inventory

Marked by phase. Everything supports light/dark, RTL, keyboard and disabled.

### Primitives — Phase 1
Button (primary / secondary / ghost / danger, + loading, + icon) · Icon Button ·
Input · Textarea · Select · Combobox · Multi-select · Checkbox · Radio · Switch ·
Date picker (Gregorian/Hijri) · Badge · Avatar · Tooltip · Spinner · Skeleton ·
Divider · Kbd

### Layout — Phase 1
App shell · Sidebar · Page header · Card · Panel · Tabs · Split view · Scroll area

### Overlays — Phase 1
Modal · Drawer · Popover · Dropdown menu · Context menu · Toast · Command palette

### Data — Phase 2
**Data table** (sticky header, resize, reorder, pin, hide, sort, inline edit,
selection, virtualised) · Filter builder · View switcher · Pagination ·
Empty state · Error state · Bulk action bar

### Domain — Phase 3+
**Verdict badge** · **Evidence card** · **Rule editor** · **Impact preview** ·
Pipeline board · Deal card · Timeline · Activity item · Task item ·
Line item editor · Currency input · Import wizard · Mapping table ·
Dashboard grid · Widget frame · Provider cost preview

The domain components are where this product's identity lives. The primitives
should be unremarkable; the verdict badge and evidence card should be excellent.

---

## 6. Key domain components

### Verdict badge

```
● QUALIFIED        ◐ REVIEW        ○ REJECTED
```

Sizes: inline (table cell), default (record header), large (verdict panel).

Always carries: shape, word, colour. Optionally: rule name, age.
**Stale verdicts** (past the workspace threshold) render with reduced emphasis
and a clock affordance — a two-year-old QUALIFIED must not look like a fresh one.

### Evidence card

Renders any evidence snapshot: provider, collection date, the raw observation,
and which parts the rule used. Collapsible, with the used parts highlighted.

This component is the product's proof of honesty. It should be as polished as
anything in the app.

### Impact preview

Used before publishing any metadata change that alters existing records.
Transition counts, the dangerous transitions called out, and affected records
with open deals surfaced by name. See [06 §3.4](06_UI_UX_GUIDELINES.md).

### Provider cost preview

`~$4.80 · 240 companies · ~26 min` with a budget-remaining bar. Shown before
execution, never after.

---

## 7. Iconography

One set, outline, 1.5px stroke, 16/20/24px. Directional icons flip under RTL;
brand marks do not.

Domain icons are **assigned in metadata**, not hardcoded — activity types,
service lines and stages each carry an icon key, so a workspace can add "Site
Visit" with its own icon and no code change.

---

## 8. Forms

- Labels above inputs. Placeholders are examples, never labels.
- Validate on blur, not on keystroke. Re-validate on change once an error exists.
- Errors sit beneath the field, in words: "Enter a work email" not "Invalid".
- Required marked on the label; optional fields say so when most are required.
- **Auto-save on record detail** with a visible saved/saving indicator.
  **Explicit submit in wizards and modals.** Never mix the two.
- Field controls are chosen by the field definition's type — one mapping,
  used by forms, filters, import mapping and the API.

---

## 9. Theming

Light and dark via CSS custom properties on the root. Dark is not inverted
light: surfaces get lighter with elevation, saturation is reduced, pure black
and pure white are both avoided.

Theme follows the OS by default with an explicit override. Workspace branding
may set the accent colour only — never the semantic or verdict tokens, because
a customer must not be able to make REJECTED look like QUALIFIED.

---

## 10. Definition of done

A component ships when all of these hold:

- [ ] Tokens only — no raw values
- [ ] Logical properties only — no `left`/`right`
- [ ] Light and dark verified
- [ ] LTR and RTL verified
- [ ] Keyboard operable, focus visible and managed
- [ ] Contrast verified in both themes
- [ ] Loading, empty, error and disabled states exist
- [ ] Screen-reader labels present, announced correctly
- [ ] Respects `prefers-reduced-motion`
- [ ] Documented with usage and misuse examples
