/**
 * Outreach helpers — the browser half of the Smartlead integration.
 *
 * Enrollment, field mapping and the compact outreach card that lives on a
 * contact record. Nothing here names a vendor endpoint — the server is the
 * integration.
 */
import { h, toast, modal, drawer, confirm, date, humanise } from './core.js';
import { api } from './api.js';
import * as store from './store.js';

const CRM_FIELDS = [
    ['first_name', 'First name'], ['last_name', 'Last name'],
    ['email', 'Email'], ['phone', 'Phone'], ['title', 'Job title'],
    ['linkedin_url', 'LinkedIn URL'], ['account_name', 'Account name'],
];

/** How one review row's classification reads, before anything is sent. */
function outcomeBadge(r) {
    if (r.result === 'pending') return h('span.badge.success', 'Will be added');
    if (r.result === 'already_member') {
        const status = r.existingMembership?.outreachStatus;
        return h('span.badge.info', `Already there${status ? ` — ${humanise(status)}` : ''}`);
    }
    return h('span.badge.warning', { title: r.reason ?? '' }, r.reason ? r.reason.slice(0, 60) : 'Held back');
}

function linkedCampaigns() {
    return (store.state.meta?.campaigns ?? []).filter((c) => c.external_id);
}

function smartleadFieldKeys() {
    // Smartlead's standard fields that accept CRM values directly. Everything
    // else travels as custom_fields — the wizard lets users add to that bag
    // without this list changing.
    return [
        'company_name', 'phone_number', 'website', 'location', 'linkedin_profile', 'company_url',
    ];
}

/**
 * Totally generic mapping UI — standard fields as selects, custom fields as a
 * bag of Smartlead-key → CRM-field rows the user can grow. Returns a mapping
 * the server's outreach.mapToLead understands, or undefined when cancelled.
 */
async function pickMapping(initial = {}) {
    const mapping = {
        company_name: initial.company_name ?? 'account_name',
        custom: { ...(initial.custom ?? {}) },
    };

    let customRows = Object.entries(mapping.custom);
    const startedWith = JSON.stringify(mapping);

    const body = h('div.stack');

    const repaint = () => {
        const companySelect = h('select.input', {
            onchange: (e) => { mapping.company_name = e.target.value || null; },
        }, h('option', { value: '' }, '— do not send —'),
        ...CRM_FIELDS.map(([v, l]) => h('option', { value: v, selected: v === mapping.company_name }, l)),
        // Custom fields the workspace already has show up here too, as free-form
        ...((store.fields('contact') ?? []).filter((f) => f.custom).map((f) => h('option', {
            value: `properties.${f.key}`, selected: `properties.${f.key}` === mapping.company_name,
        }, `${f.label} (custom)`))));

        const rows = h('div.stack.tight',
            ...customRows.map(([k, v], index) => h('div.row', { style: { gap: 'var(--space-2)' } },
                h('input.input', {
                    placeholder: 'Smartlead field, e.g. job_title',
                    value: k,
                    oninput: (e) => {
                        const next = e.target.value.trim();
                        const old = customRows[index][0];
                        customRows[index][0] = next;
                        if (!next) delete mapping.custom[old];
                        else { if (old !== next) delete mapping.custom[old]; mapping.custom[next] = v; }
                    },
                }),
                h('select.input', {
                    onchange: (e) => { customRows[index][1] = e.target.value; mapping.custom[k] = e.target.value; },
                }, CRM_FIELDS.map(([fv, fl]) => h('option', { value: fv, selected: fv === v }, fl))),
                h('button.btn.sm.ghost', {
                    onclick: () => { delete mapping.custom[k]; customRows.splice(index, 1); repaint(); },
                }, 'Remove'),
            )),
            h('button.btn.sm', {
                onclick: () => { customRows.push(['', 'title']); repaint(); },
            }, '+ Add custom field'),
        );

        mount(body, h('div.stack',
            h('div.note-box',
                h('div.strong.small', 'How names travel'),
                h('p.xs', 'Email, first and last name are always sent. Company and whatever you add as custom fields '
                    + 'are mapped here. A blank Smartlead field name is ignored.')),
            h('div.field', h('label', 'Company name ←'), companySelect,
                h('span.help', 'Written into Smartlead\'s company_name.')),
            h('div.field', h('label', 'Custom fields (Smartlead key → CRM field)'), rows),
        ));
    };

    function mount(parent, child) {
        while (parent.firstChild) parent.removeChild(parent.firstChild);
        parent.appendChild(child);
    }

    repaint();

    const result = await modal({
        title: 'Field mapping → Smartlead',
        size: 'wide',
        body,
        footer: (close) => [
            h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
            h('button.btn.primary', { onclick: () => close(mapping) }, 'Use this mapping'),
        ],
        // Escape, the backdrop or ✕ used to throw the whole mapping away with
        // no warning. Only ask once there is something to lose.
        closeGuard: () => {
            if (JSON.stringify(mapping) === startedWith) return true;
            return confirm({
                title: 'Discard this mapping?',
                message: 'The field mapping you set up has not been used yet. Closing now loses it.',
                confirmLabel: 'Discard',
                danger: true,
            });
        },
    });
    return result;
}

