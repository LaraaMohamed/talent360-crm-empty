/**
 * The generic list page — one implementation for every object.
 *
 * Views are URL-ADDRESSABLE: the view, filter, sort, page and search all live
 * in the query string, so a filtered list can be pasted into a message and the
 * person who opens it sees exactly what the sender saw.
 */
import {
    h, mount, navigate, currentPath, params, setParams, toast, modal, confirm, number, debounce,
    captureFocus, restoreFocus,
} from '../core.js';
import { api, listUrl } from '../api.js';
import * as store from '../store.js';
import {
    dataTable, filterBuilder, recordForm, emptyState, skeletonRows, verdictBadge,
    columnPicker, icon, editEntity, deleteEntity,
} from '../components.js';
import { setPageTitle } from '../app.js';
import {
    canWrite, runBulk as runBulkWrite, bulkEditActions, bulkDeleteAction,
} from '../bulk.js';
import { generateDocumentDialog } from './generate.js';
import { linkCampaignDialog, renderSmartleadPanel } from './smartlead.js';


const VIEW_COUNTS_CACHE = new Map();

export async function listPage(content, objectKey, routeName) {
    const def = store.object(objectKey);
    setPageTitle(def.plural);

    const query = params();
    const views = store.viewsFor(objectKey);
    const lists = store.listsFor(objectKey);
    const cachedCounts = VIEW_COUNTS_CACHE.get(objectKey) ?? null;

    const state = {
        viewId: query.view ?? views.find((v) => v.is_default)?.id ?? views[0]?.id ?? null,
        listId: query.list ?? null,
        page: Number(query.page) || 1,
        q: query.q ?? '',
        filter: query.filter ? safeParse(query.filter) : null,
        sort: query.sort ? safeParse(query.sort) : null,
        columns: query.columns ? safeParse(query.columns) : null,
        selection: new Set(),
        allMatching: false,
        // The trash. A soft delete that nobody can see is a soft delete nobody
        // can undo, which makes it a hard delete with extra steps.
        showDeleted: query.deleted === '1',
        data: null,
        viewCounts: cachedCounts ? { ...cachedCounts } : null,
        viewCountsLoading: !cachedCounts,
    };

    /**
     * Tab counts, deliberately NOT awaited.
     *
     * The table must never wait on a number that decorates it. This resolves
     * after the first paint and repaints the strip; if it fails, the tabs stay
     * exactly as useful as they were without it. Cached counts prevent blank flashes.
     */
    async function loadViewCounts() {
        if (!views.length) return;
        state.viewCountsLoading = true;
        try {
            const { counts } = await api.get(`/api/${routeName}/view-counts`);
            state.viewCounts = { ...(state.viewCounts ?? {}), ...counts };
            VIEW_COUNTS_CACHE.set(objectKey, state.viewCounts);
        } catch { /* the strip is still perfectly usable without counts */ }
        finally {
            state.viewCountsLoading = false;
            if (state.data && lastPaint) paint(lastPaint.view, lastPaint.columns);
        }
    }

    // A shortcut from the dashboard: /accounts?verdict=hcm opens the qualified
    // set for that rule without needing a saved view for every combination.
    if (query.verdict) {
        state.viewId = views.find((v) => v.name.toLowerCase().includes(query.verdict) && v.name.includes('qualified'))?.id ?? state.viewId;
    }

    const container = h('div');
    // Campaigns embeds the Smartlead panel above the table itself — "view
    // Smartlead from inside Campaigns" rather than a separate destination —
    // in its own host so reloading the list (search, filters, paging) never
    // wipes or re-fetches it. mount() clears its target, so both hosts have
    // to be mounted together, in one call, or the second wipes the first.
    const showSmartlead = objectKey === 'campaign' && store.can('record.write.all');
    const smartleadHost = showSmartlead ? h('div', { style: { margin: 'var(--space-4) var(--space-4) 0' } }) : null;
    mount(content, ...(smartleadHost ? [smartleadHost, container] : [container]));
    if (smartleadHost) renderSmartleadPanel(smartleadHost, { embedded: true });

    // What the last paint was given, so the tab counts can repaint the same
    // screen when they arrive rather than re-deriving it and drifting.
    let lastPaint = null;

    /**
     * Where the caret was when a reload started.
     *
     * `load()` replaces the whole container with skeleton rows before the
     * request even leaves, so by the time `paint()` runs there is nothing
     * focused left to remember. Typing in the search box debounces into
     * `load()`, which is exactly how "I can only type one letter" happens.
     */
    let pendingFocus = null;

    async function load() {
        pendingFocus = captureFocus(container) ?? pendingFocus;
        mount(container, skeletonRows(6));
        const view = views.find((v) => v.id === state.viewId) ?? null;

        const options = {
            page: state.page,
            limit: 50,
            q: state.q || null,
            view: state.showDeleted ? null : state.viewId || null,
            list: state.listId || null,
            filter: state.filter || null,
            sort: state.sort || null,
            deleted: state.showDeleted ? '1' : null,
        };

        if (state.showDeleted) options.deleted = 'only';

        try {
            state.data = await api.get(listUrl(routeName, options));
        } catch (err) {
            mount(container, h('div.content-inner', h('div.note-box.danger', err.message)));
            return;
        }

        if (!state.filter && !state.q && !state.listId && state.data) {
            if (state.showDeleted) {
                state.viewCounts = { ...(state.viewCounts ?? {}), deleted: state.data.total };
            } else if (state.viewId) {
                state.viewCounts = { ...(state.viewCounts ?? {}), [state.viewId]: state.data.total };
            }
            VIEW_COUNTS_CACHE.set(objectKey, state.viewCounts);
        }

        const columns = state.columns
            ?? state.data.columns
            ?? view?.columns
            ?? store.fields(objectKey).filter((f) => f.listDefault).map((f) => f.key);

        paint(view, columns);
    }

    function paint(view, columns) {
        lastPaint = { view, columns };
        const effectiveSort = state.sort ?? view?.sort ?? [];
        const focus = captureFocus(container) ?? pendingFocus;
        pendingFocus = null;

        /**
         * A standalone sort control for one field — same asc/desc toggle a
         * column header gives you, but it does not need that field to be a
         * visible column. See the `.dir` arrow in `dataTable()`, which this
         * mirrors so the two read as one mechanism.
         */
        function sortToggleButton(field, label) {
            const active = effectiveSort.find((s) => s.field === field);
            return h('button.btn', {
                type: 'button',
                title: `Sort by ${label}`,
                onclick: () => {
                    state.sort = [{ field, direction: active?.direction === 'asc' ? 'desc' : 'asc' }];
                    setParams({ sort: JSON.stringify(state.sort) });
                    load();
                },
            }, label, h('span.dir', active ? (active.direction === 'desc' ? '↓' : '↑') : '↕'));
        }

        mount(container,
            h('div.card', { style: { margin: 'var(--space-4)' } },
                h('div.toolbar',
                    h('div.view-tabs',
                        views.map((v) => h('div.view-tab-wrap',
                            h('button.view-tab', {
                                class: v.id === state.viewId && !state.listId && !state.showDeleted ? 'active' : '',
                                onclick: () => {
                                    state.viewId = v.id;
                                    state.listId = null;
                                    state.filter = null;
                                    state.sort = null;
                                    state.columns = null;
                                    state.page = 1;
                                    state.showDeleted = false;
                                    state.selection = new Set(); state.allMatching = false;
                                    setParams({ view: v.id, list: null, filter: null, sort: null, page: null, columns: null, deleted: null });
                                    load();
                                },
                            // The number is the RECORD count, fetched separately and
                            // filled in when it lands. Cached counts prevent blank flashes.
                            }, v.name, state.viewCounts?.[v.id] != null
                                ? h('span.tab-count', number(state.viewCounts[v.id]))
                                : (state.viewCountsLoading && h('span.tab-count.dim', '…'))),
                            // Built-in views refuse the delete server-side with a
                            // clear reason — not hidden here too, so a manager who
                            // does not recognise "system" at a glance still gets
                            // told why, instead of the control just not existing.
                            h('button.view-tab-edit', {
                                type: 'button',
                                title: `Edit "${v.name}"`,
                                'aria-label': `Edit view ${v.name}`,
                                onclick: async (e) => {
                                    e.stopPropagation();
                                    await editView(v, { objectKey, routeName, state, view: views.find((x) => x.id === state.viewId) ?? v });
                                },
                            }, icon('edit')),
                            h('button.view-tab-delete', {
                                type: 'button',
                                title: `Delete "${v.name}"`,
                                'aria-label': `Delete view ${v.name}`,
                                onclick: async (e) => {
                                    e.stopPropagation();
                                    const ok = await confirm({
                                        title: `Delete "${v.name}"?`,
                                        message: 'This removes the saved view for everyone it is shared with. The records themselves are untouched.',
                                        confirmLabel: 'Delete', danger: true,
                                    });
                                    if (!ok) return;
                                    try {
                                        await api.delete(`/api/views/${v.id}`);
                                        await store.refreshViews();
                                        toast(`Deleted "${v.name}".`, 'success');
                                        // A fresh navigate to the bare route, not
                                        // just a repaint — `views`/`lists` above
                                        // are read once when this page mounted,
                                        // and remounting is what picks up the
                                        // refreshed store.
                                        navigate(state.viewId === v.id ? `/${routeName}` : currentPath());
                                    } catch (err) {
                                        toast(err.message, 'error');
                                    }
                                },
                            }, icon('close')),
                        )),
                        lists.length > 0 && lists.map((l) => h('div.view-tab-wrap',
                            h('button.view-tab', {
                                class: l.id === state.listId ? 'active' : '',
                                title: l.kind === 'dynamic' ? 'Dynamic list — a saved filter that re-evaluates' : 'Static list — curated by hand',
                                onclick: () => {
                                    state.listId = l.id;
                                    state.page = 1;
                                    state.selection = new Set(); state.allMatching = false;
                                    setParams({ list: l.id, view: null, page: null });
                                    load();
                                },
                            }, icon('list'), l.name, h('span.dim.xs', ` ${l.count}`)),
                            h('button.view-tab-delete', {
                                type: 'button',
                                title: `Delete "${l.name}"`,
                                'aria-label': `Delete list ${l.name}`,
                                onclick: async (e) => {
                                    e.stopPropagation();
                                    const ok = await confirm({
                                        title: `Delete "${l.name}"?`,
                                        message: l.kind === 'static'
                                            ? 'This removes the list and its membership. The records themselves are untouched.'
                                            : 'This removes the saved filter. The records themselves are untouched.',
                                        confirmLabel: 'Delete', danger: true,
                                    });
                                    if (!ok) return;
                                    try {
                                        await api.delete(`/api/lists/${l.id}`);
                                        await store.refreshLists();
                                        toast(`Deleted "${l.name}".`, 'success');
                                        navigate(state.listId === l.id ? `/${routeName}` : currentPath());
                                    } catch (err) {
                                        toast(err.message, 'error');
                                    }
                                },
                            }, icon('close')),
                        )),

                        // The trash, in the open. A soft delete nobody can see
                        // is a hard delete with extra steps.
                        h('button.view-tab', {
                            class: state.showDeleted ? 'active' : '',
                            title: 'Records that were deleted. They keep everything attached to them and can be restored.',
                            onclick: () => {
                                state.showDeleted = !state.showDeleted;
                                state.page = 1;
                                state.selection = new Set(); state.allMatching = false;
                                setParams({ deleted: state.showDeleted ? '1' : null, page: null });
                                load();
                            },
                        }, icon('trash'), 'Deleted',
                        state.viewCounts?.deleted != null
                            ? h('span.tab-count', number(state.viewCounts.deleted))
                            : (state.viewCountsLoading && h('span.tab-count.dim', '…'))),
                    ),
                ),

                h('div.toolbar',
                    h('input.input', {
                        type: 'search', placeholder: `Search ${def.plural.toLowerCase()}…`,
                        value: state.q, style: { inlineSize: 'min(18rem, 100%)' },
                        dataset: { focusKey: 'list-search' },
                        oninput: debounce((e) => {
                            state.q = e.target.value;
                            state.page = 1;
                            state.selection = new Set(); state.allMatching = false;
                            setParams({ q: state.q || null, page: null });
                            load();
                        }, 300),
                    }),

                    h('button.btn', { onclick: () => openFilters(view) },
                        icon('filter'), 'Filters',
                        state.filter && h('span.badge.accent', String(countConditions(state.filter))),
                    ),

                    h('button.btn', { onclick: () => openColumns(columns) }, icon('columns'), 'Columns'),

                    /**
                     * Sort by date added, without making a contact carry a
                     * "Created" column just to offer it. A saved view's
                     * column list is configuration a rep might not touch —
                     * this works whether or not `created_at` is on screen.
                     */
                    objectKey === 'contact' && sortToggleButton('created_at', 'Date added'),

                    peopleFilters(),

                    /**
                     * Back to the pipeline.
                     *
                     * The board already offered "▤ Table"; nothing offered the
                     * return trip, so a rep who switched to the table had no way
                     * back except editing the URL. `/deals` with no view and no
                     * layout is the board — see the route in app.js — so this is
                     * a plain link rather than a mode held in a variable, which
                     * keeps both halves of the toggle shareable.
                     */
                    objectKey === 'deal' && h('a.btn', { href: '/deals' }, icon('board'), 'Board'),

                    /**
                     * The renewal question, from the list it is asked about.
                     *
                     * It is not a saved view because it cannot be one: the
                     * decision date is `expiry_date` minus `notice_days`, and
                     * the filter language compares columns rather than doing
                     * arithmetic between them.
                     */
                    objectKey === 'agreement' && h('a.btn', { href: '/renewals' }, icon('clock'), 'Renewals'),


                    h('div.spacer'),

                    store.can('export') && h('button.btn', {
                        onclick: () => openExport(columns, effectiveSort),
                    }, icon('download'), 'Export'),

                    objectKey === 'account' && store.can('qualification.run') && h('button.btn', {
                        onclick: () => runQualification(),
                    }, icon('qualification'), 'Re-qualify'),

                    /**
                     * Close-date presets, on the one object where "when" is
                     * the first question. They compile into the SAME filter
                     * AST the builder produces — a plain `between` on
                     * close_date — so they compose with owner filters and
                     * saved views instead of being a second filtering system.
                     */
                    objectKey === 'deal' && (() => {
                        const chosen = state.filter?.children?.find((c) => c.field === 'close_date');
                        const iso = (d) => d.toISOString();
                        const dayStart = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
                        const RANGES = {
                            today: () => [dayStart(new Date()), dayStart(new Date(Date.now() + 864e5))],
                            week: () => {
                                const s = dayStart(new Date());
                                s.setUTCDate(s.getUTCDate() - ((s.getUTCDay() + 6) % 7)); // Monday start
                                const e = new Date(s); e.setUTCDate(e.getUTCDate() + 7);
                                return [s, e];
                            },
                            month: () => { const n = new Date(); return [new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1)), new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1))]; },
                            quarter: () => { const n = new Date(); const q = Math.floor(n.getUTCMonth() / 3) * 3; return [new Date(Date.UTC(n.getUTCFullYear(), q, 1)), new Date(Date.UTC(n.getUTCFullYear(), q + 3, 1))]; },
                            year: () => { const n = new Date(); return [new Date(Date.UTC(n.getUTCFullYear(), 0, 1)), new Date(Date.UTC(n.getUTCFullYear() + 1, 0, 1))]; },
                        };
                        const apply = (key) => {
                            const children = (state.filter?.children ?? []).filter((c) => c.field !== 'close_date');
                            if (key && RANGES[key]) {
                                const [from, to] = RANGES[key]();
                                children.push({ field: 'close_date', operator: 'between', value: [iso(from), iso(to)] });
                            }
                            state.filter = children.length ? { op: 'and', children } : null;
                            state.page = 1;
                            state.selection = new Set(); state.allMatching = false;
                            setParams({ filter: state.filter ? JSON.stringify(state.filter) : null, page: null });
                            load();
                        };
                        return h('select.input.people-filter', {
                            style: { inlineSize: 'auto' },
                            'aria-label': 'Expected close',
                            onchange: (e) => apply(e.target.value || null),
                        },
                        h('option', { value: '' }, 'Close date: all time'),
                        ...Object.keys(RANGES).map((k) => h('option', {
                            value: k,
                            // Mark the preset that is currently applied.
                            selected: chosen?.operator === 'between'
                                && k !== 'today'
                                && JSON.stringify(chosen.value) === JSON.stringify(RANGES[k]().map(iso)),
                        }, k === 'today' ? 'Closes today' : k === 'week' ? 'Closes this week' : k === 'month' ? 'Closes this month' : k === 'quarter' ? 'Closes this quarter' : 'Closes this year')),
                        );
                    })(),

                    canWrite() && h('button.btn.primary', { onclick: () => openCreate() }, `+ New ${def.label.toLowerCase()}`),
                ),

                dataTable({
                    objectKey,
                    records: state.data.records,
                    columns,
                    total: state.data.total,
                    page: state.data.page,
                    pages: state.data.pages,
                    sort: effectiveSort,
                    selection: state.selection,
                    allSelected: state.allMatching,
                    rowHref: (r) => `/${routeName}/${r.id}`,
                    onSort: (key) => {
                        const existing = effectiveSort.find((s) => s.field === key);
                        state.sort = [{ field: key, direction: existing?.direction === 'asc' ? 'desc' : 'asc' }];
                        setParams({ sort: JSON.stringify(state.sort) });
                        load();
                    },
                    onPage: (p) => {
                        state.page = p;
                        // "Select all matching" is page-independent — it means
                        // every record under the filter, so paging keeps it.
                        state.selection = new Set();
                        setParams({ page: p > 1 ? p : null });
                        load();
                    },
                    onSelect: (ids, checked) => {
                        // Selecting on THIS page while "select all matching" is
                        // on narrows the selection back to page-level control —
                        // the header or a row is being toggled by hand.
                        if (state.allMatching) {
                            state.allMatching = false;
                            state.selection = new Set();
                        }
                        for (const id of ids) {
                            if (checked) state.selection.add(id);
                            else state.selection.delete(id);
                        }
                        paint(view, columns);
                    },
                    onClear: () => {
                        state.selection = new Set();
                        state.allMatching = false;
                        paint(view, columns);
                    },
                    bulkActions: bulkBar(view, columns),
                    rowActions: canWrite() && ['task', 'note', 'activity'].includes(objectKey)
                        ? (record) => rowButtons(record)
                        : null,
                }),
            ),
        );

        restoreFocus(container, focus);
    }

    /**
     * Per-row Edit / Delete, for the records people act on by hand.
     *
     * Accounts and deals have pages stuffed with their own actions; a task, a
     * note or an activity is a single fact someone wants to correct and leave.
     * Opening the whole record, scrolling to the Details card, editing there,
     * then hunting down Delete in the More menu is three pages of ceremony for
     * what the row itself can host. `editEntity`/`deleteEntity` are the same
     * dialogs every other surface uses, so a change made here behaves exactly
     * like a change made on the record page.
     */
    /**
     * WHOSE, in one click, on the lists where that is the question.
     *
     * ── WHY THE FILTER BUILDER WAS NOT ENOUGH ───────────────────────────────
     *
     * It can express this — `created_by is any of [Sara]` — and a manager
     * asking "what did Sara raise this week" had to open a dialog, choose a
     * field from sixty, choose an operator, choose a person, and apply. That is
     * five decisions for the question this screen is opened to ask, and the
     * cost is not the clicks: a filter nobody builds is a filter nobody uses,
     * so the answer came from asking Sara instead.
     *
     * Two dropdowns, on the four objects where ownership is the axis people
     * slice by. They compile into the SAME filter the builder produces and go
     * to the server with it, so the counts, the total and the export all move
     * together — and the builder still shows them, because they are ordinary
     * conditions rather than a second filtering mechanism beside it.
     *
     * Gated on `record.read.all`, which in this workspace a REP holds too —
     * and that is right rather than an oversight. The gate is about disclosure,
     * and these dropdowns disclose nothing: a rep can already open every task
     * on this list and read the assignee and creator off each row. Filtering by
     * a colleague's name shows them a subset of what the unfiltered list was
     * already showing them.
     *
     * The role that must not see this is one that cannot read the records in
     * the first place — an SDR, who never reaches this screen at all, and a
     * readonly member, for whom the check below is what stops it.
     */
    const PEOPLE_FILTERS = {
        task: [{ field: 'assignee_id', label: 'Assignee' }, { field: 'created_by', label: 'Created by' }],
        activity: [{ field: 'actor_id', label: 'Performed by' }, { field: 'created_by', label: 'Created by' }],
        note: [{ field: 'author_id', label: 'Author' }, { field: 'created_by', label: 'Created by' }],
        deal: [{ field: 'owner_id', label: 'Owner' }, { field: 'created_by', label: 'Created by' }],
    };

    /** The people conditions currently in `state.filter`, by field. */
    function chosenPeople() {
        const out = {};
        for (const child of state.filter?.children ?? []) {
            if (child.field && child.operator === 'is_any_of' && Array.isArray(child.value) && child.value.length === 1) {
                out[child.field] = child.value[0];
            }
        }
        return out;
    }

    function peopleFilters() {
        const fields = PEOPLE_FILTERS[objectKey];
        if (!fields || !store.can('record.read.all')) return null;
        const chosen = chosenPeople();

        const apply = (field, userId) => {
            // Rebuilt rather than mutated: the existing conditions on OTHER
            // fields are kept, this field's is replaced, and an empty choice
            // removes it entirely rather than leaving `is_any_of []`.
            const children = (state.filter?.children ?? []).filter((c) => c.field !== field);
            if (userId) children.push({ field, operator: 'is_any_of', value: [userId] });
            state.filter = children.length ? { op: 'and', children } : null;
            state.page = 1;
            state.selection = new Set(); state.allMatching = false;
            setParams({ filter: state.filter ? JSON.stringify(state.filter) : null, page: null });
            load();
        };

        return h('div.row', { style: { gap: 'var(--space-2)' } },
            fields.map(({ field, label }) => h('select.input.people-filter', {
                style: { inlineSize: 'auto' },
                'aria-label': label,
                onchange: (e) => apply(field, e.target.value || null),
            },
            h('option', { value: '' }, `${label}: anyone`),
            store.users().map((u) => h('option', {
                value: u.id, selected: u.id === chosen[field],
            }, u.name)))),
        );
    }

    function rowButtons(record) {
        if (!canWrite()) return null;
        const name = store.object(objectKey)?.titleField
            ? record[store.object(objectKey).titleField]
            : record.title ?? record.subject ?? record.body ?? record.name;
        return h('div.row',
            { style: { gap: 'var(--space-2)' }, role: 'group', 'aria-label': 'Row actions' },
            h('button.btn.sm.ghost', {
                onclick: async (event) => {
                    event.stopPropagation();
                    const saved = await editEntity(objectKey, { record });
                    if (saved) load();
                },
            }, icon('edit'), 'Edit'),
            store.can('record.delete') && h('button.btn.sm.ghost.danger', {
                onclick: async (event) => {
                    event.stopPropagation();
                    if (await deleteEntity(objectKey, record, { name })) load();
                },
            }, icon('trash'), 'Delete'),
        );
    }

    function bulkBar(view, columns) {
        const selectionPayload = () => state.allMatching
            ? { all: true, filter: state.filter, listId: state.listId, q: state.q || null }
            : { ids: [...state.selection] };

        const refresh = () => {
            state.selection = new Set();
            state.allMatching = false;
            load();
            loadViewCounts();
        };

        /** Every bulk write goes through the preview first. No exceptions. */
        const runBulk = async (payload, opts) => {
            const ran = await runBulkWrite({
                objectKey, routeName, selection: selectionPayload(), payload, ...opts,
            });
            if (ran) refresh();
        };

        const hasSelection = () => state.allMatching || state.selection.size > 0;
        const total = state.data?.total ?? 0;
        const selectionLabel = () => state.allMatching
            ? `all ${number(total)} matching`
            : state.selection.size > 0
                ? `${state.selection.size} selected`
                : 'none selected';

        return h('div.row',
            h('span.xs.dim', selectionLabel()),

            /**
             * Select ALL MATCHING, not just this page.
             *
             * The header checkbox only ever covers the page you are looking at.
             * This selects every record under the current filter — every page —
             * so a bulk action on 400 records is one choice, not eight pages of
             * checking. It is a distinct toggle, never implied by paging, and it
             * works on the trash too (restore / delete permanently).
             */
            total > 0 && h('button.btn.sm.ghost', {
                title: state.allMatching
                    ? 'Clear the select-all-matching selection.'
                    : `Select all ${number(total)} records matching the current filter — every page, not just this one.`,
                onclick: () => {
                    state.allMatching = !state.allMatching;
                    if (!state.allMatching) state.selection = new Set();
                    paint(view, columns);
                },
            }, state.allMatching ? 'Clear all' : `Select all matching (${number(total)})`),

            /**
             * Edit, the task states, and Assign — shared with every other
             * screen that lists rows, so My work's tabs offer exactly these
             * and mean exactly the same thing by them.
             */
            ...bulkEditActions({
                objectKey, routeName, selection: selectionPayload,
                disabled: !hasSelection(), onDone: refresh,
            }),

            store.can('list.write') && h('button.btn.sm', {
                disabled: !hasSelection(),
                onclick: async () => {
                    const listId = await pickList(objectKey);
                    if (!listId) return;
                    try {
                        const result = await api.post(`/api/lists/${listId}/members`, selectionPayload());
                        await store.refreshLists();
                        const name = store.state.lists.find((l) => l.id === listId)?.name ?? 'the list';
                        toast(`${result.added} added to "${name}"`
                            + `${result.skipped ? `, ${result.skipped} already there` : ''}.`, 'success');
                    } catch (err) {
                        toast(err.message, 'error');
                    }
                    refresh();
                },
            }, 'Add to list'),

            /**
             * Cold calling, from the list where the audience is chosen.
             *
             * Contacts only: a calling queue is a list of people to ring, and an
             * account has no phone of its own.
             */
            objectKey === 'contact' && (store.can('calling.manage') || store.can('calling.assign_own')) && h('button.btn.sm', {
                disabled: !hasSelection(),
                onclick: async () => {
                    const done = await addToCalling(selectionPayload(), { ids: state.selection, allMatching: state.allMatching });
                    if (done) refresh();
                },
            }, icon('phone'), 'Add to Cold Calling'),

            // Campaign membership, from the list where the audience is actually
            // chosen: filter the contacts you want, select, add.
            //
            // ONE button, not two. Pushing to Smartlead used to be a separate
            // "Add to Smartlead" action with its own campaign picker, so
            // joining a Smartlead-linked email campaign meant deciding which
            // of two near-identical buttons to click — and picking the wrong
            // one added someone to the CRM campaign with no idea they had not
            // actually been enrolled anywhere. Now the campaign you pick here
            // decides that for you: if it is linked to Smartlead, adding
            // people to it also pushes them there, through the exact same
            // review-then-push flow the old button used. A campaign that
            // isn't linked (or an account, which Smartlead has no concept of)
            // just gets a plain membership add, as before.
            ['contact', 'account'].includes(objectKey) && canWrite() && h('button.btn.sm', {
                disabled: !hasSelection(),
                onclick: async () => {
                    const campaignId = await pickCampaign();
                    if (!campaignId) return;

                    const picked = store.campaigns().find((c) => c.id === campaignId);
                    if (objectKey === 'contact' && picked?.external_id) {
                        const { enrollWizard } = await import('../outreach.js');
                        const result = await enrollWizard(selectionPayload(), { defaultCampaignId: campaignId });
                        if (result) refresh();
                        return;
                    }

                    const selection = selectionPayload();
                    const result = await api.post(`/api/campaigns/${campaignId}/members`, {
                        memberType: objectKey, ...selection,
                        includeContacts: objectKey === 'account',
                    });
                    const held = [...(result.undeliverable ?? []), ...(result.missing ?? []).map((id) => ({ id, reason: 'Record no longer exists.' }))];
                    // "0 added." with no reason shown looked like the button was
                    // broken — usually every selected contact had no email, or
                    // one this campaign's policy holds back, and the toast never
                    // said so. The counts were already computed; they just were
                    // not shown.
                    const parts = [`${result.added} added`];
                    if (result.readded) parts.push(`${result.readded} re-added`);
                    if (result.skipped) parts.push(`${result.skipped} already in it`);
                    if (held.length) parts.push(`${held.length} held back`);
                    if (result.cascaded) parts.push(`plus ${result.cascaded.added} contacts`);
                    toast(`${parts.join(', ')}.`, held.length && !result.added ? 'warning' : 'success');
                    if (held.length && objectKey === 'contact') {
                        await heldBackModal(campaignId, held);
                    } else if (held.length) {
                        await modal({
                            title: `${held.length} not added`,
                            size: 'wide',
                            body: h('div.stack.tight',
                                ...held.slice(0, 50).map((r) => h('div.row.between',
                                    h('span.small', r.name ?? r.id),
                                    h('span.badge.warning', String(r.reason ?? '').slice(0, 100)))),
                                held.length > 50 && h('p.xs.dim', `…and ${held.length - 50} more.`),
                            ),
                            footer: (close) => [h('button.btn.primary', { onclick: () => close(true) }, 'OK')],
                        });
                    }
                    refresh();
                },
            }, 'Add to campaign'),

            /**
             * Prospecting → CRM, the one door between the planes.
             *
             * Always previewed. This creates Accounts and Contacts that people
             * will immediately start working, and the two things most likely to
             * be wrong — a company that already exists, and contacts whose
             * email the policy excludes — are invisible until stated.
             */
            objectKey === 'prospecting_company' && canWrite() && h('button.btn.sm.primary', {
                disabled: !hasSelection(),
                onclick: () => importToCrm(selectionPayload(), refresh),
            }, icon('arrowRight'), 'Import into CRM'),

            /**
             * Bulk verification.
             *
             * The confirmation states the COST, not just the count: these are
             * paid third-party calls, and "verify 400 contacts" is a billable
             * act that should never happen because someone expected a preview.
             * Already-checked addresses are skipped unless explicitly asked
             * for, so re-running a view is cheap.
             */
            ['contact', 'prospecting_contact'].includes(objectKey) && canWrite() && h('button.btn.sm', {
                onclick: async () => {
                    const payload = selectionPayload();
                    const count = payload.all ? (state.data?.total ?? 0) : payload.ids.length;
                    const reverify = await modal({
                        title: `Verify ${number(count)} email address${count === 1 ? '' : 'es'}?`,
                        body: h('div.stack',
                            h('p.small', 'Each address is checked with your configured provider. These are paid, '
                                + 'rate-limited calls, so they run one at a time and are capped at 500 per run.'),
                            h('p.xs.dim', 'Contacts that already have a result are skipped unless you re-verify.'),
                        ),
                        footer: (close) => [
                            h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                            h('div.spacer'),
                            h('button.btn', { onclick: () => close({ reverify: true }) }, 'Re-verify everything'),
                            h('button.btn.primary', { onclick: () => close({ reverify: false }) }, 'Verify unchecked'),
                        ],
                    });
                    if (!reverify) return;
                    // Verifying can take a while — the provider is rate-limited
                    // and the run is capped at 500 — so the screen says so instead
                    // of sitting there looking idle. Same loading toast as the
                    // bulk operations use.
                    const loadingToast = toast(
                        `Verifying ${number(count)} email address${count === 1 ? '' : 'es'}...`,
                        'loading',
                    );
                    try {
                        const result = await api.post(`/api/${routeName}/verify-emails`, {
                            ...(payload.all
                                ? { all: true, filter: payload.filter, listId: payload.listId }
                                : { ids: payload.ids }),
                            reverify: reverify.reverify,
                        });
                        loadingToast?.remove?.();
                        const summary = result.tally.map((t) => `${t.count} ${t.label.toLowerCase()}`).join(', ');
                        toast(`${result.checked} checked${summary ? `: ${summary}` : ''}.`
                            + `${result.skipped ? ` ${result.skipped} skipped.` : ''}`, 'success');
                        refresh();
                    } catch (err) {
                        loadingToast?.remove?.();
                        toast(err.message, 'error');
                    }
                },
            }, icon('mail'), 'Verify emails'),

            objectKey === 'account' && store.can('qualification.run') && h('button.btn.sm', {
                onclick: async () => {
                    const payload = selectionPayload();
                    const result = await api.post('/api/qualification/run', {
                        ...(payload.all ? { all: true, filter: payload.filter, listId: payload.listId } : { accountIds: payload.ids }),
                    });
                    showQualificationResult(result);
                    refresh();
                },
            }, 'Re-qualify'),

            /**
             * Lead scoring is cheap and local — no third-party calls — so it
             * runs over a whole selection without a cap. Explicit rather than
             * a side effect of saving the model.
             */
            objectKey === 'account' && canWrite() && h('button.btn.sm', {
                disabled: !hasSelection(),
                title: 'Score the selected accounts with the current model',
                onclick: async () => {
                    const payload = selectionPayload();
                    const loadingToast = toast('Scoring selected accounts…', 'loading');
                    try {
                        const result = await api.post(`/api/${routeName}/score`, payload);
                        loadingToast?.remove?.();
                        toast(`${result.scored} scored`
                            + `${result.failed?.length ? `, ${result.failed.length} failed` : ''}.`, 'success');
                        refresh();
                    } catch (err) {
                        loadingToast?.remove?.();
                        toast(err.message, 'error');
                    }
                },
            }, 'Score'),

            /**
             * In the trash the choices are the opposite ones — and there are
             * two of them.
             *
             * Restore undoes the delete. "Delete permanently" is the other end
             * of it: without it the trash only ever grows, and a record deleted
             * by mistake — or one somebody asked to have erased — stays in the
             * database forever with nothing in the product able to remove it.
             */
            state.showDeleted && canWrite() && h('button.btn.sm', {
                onclick: () => runBulk({ action: 'restore' }, {
                    title: 'Restore these records?', confirmLabel: 'Restore',
                }),
            }, 'Restore'),

            state.showDeleted && store.can('record.delete') && store.can('record.write.all')
                && h('button.btn.sm.danger', {
                    title: 'Destroy these records and their files. This cannot be undone.',
                    onclick: () => runBulk({ action: 'purge' }, {
                        title: 'Delete permanently?',
                        confirmLabel: 'Delete permanently',
                        danger: true,
                    }),
                }, 'Delete permanently'),

            !state.showDeleted && bulkDeleteAction({
                objectKey, routeName, selection: selectionPayload, onDone: refresh,
            }),
        );
    }

    /* ---- dialogs ---- */

    /**
     * Export asks WHICH columns rather than assuming.
     *
     * It used to export exactly the columns on screen, silently. The table
     * shows a handful of `listDefault` columns, so the file that came out was
     * missing most of the record — every custom field, and everything
     * enrichment and qualification had produced. That gap is only discovered
     * downstream, after the file is already somewhere else, which makes a
     * quietly-truncated export worse than no export at all.
     */
    async function openExport(columns, sort) {
        const allFields = store.fields(objectKey);
        const rows = state.data?.total ?? 0;

        const start = (everything) => {
            const url = listUrl(`${routeName}/export.csv`, {
                view: state.viewId,
                list: state.listId,
                filter: state.filter,
                sort,
                q: state.q || null,
                ...(everything ? { all: '1' } : { columns: JSON.stringify(columns) }),
            });
            window.location.href = url;
            toast('Export started. It is recorded in the audit log.');
        };

        await modal({
            title: `Export ${def.plural.toLowerCase()}`,
            body: h('div.stack',
                h('p.small', `${number(rows)} ${rows === 1 ? def.label.toLowerCase() : def.plural.toLowerCase()} `
                    + 'match the current view, filters and search.'),
                h('p.xs.dim',
                    'Visible columns gives you exactly what the table shows. Every field also includes custom fields '
                    + 'and everything enrichment and qualification collected, which the table has no room to display.'),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('div.spacer'),
                h('button.btn', {
                    onclick: () => { close(true); start(false); },
                }, `Visible columns (${columns.length})`),
                h('button.btn.primary', {
                    onclick: () => { close(true); start(true); },
                }, `Every field (${allFields.length})`),
            ],
        });
    }

    /**
     * Import prospects into the CRM.
     *
     * The preview is not optional. Promotion creates records people start
     * working within minutes, and the two facts that decide whether it was
     * right — how many companies already exist as Accounts, and how many
     * contacts the email policy will leave behind — are invisible otherwise.
     * "Blocked" is shown separately from "skipped": one is a decision the user
     * can override, the other has already happened.
     */
    async function importToCrm(payload, refresh) {
        let preview;
        try {
            preview = await api.post('/api/prospects/import-preview', payload);
        } catch (err) {
            toast(err.message, 'error');
            return;
        }

        const t = preview.totals;
        const line = (label, value, help) => value > 0 && h('div.row.between',
            h('span.small', label), h('span.small.tabular.strong', number(value)),
            help && h('span.xs.dim', help));

        const decision = await modal({
            title: 'Import into the CRM',
            size: 'wide',
            body: h('div.stack',
                h('div.note-box',
                    h('div.strong', 'What will happen'),
                    h('div.stack.tight', { style: { marginBlockStart: 'var(--space-2)' } },
                        line('New accounts created', t.create),
                        line('Matched an existing account', t.merge, 'gaps filled only — nothing overwritten'),
                        line('Contacts imported', t.contacts),
                        line('Contacts excluded', t.contactsExcluded, `by the "${preview.policy}" email policy`),
                        line('Already imported', t.skip),
                    ),
                ),

                t.blocked > 0 && h('div.note-box.warning',
                    h('div.strong', `${t.blocked} not qualified`),
                    h('p.small', 'The CRM takes qualified companies. These are left in Prospecting — '
                        + 'import them anyway only if you mean to.'),
                ),

                t.contactsExcluded > 0 && h('details',
                    h('summary.small', `Why ${number(t.contactsExcluded)} contacts are excluded`),
                    h('div.stack.tight', { style: { marginBlockStart: 'var(--space-2)' } },
                        preview.rows.flatMap((r) => (r.contacts?.detail ?? [])
                            .filter((c) => !c.ok)
                            .slice(0, 40)
                            .map((c) => h('div.row.between',
                                h('span.xs', c.name, c.email && h('span.dim', ` · ${c.email}`)),
                                h('span.xs.dim', c.reason)))),
                    ),
                ),

                t.create + t.merge === 0 && h('p.dim', 'Nothing here would be imported.'),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('div.spacer'),
                t.blocked > 0 && store.can('record.write.all') && h('button.btn', {
                    onclick: () => close({ force: true }),
                }, `Import all ${number(t.create + t.merge + t.blocked)}, including unqualified`),
                (t.create + t.merge) > 0 && h('button.btn.primary', {
                    onclick: () => close({ force: false }),
                }, `Import ${number(t.create + t.merge)} qualified`),
            ],
        });

        if (!decision) return;
        try {
            const result = await api.post('/api/prospects/import', { ...payload, force: decision.force });
            toast(result.note, 'success');
            refresh();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    async function openFilters(view) {
        let working = state.filter ?? view?.filter ?? { op: 'and', children: [] };
        const host = h('div');
        const repaint = () => {
            // filterBuilder rebuilds its whole tree on every keystroke (there is
            // no DOM reconciliation in this app), which would otherwise destroy
            // the very input the user is typing into after one character.
            const focus = captureFocus(host);
            mount(host, filterBuilder(objectKey, working, (next) => {
                working = next;
                repaint();
            }));
            restoreFocus(host, focus);
        };
        repaint();

        const canUpdateCurrent = !!(view && view.id === state.viewId && !view.is_system);
        const result = await modal({
            title: `Filter ${def.plural.toLowerCase()}`,
            size: 'wide',
            body: h('div.stack', host),
            footer: (close) => [
                h('button.btn.ghost', { onclick: () => close({ clear: true }) }, 'Clear'),
                h('div.spacer'),
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                canUpdateCurrent && h('button.btn', {
                    title: `Save this filter into "${view.name}" along with the current columns & sort — one view, not two`,
                    onclick: () => close({ update: true, filter: working }),
                }, `Update "${view.name}"`),
                h('button.btn', { onclick: () => close({ save: true, filter: working }) }, 'Save as view'),
                h('button.btn.primary', { onclick: () => close({ apply: true, filter: working }) }, 'Apply'),
            ],
        });

        if (!result) return;
        if (result.clear) {
            state.filter = null;
            state.selection = new Set(); state.allMatching = false;
            setParams({ filter: null });
            return load();
        }
        if (result.update) {
            try {
                const effectiveColumns = state.columns ?? view?.columns ?? [];
                const effectiveSort = state.sort ?? view?.sort ?? [];
                await api.patch(`/api/views/${view.id}`, {
                    filter: result.filter,
                    columns: effectiveColumns,
                    sort: effectiveSort,
                });
                await store.refreshViews();
                toast(`Updated "${view.name}" — filter + columns saved together.`, 'success');
                // Stay on this view; its definition changed, so reload from it
                navigate(`/${routeName}?view=${view.id}`);
                return undefined;
            } catch (err) {
                toast(err.message, 'error');
                return;
            }
        }
        if (result.save) {
            const name = await promptText('Name this view', 'e.g. Large accounts in Egypt');
            if (!name) return;
            const { view: created } = await api.post('/api/views', {
                object_key: objectKey, name, filter: result.filter,
                columns: state.columns ?? view?.columns ?? [], sort: state.sort ?? view?.sort ?? [],
                scope: 'private',
            });
            await store.refreshViews();
            toast('View saved — filter + columns together as one view.', 'success');
            navigate(`/${routeName}?view=${created.id}`);
            return undefined;
        }
        state.filter = result.filter;
        state.page = 1;
        state.selection = new Set(); state.allMatching = false;
        setParams({ filter: JSON.stringify(result.filter), page: null });
        return load();
    }

    /**
     * Which columns, AND in what order.
     *
     * The old dialog was a list of tick boxes, so the order was whatever the
     * field registry happened to declare — un-ticking a column and re-ticking
     * it silently moved it to the end. Column order is most of what makes a
     * table readable ("name, owner, stage" is a different report from "stage,
     * name, owner"), and there was no way to express it, let alone keep it.
     *
     * So: the chosen columns are an ordered list you can move and remove, the
     * rest are a palette you add from, and the arrangement can be saved as a
     * view — which is the only way it survives the next page load.
     */
    async function openColumns(current) {
        // The picker itself lives in components.js, shared with the calling
        // queue. "Save as view" is this page's addition, because a view is
        // stored per object and the queue has nowhere to store one.
        const activeView = views.find((v) => v.id === state.viewId) ?? null;
        const canUpdateCurrent = !!(activeView && !activeView.is_system);
        const result = await columnPicker(objectKey, current, {
            extraActions: (close) => [
                canUpdateCurrent && h('button.btn', {
                    title: `Save these columns into "${activeView.name}" along with the current filter — one view, not two`,
                    onclick: () => close({ update: true }),
                }, `Update "${activeView.name}"`),
                // A private view needs no capability — it is this person's own
                // way of looking at their own screen.
                h('button.btn', { onclick: () => close({ save: true }) }, 'Save as view'),
            ],
        });
        if (!result) return;
        const chosen = result.columns;

        state.columns = chosen;
        setParams({ columns: JSON.stringify(chosen) });

        if (result.update) {
            try {
                await api.patch(`/api/views/${activeView.id}`, {
                    columns: chosen,
                    filter: state.filter ?? activeView.filter ?? null,
                    sort: state.sort ?? activeView.sort ?? [],
                });
                await store.refreshViews();
                toast(`Updated "${activeView.name}" — columns + filter saved together.`, 'success');
                navigate(`/${routeName}?view=${activeView.id}`);
                return undefined;
            } catch (err) {
                toast(err.message, 'error');
                return load();
            }
        }
        if (result.save) {
            const name = await promptText('Name this view', 'e.g. Pipeline review');
            if (!name) return load();
            try {
                const view = views.find((v) => v.id === state.viewId) ?? null;
                const { view: created } = await api.post('/api/views', {
                    object_key: objectKey,
                    name,
                    // The whole arrangement, not just the columns: a view that
                    // remembers the order but forgets the filter you were
                    // looking at is not the screen you asked it to keep.
                    filter: state.filter ?? view?.filter ?? null,
                    sort: state.sort ?? view?.sort ?? [],
                    columns: chosen,
                    scope: 'private',
                });
                await store.refreshViews();
                toast('View saved. It keeps these columns, in this order, plus the current filter.', 'success');
                navigate(`/${routeName}?view=${created.id}`);
                return undefined;
            } catch (err) {
                toast(err.message, 'error');
            }
        }
        return load();
    }

    async function openCreate() {
        /**
         * A proposal and an agreement are documents, not forms.
         *
         * The generic record form asked for a number, a title and a currency and
         * produced a row with no document and no company behind it — the
         * "separate disconnected copy of company information" this replaced. The
         * real thing starts from the account and reads everything else off it.
         */
        if (objectKey === 'proposal' || objectKey === 'agreement') {
            const done = await generateDocumentDialog({ category: objectKey });
            if (!done) return;
            toast(
                `${done.document.name} generated (v${done.generation.version})`
                + `${done.record?.number ? ` — ${done.record.number}` : ''}.`,
                'success',
            );
            if (done.record) navigate(`/${done.record.object}s/${done.record.id}`);
            else load();
            return;
        }

        /**
         * A campaign's whole point, in this CRM, is running a Smartlead
         * sequence — so "new campaign" starts from a real Smartlead campaign
         * (name pre-filled, editable) rather than a blank form nobody had
         * enough information to fill in. Someone who genuinely wants a
         * campaign untethered from Smartlead still can — see the link inside
         * the dialog itself — but that is the exception now, not the default.
         */
        if (objectKey === 'campaign') {
            if (store.can('record.write.all')) {
                const targetId = await linkCampaignDialog();
                if (!targetId) return;
                if (targetId !== '__blank__') {
                    await store.refreshCampaigns().catch(() => {});
                    navigate(`/${routeName}/${targetId}`);
                    return;
                }
                // '__blank__' — the user explicitly asked for a campaign with
                // no Smartlead tie. Fall through to the generic form below.
            }
            // Anyone who cannot link Smartlead campaigns also falls through
            // — they can still make a plain CRM campaign.
        }

        let form;
        const errorBox = h('div.error');
        const result = await modal({
            title: `New ${def.label.toLowerCase()}`,
            size: 'wide',
            body: () => {
                form = recordForm(objectKey, defaultsFor(objectKey), {});
                return h('div.stack', errorBox, form.element);
            },
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', {
                    onclick: async (event) => {
                        const button = event.currentTarget;
                        button.disabled = true;
                        try {
                            const { record } = await api.post(`/api/${routeName}`, form.draft);
                            close(record);
                        } catch (err) {
                            errorBox.textContent = err.message;
                            button.disabled = false;
                        }
                    },
                }, 'Create'),
            ],
        });
        if (!result) return;
        // A campaign is an option source as well as a record, so the cached
        // copy every picker reads has to learn about it now rather than at the
        // next full page load.
        if (objectKey === 'campaign') await store.refreshCampaigns().catch(() => {});
        navigate(`/${routeName}/${result.id}`);
    }

    async function runQualification() {
        const ok = await confirm({
            title: 'Re-qualify every account in this view?',
            message: 'The rules are evaluated against stored evidence — nothing is collected from LinkedIn, so this '
                + 'is free and takes seconds. Verdicts are appended, never overwritten.',
            confirmLabel: 'Run',
        });
        if (!ok) return;
        const result = await api.post('/api/qualification/run', {
            all: true, filter: state.filter ?? views.find((v) => v.id === state.viewId)?.filter ?? null,
        });
        showQualificationResult(result);
        load();
    }

    await load();
    loadViewCounts();   // fire-and-forget: the table is already on screen
    return undefined;
}

