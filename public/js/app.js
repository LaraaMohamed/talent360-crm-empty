/**
 * Application shell and routing.
 */
import {
    h, mount, clear, route, setNotFound, startRouter, navigate, render, currentPath,
    toast, modal, initTheme, setTheme, initDensity, configureFormatting, debounce, initials, relative,
} from './core.js';
import { api, setUnauthorizedHandler } from './api.js';
import * as store from './store.js';
import { avatar, emptyState, errorState, skeletonRows, icon } from './components.js';
import { createNotificationBell } from './notifications.js';

import { loginPage, resetPage } from './pages/login.js';
import { dashboardPage } from './pages/dashboard.js';
import { listPage } from './pages/list.js';
import { recordPage } from './pages/record.js';
import { boardPage } from './pages/board.js';
import { qualificationPage } from './pages/qualification.js';
import { peopleSearchPage } from './pages/people-search.js';
import { listsPage } from './pages/lists.js';
import { settingsPage } from './pages/settings.js';
import { importPage } from './pages/import.js';
import { uploadsPage } from './pages/uploads.js';
import { searchPage } from './pages/search.js';
import { myWorkPage } from './pages/my-work.js';
import { renewalsPage } from './pages/renewals.js';
import { meetingsPage } from './pages/meetings.js';
import { calendarPage } from './pages/calendar.js';
import { callingWorkspace } from './pages/calling.js';
import { smartleadPage } from './pages/smartlead.js';

const root = document.getElementById('root');
let shell = null;

/**
 * The pages that work without a session.
 *
 * `/reset` has to be one of them: the person spending a reset link cannot sign
 * in, which is the reason they were sent the link. Bouncing them to /login
 * would make the whole flow unusable.
 */
const SESSION_FREE = new Set(['/login', '/reset']);

initTheme();
initDensity();
setUnauthorizedHandler(() => {
    shell = null;
    if (!SESSION_FREE.has(location.pathname)) navigate('/login');
});

/* ================================================================== shell = */

/**
 * The sidebar: eight destinations and one folded section, down from nineteen.
 *
 * ── WHAT WAS WRONG WITH NINETEEN ────────────────────────────────────────────
 *
 * The old list was named after STORAGE. "Records", "Work" and "Intelligence"
 * are categories of table, not categories of work, and four of the rows —
 * Tasks, Activities, Notes and Documents — were record types rather than
 * destinations. Nobody opens a CRM to browse every note in the company; they
 * want the ones that are theirs, which is what /my-work is for. Those four
 * routes still exist, are still linked from every record that has them, and are
 * still one search away. They are simply not four of the things a person has to
 * choose between on arrival.
 *
 * Search came out for the opposite reason: it had three entry points — this
 * row, the topbar box and ⌘K — for one destination.
 *
 * ── WHAT `when` IS FOR ──────────────────────────────────────────────────────
 *
 * Capabilities are not known when this list is defined, only when the shell is
 * built, so role rules are predicates rather than static flags. They decide
 * what is DRAWN. What is ALLOWED is decided by lib/auth.mjs, before any handler
 * runs — hiding a row has never been the security boundary and is not one here.
 */

/** Can this person create or change anything at all? */
const canWrite = () => store.can('record.write.all') || store.can('record.write.own');

