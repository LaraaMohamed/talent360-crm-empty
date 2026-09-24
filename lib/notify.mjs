/**
 * Writes the few notifications that matter.
 *
 * ── WHY SO FEW ──────────────────────────────────────────────────────────────
 *
 * A notification is a demand on somebody's attention, and a system that emits
 * one for every audit event is a system whose bell is ignored by Wednesday.
 * These are the events the state-of-play doc named as worth telling a person
 * about, each written from the place that already owns the action:
 *
 *   - ASSIGNED A TASK        you have work
 *   - APPROVAL REQUESTED     somebody is waiting on your decision
 *   - PRICE CHANGE PROPOSED  a rep re-quoted; a manager must agree
 *   - DEAL WON / LOST        your deal moved to its end
 *   - LEAD DEAD              your calling lead ran out of road
 *   - AGREEMENT NOTICE DATE  the renewal decision is due
 *
 * Deliberately NOT an audit-event mirror — that is exactly the mistake
 * `timeline_projections` exists to avoid. Each function is called from the one
 * handler that owns the action, so there is exactly one place per event kind.
 *
 * Every writer is best-effort: a notification failure must never fail the
 * action it accompanies, so each swallows its own errors.
 */
import { run, id, now } from './db.mjs';

function write(ctx, userId, { kind, title, body = null, link = null, allowSelf = false }) {
    if (!userId || (!allowSelf && String(userId) === String(ctx?.userId))) return;
    try {
        run(
            `INSERT INTO notifications (id, workspace_id, user_id, kind, title, body, link, created_at)
             VALUES (?,?,?,?,?,?,?,?)`,
            [id('ntf'), ctx.workspaceId, userId, kind, title, body, link, now()],
        );
    } catch {
        // Best-effort by design: the action succeeded; the bell is secondary.
    }
}

/**
 * You were given a task. Called from task creation with the assignee.
 *
 * Deep-links to the exact task by default (`/tasks/${taskId}`) — the record
 * page for that one row, not the whole list. A caller whose task is really
 * about something else the assignee should land on instead (a follow-up
 * task tied to a calling lead, say) passes its own `link` to override it.
 */
export function notifyTaskAssigned(ctx, { assigneeId, taskId, subject, accountName = null, link = null }) {
    if (!assigneeId) return;
    write(ctx, assigneeId, {
        kind: 'task_assigned',
        title: `New task: ${subject}`,
        body: accountName ? `On ${accountName}.` : null,
        link: link ?? (taskId ? `/tasks/${taskId}` : '/my-work'),
    });
}

/**
 * A task's own due date has arrived. Fired once per task by the reminder
 * sweep (lib/reminders.mjs), never re-sent — see tasks.reminder_sent_at.
 * Deliberately separate from `notifyTaskAssigned`: that one fires the moment
 * work lands, which for a follow-up scheduled a week out is not the moment
 * anyone needs to act on it; this is.
 */
export function notifyTaskDue(ctx, { assigneeId, taskId = null, subject, accountName = null, link = null }) {
    if (!assigneeId) return;
    write(ctx, assigneeId, {
        kind: 'task_due',
        title: `Due now: ${subject}`,
        body: accountName ? `On ${accountName}.` : null,
        link: link ?? (taskId ? `/tasks/${taskId}` : '/my-work'),
    });
}

/** A booked meeting's own start time has arrived. Fired once per meeting. */
export function notifyMeetingDue(ctx, { ownerId, contactName = null, accountName = null, link = '/' }) {
    if (!ownerId) return;
    const who = contactName ?? accountName ?? 'your contact';
    write(ctx, ownerId, {
        kind: 'meeting_due',
        title: `Meeting now: ${who}`,
        body: accountName && contactName ? `${accountName}.` : null,
        link,
    });
}

/** An approval is waiting on you (proposal, agreement or price change). */
export function notifyApprovalRequested(ctx, { approverId, label, number = null, value = null, submittedBy = null, link = '/' }) {
    if (!approverId) return;
    const who = submittedBy ? ` Submitted by ${submittedBy}.` : '';
    write(ctx, approverId, {
        kind: 'approval_requested',
        title: `${label} awaiting approval${number ? ` (${number})` : ''}`,
        body: value ? `${value}.${who}` : who.trim() || null,
        link,
    });
}

