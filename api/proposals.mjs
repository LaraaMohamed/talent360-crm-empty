/**
 * Proposals and agreements.
 *
 * Two things this module is careful about:
 *
 *  1. A proposal VERSION is immutable once issued. The customer is holding v1;
 *     editing v1 to say something else makes the CRM disagree with the document
 *     in their inbox. A change makes v2.
 *
 *  2. Generation goes through a template + merge-field renderer, not a vendor.
 *     Google Docs would be one implementation of `render`, not a dependency of
 *     the module — which is the whole reason the interface is shaped this way.
 *     v1 ships the built-in HTML renderer; the seam is where a provider plugs in.
 */
import { all, get, run, tx, id, now, json } from '../lib/db.mjs';
import {
    getRecord, listRecords, audit, insert, update, nextDocumentNumber, syncDealValues,
    setDealPrice, dealPrice, ensureDealForAgreement, moveDealToStage, advanceDealForProposal, advanceDealToStage,
} from '../lib/repo.mjs';
import { readJson, badRequest, notFound, sendBuffer } from '../lib/http.mjs';
import { require$, can, requireWrite } from '../lib/auth.mjs';
import { openApprovalTask, closeApprovalTask } from '../lib/approvals.mjs';
import { notifyApprovalDecision } from '../lib/notify.mjs';
import { deriveValues, lineValue, formatMoney, billingTypeLabel } from '../lib/money.mjs';
import { ensureInternalTeamProposal } from '../lib/internal-proposal.mjs';
import { handleAgreementSigned } from '../lib/email-automation.mjs';

/* ------------------------------------------------------------- proposals -- */

export async function createProposal({ req, ctx }) {
    require$(ctx, 'proposal.issue');
    const body = await readJson(req);

    /**
     * A proposal belongs to a DEAL — the commercial opportunity it quotes.
     *
     * When no deal is passed, one is found or created for the account. This is
     * enforced here, at the API, so a caller that skips the frontend cannot
     * drop a proposal into the database with no opportunity behind it. Finding
     * before creating keeps the request idempotent: creating a proposal twice
     * for the same account never produces a second deal.
     */
    let deal = body.dealId ? getRecord('deal', ctx, body.dealId) : null;
    if (!deal) {
        const account = body.accountId ? getRecord('account', ctx, body.accountId) : null;
        if (!account) throw badRequest('A proposal needs a deal, or an account to raise one against.');
        deal = ensureDealForAgreement(ctx, {
            accountId: account.id,
            serviceLineKey: body.serviceLineKey ?? null,
            currency: account.billing_currency ?? null,
            price: body.totalValue ?? body.value ?? null,
            because: 'a proposal needs a deal',
        });
        if (!deal) throw badRequest('No pipeline is configured, so no deal could be created for this proposal.');
    }

    /**
     * The ACCOUNT decides what the client is billed in.
     *
     * A proposal is a document the customer reads, so it carries the currency
     * they actually pay in — and that is a fact about the account, not about
     * the deal record somebody opened. The deal's own currency stays as the
     * fallback for a deal raised before its account was classified, and the
     * workspace base currency behind that.
     *
     * This is the one direction the reporting conversion never runs in. The
     * dashboard converts to USD for management; a document never does.
     */
    const account = deal.account_id ? getRecord('account', ctx, deal.account_id) : null;
    const currency = account?.billing_currency || deal.currency || ctx.workspace.baseCurrency;

    const proposalId = id('pro');
    // The one numbering scheme, shared with document generation and with the
    // generic create route. Three copies of "count the rows and pad to four" is
    // how two contracts end up sharing a number.
    const number = nextDocumentNumber(ctx, 'proposals', 'P');

    return tx(() => {
        insert('proposals', {
            id: proposalId, workspace_id: ctx.workspaceId, deal_id: deal.id, account_id: deal.account_id,
            number, title: body.title || `${deal.name} — proposal`, currency,
            status: 'draft', current_version: 0, owner_id: ctx.userId, created_at: now(), updated_at: now(),
        });
        audit(ctx, { objectKey: 'proposal', recordId: proposalId, accountId: deal.account_id, action: 'created', after: { number, deal: deal.id } });
        // The deal is being quoted — see advanceDealForProposal for why this
        // never moves it backward.
        advanceDealForProposal(ctx, deal.id, 'a proposal was created for this deal');
        return { proposal: getRecord('proposal', ctx, proposalId) };
    });
}

export async function proposalDetail({ params, ctx }) {
    const proposal = getRecord('proposal', ctx, params.id);
    const versions = all('SELECT * FROM proposal_versions WHERE proposal_id = ? ORDER BY version DESC', [params.id])
        .map((v) => ({ ...v, content: json(v.content, {}) }));
    const deal = proposal.deal_id ? getRecord('deal', ctx, proposal.deal_id) : null;

    // The proposal keeps the figures it was issued with. If the deal has moved
    // since, that is flagged rather than quietly reconciled — the customer's
    // copy has not changed.
    let divergence = null;
    const current = versions.find((v) => v.version === proposal.current_version);
    if (current && deal) {
        const live = deriveValues(
            all('SELECT * FROM deal_line_items WHERE deal_id = ? ORDER BY position', [deal.id]),
            { probability: 0, baseCurrency: ctx.workspace.baseCurrency },
        );
        if (Math.abs(live.value_one_time - current.total_one_time) > 0.01 || Math.abs(live.value_mrr - current.total_mrr) > 0.01) {
            divergence = {
                issued: { oneTime: current.total_one_time, mrr: current.total_mrr },
                current: { oneTime: live.value_one_time, mrr: live.value_mrr },
                message: 'The deal has changed since this version was issued. The customer holds the issued figures; '
                    + 'issue a new version to change the terms.',
            };
        }
    }

    return { proposal, versions, deal, divergence };
}

