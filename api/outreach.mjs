/**
 * Outreach (Smartlead) — HTTP surface.
 *
 * ── ROUTING SHAPE ───────────────────────────────────────────────────────────
 *
 * Settings and diagnostics are admin-only (record.write.all). Viewing
 * membership & outreach state is reader-capable (any signed-in session that
 * can read the contact can read its outreach card — denying it would just be
 * security through obscurity). Adding to a campaign is writer-capable, with
 * the same ownership check other bulk writes use.
 *
 * The webhook is PUBLIC by design: Smartlead speaks over the open internet
 * with no session cookie and, per its own docs, no signature header — the
 * secret lives in the URL path. The route is therefore listed in
 * WEBHOOK_ROUTES and bypasses the session gate in server.mjs, where
 * lib/outreach.webhookSecretMatches does the credential check inline.
 */
import { all, get, run, id, now, json } from '../lib/db.mjs';
import { readJson, badRequest, notFound } from '../lib/http.mjs';
import { require$, can } from '../lib/auth.mjs';
import { setting, setSetting } from '../lib/settings.mjs';
import { getRecord, idsMatching } from '../lib/repo.mjs';
import { objectFromRoute } from './records.mjs';
import * as outreach from '../lib/outreach.mjs';
import * as smartlead from '../lib/smartlead.mjs';

/* ------------------------------------------------------ connection / status -- */

export async function testConnection({ req, ctx }) {
    require$(ctx, 'record.write.all');
    const body = await readJson(req).catch(() => ({}));
    const apiKey = body.apiKey?.trim() || outreach.apiKey(ctx.workspaceId);
    if (!apiKey) throw badRequest('Paste your Smartlead API key first.');
    try {
        const result = await smartlead.testConnection({ apiKey });
        // Persist the key only on a proven connection — a wrong key that lands
        // in the settings table looks "configured" everywhere else.
        if (body.apiKey) setSetting(ctx.workspaceId, 'smartlead_api_key', body.apiKey.trim());
        // Mint the webhook secret if this is the first successful connection.
        if (!setting(ctx.workspaceId, 'smartlead_webhook_secret')) {
            const { randomBytes } = await import('node:crypto');
            setSetting(ctx.workspaceId, 'smartlead_webhook_secret', randomBytes(24).toString('base64url'));
        }
        return { ok: true, ...result, configured: true };
    } catch (error) {
        const auth = Boolean(error.authFailed);
        throw badRequest(auth ? 'Smartlead rejected that API key — double-check it in Smartlead → Settings → API.' : String(error.message).slice(0, 300));
    }
}

export async function disconnect({ ctx }) {
    require$(ctx, 'record.write.all');
    setSetting(ctx.workspaceId, 'smartlead_api_key', null);
    return { ok: true, configured: false };
}

export async function status({ ctx }) {
    // Health is interesting to anyone who can read campaigns, not only admins
    // — an SDR who notices "last sync: 3 days ago" is the canary.
    return outreach.integrationStatus(ctx.workspaceId);
}

/** The Outreach → Smartlead overview page's one request: every linked campaign, rolled up. */
export async function campaignsOverview({ ctx }) {
    return { campaigns: outreach.campaignsOverview(ctx.workspaceId) };
}

/* -------------------------------------------------------- campaigns (proxy) -- */

export async function listSmartleadCampaigns({ ctx }) {
    require$(ctx, 'record.write.all');
    const apiKey = outreach.apiKey(ctx.workspaceId);
    if (!apiKey) throw badRequest('Connect Smartlead first.');
    const rows = await smartlead.listCampaigns({ apiKey });
    return { campaigns: rows };
}

/**
 * Totally rewiring a campaign is what "link" and "unlink" do. A CRM campaign is
 * the system-of-record name; the Smartlead campaign is the execution engine.
 * Channel is forced to email on link — Smartlead IS the email engine — so
 * the deliverability gate in addMembers keeps working without a special case.
 */
