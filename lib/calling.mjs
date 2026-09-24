/**
 * Cold calling: whose list a contact is on, and what happened on each call.
 *
 * ── THREE THINGS THAT ARE NOT THE SAME THING ────────────────────────────────
 *
 *   the CRM's opinion    contacts / accounts / verdicts — is this a good lead
 *   the assignment       calling_assignments — whose queue it is on right now
 *   the call             activities, one row per attempt, kept forever
 *
 * Collapsing any pair of those is the mistake this module is built to avoid.
 * A contact called four times has FOUR call activities and ONE assignment, and
 * its CRM status may not have moved at all. Call counts are therefore never
 * derived from a status: they are counted from the activities, which is the only
 * place the history exists.
 *
 * ── WHY A CALL IS AN ACTIVITY ───────────────────────────────────────────────
 *
 * Because the CRM already has activities, with `occurred_at` deliberately
 * separate from `created_at` so that logging Tuesday's call on Thursday puts it
 * on Tuesday. That is exactly the semantics a calling report needs, and a second
 * activity table would have been a second answer to "what happened with this
 * company" for the timeline to disagree with.
 *
 * ── WHAT AN SDR CAN SEE ─────────────────────────────────────────────────────
 *
 * Every read here takes the caller's scope from `scopeFor`, which returns a
 * user id for an SDR and null for a manager. It is applied in SQL, not filtered
 * afterwards, so there is no path through this file that returns one SDR's
 * contact to another. An SDR holds no `record.read.all`, so the generic record
 * routes refuse them outright — this module is the only door, and it is narrow.
 */
import { all, get, run, tx, id, now, json } from './db.mjs';
import { audit, moveDealToStage, advanceDealToStage, ensureDealForAccount, updateRecord, update } from './repo.mjs';
import { badRequest, forbidden, notFound } from './http.mjs';
import { can, require$ } from './auth.mjs';
import { compileFilter, compileSort } from './query.mjs';
import {
    startSequence, sequenceStatus, SEQUENCE_LENGTH, normalizeFollowUpAt, DEFAULT_DAY_START_HOUR,
    markDead, completeSequence, rescheduleSequence, attemptCallStep,
} from './follow-up.mjs';
import { setting } from './settings.mjs';
import { openMeetingFor, settleMeeting } from './meetings.mjs';
import { notifyMeetingScheduled, notifyQueueAssigned } from './notify.mjs';
import { phoneDigitsSql, phoneMatchCandidates } from './phone.mjs';

/**
 * How many unanswered calls in a row retire a lead.
 *
 * A setting rather than a constant: a floor calling mobile numbers gives up
 * sooner than one calling switchboards, and that is a decision the business
 * makes without a deploy. Three is the default because it is the number the
 * rule was written for; anything below one would retire a lead on its first
 * ring, so the floor is one.
 */
export const DEFAULT_ATTEMPTS_BEFORE_DEAD = 3;

function attemptsBeforeDead(ctx) {
    const configured = Number(setting(ctx.workspaceId, 'calling_attempts_before_dead'));
    return Number.isFinite(configured) && configured >= 1
        ? Math.floor(configured)
        : DEFAULT_ATTEMPTS_BEFORE_DEAD;
}

/** The activity type every call is logged as. */
export const CALL_TYPE = 'call';

/**
 * The outcomes, and what each one does to the queue.
 *
 * `conversation` is the honest basis for a contact rate: somebody who did not
 * pick up was not spoken to, and counting a no-answer as a conversation would
 * flatter every SDR equally and tell a manager nothing.
 *
 * `closes` takes the contact out of the active queue. It does NOT delete
 * anything — the assignment row and every call stay exactly where they are.
 */
export const CALL_OUTCOMES = [
    { key: 'not_interested', label: 'Not Interested', status: 'closed', closes: true, conversation: true },
    { key: 'no_answer', label: 'No Answer', status: 'working', closes: false, conversation: false },
    /**
     * A number that does not belong to the person, and never will.
     *
     * Different from No Answer in both directions that matter. It CLOSES the
     * assignment — ringing it again is wasted work, where an unanswered phone
     * is worth another try — and it is not a conversation, so it stays out of
     * the active-call count. Without it, a bad number was being logged as No
     * Answer and sat in the queue forever looking like someone who might yet
     * pick up.
     */
    { key: 'wrong_number', label: 'Wrong Number', status: 'closed', closes: true, conversation: false },
    { key: 'follow_up', label: 'Follow Up', status: 'working', closes: false, conversation: true, requires: 'followUpAt' },
    { key: 'send_profile', label: 'Send Profile', status: 'working', closes: false, conversation: true },
    /**
     * QUALIFIED, AND THE QUEUE STAYS OPEN.
     *
     * The workflow is Cold Call → Qualify → Meeting, and this outcome used to
     * end it: `status: 'done', closes: true` took the contact out of the active
     * queue the moment they were qualified, so the meeting the qualification
     * exists to book could not be logged against them afterwards. An SDR who
     * did the job properly lost the lead; one who skipped straight to Meeting
     * Scheduled kept it.
     *
     * So qualifying is `working` — the middle of the sequence, not the end of
     * it. The two meeting outcomes below close it, and Meeting Done is the
     * finish. This ordering is the one every screen reads: the outcome buttons,
     * the dashboard tiles and the SDR table all render this list in order.
     */
    { key: 'qualified', label: 'Qualified', status: 'working', closes: false, conversation: true },
    { key: 'meeting_scheduled', label: 'Meeting Scheduled', status: 'working', closes: false, conversation: true, requires: 'meetingAt' },
    /**
     * THE MEETING HAPPENED, and this is the finish of the calling sequence.
     *
     * It settles the meeting that was booked — `meeting_status = 'done'` on that
     * activity — rather than only recording a second call, because "did they turn
     * up" is a question about the meeting and not about the call that reports it.
     */
    { key: 'meeting_done', label: 'Meeting Done', status: 'done', closes: true, conversation: true },
    /**
     * THEY DID NOT TURN UP, and that is its own fact.
     *
     * Not a conversation: nobody was reached, so it must not flatter the contact
     * rate. Not a close either — a prospect who missed a meeting is a prospect to
     * rebook, and dropping them out of the queue is a decision no rule here gets
     * to make. It is the meeting's outcome that matters, and the show rate reads
     * it: see lib/meetings.mjs.
     */
    { key: 'no_show', label: 'Meeting No Show', status: 'working', closes: false, conversation: false },
];

const OUTCOME = new Map(CALL_OUTCOMES.map((o) => [o.key, o]));

/**
 * The two channels a lead can be messaged on, beside the phone.
 *
 * Deliberately NOT an outcome: a WhatsApp or an email sent between calls is
 * not an attempt on the queue — it does not touch the no-answer streak, the
 * follow-up sequence, or the deal stage, and it does not advance the SDR to
 * the next lead. It is a note on the timeline that something else happened,
 * for the same reason a rescheduled follow-up is not a call (see
 * `rescheduleFollowUp`). Keys match `activity_types` (setup.mjs) so the
 * label a workspace has renamed is the one the timeline shows.
 */
export const MESSAGE_CHANNELS = [
    { key: 'whatsapp', label: 'WhatsApp' },
    { key: 'email', label: 'Email' },
];
const MESSAGE_CHANNEL_KEYS = new Set(MESSAGE_CHANNELS.map((c) => c.key));

/**
 * The two outcomes that leave a running follow-up sequence alone.
 *
 * Every other outcome is a conversation, and a conversation is what the sequence
 * was chasing — see the end of `logCall`. These two are the ones where the
 * conversation has not happened yet: nobody picked up, or the rep is rebooking.
 *
 * Derived from the outcome table rather than typed out, so an outcome added
 * there is opted IN to ending the sequence. That is the safe default: a new
 * outcome that means "we spoke" and was forgotten here would leave leads being
 * chased after they converted, whereas a new outcome that means "still trying"
 * announces itself the first time somebody uses it.
 */
const SEQUENCE_KEEPS_RUNNING = new Set(['no_answer', 'follow_up', 'no_show']);

export const PRIORITIES = ['A', 'B', 'C'];

/** Queue statuses that still expect work. */
const LIVE = ['queued', 'working'];

/* ------------------------------------------------------------------ scope -- */

/**
 * Which SDR's work the caller is allowed to see: their own id, or null for
 * anyone who may see the whole team.
 *
 * Returned rather than checked so that every query below has to apply it —
 * a function that returns a filter is harder to forget than a guard clause.
 */
export function scopeFor(ctx) {
    if (can(ctx, 'calling.manage')) return null;
    require$(ctx, 'calling.work');
    return ctx.userId;
}

function scopeClause(ctx, { sdrId = null } = {}) {
    const locked = scopeFor(ctx);
    if (locked) return { sql: 'AND a.assigned_to = ?', params: [locked] };
    if (sdrId) return { sql: 'AND a.assigned_to = ?', params: [sdrId] };
    return { sql: '', params: [] };
}

/* ------------------------------------------------------------- assignment -- */

/**
 * Put contacts on an SDR's list.
 *
 * Reports rather than guesses. A contact already on this SDR's list is left
 * alone; one on somebody ELSE'S list is refused and named, because silently
 * moving it would take work off a colleague's queue without telling either of
 * them. Pass `reassign` once the manager has seen the conflict and said yes.
 */