/**
 * Creates the next version, freezing the deal's line items into it.
 *
 * The content snapshot is what makes a proposal a document rather than a live
 * query. Line items flow FROM the deal so the two cannot silently disagree, and
 * are copied INTO the version so the deal changing later does not rewrite
 * history.
 */
export async function createVersion({ req, params, ctx }) {
    require$(ctx, 'proposal.issue');
    const proposal = getRecord('proposal', ctx, params.id);
    /**
     * An Internal Team Proposal has exactly one legitimate writer —
     * `ensureInternalTeamProposal` (lib/internal-proposal.mjs), which is the
     * only path that redacts price BEFORE the document is built. This is the
     * ordinary version wizard, which quotes the deal's real line items with
     * no redaction step at all: letting it touch this record type is the one
     * way "no price in the generated document" could stop being true.
     */
    if (proposal.type === 'internal_team') {
        throw badRequest(
            'This is an Internal Team Proposal, generated automatically with pricing removed. '
            + 'It is not edited by hand — see the commercial proposal it came from instead.',
        );
    }
    // Two ways of producing a proposal, one record. Which one this is decides
    // where its next version comes from, and quoting a template-written
    // proposal from line items it was never based on would be a different
    // document under the same number.
    if (proposal.document_type) {
        throw badRequest(
            'This proposal is written from a template. Generate the next version from the account '
            + 'so it is produced the same way the ones before it were.',
        );
    }
    if (!proposal.deal_id) throw badRequest('This proposal is not linked to a deal, so there are no line items to quote.');
    const deal = getRecord('deal', ctx, proposal.deal_id);
    const body = await readJson(req).catch(() => ({}));

    const account = getRecord('account', ctx, proposal.account_id);
    const items = all('SELECT * FROM deal_line_items WHERE deal_id = ? ORDER BY position', [deal.id]);
    if (!items.length) throw badRequest('This deal has no line items yet, so there is nothing to quote.');

    const totals = deriveValues(items, { probability: 0, baseCurrency: proposal.currency });
    const version = proposal.current_version + 1;
    const versionId = id('pvr');

    const content = {
        title: body.title ?? proposal.title,
        intro: body.intro ?? '',
        terms: body.terms ?? DEFAULT_TERMS,
        validUntil: body.validUntil ?? new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10),
        account: { id: account.id, name: account.name, legalName: account.legal_name, crNumber: account.cr_number, country: account.country },
        deal: { id: deal.id, name: deal.name, serviceLine: deal.service_line_key },
        items: items.map((item) => ({ ...item, derived: lineValue(item) })),
        totals,
        currency: proposal.currency,
        // Merge fields resolve from any record field including custom ones, so a
        // template referencing a workspace's own field works with no code change.
        mergeData: mergeData(account, deal, ctx),
        preparedBy: ctx.user?.name ?? null,
        preparedAt: now(),
    };

    return tx(() => {
        insert('proposal_versions', {
            id: versionId, workspace_id: ctx.workspaceId, proposal_id: params.id, version,
            status: 'draft', valid_until: content.validUntil,
            content: JSON.stringify(content), rendered_html: renderHtml(content),
            total_one_time: totals.value_one_time, total_mrr: totals.value_mrr,
            term_months: maxTerm(items), created_by: ctx.userId, created_at: now(),
        });
        /**
         * A new version returns the proposal to `draft`, and this is not
         * bookkeeping — without it the workflow deadlocks.
         *
         * Once v1 is issued the proposal reads `issued`, which is neither
         * approvable (nothing is awaiting review) nor submittable (only a draft
         * or a rejection goes up). v2 could then never be issued by anybody,
         * and the two refusals each told you to do what the other forbade.
         *
         * Returning to `draft` is also the honest answer on its own terms:
         * these are unissued changes, so this is no longer the document anybody
         * approved, and it goes round again.
         */
        update('proposals', params.id, {
            current_version: version, status: 'draft', updated_at: now(),
        });
        audit(ctx, { objectKey: 'proposal', recordId: params.id, accountId: proposal.account_id, action: 'version_created', after: { version } });
        return { version: get('SELECT * FROM proposal_versions WHERE id = ?', [versionId]) };
    });
}

/* ---------------------------------------------------------------- review -- */

/**
 * Draft → Pending review → Approved / Rejected.
 *
 * The rule underneath is one sentence: the person who writes a document is not
 * the person who commits the company to it. A rep drafts and submits; approving
 * needs `document.approve`, which manager and above hold and a rep does not.
 *
 * Written once for both tables because a proposal and an agreement differ in
 * what happens AFTER approval — one is issued, the other is signed — and not at
 * all in how they are reviewed. Two copies of this would drift.
 *
 * What is deliberately NOT enforced here: that the reviewer is a different
 * person from the author. On a team this size that rule deadlocks the moment
 * the only manager writes a proposal, and the capability boundary is the
 * control the business asked for. The audit trail records who approved what, so
 * a self-approval is visible rather than prevented.
 */