export async function linkCampaign({ req, ctx }) {
    require$(ctx, 'record.write.all');
    const { campaignId, smartleadCampaignId, smartleadCampaignName } = await readJson(req);
    if (!campaignId) throw badRequest('Pick a CRM campaign to link.');
    if (!smartleadCampaignId) throw badRequest('Pick a Smartlead campaign.');
    const row = get(`SELECT id FROM campaigns WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`, [campaignId, ctx.workspaceId]);
    if (!row) throw notFound('That CRM campaign does not exist.');
    run(
        `UPDATE campaigns SET external_id = ?, channel = 'email', updated_at = ? WHERE id = ?`,
        [String(smartleadCampaignId), now(), campaignId],
    );
    // Remember the webhook mapping so reconnecting replaces rather than piles up.
    const webhooks = json(setting(ctx.workspaceId, 'smartlead_webhooks'), {}) ?? {};
    webhooks[String(campaignId)] = { smartleadCampaignId: String(smartleadCampaignId), name: String(smartleadCampaignName ?? ''), linkedAt: now() };
    setSetting(ctx.workspaceId, 'smartlead_webhooks', webhooks);
    return { ok: true, campaignId, smartleadCampaignId: String(smartleadCampaignId) };
}

export async function unlinkCampaign({ req, ctx }) {
    require$(ctx, 'record.write.all');
    const { campaignId } = await readJson(req);
    if (!campaignId) throw badRequest('Pick a campaign to unlink.');
    run(`UPDATE campaigns SET external_id = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?`, [now(), campaignId, ctx.workspaceId]);
    const webhooks = json(setting(ctx.workspaceId, 'smartlead_webhooks'), {}) ?? {};
    delete webhooks[String(campaignId)];
    setSetting(ctx.workspaceId, 'smartlead_webhooks', webhooks);
    return { ok: true };
}

export async function ensureWebhook({ req, ctx }) {
    require$(ctx, 'record.write.all');
    const apiKey = outreach.apiKey(ctx.workspaceId);
    if (!apiKey) throw badRequest('Connect Smartlead first.');
    const secret = setting(ctx.workspaceId, 'smartlead_webhook_secret');
    if (!secret) throw badRequest('No webhook secret exists — reconnect Smartlead.');
    const { campaignId } = await readJson(req);
    if (!campaignId) throw badRequest('Pick a campaign.');
    const row = get(`SELECT id, external_id, name FROM campaigns WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`, [campaignId, ctx.workspaceId]);
    if (!row || !row.external_id) throw badRequest('Link this CRM campaign to a Smartlead campaign first.');

    // Base URL is what makes the callback resolvable over the open internet.
    // Render and the Doha VM both set PUBLIC_BASE_URL; local dev falls back to
    // asking — which is fine, the webhook URL is what the admin pastes back.
    const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
    if (!base) throw badRequest('Set PUBLIC_BASE_URL so Smartlead can reach this server.');

    const webhookUrl = `${base}/api/webhooks/smartlead/${secret}`;
    const created = await smartlead.createWebhook(
        { name: `CRM → ${row.name}`, url: webhookUrl, emailCampaignId: row.external_id },
        { apiKey },
    );
    const webhooks = json(setting(ctx.workspaceId, 'smartlead_webhooks'), {}) ?? {};
    webhooks[String(campaignId)] = {
        ...webhooks[String(campaignId)],
        webhookId: created?.id ?? created?.webhook_id ?? null,
        webhookUrl,
        createdAt: now(),
    };
    setSetting(ctx.workspaceId, 'smartlead_webhooks', webhooks);
    return { ok: true, webhookUrl, webhookId: webhooks[String(campaignId)].webhookId };
}

/* --------------------------------------------------------------- enrollment -- */

/**
 * POST /api/integrations/smartlead/enroll
 *
 * Body: { campaignId, ids|all+filter/listId/q, mapping?, override? }
 *
 * `mapping` is the saved-or-ephemeral CRM→Smartlead field template — see
 * lib/outreach.mapToLead for the shape. Omitted → the last saved template.
 */