export function assignContacts(ctx, {
    contactIds = [], assignedTo, priority = 'B', campaignId = null, reassign = false, reengage = false,
} = {}) {
    /**
     * `calling.manage` runs the whole floor: any SDR's queue, either
     * direction. `calling.assign_own` (what a rep holds, separately from the
     * `calling.work` an SDR ALSO holds) is enough to put contacts on the
     * caller's OWN queue and nowhere else — a rep deciding to cold-call their
     * own lead is not the same act as reassigning the floor, and it is
     * deliberately not keyed off `calling.work` alone, or an SDR — who holds
     * that capability too, to work the queue they were given — could add to
     * it themselves.
     */
    if (!can(ctx, 'calling.manage')) {
        require$(ctx, 'calling.assign_own');
        if (assignedTo && assignedTo !== ctx.userId) {
            throw forbidden('You can only add contacts to your own calling queue.');
        }
        assignedTo = ctx.userId;
    }
    if (!assignedTo) throw badRequest('Choose an SDR to assign these contacts to.');
    if (!PRIORITIES.includes(priority)) throw badRequest(`Priority must be one of: ${PRIORITIES.join(', ')}.`);

    const target = get(
        `SELECT u.id, u.name FROM users u
           JOIN memberships m ON m.user_id = u.id AND m.workspace_id = ?
          WHERE u.id = ? AND u.status = 'active'`,
        [ctx.workspaceId, assignedTo],
    );
    if (!target) throw badRequest('That user is not an active member of this workspace.');

    const ids = [...new Set(contactIds.filter(Boolean))];
    if (!ids.length) throw badRequest('No contacts were selected.');

    const holes = ids.map(() => '?').join(',');

    // One query for the contacts, one for the existing assignments. Every
    // statement here is a network round trip, so a per-contact loop would turn
    // a 50-contact assignment into 150 of them.
    const contacts = all(
        `SELECT id, full_name, first_name, last_name, phone, account_id, owner_id
           FROM contacts
          WHERE workspace_id = ? AND deleted_at IS NULL AND id IN (${holes})`,
        [ctx.workspaceId, ...ids],
    );
    const known = new Map(contacts.map((c) => [c.id, c]));

    const existing = all(
        `SELECT a.*, u.name AS sdr_name FROM calling_assignments a
           LEFT JOIN users u ON u.id = a.assigned_to
          WHERE a.workspace_id = ? AND a.active = 1 AND a.contact_id IN (${holes})`,
        [ctx.workspaceId, ...ids],
    );
    const held = new Map(existing.map((row) => [row.contact_id, row]));

    const fresh = [];
    const conflicts = [];
    const skipped = [];
    const missing = [];
    // A lead with no number is not callable — putting it on the queue only
    // gets discovered one dead row at a time. Skipped outright rather than
    // added-then-flagged, and never reassigned either: this action is about
    // cold calling, and a contact nobody can dial is not part of it.
    const skippedNoPhone = [];

    for (const contactId of ids) {
        const contact = known.get(contactId);
        if (!contact) { missing.push(contactId); continue; }
        if (!String(contact.phone ?? '').trim()) {
            skippedNoPhone.push({ contactId, name: displayName(contact) });
            continue;
        }

        const current = held.get(contactId);
        if (!current) { fresh.push(contact); continue; }
        if (current.assigned_to === assignedTo) {
            skipped.push({ contactId, name: displayName(contact) });
            continue;
        }
        conflicts.push({
            contactId,
            name: displayName(contact),
            assignmentId: current.id,
            currentSdrId: current.assigned_to,
            currentSdrName: current.sdr_name,
        });
    }

    // Nothing is written until the manager has answered the conflict. Returning
    // the list unchanged is what lets the UI ask before anything moves.
    if (conflicts.length && !reassign) {
        return {
            assigned: 0,
            skipped,
            conflicts,
            missing,
            skippedNoPhone,
            reengage: [],
            reassigned: 0,
            needsConfirmation: true,
            sdr: { id: target.id, name: target.name },
        };
    }

    /**
     * A contact with no ACTIVE assignment can still have a DEAD one — the
     * sequence already ran its course and retired them (see markDead) — and
     * `fresh` above cannot tell that apart from someone genuinely new. Left
     * unasked, re-adding them silently grew a second full history for the
     * same person: a second assignment row, a second sequence, a second
     * "already called and retired" outcome nobody noticed until they were
     * looking straight at two rows for the one contact. This is the same
     * confirm-first shape as `conflicts` above — the difference from a
     * conflict is WHO gets asked (whoever is re-adding them, not another
     * SDR) and what the answer means (proceed anyway, not reassign).
     */
    if (fresh.length && !reengage) {
        const freshIds = fresh.map((c) => c.id);
        const priorDead = all(
            `SELECT contact_id, MAX(completed_at) AS last_completed_at, MAX(dead_at) AS dead_at
               FROM calling_assignments
              WHERE workspace_id = ? AND active = 0 AND dead_at IS NOT NULL AND contact_id IN (${freshIds.map(() => '?').join(',')})
              GROUP BY contact_id`,
            [ctx.workspaceId, ...freshIds],
        );
        if (priorDead.length) {
            const priorByContact = new Map(priorDead.map((r) => [r.contact_id, r]));
            const stillFresh = [];
            const reengageList = [];
            for (const contact of fresh) {
                const prior = priorByContact.get(contact.id);
                if (prior) {
                    reengageList.push({
                        contactId: contact.id, name: displayName(contact),
                        lastOutcomeAt: prior.dead_at ?? prior.last_completed_at ?? null,
                    });
                } else {
                    stillFresh.push(contact);
                }
            }
            if (reengageList.length) {
                return {
                    assigned: 0,
                    skipped,
                    conflicts: [],
                    reengage: reengageList,
                    missing,
                    skippedNoPhone,
                    reassigned: 0,
                    needsConfirmation: true,
                    sdr: { id: target.id, name: target.name },
                };
            }
        }
    }

    const stamp = now();
    let reassigned = 0;
    let freshIds = [];

    tx(() => {
        if (fresh.length) freshIds = insertAssignments(ctx, fresh, target.id, priority, campaignId, stamp);

        for (const conflict of conflicts) {
            run(
                `UPDATE calling_assignments
                    SET assigned_to = ?, assigned_by = ?, assigned_at = ?, priority = ?, updated_at = ?
                  WHERE id = ?`,
                [target.id, ctx.userId, stamp, priority, stamp, conflict.assignmentId],
            );
            reassigned += 1;
            audit(ctx, {
                objectKey: 'contact',
                recordId: conflict.contactId,
                action: 'calling_reassigned',
                before: { assignedTo: conflict.currentSdrId },
                after: { assignedTo: target.id },
            });
        }

        for (const contact of fresh) {
            audit(ctx, {
                objectKey: 'contact',
                recordId: contact.id,
                accountId: contact.account_id ?? null,
                action: 'calling_assigned',
                after: { assignedTo: target.id, priority },
            });
        }

        /**
         * Being put on someone's calling queue makes them the contact's owner.
         *
         * Cold calling is a relationship: whoever is dialing the phone is who
         * the CRM should point to everywhere else `owner_id` is read (record
         * lists, filters, "my contacts"). Reassigning the queue moves the
         * ownership with it, same as it moves the calling_assignments row —
         * leaving ownership behind on the old SDR would have it call a
         * contact that scoped record views no longer show as theirs.
         */
        const ownerChanges = [];
        for (const contact of fresh) {
            if (contact.owner_id !== target.id) ownerChanges.push(contact);
        }
        for (const conflict of conflicts) {
            const contact = known.get(conflict.contactId);
            if (contact && contact.owner_id !== target.id) ownerChanges.push(contact);
        }
        if (ownerChanges.length) {
            const changeHoles = ownerChanges.map(() => '?').join(',');
            run(
                `UPDATE contacts SET owner_id = ?, updated_at = ? WHERE workspace_id = ? AND id IN (${changeHoles})`,
                [target.id, stamp, ctx.workspaceId, ...ownerChanges.map((c) => c.id)],
            );
            for (const contact of ownerChanges) {
                audit(ctx, {
                    objectKey: 'contact',
                    recordId: contact.id,
                    accountId: contact.account_id ?? null,
                    action: 'contact_owner_changed',
                    before: { ownerId: contact.owner_id },
                    after: { ownerId: target.id },
                });
            }
        }

        /**
         * An assigned contact's account becomes "ready to cold call".
         *
         * The account's deal (found or created — one per account, never a
         * duplicate) moves to the ready_to_call stage, so the pipeline reads
         * the same thing the calling queue is doing. `moveDealToStage` leaves a
         * closed deal alone and is a no-op if the stage does not exist.
         */
        const accountIds = new Set();
        for (const contact of fresh) {
            if (contact.account_id) accountIds.add(contact.account_id);
        }
        for (const conflict of conflicts) {
            const contact = known.get(conflict.contactId);
            if (contact?.account_id) accountIds.add(contact.account_id);
        }
        for (const accountId of accountIds) {
            ensureReadyToCall(ctx, accountId, 'a contact was assigned to cold calling');
        }
    });

    // The SDR hears about the new work in one bell for the whole batch — see
    // notifyQueueAssigned for why per-contact would be noise.
    const totalAssigned = fresh.length + reassigned;
    if (totalAssigned > 0) {
        notifyQueueAssigned(ctx, {
            userId: target.id,
            count: totalAssigned,
            priority,
            link: queueAssignedLink({ target, stamp, freshIds, conflicts }),
        });
    }

    return {
        assigned: fresh.length,
        reassigned,
        skipped,
        conflicts: [],
        reengage: [],
        missing,
        needsConfirmation: false,
        skippedNoPhone,
        // Kept for callers still reading the old name — same count as
        // `skippedNoPhone.length`, now leads that never touched the queue
        // rather than ones added anyway and merely flagged.
        withoutPhone: skippedNoPhone.length,
        // `ensureReadyToCall` moves the ACCOUNT's deal, not the contact's —
        // a contact with no account_id has nothing for it to move, and used
        // to silently do nothing at all: added to the queue, called, worked,
        // and never once visible on the pipeline board because the board is
        // deals, and deals are accounts. Said here instead of discovered by
        // someone wondering why the count never moved.
        withoutAccount: fresh.filter((c) => !c.account_id).length,
        sdr: { id: target.id, name: target.name },
    };
}

/**
 * Where "N leads landed on your queue" should actually take you.
 *
 * One fresh (or reassigned) row — deep-link straight into the console on
 * that exact assignment, `?open=<id>`, the same param `callingWorkspace`
 * (public/js/pages/calling.js) reads on load instead of defaulting to
 * "today's next".
 *
 * More than one — the queue, pre-filtered to exactly this batch. Every
 * contact this call touched shares the one `assigned_to`/`assigned_at` this
 * function was given (`insertAssignments` and the conflict-reassign loop
 * above both stamp every row with the SAME `stamp`, once, before either
 * runs), so `assigned_to = target AND assigned_at = stamp` identifies
 * exactly this batch and nothing else — no new batch id needed. Uses the
 * queue's own filter compiler (lib/query.mjs `compileFilter`), the same
 * mechanism the "follow-ups due" link in calling.js already builds a filter
 * with, just for different fields.
 */
function queueAssignedLink({ target, stamp, freshIds, conflicts }) {
    const singleId = freshIds.length === 1 && !conflicts.length ? freshIds[0]
        : (!freshIds.length && conflicts.length === 1 ? conflicts[0].assignmentId : null);
    if (singleId) return `/calling?open=${singleId}`;

    const filter = {
        op: 'and',
        children: [
            { field: 'assigned_to', operator: 'is_any_of', value: [target.id] },
            { field: 'assigned_at', operator: 'at_or_after', value: stamp },
            { field: 'assigned_at', operator: 'at_or_before', value: stamp },
        ],
    };
    return `/calling?tab=to_call&filter=${encodeURIComponent(JSON.stringify(filter))}`;
}

/**
 * A contact on the calling queue reads as "ready to cold call" on the deal.
 *
 * The account's deal — found or created, one per account, never a duplicate —
 * moves to the `ready_to_call` stage, so the pipeline shows the same thing the
 * calling queue is doing. `moveDealToStage` leaves a closed deal alone and is a
 * no-op if the stage does not exist, so this is safe to run over an existing
 * queue (see `backfill-ready-to-call.mjs`) as well as on assignment.
 */
export function ensureReadyToCall(ctx, accountId, because = 'a contact was assigned to cold calling') {
    if (!accountId) return null;
    const deal = ensureDealForAccount(ctx, accountId, because);
    // Forward-only: re-adding a contact to cold calling on an account whose
    // deal has already moved on (Negotiation, Contracting, ...) must not
    // drag it back to the first stage. `moveDealToStage` has no such guard
    // — `advanceDealToStage` is the one that refuses to move a deal to an
    // earlier position than the one it is already at.
    if (deal) advanceDealToStage(ctx, deal.id, 'ready_to_call', because);
    return deal;
}

/** Multi-row inserts, so 50 contacts cost one round trip rather than 50. */
/** Returns the new assignment ids, in the same order as `contacts` — the
 * caller (`assignContacts`) uses them to deep-link a single fresh lead's
 * notification straight to its console row. */
function insertAssignments(ctx, contacts, assignedTo, priority, campaignId, stamp) {
    const COLUMNS = [
        'id', 'workspace_id', 'contact_id', 'account_id', 'assigned_to', 'assigned_by',
        'assigned_at', 'queue_status', 'priority', 'campaign_id', 'active', 'created_at', 'updated_at',
    ];
    const PER_REQUEST = 60;
    const assignmentIds = [];

    for (let i = 0; i < contacts.length; i += PER_REQUEST) {
        const batch = contacts.slice(i, i + PER_REQUEST);
        const batchIds = batch.map(() => id('cas'));
        const values = batch.flatMap((contact, j) => [
            batchIds[j], ctx.workspaceId, contact.id, contact.account_id ?? null, assignedTo, ctx.userId,
            stamp, 'queued', priority, campaignId, 1, stamp, stamp,
        ]);
        run(
            `INSERT INTO calling_assignments (${COLUMNS.join(',')}) VALUES `
            + batch.map(() => `(${COLUMNS.map(() => '?').join(',')})`).join(','),
            values,
        );
        assignmentIds.push(...batchIds);
    }
    return assignmentIds;
}

/* -------------------------------------------------------------- the queue -- */

