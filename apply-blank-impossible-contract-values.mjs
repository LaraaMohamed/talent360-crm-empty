/**
 * Clears agreement contract values that cannot be real.
 *
 *   node apply-blank-impossible-contract-values.mjs            # show what would change
 *   node apply-blank-impossible-contract-values.mjs --apply    # write it
 *   node --env-file=data/turso.env apply-blank-impossible-contract-values.mjs
 *
 *   --ceiling=<number>   what counts as impossible (default 1,000,000,000)
 *
 * ── WHERE THE BAD FIGURES CAME FROM ─────────────────────────────────────────
 *
 * Not from the arithmetic. `contractValue()` multiplies the monthly fee typed
 * into the generation wizard by the contract term, and it did that correctly.
 * What reached it was test data: a monthly fee of 456,788,798,798 on one
 * document, and a start date of "0002-09-01" on another, which parses as the
 * year 2 and yields a term of roughly twenty-four thousand months.
 *
 * The date case is now refused at source. The fee is not: a number somebody
 * types into a money field is their business, and a helper that decides which
 * contracts are too large to be believed is a worse problem than the one it
 * solves.
 *
 * ── WHY BLANK RATHER THAN CORRECT ───────────────────────────────────────────
 *
 * There is no way to recover what these contracts are actually worth — the
 * inputs that produced them were never right. Null means "nobody has recorded
 * this", which is true, and it keeps the figure out of every USD total until
 * somebody types the real one. A wrong number on a dashboard is acted on; a
 * missing one is asked about.
 *
 * Nothing else on the agreement is touched: the document, its dates, its
 * status and its parties are all left exactly as they are.
 */
import { migrate, all, get, run, tx, now, close } from './lib/db.mjs';

const APPLY = process.argv.includes('--apply');
const arg = process.argv.find((a) => a.startsWith('--ceiling='));

/**
 * Above this, a contract value is treated as impossible.
 *
 * One billion, in whatever currency the agreement is denominated in. The real
 * contracts in this database are hundreds of thousands; the bad ones are
 * trillions and quadrillions. Anything between those is left alone, because a
 * threshold that has to make a fine judgement is the wrong tool — this one only
 * has to separate a business from a typo.
 */
const CEILING = arg ? Number(arg.slice('--ceiling='.length)) : 1_000_000_000;

if (!Number.isFinite(CEILING) || CEILING <= 0) {
    console.error('--ceiling must be a positive number.');
    process.exit(1);
}

migrate();

const suspect = all(
    `SELECT a.id, a.number, a.title, a.contract_value, a.currency, a.effective_date, a.expiry_date,
            acc.name AS account
       FROM agreements a
       LEFT JOIN accounts acc ON acc.id = a.account_id
      WHERE a.contract_value IS NOT NULL AND a.contract_value > ?
      ORDER BY a.contract_value DESC`,
    [CEILING],
);

const total = get('SELECT COUNT(*) AS n FROM agreements WHERE contract_value IS NOT NULL').n;
console.log(`${total} agreements carry a contract value; ${suspect.length} are above ${CEILING.toLocaleString()}.`);

if (!suspect.length) {
    console.log('Nothing to do.');
    close();
    process.exit(0);
}

console.log('\nWould blank:');
for (const a of suspect) {
    console.log(
        `  ${a.number}  ${(a.currency ?? '???')} ${Number(a.contract_value).toLocaleString()}`
        + `  — ${a.account ?? 'no account'}  (${a.effective_date ?? '?'} to ${a.expiry_date ?? '?'})`,
    );
}

// What survives, so the run can be sanity-checked against something.
const kept = all(
    `SELECT number, currency, contract_value FROM agreements
      WHERE contract_value IS NOT NULL AND contract_value <= ? ORDER BY contract_value DESC`,
    [CEILING],
);
if (kept.length) {
    console.log('\nLeft alone:');
    for (const a of kept) console.log(`  ${a.number}  ${(a.currency ?? '???')} ${Number(a.contract_value).toLocaleString()}`);
}

if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write it.');
    close();
    process.exit(0);
}

const stamp = now();
tx(() => {
    for (const a of suspect) {
        run('UPDATE agreements SET contract_value = NULL, updated_at = ? WHERE id = ?', [stamp, a.id]);
        // Append-only, so the figure that was there is recoverable from the
        // trail even though the column no longer holds it.
        run(
            `INSERT INTO audit_events (id, workspace_id, object_key, record_id, account_id, action,
                                       before, after, source, created_at)
             SELECT ?, workspace_id, 'agreement', id, account_id, 'contract_value_cleared',
                    ?, ?, 'automation', ?
               FROM agreements WHERE id = ?`,
            [
                `aud_${Math.random().toString(36).slice(2, 14)}`,
                JSON.stringify({ contract_value: a.contract_value, currency: a.currency }),
                JSON.stringify({ contract_value: null, reason: `above ${CEILING}` }),
                stamp, a.id,
            ],
        );
    }
});

const left = get(
    'SELECT COUNT(*) AS n FROM agreements WHERE contract_value IS NOT NULL AND contract_value > ?',
    [CEILING],
).n;
console.log(`\nBlanked ${suspect.length}. Above the ceiling now: ${left}.`);
console.log('Re-enter the real figures on those agreements when you have them.');

close();
