export function selectQualified(header, rows, index, bySlug, selector) {
    const qualifiedRows = [];
    const qualifiedSlugs = new Set();
    let notCollectedCount = 0;

    const uniqueSet = new Set();
    for (const row of rows) {
        const raw = row[index] || '';
        let slug = raw;
        if (raw.includes('linkedin.com/company/')) {
            const parts = raw.split('/company/');
            if (parts[1]) {
                slug = parts[1].split('/')[0].split('?')[0].trim();
            }
        }
        slug = slug.toLowerCase().replace(/[^a-z0-9_-]/g, '');
        if (slug) uniqueSet.add(slug);

        const verdicts = bySlug.get(slug);
        if (!verdicts) {
            notCollectedCount++;
            continue;
        }
        let keep = false;
        if (selector === 'hcm') {
            keep = verdicts.hcm === 'QUALIFIED';
        } else if (selector === 'offshoring') {
            keep = verdicts.offshoring === 'QUALIFIED';
        } else if (selector === 'either') {
            keep = verdicts.hcm === 'QUALIFIED' || verdicts.offshoring === 'QUALIFIED';
        } else if (selector === 'both') {
            keep = verdicts.hcm === 'QUALIFIED' && verdicts.offshoring === 'QUALIFIED';
        } else {
            keep = true;
        }
        if (keep) {
            qualifiedRows.push(row);
            qualifiedSlugs.add(slug);
        }
    }

    return {
        header,
        rows: qualifiedRows,
        stats: {
            companies: uniqueSet.size,
            companiesQualified: qualifiedSlugs.size,
            companiesNotCollected: notCollectedCount,
            outputRows: qualifiedRows.length,
        }
    };
}