/* ------------------------------------------------------------- helpers --- */

function safeParse(value) {
    try { return JSON.parse(value); } catch { return null; }
}

function countConditions(node) {
    if (!node || typeof node !== 'object') return 0;
    if (Array.isArray(node.children)) return node.children.reduce((a, c) => a + countConditions(c), 0);
    return node.field ? 1 : 0;
}

function defaultsFor(objectKey) {
    const now = new Date().toISOString();
    if (objectKey === 'activity') return { occurred_at: now, type_key: store.activityTypes()[0]?.key };
    if (objectKey === 'task') return { status: 'open', priority: 'B', assignee_id: store.state.me.user.id };
    if (objectKey === 'account') return { lifecycle_stage: 'prospect' };
    if (objectKey === 'prospecting_company') return {}; // no default filter for prospecting companies
    if (objectKey === 'contact') return { is_active: true, data_source: 'entered manually' };
    if (objectKey === 'deal') {
        const pipeline = store.pipelines()[0];
        return {
            pipeline_id: pipeline?.id,
            stage_id: pipeline?.stages?.[0]?.id,
            status: 'open',
            currency: store.baseCurrency(),
        };
    }
    return {};
}


/**
 * Choosing — or creating — the campaign to add the selection to.
 *
 * Same two faults the list picker had, and the same two fixes. The campaigns
 * arrive inside `/api/meta`, which is read once when the tab loads, so a
 * campaign made after that did not exist as far as this dialog was concerned —
 * which is why it kept saying there were none right after one was created. And
 * having none was a dead end that sent you to another page and lost your
 * selection on the way.
 */
