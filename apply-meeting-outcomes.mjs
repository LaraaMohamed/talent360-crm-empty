/**
 * Gives meetings that predate the meeting columns a date and a state.
 *
 *   node apply-meeting-outcomes.mjs            # show what would change
 *   node apply-meeting-outcomes.mjs --apply    # write it
 *   node --env-file=data/turso.env apply-meeting-outcomes.mjs --apply
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 *
 * A meeting is now a fact with its own date (`activities.meeting_at`) and its
 * own state (`activities.meeting_status`). Every meeting logged before those
 * columns existed has neither, so the meetings analytics cannot see it at all —
 * the query reads `meeting_at IS NOT NULL`, and a null date means the meeting
 * is absent from the funnel rather than merely undated.
 *
 * ── WHERE THE DATE COMES FROM ───────────────────────────────────────────────
 *
 *   1. `properties.meetingAt`, for the rows the calling screen wrote before the
 *      column existed. That is the real thing: when the meeting was to be HELD.
 *   2. `occurred_at` otherwise — the only date such a row has. For a meeting
 *      logged after the fact the two are the same day anyway; for one booked
 *      ahead in the old shape they are not, and this is the honest fallback
 *      rather than a guess dressed up as data.
 *
 * Which of the two was used is recorded on each row's `properties` as
 * `meetingAtSource`, so nobody has to wonder later whether a date is the real
 * meeting time or a stand-in.
 *
 * ── WHY NOTHING IS EVER MARKED DONE OR NO SHOW ──────────────────────────────
 *
 * A NO SHOW IS A FACT SOMEBODY RECORDS. It is never inferred here, and neither
 * is Done: a meeting activity in the past is evidence that somebody wrote it
 * down, not evidence that the prospect turned up. Marking them Done would
 * manufacture a show rate out of rows nobody ever classified, and a fabricated
 * 100% is worse than no rate at all.
 *
 * So every backfilled row is `scheduled`. Those whose time has passed surface
 * in the analytics as UNCLASSIFIED — which is exactly what they are, and is a
 * queue a person can work rather than a number nobody can trust.
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
 *
 * Rows that already carry a `meeting_at` are left entirely alone: they were
 * written under the current model and this has nothing to add. Deleted rows are
 * skipped. Running it twice changes nothing the second time.
 */
import { migrate, all, get, run, tx, now, close } from './lib/db.mjs';

const APPLY = process.argv.includes('--apply');

migrate();

/**
 * Which activities are meetings.
 *
 * By type FIRST, because that is what the object model calls a meeting, and by
 * outcome as well, because a call whose outcome booked one carries the meeting
 * on the call row itself. `kickoff` is included: it is a meeting that happens,
 * and leaving it out would put a hole in the funnel at exactly the stage the
 * business cares most about.
 */
const MEETING_TYPES = ['meeting', 'kickoff'];
const MEETING_OUTCOMES = ['meeting_scheduled', 'meeting_done'];

const candidates = all(
    `SELECT id, workspace_id, type_key, outcome, subject, occurred_at, properties, actor_id
       FROM activities
      WHERE meeting_at IS NULL
        AND deleted_at IS NULL
        AND (type_key IN (${MEETING_TYPES.map(() => '?').join(',')})
             OR outcome IN (${MEETING_OUTCOMES.map(() => '?').join(',')}))
      ORDER BY occurred_at`,
    [...MEETING_TYPES, ...MEETING_OUTCOMES],
);

/** `properties` is TEXT holding JSON; a malformed one must not stop the run. */
function properties(row) {
    try {
        const parsed = JSON.parse(row.properties ?? '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

const plan = candidates.map((row) => {
    const props = properties(row);
    const stated = typeof props.meetingAt === 'string' ? props.meetingAt.trim() : '';
    return {
        row,
        props,
        meetingAt: stated || row.occurred_at,
        source: stated ? 'properties.meetingAt' : 'occurred_at',
    };
});

if (!plan.length) {
    console.log('\nEvery meeting already has a date. Nothing to backfill.');
    close();
    process.exit(0);
}

const clock = now();
const stale = plan.filter((p) => p.meetingAt < clock).length;

console.log(`\n${plan.length} meeting(s) to date:\n`);
for (const p of plan) {
    const when = String(p.meetingAt).slice(0, 16).replace('T', ' ');
    const past = p.meetingAt < clock ? '  → unclassified (its time has passed)' : '  → upcoming';
    console.log(`  ${when}  ${p.row.type_key}${p.row.outcome ? `/${p.row.outcome}` : ''}`
        + `  ${p.row.subject ?? '(no subject)'}`);
    console.log(`      from ${p.source}${past}`);
}

console.log(`\nAll of them are written as \`scheduled\`. ${stale} whose time has passed will show as`);
console.log('UNCLASSIFIED for somebody to mark Done or No Show — neither is inferred here, because');
console.log('a meeting nobody classified is not evidence that anyone turned up.');

if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write it.');
    close();
    process.exit(0);
}

let written = 0;
for (const p of plan) {
    tx(() => {
        run(
            `UPDATE activities
                SET meeting_at = ?, meeting_status = 'scheduled', properties = ?, updated_at = ?
              WHERE id = ?`,
            [
                p.meetingAt,
                // Recorded, so a reader can tell a real meeting time from the
                // stand-in this script had to use.
                JSON.stringify({ ...p.props, meetingAt: p.meetingAt, meetingAtSource: p.source }),
                now(),
                p.row.id,
            ],
        );
        written += 1;
    });
}

console.log(`\nDated ${written} meeting(s).`);

const check = get(
    `SELECT COUNT(*) AS n FROM activities
      WHERE meeting_at IS NOT NULL AND meeting_status = 'scheduled' AND deleted_at IS NULL`,
);
console.log(`The analytics can now see ${check.n} scheduled meeting(s).`);

close();