export async function enroll({ req, ctx }) {
    require$(ctx, can(ctx, 'record.write.all') ? 'record.write.all' : 'record.write.own');

    const body = await readJson(req);
    const campaignId = body.campaignId;
    if (!campaignId) throw badRequest('Pick a campaign.');

    let contactIds = Array.isArray(body.ids) ? body.ids : [];
    if (body.all) {
        // Only contacts carry an email worth sequencing — reuse the existing
        // idsMatching contract so "enroll everyone in this view" is one request.
        contactIds = idsMatching('contact', ctx, { filter: body.filter ?? null, listId: body.listId ?? null, q: body.q ?? null }).ids;
    }
    if (!contactIds.length) throw badRequest('Select some contacts to enroll.');

    // 400-at-a-time is enough to need a cap, and 500 is where the verification
    // precedent draws it — keep the same budget, same message.
    const MAX = 500;
    if (contactIds.length > MAX) {
        throw badRequest(`That is ${contactIds.length} contacts. Outreach enrollment is capped at ${MAX} per run — narrow the selection and repeat.`);
    }

    const mapping = body.mapping ?? json(setting(ctx.workspaceId, 'smartlead_field_mapping'), null) ?? {};
    if (body.mapping) setSetting(ctx.workspaceId, 'smartlead_field_mapping', body.mapping);

    // Load contacts WITH their account name — the mapping needs it as
    // `account_name`, and a query per contact is 500 round trips.
    const placeholders = contactIds.map(() => '?').join(',');
    const rows = all(
        `SELECT c.*, a.name AS account_name
           FROM contacts c LEFT JOIN accounts a ON a.id = c.account_id
          WHERE c.id IN (${placeholders}) AND c.workspace_id = ? AND c.deleted_at IS NULL`,
        [...contactIds, ctx.workspaceId],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = contactIds.map((id) => byId.get(id)).filter(Boolean);

    return outreach.enrollContacts(ctx, {
        campaignId, contacts: ordered, mapping,
        options: { override: body.override === true, dryRun: body.dryRun === true },
    });
}

/* ------------------------------------------------------------- reconciliation -- */

/** POST /api/integrations/smartlead/import-leads — see lib/outreach.importLeadsFromSmartlead. */
export async function importLeads({ req, ctx }) {
    require$(ctx, 'record.write.all');
    const { campaignId } = await readJson(req);
    if (!campaignId) throw badRequest('Pick a campaign.');
    const stats = await outreach.importLeadsFromSmartlead(ctx, campaignId);
    return { ok: true, ...stats };
}

export async function syncNow({ req, ctx }) {
    require$(ctx, 'record.write.all');
    const body = await readJson(req).catch(() => ({}));
    if (body.campaignId) {
        const row = get(`SELECT id, name, external_id FROM campaigns WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`, [body.campaignId, ctx.workspaceId]);
        if (!row || !row.external_id) throw badRequest('That campaign is not linked to Smartlead.');
        const stats = await outreach.syncCampaignLeads(ctx.workspaceId, row);
        setSetting(ctx.workspaceId, 'smartlead_last_sync_at', now());
        return { ok: true, campaigns: [{ campaignId: row.id, stats }] };
    }
    const results = await outreach.syncAllWorkspaces();
    // Filter to this workspace — the sweeper is workspace-wide but the caller
    // is scoped, and cross-workspace campaign ids are not theirs to learn.
    return { ok: true, campaigns: results.filter((r) => r.workspaceId === ctx.workspaceId) };
}

/* ------------------------------------------------------------------ events -- */

export async function listEvents({ url, ctx }) {
    require$(ctx, 'record.write.all');
    const statusFilter = url.searchParams.get('status'); // failed|processed|ignored|received
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
    const where = ['workspace_id = ?'];
    const params = [ctx.workspaceId];
    if (statusFilter) { where.push('processing_status = ?'); params.push(statusFilter); }
    const rows = all(
        `SELECT id, event_type, external_campaign_id, campaign_id, contact_id,
                processing_status, error_message, retry_count, occurred_at, received_at, processed_at
           FROM outreach_events
          WHERE ${where.join(' AND ')}
          ORDER BY received_at DESC
          LIMIT ?`,
        [...params, limit],
    );
    return { events: rows };
}

export async function retryOneEvent({ params, ctx }) {
    require$(ctx, 'record.write.all');
    return outreach.retryEvent(ctx.workspaceId, params.id);
}

/* ------------------------------------------------------ contact outreach card -- */

export async function contactOutreach({ params, ctx }) {
    // Any session that can read the contact can read its outreach card.
    const contact = getRecord('contact', ctx, params.id);
    if (!contact) throw notFound('That contact does not exist.');
    const rows = all(
        `SELECT m.*, c.name AS campaign_name, c.status AS campaign_status, c.external_id AS smartlead_campaign_id
           FROM campaign_members m
           JOIN campaigns c ON c.id = m.campaign_id
          WHERE m.workspace_id = ? AND m.member_type = 'contact' AND m.member_id = ?
          ORDER BY m.added_at DESC`,
        [ctx.workspaceId, params.id],
    );
    return { memberships: rows };
}

/* ----------------------------------------------------------------- webhook -- */

/**
 * The Smartlead callback. PUBLIC — see the module header.
 *
 * Smartlead documents two payload shapes and no signature header, so:
 *   1. the secret rides in the URL path,
 *   2. idempotency uses X-Request-Id when the platform sends it, otherwise a
 *      fingerprint of the payload,
 *   3. the handler answers quickly and truthfully: 200 for every well-formed
 *      delivery (including "I have nothing to do with this event"), 401 for a
 *      wrong secret, 400 only for JSON that cannot be read.
 */
export async function webhook({ req, params }) {
    const body = await readJson(req).catch((error) => {
        // readJson throws a typed 400 on bad JSON — rethrow with the same shape
        // so the response helper can stay uniform.
        throw error;
    });

    // Resolve the workspace that owns this secret. Secrets are per-workspace by
    // design, and a deploy can host more than one in Turso — so match on the
    // value, not on a URL guess.
    const provided = String(params.secret ?? '').trim();
    if (!provided) return { error: 'Missing webhook secret.' };

    // A single-workspace deploy finds the row in one query; a multi-workspace
    // deploy still works, one comparison per workspace at worst. Fast enough
    // for a webhook (low volume per minute) and small enough to never warrant a
    // dedicated reverse index over a settings value.
    const expectedRows = all(`SELECT workspace_id, value FROM settings WHERE key = 'smartlead_webhook_secret'`);
    let workspaceId = null;
    for (const row of expectedRows) {
        let expected;
        try { expected = JSON.parse(row.value); } catch { continue; }
        if (!expected) continue;
        const a = Buffer.from(provided);
        const b = Buffer.from(String(expected));
        // timingSafeEqual would throw on differing lengths — guard above, compare only when equal length is plausible
        if (a.length === b.length) {
            const { timingSafeEqual } = await import('node:crypto');
            if (timingSafeEqual(a, b)) { workspaceId = row.workspace_id; break; }
        }
    }
    if (!workspaceId) {
        const { badRequest: _bad } = await import('../lib/http.mjs');
        throw _bad('Webhook secret is not recognised.');
    }

    const requestId = req.headers['x-request-id'] ?? req.headers['x-requestid'] ?? null;
    // Tolerate Smartlead's other event envelope: two event names, two shapes.
    const payloads = Array.isArray(body) ? body : [body];
    const results = [];
    for (const payload of payloads) {
        results.push(outreach.ingestWebhookEvent(workspaceId, payload, requestId));
    }
    // Always 200 — Smartlead retries non-2xx, and a deliverable failure here is
    // one only a human can fix (unlinked campaign, unknown contact), so retries
    // would just replay the same refusal forever.
    return { received: results.length, results };
}
