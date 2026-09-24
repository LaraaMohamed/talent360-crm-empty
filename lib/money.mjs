/**
 * Deal money.
 *
 * The single most consequential rule in this file, and the reason `deals` has
 * no `amount` column:
 *
 *   ONE-TIME AND RECURRING REVENUE ARE NEVER SUMMED INTO ONE HEADLINE NUMBER.
 *
 * A dashboard showing "pipeline: 2.4M" that has added a placement fee to 24
 * months of retainer is not reporting, it is fiction — and it is the most
 * common reporting error in service businesses. Every function here returns the
 * figures separately and labelled; `total_contract_value` is the only one that
 * combines them, and it says so in its name and carries the term it assumed.
 *
 * ── DEAL SIZE IS A PRICE AND A CURRENCY ─────────────────────────────────────
 *
 * It used to be four pricing models with a quantity, a unit amount, a percent
 * rate and a basis amount, and the person raising a deal had to decide which of
 * those shapes their sale was before they could type a number into it. In
 * practice they typed the number they had been quoted, into whichever box
 * looked most like a number, and the model was noise — two of the three deals
 * in production carried a quantity nobody meant.
 *
 * So a deal is priced the way it is sold: ONE PRICE, in ONE CURRENCY. Quantity
 * and unit are gone from the model, the API, the forms and the arithmetic.
 *
 * ── WHETHER THAT PRICE REPEATS IS THE SERVICE'S DECISION ────────────────────
 *
 * Whether the price is billed once or every month is not a question either. It
 * follows the SERVICE, and always has:
 *
 *   HCM         per seat        →  recurring
 *   Offshoring  per headcount   →  recurring
 *   Recruitment placement fee   →  one-time
 *   OD          fixed fee       →  one-time
 *
 * `service_lines.pricing_model` already carries that fact for each service, so
 * the classification is read from the workspace's own configuration rather than
 * hard-coded against four names — a workspace that adds a fifth service says
 * how it bills by choosing its pricing model, and everything downstream
 * follows.
 */

/**
 * The pricing models a SERVICE LINE can carry, and whether each one repeats.
 *
 * This is now the whole of what a pricing model decides. It no longer shapes
 * the deal's form, because the form is a price and a currency whichever service
 * it is for.
 */
export const RECURRING_PRICING_MODELS = new Set(['per_seat', 'per_headcount', 'retainer', 'subscription']);

/**
 * The services priced PER PERSON, and what the people are called.
 *
 * ── WHY A COUNT CAME BACK ───────────────────────────────────────────────────
 *
 * Deal size was collapsed to a single price because the old form asked four
 * pricing models, a quantity, a unit amount, a percentage and a basis before
 * anybody could type the number they had been quoted. That was right for
 * Recruitment and OD, which are quoted as one figure.
 *
 * It was wrong for OFFSHORING, which is not. Offshoring is quoted as a
 * headcount and a rate per head, and that is not a form detail — it is the
 * commercial fact. "Twelve people at 3,000 a month" and "36,000 a month" are
 * the same money and different information: only the first survives one of the
 * twelve leaving, and only the first can be re-quoted when the rate moves.
 *
 * ── ONE SERVICE, NOT TWO ────────────────────────────────────────────────────
 *
 * HCM's pricing model is `per_seat`, so it looked like the same shape and was
 * briefly given the same form. It is not: HCM is quoted as a monthly fee for
 * the engagement, and asking "how many seats?" would have put a required field
 * in front of every HCM deal to collect a number nobody negotiates. HCM still
 * RECURS — that is `RECURRING_PRICING_MODELS` above, and unchanged — it is
 * simply priced as one figure.
 *
 * So this is a list of one, and deliberately a list: a workspace that starts
 * selling a second per-head service adds it here and gets the form, the
 * arithmetic and the wording without touching anything else.
 */
export const PER_PERSON_MODELS = {
    per_headcount: { unit: 'employee', unitPlural: 'employees', countLabel: 'Employees' },
};

