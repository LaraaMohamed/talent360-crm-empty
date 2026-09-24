/**
 * Meetings — every one, as a list.
 *
 * The dashboard's "Meetings scheduled" tile linked to /calling, the
 * cold-calling console — which answers "who do I ring next", not "show me
 * the meetings", and does not display a single meeting on it. This is the
 * screen that number was always supposed to lead to. See
 * lib/meetings.mjs's listMeetings for the rest of the reasoning.
 */
import { h, mount, params, setParams, date, relative, number, humanise } from '../core.js';
import { api } from '../api.js';
import { emptyState, skeletonRows, errorState, dateInput } from '../components.js';
import { setPageTitle } from '../app.js';

/**
 * "All" is `'all'`, not `''` — `setParams` (core.js) deletes a param whose
 * value is the empty string, same as one that was never set, so clicking
 * "All" would clear `status` from the URL and `load()` would then fall back
 * to its own default (`'upcoming'`) on the very next read, showing Upcoming
 * instead. `'all'` round-trips through the URL like every other tab.
 */
const STATUS_TABS = [
    ['upcoming', 'Upcoming'],
    ['unclassified', 'Past, not classified'],
    ['done', 'Done'],
    ['no_show', 'No show'],
    ['all', 'All'],
];

const RANGES = [
    ['all', 'All time'],
    ['today', 'Today'],
    ['week', 'This week'],
    ['month', 'This month'],
    ['custom', 'Custom'],
];

/** A full `YYYY-MM-DD`, as `dateInput` reports it once a day is actually complete. */
const isFullDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '');

