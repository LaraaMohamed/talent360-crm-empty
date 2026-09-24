/**
 * Dashboards.
 *
 * Widget types are a registry, so adding "verdict distribution by industry" is
 * a function here plus a row in a layout — no schema change and no new endpoint.
 *
 * Three rules every widget in this file obeys:
 *
 *  1. VERDICT BREAKDOWNS ALWAYS SHOW ALL THREE ANSWERS. A chart with QUALIFIED
 *     and REJECTED and no REVIEW is a lie by omission, and REVIEW is frequently
 *     the largest bucket (58 of 223 for HCM in the current data).
 *  2. ONE-TIME AND RECURRING REVENUE ARE NEVER SUMMED. Any widget showing
 *     "pipeline" states which it means.
 *  3. EVERY WIDGET STATES ITS DATE RANGE AND WHEN IT WAS COMPUTED. An
 *     unlabelled number on a dashboard is a rumour.
 */
import { all, get, run, id, now, json } from '../lib/db.mjs';
import { listRecords, audit, splitDealsByCloseDate, priceInForce } from '../lib/repo.mjs';
import { aggregate, aggregateInReporting, reportingRates, REPORTING_CURRENCY, lineValue } from '../lib/money.mjs';
import { setting } from '../lib/settings.mjs';
import { verdictTally, activeRules, isStale } from '../lib/qualification.mjs';
import { VERDICTS, LIFECYCLE_STAGES, ACCOUNT_TYPES } from '../lib/objects.mjs';
import { readJson, badRequest, notFound } from '../lib/http.mjs';
import { can } from '../lib/auth.mjs';
import { resolveRange } from '../lib/date-range.mjs';
import { CALL_OUTCOMES } from '../lib/calling.mjs';
import { meetingStats, showRate } from '../lib/meetings.mjs';

export async function listDashboards({ ctx }) {
    const rows = all(
        `SELECT * FROM dashboards WHERE workspace_id = ? AND (scope = 'workspace' OR owner_id = ?)
          ORDER BY is_default DESC, name`,
        [ctx.workspaceId, ctx.userId],
    );
    return {
        dashboards: rows.map((d) => ({ ...d, layout: json(d.layout, []) })),
        widgets: Object.entries(WIDGETS).map(([key, w]) => ({ key, label: w.label, description: w.description })),
    };
}

/**
 * The dashboard "/default" means FOR THIS PERSON.
 *
 * A manager and a rep were being handed the same thirteen widgets, seven of
 * them full width. The manager scrolled past "My tasks"; the rep scrolled past
 * "SDR performance" and the calling queue. Neither screen answered its reader's
 * first question, because it was answering everybody's.
 *
 * Resolution, in order:
 *   1. a stored dashboard for this role — what a layout editor will write
 *   2. the role layout in code below, which is what every workspace gets today
 *   3. the workspace-wide dashboard, so a database that predates this keeps
 *      exactly the screen it had
 *
 * Step 3 is why this needs no data migration and no re-run of setup: a
 * workspace with no role layouts behaves as it always did.
 */
function defaultDashboardFor(ctx) {
    const stored = get(
        'SELECT * FROM dashboards WHERE workspace_id = ? AND role = ? ORDER BY is_default DESC LIMIT 1',
        [ctx.workspaceId, ctx.role],
    );
    if (stored) return stored;

    const layout = ROLE_DASHBOARDS[ctx.role];
    if (layout) {
        return {
            id: `default:${ctx.role}`,
            workspace_id: ctx.workspaceId,
            name: 'Overview',
            layout: JSON.stringify(layout),
            role: ctx.role,
            scope: 'workspace',
            is_default: 1,
        };
    }

    return get(
        'SELECT * FROM dashboards WHERE workspace_id = ? AND role IS NULL ORDER BY is_default DESC LIMIT 1',
        [ctx.workspaceId],
    );
}

export async function dashboardData({ params, url, ctx }) {
    const dashboard = params.id === 'default'
        ? defaultDashboardFor(ctx)
        : get('SELECT * FROM dashboards WHERE id = ? AND workspace_id = ?', [params.id, ctx.workspaceId]);
    if (!dashboard) throw notFound('No dashboard is configured.');

    const layout = json(dashboard.layout, []);
    const computedAt = now();
    const widgets = [];

    /**
     * Reads shared between the widgets on THIS load, and no longer. See `memo`.
     */
    ctx._dashboardReads = new Map();

    /**
     * One range for the whole dashboard, resolved in the workspace's timezone.
     *
     * Widgets that measure a PERIOD use it — deals won, activity, win rate.
     * Widgets that describe the CURRENT STATE ignore it and say so, because
     * "open pipeline in March" is not a thing a pipeline can tell you: it holds
     * what is open now, not what was open then.
     */
    const range = resolveRange(
        {
            preset: url.searchParams.get('range') ?? undefined,
            from: url.searchParams.get('from') ?? undefined,
            to: url.searchParams.get('to') ?? undefined,
        },
        { timeZone: ctx.workspace.timezone || 'UTC', weekendDays: ctx.workspace.weekendDays },
    );

    /**
     * An optional person filter, `?sdr=<user-id>`, shared across the widgets that
     * are scoped per person — currently the meeting analytics one. It is read off
     * the URL and attached to the range object so the widgets that care about it
     * see it without every widget signature changing.
     *
     * This is deliberately a single person, not a list: the Cold Calling screen
     * it lands on already takes `?sdr=<id>`, and the dashboard link in a meeting
     * row points a manager straight at one rep's queue.
     */
    const sdr = url.searchParams.get('sdr');
    /**
     * A user id is a STRING — `usr_35BwUHEMnsji`. This ran it through
     * `parseInt`, which returns NaN for every id this system has ever issued,
     * so the filter resolved to null and quietly showed the whole team however
     * carefully a manager picked one person.
     *
     * Kept as given, and checked against the workspace's membership rather than
     * trusted: an id from a hand-edited URL must not reach a query as a filter
     * on somebody in another workspace.
     */
    if (sdr) {
        const member = get(
            `SELECT u.id FROM users u
               JOIN memberships m ON m.user_id = u.id AND m.workspace_id = ?
              WHERE u.id = ?`,
            [ctx.workspaceId, sdr],
        );
        range.person = member?.id ?? null;
    }

    /**
     * The management reporting rates, read once for the whole dashboard.
     *
     * Every money widget converts with the SAME rates, so two figures on one
     * screen can always be added together. Read per request rather than cached,
     * because an admin changing a rate should see the effect on the next load —
     * that is the entire point of them being editable.
     */
    const reporting = {
        currency: REPORTING_CURRENCY,
        rates: reportingRates((key) => setting(ctx.workspaceId, key)),
    };

    for (const item of layout) {
        const widget = WIDGETS[item.widget];
        if (!widget) {
            widgets.push({ ...item, error: `Unknown widget "${item.widget}".` });
            continue;
        }
        /**
         * A money widget is REFUSED here, not omitted from a layout.
         *
         * Which widgets a role's default layout carries is a matter of what is
         * useful to them. Whether the server will compute money for them is a
         * matter of authorization, and the two must not be the same mechanism:
         * `/api/dashboards/default/data` is not the only way in. Any member can
         * name a stored dashboard by id, and the workspace-wide one carries
         * `pipeline_by_stage` — so a rep asking for it by id was, until now,
         * handed the pipeline.
         *
         * The refusal is visible rather than silent. A widget that quietly
         * disappears looks like a bug worth reporting; one that says why does
         * not, and nothing is disclosed by naming the capability.
         */
        if (widget.money && !can(ctx, 'finance.read')) {
            widgets.push({
                ...item,
                label: widget.label,
                error: `Your role (${ctx.role}) cannot see financial figures.`,
                computedAt,
            });
            continue;
        }

        /**
         * The same rule for the sourcing book.
         *
         * `prospecting_funnel` counts every uploaded company by status and
         * `stale_verdicts` lists the qualification calls that have aged out —
         * both of them prospecting, both of them reachable by naming the
         * workspace dashboard by id, which any member can do. A rep does not
         * hold `prospecting.read`, so they do not get these, whichever layout
         * asked for them.
         */
        if (widget.prospecting && !can(ctx, 'prospecting.read')) {
            widgets.push({
                ...item,
                label: widget.label,
                error: `Your role (${ctx.role}) cannot see prospecting.`,
                computedAt,
            });
            continue;
        }

        try {
            // Widgets read through the same permission-aware repository as every
            // other surface, so two users genuinely see different numbers on the
            // same dashboard — correctly.
            widgets.push({
                ...item,
                label: widget.label,
                data: await widget.run(ctx, item.options ?? {}, range, reporting),
                computedAt,
            });
        } catch (err) {
            // One failing widget must not take the dashboard down with it.
            widgets.push({ ...item, label: widget.label, error: err.message, computedAt });
        }
    }

    return { dashboard: { ...dashboard, layout }, widgets, computedAt, range, currency: reporting.currency, rates: reporting.rates };
}