const NAV = [
    {
        label: null,
        items: [
            { href: '/', label: 'Dashboard', icon: 'dashboard' },
            // Tasks, activities and notes — plus the Approvals queue — filtered
            // to the person reading them. This is the row that replaced four.
            { href: '/my-work', label: 'My work', icon: 'check' },
            // /calendar is real and routed (renewal dates and meetings, laid
            // out by day — see api/calendar.mjs) but deliberately NOT a row
            // here: it is linked from /renewals and from /meetings (below)
            // instead of claiming a second top-level destination for the
            // same underlying data.
        ],
    },
    {
        label: null,
        items: [
            {
                href: '/calling', label: 'Cold calling', icon: 'phone',
                when: () => store.can('calling.manage') || store.can('calling.work'),
            },
        ],
    },
    {
        label: 'Sales',
        items: [
            { href: '/accounts', label: 'Accounts', icon: 'building' },
            { href: '/contacts', label: 'Contacts', icon: 'contact' },
            // Opens on the board, because a pipeline is the shape people think
            // about deals in. The table is a toggle away and the choice lives in
            // the URL, so either can be linked to.
            { href: '/deals', label: 'Deals', icon: 'deal' },
            { href: '/meetings', label: 'Meetings', icon: 'calendar' },
            // Curated/dynamic audiences remain routed at /lists and are linked
            // from Accounts' toolbar — a cross-cutting tool, not a daily row.
        ],
    },
    /**
     * DOCUMENTS — everything we send or sign, in one place.
     *
     * Proposals and Agreements are not two departments; they are stages of the
     * same conversation with a client, and Renewals is how those conversations
     * come back around. Grouping them ends the "which sidebar row was the
     * contract under?" hunt without changing a single URL.
     */
    {
        label: 'Documents',
        key: 'documents',
        collapsible: true,
        items: [
            { href: '/proposals', label: 'Proposals', icon: 'proposal' },
            { href: '/agreements', label: 'Agreements', icon: 'agreement' },
            { href: '/renewals', label: 'Renewals', icon: 'agreement' },
        ],
    },
    {
        label: 'Outreach',
        key: 'outreach',
        collapsible: true,
        items: [
            // Campaigns are the outreach execution layer (Smartlinked or not);
            // they answer "who are we sequencing and what came back".
            { href: '/campaigns', label: 'Campaigns', icon: 'campaign' },
            // Not a nav row of its own — the sidebar has a 16-destination
            // budget (see the "stays small enough to choose from" test) and
            // this is one campaign-management screen, not a new section.
            // Reached from the Campaigns list header and from Settings →
            // Integrations → Smartlead instead.
        ],
    },
    /**
     * Everything upstream of an Account, folded into one section.
     *
     * These are the tools that turn an uploaded list into companies worth
     * working. A rep opens Accounts, Contacts and Deals many times a shift and
     * these occasionally, which is exactly the ordering a folded section
     * expresses.
     *
     * Hidden entirely from a role that cannot act on any of it — a readonly
     * user was being offered an Import screen that refuses them.
     */
    {
        label: 'Sourcing',
        key: 'prospecting',
        collapsible: true,
        /**
         * Gated on the capability the SERVER enforces, not on a proxy for it.
         *
         * It used to read `qualification.run || canWrite()`, which a rep
         * satisfied — so the rows were drawn, and the endpoints behind them
         * answered 200. Hiding them now would still not be the boundary; the
         * boundary is `routeAllowed`. This just stops offering a door that is
         * locked.
         */
        when: () => store.can('prospecting.read'),
        items: [
            // The entry point of sourcing — a list becomes prospecting
            // companies and contacts here before anything below has
            // something to work. Gated on write, matching what the import
            // endpoint itself requires, not on the group's read gate.
            { href: '/import', label: 'Import', icon: 'upload', when: () => canWrite() },
            { href: '/prospects', label: 'Companies', icon: 'prospects' },
            // Apollo people-search lives here too: the People page hosts the
            // same finder as a primary action, so the row earns its slot once
            // instead of twice. /people-search stays routed for deep links.
            { href: '/prospecting_contacts', label: 'People', icon: 'people' },
            { href: '/qualification', label: 'Qualification', icon: 'qualification' },
        ],
    },
    {
        label: 'Admin',
        key: 'admin',
        collapsible: true,
        when: () => store.can('record.write.all'),
        items: [
            { href: '/settings', label: 'Settings', icon: 'board' },
            // Import itself now lives in Sourcing, where the work is. Its
            // audit trail stays here and is linked from Qualification, where
            // uploads are worked.
            { href: '/uploads', label: 'Upload history', icon: 'history' },
        ],
    },
];