/** The per-person shape of a pricing model, or null when it is a flat price. */
export function perPersonPricing(pricingModel) {
    return PER_PERSON_MODELS[String(pricingModel ?? '')] ?? null;
}

/** `recurring` | `one_time` — how a service line bills. */
export function billingTypeForPricingModel(pricingModel) {
    return RECURRING_PRICING_MODELS.has(String(pricingModel ?? '')) ? 'recurring' : 'one_time';
}

/**
 * The line item's `recurrence` for a service line's pricing model.
 *
 * `monthly` and `one_time` are the two values the column has always held, so
 * this is a translation between the service's vocabulary and the money engine's
 * rather than a new state.
 */
export function recurrenceForPricingModel(pricingModel) {
    return billingTypeForPricingModel(pricingModel) === 'recurring' ? 'monthly' : 'one_time';
}

/** The label a person reads. One place, so the UI and the documents agree. */
export function billingTypeLabel(billingType) {
    return billingType === 'recurring' ? 'Recurring' : 'One-time';
}

/** Assumed term for a recurring line with no term stated. Always flagged. */
export const ASSUMED_TERM_MONTHS = 12;

/**
 * The value of a single priced line, in its own currency and in base currency.
 *
 * `monthly` is the per-month figure for recurring lines and 0 for one-time
 * ones; `oneTime` is the reverse. Nothing here ever returns a single blended
 * number, because there is no honest way to produce one.
 *
 * The price is `unit_amount` and nothing multiplies it. The column keeps its
 * name because renaming a column across a live database to say the same thing
 * differently buys nothing; `price` is what every caller passes in and what
 * every screen calls it.
 */
export function lineValue(item) {
    const unitPrice = Number(item.unit_amount) || 0;
    const fx = Number(item.fx_rate) || 1;
    const recurrence = item.recurrence === 'monthly' ? 'monthly' : 'one_time';

    /**
     * The headcount, for the services that are priced per person.
     *
     * Defaults to 1 and is 1 for every flat-priced service, so `price` below is
     * the deal's size either way and nothing downstream has to ask which shape
     * it is looking at. A count of zero is a real answer — a contract that has
     * ramped down to nobody is worth nothing this month — so it is not
     * coerced up to one.
     */
    const stated = Number(item.quantity);
    const count = Number.isFinite(stated) && stated >= 0 ? stated : 1;
    const price = unitPrice * count;

    const oneTime = recurrence === 'monthly' ? 0 : price;
    const monthly = recurrence === 'monthly' ? price : 0;

    const termStated = Number.isFinite(Number(item.term_months)) && Number(item.term_months) > 0;
    const term = recurrence === 'monthly' ? (termStated ? Number(item.term_months) : ASSUMED_TERM_MONTHS) : 0;

    return {
        price,
        // The two halves that produced it, so a screen can show "12 × 3,000"
        // rather than only the product.
        unitPrice,
        count,
        recurrence,
        billingType: recurrence === 'monthly' ? 'recurring' : 'one_time',
        oneTime,
        monthly,
        termMonths: term,
        termAssumed: recurrence === 'monthly' && !termStated,
        // Contract value of THIS line — one-time plus its own recurring total.
        // Correct per line; still never added to an MRR figure.
        lineContractValue: oneTime + monthly * term,
        // Null rather than a fabricated 'SAR'. This value feeds the
        // mixed-currency check and nothing else, and inventing one made a deal
        // with one EGP line and one unmarked line look like two currencies.
        currency: item.currency || null,
        baseOneTime: oneTime * fx,
        baseMonthly: monthly * fx,
        baseContractValue: (oneTime + monthly * term) * fx,
    };
}

/**
 * Rolls a deal's line items up into the five figures the product reports, all
 * in workspace base currency.
 *
 *   value_one_time  Σ non-recurring line totals
 *   value_mrr       Σ recurring monthly totals
 *   value_arr       MRR × 12
 *   value_tcv       one-time + Σ(monthly × that line's term)   ← the only combined figure
 *   value_weighted  one-time × probability   (weighting a retainer's MRR by a
 *                   close probability produces a number with no meaning, so
 *                   recurring is weighted separately as weighted_mrr)
 */
