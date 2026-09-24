/**
 * Sourcing → People Search — Apollo's whole database, not anchored to a
 * company already in the CRM.
 *
 * ── HOW THIS DIFFERS FROM "FIND PEOPLE" ─────────────────────────────────────
 *
 * The account/prospecting-company page's "Find people" dialog answers "who
 * works HERE" — the company is already the anchor, and only its domain
 * narrows the query. This page is the other half: search by title,
 * seniority, location, company domain or headcount when the company is not
 * in the CRM yet either, which is most of what Sourcing exists to find.
 *
 * ── EVERY FILTER SHOWN HERE IS ONE APOLLO ACTUALLY SUPPORTS ─────────────────
 *
 * `lib/apollo.mjs` forwards exactly these to the API: person_titles,
 * person_seniorities, person_locations, organization_locations,
 * organization domains, employee-count ranges, keywords. A filter Apollo's
 * search endpoint does not accept — industry as its own field, a department
 * dropdown, "has email" — is not offered here, because a checkbox that does
 * nothing is worse than no checkbox.
 *
 * ── PAGINATION IS PAGE-BASED BECAUSE APOLLO'S IS ────────────────────────────
 *
 * `mixed_people/api_search` takes `page`/`per_page`, not a cursor — so this
 * does too, rather than inventing one. "Select all" is deliberately NOT
 * offered across pages: Apollo's own 50k display cap means "everything
 * matching" can be a number nobody should tick in one click, and a selection
 * spanning pages never fetched would be a claim this page cannot back up —
 * only what is on screen can be selected.
 *
 * ── WHERE A RESULT GOES ──────────────────────────────────────────────────
 *
 * Each ticked person becomes a `prospecting_contact`, filed under a
 * `prospecting_company` found by domain (or matched by name) or created —
 * never a live CRM account. That is the sourcing plane by construction: see
 * api/people-search.mjs `generalImport`. Moving one into the customer book
 * from there is the same "Add to CRM" every other prospecting company
 * already offers.
 */
import { h, mount, toast, number } from '../core.js';
import { api } from '../api.js';
import { emptyState, skeletonRows, icon } from '../components.js';
import { setPageTitle } from '../app.js';

const SENIORITIES = ['c_suite', 'vp', 'director', 'manager', 'senior', 'entry'];
const EMPLOYEE_RANGES = [
    { value: '1,10', label: '1–10' },
    { value: '11,50', label: '11–50' },
    { value: '51,200', label: '51–200' },
    { value: '201,500', label: '201–500' },
    { value: '501,1000', label: '501–1,000' },
    { value: '1001,5000', label: '1,001–5,000' },
    { value: '5001,10000', label: '5,001–10,000' },
    { value: '10001,', label: '10,001+' },
];

function labelOf(p) {
    return p.fullName || [p.firstName, p.lastName].filter(Boolean).join(' ') || '—';
}

