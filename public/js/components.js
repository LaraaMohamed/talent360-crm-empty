/**
 * Shared components.
 *
 * The primitives here are deliberately unremarkable. The two that carry the
 * product's identity — the verdict badge and the evidence card — are the ones
 * worth the extra care, because they are the visible form of the argument the
 * whole system is built on.
 */
import {
    h, mount, modal, confirm, toast, money, number, date, relative, humanise, initials,
    VERDICT_SHAPES, VERDICT_MEANING, dayKey, bytes, captureFocus, restoreFocus,
    parseTypedDate,
} from './core.js';
import * as store from './store.js';
import { api } from './api.js';

/* ================================================================== icons = */

/**
 * One icon set, at one weight.
 *
 * The sidebar was a mix of geometric glyphs and colour emoji — `▤ ☺ ◈ 📄 🛡 📞
 * ◱ ◲ ◐ 📣 ☰ ⭱ ⟲` — which is three typefaces and two colour models in a single
 * column of fifteen rows. Emoji render in the vendor's colour whatever the
 * theme does, so half the nav ignored dark mode entirely, and each glyph sat on
 * its own baseline at its own optical weight.
 *
 * These are stroked paths on a 24-grid, drawn in `currentColor`, so an icon is
 * the same weight as the text beside it and inherits every state the row has —
 * hover, active, dark. Deliberately simple shapes: an icon that needs detail to
 * be recognised is too small to carry it at 16px.
 */
const ICONS = {
    dashboard: 'M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z',
    calendar: 'M7 2v4M17 2v4M3 8h18M4 5h16a1 1 0 011 1v13a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1z',
    check: 'M4 12.5l5 5L20 6.5',
    building: 'M4 21V5a1 1 0 011-1h9a1 1 0 011 1v16M15 21V9h4a1 1 0 011 1v11M4 21h17M8 8h3M8 12h3M8 16h3',
    contact: 'M12 11a4 4 0 100-8 4 4 0 000 8zM4 21c0-4 3.6-6 8-6s8 2 8 6',
    deal: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 16a4 4 0 100-8 4 4 0 000 8zM12 13.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z',
    proposal: 'M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1zM14 3v5h5M9 13h7M9 17h5',
    agreement: 'M12 3l8 3v6c0 4.4-3.2 8.2-8 9-4.8-.8-8-4.6-8-9V6l8-3zM9 12l2 2 4-4',
    phone: 'M6 3h4l2 5-2.5 1.5a12 12 0 005 5L16 12l5 2v4a2 2 0 01-2 2A16 16 0 014 5a2 2 0 012-2z',
    prospects: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17l9 5 9-5',
    people: 'M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2 20c0-3.3 3-5 7-5s7 1.7 7 5M17 6.5a3 3 0 010 6M19 20c0-2.5-1-4-2.5-4.6',
    qualification: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 3v18',
    campaign: 'M4 10v4a1 1 0 001 1h3l6 4V5L8 9H5a1 1 0 00-1 1zM18 8a5 5 0 010 8',
    list: 'M4 6h16M4 12h16M4 18h10',
    upload: 'M12 17V4M7 9l5-5 5 5M4 20h16',
    history: 'M4 10a8 8 0 112 6M4 5v5h5M12 8v4l3 2',
    settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 14a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1v.3a2 2 0 11-4 0v-.2a1.6 1.6 0 00-2.8-1.1l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.6 1.6 0 004 14a2 2 0 01-2-2 2 2 0 012-2 1.6 1.6 0 001.1-2.7l-.1-.1a2 2 0 112.8-2.8l.1.1A1.6 1.6 0 0010 4.6V4a2 2 0 114 0v.2a1.6 1.6 0 002.7 1.1l.1-.1a2 2 0 112.8 2.8l-.1.1A1.6 1.6 0 0020 10a2 2 0 010 4z',
    task: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
    activity: 'M13 10V3L4 14h7v7l9-11h-7z',
    note: 'M19 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z',

    /* ---- the toolbar verbs ---- */
    filter: 'M3 5h18l-7 8v6l-4 2v-8L3 5z',
    columns: 'M4 4h16v16H4zM10 4v16M16 4v16',
    table: 'M3 5h18v14H3zM3 10h18M9 10v9',
    board: 'M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z',
    clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3.5 2',
    download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
    edit: 'M4 20h4L19 9a2 2 0 00-3-3L5 17v3zM15 6l3 3',
    trash: 'M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13M10 11v6M14 11v6',
    mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
    plus: 'M12 5v14M5 12h14',
    close: 'M6 6l12 12M18 6L6 18',
    arrowRight: 'M4 12h15M13 6l6 6-6 6',
    arrowLeft: 'M20 12H5M11 6l-6 6 6 6',
    chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
    more: 'M6 12h.01M12 12h.01M18 12h.01',
    refresh: 'M20 11a8 8 0 10-2 6M20 5v6h-6',
    plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 01-6 6 6 6 0 01-6-6V8zM12 18v4',
    copy: 'M10 9h7a1 1 0 011 1v7a1 1 0 01-1 1h-7a1 1 0 01-1-1v-7a1 1 0 011-1zM7 15H6a1 1 0 01-1-1V6a1 1 0 011-1h8a1 1 0 011 1v1',
};

/**
 * `icon('deal')` — an inline SVG, hidden from screen readers.
 *
 * Every icon in this product sits beside its own label, so it is decoration
 * and says so. An icon that had to be announced would need a name of its own,
 * and then the row would be read twice.
 */
export function icon(name, { size = 16 } = {}) {
    const path = ICONS[name];
    if (!path) return h('span', { 'aria-hidden': 'true' }, '·');

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'icon');

    const d = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    d.setAttribute('d', path);
    svg.appendChild(d);
    return svg;
}

/**
 * A small "copy to clipboard" button for a single value — a phone number or
 * an email address, wherever one is shown. Clipboard access is refused in
 * plenty of ordinary situations (an insecure context, a locked-down
 * browser), so failure is caught and said plainly rather than left silent.
 *
 * `stopPropagation` matters here: this sits inside table cells, and a phone
 * or email column is sometimes the row's own link — without it, a click
 * meant to copy the number would also navigate away.
 */
export function copyButton(value, { label = 'value' } = {}) {
    if (!value) return null;
    return h('button.btn.icon.ghost', {
        type: 'button',
        title: `Copy ${label}`,
        'aria-label': `Copy ${label}`,
        onclick: async (e) => {
            e.preventDefault();
            e.stopPropagation();
            try {
                await navigator.clipboard.writeText(String(value));
                toast(`Copied ${label}.`, 'success');
            } catch {
                toast('Could not copy — your browser blocked clipboard access.', 'error');
            }
        },
    }, icon('copy', { size: 14 }));
}

/* ========================================================== verdict badge = */

/**
 * SHAPE + WORD + COLOUR, always all three.
 *
 * Colour alone fails for the most common colour blindness, and this is the one
 * distinction in the product a user cannot afford to misread. A stale verdict
 * is rendered with reduced emphasis and a clock, because a two-year-old
 * QUALIFIED is not a lead.
 */
/**
 * What the badge SAYS, which is not always the verdict's name.
 *
 * UNRESOLVED is not a judgement about the company — it means the collector had
 * no identity to look at, so no rule was ever applied. Printing the word beside
 * a lead reads as a decision that was made and went against them, which is the
 * opposite of what happened. The lead still shows; the word does not.
 *
 * A qualified lead names the service it qualified FOR. "QUALIFIED" in a column
 * already headed HCM says the same thing twice; "HCM" tells a rep what to sell.
 *
 * REVIEW and REJECTED are real answers and keep their own names.
 */
function verdictWord(value, rule) {
    if (value === 'UNRESOLVED') return null;
    if (value === 'QUALIFIED' && rule) return String(rule).toUpperCase();
    return value;
}

export function verdictBadge(verdict, { size = '', stale = false, rule = null, at = null, legend = false, ruleChangedSinceVerdict = false } = {}) {
    const value = verdict ?? 'UNRESOLVED';
    // A legend or a filter is naming the bucket itself, so there the word is
    // the whole point and stays.
    const word = legend ? value : verdictWord(value, rule);
    const title = [
        VERDICT_MEANING[value] ?? '',
        rule ? `Rule: ${rule}` : '',
        at ? `Computed ${relative(at)}` : '',
        // Two different reasons a verdict is stale — say which one. A rule
        // that changed under an old verdict is not the same problem as a
        // verdict nobody has revisited; the fix for one is "wait for the
        // next sweep" and the fix for the other is "re-run it now."
        ruleChangedSinceVerdict ? 'The rule has changed since this verdict was computed — it is the OLD rule’s answer.'
            : stale ? 'This verdict is older than the workspace freshness threshold.' : '',
    ].filter(Boolean).join('\n');

    return h(`span.verdict.${size}${stale ? '.stale' : ''}${word ? '' : '.quiet'}`.replace(/\.\./g, '.').replace(/\.$/, ''), {
        dataset: { verdict: value },
        title,
        // The shape carries no meaning to a screen reader on its own, and there
        // is no word here to carry it instead.
        ...(word ? {} : { 'aria-label': 'Not yet assessed' }),
    },
    h('span.shape', { 'aria-hidden': 'true' }, VERDICT_SHAPES[value] ?? '◌'),
    word ? h('span', word) : null,
    stale && h('span', { 'aria-label': 'Stale', title: 'Older than the freshness threshold' }, '⏱'),
    );
}

