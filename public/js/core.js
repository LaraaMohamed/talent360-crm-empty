/**
 * DOM helpers, formatting and the router.
 *
 * No framework. The whole client is ES modules served as-is — no build step, no
 * bundler, no transpiler, matching the rest of this project. `h()` returns real
 * DOM nodes, so there is no virtual DOM to reason about and no reconciliation
 * to debug.
 */

/**
 * `h('div.card', { onclick }, 'text', childNode)`
 *
 * The tag accepts CSS-ish shorthand: `button.btn.primary`, `span#total`.
 * Anything null, undefined or false in the children is skipped, so
 * `cond && h(...)` works inline.
 */
export function h(spec, props, ...children) {
    const [tag, ...classes] = String(spec).split('.');
    const [name, elementId] = tag.split('#');
    const el = document.createElement(name || 'div');
    if (elementId) el.id = elementId;
    if (classes.length) el.className = classes.join(' ');

    if (props && (typeof props !== 'object' || props.nodeType || Array.isArray(props))) {
        children.unshift(props);
        props = null;
    }

    for (const [key, value] of Object.entries(props ?? {})) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') el.className = `${el.className} ${value}`.trim();
        else if (key === 'html') el.innerHTML = value;
        else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
        else if (key === 'dataset') Object.assign(el.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
        else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') el[key] = value;
        else el.setAttribute(key, value === true ? '' : value);
    }

    append(el, children);
    return el;
}

function append(el, children) {
    for (const child of children) {
        if (child === null || child === undefined || child === false || child === true) continue;
        if (Array.isArray(child)) append(el, child);
        else if (child.nodeType) el.appendChild(child);
        else el.appendChild(document.createTextNode(String(child)));
    }
}

export function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
}

export function mount(el, ...children) {
    clear(el);
    append(el, children);
    return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ============================================================== formatting = */

export const VERDICT_SHAPES = {
    QUALIFIED: '●',
    REVIEW: '◐',
    REJECTED: '○',
    UNRESOLVED: '◌',
    ERROR: '⊘',
};

export const VERDICT_MEANING = {
    QUALIFIED: 'The evidence proves the rule is met.',
    REVIEW: 'The evidence cannot answer the question. Not a rejection — a lead still to be checked.',
    REJECTED: 'The evidence proves the rule is not met.',
    UNRESOLVED: 'There is no identity to collect evidence against.',
    ERROR: 'Collection failed for this company.',
};

let locale = 'en';
let timezone = undefined;
let baseCurrency = 'SAR';

export function configureFormatting(options) {
    locale = options.locale ?? locale;
    timezone = options.timezone ?? timezone;
    baseCurrency = options.baseCurrency ?? baseCurrency;
}

export function money(amount, currency = baseCurrency) {
    const n = Number(amount) || 0;
    try {
        return new Intl.NumberFormat(locale, {
            style: 'currency', currency, maximumFractionDigits: 0,
        }).format(n);
    } catch {
        return `${currency} ${Math.round(n).toLocaleString()}`;
    }
}

export function number(value) {
    if (value === null || value === undefined || value === '') return '—';
    return new Intl.NumberFormat(locale).format(Number(value));
}

/** Dates render in the VIEWER's timezone. Stored UTC, shown local. */
/**
 * A date somebody TYPED, reduced to `YYYY-MM-DD`.
 *
 * `<input type="date">` looks like a text box and is not one: it is three
 * segments, each accepting two digits before the caret jumps, which is why
 * typing a date felt limited to one or two numbers. These fields are plain text
 * boxes now, and this is what makes that safe.
 *
 * Accepts what people actually write here:
 *
 *   2026-09-01      as stored, and what the box shows back
 *   01/09/2026      day first — this business writes dates the Egyptian and
 *   1-9-2026        Saudi way, and 01/09 is the first of September
 *   2026/09/01      year first with slashes
 *
 * DAY FIRST IS AN ASSUMPTION, and the one thing here that could silently
 * produce a wrong date rather than no date: 03/04/2026 is the third of April,
 * not the fourth of March. It is stated in the field's own hint rather than
 * left for somebody to discover from a contract.
 *
 * Anything it cannot read with confidence comes back null, and the caller
 * keeps the raw text so nobody's typing is thrown away mid-word.
 */
export function parseTypedDate(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return null;

    const iso = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    const dmy = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (!iso && !dmy) return null;

    const [y, m, d] = iso
        ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
        : [Number(dmy[3]), Number(dmy[2]), Number(dmy[1])];

    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    // Round-tripped through a real date, so 31 February is refused rather than
    // rolling quietly into March.
    const at = new Date(Date.UTC(y, m - 1, d));
    if (at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return null;
    return at.toISOString().slice(0, 10);
}

export function date(value, { withTime = false } = {}) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return new Intl.DateTimeFormat(locale, {
        year: 'numeric', month: 'short', day: 'numeric',
        ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
        timeZone: timezone,
    }).format(d);
}

/**
 * The TIME OF DAY on its own, or '' when the instant has none worth showing.
 *
 * A due date is read as "in two days", which is why the tables show `relative`.
 * That is the right answer for a deadline and the wrong one for an appointment:
 * a follow-up the rep promised for half two reads as "tomorrow", and the half two
 * — the part the person on the phone will remember — was only in a tooltip.
 *
 * Midnight comes back empty. Not because midnight is impossible, but because it
 * is what a date with no time looks like once it has been stored as an instant,
 * and "· 00:00" on every task typed without an hour is noise that teaches people
 * to stop reading the column.
 */
export function clock(value) {
    if (!value) return '';
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: timezone,
    }).formatToParts(at).reduce((acc, p) => {
        if (p.type !== 'literal') acc[p.type] = Number(p.value);
        return acc;
    }, {});
    if (!parts.hour && !parts.minute) return '';
    // Read back in the viewer's own locale, so a 12-hour region sees 2:30 pm.
    return new Intl.DateTimeFormat(locale, {
        hour: '2-digit', minute: '2-digit', timeZone: timezone,
    }).format(at);
}

