/**
 * The generic record endpoints.
 *
 * Every object gets list / read / create / update / delete / bulk / export from
 * this one file. There is no per-object handler, which is the point: a custom
 * field added by an admin is filterable, sortable, editable, exportable and
 * visible in the API the moment it exists, because nothing here knows what the
 * fields are.
 */
import {
    listRecords, countRecords, countRecordsBatch, getRecord, createRecord, updateRecord, deleteRecord, restoreRecord,
    purgeRecord, referencesTo, accountDependents, idsMatching, auditFor, hydrate,
} from '../lib/repo.mjs';
import { fieldsFor, objectDef, OBJECTS } from '../lib/objects.mjs';
import { EMPTY_FILTER } from '../lib/query.mjs';
import { readJson, badRequest, notFound, forbidden, sendBuffer } from '../lib/http.mjs';
import { require$, can, canWriteRecord, isConfined } from '../lib/auth.mjs';
import { addMembers } from '../lib/campaigns.mjs';
import { get, all, run, json, now, id, tx } from '../lib/db.mjs';
import { toCsvRows } from '../lib/csv.mjs';
import { audit } from '../lib/repo.mjs';

/** URL segment -> object key. */
export const ROUTES = {
    accounts: 'account',
    contacts: 'contact',
    deals: 'deal',
    tasks: 'task',
    activities: 'activity',
    notes: 'note',
    documents: 'document',
    proposals: 'proposal',
    agreements: 'agreement',
    campaigns: 'campaign',
    prospects: 'prospecting_company',
    prospecting_contacts: 'prospecting_contact',
};

export function objectFromRoute(route) {
    const key = ROUTES[route];
    if (!key) throw notFound(`No such object: ${route}`);
    return key;
}

/**
 * Turns URL query parameters into list options.
 *
 * A saved view supplies filter, sort and columns; anything passed explicitly
 * overrides it, so "open this view but sort by close date" is a URL, not a new
 * saved view.
 */
export function listOptions(url, ctx, objectKey) {
    const q = url.searchParams;
    const options = {
        page: Number(q.get('page')) || 1,
        limit: Number(q.get('limit')) || 50,
        q: q.get('q') || null,
        listId: q.get('list') || null,
        parentType: q.get('parent_type') || null,
        parentId: q.get('parent_id') || null,
        accountId: q.get('account_id') || null,
        dealId: q.get('deal_id') || null,
        // `deleted=1` includes deleted rows alongside live ones; `deleted=only`
        // is the trash view. They are different questions and the second one is
        // what makes a soft delete undoable.
        includeDeleted: q.get('deleted') === '1' || q.get('deleted') === 'only',
        onlyDeleted: q.get('deleted') === 'only',
    };

    let view = null;
    if (q.get('view')) {
        view = get('SELECT * FROM views WHERE id = ? AND workspace_id = ?', [q.get('view'), ctx.workspaceId]);
        if (!view) throw notFound('That view no longer exists.');
        options.filter = json(view.filter, EMPTY_FILTER);
        options.sort = json(view.sort, []);
        options.columns = json(view.columns, []);
        options.viewType = view.view_type;
        options.groupBy = view.group_by;
    }

    if (q.get('filter')) {
        try {
            options.filter = JSON.parse(q.get('filter'));
        } catch {
            throw badRequest('The filter parameter is not valid JSON.');
        }
    }
    if (q.get('sort')) {
        try {
            options.sort = JSON.parse(q.get('sort'));
        } catch {
            throw badRequest('The sort parameter is not valid JSON.');
        }
    }

    // "My" filters resolve here rather than being baked into a saved view, so a
    // shared view called "My open tasks" means each viewer's own tasks.
    options.filter = resolveMe(options.filter, ctx);
    if (objectKey === 'task' && q.get('mine') === '1') {
        options.filter = andWith(options.filter, { field: 'assignee_id', operator: 'is_any_of', value: [ctx.userId] });
    }
    return { options, view };
}

function resolveMe(filter, ctx) {
    if (!filter || typeof filter !== 'object') return filter;
    if (Array.isArray(filter.children)) {
        return { ...filter, children: filter.children.map((c) => resolveMe(c, ctx)) };
    }
    if (filter.value === '@me') return { ...filter, value: [ctx.userId] };
    if (Array.isArray(filter.value) && filter.value.includes('@me')) {
        return { ...filter, value: filter.value.map((v) => (v === '@me' ? ctx.userId : v)) };
    }
    return filter;
}

function andWith(filter, condition) {
    const base = filter ?? EMPTY_FILTER;
    return { op: 'and', children: [base, condition] };
}

