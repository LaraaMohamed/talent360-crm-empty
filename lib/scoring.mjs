/**
 * Lead scoring — configurable, explainable, and separate from qualification.
 *
 * ── WHY SCORING IS NOT QUALIFICATION ────────────────────────────────────────
 *
 * A verdict answers a CLAIM: "this company has an HR gap", proven or not, from
 * evidence. A score answers a PRIORITY: "work this one before that one". They
 * are different questions and must not be collapsed:
 *
 *   · A verdict can be REJECTED and the company still worth a call.
 *   · A score of 78 proves nothing about anything and must never be presented
 *     as though it did.
 *
 * So scores live beside verdicts, never inside them, and a score never changes
 * a verdict. `lib/qualification.mjs` stays the only thing that decides truth.
 *
 * ── EVERY NUMBER EXPLAINS ITSELF ────────────────────────────────────────────
 *
 * Each component returns its score AND the reason for it. A lead score nobody
 * can account for is a number people stop trusting the first time it disagrees
 * with them, and after that it is decoration. `explain` is not a debug feature.
 *
 * ── NOTHING HERE IS HARDCODED ───────────────────────────────────────────────
 *
 * Bands, weights, industry preferences and the ICP itself are configuration.
 * DEFAULT_MODEL is a starting point a workspace immediately owns, not a rule.
 */

/** Clamp to 0-100. Component scores are always on this scale. */
const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';

/**
 * The model a workspace starts with.
 *
 * Weights are relative, not percentages — they are normalised at the end, so
 * an admin can set one to 40 without having to make the rest sum to 60.
 */
export const DEFAULT_MODEL = {
    version: 1,
    weights: {
        qualification: 30,
        icp: 20,
        size: 15,
        industry: 15,
        decision_maker: 10,
        enrichment: 10,
    },
    qualification: {
        // Score per rule this company currently QUALIFIES for, capped. A company
        // qualifying for two services is a better lead than one qualifying for
        // one, but not twice as good.
        per_qualified_rule: 55,
        per_review_rule: 20,
        max: 100,
    },
    icp: {
        // The Ideal Customer Profile, stated explicitly so it can be argued
        // with. Each match contributes its weight; the total is normalised.
        countries: { values: ['Saudi Arabia', 'United Arab Emirates', 'Egypt', 'Qatar', 'Kuwait', 'Bahrain', 'Oman'], weight: 40 },
        industries: { values: [], weight: 30 },
        employees: { min: 50, max: 5000, weight: 30 },
    },
    size: {
        // Bands, not a formula: consultancy fit is not linear in headcount.
        bands: [
            { min: 0, max: 9, score: 10, label: 'Micro' },
            { min: 10, max: 49, score: 40, label: 'Small' },
            { min: 50, max: 199, score: 80, label: 'Mid-market' },
            { min: 200, max: 999, score: 100, label: 'Large' },
            { min: 1000, max: null, score: 70, label: 'Enterprise' },
        ],
        unknown_score: 30,
    },
    industry: {
        default_score: 40,
        scores: {
            'oil & energy': 90,
            construction: 85,
            'information technology & services': 80,
            'financial services': 80,
            'management consulting': 70,
            'logistics & supply chain': 70,
            'mechanical or industrial engineering': 70,
            retail: 55,
            'food & beverages': 50,
        },
    },
    decision_maker: {
        roles: ['decision_maker', 'champion'],
        per_contact: 45,
        // A verified email on a decision maker is worth more than a name: it is
        // the difference between knowing who to call and being able to reach them.
        verified_email_bonus: 20,
        max: 100,
    },
    enrichment: {
        // Completeness of the fields that make a company workable.
        fields: ['domain', 'website', 'linkedin_slug', 'industry', 'employee_count', 'country', 'city', 'phone'],
        // Evidence older than this stops counting as fresh.
        fresh_days: 180,
        freshness_weight: 30,
    },
};