/**
 * Put the selection on an SDR's calling queue.
 *
 * Two-step by necessity, not by taste. The server refuses to move a contact
 * that is already on somebody else's list and says whose it is; that answer
 * comes back as `needsConfirmation` with nothing written, and this asks before
 * sending it again with `reassign`. Taking work off a colleague's queue is not
 * something to do silently.
 */
/**
 * The "N not added" dialog for a contact campaign, made actionable.
 *
 * A contact held back for having no email history at all can be fixed right
 * here — verify it, and if the address comes back safe, retry adding just
 * that one contact without making the person re-run the whole selection.
 * A contact already checked and found risky or blocked stays skipped: that
 * verdict does not change by asking again, and re-adding it would defeat the
 * policy that held it back in the first place.
 */
async function heldBackModal(campaignId, held) {
    const rows = new Map(held.map((r) => [r.id, { ...r, verifying: false, addedNow: false }]));
    let box;
    const repaint = () => {
        const items = [...rows.values()];
        const next = h('div.stack.tight',
            ...items.slice(0, 50).map((r) => h('div.row.between', { style: { alignItems: 'center' } },
                h('span.small', r.name ?? r.id),
                r.addedNow
                    ? h('span.badge.success', 'Added')
                    : h('div.row', { style: { gap: 'var(--space-2)', alignItems: 'center' } },
                        h('span.badge.warning', String(r.reason ?? '').slice(0, 100)),
                        // Only offered when the reason is "never verified" —
                        // `status` is null for that case and set for every
                        // other rejection (risky, blocked, no email at all).
                        !r.status && r.email && h('button.btn.xs', {
                            disabled: r.verifying,
                            onclick: () => verifyAndRetry(r.id),
                        }, r.verifying ? 'Verifying…' : 'Verify')),
            )),
            items.length > 50 && h('p.xs.dim', `…and ${items.length - 50} more.`),
        );
        if (box) { box.replaceWith(next); box = next; } else { box = next; }
        return next;
    };

    async function verifyAndRetry(contactId) {
        const row = rows.get(contactId);
        row.verifying = true;
        repaint();
        try {
            await api.post(`/api/contacts/${contactId}/verify-email`, {});
            const result = await api.post(`/api/campaigns/${campaignId}/members`, {
                memberType: 'contact', ids: [contactId],
            });
            if (result.added || result.readded) {
                row.addedNow = true;
            } else if (result.undeliverable?.[0]) {
                row.reason = result.undeliverable[0].reason;
                row.status = result.undeliverable[0].status;
            }
        } catch (err) {
            row.reason = err.message;
        } finally {
            row.verifying = false;
            repaint();
        }
    }

    const initial = repaint();
    await modal({
        title: `${held.length} not added`,
        size: 'wide',
        body: initial,
        footer: (close) => [h('button.btn.primary', { onclick: () => close(true) }, 'OK')],
    });
}