const REVIEWABLE = {
    proposal: { table: 'proposals', label: 'proposal' },
    agreement: { table: 'agreements', label: 'agreement' },
};

/** Statuses a document can be submitted FROM. */
const SUBMITTABLE = new Set(['draft', 'rejected']);

function reviewable(kind, ctx, recordId) {
    const spec = REVIEWABLE[kind];
    const record = getRecord(kind, ctx, recordId);
    return { spec, record };
}

export async function submitForReview({ params, ctx, kind }) {
    const { spec, record } = reviewable(kind, ctx, params.id);
    // Submitting is an edit to your own document, so it takes the same
    // ownership rule as any other edit rather than a capability of its own.
    requireWrite(ctx, record);

    if (!SUBMITTABLE.has(record.status)) {
        throw badRequest(
            `This ${spec.label} is "${record.status}", so there is nothing to submit. `
            + 'Only a draft or a rejected document goes for review.',
        );
    }

    update(spec.table, record.id, {
        status: 'pending_review', submitted_at: now(), updated_at: now(),
        // A resubmission starts clean: last round's verdict is not this round's.
        reviewed_by: null, reviewed_at: null, review_note: null,
    });
    audit(ctx, {
        objectKey: kind, recordId: record.id, accountId: record.account_id,
        action: 'submitted_for_review', before: { status: record.status }, after: { status: 'pending_review' },
    });
    /**
     * And somebody is ASKED, rather than expected to notice.
     *
     * A status is not a notification: `pending_review` sat on the record and
     * the manager discovered it when the rep went and told them. The approval
     * is now a task in their queue like every other piece of their work. See
     * lib/approvals.mjs.
     */
    const task = openApprovalTask(ctx, kind, getRecord(kind, ctx, record.id));
    return { [kind]: getRecord(kind, ctx, record.id), approvalTask: task?.id ?? null };
}

export async function reviewDocument({ req, params, ctx, kind }) {
    require$(ctx, 'document.approve');
    const { spec, record } = reviewable(kind, ctx, params.id);
    const body = await readJson(req).catch(() => ({}));

    const decision = String(body.decision ?? '').toLowerCase();
    if (decision !== 'approved' && decision !== 'rejected') {
        throw badRequest('A review decision is either "approved" or "rejected".');
    }
    if (record.status !== 'pending_review') {
        throw badRequest(
            `This ${spec.label} is "${record.status}", not awaiting review. `
            + 'Approving something twice, or approving a draft nobody submitted, is not a review.',
        );
    }

    const note = String(body.note ?? '').trim();
    // A rejection without a reason sends the author back to guess at what was
    // wrong, so it is required. An approval needs no justification.
    if (decision === 'rejected' && !note) {
        throw badRequest('Say why it was rejected — the author has to know what to change.');
    }

    /**
     * For a TEMPLATE-written proposal, approval is the finalising act.
     *
     * A line-item proposal has versions, and issuing one is a separate step
     * that freezes it. A proposal generated from a template has no versions —
     * the document already exists as a file — so there is nothing left to do
     * after approval and leaving it "approved" for ever would strand it one
     * status short of the truth.
     */
    const templateWritten = kind === 'proposal' && Boolean(record.document_type);
    const finalStatus = decision === 'approved' && templateWritten ? 'issued' : decision;

    return tx(() => {
        update(spec.table, record.id, {
            status: finalStatus, reviewed_by: ctx.userId, reviewed_at: now(),
            review_note: note || null, updated_at: now(),
        });

        /**
         * The previous proposal is replaced when its replacement is APPROVED,
         * not when it was generated.
         *
         * Superseding at generation time meant a rejected draft still knocked
         * the live proposal out of the account — the client's actual offer
         * marked "superseded" by something nobody accepted. Only `issued` is
         * touched: "sent", "accepted" and "declined" record things that happened
         * between two companies, and this is not the software's licence to
         * unsay them.
         */
        if (finalStatus === 'issued' && templateWritten) {
            run(
                `UPDATE proposals SET status = 'superseded', updated_at = ?
                  WHERE workspace_id = ? AND account_id = ? AND document_type = ?
                    AND status = 'issued' AND id != ? AND deleted_at IS NULL`,
                [now(), ctx.workspaceId, record.account_id, record.document_type, record.id],
            );
        }

        audit(ctx, {
            objectKey: kind, recordId: record.id, accountId: record.account_id,
            action: decision === 'approved' ? 'approved' : 'rejected',
            before: { status: 'pending_review' }, after: { status: finalStatus, note: note || null },
        });
        // The question has been answered, so the task that asked it is done —
        // completed rather than deleted, carrying what was decided.
        closeApprovalTask(ctx, kind, record.id, decision);

        /**
         * THE AUTHOR LEARNS THE ANSWER, AND WHY.
         *
         * Submitting and waiting is the whole reason a review exists, so the
         * decision — and the reviewer's note, which a rejection requires — go
         * back to whoever submitted it. Best-effort: the review itself has
         * already happened.
         */
        const reviewerName = get('SELECT name FROM users WHERE id = ?', [ctx.userId])?.name ?? null;
        notifyApprovalDecision(ctx, {
            authorId: record.created_by ?? record.owner_id ?? null,
            label: kind === 'agreement' ? 'Agreement' : 'Proposal',
            decision,
            number: record.number ?? null,
            note: note || null,
            reviewedBy: reviewerName,
            link: `/${kind}s/${record.id}`,
        });
        return { [kind]: getRecord(kind, ctx, record.id) };
    });
}

