/**
 * EmailDraftService — turns a template plus a real record into an editable
 * email instance, then queues and delivers it. `queueDraft` marks a
 * message `queued`, logs the Activity a person or the automation is meant
 * to cause, and — if a relay is configured (Settings → Email templates) —
 * attempts real SMTP delivery in the same call via
 * lib/email-delivery.mjs's `deliverMessage`, landing the row at `sent` or
 * `failed`. With no relay configured it stays `queued`: recorded and
 * attachment-ready, same as before delivery existed, rather than an error.
 *
 * ── TEMPLATE VS DRAFT ────────────────────────────────────────────────────────
 *
 * `email_templates.subject`/`body` never change here. Every function in this
 * file reads a template, resolves its variables against the record in hand,
 * and writes the RESULT into a new `email_messages` row — editing that row
 * afterward (`updateDraft`) can never touch the template it came from. This
 * is the one property the whole feature depends on: a rep tightening one
 * client's wording must never rewrite what the next proposal email opens
 * with.
 */
import { get, run, id, now, json } from './db.mjs';
import { badRequest, notFound } from './http.mjs';
import { getTemplate, activeTemplateFor } from './email-templates.mjs';
import { resolveVariables, render } from './email-variables.mjs';
import {
    attachmentsForProposalEmail, attachmentsForAgreementEmail,
    attachmentsForFinanceEmail, attachmentsForInternalTeamEmail,
} from './email-attachments.mjs';
import { setting } from './settings.mjs';

const ATTACHMENT_RESOLVERS = {
    proposal_client: (ctx, r) => attachmentsForProposalEmail(ctx, r.proposal),
    agreement_client: (ctx, r) => attachmentsForAgreementEmail(ctx, r.agreement),
    agreement_signed_finance: (ctx, r) => attachmentsForFinanceEmail(ctx, r.agreement),
    agreement_signed_internal: (ctx, r) => attachmentsForInternalTeamEmail(ctx, r.agreement),
};

/** The client contact this email is FOR — the deal's primary contact, or its first, or the account's earliest. */
export function resolvePrimaryContact(ctx, { dealId = null, accountId = null }) {
    if (dealId) {
        const primary = get(
            `SELECT c.* FROM deal_contacts dc JOIN contacts c ON c.id = dc.contact_id
              WHERE dc.deal_id = ? AND dc.role = 'primary' AND c.deleted_at IS NULL LIMIT 1`,
            [dealId],
        );
        if (primary) return primary;
        const any = get(
            `SELECT c.* FROM deal_contacts dc JOIN contacts c ON c.id = dc.contact_id
              WHERE dc.deal_id = ? AND c.deleted_at IS NULL LIMIT 1`,
            [dealId],
        );
        if (any) return any;
    }
    if (accountId) {
        return get(
            'SELECT * FROM contacts WHERE account_id = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1',
            [accountId],
        );
    }
    return null;
}

