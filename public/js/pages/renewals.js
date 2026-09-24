/**
 * Renewals and notice dates.
 *
 * ── WHY THIS IS ITS OWN SCREEN ──────────────────────────────────────────────
 *
 * `GET /api/agreements/renewals` has existed, complete and correct, with no
 * caller. Everything it computes — the notice date, how long until it, whether
 * it has already gone past — was reachable only as four numbers on a dashboard
 * tile, and the agreement list could not express any of it: `notice_days` is
 * arithmetic against `expiry_date`, and the filter language compares columns
 * rather than doing sums between them.
 *
 * So the one question this data exists to answer — "what do I have to decide
 * about, and by when?" — had nowhere to be asked.
 *
 * ── THE NOTICE DATE IS WHEN THE WINDOW OPENS, NOT A DEADLINE ────────────────
 *
 * A 12-month contract with 90 days' notice enters its notice window in month
 * nine. That is the date this page sorts by and leads with — the expiry is
 * shown beside it as context, and sorting by expiry would put the urgent thing
 * third — but arriving at the notice date is the START of the decision
 * window, not the end of it. An agreement past its notice date and still
 * short of expiry is IN that window: shown in yellow, not red, because there
 * is still time to act.
 *
 * An agreement whose notice window has fully closed — past its EXPIRY date
 * with no decision recorded — is not filtered out and not sorted to the
 * bottom: it goes first, in red. It is the one row on the page that somebody
 * has actually missed.
 */
import { h, mount, navigate, params, setParams, date, number } from '../core.js';
import { api } from '../api.js';
import { emptyState, skeletonRows, errorState, statTile } from '../components.js';
import { setPageTitle } from '../app.js';

/** The windows worth offering. A quarter is the default because most notice
 *  periods in this business are 30, 60 or 90 days. */
const WINDOWS = [
    [30, '30 days'],
    [90, '90 days'],
    [180, '6 months'],
    [365, 'A year'],
];

/**
 * The other questions this same screen answers, beside "what's due for
 * notice" — Active and Renewing Soon share the notice-window endpoint;
 * Renewed/Expired/Terminated are a status, not a clock, so the day window
 * is hidden for them (see `paint`).
 */
const STATUSES = [
    ['renewing', 'Renewing soon'],
    ['active', 'Active'],
    ['renewed', 'Renewed'],
    ['expired', 'Expired'],
    ['terminated', 'Terminated'],
];

