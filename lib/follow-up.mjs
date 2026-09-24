/**
 * The lead follow-up sequence.
 *
 * ── THE RULE, IN FULL ───────────────────────────────────────────────────────
 *
 * A lead that is followed up gets EXACTLY FOUR activities, in this order, and
 * then it is dead:
 *
 *   1. First Follow-Up     the date and time the rep chose when they logged the
 *                          call — "the fifteenth at half two", to the minute
 *   2. WhatsApp            end of that same day, or the next day if that is past
 *   3. Second Follow-Up    exactly seven days after step 1. Not "about a week"
 *   4. WhatsApp            end of that day, or the next day if that is past
 *
 * After step 4 the lead is DEAD. There is no fifth follow-up, and nothing in
 * this module can produce one: the sequence is written in `STEPS` below, it has
 * four entries, and `startSequence` refuses to run twice on one assignment.
 *
 * ── WHY THE WHOLE SEQUENCE IS SCHEDULED AT ONCE ─────────────────────────────
 *
 * Because "exactly seven days after the first follow-up" is a fact about the
 * FIRST follow-up, and a sequence that schedules each step when the previous
 * one completes cannot honour it — step 3 would land seven days after whenever
 * somebody got round to ticking step 2, which is "about a week" by another
 * name. All four dates are computed from one instant, when the rep sets it.
 *
 * ── WHY TASKS AND NOT A SECOND KIND OF THING ────────────────────────────────
 *
 * Each step IS a task, in the tasks table, assigned to a person, appearing in
 * My Work and in every task list and filter that already exists. A rep should
 * not have to create a task for each follow-up, and a "scheduled activity" that
 * lives somewhere tasks are not is a second inbox to forget about.
 *
 * The task carries `properties.follow_up`, which is what makes a task part of a
 * sequence rather than a note about one: the step, its position, the assignment
 * it belongs to, and the activity type it stands for.
 *
 * ── DEATH IS A FACT, NOT A LABEL ────────────────────────────────────────────
 *
 * Completing step 4 closes the calling assignment, stamps `dead_at`, and logs
 * an activity saying why. The queue stops offering the contact because the row
 * is inactive, not because a screen hides it.
 */
import { all, get, run, tx, id, now, json } from './db.mjs';
import { audit } from './repo.mjs';
import { notifyLeadDead, notifyTaskAssigned } from './notify.mjs';

/** How far apart the two follow-ups are. Seven days, exactly, by definition. */
export const SECOND_FOLLOW_UP_DAYS = 7;

/**
 * How far past a step's due date "due now" still means ring immediately.
 *
 * A minute, not a policy — it exists only so a step scheduled for this same
 * instant is not flapped between "the sweep will announce it" and "announce it
 * here" by millisecond arithmetic.
 */
const DUE_NOW_TOLERANCE_MS = 60_000;

/**
 * The hour a WhatsApp message goes out, in the workspace's timezone.
 *
 * "End of the day" needs a number, and this is it. A workspace that works to
 * different hours changes `follow_up_day_end_hour` in settings; nothing here
 * needs redeploying for it.
 */
export const DEFAULT_DAY_END_HOUR = 17;

/**
 * The hour a follow-up CALL is due when nobody said which hour.
 *
 * A rep who picks a date and no time — "ring me back on the fifteenth" — still
 * needs the step to land on an hour. It used to get midnight UTC, which is 3am
 * in Riyadh and 2am in Cairo: the task list then told a rep their follow-up was
 * due at three in the morning, which is not a time anybody is going to ring a
 * prospect and reads as the software having lost the time rather than never
 * having been given one.
 *
 * The start of the working day is the honest answer to "when on the fifteenth".
 *
 * It is a FALLBACK, not the rule. A follow-up carries a time of day, the console
 * asks for one, and `normalizeFollowUpAt` only reaches for this hour when what
 * arrived was a bare date — an older client, an import, an API caller.
 */
export const DEFAULT_DAY_START_HOUR = 9;

/**
 * The sequence. Four entries, and the length of this array IS the business rule.
 *
 * `offsetDays` is measured from the FIRST follow-up in every case, never from
 * the step before — see the header.
 */