/** Loads the records category needs, from whichever id was given. Missing ids resolve to null, not an error. */
function loadRecords(ctx, { dealId, agreementId, proposalId, contactId }) {
    let agreement = agreementId ? get('SELECT * FROM agreements WHERE id = ? AND workspace_id = ?', [agreementId, ctx.workspaceId]) : null;
    let proposal = proposalId ? get('SELECT * FROM proposals WHERE id = ? AND workspace_id = ?', [proposalId, ctx.workspaceId]) : null;
    /**
     * Previewing "Agreement Signed → Finance/Internal Team" from Settings
     * only ever offers a DEAL to search by — there is no agreement picker —
     * so without this, `agreement` stayed null for every preview of those
     * two categories and their attachment resolvers (which read `records.
     * agreement`, not `records.deal`) always reported the document missing,
     * however real it was. The real automated path never hits this: it
     * always calls with an explicit `agreementId` already (see
     * `raiseAutomatedEmail`, lib/email-automation.mjs), so this only ever
     * fires for a preview that gave a deal and nothing more.
     */
    if (!agreement && !agreementId && dealId) {
        agreement = get(
            `SELECT * FROM agreements WHERE workspace_id = ? AND deal_id = ? AND deleted_at IS NULL
              ORDER BY (status = 'signed') DESC, created_at DESC LIMIT 1`,
            [ctx.workspaceId, dealId],
        );
    }
    if (!proposal && !proposalId && dealId) {
        proposal = get(
            `SELECT * FROM proposals WHERE workspace_id = ? AND deal_id = ? AND deleted_at IS NULL AND type <> 'internal_team'
              ORDER BY (status = 'issued') DESC, created_at DESC LIMIT 1`,
            [ctx.workspaceId, dealId],
        );
    }
    const resolvedDealId = dealId ?? agreement?.deal_id ?? proposal?.deal_id ?? null;
    const dealRow = resolvedDealId ? get('SELECT * FROM deals WHERE id = ? AND workspace_id = ?', [resolvedDealId, ctx.workspaceId]) : null;
    // `{{deal_stage}}` (lib/email-variables.mjs) reads `deal.stage_label`,
    // which only `hydrate()` (lib/repo.mjs) ever sets — never a column on
    // the `deals` table itself. Read as a plain row above (not `getRecord`,
    // which throws on a deleted/missing deal — this function's own contract
    // is "missing ids resolve to null, not an error"), so the label is
    // joined in by hand instead of switching read paths.
    const deal = dealRow
        ? { ...dealRow, stage_label: get('SELECT label FROM stages WHERE id = ?', [dealRow.stage_id])?.label ?? null }
        : null;
    const accountId = deal?.account_id ?? agreement?.account_id ?? proposal?.account_id ?? null;
    const account = accountId ? get('SELECT * FROM accounts WHERE id = ? AND workspace_id = ?', [accountId, ctx.workspaceId]) : null;
    const contact = contactId
        ? get('SELECT * FROM contacts WHERE id = ? AND workspace_id = ?', [contactId, ctx.workspaceId])
        : resolvePrimaryContact(ctx, { dealId: resolvedDealId, accountId });
    return { agreement, proposal, deal, account, contact };
}

function attachedDocuments(ctx, category, records) {
    const resolver = ATTACHMENT_RESOLVERS[category];
    return resolver ? resolver(ctx, records) : { documents: [], missing: [] };
}

/**
 * Resolves a template against real records WITHOUT writing anything — the
 * preview the template editor and the send dialog both use. `[MISSING: x]`
 * appears in the returned subject/body exactly as it would in a real draft.
 */
export function previewTemplate(ctx, { templateId, category = null, dealId = null, agreementId = null, proposalId = null, contactId = null }) {
    const template = templateId ? getTemplate(ctx, templateId) : activeTemplateFor(ctx, category);
    if (!template) throw notFound(`No template is available for this category yet.`);

    // The client's own contact is still resolved for Finance/Internal Team
    // categories — their templates print "Contact: {{contact_name}}" for
    // reference — it is only never used as the email's RECIPIENT for those
    // two (see buildDraft): the recipient there is whoever Settings has
    // configured, not the client.
    const records = loadRecords(ctx, { dealId, agreementId, proposalId, contactId });
    const attachments = attachedDocuments(ctx, template.category, records);
    // The `{{proposal_document}}` / `{{agreement_document}}` / `{{internal_team_proposal}}`
    // tokens each name a SPECIFIC document by category — one attachment
    // resolver runs per category, so its result is already the right one;
    // no need to sniff a generic `kind` column to tell them apart.
    const documentTokens = {
        proposal: template.category === 'proposal_client' ? attachments.documents[0] : null,
        agreement: template.category === 'agreement_client' ? attachments.documents[0] : null,
        // Finance gets two documents (agreement, proposal) in a fixed order — see attachmentsForFinanceEmail.
        internalTeamProposal: template.category === 'agreement_signed_internal' ? attachments.documents[0] : null,
    };
    const { values, missing } = resolveVariables(ctx, {
        contact: records.contact, account: records.account, deal: records.deal,
        agreement: records.agreement, proposal: records.proposal, senderId: ctx.userId,
        documents: documentTokens,
    });

    return {
        template,
        subject: render(template.subject, values),
        body: render(template.body, values),
        recipient: records.contact ? { name: values.contact_name, email: values.contact_email, contactId: records.contact.id } : null,
        attachments: attachments.documents.map((d) => ({ id: d.id, name: d.name })),
        missingAttachments: attachments.missing,
        missingVariables: missing,
        records: {
            accountId: records.account?.id ?? null, dealId: records.deal?.id ?? null,
            proposalId: records.proposal?.id ?? null, agreementId: records.agreement?.id ?? null,
        },
    };
}

