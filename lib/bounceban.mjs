/**
 * BounceBan transport. Nothing here interprets a result — that is
 * `lib/verification.mjs`'s job. This file's only responsibility is to make the
 * call correctly and hand back the raw payload.
 *
 * ── THE CONTRACT (verified against BounceBan's own API reference) ───────────
 *
 *   GET https://api-waterfall.bounceban.com/v1/verify/single?email=…
 *   Authorization: <api key>        ← NO "Bearer " prefix. Sending one 404s.
 *
 * Two endpoints exist and the choice matters:
 *
 *   api-waterfall   holds the connection until the answer is ready (30-300s),
 *                   and a retry for the same address within 30 minutes costs
 *                   no extra credit.
 *   api             returns after 15s with `status: "verifying"` if it has not
 *                   finished — and charges a full credit anyway, so polling it
 *                   bills you repeatedly for one answer.
 *
 * Waterfall is the default for exactly that reason: the alternative is paying
 * several times to learn one thing.
 */
import { badRequest } from './http.mjs';

export const DEFAULT_ENDPOINT = 'https://api-waterfall.bounceban.com/v1/verify/single';

/** Request status, which is NOT the verification outcome. */
export const REQUEST_PENDING = new Set(['verifying', 'queue']);

export async function verifyEmail(email, apiKey, options = {}) {
    if (!email || typeof email !== 'string' || !email.includes('@')) {
        throw badRequest('A valid email address is required to verify.');
    }
    if (!apiKey) throw badRequest('BounceBan API key is not configured.');

    const url = new URL(options.apiUrl || DEFAULT_ENDPOINT);
    url.searchParams.set('email', email);
    if (options.mode) url.searchParams.set('mode', options.mode);

    // `disable_catchall_verify` takes 0/1, not a boolean word. Catch-all
    // verification is left ON: knowing a domain accepts everything is the
    // difference between "deliverable" and "we cannot tell", and turning it
    // off makes accept-all domains masquerade as good addresses.
    url.searchParams.set('disable_catchall_verify', options.disableCatchall ? '1' : '0');

    // Only the waterfall endpoint honours a timeout, and it must sit in 30-300.
    if (url.hostname.startsWith('api-waterfall')) {
        const seconds = Number(options.timeout) || 45;
        url.searchParams.set('timeout', String(Math.min(300, Math.max(30, seconds))));
    }

    const fetcher = options.fetcher ?? fetch;
    const response = await fetcher(url.href, {
        method: 'GET',
        headers: {
            Accept: 'application/json',
            // Bare key. BounceBan does not use the Bearer scheme.
            Authorization: apiKey,
        },
    });

    if (response.status === 408) {
        throw badRequest('BounceBan timed out before reaching a verdict. Retrying the same address within 30 minutes costs no extra credit.');
    }
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw badRequest(`BounceBan verification failed with status ${response.status}. ${text}`.trim());
    }

    const payload = await response.json();

    // A pending request is not an answer. Surfacing it as one would record
    // "unknown" against an address BounceBan is still working on.
    if (REQUEST_PENDING.has(String(payload?.status ?? '').toLowerCase())) {
        throw badRequest(`BounceBan is still verifying this address (${payload.status}). Try again shortly — a repeat within 30 minutes is free.`);
    }

    return { payload };
}
