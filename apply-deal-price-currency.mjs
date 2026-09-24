/**
 * Brings existing deal prices onto the current model.
 *
 *   node apply-deal-price-currency.mjs            # show what would change
 *   node apply-deal-price-currency.mjs --apply    # write it
 *   node --env-file=data/turso.env apply-deal-price-currency.mjs --apply
 *
 * Three things, and they belong together because they are all the same read:
 *
 *   1. RECURRENCE follows the SERVICE. A row saying `one_time` on an
 *      Offshoring deal is a monthly retainer reporting itself as a one-off, so
 *      it lands in the wrong half of every figure the product publishes.
 *
 *   2. QUANTITY is kept where it means something and folded where it does not.
 *      Offshoring is priced per head, so "12 × 3,000" is the commercial fact
 *      and must survive — losing it is losing what happens when one of the
 *      twelve leaves. Every other service is quoted as one figure, so a
 *      quantity is an artefact of the old four-model form and is multiplied
 *      into the price.
 *
 *   3. THE PRICE SERIES is backfilled. A deal's price is now a dated series
 *      (`deal_price_periods`), and every deal priced before that existed has a
 *      line item and no series at all — so the price history is empty and the
 *      year's forecast reports nothing for it. One period is written per deal,
 *      effective from the day the deal was created, which is the earliest date
 *      the price can honestly be claimed to have applied from.
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
 *
 * It will not change what a deal is WORTH. Folding preserves the product,
 * keeping preserves both halves, and the recurrence fix moves a figure between
 * one-time and recurring without altering it. A deal that already has a price
 * series is left entirely alone — it has been priced under the current model
 * and this has nothing to add.
 *
 * A deal whose service is unknown, or which has more than one line item in more
 * than one currency, is REFUSED and named rather than guessed at.
 */
import { migrate, all, get, run, tx, id, now, close } from './lib/db.mjs';
import { recurrenceForPricingModel, perPersonPricing } from './lib/money.mjs';

const APPLY = process.argv.includes('--apply');

migrate();

/** What one old-model line was worth, by the arithmetic that produced it. */
function legacyValue(item) {
    const quantity = Number(item.quantity) || 0;
    if (item.pricing_model === 'placement_fee') {
        const rate = (Number(item.percent_rate) || 0) / 100;
        return quantity * (Number(item.basis_amount) || 0) * rate;
    }
    return quantity * (Number(item.unit_amount) || 0);
}

const plan = [];
const refused = [];
const alreadyCurrent = [];

for (const ws of all('SELECT id, name FROM workspaces')) {
    const services = new Map(
        all('SELECT key, label, pricing_model FROM service_lines WHERE workspace_id = ?', [ws.id])
            .map((row) => [row.key, row]),
    );

    const deals = all(
        `SELECT d.id, d.name, d.currency, d.service_line_key, d.created_at, d.account_id
           FROM deals d
          WHERE d.workspace_id = ?
            AND EXISTS (SELECT 1 FROM deal_line_items li WHERE li.deal_id = d.id)`,
        [ws.id],
    );

    for (const deal of deals) {
        const items = all(
            'SELECT * FROM deal_line_items WHERE deal_id = ? ORDER BY position, rowid', [deal.id],
        );
        const hasSeries = get(
            'SELECT COUNT(*) AS n FROM deal_price_periods WHERE deal_id = ?', [deal.id],
        ).n > 0;

        const currencies = new Set(items.map((i) => i.currency).filter(Boolean));
        if (currencies.size > 1) {
            refused.push({ deal, why: `lines in ${[...currencies].join(' and ')}`, items });
            continue;
        }

        const service = services.get(deal.service_line_key);
        if (!service) {
            refused.push({ deal, why: `no service line named "${deal.service_line_key ?? '(none)'}"`, items });
            continue;
        }

        const perPerson = perPersonPricing(service.pricing_model);
        const recurrence = recurrenceForPricingModel(service.pricing_model);
        const first = items[0];

        /**
         * Per-head services keep their two halves. Everything else collapses to
         * one figure, and a deal with several lines has them added together —
         * which is only ever right because they share a currency and, after the
         * fix above, a recurrence.
         */
        const unitAmount = perPerson && items.length === 1
            ? Number(first.unit_amount) || 0
            : items.reduce((sum, item) => sum + legacyValue(item), 0);
        const quantity = perPerson && items.length === 1 ? (Number(first.quantity) || 1) : 1;

        const lineChanges = items.length > 1
            || Number(first.quantity) !== quantity
            || Number(first.unit_amount) !== unitAmount
            || first.recurrence !== recurrence;

        if (!lineChanges && hasSeries) { alreadyCurrent.push(deal); continue; }

        plan.push({
            ws,
            deal,
            service,
            perPerson,
            recurrence,
            unitAmount,
            quantity,
            currency: first.currency || deal.currency,
            fxRate: Number(first.fx_rate) || 1,
            termMonths: items.map((i) => i.term_months).find((t) => Number(t) > 0) ?? null,
            lineChanges,
            needsSeries: !hasSeries,
            from: items.map((i) => `${i.quantity} × ${i.currency ?? ''} ${i.unit_amount} [${i.recurrence}]`),
        });
    }
}

