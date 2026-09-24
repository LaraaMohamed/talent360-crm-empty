/**
 * The metadata the whole client renders from.
 *
 * Loaded once from `GET /api/meta`. Nothing in the UI hard-codes a lifecycle
 * stage, an activity type, a pipeline stage or a field list — if it did, it
 * would eventually disagree with the server, and the disagreement would show up
 * as a filter that silently returns nothing.
 */
import { api } from './api.js';
import { humanise } from './core.js';

export const state = {
    meta: null,
    me: null,
    views: [],
    lists: [],
};

export async function loadMeta() {
    state.meta = await api.get('/api/meta');
    state.me = { user: state.meta.user, role: state.meta.role, capabilities: state.meta.capabilities };
    return state.meta;
}

export async function refreshViews() {
    const { views } = await api.get('/api/views');
    state.views = views;
    return views;
}

export async function refreshLists() {
    const { lists } = await api.get('/api/lists');
    state.lists = lists;
    return lists;
}

/**
 * Campaigns, re-read from the server.
 *
 * They ride along in `/api/meta` because they are an option source for the
 * campaign field, and meta is fetched once per session. That made a campaign
 * created five minutes ago invisible to every picker until the page was
 * reloaded — the picker said "no campaigns exist" while the Campaigns page
 * listed the one just made. Anything that offers a campaign calls this first.
 */
export async function refreshCampaigns() {
    const res = await api.get('/api/campaigns?limit=200');
    const records = res.records ?? [];
    if (state.meta) {
        state.meta.campaigns = records.map((c) => ({
            id: c.id, name: c.name, status: c.status, channel: c.channel, service_line_key: c.service_line_key,
            // The Smartlead link: `linkedCampaigns()` (outreach.js) filters on
            // this, and its absence here meant the "Add to Smartlead" wizard
            // found zero linked campaigns no matter how many actually were —
            // every enrollment attempt refused with "link a campaign first"
            // on a workspace that already had.
            external_id: c.external_id,
        }));
        state.meta.campaignsTotal = res.total ?? records.length;
        state.meta.campaignsTruncated = (res.total ?? records.length) > records.length;
    }
    return campaigns();
}

export function object(key) {
    return state.meta?.objects?.[key] ?? null;
}

/**
 * The objects a user may be OFFERED, which is not all of them.
 *
 * Some are registered only so their fields exist — the calling queue is
 * registered so it can be filtered and its columns chosen, but it is not a list
 * you build or a place to hang a custom field. Anything marked `internal` is
 * for the machinery, not for a picker.
 */
export function selectableObjects() {
    return Object.values(state.meta?.objects ?? {}).filter((o) => !o.internal);
}

export function fields(objectKey) {
    return object(objectKey)?.fields ?? [];
}

export function field(objectKey, key) {
    return fields(objectKey).find((f) => f.key === key) ?? null;
}

export function viewsFor(objectKey) {
    return state.views.filter((v) => v.object_key === objectKey);
}

export function listsFor(objectKey) {
    return state.lists.filter((l) => l.object_key === objectKey);
}

export function can(capability) {
    return !!state.me?.capabilities?.[capability];
}

export function users() {
    return state.meta?.users ?? [];
}

export function userName(userId) {
    if (!userId) return '—';
    return users().find((u) => u.id === userId)?.name ?? 'Unknown';
}

export function stages(pipelineId) {
    return (state.meta?.stages ?? []).filter((s) => s.pipeline_id === pipelineId);
}

export function stage(stageId) {
    return (state.meta?.stages ?? []).find((s) => s.id === stageId) ?? null;
}

export function pipelines() {
    return state.meta?.pipelines ?? [];
}

export function activityTypes() {
    return state.meta?.activityTypes ?? [];
}

export function serviceLines() {
    return state.meta?.serviceLines ?? [];
}

export function lossReasons() {
    return state.meta?.lossReasons ?? [];
}

export function rules() {
    return state.meta?.rules ?? [];
}

/**
 * One email-verification status, with its label, classification and what it
 * means for sending.
 *
 * Comes from the server's own vocabulary (lib/verification.mjs) rather than a
 * copy kept here, because a second copy is how the UI ends up calling an
 * accept-all result "verified" long after the rule that decides has moved on.
 */
