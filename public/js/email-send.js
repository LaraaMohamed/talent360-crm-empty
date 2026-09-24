/**
 * The client-facing send dialog — Proposal → Client and Agreement → Client.
 *
 * "Template = reusable default. Email draft = editable instance." Opening
 * this dialog builds a fresh draft server-side (a new `email_messages` row,
 * `POST /api/email/drafts`) from the category's active template resolved
 * against the given record; editing here PATCHes that one row and never
 * touches the template. Cancelling marks the draft cancelled rather than
 * leaving it orphaned in `draft` status forever.
 *
 * Sending is not connected yet (see lib/email-drafts.mjs) — the button says
 * "Send" because that is the action a person takes, and the confirmation
 * afterward says plainly what actually happened.
 */
import { h, modal, toast } from './core.js';
import { api } from './api.js';
import { skeletonRows, icon } from './components.js';

/**
 * @param {{category: 'proposal_client'|'agreement_client', dealId?: string, agreementId?: string, proposalId?: string}} params
 * @returns {Promise<boolean>} whether the email was queued
 */
export async function openSendEmailDialog({ category, dealId = null, agreementId = null, proposalId = null }) {
    let draft;
    try {
        draft = (await api.post('/api/email/drafts', { category, dealId, agreementId, proposalId })).draft;
    } catch (err) {
        toast(err.message, 'error');
        return false;
    }

    const errorBox = h('div.error');
    const toInput = h('input.input', { type: 'email', value: draft.recipient_email ?? '', placeholder: 'name@company.com' });
    const ccInput = h('input.input', {
        type: 'text', value: (draft.cc_emails ?? []).join(', '),
        placeholder: 'Comma-separated — cc@company.com, another@company.com',
    });
    const subjectInput = h('input.input', { value: draft.subject });
    const bodyInput = h('textarea.input', { rows: 14, value: draft.body });
    let cancelled = false;

    const saved = await modal({
        title: category === 'proposal_client' ? 'Send proposal' : 'Send agreement',
        size: 'wide',
        closeGuard: async () => {
            // A dialog dismissed by Escape/backdrop is still a cancel — the
            // draft this call created must not sit forever unaddressed.
            if (!cancelled) { cancelled = true; await api.post(`/api/email/drafts/${draft.id}/cancel`, {}).catch(() => {}); }
            return true;
        },
        body: h('div.stack',
            errorBox,
            h('div.field', h('label', 'To'), toInput,
                draft.recipient_name && h('span.help', `Found on file for ${draft.recipient_name} — edit if this send needs a different address.`)),
            !draft.recipient_email && h('div.note-box.warning',
                h('div.strong.small', 'No recipient found'),
                h('p.xs', 'This deal has no contact with an email address on file. Type one in above before sending.')),
            h('div.field', h('label', 'Cc'), ccInput),
            h('div.field', h('label', 'Subject'), subjectInput),
            h('div.field', h('label', 'Body'), bodyInput),
            h('div.field', h('label', 'Attachment'),
                draft.attachments.length
                    ? h('div.stack.tight', draft.attachments.map((a) => h('div.row', { style: { alignItems: 'center', gap: 'var(--space-1)' } }, icon('doc'), h('span.small', a.name))))
                    : h('div.note-box.warning', 'Nothing to attach yet — generate the document first, then send.')),
            draft.missing_variables.length > 0 && h('div.note-box.warning',
                `This email has unresolved variables: ${draft.missing_variables.map((v) => `{{${v}}}`).join(', ')}`),
        ),
        footer: (close) => [
            h('button.btn', {
                onclick: async () => {
                    cancelled = true;
                    await api.post(`/api/email/drafts/${draft.id}/cancel`, {}).catch(() => {});
                    close(false);
                },
            }, 'Cancel'),
            h('button.btn.primary', {
                disabled: !draft.attachments.length,
                onclick: async (event) => {
                    const button = event.currentTarget;
                    button.disabled = true;
                    try {
                        await api.patch(`/api/email/drafts/${draft.id}`, {
                            subject: subjectInput.value,
                            body: bodyInput.value,
                            recipientEmail: toInput.value,
                            ccEmails: ccInput.value,
                        });
                        await api.post(`/api/email/drafts/${draft.id}/send`, {});
                        cancelled = true; // already resolved — closeGuard must not also cancel it
                        close(true);
                    } catch (err) {
                        errorBox.textContent = err.message;
                        button.disabled = false;
                    }
                },
            }, 'Send'),
        ],
    });

    if (saved) {
        toast('Email queued — recorded on the timeline, ready to send once a provider is connected.', 'success');
    }
    return !!saved;
}
