/**
 * Deals: line items, stage transitions, the board and the forecast.
 */
import { all, get, run, tx, id, now, bind } from '../lib/db.mjs';
import {
    getRecord, listRecords, updateRecord, audit, insert, update, syncDealValues,
    dealPrice, setDealPrice, priceSchedule, priceByPeriod, reviewPricePeriod,
    splitDealsByCloseDate, missingStageFields,
} from '../lib/repo.mjs';
import { readJson, badRequest, notFound, forbidden } from '../lib/http.mjs';
import { require$, canWriteRecord } from '../lib/auth.mjs';
import { deriveValues, aggregate, aggregateInReporting, reportingRates, REPORTING_CURRENCY } from '../lib/money.mjs';
import { BILLING_CURRENCIES } from '../lib/objects.mjs';
import { setting } from '../lib/settings.mjs';
import { resolveRange } from '../lib/date-range.mjs';

/**
 * The current calendar year in the WORKSPACE'S timezone.
 *
 * The price-by-period card draws "this year, quarter by quarter", and "this
 * year" is a year in Riyadh or Cairo — not a UTC year that silently changes
 * which quarter a re-quote lands in for three hours of every night.
 */
function localYear(ctx) {
    try {
        const parts = new Intl.DateTimeFormat('en', {
            timeZone: ctx.workspace?.timezone ?? 'UTC', year: 'numeric',
        }).formatToParts(new Date());
        const year = parts.find((p) => p.type === 'year')?.value;
        return Number(year) || new Date().getUTCFullYear();
    } catch {
        return new Date().getUTCFullYear();
    }
}

/* ------------------------------------------------------------- deal size -- */

/**
 * A deal's size, and the figures derived from it.
 *
 * ── WHAT REPLACED WHAT ──────────────────────────────────────────────────────
 *
 * There were four endpoints here — add, edit and remove a line item, each
 * taking a pricing model, a quantity, a unit amount, a percentage and a basis
 * amount. A deal is now priced the way it is sold: one PRICE, one CURRENCY, and
 * a recurrence the SERVICE decides. So there is one endpoint to read it and one
 * to write it, and `lib/repo.mjs` owns both — the same `setDealPrice` an
 * agreement calls when it is signed, so a deal cannot be priced two ways
 * depending on which screen did it.
 */
export async function dealSize({ params, ctx }) {
    const deal = getRecord('deal', ctx, params.id);
    const items = all('SELECT * FROM deal_line_items WHERE deal_id = ? ORDER BY position, rowid', [params.id]);
    return {
        deal,
        size: dealPrice(ctx, deal),
        // Every price this deal has had, and any awaiting approval. One call,
        // because the card shows both and two round trips to draw one card is
        // one too many against a blocking driver.
        schedule: priceSchedule(ctx, deal.id),
        /**
         * And this calendar year quarter by quarter, on the same request.
         *
         * This is the answer the dated series exists to give: what each quarter
         * was worth at the price in force THEN, so a re-quote in April cannot
         * restate January. Sent with the card rather than fetched when the card
         * opens, because against a blocking driver a second round trip to draw
         * one card is a second round trip too many.
         */
        periods: priceByPeriod(ctx, deal.id, {
            from: `${localYear(ctx)}-01-01`,
            to: `${localYear(ctx)}-12-31`,
            period: 'quarter',
        }),
        currencies: BILLING_CURRENCIES,
        totals: deriveValues(items, {
            probability: deal.probability ?? deal.stage_probability ?? 0,
            baseCurrency: ctx.workspace.baseCurrency,
        }),
        // Every agreement this deal has, so the page can show the contract the
        // figure came from without a second request.
        agreements: all(
            `SELECT id, number, title, status, contract_value, currency, service_line_key,
                    effective_date, expiry_date, signed_at
               FROM agreements
              WHERE workspace_id = ? AND deal_id = ? AND deleted_at IS NULL
              ORDER BY created_at DESC`,
            [ctx.workspaceId, params.id],
        ),
    };
}

