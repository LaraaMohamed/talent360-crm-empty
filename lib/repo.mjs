/**
 * The generic record repository.
 *
 * One code path for list / read / create / update / delete across every object,
 * driven entirely by `objects.mjs`. This is what makes a custom field appear in
 * the list, the form, the filter builder, search and the API at once: none of
 * them contain per-object code.
 *
 * Every mutation, in a single transaction:
 *   1. validates against the field definitions
 *   2. writes the row
 *   3. appends an audit event (immutable, append only)
 *   4. refreshes the full-text index
 */
import { all, get, run, tx, id, now, json, bind } from './db.mjs';
import { removeFile } from './document-store.mjs';
import {
    objectDef, fieldsFor, fieldMap, OBJECTS, verdictPlane, DEFAULT_BILLING_CURRENCY,
} from './objects.mjs';
import { compileFilter, compileSort, EMPTY_FILTER } from './query.mjs';
import { badRequest, notFound, forbidden } from './http.mjs';
import { canWriteRecord, can, require$ } from './auth.mjs';
import { looksLikePhoneQuery, phoneMatchCandidates, phoneDigitsSql } from './phone.mjs';
// Cyclic with approvals.mjs, which imports `audit` from here. Safe for the
// same reason follow-up.mjs is: both call at runtime, never at evaluation.
import { openApprovalTask, closeApprovalTask } from './approvals.mjs';
import { notifyTaskAssigned, notifyPriceDecision, notifyLeadDead } from './notify.mjs';
import {
    deriveValues, reportingRates, toReporting, REPORTING_CURRENCY,
    billingTypeForPricingModel, recurrenceForPricingModel, billingTypeLabel,
    perPersonPricing,
} from './money.mjs';
import { setting } from './settings.mjs';
// Cyclic with follow-up.mjs, which imports `audit` from here. Safe: both
// sides call at runtime rather than at module evaluation, so the live
// bindings are resolved by the time either runs.
import { completeStep } from './follow-up.mjs';
import { reconcileNames, displayName } from './names.mjs';
import { rollupFor as campaignRollupFor } from './campaigns.mjs';

const MAX_LIMIT = 200;

/* ------------------------------------------------------------------ read -- */

/**
 * Which filter actually applies.
 *
 * The object's default filter — for accounts, "hide prospects" — is a default
 * for the BARE list, and nothing more. It must not be silently bolted onto a
 * query that already says what it wants:
 *
 *   - an explicit filter (a view, the filter builder, the API) replaces it
 *   - a list defines its own membership, so the default would quietly empty a
 *     dynamic list of prospects
 *   - a related list is already scoped by its parent
 *
 * Getting this wrong produces the worst kind of bug: a list that is correct,
 * renders without error, and is missing rows.
 */
function effectiveFilter(def, options) {
    if (options.filter) return options.filter;
    if (options.listId || options.parentId || options.accountId || options.dealId) return EMPTY_FILTER;
    return def.defaultFilter ?? EMPTY_FILTER;
}

/**
 * Builds the WHERE clause a list, a count and an export all have to agree on.
 *
 * Extracted because a count that reconstructs the filter separately is a count
 * that will eventually disagree with the list it labels — and a tab reading
 * "Qualified 127" beside a table showing something else is worse than no number
 * at all.
 */