export function verificationStatus(key) {
    return (state.meta?.verificationStatuses ?? []).find((s) => s.status === key) ?? null;
}

/**
 * What a status means, as a tone the badge can wear.
 *
 * Sent by `/api/meta` from the one registry that defines the statuses in the
 * first place. Null is a real answer: `draft`, `open` and `prospect` are the
 * unremarkable beginning of their workflow, and colouring them would spend the
 * reader's attention on the thing least worth it.
 */
export function toneFor(value) {
    if (value === null || value === undefined || value === '') return null;
    return state.meta?.statusTones?.[String(value)] ?? null;
}

export function campaigns() {
    return state.meta?.campaigns ?? [];
}

export function baseCurrency() {
    return state.meta?.workspace?.baseCurrency ?? 'SAR';
}

/**
 * The currencies anything in this workspace may be priced in.
 *
 * From the server, because the list is exactly the set of currencies the
 * dashboard holds a conversion rate for — a free-text currency box is how a
 * deal silently drops out of a converted total.
 */
export function currencies() {
    return state.meta?.billingCurrencies ?? ['USD', 'EGP', 'SAR'];
}

/**
 * Whether a service is billed monthly.
 *
 * HCM and Offshoring are; Recruitment and OD are not. The answer comes from the
 * service line the server sent, never from a list kept here — a second copy is
 * how a form ends up labelling a placement fee "per month".
 */
export function isRecurringService(key) {
    return serviceLines().find((s) => s.key === key)?.billing_type === 'recurring';
}

/**
 * Option lists that are workspace DATA rather than a fixed list on the field.
 *
 * Keyed by the `optionsSource` the field declares, not by object and field name.
 * The previous version was a chain of `if (objectKey === 'deal' && fieldKey ===
 * 'service_line_key')`, which meant the same field on a second object rendered
 * as an empty dropdown with no error — the exact silent failure the metadata
 * engine exists to prevent.
 */
const OPTION_SOURCES = {
    service_lines: () => serviceLines().map((s) => ({ value: s.key, label: s.label })),
    loss_reasons: () => lossReasons().map((s) => ({ value: s.key, label: s.label })),
    activity_types: () => activityTypes().map((t) => ({ value: t.key, label: t.label })),
    pipelines: () => pipelines().map((p) => ({ value: p.id, label: p.label })),
    stages: () => (state.meta?.stages ?? []).map((s) => ({ value: s.id, label: s.label })),
    rules: () => rules().map((r) => ({ value: r.key, label: r.label })),
    verification_statuses: () => (state.meta?.verificationStatuses ?? [])
        .map((s) => ({ value: s.status, label: s.label })),
    users: () => users().map((u) => ({ value: u.id, label: u.name })),
    campaigns: () => campaigns().map((c) => ({
        value: c.id,
        // The status rides along so a picker can tell a live campaign from one
        // that finished last year without a second lookup.
        label: c.status === 'active' || c.status === 'planned' ? c.name : `${c.name} (${c.status})`,
    })),
};

export function optionsFor(objectKey, fieldKey) {
    const def = field(objectKey, fieldKey);
    if (!def) return [];
    if (def.optionsSource && OPTION_SOURCES[def.optionsSource]) return OPTION_SOURCES[def.optionsSource]();
    if (def.type === 'user') return OPTION_SOURCES.users();
    /**
     * Through `humanise`, not a second copy of the same rule.
     *
     * This had its own title-casing, which is how the agreement type `msa`
     * rendered as "Msa" in a dropdown and on the badge at the top of every
     * contract while `humanise` — the function that knows the business writes
     * MSA, SOW, HCM and OD in capitals — sat unused two files away.
     */
    return (def.options ?? []).map((value) => ({ value, label: humanise(value) }));
}

/** The display label for a stored value, or the raw value if nothing matches. */
export function optionLabel(objectKey, fieldKey, value) {
    if (value === null || value === undefined || value === '') return null;
    const match = optionsFor(objectKey, fieldKey).find((o) => String(o.value) === String(value));
    return match?.label ?? null;
}
