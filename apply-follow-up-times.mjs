/**
 * Gives the follow-ups already in the database the TIME they were never asked for.
 *
 *   node apply-follow-up-times.mjs            # show what would change
 *   node apply-follow-up-times.mjs --apply    # write it
 *   node --env-file=data/turso.env apply-follow-up-times.mjs
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 *
 * A follow-up is a date AND a time — "ring me back on the fifteenth at half
 * two" — but the console only ever asked for a date, so what landed in
 * `next_follow_up_at` was either a bare "2026-09-15" or that date wearing
 * midnight UTC. Both are wrong in three separate ways:
 *
 *   1. Midnight UTC is 3am in Riyadh and 2am in Cairo. The task list told reps
 *      their follow-up call was due at three in the morning.
 *   2. The Follow-ups Due tab and its count compare this column against the
 *      current instant AS TEXT. "2026-09-15" sorts before every instant on the
 *      fifteenth, so a follow-up booked for the afternoon read as overdue from
 *      midnight — the tab was a day-resolution guess wearing a clock.
 *   3. The four-step sequence gave the first task the start of the working day
 *      while the assignment kept the bare date, so the two disagreed about the
 *      same follow-up by nine hours.
 *
 * The console now sends an instant and `logCall` normalises whatever arrives, so
 * nothing new can be stored this way. This is the history.
 *
 * ── WHAT IT DOES ────────────────────────────────────────────────────────────
 *
 * Every value that carries no time of day becomes the start of the working day
 * in the workspace's own timezone — `follow_up_day_start_hour`, 9am unless the
 * workspace says otherwise. That is the same rule `normalizeFollowUpAt` applies
 * to a timeless value arriving today, imported from lib/follow-up.mjs rather
 * than reimplemented here, so the migration and the running code cannot drift.
 *
 * Values that already carry a time are LEFT ALONE. A rep who typed 14:30 chose
 * it, and a migration that rounds somebody's decision to 9am is worse than the
 * bug it is fixing.
 *
 * Three places hold the same fact and all three are corrected, because a queue
 * that agrees with the task list but not with the call history is a third
 * version of the truth:
 *
 *   calling_assignments.next_follow_up_at   what the queue reads
 *   activities.next_follow_up_at            what the call recorded
 *   tasks.due_at                            the follow-up steps themselves
 */
import { migrate, all, run, tx, close } from './lib/db.mjs';
import { normalizeFollowUpAt, hasTimeOfDay, DEFAULT_DAY_START_HOUR } from './lib/follow-up.mjs';

const APPLY = process.argv.includes('--apply');

migrate();

/** The hour this workspace's day starts, read straight from settings. */
function dayStartHour(workspaceId) {
    const row = all(
        "SELECT value FROM settings WHERE workspace_id = ? AND key = 'follow_up_day_start_hour'",
        [workspaceId],
    )[0];
    if (!row) return DEFAULT_DAY_START_HOUR;
    // Settings are stored as JSON, so a bare number arrives as "9".
    const hour = Number(String(row.value).replace(/"/g, ''));
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_DAY_START_HOUR;
}

let planned = 0;
let skipped = 0;

for (const ws of all('SELECT id, name, timezone FROM workspaces')) {
    const timezone = ws.timezone || 'UTC';
    const options = { timezone, dayStartHour: dayStartHour(ws.id) };

    /**
     * The three columns, as one list, so the reporting and the writing are the
     * same pass and a table cannot be corrected in the dry run but missed in the
     * apply.
     */
    const targets = [
        {
            what: 'calling_assignments.next_follow_up_at',
            rows: all(
                `SELECT id, next_follow_up_at AS value FROM calling_assignments
                  WHERE workspace_id = ? AND next_follow_up_at IS NOT NULL`,
                [ws.id],
            ),
            write: (id, value) => run('UPDATE calling_assignments SET next_follow_up_at = ? WHERE id = ?', [value, id]),
        },
        {
            what: 'activities.next_follow_up_at',
            rows: all(
                `SELECT id, next_follow_up_at AS value FROM activities
                  WHERE workspace_id = ? AND next_follow_up_at IS NOT NULL`,
                [ws.id],
            ),
            write: (id, value) => run('UPDATE activities SET next_follow_up_at = ? WHERE id = ?', [value, id]),
        },
        {
            /**
             * Only the tasks the sequence created. An ordinary task due "on the
             * fifteenth" was typed by a person who may well have meant the day,
             * and this migration has no business rewriting it.
             */
            what: 'tasks.due_at (follow-up steps)',
            rows: all(
                `SELECT id, due_at AS value FROM tasks
                  WHERE workspace_id = ? AND due_at IS NOT NULL
                    AND properties LIKE '%"follow_up"%'`,
                [ws.id],
            ),
            write: (id, value) => run('UPDATE tasks SET due_at = ? WHERE id = ?', [value, id]),
        },
    ];

    for (const target of targets) {
        const changes = [];
        for (const row of target.rows) {
            if (hasTimeOfDay(row.value)) { skipped += 1; continue; }
            const fixed = normalizeFollowUpAt(row.value, options);
            // Unreadable text stays exactly as it is: it is evidence of how it
            // got there, and inventing an instant for it would destroy that.
            if (!fixed || fixed === row.value) { skipped += 1; continue; }
            changes.push({ id: row.id, from: row.value, to: fixed });
        }

        if (!changes.length) continue;
        planned += changes.length;

        console.log(`\n${ws.name} — ${target.what}: ${changes.length} to correct (${timezone}, day starts ${options.dayStartHour}:00)`);
        for (const change of changes.slice(0, 8)) {
            console.log(`  ${change.id}  ${change.from}  ->  ${change.to}`);
        }
        if (changes.length > 8) console.log(`  … and ${changes.length - 8} more`);

        if (!APPLY) continue;
        tx(() => {
            for (const change of changes) target.write(change.id, change.to);
        });
    }
}

console.log(`\n${planned} value(s) ${APPLY ? 'corrected' : 'to correct'}, ${skipped} already carried a time.`);
if (!planned) console.log('Nothing to do.');
else if (!APPLY) console.log('Dry run. Re-run with --apply to write it.');

close();