/* ------------------------------------------------------------- handlers -- */

/**
 * The object a CONFINED role (SDR) may reach, and the column that scopes it.
 *
 * My Work reuses the generic record routes for the SDR's own tasks,
 * activities and notes — but every read is forced down to rows where they are
 * the assignee, actor or author. Any other object stays refused.
 */
const OWN_SCOPE_OBJECTS = {
    task: 'assignee_id',
    activity: 'actor_id',
    note: 'author_id',
};

function ownScopeObject(ctx, objectKey) {
    if (!isConfined(ctx)) return null;
    return OWN_SCOPE_OBJECTS[objectKey] ?? null;
}

/**
 * The same own-only scope for READS, for a role that is NOT confined — it
 * keeps `record.read.all` for accounts/contacts/deals, the shared sales book
 * every rep works, but a call logged on someone else's lead or a note filed
 * by a colleague is not the same kind of read as "which accounts exist".
 * Only activity and note are named: tasks stay visible team-wide (My Work's
 * "Everyone" toggle already exists for exactly that), and every other object
 * is untouched.
 *
 * Deliberately separate from `ownScopeObject`: that function ALSO decides
 * what a confined role may WRITE (a much narrower "status/body only" rule),
 * and a rep's write side is already governed normally by `record.write.own`
 * — routing rep through the same function here would have silently
 * re-applied that confined write restriction to a role that never held it.
 */
const ROLE_READ_OWN_SCOPE = {
    rep: { activity: 'actor_id', note: 'author_id' },
};

export function readOwnScopeObject(ctx, objectKey) {
    return ownScopeObject(ctx, objectKey) ?? ROLE_READ_OWN_SCOPE[ctx?.role]?.[objectKey] ?? null;
}

export async function list({ url, params, ctx }) {
    const objectKey = objectFromRoute(params.object);
    const { options, view } = listOptions(url, ctx, objectKey);

    // Confined role, or a role scoped to own reads on this object: force the
    // scope so no query can widen past their own rows.
    const scopeColumn = readOwnScopeObject(ctx, objectKey);
    if (scopeColumn) {
        options.filter = {
            op: 'and',
            children: [
                ...(options.filter ? [options.filter] : []),
                { field: scopeColumn, operator: 'is_any_of', value: [ctx.userId] },
            ],
        };
    }

    const result = listRecords(objectKey, ctx, options);
    return {
        ...result,
        object: objectKey,
        columns: options.columns ?? null,
        view: view ? { id: view.id, name: view.name, view_type: view.view_type, group_by: view.group_by } : null,
    };
}

/**
 * How many records each saved view of this object actually holds.
 *
 * The view tabs used to show `conditionCount` — how many CONDITIONS the filter
 * had. Every view with one rule read "1", which every user reads as "one
 * record". A number beside a tab name means "how many are in here" in every
 * product anyone has used; showing anything else there is not a smaller truth,
 * it is a wrong one.
 *
 * One indexed COUNT per view, in one request, with no rows fetched or hydrated.
 * Requested separately from the list so a slow count can never delay the table
 * itself — the tabs fill in a moment later.
 */
export async function viewCounts({ params, ctx }) {
    const objectKey = objectFromRoute(params.object);
    const views = all(
        'SELECT id, filter FROM views WHERE workspace_id = ? AND object_key = ?',
        [ctx.workspaceId, objectKey],
    );

    /**
     * One statement for the whole tab strip.
     *
     * This was a loop making one COUNT per view — five blocking round trips
     * before the tabs above a list could draw a number, on every list, on every
     * visit. A view whose filter no longer compiles still comes back null and
     * still does not take the others down with it; see `countRecordsBatch`.
     */
    const requests = views.map((view) => ({
        key: view.id,
        filter: json(view.filter, EMPTY_FILTER),
    }));
    requests.push({ key: 'deleted', onlyDeleted: true, includeDeleted: true });
    const counts = countRecordsBatch(objectKey, ctx, requests);
    return { object: objectKey, counts };
}

export async function read({ params, ctx }) {
    const objectKey = objectFromRoute(params.object);
    const record = getRecord(objectKey, ctx, params.id);
    // Same own-only scope as the list: reachable by id must not be a wider
    // door than reachable by search.
    const scopeColumn = readOwnScopeObject(ctx, objectKey);
    if (scopeColumn && record[scopeColumn] !== ctx.userId) {
        throw notFound(`That ${objectDef(objectKey).label.toLowerCase()} does not exist.`);
    }
    return { record, object: objectKey };
}