function toCallClause(nowIso) {
    const safe = String(nowIso ?? now()).replace(/'/g, "''");
    return `AND a.queue_status IN ('queued','working') AND (a.last_outcome IS NULL OR a.last_outcome IN ('no_answer','no_show') OR (a.last_outcome = 'follow_up' AND a.next_follow_up_at IS NOT NULL AND a.next_follow_up_at <= '${safe}'))`;
}

const TABS = {
    /**
     * Still needs a call — not just "not yet closed".
     *
     * A lead that has never been rung (`last_outcome IS NULL`, still
     * `queued`) belongs here, and so does one whose most recent call was a
     * No Answer or a Meeting No Show — both mean "try again". A Follow Up
     * belongs here ONLY when its scheduled time has arrived (due now or
     * past due); a Follow Up booked for tomorrow is not a call still owed
     * today — it lives in the Follow-ups tab until its time comes. That is
     * the distinction "not due not in To call, only in Follow up" enforces.
     *
     * Every OTHER outcome that leaves the assignment `working` (Qualified,
     * Meeting Scheduled, Send Profile) is real progress on the call that
     * was already made, not a call still owed, and used to sit here anyway
     * because `queue_status` alone cannot tell the two apart — every
     * non-closing outcome sets it to the same 'working'. That put an
     * already-qualified lead back at the top of "who to call next", asking
     * someone to ring a person they had just spoken to.
     *
     * Deliberately NOT the same fix as `closes`/`active` in `logCall` — this
     * only narrows which TAB a live assignment shows under, and leaves it
     * exactly as active and callable as before. See the comment on `qualified`
     * in `CALL_OUTCOMES` for why closing the assignment itself stays untouched.
     */
    to_call: toCallClause,
    // Every lead currently mid-sequence — not only the ones whose next step
    // happens to be due today. A rep working their list needs to see the
    // whole follow-up book, including the ones due later this week, not
    // just today's slice of it.
    follow_ups: `AND a.queue_status IN ('queued','working') AND a.sequence_started_at IS NOT NULL AND a.sequence_completed_at IS NULL AND a.dead_at IS NULL`,
    completed: `AND a.queue_status IN ('done','closed')`,
    /**
     * Leads that finished the four-step sequence without converting.
     *
     * They had nowhere to be. `dead` is its own queue status, and it matched
     * none of the three tabs above — so a lead the automation marked dead
     * disappeared from every view the calling screen offers, which is
     * indistinguishable from the software having lost it. A manager reviewing
     * why a month produced nothing needs exactly this list.
     */
    dead: `AND a.queue_status = 'dead'`,
    /**
     * Every assignment the module still tracks — queued, working, done,
     * closed or dead — but NOT one taken off the list.
     *
     * This used to be no filter at all, which meant `removeFromQueue`
     * (queue_status → 'removed') took a lead off every other tab but left it
     * inflating this one forever: a manager removing a whole list watched
     * "To call" drop by the right amount while "All" never moved, because
     * 'removed' rows have no tab of their own and this one counted them
     * anyway. 'removed' means gone from the module by definition — see
     * `closeMany`'s own comment ("They come off the calling screen for
     * everyone") — so it is excluded here the same as it is everywhere else.
     */
    all: `AND a.queue_status != 'removed'`,
};

/**
 * One SDR's queue, or the whole team's for a manager.
 *
 * Joins the contact so the caller gets a name and a number without a second
 * request per row, and returns only the fields the calling screen shows. An SDR
 * has no business receiving a whole contact record here.
 */
/**
 * The queue's own quick search — a name, a company, or a phone number, in
 * one box, separate from the Filters builder's exact-field conditions.
 *
 * Phone is matched digit-normalized (see lib/phone.mjs) rather than as
 * literal text, for the same reason global search is: "+20 2 555 0199",
 * "0225550199" and "20-2-555-0199" are one number typed three ways, and a
 * plain `LIKE '%q%'` against the stored, formatted column would only ever
 * match the one someone happened to type identically.
 *
 * The phone condition is skipped below two digits rather than run with an
 * empty string — `phone_digits LIKE '%%'` matches every row with ANY phone
 * number at all, which would make a text search for "smith" silently match
 * every phoned contact in the workspace once OR'd in.
 */
function queueSearchClause(q) {
    const trimmed = String(q ?? '').trim();
    if (!trimmed) return null;
    const like = `%${trimmed.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const parts = [`c.full_name LIKE ? ESCAPE '\\'`, `acc.name LIKE ? ESCAPE '\\'`];
    const params = [like, like];
    // Every digit reading worth trying — the literal digits, and (if the
    // query looks locally-dialled) the same digits with a leading trunk
    // zero stripped. See phoneMatchCandidates in lib/phone.mjs.
    for (const digits of phoneMatchCandidates(trimmed)) {
        parts.push(`${phoneDigitsSql('c.phone')} LIKE ?`);
        params.push(`%${digits}%`);
    }
    return { sql: `(${parts.join(' OR ')})`, params };
}

export function queue(ctx, {
    sdrId = null, performedBy = null, tab = 'to_call', page = 1, limit = 50, filter = null, sort = null, from = null, to = null,
    q = null,
} = {}) {
    if (!Object.hasOwn(TABS, tab)) throw badRequest(`Unknown tab "${tab}".`);
    const nowIso = now();
    const tabSql = typeof TABS[tab] === 'function' ? TABS[tab](nowIso) : TABS[tab];
    const scope = scopeClause(ctx, { sdrId });
    const size = Math.min(200, Math.max(1, Number(limit) || 50));
    const offset = (Math.max(1, Number(page) || 1) - 1) * size;

    /**
     * The same filter builder every list has, compiled onto this query.
     *
     * Aliased `a`, matching the query below, and applied INSIDE the scope
     * clause rather than instead of it — a filter narrows what somebody may
     * already see and can never widen it, so an SDR filtering the queue still
     * cannot reach another SDR's rows.
     */
    const compiled = filter ? compileFilter('calling_assignment', ctx.workspaceId, filter, 'a') : null;

    /**
     * A date range scopes the queue by CALLS, not by the assignment.
     *
     * "Who was called in this period" is a question about the activities — an
     * assignment has no single call date, because a contact rung four times has
     * four of them. So the range joins the calls in the period, keeps only
     * assignments that had at least one, and carries the latest of them out as
     * the row's call date: the Completed tab then shows WHEN each contact was
     * called, and every tab answers who the team actually worked that week.
     */
    const ranged = from && to;
    const rangeJoin = ranged ? `
        LEFT JOIN (SELECT assignment_id, MAX(occurred_at) AS called_at
                     FROM activities
                    WHERE type_key = 'call' AND deleted_at IS NULL
                      AND occurred_at >= ? AND occurred_at < ?
                    GROUP BY assignment_id) rc ON rc.assignment_id = a.id` : '';
    const rangeSelect = ranged ? ', rc.called_at AS in_range_called_at' : '';
    const rangeWhere = ranged ? ' AND rc.assignment_id IS NOT NULL' : '';
    /**
     * WHO RANG THEM, as distinct from whose queue it is (`scope`/`sdrId`).
     *
     * A manager covering one call on a colleague's list, or a queue reassigned
     * mid-week, means "assigned to" and "actually called by" can name different
     * people — the question this answers on its own, next to the assignee
     * filter it mirrors.
     */
    const performedWhere = performedBy ? ' AND a.last_called_by = ?' : '';
    const search = queueSearchClause(q);

    const where = `a.workspace_id = ? ${scope.sql} ${tabSql}${rangeWhere}${performedWhere}`
        + (compiled ? ` AND (${compiled.sql})` : '')
        + (search ? ` AND ${search.sql}` : '');
    const params = [
        ...(ranged ? [from, to] : []),
        ctx.workspaceId, ...scope.params,
        ...(performedBy ? [performedBy] : []),
        ...(compiled ? compiled.params : []),
        ...(search ? search.params : []),
    ];

    /**
     * The calling order, unless somebody asked for another.
     *
     * High priority first, then whatever is due, then anything never called —
     * that is the order to work a queue in, not an arbitrary default, so a
     * request with no sort keeps it.
     */
    const orderBy = compileSort('calling_assignment', ctx.workspaceId, sort, 'a')
         ?? `CASE a.priority WHEN 'A' THEN 0 WHEN 'B' THEN 1 ELSE 2 END,
            a.next_follow_up_at IS NULL, a.next_follow_up_at,
            a.last_called_at IS NOT NULL, a.assigned_at`;

    // Counted through the same joins as the rows: a filter on the company name
    // reaches `accounts`, and a total that ignored the join would not match the
    // list underneath it.
    const total = get(
        `SELECT COUNT(*) AS n
           FROM calling_assignments a
           JOIN contacts c ON c.id = a.contact_id AND c.deleted_at IS NULL
           LEFT JOIN accounts acc ON acc.id = a.account_id
           LEFT JOIN users u ON u.id = a.assigned_to
           ${rangeJoin}
          WHERE ${where}`,
        params,
    )?.n ?? 0;

    const rows = all(
        `SELECT a.id, a.contact_id, a.account_id, a.queue_status, a.priority, a.call_count,
                a.last_called_at, a.last_outcome, a.last_called_by, a.next_follow_up_at, a.assigned_to,
                c.full_name, c.first_name, c.last_name, c.title, c.phone, c.email, c.linkedin_url,
                c.services,
                acc.name AS account_name, u.name AS sdr_name${rangeSelect},
                /**
                 * The Notes column (lib/objects.mjs) — whichever of THREE
                 * kinds of note is most recent, not a list of them:
                 *
                 *   · a note on the CONTACT (the Notes tab on their record)
                 *   · a note on their ACCOUNT (context that applies to
                 *     everyone calling that company, not just this person)
                 *   · the quick note typed while logging a CALL outcome
                 *     (stored as that call's own activity body, not in the
                 *     notes table at all)
                 *
                 * A rep glancing at the queue wants "what do I need to know
                 * before I dial", and that could be any of the three — an
                 * account-wide warning is exactly as relevant as something
                 * said about this person, and a note from the last call is
                 * often the freshest of all. A UNION ALL ranked by when each
                 * one landed, rather than three separate columns, because
                 * only the winner is ever shown.
                 */
                (SELECT body FROM (
                    SELECT n.body AS body, n.created_at AS at
                      FROM notes n
                     WHERE n.parent_type = 'contact' AND n.parent_id = a.contact_id AND n.deleted_at IS NULL
                    UNION ALL
                    SELECT n.body AS body, n.created_at AS at
                      FROM notes n
                     WHERE a.account_id IS NOT NULL AND n.parent_type = 'account' AND n.parent_id = a.account_id
                       AND n.deleted_at IS NULL
                    UNION ALL
                    SELECT act.body AS body, act.occurred_at AS at
                      FROM activities act
                     WHERE act.type_key = 'call' AND act.parent_type = 'contact' AND act.parent_id = a.contact_id
                       AND act.deleted_at IS NULL AND act.body IS NOT NULL AND TRIM(act.body) <> ''
                 ) combined
                 ORDER BY at DESC LIMIT 1) AS notes
           FROM calling_assignments a
           JOIN contacts c ON c.id = a.contact_id AND c.deleted_at IS NULL
           LEFT JOIN accounts acc ON acc.id = a.account_id
           LEFT JOIN users u ON u.id = a.assigned_to
           ${rangeJoin}
          WHERE ${where}
          ORDER BY ${orderBy}
          LIMIT ? OFFSET ?`,
        [...params, size, offset],
    );

    return {
        tab,
        total,
        page: Math.max(1, Number(page) || 1),
        pages: Math.max(1, Math.ceil(total / size)),
        /**
         * Both shapes of key on every row.
         *
         * The call console reads `lastCalledAt` and `sdrName`; the shared table
         * and column picker read the field registry's names, which are the
         * column names. Returning the raw row alongside the presented one costs
         * a few bytes and saves rewriting a console that works.
         */
        items: rows.map((row) => ({ ...row, ...present(row) })),
    };
}

/**
 * Every contact id matching the current tab/filter/sdr — not just the page.
 *
 * The queue table caps `limit` at 200 (see `queue()`), which is right for
 * rendering rows and wrong for "select all matching": a manager reassigning a
 * departing SDR's whole queue is choosing among however many that is, not the
 * first 200. Same WHERE clause as `queue()`, minus the joins a list of ids
 * does not need. Capped at 20000, matching the limit `bulk()` in
 * lib/repo.mjs uses for the same reason — a mis-set filter should not be able
 * to move the entire workspace in one click.
 */
export function queueContactIds(ctx, {
    sdrId = null, performedBy = null, tab = 'to_call', filter = null, from = null, to = null, q = null,
} = {}) {
    if (!Object.hasOwn(TABS, tab)) throw badRequest(`Unknown tab "${tab}".`);
    const nowIso = now();
    const tabSql = typeof TABS[tab] === 'function' ? TABS[tab](nowIso) : TABS[tab];
    const scope = scopeClause(ctx, { sdrId });
    const compiled = filter ? compileFilter('calling_assignment', ctx.workspaceId, filter, 'a') : null;

    const ranged = from && to;
    const rangeJoin = ranged ? `
        LEFT JOIN (SELECT assignment_id, MAX(occurred_at) AS called_at
                     FROM activities
                    WHERE type_key = 'call' AND deleted_at IS NULL
                      AND occurred_at >= ? AND occurred_at < ?
                    GROUP BY assignment_id) rc ON rc.assignment_id = a.id` : '';
    const rangeWhere = ranged ? ' AND rc.assignment_id IS NOT NULL' : '';
    const performedWhere = performedBy ? ' AND a.last_called_by = ?' : '';
    // "Select all matching" has to match the same criteria the rows on
    // screen do, so the quick search is a first-class part of this WHERE
    // clause too, not a page-local filter the bulk action silently ignores.
    const search = queueSearchClause(q);

    const where = `a.workspace_id = ? ${scope.sql} ${tabSql}${rangeWhere}${performedWhere}`
        + (compiled ? ` AND (${compiled.sql})` : '')
        + (search ? ` AND ${search.sql}` : '');
    const params = [
        ...(ranged ? [from, to] : []),
        ctx.workspaceId, ...scope.params,
        ...(performedBy ? [performedBy] : []),
        ...(compiled ? compiled.params : []),
        ...(search ? search.params : []),
    ];

    const rows = all(
        `SELECT a.contact_id
           FROM calling_assignments a
           JOIN contacts c ON c.id = a.contact_id AND c.deleted_at IS NULL
           LEFT JOIN accounts acc ON acc.id = a.account_id
           ${rangeJoin}
          WHERE ${where}
          LIMIT 20000`,
        params,
    );
    return rows.map((r) => r.contact_id);
}

/** The counts behind the tabs, in one round trip rather than four. */
export function queueCounts(ctx, { sdrId = null, from = null, to = null, filter = null } = {}) {
    const scope = scopeClause(ctx, { sdrId });
    const ranged = from && to;
    const nowIso = now();
    const safeNow = String(nowIso).replace(/'/g, "''");
    /**
     * The same call-scoped range as `queue()`, applied to every count.
     *
     * A manager scoping the Completed tab to a week wants the Completed pill to
     * say the same thing the list does — otherwise the number on the button and
     * the number of rows answer different questions about the same screen.
     */
    const rangeWhere = ranged ? ` AND EXISTS (SELECT 1 FROM activities x
            WHERE x.assignment_id = a.id AND x.type_key = 'call' AND x.deleted_at IS NULL
              AND x.occurred_at >= ? AND x.occurred_at < ?)` : '';
    /**
     * The same filter builder as `queue()`, applied to every count for the
     * same reason the range is: a manager who has just narrowed the queue to
     * Priority A expects the pills over the tabs to count Priority A leads,
     * not the whole book. Left unapplied here, the table narrowed on every
     * click while "To call 45 · All 45" sat frozen beside it looking like
     * the filter had done nothing — which is exactly what got reported as
     * "the priority filter isn't working".
     */
    const compiled = filter ? compileFilter('calling_assignment', ctx.workspaceId, filter, 'a') : null;
    const filterWhere = compiled ? ` AND (${compiled.sql})` : '';
    /**
     * Joined to `contacts` and counted through 'removed', exactly as
     * `queue()` and `queueContactIds()` are — three separate queries that
     * each decide who's still in the module, which is three chances for
     * them to disagree. This one used to have neither: a row for a
     * soft-deleted contact, or one taken off the list (`queue_status =
     * 'removed'`), was invisible in every tab's row list yet still counted
     * itself into that tab's badge, so the number over a tab and the rows
     * under it answered different questions.
     */
    // Matches TABS.to_call above: still owed a call, not merely 'working'.
    // A follow_up that is not yet due lives only in Follow-ups, not in To call.
    const row = get(
        `SELECT
            SUM(CASE WHEN a.queue_status IN ('queued','working')
                      AND (a.last_outcome IS NULL OR a.last_outcome IN ('no_answer','no_show') OR (a.last_outcome = 'follow_up' AND a.next_follow_up_at IS NOT NULL AND a.next_follow_up_at <= '${safeNow}'))
                      THEN 1 ELSE 0 END) AS to_call,
            SUM(CASE WHEN a.queue_status IN ('queued','working')
                      AND a.sequence_started_at IS NOT NULL AND a.sequence_completed_at IS NULL
                      AND a.dead_at IS NULL THEN 1 ELSE 0 END) AS follow_ups,
            SUM(CASE WHEN a.queue_status IN ('done','closed') THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN a.queue_status = 'dead' THEN 1 ELSE 0 END) AS dead,
            SUM(CASE WHEN a.call_count = 0 THEN 1 ELSE 0 END) AS never_called,
            SUM(CASE WHEN a.queue_status != 'removed' THEN 1 ELSE 0 END) AS all_assigned
           FROM calling_assignments a
           JOIN contacts c ON c.id = a.contact_id AND c.deleted_at IS NULL
          WHERE a.workspace_id = ? ${scope.sql}${rangeWhere}${filterWhere}`,
        [ctx.workspaceId, ...scope.params, ...(ranged ? [from, to] : []), ...(compiled ? compiled.params : [])],
    ) ?? {};

    return {
        to_call: row.to_call ?? 0,
        follow_ups: row.follow_ups ?? 0,
        completed: row.completed ?? 0,
        dead: row.dead ?? 0,
        never_called: row.never_called ?? 0,
        all: row.all_assigned ?? 0,
    };
}

/**
 * One assignment, with the contact and this contact's call history.
 *
 * Scoped like everything else: an SDR asking for an id that belongs to somebody
 * else gets the same answer as one asking for an id that does not exist, which
 * is deliberate — a 403 here would confirm the row is real.
 */
export function assignment(ctx, assignmentId) {
    const scope = scopeClause(ctx);
    const row = get(
        `SELECT a.*, c.full_name, c.first_name, c.last_name, c.title, c.phone, c.email, c.linkedin_url,
                c.services,
                acc.name AS account_name, u.name AS sdr_name
           FROM calling_assignments a
           JOIN contacts c ON c.id = a.contact_id
           LEFT JOIN accounts acc ON acc.id = a.account_id
           LEFT JOIN users u ON u.id = a.assigned_to
          WHERE a.workspace_id = ? AND a.id = ? ${scope.sql}`,
        [ctx.workspaceId, assignmentId, ...scope.params],
    );
    if (!row) throw notFound('That contact is not in your calling queue.');
    return {
        ...present(row),
        history: callHistory(ctx, row.contact_id),
        // The follow-up sequence in full: every step, its due date and
        // whether it is done. This is the answer to "what next, and when".
        sequence: sequenceStatus(ctx, row),
    };
}

/**
 * Every call AND message ever made to this contact, newest first. Never
 * truncated by status.
 *
 * Calls and messages (see `MESSAGE_CHANNELS`) share one timeline because an
 * SDR reading "what have we already done with this person" needs the
 * WhatsApp between the two calls, not just the calls either side of it. A
 * message row carries `type`/`typeLabel` and no `outcome` — the two are
 * told apart on that, not on a second flag.
 */
export function callHistory(ctx, contactId, { limit = 20 } = {}) {
    const typeKeys = [CALL_TYPE, ...MESSAGE_CHANNELS.map((c) => c.key)];
    return all(
        `SELECT v.id, v.type_key, v.outcome, v.subject, v.body AS note, v.occurred_at,
                v.next_follow_up_at, v.properties, u.name AS performed_by_name
           FROM activities v
           LEFT JOIN users u ON u.id = v.actor_id
          WHERE v.workspace_id = ? AND v.type_key IN (${typeKeys.map(() => '?').join(',')})
            AND v.parent_type = 'contact' AND v.parent_id = ? AND v.deleted_at IS NULL
          ORDER BY v.occurred_at DESC
          LIMIT ?`,
        [ctx.workspaceId, ...typeKeys, contactId, Math.min(100, Math.max(1, limit))],
    ).map((row) => ({
        id: row.id,
        type: row.type_key,
        outcome: row.outcome,
        outcomeLabel: row.type_key === CALL_TYPE ? (OUTCOME.get(row.outcome)?.label ?? row.outcome) : row.subject,
        note: row.note,
        at: row.occurred_at,
        nextFollowUpAt: row.next_follow_up_at,
        meetingAt: json(row.properties, {}).meetingAt ?? null,
        by: row.performed_by_name,
    }));
}

/* ---------------------------------------------------------------- calling -- */

/**
 * Move a follow-up to a different date and time.
 *
 * ── WHY THIS IS NOT AN UPDATE TO ONE COLUMN ─────────────────────────────────
 *
 * "They asked me to ring on Thursday instead" changes FIVE things, and a screen
 * that wrote only the obvious one would leave the other four saying Tuesday:
 *
 *   the assignment's next_follow_up_at   what the queue and the Due tab read
 *   the first follow-up task's due date  what the rep is actually handed
 *   the WhatsApp after it                end of the NEW day, not the old one
 *   the second follow-up                 exactly seven days after the new date
 *   the WhatsApp after THAT              end of that day
 *
 * So a reschedule is the schedule recomputed from the new instant — the same
 * function that built it in the first place (`scheduleFrom`) — and the steps
 * already DONE are left exactly where they are. Rewriting the due date of a
 * follow-up somebody already made would falsify the history to tidy the future.
 *
 * ── WHO CAN DO IT ───────────────────────────────────────────────────────────
 *
 * Whoever can work the queue entry. This is not a privileged act: the person on
 * the phone is the person being told to call back later, and needing a manager
 * to type a date is how a CRM ends up with follow-ups everyone knows are wrong.
 * The scoped reader still applies, so an SDR cannot reschedule somebody else's.
 */
export function rescheduleFollowUp(ctx, assignmentId, followUpAt) {
    require$(ctx, can(ctx, 'calling.manage') ? 'calling.manage' : 'calling.work');

    const current = assignmentRow(ctx, assignmentId);
    if (current.dead_at) {
        throw badRequest('This lead is dead. Reschedule is for a live follow-up — add the contact to a queue again to start over.');
    }

    const timezone = ctx.workspace?.timezone || 'UTC';
    const configuredStart = Number(setting(ctx.workspaceId, 'follow_up_day_start_hour'));
    const dayStartHour = Number.isInteger(configuredStart) ? configuredStart : DEFAULT_DAY_START_HOUR;

    if (!followUpAt) throw badRequest('A follow-up needs a date and a time. Pick when to ring back.');
    const instant = normalizeFollowUpAt(followUpAt, { timezone, dayStartHour });
    if (!instant) throw badRequest(unreadable(followUpAt, 'follow-up'));
    if (instant <= now()) {
        throw badRequest('A follow-up cannot be in the past. Pick a future date and time — that is when this contact comes back.');
    }

    const before = current.next_follow_up_at;
    const moved = rescheduleSequence(ctx, current, instant, {
        timezone,
        dayStartHour,
        dayEndHour: Number(setting(ctx.workspaceId, 'follow_up_day_end_hour')) || undefined,
    });

    const stamp = now();
    tx(() => {
        run(
            `UPDATE calling_assignments
                SET next_follow_up_at = ?, queue_status = CASE WHEN queue_status = 'queued' THEN 'working' ELSE queue_status END,
                    updated_at = ?
              WHERE id = ?`,
            [instant, stamp, current.id],
        );
        /**
         * On the timeline, because a date that moved is a fact about the
         * relationship. "They pushed us to next week twice" is a pattern worth
         * seeing, and a column that only holds the latest value cannot show it.
         */
        run(
            `INSERT INTO activities
               (id, workspace_id, parent_type, parent_id, account_id, type_key, subject, body,
                occurred_at, actor_id, source, properties, next_follow_up_at, assignment_id, created_at, updated_at)
             VALUES (?,?,'contact',?,?,'note',?,?,?,?,'ui','{}',?,?,?,?)`,
            [
                id('act'), ctx.workspaceId, current.contact_id, current.account_id ?? null,
                'Follow-up rescheduled',
                `Moved${before ? ` from ${before}` : ''} to ${instant}.`
                + (moved.steps ? ` ${moved.steps} remaining ${moved.steps === 1 ? 'step' : 'steps'} moved with it.` : ''),
                stamp, ctx.userId ?? null, instant, current.id, stamp, stamp,
            ],
        );
        audit(ctx, {
            objectKey: 'contact',
            recordId: current.contact_id,
            accountId: current.account_id ?? null,
            action: 'follow_up_rescheduled',
            before: { nextFollowUpAt: before },
            after: { nextFollowUpAt: instant, stepsMoved: moved.steps },
        });
    });

    return { assignment: assignment(ctx, assignmentId), rescheduled: instant, stepsMoved: moved.steps };
}

/**
 * Record one call.
 *
 * Appends an activity and moves the assignment on. The activity is the record;
 * the columns it updates on the assignment are a convenience for drawing the
 * queue, and are never what a report counts.
 *
 * `idempotencyKey` makes a double-click harmless. The driver blocks, so two
 * clicks are genuinely two requests arriving in order, and without this the
 * second would append a second identical call. The unique index on the key is
 * what enforces it — a check-then-insert would still race.
 */
export function logCall(ctx, {
    assignmentId, outcome, note = '', followUpAt = null, meetingAt = null, idempotencyKey = null,
    nextStep = null,
} = {}) {
    require$(ctx, can(ctx, 'calling.manage') ? 'calling.manage' : 'calling.work');

    const effect = OUTCOME.get(outcome);
    if (!effect) {
        throw badRequest(`Unknown outcome "${outcome}". One of: ${CALL_OUTCOMES.map((o) => o.key).join(', ')}.`);
    }

    // Fetched through the scoped reader, so an SDR cannot log a call against
    // somebody else's assignment by sending its id.
    const current = assignmentRow(ctx, assignmentId);

    /**
     * A FOLLOW-UP IS A DATE AND A TIME, and this is where that is enforced.
     *
     * "Ring them back on the fifteenth at half two" is the commitment the rep
     * made on the phone, so the minute has to survive the trip: it becomes the
     * assignment's `next_follow_up_at`, the first task's due date, and the
     * instant the other three steps are measured from — all from ONE normalised
     * value, so no two of them can disagree.
     *
     * Normalising here rather than in the browser is the difference between a
     * date picker and a rule. A caller that sends a bare date still gets the
     * start of the working day (see `normalizeFollowUpAt`); one that sends
     * something unreadable is refused, because the alternative is what used to
     * happen — the text went into the column, the string comparison that drives
     * the Follow-ups Due tab quietly stopped matching, and the sequence created
     * no tasks at all. A follow-up that schedules nothing is worse than an error
     * message, because nobody finds out for a week.
     */
    const timezone = ctx.workspace?.timezone || 'UTC';
    // `|| DEFAULT` would turn a workspace that starts at midnight into 9am. The
    // hour is validated again inside `normalizeFollowUpAt`, which owns the range.
    const configuredStart = Number(setting(ctx.workspaceId, 'follow_up_day_start_hour'));
    const dayStartHour = Number.isInteger(configuredStart) ? configuredStart : DEFAULT_DAY_START_HOUR;

    let followUpInstant = null;
    if (effect.requires === 'followUpAt') {
        if (!followUpAt) {
            throw badRequest('A follow-up needs a date and a time, otherwise nothing brings this contact back.');
        }
        followUpInstant = normalizeFollowUpAt(followUpAt, { timezone, dayStartHour });
        if (!followUpInstant) throw badRequest(unreadable(followUpAt, 'follow-up'));
        /**
         * A follow-up in the past books nothing — it is a task already overdue on
         * the day it is created, and the only honest reading of a date that has
         * already passed is "this should have been done yesterday".
         */
        if (followUpInstant <= now()) {
            throw badRequest('A follow-up cannot be in the past. Choose a future date and time — that is the moment this contact comes back to you.');
        }
    }

    let meetingInstant = null;
    if (effect.requires === 'meetingAt') {
        if (!meetingAt) throw badRequest('A scheduled meeting needs a date and time.');
        // Same treatment: a meeting at "midnight" is a meeting nobody booked.
        meetingInstant = normalizeFollowUpAt(meetingAt, { timezone, dayStartHour });
        if (!meetingInstant) throw badRequest(unreadable(meetingAt, 'meeting'));
    }

    if (idempotencyKey) {
        const already = get(
            `SELECT id FROM activities WHERE workspace_id = ? AND idempotency_key = ?`,
            [ctx.workspaceId, idempotencyKey],
        );
        // Already recorded. Answer as though this call succeeded, because from
        // the SDR's point of view it did.
        if (already) return { activityId: already.id, duplicate: true, assignment: assignment(ctx, assignmentId) };
    }

    const stamp = now();
    const activityId = id('act');
    /**
     * What is next, as an instant.
     *
     * A meeting is the next thing due, so it drives the follow-up queue too —
     * otherwise a booked meeting is invisible until somebody remembers it. Both
     * branches store the NORMALISED value: the Follow-ups Due tab compares this
     * column against `now()` as text, and a bare "2026-09-15" sorts before every
     * instant on that day, so a follow-up booked for 2pm read as due since
     * midnight.
     */
    const nextAt = effect.requires === 'meetingAt' ? meetingInstant : (followUpInstant ?? null);

    /**
     * THREE UNANSWERED CALLS IN A ROW AND THE LEAD IS DEAD.
     *
     * A number that has not picked up three times running is not a lead, it is a
     * queue slot somebody keeps paying for. So the streak is counted here and the
     * assignment is retired the moment it reaches the workspace's limit — nobody
     * has to notice, and no rep has to decide to give up.
     *
     * ── CONSECUTIVE, AND WHAT RESETS IT ─────────────────────────────────────
     *
     * Any other outcome sets it back to zero. Somebody who answers on the fourth
     * attempt is a live lead whatever the first three did, and a rule that
     * counted no-answers in total would eventually retire every hard-to-reach
     * client the floor has ever converted.
     *
     * Held as a COLUMN rather than counted from the activities, because two calls
     * logged in the same millisecond cannot be ordered by time — the stamps are
     * ISO milliseconds — and "the last three activities" would then occasionally
     * be the wrong three. Incremented inside the same UPDATE that records the
     * call, so the streak and the call it came from cannot disagree.
     */
    const noAnswerLimit = attemptsBeforeDead(ctx);
    const streak = outcome === 'no_answer' ? (Number(current.no_answer_streak) || 0) + 1 : 0;
    const exhausted = outcome === 'no_answer' && streak >= noAnswerLimit;

    /**
     * A follow-up lead that ENGAGES is completed, not left in the queue.
     *
     * Any outcome other than No Answer or a fresh Follow Up is a conversation,
     * and a conversation is what the four-step sequence existed to produce —
     * so the sequence tasks are closed (`completeSequence` below) and the
     * ASSIGNMENT is marked done too, so the lead reads as Completed rather
     * than still-to-work. Dead is for a lead that ran out of road; this is a
     * lead that reached its destination.
     */
    // Started AND still running — a sequence that already finished (engaged
    // or died) must not be re-triggered by a later, unrelated outcome on the
    // same assignment. `sequence_started_at` alone stays set forever once a
    // sequence has ever run, so checking only that kept treating a lead as
    // "in sequence" long after the sequence itself was over.
    const inSequence = Boolean(current.sequence_started_at) && !current.sequence_completed_at && !current.dead_at;
    const engages = inSequence && !exhausted && !SEQUENCE_KEEPS_RUNNING.has(outcome);
    const finalStatus = engages ? 'done' : effect.status;
    const finalActive = engages ? 0 : (effect.closes ? 0 : 1);
    const finalCompletedAt = engages || effect.closes ? stamp : null;

    tx(() => {
        run(
            `INSERT INTO activities
               (id, workspace_id, parent_type, parent_id, account_id, type_key, subject, body,
                occurred_at, direction, actor_id, source, properties,
                outcome, next_follow_up_at, assignment_id, idempotency_key,
                meeting_at, meeting_status, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
                activityId, ctx.workspaceId, 'contact', current.contact_id, current.account_id ?? null,
                CALL_TYPE, effect.label, String(note ?? '').trim() || null,
                stamp, 'outbound', ctx.userId, 'ui',
                JSON.stringify(meetingInstant ? { meetingAt: meetingInstant } : {}),
                outcome, nextAt, current.id, idempotencyKey,
                /**
                 * A BOOKED MEETING IS A MEETING RECORD, from the moment it is
                 * booked.
                 *
                 * `meeting_at` is when it will be held — not `occurred_at`, which
                 * is when this call happened. Reports about meetings date them by
                 * the first, so a meeting booked on the 30th for the 3rd belongs
                 * to the month it is actually in. It starts as `scheduled`, which
                 * reads as Upcoming until its time passes; nothing but a person
                 * moves it to done or no_show. See lib/meetings.mjs.
                 */
                meetingInstant, meetingInstant ? 'scheduled' : null,
                stamp, stamp,
            ],
        );

        run(
            `UPDATE calling_assignments
                SET call_count = call_count + 1,
                    last_called_at = ?, last_outcome = ?, last_called_by = ?, next_follow_up_at = ?,
                    queue_status = ?, active = ?, completed_at = ?,
                    no_answer_streak = ?, updated_at = ?
              WHERE id = ?`,
            [
                stamp, outcome, ctx.userId, nextAt, finalStatus,
                finalActive,
                finalCompletedAt,
                streak, stamp, current.id,
            ],
        );

        audit(ctx, {
            objectKey: 'contact',
            recordId: current.contact_id,
            accountId: current.account_id ?? null,
            action: 'call_logged',
            after: { outcome, nextFollowUpAt: nextAt, activityId, noAnswerStreak: streak },
        });

        /**
         * THE MEETING'S OWN STATE, kept on the meeting rather than inferred.
         *
         * Booking one moves the deal into Meeting: the pipeline is meant to show
         * where the relationship actually is, and a meeting in the diary IS that
         * stage. Nobody should have to drag a card to say what the CRM already
         * knows.
         *
         * Marking one Done or No Show settles the meeting that was booked — the
         * activity carrying `meeting_at` — so the show rate is read off recorded
         * facts. No Show is never derived from the absence of a Done: a meeting
         * that has not happened yet, and one nobody has classified, are different
         * things from one the prospect missed, and only a person can tell them
         * apart. See lib/meetings.mjs.
         */
        if (outcome === 'meeting_scheduled' && meetingInstant) {
            moveDealToStage(
                ctx, dealIdFor(ctx, current), 'meeting_scheduled',
                'a meeting was booked from cold calling',
            );

            /**
             * A BOOKED MEETING IS A TASK, not only a stage.
             *
             * The pipeline says where the deal is; the task tells the SDR what
             * to actually DO before it — confirm the room, prepare the one-
             * pager, show up. Due at the meeting instant itself so My Work
             * orders it against everything else that morning. Created through
             * the same shape the follow-up sequence uses (direct insert inside
             * this transaction), with the notification fired here because
             * createRecord is not the path.
             */
            const contactRow = get('SELECT full_name, first_name, last_name FROM contacts WHERE id = ?',
                [current.contact_id]);
            const who = contactRow?.full_name
                ?? [contactRow?.first_name, contactRow?.last_name].filter(Boolean).join(' ')
                ?? 'a lead';
            const accountRow = current.account_id
                ? get('SELECT name FROM accounts WHERE id = ?', [current.account_id])
                : null;
            const meetingTaskId = id('tsk');
            run(
                `INSERT INTO tasks
                   (id, workspace_id, parent_type, parent_id, account_id, title, description,
                    assignee_id, due_at, priority, status, properties, created_by, created_at, updated_at)
                 VALUES (?,?,'contact',?,?,?,?,?,?,?,'open',?,?,?,?)`,
                [
                    meetingTaskId, ctx.workspaceId, current.contact_id, current.account_id ?? null,
                    `Meeting — ${who}`,
                    [
                        `Meeting with ${who}` + (accountRow?.name ? ` at ${accountRow.name}.` : '.'),
                        `Booked from cold calling for ${meetingInstant}.`,
                        'Confirm attendance, prepare the profile, and log the outcome when it is done.',
                    ].join(' '),
                    current.assigned_to ?? ctx.userId ?? null,
                    meetingInstant, 'A',
                    JSON.stringify({ meeting: { assignment_id: current.id, contact_id: current.contact_id, at: meetingInstant } }),
                    ctx.userId ?? null, stamp, stamp,
                ],
            );
            notifyMeetingScheduled(ctx, {
                assigneeId: current.assigned_to ?? ctx.userId ?? null,
                taskId: meetingTaskId,
                contactId: current.contact_id,
                who,
                whenLabel: meetingInstant.replace('T', ' ').slice(0, 16),
            });
        }

        /**
         * THE OUTCOME IS THE PIPELINE, for the four calling stages that have one.
         *
         * A contact marked Interested, sent a profile, followed up, or booked
         * into a meeting is at that stage of the sale — so the account's deal
         * (found or created, one per account) moves with the outcome instead of
         * waiting for somebody to drag a card that says what the call already
         * decided. No answer and Wrong number are not stages and change nothing.
         */
        const OUTCOME_STAGES = {
            qualified: 'interested',
            send_profile: 'send_profile',
            follow_up: 'follow_up',
            meeting_scheduled: 'meeting_scheduled',
        };
        if (OUTCOME_STAGES[outcome] && current.account_id) {
            const deal = ensureDealForAccount(ctx, current.account_id, `a call was logged as ${effect.label}`);
            if (deal) moveDealToStage(ctx, deal.id, OUTCOME_STAGES[outcome], `a call was logged as ${effect.label}`);
        }

        if (outcome === 'meeting_done' || outcome === 'no_show') {
            const booked = openMeetingFor(ctx, { assignmentId: current.id });
            if (booked) {
                settleMeeting(ctx, booked.id, outcome === 'meeting_done' ? 'done' : 'no_show', {
                    note: String(note ?? '').trim() || null,
                    at: stamp,
                });
            } else if (outcome === 'meeting_done') {
                /**
                 * Done with nothing booked here — a meeting arranged by email, or
                 * one whose booking predates this. The call still records it, and
                 * it becomes a meeting record of its own so the show rate counts
                 * a meeting that demonstrably happened.
                 */
                run(
                    'UPDATE activities SET meeting_at = ?, meeting_status = ? WHERE id = ?',
                    [stamp, 'done', activityId],
                );
            }

            /**
             * EVERY RESOLVED MEETING ASKS WHAT CAME NEXT.
             *
             * A meeting that went well ends in a proposal being prepared; one
             * that did not ends in the deal being lost. The caller chooses at
             * the moment they settle the meeting — `nextStep` — and the deal
             * moves or closes here rather than waiting for somebody to find the
             * card afterwards. Only Proposal preparing is offered for a meeting
             * that happened; a No Show has not produced anything to write up.
             */
            if (outcome === 'meeting_done' && current.account_id && nextStep) {
                const dealId = dealIdFor(ctx, current);
                if (nextStep === 'lost' && dealId) {
                    const deal = get('SELECT id FROM deals WHERE id = ?', [dealId]);
                    if (deal) update('deals', dealId, {
                        status: 'lost', loss_reason: 'Meeting outcome', closed_at: now(), updated_at: now(),
                    });
                    audit(ctx, {
                        objectKey: 'deal', recordId: dealId, accountId: current.account_id,
                        action: 'deal_lost', source: 'automation',
                        after: { because: 'the meeting was settled as done and the caller closed it' },
                    });
                } else if (nextStep === 'proposal_preparing' && dealId) {
                    moveDealToStage(ctx, dealId, 'proposal_preparing', 'the meeting went well');
                }
            }
        }

        /**
         * And the streak reaching the limit retires the lead.
         *
         * Through `markDead`, which is what the four-step follow-up sequence
         * calls when it runs out — so a lead that stops answering and a lead
         * that finishes its sequence end up in the same state, on the same
         * queue tab, with the same activity on the timeline saying why. Two
         * ways to die and one way to be dead.
         */
        if (exhausted) {
            markDead(ctx, current, `${streak} unanswered calls in a row`);
        }

        /**
         * A follow-up starts the sequence, and the sequence is the whole of it.
         *
         * The rep picks ONE date and time — when they want to ring back — and
         * the four activities that follow from it are created here: this
         * follow-up at the minute they chose, a WhatsApp at the end of that day,
         * a second follow-up exactly seven days later, and a WhatsApp at the end
         * of THAT day. Then the lead is dead. Nobody types a task for any of it,
         * and nothing anywhere can add a fifth. See lib/follow-up.mjs.
         *
         * `followUpInstant` is handed over rather than the raw input, so the
         * first task's due date and the assignment's `next_follow_up_at` are the
         * same instant by construction rather than by two functions agreeing.
         *
         * Idempotent: a second follow-up logged on a lead already in the
         * sequence is the rep working the tasks they have, not asking for four
         * more — but the OPEN steps are re-dated from the new instant, so the
         * task list and the queue never disagree about when the ring-back is.
         */
        if (outcome === 'follow_up' && followUpInstant) {
            const contact = get('SELECT id, full_name, first_name, last_name FROM contacts WHERE id = ?',
                [current.contact_id]);
            const account = current.account_id
                ? get('SELECT id, name FROM accounts WHERE id = ?', [current.account_id])
                : null;
            if (contact) {
                const started = startSequence(ctx, {
                    assignment: current,
                    contact,
                    account,
                    firstFollowUpAt: followUpInstant,
                    assigneeId: current.assigned_to ?? ctx.userId,
                    timezone,
                    dayEndHour: Number(setting(ctx.workspaceId, 'follow_up_day_end_hour')) || undefined,
                    dayStartHour,
                });
                // Already running: the new instant re-dates the open steps,
                // exactly as an explicit reschedule does. Without this the queue
                // says Thursday and the first task still says Tuesday.
                if (started?.alreadyRunning) {
                    rescheduleSequence(ctx, current, followUpInstant, {
                        timezone,
                        dayStartHour,
                        dayEndHour: Number(setting(ctx.workspaceId, 'follow_up_day_end_hour')) || undefined,
                    });
                }
            }

            /**
             * And the pipeline reads what the calling queue is doing: the
             * account's deal (found or created — one per account) moves to the
             * Follow up stage, so a lead being chased is visible there too.
             */
            if (current.account_id) {
                const deal = ensureDealForAccount(ctx, current.account_id, 'a contact was scheduled for follow-up');
                if (deal) moveDealToStage(ctx, deal.id, 'follow_up', 'a contact was scheduled for follow-up');
            }
        }

        /**
         * AND AN ANSWERED FOLLOW-UP ENDS THE SEQUENCE.
         *
         * A contact who is mid-sequence and gives any outcome other than No
         * Answer or another Follow Up has done what the sequence existed to
         * produce: they engaged. Qualified, not interested, wrong number, profile
         * sent, meeting booked — each of them is a conversation, and the steps
         * still queued behind it are now chasing somebody who has already been
         * reached. A rep finding "WhatsApp after the second follow-up" on Thursday
         * for a client they qualified on Tuesday stops trusting their task list,
         * and a task list nobody trusts is worse than none.
         *
         * The two exceptions are the two outcomes that mean the conversation has
         * NOT happened yet: No Answer leaves the sequence to keep chasing (until
         * the streak above retires the lead), and a fresh Follow Up is the rep
         * working the steps they already have.
         *
         * `completeSequence` finishes the steps and says so on the timeline; it
         * deliberately does not touch the assignment's own status, because what
         * happens to the queue entry is the OUTCOME's business — Not Interested
         * closed it four statements ago, Qualified keeps it working.
         *
         * Skipped when the streak has just retired the lead: it is dead, and
         * "completed because the lead engaged" would be a second, contradictory
         * story on the same timeline.
         */
        if (!exhausted && !SEQUENCE_KEEPS_RUNNING.has(outcome)) {
            completeSequence(ctx, current, { because: effect.label.toLowerCase() });
        }

        /**
         * NO ANSWER STILL ATTEMPTED THE STEP.
         *
         * A lead mid-sequence who does not pick up stays in the sequence —
         * SEQUENCE_KEEPS_RUNNING above sees to that — but the call step
         * that was just dialled is not left open and stale: the rep made
         * the attempt, so it is complete the same way ticking its task
         * would make it, and the sequence moves on to whatever follows
         * (typically the WhatsApp already scheduled for later the same
         * day). Skipped once the streak has retired the lead — `markDead`
         * already closed every open step, and this would try to complete
         * one that no longer exists.
         */
        if (inSequence && outcome === 'no_answer' && !exhausted) {
            attemptCallStep(ctx, current.id);
        }
    });

    return { activityId, duplicate: false, assignment: assignment(ctx, assignmentId) };
}

