import { normalizeCompanySlug, detectCompanyColumn, isCompanyUrl } from './normalize.js';

export { normalizeCompanySlug, detectCompanyColumn, isCompanyUrl };

/**
 * A real RFC4180 tokenizer.
 *
 * The previous version was `line.split(',')` over `text.split(/\r?\n/)` —
 * despite every caller's comments describing this file as already hardened
 * against quoted commas, embedded newlines and doubled quotes, none of that
 * existed. A company name like `"Acme, Inc."` silently split into two
 * columns and shifted every field after it in that row, with no error and
 * no rejection — just a wrong value landing in the wrong column, imported
 * as if it were correct. This walks the text character by character so a
 * comma, newline or quote inside a quoted field is never treated as a
 * delimiter.
 */
function tokenize(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;
    const n = text.length;

    while (i < n) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
                inQuotes = false; i += 1; continue;
            }
            field += ch; i += 1; continue;
        }
        if (ch === '"') { inQuotes = true; i += 1; continue; }
        if (ch === ',') { row.push(field); field = ''; i += 1; continue; }
        if (ch === '\r') { i += 1; continue; } // normalised away; \n (bare or paired) ends the row
        if (ch === '\n') {
            row.push(field); field = '';
            rows.push(row); row = [];
            i += 1; continue;
        }
        field += ch; i += 1;
    }
    // The last field/row has no trailing newline to close it.
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
}

export function parseTable(text) {
    if (!text) return { header: [], rows: [] };
    // A UTF-8 BOM, as an actual code point rather than a literal byte in this
    // source file — the byte itself is invisible in every editor and diff,
    // which is exactly how this project lost time to it once before.
    const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const all = tokenize(stripped)
        // A tokenized blank line is one field containing only whitespace —
        // `.filter(Boolean)` on the old line-split version dropped truly
        // empty lines the same way; matched here so behaviour does not
        // change for files that relied on it.
        .filter((r) => !(r.length === 1 && r[0].trim() === ''))
        .map((r) => r.map((cell) => cell.trim()));
    if (!all.length) return { header: [], rows: [] };
    const [header, ...rows] = all;
    return { header, rows };
}

/** Quotes a field only when it needs it — matches how every spreadsheet writes CSV. */
function csvField(value) {
    const s = String(value ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers, rows) {
    const lines = [headers.map(csvField).join(',')];
    for (const row of rows) {
        lines.push(row.map(csvField).join(','));
    }
    return lines.join('\n');
}
