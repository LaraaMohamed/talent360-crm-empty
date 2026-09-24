/**
 * People discovery — provider-neutral, mirroring lib/verification.mjs.
 *
 * The CRM never learns Apollo's vocabulary. Raw Apollo payloads are mapped
 * once, here, into the CRM's own person shape, kept beside the raw JSON for
 * audit. Adding a provider (PDL, etc.) = one entry in `PROVIDERS` + its
 * transport, not a rewrite.
 *
 * ── CANONICAL PERSON (what the UI and import understand) ──────────────────
 *   { provider, providerId, firstName, lastName, fullName, title, seniority,
 *     email, emailSource, phone, linkedinUrl, organizationName, domain, raw }
 * Search never fills email/phone; enrich does (when the user explicitly
 * asks, because only that is billable).
 */
import { badRequest } from './http.mjs';
import { setting } from './settings.mjs';
import * as apollo from './apollo.mjs';

/** Normalize Apollo search hit → canonical; keep raw beside it. */
function mapApolloPerson(hit) {
    const org = hit.organization ?? {};
    const linkedIn = hit.linkedin_url ?? hit.linkedinUrl ?? null;
    return {
        provider: 'apollo',
        providerId: String(hit.id ?? ''),
        firstName: hit.first_name ?? hit.firstName ?? '',
        lastName: hit.last_name ?? hit.lastName ?? '',
        fullName: hit.name ?? [hit.first_name, hit.last_name].filter(Boolean).join(' ').trim(),
        title: hit.title ?? '',
        seniority: hit.seniority ?? null,
        email: hit.email ?? null,           // null on search; filled on enrich
        emailSource: hit.email_status ?? null,
        phone: hit.phone_numbers?.[0]?.sanitized_number ?? hit.sanitized_phone ?? null,
        linkedinUrl: linkedIn,
        photoUrl: hit.photo_url ?? null,
        city: hit.city ?? null,
        country: hit.country ?? null,
        organizationName: org.name ?? hit.organization_name ?? null,
        domain: org.primary_domain ?? org.domain ?? null,
        employmentHistory: hit.employment_history ?? [],
        raw: hit,
    };
}

/** Apollo enrich hit → patch email/phone onto canonical. */
function patchApolloEnriched(canonical, enriched) {
    const next = { ...canonical };
    if (enriched.email) { next.email = enriched.email; next.emailSource = enriched.email_status ?? 'enriched'; }
    const phone = enriched.sanitized_phone ?? enriched.phone_numbers?.[0]?.sanitized_number ?? null;
    if (phone) next.phone = phone;
    if (enriched.linkedin_url && !next.linkedinUrl) next.linkedinUrl = enriched.linkedin_url;
    return next;
}

/**
 * Apollo bulk_match's raw match object → the flat `{email, phone, ...}`
 * shape the UI actually reads (`patch.email`, `patch.phone`).
 *
 * This used to be skipped entirely — the raw Apollo object went straight to
 * the browser. Email happened to still work by coincidence (Apollo's field
 * is also called `email`), but nothing else did: phone is never a flat
 * `.phone` on Apollo's side (nested under `phone_numbers[].sanitized_number`,
 * when phone is even present — see lib/apollo.mjs's header on why it never
 * is), and a raw object with unfamiliar field names is exactly how "reveal
 * email" can come back reading as almost empty — present fields the UI
 * happens to share a name with, everything else silently absent.
 */
function mapApolloEnrichedMatch(m) {
    return {
        providerId: String(m.id ?? m.person_id ?? ''),
        firstName: m.first_name ?? '',
        lastName: m.last_name ?? '',
        title: m.title ?? '',
        email: m.email ?? null,
        emailSource: m.email_status ?? null,
        phone: m.sanitized_phone ?? m.phone_numbers?.[0]?.sanitized_number ?? null,
        linkedinUrl: m.linkedin_url ?? null,
    };
}