export function dayKey(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return 'Unknown';
    return new Intl.DateTimeFormat(locale, {
        weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', timeZone: timezone,
    }).format(d);
}

export function relative(value) {
    if (!value) return '—';
    const then = new Date(value).getTime();
    if (Number.isNaN(then)) return String(value);
    const seconds = Math.round((then - Date.now()) / 1000);
    const units = [
        ['year', 31536000], ['month', 2592000], ['week', 604800],
        ['day', 86400], ['hour', 3600], ['minute', 60],
    ];
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    for (const [unit, secondsIn] of units) {
        if (Math.abs(seconds) >= secondsIn) return rtf.format(Math.round(seconds / secondsIn), unit);
    }
    return rtf.format(seconds, 'second');
}

/**
 * Words this business writes in capitals, whatever the database stores.
 *
 * `humanise` title-cases the first letter, which turns the agreement type
 * `msa` into "Msa" and the service `od` into "Od" — on the badge at the top of
 * every contract. They are acronyms, and an acronym rendered as a name reads as
 * a typo the product made about its own vocabulary.
 *
 * A list rather than a rule, because there is no rule: "sow" is an acronym and
 * "won" is a word, and nothing about the strings distinguishes them.
 */
const ACRONYMS = new Set(['msa', 'sow', 'hcm', 'od', 'crm', 'sdr', 'icp', 'mrr', 'arr', 'tcv', 'vat', 'cr', 'kpi', 'sla']);

export function humanise(value) {
    if (value === null || value === undefined || value === '') return '—';
    if (String(value).toLowerCase() === 'queued') return 'Ready to cold call';
    return String(value)
        .replace(/[_-]+/g, ' ')
        .split(' ')
        .map((word, i) => {
            if (ACRONYMS.has(word.toLowerCase())) return word.toUpperCase();
            return i === 0 ? word.replace(/^\w/, (c) => c.toUpperCase()) : word;
        })
        .join(' ');
}

export function initials(name) {
    return String(name ?? '?')
        .split(/\s+/).filter(Boolean).slice(0, 2)
        .map((p) => p[0]?.toUpperCase() ?? '')
        .join('') || '?';
}

export function bytes(n) {
    const value = Number(n) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1048576) return `${(value / 1024).toFixed(0)} KB`;
    return `${(value / 1048576).toFixed(1)} MB`;
}

/* ================================================================= router = */

const routes = [];
let notFoundHandler = null;
let currentCleanup = null;

export function route(pattern, handler) {
    const keys = [];
    const source = pattern
        .replace(/[.+*?^${}()|[\]\\]/g, '\\$&')
        .replace(/:(\w+)/g, (_, key) => { keys.push(key); return '([^/]+)'; });
    routes.push({ regex: new RegExp(`^${source}$`), keys, handler });
}

export function setNotFound(handler) { notFoundHandler = handler; }

export function navigate(path, { replace = false } = {}) {
    if (replace) history.replaceState({}, '', path);
    else history.pushState({}, '', path);
    render();
}

export function currentPath() {
    return location.pathname + location.search;
}

