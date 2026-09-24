/**
 * The one place `{{variable}}` gets a value, for every business email this
 * product sends.
 *
 * ── WHY ONE RESOLVER ─────────────────────────────────────────────────────────
 *
 * Four workflows (proposal to client, agreement to client, signed-to-finance,
 * signed-to-internal) each need a slightly different SUBSET of the same
 * facts — a contact's name, a company's website, a service's label, a
 * contract's dates. Building that per workflow is how `{{company_name}}`
 * quietly means something different, or resolves through a different code
 * path with a different bug, in two templates that both claim to support it.
 * This file is the only place that reads a contact/account/deal/agreement/
 * proposal row and turns it into the flat variable map every template body
 * is rendered against.
 *
 * ── MISSING IS NOT BLANK ─────────────────────────────────────────────────────
 *
 * A variable this record genuinely has no value for — no contact, no
 * currency, no scope text — is never silently rendered as empty. `resolve()`
 * returns which keys resolved and which did not; `render()` prints
 * `[MISSING: key]` for the ones that did not. A blank line in a client email
 * is a mistake nobody notices until the client does; `[MISSING: scope]` is a
 * mistake the sender catches in the preview, which is the whole point of
 * building preview before building send.
 */
import { get } from './db.mjs';
import { serviceLine, dealPrice } from './repo.mjs';
import { json } from './db.mjs';

/** Every variable this resolver knows how to produce, grouped as the request specifies. */
export const VARIABLE_GROUPS = {
    Contact: ['contact_name', 'contact_first_name', 'contact_last_name', 'contact_email', 'contact_phone', 'contact_job_title'],
    Account: ['company_name', 'website', 'industry', 'account_type'],
    Deal: ['deal_name', 'deal_size', 'currency', 'service', 'scope', 'duration', 'deal_stage'],
    Agreement: ['agreement_number', 'agreement_start_date', 'agreement_end_date', 'agreement_status'],
    Proposal: ['proposal_number', 'proposal_name', 'proposal_value'],
    Sender: ['sender_name', 'sender_email', 'sender_title'],
    Documents: ['proposal_document', 'agreement_document', 'internal_team_proposal'],
};
export const ALL_VARIABLES = Object.values(VARIABLE_GROUPS).flat();

const fmtDate = (s) => {
    if (!s) return null;
    const d = new Date(String(s).slice(0, 10));
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
};
const fmtMoney = (amount, currency) => (amount === null || amount === undefined || amount === '' ? null
    : `${Number(amount).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${currency ?? ''}`.trim());

function monthsBetween(startStr, endStr) {
    const start = new Date(String(startStr).slice(0, 10));
    const end = new Date(String(endStr).slice(0, 10));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    const months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
    return months > 0 ? months : null;
}

/**
 * The scope text a signed document actually printed, read back from the
 * generation record rather than re-derived. `SERVICE_SCOPE_LIST` is what the
 * HCM document types populate (lib/document-types.mjs) — the only document
 * family with a real "scope" concept today. Anything else legitimately has
 * no scope text on file, and resolves to missing rather than a guess.
 */
function scopeFromGeneration(sourceType, sourceId) {
    if (!sourceType || !sourceId) return null;
    const table = sourceType === 'proposal' ? 'proposals' : 'agreements';
    const source = get(`SELECT document_id FROM ${table} WHERE id = ?`, [sourceId]);
    if (!source?.document_id) return null;
    const row = get('SELECT fields FROM document_generations WHERE document_id = ? ORDER BY created_at DESC LIMIT 1', [source.document_id]);
    const fields = json(row?.fields, {});
    return fields.SERVICE_SCOPE_LIST || fields.scope || null;
}

/**
 * Resolves every variable this resolver knows, against whichever records are
 * given. Any argument may be `null` — a proposal-to-client email has no
 * agreement yet, a finance email has both.
 *
 * @returns {{ values: Record<string,string>, missing: string[] }}
 */
