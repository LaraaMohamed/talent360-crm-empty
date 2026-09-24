/**
 * The dashboard.
 *
 * Widgets are rendered from whatever the server returns, so adding a widget
 * type on the server makes it renderable here without a matching change — the
 * renderer switches on the DATA SHAPE (`verdict_bars`, `money_pair`, …), not on
 * the widget name.
 */
import { h, mount, money, number, date, relative, humanise, navigate, toast } from '../core.js';
import { api } from '../api.js';
import * as store from '../store.js';
import { verdictBar, verdictBadge, statTile, emptyState, dateInput } from '../components.js';
import { setPageTitle } from '../app.js';

const PRESETS = [
    ['today', 'Today'],
    ['week', 'Week'],
    ['month', 'Month'],
    ['quarter', 'Quarter'],
    ['year', 'Year'],
    ['all', 'All time'],
    ['custom', 'Custom'],
];

/**
 * The range lives in the URL, not in a variable.
 *
 * So a refresh keeps it, the back button works, and "here is the quarter" is a
 * link somebody can send. It is also what the server reads, so the page and the
 * numbers on it can never disagree about which period is being shown.
 */
function currentRange() {
    const q = new URLSearchParams(location.search);
    return {
        preset: q.get('range') ?? 'today',
        from: q.get('from') ?? '',
        to: q.get('to') ?? '',
        /**
         * The person filter is carried on the URL so a manager who drilled into a
         * rep's meetings keeps that rep as they change the date range — and so the
         * link is sendable, like the range.
         */
        sdr: q.get('sdr') ?? '',
    };
}

function setRange(next) {
    const q = new URLSearchParams();
    q.set('range', next.preset);
    if (next.sdr) q.set('sdr', next.sdr);
    if (next.preset === 'custom') {
        if (next.from) q.set('from', next.from);
        if (next.to) q.set('to', next.to);
    }
    navigate(`/?${q}`);
}

export async function dashboardPage(content) {
    setPageTitle('Dashboard');
    const selected = currentRange();
    const query = new URLSearchParams({ range: selected.preset });
    if (selected.sdr) query.set('sdr', selected.sdr);
    if (selected.preset === 'custom' && selected.from && selected.to) {
        query.set('from', selected.from);
        query.set('to', selected.to);
    }
    const [data, attention] = await Promise.all([
        api.get(`/api/dashboards/default/data?${query}`),
        // A separate cheap read so the band never waits on a widget. Its
        // meetings-scheduled count is the one item that IS period-scoped, so
        // it shares the same range as the widgets below rather than a range
        // of its own.
        api.get(`/api/dashboard/attention?${query}`).catch(() => ({ items: [] })),
    ]);

    mount(content, h('div.content-inner',
        attentionBand(attention.items),
        rangePicker(selected, data.range),
        bands(data.widgets, content),
    ));
}

/**
 * NEEDS ATTENTION — four counters that each name where they come from.
 *
 * Every count is a decision somebody owes the day: overdue work, approvals
 * waiting, follow-ups due on the floor, meetings scheduled in the selected
 * period. Zero-count items stay visible but muted, because "nothing overdue"
 * is a fact worth seeing and not an empty box to hide.
 */
function attentionBand(items) {
    if (!items?.length) return null;
    return h('div.stack.tight', { style: { marginBlockEnd: 'var(--space-4)' } },
        h('div.attention-band',
            items.map((it) => {
                // `tone` says whether a non-zero count is bad news
                // (danger, the default — most of this band is overdue
                // work) or good news (success — a scheduled meeting isn't
                // a problem). Zero is always muted regardless of tone.
                const cls = it.count > 0 ? (it.tone === 'success' ? 'good' : 'hot') : 'muted';
                return h('a.attention-item', { class: cls, href: it.href },
                    h('span.attention-count', number(it.count ?? 0)),
                    h('span.attention-label', it.label),
                );
            }),
        ),
    );
}