/**
 * What this deal has been worth, and what it is worth in each period ahead.
 *
 * The forecast question — "keep Q1 at the old figure and put the new one on the
 * rest of the year" — is answered from the series rather than from the current
 * price times the number of quarters. See `priceByPeriod` in lib/repo.mjs.
 */
export async function dealPriceHistory({ params, url, ctx }) {
    const deal = getRecord('deal', ctx, params.id);
    const period = url.searchParams.get('period') || 'quarter';

    // The current calendar year by default, because "the year's forecast" is
    // the question this endpoint exists for.
    const year = new Date().getUTCFullYear();
    const from = url.searchParams.get('from') || `${year}-01-01`;
    const to = url.searchParams.get('to') || `${year}-12-31`;

    return {
        deal,
        schedule: priceSchedule(ctx, deal.id),
        periods: priceByPeriod(ctx, deal.id, { from, to, period }),
        /**
         * Open price approvals on this deal, so its own page can say "a rep
         * re-quoted and it is waiting" without hunting My Work for the task.
         */
        openApprovals: get(
            `SELECT COUNT(*) AS n FROM tasks
              WHERE parent_type = 'deal_price' AND status = 'open' AND deleted_at IS NULL
                AND parent_id IN (SELECT id FROM deal_price_periods WHERE deal_id = ?)`,
            [deal.id],
        )?.n ?? 0,
        from,
        to,
        period,
    };
}

/**
 * How long this deal sat in each stage it has ever visited.
 *
 * Reads `deal_stage_history` — one row per move, written by every path a
 * deal's `stage_id` can change on (`moveStage` below, `moveDealToStage` and
 * `followStage` in lib/repo.mjs, and deal creation itself for the first
 * stage). `exited_at IS NULL` marks the row the deal is in right now, so
 * its duration is measured against the current instant rather than a
 * stored end date it does not have yet.
 */
export async function dealStageHistory({ params, ctx }) {
    const deal = getRecord('deal', ctx, params.id);
    const stamp = now();
    const rows = all(
        `SELECT h.id, h.to_stage_id AS stage_id, s.label AS stage_label, s.key AS stage_key,
                h.entered_at, h.exited_at, u.name AS actor_name
           FROM deal_stage_history h
           LEFT JOIN stages s ON s.id = h.to_stage_id
           LEFT JOIN users u ON u.id = h.actor_id
          WHERE h.deal_id = ?
          ORDER BY h.entered_at ASC`,
        [deal.id],
    ).map((row) => ({
        ...row,
        exitedAt: row.exited_at,
        current: !row.exited_at,
        seconds: Math.max(0, Math.round((new Date(row.exited_at ?? stamp).getTime() - new Date(row.entered_at).getTime()) / 1000)),
    }));
    return { deal, history: rows };
}

/** Approving or rejecting a price somebody proposed. */
export async function reviewDealPrice({ req, params, ctx }) {
    getRecord('deal', ctx, params.id);
    const body = await readJson(req).catch(() => ({}));
    return {
        period: reviewPricePeriod(ctx, params.periodId, String(body.decision ?? '').toLowerCase(), body.note ?? null),
        deal: getRecord('deal', ctx, params.id),
    };
}

