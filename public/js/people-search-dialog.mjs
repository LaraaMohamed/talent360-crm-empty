/**
 * Find people at this company — Apollo via provider-neutral API.
 *
 * Search returns titles, company, LinkedIn (0 credits). Email/phone are
 * behind an explicit Reveal step (billable). Found people import as contacts
 * or prospecting contacts with email/LinkedIn dedup.
 */
import { h, toast, modal, drawer } from './core.js';
import { api } from './api.js';
import * as store from './store.js';

function labelOf(p) { return [p.first_name ?? p.firstName, p.last_name ?? p.lastName].filter(Boolean).join(' ') || p.name || p.fullName || '—'; }

export async function findPeopleDialog({ company, subjectType, subjectId, companyRoute }) {
    const subjectRoute = companyRoute ?? (subjectType === 'account' ? 'accounts' : 'prospecting_companies');
    /**
     * Two very different callers reach this dialog.
     *
     * A manager (or above) holds `record.write.all` and reveals instantly —
     * unchanged from before. A rep holds only `people_search.use`: they can
     * search and import (both free) but `people-enrich` refuses them, so
     * Reveal is replaced with a request a manager approves — see
     * requestEnrich/reviewEnrichRequest in api/people-search.mjs. That door
     * only exists for accounts (a rep never reaches a prospecting company).
     */
    const canReveal = store.can('record.write.all');
    const canRequestReveal = !canReveal && subjectType === 'account' && store.can('people_search.use');
    // Filters: keep it simple — titles + seniority + location, domain is implicit.
    const filters = { person_titles: [], person_seniorities: [], person_locations: [], q_keywords: '' };
    let results = [];
    let selected = new Set();
    let enriched = new Map(); // id -> enriched patch

    const titleInput = h('input.input', { placeholder: 'e.g. Chief Financial Officer, Finance Director' });
    const senioritySelect = h('select.input', {}, [h('option', { value: '' }, 'Any seniority'), ...['c_suite','vp','director','manager','senior','entry'].map(v => h('option', { value: v }, v))]);
    const locationInput = h('input.input', { placeholder: 'e.g. Saudi Arabia, Egypt' });
    const keywordInput = h('input.input', { placeholder: 'Optional keywords (free text)' });

    const resultsHost = h('div');

    const renderResults = () => {
        if (!results.length) { resultsHost.replaceChildren(h('p.xs.dim', 'No results yet — hit Search.')); return; }
        resultsHost.replaceChildren(
            h('div.table-wrap', h('table.data',
                h('thead', h('tr', h('th', ''), h('th', 'Name'), h('th', 'Title'), h('th', 'Company'), h('th', 'LinkedIn'), h('th', 'Email'), h('th', 'Phone'))),
                h('tbody', results.map(p => {
                    const id = String(p.providerId ?? p.id);
                    const patch = enriched.get(id);
                    const email = patch?.email ?? p.email ?? null;
                    const phone = patch?.phone ?? p.phone ?? null;
                    const linked = p.linkedinUrl ?? p.linkedin_url ?? null;
                    return h('tr',
                        h('td', h('input', { type: 'checkbox', checked: selected.has(id), onchange: (e) => { if (e.target.checked) selected.add(id); else selected.delete(id); } })),
                        h('td', labelOf(p)),
                        h('td.small', p.title ?? '—'),
                        h('td.small', p.organizationName ?? p.company_name ?? '—'),
                        h('td', linked ? h('a', { href: linked, target: '_blank', rel: 'noreferrer noopener' }, 'LinkedIn ↗') : h('span.dim', '—')),
                        h('td.small', email ? h('span', email) : h('span.dim', '— not revealed')),
                        h('td.small', phone ? h('span', phone) : h('span.dim', '— not revealed')),
                    );
                })),
            )),
            h('p.xs.dim', `${results.length} shown${results[0]?.total ? ` of ${results[0]?.total ?? ''} total` : ''}. Tick who to import.`),
        );
    };
    renderResults();

    const searchNow = async (page = 1) => {
        const btn = resultsHost.querySelector?.('button');
        resultsHost.replaceChildren(h('p.xs.dim', 'Searching…'));
        try {
            const body = {
                person_titles: titleInput.value.split(',').map(s => s.trim()).filter(Boolean),
                person_seniorities: senioritySelect.value ? [senioritySelect.value] : [],
                person_locations: locationInput.value.split(',').map(s => s.trim()).filter(Boolean),
                q_keywords: keywordInput.value.trim() || undefined,
                page, per_page: 25,
            };
            const res = await api.post(`/api/${subjectRoute}/${subjectId}/people-search`, body);
            results = res.people ?? [];
            // keep total on first row for display if needed
            if (res.total) results.forEach(r => { r.total = res.total; });
            selected = new Set();
            enriched = new Map();
            renderResults();
        } catch (err) { resultsHost.replaceChildren(h('div.note-box.danger', err.message)); }
    };

    // Every PERSON selected gets enriched, chunked into batches of 10 — the
    // provider's cap (lib/apollo.mjs) is per REQUEST, not per action. See
    // the same fix in public/js/pages/people-search.js.
    const enrichSelected = async (reveal) => {
        const ids = [...selected];
        if (!ids.length) { toast('Tick people first.', 'warning'); return; }
        const BATCH_SIZE = 10;
        const batches = [];
        for (let i = 0; i < ids.length; i += BATCH_SIZE) batches.push(ids.slice(i, i + BATCH_SIZE));

        const loadingToast = toast(`Revealing ${reveal.email ? 'email' : ''}${reveal.email && reveal.phone ? ' + ' : ''}${reveal.phone ? 'phone' : ''} for ${ids.length} — uses Apollo credits…`, 'loading');
        let failed = 0;
        for (const batch of batches) {
            try {
                const res = await api.post(`/api/${subjectRoute}/${subjectId}/people-enrich`, { ids: batch, reveal_email: reveal.email, reveal_phone: reveal.phone });
                for (const [k, v] of Object.entries(res.enriched ?? {})) enriched.set(String(k), v);
            } catch (err) {
                failed += batch.length;
                toast(err.message, 'error');
            }
        }
        // merge into results so table shows emails immediately
        for (const p of results) {
            const patch = enriched.get(String(p.providerId ?? p.id));
            if (patch?.email) p.email = patch.email;
            if (patch?.phone) p.phone = patch.phone;
        }
        renderResults();
        loadingToast?.remove?.();
        if (!failed) toast(`Revealed for ${ids.length}.`, 'success');
        else if (failed < ids.length) toast(`Revealed for ${ids.length - failed} of ${ids.length} — ${failed} failed.`, 'error');

        // Phone reveal is async — poll for delivery.
        if (reveal.phone && !failed) pollPhoneDelivery(ids);
    };

    async function pollPhoneDelivery(ids) {
        const needIds = ids.filter((id) => {
            const p = results.find((r) => String(r.providerId ?? r.id) === id);
            return p && !p.phone;
        });
        const needEmails = results
            .filter((p) => ids.includes(String(p.providerId ?? p.id)) && p.email && !p.phone)
            .map((p) => p.email);
        if (!needIds.length && !needEmails.length) return;

        const MAX_POLLS = 18;
        for (let i = 0; i < MAX_POLLS; i++) {
            await new Promise((r) => setTimeout(r, 10_000));
            try {
                const params = new URLSearchParams();
                if (needIds.length) params.set('ids', needIds.join(','));
                if (needEmails.length) params.set('emails', needEmails.join(','));
                const res = await api.get(`/api/integrations/apollo/phone-status?${params}`);
                const ready = res.ready ?? {};
                let found = 0;
                for (const p of results) {
                    const key = String(p.providerId ?? p.id);
                    const phone = ready[key] ?? ready[p.email?.toLowerCase()];
                    if (phone && !p.phone) { p.phone = phone; found += 1; }
                }
                if (found) { toast(`Phone delivered for ${found}.`, 'success'); renderResults(); }
                const allDone = results.filter((p) => ids.includes(String(p.providerId ?? p.id))).every((p) => p.phone);
                if (allDone) return;
            } catch { /* transient — keep polling */ }
        }
    }

    /**
     * A rep cannot reveal — only ask. Offered right after import, against
     * the CONTACTS just created (`res.createdContacts`, from
     * api/people-search.mjs's importPeople), because a reveal request patches
     * an existing contact rather than creating one — see requestEnrich.
     */
    async function offerRevealRequest(createdContacts) {
        const emailBox = h('input', { type: 'checkbox', checked: true });
        const phoneBox = h('input', { type: 'checkbox' });
        await modal({
            title: 'Ask a manager to reveal contact info?',
            body: h('div.stack',
                h('p.xs', `Revealing an email or phone spends Apollo credits, so it needs approval. Request it now for the `
                    + `${createdContacts.length} ${createdContacts.length === 1 ? 'person' : 'people'} just imported?`),
                h('label.row', { style: { gap: 'var(--space-2)' } }, emailBox, h('span', 'Email')),
                h('label.row', { style: { gap: 'var(--space-2)' } }, phoneBox, h('span', 'Phone')),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(false) }, 'Not now'),
                h('button.btn.primary', {
                    onclick: async (event) => {
                        if (!emailBox.checked && !phoneBox.checked) { toast('Pick email, phone, or both.', 'warning'); return; }
                        const button = event.currentTarget;
                        button.disabled = true;
                        try {
                            await api.post(`/api/accounts/${subjectId}/people-enrich-request`, {
                                people: createdContacts.map((c) => ({ provider_id: c.providerId, contact_id: c.contactId, name: c.name })),
                                reveal_email: emailBox.checked, reveal_phone: phoneBox.checked,
                            });
                            toast('Sent for approval — you’ll be notified once a manager reviews it.', 'success');
                            close(true);
                        } catch (err) {
                            button.disabled = false;
                            toast(err.message, 'error');
                        }
                    },
                }, 'Request reveal'),
            ],
        });
    }

    const importSelected = async () => {
        const picked = results.filter(p => selected.has(String(p.providerId ?? p.id)));
        if (!picked.length) { toast('Tick people to import.', 'warning'); return; }
        try {
            const payload = picked.map(p => {
                const id = String(p.providerId ?? p.id);
                const patch = enriched.get(id);
                return {
                    provider_id: id,
                    first_name: p.firstName ?? p.first_name ?? '',
                    last_name: p.lastName ?? p.last_name ?? '',
                    title: p.title ?? '',
                    email: patch?.email ?? p.email ?? null,
                    phone: patch?.phone ?? p.phone ?? null,
                    linkedin_url: p.linkedinUrl ?? p.linkedin_url ?? null,
                };
            });
            const res = await api.post(`/api/${subjectRoute}/${subjectId}/people-import`, { people: payload });
            toast(
                `${res.created} created`
                + `${res.skipped ? `, ${res.skipped} already in workspace` : ''}`
                + `${res.failed ? `, ${res.failed} failed` : ''}.`,
                res.failed ? 'warning' : 'success',
            );
            if (res.failed && res.failures?.length) {
                toast(res.failures[0].reason, 'error');
            }
            if (canRequestReveal && res.createdContacts?.length) {
                await offerRevealRequest(res.createdContacts);
            }
            return true;
        } catch (err) { toast(err.message, 'error'); return false; }
    };

    await drawer({
        title: `Find people — ${company.name}`,
        body: h('div.stack',
            h('div.note-box', h('p.xs', canReveal
                ? `Find people at ${company.name}${company.domain ? ` (${company.domain})` : ''}. Titles, company and LinkedIn come back first (0 credits). Tick people and Reveal email — that step is billable. Phone reveal is also billable — Apollo delivers the number a few minutes later via webhook.`
                : `Find people at ${company.name}${company.domain ? ` (${company.domain})` : ''}. Titles, company and LinkedIn come back first, and importing them to the CRM is free. Revealing an email or phone spends Apollo credits, so after you import you'll be offered a request a manager approves.`)),
            h('div.grid', { style: { gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' } },
                h('div.field', h('label', 'Titles (comma-separated)'), titleInput),
                h('div.field', h('label', 'Seniority'), senioritySelect),
                h('div.field', h('label', 'Locations (comma-separated)'), locationInput),
                h('div.field', h('label', 'Keywords'), keywordInput),
            ),
            h('div.row',
                h('button.btn.primary', { onclick: () => searchNow(1) }, 'Search'),
                h('div.spacer'),
                canReveal && h('button.btn', { onclick: () => enrichSelected({ email: true, phone: false }) }, 'Reveal emails'),
                canReveal && h('button.btn', { onclick: () => enrichSelected({ email: false, phone: true }) }, 'Reveal phones'),
                canRequestReveal && h('span.xs.dim', "Import, then ask a manager to reveal email/phone."),
            ),
            resultsHost,
        ),
        footer: (close) => [
            h('button.btn', { onclick: () => close(false) }, 'Close'),
            h('button.btn.primary', { onclick: async () => { const ok = await importSelected(); if (ok) close(true); } }, 'Import selected'),
        ],
    });
}