/**
 * Widgets, banded by the question they answer.
 *
 * Nine identical cards in one grid make the reader weigh all nine equally, so
 * a renewal date and an activity count arrive as the same kind of fact. The
 * layout declares a `section` per widget and this groups by it, in the order
 * the server sent them — the bands are the questions a manager turns up with,
 * and the order is the order they ask them.
 *
 * A layout with no sections renders exactly as it always did: one grid, no
 * headings. Nothing has to be banded to work.
 */
function bands(widgets, content) {
    const order = [];
    const bySection = new Map();
    for (const widget of widgets) {
        const name = widget.section ?? null;
        if (!bySection.has(name)) { bySection.set(name, []); order.push(name); }
        bySection.get(name).push(widget);
    }

    const unbanded = order.length === 1 && order[0] === null;

    return order.map((name) => h('section.dash-band',
        !unbanded && name && h('h2.dash-band-title', name),
        h('div.grid', bySection.get(name).map((widget) => widgetCard(widget, content))),
    ));
}

function widgetCard(widget, content) {
    return h(`div.card.span-${{ wide: 12, half: 6, third: 4 }[widget.size] ?? 6}`,
        h('div.card-header',
            h('h3', widget.title ?? widget.label),
        ),
        h('div.card-body', widget.error
            ? h('div.note-box.danger',
                widget.error,
                h('div', h('button.btn.sm', { onclick: () => dashboardPage(content) }, 'Retry')),
            )
            : renderWidget(widget.data)),
        // Every widget states its range and when it was computed. An
        // unlabelled number on a dashboard is a rumour.
        h('div.widget-meta',
            h('span', rangeLabel(widget.data)),
            h('span', `Computed ${relative(widget.computedAt)}`),
        ),
    );
}

/** A full `YYYY-MM-DD`, as `dateInput` reports it once a day is actually complete. */
const isFullDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '');