export async function peopleSearchPage(content) {
    setPageTitle('People search');

    const filters = {
        titles: '', seniority: '', personLocations: '',
        companyDomains: '', orgLocations: '', employeeRange: '', keywords: '',
    };
    let page = 1;
    let results = [];
    let total = 0;
    let selected = new Set();
    let enriched = new Map();
    let searching = false;
    let searched = false;
    let errorMessage = null;

    const container = h('div.content-inner');
    mount(content, container);

    function fieldToArray(value) {
        return value.split(',').map((s) => s.trim()).filter(Boolean);
    }

    async function search(nextPage = 1) {
        page = nextPage;
        searching = true;
        errorMessage = null;
        paint();
        try {
            const body = {
                person_titles: fieldToArray(filters.titles),
                person_seniorities: filters.seniority ? [filters.seniority] : [],
                person_locations: fieldToArray(filters.personLocations),
                organization_locations: fieldToArray(filters.orgLocations),
                q_organization_domains: fieldToArray(filters.companyDomains),
                organization_num_employees_ranges: filters.employeeRange ? [filters.employeeRange] : [],
                q_keywords: filters.keywords.trim() || undefined,
                page, per_page: 25,
            };
            const res = await api.post('/api/sourcing/people-search', body);
            results = res.people ?? [];
            total = res.total ?? results.length;
            selected = new Set();
            enriched = new Map();
            searched = true;
        } catch (err) {
            errorMessage = err.message;
        }
        searching = false;
        paint();
    }

    /**
     * Every PERSON selected gets enriched — "select all, reveal" means all
     * of them, not the first ten with an error for the rest.
     *
     * The provider's own limit (10 ids per call — see lib/apollo.mjs) is a
     * per-REQUEST cap, not a per-ACTION one: this chunks the selection into
     * batches of 10 and calls sequentially, merging every batch's results
     * before repainting once. A selection of 1 is one batch of 1 and behaves
     * exactly as before.
     */
    async function enrichSelected(reveal) {
        const ids = [...selected];
        if (!ids.length) return toast('Tick people first.', 'error');
        const BATCH_SIZE = 10;
        const batches = [];
        for (let i = 0; i < ids.length; i += BATCH_SIZE) batches.push(ids.slice(i, i + BATCH_SIZE));

        const kind = reveal.email && reveal.phone ? 'email + phone' : reveal.phone ? 'phone' : 'email';
        const loadingToast = toast(`Revealing ${kind} for ${ids.length} — uses provider credits…`, 'loading');
        let failed = 0;
        for (const batch of batches) {
            try {
                const res = await api.post('/api/sourcing/people-enrich', {
                    ids: batch, reveal_email: reveal.email, reveal_phone: reveal.phone,
                });
                for (const [k, v] of Object.entries(res.enriched ?? {})) enriched.set(String(k), v);
            } catch (err) {
                failed += batch.length;
                toast(err.message, 'error');
            }
        }
        for (const p of results) {
            const patch = enriched.get(String(p.providerId));
            if (patch?.email) p.email = patch.email;
            if (patch?.phone) p.phone = patch.phone;
        }
        loadingToast?.remove?.();
        if (!failed) toast(`Revealed for ${ids.length}.`, 'success');
        else if (failed < ids.length) toast(`Revealed for ${ids.length - failed} of ${ids.length} — ${failed} failed.`, 'error');
        paint();

        // Phone reveal is async — poll for delivery over the next few minutes.
        if (reveal.phone && !failed) {
            pollPhoneDelivery(ids, results);
        }
    }

    /**
     * After a phone reveal request, Apollo delivers numbers asynchronously
     * via webhook. Poll the status endpoint every 10s for up to 3 minutes
     * to pick up delivered numbers and patch them into the results table.
     */
    async function pollPhoneDelivery(ids, searchResults) {
        const providerIds = ids.filter((id) => {
            const p = searchResults.find((r) => String(r.providerId) === id);
            return p && !p.phone;
        });
        if (!providerIds.length) return;
        const emails = searchResults
            .filter((p) => ids.includes(String(p.providerId)) && p.email && !p.phone)
            .map((p) => p.email);
        if (!providerIds.length && !emails.length) return;

        const MAX_POLLS = 18; // 3 minutes at 10s intervals
        for (let i = 0; i < MAX_POLLS; i++) {
            await new Promise((r) => setTimeout(r, 10_000));
            try {
                const params = new URLSearchParams();
                if (providerIds.length) params.set('ids', providerIds.join(','));
                if (emails.length) params.set('emails', emails.join(','));
                const res = await api.get(`/api/integrations/apollo/phone-status?${params}`);
                const ready = res.ready ?? {};
                let found = 0;
                for (const p of searchResults) {
                    const phone = ready[String(p.providerId)] ?? ready[p.email?.toLowerCase()];
                    if (phone && !p.phone) {
                        p.phone = phone;
                        found += 1;
                    }
                }
                if (found) {
                    toast(`Phone delivered for ${found} of ${ids.length}.`, 'success');
                    paint();
                }
                // Stop polling once all requested ids have a phone or we've
                // exhausted the window.
                const allHavePhone = searchResults
                    .filter((p) => ids.includes(String(p.providerId)))
                    .every((p) => p.phone);
                if (allHavePhone) return;
            } catch { /* transient — keep polling */ }
        }

        // Window exhausted with some still undelivered — say so. Apollo's
        // webhook may never have reached this deployment (a wrong callback
        // URL, or the app not being publicly reachable at it), and a poll
        // that just stops reads as nothing having happened.
        const stillWaiting = searchResults
            .filter((p) => ids.includes(String(p.providerId)) && !p.phone).length;
        if (stillWaiting) {
            toast(
                `Still waiting on ${stillWaiting} phone number${stillWaiting === 1 ? '' : 's'} after 3 minutes — `
                + 'Apollo may not be able to reach this app to deliver them. Check the Apollo API key in Settings, or try again shortly.',
                'error',
            );
        }
    }

    async function importSelected() {
        const picked = results.filter((p) => selected.has(String(p.providerId)));
        if (!picked.length) return toast('Tick people to add to Sourcing.', 'error');
        try {
            const res = await api.post('/api/sourcing/people-import', { people: picked });
            toast(
                `${number(res.created)} added to Sourcing`
                + `${res.companiesCreated ? `, ${number(res.companiesCreated)} new compan${res.companiesCreated === 1 ? 'y' : 'ies'}` : ''}`
                + `${res.skipped ? `, ${number(res.skipped)} already there` : ''}`
                + `${res.failed ? `, ${number(res.failed)} failed` : ''}.`,
                'success',
            );
            selected = new Set();
            paint();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    function filterForm() {
        const field = (label, el) => h('div.field', h('label', label), el);
        return h('div.card', h('div.card-body',
            h('div.grid', { style: { gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-3)' } },
                field('Titles (comma-separated)', h('input.input', {
                    placeholder: 'e.g. HR Director, Talent Acquisition Manager',
                    value: filters.titles,
                    oninput: (e) => { filters.titles = e.target.value; },
                })),
                field('Seniority', h('select.input', {
                    onchange: (e) => { filters.seniority = e.target.value; },
                }, [
                    h('option', { value: '' }, 'Any seniority'),
                    ...SENIORITIES.map((s) => h('option', { value: s, selected: s === filters.seniority }, s)),
                ])),
                field('Person location (comma-separated)', h('input.input', {
                    placeholder: 'e.g. Saudi Arabia, Egypt',
                    value: filters.personLocations,
                    oninput: (e) => { filters.personLocations = e.target.value; },
                })),
                field('Company domain (comma-separated)', h('input.input', {
                    placeholder: 'e.g. acme.com',
                    value: filters.companyDomains,
                    oninput: (e) => { filters.companyDomains = e.target.value; },
                })),
                field('Company location (comma-separated)', h('input.input', {
                    placeholder: 'e.g. United Arab Emirates',
                    value: filters.orgLocations,
                    oninput: (e) => { filters.orgLocations = e.target.value; },
                })),
                field('Employees', h('select.input', {
                    onchange: (e) => { filters.employeeRange = e.target.value; },
                }, [
                    h('option', { value: '' }, 'Any size'),
                    ...EMPLOYEE_RANGES.map((r) => h('option', { value: r.value, selected: r.value === filters.employeeRange }, r.label)),
                ])),
                field('Keywords', h('input.input', {
                    placeholder: 'Free text — company, role, anything else',
                    value: filters.keywords,
                    oninput: (e) => { filters.keywords = e.target.value; },
                })),
            ),
            h('div.row', { style: { marginBlockStart: 'var(--space-3)' } },
                h('button.btn.primary', { onclick: () => search(1), disabled: searching }, searching ? 'Searching…' : 'Search'),
                h('span.xs.dim', { style: { marginInlineStart: 'var(--space-3)' } },
                    'Names, titles, company and LinkedIn come back first — 0 credits. Revealing an email is a separate, billable step. '
                    + 'Phone reveal is also billable — Apollo delivers the number a few minutes later via webhook.'),
            ),
        ));
    }

    function resultsTable() {
        if (errorMessage) {
            return h('div.note-box.danger', errorMessage);
        }
        if (searching) return skeletonRows(6);
        if (!searched) {
            return emptyState('Search Apollo', 'Set a filter above and search — results are not fetched until you ask.');
        }
        if (!results.length) {
            return emptyState('No matches', 'Nothing matched those filters. Widen the title, drop the location, or clear a filter.');
        }

        const isAllSelected = results.length > 0 && results.every((p) => selected.has(String(p.providerId)));

        return h('div',
            h('div.bulk-bar', selected.size > 0 && h('strong', `${number(selected.size)} selected`)),
            h('div.table-wrap', h('table.data',
                h('thead', h('tr',
                    h('th.check', h('input', {
                        type: 'checkbox', 'aria-label': 'Select all on this page', checked: isAllSelected,
                        onchange: (e) => {
                            for (const p of results) {
                                const id = String(p.providerId);
                                if (e.target.checked) selected.add(id); else selected.delete(id);
                            }
                            paint();
                        },
                    })),
                    h('th', 'Name'), h('th', 'Title'), h('th', 'Company'), h('th', 'Location'),
                    h('th', 'LinkedIn'), h('th', 'Email'), h('th', 'Phone'),
                )),
                h('tbody', results.map((p) => {
                    const id = String(p.providerId);
                    const patch = enriched.get(id);
                    const email = patch?.email ?? p.email;
                    const phone = patch?.phone ?? p.phone;
                    return h('tr', { class: selected.has(id) ? 'selected' : '' },
                        h('td.check', h('input', {
                            type: 'checkbox', checked: selected.has(id),
                            onchange: (e) => {
                                if (e.target.checked) selected.add(id); else selected.delete(id);
                                paint();
                            },
                        })),
                        h('td', labelOf(p)),
                        h('td.small', p.title || '—'),
                        h('td.small', p.organizationName || '—'),
                        h('td.small', [p.city, p.country].filter(Boolean).join(', ') || '—'),
                        h('td', p.linkedinUrl
                            ? h('a', { href: p.linkedinUrl, target: '_blank', rel: 'noreferrer noopener' }, 'LinkedIn ↗')
                            : h('span.dim', '—')),
                        h('td.small', email ? email : h('span.dim', '— not revealed')),
                        h('td.small', phone ? phone : h('span.dim', '— not revealed')),
                    );
                })),
            )),
            h('div.pagination',
                h('span', `${number(results.length)} of ${number(total)} matching · page ${page}`),
                h('div.spacer'),
                h('button.btn.sm', { disabled: page <= 1 || searching, onclick: () => search(page - 1) }, 'Previous'),
                h('button.btn.sm', { disabled: results.length < 25 || searching, onclick: () => search(page + 1) }, 'Next'),
            ),
        );
    }

    function paint() {
        mount(container,
            h('div.record-header',
                h('div.record-title', h('h1', 'People search')),
                h('div.record-sub', h('span', 'Search Apollo directly — results land in Sourcing, never straight into the customer book.')),
            ),
            filterForm(),
            selected.size > 0 && h('div.row', { style: { marginBlockStart: 'var(--space-3)', marginBlockEnd: 'var(--space-3)' } },
                h('button.btn', { onclick: () => enrichSelected({ email: true, phone: false }) }, 'Reveal emails'),
                h('button.btn', { onclick: () => enrichSelected({ email: false, phone: true }) }, 'Reveal phones'),
                h('div.spacer'),
                h('button.btn.primary', { onclick: () => importSelected() }, icon('arrowRight'), 'Add to Sourcing'),
            ),
            h('div', { style: { marginBlockStart: 'var(--space-3)' } }, resultsTable()),
        );
    }

    paint();
}