export async function renewalsPage(content) {
    setPageTitle('Renewals');

    const container = h('div.content-inner');
    mount(content, container);

    async function load() {
        const days = Number(params().days) || 90;
        const status = STATUSES.some(([k]) => k === params().status) ? params().status : 'renewing';
        mount(container, skeletonRows(5));

        let data;
        try {
            data = await api.get(`/api/agreements/renewals?days=${days}&status=${status}`);
        } catch (err) {
            mount(container, errorState(err.message, () => load()));
            return;
        }
        paint(data, days, status);
    }

    function paint(data, days, status) {
        const rows = data.agreements ?? [];
        const showWindow = status === 'renewing';
        const showNoticeColumns = status === 'renewing' || status === 'active';

        mount(container,
            h('div.record-header',
                h('div.record-title',
                    h('h1', 'Renewals & notice dates'),
                    h('div.spacer'),
                    h('a.btn', { href: '/calendar' }, 'View as calendar'),
                    h('a.btn', { href: '/agreements' }, 'All agreements'),
                ),
                h('div.record-sub',
                    h('span', status === 'renewing'
                        ? 'Signed agreements whose notice window falls inside the range below. The notice date is when '
                          + 'that window opens, not a deadline — it stays open until the agreement expires.'
                        : status === 'active' ? 'Every currently signed agreement, notice date first.'
                        : status === 'renewed' ? 'Agreements a later agreement now supersedes — the decision was already made.'
                        : `Agreements marked ${status}.`),
                ),
            ),

            h('div.row', { style: { gap: '0.15rem', marginBlockEnd: 'var(--space-3)', flexWrap: 'wrap' } },
                STATUSES.map(([value, label]) => h('button.btn.sm', {
                    class: value === status ? 'primary' : 'ghost',
                    onclick: () => { setParams({ status: value }); load(); },
                }, label)),
            ),

            showWindow && h('div.row', { style: { gap: '0.15rem', marginBlockEnd: 'var(--space-4)' } },
                WINDOWS.map(([value, label]) => h('button.btn.sm', {
                    class: value === days ? 'primary' : 'ghost',
                    onclick: () => { setParams({ days: value }); load(); },
                }, label)),
            ),

            showWindow && h('div.totals-grid', { style: { marginBlockEnd: 'var(--space-4)' } },
                h('div.total-cell', statTile('Coming up', number(rows.length),
                    `Inside the ${data.windowDays}-day window`)),
                h('div.total-cell', statTile('In notice period', number(data.inNoticePeriod),
                    data.inNoticePeriod ? 'The window is open — act now' : 'None open right now',
                    { tone: data.inNoticePeriod ? 'warning' : '' })),
                h('div.total-cell', statTile('Past notice window', number(data.overdue),
                    data.overdue ? 'Expired with no decision made' : 'Nothing has been missed',
                    { tone: data.overdue ? 'danger' : '' })),
            ),

            showWindow && data.overdue > 0 && h('div.note-box.danger', { style: { marginBlockEnd: 'var(--space-4)' } },
                h('div.strong', `${data.overdue} agreement(s) are past their notice window`),
                h('p.small', 'They have reached their expiry date with no decision recorded, so they renew on their '
                    + 'existing terms unless the client agrees otherwise. They are listed first.'),
            ),

            h('div.card',
                h('div.card-body.flush',
                    rows.length === 0
                        ? emptyState('Nothing here',
                            status === 'renewing'
                                ? `No signed agreement has a notice date inside the next ${data.windowDays} days. `
                                  + 'Widen the window above, or check that your agreements carry an expiry date and '
                                  + 'a notice period — an agreement without either cannot be counted here.'
                                : `No agreements are currently ${status === 'active' ? 'signed' : status}.`)
                        : h('div.table-wrap', h('table.data',
                            h('thead', h('tr',
                                h('th', 'Account'),
                                h('th', 'Agreement'),
                                h('th', 'Type'),
                                showNoticeColumns ? h('th', 'Notice starts') : h('th', 'Effective'),
                                showNoticeColumns ? h('th.num', 'Days left') : null,
                                h('th', 'Expires'),
                                showNoticeColumns ? h('th.num', 'Notice') : null,
                            )),
                            h('tbody', rows.map((r) => renewalRow(r, showNoticeColumns))),
                        )),
                ),
            ),

            status === 'renewing' && h('p.xs.dim', { style: { marginBlockStart: 'var(--space-3)' } },
                'Only signed agreements with an expiry date appear here. Notice is counted back from the '
                + 'expiry date, so an agreement with no notice period is due for a decision on the day it ends.'),
        );
    }

    function renewalRow(r, showNoticeColumns) {
        const rowClass = r.noticePassed ? 'row-danger' : r.inNoticePeriod ? 'row-warning' : '';
        return h('tr', { class: rowClass },
            h('td', r.account_id
                ? h('a.cell-link', { href: `/accounts/${r.account_id}` }, r.account_name ?? 'Account')
                : h('span.dim', '—')),
            h('td', h('a', { href: `/agreements/${r.id}` }, r.title || r.number || 'Agreement')),
            h('td', h('span.badge', String(r.type ?? '—').toUpperCase())),
            showNoticeColumns
                ? h('td', { title: 'The day the notice window opens — not a deadline. It stays open until expiry.' }, r.noticeDate ? date(r.noticeDate) : '—')
                : h('td', r.effective_date ? date(r.effective_date) : '—'),
            /**
             * DAYS LEFT — always a countdown, never a count-up, and never
             * "passed" for a row that is simply inside its (still open)
             * notice window.
             *
             * Before the notice date: days until the window opens. Inside the
             * window: a yellow "in notice period" badge — the window is OPEN,
             * this is exactly when it should be acted on, not a state to
             * apologise for. Only once the agreement has reached its own
             * expiry with nothing decided does this read as missed, in red.
             */
            showNoticeColumns ? h('td.num',
                r.noticePassed
                    ? h('span.badge.danger', { title: `Notice window closed ${Math.abs(r.daysToExpiry)} day${Math.abs(r.daysToExpiry) === 1 ? '' : 's'} ago` },
                        'Expired')
                    : r.inNoticePeriod
                        ? h('span.badge.warning', { title: `${number(r.daysToExpiry)} day${r.daysToExpiry === 1 ? '' : 's'} left before expiry` },
                            'In notice period')
                        : h('span', { class: r.daysToNotice <= 14 ? 'strong' : '' }, number(r.daysToNotice)),
            ) : null,
            h('td', { title: r.daysToExpiry !== undefined ? `${r.daysToExpiry} days away` : undefined }, r.expiry_date ? date(r.expiry_date) : '—'),
            showNoticeColumns ? h('td.num', r.notice_days ? `${number(r.notice_days)}d` : h('span.dim', 'none')) : null,
        );
    }

    await load();
    return undefined;
}