/**
 * Builds and PERSISTS a draft — the editable instance a user reviews before
 * sending, or automation raises directly at `queued` for a system
 * notification nobody composes by hand.
 */
export function buildDraft(ctx, {
    category, templateId = null, dealId = null, agreementId = null, proposalId = null, contactId = null,
    source = 'ui', triggerEventKey = null, ccSetting = null, initialStatus = 'draft',
}) {
    const preview = previewTemplate(ctx, { templateId, category, dealId, agreementId, proposalId, contactId });
    const recipients = ccSetting ? (setting(ctx.workspaceId, ccSetting) ?? []) : [];
    // Finance/Internal Team notifications have no client contact to address
    // — the recipient IS the configured list, not the deal's contact (which
    // is still resolved above only so {{contact_name}}/{{contact_email}}
    // can print inside the body). A client-facing category keeps its
    // resolved contact as the recipient and has no configured cc.
    const isInternalCategory = !!ccSetting;
    const recipientEmail = isInternalCategory ? null : (preview.recipient?.email ?? null);
    const recipientName = isInternalCategory ? null : (preview.recipient?.name ?? null);
    const recipientContactId = isInternalCategory ? null : (preview.recipient?.contactId ?? null);
    const cc = isInternalCategory ? recipients : [];

    const stamp = now();
    const messageId = id('eml');
    run(
        `INSERT INTO email_messages
           (id, workspace_id, template_id, category, status, subject, body,
            recipient_email, recipient_name, recipient_contact_id, cc_emails,
            account_id, deal_id, proposal_id, agreement_id,
            attachment_document_ids, missing_variables, source, trigger_event_key,
            created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
            messageId, ctx.workspaceId, preview.template.id, preview.template.category, initialStatus,
            preview.subject, preview.body,
            recipientEmail, recipientName, recipientContactId,
            JSON.stringify(cc),
            preview.records.accountId, preview.records.dealId, preview.records.proposalId, preview.records.agreementId,
            JSON.stringify(preview.attachments.map((a) => a.id)),
            JSON.stringify(preview.missingVariables),
            source, triggerEventKey,
            ctx.userId ?? null, stamp, stamp,
        ],
    );
    return getDraft(ctx, messageId);
}

export function getDraft(ctx, draftId) {
    const m = get('SELECT * FROM email_messages WHERE id = ? AND workspace_id = ?', [draftId, ctx.workspaceId]);
    if (!m) throw notFound('That email does not exist.');
    return { ...m, cc_emails: json(m.cc_emails, []), attachment_document_ids: json(m.attachment_document_ids, []), missing_variables: json(m.missing_variables, []) };
}

/** Edits the INSTANCE only — the template it was built from is untouched. */
export function updateDraft(ctx, draftId, { subject, body, recipientEmail, ccEmails }) {
    const existing = getDraft(ctx, draftId);
    if (existing.status !== 'draft') throw badRequest('Only a draft can still be edited — this email has already been queued or sent.');
    const next = {};
    if (subject !== undefined) next.subject = subject;
    if (body !== undefined) next.body = body;
    // A one-off override — the client gave a different address today, or
    // this send needs a colleague copied in. Never touches the contact
    // record or the workspace's cc setting; it only changes where THIS
    // message goes.
    if (recipientEmail !== undefined) {
        const trimmed = String(recipientEmail ?? '').trim();
        if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
            throw badRequest('That does not look like an email address.');
        }
        next.recipient_email = trimmed || null;
    }
    if (ccEmails !== undefined) {
        const list = (Array.isArray(ccEmails) ? ccEmails : String(ccEmails ?? '').split(/[,\n]/))
            .map((s) => String(s).trim()).filter(Boolean);
        const bad = list.find((addr) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr));
        if (bad) throw badRequest(`"${bad}" does not look like an email address.`);
        next.cc_emails = JSON.stringify(list);
    }
    if (!Object.keys(next).length) return existing;
    next.updated_at = now();
    run(`UPDATE email_messages SET ${Object.keys(next).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(next), draftId]);
    return getDraft(ctx, draftId);
}

