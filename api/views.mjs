/**
 * Views and lists.
 *
 *   VIEW  a saved way of LOOKING at an object — filters, sort, columns, layout.
 *   LIST  a named SET of records: static (curated by hand) or dynamic (a saved
 *         filter that re-evaluates, so records join and leave on their own).
 *
 * They are separate because they answer different questions. "Accounts I want
 * to see this way" is a view; "the 40 companies in the Q3 outreach push" is a
 * list, and it is a thing you hand to someone.
 */
import { all, get, run, id, now, json } from '../lib/db.mjs';
import { listRecords, idsMatching, audit } from '../lib/repo.mjs';
import { objectFromRoute } from './records.mjs';
import { fieldsFor, objectDef, operatorsFor, OPERATOR_LABELS } from '../lib/objects.mjs';
import { countConditions, EMPTY_FILTER } from '../lib/query.mjs';
import { readJson, badRequest, notFound, forbidden } from '../lib/http.mjs';
import { require$, can } from '../lib/auth.mjs';

/* ------------------------------------------------------------------ views -- */

export async function listViews({ url, ctx }) {
    const objectKey = url.searchParams.get('object');
    const rows = all(
        `SELECT * FROM views
          WHERE workspace_id = ? ${objectKey ? 'AND object_key = ?' : ''}
            AND (scope = 'workspace' OR owner_id = ? OR owner_id IS NULL)
          ORDER BY object_key, position, name`,
        objectKey ? [ctx.workspaceId, objectKey, ctx.userId] : [ctx.workspaceId, ctx.userId],
    );
    /**
     * A view this role cannot RUN is not offered.
     *
     * The seeded qualification views were removed from Accounts, but anybody
     * can build one — and a view filtering on `verdict_hcm` is unrunnable for a
     * rep, because the verdict fields are not sent to a role without
     * `prospecting.read` and hydration strips the values. The tab would appear,
     * report no count, and open an empty list, which reads as missing data
     * rather than as a permission.
     *
     * Filtered on what the FILTER names rather than on the object, so this
     * covers a view on any object that reaches into the qualification plane.
     */
    const runnable = can(ctx, 'prospecting.read')
        ? rows
        : rows.filter((row) => !VERDICT_FILTER.test(row.filter ?? ''));

    /**
     * And a qualification view has no place on Accounts or Contacts AT ALL.
     *
     * "HCM — qualified", "HCM — needs review", "Offshoring — rejected" and the
     * rest are prospecting's conclusions wearing an account's id. An Account is a
     * company somebody already read the verdict and decided to work; how it was
     * sourced is upstream of this screen, and six tabs re-asking the sourcing
     * question is how the accounts list stopped being about what a client buys.
     *
     * Hidden here rather than only deleted by a migration, because hiding takes
     * effect for every workspace on the next request — including the ones where
     * `apply-remove-account-verdict-views.mjs` has never been run — and because a
     * seeded view that the seeder still knows about would come back on the next
     * boot otherwise.
     *
     * SEEDED ones only. A view somebody built themselves is their configuration,
     * and making it vanish because it resembles one of ours is not a decision
     * this endpoint gets to make; the role rule above still governs those.
     */
    const visible = runnable.filter((row) => !(
        QUALIFICATION_HIDDEN_ON.has(row.object_key)
        && row.is_system === 1
        && VERDICT_FILTER.test(row.filter ?? '')
    ));

    return { views: visible.map(shapeView) };
}

/** A filter that reaches into the qualification plane. */
const VERDICT_FILTER = /"field"\s*:\s*"verdict_/;

/**
 * The objects a qualification view is noise on.
 *
 * Not `prospecting_company`, which is the plane that owns the question — the
 * four verdict views live there and stay there.
 */
const QUALIFICATION_HIDDEN_ON = new Set(['account', 'contact']);

function shapeView(row) {
    return {
        ...row,
        filter: json(row.filter, EMPTY_FILTER),
        sort: json(row.sort, []),
        columns: json(row.columns, []),
        conditionCount: countConditions(json(row.filter, EMPTY_FILTER)),
        is_default: !!row.is_default,
        is_system: !!row.is_system,
    };
}

export async function createView({ req, ctx }) {
    const body = await readJson(req);
    const objectKey = body.object_key;
    objectDef(objectKey);
    if (body.scope === 'workspace') require$(ctx, 'view.share');

    const viewId = id('viw');
    run(
        `INSERT INTO views (id, workspace_id, object_key, name, view_type, filter, sort, columns, group_by,
                            owner_id, scope, is_default, is_system, position, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?)`,
        [
            viewId, ctx.workspaceId, objectKey, String(body.name ?? 'Untitled view').slice(0, 120),
            body.view_type ?? 'table',
            JSON.stringify(body.filter ?? EMPTY_FILTER),
            JSON.stringify(body.sort ?? []),
            JSON.stringify(body.columns ?? []),
            body.group_by ?? null,
            ctx.userId, body.scope === 'workspace' ? 'workspace' : 'private',
            Number(body.position) || 100, now(), now(),
        ],
    );
    audit(ctx, { objectKey: 'view', recordId: viewId, action: 'created', after: { name: body.name, object: objectKey } });
    return { view: shapeView(get('SELECT * FROM views WHERE id = ?', [viewId])) };
}

