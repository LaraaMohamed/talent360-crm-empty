/**
 * Email verification — the CRM's own vocabulary, and a way in for any provider.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * The CRM must never learn a provider's vocabulary. BounceBan says
 * "deliverable"; ZeroBounce says "valid"; NeverBounce says "valid" but means
 * something subtly different by "catchall". If those strings reach the
 * database, then swapping provider silently changes what every stored status
 * MEANS, and every filter, campaign gate and dashboard number built on them
 * quietly shifts underneath. Worse, the old rows keep the old provider's words
 * and nothing can tell the two apart.
 *
 * So a provider's answer is translated into one of the statuses below at the
 * edge, ONCE, and the raw payload is kept alongside it for audit. Business
 * logic reads `status`; nothing outside this file reads `raw`.
 *
 * ── ADDING A PROVIDER ───────────────────────────────────────────────────────
 *
 * Add an entry to PROVIDERS with a `verify(email, apiKey, options)` that
 * returns `{ status, confidence, raw }`. Nothing else in the CRM changes:
 * the active provider is a workspace setting, not an import.
 */
import { setting } from './settings.mjs';
import { badRequest } from './http.mjs';
import { verifyEmail as bounceBanVerify, DEFAULT_ENDPOINT } from './bounceban.mjs';

/**
 * The CRM's standardized statuses.
 *
 * Deliberately more than a boolean. "We could not tell" (unknown) and "anything
 * at this domain accepts mail" (accept_all) are genuinely different from both
 * "good" and "bad", and collapsing either into `verified = false` is how a
 * usable address gets thrown away, or an unusable one gets emailed.
 */
export const STATUS = {
    VERIFIED: 'verified',
    DELIVERABLE: 'deliverable',
    ACCEPT_ALL: 'accept_all',
    CATCH_ALL: 'catch_all',
    RISKY: 'risky',
    DISPOSABLE: 'disposable',
    UNKNOWN: 'unknown',
    INVALID: 'invalid',
    DO_NOT_EMAIL: 'do_not_email',
};

export const STATUSES = Object.values(STATUS);

/**
 * What a status means for sending — the only question most callers have.
 *
 *   safe     send, and import without asking
 *   review   a human decides; never sent to automatically
 *   blocked  never send, never import by default
 *
 * `unknown` sits in REVIEW rather than BLOCKED on purpose: a provider timing
 * out is not evidence that an address is bad, and treating it as such throws
 * away good contacts every time the provider has a slow day.
 */
export const SAFE = new Set([STATUS.VERIFIED, STATUS.DELIVERABLE]);
export const REVIEW = new Set([STATUS.ACCEPT_ALL, STATUS.CATCH_ALL, STATUS.RISKY, STATUS.UNKNOWN]);
export const BLOCKED = new Set([STATUS.INVALID, STATUS.DISPOSABLE, STATUS.DO_NOT_EMAIL]);

export function classify(status) {
    if (SAFE.has(status)) return 'safe';
    if (BLOCKED.has(status)) return 'blocked';
    return 'review';
}

/** Human labels, so the UI never invents its own wording for a status. */
export const STATUS_LABEL = {
    [STATUS.VERIFIED]: 'Verified',
    [STATUS.DELIVERABLE]: 'Deliverable',
    [STATUS.ACCEPT_ALL]: 'Accept-all',
    [STATUS.CATCH_ALL]: 'Catch-all',
    [STATUS.RISKY]: 'Risky',
    [STATUS.DISPOSABLE]: 'Disposable',
    [STATUS.UNKNOWN]: 'Unknown',
    [STATUS.INVALID]: 'Invalid',
    [STATUS.DO_NOT_EMAIL]: 'Do not email',
};

/**
 * What each status MEANS, in one sentence.
 *
 * This exists because a status and a tick-box disagreeing looks like a bug. A
 * check that comes back `accept_all` is a real answer — the provider succeeded —
 * and it still leaves "Safe to send" false, which reads as "the check failed"
 * unless something says why. These sentences are that something, and they live
 * here so the record page, the toast and the history all say the same thing.
 */
export const STATUS_HELP = {
    [STATUS.VERIFIED]: 'The mailbox was confirmed to exist. Safe to send.',
    [STATUS.DELIVERABLE]: 'The mail server accepted this specific address. Safe to send.',
    [STATUS.ACCEPT_ALL]: 'The domain accepts mail for every address, so the check could not prove this '
        + 'mailbox exists. The answer is real — it is just not proof, so it is not treated as safe to send.',
    [STATUS.CATCH_ALL]: 'The domain accepts mail for every address, so the check could not prove this '
        + 'mailbox exists. The answer is real — it is just not proof, so it is not treated as safe to send.',
    [STATUS.RISKY]: 'Deliverable but a poor send — a role address (support@, sales@) or a low-quality '
        + 'mailbox. A human decides.',
    [STATUS.DISPOSABLE]: 'A throwaway address. Never send.',
    [STATUS.UNKNOWN]: 'The check could not reach an answer. That is not evidence the address is bad — '
        + 're-verify before writing it off.',
    [STATUS.INVALID]: 'The mail server refused this address. Never send.',
    [STATUS.DO_NOT_EMAIL]: 'Suppressed by policy. Never send.',
};

/** Everything the UI needs to describe a status, without inventing wording. */
export function describe(status) {
    return {
        status,
        label: STATUS_LABEL[status] ?? status,
        classification: classify(status),
        help: STATUS_HELP[status] ?? null,
    };
}

