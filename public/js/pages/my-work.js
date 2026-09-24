/**
 * My work — the one screen that answers "what am I supposed to do next?"
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Tasks, Activities, Notes and Documents each had a permanent row in the
 * sidebar. All four are RECORD TYPES, not destinations: nobody opens a CRM to
 * browse every note in the company. What a person actually wants is the subset
 * that belongs to them, and that subset was reachable only by opening a global
 * table and filtering it by hand — four items of navigation for a question none
 * of them asked.
 *
 * So the four rows became one, and this is what it points at. The global lists
 * are not gone: they are still routed, still linked from every record, and
 * still one search away. They are simply not four of the nine things a person
 * chooses between on arrival.
 *
 * ── IT IS BUILT ENTIRELY FROM THE GENERIC LIST API ──────────────────────────
 *
 * Three filtered reads through `/api/<object>`, which already scope by
 * permission and already understand `assignee_id` and `actor_id`. No endpoint
 * was added for this screen, and none should be: the moment it needs one, the
 * filter it wants is a filter every list should have.
 */
import { h, mount, navigate, params, setParams, date, clock, relative, number, humanise, toast, modal } from '../core.js';
import { api, listUrl } from '../api.js';
import * as store from '../store.js';
import {
    dataTable, emptyState, skeletonRows, errorState, statTile, icon,
    editEntity, entityActions,
} from '../components.js';
import { bulkEditActions, bulkDeleteAction } from '../bulk.js';
import { setPageTitle, isConfinedRole } from '../app.js';

/**
 * Re-rendering this screen from the card functions below it.
 *
 * The cards are module-level — they take data and return an element, which is
 * what makes them readable — but ticking a task off or creating one has to
 * refresh the counts above them. So the page publishes its own render here on
 * mount, rather than every card being handed a callback it mostly ignores.
 */
let rerender = () => {};

/** `field is any of [me]` — the shape the filter compiler expects. */
const mine = (field, userId) => ({ field, operator: 'is_any_of', value: [userId] });

/**
 * The three record types this screen is the home for, and the field on each
 * that means "this one is yours".
 *
 * Documents are deliberately absent. A document belongs to the account or deal
 * it was filed against, and "my documents" is not a question anybody asks --
 * they are reached from the record, where they mean something.
 */
/**
 * `people` is the pair of questions a manager asks of each of these.
 *
 * "Whose is it" and "who raised it" are different questions with different
 * answers — one is workload, the other is who is generating it — and only the
 * first was ever askable. They compile to an ordinary server-side filter, so
 * the count above the table and the rows in it move together; a dropdown that
 * changed a label and not the query would be worse than no dropdown.
 */
const SECTIONS = [
    {
        key: 'tasks', object: 'task', label: 'Tasks', icon: 'check', ownerField: 'assignee_id',
        people: [{ field: 'assignee_id', label: 'Assignee' }, { field: 'created_by', label: 'Created by' }],
    },
    {
        key: 'approvals', special: 'approvals', label: 'Approvals', icon: 'check',
        // Not a registry object — an OPEN-TASKS view over the three approval
        // kinds, each row linking straight to the document/deal it guards.
        // Gated on the capability that can actually act on one — a rep or SDR
        // holds neither, so the tab offering a queue of things they can only
        // ever fail to approve is not offered at all.
        when: () => store.can('document.approve'),
    },
    {
        key: 'activities', object: 'activity', label: 'Activities', icon: 'history', ownerField: 'actor_id',
        people: [{ field: 'actor_id', label: 'Performed by' }, { field: 'created_by', label: 'Created by' }],
    },
    {
        key: 'notes', object: 'note', label: 'Notes', icon: 'proposal', ownerField: 'author_id',
        people: [{ field: 'author_id', label: 'Author' }, { field: 'created_by', label: 'Created by' }],
    },
];

/**
 * A destination, not a dashboard.
 *
 * The summary is what you land on, but each record type is also one click away
 * as a real list -- sortable, paged, and switchable between MINE and
 * EVERYONE'S. Without that, folding four sidebar rows into one left the full
 * lists unreachable: two of the "All" links only rendered when their card had
 * content, so an empty Activities card offered no route to anybody's
 * activities, and a manager asking "what has the team logged this week" had
 * nowhere at all to go.
 */