/**
 * YOUR SUBMISSION WAS REVIEWED — the answer and why.
 *
 * The author submitted and waited; the decision and the reviewer's note are
 * exactly what they come back for. A rejection carries its reason (the review
 * requires one); an approval may carry a note too.
 */
export function notifyApprovalDecision(ctx, { authorId, label, decision, number = null, note = null, reviewedBy = null, link = '/' }) {
    if (!authorId) return;
    const decided = decision === 'approved' ? 'approved' : 'rejected';
    const by = reviewedBy ? ` by ${reviewedBy}` : '';
    write(ctx, authorId, {
        kind: 'approval_decision',
        title: `${label} ${decided}${number ? ` (${number})` : ''}${by}`,
        body: note ? `Reviewer's note: ${note}` : null,
        link,
    });
}

/** Your price change was approved or rejected. */
export function notifyPriceDecision(ctx, { proposedById, dealId, decision, reviewNote = null }) {
    if (!proposedById) return;
    write(ctx, proposedById, {
        kind: 'price_decision',
        title: `Price change ${decision}`,
        body: reviewNote ?? null,
        link: `/deals/${dealId}`,
    });
}

/** Your lead was retired by the rules. */
export function notifyLeadDead(ctx, { ownerId, contactId, reason }) {
    if (!ownerId) return;
    write(ctx, ownerId, {
        kind: 'lead_dead',
        title: 'A lead was marked dead',
        body: reason,
        link: `/contacts/${contactId}`,
    });
}

/**
 * Contacts landed on your calling queue.
 *
 * One bell per BATCH, not per contact — a 50-contact assignment is one piece
 * of news, and fifty notifications is how a bell gets ignored by Wednesday.
 *
 * `link` is the caller's job to compute (see `assignContacts` in
 * lib/calling.mjs): a single lead deep-links straight into the console via
 * `?open=<assignmentId>`, a batch deep-links into the queue pre-filtered to
 * exactly those rows. Falls back to the bare module when a caller has
 * nothing more specific — best-effort callers that skip it entirely.
 */
export function notifyQueueAssigned(ctx, { userId, count, priority = null, link = '/calling' }) {
    if (!userId || !count) return;
    write(ctx, userId, {
        kind: 'task_assigned',
        title: `${count} ${count === 1 ? 'contact was' : 'contacts were'} added to your calling queue`,
        body: priority ? `Priority ${priority}.` : null,
        link,
    });
}

/** An agreement has reached its renewal notice window. */
export function notifyAgreementRenewalDue(ctx, { ownerId, agreementId, accountName, number, expiryLabel, valueLabel = null }) {
    if (!ownerId) return;
    write(ctx, ownerId, {
        kind: 'renewal_due',
        title: `${accountName} — ${number} expires ${expiryLabel}`,
        body: valueLabel ? `Renewal notice reached. ${valueLabel}.` : 'Renewal notice reached.',
        link: `/agreements/${agreementId}`,
    });
}

/**
 * A meeting was booked from a call — here is the task that says so.
 *
 * `allowSelf: true` — the one exception to "nobody gets a bell for their own
 * action". An SDR booking their own meeting still wants the confirmation
 * that it is on the record, the same way the calling console itself confirms
 * every other outcome; the silence otherwise reads as "did that actually
 * save?" for the one outcome that creates a task with nothing else on
 * screen to say so.
 */
export function notifyMeetingScheduled(ctx, { assigneeId, taskId, contactId, who = null, whenLabel = null }) {
    if (!assigneeId) return;
    write(ctx, assigneeId, {
        kind: 'task_assigned',
        title: `Meeting scheduled${who ? ` with ${who}` : ''}`,
        body: whenLabel ?? null,
        link: contactId ? `/contacts/${contactId}` : '/my-work',
        allowSelf: true,
    });
}