export function params() {
    return Object.fromEntries(new URLSearchParams(location.search));
}

/** Updates the query string without re-rendering the whole page. */
export function setParams(next, { replace = true } = {}) {
    const search = new URLSearchParams(location.search);
    for (const [key, value] of Object.entries(next)) {
        if (value === null || value === undefined || value === '') search.delete(key);
        else search.set(key, value);
    }
    const query = search.toString();
    const url = location.pathname + (query ? `?${query}` : '');
    if (replace) history.replaceState({}, '', url);
    else history.pushState({}, '', url);
}

export async function render() {
    if (currentCleanup) {
        try { currentCleanup(); } catch { /* a failing teardown must not block the next page */ }
        currentCleanup = null;
    }
    const path = location.pathname;
    for (const r of routes) {
        const match = r.regex.exec(path);
        if (!match) continue;
        const args = {};
        r.keys.forEach((key, i) => { args[key] = decodeURIComponent(match[i + 1]); });
        currentCleanup = await r.handler(args, params());
        return;
    }
    if (notFoundHandler) currentCleanup = await notFoundHandler();
}

export function startRouter() {
    window.addEventListener('popstate', render);
    // One delegated listener instead of one per link, so links inside
    // re-rendered content keep working without re-binding.
    document.addEventListener('click', (event) => {
        const link = event.target.closest('a[href]');
        if (!link) return;
        const href = link.getAttribute('href');
        if (!href?.startsWith('/') || link.target === '_blank' || link.hasAttribute('download')) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(href);
    });
    /**
     * Scrolling the PAGE must never edit a number, just because the cursor
     * happened to be sitting over one. Chrome/Firefox both apply a mouse
     * wheel to a focused `<input type="number">` as +/-1 on its value, which
     * reads as "the number decreases by itself" the moment a scroll passes
     * over a stat, a price or a quantity field. Blurring it the instant a
     * wheel event arrives hands the scroll straight back to the page — the
     * one delegated listener covers every number input on every screen,
     * including ones that do not exist yet.
     */
    document.addEventListener('wheel', (event) => {
        const target = event.target;
        if (target instanceof HTMLInputElement && target.type === 'number' && document.activeElement === target) {
            target.blur();
        }
    }, { passive: true });
    render();
}

/* ================================================================= toasts = */

export function toast(message, kind = '') {
    const el = h(`div.toast.${kind}`.replace(/\.$/, ''), message);
    const host = document.getElementById('toasts');
    host.appendChild(el);
    /**
     * A "loading" toast is a promise, not an announcement — the caller holds
     * onto what this returns specifically to remove it once the work is
     * actually done (see bulk verify/score/etc.). Auto-dismissing it on the
     * same fixed timer as "Saved" raced that: a run taking longer than the
     * timeout (bulk email verification is explicitly rate-limited and can
     * run past it) saw its OWN loading toast vanish while still working,
     * making the page read as having silently finished — or failed — with
     * nothing to say it hadn't. It stays until the caller removes it.
     */
    if (kind === 'loading') return el;
    setTimeout(() => {
        el.style.opacity = '0';
        el.style.transition = 'opacity var(--duration-normal)';
        setTimeout(() => el.remove(), 250);
        // A warning usually carries a sentence explaining itself, and a sentence
        // needs longer on screen than "Saved" does.
    }, kind === 'error' || kind === 'warning' ? 6000 : 3500);
    return el;
}

/* ================================================================= modals = */

/**
 * Nested overlays — a modal opened from inside an already-open drawer
 * (Smartlead's "Add to Smartlead" → "Field mapping…" is the case that
 * surfaced this), or a modal opened from another modal. Two problems, one
 * cause: every modal shared one fixed z-index and every drawer shared
 * another, so whichever kind opened SECOND could land BEHIND the one
 * already open instead of on top of it — visually tangled, and its own ✕
 * button unreachable because a lower-stacked element cannot be clicked
 * through a higher one sitting over it.
 *
 * `nextZIndex()` hands out a strictly increasing value, so the Nth overlay
 * opened is always visually and interactively above the first N-1,
 * regardless of whether it is a modal or a drawer. `overlayStack` tracks
 * only the TOPMOST overlay's Escape/Tab handling — without it, opening a
 * second overlay left the first one's `keydown` listener still attached, so
 * Escape closed both at once and Tab could trap focus in the wrong one.
 */
let zIndexCounter = 50;
function nextZIndex() { zIndexCounter += 10; return zIndexCounter; }

