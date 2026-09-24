# Permission Model

**Status:** Draft v0.1 · **Owner:** Architecture · **Last reviewed:** 2026-08-03

---

## 1. The hard problem

Standard CRM permissions are a solved problem. This product has one twist that
is not:

> **Field-level permissions over fields that did not exist when the role was
> written.**

An admin creates "Candidate Salary Expectation" on Monday. Who can see it? Every
role in the workspace was defined before the field existed. Get the default
wrong and you have leaked salary data to the whole company; get it wrong the
other way and every new field is invisible until someone edits six roles.

**The answer:** a field definition carries its own default visibility; roles
*override* per field, never enumerate. New fields inherit the object's baseline,
so creating a field is never accidentally a data leak (FR-SEC-003).

---

## 2. Three layers

```
1. ACTION    Can this principal perform this verb at all?
                deal.update · account.export · automation.publish
             → Role-based (RBAC)

2. RECORD    On which records?
                own · team · workspace
             → Attribute-based (ABAC), per object

3. FIELD     Which fields on those records?
                visible · editable · hidden
             → Explicit grants, defaulting from the field definition
```

All three must pass. **Deny overrides allow. No implicit inheritance**
(FR-SEC-005) — permission systems with inheritance become unauditable within a
year, because nobody can answer "why can Sara see this?" without tracing a tree.

---

## 3. Actions

Roles are workspace metadata: a name and a set of action permissions
(FR-SEC-001). Actions are granular and named for what they do.

```
account.read / create / update / delete / merge / export
deal.read / create / update / delete / change_stage / reopen
qualification.run / rule_edit / rule_publish / verdict_override
automation.read / create / publish
import.run / undo
settings.fields / settings.pipelines / settings.roles / settings.integrations
audit.read
```

### Actions that deserve their own permission

| Action | Why separate |
|---|---|
| **`export`** | Reading one record and exporting 40,000 are different risks (FR-SEC-004). This is the most commonly missed distinction, and the most commonly regretted. |
| **`rule_publish`** | Changing a qualification rule can flip hundreds of verdicts. Editing a draft and publishing it are different privileges. |
| **`verdict_override`** | Overrides are ICP training data. Who can create them matters. |
| **`merge`** | Merging is destructive-adjacent and hard to reason about, even though it is reversible. |
| **`automation.publish`** | A published automation acts on everyone's data. |
| **`audit.read`** | Seeing who did what is itself sensitive. |

### Seeded roles

Ship in the template pack, fully editable:

| Role | Shape |
|---|---|
| Owner | Everything, including billing. Cannot be deleted; at least one must exist. |
| Admin | Everything except billing |
| Manager | Team-scoped records, full deal and export rights, no settings |
| Sales | Own records, no export, no settings, no rule publishing |
| Analyst | Workspace-wide read, export, reports. No writes. |
| Read-only | Workspace-wide read. Nothing else. |

---

## 4. Record scope

Per object, per role:

| Scope | Meaning |
|---|---|
| `own` | Records where the principal is owner |
| `team` | Records owned by anyone on their team(s) |
| `team_and_below` | Their team plus every team beneath it in the hierarchy |
| `workspace` | All records in the workspace |
| `none` | No access to the object |

Scopes can differ per object — a common shape is "own deals, workspace accounts",
because reps need to see who the firm already works with without seeing each
other's numbers.

### Team hierarchy

Flat teams do not describe a real sales organisation. A manager must see their
reports' records, and a director must see the managers'. Teams therefore form a
tree, and `team_and_below` rolls up it.

Without this, the only way to give a manager visibility is `workspace` scope,
which gives them everyone's — including peers they should not see. That is the
most common permission compromise in SMB CRMs, and it is avoidable.

### Record-level sharing

Scopes are rules; real work has exceptions. A rep needs one colleague on one
deal for one week.

- A record can be shared explicitly with a user or a team
- Share grants `read` or `read+write`, never ownership
- Shares are audited and can carry an expiry
- A share can only grant what the sharer holds — sharing never escalates
- Shares are visible on the record, so nobody wonders why a name appears

### Prospect visibility

Un-qualified prospects are usually workspace-visible even where deals are `own` —
the point of a shared prospecting pool is that it is shared. Configurable, not
assumed.

**Prospects deserve a note.** Un-qualified prospects are usually workspace-visible
even where deals are `own` — the whole point of a shared prospecting pool is that
it is shared. This is configurable, not assumed.

---

## 5. Field-level permissions

The layer that makes this model non-trivial.

### Field definition default

Every field definition carries `default_visibility`:

| Value | Meaning |
|---|---|
| `all` | Everyone who can read the record |
| `restricted` | Only roles explicitly granted |
| `owner_only` | Record owner and above |

The **object baseline** determines what a newly created field gets if the admin
does not choose. Default `all` for most objects; workspaces handling sensitive
data can set the baseline to `restricted` so new fields are private by default.

### Role overrides

A role may override per field: `visible`, `editable`, or `hidden`. Overrides are
sparse — roles list only exceptions, never every field. Otherwise creating a
field would require editing every role, which is exactly the failure this design
avoids.

### Enforcement everywhere

A hidden field is hidden in **every** surface, or the model is theatre:

