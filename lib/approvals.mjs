/**
 * Approval tasks.
 *
 * ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────
 *
 * A rep submits a proposal, its status becomes `pending_review`, and then
 * nothing happens — because a status is not a notification. The manager has to
 * already be looking at the proposals list, filtered to pending_review, to
 * discover there is anything to do. In practice they look when the rep asks
 * them to, which makes the workflow a status field plus a conversation.
 *
 * So submitting for review CREATES A TASK, assigned to somebody who can
 * actually approve it. Approval work then lives where every other piece of a
 * manager's work lives — My Work, the task list, the dashboard's task widget —
 * rather than in a screen they have to remember to visit.
 *
 * ── WHO IT GOES TO ──────────────────────────────────────────────────────────
 *
 * Somebody holding `document.approve`, which is manager, admin and owner and
 * is NOT a rep. `approverFor` walks those roles in order of how much of the
 * job is theirs — a manager first, because approving documents is what the
 * role is for, and an owner last, because they are the fallback rather than
 * the intended reviewer. A workspace with nobody who can approve gets no task
 * and no error: the document still submits, and the absence is a staffing fact
 * rather than a failure to save.
 *
 * ── WHY THE TASK IS CLOSED RATHER THAN DELETED ──────────────────────────────
 *
 * Approving or rejecting completes it. The task is the record that somebody was
 * asked and answered, and deleting it would leave "who approved this contract,
 * and when were they asked" answerable only from the audit log.
 */
import { all, get, run, tx, id, now, json } from './db.mjs';
import { audit } from './repo.mjs';
import { notifyApprovalRequested } from './notify.mjs';

/** Roles that may approve, most-appropriate first. */
const APPROVER_ROLES = ['manager', 'admin', 'owner'];

/**
 * How long an approver has before a review task reads as overdue.
 *
 * Was `due_at = now()` at creation — meaning every approval task was
 * overdue the instant it existed, flagged in My Work's "Overdue" stat and
 * highlighted `row-danger` in the Tasks table before anyone had a chance to
 * look at it. Two days is a deliberate, unconfigurable default rather than
 * a setting: this is a review SLA, not a due date anyone chooses per task.
 */
const APPROVAL_DUE_HOURS = 48;

/** The task metadata that makes a task an approval task. */
export function approvalOf(task) {
    const meta = json(task?.properties, {})?.approval;
    return meta && meta.kind ? meta : null;
}

/**
 * Who should review this, or null when nobody in the workspace can.
 *
 * Deliberately not the document's owner: a rep approving their own proposal is
 * the thing the review workflow exists to prevent, and `document.approve` is
 * the capability a rep does not hold.
 */
export function approverFor(ctx, { excludeUserId = null } = {}) {
    return approversFor(ctx, { excludeUserId })[0] ?? null;
}

/**
 * ONE APPROVER PER ROLE — Manager AND Admin both get the task.
 *
 * The old approach picked a single least-loaded person from the first role
 * that had one, so an admin could miss a proposal entirely because a manager
 * happened to have fewer open approvals. Now every approving ROLE contributes
 * its own least-loaded member, and either can complete the task — whichever
 * acts first closes it for both, via closeApprovalTask's shared parent_id.
 */
export function approversFor(ctx, { excludeUserId = null } = {}) {
    const members = all(
        `SELECT u.id, u.name, m.role
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = ? AND u.status = 'active'
          ORDER BY u.name`,
        [ctx.workspaceId],
    ).filter((m) => APPROVER_ROLES.includes(m.role) && m.id !== excludeUserId);

    const chosen = [];
    for (const role of ['manager', 'admin']) {
        const candidates = members.filter((m) => m.role === role);
        if (!candidates.length) continue;
        let best = null;
        let fewest = Infinity;
        for (const candidate of candidates) {
            const open = get(
                `SELECT COUNT(*) AS n FROM tasks
                  WHERE workspace_id = ? AND assignee_id = ? AND deleted_at IS NULL
                    AND status IN ('open','in_progress') AND properties LIKE '%"approval"%'`,
                [ctx.workspaceId, candidate.id],
            ).n;
            if (open < fewest) { fewest = open; best = candidate; }
        }
        if (best && !chosen.some((c) => c.id === best.id)) chosen.push(best);
    }
    // Owner is the fallback when neither role exists yet.
    if (!chosen.length) {
        const owners = members.filter((m) => m.role === 'owner');
        if (owners.length) chosen.push(owners[0]);
    }
    return chosen;
}

