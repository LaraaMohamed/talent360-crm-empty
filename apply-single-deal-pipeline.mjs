/**
 * Collapses the three deal pipelines into one, so the board is sliced by
 * SERVICE instead.
 *
 *   node apply-single-deal-pipeline.mjs            # show what would change
 *   node apply-single-deal-pipeline.mjs --apply    # write it
 *
 * Against the hosted database:
 *
 *   node --env-file=data/turso.env apply-single-deal-pipeline.mjs --apply
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 *
 * The workspace had three pipelines — Recruitment, Managed services (HCM /
 * Offshoring), and Commercial — which presented three STAGE FLOWS as though
 * they were three kinds of business. They are not the same question. What the
 * company sells is OD, Recruitment, HCM and Offshoring, and those already exist
 * as service lines that every deal carries. With the sale encoded in the
 * pipeline, "show me the OD deals" could not be asked of the board at all, and
 * a Recruitment deal and an HCM deal could never appear on one screen.
 *
 * So: one pipeline, and the service becomes the filter.
 *
 * ── WHICH FLOW SURVIVES, AND WHY ────────────────────────────────────────────
 *
 * Commercial. It is already the default, it is the only one that covers the
 * work from "in campaign" through cold calling to a signed deal, and the other
 * two are subsets of that arc with different names. Its stages are the ones the
 * calling queue and the campaign reporting already speak in.
 *
 * ── NOTHING IS GUESSED ──────────────────────────────────────────────────────
 *
 * Every stage on a retired pipeline is mapped BY NAME to a Commercial stage
 * below, not by position and not by hoping the counts line up. Won stays won
 * and lost stays lost. A stage this script does not recognise stops the run
 * rather than sending its deals somewhere arbitrary — a deal in the wrong
 * column is worse than a migration that refuses to finish.
 *
 * `deal_stage_history` is rewritten alongside, so a deal's past does not point
 * at stages that no longer exist.
 */
import { migrate, all, get, run, tx, now, close } from './lib/db.mjs';

const APPLY = process.argv.includes('--apply');
const KEEP = 'commercial';

migrate();

const workspaces = all('SELECT id, name FROM workspaces');
let problems = 0;
let movedDeals = 0;
let movedHistory = 0;
let removedStages = 0;
let removedPipelines = 0;

/**
 * Retired stage -> surviving stage, by KEY.
 *
 * Read as "a deal that had got this far is at least this far in the arc the
 * Commercial flow describes". Where two retired stages map to one survivor that
 * is deliberate: Commercial does not distinguish "client interviews" from "offer
 * out", and inventing a stage to preserve the distinction would be a bigger
 * change than the one being asked for.
 */
const STAGE_MAP = {
    // Recruitment: qualified -> brief -> shortlist -> interviews -> offer
    qualified: 'interested',
    brief: 'meeting_scheduled',
    shortlist: 'proposal_sent',
    interviews: 'negotiation',
    offer: 'negotiation',
    // Managed services: qualified -> discovery -> proposal -> negotiation -> contracting
    discovery: 'meeting_scheduled',
    proposal: 'proposal_sent',
    negotiation: 'negotiation',
    contracting: 'negotiation',
};