/**
 * Log a WhatsApp or an email sent to a lead — not a call, and not an
 * outcome. See `MESSAGE_CHANNELS` for why this stays deliberately separate
 * from `logCall`: nothing here touches the streak, the sequence, or the
 * deal stage. It is purely a fact on the timeline that a message went out.
 *
 * Same idempotency shape as `logCall`, for the same reason: the driver
 * blocks, so a double-click is a second real request, and without a key a
 * slow network would append the message twice.
 */
export function logMessage(ctx, { assignmentId, channel, note = '', idempotencyKey = null } = {}) {
    require$(ctx, can(ctx, 'calling.manage') ? 'calling.manage' : 'calling.work');

    if (!MESSAGE_CHANNEL_KEYS.has(channel)) {
        throw badRequest(`Unknown channel "${channel}". One of: ${MESSAGE_CHANNELS.map((c) => c.key).join(', ')}.`);
    }

    // Fetched through the scoped reader, so an SDR cannot log a message
    // against somebody else's assignment by sending its id.
    const current = assignmentRow(ctx, assignmentId);

    if (idempotencyKey) {
        const already = get(
            `SELECT id FROM activities WHERE workspace_id = ? AND idempotency_key = ?`,
            [ctx.workspaceId, idempotencyKey],
        );
        if (already) return { activityId: already.id, duplicate: true, assignment: assignment(ctx, assignmentId) };
    }

    // The workspace's own label for the type, same as the account timeline
    // reads it (api/accounts.mjs) — a workspace that renamed "WhatsApp" to
    // something else sees that name here too, not the seed default.
    const typeLabel = get(
        'SELECT label FROM activity_types WHERE workspace_id = ? AND key = ?',
        [ctx.workspaceId, channel],
    )?.label ?? MESSAGE_CHANNELS.find((c) => c.key === channel)?.label ?? channel;

    const stamp = now();
    const activityId = id('act');
    run(
        `INSERT INTO activities
           (id, workspace_id, parent_type, parent_id, account_id, type_key, subject, body,
            occurred_at, direction, actor_id, source, properties, assignment_id, idempotency_key,
            created_at, updated_at)
         VALUES (?,?,'contact',?,?,?,?,?,?,'outbound',?,'ui','{}',?,?,?,?)`,
        [
            activityId, ctx.workspaceId, current.contact_id, current.account_id ?? null,
            channel, typeLabel, String(note ?? '').trim() || null,
            stamp, ctx.userId, current.id, idempotencyKey, stamp, stamp,
        ],
    );

    audit(ctx, {
        objectKey: 'contact',
        recordId: current.contact_id,
        accountId: current.account_id ?? null,
        action: 'message_logged',
        after: { channel, activityId },
    });

    return { activityId, duplicate: false, assignment: assignment(ctx, assignmentId) };
}