function buildQuery(objectKey, ctx, options = {}) {
    const def = objectDef(objectKey);
    const table = def.table;

    const where = [`${table}.workspace_id = ?`];
    const params = [ctx.workspaceId];

    if (hasColumn(objectKey, 'deleted_at')) {
        if (options.onlyDeleted || options.deleted === 'only') where.push(`${table}.deleted_at IS NOT NULL`);
        else if (!options.includeDeleted) where.push(`${table}.deleted_at IS NULL`);
    }

    const compiled = compileFilter(objectKey, ctx.workspaceId, effectiveFilter(def, options), table);
    where.push(compiled.sql);
    params.push(...compiled.params);

    if (options.listId) {
        const list = get('SELECT * FROM lists WHERE id = ? AND workspace_id = ?', [options.listId, ctx.workspaceId]);
        if (!list) throw notFound('That list no longer exists.');
        if (list.kind === 'static') {
            where.push(`${table}.id IN (SELECT record_id FROM list_members WHERE list_id = ?)`);
            params.push(options.listId);
        } else {
            const dyn = compileFilter(objectKey, ctx.workspaceId, json(list.filter, EMPTY_FILTER), table);
            where.push(dyn.sql);
            params.push(...dyn.params);
        }
    }

    if (options.parentType && options.parentId) {
        where.push(`${table}.parent_type = ? AND ${table}.parent_id = ?`);
        params.push(options.parentType, options.parentId);
    }
    if (options.accountId) {
        where.push(`${table}.account_id = ?`);
        params.push(options.accountId);
    }
    if (options.dealId && hasColumn(objectKey, 'deal_id')) {
        where.push(`${table}.deal_id = ?`);
        params.push(options.dealId);
    }

    if (options.q) {
        const fields = fieldsFor(objectKey, ctx.workspaceId);
        const searchable = fields.filter((x) => x.searchable && x.column);
        const clauses = [];
        const qParams = [];
        if (searchable.length) {
            const like = `%${String(options.q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
            clauses.push(`(${searchable.map((x) => `${table}.${x.column} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
            qParams.push(...searchable.map(() => like));
        }
        /**
         * A query that looks like a phone number is ALSO matched digit-
         * normalised against the object's own phone column — the same match
         * global search and the calling queue's quick search already do (see
         * lib/phone.mjs). Without this, a per-list search box (Contacts'
         * "Search contacts…", say) never found a phone number at all, because
         * `phone` carries no `searchable` flag: it is a formatted column, and
         * a literal LIKE against it misses the moment a query is typed with
         * different spacing or a different country-code form than how the
         * number happens to be stored.
         */
        if (looksLikePhoneQuery(options.q)) {
            const phoneField = fields.find((x) => x.type === 'phone' && x.column && !x.column.includes('.'));
            if (phoneField) {
                const candidates = phoneMatchCandidates(options.q);
                if (candidates.length) {
                    const col = phoneDigitsSql(`${table}.${phoneField.column}`);
                    clauses.push(`(${candidates.map(() => `${col} LIKE ?`).join(' OR ')})`);
                    qParams.push(...candidates.map((d) => `%${d}%`));
                }
            }
        }
        if (clauses.length) {
            where.push(`(${clauses.join(' OR ')})`);
            params.push(...qParams);
        }
    }

    return { table, whereSql: where.join(' AND '), params };
}

/** How many records match, without fetching or hydrating any of them. */
export function countRecords(objectKey, ctx, options = {}) {
    const { table, whereSql, params } = buildQuery(objectKey, ctx, options);
    return get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${whereSql}`, params).n;
}

/**
 * Several counts of the same object under different filters, in ONE statement.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
 *
 * The tab strip above every list — "Active accounts 378 · Qualified 41 ·
 * Deleted 6" — is one count per saved view. It was one query per view too, so
 * opening the Accounts page paid five blocking round trips before the tabs
 * could draw, and every list in the product paid the same on every visit.
 *
 * Each arm carries the caller's own key, so results are read by name and a
 * re-ordering cannot silently relabel a tab with another view's number.
 *
 * A filter that no longer compiles — a view built on a custom field somebody
 * deleted — must not take the whole strip down with it, so each is compiled
 * separately and the broken one is reported as null exactly as it was when
 * these were separate queries.
 */
export function countRecordsBatch(objectKey, ctx, requests = []) {
    const out = {};
    const arms = [];
    const params = [];

    for (const { key, ...options } of requests) {
        out[key] = null;
        try {
            const built = buildQuery(objectKey, ctx, options);
            // The key is quoted into the SQL, so it must not be able to carry
            // anything but a record id. Anything else is skipped rather than
            // concatenated.
            if (!/^[A-Za-z0-9_-]+$/.test(String(key))) continue;
            arms.push(`SELECT '${key}' AS k, COUNT(*) AS n FROM ${built.table} WHERE ${built.whereSql}`);
            params.push(...built.params);
        } catch {
            // Left as null, and the next view still gets counted.
        }
    }

    if (!arms.length) return out;
    for (const row of all(arms.join(' UNION ALL '), params)) out[row.k] = row.n ?? 0;
    return out;
}

export function listRecords(objectKey, ctx, options = {}) {
    const fields = fieldMap(objectKey, ctx.workspaceId);
    const { table, whereSql, params } = buildQuery(objectKey, ctx, options);

    const orderBy = compileSort(objectKey, ctx.workspaceId, options.sort, table)
        ?? `${table}.${hasColumn(objectKey, 'updated_at') ? 'updated_at' : 'created_at'} DESC`;

    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(options.limit) || 50));
    const page = Math.max(1, Number(options.page) || 1);

    const total = get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${whereSql}`, params).n;
    const rows = all(
        `SELECT ${table}.* FROM ${table} WHERE ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
        [...params, limit, (page - 1) * limit],
    );

    return {
        records: hydrate(objectKey, rows, ctx),
        total,
        page,
        limit,
        pages: Math.max(1, Math.ceil(total / limit)),
        fields: fields ? [...fields.values()] : [],
    };
}

/**
 * Every id matching the filter, ignoring pagination.
 *
 * This is what makes "select all 2,431 matching" real rather than
 * "select the 50 on screen" wearing a bigger number.
 */
export function idsMatching(objectKey, ctx, options = {}) {
    const { table, whereSql, params } = buildQuery(objectKey, ctx, options);
    const rows = all(`SELECT id FROM ${table} WHERE ${whereSql}`, params);
    return { ids: rows.map((r) => r.id), total: rows.length };
}

export function getRecord(objectKey, ctx, recordId, { includeDeleted = false } = {}) {
    const def = objectDef(objectKey);
    const row = get(`SELECT * FROM ${def.table} WHERE id = ? AND workspace_id = ?`, [recordId, ctx.workspaceId]);
    if (!row) throw notFound(`That ${def.label.toLowerCase()} does not exist.`);
    if (!includeDeleted && row.deleted_at) throw notFound(`That ${def.label.toLowerCase()} was deleted.`);
    return hydrate(objectKey, [row], ctx)[0];
}

/* ----------------------------------------------------------------- write -- */

/**
 * Name reconciliation, for the two objects that have people in them.
 *
 * Runs AFTER validate, on the raw input, because it needs to know which of the
 * three name fields the caller actually mentioned — validate has already
 * dropped the ones it did not.
 */
function nameFields(objectKey, before, input) {
    if (objectKey !== 'contact' && objectKey !== 'prospecting_contact') return {};
    const mentioned = ['full_name', 'first_name', 'last_name']
        .filter((k) => Object.prototype.hasOwnProperty.call(input ?? {}, k));
    if (!mentioned.length) return {};
    const incoming = {};
    for (const key of mentioned) incoming[key] = input[key];
    return reconcileNames(before, incoming);
}

/**
 * The billing currency an account opens with, from its type.
 *
 * ON CREATION ONLY, and only when the caller said nothing. A field-level
 * `default` cannot do this because it depends on a sibling field, and a
 * computed value would be wrong: the business was explicit that Account Type
 * must not permanently determine currency. Egypt does not mean EGP forever —
 * it means EGP unless somebody says otherwise, once.
 *
 * On UPDATE the rule holds in a narrower form — see `followAccountType`.
 */
function defaultBillingCurrency(objectKey, values, input) {
    if (objectKey !== 'account') return;
    const asked = Object.prototype.hasOwnProperty.call(input ?? {}, 'billing_currency');
    if (asked || values.billing_currency) return;
    const fallback = DEFAULT_BILLING_CURRENCY[values.account_type];
    if (fallback) values.billing_currency = fallback;
}

/**
 * Offshoring sells to Regional clients, billed in USD — an Offshoring account
 * left on the plain `account_type` default of Egypt/EGP quoted correctly in
 * neither: Deal size showed EGP on a headcount priced in dollars.
 *
 * Runs BEFORE `defaultBillingCurrency`, and only when the caller said nothing
 * about `account_type` — an account explicitly created as Egypt that also
 * buys Offshoring is a real case (e.g. a local reseller) and is left alone.
 */
function defaultOffshoringAccountType(objectKey, values, input) {
    if (objectKey !== 'account') return;
    const asked = Object.prototype.hasOwnProperty.call(input ?? {}, 'account_type');
    if (asked) return;
    // `services` is a multiselect: `validate()` has already JSON-stringified
    // it into the column shape by the time this runs.
    const services = json(values.services, []);
    if (services.includes('offshoring')) values.account_type = 'Regional';
}

/**
 * Changing the type re-detects the currency — unless somebody chose it.
 *
 * The original rule was that type must never re-price a client, and that rule
 * exists for a real case: a Regional client who pays in SAR stays Regional and
 * stays in SAR. But it also meant an account created as Egypt and corrected to
 * Regional kept EGP for ever, which is the far commoner mistake and one nobody
 * thinks to fix by hand.
 *
 * So the currency follows the type only when it is still the OLD type's
 * default — that is, when nobody has expressed a preference. A currency that
 * disagrees with its type is somebody's decision and is left exactly alone,
 * and an explicit `billing_currency` in the same request always wins.
 */
function followAccountType(objectKey, values, input, before) {
    if (objectKey !== 'account') return;
    if (Object.prototype.hasOwnProperty.call(input ?? {}, 'billing_currency')) return;
    if (!('account_type' in values) || values.account_type === before?.account_type) return;

    const wanted = DEFAULT_BILLING_CURRENCY[values.account_type];
    const wasDefault = before?.billing_currency === DEFAULT_BILLING_CURRENCY[before?.account_type];
    // An account with no currency at all is not a preference either.
    if (wanted && (wasDefault || !before?.billing_currency)) values.billing_currency = wanted;
}

/**
 * The currency a DEAL opens in: whatever its client is billed in.
 *
 * `deals.currency` is `NOT NULL DEFAULT 'SAR'` in the schema, which was fine
 * when every client paid in riyals and is a silent falsehood now. The USD
 * dashboard converts by this column, so a deal on an Egyptian account that
 * nobody typed a currency into was stored as SAR and then divided by 3.75
 * instead of 50 — reported at roughly thirteen times its real value, with
 * nothing flagged, because SAR has a perfectly good rate.
 *
 * A column default cannot read a sibling table, so the account is consulted
 * here instead. Creation only, and only when the caller said nothing: a deal
 * deliberately raised in another currency stays in it, and re-pricing an
 * existing deal because its account changed is not this function's business.
 */
/**
 * Where a deal lives, when the form no longer asks.
 *
 * `pipeline_id` and `stage_id` are NOT NULL, and the pipeline chooser is gone
 * because there is one pipeline. So a deal raised with just a name and an
 * account gets the workspace's default pipeline and that pipeline's first open
 * stage — which is what "create the deal when the meeting is booked" needs:
 * no price, no line items, no date, no dropdowns.
 *
 * An explicit stage still wins, so raising one straight into Meeting scheduled
 * works exactly as before.
 */
/**
 * The fields a stage still needs before a deal may sit in it — shared so
 * dragging a card on the board and creating a deal straight into a stage ask
 * the identical question (FR-DEAL-007). `record` may be a hydrated row
 * (`properties` already an object) or the pre-insert values `createRecord`
 * is still assembling (`properties` possibly still a JSON string); `json()`
 * handles both.
 */
export function missingStageFields(record, stage) {
    const required = json(stage?.required_fields, []);
    if (!required.length) return [];
    const props = json(record?.properties, {});
    return required.filter((key) => {
        const value = key.startsWith('properties.') ? props[key.slice(11)] : record?.[key];
        return value === null || value === undefined || value === '';
    });
}

function defaultDealPlacement(objectKey, ctx, values) {
    if (objectKey !== 'deal') return;

    if (!values.pipeline_id) {
        const pipeline = get(
            `SELECT id FROM pipelines WHERE workspace_id = ? AND object_key = 'deal'
              ORDER BY is_default DESC, position LIMIT 1`,
            [ctx.workspaceId],
        );
        if (pipeline) values.pipeline_id = pipeline.id;
    }
    if (values.pipeline_id && !values.stage_id) {
        const stage = get(
            `SELECT id FROM stages WHERE pipeline_id = ? AND type = 'open' ORDER BY position LIMIT 1`,
            [values.pipeline_id],
        );
        if (stage) values.stage_id = stage.id;
    }
}

function defaultDealCurrency(objectKey, ctx, values, input) {
    if (objectKey !== 'deal') return;
    if (!values.account_id) return;
    const account = get(
        'SELECT billing_currency FROM accounts WHERE id = ? AND workspace_id = ?',
        [values.account_id, ctx.workspaceId],
    );
    if (account?.billing_currency) {
        values.currency = account.billing_currency;
    }
}

/**
 * A contract opens in the client's currency, and its renewal date starts at
 * its expiry date.
 *
 * Both are opening values, not rules. The renewal date is the one people move —
 * a 90-day notice period means the decision is due three months before the
 * contract ends — and the currency is the one that differs when a single
 * contract was negotiated in dollars for a client billed in pounds. Creation
 * only, and only where the caller said nothing.
 */
/**
 * `P-2026-0001`, `A-2026-0004`.
 *
 * Counted over the workspace rather than the year — the year in the middle says
 * when it was written, not where the counter restarted. Lives here because
 * three places now need it: document generation, `createProposal`, and
 * `createRecord` below. It was written twice before this and a third copy is
 * how two contracts end up sharing a number.
 */
export function nextDocumentNumber(ctx, table, prefix) {
    const n = get(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`, [ctx.workspaceId]).n + 1;
    return `${prefix}-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
}

/**
 * A proposal or agreement typed in by hand gets a number like any other.
 *
 * `number` is NOT NULL and read-only, which together meant the generic create
 * route could never make one: it refused for a missing field the caller was not
 * allowed to send. Every agreement in the system therefore had to come from
 * document generation — fine for new business, useless for recording the
 * contracts that existed before the CRM did, which is exactly what mapping the
 * current HCM and Offshoring clients means.
 */
function assignDocumentNumber(objectKey, ctx, values) {
    if (objectKey !== 'proposal' && objectKey !== 'agreement') return;
    if (values.number) return;
    values.number = nextDocumentNumber(
        ctx,
        objectKey === 'proposal' ? 'proposals' : 'agreements',
        objectKey === 'proposal' ? 'P' : 'A',
    );
}

function defaultAgreementFields(objectKey, ctx, values, input) {
    if (objectKey !== 'agreement') return;

    const askedRenewal = Object.prototype.hasOwnProperty.call(input ?? {}, 'renewal_date');
    if (!askedRenewal && !values.renewal_date && values.expiry_date) {
        values.renewal_date = values.expiry_date;
    }

    /**
     * `notice_days` is `NOT NULL DEFAULT 0` at the schema level — SQLite has
     * no way to leave it unset, so a record created without a negotiated
     * notice period silently got 0 rather than the workspace's own default.
     * `noticeDateFor` (lib/renewals.mjs) treats a stored number as "this
     * contract's own figure, not the default" — it has no way to tell a
     * genuine "0 days, negotiated" from "nobody typed anything" once the
     * value is on the row, so the fix has to be HERE, at the write: resolve
     * the workspace default and store it as this agreement's own figure the
     * moment it is created, the same way a price is snapshotted rather than
     * left to be recomputed from a setting that can change later.
     */
    const askedNotice = Object.prototype.hasOwnProperty.call(input ?? {}, 'notice_days');
    if (!askedNotice && (values.notice_days === undefined || values.notice_days === null || values.notice_days === '')) {
        values.notice_days = Number(setting(ctx.workspaceId, 'default_renewal_notice_days')) || 45;
    }

    const askedCurrency = Object.prototype.hasOwnProperty.call(input ?? {}, 'currency');
    if (askedCurrency || values.currency) return;

    if (values.deal_id) {
        const deal = get('SELECT currency FROM deals WHERE id = ? AND workspace_id = ?', [values.deal_id, ctx.workspaceId]);
        if (deal?.currency) {
            values.currency = deal.currency;
            return;
        }
    }

    if (values.account_id) {
        const account = get(
            'SELECT billing_currency FROM accounts WHERE id = ? AND workspace_id = ?',
            [values.account_id, ctx.workspaceId],
        );
        if (account?.billing_currency) values.currency = account.billing_currency;
    }
}

function defaultProposalFields(objectKey, ctx, values, input) {
    if (objectKey !== 'proposal') return;
    if (!values.account_id && values.deal_id) {
        const deal = get('SELECT account_id, currency FROM deals WHERE id = ? AND workspace_id = ?', [values.deal_id, ctx.workspaceId]);
        if (deal) {
            values.account_id = deal.account_id;
            if (!values.currency) values.currency = deal.currency;
        }
    }
    if (values.deal_id && !values.currency) {
        const deal = get('SELECT currency FROM deals WHERE id = ? AND workspace_id = ?', [values.deal_id, ctx.workspaceId]);
        if (deal?.currency) values.currency = deal.currency;
    }
    if (values.account_id && !values.currency) {
        const account = get('SELECT billing_currency FROM accounts WHERE id = ? AND workspace_id = ?', [values.account_id, ctx.workspaceId]);
        if (account?.billing_currency) values.currency = account.billing_currency;
    }
}

function enforceCurrencyConsistency(objectKey, ctx, values, existing = null) {
    if (objectKey !== 'proposal' && objectKey !== 'agreement' && objectKey !== 'deal') return;
    
    const accountId = values.account_id ?? existing?.account_id;
    if (accountId) {
        const account = get('SELECT billing_currency FROM accounts WHERE id = ? AND workspace_id = ?', [accountId, ctx.workspaceId]);
        if (account?.billing_currency && values.currency && values.currency.toUpperCase() !== account.billing_currency.toUpperCase()) {
            throw badRequest(`Currency mismatch: ${objectKey} currency (${values.currency}) does not match Account billing currency (${account.billing_currency}).`);
        }
    }

    if (objectKey !== 'agreement') return;
    const dealId = values.deal_id ?? existing?.deal_id;
    if (dealId) {
        const deal = get('SELECT currency FROM deals WHERE id = ? AND workspace_id = ?', [dealId, ctx.workspaceId]);
        if (deal?.currency && values.currency && values.currency.toUpperCase() !== deal.currency.toUpperCase()) {
            throw badRequest(`Currency mismatch: ${objectKey} currency (${values.currency}) does not match Deal currency (${deal.currency}).`);
        }
    }
}

export function createRecord(objectKey, ctx, input, { source = 'ui' } = {}) {
    const def = objectDef(objectKey);
    /**
     * A contact's data source reflects the account's, when nobody said
     * otherwise. `data_source` is required on a contact — personal data has
     * to say where it came from — and an account brought in by an import or
     * integration already knows that answer. Filled in before `validate`
     * runs its required-field check, so it only closes a gap: a contact
     * created with its own explicit source (Apollo, cold calling, a CSV
     * column) is never overwritten by the account's.
     */
    if (objectKey === 'contact' && !input?.data_source && input?.account_id) {
        const accountSource = get(
            'SELECT source FROM accounts WHERE id = ? AND workspace_id = ?',
            [input.account_id, ctx.workspaceId],
        )?.source;
        if (accountSource) input = { ...input, data_source: accountSource };
    }
    const values = validate(objectKey, ctx, input, { creating: true });
    Object.assign(values, nameFields(objectKey, {}, input));
    defaultOffshoringAccountType(objectKey, values, input);
    defaultBillingCurrency(objectKey, values, input);
    defaultDealPlacement(objectKey, ctx, values);
    defaultDealCurrency(objectKey, ctx, values, input);

    if (objectKey === 'proposal' && !values.deal_id && values.account_id) {
        values.deal_id = ensureDealForAgreement(ctx, {
            accountId: values.account_id,
            serviceLineKey: values.service_line_key ?? null,
            currency: values.currency ?? null,
            price: input?.total_value ?? input?.value ?? null,
            because: 'a proposal needs a deal',
        })?.id ?? null;
    }

    const proposalId = input?.proposal_id ?? values.proposal_id;
    if (objectKey === 'agreement' && proposalId) {
        const prop = get('SELECT * FROM proposals WHERE id = ? AND workspace_id = ?', [proposalId, ctx.workspaceId]);
        if (prop) {
            /**
             * An agreement IS the signed form of a proposal, so it must close
             * the SAME deal the proposal quoted. Silently attaching it to a
             * different deal would split one negotiation across two rows of the
             * pipeline — so an explicit deal that disagrees with the proposal's
             * is refused in words.
             */
            if (values.deal_id && prop.deal_id && values.deal_id !== prop.deal_id) {
                throw badRequest(`This agreement belongs to proposal ${prop.number}, which is on a different deal. An agreement must close the same deal its proposal quoted.`);
            }
            if (!values.deal_id && prop.deal_id) {
                values.deal_id = prop.deal_id;
            }
            if (!values.account_id && prop.account_id) {
                values.account_id = prop.account_id;
            }
            if (!values.currency && prop.currency) {
                values.currency = prop.currency;
            }
            const propDeal = prop.deal_id ? get('SELECT * FROM deals WHERE id = ?', [prop.deal_id]) : null;
            const propVal = Number(prop.total_value ?? (propDeal ? dealPrice(ctx, propDeal).price : 0) ?? 0);
            const agrVal = Number(values.contract_value ?? input?.contract_value ?? 0);
            if (propVal > 0 && agrVal > 0 && propVal !== agrVal && !input?.confirm_value_mismatch) {
                throw badRequest(`Value mismatch: Agreement contract value (${agrVal}) differs from Proposal value (${propVal}). Explicit confirmation required.`);
            }
        }
    }

    defaultProposalFields(objectKey, ctx, values, input);
    defaultAgreementFields(objectKey, ctx, values, input);
    enforceCurrencyConsistency(objectKey, ctx, values);
    // `Company Name - Service Name`, so nobody composes it by hand and no two
    // deals for one client disagree about the format.
    if (objectKey === 'deal') applyGeneratedDealName(ctx, values, input);

    /**
     * An agreement without a deal is a contract nobody's pipeline knows about.
     *
     * Establishing that relationship is this function's job and not the user's:
     * an appropriate deal is found for the account and the service, and one is
     * created when there is none. See `ensureDealForAgreement`.
     */
    if (objectKey === 'agreement' && !values.deal_id && values.account_id) {
        values.deal_id = ensureDealForAgreement(ctx, {
            accountId: values.account_id,
            serviceLineKey: values.service_line_key ?? null,
            currency: values.currency ?? null,
            price: values.contract_value ?? null,
        })?.id ?? null;
    }
    assignDocumentNumber(objectKey, ctx, values);

    // Idempotent identity: re-importing the same source is an update, not a
    // second copy. Without this, "re-upload the corrected file" doubles the
    // database.
    if (values.external_id) {
        const existing = get(
            `SELECT * FROM ${def.table} WHERE workspace_id = ? AND external_id = ?`,
            [ctx.workspaceId, values.external_id],
        );
        if (existing) return updateRecord(objectKey, ctx, existing.id, input, { source, reason: 'external_id match' });
    }

    const recordId = id(prefixFor(objectKey));
    const stamp = now();
    const row = {
        id: recordId,
        workspace_id: ctx.workspaceId,
        ...values,
        created_at: stamp,
        ...(hasColumn(objectKey, 'updated_at') ? { updated_at: stamp } : {}),
        ...(hasColumn(objectKey, 'created_by') ? { created_by: ctx.userId } : {}),
    };
    if (hasColumn(objectKey, 'owner_id') && !row.owner_id) row.owner_id = ctx.userId;
    if (hasColumn(objectKey, 'account_id') && row.parent_type && !row.account_id) {
        row.account_id = resolveAccountId(row.parent_type, row.parent_id);
    }

    // Refuse in words rather than letting SQLite refuse in its own.
    const missing = requiredColumns(objectKey).filter(
        (c) => row[c] === undefined || row[c] === null || row[c] === '',
    );
    if (missing.length) {
        throw badRequest(
            `A ${def.label.toLowerCase()} cannot be created without ${missing.map(fieldLabel(objectKey)).join(', ')}.`,
        );
    }

    /**
     * Entering a stage IS entering it, whether by a drag on the board or by
     * being created straight into one — `moveStage` (api/deals.mjs) already
     * refused the first; this refuses the second. Without it, a deal created
     * — by an import, an integration, or a form that lets the stage be picked
     * up front — straight into a stage that requires a field (a proposal-sent
     * stage requiring `close_date`, say) skipped the question entirely,
     * because "moving" into a stage and "starting" in one used to be two
     * different code paths asking two different questions.
     */
    if (objectKey === 'deal' && row.stage_id && !input?.force) {
        const stage = get('SELECT label, required_fields FROM stages WHERE id = ?', [row.stage_id]);
        const missingStage = missingStageFields(row, stage);
        if (missingStage.length) {
            throw badRequest(
                `"${stage.label}" needs ${missingStage.join(', ')} filled in first.`,
                { missing: missingStage, stage: stage.label },
            );
        }
    }

    return tx(() => {
        insert(def.table, row);
        audit(ctx, { objectKey, recordId, accountId: row.account_id ?? (objectKey === 'account' ? recordId : null), action: 'created', after: row, source });

        // Stage one starts the clock too — without this row, the very first
        // stage a deal ever sits in has no `entered_at`, and "how long did
        // this deal stay at X" cannot answer for it even after every OTHER
        // move is tracked (see moveDealToStage and followStage).
        if (objectKey === 'deal' && row.stage_id) {
            insert('deal_stage_history', {
                id: id('dsh'), workspace_id: ctx.workspaceId, deal_id: recordId,
                from_stage_id: null, to_stage_id: row.stage_id, entered_at: stamp, actor_id: ctx.userId ?? null,
            });
        }
        /**
         * A record CREATED awaiting approval asks somebody, like every other
         * way of getting there.
         *
         * `submitForReview` raises the task, and so does generating, and so
         * does uploading a version. Creating a proposal or agreement with
         * `status: 'pending_review'` in the payload reached the same state
         * through none of them — the record sat waiting and nobody was told.
         * Enforced here, at the write, because that is the one place every
         * caller passes through.
         */
        if ((objectKey === 'proposal' || objectKey === 'agreement') && row.status === 'pending_review') {
            openApprovalTask(ctx, objectKey, getRecord(objectKey, ctx, recordId));
        }

        // A contract exists, so the deal is being contracted, and the two
        // records of what this client pays are made to agree.
        if (objectKey === 'agreement' && row.deal_id) {
            moveDealForAgreement(ctx, row.deal_id, 'contracting', `agreement ${row.number} created`);
            syncAgreementAndDeal(ctx, recordId);
        }
        // An agreement created FROM a proposal is recorded as its signed form,
        // so the update path and every report can see which proposal(s) it
        // closes — and re-pointing it at another deal is refused with that link.
        if (objectKey === 'agreement' && proposalId) {
            const version = get(
                'SELECT id FROM proposal_versions WHERE proposal_id = ? AND version = (SELECT current_version FROM proposals WHERE id = ?)',
                [proposalId, proposalId],
            );
            if (version) {
                run('INSERT OR IGNORE INTO agreement_proposals (agreement_id, proposal_version_id) VALUES (?,?)',
                    [recordId, version.id]);
            }
        }
        // Whoever was typed on the account form is a contact on it.
        if (objectKey === 'account') syncPrimaryContact(ctx, recordId, input, { source });
        // A task assigned to somebody else is work appearing on their list —
        // the one notification the docs name as worth a bell.
        if (objectKey === 'task' && row.assignee_id) {
            notifyTaskAssigned(ctx, {
                assigneeId: row.assignee_id,
                taskId: recordId,
                subject: row.title ?? 'Task',
                accountName: null,
            });
        }
        reindex(objectKey, ctx.workspaceId, recordId);
        return getRecord(objectKey, ctx, recordId);
    });
}

/**
 * The person typed on the ACCOUNT form — or an account IMPORT carrying
 * contact columns alongside its own — becomes a CONTACT on that account.
 *
 * ── WHY THESE ARE NOT COLUMNS ON `accounts` ─────────────────────────────────
 *
 * Because a company has more than one person, and the one you entered first
 * stops being the one you deal with. Columns on the account would be a second
 * copy of a name and an email that the contact record already holds, and the
 * day somebody corrects the contact the account still says the old thing — with
 * nothing on screen to say which is right. So the form (and the importer)
 * collect them and this writes them where they belong.
 *
 * ── CREATE ONCE, UPDATE AFTER ───────────────────────────────────────────────
 *
 * The account's earliest contact is the one these fields stand for. Saving the
 * account again with the same values changes nothing; changing a value edits
 * that contact rather than adding a second one, which is what would happen if
 * this always inserted — an account re-saved three times would end up with
 * three copies of one person. The same rule is what lets an import file carry
 * one row per COMPANY with the primary contact's details alongside it, rather
 * than needing a second file and a second pass once the accounts exist.
 *
 * Only fields actually SUPPLIED are written. An account edited from a screen
 * that does not carry these fields must not blank the contact's email just
 * because the payload did not mention it.
 *
 * Nothing at all happens without a name. An email on its own creates a contact
 * with no one in it, and "role" without a person is not a person. `full_name`
 * counts as a name on its own — first and last are derived from it exactly as
 * they are on a direct contact write; see `reconcileNames` in lib/names.mjs.
 */
const PRIMARY_CONTACT_FIELDS = {
    contact_full_name: 'full_name',
    contact_first_name: 'first_name',
    contact_last_name: 'last_name',
    contact_title: 'title',
    contact_email: 'email',
    contact_phone: 'phone',
    contact_linkedin_url: 'linkedin_url',
};

export function syncPrimaryContact(ctx, accountId, input, { source = 'ui' } = {}) {
    if (!accountId || !input) return null;

    const supplied = {};
    for (const [from, to] of Object.entries(PRIMARY_CONTACT_FIELDS)) {
        if (!Object.prototype.hasOwnProperty.call(input, from)) continue;
        const value = String(input[from] ?? '').trim();
        supplied[to] = value || null;
    }
    if (!Object.keys(supplied).length) return null;

    const existing = get(
        `SELECT * FROM contacts
          WHERE workspace_id = ? AND account_id = ? AND deleted_at IS NULL
          ORDER BY created_at, rowid LIMIT 1`,
        [ctx.workspaceId, accountId],
    );

    if (existing) {
        const changed = Object.entries(supplied).filter(([k, v]) => (existing[k] ?? null) !== v);
        if (!changed.length) return existing.id;
        updateRecord('contact', ctx, existing.id, Object.fromEntries(changed), {
            source, reason: 'entered on the account',
        });
        return existing.id;
    }

    // A contact is a PERSON. Without a name there is nobody to create.
    if (!supplied.full_name && !supplied.first_name && !supplied.last_name) return null;

    return createRecord('contact', ctx, {
        ...supplied,
        account_id: accountId,
        /**
         * Personal data has to say where it came from, and this is the true
         * answer for this path: somebody typed it on the company's record.
         * Stated rather than left to a default, because a default would make
         * every contact in the database claim the same untrue provenance.
         */
        data_source: 'Entered on the account record',
    }, { source })?.id ?? null;
}

/**
 * A deal's status follows the type of the stage it sits in — WHEREVER the stage
 * is written, not only through the endpoint that remembers to.
 *
 * `POST /api/deals/:id/stage` derived this correctly. But `stage_id` is also an
 * ordinary editable field, so the record form and bulk edit set it straight
 * through `updateRecord`, which did not. Result: a deal moved to "Deal Won" from
 * the edit form stayed `status = 'open'` with no `closed_at`, so it counted as
 * open pipeline and appeared nowhere in the win rate. Two real deals were in
 * that state.
 *
 * The rule belongs here, next to the write, for the same reason the reference
 * map is built from the schema: a rule enforced in one caller is a rule the
 * second caller does not have.
 *
 * A loss still needs its reason. Closing a deal as lost without recording why
 * is the thing `moveStage` refuses, and going the long way round a guard should
 * not get you past it.
 */
function followStage(ctx, before, values, input) {
    if (!values.stage_id || values.stage_id === before.stage_id) return;

    const stage = get('SELECT * FROM stages WHERE id = ? AND workspace_id = ?',
        [values.stage_id, ctx.workspaceId]);
    if (!stage) return;   // validate() already rejects an unknown reference

    const status = stage.type === 'won' ? 'won' : stage.type === 'lost' ? 'lost' : 'open';
    values.status = status;

    if (status === 'lost') {
        const lossReason = input?.loss_reason ?? input?.lossReason ?? null;
        if (!lossReason) {
            throw badRequest('Closing a deal as lost needs a reason.', {
                lossReasons: all(
                    'SELECT key, label FROM loss_reasons WHERE workspace_id = ? ORDER BY position',
                    [ctx.workspaceId],
                ),
            });
        }
        values.loss_reason = lossReason;
    } else {
        values.loss_reason = null;
    }

    // Reopening clears the close; closing stamps it. Never left stale.
    const stamp = now();
    values.closed_at = status === 'open' ? null : (before.closed_at ?? stamp);

    // Same ledger `moveDealToStage` writes for an automated move and
    // api/deals.mjs's dedicated endpoint writes for a Kanban drag — this is
    // the THIRD path a deal's stage_id changes on (a plain edit of the Stage
    // field, or a bulk update), and without a row here it was the one
    // "how long did this deal sit in X" could not see either.
    run('UPDATE deal_stage_history SET exited_at = ? WHERE deal_id = ? AND exited_at IS NULL', [stamp, before.id]);
    insert('deal_stage_history', {
        id: id('dsh'), workspace_id: ctx.workspaceId, deal_id: before.id,
        from_stage_id: before.stage_id, to_stage_id: stage.id, entered_at: stamp, actor_id: ctx.userId ?? null,
    });
}

export function updateRecord(objectKey, ctx, recordId, input, { source = 'ui', reason = null, skipPermission = false } = {}) {
    const def = objectDef(objectKey);
    const before = get(`SELECT * FROM ${def.table} WHERE id = ? AND workspace_id = ?`, [recordId, ctx.workspaceId]);
    if (!before) throw notFound(`That ${def.label.toLowerCase()} does not exist.`);
    // The object key decides whether ownership applies: a company is shared, a
    // deal is somebody's. See SHARED_OBJECTS in lib/auth.mjs.
    if (!skipPermission && !canWriteRecord(ctx, before, objectKey)) {
        throw forbidden('You can only change records you own. Ask the owner or a manager.');
    }

    const values = validate(objectKey, ctx, input, { creating: false, existing: before });
    Object.assign(values, nameFields(objectKey, before, input));
    enforceCurrencyConsistency(objectKey, ctx, values, before);
    /**
     * Signing is a WORKFLOW, not a field write.
     *
     * `status` is an ordinary editable option on the agreement form, and
     * `signAgreement` (api/proposals.mjs) is what actually enforces approval,
     * moves the deal to Won, promotes the account to customer and raises the
     * Internal Team Proposal. A plain edit landing `signed` in `values` here
     * would flip the column and skip every one of those — leaving exactly the
     * inconsistent record this refusal exists to prevent: a contract marked
     * signed with no won deal, no customer account, and no internal proposal
     * behind it. Reverting a signature (moving OFF `signed`) is unaffected —
     * that still goes through the ordinary transition logic below.
     */
    if (objectKey === 'agreement' && values.status === 'signed' && before.status !== 'signed') {
        throw badRequest('An agreement is signed through "Record signature", not by editing its status — '
            + 'that action also moves the deal to Won and raises the Internal Team Proposal.');
    }
    /**
     * An agreement IS the signed form of a proposal, so on UPDATE it must still
     * close the SAME deal its proposal quoted. Re-pointing an agreement at a
     * different deal than its proposal would split one negotiation across two
     * rows of the pipeline — refused in words, as on create.
     */
    if (objectKey === 'agreement') {
        /**
         * The proposal(s) behind an agreement live in `agreement_proposals`,
         * not on the agreement row, so they are looked up through the join:
         * agreement → proposal_versions → proposals. Every proposal this
         * agreement is the signed form of must be on the deal it closes.
         */
        const dealId = values.deal_id ?? before.deal_id;
        if (dealId) {
            const linked = all(
                `SELECT p.id, p.number, p.deal_id FROM agreement_proposals ap
                   JOIN proposal_versions pv ON pv.id = ap.proposal_version_id
                   JOIN proposals p ON p.id = pv.proposal_id
                  WHERE ap.agreement_id = ? AND p.deal_id IS NOT NULL`,
                [recordId],
            );
            for (const prop of linked) {
                if (prop.deal_id !== dealId) {
                    throw badRequest(`This agreement belongs to proposal ${prop.number}, which is on a different deal. An agreement must close the same deal its proposal quoted.`);
                }
            }
        }
    }
    if (objectKey === 'deal') applyGeneratedDealName(ctx, values, input, before);
    /**
     * A task that is done says WHEN it was done.
     *
     * `completed_at` is a column, is on the object as a read-only field, and was
     * written by nothing: every task in the database that had been ticked
     * carried a null completion date, so "how long did that take" and "what did
     * we finish this week" were unanswerable. Reopening clears it, for the same
     * reason a reopened deal loses its closing date.
     */
    if (objectKey === 'task' && 'status' in values && values.status !== before.status) {
        const finished = values.status === 'done' || values.status === 'cancelled';
        values.completed_at = finished ? (before.completed_at ?? now()) : null;
    }
    if (objectKey === 'deal') followStage(ctx, before, values, input);
    /**
     * An agreement being unlinked from its deal is re-linked.
     *
     * "This agreement belongs to no deal" is the state twelve production
     * contracts were in, and it is not one anybody chose — so the write that
     * would restore it finds or creates the deal instead.
     */
    if (objectKey === 'agreement'
        && Object.prototype.hasOwnProperty.call(input ?? {}, 'deal_id') && !values.deal_id) {
        values.deal_id = ensureDealForAgreement(ctx, {
            accountId: values.account_id ?? before.account_id,
            serviceLineKey: values.service_line_key ?? before.service_line_key ?? null,
            currency: values.currency ?? before.currency ?? null,
            price: values.contract_value ?? before.contract_value ?? null,
        })?.id ?? null;
    }
    followAccountType(objectKey, values, input, before);
    if (!Object.keys(values).length) {
        /**
         * No column on THIS record changed — but a form-only field may still
         * have work to do elsewhere. Editing only the person on an account
         * form lands here with nothing to write to `accounts`, and returning
         * early threw the contact edit away silently.
         */
        if (objectKey === 'account') syncPrimaryContact(ctx, recordId, input, { source });
        return getRecord(objectKey, ctx, recordId);
    }

    const changed = {};
    for (const [k, v] of Object.entries(values)) {
        if (String(before[k] ?? '') !== String(v ?? '')) changed[k] = { from: before[k], to: v };
    }

    return tx(() => {
        update(def.table, recordId, {
            ...values,
            ...(hasColumn(objectKey, 'updated_at') ? { updated_at: now() } : {}),
        });
        if (Object.keys(changed).length) {
            audit(ctx, {
                objectKey,
                recordId,
                accountId: before.account_id ?? (objectKey === 'account' ? recordId : null),
                action: 'updated',
                before: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.from])),
                after: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.to])),
                source,
                reason,
            });
        }
        /**
         * A probability override typed on the deal changes the weighted value
         * without touching a line item, so the cached rollups have to follow.
         * Stage moves go through api/deals.mjs and sync for the same reason.
         */
        if (objectKey === 'deal'
            && ('probability' in values || 'stage_id' in values || 'currency' in values)) {
            syncDealValues(recordId, ctx);
        }
        /**
         * Changing the SERVICE changes whether the price repeats.
         *
         * Recurring versus one-time is the service's decision, so a deal moved
         * from HCM to Recruitment has to re-file its price as one-time — the
         * stored line still said `monthly` otherwise, and the deal went on
         * reporting an MRR for what is now a placement fee.
         */
        if (objectKey === 'deal' && 'service_line_key' in values) repriceForService(ctx, recordId);
        /**
         * Completing the last follow-up kills the lead.
         *
         * The rule is four activities and then dead, and this is where "and
         * then dead" happens — on the WRITE, so it holds however the task was
         * ticked: My Work, the task list, a bulk edit, the API. A rule enforced
         * in one caller is a rule the second caller does not have.
         *
         * `completeStep` returns null for an ordinary task, so every task
         * completion can be handed to it without asking first.
         */
        if (objectKey === 'task' && values.status === 'done') {
            completeStep(ctx, { ...before, ...values });
        }
        /**
         * An agreement that ends takes its deal with it.
         *
         * Terminated and expired are both "this contract is not producing
         * revenue any more", and a deal still sitting in Contracting against a
         * dead agreement is a forecast nobody has corrected. Signing is not
         * here: it goes through `signAgreement`, which has more to do than move
         * a stage.
         *
         * Linking an agreement to a deal after the fact moves that deal into
         * Contracting too — the link is what the automation was waiting for.
         */
        /**
         * Signed means closed. Anything else means open.
         *
         * The agreement is the truth, so the deal is a reading of it: a
         * contract that has not been signed has not closed a sale, whatever
         * the deal said a moment ago. Reverting a signature therefore reopens
         * the deal into Contracting — that transition is the one case where a
         * finished deal is allowed to move, because the document that finished
         * it has just said it did not.
         *
         * Terminated and expired are the exception in the other direction: the
         * contract ended, so the deal is lost rather than back in play.
         *
         * Signing itself is not here. It goes through `signAgreement`, which
         * also moves the money.
         */
        if (objectKey === 'agreement' && ('status' in values || 'deal_id' in values)) {
            const dealId = values.deal_id ?? before.deal_id;
            const status = values.status ?? before.status;

            if (['terminated', 'expired'].includes(status)) {
                moveDealForAgreement(ctx, dealId, 'lost',
                    `agreement ${before.number} ${status}`,
                    { loss_reason: `Agreement ${status}` });
            } else if (status !== 'signed') {
                moveDealForAgreement(ctx, dealId, 'contracting',
                    `agreement ${before.number} is ${status}, not signed`,
                    {},
                    // Only a signature being taken away reopens a closed deal.
                    { reopen: before.status === 'signed' && values.status && values.status !== 'signed' });
            }
        }
        // A contract's value and its deal's size are one commercial fact.
        if (objectKey === 'agreement'
            && ('contract_value' in values || 'currency' in values || 'deal_id' in values)) {
            syncAgreementAndDeal(ctx, recordId);
        }
        /**
         * And a document EDITED into review asks somebody too.
         *
         * The status is an ordinary editable field, so the record form and bulk
         * edit reach `pending_review` without going near `submitForReview` —
         * the same shape of hole `followStage` exists to close for deals.
         */
        if ((objectKey === 'proposal' || objectKey === 'agreement')
            && values.status === 'pending_review' && before.status !== 'pending_review') {
            openApprovalTask(ctx, objectKey, getRecord(objectKey, ctx, recordId));
        }
        // Edits to the person on the account form reach the CONTACT, which is
        // where that person lives. Only what the payload actually carried.
        if (objectKey === 'account') syncPrimaryContact(ctx, recordId, input, { source });
        reindex(objectKey, ctx.workspaceId, recordId);
        return getRecord(objectKey, ctx, recordId);
    });
}

