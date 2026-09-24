/**
 * Primitive readers for LinkedIn's internal JSON.
 *
 * LinkedIn wraps display strings in a handful of interchangeable envelopes
 * (`"x"`, `{ text: "x" }`, `{ text: { text: "x" } }`, `{ attributes: [], text: "x" }`)
 * and counts under a rotating set of key names. Nothing downstream should have to
 * know that, so all of the tolerance lives here.
 */

const TEXT_KEYS = ['text', 'name', 'title', 'displayName', 'label', 'localizedName', 'localizedTitle', 'accessibilityText'];
const COUNT_KEYS = ['count', 'entityCount', 'numResults', 'memberCount', 'total', 'value', 'displayValue'];
const HEADER_KEY_RE = /^(?:header|title|heading|caption|headerText|titleText|localizedHeader)$/i;

/**
 * Resolves a display string out of any of LinkedIn's text envelopes.
 * @returns {string|null} trimmed, non-empty string, or null.
 */
export function textOf(node, depth = 0) {
    if (depth > 4) return null;
    if (typeof node === 'string') {
        const trimmed = node.trim();
        return trimmed || null;
    }
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;

    for (const key of TEXT_KEYS) {
        if (!(key in node)) continue;
        const resolved = textOf(node[key], depth + 1);
        if (resolved) return resolved;
    }
    return null;
}

/**
 * Resolves a bucket count. Only non-negative integers qualify — this is what
 * keeps percentages, widths, and urn fragments from being mistaken for counts.
 * @returns {number|null}
 */
export function countOf(node, depth = 0) {
    if (depth > 3) return null;
    if (typeof node === 'number') return isCount(node) ? node : null;
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;

    for (const key of COUNT_KEYS) {
        if (!(key in node)) continue;
        const raw = node[key];
        if (typeof raw === 'number' && isCount(raw)) return raw;
        if (typeof raw === 'string') {
            const parsed = parseCountString(raw);
            if (parsed !== null) return parsed;
        }
        if (raw && typeof raw === 'object') {
            const nested = countOf(raw, depth + 1);
            if (nested !== null) return nested;
        }
    }
    return null;
}

/** `"1,234"` -> 1234, `"87"` -> 87, `"12%"` -> null, `"1.5K"` -> 1500. */
export function parseCountString(raw) {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    if (!value || value.includes('%')) return null;

    const abbreviated = value.match(/^([\d,.]+)\s*([KkMm])$/);
    if (abbreviated) {
        const base = Number(abbreviated[1].replace(/,/g, ''));
        if (!Number.isFinite(base)) return null;
        const multiplier = /[Kk]/.test(abbreviated[2]) ? 1_000 : 1_000_000;
        return Math.round(base * multiplier);
    }

    if (!/^[\d,\s]+$/.test(value)) return null;
    const parsed = Number(value.replace(/[,\s]/g, ''));
    return isCount(parsed) ? parsed : null;
}

/**
 * True if `node` looks like a single insight bucket: it carries both a label and
 * a count. Shape-driven on purpose — LinkedIn renames its `$type` model strings
 * far more often than it changes this shape.
 */
export function looksLikeBucket(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    return countOf(node) !== null && textOf(node) !== null;
}

/** Reads the first plausible header string off a candidate container object. */
export function headerOf(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    for (const [key, raw] of Object.entries(node)) {
        if (!HEADER_KEY_RE.test(key)) continue;
        const resolved = textOf(raw);
        if (resolved) return resolved;
    }
    return null;
}

/** Collects every string anywhere in a JSON tree, for text-level probes. */
export function collectStrings(root, { limit = 20_000, maxLength = 400 } = {}) {
    const out = [];
    const stack = [root];
    const seen = new Set();

    while (stack.length && out.length < limit) {
        const node = stack.pop();
        if (typeof node === 'string') {
            if (node.length <= maxLength) out.push(node);
            continue;
        }
        if (!node || typeof node !== 'object') continue;
        if (seen.has(node)) continue;
        seen.add(node);
        stack.push(...(Array.isArray(node) ? node : Object.values(node)));
    }
    return out;
}

function isCount(value) {
    return Number.isInteger(value) && value >= 0 && value < 100_000_000;
}