async function addToCalling(selection, selectionState) {
    let meta;
    try {
        meta = await api.get('/api/calling/meta');
    } catch (err) {
        toast(err.message, 'error');
        return false;
    }
    if (!meta.sdrs.length) {
        toast('There is nobody to assign calling to yet. Invite a user first.', 'error');
        return false;
    }

    const picked = selectionState.ids.size;
    const count = selectionState.allMatching
        ? 'every contact matching this filter'
        : `${picked} contact${picked === 1 ? '' : 's'}`;
    const draft = { assignedTo: meta.sdrs[0].id, priority: 'B' };

    const chosen = await modal({
        title: 'Add to Cold Calling',
        body: h('div.stack',
            h('p.small', `Selected: `, h('strong', count)),
            h('div.field',
                h('label', 'Assign to'),
                h('select.input', { onchange: (e) => { draft.assignedTo = e.target.value; } },
                    meta.sdrs.map((s) => h('option', { value: s.id }, `${s.name} · ${s.role}`))),
            ),
            h('div.field',
                h('label', 'Priority'),
                h('select.input', { onchange: (e) => { draft.priority = e.target.value; } },
                    meta.priorities.map((p) => h('option', { value: p, selected: p === 'B' }, p))),
            ),
            h('p.xs.dim', 'A contact already on this person\'s queue is left alone. One on somebody '
                + 'else\'s queue is reported before anything moves.'),
        ),
        footer: (close) => [
            h('button.btn', { onclick: () => close(null) }, 'Cancel'),
            h('button.btn.primary', { onclick: () => close(draft) }, 'Add to Calling Queue'),
        ],
    });
    if (!chosen) return false;

    const send = async (extra) => api.post('/api/calling/assign', { ...selection, ...chosen, ...extra });

    try {
        let result = await send({});

        if (result.needsConfirmation && result.conflicts?.length) {
            const ok = await confirm({
                title: 'Already on another queue',
                message: `${result.message} Move ${result.conflicts.length === 1 ? 'it' : 'them'} to `
                    + `${result.sdr.name}? The calls already made stay with the contact.`,
                confirmLabel: 'Reassign',
                danger: true,
            });
            if (!ok) return false;
            result = await send({ reassign: true });
        }

        // A contact whose sequence already ran its course and retired them —
        // re-adding is a real decision (give this lead another shot), not
        // something that should silently grow a second history for the same
        // person with no one having chosen it. See lib/calling.mjs's own
        // comment on `reengage`.
        if (result.needsConfirmation && result.reengage?.length) {
            const ok = await confirm({
                title: 'Already called and retired',
                message: `${result.message} Add ${result.reengage.length === 1 ? 'it' : 'them'} back to the queue for another round?`,
                confirmLabel: 'Add anyway',
            });
            if (!ok) return false;
            result = await send({ reengage: true });
        }

        toast(result.message, 'success');
        // Leads with no phone number are skipped outright, not added — the
        // count is already spelled out in result.message above (see
        // describeAssignment), so no separate toast is needed here.
        if (result.withoutAccount) {
            // The pipeline board shows DEALS, and a deal belongs to an
            // account — a contact with none will call and work fine, but
            // never appears on the board, which reads as "adding to cold
            // calling does nothing" until someone knows to look here.
            toast(`${result.withoutAccount} of them have no account, so they will not show on the pipeline board.`, 'warning');
        }
        return true;
    } catch (err) {
        toast(err.message, 'error');
        return false;
    }
}