export async function putDealSize({ req, params, ctx }) {
    const deal = getRecord('deal', ctx, params.id);
    /**
     * The object key MATTERS here, and its absence was the bug.
     *
     * `canWriteRecord` consults SHARED_OBJECTS only when it is told which
     * object it is looking at. Called without the key, this fell through to the
     * ownership test — so a deal being shared bought pricing nothing, and a rep
     * taking a call about a colleague's client still could not type in the
     * figure they had just been given.
     */
    if (!canWriteRecord(ctx, deal, 'deal')) {
        throw forbidden('Your role cannot change deals. Ask a manager.');
    }
    const body = await readJson(req);

    const raw = body.price;
    const clearing = raw === null || raw === undefined || String(raw).trim() === '';
    if (!clearing && !(Number(raw) >= 0)) throw badRequest('Enter the price as a number.');

    /**
     * A per-person service IS headcount × rate — Offshoring sells N employees
     * at a monthly rate per head. The count is REQUIRED for those services and
     * the deal size is the product of the two, so "12 people at 3,000" is
     * unambiguously 36,000/month. Flat-priced services ignore it.
     */
    const size = dealPrice(ctx, deal);
    const count = body.count ?? body.headcount ?? null;
    if (!clearing && size.perPerson) {
        const missing = count === null || count === undefined || String(count).trim() === '';
        if (missing || !(Number(count) >= 0)) {
            throw badRequest(
                `How many ${size.perPerson.unitPlural}? ${size.serviceLabel ?? 'This service'} is priced `
                + `per ${size.perPerson.unit}, so the deal needs a headcount and a rate.`,
            );
        }
    }

    const currency = String(body.currency ?? deal.currency ?? '').toUpperCase();
    if (currency && !BILLING_CURRENCIES.includes(currency)) {
        throw badRequest(`Currency must be one of: ${BILLING_CURRENCIES.join(', ')}.`);
    }
    /**
     * The ACCOUNT's billing currency is the source of truth.
     *
     * The deal, its proposals and its agreements all bill in whatever the
     * account is billed in. Silently re-pricing a deal in a different currency
     * would put one client in two books — an EGP account quoted in USD on the
     * deal while its proposals still say EGP. So a deal on a classified
     * account cannot be re-priced in a currency that disagrees with it.
     */
    if (currency && deal.account_id) {
        const account = get('SELECT billing_currency FROM accounts WHERE id = ?', [deal.account_id]);
        if (account?.billing_currency && currency !== account.billing_currency.toUpperCase()) {
            throw badRequest(
                `This account is billed in ${account.billing_currency}, so the deal, its proposals and its agreements `
                + `all use ${account.billing_currency}. Change the account's billing currency first if you need a different one.`,
            );
        }
    }

    return tx(() => {
        const size = setDealPrice(ctx, deal, {
            price: clearing ? null : Number(raw),
            count: clearing ? null : count,
            currency: currency || null,
            termMonths: body.termMonths ?? null,
            /**
             * From when, so re-quoting does not rewrite what the deal was worth
             * last quarter. Defaults to today — the commonest case is "this is
             * what it costs from now" — and a back-dated or forward-dated change
             * is the same write with a different date.
             */
            effectiveFrom: body.effectiveFrom ?? null,
            note: body.note ?? null,
        });
        /**
         * A priced deal teaches its unsigned agreements what it is worth.
         *
         * Only the ones that have not been signed: a signed contract is the
         * document both companies put their names to, and the deal does not get
         * to rewrite it afterwards.
         */
        for (const agreement of all(
            `SELECT id FROM agreements
              WHERE workspace_id = ? AND deal_id = ? AND deleted_at IS NULL AND status <> 'signed'`,
            [ctx.workspaceId, params.id],
        )) {
            update('agreements', agreement.id, {
                contract_value: size.price,
                currency: size.currency,
                updated_at: now(),
            });
        }
        return { deal: getRecord('deal', ctx, params.id), size };
    });
}

/* ------------------------------------------------------------- stage move -- */

/**
 * Moving a deal between stages.
 *
 * Three rules the docs are firm about, all enforced here:
 *   - a stage may REQUIRE fields before a deal can enter it (data quality
 *     without nagging)
 *   - closing as lost REQUIRES a reason, from a configurable list (loss reasons
 *     are the second-best ICP signal after verdict overrides)
 *   - the FX rate is frozen at close, so last year's closed revenue does not
 *     move when the exchange rate does
 */