export const STEPS = [
    {
        step: 'first_follow_up',
        position: 1,
        label: 'First follow-up',
        activityType: 'call',
        offsetDays: 0,
        endOfDay: false,
        priority: 'A',
    },
    {
        step: 'whatsapp_1',
        position: 2,
        label: 'WhatsApp after the first follow-up',
        activityType: 'whatsapp',
        offsetDays: 0,
        endOfDay: true,
        priority: 'B',
    },
    {
        step: 'second_follow_up',
        position: 3,
        label: 'Second follow-up',
        activityType: 'call',
        offsetDays: SECOND_FOLLOW_UP_DAYS,
        endOfDay: false,
        priority: 'A',
    },
    {
        step: 'whatsapp_2',
        position: 4,
        label: 'WhatsApp after the second follow-up',
        activityType: 'whatsapp',
        offsetDays: SECOND_FOLLOW_UP_DAYS,
        endOfDay: true,
        priority: 'B',
    },
];

export const SEQUENCE_LENGTH = STEPS.length;

/* ------------------------------------------------------------ scheduling -- */

/**
 * The end of `atIso`'s day in `timezone`, as UTC — or the end of the NEXT day
 * when that instant has already gone.
 *
 * The rule the product states is "same day, at the end of the day; if same-day
 * is no longer possible, the following day". The second half is not a nicety:
 * a rep who logs a follow-up at 6pm would otherwise be handed a WhatsApp task
 * that was due an hour ago, which is a to-do list that lies on the day it is
 * created.
 *
 * Timezone handling is done by asking `Intl` what the wall clock reads at a
 * given instant and correcting, rather than by adding a fixed offset — the
 * offset is not fixed, and the arithmetic that assumes it is breaks twice a
 * year in exactly the countries that observe it.
 */
export function endOfDay(atIso, { timezone = 'UTC', hour = DEFAULT_DAY_END_HOUR, nowIso = null } = {}) {
    const at = new Date(atIso);
    if (Number.isNaN(at.getTime())) return null;

    const current = new Date(nowIso ?? now());
    let candidate = atInstant(at, timezone, hour);

    // Already gone: the same day is no longer possible, so it is tomorrow.
    if (candidate.getTime() <= current.getTime()) {
        const nextDay = new Date(Math.max(at.getTime(), current.getTime()) + 864e5);
        candidate = atInstant(nextDay, timezone, hour);
        // One more push, for the case where "tomorrow at 5pm" is still behind
        // because the anchor date itself is in the past.
        if (candidate.getTime() <= current.getTime()) {
            candidate = atInstant(new Date(current.getTime() + 864e5), timezone, hour);
        }
    }
    return candidate.toISOString();
}

/**
 * The UTC instant at which the wall clock in `timezone` reads `hour:00` on the
 * calendar day that `at` falls on there.
 */
function atInstant(at, timezone, hour) {
    return instantOn(wallClock(at, timezone), timezone, hour);
}

/**
 * The same, from a calendar date rather than from an instant.
 *
 * A bare "2026-09-15" is a DATE, and turning it into an instant first in order
 * to ask which day it is loses the answer for any workspace behind UTC: midnight
 * UTC on the fifteenth is the evening of the fourteenth in New York, so the
 * follow-up was scheduled for the wrong day. The calendar fields are read
 * straight out of the string instead.
 */
function instantOn({ year, month, day }, timezone, hour) {
    // A first guess that is right to within the zone's offset, then corrected
    // by whatever the guess actually reads on that clock.
    const guess = Date.UTC(year, month - 1, day, hour, 0, 0);
    const read = wallClock(new Date(guess), timezone);
    const drift = (read.hour - hour) * 3600e3 + read.minute * 60e3;
    return new Date(guess - drift);
}

