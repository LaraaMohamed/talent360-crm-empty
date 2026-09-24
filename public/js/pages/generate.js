/**
 * Generating a proposal or an agreement.
 *
 * One dialog, three entry points — the account page, a deal, and the Proposals
 * and Agreements lists in the sidebar. It used to live inside the account
 * page's closure, which is why the sidebar's "+ New proposal" could not reach it
 * and opened a blank form instead: a title, a number and a currency typed by
 * hand, producing a record with no document and no company behind it. That form
 * is what "a separate disconnected copy of company information" meant.
 *
 * ── THE ACCOUNT IS THE SOURCE, NOT A STARTING POINT ─────────────────────────
 *
 * Every company fact the document prints is read from the account: its name,
 * its legal (usually Arabic) name, its commercial registration, its
 * representative and address, its contacts. None of it is re-entered here. The
 * one block that IS editable in this dialog — the commercial registration — is
 * saved to the ACCOUNT, because every agreement for a client names the same
 * company and signatory, and asking again per document is how two contracts end
 * up disagreeing about who signed.
 *
 * ── THE SERVICE FLOWS BACK ──────────────────────────────────────────────────
 *
 * Which documents exist at all is decided by the service lines the account
 * buys. That used to be a precondition — "Please add a service to this account
 * first" — and a dead end for anybody who started from the sidebar. It is now a
 * step: choose the service here, and it is written to the account through the
 * ordinary record update, so the account page, the dashboard, deals and reports
 * all see the relationship rather than it living on this screen.
 *
 *   choose account → choose service → choose document → configure → review
 *
 * The steps that already have an answer are skipped: an account page supplies
 * the account, a deal supplies the service line, and "New version" supplies the
 * document type.
 */
import { h, mount, modal, drawer, confirm, toast, parseTypedDate } from '../core.js';
import { api } from '../api.js';
import { fieldControl, skeletonRows } from '../components.js';

/**
 * @param {object}  o
 * @param {?string} o.accountId    known account, or null to ask for one
 * @param {?string} o.dealId       when generating from a deal
 * @param {?string} o.preselectType a DOCUMENT_TYPES key, to skip the choose step
 * @param {?string} o.category     'proposal' | 'agreement', to narrow the choices
 * @param {?string} o.title        dialog title suffix
 * @returns the generation result, or undefined if cancelled
 */