const overlayStack = [];
let stackListenerAttached = false;
function ensureStackListener() {
    if (stackListenerAttached) return;
    stackListenerAttached = true;
    document.addEventListener('keydown', (event) => {
        const top = overlayStack[overlayStack.length - 1];
        if (!top) return;
        if (event.key === 'Escape') top.onEscape();
        if (event.key === 'Tab') top.onTab(event);
    });
}
function pushOverlay(entry) {
    ensureStackListener();
    overlayStack.push(entry);
}
function popOverlay(entry) {
    const i = overlayStack.indexOf(entry);
    if (i !== -1) overlayStack.splice(i, 1);
}

/**
 * Opens a modal and returns a promise resolving to whatever `close(value)`
 * receives.
 *
 * Focus moves into the dialog and returns to the trigger on close, and
 * Escape closes it. A click on the backdrop does NOT close it — an
 * accidental click outside a dialog full of typed-in work used to throw it
 * away with no warning; only ✕, Cancel or an explicit close(value) call
 * exits now.
 */
export function modal({ title, body, footer, size = '', onOpen, closeGuard }) {
    return new Promise((resolve) => {
        const previous = document.activeElement;
        let settled = false;

        const stackEntry = { onEscape: () => guardedClose(undefined), onTab: (event) => trapFocus(event, dialog) };

        const close = (value) => {
            if (settled) return;
            settled = true;
            overlay.remove();
            popOverlay(stackEntry);
            previous?.focus?.();
            resolve(value);
        };

        /**
         * The accidental-close guard.
         *
         * Escape, a backdrop click and the ✕ all mean "out". For a dialog with
         * unsaved work that is a data-loss click, so a caller can pass
         * `closeGuard` — an async predicate — and every one of those paths asks
         * it first. Returning false keeps the dialog open and the work intact.
         * `close` itself is deliberately NOT guarded: it is the result of a
         * deliberate action (Save, Cancel after confirming), and blocking it
         * would strand a dialog that can never close.
         */
        const guardedClose = (value) => {
            if (settled) return;
            const proceed = () => close(value);
            if (!closeGuard) return proceed();
            Promise.resolve(closeGuard()).then((ok) => { if (ok) proceed(); });
        };

        /**
         * The header — and with it, the only ✕ this dialog has — used to be
         * skipped entirely for a titleless modal (`title && h(...)`). The
         * command palette is exactly that: no title, no footer, no backdrop
         * click (see the guard above), so on a phone — no Escape key to
         * press — it opened with literally no way to close it short of
         * picking a search result. `title` still decides whether an `<h2>`
         * appears; it no longer decides whether the dialog can be closed.
         */
        const dialog = h(`div.modal.${size}`.replace(/\.$/, ''), { role: 'dialog', 'aria-modal': 'true', 'aria-label': title ?? 'Dialog' },
            h('div.modal-header',
                title ? h('h2', title) : h('div.spacer'),
                title && h('div.spacer'),
                h('button.btn.ghost.icon', { onclick: () => guardedClose(undefined), 'aria-label': 'Close' }, '✕'),
            ),
            h('div.modal-body', typeof body === 'function' ? body(close) : body),
            footer && h('div.modal-footer', typeof footer === 'function' ? footer(close) : footer),
        );

        // Always painted, and always clickable, above whatever else is
        // already open — see the comment on nextZIndex() above.
        const z = nextZIndex();
        const overlay = h('div.overlay', { style: { zIndex: z } }, dialog);

        document.body.appendChild(overlay);
        pushOverlay(stackEntry);
        (dialog.querySelector('input, textarea, select, button.primary') ?? dialog).focus?.();
        onOpen?.(dialog, guardedClose);
    });
}