/**
 * A three-answer breakdown bar.
 *
 * Always renders every bucket that has a count, in fixed order, INCLUDING
 * REVIEW. A chart with QUALIFIED and REJECTED and no REVIEW is a lie by
 * omission — and REVIEW is frequently the largest bucket.
 */
export function verdictBar(buckets, { showLegend = true } = {}) {
    const total = buckets.reduce((a, b) => a + b.count, 0);
    if (!total) return h('p.dim.small', 'No verdicts computed yet.');

    return h('div.stack.tight',
        h('div.verdict-bar', { role: 'img', 'aria-label': buckets.map((b) => `${b.verdict} ${b.count}`).join(', ') },
            buckets.filter((b) => b.count > 0).map((b) => h('span', {
                dataset: { verdict: b.verdict },
                style: { inlineSize: `${(b.count / total) * 100}%` },
                title: `${b.verdict}: ${b.count} (${Math.round((b.count / total) * 100)}%)`,
            }, b.count / total > 0.08 ? String(b.count) : '')),
        ),
        showLegend && h('div.legend',
            buckets.map((b) => h('span.legend-item',
                h('span.legend-swatch', { style: { background: `var(--color-verdict-${b.verdict.toLowerCase()})` } }),
                h('span', { class: b.count ? '' : 'dim' }, `${VERDICT_SHAPES[b.verdict]} ${b.verdict} ${b.count}`),
            )),
        ),
    );
}

/* =========================================================== evidence card = */

/**
 * The evidence card — the product's proof of honesty.
 *
 * Shows the raw observation, its provider, when it was collected, and which
 * rows each rule actually read. A user who does not believe a verdict can check
 * it here rather than taking it on trust, which is the difference between a
 * score and an argument.
 */
export function evidenceCard(evidence, { gaps = [] } = {}) {
    if (!evidence) {
        return h('div.empty',
            h('h3', 'No evidence collected'),
            h('p', 'Nothing has been observed for this account yet, so no rule can reach a conclusion. '
                + 'That is UNRESOLVED, not rejected.'),
        );
    }

    const panelNames = { location: 'Where they are', function: 'What they do', school: 'Where they studied', skill: 'What they are skilled at' };
    const usedBy = evidence.usedBy ?? {};

    return h('div.evidence',
        h('div.row.between',
            h('div',
                h('div.strong', evidence.companyName ?? evidence.subjectKey),
                h('div.xs.dim', `Collected by ${evidence.provider} · ${date(evidence.collectedAt, { withTime: true })} · ${relative(evidence.collectedAt)}`),
            ),
            evidence.totalMembers !== null && evidence.totalMembers !== undefined && h('div.metric',
                h('span.metric-label', 'Headcount'),
                h('span.metric-value', number(evidence.totalMembers)),
            ),
        ),

        evidence.error && h('div.note-box.danger', evidence.error),

        h('div.panel-grid',
            Object.entries(panelNames).map(([key, label]) => {
                // null = never collected. [] = collected and LinkedIn listed
                // nothing. These are different claims and must not look alike.
                const rows = evidence.panels?.[key];
                return h('div.panel',
                    h('div.panel-head',
                        h('span', label),
                        h('span.used', rows?.length ? `read by ${(usedBy[key] ?? ['nothing']).join(', ')}` : ''),
                    ),
                    rows?.length
                        ? h('div.panel-rows', rows.map((row) => h('div.panel-row',
                            h('span', row.label),
                            h('span.count', number(row.count)),
                        )))
                        : h('div.panel-empty', rows === null || rows === undefined
                            ? 'Not collected — this panel was never saved, so the signals that read it are unknown, not absent.'
                            : 'Collected, and LinkedIn listed nothing here.'),
                );
            }),
        ),

        // The single most important caveat about this data, stated where the
        // data is, not buried in documentation.
        h('div.note-box',
            'LinkedIn lists only the top few rows in each panel. "Not listed" means '
            + '"not in the top five", never "zero" — which is why a verdict that rests on absence '
            + 'computes an arithmetic bound first and returns REVIEW when the numbers cannot settle it.',
        ),

        gaps.length > 0 && h('div.note-box.warning',
            h('div.strong', 'Fields missing from this collection'),
            h('ul', { style: { marginBlockStart: 'var(--space-1)', paddingInlineStart: 'var(--space-4)', listStyle: 'disc' } },
                gaps.map((g) => h('li', g)),
            ),
        ),
    );
}

/** PASS / FAIL / INFO lines, straight from the rule's own reasoning. */
export function reasonList(reasons = []) {
    if (!reasons.length) return null;
    return h('div.stack.tight',
        reasons.map((text) => {
            const tag = String(text).split(':')[0].trim();
            const kind = tag === 'PASS' ? 'pass' : tag.startsWith('FAIL') || tag.startsWith('SCREENED') ? 'fail' : 'info';
            const rest = String(text).slice(String(text).indexOf(':') + 1).trim();
            return h(`div.reason.${kind}`,
                h('span.tag', tag),
                h('span', rest || text),
            );
        }),
    );
}

/* =============================================================== form fields = */

/**
 * Fields whose stored value and displayed value are deliberately different.
 *
 * A field definition crosses to the browser as JSON, so it cannot carry a
 * function; it names a format and this is where the name is resolved. The
 * server owns the other direction — `normalise` on the field definition reduces
 * whatever was typed back to what is stored, on every write.
 *
 * `linkedin_company` is the only one so far: the column holds the slug, because
 * evidence rows and verdicts are keyed on it, but nobody has a slug in their
 * hand — they have the address bar.
 */
const FORMATS = {
    linkedin_company: (slug) => (String(slug ?? '').trim()
        ? `https://www.linkedin.com/company/${String(slug).trim()}/`
        : ''),
};

/**
 * Renders one input from a FIELD DEFINITION.
 *
 * One mapping from field type to control, used by the record form, the filter
 * builder and the import mapper — so a new field type is added in one place.
 */
