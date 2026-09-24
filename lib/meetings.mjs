/**
 * Meetings: the three states one can be in, and the only honest show rate.
 *
 * ── WHY MEETINGS NEEDED A MODEL OF THEIR OWN ────────────────────────────────
 *
 * A meeting used to be an outcome on a call — `meeting_scheduled` — with the
 * date buried in the activity's `properties` JSON. Every question a sales floor
 * actually asks of its meetings was unanswerable from that:
 *
 *   "how many meetings this month"   counted CALLS, dated by the call. One
 *                                    booked on the 30th for the 3rd fell in the
 *                                    wrong month.
 *   "did they turn up"               nothing recorded it.
 *   "what is our show rate"          not computable: a meeting nobody had had
 *                                    yet and one nobody attended were the same
 *                                    row.
 *
 * So a meeting has a DATE of its own (`activities.meeting_at`) and a STATE of
 * its own (`activities.meeting_status`), and this module owns the transitions
 * between those states and the arithmetic over them.
 *
 * ── THE THREE STATES ────────────────────────────────────────────────────────
 *
 *   scheduled   booked. Before `meeting_at` it is UPCOMING — the same state
 *               read against the clock, never a fourth column.
 *   done        it happened.
 *   no_show     the time came and the prospect did not.
 *
 * `no_show` is written by a person, never derived. A meeting at 3pm today is not
 * a no-show at 2pm, and a meeting nobody has classified yet is not one either —
 * that is unclassified, which is a different fact and is reported as one.
 *
 * ── THE SHOW RATE, AND THE DENOMINATOR THAT MAKES IT HONEST ─────────────────
 *
 *     Done / (Done + No Show)
 *
 * NOT Done / Scheduled. Booking meetings for next week would otherwise lower
 * this week's show rate, so a rep filling their diary would watch their own
 * number fall — a metric that punishes the work it exists to encourage. Upcoming
 * meetings stay outside the denominator until they resolve.
 *
 * When Done and No Show are both nought there is NO RATE. `null`, not 0: a team
 * whose meetings are all still to come has not shown a 0% show rate, and a
 * dashboard that says 0% is making an accusation the data cannot support.
 */
import { all, get, run, now } from './db.mjs';
import { badRequest, notFound, forbidden } from './http.mjs';
import { audit } from './repo.mjs';

export const MEETING_STATUSES = [
    { key: 'scheduled', label: 'Scheduled', help: 'Booked. Before its time it reads as Upcoming.' },
    { key: 'done', label: 'Done', help: 'The meeting happened.' },
    { key: 'no_show', label: 'No Show', help: 'The time came and the prospect did not.' },
];

const STATUS_KEYS = new Set(MEETING_STATUSES.map((s) => s.key));

/** The states that are a settled outcome — the show rate's whole world. */
export const SETTLED = new Set(['done', 'no_show']);

/**
 * Done / (Done + No Show) as a percentage — or null when neither has happened.
 *
 * One function, so the per-person rows, the total row and the headline card
 * cannot disagree, and so "no outcomes yet" is answered the same way everywhere.
 */
export function showRate(done, noShow) {
    const settled = (Number(done) || 0) + (Number(noShow) || 0);
    if (!settled) return null;
    return Math.round(((Number(done) || 0) / settled) * 1000) / 10;
}

/**
 * How long before its start a meeting may be marked done.
 *
 * A meeting can be brought forward, or run at 14:55 for a 15:00 slot, and
 * refusing to record one that has demonstrably happened would be the software
 * arguing with the person who was in it. Deliberately small.
 */
export const DONE_GRACE_MINUTES = 60;

/**
 * Classify a meeting that has already been booked.
 *
 * A meeting at 3pm cannot be a no-show at 2pm — nobody has failed to arrive yet.
 * Allowing it would let a rep clear their diary by declaring tomorrow's meetings
 * dead, and would make "No Show" mean two different things in one column.
 */