export function resolveVariables(ctx, { contact = null, account = null, deal = null, agreement = null, proposal = null, senderId = null, documents = null }) {
    const values = {};

    // ---- contact ----
    if (contact) {
        values.contact_name = contact.full_name || [contact.first_name, contact.last_name].filter(Boolean).join(' ') || null;
        values.contact_first_name = contact.first_name || null;
        values.contact_last_name = contact.last_name || null;
        values.contact_email = contact.email || null;
        values.contact_phone = contact.phone || null;
        values.contact_job_title = contact.title || null;
    }

    // ---- account ----
    if (account) {
        values.company_name = account.name || null;
        values.website = account.website || null;
        values.industry = account.industry || null;
        values.account_type = account.account_type || null;
    }

    // ---- deal ----
    const serviceKey = agreement?.service_line_key ?? deal?.service_line_key ?? proposal?.service_line_key ?? null;
    const line = serviceKey ? serviceLine(ctx.workspaceId, serviceKey) : null;
    if (deal) {
        values.deal_name = deal.name || null;
        const price = dealPrice(ctx, deal);
        values.deal_size = fmtMoney(price.price, price.currency);
        values.currency = price.currency || deal.currency || null;
        values.deal_stage = deal.stage_label || null; // hydrated by the caller when available
    }
    values.service = line?.label ?? null;

    // Duration: the agreement's own term wins (it is the contract that was
    // actually signed); a deal's recurring term is the fallback for a
    // proposal that has no agreement yet.
    if (agreement?.effective_date && agreement?.expiry_date) {
        const months = monthsBetween(agreement.effective_date, agreement.expiry_date);
        values.duration = months ? `${months} months` : null;
    } else if (deal) {
        const price = dealPrice(ctx, deal);
        values.duration = price.termMonths ? `${price.termMonths} months` : null;
    }

    // Scope: read back from whichever document was actually generated —
    // agreement first (the signed truth), then the proposal.
    values.scope = scopeFromGeneration('agreement', agreement?.id) ?? scopeFromGeneration('proposal', proposal?.id);

    // ---- agreement ----
    if (agreement) {
        values.agreement_number = agreement.number || null;
        values.agreement_start_date = fmtDate(agreement.effective_date);
        values.agreement_end_date = fmtDate(agreement.expiry_date);
        values.agreement_status = agreement.status || null;
    }

    // ---- proposal ----
    if (proposal) {
        values.proposal_number = proposal.number || null;
        values.proposal_name = proposal.title || null;
        const dealForValue = deal ?? (proposal.deal_id ? get('SELECT * FROM deals WHERE id = ?', [proposal.deal_id]) : null);
        values.proposal_value = dealForValue ? fmtMoney(dealPrice(ctx, dealForValue).price, dealPrice(ctx, dealForValue).currency) : null;
    }

    // ---- sender ----
    const sender = senderId ? get('SELECT * FROM users WHERE id = ?', [senderId]) : null;
    if (sender) {
        values.sender_name = sender.name || null;
        values.sender_email = sender.email || null;
        const membership = get('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?', [ctx.workspaceId, sender.id]);
        values.sender_title = membership ? membership.role.charAt(0).toUpperCase() + membership.role.slice(1) : null;
    }

    // ---- documents (attachment tokens — resolve to a filename for display in body text) ----
    if (documents) {
        values.proposal_document = documents.proposal?.name ?? null;
        values.agreement_document = documents.agreement?.name ?? null;
        values.internal_team_proposal = documents.internalTeamProposal?.name ?? null;
    }

    const missing = ALL_VARIABLES.filter((key) => values[key] === null || values[key] === undefined || values[key] === '');
    return { values, missing };
}

/** `{{key}}` -> its value, or `[MISSING: key]`. Never blank, and never silent. */
export function render(text, values) {
    if (!text) return '';
    return text.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (whole, key) => {
        const value = values[key];
        if (value === null || value === undefined || value === '') return `[MISSING: ${key}]`;
        return String(value);
    });
}

/** Every `{{key}}` a piece of template text references, for the editor's "supported variables" list. */
export function variablesUsedIn(text) {
    if (!text) return [];
    const found = new Set();
    for (const m of text.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)) found.add(m[1]);
    return [...found];
}