/**
 * Raises the approval task for a document that has just gone for review.
 *
 * Idempotent: a document resubmitted after a rejection reuses its open task
 * rather than raising a second one, because it is the same question.
 */
/**
 * Checked and created in ONE transaction, not two separate statements.
 *
 * A document can reach `pending_review` from more than one place — generating
 * it, editing its status directly, uploading a replacement file — and this is
 * the one function all of them funnel through specifically so "does it already
 * have an open task" is asked and answered once. But a plain SELECT-then-INSERT
 * still has a gap: two calls for the same record, close enough together, can
 * both read "nothing yet" before either has written its row, and both go on to
 * create one — the account ends up with two open copies of the same question,
 * and approving one leaves the other looking like a second, separate ask.
 * Wrapping the check and the whole per-approver write in one `tx()` closes
 * that window — SQLite serializes writers, so a second call's read cannot run
 * until the first call's write has committed.
 */
export function openApprovalTask(ctx, kind, record, { submittedBy = null } = {}) {
    if (!record?.id) return null;
    return tx(() => openApprovalTaskLocked(ctx, kind, record, { submittedBy }));
}

function openApprovalTaskLocked(ctx, kind, record, { submittedBy = null } = {}) {
    const existing = get(
        `SELECT * FROM tasks
          WHERE workspace_id = ? AND parent_type = ? AND parent_id = ?
            AND deleted_at IS NULL AND status IN ('open','in_progress')
            AND properties LIKE '%"approval"%'`,
        [ctx.workspaceId, kind, record.id],
    );
    if (existing) return existing;

    // One task per approving ROLE: Manager AND Admin each get their own copy.
    const approvers = approversFor(ctx, { excludeUserId: submittedBy ?? ctx.userId ?? null });
    if (!approvers.length) return null;

    const account = record.account_id
        ? get('SELECT name FROM accounts WHERE id = ?', [record.account_id])
        : null;
    const isPrice = kind === 'deal_price';
    // A rep's Apollo reveal request — see `people_enrich_requests` in
    // schema.sql and requestEnrich/reviewEnrichRequest in
    // api/people-search.mjs. Unlike the other three kinds this one has no
    // `number` or `contract_value` — it names a count of people and which
    // fields (email/phone) were asked for instead.
    const isPeopleEnrich = kind === 'people_enrich';
    // A rep or SDR's ask to hand a contact to somebody else — see
    // `contact_reassign_requests` in schema.sql and
    // requestReassign/reviewReassignRequest in api/calling.mjs. Like
    // people_enrich, this has no `number`/`contract_value` of its own; it
    // names the contact and who it should go to instead.
    const isReassign = kind === 'contact_reassign';
    const submitter = get('SELECT name FROM users WHERE id = ?', [submittedBy ?? ctx.userId ?? ''])?.name ?? 'a colleague';
    const value = Number(record.contract_value) > 0
        ? `${record.currency ?? ''} ${Number(record.contract_value).toLocaleString()}`.trim()
        : null;
    const stamp = now();
    const dueAt = new Date(Date.parse(stamp) + APPROVAL_DUE_HOURS * 3600e3).toISOString();
    const label = isPrice ? 'price change' : kind === 'agreement' ? 'agreement'
        : isPeopleEnrich ? 'contact reveal' : isReassign ? 'reassignment' : 'proposal';

    const title = isPrice
        ? `Approve a price change — ${record.number ?? 'a deal'}`
        : isPeopleEnrich
            ? `Approve a contact reveal${account?.name ? ` — ${account.name}` : ''}`
            : isReassign
                ? `Approve reassigning ${record.contact_name ?? 'a contact'}`
                : `Approve ${label} ${record.number ?? ''}`.trim()
                    + (account?.name ? ` — ${account.name}` : '');
    const peopleCount = isPeopleEnrich ? (Number(record.people_count) || 0) : 0;
    const description = [
        isPrice
            ? `${submitter} proposed a new price for ${record.number ?? 'a deal'}`
              + (account?.name ? ` at ${account.name}` : '') + '.'
            : isPeopleEnrich
                ? `${submitter} asked to reveal ${record.fields_label ?? 'contact info'} for `
                  + `${peopleCount} ${peopleCount === 1 ? 'person' : 'people'}`
                  + (account?.name ? ` at ${account.name}` : '') + '.'
                : isReassign
                    ? `${submitter} asked to reassign ${record.contact_name ?? 'a contact'} to `
                      + `${record.requested_to_name ?? 'someone else'}`
                      + (account?.name ? ` at ${account.name}` : '') + '.'
                    : `${submitter} submitted this ${label} for approval`
                      + (account?.name ? ` for ${account.name}` : '') + '.',
        value ? `${isPrice ? 'Proposed' : 'Value'}: ${value}.` : null,
        `Submitted ${stamp.slice(0, 10)}.`,
        isPrice
            ? 'Until it is approved the deal keeps the price it had. Open the deal to approve or reject it; '
              + 'a rejection needs a reason, so the person who proposed it knows what to change.'
            : isPeopleEnrich
                ? 'Approving spends Apollo credits immediately. Open the account to approve or reject; '
                  + 'a rejection needs a reason, so the person who asked knows why.'
                : isReassign
                    ? 'Until it is approved the contact stays with its current owner. Open the contact to '
                      + 'approve or reject; a rejection needs a reason, so the person who asked knows why.'
                    : `Open the ${label} and approve or reject it. A rejection needs a reason — the author has to know what to change.`,
    ].filter(Boolean).join(' ');

    const created = [];
    for (const approver of approvers) {
        const taskId = id('tsk');
        run(
            `INSERT INTO tasks
               (id, workspace_id, parent_type, parent_id, account_id, title, description,
                assignee_id, due_at, priority, status, properties, created_by, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,'A','open',?,?,?,?)`,
            [
                taskId, ctx.workspaceId, kind, record.id, record.account_id ?? null,
                title, description,
                approver.id,
                dueAt,
                JSON.stringify({
                    approval: {
                        kind, record_id: record.id, number: record.number ?? null,
                        submitted_by: submittedBy ?? ctx.userId ?? null, submitted_at: stamp,
                        value: value ?? null,
                        // contact_reassign only — `record.id` above is the
                        // REQUEST's id, not the contact's, so the worklist
                        // (my-work.js) needs this to link to the contact.
                        contact_id: isReassign ? record.contact_id : undefined,
                    },
                }),
                ctx.userId ?? null, stamp, stamp,
            ],
        );

        audit(ctx, {
            objectKey: kind, recordId: record.id, accountId: record.account_id ?? null,
            action: 'approval_requested', source: 'automation',
            after: { assignedTo: approver.name, role: approver.role, taskId },
        });

        notifyApprovalRequested(ctx, {
            approverId: approver.id,
            label: label.charAt(0).toUpperCase() + label.slice(1),
            number: record.number ?? null,
            value,
            submittedBy: submitter,
            // people_enrich and contact_reassign have no page of their own —
            // the approval lives on the record it was requested about.
            link: isPeopleEnrich ? `/accounts/${record.account_id}`
                : isReassign ? `/contacts/${record.contact_id}`
                : `/${kind}s/${record.id}`,
        });

        created.push(taskId);
    }

    // Return the first so callers have a handle; all copies share the same fate.
    return created.length ? get('SELECT * FROM tasks WHERE id = ?', [created[0]]) : null;
}

/**
 * The reviewer has answered, so the task is done.
 *
 * Completed rather than deleted, and stamped with what was decided, so the task
 * list reads as a record of decisions rather than as a queue that empties.
 */
export function closeApprovalTask(ctx, kind, recordId, decision) {
    // Close ALL copies: Manager and Admin each hold their own, and whichever
    // decides first settles it for both.
    const tasks = all(
        `SELECT * FROM tasks
          WHERE workspace_id = ? AND parent_type = ? AND parent_id = ?
            AND deleted_at IS NULL AND status IN ('open','in_progress')
            AND properties LIKE '%"approval"%'`,
        [ctx.workspaceId, kind, recordId],
    );
    if (!tasks.length) return null;

    const stamp = now();
    for (const task of tasks) {
        const properties = json(task.properties, {});
        properties.approval = {
            ...properties.approval,
            decision,
            decided_by: ctx.userId ?? null,
            decided_at: stamp,
        };
        run(
            `UPDATE tasks SET status = 'done', completed_at = ?, properties = ?, updated_at = ? WHERE id = ?`,
            [stamp, JSON.stringify(properties), stamp, task.id],
        );
    }
    return { closed: tasks.length };
}
