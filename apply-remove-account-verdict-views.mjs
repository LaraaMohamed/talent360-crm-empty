/**
 * Removes the qualification views from the ACCOUNTS list.
 *
 *   node apply-remove-account-verdict-views.mjs            # show what would go
 *   node apply-remove-account-verdict-views.mjs --apply    # write it
 *   node --env-file=data/turso.env apply-remove-account-verdict-views.mjs --apply
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 *
 * "HCM — qualified", "HCM — needs review" and their Offshoring pair filtered
 * Accounts by what the qualification engine concluded. That is prospecting's
 * answer wearing an account's id — the same thing the verdict COLUMNS were, and
 * those came off this object because a rep does not hold `prospecting.read`. A
 * tab strip offering four filters that return an empty list is worse than no
 * tab at all.
 *
 * The identical views on Prospecting companies are untouched. That is the plane
 * the question belongs to.
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
 *
 * Only `is_system = 1` views on `account` whose filter names a verdict field.
 * A view somebody built themselves is left exactly alone even if it filters the
 * same way — it is their configuration, and deleting it because it resembles a
 * seeded one is not this script's decision to make. Those are listed at the end
 * so you can see what is left.
 */
import { migrate, all, get, run, close } from './lib/db.mjs';

const APPLY = process.argv.includes('--apply');

migrate();

const VERDICT_FIELD = /"field"\s*:\s*"verdict_/;

const candidates = all(
    "SELECT id, workspace_id, name, filter, is_system FROM views WHERE object_key = 'account'",
);

const seeded = candidates.filter((v) => v.is_system === 1 && VERDICT_FIELD.test(v.filter ?? ''));
const handMade = candidates.filter((v) => v.is_system !== 1 && VERDICT_FIELD.test(v.filter ?? ''));

if (!seeded.length) {
    console.log('\nNo seeded qualification views remain on Accounts.');
} else {
    console.log(`\n${seeded.length} view(s) to remove from the Accounts list:\n`);
    for (const view of seeded) console.log(`  ${view.name}`);
}

if (handMade.length) {
    console.log(`\nLEFT ALONE — built by somebody here, not seeded (${handMade.length}):\n`);
    for (const view of handMade) console.log(`  ${view.name}`);
    console.log('\n  These filter on a verdict too. They are somebody\'s configuration, so this script');
    console.log('  does not touch them — but a rep opening one will see an empty list, because the');
    console.log('  verdict fields are not sent to a role without prospecting.read. Delete them by');
    console.log('  hand if they are no longer wanted.');
}

if (!seeded.length) {
    close();
    process.exit(0);
}

if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write it.');
    close();
    process.exit(0);
}

let removed = 0;
for (const view of seeded) {
    // Anything pinned to this view goes with it, or the next reader gets a
    // dashboard tile pointing at a view that is not there.
    run('DELETE FROM views WHERE id = ?', [view.id]);
    removed += 1;
}

console.log(`\nRemoved ${removed} view(s).`);
const left = all(
    "SELECT name FROM views WHERE object_key = 'account' ORDER BY position",
).map((v) => v.name);
console.log(`The Accounts list now offers: ${left.join(', ')}`);

close();