function buildShell() {
    // First Tab on any page jumps straight to the content — the sidebar has
    // ~15 stops before it otherwise. Lives outside the sidebar so it works
    // with the drawer closed on mobile too.
    const skipLink = h('a.skip-link', { href: '#content' }, 'Skip to content');
    const sidebar = h('aside.sidebar', { id: 'sidebar' },
        h('a.sidebar-brand', { href: '/' },
            h('span.mark', h('img', { src: '/logo.png', alt: 'Talent 360', style: { height: '32px', width: 'auto', objectFit: 'contain', display: 'block' } })),
            h('span.sidebar-brand-name',
                `${store.state.meta.workspace.name} `,
                h('small', 'CRM'),
            ),
        ),
        /**
         * Who you are, at the TOP.
         *
         * It sat at the bottom, pinned there by an auto margin, which put the
         * two facts a person checks first — which workspace am I in, and who am
         * I signed in as — at opposite ends of the column with fifteen
         * navigation rows between them. On a short viewport the second one was
         * below the fold entirely, so "am I in the right account?" required a
         * scroll.
         *
         * They belong together: the brand says where, this says who, and
         * Settings is the thing you reach for immediately after reading either.
         */
        h('nav.nav', { 'aria-label': 'Main' }, NAV.map(navGroup)),
    );

    const scrim = h('div.scrim', { style: { display: 'none' }, onclick: () => toggleSidebar(false) });

    const searchTrigger = h('button.search-trigger', { onclick: openPalette },
        h('span', { 'aria-hidden': 'true' }, '⌕'),
        h('span.label', 'Search accounts, contacts, deals…'),
        h('kbd', navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl K'),
    );

    // The bell is the shared module — same badge, panel and polling the SDR
    // calling shell mounts, so neither surface can drift from the other.
    const notifications = createNotificationBell();
    notifications.startPolling();

    const topbar = h('header.topbar',
        h('button.btn.ghost.icon.mobile-only', { 'aria-label': 'Menu', onclick: () => toggleSidebar() }, '☰'),
        h('div.topbar-title', { id: 'page-title' }, ''),
        h('div.topbar-actions',
            searchTrigger,
            notifications.el,
            h('button.btn.ghost.icon', {
                title: 'Theme',
                onclick: () => {
                    const current = document.documentElement.getAttribute('data-theme');
                    setTheme(current === 'dark' ? 'light' : current === 'light' ? 'system' : 'dark');
                },
            }, '◐'),

            /**
             * Who you are, top right, where people look for it.
             *
             * It has been at the bottom of the sidebar and then at the top of
             * it. Both were wrong for the same reason: a sidebar is for going
             * places, and on a narrow screen it is a drawer behind a hamburger
             * — so "which account am I signed in as?" was a question that
             * needed a click to answer on a phone. Top right is where the
             * convention puts it, and it is already where this product keeps
             * the other things that are about YOU rather than about the page:
             * notifications and the theme.
             *
             * The WHOLE control is the link, not a gear beside it. A name that
             * looks like a label and a 16px cog that is the only live target
             * makes the reader hunt for the hit area; here the avatar, the
             * name and the role are one anchor, and the cog goes away.
             */
            h('a.topbar-user', {
                href: '/settings',
                title: `Signed in as ${store.state.me.user.name} · ${store.state.me.role}`,
            },
            avatar(store.state.me.user.name),
            h('div.topbar-user-text',
                h('div.small.truncate', store.state.me.user.name),
                h('div.xs.dim.truncate', store.state.me.role),
            ),
            ),
        ),
    );

    // tabindex=-1 makes the region focusable so the skip link's #content
    // actually moves keyboard focus, not just the scroll position.
    const content = h('main.content', { id: 'content', tabindex: '-1' });

    return h('div.app', skipLink, sidebar, scrim, h('div.main', topbar, content));
}

function navGroup(group) {
    // A whole section can be irrelevant to a role, not just a row in it.
    if (group.when?.() === false) return null;

    const items = group.items.filter((i) => !i.hidden && i.when?.() !== false).map((item) => h('a.nav-item', {
        href: item.href, dataset: { href: item.href },
    },
    icon(item.icon),
    h('span', item.label),
    ));

    // A group whose every row was hidden must not leave its heading, or its
    // spacing, behind — that reads as a section that failed to load.
    if (!items.length) return null;

    if (!group.collapsible) {
        return h('div.nav-group', group.label && h('div.nav-label', group.label), items);
    }

    const bodyId = `nav-${group.key}`;
    return h('div.nav-group', { dataset: { group: group.key } },
        h('button.nav-label.nav-toggle', {
            type: 'button',
            'aria-controls': bodyId,
            'aria-expanded': 'false',
            onclick: () => {
                const el = document.querySelector(`.nav-group[data-group="${group.key}"]`);
                setGroupOpen(group.key, !el?.classList.contains('open'), true);
            },
        },
        h('span.nav-chevron', { 'aria-hidden': 'true' }, '▸'),
        h('span', group.label),
        ),
        h('div.nav-collapse', { id: bodyId }, items),
    );
}

/**
 * Which sections the user has opened. Absent means closed, so a section is
 * secondary until someone says otherwise — which is the point of folding
 * Prospecting away in the first place.
 */
const NAV_OPEN_KEY = 'crm.nav.open';

function openGroups() {
    try { return new Set(JSON.parse(localStorage.getItem(NAV_OPEN_KEY) ?? '[]')); } catch { return new Set(); }
}

function setGroupOpen(key, open, remember) {
    const group = document.querySelector(`.nav-group[data-group="${key}"]`);
    if (!group) return;
    group.classList.toggle('open', open);
    group.querySelector('.nav-toggle')?.setAttribute('aria-expanded', String(open));
    if (!remember) return;

    const stored = openGroups();
    if (open) stored.add(key); else stored.delete(key);
    // Private browsing refuses to store; the sidebar still works, it just
    // forgets between reloads.
    try { localStorage.setItem(NAV_OPEN_KEY, JSON.stringify([...stored])); } catch { /* not fatal */ }
}

function toggleSidebar(force) {
    const sidebar = document.getElementById('sidebar');
    const scrim = document.querySelector('.scrim');
    const open = force ?? !sidebar.classList.contains('open');
    sidebar.classList.toggle('open', open);
    if (scrim) scrim.style.display = open ? 'block' : 'none';
}

export function setPageTitle(title) {
    const el = document.getElementById('page-title');
    if (el) el.textContent = title;
    document.title = title ? `${title} · CRM` : 'CRM';
}

function markActiveNav() {
    const path = location.pathname;
    for (const link of document.querySelectorAll('.nav-item')) {
        const href = link.dataset.href;
        const active = href === '/' ? path === '/' : path.startsWith(href);
        link.classList.toggle('active', active);
    }

    /**
     * A folded section must never hide the page the user is actually on —
     * including on a cold load or a refresh straight into /qualification,
     * where nothing was clicked to open it.
     */
    const stored = openGroups();
    for (const group of document.querySelectorAll('.nav-group[data-group]')) {
        const key = group.dataset.group;
        const holdsActive = Boolean(group.querySelector('.nav-item.active'));
        setGroupOpen(key, holdsActive || stored.has(key), false);
    }
}

/**
 * Renders a page into the shell, creating the shell on first use.
 *
 * Every page handler returns its cleanup function (or nothing), which the
 * router calls before the next page renders.
 */
/**
 * Roles confined to one workspace get their own boot, not the CRM shell.
 *
 * `page()` below opens by fetching /api/meta, /api/views and /api/lists. For an
 * SDR all three answer 403 by design, so the ordinary path cannot start at all
 * — this one asks for /api/me and nothing else.
 */
const CONFINED_HOME = { sdr: '/calling' };

/**
 * Whether this role gets no shell at all — so a page that IS reachable for a
 * confined role (`/my-work`, `/calling`) knows to draw its own way back to
 * the other one, rather than leaving a confined SDR stuck on whichever of
 * the two they landed on with no sidebar to click out through.
 */
export function isConfinedRole(role) {
    return Boolean(CONFINED_HOME[role]);
}

let identity = null;

async function whoami() {
    if (!identity) identity = await api.get('/api/me');
    return identity;
}

async function confinedPage(builder) {
    let me;
    try {
        me = await whoami();
        /**
         * A confined screen is metadata-driven like every other one.
         *
         * This path used to load `/api/me` and nothing else, which is why the
         * calling queue had no columns for an SDR: `store.fields()` reads the
         * registry, the registry is `/api/meta`, and nobody had asked for it.
         * The Columns dialog then reported "0 shown" and "every field is
         * already shown" — both correct answers about an empty registry.
         *
         * Views come too, so a saved filter is available on the one screen this
         * role has. `refreshLists()` deliberately does NOT: lists are not
         * reachable for a confined role and asking would only 403 the boot.
         */
        if (!store.state.meta) {
            await store.loadMeta();
            await store.refreshViews();
        }
    } catch (err) {
        if (err.status === 401) return navigate('/login', { replace: true });
        mount(root, errorState(err.message, () => location.reload()));
        return undefined;
    }
    configureFormatting({
        locale: me.workspace?.locale,
        timezone: me.workspace?.timezone,
        baseCurrency: me.workspace?.baseCurrency,
    });
    // The CRM shell must not be left on screen underneath.
    shell = null;
    return builder(root, { me });
}

/**
 * Where a role belongs when it asks for "/".
 *
 * An SDR opening the CRM should land in their calling workspace, not on a
 * dashboard they cannot load — §19.
 */
async function homeFor() {
    try {
        const me = await whoami();
        return CONFINED_HOME[me.role] ?? null;
    } catch { return null; }
}

/**
 * No route reachable through `page()` may build the full CRM shell for a
 * confined role, even if that role happens to hold read access to the one
 * API this particular page calls.
 *
 * Individual routes (accounts, deals, tasks, /my-work, ...) each call
 * `page()` with no idea who is asking — that used to mean the FIRST one an
 * SDR's browser reached built the shell once and left it mounted for the
 * rest of the session (`shell` is set-once, see below), sidebar and all,
 * with only the CONTENT area then 403ing route by route as they clicked
 * into rows they hold no access to. Checked here, centrally, so no route
 * has to remember to guard itself.
 */
async function confinementRedirect() {
    try {
        const me = await whoami();
        return CONFINED_HOME[me.role] ?? null;
    } catch { return null; }
}

async function page(builder) {
    const confinedHome = await confinementRedirect();
    if (confinedHome && location.pathname !== confinedHome) {
        navigate(confinedHome, { replace: true });
        return undefined;
    }

    if (!store.state.meta) {
        try {
            await store.loadMeta();
            await Promise.all([store.refreshViews(), store.refreshLists()]);
            configureFormatting({
                locale: store.state.meta.workspace.locale,
                timezone: store.state.meta.workspace.timezone,
                baseCurrency: store.state.meta.workspace.baseCurrency,
            });
        } catch (err) {
            if (err.status === 401) return navigate('/login', { replace: true });
            mount(root, errorState(err.message, () => location.reload()));
            return undefined;
        }
    }

    if (!shell) {
        shell = buildShell();
        mount(root, shell);
    }
    markActiveNav();
    toggleSidebar(false);

    const content = document.getElementById('content');
    mount(content, skeletonRows(5));

    try {
        const result = await builder(content);
        return result;
    } catch (err) {
        mount(content, errorState(err.message, () => render()));
        return undefined;
    }
}

/* ======================================================== command palette = */

let paletteOpen = false;

async function openPalette() {
    if (paletteOpen) return;
    paletteOpen = true;

    const results = h('div.palette-results');
    const input = h('input', { type: 'search', placeholder: 'Search accounts, contacts, deals, notes…', 'aria-label': 'Search' });
    let items = [];
    let cursor = 0;

    const paint = () => {
        if (!items.length) {
            results.replaceChildren(h('div.palette-item.dim', input.value.length < 2
                ? 'Type at least two characters.'
                : 'Nothing matched.'));
            return;
        }
        const nodes = [];
        let index = 0;
        let lastGroup = null;
        for (const item of items) {
            if (item.group !== lastGroup) {
                nodes.push(h('div.palette-group-label', item.group));
                lastGroup = item.group;
            }
            const i = index;
            /**
             * Hover moves the keyboard cursor without a full repaint.
             *
             * `paint()` rebuilds every row from scratch (no DOM diffing in
             * this app — see core.js). Calling it on every `mouseenter` used
             * to mean that simply moving the mouse toward a row to click it
             * could swap that row's DOM node out from under the pointer
             * between the mousedown and the mouseup — the same class of bug
             * fixed elsewhere as a focus-loss issue, here showing up as
             * "clicking a result sometimes does nothing." Toggling the
             * `.active` class directly avoids rebuilding anything.
             */
            nodes.push(h(`div.palette-item${i === cursor ? '.active' : ''}`, {
                onclick: () => go(item),
                onmouseenter: (e) => {
                    if (cursor === i) return;
                    nodes[cursor]?.classList.remove('active');
                    cursor = i;
                    e.currentTarget.classList.add('active');
                },
            },
            item.verdict
                ? h('span.dim', { title: 'HCM / Offshoring' }, `${shape(item.verdict.hcm)}${shape(item.verdict.offshoring)}`)
                : h('span.dim', '•'),
            h('div', { style: { minInlineSize: 0 } },
                h('div.truncate', item.title),
                item.subtitle && h('div.sub.truncate', item.subtitle),
                // A contact on somebody's calling queue is one click from
                // here too, not just from Contacts — see the `calling` field
                // search() attaches (api/search.mjs). Navigated explicitly
                // rather than left to the router's delegated click listener
                // (core.js): stopPropagation() here would also swallow the
                // click before it ever reached that document-level listener,
                // so the href would silently do nothing instead of the outer
                // row's `go(item)`.
                item.calling && h('a.sub', {
                    href: `/calling?sdr=${encodeURIComponent(item.calling.sdrId)}&q=${encodeURIComponent(input.value.trim())}&tab=all`,
                    style: { display: 'block' },
                    onclick: (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const href = e.currentTarget.getAttribute('href');
                        close();
                        navigate(href);
                    },
                }, `On ${item.calling.sdrName ?? 'a'}'s calling queue →`),
            ),
            ));
            index += 1;
        }
        if (items.length) {
            nodes.push(h('div.palette-item.dim', { onclick: seeAll },
                h('span', '⌕'),
                h('div', h('div', `Search everything for "${input.value.trim()}"`)),
            ));
        }
        results.replaceChildren(...nodes);
    };

    const shape = (v) => ({ QUALIFIED: '●', REVIEW: '◐', REJECTED: '○', UNRESOLVED: '◌', ERROR: '⊘' }[v] ?? '◌');

    const go = (item) => {
        close();
        navigate(`/${item.route}/${item.id}`);
    };

    // The palette shows the best few per object. When there are more, the
    // full-page search is one keystroke away rather than a thing you have to
    // know exists.
    const seeAll = () => {
        close();
        navigate(`/search?q=${encodeURIComponent(input.value.trim())}`);
    };

    const run = debounce(async () => {
        const query = input.value.trim();
        if (query.length < 2) { items = []; return paint(); }
        try {
            const data = await api.get(`/api/search?q=${encodeURIComponent(query)}`);
            items = data.groups.flatMap((g) => g.records.map((r) => ({ ...r, group: g.label, route: g.route })));
            cursor = 0;
            paint();
        } catch (err) {
            items = [];
            paint();
            toast(err.message, 'error');
        }
    }, 180);

    input.addEventListener('input', run);
    input.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') { event.preventDefault(); cursor = Math.min(cursor + 1, items.length - 1); paint(); }
        if (event.key === 'ArrowUp') { event.preventDefault(); cursor = Math.max(cursor - 1, 0); paint(); }
        if (event.key === 'Enter' && items[cursor]) { event.preventDefault(); go(items[cursor]); }
    });

    let close;
    paint();
    await modal({
        size: 'palette',
        body: (dismiss) => { close = dismiss; return h('div', input, results); },
        onOpen: (dialog) => { dialog.classList.add('palette'); input.focus(); },
    });
    paletteOpen = false;
}

