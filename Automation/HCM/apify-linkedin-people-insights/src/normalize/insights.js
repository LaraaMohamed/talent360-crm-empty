/**
 * Assembles a provider's raw payload into the one canonical shape that the
 * qualification engine and the dataset output both consume.
 *
 * Providers differ in how they get the bytes; they must not differ in what they
 * hand back. Every provider returns `{ rawPanels, associatedMembers, company }`
 * and this module is the only thing that turns that into the canonical model.
 */

import { normalizeBuckets } from './buckets.js';
import { canonicalizePanels, missingRequiredPanels } from './panels.js';

/**
 * @param {{ rawPanels?: object[], associatedMembers?: {count:number,source:string}|null,
 *   company?: object, panels?: Record<string, object[]> }} raw
 * @returns {{ company: object, associatedMembers: number|null, panels: object,
 *   panelHeadersSeen: string[], unmappedPanels: object[], missingPanels: string[],
 *   sufficiency: { sufficient: boolean, reasons: string[] } }}
 */
export function buildCanonicalInsights(raw) {
    // A provider may deliver already-keyed panels (the static provider, the DOM
    // tier) or raw header/bucket pairs (the JSON tiers). Both are accepted.
    const fromRaw = canonicalizePanels(raw?.rawPanels);
    const panels = { ...fromRaw.panels };

    for (const [key, buckets] of Object.entries(raw?.panels ?? {})) {
        const normalized = normalizeBuckets(buckets);
        if (normalized.length) panels[key] = normalized;
    }

    for (const [key, buckets] of Object.entries(panels)) {
        panels[key] = normalizeBuckets(buckets);
    }

    const company = raw?.company ?? {};
    const associatedMembers = pickMemberTotal(raw?.associatedMembers, company);
    const missingPanels = missingRequiredPanels(panels);

    const reasons = [];
    if (associatedMembers === null) reasons.push('no associated-member total found');
    for (const key of missingPanels) reasons.push(`missing "${key}" panel`);

    return {
        company,
        associatedMembers,
        associatedMembersSource: associatedMembers === null
            ? null
            : (raw?.associatedMembers?.count === associatedMembers ? 'insights-header' : 'company-staff-count'),
        panels,
        panelHeadersSeen: fromRaw.headersSeen,
        unmappedPanels: fromRaw.unmapped,
        missingPanels,
        sufficiency: { sufficient: reasons.length === 0, reasons },
    };
}

/**
 * Prefers the "N associated members" figure from the insights header over the
 * company's `staffCount`. They are different numbers: `staffCount` counts every
 * member who lists the company, while the insights total counts the members the
 * panels were actually computed over. Mixing them would make the ratios wrong.
 */
function pickMemberTotal(associatedMembers, company) {
    if (Number.isInteger(associatedMembers?.count)) return associatedMembers.count;
    if (Number.isInteger(company?.staffCount)) return company.staffCount;
    return null;
}