export function deriveValues(items, { probability = 0, baseCurrency = 'USD' } = {}) {
    let oneTime = 0;
    let mrr = 0;
    let tcv = 0;
    let assumedTerms = 0;
    const currencies = new Set();

    /**
     * The same three figures, WITHOUT the per-line `fx_rate` applied.
     *
     * `fx_rate` is a point-in-time multiplier somebody can type on a line item,
     * and it converts into the workspace base currency. Management reporting
     * converts into USD from the deal's own currency using the admin's current
     * rate, so it has to start from the untouched amount — converting the
     * already-converted figure would apply two rates to one number.
     */
    let ownOneTime = 0;
    let ownMrr = 0;
    let ownTcv = 0;

    for (const item of items) {
        const v = lineValue(item);
        oneTime += v.baseOneTime;
        mrr += v.baseMonthly;
        tcv += v.baseContractValue;
        ownOneTime += v.oneTime;
        ownMrr += v.monthly;
        ownTcv += v.lineContractValue;
        if (v.termAssumed) assumedTerms += 1;
        // A line that states no currency is not evidence of a second one.
        if (v.currency) currencies.add(v.currency);
    }

    const p = Math.max(0, Math.min(1, Number(probability) || 0));

    return {
        value_one_time: round(oneTime),
        value_mrr: round(mrr),
        value_arr: round(mrr * 12),
        value_tcv: round(tcv),
        value_weighted: round(oneTime * p),
        value_weighted_mrr: round(mrr * p),
        // In the deal's OWN currency, for the reporting layer to convert.
        own_one_time: round(ownOneTime),
        own_mrr: round(ownMrr),
        own_tcv: round(ownTcv),
        own_weighted: round(ownOneTime * p),
        currency: baseCurrency,
        line_item_count: items.length,
        // Surfaced, not hidden: a TCV built on an assumed term is a different
        // claim from one built on a stated term.
        assumed_terms: assumedTerms,
        mixed_currencies: currencies.size > 1,
        currencies: [...currencies],
    };
}

/**
 * Aggregates many deals. Same rule: two headline numbers, never one.
 */
export function aggregate(deals) {
    const out = {
        count: deals.length,
        one_time: 0,
        mrr: 0,
        arr: 0,
        weighted_one_time: 0,
        weighted_mrr: 0,
        tcv: 0,
    };
    for (const d of deals) {
        out.one_time += d.value_one_time ?? 0;
        out.mrr += d.value_mrr ?? 0;
        out.weighted_one_time += d.value_weighted ?? 0;
        out.weighted_mrr += d.value_weighted_mrr ?? 0;
        out.tcv += d.value_tcv ?? 0;
    }
    out.arr = round(out.mrr * 12);
    for (const k of ['one_time', 'mrr', 'weighted_one_time', 'weighted_mrr', 'tcv']) out[k] = round(out[k]);
    return out;
}

export function formatMoney(amount, currency = 'USD', locale = 'en') {
    try {
        return new Intl.NumberFormat(locale, {
            style: 'currency', currency, maximumFractionDigits: 0,
        }).format(Number(amount) || 0);
    } catch {
        return `${currency} ${Math.round(Number(amount) || 0).toLocaleString()}`;
    }
}