export async function meetingsPage(content, { confined = false } = {}) {
    setPageTitle('Meetings');

    const container = h('div.content-inner');
    mount(content, container);

    let meta = null;
    try { meta = await api.get('/api/meetings/meta'); } catch { meta = { sdrs: [] }; }

    async function load() {
        const q = params();
        const status = STATUS_TABS.some(([k]) => k === q.status) ? q.status : 'upcoming';
        const range = RANGES.some(([k]) => k === q.range) ? q.range : 'all';
        const sdr = q.sdr ?? '';
        const from = q.from ?? '';
        const to = q.to ?? '';
        mount(container, skeletonRows(5));

        const query = new URLSearchParams({ status, range });
        if (sdr) query.set('sdr', sdr);
        // An incomplete custom range asks the server for nothing it can
        // answer — wait for both ends rather than sending a half range.
        if (range === 'custom' && isFullDate(from) && isFullDate(to)) {
            query.set('from', from);
            query.set('to', to);
        }
        let data;
        try {
            data = await api.get(`/api/meetings?${query}`);
        } catch (err) {
            mount(container, errorState(err.message, () => load()));
            return;
        }
        paint(data, status, range, sdr, { from, to });
    }

    function paint(data, status, range, sdr, customDraft = { from: '', to: '' }) {
        const rows = data.meetings ?? [];

        mount(container,
            h('div.record-header',
                h('div.record-title',
                    h('h1', 'Meetings'),
                    h('div.spacer'),
                    // /calendar boots the full CRM shell, which a confined
                    // SDR cannot open — the link would only bounce them
                    // straight back here.
                    !confined && h('a.btn', { href: '/calendar' }, 'View as calendar'),
                    h('a.btn', { href: '/calling' }, 'Calling console'),
                ),
                h('div.record-sub', h('span', confined
                    ? 'The meetings you booked off your own calls.'
                    : 'Every meeting booked off a call, whichever day it falls on and whoever it belongs to.')),
            ),

            h('div.row', { style: { gap: '0.15rem', marginBlockEnd: 'var(--space-2)', flexWrap: 'wrap' } },
                STATUS_TABS.map(([value, label]) => h('button.btn.sm', {
                    class: value === status ? 'primary' : 'ghost',
                    onclick: () => { setParams({ status: value }); load(); },
                }, label)),
            ),

            h('div.row', { style: { gap: 'var(--space-3)', marginBlockEnd: 'var(--space-4)', flexWrap: 'wrap', alignItems: 'center' } },
                h('select.input.sm', {
                    style: { inlineSize: 'auto' },
                    onchange: (e) => {
                        const value = e.target.value;
                        setParams({ range: value === 'all' ? null : value, from: null, to: null });
                        load();
                    },
                },
                    RANGES.map(([value, label]) => h('option', { value, selected: value === range }, label)),
                ),
                range === 'custom' && customRangeFields(customDraft),
                // A confined SDR only ever gets their own meetings back
                // (see api/meetings.mjs's list()) — offering a picker that
                // cannot change what comes back is a control with no effect.
                !confined && meta.sdrs?.length > 0 && h('select.input', {
                    style: { inlineSize: 'auto' },
                    onchange: (e) => { setParams({ sdr: e.target.value || null }); load(); },
                },
                    h('option', { value: '', selected: !sdr }, 'Everyone'),
                    meta.sdrs.map((s) => h('option', { value: s.id, selected: s.id === sdr }, s.name))),
            ),

            h('div.card',
                h('div.card-body.flush',
                    rows.length === 0
                        ? emptyState('No meetings here',
                            status === 'upcoming'
                                ? 'Nothing booked and still ahead of its time in this window. Meetings come from Meeting Scheduled on a call.'
                                : 'Nothing matches this filter.')
                        : h('div.table-wrap', h('table.data',
                            h('thead', h('tr',
                                h('th', 'When'), h('th', 'Contact'), h('th', 'Account'),
                                h('th', 'Status'), h('th', 'Assigned to'), h('th', 'Actions'),
                            )),
                            h('tbody', rows.map(meetingRow)),
                        )),
                ),
            ),
            data.pages > 1 && h('p.xs.dim', { style: { marginBlockStart: 'var(--space-3)' } }, `Page ${data.page} of ${data.pages} — ${number(data.total)} total.`),
        );
    }

    function customRangeFields(initial) {
        // A local mutable draft, not the URL — reading it back from `params()`
        // mid-keystroke would miss the sibling field's value on this same
        // render and never notice a complete pair.
        const draft = { from: initial.from, to: initial.to };
        const apply = () => {
            if (!isFullDate(draft.from) || !isFullDate(draft.to)) return;
            setParams({ from: draft.from, to: draft.to });
            load();
        };
        return h('div.row', { style: { gap: 'var(--space-2)', alignItems: 'center' } },
            dateInput({
                value: draft.from,
                'aria-label': 'From',
                onChange: (v) => { draft.from = v; apply(); },
            }),
            h('span.xs.dim', 'to'),
            dateInput({
                value: draft.to,
                'aria-label': 'To',
                onChange: (v) => { draft.to = v; apply(); },
            }),
        );
    }

    const STATUS_TONE = { scheduled: '', done: 'success', no_show: 'danger' };

    /**
     * Settle straight from the list — the same `settleMeeting` a call's
     * "Meeting Done"/"Meeting No Show" outcome writes to (lib/meetings.mjs),
     * reached here without leaving this page to find the right SDR's queue
     * and log an unrelated call just to close out a meeting already on
     * screen. Only offered once the meeting's time has passed — the same
     * rule the server enforces, checked here first so a click is never
     * refused for a reason the list could have hidden the button for.
     */
    async function settle(id, status) {
        try {
            await api.patch(`/api/meetings/${id}/settle`, { status });
            await load();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    function meetingRow(m) {
        const past = new Date(m.meetingAt).getTime() < Date.now();
        return h('tr', { class: m.status === 'scheduled' && past ? 'row-danger' : '' },
            h('td', { title: date(m.meetingAt, { withTime: true }) },
                date(m.meetingAt), ' ', h('span.xs.dim', relative(m.meetingAt))),
            h('td', m.contactId
                ? h('a.cell-link', { href: `/contacts/${m.contactId}` }, m.contactName || m.subject)
                : h('span', m.subject)),
            h('td', m.accountId
                ? h('a', { href: `/accounts/${m.accountId}` }, m.accountName)
                : h('span.dim', '—')),
            h('td', h('span.badge', { class: STATUS_TONE[m.status] ?? '' }, humanise(m.status))),
            h('td', m.assignedName ?? h('span.dim', '—')),
            h('td', m.status === 'scheduled' && past
                ? h('div.row', { style: { gap: '0.15rem' } },
                    h('button.btn.sm', { onclick: () => settle(m.id, 'done') }, 'Mark done'),
                    h('button.btn.sm.ghost', { onclick: () => settle(m.id, 'no_show') }, 'No show'))
                : h('span.dim', '—')),
        );
    }

    await load();
    return undefined;
}
