/**
 * Gives every existing account an Account Type.
 *
 *   node apply-account-type-backfill.mjs            # show what would change
 *   node apply-account-type-backfill.mjs --apply    # write it
 *
 * Against the hosted database, prefix with the env file:
 *
 *   node --env-file=data/turso.env apply-account-type-backfill.mjs --apply
 *
 * ── WHY A WRITTEN MIGRATION ─────────────────────────────────────────────────
 *
 * `account_type` is now required with a default, which fixes every account
 * created from here on and does nothing at all for the ones already in the
 * book. A default applies at creation; it does not reach back. So the accounts
 * that predate the field stay empty until something writes to them, and an
 * empty type is exactly the state that put an "Unassigned" column on the
 * dashboard.
 *
 * ── WHAT IT DOES NOT TOUCH ──────────────────────────────────────────────────
 *
 * `billing_currency` is deliberately left alone. Type and currency are separate
 * facts — that separation is the whole point of the two fields, and this
 * codebase never re-derives one from the other after creation. Setting a
 * thousand accounts to USD because they are now Regional would be inventing a
 * commercial term for each of them.
 *
 * That leaves a real gap, and the script reports it rather than fixing it: an
 * account with no billing currency gives its deals no currency either, and they
 * fall back to the workspace base. See the summary at the end of a run.
 *
 * Nothing is deleted and nothing that already HAS a type is changed.
 */
import { migrate, all, get, run, tx, now, close } from './lib/db.mjs';
import { ACCOUNT_TYPES } from './lib/objects.mjs';

const APPLY = process.argv.includes('--apply');

/**
 * What the untyped accounts become.
 *
 * Regional, because that is what the existing book was classified as when this
 * was decided. Pass `--type=Egypt` to override for a subset run.
 */
const typeArg = process.argv.find((a) => a.startsWith('--type='));
const TYPE = typeArg ? typeArg.slice('--type='.length) : 'Regional';

if (!ACCOUNT_TYPES.includes(TYPE)) {
    console.error(`"${TYPE}" is not an account type. Known: ${ACCOUNT_TYPES.join(', ')}.`);
    process.exit(1);
}

migrate();

// Deleted rows are included on purpose. A soft-deleted account can be restored,
// and restoring it into the "unassigned" state this migration exists to remove
// would quietly reintroduce the problem months later.
const untyped = all(
    `SELECT id, name, deleted_at, billing_currency
       FROM accounts
      WHERE account_type IS NULL OR TRIM(account_type) = ''
      ORDER BY name`,
);

const total = get('SELECT COUNT(*) AS n FROM accounts').n;

console.log(`${total} accounts, ${untyped.length} with no type.`);
if (!untyped.length) {
    console.log('Nothing to do.');
    close();
    process.exit(0);
}

const live = untyped.filter((a) => !a.deleted_at).length;
console.log(`  ${live} live, ${untyped.length - live} in the trash (restorable, so included).`);
console.log(`\nWould set account_type = "${TYPE}" on:`);
for (const a of untyped.slice(0, 20)) {
    console.log(`  ${a.deleted_at ? '[trash] ' : ''}${a.name}`);
}
if (untyped.length > 20) console.log(`  … and ${untyped.length - 20} more`);

if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write it.');
    close();
    process.exit(0);
}

const stamp = now();
tx(() => {
    for (const a of untyped) {
        run(
            'UPDATE accounts SET account_type = ?, updated_at = ? WHERE id = ?',
            [TYPE, stamp, a.id],
        );
    }
});

const left = get(
    "SELECT COUNT(*) AS n FROM accounts WHERE account_type IS NULL OR TRIM(account_type) = ''",
).n;
console.log(`\nSet ${untyped.length} accounts to "${TYPE}". Untyped remaining: ${left}.`);

/**
 * The gap this migration deliberately does not close.
 *
 * A deal takes its currency from its account's billing currency; an account
 * with none sends its deals to the workspace base currency instead, which the
 * USD dashboard then converts at the wrong rate. Worth knowing about, not worth
 * guessing at — a currency is a commercial term, not a derivable fact.
 */
const noCurrency = get(
    `SELECT COUNT(*) AS n FROM accounts
      WHERE deleted_at IS NULL AND (billing_currency IS NULL OR TRIM(billing_currency) = '')`,
).n;
if (noCurrency) {
    console.log(
        `\n${noCurrency} live accounts still have no billing currency. Their deals fall back to the `
        + 'workspace base currency, which the USD dashboard then converts at that rate. Set them from '
        + 'the account page, or in bulk, before trusting per-account revenue figures.',
    );
}

close();