export async function pickCampaign() {
    try { await store.refreshCampaigns(); } catch { /* fall back to what is cached */ }

    const options = store.campaigns();
    const NEW = '__new__';
    const canCreate = store.can('record.write.all') || store.can('record.write.own');
    const draft = { name: '', channel: 'email', status: 'planned', service_line_key: '' };

    const select = h('select.input', {
        id: 'pick_campaign',
        onchange: () => paintNew(),
    },
    options.map((c) => h('option', { value: c.id }, `${c.name} (${c.status})`)),
    canCreate && h('option', { value: NEW }, options.length ? '＋ Create a new campaign…' : '＋ Create the first campaign…'),
    );
    if (!options.length && canCreate) select.value = NEW;

    const newFields = h('div');
    const paintNew = () => {
        if (select.value !== NEW) return mount(newFields);
        return mount(newFields, h('div.stack.tight',
            h('div.field', h('label', { for: 'new_campaign_name' }, 'Name'),
                h('input.input', {
                    id: 'new_campaign_name', dir: 'auto', value: draft.name,
                    placeholder: 'Q3 HCM outreach',
                    oninput: (e) => { draft.name = e.target.value; },
                })),
            h('div.field', h('label', { for: 'new_campaign_service' }, 'Service line'),
                h('select.input', {
                    id: 'new_campaign_service',
                    onchange: (e) => { draft.service_line_key = e.target.value; },
                },
                h('option', { value: '' }, '—'),
                store.serviceLines().map((s) => h('option', { value: s.key }, s.label)))),
            h('p.xs.dim', 'Created as a planned campaign. Its channel, dates and budget can be filled in on the '
                + 'Campaigns page — this is the shortest path from "these are the people" to "they are in it".'),
        ));
    };
    paintNew();

    const errorBox = h('div.error');

    return modal({
        title: 'Add to campaign',
        size: 'narrow',
        body: h('div.stack',
            errorBox,
            options.length === 0 && !canCreate
                ? h('p.small', 'There are no campaigns yet, and your role cannot create one.')
                : h('div.field', h('label', { for: 'pick_campaign' }, 'Campaign'), select),
            store.state.meta?.campaignsTruncated && h('p.xs.dim', `Showing ${options.length} of ${store.state.meta.campaignsTotal} campaigns.`),
            newFields,
            h('p.xs.dim', 'Members already in the campaign are left alone rather than duplicated.'),
        ),
        footer: (close) => [
            h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
            (options.length > 0 || canCreate) && h('button.btn.primary', {
                onclick: async (event) => {
                    const button = event.currentTarget;
                    if (select.value !== NEW) return close(select.value);
                    if (!draft.name.trim()) {
                        errorBox.textContent = 'Give the campaign a name.';
                        return undefined;
                    }
                    button.disabled = true;
                    try {
                        const { record } = await api.post('/api/campaigns', {
                            name: draft.name.trim(),
                            status: draft.status,
                            channel: draft.channel,
                            service_line_key: draft.service_line_key || null,
                        });
                        await store.refreshCampaigns();
                        return close(record.id);
                    } catch (err) {
                        errorBox.textContent = err.message;
                        button.disabled = false;
                        return undefined;
                    }
                },
            }, 'Add'),
        ],
    });
}


