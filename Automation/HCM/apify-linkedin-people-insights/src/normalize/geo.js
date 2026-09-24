/**
 * Country resolution out of the "Where they live" panel.
 *
 * The one thing that must not be done here is adding buckets up. LinkedIn's
 * location facets are hierarchical and overlapping — a real panel reads
 * `Egypt 91`, `Cairo, Egypt 70`, `Al Jizah, Egypt 15`, `Giza 10`, and the same
 * person is counted in the country bucket and in their city bucket, sometimes in
 * two spellings of the same governorate ("Al Jizah, Egypt" and "Giza"). Summing
 * that gives 186 members for a company with 113. So:
 *
 *   - the country-level bucket is the answer whenever it is present;
 *   - if it is absent, the largest sub-region bucket is a *lower bound*, returned
 *     with reduced confidence and labelled as such;
 *   - sub-region buckets are never summed, in either branch.
 */

const BUILTIN_COUNTRY_ALIASES = {
    Egypt: ['egypt', 'arab republic of egypt', 'egypt, arab rep.', 'مصر'],
    'Saudi Arabia': ['saudi arabia', 'kingdom of saudi arabia', 'ksa'],
    'United Arab Emirates': ['united arab emirates', 'uae', 'u.a.e.'],
    Kuwait: ['kuwait', 'state of kuwait'],
    Qatar: ['qatar', 'state of qatar'],
    Bahrain: ['bahrain', 'kingdom of bahrain'],
    Oman: ['oman', 'sultanate of oman'],
    Jordan: ['jordan', 'hashemite kingdom of jordan'],
    Morocco: ['morocco', 'kingdom of morocco'],
    Tunisia: ['tunisia'],
    Nigeria: ['nigeria'],
    Kenya: ['kenya'],
    'South Africa': ['south africa'],
    'United Kingdom': ['united kingdom', 'uk', 'u.k.', 'great britain', 'england'],
    'United States': ['united states', 'united states of america', 'usa', 'u.s.', 'us'],
    Germany: ['germany', 'deutschland'],
    India: ['india'],
    Pakistan: ['pakistan'],
};

const BUILTIN_SUBREGIONS = {
    Egypt: [
        'cairo', 'greater cairo', 'new cairo', 'nasr city', 'heliopolis', 'maadi', 'zamalek', 'downtown cairo',
        'giza', 'al jizah', 'al haram', 'sheikh zayed', '6th of october', 'sixth of october', '6th of october city',
        'alexandria', 'al iskandariyah', 'port said', 'suez', 'ismailia', 'damietta', 'damiette',
        'mansoura', 'al mansurah', 'tanta', 'zagazig', 'banha', 'benha', 'shibin el kom',
        'asyut', 'assiut', 'sohag', 'minya', 'al minya', 'beni suef', 'fayoum', 'al fayyum',
        'luxor', 'aswan', 'hurghada', 'sharm el sheikh', 'marsa matruh', 'qena', 'obour', 'el shorouk',
        'badr city', 'new administrative capital', 'smart village',
    ],
    'Saudi Arabia': ['riyadh', 'jeddah', 'dammam', 'khobar', 'al khobar', 'mecca', 'makkah', 'medina', 'dhahran'],
    'United Arab Emirates': ['dubai', 'abu dhabi', 'sharjah', 'ajman', 'ras al khaimah', 'al ain', 'fujairah'],
};

/**
 * @param {{label:string,count:number}[]} buckets normalized "Where they live" buckets
 * @param {{ country: string, countryAliases?: object, subRegionHints?: object }} options
 * @returns {{ country: string, count: number|null, basis: 'country'|'sub-region-max'|'absent',
 *   confidence: 'high'|'low'|'none', matchedLabel: string|null,
 *   subRegions: {label:string,count:number}[], subRegionSum: number,
 *   otherCountries: {label:string,count:number}[], note: string|null }}
 */