export async function myWorkPage(content) {
    setPageTitle('My work');

    const me = store.state.me.user;
    const query = params();
    const sections = SECTIONS.filter((x) => !x.when || x.when());
    let tab = sections.some((x) => x.key === query.tab) ? query.tab : 'overview';
    /**
     * Whose work is shown. "Everyone" is drawn only for a role that may read
     * other people's records -- the server refuses it regardless, which is the
     * boundary that actually holds; this only avoids offering a control that
     * leads to a refusal.
     */
    let scope = query.scope === 'all' && store.can('record.read.all') ? 'all' : 'mine';
    let listPageNo = Number(query.page) || 1;
    /**
     * Whose work to show, by field, from the URL so a filtered view is a link.
     *
     * A manager who has narrowed to "Ahmed's tasks that Sara raised" should be
     * able to send that to Sara, and a refresh should not throw it away.
     */
    let people = {
        assignee_id: query.assignee_id ?? null,
        actor_id: query.actor_id ?? null,
        author_id: query.author_id ?? null,
        created_by: query.created_by ?? null,
    };
    let listSort = null;
    /**
     * What is ticked, and whether "every matching record" is ticked instead.
     *
     * These tabs are where a person's own tasks, activities and notes live, so
     * they are also where the tedious corrections happen: ten tasks to close,
     * six to reassign after somebody leaves, a batch of notes filed against the
     * wrong account. Doing that one record at a time is ten round trips to a
     * detail page and back, and the list page — which has had bulk actions all
     * along — is not where anybody looks for their own work.
     *
     * `allMatching` is deliberately separate from the ticks: the checkbox in
     * the header covers the page you can see, and acting on all 300 has to be
     * something you asked for by name.
     */
    let selection = new Set();
    let allMatching = false;
    const clearSelection = () => { selection = new Set(); allMatching = false; };

    const container = h('div.content-inner');
    mount(content, container);

    function tabsBar() {
        const seg = (key, label, iconName) => h('button.segment', {
            class: key === tab ? 'active' : '',
            'aria-pressed': String(key === tab),
            onclick: () => {
                tab = key; listPageNo = 1; listSort = null;
                clearSelection();
                setParams({ tab: key === 'overview' ? null : key, page: null });
                render();
            },
        }, icon(iconName), h('span', label));

        return h('div.queue-header',
            h('div.segmented', { role: 'group', 'aria-label': 'What to show' },
                seg('overview', 'Overview', 'dashboard'),
                sections.map((x) => seg(x.key, x.label, x.icon)),
            ),
            h('div.spacer'),
            tab !== 'overview' && store.can('record.read.all') && h('div.segmented',
                { role: 'group', 'aria-label': 'Whose work' },
                ['mine', 'all'].map((value) => h('button.segment', {
                    class: value === scope ? 'active' : '',
                    'aria-pressed': String(value === scope),
                    onclick: () => {
                        scope = value; listPageNo = 1;
                        clearSelection();
                        setParams({ scope: value === 'mine' ? null : value, page: null });
                        render();
                    },
                }, h('span', value === 'mine' ? 'Mine' : 'Everyone'))),
            ),

            peopleFilters(),
        );
    }

    /**
     * Filter by who it is for, and by who raised it.
     *
     * Offered to anybody who can read the whole workspace — which is the same
     * capability that draws the Everyone toggle beside it. A rep reading only
     * their own work has one name to choose from, so the controls would be
     * furniture; they are not drawn.
     */
    function peopleFilters() {
        const section = sections.find((x) => x.key === tab);
        if (!section?.people || !store.can('record.read.all')) return null;

        return h('div.row', { style: { gap: 'var(--space-2)' } },
            section.people.map(({ field, label }) => h('select.input.people-filter', {
                style: { inlineSize: 'auto' },
                'aria-label': label,
                onchange: (e) => {
                    people = { ...people, [field]: e.target.value || null };
                    listPageNo = 1;
                    clearSelection();
                    setParams({ [field]: e.target.value || null, page: null });
                    render();
                },
            },
            h('option', { value: '' }, `${label}: anyone`),
            store.users().map((u) => h('option', {
                value: u.id, selected: u.id === people[field],
            }, u.name)))),

            Object.values(people).some(Boolean) && h('button.btn.sm.ghost', {
                onclick: () => {
                    const cleared = {};
                    for (const { field } of section.people) cleared[field] = null;
                    people = cleared;
                    listPageNo = 1;
                    clearSelection();
                    setParams({ ...cleared, page: null });
                    render();
                },
            }, 'Clear'),
        );
    }

    function heading(section) {
        return h('div.record-header',
            h('div.record-title', h('h1', `Good to see you, ${String(me.name ?? '').split(' ')[0] || 'there'}`)),
            h('div.record-sub', h('span', section
                ? `${section.label}${scope === 'mine' ? ' assigned to you' : ' across the workspace'}.`
                : 'Everything assigned to you, in one place.')),
            confinedLinks(),
        );
    }

    /**
     * The way back out, for a role with no shell.
     *
     * A confined SDR reaches `/my-work` with no sidebar underneath it (see
     * `confinedPage` in app.js) — the only other screen they hold is
     * `/calling`, and without a link here that screen was reachable only by
     * editing the address bar. Mirrors the "My work" link `calling.js` already
     * carries on its own console, the same way, for the same reason.
     */
    function confinedLinks() {
        if (!isConfinedRole(store.state.me.role)) return null;
        return h('div.row', { style: { gap: 'var(--space-2)', marginBlockStart: 'var(--space-3)' } },
            h('a.btn.sm.ghost', { href: '/calling' }, 'Cold calling'),
            h('button.btn.sm.ghost', {
                onclick: () => api.post('/api/auth/logout', {}).then(() => { location.href = '/login'; }),
            }, 'Sign out'),
        );
    }

    /** One record type, as the ordinary list it always was. */
    async function listView(section) {
        const host = h('div');
        mount(host, skeletonRows(6));

        const columns = store.fields(section.object).filter((f) => f.listDefault).map((f) => f.key);

        /**
         * One filter, built from every control on screen.
         *
         * "Mine" and the two people dropdowns are `and`-ed together, so
         * "assignee Ahmed, created by Sara" narrows to the intersection rather
         * than the last control touched winning. Sent to the server, which is
         * what makes the total honest — filtering 50 fetched rows in the
         * browser reports "12 of 3,400" and means neither number.
         */
        const children = [];
        if (scope === 'mine') children.push(mine(section.ownerField, me.id));
        for (const { field } of section.people ?? []) {
            if (people[field]) children.push(mine(field, people[field]));
        }
        const filter = children.length ? { op: 'and', children } : null;

        let data;
        try {
            data = await api.get(listUrl(section.key, { page: listPageNo, limit: 50, filter, sort: listSort }));
        } catch (err) {
            mount(host, errorState(err.message, () => render()));
            return host;
        }

        /**
         * "Nothing has been recorded in this workspace yet" is a lie when a
         * filter is on.
         *
         * An empty result that is empty BECAUSE of a filter reads as an empty
         * database, and the next thing somebody does is go and check whether
         * the data is gone. So the message names the filter and offers to
         * clear it.
         */
        const narrowed = (section.people ?? []).filter(({ field }) => people[field]);
        const nothingHere = narrowed.length
            ? `No ${section.label.toLowerCase()} match `
              + narrowed.map(({ field, label }) => `${label.toLowerCase()} ${store.userName(people[field])}`).join(' and ')
              + '. The records are still there — this filter does not match any of them.'
            : scope === 'mine'
                ? 'Nothing here is assigned to you. Anything you are given, or log yourself from a record, '
                  + `collects here.${store.can('record.read.all') ? ' Switch to Everyone to see the whole workspace.' : ''}`
                : 'Nothing of this kind has been recorded in this workspace yet.';

        /**
         * Ticking a box repaints; it does not reload.
         *
         * The table is drawn from `data` that has already arrived, so selecting
         * a row is a redraw of what is on screen rather than another round trip
         * to the server for the same fifty records.
         */
        const paintList = () => mount(host, h('div.card', h('div.card-body.flush',
            data.records.length === 0
                ? emptyState(`No ${section.label.toLowerCase()}`, nothingHere,
                    narrowed.length ? h('button.btn', {
                        onclick: () => {
                            const cleared = {};
                            for (const { field } of section.people) cleared[field] = null;
                            people = cleared;
                            clearSelection();
                            setParams({ ...cleared, page: null });
                            render();
                        },
                    }, 'Clear the filter') : null)
                : dataTable({
                    objectKey: section.object,
                    records: data.records,
                    columns,
                    total: data.total,
                    page: data.page,
                    pages: data.pages,
                    sort: listSort ?? [],
                    selection,
                    allSelected: allMatching,
                    rowHref: (r) => `/${section.key}/${r.id}`,
                    onSort: (key) => {
                        const was = (listSort ?? []).find((x) => x.field === key);
                        listSort = [{ field: key, direction: was?.direction === 'asc' ? 'desc' : 'asc' }];
                        render();
                    },
                    onPage: (next) => {
                        listPageNo = next;
                        // The ticks belonged to the page being left; "all
                        // matching" is page-independent and survives.
                        selection = new Set();
                        setParams({ page: next > 1 ? next : null });
                        render();
                    },
                    onSelect: (ids, checked) => {
                        // Touching a checkbox by hand while "all matching" is on
                        // hands control back to the ticks — the two cannot both
                        // be what the user meant.
                        if (allMatching) clearSelection();
                        for (const id of ids) {
                            if (checked) selection.add(id);
                            else selection.delete(id);
                        }
                        paintList();
                    },
                    onClear: () => { clearSelection(); paintList(); },
                    bulkActions: bulkBar(section, data, filter, paintList),
                }),
        )));
        paintList();
        return host;
    }

    /**
     * The bulk bar, built from the shared actions.
     *
     * Every button here is the same one the list page draws, running the same
     * preview-then-write — so completing eight tasks from My work and doing it
     * from the Tasks list are the same operation, not two implementations that
     * will drift.
     */
    function bulkBar(section, data, filter, paintList) {
        const objectKey = section.object;
        const routeName = section.key;
        const total = data.total ?? 0;

        /**
         * What the buttons act on. "All matching" sends the SERVER the filter
         * the screen was built from, so it means every record behind the
         * paging — not the fifty that happen to be loaded.
         */
        const selectionPayload = () => (allMatching
            ? { all: true, filter }
            : { ids: [...selection] });
        const disabled = !allMatching && selection.size === 0;

        const onDone = () => { clearSelection(); render(); };

        return h('div.row',
            // The table already says how many are ticked. This says the one
            // thing it cannot know: that the selection is bigger than the page.
            allMatching && h('span.xs.dim', `all ${number(total)} matching`),

            data.pages > 1 && h('button.btn.sm.ghost', {
                title: allMatching
                    ? 'Clear the select-all-matching selection.'
                    : `Select all ${number(total)} records matching these filters — every page, not just this one.`,
                onclick: () => {
                    allMatching = !allMatching;
                    if (!allMatching) selection = new Set();
                    paintList();
                },
            }, allMatching ? 'Clear all' : `Select all matching (${number(total)})`),

            ...bulkEditActions({ objectKey, routeName, selection: selectionPayload, disabled, onDone }),
            bulkDeleteAction({ objectKey, routeName, selection: selectionPayload, disabled, onDone }),
        );
    }

    rerender = () => { render(); };

    async function render() {
        const section = sections.find((x) => x.key === tab);
        const body = h('div');
        mount(container, heading(section), tabsBar(), body);
        mount(body, section?.special === 'approvals' ? await approvalsView() : section ? await listView(section) : await overview());
    }

    /**
     * APPROVALS — one queue across proposals, agreements and price changes.
     *
     * These were three separate places a manager had to remember; the task
     * store already knows about all of them, so this is a filtered view over
     * open approval tasks with the document deep-link the Tasks tab draws.
     * Anyone who can act on at least one kind sees the tab; what they can
     * actually approve is still decided server-side per document.
     */
    /**
     * The document's own decision, from a task row — never the task itself.
     *
     * This used to PATCH the task straight to `done`, which cleared it from
     * the queue without ever calling the review endpoint: the proposal,
     * agreement or price change stayed exactly where it was — pending
     * forever, nobody notified, no record anyone decided anything. Routing
     * through the same `/review` endpoints the record page's Approve/Reject
     * buttons use is what actually moves the document and closes the task
     * as a side effect of that (see `closeApprovalTask`, lib/approvals.mjs).
     */
    async function reviewFromWorklist(t, decision) {
        let meta = {};
        try { meta = JSON.parse(t.properties ?? '{}')?.approval ?? {}; } catch { /* keep {} */ }

        const rejecting = decision === 'rejected';
        const note = h('textarea.input', {
            rows: 3,
            placeholder: rejecting ? 'What needs to change before this can go out?' : 'Optional',
        });
        const done = await modal({
            title: rejecting ? 'Reject this document' : 'Approve this document',
            body: h('div.stack',
                h('div.strong', t.title),
                h('div.field', h('label', rejecting ? 'Reason' : 'Note'), note),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h(`button.btn.${rejecting ? 'danger' : 'primary'}`, {
                    onclick: async (event) => {
                        const button = event.currentTarget;
                        button.disabled = true;
                        try {
                            if (t.parent_type === 'deal_price') {
                                await api.post(`/api/deals/${meta.deal_id}/price-periods/${t.parent_id}/review`, {
                                    decision, note: note.value,
                                });
                            } else if (t.parent_type === 'people_enrich') {
                                await api.post(`/api/people-enrich-requests/${t.parent_id}/review`, {
                                    decision, note: note.value,
                                });
                            } else if (t.parent_type === 'contact_reassign') {
                                await api.post(`/api/calling/reassign-requests/${t.parent_id}/review`, {
                                    decision, note: note.value,
                                });
                            } else {
                                await api.post(`/api/${t.parent_type}s/${t.parent_id}/review`, {
                                    decision, note: note.value,
                                });
                            }
                            close(true);
                        } catch (err) {
                            button.disabled = false;
                            toast(err.message, 'error');
                        }
                    },
                }, rejecting ? 'Reject' : 'Approve'),
            ],
        });
        if (done) render();
    }

    async function approvalsView() {
        const host = h('div');
        mount(host, skeletonRows(4));
        const kinds = ['proposal', 'agreement', 'deal_price', 'people_enrich', 'contact_reassign'];
        /**
         * Assigned to ME — `openApprovalTask` (lib/approvals.mjs) writes one
         * task per approving role, each with its own `assignee_id`, so this is
         * a real per-person filter, not an approximation. It used to fetch the
         * page's whole open-task list unfiltered and narrow it client-side to
         * kind + status only, which showed every colleague's pending approvals
         * too — a wider set than the dashboard's "Approvals waiting on you"
         * tile, which counts only the viewer's own (see `attention()` in
         * api/dashboard.mjs). Whoever decides first still closes every copy
         * (`closeApprovalTask`), so a personal filter here changes what is
         * SHOWN, not who may act.
         */
        const data = await api.get(listUrl('tasks', {
            filter: {
                op: 'and',
                children: [
                    mine('assignee_id', me.id),
                    { field: 'status', operator: 'is_any_of', value: ['open'] },
                ],
            },
            page: 1, limit: 100, sort: [{ field: 'due_at', direction: 'asc' }],
        })).catch(() => ({ records: [] }));
        const rows = (data.records ?? []).filter((t) => kinds.includes(t.parent_type));
        if (!rows.length) {
            return h('div.card', h('div.card-body',
                emptyState('Nothing waiting on you',
                    'Proposals, agreements and price changes submitted for review appear here with a direct link to the document.')));
        }
        return h('div.card',
            h('div.card-header', h('h2', 'Waiting for review'), h('div.actions', h('span.xs.dim', `${rows.length} open`))),
            h('div.card-body.flush', h('div.table-wrap', h('table.data',
                h('thead', h('tr', h('th', 'Document'), h('th', 'Kind'), h('th', 'Submitted'), h('th', ''))),
                h('tbody', rows.map((t) => {
                    let href = null;
                    try {
                        const meta = JSON.parse(t.properties ?? '{}')?.approval ?? {};
                        href = t.parent_type === 'deal_price'
                            ? (meta.deal_id ? `/deals/${meta.deal_id}` : null)
                            : t.parent_type === 'people_enrich'
                                ? (t.account_id ? `/accounts/${t.account_id}` : null)
                                : t.parent_type === 'contact_reassign'
                                    ? (meta.contact_id ? `/contacts/${meta.contact_id}` : null)
                                    : `/${t.parent_type}s/${t.parent_id}`;
                    } catch { /* keep null */ }
                    // Different capability per kind, matching what the review
                    // endpoint itself requires — document.approve for a
                    // proposal/agreement, record.write.all for a price change
                    // or a contact reveal (api/proposals.mjs, lib/repo.mjs,
                    // api/people-search.mjs's reviewEnrichRequest), calling.manage
                    // for a reassignment (api/calling.mjs's reviewReassignRequest).
                    const canReview = t.parent_type === 'deal_price' || t.parent_type === 'people_enrich'
                        ? store.can('record.write.all')
                        : t.parent_type === 'contact_reassign'
                            ? store.can('calling.manage')
                            : store.can('document.approve');
                    return h('tr',
                        h('td', href
                            ? h('a.cell-link', { href }, t.title)
                            : t.title),
                        h('td', h('span.badge.accent', humanise(t.parent_type))),
                        h('td', { title: date(t.created_at, { withTime: true }) }, relative(t.created_at)),
                        h('td.num', canReview
                            ? h('div.row', { style: { gap: '0.15rem', justifyContent: 'flex-end' } },
                                h('button.btn.sm.primary', { onclick: () => reviewFromWorklist(t, 'approved') }, 'Approve'),
                                h('button.btn.sm', { onclick: () => reviewFromWorklist(t, 'rejected') }, 'Reject'))
                            : (href ? h('a.btn.sm', { href }, 'Open') : null)),
                    );
                })),
            ))),
        );
    }

    async function overview() {
        const host = h('div');
        mount(host, skeletonRows(6));

    /**
     * Three independent reads, in parallel and individually forgiving.
     *
     * A workspace that has never logged an activity should still see its tasks.
     * One failing read leaves its own card empty and says so, rather than
     * replacing the whole screen with an error — which is what a single
     * `Promise.all` and one `await` chain would have done.
     */
    const [tasks, activities, notes] = await Promise.all([
        api.get(listUrl('tasks', {
            filter: {
                op: 'and',
                children: [
                    mine('assignee_id', me.id),
                    { field: 'status', operator: 'is_any_of', value: ['open', 'in_progress'] },
                ],
            },
            sort: [{ field: 'due_at', direction: 'asc' }],
            limit: 25,
        })).catch(() => null),

        api.get(listUrl('activities', {
            filter: { op: 'and', children: [mine('actor_id', me.id)] },
            sort: [{ field: 'occurred_at', direction: 'desc' }],
            limit: 12,
        })).catch(() => null),

        api.get(listUrl('notes', {
            filter: { op: 'and', children: [mine('author_id', me.id)] },
            sort: [{ field: 'created_at', direction: 'desc' }],
            limit: 8,
        })).catch(() => null),
    ]);

    /**
     * Overdue is counted against the READER's clock.
     *
     * A task due at 5pm in Riyadh is not overdue at 3pm in Riyadh, whatever the
     * server's timezone happens to be — the same rule the dashboard's task
     * widget follows.
     */
    const nowMs = Date.now();
    const overdue = (tasks?.records ?? []).filter((t) => t.due_at && new Date(t.due_at).getTime() < nowMs);
    const dueToday = (tasks?.records ?? []).filter((t) => {
        if (!t.due_at) return false;
        const due = new Date(t.due_at);
        return due.getTime() >= nowMs && due.toDateString() === new Date().toDateString();
    });

    mount(host,
        h('div.totals-grid', { style: { marginBlockEnd: 'var(--space-4)' } },
            h('div.total-cell', statTile('Open tasks', number(tasks?.total ?? 0))),
            h('div.total-cell', statTile('Overdue', number(overdue.length),
                overdue.length ? 'Past their due date' : 'Nothing is late')),
            h('div.total-cell', statTile('Due today', number(dueToday.length))),
        ),

        h('div.grid',
            h('div.span-8', taskCard(tasks, overdue)),
            h('div.span-4', h('div.stack',
                activityCard(activities),
                noteCard(notes),
            )),
        ),
        );
        return host;
    }

    await render();
    return undefined;
}