/**
 * Choosing — or creating — the list to add the selection to.
 *
 * Three things this gets right that the previous version did not:
 *
 *  1. It RE-READS the lists before deciding there are none. The store loads them
 *     once per session, so a list made in another tab, by a colleague, or before
 *     a long-lived tab was opened simply did not exist as far as this dialog was
 *     concerned — and it said so, confidently, while the Lists page showed it.
 *  2. A list belongs to ONE object. Lists of accounts cannot hold contacts, so
 *     an accounts list is not offered on the contacts page — but that is now
 *     STATED, because "you have no lists" and "you have none of THIS kind" look
 *     identical from here and only one of them is true.
 *  3. Having none is not a dead end. The list is created from this dialog, with
 *     the selection going into it, instead of sending the user to another page
 *     to come back and start the selection again.
 */
async function pickList(objectKey) {
    // Cheap, and it is the difference between an honest empty state and a lie.
    try { await store.refreshLists(); } catch { /* fall back to what is cached */ }

    const objectLabel = store.object(objectKey)?.plural ?? objectKey;
    const options = store.listsFor(objectKey).filter((l) => l.kind === 'static');
    const dynamic = store.listsFor(objectKey).filter((l) => l.kind === 'dynamic');
    const elsewhere = store.state.lists.filter((l) => l.object_key !== objectKey).length;

    const NEW = '__new__';
    const canCreate = store.can('list.write');
    const draft = { name: '', description: '' };

    const select = h('select.input', {
        id: 'pick_list',
        onchange: () => paintNew(),
    },
    options.map((l) => h('option', { value: l.id }, `${l.name} · ${number(l.count ?? 0)}`)),
    canCreate && h('option', { value: NEW }, options.length ? '＋ Create a new list…' : `＋ Create the first ${objectLabel.toLowerCase()} list…`),
    );
    // With no lists yet the create option is the only one, so it starts selected.
    if (!options.length && canCreate) select.value = NEW;

    const newFields = h('div');
    const paintNew = () => {
        if (select.value !== NEW) return mount(newFields);
        return mount(newFields, h('div.stack.tight',
            h('div.field', h('label', { for: 'new_list_name' }, 'Name'),
                h('input.input', {
                    id: 'new_list_name', dir: 'auto', value: draft.name,
                    placeholder: 'Q3 outreach push',
                    oninput: (e) => { draft.name = e.target.value; },
                })),
            h('div.field', h('label', { for: 'new_list_desc' }, 'Description'),
                h('input.input', {
                    id: 'new_list_desc', dir: 'auto', value: draft.description,
                    placeholder: 'Optional — what this list is for',
                    oninput: (e) => { draft.description = e.target.value; },
                })),
            h('p.xs.dim', `A static list of ${objectLabel.toLowerCase()}, curated by hand. The records you have `
                + 'selected go into it now; nothing joins or leaves it on its own.'),
        ));
    };
    paintNew();

    const errorBox = h('div.error');

    const chosen = await modal({
        title: 'Add to list',
        size: 'narrow',
        body: h('div.stack',
            errorBox,
            options.length === 0 && !canCreate
                ? h('p.small', `There are no ${objectLabel.toLowerCase()} lists yet, and your role cannot create one. `
                    + 'Ask an admin to make one.')
                : h('div.field', h('label', { for: 'pick_list' }, 'List'), select),
            newFields,
            // The likeliest reason a list "is missing": it belongs to a
            // different object. Said plainly rather than left to be guessed at.
            options.length === 0 && elsewhere > 0 && h('p.xs.dim',
                `You have ${elsewhere} list(s), but a list holds one kind of record and none of them holds `
                + `${objectLabel.toLowerCase()}. Make one here instead.`),
            dynamic.length > 0 && h('p.xs.dim',
                `${dynamic.length} dynamic list(s) are not shown: records join those by matching a filter, `
                + 'so they cannot be added to by hand. Edit the filter on the Lists page instead.'),
        ),
        footer: (close) => [
            h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
            (options.length > 0 || canCreate) && h('button.btn.primary', {
                onclick: async (event) => {
                    const button = event.currentTarget;
                    if (select.value !== NEW) return close(select.value);
                    if (!draft.name.trim()) {
                        errorBox.textContent = 'Give the list a name.';
                        return undefined;
                    }
                    button.disabled = true;
                    try {
                        const { list } = await api.post('/api/lists', {
                            object_key: objectKey, kind: 'static',
                            name: draft.name.trim(), description: draft.description.trim() || null,
                        });
                        return close(list.id);
                    } catch (err) {
                        errorBox.textContent = err.message;
                        button.disabled = false;
                        return undefined;
                    }
                },
            }, 'Add'),
        ],
    });

    return chosen ?? null;
}