/**
 * Open the campaign picker → mapping → preview → enqueue flow.
 *
 * `selectionPayload` is either {ids:[…]} or {all:true,filter,listId,q} — the
 * same contract Verify emails and every other bulk write already speaks, so
 * the list page passes straight through.
 */
export async function enrollWizard(selectionPayload, { defaultCampaignId = null } = {}) {
    // The cached meta.campaigns list is only as fresh as this session's last
    // refresh — a campaign linked in another tab, or earlier today, would
    // otherwise read as unlinked here and refuse every enrollment with a
    // false "link a campaign first". See refreshCampaigns' own doc comment
    // in store.js; smartlead.js already does this before its own check.
    await store.refreshCampaigns().catch(() => {});
    const linked = linkedCampaigns();
    if (!linked.length) {
        toast('No CRM campaign is linked to Smartlead. Open a campaign → link it first.', 'error');
        return null;
    }

    const initialChosen = defaultCampaignId ?? linked[0].id;
    let chosen = initialChosen;
    let mapping = store.state.meta?.settings?.smartlead_field_mapping ?? null;
    try { if (typeof mapping === 'string') mapping = JSON.parse(mapping); } catch { mapping = null; }
    const startedWithMapping = JSON.stringify(mapping);

    const body = h('div.stack');
    const repaint = () => {
        body.replaceChildren(
            h('div.field', h('label', 'Campaign'),
                h('select.input', {
                    onchange: (e) => { chosen = e.target.value; },
                }, linked.map((c) => h('option', { value: c.id, selected: c.id === chosen },
                    `${c.name}  →  Smartlead #${c.external_id}`)))),
            h('div.row',
                h('button.btn.sm', {
                    onclick: async () => {
                        const next = await pickMapping(mapping ?? {});
                        if (next) { mapping = next; repaint(); }
                    },
                }, 'Field mapping…'),
                mapping
                    ? h('span.xs.dim', `${Object.keys(mapping.custom ?? {}).length} custom field(s) + company`)
                    : h('span.xs.dim', 'Using defaults (company name only)'),
            ),
            h('p.xs.dim', 'Duplicates already in that campaign are reported, not re-added. Blocked or bounced addresses are held back with the reason shown.'),
        );
    };
    repaint();

    const confirmed = await drawer({
        title: 'Add to Smartlead',
        body,
        footer: (close) => [
            h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
            h('button.btn.primary', { onclick: () => close({ campaignId: chosen, mapping }) }, 'Review →'),
        ],
        // Escape, the backdrop or ✕ used to throw away the campaign choice and
        // any field mapping set up in this drawer with no warning at all.
        closeGuard: () => {
            if (chosen === initialChosen && JSON.stringify(mapping) === startedWithMapping) return true;
            return confirm({
                title: 'Discard this enrollment setup?',
                message: 'The campaign and field mapping you chose have not been added yet. Closing now loses them.',
                confirmLabel: 'Discard',
                danger: true,
            });
        },
    });
    if (!confirmed) return null;

    /**
     * THE REVIEW STEP — a dry run against the real classification (already a
     * member, held back by policy or suppression, duplicate in this batch)
     * with nothing pushed to Smartlead yet. Nobody sees a batch vanish into
     * an API call with no chance to notice "wait, half of these bounced
     * last month" first.
     */
    const checking = toast('Checking…', 'loading');
    let preview;
    try {
        preview = await api.post('/api/integrations/smartlead/enroll', {
            campaignId: confirmed.campaignId, mapping: confirmed.mapping, dryRun: true, ...selectionPayload,
        });
    } catch (err) {
        checking?.remove?.();
        toast(err.message, 'error');
        return null;
    }
    checking?.remove?.();

    const willEnroll = preview.results.filter((r) => r.result === 'pending');
    const proceed = await modal({
        title: `Review — ${preview.results.length} contact(s)`,
        size: 'wide',
        body: h('div.stack',
            h('div.row', { style: { gap: 'var(--space-4)' } },
                h('div', h('div.xs.dim', 'Will be added'), h('div.strong', String(willEnroll.length))),
                preview.summary.already_member ? h('div', h('div.xs.dim', 'Already there'), h('div.strong', String(preview.summary.already_member))) : null,
                preview.summary.skipped ? h('div', h('div.xs.dim', 'Held back'), h('div.strong', String(preview.summary.skipped))) : null,
            ),
            h('div.table-wrap', { style: { maxBlockSize: '24rem', overflowY: 'auto' } }, h('table.data',
                h('thead', h('tr', h('th', 'Contact'), h('th', 'Company'), h('th', 'Email'), h('th', 'Verification'), h('th', 'Outcome'))),
                h('tbody', preview.results.slice(0, 200).map((r) => h('tr',
                    h('td', r.name),
                    h('td.xs.dim', r.company ?? '—'),
                    h('td.xs', r.email ?? '—'),
                    h('td', r.verificationStatus
                        ? h('span.badge', { class: r.verificationStatus === 'valid' ? 'success' : 'warning' }, humanise(r.verificationStatus))
                        : h('span.xs.dim', 'unverified')),
                    h('td', outcomeBadge(r)),
                ))),
            )),
            preview.results.length > 200 && h('p.xs.dim', `…and ${preview.results.length - 200} more.`),
        ),
        footer: (close) => [
            h('button.btn', { onclick: () => close(false) }, 'Cancel'),
            h('button.btn.primary', {
                disabled: willEnroll.length === 0,
                onclick: () => close(true),
            }, willEnroll.length ? `Add ${willEnroll.length} contact(s) →` : 'Nothing to add'),
        ],
    });
    if (!proceed) return null;

    const loading = toast('Adding to Smartlead…', 'loading');
    try {
        const result = await api.post('/api/integrations/smartlead/enroll', {
            campaignId: confirmed.campaignId, mapping: confirmed.mapping, ...selectionPayload,
        });
        loading?.remove?.();
        const s = result.summary ?? {};
        const parts = [];
        if (s.enrolled) parts.push(`${s.enrolled} enrolled`);
        if (s.already_member) parts.push(`${s.already_member} already there`);
        if (s.skipped) parts.push(`${s.skipped} held back`);
        if (s.failed) parts.push(`${s.failed} failed`);
        toast(parts.join(' · ') || 'Done.', s.failed ? 'warning' : 'success');

        // Failures and holds are actionable — show the reasons rather than
        // leaving them as a count the user has to guess about.
        const held = result.results.filter((r) => r.result === 'skipped' || r.result === 'failed');
        if (held.length) {
            await modal({
                title: `${held.length} not enrolled`,
                size: 'wide',
                body: h('div.stack.tight',
                    ...held.slice(0, 50).map((r) => h('div.row.between',
                        h('span.small', r.name, h('span.dim', ` · ${r.email}`)),
                        h('span.badge.warning', (r.reason ?? r.result).slice(0, 100)))),
                    held.length > 50 && h('p.xs.dim', `…and ${held.length - 50} more.`),
                ),
                footer: (close) => [
                    h('button.btn.primary', { onclick: () => close(true) }, 'OK'),
                ],
            });
        }

        /**
         * The obvious next action, offered rather than implied: the campaign
         * these people just joined is where their replies will land. One
         * click, and the loop closes at the place that watches it.
         */
        const { confirm } = await import('./core.js');
        const go = await modal({
            title: 'Enrollment complete',
            size: 'narrow',
            body: h('div.stack',
                h('p.small', `${s.enrolled ?? 0} contact(s) were pushed to Smartlead.`),
                h('p.xs.dim', 'Sequence events will flow back automatically — first sent, opens, replies and bounces appear on each contact and in the campaign.'),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(false) }, 'Stay here'),
                h('button.btn.primary', { onclick: () => close(true) }, 'View campaign →'),
            ],
        });
        if (go && confirmed?.campaignId) {
            const { navigate } = await import('./core.js');
            navigate(`/campaigns/${confirmed.campaignId}`);
        }
        return result;
    } catch (error) {
        loading?.remove?.();
        toast(error.message, 'error');
        return null;
    }
}

