/**
 * The CRM calendar — renewal dates and scheduled meetings, month by month.
 *
 * Two event kinds only, on purpose (see api/calendar.mjs's header): this is
 * not a general-purpose events system, it is the two dates already tracked
 * elsewhere in this product placed on the day they actually fall. Clicking
 * a renewal event opens the Agreement; clicking a meeting opens the Account
 * or Contact it was booked against.
 */
import { h, mount, params, setParams } from '../core.js';
import { api } from '../api.js';
import { skeletonRows, errorState } from '../components.js';
import { setPageTitle } from '../app.js';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function currentMonthKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(key, delta) {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Monday-first grid of every day shown for this month, including the lead/trail days from neighbouring months. */
function gridDays(monthKey) {
    const [y, m] = monthKey.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const startOffset = (first.getUTCDay() + 6) % 7; // 0 = Monday
    const gridStart = new Date(first);
    gridStart.setUTCDate(gridStart.getUTCDate() - startOffset);

    const days = [];
    for (let i = 0; i < 42; i += 1) {
        const d = new Date(gridStart);
        d.setUTCDate(gridStart.getUTCDate() + i);
        days.push({
            date: d.toISOString().slice(0, 10),
            day: d.getUTCDate(),
            inMonth: d.getUTCMonth() === m - 1,
        });
    }
    return days;
}

export async function calendarPage(content) {
    setPageTitle('Calendar');
    const container = h('div.content-inner');
    mount(content, container);

    let monthKey = /^\d{4}-\d{2}$/.test(params().month ?? '') ? params().month : currentMonthKey();

    async function load() {
        mount(container, skeletonRows(6));
        let data;
        try {
            data = await api.get(`/api/calendar?month=${monthKey}`);
        } catch (err) {
            mount(container, errorState(err.message, () => load()));
            return;
        }
        paint(data);
    }

    function go(delta) {
        monthKey = shiftMonth(monthKey, delta);
        setParams({ month: monthKey });
        load();
    }

    function paint(data) {
        const eventsByDay = new Map();
        for (const e of data.events) {
            if (!eventsByDay.has(e.date)) eventsByDay.set(e.date, []);
            eventsByDay.get(e.date).push(e);
        }
        const [y, m] = monthKey.split('-').map(Number);
        const today = new Date().toISOString().slice(0, 10);

        mount(container,
            h('div.record-header',
                h('div.record-title',
                    h('h1', `${MONTH_NAMES[m - 1]} ${y}`),
                    h('div.spacer'),
                    h('button.btn.sm.ghost', { onclick: () => go(-1) }, '← Prev'),
                    h('button.btn.sm.ghost', { onclick: () => { monthKey = currentMonthKey(); setParams({ month: monthKey }); load(); } }, 'Today'),
                    h('button.btn.sm.ghost', { onclick: () => go(1) }, 'Next →'),
                ),
                h('div.record-sub', h('span', 'Agreement renewals and scheduled meetings, on the day they fall.')),
            ),

            data.events.length === 0 && h('div.note-box', { style: { marginBlockEnd: 'var(--space-3)' } },
                'Nothing on the calendar this month.'),

            h('div.calendar-grid',
                WEEKDAYS.map((w) => h('div.calendar-weekday', w)),
                gridDays(monthKey).map((d) => h('div.calendar-day', {
                    class: [!d.inMonth ? 'dim' : '', d.date === today ? 'today' : ''].filter(Boolean).join(' '),
                },
                h('div.calendar-day-num', String(d.day)),
                h('div.calendar-day-events',
                    (eventsByDay.get(d.date) ?? []).slice(0, 4).map((e) => h('a.calendar-event', {
                        class: e.kind,
                        href: e.link ?? '#',
                        title: e.detail ?? e.title,
                    }, e.title)),
                    (eventsByDay.get(d.date) ?? []).length > 4
                        && h('div.xs.dim', `+${eventsByDay.get(d.date).length - 4} more`),
                ),
                )),
            ),
        );
    }

    await load();
    return undefined;
}
