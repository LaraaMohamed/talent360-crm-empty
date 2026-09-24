/**
 * Outreach — the provider-neutral half of the email-sequencing integration.
 *
 * ── THE SHAPE OF THIS ───────────────────────────────────────────────────────
 *
 * Smartlead executes sequences; this CRM stays the system of record. The
 * boundary is the same one lib/verification.mjs draws for email verification,
 * and for the same reason: the CRM must never learn a vendor's vocabulary.
 * A provider's answer is translated ONCE, here, into states this product owns:
 *
 *     sequence state   enrolled | sending | paused | completed | stopped
 *     engagement       first/last sent, opens, clicks, replies, bounce,
 *                      unsubscribe, lead category (interested / …)
 *
 * Everything provider-specific — endpoint names, payload quirks, the fact that
 * LEAD_UNSUBSCRIBED spells its address `lead_email` while every other event
 * says `to_email` — is absorbed in this file and nowhere else. Swapping
 * providers means rewriting lib/smartlead.mjs and the two translate functions
 * here, not the schema, not the API surface, not the UI.
 *
 * ── WHERE STATE LIVES ───────────────────────────────────────────────────────
 *
 * A Smartlead campaign IS a CRM campaign (channel 'email', external_id set);
 * an enrolled contact IS a campaign_members row. No second membership model —
 * attribution, rollups and the existing contacted→deal business rule keep
 * working untouched. The outreach columns on campaign_members carry CURRENT
 * state; outreach_events carries every raw event forever, append-only.
 *
 * ── THE THREE RULES ─────────────────────────────────────────────────────────
 *
 *  1. AN EVENT IS APPLIED AT MOST ONCE. The unique key on outreach_events is
 *     the law; the activity's idempotency_key is the belt to those braces.
 *  2. MEMBERSHIP STATUS NEVER MOVES BACKWARD. A reply outranks a send; a
 *     reconciliation sweep that re-reports "sending" after someone replied
 *     must not un-reply them.
 *  3. THE TIMELINE IS CURATED. Opens and clicks update counters silently —
 *     a tracking pixel loading is not a human moment — while sends, replies,
 *     bounces and unsubscribes become activities the team can act on.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { all, get, run, id as newId, now, json } from './db.mjs';
import { badRequest, notFound } from './http.mjs';
import { setting } from './settings.mjs';
import { audit, createRecord } from './repo.mjs';
import { classify } from './verification.mjs';
import { canEnrol } from './campaigns.mjs';
import * as smartlead from './smartlead.mjs';

export const PROVIDER = 'smartlead';

/** Neutral sequence-state vocabulary, and Smartlead's words mapped into it. */
export const SEQUENCE_STATUS = {
    STARTED: 'enrolled',
    INPROGRESS: 'sending',
    PAUSED: 'paused',
    COMPLETED: 'completed',
    STOPPED: 'stopped',
};

/** Rank so engagement never moves backward. Excluded sits outside the ladder. */
const STATUS_RANK = { targeted: 0, contacted: 1, engaged: 2, responded: 3, converted: 4 };

/* ------------------------------------------------------------ credentials -- */

export function apiKey(workspaceId) {
    return setting(workspaceId, 'smartlead_api_key');
}

export function isConfigured(workspaceId) {
    return Boolean(apiKey(workspaceId));
}