/**
 * The gate every finalising action passes through.
 *
 * Issuing a proposal and signing an agreement are the two moments a document
 * stops being ours and starts being the customer's, and both require that
 * somebody with `document.approve` said yes first.
 */
function requireApproved(record, { label, action }) {
    if (record.status === 'approved') return;
    if (record.status === 'pending_review') {
        throw badRequest(`This ${label} is waiting for review. It can be ${action} once a manager approves it.`);
    }
    throw badRequest(
        `This ${label} is "${record.status}" and has not been approved, so it cannot be ${action}. `
        + 'Submit it for review first.',
    );
}

export const submitProposalForReview = (args) => submitForReview({ ...args, kind: 'proposal' });
export const reviewProposal = (args) => reviewDocument({ ...args, kind: 'proposal' });
export const submitAgreementForReview = (args) => submitForReview({ ...args, kind: 'agreement' });
export const reviewAgreement = (args) => reviewDocument({ ...args, kind: 'agreement' });

/** Issuing freezes the version. From here it can be sent, never edited. */
export async function issueVersion({ params, ctx }) {
    require$(ctx, 'proposal.issue');
    const proposal = getRecord('proposal', ctx, params.id);
    const version = get('SELECT * FROM proposal_versions WHERE proposal_id = ? AND version = ?', [params.id, Number(params.version)]);
    if (!version) throw notFound('That version does not exist.');
    if (version.status === 'issued') throw badRequest('That version is already issued. Create a new version to change the terms.');
    requireApproved(proposal, { label: 'proposal', action: 'issued' });

    return tx(() => {
        update('proposal_versions', version.id, { status: 'issued', issued_at: now() });
        // Also a document on the account, so it turns up where people look for
        // files rather than only inside the proposal module.
        const documentId = id('doc');
        insert('documents', {
            id: documentId, workspace_id: ctx.workspaceId, parent_type: 'proposal', parent_id: params.id,
            account_id: proposal.account_id, name: `${proposal.number} v${version.version} — ${proposal.title}.html`,
            kind: 'proposal', mime: 'text/html', size_bytes: (version.rendered_html ?? '').length,
            storage_key: `proposal:${version.id}`, uploaded_by: ctx.userId, created_at: now(),
        });
        /**
         * Without this, the document above exists but nothing that asks "what
         * IS this proposal's document" — `attachmentsForProposalEmail`, lib/
         * email-attachments.mjs, foremost among them — can find it. That path
         * reads `proposals.document_id` alone, so the "Send email → Client"
         * action on an issued line-item proposal reported the attachment
         * missing on every send, silently, the same failure mode already
         * found and fixed for the Internal Team Proposal's own document.
         */
        update('proposals', params.id, { status: 'issued', document_id: documentId, updated_at: now() });
        audit(ctx, {
            objectKey: 'proposal', recordId: params.id, accountId: proposal.account_id,
            action: 'proposal_issued', after: { version: version.version, number: proposal.number },
        });
        return { version: get('SELECT * FROM proposal_versions WHERE id = ?', [version.id]) };
    });
}

export async function markSent({ params, ctx }) {
    require$(ctx, 'proposal.issue');
    const proposal = getRecord('proposal', ctx, params.id);
    const version = get('SELECT * FROM proposal_versions WHERE proposal_id = ? AND version = ?', [params.id, Number(params.version)]);
    if (!version) throw notFound('That version does not exist.');
    if (version.status !== 'issued') throw badRequest('Issue the version before sending it.');

    return tx(() => {
        update('proposal_versions', version.id, { sent_at: now() });
        update('proposals', params.id, { status: 'sent', updated_at: now() });
        insert('activities', {
            id: id('act'), workspace_id: ctx.workspaceId, parent_type: 'deal', parent_id: proposal.deal_id,
            account_id: proposal.account_id, type_key: 'proposal_sent',
            subject: `${proposal.number} v${version.version} sent`, body: null,
            occurred_at: now(), actor_id: ctx.userId, source: 'system', created_at: now(), updated_at: now(),
        });
        // The pipeline's own stage says the same thing the proposal's status
        // just did. Forward-only — see advanceDealToStage.
        if (proposal.deal_id) {
            advanceDealToStage(ctx, proposal.deal_id, 'proposal_sent', `${proposal.number} was sent`);
        }
        return { ok: true };
    });
}

/**
 * The same mark, for a proposal generated from a .docx template.
 *
 * That path has no `proposal_versions` row to carry `sent_at` — it goes
 * straight from approval to `issued` in one step (see reviewDocument) — so
 * this is proposal-level rather than version-level, but otherwise the same
 * fact: somebody told the CRM the document left the building.
 */
