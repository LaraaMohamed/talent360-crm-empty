/**
 * Smartlead transport. Nothing here interprets a result into CRM meaning —
 * that is `lib/outreach.mjs`'s job. This file's only responsibility is to make
 * the call correctly and hand back the raw payload.
 *
 * ── THE CONTRACT (verified against Smartlead's current API reference) ───────
 *
 *   Base     https://server.smartlead.ai/api/v1
 *   Auth     ?api_key=… on EVERY request. There is no OAuth and no header
 *            scheme; a missing or wrong key is answered with 401.
 *   Replies  JSON. Errors carry { message } or { error }.
 *
 * Verified endpoints used here:
 *
 *   GET    /campaigns/                              list campaigns (paginated)
 *   GET    /campaigns/{id}/leads                    leads in one campaign
 *            query: offset, limit<=100, status, emailStatus,
 *                   created_at_gt / last_sent_time_gt / event_time_gt
 *            lead rows carry campaign_lead_map_id, status
 *            (STARTED|INPROGRESS|COMPLETED|PAUSED|STOPPED), lead_category_id,
 *            lead.{id,email,…}, is_unsubscribed
 *   POST   /campaigns/{id}/leads?lead_list=[…]&settings={…}
 *            max 400 per batch by the current docs (older docs said 100 — this
 *            client batches at 100 anyway, which both generations accept);
 *            returns added_count / skipped_count / skipped_leads[]
 *   POST   /campaigns/{id}/leads/{lead_id}/pause    stop sequencing one lead
 *   POST   /campaigns/{id}/leads/{lead_id}/resume   resume one lead
 *   POST   /webhook/create                          register a webhook
 *   GET    /webhook/{id}                            read one webhook
 *   DELETE /webhook/delete/{id}                     remove one webhook
 *
 * Rate limits are plan-dependent and undocumented per tier; the API answers
 * 429 when exceeded. Every caller is expected to treat 429 as "slow down" —
 * the enrolment engine batches sequentially for exactly this reason.
 */
import { HttpError } from './http.mjs';

export const DEFAULT_BASE = 'https://server.smartlead.ai/api/v1';

/** The sequence states Smartlead reports per lead-in-campaign. */
export const LEAD_SEQUENCE_STATUSES = ['STARTED', 'INPROGRESS', 'COMPLETED', 'PAUSED', 'STOPPED'];

/**
 * The webhook events Smartlead can subscribe to. Used verbatim as the keys of
 * an `event_type_map`; anything Smartlead adds later is passed through by the
 * enrolment of new webhooks without this file changing.
 */
export const WEBHOOK_EVENTS = [
    'EMAIL_SENT',
    'FIRST_EMAIL_SENT',
    'EMAIL_OPEN',
    'EMAIL_LINK_CLICK',
    'EMAIL_REPLY',
    'EMAIL_BOUNCE',
    'LEAD_UNSUBSCRIBED',
    'LEAD_CATEGORY_UPDATED',
    'CAMPAIGN_STATUS_CHANGED',
    'UNTRACKED_REPLIES',
    'MANUAL_STEP_REACHED',
];

/** Events worth paying a webhook round trip for. Open/click stay off by default. */
export const DEFAULT_WEBHOOK_EVENT_MAP = Object.fromEntries([
    'EMAIL_SENT',
    'FIRST_EMAIL_SENT',
    'EMAIL_REPLY',
    'EMAIL_BOUNCE',
    'LEAD_UNSUBSCRIBED',
    'LEAD_CATEGORY_UPDATED',
].map((event) => [event, true]));

/**
 * Extends HttpError (not a plain Error) on purpose. server.mjs's top-level
 * handler only forwards an HttpError's own message to the response —
 * everything else becomes a bare "Something went wrong on the server.",
 * which is exactly what threw away every one of this class's genuinely
 * useful messages ("Smartlead rejected the API key", a rate limit, a real
 * network failure) at every call site that did not wrap it by hand. Sync and
 * import have several such call sites; this fixes all of them at once
 * instead of wrapping each individually. The RESPONSE status is always 400
 * — Smartlead's own upstream status (kept as `.status` below) is a fact
 * about a request to THEM, not about this request to US, the same
 * distinction lib/apollo.mjs's badRequest(...) calls already draw.
 */
export class SmartleadError extends HttpError {
    constructor(message, { status = 0, rateLimited = false, authFailed = false } = {}) {
        super(400, message, { rateLimited, authFailed });
        this.name = 'SmartleadError';
        this.status = status;
        this.rateLimited = rateLimited;
        this.authFailed = authFailed;
    }
}

function buildUrl(base, path, apiKey, query = {}) {
    const url = new URL(`${base}${path}`);
    if (apiKey) url.searchParams.set('api_key', apiKey);
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
    }
    return url;
}

/**
 * No request here waited on anything — a sync walks up to 30 pages per pass,
 * three passes per campaign, so a single slow or genuinely hung Smartlead
 * response used to mean the whole "Sync all now" / "Import leads" click sat
 * forever with no error and no result: indistinguishable, from the button,
 * from having done nothing at all. 25s is generous for one page of leads and
 * still short enough that a stuck request surfaces as a real, readable error
 * instead of the click looking dead.
 */
const REQUEST_TIMEOUT_MS = 25_000;

