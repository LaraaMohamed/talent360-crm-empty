/**
 * Meetings — the list `/calendar` and the dashboard's "Meetings scheduled"
 * tile both point at facts about, without either ever showing the meetings
 * themselves as a list. See lib/meetings.mjs's listMeetings for why this
 * needed to exist.
 */
import { listMeetings, settleMeeting, MEETING_STATUSES } from '../lib/meetings.mjs';
import { syncAssignmentAfterMeetingSettled } from '../lib/calling.mjs';
import { listMembers, can, require$ } from '../lib/auth.mjs';
import { resolveRange } from '../lib/date-range.mjs';
import { readJson } from '../lib/http.mjs';

export async function list({ url, ctx }) {
    const range = resolveRange(
        {
            preset: url.searchParams.get('range') ?? 'all',
            from: url.searchParams.get('from') ?? undefined,
            to: url.searchParams.get('to') ?? undefined,
        },
        { timeZone: ctx.workspace?.timezone || 'UTC', weekendDays: ctx.workspace?.weekendDays },
    );
    const result = listMeetings(ctx, {
        status: url.searchParams.get('status') || null,
        from: range?.from ?? null,
        to: range?.to ?? null,
        // A confined SDR sees their own meetings only — same rule My Work
        // enforces for tasks/notes — regardless of what `?sdr=` asks for.
        // Every other role keeps exactly what it already had.
        sdrId: ctx.role === 'sdr' ? ctx.userId : (url.searchParams.get('sdr') || null),
        q: url.searchParams.get('q') || null,
        page: Number(url.searchParams.get('page')) || 1,
        limit: Number(url.searchParams.get('limit')) || 50,
    });
    return { ...result, statuses: MEETING_STATUSES };
}

/**
 * Mark a meeting Done or No show straight from the list — the same
 * `settleMeeting` a call's "Meeting Done"/"Meeting No Show" outcome uses
 * (lib/calling.mjs), reached here without having to leave this page, find
 * the right SDR's queue, and log an unrelated call just to close out a
 * meeting already in front of you.
 *
 * `syncAssignmentAfterMeetingSettled` is the other half of that same
 * outcome — the calling queue's own `last_outcome`/`queue_status`, which
 * `settleMeeting` alone never touches (see its own comment in
 * lib/calling.mjs for why). Without it, a meeting settled here kept
 * reading "Meeting Scheduled" on the calling queue — resolved everywhere
 * except the one screen the SDR actually works from.
 */
export async function settle({ req, params, ctx }) {
    require$(ctx, can(ctx, 'calling.manage') ? 'calling.manage' : 'calling.work');
    const body = await readJson(req);
    const meeting = settleMeeting(ctx, params.id, body.status, {
        note: body.note ?? null,
        // A confined SDR may only settle a meeting that is theirs — the
        // route-level check above only proves they can settle SOMETHING.
        restrictToUserId: ctx.role === 'sdr' ? ctx.userId : null,
    });
    syncAssignmentAfterMeetingSettled(ctx, meeting.assignment_id, body.status);
    return { ok: true };
}

/** Who a meeting can be assigned to — same list the calling console offers. */
export async function meta({ ctx }) {
    return {
        statuses: MEETING_STATUSES,
        sdrs: listMembers(ctx.workspaceId)
            .filter((m) => m.status === 'active')
            .map((m) => ({ id: m.id, name: m.name })),
    };
}