/**
 * The compact outreach card drawn on a contact record.
 *
 * Fetched from GET /api/contacts/:id/outreach via .../related's outreach
 * companion — `extras.outreach` when that exists, otherwise this helper fetches
 * on live render. The card stays compact: campaign, status, sequence, dates,
 * counters. Open/click are honest counters, not a timeline full of pixels.
 */
export function outreachCard(memberships, { onSync = null } = {}) {
    if (!memberships?.length) return null;

    const tone = { enrolled: '', sending: 'info', replied: 'success', bounced: 'danger', unsubscribed: 'danger', paused: 'warning', completed: '', stopped: 'warning' };

    return h('div.card',
        h('div.card-header',
            h('h3', 'Outreach'),
            h('div.actions', onSync && h('button.btn.sm', { onclick: onSync }, 'Sync')),
        ),
        h('div.card-body', h('div.stack.tight',
            memberships.map((m) => h('div.stack.tight', { style: { borderBlockEnd: '1px solid var(--border)', paddingBlockEnd: 'var(--space-2)' } },
                h('div.row',
                    h('a.small.strong', { href: `/campaigns/${m.campaign_id}` }, m.campaign_name),
                    h('div.spacer'),
                    m.outreach_status && h('span.badge', { class: tone[m.outreach_status] ?? '' }, humanise(m.outreach_status)),
                    h('span.badge', humanise(m.status)),
                ),
                h('div.row', { style: { gap: 'var(--space-3)', flexWrap: 'wrap' } },
                    m.current_sequence != null && h('span.xs.dim', `Step ${m.current_sequence}`),
                    m.first_sent_at && h('span.xs.dim', { title: date(m.first_sent_at, { withTime: true }) }, `First ${date(m.first_sent_at)}`),
                    m.last_sent_at && h('span.xs.dim', { title: date(m.last_sent_at, { withTime: true }) }, `Last ${date(m.last_sent_at)}`),
                    m.last_event_type && h('span.xs.dim', `Last: ${m.last_event_type}`),
                ),
                h('div.row', { style: { gap: 'var(--space-3)' } },
                    h('span.xs.dim', `${m.total_emails_sent ?? 0} sent`),
                    m.total_replies ? h('span.xs', { style: { color: 'var(--success)' } }, `${m.total_replies} repl${m.total_replies === 1 ? 'y' : 'ies'}`) : null,
                    m.bounced_at && h('span.badge.danger', `bounced ${date(m.bounced_at)}`),
                    m.unsubscribed_at && h('span.badge.danger', `unsubscribed ${date(m.unsubscribed_at)}`),
                    m.lead_category && h('span.badge.info', humanise(m.lead_category)),
                ),
            )),
        )),
    );
}