/**
 * Soft delete. Nothing is destroyed on a user action — a mis-click at 5pm on a
 * Thursday should be recoverable on Friday. Hard delete is a separate, audited
 * job that must also reach evidence snapshots, exports and generated documents.
 */
export function deleteRecord(objectKey, ctx, recordId, { source = 'ui' } = {}) {
    const def = objectDef(objectKey);
    const before = get(`SELECT * FROM ${def.table} WHERE id = ? AND workspace_id = ?`, [recordId, ctx.workspaceId]);
    if (!before) throw notFound(`That ${def.label.toLowerCase()} does not exist.`);
    /**
     * Deleting is a CAPABILITY, and then an ownership question.
     *
     * `canWriteRecord` below answers the second. It never answered the first,
     * and this function is exported — api/records.mjs asks for `record.delete`
     * before calling it, and every other caller was trusted to remember. A rep
     * holds `record.write.own`, so a path that reached here without that check
     * let them bin their own accounts, which is most of the ones they touch.
     *
     * Asked here as well as at the route, because a rule enforced in one caller
     * is a rule the second caller does not have.
     */
    require$(ctx, 'record.delete');
    if (!canWriteRecord(ctx, before)) throw forbidden('You can only delete records you own.');

    /**
     * The document and the record it is a version of are the SAME commercial
     * fact (see the schema comment above the proposals table: "one record here
     * for one generated document there, joined by document_id"). Deleting one
     * and keeping the other leaves a proposal that points at a file which no
     * longer opens, or a file whose record is no longer in the sidebar. So the
     * delete cascades: binning the document trashes its proposal/agreement
     * record, and binning a generated proposal/agreement trashes its document.
     *
     * Found HERE rather than only in the frontend, so the trash is empty
     * however the delete arrived — through `/api/documents/:id`, through the
     * sidebar's `/api/proposals/:id`, or through the bulk endpoint.
     */
    const twin = findDocumentTwin(objectKey, before);

    /**
     * A SIGNED agreement is a contract, not a file to tidy up.
     *
     * `findDocumentTwin` has computed `signedAgreement` all along — this is
     * the check that reads it. Reachable from either side: deleting the
     * document a signed agreement renders as, or deleting the agreement
     * record itself. Blocking only one of those two doors is not a guard,
     * it is a detour — the account-level version of this same rule (see
     * `accountDependents`/the delete-preview above) now warns and cascades
     * rather than refusing outright, which is the right call for an account
     * that legitimately needs closing out; a live, signed, individual
     * contract has no equivalent "I meant to do this" path, so it stays a
     * hard refusal.
     */
    if (twin?.signedAgreement || (objectKey === 'agreement' && before.status === 'signed')) {
        throw badRequest(
            'This document is a signed agreement. Delete is blocked while a contract is live — '
            + 'terminate the agreement first.',
        );
    }

    return tx(() => {
        if (hasColumn(objectKey, 'deleted_at')) {
            update(def.table, recordId, { deleted_at: now() });
        } else {
            run(`DELETE FROM ${def.table} WHERE id = ?`, [recordId]);
        }
        audit(ctx, { objectKey, recordId, accountId: before.account_id ?? (objectKey === 'account' ? recordId : null), action: 'deleted', before, source });
        run('DELETE FROM search_index WHERE record_id = ?', [recordId]);

        if (twin) {
            // The second face of the deletion: the linked record or document,
            // written in the same transaction so neither the sidebar nor the
            // Documents tab can outlive the other. `findDocumentTwin` already
            // searched for a live twin, so this one is the record the document
            // is a version of, and it was not trashed before this delete.
            update(twin.table, twin.id, { deleted_at: now() });
            audit(ctx, {
                objectKey: twin.objectKey, recordId: twin.id,
                accountId: twin.accountId, action: 'deleted', before: twin.before, source,
            });
            run('DELETE FROM search_index WHERE record_id = ?', [twin.id]);
        }
        return { ok: true, id: recordId };
    });
}

/**
 * The proposal/agreement record a generated document is a version of — or the
 * document behind a generated proposal/agreement — so its delete can carry the
 * other half with it.
 *
 * Nullable either way: not every document has a record (uploads and
 * attachments), and not every proposal or agreement is generated (the older
 * line-item path has no `document_id`).
 *
 * `fromTrash` swaps which state the twin is searched in: a delete looks for a
 * LIVE twin to take with it, a restore looks for a TRASHED twin to bring back
 * with the record being restored.
 */
function findDocumentTwin(objectKey, before, { fromTrash = false } = {}) {
    const live = fromTrash ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL';
    if (objectKey === 'document') {
        // A generated document is the file of its proposal or agreement.
        // Only live records cascade — a record already in the trash is not
        // resurrected on a second delete, and a hard-purged one cannot be.
        const proposal = get(
            `SELECT * FROM proposals WHERE document_id = ? AND ${live}`,
            [before.id],
        );
        const agreement = get(
            `SELECT * FROM agreements WHERE document_id = ? AND ${live}`,
            [before.id],
        );
        const linked = proposal ?? agreement;
        if (!linked) return null;
        const table = proposal ? 'proposals' : 'agreements';
        return {
            table, id: linked.id,
            objectKey: proposal ? 'proposal' : 'agreement',
            accountId: linked.account_id,
            deletedAt: linked.deleted_at,
            before: linked,
            // The same live-contract guard a whole account gets: a signed
            // agreement is not thrown away by deleting "its document".
            signedAgreement: Boolean(agreement && agreement.status === 'signed' && !fromTrash),
        };
    }

    if (objectKey === 'proposal' || objectKey === 'agreement') {
        if (!before.document_id) return null;
        const document = get(
            `SELECT * FROM documents WHERE id = ? AND ${live}`,
            [before.document_id],
        );
        if (!document) return null;
        return {
            table: 'documents', id: document.id,
            objectKey: 'document', accountId: document.account_id,
            deletedAt: document.deleted_at, before: document, signedAgreement: false,
        };
    }

    return null;
}

/**
 * What still points at this row, discovered from the schema rather than a list.
 *
 * `PRAGMA foreign_key_list` is asked of every table once, so a table added
 * later is covered without anybody remembering to update a constant here. A
 * hand-written map of "things that reference an account" is exactly the kind of
 * list that is right the day it is written and wrong six months later — and
 * being wrong here means a permanent delete either fails with a raw SQLite
 * error or takes something with it that nobody was warned about.
 */
export function referencesTo(table, recordId) {
    if (!REFERENCE_MAP) REFERENCE_MAP = buildReferenceMap();

    const found = [];
    for (const ref of REFERENCE_MAP.get(table) ?? []) {
        // A cascading reference is not a blocker: the database already knows
        // what to do with it, and it exists precisely because the child has no
        // meaning without the parent.
        if (ref.onDelete === 'CASCADE') continue;
        const n = get(`SELECT COUNT(*) AS n FROM ${ref.table} WHERE ${ref.column} = ?`, [recordId])?.n ?? 0;
        if (n) found.push({ table: ref.table, column: ref.column, count: n });
    }

    /**
     * The polymorphic parents, which no foreign key describes.
     *
     * Tasks, activities, notes and documents point at their subject with a
     * `parent_type` / `parent_id` PAIR, and SQLite cannot express a foreign key
     * over that — so `PRAGMA foreign_key_list` reports nothing and the database
     * will happily let the parent be deleted. Missing them meant a purge left
     * tasks and notes pointing at an id that no longer resolves: they show up
     * in lists, open to nothing, and cannot be explained. Discovered by looking
     * for the column pair rather than listing the four tables, for the same
     * reason as above.
     */
    const objectKey = OBJECT_BY_TABLE[table];
    if (objectKey) {
        for (const t of polymorphicChildren()) {
            const n = get(
                `SELECT COUNT(*) AS n FROM ${t.table} WHERE ${t.typeColumn} = ? AND ${t.idColumn} = ?`,
                [objectKey, recordId],
            )?.n ?? 0;
            if (n) found.push({ table: t.table, column: t.idColumn, count: n });
        }
    }

    return found;
}

/**
 * What genuinely still points at a document being permanently deleted.
 *
 * The generic `referencesTo` cannot be answered for a document: its own plane —
 * the `document_generations` version row, the `document_events`, and the
 * proposal/agreement record that is the same commercial fact as the file —
 * would ALL appear as blockers, and a permanent delete would refuse on the very
 * rows it is the job of permanent deletion to reach (the blockers are deleted
 * in the same transaction, in `purgeRecord`).
 *
 * So only a LIVE proposal/agreement pointing at it as its `document_id`, or a
 * commercial registration imported from it, blocks — those are facts that
 * outlive the file and must be moved by hand. A trashed twin is not a blocker:
 * it went to the trash WITH the document, and goes with it for good.
 */
function blockersForDocument(recordId) {
    const found = [];
    for (const table of ['proposals', 'agreements']) {
        const n = get(
            `SELECT COUNT(*) AS n FROM ${table} WHERE document_id = ? AND deleted_at IS NULL`,
            [recordId],
        )?.n ?? 0;
        if (n) found.push({ table, column: 'document_id', count: n });
    }
    const registrations = get(
        'SELECT COUNT(*) AS n FROM commercial_registrations WHERE source_document_id = ?',
        [recordId],
    )?.n ?? 0;
    if (registrations) found.push({ table: 'commercial_registrations', column: 'source_document_id', count: registrations });
    return found;
}

/**
 * Every foreign key in the database, in ONE statement.
 *
 * This used to ask each table in turn — `PRAGMA foreign_key_list` per table,
 * and `PRAGMA table_info` per table again below. On a file database that is 119
 * instant calls; on a hosted one it is 119 network round trips, and it made the
 * first permanent delete after a restart take 8.4 seconds. The driver blocks
 * while it waits, so the whole server stopped answering for that long and
 * Render returned 502. Joined against sqlite_master, the same pragmas are two
 * statements.
 *
 * The pragma is still the source of truth, so a table added later is still
 * covered without anybody updating a list here — that was the point of asking
 * the database in the first place.
 *
 * If this throws it must be allowed to throw. The old version caught per-table
 * failures and carried on, which sounds defensive but produced an INCOMPLETE
 * reference map — and an incomplete map means `purgeRecord` finds no blockers
 * and destroys a record something still points at. Failing loudly is the safe
 * behaviour here.
 */
function buildReferenceMap() {
    const map = new Map();
    const rows = all(
        `SELECT m.name AS child, f."table" AS parent, f."from" AS column, f.on_delete AS on_delete
           FROM sqlite_master m, pragma_foreign_key_list(m.name) f
          WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'`,
    );
    for (const row of rows) {
        if (!map.has(row.parent)) map.set(row.parent, []);
        map.get(row.parent).push({ table: row.child, column: row.column, onDelete: row.on_delete });
    }
    return map;
}

/**
 * Tables whose rows BELONG to a subject named by a (type, id) pair.
 *
 * `parent_type` only. A campaign membership uses the same shape but is a join
 * row, not a child: it carries no content of its own, so it is removed with the
 * record rather than standing in the way of removing it (see `purgeRecord`).
 */
let POLYMORPHIC_CACHE = null;

function polymorphicChildren() {
    if (POLYMORPHIC_CACHE) return POLYMORPHIC_CACHE;

    const columns = new Map();
    for (const row of all(
        `SELECT m.name AS tbl, p.name AS col
           FROM sqlite_master m, pragma_table_info(m.name) p
          WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'`,
    )) {
        if (!columns.has(row.tbl)) columns.set(row.tbl, new Set());
        columns.get(row.tbl).add(row.col);
    }

    POLYMORPHIC_CACHE = [];
    for (const [table, cols] of columns) {
        if (cols.has('parent_type') && cols.has('parent_id')) {
            POLYMORPHIC_CACHE.push({ table, typeColumn: 'parent_type', idColumn: 'parent_id' });
        }
    }
    return POLYMORPHIC_CACHE;
}

/** table name -> object key, so a polymorphic `parent_type` can be matched. */
const OBJECT_BY_TABLE = Object.fromEntries(Object.entries(OBJECTS).map(([key, def]) => [def.table, key]));

let REFERENCE_MAP = null;

function inClause(arr) {
    return arr.map(() => '?').join(',');
}

function chunkedRun(fn, ids, chunkSize = 500) {
    if (!ids || !ids.length) return;
    for (let i = 0; i < ids.length; i += chunkSize) {
        fn(ids.slice(i, i + chunkSize));
    }
}

