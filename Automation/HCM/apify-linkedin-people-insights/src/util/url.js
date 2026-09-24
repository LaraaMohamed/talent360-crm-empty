/**
 * Company reference canonicalization.
 *
 * Everything downstream keys off `universalName`, so this is the only place that
 * knows what shapes of user input are acceptable.
 */

const COMPANY_PATH_RE = /linkedin\.com\/(?:company|school|showcase)\/([^/?#]+)/i;

/**
 * @param {string|object} raw a company URL, a slug, a numeric company id, or an
 *   object carrying any of those under `url` / `companyUrl` / `universalName` / `slug`.
 * @returns {{ universalName: string, isNumericId: boolean, companyUrl: string,
 *   peopleUrl: string, aboutUrl: string, label: string }}
 */
export function parseCompanyRef(raw) {
    const value = extractString(raw);
    if (!value) throw new Error('Empty company reference');

    let universalName;
    const matched = value.match(COMPANY_PATH_RE);

    if (matched) {
        universalName = matched[1];
    } else if (/^https?:\/\//i.test(value) || value.includes('/')) {
        throw new Error(`Not a LinkedIn company URL: ${value}`);
    } else {
        universalName = value;
    }

    universalName = safeDecode(universalName).trim().replace(/^\/+|\/+$/g, '').toLowerCase();
    if (!universalName) throw new Error(`Could not derive a company slug from: ${value}`);

    const base = `https://www.linkedin.com/company/${encodeURIComponent(universalName)}`;
    return {
        universalName,
        isNumericId: /^\d+$/.test(universalName),
        companyUrl: `${base}/`,
        peopleUrl: `${base}/people/`,
        aboutUrl: `${base}/about/`,
        label: universalName,
    };
}

/** Parses a list of references, keeping the failures instead of throwing on the first one. */
export function parseCompanyRefs(list) {
    const refs = [];
    const errors = [];
    const seen = new Set();

    for (const item of list ?? []) {
        try {
            const ref = parseCompanyRef(item);
            if (seen.has(ref.universalName)) continue;
            seen.add(ref.universalName);
            refs.push(ref);
        } catch (err) {
            errors.push({ input: item, message: err.message });
        }
    }
    return { refs, errors };
}

/** `urn:li:fsd_company:1035` -> `1035`; anything unrecognized -> null. */
export function companyIdFromUrn(urn) {
    if (typeof urn !== 'string') return null;
    const matched = urn.match(/urn:li:(?:fs_|fsd_)?(?:company|organization)(?:[^:]*):(\d+)/i);
    return matched ? matched[1] : null;
}

function extractString(raw) {
    if (raw == null) return '';
    if (typeof raw === 'object') {
        const candidate = raw.url ?? raw.companyUrl ?? raw.universalName ?? raw.slug ?? raw.link;
        return candidate == null ? '' : String(candidate).trim();
    }
    return String(raw).trim();
}

function safeDecode(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}
