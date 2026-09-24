/**
 * Adds the Training and Team Building services, and the Kickoff stage.
 *
 *   node apply-new-services-and-kickoff.mjs            # what would change
 *   node apply-new-services-and-kickoff.mjs --apply    # write it
 *
 * ── SERVICES ─────────────────────────────────────────────────────────────────
 *
 * The book is now Recruitment, HCM, Offshoring, OD, Training and Team
 * Building. Training and Team Building are project work, so both are quoted
 * ONCE (`fixed_fee`) — the same recurrence rule the money engine applies to
 * OD and Recruitment, and the opposite of HCM/Offshoring's per-month model.
 *
 * New service lines are added per workspace, idempotently. No existing record
 * changes: a deal, target or account that already names a service keeps it.
 *
 * ── KICKOFF STAGE ────────────────────────────────────────────────────────────
 *
 * The commercial pipeline ends ... → Contracting → Kickoff → Won/Lost. Kickoff
 * is the last OPEN stage — the signed deal handed to delivery. Added to every
 * pipeline that already has a `contracting` stage, idempotently.
 */
import { migrate, all, get, run, id, now, close, describe } from './lib/db.mjs';

const APPLY = process.argv.includes('--apply');

migrate();

const workspaces = all('SELECT id, name FROM workspaces');

console.log('');
console.log(`  Database  ${describe()}`);
console.log(`  Mode      ${APPLY ? 'WRITE' : 'dry run — pass --apply to write'}`);
console.log('');

let servicesAdded = 0;
let stagesAdded = 0;

/**
 * Superseded by merge-training-team-building.mjs: Training and Team
 * Building were later combined into one service line,
 * "training_team_building". This script's job here is done and it is kept
 * only as a record of when the two were first added — the guard below stops
 * a re-run from undoing that merge by re-creating them as separate rows.
 */
const NEW_SERVICES = [
    { key: 'training', label: 'Training', model: 'fixed_fee' },
    { key: 'team_building', label: 'Team Building', model: 'fixed_fee' },
];

for (const ws of workspaces) {
    // 1. New service lines, if missing — and not already merged.
    const merged = get(
        "SELECT id FROM service_lines WHERE workspace_id = ? AND key = 'training_team_building'", [ws.id],
    );
    for (const svc of NEW_SERVICES) {
        if (merged) continue;
        const existing = get(
            'SELECT id FROM service_lines WHERE workspace_id = ? AND key = ?', [ws.id, svc.key],
        );
        if (existing) continue;
        const position = get('SELECT MAX(position) AS p FROM service_lines WHERE workspace_id = ?', [ws.id]).p ?? 0;
        const rowId = id('svc');
        console.log(`  ${ws.name}: service "${svc.label}" -> ${rowId}${APPLY ? '' : ' (dry run)'}`);
        if (APPLY) {
            run(
                'INSERT INTO service_lines (id, workspace_id, key, label, pricing_model, rule_key, position) VALUES (?,?,?,?,?,NULL,?)',
                [rowId, ws.id, svc.key, svc.label, svc.model, position + 1],
            );
        }
        servicesAdded += 1;
    }

    // 2. Kickoff stage, after contracting, if missing.
    const pipe = get(
        `SELECT p.* FROM pipelines p
          WHERE p.workspace_id = ? AND p.object_key = 'deal'
          ORDER BY p.is_default DESC, p.position LIMIT 1`,
        [ws.id],
    );
    if (!pipe) continue;
    const contracting = get(
        'SELECT * FROM stages WHERE pipeline_id = ? AND key = ?', [pipe.id, 'contracting'],
    );
    const kickoff = get(
        'SELECT * FROM stages WHERE pipeline_id = ? AND key = ?', [pipe.id, 'kickoff'],
    );
    if (kickoff) continue;
    if (!contracting) continue;
    console.log(`  ${ws.name}: stage "Kickoff" after "Contracting"${APPLY ? '' : ' (dry run)'}`);
    if (APPLY) {
        run(
            'UPDATE stages SET position = position + 1 WHERE pipeline_id = ? AND position > ?',
            [pipe.id, contracting.position],
        );
        run(
            `INSERT INTO stages (id, workspace_id, pipeline_id, key, label, position, probability, type, required_fields, wip_limit)
             VALUES (?,?,?,?,?,?,0.95,'open','[]',NULL)`,
            [id('stg'), ws.id, pipe.id, 'kickoff', 'Kickoff', contracting.position + 1],
        );
    }
    stagesAdded += 1;
}

console.log('');
console.log(`  services added: ${servicesAdded}`);
console.log(`  kickoff stages added: ${stagesAdded}`);
if (!APPLY) {
    console.log('');
    console.log('  Dry run only. Re-run with --apply to write.');
}
close();
