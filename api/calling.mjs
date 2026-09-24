/**
 * Cold calling endpoints.
 *
 * Two audiences, and the split is the point. A manager assigns work and reads
 * the whole team; an SDR works one queue and can reach nothing else. Both come
 * through here, and every read is scoped inside lib/calling.mjs rather than by
 * a check in each handler — see `scopeFor` there for why.
 *
 * An SDR holds no `record.read.all`, so the generic /api/<object> routes already
 * refuse them. This file is deliberately the only other door, and it hands back
 * the few contact fields a call needs rather than whole records.
 */
import { readJson, badRequest, forbidden, notFound } from '../lib/http.mjs';
import { require$, can, listMembers } from '../lib/auth.mjs';
import { idsMatching, createRecord, updateRecord, ensureDealForAccount, advanceDealToStage, audit } from '../lib/repo.mjs';
import { all, get, run, tx, id, now } from '../lib/db.mjs';
import { setting } from '../lib/settings.mjs';
import { DEFAULT_DAY_START_HOUR } from '../lib/follow-up.mjs';
import { resolveRange } from '../lib/date-range.mjs';
import { openApprovalTask, closeApprovalTask } from '../lib/approvals.mjs';
import { notifyApprovalDecision } from '../lib/notify.mjs';
import {
    CALL_OUTCOMES, MESSAGE_CHANNELS, PRIORITIES, BULK_QUEUE_STATUSES, assignContacts, queue, queueContactIds,
    queueCounts, assignment, logCall, logMessage, nextInQueue, removeFromQueue, setPriority, setQueueStatus,
    setContactServices, bulkLogOutcome, callHistory, rescheduleFollowUp, otherFollowUpsDueNow, clearCallingActivity,
    displayName,
} from '../lib/calling.mjs';

/**
 * Everything the calling screens need to render before they know anything about
 * a particular queue: the outcome buttons, the priorities, and who work can be
 * given to. One request rather than three.
 */
export async function meta({ ctx }) {
    const manager = can(ctx, 'calling.manage');
    // A rep may still put a contact on their OWN queue (calling.assign_own —
    // not calling.work, which an SDR also holds and must not get a
    // destination list from), so the one destination that choice actually
    // needs is themselves — not the floor, which enumerating every
    // colleague would be.
    const self = !manager && can(ctx, 'calling.assign_own')
        ? assignableMembers(ctx).filter((m) => m.id === ctx.userId)
        : [];
    return {
        outcomes: CALL_OUTCOMES.map((o) => ({
            key: o.key,
            label: o.label,
            requires: o.requires ?? null,
            closes: Boolean(o.closes),
        })),
        messageChannels: MESSAGE_CHANNELS,
        priorities: PRIORITIES,
        // The manual board-reorganisation statuses `setQueueStatus` accepts —
        // deliberately not `dead`, which stays a fact `markDead` records with
        // a reason, never a status flipped from a list. See its own comment
        // in lib/calling.mjs.
        queueStatuses: BULK_QUEUE_STATUSES,
        canManage: manager,
        /**
         * The hour the workspace starts, as a time the console can put in a box.
         *
         * A follow-up is a date AND a time, and a time box that opens empty
         * becomes midnight the moment somebody only fills in the date — which is
         * 3am here and the reason the task list used to read as broken. The
         * default belongs to the workspace (`follow_up_day_start_hour`), so it is
         * sent rather than hardcoded in the browser. See lib/follow-up.mjs.
         */
        defaultFollowUpTime: hourAsTime(setting(ctx.workspaceId, 'follow_up_day_start_hour')),
        // An SDR has no business enumerating their colleagues; a rep sees
        // only themselves, the one destination their capability allows.
        sdrs: manager ? assignableMembers(ctx) : self,
        /**
         * Everyone a REQUEST could name, regardless of `sdrs` above.
         *
         * `sdrs` is a destination list for actually moving a contact —
         * self-only below `calling.manage`, on purpose (see the comment on
         * `self`). A reassignment REQUEST is a different act: naming who you
         * think should get it, then asking somebody who can actually decide.
         * That needs the full member list, and both `sdr` and `rep` already
         * hold `member.read` — nothing new is exposed, just used here too.
         */
        colleagues: assignableMembers(ctx),
    };
}

/** `9` → `09:00`, for an `<input type="time">`. */
function hourAsTime(hour) {
    const value = Number(hour);
    const safe = Number.isInteger(value) && value >= 0 && value <= 23 ? value : DEFAULT_DAY_START_HOUR;
    return `${String(safe).padStart(2, '0')}:00`;
}

/**
 * Who can be given calling work.
 *
 * Anyone in the workspace who could plausibly hold a queue — not just the `sdr`
 * role, because a manager or rep making their own calls is normal and refusing
 * to let them hold a list would be a rule nobody asked for.
 */