/** The whole vocabulary, for `/api/meta`. */
export const STATUS_META = STATUSES.map(describe);

/* ------------------------------------------------------------- providers -- */

/**
 * BounceBan's answer, translated.
 *
 * Written defensively because the payload shape is not guaranteed: the flags
 * are checked before the free-text verdict, since "deliverable + catch_all" is
 * a catch-all first and a deliverable second — emailing it on the strength of
 * the word "deliverable" is exactly the bounce this module exists to prevent.
 */
export function mapBounceBan(payload) {
    const raw = payload ?? {};

    /**
     * `result` is the verdict. `status` is the REQUEST state — its values are
     * `success`, `verifying` and `queue`, none of which say anything about the
     * address. Reading `status` here (as this function first did) mapped every
     * successful check to UNKNOWN, because "success" matches no outcome.
     */
    const verdict = String(raw.result ?? '').toLowerCase();
    const flag = (...names) => names.some((n) => raw[n] === true || raw[n] === 'true' || raw[n] === 1);

    // Order matters, strongest disqualifier first.
    if (flag('is_disposable', 'disposable')) return STATUS.DISPOSABLE;
    if (/undeliverable|invalid|bounce/.test(verdict)) return STATUS.INVALID;
    // Accept-all outranks "deliverable": on a domain that accepts everything,
    // "deliverable" only means the server did not refuse — which is not
    // evidence the mailbox exists.
    if (flag('is_accept_all', 'accept_all', 'is_catch_all', 'catch_all')) return STATUS.ACCEPT_ALL;
    // A role address (support@, sales@) is deliverable and still a bad send.
    if (flag('is_role')) return STATUS.RISKY;
    if (/risky|risk/.test(verdict)) return STATUS.RISKY;
    if (/deliverable|valid|ok/.test(verdict)) return STATUS.DELIVERABLE;
    if (/unknown/.test(verdict)) return STATUS.UNKNOWN;

    return STATUS.UNKNOWN;
}

function confidenceOf(payload) {
    const raw = payload ?? {};
    const value = raw.score ?? raw.confidence ?? raw.quality_score;
    if (value === undefined || value === null) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    // BounceBan returns -1 when no score is available. Storing that as a
    // confidence of -1 (or clamping it to 0) would read as "we are certain
    // this is terrible" rather than "we have no figure".
    if (n < 0) return null;
    // Providers disagree about 0-1 versus 0-100. Stored as 0-1.
    return n > 1 ? Math.min(1, n / 100) : Math.max(0, n);
}

export const PROVIDERS = {
    bounceban: {
        key: 'bounceban',
        label: 'BounceBan',
        settingKey: 'bounceban_api_key',
        endpointSetting: 'bounceban_api_url',
        defaultEndpoint: DEFAULT_ENDPOINT,
        async verify(email, apiKey, options = {}) {
            const result = await bounceBanVerify(email, apiKey, options);
            return {
                status: mapBounceBan(result.payload),
                confidence: confidenceOf(result.payload),
                raw: result.payload,
            };
        },
    },
};

/* ---------------------------------------------------------------- service -- */

/** The provider this workspace is configured to use. */
export function activeProvider(workspaceId) {
    const key = setting(workspaceId, 'verification_provider') || 'bounceban';
    const provider = PROVIDERS[key];
    if (!provider) throw badRequest(`Unknown verification provider "${key}". Configure one of: ${Object.keys(PROVIDERS).join(', ')}.`);
    return provider;
}

export function isConfigured(workspaceId) {
    try {
        const provider = activeProvider(workspaceId);
        return Boolean(setting(workspaceId, provider.settingKey));
    } catch {
        return false;
    }
}

/**
 * Verify one address.
 *
 * Returns a standardized result and NEVER throws for a bad address — an
 * unverifiable email is a finding, not an error. It still throws when the
 * workspace is misconfigured, because that is not a fact about the address and
 * silently recording 500 contacts as `unknown` would hide it.
 */
export async function verifyAddress(email, ctx, options = {}) {
    const address = String(email ?? '').trim();
    const provider = activeProvider(ctx.workspaceId);
    const apiKey = setting(ctx.workspaceId, provider.settingKey);
    if (!apiKey) {
        throw badRequest(`${provider.label} is not configured. Add its API key in Settings before verifying.`);
    }

    if (!address || !address.includes('@')) {
        return {
            email: address, status: STATUS.INVALID, confidence: null,
            provider: provider.key, providerLabel: provider.label,
            checkedAt: new Date().toISOString(), raw: { reason: 'no address on the record' },
        };
    }

    const endpoint = setting(ctx.workspaceId, provider.endpointSetting) || provider.defaultEndpoint;

    try {
        const result = await provider.verify(address, apiKey, { ...options, apiUrl: endpoint });
        return {
            email: address,
            status: result.status,
            confidence: result.confidence ?? null,
            provider: provider.key,
            providerLabel: provider.label,
            checkedAt: new Date().toISOString(),
            raw: result.raw,
        };
    } catch (err) {
        // The provider failed, which says nothing about the address. Recorded
        // as UNKNOWN with the reason kept, rather than as INVALID — marking a
        // good address invalid because of an outage is unrecoverable without
        // a re-run nobody knows to do.
        return {
            email: address,
            status: STATUS.UNKNOWN,
            confidence: null,
            provider: provider.key,
            providerLabel: provider.label,
            checkedAt: new Date().toISOString(),
            error: err.message,
            raw: { error: err.message },
        };
    }
}
