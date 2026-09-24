/**
 * The Internal Team Proposal — automatically raised when an Agreement is
 * signed.
 *
 * ── THE RULE, IN FULL ───────────────────────────────────────────────────────
 *
 * Signing an agreement means the deal is closing on real, agreed terms. The
 * team that delivers it — not the client — needs the same scope, the same
 * service detail, the same client facts the commercial proposal carried,
 * with NONE of the commercial figures: price is a negotiation between the
 * company and the client, not something every internal reader needs in
 * front of them to do the work.
 *
 * ── WHY THIS IS A SEPARATE MODULE AND NOT MORE CODE IN signAgreement ────────
 *
 * `api/proposals.mjs` already owns signing, review, and both flavours of
 * proposal generation. This function is call-and-forget from there — one
 * line, wrapped so a failure here can never take a successful signature
 * down with it (see `ensureInternalTeamProposal`'s own doc comment) — and
 * everything it needs to reuse (the docx generator) is imported from
 * `lib/`, never from `api/`: this is business logic, and business logic
 * does not import the HTTP layer.
 *
 * ── EVERY PRICE-BEARING FIELD IS REDACTED, EXPLICITLY, IN ONE PLACE ─────────
 *
 * Two proposal shapes exist in this CRM — written from a `.docx` template,
 * or built from a deal's line items — and each has its OWN redaction path
 * here, because each carries price in a different shape:
 *
 *   docx path        `generate(..., redactMoney: true)` blanks every
 *                     placeholder `docType.variables` marks `money: true`,
 *                     AFTER validation has run against the real figures —
 *                     see lib/doc-generation.mjs.
 *   line-item path    `redactedContent()` below strips `unit_amount`,
 *                     `derived` and `totals` from a clone of the source
 *                     version's own frozen content, then `renderInternal`
 *                     below renders a table with no Price or Amount column
 *                     at all — not a blanked one.
 *
 * Neither path can silently inherit a number through a shared variable: the
 * docx path never sees the real placeholders, and the line-item path never
 * builds a row that has a price cell to leave empty.
 */
import { get, run, id, now, json } from './db.mjs';
import { getRecord, audit, nextDocumentNumber, insert, update } from './repo.mjs';
import { generate } from './doc-generation.mjs';
import { billingTypeLabel } from './money.mjs';

/**
 * Every price-bearing key a line-item's frozen `content` can carry, gone.
 *
 * `items[].derived` and `items[].unit_amount` are what the ordinary renderer
 * reads to print a Price/Amount column; `totals` is the one-time/MRR/ARR
 * summary. Wiping both, rather than trusting the internal renderer alone not
 * to read them, means a future change to that renderer cannot resurrect a
 * price by accident — the data it would need is not there to read.
 */
function redactedContent(source) {
    const clone = JSON.parse(JSON.stringify(source ?? {}));
    clone.title = 'Internal Team Proposal';
    clone.items = (clone.items ?? []).map((item) => {
        const { unit_amount, derived, percent_rate, basis_amount, ...rest } = item;
        return rest;
    });
    delete clone.totals;
    delete clone.currency;
    return clone;
}

/**
 * The line-item proposal's document, with every commercial figure omitted
 * by construction — an Item/Billing table, never an Item/Billing/Price/
 * Amount one with the last two columns left blank.
 */
function renderInternal(content) {
    const c = content ?? {};
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));

    const rows = (c.items ?? []).map((item) => `<tr>
            <td dir="auto">${esc(item.label)}</td>
            <td>${esc(billingTypeLabel(item.billing_type))}</td>
        </tr>`).join('');

    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Internal Team Proposal</title>