function trapFocus(event, container) {
    const focusable = container.querySelectorAll(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

export async function confirm({ title, message, confirmLabel = 'Confirm', danger = false }) {
    return modal({
        title,
        size: 'narrow',
        body: h('p.muted', message),
        footer: (close) => [
            h('button.btn', { onclick: () => close(false) }, 'Cancel'),
            h(`button.btn.${danger ? 'danger' : 'primary'}`, { onclick: () => close(true) }, confirmLabel),
        ],
    }).then((value) => value === true);
}

/* ================================================================ drawers = */

/**
 * A DRAWER — the same contract as `modal`, side-sheet instead of dialog.
 *
 * Multi-step work (wizards, mapping, long forms) outgrew modals: a centered
 * box asking for twelve decisions reads as an application trapped in a
 * popup. A drawer gives that work room without navigation, keeps the record
 * visible behind it on wide screens, and becomes the existing bottom sheet
 * on phones. Focus trap, Escape, closeGuard and focus-restore behave exactly
 * as `modal`'s do — one contract, two shapes. A click on the scrim does NOT
 * close it, same reasoning as modal's backdrop.
 */
export function drawer({ title, body, footer, closeGuard, onOpen }) {
    return new Promise((resolve) => {
        const previous = document.activeElement;
        let settled = false;

        const stackEntry = { onEscape: () => guardedClose(undefined), onTab: (event) => trapFocus(event, panel) };

        const close = (value) => {
            if (settled) return;
            settled = true;
            panel.classList.remove('open');
            scrim.remove();
            popOverlay(stackEntry);
            setTimeout(() => panel.remove(), 200);
            previous?.focus?.();
            resolve(value);
        };

        const guardedClose = (value) => {
            if (settled) return;
            const proceed = () => close(value);
            if (!closeGuard) return proceed();
            Promise.resolve(closeGuard()).then((ok) => { if (ok) proceed(); });
        };

        const panel = h('aside.drawer', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title ?? 'Panel' },
            h('div.drawer-header',
                h('h2', title),
                h('div.spacer'),
                h('button.btn.ghost.icon', { onclick: () => guardedClose(undefined), 'aria-label': 'Close' }, '✕'),
            ),
            h('div.drawer-body', typeof body === 'function' ? body(close) : body),
            footer && h('div.drawer-footer', typeof footer === 'function' ? footer(close) : footer),
        );

        // Same reasoning as modal's overlay z-index — a drawer opened while
        // another modal or drawer is already open must land, and stay,
        // click-through-ably on top of it, not underneath.
        const z = nextZIndex();
        const scrim = h('div.scrim', { style: { zIndex: z } });
        panel.style.zIndex = String(z + 1);

        document.body.appendChild(scrim);
        document.body.appendChild(panel);
        // Next frame so the transform transition actually plays.
        requestAnimationFrame(() => panel.classList.add('open'));
        pushOverlay(stackEntry);
        (panel.querySelector('input, textarea, select, button.primary') ?? panel).focus?.();
        onOpen?.(panel, guardedClose);
    });
}

/* ================================================================== misc = */

export function debounce(fn, ms = 250) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

/**
 * `h()`/`mount()` always build fresh DOM nodes — there is no reconciliation.
 * A rebuild triggered by typing (an `oninput` that repaints its own container)
 * therefore throws away the very input the user is typing into, along with
 * its focus and caret. Every editable field that can trigger its own repaint
 * must tag itself with `data-focus-key` and wrap the repaint in these two
 * calls, or the field only ever accepts one keystroke before losing focus.
 */
export function captureFocus(root) {
    const el = document.activeElement;
    if (!el || !root.contains(el)) return null;
    const key = el.dataset?.focusKey;
    if (!key) return null;
    return { key, start: el.selectionStart, end: el.selectionEnd };
}

export function restoreFocus(root, snapshot) {
    if (!snapshot) return;
    const el = root.querySelector(`[data-focus-key="${CSS.escape(snapshot.key)}"]`);
    if (!el) return;
    el.focus();
    if (typeof el.setSelectionRange === 'function' && snapshot.start != null) {
        try { el.setSelectionRange(snapshot.start, snapshot.end); } catch { /* not a text-selectable input */ }
    }
}

export function group(items, keyOf) {
    const map = new Map();
    for (const item of items) {
        const key = keyOf(item);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(item);
    }
    return map;
}

export function setTheme(theme) {
    if (theme === 'system') {
        document.documentElement.removeAttribute('data-theme');
        localStorage.removeItem('crm-theme');
    } else {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('crm-theme', theme);
    }
}

/**
 * Row height, as a workspace-wide preference rather than a per-table toggle.
 *
 * A density control on every list is a control the reader meets a dozen times
 * and sets once. It belongs where the theme is: chosen in Settings, stamped on
 * the document, obeyed by every table at once.
 *
 * "Comfortable" is the default and stamps nothing, so a browser that has never
 * been told behaves exactly as it always did.
 */
export function setDensity(density) {
    if (density === 'compact') {
        document.documentElement.setAttribute('data-density', 'compact');
        localStorage.setItem('crm-density', 'compact');
    } else {
        document.documentElement.removeAttribute('data-density');
        localStorage.removeItem('crm-density');
    }
}

export function initDensity() {
    if (localStorage.getItem('crm-density') === 'compact') {
        document.documentElement.setAttribute('data-density', 'compact');
    }
}

export function initTheme() {
    const saved = localStorage.getItem('crm-theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
}

export function setDirection(dir) {
    document.documentElement.setAttribute('dir', dir);
}
