/**
 * Function-panel resolution ("What they do").
 *
 * Unlike the location panel, LinkedIn's job-function facets are close to disjoint —
 * a member has one current function — so the buckets can meaningfully be summed
 * to measure how much of the workforce the panel accounts for. They still do not
 * add up to the member total, because the panel is truncated to its top entries
 * and members with no resolvable function are omitted. `coverage` quantifies that
 * gap so the qualification engine can distinguish "few HR staff" from
 * "HR not in the visible top five".
 */

import { findAllBucketsByAliases, findBucketByAliases, sumBuckets } from './buckets.js';

export const DEFAULT_HR_ALIASES = [
    'Human Resources',
    'HR',
    'Human Resources (HR)',
    'People Operations',
    'People & Culture',
    'People and Culture',
];

/**
 * HR-adjacent functions are reported separately and never added to the HR count.
 * In LinkedIn's taxonomy "Recruiting" is its own facet alongside "Human Resources",
 * so folding it in would double count a real HR department in some companies while
 * inflating a staffing agency's numbers in others.
 */
export const DEFAULT_HR_ADJACENT_ALIASES = ['Recruiting', 'Talent Acquisition', 'Administrative', 'Support'];

/**
 * @param {{label:string,count:number}[]} buckets normalized "What they do" buckets
 * @param {{ hrAliases?: string[], hrAdjacentAliases?: string[], totalMembers?: number|null }} options
 */
export function resolveFunctionMetrics(buckets, { hrAliases, hrAdjacentAliases, totalMembers } = {}) {
    const list = buckets ?? [];
    const hrMatch = findBucketByAliases(list, hrAliases?.length ? hrAliases : DEFAULT_HR_ALIASES);
    const adjacentMatches = findAllBucketsByAliases(
        list.filter((bucket) => bucket.label !== hrMatch?.label),
        hrAdjacentAliases?.length ? hrAdjacentAliases : DEFAULT_HR_ADJACENT_ALIASES,
    );

    const visibleSum = sumBuckets(list);
    const coverage = Number.isInteger(totalMembers) && totalMembers > 0
        ? Math.min(1, visibleSum / totalMembers)
        : null;

    const smallestVisible = list.length ? Math.min(...list.map((bucket) => bucket.count)) : null;

    return {
        hrCount: hrMatch?.count ?? null,
        hrLabel: hrMatch?.label ?? null,
        hrMatchType: hrMatch?.matchType ?? null,
        hrAdjacentCount: adjacentMatches.reduce((total, match) => total + match.count, 0),
        hrAdjacent: adjacentMatches.map(({ label, count }) => ({ label, count })),
        visibleSum,
        coverage,
        bucketCount: list.length,
        /**
         * When HR is absent from a truncated panel, its true count cannot exceed the
         * smallest bucket that did make the cut — otherwise it would have been shown.
         * That is a genuine upper bound, and it is far more useful to a scoring rule
         * than a null.
         */
        hrUpperBoundIfAbsent: hrMatch ? null : smallestVisible,
    };
}