export async function create({ req, params, ctx }) {
    const objectKey = objectFromRoute(params.object);
    require$(ctx, can(ctx, 'record.write.all') ? 'record.write.all' : 'record.write.own');
    const body = await readJson(req);
    return { record: createRecord(objectKey, ctx, body), object: objectKey };
}

export async function patch({ req, params, ctx }) {
    const objectKey = objectFromRoute(params.object);
    const body = await readJson(req);

    /**
     * A confined role may update THEIR OWN tasks — ticking one done from My
     * Work is the whole point of the scope. The record is fetched first so the
     * ownership question is answered here rather than by a capability the
     * role deliberately does not hold; anything beyond a status change is
     * still refused.
     */
    const scopeColumn = ownScopeObject(ctx, objectKey);
    if (scopeColumn) {
        const existing = get(`SELECT * FROM ${objectDef(objectKey).table} WHERE id = ? AND workspace_id = ?`,
            [params.id, ctx.workspaceId]);
        if (!existing) throw notFound('That record does not exist.');
        if (existing[scopeColumn] !== ctx.userId) {
            throw forbidden('You can only change your own records.');
        }
        // Own-task editing is real editing: a rep renaming or re-dating their
        // own task is exactly what Edit means on My Work. Notes: the body.
        // Everything else stays read-only for a confined role.
        const allowed = objectKey === 'task'
            ? ['status', 'title', 'description', 'due_at', 'priority']
            : objectKey === 'note'
                ? ['body']
                : [];
        const attempted = Object.keys(body);
        if (attempted.some((k) => !allowed.includes(k))) {
            throw forbidden('Only ' + allowed.join(', ') + ' can be changed here.');
        }
        return { record: updateRecord(objectKey, ctx, params.id, body, { skipPermission: true }), object: objectKey };
    }

    return { record: updateRecord(objectKey, ctx, params.id, body), object: objectKey };
}

/**
 * Move to the trash — which is a capability, not just an ownership question.
 *
 * `deleteRecord` underneath checks that you may WRITE the record, and a rep may
 * write their own. That is not the same question as whether a rep may delete at
 * all, and the answer to the second is no: the roles were specified as a rep who
 * can add and edit but never remove. Without this line a rep could bin every
 * account they had created, which is most of the ones they touch.
 *
 * The comment on `purge` below already described `record.delete` as "the
 * capability to put something in the trash". It was true of the design and had
 * never been true of this function.
 */
export async function remove({ params, ctx }) {
    const objectKey = objectFromRoute(params.object);
    require$(ctx, 'record.delete');
    return deleteRecord(objectKey, ctx, params.id);
}

export async function restore({ params, ctx }) {
    const objectKey = objectFromRoute(params.object);
    return { record: restoreRecord(objectKey, ctx, params.id) };
}

/**
 * Permanent delete, from the trash only.
 *
 * `record.delete` on its own is the capability to put something in the trash,
 * which is reversible. Destroying it is not, so it additionally requires the
 * workspace-wide write capability — the same bar as editing somebody else's
 * records, because that is the blast radius.
 */
export async function purge({ params, ctx }) {
    const objectKey = objectFromRoute(params.object);
    require$(ctx, 'record.delete');
    require$(ctx, 'record.write.all');
    return purgeRecord(objectKey, ctx, params.id);
}

export async function history({ params, ctx }) {
    const objectKey = objectFromRoute(params.object);
    getRecord(objectKey, ctx, params.id, { includeDeleted: true });
    return { events: auditFor(ctx, { recordId: params.id }) };
}

/**
 * Bulk operations over a selection.
 *
 * ── THE SELECTION ───────────────────────────────────────────────────────────
 * Accepts `ids`, or `all: true` plus the current filter — which is what makes
 * "select all 2,431 matching" mean the 2,431, not the 50 on screen.
 *
 * ── PREVIEW BEFORE COMMITMENT ───────────────────────────────────────────────
 * `preview: true` runs no writes and answers three questions: how many records,
 * which of them this user cannot change, and what the change actually is. A
 * bulk edit is the single easiest way to damage a CRM — 2,000 records changed
 * by a filter that was one condition wider than the user thought — and the fix
 * for that is not a confirmation dialog, it is showing the consequence first.
 *
 * ── PARTIAL FAILURE IS REPORTED, NEVER SWALLOWED ────────────────────────────
 * Failures are collected per record rather than aborting the batch, because a
 * bulk assign that stops at record 12 of 500 with no report is worse than one
 * that finishes and names the 3 that failed.
 */
