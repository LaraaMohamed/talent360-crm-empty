/**
 * Deals sitting on "Ready to cold call" whose account has nobody on the
 * calling queue any more.
 *
 *   node fix-orphaned-ready-to-call.mjs            report only
 *   node fix-orphaned-ready-to-call.mjs --write    walk each one and ask
 *
 * ── WHY THESE EXIST ──────────────────────────────────────────────────────────
 *
 * `ensureReadyToCall` (lib/calling.mjs) moves a deal to `ready_to_call` the
 * moment a contact is assigned to the calling queue — forward-only, on
 * purpose (see the comment there: re-adding a contact must not drag a deal
 * that has moved on back to the first stage). `removeFromQueue` only updates
 * `calling_assignments`; it never moves the deal back. That is deliberate —
 * the assignment and the stage are two different facts — but it means a
 * board can show "17 ready to cold call" when the queue behind every one of
 * them has been cleared.
 *
 * This finds those deals per workspace and, in --write mode, asks per deal
 * what to do rather than guessing one answer for all of them: some belong
 * back at the top of the funnel, some are genuinely dead.
 */
import { all, get, migrate, close, now } from './lib/db.mjs';
import { moveDealToStage } from './lib/repo.mjs';
import readline from 'node:readline/promises';

const WRITE = process.argv.includes('--write');

migrate();

const workspaces = all('SELECT id, name FROM workspaces');
const rl = WRITE ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;

let found = 0;
let movedToCampaign = 0;
let closedLost = 0;
let skipped = 0;

function daysSince(iso) {
    return Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
}

for (const workspace of workspaces) {
    const ctx = { workspaceId: workspace.id, userId: null, role: 'owner', workspace: { id: workspace.id, baseCurrency: 'USD' } };

    const stage = get(
        `SELECT s.* FROM stages s JOIN pipelines p ON p.id = s.pipeline_id
          WHERE p.workspace_id = ? AND s.key = 'ready_to_call' AND p.is_default = 1
          LIMIT 1`,
        [workspace.id],
    );
    if (!stage) continue;

    const deals = all(
        `SELECT d.id, d.account_id, a.name AS account_name,
                (SELECT h.entered_at FROM deal_stage_history h
                  WHERE h.deal_id = d.id AND h.to_stage_id = d.stage_id AND h.exited_at IS NULL
                  ORDER BY h.entered_at DESC LIMIT 1) AS entered_at,
                d.updated_at
           FROM deals d JOIN accounts a ON a.id = d.account_id AND a.deleted_at IS NULL
          WHERE d.workspace_id = ? AND d.status = 'open' AND d.stage_id = ? AND d.deleted_at IS NULL
          ORDER BY d.updated_at ASC`,
        [workspace.id, stage.id],
    );
    if (!deals.length) continue;

    const orphaned = deals.filter((d) => {
        const live = get(
            `SELECT COUNT(*) AS n FROM calling_assignments
              WHERE workspace_id = ? AND account_id = ? AND active = 1`,
            [workspace.id, d.account_id],
        );
        return (live?.n ?? 0) === 0;
    });
    if (!orphaned.length) continue;

    found += orphaned.length;
    console.log('');
    console.log(`${workspace.name} — ${orphaned.length} deal(s) in "Ready to cold call" with nobody queued`);
    console.log('');

    if (!WRITE) {
        for (const d of orphaned) {
            const days = daysSince(d.entered_at ?? d.updated_at);
            console.log(`  ${d.account_name.padEnd(40)} ${d.id}  in this stage ${days}d`);
        }
        continue;
    }

    const reasons = all('SELECT key, label FROM loss_reasons WHERE workspace_id = ? ORDER BY position', [workspace.id]);

    for (const d of orphaned) {
        const days = daysSince(d.entered_at ?? d.updated_at);
        console.log(`  ${d.account_name} — ${d.id} — in this stage ${days}d`);
        // eslint-disable-next-line no-await-in-loop
        const answer = (await rl.question('    [c] In campaign   [l] Lost   [s] Skip  > ')).trim().toLowerCase();
        if (answer === 'c') {
            const result = moveDealToStage(ctx, d.id, 'in_campaign', 'orphaned ready-to-call cleanup');
            if (result) { movedToCampaign += 1; } else { console.log('    could not move — no "in_campaign" stage on this pipeline'); skipped += 1; }
        } else if (answer === 'l') {
            reasons.forEach((r, i) => console.log(`      ${i + 1}. ${r.label}`));
            // eslint-disable-next-line no-await-in-loop
            const pick = await rl.question('    reason # > ');
            const reason = reasons[Number(pick) - 1];
            if (reason) {
                moveDealToStage(ctx, d.id, 'lost', 'orphaned ready-to-call cleanup', { loss_reason: reason.key });
                closedLost += 1;
            } else {
                console.log('    no reason picked — skipped');
                skipped += 1;
            }
        } else {
            skipped += 1;
        }
    }
}

if (rl) rl.close();

console.log('');
console.log(`  orphaned deals found:    ${found}`);
if (WRITE) {
    console.log(`  moved to In campaign:    ${movedToCampaign}`);
    console.log(`  closed as Lost:          ${closedLost}`);
    console.log(`  skipped:                 ${skipped}`);
} else if (found) {
    console.log('');
    console.log('  Dry run only. Re-run with --write to go through them one by one.');
}
close();
