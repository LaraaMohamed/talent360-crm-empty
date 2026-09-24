/**
 * The import page — bulk add, for any object.
 *
 * ── WHY IT IS SHAPED LIKE THIS ──────────────────────────────────────────────
 * The brief calls the importer "probably the most polished page", and it is
 * right: it is the first thing an evaluator tries and the first thing that
 * loses their trust. Every competitor makes you commit before revealing the
 * consequences. Here the counts come first.
 *
 *   1  Choose      what am I importing, and from where
 *   2  Map         auto-mapped from the VALUES, with three samples per column
 *   3  Preview     exact counts — create · update · skip · reject, with reasons
 *   4  Run         the same walk, writing
 *   5  Summary     kept, revisitable, with a rejected-rows CSV and an undo
 *
 * The file stays in the browser between steps. The server is not holding a
 * half-configured import for you, so a refresh loses nothing but your place.
 */
import {
    h, mount, navigate, toast, modal, confirm, number, date, relative, humanise,
    captureFocus, restoreFocus,
} from '../core.js';
import { api } from '../api.js';
import * as store from '../store.js';
import { emptyState, skeletonRows, statTile, icon, fieldControl } from '../components.js';
import { setPageTitle } from '../app.js';

const IMPORTABLE = ['account', 'contact', 'deal', 'campaign', 'task', 'prospecting_company', 'prospecting_contact'];

/**
 * An in-progress import survives leaving the page — a client search, a
 * ringing phone, a wrong nav click — and coming back to it.
 *
 * `sessionStorage`, not `localStorage`: this is "don't lose what I was
 * doing a minute ago," not a permanent draft. It clears itself when the
 * tab actually closes, which is the right lifetime for a half-mapped CSV
 * nobody meant to keep forever. Only the CHOICES are stored (mapping,
 * defaults, which file) — `profile` (column samples/suggestions) is
 * re-fetched from the same text on restore rather than duplicated in
 * storage, and `preview`/`result` are re-derived by the normal Preview
 * step rather than restored, so this never hands back stale counts.
 */
const DRAFT_KEY = 'crm-import-draft';

function saveDraft(state) {
    // Nothing chosen yet, or already finished — nothing worth remembering.
    if (state.step !== 'map' && state.step !== 'preview') {
        try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
        return;
    }
    try {
        sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
            workflow: state.workflow, objectKey: state.objectKey, filename: state.filename,
            source: state.source, text: state.text, mapping: state.mapping, defaults: state.defaults,
            extraDefaultKeys: [...state.extraDefaultKeys], duplicateStrategy: state.duplicateStrategy,
        }));
    } catch {
        // Quota exceeded (a very large pasted file) or storage disabled —
        // losing the recovery draft is a much smaller problem than crashing
        // the page over it.
    }
}

/** Restores a draft's CHOICES, then re-derives `profile` from the same text — never trusts stored server output as still current. */
async function restoreDraft(state) {
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null'); } catch { saved = null; }
    if (!saved?.text) return;

    state.workflow = saved.workflow ?? state.workflow;
    state.objectKey = saved.objectKey ?? state.objectKey;
    state.filename = saved.filename ?? state.filename;
    state.source = saved.source ?? state.source;
    state.text = saved.text;
    state.mapping = saved.mapping ?? {};
    state.defaults = saved.defaults ?? {};
    state.extraDefaultKeys = new Set(saved.extraDefaultKeys ?? []);
    state.duplicateStrategy = saved.duplicateStrategy ?? state.duplicateStrategy;

    try {
        state.profile = state.workflow === 'customers'
            ? await api.postText('/api/import/customers/profile', state.text)
            : await api.postText(`/api/import/profile?object=${state.objectKey}`, state.text);
        // Always lands on Map, whichever step it was saved from — Preview's
        // own counts are cheap to re-run and must never be shown stale.
        state.step = 'map';
        toast('Picked up where you left off.', 'success');
    } catch {
        // The file itself is still fine; only the server round-trip failed.
        // Leave it on Choose rather than losing the recovered text.
        state.step = 'choose';
    }
}