/* ------------------------------------------------------------------ cards -- */

function cardShell(title, action, body) {
    return h('div.card',
        h('div.card-header', h('h2', title), action && h('div.actions', action)),
        h('div.card-body', body),
    );
}

/**
 * A way through to the full list, on EVERY branch including the empty ones.
 *
 * It used to be omitted when a card had nothing in it, which is exactly the
 * moment somebody wants to look wider: an empty "What I logged" offered no
 * route to what anybody else had logged.
 */
const seeAll = (tab, label) => h('a.btn.sm', { href: `/my-work?tab=${tab}` }, label);

function taskCard(tasks, overdue) {
    if (!tasks) {
        return cardShell('Tasks', seeAll('tasks', 'All tasks'),
            h('p.small.dim', 'Your tasks could not be loaded just now. Reloading usually fixes it.'));
    }
    if (!tasks.records.length) {
        return cardShell('Tasks', taskCardActions(),
            emptyState('Nothing assigned to you',
                'Tasks you are given, or give yourself from a record, appear here with the closest due date first.',
                h('button.btn.primary', { onclick: () => newTask() }, '+ New task')));
    }

    const overdueIds = new Set(overdue.map((t) => t.id));

    return cardShell('Tasks', taskCardActions(),
        h('div.stack.tight',
            overdue.length > 0 && h('div.note-box.warning',
                `${overdue.length} ${overdue.length === 1 ? 'task is' : 'tasks are'} past due.`),

            h('div.table-wrap', h('table.data',
                h('thead', h('tr',
                    h('th', { style: { inlineSize: '2rem' } }, ''),
                    h('th', 'Task'), h('th', 'Account'), h('th', 'Priority'), h('th', 'Due'), h('th', ''),
                )),
                h('tbody', tasks.records.map((t) => h('tr', { class: overdueIds.has(t.id) ? 'row-danger' : '' },
                    /**
                     * Approval tasks carry parent_type=proposal/agreement — link
                     * straight to the DOCUMENT needing review rather than to a
                     * generic task page. Every other task keeps its own route.
                     */
                    h('td', h('input', {
                        type: 'checkbox',
                        'aria-label': `Mark ${t.title} done`,
                        onchange: async (e) => {
                            const box = e.target;
                            const row = box.closest('tr');
                            box.disabled = true;
                            row.style.opacity = box.checked ? '0.5' : '';
                            try {
                                await api.patch(`/api/tasks/${t.id}`, { status: box.checked ? 'done' : 'open' });
                                rerender();
                            } catch (err) {
                                box.checked = !box.checked;
                                row.style.opacity = '';
                                box.disabled = false;
                                toast(err.message, 'error');
                            }
                        },
                    })),
                    h('td', (() => {
                        // Approval tasks link to the thing needing review: a
                        // proposal or agreement to itself, a PRICE CHANGE to the
                        // deal it would move (the approval lives on the deal's
                        // price history — a price period has no page of its own).
                        let href = `/tasks/${t.id}`;
                        if (t.parent_type === 'proposal' || t.parent_type === 'agreement') {
                            href = `/${t.parent_type}s/${t.parent_id}`;
                        } else if (t.parent_type === 'deal_price') {
                            let dealId = null;
                            try { dealId = JSON.parse(t.properties ?? '{}')?.approval?.deal_id ?? null; } catch { /* unparseable keeps the fallback */ }
                            if (dealId) href = `/deals/${dealId}`;
                        } else if (t.parent_type === 'people_enrich' && t.account_id) {
                            href = `/accounts/${t.account_id}`;
                        }
                        const docLink = href !== `/tasks/${t.id}`;
                        return h('a.cell-link', { href },
                            t.title,
                            docLink ? h('span.badge.accent', { style: { marginInlineStart: 'var(--space-1)' } }, 'Review') : null,
                        );
                    })()),
                    h('td', t.account_id
                        ? h('a', { href: `/accounts/${t.account_id}` }, t.account_name ?? 'Account')
                        : h('span.dim', '—')),
                    h('td', h(`span.badge${{ A: '.danger', B: '.warning' }[t.priority] ?? ''}`,
                        t.priority)),
                    /**
                     * The distance in the cell, the time beside it, the full
                     * date on hover.
                     *
                     * A due date is read as "in two days" — but a follow-up call
                     * the rep promised for half two is an appointment, and
                     * "tomorrow" is not enough to keep it. `clock` is empty for
                     * anything stored without a time of day, so ordinary tasks
                     * look exactly as they did.
                     */
                    h('td', t.due_at
                        ? h('span', { title: date(t.due_at, { withTime: true }) },
                            relative(t.due_at),
                            clock(t.due_at) ? h('span.dim', ` · ${clock(t.due_at)}`) : null)
                        : h('span.dim', 'No date')),
                    h('td', entityActions('task', t, { onDone: () => rerender(), name: t.title })),
                ))),
            )),

            tasks.total > tasks.records.length && h('p.xs.dim',
                `Showing ${tasks.records.length} of ${number(tasks.total)}.`),
        ),
    );
}

