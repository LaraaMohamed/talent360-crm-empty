/**
 * DocumentAttachmentService — which document(s) a business email attaches,
 * resolved from the CRM's own records so nobody is ever asked to upload a
 * proposal or agreement by hand for something the system already generated.
 *
 * Each function returns the SAME shape: `{ documents, missing }` — the
 * document rows found (each carrying `id`/`name`/`storage_key`, ready for
 * `lib/document-store.mjs`'s `readFile` once sending is connected), and the
 * human-readable names of anything expected but not on file, e.g.
 * `"Client Proposal (not generated yet)"`. A missing attachment never
 * silently drops the email's other attachments — the draft is still built,
 * with the gap named so a person catches it in preview.
 */
import { get } from './db.mjs';
import { resolveSourceProposal } from './internal-proposal.mjs';

function documentFor(ctx, documentId) {
    if (!documentId) return null;
    return get('SELECT * FROM documents WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL', [documentId, ctx.workspaceId]);
}

/** Proposal → Client: the proposal's own generated document. */
export function attachmentsForProposalEmail(ctx, proposal) {
    const doc = documentFor(ctx, proposal?.document_id);
    return doc
        ? { documents: [doc], missing: [] }
        : { documents: [], missing: ['Client Proposal (not generated as a document yet)'] };
}

/** Agreement → Client: the agreement's own generated document. */
export function attachmentsForAgreementEmail(ctx, agreement) {
    const doc = documentFor(ctx, agreement?.document_id);
    return doc
        ? { documents: [doc], missing: [] }
        : { documents: [], missing: ['Agreement (not generated as a document yet)'] };
}

/** Agreement Signed → Finance: the signed agreement, plus the client proposal it closed. */
export function attachmentsForFinanceEmail(ctx, agreement) {
    const documents = [];
    const missing = [];

    const agreementDoc = documentFor(ctx, agreement?.document_id);
    if (agreementDoc) documents.push(agreementDoc);
    else missing.push('Signed Agreement (not generated as a document yet)');

    const sourceProposal = agreement ? resolveSourceProposal(ctx, agreement) : null;
    const proposalDoc = documentFor(ctx, sourceProposal?.document_id);
    if (proposalDoc) documents.push(proposalDoc);
    else missing.push('Client Proposal (no source proposal found for this agreement)');

    return { documents, missing };
}

/** Agreement Signed → Internal Team: the Internal Team Proposal — never the priced client proposal. */
export function attachmentsForInternalTeamEmail(ctx, agreement) {
    if (!agreement) return { documents: [], missing: ['Internal Team Proposal (no agreement)'] };
    const internal = get(
        `SELECT * FROM proposals WHERE workspace_id = ? AND source_agreement_id = ? AND type = 'internal_team' AND deleted_at IS NULL
           ORDER BY created_at DESC LIMIT 1`,
        [ctx.workspaceId, agreement.id],
    );
    const doc = documentFor(ctx, internal?.document_id);
    return doc
        ? { documents: [doc], missing: [] }
        : { documents: [], missing: ['Internal Team Proposal (not generated yet — ensureInternalTeamProposal should have raised it on signing)'] };
}