function assignableMembers(ctx) {
    return listMembers(ctx.workspaceId)
        .filter((m) => m.status === 'active' && m.role !== 'readonly')
        .map((m) => ({ id: m.id, name: m.name, role: m.role }));
}

/* ----------------------------------------------------------- assigning -- */

/**
 * Add contacts to somebody's queue.
 *
 * Accepts the same two selection shapes as every other bulk action in the CRM —
 * an explicit list of ids, or "everything matching the filter I am looking at" —
 * so the selection bar on the Contacts list can hand its state straight over
 * without a second concept of what "selected" means.
 *
 * Returns without writing when a contact is already on somebody else's list.
 * The UI shows who has it and asks; `reassign: true` is the answer.
 */
export async function assign({ req, ctx }) {
    // Either capability may call this; assignContacts (lib/calling.mjs) is
    // what actually narrows a calling.assign_own-only caller to their own
    // queue. Not calling.work — an SDR holds that too, to work the queue
    // they were given, and must still be refused here.
    if (!can(ctx, 'calling.manage')) require$(ctx, 'calling.assign_own');
    const body = await readJson(req);

    /**
     * `ids` is what every other bulk action in this CRM sends, so it is what the
     * selection bar sends here too; `contactIds` is the name this endpoint's own
     * callers use. Accepting both is not indulgence — reading only the second is
     * exactly why the button answered "No contacts were selected" for a screen
     * full of ticked boxes.
     */
    const explicit = Array.isArray(body.ids) ? body.ids
        : (Array.isArray(body.contactIds) ? body.contactIds : []);

    const contactIds = body.all
        ? idsMatching('contact', ctx, {
            filter: body.filter ?? null, listId: body.listId ?? null, q: body.q ?? null,
        }).ids
        : explicit;

    if (!contactIds.length) throw badRequest('No contacts were selected.');

    const result = assignContacts(ctx, {
        contactIds,
        assignedTo: body.assignedTo,
        // 'medium' was never on this product's scale (A/B/C) — every assign
        // that omitted an explicit priority answered 400 and read as broken.
        // The lib default is B.
        priority: body.priority ?? 'B',
        campaignId: body.campaignId ?? null,
        reassign: Boolean(body.reassign),
        reengage: Boolean(body.reengage),
    });

    return { ...result, message: describeAssignment(result) };
}

/**
 * Create a contact (and account if needed) from inside the calling workspace
 * and put it straight on the caller's own queue.
 *
 * SDRs hold no `record.read.all` so the generic POST /api/contacts is 403 for
 * them; this is the one door that lets them add a lead while they are calling.
 * The contact + account are real CRM records — they appear in Contacts/Accounts
 * for anyone with `record.read.all` — and the queue assignment is the same
 * `assignContacts` path every other surface uses, so counts, pipeline stage
 * (`ready_to_call`) and `withoutPhone`/`withoutAccount` reporting stay consistent.
 */
