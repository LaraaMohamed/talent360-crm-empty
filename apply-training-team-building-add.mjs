/**
 * Adds "Training & Team Building" (key: training_team_building) as a service
 * line to any workspace that does not already have one.
 *
 * merge-training-team-building.mjs (already applied) handles the case where
 * a workspace has old separate "training"/"team_building" rows to fold
 * together. It deliberately does nothing when neither of those exists — the
 * common case for a workspace that predates this service line entirely, which
 * is exactly the state the production "Talent 360" workspace was found in:
 * no training, no team_building, no training_team_building. This script is
 * the other half — it INSERTS the row fresh, appended after whatever service
 * lines the workspace already has, instead of merging anything.
 *
 *   node apply-training-team-building-add.mjs            # what would change
 *   node apply-training-team-building-add.mjs --apply    # write it
 */
import { migrate, all, get, run, tx, id, close } from './lib/db.mjs';

const APPLY = process.argv.includes('--apply');
const KEY = 'training_team_building';
const LABEL = 'Training & Team Building';
const PRICING_MODEL = 'fixed_fee';

migrate();

const workspaces = all('SELECT id, name FROM workspaces');
const missing = workspaces.filter((w) => !get('SELECT id FROM service_lines WHERE workspace_id = ? AND key = ?', [w.id, KEY]));

if (!missing.length) {
    console.log(`Every workspace already has "${KEY}". Nothing to do.`);
    close();
    process.exit(0);
}

console.log(`Would add "${LABEL}" (${KEY}) to:`);
for (const w of missing) console.log(`  ${w.name} (${w.id})`);

if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write it, after `npm run backup`.');
    close();
    process.exit(0);
}

tx(() => {
    for (const w of missing) {
        const maxPosition = get('SELECT MAX(position) AS p FROM service_lines WHERE workspace_id = ?', [w.id])?.p ?? -1;
        run(
            'INSERT INTO service_lines (id, workspace_id, key, label, pricing_model, position) VALUES (?,?,?,?,?,?)',
            [id('svc'), w.id, KEY, LABEL, PRICING_MODEL, maxPosition + 1],
        );
    }
});

console.log(`\nAdded "${LABEL}" to ${missing.length} workspace(s).`);
close();