/**
 * Detect all records dependent on an Account, directly and indirectly.
 * Tracing the complete dependency graph:
 * Account
 *  ├── Contacts (and their calling assignments, email verifications, polymorphic children)
 *  ├── Deals (and their line items, price periods, stage history, deal_contacts, polymorphic children)
 *  ├── Proposals (and their versions, agreement_proposals links, polymorphic children)
 *  ├── Agreements (and self-references, agreement_proposals links, polymorphic children)
 *  ├── Document Generations (and document_events)
 *  ├── Documents (and files on disk / blobs, document_events)
 *  ├── Commercial Registrations
 *  ├── HCM Service Selections
 *  ├── Tasks (polymorphic + direct)
 *  ├── Notes (polymorphic + direct)
 *  ├── Activities (polymorphic + direct)
 *  ├── Calling Assignments (direct + contact)
 *  ├── Evidence Snapshots & Verdicts
 *  └── Prospecting Companies (imported_account_id link)
 */
export function accountDependents(accountId, workspaceId) {
    const contactRows = all('SELECT id FROM contacts WHERE account_id = ?', [accountId]);
    const contactIds = contactRows.map((r) => r.id);

    const dealRows = all('SELECT id FROM deals WHERE account_id = ?', [accountId]);
    const dealIds = dealRows.map((r) => r.id);

    let proposalRows = all('SELECT id, document_id FROM proposals WHERE account_id = ?', [accountId]);
    if (dealIds.length) {
        chunkedRun((chunk) => {
            const more = all(`SELECT id, document_id FROM proposals WHERE deal_id IN (${inClause(chunk)})`, chunk);
            proposalRows = proposalRows.concat(more);
        }, dealIds);
    }
    const proposalMap = new Map();
    for (const p of proposalRows) proposalMap.set(p.id, p);
    const proposalIds = [...proposalMap.keys()];

    let agreementRows = all('SELECT id, document_id FROM agreements WHERE account_id = ?', [accountId]);
    if (dealIds.length) {
        chunkedRun((chunk) => {
            const more = all(`SELECT id, document_id FROM agreements WHERE deal_id IN (${inClause(chunk)})`, chunk);
            agreementRows = agreementRows.concat(more);
        }, dealIds);
    }
    const agreementMap = new Map();
    for (const a of agreementRows) agreementMap.set(a.id, a);
    const agreementIds = [...agreementMap.keys()];

    let docGenRows = all('SELECT id, document_id FROM document_generations WHERE account_id = ?', [accountId]);
    if (dealIds.length) {
        chunkedRun((chunk) => {
            const more = all(`SELECT id, document_id FROM document_generations WHERE deal_id IN (${inClause(chunk)})`, chunk);
            docGenRows = docGenRows.concat(more);
        }, dealIds);
    }
    if (contactIds.length) {
        chunkedRun((chunk) => {
            const more = all(`SELECT id, document_id FROM document_generations WHERE contact_id IN (${inClause(chunk)})`, chunk);
            docGenRows = docGenRows.concat(more);
        }, contactIds);
    }
    const docGenMap = new Map();
    for (const g of docGenRows) docGenMap.set(g.id, g);
    const docGenIds = [...docGenMap.keys()];

    const commRegRows = all('SELECT id, source_document_id FROM commercial_registrations WHERE account_id = ?', [accountId]);
    const commRegIds = commRegRows.map((r) => r.id);

    const hcmRows = all('SELECT account_id FROM hcm_service_selections WHERE account_id = ?', [accountId]);
    const hcmServiceCount = hcmRows.length;

    const docIdSet = new Set();
    const directDocRows = all('SELECT id, storage_key FROM documents WHERE account_id = ? OR (parent_type = ? AND parent_id = ?)', [accountId, 'account', accountId]);
    for (const d of directDocRows) docIdSet.add(d.id);

    function collectPolymorphicDocs(parentType, parentIds) {
        if (!parentIds.length) return;
        chunkedRun((chunk) => {
            const rows = all(`SELECT id, storage_key FROM documents WHERE parent_type = ? AND parent_id IN (${inClause(chunk)})`, [parentType, ...chunk]);
            for (const r of rows) docIdSet.add(r.id);
        }, parentIds);
    }
    collectPolymorphicDocs('deal', dealIds);
    collectPolymorphicDocs('contact', contactIds);
    collectPolymorphicDocs('proposal', proposalIds);
    collectPolymorphicDocs('agreement', agreementIds);

    for (const p of proposalMap.values()) if (p.document_id) docIdSet.add(p.document_id);
    for (const a of agreementMap.values()) if (a.document_id) docIdSet.add(a.document_id);
    for (const g of docGenMap.values()) if (g.document_id) docIdSet.add(g.document_id);
    for (const c of commRegRows) if (c.source_document_id) docIdSet.add(c.source_document_id);

    const docIds = [...docIdSet];
    let allDocRows = [];
    if (docIds.length) {
        chunkedRun((chunk) => {
            const rows = all(`SELECT id, storage_key FROM documents WHERE id IN (${inClause(chunk)})`, chunk);
            allDocRows = allDocRows.concat(rows);
        }, docIds);
    }

    const taskIdSet = new Set();
    const directTaskRows = all('SELECT id FROM tasks WHERE account_id = ? OR (parent_type = ? AND parent_id = ?)', [accountId, 'account', accountId]);
    for (const t of directTaskRows) taskIdSet.add(t.id);

    function collectPolymorphicTasks(parentType, parentIds) {
        if (!parentIds.length) return;
        chunkedRun((chunk) => {
            const rows = all(`SELECT id FROM tasks WHERE parent_type = ? AND parent_id IN (${inClause(chunk)})`, [parentType, ...chunk]);
            for (const r of rows) taskIdSet.add(r.id);
        }, parentIds);
    }
    collectPolymorphicTasks('deal', dealIds);
    collectPolymorphicTasks('contact', contactIds);
    collectPolymorphicTasks('proposal', proposalIds);
    collectPolymorphicTasks('agreement', agreementIds);
    const taskIds = [...taskIdSet];

    const noteIdSet = new Set();
    const directNoteRows = all('SELECT id FROM notes WHERE account_id = ? OR (parent_type = ? AND parent_id = ?)', [accountId, 'account', accountId]);
    for (const n of directNoteRows) noteIdSet.add(n.id);

    function collectPolymorphicNotes(parentType, parentIds) {
        if (!parentIds.length) return;
        chunkedRun((chunk) => {
            const rows = all(`SELECT id FROM notes WHERE parent_type = ? AND parent_id IN (${inClause(chunk)})`, [parentType, ...chunk]);
            for (const r of rows) noteIdSet.add(r.id);
        }, parentIds);
    }
    collectPolymorphicNotes('deal', dealIds);
    collectPolymorphicNotes('contact', contactIds);
    collectPolymorphicNotes('proposal', proposalIds);
    collectPolymorphicNotes('agreement', agreementIds);
    const noteIds = [...noteIdSet];

    const activityIdSet = new Set();
    const directActivityRows = all('SELECT id FROM activities WHERE account_id = ? OR (parent_type = ? AND parent_id = ?)', [accountId, 'account', accountId]);
    for (const a of directActivityRows) activityIdSet.add(a.id);

    function collectPolymorphicActivities(parentType, parentIds) {
        if (!parentIds.length) return;
        chunkedRun((chunk) => {
            const rows = all(`SELECT id FROM activities WHERE parent_type = ? AND parent_id IN (${inClause(chunk)})`, [parentType, ...chunk]);
            for (const r of rows) activityIdSet.add(r.id);
        }, parentIds);
    }
    collectPolymorphicActivities('deal', dealIds);
    collectPolymorphicActivities('contact', contactIds);
    collectPolymorphicActivities('proposal', proposalIds);
    collectPolymorphicActivities('agreement', agreementIds);
    const activityIds = [...activityIdSet];

    let callingRows = all('SELECT id FROM calling_assignments WHERE account_id = ?', [accountId]);
    if (contactIds.length) {
        chunkedRun((chunk) => {
            const rows = all(`SELECT id FROM calling_assignments WHERE contact_id IN (${inClause(chunk)})`, chunk);
            callingRows = callingRows.concat(rows);
        }, contactIds);
    }
    const callingMap = new Map();
    for (const c of callingRows) callingMap.set(c.id, c);
    const callingAssignmentIds = [...callingMap.keys()];

    const verdictRows = all('SELECT id FROM verdicts WHERE account_id = ?', [accountId]);
    const verdictIds = verdictRows.map((r) => r.id);
    const evidenceRows = all('SELECT id FROM evidence_snapshots WHERE account_id = ?', [accountId]);
    const evidenceIds = evidenceRows.map((r) => r.id);

    const items = [];
    if (dealIds.length) items.push({ table: 'deals', label: 'deals', count: dealIds.length });
    if (proposalIds.length) items.push({ table: 'proposals', label: 'proposals', count: proposalIds.length });
    if (agreementIds.length) items.push({ table: 'agreements', label: 'agreements', count: agreementIds.length });
    if (docIds.length) items.push({ table: 'documents', label: 'documents', count: docIds.length });
    if (docGenIds.length) items.push({ table: 'document_generations', label: 'document generations', count: docGenIds.length });
    if (taskIds.length) items.push({ table: 'tasks', label: 'tasks', count: taskIds.length });
    if (noteIds.length) items.push({ table: 'notes', label: 'notes', count: noteIds.length });
    if (activityIds.length) items.push({ table: 'activities', label: 'activities', count: activityIds.length });
    if (contactIds.length) items.push({ table: 'contacts', label: 'contacts', count: contactIds.length });
    if (callingAssignmentIds.length) items.push({ table: 'calling_assignments', label: 'calling assignments', count: callingAssignmentIds.length });
    if (commRegIds.length) items.push({ table: 'commercial_registrations', label: 'commercial registrations', count: commRegIds.length });

    const total = items.reduce((acc, it) => acc + it.count, 0);

    return {
        accountId,
        contactIds,
        dealIds,
        proposalIds,
        agreementIds,
        docGenIds,
        commRegIds,
        hcmServiceCount,
        docIds,
        allDocRows,
        taskIds,
        noteIds,
        activityIds,
        callingAssignmentIds,
        verdictIds,
        evidenceIds,
        items,
        total,
    };
}

export function purgeAccount(ctx, accountId, before) {
    const deps = accountDependents(accountId, ctx.workspaceId);

    return tx(() => {
        // 1. Clear foreign key reference on imported prospecting company
        run('UPDATE prospecting_companies SET imported_account_id = NULL WHERE imported_account_id = ?', [accountId]);

        // 2. Break self-referencing / cycles on agreements, proposals, registrations, and generations
        if (deps.agreementIds.length) {
            chunkedRun((chunk) => {
                run(`UPDATE agreements SET supersedes_agreement_id = NULL, document_id = NULL WHERE id IN (${inClause(chunk)})`, chunk);
            }, deps.agreementIds);
        }
        if (deps.proposalIds.length) {
            chunkedRun((chunk) => {
                run(`UPDATE proposals SET document_id = NULL WHERE id IN (${inClause(chunk)})`, chunk);
            }, deps.proposalIds);
        }
        if (deps.commRegIds.length) {
            chunkedRun((chunk) => {
                run(`UPDATE commercial_registrations SET source_document_id = NULL WHERE id IN (${inClause(chunk)})`, chunk);
            }, deps.commRegIds);
        }
        if (deps.docGenIds.length) {
            chunkedRun((chunk) => {
                run(`UPDATE document_generations SET document_id = NULL WHERE id IN (${inClause(chunk)})`, chunk);
            }, deps.docGenIds);
        }

        // 3. Document events (cascading / leaf)
        if (deps.docGenIds.length) {
            chunkedRun((chunk) => {
                run(`DELETE FROM document_events WHERE generation_id IN (${inClause(chunk)})`, chunk);
            }, deps.docGenIds);
        }
        if (deps.docIds.length) {
            chunkedRun((chunk) => {
                run(`DELETE FROM document_events WHERE document_id IN (${inClause(chunk)})`, chunk);
            }, deps.docIds);
        }

        // 4. Agreement proposals & Proposal versions
        if (deps.agreementIds.length) {
            chunkedRun((chunk) => {
                run(`DELETE FROM agreement_proposals WHERE agreement_id IN (${inClause(chunk)})`, chunk);
            }, deps.agreementIds);
        }
        if (deps.proposalIds.length) {
            chunkedRun((chunk) => {
                run(`DELETE FROM agreement_proposals WHERE proposal_version_id IN (SELECT id FROM proposal_versions WHERE proposal_id IN (${inClause(chunk)}))`, chunk);
                run(`DELETE FROM proposal_versions WHERE proposal_id IN (${inClause(chunk)})`, chunk);
            }, deps.proposalIds);
        }

        // 5. Agreements
        if (deps.agreementIds.length) {
            chunkedRun((chunk) => {
                run(`DELETE FROM agreements WHERE id IN (${inClause(chunk)})`, chunk);
            }, deps.agreementIds);
        }

        // 6. Commercial registrations
        if (deps.commRegIds.length) {
            chunkedRun((chunk) => {
                run(`DELETE FROM commercial_registrations WHERE id IN (${inClause(chunk)})`, chunk);
            }, deps.commRegIds);
        }

        // 7. Document generations
        if (deps.docGenIds.length) {
            chunkedRun((chunk) => {
                run(`DELETE FROM document_generations WHERE id IN (${inClause(chunk)})`, chunk);
            }, deps.docGenIds);
        }

        // 8. Proposals
        if (deps.proposalIds.length) {
            chunkedRun((chunk) => {
                run(`DELETE FROM proposals WHERE id IN (${inClause(chunk)})`, chunk);
            }, deps.proposalIds);
        }

        // 9. Deals children (line items, price periods, stage history, contacts)
        if (deps.dealIds.length) {
            chunkedRun((chunk) => {
                run(`DELETE FROM deal_contacts WHERE deal_id IN (${inClause(chunk)})`, chunk);
                run(`DELETE FROM deal_line_items WHERE deal_id IN (${inClause(chunk)})`, chunk);
                run(`DELETE FROM deal_price_periods WHERE deal_id IN (${inClause(chunk)})`, chunk);
                run(`DELETE FROM deal_stage_history WHERE deal_id IN (${inClause(chunk)})`, chunk);
            }, deps.dealIds);
        }
        if (deps.contactIds.length) {
            chunkedRun((chunk) => {
                run(`DELETE FROM deal_contacts WHERE contact_id IN (${inClause(chunk)})`, chunk);
            }, deps.contactIds);
        }

        // 10. Calling assignments
        run('DELETE FROM calling_assignments WHERE account_id = ?', [accountId]);
        if (deps.contactIds.length) {
            chunkedRun((chunk) => {
                run(`DELETE FROM calling_assignments WHERE contact_id IN (${inClause(chunk)})`, chunk);
            }, deps.contactIds);
        }

        // 11. Email verifications
        run('DELETE FROM email_verifications WHERE (subject_type = ? AND subject_id = ?)', ['account', accountId]);
        if (deps.contactIds.length) {
            chunkedRun((chunk) => {
                run(`DELETE FROM email_verifications WHERE subject_type = 'contact' AND subject_id IN (${inClause(chunk)})`, chunk);
            }, deps.contactIds);
        }

        // 12. Tasks, Notes, Activities
        if (deps.taskIds.length) {
            chunkedRun((chunk) => {
                run(`DELETE FROM tasks WHERE id IN (${inClause(chunk)})`, chunk);
            }, deps.taskIds);
        }
        if (deps.noteIds.length) {
            chunkedRun((chunk) => {
                run(`DELETE FROM notes WHERE id IN (${inClause(chunk)})`, chunk);
            }, deps.noteIds);
        }
        if (deps.activityIds.length) {
            chunkedRun((chunk) => {
                run(`DELETE FROM activities WHERE id IN (${inClause(chunk)})`, chunk);
            }, deps.activityIds);
        }

        // 13. Documents and their files on disk
        for (const doc of deps.allDocRows) {
            if (doc.storage_key && !doc.storage_key.startsWith('proposal:')) {
                try {
                    removeFile(doc.storage_key);
                } catch {
                    // file might already be absent on disk
                }
            }
        }
        if (deps.docIds.length) {
            chunkedRun((chunk) => {
                run(`DELETE FROM documents WHERE id IN (${inClause(chunk)})`, chunk);
            }, deps.docIds);
        }

        // 14. Deals
        if (deps.dealIds.length) {
            chunkedRun((chunk) => {
                run(`DELETE FROM deals WHERE id IN (${inClause(chunk)})`, chunk);
            }, deps.dealIds);
        }

        // 15. Contacts
        if (deps.contactIds.length) {
            chunkedRun((chunk) => {
                run(`DELETE FROM contacts WHERE id IN (${inClause(chunk)})`, chunk);
            }, deps.contactIds);
        }

        // 16. HCM Service Selections
        run('DELETE FROM hcm_service_selections WHERE account_id = ?', [accountId]);

        // 17. Verdicts & Evidence Snapshots
        run('DELETE FROM verdicts WHERE account_id = ?', [accountId]);
        run('DELETE FROM evidence_snapshots WHERE account_id = ?', [accountId]);

        // 18. Clean join/index tables (list_members, campaign_members, search_index)
        const allDeletedIds = [
            accountId,
            ...deps.contactIds,
            ...deps.dealIds,
            ...deps.proposalIds,
            ...deps.agreementIds,
            ...deps.docIds,
            ...deps.taskIds,
            ...deps.noteIds,
            ...deps.activityIds,
        ];
        chunkedRun((chunk) => {
            run(`DELETE FROM list_members WHERE record_id IN (${inClause(chunk)})`, chunk);
            run(`DELETE FROM search_index WHERE record_id IN (${inClause(chunk)})`, chunk);
        }, allDeletedIds);

        run('DELETE FROM campaign_members WHERE member_type = ? AND member_id = ?', ['account', accountId]);
        run('DELETE FROM campaign_members WHERE account_id = ?', [accountId]);
        if (deps.contactIds.length) {
            chunkedRun((chunk) => {
                run(`DELETE FROM campaign_members WHERE member_type = 'contact' AND member_id IN (${inClause(chunk)})`, chunk);
            }, deps.contactIds);
        }

        // 19. The Account row itself
        run('DELETE FROM accounts WHERE id = ?', [accountId]);

        // 20. Audit event
        audit(ctx, {
            objectKey: 'account',
            recordId: accountId,
            accountId,
            action: 'purged',
            before,
        });

        return { ok: true, id: accountId, purged: true };
    });
}

/** Rows that belong to a subject and mean nothing without it. */
const OWNED_BY_SUBJECT = {
    accounts: ['evidence_snapshots.account_id', 'verdicts.account_id'],
    prospecting_companies: ['prospecting_evidence_snapshots.prospect_id', 'prospecting_verdicts.prospect_id'],
};

/**
 * A contact's own history means nothing without the contact, and used to
 * block deleting it anyway.
 *
 * A cold-calling contact has a calling assignment and at least one call
 * activity practically by definition — that is the whole job the module
 * does to it — so the generic `referencesTo` check refused to permanently
 * delete almost every contact that had ever been worked, with no way to
 * proceed short of hand-deleting its own call history first. `purgeAccount`
 * already treats an account's calling assignments and activities as owned
 * rather than blocking; this is the same call one object down. Anything
 * else pointing at the contact — a document generated with it named as the
 * signatory, say — still blocks, same as before.
 */
function purgeContact(ctx, contactId, before) {
    const OWNED_TABLES = new Set(['calling_assignments', 'activities', 'tasks', 'notes']);
    const blockers = referencesTo('contacts', contactId).filter((b) => !OWNED_TABLES.has(b.table));
    if (blockers.length) {
        const named = blockers.map((b) => `${b.count} in ${b.table}`).join(', ');
        throw badRequest(
            `${blockers.reduce((n, b) => n + b.count, 0)} other record(s) still point at this one (${named}). `
            + 'Permanent delete is refused while anything references it — remove or reassign those first.',
        );
    }

    return tx(() => {
        run('DELETE FROM calling_assignments WHERE contact_id = ?', [contactId]);
        run(`DELETE FROM activities WHERE parent_type = 'contact' AND parent_id = ?`, [contactId]);
        run(`DELETE FROM tasks WHERE parent_type = 'contact' AND parent_id = ?`, [contactId]);
        run(`DELETE FROM notes WHERE parent_type = 'contact' AND parent_id = ?`, [contactId]);
        // Optional and rarely populated — the document generation itself is
        // the record that matters, so it loses the name rather than the
        // permanent delete refusing on a column nobody is using to find it.
        run('UPDATE document_generations SET contact_id = NULL WHERE contact_id = ?', [contactId]);
        // The generic purge path (below) does this too — a contact taking
        // its own dedicated path must not skip it, or the purged contact's
        // name/title/email keeps surfacing in global search forever with
        // nothing behind it.
        run('DELETE FROM search_index WHERE record_id = ?', [contactId]);
        run('DELETE FROM contacts WHERE id = ?', [contactId]);

        audit(ctx, {
            objectKey: 'contact',
            recordId: contactId,
            accountId: before.account_id ?? null,
            action: 'purged',
            before,
        });

        return { ok: true, id: contactId, purged: true };
    });
}