export async function markProposalSent({ params, ctx }) {
    require$(ctx, 'proposal.issue');
    const proposal = getRecord('proposal', ctx, params.id);
    if (proposal.status !== 'issued') {
        throw badRequest('This proposal has to be issued before it can be marked sent.');
    }

    return tx(() => {
        update('proposals', params.id, { status: 'sent', updated_at: now() });
        insert('activities', {
            id: id('act'), workspace_id: ctx.workspaceId, parent_type: 'deal', parent_id: proposal.deal_id,
            account_id: proposal.account_id, type_key: 'proposal_sent',
            subject: `${proposal.number} sent`, body: null,
            occurred_at: now(), actor_id: ctx.userId, source: 'system', created_at: now(), updated_at: now(),
        });
        if (proposal.deal_id) {
            advanceDealToStage(ctx, proposal.deal_id, 'proposal_sent', `${proposal.number} was sent`);
        }
        audit(ctx, {
            objectKey: 'proposal', recordId: params.id, accountId: proposal.account_id,
            action: 'proposal_sent', after: { number: proposal.number },
        });
        return { proposal: getRecord('proposal', ctx, params.id) };
    });
}

export async function renderVersion({ params, ctx, res }) {
    const proposal = getRecord('proposal', ctx, params.id);
    const version = get('SELECT * FROM proposal_versions WHERE proposal_id = ? AND version = ?', [params.id, Number(params.version)]);
    if (!version) throw notFound('That version does not exist.');
    const html = version.rendered_html || renderHtml(json(version.content, {}));
    sendBuffer(res, 200, Buffer.from(html, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8' });
    return undefined;
}

/** A field-by-field diff between two versions, so a change is reviewable. */
export async function diffVersions({ url, params, ctx }) {
    getRecord('proposal', ctx, params.id);
    const a = Number(url.searchParams.get('from'));
    const b = Number(url.searchParams.get('to'));
    const rows = all('SELECT * FROM proposal_versions WHERE proposal_id = ? AND version IN (?,?)', [params.id, a, b]);
    if (rows.length < 2) throw badRequest('Pick two versions that both exist.');

    const [left, right] = rows.sort((x, y) => x.version - y.version).map((v) => json(v.content, {}));
    const changes = [];

    const compare = (label, x, y) => {
        if (JSON.stringify(x) !== JSON.stringify(y)) changes.push({ field: label, from: x, to: y });
    };
    compare('Title', left.title, right.title);
    compare('Valid until', left.validUntil, right.validUntil);
    compare('One-time total', left.totals?.value_one_time, right.totals?.value_one_time);
    compare('MRR', left.totals?.value_mrr, right.totals?.value_mrr);
    compare('Terms', left.terms, right.terms);

    const key = (i) => `${i.label}|${i.pricing_model}`;
    const leftItems = new Map((left.items ?? []).map((i) => [key(i), i]));
    const rightItems = new Map((right.items ?? []).map((i) => [key(i), i]));
    for (const [k, item] of rightItems) {
        if (!leftItems.has(k)) changes.push({ field: `Line added: ${item.label}`, from: null, to: item.derived?.lineContractValue });
        else if (JSON.stringify(leftItems.get(k)) !== JSON.stringify(item)) {
            changes.push({ field: `Line changed: ${item.label}`, from: leftItems.get(k).derived?.lineContractValue, to: item.derived?.lineContractValue });
        }
    }
    for (const [k, item] of leftItems) {
        if (!rightItems.has(k)) changes.push({ field: `Line removed: ${item.label}`, from: item.derived?.lineContractValue, to: null });
    }

    return { from: a, to: b, changes };
}

export async function deleteVersion({ params, ctx }) {
    require$(ctx, 'record.delete');
    const proposal = getRecord('proposal', ctx, params.id);
    const version = get('SELECT * FROM proposal_versions WHERE proposal_id = ? AND version = ?', [params.id, Number(params.version)]);
    if (!version) throw notFound('That version does not exist.');
    if (version.status === 'issued') {
        throw badRequest('Cannot delete an issued version. Create a new version instead.');
    }

    return tx(() => {
        run('DELETE FROM proposal_versions WHERE id = ?', [version.id]);
        audit(ctx, {
            objectKey: 'proposal',
            recordId: params.id,
            accountId: proposal.account_id,
            action: 'version_deleted',
            before: { version: version.version },
        });
        return { ok: true };
    });
}

/* --------------------------------------------------------------- rendering -- */

const DEFAULT_TERMS = 'Fees are exclusive of VAT. Payment terms are 30 days from invoice date. '
    + 'This proposal is valid until the date shown above.';

function mergeData(account, deal, ctx) {
    return {
        'account.name': account.name,
        'account.legal_name': account.legal_name ?? '',
        'account.cr_number': account.cr_number ?? '',
        'account.country': account.country ?? '',
        'account.industry': account.industry ?? '',
        'deal.name': deal.name,
        'deal.service_line': deal.service_line_key ?? '',
        'workspace.name': ctx.workspace.name,
        'today': new Date().toISOString().slice(0, 10),
        // Custom fields come through by their own keys, so a template can
        // reference a field an admin created this morning.
        ...Object.fromEntries(Object.entries(account.properties ?? {}).map(([k, v]) => [`account.${k}`, v ?? ''])),
        ...Object.fromEntries(Object.entries(deal.properties ?? {}).map(([k, v]) => [`deal.${k}`, v ?? ''])),
    };
}

/**
 * The built-in renderer.
 *
 * `dir="auto"` on every text-bearing element, not just the page: an Arabic
 * legal name inside an otherwise-English proposal must render right-to-left on
 * its own, and a page-level direction cannot do that.
 */
function renderHtml(content) {
    const c = content ?? {};
    const money = (n) => formatMoney(n, c.currency ?? 'USD');
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));

    const rows = (c.items ?? []).map((item) => {
        const d = item.derived ?? {};
        const total = d.monthly
            ? `${money(d.monthly)} / month${d.termMonths ? ` × ${d.termMonths} months` : ''}`
            : money(d.oneTime);
        return `<tr>
            <td dir="auto">${esc(item.label)}</td>
            <td>${esc(billingTypeLabel(d.billingType))}</td>
            <td class="num">${esc(money(item.unit_amount))}</td>
            <td class="num">${esc(total)}</td>
        </tr>`;
    }).join('');

    const t = c.totals ?? {};
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.title)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 14px/1.6 -apple-system, "Segoe UI", Roboto, sans-serif; color: #16191d; max-width: 46rem; margin: 0 auto; padding: 3rem 1.5rem 5rem; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; letter-spacing: -.02em; }
  .meta { color: #667085; margin-bottom: 2.5rem; }
  table { width: 100%; border-collapse: collapse; margin: 1.5rem 0; font-variant-numeric: tabular-nums; }
  th, td { text-align: start; padding: .6rem .5rem; border-block-end: 1px solid #e3e6ea; }
  th { font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; color: #667085; }
  .num { text-align: end; }
  .totals { display: grid; grid-template-columns: 1fr auto; gap: .4rem 2rem; margin-top: 1.5rem; }
  .totals .label { color: #667085; }
  .totals .value { text-align: end; font-variant-numeric: tabular-nums; font-weight: 600; }
  .note { margin-top: 2rem; padding: .9rem 1rem; background: #f6f7f9; border-radius: 8px; color: #475467; font-size: .9rem; }
  footer { margin-top: 3rem; color: #667085; font-size: .85rem; }
  @media print { body { padding: 0; } }
</style></head><body>
<h1 dir="auto">${esc(c.title)}</h1>
<p class="meta" dir="auto">
  Prepared for <strong>${esc(c.account?.name)}</strong>${c.account?.legalName ? ` <span dir="auto">(${esc(c.account.legalName)})</span>` : ''}<br>
  ${c.account?.crNumber ? `CR ${esc(c.account.crNumber)} &middot; ` : ''}Valid until ${esc(c.validUntil)}
</p>
${c.intro ? `<p dir="auto">${esc(c.intro)}</p>` : ''}
<table>
  <thead><tr><th>Item</th><th>Billing</th><th class="num">Price</th><th class="num">Amount</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<div class="totals">
  <div class="label">One-time total</div><div class="value">${money(t.value_one_time)}</div>
  <div class="label">Recurring, per month</div><div class="value">${money(t.value_mrr)}</div>
  ${t.value_mrr ? `<div class="label">Annualised recurring</div><div class="value">${money(t.value_arr)}</div>` : ''}
</div>
<div class="note">
  One-time and recurring amounts are shown separately because they are not the same kind of money.
  ${t.assumed_terms ? `${t.assumed_terms} recurring line(s) have no stated term; 12 months is assumed for any contract-value figure.` : ''}
</div>
<p dir="auto">${esc(c.terms)}</p>
<footer>${esc(c.preparedBy ?? '')} &middot; ${esc(String(c.preparedAt ?? '').slice(0, 10))}</footer>
</body></html>`;
}

function maxTerm(items) {
    return items.reduce((a, i) => Math.max(a, Number(i.term_months) || 0), 0) || null;
}

/* ------------------------------------------------------------- agreements -- */

/**
 * Signing an agreement is the event that makes a customer.
 *
 * A won deal is a decision; a signed agreement is a commitment, and only the
 * second one changes the account's lifecycle.
 */
export async function signAgreement({ req, params, ctx }) {
    require$(ctx, 'agreement.sign');
    const agreement = getRecord('agreement', ctx, params.id);
    const body = await readJson(req).catch(() => ({}));
    if (agreement.status === 'signed') throw badRequest('That agreement is already signed.');
    // `out_for_signature` is a stage AFTER approval, so it passes too.
    if (agreement.status !== 'out_for_signature') {
        requireApproved(agreement, { label: 'agreement', action: 'signed' });
    }
    if (!agreement.effective_date && !body.effectiveDate) throw badRequest('An effective date is needed before signing.');

    const signedAt = body.signedAt ?? now();

    const signed = tx(() => {
        update('agreements', params.id, {
            status: 'signed',
            signed_at: signedAt,
            effective_date: body.effectiveDate ?? agreement.effective_date,
            expiry_date: body.expiryDate ?? agreement.expiry_date,
            updated_at: now(),
        });
        audit(ctx, {
            objectKey: 'agreement', recordId: params.id, accountId: agreement.account_id,
            action: 'agreement_signed', after: { number: agreement.number, signedAt },
        });

        /**
         * The deal this contract closes — found or created, never absent.
         *
         * An agreement created before this rule existed can still reach here
         * with no deal, and signing it must not quietly close nothing. See
         * `ensureDealForAgreement` in lib/repo.mjs.
         */
        let deal = agreement.deal_id
            ? get('SELECT * FROM deals WHERE id = ?', [agreement.deal_id])
            : null;
        if (!deal) {
            deal = ensureDealForAgreement(ctx, {
                accountId: agreement.account_id,
                serviceLineKey: agreement.service_line_key ?? null,
                currency: agreement.currency ?? null,
                price: agreement.contract_value ?? null,
            });
            if (deal) update('agreements', params.id, { deal_id: deal.id });
        }

        /**
         * The signed contract is what the deal is worth.
         *
         * The agreement is the truth: it is the document both companies put
         * their names to, and a deal quoting a different figure is quoting a
         * negotiation that has since concluded.
         *
         * BUT the contract value is a TOTAL (`monthly_fee × months`). Writing
         * it straight into a recurring deal would inflate MRR by the term — a
         * 4,200/month retainer under a 50,400 annual contract would become a
         * 50,400/month deal the day it is won. So a recurring deal keeps the
         * line items the proposal or the deal form produced; only a one-time
         * deal (whose whole figure the contract value IS) is priced from the
         * contract value here. The contract value still drives the
         * `deal_value` reporting figure regardless.
         *
         * `current.billingType` already answers "one-time or recurring?" from
         * the deal's OWN service line — `billingTypeForPricingModel` in
         * `dealPrice()` derives it whether or not the deal has ever been
         * priced. The `|| current.price === null` this used to carry ran
         * this same branch for ANY unpriced deal regardless of billing type —
         * so an unpriced HCM (recurring) deal, on first signing, had the
         * agreement's ANNUAL total written in as its MONTHLY rate: exactly
         * the 4,200-vs-50,400 mistake this comment warns about, just reached
         * from "never priced" instead of "already recurring". An unpriced
         * recurring deal is left exactly that — unpriced — for the rep to
         * fill in with the actual monthly figure on the deal form, which
         * asks for it explicitly labelled "per month" rather than guessing
         * one out of a total nothing here can safely divide.
         */
        if (deal && Number(agreement.contract_value) > 0) {
            const current = dealPrice(ctx, deal);
            if (current.billingType === 'one_time') {
                setDealPrice(ctx, deal, {
                    price: Number(agreement.contract_value),
                    currency: agreement.currency || deal.currency,
                    source: 'automation',
                    reason: `agreement ${agreement.number} signed`,
                });
            }
        }

        if (deal) {
            /**
             * The signed contract closes the deal. `moveDealToStage` looks up
             * the won stage by TYPE (so "Placed" or "Deal Won" both work), and
             * the closed_at is the SIGNATURE date — not now — so a deal signed
             * last week is won in the range it was actually won in.
             */
            const moved = moveDealToStage(ctx, deal.id, 'won',
                `agreement ${agreement.number} signed`,
                { closed_at: signedAt },
                { reopen: deal.status !== 'open' && deal.status !== 'won' && deal.status !== 'lost' });
            if (moved) {
                syncDealValues(deal.id, ctx);
                audit(ctx, {
                    objectKey: 'deal', recordId: deal.id, accountId: deal.account_id, action: 'deal_won',
                    after: { because: `agreement ${agreement.number} signed` }, source: 'automation',
                });
            }
        }

        const account = get('SELECT * FROM accounts WHERE id = ?', [agreement.account_id]);
        if (account && account.lifecycle_stage !== 'customer') {
            run('UPDATE accounts SET lifecycle_stage = ?, updated_at = ? WHERE id = ?', ['customer', now(), account.id]);
            audit(ctx, {
                objectKey: 'account', recordId: account.id, accountId: account.id, action: 'lifecycle_changed',
                before: { lifecycle_stage: account.lifecycle_stage },
                after: { lifecycle_stage: 'customer', because: `agreement ${agreement.number} signed` },
                source: 'automation',
            });
        }

        return { agreement: getRecord('agreement', ctx, params.id) };
    });

    /**
     * Everything the signature itself triggers, AFTER it has committed:
     * the Internal Team Proposal, the Finance notification, the Internal
     * Team notification. lib/email-automation.mjs's `handleAgreementSigned`
     * is deliberately as tolerant as `ensureInternalTeamProposal` always
     * was here — a signed agreement is signed whatever happens next, and
     * each of its three steps is independently retried on a subsequent
     * call rather than the caller ever being told something exists when it
     * does not.
     */
    try {
        const outcome = await handleAgreementSigned(ctx, getRecord('agreement', ctx, params.id));
        if (outcome.internalProposal?.error || outcome.finance?.error || outcome.internalTeam?.error) {
            audit(ctx, {
                objectKey: 'agreement', recordId: params.id, accountId: signed.agreement.account_id,
                action: 'agreement_signed_automation_partial', source: 'automation',
                after: outcome,
            });
        }
    } catch (err) {
        audit(ctx, {
            objectKey: 'agreement', recordId: params.id, accountId: signed.agreement.account_id,
            action: 'internal_team_proposal_failed', source: 'automation',
            after: { because: String(err?.message ?? err).slice(0, 300) },
        });
    }

    return signed;
}

/**
 * The manual door back in for a signed agreement whose Internal Team
 * Proposal never got created.
 *
 * `ensureInternalTeamProposal` runs call-and-forget from `signAgreement`
 * and swallows its own failures (see that function's doc comment) — a
 * source proposal that did not exist yet at the moment of signing, or any
 * other transient failure, leaves the agreement signed with nothing to
 * show on this card. This retries the same idempotent function; it is a
 * no-op if the proposal already exists.
 */
export async function retryInternalTeamProposal({ params, ctx }) {
    require$(ctx, 'agreement.sign');
    const agreement = getRecord('agreement', ctx, params.id);
    if (agreement.status !== 'signed') throw badRequest('Only a signed agreement can raise an Internal Team Proposal.');
    const record = ensureInternalTeamProposal(ctx, agreement);
    if (!record) {
        throw badRequest('No Internal Team Proposal could be created. This agreement has no source proposal '
            + '(or generation) on record to build one from — check the deal this agreement closes.');
    }
    /**
     * Also re-raises the Finance and Internal Team notification emails —
     * `handleAgreementSigned` is idempotent per email (see its own doc
     * comment), so this is a genuine "send it" for whichever of the two
     * never went out (no relay configured at the time, a transient
     * failure), and a no-op for whichever already did. There was
     * previously no way to manually trigger these once the document
     * existed — the button above simply disappeared.
     */
    const emails = await handleAgreementSigned(ctx, agreement);
    return { proposal: record, emails };
}

/**
 * The renewal pipeline.
 *
 * Sorted by NOTICE date, not expiry date. A 90-day notice period on a 12-month
 * contract means the decision point is month nine — a list ordered by expiry
 * shows it as comfortably far away on the day it is already too late.
 */
/**
 * `status` widens this page beyond "what's due for notice" to the other
 * questions the same screen answers instead of scattering across the
 * generic Agreements list: what's already renewed, what's expired, what's
 * been terminated. `renewing` (the original, default behaviour) is the only
 * mode the day WINDOW applies to — the others are a status, not a clock.
 */
export async function renewals({ url, ctx }) {
    const days = Math.max(1, Number(url.searchParams.get('days')) || 90);
    const statusFilter = url.searchParams.get('status') || 'renewing';
    const today = Date.now();

    if (statusFilter === 'expired' || statusFilter === 'terminated') {
        const rows = all(
            `SELECT a.*, ac.name AS account_name FROM agreements a
               JOIN accounts ac ON ac.id = a.account_id
              WHERE a.workspace_id = ? AND a.deleted_at IS NULL AND a.status = ?
              ORDER BY a.expiry_date DESC`,
            [ctx.workspaceId, statusFilter],
        );
        return { windowDays: days, statusFilter, agreements: rows, inNoticePeriod: 0, overdue: 0 };
    }

    if (statusFilter === 'renewed') {
        const rows = all(
            `SELECT a.*, ac.name AS account_name FROM agreements a
               JOIN accounts ac ON ac.id = a.account_id
              WHERE a.workspace_id = ? AND a.deleted_at IS NULL
                AND EXISTS (SELECT 1 FROM agreements b WHERE b.supersedes_agreement_id = a.id AND b.workspace_id = a.workspace_id)
              ORDER BY a.expiry_date DESC`,
            [ctx.workspaceId],
        );
        return { windowDays: days, statusFilter, agreements: rows, inNoticePeriod: 0, overdue: 0 };
    }

    // 'active' (every currently-signed agreement) and 'renewing' (the
    // notice-window subset of the same set) share one query — 'active'
    // simply never applies the day-window filter below.
    const rows = all(
        `SELECT a.*, ac.name AS account_name FROM agreements a
           JOIN accounts ac ON ac.id = a.account_id
          WHERE a.workspace_id = ? AND a.deleted_at IS NULL AND a.status = 'signed' AND a.expiry_date IS NOT NULL
          ORDER BY a.expiry_date`,
        [ctx.workspaceId],
    );

    let enriched = rows.map((r) => {
        const expiry = new Date(r.expiry_date).getTime();
        const noticeMs = (r.notice_days || 0) * 864e5;
        const noticeDate = new Date(expiry - noticeMs).toISOString().slice(0, 10);
        const daysToNotice = Math.ceil((expiry - noticeMs - today) / 864e5);
        const daysToExpiry = Math.ceil((expiry - today) / 864e5);
        return {
            ...r,
            noticeDate,
            daysToNotice,
            daysToExpiry,
            /**
             * `noticeDate` is the day the notice WINDOW OPENS, not a deadline —
             * `daysToNotice < 0` only means today is past that opening date,
             * which is exactly when notice is supposed to be given, not when
             * the chance to give it is gone. That window actually closes at
             * expiry: nothing renews or lapses before then.
             *
             * Three states, not two: not yet open (daysToNotice > 0), open
             * (inNoticePeriod — the one that should read as "act now", not as
             * "too late"), and actually closed (noticePassed, once the
             * agreement itself has reached its expiry date with no decision
             * made).
             */
            inNoticePeriod: daysToNotice <= 0 && daysToExpiry > 0,
            noticePassed: daysToExpiry <= 0,
        };
    });
    // `renewable !== 0`, not a plain truthy check: unset means renewable
    // (the field's own default), and an agreement that never had this box
    // touched — every one signed before it existed — must not silently
    // vanish from its own renewal notice.
    if (statusFilter !== 'active') enriched = enriched.filter((r) => r.daysToNotice <= days && r.renewable !== 0);

    enriched.sort((a, b) => a.daysToNotice - b.daysToNotice);
    return {
        windowDays: days,
        statusFilter,
        agreements: enriched,
        inNoticePeriod: enriched.filter((r) => r.inNoticePeriod).length,
        overdue: enriched.filter((r) => r.noticePassed).length,
    };
}
