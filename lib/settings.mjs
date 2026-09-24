/** Small workspace key/value configuration, with defaults in one place. */
import { all, get, run, now, json } from './db.mjs';

export const DEFAULTS = {
    /**
     * Which audit actions are projected into the human timeline.
     *
     * This is the whole answer to "every action creates an activity". Every
     * action DOES create an audit event; only these few reach the timeline.
     * Without the filter you get a timeline nobody reads, drowned in
     * `custom_field_47: null -> ""`, and the rep stops looking at the one
     * screen the product most needs them to look at.
     */
    timeline_projections: [
        'lifecycle_changed',
        'stage_changed',
        'verdict_computed',
        'owner_changed',
        'deal_won',
        'deal_lost',
        'proposal_issued',
        'agreement_signed',
    ],
    /** Verdict age, in days, past which a verdict is shown with reduced emphasis. */
    verdict_stale_days: 180,
    /**
     * Email verification.
     *
     * The provider is configuration, not an import: `lib/verification.mjs`
     * translates whichever one is active into the CRM's own statuses, so
     * switching supplier is a settings change rather than a code change.
     */
    verification_provider: 'bounceban',
    bounceban_api_key: null,
    bounceban_api_url: null,
    /**
     * Which verification outcomes may be ENROLLED IN A CAMPAIGN.
     *
     *   safe    verified and deliverable only
     *   review  also allows accept-all, catch-all, risky, unknown, and
     *           never-checked addresses
     *   all     anything with an address
     *
     * Blocked outcomes — invalid, disposable, do-not-email — are refused under
     * every setting including `all`. One hard bounce costs more sending
     * reputation than any single contact is worth.
     *
     * ── WHY THIS GATES CAMPAIGNS AND NOT IMPORT ─────────────────────────────
     *
     * Deliverability is a CHANNEL problem, not a record problem. A contact
     * whose email bounces is still a real person with a phone number, a title
     * and a LinkedIn profile — refusing to import them to avoid a bounce
     * throws away the relationship to solve a problem that only exists when
     * you send mail.
     *
     * So import is lossless: every row that is mapped is created, and nothing
     * is dropped for an unverified address. The check happens at the point
     * where a bad address actually costs something — enrolling someone in a
     * campaign.
     */
    campaign_email_policy: 'review',

    /**
     * How many days before an agreement's expiry the renewal decision is due.
     *
     * The one number `lib/renewals.mjs` and the agreement form both read —
     * centralised so "45" is typed once rather than hardcoded at every call
     * site that needs a notice window. An agreement's own `notice_days`
     * still wins when it is set explicitly; this is only the value new
     * agreements (and the import) open with.
     */
    default_renewal_notice_days: 45,

    /**
     * Who the two automated agreement-signed emails go to.
     *
     * Arrays of plain email addresses, not user references — Finance often
     * is not a CRM login at all, and an internal distribution list is not a
     * person `owner_id` could ever point at. `null` (the default) means
     * "nobody configured yet": lib/email-automation.mjs still raises the
     * draft when an agreement is signed — the record and the Activity exist
     * either way — it is only left unaddressed until an admin sets these.
     */
    finance_notification_recipients: null,
    internal_team_notification_recipients: null,

    /**
     * SMTP delivery for the business email system (lib/email-delivery.mjs).
     *
     * One relay, workspace-wide — this is low-volume business mail (a
     * handful of proposals and agreements a day, not a marketing platform),
     * so one configured account is the right shape, the same way BounceBan
     * and Smartlead are each configured once per workspace. `smtp_password`
     * is listed in api/meta.mjs's SECRET_SETTINGS and never reaches the
     * browser once set.
     */
    smtp_host: null,
    smtp_port: 587,
    smtp_secure: 'starttls', // 'tls' (port 465) | 'starttls' (port 587) | 'none'
    smtp_username: null,
    smtp_password: null,
    smtp_from_email: null,
    smtp_from_name: null,

    /**
     * Document generation defaults, carried over verbatim from the Apps Script's
     * Settings sheet (`SetupService.gs` seedDefaultSettings_).
     *
     * These are the values the wizard OPENS with, not values it imposes: every
     * one of them is an editable field on the generation form, and whatever the
     * user confirms is what prints. They exist so that the four or five numbers
     * that are the same on almost every document are typed once, in Settings,
     * rather than on every proposal.
     *
     * `doc_default_currency` is deliberately null rather than the automation's
     * 'EGP'. The CRM already knows a currency — the deal's, or the workspace's
     * base — and prefers it; this setting is the override for a workspace that
     * quotes in something else. The Arabic currency WORD has no such source, so
     * it keeps the automation's value.
     */
    doc_default_currency: null,
    doc_default_currency_ar: 'جنيه',
    /**
     * Management reporting rates, expressed as UNITS PER USD.
     *
     * The dashboard reports in USD; clients pay in USD, EGP or SAR. These are
     * the rates that translate the second into the first, and they are
     * deliberately a handful of numbers an admin types — not a feed.
     *
     * ── WHAT THESE ARE NOT ──────────────────────────────────────────────────
     *
     * Not settlement rates, not accounting rates, and not history. There is no
     * daily synchronisation, no revaluation, and no stored converted value on
     * any deal. Changing one of these changes what the DASHBOARD says and
     * nothing else: the deal, the proposal and the agreement keep the amount
     * and currency the client agreed to, because those are the source of truth
     * and a reporting rate has no business rewriting them.
     *
     * Stored per workspace like every other setting, so they are editable
     * without a deploy.
     */
    reporting_currency: 'USD',
    fx_egp_per_usd: 50,
    fx_sar_per_usd: 3.75,
    doc_default_onsite_visits: 2,
    doc_default_validity_days: 10,
    /**
     * The offshoring talent fee, per employee per month.
     *
     * It was a literal 65 in the template, highlighted yellow — the convention
     * for "someone edits this by hand before sending". That is a value the form
     * should ask for, so it is a field with this as its opening value.
     */
    doc_default_talent_fee: 65,
    doc_default_contract_duration_text: 'سنة ميلادية واحدة',
    /** Term length used to offer an end date. `computeContractEndDate` applies it. */
    doc_default_contract_years: 1,
    /** The timezone every generated date is stamped in. The automation's CONFIG.TIMEZONE. */
    doc_timezone: 'Africa/Cairo',
    /**
     * What "the end of the day" means for a WhatsApp follow-up, in the
     * workspace's own timezone. A business that works later moves this
     * rather than waiting for a deploy. See lib/follow-up.mjs.
     */
    follow_up_day_end_hour: 17,
    /**
     * And what "on that day" means for a follow-up CALL. A rep picks a date,
     * not a time; this is the hour that date becomes. See lib/follow-up.mjs.
     */
    follow_up_day_start_hour: 9,
    /**
     * How many unanswered calls IN A ROW retire a lead.
     *
     * Three, as the calling floor works it: ring, ring, ring, and a number that
     * has not picked up three times running is not a lead, it is a queue slot
     * somebody keeps paying for. A setting rather than a constant because it is a
     * judgement about how hard to chase — a floor calling mobiles gives up sooner
     * than one calling switchboards — and a workspace that wants five attempts
     * should not need a deploy to get them.
     *
     * The streak is CONSECUTIVE: any other outcome — a conversation, a follow-up,
     * a profile sent — resets it to zero, because somebody who answers on the
     * fourth attempt is a live lead whatever the first three did. See `logCall`
     * in lib/calling.mjs.
     */
    calling_attempts_before_dead: 3,

    /**
     * Outreach (email sequencing) integration.
     *
     * The provider transport lives in lib/smartlead.mjs and the neutral
     * vocabulary in lib/outreach.mjs; these keys are only configuration, and
     * they follow the BounceBan precedent exactly: the API key and webhook
     * secret are credentials — writable by an admin, readable by nobody — so
     * api/meta.mjs lists them in SECRET_SETTINGS and the frontend learns only
     * `secretsConfigured`.
     *
     * `smartlead_field_mapping` is the saved CRM→Smartlead field template used
     * by the enrolment wizard. `smartlead_last_sync_at` throttles the
     * reconciliation sweep. `smartlead_webhooks` maps a linked CRM campaign id
     * to the Smartlead webhook row created for it, so reconnecting replaces
     * rather than duplicates.
     */
    smartlead_api_key: null,
    smartlead_webhook_secret: null,
    smartlead_field_mapping: null,
    smartlead_last_sync_at: null,
    smartlead_webhooks: {},
    /**
     * Which outreach events reach the human TIMELINE as activities.
     *
     * Opens are excluded on purpose: a tracking pixel loading is evidence that
     * a pixel loaded somewhere, not that a person read anything — Apple's
     * privacy proxy alone loads pixels pre-emptively, so opens would fill the
     * timeline with confident nonsense. They still update counters and
     * last_event_at on the membership; they just don't get an activity.
     */
    smartlead_timeline_events: ['enrolled', 'sent', 'reply', 'bounce', 'unsubscribe', 'category', 'manual_step'],

    /**
     * People discovery for sourcing — provider-neutral, mirroring verification.
     *
     * The CRM never learns a provider's vocabulary. lib/people-search.mjs maps
     * whichever provider is active into the CRM's own person shape, so adding
     * a second provider (PDL, etc.) is a registry entry + transport, not a
     * rewrite. Credentials stay write-only via api/meta.SECRET_SETTINGS, like
     * BounceBan and Smartlead.
     *
     * `people_search_provider` selects the active discovery vendor; future
     * providers add their `*_api_key` here and a registry entry in
     * lib/people-search.mjs:`PROVIDERS`.
     */
    people_search_provider: 'apollo',
    apollo_api_key: null,
    apollo_api_url: null,
};

