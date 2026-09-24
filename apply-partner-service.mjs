/**
 * Adds "Partner" (key: partner) as a service line to any workspace that does
 * not already have one — same pattern as apply-training-team-building-add.mjs.
 *
 * This makes "Partner" selectable in the Services multiselect on Accounts and
 * Contacts (that field's optionsSource is service_lines). `pricing_model` is
 * `fixed_fee` because Partner is not billed per seat/headcount/placement — the
 * same choice made for OD and Training & Team Building.
 *
 *   node apply-partner-service.mjs            # what would change
 *   node apply-partner-service.mjs --apply    # write it
 */
import { migrate, all, get, run, tx, id, close } from './lib/db.mjs';

const APPLY = process.argv.includes('--apply');
const KEY = 'partner';
const LABEL = 'Partner';
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