/**
 * The deal a queue entry's meeting should move.
 *
 * One open deal per account is the model this CRM settled on, so the account is
 * enough to find it — and if the account has none, a booked meeting is exactly
 * the moment one should exist: a meeting in the diary that appears nowhere in the
 * pipeline is the gap this whole automation is closing.
 *
 * Returns null for a queue entry with no company, which is a contact somebody
 * imported without one rather than an error.
 */
function dealIdFor(ctx, assignment) {
    if (!assignment?.account_id) return null;
    return ensureDealForAccount(ctx, assignment.account_id, 'a meeting was booked from cold calling')?.id ?? null;
}

/**
 * The message a date nobody can read gets.
 *
 * It quotes what arrived and shows the shape that works, because "invalid date"
 * in front of an SDR mid-call tells them the software is broken rather than
 * which of the two boxes to look at.
 */
function unreadable(value, what) {
    return `"${String(value).slice(0, 40)}" is not a ${what} date and time we can read. `
        + 'Use a date like 2026-09-15 and a time like 14:30.';
}

/**
 * How many OTHER leads have a follow-up genuinely due right now.
 *
 * Not the same question as the `follow_ups` tab count in `queueCounts` —
 * that one is "how big is my whole follow-up book" (anyone mid-sequence,
 * whatever their next step's date), which is the right question for a tab
 * a rep browses. This is "work them now": whoever's `next_follow_up_at` has
 * actually arrived, matching `queueCounts.to_call`'s own due-now rule and
 * `attention()`'s "Follow-ups due now" tile in lib/dashboard.mjs.
 *
 * `excludeAssignmentId` leaves out whichever lead is already on screen. The
 * console shows that lead's own due-ness through `sequenceStrip` — folding
 * it into this banner too meant a rep looking at the one and only due
 * follow-up, which was the person they were already about to call, was
 * told "1 follow-up due — work them now" pointing at a queue tab that led
 * right back to the same contact.
 */