export function fieldControl(objectKey, def, value, onChange, { id: controlId } = {}) {
    const common = { class: 'input', id: controlId, name: def.key };

    if (def.type === 'checkbox') {
        return h('label.checkbox',
            h('input', {
                type: 'checkbox', id: controlId, checked: !!value && value !== '0',
                onchange: (e) => onChange(e.target.checked),
            }),
            h('span.small', def.label),
        );
    }

    if (def.type === 'select' || def.type === 'user' || def.type === 'reference') {
        // A field with a known option source gets a dropdown — the list is
        // bounded and already loaded. A reference WITHOUT one points at an
        // unbounded table (accounts, deals), so it is picked by search instead
        // of a select holding two thousand rows.
        if (def.type === 'reference' && !def.optionsSource) {
            return referencePicker(def, value, onChange, controlId);
        }
        // `store.optionsFor` resolves by looking `def.key` up in `objectKey`'s
        // own field registry — the right source when it has one, because a
        // few fields (verification_status) map to a hand-written label rather
        // than a humanised key. But it is empty for a field that is not
        // really one of that object's fields — an import-only column like a
        // contact-import's `account_type` (see ACCOUNT_FIELDS_FOR_CONTACT in
        // `lib/import.mjs`) — which is when the inline `options` this def
        // already carries are the only source there is. Same fallback the
        // filter builder's `conditionValue` already uses.
        const fromStore = store.optionsFor(objectKey, def.key);
        const options = fromStore.length
            ? fromStore
            : (def.options ?? []).map((v) => ({ value: v, label: humanise(v) }));
        return h('select', { ...common, onchange: (e) => onChange(e.target.value || null) },
            h('option', { value: '' }, def.required ? 'Choose…' : '—'),
            options.map((o) => h('option', { value: o.value, selected: String(value ?? '') === String(o.value) }, o.label)),
        );
    }

    if (def.type === 'multiselect') {
        const selected = new Set(Array.isArray(value) ? value : []);
        const fromStore = store.optionsFor(objectKey, def.key);
        const options = fromStore.length
            ? fromStore
            : (def.options ?? []).map((v) => ({ value: v, label: humanise(v) }));
        return h('div.row',
            options.map((o) => h('label.checkbox',
                h('input', {
                    type: 'checkbox', checked: selected.has(o.value),
                    onchange: (e) => {
                        if (e.target.checked) selected.add(o.value);
                        else selected.delete(o.value);
                        onChange([...selected]);
                    },
                }),
                h('span.small', o.label),
            )),
        );
    }

    if (def.type === 'textarea') {
        return h('textarea', { ...common, dir: 'auto', oninput: (e) => onChange(e.target.value) }, value ?? '');
    }

    // `date` and `datetime` are handled above by `dateInput`, so neither
    // appears here — the segmented native controls are gone from this app.
    const inputType = {
        number: 'number', currency: 'number', percent: 'number',
        email: 'email', url: 'url', phone: 'tel',
    }[def.type] ?? 'text';

    let inputValue = value ?? '';
    /**
     * Shown as the URL it stands for, stored as the slug.
     *
     * The box holds what somebody would recognise and can click through to;
     * the server reduces whatever is typed back to the slug on save, so the
     * value the qualification engine is keyed on never changes shape.
     */
    if (def.format === 'linkedin_company' && inputValue) inputValue = FORMATS.linkedin_company(inputValue);

    /**
     * Dates and datetimes both go through the one control that can be typed in.
     *
     * `datetime` used to render `<input type="datetime-local">`, which is the
     * same three segments as `type="date"` with two more bolted on — so a task
     * due date, a meeting time and an activity's "when it happened" all had the
     * typing problem the date fields had been fixed for. There is one control
     * now, and it carries a calendar button so the picker did not have to be
     * given up to get typing back. See `dateInput`.
     */
    if (def.type === 'date' || def.type === 'datetime') {
        return dateInput({
            ...common,
            value: value ?? '',
            withTime: def.type === 'datetime',
            /**
             * A date picked with no time typed still needs an hour, and
             * midnight is not a neutral choice — it is 3am in Riyadh, a time
             * nobody meant. `dateInput` falls back to it only when nothing
             * else is given, so this is the same "start of the working day"
             * answer `lib/follow-up.mjs` (DEFAULT_DAY_START_HOUR) already
             * settled on for exactly this question. A task due "the
             * fifteenth" with no hour typed now reads as 9am that day, not
             * as a task overdue since midnight.
             */
            defaultTime: def.type === 'datetime' ? '09:00' : undefined,
            onChange,
        });
    }

    return h('input', {
        ...common,
        type: inputType,
        // dir="auto" per input: an Arabic legal name inside an English form must
        // render right-to-left on its own.
        dir: 'auto',
        value: inputValue,
        step: def.type === 'currency' ? '0.01' : undefined,
        oninput: (e) => onChange(e.target.value),
    });
}


/**
 * A link to another record: search what exists, or create it on the spot.
 *
 * Three things this has to get right, because the previous version got them
 * wrong and each one costs real data:
 *
 *  1. IT SHOWS THE NAME, NOT THE ID. "Currently linked: acc_iyxDbil7NGsj" is
 *     not an answer to "which company is this?", so the current value is
 *     resolved to its name on open.
 *
 *  2. NOT FINDING IT IS NOT A DEAD END. A contact whose company is not in the
 *     CRM yet used to leave the person typing, failing, and saving the record
 *     unlinked — which is how an Account ends up re-keyed by hand later, or
 *     duplicated. Creating the Account is offered inline, from the text already
 *     typed, and links it in the same click.
 *
 *  3. A LINK CAN BE WRONG. Clear is always available; a picker that can only
 *     ever be set makes a misclick permanent.
 */
function referencePicker(def, value, onChange, controlId) {
    const ROUTES = {
        account_id: 'accounts', deal_id: 'deals', contact_id: 'contacts', campaign_id: 'campaigns',
    };
    const route = ROUTES[def.key] ?? 'accounts';
    const objectKey = { accounts: 'account', deals: 'deal', contacts: 'contact', campaigns: 'campaign' }[route];
    // Inline create is offered for Accounts only. An Account is identifiable
    // from a name alone; a Contact is not (it needs a person's name and a
    // lawful data source), so offering it there would only produce a failure
    // message dressed up as a button.
    const canCreate = route === 'accounts';

    let currentId = value ?? null;

    const input = h('input.input', {
        id: controlId, type: 'search', autocomplete: 'off',
        placeholder: canCreate ? 'Search accounts, or type a new name…' : `Search ${route}…`,
    });
    const results = h('div.stack.tight.picker-results');
    const chosen = h('div.xs.dim');

    const paintChosen = (label) => {
        if (!currentId) return mount(chosen);
        return mount(chosen, h('div.row', { style: { gap: 'var(--space-2)', alignItems: 'center' } },
            h('span', 'Linked to ', h('strong', label ?? currentId)),
            h('a.xs', { href: `/${route}/${currentId}` }, 'open ↗'),
            h('button.btn.sm.ghost', {
                type: 'button',
                onclick: () => { currentId = null; input.value = ''; mount(chosen); onChange(null); },
            }, 'Clear'),
        ));
    };

    const select = (record) => {
        currentId = record.id;
        input.value = displayName(record);
        results.replaceChildren();
        paintChosen(displayName(record));
        onChange(record.id);
    };

    const search = async (query) => {
        if (query.length < 2) return results.replaceChildren();
        const { api } = await import('./api.js');

        let records = [];
        try {
            const data = await api.get(`/api/${route}?q=${encodeURIComponent(query)}&limit=8`);
            records = data.records ?? [];
        } catch { /* offer create anyway — see below */ }

        const nodes = records.map((r) => h('button.btn.ghost.block', {
            type: 'button', style: { justifyContent: 'flex-start' },
            onclick: () => select(r),
        }, displayName(r)));

        const exact = records.some((r) => displayName(r).toLowerCase() === query.toLowerCase());
        if (canCreate && !exact) {
            nodes.push(h('button.btn.ghost.block', {
                type: 'button', style: { justifyContent: 'flex-start' },
                onclick: async (event) => {
                    const button = event.currentTarget;
                    button.disabled = true;
                    try {
                        // Required fields that carry a default are sent with it,
                        // so the quick create does not fail on a value the user
                        // was never asked for and would not have changed.
                        const payload = { name: query };
                        for (const f of store.fields(objectKey)) {
                            if (f.required && f.default !== undefined && payload[f.key] === undefined) {
                                payload[f.key] = f.default;
                            }
                        }
                        const { record } = await api.post(`/api/${route}`, payload);
                        select(record);
                        toast(`Created "${displayName(record)}".`, 'success');
                    } catch (err) {
                        button.disabled = false;
                        toast(err.message, 'error');
                    }
                },
            }, h('span', h('strong', `+ Create "${query}"`), h('span.dim', ' as a new account'))));
        }

        if (!nodes.length) {
            nodes.push(h('div.xs.dim', { style: { padding: 'var(--space-2)' } }, 'Nothing matched.'));
        }
        results.replaceChildren(...nodes);
    };

    let timer;
    input.addEventListener('input', () => {
        clearTimeout(timer);
        const query = input.value.trim();
        timer = setTimeout(() => search(query), 220);
    });

    // Resolve whatever is already linked, so the field opens showing a name.
    // Deliberately does NOT call onChange: displaying the existing value is not
    // an edit, and marking the form dirty on open would be a lie.
    if (currentId) {
        paintChosen(null);
        import('./api.js')
            .then(({ api }) => api.get(`/api/${route}/${currentId}`))
            .then(({ record }) => { input.value = displayName(record); paintChosen(displayName(record)); })
            .catch(() => { /* the id stays on screen; it is still linked */ });
    }

    return h('div.stack.tight', input, results, chosen);
}

/** The human name of a record, whatever the object calls it. */
function displayName(record) {
    if (!record) return '';
    if (record.name) return record.name;
    const person = [record.first_name, record.last_name].filter(Boolean).join(' ');
    return person || record.title || record.id || '';
}

/**
 * A whole record form, generated from the field definitions.
 *
 * Labels above inputs; placeholders are examples, never labels; errors sit
 * beneath the field in words. Required is marked on the label.
 */
export function recordForm(objectKey, record, { onChange, errors = {}, only = null } = {}) {
    const draft = { ...record, properties: { ...(record.properties ?? {}) } };
    const defs = store.fields(objectKey).filter((f) => f.form !== false && !f.readOnly && !f.computed);
    const shown = only ? defs.filter((f) => only.includes(f.key)) : defs;

    const setValue = (def, value) => {
        if (def.custom) draft.properties[def.key.replace('properties.', '')] = value;
        else draft[def.key] = value;
        onChange?.(draft, def);
        // A field can decide whether ANOTHER field is asked at all, so a change
        // may add or remove rows. Only repaint when it actually would: a form
        // that rebuilds on every keystroke is the focus bug this app already
        // has a workaround for.
        if (host && affectsVisibility(shown, def.key)) repaint();
    };

    const host = h('div.stack');

    const repaint = () => {
        const focus = captureFocus(host);
        mount(host, sections(shown, draft, objectKey, setValue, errors));
        restoreFocus(host, focus);
    };
    repaint();

    return { draft, element: host };
}

