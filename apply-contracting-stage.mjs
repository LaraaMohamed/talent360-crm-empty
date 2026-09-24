/**
 * Adds a Contracting stage immediately after Negotiation.
 *
 *   node apply-contracting-stage.mjs            # show what would change
 *   node apply-contracting-stage.mjs --apply    # write it
 *   node --env-file=data/turso.env apply-contracting-stage.mjs
 *
 * ── WHY THIS STAGE, WHEN ONE LIKE IT WAS REMOVED ────────────────────────────
 *
 * The pipeline used to carry "Agreement sent" between Negotiation and the win,
 * and setup.mjs still explains why it went: a stage that mirrors another
 * object's status is two places to update and two places to disagree.
 *
 * That argument was about a stage somebody had to remember to drag a card
 * into. This one nobody touches. Creating an agreement moves the deal here,
 * signing moves it to Won, and terminating moves it to Lost — all in
 * lib/repo.mjs, from the agreement's own status. The stage cannot disagree
 * with the document because it is never set by hand.
 *
 * ── POSITION ────────────────────────────────────────────────────────────────
 *
 * Straight after Negotiation, which means every later stage shifts down one.
 * Positions are rewritten in a single pass so the board's columns stay in the
 * order the sales process actually runs in, rather than the new stage landing
 * at the end where nobody would look for it.
 *
 * Nothing is moved between stages here. Deals stay exactly where they are; the
 * automation only applies from the next agreement onwards.
 */
import { migrate, all, get, run, tx, id, now, close } from './lib/db.mjs';

const APPLY = process.argv.includes('--apply');
const KEY = 'contracting';
const LABEL = 'Contracting';
const AFTER = 'negotiation';
const PROBABILITY = 85;

migrate();

let added = 0;
for (const ws of all('SELECT id, name FROM workspaces')) {
    const pipelines = all(
        "SELECT * FROM pipelines WHERE workspace_id = ? AND object_key = 'deal' ORDER BY position",
        [ws.id],
    );

    for (const pipeline of pipelines) {
        const stages = all('SELECT * FROM stages WHERE pipeline_id = ? ORDER BY position', [pipeline.id]);
        const anchor = stages.find((s) => s.key === AFTER);
        if (!anchor) {
            console.log(`${ws.name} / ${pipeline.label}: no "${AFTER}" stage — skipped`);
            continue;
        }
        if (stages.some((s) => s.key === KEY)) {
            console.log(`${ws.name} / ${pipeline.label}: already has "${KEY}"`);
            continue;
        }

        // The order it will read in afterwards, so a dry run shows the board.
        const planned = [];
        for (const s of stages) {
            planned.push(s.label);
            if (s.key === AFTER) planned.push(`${LABEL}  <-- new`);
        }
        console.log(`\n${ws.name} / ${pipeline.label}`);
        planned.forEach((label, i) => console.log(`  ${String(i).padStart(2)}  ${label}`));
        added += 1;

        if (!APPLY) continue;

        tx(() => {
            // Everything at or after the anchor's position moves down one,
            // highest first so no two rows collide on a position on the way.
            const shift = stages.filter((s) => s.position > anchor.position).reverse();
            for (const s of shift) {
                run('UPDATE stages SET position = ? WHERE id = ?', [s.position + 1, s.id]);
            }
            run(
                `INSERT INTO stages (id, workspace_id, pipeline_id, key, label, position, probability, type,
                                     wip_limit, required_fields)
                 VALUES (?,?,?,?,?,?,?,'open',NULL,'[]')`,
                [id('stg'), ws.id, pipeline.id, KEY, LABEL, anchor.position + 1, PROBABILITY],
            );
        });
    }
}

if (!added) {
    console.log('\nNothing to add.');
    close();
    process.exit(0);
}

if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write it.');
    close();
    process.exit(0);
}

console.log(`\nAdded "${LABEL}" to ${added} pipeline(s).`);

// Positions must still be a clean sequence, or the board draws columns in an
// order nobody chose.
for (const p of all("SELECT * FROM pipelines WHERE object_key = 'deal'")) {
    const seq = all('SELECT position, label FROM stages WHERE pipeline_id = ? ORDER BY position', [p.id]);
    const duplicated = seq.length !== new Set(seq.map((s) => s.position)).size;
    console.log(`  ${p.label}: ${seq.map((s) => s.label).join(' -> ')}${duplicated ? '   !! DUPLICATE POSITIONS' : ''}`);
}

close();