/**
 * `next_follow_up_at` is not only a follow-up's own due date — a Meeting
 * Scheduled outcome reuses the same column to hold the MEETING's time (see
 * `nextAt` in `logCall`), and never starts the four-step sequence. Without
 * the sequence guard below, a scheduled meeting whose time arrives read as
 * "a follow-up is due" here, while the follow_ups tab (which requires
 * exactly that) correctly never showed it — a count with nothing behind it
 * once clicked through. Same condition the `follow_ups` TABS entry in
 * `queue()` uses, so the two cannot disagree again.
 */
export function otherFollowUpsDueNow(ctx, { sdrId = null, excludeAssignmentId = null } = {}) {
    const scope = scopeClause(ctx, { sdrId });
    const row = get(
        `SELECT COUNT(*) AS n
           FROM calling_assignments a
           JOIN contacts c ON c.id = a.contact_id AND c.deleted_at IS NULL
          WHERE a.workspace_id = ? ${scope.sql} AND a.queue_status IN ('queued','working')
            AND a.next_follow_up_at IS NOT NULL AND a.next_follow_up_at <= ?
            AND a.sequence_started_at IS NOT NULL AND a.sequence_completed_at IS NULL AND a.dead_at IS NULL
            ${excludeAssignmentId ? 'AND a.id != ?' : ''}`,
        excludeAssignmentId
            ? [ctx.workspaceId, ...scope.params, now(), excludeAssignmentId]
            : [ctx.workspaceId, ...scope.params, now()],
    );
    return row?.n ?? 0;
}