/** Does any field's visibility depend on this one? */
function affectsVisibility(defs, key) {
    return defs.some((d) => d.showWhen?.field === key);
}

/**
 * Whether a field is asked, given what the record currently holds.
 *
 * `showWhen` crosses from the server as data, never as a function — a field
 * definition is JSON. Two forms so far, and both are deliberately dull:
 *
 *   { field, in: [...] }        that field holds one of these values
 *   { field, isNotEmpty: true } that field holds anything at all
 *
 * A field with no condition is always asked, so this is opt-in and nothing
 * disappears by default.
 */
function isVisible(def, draft) {
    const rule = def.showWhen;
    if (!rule) return true;
    const value = rule.field?.startsWith('properties.')
        ? draft.properties?.[rule.field.replace('properties.', '')]
        : draft[rule.field];
    if (rule.isNotEmpty) return value !== null && value !== undefined && value !== '';
    if (Array.isArray(rule.in)) return rule.in.map(String).includes(String(value ?? ''));
    return true;
}

/**
 * The form, in sections, with the rarely-touched fields folded away.
 *
 * A flat list of twenty inputs in registry order is a database table with
 * labels on it. Grouping is declared on the field (`group`), so a new field
 * lands in the right section by being defined rather than by anyone editing
 * this. Anything ungrouped falls into the first section rather than vanishing.
 */
function sections(defs, draft, objectKey, setValue, errors) {
    const visible = defs.filter((def) => isVisible(def, draft));

    const order = [];
    const byGroup = new Map();
    for (const def of visible) {
        const name = def.group ?? null;
        if (!byGroup.has(name)) { byGroup.set(name, []); order.push(name); }
        byGroup.get(name).push(def);
    }

    const field = (def) => {
        const controlId = `f_${objectKey}_${def.key.replace(/\W/g, '_')}`;
        const value = def.custom ? draft.properties?.[def.key.replace('properties.', '')] : draft[def.key];
        const control = fieldControl(objectKey, def, value, (v) => setValue(def, v), { id: controlId });

        /**
         * A field that governs another field's visibility triggers a repaint,
         * and a repaint throws away the very input being typed into — the
         * failure `captureFocus` exists for. Tagging the control opts it into
         * that mechanism, so "probability" keeps the caret while the override
         * reason appears beneath it.
         *
         * Only plain controls are tagged: a checkbox group returns a wrapper
         * rather than the focused element, and restoring to a wrapper would put
         * the caret on the first box rather than the one in hand.
         */
        if (/^(INPUT|SELECT|TEXTAREA)$/.test(control?.tagName ?? '')) {
            control.dataset.focusKey = `form:${def.key}`;
        }

        return h('div.field',
            h('label', { for: controlId },
                def.label,
                def.required && h('span.required', { title: 'Required' }, '*'),
            ),
            control,
            def.help && h('span.help', def.help),
            errors[def.key] && h('span.error', errors[def.key]),
        );
    };

    // One group and no name is the old flat form, and should look like it —
    // a lone heading over every field on the page is decoration.
    const unsectioned = order.length === 1 && order[0] === null;

    return order.map((name) => {
        const all = byGroup.get(name);
        const primary = all.filter((d) => !d.advanced);
        const advanced = all.filter((d) => d.advanced);

        return h('div.stack.tight',
            !unsectioned && name && h('h4.form-section', name),
            h('div.stack', primary.map(field)),
            advanced.length > 0 && h('details.form-advanced',
                h('summary.xs.dim', `${advanced.length} more — external IDs, attribution and overrides`),
                h('div.stack', { style: { marginBlockStart: 'var(--space-3)' } }, advanced.map(field)),
            ),
        );
    });
}

/* ============================================================ filter builder = */

/**
 * Nested AND/OR filter builder over the object's own field definitions.
 *
 * Fields that cannot be filtered are listed underneath WITH THE REASON. A
 * silent omission looks like a bug; a stated constraint reads as a design and
 * the user stops hunting for the field that is not there.
 */
export function filterBuilder(objectKey, filter, onChange) {
    const defs = store.fields(objectKey);
    const filterable = defs.filter((f) => f.filterable);
    const excluded = defs.filter((f) => !f.filterable);
    const labels = store.state.meta?.operatorLabels ?? {};

    const clone = (node) => JSON.parse(JSON.stringify(node ?? { op: 'and', children: [] }));
    let model = clone(filter);
    const emit = () => onChange(clone(model));

    const renderGroup = (group, parent, index, path) => {
        const rows = group.children.map((child, i) => {
            const childPath = `${path}.${i}`;
            const joiner = i > 0
                ? h('div.filter-joiner',
                    h('select.input', {
                        style: { inlineSize: 'auto' },
                        disabled: i > 1,
                        title: i > 1 ? 'All conditions in a group share one connector. Add a nested group to mix AND with OR.' : '',
                        onchange: (e) => { group.op = e.target.value; emit(); },
                    },
                    h('option', { value: 'and', selected: group.op !== 'or' }, 'AND'),
                    h('option', { value: 'or', selected: group.op === 'or' }, 'OR'),
                    ),
                )
                : h('div.filter-joiner', h('span', 'Where'));

            if (Array.isArray(child.children)) {
                return h('div.stack.tight', joiner, renderGroup(child, group, i, childPath));
            }
            return h('div.stack.tight', joiner, renderCondition(child, group, i, childPath));
        });

        return h('div.filter-group',
            rows,
            h('div.row',
                h('button.btn.sm', {
                    type: 'button',
                    onclick: () => {
                        const first = filterable[0];
                        group.children.push({ field: first.key, operator: first.operators[0], value: '' });
                        emit();
                    },
                }, '+ Condition'),
                h('button.btn.sm.ghost', {
                    type: 'button',
                    onclick: () => { group.children.push({ op: 'or', children: [] }); emit(); },
                }, '+ Group'),
                parent && h('button.btn.sm.ghost', {
                    type: 'button',
                    onclick: () => { parent.children.splice(index, 1); emit(); },
                }, 'Remove group'),
            ),
        );
    };

    const renderCondition = (cond, group, index, path) => {
        const def = filterable.find((f) => f.key === cond.field) ?? filterable[0];
        const needsValue = !['is_empty', 'is_not_empty'].includes(cond.operator);

        return h('div.filter-row',
            h('select.input', {
                onchange: (e) => {
                    const next = filterable.find((f) => f.key === e.target.value);
                    cond.field = next.key;
                    cond.operator = next.operators[0];
                    cond.value = '';
                    emit();
                },
            }, filterable.map((f) => h('option', { value: f.key, selected: f.key === cond.field }, f.label))),

            h('select.input', {
                onchange: (e) => { cond.operator = e.target.value; emit(); },
            }, (def.operators ?? []).map((op) => h('option', { value: op, selected: op === cond.operator }, labels[op] ?? op))),

            needsValue ? conditionValue(objectKey, def, cond, emit, path) : h('span.dim.small', '—'),

            h('button.btn.sm.ghost', {
                type: 'button', 'aria-label': 'Remove condition',
                onclick: () => { group.children.splice(index, 1); emit(); },
            }, '✕'),
        );
    };

    return h('div.filter-builder',
        renderGroup(model, null, 0, '0'),
        excluded.length > 0 && h('details.filter-unavailable',
            h('summary', `${excluded.length} field(s) cannot be filtered — why?`),
            h('ul', { style: { marginBlockStart: 'var(--space-2)', display: 'grid', gap: 'var(--space-1)' } },
                excluded.map((f) => h('li', h('strong', f.label), ' — ', f.excludedBecause)),
            ),
        ),
    );
}