document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (store.state.meta) openPalette();
    }
});

/* ================================================================= routes = */

route('/login', () => loginPage(root, async () => {
    shell = null;
    store.state.meta = null;
    navigate('/');
}));

route('/reset', (_, query) => resetPage(root, query.token ?? '', () => navigate('/login')));

route('/', async () => {
    const confined = await homeFor();
    if (confined) return navigate(confined, { replace: true });
    return page((content) => dashboardPage(content));
});

/**
 * One page, two audiences.
 *
 * An SDR gets it standalone, because the CRM shell cannot boot for them. A
 * manager gets the same page INSIDE the shell — they still need the rest of the
 * CRM one click away — and it opens on the team queue rather than on a console
 * pretending the whole team's list is theirs to ring.
 */
route('/calling', async () => {
    let me;
    try { me = await whoami(); } catch { return navigate('/login', { replace: true }); }
    if (CONFINED_HOME[me.role]) return confinedPage(callingWorkspace);
    return page((content) => callingWorkspace(content, { me, manager: true }));
});

const OBJECT_ROUTES = {
    accounts: 'account', contacts: 'contact', deals: 'deal', tasks: 'task',
    activities: 'activity', notes: 'note', documents: 'document',
    proposals: 'proposal', agreements: 'agreement', campaigns: 'campaign',
    prospects: 'prospecting_company', prospecting_contacts: 'prospecting_contact',
};