export async function createContact({ req, ctx }) {
    if (!can(ctx, 'calling.manage') && !can(ctx, 'calling.work') && !can(ctx, 'calling.assign_own')) {
        require$(ctx, 'calling.work');
    }
    const body = await readJson(req);
    const fullName = String(body.full_name ?? body.fullName ?? '').trim();
    const firstName = String(body.first_name ?? body.firstName ?? '').trim();
    const lastName = String(body.last_name ?? body.lastName ?? '').trim();
    const nameForContact = fullName || [firstName, lastName].filter(Boolean).join(' ').trim();
    if (!nameForContact) throw badRequest('Contact name is required.');
    const phone = body.phone != null ? String(body.phone).trim() : '';
    const email = body.email != null ? String(body.email).trim() : '';
    const title = body.title != null ? String(body.title).trim() : '';
    const linkedinUrl = body.linkedin_url ?? body.linkedinUrl ?? null;

    // Account: either an existing account_id or a name to find/create.
    // For SDR, account type + services are required (user request).
    const accountTypeRaw = String(body.account_type ?? body.accountType ?? '').trim();
    const servicesRaw = Array.isArray(body.services) ? body.services
        : Array.isArray(body.service_line_keys) ? body.service_line_keys
        : Array.isArray(body.service_lines) ? body.service_lines
        : (body.service_line_key ? [String(body.service_line_key)] : []);
    const servicesClean = servicesRaw.map((s) => String(s).trim()).filter(Boolean);
    if (ctx.role === 'sdr' && (!accountTypeRaw || !servicesClean.length)) {
        throw badRequest('Account type and at least one service are required when an SDR adds a contact.');
    }
    if (accountTypeRaw && !['Egypt', 'Regional'].includes(accountTypeRaw)) {
        throw badRequest('Account type must be Egypt or Regional.');
    }

    let accountId = body.account_id ?? body.accountId ?? null;
    const accountNameRaw = String(body.account_name ?? body.accountName ?? '').trim();
    if (!accountId && accountNameRaw) {
        const existing = get(
            `SELECT id FROM accounts WHERE workspace_id = ? AND lower(name) = lower(?) AND deleted_at IS NULL LIMIT 1`,
            [ctx.workspaceId, accountNameRaw],
        );
        if (existing) {
            accountId = existing.id;
            // If SDR provided type/services and existing account lacks them, patch it
            if (accountTypeRaw || servicesClean.length) {
                try {
                    const patch = {};
                    if (accountTypeRaw) patch.account_type = accountTypeRaw;
                    if (servicesClean.length) patch.services = servicesClean;
                    updateRecord('account', ctx, accountId, patch);
                } catch {}
            }
        } else {
            const accountPayload = {
                name: accountNameRaw,
                lifecycle_stage: 'prospect',
                phone: phone || undefined,
                account_type: accountTypeRaw || undefined,
                services: servicesClean.length ? servicesClean : undefined,
            };
            for (const k of Object.keys(accountPayload)) if (accountPayload[k] === undefined) delete accountPayload[k];
            const account = createRecord('account', ctx, accountPayload);
            accountId = account.id;
        }
    } else if (!accountId && !accountNameRaw && ctx.role === 'sdr') {
        throw badRequest('Account / Company is required.');
    }

    // Build contact payload — let repo validation handle required fields.
    const contactInput = {
        full_name: nameForContact,
        first_name: firstName || undefined,
        last_name: lastName || undefined,
        phone: phone || undefined,
        email: email || undefined,
        title: title || undefined,
        linkedin_url: linkedinUrl || undefined,
        account_id: accountId || undefined,
        owner_id: ctx.userId,
        data_source: 'cold calling',
    };
    // Remove undefined keys so repo defaults apply.
    for (const k of Object.keys(contactInput)) if (contactInput[k] === undefined) delete contactInput[k];

    const contact = createRecord('contact', ctx, contactInput);

    // Auto-assign to the caller's own queue.
    // Managers/reps use the normal assignContacts path (which checks calling.assign_own).
    // SDRs hold only calling.work and are normally forbidden from putting anything
    // on a queue themselves — this dedicated create-from-calling door is the one
    // exception: a freshly created lead they just typed is allowed on their own
    // queue without needing calling.assign_own. Generic POST /api/calling/assign
    // stays refused for SDRs (see test 'an SDR cannot assign').
    let assignResult;
    const priority = body.priority ?? 'B';
    if (can(ctx, 'calling.manage') || can(ctx, 'calling.assign_own')) {
        const assignedTo = can(ctx, 'calling.manage') && body.assignedTo ? body.assignedTo : ctx.userId;
        assignResult = assignContacts(ctx, { contactIds: [contact.id], assignedTo, priority });
    } else if (ctx.role === 'sdr' && can(ctx, 'calling.work')) {
        const assignedTo = ctx.userId;
        const hasPhone = !!String(contact.phone ?? '').trim();
        if (!hasPhone) {
            // Mirrors assignContacts: a lead with no number never touches the
            // queue, it is just skipped and reported. The contact itself is
            // still created above — only the queue placement is withheld.
            assignResult = {
                assigned: 0,
                reassigned: 0,
                skipped: [],
                conflicts: [],
                reengage: [],
                missing: [],
                needsConfirmation: false,
                skippedNoPhone: [{ contactId: contact.id, name: contact.full_name || nameForContact }],
                withoutPhone: 1,
                withoutAccount: !contact.account_id ? 1 : 0,
                sdr: { id: assignedTo, name: ctx.user?.name ?? assignedTo },
            };
        } else {
            const stamp = now();
            const assignmentId = id('cas');
            tx(() => {
                run(
                    `INSERT INTO calling_assignments (id, workspace_id, contact_id, account_id, assigned_to, assigned_by, assigned_at, queue_status, priority, campaign_id, active, created_at, updated_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                    [assignmentId, ctx.workspaceId, contact.id, contact.account_id ?? null, assignedTo, ctx.userId, stamp, 'queued', priority, null, 1, stamp, stamp],
                );
                audit(ctx, {
                    objectKey: 'contact',
                    recordId: contact.id,
                    accountId: contact.account_id ?? null,
                    action: 'calling_assigned',
                    after: { assignedTo, priority },
                });
                if (contact.account_id) {
                    const deal = ensureDealForAccount(ctx, contact.account_id, 'a contact was assigned to cold calling');
                    if (deal) advanceDealToStage(ctx, deal.id, 'ready_to_call', 'a contact was assigned to cold calling');
                }
            });
            try {
                const { notifyQueueAssigned } = await import('../lib/notify.mjs');
                notifyQueueAssigned(ctx, { userId: assignedTo, count: 1, priority, link: `/calling?open=${assignmentId}` });
            } catch {}
            assignResult = {
                assigned: 1,
                reassigned: 0,
                skipped: [],
                conflicts: [],
                reengage: [],
                missing: [],
                needsConfirmation: false,
                skippedNoPhone: [],
                withoutPhone: 0,
                withoutAccount: !contact.account_id ? 1 : 0,
                sdr: { id: assignedTo, name: ctx.user?.name ?? assignedTo },
            };
        }
    } else {
        require$(ctx, 'calling.assign_own');
    }
    // assignContacts with a fresh contact never needs confirmation, but handle it anyway.
    if (assignResult.needsConfirmation) {
        // For a brand-new contact this should not happen; surface it rather than swallow.
        return { contact, accountId, assignment: assignResult, message: describeAssignment(assignResult) };
    }

    const createdName = contact.full_name || nameForContact;
    const atAccount = accountNameRaw ? ` at ${accountNameRaw}` : '';
    return {
        contact,
        accountId,
        assignment: assignResult,
        message: assignResult.assigned
            ? `${createdName} created${atAccount} and added to ${assignResult.sdr?.name ?? 'your'} queue.`
            : `${createdName} created${atAccount}, but not added to the queue — no phone number.`,
    };
}

function describeAssignment(result) {
    if (result.needsConfirmation && result.conflicts.length) {
        const names = result.conflicts.slice(0, 3).map((c) => c.name).join(', ');
        const more = result.conflicts.length > 3 ? ` and ${result.conflicts.length - 3} more` : '';
        return `${names}${more} ${result.conflicts.length === 1 ? 'is' : 'are'} already on another queue.`;
    }
    if (result.needsConfirmation && result.reengage?.length) {
        const names = result.reengage.slice(0, 3).map((c) => c.name).join(', ');
        const more = result.reengage.length > 3 ? ` and ${result.reengage.length - 3} more` : '';
        return `${names}${more} already went through the calling sequence and ${result.reengage.length === 1 ? 'was' : 'were'} retired.`;
    }
    const parts = [];
    if (result.assigned) parts.push(`${result.assigned} added to ${result.sdr.name}'s calling queue`);
    if (result.reassigned) parts.push(`${result.reassigned} moved to ${result.sdr.name}`);
    if (result.skipped.length) parts.push(`${result.skipped.length} already there`);
    if (result.skippedNoPhone?.length) parts.push(`${result.skippedNoPhone.length} skipped — no phone number`);
    if (result.missing.length) parts.push(`${result.missing.length} no longer exist`);
    return parts.length ? `${parts.join(', ')}.` : 'Nothing changed.';
}

/* --------------------------------------------------------------- queues -- */

/** `filter` and `sort` arrive as JSON, exactly as they do on every list route. */
function jsonParam(url, name) {
    const raw = url.searchParams.get(name);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        throw badRequest(`The ${name} parameter is not valid JSON.`);
    }
}

export async function listQueue({ url, ctx }) {
    return queue(ctx, {
        sdrId: url.searchParams.get('sdr') || null,
        performedBy: url.searchParams.get('performedBy') || null,
        tab: url.searchParams.get('tab') || 'to_call',
        page: Number(url.searchParams.get('page')) || 1,
        limit: Number(url.searchParams.get('limit')) || 50,
        filter: jsonParam(url, 'filter'),
        sort: jsonParam(url, 'sort'),
        q: url.searchParams.get('q') || null,
        ...queueRange(url, ctx),
    });
}

/**
 * Every contact id the current queue view matches — for "select all N
 * matching" on Reassign, which the 200-row cap on `listQueue` cannot answer.
 */
export async function queueIds({ url, ctx }) {
    require$(ctx, 'calling.manage');
    return {
        ids: queueContactIds(ctx, {
            sdrId: url.searchParams.get('sdr') || null,
            performedBy: url.searchParams.get('performedBy') || null,
            tab: url.searchParams.get('tab') || 'to_call',
            filter: jsonParam(url, 'filter'),
            q: url.searchParams.get('q') || null,
            ...queueRange(url, ctx),
        }),
    };
}

export async function counts({ url, ctx }) {
    return queueCounts(ctx, {
        sdrId: url.searchParams.get('sdr') || null,
        filter: jsonParam(url, 'filter'),
        ...queueRange(url, ctx),
    });
}

/**
 * The date range a manager scoped the queue to, resolved like the dashboard's.
 *
 * The queue is read through the same `range`/`from`/`to` query parameters the
 * dashboard uses, so "who did we call this week" on the dashboard and in the
 * calling screen can never be answered differently: both resolve through
 * `resolveRange`, in the workspace's own clock. `all` carries no instants, and
 * an absent range is the default, unfiltered queue.
 */
function queueRange(url, ctx) {
    /**
     * An absent `range` param means "unfiltered queue" here — the calling
     * console's own default (queueRange = '') never sends the param at all
     * expecting exactly that. `resolveRange` was built for the dashboard,
     * where an absent preset means "this month" instead; passing that
     * default through unchanged made the queue silently require every
     * assignment to have a CALL ACTIVITY dated within the current calendar
     * month (see the range-join below) to appear in ANY tab at all — a
     * contact assigned today but not yet called, or one last called in a
     * different month than a later-due follow-up, simply vanished with no
     * error. `'all'` is resolved explicitly so an absent param means what
     * this screen has always claimed it means.
     */
    const range = resolveRange(
        {
            preset: url.searchParams.get('range') ?? 'all',
            from: url.searchParams.get('from') ?? undefined,
            to: url.searchParams.get('to') ?? undefined,
        },
        { timeZone: ctx.workspace?.timezone || 'UTC', weekendDays: ctx.workspace?.weekendDays },
    );
    if (!range.from || !range.to) return {};
    return { from: range.from, to: range.to };
}

export async function readAssignment({ params, ctx }) {
    return assignment(ctx, params.id);
}

/**
 * Edit the LEAD behind a calling assignment, from inside the console.
 *
 * The one door an SDR has to change a lead's own details without leaving
 * the calling screen — the generic PATCH /api/contacts/:id is 403 for them
 * (see the file comment above), so this reaches the contact the same way
 * every other read here does: through an assignment `assignment()` (see
 * lib/calling.mjs) already scopes to the caller's own queue, or the whole
 * floor under `calling.manage`. That lookup throws `notFound` for an id
 * outside the caller's scope, the same as it does for readAssignment.
 *
 * The write itself is the ordinary contact update (`updateRecord`,
 * lib/repo.mjs) — validated, audited and reindexed exactly like editing the
 * field on the contact record page, not a second write path with its own
 * rules. Only the handful of fields a lead's own record carries are
 * accepted; queue-level facts (priority, queue status, who it is assigned
 * to) are edited through the existing `/api/calling/priority`,
 * `/api/calling/status` and `/api/calling/assign` endpoints instead — they
 * already require `calling.manage`, and this endpoint does not widen that.
 */
const EDITABLE_CONTACT_FIELDS = [
    'full_name', 'first_name', 'last_name', 'title', 'phone', 'email', 'linkedin_url', 'services',
];
export async function editContact({ req, params, ctx }) {
    const current = assignment(ctx, params.id);
    const body = await readJson(req);
    const patch = {};
    for (const key of EDITABLE_CONTACT_FIELDS) {
        if (Object.hasOwn(body, key)) patch[key] = body[key];
    }
    if (!Object.keys(patch).length) throw badRequest('Nothing to update.');
    const contact = updateRecord('contact', ctx, current.contactId, patch);
    return { contact };
}

/**
 * The SDR's home: the numbers for today, and where to carry on.
 *
 * "Called today" is counted from the CALL ACTIVITIES, not from the queue —
 * a contact rung three times today is three calls, and the queue row only
 * remembers the last one.
 */
export async function today({ url, ctx }) {
    const sdrId = can(ctx, 'calling.manage') ? (url.searchParams.get('sdr') || null) : ctx.userId;
    const filter = jsonParam(url, 'filter');
    const q = url.searchParams.get('q') || null;
    const totals = queueCounts(ctx, { sdrId });
    const next = nextInQueue(ctx, { sdrId, filter, q });

    const who = sdrId ?? ctx.userId;
    const since = startOfDay(ctx);
    const row = all(
        `SELECT outcome, COUNT(*) AS n FROM activities
          WHERE workspace_id = ? AND type_key = 'call' AND actor_id = ?
            AND occurred_at >= ? AND deleted_at IS NULL
          GROUP BY outcome`,
        [ctx.workspaceId, who, since],
    );
    const byOutcome = Object.fromEntries(row.map((r) => [r.outcome, r.n]));
    const calledToday = row.reduce((a, r) => a + r.n, 0);

    return {
        assigned: totals.all,
        remaining: totals.to_call,
        // Due NOW, and not the lead already on screen — see
        // `otherFollowUpsDueNow`'s own comment. `totals.follow_ups` (the
        // Follow-ups TAB count) is a different question: the whole
        // mid-sequence book, whatever each one's next date is.
        followUpsDue: otherFollowUpsDueNow(ctx, { sdrId, excludeAssignmentId: next?.id ?? null }),
        completed: totals.completed,
        calledToday,
        meetingsToday: byOutcome.meeting_scheduled ?? 0,
        qualifiedToday: byOutcome.qualified ?? 0,
        next,
    };
}

/** Midnight in the workspace's own timezone, so "today" means their today. */
function startOfDay(ctx) {
    const zone = ctx.workspace?.timezone || 'UTC';
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    // Reuse the range resolver rather than repeating offset arithmetic here.
    return resolveDayStart(parts, zone);
}

function resolveDayStart(isoDay, zone) {
    const [year, month, day] = isoDay.split('-').map(Number);
    const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
    const probe = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(guess)).reduce((acc, p) => {
        if (p.type !== 'literal') acc[p.type] = Number(p.value);
        return acc;
    }, {});
    const offset = Date.UTC(
        probe.year, probe.month - 1, probe.day, probe.hour % 24, probe.minute, probe.second,
    ) - guess;
    return new Date(guess - offset).toISOString();
}

/* ---------------------------------------------------------------- calls -- */

/**
 * Record one call and hand back the next contact in the same response.
 *
 * Both in one round trip on purpose: Save & Next is the interaction the whole
 * module is judged on, and a second request to find out who is next would put a
 * visible pause in the middle of it.
 */
export async function call({ req, params, ctx }) {
    const body = await readJson(req);

    // A plain SDR has no `sdr` to send (their own queue is the only one they
    // can see anyway) — `body.filter`/`body.sort`/`body.q`, the queue's own
    // Filters, column sort and quick search, are for everyone, same as they
    // are on the queue table.
    const sdrId = can(ctx, 'calling.manage') ? (body.sdr ?? null) : null;
    /**
     * Captured BEFORE `logCall` runs, not after — see `nextInQueue`'s own
     * comment for why the order matters: this lead's position in the queue
     * has to be read while it is still standing where the SDR was looking
     * at it, not after the save that is about to move or remove it.
     */
    const next = nextInQueue(ctx, {
        sdrId, after: params.id, filter: body.filter ?? null, sort: body.sort ?? null, q: body.q ?? null,
    });

    /**
     * 'interested' is accepted as an alias of the queue's own outcome
     * 'qualified': the pipeline stage and the business vocabulary say
     * Interested, while the calling floor has always said Qualified. One
     * translation at the boundary keeps both true.
     */
    const result = logCall(ctx, {
        assignmentId: params.id,
        outcome: body.outcome === 'interested' ? 'qualified' : body.outcome,
        note: body.note ?? '',
        followUpAt: body.followUpAt ?? null,
        meetingAt: body.meetingAt ?? null,
        idempotencyKey: body.idempotencyKey ?? null,
        nextStep: body.nextStep ?? null,
    });

    return {
        ...result,
        next,
        counts: queueCounts(ctx, { sdrId }),
        /**
         * The same due-now figure `today()` returns on page load — see its
         * comment. Without this the response's only follow-up count was
         * `counts.follow_ups` (`queueCounts`'s whole-book figure: every lead
         * currently mid-sequence, whatever their next step's date), and the
         * frontend had nothing else to reach for after a call, so "N due —
         * work them now" started reading the book size instead of "due now"
         * the moment a single call was logged — including on the very lead
         * whose own follow-up isn't due yet.
         */
        followUpsDue: otherFollowUpsDueNow(ctx, { sdrId, excludeAssignmentId: next?.id ?? null }),
    };
}

/**
 * Log a WhatsApp or an email sent to a lead — see `logMessage` in
 * lib/calling.mjs for why this is not folded into `call` above: it is not
 * an outcome, and does not advance the queue.
 */
export async function message({ req, params, ctx }) {
    const body = await readJson(req);
    return logMessage(ctx, {
        assignmentId: params.id,
        channel: body.channel,
        note: body.note ?? '',
        idempotencyKey: body.idempotencyKey ?? null,
    });
}

export async function history({ params, ctx }) {
    // Reached through the assignment, so an SDR cannot read the call history of
    // a contact that is not on their list by passing its id.
    const target = assignment(ctx, params.id);
    return { contactId: target.contactId, calls: callHistory(ctx, target.contactId, { limit: 50 }) };
}

/**
 * Wipe this contact's calling history back to a blank slate — admin-only,
 * see `clearCallingActivity` in lib/calling.mjs for what that means and why
 * it is narrower than "delete the contact".
 */
export async function clearActivity({ params, ctx }) {
    return clearCallingActivity(ctx, params.id);
}

/**
 * Move an existing follow-up to a different date and time.
 *
 * A PATCH on the follow-up rather than a second kind of call: no call was made,
 * no outcome changed, and the queue entry keeps its history. `rescheduleFollowUp`
 * moves the pending sequence steps with it — see lib/calling.mjs.
 */
export async function reschedule({ req, params, ctx }) {
    const body = await readJson(req);
    return rescheduleFollowUp(ctx, params.id, body.followUpAt ?? null);
}

/* ----------------------------------------------------------- management -- */

export async function remove({ req, ctx }) {
    const body = await readJson(req);
    // Either selection shape the queue screen holds — row ids, or contact ids
    // when "select all matching" reached past this page.
    return removeFromQueue(ctx, body.assignmentIds ?? [], body.contactIds ?? []);
}

export async function prioritise({ req, ctx }) {
    const body = await readJson(req);
    return setPriority(ctx, body.assignmentIds ?? [], body.priority, body.contactIds ?? []);
}

export async function setStatus({ req, ctx }) {
    const body = await readJson(req);
    return setQueueStatus(ctx, body.assignmentIds ?? [], body.status, body.contactIds ?? []);
}

/** Bulk-set the contact-level Services behind a queue selection. */
export async function setServices({ req, ctx }) {
    const body = await readJson(req);
    return setContactServices(ctx, body.assignmentIds ?? [], body.services ?? [], body.contactIds ?? []);
}

/**
 * Log the same call outcome against every selected, live assignment —
 * the bulk edit dialog's "Outcome" field. See `bulkLogOutcome`,
 * lib/calling.mjs, for what actually happens per row.
 */
export async function logBulkOutcome({ req, ctx }) {
    const body = await readJson(req);
    return bulkLogOutcome(ctx, {
        assignmentIds: body.assignmentIds ?? [],
        contactIds: body.contactIds ?? [],
        // Same alias `call` accepts above: the calling floor says Qualified,
        // the deal stage says Interested.
        outcome: body.outcome === 'interested' ? 'qualified' : body.outcome,
        note: body.note ?? '',
        followUpAt: body.followUpAt ?? null,
        meetingAt: body.meetingAt ?? null,
    });
}

/* ---------------------------------------------- reassignment requests -- */

function reassignRequestRow(ctx, requestId) {
    return get(
        `SELECT r.*, c.full_name AS contact_name, ru.name AS requested_by_name, tu.name AS requested_to_name
           FROM contact_reassign_requests r
           LEFT JOIN contacts c ON c.id = r.contact_id
           LEFT JOIN users ru ON ru.id = r.requested_by
           LEFT JOIN users tu ON tu.id = r.requested_to
          WHERE r.id = ? AND r.workspace_id = ?`,
        [requestId, ctx.workspaceId],
    );
}

function hydrateReassignRequest(row) {
    if (!row) return null;
    return {
        id: row.id, contactId: row.contact_id, contactName: row.contact_name ?? null,
        requestedBy: row.requested_by, requestedByName: row.requested_by_name ?? null,
        requestedTo: row.requested_to, requestedToName: row.requested_to_name ?? null,
        note: row.note, status: row.status,
        reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at, reviewNote: row.review_note,
        createdAt: row.created_at, updatedAt: row.updated_at,
    };
}

/**
 * Whether THIS contact currently has a live calling-queue row, and whose.
 *
 * What the Contact record page's cold-calling button needs before it can
 * decide which of "Add", "Remove" and "Open in Cold Calling" to show —
 * one small read rather than teaching the generic contact hydration path
 * (lib/repo.mjs's `hydrate`) about a plane most contact reads never touch.
 */
export async function contactStatus({ params, ctx }) {
    if (!can(ctx, 'calling.manage') && !can(ctx, 'calling.work') && !can(ctx, 'calling.assign_own')) {
        return { assignment: null };
    }
    const row = get(
        `SELECT a.id, a.assigned_to, a.queue_status, u.name AS sdr_name
           FROM calling_assignments a
           LEFT JOIN users u ON u.id = a.assigned_to
          WHERE a.workspace_id = ? AND a.contact_id = ? AND a.active = 1`,
        [ctx.workspaceId, params.id],
    );
    return {
        assignment: row ? {
            id: row.id, sdrId: row.assigned_to, sdrName: row.sdr_name ?? null, status: row.queue_status,
        } : null,
    };
}

/**
 * An SDR or rep asks for a contact to go to somebody else.
 *
 * Neither holds enough to move it themselves — `assignContacts` forces
 * `assignedTo = ctx.userId` for anyone without `calling.manage` (see the top
 * of that function) — so this is the door instead. Nothing moves until a
 * manager reviews it; same shape as a rep's Apollo reveal request
 * (`people_enrich_requests`, requestEnrich above).
 */
export async function requestReassign({ req, params, ctx }) {
    require$(ctx, 'calling.work');
    const contact = get(
        `SELECT id, full_name, first_name, last_name, account_id, owner_id FROM contacts
          WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
        [params.id, ctx.workspaceId],
    );
    if (!contact) throw notFound('That contact does not exist.');

    const body = await readJson(req);
    const requestedTo = String(body.to ?? body.requestedTo ?? body.assignedTo ?? '').trim();
    if (!requestedTo) throw badRequest('Choose who this contact should go to.');
    if (requestedTo === ctx.userId) throw badRequest('Choose somebody other than yourself.');

    const target = get(
        `SELECT u.id, u.name FROM users u
           JOIN memberships m ON m.user_id = u.id AND m.workspace_id = ?
          WHERE u.id = ? AND u.status = 'active'`,
        [ctx.workspaceId, requestedTo],
    );
    if (!target) throw badRequest('That user is not an active member of this workspace.');
    if (contact.owner_id === target.id) throw badRequest(`${target.name} already has this contact.`);

    // One open ask per contact at a time — a second request for the same
    // contact while the first is still pending would just be a race over
    // which the manager sees first, not a second, different decision.
    const existing = get(
        `SELECT id FROM contact_reassign_requests WHERE workspace_id = ? AND contact_id = ? AND status = 'pending_approval'`,
        [ctx.workspaceId, contact.id],
    );
    if (existing) throw badRequest('A reassignment for this contact is already waiting on a manager.');

    const note = String(body.note ?? '').trim() || null;
    const stamp = now();
    const requestId = id('crr');
    run(
        `INSERT INTO contact_reassign_requests
           (id, workspace_id, contact_id, requested_by, requested_to, note, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,'pending_approval',?,?)`,
        [requestId, ctx.workspaceId, contact.id, ctx.userId, target.id, note, stamp, stamp],
    );

    openApprovalTask(ctx, 'contact_reassign', {
        id: requestId, account_id: contact.account_id ?? null,
        contact_id: contact.id, contact_name: displayName(contact), requested_to_name: target.name,
    });

    audit(ctx, {
        objectKey: 'contact', recordId: contact.id, accountId: contact.account_id ?? null,
        action: 'reassign_requested', after: { requestedTo: target.id, note },
    });

    return { request: hydrateReassignRequest(reassignRequestRow(ctx, requestId)) };
}

/** Pending requests: a manager sees the workspace's queue, everyone else sees only their own. */
export async function listReassignRequests({ ctx, url }) {
    if (!can(ctx, 'calling.manage') && !can(ctx, 'calling.work') && !can(ctx, 'calling.assign_own')) {
        throw forbidden('You do not have permission to do that.');
    }
    const status = url.searchParams.get('status');
    const clauses = ['r.workspace_id = ?'];
    const args = [ctx.workspaceId];
    if (!can(ctx, 'calling.manage')) { clauses.push('r.requested_by = ?'); args.push(ctx.userId); }
    if (status) { clauses.push('r.status = ?'); args.push(status); }
    const rows = all(
        `SELECT r.*, c.full_name AS contact_name, ru.name AS requested_by_name, tu.name AS requested_to_name
           FROM contact_reassign_requests r
           LEFT JOIN contacts c ON c.id = r.contact_id
           LEFT JOIN users ru ON ru.id = r.requested_by
           LEFT JOIN users tu ON tu.id = r.requested_to
          WHERE ${clauses.join(' AND ')} ORDER BY r.created_at DESC LIMIT 200`,
        args,
    );
    return { requests: rows.map(hydrateReassignRequest) };
}

/**
 * A manager decides. Approving runs the exact same `assignContacts` a manual
 * reassignment would — `reassign: true` because moving it off whoever holds
 * it now is the whole point, `reengage: true` because the manager has
 * already made the call by approving and should not hit a second prompt for
 * a contact whose sequence had run its course.
 */
export async function reviewReassignRequest({ req, params, ctx }) {
    require$(ctx, 'calling.manage');
    const row = get('SELECT * FROM contact_reassign_requests WHERE id = ? AND workspace_id = ?', [params.id, ctx.workspaceId]);
    if (!row) throw notFound('That request does not exist.');
    if (row.status !== 'pending_approval') {
        throw badRequest(`This request is "${row.status}", not awaiting review.`);
    }

    const body = await readJson(req).catch(() => ({}));
    const decision = String(body.decision ?? '').toLowerCase();
    if (decision !== 'approved' && decision !== 'rejected') {
        throw badRequest('A review decision is either "approved" or "rejected".');
    }
    const note = String(body.note ?? body.review_note ?? '').trim();
    if (decision === 'rejected' && !note) {
        throw badRequest('Say why it was rejected — the person who asked needs to know.');
    }

    const stamp = now();
    const link = `/contacts/${row.contact_id}`;
    const reviewerName = get('SELECT name FROM users WHERE id = ?', [ctx.userId])?.name ?? null;

    if (decision === 'rejected') {
        run(
            `UPDATE contact_reassign_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ? WHERE id = ?`,
            [ctx.userId, stamp, note, stamp, row.id],
        );
        closeApprovalTask(ctx, 'contact_reassign', row.id, 'rejected');
        notifyApprovalDecision(ctx, {
            authorId: row.requested_by, label: 'Reassignment', decision: 'rejected',
            note, reviewedBy: reviewerName, link,
        });
        return { request: hydrateReassignRequest(reassignRequestRow(ctx, row.id)) };
    }

    const current = get(
        `SELECT priority FROM calling_assignments WHERE workspace_id = ? AND contact_id = ? AND active = 1`,
        [ctx.workspaceId, row.contact_id],
    );
    const assignmentResult = assignContacts(ctx, {
        contactIds: [row.contact_id], assignedTo: row.requested_to,
        priority: current?.priority ?? 'B', reassign: true, reengage: true,
    });

    run(
        `UPDATE contact_reassign_requests SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ? WHERE id = ?`,
        [ctx.userId, stamp, note || null, stamp, row.id],
    );
    closeApprovalTask(ctx, 'contact_reassign', row.id, 'approved');
    notifyApprovalDecision(ctx, {
        authorId: row.requested_by, label: 'Reassignment', decision: 'approved',
        note: note || null, reviewedBy: reviewerName, link,
    });

    return { request: hydrateReassignRequest(reassignRequestRow(ctx, row.id)), assignment: assignmentResult };
}