/**
 * "Send." Delivery is not connected yet (see the schema comment), so this
 * moves the draft to `queued` and logs it as an Activity — the same
 * observable fact the rest of the CRM already reads timelines for — rather
 * than pretending mail left the building.
 */
export async function queueDraft(ctx, draftId) {
    const existing = getDraft(ctx, draftId);
    if (existing.status !== 'draft') throw badRequest('This email has already been queued, sent or cancelled.');
    if (!existing.recipient_email && !existing.cc_emails.length) {
        throw badRequest('This email has no recipient — add a contact email, or configure recipients for this category in Settings.');
    }
    run('UPDATE email_messages SET status = ?, updated_at = ? WHERE id = ?', ['queued', now(), draftId]);
    logEmailActivity(ctx, getDraft(ctx, draftId));
    const { deliverMessage } = await import('./email-delivery.mjs');
    await deliverMessage(ctx, getDraft(ctx, draftId));
    return getDraft(ctx, draftId);
}

export function cancelDraft(ctx, draftId) {
    const existing = getDraft(ctx, draftId);
    if (existing.status !== 'draft') throw badRequest('Only a draft can be cancelled.');
    run('UPDATE email_messages SET status = ?, updated_at = ? WHERE id = ?', ['cancelled', now(), draftId]);
    return getDraft(ctx, draftId);
}

/**
 * The Activity every queued email creates — the one place `type_key` and
 * `properties` are decided, so a person-sent proposal email and an
 * automation-raised finance email both leave the same shape of footprint on
 * the timeline (see request section 10).
 */
/** The 'email_queued' activity type exists before the first email needs it — same pattern as lib/outreach.mjs's 'outreach' type. */
function ensureEmailActivityType(ctx) {
    const row = get(`SELECT id FROM activity_types WHERE workspace_id = ? AND key = 'email_queued'`, [ctx.workspaceId]);
    if (row) return;
    run(
        `INSERT INTO activity_types (id, workspace_id, key, label, icon, color, manual, position)
         VALUES (?,?,?,?,?,?,?,?)`,
        [id('aty'), ctx.workspaceId, 'email_queued', 'Email', 'mail', 'info', 0, 61],
    );
}

export function logEmailActivity(ctx, message) {
    ensureEmailActivityType(ctx);
    const stamp = now();
    const activityId = id('act');
    // Proposal-to-client shows on the DEAL's timeline (matching the existing
    // `proposal_sent` activity convention — see markProposalSent). Every
    // agreement-related email shows on the AGREEMENT's own timeline. Either
    // way, `account_id` below is what additionally rolls it up onto the
    // Account's timeline regardless of which of these it is.
    const parentType = message.category === 'proposal_client' && message.deal_id ? 'deal'
        : message.agreement_id ? 'agreement'
            : message.deal_id ? 'deal' : 'account';
    const parentId = parentType === 'deal' ? message.deal_id : parentType === 'agreement' ? message.agreement_id : message.account_id;
    run(
        `INSERT INTO activities (id, workspace_id, parent_type, parent_id, account_id, type_key, subject, body,
            occurred_at, actor_id, source, properties, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
            activityId, ctx.workspaceId, parentType, parentId, message.account_id,
            'email_queued', `${message.subject}`, null, stamp,
            message.source === 'automation' ? null : (ctx.userId ?? null),
            message.source,
            JSON.stringify({
                email_message_id: message.id, category: message.category,
                recipient: message.recipient_email, cc: json(message.cc_emails, []),
                attachments: json(message.attachment_document_ids, []).length,
            }),
            stamp, stamp,
        ],
    );
    return getDraft(ctx, message.id);
}