export function settleMeeting(ctx, activityId, status, { note = null, at = null, restrictToUserId = null } = {}) {
    if (!STATUS_KEYS.has(status)) {
        throw badRequest(`A meeting is scheduled, done or no_show — not "${status}".`);
    }

    const meeting = get(
        `SELECT a.*, COALESCE(asg.assigned_to, a.actor_id) AS owner_user_id
           FROM activities a
           LEFT JOIN calling_assignments asg ON asg.id = a.assignment_id
          WHERE a.id = ? AND a.workspace_id = ? AND a.deleted_at IS NULL AND a.meeting_at IS NOT NULL`,
        [activityId, ctx.workspaceId],
    );
    if (!meeting) throw notFound('That meeting does not exist.');
    // A confined SDR reaches this route for their own book only (see
    // api/meetings.mjs's settle()) — this is what stops them settling a
    // colleague's meeting once they hold the route at all.
    if (restrictToUserId && meeting.owner_user_id !== restrictToUserId) {
        throw forbidden('You can only settle your own meetings.');
    }

    const stamp = at ?? now();
    const startsAt = new Date(meeting.meeting_at).getTime();
    const clock = new Date(stamp).getTime();

    if (status === 'no_show' && clock < startsAt) {
        throw badRequest(
            'That meeting has not happened yet, so it cannot be a no-show. '
            + 'It stays Upcoming until its time has passed.',
        );
    }
    if (status === 'done' && clock < startsAt - DONE_GRACE_MINUTES * 60e3) {
        throw badRequest('That meeting is still in the future. Mark it done once it has taken place.');
    }

    const before = meeting.meeting_status ?? 'scheduled';
    run(
        'UPDATE activities SET meeting_status = ?, properties = ?, updated_at = ? WHERE id = ?',
        [
            status,
            JSON.stringify({
                ...safeProperties(meeting.properties),
                meetingAt: meeting.meeting_at,
                meetingOutcomeAt: stamp,
                ...(note ? { meetingOutcomeNote: String(note).slice(0, 500) } : {}),
            }),
            stamp,
            meeting.id,
        ],
    );

    audit(ctx, {
        objectKey: 'contact',
        recordId: meeting.parent_id,
        accountId: meeting.account_id ?? null,
        action: `meeting_${status}`,
        before: { meeting_status: before },
        after: { meeting_status: status, meetingAt: meeting.meeting_at },
    });

    return { ...meeting, meeting_status: status };
}

function safeProperties(raw) {
    try { return JSON.parse(raw ?? '{}') ?? {}; } catch { return {}; }
}

/**
 * The meeting a call outcome is about: the most recent one still unsettled.
 *
 * A rep pressing Meeting Done means the meeting they just had, which is the one
 * that was booked and never classified. Reaching for it rather than asking them
 * to pick from a list is why the console can record an outcome in one click.
 *
 * Returns null when nothing is outstanding, which is not an error: a meeting can
 * be logged as done by somebody who never booked it here.
 */
export function openMeetingFor(ctx, { assignmentId = null, contactId = null } = {}) {
    if (!assignmentId && !contactId) return null;
    const where = assignmentId ? 'a.assignment_id = ?' : 'a.parent_id = ?';
    return get(
        `SELECT a.* FROM activities a
          WHERE a.workspace_id = ? AND ${where} AND a.deleted_at IS NULL
            AND a.meeting_at IS NOT NULL
            AND (a.meeting_status IS NULL OR a.meeting_status = 'scheduled')
          ORDER BY a.meeting_at DESC
          LIMIT 1`,
        [ctx.workspaceId, assignmentId ?? contactId],
    ) ?? null;
}

/* -------------------------------------------------------------- analytics -- */