async function request(method, path, { apiKey, base, body, query, fetcher } = {}) {
    if (!apiKey) throw new SmartleadError('A Smartlead API key is required.');
    const doFetch = fetcher ?? fetch;
    const url = buildUrl(base ?? DEFAULT_BASE, path, apiKey, query);

    let response;
    const controller = fetcher ? null : new AbortController();
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    try {
        response = await doFetch(url.href, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
            signal: controller?.signal,
        });
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new SmartleadError(`Smartlead did not respond within ${REQUEST_TIMEOUT_MS / 1000}s.`, { status: 0 });
        }
        throw new SmartleadError(`Could not reach Smartlead: ${error?.cause?.code ?? error.message}`);
    } finally {
        if (timer) clearTimeout(timer);
    }

    if (response.status === 429) {
        throw new SmartleadError('Smartlead rate limit reached (429). Slow down and retry.', {
            status: 429, rateLimited: true,
        });
    }
    if (response.status === 401) {
        throw new SmartleadError('Smartlead rejected the API key (401).', { status: 401, authFailed: true });
    }

    const text = await response.text().catch(() => '');
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }

    if (!response.ok) {
        const detail = payload?.message ?? payload?.error ?? text.slice(0, 200);
        throw new SmartleadError(`Smartlead request failed (${response.status}). ${detail}`.trim(), {
            status: response.status,
        });
    }
    return payload;
}

/* --------------------------------------------------------------- campaigns -- */

export async function listCampaigns(options = {}) {
    const payload = await request('GET', '/campaigns/', options);
    // The list endpoint has been seen returning either an array or
    // { campaigns: [...] }; accept both rather than guess which generation.
    return Array.isArray(payload) ? payload : (payload?.campaigns ?? []);
}

export async function getCampaign(campaignId, options = {}) {
    return request('GET', `/campaigns/${campaignId}`, options);
}

/**
 * Leads in one campaign, paged. Returns the raw page:
 * { total_leads, offset, limit, data: [{ campaign_lead_map_id, status, … }] }.
 * `query.eventTimeGt` maps to the API's event_time_gt incremental filter.
 */
export async function getCampaignLeads(campaignId, query = {}, options = {}) {
    return request('GET', `/campaigns/${campaignId}/leads`, {
        ...options,
        query: {
            offset: query.offset ?? 0,
            limit: Math.min(100, Math.max(1, query.limit ?? 100)),
            status: query.status,
            emailStatus: query.emailStatus,
            event_time_gt: query.eventTimeGt,
            last_sent_time_gt: query.lastSentTimeGt,
            created_at_gt: query.createdAtGt,
        },
    });
}

/* ------------------------------------------------------------------- leads -- */

/**
 * Add leads to a campaign. `leadList` is already in Smartlead's shape — the
 * mapping from CRM fields happened upstream. Batches are capped at 100 here so
 * neither generation of the API can refuse the size.
 */
export async function addLeadsToCampaign(campaignId, leadList, settings, options = {}) {
    if (!Array.isArray(leadList) || !leadList.length) throw new SmartleadError('A lead list is required.');
    const batches = [];
    for (let i = 0; i < leadList.length; i += 100) batches.push(leadList.slice(i, i + 100));

    const results = [];
    for (const batch of batches) {
        const payload = await request('POST', `/campaigns/${campaignId}/leads`, {
            ...options,
            body: {
                lead_list: batch,
                // Block lists and unsubscribe lists protect the sending domain;
                // the caller must opt OUT of them explicitly, never in.
                settings: settings ?? {
                    ignore_global_block_list: false,
                    ignore_unsubscribe_list: false,
                    ignore_duplicate_leads_in_other_campaign: false,
                },
            },
        });
        results.push(payload);
        // Sequential on purpose — see the rate-limit note at the top.
    }
    if (results.length === 1) return results[0];
    return {
        added_count: results.reduce((sum, r) => sum + (r?.added_count ?? 0), 0),
        skipped_count: results.reduce((sum, r) => sum + (r?.skipped_count ?? 0), 0),
        skipped_leads: results.flatMap((r) => r?.skipped_leads ?? []),
        _batches: results.length,
    };
}

export async function pauseLead(campaignId, leadId, options = {}) {
    return request('POST', `/campaigns/${campaignId}/leads/${leadId}/pause`, options);
}

export async function resumeLead(campaignId, leadId, options = {}) {
    return request('POST', `/campaigns/${campaignId}/leads/${leadId}/resume`, options);
}

/* ---------------------------------------------------------------- webhooks -- */

/**
 * Register the webhook for one campaign. Association type 3 ("campaign") —
 * user-level webhooks take priority over narrower ones inside Smartlead and
 * would drag every other campaign's traffic to us.
 */
export async function createWebhook({ name, url, emailCampaignId, eventTypeMap }, options = {}) {
    return request('POST', '/webhook/create', {
        ...options,
        body: {
            name,
            webhook_url: url,
            association_type: 3,
            email_campaign_id: emailCampaignId,
            event_type_map: eventTypeMap ?? DEFAULT_WEBHOOK_EVENT_MAP,
        },
    });
}

export async function getWebhook(webhookId, options = {}) {
    return request('GET', `/webhook/${webhookId}`, options);
}

export async function deleteWebhook(webhookId, options = {}) {
    return request('DELETE', `/webhook/delete/${webhookId}`, options);
}

/** Cheap connection test: listing campaigns proves the key without side effects. */
export async function testConnection(options = {}) {
    const campaigns = await listCampaigns({ ...options, query: undefined });
    return { ok: true, campaignCount: campaigns.length };
}
