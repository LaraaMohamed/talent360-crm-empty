/**
 * EmailAutomationService — what fires the moment an agreement is signed.
 *
 * Exactly four things, every time, and never twice for the same signature:
 *
 *   1. The Internal Team Proposal is generated (or found, if it already was).
 *   2. A Finance notification is queued, with the signed agreement and the
 *      client proposal attached.
 *   3. An Internal Team notification is queued, with the Internal Team
 *      Proposal attached — never the priced client documents.
 *   4. Each queued email leaves an Activity on the agreement's timeline.
 *
 * ── IDEMPOTENCY ──────────────────────────────────────────────────────────────
 *
 * `email_messages.trigger_event_key` carries a UNIQUE index
 * (`workspace_id, trigger_event_key`, schema.sql). `agreement_signed:{id}:
 * finance` and `agreement_signed:{id}:internal` can each exist at most once,
 * ever, for a given agreement — a second call to `handleAgreementSigned` for
 * the same agreement (a retried webhook, a double click before this session
 * added the up-front `status === 'signed'` guard in `signAgreement`) hits
 * the unique constraint on the second insert attempt and is treated as
 * "already handled", not as an error. The Internal Team Proposal itself is
 * idempotent the same way, one level down, in `ensureInternalTeamProposal`.
 *
 * ── WHY THIS RUNS OUTSIDE THE SIGNING TRANSACTION ───────────────────────────
 *
 * `signAgreement` already calls `ensureInternalTeamProposal` in its own
 * try/catch AFTER the signing transaction commits — a proposal-generation
 * failure must never undo a real signature. This function is called from
 * that same place, for the same reason, and makes its own two email drafts
 * exactly as tolerant: one failing does not take down the other, and neither
 * takes down the fact that the agreement is signed.
 */
import { get } from './db.mjs';
import { ensureInternalTeamProposal } from './internal-proposal.mjs';
import { buildDraft, getDraft, logEmailActivity } from './email-drafts.mjs';

/**
 * Was this trigger already handled? Checked up front so a repeat call skips
 * straight past the work — the unique index is the real guarantee; this is
 * the fast, readable path to the same answer.
 */
function alreadyTriggered(ctx, triggerEventKey) {
    return !!get(
        'SELECT id FROM email_messages WHERE workspace_id = ? AND trigger_event_key = ?',
        [ctx.workspaceId, triggerEventKey],
    );
}

/** One category's automated email: build it queued, log it, attempt delivery, and swallow a race against an identical concurrent call. */
async function raiseAutomatedEmail(ctx, { category, agreementId, ccSetting, triggerEventKey }) {
    if (alreadyTriggered(ctx, triggerEventKey)) return { skipped: true, reason: 'already queued for this agreement' };
    try {
        const draft = buildDraft(ctx, {
            category, agreementId, source: 'automation', triggerEventKey, ccSetting, initialStatus: 'queued',
        });
        logEmailActivity(ctx, draft);
        // Best-effort — a relay that is not configured, or a send that
        // fails, must never undo the fact that the agreement is signed or
        // that the Internal Team Proposal exists. deliverMessage already
        // never throws; this catch is only for something deliverMessage
        // itself did not anticipate.
        const { deliverMessage } = await import('./email-delivery.mjs');
        await deliverMessage(ctx, draft).catch(() => {});
        // Re-read: deliverMessage updates status/error/sent_at on the row,
        // and the caller (the automation's own outcome, and its audit entry
        // on partial failure) needs the delivered state, not the moment
        // before delivery was attempted.
        return { skipped: false, draft: getDraft(ctx, draft.id) };
    } catch (err) {
        // A UNIQUE constraint violation means a concurrent call won the race
        // between the check above and this insert — genuinely handled, not
        // a failure. Anything else is a real problem and is re-thrown so the
        // caller's own try/catch (signAgreement) can log it without masking
        // it as "fine".
        if (String(err.message ?? err).toLowerCase().includes('unique')) {
            return { skipped: true, reason: 'already queued (race)' };
        }
        throw err;
    }
}

/**
 * Call once, right after an agreement's status becomes 'signed' — the same
 * place and the same non-transactional tolerance as
 * `ensureInternalTeamProposal` already gets in `signAgreement`.
 */
export async function handleAgreementSigned(ctx, agreement) {
    const results = { internalProposal: null, finance: null, internalTeam: null };

    try {
        results.internalProposal = ensureInternalTeamProposal(ctx, agreement);
    } catch (err) {
        results.internalProposal = { error: err.message };
    }

    try {
        results.finance = await raiseAutomatedEmail(ctx, {
            category: 'agreement_signed_finance', agreementId: agreement.id,
            ccSetting: 'finance_notification_recipients',
            triggerEventKey: `agreement_signed:${agreement.id}:finance`,
        });
    } catch (err) {
        results.finance = { error: err.message };
    }

    try {
        // The Internal Team email attaches the Internal Team Proposal
        // resolved above — raised first on purpose, so this attachment
        // resolution has something to find rather than reporting it missing
        // on the very signature that was meant to create it.
        results.internalTeam = await raiseAutomatedEmail(ctx, {
            category: 'agreement_signed_internal', agreementId: agreement.id,
            ccSetting: 'internal_team_notification_recipients',
            triggerEventKey: `agreement_signed:${agreement.id}:internal`,
        });
    } catch (err) {
        results.internalTeam = { error: err.message };
    }

    return results;
}
