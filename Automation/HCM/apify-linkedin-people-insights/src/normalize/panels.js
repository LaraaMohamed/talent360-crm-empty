/**
 * Panel identification.
 *
 * The single alias table below is shared by the JSON tiers and the DOM tier, so a
 * new LinkedIn wording only ever has to be added in one place. Order matters:
 * the first definition whose pattern matches wins, which is why the narrower
 * headers ("What they studied", job titles) are listed ahead of the broader ones
 * they would otherwise be swallowed by.
 */

import { mergeBuckets, normalizeBuckets } from './buckets.js';

export const PANEL_DEFINITIONS = [
    {
        key: 'titles',
        label: 'Job titles',
        patterns: [/what they do at\b/i, /job titles?/i, /^titles?$/i, /current titles?/i],
    },
    {
        key: 'fieldsOfStudy',
        label: 'Fields of study',
        patterns: [/what they studied/i, /fields? of study/i, /^majors?$/i],
    },
    {
        key: 'functions',
        label: 'What they do',
        patterns: [/what they do/i, /job functions?/i, /^functions?$/i, /current functions?/i, /departments?/i],
    },
    {
        key: 'locations',
        label: 'Where they live',
        patterns: [/where they live/i, /where they work/i, /^locations?$/i, /geograph(?:y|ies|ic)/i, /^regions?$/i],
    },
    {
        key: 'schools',
        label: 'Where they studied',
        patterns: [/where they studied/i, /^schools?$/i, /universit(?:y|ies)/i, /alma maters?/i],
    },
    {
        key: 'skills',
        label: 'What they are skilled at',
        patterns: [/what they(?:'| a)?re skilled at/i, /what they are skilled at/i, /^skills?$/i, /top skills/i],
    },
    {
        key: 'seniority',
        label: 'Seniority',
        patterns: [/seniorit(?:y|ies)/i, /how senior/i, /^levels?$/i],
    },
];

/** The panels the qualification engine actually needs. */
export const REQUIRED_PANEL_KEYS = ['functions', 'locations'];

/** @returns {string|null} canonical panel key for a header string. */
export function mapHeaderToPanelKey(header) {
    if (typeof header !== 'string') return null;
    const value = header.trim();
    if (!value) return null;

    for (const definition of PANEL_DEFINITIONS) {
        if (definition.patterns.some((pattern) => pattern.test(value))) return definition.key;
    }
    return null;
}

/**
 * Folds raw `{ header, buckets }` panels into a canonical map.
 *
 * Panels that map to the same key are merged rather than overwritten: the same
 * panel can appear more than once per page (carousel slides, mobile variants),
 * sometimes truncated to fewer buckets in one copy than the other.
 *
 * @returns {{ panels: Record<string, {label:string,count:number}[]>,
 *   unmapped: { header: string|null, buckets: object[] }[], headersSeen: string[] }}
 */
export function canonicalizePanels(rawPanels) {
    const panels = {};
    const unmapped = [];
    const headersSeen = [];

    for (const panel of rawPanels ?? []) {
        if (panel?.header) headersSeen.push(panel.header);
        const key = mapHeaderToPanelKey(panel?.header);

        if (!key) {
            unmapped.push({ header: panel?.header ?? null, buckets: normalizeBuckets(panel?.buckets) });
            continue;
        }
        panels[key] = mergeBuckets(panels[key], panel.buckets);
    }

    return { panels, unmapped, headersSeen: [...new Set(headersSeen)] };
}

/** Which of the panels the engine needs are missing or empty. */
export function missingRequiredPanels(panels) {
    return REQUIRED_PANEL_KEYS.filter((key) => !panels?.[key]?.length);
}