/**
 * Meeting counts per person for a window, plus the totals, aggregated in SQL.
 *
 * ── WHICH DATE THE WINDOW MEANS ─────────────────────────────────────────────
 *
 * `meeting_at`. A meeting belongs to the period it is HELD in, not the one it was
 * booked in and not the one somebody classified it in — "how did our meetings go
 * this month" is a question about the meetings that were in this month.
 *
 * ── WHICH PERSON IT COUNTS FOR ──────────────────────────────────────────────
 *
 * Whoever's queue the contact is on (`calling_assignments.assigned_to`), falling
 * back to whoever logged the call. That matches the rest of the cold calling
 * table, where Assigned and Called are the SDR's own queue — a manager covering
 * one call on somebody's list must not move the meeting onto their row.
 *
 * ── WHY IT IS ONE QUERY ─────────────────────────────────────────────────────
 *
 * Six numbers per person, computed by the database and returned as a handful of
 * rows. The alternative anybody reaches for first — fetch the meetings, count
 * them in JavaScript — is a page that gets slower every month it is used, and on
 * the live backend every statement is a blocking round trip.
 */
export function meetingStats(ctx, { from = null, to = null, sdrId = null, nowIso = null } = {}) {
    const clock = nowIso ?? now();
    const params = [ctx.workspaceId];
    const where = ['a.workspace_id = ?', 'a.meeting_at IS NOT NULL', 'a.deleted_at IS NULL'];

    if (from) { where.push('a.meeting_at >= ?'); params.push(from); }
    if (to) { where.push('a.meeting_at < ?'); params.push(to); }

    /**
     * The person is resolved in SQL, so the grouping and the filter agree by
     * construction — a filter applied in JavaScript over a query grouped in SQL
     * is how a total stops matching the rows above it.
     */
    const person = 'COALESCE(asg.assigned_to, a.actor_id)';
    if (sdrId) { where.push(`${person} = ?`); params.push(sdrId); }

    const rows = all(
        `SELECT ${person} AS person,
                COUNT(*) AS scheduled,
                SUM(CASE WHEN a.meeting_status = 'done' THEN 1 ELSE 0 END) AS done,
                SUM(CASE WHEN a.meeting_status = 'no_show' THEN 1 ELSE 0 END) AS no_show,
                SUM(CASE WHEN COALESCE(a.meeting_status,'scheduled') = 'scheduled'
                          AND a.meeting_at > ? THEN 1 ELSE 0 END) AS upcoming,
                SUM(CASE WHEN COALESCE(a.meeting_status,'scheduled') = 'scheduled'
                          AND a.meeting_at <= ? THEN 1 ELSE 0 END) AS unclassified
           FROM activities a
           LEFT JOIN calling_assignments asg ON asg.id = a.assignment_id
          WHERE ${where.join(' AND ')}
          GROUP BY ${person}`,
        [clock, clock, ...params],
    );

    const byPerson = new Map();
    for (const row of rows) {
        byPerson.set(row.person ?? 'unassigned', {
            id: row.person ?? null,
            scheduled: Number(row.scheduled) || 0,
            done: Number(row.done) || 0,
            noShow: Number(row.no_show) || 0,
            upcoming: Number(row.upcoming) || 0,
            /**
             * Past its time, and still nobody has said whether they turned up.
             *
             * Not a state of its own — a prompt. It is also the honest reason a
             * show rate can rest on fewer meetings than were held, which is worth
             * showing rather than hiding inside the denominator.
             */
            unclassified: Number(row.unclassified) || 0,
            showRate: showRate(row.done, row.no_show),
        });
    }

    /**
     * The total is computed from the SUMS, never averaged from the rates.
     *
     * Averaging percentages weights a rep with two meetings the same as one with
     * forty, so one quiet week at 0% drags the floor's number down by more than
     * the meetings justify. Done / (Done + No Show) across the whole window is the
     * only figure that means what it says.
     */
    const totals = [...byPerson.values()].reduce((acc, row) => ({
        scheduled: acc.scheduled + row.scheduled,
        done: acc.done + row.done,
        noShow: acc.noShow + row.noShow,
        upcoming: acc.upcoming + row.upcoming,
        unclassified: acc.unclassified + row.unclassified,
    }), { scheduled: 0, done: 0, noShow: 0, upcoming: 0, unclassified: 0 });
    totals.showRate = showRate(totals.done, totals.noShow);

    return { byPerson, totals };
}

