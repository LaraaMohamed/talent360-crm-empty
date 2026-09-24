/**
 * The deal board.
 *
 * Columns are stages read from workspace metadata, so adding a stage adds a
 * column with no code change. Each column shows TWO totals — one-time and MRR —
 * because a column holding a placement fee and a 24-month retainer has no
 * honest single number.
 */
import { h, mount, navigate, toast, modal, money, number, date, relative, params, setParams } from '../core.js';
import { api } from '../api.js';
import * as store from '../store.js';
import { emptyState, skeletonRows, icon, errorState,} from '../components.js';
import { setPageTitle } from '../app.js';

export async function boardPage(content) {
    setPageTitle('Deals');
    const query = params();
    let pipelineId = query.pipeline ?? null;
    let ownerId = query.owner ?? null;
    let service = query.service ?? null;
    let range = query.range ?? 'all';

    // The page is a column: toolbar, the board that takes the rest of the
    // height, then the footnote. See `.board-page` -- it keeps the board's
    // horizontal scrollbar at the bottom of the screen rather than under the
    // shortest column.
    const container = h('div.board-page');
    mount(content, container);

    async function load() {
        mount(container, skeletonRows(4));
        /**
         * A failed reload has to SAY so.
         *
         * This runs again after every drag, and a rejection here used to leave
         * the skeleton it just mounted on screen for ever -- a board that looks
         * like it is still loading is indistinguishable from one that failed.
         */
        let data;
        try {
            data = await api.get(`/api/deals/board?${new URLSearchParams({
                ...(pipelineId ? { pipeline: pipelineId } : {}),
                ...(ownerId ? { owner: ownerId } : {}),
                ...(service ? { service } : {}),
                ...(range && range !== 'all' ? { range } : {}),
            })}`);
        } catch (err) {
            mount(container, errorState(err.message, () => load()));
            return;
        }
        pipelineId = data.pipeline.id;
        paint(data);
    }

    function paint(data) {
        /**
         * The early pipeline stages — campaign and cold-calling — are prep work,
         * not sales. They stay in the dashboard (full stage breakdown) but are
         * not worth a board column of their own, so the board starts at the
         * first stage a deal actually gets quoted at.
         */
        const HIDDEN_STAGE_KEYS = new Set([
            'in_campaign', 'ready_to_call', 'interested', 'send_profile',
            'follow_up', 'meeting_scheduled', 'proposal_preparing',
        ]);
        data.columns = data.columns.filter((c) => !HIDDEN_STAGE_KEYS.has(c.stage.key));

        /**
         * "Open" means open — Won and Lost are always shown as columns (see
         * the board API's own comment: terminal stages never disappear the
         * instant a deal lands in them), but they are not open pipeline, and
         * summing every column into a total labelled "Open" put a lost deal's
         * value into a figure that told a rep their pipeline was worth more
         * than it was. Only `type === 'open'` columns feed this summary; each
         * column still shows its own total, Won and Lost included, right on
         * its own header.
         */
        const openColumns = data.columns.filter((c) => c.stage.type === 'open');
        const totalOneTime = openColumns.reduce((a, c) => a + c.totals.one_time, 0);
        const totalMrr = openColumns.reduce((a, c) => a + c.totals.mrr, 0);
        const totalCount = openColumns.reduce((a, c) => a + c.total, 0);

        mount(container,
            h('div.toolbar',
                /**
                 * The board is sliced by SERVICE, not by pipeline.
                 *
                 * The pipeline chooser that stood here offered Recruitment,
                 * Managed services and Commercial — three stage flows presented
                 * as though they were three kinds of business. What the company
                 * actually sells is OD, Recruitment, HCM and Offshoring, and
                 * "show me the OD deals" was a question this screen could not
                 * be asked. The options come from the workspace's own service
                 * lines, so adding a fifth service needs no change here.
                 *
                 * Only shown when there is more than one pipeline left to
                 * choose between — see apply-single-deal-pipeline.mjs, which
                 * collapses them to one.
                 */
                h('select.input', {
                    style: { inlineSize: 'auto' },
                    onchange: (e) => { service = e.target.value || null; setParams({ service }); load(); },
                },
                h('option', { value: '' }, 'All services'),
                (data.services ?? []).map((s) => h('option', {
                    value: s.key, selected: s.key === service,
                }, s.label))),

                // Deals in a time range — the dashboard's question asked of the
                // pipeline. "What did we open this month" is answered here.
                h('select.input', {
                    style: { inlineSize: 'auto' },
                    'aria-label': 'Deal created in',
                    onchange: (e) => { range = e.target.value || 'all'; setParams({ range }); load(); },
                },
                [['all', 'All time'], ['today', 'Today'], ['week', 'This week'], ['month', 'This month'],
                 ['quarter', 'This quarter'], ['year', 'This year']].map(([v, l]) => h('option', {
                    value: v, selected: v === range,
                }, l))),

                data.pipelines.length > 1 && h('select.input', {
                    style: { inlineSize: 'auto' },
                    onchange: (e) => { pipelineId = e.target.value; setParams({ pipeline: pipelineId }); load(); },
                }, data.pipelines.map((p) => h('option', { value: p.id, selected: p.id === data.pipeline.id }, p.label))),

                h('select.input', {
                    style: { inlineSize: 'auto' },
                    onchange: (e) => { ownerId = e.target.value || null; setParams({ owner: ownerId }); load(); },
                },
                h('option', { value: '' }, 'All owners'),
                store.users().map((u) => h('option', { value: u.id, selected: u.id === ownerId }, u.name))),

                h('div.spacer'),

                h('div.row', { style: { gap: 'var(--space-4)' } },
                    h('span.small', h('span.dim', 'Open '), h('strong', number(totalCount))),
                    h('span.small', h('span.dim', 'One-time '), h('strong.money', money(totalOneTime, data.currency))),
                    h('span.small', h('span.dim', 'Recurring '), h('strong.money', `${money(totalMrr, data.currency)}/mo`)),
                ),

                h('a.btn', { href: '/deals?layout=table' }, icon('table'), 'Table'),
                h('button.btn', { onclick: () => showForecast() }, icon('chart'), 'Forecast'),
            ),

            h('div.board', data.columns.map((column) => boardColumn(column, data))),

            h('div.content-inner',
                h('p.xs.dim', 'One-time and recurring totals are never added together. Drag a card to move its deal; '
                    + 'a stage that requires fields, or a lost stage that requires a reason, will say so.'),
            ),
        );
    }

    function boardColumn(column, data) {
        const cards = h('div.board-cards',
            column.deals.map((deal) => dealCard(deal)),
            column.truncated && h('div.xs.dim', { style: { padding: 'var(--space-2)' } },
                `Showing ${column.deals.length} of ${number(column.total)}`),
        );

        const el = h('div.board-column',
            { dataset: { stageId: column.stage.id } },
            h('div.board-column-header',
                h('div.board-column-title',
                    h('span', column.stage.label),
                    h('span.count', number(column.total)),
                    column.overWip && h('span.badge.warning', { title: `WIP limit ${column.stage.wipLimit}` }, 'over WIP'),
                ),
                h('div.board-column-totals',
                    h('span', `${money(column.totals.one_time, data.currency)} one-time`),
                    h('span', `${money(column.totals.mrr, data.currency)}/mo recurring`),
                ),
            ),
            cards,
        );

        el.addEventListener('dragover', (event) => {
            event.preventDefault();
            el.classList.add('over');
        });
        el.addEventListener('dragleave', () => el.classList.remove('over'));
        el.addEventListener('drop', async (event) => {
            event.preventDefault();
            el.classList.remove('over');
            const dealId = event.dataTransfer.getData('text/plain');
            if (!dealId) return;
            try {
                await api.post(`/api/deals/${dealId}/stage`, { stageId: column.stage.id });
                load();
            } catch (err) {
                // A stage can require fields, or a reason. The refusal explains
                // itself rather than silently snapping the card back.
                if (err.payload?.lossReasons) return askLossReason(dealId, column.stage.id, err.payload.lossReasons);
                toast(err.message, 'error');
                load();
            }
        });

        return el;
    }

    function dealCard(deal) {
        // HTML5 drag consumes one-finger touches on a phone, which made the
        // board unscrollable if `draggable` were set unconditionally — so it
        // still is not, for coarse pointers. Touch gets its own long-press
        // drag below instead (see touchDragHandlers), rather than falling
        // back to "open it and use Move stage" as the only option.
        const canDrag = !window.matchMedia('(pointer: coarse)').matches;
        const card = h('div.deal-card', { draggable: canDrag ? 'true' : null },
            h('a.title', { href: `/deals/${deal.id}` }, deal.name),
            h('span.meta', deal.account_name ?? '—'),
            /**
             * The deal's SIZE, said once and labelled by how it bills.
             *
             * The card used to print `value_one_time` and `value_mrr` as two
             * badges and, when both were zero, the words "no line items" — a
             * message about the storage rather than about the deal. A deal is
             * priced or it is not, and an unpriced one is worth saying so about
             * because it contributes nothing to the column total above it.
             */
            h('div.values',
                deal.price > 0
                    ? h(`span.badge.${deal.billing_type === 'recurring' ? 'success' : 'accent'}`,
                        deal.billing_type === 'recurring'
                            ? `${money(deal.price, deal.currency)}/mo`
                            : money(deal.price, deal.currency))
                    : h('span.badge', { title: 'This deal has no price yet, so it adds nothing to the forecast.' }, 'not priced'),
                deal.service_line_label && h('span.badge', deal.service_line_label),
            ),
            h('div.row', { style: { gap: 'var(--space-1)' } },
                deal.close_date && h('span.xs.dim', { title: date(deal.close_date) }, `closes ${relative(deal.close_date)}`),
                h('div.spacer'),
                h('span.xs.dim', deal.owner_name ?? ''),
            ),
        );
        card.addEventListener('dragstart', (event) => {
            event.dataTransfer.setData('text/plain', deal.id);
            card.classList.add('dragging');
        });
        card.addEventListener('dragend', () => card.classList.remove('dragging'));
        if (!canDrag) touchDragHandlers(card, deal.id);
        return card;
    }

    /**
     * Long-press drag, for a pointer HTML5 drag-and-drop does not work on.
     *
     * A touchstart that becomes a drag immediately would swallow every
     * scroll gesture on the board — the exact problem `canDrag` above exists
     * to avoid. So a touch only starts moving the CARD after it has been
     * held for `HOLD_MS` without wandering past `MOVE_TOLERANCE` — long
     * enough that an ordinary scroll or tap never triggers it, short enough
     * that a deliberate hold does not feel broken.
     *
     * Once a drag is live, the card follows the finger as a fixed-position
     * ghost (the original stays in place, dimmed, so the column's layout does
     * not jump), and `elementFromPoint` under the finger decides which
     * column is the drop target — the same `.over` class the desktop path
     * already uses lights it up, so the two paths read as one feature rather
     * than two.
     */
    function touchDragHandlers(card, dealId) {
        const HOLD_MS = 450;
        const MOVE_TOLERANCE = 10;
        let holdTimer = null;
        let ghost = null;
        let startX = 0;
        let startY = 0;
        let dragging = false;
        let currentColumn = null;

        const clearHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };

        const endDrag = async (drop) => {
            if (ghost) { ghost.remove(); ghost = null; }
            card.classList.remove('dragging');
            if (currentColumn) { currentColumn.classList.remove('over'); }
            document.body.classList.remove('board-touch-dragging');
            dragging = false;
            if (drop && currentColumn?.dataset.stageId) {
                try {
                    await api.post(`/api/deals/${dealId}/stage`, { stageId: currentColumn.dataset.stageId });
                    load();
                } catch (err) {
                    if (err.payload?.lossReasons) return askLossReason(dealId, currentColumn.dataset.stageId, err.payload.lossReasons);
                    toast(err.message, 'error');
                    load();
                }
            }
            currentColumn = null;
        };

        card.addEventListener('touchstart', (event) => {
            if (event.touches.length !== 1) return;
            const touch = event.touches[0];
            startX = touch.clientX;
            startY = touch.clientY;
            clearHold();
            holdTimer = setTimeout(() => {
                dragging = true;
                card.classList.add('dragging');
                document.body.classList.add('board-touch-dragging');
                const rect = card.getBoundingClientRect();
                ghost = card.cloneNode(true);
                ghost.classList.add('deal-card-ghost');
                ghost.style.width = `${rect.width}px`;
                ghost.style.left = `${rect.left}px`;
                ghost.style.top = `${rect.top}px`;
                document.body.appendChild(ghost);
                if (navigator.vibrate) navigator.vibrate(15);
            }, HOLD_MS);
        }, { passive: true });

        card.addEventListener('touchmove', (event) => {
            const touch = event.touches[0];
            if (!dragging) {
                // Wandered too far before the hold fired — this is a scroll,
                // not a drag. Cancel the timer and let the page scroll as normal.
                if (Math.abs(touch.clientX - startX) > MOVE_TOLERANCE || Math.abs(touch.clientY - startY) > MOVE_TOLERANCE) {
                    clearHold();
                }
                return;
            }
            // Now genuinely dragging: the page must not scroll under it.
            event.preventDefault();
            const dx = touch.clientX - startX;
            const dy = touch.clientY - startY;
            const rect = card.getBoundingClientRect();
            ghost.style.transform = `translate(${dx}px, ${dy}px)`;

            const under = document.elementFromPoint(touch.clientX, touch.clientY);
            const column = under?.closest('.board-column') ?? null;
            if (column !== currentColumn) {
                currentColumn?.classList.remove('over');
                currentColumn = column;
                currentColumn?.classList.add('over');
            }
        }, { passive: false });

        card.addEventListener('touchend', () => {
            clearHold();
            if (dragging) endDrag(true);
        });
        card.addEventListener('touchcancel', () => {
            clearHold();
            if (dragging) endDrag(false);
        });
    }

    async function askLossReason(dealId, stageId, reasons) {
        const select = h('select.input', reasons.map((r) => h('option', { value: r.key }, r.label)));
        const chosen = await modal({
            title: 'Why was it lost?',
            size: 'narrow',
            body: h('div.stack',
                h('div.field', h('label', 'Loss reason'), select),
                h('div.note-box', 'Loss reasons are the second-best ICP signal after verdict overrides, which is why one is required.'),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', { onclick: () => close(select.value) }, 'Close as lost'),
            ],
        });
        if (!chosen) return load();
        await api.post(`/api/deals/${dealId}/stage`, { stageId, lossReason: chosen });
        return load();
    }

    async function showForecast() {
        const data = await api.get('/api/deals/forecast?days=90');
        await modal({
            title: `Forecast — next ${data.horizonDays} days`,
            size: 'wide',
            body: h('div.stack',
                h('div.grid', { style: { gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))' } },
                    h('div.total-cell', h('div.metric',
                        h('span.metric-label', 'Open one-time'), h('span.metric-value', money(data.open.one_time, data.currency)),
                        h('span.metric-help', `${data.open.count} deals`))),
                    h('div.total-cell', h('div.metric',
                        h('span.metric-label', 'Open recurring'), h('span.metric-value', `${money(data.open.mrr, data.currency)}/mo`),
                        h('span.metric-help', `${money(data.open.arr, data.currency)} annualised`))),
                    h('div.total-cell', h('div.metric',
                        h('span.metric-label', 'Won in period'), h('span.metric-value', money(data.won.one_time, data.currency)),
                        h('span.metric-help', `plus ${money(data.won.mrr, data.currency)}/mo recurring`))),
                    (data.unscheduled?.count ?? 0) > 0 && h('div.total-cell', h('div.metric',
                        h('span.metric-label', 'Open, no close date'),
                        h('span.metric-value', money(data.unscheduled.one_time, data.currency)),
                        h('span.metric-help', `${data.unscheduled.count} deals · not in the totals above`))),
                    h('div.total-cell', h('div.metric.tone-success',
                        h('span.metric-label', 'Forecast, one-time'),
                        h('span.metric-value', money(data.won.one_time + data.open.one_time, data.currency)),
                        h('span.metric-help', 'won plus open at full value'))),
                    h('div.total-cell', h('div.metric.tone-success',
                        h('span.metric-label', 'Forecast, per month'),
                        h('span.metric-value', `${money(data.won.mrr + data.open.mrr, data.currency)}/mo`),
                        h('span.metric-help', 'never added to the figure beside it'))),
                ),
                h('div.table-wrap', h('table.data',
                    h('thead', h('tr', h('th', 'Stage'), h('th.num', 'Deals'), h('th.num', 'One-time'), h('th.num', 'Recurring'))),
                    h('tbody', data.byStage.map((s) => h('tr',
                        h('td', s.label),
                        h('td.num', number(s.count)),
                        h('td.num', money(s.one_time, data.currency)),
                        h('td.num', `${money(s.mrr, data.currency)}/mo`),
                    ))),
                )),
                h('div.note-box', data.note),
            ),
            footer: (close) => h('button.btn.primary', { onclick: () => close(true) }, 'Close'),
        });
    }

    await load();
    return undefined;
}
