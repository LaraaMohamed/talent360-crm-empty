/**
 * Replaces the "Site visit" activity type with "Kickoff".
 *
 *   node apply-kickoff-activity-type.mjs            # show what would change
 *   node apply-kickoff-activity-type.mjs --apply    # write it
 *   node --env-file=data/turso.env apply-kickoff-activity-type.mjs
 *
 * ── WHAT SITE VISIT ACTUALLY WAS ────────────────────────────────────────────
 *
 * Not a stage. Nothing in the pipeline was ever called Site visit — it is one
 * of the eight seeded rows in `activity_types`, the list behind the "log an
 * activity" picker, sitting sixth between WhatsApp and Proposal sent.
 *
 * That matters for how it is removed. A stage would have deals standing in it;
 * an activity type has HISTORY logged against it, and `activities.type_key`
 * stores the key as a string rather than a foreign key. Deleting the row would
 * leave every site visit anybody ever recorded pointing at a type that no
 * longer exists — rendered by the timeline's fallback bullet, unfilterable,
 * and unexplainable to whoever logged it.
 *
 * So this RENAMES, in one transaction: the type row and every activity that
 * refers to it move together. A visit logged last March reads as a Kickoff
 * afterwards, which is the honest outcome — the same event, under the name the
 * business now uses for it.
 *
 * ── POSITION ────────────────────────────────────────────────────────────────
 *
 * Last in the arc rather than sixth. A kickoff is what happens once a deal is
 * signed and handed to delivery, so it belongs after Proposal sent, not in the
 * middle of the outreach types. "Logged note" stays at the end because it is
 * not a step in the arc at all.
 *
 * ── IF A WORKSPACE ALREADY HAS BOTH ─────────────────────────────────────────
 *
 * Then the rename would collide on (workspace_id, key). The site_visit
 * activities are repointed at the existing kickoff row and the old type is
 * deleted, which is the same end state by a different route.
 */
import { migrate, all, get, run, tx, now, close } from './lib/db.mjs';

const APPLY = process.argv.includes('--apply');

const OLD_KEY = 'site_visit';
const NEW_KEY = 'kickoff';
const NEW_LABEL = 'Kickoff';
const NEW_ICON = 'flag';
const NEW_COLOR = 'success';
const AFTER = 'proposal_sent';

migrate();

let renamed = 0;
let merged = 0;
let movedActivities = 0;

for (const ws of all('SELECT id, name FROM workspaces')) {
    const old = get(
        'SELECT * FROM activity_types WHERE workspace_id = ? AND key = ?',
        [ws.id, OLD_KEY],
    );
    if (!old) continue;

    const existing = get(
        'SELECT * FROM activity_types WHERE workspace_id = ? AND key = ?',
        [ws.id, NEW_KEY],
    );

    const affected = Number(get(
        'SELECT COUNT(*) AS n FROM activities WHERE workspace_id = ? AND type_key = ?',
        [ws.id, OLD_KEY],
    )?.n) || 0;

    // Where it should sit: straight after Proposal sent, with everything below
    // it shifted down one so the picker stays in the order the work happens.
    const anchor = get(
        'SELECT position FROM activity_types WHERE workspace_id = ? AND key = ?',
        [ws.id, AFTER],
    );
    const target = anchor ? Number(anchor.position) + 1 : Number(old.position);

    const verb = existing ? 'merge into existing' : 'rename';
    console.log(
        `${ws.name}: ${verb} ${OLD_KEY} -> ${NEW_KEY}`
        + `, ${affected} logged ${affected === 1 ? 'activity' : 'activities'} carried across`
        + (existing ? '' : `, position ${old.position} -> ${target}`),
    );

    if (!APPLY) {
        if (existing) merged++; else renamed++;
        movedActivities += affected;
        continue;
    }

    tx(() => {
        run(
            'UPDATE activities SET type_key = ?, updated_at = ? WHERE workspace_id = ? AND type_key = ?',
            [NEW_KEY, now(), ws.id, OLD_KEY],
        );

        if (existing) {
            run('DELETE FROM activity_types WHERE id = ?', [old.id]);
        } else {
            // Shift the tail down BEFORE claiming the slot, and skip the row
            // being moved so it does not push itself.
            run(
                `UPDATE activity_types SET position = position + 1
                  WHERE workspace_id = ? AND position >= ? AND id <> ?`,
                [ws.id, target, old.id],
            );
            run(
                `UPDATE activity_types
                    SET key = ?, label = ?, icon = ?, color = ?, position = ?
                  WHERE id = ?`,
                [NEW_KEY, NEW_LABEL, NEW_ICON, NEW_COLOR, target, old.id],
            );
        }
    });

    if (existing) merged++; else renamed++;
    movedActivities += affected;
}

const total = renamed + merged;
if (!total) {
    console.log('Nothing to do — no workspace has a Site visit activity type.');
} else {
    console.log(
        `\n${APPLY ? 'Applied' : 'Would apply'}: `
        + `${renamed} renamed, ${merged} merged, ${movedActivities} activities carried across.`,
    );
    if (!APPLY) console.log('Re-run with --apply to write it.');
}

close();