function conditionValue(objectKey, def, cond, emit, path) {
    if (['is_any_of', 'is_none_of', 'has_any_of', 'has_all_of', 'has_none_of'].includes(cond.operator)) {
        const options = store.optionsFor(objectKey, def.key).length
            ? store.optionsFor(objectKey, def.key)
            : (def.options ?? []).map((v) => ({ value: v, label: humanise(v) }));
        const selected = new Set(Array.isArray(cond.value) ? cond.value : (cond.value ? [cond.value] : []));
        if (!options.length) {
            return h('input.input', {
                value: [...selected].join(', '), placeholder: 'Comma-separated',
                dataset: { focusKey: `${path}:value` },
                oninput: (e) => { cond.value = e.target.value.split(',').map((s) => s.trim()).filter(Boolean); emit(); },
            });
        }
        return h('div.row', { style: { gap: 'var(--space-1)' } },
            options.map((o) => h('label.checkbox',
                h('input', {
                    type: 'checkbox', checked: selected.has(o.value),
                    onchange: (e) => {
                        if (e.target.checked) selected.add(o.value);
                        else selected.delete(o.value);
                        cond.value = [...selected];
                        emit();
                    },
                }),
                h('span.xs', o.label),
            )),
        );
    }

    const isDate = ['date', 'datetime'].includes(def.type);

    if (cond.operator === 'between') {
        const pair = Array.isArray(cond.value) ? cond.value : ['', ''];
        // A raw `<input type="date">` fights typing a whole date the way
        // people type one — see dateInput's own header comment for why
        // ("the 1-digit problem"). This filter row never got migrated off
        // the native picker when dateInput was built for exactly that; it
        // has the same bug wherever it still uses one.
        if (isDate) {
            return h('div.row', { style: { gap: 'var(--space-1)' } },
                dateInput({
                    value: pair[0] ?? '', dataset: { focusKey: `${path}:value:0` },
                    onChange: (v) => { cond.value = [v, pair[1]]; emit(); },
                }),
                dateInput({
                    value: pair[1] ?? '', dataset: { focusKey: `${path}:value:1` },
                    onChange: (v) => { cond.value = [pair[0], v]; emit(); },
                }),
            );
        }
        const type = ['number', 'currency', 'percent'].includes(def.type) ? 'number' : 'text';
        return h('div.row', { style: { gap: 'var(--space-1)' } },
            h('input.input', {
                type, value: pair[0] ?? '', dataset: { focusKey: `${path}:value:0` },
                oninput: (e) => { cond.value = [e.target.value, pair[1]]; emit(); },
            }),
            h('input.input', {
                type, value: pair[1] ?? '', dataset: { focusKey: `${path}:value:1` },
                oninput: (e) => { cond.value = [pair[0], e.target.value]; emit(); },
            }),
        );
    }

    if (isDate && !['in_last_days', 'in_next_days'].includes(cond.operator)) {
        return dateInput({
            value: cond.value ?? '', dataset: { focusKey: `${path}:value` },
            onChange: (v) => { cond.value = v; emit(); },
        });
    }

    const type = ['in_last_days', 'in_next_days'].includes(cond.operator) ? 'number'
        : ['number', 'currency', 'percent'].includes(def.type) ? 'number' : 'text';

    return h('input.input', {
        type, dir: 'auto', value: cond.value ?? '',
        placeholder: ['in_last_days', 'in_next_days'].includes(cond.operator) ? 'days' : '',
        dataset: { focusKey: `${path}:value` },
        oninput: (e) => { cond.value = e.target.value; emit(); },
    });
}

/* ============================================================== data table = */

/**
 * The data table.
 *
 * Selection spans the whole result set, not the rendered page: the bulk bar
 * offers "select all N matching" explicitly, because selecting 2,431 records
 * when 50 are on screen is the difference between a tool and a toy.
 */
/**
 * The empty table.
 *
 * An empty state that only says "nothing here" makes the user guess whether
 * they filtered wrongly, imported nothing, or hit a bug. Where the answer is
 * knowable it is stated, and where there is an obvious next action it is a link
 * rather than a sentence describing one.
 *
 * The Accounts case is the one that matters. This page previously said prospects
 * were "excluded from default views until a verdict promotes them" — true before
 * Prospecting existed, false and misleading after it, and it pointed nowhere.
 * An empty Accounts list now means exactly one thing: nothing has been imported
 * yet, and the qualified companies are one click away.
 */
function emptyTable(objectKey) {
    // `?view=` takes an id, not a name, so the tab is resolved from the loaded
    // views rather than guessed at. A link that lands on the wrong tab is worse
    // than one that lands on the default.
    const viewId = (object, name) => store.viewsFor(object).find((v) => v.name === name)?.id ?? null;

    if (objectKey === 'account') {
        const qualified = viewId('prospecting_company', 'Qualified');
        return h('div.empty',
            h('h3', 'No accounts yet'),
            h('p', 'Accounts are created when you import a qualified company from Prospecting — '
                + 'so this list only ever holds companies someone deliberately chose to work.'),
            h('a.btn.primary', {
                href: qualified ? `/prospects?view=${qualified}` : '/prospects',
            }, 'Review qualified prospects'),
        );
    }
    if (objectKey === 'prospecting_company') {
        return h('div.empty',
            h('h3', 'No companies match'),
            h('p', 'Every company ever uploaded stays in Prospecting, so an empty list here means the '
                + 'filter excluded them rather than that they are gone. Try the All uploaded tab.'),
            h('a.btn', { href: '/import' }, 'Upload a list'),
        );
    }
    return h('div.empty',
        h('h3', 'Nothing here'),
        h('p', 'No records match this view. Clearing the filter, or switching to another tab, will show more.'),
    );
}

export function dataTable({
    objectKey, records, columns, total, page, pages, sort = [], selection,
    onSort, onPage, onSelect, onClear, rowHref, onRowClick, bulkActions,
    rowActions = null, allSelected = false,
}) {
    const defs = store.fields(objectKey);
    const cols = columns.map((col) => {
        if (typeof col === 'string') {
            return { key: col, def: defs.find((f) => f.key === col) };
        }
        return { key: col.key, def: col.def || defs.find((f) => f.key === col.key), render: col.render };
    }).filter((c) => c.def);
    const selected = selection instanceof Set ? selection : (selection?.ids ?? new Set());

    const sortFor = (key) => sort.find((s) => s.field === key);

    const isAllOnPageSelected = records.length > 0 && records.every((r) => selected.has(r.id));
    // "Select all matching" covers every page, so the page header reads checked
    // too — the page is a subset of the selection.
    const isHeaderChecked = allSelected || (records.length > 0 && isAllOnPageSelected);

    const header = h('tr',
        onSelect && h('th.check',
            h('input', {
                type: 'checkbox', 'aria-label': 'Select all on this page',
                checked: isHeaderChecked,
                onchange: (e) => onSelect(records.map((r) => r.id), e.target.checked),
            }),
        ),
        cols.map((col) => {
            const def = col.def;
            const active = sortFor(def.key);
            return h(`th${def.sortable === false ? '' : '.sortable'}${['number', 'currency', 'percent'].includes(def.type) ? '.num' : ''}`, {
                onclick: def.sortable === false ? undefined : () => onSort?.(def.key),
                title: def.sortable === false ? 'This column cannot be sorted.' : `Sort by ${def.label}`,
                'aria-sort': active ? (active.direction === 'desc' ? 'descending' : 'ascending') : 'none',
            }, def.label, active && h('span.dir', active.direction === 'desc' ? '↓' : '↑'));
        }),
        rowActions && h('th.actions', { 'aria-label': 'Row actions' }),
    );

    /**
     * A row can be a link or an action, and the calling queue is the second.
     *
     * `rowHref` is right when the row has a page of its own. A queue entry does
     * not — clicking it puts that contact in the console beside you — so the
     * whole row is clickable instead. A checkbox click is not a row click.
     */
    const body = records.map((record) => {
        const isChecked = selected.has(record.id);
        return h('tr', {
            class: isChecked ? 'selected' : '',
            ...(onRowClick ? {
                style: { cursor: 'pointer' },
                onclick: (event) => {
                    if (event.target.closest('input, a, button, select')) return;
                    onRowClick(record);
                },
            } : {}),
        },
            onSelect && h('td.check',
                h('input', {
                    type: 'checkbox', 'aria-label': `Select ${record.name ?? record.id}`,
                    checked: isChecked,
                    onchange: (e) => onSelect([record.id], e.target.checked),
                }),
            ),
            cols.map((col, i) => h(`td${['number', 'currency', 'percent'].includes(col.def.type) ? '.num' : ''}`,
                i === 0 && rowHref
                    ? h('a.cell-link', { href: rowHref(record) }, col.render ? col.render(record, col.def, objectKey) : cellContent(objectKey, col.def, record))
                    : col.render ? col.render(record, col.def, objectKey) : cellContent(objectKey, col.def, record),
            )),
            rowActions && h('td.actions', rowActions(record)),
        );
    });

    const selectionCount = selected.size;

    return h('div',
        selectionCount > 0 && h('div.bulk-bar',
            h('strong', `${number(selectionCount)} selected`),
            selectionCount > 0 && h('button.btn.sm.ghost', { onclick: () => onClear?.() }, 'Clear selection'),
            h('div.spacer'),
            bulkActions,
        ),

        h('div.table-wrap',
            records.length === 0
                ? emptyTable(objectKey)
                : h('table.data', h('thead', header), h('tbody', body)),
        ),

        pages > 1 && h('div.pagination',
            h('span', `${number(total)} record${total === 1 ? '' : 's'} · page ${page} of ${pages}`),
            h('div.spacer'),
            h('button.btn.sm', { disabled: page <= 1, onclick: () => onPage(page - 1) }, 'Previous'),
            h('button.btn.sm', { disabled: page >= pages, onclick: () => onPage(page + 1) }, 'Next'),
        ),
        pages <= 1 && records.length > 0 && h('div.pagination', h('span', `${number(total)} record${total === 1 ? '' : 's'}`)),
    );
}

