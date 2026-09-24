/**
 * Saved lists.
 *
 *   STATIC   a curated set. Records are added by hand and stay until removed.
 *   DYNAMIC  a saved filter. Records join and leave on their own as they change.
 *
 * Both are useful and they are not the same thing: "the 40 companies in the Q3
 * push" is a static list you hand to someone; "every account whose HCM verdict
 * is REVIEW" is a dynamic one that should shrink as the queue is worked.
 */
import { h, mount, toast, modal, confirm, number, captureFocus, restoreFocus } from '../core.js';
import { api } from '../api.js';
import * as store from '../store.js';
import { filterBuilder, emptyState, errorState,} from '../components.js';
import { setPageTitle } from '../app.js';

export async function listsPage(content) {
    setPageTitle('Lists');
    const container = h('div.content-inner');
    mount(content, container);

    async function load() {
        // Reloaded after every create, edit and delete. Without this the page
        // keeps showing the list somebody just changed, as though nothing had.
        try {
            await store.refreshLists();
            await store.refreshViews();
        } catch (err) {
            mount(container, errorState(err.message, () => load()));
            return;
        }
        paint();
    }

    function paint() {
        const lists = store.state.lists;
        mount(container,
            h('div.card',
                h('div.card-header',
                    h('h2', 'Lists'),
                    h('div.actions',
                        store.can('list.write') && h('button.btn.sm.primary', { onclick: () => createList() }, '+ New list'),
                    ),
                ),
                h('div.card-body.flush',
                    lists.length === 0
                        ? emptyState('No lists yet',
                            'A list is a named set of records you can hand to someone. Static lists are curated by hand; '
                            + 'dynamic lists are a saved filter that re-evaluates.',
                            store.can('list.write') && h('button.btn.primary', { onclick: () => createList() }, 'Create the first list'))
                        : h('div.table-wrap', h('table.data',
                            h('thead', h('tr', h('th', 'Name'), h('th', 'Object'), h('th', 'Kind'), h('th.num', 'Records'), h('th', ''))),
                            h('tbody', lists.map((l) => h('tr',
                                h('td',
                                    h('a.cell-link', { href: `/${store.object(l.object_key)?.route ?? l.object_key}?list=${l.id}` }, l.name),
                                    l.description && h('div.xs.dim', l.description),
                                ),
                                h('td', store.object(l.object_key)?.plural ?? l.object_key),
                                h('td', h('span.badge', { class: l.kind === 'dynamic' ? 'accent' : '' },
                                    l.kind === 'dynamic' ? 'dynamic' : 'static')),
                                h('td.num', number(l.count)),
                                h('td.row',
                                    store.can('list.write') && h('button.btn.sm.ghost', { onclick: () => editList(l) }, 'Edit'),
                                    store.can('list.write') && h('button.btn.sm.ghost', {
                                        onclick: async () => {
                                            if (!await confirm({
                                                title: `Delete "${l.name}"?`,
                                                message: 'The list is removed. The records in it are untouched.',
                                                confirmLabel: 'Delete', danger: true,
                                            })) return;
                                            await api.delete(`/api/lists/${l.id}`);
                                            load();
                                        },
                                    }, 'Delete'),
                                ),
                            ))),
                        )),
                ),
            ),

            h('div.card',
                h('div.card-header', h('h2', 'Saved views')),
                h('div.card-body.flush',
                    h('div.table-wrap', h('table.data',
                        h('thead', h('tr', h('th', 'View'), h('th', 'Object'), h('th', 'Type'), h('th.num', 'Filters'), h('th', 'Shared'), h('th', ''))),
                        h('tbody', store.state.views.map((v) => h('tr',
                            h('td', h('a.cell-link', { href: `/${store.object(v.object_key)?.route}?view=${v.id}` }, v.name)),
                            h('td', store.object(v.object_key)?.plural ?? v.object_key),
                            h('td', h('span.badge', v.view_type)),
                            h('td.num', String(v.conditionCount)),
                            h('td', v.scope === 'workspace' ? h('span.badge.accent', 'workspace') : h('span.dim.xs', 'private')),
                            h('td', !v.is_system && h('button.btn.sm.ghost', {
                                onclick: async () => {
                                    if (!await confirm({ title: `Delete "${v.name}"?`, message: 'The view is removed; records are untouched.', confirmLabel: 'Delete', danger: true })) return;
                                    await api.delete(`/api/views/${v.id}`);
                                    load();
                                },
                            }, 'Delete')),
                        ))),
                    )),
                ),
            ),
        );
    }

    async function createList() {
        const draft = { object_key: 'account', kind: 'static', name: '', description: '', filter: { op: 'and', children: [] } };
        const filterHost = h('div');
        const errorBox = h('div.error');

        const repaintFilter = () => {
            mount(filterHost, draft.kind === 'dynamic'
                ? h('div.stack.tight',
                    h('div.strong.small', 'Filter'),
                    filterBuilder(draft.object_key, draft.filter, (next) => { draft.filter = next; }),
                )
                : h('p.xs.dim', 'A static list starts empty. Add records to it from any list view using the bulk bar.'));
        };
        repaintFilter();

        const created = await modal({
            title: 'New list',
            size: 'wide',
            body: h('div.stack',
                errorBox,
                h('div.field', h('label', 'Name'),
                    h('input.input', { dir: 'auto', oninput: (e) => { draft.name = e.target.value; } })),
                h('div.field', h('label', 'Description'),
                    h('input.input', { dir: 'auto', oninput: (e) => { draft.description = e.target.value; } })),
                h('div.field', h('label', 'Object'),
                    h('select.input', {
                        onchange: (e) => { draft.object_key = e.target.value; draft.filter = { op: 'and', children: [] }; repaintFilter(); },
                    // Internal objects are registered for their fields, not as
                    // things a user picks — the calling queue is not a list you
                    // build, it is a queue somebody works.
                    }, store.selectableObjects().map((o) => h('option', { value: o.key }, o.plural)))),
                h('div.field', h('label', 'Kind'),
                    h('select.input', { onchange: (e) => { draft.kind = e.target.value; repaintFilter(); } },
                        h('option', { value: 'static' }, 'Static — curated by hand'),
                        h('option', { value: 'dynamic' }, 'Dynamic — a saved filter that re-evaluates')),
                    h('span.help', 'A dynamic list changes as records change. A static one only changes when someone edits it.')),
                filterHost,
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', {
                    onclick: async (event) => {
                        const button = event.currentTarget;
                        if (!draft.name.trim()) { errorBox.textContent = 'Give the list a name.'; return; }
                        button.disabled = true;
                        try {
                            const result = await api.post('/api/lists', draft);
                            close(result.list);
                        } catch (err) {
                            errorBox.textContent = err.message;
                            button.disabled = false;
                        }
                    },
                }, 'Create'),
            ],
        });
        if (created) load();
    }

    /**
     * Editing a list.
     *
     * Everything a list has that can change is here: its name, its description
     * and — for a dynamic one — its filter. The page previously offered "Edit
     * filter" on dynamic lists and nothing at all on static ones, so a static
     * list with a typo in its name could only be deleted and made again, taking
     * its members with it.
     *
     * What is NOT editable is the object and the kind. Both would silently
     * invalidate the members: an accounts list holding contact ids, or a curated
     * list whose members are replaced by whatever a filter happens to match.
     * Deliberately absent rather than forgotten.
     */
    async function editList(list) {
        const draft = { name: list.name, description: list.description ?? '' };
        let working = list.filter;
        const errorBox = h('div.error');

        const host = h('div');
        const repaint = () => {
            if (list.kind !== 'dynamic') return;
            const focus = captureFocus(host);
            mount(host, h('div.stack.tight',
                h('div.strong.small', 'Filter'),
                filterBuilder(list.object_key, working, (next) => { working = next; repaint(); }),
            ));
            restoreFocus(host, focus);
        };
        repaint();

        const saved = await modal({
            title: `Edit "${list.name}"`,
            size: list.kind === 'dynamic' ? 'wide' : 'narrow',
            body: h('div.stack',
                errorBox,
                h('div.field', h('label', { for: 'list_name' }, 'Name'),
                    h('input.input', {
                        id: 'list_name', dir: 'auto', value: draft.name,
                        oninput: (e) => { draft.name = e.target.value; },
                    })),
                h('div.field', h('label', { for: 'list_desc' }, 'Description'),
                    h('input.input', {
                        id: 'list_desc', dir: 'auto', value: draft.description,
                        oninput: (e) => { draft.description = e.target.value; },
                    })),
                h('p.xs.dim',
                    `${store.object(list.object_key)?.plural ?? list.object_key} · `
                    + (list.kind === 'dynamic'
                        ? 'dynamic — membership follows the filter below'
                        : 'static — membership is curated by hand')
                    + '. Neither can be changed after the list is made: both would leave the '
                    + 'records already in it pointing at nothing.'),
                host,
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', {
                    onclick: async (event) => {
                        const button = event.currentTarget;
                        if (!draft.name.trim()) { errorBox.textContent = 'Give the list a name.'; return; }
                        button.disabled = true;
                        try {
                            await api.patch(`/api/lists/${list.id}`, {
                                name: draft.name.trim(),
                                description: draft.description.trim() || null,
                                ...(list.kind === 'dynamic' ? { filter: working } : {}),
                            });
                            close(true);
                        } catch (err) {
                            errorBox.textContent = err.message;
                            button.disabled = false;
                        }
                    },
                }, 'Save'),
            ],
        });
        if (!saved) return;
        toast(list.kind === 'dynamic'
            ? 'Saved. The list re-evaluates immediately.'
            : 'Saved.', 'success');
        load();
    }

    await load();
    return undefined;
}
