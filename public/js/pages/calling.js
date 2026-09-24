/**
 * The SDR calling workspace.
 *
 * ── WHY THIS HAS ITS OWN SHELL ──────────────────────────────────────────────
 * Not styling. An SDR is confined server-side to /api/me and /api/calling/*,
 * so the CRM shell literally cannot boot for them — it opens by fetching
 * /api/meta, /api/views and /api/lists, and all three now answer 403. Hiding
 * navigation items would have left three failed requests and an error screen.
 *
 * It is also the right shape. This is not the CRM with fewer menus; it is one
 * question repeated forty times a day — who am I ringing, what happened, what
 * do I need to remember — and everything else on screen is in the way.
 *
 * ── WHAT MAKES IT FAST ──────────────────────────────────────────────────────
 * Save & Next is one request. The server answers with the call it saved, the
 * NEXT contact, and refreshed counts, so the screen repaints from what it
 * already has rather than asking again and making the SDR wait mid-rhythm.
 *
 * The note is drafted to localStorage as it is typed, per contact. A refresh, a
 * closed laptop or a failed request cannot lose a sentence somebody has already
 * composed — and a failed save deliberately does NOT advance, because losing
 * your place is almost as bad as losing the note.
 */
import {
    h, mount, modal, confirm, toast, relative, date, number, params, setParams, humanise,
    captureFocus, restoreFocus, debounce,
} from '../core.js';
import { api } from '../api.js';
import * as store from '../store.js';
import { createNotificationBell } from '../notifications.js';

/**
 * What each outcome DOES, on the button.
 *
 * Four of them move the deal's pipeline stage and one closes the lead out of
 * the queue; an SDR should see that consequence at the moment of choosing,
 * not discover it later on a board. Keys mirror CALL_OUTCOMES in
 * lib/calling.mjs — an outcome without an entry simply shows its label only.
 */
const OUTCOME_SUBTITLES = {
    interested: 'moves pipeline to Interested',
    qualified: 'moves pipeline to Interested',
    send_profile: 'moves pipeline to Send profile',
    follow_up: 'schedules the 4-step sequence',
    meeting_scheduled: 'moves pipeline to Meeting',
    not_interested: 'closes this lead',
    wrong_number: 'closes this lead',
    no_answer: '3 in a row retires the lead',
    meeting_done: 'finishes the sequence',
    no_show: 'stays in queue for rebooking',
};
import {
    dataTable, filterBuilder, columnPicker, emptyState, errorState, skeletonRows, icon,
    dateInput, copyButton,
} from '../components.js';

/**
 * Inline priority dropdown for calling queue.
 * Only shown for managers who have calling.manage capability.
 */
function renderPriorityInline(record, def, objectKey) {
    const canManage = store.can('calling.manage');
    if (!canManage) {
        // For SDRs, just show the badge
        const badgeClass = record.priority === 'A' ? 'danger' : record.priority === 'B' ? 'warning' : '';
        return h(`span.badge${badgeClass ? `.${badgeClass}` : ''}`, record.priority);
    }
    
    const select = h('select.input.inline-priority', {
        value: record.priority,
        onchange: async (e) => {
            const newPriority = e.target.value;
            if (newPriority === record.priority) return;
            try {
                await api.patch('/api/calling/priority', {
                    assignmentIds: [record.id],
                    priority: newPriority,
                });
                toast(`Priority changed to ${newPriority}`, 'success');
                // Update the record optimistically
                record.priority = newPriority;
            } catch (err) {
                toast(err.message, 'error');
                // Revert the select
                select.value = record.priority;
            }
        },
    }, [
        h('option', { value: 'A' }, 'A'),
        h('option', { value: 'B' }, 'B'),
        h('option', { value: 'C' }, 'C'),
    ]);
    
    return select;
}
import { setPageTitle } from '../app.js';

const DRAFTS = 'crm.calling.drafts';

/** Notes in progress, keyed by assignment. Survives a reload; never the source of truth. */
function drafts() {
    try { return JSON.parse(localStorage.getItem(DRAFTS) ?? '{}'); } catch { return {}; }
}
function saveDraft(id, text) {
    const all = drafts();
    if (text.trim()) all[id] = text; else delete all[id];
    try { localStorage.setItem(DRAFTS, JSON.stringify(all)); } catch { /* private mode */ }
}
function clearDraft(id) { saveDraft(id, ''); }

/**
 * Whether a value the date-and-time boxes produced is an instant we can send.
 *
 * `dateInput` reports what is typed while it is being typed, so "15/0" reaches
 * this closure on its way to a date. An instant is what the server takes, and
 * this is the difference between the two.
 */
function readable(value) {
    if (!value) return false;
    return !Number.isNaN(new Date(value).getTime());
}

