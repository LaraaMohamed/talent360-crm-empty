/**
 * The due-reminder sweep: a task, follow-up or meeting gets exactly one
 * notification the moment it actually comes due — not when it was created
 * (that is `notifyTaskAssigned`'s job, fired once, immediately, which for
 * something scheduled days or weeks out is not the moment anyone needs to
 * act), and not again on every later sweep tick just because it is still
 * open.
 *
 * ── WHY THIS FILE, AND NOT A REQUEST HANDLER ────────────────────────────────
 *
 * Same reasoning as lib/renewals.mjs: the whole point is that it runs
 * whether or not anyone has the CRM open. server.mjs wires
 * `sweepAllWorkspaces` into the same kind of `setInterval` the renewal sweep
 * and the Smartlead sync already use.
 *
 * ── THE MARKER ───────────────────────────────────────────────────────────────
 *
 * `tasks.reminder_sent_at` / `activities.meeting_reminder_sent_at` — set the
 * first time a reminder fires for THIS due date. A follow-up task's own
 * `properties.follow_up` step already covers "what happens when it is
 * completed" (lib/follow-up.mjs); this only covers "who gets told it is due"
 * — every open task with a due date qualifies, whether it is a plain task, a
 * follow-up step (call or WhatsApp), or a renewal notice.
 */
import { all, run, now } from './db.mjs';
import { notifyTaskDue, notifyMeetingDue } from './notify.mjs';

/**
 * One workspace's sweep: every open, assigned, due task and every scheduled
 * meeting whose start time has arrived gets exactly one notification.
 */
export function sweepReminders(workspaceId) {
    const ctx = { workspaceId, userId: null };
    const stamp = now();
    let tasksReminded = 0;
    let meetingsReminded = 0;

    const dueTasks = all(
        `SELECT t.id, t.title, t.assignee_id, t.account_id, a.name AS account_name
           FROM tasks t
      LEFT JOIN accounts a ON a.id = t.account_id
          WHERE t.workspace_id = ? AND t.deleted_at IS NULL
            AND t.status IN ('open','in_progress')
            AND t.assignee_id IS NOT NULL
            AND t.due_at IS NOT NULL AND t.due_at <= ?
            AND t.reminder_sent_at IS NULL`,
        [workspaceId, stamp],
    );
    for (const task of dueTasks) {
        notifyTaskDue(ctx, {
            assigneeId: task.assignee_id, taskId: task.id, subject: task.title, accountName: task.account_name,
        });
        run('UPDATE tasks SET reminder_sent_at = ? WHERE id = ?', [stamp, task.id]);
        tasksReminded += 1;
    }

    // Whoever's queue the contact is on, falling back to whoever logged the
    // call — the same person a meeting counts FOR everywhere else in this
    // product. See the comment on this exact COALESCE in lib/meetings.mjs.
    const dueMeetings = all(
        `SELECT act.id, act.parent_id, act.meeting_at, c.full_name AS contact_name,
                COALESCE(asg.assigned_to, act.actor_id) AS owner_id, acc.name AS account_name
           FROM activities act
           JOIN contacts c ON c.id = act.parent_id AND act.parent_type = 'contact'
      LEFT JOIN accounts acc ON acc.id = c.account_id
      LEFT JOIN calling_assignments asg ON asg.id = act.assignment_id
          WHERE act.workspace_id = ? AND act.deleted_at IS NULL
            AND act.meeting_status = 'scheduled'
            AND act.meeting_at IS NOT NULL AND act.meeting_at <= ?
            AND act.meeting_reminder_sent_at IS NULL`,
        [workspaceId, stamp],
    );
    for (const meeting of dueMeetings) {
        notifyMeetingDue(ctx, {
            ownerId: meeting.owner_id, contactName: meeting.contact_name, accountName: meeting.account_name,
            link: `/contacts/${meeting.parent_id}`,
        });
        run('UPDATE activities SET meeting_reminder_sent_at = ? WHERE id = ?', [stamp, meeting.id]);
        meetingsReminded += 1;
    }

    return { workspaceId, tasksReminded, meetingsReminded };
}

export function sweepAllWorkspaces() {
    const workspaces = all('SELECT id FROM workspaces');
    return workspaces.map((w) => sweepReminders(w.id));
}
