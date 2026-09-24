/**
 * Search across every record.
 *
 * The command palette (Ctrl/Cmd K) is for "take me to that one thing I am half
 * remembering". This page is for "show me everything that mentions this" — a
 * phone number, a domain, a person's name — across accounts, contacts, deals,
 * campaigns, tasks, notes, documents and activities at once.
 *
 * Two things it is careful about:
 *
 *  - The per-object counts describe the WHOLE match, not the visible page. A
 *    chip reading "Contacts 41" that means "41 on this page" is a lie the user
 *    only catches after acting on it.
 *  - When the scan hits its ceiling it says so. "Showing the best 200 of 1,400"
 *    is honest; silently returning 200 implies the other 1,200 do not exist.
 */
import { h, mount, navigate, setParams, debounce, humanise, captureFocus, restoreFocus } from '../core.js';
import { api } from '../api.js';
import * as store from '../store.js';
import { emptyState, skeletonRows } from '../components.js';
import { setPageTitle } from '../app.js';

export async function searchPage(content, query = {}) {
    setPageTitle('Search');
    const container = h('div.content-inner');
    mount(content, container);

    const state = {
        q: query.q ?? '',
        object: query.object ?? null,
        data: null,
        loading: false,
    };

    /**
     * Which request the results on screen belong to.
     *
     * Now that a slower query no longer blanks the page while it runs, two can
     * be in flight at once — and the older one must not be allowed to land on
     * top of the newer one's answer.
     */
    let sequence = 0;

    const input = h('input.input', {
        type: 'search',
        value: state.q,
        placeholder: 'Search everything — a name, a domain, a phone number, a note…',
        style: { inlineSize: '100%', fontSize: 'var(--text-lg)' },
        dataset: { focusKey: 'global-search' },
        oninput: debounce((e) => {
            state.q = e.target.value;
            setParams({ q: state.q || null });
            run();
        }, 250),
    });

    async function run() {
        if (state.q.trim().length < 2) {
            state.data = null;
            state.loading = false;
            sequence += 1;
            return paint();
        }
        const mine = (sequence += 1);
        state.loading = true;
        paint();

        let next;
        try {
            const params = new URLSearchParams({ q: state.q, limit: '25', scan: '400' });
            if (state.object) params.set('object', state.object);
            next = await api.get(`/api/search?${params}`);
        } catch (err) {
            next = { error: err.message, groups: [], objects: [] };
        }
        // A stale answer is dropped rather than painted. Without this, typing
        // "sau" then "saudi" can end with the results for "sau" on screen under
        // the word "saudi", which is worse than being slow.
        if (mine !== sequence) return undefined;
        state.data = next;
        state.loading = false;
        return paint();
    }

    function paint() {
        const focus = captureFocus(container);
        mount(container,
            h('div.card',
                h('div.card-body',
                    h('div.field', input),
                    state.data?.objects?.length > 0 && h('div.row', { style: { marginBlockStart: 'var(--space-3)' } },
                        h('button.chip', {
                            class: state.object ? '' : 'accent',
                            onclick: () => { state.object = null; setParams({ object: null }); run(); },
                        }, `Everything ${state.data.matchedTotal ?? ''}`),
                        state.data.objects.map((o) => h('button.chip', {
                            class: state.object === o.key ? 'accent' : '',
                            onclick: () => { state.object = o.key; setParams({ object: o.key }); run(); },
                        }, `${o.label} ${o.count}`)),
                    ),
                    state.data?.capped && h('p.xs.dim', { style: { marginBlockStart: 'var(--space-2)' } },
                        `Showing the best matches out of ${state.data.matchedTotal}. Narrow the search, or filter to one `
                        + 'type above, to see the rest.'),
                    // The only sign that a query is running, now that the
                    // results below stay put while it does.
                    state.loading && state.data && h('p.xs.dim', { style: { marginBlockStart: 'var(--space-2)' } },
                        'Searching… the results below are for what you typed before.'),
                ),
            ),
            body(),
        );
        // Keeps the caret AND the focus where the typist left them. Restoring
        // the selection alone was not enough: `mount` re-appends the input,
        // and moving a focused element in the DOM blurs it, so the next
        // keystroke went nowhere.
        restoreFocus(container, focus);
    }

    function body() {
        /**
         * Results are NOT taken away while the next query runs.
         *
         * They used to be: every keystroke replaced the whole list with
         * skeleton rows for as long as the round trip took. A click is a
         * mousedown and a mouseup on the SAME element, so anyone who clicked a
         * result just after their last keystroke pressed down on a link that
         * was gone by the time they let go — no click event was ever fired, and
         * the page appeared to ignore them. Doing it again worked, which made
         * it look random rather than like a bug.
         *
         * So the skeleton is only for the first search, when there is nothing
         * to keep. After that the previous results stay on screen, dimmed and
         * labelled, and stay clickable — clicking a result you can see is
         * always right, because it is the record you chose.
         */
        if (state.loading && !state.data) return skeletonRows(5);
        if (state.q.trim().length < 2) {
            return h('div.card', h('div.card-body', emptyState('Search everything',
                'Accounts, contacts, deals, campaigns, tasks, notes, documents and activities at once. '
                + 'Type at least two characters. Custom fields marked searchable are included.')));
        }
        if (state.data?.error) {
            return h('div.card', h('div.card-body', h('div.note-box.danger', state.data.error)));
        }
        if (!state.data?.groups?.length) {
            return h('div.card', h('div.card-body', emptyState('Nothing matched',
                `No record mentions "${state.q}". Terms are matched as prefixes, so a partial name works — but a `
                + 'field only appears here if it is marked searchable in Settings.')));
        }

        // Dimmed while the next answer is on its way, so "these are the results
        // for what you have finished typing" is never claimed while it is not
        // yet true. They stay clickable on purpose.
        const stale = state.loading ? '.is-stale' : '';

        return state.data.groups.map((group) => h(`div.card${stale}`,
            h('div.card-header',
                h('h2', group.label),
                h('div.actions',
                    h('span.xs.dim', `${group.records.length} of ${state.data.counts[group.object] ?? group.records.length}`),
                    (state.data.counts[group.object] ?? 0) > group.records.length && !state.object && h('button.btn.sm.ghost', {
                        onclick: () => { state.object = group.object; setParams({ object: group.object }); run(); },
                    }, 'See all'),
                ),
            ),
            h('div.card-body.flush',
                h('div.stack.tight', { style: { padding: 'var(--space-2)' } },
                    group.records.map((record) => h('div.row', { style: { alignItems: 'center', gap: 'var(--space-2)' } },
                        h('a.search-hit', { href: `/${group.route}/${record.id}`, style: { flex: '1', minInlineSize: 0 } },
                            h('div', { style: { minInlineSize: 0 } },
                                h('div.strong.truncate', { dir: 'auto' }, record.title),
                                record.subtitle && h('div.xs.dim.truncate', { dir: 'auto' }, record.subtitle),
                            ),
                        ),
                        // A contact found here can be sitting on somebody's
                        // calling queue — a screen this search never lands
                        // on otherwise (see `calling` in api/search.mjs).
                        // A sibling link, not nested inside `.search-hit`,
                        // so both stay ordinary anchors the router's own
                        // delegated click handler (core.js) already knows
                        // how to navigate.
                        record.calling && h('a.xs.dim', {
                            href: `/calling?sdr=${encodeURIComponent(record.calling.sdrId)}&q=${encodeURIComponent(state.q)}&tab=all`,
                            style: { flexShrink: '0', paddingInline: 'var(--space-2)' },
                        }, `On ${record.calling.sdrName ?? 'a'}'s queue →`),
                    )),
                ),
            ),
        ));
    }

    paint();
    if (state.q) await run();
    input.focus();
    return undefined;
}
