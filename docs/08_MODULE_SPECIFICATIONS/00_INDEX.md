# Module Specifications

One spec per module. Each states what the module owns, what it exposes, what it
consumes, and how you know it works.

| # | Module | Status | Phase |
|---|---|---|---|
| [01](01_PROSPECTING_AND_QUALIFICATION.md) | **Prospecting & Qualification** | **Exists — in production use** | 0–2 |
| [02](02_ACCOUNTS_AND_CONTACTS.md) | Accounts & Contacts | Planned | 2 |
| [03](03_DEALS_AND_PIPELINE.md) | Deals & Pipeline | Planned | 4 |
| [04](04_ACTIVITIES_TASKS_TIMELINE.md) | Activities, Tasks & Timeline | Planned | 3 |
| [05](05_PROPOSALS_AND_AGREEMENTS.md) | Proposals & Agreements | Planned | 5 |
| [06](06_IMPORT_ENGINE.md) | Import Engine | **Partially exists** | 2 |
| [07](07_VIEWS_LISTS_DASHBOARDS.md) | Views, Lists & Dashboards | Planned | 3, 6 |

Cross-cutting concerns have their own documents:
[09 API](../09_API_ARCHITECTURE.md) ·
[10 Automation](../10_AUTOMATION_ENGINE.md) ·
[11 Integrations](../11_INTEGRATIONS.md) ·
[12 Permissions](../12_PERMISSION_MODEL.md)

---

## Spec template

Every module spec follows this structure. Copy it for new modules.

```markdown
# <Module Name>

**Status** · **Owner** · **Phase** · **Depends on**

## 1. Purpose
What job this module does, in two sentences. What it is NOT responsible for.

## 2. Current state
For brownfield modules: what exists, where, and what must not regress.

## 3. Domain concepts
The entities this module owns. Link to 03_DOMAIN_MODEL.md rather than restating.

## 4. Configuration surface
What an admin can change without code. This is the module's real product.

## 5. Behaviour
The rules. Especially the non-obvious ones and the reasons behind them.

## 6. Interfaces
Public interface offered · events emitted · events consumed · provider
capabilities required.

## 7. UI surfaces
Screens and components. Link to 06/07 rather than restating.

## 8. Edge cases
Named, with the required behaviour. Not hypothetical — from real data where possible.

## 9. Acceptance criteria
Checkable statements. Each maps to a requirement ID.

## 10. Out of scope
What this module deliberately does not do, and which module does it instead.
```

## Conventions

- **Requirement IDs** from [02_PRODUCT_REQUIREMENTS.md](../02_PRODUCT_REQUIREMENTS.md)
  are referenced, never restated. If a spec needs a requirement that does not
  exist, add it there first.
- **⚑ marks preservation requirements** — behaviour that works today and must
  not regress.
- No file paths, class names or function signatures. Specs describe behaviour.