/**
 * Permanent delete. There is no undo, and the code says so out loud.
 *
 * Three properties make this safe enough to expose in the UI:
 *
 *  1. It only ever operates on a row that is ALREADY in the trash. Deleting is
 *     one decision and destroying is a second one, taken later, with the record
 *     sitting in a view called Deleted in between.
 *  2. For non-account records, it refuses while anything still points at the row, and names what.
 *     For accounts, it cascades and safely destroys all account-owned dependent records in topological order.
 *  3. The audit event survives it. `audit_events.record_id` carries no foreign
 *     key for exactly this reason: the record goes, the fact that it existed
 *     and who destroyed it does not.
 */
export function purgeRecord(objectKey, ctx, recordId) {
    const def = objectDef(objectKey);
    const before = get(`SELECT * FROM ${def.table} WHERE id = ? AND workspace_id = ?`, [recordId, ctx.workspaceId]);
    if (!before) throw notFound(`That ${def.label.toLowerCase()} does not exist.`);
    if (!canWriteRecord(ctx, before)) throw forbidden('You can only delete records you own.');

    if (hasColumn(objectKey, 'deleted_at') && !before.deleted_at) {
        throw badRequest(
            `That ${def.label.toLowerCase()} is not in the trash. Delete it first — permanent delete is deliberately `
            + 'a second decision, taken after the first one has had time to be regretted.',
        );
    }

    if (objectKey === 'account') {
        return purgeAccount(ctx, recordId, before);
    }
    if (objectKey === 'contact') {
        return purgeContact(ctx, recordId, before);
    }

    const blockers = objectKey === 'document'
        ? blockersForDocument(recordId)
        : referencesTo(def.table, recordId);
    if (blockers.length) {
        const named = blockers.map((b) => `${b.count} in ${b.table}`).join(', ');
        throw badRequest(
            `${blockers.reduce((n, b) => n + b.count, 0)} other record(s) still point at this one (${named}). `
            + 'Permanent delete is refused while anything references it — remove or reassign those first.',
        );
    }

    return tx(() => {
        for (const owned of OWNED_BY_SUBJECT[def.table] ?? []) {
            const [table, column] = owned.split('.');
            run(`DELETE FROM ${table} WHERE ${column} = ?`, [recordId]);
        }

        /**
         * A document's own plane: the version history, its events, and the
         * proposal/agreement record that went to the trash with it.
         *
         * `referencesTo` excludes these from blocking (see `blockersForDocument`),
         * so the permanent delete reaches them here rather than refusing on its
         * own governance: a "permanent" delete that keeps a generation pointing
         * at a file that no longer exists is not one.
         */
        if (objectKey === 'document') {
            run('DELETE FROM document_generations WHERE document_id = ?', [recordId]);
            run('DELETE FROM document_events WHERE document_id = ?', [recordId]);
            for (const table of ['proposals', 'agreements']) {
                const twin = get(`SELECT id FROM ${table} WHERE document_id = ? AND deleted_at IS NOT NULL`, [recordId]);
                if (twin) {
                    run('DELETE FROM search_index WHERE record_id = ?', [twin.id]);
                    run(`DELETE FROM ${table} WHERE id = ?`, [twin.id]);
                }
            }
        }

        /**
         * The other half of the cascade, on the way out: permanently deleting a
         * generated proposal/agreement is permanently deleting the file it is a
         * version of. The document row, its generation and its events are owned
         * by the record, so they go with it.
         */
        if ((objectKey === 'proposal' || objectKey === 'agreement') && before.document_id) {
            // Same registration guard as the document purge: a commercial
            // registration imported from this file still needs it, so the file
            // is left for a human to move first.
            const registered = get(
                'SELECT COUNT(*) AS n FROM commercial_registrations WHERE source_document_id = ?',
                [before.document_id],
            )?.n ?? 0;
            if (!registered) {
                run('DELETE FROM document_generations WHERE document_id = ?', [before.document_id]);
                run('DELETE FROM document_events WHERE document_id = ?', [before.document_id]);
                const doc = get('SELECT storage_key, name FROM documents WHERE id = ?', [before.document_id]);
                if (doc?.storage_key && !doc.storage_key.startsWith('proposal:')) {
                    try { removeFile(doc.storage_key); } catch { /* the row is going regardless */ }
                }
                run('DELETE FROM documents WHERE id = ?', [before.document_id]);
            }
        }
        // Join rows, not children: they carry no content of their own, so they
        // go with the record instead of blocking it. A list or a campaign that
        // quietly loses one member is the correct outcome of destroying it.
        run('DELETE FROM list_members WHERE record_id = ?', [recordId]);
        run('DELETE FROM campaign_members WHERE member_type = ? AND member_id = ?', [objectKey, recordId]);
        run('DELETE FROM email_verifications WHERE subject_type = ? AND subject_id = ?', [objectKey, recordId]);
        run('DELETE FROM search_index WHERE record_id = ?', [recordId]);
        run(`DELETE FROM ${def.table} WHERE id = ?`, [recordId]);

        /**
         * The bytes, too.
         *
         * A "permanent" delete that leaves the file on disk is not one — and
         * for a document holding a signed agreement or a client's data, the
         * file is the thing being deleted. Proposals render from the database
         * (`proposal:<id>`) and have no file of their own.
         */
        if (objectKey === 'document' && before.storage_key && !before.storage_key.startsWith('proposal:')) {
            try {
                removeFile(before.storage_key);
            } catch { /* the row is going regardless; a missing file is not a reason to keep it */ }
        }

        // Written AFTER the row is gone, and it keeps the whole before-image.
        // "Deleted permanently" with no record of what was in it answers the
        // question nobody asks until months later.
        audit(ctx, {
            objectKey,
            recordId,
            accountId: before.account_id ?? (objectKey === 'account' ? recordId : null),
            action: 'purged',
            before,
        });
        return { ok: true, id: recordId, purged: true };
    });
}

export function restoreRecord(objectKey, ctx, recordId) {
    const def = objectDef(objectKey);
    if (!hasColumn(objectKey, 'deleted_at')) throw badRequest('That object cannot be restored.');
    const row = get(`SELECT * FROM ${def.table} WHERE id = ? AND workspace_id = ?`, [recordId, ctx.workspaceId]);
    if (!row) throw notFound('That record does not exist.');
    return tx(() => {
        update(def.table, recordId, { deleted_at: null });
        audit(ctx, { objectKey, recordId, action: 'restored', after: { deleted_at: null } });
        reindex(objectKey, ctx.workspaceId, recordId);

        /**
         * The twin that went to the trash together comes back together.
         *
         * `deleteRecord` bins a generated document with its proposal/agreement
         * record (and vice versa); a restore that brought only one half back
         * would recreate the orphan the cascade exists to prevent.
         *
         * The twin is searched WITHOUT the live filter, the opposite of the
         * delete-side search: the record being restored is in the trash, and
         * the twin that went with it is too.
         */
        const twin = findDocumentTwin(objectKey, row, { fromTrash: true });
        if (twin && twin.deletedAt) {
            update(twin.table, twin.id, { deleted_at: null });
            audit(ctx, { objectKey: twin.objectKey, recordId: twin.id, accountId: twin.accountId, action: 'restored', after: { deleted_at: null } });
            reindex(twin.objectKey, ctx.workspaceId, twin.id);
        }
        return { ...getRecord(objectKey, ctx, recordId), restoredTwin: twin?.objectKey ?? null };
    });
}

/* ------------------------------------------------------------ validation -- */

/**
 * Coerces and checks input against the field definitions, and returns only the
 * columns that were actually supplied. Unknown keys are dropped rather than
 * rejected, so a client sending a hydrated record straight back does not fail
 * on the computed fields it received.
 */
export function validate(objectKey, ctx, input, { creating, existing } = {}) {
    const fields = fieldsFor(objectKey, ctx.workspaceId, { includeComputed: false });
    const out = {};
    const properties = existing ? json(existing.properties, {}) : {};
    let touchedProperties = false;
    const errors = [];

    for (const field of fields) {
        if (field.readOnly) continue;
        const supplied = field.custom
            ? (input.properties && Object.prototype.hasOwnProperty.call(input.properties, field.property))
            : Object.prototype.hasOwnProperty.call(input, field.key);

        if (!supplied) {
            // A default satisfies a requirement. Demanding a value the system
            // already knows turns every API caller and every importer into a
            // place that has to repeat the default — and eventually disagree
            // with it.
            if (creating && field.default !== null && field.default !== undefined) {
                out[field.column] = field.default;
            } else if (creating && field.required && !field.custom) {
                errors.push(`${field.label} is required.`);
            }
            continue;
        }

        const raw = field.custom ? input.properties[field.property] : input[field.key];
        let value;
        try {
            value = coerce(field, raw);
        } catch (err) {
            errors.push(err.message);
            continue;
        }

        /**
         * A field that knows how to read what people actually paste.
         *
         * Applied on every write, so the API, the form and an import all store
         * the same shape. The importer already normalised LinkedIn URLs; the
         * form did not, which is the one way a full URL could get into a column
         * whose value is an identity other tables are keyed on.
         */
        if (typeof field.normalise === 'function' && value !== null && value !== '') {
            value = field.normalise(value);
        }

        if (field.required && (value === null || value === '')) {
            errors.push(`${field.label} is required.`);
            continue;
        }

        // A reference must point at something real, in this workspace. Checked
        // here rather than left to a foreign key so the message names the field
        // — "That campaign does not exist" beats "FOREIGN KEY constraint
        // failed", and an importer can report it per row.
        if (field.references && value) {
            const target = get(
                `SELECT id FROM ${field.references} WHERE id = ? AND workspace_id = ?`,
                [value, ctx.workspaceId],
            );
            if (!target) {
                errors.push(`${field.label}: no ${field.references.replace(/s$/, '')} with id "${value}" exists in this workspace.`);
                continue;
            }
        }

        if (field.custom) {
            properties[field.property] = value;
            touchedProperties = true;
        } else if (field.column) {
            out[field.column] = value;
        }
        /**
         * A field with NO column has been validated and is deliberately not
         * stored here — it belongs to another record. The account's four
         * primary-contact fields are the case: see `syncPrimaryContact`. It is
         * dropped rather than written, because writing it would need a column
         * on this table and that column is the duplicate the whole arrangement
         * exists to avoid.
         */
    }

    // Attachment parents come in as plain keys and are not field definitions.
    for (const key of ['parent_type', 'parent_id', 'account_id', 'deal_id']) {
        if (hasColumn(objectKey, key) && Object.prototype.hasOwnProperty.call(input, key) && out[key] === undefined) {
            out[key] = input[key] || null;
        }
    }

    if (touchedProperties) out.properties = JSON.stringify(properties);
    if (errors.length) throw badRequest(errors[0], { errors });
    return out;
}

function coerce(field, raw) {
    if (raw === '' || raw === null || raw === undefined) {
        return field.type === 'checkbox' ? 0 : null;
    }
    switch (field.type) {
        case 'number':
        case 'currency':
        case 'percent': {
            const n = Number(raw);
            if (!Number.isFinite(n)) throw new Error(`${field.label} must be a number.`);
            return n;
        }
        case 'checkbox':
            return raw === true || raw === 1 || raw === '1' || raw === 'true' ? 1 : 0;
        case 'email': {
            const s = String(raw).trim().toLowerCase();
            if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) throw new Error(`Enter a valid email for ${field.label}.`);
            return s;
        }
        case 'url': {
            const s = String(raw).trim();
            return /^https?:\/\//i.test(s) ? s : `https://${s}`;
        }
        case 'select': {
            const s = String(raw);
            if (field.options?.length && !field.options.includes(s)) {
                throw new Error(`${field.label} must be one of: ${field.options.join(', ')}.`);
            }
            return s;
        }
        case 'multiselect': {
            const list = Array.isArray(raw) ? raw.map(String) : String(raw).split(',').map((s) => s.trim()).filter(Boolean);
            if (field.options?.length) {
                const bad = list.find((v) => !field.options.includes(v));
                if (bad) throw new Error(`"${bad}" is not a valid ${field.label}.`);
            }
            return JSON.stringify(list);
        }
        case 'date':
            return String(raw).slice(0, 10);
        case 'datetime': {
            const d = new Date(raw);
            if (Number.isNaN(d.getTime())) throw new Error(`${field.label} is not a valid date.`);
            return d.toISOString();
        }
        default:
            return String(raw);
    }
}

/**
 * The admin's conversion rates, once per hydration rather than once per row.
 *
 * `reportingRates` reads three settings, and settings are cached per process —
 * but building the object for every deal in a page of two hundred is still two
 * hundred allocations and three cache lookups each, on the hot path of every
 * list. Held against the ctx, which lives for one request.
 */
function reportingRatesFor(ctx) {
    if (!ctx) return reportingRates(() => undefined);
    if (!ctx._reportingRates) {
        ctx._reportingRates = reportingRates((key) => setting(ctx.workspaceId, key));
    }
    return ctx._reportingRates;
}

/* ----------------------------------------------------------- enrichment -- */

/**
 * Attaches the values that are computed rather than stored: owner names,
 * account names, current verdicts, derived deal money. Done in bulk per page
 * (a handful of queries), never per row.
 */
export function hydrate(objectKey, rows, ctx) {
    if (!rows.length) return [];

    const userIds = new Set();
    const accountIds = new Set();
    const dealIds = new Set();
    const campaignIds = new Set();
    const prospectIds = new Set();
    for (const r of rows) {
        for (const k of ['owner_id', 'assignee_id', 'actor_id', 'author_id', 'uploaded_by', 'created_by', 'reviewed_by']) {
            if (r[k]) userIds.add(r[k]);
        }
        if (r.account_id) accountIds.add(r.account_id);
        if (objectKey === 'account') accountIds.add(r.id);
        if (r.deal_id) dealIds.add(r.deal_id);
        if (objectKey === 'deal') dealIds.add(r.id);
        if (r.campaign_id) campaignIds.add(r.campaign_id);
        // A prospecting contact points at a prospect, not an account. Without
        // this the Prospect column on that list renders a raw `pro_…` id.
        if (r.prospect_id) prospectIds.add(r.prospect_id);
    }

    const users = lookup('SELECT id, name, email FROM users WHERE id IN', [...userIds]);
    const accounts = objectKey === 'account'
        ? new Map()
        // `billing_currency` rides along because a deal that never had a
        // currency typed on it falls back to its account's, below.
        : lookup('SELECT id, name, lifecycle_stage, billing_currency FROM accounts WHERE id IN', [...accountIds]);
    const deals = objectKey === 'deal' ? new Map() : lookup('SELECT id, name, status FROM deals WHERE id IN', [...dealIds]);
    const campaigns = campaignIds.size ? lookup('SELECT id, name, status FROM campaigns WHERE id IN', [...campaignIds]) : new Map();
    const prospects = prospectIds.size
        ? lookup('SELECT id, name, status FROM prospecting_companies WHERE id IN', [...prospectIds])
        : new Map();

    /**
     * The account's earliest contact, filled back into the four form-only
     * fields so opening the form shows the person already on record instead of
     * an empty set of boxes that would create a second copy of them on save.
     *
     * ONE statement for the whole page, not one per account: the driver blocks
     * on every round trip, so an N+1 here would cost a list of fifty accounts
     * fifty of them. Earliest by `created_at` matches `syncPrimaryContact`, so
     * the form reads back exactly the record a save would write to.
     */
    const primaryContacts = objectKey === 'account' && accountIds.size
        ? all(
            `SELECT account_id, first_name, last_name, title, email,
                    ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY created_at, rowid) AS seq
               FROM contacts
              WHERE workspace_id = ? AND deleted_at IS NULL
                AND account_id IN (${[...accountIds].map(() => '?').join(',')})`,
            [ctx.workspaceId, ...accountIds],
        ).filter((c) => c.seq === 1)
        : [];
    const primaryContact = new Map(primaryContacts.map((c) => [c.account_id, c]));

    let verdicts = new Map();
    let dealValues = new Map();
    let stages = new Map();
    let campaignRollup = new Map();

    // Verdicts hydrate for any object that declares an evidence plane, not just
    // accounts — otherwise a prospecting list renders a verdict column that is
    // permanently UNRESOLVED while the verdicts sit right there in the database.
    /**
     * And only for somebody who may READ prospecting.
     *
     * The verdict columns hang off accounts as well as prospects, so an account
     * list handed a rep every QUALIFIED/REJECTED call the sourcing engine had
     * made — the conclusion of a plane their role does not include. The
     * endpoints that serve verdicts directly are refused in lib/auth.mjs; this
     * is the same rule where the data rides along with something else.
     */
    const plane = ctx && !can(ctx, 'prospecting.read') ? null : verdictPlane(objectKey);
    if (plane && rows.length) {
        verdicts = currentVerdictsFor(rows.map((r) => r.id), plane);
    }
    if (objectKey === 'campaign') {
        campaignRollup = campaignRollupFor(rows.map((r) => r.id), {
            baseCurrency: ctx?.workspace?.baseCurrency ?? 'USD',
        });
    }
    if (objectKey === 'deal' && dealIds.size) {
        dealValues = dealValuesFor([...dealIds], ctx);
        stages = lookup(
            'SELECT s.id, s.label, s.key, s.type, s.probability, s.pipeline_id FROM stages s WHERE s.id IN',
            rows.map((r) => r.stage_id).filter(Boolean),
        );
    }

    /**
     * A multiselect is stored as a JSON array and has to come back as one.
     *
     * It went out as the raw string, and every consumer checks `Array.isArray`
     * before doing anything with it — the checkbox group in `fieldControl`, the
     * badges in `cellContent`. So an account's Services rendered blank however
     * many services it had, on the form and in the list alike, while the server
     * (which parses with `json()` everywhere it reads them) saw them fine. The
     * data was never wrong; only the shape it was handed over in.
     */
    const multi = multiselectKeys(objectKey);

    return rows.map((row) => {
        const out = { ...row };
        out.properties = json(row.properties, {});

        // The four form-only fields, read back off the contact they write to.
        if (objectKey === 'account') {
            const person = primaryContact.get(row.id) ?? null;
            out.contact_first_name = person?.first_name ?? null;
            out.contact_last_name = person?.last_name ?? null;
            out.contact_title = person?.title ?? null;
            out.contact_email = person?.email ?? null;
        }
        if (typeof row.roles === 'string') out.roles = json(row.roles, []);
        if (typeof row.mentions === 'string') out.mentions = json(row.mentions, []);
        for (const key of multi) {
            if (typeof row[key] === 'string') out[key] = json(row[key], []);
        }

        for (const k of ['owner_id', 'assignee_id', 'actor_id', 'author_id', 'uploaded_by', 'created_by', 'reviewed_by']) {
            if (row[k]) out[`${k.replace(/_id$|_by$/, '')}_name`] = users.get(row[k])?.name ?? 'Unknown';
        }
        if (row.account_id && accounts.has(row.account_id)) {
            out.account_name = accounts.get(row.account_id).name;
        }
        if (row.deal_id && deals.has(row.deal_id)) out.deal_name = deals.get(row.deal_id).name;
        if (row.campaign_id && campaigns.has(row.campaign_id)) out.campaign_name = campaigns.get(row.campaign_id).name;

        if (plane) {
            const v = verdicts.get(row.id) ?? {};
            out.verdicts = v;
            out.verdict_hcm = v.hcm?.verdict ?? 'UNRESOLVED';
            out.verdict_offshoring = v.offshoring?.verdict ?? 'UNRESOLVED';
        }
        if (objectKey === 'deal') {
            const stage = stages.get(row.stage_id);
            out.stage_label = stage?.label ?? null;
            out.stage_type = stage?.type ?? 'open';
            out.stage_probability = stage?.probability ?? 0;

            /**
             * The derived block carries a `currency` of its own — the one the
             * `value_*` figures are denominated in, which is the workspace base.
             * Assigned flat it overwrote the DEAL'S currency, so every deal came
             * back reporting the base currency whatever it was actually billed
             * in. Harmless while everything was SAR; wrong the moment a client
             * pays in EGP, and wrong in the direction that converts a figure
             * with the wrong rate.
             */
            const derived = dealValues.get(row.id) ?? emptyValue(ctx);
            Object.assign(out, derived);
            out.value_currency = derived.currency;

            /**
             * A deal with no currency of its own belongs to its ACCOUNT's.
             *
             * The fallback used to be the workspace base currency, which in
             * this workspace is SAR. That is not a neutral default: the USD
             * dashboard converts by this field, so an EGP deal that nobody
             * typed a currency on was divided by the SAR rate instead of the
             * EGP one and reported roughly thirteen times its real value. It
             * failed silently, because SAR HAS a rate — the unconvertible path
             * never fired.
             *
             * The account's billing currency is what the client actually pays
             * in and is already the source of truth for proposals and
             * agreements, so it is the honest answer here too. Resolved on read
             * rather than backfilled: no migration, and an account whose
             * currency is corrected later fixes its old deals with it.
             */
            out.currency = row.currency
                || accounts.get(row.account_id)?.billing_currency
                || derived.currency;

            /**
             * Deal size, and whether it repeats — on every deal that is read.
             *
             * `price` is the number somebody typed and `currency` is what the
             * client pays in; `billing_type` is the SERVICE's answer and is
             * therefore never stored on the deal, because a stored copy is a
             * copy that can disagree with the service it came from.
             */
            const line = serviceLine(ctx?.workspaceId, row.service_line_key);
            out.price = derived.price ?? null;
            if (derived.price_currency) out.currency = derived.price_currency;
            out.billing_type = billingTypeForPricingModel(line?.pricing_model);
            out.billing_type_label = billingTypeLabel(out.billing_type);
            out.service_line_label = line?.label ?? null;

            /**
             * THE SAME FIGURE IN USD, beside the one the client pays.
             *
             * The dashboard reports in USD because a book with EGP, SAR and USD
             * deals in it has no other honest total — and every deal SCREEN
             * reported the client's own currency, so the pipeline on the
             * dashboard and the deals making it up were quoted in different
             * units with nothing saying so. Somebody comparing an EGP 500,000
             * deal against a SAR 100,000 one was comparing two numbers that
             * differ by a factor of thirteen before the digits are even read.
             *
             * Converted from the deal's OWN figures at the admin's current
             * rates, never from the base-currency ones, so no amount ever has
             * two rates applied to it. Null rather than a guess when the
             * currency has no rate: reporting an unconvertible amount as though
             * it were dollars is worse than admitting the rate is missing, and
             * the screen says which it is.
             */
            const rates = reportingRatesFor(ctx);
            out.reporting_currency = REPORTING_CURRENCY;
            out.price_reporting = toReporting(out.price, out.currency, rates);
            out.one_time_reporting = toReporting(derived.own_one_time, out.currency, rates);
            out.mrr_reporting = toReporting(derived.own_mrr, out.currency, rates);
            out.tcv_reporting = toReporting(derived.own_tcv, out.currency, rates);
            out.deal_value_reporting = toReporting(derived.deal_value, out.currency, rates);
        }
        if (objectKey === 'contact' || objectKey === 'prospecting_contact') {
            // The STORED full name wins. Only falls back to composing one for
            // rows written before the column existed.
            out.full_name = displayName(row);
        }
        if (row.prospect_id && prospects.has(row.prospect_id)) {
            out.prospect_name = prospects.get(row.prospect_id).name;
        }
        if (objectKey === 'campaign') {
            Object.assign(out, campaignRollup.get(row.id) ?? {
                member_count: 0, influenced_one_time: 0, influenced_mrr: 0,
            });
            out.currency = row.currency ?? ctx?.workspace?.baseCurrency ?? 'USD';
        }
        return out;
    });
}