const BULK_ACTIONS = ['update', 'assign', 'delete', 'restore', 'purge', 'add_to_list', 'remove_from_list', 'add_to_campaign'];

/** Actions whose selection lives in the trash rather than the live list. */
const OVER_DELETED = new Set(['restore', 'purge']);

export async function bulk({ req, params, ctx }) {
    const objectKey = objectFromRoute(params.object);
    const body = await readJson(req);
    const action = body.action;
    if (!BULK_ACTIONS.includes(action)) {
        throw badRequest(`Unknown bulk action "${action}". Known actions: ${BULK_ACTIONS.join(', ')}.`);
    }

    let ids = Array.isArray(body.ids) ? body.ids : [];
    if (body.all) {
        const isDeletedAction = OVER_DELETED.has(action);
        const matched = idsMatching(objectKey, ctx, {
            filter: resolveMe(body.filter, ctx),
            listId: body.listId ?? null,
            q: body.q ?? null,
            parentId: body.parentId ?? null,
            parentType: body.parentType ?? null,
            accountId: body.accountId ?? null,
            dealId: body.dealId ?? null,
            // A restore or a permanent delete operates on deleted rows, so the
            // selection has to be able to see them. Every other action works on
            // live records.
            onlyDeleted: isDeletedAction,
            includeDeleted: isDeletedAction,
        });
        ids = matched.ids;
    }
    if (!ids.length) throw badRequest('Nothing was selected.');
    if (ids.length > 20000) throw badRequest(`That is ${ids.length} records. Narrow the selection — this limit exists so a mis-set filter cannot rewrite the database in one click.`);

    // Deleting in bulk is deleting. The single-record route asks the same
    // question one row at a time, and a permission that twenty thousand rows
    // can walk around is not a permission.
    if (action === 'delete') require$(ctx, 'record.delete');
    if (action === 'purge') {
        require$(ctx, 'record.delete');
        require$(ctx, 'record.write.all');
    }

    if (body.preview) return previewBulk(objectKey, ctx, ids, action, body);

    const results = { requested: ids.length, succeeded: 0, failed: [], action };

    tx(() => {
        for (const recordId of ids) {
            try {
                if (action === 'delete') deleteRecord(objectKey, ctx, recordId);
                else if (action === 'restore') restoreRecord(objectKey, ctx, recordId);
                else if (action === 'purge') purgeRecord(objectKey, ctx, recordId);
                else if (action === 'assign') {
                    // A task is assigned to an ASSIGNEE; every other record with
                    // ownership is owned. Mapping by object means the same bulk
                    // action works on the tasks list and the accounts list.
                    const assignField = objectKey === 'task' ? 'assignee_id' : 'owner_id';
                    updateRecord(objectKey, ctx, recordId, { [assignField]: body.ownerId ?? body.assigneeId ?? null });
                }
                else if (action === 'update') updateRecord(objectKey, ctx, recordId, normaliseValues(body.values));
                else if (action === 'add_to_list') addToList(ctx, body.listId, recordId);
                else if (action === 'remove_from_list') removeFromList(ctx, body.listId, recordId);
                results.succeeded += 1;
            } catch (err) {
                results.failed.push({ id: recordId, error: err.message });
            }
        }
    });

    // Campaign membership is one statement over the whole selection rather than
    // a loop, because it is idempotent by construction and has its own report.
    if (action === 'add_to_campaign') {
        const outcome = addMembers(ctx, body.campaignId, objectKey === 'account' ? 'account' : 'contact', ids);
        results.succeeded = outcome.added + outcome.readded;
        results.campaign = outcome;
    }

    audit(ctx, {
        objectKey,
        recordId: null,
        action: `bulk_${action}`,
        after: {
            requested: results.requested,
            succeeded: results.succeeded,
            failed: results.failed.length,
            // The fields a bulk edit touched are part of the audit record. "800
            // records updated" without saying what changed is not an audit trail.
            ...(action === 'update' ? { fields: Object.keys(normaliseValues(body.values)) } : {}),
            ...(action === 'assign' ? { ownerId: body.ownerId } : {}),
        },
    });
    return results;
}

/**
 * A dry run.
 *
 * Reports the count, a sample of what will be hit, and — the part that actually
 * prevents accidents — the records the caller has no permission to change. A
 * rep bulk-editing 500 accounts of which they own 12 should learn that here,
 * not from 488 lines in a failure report.
 */