/** The next contact to call, so Save & Next needs no second decision. */
/**
 * `filter` is the SAME filter AST the queue table's own Filters button
 * builds — without it, "Save & Next" (and the console's very first contact,
 * from `today()`) pulled from the whole unfiltered to_call queue regardless
 * of what the SDR had actually filtered the list down to. Someone working
 * "just my Priority A leads" would run out of those and get handed whoever
 * was next in the FULL queue with no warning that the filter had been
 * silently dropped. `sort` is the same idea for whatever column order the
 * queue table (or the console's browsing arrows, see `navigate` in
 * calling.js) is currently showing.
 *
 * ── POSITION, NOT PRIORITY ───────────────────────────────────────────────
 *
 * With `after` given, this finds THAT row's own place in the ordered to_call
 * list and returns whoever sits immediately behind it — not whoever the
 * ORDER BY would put first. It used to be the second: `queue(ctx, {limit:
 * 2}).find(id !== after)`, which is "the top of the queue, skipping `after`
 * if it happens to still be there" — right for a queue where every lead
 * shares one priority and nobody has been called yet, and wrong the moment
 * they don't, because it hands back the SAME highest-priority lead call
 * after call instead of advancing. Opening lead 3 of 5 and saving reliably
 * bounced back to lead 1.
 *
 * The caller MUST compute this before mutating `after`'s own row (see
 * `call()` in api/calling.mjs) — `logCall` changes exactly the columns this
 * function orders by (`last_called_at`, `queue_status`, ...), so finding
 * `after`'s position AFTER that write would be asking where a row used to
 * sit using a query that only sees where it sits now.
 */
export function nextInQueue(ctx, { sdrId = null, after = null, filter = null, sort = null, q = null } = {}) {
    // The queue table's own cap (see `queue()`) — a position beyond it is
    // not one Save & Next can resolve exactly, so it falls through to the
    // cold-start behaviour below, same as a queue too heavily filtered to
    // contain `after` at all.
    const page = queue(ctx, { sdrId, tab: 'to_call', filter, sort, q, limit: 200 });
    if (!after) return page.items[0] ?? null;
    const index = page.items.findIndex((item) => item.id === after);
    if (index === -1) return page.items.find((item) => item.id !== after) ?? null;
    return page.items[index + 1] ?? null;
}

/* ------------------------------------------------------------- management -- */

/**
 * Every bulk action on the queue screen takes the same two selection
 * shapes — explicit row ids, or contact ids when "select all matching"
 * reached past the page on screen — and resolves them the same way: a
 * contact id becomes its LIVE assignment (`active = 1`), because that is
 * the one row "on the queue" actually means. One place, so Remove,
 * priority, status and the contact-level bulk edit below cannot quietly
 * disagree about what a contact id resolves to.
 */
function resolveLiveAssignmentIds(ctx, assignmentIds = [], contactIds = []) {
    const ids = [...new Set(assignmentIds.filter(Boolean))];
    const contacts = [...new Set(contactIds.filter(Boolean))];
    if (contacts.length) {
        const holes = contacts.map(() => '?').join(',');
        const live = all(
            `SELECT id FROM calling_assignments
              WHERE workspace_id = ? AND active = 1 AND contact_id IN (${holes})`,
            [ctx.workspaceId, ...contacts],
        );
        ids.push(...live.map((r) => r.id));
    }
    return [...new Set(ids)];
}

/**
 * The same resolution as above, for REMOVE specifically — which has to work
 * from the Completed and Dead tabs too, not only "To call".
 *
 * Every other bulk action restricts a contact id to its LIVE assignment on
 * purpose: you cannot log a new outcome or reprioritise a lead that has
 * already closed. Remove is different — "take these people off the calling
 * queue entirely" is exactly the action a manager reaches for FROM the
 * Completed/Dead tabs, clearing out this week's wrong numbers and
 * not-interesteds. Those rows are `active = 0` by then (see CALL_OUTCOMES'
 * `closes: true`), so resolving only live assignments silently found nothing
 * to remove and answered "Nothing was selected." for a screen full of ticked
 * boxes. Matches any assignment not already 'removed' — a contact can carry
 * more than one historical row (see the re-engage path in `assignContacts`),
 * and "off the module for everyone" means all of them, not just the one on
 * screen.
 */
function resolveAssignmentIdsForRemoval(ctx, assignmentIds = [], contactIds = []) {
    const ids = [...new Set(assignmentIds.filter(Boolean))];
    const contacts = [...new Set(contactIds.filter(Boolean))];
    if (contacts.length) {
        const holes = contacts.map(() => '?').join(',');
        const rows = all(
            `SELECT id FROM calling_assignments
              WHERE workspace_id = ? AND queue_status != 'removed' AND contact_id IN (${holes})`,
            [ctx.workspaceId, ...contacts],
        );
        ids.push(...rows.map((r) => r.id));
    }
    return [...new Set(ids)];
}

/**
 * Wipes a contact's calling history back to a blank slate — every call,
 * message and meeting logged against this queue entry soft-deleted, and the
 * assignment's own aggregate columns (call count, last outcome, no-answer
 * streak, the follow-up sequence, dead/alive) reset to what a freshly
 * assigned contact looks like.
 *
 * ── WHY THIS IS admin-only ───────────────────────────────────────────────
 *
 * Everywhere else in this module a call is permanent — "the calls already
 * made stay with the CONTACT" is the rule a reassignment, a merge and a
 * pipeline stage change all keep. This is the one deliberate exception: test
 * data left in a workspace, or a lead logged against entirely by mistake,
 * needs a real way back to zero rather than living with a false history
 * forever. `calling.clear_activity` is checked without being added to any
 * role's list — the same trick that makes a capability string "admin only"
 * anywhere in this codebase, since only owner/admin hold the `*` that
 * satisfies a check nobody was explicitly given.
 *
 * ── WHAT SURVIVES ────────────────────────────────────────────────────────
 *
 * The assignment itself, the contact, and any deal it moved — this clears
 * what HAPPENED on the calling floor, not who the contact is or where the
 * deal sits. A deal a call moved to Interested stays there; reverting it
 * automatically would be a second, much larger decision this action does
 * not make.
 */
export function clearCallingActivity(ctx, assignmentId) {
    require$(ctx, 'calling.clear_activity');
    const current = get(
        `SELECT * FROM calling_assignments WHERE workspace_id = ? AND id = ?`,
        [ctx.workspaceId, assignmentId],
    );
    if (!current) throw notFound('That contact is not in the calling queue.');

    // The same rows `callHistory` shows — every call and message ever logged
    // against the CONTACT, not only this assignment_id. A contact reassigned
    // or re-added to the queue gets a new assignment row, and history made
    // under the old one must not survive "Clear activity" looking cleared.
    const typeKeys = [CALL_TYPE, ...MESSAGE_CHANNELS.map((c) => c.key)];
    const stamp = now();
    let cleared = 0;
    tx(() => {
        const activityRows = all(
            `SELECT id FROM activities
              WHERE workspace_id = ? AND parent_type = 'contact' AND parent_id = ?
                AND type_key IN (${typeKeys.map(() => '?').join(',')}) AND deleted_at IS NULL`,
            [ctx.workspaceId, current.contact_id, ...typeKeys],
        );
        cleared = activityRows.length;
        if (activityRows.length) {
            run(
                `UPDATE activities SET deleted_at = ?, updated_at = ?
                  WHERE workspace_id = ? AND parent_type = 'contact' AND parent_id = ?
                    AND type_key IN (${typeKeys.map(() => '?').join(',')}) AND deleted_at IS NULL`,
                [stamp, stamp, ctx.workspaceId, current.contact_id, ...typeKeys],
            );
        }
        // Sequence tasks are cancelled, not deleted — same rule `markDead`
        // follows: they happened, and a rep looking back should see that a
        // step existed and was overtaken, not that it never did.
        run(
            `UPDATE tasks SET status = 'cancelled', updated_at = ?
              WHERE workspace_id = ? AND status IN ('open','in_progress')
                AND properties LIKE ?`,
            [stamp, ctx.workspaceId, `%"assignment_id":"${assignmentId}"%`],
        );
        /**
         * `active` is deliberately left alone.
         *
         * Forcing it to 1 used to crash this on a contact re-engaged or
         * reassigned since the assignment being cleared was made: that
         * contact now has a NEWER row with `active = 1`, and
         * `idx_calling_active_contact` allows only one per contact, so the
         * UPDATE hit a UNIQUE constraint and this whole action 500'd. A
         * clear only wipes what happened on this queue entry — whether it
         * is the contact's current, live assignment is a separate fact this
         * action does not get to change.
         */
        run(
            `UPDATE calling_assignments
                SET queue_status = 'queued', call_count = 0, last_called_at = NULL,
                    last_outcome = NULL, last_called_by = NULL, next_follow_up_at = NULL,
                    no_answer_streak = 0, sequence_started_at = NULL, sequence_step = 0,
                    sequence_completed_at = NULL, dead_at = NULL, dead_reason = NULL,
                    completed_at = NULL, updated_at = ?
              WHERE id = ?`,
            [stamp, assignmentId],
        );
        audit(ctx, {
            objectKey: 'contact',
            recordId: current.contact_id,
            accountId: current.account_id ?? null,
            action: 'calling_activity_cleared',
            before: {
                callCount: current.call_count, lastOutcome: current.last_outcome,
                queueStatus: current.queue_status,
            },
            after: { activitiesCleared: cleared },
        });
    });

    return { cleared, assignment: assignment(ctx, assignmentId) };
}