function round(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

/* ------------------------------------------------- management reporting -- */

/**
 * The currency management reports in. One value, not a setting per report.
 */
export const REPORTING_CURRENCY = 'USD';

/**
 * The admin's rates, as UNITS PER USD, with USD itself pinned at 1.
 *
 * Taken from settings so an admin changes them without a deploy. A rate that
 * is missing, zero or negative would silently produce Infinity or a negative
 * total, so it falls back to the default rather than poisoning a dashboard.
 */
export function reportingRates(settingsFor) {
    const rate = (key, fallback) => {
        const value = Number(settingsFor(key));
        return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    return {
        USD: 1,
        EGP: rate('fx_egp_per_usd', 50),
        SAR: rate('fx_sar_per_usd', 3.75),
    };
}

/**
 * One amount, in the client's currency, expressed in USD.
 *
 *   USD   → unchanged
 *   EGP   → amount ÷ EGP-per-USD
 *   SAR   → amount ÷ SAR-per-USD
 *
 * A currency with no rate returns null rather than a number: reporting an
 * unconvertible amount as though it were dollars is worse than admitting the
 * rate is missing, and the caller can then say so.
 */
export function toReporting(amount, currency, rates) {
    const value = Number(amount) || 0;
    const rate = rates?.[String(currency ?? '').toUpperCase()];
    if (!Number.isFinite(rate) || rate <= 0) return null;
    return round(value / rate);
}

/**
 * Aggregates deals into USD, converting each one by ITS OWN currency first.
 *
 * This is the difference between a total and a number: `aggregate` above sums
 * `value_one_time` across deals without looking at currency, which is correct
 * only while every deal shares one. Add an EGP deal to a SAR pipeline and it
 * quietly reports 500,000 + 100,000 as though the units matched.
 *
 * Conversion is from the deal's own-currency figures, never the fx-multiplied
 * ones, so a line item carrying an `fx_rate` cannot have two rates applied to
 * it. Deals whose own line items disagree about currency are counted and
 * reported rather than silently folded in — the caller decides what to say.
 */
/**
 * The probability a deal's own figures were already weighted by.
 *
 * Read back from the two numbers rather than looked up again: `value_weighted`
 * is `one_time × p`, and re-deriving `p` from a stage here would be a second
 * opinion that can disagree with the first.
 *
 * A deal with no one-time value has no ratio to recover, so fall back to the
 * stage probability (or the deal's own override).  Without this, purely
 * recurring deals contribute zero to the forecast — the pipeline counts them
 * fully but the forecast ignores them, making the forecast permanently smaller
 * than the pipeline for any workspace with retainers.
 */
function probabilityOf(deal) {
    const base = Number(deal.own_one_time) || 0;
    if (base) return (Number(deal.own_weighted) || 0) / base;
    // Stage probabilities and the deal override are stored as 0-100; normalise
    // to 0-1 to match the weighted figures which were computed in that scale.
    const fallback = Number(deal.probability) || Number(deal.stage_probability) || 0;
    return Math.max(0, Math.min(1, fallback / 100));
}

export function aggregateInReporting(deals, rates) {
    const out = {
        currency: REPORTING_CURRENCY,
        count: deals.length,
        one_time: 0,
        mrr: 0,
        arr: 0,
        weighted_one_time: 0,
        // The recurring half of the weighting. `aggregate` has always carried it;
        // this one did not, so a forecast that weights recurring value had to
        // reach for a key that was quietly undefined.
        weighted_mrr: 0,
        tcv: 0,
        // Deals we could not convert, because their currency has no rate.
        unconvertible: 0,
        // Deals whose own line items are in more than one currency.
        mixed: 0,
    };

    for (const deal of deals) {
        if (deal.mixed_currencies) out.mixed += 1;
        const currency = deal.currency ?? REPORTING_CURRENCY;
        const oneTime = toReporting(deal.own_one_time ?? 0, currency, rates);
        if (oneTime === null) { out.unconvertible += 1; continue; }

        out.one_time += oneTime;
        out.mrr += toReporting(deal.own_mrr ?? 0, currency, rates) ?? 0;
        out.weighted_one_time += toReporting(deal.own_weighted ?? 0, currency, rates) ?? 0;
        out.weighted_mrr += toReporting((deal.own_mrr ?? 0) * probabilityOf(deal), currency, rates) ?? 0;
        out.tcv += toReporting(deal.own_tcv ?? 0, currency, rates) ?? 0;
    }

    out.arr = round(out.mrr * 12);
    for (const k of ['one_time', 'mrr', 'weighted_one_time', 'weighted_mrr', 'tcv']) out[k] = round(out[k]);
    return out;
}