export async function importPage(content) {
    setPageTitle('Import');
    const container = h('div.content-inner');
    mount(content, container);

    const state = {
        // 'prospects' is the existing, object-at-a-time importer above.
        // 'customers' is the Existing Customers workflow: one file, one
        // mapping, and an Account + Contact + Deal + Agreement written
        // together per row. See lib/import-customers.mjs for why this is a
        // separate engine rather than a fifth entry in IMPORTABLE.
        workflow: 'prospects',
        step: 'choose',
        objectKey: 'contact',
        filename: null,
        text: null,
        profile: null,
        mapping: {},
        columnSearch: '',
        defaults: {},
        // Optional fields the user has chosen to prior-set a value for — a
        // service line on every row, an account type that is not in the file
        // at all. Required-but-unmapped fields are ALWAYS shown (see
        // `unmappedRequired`); this is the same panel opened up to fields
        // that are not required, entered on request rather than by default,
        // because most optional fields nobody wants to set a batch value for.
        extraDefaultKeys: new Set(),
        // Values this workspace already uses for a field, fetched once per
        // field, plus which fields the user has explicitly chosen to answer
        // with something not on that list.
        knownValues: {},
        otherMode: {},
        duplicateStrategy: 'update',
        preview: null,
        result: null,
        batches: [],
        busy: false,
    };

    async function loadBatches() {
        const data = await api.get('/api/import/batches');
        state.batches = data.batches;
    }

    function paint() {
        saveDraft(state);
        const customers = state.workflow === 'customers';
        mount(container,
            h('div.card',
                h('div.card-header',
                    h('h2', 'Import'),
                    h('div.actions', h('span.xs.dim', 'Nothing is written until you press Run.')),
                ),
                h('div.card-body', stepper()),
            ),
            state.step === 'choose' ? chooseStep() : null,
            state.step === 'map' ? (customers ? mapStepCustomers() : mapStep()) : null,
            state.step === 'preview' ? (customers ? previewStepCustomers() : previewStep()) : null,
            state.step === 'done' ? (customers ? doneStepCustomers() : doneStep()) : null,
            state.step === 'choose' ? historyCard() : null,
        );
    }

    function stepper() {
        const steps = [
            ['choose', 'Choose a file'],
            ['map', 'Map the columns'],
            ['preview', 'Check what will happen'],
            ['done', 'Result'],
        ];
        const currentIndex = steps.findIndex(([key]) => key === state.step);
        return h('div.row', steps.map(([key, label], i) => h('span.chip', {
            class: key === state.step ? 'accent' : i < currentIndex ? '' : 'dim',
        }, `${i + 1}. ${label}`)));
    }

    /* ---- 1. choose ----------------------------------------------------- */

    function chooseStep() {
        const fileInput = h('input', {
            type: 'file', accept: '.csv,text/csv,text/plain',
            onchange: (e) => readFile(e.target.files[0]),
        });
        const pasteBox = h('textarea.input', {
            rows: 8, spellcheck: 'false',
            placeholder: 'name,domain,country\nAcme,acme.sa,Saudi Arabia',
        });

        const dropZone = h('div.dropzone', {
            ondragover: (e) => { e.preventDefault(); dropZone.classList.add('over'); },
            ondragleave: () => dropZone.classList.remove('over'),
            ondrop: (e) => {
                e.preventDefault();
                dropZone.classList.remove('over');
                const file = e.dataTransfer.files?.[0];
                if (file) readFile(file);
            },
            onclick: () => fileInput.click(),
        },
        h('div.strong', 'Drop a CSV here'),
        h('p.small.muted', 'or click to choose one. Parsed in your browser first — the counts you see come from '
            + 'the actual file, not an estimate.'),
        fileInput,
        );

        return h('div.card',
            h('div.card-header', h('h2', 'What are you importing?')),
            h('div.card-body',
                h('div.field',
                    h('label', 'Import type'),
                    h('div.stack.tight',
                        [
                            ['prospects', 'New Prospects', 'One object at a time — accounts, contacts, deals or another list. Lands in Prospecting, ready to be worked.'],
                            ['customers', 'Existing Customers', 'One file: Account, Contact, Deal and Agreement together, already an active customer — never sent through Prospecting or Cold Calling.'],
                        ].map(([value, label, help]) => h('label.checkbox',
                            h('input', {
                                type: 'radio', name: 'workflow', checked: state.workflow === value,
                                onchange: () => { state.workflow = value; paint(); },
                            }),
                            h('div', h('div.small.strong', label), h('div.xs.dim', help)),
                        )),
                    ),
                ),
                state.workflow === 'prospects' && h('div.field',
                    h('label', 'Into'),
                    h('select.input', {
                        onchange: (e) => { state.objectKey = e.target.value; },
                    }, IMPORTABLE.filter((k) => store.object(k)).map((k) => h('option', {
                        value: k, selected: k === state.objectKey,
                    }, store.object(k).plural))),
                    h('span.help', 'Custom fields on this object are importable too — they appear in the mapping list '
                        + 'automatically.'),
                ),
                dropZone,
                h('details', { style: { marginBlockStart: 'var(--space-4)' } },
                    h('summary.small', 'Or paste rows'),
                    h('div.stack', { style: { marginBlockStart: 'var(--space-2)' } },
                        pasteBox,
                        h('button.btn', {
                            onclick: () => {
                                const text = pasteBox.value.trim();
                                if (!text) return toast('Paste some rows first.', 'error');
                                return ingest(text, 'pasted rows', 'paste');
                            },
                        }, 'Use these rows'),
                    ),
                ),
            ),
        );
    }

    function readFile(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => ingest(String(reader.result), file.name, 'upload');
        reader.onerror = () => toast('That file could not be read.', 'error');
        // Read as UTF-8. A BOM is stripped by the parser, which builds it from
        // its code point rather than carrying an invisible character in source.
        reader.readAsText(file, 'utf-8');
    }

    async function ingest(text, filename, source) {
        state.text = text;
        state.filename = filename;
        state.source = source;
        state.busy = true;
        mount(container, skeletonRows(5));
        try {
            state.profile = state.workflow === 'customers'
                ? await api.postText('/api/import/customers/profile', text)
                : await api.postText(`/api/import/profile?object=${state.objectKey}`, text);
            state.mapping = { ...state.profile.mapping };
            state.step = 'map';
        } catch (err) {
            toast(err.message, 'error');
            state.step = 'choose';
        }
        state.busy = false;
        paint();
    }

    /* ---- 2. map -------------------------------------------------------- */

    /**
     * The mapping table.
     *
     * Three sample values sit beside every suggestion, because users verify a
     * mapping by recognising their data — not by reading header names. The
     * confidence and the REASON for each guess are shown for the same reason:
     * "95% of values look like email addresses" is checkable, "Email" is not.
     */
    /**
     * A value for a required field the file does not contain.
     *
     * Offered as CHOICES, not as an empty box. The workspace already has a
     * vocabulary for fields like Data source, and retyping it by hand is how
     * "LinkedIn export" quietly acquires a second spelling that no filter will
     * ever group with the first. Equally, the list is never the whole truth, so
     * "Other" is always present and always writes a genuinely custom value —
     * a fixed list that rejects a true-but-unlisted answer is how an import
     * ends up throwing away every row for no good reason.
     */
    // Types the object registry already has a real control for — a select,
    // a set of checkboxes, a date picker. Asking for "one value to use for
    // every row" is still a free-text box for these before this: Account
    // type offered whatever strings happened to already be in the data
    // (or nothing, on a brand new object) instead of Egypt/Regional, and
    // Services had no way to pick more than one. `fieldControl` is the
    // same renderer the record form and the filter builder already use for
    // every field type — reused here rather than reinventing checkbox/
    // select/date handling a third time.
    const STRUCTURED_DEFAULT_TYPES = new Set([
        'checkbox', 'select', 'multiselect', 'user', 'reference',
        'date', 'datetime', 'number', 'currency', 'percent', 'email', 'url', 'phone',
    ]);

    function defaultControl(f, repaint) {
        if (STRUCTURED_DEFAULT_TYPES.has(f.type)) {
            const controlId = `import-default-${f.key.replace(/\W/g, '_')}`;
            return h('div.field',
                f.type !== 'checkbox' && h('label', { for: controlId }, `Value for ${f.label}`),
                fieldControl(state.objectKey, f, state.defaults[f.key] ?? null, (value) => {
                    const empty = value === null || value === undefined || value === ''
                        || (Array.isArray(value) && value.length === 0);
                    if (empty) delete state.defaults[f.key]; else state.defaults[f.key] = value;
                    repaint();
                }, { id: controlId }),
            );
        }

        if (state.knownValues[f.key] === undefined) {
            state.knownValues[f.key] = null; // in flight — do not ask twice
            const route = store.object(state.objectKey)?.route;
            api.get(`/api/${route}/field-values?field=${encodeURIComponent(f.key)}`)
                .then((data) => { state.knownValues[f.key] = data.values.map((v) => v.value); repaint(); })
                .catch(() => { state.knownValues[f.key] = []; });
        }

        const options = state.knownValues[f.key] ?? [];
        const current = state.defaults[f.key] ?? '';
        const other = state.otherMode[f.key] === true || (current !== '' && !options.includes(current));
        const OTHER = '__crm_other__';

        const customBox = h('input.input', {
            dir: 'auto',
            value: current,
            placeholder: f.key === 'data_source' || f.key === 'source'
                ? 'e.g. LinkedIn export, March 2026'
                : `A value to use for every row`,
            dataset: { focusKey: `default:${f.key}` },
            oninput: (e) => {
                const value = e.target.value.trim();
                if (value) state.defaults[f.key] = value;
                else delete state.defaults[f.key];
            },
            // Only the summary line above depends on this, so it is repainted
            // on blur rather than per keystroke.
            onblur: () => repaint(),
        });

        return h('div.field',
            h('label', `Value for ${f.label}`),
            options.length > 0 && h('select.input', {
                dataset: { focusKey: `default-select:${f.key}` },
                onchange: (e) => {
                    const chosen = e.target.value;
                    if (chosen === OTHER) {
                        state.otherMode[f.key] = true;
                        delete state.defaults[f.key];
                    } else {
                        delete state.otherMode[f.key];
                        if (chosen) state.defaults[f.key] = chosen;
                        else delete state.defaults[f.key];
                    }
                    repaint();
                },
            },
            h('option', { value: '', selected: !other && current === '' }, '— choose a value —'),
            options.map((v) => h('option', { value: v, selected: !other && v === current }, v)),
            h('option', { value: OTHER, selected: other }, 'Other — type it below'),
            ),
            (options.length === 0 || other) && customBox,
            f.key === 'data_source' && h('span.help',
                'Required on contacts: personal data carries obligations a company record does not.'),
        );
    }

    /** Sentinel for the "create a field" option. Not a field key. */
    const NEW_FIELD = '__crm_new_field__';

    /**
     * Create a custom field without leaving the import.
     *
     * The type is GUESSED FROM THE VALUES, not from the header, for the same
     * reason the column detector is: a column called "Revenue" holding
     * "2024-03-01" is a date whatever it is titled, and getting this wrong
     * means every row fails validation later with a message about a field the
     * user just created.
     */
    async function createFieldForColumn(column, profile, repaint) {
        const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        const samples = (column.samples ?? []).filter(Boolean);
        const every = (test) => samples.length > 0 && samples.every(test);

        const guessed = every((s) => /^-?\d+(\.\d+)?$/.test(String(s).trim())) ? 'number'
            : every((s) => /^\d{4}-\d{2}-\d{2}/.test(String(s).trim())) ? 'date'
                : every((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s).trim())) ? 'email'
                    : every((s) => /^https?:\/\//i.test(String(s).trim())) ? 'url'
                        : 'text';

        let key = slug(column.name) || `column_${column.index + 1}`;
        if (/^\d/.test(key)) key = `f_${key}`;

        const draft = {
            object_key: state.objectKey,
            key,
            label: column.name || `Column ${column.index + 1}`,
            type: guessed,
            filterable: true,
            searchable: false,
            options: null,
        };
        const errorBox = h('div.error');

        const created = await modal({
            title: `New field for "${column.name || 'this column'}"`,
            body: h('div.stack',
                errorBox,
                h('div.field', h('label', 'Label'),
                    h('input.input', { dir: 'auto', value: draft.label, oninput: (e) => { draft.label = e.target.value; } })),
                h('div.field', h('label', 'Key'),
                    h('input.input', { value: draft.key, oninput: (e) => { draft.key = slug(e.target.value); } }),
                    h('span.help', `Filterable as properties.${draft.key}. Letters, numbers and underscores.`)),
                h('div.field', h('label', 'Type'),
                    h('select.input', { onchange: (e) => { draft.type = e.target.value; } },
                        ['text', 'textarea', 'number', 'currency', 'percent', 'date', 'datetime', 'select', 'multiselect', 'checkbox', 'url', 'email', 'phone']
                            .map((t) => h('option', { value: t, selected: t === guessed }, humanise(t)))),
                    h('span.help', samples.length
                        ? `Guessed ${humanise(guessed)} from this column's values: ${samples.slice(0, 3).join(', ')}`
                        : 'This column is empty, so the type could not be guessed.')),
                h('label.checkbox',
                    h('input', { type: 'checkbox', checked: true, onchange: (e) => { draft.filterable = e.target.checked; } }),
                    h('span', 'Filterable')),
                h('div.note-box',
                    'The field is created on ', h('strong', store.object(state.objectKey).plural),
                    ' immediately and this column is mapped to it. Nothing is imported until you press Run.'),
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
                }, 'Create and map'),
            ],
        });

        if (!created) return;

        // The new field has to appear in every other column's dropdown too, so
        // the profile's field list and the cached metadata are both refreshed.
        const fieldKey = `properties.${draft.key}`;
        await store.loadMeta().catch(() => {});
        profile.fields.push({
            key: fieldKey, label: draft.label, type: draft.type, custom: true, required: false,
        });
        state.mapping[column.index] = fieldKey;
        toast(`"${draft.label}" created and mapped.`, 'success');
        repaint();
    }

    function mapStep() {
        const p = state.profile;
        const fields = p.fields;

        // Required fields with no column. Deliberately NOT filtered by whether a
        // default has been supplied: the control has to stay on screen so the
        // answer can be changed, and a field that vanishes the moment you type
        // into it cannot be corrected.
        const unmappedRequired = () => fields
            .filter((f) => f.required && !Object.values(state.mapping).includes(f.key));
        // Optional fields the user has opted into prior-setting — a service
        // line, an account type the file does not carry — same rule: gone
        // from the list once a column is mapped to it, not once the box is
        // cleared, so a value in progress cannot be lost by a stray repaint.
        const unmappedExtras = () => fields
            .filter((f) => !f.required && state.extraDefaultKeys.has(f.key)
                && !Object.values(state.mapping).includes(f.key));

        const host = h('div');
        const repaint = () => {
            const missing = unmappedRequired();
            const extras = unmappedExtras();
            const blocking = missing.filter((f) => !state.defaults[f.key]);
            const focus = captureFocus(host);
            /**
             * `mount(host, ...)` rebuilds the mapping screen from scratch on
             * every repaint — picking a field to set a default for, adding
             * another one, an async field-values lookup resolving after the
             * fact. None of that is a page NAVIGATION, but a full DOM
             * rebuild with nothing focused afterward (see `captureFocus`
             * above — it only restores a KNOWN, tagged field, not scroll)
             * reads to the browser as "new page", and the shell's real
             * scroll container (`.content`, not `window` — see app.css)
             * snaps back to the top. Long mapping screens with several
             * required-field defaults made this look like the click itself
             * had teleported the page, when it was the repaint underneath
             * it.
             */
            const scroller = document.querySelector('.content');
            const scrollTop = scroller?.scrollTop ?? 0;
            // Search matches the source column's own name/samples, and the
            // CRM field it is (or would be) mapped to — so "email" finds both
            // a column literally called that and one already mapped to Email.
            const query = state.columnSearch.trim().toLowerCase();
            const visible = !query ? p.columns : p.columns.filter((column) => {
                const mappedField = fields.find((f) => f.key === state.mapping[column.index]);
                return column.name.toLowerCase().includes(query)
                    || column.samples.some((s) => String(s).toLowerCase().includes(query))
                    || mappedField?.label.toLowerCase().includes(query);
            });
            mount(host,
                query && !visible.length
                    ? h('div.note-box', { style: { marginBlockEnd: 'var(--space-3)' } },
                        `No column matches "${state.columnSearch.trim()}".`)
                    : null,
                h('div.table-wrap', h('table.data',
                    h('thead', h('tr',
                        h('th', 'Column in your file'), h('th', 'Sample values'), h('th', 'Imports into'), h('th', 'Why'),
                    )),
                    h('tbody', visible.map((column) => h('tr',
                        h('td',
                            h('div.strong.small', column.name),
                            h('div.xs.dim', `${number(column.filled)} of ${number(p.rows)} filled`),
                            column.blankHeader && h('span.badge.warning', 'blank header'),
                        ),
                        h('td', h('div.stack.tight',
                            column.samples.length
                                ? column.samples.map((s) => h('code.xs', { dir: 'auto' }, s))
                                : h('span.dim.xs', 'empty'),
                        )),
                        h('td', h('select.input', {
                            onchange: (e) => {
                                if (e.target.value === NEW_FIELD) {
                                    // Put the select back where it was; the
                                    // mapping only changes if the field is
                                    // actually created.
                                    e.target.value = state.mapping[column.index] ?? '';
                                    createFieldForColumn(column, p, repaint);
                                    return;
                                }
                                if (e.target.value) state.mapping[column.index] = e.target.value;
                                else delete state.mapping[column.index];
                                repaint();
                            },
                        },
                        h('option', { value: '' }, '— skip this column —'),
                        fields.map((f) => h('option', {
                            value: f.key,
                            selected: state.mapping[column.index] === f.key,
                        }, f.label + (f.required ? ' *' : '') + (f.custom ? ' (custom)' : ''))),
                        // A column with nowhere to go used to mean abandoning
                        // the import, creating the field in Settings, and
                        // starting again — so in practice it meant skipping the
                        // column and losing the data.
                        h('option', { value: NEW_FIELD }, '+ Create a new field…'),
                        )),
                        h('td.xs.dim', { style: { maxInlineSize: '16rem' } },
                            column.suggestion
                                ? [column.reason, h('div', h('span.badge', { class: column.confidence > 0.7 ? 'success' : 'warning' },
                                    `${Math.round(column.confidence * 100)}% sure`))]
                                : column.reason ?? '—'),
                    ))),
                )),

                missing.length > 0 && h(`div.note-box.${blocking.length ? 'warning' : 'success'}`,
                    { style: { marginBlockStart: 'var(--space-3)' } },
                    h('div.strong', blocking.length
                        ? `${blocking.length} required field(s) have no column`
                        : 'Every required field has an answer'),
                    h('p.small', blocking.length
                        ? 'Give each one a value to use for every row, or map a column to it. Without that, '
                          + 'every row is rejected — which the preview will show you, but this is cheaper.'
                        : 'These fields are not in your file, so every row will use the value you chose.'),
                    h('div.stack.tight', { style: { marginBlockStart: 'var(--space-2)' } },
                        missing.map((f) => defaultControl(f, repaint)),
                    ),
                ),

                /**
                 * PRIOR-SET VALUES — the same idea as the required panel above,
                 * opened up to fields the file does not need to carry at all. A
                 * service line, an account type, a data source: one value for
                 * the whole batch, chosen once instead of added as a column that
                 * would just repeat itself down every row.
                 */
                h('div.note-box', { style: { marginBlockStart: 'var(--space-3)' } },
                    h('div.strong', 'Set a value for every row'),
                    h('p.small', 'For a fact that is true of the whole file, not something your columns carry — '
                        + 'every service in one file, one account type, one source.'),
                    extras.length > 0 && h('div.stack.tight', { style: { marginBlockStart: 'var(--space-2)' } },
                        extras.map((f) => h('div.row.between',
                            { style: { alignItems: 'flex-end', gap: 'var(--space-2)' } },
                            h('div', { style: { flex: '1' } }, defaultControl(f, repaint)),
                            h('button.btn.sm.ghost', {
                                onclick: () => {
                                    state.extraDefaultKeys.delete(f.key);
                                    delete state.defaults[f.key];
                                    repaint();
                                },
                            }, 'Remove'),
                        )),
                    ),
                    h('div.field', { style: { marginBlockStart: 'var(--space-2)' } },
                        h('select.input', {
                            style: { inlineSize: 'auto' },
                            onchange: (e) => {
                                const key = e.target.value;
                                e.target.value = '';
                                if (!key) return;
                                state.extraDefaultKeys.add(key);
                                repaint();
                            },
                        },
                        h('option', { value: '' }, '+ Set a value for another field…'),
                        fields
                            .filter((f) => !f.required
                                && !Object.values(state.mapping).includes(f.key)
                                && !state.extraDefaultKeys.has(f.key))
                            .map((f) => h('option', { value: f.key }, f.label)),
                        )),
                    ),
            );
            restoreFocus(host, focus);
            if (scroller) scroller.scrollTop = scrollTop;
        };
        repaint();

        return [
            p.duplicateHeaders.length > 0 && h('div.card', h('div.card-body',
                h('div.note-box',
                    h('div.strong', 'This file has repeated column names'),
                    h('p.small', `${p.duplicateHeaders.map((d) => `"${d.name}"`).join(', ')} appears more than once. `
                        + 'Both copies are preserved and can be mapped independently — nothing has been dropped.'),
                ),
            )),

            h('div.card',
                h('div.card-header',
                    h('h2', 'Map the columns'),
                    h('div.actions',
                        h('span.xs.dim', `${number(p.rows)} rows · ${p.header.length} columns · ${state.filename}`),
                        p.templates?.length > 0 && h('select.input', {
                            style: { inlineSize: 'auto' },
                            onchange: (e) => {
                                const template = p.templates.find((t) => t.id === e.target.value);
                                if (!template) return;
                                state.mapping = { ...template.mapping };
                                state.defaults = { ...(template.options?.defaults ?? {}) };
                                // A saved default for an optional field has to
                                // stay visible and editable, same as one just
                                // chosen on screen — otherwise the only way to
                                // see or change it is to open the template.
                                state.extraDefaultKeys = new Set(Object.keys(state.defaults));
                                toast(`Loaded "${template.name}".`, 'success');
                                paint();
                            },
                        },
                        h('option', { value: '' }, 'Load a saved mapping…'),
                        p.templates.map((t) => h('option', { value: t.id }, t.name))),
                    ),
                ),
                h('div.card-body',
                    h('div.note-box',
                        'Columns were matched on their VALUES, not their names. That is why a column called '
                        + '"Personal LinkedIn" is not offered as the company URL, whatever it is titled.'),
                    p.columns.length > 8 && h('div.field', { style: { marginBlockStart: 'var(--space-3)' } },
                        h('input.input', {
                            type: 'search',
                            placeholder: 'Search columns by name, sample value, or mapped field…',
                            value: state.columnSearch,
                            oninput: (e) => { state.columnSearch = e.target.value; repaint(); },
                        }),
                    ),
                ),
                h('div.card-body.flush', host),
            ),

            h('div.card',
                h('div.card-header', h('h2', 'When a record already exists')),
                h('div.card-body',
                    h('div.stack.tight',
                        [
                            ['update', 'Update it', `Matched on ${p.matchers.map((m) => m.label).join(', ')}. Re-uploading the same file changes nothing.`],
                            ['skip', 'Leave it alone', 'Existing records are reported as skipped and not touched.'],
                        ].map(([value, label, help]) => h('label.checkbox',
                            h('input', {
                                type: 'radio', name: 'dup', checked: state.duplicateStrategy === value,
                                onchange: () => { state.duplicateStrategy = value; },
                            }),
                            h('div', h('div.small.strong', label), h('div.xs.dim', help)),
                        )),
                    ),
                ),
                h('div.card-body',
                    h('div.row',
                        h('button.btn', { onclick: () => { state.step = 'choose'; paint(); } }, 'Back'),
                        h('button.btn', { onclick: () => saveTemplate() }, 'Save this mapping'),
                        h('div.spacer'),
                        h('button.btn.primary', {
                            onclick: () => {
                                // The same check the warning panel above already
                                // computes — a required field with no column and
                                // no default was previously allowed through to
                                // Preview anyway, where it surfaced as every row
                                // rejected. Blocked here instead, at the point
                                // where it is one click to fix rather than a
                                // rejected-rows CSV to read.
                                const stillBlocking = unmappedRequired().filter((f) => {
                                    const v = state.defaults[f.key];
                                    return v === undefined || v === null || v === ''
                                        || (Array.isArray(v) && v.length === 0);
                                });
                                if (stillBlocking.length) {
                                    toast(
                                        `Set a value for ${stillBlocking.map((f) => f.label).join(', ')} before continuing — `
                                        + 'every row would otherwise be rejected for it.',
                                        'error',
                                    );
                                    return;
                                }
                                runPreview();
                            },
                        }, 'Check what will happen →'),
                    ),
                ),
            ),
        ];
    }

    /* ---- Existing Customers: map ---------------------------------------- */

    function mapStepCustomers() {
        const p = state.profile;
        const fields = p.fields;
        const groups = ['Account', 'Contact', 'Commercial', 'Agreement'];

        return [
            h('div.card',
                h('div.card-header',
                    h('h2', 'Map the columns'),
                    h('div.actions', h('span.xs.dim', `${number(p.rows)} rows · ${p.header.length} columns · ${state.filename}`)),
                ),
                h('div.card-body',
                    h('div.note-box',
                        'One row becomes an Account, its Contact, its Deal and its signed Agreement together. '
                        + 'The account always lands as an existing customer — never Prospecting or Cold Calling.'),
                ),
                h('div.card-body.flush', h('div.table-wrap', h('table.data',
                    h('thead', h('tr', h('th', 'Column in your file'), h('th', 'Sample values'), h('th', 'Maps to'))),
                    h('tbody', p.columns.map((column) => h('tr',
                        h('td',
                            h('div.strong.small', column.name),
                            h('div.xs.dim', `${number(column.filled)} of ${number(p.rows)} filled`),
                        ),
                        h('td', h('div.stack.tight',
                            column.samples.length
                                ? column.samples.map((s) => h('code.xs', { dir: 'auto' }, s))
                                : h('span.dim.xs', 'empty'),
                        )),
                        h('td', h('select.input', {
                            onchange: (e) => {
                                if (e.target.value) state.mapping[column.index] = e.target.value;
                                else delete state.mapping[column.index];
                            },
                        },
                        h('option', { value: '' }, '— skip this column —'),
                        groups.map((g) => h('optgroup', { label: g },
                            fields.filter((f) => f.group === g).map((f) => h('option', {
                                value: f.key,
                                selected: state.mapping[column.index] === f.key,
                            }, f.label + (f.required ? ' *' : ''))),
                        )),
                        )),
                    ))),
                ))),
                p.requiredMissing?.length > 0 && h('div.card-body',
                    h('div.note-box.warning',
                        h('div.strong', `${p.requiredMissing.length} required field(s) have no column`),
                        h('p.small', p.requiredMissing.map((f) => f.label).join(', ') + ' — map a column to it, or every row rejects.'),
                    ),
                ),
                h('div.card-body',
                    h('div.row',
                        h('button.btn', { onclick: () => { state.step = 'choose'; paint(); } }, 'Back'),
                        h('div.spacer'),
                        h('button.btn.primary', {
                            onclick: () => {
                                // Live against the CURRENT mapping, not the
                                // profile's snapshot from when the file was
                                // first read — a column mapped since then must
                                // count as answered.
                                const stillMissing = fields.filter((f) => f.required
                                    && !Object.values(state.mapping).includes(f.key));
                                if (stillMissing.length) {
                                    toast(
                                        `Map a column to ${stillMissing.map((f) => f.label).join(', ')} before continuing — `
                                        + 'every row would otherwise be rejected for it.',
                                        'error',
                                    );
                                    return;
                                }
                                runPreviewCustomers();
                            },
                        }, 'Check what will happen →'),
                    ),
                ),
            ),
        ];
    }

    async function runPreviewCustomers() {
        if (!Object.keys(state.mapping).length) return toast('Map at least one column first.', 'error');
        mount(container, skeletonRows(5));
        try {
            state.preview = await api.post('/api/import/customers/preview', {
                text: state.text, mapping: state.mapping,
            });
            state.step = 'preview';
        } catch (err) {
            toast(err.message, 'error');
        }
        return paint();
    }

    /* ---- Existing Customers: preview ------------------------------------ */

    function previewStepCustomers() {
        const p = state.preview;
        const c = p.counts;
        return [
            h('div.card',
                h('div.card-header',
                    h('h2', 'What will happen'),
                    h('div.actions', h('span.xs.dim', `${number(p.total)} rows`)),
                ),
                h('div.card-body',
                    h('div.totals-grid',
                        h('div.total-cell', statTile('Accounts', number(c.accounts.new + c.accounts.existing), `${number(c.accounts.new)} new · ${number(c.accounts.existing)} existing`)),
                        h('div.total-cell', statTile('Contacts', number(c.contacts.new + c.contacts.existing), `${number(c.contacts.new)} new · ${number(c.contacts.existing)} existing`)),
                        h('div.total-cell', statTile('Deals', number(c.deals.created + c.deals.updated), `${number(c.deals.created)} created · ${number(c.deals.updated)} updated`)),
                        h('div.total-cell', statTile('Agreements', number(c.agreements.created + c.agreements.updated), `${number(c.agreements.created)} created · ${number(c.agreements.updated)} updated`)),
                        h('div.total-cell', statTile('Renewals', number(c.renewals), 'entering the renewal calendar')),
                        h('div.total-cell', statTile('Errors', number(c.rows.reject), 'rows that will not import')),
                    ),
                    h('div.note-box', { style: { marginBlockStart: 'var(--space-3)' } }, p.note),
                ),
            ),
            h('div.card',
                h('div.card-header', h('h2', 'Row by row'), h('div.actions',
                    h('span.xs.dim', p.truncatedResults ? 'First 100 rows' : `${p.results.length} rows`))),
                h('div.card-body.flush', h('div.table-wrap', h('table.data',
                    h('thead', h('tr', h('th.num', 'Row'), h('th', 'Outcome'), h('th', 'Detail'))),
                    h('tbody', p.results.slice(0, 100).map((r) => h('tr',
                        h('td.num', r.rowNumber),
                        h('td', h('span.badge', { class: outcomeKind(r.outcome) }, r.outcome)),
                        h('td.xs.dim', r.reason ?? (r.account ? `${r.account}${r.service ? ` — ${r.service}` : ''}` : '—')),
                    ))),
                ))),
            ),
            h('div.card', h('div.card-body', h('div.row',
                h('button.btn', { onclick: () => { state.step = 'map'; paint(); } }, 'Back to mapping'),
                h('div.spacer'),
                h('button.btn.primary', {
                    disabled: c.rows.create === 0,
                    onclick: (e) => runExecuteCustomers(e.currentTarget),
                }, `Run — ${number(c.rows.create)} row(s)`),
            ))),
        ];
    }

    async function runExecuteCustomers(button) {
        if (button) { button.disabled = true; button.textContent = 'Importing…'; }
        try {
            state.result = await api.post('/api/import/customers/execute', {
                text: state.text, filename: state.filename, mapping: state.mapping,
            });
            state.step = 'done';
            await loadBatches();
        } catch (err) {
            toast(err.message, 'error');
            if (button) { button.disabled = false; button.textContent = 'Run'; }
            return;
        }
        paint();
    }

    /* ---- Existing Customers: done ---------------------------------------- */

    function doneStepCustomers() {
        const r = state.result;
        const c = r.counts;
        return [
            h('div.card',
                h('div.card-header', h('h2', 'Done')),
                h('div.card-body',
                    h('div.totals-grid',
                        h('div.total-cell', statTile('Accounts', number(c.accounts.new + c.accounts.existing))),
                        h('div.total-cell', statTile('Contacts', number(c.contacts.new + c.contacts.existing))),
                        h('div.total-cell', statTile('Deals', number(c.deals.created + c.deals.updated))),
                        h('div.total-cell', statTile('Agreements', number(c.agreements.created + c.agreements.updated))),
                        h('div.total-cell', statTile('Renewals', number(c.renewals))),
                        h('div.total-cell', statTile('Errors', number(c.rows.reject))),
                    ),
                    c.rows.reject > 0 && h('div.note-box.warning', { style: { marginBlockStart: 'var(--space-3)' } },
                        h('div.strong', `${number(c.rows.reject)} row(s) were rejected`),
                        h('p.small', 'Everything else imported. Fix those rows and re-upload the whole file — matched '
                            + 'records update rather than duplicate.'),
                    ),
                    h('div.row', { style: { marginBlockStart: 'var(--space-3)' } },
                        h('a.btn', { href: '/accounts' }, 'Open Accounts'),
                        h('a.btn', { href: '/agreements' }, 'Open Agreements'),
                        h('div.spacer'),
                        h('button.btn.primary', {
                            onclick: () => {
                                Object.assign(state, { step: 'choose', text: null, profile: null, mapping: {}, preview: null, result: null });
                                paint();
                            },
                        }, 'Import another file'),
                    ),
                ),
            ),
        ];
    }

    async function saveTemplate() {
        const name = await promptFor('Name this mapping', 'e.g. Apollo export, standard columns');
        if (!name) return;
        await api.post('/api/import/templates', {
            object_key: state.objectKey,
            name,
            mapping: state.mapping,
            options: { defaults: state.defaults, duplicateStrategy: state.duplicateStrategy },
        });
        toast('Mapping saved. It will be offered next time you import into this object.', 'success');
    }

    /* ---- 3. preview ---------------------------------------------------- */

    async function runPreview() {
        if (!Object.keys(state.mapping).length) return toast('Map at least one column first.', 'error');
        mount(container, skeletonRows(5));
        try {
            state.preview = await api.post(`/api/import/preview?object=${state.objectKey}`, {
                text: state.text,
                mapping: state.mapping,
                defaults: state.defaults,
                duplicateStrategy: state.duplicateStrategy,
            });
            state.step = 'preview';
        } catch (err) {
            toast(err.message, 'error');
        }
        return paint();
    }

    function previewStep() {
        const p = state.preview;
        return [
            h('div.card',
                h('div.card-header',
                    h('h2', 'What will happen'),
                    h('div.actions', h('span.xs.dim', `${number(p.total)} rows`)),
                ),
                h('div.card-body',
                    h('div.totals-grid',
                        h('div.total-cell', statTile('Create', number(p.counts.create), 'new records')),
                        h('div.total-cell', statTile('Update', number(p.counts.update), 'matched existing')),
                        h('div.total-cell', statTile('Skip', number(p.counts.skip), 'left untouched')),
                        h('div.total-cell', statTile('Reject', number(p.counts.reject), 'with a reason')),
                    ),
                    h('div.note-box', { style: { marginBlockStart: 'var(--space-3)' } }, p.note),
                ),
            ),

            p.reasons.length > 0 && h('div.card',
                h('div.card-header', h('h2', 'Why rows are skipped or rejected')),
                h('div.card-body.flush', h('div.table-wrap', h('table.data',
                    h('thead', h('tr', h('th.num', 'Rows'), h('th', 'Reason'))),
                    h('tbody', p.reasons.map((r) => h('tr',
                        h('td.num', number(r.count)),
                        h('td.small', r.reason),
                    ))),
                ))),
            ),

            h('div.card',
                h('div.card-header', h('h2', 'Row by row'), h('div.actions',
                    h('span.xs.dim', p.truncatedResults ? 'First 100 rows' : `${p.results.length} rows`))),
                h('div.card-body.flush', h('div.table-wrap', h('table.data',
                    h('thead', h('tr', h('th.num', 'Row'), h('th', 'Outcome'), h('th', 'Detail'))),
                    h('tbody', p.results.slice(0, 100).map((r) => h('tr',
                        h('td.num', r.rowNumber),
                        h('td', h('span.badge', { class: outcomeKind(r.outcome) }, r.outcome)),
                        h('td.xs.dim', r.reason ?? '—'),
                    ))),
                ))),
            ),

            h('div.card', h('div.card-body', h('div.row',
                h('button.btn', { onclick: () => { state.step = 'map'; paint(); } }, 'Back to mapping'),
                h('div.spacer'),
                h('button.btn.primary', {
                    disabled: p.counts.create + p.counts.update === 0,
                    onclick: (e) => runExecute(e.currentTarget),
                }, `Run — ${number(p.counts.create)} create, ${number(p.counts.update)} update`),
            ))),
        ];
    }

    async function runExecute(button) {
        if (button) {
            button.disabled = true;
            button.textContent = 'Importing…';
        }
        try {
            state.result = await api.post(`/api/import/execute?object=${state.objectKey}`, {
                text: state.text,
                filename: state.filename,
                source: state.source,
                mapping: state.mapping,
                defaults: state.defaults,
                duplicateStrategy: state.duplicateStrategy,
            });
            state.step = 'done';
            await loadBatches();
        } catch (err) {
            toast(err.message, 'error');
            if (button) {
                button.disabled = false;
                button.textContent = 'Run';
            }
            return;
        }
        paint();
    }

    /* ---- 4. done ------------------------------------------------------- */

    function doneStep() {
        const r = state.result;
        const matches = state.preview
            && state.preview.counts.create === r.counts.create
            && state.preview.counts.update === r.counts.update;

        return [
            h('div.card',
                h('div.card-header', h('h2', 'Done')),
                h('div.card-body',
                    h('div.totals-grid',
                        h('div.total-cell', statTile('Created', number(r.counts.create))),
                        h('div.total-cell', statTile('Updated', number(r.counts.update))),
                        h('div.total-cell', statTile('Skipped', number(r.counts.skip))),
                        h('div.total-cell', statTile('Rejected', number(r.counts.reject))),
                    ),
                    // The preview promised these numbers. Saying so out loud is
                    // how that promise becomes checkable rather than assumed.
                    h('div.note-box', { class: matches ? '' : 'warning', style: { marginBlockStart: 'var(--space-3)' } },
                        matches
                            ? 'Exactly what the preview said would happen.'
                            : 'These counts differ from the preview — the data changed between the check and the run. '
                              + 'The row-by-row detail below says what happened to each row.'),
                    r.counts.reject > 0 && h('div.note-box.warning', { style: { marginBlockStart: 'var(--space-2)' } },
                        h('div.strong', `${number(r.counts.reject)} row(s) were rejected`),
                        h('p.small', 'Everything else imported. Download the rejected rows, fix them, and upload just those — '
                            + 're-uploading the whole file is safe too, because matched records update rather than duplicate.'),
                    ),
                    h('div.row', { style: { marginBlockStart: 'var(--space-3)' } },
                        h('a.btn', { href: `/${store.object(state.objectKey).route}` }, `Open ${store.object(state.objectKey).plural}`),
                        r.counts.reject > 0 && h('a.btn', {
                            href: `/api/import/batches/${r.batchId}/errors.csv`, download: '',
                        }, icon('download'), 'Rejected rows'),
                        h('button.btn', { onclick: () => undoBatch(r.batchId) }, 'Undo this import'),
                        h('div.spacer'),
                        h('button.btn.primary', {
                            onclick: () => {
                                Object.assign(state, {
                                    step: 'choose', text: null, profile: null, mapping: {},
                                    defaults: {}, extraDefaultKeys: new Set(), preview: null, result: null,
                                });
                                paint();
                            },
                        }, 'Import another file'),
                    ),
                ),
            ),
        ];
    }

    async function undoBatch(batchId) {
        const ok = await confirm({
            title: 'Undo this import?',
            message: 'The records it CREATED are deleted — soft-deleted, so they can be restored. Records it updated '
                + 'keep their current values, because reverting those would also discard any edit made since.',
            confirmLabel: 'Undo', danger: true,
        });
        if (!ok) return;
        try {
            const result = await api.post(`/api/import/batches/${batchId}/undo`, {});
            toast(`${result.removed} record(s) removed.`
                + (result.updatedNotReverted ? ` ${result.updatedNotReverted} updated record(s) were left as they are.` : ''), 'success');
            await loadBatches();
            paint();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    /* ---- history ------------------------------------------------------- */

    function historyCard() {
        if (!state.batches.length) {
            return h('div.card',
                h('div.card-header', h('h2', 'Past imports')),
                h('div.card-body', emptyState('Nothing imported yet',
                    'Every import is kept here with its counts, its mapping and a downloadable list of any rejected '
                    + 'rows — so "what did that upload actually do?" has an answer weeks later.')),
            );
        }
        return h('div.card',
            h('div.card-header', h('h2', 'Past imports')),
            h('div.card-body.flush', h('div.table-wrap', h('table.data',
                h('thead', h('tr',
                    h('th', 'When'), h('th', 'File'), h('th', 'Into'), h('th', 'By'),
                    h('th.num', 'Created'), h('th.num', 'Updated'), h('th.num', 'Skipped'), h('th.num', 'Rejected'),
                    h('th', 'Status'), h('th', ''),
                )),
                h('tbody', state.batches.map((b) => h('tr',
                    h('td', { title: date(b.created_at, { withTime: true }) }, relative(b.created_at)),
                    h('td.small', b.filename ?? h('span.dim', 'pasted')),
                    h('td.small', store.object(b.object_key)?.plural ?? b.object_key),
                    h('td.small.dim', b.created_by_name ?? '—'),
                    h('td.num', number(b.created_count)),
                    h('td.num', number(b.updated_count)),
                    h('td.num', number(b.skipped_count)),
                    h('td.num', b.rejected_count ? h('strong', number(b.rejected_count)) : '0'),
                    h('td', h('span.badge', { class: { completed: 'success', failed: 'danger', undone: 'warning' }[b.status] ?? '' }, b.status)),
                    h('td', h('div.row',
                        b.rejected_count > 0 && h('a.btn.sm.ghost', { href: `/api/import/batches/${b.id}/errors.csv`, download: '' }, icon('download'), 'Errors'),
                        b.status === 'completed' && b.created_count > 0 && h('button.btn.sm.ghost', {
                            onclick: () => undoBatch(b.id),
                        }, 'Undo'),
                    )),
                ))),
            ))),
        );
    }

    await restoreDraft(state);
    await loadBatches();
    paint();
    return undefined;
}

function outcomeKind(outcome) {
    return { created: 'success', updated: 'accent', skipped: '', rejected: 'danger' }[outcome] ?? '';
}

async function promptFor(title, placeholder) {
    const input = h('input.input', { placeholder });
    return modal({
        title,
        size: 'narrow',
        body: h('div.field', input),
        footer: (close) => [
            h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
            h('button.btn.primary', { onclick: () => close(input.value.trim() || undefined) }, 'Save'),
        ],
    });
}
