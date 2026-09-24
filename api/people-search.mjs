/**
 * People discovery — HTTP surface (provider-neutral).
 *
 * Two planes: CRM `account` and sourcing `prospecting_company`. Both carry
 * a domain; either can ask "who works there?" The answer lands as
 * `prospecting_contacts` under the prospect plane when one exists, or as CRM
 * `contacts` under the account when it is already a customer. The UI decides
 * which button it shows; the server does both and the audit records what moved.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { get, run, all, id, now } from '../lib/db.mjs';
import { readJson, badRequest, notFound, forbidden } from '../lib/http.mjs';
import { require$, can } from '../lib/auth.mjs';
import { setting, setSetting } from '../lib/settings.mjs';
import { createRecord, updateRecord } from '../lib/repo.mjs';
import { openApprovalTask, closeApprovalTask } from '../lib/approvals.mjs';
import { notifyApprovalDecision } from '../lib/notify.mjs';
import * as people from '../lib/people-search.mjs';

/**
 * The webhook URL Apollo delivers a phone number to, once it is ready
 * (never synchronously — see lib/apollo.mjs's own header). Minted lazily,
 * on the first phone reveal a workspace ever asks for, the same way
 * Smartlead's own webhook secret is — there is no separate "connect"
 * step for Apollo to mint it during, and making phone reveal depend on
 * one would just be a second dead end before the first one is even fixed.
 */
function apolloWebhookUrl(req, ctx) {
    let secret = setting(ctx.workspaceId, 'apollo_webhook_secret');
    if (!secret) {
        secret = randomBytes(24).toString('base64url');
        setSetting(ctx.workspaceId, 'apollo_webhook_secret', secret);
    }
    // Prefer PUBLIC_BASE_URL — the same source of truth Smartlead's own webhook
    // registration insists on (api/outreach.mjs) — an explicit, known-reachable
    // address rather than trusting whatever headers a proxy happened to forward.
    // Falls back to request headers for a local/dev run where PUBLIC_BASE_URL is
    // not set, but never silently defaults to the literal word "localhost": that
    // used to happen when a proxy stripped both Host headers, registering a
    // callback URL Apollo could never reach and leaving phone reveals to poll
    // forever with nothing to show.
    const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
    if (base) return `${base}/api/webhooks/apollo/${secret}`;

    const proto = req.headers['x-forwarded-proto'] ?? 'https';
    const host = req.headers['x-forwarded-host'] ?? req.headers.host;
    if (!host) throw badRequest('Set PUBLIC_BASE_URL so Apollo can reach this server.');
    return `${proto}://${host}/api/webhooks/apollo/${secret}`;
}

function resolveCompany(ctx, subjectType, subjectId) {
    const table = subjectType === 'account' ? 'accounts' : 'prospecting_companies';
    const row = get(`SELECT id, name, domain, website FROM ${table} WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`, [subjectId, ctx.workspaceId]);
    if (!row) throw notFound(subjectType === 'account' ? 'That account does not exist.' : 'That company does not exist.');
    return row;
}