/** Merge a stored model over the defaults so a partial config is still valid. */
export function resolveModel(stored) {
    if (!stored || typeof stored !== 'object') return DEFAULT_MODEL;
    const merged = { ...DEFAULT_MODEL, ...stored };
    for (const key of ['weights', 'qualification', 'icp', 'size', 'industry', 'decision_maker', 'enrichment']) {
        merged[key] = { ...DEFAULT_MODEL[key], ...(stored[key] ?? {}) };
    }
    return merged;
}

/* ------------------------------------------------------------ components -- */

function scoreSize(record, model) {
    const n = Number(record.employee_count);
    if (!Number.isFinite(n) || n <= 0) {
        return { score: clamp(model.size.unknown_score), why: 'Headcount is unknown.' };
    }
    const band = model.size.bands.find((b) => n >= b.min && (b.max === null || b.max === undefined || n <= b.max));
    if (!band) return { score: clamp(model.size.unknown_score), why: `${n} employees falls outside every configured band.` };
    return { score: clamp(band.score), why: `${n} employees — ${band.label ?? 'band'}.` };
}

function scoreIndustry(record, model) {
    const key = String(record.industry ?? '').trim().toLowerCase();
    if (!key) return { score: clamp(model.industry.default_score), why: 'Industry is unknown.' };
    const configured = model.industry.scores?.[key];
    if (configured === undefined) {
        return { score: clamp(model.industry.default_score), why: `"${record.industry}" has no configured score.` };
    }
    return { score: clamp(configured), why: `"${record.industry}" is a configured industry.` };
}

function scoreIcp(record, model) {
    const parts = [];
    let earned = 0;
    let possible = 0;

    const { countries, industries, employees } = model.icp;

    if (countries?.weight) {
        possible += countries.weight;
        const list = (countries.values ?? []).map((v) => String(v).toLowerCase());
        const value = String(record.country ?? '').toLowerCase();
        // An empty target list means "no preference", which must score as a
        // match rather than silently penalising every company.
        const hit = !list.length || (value && list.includes(value));
        if (hit) { earned += countries.weight; parts.push(`country ${record.country || 'unset'} in profile`); }
        else parts.push(`country ${record.country || 'unset'} outside profile`);
    }

    if (industries?.weight) {
        possible += industries.weight;
        const list = (industries.values ?? []).map((v) => String(v).toLowerCase());
        const value = String(record.industry ?? '').toLowerCase();
        const hit = !list.length || (value && list.includes(value));
        if (hit) { earned += industries.weight; parts.push('industry in profile'); }
        else parts.push('industry outside profile');
    }

    if (employees?.weight) {
        possible += employees.weight;
        const n = Number(record.employee_count);
        const hit = Number.isFinite(n) && n > 0
            && (employees.min === null || n >= employees.min)
            && (employees.max === null || n <= employees.max);
        if (hit) { earned += employees.weight; parts.push(`headcount within ${employees.min}-${employees.max}`); }
        else parts.push('headcount outside profile');
    }

    if (!possible) return { score: 0, why: 'No ICP criteria are configured.' };
    return { score: clamp((earned / possible) * 100), why: parts.join('; ') };
}

function scoreQualification(verdicts, model) {
    const current = Object.values(verdicts ?? {});
    if (!current.length) return { score: 0, why: 'No rule has been run yet.' };

    const qualified = current.filter((v) => v.verdict === 'QUALIFIED');
    const review = current.filter((v) => v.verdict === 'REVIEW');

    const raw = qualified.length * model.qualification.per_qualified_rule
        + review.length * model.qualification.per_review_rule;

    const why = qualified.length
        ? `Qualifies for ${qualified.length} service${qualified.length === 1 ? '' : 's'}`
          + (review.length ? `, ${review.length} in review.` : '.')
        : review.length
            ? `${review.length} unresolved, none qualified yet.`
            : 'Rejected by every rule run so far.';

    return { score: clamp(Math.min(raw, model.qualification.max)), why };
}

