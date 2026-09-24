/**
 * Prospecting → CRM. The one door between the two planes.
 *
 * ── WHY THIS FILE IS THE WHOLE POINT ────────────────────────────────────────
 *
 * The CRM is only worth trusting if everything in it arrived deliberately.
 * `prospecting_companies` is the historical record of every company ever
 * uploaded — good, bad and unresolved. `accounts` is the working set. Nothing
 * crosses without passing through here, which is what lets a pipeline number
 * mean something.
 *
 * A promotion is: create the Account, carry the Contacts that pass the
 * assign an owner, and leave the prospect in place pointing at what it became. The prospect is NEVER deleted or moved — it is
 * history, and history that disappears when it is acted on is not history.
 *
 * ── WHAT IT REFUSES TO DO ───────────────────────────────────────────────────
 *
 *  · It will not promote an unqualified company unless explicitly forced, and
 *    says so rather than silently importing it.
 *  · It never withholds a contact for a bad email. Import is lossless; the
 *    deliverability gate is at campaign enrolment.
 *  · It will not create a second Account for a company already promoted; it
 *    returns the existing one. Double-clicking Import must not fork the CRM.
 */
import { all, get, run, id, now, json, tx } from './db.mjs';
import { createRecord, updateRecord, audit } from './repo.mjs';
import { setting } from './settings.mjs';
import { classify, STATUS_LABEL } from './verification.mjs';
import { badRequest, notFound } from './http.mjs';

/**
 * IMPORT IS LOSSLESS.
 *
 * Every contact attached to a promoted company comes across, whatever its
 * email says. This function exists only to LABEL what is coming, never to
 * refuse it.
 *
 * An earlier version filtered here, and it was wrong: a contact whose email
 * bounces is still a real person with a phone number, a title and a LinkedIn
 * profile. Dropping them at import throws away the relationship to solve a
 * problem that only exists at send time. Deliverability is gated where it
 * costs something — campaign enrolment, see `lib/campaigns.mjs`.
 */
export function describeContactEmail(contact) {
    const email = (contact.email ?? '').trim();
    if (!email) return { ok: true, band: 'none', reason: 'No email address on file.' };

    const status = contact.verification_status;
    if (!status) return { ok: true, band: 'unchecked', reason: 'Not verified yet.' };

    const band = classify(status);
    const label = STATUS_LABEL[status] ?? status;
    return {
        ok: true,
        band,
        reason: band === 'blocked'
            ? `${label} — imported, but will be held back from campaigns.`
            : `${label}.`,
    };
}

/** The fields a prospect hands to the Account it becomes. */
const CARRIED = [
    'name', 'domain', 'website', 'linkedin_slug', 'industry', 'country', 'city',
    'employee_count', 'phone', 'campaign_id', 'source', 'external_id', 'services',
    'score_overall', 'score_qualification', 'score_icp', 'score_size',
    'score_industry', 'score_decision_maker', 'score_enrichment', 'scored_at',
];

/**
 * What a promotion WOULD do, without doing it.
 *
 * Every count on this preview is produced by the same code the execution runs,
 * so the numbers cannot drift from the act.
 */
export function previewPromotion(ctx, prospectIds, { force = false } = {}) {
    const rows = [];

    for (const prospectId of prospectIds) {
        const prospect = get(
            'SELECT * FROM prospecting_companies WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL',
            [prospectId, ctx.workspaceId],
        );
        if (!prospect) {
            rows.push({ id: prospectId, name: '(missing)', action: 'skip', reason: 'No longer exists.' });
            continue;
        }

        if (prospect.imported_account_id) {
            rows.push({
                id: prospect.id, name: prospect.name, action: 'skip',
                reason: 'Already imported.', accountId: prospect.imported_account_id,
            });
            continue;
        }

        const qualified = prospect.status === 'qualified';
        if (!qualified && !force) {
            rows.push({
                id: prospect.id, name: prospect.name, action: 'blocked',
                reason: `Status is "${prospect.status}". The CRM takes qualified companies; import anyway only on purpose.`,
            });
            continue;
        }

        // An existing Account for the same company is a merge decision, not an
        // import. Flagged here rather than creating a duplicate silently.
        const existing = matchExistingAccount(ctx, prospect);

        const contacts = all(
            'SELECT * FROM prospecting_contacts WHERE prospect_id = ? AND workspace_id = ? AND deleted_at IS NULL',
            [prospect.id, ctx.workspaceId],
        );
        const judged = contacts.map((c) => ({
            id: c.id,
            name: c.full_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || '(unnamed)',
            email: c.email,
            status: c.verification_status,
            ...describeContactEmail(c),
        }));

        rows.push({
            id: prospect.id,
            name: prospect.name,
            action: existing ? 'merge' : 'create',
            reason: existing
                ? `An account already matches on ${existing.matcher}.`
                : qualified ? 'Qualified and ready.' : 'Forced despite status.',
            existingAccountId: existing?.id ?? null,
            existingAccountName: existing?.name ?? null,
            contacts: { total: judged.length, detail: judged, byBand: tallyBands(judged) },
        });
    }

    return {
        rows,
        totals: {
            create: rows.filter((r) => r.action === 'create').length,
            merge: rows.filter((r) => r.action === 'merge').length,
            blocked: rows.filter((r) => r.action === 'blocked').length,
            skip: rows.filter((r) => r.action === 'skip').length,
            // Every contact is imported. These two are reported so the state of
            // the data is visible, NOT because anything is being withheld.
            contacts: rows.reduce((a, r) => a + (r.contacts?.total ?? 0), 0),
            contactsUnverified: rows.reduce((a, r) => a + (r.contacts?.byBand?.unchecked ?? 0), 0),
            contactsUndeliverable: rows.reduce((a, r) => a + (r.contacts?.byBand?.blocked ?? 0), 0),
        },
    };
}