<style>
  :root { color-scheme: light; }
  body { font: 14px/1.6 -apple-system, "Segoe UI", Roboto, sans-serif; color: #16191d; max-width: 46rem; margin: 0 auto; padding: 3rem 1.5rem 5rem; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; letter-spacing: -.02em; }
  .meta { color: #667085; margin-bottom: 2.5rem; }
  table { width: 100%; border-collapse: collapse; margin: 1.5rem 0; }
  th, td { text-align: start; padding: .6rem .5rem; border-block-end: 1px solid #e3e6ea; }
  th { font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; color: #667085; }
  .note { margin-top: 2rem; padding: .9rem 1rem; background: #f6f7f9; border-radius: 8px; color: #475467; font-size: .9rem; }
  footer { margin-top: 3rem; color: #667085; font-size: .85rem; }
  @media print { body { padding: 0; } }
</style></head><body>
<h1 dir="auto">Internal Team Proposal</h1>
<p class="meta" dir="auto">
  Prepared for <strong>${esc(c.account?.name)}</strong>${c.account?.legalName ? ` <span dir="auto">(${esc(c.account.legalName)})</span>` : ''}<br>
  ${c.account?.crNumber ? `CR ${esc(c.account.crNumber)} &middot; ` : ''}Service scope as of ${esc(String(c.preparedAt ?? '').slice(0, 10))}
</p>
${c.intro ? `<p dir="auto">${esc(c.intro)}</p>` : ''}
<table>
  <thead><tr><th>Item</th><th>Billing</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<div class="note">
  This is the internal working copy of the proposal for ${esc(c.account?.name)}, generated automatically once the
  agreement was signed. It carries the same scope and service detail as the customer-facing proposal —
  commercial pricing is intentionally not shown here.
</div>
<p dir="auto">${esc(c.terms)}</p>
<footer>Internal Team Proposal &middot; ${esc(String(c.preparedAt ?? '').slice(0, 10))}</footer>
</body></html>`;
}

/**
 * The proposal the signed agreement's own commercial terms actually came
 * from — the authoritative relationship the requirement asks for, checked
 * in the order it names.
 *
 *   1. `agreement_proposals` — the explicit join this agreement was CREATED
 *      from (see `linkGeneratedRecord` / `createProposal`'s "created from a
 *      proposal" path). This is the one the agreement itself stores.
 *   2. Failing that, the deal's own most recently created proposal — an
 *      agreement can exist with no recorded proposal (an inbound deal that
 *      skipped one), and the deal is still the correct scope to search.
 *
 * Never "any proposal on the account" — a client with two deals must not
 * have one deal's agreement pick up the other's proposal.
 */
export function resolveSourceProposal(ctx, agreement) {
    const viaJoin = get(
        `SELECT p.* FROM agreement_proposals ap
           JOIN proposal_versions pv ON pv.id = ap.proposal_version_id
           JOIN proposals p ON p.id = pv.proposal_id
          WHERE ap.agreement_id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL
          ORDER BY pv.created_at DESC LIMIT 1`,
        [agreement.id, ctx.workspaceId],
    );
    if (viaJoin) return viaJoin;

    if (!agreement.deal_id) return null;
    return get(
        `SELECT * FROM proposals
          WHERE deal_id = ? AND workspace_id = ? AND deleted_at IS NULL AND type = 'standard'
          ORDER BY created_at DESC LIMIT 1`,
        [agreement.deal_id, ctx.workspaceId],
    );
}

/**
 * Builds the Internal Team Proposal from the docx-templated source, through
 * the SAME `generate()` every other document in this CRM goes through.
 *
 * The real, unredacted `fields` and `services` a generation used are read
 * back from `document_generations` — the row `generate()` itself writes
 * every time — rather than re-derived, so the internal document reflects
 * EXACTLY what the signed agreement's own source proposal was generated
 * with, never a second, possibly-drifted guess at the same facts.
 */
function fromDocxSource(ctx, { source, agreement, deal }) {
    const generation = get(
        `SELECT * FROM document_generations
          WHERE workspace_id = ? AND document_id = ?
          ORDER BY created_at DESC LIMIT 1`,
        [ctx.workspaceId, source.document_id],
    );
    if (!generation) return null;

    const result = generate(ctx, {
        accountId: source.account_id,
        dealId: deal?.id ?? source.deal_id ?? null,
        docTypeKey: source.document_type,
        fields: json(generation.fields, {}),
        services: json(generation.services, []),
        redactMoney: true,
        recordOverrides: {
            title: 'Internal Team Proposal',
            status: 'issued',
            type: 'internal_team',
            sourceProposalId: source.id,
            sourceAgreementId: agreement.id,
        },
    });
    return result.record ? getRecord('proposal', ctx, result.record.id) : null;
}

/**
 * Builds the Internal Team Proposal from a line-item source — no template,
 * so this writes the `proposals` / `proposal_versions` rows directly, the
 * same shape `createVersion` (api/proposals.mjs) writes for an ordinary
 * next version, minus every price field and rendered through
 * `renderInternal` instead of the customer-facing renderer.
 */
function fromLineItemSource(ctx, { source, agreement, deal }) {
    const latest = get(
        'SELECT * FROM proposal_versions WHERE proposal_id = ? ORDER BY version DESC LIMIT 1',
        [source.id],
    );
    if (!latest) return null;

    const content = redactedContent(json(latest.content, {}));
    const proposalId = id('pro');
    const versionId = id('pvr');
    const number = nextDocumentNumber(ctx, 'proposals', 'P');
    const stamp = now();

    run(
        `INSERT INTO proposals
           (id, workspace_id, deal_id, account_id, number, title, currency, status,
            current_version, owner_id, type, source_proposal_id, source_agreement_id,
            created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
            proposalId, ctx.workspaceId, deal?.id ?? source.deal_id ?? null, source.account_id,
            number, 'Internal Team Proposal', source.currency, 'issued',
            1, ctx.userId ?? null, 'internal_team', source.id, agreement.id,
            stamp, stamp,
        ],
    );
    const renderedHtml = renderInternal(content);
    run(
        `INSERT INTO proposal_versions
           (id, workspace_id, proposal_id, version, status, valid_until,
            content, rendered_html, total_one_time, total_mrr, term_months, created_by, created_at)
         VALUES (?,?,?,1,'issued',?,?,?,0,0,?,?,?)`,
        [
            versionId, ctx.workspaceId, proposalId, content.validUntil ?? null,
            JSON.stringify(content), renderedHtml,
            latest.term_months ?? null, ctx.userId ?? null, stamp,
        ],
    );

    /**
     * A DOCUMENT, same as any other proposal reaching `issued` — see
     * `issueVersion` in api/proposals.mjs, whose shape this mirrors exactly.
     * Without this row a line-item-sourced Internal Team Proposal existed
     * only in the `proposals` table: correctly redacted, correctly linked
     * to the agreement, and invisible on the account/deal's Documents tab,
     * which reads `document_generations` — the docx-templated path already
     * gets one for free from `generate()` (see `fromDocxSource`), so only
     * this path needed it added by hand.
     */
    const documentId = id('doc');
    insert('documents', {
        id: documentId, workspace_id: ctx.workspaceId, parent_type: 'proposal', parent_id: proposalId,
        account_id: source.account_id, name: `${number} — Internal Team Proposal.html`,
        kind: 'proposal', mime: 'text/html', size_bytes: renderedHtml.length,
        storage_key: `proposal:${versionId}`, uploaded_by: ctx.userId ?? null, created_at: stamp,
    });
    insert('document_generations', {
        id: id('dgn'), workspace_id: ctx.workspaceId, account_id: source.account_id,
        deal_id: deal?.id ?? source.deal_id ?? null, document_type: 'INTERNAL_TEAM_PROPOSAL',
        version: 1, document_id: documentId, fields: '{}', placeholders: '{}', services: '[]',
        status: 'generated', generated_by: ctx.userId ?? null, created_at: stamp,
    });
    /**
     * Without this, the document above exists — findable on the Documents
     * tab, per the comment ahead of it — but invisible to anything that asks
     * "what is THIS proposal's document", `documentFor` in
     * lib/email-attachments.mjs among them. That is exactly the path the
     * automated Internal Team notification email uses to find its
     * attachment, so skipping this line left that email queued with nothing
     * attached and no error either — the one silent way this whole feature
     * could look finished and still hand the internal team an empty
     * envelope.
     */
    update('proposals', proposalId, { document_id: documentId });

    return getRecord('proposal', ctx, proposalId);
}

/**
 * The entry point. Idempotent: safe to call every time an agreement reaches
 * `signed`, however many times that happens, and safe to call again after a
 * failed attempt — nothing here assumes it is the first try.
 *
 * ── FAILURE DOES NOT UNDO THE SIGNATURE ─────────────────────────────────────
 *
 * The caller (`signAgreement`) invokes this AFTER its own transaction has
 * already committed, in its own try/catch — a contract that has been signed
 * is signed whether or not this succeeds. A failure is recorded as its own
 * audit event so it is visible, and the next call — another sign attempt on
 * an idempotent path, or a manual retry — tries again rather than the
 * system silently pretending the internal proposal exists.
 */
export function ensureInternalTeamProposal(ctx, agreement) {
    const existing = get(
        `SELECT * FROM proposals
          WHERE workspace_id = ? AND source_agreement_id = ? AND type = 'internal_team' AND deleted_at IS NULL`,
        [ctx.workspaceId, agreement.id],
    );
    if (existing) return existing;

    const source = resolveSourceProposal(ctx, agreement);
    if (!source) {
        audit(ctx, {
            objectKey: 'agreement', recordId: agreement.id, accountId: agreement.account_id,
            action: 'internal_team_proposal_skipped', source: 'automation',
            after: { because: 'no source proposal could be found for this agreement or its deal' },
        });
        return null;
    }

    const deal = agreement.deal_id ? get('SELECT * FROM deals WHERE id = ?', [agreement.deal_id]) : null;

    try {
        const record = source.document_type
            ? fromDocxSource(ctx, { source, agreement, deal })
            : fromLineItemSource(ctx, { source, agreement, deal });

        if (!record) {
            audit(ctx, {
                objectKey: 'agreement', recordId: agreement.id, accountId: agreement.account_id,
                action: 'internal_team_proposal_failed', source: 'automation',
                after: { because: 'the source proposal has no generation/version to build from' },
            });
            return null;
        }

        audit(ctx, {
            objectKey: 'agreement', recordId: agreement.id, accountId: agreement.account_id,
            action: 'internal_team_proposal_created', source: 'automation',
            after: { proposalId: record.id, number: record.number, sourceProposalId: source.id },
        });
        return record;
    } catch (err) {
        // A DB-level race — two requests both passing the idempotency check
        // before either had inserted — surfaces as the partial unique index
        // refusing the second write. That is not a real failure: somebody
        // else's call just won, so this fetches and returns what they
        // created instead of reporting an error for a request that, from
        // the outside, succeeded.
        const raced = get(
            `SELECT * FROM proposals
              WHERE workspace_id = ? AND source_agreement_id = ? AND type = 'internal_team' AND deleted_at IS NULL`,
            [ctx.workspaceId, agreement.id],
        );
        if (raced) return raced;

        audit(ctx, {
            objectKey: 'agreement', recordId: agreement.id, accountId: agreement.account_id,
            action: 'internal_team_proposal_failed', source: 'automation',
            after: { because: String(err?.message ?? err).slice(0, 300) },
        });
        return null;
    }
}