function domainOf(row) {
    const raw = (row.domain ?? row.website ?? '').trim();
    if (!raw) return null;
    try {
        // Stored as bare domain or URL; normalize to host only.
        const u = raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`);
        return u.hostname.replace(/^www\./, '').toLowerCase();
    } catch { return raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase(); }
}

/**
 * A phone Apollo delivered after the fact, for one person being imported
 * right now — matched by Apollo's own person id first, then by email.
 * Consumed the moment it is used (`consumed_at` set): a delivery is for
 * ONE import, not a pool a later, unrelated person could accidentally draw
 * from.
 */
function consumeRevealedPhone(ctx, { providerId, email }) {
    let row = providerId
        ? get(`SELECT id, phone FROM phone_reveals WHERE workspace_id = ? AND provider = 'apollo' AND provider_person_id = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`, [ctx.workspaceId, String(providerId)])
        : null;
    if (!row && email) {
        row = get(`SELECT id, phone FROM phone_reveals WHERE workspace_id = ? AND provider = 'apollo' AND lower(email) = lower(?) AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`, [ctx.workspaceId, email]);
    }
    if (!row) return null;
    run('UPDATE phone_reveals SET consumed_at = ? WHERE id = ?', [now(), row.id]);
    return row.phone;
}

function subjectTypeFromUrl(url) {
    // Called with `/api/accounts/:id/...` or `/api/prospecting_companies/:id/...`
    return String(url.pathname).includes('/prospecting_companies/') ? 'prospecting_company' : 'account';
}
export async function search({ req, params, ctx, url }) {
    const subjectType = params.subjectType === 'accounts' ? 'account' : params.subjectType === 'prospecting_companies' ? 'prospecting_company' : subjectTypeFromUrl(url);
    // Free (0-credit): a rep may search people at an ACCOUNT they can already
    // see. The prospecting plane stays manager+ — same reasoning as
    // `prospecting.read` itself, see lib/auth.mjs.
    require$(ctx, subjectType === 'account' ? 'people_search.use' : 'record.write.all');
    const company = resolveCompany(ctx, subjectType, params.id);
    const body = await readJson(req).catch(() => ({}));
    const domain = body.domain ?? domainOf(company);
    const filters = {
        person_titles: body.person_titles ?? body.titles ?? [],
        person_seniorities: body.person_seniorities ?? body.seniorities ?? [],
        person_locations: body.person_locations ?? body.locations ?? [],
        q_keywords: body.q_keywords ?? body.keywords ?? undefined,
        // UI may pass a tighter page; default 1/25 handled in lib.
    };
    const page = Number(body.page) || 1;
    const perPage = Math.min(50, Math.max(1, Number(body.per_page ?? body.perPage) || 25));
    const result = await people.searchAtCompany({ workspaceId: ctx.workspaceId, domain, companyName: company.name, filters, page, perPage });
    return { company: { id: company.id, name: company.name, domain }, provider: result.raw ? result.providerId ?? people.activeProvider(ctx.workspaceId).key : undefined, people: result.people, total: result.total, page: result.page, perPage: result.perPage };
}

export async function enrich({ req, params, ctx, url }) {
    require$(ctx, 'record.write.all');
    const subjectType = params.subjectType === 'accounts' ? 'account' : params.subjectType === 'prospecting_companies' ? 'prospecting_company' : subjectTypeFromUrl(url);
    resolveCompany(ctx, subjectType, params.id); // 404 if unknown
    const body = await readJson(req);
    const ids = (body.ids ?? body.person_ids ?? []).map(String).filter(Boolean);
    const revealEmail = body.reveal_email ?? body.email ?? true;
    const revealPhone = body.reveal_phone ?? body.phone ?? false;
    if (!ids.length) throw badRequest('Pick people to reveal contact info for.');
    const webhookUrl = revealPhone ? apolloWebhookUrl(req, ctx) : null;
    const result = await people.enrichPeople({ workspaceId: ctx.workspaceId, ids, reveal: { email: Boolean(revealEmail), phone: Boolean(revealPhone) }, webhookUrl });
    // Return enriched patches keyed by id so the UI can merge without refetching search.
    const patched = {};
    for (const [k, v] of result.byId.entries()) patched[k] = v;
    return { enriched: patched, provider: result.provider };
}

export async function importPeople({ req, params, ctx, url }) {
    const subjectType = params.subjectType === 'accounts' ? 'account' : params.subjectType === 'prospecting_companies' ? 'prospecting_company' : subjectTypeFromUrl(url);
    // Free (0-credit): saving what search already returned. See `search()`.
    require$(ctx, subjectType === 'account' ? 'people_search.use' : 'record.write.all');
    const company = resolveCompany(ctx, subjectType, params.id);
    const body = await readJson(req);
    const peopleList = body.people ?? [];
    if (!peopleList.length) throw badRequest('Nothing to import — pick people first.');

    // Import target: when asked from a prospecting company, land as
    // prospecting_contacts under it (sourcing plane); from a CRM account,
    // land as contacts under that account. The UI passes `target` explicitly;
    // default follows the caller plane.
    const asProspect = subjectType === 'prospecting_company';
    const prospectId = asProspect ? company.id : null;
    const accountId = !asProspect ? company.id : (get(`SELECT id FROM accounts WHERE workspace_id = ? AND (domain = ? OR website = ?) AND deleted_at IS NULL LIMIT 1`, [ctx.workspaceId, company.domain, company.website])?.id ?? null);

    let created = 0, skipped = 0, failed = 0;
    const skippedExisting = [];
    const failures = [];
    // Which Apollo person became which CRM record — nothing else on a
    // `contact` row keeps this pairing (contacts have no `external_id`
    // column), so it travels back to the caller instead. A rep who lacks
    // `record.write.all` uses it to name the exact records a later reveal
    // request should patch — see requestEnrich below.
    const createdContacts = [];
    for (const p of peopleList) {
        const email = (p.email ?? '').trim().toLowerCase();
        // Already have this person? Check prospecting_contacts + contacts by email|linkedin_url.
        let exists = null;
        if (email) {
            exists = get(`SELECT id FROM prospecting_contacts WHERE workspace_id = ? AND lower(email) = lower(?) AND deleted_at IS NULL LIMIT 1`, [ctx.workspaceId, email])
                ?? get(`SELECT id FROM contacts WHERE workspace_id = ? AND lower(email) = lower(?) AND deleted_at IS NULL LIMIT 1`, [ctx.workspaceId, email]);
        }
        if (!exists && p.linkedin_url) {
            exists = get(`SELECT id FROM prospecting_contacts WHERE workspace_id = ? AND linkedin_url = ? AND deleted_at IS NULL LIMIT 1`, [ctx.workspaceId, p.linkedin_url])
                ?? get(`SELECT id FROM contacts WHERE workspace_id = ? AND linkedin_url = ? AND deleted_at IS NULL LIMIT 1`, [ctx.workspaceId, p.linkedin_url]);
        }
        if (exists) { skipped += 1; skippedExisting.push({ name: [p.first_name, p.last_name].filter(Boolean).join(' '), email, reason: 'Already in the workspace.' }); continue; }

        /**
         * Through createRecord, not raw INSERT — validation, the audit event
         * naming who imported whom, and the search index are the same ones the
         * UI and API use. An importer with its own write path is an importer
         * that eventually writes something the rest of the system considers
         * impossible (lib/import.mjs, rule 4).
         */
        const payload = {
            first_name: p.first_name ?? p.firstName ?? '',
            last_name: p.lastName ?? p.last_name ?? '',
            title: p.title ?? '',
            email: email || null,
            // What was on screen when this was ticked wins; a phone Apollo
            // delivered LATER (after the reveal request returned, before
            // this import) is picked up here rather than lost — the two are
            // rarely both present, but the one on screen is the one the
            // person actually chose to import.
            phone: p.phone ?? consumeRevealedPhone(ctx, { providerId: p.providerId ?? p.provider_id, email }) ?? null,
            linkedin_url: p.linkedin_url ?? p.linkedinUrl ?? null,
            // Both contact and prospecting_contact require this — omitting it
            // made every createRecord call below throw "Data source is
            // required.", landing every import in `failed` while the UI toast
            // only ever reported `created`, so this read as "0 created" with
            // no visible error at all.
            data_source: 'Apollo',
        };
        try {
            let recordRow;
            if (asProspect) {
                recordRow = createRecord('prospecting_contact', ctx, { ...payload, prospect_id: prospectId }, { source: 'automation' });
            } else {
                recordRow = createRecord('contact', ctx, { ...payload, account_id: accountId }, { source: 'automation' });
            }
            created += 1;
            const providerId = String(p.provider_id ?? p.providerId ?? '').trim();
            if (providerId) {
                createdContacts.push({ providerId, contactId: recordRow.id, name: [p.first_name, p.last_name].filter(Boolean).join(' ') });
            }
        } catch (err) {
            failed += 1;
            failures.push({ name: [p.first_name, p.last_name].filter(Boolean).join(' '), reason: String(err.message).slice(0, 200) });
        }
    }

    const at = now();
    run(`INSERT INTO audit_events (id, workspace_id, object_key, record_id, action, actor_id, source, after, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        [id('aud'), ctx.workspaceId, asProspect ? 'prospecting_company' : 'account', company.id, 'people_imported', ctx.userId, 'automation', JSON.stringify({ provider: setting(ctx.workspaceId, 'people_search_provider') ?? 'apollo', created, skipped, failed, at }), at]);

    return { created, skipped, failed, failures, skippedExisting, target: asProspect ? 'prospecting_contacts' : 'contacts', createdContacts };
}

/* ----------------------------------------------- reveal, subject to approval -- */

/**
 * A rep cannot call `enrich()` — it requires `record.write.all`, which they
 * don't hold, on purpose (revealing an email or phone spends Apollo credits).
 * This is the door they use instead: name which already-imported contacts,
 * and which of email/phone, and a manager decides whether it happens.
 *
 * Deliberately account-only (see `search`/`importPeople` above) — the
 * prospecting plane has no request-to-approve door, only the direct
 * `record.write.all`-gated one, matching how a rep never reaches it at all.
 */
function hydrateEnrichRequest(row) {
    if (!row) return null;
    let peopleList = [], result = null;
    try { peopleList = JSON.parse(row.people ?? '[]'); } catch { /* keep [] */ }
    try { result = row.result ? JSON.parse(row.result) : null; } catch { result = null; }
    return {
        id: row.id, subjectType: row.subject_type, subjectId: row.subject_id,
        requestedBy: row.requested_by, people: peopleList,
        revealEmail: Boolean(row.reveal_email), revealPhone: Boolean(row.reveal_phone),
        status: row.status, result,
        reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at, reviewNote: row.review_note,
        createdAt: row.created_at, updatedAt: row.updated_at,
    };
}

export async function requestEnrich({ req, params, ctx }) {
    require$(ctx, 'people_search.use');
    const account = resolveCompany(ctx, 'account', params.id);
    const body = await readJson(req);

    const peopleList = (Array.isArray(body.people) ? body.people : [])
        .map((p) => ({
            providerId: String(p.providerId ?? p.provider_id ?? '').trim(),
            contactId: String(p.contactId ?? p.contact_id ?? '').trim(),
            name: String(p.name ?? '').trim() || null,
        }))
        .filter((p) => p.providerId && p.contactId);
    if (!peopleList.length) {
        throw badRequest('Pick people to request a reveal for — import them to the CRM first, then ask for their email or phone.');
    }
    if (peopleList.length > 10) throw badRequest('Pick up to 10 at a time (provider limit).');

    const revealEmail = Boolean(body.reveal_email ?? body.email ?? true);
    const revealPhone = Boolean(body.reveal_phone ?? body.phone ?? false);
    if (!revealEmail && !revealPhone) throw badRequest('Ask for email, phone, or both.');

    const stamp = now();
    const requestId = id('per');
    run(
        `INSERT INTO people_enrich_requests
           (id, workspace_id, subject_type, subject_id, requested_by, people, reveal_email, reveal_phone, status, created_at, updated_at)
         VALUES (?,?,'account',?,?,?,?,?,'pending_approval',?,?)`,
        [requestId, ctx.workspaceId, account.id, ctx.userId, JSON.stringify(peopleList), revealEmail ? 1 : 0, revealPhone ? 1 : 0, stamp, stamp],
    );

    const fieldsLabel = revealEmail && revealPhone ? 'email and phone' : revealPhone ? 'phone' : 'email';
    openApprovalTask(ctx, 'people_enrich', {
        id: requestId, account_id: account.id,
        people_count: peopleList.length, fields_label: fieldsLabel,
    });

    run(`INSERT INTO audit_events (id, workspace_id, object_key, record_id, action, actor_id, source, after, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        [id('aud'), ctx.workspaceId, 'account', account.id, 'people_enrich_requested', ctx.userId, 'ui',
            JSON.stringify({ requestId, count: peopleList.length, revealEmail, revealPhone }), stamp]);

    return { request: hydrateEnrichRequest(get('SELECT * FROM people_enrich_requests WHERE id = ?', [requestId])) };
}

/** Pending requests: a manager sees the workspace's queue, a rep sees only their own. */
export async function listEnrichRequests({ ctx, url }) {
    if (!can(ctx, 'record.write.all') && !can(ctx, 'people_search.use')) {
        throw forbidden('You do not have permission to do that');
    }
    const status = url.searchParams.get('status');
    const clauses = ['workspace_id = ?'];
    const args = [ctx.workspaceId];
    if (!can(ctx, 'record.write.all')) { clauses.push('requested_by = ?'); args.push(ctx.userId); }
    if (status) { clauses.push('status = ?'); args.push(status); }
    const rows = all(
        `SELECT * FROM people_enrich_requests WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT 200`,
        args,
    );
    return { requests: rows.map(hydrateEnrichRequest) };
}

/** Polled by the requester while it is pending, and after — to read the reveal. */
export async function getEnrichRequest({ ctx, params }) {
    const row = get('SELECT * FROM people_enrich_requests WHERE id = ? AND workspace_id = ?', [params.id, ctx.workspaceId]);
    if (!row) throw notFound('That request does not exist.');
    if (row.requested_by !== ctx.userId && !can(ctx, 'record.write.all')) {
        throw forbidden('That is not your reveal request.');
    }
    return { request: hydrateEnrichRequest(row) };
}

/**
 * A manager decides. Approving is the moment Apollo credits are actually
 * spent — never at request time — so a rejected or ignored request never
 * costs anything.
 *
 * Email typically comes back in this same response and is patched onto the
 * waiting contact immediately. Phone never does (see lib/apollo.mjs on why
 * it is always a later webhook delivery) — `phoneWebhook` below finishes the
 * job for an approved request the moment Apollo's callback lands.
 */
export async function reviewEnrichRequest({ req, params, ctx }) {
    require$(ctx, 'record.write.all');
    const row = get('SELECT * FROM people_enrich_requests WHERE id = ? AND workspace_id = ?', [params.id, ctx.workspaceId]);
    if (!row) throw notFound('That request does not exist.');
    if (row.status !== 'pending_approval') {
        throw badRequest(`This request is "${row.status}", not awaiting review.`);
    }

    const body = await readJson(req).catch(() => ({}));
    const decision = String(body.decision ?? '').toLowerCase();
    if (decision !== 'approved' && decision !== 'rejected') {
        throw badRequest('A review decision is either "approved" or "rejected".');
    }
    const note = String(body.note ?? body.review_note ?? '').trim();
    if (decision === 'rejected' && !note) {
        throw badRequest('Say why it was rejected — the person who asked needs to know.');
    }

    const stamp = now();
    const link = `/accounts/${row.subject_id}`;
    const reviewerName = get('SELECT name FROM users WHERE id = ?', [ctx.userId])?.name ?? null;

    if (decision === 'rejected') {
        run(
            `UPDATE people_enrich_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ? WHERE id = ?`,
            [ctx.userId, stamp, note, stamp, row.id],
        );
        closeApprovalTask(ctx, 'people_enrich', row.id, 'rejected');
        notifyApprovalDecision(ctx, {
            authorId: row.requested_by, label: 'Contact reveal', decision: 'rejected',
            note, reviewedBy: reviewerName, link,
        });
        return { request: hydrateEnrichRequest(get('SELECT * FROM people_enrich_requests WHERE id = ?', [row.id])) };
    }

    const peopleList = JSON.parse(row.people ?? '[]');
    const ids = peopleList.map((p) => p.providerId).filter(Boolean);
    const revealEmail = Boolean(row.reveal_email);
    const revealPhone = Boolean(row.reveal_phone);
    const webhookUrl = revealPhone ? apolloWebhookUrl(req, ctx) : null;
    const enriched = await people.enrichPeople({ workspaceId: ctx.workspaceId, ids, reveal: { email: revealEmail, phone: revealPhone }, webhookUrl });

    const result = {};
    for (const person of peopleList) {
        const match = enriched.byId.get(person.providerId);
        result[person.providerId] = { email: match?.email ?? null, phone: match?.phone ?? null };
        const patch = {};
        if (revealEmail && match?.email) patch.email = match.email;
        if (revealPhone && match?.phone) patch.phone = match.phone;
        if (Object.keys(patch).length) {
            try { updateRecord('contact', ctx, person.contactId, patch); } catch { /* the contact may since have been deleted or merged — the approval still stands */ }
        }
    }

    run(
        `UPDATE people_enrich_requests SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = ?, result = ?, updated_at = ? WHERE id = ?`,
        [ctx.userId, stamp, note || null, JSON.stringify(result), stamp, row.id],
    );
    closeApprovalTask(ctx, 'people_enrich', row.id, 'approved');
    notifyApprovalDecision(ctx, {
        authorId: row.requested_by, label: 'Contact reveal', decision: 'approved',
        note: note || null, reviewedBy: reviewerName, link,
    });

    run(`INSERT INTO audit_events (id, workspace_id, object_key, record_id, action, actor_id, source, after, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        [id('aud'), ctx.workspaceId, 'account', row.subject_id, 'people_enrich_reviewed', ctx.userId, 'ui',
            JSON.stringify({ requestId: row.id, decision, revealEmail, revealPhone }), stamp]);

    return { request: hydrateEnrichRequest(get('SELECT * FROM people_enrich_requests WHERE id = ?', [row.id])) };
}

export async function status({ ctx }) {
    const provider = (() => { try { return people.activeProvider(ctx.workspaceId); } catch { return null; } })();
    return {
        provider: provider?.key ?? setting(ctx.workspaceId, 'people_search_provider') ?? 'apollo',
        label: provider?.label ?? 'Apollo',
        configured: people.isConfigured(ctx.workspaceId),
        // UI shows whether a key is set without revealing it (mirrors /api/meta CONTRACT).
        secretsConfigured: { apollo_api_key: Boolean(setting(ctx.workspaceId, 'apollo_api_key')) },
    };
}

/* ------------------------------------------------------- general search -- */

/**
 * People Search, not anchored to a company already in the CRM.
 *
 * `search()` above answers "who works at THIS account" — the account or
 * prospecting company is given, and only its domain narrows the query. This
 * is the other question: search Apollo's whole database by title, seniority,
 * location, company domain or headcount, the way Sourcing needs to when the
 * company is not in the CRM yet either. Same transport (`lib/apollo.mjs`),
 * same canonical shape — only the anchor is missing, which `searchAtCompany`
 * already tolerates (`domain: null` falls through to the filters as given).
 *
 * Exposes exactly the filters `lib/apollo.mjs` forwards to Apollo and no
 * others — a checkbox for a filter Apollo does not support would be a lie
 * the UI tells about what it can do.
 */
/**
 * Reveal, for a general search result — the same billable step `enrich()`
 * offers a company page, without a company to anchor it to. `enrichPeople`
 * itself was already general (ids + workspace, nothing else), so this is
 * the same wrapper minus the anchor lookup.
 */
export async function generalEnrich({ req, ctx }) {
    require$(ctx, 'record.write.all');
    const body = await readJson(req);
    const ids = (body.ids ?? []).map(String).filter(Boolean);
    if (!ids.length) throw badRequest('Pick people to reveal contact info for.');
    const revealEmail = body.reveal_email ?? true;
    const revealPhone = body.reveal_phone ?? false;
    const webhookUrl = revealPhone ? apolloWebhookUrl(req, ctx) : null;
    const result = await people.enrichPeople({ workspaceId: ctx.workspaceId, ids, reveal: { email: Boolean(revealEmail), phone: Boolean(revealPhone) }, webhookUrl });
    const patched = {};
    for (const [k, v] of result.byId.entries()) patched[k] = v;
    return { enriched: patched, provider: result.provider };
}

/**
 * Has Apollo delivered a phone number yet, for any of these people?
 *
 * Polled by the browser for a short while after a phone reveal is
 * requested — the delivery is asynchronous and usually takes a few
 * minutes (see lib/apollo.mjs), so there is nothing to return the moment
 * the request that ASKED for it returns. Matches by provider person id
 * first, falling back to email (a search result the caller already has
 * one for). A matched row is left unconsumed here — reading it is not the
 * same as using it, and `importPeople` is what actually consumes one onto
 * a saved record.
 */
export async function phoneRevealStatus({ url, ctx }) {
    const ids = (url.searchParams.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const emails = (url.searchParams.get('emails') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const ready = {};
    if (ids.length) {
        const holes = ids.map(() => '?').join(',');
        for (const row of all(
            `SELECT provider_person_id, phone FROM phone_reveals
              WHERE workspace_id = ? AND provider = 'apollo' AND provider_person_id IN (${holes})
              ORDER BY created_at DESC`,
            [ctx.workspaceId, ...ids],
        )) {
            ready[row.provider_person_id] ??= row.phone;
        }
    }
    if (emails.length) {
        const holes = emails.map(() => '?').join(',');
        for (const row of all(
            `SELECT email, phone FROM phone_reveals
              WHERE workspace_id = ? AND provider = 'apollo' AND lower(email) IN (${holes})
              ORDER BY created_at DESC`,
            [ctx.workspaceId, ...emails],
        )) {
            ready[row.email.toLowerCase()] ??= row.phone;
        }
    }
    return { ready };
}

export async function generalSearch({ req, ctx }) {
    require$(ctx, 'record.write.all');
    const body = await readJson(req).catch(() => ({}));
    const filters = {
        person_titles: body.person_titles ?? [],
        person_seniorities: body.person_seniorities ?? [],
        person_locations: body.person_locations ?? [],
        organization_locations: body.organization_locations ?? [],
        q_organization_domains: body.q_organization_domains ?? [],
        organization_num_employees_ranges: body.organization_num_employees_ranges ?? [],
        q_keywords: body.q_keywords || undefined,
    };
    const page = Number(body.page) || 1;
    const perPage = Math.min(50, Math.max(1, Number(body.per_page ?? body.perPage) || 25));
    const result = await people.searchAtCompany({
        workspaceId: ctx.workspaceId, domain: null, companyName: null, filters, page, perPage,
    });
    return {
        provider: people.activeProvider(ctx.workspaceId).key,
        people: result.people, total: result.total, page: result.page, perPage: result.perPage,
    };
}

/**
 * Apollo → Sourcing, for results that came from `generalSearch` rather than
 * from a company page.
 *
 * Each selected person is grouped by their ORGANIZATION — Apollo's search
 * hit carries one, unlike a company page's import where the company is
 * already the anchor — so a `prospecting_company` is found by domain (the
 * strongest signal) or created, and the contact lands under it. Same
 * email/LinkedIn dedup `importPeople` uses, so a person Apollo has already
 * surfaced once, from either search, is recognised the second time rather
 * than duplicated.
 */
export async function generalImport({ req, ctx }) {
    require$(ctx, 'record.write.all');
    const body = await readJson(req);
    const peopleList = body.people ?? [];
    if (!peopleList.length) throw badRequest('Nothing to import — pick people first.');

    let companiesCreated = 0, companiesMatched = 0, created = 0, skipped = 0, failed = 0;
    const skippedExisting = [];
    const failures = [];

    for (const p of peopleList) {
        const domain = (p.domain ?? '').trim().toLowerCase() || null;
        const orgName = (p.organizationName ?? '').trim() || null;
        if (!domain && !orgName) {
            failed += 1;
            failures.push({ name: [p.firstName, p.lastName].filter(Boolean).join(' '), reason: 'No company on this result to file them under.' });
            continue;
        }

        let prospect = domain
            ? get(`SELECT id FROM prospecting_companies WHERE workspace_id = ? AND lower(domain) = ? AND deleted_at IS NULL LIMIT 1`, [ctx.workspaceId, domain])
            : null;
        if (!prospect && orgName) {
            prospect = get(`SELECT id FROM prospecting_companies WHERE workspace_id = ? AND lower(name) = lower(?) AND deleted_at IS NULL LIMIT 1`, [ctx.workspaceId, orgName]);
        }
        if (prospect) {
            companiesMatched += 1;
        } else {
            prospect = createRecord('prospecting_company', ctx, {
                name: orgName ?? domain, domain: domain ?? null, source: 'Apollo',
            }, { source: 'automation' });
            companiesCreated += 1;
        }

        const email = (p.email ?? '').trim().toLowerCase();
        let exists = null;
        if (email) {
            exists = get(`SELECT id FROM prospecting_contacts WHERE workspace_id = ? AND lower(email) = lower(?) AND deleted_at IS NULL LIMIT 1`, [ctx.workspaceId, email])
                ?? get(`SELECT id FROM contacts WHERE workspace_id = ? AND lower(email) = lower(?) AND deleted_at IS NULL LIMIT 1`, [ctx.workspaceId, email]);
        }
        if (!exists && p.linkedinUrl) {
            exists = get(`SELECT id FROM prospecting_contacts WHERE workspace_id = ? AND linkedin_url = ? AND deleted_at IS NULL LIMIT 1`, [ctx.workspaceId, p.linkedinUrl])
                ?? get(`SELECT id FROM contacts WHERE workspace_id = ? AND linkedin_url = ? AND deleted_at IS NULL LIMIT 1`, [ctx.workspaceId, p.linkedinUrl]);
        }
        if (exists) {
            skipped += 1;
            skippedExisting.push({ name: [p.firstName, p.lastName].filter(Boolean).join(' '), email, reason: 'Already in the workspace.' });
            continue;
        }

        try {
            createRecord('prospecting_contact', ctx, {
                prospect_id: prospect.id,
                first_name: p.firstName ?? '', last_name: p.lastName ?? '', title: p.title ?? '',
                email: email || null,
                phone: p.phone ?? consumeRevealedPhone(ctx, { providerId: p.providerId, email }) ?? null,
                linkedin_url: p.linkedinUrl ?? null,
                data_source: 'Apollo', external_id: p.providerId ?? null,
            }, { source: 'automation' });
            created += 1;
        } catch (err) {
            failed += 1;
            failures.push({ name: [p.firstName, p.lastName].filter(Boolean).join(' '), reason: String(err.message).slice(0, 200) });
        }
    }

    const at = now();
    run(`INSERT INTO audit_events (id, workspace_id, object_key, record_id, action, actor_id, source, after, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        [id('aud'), ctx.workspaceId, 'prospecting_company', null, 'people_search_imported', ctx.userId, 'automation',
            JSON.stringify({ provider: 'apollo', created, skipped, failed, companiesCreated, companiesMatched, at }), at]);

    return { created, skipped, failed, failures, skippedExisting, companiesCreated, companiesMatched };
}

/* -------------------------------------------------------- phone webhook -- */

/**
 * Finishes an APPROVED reveal request the moment Apollo's phone finally
 * arrives — `reviewEnrichRequest` above could only patch email onto the
 * contact synchronously; phone is never in that response (see this file's
 * header comment on `phoneWebhook`). No session here — this runs off the
 * public webhook — so the contact is patched with a plain UPDATE the same
 * way `consumeRevealedPhone` reaches into `phone_reveals` above, not through
 * `updateRecord`. Matched by a LIKE over the request's own `people` JSON,
 * the same technique `lib/approvals.mjs` uses over `tasks.properties` — an
 * index on a JSON column buys nothing a workspace's request volume needs.
 * The `phone IS NULL OR phone = ''` guard means a number the rep (or anyone
 * else) already put on the contact by hand in the meantime is never
 * overwritten by a slower, less current delivery.
 */
function applyPendingPhoneReveal(workspaceId, providerId, phone) {
    const candidates = all(
        `SELECT * FROM people_enrich_requests
          WHERE workspace_id = ? AND status = 'approved' AND reveal_phone = 1
            AND people LIKE ?`,
        [workspaceId, `%"providerId":"${providerId}"%`],
    );
    for (const row of candidates) {
        let peopleList, result;
        try { peopleList = JSON.parse(row.people ?? '[]'); } catch { continue; }
        try { result = row.result ? JSON.parse(row.result) : {}; } catch { result = {}; }
        if (result[providerId]?.phone) continue; // already applied for this request
        const person = peopleList.find((p) => p.providerId === providerId);
        if (!person?.contactId) continue;
        run(
            `UPDATE contacts SET phone = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND (phone IS NULL OR phone = '')`,
            [phone, now(), person.contactId, workspaceId],
        );
        result[providerId] = { ...(result[providerId] ?? {}), phone };
        run(`UPDATE people_enrich_requests SET result = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(result), now(), row.id]);
    }
}

/**
 * Apollo's phone-reveal callback. PUBLIC — no session, matched by the
 * secret in the URL path, same shape as api/outreach.mjs's Smartlead
 * webhook (see that function's own comment for why: no signature header
 * to check, so the secret riding in the path IS the credential).
 *
 * The exact payload shape for a phone delivery is not fully documented at
 * the time this was written, so every plausible field name is tried
 * (`id`/`person_id`/`contact_id` for the Apollo person, `phone_number` /
 * `phone` / `sanitized_phone` / a `phone_numbers[]` array for the number
 * itself, `email` when Apollo includes it) and the whole raw body is kept
 * on the row regardless, so a real delivery that this misses to parse is
 * still recoverable by hand from `phone_reveals.raw` rather than lost.
 */
export async function phoneWebhook({ req, params }) {
    const body = await readJson(req).catch((error) => { throw error; });

    const provided = String(params.secret ?? '').trim();
    if (!provided) return { error: 'Missing webhook secret.' };

    const rows = all(`SELECT workspace_id, value FROM settings WHERE key = 'apollo_webhook_secret'`);
    let workspaceId = null;
    for (const row of rows) {
        let expected;
        try { expected = JSON.parse(row.value); } catch { continue; }
        if (!expected) continue;
        const a = Buffer.from(provided);
        const b = Buffer.from(String(expected));
        if (a.length === b.length && timingSafeEqual(a, b)) { workspaceId = row.workspace_id; break; }
    }
    if (!workspaceId) throw badRequest('Webhook secret is not recognised.');

    const payloads = Array.isArray(body) ? body : [body];
    let stored = 0;
    for (const payload of payloads) {
        const personId = payload.id ?? payload.person_id ?? payload.contact_id ?? payload.people_id ?? null;
        const email = payload.email ?? payload.person_email ?? null;
        const phone = payload.phone_number ?? payload.phone ?? payload.sanitized_phone
            ?? payload.phone_numbers?.[0]?.sanitized_number ?? payload.phone_numbers?.[0]?.raw_number ?? null;
        if (!phone || (!personId && !email)) continue; // nothing to match this delivery to
        run(
            `INSERT INTO phone_reveals (id, workspace_id, provider, provider_person_id, email, phone, raw, created_at)
             VALUES (?,?,?,?,?,?,?,?)`,
            [id('phr'), workspaceId, 'apollo', personId ? String(personId) : null, email ? String(email) : null,
                String(phone), JSON.stringify(payload).slice(0, 5000), now()],
        );
        stored += 1;
        if (personId) applyPendingPhoneReveal(workspaceId, String(personId), String(phone));
    }
    // Always 200 — same reasoning as the Smartlead webhook: a delivery
    // failure here is one only a human can fix, and Apollo retrying a
    // non-2xx would just replay the same outcome forever.
    return { received: payloads.length, stored };
}