export const PROVIDERS = {
    apollo: {
        key: 'apollo',
        label: 'Apollo',
        settingKey: 'apollo_api_key',
        endpointSetting: 'apollo_api_url',
        defaultEndpoint: apollo.DEFAULT_BASE,
        search: async (filters, apiKey, opts) => {
            const { payload } = await apollo.searchPeople(filters, apiKey, opts);
            const raw = payload?.people ?? payload?.contacts ?? [];
            return {
                people: raw.map(mapApolloPerson),
                total: payload?.pagination?.total_entries ?? payload?.total_entries ?? raw.length,
                page: payload?.pagination?.page ?? filters.page ?? 1,
                perPage: payload?.pagination?.per_page ?? filters.per_page ?? raw.length,
                raw: payload,
            };
        },
        enrich: async (ids, apiKey, reveal, opts) => {
            const { payload } = await apollo.bulkEnrich(ids, apiKey, reveal, opts);
            const matches = payload?.matches ?? payload?.people ?? [];
            // Canonicalized — see mapApolloEnrichedMatch's own comment for
            // why the raw Apollo object cannot be handed to the UI as-is.
            const byId = new Map(matches.map((m) => {
                const mapped = mapApolloEnrichedMatch(m);
                return [mapped.providerId, mapped];
            }));
            return { byId, raw: payload };
        },
        patchEnriched: patchApolloEnriched,
    },
};

export function activeProvider(workspaceId) {
    const key = setting(workspaceId, 'people_search_provider') ?? 'apollo';
    const p = PROVIDERS[key];
    if (!p) throw badRequest(`Unknown people-search provider "${key}".`);
    return p;
}

export function isConfigured(workspaceId) {
    try {
        const p = activeProvider(workspaceId);
        return Boolean(setting(workspaceId, p.settingKey));
    } catch { return false; }
}

/** Search people at a company (or free-form when domain is missing). */
export async function searchAtCompany({ workspaceId, domain, companyName, filters = {}, page = 1, perPage = 25, fetcher = null }) {
    const provider = activeProvider(workspaceId);
    const apiKey = setting(workspaceId, provider.settingKey);
    if (!apiKey) throw badRequest(`${provider.label} API key is not configured. Add it in Settings → Integrations.`);
    const apiUrl = setting(workspaceId, provider.endpointSetting) ?? provider.defaultEndpoint;

    // Domain is the strongest signal; fall back to keywords (can be noisy).
    const qDomains = domain ? [String(domain).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase()] : [];
    const merged = {
        ...filters,
        q_organization_domains: filters.q_organization_domains ?? qDomains,
        q_keywords: filters.q_keywords ?? (qDomains.length ? undefined : companyName),
        page, per_page: perPage,
    };
    return provider.search(merged, apiKey, { apiUrl, fetcher });
}

/** Reveal email/phone for selected ids — billable, explicit. */
export async function enrichPeople({ workspaceId, ids, reveal = { email: true, phone: false }, webhookUrl = null, fetcher = null }) {
    if (!ids?.length) throw badRequest('Select people to enrich.');
    if (ids.length > 10) throw badRequest('Pick up to 10 at a time (provider limit).');
    const provider = activeProvider(workspaceId);
    const apiKey = setting(workspaceId, provider.settingKey);
    if (!apiKey) throw badRequest(`${provider.label} API key is not configured.`);
    const apiUrl = setting(workspaceId, provider.endpointSetting) ?? provider.defaultEndpoint;
    const { byId } = await provider.enrich(ids, apiKey, reveal, { apiUrl, fetcher, webhookUrl });
    return { byId, provider: provider.key };
}

/** Map canonical people into CRM contacts Prospecting import rows. */
export function canonicalToProspectContact(canonical, prospectId) {
    return {
        prospect_id: prospectId,
        first_name: canonical.firstName ?? '',
        last_name: canonical.lastName ?? '',
        title: canonical.title ?? '',
        email: canonical.email ?? null,
        phone: canonical.phone ?? null,
        linkedin_url: canonical.linkedinUrl ?? null,
        _provider: canonical.provider,
        _providerId: canonical.providerId,
        _raw: canonical.raw,
    };
}