function scoreDecisionMaker(contacts, model) {
    const list = contacts ?? [];
    if (!list.length) return { score: 0, why: 'No contacts on this company.' };

    const wanted = new Set((model.decision_maker.roles ?? []).map((r) => String(r).toLowerCase()));
    const matches = list.filter((c) => {
        const roles = Array.isArray(c.roles) ? c.roles : String(c.roles ?? '').split(',');
        return roles.some((r) => wanted.has(String(r).trim().toLowerCase()));
    });

    if (!matches.length) {
        return { score: 0, why: `${list.length} contact${list.length === 1 ? '' : 's'}, none flagged as a decision maker.` };
    }

    const reachable = matches.filter((c) => c.email_verified === 1 || c.email_verified === true);
    const raw = matches.length * model.decision_maker.per_contact
        + (reachable.length ? model.decision_maker.verified_email_bonus : 0);

    return {
        score: clamp(Math.min(raw, model.decision_maker.max)),
        why: `${matches.length} decision maker${matches.length === 1 ? '' : 's'}`
            + (reachable.length ? `, ${reachable.length} with a verified email.` : ', none with a verified email.'),
    };
}

function scoreEnrichment(record, model, evidenceAt) {
    const fields = model.enrichment.fields ?? [];
    const filled = fields.filter((key) => !isBlank(record[key]));
    const completeness = fields.length ? (filled.length / fields.length) * 100 : 0;

    const freshWeight = model.enrichment.freshness_weight ?? 0;
    let freshness = 0;
    let freshWhy = 'never enriched';
    if (evidenceAt) {
        const days = (Date.now() - new Date(evidenceAt).getTime()) / 86400000;
        const limit = model.enrichment.fresh_days || 180;
        freshness = days <= limit ? 100 : Math.max(0, 100 - ((days - limit) / limit) * 100);
        freshWhy = `evidence ${Math.round(days)} days old`;
    }

    const score = freshWeight
        ? ((completeness * (100 - freshWeight)) + (freshness * freshWeight)) / 100
        : completeness;

    return {
        score: clamp(score),
        why: `${filled.length} of ${fields.length} fields present, ${freshWhy}.`,
    };
}

/* ---------------------------------------------------------------- public -- */

/**
 * Score one company.
 *
 * Pure: everything it needs is passed in, so it is testable without a database
 * and cannot accidentally depend on request state.
 *
 *   record    the account or prospecting company
 *   verdicts  { ruleKey: { verdict } } — current verdicts only
 *   contacts  contacts attached to it
 *   evidenceAt  when it was last enriched
 */
export function scoreCompany(record, { verdicts = {}, contacts = [], evidenceAt = null } = {}, storedModel = null) {
    const model = resolveModel(storedModel);

    const components = {
        qualification: scoreQualification(verdicts, model),
        icp: scoreIcp(record, model),
        size: scoreSize(record, model),
        industry: scoreIndustry(record, model),
        decision_maker: scoreDecisionMaker(contacts, model),
        enrichment: scoreEnrichment(record, model, evidenceAt),
    };

    // Weights are relative and normalised here, so an admin never has to make
    // them sum to 100 — and a weight of 0 genuinely removes a component rather
    // than quietly contributing nothing while still diluting the rest.
    let weighted = 0;
    let totalWeight = 0;
    for (const [key, part] of Object.entries(components)) {
        const weight = Number(model.weights?.[key]) || 0;
        if (weight <= 0) continue;
        weighted += part.score * weight;
        totalWeight += weight;
    }
    const overall = totalWeight ? clamp(weighted / totalWeight) : 0;

    return {
        overall,
        components,
        explain: Object.entries(components).map(([key, part]) => ({
            key,
            score: part.score,
            weight: Number(model.weights?.[key]) || 0,
            why: part.why,
        })),
        modelVersion: model.version ?? 1,
    };
}

/** Column names the scores are stored under, for both company planes. */
export const SCORE_COLUMNS = {
    overall: 'score_overall',
    qualification: 'score_qualification',
    icp: 'score_icp',
    size: 'score_size',
    industry: 'score_industry',
    decision_maker: 'score_decision_maker',
    enrichment: 'score_enrichment',
};