/**
 * The routes that are PROSPECTING, and are therefore not a rep's.
 *
 * The server already refuses these — `PROSPECTING_ROUTES` in lib/auth.mjs is
 * the boundary and this is not it. But a route with no guard still BUILDS the
 * page: the list mounts, asks `/api/prospects`, is refused, and draws an error
 * where a rep expected a screen. Worse, it asks at all — the requirement is
 * that a rep's browser never requests prospecting data, not that it be told no.
 *
 * So the page is never constructed, and nothing it would have fetched is
 * fetched. Typing the URL says the same thing the missing sidebar entry says.
 */
const PROSPECTING_ROUTE_NAMES = new Set(['prospects', 'prospecting_contacts']);

function guarded(capability, build) {
    return (...args) => page((content) => {
        if (!store.can(capability)) return notAllowed(content);
        return build(...args)(content);
    });
}

function notAllowed(content) {
    setPageTitle('Not available');
    mount(content, h('div.content-inner', emptyState(
        'That is not part of your workspace',
        'Prospecting is the sourcing book — every company ever uploaded and every verdict computed '
        + 'against one. Accounts, Contacts and Deals are where the work you have been given lives.',
        h('a.btn.primary', { href: '/' }, 'Back to the dashboard'),
    )));
    return undefined;
}

