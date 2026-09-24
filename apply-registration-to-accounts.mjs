/**
 * Copies commercial-registration facts onto the accounts that already have one.
 *
 *   node apply-registration-to-accounts.mjs             # show what would change
 *   node apply-registration-to-accounts.mjs --apply     # write it
 *   node apply-registration-to-accounts.mjs --overwrite # also replace values that DISAGREE
 *   node --env-file=data/turso.env apply-registration-to-accounts.mjs
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * `accounts.cr_number` and `accounts.legal_name` are the same two facts as the
 * registration's `cr_number` and `company_name_ar` — the account field even
 * describes itself as "the registered name, often in Arabic". Saving a
 * registration now writes them through, but that only fires on save, so every
 * registration captured before it stayed invisible on the account. The CR
 * number matters most: duplicate detection searches `accounts.cr_number`, and
 * it is the strongest natural key this CRM has.
 *
 * ── FILLS BLANKS, REPORTS DISAGREEMENTS ─────────────────────────────────────
 *
 * A bulk pass over history is not the same act as somebody saving a form. Where
 * the account already holds a DIFFERENT value, somebody typed it, and this
 * script names the conflict and leaves it alone unless `--overwrite` says
 * otherwise. One account here has a legal name shorter than its registered one
 * — the sort of difference that is either a deliberate trading name or a slip,
 * and not something a migration should decide.
 */
import { migrate, all, get, run, tx, now, close } from './lib/db.mjs';

const APPLY = process.argv.includes('--apply');
const OVERWRITE = process.argv.includes('--overwrite');

migrate();

const rows = all(
    `SELECT r.account_id, r.cr_number, r.company_name_ar,
            a.name, a.cr_number AS account_cr, a.legal_name AS account_legal
       FROM commercial_registrations r
       JOIN accounts a ON a.id = r.account_id
      ORDER BY a.name`,
);

console.log(`${rows.length} account(s) have a commercial registration.\n`);

const fills = [];
const conflicts = [];

for (const r of rows) {
    const patch = {};
    const clash = [];

    const consider = (regValue, accountValue, column) => {
        const wanted = String(regValue ?? '').trim();
        if (!wanted) return;
        const held = String(accountValue ?? '').trim();
        if (!held) { patch[column] = wanted; return; }
        if (held !== wanted) clash.push({ column, held, wanted });
    };

    consider(r.cr_number, r.account_cr, 'cr_number');
    consider(r.company_name_ar, r.account_legal, 'legal_name');

    if (clash.length) conflicts.push({ ...r, clash });
    if (Object.keys(patch).length || (OVERWRITE && clash.length)) {
        if (OVERWRITE) for (const c of clash) patch[c.column] = c.wanted;
        fills.push({ accountId: r.account_id, name: r.name, patch });
    }
}

if (fills.length) {
    console.log('Would fill:');
    for (const f of fills) {
        console.log(`  ${f.name}`);
        for (const [k, v] of Object.entries(f.patch)) console.log(`      ${k} = ${v}`);
    }
}

if (conflicts.length) {
    console.log(`\n${OVERWRITE ? 'Overwriting' : 'LEAVING ALONE'} — the account already holds something different:`);
    for (const c of conflicts) {
        for (const x of c.clash) {
            console.log(`  ${c.name}: ${x.column}`);
            console.log(`      account      "${x.held}"`);
            console.log(`      registration "${x.wanted}"`);
        }
    }
    if (!OVERWRITE) console.log('  Re-run with --overwrite to replace these with the registration’s values.');
}

if (!fills.length) {
    console.log('\nNothing to fill.');
    close();
    process.exit(0);
}

if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write it.');
    close();
    process.exit(0);
}

const stamp = now();
tx(() => {
    for (const f of fills) {
        const keys = Object.keys(f.patch);
        run(
            `UPDATE accounts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
            [...keys.map((k) => f.patch[k]), stamp, f.accountId],
        );
    }
});

console.log(`\nFilled ${fills.length} account(s).`);
console.log(
    'Search is rebuilt on the next write to each account. To make them findable by CR number now, '
    + 'open one and save it, or re-run whatever reindexes search in this workspace.',
);

const left = get(
    `SELECT COUNT(*) AS n FROM commercial_registrations r JOIN accounts a ON a.id = r.account_id
      WHERE (r.cr_number IS NOT NULL AND TRIM(r.cr_number) != '')
        AND (a.cr_number IS NULL OR TRIM(a.cr_number) = '')`,
).n;
console.log(`Accounts with a registered CR number still missing it: ${left}`);

close();
