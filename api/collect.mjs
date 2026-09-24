/**
 * Collecting evidence for one company, on demand.
 *
 * Two endpoints and nothing else: start it, then ask how it is going. The work
 * itself is in `lib/collect.mjs`, and the collector it drives is the
 * local-scraper project — see that file for why none of it is reimplemented
 * here.
 *
 * `start` returns as soon as the job exists, because collecting one company can
 * mean waiting for somebody to sign in to LinkedIn in a browser window that has
 * just opened. An HTTP request is the wrong shape for that wait.
 */
import { startCollection, jobStatus, scraperInstalled, slugFor } from '../lib/collect.mjs';
import { readJson, badRequest } from '../lib/http.mjs';
import { require$ } from '../lib/auth.mjs';
import { getRecord } from '../lib/repo.mjs';
import { latestEvidence } from '../lib/qualification.mjs';
import { QUALIFIER_DIR } from '../lib/qualifier-ui.mjs';
import { objectFromRoute } from './records.mjs';

/** Which qualification subject a route segment refers to. */
function subjectFor(routeSegment) {
    const objectKey = objectFromRoute(routeSegment);
    if (objectKey === 'account') return { subjectType: 'account', objectKey };
    if (objectKey === 'prospecting_company') return { subjectType: 'prospect', objectKey };
    throw badRequest(`${objectKey} records are not qualification subjects, so there is nothing to collect for them.`);
}

/**
 * Can this company be collected, and is it worth it?
 *
 * Asked by the record page so the button can say what will happen — or say why
 * it cannot — instead of offering an action that fails when it is pressed.
 */
export async function collectability({ params, ctx }) {
    const { subjectType, objectKey } = subjectFor(params.object);
    const record = getRecord(objectKey, ctx, params.id);
    if (!record) throw badRequest('That company does not exist.');

    const slug = slugFor(record);
    const evidence = latestEvidence(ctx.workspaceId, params.id, subjectType);

    return {
        slug,
        hasEvidence: !!evidence,
        collectedAt: evidence?.collected_at ?? null,
        installed: scraperInstalled(),
        directory: QUALIFIER_DIR,
        // One sentence saying what is in the way, or null when nothing is.
        blockedBecause: !slug
            ? 'This company has no LinkedIn slug, so there is no page to collect from. Add its LinkedIn company URL.'
            : (!scraperInstalled()
                ? `The collector was not found at ${QUALIFIER_DIR}.`
                : (evidence
                    ? 'Evidence has already been collected. Re-qualifying runs the rules against it, offline and free.'
                    : null)),
    };
}

export async function start({ req, params, ctx }) {
    const { subjectType } = subjectFor(params.object);
    require$(ctx, 'qualification.run');
    const body = await readJson(req).catch(() => ({}));
    return { job: startCollection(ctx, subjectType, params.id, { force: body?.force === true }) };
}

export async function status({ params }) {
    return { job: jobStatus(params.id) };
}