function wallClock(at, timezone) {
    let fields;
    try {
        fields = new Intl.DateTimeFormat('en-CA', {
            timeZone: timezone,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).formatToParts(at);
    } catch {
        // An unknown timezone is a configuration mistake, not a reason to
        // refuse to schedule anything. UTC, and the caller's dates still land.
        return {
            year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate(),
            hour: at.getUTCHours(), minute: at.getUTCMinutes(),
        };
    }
    const value = (type) => Number(fields.find((f) => f.type === type)?.value ?? 0);
    return {
        year: value('year'), month: value('month'), day: value('day'),
        hour: value('hour'), minute: value('minute'),
    };
}

/* ---------------------------------------------------- what a follow-up is -- */

/** A bare calendar date — "2026-09-15" — and nothing else. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Whether a follow-up value carries a TIME OF DAY that somebody chose.
 *
 * "2026-09-15" plainly does not. `2026-09-15T00:00:00.000Z` is the same thing
 * wearing an instant: it is what a date-only input produces once something has
 * stamped midnight onto it, and midnight UTC is 3am in Riyadh — a time no rep
 * has ever asked to make a call at, so it is read as absent rather than chosen.
 *
 * Anything else — including a deliberate `T00:00` in the workspace's own
 * timezone, which arrives as some other UTC hour — is somebody's decision and
 * is kept to the minute.
 */
export function hasTimeOfDay(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return false;
    if (DATE_ONLY.test(raw)) return false;
    return !/T00:00(:00(\.000)?)?Z?$/.test(raw);
}

/**
 * One follow-up value, as the instant the CRM will actually work to.
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 *
 * A follow-up is a date AND A TIME. "Ring them back on the fifteenth at half
 * two" is the commitment a rep makes on the phone, and everything downstream —
 * the task's due date, the assignment's `next_follow_up_at`, the Follow-ups Due
 * tab, the sort order of My Work — reads one column and must read the same
 * instant. When the console sent a date and the sequence quietly gave it an
 * hour, those two disagreed: the queue thought the follow-up was due at
 * midnight and the task said nine.
 *
 * So the decision is made ONCE, here, and every writer normalises through it.
 *
 *   a full instant   kept exactly, to the minute — it is what somebody chose
 *   a bare date      the start of the working day in the workspace's timezone
 *   anything else    null, and the caller refuses the request
 *
 * Returning null rather than throwing keeps this usable from the UI (to preview
 * a schedule) and from validation (to reject with a decent message).
 */
export function normalizeFollowUpAt(value, { timezone = 'UTC', dayStartHour = DEFAULT_DAY_START_HOUR } = {}) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;

    const day = DATE_ONLY.exec(raw);
    if (day) {
        const parts = { year: Number(day[1]), month: Number(day[2]), day: Number(day[3]) };
        // Round-tripped, so "2026-02-31" is refused rather than rolling into March.
        const probe = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
        if (probe.getUTCMonth() + 1 !== parts.month || probe.getUTCDate() !== parts.day) return null;
        return instantOn(parts, timezone, hourOf(dayStartHour)).toISOString();
    }

    const at = new Date(raw);
    if (Number.isNaN(at.getTime())) return null;
    if (hasTimeOfDay(raw)) return at.toISOString();
    // An instant that is really a date wearing midnight UTC. Same rule as above.
    return atInstant(at, timezone, hourOf(dayStartHour)).toISOString();
}

/** An hour that came from settings, which is a text column. */
function hourOf(value) {
    const hour = Number(value);
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_DAY_START_HOUR;
}

/**
 * The four due dates, from the one the rep chose.
 *
 * Exported so a test can assert the seven days without going near the database,
 * and so the UI can show the schedule before it is committed.
 */
export function scheduleFrom(firstAtIso, {
    timezone = 'UTC',
    dayEndHour = DEFAULT_DAY_END_HOUR,
    dayStartHour = DEFAULT_DAY_START_HOUR,
    nowIso = null,
} = {}) {
    /**
     * A date with no time gets the start of the working day; a date somebody
     * gave a time to keeps it, to the minute. One rule, in one function, so the
     * schedule and the queue column cannot disagree about what was entered.
     */
    const firstIso = normalizeFollowUpAt(firstAtIso, { timezone, dayStartHour });
    if (!firstIso) return null;
    const first = new Date(firstIso);

    return STEPS.map((step) => {
        /**
         * Seven days is 7 × 24 hours from the first instant, for a follow-up with
         * a time and one without alike — the rule is "exactly seven days after
         * step 1", stated in milliseconds precisely so that "about a week" cannot
         * creep in. In a zone that observes DST that can read as an hour's
         * difference on the wall clock twice a year, which is the honest cost of
         * the two steps being a fixed distance apart.
         */
        const anchor = new Date(first.getTime() + step.offsetDays * 864e5);
        if (step.endOfDay) {
            /**
             * A WhatsApp cannot go out before the call it follows.
             *
             * "End of that same day" is measured against the clock AND against
             * the call: a follow-up booked for 10pm is already past the end of
             * its own day, so its WhatsApp belongs to the next one. Without the
             * anchor in here, an evening follow-up produced a WhatsApp task due
             * five hours before the call that was supposed to prompt it.
             */
            const notBefore = laterOf(nowIso ?? now(), anchor.toISOString());
            return { ...step, dueAt: endOfDay(anchor.toISOString(), { timezone, hour: dayEndHour, nowIso: notBefore }) };
        }
        return { ...step, dueAt: anchor.toISOString() };
    });
}

