/**
 * Settings: workspace, people, custom fields, activity types, timeline
 * projections and the account menu.
 *
 * Everything here is CONFIGURATION rather than code — which is the claim the
 * whole platform makes, so this is the page where the claim is either true or
 * visibly false.
 */
import { h, mount, navigate, toast, modal, confirm, setTheme, setDensity, humanise, date } from '../core.js';
import { api } from '../api.js';
import * as store from '../store.js';
import { emptyState, skeletonRows, errorState, icon } from '../components.js';
import { setPageTitle } from '../app.js';

export async function settingsPage(content) {
    setPageTitle('Settings');
    const container = h('div');
    mount(content, container);

    // Fetched separately from meta: templates are a Settings-only concern, and
    // putting them in the payload every page load pays for them everywhere.
    let templates = null;
    async function loadTemplates() {
        templates = await api.get('/api/document-templates')
            .then((r) => r.templates)
            .catch(() => []);
    }

    async function reload() {
        await Promise.all([store.loadMeta(), loadTemplates()]);
        paint();
    }

    let draftBounceBanKey = null;
    let draftVerificationProvider = null;
    let draftCampaignPolicy = null;
    let activeSection = 'general';

    /**
     * The sections, and the cards in each.
     *
     * Settings used to be one long scroll of a dozen unrelated cards — account
     * preferences beside document templates beside revenue targets. Grouped
     * into tabs by the question being asked, so an admin lands on "who is on
     * the team" or "how we price" without scrolling past everything else.
     */
    const SECTIONS = [
        { key: 'general', label: 'General', icon: 'settings', description: 'Your account, appearance, workspace defaults and the audit timeline.' },
        { key: 'revenue', label: 'Revenue', icon: 'chart', description: 'Currency conversion rates and per-service revenue targets.' },
        { key: 'scoring', label: 'Lead scoring', icon: 'qualification', description: 'How an account’s fit and intent are weighted into one score.' },
        { key: 'integrations', label: 'Integrations', icon: 'plug', description: 'Email verification, outreach and people-search providers.' },
        { key: 'people', label: 'People', icon: 'people', description: 'Everyone with a login to this workspace, and their role.' },
        { key: 'documents', label: 'Documents', icon: 'proposal', description: 'The .docx templates proposals and agreements are generated from.' },
        { key: 'email', label: 'Email templates', icon: 'mail', description: 'Proposal, agreement and agreement-signed business emails, and who they notify.' },
        { key: 'data', label: 'Data', icon: 'table', description: 'Custom fields, activity types, and workspace maintenance.' },
    ];

    function paint() {
        const meta = store.state.meta;
        if (draftBounceBanKey === null) draftBounceBanKey = meta.settings.bounceban_api_key ?? '';

        // Keep the active section valid for this viewer's permissions.
        if (activeSection === 'revenue' && !store.can('finance.read')) activeSection = 'general';
        if (activeSection === 'scoring' && !store.can('record.write.all')) activeSection = 'general';

        /**
         * Built lazily, one section at a time.
         *
         * Several of these card factories fetch on the spot when called
         * (service targets, the scoring model) rather than on mount — fine
         * when there was one flat page to build once, but this function
         * builds whichever section is ACTIVE on every repaint, and a nav
         * rail invites clicking between sections far more than a single
         * scroll ever did. Building all seven arrays regardless of which
         * one is showing meant every click anywhere in Settings re-fetched
         * revenue targets and the scoring model along with it.
         */
        function cardsFor(section) {
            switch (section) {
                case 'general': return [youCard(meta), appearanceCard(), workspaceCard(meta), timelineCard(meta), maintenanceCard()];
                case 'revenue': return store.can('finance.read') ? [reportingRatesCard(meta), serviceTargetsCard(), renewalSettingsCard(meta)] : [];
                case 'scoring': return store.can('record.write.all') ? [scoringCard()] : [];
                case 'integrations': return [integrationsCard(meta)];
                case 'people': return [peopleCard(meta)];
                case 'documents': return [templatesCard()];
                case 'email': return [smtpCard(meta), emailRecipientsCard(meta), emailTemplatesCard()];
                case 'data': return [customFieldsCard(meta), activityTypesCard(meta)];
                default: return [];
            }
        }

        const current = SECTIONS.find((s) => s.key === activeSection) ?? SECTIONS[0];

        mount(container,
            h('div.settings-shell',
                h('nav.settings-nav',
                    h('div.settings-nav-head', h('h1', 'Settings'), h('p', 'Workspace configuration.')),
                    visibleSections(SECTIONS).map((s) => h('button.settings-nav-item', {
                        class: s.key === activeSection ? 'active' : '',
                        onclick: () => { activeSection = s.key; paint(); },
                        'aria-current': s.key === activeSection ? 'page' : undefined,
                    }, icon(s.icon), h('span.settings-nav-label', s.label))),
                ),
                h('div.settings-content',
                    h('div.settings-content-head', h('h2', current.label), h('p', current.description)),
                    h('div.stack',
                        cardsFor(activeSection).filter(Boolean),
                    ),
                ),
            ),
        );
    }

    /** Same visibility rule the section switch above already enforces, applied to what the nav offers. */
    function visibleSections(sections) {
        return sections.filter((s) => {
            if (s.key === 'revenue') return store.can('finance.read');
            if (s.key === 'scoring') return store.can('record.write.all');
            return true;
        });
    }

    function youCard(meta) {
        const initials = (meta.user.name || meta.user.email || '?')
            .split(' ').filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
        return h('div.card',
            h('div.card-body',
                h('div.row', { style: { gap: 'var(--space-4)', alignItems: 'center' } },
                    h('span.avatar.lg', initials),
                    h('div',
                        h('div.strong', { style: { fontSize: 'var(--text-lg)' } }, meta.user.name),
                        h('div.small.dim', meta.user.email),
                    ),
                    h('div.spacer'),
                    h('span.badge.accent', meta.role),
                ),
                h('div.row', { style: { marginBlockStart: 'var(--space-4)', gap: 'var(--space-2)' } },
                    h('span.xs.dim', `Workspace: ${meta.workspace.name}`),
                ),
                h('div.row', { style: { marginBlockStart: 'var(--space-4)' } },
                    h('button.btn', {
                        onclick: () => changePassword(),
                    }, 'Change password'),
                    h('button.btn', {
                        onclick: async () => {
                            await api.post('/api/auth/logout', {});
                            location.href = '/login';
                        },
                    }, 'Sign out'),
                ),
            ),
        );
    }

    function appearanceCard() {
        return h('div.card',
            h('div.card-header', h('h2', 'Appearance')),
            h('div.card-body',
                h('div.field',
                    h('label', 'Theme'),
                    h('div.row',
                        ['system', 'light', 'dark'].map((t) => h('button.btn.sm', {
                            class: (localStorage.getItem('crm-theme') ?? 'system') === t ? 'primary' : '',
                            onclick: () => { setTheme(t); paint(); },
                        }, humanise(t))),
                    ),
                ),
                h('div.field',
                    h('label', 'Table density'),
                    h('div.row',
                        [['comfortable', 'Comfortable'], ['compact', 'Compact']].map(([value, label]) => h('button.btn.sm', {
                            class: (localStorage.getItem('crm-density') ?? 'comfortable') === value ? 'primary' : '',
                            onclick: () => { setDensity(value); paint(); },
                        }, label)),
                    ),
                    h('span.help', 'Compact fits roughly 80% more rows on a screen. '
                        + 'It changes spacing and type size only — no column is hidden and nothing wraps differently.'),
                ),
            ),
        );
    }

    function workspaceCard(meta) {
        const currencyStatus = h('span.xs.dim');
        const currencySelect = h('select.input', { style: { inlineSize: 'auto' } },
            store.currencies().map((c) => h('option', { value: c, selected: c === meta.workspace.baseCurrency }, c)));

        const saveCurrency = async () => {
            currencyStatus.textContent = 'Saving…';
            try {
                await api.patch('/api/settings', { base_currency: currencySelect.value });
                meta.workspace.baseCurrency = currencySelect.value;
                currencyStatus.textContent = 'Saved — new accounts and deals will fall back to this from now on.';
            } catch (err) {
                currencyStatus.textContent = err.message;
            }
        };

        return h('div.card',
            h('div.card-header', h('h2', 'Workspace')),
            h('div.card-body',
                h('dl.detail-list',
                    h('dt', 'Base currency'), h('dd',
                        h('div.row', { style: { gap: 'var(--space-2)', alignItems: 'center' } },
                            currencySelect,
                            h('button.btn.sm', { onclick: saveCurrency }, 'Save'),
                            currencyStatus,
                        )),
                    h('dt', 'Timezone'), h('dd', meta.workspace.timezone),
                    h('dt', 'Weekend'), h('dd', meta.workspace.weekendDays.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(' & ')),
                    h('dt', 'Verdict freshness'), h('dd', `${meta.workspace.verdictStaleDays} days`),
                ),
                h('p.xs.dim', { style: { marginBlockStart: 'var(--space-3)' } },
                    'The currency a new account or deal falls back to when nothing more specific — an account’s own '
                    + 'billing currency, an explicit choice — says otherwise. Does not change any existing record; '
                    + 'those keep whatever currency they were created with.'),
                h('p.xs.dim', { style: { marginBlockStart: 'var(--space-2)' } },
                    'Automation-generated due dates skip the weekend shown here. "Due in 3 working days" is wrong for '
                    + 'this market if it assumes Saturday and Sunday.'),
            ),
        );
    }

    function timelineCard(meta) {
        return h('div.card',
            h('div.card-header', h('h2', 'Timeline')),
            h('div.card-body',
                h('p.small.muted',
                    'Every change writes an audit event. Only the events selected here also appear on the human '
                    + 'timeline — without that filter you get a timeline nobody reads, drowned in field-level diffs.'),
                h('div.stack.tight', { style: { marginBlockStart: 'var(--space-3)' } },
                    PROJECTABLE.map(([key, label]) => h('label.checkbox',
                        h('input', {
                            type: 'checkbox',
                            checked: meta.settings.timeline_projections.includes(key),
                            disabled: !store.can('record.write.all'),
                            onchange: async (e) => {
                                const next = new Set(meta.settings.timeline_projections);
                                if (e.target.checked) next.add(key);
                                else next.delete(key);
                                await api.patch('/api/settings', { timeline_projections: [...next] });
                                toast('Saved.', 'success');
                                reload();
                            },
                        }),
                        h('span', label),
                    )),
                ),
            ),
        );
    }

    function maintenanceCard() {
        return h('div.card',
            h('div.card-header', h('h2', 'Maintenance')),
            h('div.card-body', h('div.stack.tight',
                h('div.row.between',
                    h('div',
                        h('div.small.strong', 'Rebuild the search index'),
                        h('div.xs.dim', 'Needed after a bulk import, or after marking a field searchable.'),
                    ),
                    h('button.btn.sm', {
                        onclick: async (e) => {
                            const button = e.currentTarget;
                            button.disabled = true;
                            const result = await api.post('/api/search/reindex', {});
                            toast(`Indexed ${result.indexed} records.`, 'success');
                            button.disabled = false;
                        },
                    }, 'Rebuild'),
                ),
                h('div.row.between',
                    h('div',
                        h('div.small.strong', 'Qualification engine'),
                        h('div.xs.dim', 'The rules are read from the local-scraper project, never copied, so the CRM and '
                            + 'the command line can never disagree.'),
                    ),
                    h('a.btn.sm', { href: '/qualification' }, 'Open'),
                ),
            )),
        );
    }

    function integrationsCard(meta) {
        return h('div.stack',
            verificationIntegrationsCard(meta),
            smartleadCard(meta),
            peopleSearchCard(meta),
            apiKeysCard(),
        );
    }

    function verificationIntegrationsCard(meta) {
        return h('div.card',
            h('div.card-header', h('h2', 'Email verification')),
            h('div.card-body',
                h('div.field',
                    h('label', 'BounceBan API key'),
                    // Never prefilled with the key itself — the server does
                    // not send it. Empty means "leave it as it is"; typing
                    // replaces it.
                    h('input.input', {
                        type: 'password',
                        autocomplete: 'off',
                        placeholder: meta.secretsConfigured?.bounceban_api_key
                            ? 'A key is set — type to replace it'
                            : 'No key set',
                        oninput: (e) => { draftBounceBanKey = e.target.value; },
                    }),
                    h('span.help', 'Used to verify prospecting contact email addresses with BounceBan. '
                        + 'The key is write-only: it is never sent back to the browser.'),
                ),
                h('div.field',
                    h('label', 'Verification provider'),
                    h('select.input', {
                        onchange: (e) => { draftVerificationProvider = e.target.value; },
                    }, ['bounceban'].map((p) => h('option', {
                        value: p, selected: p === (draftVerificationProvider ?? meta.settings.verification_provider ?? 'bounceban'),
                    }, humanise(p)))),
                    h('span.help', 'Which provider email verification runs through.'),
                ),
                h('div.field',
                    h('label', 'Campaign enrolment policy'),
                    h('select.input', {
                        onchange: (e) => { draftCampaignPolicy = e.target.value; },
                    }, [
                        ['safe', 'Safe — verified and deliverable only'],
                        ['review', 'Review — also allow accept-all, catch-all, risky, unknown'],
                        ['all', 'All — anything with an address'],
                    ].map(([v, l]) => h('option', {
                        value: v, selected: v === (draftCampaignPolicy ?? meta.settings.campaign_email_policy ?? 'review'),
                    }, l))),
                    h('span.help', 'Decides who can be enrolled in a campaign. Blocked addresses — invalid, '
                        + 'disposable, do-not-email — are refused under every setting.'),
                ),
                h('div.row',
                    h('button.btn.primary', {
                        onclick: async () => {
                            try {
                                await api.patch('/api/settings', {
                                    bounceban_api_key: draftBounceBanKey || null,
                                    ...(draftVerificationProvider ? { verification_provider: draftVerificationProvider } : {}),
                                    ...(draftCampaignPolicy ? { campaign_email_policy: draftCampaignPolicy } : {}),
                                });
                                toast('Verification settings saved.', 'success');
                                reload();
                            } catch (err) {
                                toast(err.message, 'error');
                            }
                        },
                    }, 'Save'),
                ),
            ),
        );
    }

    let draftSmartleadKey = null;
    let smartleadHealth = null;
    let smartleadHealthLoading = false;

    let draftPeopleProvider = null;
    let draftApolloKey = null;

    function smartleadCard(meta) {
        const configured = Boolean(meta.secretsConfigured?.smartlead_api_key);
        const secret = meta.secretsConfigured?.smartlead_webhook_secret ? 'set' : 'not set';
        const webhookUrl = (typeof location !== 'undefined' && meta.secretsConfigured?.smartlead_webhook_secret)
            ? `${location.origin}/api/webhooks/smartlead/••••`
            : 'Connect Smartlead to generate a webhook URL.';
        const health = smartleadHealth;

        return h('div.card',
            h('div.card-header',
                h('h2', 'Smartlead — outreach'),
                h('div.actions',
                    configured && h('a.btn.sm.ghost', { href: '/outreach/smartlead' }, 'Campaign overview →'),
                    configured
                        ? h('span.badge.success', 'Connected')
                        : h('span.badge.warning', 'Not connected'),
                ),
            ),
            h('div.card-body',
                h('div.field',
                    h('label', 'Smartlead API key'),
                    h('input.input', {
                        type: 'password',
                        autocomplete: 'off',
                        placeholder: configured ? 'A key is set — type to replace it' : 'Paste your Smartlead API key',
                        oninput: (e) => { draftSmartleadKey = e.target.value; },
                    }),
                    h('span.help', 'From Smartlead → Settings → API. Write-only: never sent back to the browser.'),
                ),
                h('div.row',
                    h('button.btn.primary', {
                        onclick: async (e) => {
                            const btn = e.currentTarget;
                            btn.disabled = true;
                            try {
                                const payload = {};
                                if (draftSmartleadKey !== null && draftSmartleadKey !== '') payload.apiKey = draftSmartleadKey;
                                else if (!configured) throw new Error('Paste your Smartlead API key first.');
                                // When already configured, empty means "test the stored key".
                                const result = await api.post('/api/integrations/smartlead/test', payload);
                                toast(`Connected — ${result.campaignCount ?? 0} campaigns found.`, 'success');
                                draftSmartleadKey = null;
                                reload();
                            } catch (err) {
                                toast(err.message, 'error');
                            } finally { btn.disabled = false; }
                        },
                    }, configured ? 'Test & save' : 'Connect'),
                    configured && h('button.btn', {
                        onclick: async () => {
                            if (!await confirm({ title: 'Disconnect Smartlead?', message: 'This clears the stored API key. Campaign links and outreach history are kept.', confirmLabel: 'Disconnect', danger: true })) return;
                            await api.post('/api/integrations/smartlead/disconnect', {});
                            draftSmartleadKey = null;
                            smartleadHealth = null;
                            toast('Smartlead disconnected.', 'success');
                            reload();
                        },
                    }, 'Disconnect'),
                ),

                configured && h('div.stack.tight', { style: { marginBlockStart: 'var(--space-4)' } },
                    h('div.field',
                        h('label', 'Webhook'),
                        h('div.xs.dim', { style: { wordBreak: 'break-all' } }, webhookUrl),
                        h('span.help', `Secret: ${secret}. Smartlead authenticates by this URL, not a header. `
                            + 'The secret is write-only — Smartlead stores the URL. Point campaigns at it from Integration health.'),
                    ),
                    h('div.row',
                        h('button.btn.sm', {
                            disabled: smartleadHealthLoading,
                            onclick: async () => {
                                smartleadHealthLoading = true;
                                paint();
                                try {
                                    smartleadHealth = await api.get('/api/integrations/smartlead/status');
                                } catch (err) { toast(err.message, 'error'); }
                                smartleadHealthLoading = false;
                                paint();
                            },
                        }, smartleadHealthLoading ? 'Loading…' : 'Integration health'),
                        smartleadHealth && health?.lastSyncAt && h('span.xs.dim', `Last sync ${date(health.lastSyncAt, { withTime: true })}`),
                    ),
                    smartleadHealth && renderSmartleadHealth(smartleadHealth),
                ),
            ),
        );
    }

    function peopleSearchCard(meta) {
        const provider = draftPeopleProvider ?? meta.settings.people_search_provider ?? 'apollo';
        const apolloConfigured = Boolean(meta.secretsConfigured?.apollo_api_key);
        return h('div.card',
            h('div.card-header',
                h('h2', 'People search — sourcing'),
                h('div.actions', apolloConfigured ? h('span.badge.success', 'Apollo connected') : h('span.badge.warning', 'Not connected')),
            ),
            h('div.card-body',
                h('div.note-box',
                    h('p.xs', 'Find people at an Account or Prospecting Company — titles, company, LinkedIn returned first. '
                        + 'Emails and phone are revealed only when you explicitly ask (uses Apollo enrichment credits). '
                        + 'Found people import as contacts / prospecting contacts with dedup.')),
                h('div.field',
                    h('label', 'Provider'),
                    h('select.input', {
                        onchange: (e) => { draftPeopleProvider = e.target.value; },
                    }, [
                        ['apollo', 'Apollo — 240M+ contacts'],
                    ].map(([v, l]) => h('option', { value: v, selected: v === provider }, l))),
                    h('span.help', 'Provider-neutral — adding a second discovery vendor is a registry entry in lib/people-search.mjs, not a rewrite.'),
                ),
                h('div.field',
                    h('label', 'Apollo API key'),
                    h('input.input', {
                        type: 'password', autocomplete: 'off',
                        placeholder: apolloConfigured ? 'A key is set — type to replace it' : 'Paste your Apollo API key (x-api-key)',
                        oninput: (e) => { draftApolloKey = e.target.value; },
                    }),
                    h('span.help', 'Apollo → Settings → Connected Apps → API Keys. Write-only like BounceBan / Smartlead. Search is 0 credits; enrichment is billable.'),
                ),
                h('div.row',
                    h('button.btn.primary', {
                        onclick: async () => {
                            try {
                                const patch = {};
                                if (draftPeopleProvider) patch.people_search_provider = draftPeopleProvider;
                                if (draftApolloKey !== null && draftApolloKey !== '') patch.apollo_api_key = draftApolloKey;
                                else if (draftApolloKey === '' && apolloConfigured) patch.apollo_api_key = null;
                                if (!Object.keys(patch).length) { toast('Nothing to save.', 'warning'); return; }
                                await api.patch('/api/settings', patch);
                                draftApolloKey = null; draftPeopleProvider = null;
                                toast('People search settings saved.', 'success'); reload();
                            } catch (err) { toast(err.message, 'error'); }
                        },
                    }, 'Save'),
                    apolloConfigured && h('button.btn', {
                        onclick: async () => {
                            try {
                                const s = await api.get('/api/integrations/people-search/status');
                                toast(s.configured ? `${s.label} ready.` : `${s.label} not configured.`, s.configured ? 'success' : 'warning');
                            } catch (err) { toast(err.message, 'error'); }
                        },
                    }, 'Test'),
                ),
            ),
        );
    }

    /**
     * Personal API keys — the credential a tool with no browser (Make,
     * Zapier, a script) sends as `X-Api-Key` instead of logging in.
     *
     * A key acts as whoever created it, so this card shows YOUR keys by
     * default; an admin sees everyone's, because a departing teammate's
     * automations need a place to be shut off. Fetched on demand rather than
     * folded into `/api/meta` — it is small, rarely opened, and would
     * otherwise cost every page load a join nobody asked for.
     */
    function apiKeysCard() {
        const host = h('div');
        const isAdmin = store.can('record.write.all');

        async function refreshKeys() {
            mount(host, skeletonRows(2));
            let rows;
            try {
                rows = (await api.get('/api/api-keys')).keys;
            } catch (err) {
                mount(host, errorState(err.message, refreshKeys));
                return;
            }
            if (!rows.length) {
                mount(host, h('div.card-body', emptyState('No API keys yet.', 'Create one to connect Make, Zapier or another tool.')));
                return;
            }
            mount(host, h('div.table-wrap', h('table.data',
                h('thead', h('tr',
                    h('th', 'Name'), isAdmin && h('th', 'Owner'), h('th', 'Key'),
                    h('th', 'Created'), h('th', 'Last used'), h('th', ''))),
                h('tbody', rows.map((k) => h('tr',
                    h('td', k.name),
                    isAdmin && h('td.small.dim', k.user_name),
                    h('td', h('code.xs', `${k.key_prefix}…`)),
                    h('td.small.dim', date(k.created_at)),
                    h('td.small.dim', k.last_used_at ? date(k.last_used_at, { withTime: true }) : 'Never'),
                    h('td.num', k.revoked_at
                        ? h('span.badge', 'Revoked')
                        : h('button.btn.sm', {
                            onclick: async (e) => {
                                // Captured before the `await` below: the click
                                // event has finished dispatching by the time
                                // `confirm()` resolves, and a DOM event's
                                // `currentTarget` is null once that happens.
                                const button = e.currentTarget;
                                if (!await confirm({
                                    title: `Revoke "${k.name}"?`,
                                    message: 'Anything still using this key — a Make scenario, a script — stops working immediately. This cannot be undone.',
                                    confirmLabel: 'Revoke', danger: true,
                                })) return;
                                button.disabled = true;
                                try {
                                    await api.delete(`/api/api-keys/${k.id}`);
                                    toast('Key revoked.', 'success');
                                    refreshKeys();
                                } catch (err) { toast(err.message, 'error'); button.disabled = false; }
                            },
                        }, 'Revoke')),
                ))),
            )));
        }

        refreshKeys();

        return h('div.card',
            h('div.card-header',
                h('h2', 'API keys'),
                h('div.actions', h('button.btn.sm.primary', { onclick: () => createApiKeyDialog(refreshKeys) }, '+ New key')),
            ),
            h('div.card-body.flush', host),
            h('div.card-body',
                h('p.xs.dim', 'Lets a tool with no login of its own — Make, Zapier, a script — call this CRM the '
                    + 'same way you do. A key acts exactly as the person who created it: same records, same role, '
                    + 'same limits. Send it as an ', h('code.xs', 'X-Api-Key'), ' header instead of a session cookie.'),
            ),
        );
    }

    /**
     * Naming and minting a new personal key.
     *
     * The raw value is shown exactly once, the same promise a password reset
     * link makes and for the same reason — only its hash is stored, so it
     * cannot be looked up again if it goes astray.
     */
    async function createApiKeyDialog(onDone) {
        const draft = { name: '' };
        const errorBox = h('div.error');

        const created = await modal({
            title: 'New API key',
            size: 'narrow',
            body: h('div.stack',
                errorBox,
                h('div.field',
                    h('label', 'Name'),
                    h('input.input', {
                        placeholder: 'e.g. Make.com',
                        oninput: (e) => { draft.name = e.target.value; },
                    }),
                    h('span.help', 'What is going to use this key — helps you tell keys apart later.')),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(null) }, 'Cancel'),
                h('button.btn.primary', {
                    onclick: async (e) => {
                        if (!draft.name.trim()) { errorBox.textContent = 'Give the key a name.'; return; }
                        e.target.disabled = true;
                        try {
                            close(await api.post('/api/api-keys', { name: draft.name.trim() }));
                        } catch (err) {
                            errorBox.textContent = err.message;
                            e.target.disabled = false;
                        }
                    },
                }, 'Create'),
            ],
        });
        if (!created) return;

        const field = h('input.input', { value: created.key, readonly: true, onclick: (e) => e.target.select() });
        await modal({
            title: 'API key created',
            size: 'narrow',
            body: h('div.stack',
                h('div.field',
                    h('label', created.name),
                    field,
                    h('span.help', 'Paste this into Make — or wherever it is going — now. It will not be shown again.')),
                h('div.note-box',
                    'This is shown once. Only its hash is stored, so it cannot be looked up again — if it goes '
                    + 'astray, revoke it below and create another.'),
            ),
            footer: (close) => [
                h('button.btn', {
                    onclick: async () => {
                        try {
                            await navigator.clipboard.writeText(created.key);
                            toast('Copied.', 'success');
                        } catch {
                            field.select();
                            toast('Select it and copy manually.', '');
                        }
                    },
                }, 'Copy'),
                h('button.btn.primary', { onclick: () => close(true) }, 'Done'),
            ],
            onOpen: () => field.select(),
        });
        onDone();
    }

    function renderSmartleadHealth(health) {
        const failed = health.events?.failed ?? 0;
        return h('div.stack.tight', { style: { marginBlockStart: 'var(--space-3)' } },
            h('div.row', { style: { gap: 'var(--space-3)', flexWrap: 'wrap' } },
                h('div', h('div.xs.dim', 'Campaigns linked'), h('div.strong', String(health.campaignsLinked ?? 0))),
                h('div', h('div.xs.dim', 'Webhook events'), h('div.strong', String(health.events?.total ?? 0))),
                h('div', h('div.xs.dim', 'Processed'), h('div.strong', String(health.events?.processed ?? 0))),
                h('div', h('div.xs.dim', 'Failed'), h('span.badge', { class: failed ? 'danger' : '' }, String(failed))),
            ),
            h('div.row',
                h('button.btn.sm', {
                    onclick: async (e) => {
                        e.currentTarget.disabled = true;
                        try {
                            const result = await api.post('/api/integrations/smartlead/sync', {});
                            toast(`Sync done — ${result.campaigns?.length ?? 0} campaign(s) checked.`, 'success');
                            smartleadHealth = await api.get('/api/integrations/smartlead/status');
                            paint();
                        } catch (err) { toast(err.message, 'error'); e.currentTarget.disabled = false; }
                    },
                }, 'Sync now'),
                health.campaigns?.length
                    ? h('span.xs.dim', health.campaigns.map((c) => `${c.name} (#${c.external_id})`).join(', '))
                    : h('span.xs.dim', 'No campaigns linked. Link one from its campaign page.'),
            ),
            failed > 0 && h('div.card', { style: { marginBlockStart: 'var(--space-3)' } },
                h('div.card-header', h('h3', `Failed events — ${failed}`)),
                h('div.card-body.flush',
                    h('div.table-wrap', h('table.data',
                        h('thead', h('tr', h('th', 'When'), h('th', 'Event'), h('th', 'Error'), h('th', ''))),
                        h('tbody', health.recentErrors.map((ev) => h('tr',
                            h('td.xs', date(ev.received_at, { withTime: true })),
                            h('td', h('code.xs', ev.event_type ?? '—')),
                            h('td.xs.dim', (ev.error_message ?? '').slice(0, 120)),
                            h('td.num', h('button.btn.sm', {
                                onclick: async () => {
                                    try {
                                        const result = await api.post(`/api/integrations/smartlead/events/${ev.id}/retry`, {});
                                        toast(result.ok ? 'Replayed.' : (result.reason ?? 'Still failing.'), result.ok ? 'success' : 'error');
                                        smartleadHealth = await api.get('/api/integrations/smartlead/status');
                                        paint();
                                    } catch (err) { toast(err.message, 'error'); }
                                },
                            }, 'Retry')),
                        ))),
                    )),
                ),
            ),
        );
    }

    function peopleCard(meta) {
        return h('div.card',
            h('div.card-header',
                h('h2', 'People'),
                store.can('record.write.all') && h('div.actions',
                    h('button.btn.sm.primary', { onclick: () => inviteUser() }, '+ Add person')),
            ),
            h('div.card-body.flush',
                h('div.table-wrap', h('table.data',
                    h('thead', h('tr', h('th', 'Name'), h('th', 'Email'), h('th', 'Role'), h('th', 'Status'),
                        store.can('record.write.all') && h('th', ''))),
                    h('tbody', meta.users.map((u) => h('tr',
                        h('td', u.name),
                        h('td.small.dim', u.email),
                        // Editable for an admin, because an SDR invited as a
                        // rep otherwise has no route to the role that
                        // confines them.
                        h('td', store.can('record.write.all') && u.id !== store.state.me.user.id
                            ? h('select.input.sm', {
                                onchange: async (e) => {
                                    const role = e.target.value;
                                    try {
                                        await api.patch(`/api/users/${u.id}`, { role });
                                        toast(`${u.name} is now ${humanise(role)}.`, 'success');
                                    } catch (err) {
                                        toast(err.message, 'error');
                                        e.target.value = u.role;
                                    }
                                },
                            }, (store.state.meta.roles ?? []).map((r) => h('option', {
                                value: r, selected: r === u.role,
                            }, humanise(r))))
                            : h('span.badge', u.role)),
                        h('td', h('span.badge', { class: u.status === 'active' ? 'success' : 'danger' }, u.status)),
                        store.can('record.write.all') && h('td.num', h('div.row', { style: { gap: 'var(--space-1)', justifyContent: 'flex-end' } },
                            h('button.btn.sm', {
                                title: `Edit ${u.name} — name, email, password`,
                                onclick: () => editPerson(u),
                            }, 'Edit'),
                            h('button.btn.sm', { onclick: () => issueResetLink(u) }, 'Reset link'),
                        )),
                    ))),
                )),
                h('p.xs.dim', { style: { padding: 'var(--space-3)' } },
                    'A role belongs to the membership, not the person — the same login can hold a different role in '
                    + 'another workspace. This system sends no email, so a reset link is shown to you once and you '
                    + 'pass it on.'),
            ),
        );
    }

    function templatesCard() {
        return h('div.card',
            h('div.card-header', h('h2', 'Document templates')),
            h('div.card-body.flush',
                h('div.table-wrap', h('table.data',
                    h('thead', h('tr', h('th', 'Document'), h('th', 'Template'), h('th', 'Version'), h('th', ''))),
                    h('tbody', (templates ?? []).map((t) => h('tr',
                        h('td', t.label),
                        h('td', t.installed
                            ? h('div',
                                h('div.small', { dir: 'auto' }, t.installed.label),
                                h('div.xs.dim', `${date(t.installed.created_at)} · ${t.installed.checksum.slice(0, 12)}`))
                            : h('span.badge.warning', 'not installed')),
                        h('td', t.installed ? h('span.badge', `v${t.installed.version}`) : h('span.dim', '—')),
                        h('td.num', store.can('record.write.all') && h('button.btn.sm', {
                            onclick: () => uploadTemplate(t),
                        }, t.installed ? 'Replace' : 'Upload')),
                    ))),
                )),
                h('p.xs.dim', { style: { padding: 'var(--space-3)' } },
                    'The .docx files from ', h('code', 'Automation/'), ' — the same ones the Apps Script '
                    + 'generator uses. Replacing a template retires the old one rather than deleting it, so every '
                    + 'document already generated still records the exact template that produced it.'),
            ),
        );
    }

    function customFieldsCard(meta) {
        return h('div.card',
            h('div.card-header',
                h('h2', 'Custom fields'),
                store.can('record.write.all') && h('div.actions',
                    h('button.btn.sm.primary', { onclick: () => createField() }, '+ New field')),
            ),
            h('div.card-body',
                h('div.note-box',
                    'A field created here appears immediately in the list, the record form, the filter builder, the '
                    + 'export and the API. Nothing else needs changing — that is the whole point of the metadata engine.'),
            ),
            h('div.card-body.flush', customFieldsTable(meta)),
        );
    }

    function activityTypesCard(meta) {
        return h('div.card',
            h('div.card-header',
                h('h2', 'Activity types'),
                store.can('record.write.all') && h('div.actions',
                    h('button.btn.sm.primary', { onclick: () => createActivityType() }, '+ New type')),
            ),
            h('div.card-body.flush',
                h('div.table-wrap', h('table.data',
                    h('thead', h('tr', h('th', 'Label'), h('th', 'Key'), h('th', 'Colour'))),
                    h('tbody', meta.activityTypes.map((t) => h('tr',
                        h('td', t.label),
                        h('td', h('code.xs', t.key)),
                        h('td', h('span.badge', { class: t.color }, t.color)),
                    ))),
                )),
                h('p.xs.dim', { style: { padding: 'var(--space-3)' } },
                    '"Call", "email" and "meeting" are rows in a table, not values in code. Adding one '
                    + 'requires no deployment.'),
            ),
        );
    }

    /**
     * Targets per Account Type and Service.
     *
     * Configuration, not code — the business changes a number here and the
     * dashboard reads it. Held in USD because that is the reporting currency
     * the figures are normalised into before they are compared.
     *
     * A blank box means NOT SET, and clearing one deletes the row rather than
     * storing zero. "0% of a target nobody agreed" is a different statement
     * from "no target", and only one of them belongs on a dashboard.
     */
    /**
     * The management reporting rates.
     *
     * Units per USD, typed by an admin, and nothing else: no feed, no history,
     * no daily sync. Changing one moves every figure on the dashboard and moves
     * nothing else — the deal, the proposal and the agreement keep the amount
     * and currency the client agreed to, which the note below says out loud
     * because it is the question everybody asks first.
     */
    /**
     * The one number lib/renewals.mjs reads when an agreement does not carry
     * its own notice period — see lib/settings.mjs's DEFAULTS.
     */
    function renewalSettingsCard(meta) {
        const OPTIONS = [30, 45, 60, 90];
        const current = Number(meta.settings.default_renewal_notice_days) || 45;
        const customMode = !OPTIONS.includes(current);
        const status = h('span.xs.dim');

        const save = async (days) => {
            try {
                await api.patch('/api/settings', { default_renewal_notice_days: days });
                meta.settings.default_renewal_notice_days = days;
                status.textContent = 'Saved.';
                toast('Renewal notice default saved', 'success');
            } catch (err) {
                toast(err.message, 'error');
            }
        };

        const customBox = h('input.input.sm', {
            type: 'number', min: 1, style: { inlineSize: '6rem' },
            value: customMode ? current : '',
            placeholder: 'Custom',
            onchange: (e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n > 0) save(n);
            },
        });

        return h('div.card',
            h('div.card-header', h('h2', 'Renewal notice'), h('div.actions', status)),
            h('div.card-body',
                h('p.small.muted',
                    'How many days before an agreement’s expiry the renewal decision is due, by default. '
                    + 'An agreement with its own notice period set always uses that instead — this is only '
                    + 'what a new agreement, and the Existing Customers import, open with.'),
                h('div.field', { style: { marginBlockStart: 'var(--space-3)' } },
                    h('label', 'Default renewal notice'),
                    h('div.row',
                        OPTIONS.map((n) => h('button.btn.sm', {
                            class: !customMode && n === current ? 'primary' : '',
                            onclick: () => save(n),
                        }, `${n} days`)),
                        customBox,
                    ),
                ),
            ),
        );
    }

    /**
     * The workspace's outgoing mail relay — lib/settings.mjs's `smtp_*` keys,
     * delivered through by lib/smtp-client.mjs (no dependency, see that
     * file's header). One relay, workspace-wide: this is the low-volume
     * business mail the request describes, not a marketing platform where
     * per-sender relays would matter.
     */
    function smtpCard(meta) {
        const draft = {
            host: meta.settings.smtp_host ?? '',
            port: meta.settings.smtp_port ?? 587,
            secure: meta.settings.smtp_secure ?? 'starttls',
            username: meta.settings.smtp_username ?? '',
            password: '',
            fromEmail: meta.settings.smtp_from_email ?? '',
            fromName: meta.settings.smtp_from_name ?? '',
        };
        const status = h('span.xs.dim');
        const testBox = h('div');

        const save = async () => {
            try {
                await api.patch('/api/settings', {
                    smtp_host: draft.host.trim() || null,
                    smtp_port: Number(draft.port) || 587,
                    smtp_secure: draft.secure,
                    smtp_username: draft.username.trim() || null,
                    ...(draft.password ? { smtp_password: draft.password } : {}),
                    smtp_from_email: draft.fromEmail.trim() || null,
                    smtp_from_name: draft.fromName.trim() || null,
                });
                Object.assign(meta.settings, {
                    smtp_host: draft.host, smtp_port: draft.port, smtp_secure: draft.secure,
                    smtp_username: draft.username, smtp_from_email: draft.fromEmail, smtp_from_name: draft.fromName,
                });
                if (draft.password) meta.secretsConfigured = { ...meta.secretsConfigured, smtp_password: true };
                status.textContent = 'Saved.';
                toast('SMTP settings saved', 'success');
            } catch (err) { toast(err.message, 'error'); }
        };

        const sendTest = async (button) => {
            const to = testBox.querySelector('input').value.trim();
            if (!to) return toast('Enter an address to send the test to.', 'error');
            button.disabled = true;
            button.textContent = 'Sending…';
            try {
                await api.post('/api/email/test-send', { to });
                toast(`Test email sent to ${to}.`, 'success');
            } catch (err) {
                toast(err.message, 'error');
            } finally {
                button.disabled = false;
                button.textContent = 'Send test email';
            }
        };

        return h('div.card',
            h('div.card-header', h('h2', 'Outgoing mail (SMTP)'), h('div.actions', status)),
            h('div.card-body',
                h('p.small.muted', 'The relay queued proposal, agreement and agreement-signed emails actually send '
                    + 'through. Works with Gmail, Microsoft 365, or any SMTP account — an app password, not your '
                    + 'normal login password, for either of those.'),
                h('div.row', { style: { gap: 'var(--space-3)', marginBlockStart: 'var(--space-3)', flexWrap: 'wrap' } },
                    h('div.field', { style: { flex: '2', minInlineSize: '12rem' } },
                        h('label', 'Host'),
                        h('input.input', { value: draft.host, placeholder: 'smtp.gmail.com', oninput: (e) => { draft.host = e.target.value; } })),
                    h('div.field', { style: { inlineSize: '6rem' } },
                        h('label', 'Port'),
                        h('input.input', { type: 'number', value: draft.port, oninput: (e) => { draft.port = e.target.value; } })),
                    h('div.field', { style: { inlineSize: '10rem' } },
                        h('label', 'Encryption'),
                        h('select.input', { onchange: (e) => { draft.secure = e.target.value; } },
                            [['starttls', 'STARTTLS (587)'], ['tls', 'TLS (465)'], ['none', 'None']].map(([v, l]) => h('option', {
                                value: v, selected: v === draft.secure,
                            }, l)))),
                ),
                h('div.row', { style: { gap: 'var(--space-3)', marginBlockStart: 'var(--space-2)', flexWrap: 'wrap' } },
                    h('div.field', { style: { flex: '1', minInlineSize: '12rem' } },
                        h('label', 'Username'),
                        h('input.input', { value: draft.username, autocomplete: 'off', oninput: (e) => { draft.username = e.target.value; } })),
                    h('div.field', { style: { flex: '1', minInlineSize: '12rem' } },
                        h('label', 'Password'),
                        h('input.input', {
                            type: 'password', autocomplete: 'off',
                            placeholder: meta.secretsConfigured?.smtp_password ? 'A password is set — type to replace it' : 'No password set',
                            oninput: (e) => { draft.password = e.target.value; },
                        })),
                ),
                h('div.row', { style: { gap: 'var(--space-3)', marginBlockStart: 'var(--space-2)', flexWrap: 'wrap' } },
                    h('div.field', { style: { flex: '1', minInlineSize: '12rem' } },
                        h('label', 'From address'),
                        h('input.input', { type: 'email', value: draft.fromEmail, placeholder: 'no-reply@yourcompany.com', oninput: (e) => { draft.fromEmail = e.target.value; } })),
                    h('div.field', { style: { flex: '1', minInlineSize: '12rem' } },
                        h('label', 'From name'),
                        h('input.input', { value: draft.fromName, placeholder: 'Talent 360', oninput: (e) => { draft.fromName = e.target.value; } })),
                ),
                h('div.row', { style: { marginBlockStart: 'var(--space-3)' } },
                    h('button.btn.primary', { onclick: save }, 'Save'),
                ),
                h('hr', { style: { marginBlock: 'var(--space-4)' } }),
                h('div.field',
                    h('label', 'Send a test email'),
                    mount(testBox,
                        h('div.row', { style: { gap: 'var(--space-2)' } },
                            h('input.input', { type: 'email', placeholder: 'you@yourcompany.com', style: { flex: '1' } }),
                            h('button.btn', { onclick: (e) => sendTest(e.currentTarget) }, 'Send test email'),
                        ),
                    ),
                    h('span.help', 'Confirms the relay above actually delivers, before it is trusted with a real client send.'),
                ),
            ),
        );
    }

    /** Who the two automated agreement-signed emails go to — lib/settings.mjs's finance_/internal_team_notification_recipients. */
    function emailRecipientsCard(meta) {
        const status = h('span.xs.dim');
        const parseEmails = (s) => s.split(/[,\n]/).map((v) => v.trim()).filter(Boolean);
        const save = async (key, raw) => {
            const emails = parseEmails(raw);
            const bad = emails.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
            if (bad) return toast(`"${bad}" is not a valid email address.`, 'error');
            try {
                await api.patch('/api/settings', { [key]: emails });
                meta.settings[key] = emails;
                status.textContent = 'Saved.';
                toast('Recipients saved', 'success');
            } catch (err) { toast(err.message, 'error'); }
        };
        return h('div.card',
            h('div.card-header', h('h2', 'Notification recipients'), h('div.actions', status)),
            h('div.card-body',
                h('p.small.muted', 'Who the two automated "agreement signed" emails are addressed to. One per line, or comma-separated.'),
                h('div.field', { style: { marginBlockStart: 'var(--space-3)' } },
                    h('label', 'Finance'),
                    h('textarea.input', {
                        rows: 2, value: (meta.settings.finance_notification_recipients ?? []).join('\n'),
                        onblur: (e) => save('finance_notification_recipients', e.target.value),
                    }),
                ),
                h('div.field', { style: { marginBlockStart: 'var(--space-3)' } },
                    h('label', 'Internal team'),
                    h('textarea.input', {
                        rows: 2, value: (meta.settings.internal_team_notification_recipients ?? []).join('\n'),
                        onblur: (e) => save('internal_team_notification_recipients', e.target.value),
                    }),
                ),
            ),
        );
    }

    /** Every variable the resolver supports (lib/email-variables.mjs's ALL_VARIABLES) — mirrored here for the insert palette. */
    const EMAIL_VARIABLES = [
        'contact_name', 'contact_first_name', 'contact_last_name', 'contact_email', 'contact_phone', 'contact_job_title',
        'company_name', 'website', 'industry', 'account_type',
        'deal_name', 'deal_size', 'currency', 'service', 'scope', 'duration', 'deal_stage',
        'agreement_number', 'agreement_start_date', 'agreement_end_date', 'agreement_status',
        'proposal_number', 'proposal_name', 'proposal_value',
        'sender_name', 'sender_email', 'sender_title',
        'proposal_document', 'agreement_document', 'internal_team_proposal',
    ];

    function emailTemplatesCard() {
        const host = h('div.card-body.flush', skeletonRows(3));
        let list = null;

        async function load() {
            try {
                list = (await api.get('/api/email-templates')).templates;
            } catch (err) {
                mount(host, h('div.card-body', h('div.note-box.danger', err.message)));
                return;
            }
            render();
        }

        function render() {
            mount(host, h('div.table-wrap', h('table.data',
                h('thead', h('tr', h('th', 'Category'), h('th', 'Template'), h('th', 'Status'), h('th', ''))),
                h('tbody', list.map((t) => h('tr',
                    h('td.small', categoryLabel(t.category)),
                    h('td',
                        h('span.strong', t.name),
                        t.is_system && h('span.badge.xs', { style: { marginInlineStart: '0.5em' } }, 'system')),
                    h('td', h('span.badge', { class: t.status === 'active' ? 'success' : t.status === 'inactive' ? '' : 'warning' }, t.status)),
                    h('td.num', h('div.row', { style: { justifyContent: 'flex-end' } },
                        h('button.btn.sm.ghost', { onclick: () => openEditor(t) }, 'Edit'),
                        h('button.btn.sm.ghost', { onclick: () => duplicate(t) }, 'Duplicate'),
                        t.status === 'active'
                            ? h('button.btn.sm.ghost', { onclick: () => setStatus(t, 'inactive') }, 'Deactivate')
                            : h('button.btn.sm.ghost', { onclick: () => setStatus(t, 'active') }, 'Activate'),
                    )),
                ))),
            )));
        }

        async function setStatus(t, status) {
            try { await api.patch(`/api/email-templates/${t.id}`, { status }); toast('Saved', 'success'); await load(); }
            catch (err) { toast(err.message, 'error'); }
        }
        async function duplicate(t) {
            try { await api.post(`/api/email-templates/${t.id}/duplicate`, {}); toast('Duplicated as a draft', 'success'); await load(); }
            catch (err) { toast(err.message, 'error'); }
        }

        async function openEditor(t) {
            const draft = { subject: t.subject, body: t.body };
            const errorBox = h('div.error');
            const subjectInput = h('input.input', { value: draft.subject, oninput: (e) => { draft.subject = e.target.value; } });
            const bodyInput = h('textarea.input', { rows: 12, value: draft.body, oninput: (e) => { draft.body = e.target.value; } });
            const previewHost = h('div', h('p.xs.dim', 'Search a deal above to preview this template with real data.'));
            const dealResults = h('div.row', { style: { flexWrap: 'wrap', gap: '0.25rem', marginBlockStart: 'var(--space-2)' } });
            let selectedDealId = null;
            let searchTimeout;

            const insertVar = (key) => {
                const el = document.activeElement === subjectInput ? subjectInput : bodyInput;
                const start = el.selectionStart ?? el.value.length;
                const end = el.selectionEnd ?? el.value.length;
                const token = `{{${key}}}`;
                el.value = el.value.slice(0, start) + token + el.value.slice(end);
                if (el === subjectInput) draft.subject = el.value; else draft.body = el.value;
                el.focus();
                el.selectionStart = el.selectionEnd = start + token.length;
            };

            const runPreview = async () => {
                if (!selectedDealId) return;
                mount(previewHost, skeletonRows(2));
                try {
                    const result = await api.post(`/api/email-templates/${t.id}/preview`, { dealId: selectedDealId });
                    mount(previewHost, h('div.stack.tight',
                        h('div.field', h('label', 'Subject'), h('div.note-box', result.subject)),
                        h('div.field', h('label', 'Body'),
                            h('pre.small', { style: { whiteSpace: 'pre-wrap', fontFamily: 'inherit' } }, result.body)),
                        result.missingVariables.length > 0 && h('div.note-box.warning',
                            `Missing: ${result.missingVariables.map((v) => `{{${v}}}`).join(', ')}`),
                        result.attachments.length > 0 && h('p.xs.dim', `Attachments: ${result.attachments.map((a) => a.name).join(', ')}`),
                        result.missingAttachments.length > 0 && h('p.xs.dim', `Not yet on file: ${result.missingAttachments.join(', ')}`),
                    ));
                } catch (err) {
                    mount(previewHost, h('div.note-box.danger', err.message));
                }
            };

            const dealSearchInput = h('input.input', {
                placeholder: 'Type a deal name…',
                oninput: (e) => {
                    clearTimeout(searchTimeout);
                    const q = e.target.value.trim();
                    if (!q) { mount(dealResults); return; }
                    searchTimeout = setTimeout(async () => {
                        const data = await api.get(`/api/deals?q=${encodeURIComponent(q)}&limit=8`).catch(() => ({ records: [] }));
                        mount(dealResults, (data.records ?? []).map((d) => h('button.btn.xs.ghost', {
                            onclick: () => { selectedDealId = d.id; dealSearchInput.value = d.name; mount(dealResults); runPreview(); },
                        }, d.name)));
                    }, 250);
                },
            });

            const saved = await modal({
                title: `Edit — ${t.name}`,
                size: 'wide',
                body: h('div.stack',
                    errorBox,
                    t.is_system && h('p.xs.dim', 'The category this template triggers on cannot be changed. Subject, body and status can.'),
                    h('div.field', h('label', 'Subject'), subjectInput),
                    h('div.field', h('label', 'Body'), bodyInput),
                    h('div.field', h('label', 'Insert a variable'),
                        h('div.row', { style: { flexWrap: 'wrap', gap: '0.25rem' } },
                            EMAIL_VARIABLES.map((k) => h('button.btn.xs.ghost', { type: 'button', onclick: () => insertVar(k) }, `{{${k}}}`)))),
                    h('hr'),
                    h('div.field', h('label', 'Preview with a real deal'), dealSearchInput, dealResults),
                    previewHost,
                ),
                footer: (close) => [
                    h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                    h('button.btn.primary', {
                        onclick: async (event) => {
                            const button = event.currentTarget;
                            button.disabled = true;
                            try {
                                await api.patch(`/api/email-templates/${t.id}`, { subject: draft.subject, body: draft.body });
                                close(true);
                            } catch (err) {
                                errorBox.textContent = err.message;
                                button.disabled = false;
                            }
                        },
                    }, 'Save'),
                ],
            });
            if (saved) { toast('Template saved', 'success'); await load(); }
        }

        load();
        return h('div.card', h('div.card-header', h('h2', 'Templates')), host);
    }

    function categoryLabel(category) {
        return {
            proposal_client: 'Proposal → Client',
            agreement_client: 'Agreement → Client',
            agreement_signed_finance: 'Agreement Signed → Finance',
            // Sent when an agreement is signed, but its content is the
            // proposal's scope, redacted of price — "Agreement" in the
            // label read as if the commercial document went out internally,
            // which is exactly what this category exists to never do.
            agreement_signed_internal: 'Proposal Scope → Internal Team',
        }[category] ?? category;
    }

    function reportingRatesCard(meta) {
        const rates = [
            { key: 'fx_egp_per_usd', label: 'EGP per USD', hint: 'e.g. 50 — one dollar buys fifty pounds.' },
            { key: 'fx_sar_per_usd', label: 'SAR per USD', hint: 'e.g. 3.75.' },
        ];
        const status = h('span.xs.dim');

        const save = async (key, input) => {
            const value = String(input.value).trim();
            if (!(Number(value) > 0)) {
                status.textContent = 'A rate must be a positive number.';
                return;
            }
            status.textContent = 'Saving…';
            try {
                await api.patch('/api/settings', { [key]: Number(value) });
                status.textContent = 'Saved — the dashboard uses it from the next load.';
            } catch (err) {
                status.textContent = err.message;
            }
        };

        return h('div.card',
            h('div.card-header',
                h('h2', 'Reporting currency'),
                h('div.actions', h('span.xs.dim', 'Admin only')),
            ),
            h('div.card-body',
                h('dl.detail-list',
                    h('dt', 'Reports in'), h('dd', meta.settings?.reporting_currency ?? 'USD'),
                    h('dt', 'USD per USD'), h('dd', '1'),
                ),
                ...rates.map((rate) => h('div.field',
                    h('label', rate.label),
                    h('input.input.tabular', {
                        type: 'text',
                        inputMode: 'decimal',
                        value: meta.settings?.[rate.key] ?? '',
                        onchange: (e) => save(rate.key, e.target),
                    }),
                    h('span.help', rate.hint),
                )),
                status,
                h('div.note-box', { style: { marginBlockStart: 'var(--space-3)' } },
                    h('div.strong.small', 'These are management reporting rates'),
                    h('p.xs', 'They convert EGP and SAR figures into USD so the dashboard can total them. '
                        + 'They are not settlement rates and nothing is revalued: changing one here does not alter a '
                        + 'single deal, proposal or agreement. An agreement for EGP 500,000 stays EGP 500,000 — only '
                        + 'what the dashboard reports it as changes.'),
                ),
            ),
        );
    }

    function serviceTargetsCard() {
        const host = h('div.card-body.flush', skeletonRows(3));

        const load = async () => {
            let data;
            try {
                data = await api.get('/api/service-targets');
            } catch (err) {
                return mount(host, h('div.card-body', h('div.note-box.danger', err.message)));
            }
            if (!data.services.length) {
                return mount(host, h('div.card-body',
                    h('p.dim', 'This workspace has no service lines, so there is nothing to set a target against.')));
            }

            const save = async (input, accountType, service) => {
                input.classList.remove('is-error');
                try {
                    const { target } = await api.put('/api/service-targets', {
                        accountType, service, target: input.value,
                    });
                    input.value = target === null ? '' : String(target);
                    toast('Target saved', 'success');
                } catch (err) {
                    input.classList.add('is-error');
                    toast(err.message, 'error');
                }
            };

            return mount(host, h('div.table-wrap', h('table.data',
                h('thead', h('tr',
                    h('th', 'Service'),
                    ...data.accountTypes.map((t) => h('th.num', t)),
                )),
                h('tbody', data.services.map((service) => h('tr',
                    h('td', h('span.strong', service.label)),
                    ...data.accountTypes.map((accountType) => {
                        const cell = data.targets.find(
                            (t) => t.accountType === accountType && t.service === service.key,
                        );
                        const input = h('input.input.sm.tabular', {
                            type: 'text',
                            inputMode: 'decimal',
                            placeholder: 'Not set',
                            value: cell?.target ?? '',
                            title: cell?.updatedAt ? `Last changed ${date(cell.updatedAt, { withTime: true })}` : 'No target set',
                            onchange: (e) => save(e.target, accountType, service.key),
                        });
                        return h('td.num', input);
                    }),
                ))),
            )));
        };
        load();

        return h('div.card',
            h('div.card-header',
                h('h2', 'Service targets'),
                h('div.actions', h('span.xs.dim', 'USD — the reporting currency')),
            ),
            host,
            h('div.card-body', h('p.xs.dim',
                'One target per account type and service. Leave a box empty for "no target set" — the dashboard '
                + 'reports that differently from a target of zero. Targets are compared against figures normalised '
                + 'to USD; what each client actually pays is unaffected.')),
        );
    }

    /**
     * Lead scoring: the weights, saved as a new model version.
     *
     * The API refuses negative weights and an all-zero model, and saving does
     * NOT rescore — that is an explicit act on the list, so a weight change
     * never silently rewrites history.
     */
    function scoringCard() {
        const host = h('div');
        const card = h('div.card',
            h('div.card-header',
                h('h2', 'Lead scoring'),
                h('div.actions', h('span.xs.dim', 'Weights are relative and normalised')),
            ),
            h('div.card-body', host),
        );

        (async () => {
            let data;
            try {
                data = await api.get('/api/scoring/model');
            } catch (err) {
                mount(host, errorState(err.message, () => reload()));
                return;
            }
            const draft = { ...data.model.weights };
            const rows = Object.entries(data.model.weights).map(([key, weight]) => {
                const input = h('input.input.sm.tabular', {
                    type: 'number', step: '1', min: '0', value: weight,
                    oninput: (e) => { draft[key] = Number(e.target.value) || 0; },
                });
                return { key, label: humanise(key), input };
            });

            mount(host, h('div.stack',
                h('div.table-wrap', h('table.data',
                    h('thead', h('tr', h('th', 'Component'), h('th', 'Weight'))),
                    h('tbody', rows.map((r) => h('tr',
                        h('td', r.label, h('div', h('code.xs.dim', r.key))),
                        h('td', r.input),
                    ))),
                )),
                h('p.xs.dim', `Model v${data.model.version ?? 1}. Saving publishes a NEW version — existing scores `
                    + 'are unchanged until you rescore from the accounts list.'),
                h('div.row',
                    h('button.btn.primary', {
                        onclick: async (event) => {
                            const button = event.currentTarget;
                            button.disabled = true;
                            try {
                                const result = await api.put('/api/scoring/model', { model: { weights: draft } });
                                toast(result.note ?? 'Saved.', 'success');
                                reload();
                            } catch (err) {
                                toast(err.message, 'error');
                                button.disabled = false;
                            }
                        },
                    }, 'Save model'),
                ),
            ));
        })();

        return card;
    }

    function customFieldsTable(meta) {
        const custom = Object.values(meta.objects).flatMap((o) => o.fields.filter((f) => f.custom).map((f) => ({ ...f, object: o })));
        if (!custom.length) return emptyState('No custom fields', 'Add one to see it flow through every surface at once.');
        return h('div.table-wrap', h('table.data',
            h('thead', h('tr', h('th', 'Field'), h('th', 'Object'), h('th', 'Type'), h('th', 'Filterable'), h('th', 'Searchable'), h('th', ''))),
            h('tbody', custom.map((f) => h('tr',
                h('td', f.label, h('div', h('code.xs.dim', f.key))),
                h('td', f.object.plural),
                h('td', h('span.badge', f.type)),
                h('td', f.filterable ? '✓' : h('span.dim', { title: f.excludedBecause }, '—')),
                h('td', f.searchable ? '✓' : h('span.dim', '—')),
                h('td', store.can('record.write.all') && h('button.btn.sm.ghost', {
                    onclick: async () => {
                        if (!await confirm({
                            title: `Delete "${f.label}"?`,
                            message: 'Existing values are kept — re-creating the field with the same key restores them. '
                                + 'Deletion is blocked while a view or list still references it.',
                            confirmLabel: 'Delete', danger: true,
                        })) return;
                        try {
                            const result = await api.delete(`/api/fields/${f.id ?? ''}`);
                            toast(result.note ?? 'Deleted.', 'success');
                            reload();
                        } catch (err) {
                            // The referrer is named, so the message is actionable.
                            toast(err.message, 'error');
                        }
                    },
                }, 'Delete')),
            ))),
        ));
    }

    async function createField() {
        const draft = { object_key: 'account', key: '', label: '', type: 'text', filterable: true, searchable: false, options: null };
        const optionsField = h('div');
        const errorBox = h('div.error');

        const repaintOptions = () => {
            mount(optionsField, ['select', 'multiselect'].includes(draft.type)
                ? h('div.field',
                    h('label', 'Options'),
                    h('input.input', {
                        placeholder: 'A, B, C',
                        oninput: (e) => { draft.options = e.target.value.split(',').map((s) => s.trim()).filter(Boolean); },
                    }),
                    h('span.help', 'Comma-separated.'))
                : null);
        };
        repaintOptions();

        const created = await modal({
            title: 'New custom field',
            body: h('div.stack',
                errorBox,
                h('div.field', h('label', 'Object'),
                    h('select.input', { onchange: (e) => { draft.object_key = e.target.value; } },
                        // Not the internal ones: a custom field on the calling
                        // queue would have nowhere to be edited.
                        store.selectableObjects().map((o) => h('option', { value: o.key }, o.plural)))),
                h('div.field', h('label', 'Label'),
                    h('input.input', {
                        oninput: (e) => {
                            draft.label = e.target.value;
                            if (!draft.keyTouched) draft.key = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
                        },
                    })),
                h('div.field', h('label', 'Key'),
                    h('input.input', { oninput: (e) => { draft.key = e.target.value; draft.keyTouched = true; } }),
                    h('span.help', 'Used in the API and in filters as properties.<key>.')),
                h('div.field', h('label', 'Type'),
                    h('select.input', { onchange: (e) => { draft.type = e.target.value; repaintOptions(); } },
                        ['text', 'textarea', 'number', 'currency', 'percent', 'date', 'datetime', 'select', 'multiselect', 'checkbox', 'url', 'email', 'phone']
                            .map((t) => h('option', { value: t }, humanise(t))))),
                optionsField,
                h('label.checkbox',
                    h('input', { type: 'checkbox', checked: true, onchange: (e) => { draft.filterable = e.target.checked; } }),
                    h('span', 'Filterable'),
                ),
                h('label.checkbox',
                    h('input', { type: 'checkbox', onchange: (e) => { draft.searchable = e.target.checked; } }),
                    h('span', 'Searchable'),
                ),
                h('div.note-box',
                    'Filterable and searchable are the index budget, not conveniences. A field that is not filterable is '
                    + 'left out of the filter builder with an explanation rather than silently missing.'),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', {
                    onclick: async (event) => {
                        const button = event.currentTarget;
                        button.disabled = true;
                        try {
                            await api.post('/api/fields', draft);
                            close(true);
                        } catch (err) {
                            errorBox.textContent = err.message;
                            button.disabled = false;
                        }
                    },
                }, 'Create'),
            ],
        });
        if (created) {
            toast('Field created. It is already in the list, the form, the filter builder and the API.', 'success');
            reload();
        }
    }

    async function createActivityType() {
        const draft = { key: '', label: '', icon: 'dot', color: 'info' };
        const errorBox = h('div.error');
        const created = await modal({
            title: 'New activity type',
            size: 'narrow',
            body: h('div.stack',
                errorBox,
                h('div.field', h('label', 'Label'),
                    h('input.input', {
                        oninput: (e) => {
                            draft.label = e.target.value;
                            draft.key = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_');
                        },
                    })),
                h('div.field', h('label', 'Colour'),
                    h('select.input', { onchange: (e) => { draft.color = e.target.value; } },
                        ['info', 'accent', 'success', 'warning', 'danger'].map((c) => h('option', { value: c }, humanise(c))))),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', {
                    onclick: async (event) => {
                        const button = event.currentTarget;
                        button.disabled = true;
                        try {
                            await api.post('/api/activity-types', draft);
                            close(true);
                        } catch (err) {
                            errorBox.textContent = err.message;
                            button.disabled = false;
                        }
                    },
                }, 'Create'),
            ],
        });
        if (created) reload();
    }

    /**
     * Changing your own password.
     *
     * The confirmation field is checked here, before the request: a typo should
     * cost a keystroke, not a round trip that reports something vague.
     */
    async function changePassword() {
        const draft = { current: '', next: '', confirm: '' };
        const errorBox = h('div.error');
        const done = await modal({
            title: 'Change password',
            size: 'narrow',
            body: h('div.stack',
                errorBox,
                h('div.field', h('label', 'Current password'),
                    h('input.input', { type: 'password', autocomplete: 'current-password', oninput: (e) => { draft.current = e.target.value; } })),
                h('div.field', h('label', 'New password'),
                    h('input.input', { type: 'password', autocomplete: 'new-password', oninput: (e) => { draft.next = e.target.value; } }),
                    h('span.help', 'At least 8 characters.')),
                h('div.field', h('label', 'Confirm new password'),
                    h('input.input', { type: 'password', autocomplete: 'new-password', oninput: (e) => { draft.confirm = e.target.value; } })),
                h('div.note-box',
                    'This signs you out of every other browser and device. This one stays signed in.'),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', {
                    onclick: async (event) => {
                        errorBox.textContent = '';
                        if (draft.next !== draft.confirm) {
                            errorBox.textContent = 'Those two passwords do not match.';
                            return;
                        }
                        event.target.disabled = true;
                        try {
                            await api.post('/api/me/password', {
                                currentPassword: draft.current, newPassword: draft.next,
                            });
                            close(true);
                        } catch (err) {
                            errorBox.textContent = err.message;
                            event.target.disabled = false;
                        }
                    },
                }, 'Change password'),
            ],
        });
        if (done) toast('Password changed. Other sessions were signed out.', 'success');
    }

    /**
     * Issuing a reset link for someone else.
     *
     * Shown once and never retrievable — only its hash is stored — so the modal
     * says so plainly rather than letting an admin assume they can come back
     * for it.
     */
    async function issueResetLink(user) {
        const proceed = await confirm({
            title: `Reset link for ${user.name}?`,
            message: 'This expires any earlier unused link for them. It does not change their password '
                + 'or sign them out — that happens when they use it.',
            confirmLabel: 'Create link',
        });
        if (!proceed) return;

        let result;
        try {
            result = await api.post(`/api/users/${user.id}/reset-link`, {});
        } catch (err) {
            return toast(err.message, 'error');
        }

        const url = `${location.origin}${result.path}`;
        const field = h('input.input', { value: url, readonly: true, onclick: (e) => e.target.select() });
        await modal({
            title: 'One-time reset link',
            size: 'narrow',
            body: h('div.stack',
                h('div.field',
                    h('label', `Send this to ${result.user.email}`),
                    field,
                    h('span.help', `Works once, expires in ${result.expiresInHours} hours.`)),
                h('div.note-box',
                    'This is shown once. Only its hash is stored, so it cannot be looked up again — '
                    + 'if it goes astray, issue another.'),
            ),
            footer: (close) => [
                h('button.btn', {
                    onclick: async () => {
                        try {
                            await navigator.clipboard.writeText(url);
                            toast('Copied.', 'success');
                        } catch {
                            // Clipboard access is refused in plenty of ordinary
                            // situations; the field is right there and selected.
                            field.select();
                            toast('Select it and copy manually.', '');
                        }
                    },
                }, 'Copy'),
                h('button.btn.primary', { onclick: () => close(true) }, 'Done'),
            ],
            onOpen: () => field.select(),
        });
        return undefined;
    }

    /**
     * Editing a person: name, email, and (optionally) setting a password.
     *
     * The backend has accepted PUT /api/users/:id for all three since the
     * beginning; this dialog is the door that was missing. The password field
     * is deliberately optional — an admin who only fixes a typo should not be
     * forced to invent credentials — and what is sent is exactly what changed.
     */
    async function editPerson(u) {
        const draft = { name: u.name ?? '', email: u.email ?? '', password: '' };
        const errorBox = h('div.error');

        const saved = await modal({
            title: `Edit ${u.name}`,
            body: h('div.stack',
                errorBox,
                h('div.field', h('label', 'Name'),
                    h('input.input', { value: draft.name, oninput: (e) => { draft.name = e.target.value; } })),
                h('div.field', h('label', 'Email'),
                    h('input.input', { type: 'email', value: draft.email, oninput: (e) => { draft.email = e.target.value; } }),
                    h('span.help', 'This is how they sign in. It must not belong to another account.')),
                h('div.field', h('label', 'New password (optional)'),
                    h('input.input', {
                        type: 'text', autocomplete: 'off',
                        placeholder: 'Leave blank to keep their current password',
                        oninput: (e) => { draft.password = e.target.value; },
                    }),
                    h('span.help', 'At least 8 characters. Stored as a scrypt hash. They are NOT signed out elsewhere by this — use "Reset link" if you need that.')),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', {
                    onclick: async (event) => {
                        const button = event.currentTarget;
                        button.disabled = true;
                        try {
                            const payload = {};
                            if (draft.name !== u.name) payload.name = draft.name;
                            if (draft.email !== u.email) payload.email = draft.email;
                            if (draft.password !== '') payload.password = draft.password;
                            if (!Object.keys(payload).length) { close(undefined); return; }
                            const result = await api.put(`/api/users/${u.id}`, payload);
                            close(result);
                        } catch (err) {
                            errorBox.textContent = err.message;
                            button.disabled = false;
                        }
                    },
                }, 'Save'),
            ],
        });

        if (saved) {
            toast(`${saved.user?.name ?? u.name} updated.`, 'success');
            reload();
        }
    }

    async function inviteUser() {
        const draft = { email: '', name: '', password: '', role: 'rep' };
        const errorBox = h('div.error');
        const created = await modal({
            title: 'Add person',
            body: h('div.stack',
                errorBox,
                h('div.field', h('label', 'Name'), h('input.input', { oninput: (e) => { draft.name = e.target.value; } })),
                h('div.field', h('label', 'Email'), h('input.input', { type: 'email', oninput: (e) => { draft.email = e.target.value; } })),
                h('div.field',
                    h('label', 'Temporary password'),
                    h('input.input', { type: 'text', oninput: (e) => { draft.password = e.target.value; } }),
                    h('span.help', 'At least 8 characters. Stored as a scrypt hash — nobody, including you, can read it back.')),
                h('div.field', h('label', 'Role'),
                    h('select.input', { onchange: (e) => { draft.role = e.target.value; } },
                        // From the server's capability matrix, not a list typed
                        // out here — that is why `sdr` was invisible.
                        (store.state.meta.roles ?? ['admin', 'manager', 'rep', 'readonly'])
                            .map((r) => h('option', { value: r, selected: r === 'rep' }, humanise(r))))),
                h('div.note-box',
                    h('div.strong.small', 'What each role can do'),
                    h('ul', { style: { marginBlockStart: 'var(--space-1)', paddingInlineStart: 'var(--space-4)', listStyle: 'disc' } },
                        h('li', 'Admin — everything, including rules and custom fields'),
                        h('li', 'Manager — all records, delete, export, sign agreements'),
                        h('li', 'Rep — reads everything, edits their own records, no export'),
                        h('li', 'Read only — reads, changes nothing'),
                        h('li', 'SDR — their calling queue and nothing else. No accounts, '
                            + 'no contacts list, no dashboard; every other page is refused by the '
                            + 'server, not merely hidden.'),
                    ),
                    h('p.xs', { style: { marginBlockStart: 'var(--space-2)' } },
                        'Export is its own permission rather than part of read: looking at one record and walking out with '
                        + 'the whole database are different acts.'),
                ),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', {
                    onclick: async (event) => {
                        const button = event.currentTarget;
                        button.disabled = true;
                        try {
                            await api.post('/api/users', draft);
                            close(true);
                        } catch (err) {
                            errorBox.textContent = err.message;
                            button.disabled = false;
                        }
                    },
                }, 'Add'),
            ],
        });
        if (created) reload();
    }

    /**
     * Installing a .docx template.
     *
     * Sent as a raw body rather than multipart, matching how document upload
     * already works here — the file name and target travel in the query string.
     */
    async function uploadTemplate(entry) {
        const input = h('input', { type: 'file', accept: '.docx' });
        input.click();
        await new Promise((resolve) => { input.onchange = resolve; });
        const file = input.files?.[0];
        if (!file) return;
        try {
            // The raw bytes go in the body; the target and name travel in the
            // query string, the same shape api.upload already uses.
            const query = new URLSearchParams({ key: entry.key, name: file.name });
            const result = await api.post(`/api/document-templates?${query}`, await file.arrayBuffer());
            if (result?.warning) {
                toast(`${entry.label} template installed, but not safe: ${result.warning}`, 'error');
            } else {
                toast(`${entry.label} template installed.`, 'success');
            }
            reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    // Painted immediately with what we have, then again once the templates
    // arrive — a Settings page that waits on a secondary fetch before showing
    // anything is a page that looks broken on a slow connection.
    paint();
    loadTemplates().then(paint);
    return undefined;
}

const PROJECTABLE = [
    ['lifecycle_changed', 'Lifecycle changed'],
    ['stage_changed', 'Deal stage changed'],
    ['verdict_computed', 'Verdict computed or changed'],
    ['owner_changed', 'Owner changed'],
    ['deal_won', 'Deal won'],
    ['deal_lost', 'Deal lost'],
    ['proposal_issued', 'Proposal issued'],
    ['agreement_signed', 'Agreement signed'],
    ['created', 'Record created'],
    ['updated', 'Any field change (noisy)'],
    ['exported', 'Export performed'],
];