export async function generateDocumentDialog({
    accountId = null, dealId = null, preselectType = null, category = null, title = null,
} = {}) {
    const fromDeal = Boolean(dealId);

    let account = accountId;
    let options = null;
    let step = account ? 'loading' : 'account';
    let error = null;

    let chosen = null;
    let values = {};
    let services = [];          // HCM scopes inside the document
    let serviceLines = [];      // what the account buys — hcm, offshoring
    let contactId = null;
    let registration = {};
    let registrationDirty = false;
    let preview = null;
    let busy = false;
    /**
     * Whether the user has entered anything worth keeping. Set on the first
     * edit, so clicking out of the dialog asks before throwing it away instead
     * of silently discarding a half-written document. Cleared on a successful
     * generation, when there is nothing left to lose.
     */
    let dirty = false;
    const markDirty = () => { dirty = true; };

    const bodyWrap = h('div.stack');
    const footWrap = h('div.row', { style: { gap: 'var(--space-2)', width: '100%' } });
    let closeDialog = () => {};

    /* ------------------------------------------------------------ loading -- */

    /**
     * `advance` distinguishes the two reasons for loading: arriving at an
     * account, which stops at the service step, and coming back from it having
     * just changed the services, which must not land on the step it came from.
     */
    async function loadOptions({ advance = false } = {}) {
        step = 'loading';
        error = null;
        render();
        try {
            options = await api.get(fromDeal
                ? `/api/deals/${dealId}/document-options`
                : `/api/accounts/${account}/document-options`);
        } catch (err) {
            error = err.message;
            step = account ? 'error' : 'account';
            render();
            return;
        }

        serviceLines = [...(options.account?.serviceLines ?? [])];
        services = [...(options.selectedServices ?? [])];
        registration = { ...(options.registration ?? {}) };
        // The account already carries a CR number of its own. Offering it here
        // beats asking for a number the record in front of us already holds —
        // and two fields quietly disagreeing is the duplication worth avoiding.
        if (!registration.cr_number && options.account?.cr_number) {
            registration.cr_number = options.account.cr_number;
        }
        registrationDirty = false;

        // A deal names its own service line, so there is nothing to choose.
        step = (fromDeal || advance) ? afterService() : 'service';
        render();
    }

    /** Where to go once the service is settled: straight past choosing when we know. */
    function afterService() {
        const usable = usableTypes();
        if (!usable.length) return 'notemplates';
        const wanted = preselectType && usable.find((t) => t.key === preselectType);
        chosen = wanted ?? chosen ?? usable[0];
        values = { ...(options.prefills[chosen.key] ?? {}) };
        return wanted ? 'configure' : 'choose';
    }

    const offeredTypes = () => (category
        ? (options?.types ?? []).filter((t) => t.category === category)
        : (options?.types ?? []));
    const usableTypes = () => offeredTypes().filter((t) => t.template);

    /* -------------------------------------------------------------- steps -- */

    const accountStep = () => h('div.stack',
        h('p.muted', 'Which company is this document for?'),
        error && h('div.note-box.danger', error),
        h('div.field',
            h('label', 'Account', h('span.req', ' *')),
            fieldControl('proposal', { key: 'account_id', type: 'reference', label: 'Account' }, account,
                (value) => {
                    account = value || null;
                    if (account) loadOptions();
                }),
            h('span.help', 'Everything the document says about the client is read from this account — '
                + 'its name, registration, representative and address. None of it is typed again here.'),
        ),
    );

    /**
     * The account's own summary. Read-only on purpose: this dialog writes
     * documents, and a company detail that is wrong is wrong on the account, not
     * on one proposal.
     */
    const accountPanel = () => {
        const a = options?.account;
        if (!a) return null;
        const rows = [
            ['Account', a.name],
            ['Legal name', a.legal_name],
            ['Lifecycle', a.lifecycle_stage],
            ['Industry', a.industry],
            ['Location', [a.city, a.country].filter(Boolean).join(', ')],
            ['Phone', a.phone],
            ['Website', a.website || a.domain],
            ['CR number', registration.cr_number || a.cr_number],
            ['Representative', registration.representative_name],
            ['Address', registration.address],
            ['Services', serviceLines.join(', ')],
        ].filter(([, value]) => value);

        return h('div.note-box',
            h('div.row', { style: { gap: 'var(--space-2)', alignItems: 'baseline' } },
                h('span.strong.small', 'From the account'),
                h('div.spacer'),
                h('a.xs', { href: `/accounts/${a.id}` }, 'open ↗'),
            ),
            h('dl.detail-list', { style: { marginBlockStart: 'var(--space-2)' } },
                rows.flatMap(([label, value]) => [
                    h('dt', label),
                    h('dd', { dir: 'auto' }, String(value)),
                ])),
        );
    };

    /**
     * The service the client is buying, chosen here and written to the account.
     *
     * Pre-checked from what the account already has, so for an existing client
     * this is one click. For a new one it is the step that used to be a refusal.
     */
    const serviceStep = () => h('div.stack',
        accountPanel(),
        h('p.muted', 'Which service is this for?'),
        error && h('div.note-box.danger', error),
        !(options.serviceLines ?? []).length && h('div.note-box.danger',
            'This workspace has no service lines configured, so there is nothing to sell and no document '
            + 'to write. They are seeded by ', h('code', 'setup.mjs'), '.'),
        h('div.stack', { style: { gap: 'var(--space-1)' } },
            (options.serviceLines ?? []).map((line) => h('label.row', { style: { gap: 'var(--space-2)' } },
                h('input', {
                    type: 'checkbox',
                    checked: serviceLines.includes(line.key),
                    onchange: (e) => {
                        serviceLines = e.target.checked
                            ? [...serviceLines, line.key]
                            : serviceLines.filter((k) => k !== line.key);
                    },
                }),
                h('span', line.label),
            )),
        ),
        h('span.help', 'Saved to the account, not to this document. It is the commercial relationship, '
            + 'so the account page, the dashboard, deals and reports all read it from there.'),
    );

    const notemplatesStep = () => h('div.stack',
        accountPanel(),
        h('p.strong', 'No template is installed for the documents this account can have.'),
        h('div.note-box',
            'Settings → Documents. The templates are the ones in ',
            h('code', 'Automation/'), ' — the same files the Apps Script generator uses.'),
        offeredTypes().some((t) => t.blockers?.length) && h('ul.stack.tight',
            offeredTypes().flatMap((t) => (t.blockers ?? []).map((b) => h('li.xs.dim', b)))),
    );

    const errorStep = () => h('div.note-box.danger', error ?? 'Something went wrong.');

    /**
     * "No commercial registration" is a fact about the ACCOUNT, not about any
     * one document type — so when the account offers both an HCM and an
     * Offshoring proposal and neither type's account has one, the identical
     * sentence used to print once under EACH button. Two (or more) copies of
     * the same paragraph, one after another, read as the page having broken
     * rather than as one blocker shared by two choices. Said once, above the
     * list, with the one action that actually clears it for every type at
     * once; each button keeps only what is genuinely its own reason (a
     * missing template).
     */
    const chooseStep = () => {
        const types = offeredTypes();
        const isRegistrationBlocker = (b) => b.includes('commercial registration');
        const missingRegistration = types.some((t) => t.blockers.some(isRegistrationBlocker));
        return h('div.stack',
            accountPanel(),
            h('p.muted', 'Which document is this?'),
            missingRegistration && options?.account && h('div.note-box.warning',
                'No commercial registration has been recorded for this account yet. Add it so the first-party '
                + 'details can be filled in automatically. ',
                h('a', { href: `/accounts/${options.account.id}` }, 'Open the account →')),
            h('div.stack', { style: { gap: 'var(--space-2)' } },
                types.map((type) => {
                    const blocked = !type.template || type.blockers.length > 0;
                    const ownBlockers = type.blockers.filter((b) => !isRegistrationBlocker(b));
                    return h('button.btn.block', {
                        class: blocked ? 'ghost' : '',
                        disabled: !type.template,
                        style: { textAlign: 'start', height: 'auto', padding: 'var(--space-3)' },
                        onclick: () => selectType(type),
                    },
                    h('div.row', { style: { gap: 'var(--space-2)' } },
                        h('span.strong', type.label),
                        h('span.badge', type.category),
                        type.hasServiceSelection && h('span.badge.accent', 'scopes'),
                    ),
                    ownBlockers.length
                        ? h('div.xs.dim', { style: { marginBlockStart: 'var(--space-1)' } }, ownBlockers.join(' '))
                        : type.template
                            ? h('div.xs.dim', { style: { marginBlockStart: 'var(--space-1)' } },
                                `Template ${type.template.label} v${type.template.version}`)
                            : null,
                    );
                }),
            ),
        );
    };

    const selectType = (type) => {
        chosen = type;
        values = { ...(options.prefills[type.key] ?? {}) };
        preview = null;
        step = 'configure';
        render();
    };

    /**
     * A field is hidden when its own rule says it does not apply.
     *
     * Checked `field.requiredWithRecruitment` — a property no field
     * definition has ever carried (the registry calls it `requiredIf`, a
     * function — see lib/document-types.mjs). Always undefined, so this
     * always returned true and "Employees To Hire" showed on every HCM
     * document regardless of scope, asking a question whose answer would
     * never be printed the moment Recruitment wasn't even selected.
     */
    const fieldApplies = (field) => typeof field.requiredIf !== 'function'
        || !chosen.hasServiceSelection
        || field.requiredIf(services);

    // The two parts of the configure step that a scope toggle changes. Held as
    // nodes and updated in place rather than re-rendered, because a handler that
    // destroys the element currently dispatching its own event loses the rest of
    // that event — the checkbox that was just clicked is detached mid-flight and
    // the click continues into its replacement. The symptom was one click
    // clearing the whole selection.
    const countNode = h('span.xs.dim');
    const fieldsNode = h('div.stack');

    const scopesChanged = () => {
        markDirty();
        preview = null;
        countNode.textContent = `${services.length} of ${options.services.length} selected`;
        mount(fieldsNode, fieldControls());
    };

    const scopeBoxes = [];

    const setAllScopes = (on) => {
        services = on ? options.services.map((s) => s.key) : [];
        for (const box of scopeBoxes) box.checked = on;
        scopesChanged();
    };

    const scopeField = () => {
        if (!chosen.hasServiceSelection) return null;
        scopeBoxes.length = 0;
        return h('div.field',
            h('label', 'Service scopes included'),
            h('div.row', { style: { gap: 'var(--space-2)' } },
                h('button.btn.sm.ghost', { type: 'button', onclick: () => setAllScopes(true) }, 'All'),
                h('button.btn.sm.ghost', { type: 'button', onclick: () => setAllScopes(false) }, 'None'),
                countNode,
            ),
            h('div.stack', { style: { gap: 'var(--space-1)', marginBlockStart: 'var(--space-2)' } },
                options.services.map((svc) => {
                    const box = h('input', {
                        type: 'checkbox',
                        checked: services.includes(svc.key),
                        onchange: (e) => {
                            services = e.target.checked
                                ? [...services, svc.key]
                                : services.filter((k) => k !== svc.key);
                            scopesChanged();
                        },
                    });
                    scopeBoxes.push(box);
                    return h('label.row', { style: { gap: 'var(--space-2)' } },
                        box,
                        h('span', svc.label),
                        h('span.xs.dim', { dir: 'rtl' }, svc.labelAr));
                }),
            ),
            h('span.help', 'Only the checked scopes appear in the document. The rest are removed outright and '
                + 'the survivors renumber, so there is never a gap in the numbering.'),
        );
    };

    /**
     * The fields, which depend on the scope selection: "Employees To Hire"
     * exists only when Recruitment is on, exactly as `requiredIf` says in the
     * registry. Asking for it otherwise is asking a question whose answer will
     * never be printed.
     */
    const fieldControls = () => [
        chosen.fields.filter(fieldApplies).map((field) => h('div.field',
            h('label', field.label,
                (field.required || (typeof field.requiredIf === 'function' && field.requiredIf(services)))
                    && h('span.req', ' *')),
            h('input.input', {
                // Dates are typed, not clicked through. `<input type="date">`
                // is three two-digit segments, which is why a date could not be
                // written straight out; parseTypedDate reduces what was typed
                // on blur. See public/js/core.js.
                type: field.type === 'number' ? 'number' : 'text',
                inputmode: field.type === 'date' ? 'numeric' : undefined,
                placeholder: field.type === 'date' ? 'YYYY-MM-DD' : undefined,
                dir: 'auto',
                value: values[field.key] ?? '',
                onblur: field.type === 'date' ? (e) => {
                    const parsed = parseTypedDate(e.target.value);
                    if (parsed && parsed !== e.target.value) {
                        e.target.value = parsed;
                        values[field.key] = parsed;
                        derived.delete(field.key);
                        markDirty();
                        if (applyDerivedDates(field.key)) mount(fieldsNode, fieldControls());
                    }
                } : undefined,
                oninput: (e) => {
                    values[field.key] = e.target.value;
                    markDirty();
                    preview = null;
                    // Typing in a derived field claims it: a later change to the
                    // start date must not quietly overwrite a term somebody set
                    // deliberately.
                    derived.delete(field.key);
                    if (applyDerivedDates(field.key)) mount(fieldsNode, fieldControls());
                },
            }),
            field.hint && h('span.help', field.hint),
        )),
        options.contacts?.length ? h('div.field',
            h('label', 'Primary contact'),
            h('select.input', {
                onchange: (e) => { contactId = e.target.value || null; markDirty(); },
            }, [
                h('option', { value: '' }, '— none —'),
                ...options.contacts.map((c) => h('option', {
                    value: c.id, selected: c.id === contactId,
                }, `${c.full_name || `${c.first_name} ${c.last_name}`.trim()}${c.title ? ` · ${c.title}` : ''}`)),
            ]),
            h('span.help', 'Recorded against the generation. None of the four templates prints a contact name, '
                + 'so this does not appear in the document.'),
        ) : null,
    ];

    /**
     * Fill in a date the registry says is derived — end date from start date, on
     * the inclusive-term convention: start + N years − 1 day.
     *
     * The server does this too, but it can only do it when a start date already
     * exists, which on a first agreement it does not. So the hint said
     * "calculated automatically" and then the field sat empty and refused to
     * generate. Offered, not imposed: an end date somebody has typed is left
     * alone, because not every contract runs a year.
     */
    const derived = new Set();

    function applyDerivedDates(changedKey) {
        let touched = false;
        for (const field of chosen.fields) {
            if (field.autoCalcFrom !== changedKey) continue;
            const start = values[changedKey];
            if (values[field.key] && !derived.has(field.key)) continue;   // theirs, not ours
            if (!start) continue;

            const end = new Date(`${String(start).slice(0, 10)}T12:00:00Z`);
            if (Number.isNaN(end.getTime())) continue;
            end.setUTCFullYear(end.getUTCFullYear() + (Number(options.contractYears) || 1));
            end.setUTCDate(end.getUTCDate() - 1);

            values[field.key] = end.toISOString().slice(0, 10);
            derived.add(field.key);
            touched = true;
        }
        return touched;
    }

    /** The five certificate details, when the chosen document prints them. */
    const REGISTRATION_FIELDS = [
        { key: 'company_name_ar', label: 'Company name (Arabic)', dir: 'rtl',
            hint: 'As written on the certificate. Prints as the client name; falls back to the account name.' },
        { key: 'cr_number', label: 'Commercial registration number' },
        { key: 'representative_name', label: 'Representative name', required: true, dir: 'auto',
            hint: 'The person who signs on the client’s behalf.' },
        { key: 'address', label: 'Company address', dir: 'auto' },
    ];

    const registrationFields = () => h('div.stack',
        h('div.row', { style: { gap: 'var(--space-2)' } },
            h('span.strong', 'Commercial registration'),
            h('span.xs.dim', 'Saved to the account — entered once, not per document'),
        ),
        ...REGISTRATION_FIELDS.map((field) => h('div.field',
            h('label', field.label, field.required && h('span.req', ' *')),
            h('input.input', {
                dir: field.dir ?? 'auto',
                value: registration[field.key] ?? '',
                oninput: (e) => {
                    registration[field.key] = e.target.value;
                    registrationDirty = true;
                    markDirty();
                    preview = null;
                },
            }),
            field.hint && h('span.help', field.hint),
        )),
    );

    const configureStep = () => {
        const scopes = scopeField();
        countNode.textContent = `${services.length} of ${options.services.length} selected`;
        mount(fieldsNode, fieldControls());
        return h('div.stack',
            accountPanel(),
            h('div.row', { style: { gap: 'var(--space-2)' } },
                h('span.strong', chosen.label),
                h('span.xs.dim', `Template ${chosen.template.label} v${chosen.template.version}`),
            ),
            scopes,
            fieldsNode,
            chosen.requiresCommercialRegistration ? registrationFields() : null,
        );
    };

    /**
     * Written before the preview, so what the preview shows is what the account
     * actually holds — not a value living only in this dialog that would vanish
     * if it were closed.
     */
    async function saveRegistration() {
        if (!registrationDirty || !chosen.requiresCommercialRegistration) return;
        const saved = await api.put(`/api/accounts/${options.account.id}/commercial-registration`, registration);
        registration = { ...(saved.registration ?? registration) };
        options.registration = registration;
        registrationDirty = false;
    }

    /**
     * The service selection, written to the account before anything else.
     *
     * Through the ordinary record update, so it is validated, audited and
     * reindexed exactly like somebody editing the field on the account page —
     * which is the point: it is the same fact, in the same place.
     */
    async function saveServiceLines() {
        const before = [...(options.account?.serviceLines ?? [])].sort().join(',');
        const after = [...serviceLines].sort().join(',');
        if (before === after) return;
        await api.patch(`/api/accounts/${options.account.id}`, { services: serviceLines });
    }

    const reviewStep = () => {
        if (!preview) return h('div.card-body.flush', skeletonRows(4));

        const missing = preview.variables.filter((v) => v.missing && v.required);
        return h('div.stack',
            preview.problems.length ? h('div.note-box.danger',
                h('div.strong', 'This document cannot be generated yet:'),
                h('ul', { style: { marginBlockStart: 'var(--space-1)', paddingInlineStart: 'var(--space-4)', listStyle: 'disc' } },
                    preview.problems.map((p) => h('li', p))),
            ) : null,
            preview.leftoverTokens.length ? h('div.note-box.danger',
                `The template still contains ${preview.leftoverTokens.join(', ')} after filling it in. `
                + 'Nothing will be saved until that is resolved — the placeholder has no value behind it.',
            ) : null,
            h('div.row', { style: { gap: 'var(--space-2)' } },
                h('span.strong', `${preview.label} v${preview.nextVersion}`),
                h('span.xs.dim', `${preview.variables.length} variables`),
                missing.length
                    ? h('span.badge.danger', `${missing.length} missing`)
                    : h('span.badge.success', 'complete'),
            ),
            h('div.table-wrap', h('table.data',
                h('thead', h('tr',
                    h('th', 'Variable'), h('th', 'Source'), h('th', 'Value'),
                )),
                h('tbody', preview.variables.map((variable) => h('tr',
                    { class: variable.missing && variable.required ? 'row-danger' : '' },
                    h('td',
                        h('div', variable.label),
                        h('code.xs.dim', `{{${variable.key}}}`),
                    ),
                    h('td',
                        h('div.xs', variable.sourceLabel),
                        h('div.xs.dim', variable.detail),
                    ),
                    h('td', { dir: 'auto' },
                        // A value the user can still fix is fixed here rather
                        // than by sending them back a step.
                        variable.fieldKey
                            ? [
                                h('input.input.sm', {
                                    value: values[variable.fieldKey] ?? '',
                                    oninput: (e) => { values[variable.fieldKey] = e.target.value; markDirty(); },
                                    onblur: (e) => {
                                        // The same typed-date reading the
                                        // configure step applies: a date edited
                                        // here must arrive at the server as a
                                        // date, not as the text it was typed in.
                                        const field = chosen.fields.find((f) => f.key === variable.fieldKey);
                                        if (field?.type === 'date') {
                                            const parsed = parseTypedDate(e.target.value);
                                            if (parsed && parsed !== e.target.value) {
                                                e.target.value = parsed;
                                                values[variable.fieldKey] = parsed;
                                            }
                                        }
                                    },
                                    onchange: () => refreshPreview(),
                                }),
                                // What the DOCUMENT will read, when that is not
                                // character-for-character what was typed — a fee
                                // entered as 52000 prints as 52,000.
                                !variable.missing && variable.value !== String(values[variable.fieldKey] ?? '')
                                    && h('div.xs.dim', `prints as ${variable.value}`),
                            ]
                            : variable.missing
                                ? h('span.badge.danger', variable.required ? 'missing' : 'empty')
                                : h('span', variable.value),
                    ),
                ))),
            )),
            h('div.note-box',
                `Generating creates ${preview.label} v${preview.nextVersion} and never replaces an earlier `
                + `version. It is attached to ${preview.account.name}`,
                preview.deal ? ` and to ${preview.deal.name}` : '',
                '.'),
        );
    };

    async function refreshPreview() {
        /**
         * NOT blanked to null, and NOT re-rendered here, when a preview
         * already exists. `render()` fully rebuilds the DOM under it every
         * time (no diffing) — the whole review table used to be torn down
         * and swapped for a skeleton loader for EVERY field fixed in place,
         * which is the review step's whole point, so editing one value read
         * as the dialog reloading itself on each edit. The one case this
         * still shows a skeleton is the FIRST call, entering the step fresh
         * with nothing to show yet (`preview` starts `null`) — a refresh of
         * an existing preview instead keeps the old table on screen,
         * untouched, until the new one is ready to replace it in one go.
         */
        if (!preview) render();
        try {
            preview = await api.post(`/api/accounts/${options.account.id}/documents/preview`, {
                documentType: chosen.key,
                fields: values,
                services: chosen.hasServiceSelection ? services : null,
                dealId,
            });
        } catch (err) {
            preview = {
                label: chosen.label, nextVersion: '?', variables: [], leftoverTokens: [],
                account: { name: options.account?.name ?? '' }, deal: null,
                problems: err.payload?.problems ?? [err.message], ok: false,
            };
        }
        render();
    }

    /* ------------------------------------------------------------- chrome -- */

    /** Only the steps this run actually has, numbered as the user meets them. */
    function stepList() {
        return [
            !accountId && 'account',
            !fromDeal && 'service',
            'choose', 'configure', 'review',
        ].filter(Boolean);
    }

    function body() {
        switch (step) {
            case 'loading': return h('div.card-body.flush', skeletonRows(4));
            case 'account': return accountStep();
            case 'service': return serviceStep();
            case 'notemplates': return notemplatesStep();
            case 'error': return errorStep();
            case 'choose': return chooseStep();
            case 'configure': return configureStep();
            case 'review': return reviewStep();
            default: return null;
        }
    }

    function back() {
        if (step === 'review') return 'configure';
        if (step === 'configure') return usableTypes().length > 1 ? 'choose' : (fromDeal ? null : 'service');
        if (step === 'choose' || step === 'notemplates') return fromDeal ? null : 'service';
        if (step === 'service') return accountId ? null : 'account';
        return null;
    }

    function render() {
        const steps = stepList();
        mount(bodyWrap,
            steps.includes(step) && h('div.row', { style: { gap: 'var(--space-2)', marginBlockEnd: 'var(--space-2)' } },
                steps.map((name, i) => h('span.badge', {
                    class: name === step ? 'accent' : '',
                }, `${i + 1}. ${name[0].toUpperCase()}${name.slice(1)}`)),
            ),
            body(),
        );

        const previous = back();
        mount(footWrap,
            h('button.btn', { onclick: () => closeDialog(undefined) }, 'Cancel'),
            h('div.spacer'),
            previous && h('button.btn', {
                onclick: () => { step = previous; render(); },
            }, 'Back'),

            step === 'service' && h('button.btn.primary', {
                onclick: async (event) => {
                    const button = event.currentTarget;
                    if (!serviceLines.length) {
                        error = 'Choose at least one service — it decides which documents this client can have.';
                        return render();
                    }
                    button.disabled = true;
                    try {
                        await saveServiceLines();
                    } catch (err) {
                        button.disabled = false;
                        error = err.message;
                        return render();
                    }
                    // Re-read: the account's services decide which document types
                    // exist, so the list is fetched again rather than guessed at.
                    await loadOptions({ advance: true });
                    return undefined;
                },
            }, 'Continue →'),

            step === 'configure' && h('button.btn.primary', {
                onclick: async (event) => {
                    const button = event.currentTarget;
                    button.disabled = true;
                    try {
                        await saveRegistration();
                    } catch (err) {
                        button.disabled = false;
                        toast(err.message, 'error');
                        return;
                    }
                    step = 'review';
                    refreshPreview();
                },
            }, 'Review variables →'),

            step === 'review' && h('button.btn.primary', {
                disabled: busy || !preview || !preview.ok,
                onclick: async (event) => {
                    busy = true;
                    event.target.disabled = true;
                    event.target.textContent = 'Generating…';
                    try {
                        // The dialog is closing with a real result — there is
                        // nothing left to lose, so the discard guard stands down.
                        dirty = false;
                        closeDialog(await api.post(`/api/accounts/${options.account.id}/documents`, {
                            documentType: chosen.key,
                            fields: values,
                            services: chosen.hasServiceSelection ? services : null,
                            contactId,
                            dealId,
                        }));
                    } catch (err) {
                        busy = false;
                        // The server returns every problem at once; showing them
                        // as a list is the whole point of collecting them.
                        preview = { ...preview, ok: false, problems: err.payload?.problems ?? [err.message] };
                        render();
                    }
                },
            }, 'Generate'),
        );
    }

    render();
    if (account) loadOptions();

    return drawer({
        title: title ? `Generate document · ${title}` : 'Generate document',
        body: bodyWrap,
        footer: footWrap,
        onOpen: (_dialog, close) => { closeDialog = close; },
        /**
         * Clicking out — Escape, the backdrop or the ✕ — used to throw away
         * everything typed in the dialog. Ask before discarding once there is
         * work to lose; an empty dialog still closes in one click.
         */
        closeGuard: () => {
            if (!dirty) return true;
            return confirm({
                title: 'Discard this document?',
                message: 'You have entered details that have not been generated. Closing now loses them.',
                confirmLabel: 'Discard',
                danger: true,
            });
        },
    });
}
