/**
 * HTTP surface for the business email system — templates, previews, drafts.
 *
 * Sending is not implemented (see lib/email-drafts.mjs): `send` here means
 * "queue", not "deliver". Every function is a thin wrapper over the four
 * lib/email-*.mjs services; no business logic lives in this file.
 */
import { readJson, badRequest } from '../lib/http.mjs';
import { require$ } from '../lib/auth.mjs';
import { all } from '../lib/db.mjs';
import {
    listTemplates, getTemplate, createTemplate, updateTemplate, duplicateTemplate, deleteTemplate,
} from '../lib/email-templates.mjs';
import { previewTemplate, buildDraft, getDraft, updateDraft, queueDraft, cancelDraft } from '../lib/email-drafts.mjs';
import { sendTestEmail } from '../lib/email-delivery.mjs';

const CLIENT_CATEGORIES = ['proposal_client', 'agreement_client'];

/** A draft as the frontend wants it — attachment ids resolved to `{id, name}`, so the send dialog never has to ask separately. */
function withAttachmentNames(ctx, draft) {
    if (!draft.attachment_document_ids.length) return { ...draft, attachments: [] };
    const rows = all(
        `SELECT id, name FROM documents WHERE workspace_id = ? AND id IN (${draft.attachment_document_ids.map(() => '?').join(',')})`,
        [ctx.workspaceId, ...draft.attachment_document_ids],
    );
    return { ...draft, attachments: draft.attachment_document_ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean) };
}

/* ------------------------------------------------------------ templates -- */

export async function templates({ ctx }) {
    require$(ctx, 'proposal.issue');
    return { templates: listTemplates(ctx) };
}

export async function template({ params, ctx }) {
    require$(ctx, 'proposal.issue');
    return { template: getTemplate(ctx, params.id) };
}

export async function createTemplateRoute({ req, ctx }) {
    require$(ctx, 'record.write.all');
    const body = await readJson(req);
    return { template: createTemplate(ctx, body) };
}

export async function updateTemplateRoute({ req, params, ctx }) {
    require$(ctx, 'record.write.all');
    const body = await readJson(req);
    return { template: updateTemplate(ctx, params.id, body) };
}

export async function duplicateTemplateRoute({ params, ctx }) {
    require$(ctx, 'record.write.all');
    return { template: duplicateTemplate(ctx, params.id) };
}

export async function deleteTemplateRoute({ params, ctx }) {
    require$(ctx, 'record.write.all');
    return deleteTemplate(ctx, params.id);
}

/** Preview a template (or the active one for a category) against a real record — writes nothing. */
export async function previewTemplateRoute({ req, params, ctx }) {
    require$(ctx, 'proposal.issue');
    const body = await readJson(req);
    return previewTemplate(ctx, { templateId: params.id, ...body });
}

export async function previewCategoryRoute({ req, params, ctx }) {
    require$(ctx, 'proposal.issue');
    const body = await readJson(req);
    return previewTemplate(ctx, { category: params.category, ...body });
}

/* ---------------------------------------------------------------- drafts -- */

/** Only the two client-facing categories are user-initiated — the other two are automation-only (lib/email-automation.mjs). */
export async function createDraft({ req, ctx }) {
    require$(ctx, 'proposal.issue');
    const body = await readJson(req);
    if (!CLIENT_CATEGORIES.includes(body.category)) {
        throw badRequest(`"${body.category}" emails are sent automatically when an agreement is signed — they are not started by hand.`);
    }
    return { draft: withAttachmentNames(ctx, buildDraft(ctx, { ...body, source: 'ui' })) };
}

export async function draft({ params, ctx }) {
    require$(ctx, 'proposal.issue');
    return { draft: withAttachmentNames(ctx, getDraft(ctx, params.id)) };
}

export async function updateDraftRoute({ req, params, ctx }) {
    require$(ctx, 'proposal.issue');
    const body = await readJson(req);
    return { draft: withAttachmentNames(ctx, updateDraft(ctx, params.id, body)) };
}

export async function sendDraft({ params, ctx }) {
    require$(ctx, 'proposal.issue');
    return { draft: withAttachmentNames(ctx, await queueDraft(ctx, params.id)) };
}

export async function cancelDraftRoute({ params, ctx }) {
    require$(ctx, 'proposal.issue');
    return { draft: withAttachmentNames(ctx, cancelDraft(ctx, params.id)) };
}

/** Settings' "Send a test email" — proves a configured relay actually works. */
export async function testSend({ req, ctx }) {
    require$(ctx, 'record.write.all');
    const body = await readJson(req);
    if (!body.to?.trim()) throw badRequest('Give an address to send the test to.');
    await sendTestEmail(ctx, body.to.trim());
    return { ok: true };
}
