/**
 * Apollo transport. Nothing here interprets a result — that is
 * `lib/people-search.mjs`'s job. This file only makes the calls correctly
 * and hands back raw payloads.
 *
 * ── THE CONTRACT (verified against Apollo docs 2024-06) ───────────────────
 *   Base  https://api.apollo.io/api/v1
 *   Auth  x-api-key: <key>   (NOT Bearer, NOT api_key= query)
 *
 *   POST /mixed_people/api_search   — search net-new people (0 credits).
 *        Query params: person_titles[], person_seniorities[], person_locations[],
 *        q_organization_domains_list[] (NOT q_organization_domains[] — that
 *        name does not exist and Apollo silently ignores it rather than
 *        erroring, so a domain-anchored search ran with no domain filter at
 *        all for a while and read as "no result found" for most companies),
 *        organization_num_employees_ranges[], q_keywords, per_page (1-100),
 *        page (1-500). 50k display limit. Does NOT return email/phone — see
 *        bulk enrich.
 *
 *   POST /people/bulk_match   — reveal email/phone for ids found above.
 *        Body: { details: [{ id }] }, reveal_personal_emails, reveal_phone_number.
 *        This IS billable (plan-dependent); caller must have asked for it.
 *        NOT under /mixed_people/ — that prefix is the search family only.
 *        Hitting /mixed_people/bulk_match 404s regardless of plan; this was
 *        wrong here for a while and read as "wrong plan" when it was really
 *        just the wrong path (verified against Apollo's docs 2026-08).
 *        PHONE IS NOT SYNCHRONOUS: reveal_phone_number requires a
 *        webhook_url and Apollo delivers the number to it LATER, off this
 *        response entirely — this transport does not offer phone reveal for
 *        exactly that reason (see bulkEnrich below).
 *
 * Two hosts exist in docs (`api.apollo.io`); x-api-key header name is
 * case-insensitive per spec but we send canonical `x-api-key`.
 */
import { badRequest } from './http.mjs';

export const DEFAULT_BASE = 'https://api.apollo.io/api/v1';

/**
 * People search — returns Apollo's raw page.
 * `filters` is a plain object with the query-param vocabulary (arrays for
 * repeating params). `options.fetcher` is injected in tests like bounceban.
 */
export async function searchPeople(filters = {}, apiKey, options = {}) {
    if (!apiKey) throw badRequest('Apollo API key is not configured.');
    const base = (options.apiUrl || DEFAULT_BASE).replace(/\/$/, '');
    const url = new URL(`${base}/mixed_people/api_search`);

    // Apollo's search is POST with query params on the URL; body is {}.
    // Repeating params are encoded as `person_titles[]=…` per docs.
    const appendArray = (key, arr) => {
        if (!arr?.length) return;
        for (const v of arr) if (String(v).trim()) url.searchParams.append(`${key}[]`, String(v).trim());
    };
    if (filters.person_titles?.length) appendArray('person_titles', filters.person_titles);
    if (filters.person_seniorities?.length) appendArray('person_seniorities', filters.person_seniorities);
    if (filters.person_locations?.length) appendArray('person_locations', filters.person_locations);
    // The real param is `q_organization_domains_list[]`, not
    // `q_organization_domains[]` — Apollo silently ignores an unknown param
    // rather than 400ing on it, so a domain-anchored "Find people at this
    // company" search ran with NO domain filter at all and returned whatever
    // the other filters (often none) matched — which for most companies
    // read as "no result found" or results from the wrong company entirely.
    if (filters.q_organization_domains?.length) appendArray('q_organization_domains_list', filters.q_organization_domains);
    if (filters.organization_locations?.length) appendArray('organization_locations', filters.organization_locations);
    if (filters.q_keywords) url.searchParams.set('q_keywords', String(filters.q_keywords));
    if (filters.organization_num_employees_ranges?.length) appendArray('organization_num_employees_ranges', filters.organization_num_employees_ranges);

    url.searchParams.set('per_page', String(Math.min(100, Math.max(1, Number(filters.per_page) || 25))));
    url.searchParams.set('page', String(Math.max(1, Number(filters.page) || 1)));

    const fetcher = options.fetcher ?? fetch;
    let res;
    try {
        res = await fetcher(url.href, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': apiKey },
            body: JSON.stringify({}),
        });
    } catch (e) {
        throw badRequest(`Could not reach Apollo: ${e?.cause?.code ?? e.message}`);
    }
    if (res.status === 401) throw badRequest('Apollo rejected the API key (401). Check Settings → Integrations → Apollo.');
    if (res.status === 403) throw badRequest('Apollo refused this search (403) — master API key required or plan does not include People Search.');
    if (res.status === 429) throw badRequest('Apollo rate limit hit (429). Wait a moment and retry.');
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw badRequest(`Apollo search failed (${res.status}). ${text.slice(0, 300)}`.trim());
    }
    const payload = await res.json();
    // Keep raw for debugging; caller interprets.
    return { payload };
}

/**
 * Bulk enrich — reveal email (and optionally phone) for ids found by search.
 *
 * PHONE REVEAL is async: Apollo requires a `webhook_url` when
 * `reveal_phone_number` is true. The number itself is delivered to that URL
 * LATER — never in this response's `matches`. When `options.webhookUrl` is
 * supplied and `reveal.phone` is true, we send both flags; otherwise phone
 * is always false (the old behaviour).
 */
export async function bulkEnrich(ids, apiKey, reveal = { email: true, phone: false }, options = {}) {
    if (!apiKey) throw badRequest('Apollo API key is not configured.');
    if (!ids?.length) return { payload: { matches: [] } };
    if (ids.length > 10) throw badRequest('Bulk enrich is capped at 10 ids per call (Apollo limit).');

    const base = (options.apiUrl || DEFAULT_BASE).replace(/\/$/, '');
    const url = new URL(`${base}/people/bulk_match`);
    const fetcher = options.fetcher ?? fetch;

    const revealPhone = Boolean(reveal.phone) && Boolean(options.webhookUrl);
    let res;
    try {
        res = await fetcher(url.href, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': apiKey },
            body: JSON.stringify({
                details: ids.map((id) => ({ id: String(id) })),
                reveal_personal_emails: Boolean(reveal.email),
                reveal_phone_number: revealPhone,
                ...(revealPhone ? { webhook_url: options.webhookUrl } : {}),
            }),
        });
    } catch (e) {
        throw badRequest(`Could not reach Apollo: ${e?.cause?.code ?? e.message}`);
    }
    if (res.status === 401) throw badRequest('Apollo rejected the API key (401).');
    if (res.status === 429) throw badRequest('Apollo rate limit hit (429). Wait a moment and retry.');
    if (res.status === 404) {
        throw badRequest(
            'Apollo enrich failed (404) — bulk_match was not found at this URL. This is not "the person was '
            + "not found\" (Apollo returns 200 with empty matches for that); it means the endpoint itself is "
            + 'wrong for this account. Check Settings → Integrations → Apollo: a custom API URL override, or a '
            + `plan that does not include this endpoint, are the two known causes. Called: ${url.href.replace(/\?.*$/, '')}`,
        );
    }
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw badRequest(`Apollo enrich failed (${res.status}). ${text.slice(0, 300)}`.trim());
    }
    const payload = await res.json();
    return { payload };
}
