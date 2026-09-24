/**
 * A ledger of which one-off migration/backfill scripts have actually been run
 * against THIS database, and when.
 *
 *   node migration-log.mjs                            what's recorded, what isn't
 *   node migration-log.mjs --mark <script> ["note"]   record a script as applied, now
 *
 * The scripts themselves (apply-*.mjs, backfill-*.mjs and friends, in the
 * repo root) were never required to register themselves, and this does not
 * change that — retrofitting all of them risked introducing a bug into each
 * one, for a project this size to fix in one pass. Instead this is the one
 * place that answers "did X actually run against production," and the habit
 * to build going forward is running --mark right after applying one, the same
 * way you would note a change in a deploy log.
 *
 * Point it at production the same way any other script here does:
 *   TURSO_URL=…  TURSO_TOKEN=…  node migration-log.mjs
 *
 * The first time this runs against a database with real history, most or all
 * scripts will show as "not recorded" — that is expected, not a problem this
 * tool found. Mark the ones known to have run (ask whoever has touched this
 * database before) and the ledger is accurate from here on.
 */
import fs from 'node:fs';
import { all, run, migrate, close, describe, now, ROOT } from './lib/db.mjs';

const args = process.argv.slice(2);
const MARK = args.includes('--mark');

migrate();

const SCRIPT_PATTERN = /^(apply|backfill|migrate|merge|link|fix)-.*\.mjs$/;
const scripts = fs.readdirSync(ROOT).filter((f) => SCRIPT_PATTERN.test(f)).sort();

if (MARK) {
    const name = args[args.indexOf('--mark') + 1];
    if (!name) {
        console.error('\n  Usage: node migration-log.mjs --mark <script-name.mjs> ["note"]\n');
        close();
        process.exit(1);
    }
    if (!scripts.includes(name)) {
        console.error(`\n  "${name}" is not a script in the repo root matching apply-/backfill-/migrate-/merge-/link-/fix-*.mjs.`);
        console.error('  Check the spelling — or is this a genuinely new naming pattern this tool should also recognise?\n');
        close();
        process.exit(1);
    }
    const note = args.slice(args.indexOf('--mark') + 2).join(' ') || null;
    run(
        `INSERT INTO schema_migrations (name, applied_at, note) VALUES (?,?,?)
         ON CONFLICT(name) DO UPDATE SET applied_at = excluded.applied_at, note = excluded.note`,
        [name, now(), note],
    );
    console.log(`\n  Recorded: ${name}${note ? `  — ${note}` : ''}\n`);
    close();
    process.exit(0);
}

const recorded = new Map(all('SELECT name, applied_at, note FROM schema_migrations').map((r) => [r.name, r]));

console.log('');
console.log(`  Database  ${describe()}`);
console.log('');

let unrecorded = 0;
for (const script of scripts) {
    const row = recorded.get(script);
    if (row) {
        console.log(`  ✓ ${script.padEnd(42)} ${row.applied_at}${row.note ? `  — ${row.note}` : ''}`);
    } else {
        unrecorded += 1;
        console.log(`  ? ${script.padEnd(42)} not recorded — has this run against this database?`);
    }
}

console.log('');
if (unrecorded) {
    console.log(`  ${unrecorded} script(s) with no record either way. That does not mean they`);
    console.log('  have not run — only that nobody has told this ledger yet. Check with');
    console.log('  whoever has run scripts against this database before, then:');
    console.log('');
    console.log('      node migration-log.mjs --mark <script-name.mjs> "who/when/why"');
    console.log('');
} else {
    console.log('  Every migration script in the repo is accounted for.');
    console.log('');
}

close();
