export function normalizeText(text) {
    if (!text) return '';
    return String(text).toLowerCase().trim();
}