/**
 * The campaign page's Smartlead panel — link/unlink, webhook, health.
 * Mounted inside the Members tab when the viewer is a campaign, and hidden
 * for other object types by the caller.
 */
export function campaignOutreachPanel(campaign, { onChanged = null } = {}) {
    const linked = Boolean(campaign.external_id);
    const host = h('div');

    const load = async () => {
        const smartleadCampaigns = await api.get('/api/integrations/smartlead/campaigns')
            .then((r) => r.campaigns ?? [])
            .catch(() => []);
        const health = await api.get('/api/integrations/smartlead/status')
            .then((r) => r)
            .catch(() => null);

        const linkForThis = health?.campaigns?.find((c) => c.id === campaign.id) ?? null;

        host.replaceChildren(
            h('div.card',
                h('div.card-header',
                    h('h3', 'Smartlead'),
                    h('div.actions',
                        linked
                            ? h('span.badge.success', `Linked — #${campaign.external_id}`)
                            : h('span.badge.warning', 'Not linked'),
                    ),
                ),
                h('div.card-body', h('div.stack',
                    !linked
                        ? h('div.stack.tight',
                            h('p.small', 'Link this CRM campaign to a Smartlead campaign. Contacts you enroll here will be pushed to that Smartlead campaign.'),
                            h('div.row',
                                h('select.input', { id: 'sl-campaign-picker' },
                                    smartleadCampaigns.length
                                        ? smartleadCampaigns.map((sc) => h('option', {
                                            value: String(sc.id ?? sc.campaign_id ?? ''),
                                        }, `${sc.name ?? sc.campaign_name ?? `Campaign #${sc.id}`} (#${sc.id ?? sc.campaign_id})`))
                                        : [h('option', { disabled: true }, 'No Smartlead campaigns found — check the API key in Settings.')]),
                                h('button.btn.primary', {
                                    onclick: async (e) => {
                                        const sel = document.getElementById('sl-campaign-picker');
                                        const smartleadId = sel?.value;
                                        const opt = sel?.selectedOptions?.[0];
                                        const name = opt?.textContent?.split(' (#')[0] ?? '';
                                        if (!smartleadId) return toast('Pick a Smartlead campaign.', 'error');
                                        e.currentTarget.disabled = true;
                                        try {
                                            await api.post('/api/integrations/smartlead/link', {
                                                campaignId: campaign.id, smartleadCampaignId: smartleadId, smartleadCampaignName: name,
                                            });
                                            toast('Campaign linked.', 'success');
                                            onChanged?.();
                                        } catch (err) { toast(err.message, 'error'); e.currentTarget.disabled = false; }
                                    },
                                }, 'Link'),
                            ),
                        )
                        : h('div.stack.tight',
                            h('div.row',
                                h('button.btn', {
                                    onclick: async (e) => {
                                        e.currentTarget.disabled = true;
                                        try {
                                            await api.post('/api/integrations/smartlead/webhook', { campaignId: campaign.id });
                                            toast('Webhook registered in Smartlead.', 'success');
                                            load();
                                        } catch (err) { toast(err.message, 'error'); e.currentTarget.disabled = false; }
                                    },
                                }, 'Register webhook'),
                                h('button.btn', {
                                    onclick: async (e) => {
                                        e.currentTarget.disabled = true;
                                        try {
                                            await api.post('/api/integrations/smartlead/sync', { campaignId: campaign.id });
                                            toast('Sync done.', 'success');
                                            load();
                                            onChanged?.();
                                        } catch (err) { toast(err.message, 'error'); e.currentTarget.disabled = false; }
                                    },
                                }, 'Sync now'),
                                h('button.btn.ghost.danger', {
                                    onclick: async () => {
                                        if (!await confirm({ title: 'Unlink this campaign?', message: 'Contacts already enrolled keep their outreach history; future enrollments stop.', confirmLabel: 'Unlink', danger: true })) return;
                                        await api.post('/api/integrations/smartlead/unlink', { campaignId: campaign.id });
                                        toast('Campaign unlinked.', 'success');
                                        onChanged?.();
                                    },
                                }, 'Unlink'),
                            ),
                            health?.lastSyncAt && h('p.xs.dim', `Last sync ${date(health.lastSyncAt, { withTime: true })}`),
                        ),
                )),
            ),
        );
    };
    load().catch(() => host.replaceChildren(h('p.xs.dim', 'Could not reach Smartlead — check the API key in Settings.')));
    return host;
}