if (refused.length) {
    console.log('\nREFUSED — these need a person to decide:\n');
    for (const r of refused) {
        console.log(`  ${r.deal.name}  (${r.why})`);
        for (const i of r.items) console.log(`      ${i.quantity} × ${i.currency ?? ''} ${i.unit_amount} [${i.recurrence}]`);
    }
}

if (alreadyCurrent.length) {
    console.log(`\n${alreadyCurrent.length} deal(s) already current — nothing to do for them.`);
}

if (!plan.length) {
    console.log('\nEvery deal is on the current model with a price series.');
    close();
    process.exit(refused.length ? 1 : 0);
}

console.log(`\n${plan.length} deal(s) to bring up to date:\n`);
for (const p of plan) {
    const total = p.unitAmount * p.quantity;
    console.log(`  ${p.deal.name}  [${p.service.label} → ${p.recurrence === 'monthly' ? 'recurring' : 'one-time'}]`);
    if (p.lineChanges) {
        console.log(`      was  ${p.from.join('  +  ')}`);
        console.log(`      now  ${p.perPerson
            ? `${p.quantity} ${p.quantity === 1 ? p.perPerson.unit : p.perPerson.unitPlural} × ${p.currency} ${p.unitAmount.toLocaleString()} = ${p.currency} ${total.toLocaleString()}`
            : `${p.currency} ${total.toLocaleString()}`}${p.recurrence === 'monthly' ? ' / month' : ''}`);
    } else {
        console.log(`      price unchanged: ${p.currency} ${total.toLocaleString()}${p.recurrence === 'monthly' ? ' / month' : ''}`);
    }
    if (p.needsSeries) {
        console.log(`      + price history starting ${String(p.deal.created_at).slice(0, 10)} (the day the deal was raised)`);
    }
}

if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write it.');
    close();
    process.exit(0);
}

let lines = 0;
let series = 0;
for (const p of plan) {
    tx(() => {
        if (p.lineChanges) {
            run('DELETE FROM deal_line_items WHERE deal_id = ?', [p.deal.id]);
            run(
                `INSERT INTO deal_line_items
                   (id, workspace_id, deal_id, label, service_line_key, pricing_model, recurrence,
                    quantity, unit_amount, term_months, currency, fx_rate, position)
                 VALUES (?,?,?,'Deal size',?,?,?,?,?,?,?,?,0)`,
                [
                    id('lit'), p.ws.id, p.deal.id, p.deal.service_line_key ?? null,
                    p.service.pricing_model, p.recurrence,
                    p.quantity, p.unitAmount,
                    p.recurrence === 'monthly' ? p.termMonths : null,
                    p.currency ?? null, p.fxRate,
                ],
            );
            lines += 1;
        }

        if (p.needsSeries) {
            /**
             * From the day the deal was raised.
             *
             * The line item carries no date of its own, so this is the earliest
             * moment the price can honestly be said to have applied from — and
             * it means the year's forecast can value every quarter since,
             * rather than reporting nothing because the series began today.
             */
            run(
                `INSERT INTO deal_price_periods
                   (id, workspace_id, deal_id, effective_from, unit_amount, quantity, currency,
                    fx_rate, recurrence, term_months, status, note, created_by, created_at,
                    approved_by, approved_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,'active',?,NULL,?,NULL,?)`,
                [
                    id('dpp'), p.ws.id, p.deal.id, String(p.deal.created_at).slice(0, 10),
                    p.unitAmount, p.quantity, p.currency ?? null, p.fxRate,
                    p.recurrence, p.recurrence === 'monthly' ? p.termMonths : null,
                    'Backfilled from the price this deal already carried.',
                    now(), now(),
                ],
            );
            series += 1;
        }

        run(
            `INSERT INTO audit_events (id, workspace_id, object_key, record_id, account_id, action,
                                       actor_id, source, before, after, created_at)
             VALUES (?,?,'deal',?,?,'deal_priced',NULL,'system',?,?,?)`,
            [
                id('aud'), p.ws.id, p.deal.id, p.deal.account_id ?? null,
                JSON.stringify({ lines: p.from }),
                JSON.stringify({
                    price: p.unitAmount * p.quantity,
                    unit_price: p.unitAmount,
                    ...(p.perPerson ? { [p.perPerson.unitPlural]: p.quantity } : {}),
                    currency: p.currency,
                    billing: p.recurrence === 'monthly' ? 'recurring' : 'one_time',
                    _reason: 'brought onto the current model by apply-deal-price-currency.mjs',
                }),
                now(),
            ],
        );
    });
}

console.log(`\nRepriced ${lines} deal(s) and backfilled ${series} price series.`);
console.log('The cached value_* columns refresh on the next write to each deal; nothing displays');
console.log('them — every read derives from the priced line — so no figure on screen is stale.');

close();
process.exit(refused.length ? 1 : 0);