export async function promptText(title, placeholder, initial = '') {
    const input = h('input.input', { value: initial, placeholder });
    return modal({
        title,
        size: 'narrow',
        body: h('div.field', input),
        footer: (close) => [
            h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
            h('button.btn.primary', { onclick: () => close(input.value.trim() || undefined) }, 'Save'),
        ],
    });
}

/**
 * Edit an existing view — rename and optionally save the current screen
 * (filter + columns + sort) into it. A view is ONE saved look: one filter
 * and one column order, not a filter-view plus a column-view. Updating keeps
 * them together, so "Large accounts in Egypt + pipeline columns" stays one
 * tab instead of becoming two.
 */
export async function editView(targetView, { objectKey, routeName, state } = {}) {
    if (!targetView) return;
    if (targetView.is_system) {
        toast('Built-in views cannot be edited. Save a copy instead.', 'error');
        return;
    }
    const nameInput = h('input.input', { value: targetView.name ?? '', placeholder: 'View name' });
    const updateCurrent = h('input', { type: 'checkbox', checked: true });
    const errorBox = h('div.error');

    const result = await modal({
        title: `Edit "${targetView.name}"`,
        size: 'narrow',
        body: h('div.stack',
            errorBox,
            h('div.field', h('label', 'Name'), nameInput),
            h('label.row', { style: { gap: 'var(--space-2)', alignItems: 'center', marginBlockStart: 'var(--space-2)' } },
                updateCurrent, h('span.small', 'Save current filter, sort and columns into this view')),
            h('p.xs.dim', 'When checked, the view will remember exactly what you see right now — the filter you built and the columns you chose — as one saved look.'),
            !targetView.owner_id || targetView.owner_id === store.state.me?.user?.id ? null
                : h('p.xs.dim', 'You do not own this view — you can still update it if you have view.share, otherwise save a copy.'),
        ),
        footer: (close) => [
            h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
            h('button.btn.primary', {
                onclick: async (event) => {
                    const btn = event.currentTarget;
                    const newName = nameInput.value.trim();
                    if (!newName) { errorBox.textContent = 'Give the view a name.'; return; }
                    btn.disabled = true;
                    try {
                        const patch = { name: newName };
                        if (updateCurrent.checked && state) {
                            // Persist the screen as it is — one filter + one column set, together.
                            const currentView = targetView;
                            // state.columns may be null (means view default); resolve to what the table actually shows
                            const effectiveColumns = state.columns
                                ?? currentView.columns
                                ?? store.fields(objectKey).filter((f) => f.listDefault).map((f) => f.key);
                            const effectiveFilter = state.filter ?? currentView.filter ?? null;
                            const effectiveSort = state.sort ?? currentView.sort ?? [];
                            patch.filter = effectiveFilter;
                            patch.sort = effectiveSort;
                            patch.columns = effectiveColumns;
                        }
                        await api.patch(`/api/views/${targetView.id}`, patch);
                        await store.refreshViews();
                        toast(`Updated "${newName}".`, 'success');
                        // Stay on the same view — its id did not change, but its definition did.
                        if (state && state.viewId === targetView.id) {
                            // Force a reload so the URL-driven state picks up the new definition
                            navigate(`/${routeName}?view=${targetView.id}`);
                        } else {
                            // Repaint tabs on this page
                            navigate(currentPath());
                        }
                        close(true);
                    } catch (err) {
                        errorBox.textContent = err.message;
                        btn.disabled = false;
                    }
                },
            }, 'Save'),
        ],
    });
    return result;
}