/**
 * Every individual meeting — the list `meetingStats` only ever totalled.
 *
 * "Meetings scheduled" on the dashboard used to link to /calling, the
 * cold-calling console, which answers a different question (who to ring
 * next) and does not show a single meeting on it — clicking the number
 * everyone actually reads as "show me the meetings" landed somewhere that
 * could not. This is the module that answers it: same WHO-it-counts-for
 * and WHICH-date-it-belongs-to rules as meetingStats, one row per meeting
 * instead of one row per person.
 */
export function listMeetings(ctx, { status = null, from = null, to = null, sdrId = null, q = null, page = 1, limit = 50 } = {}) {
    const params = [ctx.workspaceId];
    const where = ['a.workspace_id = ?', 'a.meeting_at IS NOT NULL', 'a.deleted_at IS NULL'];

    if (from) { where.push('a.meeting_at >= ?'); params.push(from); }
    if (to) { where.push('a.meeting_at < ?'); params.push(to); }

    const person = 'COALESCE(asg.assigned_to, a.actor_id)';
    if (sdrId) { where.push(`${person} = ?`); params.push(sdrId); }

    if (status === 'upcoming') {
        where.push(`COALESCE(a.meeting_status, 'scheduled') = 'scheduled' AND a.meeting_at > ?`);
        params.push(now());
    } else if (status === 'unclassified') {
        where.push(`COALESCE(a.meeting_status, 'scheduled') = 'scheduled' AND a.meeting_at <= ?`);
        params.push(now());
    } else if (status && STATUS_KEYS.has(status)) {
        where.push('a.meeting_status = ?');
        params.push(status);
    }

    if (q?.trim()) {
        where.push('(c.full_name LIKE ? OR acc.name LIKE ? OR a.subject LIKE ?)');
        const like = `%${q.trim()}%`;
        params.push(like, like, like);
    }

    const size = Math.min(200, Math.max(1, Number(limit) || 50));
    const offset = (Math.max(1, Number(page) || 1) - 1) * size;
    const sql = `
        FROM activities a
        LEFT JOIN calling_assignments asg ON asg.id = a.assignment_id
        LEFT JOIN contacts c ON c.id = a.parent_id AND a.parent_type = 'contact'
        LEFT JOIN accounts acc ON acc.id = COALESCE(a.account_id, c.account_id)
        LEFT JOIN users u ON u.id = ${person}
       WHERE ${where.join(' AND ')}`;

    const total = get(`SELECT COUNT(*) AS n ${sql}`, params)?.n ?? 0;
    const rows = all(
        `SELECT a.id, a.subject, a.meeting_at, a.meeting_status, a.parent_type, a.parent_id,
                c.full_name AS contact_name, acc.id AS account_id, acc.name AS account_name,
                ${person} AS assigned_to, u.name AS assigned_name
         ${sql}
         ORDER BY a.meeting_at DESC
         LIMIT ? OFFSET ?`,
        [...params, size, offset],
    );

    return {
        total, page: Math.max(1, Number(page) || 1), pages: Math.max(1, Math.ceil(total / size)),
        meetings: rows.map((r) => ({
            id: r.id,
            subject: r.subject || (r.contact_name ? `Meeting — ${r.contact_name}` : 'Meeting'),
            meetingAt: r.meeting_at,
            status: r.meeting_status ?? 'scheduled',
            contactId: r.parent_type === 'contact' ? r.parent_id : null,
            contactName: r.contact_name,
            accountId: r.account_id,
            accountName: r.account_name,
            assignedTo: r.assigned_to,
            assignedName: r.assigned_name,
        })),
    };
}
