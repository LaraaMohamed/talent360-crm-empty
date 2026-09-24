/**
 * Puts the widgets that postdate a dashboard onto it — "Deals won" and the
 * three cold-calling widgets.
 *
 *   node apply-deals-won-widget.mjs            # show what would change
 *   node apply-deals-won-widget.mjs --apply    # write it
 *
 * A dashboard's layout is stored per workspace, so changing DEFAULT_DASHBOARD
 * only affects workspaces created afterwards. Every existing dashboard keeps
 * the layout it was created with — which is the right default (nobody wants
 * their dashboard rearranged by a deploy) and the reason this script exists.
 *
 * It is idempotent: a dashboard that already lists the widget is left alone,
 * so running it twice is the same as running it once.
 *
 *   TURSO_URL=… TURSO_TOKEN=… node apply-deals-won-widget.mjs --apply
 *
 * or, against the hosted database with the env file:
 *
 *   node --env-file=data/turso.env apply-deals-won-widget.mjs --apply
 */
import { migrate, all, run, now, json, close, describe } from './lib/db.mjs';

const APPLY = process.argv.includes('--apply');

const WIDGETS_TO_ADD = [
    { widget: 'deals_won', title: 'Deals won', size: 'wide', options: {} },
    { widget: 'calling_activity', title: 'Cold calling', size: 'wide', options: {} },
    { widget: 'sdr_performance', title: 'SDR performance', size: 'wide', options: {} },
    { widget: 'calling_queue', title: 'Calling queue', size: 'wide', options: {} },
];

migrate();

console.log('');
console.log(`  database  ${describe()}`);
console.log('');

const dashboards = all('SELECT id, workspace_id, name, layout FROM dashboards');
let changed = 0;

for (const dashboard of dashboards) {
    const layout = json(dashboard.layout, []);
    const present = new Set(layout.map((item) => item.widget));
    const missing = WIDGETS_TO_ADD.filter((w) => !present.has(w.widget));

    if (!missing.length) {
        console.log(`  ·  ${dashboard.name}: already has all of them`);
        continue;
    }

    /**
     * "Deals won" goes directly above "Win rate" when that is present, because
     * the two answer the same question at different resolutions and reading
     * them apart is how a rate gets quoted without the count behind it.
     *
     * The calling widgets go at the END. They are a new section of the screen
     * rather than a correction to an existing one, and pushing somebody's
     * familiar layout down to make room for them would be rude.
     */
    const next = [...layout];
    for (const widget of missing) {
        if (widget.widget === 'deals_won') {
            const at = next.findIndex((item) => item.widget === 'win_rate');
            next.splice(at >= 0 ? at : Math.min(1, next.length), 0, widget);
        } else {
            next.push(widget);
        }
    }

    console.log(`  ${APPLY ? '+' : '→'}  ${dashboard.name}: adding ${missing.map((w) => w.widget).join(', ')}`);
    changed += 1;

    if (APPLY) {
        run('UPDATE dashboards SET layout = ?, updated_at = ? WHERE id = ?',
            [JSON.stringify(next), now(), dashboard.id]);
    }
}

console.log('');
if (!changed) {
    console.log('  Nothing to do.');
} else if (APPLY) {
    console.log(`  ${changed} dashboard(s) updated.`);
} else {
    console.log(`  ${changed} dashboard(s) would change. Re-run with --apply to write it.`);
}
console.log('');

close();
