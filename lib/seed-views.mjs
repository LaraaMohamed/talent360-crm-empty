/**
 * The system views every workspace starts with.
 *
 * Lifted out of setup.mjs so that adding a view to the product is one edit here
 * rather than an edit plus a hand-written INSERT for every database that
 * already exists. `seedViews()` is idempotent — it inserts a view only when no
 * view of that name exists on that object — so it is safe to call on a fresh
 * install and safe to call again after new views ship.
 *
 * A view is CONFIGURATION, not code: everything here is editable and deletable
 * from the UI. These are defaults, not fixtures.
 */
import { get, run, id, now } from './db.mjs';

const V = (workspaceId, objectKey, name, viewType, filter, sort, columns, extra = {}) => ({
    id: id('viw'), workspace_id: workspaceId, object_key: objectKey, name, view_type: viewType,
    filter: JSON.stringify(filter), sort: JSON.stringify(sort), columns: JSON.stringify(columns),
    group_by: extra.groupBy ?? null, owner_id: null, scope: 'workspace',
    is_default: extra.isDefault ? 1 : 0, is_system: 1, position: extra.position ?? 0,
    created_at: now(), updated_at: now(),
});

const and = (...children) => ({ op: 'and', children });
const cond = (field, operator, value) => ({ field, operator, value });