function rangePicker(selected, resolved) {
    const custom = selected.preset === 'custom';
    const draft = { from: selected.from, to: selected.to };

    /** Carries the person filter so a rep stays selected as the range changes. */
    const withPerson = (next) => ({ ...next, sdr: selected.sdr });

    const apply = () => {
        if (!isFullDate(draft.from) || !isFullDate(draft.to)) return;
        setRange(withPerson({ preset: 'custom', from: draft.from, to: draft.to }));
    };

    return h('div.row', {
        style: {
            gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap',
            marginBlockEnd: 'var(--space-3)',
        },
    },
    h('select.input.sm', {
        style: { inlineSize: 'auto' },
        onchange: (e) => (e.target.value === 'custom'
            // Opening Custom must not wipe the numbers on screen; it waits
            // for two complete dates before asking the server for anything.
            ? setRange(withPerson({ preset: 'custom', from: draft.from, to: draft.to }))
            : setRange(withPerson({ preset: e.target.value }))),
    },
        PRESETS.map(([key, label]) => h('option', { value: key, selected: key === selected.preset }, label)),
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
    // What the SERVER resolved, not what was clicked — if a half-finished
    // custom range fell back to the month, this says so rather than leaving
    // the picker and the figures disagreeing.
    resolved ? h('span.xs.dim', `Showing ${resolved.label}`) : null,
    );
}

function rangeLabel(data) {
    if (!data) return 'No data';
    if (data.range?.label) return data.range.label;
    if (data.windowDays) return `Last / next ${data.windowDays} days`;
    if (data.thresholdDays) return `Threshold ${data.thresholdDays} days`;
    if (data.since) return `Since ${date(data.since)}`;
    return 'Current state';
}

function renderWidget(data) {
    if (!data) return h('p.dim', 'No data.');
    switch (data.type) {
        case 'verdict_bars': return verdictBars(data);
        case 'kpi_tiles': return kpiTiles(data);
        case 'funnel': return funnel(data);
        case 'money_pair': return moneyPair(data);
        case 'stage_bars': return stageBars(data);
        case 'task_list': return taskList(data);
        case 'stale_list': return staleList(data);
        case 'bars': return bars(data);
        case 'service_matrix': return serviceMatrix(data);
        case 'renewal_list': return renewalList(data);
        case 'change_list': return changeList(data);
        case 'table': return widgetTable(data);
        case 'meeting_analytics': return meetingAnalytics(data);
        default: return h('pre.small', JSON.stringify(data, null, 2));
    }
}

/**
 * A small sortable table, for the widgets whose answer is per-person.
 *
 * Sorted in the browser because the rows are already all here — there is one
 * per SDR, not one per call, so a round trip to re-order five rows would be a
 * request spent on arithmetic.
 */
function widgetTable(data) {
    if (!data.rows.length) return h('p.dim', data.emptyNote ?? 'Nothing to show.');

    let sortKey = data.columns.find((c) => c.numeric)?.key ?? data.columns[0].key;
    let descending = true;
    const body = h('tbody');
    const tfoot = h('tfoot');

    const paint = () => {
        const rows = [...data.rows].sort((a, b) => {
            const [x, y] = [a[sortKey], b[sortKey]];
            const cmp = typeof x === 'number' && typeof y === 'number'
                ? x - y
                : String(x ?? '').localeCompare(String(y ?? ''));
            return descending ? -cmp : cmp;
        });
        /**
         * Filled from the row. A widget cannot send a function — this arrives
         * as JSON — so it sends `/calling?sdr={id}` and the row supplies
         * `id`. A row that has no value for a placeholder is plain text,
         * rather than a link to a page about nobody.
         */
        const fillTemplate = (template, row) => {
            let missing = false;
            const href = template.replace(/\{(\w+)\}/g, (_, key) => {
                const value = row[key];
                if (value === null || value === undefined || value === '') missing = true;
                return encodeURIComponent(String(value ?? ''));
            });
            return missing ? null : href;
        };
        const cell = (row, col) => {
            const value = row[col.key];
            const body = col.numeric
                ? `${number(value ?? 0)}${col.suffix ?? ''}`
                : String(value ?? '—');
            const template = col.key === 'name' ? data.hrefTemplate : data.columnHrefTemplates?.[col.key];
            // A count of zero has nothing behind it to open the queue to.
            if (template && !(col.numeric && !value)) {
                const href = fillTemplate(template, row);
                if (href) return h('a', { href }, body);
            }
            return body;
        };
        mount(body, rows.map((row) => h('tr', data.columns.map((col) => h(col.numeric ? 'td.num' : 'td', cell(row, col))))));
        if (data.totals) {
            mount(tfoot, h('tr.totals', data.columns.map((col) => {
                const value = data.totals[col.key];
                const body = col.numeric ? `${number(value ?? 0)}${col.suffix ?? ''}` : String(value ?? '');
                const href = data.columnHrefs?.[col.key];
                return h(col.numeric ? 'td.num' : 'td', href && value ? h('a', { href }, body) : body);
            })));
        }
    };

    /**
     * `widget-table`, so a dashboard card's table can lay itself out
     * differently from a full-page list. See the CSS.
     */
    const table = h('table.data.widget-table',
        h('thead', h('tr', data.columns.map((col) => h(col.numeric ? 'th.num' : 'th',
            {
                /**
                 * The definition, on the heading.
                 *
                 * Five columns counting people and calls read as repetitive
                 * until each says what it counts, and the note under the table
                 * is where somebody looks second. A widget that sends `help`
                 * had it dropped on the floor here.
                 */
                title: col.help ?? null,
            },
            h(`button.btn.ghost.sm${col.help ? '.has-help' : ''}`, {
                style: { padding: '0 0.2rem' },
                onclick: () => {
                    if (sortKey === col.key) descending = !descending;
                    else { sortKey = col.key; descending = Boolean(col.numeric); }
                    paint();
                },
            }, col.label, sortKey === col.key ? (descending ? ' ↓' : ' ↑') : ''),
        )))),
        body,
        data.totals ? tfoot : null,
    );

    paint();
    return h('div.stack.tight',
        h('div.table-wrap', table),
        data.note ? h('div.note-box', data.note) : null,
    );
}

/**
 * KPIs up top, the per-person table below — the funnel and its rows, one card.
 *
 * The show-rate tile carries `tone: 'strong'` from the server, which the CSS
 * draws with an accent border so it reads as the headline the funnel collapses
 * without. It stays "—" until a meeting resolves, never a false 0%.
 */
function meetingAnalytics(data) {
    return h('div.stack.tight',
        h('div.stat-grid',
            data.tiles.map((t) => {
                const value = t.value === null || t.value === undefined
                    ? '—'
                    : `${number(t.value)}${t.suffix ?? ''}`;
                const tile = statTile(t.label, value, t.help, { tone: t.tone, tooltip: true });
                return t.href ? h('a.stat-link', { href: t.href }, tile) : tile;
            }),
        ),
        data.table ? widgetTable(data.table) : null,
    );
}

function verdictBars(data) {
    if (!data.rules.length) return emptyState('No rules configured', 'Set up a qualification rule to see verdicts here.');
    return h('div.stack',
        data.rules.map((rule) => h('div.stack.tight',
            h('div.row.between',
                h('div',
                    h('span.strong', rule.label),
                    h('span.xs.dim', ` · v${rule.version} · ${rule.summary}`),
                ),
                h('a.btn.sm.ghost', { href: `/accounts?verdict=${rule.rule}` }, 'Open'),
            ),
            verdictBar(rule.buckets),
        )),
        h('div.note-box', data.note),
    );
}

/**
 * A row of headline numbers.
 *
 * Money is formatted as money and counts as counts — a tile never shows a
 * currency figure and a row count in the same shape, because the reader stops
 * checking which is which. A tile with a destination is a link: a number
 * nobody can act on is trivia.
 */
/**
 * A row of numbers, and it has to READ as a row of numbers.
 *
 * This was a twelve-column grid of `span-3` cells with every widget's
 * explanation printed underneath in full — so "CRM at a glance" opened with
 * twelve headline figures each trailing two lines of prose, and took three
 * screens to answer a question whose whole point is that it is answered at a
 * glance. The explanations are not gone; they are on the labels.
 *
 * `tone` is honoured here rather than ignored: the widgets have always sent it
 * and nothing has ever drawn it, so a won figure and a no-answer figure looked
 * identical.
 */
function kpiTiles(data) {
    return h('div',
        h('div.stat-grid',
            data.tiles.map((t) => {
                const value = t.value === null || t.value === undefined
                    ? '—'
                    : t.money
                        ? money(t.value, data.currency)
                        : `${number(t.value)}${t.suffix ?? ''}`;
                const tile = statTile(t.label, value, t.help, { tone: t.tone, tooltip: true });
                return t.href ? h('a.stat-link', { href: t.href }, tile) : tile;
            }),
        ),
        /**
         * The note is the widget's own guidance — a truncation warning, or the
         * pointer to the card that answers the follow-up question. Every other
         * widget type renders its note; the KPI tiles were the only one that
         * dropped it on the floor.
         */
        data.note && h('p.xs.dim', { style: { marginBlockStart: 'var(--space-3)' } }, data.note),
    );
}

function funnel(data) {
    const max = Math.max(1, ...data.stages.map((s) => s.count));
    return h('div.stack.tight',
        data.stages.map((s) => h('div.stack.tight',
            h('div.row.between',
                h('span.small', humanise(s.stage)),
                h('span.small.tabular', number(s.count)),
            ),
            h('div.bar-track',
                h('div.bar-fill', {
                    style: {
                        inlineSize: `${(s.count / max) * 100}%`,
                        background: s.stage === 'customer' ? 'var(--color-success)'
                            : s.stage === 'disqualified' || s.stage === 'churned' ? 'var(--color-danger)'
                                : 'var(--color-accent)',
                    },
                }),
            ),
        )),
        h('p.xs.dim', `${number(data.total)} accounts. Prospects are hidden from default views until a verdict promotes them.`),
    );
}

function moneyPair(data) {
    return h('div.stack',
        h('div.grid', { style: { gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))' } },
            data.figures.map((f) => h('div.total-cell', statTile(f.label, money(f.value, data.currency), f.help))),
        ),
        h('p.xs.dim', `${number(data.count)} open deals. One-time and recurring are never added together — `
            + 'they are different kinds of money.'),
    );
}

function stageBars(data) {
    if (!data.stages.length) return h('p.dim', 'No open stages.');

    /**
     * The bar is this stage's SHARE OF THE WHOLE PIPELINE, not its size
     * relative to whichever stage happens to be biggest.
     *
     * It used to divide by the single largest stage, which makes the top
     * stage always read as 100% full no matter how small the actual pipeline
     * is — two modest, similarly-priced stages (say $1,200/mo and $1,120/mo,
     * nothing else in the pipeline at all) both rendered as bars nearly
     * touching the end of the track, which is not a percentage of anything a
     * reader could name. Dividing by the TOTAL instead means the two bars
     * read as roughly half each — an honest 51% and 49% of the pipeline,
     * which is what "percentage filled" actually promises.
     */
    /**
     * The denominator is the OPEN pipeline only — Won and Lost are drawn as
     * their own bars below (see `data.stages` including them, further down),
     * but they are not open pipeline, and letting a closed deal's value into
     * the total every open stage's bar width is a percentage OF would shrink
     * every open bar to make room for money that is no longer being
     * forecast. Same principle as the board's own "Open" summary.
     */
    const total = Math.max(1, data.stages
        .filter((s) => s.type === 'open')
        .reduce((a, s) => a + s.one_time + s.mrr * 12, 0));

    return h('div.stack.tight',
        h('div.xs.dim', data.pipeline),
        data.stages.map((s) => {
            const value = s.one_time + s.mrr * 12;
            /**
             * A stage can hold deals with no price yet — early enough in the
             * sale that nothing has been quoted. Those deals are real and the
             * count says so, but a $0-scaled bar is indistinguishable from a
             * stage holding nothing at all. A thin neutral marker keeps "there
             * is something here" visible without pretending to be a dollar
             * figure it is not.
             */
            const unpriced = s.count > 0 && value === 0;
            return h('div.stack.tight',
                h('div.row.between',
                    h('span.small', s.stage),
                    h('span.xs.dim.tabular', `${number(s.count)} · ${money(s.one_time, data.currency)} one-time · ${money(s.mrr, data.currency)}/mo`),
                ),
                // Two stacked segments, never one blended bar.
                h('div.bar-track', { style: { display: 'flex' } },
                    unpriced
                        ? h('div', { title: `${number(s.count)} deal${s.count === 1 ? '' : 's'}, not yet priced`, style: { inlineSize: '3%', background: 'var(--color-border-strong)' } })
                        : [
                            h('div', { style: { inlineSize: `${(s.one_time / total) * 100}%`, background: 'var(--color-accent)' } }),
                            h('div', { style: { inlineSize: `${((s.mrr * 12) / total) * 100}%`, background: 'var(--color-success)' } }),
                        ],
                ),
            );
        }),
        h('div.legend',
            h('span.legend-item', h('span.legend-swatch', { style: { background: 'var(--color-accent)' } }), 'One-time'),
            h('span.legend-item', h('span.legend-swatch', { style: { background: 'var(--color-success)' } }), 'Recurring (annualised)'),
            h('span.legend-item', h('span.legend-swatch', { style: { background: 'var(--color-border-strong)' } }), 'Not yet priced'),
        ),
    );
}

function taskList(data) {
    if (!data.tasks.length) return h('p.dim', 'Nothing assigned to you right now.');
    return h('div.stack.tight',
        data.overdue > 0 && h('div.note-box.warning', `${data.overdue} overdue.`),
        data.tasks.slice(0, 8).map((t) => h('div.row.between',
            h('a', { href: `/tasks/${t.id}` }, t.title),
            h('span.xs', { class: t.overdue ? 'error' : 'dim', style: t.overdue ? { color: 'var(--color-danger)' } : {} },
                t.dueAt ? relative(t.dueAt) : 'no due date'),
        )),
        data.total > 8 && h('a.small', { href: '/tasks' }, `See all ${number(data.total)}`),
    );
}

function staleList(data) {
    if (!data.staleCount) return h('p.dim', `Nothing older than ${data.thresholdDays} days.`);
    return h('div.stack.tight',
        h('div.row', statTile('Ageing', number(data.staleCount), `of ${number(data.total)} live verdicts`)),
        data.oldest.map((r) => h('div.row.between',
            h('a', { href: `/accounts/${r.accountId}` }, r.name),
            h('span.row', { style: { gap: 'var(--space-1)' } },
                verdictBadge(r.verdict, { stale: true, rule: r.rule }),
                h('span.xs.dim', `${r.ageDays}d`),
            ),
        )),
        h('p.xs.dim', data.note),
    );
}

/**
 * Egypt and Regional down the columns, services down the rows.
 *
 * One cell is one commercial question — what did Egypt's HCM business win this
 * period, and was that the plan. So the cell leads with total contract value
 * against target, and puts one-time and recurring underneath rather than adding
 * them together, because they are not the same kind of money.
 *
 * A cell with no target shows the figure and says "no target" rather than a
 * confident 0%, which would read as failure against a number nobody agreed.
 */
function serviceMatrix(data) {
    const attainmentTone = (pct) => (pct === null ? '' : pct >= 100 ? 'success' : pct >= 70 ? 'warning' : 'danger');

    return h('div.stack',
        h('div.table-wrap', h('table.data',
            h('thead', h('tr',
                h('th', 'Service'),
                ...data.accountTypes.map((t) => h('th.num', t)),
            )),
            h('tbody', data.rows.map((row) => h('tr',
                h('td', h('span.strong', row.label)),
                ...row.cells.map((cell) => h('td.num',
                    // The headline: what was won, and whether that was the plan.
                    h('div.strong', money(cell.tcv, data.currency)),
                    cell.target === null
                        ? h('div.xs.dim', cell.count ? 'no target set' : '—')
                        : h('div.xs',
                            h('span.badge', { class: attainmentTone(cell.attainment) }, `${cell.attainment}%`),
                            h('span.dim', ` of ${money(cell.target, data.currency)}`)),
                    // Kept apart, always.
                    (cell.one_time || cell.mrr) ? h('div.xs.dim',
                        `${money(cell.one_time, data.currency)} one-time · ${money(cell.mrr, data.currency)}/mo`,
                    ) : null,
                    cell.unconvertible
                        ? h('div.xs.danger', `${cell.unconvertible} deal(s) have no rate`)
                        : null,
                )),
            ))),
        )),
        data.capped ? h('p.xs.danger', 'More deals closed in this period than could be totalled — the figures above are a floor.') : null,
        /**
         * What the columns leave out, as a sentence rather than a column.
         *
         * Only drawn when there is something to say — on a workspace where
         * every account is classified this is silent, which is the normal case
         * and should look like it.
         */
        data.unassigned
            ? h('p.xs.warning',
                `${number(data.unassigned.count)} won deal${data.unassigned.count === 1 ? '' : 's'} `
                + `(${money(data.unassigned.tcv, data.currency)}) `
                + 'are not counted above: their account has no Account Type set.')
            : null,
        h('p.xs.dim', data.note),
    );
}

function bars(data) {
    if (!data.bars.length) return h('p.dim', data.emptyNote ?? 'No activity logged in this window.');
    const max = Math.max(1, ...data.bars.map((b) => b.count));
    return h('div.stack.tight',
        data.bars.map((b) => h('div.stack.tight',
            h('div.row.between', h('span.small', b.label), h('span.small.tabular', number(b.count))),
            h('div.bar-track', h('div.bar-fill', { style: { inlineSize: `${(b.count / max) * 100}%`, background: 'var(--color-accent)' } })),
        )),
        /**
         * The caption belongs to the widget, not to this renderer: the same
         * bars show activities in a window, or deals by service, and one
         * hardcoded sentence cannot be true for both.
         *
         * The fallback said "in ${data.windowDays} days" and the activity
         * widget stopped sending `windowDays` when it moved to following the
         * dashboard's range — so every rep's home page read "3 activities in
         * undefined days". A range that IS sent is used; otherwise the sentence
         * stops before it can invent a number.
         */
        h('p.xs.dim', data.note
            ?? (data.range?.label
                ? `${number(data.total)} in ${String(data.range.label).toLowerCase()}.`
                : `${number(data.total)} in this period.`)),
    );
}

function renewalList(data) {
    const valueLine = Object.entries(data.valueByCurrency ?? {})
        .map(([cur, amount]) => `${cur} ${Math.round(amount).toLocaleString()}`).join(' · ');
    return h('div.stack.tight',
        h('div.row', { style: { gap: 'var(--space-4)', flexWrap: 'wrap' } },
            renewalStat('0–30d', data.buckets?.d0_30 ?? 0, 'danger'),
            renewalStat('31–45d', data.buckets?.d31_45 ?? 0, 'warning'),
            renewalStat('46–90d', data.buckets?.d46_90 ?? 0, ''),
            renewalStat('Expired', data.expiredCount ?? 0, 'danger'),
            renewalStat('Renewed', data.renewedCount ?? 0, 'success'),
            renewalStat('Terminated', data.terminatedCount ?? 0, ''),
        ),
        valueLine && h('p.xs.dim', `Renewing within 90 days: ${valueLine}`),
        h('div.hr', { style: { marginBlock: 'var(--space-2)' } }),
        !data.agreements.length ? h('p.dim', `No notice dates in the next ${data.windowDays} days.`) : [
            data.overdue > 0 && h('div.note-box.danger', `${data.overdue} agreement(s) past their notice window — expired with no decision made.`),
            data.agreements.map((a) => h('div.row.between',
                h('a', { href: `/agreements/${a.id}` }, `${a.number} · ${a.account_name}`),
                // Same three states as the Renewals page: not yet due (dim),
                // inside the (open) notice window (warning), or actually past
                // the agreement's own expiry with nothing decided (danger).
                h('span.xs', {
                    style: {
                        color: a.noticePassed ? 'var(--color-danger)' : a.inNoticePeriod ? 'var(--color-warning)' : 'var(--color-fg-tertiary)',
                    },
                }, `notice ${date(a.noticeDate)}`),
            )),
        ],
        h('p.xs.dim', data.note),
    );
}

function renewalStat(label, value, tone) {
    return h('div', { style: { textAlign: 'center' } },
        h('div.strong', { style: tone ? { color: `var(--color-${tone})` } : null }, String(value)),
        h('div.xs.dim', label),
    );
}

function changeList(data) {
    if (!data.changes.length) return h('p.dim', data.note ?? 'No changes.');
    return h('div.stack.tight',
        data.changes.map((c) => h('div.row.between',
            h('a', { href: `/accounts/${c.accountId}` }, c.accountName ?? c.accountId),
            h('span.row', { style: { gap: 'var(--space-1)' } },
                verdictBadge(c.from),
                h('span.dim', '→'),
                verdictBadge(c.to),
                c.dangerous && h('span.badge.danger', { title: 'This account stopped qualifying' }, '!'),
                h('span.xs.dim', `${c.rule} v${c.ruleVersion}`),
            ),
        )),
    );
}