/** How many contacts sit in each deliverability band, for the preview. */
function tallyBands(judged) {
    const out = {};
    for (const c of judged) out[c.band] = (out[c.band] ?? 0) + 1;
    return out;
}

/** An account that already represents this company, by strongest key first. */
function matchExistingAccount(ctx, prospect) {
    const tryOne = (sql, value, matcher) => {
        if (!value) return null;
        const row = get(sql, [ctx.workspaceId, value]);
        return row ? { ...row, matcher } : null;
    };
    // Check non-deleted first, then soft-deleted (unique index includes all rows)
    return tryOne('SELECT id, name FROM accounts WHERE workspace_id = ? AND linkedin_slug = ? AND deleted_at IS NULL',
        prospect.linkedin_slug, 'LinkedIn slug')
        ?? tryOne('SELECT id, name FROM accounts WHERE workspace_id = ? AND linkedin_slug = ?',
            prospect.linkedin_slug, 'LinkedIn slug (deleted)')
        ?? tryOne('SELECT id, name FROM accounts WHERE workspace_id = ? AND domain = ? AND deleted_at IS NULL',
            prospect.domain, 'domain')
        ?? tryOne('SELECT id, name FROM accounts WHERE workspace_id = ? AND domain = ?',
            prospect.domain, 'domain (deleted)')
        ?? tryOne('SELECT id, name FROM accounts WHERE workspace_id = ? AND LOWER(name) = LOWER(?) AND deleted_at IS NULL',
            prospect.name, 'name')
        ?? tryOne('SELECT id, name FROM accounts WHERE workspace_id = ? AND LOWER(name) = LOWER(?)',
            prospect.name, 'name (deleted)');
}

/**
 * Promote for real.
 *
 * Wrapped in a transaction per prospect: a company that ends up as an Account
 * with none of its contacts, because the third insert failed, is worse than one
 * that was not imported at all — the first looks finished.
 */