export async function patchView({ req, params, ctx }) {
    const view = get('SELECT * FROM views WHERE id = ? AND workspace_id = ?', [params.id, ctx.workspaceId]);
    if (!view) throw notFound('That view no longer exists.');
    if (view.is_system && !can(ctx, 'record.write.all')) {
        throw forbidden('Built-in views can only be changed by an admin. Save a copy instead.');
    }
    if (view.owner_id && view.owner_id !== ctx.userId && !can(ctx, 'record.write.all')) {
        throw forbidden('That view belongs to someone else. Save a copy instead.');
    }

    const body = await readJson(req);
    if (body.scope === 'workspace' && view.scope !== 'workspace') require$(ctx, 'view.share');

    const values = {};
    if (body.name !== undefined) values.name = String(body.name).slice(0, 120);
    if (body.view_type !== undefined) values.view_type = body.view_type;
    if (body.filter !== undefined) values.filter = JSON.stringify(body.filter);
    if (body.sort !== undefined) values.sort = JSON.stringify(body.sort);
    if (body.columns !== undefined) values.columns = JSON.stringify(body.columns);
    if (body.group_by !== undefined) values.group_by = body.group_by;
    if (body.scope !== undefined) values.scope = body.scope;
    values.updated_at = now();

    const keys = Object.keys(values);
    run(`UPDATE views SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => values[k]), params.id]);
    return { view: shapeView(get('SELECT * FROM views WHERE id = ?', [params.id])) };
}

export async function deleteView({ params, ctx }) {
    const view = get('SELECT * FROM views WHERE id = ? AND workspace_id = ?', [params.id, ctx.workspaceId]);
    if (!view) throw notFound('That view no longer exists.');
    if (view.is_system) throw badRequest('Built-in views cannot be deleted. Create your own instead.');
    if (view.owner_id && view.owner_id !== ctx.userId && !can(ctx, 'record.write.all')) {
        throw forbidden('That view belongs to someone else.');
    }
    run('DELETE FROM views WHERE id = ?', [params.id]);
    audit(ctx, { objectKey: 'view', recordId: params.id, action: 'deleted', before: { name: view.name } });
    return { ok: true };
}

/**
 * The filter builder's schema for one object.
 *
 * Non-filterable fields are returned too, WITH the reason. A silent omission
 * reads as a bug; a stated constraint reads as a design, and the user stops
 * looking for the field that is not there.
 */
export async function filterSchema({ url, ctx }) {
    const objectKey = url.searchParams.get('object') ?? 'account';
    const def = objectDef(objectKey);
    const fields = fieldsFor(objectKey, ctx.workspaceId);

    return {
        object: objectKey,
        label: def.label,
        plural: def.plural,
        defaultFilter: def.defaultFilter ?? EMPTY_FILTER,
        operatorLabels: OPERATOR_LABELS,
        fields: fields.map((f) => ({
            key: f.key,
            label: f.label,
            type: f.type,
            options: f.options,
            custom: !!f.custom,
            computed: f.computed ?? null,
            required: !!f.required,
            readOnly: !!f.readOnly,
            form: f.form !== false,
            help: f.help ?? null,
            listDefault: !!f.listDefault,
            filterable: !!f.filterable,
            sortable: f.sortable !== false,
            searchable: !!f.searchable,
            operators: f.filterable ? operatorsFor(f.type) : [],
            excludedBecause: f.filterable ? null : (f.excludedBecause ?? 'This field is not indexed for filtering.'),
        })),
    };
}

/* ------------------------------------------------------------------ lists -- */

export async function listLists({ url, ctx }) {
    const objectKey = url.searchParams.get('object');
    const rows = all(
        `SELECT * FROM lists WHERE workspace_id = ? ${objectKey ? 'AND object_key = ?' : ''} ORDER BY name`,
        objectKey ? [ctx.workspaceId, objectKey] : [ctx.workspaceId],
    );
    const counts = new Map(
        all('SELECT list_id, COUNT(*) AS n FROM list_members GROUP BY list_id').map((r) => [r.list_id, r.n]),
    );
    return {
        lists: rows.map((row) => ({
            ...row,
            filter: json(row.filter, EMPTY_FILTER),
            // A dynamic list's size is a query, so it is counted on demand
            // rather than stored — a stored count on a live filter goes stale
            // the moment a record changes.
            count: row.kind === 'static'
                ? counts.get(row.id) ?? 0
                : idsMatching(row.object_key, ctx, { filter: json(row.filter, EMPTY_FILTER) }).total,
        })),
    };
}

export async function createList({ req, ctx }) {
    require$(ctx, 'list.write');
    const body = await readJson(req);
    objectDef(body.object_key);

    const listId = id('lst');
    run(
        `INSERT INTO lists (id, workspace_id, object_key, name, description, kind, filter, owner_id, scope, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
            listId, ctx.workspaceId, body.object_key, String(body.name ?? 'Untitled list').slice(0, 120),
            body.description ?? null, body.kind === 'dynamic' ? 'dynamic' : 'static',
            JSON.stringify(body.filter ?? EMPTY_FILTER), ctx.userId,
            body.scope === 'private' ? 'private' : 'workspace', now(), now(),
        ],
    );

    // Seeding a static list straight from the current selection is the usual
    // way one gets made, so it is one call rather than two.
    if (body.kind !== 'dynamic' && (body.ids?.length || body.all)) {
        const ids = body.all
            ? idsMatching(body.object_key, ctx, { filter: body.filter, q: body.q ?? null }).ids
            : body.ids;
        for (const recordId of ids) {
            run('INSERT OR IGNORE INTO list_members (list_id, record_id, added_at, added_by) VALUES (?,?,?,?)',
                [listId, recordId, now(), ctx.userId]);
        }
    }

    audit(ctx, { objectKey: 'list', recordId: listId, action: 'created', after: { name: body.name, kind: body.kind } });
    return { list: get('SELECT * FROM lists WHERE id = ?', [listId]) };
}

