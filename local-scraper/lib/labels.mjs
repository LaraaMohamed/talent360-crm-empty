export function cleanFacets(facets) {
    if (!Array.isArray(facets)) return [];
    return facets.map(f => {
        if (!f) return null;
        const name = typeof f === 'string' ? f : (f.name ?? '');
        const cleaned = name.replace(/\s+(toggle off|toggle on|selected|checkbox).*$/i, '').trim();
        return typeof f === 'string' ? cleaned : { ...f, name: cleaned };
    }).filter(Boolean);
}