function previewBulk(objectKey, ctx, ids, action, body) {
    const def = objectDef(objectKey);
    const sample = all(
        `SELECT * FROM ${def.table} WHERE id IN (${ids.slice(0, 200).map(() => '?').join(',')})`,
        ids.slice(0, 200),
    );

    let blocked = [];
    if (['update', 'assign', 'delete', 'purge'].includes(action)) {
        // Editing in bulk asks the same question as editing one at a time, so
        // it has to get the same answer — the object key is what makes a shared
        // record shared. Removal passes no key, so ownership still governs it.
        const editing = action === 'update' || action === 'assign';
        blocked = sample.filter((row) => !canWriteRecord(ctx, row, editing ? objectKey : null))
            .map((row) => ({ id: row.id, name: row[def.titleField] ?? row.id }));
    }

    /**
     * For a permanent delete, the preview answers the only question that
     * matters: which of these will REFUSE, and why. For accounts, dependent
     * records will be safely cascade-deleted with a warning confirmation.
     */
    let referenced = [];
    let dependents = [];
    let dependentWarning = null;

    if (action === 'purge') {
        if (objectKey === 'account') {
            for (const row of sample) {
                const deps = accountDependents(row.id, ctx.workspaceId);
                if (deps.total > 0) {
                    dependents.push({
                        id: row.id,
                        title: row[def.titleField] ?? row.name ?? row.id,
                        items: deps.items,
                        total: deps.total,
                    });
                }
            }
            if (dependents.length > 0) {
                dependentWarning = 'This account has related data including deals, proposals, documents, tasks, and other records. Permanently deleting this account will also permanently delete its associated data. This action cannot be undone. Are you sure you want to continue?';
            }
        } else {
            referenced = sample.map((row) => ({ id: row.id, title: row[def.titleField] ?? row.id, blockers: referencesTo(def.table, row.id) }))
                .filter((r) => r.blockers.length)
                .slice(0, 20);
        }
    }

    const values = action === 'update' ? normaliseValues(body.values) : {};
    const fields = fieldsFor(objectKey, ctx.workspaceId);
    const changes = Object.entries(values).map(([key, value]) => {
        const field = fields.find((f) => f.key === key) ?? { label: key, type: 'text' };
        // How many rows actually differ. "800 selected, 12 will change" is the
        // difference between a bulk edit and a bulk no-op that still writes 800
        // audit events.
        const differing = sample.filter((row) => String(row[key] ?? '') !== String(value ?? '')).length;
        return {
            key, label: field.label, value,
            clearing: value === null || value === '',
            differingInSample: differing,
        };
    });

    // Hydrated, so the sample shows "Sara Nour" rather than `con_nH2X…`. A
    // contact's title field is `full_name`, which is derived, not stored.
    const shown = hydrate(objectKey, sample.slice(0, 8), ctx);

    return {
        preview: true,
        action,
        requested: ids.length,
        sampled: sample.length,
        sample: shown.map((row) => ({ id: row.id, title: row[def.titleField] ?? row.name ?? row.id })),
        blocked,
        blockedCount: blocked.length,
        changes,
        dependents,
        dependentWarning,
        referenced,
        irreversible: action === 'purge',
        note: blocked.length
            ? `${blocked.length} of the records you can see are owned by someone else. Your role can only change your own, so those will be reported as failures.`
            : (referenced.length
                ? `${referenced.length} of them still have other records pointing at them and will be refused, not destroyed.`
                : null),
    };
}

/**
 * `null` means CLEAR THE FIELD, and it has to survive JSON.
 *
 * An empty string from a form input and a deliberate "empty this field" are the
 * same intent here, but `undefined` is not: it means the caller never mentioned
 * the field, and mentioning nothing must never blank a column.
 */
function normaliseValues(values) {
    const out = {};
    for (const [key, value] of Object.entries(values ?? {})) {
        if (value === undefined) continue;
        out[key] = value;
    }
    if (!Object.keys(out).length) throw badRequest('No values were supplied, so there is nothing to change.');
    return out;
}

function addToList(ctx, listId, recordId) {
    const list = get('SELECT * FROM lists WHERE id = ? AND workspace_id = ?', [listId, ctx.workspaceId]);
    if (!list) throw notFound('That list does not exist.');
    if (list.kind !== 'static') throw badRequest('That list is dynamic — it is a saved filter, so records join it by matching.');
    run('INSERT OR IGNORE INTO list_members (list_id, record_id, added_at, added_by) VALUES (?,?,?,?)',
        [listId, recordId, now(), ctx.userId]);
}