export async function patchDashboard({ req, params, ctx }) {
    const dashboard = get('SELECT * FROM dashboards WHERE id = ? AND workspace_id = ?', [params.id, ctx.workspaceId]);
    if (!dashboard) throw notFound('That dashboard does not exist.');
    const body = await readJson(req);
    const values = { updated_at: now() };
    if (body.name !== undefined) values.name = String(body.name).slice(0, 120);
    if (body.layout !== undefined) {
        for (const item of body.layout) {
            if (!WIDGETS[item.widget]) throw badRequest(`Unknown widget "${item.widget}".`);
        }
        values.layout = JSON.stringify(body.layout);
    }
    const keys = Object.keys(values);
    run(`UPDATE dashboards SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => values[k]), params.id]);
    audit(ctx, { objectKey: 'dashboard', recordId: params.id, action: 'updated', after: { name: values.name } });
    return { dashboard: { ...get('SELECT * FROM dashboards WHERE id = ?', [params.id]), layout: json(values.layout ?? dashboard.layout, []) } };
}

/* --------------------------------------------------------------- widgets -- */

/**
 * The dashboard a new workspace starts with.
 *
 * Commercial first, intake second, qualification detail not at all — the
 * verdict widgets still exist and can be added back by an admin, but they are
 * not what this screen is for. Kept here beside the widget registry so a
 * renamed widget cannot leave the default layout pointing at nothing.
 */
export const DEFAULT_DASHBOARD = [
    { widget: 'crm_snapshot', title: 'CRM at a glance', size: 'wide', options: {} },
    { widget: 'pipeline_by_stage', title: 'Commercial pipeline', size: 'wide', options: {} },
    { widget: 'prospecting_funnel', title: 'Prospecting intake', size: 'wide', options: {} },
    { widget: 'deals_won', title: 'Won, in money', size: 'wide', options: {} },
    { widget: 'calling_activity', title: 'Cold calling', size: 'wide', options: {} },
    { widget: 'sdr_performance', title: 'SDR performance', size: 'wide', options: {} },
    { widget: 'calling_queue', title: 'Calling queue', size: 'wide', options: {} },
    { widget: 'win_rate', title: 'Win rate', size: 'half', options: {} },
    { widget: 'deals_by_service', title: 'Deals by service', size: 'half', options: {} },
    // Egypt against Regional, beside the service split so the two read as a
    // pair. `account_type` describes itself on the field as "the commercial
    // grouping the dashboard reports by"; until this row, nothing did.
    { widget: 'deals_by_account_type', title: 'Egypt vs Regional', size: 'half', options: {} },
    { widget: 'my_tasks', title: 'My tasks', size: 'half', options: {} },
    { widget: 'renewals', title: 'Renewals & notice dates', size: 'half', options: { days: 90 } },
    { widget: 'activity_volume', title: 'Activity', size: 'half', options: {} },
    { widget: 'lifecycle_funnel', title: 'Account lifecycle', size: 'half', options: {} },
];

/**
 * The layout each role opens on, when the workspace has not stored its own.
 *
 * Keyed by role and read by `defaultDashboardFor` above, which falls back to the
 * workspace-wide `DEFAULT_DASHBOARD` for any role not listed — so a role added
 * later, or a workspace that predates this, keeps exactly the screen it had.
 *
 * A REP's layout carries no money widget. That is not only tidiness: pipeline
 * and revenue are the figures Part 15 restricts, and the cheapest way not to
 * send them is not to put them on the page. The server-side gate is still
 * coming (Phase 5) and is what actually enforces it — this just stops the
 * request being made.
 *
 * An SDR is absent on purpose. They are confined to /api/calling/* and never
 * reach a dashboard at all.
 */
/**
 * A manager's eight, not the workspace's thirteen.
 *
 * The question this screen answers is "how is the business doing, and what
 * needs me" — so it carries the pipeline, what closed, the two splits the
 * business reports by, and what is about to renew. Prospecting intake, the
 * calling queue and the lifecycle funnel are all real widgets and none of them
 * answers that question; an admin gets the intake ones back below.
 */
/**
 * `section` bands the widgets so nine cards read as three questions.
 *
 * A dashboard of identical cards makes the reader weigh every one of them
 * equally, which is how a renewal date and an activity count end up looking
 * like the same kind of fact. The bands are the questions a manager actually
 * arrives with, in the order they ask them.
 *
 * ── ON EGYPT vs REGIONAL ────────────────────────────────────────────────────
 *
 * `service_performance` crosses account type WITH service and reports won
 * revenue against target. `deals_by_account_type` and `deals_by_service` each
 * answer half of that, in counts. Carrying all three meant three widgets
 * answering one question three ways, so the two halves come off here.
 *
 * They are not deleted: they are exactly what rep and readonly get, because
 * `service_performance` reports money and those roles may not see it. One
 * question, two answers, chosen by what the reader is allowed to know.
 */
const MANAGER_DASHBOARD = [
    { widget: 'sdr_performance', title: 'Team calling', size: 'wide', section: 'The team', options: {} },
    { widget: 'meeting_analytics', title: 'Team meetings', size: 'wide', section: 'The team', options: {} },

    { widget: 'crm_snapshot', title: 'At a glance', size: 'wide', section: 'Where we stand', options: {} },
    { widget: 'pipeline_by_stage', title: 'Pipeline', size: 'wide', section: 'Where we stand', options: {} },

    { widget: 'deals_won', title: 'Won, in money', size: 'wide', section: 'What closed', options: {} },
    { widget: 'win_rate', title: 'Win rate', size: 'wide', section: 'What closed', options: {} },
    { widget: 'renewals', title: 'Renewals & notice dates', size: 'wide', section: 'What closed', options: { days: 90 } },
    { widget: 'service_performance', title: 'Egypt & Regional by service', size: 'wide', section: 'What closed', options: {} },
];

/**
 * Exported so the rule below is TESTED rather than trusted.
 *
 * "A rep's layout carries no money widget" was a comment sitting directly above
 * two widgets that render currency, and it stayed wrong until somebody read the
 * two together. A widget that reports money declares `money: true` in the
 * registry, and test.mjs refuses any layout that puts one in front of a role
 * that may not see it — so the next money widget cannot be added to these
 * lists by accident.
 */
export const ROLE_DASHBOARDS = {
    manager: MANAGER_DASHBOARD,

    // An admin is a manager who also owns the data, so they get the intake
    // widget that answers "is anything quietly rotting" — intake nobody has worked.
    admin: [
        ...MANAGER_DASHBOARD,
        { widget: 'prospecting_funnel', title: 'Prospecting intake', size: 'wide', section: 'Data health', options: {} },
    ],
    owner: [
        ...MANAGER_DASHBOARD,
        { widget: 'prospecting_funnel', title: 'Prospecting intake', size: 'wide', section: 'Data health', options: {} },
    ],

    /**
     * No money reaches these two, and it is now true rather than merely stated.
     *
     * Two widgets were breaking the rule the comment above declares.
     * `pipeline_by_stage`, sitting on both layouts under the heading
     * "Commercial pipeline", renders one-time and MRR for every stage. And
     * `crm_snapshot` on the readonly layout carries three money tiles, one of
     * them labelled "Pipeline". Both were already sending those figures to the
     * browser. Neither is here now.
     *
     * What replaces them counts rather than values: how many open deals sit
     * against each service and each commercial grouping is a shape of the
     * business a rep needs, and it has no currency symbol anywhere on it.
     */
    rep: [
        { widget: 'my_tasks', title: 'My tasks', size: 'wide', section: 'My work', options: {} },
        { widget: 'my_calling', title: 'My calling', size: 'wide', section: 'My work', options: {} },
        { widget: 'activity_volume', title: 'My activity', size: 'half', section: 'My work', options: {} },

        { widget: 'deals_by_service', title: 'Open deals by service', size: 'half', section: 'The book', options: {} },
        { widget: 'deals_by_account_type', title: 'Egypt vs Regional', size: 'half', section: 'The book', options: {} },
        { widget: 'lifecycle_funnel', title: 'Account lifecycle', size: 'half', section: 'The book', options: {} },
        /**
         * Prospecting intake used to sit here and cannot any more.
         *
         * A rep does not hold `prospecting.read`, so the widget is refused —
         * which after the refusal was added meant this layout drew a card
         * reading "Your role cannot see prospecting" on the rep's own home
         * page. A layout that asks for something the role is denied is a
         * layout nobody meant to write; the fix belongs here rather than in an
         * exception to the refusal.
         *
         * Win rate replaces it. It carries no money — it is counts and a
         * percentage — so it passes the rule this list exists to keep, and
         * "how am I doing" is a better question for a rep's dashboard than
         * "what did the sourcing pile do".
         */
        { widget: 'win_rate', title: 'My win rate', size: 'wide', section: 'The book', options: { owner: 'me' } },
    ],
    sdr: [
        { widget: 'my_calling', title: 'My calling', size: 'wide', section: 'My work', options: {} },
        { widget: 'my_tasks', title: 'My tasks', size: 'wide', section: 'My work', options: {} },
        { widget: 'activity_volume', title: 'My activity', size: 'half', section: 'My work', options: {} },
        { widget: 'deals_by_service', title: 'Open deals by service', size: 'half', section: 'The book', options: {} },
        { widget: 'deals_by_account_type', title: 'Egypt vs Regional', size: 'half', section: 'The book', options: {} },
        { widget: 'lifecycle_funnel', title: 'Account lifecycle', size: 'half', section: 'The book', options: {} },
    ],
    /**
     * Four widgets and no bands, deliberately.
     *
     * Banding exists to stop a long page reading as one undifferentiated list.
     * Four cards are not a long page, and a single heading over all of them is
     * decoration rather than structure — the same reason the record form does
     * not print a section title when there is only one section.
     */
    readonly: [
        { widget: 'deals_by_service', title: 'Open deals by service', size: 'half', options: {} },
        { widget: 'deals_by_account_type', title: 'Egypt vs Regional', size: 'half', options: {} },
        { widget: 'lifecycle_funnel', title: 'Account lifecycle', size: 'half', options: {} },
        { widget: 'activity_volume', title: 'Activity', size: 'half', options: {} },
    ],
};

/**
 * Deals that CLOSED inside the range, hydrated so their money can be totalled.
 *
 * Two steps on purpose. The filter compiler compares dates a DAY at a time in
 * UTC, and a day in Riyadh is not a day in UTC — so the range's instants are
 * applied in SQL, where they are exact, and the ids then go back through
 * `listRecords` to pick up line items and the same permission rules as every
 * other surface. Counting in SQL alone would show a rep deals they cannot see.
 */
/**
 * COUNT over a table, scoped to the range by a NAMED timestamp column.
 *
 * The column is the whole point. "Accounts added today" is a creation date,
 * "calls today" is when the call happened, "tasks due today" is a due date, and
 * a meeting logged this morning may have happened last week. One clock for all
 * of them would be wrong for most of them, so every caller names its own and
 * there is no default.
 *
 * The range's bounds are UTC instants resolved from the workspace's timezone by
 * `resolveRange`, and the comparison is against the stored ISO-8601 timestamp —
 * so "today" is a day in Riyadh, not a day in UTC. Comparing with DATE() would
 * put three hours of every night in the wrong day.
 *
 * `to` is exclusive, matching the resolver, so nothing is counted in two periods.
 */
function countInRange(ctx, table, column, range, extra = null) {
    const { sql, params } = countClause(ctx, table, column, range, extra);
    return get(sql, params)?.n ?? 0;
}

/** The one-table COUNT, as SQL and parameters, so it can be batched below. */
function countClause(ctx, table, column, range, extra = null) {
    const where = ['workspace_id = ?', 'deleted_at IS NULL'];
    const params = [ctx.workspaceId];
    if (extra) where.push(extra);
    if (range?.from) { where.push(`${column} >= ?`); params.push(range.from); }
    if (range?.to) { where.push(`${column} < ?`); params.push(range.to); }
    return { sql: `SELECT COUNT(*) AS n FROM ${table} WHERE ${where.join(' AND ')}`, params };
}

/**
 * MANY counts, in ONE statement.
 *
 * ── WHY THIS IS WORTH A UNION ───────────────────────────────────────────────
 *
 * The snapshot widget asks seven "how many X in this period" questions across
 * seven tables. Seven `COUNT(*)`s over indexed columns is nothing — but against
 * the live backend each one is a BLOCKING round trip, and the tiles cannot draw
 * until the last returns. So the cost is seven latencies, not seven counts.
 *
 * `UNION ALL` puts them in one statement and one trip. Each arm carries its own
 * key so the caller reads results by name rather than by position, because a
 * silent re-ordering of the specs would otherwise relabel every tile on the
 * dashboard with no error anywhere.
 *
 * Specs are `[key, table, column, extra?]`. `extra` is a fragment written in
 * this file and never from a request, which is what keeps a concatenated
 * predicate safe here.
 */
function countsInRange(ctx, specs, range) {
    if (!specs.length) return {};
    const arms = [];
    const params = [];
    for (const [key, table, column, extra = null] of specs) {
        const clause = countClause(ctx, table, column, range, extra);
        arms.push(clause.sql.replace('SELECT COUNT(*) AS n', `SELECT '${key}' AS k, COUNT(*) AS n`));
        params.push(...clause.params);
    }
    const rows = all(arms.join(' UNION ALL '), params);
    const out = {};
    for (const [key] of specs) out[key] = 0;
    for (const row of rows) out[row.k] = row.n ?? 0;
    return out;
}

/**
 * Every open deal, read once per request.
 *
 * Three widgets want this exact set. The limit is stated here rather than at
 * each call site so they cannot disagree about how much of the pipeline they
 * are looking at — two widgets capping differently would report two different
 * pipeline values on one screen.
 */
const OPEN_LIMIT = 500;

function openDeals(ctx, options = {}) {
    const scope = ownerScope(ctx, options);
    return memo(ctx, `open:${JSON.stringify(scope)}`, () => listRecords('deal', ctx, {
        filter: { op: 'and', children: [{ field: 'status', operator: 'is_any_of', value: ['open'] }, ...scope] },
        limit: OPEN_LIMIT,
    }));
}

/**
 * Pipeline deals: open deals EXCLUDING the contracting stage.
 *
 * Deals with unsigned agreements (contracting stage) are visible in the
 * kanban and count toward forecasting, but should NOT count in pipeline
 * value tiles — they are not yet committed revenue.
 *
 * Derived from the SAME hydrated `openDeals` the forecast and the open count
 * use, filtered in JavaScript by stage, rather than a second 500-deal query +
 * hydration. The memo makes the two reads share one set of rows.
 */
function pipelineDeals(ctx, options = {}) {
    const open = openDeals(ctx, options);
    if (!open.records.length) return open;
    const contractingIds = new Set(getContractingStageIds(ctx));
    if (!contractingIds.size) return open;
    const records = open.records.filter((r) => !contractingIds.has(r.stage_id));
    return { ...open, records, total: records.length };
}

/**
 * A won deal's money, as it stood the day it closed — not as it stands today.
 *
 * `own_one_time`/`own_mrr` on a hydrated deal record are always today's price
 * (`dealValuesFor` reads the CURRENT `deal_line_items` row, itself a
 * projection of whichever `deal_price_periods` row is in force right now —
 * see `lib/repo.mjs`). Left alone, a deal re-quoted after it was won would
 * silently rewrite what "Won, per month" reported for the month it actually
 * closed in — exactly the retrospective rewriting `deal_price_periods` exists
 * to prevent for the price itself, just one layer further out.
 *
 * Falls back to the deal's own current-derived figures when there is no dated
 * price history to ask (a deal priced before `deal_price_periods` existed, or
 * never priced at all) — trusting what is there rather than turning a real
 * number into a silent zero.
 */
function dealAtClose(ctx, deal) {
    const period = priceInForce(ctx, deal.id, deal.closed_at);
    if (!period) return deal;
    const v = lineValue({
        unit_amount: period.unit_amount,
        quantity: period.quantity,
        fx_rate: period.fx_rate,
        recurrence: period.recurrence,
        term_months: period.term_months,
        currency: period.currency,
    });
    return {
        ...deal,
        own_one_time: v.oneTime,
        own_mrr: v.monthly,
        own_tcv: v.lineContractValue,
        currency: v.currency ?? deal.currency,
    };
}

function getContractingStageIds(ctx) {
    const stages = all(
        'SELECT id FROM stages WHERE workspace_id = ? AND key = ?',
        [ctx.workspaceId, 'contracting'],
    );
    return stages.map((s) => s.id);
}

/** What a tile means when it cannot be scoped to a period. Said, not implied. */
const AS_OF_NOW = 'Right now, whatever the range — the database keeps no history of what this was.';

const CLOSED_LIMIT = 500;

/** Money to the cent, so a sum of two rounded figures does not drift. */
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Scopes a widget to the viewer's own records when the layout asks for it.
 *
 * A rep holds `record.read.all`, so the repository will happily hand them the
 * whole workspace — which is right for a list they went looking at and wrong
 * for a dashboard tile labelled "my pipeline". The layout says `owner: 'me'`
 * and this is what that means. Anything else scopes to nobody in particular,
 * which is the manager's view and the existing behaviour.
 */
/**
 * One dashboard load reads the same deals five times.
 *
 * ── WHAT IT WAS DOING ───────────────────────────────────────────────────────
 *
 * "Every open deal" is wanted by the snapshot, by pipeline value and by the
 * forecast; "every deal won in this range" is wanted by the snapshot, by deals
 * won and by the win rate. Each widget asked for itself, so one page load
 * fetched the same two result sets three times each — six count-and-page pairs
 * for two distinct questions.
 *
 * Against a file that is invisible. Against Turso it is twelve blocking round
 * trips for data the process was already holding.
 *
 * ── WHY A REQUEST-SCOPED CACHE AND NOT A LONGER-LIVED ONE ───────────────────
 *
 * Because the answer must not survive the request. A dashboard is read after a
 * deal moves, and a cache that outlived one load would show the stage the deal
 * was in a minute ago — which is precisely the kind of quietly-stale number
 * this codebase refuses elsewhere. The map is created by `dashboardData`, lives
 * on the request's ctx, and is thrown away with it.
 *
 * Widgets asked for by id outside that handler get no map and simply read
 * through, so this is an optimisation and never a behaviour.
 */
function memo(ctx, key, produce) {
    const cache = ctx?._dashboardReads;
    if (!cache) return produce();
    if (!cache.has(key)) cache.set(key, produce());
    return cache.get(key);
}

/**
 * A link from a cold-calling number straight to the exact rows behind it.
 *
 * The Calling Queue's filter builder already speaks the `calling_assignment`
 * object (lib/objects.mjs) — `last_outcome`, `queue_status`, `assigned_to` —
 * so this just writes the same filter shape the queue page's own filter UI
 * would produce and lets `/calling` decode it exactly as it decodes one a
 * person built by hand. `sdrId` is passed as the queue's own `sdr` scope
 * param rather than folded into the filter, matching how every other
 * SDR-scoped link on this dashboard already reaches the queue (see
 * `hrefTemplate: '/calling?sdr={id}'` on the SDR performance table).
 *
 * Reads the CURRENT state of each assignment (`last_outcome`, `queue_status`)
 * rather than the count of matching call EVENTS in the selected range, which
 * is what the number clicked usually counts — a lead called twice with a No
 * Answer both times, then reached on a third call, contributes 2 to the "No
 * answer" count for the period but has `last_outcome = qualified` (or
 * whatever the third call produced) right now, and is not on this filtered
 * list. That is the honest limit of a queue built on current assignment
 * state: it can show "everyone currently sitting at this outcome", not
 * "everyone who ever produced it in this window".
 */
function callingHref({ outcome = null, queueStatus = null, tab = null, extra = [], sdrId = null, range = null } = {}) {
    const children = [];
    // `outcome` is usually one key, but "Qualified" now stands for two
    // (see QUALIFIED_OUTCOMES) — accepting an array here means the number
    // and the drill-through link can never disagree about what it counts.
    if (outcome) children.push({ field: 'last_outcome', operator: 'is_any_of', value: [].concat(outcome) });
    if (queueStatus) children.push({ field: 'queue_status', operator: 'is_any_of', value: [queueStatus] });
    children.push(...extra);
    const query = new URLSearchParams();
    if (tab) query.set('tab', tab);
    if (children.length) query.set('filter', JSON.stringify({ op: 'and', children }));
    if (sdrId) query.set('sdr', sdrId);
    // The dashboard's own date range, carried across so "3 Qualified this
    // week" opens the queue still scoped to this week — not the queue's own
    // default of every assignment ever. `/calling` reads `range`/`from`/`to`
    // exactly as the dashboard does (both go through resolveRange), so the
    // preset key needs no translation; 'all' is the queue's own unfiltered
    // default, so it is left off rather than sent as a preset nothing binds.
    if (range?.preset && range.preset !== 'all') {
        query.set('range', range.preset);
        if (range.preset === 'custom' && range.from) query.set('from', range.from);
        if (range.preset === 'custom' && range.to) query.set('to', range.to);
    }
    const qs = query.toString();
    return `/calling${qs ? `?${qs}` : ''}`;
}

/**
 * `callingHref`, as a per-row TEMPLATE for a `type: 'table'` widget.
 *
 * The filter is the same for every row in a column, so it is built once,
 * fully encoded, and only the SDR id is left as a literal placeholder the
 * browser fills in per row — the same mechanism `hrefTemplate:
 * '/calling?sdr={id}'` already uses (see `widgetTable` in
 * public/js/pages/dashboard.js). `sdrPlaceholder` matches whichever field
 * the row actually carries the SDR's id under — `sdr_performance` calls it
 * `id`, `calling_queue` calls it `bucket`.
 */
function callingHrefTemplate({ outcome = null, queueStatus = null, tab = null, extra = [], range = null } = {}, sdrPlaceholder = 'id') {
    const base = callingHref({ outcome, queueStatus, tab, extra, range });
    return `${base}${base.includes('?') ? '&' : '?'}sdr={${sdrPlaceholder}}`;
}

function ownerScope(ctx, options) {
    return options?.owner === 'me'
        ? [{ field: 'owner_id', operator: 'is_any_of', value: [ctx.userId] }]
        : [];
}

function closedInRange(ctx, range, status, stageId = null, scope = []) {
    return memo(
        ctx,
        `closed:${status}:${stageId ?? ''}:${range?.from ?? ''}:${range?.to ?? ''}:${JSON.stringify(scope)}`,
        () => closedInRangeUncached(ctx, range, status, stageId, scope),
    );
}

function closedInRangeUncached(ctx, range, status, stageId = null, scope = []) {
    const children = [{ field: 'status', operator: 'is_any_of', value: [status] }, ...scope];
    if (stageId) children.push({ field: 'stage_id', operator: 'is', value: stageId });

    /**
     * A coarse day filter in SQL, then the exact instants here.
     *
     * The filter compiler compares dates a whole UTC day at a time, and the
     * range's edges fall mid-day in UTC — 1 August in Riyadh begins at 21:00 on
     * 31 July. Widening to whole UTC days gives a SUPERSET, which the exact
     * comparison below then trims. Filtering only in SQL would be off by the
     * offset; filtering only here would fetch the whole history.
     */
    if (range?.from && range?.to) {
        children.push({
            field: 'closed_at',
            operator: 'between',
            value: [range.from.slice(0, 10), new Date(Date.parse(range.to) - 1).toISOString().slice(0, 10)],
        });
    }

    const page = listRecords('deal', ctx, {
        filter: { op: 'and', children },
        limit: CLOSED_LIMIT,
    });

    const records = page.records.filter((d) => {
        if (!d.closed_at) return false;
        if (range?.from && d.closed_at < range.from) return false;
        if (range?.to && d.closed_at >= range.to) return false;
        return true;
    });

    return { total: records.length, records, capped: page.total > CLOSED_LIMIT };
}

/**
 * Every call in the range, grouped once.
 *
 * The range is applied to `occurred_at` — when the call HAPPENED — and never to
 * the contact's dates or the assignment's. A contact assigned on the 1st and
 * rung on the 11th belongs to the 11th, and rung three times belongs to three
 * days. That is the whole reason a call is its own row.
 */
function callAggregate(ctx, range, { by = null } = {}) {
    const where = [`workspace_id = ?`, `type_key = 'call'`, 'deleted_at IS NULL'];
    const params = [ctx.workspaceId];
    if (range?.from) { where.push('occurred_at >= ?'); params.push(range.from); }
    if (range?.to) { where.push('occurred_at < ?'); params.push(range.to); }

    const group = by ? `${by}, outcome` : 'outcome';
    return all(
        `SELECT ${by ? `${by} AS bucket,` : ''} outcome, COUNT(*) AS calls,
                COUNT(DISTINCT parent_id) AS contacts
           FROM activities WHERE ${where.join(' AND ')}
          GROUP BY ${group}`,
        params,
    );
}

/** Unique contacts cannot be summed from a per-outcome grouping — asked separately. */
function uniqueContacts(ctx, range, { by = null } = {}) {
    const where = [`workspace_id = ?`, `type_key = 'call'`, 'deleted_at IS NULL'];
    const params = [ctx.workspaceId];
    if (range?.from) { where.push('occurred_at >= ?'); params.push(range.from); }
    if (range?.to) { where.push('occurred_at < ?'); params.push(range.to); }
    return all(
        `SELECT ${by ? `${by} AS bucket,` : `'all' AS bucket,`} COUNT(DISTINCT parent_id) AS contacts,
                COUNT(*) AS calls
           FROM activities WHERE ${where.join(' AND ')}
          ${by ? `GROUP BY ${by}` : ''}`,
        params,
    );
}

const CONVERSATION = new Set(
    CALL_OUTCOMES.filter((o) => o.conversation).map((o) => o.key),
);

/**
 * "Qualified", counted. `send_profile` is its own pipeline stage (see
 * `OUTCOME_STAGES` in lib/calling.mjs — a deal logged Send Profile moves to
 * the Send Profile stage, not Interested) but the two are the same FACT for
 * this reporting figure: the lead engaged and the SDR judged them worth
 * pursuing. Counting only `qualified` here made a rep who does the extra
 * step of sending a profile look less productive than one who does not,
 * on a number that is supposed to measure the opposite.
 */
const QUALIFIED_OUTCOMES = ['qualified', 'send_profile'];

function qualifiedCount(byOutcome) {
    return QUALIFIED_OUTCOMES.reduce((a, key) => a + (Number(byOutcome[key]) || 0), 0);
}

export const WIDGETS = {
    /**
     * Cold calling volume and outcomes for the selected period.
     *
     * Total calls and unique contacts are BOTH here, deliberately. One contact
     * rung four times is four calls and one contact, and a report that offers
     * only the first flatters effort while a report that offers only the second
     * hides it.
     */
    calling_activity: {
        label: 'Cold calling',
        description: 'Calls made in the selected range, and what came of them.',
        async run(ctx, options, range) {
            const rows = callAggregate(ctx, range);
            const totals = uniqueContacts(ctx, range)[0] ?? { calls: 0, contacts: 0 };
            const byOutcome = Object.fromEntries(rows.map((r) => [r.outcome, r.calls]));
            const conversations = rows
                .filter((r) => CONVERSATION.has(r.outcome))
                .reduce((a, r) => a + r.calls, 0);
            const calls = Number(totals.calls) || 0;

            const rate = (n) => (calls ? Math.round((n / calls) * 100) : null);

            /**
             * The queue as it stands — assigned, called, dead — for the contact
             * rate and the dead count.
             *
             * "Called" means MOVED OFF "ready to call" — `queue_status <>
             * 'queued'` — not "has a call logged against it, ever". Those used
             * to be the same test (`call_count > 0`), but they are not: a
             * manager can push an assignment back to `queued` with the bulk
             * status action (to re-attempt someone, say) without resetting
             * `call_count`, and that contact is exactly "ready to call" again
             * — counting it as contacted read the rate as higher than the list
             * actually was. A No answer, a follow-up, anything short of
             * completed still counts as worked; only still sitting on "ready
             * to call" does not.
             */
            const queue = get(
                `SELECT COUNT(*) AS assigned,
                        SUM(CASE WHEN queue_status != 'queued' THEN 1 ELSE 0 END) AS called,
                        SUM(CASE WHEN queue_status = 'dead' THEN 1 ELSE 0 END) AS dead
                   FROM calling_assignments a
                   JOIN contacts c ON c.id = a.contact_id AND c.deleted_at IS NULL
                  WHERE a.workspace_id = ? AND a.queue_status != 'removed'`,
                [ctx.workspaceId],
            ) ?? { assigned: 0, called: 0, dead: 0 };
            const assigned = Number(queue.assigned) || 0;
            const calledCount = Number(queue.called) || 0;
            const dead = Number(queue.dead) || 0;

            return {
                type: 'kpi_tiles',
                range,
                tiles: [
                    { label: 'Total calls', value: calls, help: 'Every attempt, including repeat calls to the same person.' },
                    { label: 'Unique contacts', value: Number(totals.contacts) || 0, help: 'People reached at least once. Four calls to one person counts once here.' },
                    { label: 'Assigned', value: assigned, help: 'Leads on the calling queue, as it stands now.' },
                    {
                        label: 'Dead leads', value: dead, tone: dead ? 'danger' : undefined,
                        help: 'Leads retired by the rules — three consecutive no answers, or the four-step follow-up sequence running out. As of now.',
                        href: callingHref({ queueStatus: 'dead' }),
                    },
                    // Qualified before Meetings scheduled, matching CALL_OUTCOMES
                    // and the SDR table below. Qualifying is what the call is
                    // FOR; a meeting is what follows from it.
                    {
                        label: 'Qualified', value: qualifiedCount(byOutcome), tone: 'success',
                        help: 'Calls that qualified the lead — Qualified or Send Profile — the step between a call and a meeting.',
                        href: callingHref({ outcome: QUALIFIED_OUTCOMES }),
                    },
                    {
                        label: 'Meetings scheduled', value: byOutcome.meeting_scheduled ?? 0, tone: 'success',
                        help: 'Meetings booked off the back of a qualifying call.',
                        href: callingHref({ outcome: 'meeting_scheduled' }),
                    },
                    { label: 'Qualify rate', value: rate(qualifiedCount(byOutcome)), suffix: '%', help: 'Qualified ÷ total calls.' },
                    { label: 'Meeting rate', value: rate(byOutcome.meeting_scheduled ?? 0), suffix: '%', help: 'Meetings scheduled ÷ total calls.' },
                    /**
                     * Contact rate FROM ASSIGNED, and No answer / Follow-up
                     * count as worked.
                     *
                     * This is the SDR table's Contact rate — how much of the
                     * list each rep was given has been dialled at least once.
                     * A No answer IS a call made, and a Follow-up IS a call
                     * made, so both are part of the numerator. "Contact rate"
                     * here means called ÷ assigned, not answered ÷ calls.
                     */
                    { label: 'Contact rate', value: assigned ? Math.round((calledCount / assigned) * 100) : null, suffix: '%', help: 'Moved off "ready to call" ÷ assigned. A No answer or a follow-up counts — it is work done, not a pick-up — but still sitting ready to call does not.' },
                    { label: 'Active call rate', value: rate(conversations), suffix: '%', help: 'Active calls ÷ total calls. An active call is one that reached somebody — not No answer, not Wrong number.' },
                    { label: 'Follow-ups', value: byOutcome.follow_up ?? 0, href: callingHref({ outcome: 'follow_up' }) },
                    { label: 'No answer', value: byOutcome.no_answer ?? 0, href: callingHref({ outcome: 'no_answer' }) },
                    { label: 'Not interested', value: byOutcome.not_interested ?? 0, href: callingHref({ outcome: 'not_interested' }) },
                    { label: 'Meetings done', value: byOutcome.meeting_done ?? 0, href: callingHref({ outcome: 'meeting_done' }) },
                ],
            };
        },
    },

    /** Who did what, in one query rather than one per person. */
    sdr_performance: {
        label: 'SDR performance',
        description: 'Calls, outcomes and conversion per SDR for the selected range.',
        async run(ctx, options, range) {
            const rows = callAggregate(ctx, range, { by: 'actor_id' });
            const uniques = new Map(
                uniqueContacts(ctx, range, { by: 'actor_id' }).map((r) => [r.bucket, r]),
            );
            const names = new Map(
                all('SELECT id, name FROM users').map((u) => [u.id, u.name]),
            );

            /**
            /**
             * The list each person was given, and how much of it they have rung.
             *
             * ── WHY THIS COUNTS EVERY ASSIGNMENT, NOT THE OPEN ONES ─────────
             *
             * It filtered on `active = 1`, so a contact left the count the
             * moment it was closed — and closing a contact is what WORKING one
             * looks like. An SDR who rang thirty of their hundred and closed
             * twenty of those was reported as ten called out of eighty
             * assigned. The denominator shrank as they worked, so the rate
             * climbed for reasons that had nothing to do with effort, and
             * "Assigned" did not mean the thing its name says.
             *
             * It now means what it says: the contacts assigned to that person.
             *
             * "Called" is `queue_status <> 'queued'` — moved off "ready to
             * call" — not `call_count > 0`. A No answer, a follow-up, or any
             * other outcome short of completed still counts; a lead a manager
             * has pushed back to `queued` (to re-attempt, say) does not, even
             * though `call_count` still remembers the earlier calls — "ready
             * to call" is exactly what it is again, and the rate should say so.
             *
             * Both figures are the queue AS IT STANDS, not within the range —
             * an assignment carries no date a range could scope it by, and the
             * note under the table says so.
             */
            const queues = new Map(
                all(
                    `SELECT assigned_to AS bucket,
                            COUNT(*) AS assigned,
                            SUM(CASE WHEN queue_status != 'queued' THEN 1 ELSE 0 END) AS called,
                            SUM(CASE WHEN queue_status = 'dead' THEN 1 ELSE 0 END) AS dead
                       FROM calling_assignments a
                       JOIN contacts c ON c.id = a.contact_id AND c.deleted_at IS NULL
                      WHERE a.workspace_id = ? AND a.assigned_to IS NOT NULL AND a.queue_status != 'removed'
                      GROUP BY a.assigned_to`,
                    [ctx.workspaceId],
                ).map((r) => [r.bucket, r]),
            );

            const people = new Map();
            for (const row of rows) {
                if (!people.has(row.bucket)) people.set(row.bucket, { outcomes: {}, calls: 0 });
                const entry = people.get(row.bucket);
                entry.outcomes[row.outcome] = row.calls;
                entry.calls += row.calls;
            }
            // Somebody holding a queue they have not started is exactly who a
            // manager is looking for, so they appear with a rate of 0 rather
            // than not appearing at all.
            for (const userId of queues.keys()) {
                if (!people.has(userId)) people.set(userId, { outcomes: {}, calls: 0 });
            }

            const sdrs = [...people.entries()].map(([userId, entry]) => {
                const conversations = Object.entries(entry.outcomes)
                    .filter(([key]) => CONVERSATION.has(key))
                    .reduce((a, [, n]) => a + n, 0);
                const queue = queues.get(userId);
                const assigned = Number(queue?.assigned) || 0;
                const called = Number(queue?.called) || 0;
                const dead = Number(queue?.dead) || 0;
                return {
                    id: userId,
                    name: names.get(userId) ?? 'Unknown',
                    assigned,
                    called,
                    dead,
                    calls: entry.calls,
                    contacts: Number(uniques.get(userId)?.contacts) || 0,
                    meetings: entry.outcomes.meeting_scheduled ?? 0,
                    qualified: qualifiedCount(entry.outcomes),
                    followUps: entry.outcomes.follow_up ?? 0,
                    noAnswer: entry.outcomes.no_answer ?? 0,
                    notInterested: entry.outcomes.not_interested ?? 0,
                    wrongNumber: entry.outcomes.wrong_number ?? 0,
                    // Of the list they were given, how much has been rung.
                    contactRate: assigned ? Math.round((called / assigned) * 100) : null,
                    /**
                     * Calls that reached somebody — everything except No Answer
                     * and Wrong Number.
                     *
                     * A count rather than the rate that used to sit here. A
                     * percentage answers "how well is the dialling going" and
                     * flatters a small sample: three calls, two answered, 67%
                     * reads better than thirty calls and twenty answered. The
                     * count is the work actually done, and Calls is beside it
                     * for whoever wants the ratio.
                     *
                     * Derived from the `conversation` flag on each outcome
                     * rather than a list of exclusions written out here, so a
                     * new outcome declares once whether it reached a person.
                     */
                    conversations,
                };
            }).sort((a, b) => (b.assigned - a.assigned) || (b.conversations - a.conversations));

            /**
             * One row answers for the whole table.
             *
             * Queue worked has no meaningful total (it is a ratio of two
             * counts that ARE summed), so the footer sums the raw counts and
             * recomputes it from the sums rather than adding percentages.
             * `called` stays on the row for exactly that — it is the ratio's
             * numerator, not a column anybody reads.
             */
            const totals = {
                name: 'Total',
                assigned: sdrs.reduce((a, r) => a + r.assigned, 0),
                called: sdrs.reduce((a, r) => a + r.called, 0),
                dead: sdrs.reduce((a, r) => a + r.dead, 0),
                calls: sdrs.reduce((a, r) => a + r.calls, 0),
                conversations: sdrs.reduce((a, r) => a + r.conversations, 0),
                contacts: sdrs.reduce((a, r) => a + r.contacts, 0),
                qualified: sdrs.reduce((a, r) => a + r.qualified, 0),
                meetings: sdrs.reduce((a, r) => a + r.meetings, 0),
                followUps: sdrs.reduce((a, r) => a + r.followUps, 0),
                noAnswer: sdrs.reduce((a, r) => a + r.noAnswer, 0),
                notInterested: sdrs.reduce((a, r) => a + r.notInterested, 0),
                wrongNumber: sdrs.reduce((a, r) => a + r.wrongNumber, 0),
            };
            totals.contactRate = totals.assigned
                ? Math.round((totals.called / totals.assigned) * 100)
                : null;

            return {
                type: 'table',
                range,
                /**
                 * ── WHAT WAS WRONG WITH THIS ROW OF HEADINGS ────────────────
                 *
                 * "Called" and "Calls" sat two columns apart, one letter apart,
                 * meaning different things over different periods: Called was
                 * how many ASSIGNED leads had ever been rung, Calls was how many
                 * calls were made IN THE SELECTED RANGE. Nobody reading a table
                 * distinguishes those from the headings, and the note at the
                 * bottom had to apologise for the exception.
                 *
                 * Worse, "Contact rate" appeared HERE as called ÷ assigned and
                 * again in the tiles above as conversations ÷ calls — one name,
                 * two formulas, one screen. Whichever a manager had in mind,
                 * half the dashboard was answering the other question.
                 *
                 * So: Called is gone, because "Assigned 100, 40% worked" says
                 * it without a third column; the ratio is named for what it
                 * measures; and the period columns say plainly what they count.
                 */
                /**
                 * SIX COLUMNS, SIX DIFFERENT QUESTIONS.
                 *
                 * They read as repetitive because five of them are counts of
                 * people or calls, so the names have to carry the difference —
                 * and renaming them to be distinct only made them unfamiliar.
                 * These are the business's own words, each with the definition
                 * on the heading and all six spelled out under the table:
                 *
                 *   Assigned         contacts on this person's list
                 *   Contact rate     how many of them have been rung, as a %
                 *   Dead             retired off that list — three no answers, or the sequence ran out
                 *   Calls made       calls, including repeat calls to one person
                 *   Active calls     calls that reached somebody
                 *   Unique contacts  people behind those calls, counted once each
                 *
                 * The first three describe the LIST and ignore the date range;
                 * the last three describe the PERIOD.
                 */
                columns: [
                    { key: 'name', label: 'SDR' },
                    {
                        key: 'assigned', label: 'Assigned', numeric: true,
                        help: 'Contacts assigned to this person. The whole list, whatever has since happened to it.',
                    },
                    {
                        key: 'contactRate', label: 'Contact rate', numeric: true, suffix: '%',
                        help: 'How much of that list has moved off "ready to call" — no answer, follow-up, or anything else short of still waiting — ÷ assigned.',
                    },
                    {
                        key: 'dead', label: 'Dead', numeric: true,
                        help: 'Leads on this person’s list retired by the rules — three consecutive no answers, or the four-step follow-up sequence running out. As it stands now, not scoped to the period.',
                    },
                    {
                        key: 'conversations', label: 'Active calls', numeric: true,
                        help: 'Calls that reached somebody — everything except No answer and Wrong number.',
                    },
                    {
                        key: 'contacts', label: 'Unique contacts', numeric: true,
                        help: 'The people behind those calls. Four calls to one person is one.',
                    },
                    // Qualified before Meetings: qualifying is what the call is
                    // FOR, and a meeting is what follows from it. The table
                    // reads in the order the work happens.
                    { key: 'qualified', label: 'Qualified', numeric: true },
                    { key: 'meetings', label: 'Meetings', numeric: true },
                    { key: 'followUps', label: 'Follow-ups', numeric: true },
                    { key: 'noAnswer', label: 'No answer', numeric: true },
                    { key: 'notInterested', label: 'Not interested', numeric: true },
                    { key: 'wrongNumber', label: 'Wrong number', numeric: true },
                ],
                rows: sdrs,
                totals,
                /**
                 * A TEMPLATE, not a function.
                 *
                 * This crosses to the browser as JSON, and `JSON.stringify`
                 * drops a function without a word — so `href: (row) => …`
                 * arrived as `undefined` and the name column has never been
                 * a link on any widget that sent one. `{key}` is filled from
                 * the row; a row missing that key renders as plain text
                 * rather than a link to nowhere.
                 */
                hrefTemplate: '/calling?sdr={id}',
                /**
                 * Per-column links, for the outcome counts specifically —
                 * "3 No answer by Lara" opens the queue already filtered to
                 * Lara's leads whose last outcome is No answer, rather than
                 * making the reader rebuild that filter by hand. Only the
                 * columns that map to one queue field get one: Assigned,
                 * Contact rate, Calls made, Active calls and Unique contacts
                 * are each a mix of several outcomes (or none), and a filter
                 * that quietly showed the wrong rows would be worse than a
                 * plain number.
                 */
                columnHrefTemplates: {
                    // Dead ignores the date range (see the note below — an
                    // assignment carries no date to scope it by), so the
                    // link does too: sending a range here would filter the
                    // list to fewer rows than the number above it counts.
                    dead: callingHrefTemplate({ queueStatus: 'dead' }),
                    qualified: callingHrefTemplate({ outcome: QUALIFIED_OUTCOMES, range }),
                    meetings: callingHrefTemplate({ outcome: 'meeting_scheduled', range }),
                    followUps: callingHrefTemplate({ outcome: 'follow_up', range }),
                    noAnswer: callingHrefTemplate({ outcome: 'no_answer', range }),
                    notInterested: callingHrefTemplate({ outcome: 'not_interested', range }),
                    wrongNumber: callingHrefTemplate({ outcome: 'wrong_number', range }),
                },
                // The same columns' TOTAL row, unscoped by SDR — "Total No
                // answer" shows every No answer lead, not one person's.
                columnHrefs: {
                    dead: callingHref({ queueStatus: 'dead' }),
                    qualified: callingHref({ outcome: QUALIFIED_OUTCOMES, range }),
                    meetings: callingHref({ outcome: 'meeting_scheduled', range }),
                    followUps: callingHref({ outcome: 'follow_up', range }),
                    noAnswer: callingHref({ outcome: 'no_answer', range }),
                    notInterested: callingHref({ outcome: 'not_interested', range }),
                    wrongNumber: callingHref({ outcome: 'wrong_number', range }),
                },
                note: 'Assigned is the contacts on this person’s list, Contact rate is how many of them '
                    + 'have moved off "ready to call" — a No answer or a follow-up counts, still waiting does not '
                    + '— and Dead is how many the rules have retired — all three '
                    + 'describe the list as it stands, and ignore the date range, because an assignment carries '
                    + 'no date to scope it by. The rest count the selected period: Active calls are the ones that reached somebody (everything except No '
                    + 'answer and Wrong number), and Unique contacts counts each person once however often they '
                    + 'were rung.',
                emptyNote: 'Nobody holds a calling queue, and no calls were made in this period.',
            };
        },
    },

    /** Your Team calling, filtered to you — exact same table as sdr_performance, one row. */
    my_calling: {
        label: 'My calling',
        description: 'Your cold calling performance for the selected range — same columns as Team calling, only your queue.',
        async run(ctx, options, range) {
            const names = new Map(all('SELECT id, name FROM users').map((u) => [u.id, u.name]));
            const myId = ctx.userId;

            // Calls/metrics scoped to you and to the selected range (the range
            // is period-scoped; the queue counts below are current-state and
            // intentionally ignore the range — same as Team calling).
            const whereActs = ['workspace_id = ?', `type_key = 'call'`, 'deleted_at IS NULL', 'actor_id = ?'];
            const paramsActs = [ctx.workspaceId, myId];
            if (range?.from) { whereActs.push('occurred_at >= ?'); paramsActs.push(range.from); }
            if (range?.to) { whereActs.push('occurred_at < ?'); paramsActs.push(range.to); }
            const rows = all(
                `SELECT outcome, COUNT(*) AS calls, COUNT(DISTINCT parent_id) AS contacts
                   FROM activities WHERE ${whereActs.join(' AND ')} GROUP BY outcome`,
                paramsActs,
            );
            const unique = get(
                `SELECT COUNT(DISTINCT parent_id) AS contacts, COUNT(*) AS calls
                   FROM activities WHERE ${whereActs.join(' AND ')}`,
                paramsActs,
            ) ?? { contacts: 0, calls: 0 };

            // "Called" is `queue_status <> 'queued'` — see the identical
            // comment on the Team calling query above.
            const queue = get(
                `SELECT COUNT(*) AS assigned,
                        SUM(CASE WHEN queue_status != 'queued' THEN 1 ELSE 0 END) AS called,
                        SUM(CASE WHEN queue_status = 'dead' THEN 1 ELSE 0 END) AS dead
                   FROM calling_assignments a
                   JOIN contacts c ON c.id = a.contact_id AND c.deleted_at IS NULL
                  WHERE a.workspace_id = ? AND a.assigned_to = ? AND a.queue_status != 'removed'`,
                [ctx.workspaceId, myId],
            ) ?? { assigned: 0, called: 0, dead: 0 };

            const byOutcome = Object.fromEntries(rows.map((r) => [r.outcome, r.calls]));
            const conversations = rows.filter((r) => CONVERSATION.has(r.outcome)).reduce((a, r) => a + r.calls, 0);
            const assigned = Number(queue.assigned) || 0;
            const called = Number(queue.called) || 0;
            const dead = Number(queue.dead) || 0;
            const contacts = Number(unique.contacts) || 0;
            const calls = Number(unique.calls) || 0;

            const me = {
                id: myId,
                name: names.get(myId) ?? 'You',
                assigned,
                called,
                dead,
                calls,
                contacts,
                meetings: byOutcome.meeting_scheduled ?? 0,
                qualified: qualifiedCount(byOutcome),
                followUps: byOutcome.follow_up ?? 0,
                noAnswer: byOutcome.no_answer ?? 0,
                notInterested: byOutcome.not_interested ?? 0,
                wrongNumber: byOutcome.wrong_number ?? 0,
                contactRate: assigned ? Math.round((called / assigned) * 100) : null,
                conversations,
            };

            const totals = { ...me, name: 'Total' };

            return {
                type: 'table',
                range,
                columns: [
                    { key: 'name', label: 'SDR' },
                    { key: 'assigned', label: 'Assigned', numeric: true, help: 'Contacts assigned to you. The whole list, whatever has since happened to it.' },
                    { key: 'contactRate', label: 'Contact rate', numeric: true, suffix: '%', help: 'How much of that list has moved off "ready to call" ÷ assigned.' },
                    { key: 'dead', label: 'Dead', numeric: true, help: 'Leads on your list retired by the rules — three consecutive no answers, or the four-step follow-up sequence running out. As it stands now, not scoped to the period.' },
                    { key: 'conversations', label: 'Active calls', numeric: true, help: 'Calls that reached somebody — everything except No answer and Wrong number.' },
                    { key: 'contacts', label: 'Unique contacts', numeric: true, help: 'The people behind those calls. Four calls to one person is one.' },
                    { key: 'qualified', label: 'Qualified', numeric: true },
                    { key: 'meetings', label: 'Meetings', numeric: true },
                    { key: 'followUps', label: 'Follow-ups', numeric: true },
                    { key: 'noAnswer', label: 'No answer', numeric: true },
                    { key: 'notInterested', label: 'Not interested', numeric: true },
                    { key: 'wrongNumber', label: 'Wrong number', numeric: true },
                ],
                rows: assigned || contacts || conversations ? [me] : [],
                totals: assigned || contacts || conversations ? totals : { name: 'Total', assigned: 0, contactRate: null, dead: 0, conversations: 0, contacts: 0, qualified: 0, meetings: 0, followUps: 0, noAnswer: 0, notInterested: 0, wrongNumber: 0 },
                hrefTemplate: '/calling?sdr={id}',
                columnHrefTemplates: {
                    dead: callingHrefTemplate({ queueStatus: 'dead' }),
                    qualified: callingHrefTemplate({ outcome: QUALIFIED_OUTCOMES }),
                    meetings: callingHrefTemplate({ outcome: 'meeting_scheduled' }),
                    followUps: callingHrefTemplate({ outcome: 'follow_up' }),
                    noAnswer: callingHrefTemplate({ outcome: 'no_answer' }),
                    notInterested: callingHrefTemplate({ outcome: 'not_interested' }),
                    wrongNumber: callingHrefTemplate({ outcome: 'wrong_number' }),
                },
                columnHrefs: {
                    dead: callingHref({ queueStatus: 'dead' }),
                    qualified: callingHref({ outcome: QUALIFIED_OUTCOMES }),
                    meetings: callingHref({ outcome: 'meeting_scheduled' }),
                    followUps: callingHref({ outcome: 'follow_up' }),
                    noAnswer: callingHref({ outcome: 'no_answer' }),
                    notInterested: callingHref({ outcome: 'not_interested' }),
                    wrongNumber: callingHref({ outcome: 'wrong_number' }),
                },
                note: 'Assigned is the contacts on your list, Contact rate is how many of them have moved off "ready to call" — a No answer or a follow-up counts, still waiting does not — and Dead is how many the rules have retired — all three describe the list as it stands, and ignore the date range, because an assignment carries no date to scope it by. The rest count the selected period: Active calls are the ones that reached somebody (everything except No answer and Wrong number), and Unique contacts counts each person once however often they were rung.',
                emptyNote: 'You hold no calling queue and made no calls in this period.',
            };
        },
    },

    /**
     * The queue as it stands, which is a CURRENT fact and ignores the range —
     * "how many are still to call" cannot be asked of last March.
     */
    calling_queue: {
        label: 'Calling queue',
        description: 'What is assigned, worked and still waiting, per SDR.',
        async run(ctx) {
            /**
             * "Still to call" — matches the queue's own To call tab
             * (lib/calling.mjs TABS.to_call): a lead most recently Qualified
             * or Meeting-Scheduled is real progress, not a call still owed,
             * even though the assignment itself is still 'working'.
             */
            const stamp = now();
            const rows = all(
                `SELECT a.assigned_to AS bucket, u.name AS name,
                        COUNT(*) AS assigned,
                        SUM(CASE WHEN a.queue_status IN ('done','closed') THEN 1 ELSE 0 END) AS completed,
                        SUM(CASE WHEN a.queue_status IN ('queued','working')
                                  AND (a.last_outcome IS NULL OR a.last_outcome IN ('no_answer','follow_up'))
                                  THEN 1 ELSE 0 END) AS remaining,
                        SUM(CASE WHEN a.call_count = 0 THEN 1 ELSE 0 END) AS never_called,
                        SUM(CASE WHEN a.queue_status IN ('queued','working')
                                  AND a.next_follow_up_at IS NOT NULL AND a.next_follow_up_at < ? THEN 1 ELSE 0 END) AS overdue
                   FROM calling_assignments a
                   JOIN contacts c ON c.id = a.contact_id AND c.deleted_at IS NULL
                   LEFT JOIN users u ON u.id = a.assigned_to
                  WHERE a.workspace_id = ? AND a.queue_status != 'removed'
                  GROUP BY a.assigned_to, u.name
                  ORDER BY remaining DESC`,
                [stamp, ctx.workspaceId],
            );

            return {
                type: 'table',
                columns: [
                    { key: 'name', label: 'SDR' },
                    { key: 'assigned', label: 'Assigned', numeric: true },
                    { key: 'completed', label: 'Worked', numeric: true },
                    { key: 'remaining', label: 'Remaining', numeric: true },
                    { key: 'never_called', label: 'Never called', numeric: true },
                    { key: 'overdue', label: 'Overdue follow-ups', numeric: true },
                ],
                rows: rows.map((r) => ({ ...r, name: r.name ?? 'Unassigned' })),
                totals: {
                    name: 'Total',
                    assigned: rows.reduce((a, r) => a + r.assigned, 0),
                    completed: rows.reduce((a, r) => a + r.completed, 0),
                    remaining: rows.reduce((a, r) => a + r.remaining, 0),
                    never_called: rows.reduce((a, r) => a + r.never_called, 0),
                    overdue: rows.reduce((a, r) => a + r.overdue, 0),
                },
                hrefTemplate: '/calling?sdr={bucket}',
                // Same per-column click-through as the SDR performance table
                // beside it — "12 overdue for Sarah" opens exactly that list
                // instead of asking the reader to rebuild the filter by hand.
                columnHrefTemplates: {
                    completed: callingHrefTemplate({ tab: 'completed' }, 'bucket'),
                    remaining: callingHrefTemplate({ tab: 'to_call' }, 'bucket'),
                    never_called: callingHrefTemplate(
                        { tab: 'to_call', extra: [{ field: 'call_count', operator: 'eq', value: 0 }] }, 'bucket',
                    ),
                    overdue: callingHrefTemplate(
                        { tab: 'follow_ups', extra: [{ field: 'next_follow_up_at', operator: 'before', value: stamp }] }, 'bucket',
                    ),
                },
                columnHrefs: {
                    completed: callingHref({ tab: 'completed' }),
                    remaining: callingHref({ tab: 'to_call' }),
                    never_called: callingHref({ tab: 'to_call', extra: [{ field: 'call_count', operator: 'eq', value: 0 }] }),
                    overdue: callingHref({
                        tab: 'follow_ups', extra: [{ field: 'next_follow_up_at', operator: 'before', value: stamp }],
                    }),
                },
                emptyNote: 'Nothing is on a calling queue yet.',
                note: 'Where the queue stands now. Not affected by the date range above.',
            };
        },
    },

    /**
     * Deals won in the selected period.
     *
     * The one widget on this dashboard that answers "how did we do", rather
     * than "where are we". Lost sits beside it deliberately: a won count with
     * no denominator is a number that only ever goes up.
     */
    /**
     * What the wins were WORTH. The counting is `win_rate`'s job.
     *
     * ── WHY THESE TWO STOPPED OVERLAPPING ───────────────────────────────────
     *
     * They both sat on the manager, admin, owner and workspace layouts, and
     * between them repeated four figures out of seven: "Win rate" twice with
     * the same formula and the same help text, and the same count of won deals
     * under two labels ("Deals won" here, "Won" there). Two cards, a scroll
     * apart, disagreeing about nothing and asking to be read twice.
     *
     * So each answers one question now. This one is money — hence `money: true`
     * and the finance gate — and `win_rate` is counts and a percentage, which
     * is why a rep may have it and not this.
     */
    deals_won: {
        label: 'Won, in money',
        description: 'What the deals closed as won inside the selected range were worth.',
        money: true,
        async run(ctx, options, range, reporting) {
            const scope = ownerScope(ctx, options);
            const won = closedInRange(ctx, range, 'won', null, scope);
            // Priced as of the day each deal actually closed — see `dealAtClose` —
            // so a later re-quote cannot rewrite what a past period reportedly won.
            const wonAtClose = won.records.map((d) => dealAtClose(ctx, d));
            const value = aggregateInReporting(wonAtClose, reporting.rates);

            /**
             * An average over ONE-TIME value only, and it says so.
             *
             * There is no honest average "deal size" across a book that mixes
             * placement fees with monthly retainers — the two are not the same
             * kind of number, which is the rule this whole file is built on.
             */
            const oneTimeDeals = wonAtClose.filter((d) => (Number(d.own_one_time) || 0) > 0);
            /**
             * The average's own numerator, not `value.one_time` above.
             *
             * `value` aggregates EVERY won deal in the period, including any
             * with zero or negative one-time value (a credit/adjustment) —
             * `oneTimeDeals` deliberately excludes those from the count. Using
             * `value.one_time / oneTimeDeals.length` divided a total that
             * still included the excluded deals' (negative) contribution by a
             * count that did not, understating the average whenever both
             * kinds of deal closed in the same period.
             */
            const oneTimeValue = aggregateInReporting(oneTimeDeals, reporting.rates).one_time;

            return {
                type: 'kpi_tiles',
                range,
                // The figures above were converted; the label has to agree with
                // them, or the screen reports dollars under a SAR heading.
                currency: reporting.currency,
                tiles: [
                    {
                        label: 'Won, one-time', value: value.one_time, money: true, tone: 'success',
                        help: 'Placement and fixed fees. Never added to the figure beside it.',
                    },
                    {
                        label: 'Won, per month', value: value.mrr, money: true, tone: 'success',
                        help: 'Recurring value of what was won. A month of it, not a year.',
                    },
                    {
                        label: 'Won, annualised recurring', value: value.arr, money: true,
                        help: 'The monthly figure beside this, times twelve.',
                    },
                    {
                        label: 'Average one-time deal', value: oneTimeDeals.length
                            ? Math.round(oneTimeValue / oneTimeDeals.length)
                            : null,
                        money: true,
                        help: oneTimeDeals.length
                            ? `Across the ${oneTimeDeals.length} won deal(s) with one-time value. Recurring deals are `
                              + 'excluded — averaging a fee and a retainer produces a number with no meaning.'
                            : 'No won deal in this period carried one-time value.',
                    },
                ],
                note: won.capped
                    ? `More than ${CLOSED_LIMIT} deals closed in this period; the figures cover the most recent ${CLOSED_LIMIT}.`
                    : 'How MANY were won, and against how many lost, is the Win rate card.',
            };
        },
    },

    /**
     * The prospecting funnel — everything BEFORE the CRM.
     *
     * Deliberately separate from every commercial widget on this dashboard.
     * Qualification is preprocessing: a company sitting in REVIEW is not a
     * negotiation, and showing the two in one funnel is how a pipeline review
     * ends up discussing 200 unqualified rows. These counts answer "is the
     * intake healthy?", not "how is the quarter going?".
     */
    /**
     * Intake is one event and five states.
     *
     * How many companies were UPLOADED in the period is a question about
     * `created_at`. Where they have got to since is not: a company uploaded in
     * March and rejected in August is rejected now, and reporting it under March
     * would be inventing a history the table does not keep.
     */
    prospecting_funnel: {
        label: 'Prospecting intake',
        description: 'Companies uploaded in the period, and where the whole pile stands now.',
        // The sourcing book. Refused to a role without `prospecting.read`,
        // whichever layout named it — see `dashboardData`.
        prospecting: true,
        async run(ctx, options, range) {
            const rows = all(
                /**
                 * `imported` is counted even though the row is soft-deleted.
                 *
                 * Importing a company RETIRES it from prospecting — the row is
                 * marked deleted so it leaves every list, which is what "gone
                 * from prospecting" means (see lib/promotion.mjs). But "how
                 * many did we import" is a real question about the funnel, and
                 * filtering those rows out would answer it with nought and make
                 * the funnel look like nothing ever leaves it.
                 *
                 * Only that status. A prospect somebody deleted by hand is
                 * deleted, and does not belong in any of these counts.
                 */
                `SELECT status, COUNT(*) AS n FROM prospecting_companies
                  WHERE workspace_id = ? AND (deleted_at IS NULL OR status = 'imported')
                  GROUP BY status`,
                [ctx.workspaceId],
            );
            const by = new Map(rows.map((r) => [r.status, r.n]));
            const total = rows.reduce((a, r) => a + r.n, 0);
            // Not `countInRange` — its WHERE always requires `deleted_at IS
            // NULL`, which drops every row this widget's own "imported"
            // exception (above) exists to keep. A company uploaded and
            // imported within the SAME range was showing up in "Prospects on
            // file" and "Imported into CRM" but silently missing from
            // "Uploaded" — the funnel's own top-of-funnel tile undercounting
            // its own funnel.
            const uploadedWhere = ['workspace_id = ?', "(deleted_at IS NULL OR status = 'imported')"];
            const uploadedParams = [ctx.workspaceId];
            if (range?.from) { uploadedWhere.push('created_at >= ?'); uploadedParams.push(range.from); }
            if (range?.to) { uploadedWhere.push('created_at < ?'); uploadedParams.push(range.to); }
            const uploaded = get(
                `SELECT COUNT(*) AS n FROM prospecting_companies WHERE ${uploadedWhere.join(' AND ')}`,
                uploadedParams,
            )?.n ?? 0;
            return {
                type: 'kpi_tiles',
                range,
                tiles: [
                    {
                        label: 'Uploaded', value: uploaded,
                        href: '/uploads', help: 'Companies that arrived in this period.',
                    },
                    { label: 'Prospects on file', value: total, help: `Every company ever uploaded and still on file. ${AS_OF_NOW}` },
                    { label: 'Qualification queue', value: (by.get('uploaded') ?? 0) + (by.get('qualifying') ?? 0), help: `Waiting for, or currently running, qualification. ${AS_OF_NOW}` },
                    { label: 'Qualified — ready to import', value: by.get('qualified') ?? 0, tone: 'success', href: '/prospects', help: `Passed a rule and not yet imported. ${AS_OF_NOW}` },
                    { label: 'Review required', value: by.get('review_required') ?? 0, tone: 'warning', href: '/qualification?tab=review', help: `The evidence could not answer the question. A queue to work, not a rejection. ${AS_OF_NOW}` },
                    { label: 'Rejected', value: by.get('rejected') ?? 0, help: `The evidence proved the rule was not met. ${AS_OF_NOW}` },
                    { label: 'Imported into CRM', value: by.get('imported') ?? 0, help: 'Now Accounts, being worked — and retired from prospecting, so they no longer appear in the lists above.' },
                ],
            };
        },
    },

    /**
     * The commercial snapshot: what the business actually has on right now.
     */
    /**
     * Two kinds of number, kept apart on purpose.
     *
     * WHAT HAPPENED in the selected period — added, created, logged — each read
     * from the timestamp that metric actually means. And WHAT IS ON right now:
     * open deals and the money in them, which no range can scope, because the
     * database records what is open today and never recorded what was open in
     * March. Those tiles say so rather than silently ignoring the picker.
     */
    crm_snapshot: {
        label: 'CRM at a glance',
        description: 'What was added in the selected period, and what the business has on right now.',
        money: true,
        async run(ctx, options, range, reporting) {
            const one = (sql, args = []) => get(sql, [ctx.workspaceId, ...args])?.n ?? 0;
            /**
             * Seven counts, one round trip. See `countsInRange`.
             *
             * These were seven separate `countInRange` calls made while
             * building the tile list, so they were seven blocking waits before
             * the widget could return — on the widget that sits at the top of
             * the dashboard and is therefore the one everybody waits for.
             */
            const counts = countsInRange(ctx, [
                ['accounts', 'accounts', 'created_at'],
                ['contacts', 'contacts', 'created_at'],
                ['deals', 'deals', 'created_at'],
                ['proposals', 'proposals', 'created_at'],
                ['agreements', 'agreements', 'created_at'],
                /**
                 * Meetings scoped and counted the same way as every other
                 * meeting number on this dashboard (meeting_analytics, the
                 * top-summary "Meetings scheduled" tile): by `meeting_at`,
                 * the meeting's own date — never by `occurred_at`, which is
                 * when the CALL that booked it was logged, and never by
                 * `type_key = 'meeting'`, a separate, rarely-used manual
                 * note type that has nothing to do with a booked meeting.
                 * Three different numbers answering what reads as the same
                 * question, on the same screen, is worse than one that is
                 * merely differently-scoped and says so.
                 */
                ['meetings', 'activities', 'meeting_at', 'meeting_at IS NOT NULL'],
            ], range);

            /**
             * "Tasks due" means DUE — `due_at <= now` — not "due sometime
             * inside whichever period is selected".
             *
             * It used to ride the same period-window machinery as "Deals
             * created" and friends: any open task whose `due_at` fell
             * anywhere in "This month" counted, so a follow-up due next week
             * or a WhatsApp step due tomorrow both counted as "due" today.
             * Clicking the tile then landed on the plain Tasks list, which
             * doesn't apply that window either — three different sets of
             * rows for one number. `status <> 'done'` was the other half of
             * the same bug: a cancelled task with a past due date still
             * counted. Scoped and filtered to match `href` exactly below.
             */
            // Captured once so the count and the destination filter below
            // compare against the exact same instant — two calls to `now()`
            // a few lines apart is two different cutoffs.
            const dueStamp = now();
            const tasksDue = get(
                `SELECT COUNT(*) AS n FROM tasks
                  WHERE workspace_id = ? AND deleted_at IS NULL AND status IN ('open','in_progress')
                    AND due_at IS NOT NULL AND due_at <= ?`,
                [ctx.workspaceId, dueStamp],
            )?.n ?? 0;

            // Shared with the pipeline-value widget below and with the
            // forecast, which all want exactly this set. See `openDeals`.
            const open = openDeals(ctx, options);

            /**
             * Pipeline value uses only signed-ready deals (excluding contracting).
             * Deals with unsigned agreements are visible in kanban and forecasting
             * but do not count as pipeline revenue until signed.
             */
            const pipeline = pipelineDeals(ctx, options);
            const pipelineTotals = aggregateInReporting(pipeline.records, reporting.rates);

            /**
             * A forecast is what is BANKED plus what is still expected TO
             * CLOSE IN THIS PERIOD — not every open deal regardless of when
             * it is expected to close.
             *
             * Won-in-range at full value, plus open deals whose `close_date`
             * falls inside the selected range, via `splitDealsByCloseDate` —
             * the same function the board's "next 90 days" forecast uses, so
             * the two never quietly disagree about which deals count. No
             * probability weighting either way.
             *
             * Open deals with no close date, or one outside this range, are
             * real pipeline but are not a claim about THIS period — they are
             * reported separately as `unscheduledOpen` rather than silently
             * included or silently dropped.
             */
            const { dated: expectedOpen, undated: unscheduledOpen } = splitDealsByCloseDate(
                open.records, { from: range.from, to: range.to },
            );
            const expected = aggregateInReporting(expectedOpen, reporting.rates);
            const unscheduled = aggregateInReporting(unscheduledOpen, reporting.rates);
            const wonSoFar = aggregateInReporting(closedInRange(ctx, range, 'won').records, reporting.rates);
            const forecastOneTime = round2(wonSoFar.one_time + expected.one_time);
            const forecastMrr = round2(wonSoFar.mrr + expected.mrr);

            return {
                type: 'kpi_tiles',
                currency: reporting.currency,
                range,
                tiles: [
                    /* ---- what happened in the period, each on its own clock ---- */
                    {
                        label: 'Accounts added', value: counts.accounts, href: '/accounts',
                        help: 'Created in this period. Import date, not the date the company was founded or scraped.',
                    },
                    {
                        label: 'Contacts added', value: counts.contacts, href: '/contacts',
                        help: 'Created in this period.',
                    },
                    {
                        label: 'Deals created', value: counts.deals, href: '/deals',
                        help: 'Opened in this period, whatever has become of them since. '
                            + 'Deals WON in the period are their own widget — a different question and a different date.',
                    },
                    {
                        label: 'Proposals created', value: counts.proposals, href: '/proposals',
                        help: 'One per document produced. A second version is a second proposal.',
                    },
                    {
                        label: 'Agreements created', value: counts.agreements, href: '/agreements',
                        help: 'When the contract was produced. Signing is a separate date and a separate question.',
                    },
                    {
                        label: 'Meetings', value: counts.meetings, href: '/activities',
                        help: 'When the meeting happened, not when somebody got round to logging it.',
                    },
                    {
                        label: 'Tasks due', value: tasksDue,
                        tone: 'warning',
                        // The exact same predicate the count above ran, down to
                        // the instant: `at_or_before` compares the timestamp
                        // as given rather than widening to the whole day (see
                        // `lib/query.mjs`), so a task due later today cannot
                        // appear here before it is actually due.
                        href: `/tasks?filter=${encodeURIComponent(JSON.stringify({
                            op: 'and',
                            children: [
                                { field: 'status', operator: 'is_any_of', value: ['open', 'in_progress'] },
                                { field: 'due_at', operator: 'at_or_before', value: dueStamp },
                            ],
                        }))}`,
                        help: 'Open, with a due date that has already arrived — not merely sometime in this period. '
                            + 'Ignores the range picker above; a task due now is due now regardless of the window selected.',
                    },

                    /* ---- and what is on right now, which no range can scope ---- */
                    { label: 'CRM accounts', value: one('SELECT COUNT(*) AS n FROM accounts WHERE workspace_id = ? AND deleted_at IS NULL'), href: '/accounts', help: AS_OF_NOW },
                    { label: 'Open deals', value: open.total, href: '/deals', help: AS_OF_NOW },
                    /**
                     * "Pipeline" here means what is still OPEN and not yet
                     * won — deliberately distinct from "Won, per month" in
                     * the What Closed section below, which is the recurring
                     * value of deals actually closed-won in this period.
                     * Labelled "Open pipeline" rather than bare "Pipeline"
                     * so the two are never read as the same question: an
                     * open pipeline of $0 recurring is a true, separate fact
                     * from having won nothing this month.
                     */
                    { label: 'Open pipeline, one-time', value: pipelineTotals.one_time, money: true, help: `Open deals excluding unsigned agreements — not yet won. ${AS_OF_NOW}` },
                    { label: 'Open pipeline, per month', value: pipelineTotals.mrr, money: true, help: `Recurring value of open deals excluding unsigned agreements — not yet won. See "Won, per month" below for closed business. ${AS_OF_NOW}` },
                    {
                        label: 'Forecast, one-time', value: forecastOneTime, money: true,
                        help: 'Won in this period at full value, plus open deals expected to close in this '
                            + 'period at full value. Deals expected to close in a different period, or with no '
                            + 'expected close date, are excluded — see the note below and "Open pipeline" above '
                            + 'for the full total.',
                    },
                    {
                        label: 'Forecast, per month', value: forecastMrr, money: true,
                        help: 'The same calculation for recurring value. Never added to the one-time figure '
                            + 'beside it — a placement fee and 24 months of retainer are not one number.',
                    },
                ],
                note: (unscheduledOpen.length || unscheduled.one_time || unscheduled.mrr)
                    ? `${unscheduledOpen.length} open deal(s) worth ${unscheduled.one_time} one-time `
                      + `and ${unscheduled.mrr}/month have no expected close date and are not counted in either `
                      + 'Forecast tile — they are real pipeline, just undated. See "Open pipeline" above for the full total.'
                    : undefined,
            };
        },
    },

    /**
     * Win rate over CLOSED deals only.
     *
     * The denominator is won + lost, never won + everything-in-flight. A deal
     * still being worked has not been lost, and counting it as one makes the
     * number drift down all quarter and jump every time the pipeline is tidied.
     */
    win_rate: {
        label: 'Win rate',
        description: 'Won against lost, over deals that closed inside the range.',
        async run(ctx, options, range) {
            const scope = ownerScope(ctx, options);
            const won = closedInRange(ctx, range, 'won', null, scope);
            const lost = closedInRange(ctx, range, 'lost', null, scope);
            const closed = won.total + lost.total;

            // Still-open is a CURRENT count and says so. It cannot be scoped to
            // a past range — a deal open today was not necessarily open then,
            // and the database keeps no history of that.
            const stillOpen = get(
                `SELECT COUNT(*) AS n FROM deals
                  WHERE workspace_id = ? AND deleted_at IS NULL AND status = 'open'
                        ${scope.length ? 'AND owner_id = ?' : ''}`,
                scope.length ? [ctx.workspaceId, ctx.userId] : [ctx.workspaceId],
            )?.n ?? 0;

            return {
                type: 'kpi_tiles',
                range,
                tiles: [
                    {
                        label: 'Win rate', value: closed ? Math.round((won.total / closed) * 100) : null, suffix: '%', tone: 'success',
                        help: closed ? `${won.total} won of ${closed} closed in this period.` : 'Nothing closed in this period.',
                    },
                    { label: 'Won', value: won.total, tone: 'success' },
                    { label: 'Lost', value: lost.total },
                    { label: 'Still open', value: stillOpen, help: 'Open right now, whatever the range — not part of the rate.' },
                ],
            };
        },
    },

    deals_by_service: {
        label: 'Deals by service',
        description: 'Open deals split by service line.',
        async run(ctx) {
            const rows = all(
                `SELECT COALESCE(NULLIF(TRIM(service_line_key), ''), 'unassigned') AS k, COUNT(*) AS n
                   FROM deals
                  WHERE workspace_id = ? AND deleted_at IS NULL AND status = 'open'
                  GROUP BY k ORDER BY n DESC`,
                [ctx.workspaceId],
            );
            const labels = new Map(
                all('SELECT key, label FROM service_lines WHERE workspace_id = ?', [ctx.workspaceId])
                    .map((r) => [r.key, r.label]),
            );
            return {
                type: 'bars',
                bars: rows.map((r) => ({ label: labels.get(r.k) ?? r.k, count: r.n })),
                total: rows.reduce((a, r) => a + r.n, 0),
                note: 'Open deals by service line.',
                emptyNote: 'No open deals yet.',
            };
        },
    },

    /**
     * Egypt against Regional — the split the business actually reports on.
     *
     * `account_type` describes itself, on the field, as "the commercial
     * grouping the dashboard reports by". Nothing on the dashboard grouped by
     * it, so the promise was made on the record and never kept on the screen.
     *
     * It groups DEALS by the type of the account behind them, because the
     * question is "how is Egypt doing", not "how many Egyptian companies are on
     * file" — and it counts open deals, matching `deals_by_service` beside it
     * so the two bars can be read as one pair.
     *
     * Accounts whose type nobody has set are shown rather than dropped. A
     * silently omitted bucket is how a split stops adding up to the total and
     * nobody notices for a quarter.
     */
    deals_by_account_type: {
        label: 'Egypt vs Regional',
        description: 'Open deals split by the account type behind them.',
        async run(ctx) {
            const rows = all(
                `SELECT COALESCE(NULLIF(TRIM(a.account_type), ''), 'Unassigned') AS k, COUNT(*) AS n
                   FROM deals d
                   LEFT JOIN accounts a ON a.id = d.account_id
                  WHERE d.workspace_id = ? AND d.deleted_at IS NULL AND d.status = 'open'
                  GROUP BY k ORDER BY n DESC`,
                [ctx.workspaceId],
            );
            return {
                type: 'bars',
                bars: rows.map((r) => ({ label: r.k, count: r.n })),
                total: rows.reduce((a, r) => a + r.n, 0),
                note: 'Open deals by the commercial grouping of their account. Not the country — a company '
                    + 'registered anywhere can be either.',
                emptyNote: 'No open deals yet.',
            };
        },
    },

    /**
     * Egypt and Regional performance, service by service, against target.
     *
     * The screen the business actually asked for: what each side of the
     * business won, per service, in one currency, next to what it was aiming at.
     *
     * ── WHAT IS COMPARED, AND WHY IT IS TCV ─────────────────────────────────
     *
     * A target is one number. This file's cardinal rule is that one-time and
     * recurring are never summed into a headline figure, so "one-time + MRR"
     * cannot be what a target is measured against. Total contract value is the
     * one combined figure this codebase sanctions — it says so in its name and
     * carries the term it assumed — so attainment is TCV against target, and
     * one-time and recurring are reported separately beside it rather than
     * folded in.
     *
     * Every figure is converted to USD by each deal's OWN currency before it is
     * added to anything, so an EGP deal and a SAR deal in the same cell are
     * comparable. A deal whose currency has no rate is counted as unconvertible
     * and reported, never quietly treated as dollars.
     *
     * ── WHAT IS COUNTED ─────────────────────────────────────────────────────
     *
     * Deals WON inside the selected range, by `closed_at` — a target is about
     * what was landed in a period, and the range picker drives it. Accounts
     * whose type nobody has set appear under "Unassigned" rather than being
     * dropped: a split that silently stops adding up to the total is how a
     * quarter goes by before anybody notices.
     */
    service_performance: {
        label: 'Performance by account type and service',
        description: 'What Egypt and Regional won per service in the period, in USD, against target.',
        money: true,
        async run(ctx, options, range, reporting) {
            const services = all(
                'SELECT key, label FROM service_lines WHERE workspace_id = ? ORDER BY position',
                [ctx.workspaceId],
            );
            const targets = new Map(
                all('SELECT account_type, service_line_key, target_amount FROM service_targets WHERE workspace_id = ?',
                    [ctx.workspaceId]).map((r) => [`${r.account_type}:${r.service_line_key}`, r.target_amount]),
            );

            const won = closedInRange(ctx, range, 'won');
            // The account type behind each deal, in one query rather than one
            // per deal.
            const accountIds = [...new Set(won.records.map((d) => d.account_id).filter(Boolean))];
            const types = new Map();
            for (let i = 0; i < accountIds.length; i += 400) {
                const chunk = accountIds.slice(i, i + 400);
                for (const row of all(
                    `SELECT id, account_type FROM accounts WHERE id IN (${chunk.map(() => '?').join(',')})`,
                    chunk,
                )) types.set(row.id, row.account_type);
            }

            const UNASSIGNED = 'Unassigned';
            const bucket = new Map();
            const key = (type, service) => `${type}:${service}`;
            for (const deal of won.records) {
                const type = types.get(deal.account_id) || UNASSIGNED;
                const service = deal.service_line_key || 'unassigned';
                const k = key(type, service);
                if (!bucket.has(k)) bucket.set(k, []);
                bucket.get(k).push(deal);
            }

            /**
             * Egypt and Regional are the columns. "Unassigned" is not one.
             *
             * It used to be, on the reasoning that a split which stops adding
             * up to the total is how a quarter goes by before anybody notices.
             * That reasoning was right about the risk and wrong about the
             * remedy: what it actually produced was a permanent third column of
             * "$0 / —" next to the two that carry the business, and a column of
             * dashes is read as a broken widget, not as a prompt.
             *
             * The fact still cannot go missing — it moves to a line under the
             * table, which appears only when there is something to say. A count
             * of unclassified deals is a sentence somebody acts on; an empty
             * column is furniture.
             */
            const seenTypes = new Set([
                ...ACCOUNT_TYPES,
                ...[...bucket.keys()].map((k) => k.split(':')[0]),
                ...[...targets.keys()].map((k) => k.split(':')[0]),
            ]);
            seenTypes.delete(UNASSIGNED);
            const accountTypes = [...seenTypes];

            // What the columns above therefore do NOT include.
            const strayDeals = [...bucket.entries()]
                .filter(([k]) => k.split(':')[0] === UNASSIGNED)
                .flatMap(([, deals]) => deals);
            const stray = aggregateInReporting(strayDeals, reporting.rates);

            const rows = services.map((service) => ({
                service: service.key,
                label: service.label,
                cells: accountTypes.map((accountType) => {
                    const deals = bucket.get(key(accountType, service.key)) ?? [];
                    const totals = aggregateInReporting(deals, reporting.rates);
                    const target = targets.get(`${accountType}:${service.key}`) ?? null;
                    return {
                        accountType,
                        count: deals.length,
                        one_time: totals.one_time,
                        mrr: totals.mrr,
                        tcv: totals.tcv,
                        unconvertible: totals.unconvertible,
                        target,
                        // Null, not 0%, when nobody set a target. They are
                        // different statements and only one is a judgement.
                        attainment: target > 0 ? Math.round((totals.tcv / target) * 100) : null,
                    };
                }),
            }));

            return {
                type: 'service_matrix',
                range,
                currency: reporting.currency,
                accountTypes,
                rows,
                /**
                 * Deals the columns above cannot account for, because nobody
                 * has said whether their account is Egypt or Regional.
                 *
                 * Null when there are none, so the client has nothing to draw
                 * on a normal day.
                 */
                unassigned: strayDeals.length
                    ? { count: strayDeals.length, tcv: stray.tcv }
                    : null,
                capped: won.capped,
                note: 'Won in this period, converted to USD by each deal’s own currency. Attainment compares '
                    + 'total contract value against target; one-time and recurring are shown separately because '
                    + 'they are not the same kind of money.',
            };
        },
    },

    verdict_distribution: {
        label: 'Qualification verdicts',
        description: 'Current verdict per rule. Always shows all three answers.',
        prospecting: true,
        async run(ctx) {
            const tally = verdictTally(ctx.workspaceId);
            return {
                type: 'verdict_bars',
                rules: Object.entries(tally).map(([key, counts]) => ({
                    rule: key,
                    label: counts.label ?? key,
                    summary: counts.summary ?? '',
                    version: counts.version ?? 1,
                    // Fixed order, all buckets present even at zero.
                    buckets: VERDICTS.map((v) => ({ verdict: v, count: counts[v] ?? 0 })),
                    total: VERDICTS.reduce((a, v) => a + (counts[v] ?? 0), 0),
                })),
                note: 'REVIEW means the evidence could not answer the question. It is a queue to work, not a rejection.',
            };
        },
    },

    lifecycle_funnel: {
        label: 'Account lifecycle',
        description: 'How many accounts sit at each lifecycle stage.',
        async run(ctx) {
            const rows = all(
                `SELECT lifecycle_stage, COUNT(*) AS n FROM accounts
                  WHERE workspace_id = ? AND deleted_at IS NULL GROUP BY lifecycle_stage`,
                [ctx.workspaceId],
            );
            const counts = new Map(rows.map((r) => [r.lifecycle_stage, r.n]));
            return {
                type: 'funnel',
                stages: LIFECYCLE_STAGES.map((stage) => ({ stage, count: counts.get(stage) ?? 0 })),
                total: rows.reduce((a, r) => a + r.n, 0),
            };
        },
    },

    pipeline_value: {
        label: 'Open pipeline',
        description: 'One-time and recurring value of open deals, excluding unsigned agreements.',
        money: true,
        async run(ctx, options, range, reporting) {
            const pipeline = pipelineDeals(ctx, options);
            const totals = aggregateInReporting(pipeline.records, reporting.rates);
            return {
                type: 'money_pair',
                currency: reporting.currency,
                count: pipeline.total,
                // Two headline figures. There is deliberately no third one
                // adding them together.
                figures: [
                    { label: 'One-time', value: totals.one_time, help: 'Placement fees and fixed-fee work.' },
                    { label: 'Recurring, per month', value: totals.mrr, help: 'Seats and headcount retainers.' },
                    { label: 'Annualised recurring', value: totals.arr, help: 'MRR × 12.' },
                ],
            };
        },
    },

    pipeline_by_stage: {
        label: 'Deals by stage',
        description: 'Deals per stage, including the won and lost columns, as the board shows them.',
        money: true,
        async run(ctx, options, range, reporting) {
            const pipeline = options.pipelineId
                ? get('SELECT * FROM pipelines WHERE id = ? AND workspace_id = ?', [options.pipelineId, ctx.workspaceId])
                : get('SELECT * FROM pipelines WHERE workspace_id = ? ORDER BY is_default DESC, position LIMIT 1', [ctx.workspaceId]);
            if (!pipeline) return { type: 'stage_bars', stages: [], pipeline: null };

            const stages = all('SELECT * FROM stages WHERE pipeline_id = ? ORDER BY position', [pipeline.id]);

            /**
             * ONE read for the whole pipeline, grouped here.
             *
             * This loop used to call `listRecords` once per stage: a count and
             * a page of rows each, plus hydration, thirteen times over. Against
             * the local file that is free; against Turso every statement is a
             * blocking round trip, so the single most-looked-at widget on the
             * dashboard cost twenty-six of them before it drew anything, and
             * the board below it cost twenty-six more for the same rows.
             *
             * The filter is the union of what the loop asked for — every deal
             * in this pipeline that is open, won or lost — and the grouping is
             * a `Map`, which is not a thing worth a network round trip.
             *
             * The limit is per PIPELINE now rather than per stage, so it is
             * raised to match, and truncation is reported rather than silently
             * changing what the totals mean.
             */
            const PIPELINE_CAP = 2000;
            const page = listRecords('deal', ctx, {
                filter: {
                    op: 'and',
                    children: [
                        { field: 'pipeline_id', operator: 'is', value: pipeline.id },
                        { field: 'status', operator: 'is_any_of', value: ['open', 'won', 'lost'] },
                        ...ownerScope(ctx, options),
                    ],
                },
                limit: PIPELINE_CAP,
            });

            const byStage = new Map();
            for (const deal of page.records) {
                if (!byStage.has(deal.stage_id)) byStage.set(deal.stage_id, []);
                byStage.get(deal.stage_id).push(deal);
            }

            const out = [];
            for (const stage of stages) {
                /**
                 * Won and lost stages were skipped entirely, so "Deal Won"
                 * existed in the pipeline and appeared nowhere — a stage you
                 * can move a deal into and then never see again.
                 *
                 * They are reported, but kept apart from the open stages and
                 * out of their total. A deal already won is not forecast
                 * revenue; adding it to the pipeline would inflate the one
                 * number this widget exists to give honestly.
                 */
                const closed = stage.type === 'won' || stage.type === 'lost';
                if (!closed && stage.type !== 'open') continue;

                /**
                 * Every stage is read the same way: what is sitting in it now.
                 *
                 * Won and lost were scoped to the selected range while the open
                 * stages showed the present. That is defensible when they are
                 * separated and labelled, and misleading the moment they are
                 * shown as ordinary stages — the same column of numbers would
                 * have meant "now" on nine rows and "this month" on two.
                 *
                 * So this widget is current state throughout, which is also what
                 * the board shows. "How many did we win this month" is the Deals
                 * won widget's question, and it follows the range properly.
                 *
                 * A won deal carries status 'won', not 'open', which is why the
                 * status has to follow the stage's own type.
                 */
                const wanted = closed ? stage.type : 'open';
                const deals = (byStage.get(stage.id) ?? []).filter((d) => d.status === wanted);
                out.push({
                    stage: stage.label,
                    // So the bar chart can tell a Won or Lost stage apart
                    // from an open one — see stageBars in
                    // public/js/pages/dashboard.js, which uses this to keep
                    // closed deals out of the denominator every open bar's
                    // width is a percentage of.
                    type: stage.type,
                    count: deals.length,
                    ...aggregateInReporting(deals, reporting.rates),
                });
            }
            return {
                type: 'stage_bars',
                pipeline: pipeline.label,
                stages: out,
                currency: reporting.currency,
                // Said rather than hidden: a capped read makes every figure
                // below it a floor, and a reader has to know which it is.
                truncated: page.total > page.records.length
                    ? { shown: page.records.length, total: page.total }
                    : null,
            };
        },
    },

    my_tasks: {
        label: 'My tasks',
        description: 'Open tasks assigned to you, overdue first.',
        async run(ctx) {
            const page = listRecords('task', ctx, {
                filter: {
                    op: 'and',
                    children: [
                        { field: 'assignee_id', operator: 'is_any_of', value: [ctx.userId] },
                        { field: 'status', operator: 'is_any_of', value: ['open', 'in_progress'] },
                    ],
                },
                sort: [{ field: 'due_at', direction: 'asc' }],
                limit: 20,
            });
            const nowMs = Date.now();
            return {
                type: 'task_list',
                total: page.total,
                // Overdue is computed against the viewer's clock, not the
                // server's — a task due 5pm Riyadh is not overdue at 3pm Riyadh
                // because the server is in UTC.
                overdue: page.records.filter((t) => t.due_at && new Date(t.due_at).getTime() < nowMs).length,
                tasks: page.records.map((t) => ({
                    id: t.id, title: t.title, dueAt: t.due_at, priority: t.priority,
                    accountId: t.account_id, accountName: t.account_name,
                    overdue: !!t.due_at && new Date(t.due_at).getTime() < nowMs,
                })),
            };
        },
    },

    stale_verdicts: {
        label: 'Ageing verdicts',
        description: 'Verdicts older than the workspace freshness threshold.',
        prospecting: true,
        async run(ctx) {
            const days = ctx.workspace.verdictStaleDays;
            const rows = all(
                `SELECT v.rule_key, v.verdict, v.computed_at, a.id, a.name
                   FROM verdicts v JOIN accounts a ON a.id = v.account_id AND a.deleted_at IS NULL
                  WHERE v.workspace_id = ? AND v.is_current = 1 AND v.verdict IN ('QUALIFIED','REVIEW')
                  ORDER BY v.computed_at ASC LIMIT 500`,
                [ctx.workspaceId],
            );
            const stale = rows.filter((r) => isStale(r.computed_at, days));
            return {
                type: 'stale_list',
                thresholdDays: days,
                staleCount: stale.length,
                total: rows.length,
                // Counted AND named. "12 are ageing" is a statistic; the names
                // are what someone acts on.
                oldest: stale.slice(0, 8).map((r) => ({
                    accountId: r.id, name: r.name, rule: r.rule_key, verdict: r.verdict,
                    computedAt: r.computed_at,
                    ageDays: Math.floor((Date.now() - new Date(r.computed_at).getTime()) / 864e5),
                })),
                note: 'A two-year-old QUALIFIED is not a lead. Re-run the rule, or re-collect the evidence.',
            };
        },
    },

    activity_volume: {
        label: 'Activity',
        description: 'Logged activities per type over a window.',
        async run(ctx, options, range) {
            // Follows the dashboard's range rather than its own `days` option,
            // so "activity" and "deals won" describe the same period. A layout
            // still carrying days: 30 is simply ignored.
            const where = ['workspace_id = ?', 'deleted_at IS NULL'];
            const params = [ctx.workspaceId];
            if (range?.from) { where.push('occurred_at >= ?'); params.push(range.from); }
            if (range?.to) { where.push('occurred_at < ?'); params.push(range.to); }
            const rows = all(
                `SELECT type_key, COUNT(*) AS n FROM activities
                  WHERE ${where.join(' AND ')}
                  GROUP BY type_key ORDER BY n DESC`,
                params,
            );
            const labels = new Map(
                all('SELECT key, label FROM activity_types WHERE workspace_id = ?', [ctx.workspaceId]).map((t) => [t.key, t.label]),
            );
            return {
                type: 'bars',
                range,
                total: rows.reduce((a, r) => a + r.n, 0),
                bars: rows.map((r) => ({ label: labels.get(r.type_key) ?? r.type_key, count: r.n })),
            };
        },
    },

    renewals: {
        label: 'Renewals & notice dates',
        description: 'Signed agreements whose notice date falls inside the window.',
        async run(ctx, options) {
            const days = Math.max(1, Number(options.days) || 90);
            const rows = all(
                `SELECT a.id, a.number, a.title, a.expiry_date, a.notice_days, a.renewable, a.contract_value, a.currency,
                        ac.name AS account_name, ac.owner_id AS account_owner_id
                   FROM agreements a JOIN accounts ac ON ac.id = a.account_id
                  WHERE a.workspace_id = ? AND a.deleted_at IS NULL AND a.status IN ('signed','expired','terminated')`,
                [ctx.workspaceId],
            );
            const signedDated = rows.filter((r) => r.expiry_date);
            // A fixed-term engagement ending for good (`renewable = 0`) raises
            // no notice task (lib/renewals.mjs) and is excluded from the
            // Renewals page (api/proposals.mjs) — this widget listed it
            // under "Notice due" and folded its value into the renewing
            // totals anyway, the one caller the sibling fixes missed.
            const enriched = signedDated.filter((r) => r.status !== 'terminated' && r.status !== 'expired' && r.renewable !== 0).map((r) => {
                const expiry = new Date(r.expiry_date).getTime();
                const noticeAt = expiry - (r.notice_days || 0) * 864e5;
                const daysToNotice = Math.ceil((noticeAt - Date.now()) / 864e5);
                const daysToExpiry = Math.ceil((expiry - Date.now()) / 864e5);
                return {
                    ...r,
                    noticeDate: new Date(noticeAt).toISOString().slice(0, 10),
                    daysToNotice,
                    daysToExpiry,
                    // Same rule as the Renewals page (api/proposals.mjs) — the
                    // notice date is when the window OPENS, not a deadline, so
                    // `daysToNotice < 0` alone means "in the window", not
                    // "missed". Only past the agreement's own expiry is it
                    // actually overdue. See that file's fuller comment.
                    inNoticePeriod: daysToNotice <= 0 && daysToExpiry > 0,
                    noticePassed: daysToExpiry <= 0,
                };
            }).filter((r) => r.daysToNotice <= days).sort((a, b) => a.daysToNotice - b.daysToNotice);

            /**
             * Renewing Soon, bucketed by days-to-NOTICE — same clock the
             * widget's own note (and the rest of this product) sorts by. A
             * 90-day notice on a 12-month contract is due in month nine, so
             * bucketing by days-to-expiry instead put it three months later
             * than the decision actually falls, and left agreements with a
             * near notice date but a far expiry out of every bucket.
             */
            const buckets = { d0_30: 0, d31_45: 0, d46_90: 0 };
            const valueByCurrency = {}; // renewing within 90 days, one total per currency — never summed across them
            for (const r of enriched) {
                if (r.daysToNotice < 0 || r.daysToNotice > 90) continue;
                if (r.daysToNotice <= 30) buckets.d0_30 += 1;
                else if (r.daysToNotice <= 45) buckets.d31_45 += 1;
                else buckets.d46_90 += 1;
                if (r.contract_value) {
                    const cur = r.currency ?? 'USD';
                    valueByCurrency[cur] = (valueByCurrency[cur] ?? 0) + Number(r.contract_value);
                }
            }

            const expiredCount = rows.filter((r) => r.status === 'expired'
                || (r.status === 'signed' && r.expiry_date && new Date(r.expiry_date).getTime() < Date.now())).length;
            const supersededIds = new Set(
                all('SELECT supersedes_agreement_id AS id FROM agreements WHERE workspace_id = ? AND supersedes_agreement_id IS NOT NULL', [ctx.workspaceId])
                    .map((r) => r.id),
            );

            return {
                type: 'renewal_list',
                windowDays: days,
                agreements: enriched.slice(0, 10),
                total: enriched.length,
                inNoticePeriod: enriched.filter((r) => r.inNoticePeriod).length,
                overdue: enriched.filter((r) => r.noticePassed).length,
                buckets,
                expiredCount,
                terminatedCount: rows.filter((r) => r.status === 'terminated').length,
                renewedCount: rows.filter((r) => supersededIds.has(r.id)).length,
                valueByCurrency,
                note: 'Sorted by NOTICE date, not expiry. A 90-day notice on a 12-month contract means the '
                    + 'decision point is month nine.',
            };
        },
    },

    recent_verdict_changes: {
        label: 'Verdicts that changed',
        description: 'Accounts whose verdict moved inside the period, and why.',
        prospecting: true,
        async run(ctx, options, range) {
            const limit = Math.min(50, Number(options.limit) || 12);
            // A verdict change is an event, dated by when it was computed. The
            // window is the dashboard's, so this list and the numbers above it
            // describe the same stretch of time.
            const where = ['e.workspace_id = ?', "e.action = 'verdict_computed'"];
            const params = [ctx.workspaceId];
            if (range?.from) { where.push('e.created_at >= ?'); params.push(range.from); }
            if (range?.to) { where.push('e.created_at < ?'); params.push(range.to); }
            const rows = all(
                `SELECT e.*, a.name AS account_name FROM audit_events e
                   LEFT JOIN accounts a ON a.id = e.account_id
                  WHERE ${where.join(' AND ')}
                  ORDER BY e.created_at DESC LIMIT ?`,
                [...params, limit * 4],
            );
            const changes = [];
            for (const row of rows) {
                const before = json(row.before, null);
                const after = json(row.after, {});
                if (!before?.verdict || before.verdict === after.verdict) continue;
                changes.push({
                    accountId: row.account_id,
                    accountName: row.account_name,
                    rule: after.rule_key,
                    from: before.verdict,
                    to: after.verdict,
                    ruleVersion: after.rule_version,
                    // The transition that costs money: an account someone was
                    // told to call, now told not to.
                    dangerous: before.verdict === 'QUALIFIED' && after.verdict !== 'QUALIFIED',
                    at: row.created_at,
                });
                if (changes.length >= limit) break;
            }
            return {
                type: 'change_list', changes, range,
                note: changes.length ? null : 'No verdict changed in this period.',
            };
        },
    },

    /**
     * Meetings, the way the sales floor talks about them.
     *
     * A meeting is one fact with its own date (`activities.meeting_at`) and its
     * own state (`activities.meeting_status`), and the only honest show rate is
     * Done / (Done + No Show). The tiles lead with that rate, because the funnel
     * collapses without it: a month can be full of meetings nobody has turned up
     * to and the screen says nothing if the rate is not front and centre.
     *
     * ── WHY THIS WIDGET EXISTS SEPARATELY ───────────────────────────────
     *
     * `calling_activity` already reports meetings SCHEDULED off the back of a
     * call — but it cannot tell you any of the things a floor asks next: did the
     * one booked for Tuesday happen, is the week's rate good, who is carrying
     * meetings that still need classifying. This is the meetings-only view; it
     * is where "how did our meetings go" gets answered instead of inferred from
     * call outcomes.
     *
     * ── WHY THE RATE IS `null` INSTEAD OF `0%` ───────────────────────────
     *
     * A team whose meetings are all still to come has not shown a 0% show rate,
     * and a dashboard that says 0% is making an accusation the data cannot
     * support. `null` reads as "—" until a meeting resolves into Done or No
     * Show. See `lib/meetings.mjs` for the rule.
     */
    meeting_analytics: {
        label: 'Meeting analytics',
        description: 'Meetings held in the selected range, by outcome and by person, with the show rate that ties them together.',
        async run(ctx, options, range) {
            const sdrId = range?.person ?? null;
            const stats = meetingStats(ctx, {
                from: range?.from ?? null,
                to: range?.to ?? null,
                sdrId,
                nowIso: now(),
            });
            const t = stats.totals;

            /**
             * The headline figures come from the SUMS, so the per-person rows and
             * the total row can never disagree, and the show rate is computed from
             * the aggregate Done + No Show rather than averaged from the rows.
             */
            const tiles = [
                {
                    label: 'Scheduled', value: t.scheduled, tone: 'primary',
                    help: 'Meetings booked to happen in the selected range. Before its time an upcoming meeting reads here too.',
                },
                {
                    label: 'Done', value: t.done, tone: 'success',
                    help: 'Meetings that happened. The numerator of show rate.',
                },
                {
                    label: 'No show', value: t.noShow, tone: 'danger',
                    help: 'Meetings whose time came and the prospect did not. The other half of the denominator.',
                },
                {
                    label: 'Upcoming', value: t.upcoming, tone: 'warning',
                    help: 'Scheduled meetings that have not happened yet. They stay outside show rate until they resolve.',
                },
                /**
                 * Front and centre because a funnel without its conversion sits
                 * there looking like it could be anything. `tone: 'strong'` makes
                 * the renderer draw it as the headline it is.
                 */
                {
                    label: 'Show rate', value: t.showRate, suffix: '%',
                    tone: t.showRate === null ? undefined : 'strong',
                    help: 'Done ÷ (Done + No Show). Null until at least one meeting resolves — a team whose meetings are all still to come is not failing to show up.',
                },
            ];

            /**
             * Names resolved in one query, so a row whose person has left is still
             * readable instead of a blank. Unclassified meetings sit on a row of
             * their own so "nobody has said yet" is visible rather than lost in a
             * null bucket.
             */
            const names = new Map(
                // Membership is the workspace link — `users` has no workspace_id
                // of its own, and asking it for one threw on every read.
                all(`SELECT u.id, u.name FROM users u
                       JOIN memberships m ON m.user_id = u.id AND m.workspace_id = ?`,
                [ctx.workspaceId]).map((u) => [u.id, u.name]),
            );

            const rows = [...stats.byPerson.entries()].map(([personKey, row]) => ({
                id: row.id,
                name: row.id ? (names.get(row.id) ?? 'Unknown') : (personKey === 'unassigned' ? 'Unassigned' : String(personKey)),
                scheduled: row.scheduled,
                done: row.done,
                noShow: row.noShow,
                upcoming: row.upcoming,
                unclassified: row.unclassified,
                showRate: row.showRate,
            })).sort((a, b) => (b.scheduled - a.scheduled) || (String(a.name).localeCompare(String(b.name))));

            /**
             * A name with no meetings and no queue still owns a row — the table
             * has to answer "did they have any" as clearly as "they had them".
             */
            if (sdrId) {
                const exists = rows.find((r) => r.id === sdrId);
                if (!exists) {
                    rows.push({
                        id: sdrId, name: names.get(sdrId) ?? 'Unknown',
                        scheduled: 0, done: 0, noShow: 0, upcoming: 0, unclassified: 0, showRate: null,
                    });
                }
            }

            return {
                type: 'meeting_analytics',
                range,
                tiles,
                table: {
                    columns: [
                        { key: 'name', label: 'SDR' },
                        { key: 'scheduled', label: 'Scheduled', numeric: true, help: 'Meetings booked in this period.' },
                        { key: 'done', label: 'Done', numeric: true, tone: 'success', help: 'Met and marked done.' },
                        { key: 'noShow', label: 'No show', numeric: true, tone: 'danger', help: 'Time came, they did not.' },
                        { key: 'upcoming', label: 'Upcoming', numeric: true, tone: 'warning', help: 'Scheduled and not yet happened.' },
                        { key: 'unclassified', label: 'Unclassified', numeric: true, tone: 'warning', help: 'Past its time, still not marked done or no-show.' },
                        {
                            key: 'showRate', label: 'Show rate', numeric: true, suffix: '%',
                            help: 'Done ÷ (Done + No Show) for this person.',
                        },
                    ],
                    rows,
                    totals: {
                        name: 'Total',
                        scheduled: t.scheduled,
                        done: t.done,
                        noShow: t.noShow,
                        upcoming: t.upcoming,
                        unclassified: t.unclassified,
                        showRate: t.showRate,
                    },
                    /**
                     * Drilling into a person's meetings opens the rep's Cold Calling
                     * queue — the same `?sdr=` they are used to seeing on every other
                     * per-person table on this dashboard.
                     */
                    hrefTemplate: '/calling?sdr={id}',
                    emptyNote: 'No meetings are booked in this period.',
                    note: 'Meetings are counted by `meeting_at` — the day they were held, '
                        + 'not the day they were booked or classified. Show rate is Done ÷ (Done + No Show) '
                        + 'and reads as "—" until a meeting resolves; it never punishes a team for booking ahead.',
                },
            };
        },
    },
};