/**
 * The result of a re-qualification run.
 *
 * Named transitions, not just counts — and the dangerous ones (an account that
 * stopped qualifying) called out separately, because those are the ones a rep
 * has already been told to call.
 */
export function showQualificationResult(result) {
    const dangerous = result.changes.filter((c) => c.dangerous);
    return modal({
        title: 'Qualification run',
        size: 'wide',
        body: h('div.stack',
            h('div.grid', { style: { gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))' } },
                Object.entries(result.summary).map(([rule, counts]) => h('div.total-cell',
                    h('div.strong', rule),
                    h('div.row', { style: { gap: 'var(--space-2)', marginBlockStart: 'var(--space-2)' } },
                        ['QUALIFIED', 'REVIEW', 'REJECTED', 'UNRESOLVED', 'ERROR'].map((v) => h('span.row', { style: { gap: '0.2rem' } },
                            verdictBadge(v, { legend: true }), h('span.small.tabular', String(counts[v] ?? 0)),
                        )),
                    ),
                    h('div.xs.dim', { style: { marginBlockStart: 'var(--space-2)' } }, `${counts.changed} changed`),
                )),
            ),
            dangerous.length > 0 && h('div.note-box.warning',
                h('div.strong', `${dangerous.length} account(s) stopped qualifying`),
                h('ul', { style: { marginBlockStart: 'var(--space-2)', display: 'grid', gap: 'var(--space-1)' } },
                    dangerous.slice(0, 20).map((c) => h('li',
                        h('a', { href: `/accounts/${c.accountId}` }, c.accountName ?? c.accountId),
                        ` — ${c.rule}: ${c.from} → ${c.to}`,
                        c.hasOpenDeal && h('strong', ' · has an open deal'),
                    )),
                ),
            ),
            h('div.note-box',
                'Verdicts are appended, never overwritten. Every account still shows the version of the rule that '
                + 'produced each verdict, so "why did this change?" always has an answer.'),
        ),
        footer: (close) => h('button.btn.primary', { onclick: () => close(true) }, 'Close'),
    });
}