export function resolveCountryCount(buckets, { country, countryAliases = {}, subRegionHints = {} } = {}) {
    const canonical = country?.trim() || 'Egypt';
    const aliases = aliasesFor(canonical, countryAliases);
    const subRegionNames = subRegionsFor(canonical, subRegionHints);

    const classified = (buckets ?? []).map((bucket) => ({
        ...bucket,
        level: classify(bucket.label, aliases, subRegionNames),
    }));

    const countryBucket = classified.find((bucket) => bucket.level === 'country');
    const subRegions = classified.filter((bucket) => bucket.level === 'sub-region');
    const otherCountries = classified
        .filter((bucket) => bucket.level === 'other')
        .map(({ label, count }) => ({ label, count }));
    const subRegionSum = subRegions.reduce((total, bucket) => total + bucket.count, 0);

    const base = {
        country: canonical,
        subRegions: subRegions.map(({ label, count }) => ({ label, count })),
        subRegionSum,
        otherCountries,
    };

    if (countryBucket) {
        return {
            ...base,
            count: countryBucket.count,
            basis: 'country',
            confidence: 'high',
            matchedLabel: countryBucket.label,
            note: subRegionSum > countryBucket.count
                ? 'Sub-region buckets overlap the country bucket and each other; the country bucket is authoritative.'
                : null,
        };
    }

    if (subRegions.length) {
        const largest = subRegions.reduce((best, bucket) => (bucket.count > best.count ? bucket : best));
        return {
            ...base,
            count: largest.count,
            basis: 'sub-region-max',
            confidence: 'low',
            matchedLabel: largest.label,
            note: `No country-level bucket for ${canonical} in the panel. Reporting the largest sub-region bucket `
                + `("${largest.label}") as a lower bound — sub-regions overlap, so they cannot be summed.`,
        };
    }

    return {
        ...base,
        count: null,
        basis: 'absent',
        confidence: 'none',
        matchedLabel: null,
        note: `The location panel contains no bucket attributable to ${canonical}. Note that LinkedIn truncates `
            + 'this panel to its top entries, so absence is not proof of zero.',
    };
}

/** 'country' | 'sub-region' | 'other' for one location label. */
export function classify(label, aliases, subRegionNames) {
    const value = String(label ?? '').trim().toLowerCase();
    if (!value) return 'other';

    if (aliases.has(value)) return 'country';

    // "Cairo, Egypt" / "Cairo Governorate, Egypt"
    for (const alias of aliases) {
        if (value.endsWith(`, ${alias}`) || value.endsWith(` ${alias}`)) return 'sub-region';
    }

    const stripped = value.replace(/\s+(?:governorate|province|region|metropolitan area|area)$/i, '').trim();
    if (subRegionNames.has(value) || subRegionNames.has(stripped)) return 'sub-region';

    return 'other';
}

function aliasesFor(country, overrides) {
    const set = new Set([country.toLowerCase()]);
    for (const alias of BUILTIN_COUNTRY_ALIASES[country] ?? []) set.add(alias.toLowerCase());
    for (const alias of lookupOverride(overrides, country)) set.add(alias);
    return set;
}

function subRegionsFor(country, overrides) {
    const set = new Set(BUILTIN_SUBREGIONS[country] ?? []);
    for (const name of lookupOverride(overrides, country)) set.add(name);
    return set;
}

/** Case-insensitive key lookup, so `{ egypt: [...] }` works as well as `{ Egypt: [...] }`. */
function lookupOverride(overrides, country) {
    if (!overrides || typeof overrides !== 'object') return [];
    const wanted = country.toLowerCase();
    for (const [key, value] of Object.entries(overrides)) {
        if (key.toLowerCase() !== wanted) continue;
        if (!Array.isArray(value)) return [];
        return value.filter((item) => typeof item === 'string').map((item) => item.trim().toLowerCase()).filter(Boolean);
    }
    return [];
}
