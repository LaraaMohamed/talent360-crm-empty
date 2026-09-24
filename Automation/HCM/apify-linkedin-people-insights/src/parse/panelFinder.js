/**
 * Shape-driven discovery of insight panels.
 *
 * The deliberate choice here is not to match on LinkedIn's `$type` model names
 * (`com.linkedin.voyager.dash.organization.…`). Those get renamed on LinkedIn's
 * own release cadence and would silently zero out our extraction. What does not
 * change is the shape: a panel is a container with a header string plus a list of
 * items that each carry a label and an integer count. We look for that, then map
 * the header text to a canonical panel key.
 */

import { collectStrings, countOf, headerOf, looksLikeBucket, textOf } from './values.js';

const MIN_BUCKETS = 2;
const MAX_DEPTH = 14;

/**
 * @param {{ roots: unknown[], entityList: unknown[], entities: Map<string, unknown> }} graph
 * @returns {{ header: string|null, buckets: { label: string, count: number }[], path: string }[]}
 */
export function findBucketPanels(graph) {
    const entities = graph.entities ?? new Map();
    const panels = [];
    const signatures = new Set();
    const visited = new Set();

    const resolve = (node) => {
        if (typeof node === 'string' && node.startsWith('urn:')) return entities.get(node) ?? null;
        return node;
    };

    const record = (header, buckets, path) => {
        const signature = `${header ?? ''}::${buckets.map((b) => `${b.label}=${b.count}`).join('|')}`;
        if (signatures.has(signature)) return;
        signatures.add(signature);
        panels.push({ header, buckets, path });
    };

    const visit = (node, ancestors, path, depth) => {
        if (depth > MAX_DEPTH || node == null || typeof node !== 'object') return;
        if (visited.has(node)) return;
        visited.add(node);

        if (Array.isArray(node)) {
            const buckets = readBuckets(node, resolve);
            if (buckets.length >= MIN_BUCKETS) {
                record(findHeader(ancestors, buckets), buckets, path);
            }
            node.forEach((item, index) => {
                const resolved = resolve(item);
                if (resolved && typeof resolved === 'object') {
                    visit(resolved, ancestors, `${path}[${index}]`, depth + 1);
                }
            });
            return;
        }

        const nextAncestors = [...ancestors, node];
        for (const [key, raw] of Object.entries(node)) {
            const child = resolve(raw);
            if (child && typeof child === 'object') visit(child, nextAncestors, `${path}.${key}`, depth + 1);
        }
    };

    graph.roots?.forEach((root, index) => visit(root, [], `roots[${index}]`, 0));
    graph.entityList?.forEach((entity, index) => visit(entity, [], `entities[${index}]`, 0));

    return panels;
}

/**
 * Reads the "N associated members" total. This is the count LinkedIn shows above
 * the panels, and it is the denominator for every ratio the qualification engine
 * computes — so it comes from the page text rather than being inferred by summing
 * buckets, which would be wrong (see normalize/geo.js on overlapping buckets).
 *
 * @returns {{ count: number, source: string }|null}
 */
export function findAssociatedMemberCount(graph) {
    const patterns = [
        /([\d,.]+)\s*(?:\+\s*)?associated\s+members?/i,
        /([\d,.]+)\s*(?:\+\s*)?employees?\s+on\s+linkedin/i,
        /([\d,.]+)\s*(?:\+\s*)?members?\s+associated/i,
    ];

    const strings = collectStrings({ roots: graph.roots, entityList: graph.entityList });
    for (const pattern of patterns) {
        for (const value of strings) {
            const matched = value.match(pattern);
            if (!matched) continue;
            const count = Number(matched[1].replace(/[,.\s]/g, ''));
            if (Number.isInteger(count) && count >= 0) return { count, source: value.trim() };
        }
    }
    return null;
}

function readBuckets(list, resolve) {
    const buckets = [];

    for (const item of list) {
        const node = resolve(item);
        if (!looksLikeBucket(node)) continue;
        const label = textOf(node);
        const count = countOf(node);
        if (!label || count === null) continue;
        // A label that is itself just a number is a count rendered twice, not a bucket.
        if (/^[\d,.\s%]+$/.test(label)) continue;
        buckets.push({ label: label.trim(), count });
    }

    // Every item in a real panel list is a bucket. A stray pair of count-carrying
    // objects inside an unrelated array is not a panel.
    return buckets.length >= MIN_BUCKETS && buckets.length >= list.length / 2 ? buckets : [];
}

function findHeader(ancestors, buckets) {
    const bucketLabels = new Set(buckets.map((bucket) => bucket.label.toLowerCase()));

    for (let index = ancestors.length - 1; index >= 0; index -= 1) {
        const header = headerOf(ancestors[index]);
        if (header && !bucketLabels.has(header.toLowerCase())) return header;
    }
    return null;
}