export async function moveStage({ req, params, ctx }) {
    require$(ctx, 'deal.stage.change');
    const deal = getRecord('deal', ctx, params.id);
    const body = await readJson(req);

    const stage = get('SELECT * FROM stages WHERE id = ? AND workspace_id = ?', [body.stageId, ctx.workspaceId]);
    if (!stage) throw notFound('That stage does not exist.');
    if (stage.pipeline_id !== deal.pipeline_id) {
        throw badRequest('That stage belongs to a different pipeline. Change the pipeline first.');
    }

    const missing = missingStageFields(deal, stage);
    if (missing.length && !body.force) {
        throw badRequest(
            `"${stage.label}" needs ${missing.join(', ')} filled in first.`,
            { missing, stage: stage.label },
        );
    }

    if (stage.type === 'lost' && !body.lossReason) {
        const reasons = all('SELECT key, label FROM loss_reasons WHERE workspace_id = ? ORDER BY position', [ctx.workspaceId]);
        throw badRequest('Closing a deal as lost needs a reason.', { lossReasons: reasons });
    }

    const previous = get('SELECT * FROM stages WHERE id = ?', [deal.stage_id]);
    const stamp = now();

    return tx(() => {
        const values = {
            stage_id: stage.id,
            status: stage.type === 'won' ? 'won' : stage.type === 'lost' ? 'lost' : 'open',
            updated_at: stamp,
        };
        if (stage.type === 'won' || stage.type === 'lost') {
            values.closed_at = stamp;
            values.loss_reason = stage.type === 'lost' ? body.lossReason : null;
            // Freeze the rates actually used, on the record. Re-deriving them
            // later is how historical revenue silently changes.
            const rates = {};
            for (const item of all('SELECT currency, fx_rate FROM deal_line_items WHERE deal_id = ?', [params.id])) {
                rates[item.currency] = item.fx_rate;
            }
            values.close_fx_rate = JSON.stringify(rates);
        } else {
            // Reopening: a new stage-history entry, but the original close is
            // preserved in the audit trail rather than erased.
            values.closed_at = null;
            values.loss_reason = null;
        }
        update('deals', params.id, values);

        // The stage carries the probability the weighted figure is weighted by,
        // so moving stage changes what this deal is worth to a forecast even
        // though not one line item moved.
        syncDealValues(params.id, ctx);

        run('UPDATE deal_stage_history SET exited_at = ? WHERE deal_id = ? AND exited_at IS NULL', [stamp, params.id]);
        insert('deal_stage_history', {
            id: id('dsh'), workspace_id: ctx.workspaceId, deal_id: params.id,
            from_stage_id: deal.stage_id, to_stage_id: stage.id, entered_at: stamp, actor_id: ctx.userId,
        });

        audit(ctx, {
            objectKey: 'deal', recordId: params.id, accountId: deal.account_id,
            action: stage.type === 'won' ? 'deal_won' : stage.type === 'lost' ? 'deal_lost' : 'stage_changed',
            before: { stage: previous?.label ?? null, status: deal.status },
            after: { stage: stage.label, status: values.status, ...(values.loss_reason ? { loss_reason: values.loss_reason } : {}) },
        });

        // An account with an open deal is `engaged`; a won deal does not by
        // itself make a customer — a signed agreement does.
        const account = get('SELECT * FROM accounts WHERE id = ?', [deal.account_id]);
        if (account && ['prospect', 'qualified'].includes(account.lifecycle_stage) && values.status === 'open') {
            run('UPDATE accounts SET lifecycle_stage = ?, updated_at = ? WHERE id = ?', ['engaged', stamp, account.id]);
            audit(ctx, {
                objectKey: 'account', recordId: account.id, accountId: account.id, action: 'lifecycle_changed',
                before: { lifecycle_stage: account.lifecycle_stage },
                after: { lifecycle_stage: 'engaged', because: 'deal opened' },
                source: 'automation',
            });
        }
        /**
         * The reverse: an account steps back out of `engaged` once the deal
         * that put it there is lost, and nothing else is still open.
         *
         * Only for a LOSS. A won deal deliberately leaves `engaged` alone —
         * see the comment above: a won deal without a signed agreement yet is
         * still mid-contracting, not a reason to walk the lifecycle backwards.
         * A lost deal is different: `engaged` was set purely because a deal
         * was open, and once it is lost with no other deal open on the
         * account, staying `engaged` is a stale label nothing justifies any
         * more. Steps back to `qualified`, not `prospect`: this account was
         * already vetted before anything opened, and a lost deal doesn't undo
         * that.
         */
        if (account && account.lifecycle_stage === 'engaged' && stage.type === 'lost') {
            const stillOpen = get(
                "SELECT 1 FROM deals WHERE workspace_id = ? AND account_id = ? AND status = 'open' AND id <> ? LIMIT 1",
                [ctx.workspaceId, account.id, params.id],
            );
            if (!stillOpen) {
                run('UPDATE accounts SET lifecycle_stage = ?, updated_at = ? WHERE id = ?', ['qualified', stamp, account.id]);
                audit(ctx, {
                    objectKey: 'account', recordId: account.id, accountId: account.id, action: 'lifecycle_changed',
                    before: { lifecycle_stage: 'engaged' },
                    after: { lifecycle_stage: 'qualified', because: 'deal lost, no other deal open' },
                    source: 'automation',
                });
            }
        }

        return { deal: getRecord('deal', ctx, params.id) };
    });
}

