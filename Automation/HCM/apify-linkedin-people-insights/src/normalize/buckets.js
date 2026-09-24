/**
 * Bucket-list hygiene: dedupe, sort, look up by alias.
 */

/**
 * Deduplicates by label (keeping the largest count for a repeated label) and
 * sorts descending. LinkedIn regularly renders the same panel twice — once in the
 * visible carousel slide and once in a preloaded one — so duplicates are normal
 * and are not evidence of a parsing error.
 */
export function normalizeBuckets(buckets) {
    const byLabel = new Map();

    for (const bucket of buckets ?? []) {
        const label = typeof bucket?.label === 'string' ? bucket.label.trim() : '';
        const count = bucket?.count;
        if (!label || !Number.isInteger(count) || count < 0) continue;

        const key = label.toLowerCase();
        const existing = byLabel.get(key);
        if (!existing || count > existing.count) byLabel.set(key, { label, count });
    }

    return [...byLabel.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Union of two bucket lists, largest count per label wins. */
export function mergeBuckets(a, b) {
    return normalizeBuckets([...(a ?? []), ...(b ?? [])]);
}

/**
 * Finds the bucket whose label matches any alias, exactly (case-insensitive)
 * first, then as a whole-word containment. Containment is deliberately the
 * fallback and not the primary rule: "Human Resources" must not be matched by a
 * bucket labelled "Human Resources Consulting".
 *
 * @returns {{ label: string, count: number, matchedAlias: string, matchType: 'exact'|'contains' }|null}
 */
export function findBucketByAliases(buckets, aliases) {
    const normalizedAliases = (aliases ?? [])
        .map((alias) => (typeof alias === 'string' ? alias.trim().toLowerCase() : ''))
        .filter(Boolean);
    if (!normalizedAliases.length) return null;

    for (const bucket of buckets ?? []) {
        const label = bucket.label.toLowerCase();
        const exact = normalizedAliases.find((alias) => alias === label || stripParenthetical(label) === alias);
        if (exact) return { ...bucket, matchedAlias: exact, matchType: 'exact' };
    }

    for (const bucket of buckets ?? []) {
        const label = bucket.label.toLowerCase();
        const contained = normalizedAliases.find((alias) => wholeWordIncludes(label, alias));
        if (contained) return { ...bucket, matchedAlias: contained, matchType: 'contains' };
    }

    return null;
}

/** All buckets matching any alias, each returned once. */
export function findAllBucketsByAliases(buckets, aliases) {
    const matches = [];
    for (const bucket of buckets ?? []) {
        const match = findBucketByAliases([bucket], aliases);
        if (match) matches.push(match);
    }
    return matches;
}

export function sumBuckets(buckets) {
    return (buckets ?? []).reduce((total, bucket) => total + (bucket.count ?? 0), 0);
}

/** `"human resources (hr)"` -> `"human resources"`. */
function stripParenthetical(label) {
    return label.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function wholeWordIncludes(haystack, needle) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(haystack);
}