function laterOf(a, b) {
    return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

/* -------------------------------------------------------------- the tasks -- */

/** The follow-up metadata on a task, or null when it is an ordinary task. */
export function followUpOf(task) {
    const meta = json(task?.properties, {})?.follow_up;
    return meta && meta.step ? meta : null;
}

/**
 * Starts the sequence for one calling assignment.
 *
 * Idempotent by construction: an assignment that has already started one is
 * returned unchanged. A rep who logs a second follow-up on a lead already in
 * the sequence is not asking for four more tasks — they are working the ones
 * they have.
 */
export function startSequence(ctx, {
    assignment, contact, account = null, firstFollowUpAt, assigneeId = null, timezone = 'UTC',
    dayEndHour = DEFAULT_DAY_END_HOUR, dayStartHour = DEFAULT_DAY_START_HOUR,
}) {
    if (!assignment?.id || !firstFollowUpAt) return null;
    if (assignment.sequence_started_at) {
        return { alreadyRunning: true, tasks: tasksFor(ctx, assignment.id) };
    }

    const schedule = scheduleFrom(firstFollowUpAt, { timezone, dayEndHour, dayStartHour });
    if (!schedule) return null;

    const owner = assigneeId ?? assignment.assigned_to ?? ctx.userId ?? null;
    const company = account?.name ?? null;
    const who = contact?.full_name
        ?? [contact?.first_name, contact?.last_name].filter(Boolean).join(' ')
        ?? 'this lead';
    const stamp = now();
    const created = [];

    tx(() => {
        for (const item of schedule) {
            const taskId = id('tsk');
            run(
                `INSERT INTO tasks
                   (id, workspace_id, parent_type, parent_id, account_id, title, description,
                    assignee_id, due_at, priority, status, properties, created_by, created_at, updated_at)
                 VALUES (?,?,'contact',?,?,?,?,?,?,?,'open',?,?,?,?)`,
                [
                    taskId, ctx.workspaceId, contact.id, assignment.account_id ?? null,
                    `${item.label} — ${who}`,
                    describe(item, { who, company, schedule }),
                    owner, item.dueAt, item.priority,
                    JSON.stringify({
                        follow_up: {
                            step: item.step,
                            position: item.position,
                            of: SEQUENCE_LENGTH,
                            activity_type: item.activityType,
                            assignment_id: assignment.id,
                            contact_id: contact.id,
                        },
                    }),
                    ctx.userId ?? null, stamp, stamp,
                ],
            );
            created.push({ id: taskId, ...item });
        }

        run(
            `UPDATE calling_assignments
                SET sequence_started_at = ?, sequence_step = 0, updated_at = ?
              WHERE id = ?`,
            [stamp, stamp, assignment.id],
        );

        audit(ctx, {
            objectKey: 'contact',
            recordId: contact.id,
            accountId: assignment.account_id ?? null,
            action: 'follow_up_sequence_started',
            source: 'automation',
            after: {
                steps: created.map((c) => ({ step: c.step, dueAt: c.dueAt })),
                rule: `${SEQUENCE_LENGTH} activities, then the lead is dead`,
            },
        });

        /**
         * The bell rings for work that can be acted on NOW.
         *
         * These tasks never passed through createRecord, so the notification
         * that path fires never happened. But announcing all four steps the
         * moment the sequence starts is four bells at once for three weeks of
         * future work — and every one of them still said "New task" days later,
         * after the lead had engaged and `completeSequence` had closed the
         * steps behind it, so clicking a week-old bell opened a task that was
         * already done.
         *
         * A step scheduled for later announces itself exactly once, when it
         * actually comes due: the reminder sweep fires "Due now" for open tasks
         * as their date arrives (lib/reminders.mjs) and never for ones already
         * completed or cancelled. Only a step that is due — or overdue — right
         * now rings immediately.
         */
        const stampMs = Date.parse(stamp);
        for (const task of created) {
            if (Date.parse(task.dueAt) > stampMs + DUE_NOW_TOLERANCE_MS) continue;
            notifyTaskAssigned(ctx, {
                assigneeId: owner,
                taskId: task.id,
                subject: task.label,
                accountName: company,
                // A calling follow-up is a lead to ring, not a task to read —
                // it belongs in the console on the exact contact, not the
                // generic task record.
                link: `/calling?open=${assignment.id}`,
            });
        }
    });

    return { alreadyRunning: false, tasks: created };
}

/**
 * What the rep needs to know without opening anything else.
 *
 * Requirement: the task must carry the lead, the company, the activity type,
 * the due date, the position in the sequence and the context. All six are here,
 * in a sentence rather than a form, because a task description is read at a
 * glance between calls.
 */
function describe(item, { who, company, schedule }) {
    const last = item.position === SEQUENCE_LENGTH;
    const next = schedule.find((s) => s.position === item.position + 1);
    return [
        `${item.activityType === 'whatsapp' ? 'WhatsApp' : 'Call'} ${who}`
        + (company ? ` at ${company}` : '')
        + '.',
        `Step ${item.position} of ${SEQUENCE_LENGTH} in the follow-up sequence.`,
        last
            ? 'This is the last one. When it is done the lead is marked dead and no further follow-up is created.'
            : `Next: ${next.label.toLowerCase()}.`,
    ].join(' ');
}

/** Every follow-up task on one assignment, in sequence order. */
export function tasksFor(ctx, assignmentId) {
    return all(
        `SELECT * FROM tasks
          WHERE workspace_id = ? AND deleted_at IS NULL
            AND properties LIKE ?
          ORDER BY due_at`,
        [ctx.workspaceId, `%"assignment_id":"${assignmentId}"%`],
    ).map((task) => ({ ...task, follow_up: followUpOf(task) }))
        .filter((task) => task.follow_up?.assignment_id === assignmentId)
        .sort((a, b) => a.follow_up.position - b.follow_up.position);
}

/**
 * The trail a WhatsApp step leaves.
 *
 * Steps 2 and 4 in `STEPS` ARE a WhatsApp message, not a reminder to send
 * one — so ticking that task done without a record of the message itself
 * left the sequence's own timeline unable to say whether the assignee
 * actually messaged the lead or just cleared their list. This is that
 * record: a real `activities` row, `type_key: 'whatsapp'`, written the
 * moment the step is completed, by whoever completed it.
 */
function logWhatsAppForStep(ctx, task, meta, assignment) {
    const stamp = now();
    const contact = meta.contact_id
        ? get('SELECT full_name, first_name, last_name FROM contacts WHERE id = ? AND workspace_id = ?', [meta.contact_id, ctx.workspaceId])
        : null;
    const who = contact?.full_name || [contact?.first_name, contact?.last_name].filter(Boolean).join(' ') || 'the lead';
    run(
        `INSERT INTO activities
           (id, workspace_id, parent_type, parent_id, account_id, type_key, subject, body,
            occurred_at, actor_id, source, properties, created_at, updated_at)
         VALUES (?,?,'contact',?,?,'whatsapp',?,?,?,?,?,?,?,?)`,
        [
            id('act'), ctx.workspaceId, meta.contact_id, assignment.account_id ?? null,
            `WhatsApp sent to ${who}`,
            `Step ${meta.position} of ${SEQUENCE_LENGTH} in the follow-up sequence.`,
            stamp, task.assignee_id ?? ctx.userId ?? null, 'automation',
            JSON.stringify({ follow_up_step: meta.step, task_id: task.id }),
            stamp, stamp,
        ],
    );
}

/**
 * Called when a task is completed. Advances the sequence, logs the WhatsApp
 * a step 2/4 completion stands for, and kills the lead when the last step
 * is done.
 *
 * Returns null for an ordinary task, so the caller can hand every completion to
 * it without asking whether this one matters.
 */
export function completeStep(ctx, task) {
    const meta = followUpOf(task);
    if (!meta) return null;

    const assignment = get(
        'SELECT * FROM calling_assignments WHERE id = ? AND workspace_id = ?',
        [meta.assignment_id, ctx.workspaceId],
    );
    if (!assignment) return null;

    if (meta.activity_type === 'whatsapp') logWhatsAppForStep(ctx, task, meta, assignment);

    const stamp = now();
    const reached = Math.max(Number(assignment.sequence_step) || 0, meta.position);

    if (reached < SEQUENCE_LENGTH) {
        /**
         * `next_follow_up_at` is what the calling queue and its Follow-ups Due
         * tab actually read (see the comment on `nextAt` in lib/calling.mjs) —
         * it was set once, to step 1's due date, when the sequence started,
         * and NOTHING advanced it as later steps completed. A call step's due
         * date happens to land the contact back in the queue anyway (a rep
         * browsing "who's due" finds it), which is exactly why nobody noticed
         * this for calls — but a WhatsApp step has no such second path: the
         * only place it ever showed up was the one-time "task assigned"
         * notification fired for all four steps at once, on day one. By the
         * time whatsapp_2 came due seven days later, nothing pointed back at
         * it — not the queue, not a fresh notification, nothing. Advancing
         * this column to whichever step is now active fixes both: the queue
         * surfaces the contact again, and the Follow-ups tab's ordering is
         * honest about what is actually due next.
         */
        const next = tasksFor(ctx, assignment.id).find((t) => t.follow_up?.position === reached + 1 && t.status !== 'done');
        run('UPDATE calling_assignments SET sequence_step = ?, next_follow_up_at = ?, updated_at = ? WHERE id = ?',
            [reached, next?.due_at ?? assignment.next_follow_up_at, stamp, assignment.id]);
        return { position: meta.position, of: SEQUENCE_LENGTH, dead: false };
    }

    return markDead(ctx, assignment, 'the follow-up sequence completed');
}

/**
 * A CALL step was attempted and nobody answered.
 *
 * The step still happened — the rep dialled — so it is complete the same
 * way ticking its task would make it complete, and the sequence moves on to
 * whatever comes next (typically the WhatsApp that already follows it the
 * same day). Without this, a lead's "next step" stayed stuck on a call
 * already attempted, several unanswered rings deep, until somebody noticed
 * and ticked the task by hand.
 *
 * A WhatsApp step is never touched here — only a genuine call attempt
 * completes a call step; nothing about a phone call substitutes for the
 * WhatsApp message steps 2 and 4 stand for.
 */
export function attemptCallStep(ctx, assignmentId) {
    const assignment = get('SELECT * FROM calling_assignments WHERE id = ? AND workspace_id = ?', [assignmentId, ctx.workspaceId]);
    if (!assignment?.sequence_started_at || assignment.sequence_completed_at || assignment.dead_at) return null;

    const tasks = tasksFor(ctx, assignmentId);
    const current = tasks.find((t) => (t.status === 'open' || t.status === 'in_progress') && t.follow_up.activity_type === 'call');
    if (!current) return null;

    const stamp = now();
    run('UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?', ['done', stamp, stamp, current.id]);
    return completeStep(ctx, { ...current, status: 'done' });
}

/**
 * The whole schedule, moved to a new first follow-up.
 *
 * ── WHAT MOVES AND WHAT DOES NOT ────────────────────────────────────────────
 *
 * The steps still OPEN are re-dated from the new instant, using the same
 * `scheduleFrom` that built them, so "exactly seven days after the first
 * follow-up" survives a reschedule instead of quietly becoming seven days after
 * the original one. Steps already DONE keep their dates: a call somebody made on
 * Tuesday happened on Tuesday, and rewriting its due date to tidy the future
 * would falsify the history.
 *
 * A sequence that never started moves nothing and says so, so the caller can
 * reschedule a plain follow-up without asking whether four tasks exist.
 */
export function rescheduleSequence(ctx, assignment, firstFollowUpAt, {
    timezone = 'UTC', dayEndHour = DEFAULT_DAY_END_HOUR, dayStartHour = DEFAULT_DAY_START_HOUR,
} = {}) {
    if (!assignment?.sequence_started_at) return { steps: 0 };

    const schedule = scheduleFrom(firstFollowUpAt, { timezone, dayEndHour, dayStartHour });
    if (!schedule) return { steps: 0 };

    const byStep = new Map(schedule.map((s) => [s.step, s.dueAt]));
    const tasks = tasksFor(ctx, assignment.id);
    const stamp = now();
    let moved = 0;

    tx(() => {
        for (const task of tasks) {
            // Done and cancelled steps are history. Only what is still to happen
            // can be rescheduled.
            if (task.status !== 'open' && task.status !== 'in_progress') continue;
            const dueAt = byStep.get(task.follow_up.step);
            if (!dueAt || dueAt === task.due_at) continue;
            run('UPDATE tasks SET due_at = ?, updated_at = ? WHERE id = ?', [dueAt, stamp, task.id]);
            moved += 1;
        }
    });

    return { steps: moved };
}

/**
 * The follow-up sequence is FINISHED, because the lead answered.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * A contact in the middle of the sequence who is rung and gives any outcome
 * other than No Answer or another Follow Up has done the thing the sequence
 * existed to produce: they engaged. Qualified, not interested, wrong number,
 * profile sent, meeting booked — all of them end it. The remaining steps are
 * chasing somebody who has already been reached, and a rep who finds "WhatsApp
 * after the second follow-up" in their list on Thursday for a client they
 * qualified on Tuesday stops trusting the list.
 *
 * ── COMPLETED IS NOT DEAD ───────────────────────────────────────────────────
 *
 * `markDead` is for a lead that ran out of road. This is the opposite outcome
 * and must not share its state: no `dead_at`, no `dead_reason`, and the
 * assignment's own status is left to the OUTCOME that triggered this — Not
 * Interested closes it, Qualified keeps it working, and neither is this
 * function's business. All this does is finish the sequence and tidy the tasks
 * it left behind.
 *
 * Open steps are marked `done` rather than `cancelled`: the sequence reached its
 * purpose, and a cancelled task reads as work abandoned. `sequence_step` is
 * stamped at full length so "Follow-ups done" stops offering a next step, and
 * the timeline says which outcome ended it.
 *
 * Returns null when there was no sequence running, so callers can hand every
 * call to it without asking first.
 */
export function completeSequence(ctx, assignment, { because = 'the lead engaged' } = {}) {
    if (!assignment?.id || !assignment.sequence_started_at) return null;
    if (assignment.dead_at) return null;

    const open = all(
        `SELECT id FROM tasks
          WHERE workspace_id = ? AND status IN ('open','in_progress') AND deleted_at IS NULL
            AND properties LIKE ?`,
        [ctx.workspaceId, `%"assignment_id":"${assignment.id}"%`],
    );

    const stamp = now();
    tx(() => {
        run(
            `UPDATE calling_assignments
                SET sequence_step = ?, sequence_completed_at = ?, updated_at = ?
              WHERE id = ?`,
            [SEQUENCE_LENGTH, stamp, stamp, assignment.id],
        );
        if (open.length) {
            run(
                `UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ?
                  WHERE workspace_id = ? AND status IN ('open','in_progress')
                    AND properties LIKE ?`,
                [stamp, stamp, ctx.workspaceId, `%"assignment_id":"${assignment.id}"%`],
            );
        }
        run(
            `INSERT INTO activities
               (id, workspace_id, parent_type, parent_id, account_id, type_key, subject, body,
                occurred_at, actor_id, source, properties, created_at, updated_at)
             VALUES (?,?,'contact',?,?,'note',?,?,?,?,'automation','{}',?,?)`,
            [
                id('act'), ctx.workspaceId, assignment.contact_id, assignment.account_id ?? null,
                'Follow-up sequence completed',
                `The lead was reached — ${because} — so the follow-up sequence is complete and `
                + `${open.length} remaining ${open.length === 1 ? 'step was' : 'steps were'} closed. `
                + 'Nobody will be chased for a conversation that already happened.',
                stamp, ctx.userId ?? null, stamp, stamp,
            ],
        );
        audit(ctx, {
            objectKey: 'contact',
            recordId: assignment.contact_id,
            accountId: assignment.account_id ?? null,
            action: 'follow_up_sequence_completed',
            source: 'automation',
            after: { because, stepsClosed: open.length },
        });
    });

    return { completed: true, stepsClosed: open.length };
}

/**
 * The lead is dead.
 *
 * The assignment goes inactive, which is what takes it out of the queue — the
 * queue reads `active`, so this is the fact and not a filter over it. The
 * remaining open tasks in the sequence are cancelled rather than deleted: they
 * happened, and a rep looking back should see four steps of which some were
 * ticked and the rest overtaken.
 *
 * ── ONE DOOR OUT, WHATEVER KILLED IT ────────────────────────────────────────
 *
 * Two things retire a lead: finishing the four-step sequence without converting,
 * and three unanswered calls in a row (`logCall`, lib/calling.mjs). Both come
 * through here, because "dead" is a set of six facts — inactive, queue_status,
 * dead_at, dead_reason, cancelled tasks, a timeline entry — and a second
 * function that set five of them would produce leads that were dead in the list
 * and alive on the contact page.
 *
 * `note` is what the timeline says. It defaults to the sequence's own wording;
 * the no-answer rule passes its own, because "all four follow-up activities are
 * done" on a lead that never had one is the software describing something that
 * did not happen.
 *
 * `sequence_step` is only advanced for a lead that HAD a sequence. Stamping four
 * on a lead nobody followed up would make "Follow-ups done" read 4 out of 4 on a
 * contact that was rung three times and never answered.
 */
export function markDead(ctx, assignment, reason, { note = null } = {}) {
    const stamp = now();
    const running = Boolean(assignment.sequence_started_at);
    const step = running ? SEQUENCE_LENGTH : (Number(assignment.sequence_step) || 0);
    /**
     * The timeline says what actually happened, not what usually does.
     *
     * `running` was computed for `sequence_step` and the message ignored it, so
     * a lead retired for three unanswered calls — which never had a sequence at
     * all — was recorded as "all 4 follow-up activities are done". That is a
     * confident sentence about four things that did not occur, on the one
     * record somebody reads six months later to find out why the lead went
     * quiet. The two ways to die read differently because they ARE different.
     */
    const body = note
        ?? (running
            ? `All ${SEQUENCE_LENGTH} follow-up activities are done and the lead did not convert. `
              + 'No further follow-up will be created automatically.'
            : `The lead was retired: ${reason}. No follow-up sequence had been started, `
              + 'and none will be created automatically.');

    tx(() => {
        run(
            `UPDATE calling_assignments
                SET sequence_step = ?, dead_at = ?, dead_reason = ?,
                    queue_status = 'dead', active = 0, completed_at = ?, updated_at = ?
              WHERE id = ?`,
            [step, stamp, reason, stamp, stamp, assignment.id],
        );
        run(
            `UPDATE tasks SET status = 'cancelled', updated_at = ?
              WHERE workspace_id = ? AND status IN ('open','in_progress')
                AND properties LIKE ?`,
            [stamp, ctx.workspaceId, `%"assignment_id":"${assignment.id}"%`],
        );
        /**
         * Recorded as an ACTIVITY, not only as a status.
         *
         * "Why did this lead go quiet in March" is a question asked six months
         * later, and a flag on a row does not answer it. The timeline does.
         */
        run(
            `INSERT INTO activities
               (id, workspace_id, parent_type, parent_id, account_id, type_key, subject, body,
                occurred_at, actor_id, source, properties, created_at, updated_at)
             VALUES (?,?,'contact',?,?,'note',?,?,?,?,'automation','{}',?,?)`,
            [
                id('act'), ctx.workspaceId, assignment.contact_id, assignment.account_id ?? null,
                'Lead marked dead',
                body,
                stamp, ctx.userId ?? null, stamp, stamp,
            ],
        );
        audit(ctx, {
            objectKey: 'contact',
            recordId: assignment.contact_id,
            accountId: assignment.account_id ?? null,
            action: 'lead_dead',
            source: 'automation',
            after: { because: reason, steps: step },
        });
    });
    // The rep whose lead it was learns it died — best-effort, after the write.
    notifyLeadDead(ctx, {
        ownerId: assignment.assigned_to ?? null,
        contactId: assignment.contact_id,
        reason,
    });
    return { position: SEQUENCE_LENGTH, of: SEQUENCE_LENGTH, dead: true };
}

/**
 * Where a lead stands, for the calling card and the contact page.
 *
 * Every question the rep asks in the two seconds before dialling: how far
 * through the sequence, what is next, when is it due, and is this lead still
 * alive. Answered from the tasks, which are the sequence.
 */
export function sequenceStatus(ctx, assignment) {
    if (!assignment?.sequence_started_at) {
        return { running: false, dead: Boolean(assignment?.dead_at), position: 0, of: SEQUENCE_LENGTH, next: null };
    }
    const tasks = tasksFor(ctx, assignment.id);
    const done = tasks.filter((t) => t.status === 'done');
    const next = tasks.find((t) => t.status === 'open' || t.status === 'in_progress') ?? null;
    return {
        running: true,
        dead: Boolean(assignment.dead_at),
        deadAt: assignment.dead_at ?? null,
        deadReason: assignment.dead_reason ?? null,
        position: done.length,
        of: SEQUENCE_LENGTH,
        next: next && {
            taskId: next.id,
            label: next.follow_up.step.startsWith('whatsapp') ? 'WhatsApp' : 'Follow-up call',
            step: next.follow_up.step,
            position: next.follow_up.position,
            dueAt: next.due_at,
        },
        steps: tasks.map((t) => ({
            step: t.follow_up.step,
            position: t.follow_up.position,
            label: t.follow_up.step.startsWith('whatsapp') ? 'WhatsApp' : 'Follow-up call',
            dueAt: t.due_at,
            status: t.status,
            taskId: t.id,
        })),
    };
}