/* ----------------------------------------------------------------- board -- */

/**
 * The kanban board. Columns are stages, so a workspace that adds a stage gets a
 * column without a code change.
 *
 * Column totals are reported as TWO figures — one-time and MRR — because there
 * is no honest single number for a column holding a placement fee and a
 * 24-month retainer.
 */
export async function board({ url, ctx }) {
    const pipelineId = url.searchParams.get('pipeline')
        ?? get('SELECT id FROM pipelines WHERE workspace_id = ? ORDER BY is_default DESC, position LIMIT 1', [ctx.workspaceId])?.id;
    if (!pipelineId) throw notFound('No pipeline is configured.');

    const pipeline = get('SELECT * FROM pipelines WHERE id = ? AND workspace_id = ?', [pipelineId, ctx.workspaceId]);
    if (!pipeline) throw notFound('That pipeline does not exist.');

    const stages = all('SELECT * FROM stages WHERE pipeline_id = ? ORDER BY position', [pipelineId]);
    const onlyOpen = url.searchParams.get('open') !== '0';
    const ownerId = url.searchParams.get('owner');

    /**
     * The board's second axis is the SERVICE, not a second pipeline.
     *
     * Which stages a deal moves through is one question and what was sold is
     * another, and the workspace had been answering the second with the first:
     * three pipelines called Recruitment, Managed services and Commercial, so
     * "show me the OD deals" was a question the board could not be asked. The
     * services are OD, Recruitment, HCM and Offshoring, they live in
     * `service_lines`, and every deal already carries one.
     */
    const service = url.searchParams.get('service');

    /**
     * Deals in a time range, the way the dashboard slices its widgets.
     *
     * `range` is a preset (today/week/month/quarter/year/all). Deals are
     * filtered by CREATED date — "what did we open this month" is the question
     * a pipeline answers, and closed deals are their own dashboard widget.
     * Resolved in the workspace timezone, exactly like the dashboard.
     */
    const range = url.searchParams.get('range');
    let fromDate = null;
    let toDate = null;
    if (range && range !== 'all') {
        const resolved = resolveRange({ preset: range }, { timeZone: ctx.workspace?.timezone ?? 'UTC' });
        if (resolved?.from) fromDate = String(resolved.from).slice(0, 10);
        if (resolved?.to) toDate = String(resolved.to).slice(0, 10);
    }

    /**
     * "Open" hides STALE open-pipeline noise, not the Won/Lost columns
     * themselves — those two are terminal stages, always shown, or the board
     * would render a "Deal Won" column that a deal dropped into that instant
     * immediately vanishes from (status flips to 'won' on the move, and the
     * very next reload would otherwise filter it straight back out).
     */
    const terminalStageIds = stages.filter((s) => s.type !== 'open').map((s) => s.id);
    const filter = { op: 'and', children: [{ field: 'pipeline_id', operator: 'is', value: pipelineId }] };
    if (onlyOpen) {
        filter.children.push({
            op: 'or',
            children: [
                { field: 'status', operator: 'is_any_of', value: ['open'] },
                ...(terminalStageIds.length ? [{ field: 'stage_id', operator: 'is_any_of', value: terminalStageIds }] : []),
            ],
        });
    }
    if (ownerId) filter.children.push({ field: 'owner_id', operator: 'is_any_of', value: [ownerId] });
    if (service) filter.children.push({ field: 'service_line_key', operator: 'is_any_of', value: [service] });
    if (fromDate && toDate) filter.children.push({ field: 'created_at', operator: 'between', value: [fromDate, toDate] });

    // A column with 10,000 cards is capped and says so, rather than rendering
    // 10,000 nodes and calling it a board.
    const CAP = 100;

    /**
     * ONE read for the board, grouped into columns here.
     *
     * This mapped over the stages calling `listRecords` for each — a count and
     * a page of rows per column, thirteen columns, twenty-six blocking round
     * trips to draw one screen. The board is the deals landing page, so that
     * was the slowest thing in the product and the first thing anybody saw.
     *
     * The per-column CAP is kept as a display cap: the whole board is read to
     * `BOARD_LIMIT` and each column shows at most CAP of its own cards, with
     * `truncated` still telling the truth about what was left out. The exact
     * per-column totals come from `countsByStage` below — a single GROUP BY,
     * so a capped read never turns into a wrong count.
     */
    const BOARD_LIMIT = 2000;
    const rates = reportingRates((key) => setting(ctx.workspaceId, key));
    const page = listRecords('deal', ctx, {
        filter, limit: BOARD_LIMIT, sort: [{ field: 'updated_at', direction: 'desc' }],
    });

    const byStage = new Map();
    for (const deal of page.records) {
        if (!byStage.has(deal.stage_id)) byStage.set(deal.stage_id, []);
        byStage.get(deal.stage_id).push(deal);
    }

    /**
     * The true count per column, whatever the read was capped at.
     *
     * A board that shows "100" on every busy column because that is where the
     * page stopped is a board reporting its own limit as a business figure.
     * One GROUP BY answers it for every column at once.
     */
    const counts = new Map(
        stageCounts(ctx, { pipelineId, onlyOpen, ownerId, service, fromDate, toDate, terminalStageIds }).map((r) => [r.stage_id, r.n]),
    );

    const columns = stages.map((stage) => {
        const all$ = byStage.get(stage.id) ?? [];
        const total = counts.get(stage.id) ?? all$.length;
        const deals = all$.slice(0, CAP);
        return {
            stage: { id: stage.id, key: stage.key, label: stage.label, type: stage.type, probability: stage.probability, wipLimit: stage.wip_limit },
            deals,
            total,
            truncated: total > deals.length,
            /**
             * Totalled from what was READ, which is the whole column unless the
             * board itself was capped. `aggregate` over the displayed hundred
             * would have reported the value of a hundred cards as the value of
             * the column.
             */
            totals: aggregateInReporting(all$, rates),
            overWip: stage.wip_limit ? total > stage.wip_limit : false,
        };
    });

    return {
        currency: REPORTING_CURRENCY,
        pipeline,
        pipelines: all('SELECT * FROM pipelines WHERE workspace_id = ? ORDER BY position', [ctx.workspaceId]),
        // What the board can be sliced by, from the workspace's own service
        // lines rather than a list repeated in the client.
        services: all(
            'SELECT key, label FROM service_lines WHERE workspace_id = ? ORDER BY position',
            [ctx.workspaceId],
        ),
        service: service ?? null,
        columns,
        cap: CAP,
        // A board bigger than one read is a board whose column totals are a
        // floor. Reported, because the alternative is a quiet understatement.
        truncated: page.total > page.records.length
            ? { shown: page.records.length, total: page.total }
            : null,
    };
}