for (const [routeName, objectKey] of Object.entries(OBJECT_ROUTES)) {
    const prospecting = PROSPECTING_ROUTE_NAMES.has(routeName);
    const list = (_, query) => (content) => (
        // Deals default to the board, because a pipeline is the shape people
        // think about deals in. `?view=` overrides it.
        routeName === 'deals' && !query.view && query.layout !== 'table'
            ? boardPage(content)
            : listPage(content, objectKey, routeName)
    );
    const detail = ({ id }) => (content) => recordPage(content, objectKey, routeName, id);

    if (prospecting) {
        route(`/${routeName}`, guarded('prospecting.read', list));
        route(`/${routeName}/:id`, guarded('prospecting.read', detail));
    } else {
        route(`/${routeName}`, (params, query) => page(list(params, query)));
        route(`/${routeName}/:id`, (params) => page(detail(params)));
    }
}

route('/qualification', guarded('prospecting.read', (_, query) => (content) => (
    qualificationPage(content, { tab: query.tab })
)));
route('/people-search', guarded('prospecting.read', () => (content) => peopleSearchPage(content)));
/**
 * Also two audiences, same reason as /calling above.
 *
 * A confined role's own tasks/notes ARE reachable for them (see the sdr
 * allowlist in lib/auth.mjs), so they legitimately land here — but the
 * ordinary page() builder boots the full CRM shell underneath it: Dashboard,
 * Deals, every nav row `/my-work` itself never gates. An SDR opening their
 * own work page saw the whole sidebar and a 403 behind anything else in it.
 */
