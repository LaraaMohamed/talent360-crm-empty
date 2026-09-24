/**
 * Marks which copy of the database is the live one.
 *
 *   node retire-database.mjs                      show what this copy is
 *   node retire-database.mjs --retire --to <url>  stop serving this copy
 *   node retire-database.mjs --activate           make this copy the live one
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
 *
 * There is one live database. Moving the CRM to a server means copying
 * `crm.db` to it, and from that moment two files exist that both look usable.
 * If anyone starts the old one, both accumulate edits, and merging them is not
 * a restore — it is reconciling two histories by hand, badly, with losses.
 *
 * So the old copy is retired: `server.mjs` refuses to serve it and says where
 * the live system is. Scripts still work, so it can still be backed up or read.
 *
 * ── THE ORDER MATTERS ───────────────────────────────────────────────────────
 *
 *   1. take a backup            node backup-db.mjs
 *   2. copy it to the server, restore it there, confirm it opens
 *   3. THEN retire this one     node retire-database.mjs --retire --to https://…
 *
 * Retiring first would hand the server a database already marked retired — it
 * is copied along with the file. That is recoverable (`--activate` on the
 * server), and doing it in this order avoids needing to.
 */
import { migrate, get, run, close, identity, DB_FILE, now } from './lib/db.mjs';

const args = process.argv.slice(2);
const has = (flag) => args.includes(`--${flag}`);
const value = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};

migrate();
const db = identity();

const show = () => {
    console.log('');
    console.log(`  file         ${DB_FILE}`);
    console.log(`  instance     ${db.instance_id}`);
    console.log(`  status       ${db.status}`);
    if (db.retired_at) console.log(`  retired      ${db.retired_at}`);
    if (db.moved_to) console.log(`  live copy    ${db.moved_to}`);
    if (db.note) console.log(`  note         ${db.note}`);
    console.log('');
};

if (has('retire')) {
    const to = value('to');
    if (!to) {
        console.error('\n  Say where the live copy is:  --to https://crm.example.com\n'
            + '  A retired database that cannot tell you where the real one went is a dead end\n'
            + '  for whoever finds it.\n');
        close();
        process.exit(1);
    }
    if (db.status === 'retired') {
        console.log('\n  Already retired.');
        show();
        close();
        process.exit(0);
    }

    run('UPDATE database_identity SET status = ?, moved_to = ?, retired_at = ?, note = ? WHERE id = 1',
        ['retired', to, now(), value('note')]);

    const counts = {
        accounts: get('SELECT COUNT(*) n FROM accounts').n,
        contacts: get('SELECT COUNT(*) n FROM contacts').n,
        deals: get('SELECT COUNT(*) n FROM deals').n,
    };
    console.log('');
    console.log('  Retired. `npm start` will refuse to serve this copy.');
    console.log('');
    console.log(`  It still holds ${counts.accounts} accounts, ${counts.contacts} contacts and `
        + `${counts.deals} deals — nothing was deleted, and scripts still read it.`);
    console.log(`  The live system is ${to}`);
    console.log('');
    console.log('  Check the live copy has all of that before you rely on this being over.');
    console.log('');
} else if (has('activate')) {
    if (db.status === 'primary') {
        console.log('\n  Already the live copy.');
        show();
        close();
        process.exit(0);
    }
    run('UPDATE database_identity SET status = ?, moved_to = NULL, retired_at = NULL WHERE id = 1', ['primary']);
    console.log('');
    console.log('  This copy is now the live one and will be served.');
    console.log('');
    console.log('  Make sure the copy it was retired in favour of is not also running —');
    console.log('  that is the situation this flag exists to prevent, not to create.');
    console.log('');
} else {
    show();
    if (db.status === 'primary') {
        console.log('  To retire it after moving the CRM elsewhere:');
        console.log('      node retire-database.mjs --retire --to https://crm.example.com');
        console.log('');
    }
}

close();