/**
 * How many deals sit in each stage of this pipeline, in one statement.
 *
 * The filter is rebuilt in SQL rather than compiled from the same filter tree,
 * because the tree compiler produces a WHERE for a `SELECT *` and this needs a
 * GROUP BY — and because these four conditions are the whole of what the board
 * filters by. If that stops being true, this has to follow it, and the test
 * that compares these counts against the rows is what will say so.
 */
function stageCounts(ctx, { pipelineId, onlyOpen, ownerId, service, fromDate = null, toDate = null, terminalStageIds = [] }) {
    const where = ['d.workspace_id = ?', 'd.deleted_at IS NULL', 'd.pipeline_id = ?'];
    const params = [ctx.workspaceId, pipelineId];
    // Same rule as the board's own filter: "open" hides stale open-pipeline
    // deals, never a stage's own Won/Lost column.
    if (onlyOpen) {
        if (terminalStageIds.length) {
            where.push(`(d.status = 'open' OR d.stage_id IN (${terminalStageIds.map(() => '?').join(',')}))`);
            params.push(...terminalStageIds);
        } else {
            where.push("d.status = 'open'");
        }
    }
    if (ownerId) { where.push('d.owner_id = ?'); params.push(ownerId); }
    if (service) { where.push('d.service_line_key = ?'); params.push(service); }
    if (fromDate && toDate) {
        where.push('d.created_at BETWEEN ? AND ?');
        params.push(fromDate, `${toDate}T23:59:59.999Z`);
    }
    return all(
        `SELECT d.stage_id, COUNT(*) AS n FROM deals d
          WHERE ${where.join(' AND ')} GROUP BY d.stage_id`,
        params,
    );
}