/** Constant-time compare — the webhook secret is a credential. */
export function webhookSecretMatches(workspaceId, provided) {
    const expected = setting(workspaceId, 'smartlead_webhook_secret');
    if (!expected || !provided) return false;
    const a = Buffer.from(String(provided));
    const b = Buffer.from(String(expected));
    return a.length === b.length && timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ events -- */

/**
 * Normalize one webhook payload into this product's vocabulary.
 *
 * Smartlead documents TWO shapes — flat (`event_type` at the top) and nested
 * (`event` with a `lead` object) — and does not say which any given campaign
 * will emit. This accepts both. It also absorbs the spelling quirks:
 * LEAD_UNSUBSCRIBED uses `lead_email`, replies carry `time_replied`.
 */
export function normalizeEvent(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const flat = typeof payload.event_type === 'string' ? payload : null;
    const nested = typeof payload.event === 'string' ? payload : null;
    if (!flat && !nested) return null;

    const type = String(flat?.event_type ?? nested?.event ?? '').toUpperCase();
    const lead = nested?.lead ?? {};
    const email = String(
        flat?.to_email ?? flat?.lead_email ?? lead.email ?? nested?.to_email ?? '',
    ).trim().toLowerCase();
    if (!type || !email) return null;

    // One timestamp per event kind; fall back to the time we got it.
    const occurredAt = flat?.time_replied ?? flat?.time_opened ?? flat?.time_sent
        ?? nested?.timestamp ?? nested?.reply?.received_at ?? now();

    return {
        type,
        email,
        name: String(flat?.to_name ?? `${lead.first_name ?? ''} ${lead.last_name ?? ''}`).trim(),
        campaignRef: flat?.campaign_id ?? nested?.campaign_id ?? null,
        campaignName: flat?.campaign_name ?? nested?.campaign_name ?? null,
        leadRef: nested?.lead_id ?? null,
        sequenceNumber: Number(flat?.sequence_number ?? nested?.sequence_number) || null,
        occurredAt,
        messageId: flat?.message_id ?? nested?.email?.message_id ?? null,
        category: flat?.category ?? nested?.category ?? null,
        replyPreview: flat?.preview_text ?? nested?.reply?.preview_text
            ?? stripHtml(flat?.reply_body ?? nested?.reply?.body),
        subject: flat?.subject ?? nested?.reply?.subject ?? null,
        raw: payload,
    };
}

function stripHtml(text) {
    if (!text) return null;
    return String(text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400) || null;
}

/**
 * The idempotency key for one delivery.
 *
 * Prefer Smartlead's own request id (its docs name `X-Request-Id` for exactly
 * this); without one, fingerprint the event itself. Two deliveries of the same
 * open/reply/bounce produce the same string, so the UNIQUE constraint below
 * collapses them into one row no matter how the race arrives.
 */
export function eventFingerprint(event, requestId) {
    if (requestId) return String(requestId);
    return createHash('sha256').update([
        PROVIDER,
        event.type,
        event.campaignRef ?? '',
        event.messageId ?? '',
        event.email,
        event.occurredAt ?? '',
    ].join('|')).digest('hex');
}

/* ------------------------------------------------------- webhook ingestion -- */

/**
 * Record + apply one webhook delivery. Returns what happened, never throws for
 * a well-formed but unapplicable event — Smartlead must get its 200 either way,
 * or it retries forever against a condition only a human can fix.
 */
export function ingestWebhookEvent(workspaceId, rawPayload, requestId = null) {
    const receivedAt = now();
    const event = normalizeEvent(rawPayload);

    if (!event) {
        // Malformed: recorded (so the health page can show it), never applied.
        run(
            `INSERT INTO outreach_events (id, workspace_id, provider, idempotency_key, event_type,
                payload, processing_status, error_message, received_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [newId('oev'), workspaceId, PROVIDER, eventFingerprint({ type: '?', email: '?' }, requestId),
                'MALFORMED', JSON.stringify(rawPayload ?? {}).slice(0, 100000), 'failed', 'Payload matched neither documented shape.', receivedAt],
        );
        return { status: 'rejected', reason: 'Unrecognised payload shape.' };
    }

    const key = eventFingerprint(event, requestId);
    try {
        run(
            `INSERT INTO outreach_events (id, workspace_id, provider, idempotency_key, event_type,
                external_campaign_id, occurred_at, payload, processing_status, received_at)
             VALUES (?,?,?,?,?,?,?,?,'received',?)`,
            [newId('oev'), workspaceId, PROVIDER, key, event.type, String(event.campaignRef ?? ''),
                event.occurredAt, JSON.stringify(event.raw).slice(0, 100000), receivedAt],
        );
    } catch (error) {
        if (String(error.message).includes('UNIQUE constraint failed')) {
            return { status: 'duplicate', idempotencyKey: key };
        }
        throw error;
    }

    try {
        applyEvent(workspaceId, event);
        run(`UPDATE outreach_events SET processing_status = 'processed', processed_at = ? WHERE workspace_id = ? AND idempotency_key = ?`,
            [now(), workspaceId, key]);
        return { status: 'processed', idempotencyKey: key };
    } catch (error) {
        run(`UPDATE outreach_events SET processing_status = 'failed', error_message = ?, processed_at = ? WHERE workspace_id = ? AND idempotency_key = ?`,
            [String(error.message).slice(0, 500), now(), workspaceId, key]);
        return { status: 'failed', reason: error.message };
    }
}

/**
 * Turn one normalized event into membership state (+ timeline where curated).
 * All SQL, all in the caller's wake — ingestWebhookEvent wraps failures.
 */
function applyEvent(workspaceId, event) {
    // Campaign must be linked: campaigns.external_id IS the Smartlead id.
    const campaignRow = get(
        `SELECT id, name, owner_id FROM campaigns WHERE workspace_id = ? AND external_id = ? AND deleted_at IS NULL`,
        [workspaceId, String(event.campaignRef ?? '')],
    );
    if (!campaignRow) throw new Error(`No CRM campaign is linked to Smartlead campaign ${event.campaignRef}.`);

    const contact = findContactByEmail(workspaceId, event.email);
    if (!contact) throw new Error(`No CRM contact has email ${event.email}.`);

    const member = ensureMembership(workspaceId, campaignRow.id, contact, event);

    /* --- counters and timestamps, per event kind --- */
    const updates = { last_event_type: event.type, last_event_at: event.occurredAt };
    let memberStatus = null;
    let timelineSubject = null;
    let body = null;
    let direction = 'outbound';

    switch (event.type) {
        case 'FIRST_EMAIL_SENT':
        case 'EMAIL_SENT':
            updates.total_emails_sent = (member.total_emails_sent ?? 0) + 1;
            updates.last_sent_at = event.occurredAt;
            if (!member.first_sent_at) updates.first_sent_at = event.occurredAt;
            if (event.sequenceNumber) updates.current_sequence = event.sequenceNumber;
            memberStatus = 'contacted';
            timelineSubject = `Sequence ${event.sequenceNumber ?? ''} email sent`.replace('  ', ' ');
            break;
        case 'EMAIL_OPEN':
            updates.total_opens = (member.total_opens ?? 0) + 1;
            break;
        case 'EMAIL_LINK_CLICK':
            updates.total_clicks = (member.total_clicks ?? 0) + 1;
            break;
        case 'EMAIL_REPLY':
            updates.total_replies = (member.total_replies ?? 0) + 1;
            if (!member.replied_at) updates.replied_at = event.occurredAt;
            memberStatus = 'responded';
            direction = 'inbound';
            timelineSubject = 'Replied to outreach';
            body = [event.subject, event.replyPreview].filter(Boolean).join(' — ') || null;
            notifyReply(workspaceId, contact, campaignRow.name);
            break;
        case 'EMAIL_BOUNCE':
            if (!member.bounced_at) updates.bounced_at = event.occurredAt;
            memberStatus = 'excluded';
            timelineSubject = 'Outreach email bounced';
            break;
        case 'LEAD_UNSUBSCRIBED':
            if (!member.unsubscribed_at) updates.unsubscribed_at = event.occurredAt;
            memberStatus = 'excluded';
            timelineSubject = 'Unsubscribed from outreach';
            break;
        case 'LEAD_CATEGORY_UPDATED':
            if (event.category) { updates.lead_category = event.category; updates.categorized_at = event.occurredAt; }
            memberStatus = categoryStatus(event.category) ?? 'responded';
            timelineSubject = `Marked ${event.category ?? 'categorised'} in Smartlead`;
            break;
        case 'MANUAL_STEP_REACHED':
            timelineSubject = 'Reached a manual step in the sequence';
            body = 'Smartlead paused this lead at a step that needs a human (call or LinkedIn action).';
            break;
        default:
            // Known-but-uninteresting (CAMPAIGN_STATUS_CHANGED, UNTRACKED_REPLIES):
            // recorded in the log, no membership change, no timeline noise.
            return;
    }

    const sets = Object.keys(updates).map((col) => `${col} = ?`);
    const params = Object.values(updates);
    run(`UPDATE campaign_members SET ${sets.join(', ')} WHERE id = ?`, [...params, member.id]);

    if (memberStatus) advanceMemberStatus(workspaceId, campaignRow.id, contact.id, memberStatus);

    const timelineEvents = setting(workspaceId, 'smartlead_timeline_events');
    const timelineKind = timelineKindOf(event.type);
    if (timelineSubject && timelineKind && timelineEvents.includes(timelineKind)) {
        recordTimelineActivity(workspaceId, {
            contactId: contact.id,
            accountId: contact.account_id,
            campaignName: campaignRow.name,
            subject: timelineSubject,
            body,
            occurredAt: event.occurredAt,
            direction,
            eventId: event.type,
            sequenceNumber: event.sequenceNumber,
        });
    }
}

function timelineKindOf(type) {
    if (type === 'FIRST_EMAIL_SENT' || type === 'EMAIL_SENT') return 'sent';
    if (type === 'EMAIL_REPLY') return 'reply';
    if (type === 'EMAIL_BOUNCE') return 'bounce';
    if (type === 'LEAD_UNSUBSCRIBED') return 'unsubscribe';
    if (type === 'LEAD_CATEGORY_UPDATED') return 'category';
    if (type === 'MANUAL_STEP_REACHED') return 'manual_step';
    return null; // opens/clicks: counters only
}

/** Interested-style categories lift to engaged; everything else just responded. */
function categoryStatus(category) {
    if (!category) return null;
    return /interest|meeting|book/i.test(String(category)) ? 'engaged' : 'responded';
}

function findContactByEmail(workspaceId, email) {
    return get(
        `SELECT id, account_id, owner_id, full_name, first_name, last_name, email, verification_status
           FROM contacts
          WHERE workspace_id = ? AND deleted_at IS NULL AND lower(email) = lower(?)`,
        [workspaceId, email],
    );
}

/**
 * Find the membership row, creating one only if the person genuinely isn't in
 * the campaign yet — which happens legitimately: someone added straight in
 * Smartlead shows up here first. Re-adding after removal clears the removal,
 * exactly as lib/campaigns.addMembers does.
 */
function ensureMembership(workspaceId, campaignId, contact, event) {
    const existing = get(
        `SELECT * FROM campaign_members WHERE campaign_id = ? AND member_type = 'contact' AND member_id = ?`,
        [campaignId, contact.id],
    );
    if (existing) {
        if (existing.removed_at) {
            run('UPDATE campaign_members SET removed_at = NULL WHERE id = ?', [existing.id]);
        }
        if (event.leadRef && !existing.external_key) {
            run('UPDATE campaign_members SET external_key = ? WHERE id = ? AND external_key IS NULL',
                [String(event.leadRef), existing.id]);
        }
        return existing;
    }
    const memberId = newId('cmm');
    run(
        `INSERT INTO campaign_members (id, workspace_id, campaign_id, member_type, member_id, account_id,
            status, external_key, added_at, notes)
         VALUES (?,?,?,'contact',?,?,?,?,?,?)`,
        [memberId, workspaceId, campaignId, contact.id, contact.account_id, 'targeted',
            event.leadRef ? String(event.leadRef) : null, now(), 'Added by Smartlead'],
    );
    return get('SELECT * FROM campaign_members WHERE id = ?', [memberId]);
}

/**
 * Move a member forward only. `excluded` wins over anything; otherwise the
 * higher rank wins. Delegates the actual write through setMemberStatus so the
 * contacted→deal pipeline rule fires exactly as it does for a human marking
 * someone Contacted — automation is not a licence to bypass business rules.
 */
function advanceMemberStatus(workspaceId, campaignId, contactId, target) {
    const current = get(
        `SELECT status FROM campaign_members WHERE campaign_id = ? AND member_type = 'contact' AND member_id = ?`,
        [campaignId, contactId],
    );
    if (!current) return;
    if (target === 'excluded') {
        if (current.status !== 'converted') {
            setMemberForward({ workspaceId }, campaignId, contactId, 'excluded');
        }
        return;
    }
    const from = STATUS_RANK[current.status] ?? -1;
    const to = STATUS_RANK[target] ?? -1;
    if (to > from) setMemberForward({ workspaceId }, campaignId, contactId, target);
}

// Imported late-bound via require-free ESM: campaigns.mjs imports repo.mjs which
// would cycle back through here if imported at top level alongside audit().
import { setMemberStatus } from './campaigns.mjs';
function setMemberForward(ctx, campaignId, contactId, status) {
    setMemberStatus(ctx, campaignId, 'contact', [contactId], status);
}

/* ------------------------------------------------------------- activities -- */

/** The 'outreach' activity type exists before the first event needs it. */
function ensureOutreachType(workspaceId) {
    const row = get(`SELECT id FROM activity_types WHERE workspace_id = ? AND key = 'outreach'`, [workspaceId]);
    if (row) return;
    run(
        `INSERT INTO activity_types (id, workspace_id, key, label, icon, color, manual, position)
         VALUES (?,?,?,?,?,?,?,?)`,
        [newId('aty'), workspaceId, 'outreach', 'Outreach', 'mail', 'info', 0, 60],
    );
}

function recordTimelineActivity(workspaceId, { contactId, accountId, campaignName, subject, body, occurredAt, direction, eventId, sequenceNumber }) {
    ensureOutreachType(workspaceId);
    const fingerprint = ['sl', contactId, eventId, campaignName, occurredAt, sequenceNumber ?? ''].join('|');
    const at = now();
    run(
        `INSERT INTO activities (id, workspace_id, parent_type, parent_id, account_id, type_key, subject, body,
            occurred_at, direction, source, properties, idempotency_key, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?, 'automation', ?, ?, ?, ?)`,
        [
            newId('act'), workspaceId, 'contact', contactId, accountId ?? null, 'outreach',
            subject, body, occurredAt, direction,
            JSON.stringify({ provider: PROVIDER, campaign: campaignName, event: eventId, sequence: sequenceNumber }),
            // DB-level dedupe: even if the events table were purged, the same
            // delivery can never appear twice on the timeline.
            fingerprint.slice(0, 200), at, at,
        ],
    );
}

function notifyReply(workspaceId, contact, campaignName) {
    try {
        // Late import avoided: notifications are best-effort and tiny, written
        // inline like lib/notify.write does everywhere else.
        const ownerId = contact.owner_id;
        if (!ownerId) return;
        const name = contact.full_name || [contact.first_name, contact.last_name].filter(Boolean).join(' ');
        run(
            `INSERT INTO notifications (id, workspace_id, user_id, kind, title, body, link, created_at)
             VALUES (?,?,?,?,?,?,?,?)`,
            [newId('ntf'), workspaceId, ownerId, 'outreach_reply',
                `Outreach reply: ${name}`,
                `Replied in “${campaignName}”.`, `/contacts/${contact.id}`, now()],
        );
    } catch { /* best-effort, always */ }
}

/* -------------------------------------------------------------- enrollment -- */


/**
 * Put selected contacts into a linked Smartlead campaign.
 *
 * Returns ONE RESULT PER CONTACT — enrolled, already_member, skipped (with the
 * actual reason), or failed (with the actual reason) — because reporting a
 * blanket success over a mixed batch is how silent data loss hides.
 */
export async function enrollContacts(ctx, { campaignId, contacts, mapping, options = {} }) {
    const campaignRow = get(
        `SELECT * FROM campaigns WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
        [campaignId, ctx.workspaceId],
    );
    if (!campaignRow) throw notFound('That campaign does not exist.');
    if (!campaignRow.external_id) throw badRequest('This campaign is not linked to a Smartlead campaign yet.');
    const key = apiKey(ctx.workspaceId);
    if (!key) throw badRequest('Connect Smartlead in Settings → Integrations first.');

    const policy = setting(ctx.workspaceId, 'campaign_email_policy') ?? 'review';
    const results = [];
    const accepted = [];
    const seenEmails = new Set();

    for (const contact of contacts) {
        const name = contact.full_name || [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email;
        const base = {
            id: contact.id, name, email: contact.email,
            company: contact.account_name ?? null,
            verificationStatus: contact.verification_status ?? null,
        };

        const existing = get(
            `SELECT id, removed_at, outreach_status, added_at, last_event_at FROM campaign_members
              WHERE campaign_id = ? AND member_type = 'contact' AND member_id = ?`,
            [campaignId, contact.id],
        );
        if (existing && !existing.removed_at) {
            results.push({
                ...base, result: 'already_member',
                existingMembership: {
                    outreachStatus: existing.outreach_status, addedAt: existing.added_at, lastEventAt: existing.last_event_at,
                },
            });
            continue;
        }

        const verdict = canEnrol(contact, policy);
        if (!verdict.ok) {
            results.push({ ...base, result: 'skipped', reason: verdict.reason });
            continue;
        }

        const suppressed = suppressionReason(ctx.workspaceId, contact.id);
        if (suppressed && !options.override) {
            results.push({ ...base, result: 'skipped', reason: suppressed });
            continue;
        }

        const email = String(contact.email ?? '').trim();
        if (!email || !email.includes('@')) {
            results.push({ ...base, result: 'skipped', reason: 'No usable email address.' });
            continue;
        }
        if (seenEmails.has(email.toLowerCase())) {
            results.push({ ...base, result: 'skipped', reason: 'Duplicate in this batch.' });
            continue;
        }
        seenEmails.add(email.toLowerCase());

        accepted.push({ contact, base });
        results.push({ ...base, result: 'pending' });
    }

    /**
     * REVIEW, before a single request reaches Smartlead.
     *
     * Everything above this line — already-a-member, suppressed, no usable
     * email, a duplicate address within the same batch — is exactly the
     * classification a real send would produce, computed without one. This
     * is what lets the enrollment wizard show "20 contacts: 17 will be
     * added, 2 already there, 1 held back" and let a person say yes BEFORE
     * anything is pushed, rather than after.
     */
    if (options.dryRun) {
        return { results, summary: summarize(results), policy, dryRun: true };
    }

    /* --- push the acceptable ones, in batches the API is known to take --- */
    if (accepted.length) {
        const leadList = accepted.map(({ contact }) => mapToLead(contact, mapping));
        try {
            const response = await smartlead.addLeadsToCampaign(campaignRow.external_id, leadList, undefined, {
                apiKey: key, fetcher: options.fetcher,
            });
            const skippedByReason = new Map();
            for (const skip of response?.skipped_leads ?? []) {
                skippedByReason.set(String(skip?.email ?? '').toLowerCase(), skip?.reason ?? 'Skipped by Smartlead.');
            }
            for (const item of accepted) {
                const email = String(item.contact.email).toLowerCase();
                if (skippedByReason.has(email)) {
                    markResult(results, item.base.id, 'skipped', skippedByReason.get(email));
                    continue;
                }
                markResult(results, item.base.id, 'enrolled');
                upsertEnrolledMembership(ctx.workspaceId, campaignRow.id, item.contact);
            }
        } catch (error) {
            // The whole push failed — report it honestly per contact rather
            // than pretending partial success.
            for (const item of accepted) {
                markResult(results, item.base.id, 'failed', friendlyError(error));
            }
        }
    }

    const enrolled = results.filter((r) => r.result === 'enrolled').length;
    if (enrolled > 0) {
        audit(ctx, {
            objectKey: 'campaign', recordId: campaignRow.id,
            action: 'outreach_enrolled',
            after: { provider: PROVIDER, smartlead_campaign: campaignRow.external_id, enrolled },
            source: 'automation',
        });
    }

    return { results, summary: summarize(results), policy };
}

function suppressionReason(workspaceId, contactId) {
    const row = get(
        `SELECT m.unsubscribed_at AS unsubscribed_at, m.bounced_at AS bounced_at
           FROM campaign_members m
           JOIN campaigns c ON c.id = m.campaign_id
          WHERE m.workspace_id = ? AND m.member_type = 'contact' AND m.member_id = ?
            AND c.deleted_at IS NULL
          ORDER BY COALESCE(m.unsubscribed_at, m.bounced_at) DESC
          LIMIT 1`,
        [workspaceId, contactId],
    );
    if (!row) return null;
    if (row.unsubscribed_at) return `Unsubscribed from outreach on ${row.unsubscribed_at.slice(0, 10)}.`;
    if (row.bounced_at) return `Email bounced on ${row.bounced_at.slice(0, 10)} — fix the address first.`;
    return null;
}

function upsertEnrolledMembership(workspaceId, campaignId, contact) {
    const existing = get(
        `SELECT id, removed_at FROM campaign_members WHERE campaign_id = ? AND member_type = 'contact' AND member_id = ?`,
        [campaignId, contact.id],
    );
    if (existing) {
        run(`UPDATE campaign_members SET removed_at = NULL, outreach_status = COALESCE(outreach_status, 'enrolled')
               WHERE id = ?`, [existing.id]);
        return;
    }
    run(
        `INSERT INTO campaign_members (id, workspace_id, campaign_id, member_type, member_id, account_id,
            status, outreach_status, added_by, added_at)
         VALUES (?,?,?,'contact',?,?,?,?,?,?)`,
        [newId('cmm'), workspaceId, campaignId, contact.id, contact.account_id ?? null,
            'targeted', 'enrolled', null, now()],
    );
}

/**
 * CRM → Smartlead field resolution. System columns resolve directly; anything
 * else reads the contact's custom-field JSON. `account_name` comes joined onto
 * the contact by the caller.
 */
export function mapToLead(contact, mapping = {}) {
    const custom = {};
    for (const [smartKey, crmKey] of Object.entries(mapping.custom ?? {})) {
        const value = resolveCrmField(contact, crmKey);
        if (value !== null && value !== undefined && String(value).trim() !== '') {
            custom[smartKey] = String(value);
        }
    }
    const company = resolveCrmField(contact, mapping.company_name ?? 'account_name');
    const lead = {
        email: String(contact.email).trim(),
        first_name: contact.first_name ?? '',
        last_name: contact.last_name ?? '',
    };
    if (company) lead.company_name = String(company);
    if (Object.keys(custom).length) lead.custom_fields = custom;
    return lead;
}

export function resolveCrmField(contact, key) {
    if (!key) return null;
    if (key === 'account_name') return contact.account_name ?? null;
    if (Object.prototype.hasOwnProperty.call(contact, key)) return contact[key];
    const properties = json(contact.properties, {}) ?? {};
    return properties[key] ?? null;
}

/** The CRM fields the wizard offers for mapping. Custom fields arrive via meta. */
export const MAPPABLE_CRM_FIELDS = [
    ['first_name', 'First name'], ['last_name', 'Last name'], ['full_name', 'Full name'],
    ['email', 'Email'], ['phone', 'Phone'], ['title', 'Job title'],
    ['linkedin_url', 'LinkedIn URL'], ['account_name', 'Account name'],
];

function markResult(results, contactId, result, reason) {
    const row = results.find((r) => r.id === contactId);
    if (row) { row.result = result; if (reason) row.reason = reason; }
}

function summarize(results) {
    const out = { enrolled: 0, already_member: 0, skipped: 0, failed: 0 };
    for (const r of results) out[r.result] = (out[r.result] ?? 0) + 1;
    return out;
}

function friendlyError(error) {
    if (error?.authFailed) return 'Smartlead rejected the API key.';
    if (error?.rateLimited) return 'Smartlead rate limit hit — try again shortly.';
    return String(error.message ?? error).slice(0, 200);
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/* ---------------------------------------------------------- reconciliation -- */

const SYNC_PAGE_LIMIT = 100;
const SYNC_MAX_PAGES = 30;   // 3,000 leads per campaign per sweep, then it says so

/**
 * Pull one linked campaign's truth from Smartlead and reconcile memberships.
 *
 * Webhooks are trusted but not relied on: this runs on a timer and on demand,
 * and it is how a missed/delayed delivery heals. Three passes per campaign —
 * everyone, everyone who replied, everyone who bounced — each paged, replies
 * and bounces narrowed by the API's own filters so a steady state costs three
 * small requests rather than a full download.
 */
export async function syncCampaignLeads(workspaceId, campaignRow, options = {}) {
    const key = options.apiKey ?? apiKey(workspaceId);
    if (!key) throw badRequest('Connect Smartlead first.');

    ensureOutreachType(workspaceId);
    const stats = { scanned: 0, updated: 0, repliesFound: 0, bouncesFound: 0, pages: 0 };

    const sinceSetting = setting(workspaceId, 'smartlead_last_sync_at');
    const since = options.full ? null : (sinceSetting ?? null);

    await reconcilePass(workspaceId, campaignRow, key, {}, stats, since, options);
    await reconcilePass(workspaceId, campaignRow, key, { emailStatus: 'is_replied' }, stats, since, options, 'repliesFound');
    await reconcilePass(workspaceId, campaignRow, key, { emailStatus: 'is_bounced' }, stats, since, options, 'bouncesFound');

    return stats;
}

/**
 * The other direction from reconcilePass: leads Smartlead knows about that
 * this CRM has never met. reconcileLead deliberately refuses to attach truth
 * to a person the CRM has no record of (see its own comment) — that refusal
 * is correct for a background sweep, but it means a campaign linked straight
 * from Smartlead (rather than built by enrolling CRM contacts first) reads as
 * "zero everything" forever, because there is nothing here to update.
 *
 * This is the explicit, one-time fix for exactly that: pull every lead on the
 * Smartlead side, create the contact if none matches by email, and give it a
 * campaign_members row — the same row ensureMembership would create for a
 * webhook, just made up front instead of waiting for one lead at a time to
 * reply or bounce. Afterwards it calls syncCampaignLeads so status, replies
 * and bounces backfill immediately instead of waiting for the next sweep.
 *
 * What this can NOT backfill: per-lead sent counts. Smartlead's leads listing
 * does not carry them (only reply/bounce filters and a coarse sequence
 * status) — total_emails_sent only grows from here on, off real webhook
 * events, exactly as it does for a campaign built the other way around.
 */
export async function importLeadsFromSmartlead(ctx, campaignId, options = {}) {
    const campaignRow = get(
        `SELECT * FROM campaigns WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
        [campaignId, ctx.workspaceId],
    );
    if (!campaignRow) throw notFound('That campaign does not exist.');
    if (!campaignRow.external_id) throw badRequest('This campaign is not linked to a Smartlead campaign yet.');
    const key = apiKey(ctx.workspaceId);
    if (!key) throw badRequest('Connect Smartlead in Settings → Integrations first.');

    const stats = { scanned: 0, contactsCreated: 0, membersAdded: 0, alreadyMembers: 0, skippedNoEmail: 0 };
    let offset = 0;
    for (;;) {
        const page = await smartlead.getCampaignLeads(campaignRow.external_id, { offset, limit: SYNC_PAGE_LIMIT }, { apiKey: key, fetcher: options.fetcher });
        const rows = page?.data ?? [];
        for (const row of rows) {
            stats.scanned += 1;
            const lead = row?.lead ?? {};
            const email = String(lead.email ?? '').trim().toLowerCase();
            if (!email) { stats.skippedNoEmail += 1; continue; }

            let contact = get(
                `SELECT id, account_id FROM contacts WHERE workspace_id = ? AND deleted_at IS NULL AND lower(email) = ?`,
                [ctx.workspaceId, email],
            );
            if (!contact) {
                const fullName = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.name || email;
                const created = createRecord('contact', ctx, {
                    full_name: fullName,
                    first_name: lead.first_name ?? null,
                    last_name: lead.last_name ?? null,
                    email: lead.email,
                    data_source: 'Smartlead import',
                }, { source: 'smartlead-import' });
                contact = { id: created.id, account_id: created.account_id ?? null };
                stats.contactsCreated += 1;
            }

            const existing = get(
                `SELECT id, removed_at FROM campaign_members WHERE campaign_id = ? AND member_type = 'contact' AND member_id = ?`,
                [campaignRow.id, contact.id],
            );
            if (existing) {
                if (existing.removed_at) run('UPDATE campaign_members SET removed_at = NULL WHERE id = ?', [existing.id]);
                stats.alreadyMembers += 1;
                continue;
            }
            try {
                run(
                    `INSERT INTO campaign_members (id, workspace_id, campaign_id, member_type, member_id, account_id,
                        status, external_key, added_at, notes)
                     VALUES (?,?,?,'contact',?,?,?,?,?,?)`,
                    [newId('cmm'), ctx.workspaceId, campaignRow.id, contact.id, contact.account_id ?? null,
                        'targeted', row.campaign_lead_map_id ? String(row.campaign_lead_map_id) : null, now(), 'Imported from Smartlead'],
                );
                stats.membersAdded += 1;
            } catch (err) {
                /**
                 * The check above and this insert are not one atomic step —
                 * the leads page fetch just before it (`getCampaignLeads`)
                 * is an await, a real yield point, so two overlapping
                 * imports for the same campaign (a double-click, or the
                 * automatic import right after linking racing a user who
                 * clicked "Import leads" again) can both pass the SELECT
                 * before either INSERTs. The second write hit `campaign_
                 * members`'s own UNIQUE(campaign_id, member_type, member_id)
                 * — schema.sql — and threw a raw SQLite error, which is not
                 * an HttpError, so it surfaced as the generic "Something
                 * went wrong on the server." with nothing to explain it.
                 * The other request winning that race is success, not
                 * failure — the contact IS a member.
                 */
                if (!String(err.message ?? err).toLowerCase().includes('unique')) throw err;
                stats.alreadyMembers += 1;
            }
        }
        if (rows.length < SYNC_PAGE_LIMIT) break;
        offset += SYNC_PAGE_LIMIT;
        if (offset >= SYNC_PAGE_LIMIT * SYNC_MAX_PAGES) break;
    }

    if (stats.membersAdded > 0) {
        const syncStats = await syncCampaignLeads(ctx.workspaceId, campaignRow, { full: true, fetcher: options.fetcher });
        stats.reconciled = syncStats;
    }
    return stats;
}

async function reconcilePass(workspaceId, campaignRow, key, filter, stats, since, options = {}, counter = 'updated') {
    const campaignRef = campaignRow.external_id;
    let offset = 0;
    for (;;) {
        const page = await smartlead.getCampaignLeads(campaignRef, { offset, limit: SYNC_PAGE_LIMIT, ...filter }, { apiKey: key, fetcher: options.fetcher });
        stats.pages += 1;
        const rows = page?.data ?? [];
        for (const row of rows) stats.scanned += 1;
        for (const row of rows) {
            const changed = reconcileLead(workspaceId, campaignRow, row, counter === 'repliesFound', counter === 'bouncesFound', stats);
            if (changed) {
                stats.updated += 1;
                if (counter !== 'updated') stats[counter] += 1;
            }
        }
        if (rows.length < SYNC_PAGE_LIMIT) break;
        offset += SYNC_PAGE_LIMIT;
        if (offset >= SYNC_PAGE_LIMIT * SYNC_MAX_PAGES) break;
    }
}

function reconcileLead(workspaceId, campaignRow, row, isReplyPass, isBouncePass, stats) {
    const lead = row?.lead ?? {};
    const email = String(lead.email ?? '').trim().toLowerCase();
    if (!email) return false;

    const member = get(
        `SELECT * FROM campaign_members WHERE campaign_id = ? AND member_type = 'contact'
           AND (external_key = ? OR member_id IN (SELECT id FROM contacts WHERE workspace_id = ? AND lower(email) = lower(?) AND deleted_at IS NULL))
         LIMIT 1`,
        [campaignRow.id, String(row.campaign_lead_map_id ?? ''), workspaceId, email],
    );

    const neutralStatus = SEQUENCE_STATUS[String(row.status ?? '').toUpperCase()] ?? null;
    const unsubscribed = Boolean(lead.is_unsubscribed);

    if (!member) {
        // Someone Smartlead knows that the CRM does not: nothing to attach the
        // truth TO. Counted as scanned, surfaced nowhere else — creating a bare
        // contact from an email address alone is import's job, done properly.
        return false;
    }

    const updates = {};
    if (row.campaign_lead_map_id && !member.external_key) updates.external_key = String(row.campaign_lead_map_id);
    if (neutralStatus && neutralStatus !== member.outreach_status && rankSafe(member.status, neutralStatus)) {
        updates.outreach_status = neutralStatus;
    }
    if (unsubscribed && !member.unsubscribed_at) {
        updates.unsubscribed_at = now();
    }

    // Replies and bounces get their own writes below, driven by which PASS
    // this is, not by `updates` — a lead whose external_key/status were
    // already settled by the unfiltered pass has an empty `updates` here,
    // and returning early on that (as this used to) silently ate every
    // reply/bounce discovered on the later filtered passes: the exact bug
    // behind replies and bounces reading as zero when Smartlead shows real
    // activity. `changed` tracks whether ANY write happened, across all three.
    let changed = false;
    if (Object.keys(updates).length) {
        const sets = Object.keys(updates).map((col) => `${col} = ?`);
        run(`UPDATE campaign_members SET ${sets.join(', ')} WHERE id = ?`, [...Object.values(updates), member.id]);
        changed = true;
        if (updates.unsubscribed_at) advanceMemberStatus(workspaceId, campaignRow.id, member.member_id, 'excluded');
    }

    // Replies discovered here (not by webhook) still earn their timeline entry:
    // the idempotency key is deterministic off the membership, so a later
    // webhook for the same reply collapses into the SAME activity.
    if (isReplyPass && !member.replied_at) {
        // total_replies is otherwise only incremented per real-time webhook
        // event, which a sync-discovered reply never received — without this
        // it would show replied_at set but total_replies still 0, which is
        // its own "zero that is not true". One is an honest floor: sync
        // cannot know the exact count, only that at least one reply happened.
        run(`UPDATE campaign_members SET replied_at = ?, total_replies = COALESCE(total_replies, 0) + 1 WHERE id = ?`, [now(), member.id]);
        changed = true;
        const contact = get(
            `SELECT id, account_id, owner_id, full_name, first_name, last_name FROM contacts WHERE id = ?`,
            [member.member_id],
        );
        if (contact) {
            recordTimelineActivity(workspaceId, {
                contactId: contact.id, accountId: contact.account_id,
                campaignName: campaignRow.name,
                subject: 'Replied to outreach (found on sync)', body: null,
                occurredAt: now(), direction: 'inbound', eventId: 'EMAIL_REPLY', sequenceNumber: null,
            });
            advanceMemberStatus(workspaceId, campaignRow.id, member.member_id, 'responded');
        }
    }
    if (isBouncePass && !member.bounced_at) {
        run(`UPDATE campaign_members SET bounced_at = COALESCE(bounced_at, ?) WHERE id = ?`, [now(), member.id]);
        changed = true;
        advanceMemberStatus(workspaceId, campaignRow.id, member.member_id, 'excluded');
    }
    return changed;
}

/**
 * Whether a SYNC-discovered sequence state may overwrite outreach_status.
 *
 * Paused/stopped are always safe — they are facts about the sequence, not
 * about the person. Everything else is a progression claim, and once somebody
 * has replied or converted, no later "INPROGRESS" from a sweep may walk that
 * back; engagement outranks the machine. (Webhook writes go through
 * advanceMemberStatus's rank guard instead — this only guards the sweeper.)
 */
function rankSafe(currentMemberStatus, nextSequenceState) {
    if (nextSequenceState === 'stopped' || nextSequenceState === 'paused') return true;
    if (currentMemberStatus === 'responded' || currentMemberStatus === 'converted') return false;
    return true;
}

/**
 * Sweep every workspace that has both a key and at least one linked campaign.
 * Called by the timer in server.mjs and by Integration health's Sync now.
 */
export async function syncAllWorkspaces(options = {}) {
    const links = all(
        `SELECT DISTINCT c.workspace_id AS workspace_id
           FROM campaigns c JOIN settings s ON s.workspace_id = c.workspace_id AND s.key = 'smartlead_api_key'
          WHERE c.external_id IS NOT NULL AND c.deleted_at IS NULL`,
    );
    const out = [];
    for (const link of links) {
        const key = apiKey(link.workspace_id);
        if (!key) continue;
        const campaigns = all(
            `SELECT id, name, external_id FROM campaigns
              WHERE workspace_id = ? AND external_id IS NOT NULL AND deleted_at IS NULL`,
            [link.workspace_id],
        );
        for (const campaignRow of campaigns) {
            try {
                const stats = await syncCampaignLeads(link.workspace_id, campaignRow, { ...options, apiKey: key });
                out.push({ workspaceId: link.workspace_id, campaignId: campaignRow.id, ok: true, stats });
            } catch (error) {
                out.push({ workspaceId: link.workspace_id, campaignId: campaignRow.id, ok: false, error: friendlyError(error) });
            }
        }
        setSettingSafe(link.workspace_id, 'smartlead_last_sync_at', now());
    }
    return out;
}

function setSettingSafe(workspaceId, key, value) {
    try {
        run(
            `INSERT INTO settings (workspace_id, key, value, updated_at) VALUES (?,?,?,?)
             ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            [workspaceId, key, JSON.stringify(value), now()],
        );
    } catch { /* the sweep must never die writing its own bookmark */ }
}

/* -------------------------------------------------------------- overview -- */

/**
 * Every Smartlead-linked CRM campaign, with the outreach rollup a manager
 * actually wants to see without opening each one — mapped contacts, sent,
 * replies, bounces, interested, when it last synced. The single screen
 * `campaignOutreachPanel` never offered: that lives inside one campaign's
 * Members tab, and there was nowhere to see all of them at once.
 */
export function campaignsOverview(workspaceId) {
    const rows = all(
        `SELECT c.id, c.name, c.status, c.external_id,
                COUNT(m.id) AS mapped,
                SUM(CASE WHEN m.removed_at IS NULL THEN 1 ELSE 0 END) AS active_members,
                SUM(COALESCE(m.total_emails_sent, 0)) AS total_sent,
                SUM(COALESCE(m.total_replies, 0)) AS total_replies,
                SUM(CASE WHEN m.bounced_at IS NOT NULL THEN 1 ELSE 0 END) AS total_bounces,
                SUM(CASE WHEN m.unsubscribed_at IS NOT NULL THEN 1 ELSE 0 END) AS total_unsubscribed,
                SUM(CASE WHEN m.outreach_status = 'engaged' OR (m.lead_category IS NOT NULL AND m.lead_category LIKE '%nterest%') THEN 1 ELSE 0 END) AS total_interested,
                MAX(m.last_event_at) AS last_activity_at
           FROM campaigns c
           LEFT JOIN campaign_members m ON m.campaign_id = c.id AND m.member_type = 'contact'
          WHERE c.workspace_id = ? AND c.external_id IS NOT NULL AND c.deleted_at IS NULL
          GROUP BY c.id
          ORDER BY c.name`,
        [workspaceId],
    );
    const webhooks = json(setting(workspaceId, 'smartlead_webhooks'), {}) ?? {};
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        externalId: row.external_id,
        mapped: row.mapped ?? 0,
        activeMembers: row.active_members ?? 0,
        totalSent: row.total_sent ?? 0,
        totalReplies: row.total_replies ?? 0,
        totalBounces: row.total_bounces ?? 0,
        totalUnsubscribed: row.total_unsubscribed ?? 0,
        totalInterested: row.total_interested ?? 0,
        lastActivityAt: row.last_activity_at ?? null,
        replyRate: row.total_sent ? round2((100 * row.total_replies) / row.total_sent) : null,
        bounceRate: row.total_sent ? round2((100 * row.total_bounces) / row.total_sent) : null,
        webhookRegistered: Boolean(webhooks[String(row.id)]?.webhookId),
    }));
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/* ----------------------------------------------------------------- health -- */

export function integrationStatus(workspaceId) {
    const configured = isConfigured(workspaceId);
    const linked = all(
        `SELECT id, name, external_id, status FROM campaigns
          WHERE workspace_id = ? AND external_id IS NOT NULL AND deleted_at IS NULL`,
        [workspaceId],
    );
    const counts = get(
        `SELECT SUM(CASE WHEN processing_status = 'failed' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN processing_status = 'processed' THEN 1 ELSE 0 END) AS processed,
                COUNT(*) AS total,
                MAX(received_at) AS last_webhook_at
           FROM outreach_events WHERE workspace_id = ?`,
        [workspaceId],
    ) ?? {};
    const recentErrors = all(
        `SELECT id, event_type, error_message, retry_count, received_at
           FROM outreach_events WHERE workspace_id = ? AND processing_status = 'failed'
          ORDER BY received_at DESC LIMIT 10`,
        [workspaceId],
    );
    return {
        configured,
        campaignsLinked: linked.length,
        campaigns: linked,
        webhooks: json(setting(workspaceId, 'smartlead_webhooks'), {}) ?? {},
        lastSyncAt: setting(workspaceId, 'smartlead_last_sync_at'),
        events: {
            total: counts.total ?? 0,
            processed: counts.processed ?? 0,
            failed: counts.failed ?? 0,
            lastWebhookAt: counts.last_webhook_at ?? null,
        },
        recentErrors,
    };
}

/** Replay one failed event. Same code path as the original delivery. */
export function retryEvent(workspaceId, eventId) {
    const row = get(
        `SELECT * FROM outreach_events WHERE id = ? AND workspace_id = ?`,
        [eventId, workspaceId],
    );
    if (!row) throw notFound('No such event.');
    if (row.processing_status !== 'failed') throw badRequest('Only failed events can be retried.');

    let payload;
    try { payload = JSON.parse(row.payload ?? '{}'); } catch { payload = {}; }
    try {
        if (row.event_type === 'MALFORMED') throw new Error('The payload itself was malformed; nothing to replay.');
        applyEvent(workspaceId, normalizeEvent(payload) ?? (() => { throw new Error('Stored payload no longer parses.'); })());
        run(`UPDATE outreach_events SET processing_status = 'processed', processed_at = ?, retry_count = retry_count + 1 WHERE id = ?`,
            [now(), eventId]);
        return { ok: true };
    } catch (error) {
        run(`UPDATE outreach_events SET processing_status = 'failed', error_message = ?, retry_count = retry_count + 1 WHERE id = ?`,
            [String(error.message).slice(0, 500), eventId]);
        return { ok: false, reason: String(error.message).slice(0, 200) };
    }
}