function removeFromList(ctx, listId, recordId) {
    const list = get('SELECT * FROM lists WHERE id = ? AND workspace_id = ?', [listId, ctx.workspaceId]);
    if (!list) throw notFound('That list does not exist.');
    if (list.kind !== 'static') throw badRequest('That list is dynamic. Records leave it by no longer matching its filter.');
    run('DELETE FROM list_members WHERE list_id = ? AND record_id = ?', [listId, recordId]);
}

/**
 * CSV export.
 *
 * A separate capability from read, and always audited. Reading one record on
 * screen and walking out with the whole database are different acts.
 */
export async function exportCsv({ url, params, ctx, res }) {
    const objectKey = objectFromRoute(params.object);
    require$(ctx, 'export');

    const { options } = listOptions(url, ctx, objectKey);
    const fields = fieldsFor(objectKey, ctx.workspaceId);

    /**
     * `all=1` exports every field the object has, custom fields included.
     *
     * The default is still the columns on screen, because "export what I am
     * looking at" is the common case. But it must not be the ONLY case: the
     * list shows a handful of `listDefault` columns, so a plain export silently
     * dropped most of the record — including everything collected by
     * enrichment and qualification. An export that quietly omits the data is
     * worse than no export, because the gap is only discovered downstream.
     */
    const everything = url.searchParams.get('all') === '1';
    const wanted = everything
        ? fields.map((f) => f.key)
        : (options.columns?.length ? options.columns : fields.filter((x) => x.listDefault).map((x) => x.key));
    const columns = wanted.map((key) => fields.find((f) => f.key === key)).filter(Boolean);

    const rows = [];
    let page = 1;
    for (;;) {
        const chunk = listRecords(objectKey, ctx, { ...options, page, limit: 200 });
        rows.push(...chunk.records);
        if (page >= chunk.pages || rows.length >= 100000) break;
        page += 1;
    }

    const body = await toCsvRows(columns, rows, (row, column) => cellValue(row, column));

    audit(ctx, {
        objectKey,
        recordId: null,
        action: 'exported',
        after: { rows: rows.length, columns: columns.map((c) => c.key) },
    });

    const filename = `${objectDef(objectKey).plural} ${new Date().toISOString().slice(0, 10)}.csv`;
    sendBuffer(res, 200, Buffer.from(body, 'utf8'), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
    });
    return undefined;
}

export function cellValue(row, column) {
    if (column.custom) return row.properties?.[column.property] ?? '';
    if (column.key === 'owner_id') return row.owner_name ?? '';
    if (column.key === 'assignee_id') return row.assignee_name ?? '';
    if (column.key === 'actor_id') return row.actor_name ?? '';
    if (column.key === 'author_id') return row.author_name ?? '';
    if (column.key === 'account_id') return row.account_name ?? '';
    if (column.key === 'deal_id') return row.deal_name ?? '';
    if (column.key === 'stage_id') return row.stage_label ?? '';
    const value = row[column.key];
    if (Array.isArray(value)) return value.join('; ');
    if (value === null || value === undefined) return '';
    return value;
}

/**
 * The values a field is ALREADY using in this workspace, most used first.
 *
 * Free-text fields like Data source are where a vocabulary emerges by use
 * rather than by configuration. Hardcoding that list in the app is how an
 * import ends up rejected for saying something true but unlisted; leaving it
 * as a bare text box is how the same source acquires four spellings. Offering
 * what the workspace already says — plus the freedom to type something new —
 * avoids both, and needs no admin to maintain it.
 */
export async function fieldValues({ url, params, ctx }) {
    const objectKey = objectFromRoute(params.object);
    const fieldKey = url.searchParams.get('field');
    const field = fieldsFor(objectKey, ctx.workspaceId).find((f) => f.key === fieldKey);
    if (!field) throw notFound(`No such field: ${fieldKey}`);

    const table = objectDef(objectKey).table;
    // Both identifiers come from the field registry, never from the URL, so
    // they are an allowlist rather than interpolated user input.
    const expression = field.custom ? "json_extract(properties, '$.' || ?)" : field.key;
    const args = field.custom ? [field.property, ctx.workspaceId] : [ctx.workspaceId];

    const rows = all(
        `SELECT ${expression} AS value, COUNT(*) AS n
           FROM ${table}
          WHERE workspace_id = ? AND deleted_at IS NULL
          GROUP BY value
         HAVING value IS NOT NULL AND TRIM(value) <> ''
          ORDER BY n DESC, value ASC
          LIMIT 50`,
        args,
    );

    return { field: field.key, values: rows.map((r) => ({ value: String(r.value), count: r.n })) };
}

/* ---------------------------------------------------------- attachments -- */

