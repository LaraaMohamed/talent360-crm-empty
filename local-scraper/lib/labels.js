export function cleanFacets(facets) {
    if (!Array.isArray(facets)) return [];
    return facets.map(f => {
        if (!f) return null;
        if (typeof f === 'string') {
            return f.replace(/\b(toggle off|toggle on|selected|checkbox)\b/gi, '').trim();
        }
        const raw = f.label || f.name || '';
        const cleaned = String(raw).replace(/\b(toggle off|toggle on|selected|checkbox)\b/gi, '').trim();
        return {
            ...f,
            label: cleaned,
            name: cleaned,
        };
    }).filter(Boolean);
}