route('/my-work', async () => {
    let me;
    try { me = await whoami(); } catch { return navigate('/login', { replace: true }); }
    if (CONFINED_HOME[me.role]) return confinedPage((root) => myWorkPage(root));
    return page((content) => myWorkPage(content));
});
// Registered before the object routes below, or /agreements/:id claims it.
route('/renewals', () => page((content) => renewalsPage(content)));
/**
 * Also two audiences, same reason as /calling and /my-work above.
 *
 * A confined SDR's own meetings ARE reachable for them (see the sdr
 * allowlist in lib/auth.mjs — `list()`/`settle()` in api/meetings.mjs force
 * the scope to their own userId), but the ordinary page() builder boots the
 * full CRM shell, which 403s on load for a confined role.
 */
route('/meetings', async () => {
    let me;
    try { me = await whoami(); } catch { return navigate('/login', { replace: true }); }
    if (CONFINED_HOME[me.role]) return confinedPage((root) => meetingsPage(root, { confined: true }));
    return page((content) => meetingsPage(content));
});
route('/calendar', () => page((content) => calendarPage(content)));
route('/outreach/smartlead', () => page((content) => smartleadPage(content)));
route('/lists', () => page((content) => listsPage(content)));
route('/import', () => page((content) => importPage(content)));
route('/uploads', () => page((content) => uploadsPage(content)));
route('/search', (_, query) => page((content) => searchPage(content, query)));
route('/settings', () => page((content) => settingsPage(content)));

setNotFound(() => page((content) => {
    setPageTitle('Not found');
    mount(content, h('div.content-inner', emptyState(
        'That page does not exist',
        `Nothing is routed at ${currentPath()}.`,
        h('a.btn.primary', { href: '/' }, 'Back to the dashboard'),
    )));
}));

/* ================================================================== start = */

(async () => {
    try {
        await api.get('/api/me', { allowUnauthorized: true });
    } catch (err) {
        if (err.status === 401 && !SESSION_FREE.has(location.pathname)) {
            history.replaceState({}, '', '/login');
        }
    }
    startRouter();
})();