/**
 * Everything hanging off one record: its activities, tasks, notes, documents,
 * and — for an account — its contacts, deals, proposals and agreements too.
 *
 * One request instead of six, because the record page needs all of it and six
 * round trips on a phone is a visibly slower page.
 */
/**
 * What hangs off a record, and how much of it comes back at once.
 *
 * ONE definition, read by the record page's first load and by "Load more"
 * alike. That is the point of it being a table rather than a run of calls: page
 * two has to be sorted and scoped exactly as page one was, and the surest way
 * for it not to be is to write the rules down twice.
 *
 * The limits stay. They are what stops opening one account from hydrating
 * fourteen hundred contacts, and `listRecords` caps everything at 200 besides.
 * What changes is that a limit no longer hides: `related` returns the true
 * count next to the rows, and the client asks for the rest when the reader
 * wants it.
 */
const RELATED_ATTACHED = {
    tasks: { object: 'task', limit: 100, sort: [{ field: 'due_at', direction: 'asc' }] },
    notes: { object: 'note', limit: 100, sort: [{ field: 'created_at', direction: 'desc' }] },
    documents: { object: 'document', limit: 100, sort: [{ field: 'created_at', direction: 'desc' }] },
};

const RELATED_SPECS = {
    account: {
        contacts: { object: 'contact', limit: 200, by: 'accountId', sort: [{ field: 'last_name', direction: 'asc' }] },
        deals: { object: 'deal', limit: 100, by: 'accountId', sort: [{ field: 'updated_at', direction: 'desc' }] },
        proposals: { object: 'proposal', limit: 50, by: 'accountId' },
        agreements: { object: 'agreement', limit: 50, by: 'accountId' },
        // Attachments logged against the account's CHILDREN roll up here — an
        // activity on a deal belongs on the account's timeline — so these are
        // scoped by account rather than by parent.
        tasks: { ...RELATED_ATTACHED.tasks, by: 'accountId' },
        notes: { ...RELATED_ATTACHED.notes, by: 'accountId' },
        documents: { ...RELATED_ATTACHED.documents, by: 'accountId' },
    },
    deal: {
        ...RELATED_ATTACHED,
        proposals: { object: 'proposal', limit: 50, by: 'dealId' },
        agreements: { object: 'agreement', limit: 50, by: 'dealId' },
    },
};

function relatedSpecs(objectKey) {
    return RELATED_SPECS[objectKey] ?? RELATED_ATTACHED;
}

/** One spec plus a page number, as `listRecords` wants it. */
function relatedOptions(spec, objectKey, recordId, page) {
    const scope = spec.by
        ? { [spec.by]: recordId }
        : { parentType: objectKey, parentId: recordId };
    return { ...scope, limit: spec.limit, sort: spec.sort, page: Math.max(1, Number(page) || 1) };
}

/**
 * The next page of ONE related list.
 *
 * Exists so "Load more" cannot drift from the first load: same spec, same sort,
 * same page size, one page along. A client that reconstructed the query itself
 * would eventually sort page two differently and show a row twice while hiding
 * another — the kind of bug nobody reports because it looks like bad data.
 */
export async function relatedPage({ params, url, ctx }) {
    const objectKey = objectFromRoute(params.object);
    getRecord(objectKey, ctx, params.id);          // 404s and permission-checks the parent

    const spec = relatedSpecs(objectKey)[params.child];
    if (!spec) {
        throw notFound(`"${params.child}" is not a related list on a ${objectKey}.`);
    }

    const page = Number(url.searchParams.get('page')) || 1;
    const result = listRecords(spec.object, ctx, relatedOptions(spec, objectKey, params.id, page));
    return {
        child: params.child,
        records: result.records,
        total: result.total,
        page: result.page,
        pages: result.pages,
    };
}

