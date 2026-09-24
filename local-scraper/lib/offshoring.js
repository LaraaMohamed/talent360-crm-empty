export const ID = 'offshoring';
export const TITLE = 'Offshoring (Egypt footprint)';
export const SUMMARY = 'Egypt headcount and presence';
export const DEFAULTS = { minEgyptCount: 20 };

export function run(snapshot, config) {
    const rawLocations = snapshot.facets?.location ?? [];
    
    const locations = rawLocations.map(l => {
        if (typeof l === 'string') {
            return { label: l.replace(/\s+(toggle off|toggle on|selected|checkbox).*$/i, '').trim(), count: 0 };
        }
        const raw = l.label ?? l.name ?? '';
        const cleaned = String(raw).replace(/\s+(toggle off|toggle on|selected|checkbox).*$/i, '').trim();
        return { ...l, label: cleaned, name: cleaned };
    });

    const exactEgypt = locations.find(l => {
        const name = l.label ?? l.name ?? '';
        return name.toLowerCase().replace(/\s+/g, ' ').trim() === 'egypt';
    });

    const countryCount = exactEgypt ? (typeof exactEgypt === 'object' ? (exactEgypt.count ?? exactEgypt.value ?? 0) : 0) : 0;
    const countryMethod = exactEgypt ? 'country-row' : (locations.length > 0 ? 'top-locations' : 'none');

    const min = config?.minEgyptCount ?? 20;

    let verdict = 'REVIEW';
    if (exactEgypt) {
        if (countryCount >= min) {
            verdict = 'QUALIFIED';
        } else {
            verdict = 'REJECTED';
        }
    } else if (locations.length > 0) {
        verdict = 'REVIEW';
    } else {
        verdict = 'REVIEW';
    }

    return {
        verdict,
        metrics: { countryCount, countryMethod },
        reasons: [],
        notes: [`Egypt count: ${countryCount}`],
    };
}