/**
 * Forecast.
 *
 * Deliberately returns one-time and recurring as separate structures with no
 * combined total anywhere except `tcv`, which names the assumption it makes.
 */
export async function forecast({ url, ctx }) {
    const days = Math.max(1, Number(url.searchParams.get('days')) || 90);
    const horizon = new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
    const rates = reportingRates((key) => setting(ctx.workspaceId, key));

    /**
     * Every open deal, split by `splitDealsByCloseDate` — the same function
     * the main dashboard's period forecast now uses — into those due inside
     * the horizon and those with no close date at all.
     *
     * A deal can be raised the moment a meeting is booked — no price, no line
     * items, no date — because that is when it becomes real to the person
     * working it. They are included and REPORTED SEPARATELY: a deal with no
     * date cannot be claimed to land inside ninety days, so folding it into
     * that total would be a forecast nobody could stand behind; leaving it out
     * entirely was worse, because the pipeline looked emptier than it is.
     *
     * The status filter alone decides what is fetched; the close-date window
     * is applied afterward in JS so both forecasts share one definition of
     * "inside the window". At real scale this means the 200-row cap applies
     * before the date split rather than after, so a pipeline with hundreds of
     * far-future deals could in principle crowd out a closer one — acceptable
     * for now, and the first thing to revisit if the cap is ever hit.
     */
    const allOpen = listRecords('deal', ctx, {
        filter: { field: 'status', operator: 'is_any_of', value: ['open'] },
        limit: 200,
        sort: [{ field: 'close_date', direction: 'asc' }],
    });
    const { dated, undated } = splitDealsByCloseDate(allOpen.records, { to: horizon });
    const openDeals = { records: [...dated, ...undated] };

    const wonThisPeriod = listRecords('deal', ctx, {
        filter: {
            op: 'and',
            children: [
                { field: 'status', operator: 'is_any_of', value: ['won'] },
                { field: 'closed_at', operator: 'in_last_days', value: days },
            ],
        },
        limit: 200,
    });

    const byStage = new Map();
    for (const deal of openDeals.records) {
        const key = deal.stage_label ?? 'Unknown';
        if (!byStage.has(key)) byStage.set(key, []);
        byStage.get(key).push(deal);
    }

    return {
        horizonDays: days,
        currency: REPORTING_CURRENCY,
        open: aggregateInReporting(dated, rates),
        // Real pipeline that has not been given a date yet. Counted on its own
        // so the horizon total stays a claim about the horizon.
        unscheduled: aggregateInReporting(undated, rates),
        won: aggregateInReporting(wonThisPeriod.records, rates),
        byStage: [...byStage.entries()].map(([label, deals]) => ({ label, ...aggregateInReporting(deals, rates) })),
        deals: openDeals.records,
        // Stated, not implied. A reader who does not know which number is which
        // will add them, and then the report is wrong.
        note: 'One-time and recurring revenue are reported separately and are never added together. '
            + 'TCV is the only combined figure and assumes each recurring line runs its stated term '
            + '(12 months where no term is set).',
    };
}
