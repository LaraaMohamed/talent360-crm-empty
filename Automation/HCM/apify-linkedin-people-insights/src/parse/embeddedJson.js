/**
 * Extraction of LinkedIn's server-rendered JSON out of a company page.
 *
 * This is what makes one page load enough. LinkedIn ships the People tab's data
 * inside the HTML document as a series of hidden `<code id="bpr-guid-…">` elements,
 * each holding the JSON body of an internal API response, paired with
 * `<code id="datalet-bpr-guid-…">` elements that record which endpoint produced it.
 * Reading those gives us the insight panels *and* the company metadata from a
 * single GET, with no JavaScript execution, no carousel clicking, and no
 * "show more" interaction.
 */

import * as cheerio from 'cheerio';
import { companyIdFromUrn } from '../util/url.js';

/** @returns {{ id: string, json: unknown }[]} every `<code>` block that parses as JSON. */
export function extractCodeBlocks(html) {
    if (!html || typeof html !== 'string') return [];
    const $ = cheerio.load(html);
    const blocks = [];

    $('code').each((_, element) => {
        const id = $(element).attr('id') ?? '';
        // cheerio's .text() has already reversed the HTML entity escaping.
        const raw = stripComments($(element).text());
        if (raw.length < 2) return;
        if (!raw.startsWith('{') && !raw.startsWith('[')) return;

        try {
            blocks.push({ id, json: JSON.parse(raw) });
        } catch {
            // Not every hidden <code> block is JSON; skipping is the correct outcome.
        }
    });

    return blocks;
}

/**
 * Flattens the code blocks into something searchable.
 *
 * `included` is LinkedIn's normalized entity table: every panel, bucket, and
 * company record is a flat entry there, cross-referenced by `entityUrn`. Merging
 * all of the tables into one map means callers never have to resolve references.
 */
export function buildEntityGraph(blocks) {
    const roots = [];
    const entities = new Map();
    const endpoints = [];

    for (const { id, json } of blocks) {
        if (id.startsWith('datalet-')) {
            const request = readRequestPath(json);
            if (request) endpoints.push(request);
            continue;
        }

        roots.push(json);
        const included = Array.isArray(json?.included) ? json.included : [];
        for (const entity of included) {
            const urn = entity?.entityUrn ?? entity?.['*entityUrn'] ?? entity?.objectUrn;
            if (typeof urn === 'string') entities.set(urn, entity);
        }
    }

    return { roots, entities, endpoints, entityList: [...entities.values()] };
}

/**
 * Company metadata, read out of whichever entity in the graph looks like the
 * organization record.
 */
export function extractCompanyMetadata(graph) {
    const candidates = [...graph.entityList, ...graph.roots.map((root) => root?.data).filter(Boolean)];
    const metadata = {
        name: null,
        universalName: null,
        companyId: null,
        entityUrn: null,
        industry: null,
        headquarters: null,
        staffCount: null,
        staffCountRange: null,
        followerCount: null,
        websiteUrl: null,
        description: null,
        founded: null,
    };

    for (const entity of candidates) {
        if (!entity || typeof entity !== 'object') continue;
        const urn = entity.entityUrn ?? entity.objectUrn;
        const isCompanyLike = typeof urn === 'string' && /(?:company|organization)/i.test(urn);
        if (!isCompanyLike && !entity.universalName) continue;

        assign(metadata, 'entityUrn', typeof urn === 'string' ? urn : null);
        assign(metadata, 'companyId', companyIdFromUrn(urn));
        assign(metadata, 'universalName', str(entity.universalName));
        assign(metadata, 'name', str(entity.name) ?? str(entity.localizedName));
        assign(metadata, 'staffCount', int(entity.staffCount) ?? int(entity.employeeCount));
        assign(metadata, 'followerCount', int(entity.followerCount) ?? int(entity.followingInfo?.followerCount));
        assign(metadata, 'websiteUrl', str(entity.companyPageUrl) ?? str(entity.websiteUrl) ?? str(entity.website));
        assign(metadata, 'description', str(entity.description) ?? str(entity.tagline));
        assign(metadata, 'founded', int(entity.foundedOn?.year));
        assign(metadata, 'industry', readIndustry(entity));
        assign(metadata, 'headquarters', readHeadquarters(entity));
        assign(metadata, 'staffCountRange', readStaffRange(entity.staffCountRange));
    }

    return metadata;
}

/**
 * Turns an observed endpoint path into a reusable template by replacing the
 * company's own identifiers with placeholders. Conservative on purpose: if
 * neither identifier appears in the path there is nothing safe to parameterize,
 * so the endpoint is not learned.
 *
 * @returns {string|null}
 */
export function templatizeEndpoint(path, { universalName, companyId }) {
    if (typeof path !== 'string' || !path) return null;

    let template = path;
    let parameterized = false;

    if (companyId) {
        const before = template;
        template = template.replaceAll(companyId, '{companyId}');
        parameterized ||= template !== before;
    }
    if (universalName) {
        const before = template;
        template = template.replaceAll(encodeURIComponent(universalName), '{universalName}');
        template = template.replaceAll(universalName, '{universalName}');
        parameterized ||= template !== before;
    }

    return parameterized ? template : null;
}

/** Fills a learned template back in for a different company. */
export function renderEndpoint(template, { universalName, companyId }) {
    if (typeof template !== 'string') return null;
    if (template.includes('{companyId}') && !companyId) return null;
    if (template.includes('{universalName}') && !universalName) return null;

    return template
        .replaceAll('{companyId}', companyId ?? '')
        .replaceAll('{universalName}', encodeURIComponent(universalName ?? ''));
}

function readRequestPath(json) {
    const request = json?.request ?? json?.url ?? json?.meta?.request;
    if (typeof request !== 'string' || !request.includes('/voyager/')) return null;
    const status = json?.status ?? json?.meta?.status;
    if (typeof status === 'number' && status >= 400) return null;
    return request;
}

function readIndustry(entity) {
    const direct = str(entity.industry) ?? str(entity.industryName);
    if (direct) return direct;
    const list = entity.industries ?? entity.industryV2Taxonomy ?? entity.industryUrns;
    if (Array.isArray(list)) {
        for (const item of list) {
            const name = str(item) ?? str(item?.name) ?? str(item?.localizedName);
            if (name && !name.startsWith('urn:')) return name;
        }
    }
    return null;
}

function readHeadquarters(entity) {
    const hq = entity.headquarter ?? entity.headquarters ?? entity.confirmedLocations?.find((loc) => loc?.headquarter);
    if (!hq || typeof hq !== 'object') return null;
    const parts = [hq.city, hq.geographicArea ?? hq.state, hq.country].map(str).filter(Boolean);
    return parts.length ? { city: str(hq.city), country: str(hq.country), display: parts.join(', ') } : null;
}

function readStaffRange(range) {
    if (!range || typeof range !== 'object') return null;
    const start = int(range.start);
    const end = int(range.end);
    if (start === null && end === null) return null;
    return end === null ? `${start}+` : `${start ?? 0}-${end}`;
}

function stripComments(text) {
    return text.trim().replace(/^<!--+/, '').replace(/--+>$/, '').trim();
}

function assign(target, key, value) {
    if (target[key] === null && value !== null && value !== undefined) target[key] = value;
}

function str(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
}

function int(value) {
    return Number.isInteger(value) ? value : null;
}