export async function patchList({ req, params, ctx }) {
    require$(ctx, 'list.write');
    const list = get('SELECT * FROM lists WHERE id = ? AND workspace_id = ?', [params.id, ctx.workspaceId]);
    if (!list) throw notFound('That list does not exist.');
    const body = await readJson(req);

    const values = { updated_at: now() };
    if (body.name !== undefined) values.name = String(body.name).slice(0, 120);
    if (body.description !== undefined) values.description = body.description;
    if (body.filter !== undefined) values.filter = JSON.stringify(body.filter);
    if (body.scope !== undefined) values.scope = body.scope;

    const keys = Object.keys(values);
    run(`UPDATE lists SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => values[k]), params.id]);
    return { list: get('SELECT * FROM lists WHERE id = ?', [params.id]) };
}

export async function deleteList({ params, ctx }) {
    require$(ctx, 'list.write');
    const list = get('SELECT * FROM lists WHERE id = ? AND workspace_id = ?', [params.id, ctx.workspaceId]);
    if (!list) throw notFound('That list does not exist.');
    run('DELETE FROM lists WHERE id = ?', [params.id]);
    audit(ctx, { objectKey: 'list', recordId: params.id, action: 'deleted', before: { name: list.name } });
    return { ok: true };
}

export async function listMembers({ req, params, ctx }) {
    require$(ctx, 'list.write');
    const list = get('SELECT * FROM lists WHERE id = ? AND workspace_id = ?', [params.id, ctx.workspaceId]);
    if (!list) throw notFound('That list does not exist.');
    if (list.kind !== 'static') {
        throw badRequest('That list is dynamic. Records join it by matching its filter — edit the filter instead.');
    }

    const body = await readJson(req);
    const ids = body.all
        ? idsMatching(list.object_key, ctx, {
            filter: body.filter, listId: body.fromListId ?? null, q: body.q ?? null,
        }).ids
        : (body.ids ?? []);
    if (!ids.length) throw badRequest('Nothing was selected.');

    let added = 0;
    for (const recordId of ids) {
        const before = get('SELECT 1 AS x FROM list_members WHERE list_id = ? AND record_id = ?', [params.id, recordId]);
        if (before) continue;
        run('INSERT INTO list_members (list_id, record_id, added_at, added_by) VALUES (?,?,?,?)',
            [params.id, recordId, now(), ctx.userId]);
        added += 1;
    }
    audit(ctx, { objectKey: 'list', recordId: params.id, action: 'members_added', after: { added, requested: ids.length } });
    return { added, requested: ids.length, skipped: ids.length - added };
}

export async function removeMembers({ req, params, ctx }) {
    require$(ctx, 'list.write');
    const body = await readJson(req);
    const ids = body.ids ?? [];
    if (!ids.length) throw badRequest('Nothing was selected.');
    for (const recordId of ids) {
        run('DELETE FROM list_members WHERE list_id = ? AND record_id = ?', [params.id, recordId]);
    }
    return { removed: ids.length };
}