function emptyValue(ctx) {
    return {
        value_one_time: 0, value_mrr: 0, value_arr: 0, value_weighted: 0,
        value_tcv: 0, currency: ctx?.workspace?.baseCurrency ?? 'USD', line_item_count: 0,
    };
}

/**
 * Current verdict per rule, keyed by subject id. Two rules, one query.
 *
 * `plane` says which table to read — accounts and prospects are qualified by
 * the same engine into separate histories. It defaults to the account plane so
 * existing callers keep working unchanged.
 */
export function currentVerdictsFor(subjectIds, plane = verdictPlane('account')) {
    if (!subjectIds.length) return new Map();
    const { table, idColumn } = plane;
    const rows = all(
        `SELECT * FROM ${table} WHERE is_current = 1 AND ${idColumn} IN (${subjectIds.map(() => '?').join(',')})`,
        subjectIds,
    );
    const map = new Map();
    for (const row of rows) {
        const subjectId = row[idColumn];
        if (!map.has(subjectId)) map.set(subjectId, {});
        map.get(subjectId)[row.rule_key] = {
            id: row.id,
            verdict: row.verdict,
            confidence: row.confidence,
            ruleVersion: row.rule_version,
            computedAt: row.computed_at,
            metrics: json(row.metrics, {}),
            reasons: json(row.reasons, []),
            notes: json(row.notes, []),
            evidenceId: row.evidence_id,
        };
    }
    return map;
}

/**
 * Refreshes the cached rollups on one deal.
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────────
 *
 * `deals.value_*` are a projection of the line items, written ONLY here, using
 * the same `deriveValues` every read path uses. They are never displayed: the
 * hydrator below recomputes from `deal_line_items` on every read, so a stale
 * cache costs a wrong ORDER BY, never a wrong number on screen. That is the
 * whole reason it is safe to cache money at all.
 *
 * Call after anything that can change a deal's worth: a line item written or
 * removed, a stage moved (the stage carries the probability that weights it),
 * or a probability override typed on the deal itself.
 *
 * It deliberately does not touch `updated_at`. Recomputing a cache is not an
 * edit somebody made, and letting it bump the timestamp would make every deal
 * look freshly worked the first time this runs across the table.
 */
/**
 * Moves a deal because something else moved.
 *
 * The pipeline once carried an "Agreement sent" stage and it was deliberately
 * removed, on the argument that a stage mirroring another object's status is
 * two places to update and two places to disagree. That argument was about a
 * stage somebody had to remember to drag a card into. These nobody touches: the
 * agreement, or the meeting, is the only thing anyone changes and the deal
 * follows it.
 *
 * Never moves a deal that has already finished. A won deal whose agreement is
 * re-saved must not be dragged back to Contracting, and a deal lost for its own
 * reasons is not un-lost by a document.
 *
 * `moveDealForAgreement` is kept as the name the document code calls it by; a
 * booked meeting uses the same machinery through `moveDealToStage`, because
 * "advance this deal to that stage, unless it is already closed" is one rule and
 * a second copy of it would be a second set of edge cases.
 */
export function moveDealToStage(ctx, dealId, stageKey, reason, extra = {}, { reopen = false } = {}) {
    if (!dealId) return null;
    const deal = get('SELECT * FROM deals WHERE id = ? AND workspace_id = ?', [dealId, ctx.workspaceId]);
    if (!deal) return null;

    /**
     * A closed deal is left alone unless the agreement says otherwise.
     *
     * Creating a document must never drag a won deal backwards, so the default
     * is to do nothing. But an agreement moving OUT of signed is the contract
     * itself saying the sale did not conclude — the deal was won because that
     * agreement was signed, and it is not signed now. `reopen` is passed only
     * from that transition, and `closed_at` is cleared with it so a reopened
     * deal does not keep a closing date it no longer has.
     */
    if (deal.status !== 'open' && !reopen) return null;

    /**
     * By key, and for the two conclusions by TYPE as well.
     *
     * Won and lost exist in every pipeline whatever they are called — "Placed",
     * "Deal Won" — so a terminal move never depends on a migration having run.
     * `contracting` is looked up by key only: a workspace without that stage
     * should do NOTHING, not land the deal on whichever open stage happened to
     * come first, which would move cards for a reason nobody could read.
     */
    const terminal = stageKey === 'won' || stageKey === 'lost';
    const stage = get(
        'SELECT * FROM stages WHERE pipeline_id = ? AND key = ?', [deal.pipeline_id, stageKey],
    ) ?? (terminal
        ? get('SELECT * FROM stages WHERE pipeline_id = ? AND type = ? LIMIT 1', [deal.pipeline_id, stageKey])
        : null);
    if (!stage || stage.id === deal.stage_id) return null;

    const stamp = now();
    update('deals', deal.id, {
        stage_id: stage.id,
        status: stage.type === 'open' ? 'open' : stage.type,
        // Reopening clears the close date and the loss reason; closing sets it.
        ...(stage.type === 'open' ? { closed_at: null, loss_reason: null } : { closed_at: stamp }),
        ...extra,
        updated_at: stamp,
    });

    /**
     * Same ledger the manual stage-change endpoint writes (api/deals.mjs),
     * kept in step here rather than left to it.
     *
     * Every automated move — a call logged, a meeting booked, a document
     * generated — goes through THIS function, not that endpoint. Before this,
     * `deal_stage_history` only ever saw the stage changes a person dragged
     * by hand; every automated one left no row, so "how long did this deal
     * sit in Proposal preparing" was answering from a ledger most of a deal's
     * actual movement never reached.
     */
    run('UPDATE deal_stage_history SET exited_at = ? WHERE deal_id = ? AND exited_at IS NULL', [stamp, deal.id]);
    insert('deal_stage_history', {
        id: id('dsh'), workspace_id: ctx.workspaceId, deal_id: deal.id,
        from_stage_id: deal.stage_id, to_stage_id: stage.id, entered_at: stamp, actor_id: ctx.userId ?? null,
    });

    audit(ctx, {
        objectKey: 'deal', recordId: deal.id, accountId: deal.account_id,
        action: `deal_${stage.type === 'open' ? 'stage_changed' : stage.type}`,
        before: { stage_id: deal.stage_id, status: deal.status },
        after: { stage_id: stage.id, stage: stage.label, because: reason },
        source: 'automation',
    });
    return stage;
}

/**
 * The name the document code has always called it by.
 *
 * Kept as an alias rather than renamed at forty call sites: the behaviour is
 * identical, and a rename that touches every document path to make room for
 * meetings is a diff nobody can review for the thing it is actually adding.
 */
export const moveDealForAgreement = moveDealToStage;

/**
 * Move a deal to a later stage, and ONLY a later one.
 *
 * The general form of what used to be proposal-preparing's own function: a
 * proposal being created, or sent, or a call landing an outcome, all mean
 * the deal has reached a point in the pipeline — but none of them get to
 * drag it BACKWARD if it is already further along. A rep raising a second
 * or revised proposal on a deal already in Negotiation must not read as
 * the deal losing ground for the ordinary act of drafting a follow-up
 * document; the same is true of a proposal marked sent after the deal has
 * moved on. Compared by the pipeline's own `position` column, not by name,
 * so a workspace that renamed or reordered its stages is still honoured.
 */
export function advanceDealToStage(ctx, dealId, stageKey, reason) {
    if (!dealId) return null;
    const deal = get('SELECT * FROM deals WHERE id = ? AND workspace_id = ?', [dealId, ctx.workspaceId]);
    if (!deal || deal.status !== 'open') return null;
    const target = get(`SELECT * FROM stages WHERE pipeline_id = ? AND key = ?`, [deal.pipeline_id, stageKey]);
    if (!target) return null;
    const current = deal.stage_id
        ? get('SELECT position FROM stages WHERE id = ?', [deal.stage_id])
        : null;
    if (current && current.position >= target.position) return null;
    return moveDealToStage(ctx, dealId, stageKey, reason);
}

/** The name every existing caller already uses. See `advanceDealToStage`. */
export function advanceDealForProposal(ctx, dealId, reason) {
    return advanceDealToStage(ctx, dealId, 'proposal_preparing', reason);
}

/**
 * The account's open deal, created if it has none.
 *
 * A meeting booked from cold calling has to appear in the pipeline, and on an
 * account nobody has raised a deal for there is nothing to move — so the deal is
 * the consequence of the meeting, exactly as one is the consequence of an
 * agreement. Same resolution as `ensureDealForAgreement`, whose own reason string
 * ("an agreement needs a deal") would be a lie here.
 */
export function ensureDealForAccount(ctx, accountId, because, serviceLineKey = null) {
    if (!accountId) return null;
    const found = findDealForAgreement(ctx, { accountId, serviceLineKey });
    if (found) return found;
    return ensureDealForAgreement(ctx, { accountId, serviceLineKey, source: 'automation', because });
}

/* ---------------------------------------------------------- deal identity -- */

/**
 * The service lines of a workspace, cached for the life of the process.
 *
 * Every deal read wants its service's label (for the name) and its pricing
 * model (for whether the price recurs), and a workspace has four of them. One
 * query per deal in a list of two hundred is two hundred blocking round trips
 * to Turso for four rows. Written from settings only, which calls the
 * invalidator below.
 */
const serviceLineCache = new Map();

export function invalidateServiceLines(workspaceId = null) {
    if (!workspaceId) { serviceLineCache.clear(); return; }
    serviceLineCache.delete(workspaceId);
}

export function serviceLinesFor(workspaceId) {
    if (!serviceLineCache.has(workspaceId)) {
        serviceLineCache.set(workspaceId, new Map(
            all(
                'SELECT key, label, pricing_model FROM service_lines WHERE workspace_id = ? ORDER BY position',
                [workspaceId],
            ).map((row) => [row.key, row]),
        ));
    }
    return serviceLineCache.get(workspaceId);
}

export function serviceLine(workspaceId, key) {
    if (!key) return null;
    return serviceLinesFor(workspaceId).get(key) ?? null;
}

/**
 * Recurring or one-time, decided by the SERVICE and never by the user.
 *
 * The business rule is "Offshoring and HCM repeat, Recruitment and OD do not",
 * and it is expressed once, here, from `service_lines.pricing_model`. A deal
 * cannot be an Offshoring deal billed one-time, because nothing anywhere offers
 * that as a choice.
 */
export function billingTypeForService(workspaceId, serviceLineKey) {
    return billingTypeForPricingModel(serviceLine(workspaceId, serviceLineKey)?.pricing_model);
}

/**
 * The deal name, generated: `Company Name - Service Name`.
 *
 * Nobody types this. It was previously half-generated in one dialog — the
 * account name, an em dash, and an empty space where the service should have
 * been, which is how production ended up with a deal called
 * "ACE Moharram and Associates — " — and typed by hand everywhere else, so no
 * two deals for the same client agreed on a format.
 *
 * Returns null when neither half is known; a deal named after nothing is worse
 * than one named "Deal".
 */
export function generatedDealName(ctx, { accountId, accountName = null, serviceLineKey = null }) {
    const company = String(
        accountName
        ?? (accountId
            ? get('SELECT name FROM accounts WHERE id = ? AND workspace_id = ?', [accountId, ctx.workspaceId])?.name
            : null)
        ?? '',
    ).trim();
    const service = String(serviceLine(ctx.workspaceId, serviceLineKey)?.label ?? '').trim();
    if (!company && !service) return null;
    if (!service) return company;
    if (!company) return service;
    return `${company} - ${service}`;
}

/**
 * Whether a name is one this module produced, for SOME service of this account.
 *
 * Used to decide whether re-generating is a correction or an overwrite. A deal
 * somebody renamed "Q3 renewal — urgent" keeps that name when its service
 * changes; one still carrying a generated name follows the change, because a
 * deal called "ABC - HCM" that is now a Recruitment deal is a lie in the list
 * view.
 *
 * The half-generated legacy shape ("ABC — ", em dash, nothing after it) counts
 * as generated too, so the deals already carrying it are repaired the first
 * time anybody touches them.
 */
function isGeneratedDealName(ctx, deal, accountName) {
    const name = String(deal?.name ?? '').trim();
    if (!name) return true;
    const company = String(accountName ?? '').trim();
    if (company) {
        if (name === company) return true;
        for (const dash of ['-', '—']) {
            if (name === `${company} ${dash}`) return true;
            for (const line of serviceLinesFor(ctx.workspaceId).values()) {
                if (name === `${company} ${dash} ${line.label}`) return true;
            }
        }
    }
    return false;
}

/**
 * Fills in a deal's name from its company and its service.
 *
 * On CREATE whenever the caller did not type one. On UPDATE only when the
 * existing name is still a generated one — see above.
 */
export function applyGeneratedDealName(ctx, values, input, before = null) {
    const asked = String(input?.name ?? '').trim();
    const accountId = values.account_id ?? before?.account_id ?? null;
    if (!accountId) return;
    const serviceLineKey = values.service_line_key !== undefined
        ? values.service_line_key
        : before?.service_line_key ?? null;

    const accountName = get(
        'SELECT name FROM accounts WHERE id = ? AND workspace_id = ?', [accountId, ctx.workspaceId],
    )?.name ?? null;

    if (!before) {
        if (asked) return;                    // typed a name: it is theirs
        const generated = generatedDealName(ctx, { accountId, accountName, serviceLineKey });
        if (generated) values.name = generated;
        return;
    }

    // An explicit rename in this same request wins over regeneration.
    if (Object.prototype.hasOwnProperty.call(input ?? {}, 'name') && asked) return;
    const movedService = values.service_line_key !== undefined && values.service_line_key !== before.service_line_key;
    const movedAccount = values.account_id !== undefined && values.account_id !== before.account_id;
    if (!movedService && !movedAccount) return;
    if (!isGeneratedDealName(ctx, before, accountName)) return;

    const generated = generatedDealName(ctx, { accountId, accountName, serviceLineKey });
    if (generated) values.name = generated;
}

/* -------------------------------------------------------------- deal size -- */

/**
 * The label the single priced line carries.
 *
 * A deal has ONE price, held as ONE row in `deal_line_items`, and the label
 * exists so that row is recognisable in an audit event rather than as a thing
 * anybody chooses.
 */
export const DEAL_PRICE_LABEL = 'Deal size';

/**
 * A deal's size: a price, a currency, and whether it repeats.
 *
 * A deal that has never been priced returns a null price rather than zero —
 * "nobody has said" and "it is worth nothing" are different claims, and only
 * one of them belongs in a forecast.
 */
export function dealPrice(ctx, deal) {
    const row = deal?.id
        ? get('SELECT * FROM deal_line_items WHERE deal_id = ? ORDER BY position, rowid LIMIT 1', [deal.id])
        : null;
    const line = serviceLine(ctx.workspaceId, deal?.service_line_key);
    const billingType = billingTypeForPricingModel(line?.pricing_model);
    /**
     * `perPerson` is the whole of what the form needs to know about shape.
     *
     * Null for a flat-priced service, and an object naming the unit for one
     * priced per person — so a screen asks "Employees" and "Price per employee
     * per month" for Offshoring and a single "Price" for Recruitment, from one
     * branch rather than a list of service keys repeated in every caller.
     */
    const perPerson = perPersonPricing(line?.pricing_model);
    const unitPrice = row && Number.isFinite(Number(row.unit_amount)) ? Number(row.unit_amount) : null;
    const count = row && Number.isFinite(Number(row.quantity)) ? Number(row.quantity) : (perPerson ? null : 1);

    return {
        // The DEAL'S SIZE — what the client pays — however it was arrived at.
        price: unitPrice === null ? null : unitPrice * (count ?? 1),
        // And the two halves behind it, for the services that have two.
        unitPrice,
        count,
        perPerson,
        currency: row?.currency || deal?.currency || ctx.workspace?.baseCurrency || 'USD',
        billingType,
        billingLabel: billingTypeLabel(billingType),
        recurrence: recurrenceForPricingModel(line?.pricing_model),
        termMonths: row?.term_months ?? null,
        serviceLabel: line?.label ?? null,
    };
}