| Surface | Behaviour |
|---|---|
| Record detail | Absent, not blank |
| List columns | Not offered in the column picker |
| Filters | Not offered — filtering on a hidden field infers its value |
| Search | Not searched, not matched |
| **Export** | Absent from the file |
| **API** | Key absent from the response — not null, so "hidden" and "empty" stay distinct |
| **Import** | Not writable |
| **Automation** | A rule cannot read or write it beyond its author's rights |
| **Webhooks** | Absent from payloads |
| Reports | Not aggregatable |

Filters and search are the two most commonly forgotten. Being able to filter
`salary > 500000` and count the results leaks the data without ever displaying it.

### Cost of enforcement

Stripping hidden fields on every read path — responses, exports, search, filters,
webhooks — is real work, and asserting it is correct is not the same as making it
affordable.

**The permission set resolves once per request into a cached field mask**, and
projection happens at the serialisation boundary in **one place**, not scattered
across handlers. Scattering it is how a leak eventually appears in the one
handler nobody updated.

Search is the hard case: permission tags are applied **inside** the query, not by
filtering results afterwards, because post-filtering breaks pagination and leaks
counts. See [05 §7](05_DATABASE_DESIGN.md).

Field-mask resolution is benchmarked as part of the reference load model
([16 §1](16_SCALABILITY_AND_OPERATIONS.md)).

---

## 6. Special principals

| Principal | Rule |
|---|---|
| **API key** | Runs under a workspace-scoped principal with a role. **No admin bypass, ever** — a key that outranks the permission system is how isolation gets breached. |
| **Automation** | Runs under its author's effective permissions. An automation cannot escalate privilege. |
| **Import** | Runs under the importing user. Cannot write fields they cannot see. |
| **System** | Internal maintenance only. Never triggered by user input, never exposed. |
| **Support access** | Time-boxed, explicitly granted by the workspace, fully audited, and visibly indicated in the UI while active. |

---

## 7. Tenant isolation

Permissions operate **inside** a workspace. Isolation *between* workspaces is a
separate, stronger guarantee and is not a permission check:

- `workspace_id` on every tenant-scoped table
- Row-level security in the database, not application discipline
  ([05 §2](05_DATABASE_DESIGN.md))
- The repository layer scopes explicitly as well — RLS is the safety net, because
  "we always remember" is a claim about human behaviour across years
- **CI tests attempt cross-workspace access and assert failure** (NFR-SEC-003)

A user with multiple memberships has entirely independent permissions in each.
Permissions belong to the *membership*, never the user.

---

## 8. Audit

Immutable, complete, separate from the activity timeline
([ADR-07](04_SYSTEM_ARCHITECTURE.md#decision-register)).

Recorded: actor, timestamp, object, before, after, source (UI / API / automation
/ import), request ID.

Always audited, even when routine:

- Every record mutation
- **Every export**, with row count and columns — the most valuable audit line
  when something leaks
- Permission and role changes
- Field visibility changes
- Integration credential changes
- Automation publishes
- Rule publishes and verdict overrides
- Logins, failures, and support access

No `UPDATE` or `DELETE` grant on the audit table is issued to the application
role. Not policy — a database permission.

---

## 9. Edge cases

| Case | Behaviour |
|---|---|
| New field created | Inherits the object baseline; never leaks by default |
| Field visibility narrowed | Takes effect immediately, including in cached views and saved filters referencing it |
| User's role changed mid-session | Re-evaluated on next request; no stale grants |
| Record ownership transferred | Old owner loses access immediately under `own` scope |
| User in two teams | Union of team scopes |
| Deactivated user | Loses access immediately; their records and automations persist |
| Automation authored by a user later demoted | Rule stops performing actions beyond their new rights, and surfaces as failing rather than silently skipping |
| Shared view containing hidden columns | Columns absent for viewers lacking access; the view still loads |
| Export containing hidden fields | Columns absent; the export summary states how many were withheld |
| Mention of a user without record access | Blocked with explanation — mentions must not leak record content |
| Last Owner attempts self-demotion | Blocked; a workspace must always have one Owner |
| Verdict on a record the user cannot see | Not returned; counts state "n hidden by permissions" rather than silently under-reporting |

That last one matters more than it looks: silently returning 41 of 67 qualified
accounts, with no indication that 26 were withheld, teaches users the numbers are
unreliable.

---

## 10. Acceptance criteria

- [ ] Roles are metadata; a new role needs no code (FR-SEC-001)
- [ ] Record scope is configurable per object per role (FR-SEC-002)
- [ ] A newly created field inherits the object baseline and never leaks (FR-SEC-003)
- [ ] Hidden fields are absent from detail, lists, **filters**, **search**, exports, API, webhooks and reports (FR-SEC-003)
- [ ] Export is a separate permission from read (FR-SEC-004)
- [ ] Deny overrides allow; no implicit inheritance (FR-SEC-005)
- [ ] API keys have no admin bypass
- [ ] Automations cannot escalate their author's privileges
- [ ] Imports cannot write fields the importer cannot see
- [ ] Every mutation and every export is audited (FR-SEC-006, 007)
- [ ] Audit records cannot be modified by the application role
- [ ] CI tests prove cross-workspace access fails (NFR-SEC-003)
- [ ] Permission-filtered counts state what was withheld
