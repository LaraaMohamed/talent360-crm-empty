/**
 * Campaign endpoints: membership, performance, and building an audience from a
 * selection.
 *
 * The generic record routes already give campaigns CRUD, list, filter, export
 * and custom fields — this file only holds what is genuinely campaign-shaped.
 * That split is the test of the object registry: adding a first-class object
 * should cost one registry entry plus its own verbs, not a second CRUD stack.
 */
import { all, get, json } from '../lib/db.mjs';
import { getRecord, idsMatching, audit, listRecords } from '../lib/repo.mjs';
import { readJson, badRequest, notFound } from '../lib/http.mjs';
import { require$, can } from '../lib/auth.mjs';
import {
    addMembers, removeMembers, setMemberStatus, members, membershipsFor,
    performance, MEMBER_STATUSES,
} from '../lib/campaigns.mjs';

/**
 * Resolves what the caller selected.
 *
 * Accepts explicit ids, or `all: true` plus the filter that produced the view —
 * so "add all 1,204 matching accounts to this campaign" means the 1,204, not
 * the 50 rendered on screen. Shared with the bulk endpoints deliberately: one
 * definition of "the selection" for the whole product.
 */
export function resolveSelection(objectKey, ctx, body) {
    if (body.all) {
        return idsMatching(objectKey, ctx, {
            filter: body.filter ?? null,
            listId: body.listId ?? null,
            q: body.q ?? null,
        }).ids;
    }
    return Array.isArray(body.ids) ? body.ids : [];
}

export async function listMembers({ params, url, ctx }) {
    getRecord('campaign', ctx, params.id);
    return members(ctx, params.id, {
        memberType: url.searchParams.get('type'),
        status: url.searchParams.get('status'),
        includeRemoved: url.searchParams.get('removed') === '1',
        page: Number(url.searchParams.get('page')) || 1,
        limit: Number(url.searchParams.get('limit')) || 100,
    });
}

/**
 * Adds members from a selection of contacts or accounts.
 *
 * Adding an ACCOUNT optionally cascades to its contacts, because "campaign the
 * 60 qualified companies" almost always means the people at them — but it is a
 * choice, stated in the request, not a surprise.
 */
export async function addCampaignMembers({ req, params, ctx }) {
    require$(ctx, can(ctx, 'record.write.all') ? 'record.write.all' : 'record.write.own');
    const campaignRecord = getRecord('campaign', ctx, params.id);
    const body = await readJson(req);
    const memberType = body.memberType ?? 'contact';
    const objectKey = memberType === 'account' ? 'account' : 'contact';

    let ids = resolveSelection(objectKey, ctx, body);
    if (!ids.length) throw badRequest('Nothing was selected.');

    const result = addMembers(ctx, params.id, memberType, ids);

    let cascaded = null;
    if (memberType === 'account' && body.includeContacts) {
        const contactIds = all(
            `SELECT id FROM contacts WHERE workspace_id = ? AND deleted_at IS NULL AND is_active = 1
               AND account_id IN (${ids.map(() => '?').join(',')})`,
            [ctx.workspaceId, ...ids],
        ).map((r) => r.id);
        cascaded = addMembers(ctx, params.id, 'contact', contactIds);
    }

    audit(ctx, {
        objectKey: 'campaign',
        recordId: params.id,
        action: 'campaign_members_added',
        after: { memberType, requested: ids.length, ...result, cascadedContacts: cascaded?.added ?? 0 },
    });

    return { ...result, cascaded, campaign: campaignRecord.name };
}

export async function removeCampaignMembers({ req, params, ctx }) {
    require$(ctx, can(ctx, 'record.write.all') ? 'record.write.all' : 'record.write.own');
    getRecord('campaign', ctx, params.id);
    const body = await readJson(req);
    const memberType = body.memberType ?? 'contact';
    const ids = resolveSelection(memberType === 'account' ? 'account' : 'contact', ctx, body);
    if (!ids.length) throw badRequest('Nothing was selected.');

    const result = removeMembers(ctx, params.id, memberType, ids);
    audit(ctx, {
        objectKey: 'campaign', recordId: params.id, action: 'campaign_members_removed',
        after: { memberType, ...result },
    });
    // Said explicitly, because "removed" reading as "deleted" is exactly the
    // misunderstanding that makes people avoid the button.
    return { ...result, note: 'Removed members keep their history. The campaign\'s original reach is unchanged.' };
}

export async function patchMemberStatus({ req, params, ctx }) {
    require$(ctx, can(ctx, 'record.write.all') ? 'record.write.all' : 'record.write.own');
    getRecord('campaign', ctx, params.id);
    const body = await readJson(req);
    const memberType = body.memberType ?? 'contact';
    const ids = resolveSelection(memberType === 'account' ? 'account' : 'contact', ctx, body);
    if (!ids.length) throw badRequest('Nothing was selected.');
    const result = setMemberStatus(ctx, params.id, memberType, ids, body.status);
    audit(ctx, {
        objectKey: 'campaign', recordId: params.id, action: 'campaign_member_status_changed',
        after: { memberType, status: body.status, updated: result.updated },
    });
    return result;
}

export async function campaignPerformance({ params, ctx }) {
    getRecord('campaign', ctx, params.id);
    const stats = performance(ctx, params.id);

    // The attributed deals themselves, not just their total. A number nobody can
    // click through to is a number nobody trusts.
    const deals = listRecords('deal', ctx, {
        filter: { op: 'and', children: [{ field: 'campaign_id', operator: 'is_any_of', value: [params.id] }] },
        limit: 50,
        sort: [{ field: 'updated_at', direction: 'desc' }],
    });

    return { ...stats, deals: deals.records, dealTotal: deals.total, statuses: MEMBER_STATUSES };
}

/** The campaigns a contact or an account belongs to. Rendered on the record page. */
export async function membershipFor({ params, ctx }) {
    const objectKey = params.object === 'accounts' ? 'account' : 'contact';
    getRecord(objectKey, ctx, params.id);
    return { memberships: membershipsFor(ctx, objectKey, params.id), statuses: MEMBER_STATUSES };
}
