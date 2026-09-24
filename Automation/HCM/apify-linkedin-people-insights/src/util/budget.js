/**
 * Page-load accounting.
 *
 * A "page load" is any network round trip to LinkedIn that returns a document or
 * an API payload. It is the actor's unit of cost, because it dominates both
 * Compute Unit time and the risk of being rate-limited. The caps here are
 * enforced, not advisory: a tier that would exceed them is refused before the
 * request goes out, so a misconfigured run fails loudly instead of overspending.
 */

export class BudgetExceededError extends Error {
    constructor(message, scope) {
        super(message);
        this.name = 'BudgetExceededError';
        this.scope = scope;
    }
}

export class Budget {
    constructor({ maxPerCompany = 2, maxTotal = 0 } = {}) {
        this.maxPerCompany = maxPerCompany;
        this.maxTotal = maxTotal;
        this.totalLoads = 0;
        this.totalBytes = 0;
        this.byTier = new Map();
    }

    /** A per-company view that shares the global counters. */
    forCompany(universalName) {
        const budget = this;
        let loads = 0;
        let bytes = 0;

        return {
            universalName,
            get loads() { return loads; },
            get bytes() { return bytes; },
            get remaining() {
                const perCompany = budget.maxPerCompany - loads;
                if (!budget.maxTotal) return perCompany;
                return Math.min(perCompany, budget.maxTotal - budget.totalLoads);
            },

            /** Throws unless at least `count` more loads are affordable. */
            assert(count = 1) {
                if (loads + count > budget.maxPerCompany) {
                    throw new BudgetExceededError(
                        `Page-load budget for ${universalName} exhausted (${loads}/${budget.maxPerCompany})`,
                        'company',
                    );
                }
                if (budget.maxTotal && budget.totalLoads + count > budget.maxTotal) {
                    throw new BudgetExceededError(
                        `Run-wide page-load budget exhausted (${budget.totalLoads}/${budget.maxTotal})`,
                        'run',
                    );
                }
            },

            spend({ tier, bytes: spentBytes = 0 } = {}) {
                loads += 1;
                bytes += spentBytes;
                budget.totalLoads += 1;
                budget.totalBytes += spentBytes;
                if (tier) budget.byTier.set(tier, (budget.byTier.get(tier) ?? 0) + 1);
            },
        };
    }

    stats() {
        return {
            totalPageLoads: this.totalLoads,
            totalBytes: this.totalBytes,
            pageLoadsByTier: Object.fromEntries(this.byTier),
        };
    }
}