/**
 * Writes a deal's size. The ONLY path that prices a deal.
 *
 * Everything that has a figure for a deal — the deal form, an agreement being
 * signed, an agreement generated from a template — comes through here, so there
 * is one implementation of "what a deal is worth" instead of three writing
 * `deal_line_items` slightly differently. The row is REPLACED rather than
 * appended to: a deal has one price, so a second row would be a second opinion.
 *
 * The recurrence is never taken from the caller. It is the service's.
 */
export function setDealPrice(ctx, deal, {
    price, count = null, currency = null, termMonths = null, source = 'ui', reason = null,
    effectiveFrom = null, note = null,
}) {
    const amount = price === null || price === undefined || price === '' ? null : Number(price);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
        throw badRequest('A price must be a number, and not a negative one.');
    }

    const line = serviceLine(ctx.workspaceId, deal.service_line_key);

    /**
     * The count, for a service priced per person.
     *
     * Refused rather than defaulted for those services: an Offshoring deal
     * saved with no headcount would price at one employee and read as a real
     * figure, which is the quiet wrong number this file exists to avoid. A
     * flat-priced service ignores whatever is passed and stores 1.
     */
    /**
     * A count multiplies the price; NO count means the price is already a total.
     *
     * Both callers are legitimate. Somebody quoting an Offshoring deal gives a
     * headcount and a rate per head, and `putDealSize` insists on both — that
     * is where the breakdown exists to be captured. But a signed agreement
     * hands over a contract VALUE, which is already the whole number and has no
     * headcount behind it to state; demanding one there would refuse to record
     * what the client actually signed.
     *
     * The emptiness check comes BEFORE `Number`, because `Number(null)` and
     * `Number('')` are both 0 — so "not given" would otherwise become a
     * confident headcount of zero and price the deal at nothing. Zero typed
     * deliberately is a real answer and is kept: a contract ramped down to
     * nobody is worth nothing this month.
     */
    const perPerson = perPersonPricing(line?.pricing_model);
    const given = !(count === null || count === undefined || String(count).trim() === '');
    const stated = Number(count);
    if (given && (!Number.isFinite(stated) || stated < 0)) {
        throw badRequest(`How many ${perPerson?.unitPlural ?? 'units'}? That must be a whole number, and not a negative one.`);
    }
    const headcount = given ? stated : 1;
    const recurrence = recurrenceForPricingModel(line?.pricing_model);
    const chosen = String(currency || deal.currency || ctx.workspace?.baseCurrency || 'USD').toUpperCase();
    const before = get('SELECT * FROM deal_line_items WHERE deal_id = ? ORDER BY position, rowid LIMIT 1', [deal.id]);

    /**
     * A PROPOSAL, when the person cannot price the workspace's deals outright.
     *
     * A rep may edit a colleague's deal — see SHARED_OBJECTS in lib/auth.mjs —
     * and the price is the one field on it that is a commitment rather than a
     * correction. So a rep's change is recorded as a dated period awaiting
     * approval and raises the task for it, and the deal goes on reporting the
     * figure a manager last agreed to until somebody agrees to this one.
     *
     * Automations are not proposals: an agreement being signed, or a service
     * changing the recurrence, is the system applying a decision already made.
     */
    const proposing = source === 'ui' && !can(ctx, 'record.write.all');
    const startsOn = String(effectiveFrom ?? now()).slice(0, 10);

    if (amount !== null) {
        const period = recordPricePeriod(ctx, deal, {
            unitAmount: amount,
            quantity: headcount,
            currency: chosen,
            fxRate: baseFxRate(ctx, chosen),
            recurrence,
            termMonths: recurrence === 'monthly' && Number(termMonths) > 0 ? Number(termMonths) : null,
            effectiveFrom: startsOn,
            status: proposing ? 'pending_approval' : 'active',
            note,
        });

        if (proposing) {
            audit(ctx, {
                objectKey: 'deal', recordId: deal.id, accountId: deal.account_id,
                action: 'price_change_proposed', source, reason,
                after: {
                    price: amount * headcount, unit_price: amount, currency: chosen,
                    effective_from: startsOn, awaiting: 'a manager',
                },
            });
            openApprovalTask(ctx, 'deal_price', {
                id: period.id,
                // The task deep-links to the DEAL, not to a price-period page
                // that does not exist — my-work reads this off the approval meta.
                deal_id: deal.id,
                account_id: deal.account_id,
                number: deal.name,
                currency: chosen,
                contract_value: amount * headcount,
            });
            // The deal keeps the price a manager last agreed to.
            return { ...dealPrice(ctx, get('SELECT * FROM deals WHERE id = ?', [deal.id])), pending: period };
        }
    }

    /**
     * The line item is the row in force TODAY, not the row just written.
     *
     * A price agreed now to start next January is a real and common thing to
     * record, and projecting it straight onto the deal would make the board,
     * the forecast and every list report next year's figure today. So the write
     * above went into the series, and this reads back whichever row actually
     * applies — which for the ordinary case (effective today) is the one just
     * written, and for a scheduled change is the one it replaces.
     */
    projectCurrentPrice(ctx, get('SELECT * FROM deals WHERE id = ?', [deal.id]) ?? deal);

    /**
     * Clearing a price ends the series rather than deleting it.
     *
     * A zero-amount period from today means "from today this deal has no
     * agreed price", which is a fact with a date like any other — and it leaves
     * last quarter's figure exactly where it was.
     */
    if (amount === null) {
        run("DELETE FROM deal_price_periods WHERE deal_id = ? AND status = 'active' AND effective_from >= ?",
            [deal.id, startsOn]);
    }

    run('UPDATE deals SET updated_at = ? WHERE id = ?', [now(), deal.id]);

    audit(ctx, {
        objectKey: 'deal', recordId: deal.id, accountId: deal.account_id,
        action: 'deal_priced', source, reason,
        before: before
            ? {
                price: Number(before.unit_amount) * (Number(before.quantity) || 1),
                unit_price: Number(before.unit_amount),
                ...(perPerson ? { [perPerson.unitPlural]: Number(before.quantity) || 0 } : {}),
                currency: before.currency,
            }
            : null,
        after: {
            price: amount === null ? null : amount * headcount,
            unit_price: amount,
            ...(perPerson ? { [perPerson.unitPlural]: headcount } : {}),
            currency: chosen,
            billing: billingTypeForPricingModel(line?.pricing_model),
        },
    });
    return dealPrice(ctx, get('SELECT * FROM deals WHERE id = ?', [deal.id]));
}

/**
 * One unit of `currency`, in the WORKSPACE BASE currency.
 *
 * Lifted out of api/deals.mjs so the agreement paths that price a deal convert
 * the same way the deal form does — a rate applied in one writer and defaulted
 * to 1 in another is two different numbers on one screen.
 */
function baseFxRate(ctx, currency) {
    const base = ctx.workspace?.baseCurrency ?? 'USD';
    const from = currency || base;
    if (from === base) return 1;
    const rates = reportingRates((key) => setting(ctx.workspaceId, key));
    const perUsdBase = Number(rates[base]);
    const perUsdFrom = Number(rates[from]);
    // An unknown currency converts at 1 rather than at zero: counting it once
    // is wrong by a rate, counting it as nothing is wrong by everything.
    if (!(perUsdBase > 0) || !(perUsdFrom > 0)) return 1;
    return perUsdBase / perUsdFrom;
}

/**
 * Re-files a deal's existing price under its (new) service.
 *
 * Called when `service_line_key` changes. The price and the currency are the
 * person's; whether that price repeats is the service's, so only the recurrence
 * moves — and it moves through `setDealPrice`, so the rollups and the audit
 * trail follow it like any other pricing.
 */
export function repriceForService(ctx, dealId) {
    const deal = get('SELECT * FROM deals WHERE id = ? AND workspace_id = ?', [dealId, ctx.workspaceId]);
    if (!deal) return null;
    const row = get('SELECT * FROM deal_line_items WHERE deal_id = ? ORDER BY position, rowid LIMIT 1', [deal.id]);
    if (!row) return null;
    const wanted = recurrenceForPricingModel(serviceLine(ctx.workspaceId, deal.service_line_key)?.pricing_model);
    if (row.recurrence === wanted) {
        // Still worth keeping the stored service key honest.
        if (row.service_line_key !== deal.service_line_key) {
            update('deal_line_items', row.id, { service_line_key: deal.service_line_key ?? null });
        }
        return null;
    }
    return setDealPrice(ctx, deal, {
        price: row.unit_amount,
        count: row.quantity,
        currency: row.currency,
        termMonths: row.term_months,
        source: 'automation',
        reason: 'the service changed, and the service decides whether the price repeats',
    });
}

/* -------------------------------------------- the deal an agreement needs -- */

/**
 * The deal an agreement belongs to.
 *
 * An appropriate deal is one for the SAME ACCOUNT and the SAME SERVICE that is
 * not in the bin. The most recently updated open one wins, then a won one — a
 * renewal signed against a closed deal is still that deal.
 *
 * A service that no deal sells returns null on purpose: that is a NEW deal, and
 * attaching an Offshoring contract to a Recruitment deal because it was the
 * only one going would be worse than either.
 */
export function findDealForAgreement(ctx, { accountId, serviceLineKey = null }) {
    if (!accountId) return null;
    const candidates = all(
        `SELECT * FROM deals
          WHERE workspace_id = ? AND account_id = ? AND deleted_at IS NULL
          ORDER BY updated_at DESC`,
        [ctx.workspaceId, accountId],
    );
    if (!candidates.length) return null;

    const sameService = serviceLineKey
        ? candidates.filter((d) => d.service_line_key === serviceLineKey)
        : candidates;
    if (serviceLineKey && !sameService.length) return null;

    return sameService.find((d) => d.status === 'open')
        ?? sameService.find((d) => d.status === 'won')
        ?? sameService[0]
        ?? null;
}

/**
 * The deal an agreement belongs to — found, or CREATED.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * An agreement is a contract for a service with a client, which is exactly what
 * a deal is the record of. The two were nonetheless allowed to drift apart:
 * every one of the twelve agreements in production had `deal_id` NULL, so none
 * of them moved a pipeline, none appeared on a deal, and the link dialog
 * answered "that account has no deals yet — create one first, then link it",
 * which is a CRM asking a person to do its filing.
 *
 * So the relationship is established rather than demanded.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 *
 * It never creates a SECOND deal for a service that already has one, and it
 * never touches the deal it finds beyond linking. Manual deal creation is
 * untouched and is still how somebody raises "ABC - Recruitment" beside
 * "ABC - HCM".
 */
export function ensureDealForAgreement(ctx, {
    accountId, serviceLineKey = null, currency = null, price = null, source = 'automation',
    because = 'an agreement needs a deal',
}) {
    if (!accountId) return null;
    const found = findDealForAgreement(ctx, { accountId, serviceLineKey });
    if (found) return found;

    const account = get(
        'SELECT id, name, billing_currency, services FROM accounts WHERE id = ? AND workspace_id = ?',
        [accountId, ctx.workspaceId],
    );
    if (!account) return null;

    // The service the contract is for, or the one the account buys, or the
    // workspace's first. A deal with no service cannot be classified recurring
    // or one-time, so it is worth reaching for all three.
    const service = serviceLineKey
        ?? json(account.services, [])[0]
        ?? [...serviceLinesFor(ctx.workspaceId).keys()][0]
        ?? null;

    const pipeline = get(
        `SELECT * FROM pipelines WHERE workspace_id = ? AND object_key = 'deal'
          ORDER BY is_default DESC, position LIMIT 1`,
        [ctx.workspaceId],
    );
    if (!pipeline) return null;
    const stage = get('SELECT * FROM stages WHERE pipeline_id = ? ORDER BY position LIMIT 1', [pipeline.id]);
    if (!stage) return null;

    const dealId = id('dea');
    const stamp = now();
    insert('deals', {
        id: dealId,
        workspace_id: ctx.workspaceId,
        account_id: account.id,
        name: generatedDealName(ctx, { accountId: account.id, accountName: account.name, serviceLineKey: service })
            ?? account.name,
        pipeline_id: pipeline.id,
        stage_id: stage.id,
        status: 'open',
        currency: String(account.billing_currency || currency || ctx.workspace?.baseCurrency || 'USD').toUpperCase(),
        service_line_key: service,
        owner_id: ctx.userId ?? null,
        created_by: ctx.userId ?? null,
        created_at: stamp,
        updated_at: stamp,
    });
    audit(ctx, {
        objectKey: 'deal', recordId: dealId, accountId: account.id,
        action: 'created', source,
        after: { because, service_line_key: service },
    });
    // Same reason createRecord starts one for a deal raised by hand — the
    // deal's first stage needs an `entered_at` too, and this path (an
    // agreement or proposal auto-raising the deal behind it) inserts
    // directly rather than through createRecord.
    insert('deal_stage_history', {
        id: id('dsh'), workspace_id: ctx.workspaceId, deal_id: dealId,
        from_stage_id: null, to_stage_id: stage.id, entered_at: stamp, actor_id: ctx.userId ?? null,
    });
    reindex('deal', ctx.workspaceId, dealId);

    const deal = get('SELECT * FROM deals WHERE id = ?', [dealId]);
    /**
     * `price` here is the agreement's CONTRACT VALUE — a total, not a
     * monthly rate (see the comment where the caller in api/proposals.mjs
     * signs an agreement onto an already-existing deal, which this mirrors
     * for a brand-new one). Writing it straight in only makes sense for a
     * one-time service, whose whole figure the contract value IS; for a
     * recurring one it would price the deal at its own annual total per
     * month. Left unpriced, a rep fills in the real monthly figure on the
     * deal form, which asks for it explicitly rather than this guessing one
     * out of a total with no term attached to divide it by.
     */
    const recurring = billingTypeForPricingModel(serviceLine(ctx.workspaceId, service)?.pricing_model) !== 'one_time';
    if (!recurring && price !== null && price !== undefined && Number(price) > 0) {
        setDealPrice(ctx, deal, { price, currency, source, reason: 'from the agreement it was created for' });
    }
    return get('SELECT * FROM deals WHERE id = ?', [dealId]);
}

/**
 * Keeps a deal's size and an agreement's contract value the same number.
 *
 * They are two records of one commercial fact, and the product asks for them to
 * agree. The direction is decided by which one knows: an agreement carrying a
 * value teaches an unpriced deal, a priced deal teaches an agreement generated
 * without one. When both are set and they differ the AGREEMENT wins — it is the
 * document both companies signed, and the deal is the negotiation that produced
 * it.
 */
export function syncAgreementAndDeal(ctx, agreementId) {
    const agreement = get(
        'SELECT * FROM agreements WHERE id = ? AND workspace_id = ?', [agreementId, ctx.workspaceId],
    );
    if (!agreement?.deal_id) return null;
    const deal = get('SELECT * FROM deals WHERE id = ? AND workspace_id = ?', [agreement.deal_id, ctx.workspaceId]);
    if (!deal) return null;

    const contractValue = Number(agreement.contract_value);
    const current = dealPrice(ctx, deal);

    if (Number.isFinite(contractValue) && contractValue > 0) {
        const currency = agreement.currency || current.currency;
        /**
         * The contract value is a TOTAL (`monthly_fee × months`). Writing it
         * straight into a deal is only right for a one-time service, where the
         * whole figure IS the deal. For a recurring deal it would inflate MRR
         * by the term — a 50,400 annual contract on a 4,200/month retainer
         * would report as 50,400/month. So a recurring deal keeps the line
         * items the proposal or the deal form produced, and the contract value
         * still drives the `deal_value` reporting figure (see `dealValuesFor`).
         */
        if (current.billingType === 'one_time' || current.price === null) {
            setDealPrice(ctx, deal, {
                price: contractValue,
                currency,
                source: 'automation',
                reason: `agreement ${agreement.number}`,
            });
        }
        return { direction: 'agreement_to_deal', value: contractValue };
    }

    if (current.price !== null && current.price > 0) {
        update('agreements', agreement.id, {
            contract_value: current.price,
            currency: current.currency,
            updated_at: now(),
        });
        audit(ctx, {
            objectKey: 'agreement', recordId: agreement.id, accountId: agreement.account_id,
            action: 'value_from_deal', source: 'automation',
            after: { contract_value: current.price, currency: current.currency, deal: deal.name },
        });
        return { direction: 'deal_to_agreement', value: current.price };
    }
    return null;
}

/* --------------------------------------------- what a deal was worth, when -- */

/**
 * A deal's price series, newest first.
 *
 * `pending_approval` rows are included and flagged rather than hidden: a rep's
 * proposed re-quote is something a manager has to be able to see in order to
 * agree to it, and something the rep has to be able to see in order to know it
 * was recorded.
 */
export function priceSchedule(ctx, dealId, { includeRejected = false } = {}) {
    const rows = all(
        `SELECT p.*, c.name AS created_name, a.name AS approved_name
           FROM deal_price_periods p
           LEFT JOIN users c ON c.id = p.created_by
           LEFT JOIN users a ON a.id = p.approved_by
          WHERE p.deal_id = ? AND p.workspace_id = ?
          ORDER BY p.effective_from DESC, p.created_at DESC`,
        [dealId, ctx.workspaceId],
    );
    return rows
        .filter((row) => includeRejected || row.status !== 'rejected')
        .map((row) => ({
            ...row,
            price: (Number(row.unit_amount) || 0) * (Number(row.quantity) || 1),
        }));
}

/**
 * The price in force on a given date — the latest ACTIVE row that had started.
 *
 * `pending_approval` is deliberately not consulted. A price nobody has agreed
 * to is a proposal, and a forecast built on proposals is a forecast of what
 * somebody hopes to charge.
 *
 * Returns null when the deal had no price yet on that date, which is a real
 * answer: a deal raised in January and priced in March was worth nothing
 * anybody had stated in February, and reporting the March figure back over it
 * is the retrospective rewriting this whole table exists to prevent.
 */
export function priceInForce(ctx, dealId, onDate = null) {
    const day = String(onDate ?? now()).slice(0, 10);
    const row = get(
        `SELECT * FROM deal_price_periods
          WHERE deal_id = ? AND workspace_id = ? AND status = 'active' AND effective_from <= ?
          ORDER BY effective_from DESC, created_at DESC LIMIT 1`,
        [dealId, ctx.workspaceId, day],
    );
    if (!row) return null;
    return { ...row, price: (Number(row.unit_amount) || 0) * (Number(row.quantity) || 1) };
}

/**
 * What a deal was worth in each period of a span — the answer the year's
 * forecast needs.
 *
 * ── WHY THIS IS NOT "THE CURRENT PRICE TIMES THE NUMBER OF QUARTERS" ────────
 *
 * Because that is the bug. Re-quote a retainer in April and the naive version
 * reports January to March at April's figure, so the year's total moves for
 * months that have already been invoiced. Each period is valued at the row that
 * was in force during it, and a period the deal had no price for reports null
 * rather than borrowing a neighbour's.
 *
 * Periods are taken at their START. A price that changes mid-quarter belongs to
 * the quarter it starts in for the NEXT one — stated here rather than left for
 * somebody to infer, because the alternative (pro-rating within a period) is a
 * different and much larger claim about how this business bills.
 */