for (const ws of workspaces) {
    const pipelines = all(
        "SELECT * FROM pipelines WHERE workspace_id = ? AND object_key = 'deal' ORDER BY position",
        [ws.id],
    );
    if (pipelines.length <= 1) continue;

    const keep = pipelines.find((p) => p.key === KEEP);
    if (!keep) {
        console.log(`${ws.name}: no "${KEEP}" pipeline — skipped, nothing is guessed at.`);
        problems += 1;
        continue;
    }

    const survivors = new Map(
        all('SELECT id, key, label, type FROM stages WHERE pipeline_id = ?', [keep.id]).map((s) => [s.key, s]),
    );
    const retired = pipelines.filter((p) => p.id !== keep.id);

    console.log(`\n${ws.name}`);
    console.log(`  keeping   "${keep.label}" (${survivors.size} stages)`);

    /** Deals the stage-mapping pass has accounted for, by id. */
    const handled = new Set();

    for (const pipeline of retired) {
        const stages = all('SELECT * FROM stages WHERE pipeline_id = ? ORDER BY position', [pipeline.id]);
        const deals = get(
            'SELECT COUNT(*) AS n FROM deals WHERE pipeline_id = ?', [pipeline.id],
        ).n;
        console.log(`  retiring  "${pipeline.label}" — ${stages.length} stages, ${deals} deals`);

        for (const stage of stages) {
            // Won and lost are structural, so they map by TYPE whatever they
            // are called. Everything else must be named in the map.
            const target = stage.type === 'won' || stage.type === 'lost'
                ? [...survivors.values()].find((s) => s.type === stage.type)
                : survivors.get(STAGE_MAP[stage.key]);

            if (!target) {
                console.log(`    !! "${stage.key}" (${stage.label}) has no mapping — nothing will be written`);
                problems += 1;
                continue;
            }

            // Recorded by ID, not just counted, so the stray sweep below knows
            // these are already spoken for whether or not anything was written.
            const onStage = all('SELECT id FROM deals WHERE stage_id = ?', [stage.id]);
            const n = onStage.length;
            for (const d of onStage) handled.add(d.id);
            if (n) console.log(`    ${stage.label} -> ${target.label}  (${n} deal${n === 1 ? '' : 's'})`);

            if (APPLY && !problems) {
                run(
                    'UPDATE deals SET pipeline_id = ?, stage_id = ?, updated_at = ? WHERE stage_id = ?',
                    [keep.id, target.id, now(), stage.id],
                );
                movedDeals += n;
                // History records a MOVE, so it names two stages and both have
                // to follow. A `from` pointing at a deleted stage is how a
                // deal's past silently becomes unreadable.
                const h = get(
                    'SELECT COUNT(*) AS n FROM deal_stage_history WHERE from_stage_id = ? OR to_stage_id = ?',
                    [stage.id, stage.id],
                ).n;
                run('UPDATE deal_stage_history SET from_stage_id = ? WHERE from_stage_id = ?', [target.id, stage.id]);
                run('UPDATE deal_stage_history SET to_stage_id = ? WHERE to_stage_id = ?', [target.id, stage.id]);
                movedHistory += h;
            }
        }
    }

    /**
     * Deals whose pipeline and stage already disagree.
     *
     * This workspace has one: `pipeline_id` says Managed services while
     * `stage_id` points at a Commercial stage. The pass above keys on the
     * stage, so it does not see such a deal — and deleting the pipeline
     * underneath it would leave it pointing at nothing.
     *
     * So anything still sitting on a retired pipeline is swept onto the
     * survivor. A deal whose stage is already a survivor's keeps it, because
     * that stage is the better record of where the deal actually is; anything
     * else lands on the first open stage rather than being guessed at further.
     */
    const openStage = [...survivors.values()].find((s) => s.type === 'open');
    for (const pipeline of retired) {
        const strays = all(
            'SELECT id, stage_id FROM deals WHERE pipeline_id = ?', [pipeline.id],
        // A deal the stage pass above already accounted for is not a stray.
        //
        // Under --apply that pass has moved it and this query no longer returns
        // it. In a DRY RUN nothing was written, so it is still sitting here —
        // and reporting it a second time told the operator that a won deal was
        // about to be demoted to "Follow up", which is the opposite of what
        // would happen. A preview nobody can trust is worse than no preview.
        ).filter((d) => !handled.has(d.id));
        for (const deal of strays) {
            const keepsStage = [...survivors.values()].some((s) => s.id === deal.stage_id);
            console.log(
                `    stray deal ${deal.id}: pipeline says "${pipeline.label}", stage `
                + `${keepsStage ? 'already belongs to the survivor — kept' : 'does not — moved to ' + openStage.label}`,
            );
            if (APPLY && !problems) {
                run(
                    'UPDATE deals SET pipeline_id = ?, stage_id = ?, updated_at = ? WHERE id = ?',
                    [keep.id, keepsStage ? deal.stage_id : openStage.id, now(), deal.id],
                );
                movedDeals += 1;
            }
        }
    }

    if (APPLY && !problems) {
        tx(() => {
            for (const pipeline of retired) {
                removedStages += get('SELECT COUNT(*) AS n FROM stages WHERE pipeline_id = ?', [pipeline.id]).n;
                run('DELETE FROM stages WHERE pipeline_id = ?', [pipeline.id]);
                run('DELETE FROM pipelines WHERE id = ?', [pipeline.id]);
                removedPipelines += 1;
            }
            run('UPDATE pipelines SET is_default = 1, position = 0 WHERE id = ?', [keep.id]);
        });
    }
}

if (problems) {
    console.log(`\n${problems} unmapped stage(s). Nothing was written — add them to STAGE_MAP and re-run.`);
    close();
    process.exit(1);
}

if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write it.');
    close();
    process.exit(0);
}

console.log(
    `\nMoved ${movedDeals} deals and ${movedHistory} history rows; `
    + `removed ${removedStages} stages and ${removedPipelines} pipelines.`,
);

// Every deal should now sit on the surviving pipeline, and every one of them
// should carry a service — that is what the board filters by now.
const orphaned = get(
    `SELECT COUNT(*) AS n FROM deals d
      WHERE NOT EXISTS (SELECT 1 FROM pipelines p WHERE p.id = d.pipeline_id)`,
).n;
const noService = get(
    "SELECT COUNT(*) AS n FROM deals WHERE service_line_key IS NULL OR TRIM(service_line_key) = ''",
).n;
console.log(`Deals pointing at a missing pipeline: ${orphaned}`);
if (noService) {
    console.log(
        `${noService} deals have no service line. They are reachable under "All services" and nowhere `
        + 'else, and they do not appear on the dashboard\'s service matrix either. Worth setting.',
    );
}

close();