export function promote(ctx, prospectIds, { force = false, ownerId = null } = {}) {
    const preview = previewPromotion(ctx, prospectIds, { force });

    let accountsCreated = 0;
    let accountsMerged = 0;
    let contactsCreated = 0;
    const results = [];

    for (const row of preview.rows) {
        if (row.action === 'skip' || row.action === 'blocked') {
            results.push(row);
            continue;
        }

        const prospect = get('SELECT * FROM prospecting_companies WHERE id = ?', [row.id]);

        tx(() => {
            let accountId = row.existingAccountId;

            if (accountId) {
                accountsMerged += 1;
                // Only fills gaps. An account being worked is not overwritten by
                // an uploaded row — see lib/merge.mjs for the same guarantee.
                const account = get('SELECT * FROM accounts WHERE id = ?', [accountId]);
                const fill = {};
                for (const key of CARRIED) {
                    const incoming = prospect[key];
                    const current = account[key];
                    const currentEmpty = current === null || current === undefined || String(current).trim() === '';
                    const incomingHas = incoming !== null && incoming !== undefined && String(incoming).trim() !== '';
                    if (currentEmpty && incomingHas) fill[key] = incoming;
                }
                // Restore soft-deleted accounts
                if (account.deleted_at) {
                    fill.deleted_at = null;
                }
                if (Object.keys(fill).length) {
                    const keys = Object.keys(fill);
                    run(`UPDATE accounts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
                        [...keys.map((k) => fill[k]), now(), accountId]);
                }
            } else {
                const payload = {};
                for (const key of CARRIED) if (prospect[key] !== null && prospect[key] !== undefined) payload[key] = prospect[key];
                payload.lifecycle_stage = 'prospect';
                payload.owner_id = ownerId ?? prospect.owner_id ?? ctx.userId;
                payload.properties = json(prospect.properties, {});

                const account = createRecord('account', ctx, payload, { source: 'promotion', reason: 'Imported from Prospecting' });
                accountId = account.id;
                accountsCreated += 1;
            }

            // EVERY contact comes across. Nothing is withheld for an
            // unverified or undeliverable address — a person with a bad email
            // still has a phone number, a title and a LinkedIn profile. The
            // deliverability gate is at campaign enrolment, where a bad address
            // actually costs something.
            for (const detail of row.contacts.detail) {
                const source = get('SELECT * FROM prospecting_contacts WHERE id = ?', [detail.id]);
                if (!source) continue;

                // A placeholder like "N/A" or "no email" is not an address —
                // matching on it would treat every prospect carrying the same
                // placeholder as the same person. Only a value with an `@` is
                // ever used to find an existing contact; anything else is
                // promoted as a new one, same as a blank cell.
                const sourceEmail = source.email && String(source.email).includes('@') ? source.email : null;
                const already = sourceEmail
                    ? get(
                        'SELECT id FROM contacts WHERE workspace_id = ? AND account_id = ? AND LOWER(email) = LOWER(?) AND deleted_at IS NULL',
                        [ctx.workspaceId, accountId, sourceEmail],
                    )
                    : null;
                if (already) continue;

                createRecord('contact', ctx, {
                    account_id: accountId,
                    first_name: source.first_name,
                    last_name: source.last_name,
                    title: source.title,
                    email: source.email,
                    phone: source.phone,
                    linkedin_url: source.linkedin_url,
                    roles: json(source.roles, []),
                    // The prospecting contact still carries a single
                    // service_line_key (out of this migration's scope —
                    // see lib/objects.mjs's contact field comment); the CRM
                    // contact it becomes gets it as the first entry of its
                    // own multi-service list, editable from there.
                    services: source.service_line_key ? [source.service_line_key] : [],
                    campaign_id: source.campaign_id,
                    data_source: source.data_source || 'Prospecting import',
                    acquired_at: source.acquired_at,
                    lawful_basis: source.lawful_basis,
                    email_verified: source.email_verified,
                    verification_status: source.verification_status,
                    verification_provider: source.verification_provider,
                    verification_confidence: source.verification_confidence,
                    verified_at: source.verified_at,
                    owner_id: ownerId ?? source.owner_id ?? ctx.userId,
                    is_active: 1,
                }, { source: 'promotion', reason: 'Imported from Prospecting' });
                contactsCreated += 1;
            }

            /**
             * IMPORTED MEANS GONE FROM PROSPECTING.
             *
             * ── WHAT IT USED TO DO ──────────────────────────────────────────
             *
             * Set `status = 'imported'` and leave the row exactly where it was,
             * so a company that had become an Account went on appearing in the
             * prospecting list — and its people went on appearing in
             * prospecting contacts, where nothing was written to them at all.
             * The sourcing book therefore accumulated every company anybody had
             * ever worked, and the question that book exists to answer ("who is
             * left to qualify") got harder to read with every success.
             *
             * Two records of one company is also two records to edit. Somebody
             * correcting an industry on the prospecting row was correcting a
             * copy nothing reads.
             *
             * ── WHY SOFT-DELETED AND NOT DESTROYED ──────────────────────────
             *
             * `deleted_at` removes it from every prospecting list, count and
             * screen — every query in this codebase filters on it — which is
             * what "gone from prospecting" means to anybody using the product.
             *
             * Destroying the row would take the evidence with it.
             * `prospecting_verdicts.prospect_id` is NOT NULL and references
             * this row; so do the evidence snapshots, and `contacts.prospect_id`
             * on every person imported alongside. That chain is how a deal
             * traces back to the verdict that sourced it — the ICP-to-revenue
             * loop this whole plane exists for. A promotion is also the one
             * action here somebody might want undone, and an undo needs a row.
             *
             * The status stays `imported` rather than being blanked, so the
             * funnel can still report how many were imported, and
             * `imported_account_id` still points at what it became.
             */
            const retiredAt = now();
            run(
                `UPDATE prospecting_companies
                    SET status = 'imported', imported_account_id = ?, imported_at = ?,
                        deleted_at = ?, updated_at = ?
                  WHERE id = ?`,
                [accountId, retiredAt, retiredAt, retiredAt, prospect.id],
            );

            /**
             * And the people with it. They were left untouched entirely — so a
             * contact imported into the CRM stayed in the prospecting contact
             * list for ever, and calling either copy was a coin toss.
             */
            run(
                `UPDATE prospecting_contacts
                    SET deleted_at = ?, updated_at = ?
                  WHERE prospect_id = ? AND workspace_id = ? AND deleted_at IS NULL`,
                [retiredAt, retiredAt, prospect.id, ctx.workspaceId],
            );

            audit(ctx, {
                objectKey: 'account', recordId: accountId, accountId, action: 'imported_from_prospecting',
                after: {
                    prospectId: prospect.id, prospectName: prospect.name,
                    contactsImported: row.contacts.total,
                    merged: Boolean(row.existingAccountId),
                    // Said in the trail, because "where did that prospect go"
                    // is asked by whoever notices the list got shorter.
                    retiredFromProspecting: true,
                },
            });

            results.push({ ...row, accountId });
        });
    }

    return {
        accountsCreated,
        accountsMerged,
        contactsCreated,
        blocked: preview.totals.blocked,
        skipped: preview.totals.skip,
        results,
    };
}