export async function related({ params, ctx }) {
    const objectKey = objectFromRoute(params.object);
    const record = getRecord(objectKey, ctx, params.id);
    const out = {};

    /**
     * How many there ACTUALLY are, beside how many were sent.
     *
     * Every call below is capped, and the caps were invisible: an account with
     * 1,400 contacts returned 200 of them and said nothing, so the tab read
     * "200" and the page presented a truncation as the whole truth. Nothing
     * errored and nothing looked wrong, which is what made it bad.
     *
     * `listRecords` already runs a COUNT on every call and returns it — the
     * numbers below were being computed and thrown away. This keeps them, so
     * the client can say "200 of 1,400" and offer the rest.
     *
     * Kept as a SIBLING map rather than by wrapping each list in
     * `{records, total}`: a dozen places read these as plain arrays, and a
     * shape change buys nothing the client cannot get from here.
     */
    const counts = {};
    for (const [key, spec] of Object.entries(relatedSpecs(objectKey))) {
        const result = listRecords(spec.object, ctx, relatedOptions(spec, objectKey, params.id, 1));
        out[key] = result.records;
        counts[key] = result.total;
    }

    /**
     * The commercial registration, on the record it is a fact about.
     *
     * It is captured while generating a contract and stored per ACCOUNT, which
     * was right — and then never shown on the account, which meant the
     * representative and the address existed only inside whichever document
     * happened to quote them. Two of the fields have account columns and are
     * synced there; these are the other two, and this is where they become
     * visible.
     */
    if (objectKey === 'account') {
        out.registration = get(
            'SELECT * FROM commercial_registrations WHERE workspace_id = ? AND account_id = ?',
            [ctx.workspaceId, params.id],
        ) ?? null;
        /**
         * An Internal Team Proposal built from a LINE-ITEM source (no docx
         * template behind it — see `fromLineItemSource`, lib/internal-
         * proposal.mjs) never gets a row in `documents`: it has no file, it
         * is rendered on request from `proposal_versions.content`, the same
         * as any other line-item proposal. So it is a real, openable
         * record that the generic `documents` relation above can never see
         * — the account's Documents tab read 0 while one sat one click
         * away on its Agreement page. Counted and linked here rather than
         * forced into the documents table as a row with no file behind it,
         * which would just move the lie into "Download" 404ing instead.
         */
        out.looseInternalProposals = all(
            `SELECT id, number, title, created_at FROM proposals
              WHERE workspace_id = ? AND account_id = ? AND type = 'internal_team'
                AND document_type IS NULL AND deleted_at IS NULL
              ORDER BY created_at DESC`,
            [ctx.workspaceId, params.id],
        );
        counts.documents = (counts.documents ?? out.documents?.length ?? 0) + out.looseInternalProposals.length;
    }

    if (objectKey === 'deal') {
        out.contacts = all(
            `SELECT c.*, dc.role AS deal_role FROM deal_contacts dc
               JOIN contacts c ON c.id = dc.contact_id
              WHERE dc.deal_id = ?`,
            [params.id],
        ).map((c) => ({ ...c, full_name: `${c.first_name} ${c.last_name}`.trim(), roles: json(c.roles, []) }));
        // A deal's contacts come from the join table unpaged, so the count is
        // simply how many there are. Stated rather than left undefined, so the
        // client never has to guess which lists carry a total.
        counts.contacts = out.contacts.length;
    }

    return { record, object: objectKey, related: out, counts };
}

export async function batchDelete({ req, params, ctx }) {
    const objectKey = objectFromRoute(params.object);
    const body = await readJson(req);
    const action = body.action || 'delete';
    if (!['delete', 'purge'].includes(action)) {
        throw badRequest(`Unknown batch delete action "${action}".`);
    }

    let ids = Array.isArray(body.ids) ? body.ids : [];
    if (body.all) {
        const isDeletedAction = OVER_DELETED.has(action);
        const matched = idsMatching(objectKey, ctx, {
            filter: resolveMe(body.filter, ctx),
            listId: body.listId ?? null,
            q: body.q ?? null,
            parentId: body.parentId ?? null,
            parentType: body.parentType ?? null,
            accountId: body.accountId ?? null,
            dealId: body.dealId ?? null,
            onlyDeleted: isDeletedAction,
            includeDeleted: isDeletedAction,
        });
        ids = matched.ids;
    }
    if (!ids.length) throw badRequest('Nothing was selected.');
    if (ids.length > 20000) throw badRequest(`That is ${ids.length} records. Narrow the selection.`);

    if (action === 'delete') require$(ctx, 'record.delete');
    if (action === 'purge') {
        require$(ctx, 'record.delete');
        require$(ctx, 'record.write.all');
    }

    const results = { requested: ids.length, succeeded: 0, failed: [], action };

    tx(() => {
        for (const recordId of ids) {
            try {
                if (action === 'delete') deleteRecord(objectKey, ctx, recordId);
                else if (action === 'purge') purgeRecord(objectKey, ctx, recordId);
                results.succeeded += 1;
            } catch (err) {
                results.failed.push({ id: recordId, error: err.message });
            }
        }
    });

    audit(ctx, {
        objectKey,
        recordId: null,
        action: `batch_${action}`,
        after: {
            requested: results.requested,
            succeeded: results.succeeded,
            failed: results.failed.length,
        },
    });

    return results;
}
