/**
 * Makes the commercial pipeline end in the two terminals it should end in.
 *
 *   node apply-won-lost-stages.mjs            # show what would change
 *   node apply-won-lost-stages.mjs --apply    # write it
 *
 * ── WHAT CHANGES ────────────────────────────────────────────────────────────
 *
 *   "Deal won"       -> "Deal Won"      (same stage, same key, new label)
 *   "Lost"           -> "Deal Lost"     (same stage, same key, new label)
 *   "Agreement sent" -> removed         (only when it holds no deals)
 *
 * and the remaining stages are renumbered so the board reads
 *
 *   … Proposal sent · Negotiation · On hold · Deal Won · Deal Lost
 *
 * with the open stages first and the two closed ones adjacent at the end.
 *
 * ── WHY "AGREEMENT SENT" GOES ───────────────────────────────────────────────
 *
 * The state it described — a contract out for signature — is already an
 * `agreement` record moving from issued to signed, and recording that signature
 * is what moves the deal into the won stage (api/proposals.mjs, signAgreement).
 * A stage that mirrors another object's status is two places to update and two
 * places to disagree. Nothing is lost: the same fact is still on the record,
 * one hop away, in the object that owns it.
 *
 * ── WHAT THIS WILL NOT DO ───────────────────────────────────────────────────
 *
 * If any deal is sitting in "Agreement sent", the stage is KEPT and the script
 * says so. Deciding whether those deals are won, still in negotiation, or
 * something else is a judgement about live commercial work, not something a
 * migration should guess. Move them by hand, then run this again.
 *
 * Only the `commercial` pipeline is touched. Recruitment and Managed services
 * keep their own stage lists.
 */
import { migrate, get, run, all, close } from './lib/db.mjs';

const APPLY = process.argv.includes('--apply');

/** key -> label. The order of this list IS the board order. */
const FINAL_ORDER = [
    ['in_campaign', 'In campaign'],
    ['ready_to_call', 'Ready to cold call'],
    ['interested', 'Interested'],
    ['send_profile', 'Send profile'],
    ['follow_up', 'Follow up'],
    ['meeting_scheduled', 'Meeting scheduled'],
    ['proposal_preparing', 'Proposal preparing'],
    ['proposal_sent', 'Proposal sent'],
    ['negotiation', 'Negotiation'],
    ['on_hold', 'On hold'],
    ['won', 'Deal Won'],
    ['lost', 'Deal Lost'],
];

migrate();

const plan = [];
const warnings = [];

for (const ws of all('SELECT id, name FROM workspaces')) {
    const pipeline = get('SELECT * FROM pipelines WHERE workspace_id = ? AND key = ?', [ws.id, 'commercial']);
    if (!pipeline) {
        warnings.push(`[${ws.name}] no "commercial" pipeline — run \`node apply-commercial-pipeline.mjs --apply\` first`);
        continue;
    }

    const stages = all('SELECT * FROM stages WHERE pipeline_id = ? ORDER BY position', [pipeline.id]);
    const byKey = new Map(stages.map((s) => [s.key, s]));

    /* ---- 1. the two terminals get their labels ---- */

    for (const [key, label] of [['won', 'Deal Won'], ['lost', 'Deal Lost']]) {
        const stage = byKey.get(key);
        if (!stage) {
            warnings.push(`[${ws.name}] no "${key}" stage to rename — skipped`);
            continue;
        }
        if (stage.label === label) continue;
        plan.push(`[${ws.name}] rename stage "${stage.label}" -> "${label}"`);
        if (APPLY) run('UPDATE stages SET label = ? WHERE id = ?', [label, stage.id]);
    }

    /* ---- 2. "Agreement sent" goes, if it is empty ---- */

    const agreementSent = byKey.get('agreement_sent');
    let keepingAgreementSent = false;
    if (agreementSent) {
        const held = get('SELECT COUNT(*) AS n FROM deals WHERE stage_id = ?', [agreementSent.id]).n;
        if (held > 0) {
            keepingAgreementSent = true;
            warnings.push(
                `[${ws.name}] "Agreement sent" still holds ${held} deal(s), so it was KEPT. `
                + 'Move those deals to Negotiation or Deal Won, then run this again.',
            );
        } else {
            plan.push(`[${ws.name}] remove stage "Agreement sent" (holds no deals)`);
            if (APPLY) {
                // History rows are left pointing at the removed id on purpose:
                // deal_stage_history records what happened, and a deal that
                // genuinely passed through this stage did pass through it.
                run('DELETE FROM stages WHERE id = ?', [agreementSent.id]);
            }
            byKey.delete('agreement_sent');
        }
    }

    /* ---- 3. renumber what is left ---- */

    // A kept "Agreement sent" holds its old slot, just before the terminals, so
    // the numbering below is the same list either way.
    const order = keepingAgreementSent
        ? FINAL_ORDER.flatMap((entry) => (entry[0] === 'won' ? [['agreement_sent', 'Agreement sent'], entry] : [entry]))
        : FINAL_ORDER;

    let position = 0;
    for (const [key, label] of order) {
        const stage = byKey.get(key);
        if (!stage) continue;
        if (stage.position !== position) {
            plan.push(`[${ws.name}] move "${label}" to position ${position} (was ${stage.position})`);
            if (APPLY) run('UPDATE stages SET position = ? WHERE id = ?', [position, stage.id]);
        }
        position += 1;
    }

    /* ---- 4. anything unexpected is reported, never touched ---- */

    const known = new Set(FINAL_ORDER.map(([key]) => key));
    for (const stage of all('SELECT key, label FROM stages WHERE pipeline_id = ?', [pipeline.id])) {
        if (!known.has(stage.key) && stage.key !== 'agreement_sent') {
            warnings.push(`[${ws.name}] stage "${stage.label}" (${stage.key}) is not in this script's list — left alone`);
        }
    }
}

console.log(`\n  ${APPLY ? 'Applied' : 'Would apply'}:\n`);
if (!plan.length) console.log('   · nothing — the pipeline already ends in Deal Won and Deal Lost');
for (const line of plan) console.log(`   · ${line}`);
if (warnings.length) {
    console.log('\n  Notes:\n');
    for (const line of warnings) console.log(`   ! ${line}`);
}
console.log(APPLY
    ? '\n  Done. Restart the server to pick it up.\n'
    : '\n  Nothing was written. Re-run with --apply to make these changes.\n');

close();