export function systemViews(WS) {
    const v = (...args) => V(WS, ...args);

    return [
        /* ------------------------------------------------------ prospecting -- */
        /**
         * The Prospecting tabs.
         *
         * These filter on the DERIVED `status` rollup, not on a per-rule verdict,
         * because the tabs answer "where is this company in the funnel?" — one
         * question with one answer. The per-service views below answer the other
         * question ("who is right for HCM?"), and keeping the two separate is
         * what stops a company that offshoring qualified from disappearing
         * because HCM rejected it.
         *
         * "All uploaded" is the default and has NO filter. Prospecting is the
         * historical record of every company ever uploaded; a default that hides
         * part of it is how a company goes missing and the upload gets blamed.
         */
        v('prospecting_company', 'All uploaded', 'table', and(),
            [{ field: 'created_at', direction: 'desc' }],
            ['name', 'status', 'verdict_hcm', 'verdict_offshoring', 'employee_count', 'industry', 'country', 'created_at'],
            { isDefault: true, position: 0 }),

        v('prospecting_company', 'Qualified', 'table',
            and(cond('status', 'is_any_of', ['qualified'])),
            [{ field: 'employee_count', direction: 'desc' }],
            ['name', 'status', 'verdict_hcm', 'verdict_offshoring', 'employee_count', 'industry', 'country'],
            { position: 1 }),

        // REVIEW is a queue to work, not a bin — it gets a first-class tab and is
        // frequently the largest bucket.
        v('prospecting_company', 'Review required', 'table',
            and(cond('status', 'is_any_of', ['review_required'])),
            [{ field: 'employee_count', direction: 'desc' }],
            ['name', 'status', 'verdict_hcm', 'verdict_offshoring', 'employee_count', 'industry', 'country'],
            { position: 2 }),

        v('prospecting_company', 'Rejected', 'table',
            and(cond('status', 'is_any_of', ['rejected'])),
            [{ field: 'updated_at', direction: 'desc' }],
            ['name', 'status', 'verdict_hcm', 'verdict_offshoring', 'employee_count', 'industry', 'country'],
            { position: 3 }),

        v('prospecting_company', 'Imported', 'table',
            and(cond('status', 'is_any_of', ['imported'])),
            [{ field: 'imported_at', direction: 'desc' }],
            ['name', 'status', 'imported_account_id', 'imported_at', 'employee_count', 'industry', 'country'],
            { position: 4 }),

        /**
         * Per-service views, on the VERDICT rather than the rollup.
         *
         * This is the list you actually build a campaign from: "companies right
         * for offshoring" is a different set from "companies that qualified for
         * something", and pitching the wrong service is worse than not pitching.
         */
        v('prospecting_company', 'HCM — qualified', 'table',
            and(cond('verdict_hcm', 'is_any_of', ['QUALIFIED'])),
            [{ field: 'employee_count', direction: 'desc' }],
            ['name', 'verdict_hcm', 'employee_count', 'industry', 'country', 'status'],
            { position: 5 }),

        v('prospecting_company', 'HCM — needs review', 'table',
            and(cond('verdict_hcm', 'is_any_of', ['REVIEW'])),
            [{ field: 'employee_count', direction: 'desc' }],
            ['name', 'verdict_hcm', 'employee_count', 'industry', 'country'],
            { position: 6 }),

        v('prospecting_company', 'Offshoring — qualified', 'table',
            and(cond('verdict_offshoring', 'is_any_of', ['QUALIFIED'])),
            [{ field: 'employee_count', direction: 'desc' }],
            ['name', 'verdict_offshoring', 'employee_count', 'industry', 'country', 'status'],
            { position: 7 }),

        v('prospecting_company', 'Offshoring — needs review', 'table',
            and(cond('verdict_offshoring', 'is_any_of', ['REVIEW'])),
            [{ field: 'employee_count', direction: 'desc' }],
            ['name', 'verdict_offshoring', 'employee_count', 'industry', 'country'],
            { position: 8 }),

        v('prospecting_company', 'By status', 'kanban', and(),
            [], ['name', 'employee_count', 'industry'],
            { groupBy: 'status', position: 9 }),

        v('prospecting_contact', 'All prospecting contacts', 'table', and(),
            [{ field: 'last_name', direction: 'asc' }],
            // `verification_status`, not `email_verified`. The boolean answers
            // "may I send?" and nothing else; the status answers that AND "what
            // did the check actually find?", which is the question asked when
            // the two look like they disagree.
            ['full_name', 'title', 'prospect_id', 'email', 'verification_status', 'service_line_key'],
            { isDefault: true }),

        /* ---------------------------------------------------------- accounts -- */
        /**
         * An Account is now a company that was deliberately imported, so the
         * default view no longer has to hide anything except the disqualified.
         * The old "hide prospects" filter is gone with the prospects.
         */
        /**
         * The columns are the COMMERCIAL facts, not the qualification ones.
         *
         * This view used to lead with both verdict columns, employee count and
         * country. An Account has already passed the qualification gate —
         * somebody read the verdict and deliberately imported the company — so
         * from here the questions are what it buys, what it pays in, and
         * whether anyone owes it anything. The verdicts are still sortable,
         * still filterable, still one click away in the column picker, and the
         * two per-service views below still lead with them.
         */
        v('account', 'Active accounts', 'table',
            and(cond('lifecycle_stage', 'is_none_of', ['disqualified'])),
            [{ field: 'updated_at', direction: 'desc' }],
            ['name', 'lifecycle_stage', 'account_type', 'billing_currency', 'services', 'industry', 'owner_id', 'open_deals'],
            { isDefault: true, position: 0 }),

        /**
         * THE FOUR VERDICT VIEWS THAT USED TO BE HERE ARE GONE.
         *
         * "HCM — qualified", "HCM — needs review" and their Offshoring pair
         * filtered ACCOUNTS by what the qualification engine concluded. They
         * are prospecting's answers wearing an account's id — the same thing
         * the verdict COLUMNS were, and those were taken off this object for a
         * reason: a rep does not hold `prospecting.read`, and a tab strip
         * offering four filters that return an empty list for them is worse
         * than no tab.
         *
         * They still exist on `prospecting_company` above, which is the plane
         * that owns the question. An account is a company somebody decided to
         * work; how it was sourced is upstream of this screen.
         *
         * Existing workspaces are cleared by apply-remove-account-verdict-views.mjs.
         */

        v('account', 'Customers', 'table',
            and(cond('lifecycle_stage', 'is_any_of', ['customer'])),
            [{ field: 'name', direction: 'asc' }],
            ['name', 'lifecycle_stage', 'industry', 'country', 'owner_id'],
            { position: 6 }),

        v('account', 'By lifecycle', 'kanban', and(),
            [], ['name', 'industry', 'employee_count'],
            { groupBy: 'lifecycle_stage', position: 7 }),

        /* ---------------------------------------------------------- contacts -- */
        /**
         * The list shows the WHOLE name, because that is the authoritative one.
         *
         * It led with `first_name, last_name` — the two DERIVED fields — so a
         * four-part Arabic name arrived on screen as two columns that had to be
         * read together and still did not reconstruct it. `lib/names.mjs` is
         * explicit that full name is the authority and the parts are
         * conveniences for sorting and greetings; the list now agrees with it.
         *
         * Sorting stays on `last_name`, which is exactly what a derived part is
         * FOR — you cannot alphabetise a book of names by the whole string.
         */
        v('contact', 'All contacts', 'table', and(), [{ field: 'last_name', direction: 'asc' }],
            ['full_name', 'title', 'account_id', 'email', 'phone', 'service_line_key', 'owner_id', 'is_active'],
            { isDefault: true }),

        v('contact', 'Decision makers', 'table',
            and(cond('roles', 'has_any_of', ['decision_maker', 'primary'])),
            [{ field: 'last_name', direction: 'asc' }],
            ['first_name', 'last_name', 'title', 'account_id', 'email', 'roles'],
            { position: 1 }),

        // The service a contact buys is on the contact, so "who do we talk to
        // about HCM" is a view rather than a habit of naming people carefully.
        v('contact', 'By service', 'kanban', and(),
            [{ field: 'last_name', direction: 'asc' }],
            ['first_name', 'last_name', 'title', 'account_id', 'email', 'services'],
            { groupBy: 'services', position: 2 }),

        /* --------------------------------------------------------- campaigns -- */
        v('campaign', 'All campaigns', 'table', and(),
            [{ field: 'start_date', direction: 'desc' }],
            ['name', 'status', 'channel', 'service_line_key', 'member_count', 'start_date', 'end_date', 'owner_id'],
            { isDefault: true }),

        v('campaign', 'Running now', 'table',
            and(cond('status', 'is_any_of', ['active'])),
            [{ field: 'start_date', direction: 'desc' }],
            ['name', 'channel', 'service_line_key', 'member_count', 'influenced_one_time', 'influenced_mrr', 'owner_id'],
            { position: 1 }),

        /* ------------------------------------------------------------- deals -- */
        /**
         * What a deal is WORTH belongs on the list of deals — as its SIZE.
         *
         * These columns used to be `value_one_time` and `value_mrr` side by
         * side, which is the same figure printed twice: exactly one of them is
         * ever non-zero, because a deal is either one-time or recurring, so
         * every row showed a number and a dash and the reader had to work out
         * which column meant anything for this one. `price` and `billing_type`
         * say it once and say which it is.
         *
         * `value_mrr` stays as the SORT on the pipeline, because the price has
         * no column of its own to sort by (it lives on the deal's priced line)
         * and the rollups are the cached projection of it.
         */
        v('deal', 'Open pipeline', 'kanban',
            and(cond('status', 'is_any_of', ['open'])),
            [{ field: 'value_one_time', direction: 'desc' }],
            ['name', 'account_id', 'service_line_key', 'stage_id', 'price', 'billing_type', 'close_date', 'owner_id'],
            { groupBy: 'stage_id', isDefault: true }),

        v('deal', 'All deals', 'table', and(), [{ field: 'updated_at', direction: 'desc' }],
            ['name', 'account_id', 'stage_id', 'status', 'service_line_key', 'price', 'billing_type', 'close_date', 'owner_id'],
            { position: 1 }),

        v('deal', 'Closing this quarter', 'table',
            and(cond('status', 'is_any_of', ['open']), cond('close_date', 'in_next_days', 90)),
            [{ field: 'close_date', direction: 'asc' }],
            ['name', 'account_id', 'stage_id', 'price', 'billing_type', 'close_date', 'owner_id'],
            { position: 2 }),

        /* ------------------------------------------------------------- work -- */
        v('task', 'My open tasks', 'table',
            and(cond('status', 'is_any_of', ['open', 'in_progress'])),
            [{ field: 'due_at', direction: 'asc' }],
            ['title', 'status', 'priority', 'due_at', 'account_id', 'assignee_id'],
            { isDefault: true }),

        v('task', 'Overdue', 'table',
            and(cond('status', 'is_any_of', ['open', 'in_progress']), cond('due_at', 'before', new Date().toISOString().slice(0, 10))),
            [{ field: 'due_at', direction: 'asc' }],
            ['title', 'priority', 'due_at', 'account_id', 'assignee_id'],
            { position: 1 }),

        v('activity', 'Recent activity', 'table', and(), [{ field: 'occurred_at', direction: 'desc' }],
            ['type_key', 'subject', 'occurred_at', 'account_id', 'actor_id'], { isDefault: true }),

        v('note', 'All notes', 'table', and(), [{ field: 'created_at', direction: 'desc' }],
            ['body', 'account_id', 'author_id', 'created_at'], { isDefault: true }),

        v('document', 'All documents', 'table', and(), [{ field: 'created_at', direction: 'desc' }],
            ['name', 'kind', 'mime', 'size_bytes', 'account_id', 'created_at'], { isDefault: true }),

        /* ------------------------------------------- proposals & agreements -- */
        v('proposal', 'All proposals', 'table', and(), [{ field: 'created_at', direction: 'desc' }],
            ['number', 'title', 'status', 'current_version', 'account_id', 'deal_id', 'owner_id'], { isDefault: true }),

        v('agreement', 'All agreements', 'table', and(), [{ field: 'expiry_date', direction: 'asc' }],
            ['number', 'title', 'type', 'status', 'account_id', 'effective_date', 'expiry_date'], { isDefault: true }),

        // The renewal pipeline. Recurring revenue lost to a missed notice date is
        // pure, avoidable loss, and the notice date always comes before the expiry.
        v('agreement', 'Renewals — next 90 days', 'table',
            and(cond('status', 'is_any_of', ['signed']), cond('expiry_date', 'in_next_days', 90)),
            [{ field: 'expiry_date', direction: 'asc' }],
            ['number', 'title', 'account_id', 'expiry_date', 'notice_days', 'renewable'],
            { position: 1 }),
    ];
}

/**
 * Inserts any system view this workspace does not already have.
 *
 * Matched on (object, name) rather than id, so a view a user has since edited
 * is left exactly as they left it. Returns how many were added.
 */
export function seedViews(workspaceId) {
    let added = 0;
    for (const view of systemViews(workspaceId)) {
        const existing = get('SELECT id FROM views WHERE workspace_id = ? AND object_key = ? AND name = ?',
            [workspaceId, view.object_key, view.name]);
        if (existing) continue;
        const keys = Object.keys(view);
        run(`INSERT INTO views (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => view[k]));
        added += 1;
    }
    return added;
}
