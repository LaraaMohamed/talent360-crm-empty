/**
 * Outreach → Smartlead Campaigns — the one screen the integration never had.
 *
 * Everything it needs already existed: a health endpoint (integrationStatus),
 * a per-campaign link/sync panel buried in that campaign's Members tab, and
 * an enrollment wizard reachable from a contacts list. None of them answered
 * "what is going on with Smartlead, across every campaign, right now" —
 * which meant the only way to see a second linked campaign's numbers was to
 * already know its name and go find its record. This is that answer: every
 * linked campaign, its outreach rollup, and the integration's own health.
 *
 * `renderSmartleadPanel` is the reusable half — it is mounted both by the
 * standalone /outreach/smartlead route below AND embedded directly inside
 * the Campaigns list page (see list.js), so "view Smartlead from inside
 * Campaigns" and "the dedicated page" are the same code, not two.
 */
import { h, mount, date, relative, number, toast, modal } from '../core.js';
import { api } from '../api.js';
import * as store from '../store.js';
import { emptyState, skeletonRows, errorState, statTile } from '../components.js';
import { setPageTitle } from '../app.js';

/**
 * The "create/link a campaign from Smartlead" dialog — the primary way a
 * campaign now comes into being (see list.js's openCreate, which offers this
 * instead of a blank generic form for the campaign object). Standalone so
 * both the embedded panel below and the Campaigns list's "New" button can
 * open it without either owning the other's lifecycle.
 *
 * Returns the new/linked CRM campaign id, `'__blank__'` if the caller asked
 * for a plain campaign with no Smartlead tie instead, or null if cancelled.
 */
