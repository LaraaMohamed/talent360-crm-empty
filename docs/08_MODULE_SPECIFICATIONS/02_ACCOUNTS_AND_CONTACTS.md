# Accounts & Contacts

**Status:** Planned · **Phase:** 2 · **Depends on:** platform, prospecting

---

## 1. Purpose

The record of who exists. Organisations and the people in them, from first
import to churned customer, with one identity per real-world entity.

**Not responsible for:** judging companies (prospecting), commercial value
(deals), or communication history (activities).

---

## 2. Domain concepts

`Account`, `Contact`, `Lifecycle Stage`. See [03_DOMAIN_MODEL.md §3](../03_DOMAIN_MODEL.md).

The decision that makes this module work: **prospects are accounts at an early
lifecycle stage, not a separate object** ([ADR-10](../04_SYSTEM_ARCHITECTURE.md#decision-register)).
Uploading 2,000 companies does not create 2,000 things to manage — it creates
2,000 prospects, hidden from default views until a verdict promotes them.

```
prospect ──► qualified ──► engaged ──► customer ──► churned
    │             │
    └─────────────┴──────► disqualified
```

| Stage | Set by | Visible by default |
|---|---|---|
| `prospect` | Import or discovery | No |
| `qualified` | A rule returning QUALIFIED | Yes |
| `engaged` | First open deal | Yes |
| `customer` | First signed agreement | Yes |
| `churned` | No active agreement after expiry | Filtered |
| `disqualified` | Rule rejection or manual | No |

Transitions are automation rules, not hardcoded logic — so a workspace that
sells differently can define its own.

---

## 3. Configuration surface

Custom fields on both objects · lifecycle stages and their transitions ·
duplicate-match rules and thresholds · contact role flags · required fields per
stage · assignment rules · industry and other picklists.

---

## 4. Behaviour

### Identity and deduplication

Every record carries `external_id`, so re-importing a source is a no-op rather
than a duplicate (FR-REC-004). Beyond that, configurable match rules with
confidence scores:

| Matcher | Confidence | Note |
|---|---|---|
| Commercial Registration | Exact = certain | **First-class for Saudi entities** — the strongest natural key available here |
| Domain | Exact = high | Beware shared hosts and group domains |
| LinkedIn slug | Exact = high | Already the identity used by the qualification engine |
| Name + country | Fuzzy = medium | Requires review; never auto-merges |
| Contact email | Exact = certain | For contacts |

Duplicates are **surfaced for decision**, not silently merged, unless confidence
is `certain` and the workspace has opted in.

### Merge

First-class and **reversible** (FR-REC-007). A merge must define, per related
object, what happens:

| Related | On merge |
|---|---|
| Contacts | Move to survivor; deduplicate by email |
| Deals | Move to survivor; never merged with each other |
| Activities & tasks | Move to survivor; timeline preserves original timestamps |
| Documents | Move to survivor |
| Verdicts | **Re-point, not merge.** Two evidence trails remain distinct and both readable |
| Field conflicts | User chooses per field; the choice is audited |

Reversibility matters because merges are done under time pressure on incomplete
information, and an irreversible merge of two large accounts is unrecoverable.

### Personal data

Contacts carry obligations that companies do not (FR-REC-005, 010, 011):
`data_source`, `acquired_at`, `lawful_basis`. Soft delete by default; hard delete
is a job that must also reach evidence snapshots, exports, caches and generated
documents. Subject erasure locates a person across every object.

---

## 5. Interfaces

**Offers:** CRUD, search, merge, unmerge, bulk assign, lifecycle transition,
duplicate check, subject erasure.

**Emits:** `account.created/updated/merged/deleted`, `account.lifecycle_changed`,
`account.owner_changed`, `contact.*`.

**Consumes:** `verdict.computed` (promote to qualified or disqualified),
`deal.created` (→ engaged), `agreement.signed` (→ customer).

---

## 6. UI surfaces

Account list (table/kanban by lifecycle) · account detail with timeline, deals,
contacts, documents, **verdict panel** · contact list and detail · merge
comparison · duplicate review queue · bulk assignment.

The account detail page is the product's most-visited screen. The verdict panel
belongs **above** the fold — it is why the account is in the system.

---

## 7. Edge cases

| Case | Behaviour |
|---|---|
| Account with no domain and no LinkedIn | Allowed; not collectable — verdict `UNRESOLVED` |
| Two accounts merged, both with open deals | Both deals move; neither is merged; owner notified |
| Merge undone after edits | Restores the split; edits since the merge are attributed and preserved |
| Contact at two companies | One contact per account. A person at two firms is two contacts, linked by email. |
| Contact leaves | Contact is marked inactive, never deleted — history stays intact |
| Company renamed or rebranded | Name history retained; verdicts still resolve by slug/CR |
| Arabic legal name and English trading name | Both stored; both searchable; display name configurable |
| Deleted account with signed agreement | Hard delete blocked; explain why |

---

## 8. Acceptance criteria

- [ ] Re-importing the same file creates no duplicates (FR-REC-004)
- [ ] Prospects are excluded from default views (FR-REC-001)
- [ ] Merge is reversible with a full audit trail (FR-REC-007)
- [ ] Merging re-points verdicts and keeps both evidence trails readable
- [ ] Commercial Registration works as a match rule (FR-REC-006)
- [ ] Hard delete reaches evidence snapshots and exports (FR-REC-008)
- [ ] Every contact records `data_source`, `acquired_at`, `lawful_basis` (FR-REC-005, 010)
- [ ] A custom field created by an admin appears in list, detail, filter, import and API with no code change
- [ ] Lifecycle transitions on verdict are configurable, not hardcoded