export function cellContent(objectKey, col, record) {
    if (col.computed === 'verdict') {
        const info = record.verdicts?.[col.rule];
        return verdictBadge(record[col.key], { rule: col.rule, at: info?.computedAt, stale: info?.stale });
    }
    if (col.computed === 'money') {
        /**
         * Null is not zero, and a list must not print it as one.
         *
         * A deal nobody has priced showed "SAR 0", which reads as a deal worth
         * nothing — a claim about the negotiation rather than about the data.
         * The rollups genuinely ARE zero when there is nothing to roll up; the
         * price is null until somebody quotes it, and says so.
         */
        const value = record[col.key];
        if (value === null || value === undefined) return h('span.dim', '—');
        /**
         * The ROLLUPS are in base currency. The price is in the client's.
         *
         * `value_one_time`, `value_mrr`, `value_arr` and `value_weighted` are
         * converted figures — the deal hydrator says so by sending
         * `value_currency` beside them — while `price` is the number somebody
         * typed, in the currency they typed it in. Formatting all of them with
         * `record.currency` printed a SAR 46,875 monthly total as "$46,875",
         * which is the wrong number by a rate and reads as the right one.
         */
        const currency = col.key.startsWith('value_')
            ? (record.value_currency ?? record.currency)
            : record.currency;
        return h('span.money', money(value, currency));
    }

    const value = col.custom ? record.properties?.[col.key.replace('properties.', '')] : record[col.key];

    switch (col.key) {
        case 'owner_id': return record.owner_name ?? '—';
        case 'assignee_id': return record.assignee_name ?? '—';
        case 'actor_id': return record.actor_name ?? '—';
        case 'author_id': return record.author_name ?? '—';
        case 'uploaded_by': return record.uploaded_name ?? '—';
        case 'account_id': return record.account_id
            ? h('a', { href: `/accounts/${record.account_id}` }, record.account_name ?? record.account_id)
            : '—';
        case 'deal_id': return record.deal_id
            ? h('a', { href: `/deals/${record.deal_id}` }, record.deal_name ?? record.deal_id)
            : '—';
        case 'stage_id': return record.stage_label ?? '—';
        case 'size_bytes': return bytes(value);
        /**
         * Three states, not two.
         *
         * "No" on a contact nobody has checked reads as a verdict; it is the
         * absence of one. And "No" on a contact whose check came back
         * `accept_all` reads as a failed check; the check succeeded. Both are
         * said in words here, because this column is often shown without the
         * status column that would otherwise explain it.
         */
        case 'email_verified': {
            const status = record.verification_status;
            if (!status) return h('span.dim', 'Not checked');
            if (value) return h('span.badge.success', 'Yes');
            const label = store.optionLabel(objectKey, 'verification_status', status) ?? humanise(status);
            return h('span.row', { style: { gap: 'var(--space-2)' } },
                h('span.badge', 'No'), h('span.xs.dim', label));
        }
        default: break;
    }

    if (value === null || value === undefined || value === '') return h('span.dim', '—');

    /**
     * A person, by NAME.
     *
     * The switch above resolves five user columns by their key — owner_id,
     * assignee_id and so on — which works right up until an object declares a
     * sixth. The calling queue's `assigned_to` was that sixth, and it rendered
     * `usr_5XdXRK5rQ9tY` in a column headed "Assigned to (person)".
     *
     * This is the generic answer the key list was standing in for: any field
     * the registry TYPES as a user resolves through the workspace's own roster,
     * so declaring one is enough and no key needs adding here again.
     */
    if (col.type === 'user') return store.userName(value);

    if (col.type === 'checkbox') return value ? 'Yes' : 'No';
    if (col.type === 'currency') return h('span.money', money(value, record.currency));
    if (col.type === 'number') return number(value);
    if (col.type === 'percent') return `${Math.round(Number(value) * 100)}%`;
    if (col.type === 'date') return date(value);
    if (col.type === 'datetime') return h('span', { title: date(value, { withTime: true }) }, relative(value));
    if (col.type === 'multiselect') return h('div.row', { style: { gap: '0.2rem' } },
        (Array.isArray(value) ? value : []).map((v) => h('span.badge', humanise(v))));
    if (col.type === 'select' || col.type === 'reference') {
        // A field whose options are workspace data stores a key or an id, so the
        // cell must resolve it. Showing `cmp_7hK2…` in a Campaign column is the
        // sort of thing that makes a metadata-driven table look broken.
        const label = store.optionLabel(objectKey, col.key, value);
        if (col.type === 'reference' && !label) return h('span.dim.truncate', String(value));
        /**
         * The tone comes from the SERVER's status registry, not from a table
         * kept here. The table kept here covered fourteen values out of sixty
         * and none of the approval workflow, so an EXPIRED contract and one
         * awaiting review were the same grey pill. See STATUS_TONES in
         * lib/objects.mjs.
         */
        const kind = store.toneFor(value);
        return h(`span.badge${kind ? `.${kind}` : ''}`, label ?? humanise(value));
    }
    // A formatted field is shown as what it stands for, and is clickable.
    if (col.format && FORMATS[col.format]) {
        const href = FORMATS[col.format](value);
        return h('a', { href, target: '_blank', rel: 'noreferrer noopener' },
            String(href).replace(/^https?:\/\/(www\.)?/, ''));
    }
    if (col.type === 'url') return h('a', { href: value, target: '_blank', rel: 'noreferrer noopener' }, String(value).replace(/^https?:\/\//, ''));
    if (col.type === 'email') return h('span.row', { style: { gap: 'var(--space-1)' } },
        h('a', { href: `mailto:${value}` }, value), copyButton(value, { label: 'email address' }));
    if (col.type === 'phone') return h('span.row', { style: { gap: 'var(--space-1)' } },
        h('a', { href: `tel:${value}` }, value), copyButton(value, { label: 'phone number' }));

    return h('span', { dir: 'auto', class: 'truncate', title: String(value) }, String(value));
}

/**
 * Pagination controls.
 *
 * One implementation, used by the data table, the search page, campaign members
 * and the import tables — so "page 3 of 12" behaves and reads the same
 * everywhere instead of four near-identical widgets drifting apart.
 *
 * It always states the TOTAL, not just the page. "Showing 25" invites the
 * reader to assume that is all there is; "25 of 412" does not.
 */
export function pager({ page, pages, total, limit, onPage, unit = 'record' }) {
    if (!total) return null;
    const safePages = Math.max(1, pages ?? Math.ceil(total / (limit || 1)));
    const first = (page - 1) * (limit ?? 0) + 1;
    const last = Math.min(total, page * (limit ?? total));

    if (safePages <= 1) {
        return h('div.pagination', h('span', `${number(total)} ${unit}${total === 1 ? '' : 's'}`));
    }

    return h('div.pagination',
        h('span', `${number(first)}–${number(last)} of ${number(total)} ${unit}${total === 1 ? '' : 's'}`),
        h('div.spacer'),
        h('button.btn.sm', { disabled: page <= 1, onclick: () => onPage(1), title: 'First page' }, '«'),
        h('button.btn.sm', { disabled: page <= 1, onclick: () => onPage(page - 1) }, 'Previous'),
        h('span.small.tabular', { style: { paddingInline: 'var(--space-2)' } }, `${page} / ${safePages}`),
        h('button.btn.sm', { disabled: page >= safePages, onclick: () => onPage(page + 1) }, 'Next'),
        h('button.btn.sm', { disabled: page >= safePages, onclick: () => onPage(safePages), title: 'Last page' }, '»'),
    );
}

/* ================================================================ timeline = */

/**
 * The timeline, grouped by day.
 *
 * It has to stay readable at 500 entries, which means day grouping and never
 * showing raw field diffs unless asked. System entries are visually quieter
 * than human ones, and are not editable — they come from the audit log.
 */
export function timelineList(entries, { onEdit, onDelete } = {}) {
    if (!entries.length) {
        return h('div.empty',
            h('h3', 'Nothing logged yet'),
            h('p', 'Calls, emails and meetings you log will appear here, newest first, alongside the system events '
                + 'this workspace projects into the timeline.'),
        );
    }

    const byDay = new Map();
    for (const entry of entries) {
        const key = dayKey(entry.at);
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push(entry);
    }

    return h('div.timeline',
        [...byDay.entries()].map(([day, items]) => [
            h('div.timeline-day', day),
            items.map((entry) => h(`div.timeline-item${entry.kind === 'system' ? '.system' : ''}`,
                h(`div.timeline-dot.${entry.color ?? 'info'}`, { 'aria-hidden': 'true' }, iconFor(entry)),
                h('div.timeline-body',
                    h('div.timeline-head',
                        h('span.timeline-subject', { dir: 'auto' }, entry.subject || entry.typeLabel),
                        h('span.timeline-meta',
                            entry.typeLabel,
                            ' · ', entry.actor,
                            ' · ', h('span', { title: date(entry.at, { withTime: true }) }, relative(entry.at)),
                            // Logging Tuesday's call on Thursday shows Tuesday,
                            // with the entry date available on hover.
                            entry.createdAt && entry.createdAt.slice(0, 10) !== String(entry.at).slice(0, 10)
                                ? h('span', { title: `Logged ${date(entry.createdAt, { withTime: true })}` }, ' · backdated')
                                : null,
                        ),
                    ),
                    entry.body && h('div.timeline-text', { dir: 'auto' }, entry.body),
                    entry.editable && (onEdit || onDelete) && h('div.row', { style: { marginBlockStart: 'var(--space-1)' } },
                        onEdit && h('button.btn.sm.ghost', { onclick: () => onEdit(entry) }, 'Edit'),
                        onDelete && h('button.btn.sm.ghost', { onclick: () => onDelete(entry) }, 'Delete'),
                    ),
                ),
            )),
        ]),
    );
}

function iconFor(entry) {
    return {
        call: '☎', email: '✉', meeting: '📅', linkedin: 'in', whatsapp: '💬',
        kickoff: '🏁', proposal_sent: '📄', note: '📝', system: '⚙',
    }[entry.icon] ?? (entry.kind === 'system' ? '⚙' : '•');
}

/* ================================================================== misc == */

export function pageHeader(title, subtitle, actions) {
    return h('div.record-header',
        h('div.record-title', h('h1', { dir: 'auto' }, title), actions && h('div.spacer'), actions),
        subtitle && h('div.record-sub', subtitle),
    );
}

export function emptyState(title, message, action) {
    return h('div.empty', h('h3', title), h('p', message), action);
}

export function errorState(message, retry) {
    return h('div.error-state',
        h('h3', 'That did not work'),
        h('p', message),
        retry && h('button.btn', { onclick: retry }, 'Try again'),
    );
}

export function skeletonRows(n = 6) {
    return h('div.stack.tight', { style: { padding: 'var(--space-4)' } },
        Array.from({ length: n }, () => h('div.skeleton', { style: { blockSize: '2rem' } })));
}

export function avatar(name, size = '') {
    return h(`div.avatar.${size}`.replace(/\.$/, ''), { title: name }, initials(name));
}

/**
 * One number, labelled.
 *
 * `tone` colours the VALUE, not the tile — a dashboard where four cells have
 * coloured backgrounds is a traffic light, and most numbers are not good or bad,
 * they are just the number.
 *
 * `tooltip` moves the explanation off the page and onto the label. Every widget
 * in this product explains what its figure counts, which is right — but twelve
 * of those explanations printed in full turns "at a glance" into two screens of
 * prose. The label gets a dotted underline so the explanation is discoverable
 * rather than merely hidden.
 */
export function statTile(label, value, help, { tone = '', tooltip = false } = {}) {
    const explained = tooltip && help;
    return h(`div.metric${tone ? `.tone-${tone}` : ''}`,
        h('span.metric-label', {
            class: explained ? 'has-help' : '',
            title: explained ? help : null,
        }, label),
        h('span.metric-value', value),
        help && !tooltip && h('span.metric-help', help),
    );
}

/**
 * Choosing which columns a table shows, and in what order.
 *
 * Shared rather than reimplemented: the calling queue wants the same picker the
 * lists have, and two copies of a drag-free reordering UI would be two things to
 * fix every time. Driven entirely from the field registry, so an object gets
 * this by being registered.
 *
 * Returns the chosen keys, or `undefined` if cancelled. `extraActions` lets the
 * caller add a button to the footer — the lists use it for "Save as view",
 * which the queue has no equivalent of.
 */
export async function columnPicker(objectKey, current, { extraActions = null } = {}) {
    const fields = store.fields(objectKey).filter((f) => f.key !== 'properties');
    const label = (key) => fields.find((f) => f.key === key)?.label ?? key;
    let chosen = (current ?? []).filter((key) => fields.some((f) => f.key === key));

    const host = h('div');
    const repaint = () => {
        const available = fields.filter((f) => !chosen.includes(f.key));
        const move = (index, delta) => {
            const next = [...chosen];
            const [item] = next.splice(index, 1);
            next.splice(Math.max(0, Math.min(next.length, index + delta)), 0, item);
            chosen = next;
            repaint();
        };

        mount(host,
            h('div.stack.tight',
                h('div.strong.small', `Shown, in this order (${chosen.length})`),
                chosen.length === 0
                    ? h('p.xs.dim', 'No columns chosen. Add some below — a table with no columns is just a row count.')
                    : h('div.stack.tight', chosen.map((key, i) => h('div.row.between.column-row',
                        h('span.small.truncate', label(key)),
                        h('div.row', { style: { gap: '0.15rem' } },
                            h('button.btn.sm.ghost.icon', {
                                title: 'Move up', disabled: i === 0, onclick: () => move(i, -1),
                            }, '↑'),
                            h('button.btn.sm.ghost.icon', {
                                title: 'Move down', disabled: i === chosen.length - 1, onclick: () => move(i, 1),
                            }, '↓'),
                            h('button.btn.sm.ghost.icon', {
                                title: 'Remove', onclick: () => { chosen = chosen.filter((k) => k !== key); repaint(); },
                            }, '✕'),
                        ),
                    ))),

                h('div.strong.small', { style: { marginBlockStart: 'var(--space-3)' } }, 'Add a column'),
                available.length === 0
                    ? h('p.xs.dim', 'Every field is already shown.')
                    : h('div.row', { style: { flexWrap: 'wrap' } }, available.map((f) => h('button.chip', {
                        onclick: () => { chosen = [...chosen, f.key]; repaint(); },
                    }, `＋ ${f.label}`, f.custom && h('span.dim', ' ·custom')))),
            ),
        );
    };
    repaint();

    const result = await modal({
        title: 'Columns',
        size: 'wide',
        body: h('div.stack', host),
        footer: (close) => [
            h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
            h('div.spacer'),
            ...(extraActions ? extraActions(close) : []),
            h('button.btn.primary', { onclick: () => close({ apply: true }) }, 'Apply'),
        ],
    });
    if (!result) return undefined;
    return { columns: chosen, ...result };
}

/* ------------------------------------------------- create, edit, delete -- */

/**
 * One dialog for creating and editing ANY record, driven by the field registry.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Tasks, activities and notes each had a hand-written create dialog and no way
 * to edit or delete at all. Three dialogs meant three sets of labels, three
 * date controls, three ideas of what a loading state looks like, and three
 * places to add a field — and the fields were already declared once, in the
 * object registry, which `recordForm` renders. So there is one dialog, and a
 * new field on any object appears in it without a line of code here.
 *
 * `defaults` are values the caller knows and the form does not ask for — the
 * parent this is being created against, most often. They are merged on save
 * rather than shown, because "which record is this note on" is answered by the
 * page you are standing on.
 *
 * Returns the saved record, or undefined if cancelled.
 */
export async function editEntity(objectKey, { record = null, defaults = {}, title = null, only = null } = {}) {
    const def = store.object(objectKey);
    const label = def?.label ?? objectKey;
    const editing = Boolean(record?.id);
    let form;
    const errorBox = h('div.error');

    return modal({
        title: title ?? `${editing ? 'Edit' : 'New'} ${label.toLowerCase()}`,
        size: 'wide',
        body: () => {
            form = recordForm(objectKey, { ...defaults, ...(record ?? {}) }, { only });
            return h('div.stack', errorBox, form.element);
        },
        footer: (close) => [
            h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
            h('button.btn.primary', {
                onclick: async (event) => {
                    const button = event.currentTarget;
                    // The loading state every one of the three dialogs had a
                    // slightly different version of, or none.
                    const restore = button.textContent;
                    button.disabled = true;
                    button.textContent = 'Saving…';
                    try {
                        /**
                         * `form.draft` already carries every default — `recordForm`
                         * is seeded with `{ ...defaults, ...record }` at line 1359 —
                         * and stays live as the person edits. Re-spreading
                         * `defaults` on top of it here used to win outright: any
                         * field also passed as a default (an assignee pre-filled
                         * to yourself, a priority pre-filled to B) reverted to
                         * that value on save no matter what was picked in the
                         * form. A task "assigned to a rep" silently saved back to
                         * its creator instead — and since the notifier skips
                         * notifying yourself, that read as both the assignment
                         * and its notification doing nothing.
                         */
                        const body = form.draft;
                        const saved = editing
                            ? await api.patch(`/api/${def.route}/${record.id}`, body)
                            : await api.post(`/api/${def.route}`, body);
                        toast(`${label} ${editing ? 'saved' : 'created'}.`, 'success');
                        close(saved.record ?? saved);
                    } catch (err) {
                        errorBox.textContent = err.message;
                        button.disabled = false;
                        button.textContent = restore;
                    }
                },
            }, editing ? 'Save' : 'Create'),
        ],
    });
}

/**
 * Deleting one record, with the confirmation a destructive action earns.
 *
 * Soft delete — `deleteRecord` in lib/repo.mjs moves it to the trash and keeps
 * everything attached to it — and the dialog says so, because "Delete?" with no
 * indication of whether it is recoverable makes people cancel work they meant
 * to do and confirm work they did not.
 *
 * Returns true when it was deleted.
 */
export async function deleteEntity(objectKey, record, { name = null } = {}) {
    const def = store.object(objectKey);
    const label = def?.label ?? objectKey;
    const title = name ?? record?.[def?.titleField] ?? record?.title ?? record?.subject ?? record?.body ?? '';

    const ok = await confirm({
        title: `Delete this ${label.toLowerCase()}?`,
        message: `${String(title).slice(0, 140) || `This ${label.toLowerCase()}`} moves to the trash. `
            + 'Everything attached to it is kept, and it can be restored.',
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return false;

    try {
        await api.delete(`/api/${def.route}/${record.id}`);
        toast(`${label} deleted.`, 'success');
        return true;
    } catch (err) {
        toast(err.message, 'error');
        return false;
    }
}

/**
 * The Edit and Delete pair, as one row of buttons.
 *
 * Rendered from capabilities rather than hidden by role name: a rep may edit
 * and may not delete, and that is `record.write.*` and `record.delete` — the
 * same two the server checks. Delete simply does not render for somebody who
 * cannot, rather than rendering and failing.
 */
export function entityActions(objectKey, record, { onDone, name = null, size = 'sm' } = {}) {
    const canEdit = store.can('record.write.all') || store.can('record.write.own');
    const canDelete = store.can('record.delete');
    if (!canEdit && !canDelete) return null;

    return h('div.row.entity-actions', { style: { gap: 'var(--space-1)' } },
        canEdit && h(`button.btn.${size}.ghost`, {
            title: 'Edit',
            onclick: async () => {
                const saved = await editEntity(objectKey, { record });
                if (saved) onDone?.(saved);
            },
        }, 'Edit'),
        canDelete && h(`button.btn.${size}.ghost.danger`, {
            title: 'Delete',
            onclick: async () => {
                if (await deleteEntity(objectKey, record, { name })) onDone?.(null);
            },
        }, 'Delete'),
    );
}

/* ------------------------------------------------------------ date input -- */

/**
 * A date or date-and-time box that can be TYPED INTO, with a picker beside it.
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────
 *
 * `<input type="date">` is three two-digit segments wearing a text box. Typing
 * "18" into the day segment moves the caret to the month whether you meant it
 * to or not, "2026" in a two-digit segment is not accepted, and a person typing
 * a whole date the way people type dates — 18/08/2026 — gets a fight. That is
 * the "only one or two digits" the product keeps reporting: the box is not
 * limited, it is segmented, and a segment holds two digits by construction.
 *
 * ── AND THE PROBLEM WITH THE OBVIOUS FIX ────────────────────────────────────
 *
 * Replacing it with a plain text box fixes typing and removes the calendar,
 * which people also use — for "the Tuesday after next" nobody wants to work out
 * a date to type. So this is BOTH: a text box that accepts a complete typed
 * date, and a real picker one click away that writes back into it.
 *
 * ── PARSING ON BLUR, NOT ON KEYSTROKE ───────────────────────────────────────
 *
 * "0" on the way to "01/09/2026" is not a date, and rewriting the box under a
 * moving caret is worse than waiting. So what is typed is left exactly as typed
 * until focus leaves, and only then normalised. Text that cannot be parsed is
 * also left alone — the server refuses it with a message, which beats silently
 * emptying a box somebody just filled in.
 *
 * `withTime` adds a time box beside the date one. A due date at "5pm" and a due
 * date at "midnight, because the field only took a date" are different
 * commitments, and the task list sorts by it.
 *
 * `defaultTime` is what that box opens at, and it exists because an empty time
 * box is not neutral: the instant this control emits is built from both halves,
 * so a person who fills in only the date is committing to midnight without
 * having said so. A follow-up passes the workspace's start of day, which is the
 * hour somebody would actually make the call at.
 */
export function dateInput({ value = '', withTime = false, defaultTime = '', onChange, ...rest } = {}) {
    const initial = splitValue(value, withTime);

    const text = h('input.input.date-text', {
        ...rest,
        type: 'text',
        inputmode: 'numeric',
        autocomplete: 'off',
        placeholder: 'YYYY-MM-DD',
        dir: 'auto',
        value: initial.date,
        'aria-label': rest['aria-label'] ?? 'Date',
    });

    const time = withTime
        ? h('input.input.date-time', {
            type: 'time',
            value: initial.time || (initial.date ? defaultTime : ''),
            'aria-label': 'Time',
            style: { inlineSize: '8rem' },
        })
        : null;

    /**
     * The picker. A real `<input type="date">`, laid directly over the
     * button rather than shrunk to a hidden 1px proxy — so a mouse click
     * lands on the native input itself and opens its calendar as an
     * ordinary trusted click, not a script-triggered one.
     *
     * That distinction is not academic: `showPicker()` calling a hidden
     * input from a button's own click handler works in some Chromium
     * builds and silently no-ops in others (observed in Brave), and never
     * opens a picker triggered that way in Safari at all. A real click on
     * a real, visible-to-the-browser (if not to the eye) date input is the
     * one thing every engine honours the same way.
     */
    const picker = h('input.date-picker-native', {
        type: 'date',
        tabindex: '-1',
        'aria-hidden': 'true',
        value: initial.date,
        // A mouse click lands directly on this input now, bypassing the
        // button's own onclick — so what it shows on open has to be synced
        // here too, from whatever is currently typed in the text box.
        onmousedown: () => { picker.value = parseTypedDate(text.value) ?? ''; },
        onchange: () => {
            if (!picker.value) return;
            text.value = picker.value;
            emit();
        },
    });

    const button = h('button.btn.date-picker-button', {
        type: 'button',
        title: 'Pick from a calendar',
        'aria-label': 'Pick a date from a calendar',
        // The overlaying picker catches the mouse; this stays reachable by
        // keyboard (Tab, then Enter/Space) and best-effort opens the same
        // picker where showPicker() is supported for a script-triggered call.
        onclick: () => {
            picker.value = parseTypedDate(text.value) ?? '';
            try { picker.showPicker?.(); } catch { /* keyboard path only; the click overlay is the reliable one */ }
        },
    }, '📅');

    const pickerWrap = h('span.date-picker-wrap', button, picker);

    function emit() {
        const day = parseTypedDate(text.value);
        if (!day) return onChange?.(text.value);
        if (!withTime) return onChange?.(day);
        /**
         * A date with no time gets the default filled IN THE BOX, not silently
         * behind it. The person then sees the hour they are committing to and can
         * change it, which is the whole difference between a default and a guess.
         */
        if (!time.value && defaultTime) time.value = defaultTime;
        const timeOfDay = time.value || '00:00';
        // Built from the parts the person entered and read back as an instant,
        // so what they typed in their own timezone is what is stored in UTC.
        const at = new Date(`${day}T${timeOfDay}`);
        return onChange?.(Number.isNaN(at.getTime()) ? text.value : at.toISOString());
    }

    text.addEventListener('input', () => {
        /**
         * Reported as typed. Nothing is rewritten while the caret is moving, so
         * "1" on the way to "15/09/2026" is not turned into a date — and because
         * `emit` reads both boxes out of the DOM rather than from what it was
         * last told, a time already chosen is not lost by typing the date after
         * it. Blur normalises.
         */
        onChange?.(text.value);
    });
    text.addEventListener('blur', () => {
        const parsed = parseTypedDate(text.value);
        if (parsed && parsed !== text.value) text.value = parsed;
        emit();
    });
    time?.addEventListener('change', emit);

    return h('div.date-field', text, time, pickerWrap);
}

/** An ISO value split into the two boxes that edit it. */
function splitValue(value, withTime) {
    if (!value) return { date: '', time: '' };
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) return { date: String(value).slice(0, 10), time: '' };
    if (!withTime) return { date: String(value).slice(0, 10), time: '' };
    const pad = (n) => String(n).padStart(2, '0');
    return {
        // Local, because the boxes are what the reader sees and they read in
        // their own timezone. `emit` converts back on the way out.
        date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
        time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
    };
}