/**
 * Mirrors the calling queue onto a meeting settled from the Meetings page.
 *
 * Marking a meeting Done or No Show there is the same fact a call outcome of
 * Meeting Done / Meeting No Show already records (see `logCall` above, and
 * `settleMeeting` in lib/meetings.mjs) — but `settleMeeting` on its own only
 * ever touches the meeting's own status, because it is shared by both
 * entry points and the call-outcome one already updates the assignment
 * itself, a few lines earlier in the same `logCall` transaction. Settling
 * from the Meetings page skipped that update entirely, so a lead whose
 * meeting had clearly resolved kept reading "Meeting Scheduled" on the
 * calling queue with no way to tell from that screen that anything had
 * happened.
 *
 * Deliberately narrow: this sets only the columns a call OUTCOME of these
 * two keys sets (`queue_status`, `active`, `completed_at`, `last_outcome`),
 * reusing CALL_OUTCOMES as the one source of truth for what each means —
 * not `call_count` or the no-answer streak, because settling a meeting here
 * is not a new call attempt.
 */
export function syncAssignmentAfterMeetingSettled(ctx, assignmentId, status) {
    if (!assignmentId) return;
    const outcome = status === 'done' ? 'meeting_done' : 'no_show';
    const effect = OUTCOME.get(outcome);
    const stamp = now();
    run(
        `UPDATE calling_assignments
            SET last_outcome = ?, queue_status = ?, active = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ?`,
        [outcome, effect.status, effect.closes ? 0 : 1, effect.closes ? stamp : null, stamp, assignmentId, ctx.workspaceId],
    );
}

export function removeFromQueue(ctx, assignmentIds = [], contactIds = []) {
    require$(ctx, 'calling.manage');
    return closeMany(ctx, resolveAssignmentIdsForRemoval(ctx, assignmentIds, contactIds), 'removed', 'calling_removed');
}

export function setPriority(ctx, assignmentIds = [], priority, contactIds = []) {
    require$(ctx, 'calling.manage');
    if (!PRIORITIES.includes(priority)) throw badRequest(`Priority must be one of: ${PRIORITIES.join(', ')}.`);
    const ids = resolveLiveAssignmentIds(ctx, assignmentIds, contactIds);
    if (!ids.length) throw badRequest('Nothing was selected.');

    const stamp = now();
    run(
        `UPDATE calling_assignments SET priority = ?, updated_at = ?
          WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
        [priority, stamp, ctx.workspaceId, ...ids],
    );
    return { updated: ids.length, priority };
}

/**
 * A direct queue-status override — reorganising the board ("these three are
 * actually done"), not a call outcome. Deliberately narrow: `dead` is not
 * offered here, because retiring a lead is a fact `markDead` records with a
 * reason and a timestamp, not a status a manager flips from a list.
 */
export const BULK_QUEUE_STATUSES = ['queued', 'working', 'done', 'closed'];
export function setQueueStatus(ctx, assignmentIds = [], status, contactIds = []) {
    require$(ctx, 'calling.manage');
    if (!BULK_QUEUE_STATUSES.includes(status)) {
        throw badRequest(`Queue status must be one of: ${BULK_QUEUE_STATUSES.join(', ')}.`);
    }
    const ids = resolveLiveAssignmentIds(ctx, assignmentIds, contactIds);
    if (!ids.length) throw badRequest('Nothing was selected.');

    const stamp = now();
    const active = ['done', 'closed'].includes(status) ? 0 : 1;
    run(
        `UPDATE calling_assignments SET queue_status = ?, active = ?, updated_at = ?
          WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
        [status, active, stamp, ctx.workspaceId, ...ids],
    );
    return { updated: ids.length, status };
}

/**
 * Bulk-set the SERVICE(S) on the underlying CONTACTS behind a queue
 * selection — the one field in this trio that does not live on the
 * assignment. Written through the ordinary contact update (lib/repo.mjs),
 * not a raw UPDATE, so it is validated, audited and reindexed exactly like
 * editing the field on the contact record itself; a bulk action with its
 * own write path is a bulk action that eventually writes something the
 * rest of the system considers impossible.
 */
export function setContactServices(ctx, assignmentIds = [], services = [], contactIds = []) {
    require$(ctx, 'calling.manage');
    const ids = resolveLiveAssignmentIds(ctx, assignmentIds, contactIds);
    if (!ids.length) throw badRequest('Nothing was selected.');

    const holes = ids.map(() => '?').join(',');
    const rows = all(
        `SELECT DISTINCT contact_id FROM calling_assignments WHERE workspace_id = ? AND id IN (${holes})`,
        [ctx.workspaceId, ...ids],
    );
    for (const row of rows) {
        updateRecord('contact', ctx, row.contact_id, { services });
    }
    return { updated: rows.length, services };
}

/**
 * Log the SAME outcome against every selected, live assignment — the bulk
 * counterpart of `logCall`, for a batch worked outside the console (a paper
 * list, a session's worth of calls entered afterwards) rather than one at a
 * time. Everything `logCall` does per call — the no-answer streak, dead
 * marking, the follow-up sequence, the deal move on a meeting — happens for
 * each row exactly as if it had been logged individually; this only saves
 * the round trips, not the rules. `followUpAt`/`meetingAt`, when the chosen
 * outcome needs one, is the same instant applied to every row.
 */
export function bulkLogOutcome(ctx, {
    assignmentIds = [], contactIds = [], outcome, note = '', followUpAt = null, meetingAt = null,
} = {}) {
    if (!OUTCOME.has(outcome)) {
        throw badRequest(`Unknown outcome "${outcome}". One of: ${CALL_OUTCOMES.map((o) => o.key).join(', ')}.`);
    }
    const ids = resolveLiveAssignmentIds(ctx, assignmentIds, contactIds);
    if (!ids.length) throw badRequest('Nothing was selected.');

    /**
     * Per-row, not all-or-nothing.
     *
     * Each `logCall` is its own transaction, and one selected lead can
     * legitimately fail where the others do not — retired mid-batch by
     * someone else, a follow-up date that has since slipped into the past.
     * The loop used to abort on the first failure and report it as a flat
     * error, with no way to tell a manager doing a 50-lead bulk edit how
     * many of the 50 actually went through. Collecting failures instead
     * means the caller can report "48 logged, 2 could not be" rather than
     * one opaque toast covering an unknown number of untouched rows.
     */
    const failed = [];
    let updated = 0;
    for (const assignmentId of ids) {
        try {
            logCall(ctx, { assignmentId, outcome, note, followUpAt, meetingAt });
            updated += 1;
        } catch (err) {
            failed.push({ assignmentId, error: err.message });
        }
    }
    // Every row failed for the same reason (almost always: the outcome needs
    // a date/time nobody gave it) — that is worth refusing outright rather
    // than reporting "0 updated" as though it were a partial success.
    if (!updated && failed.length) {
        throw badRequest(failed[0].error);
    }
    return { updated, outcome, failed };
}

function closeMany(ctx, assignmentIds, status, action) {
    const ids = [...new Set(assignmentIds.filter(Boolean))];
    if (!ids.length) throw badRequest('Nothing was selected.');
    const holes = ids.map(() => '?').join(',');

    const rows = all(
        `SELECT id, contact_id, account_id, assigned_to FROM calling_assignments
          WHERE workspace_id = ? AND id IN (${holes})`,
        [ctx.workspaceId, ...ids],
    );
    if (!rows.length) throw notFound('None of those assignments exist.');

    const stamp = now();
    tx(() => {
        run(
            `UPDATE calling_assignments
                SET queue_status = ?, active = 0, completed_at = ?, updated_at = ?
              WHERE workspace_id = ? AND id IN (${holes})`,
            [status, stamp, stamp, ctx.workspaceId, ...ids],
        );
        for (const row of rows) {
            audit(ctx, {
                objectKey: 'contact',
                recordId: row.contact_id,
                accountId: row.account_id ?? null,
                action,
                before: { assignedTo: row.assigned_to },
            });
        }
    });

    // The calls stay. Taking a contact off a list is not a reason to lose the
    // record of having rung them.
    return { removed: rows.length, callsKept: true };
}

/* ----------------------------------------------------------------- shared -- */

function assignmentRow(ctx, assignmentId) {
    const scope = scopeClause(ctx);
    const row = get(
        `SELECT a.* FROM calling_assignments a
          WHERE a.workspace_id = ? AND a.id = ? ${scope.sql}`,
        [ctx.workspaceId, assignmentId, ...scope.params],
    );
    if (!row) throw notFound('That contact is not in your calling queue.');
    if (row.queue_status === 'removed') throw forbidden('That contact has been taken off the calling list.');
    return row;
}

export function displayName(contact) {
    return contact.full_name
        || [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim()
        || 'Unnamed contact';
}

function present(row) {
    return {
        id: row.id,
        contactId: row.contact_id,
        accountId: row.account_id,
        name: displayName(row),
        title: row.title,
        company: row.account_name,
        phone: row.phone,
        email: row.email,
        linkedinUrl: row.linkedin_url,
        priority: row.priority,
        queueStatus: row.queue_status,
        callCount: row.call_count,
        lastCalledAt: row.last_called_at,
        inRangeCalledAt: row.in_range_called_at ?? null,
        lastOutcome: row.last_outcome,
        lastOutcomeLabel: row.last_outcome ? (OUTCOME.get(row.last_outcome)?.label ?? row.last_outcome) : null,
        nextFollowUpAt: row.next_follow_up_at,
        assignedTo: row.assigned_to,
        sdrName: row.sdr_name,
        lastCalledBy: row.last_called_by,
        // A multiselect column has to come back as an actual array — every
        // consumer (the badge list here, the queue table's own cell
        // renderer) checks Array.isArray before doing anything with it. See
        // repo.mjs's own comment on this exact shape for `listRecords`; this
        // query is hand-written SQL and gets none of that for free.
        services: json(row.services, []),
        /**
         * Whether this lead is still alive, and where it is in the sequence.
         *
         * Four of the six things a rep needs before dialling — what is next,
         * when it is due, how far through they are, and whether there is any
         * point — and none of them was on the card. The other two, who to ring
         * and what happened last time, already were.
         */
        dead: Boolean(row.dead_at),
        deadAt: row.dead_at ?? null,
        deadReason: row.dead_reason ?? null,
        sequenceStep: Number(row.sequence_step) || 0,
        sequenceOf: SEQUENCE_LENGTH,
        sequenceStarted: Boolean(row.sequence_started_at),
    };
}