/**
 * The Tasks card's header: create one, or go and see them all.
 *
 * A screen called My Work that could not create a piece of work sent people to
 * a record page to make a task about something that was not on a record.
 */
function taskCardActions() {
    return h('div.row', { style: { gap: 'var(--space-2)' } },
        h('button.btn.sm.primary', { onclick: () => newTask() }, '+ New task'),
        seeAll('tasks', 'All tasks'),
    );
}

async function newTask() {
    const saved = await editEntity('task', {
        title: 'New task',
        defaults: {
            assignee_id: store.state.me.user.id,
            priority: 'B',
            status: 'open',
        },
    });
    if (saved) rerender();
}

function activityCard(activities) {
    if (!activities) {
        return cardShell('What I logged', seeAll('activities', 'All'), h('p.small.dim', 'Could not be loaded just now.'));
    }
    if (!activities.records.length) {
        return cardShell('What I logged', seeAll('activities', 'All'),
            h('p.small.dim', 'Calls, emails and meetings you log against a record show up here, newest first.'));
    }

    return cardShell('What I logged', seeAll('activities', 'All'),
        h('div.stack.tight', activities.records.map((a) => h('div.stack.tight',
            h('div.row.between',
                h('span.small.truncate', { dir: 'auto' }, a.subject || humanise(a.type_key)),
                h('span.xs.dim', { title: date(a.occurred_at, { withTime: true }) }, relative(a.occurred_at)),
            ),
            a.account_id && h('a.xs.dim', { href: `/accounts/${a.account_id}` }, a.account_name ?? 'Account'),
        ))),
    );
}

function noteCard(notes) {
    if (!notes) return cardShell('My notes', seeAll('notes', 'All'), h('p.small.dim', 'Could not be loaded just now.'));
    if (!notes.records.length) {
        return cardShell('My notes', seeAll('notes', 'All'),
            h('p.small.dim', 'Notes you write on an account or a deal collect here.'));
    }

    return cardShell('My notes', seeAll('notes', 'All'),
        h('div.stack.tight', notes.records.map((n) => h('div.stack.tight',
            // A note is free text and can be long; two lines of it is enough to
            // recognise which one it is.
            h('div.xs.truncate', { dir: 'auto', title: n.body }, n.body),
            h('div.row.between',
                n.account_id
                    ? h('a.xs.dim', { href: `/accounts/${n.account_id}` }, n.account_name ?? 'Account')
                    : h('span.xs.dim', '—'),
                h('span.xs.dim', relative(n.created_at)),
            ),
        ))),
    );
}
