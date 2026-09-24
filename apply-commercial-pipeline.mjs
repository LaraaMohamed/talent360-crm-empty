/**
 * Adds the Commercial pipeline and repoints the default dashboard at it.
 *
 *   node apply-commercial-pipeline.mjs            # show what would change
 *   node apply-commercial-pipeline.mjs --apply    # write it
 *
 * ── WHAT THIS DOES AND DOES NOT TOUCH ───────────────────────────────────────
 *
 * DOES   create the 13-stage Commercial pipeline, make it the default, and
 *        replace the default dashboard's layout with the commercial one.
 *
 * DOES NOT touch a single deal. The Recruitment and Managed services pipelines
 *        stay exactly as they are, stages included, so every existing deal
 *        keeps the stage it is actually in. Moving live deals between
 *        pipelines is a decision for a human with context, not a side effect
 *        of running a script.
 *
 * The stage list is written out here rather than imported, on purpose: a
 * migration records what was true when it ran. One that imports a constant
 * quietly changes meaning the next time that constant is edited.
 *
 * ── PARTLY SUPERSEDED ───────────────────────────────────────────────────────
 * `apply-won-lost-stages.mjs` later removed "Agreement sent" and renamed the
 * terminals to "Deal Won" / "Deal Lost". The list below is left as it was — see
 * above — and this script now only seeds stages into a pipeline IT created, so
 * re-running it can no longer resurrect a stage a later migration removed.
 */
import { migrate, get, run, all, id, now, close } from './lib/db.mjs';
import { DEFAULT_DASHBOARD } from './api/dashboard.mjs';

const APPLY = process.argv.includes('--apply');

const STAGES = [
    // key, label, probability %, type
    ['in_campaign', 'In campaign', 0, 'open'],
    ['ready_to_call', 'Ready to cold call', 0, 'open'],
    ['interested', 'Interested', 0, 'open'],
    ['send_profile', 'Send profile', 0, 'open'],
    ['follow_up', 'Follow up', 0, 'open'],
    ['meeting_scheduled', 'Meeting scheduled', 10, 'open'],
    ['proposal_preparing', 'Proposal preparing', 30, 'open'],
    ['proposal_sent', 'Proposal sent', 50, 'open'],
    ['negotiation', 'Negotiation', 70, 'open'],
    ['agreement_sent', 'Agreement sent', 90, 'open'],
    ['won', 'Deal won', 100, 'won'],
    ['on_hold', 'On hold', 0, 'open'],
    ['lost', 'Lost', 0, 'lost'],
];

migrate();

const workspaces = all('SELECT id, name FROM workspaces');
if (!workspaces.length) {
    console.log('No workspaces. Run `node setup.mjs` first.');
    close();
    process.exit(0);
}

const plan = [];

for (const ws of workspaces) {
    let pipeline = get('SELECT * FROM pipelines WHERE workspace_id = ? AND key = ?', [ws.id, 'commercial']);
    let created = false;

    if (!pipeline) {
        created = true;
        plan.push(`[${ws.name}] create pipeline "Commercial" with ${STAGES.length} stages`);
        if (APPLY) {
            const pipelineId = id('pip');
            run(
                `INSERT INTO pipelines (id, workspace_id, key, label, object_key, is_default, position, created_at)
                 VALUES (?,?,?,?,?,?,?,?)`,
                [pipelineId, ws.id, 'commercial', 'Commercial', 'deal', 0, -1, now()],
            );
            pipeline = get('SELECT * FROM pipelines WHERE id = ?', [pipelineId]);
        }
    } else {
        plan.push(`[${ws.name}] pipeline "Commercial" already exists — leaving its stages alone`);
    }

    // Stages are seeded ONLY into a pipeline this run created. An existing one
    // is left exactly as the workspace has it, which is what the line above
    // already promised.
    if (APPLY && created && pipeline) {
        for (const [position, [key, label, probability, type]] of STAGES.entries()) {
            const existing = get('SELECT id FROM stages WHERE pipeline_id = ? AND key = ?', [pipeline.id, key]);
            if (existing) continue;
            run(
                `INSERT INTO stages (id, workspace_id, pipeline_id, key, label, position, probability, type, required_fields, wip_limit)
                 VALUES (?,?,?,?,?,?,?,?,?,NULL)`,
                [
                    id('stg'), ws.id, pipeline.id, key, label, position, probability / 100, type,
                    JSON.stringify(key === 'proposal_sent' ? ['close_date'] : []),
                ],
            );
        }
    }

    const currentDefault = get('SELECT key FROM pipelines WHERE workspace_id = ? AND is_default = 1', [ws.id]);
    if (currentDefault?.key !== 'commercial') {
        plan.push(`[${ws.name}] make "Commercial" the default pipeline (was: ${currentDefault?.key ?? 'none'})`);
        if (APPLY) {
            run('UPDATE pipelines SET is_default = 0 WHERE workspace_id = ?', [ws.id]);
            run('UPDATE pipelines SET is_default = 1 WHERE workspace_id = ? AND key = ?', [ws.id, 'commercial']);
        }
    }

    const dashboard = get('SELECT id, name FROM dashboards WHERE workspace_id = ? AND is_default = 1', [ws.id]);
    if (dashboard) {
        plan.push(`[${ws.name}] reset dashboard "${dashboard.name}" to the commercial layout `
            + `(${DEFAULT_DASHBOARD.length} widgets; qualification verdicts move to the Qualification page)`);
        if (APPLY) {
            run('UPDATE dashboards SET layout = ?, updated_at = ? WHERE id = ?',
                [JSON.stringify(DEFAULT_DASHBOARD), now(), dashboard.id]);
        }
    }
}

console.log(`\n  ${APPLY ? 'Applied' : 'Would apply'}:\n`);
for (const line of plan) console.log(`   · ${line}`);
console.log(APPLY
    ? '\n  Done. Restart the server to pick it up.\n'
    : '\n  Nothing was written. Re-run with --apply to make these changes.\n');

close();