/**
 * The workspace's settings, read as ONE row set rather than one row per key.
 *
 * `setting()` was a single-row SELECT, and the callers ask for a lot of keys:
 * `/api/meta` alone made eighteen, and every money widget asks for the exchange
 * rates. Each one is a blocking round trip in production.
 *
 * Written from exactly one place, which invalidates. Per process, like the
 * field definitions cache in objects.mjs, and for the same reasons.
 */
const settingsCache = new Map();

export function invalidateSettings(workspaceId) {
    if (!workspaceId) settingsCache.clear();
    else settingsCache.delete(workspaceId);
}

function rowsFor(workspaceId) {
    if (settingsCache.has(workspaceId)) return settingsCache.get(workspaceId);
    const rows = {};
    for (const row of all('SELECT key, value FROM settings WHERE workspace_id = ?', [workspaceId])) {
        rows[row.key] = row.value;
    }
    settingsCache.set(workspaceId, rows);
    return rows;
}

export function setting(workspaceId, key) {
    const raw = rowsFor(workspaceId)[key];
    if (raw === undefined) return DEFAULTS[key];
    return json(raw, DEFAULTS[key]);
}

export function setSetting(workspaceId, key, value) {
    run(
        `INSERT INTO settings (workspace_id, key, value, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [workspaceId, key, JSON.stringify(value), now()],
    );
    // The cache above is only correct while every write goes through here.
    invalidateSettings(workspaceId);
    return value;
}

export function allSettings(workspaceId) {
    const out = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) out[key] = setting(workspaceId, key);
    return out;
}
