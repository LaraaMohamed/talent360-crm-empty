export function normalizeCompanySlug(val) {
    if (!val) return '';
    const str = String(val).trim();
    if (str.includes('linkedin.com/company/')) {
        const parts = str.split('/company/');
        if (parts[1]) {
            return parts[1].split('/')[0].split('?')[0].trim().toLowerCase();
        }
    }
    return str.toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

export function detectCompanyColumn(headers, rows) {
    if (!headers || !Array.isArray(headers)) return { index: 0, name: '(column 1)' };
    
    if (rows && rows.length > 0) {
        for (let col = 0; col < headers.length; col++) {
            if (rows.some(r => r[col] && String(r[col]).includes('linkedin.com/company/'))) {
                return { index: col, name: headers[col] || `(column ${col + 1})` };
            }
        }
    }

    let index = headers.findIndex(h => /linkedin|url/i.test(h));
    if (index >= 0) {
        return { index, name: headers[index] };
    }

    index = headers.findIndex(h => /company|organization/i.test(h));
    if (index >= 0) {
        return { index, name: headers[index] };
    }

    index = headers.findIndex(h => /name/i.test(h));
    const finalIndex = index >= 0 ? index : 0;
    return { index: finalIndex, name: headers[finalIndex] || `(column ${finalIndex + 1})` };
}

export function isCompanyUrl(val) {
    if (!val) return false;
    const str = String(val).trim();
    return str.includes('linkedin.com/company/') || /^[a-z0-9_-]+$/i.test(str);
}