export async function linkCampaignDialog() {
    let smartleadCampaigns = [];
    let crmCampaigns = [];
    try {
        [smartleadCampaigns, crmCampaigns] = await Promise.all([
            api.get('/api/integrations/smartlead/campaigns').then((r) => r.campaigns ?? []),
            api.get('/api/campaigns?limit=200').then((r) => (r.records ?? []).filter((c) => !c.external_id)),
        ]);
    } catch (err) {
        // Not connected, or the connection is broken — this must not be a
        // dead end. Whoever hit "New campaign" still gets a way to make one.
        toast(`${err.message} — creating a plain campaign instead.`, 'warning');
        return '__blank__';
    }
    if (!smartleadCampaigns.length) {
        toast('No unlinked Smartlead campaigns found — creating a plain campaign instead.', 'warning');
        return '__blank__';
    }

    let crmId = '__new__';
    let smartleadId = String(smartleadCampaigns[0]?.id ?? smartleadCampaigns[0]?.campaign_id ?? '');
    const smartleadNameOf = (sid) => {
        const sc = smartleadCampaigns.find((s) => String(s.id ?? s.campaign_id) === String(sid));
        return sc?.name ?? sc?.campaign_name ?? '';
    };
    // Defaults to the Smartlead campaign's own name — editable, never blank.
    let newName = smartleadNameOf(smartleadId);
    let nameTouched = false;
    let importOutcome = null;

    const body = h('div.stack');
    const repaint = () => {
        body.replaceChildren(
            h('div.field',
                h('label', 'Smartlead campaign'),
                h('select.input', {
                    onchange: (e) => {
                        smartleadId = e.target.value;
                        if (!nameTouched) newName = smartleadNameOf(smartleadId);
                        repaint();
                    },
                },
                    smartleadCampaigns.map((sc) => h('option', {
                        value: String(sc.id ?? sc.campaign_id ?? ''), selected: String(sc.id ?? sc.campaign_id) === smartleadId,
                    }, `${sc.name ?? sc.campaign_name ?? `Campaign #${sc.id}`} (#${sc.id ?? sc.campaign_id})`))),
            ),
            h('div.field',
                h('label', 'CRM campaign'),
                h('select.input', { onchange: (e) => { crmId = e.target.value; repaint(); } },
                    h('option', { value: '__new__', selected: crmId === '__new__' }, '+ Create a new campaign from this'),
                    crmCampaigns.map((c) => h('option', { value: c.id, selected: c.id === crmId }, c.name))),
            ),
            crmId === '__new__' && h('div.field',
                h('label', 'Name'),
                h('input.input', {
                    value: newName, dir: 'auto',
                    oninput: (e) => { newName = e.target.value; nameTouched = true; },
                }),
                h('span.help', 'Filled in from the Smartlead campaign\'s name — edit it if you want the CRM to call it something else.'),
            ),
        );
    };
    repaint();

    const confirmed = await modal({
        title: 'New campaign, from Smartlead',
        body,
        footer: (close) => [
            h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
            h('button.btn.ghost', { onclick: () => close('__blank__'), title: 'A campaign not tied to Smartlead — e.g. tracking a non-email touch' }, 'Not from Smartlead…'),
            h('button.btn.primary', {
                onclick: async (e) => {
                    if (crmId === '__new__' && !newName.trim()) {
                        toast('Name the new campaign first.', 'error');
                        return;
                    }
                    e.currentTarget.disabled = true;
                    try {
                        let targetId = crmId;
                        if (crmId === '__new__') {
                            const { record } = await api.post('/api/campaigns', { name: newName.trim(), status: 'active' });
                            targetId = record.id;
                        }
                        await api.post('/api/integrations/smartlead/link', {
                            campaignId: targetId, smartleadCampaignId: smartleadId,
                            smartleadCampaignName: smartleadNameOf(smartleadId),
                        });
                        // A campaign just linked straight from Smartlead has no CRM
                        // contacts behind it yet — import them right away so it
                        // does not sit at "all zero" the moment it appears. If this
                        // part fails, the campaign is still linked (do not lose that),
                        // but silently swallowing the error left someone believing
                        // an import had happened when it never did — the toast below
                        // has to say which actually occurred.
                        importOutcome = await api.post('/api/integrations/smartlead/import-leads', { campaignId: targetId })
                            .then((r) => ({ ok: true, ...r }))
                            .catch((err) => ({ ok: false, message: err.message }));
                        close(targetId);
                    } catch (err) {
                        toast(err.message, 'error');
                        e.currentTarget.disabled = false;
                    }
                },
            }, 'Link'),
        ],
    });
    if (confirmed === '__blank__') return '__blank__';
    if (confirmed) {
        if (importOutcome?.ok) {
            toast(`Campaign linked — imported ${importOutcome.membersAdded ?? 0} lead(s) from Smartlead.`, 'success');
        } else if (importOutcome) {
            toast(`Campaign linked, but importing its leads failed: ${importOutcome.message} Use "Import leads from Smartlead" on it to retry.`, 'warning');
        } else {
            toast('Campaign linked.', 'success');
        }
        // `store.state.meta.campaigns` is cached for the session and is
        // exactly what the "Add to Smartlead" wizard checks for a linked
        // campaign — without this, the campaign just linked here still
        // reads as unlinked everywhere else until the page is reloaded.
        // See refreshCampaigns' own doc comment in store.js.
        await store.refreshCampaigns().catch(() => {});
    }
    return confirmed ?? null;
}

/**
 * Mount the health card + linked-campaigns table into `host`, and keep it
 * live (own load/paint cycle). Returns a `{ reload }` handle so a caller —
 * the campaigns list, mainly — can refresh it after an action of its own
 * (e.g. just linked a new campaign) without re-mounting the whole panel.
 */
export function renderSmartleadPanel(host, { embedded = false } = {}) {
    let status = null;
    let overview = null;
    let error = null;
    mount(host, skeletonRows(3));

    async function load() {
        try {
            [status, overview] = await Promise.all([
                api.get('/api/integrations/smartlead/status'),
                api.get('/api/integrations/smartlead/overview'),
            ]);
            error = null;
        } catch (err) {
            error = err.message;
        }
        paint();
    }

    async function syncAll(e) {
        const button = e?.currentTarget;
        if (button) button.disabled = true;
        // Up to 30 pages × 3 passes per linked campaign, one request at a
        // time (see SYNC_PAGE_LIMIT/SYNC_MAX_PAGES in lib/outreach.mjs) — a
        // real sync can take a while, and a click with no visible reaction
        // for that long reads as broken. This says so up front.
        const loading = toast('Syncing every linked campaign — this can take a moment…', 'loading');
        try {
            const result = await api.post('/api/integrations/smartlead/sync', {});
            const rows = result.campaigns ?? [];
            const failed = rows.filter((r) => r.ok === false);
            loading?.remove?.();
            if (!rows.length) {
                toast('Sync ran, but no campaigns are linked yet.', 'warning');
            } else if (failed.length) {
                toast(`Sync done — ${rows.length - failed.length} of ${rows.length} succeeded, ${failed.length} failed.`, 'warning');
            } else {
                toast(`Sync done — ${rows.length} campaign(s) checked.`, 'success');
            }
        } catch (err) {
            loading?.remove?.();
            toast(err.message, 'error');
        }
        if (button) button.disabled = false;
        await load();
    }

    async function importLeads(campaign, button) {
        if (button) button.disabled = true;
        const loading = toast(`Importing leads for ${campaign.name}…`, 'loading');
        try {
            const result = await api.post('/api/integrations/smartlead/import-leads', { campaignId: campaign.id });
            loading?.remove?.();
            const parts = [];
            if (result.contactsCreated) parts.push(`${result.contactsCreated} new contact(s)`);
            if (result.membersAdded) parts.push(`${result.membersAdded} added to the campaign`);
            if (result.alreadyMembers) parts.push(`${result.alreadyMembers} already there`);
            toast(result.membersAdded ? `Imported — ${parts.join(', ')}.` : 'Nothing new to import — every lead is already a CRM contact.', 'success');
        } catch (err) {
            loading?.remove?.();
            toast(err.message, 'error');
        }
        if (button) button.disabled = false;
        await load();
    }

    function healthCard() {
        if (!status?.configured) {
            return h('div.card', h('div.card-body',
                emptyState('Smartlead is not connected',
                    'Add an API key in Settings → Integrations → Smartlead to start linking campaigns.'),
                h('div.row', { style: { justifyContent: 'center', marginBlockStart: 'var(--space-3)' } },
                    h('a.btn.primary', { href: '/settings?tab=integrations' }, 'Go to Settings')),
            ));
        }
        const failed = status.events?.failed ?? 0;
        return h('div.card',
            h('div.card-header',
                h('h2', embedded ? 'Smartlead — integration health' : 'Integration health'),
                h('div.actions', h('button.btn.sm', { onclick: syncAll }, 'Sync all now')),
            ),
            h('div.card-body',
                h('div.stat-grid',
                    statTile('Campaigns linked', number(status.campaignsLinked ?? 0)),
                    statTile('Webhook events', number(status.events?.total ?? 0)),
                    statTile('Processed', number(status.events?.processed ?? 0)),
                    statTile('Failed', number(failed), null, { tone: failed ? 'danger' : '' }),
                ),
                h('p.xs.dim', { style: { marginBlockStart: 'var(--space-2)' } },
                    status.lastSyncAt
                        ? `Last sync ${relative(status.lastSyncAt)}.`
                        : 'No sync has run yet — the background sweep runs every 15 minutes, or press Sync all now.',
                    status.events?.lastWebhookAt ? ` Last webhook ${relative(status.events.lastWebhookAt)}.` : ''),
            ),
            failed > 0 && h('div.card-body.flush', { style: { borderBlockStart: '1px solid var(--color-border-subtle)' } },
                h('div.table-wrap', h('table.data',
                    h('thead', h('tr', h('th', 'When'), h('th', 'Event'), h('th', 'Error'), h('th', ''))),
                    h('tbody', status.recentErrors.map((ev) => h('tr',
                        h('td.xs', date(ev.received_at, { withTime: true })),
                        h('td', h('code.xs', ev.event_type ?? '—')),
                        h('td.xs.dim', (ev.error_message ?? '').slice(0, 120)),
                        h('td.num', h('button.btn.sm', {
                            onclick: async () => {
                                try {
                                    const result = await api.post(`/api/integrations/smartlead/events/${ev.id}/retry`, {});
                                    toast(result.ok ? 'Replayed.' : (result.reason ?? 'Still failing.'), result.ok ? 'success' : 'error');
                                } catch (err) { toast(err.message, 'error'); }
                                load();
                            },
                        }, 'Retry')),
                    ))),
                )),
            ),
        );
    }

    function campaignsCard() {
        if (!status?.configured) return null;
        const rows = overview?.campaigns ?? [];
        return h('div.card',
            h('div.card-header',
                h('h2', 'Linked campaigns'),
                h('div.actions', store.can('record.write.all') && h('button.btn.sm.primary', { onclick: () => linkCampaignDialog().then((ok) => ok && load()) }, '+ Link a campaign')),
            ),
            h('div.card-body.flush',
                rows.length === 0
                    ? emptyState('No campaigns linked yet',
                        'Link a CRM campaign to a Smartlead one to start tracking replies.')
                    : h('div.table-wrap', h('table.data',
                        h('thead', h('tr',
                            h('th', 'Campaign'), h('th', 'Smartlead ID'), h('th', 'Status'),
                            h('th.num', 'Mapped'), h('th.num', 'Sent'), h('th.num', 'Replies'),
                            h('th.num', 'Bounces'), h('th.num', 'Interested'), h('th', 'Last activity'), h('th', ''),
                        )),
                        h('tbody', rows.map((c) => [
                            h('tr',
                                h('td', h('a', { href: `/campaigns/${c.id}` }, c.name)),
                                h('td.xs.dim', `#${c.externalId}`),
                                h('td', h('span.badge', c.status)),
                                h('td.num', number(c.mapped)),
                                h('td.num', number(c.totalSent)),
                                h('td.num', c.totalReplies > 0 ? h('span.strong', number(c.totalReplies)) : '0',
                                    c.replyRate !== null && h('span.xs.dim', ` (${c.replyRate}%)`)),
                                h('td.num', c.totalBounces > 0 ? h('span.badge.warning', number(c.totalBounces)) : '0'),
                                h('td.num', number(c.totalInterested)),
                                h('td.xs.dim', c.lastActivityAt ? relative(c.lastActivityAt) : '—'),
                                h('td.num', h('div.row', { style: { justifyContent: 'flex-end', gap: 'var(--space-1)' } },
                                    h('button.btn.sm.ghost', {
                                        onclick: async (e) => {
                                            e.currentTarget.disabled = true;
                                            try {
                                                await api.post('/api/integrations/smartlead/sync', { campaignId: c.id });
                                                toast('Synced.', 'success');
                                            } catch (err) { toast(err.message, 'error'); }
                                            load();
                                        },
                                    }, 'Sync'),
                                )),
                            ),
                            // Zero-mapped reads as "broken" if left unexplained — it
                            // almost always means leads exist in Smartlead that have
                            // no matching CRM contact yet, which sync (by design)
                            // will not silently invent. Import does that on purpose,
                            // once, on request. See importLeadsFromSmartlead's own
                            // doc comment in lib/outreach.mjs.
                            c.mapped === 0 && h('tr',
                                h('td', { colspan: 10 }, h('div.note-box', { style: { margin: 0 } },
                                    h('p.xs', 'No CRM contacts are attached to this campaign yet, so sent/reply/bounce counts read as zero even if Smartlead shows real activity. ',
                                        h('button.btn.sm', { onclick: (e) => importLeads(c, e.currentTarget) }, 'Import leads from Smartlead')),
                                ))),
                        ])),
                    )),
            ),
        );
    }

    function paint() {
        mount(host,
            !embedded && h('div.row', { style: { marginBlockEnd: 'var(--space-3)' } },
                h('div', h('h1', 'Smartlead'), h('p.small.dim', 'Outreach campaigns, mapped from the CRM. Sequences run in Smartlead; replies, bounces and sends flow back here.')),
            ),
            error ? errorState(error, load) : null,
            !error && healthCard(),
            !error && campaignsCard(),
        );
    }

    load();
    return { reload: load, linkCampaign: () => linkCampaignDialog().then((ok) => { if (ok) load(); return ok; }) };
}

export async function smartleadPage(content) {
    setPageTitle('Smartlead');
    const container = h('div.content-inner');
    mount(content, container);
    renderSmartleadPanel(container, { embedded: false });
}