/* ---------------------------------------------------------- attention ---- */

/**
 * NEEDS ATTENTION - four counts, each naming where the work lives.
 *
 * The dashboard answers "what is happening"; this band answers "what needs
 * ME". Every count links to its source so the click IS the next action, and
 * every scope follows the reader: an SDR sees their own floor numbers, a
 * manager sees the team's, and approvals only count where the reader can
 * actually act on them.
 */
export async function attention({ ctx, url }) {
    const stamp = now();
    const canApprove = can(ctx, 'document.approve') || can(ctx, 'record.write.all');

    /**
     * Everyone's, unconditionally — not scoped to the reader like the tiles
     * beside it.
     *
     * "Overdue tasks" answers "is anything slipping", and that answer must
     * not shrink to whoever happens to be looking. The reader's OWN overdue
     * tasks are a separate, genuinely personal list — the `my_tasks` widget,
     * which stays scoped to `assignee_id = ctx.userId` regardless of role;
     * this tile is the team-wide count beside it.
     */
    const overdue = get(
        `SELECT COUNT(*) AS n FROM tasks
          WHERE workspace_id = ? AND deleted_at IS NULL AND status IN ('open','in_progress')
            AND due_at IS NOT NULL AND due_at < ?`,
        [ctx.workspaceId, stamp],
    )?.n ?? 0;

    /**
     * "On you" means it — `openApprovalTask` (lib/approvals.mjs) writes ONE
     * task per approving role, each with its own `assignee_id`, precisely so
     * this can be personal rather than "every open approval in the workspace".
     * Two people holding the approval capability each see their OWN pending
     * count, not each other's; whichever of them decides first still closes
     * every copy (`closeApprovalTask`), so nothing here weakens that.
     */
    const approvals = canApprove
        ? get(
            `SELECT COUNT(DISTINCT t.parent_id) AS n FROM tasks t
              WHERE t.workspace_id = ? AND t.deleted_at IS NULL AND t.status = 'open'
                AND t.parent_type IN ('proposal','agreement','deal_price','contact_reassign') AND t.assignee_id = ?`,
            [ctx.workspaceId, ctx.userId],
        )?.n ?? 0
        : 0;

    /**
     * `next_follow_up_at` also holds a MEETING's time when the last outcome
     * was Meeting Scheduled (see `nextAt` in `logCall`, lib/calling.mjs) —
     * that path never starts the four-step sequence, so without this guard
     * a scheduled meeting whose time arrives counted as "a follow-up due"
     * here while the destination (the `follow_ups` tab, which requires
     * exactly this) correctly never showed it.
     */
    const followUps = get(
        `SELECT COUNT(*) AS n FROM calling_assignments
          WHERE workspace_id = ? AND active = 1 AND queue_status IN ('queued','working')
            AND next_follow_up_at IS NOT NULL AND next_follow_up_at <= ?
            AND sequence_started_at IS NOT NULL AND sequence_completed_at IS NULL AND dead_at IS NULL
            ${can(ctx, 'calling.manage') ? '' : ' AND assigned_to = ?'}`,
        can(ctx, 'calling.manage') ? [ctx.workspaceId, stamp] : [ctx.workspaceId, stamp, ctx.userId],
    )?.n ?? 0;

    /**
     * Meetings scheduled in the reader's chosen period — Today, Week, Month or a
     * custom span, the same presets the dashboard's own range picker offers.
     * "Retired leads this week" used to sit here; that count is dead weight for
     * the reader's day, so it moved into the Team calling table as a per-SDR
     * column and this slot answers a question worth acting on instead.
     */
    const range = resolveRange(
        {
            preset: url.searchParams.get('range') ?? undefined,
            from: url.searchParams.get('from') ?? undefined,
            to: url.searchParams.get('to') ?? undefined,
        },
        { timeZone: ctx.workspace.timezone || 'UTC', weekendDays: ctx.workspace.weekendDays },
    );
    const meetingsScheduled = countInRange(
        ctx, 'activities', 'occurred_at', range,
        "type_key = 'call' AND outcome = 'meeting_scheduled'",
    );

    /**
     * `tone` says whether a non-zero count is bad news or good news —
     * everything on this band used to turn the same red the instant its
     * count left zero, so a healthy "3 meetings scheduled" read exactly
     * like "3 tasks slipping". Only the three actionable/overdue tiles are
     * warnings; a scheduled meeting is what this whole dashboard is for.
     */
    /**
     * `/my-work?tab=tasks` is a personal work QUEUE, not this count's
     * destination: it shows every open task assigned to the viewer sorted by
     * due date — including the ones due next week — because that is the right
     * default for a page somebody lands on to see "what's mine". Clicking
     * "N overdue" and landing there showed the whole queue, overdue or not,
     * which is real work but not the N rows that were counted.
     *
     * `/tasks?filter=...` is the same generic list `crm_snapshot`'s "Tasks
     * due" tile already links to, filtered to EXACTLY the predicate `overdue`
     * above ran — status open/in_progress, `due_at` at or before this same
     * instant. It replaces `/my-work` here rather than teaching that page a
     * second filtered mode.
     */
    const overdueHref = `/tasks?filter=${encodeURIComponent(JSON.stringify({
        op: 'and',
        children: [
            { field: 'status', operator: 'is_any_of', value: ['open', 'in_progress'] },
            { field: 'due_at', operator: 'at_or_before', value: stamp },
        ],
    }))}`;

    /**
     * The follow-ups TAB shows the whole follow-up book on purpose — "every
     * lead currently mid-sequence", not only today's slice (see the comment
     * on `follow_ups` in lib/calling.mjs's `TABS`). That is right for a rep
     * browsing the tab directly, and wrong for a tile that promises "due now":
     * clicking it landed on the same book, WhatsApp steps due next week and
     * all.
     *
     * `queue()` already composes an arbitrary `filter` on top of whichever tab
     * clause is active (see `compiled` in lib/calling.mjs), so passing the
     * same `next_follow_up_at at_or_before <now>` condition the count above
     * used narrows this ONE link to due-now, without changing what the tab
     * shows to anyone who opens it normally.
     */
    const followUpsHref = `/calling?tab=follow_ups&filter=${encodeURIComponent(JSON.stringify({
        op: 'and',
        children: [
            { field: 'next_follow_up_at', operator: 'at_or_before', value: stamp },
        ],
    }))}`;

    return { items: [
        { key: 'overdue', label: 'Overdue tasks', count: overdue, href: overdueHref, tone: 'danger' },
        ...(canApprove ? [{ key: 'approvals', label: 'Approvals waiting on you', count: approvals, href: '/my-work?tab=approvals', tone: 'danger' }] : []),
        { key: 'followups', label: 'Follow-ups due now', count: followUps, href: followUpsHref, tone: 'danger' },
        {
            key: 'meetings', label: `Meetings scheduled — ${range.label}`, count: meetingsScheduled, tone: 'success',
            // Was /calling — the cold-calling console, which answers "who do
            // I ring next" and shows no meeting on it at all. /meetings is
            // the actual list; its own range preset is passed through so
            // the number clicked and the rows shown agree on the window.
            href: `/meetings${url.searchParams.get('range') ? `?range=${url.searchParams.get('range')}` : ''}`,
        },
    ] };
}