export async function callingWorkspace(root, { me, manager = false } = {}) {
    if (manager) setPageTitle('Cold calling');
    else document.title = 'Calling · CRM';

    const container = h('div.calling');
    mount(root, container);
    mount(container, skeletonRows(4));

    let meta;
    let today;
    let current = null;
    let outcome = null;
    let followUpAt = '';
    let meetingAt = '';
    let meetingNextStep = '';
    let busy = false;
    let lastError = null;
    /**
     * Previous/Next arrow navigation — browsing only, independent of Save &
     * Next. See `navigate()` below.
     */
    let navBusy = false;

    /**
     * The console is the page; the list is a place to go and look something up.
     *
     * Kept as a mode rather than a second column because on the screen an SDR
     * actually uses, a table beside the call would be forty rows competing with
     * the one contact that matters. Switching is one click and does not lose the
     * note in progress — that lives in localStorage, not in this closure.
     */
    // A manager arrives to see the team, not to make a call — the console is
    // still one click away if they want to ring somebody themselves.
    let view = manager ? 'queue' : 'call';
    let sdrFilter = params().sdr ?? '';
    /**
     * WHO ACTUALLY CALLED, as its own filter next to `sdrFilter` (whose
     * queue). A manager covering one call on a colleague's list, or a lead
     * reassigned mid-week, means the two can name different people.
     */
    let performedByFilter = params().performedBy ?? '';
    const q = params();
    let tab = ['follow_ups', 'completed', 'dead', 'all'].includes(q.tab) ? q.tab : 'to_call';
    // Deep link /calling?tab=follow_ups lands on the QUEUE, not the console —
    // the attention band and dashboard send people here to work the list.
    if (q.tab && view !== 'queue') view = 'queue';
    /**
     * Deep link /calling?open=<assignmentId> — a notification for one exact
     * lead (a single queue assignment, or a "follow up with X" task) lands
     * on that lead in the console, instead of whatever "today's next" would
     * otherwise have opened. Consumed once below, at the bottom of this
     * function, where `open()` is first called.
     */
    const openAssignmentId = q.open ?? null;
    let counts = null;
    let listing = null;
    /**
     * Why a failure is held rather than only toasted.
     *
     * The queue rendered a skeleton whenever `listing` was null, and `listing`
     * is null both before a load and after one that threw. So a failed request
     * left the spinner turning for ever behind a toast that had already faded —
     * indistinguishable, to the person looking at it, from a queue that is
     * still loading.
     */
    let queueError = null;

    /**
     * The queue's filter, sort and columns — in the URL, as a list's are.
     *
     * A filtered queue can then be pasted into a message and the person who
     * opens it sees what the sender saw, which is the same promise the list
     * pages make.
     */
    // Declared here, ahead of `queueFilter`/`queueColumns` below, because
    // `normalizeColumns()` (used to parse `q.columns` on the very next few
    // lines) calls `defaultColumns()` — which references `QUEUE_OBJECT`.
    // Both used to live down with the rest of the queue-rendering code,
    // which put their `const` declarations AFTER this parse ran, so a
    // `/calling` URL carrying an empty or unparsable `?columns=` (the state
    // it's left in once every column has been removed via the Columns
    // picker) threw "Cannot access 'defaultColumns' before initialization"
    // on the very next page load — including the one that runs when
    // returning to the queue from the solo calling screen.
    const QUEUE_OBJECT = 'calling_assignment';
    const defaultColumns = () => store.fields(QUEUE_OBJECT)
        .filter((f) => f.listDefault)
        // "Assigned to" is only a question when you can see more than your own.
        .filter((f) => manager || f.key !== 'sdr_name')
        .map((f) => column(f.key, f));

    const safeParse = (value) => { try { return JSON.parse(value); } catch { return null; } };
    let queueFilter = q.filter ? safeParse(q.filter) : null;
    let queueSort = q.sort ? safeParse(q.sort) : null;
    let queueColumns = q.columns ? normalizeColumns(safeParse(q.columns)) : null;
    let queueViewId = q.view ?? null;
    let queuePage = 1;

    /**
     * The queue's own quick search — a name, a company or a phone number, in
     * one box.
     *
     * Separate from the Filters builder on purpose: Filters is exact
     * conditions somebody sets up once and keeps ("Priority A, no answer in
     * the last week"); this is what a rep types mid-shift to jump straight
     * to one contact ("has Sarah called back yet") without opening a dialog
     * for it. Server-side, matched digit-normalized for the phone half — see
     * `queueSearchClause` in lib/calling.mjs.
     */
    let queueSearch = q.q ?? '';

    /**
     * The queue's date range, in the URL like the dashboard's.
     *
     * The server resolves it in the workspace's own clock, so "who did we call
     * this week" means the same thing on both screens. An empty `queueRange` is
     * the default, old, unfiltered queue.
     */
    let queueRange = q.range ?? '';
    let queueFrom = q.from ?? '';
    let queueTo = q.to ?? '';

    /**
     * Which queue rows are ticked.
     *
     * Held by CONTACT id rather than assignment id, because that is what
     * `/api/calling/assign` takes — it assigns a person to an SDR, and the
     * queue row is the consequence of that rather than the thing being moved.
     * Cleared whenever the rows underneath change, so a tick can never survive
     * onto a row the user never saw.
     */
    let queueSelection = new Set();
    /**
     * "Select all matching" for the queue — the whole tab/filter, not the 100
     * rows on screen.
     *
     * The table itself caps at 100 rows a page (see `queue()`, capped at 200
     * server-side), so ticking every box on screen was never "reassign the
     * whole queue" for anybody managing more than a page of leads. Resolved
     * through `/api/calling/queue/ids`, which runs the identical tab/sdr/range/
     * filter clause `loadQueue` does, uncapped up to the same 20000-row ceiling
     * every other bulk action in this CRM refuses past.
     */
    let queueAllMatching = false;

    try {
        const todayQuery = new URLSearchParams();
        if (sdrFilter) todayQuery.set('sdr', sdrFilter);
        if (queueFilter) todayQuery.set('filter', JSON.stringify(queueFilter));
        if (queueSearch.trim()) todayQuery.set('q', queueSearch.trim());
        [meta, today] = await Promise.all([
            api.get('/api/calling/meta'),
            api.get(`/api/calling/today${todayQuery.toString() ? `?${todayQuery}` : ''}`),
        ]);
    } catch (err) {
        mount(container, h('div.note-box.danger', err.message));
        return;
    }

    /**
     * The hour the time boxes open at, from the workspace rather than from here.
     *
     * `follow_up_day_start_hour` is what the server turns a timeless follow-up
     * into, so offering the same hour in the box means the screen and the
     * scheduler agree — and a business that starts at eight changes one setting
     * rather than waiting for a deploy. See lib/follow-up.mjs.
     */
    const defaultTime = () => meta.defaultFollowUpTime || '09:00';

    /**
     * A follow-up's DEFAULT instant: tomorrow at the start of the working day.
     *
     * The four-step sequence has a fixed timing — first call, WhatsApp at the
     * end of the day, a second call exactly seven days later, and a last
     * WhatsApp — and only the FIRST date and time is the rep's to choose. So
     * the box opens already filled with a sensible future instant (tomorrow at
     * the workspace's start hour), which the rep can edit; it is never left
     * empty for the sequence to guess at. Tomorrow rather than today because
     * a follow-up must not be in the past, and an end-of-day booking is the
     * common slip.
     */
    function defaultFollowUpInstant() {
        const [h, m] = defaultTime().split(':').map(Number);
        const at = new Date();
        at.setDate(at.getDate() + 1);
        at.setHours(Number.isInteger(h) ? h : 9, Number.isInteger(m) ? m : 0, 0, 0);
        return at.toISOString();
    }

    async function open(assignmentId) {
        if (!assignmentId) { current = null; paint(); return; }
        try {
            current = await api.get(`/api/calling/assignments/${assignmentId}`);
            outcome = null;
            followUpAt = '';
            meetingAt = '';
            meetingNextStep = '';
            lastError = null;
        } catch (err) {
            toast(err.message, 'error');
            current = null;
        }
        paint();
    }

    /**
     * Save & Next.
     *
     * The idempotency key is minted once per contact-and-attempt, so a second
     * click sends the SAME key and the server answers with the call it already
     * recorded instead of appending another.
     */
    async function saveAndNext() {
        if (!outcome || busy) return;
        const need = meta.outcomes.find((o) => o.key === outcome)?.requires;
        /**
         * Both halves, and both readable.
         *
         * The date box reports what is typed as it is typed, so at this moment
         * `followUpAt` is either an instant (the box has been left, or a time was
         * set) or half-finished text. Refusing the second here is kinder than
         * sending it: the server refuses it too, but after the note has been
         * posted and the rhythm broken.
         */
        if (need === 'followUpAt' && !readable(followUpAt)) {
            lastError = followUpAt
                ? `"${followUpAt}" is not a date and time we can read. Use 2026-09-15 and a time like 14:30.`
                : 'Pick the follow-up date and time — it is what brings this contact back.';
            paint();
            return;
        }
        /**
         * A follow-up in the past books nothing — the server refuses it too, but
         * refusing here keeps the rep on the call instead of after an error.
         * Same rule as `logCall` in lib/calling.mjs.
         */
        if (need === 'followUpAt' && followUpAt && new Date(followUpAt).getTime() <= Date.now()) {
            lastError = 'The follow-up cannot be in the past. Pick a future date and time — that is when this contact comes back.';
            paint();
            return;
        }
        if (need === 'meetingAt' && !readable(meetingAt)) {
            lastError = meetingAt
                ? `"${meetingAt}" is not a date and time we can read. Use 2026-09-15 and a time like 14:30.`
                : 'Pick the meeting date and time.';
            paint();
            return;
        }
        if (need === 'meetingAt' && meetingAt && new Date(meetingAt).getTime() <= Date.now()) {
            lastError = 'The meeting cannot be in the past. Pick a future date and time.';
            paint();
            return;
        }

        busy = true;
        lastError = null;
        paint();

        const note = drafts()[current.id] ?? '';
        const key = `${current.id}:${current.callCount}`;

        try {
            const result = await api.post(`/api/calling/assignments/${current.id}/call`, {
                outcome, note, followUpAt: followUpAt || null, meetingAt: meetingAt || null,
                nextStep: outcome === 'meeting_done' && meetingNextStep ? meetingNextStep : null,
                idempotencyKey: key,
                // Same reason `today` was fetched with these above: the next
                // contact this hands back must stay inside whatever queue —
                // whose, filtered how, sorted how, and searched for what — the
                // SDR is actually working, so "next" agrees with the row this
                // lead sits above on the queue table.
                sdr: sdrFilter || null,
                filter: queueFilter || null,
                sort: queueSort || null,
                q: queueSearch.trim() || null,
            });
            clearDraft(current.id);
            /**
             * `result.counts` is queueCounts()'s own shape (`to_call`,
             * `follow_ups`, snake_case) — `follow_ups` there is the whole
             * follow-up BOOK (every lead mid-sequence, whatever their next
             * step's date), not "due now". This used to spread it straight
             * into `today.followUpsDue` (the field the "N due — work them
             * now" banner reads), so logging a single call replaced the
             * correct due-now figure with the much larger book size — the
             * banner then read "due" for leads that were not, including the
             * one just called. `result.followUpsDue` is the same due-now,
             * exclude-the-lead-on-screen figure `/api/calling/today` returns
             * on page load (see its comment in api/calling.mjs `call()`).
             */
            today = {
                ...today,
                remaining: result.counts.to_call,
                followUpsDue: result.followUpsDue,
                completed: result.counts.completed,
                assigned: result.counts.all,
                calledToday: (today.calledToday ?? 0) + 1,
            };
            // The tab counts came back with the call, so the queue is never
            // showing yesterday's numbers behind today's work.
            counts = result.counts;
            listing = null;
            busy = false;
            toast('Saved', 'success');
            await open(result.next?.id ?? null);
        } catch (err) {
            /**
             * Stay exactly where we are. The note is still in localStorage and
             * still in the box, so trying again costs a click and nothing else —
             * §43: a network failure must never destroy a note.
             */
            busy = false;
            lastError = `${err.message} Your note is saved on this device — try again.`;
            paint();
        }
    }

    /**
     * Previous / Next — browsing, not saving.
     *
     * A completely separate action from Save & Next: it never calls
     * `saveAndNext`, posts no outcome, logs no activity, and does not touch
     * `queue_status` or the counts. It walks the SAME ordered list the queue
     * view shows for whichever tab/filter/sort is active — the query below
     * mirrors `loadQueue`'s so the arrows can never disagree with "My queue"
     * about what order the leads are in (see `queue()` in lib/calling.mjs for
     * that ordering). Fetched fresh on every click rather than cached, so a
     * lead saved and removed from the tab a moment ago can't leave the arrows
     * pointing at a stale position.
     *
     * Moving to a lead is just `open()` — the same GET-only swap a queue row
     * click or Save & Next's own "next" already use, so there is nothing new
     * here that could accidentally save, and the note draft (localStorage,
     * per contact) is untouched either way.
     */
    async function navigate(step) {
        if (busy || navBusy || !current) return;
        navBusy = true;
        paint();
        try {
            const query = new URLSearchParams({ tab, limit: '200', page: '1' });
            if (sdrFilter) query.set('sdr', sdrFilter);
            if (performedByFilter) query.set('performedBy', performedByFilter);
            if (queueRange) query.set('range', queueRange);
            if (queueRange === 'custom') {
                if (queueFrom) query.set('from', queueFrom);
                if (queueTo) query.set('to', queueTo);
            }
            if (queueFilter) query.set('filter', JSON.stringify(queueFilter));
            if (queueSort) query.set('sort', JSON.stringify(queueSort));
            if (queueSearch.trim()) query.set('q', queueSearch.trim());

            const page = await api.get(`/api/calling/queue?${query}`);
            const ids = page.items.map((item) => item.id);
            const index = ids.indexOf(current.id);
            const targetId = index === -1
                ? (step > 0 ? ids[0] : ids[ids.length - 1])
                : ids[index + step];

            if (!targetId) {
                toast(step > 0 ? 'No more leads in this queue.' : 'This is the first lead in the queue.', '');
                return;
            }
            await open(targetId);
        } catch (err) {
            toast(err.message, 'error');
        } finally {
            navBusy = false;
            paint();
        }
    }

    /* ------------------------------------------------------------- render -- */

    function header() {
        // The bell lives in this shell too — an SDR was the one person the
        // old topbar-less header left with no way to see anything had landed
        // for them. Same badge, panel and polling as the CRM topbar.
        const notifications = createNotificationBell();
        notifications.startPolling();

        /**
         * A manager gets a plain bar, not a greeting and a stat row.
         *
         * Those stats would mix scopes: "Assigned" and "Remaining" are the whole
         * team's, while "Called today" can only be the calls this person made.
         * Five numbers where two mean something different from the other three
         * is worse than no numbers — the dashboard widgets are the manager's
         * figures, and they say which period they cover.
         */
        if (manager) {
            return h('header.calling-header',
                h('div',
                    h('h1', 'Cold calling'),
                    h('p.small.dim', 'Who is calling whom. Numbers are on the dashboard.'),
                ),
                h('div.spacer'),
                notifications.el,
            );
        }

        const hour = new Date().getHours();
        const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
        return h('header.calling-header',
            h('div',
                h('h1', `${greeting}, ${String(me.user.name ?? '').split(' ')[0] || 'there'}`),
                h('p.small.dim', 'Cold calling'),
            ),
            h('div.spacer'),
            h('div.calling-stats',
                stat('Assigned', today.assigned),
                stat('Called today', today.calledToday),
                stat('Remaining', today.remaining),
                stat('Follow-ups due', today.followUpsDue),
                stat('Meetings today', today.meetingsToday),
            ),
            notifications.el,
            h('a.btn.sm.ghost', { href: '/my-work' }, 'My work'),
            h('a.btn.sm.ghost', { href: '/meetings' }, 'Meetings'),
            h('button.btn.sm.ghost', { onclick: () => api.post('/api/auth/logout', {}).then(() => { location.href = '/login'; }) }, 'Sign out'),
        );
    }

    const stat = (label, value) => h('div.calling-stat',
        h('span.calling-stat-value', String(value ?? 0)),
        h('span.calling-stat-label', label),
    );

    function callCard() {
        if (!current) {
            return h('div.card', h('div.card-body',
                today.assigned === 0
                    ? emptyState('No contacts assigned', 'Nothing is in your calling queue yet. Your manager adds contacts to it.')
                    : emptyState('You are all caught up', 'Nothing left to call right now. Follow-ups appear here when they are due.'),
            ));
        }

        const need = meta.outcomes.find((o) => o.key === outcome)?.requires;
        const note = drafts()[current.id] ?? '';

        /**
         * What is about to be saved, in words, under the two boxes.
         *
         * Updated by writing to this one node rather than by repainting the
         * card: a repaint on every keystroke would rebuild the note textarea
         * underneath the caret, and the note is the thing an SDR is typing while
         * they are on the phone.
         */
        const whenLine = h('span.xs.dim');
        const echo = (value) => {
            const at = value ? new Date(value) : null;
            whenLine.textContent = at && !Number.isNaN(at.getTime())
                ? `Saving as ${date(at.toISOString(), { withTime: true })}`
                : '';
        };
        echo(need === 'meetingAt' ? meetingAt : followUpAt);

        const noteBox = h('textarea.input.calling-note', {
            rows: 3,
            placeholder: 'Write a quick note about this call…',
            value: note,
            oninput: (e) => saveDraft(current.id, e.target.value),
            onkeydown: (e) => {
                // Ctrl/Cmd+Enter saves from inside the note, so the whole call
                // can be recorded without the hands leaving the keyboard.
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); saveAndNext(); }
            },
        });

        return h('div.card.calling-card',
            h('div.card-body.stack',
                /**
                 * Browsing, separate from Save & Next below — see `navigate()`.
                 * Its own row, its own controls: clicking these never saves
                 * this lead, changes its status, or logs anything.
                 */
                h('div.row.calling-nav',
                    h('button.btn.ghost.calling-nav-btn', {
                        title: 'Previous lead — just browsing, does not save',
                        'aria-label': 'Previous lead',
                        disabled: busy || navBusy,
                        onclick: () => navigate(-1),
                    }, icon('arrowLeft')),
                    h('div.spacer'),
                    h('span.xs.dim', 'Browse leads — does not save'),
                    h('div.spacer'),
                    h('button.btn.ghost.calling-nav-btn', {
                        title: 'Next lead — just browsing, does not save',
                        'aria-label': 'Next lead',
                        disabled: busy || navBusy,
                        onclick: () => navigate(1),
                    }, icon('arrowRight')),
                ),

                h('div.calling-who',
                    h('div.row', { style: { gap: 'var(--space-2)', alignItems: 'baseline' } },
                        h('h2', current.contactId
                            ? h('a', { href: `/contacts/${current.contactId}`, title: 'Open this contact’s record' }, current.name)
                            : current.name),
                        h('button.btn.xs.ghost', {
                            title: 'Edit this lead without leaving the calling screen',
                            onclick: () => openEditLead(),
                        }, icon('edit'), 'Edit'),
                    ),
                    (current.services ?? []).map((s) => h('span.badge.info', {
                        title: 'A service this lead is being called for (from the contact record)',
                        style: { marginInlineEnd: 'var(--space-2)' },
                    }, humanise(s))),
                    h('p.dim', current.title || current.company
                        ? [
                            current.title,
                            current.company && (current.accountId
                                ? h('a.small', { href: `/accounts/${current.accountId}`, title: 'Open this account’s record' }, current.company)
                                : current.company),
                        ].filter(Boolean).flatMap((part, i) => (i ? [' · ', part] : [part]))
                        : 'No company recorded'),
                    h('div.calling-contact',
                        current.phone
                            ? h('span.row', { style: { gap: 'var(--space-1)' } },
                                h('a.calling-phone', { href: `tel:${current.phone}` }, `📞 ${current.phone}`),
                                copyButton(current.phone, { label: 'phone number' }))
                            : h('span.badge.warning', 'No phone number on this contact'),
                        current.email && h('span.row', { style: { gap: 'var(--space-1)' } },
                            h('a.small', { href: `mailto:${current.email}` }, current.email),
                            copyButton(current.email, { label: 'email address' })),
                        current.linkedinUrl && h('a.small', { href: current.linkedinUrl, target: '_blank', rel: 'noreferrer' }, 'LinkedIn ↗'),
                    ),
                    /**
                     * A message sent between calls, not a call outcome — see
                     * `logMessage` in lib/calling.mjs for why these stay off
                     * the outcome row entirely: nothing here touches the
                     * streak, the sequence, or the deal stage. Just a note on
                     * this lead's timeline that a WhatsApp or an email went out.
                     */
                    h('div.calling-contact', { style: { marginBlockStart: 'var(--space-1)' } },
                        (meta.messageChannels ?? []).map((c) => h('button.btn.xs.ghost', {
                            onclick: () => logMessage(c.key),
                        }, `✎ Log ${c.label}`)),
                        /**
                         * Neither an SDR nor a rep may move a contact onto
                         * somebody else's queue directly — `assignContacts`
                         * (lib/calling.mjs) forces `assignedTo = ctx.userId`
                         * for anyone without `calling.manage`. This is the
                         * door instead: nothing moves until a manager
                         * reviews it. `meta.canManage` is the real
                         * capability the server checked to build this
                         * response — unlike the page-level `manager` flag
                         * this file's own `canManage()` also folds in, which
                         * is true for a rep too and is not what gates this.
                         */
                        !meta.canManage && current.contactId && h('button.btn.xs.ghost', {
                            onclick: () => requestReassignment(current),
                        }, '⇄ Request reassignment'),
                    ),
                    current.callCount > 0 && h('p.xs.dim',
                        `${current.callCount} previous ${current.callCount === 1 ? 'attempt' : 'attempts'}`
                        + (current.lastOutcomeLabel ? ` · last: ${current.lastOutcomeLabel}` : '')
                        + (current.lastCalledAt ? ` ${relative(current.lastCalledAt)}` : '')),
                ),

                sequenceStrip(current.sequence),

                // DUE FIRST — if follow-ups are owed today, that is the next
                // action, stated above the outcome buttons rather than one tab
                // away. The follow_ups TAB on its own shows the whole
                // mid-sequence book (every lead due today or in three weeks),
                // which is right for someone browsing it directly and wrong
                // for a link that promises "due now" — the filter narrows this
                // ONE link to the same due-now figure the banner counts.
                Number(today.followUpsDue) > 0 && h('div.note-box.warning', { style: { padding: 'var(--space-2) var(--space-3)' } },
                    h('a.small.strong', {
                        href: `/calling?tab=follow_ups&filter=${encodeURIComponent(JSON.stringify({
                            op: 'and',
                            children: [{ field: 'next_follow_up_at', operator: 'at_or_before', value: new Date().toISOString() }],
                        }))}`,
                    },
                        `${today.followUpsDue} follow-up${today.followUpsDue === 1 ? '' : 's'} due — work them now →`)),

                h('div.stack.tight',
                    h('div.strong.small', 'What happened?'),
                    h('div.calling-outcomes', meta.outcomes.map((o, i) => h('button.btn.calling-outcome', {
                        class: outcome === o.key ? 'primary' : '',
                        onclick: () => {
                            outcome = o.key;
                            lastError = null;
                            // A follow-up opens with its default future instant
                            // already in the box — tomorrow at the start of the
                            // working day — editable, never blank. Re-picking the
                            // same outcome keeps whatever was already there.
                            if (o.key === 'follow_up' && !followUpAt) followUpAt = defaultFollowUpInstant();
                            paint();
                        },
                        title: OUTCOME_SUBTITLES[o.key]
                            ? `${o.label} — ${OUTCOME_SUBTITLES[o.key]}`
                            : `${i + 1}`,
                    }, o.label,
                        // The consequence, on the button: an SDR should not need
                        // a tooltip to know which outcomes move the pipeline.
                        OUTCOME_SUBTITLES[o.key] ? h('span.sub', OUTCOME_SUBTITLES[o.key]) : null,
                    ))),
                ),

                /**
                 * Typed, with a calendar beside it — the same control the rest
                 * of the CRM uses. These two were native segmented inputs, so
                 * an SDR mid-call could not simply type the date the person on
                 * the phone had just given them.
                 *
                 * BOTH HALVES MATTER. "Ring me back Tuesday afternoon" is a
                 * time as much as a date, and the sequence, the queue and the
                 * task list all work to the instant — so the time box carries
                 * the workspace's start of day rather than opening empty and
                 * quietly meaning midnight. `whenLine` reads back what will be
                 * saved, because a follow-up nobody can see is the one thing
                 * this form must not produce.
                 */
                need === 'followUpAt' ? h('div.field',
                    h('label', 'Follow-up date and time'),
                    dateInput({
                        value: followUpAt,
                        withTime: true,
                        defaultTime: defaultTime(),
                        onChange: (v) => { followUpAt = v; echo(followUpAt); },
                    }),
                    whenLine,
                    h('span.help', 'This starts the four-step follow-up sequence: this call at the time you set, '
                        + 'a WhatsApp at the end of that day, a second follow-up exactly seven days later, '
                        + 'and a last WhatsApp.'),
                ) : null,

                need === 'meetingAt' ? h('div.field',
                    h('label', 'Meeting date and time'),
                    dateInput({
                        value: meetingAt,
                        withTime: true,
                        defaultTime: defaultTime(),
                        onChange: (v) => { meetingAt = v; echo(meetingAt); },
                    }),
                    whenLine,
                ) : null,

                /**
                 * EVERY RESOLVED MEETING ASKS WHAT CAME NEXT. A meeting that
                 * went well ends in a proposal being prepared; one that did not
                 * ends the deal. Chosen here, applied by the server with the
                 * call, so the pipeline moves in the same action.
                 */
                outcome === 'meeting_done' ? h('div.field',
                    h('label', 'What came next?'),
                    h('select.input', {
                        onchange: (e) => { meetingNextStep = e.target.value || ''; },
                    }, [
                        h('option', { value: '' }, '— choose —'),
                        h('option', { value: 'proposal_preparing', selected: meetingNextStep === 'proposal_preparing' }, 'Prepare a proposal'),
                        h('option', { value: 'lost', selected: meetingNextStep === 'lost' }, 'Deal lost'),
                    ]),
                    h('span.help', 'Moves the deal to Proposal preparing, or closes it as lost.'),
                ) : null,

                h('div.stack.tight',
                    h('div.strong.small', 'Quick note'),
                    noteBox,
                ),

                lastError ? h('div.note-box.danger', lastError) : null,

                h('div.row',
                    h('span.xs.dim', outcome ? 'Ctrl+Enter saves' : 'Choose what happened'),
                    h('div.spacer'),
                    h('button.btn.primary.calling-save', {
                        disabled: !outcome || busy,
                        onclick: saveAndNext,
                    }, busy ? 'Saving…' : 'Save & Next →'),
                ),
            ),
            current.history?.length ? historyBlock(current.history) : null,
        );
    }

    /**
     * Where this lead stands, in one strip.
     *
     * The six questions an SDR asks in the two seconds before dialling are: who
     * is this, what happened last time, what is due, what is next, when, and is
     * there any point. The card answered the first two. This answers the rest.
     *
     * A lead that has not been followed up yet gets nothing — an empty progress
     * bar on every fresh contact is decoration, and the screen has work to do.
     */
    function sequenceStrip(sequence) {
        if (!sequence?.running && !sequence?.dead) return null;

        if (sequence.dead) {
            return h('div.note-box.danger.calling-sequence',
                h('div.strong.small', 'Lead is dead'),
                h('p.xs', `All ${sequence.of} follow-up activities are done and it did not convert. `
                    + 'No further follow-up will be created.'),
            );
        }

        const next = sequence.next;
        // "Due now" versus "Scheduled for…" — the same date read two ways
        // depending on whether it has actually arrived. A rep glancing at
        // three leads in a row should be able to tell which one is ready to
        // act on without doing the arithmetic themselves.
        const isDue = next && new Date(next.dueAt).getTime() <= Date.now();
        return h('div.calling-sequence',
            h('div.row',
                h('span.small.strong', `Follow-up ${sequence.position} of ${sequence.of}`),
                h('div.spacer'),
                next
                    ? h('span.small',
                        h('span.dim', isDue ? 'Due now: ' : 'Next, scheduled: '),
                        `${next.label}${isDue ? '' : ` · ${relative(next.dueAt)}`} · ${date(next.dueAt, { withTime: true })}`)
                    : h('span.small.dim', 'Nothing scheduled'),
                /**
                 * Moving the date, without logging a call to do it.
                 *
                 * "They asked me to ring Thursday instead" is not a call — no
                 * outcome, no attempt — and the only way to change the date used
                 * to be to log one, which put a call that never happened in the
                 * history and appended a fifth thing to a four-step sequence.
                 */
                next ? h('button.btn.xs.ghost', {
                    title: 'Move this follow-up to another date and time',
                    onclick: () => editFollowUp(next.dueAt),
                }, 'Reschedule') : null,
            ),
            h('div.calling-sequence-steps', (sequence.steps ?? []).map((step) => h('span.calling-sequence-step', {
                class: step.status === 'done' ? 'done' : (next && step.taskId === next.taskId ? 'current' : ''),
                title: `${step.label} · ${date(step.dueAt, { withTime: true })} · `
                    + (step.status === 'done' ? 'done'
                        : next && step.taskId === next.taskId ? (isDue ? 'due now' : `scheduled, ${relative(step.dueAt)}`)
                        : step.status === 'cancelled' ? 'cancelled' : `scheduled, ${relative(step.dueAt)}`),
            }, step.label))),
            h('p.xs.dim', `The sequence is ${sequence.of} activities — follow-up, WhatsApp, follow-up seven days `
                + 'later, WhatsApp. After the last one the lead is marked dead automatically.'),
        );
    }

    /**
     * Moving an existing follow-up.
     *
     * A small dialog rather than an inline box, because it is a deliberate act
     * with a consequence worth stating: the WhatsApp and the second follow-up
     * move with it. The server recomputes the schedule from the new instant, so
     * "seven days after the first follow-up" survives the change instead of
     * quietly becoming seven days after the date somebody typed first.
     */
    async function editFollowUp(currentDueAt) {
        if (!current) return;
        let value = currentDueAt ?? '';
        const errorBox = h('div.error');

        const saved = await modal({
            title: 'Reschedule this follow-up',
            body: () => h('div.stack',
                errorBox,
                h('div.field',
                    h('label', 'New date and time'),
                    dateInput({
                        value,
                        withTime: true,
                        defaultTime: defaultTime(),
                        onChange: (v) => { value = v; },
                    }),
                    h('span.help', 'The WhatsApp after it and the second follow-up move with it. '
                        + 'Steps already done keep their dates.'),
                ),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', {
                    onclick: async (event) => {
                        const button = event.currentTarget;
                        if (!readable(value)) {
                            errorBox.textContent = 'Pick a date and a time we can read, like 2026-09-15 and 14:30.';
                            return;
                        }
                        button.disabled = true;
                        button.textContent = 'Moving…';
                        try {
                            close(await api.patch(
                                `/api/calling/assignments/${current.id}/follow-up`,
                                { followUpAt: value },
                            ));
                        } catch (err) {
                            errorBox.textContent = err.message;
                            button.disabled = false;
                            button.textContent = 'Move it';
                        }
                    },
                }, 'Move it'),
            ],
        });

        if (!saved) return;
        /**
         * Repainted from what came back, not by re-fetching the console.
         *
         * The response carries the assignment with its recomputed sequence, so
         * the strip redraws from one request — the queue counts have not changed
         * (no call was logged), and reloading them would be work with nothing to
         * show for it.
         */
        current = saved.assignment ?? current;
        toast(saved.stepsMoved
            ? `Follow-up moved. ${saved.stepsMoved} pending ${saved.stepsMoved === 1 ? 'step' : 'steps'} moved with it.`
            : 'Follow-up moved.', 'success');
        paint();
    }

    /**
     * Logging a WhatsApp or an email sent to this lead — not a call outcome,
     * so it is its own small dialog rather than a state on the note box
     * below: that note is bound to whichever outcome gets chosen next, and
     * a message sent between calls must not silently become the note on a
     * later, unrelated call.
     */
    async function logMessage(channel) {
        if (!current) return;
        const label = meta.messageChannels?.find((c) => c.key === channel)?.label ?? channel;
        let note = '';
        const key = `${current.id}:${channel}:${current.callCount ?? 0}:${Date.now()}`;

        const saved = await modal({
            title: `Log ${label}`,
            body: () => h('div.field',
                h('label', 'What did you send? (optional)'),
                h('textarea.input', {
                    rows: 4, placeholder: `A quick note about the ${label.toLowerCase()}…`,
                    oninput: (e) => { note = e.target.value; },
                }),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', {
                    onclick: async (event) => {
                        const button = event.currentTarget;
                        button.disabled = true;
                        button.textContent = 'Logging…';
                        try {
                            close(await api.post(`/api/calling/assignments/${current.id}/message`, {
                                channel, note, idempotencyKey: key,
                            }));
                        } catch (err) {
                            toast(err.message, 'error');
                            button.disabled = false;
                            button.textContent = `Log ${label}`;
                        }
                    },
                }, `Log ${label}`),
            ],
        });

        if (!saved) return;
        current = saved.assignment ?? current;
        toast(`${label} logged.`, 'success');
        paint();
    }

    /**
     * Asking a manager to hand this contact to somebody else — see the
     * comment above the button that opens this, and requestReassign in
     * api/calling.mjs for the door itself.
     */
    async function requestReassignment(row) {
        const others = (meta.colleagues ?? []).filter((m) => m.id !== me?.user?.id && m.id !== row.assignedTo);
        if (!others.length) {
            toast('There is nobody else in the workspace to request this for.', 'error');
            return;
        }
        const draft = { to: others[0].id, note: '' };
        const chosen = await modal({
            title: `Request reassignment — ${row.name}`,
            body: h('div.stack',
                h('div.field',
                    h('label', 'Send this contact to'),
                    h('select.input', { onchange: (e) => { draft.to = e.target.value; } },
                        others.map((m) => h('option', { value: m.id }, `${m.name} · ${m.role}`))),
                ),
                h('div.field',
                    h('label', 'Why (optional)'),
                    h('textarea.input', {
                        rows: 3, placeholder: 'Anything the manager should know before deciding…',
                        oninput: (e) => { draft.note = e.target.value; },
                    }),
                ),
                h('p.xs.dim', 'Nothing moves yet — a manager approves or rejects this before the contact changes hands.'),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(null) }, 'Cancel'),
                h('button.btn.primary', { onclick: () => close(draft) }, 'Send request'),
            ],
        });
        if (!chosen) return;

        try {
            await api.post(`/api/calling/contacts/${row.contactId}/reassign-request`, chosen);
            toast('Reassignment requested. A manager will review it.', 'success');
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    /**
     * Wipes this contact's calling history — admin-only, and the button is
     * simply absent for anyone else (the server refuses it either way; see
     * `clearCallingActivity` in lib/calling.mjs, which is what actually
     * enforces this rather than the button being hidden).
     */
    async function clearActivity() {
        if (!current) return;
        const ok = await confirm({
            title: `Clear ${current.name}'s calling activity?`,
            message: 'Every call and message logged against this contact is removed, the queue entry resets to '
                + 'unworked (never called, no outcome, no streak), and any pending follow-up steps are cancelled. '
                + 'The contact, account and deal are not touched. This cannot be undone.',
            confirmLabel: 'Clear activity',
            danger: true,
        });
        if (!ok) return;
        try {
            const result = await api.post(`/api/calling/assignments/${current.id}/clear-activity`, {});
            current = result.assignment ?? current;
            outcome = null; followUpAt = ''; meetingAt = ''; meetingNextStep = ''; lastError = null;
            toast(`Cleared ${result.cleared} ${result.cleared === 1 ? 'activity' : 'activities'}.`, 'success');
            paint();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    /** Collapsed by default: useful, and not the point of the screen. */
    function historyBlock(history) {
        return h('details.calling-history',
            h('summary',
                `Recent activity (${history.length})`,
                store.can('calling.clear_activity') && h('button.btn.xs.ghost.danger', {
                    style: { marginInlineStart: 'var(--space-3)' },
                    // A <summary> is also a disclosure toggle — without this
                    // the click opens/closes the details block as well as
                    // firing the button.
                    onclick: (e) => { e.preventDefault(); e.stopPropagation(); clearActivity(); },
                }, 'Clear activity'),
            ),
            h('div.stack.tight', history.map((call) => h('div.calling-history-row',
                h('div.row',
                    h('span.small.strong', call.type === 'call' ? call.outcomeLabel : `✎ ${call.outcomeLabel}`),
                    h('div.spacer'),
                    h('span.xs.dim', `${date(call.at)} · ${call.by ?? 'unknown'}`),
                ),
                call.note ? h('p.small', call.note) : h('p.xs.dim', 'No note.'),
            ))),
        );
    }

    /* --------------------------------------------------------- the queue -- */

    /**
     * The stages of a calling day, as a segmented control.
     *
     * ── WHY NOT A DROPDOWN ──────────────────────────────────────────────────
     *
     * A dropdown would save a row and cost the three numbers that make this
     * screen worth looking at. An SDR does not choose a stage once and settle
     * in — they bounce between "who is left" and "who is owed a call back" all
     * shift, and the decision is made FROM the counts. Hiding two of them
     * behind a click to tidy the header optimises for the screenshot rather
     * than the shift.
     *
     * So: everything visible, one click to switch, and the counts carried in
     * pills rather than glued into the label as `To call (42)` — a count in
     * the label cannot be tabular, cannot be coloured, and reads as part of
     * the name of the thing.
     *
     * Follow-ups shows every lead currently mid four-step sequence —
     * whatever their next step's due date is, not only the ones already
     * overdue. A rep working their list needs the whole book, not just
     * today's slice of it; the overdue ones are still visible in it, sorted
     * by due date like the rest of the queue.
     */
    const TABS = [
        { key: 'to_call', label: 'To call', icon: 'phone' },
        { key: 'follow_ups', label: 'Follow-ups', icon: 'clock' },
        { key: 'completed', label: 'Completed', icon: 'check' },
        /**
         * Leads the four-step sequence finished without converting.
         *
         * They had no tab, and `dead` matches none of the other three — so a
         * lead the automation retired vanished from the screen entirely, which
         * looks like data loss rather than a decision. "Why did this month
         * produce nothing" is answered from this list.
         */
        { key: 'dead', label: 'Dead', icon: 'close' },
        { key: 'all', label: 'All', icon: 'list' },
    ];

    /**
     * One stage. The count is absent rather than zero until it is known —
     * a placeholder number is read and acted on; a missing one is waited for.
     */
    function segment({ key, label, icon: iconName, tone }) {
        const count = counts?.[key];
        const urgent = tone === 'due' && count > 0;
        return h('button.segment', {
            class: [key === tab ? 'active' : '', urgent ? 'due' : ''].filter(Boolean).join(' '),
            'aria-pressed': String(key === tab),
            onclick: () => loadQueue(key),
        },
        icon(iconName),
        h('span', label),
        count != null && h('span.segment-count', number(count)),
        );
    }

    async function loadQueue(next = tab) {
        tab = next;
        listing = null;
        queueError = null;
        // A tick belongs to the rows it was made on.
        queueSelection = new Set();
        queueAllMatching = false;
        paint();
        try {
            const query = new URLSearchParams({ tab, limit: '100', page: String(queuePage) });
            if (sdrFilter) query.set('sdr', sdrFilter);
            if (performedByFilter) query.set('performedBy', performedByFilter);
            // The range reaches the QUERY, not the rendering — the server scopes
            // the rows and the counts together, so the pills and the table agree
            // about how many were worked in the period.
            if (queueRange) query.set('range', queueRange);
            if (queueRange === 'custom') {
                if (queueFrom) query.set('from', queueFrom);
                if (queueTo) query.set('to', queueTo);
            }
            // The filter reaches the QUERY, not the rendering — the server
            // narrows the rows and the total, so paging and counts stay honest.
            if (queueFilter) query.set('filter', JSON.stringify(queueFilter));
            if (queueSort) query.set('sort', JSON.stringify(queueSort));
            // Same reasoning as the filter — matched server-side, not by
            // hiding rows client-side, so paging and "select all matching"
            // agree with what is on screen.
            if (queueSearch.trim()) query.set('q', queueSearch.trim());

            const scope = new URLSearchParams();
            if (sdrFilter) scope.set('sdr', sdrFilter);
            if (queueRange) scope.set('range', queueRange);
            if (queueRange === 'custom') {
                if (queueFrom) scope.set('from', queueFrom);
                if (queueTo) scope.set('to', queueTo);
            }
            // Same filter as the table, so "To call 45 · All 45" narrows to
            // match it instead of sitting frozen beside a table that just
            // shrank to 2 — which reads as the filter having no effect at
            // all, even though the rows underneath it are exactly right.
            if (queueFilter) scope.set('filter', JSON.stringify(queueFilter));

            [counts, listing] = await Promise.all([
                api.get(`/api/calling/counts${scope.size ? `?${scope}` : ''}`),
                api.get(`/api/calling/queue?${query}`),
            ]);
        } catch (err) {
            queueError = err.message;
            toast(err.message, 'error');
        }
        paint();
    }

    /**
     * The queue, with the same filter builder and column picker every list has.
     *
     * It gets them by `calling_assignment` being a registered object (see
     * lib/objects.mjs) — the whole apparatus is driven from the field registry.
     * The object is deliberately NOT routable: the rows still come from
     * /api/calling/queue, which scopes every read to the SDR who owns them.
     *
     * The tabs stay. They are a coarse scope over queue_status and a filter
     * composes on top of one rather than replacing it.
     */

    /**
     * One queue column, decorated where the queue needs more than the generic
     * table gives it.
     *
     * Both the default arrangement and a saved view come through here, so a
     * column behaves the same whichever produced it — the inline priority
     * dropdown used to exist only in the defaults, so restoring a saved view
     * silently turned it back into a read-only badge.
     */
    function column(key, known = null) {
        const def = known ?? store.field(QUEUE_OBJECT, key);
        if (!def) return { key, def };

        // Priority is editable in place, by anyone who can move the queue.
        if (key === 'priority' && canManage()) {
            return { key, def, render: (record, d, objectKey) => renderPriorityInline(record, d, objectKey) };
        }

        // The contact and the company are records, not labels — a manager or
        // SDR scanning the queue can open either straight from the table
        // instead of hunting for it through Contacts/Accounts search.
        if (key === 'full_name') {
            return {
                key,
                def,
                render: (record) => (record.contact_id
                    ? h('a.cell-link', { href: `/contacts/${record.contact_id}` }, record.full_name)
                    : (record.full_name ?? h('span.dim', '—'))),
            };
        }
        if (key === 'account_name') {
            return {
                key,
                def,
                render: (record) => (record.account_id && record.account_name
                    ? h('a.cell-link', { href: `/accounts/${record.account_id}` }, record.account_name)
                    : (record.account_name ?? h('span.dim', '—'))),
            };
        }

        /**
         * A follow-up is a date AND a time, so the column says both.
         *
         * The generic `datetime` cell renders "in 6 days" with the instant in a
         * tooltip, which is right for "last called" and wrong here: the time is
         * the commitment the rep made on the phone, and a manager scanning the
         * Follow-ups tab should not have to hover each row to find out whether
         * 2pm was ever recorded.
         */
        if (key === 'next_follow_up_at') {
            return {
                key,
                def,
                render: (record) => (record.next_follow_up_at
                    ? h('span', { title: relative(record.next_follow_up_at) },
                        date(record.next_follow_up_at, { withTime: true }))
                    : h('span.dim', '—')),
            };
        }

        /**
         * When the queue was scoped to a period, "Last called" says the call in
         * that period — the row exists because of it, and the assignment's own
         * `last_called_at` may be a later call made since.
         */
        if (key === 'last_called_at') {
            return {
                key,
                def,
                render: (record) => {
                    const at = record.inRangeCalledAt ?? record.last_called_at;
                    return at
                        ? h('span', { title: relative(at) }, date(at, { withTime: true }))
                        : h('span.dim', '—');
                },
            };
        }

        return { key, def };
    }

    /** Views saved against the queue — this person's, plus anything shared. */
    const savedViews = () => store.viewsFor(QUEUE_OBJECT);

    /**
     * A link carrying only `?view=` still opens on that view.
     *
     * Applying one writes its filter and columns into the URL too, so most
     * links carry the whole arrangement. But somebody pasting just the view id
     * — or a shared view whose owner changed it since — should still get the
     * saved thing rather than an unfiltered queue with a name on it.
     */
    function normalizeColumns(keys) {
        if (!keys?.length) return defaultColumns();
        return keys.map((key) => (typeof key === 'object' && key.key ? key : column(key)));
    }

    if (queueViewId && !queueFilter && !queueColumns) {
        const opened = savedViews().find((v) => v.id === queueViewId);
        if (opened) {
            queueFilter = opened.filter ?? null;
            queueSort = opened.sort?.length ? opened.sort : null;
            queueColumns = normalizeColumns(opened.columns);
        }
    }

    /**
     * Loads a saved view, or clears back to the plain queue.
     *
     * The filter and columns go into the URL as they already do, so a view is
     * bookmarkable and shareable as a link once it has been applied — the
     * saved record is a name for the arrangement, not a second source of truth
     * about what is on screen.
     */
    function applyQueueView(viewId) {
        const view = savedViews().find((v) => v.id === viewId) ?? null;
        queueViewId = view?.id ?? null;
        queueFilter = view?.filter ?? null;
        queueSort = view?.sort?.length ? view.sort : null;
        queueColumns = normalizeColumns(view?.columns);
        queuePage = 1;
        setParams({ view: queueViewId });
        setQueueParams();
        loadQueue(tab);
    }

    /**
     * Removes a saved view — the queue's own version of the delete button
     * every other list already has (see list.js's `view-tab-delete`). The
     * queue's views live in a `<select>` rather than tabs, so this is a
     * standalone button next to it instead of one per row.
     */
    async function deleteQueueView() {
        const view = savedViews().find((v) => v.id === queueViewId);
        if (!view) return;
        const ok = await confirm({
            title: `Delete "${view.name}"?`,
            message: 'This removes the saved view for everyone it is shared with. The contacts themselves are untouched.',
            confirmLabel: 'Delete', danger: true,
        });
        if (!ok) return;
        try {
            await api.delete(`/api/views/${view.id}`);
            await store.refreshViews();
            toast(`Deleted "${view.name}".`, 'success');
            applyQueueView(null);
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    /**
     * Names the current arrangement and keeps it.
     *
     * Private unless the person can share — `view.share` is a manager-and-above
     * capability, so an SDR saves for themselves and a manager can put one in
     * front of the whole calling team. The checkbox only appears for somebody
     * who can actually tick it.
     */
    async function saveQueueView(columns) {
        const name = h('input.input', { placeholder: 'e.g. Riyadh, no answer, due this week' });
        const share = h('input', { type: 'checkbox' });
        const errorBox = h('div.error');

        const saved = await modal({
            title: 'Save this view',
            body: h('div.stack',
                errorBox,
                h('div.field', h('label', 'Name'), name),
                store.can('view.share') ? h('label.row',
                    share, h('span.small', 'Share with the whole team'),
                ) : null,
                h('div.note-box', 'Keeps the filter and the columns exactly as they are now.'),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', {
                    onclick: async (event) => {
                        const button = event.currentTarget;
                        if (!name.value.trim()) { errorBox.textContent = 'Give it a name.'; return; }
                        button.disabled = true;
                        try {
                            const { view } = await api.post('/api/views', {
                                object_key: QUEUE_OBJECT,
                                name: name.value.trim(),
                                filter: queueFilter ?? null,
                                sort: queueSort ?? [],
                                columns,
                                scope: share.checked ? 'workspace' : 'private',
                            });
                            await store.refreshViews();
                            close(view);
                        } catch (err) {
                            errorBox.textContent = err.message;
                            button.disabled = false;
                        }
                    },
                }, 'Save'),
            ],
        });

        if (saved) {
            toast(saved.scope === 'workspace' ? 'View saved and shared with the team.' : 'View saved.', 'success');
            applyQueueView(saved.id);
        }
    }

    /**
     * Sort by date assigned without needing "Assigned" on screen — the same
     * asc/desc toggle a column header gives you, mirroring the `.dir` arrow
     * in `dataTable()` so the two read as one mechanism.
     */
    function sortToggleButton(field, label) {
        const active = (queueSort ?? []).find((s) => s.field === field);
        return h('button.btn.sm', {
            type: 'button',
            title: `Sort by ${label}`,
            onclick: () => {
                queueSort = [{ field, direction: active?.direction === 'asc' ? 'desc' : 'asc' }];
                setQueueParams();
                loadQueue(tab);
            },
        }, label, h('span.dir', active ? (active.direction === 'desc' ? '↓' : '↑') : '↕'));
    }

    function queueCard() {
        const columns = queueColumns ?? defaultColumns();
        const filterCount = countConditions(queueFilter);
        const searching = queueSearch.trim().length > 0;

        return h('div.card',
            /**
             * Two rows, not one.
             *
             * The stages and the tools were sharing a header — four tabs, two
             * buttons and, for a manager, a person picker, in a single line
             * that wrapped at any sensible width. They are different kinds of
             * control: one says WHICH work, the others say how it is shown.
             */
            h('div.queue-header',
                h('div.segmented', { role: 'group', 'aria-label': 'Queue stage' }, TABS.map(segment)),
                h('div.spacer'),
                h('div.row', { style: { gap: 'var(--space-2)' } },
                    /**
                     * The queue's own quick search — separate from Filters
                     * (exact conditions kept around) and from global search
                     * (⌘K, the whole workspace): this is "find the one
                     * contact I'm thinking of, right now, in my queue".
                     * Matched server-side, phone included — see
                     * `queueSearchClause` in lib/calling.mjs.
                     */
                    h('input.input.sm', {
                        type: 'search',
                        placeholder: 'Search name, company or phone…',
                        value: queueSearch,
                        style: { inlineSize: 'min(16rem, 100%)' },
                        dataset: { focusKey: 'queue-search' },
                        oninput: debounce((e) => {
                            queueSearch = e.target.value;
                            queuePage = 1;
                            queueSelection = new Set();
                            queueAllMatching = false;
                            setQueueParams();
                            loadQueue(tab);
                        }, 300),
                    }),
                    manager ? h('select.input.sm', {
                        'aria-label': 'Whose queue',
                        onchange: (e) => { sdrFilter = e.target.value; setQueueParams(); loadQueue(tab); },
                    }, [
                        h('option', { value: '' }, 'Everyone'),
                        ...meta.sdrs.map((sdr) => h('option', {
                            value: sdr.id, selected: sdr.id === sdrFilter,
                        }, sdr.name)),
                    ]) : null,
                    /**
                     * WHO ACTUALLY CALLED, separate from whose queue it is.
                     *
                     * "Assigned to" (above) can name somebody who has never
                     * touched the phone on a reassigned lead; this answers
                     * the question a manager actually means by "performed
                     * by" — who made the calls, not who owns the row today.
                     */
                    manager ? h('select.input.sm', {
                        'aria-label': 'Performed by',
                        title: 'Filter by who actually made the calls, not who the queue is assigned to.',
                        onchange: (e) => { performedByFilter = e.target.value; setQueueParams(); loadQueue(tab); },
                    }, [
                        h('option', { value: '' }, 'Performed by: anyone'),
                        ...meta.sdrs.map((sdr) => h('option', {
                            value: sdr.id, selected: sdr.id === performedByFilter,
                        }, sdr.name)),
                    ]) : null,
                    /**
                     * Saved views, for whoever is looking.
                     *
                     * The queue's filter and columns already live in the URL, so
                     * a view is only a name for an arrangement somebody wants
                     * back tomorrow. Every role gets this: an SDR saves their
                     * own privately, and sees anything a manager shared with the
                     * team, because that is what `listViews` returns.
                     */
                    savedViews().length ? h('select.input.sm', {
                        'aria-label': 'Saved views',
                        onchange: (e) => applyQueueView(e.target.value || null),
                    }, [
                        h('option', { value: '' }, 'No saved view'),
                        ...savedViews().map((v) => h('option', {
                            value: v.id, selected: v.id === queueViewId,
                        }, v.scope === 'workspace' ? `${v.name} (team)` : v.name)),
                    ]) : null,
                    // Only once a saved view is actually selected — there is
                    // nothing to delete standing on the plain queue. The
                    // server refuses a built-in view's delete with its own
                    // reason (see list.js's identical button), so nothing
                    // needs to be hidden here for that case either.
                    queueViewId && h('button.btn.sm.ghost.danger', {
                        title: 'Delete this saved view',
                        'aria-label': 'Delete this saved view',
                        onclick: () => deleteQueueView(),
                    }, icon('close')),
                    h('button.btn.sm', {
                        class: filterCount ? 'primary' : '',
                        onclick: () => openFilters(),
                    }, icon('filter'), filterCount ? `Filters (${filterCount})` : 'Filters'),
                    h('button.btn.sm', { onclick: () => openColumns(columns) }, icon('columns'), 'Columns'),
                    sortToggleButton('assigned_at', 'Date assigned'),
                    /**
                     * Saving is offered only when there is something to save.
                     *
                     * A "Save view" button beside an untouched queue invites you
                     * to name the default, which is how a view list fills up
                     * with four copies of the same screen.
                     */
                    (filterCount || queueColumns) && h('button.btn.sm', {
                        onclick: () => saveQueueView(columns.map((c) => c.key ?? c)),
                    }, icon('list'), 'Save view'),
                    h('button.btn.sm.primary', { onclick: () => openAddContact() }, '+ Add contact'),
                ),
            ),
            /**
             * The period this queue is scoped to, as a second, quieter row.
             *
             * The range is the dashboard's question asked of the calling floor —
             * "who did we work this week" — so it sits apart from the stage tabs
             * (WHICH work) and the tools (how it is shown), and it carries the
             * same presets, resolved the same way, in the workspace's clock.
             */
            h('div.queue-range', rangePicker()),
            h('div.card-body.flush',
                queueError
                    ? errorState(queueError, () => loadQueue(tab))
                    : !listing
                        ? skeletonRows(4)
                        : !listing.items.length
                            ? emptyState(
                                (filterCount || searching) ? 'Nothing matches'
                                    : tab === 'follow_ups' ? 'No leads in a follow-up sequence'
                                        : tab === 'dead' ? 'No dead leads' : 'Nothing here',
                                searching && filterCount
                                    ? 'No queue entry in this tab matches the search and the filter. Clear one, or widen it.'
                                    : searching
                                        ? `No queue entry in this tab matches "${queueSearch.trim()}".`
                                        : filterCount
                                            ? 'No queue entry in this tab matches the filter. Clear it, or widen it.'
                                            : tab === 'follow_ups'
                                                ? 'Nobody is currently mid follow-up sequence.'
                                                : tab === 'dead'
                                                    ? 'A lead lands here once all four follow-up activities are done and it '
                                                      + 'has not converted. Nothing has reached that point.'
                                                    : 'No contacts in this tab.',
                                (filterCount || searching)
                                    ? h('div.row', { style: { gap: 'var(--space-2)' } },
                                        searching ? h('button.btn', {
                                            onclick: () => { queueSearch = ''; setQueueParams(); loadQueue(tab); },
                                        }, 'Clear the search') : null,
                                        filterCount ? h('button.btn', {
                                            onclick: () => { queueFilter = null; setQueueParams(); loadQueue(tab); },
                                        }, 'Clear the filter') : null,
                                    )
                                    : null,
                            )
                            : dataTable({
                                objectKey: QUEUE_OBJECT,
                                records: listing.items,
                                columns,
                                total: listing.total,
                                page: listing.page,
                                pages: listing.pages,
                                sort: queueSort ?? [],
                                onSort: (key) => {
                                    const existing = (queueSort ?? []).find((s) => s.field === key);
                                    queueSort = [{ field: key, direction: existing?.direction === 'asc' ? 'desc' : 'asc' }];
                                    setQueueParams();
                                    loadQueue(tab);
                                },
                                onPage: (next) => { queuePage = next; loadQueue(tab); },
                                // A queue entry has no page of its own — clicking
                                // it puts that contact in the console beside you.
                                onRowClick: (record) => { view = 'call'; open(record.id); },

                                /**
                                 * Ticking rows is a MANAGER's affair.
                                 *
                                 * An SDR works their own queue; moving people
                                 * between queues is the thing `calling.manage`
                                 * exists for, and the server refuses it anyway.
                                 * Offering boxes an SDR cannot act on would be
                                 * a row of controls that only ever lead to a
                                 * refusal.
                                 */
                                ...(canManage() ? {
                                    selection: { ids: selectedContactIds(), allMatching: queueAllMatching },
                                    allSelected: queueAllMatching,
                                    onSelect: (ids, checked) => {
                                        // Ticking a row by hand while "all matching"
                                        // is on means the box, not the whole tab —
                                        // same rule every other bulk bar in this
                                        // CRM uses.
                                        if (queueAllMatching) { queueAllMatching = false; queueSelection = new Set(); }
                                        // dataTable hands back the ROW ids; the
                                        // selection is kept by contact, which is
                                        // what reassignment actually moves.
                                        for (const rowId of ids) {
                                            const row = listing.items.find((r) => r.id === rowId);
                                            if (!row) continue;
                                            if (checked) queueSelection.add(row.contact_id);
                                            else queueSelection.delete(row.contact_id);
                                        }
                                        paint();
                                    },
                                    onClear: () => { queueAllMatching = false; queueSelection = new Set(); paint(); },
                                    bulkActions: bulkBar(),
                                } : {}),
                            }),
            ),
        );
    }

    /** Whoever can run a queue can move people between them. */
    function canManage() {
        return manager || store.can('calling.manage');
    }

    /**
     * The ticked rows, expressed as ROW ids for the table to draw.
     *
     * The selection itself is held by contact, so this maps back — a contact
     * can hold only one queue row at a time, which is what makes the round trip
     * safe.
     */
    function selectedContactIds() {
        const ids = new Set();
        for (const row of listing?.items ?? []) {
            if (queueSelection.has(row.contact_id)) ids.add(row.id);
        }
        return ids;
    }

    /**
     * Move the ticked people to somebody else's queue.
     *
     * The calls already made stay with the CONTACT rather than the queue row,
     * so a reassigned lead arrives with its history — which is the difference
     * between handing work over and starting it again.
     */
    function bulkBar() {
        const total = listing?.total ?? 0;
        return h('div.row',
            total > 0 && h('button.btn.sm.ghost', {
                title: queueAllMatching
                    ? 'Clear the select-all-matching selection.'
                    : `Select all ${number(total)} contacts matching this tab and filter — every page, not just this one.`,
                onclick: async () => {
                    if (queueAllMatching) {
                        queueAllMatching = false;
                        queueSelection = new Set();
                        paint();
                        return;
                    }
                    try {
                        const query = new URLSearchParams({ tab });
                        if (sdrFilter) query.set('sdr', sdrFilter);
                        if (performedByFilter) query.set('performedBy', performedByFilter);
                        if (queueRange) query.set('range', queueRange);
                        if (queueRange === 'custom') {
                            if (queueFrom) query.set('from', queueFrom);
                            if (queueTo) query.set('to', queueTo);
                        }
                        if (queueFilter) query.set('filter', JSON.stringify(queueFilter));
                        if (queueSearch.trim()) query.set('q', queueSearch.trim());
                        const { ids } = await api.get(`/api/calling/queue/ids?${query}`);
                        queueSelection = new Set(ids);
                        queueAllMatching = true;
                        paint();
                    } catch (err) {
                        toast(err.message, 'error');
                    }
                },
            }, queueAllMatching ? 'Clear all' : `Select all matching (${number(total)})`),
            h('button.btn.sm.primary', { onclick: () => bulkEditSelected() },
                icon('edit'), 'Bulk edit'),
            h('button.btn.sm.ghost.danger', { onclick: () => removeSelected() },
                icon('trash'), 'Remove'),
        );
    }

    /**
     * Priority and assignment live on the ASSIGNMENT; an outcome is a call
     * LOGGED against it (see `bulkLogOutcome`, lib/calling.mjs) — three
     * different things, one dialog. Only what is actually checked gets
     * written; an unticked field is left exactly as it was on every
     * selected record, the same "only what you chose" rule the CRM's own
     * bulk edit dialog holds everywhere else.
     *
     * Services was dropped for one session and restored the next — a
     * calling floor genuinely does correct a lead's services mid-session
     * (a rep learns the account also wants Offshoring, not just HCM), and
     * leaving it out just meant the correction happened somewhere else and
     * the queue silently disagreed with the contact until the page reloaded.
     * Writes straight to the CONTACT (see `setContactServices`,
     * lib/calling.mjs) — never a queue-only field — same as every other
     * field in this dialog.
     */
    async function bulkEditSelected() {
        const contactIds = [...queueSelection];
        if (!contactIds.length) return;

        const draft = { priority: null, assignedTo: meta.sdrs[0]?.id, outcome: null, followUpAt: '', meetingAt: '', services: [] };
        const wantPriority = { on: false };
        const wantAssign = { on: false };
        const wantOutcome = { on: false };
        const wantServices = { on: false };
        const serviceOptions = store.serviceLines();

        const outcomeField = h('div.stack.tight');
        function paintOutcomeField() {
            const need = meta.outcomes.find((o) => o.key === draft.outcome)?.requires;
            mount(outcomeField,
                h('select.input', {
                    onchange: (e) => { draft.outcome = e.target.value; paintOutcomeField(); },
                }, [h('option', { value: '' }, '— choose —'),
                    ...meta.outcomes.map((o) => h('option', { value: o.key, selected: o.key === draft.outcome }, o.label))]),
                need === 'followUpAt' ? h('div.field',
                    h('label', 'Follow-up date and time'),
                    dateInput({
                        value: draft.followUpAt, withTime: true, defaultTime: defaultTime(),
                        onChange: (v) => { draft.followUpAt = v; },
                    }),
                ) : null,
                need === 'meetingAt' ? h('div.field',
                    h('label', 'Meeting date and time'),
                    dateInput({
                        value: draft.meetingAt, withTime: true, defaultTime: defaultTime(),
                        onChange: (v) => { draft.meetingAt = v; },
                    }),
                ) : null,
            );
        }
        paintOutcomeField();

        const chosen = await modal({
            title: `Bulk edit ${number(contactIds.length)} lead${contactIds.length === 1 ? '' : 's'}`,
            size: 'wide',
            body: h('div.stack',
                h('div.note-box', 'Only the fields you tick below are changed. Everything else on each record is left alone.'),
                h('div.field',
                    h('label.checkbox',
                        h('input', { type: 'checkbox', onchange: (e) => { wantPriority.on = e.target.checked; } }),
                        h('span', 'Priority')),
                    h('select.input', {
                        onchange: (e) => { draft.priority = e.target.value; },
                    }, ['A', 'B', 'C'].map((p) => h('option', { value: p }, p))),
                ),
                meta.sdrs.length > 0 && h('div.field',
                    h('label.checkbox',
                        h('input', { type: 'checkbox', onchange: (e) => { wantAssign.on = e.target.checked; } }),
                        h('span', 'Assigned to')),
                    h('select.input', {
                        onchange: (e) => { draft.assignedTo = e.target.value; },
                    }, meta.sdrs.map((sdr) => h('option', { value: sdr.id }, `${sdr.name} · ${sdr.role}`))),
                    h('span.help', 'The calls already made stay with each contact, so the person taking them '
                        + 'over can see what has happened rather than starting again.'),
                ),
                h('div.field',
                    h('label.checkbox',
                        h('input', { type: 'checkbox', onchange: (e) => { wantOutcome.on = e.target.checked; } }),
                        h('span', 'Outcome')),
                    h('span.help', 'Logs this outcome against every selected lead — the same as ringing each one and picking it on the call screen.'),
                    outcomeField,
                ),
                serviceOptions.length > 0 && h('div.field',
                    h('label.checkbox',
                        h('input', { type: 'checkbox', onchange: (e) => { wantServices.on = e.target.checked; } }),
                        h('span', 'Services')),
                    h('span.help', 'Replaces the contact’s services with exactly what’s ticked below — not added to what’s already there.'),
                    h('div.stack.tight', serviceOptions.map((s) => h('label.checkbox',
                        h('input', {
                            type: 'checkbox',
                            onchange: (e) => {
                                draft.services = e.target.checked
                                    ? [...draft.services, s.key]
                                    : draft.services.filter((k) => k !== s.key);
                            },
                        }),
                        h('span', s.label)))),
                ),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', {
                    onclick: () => {
                        if (!wantPriority.on && !wantAssign.on && !wantOutcome.on && !wantServices.on) return close(undefined);
                        if (wantOutcome.on && !draft.outcome) {
                            toast('Choose an outcome, or untick it.', 'error');
                            return undefined;
                        }
                        if (wantServices.on && !draft.services.length) {
                            toast('Tick at least one service, or untick the Services field.', 'error');
                            return undefined;
                        }
                        return close({
                            priority: wantPriority.on ? draft.priority : undefined,
                            assignedTo: wantAssign.on ? draft.assignedTo : undefined,
                            outcome: wantOutcome.on ? draft.outcome : undefined,
                            services: wantServices.on ? draft.services : undefined,
                            followUpAt: draft.followUpAt || null,
                            meetingAt: draft.meetingAt || null,
                        });
                    },
                }, 'Apply'),
            ],
        });
        if (!chosen) return;

        const results = [];
        try {
            if (chosen.priority !== undefined) {
                const r = await api.patch('/api/calling/priority', { contactIds, priority: chosen.priority });
                results.push(`${r.updated} priority`);
            }
            if (chosen.assignedTo !== undefined) {
                // Every one of these rows is already on the queue by definition,
                // so the server's "are you sure" round trip would ask about the
                // thing that was just asked for — sent outright.
                const r = await api.post('/api/calling/assign', {
                    ids: contactIds, assignedTo: chosen.assignedTo, priority: chosen.priority ?? 'B', reassign: true,
                });
                results.push(r.message);
            }
            let outcomeFailures = 0;
            if (chosen.outcome !== undefined) {
                const r = await api.post('/api/calling/log-bulk', {
                    contactIds, outcome: chosen.outcome, followUpAt: chosen.followUpAt, meetingAt: chosen.meetingAt,
                });
                outcomeFailures = r.failed?.length ?? 0;
                results.push(`${r.updated} logged as ${r.outcome}`
                    + (outcomeFailures ? ` (${outcomeFailures} could not be)` : ''));
            }
            if (chosen.services !== undefined) {
                const r = await api.patch('/api/calling/services', { contactIds, services: chosen.services });
                results.push(`${r.updated} services`);
            }
            toast(`Updated: ${results.join(', ')}.`, outcomeFailures ? 'warning' : 'success');
            queueSelection = new Set();
            queueAllMatching = false;
            await loadQueue(tab);
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    /**
     * Take the ticked people off the calling queue entirely.
     *
     * The selection is sent by CONTACT — the shape it is already held in — so
     * "select all matching" removes every page, not just the rows on screen.
     * The calls already made stay with each contact; only the queue row ends.
     */
    async function removeSelected() {
        const contactIds = [...queueSelection];
        if (!contactIds.length) return;

        const ok = await confirm({
            title: `Remove ${number(contactIds.length)} lead${contactIds.length === 1 ? '' : 's'} from the calling queue?`,
            message: 'They come off the calling screen for everyone. Calls already made are kept.',
            confirmLabel: 'Remove',
            danger: true,
        });
        if (!ok) return undefined;

        try {
            const result = await api.post('/api/calling/remove', { contactIds });
            toast(`${number(result.removed)} lead${result.removed === 1 ? '' : 's'} removed from the calling queue.`, 'success');
            queueSelection = new Set();
            queueAllMatching = false;
            await loadQueue(tab);
        } catch (err) {
            toast(err.message, 'error');
        }
        return undefined;
    }

    /** How many conditions a filter actually carries, for the button's badge. */
    function countConditions(node) {
        if (!node) return 0;
        if (Array.isArray(node.children)) return node.children.reduce((a, c) => a + countConditions(c), 0);
        return node.field ? 1 : 0;
    }

    /** Filter and columns live in the URL, exactly as they do on a list. */
    function setQueueParams() {
        setParams({
            filter: queueFilter ? JSON.stringify(queueFilter) : null,
            sort: queueSort ? JSON.stringify(queueSort) : null,
            columns: queueColumns ? JSON.stringify(queueColumns.map((c) => c.key ?? c)) : null,
            sdr: sdrFilter ? sdrFilter : null,
            performedBy: performedByFilter ? performedByFilter : null,
            range: queueRange || null,
            from: queueRange === 'custom' ? (queueFrom || null) : null,
            to: queueRange === 'custom' ? (queueTo || null) : null,
            q: queueSearch.trim() || null,
        });
    }

    const QUEUE_PRESETS = [
        ['', 'All time'],
        ['today', 'Today'],
        ['week', 'Week'],
        ['month', 'Month'],
        ['custom', 'Custom'],
    ];

    /**
     * The queue's date range: the dashboard's presets, but it only ever needs
     * the four a calling floor runs on. Custom waits for two readable dates
     * before asking the server for anything, exactly as the dashboard's does.
     */
    function rangePicker() {
        const custom = queueRange === 'custom';
        const draft = { from: queueFrom, to: queueTo };

        const apply = () => {
            // A complete `YYYY-MM-DD`, not just a truthy string — a plain
            // truthiness check let a partially-typed date ("2026-08-") through
            // on blur and sent it straight to the server. dateInput reports
            // every keystroke, not only finished ones, same as the dashboard's
            // own custom range (public/js/pages/dashboard.js) and Meetings'.
            if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.from) || !/^\d{4}-\d{2}-\d{2}$/.test(draft.to)) return;
            queueRange = 'custom';
            queueFrom = draft.from;
            queueTo = draft.to;
            queuePage = 1;
            setQueueParams();
            loadQueue(tab);
        };

        return h('div.row', {
            style: { gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' },
        },
        h('div.row', { style: { gap: '0.15rem' } },
            QUEUE_PRESETS.map(([key, label]) => h('button.btn.sm', {
                class: key === queueRange ? 'primary' : 'ghost',
                onclick: () => {
                    if (key === 'custom') { queueRange = 'custom'; setQueueParams(); paint(); return; }
                    if (key === queueRange) return;
                    queueRange = key;
                    queuePage = 1;
                    setQueueParams();
                    loadQueue(tab);
                },
            }, label)),
        ),
        custom ? h('div.row', { style: { gap: 'var(--space-2)', alignItems: 'center' } },
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
        ) : null,
        h('div.spacer'),
        queueRange !== '' && !custom
            ? h('span.xs.dim', 'Scoped to calls in this period')
            : null,
        );
    }

    async function openFilters() {
        let working = queueFilter ?? { op: 'and', children: [] };
        const host = h('div');
        // filterBuilder rebuilds its whole tree on every keystroke (there is
        // no DOM reconciliation in this app), which would otherwise destroy
        // the very input being typed into after one character — a phone
        // number typed into the "contains" box stopped after the first
        // digit. captureFocus/restoreFocus (core.js) carry the caret across
        // the rebuild; see the identical fix in list.js's own openFilters.
        const repaint = () => {
            const focus = captureFocus(host);
            mount(host, filterBuilder(QUEUE_OBJECT, working, (next) => {
                working = next;
                repaint();
            }));
            restoreFocus(host, focus);
        };
        repaint();

        const result = await modal({
            title: 'Filter the queue',
            size: 'wide',
            body: h('div.stack', host),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('div.spacer'),
                h('button.btn', { onclick: () => close({ clear: true }) }, 'Clear'),
                h('button.btn.primary', { onclick: () => close({ apply: true }) }, 'Apply'),
            ],
        });
        if (!result) return;

        queueFilter = result.clear ? null : working;
        queuePage = 1;
        setQueueParams();
        loadQueue(tab);
    }

    async function openColumns(current) {
        const result = await columnPicker(QUEUE_OBJECT, (current ?? []).map((c) => c.key ?? c));
        if (!result) return;
        queueColumns = normalizeColumns(result.columns);
        setQueueParams();
        paint();
    }

    async function openAddContact() {
        const draft = { full_name: '', phone: '', email: '', title: '', account_name: '', account_type: 'Regional', services: [] };
        const errorBox = h('div.error');
        // Service lines for the account — try store, fallback to meta, fallback to static list
        let serviceOptions = [];
        try { serviceOptions = store.serviceLines?.() ?? []; } catch {}
        if (!serviceOptions.length) {
            try {
                const metaFull = await api.get('/api/meta').catch(() => null);
                if (metaFull?.serviceLines?.length) serviceOptions = metaFull.serviceLines;
                else if (metaFull?.service_lines?.length) serviceOptions = metaFull.service_lines;
            } catch {}
        }
        if (!serviceOptions.length) {
            serviceOptions = [
                { key: 'recruitment', label: 'Recruitment' },
                { key: 'hcm', label: 'HCM' },
                { key: 'offshoring', label: 'Offshoring' },
                { key: 'od', label: 'OD' },
                { key: 'training_team_building', label: 'Training & Team Building' },
            ];
        }

        const accountTypeSelect = h('select.input', {
            value: draft.account_type,
            onchange: (e) => { draft.account_type = e.target.value; },
        }, [
            h('option', { value: 'Egypt' }, 'Egypt'),
            h('option', { value: 'Regional' }, 'Regional'),
        ]);
        // Keep draft in sync with select initial value
        accountTypeSelect.value = draft.account_type;

        const servicesBox = h('div.stack.tight', serviceOptions.map((s) => h('label.row', { style: { gap: 'var(--space-2)', alignItems: 'center' } },
            h('input', {
                type: 'checkbox', value: s.key,
                checked: draft.services.includes(s.key),
                onchange: (e) => {
                    if (e.target.checked) draft.services = [...new Set([...draft.services, s.key])];
                    else draft.services = draft.services.filter((k) => k !== s.key);
                },
            }),
            h('span.small', s.label ?? s.key),
        )));

        const result = await modal({
            title: 'Add contact to calling',
            size: 'wide',
            body: h('div.stack',
                errorBox,
                h('div.grid', { style: { gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' } },
                    h('div.field', h('label', 'Full name *'), h('input.input', {
                        placeholder: 'e.g. Lara Ahmed', value: draft.full_name,
                        oninput: (e) => { draft.full_name = e.target.value; },
                    })),
                    h('div.field', h('label', 'Title'), h('input.input', {
                        placeholder: 'e.g. Head of HR', value: draft.title,
                        oninput: (e) => { draft.title = e.target.value; },
                    })),
                ),
                h('div.grid', { style: { gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' } },
                    h('div.field', h('label', 'Phone'), h('input.input', {
                        placeholder: '+9665…', value: draft.phone,
                        oninput: (e) => { draft.phone = e.target.value; },
                    })),
                    h('div.field', h('label', 'Email'), h('input.input', {
                        placeholder: 'name@company.com', value: draft.email, type: 'email',
                        oninput: (e) => { draft.email = e.target.value; },
                    })),
                ),
                h('div.field', h('label', 'Account / Company *'), h('input.input', {
                    placeholder: 'e.g. Acme Co', value: draft.account_name,
                    oninput: (e) => { draft.account_name = e.target.value; },
                })),
                h('div.grid', { style: { gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' } },
                    h('div.field', h('label', 'Account type *'), accountTypeSelect,
                        h('span.xs.dim', 'Egypt or Regional — required for SDR-created accounts.')),
                    h('div.field', h('label', 'Services *'), servicesBox,
                        h('span.xs.dim', 'At least one service — e.g. HCM for headcount, Offshoring, etc.')),
                ),
                h('p.xs.dim', 'Creates the contact and account (visible in Contacts/Accounts) with the chosen type/services and puts it straight on your calling queue.'),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', {
                    onclick: async (event) => {
                        const btn = event.currentTarget;
                        if (!draft.full_name.trim()) { errorBox.textContent = 'Full name is required.'; return; }
                        if (!draft.account_name.trim()) { errorBox.textContent = 'Account / Company is required.'; return; }
                        if (!draft.account_type) { errorBox.textContent = 'Account type is required.'; return; }
                        if (!draft.services.length) { errorBox.textContent = 'Pick at least one service.'; return; }
                        btn.disabled = true;
                        btn.textContent = 'Adding…';
                        try {
                            const res = await api.post('/api/calling/contacts', {
                                full_name: draft.full_name.trim(),
                                phone: draft.phone.trim() || undefined,
                                email: draft.email.trim() || undefined,
                                title: draft.title.trim() || undefined,
                                account_name: draft.account_name.trim(),
                                account_type: draft.account_type,
                                services: draft.services,
                            });
                            toast(res.message || 'Contact added to your queue.', 'success');
                            close(true);
                            // New lead is in To call — jump there and reload
                            tab = 'to_call';
                            await loadQueue(tab);
                            if (res.contact?.id) {
                                const row = listing?.items.find((r) => r.contact_id === res.contact.id);
                                if (row) { view = 'call'; await open(row.id); } else { view = 'queue'; paint(); }
                            }
                        } catch (err) {
                            errorBox.textContent = err.message;
                            btn.disabled = false;
                            btn.textContent = 'Add to queue';
                        }
                    },
                }, 'Add to queue'),
            ],
        });
        return result;
    }

    /**
     * Edit the lead on screen without leaving the calling console.
     *
     * Same fields, same layout as "Add contact to calling" above — this is
     * the same lead, just already on the queue — pre-filled with what is
     * already known rather than opt-in-per-field the way the CRM's bulk
     * edit dialogs are, because there is exactly one record here and
     * showing its current values is strictly more useful than a blank form.
     *
     * Writes through `/api/calling/assignments/:id/contact` (calling.js
     * server-side, `editContact`) rather than the generic contacts
     * endpoint — an SDR cannot reach that one at all (see the file comment
     * at the top of api/calling.mjs), and this is their only door to their
     * own lead's details.
     *
     * Priority, "assigned to" and Queue status are queue facts, not the
     * lead's own, and all three already require `calling.manage`
     * server-side (`setPriority`, `assignContacts`, `setQueueStatus`) —
     * shown here only for a manager, through those exact existing
     * endpoints, not a new write path. Queue status offers only what
     * `setQueueStatus` accepts (`meta.queueStatuses`) — `dead` is
     * deliberately absent there (see its own comment in lib/calling.mjs):
     * retiring a lead is a fact `markDead` records with a reason, not a
     * status flipped from a list, so an already-dead lead shows its status
     * as a note instead of an editable control.
     */
    async function openEditLead() {
        if (!current) return;
        const serviceOptions = store.serviceLines?.() ?? [];
        const draft = {
            full_name: current.name ?? '',
            title: current.title ?? '',
            phone: current.phone ?? '',
            email: current.email ?? '',
            services: [...(current.services ?? [])],
            priority: current.priority,
            assignedTo: current.assignedTo,
            queueStatus: current.queueStatus,
        };
        const errorBox = h('div.error');

        const servicesBox = h('div.stack.tight', serviceOptions.map((s) => h('label.row', { style: { gap: 'var(--space-2)', alignItems: 'center' } },
            h('input', {
                type: 'checkbox', checked: draft.services.includes(s.key),
                onchange: (e) => {
                    draft.services = e.target.checked
                        ? [...new Set([...draft.services, s.key])]
                        : draft.services.filter((k) => k !== s.key);
                },
            }),
            h('span.small', s.label ?? s.key),
        )));

        const result = await modal({
            title: 'Edit lead',
            size: 'wide',
            body: h('div.stack',
                errorBox,
                h('div.grid', { style: { gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' } },
                    h('div.field', h('label', 'Full name *'), h('input.input', {
                        value: draft.full_name,
                        oninput: (e) => { draft.full_name = e.target.value; },
                    })),
                    h('div.field', h('label', 'Title'), h('input.input', {
                        value: draft.title,
                        oninput: (e) => { draft.title = e.target.value; },
                    })),
                ),
                h('div.grid', { style: { gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' } },
                    h('div.field', h('label', 'Phone'), h('input.input', {
                        value: draft.phone,
                        oninput: (e) => { draft.phone = e.target.value; },
                    })),
                    h('div.field', h('label', 'Email'), h('input.input', {
                        value: draft.email, type: 'email',
                        oninput: (e) => { draft.email = e.target.value; },
                    })),
                ),
                serviceOptions.length > 0 && h('div.field', h('label', 'Services'), servicesBox),
                meta.canManage && h('div.grid', { style: { gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' } },
                    h('div.field', h('label', 'Priority'), h('select.input', {
                        value: draft.priority,
                        onchange: (e) => { draft.priority = e.target.value; },
                    }, meta.priorities.map((p) => h('option', { value: p, selected: p === draft.priority }, p)))),
                    meta.sdrs.length > 0 && h('div.field', h('label', 'Assigned to'), h('select.input', {
                        value: draft.assignedTo,
                        onchange: (e) => { draft.assignedTo = e.target.value; },
                    }, meta.sdrs.map((sdr) => h('option', {
                        value: sdr.id, selected: sdr.id === draft.assignedTo,
                    }, `${sdr.name} · ${sdr.role}`)))),
                ),
                /**
                 * `dead` is deliberately absent from `meta.queueStatuses` — see
                 * BULK_QUEUE_STATUSES in lib/calling.mjs. A lead already dead
                 * shows its status as a note instead of a mismatched select,
                 * rather than offering a control that would only ever be
                 * refused by the server (or worse, silently coerced to some
                 * other value).
                 */
                meta.canManage && (meta.queueStatuses ?? []).includes(draft.queueStatus) && h('div.field',
                    h('label', 'Queue status'),
                    h('select.input', {
                        value: draft.queueStatus,
                        onchange: (e) => { draft.queueStatus = e.target.value; },
                    }, meta.queueStatuses.map((s) => h('option', {
                        value: s, selected: s === draft.queueStatus,
                    }, humanise(s)))),
                    h('span.help', 'A manual override — for reorganising the board, not for logging a call outcome.'),
                ),
                meta.canManage && !(meta.queueStatuses ?? []).includes(draft.queueStatus) && h('p.xs.dim',
                    `Queue status: ${humanise(draft.queueStatus ?? 'unknown')} — not editable here.`),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', {
                    onclick: async (event) => {
                        const btn = event.currentTarget;
                        if (!draft.full_name.trim()) { errorBox.textContent = 'Full name is required.'; return; }
                        btn.disabled = true;
                        btn.textContent = 'Saving…';
                        try {
                            await api.patch(`/api/calling/assignments/${current.id}/contact`, {
                                full_name: draft.full_name.trim(),
                                title: draft.title.trim(),
                                phone: draft.phone.trim(),
                                email: draft.email.trim(),
                                services: draft.services,
                            });
                            if (meta.canManage && draft.priority !== current.priority) {
                                await api.patch('/api/calling/priority', {
                                    assignmentIds: [current.id], priority: draft.priority,
                                });
                            }
                            if (meta.canManage && draft.assignedTo && draft.assignedTo !== current.assignedTo) {
                                await api.post('/api/calling/assign', {
                                    ids: [current.contactId], assignedTo: draft.assignedTo,
                                    priority: draft.priority, reassign: true,
                                });
                            }
                            if (meta.canManage && (meta.queueStatuses ?? []).includes(draft.queueStatus)
                                && draft.queueStatus !== current.queueStatus) {
                                await api.patch('/api/calling/status', {
                                    assignmentIds: [current.id], status: draft.queueStatus,
                                });
                            }
                            toast('Lead updated.', 'success');
                            close(true);
                            // Same lead, fresh data — never navigates away from
                            // the console, and never leaves stale values on
                            // screen behind a "Saved" toast.
                            await open(current.id);
                        } catch (err) {
                            errorBox.textContent = err.message;
                            btn.disabled = false;
                            btn.textContent = 'Save';
                        }
                    },
                }, 'Save'),
            ],
        });
        return result;
    }

    function viewToggle() {
        return h('div.row', { style: { gap: '0.15rem' } },
            h('button.btn.sm', {
                class: view === 'call' ? 'primary' : 'ghost',
                onclick: () => { view = 'call'; paint(); },
            }, 'Calling'),
            h('button.btn.sm', {
                class: view === 'queue' ? 'primary' : 'ghost',
                onclick: () => { view = 'queue'; if (!listing) loadQueue(); else paint(); },
            }, 'My queue'),
        );
    }

    function paint() {
        /**
         * The console is capped; the queue is not.
         *
         * `.calling` is 52rem wide, which is right for the thing it was built
         * for — one contact, one note box, a column of text somebody reads
         * while talking. It is wrong for the queue, which is a grid: the table
         * was being squeezed into 832px on a 1520px screen, so adding a column
         * made every existing one narrower instead of using the room to the
         * right of it, and enough columns produced a scrollbar with half the
         * window empty beside it.
         *
         * Same wrapper, two jobs, so the width follows the job.
         */
        container.classList.toggle('calling-wide', view === 'queue');
        // mount() never reconciles — it rebuilds the whole tree, including the
        // queue's own quick-search input. loadQueue() calls paint() on every
        // debounced keystroke, so without carrying the caret across the
        // rebuild the box only ever accepted one character before losing
        // focus. Same fix as openFilters()'s repaint() above.
        const focus = captureFocus(container);
        mount(container, header(), viewToggle(), view === 'call' ? callCard() : queueCard());
        restoreFocus(container, focus);
    }

    if (openAssignmentId) view = 'call';
    await open(openAssignmentId ?? today.next?.id ?? null);

    /**
     * The view you arrive on has to fetch itself.
     *
     * A manager lands on the queue rather than the console, and nothing here
     * loaded it — `loadQueue` ran only from a tab click or the view toggle. So
     * the queue sat on its skeleton from the moment the page opened, looking
     * like a list that was still loading rather than one nobody had asked for.
     * The console has always fetched itself through `open` above; this is the
     * same thing for the other view.
     */
    if (view === 'queue') await loadQueue();

    // Number keys pick an outcome, so the common case never needs the mouse.
    document.addEventListener('keydown', (event) => {
        if (!current || busy) return;
        if (event.target.tagName === 'TEXTAREA' || event.target.tagName === 'INPUT') return;
        const index = Number(event.key) - 1;
        if (Number.isInteger(index) && meta.outcomes[index]) {
            outcome = meta.outcomes[index].key;
            lastError = null;
            paint();
        }
    });
}