export function priceByPeriod(ctx, dealId, { from, to, period = 'quarter' } = {}) {
    const starts = periodStarts(from, to, period);
    return starts.map((start, index) => {
        /**
         * The price at the period's START, or the first one that begins INSIDE
         * it when there was none yet.
         *
         * Sampling at the start alone is right for a re-quote — a change
         * effective 1 April leaves Q1 on the old figure, which is the whole
         * point of this table. It is wrong for the FIRST price: a deal priced
         * on 17 August reported Q3 as "not yet priced" when it had been priced
         * for half of it, which reads as missing data rather than as a deal
         * that started mid-quarter.
         *
         * So a period with nothing in force at its start falls back to the
         * earliest price that begins within it, flagged, and a period genuinely
         * before the deal was ever priced still reports null. Deliberately not
         * pro-rated: apportioning a monthly figure across part of a quarter is
         * a much larger claim about how this business bills, and one nobody has
         * made.
         */
        const next = starts[index + 1] ?? nextPeriodStart(start, period);
        const atStart = priceInForce(ctx, dealId, start);
        const startedWithin = atStart ? null : get(
            `SELECT * FROM deal_price_periods
              WHERE deal_id = ? AND workspace_id = ? AND status = 'active'
                AND effective_from > ? ${next ? 'AND effective_from < ?' : ''}
              ORDER BY effective_from LIMIT 1`,
            next ? [dealId, ctx.workspaceId, start, next] : [dealId, ctx.workspaceId, start],
        );
        const inForce = atStart ?? (startedWithin
            ? { ...startedWithin, price: (Number(startedWithin.unit_amount) || 0) * (Number(startedWithin.quantity) || 1) }
            : null);
        return {
            // Said, so a reader knows the figure did not cover the whole period.
            // `startsOn` below is the PERIOD's start; this is the PRICE's.
            startedMidPeriod: Boolean(!atStart && startedWithin),
            pricedFrom: startedWithin?.effective_from ?? null,
            period: labelForPeriod(start, period),
            startsOn: start,
            price: inForce ? inForce.price : null,
            unitPrice: inForce ? Number(inForce.unit_amount) : null,
            count: inForce ? Number(inForce.quantity) : null,
            currency: inForce?.currency ?? null,
            recurrence: inForce?.recurrence ?? null,
            // Which row answered, so a screen can show that two quarters share
            // one price rather than repeating it as though it were re-agreed.
            periodId: inForce?.id ?? null,
        };
    });
}

/** The first day of each period between two dates, inclusive of both ends. */
function periodStarts(from, to, period) {
    const start = new Date(`${String(from).slice(0, 10)}T00:00:00Z`);
    const end = new Date(`${String(to).slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];

    const out = [];
    const step = period === 'month' ? 1 : period === 'year' ? 12 : 3;
    // Snapped back to the period the range starts in, so a span beginning on
    // 15 February reports the quarter that contains it rather than inventing
    // one that begins that day.
    let year = start.getUTCFullYear();
    let month = period === 'year' ? 0 : Math.floor(start.getUTCMonth() / step) * step;

    for (let guard = 0; guard < 400; guard += 1) {
        const at = new Date(Date.UTC(year, month, 1));
        if (at.getTime() > end.getTime()) break;
        out.push(at.toISOString().slice(0, 10));
        month += step;
        if (month > 11) { year += Math.floor(month / 12); month %= 12; }
    }
    return out;
}

function labelForPeriod(startsOn, period) {
    const at = new Date(`${startsOn}T00:00:00Z`);
    const year = at.getUTCFullYear();
    if (period === 'year') return String(year);
    if (period === 'month') {
        return `${at.toLocaleString('en', { month: 'short', timeZone: 'UTC' })} ${year}`;
    }
    return `Q${Math.floor(at.getUTCMonth() / 3) + 1} ${year}`;
}

function nextPeriodStart(startStr, period) {
    const at = new Date(`${startStr}T00:00:00Z`);
    if (Number.isNaN(at.getTime())) return null;
    const step = period === 'month' ? 1 : period === 'year' ? 12 : 3;
    let year = at.getUTCFullYear();
    let month = at.getUTCMonth() + step;
    if (month > 11) { year += Math.floor(month / 12); month %= 12; }
    return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
}

/**
 * Records a price as taking effect from a date, and returns the row.
 *
 * `status` is decided by the CALLER's authority, not by this function guessing:
 * somebody who may write deals workspace-wide sets a price, and a rep proposes
 * one. See `setDealPrice`.
 */
function recordPricePeriod(ctx, deal, {
    unitAmount, quantity, currency, fxRate, recurrence, termMonths,
    effectiveFrom, status, note = null,
}) {
    const periodId = id('dpp');
    insert('deal_price_periods', {
        id: periodId,
        workspace_id: ctx.workspaceId,
        deal_id: deal.id,
        effective_from: String(effectiveFrom ?? now()).slice(0, 10),
        unit_amount: unitAmount ?? 0,
        quantity: quantity ?? 1,
        currency,
        fx_rate: fxRate,
        recurrence,
        term_months: termMonths ?? null,
        status,
        note,
        created_by: ctx.userId ?? null,
        created_at: now(),
        ...(status === 'active' && can(ctx, 'record.write.all')
            ? { approved_by: ctx.userId ?? null, approved_at: now() }
            : {}),
    });
    return get('SELECT * FROM deal_price_periods WHERE id = ?', [periodId]);
}

/**
 * Approving or rejecting a proposed price.
 *
 * Approval makes it active and re-projects the deal's current figures, because
 * a price agreed today with an effective date in the past changes what the deal
 * is worth now. Rejection leaves the row exactly where it is, marked, because
 * "what did they ask for and who said no" is the question this is asked about
 * six weeks later.
 */
export function reviewPricePeriod(ctx, periodId, decision, note = null) {
    require$(ctx, 'record.write.all');
    const period = get(
        'SELECT * FROM deal_price_periods WHERE id = ? AND workspace_id = ?',
        [periodId, ctx.workspaceId],
    );
    if (!period) throw notFound('That price change does not exist.');
    if (period.status !== 'pending_approval') {
        throw badRequest(`That price change is "${period.status}", not awaiting approval.`);
    }
    if (decision !== 'approved' && decision !== 'rejected') {
        throw badRequest('A decision is either "approved" or "rejected".');
    }
    if (decision === 'rejected' && !String(note ?? '').trim()) {
        throw badRequest('Say why it was rejected — the person who proposed it has to know what to change.');
    }

    const deal = get('SELECT * FROM deals WHERE id = ? AND workspace_id = ?', [period.deal_id, ctx.workspaceId]);

    return tx(() => {
        update('deal_price_periods', periodId, {
            status: decision === 'approved' ? 'active' : 'rejected',
            approved_by: ctx.userId ?? null,
            approved_at: now(),
            review_note: note ?? null,
        });
        if (decision === 'approved' && deal) projectCurrentPrice(ctx, deal);

        audit(ctx, {
            objectKey: 'deal', recordId: period.deal_id, accountId: deal?.account_id ?? null,
            action: decision === 'approved' ? 'price_change_approved' : 'price_change_rejected',
            after: {
                effective_from: period.effective_from,
                price: (Number(period.unit_amount) || 0) * (Number(period.quantity) || 1),
                currency: period.currency,
                note: note ?? null,
            },
        });
        closeApprovalTask(ctx, 'deal_price', periodId, decision);
        // The rep who proposed it learns the answer where they proposed it.
        notifyPriceDecision(ctx, {
            proposedById: period.created_by,
            dealId: deal?.id ?? null,
            decision,
            reviewNote: note ?? null,
        });
        return get('SELECT * FROM deal_price_periods WHERE id = ?', [periodId]);
    });
}

/**
 * Rewrites the deal's canonical line item from the row in force TODAY.
 *
 * The line item is a projection, not a second opinion — see the table comment
 * in schema.sql. Everything in the product that asks what a deal is worth reads
 * it, so this is what makes an approved back-dated change show up on the board
 * without any of those readers knowing the series exists.
 */
function projectCurrentPrice(ctx, deal) {
    const inForce = priceInForce(ctx, deal.id);
    run('DELETE FROM deal_line_items WHERE deal_id = ?', [deal.id]);
    if (inForce) {
        insert('deal_line_items', {
            id: id('lit'),
            workspace_id: ctx.workspaceId,
            deal_id: deal.id,
            label: DEAL_PRICE_LABEL,
            service_line_key: deal.service_line_key ?? null,
            pricing_model: serviceLine(ctx.workspaceId, deal.service_line_key)?.pricing_model ?? 'fixed_fee',
            recurrence: inForce.recurrence,
            quantity: inForce.quantity,
            unit_amount: inForce.unit_amount,
            term_months: inForce.term_months,
            currency: inForce.currency,
            fx_rate: inForce.fx_rate,
            position: 0,
        });
        if (deal.currency !== inForce.currency) {
            update('deals', deal.id, { currency: inForce.currency, updated_at: now() });
        }
    }
    syncDealValues(deal.id, ctx);
}

/**
 * Splits open deals by whether their expected close date falls inside a
 * window — the one rule "what's the board's 90-day forecast" and "what do we
 * expect to close this quarter" must share, so they cannot quietly disagree
 * about which deals count.
 *
 * A deal with no `close_date` is real pipeline nobody has dated yet. It is
 * reported back separately as `undated`, never folded into a window's total —
 * a forecast that quietly absorbs undated deals into "now" is a forecast for
 * a window nobody actually claimed (see the board's own forecast, which this
 * mirrors). A dated deal whose close date falls OUTSIDE the window is simply
 * dropped: it belongs to whichever window actually contains it, not this one.
 *
 * `close_date` is a plain calendar date with no time or timezone of its own,
 * so it is compared against `from`/`to` truncated to their first ten
 * characters — the same truncation the filter engine's own `before` operator
 * uses (`lib/query.mjs` `dayOnly`) — rather than as full instants. `to` is
 * exclusive, matching `resolveRange`; `from` is optional, because a rolling
 * "next N days" forecast has no lower bound — an open deal overdue to close
 * is still expected, however many days it has slipped.
 */
export function splitDealsByCloseDate(deals, { from = null, to = null } = {}) {
    const fromDay = from ? String(from).slice(0, 10) : null;
    const toDay = to ? String(to).slice(0, 10) : null;
    const dated = [];
    const undated = [];
    for (const deal of deals) {
        const closeDate = deal.close_date ? String(deal.close_date).slice(0, 10) : null;
        if (!closeDate) { undated.push(deal); continue; }
        if (toDay && closeDate >= toDay) continue;
        if (fromDay && closeDate < fromDay) continue;
        dated.push(deal);
    }
    return { dated, undated };
}

export function syncDealValues(dealId, ctx) {
    if (!dealId) return null;
    const values = dealValuesFor([dealId], ctx).get(dealId);
    if (!values) return null;
    run(
        `UPDATE deals SET value_one_time = ?, value_mrr = ?, value_arr = ?, value_weighted = ?, value_tcv = ?
          WHERE id = ?`,
        [
            values.value_one_time ?? 0,
            values.value_mrr ?? 0,
            values.value_arr ?? 0,
            values.value_weighted ?? 0,
            values.value_tcv ?? 0,
            dealId,
        ],
    );
    return values;
}

function dealValuesFor(dealIds, ctx) {
    const rows = all(
        `SELECT * FROM deal_line_items WHERE deal_id IN (${dealIds.map(() => '?').join(',')}) ORDER BY position`,
        dealIds,
    );
    const stageRows = all(
        `SELECT d.id, d.probability, d.status, s.probability AS stage_probability
           FROM deals d LEFT JOIN stages s ON s.id = d.stage_id
          WHERE d.id IN (${dealIds.map(() => '?').join(',')})`,
        dealIds,
    );
    const probability = new Map(stageRows.map((r) => [r.id, r.probability ?? r.stage_probability ?? 0]));

    const agreements = dealIds.length ? all(
        `SELECT deal_id, contract_value, created_at FROM agreements WHERE deal_id IN (${dealIds.map(() => '?').join(',')}) AND workspace_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`,
        [...dealIds, ctx.workspaceId],
    ) : [];
    const proposals = dealIds.length ? all(
        `SELECT p.deal_id, p.id, p.created_at, pv.total_one_time, pv.total_mrr 
           FROM proposals p 
           LEFT JOIN proposal_versions pv ON pv.proposal_id = p.id AND pv.version = p.current_version 
          WHERE p.deal_id IN (${dealIds.map(() => '?').join(',')}) AND p.workspace_id = ? AND p.deleted_at IS NULL ORDER BY p.created_at DESC`,
        [...dealIds, ctx.workspaceId],
    ) : [];

    const latestAgreementByDeal = new Map();
    for (const agr of agreements) {
        if (!latestAgreementByDeal.has(agr.deal_id)) {
            latestAgreementByDeal.set(agr.deal_id, agr);
        }
    }
    const latestProposalByDeal = new Map();
    for (const prop of proposals) {
        if (!latestProposalByDeal.has(prop.deal_id)) {
            latestProposalByDeal.set(prop.deal_id, prop);
        }
    }

    const byDeal = new Map();
    for (const item of rows) {
        if (!byDeal.has(item.deal_id)) byDeal.set(item.deal_id, []);
        byDeal.get(item.deal_id).push(item);
    }
    const out = new Map();
    for (const dealId of dealIds) {
        const items = byDeal.get(dealId) ?? [];
        const priced = items[0] ?? null;

        const agr = latestAgreementByDeal.get(dealId);
        const prop = latestProposalByDeal.get(dealId);

        let dealValue = null;
        if (agr && prop) {
            const agrTime = new Date(agr.created_at || 0).getTime();
            const propTime = new Date(prop.created_at || 0).getTime();
            if (agrTime >= propTime) {
                dealValue = Number(agr.contract_value) || 0;
            } else {
                dealValue = Number(prop.total_one_time) || 0;
            }
        } else if (agr) {
            dealValue = Number(agr.contract_value) || 0;
        } else if (prop) {
            dealValue = Number(prop.total_one_time) || 0;
        } else {
            dealValue = priced && Number.isFinite(Number(priced.unit_amount))
                ? Number(priced.unit_amount) * (Number(priced.quantity) || 1)
                : null;
        }

        out.set(dealId, {
            ...deriveValues(items, {
                probability: probability.get(dealId) ?? 0,
                baseCurrency: ctx?.workspace?.baseCurrency ?? 'USD',
            }),
            price: priced && Number.isFinite(Number(priced.unit_amount))
                ? Number(priced.unit_amount) * (Number(priced.quantity) || 1)
                : null,
            deal_value: dealValue,
            unit_price: priced ? Number(priced.unit_amount) : null,
            count: priced ? Number(priced.quantity) : null,
            price_currency: priced?.currency ?? null,
            term_months: priced?.term_months ?? null,
        });
    }
    return out;
}

function lookup(sqlPrefix, ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const rows = all(`${sqlPrefix} (${unique.map(() => '?').join(',')})`, unique);
    return new Map(rows.map((r) => [r.id, r]));
}

/* --------------------------------------------------------------- audit --- */

/**
 * Append-only. There is deliberately no update or delete path to audit_events
 * anywhere in this codebase — an audit log a user can edit fails its first
 * review, and that is the entire point of keeping it separate from activities.
 */
export function audit(ctx, { objectKey, recordId, accountId = null, action, before = null, after = null, source = 'ui', reason = null }) {
    run(
        `INSERT INTO audit_events (id, workspace_id, object_key, record_id, account_id, action, actor_id, source, before, after, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
            id('aud'), ctx.workspaceId, objectKey, recordId, bind(accountId), action,
            bind(ctx.userId), source,
            before ? JSON.stringify(redact(before)) : null,
            after ? JSON.stringify({ ...redact(after), ...(reason ? { _reason: reason } : {}) }) : null,
            now(),
        ],
    );
}

function redact(obj) {
    const out = { ...obj };
    delete out.password_hash;
    return out;
}

export function auditFor(ctx, { recordId, accountId, limit = 100 }) {
    const rows = recordId
        ? all('SELECT * FROM audit_events WHERE record_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT ?', [recordId, ctx.workspaceId, limit])
        : all('SELECT * FROM audit_events WHERE account_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT ?', [accountId, ctx.workspaceId, limit]);
    const users = lookup('SELECT id, name FROM users WHERE id IN', rows.map((r) => r.actor_id));
    return rows.map((r) => ({
        ...r,
        before: json(r.before, null),
        after: json(r.after, null),
        actor_name: users.get(r.actor_id)?.name ?? 'System',
    }));
}

/* -------------------------------------------------------------- indexing -- */

export function reindex(objectKey, workspaceId, recordId) {
    const def = objectDef(objectKey);
    const row = get(`SELECT * FROM ${def.table} WHERE id = ?`, [recordId]);
    run('DELETE FROM search_index WHERE record_id = ?', [recordId]);
    if (!row || row.deleted_at) return;

    const fields = fieldsFor(objectKey, workspaceId, { includeComputed: false }).filter((x) => x.searchable);
    const properties = json(row.properties, {});
    const parts = fields.map((x) => (x.custom ? properties[x.property] : row[x.column])).filter(Boolean);
    const title = String(row[def.titleField] ?? row.name ?? row.title ?? row.subject ?? '').slice(0, 300);

    run(
        'INSERT INTO search_index (record_id, workspace_id, object_key, title, body) VALUES (?,?,?,?,?)',
        [recordId, workspaceId, objectKey, title || parts[0] || '', parts.join(' \n ').slice(0, 4000)],
    );
}

/* --------------------------------------------------------------- helpers -- */

/**
 * The multiselect columns of an object, from the registry rather than a list
 * kept by hand — a second multiselect field added later is covered by declaring
 * its type, which is the only place that should have to say so.
 */
const MULTISELECT_CACHE = new Map();
function multiselectKeys(objectKey) {
    if (!MULTISELECT_CACHE.has(objectKey)) {
        MULTISELECT_CACHE.set(objectKey, (OBJECTS[objectKey]?.fields ?? [])
            .filter((f) => f.type === 'multiselect')
            .map((f) => f.key));
    }
    return MULTISELECT_CACHE.get(objectKey);
}

const COLUMN_CACHE = new Map();

/** The name a person would recognise, falling back to the column itself. */
function fieldLabel(objectKey) {
    const fields = objectDef(objectKey).fields ?? [];
    return (column) => {
        const field = fields.find((f) => f.key === column);
        return (field?.label ?? column.replace(/_id$/, '').replace(/_/g, ' ')).toLowerCase();
    };
}

function columnsOf(objectKey) {
    const def = objectDef(objectKey);
    if (!COLUMN_CACHE.has(def.table)) {
        COLUMN_CACHE.set(def.table, new Map(
            all(`PRAGMA table_info(${def.table})`).map((c) => [c.name, c]),
        ));
    }
    return COLUMN_CACHE.get(def.table);
}

export function hasColumn(objectKey, column) {
    return columnsOf(objectKey).has(column);
}

/**
 * Columns the database will refuse to leave empty, and that nothing fills in
 * for you — no default, and not the primary key.
 *
 * A deal belongs to an account, a document belongs to something and has bytes
 * somewhere. Those are NOT NULL because they are true, and creating such a
 * record through the generic "new record" route sent the omission all the way
 * to SQLite, which answered `NOT NULL constraint failed: documents.parent_type`
 * as an unhandled 500 — a stack trace where a sentence was needed.
 */
function requiredColumns(objectKey) {
    return [...columnsOf(objectKey).values()]
        .filter((c) => c.notnull && c.dflt_value === null && !c.pk)
        .map((c) => c.name);
}

export function insert(table, row) {
    const keys = Object.keys(row).filter((k) => row[k] !== undefined);
    run(
        `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
        keys.map((k) => bind(row[k])),
    );
}

export function update(table, recordId, values) {
    const keys = Object.keys(values).filter((k) => values[k] !== undefined);
    if (!keys.length) return;
    run(
        `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
        [...keys.map((k) => bind(values[k])), recordId],
    );
}

function resolveAccountId(parentType, parentId) {
    if (!parentType || !parentId) return null;
    if (parentType === 'account') return parentId;
    const table = OBJECTS[parentType]?.table;
    if (!table) return null;
    return get(`SELECT account_id FROM ${table} WHERE id = ?`, [parentId])?.account_id ?? null;
}

const PREFIXES = {
    account: 'acc', contact: 'con', deal: 'dea', task: 'tsk', activity: 'act',
    note: 'not', document: 'doc', proposal: 'pro', agreement: 'agr', campaign: 'cmp',
};
function prefixFor(objectKey) {
    return PREFIXES[objectKey] ?? objectKey.slice(0, 3);
}

export { resolveAccountId };
