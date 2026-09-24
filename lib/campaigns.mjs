/**
 * Campaign membership and attribution.
 *
 * ── WHAT A CAMPAIGN IS HERE ─────────────────────────────────────────────────
 * A record of an outbound push: who it reached, and what it produced. It is
 * NOT a marketing automation platform — nothing is sent from here, there are no
 * landing pages and no open tracking. `docs/01_PRODUCT_VISION.md` rules that
 * out explicitly, and the boundary is worth keeping: the moment a CRM starts
 * sending email it inherits deliverability, suppression lists and consent
 * plumbing, none of which this team is buying.
 *
 * ── THE TWO RULES THAT SHAPE THIS FILE ──────────────────────────────────────
 *
 *  1. ONE-TIME AND RECURRING ARE NEVER SUMMED. A campaign that sourced one
 *     placement fee and one 24-month retainer produced two figures, and adding
 *     them overstates the campaign in exactly the direction that flatters it.
 *     Same rule as `money.mjs`, one level up. Cost per acquisition is reported
 *     against the count, never against a blended revenue number.
 *
 *  2. MEMBERSHIP IS HISTORY. `added_at` survives removal, because a campaign's
 *     reach in March is a fact about March. Removing someone sets `removed_at`;
 *     it does not delete the row, or last quarter's report moves.
 */
import { all, get, run, id, now } from './db.mjs';
import { deriveValues } from './money.mjs';
import { badRequest, notFound } from './http.mjs';
import { setting } from './settings.mjs';
import { classify, STATUS_LABEL } from './verification.mjs';
import { ensureDealForAccount, moveDealToStage, advanceDealToStage } from './repo.mjs';

export const MEMBER_STATUSES = ['targeted', 'contacted', 'engaged', 'responded', 'converted', 'excluded'];
export const MEMBER_TYPES = ['contact', 'account'];

/* ---------------------------------------------------------------- members -- */

export function campaign(ctx, campaignId) {
    const row = get('SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?', [campaignId, ctx.workspaceId]);
    if (!row || row.deleted_at) throw notFound('That campaign does not exist.');
    return row;
}

/**
 * Adds members, idempotently.
 *
 * Re-running the same add is a no-op rather than an error, because the usual
 * caller is "select everything matching this filter and add it", run twice by
 * two people on overlapping selections. Returns what actually happened so the
 * UI can say "412 added, 88 already there" instead of claiming 500.
 */
/**
 * Is this contact safe to send to?
 *
 * THE deliverability gate. Not import — here. A contact with a dead address is
 * still a real person worth keeping and worth calling; they simply must not be
 * mailed. Blocking them at enrolment protects the sending domain without
 * costing the relationship.
 *
 * Blocked outcomes are refused under every policy, `all` included: one hard
 * bounce costs more reputation than any single recipient is worth.
 */
export function canEnrol(contact, policy) {
    const email = (contact.email ?? '').trim();
    if (!email) return { ok: false, reason: 'No email address.' };

    const status = contact.verification_status;
    if (!status) {
        return policy === 'safe'
            ? { ok: false, reason: 'Never verified — this campaign takes verified addresses only.' }
            : { ok: true, reason: 'Not verified.' };
    }

    const band = classify(status);
    const label = STATUS_LABEL[status] ?? status;
    if (band === 'blocked') return { ok: false, reason: `${label} — never enrolled, under any policy.` };
    if (band === 'safe') return { ok: true, reason: label };
    return policy === 'safe'
        ? { ok: false, reason: `${label} — this campaign takes verified addresses only.` }
        : { ok: true, reason: label };
}

export function addMembers(ctx, campaignId, memberType, memberIds) {
    if (!MEMBER_TYPES.includes(memberType)) throw badRequest(`A campaign member is a contact or an account, not "${memberType}".`);
    campaign(ctx, campaignId);

    const table = memberType === 'contact' ? 'contacts' : 'accounts';

    /**
     * The deliverability gate applies to EMAIL campaigns only.
     *
     * A LinkedIn or cold-call campaign has no business rejecting someone for a
     * dead mailbox — the address is irrelevant to how they will be contacted,
     * and gating on it would quietly shrink every non-email campaign to the
     * subset of people who happen to have a verified email.
     */
    const details = campaign(ctx, campaignId);
    const gated = memberType === 'contact' && details.channel === 'email';
    const policy = setting(ctx.workspaceId, 'campaign_email_policy') ?? 'review';
    let added = 0;
    let readded = 0;
    let skipped = 0;
    const missing = [];
    // Accounts that gained a member in THIS call — not `skipped` ones, who
    // were already in the campaign and so already made this move.
    const touchedAccountIds = new Set();
    // Contacts held back for deliverability, reported by reason rather than as
    // a bare number — "12 were not added" with no explanation is how people
    // conclude the feature is broken.
    const undeliverable = [];

    for (const memberId of memberIds) {
        // An account has no account_id of its own — the campaign_members row
        // for an account member uses the account's own id for that column
        // (below), never a lookup, so nothing here needs to select it.
        const columns = memberType === 'contact'
            ? 'id, account_id, full_name, first_name, last_name, email, verification_status'
            : 'id';
        const record = get(`SELECT ${columns} FROM ${table} WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
            [memberId, ctx.workspaceId]);
        if (!record) { missing.push(memberId); continue; }

        if (gated) {
            const verdict = canEnrol(record, policy);
            if (!verdict.ok) {
                undeliverable.push({
                    id: record.id,
                    name: record.full_name || [record.first_name, record.last_name].filter(Boolean).join(' ') || record.email,
                    email: record.email,
                    status: record.verification_status,
                    reason: verdict.reason,
                });
                continue;
            }
        }

        const existing = get(
            'SELECT * FROM campaign_members WHERE campaign_id = ? AND member_type = ? AND member_id = ?',
            [campaignId, memberType, memberId],
        );
        if (existing) {
            // Previously removed and now added back: clear the removal, keep the
            // original added_at. The first contact date is the one that matters.
            if (existing.removed_at) {
                run('UPDATE campaign_members SET removed_at = NULL WHERE id = ?', [existing.id]);
                readded += 1;
                if (memberType === 'account') touchedAccountIds.add(memberId);
                else if (record.account_id) touchedAccountIds.add(record.account_id);
            } else {
                skipped += 1;
            }
            continue;
        }

        run(
            `INSERT INTO campaign_members (id, workspace_id, campaign_id, member_type, member_id, account_id, status, added_at, added_by)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [
                id('cmm'), ctx.workspaceId, campaignId, memberType, memberId,
                memberType === 'account' ? memberId : record.account_id ?? null,
                'targeted', now(), ctx.userId,
            ],
        );
        added += 1;
        if (memberType === 'account') touchedAccountIds.add(memberId);
        else if (record.account_id) touchedAccountIds.add(record.account_id);
    }

    /**
     * Being targeted by a campaign is the pipeline's first stage — the
     * account is now IN a push, whether or not anyone has reached them yet.
     * Forward-only: a company already further along (someone answered, a
     * proposal is out) does not lose ground for being swept into another
     * list. "Contacted" (above, `setMemberStatus`) is the stronger signal
     * and moves the deal on its own; this only ever catches a deal that
     * hasn't started.
     */
    for (const accountId of touchedAccountIds) {
        // The campaign's own service, not left blank — a deal with no
        // service can never be classified recurring or one-time, and
        // stays 0 in every value tile even once a price is added, per
        // dealValuesFor. The campaign is FOR a specific service; the deal
        // it opens should say which one from the start.
        const deal = ensureDealForAccount(ctx, accountId, 'added to a campaign', details.service_line_key ?? null);
        if (deal) advanceDealToStage(ctx, deal.id, 'in_campaign', 'added to a campaign');
    }

    return { added, readded, skipped, missing, undeliverable, policy };
}

/** Removal is a timestamp, never a delete — see rule 2 at the top of this file. */
export function removeMembers(ctx, campaignId, memberType, memberIds) {
    campaign(ctx, campaignId);
    let removed = 0;
    for (const memberId of memberIds) {
        const result = run(
            'UPDATE campaign_members SET removed_at = ? WHERE campaign_id = ? AND member_type = ? AND member_id = ? AND removed_at IS NULL',
            [now(), campaignId, memberType, memberId],
        );
        removed += result.changes ?? 0;
    }
    return { removed };
}

export function setMemberStatus(ctx, campaignId, memberType, memberIds, status) {
    if (!MEMBER_STATUSES.includes(status)) {
        throw badRequest(`Member status must be one of: ${MEMBER_STATUSES.join(', ')}.`);
    }
    const details = campaign(ctx, campaignId);
    let updated = 0;
    for (const memberId of memberIds) {
        const result = run(
            'UPDATE campaign_members SET status = ? WHERE campaign_id = ? AND member_type = ? AND member_id = ?',
            [status, campaignId, memberType, memberId],
        );
        updated += result.changes ?? 0;
    }

    /**
     * A member worked in the campaign is a company IN the commercial pipeline.
     *
     * Marking a contact Contacted is the first act of selling to them, so their
     * account's deal (found or created — one per account) moves to the
     * `in_campaign` stage, and the pipeline reads the same thing the campaign
     * does. Other statuses are bookkeeping and change nothing.
     */
    if (status === 'contacted' && memberType === 'contact') {
        const accountIds = all(
            `SELECT DISTINCT account_id FROM contacts
              WHERE id IN (${memberIds.map(() => '?').join(',')}) AND workspace_id = ? AND account_id IS NOT NULL`,
            [...memberIds, ctx.workspaceId],
        ).map((r) => r.account_id);
        for (const accountId of accountIds) {
            const deal = ensureDealForAccount(ctx, accountId, 'a campaign contact was contacted', details.service_line_key ?? null);
            if (deal) moveDealToStage(ctx, deal.id, 'in_campaign', 'a campaign contact was contacted');
        }
    }
    return { updated, status };
}

export function members(ctx, campaignId, { memberType = null, status = null, includeRemoved = false, limit = 200, page = 1 } = {}) {
    const where = ['m.campaign_id = ?', 'm.workspace_id = ?'];
    const params = [campaignId, ctx.workspaceId];
    if (memberType) { where.push('m.member_type = ?'); params.push(memberType); }
    if (status) { where.push('m.status = ?'); params.push(status); }
    if (!includeRemoved) where.push('m.removed_at IS NULL');

    const whereSql = where.join(' AND ');
    const total = get(`SELECT COUNT(*) n FROM campaign_members m WHERE ${whereSql}`, params).n;
    const rows = all(
        `SELECT m.*,
                COALESCE(c.first_name || ' ' || c.last_name, a.name) AS member_name,
                c.email AS member_email, c.title AS member_title,
                acc.name AS account_name
           FROM campaign_members m
           LEFT JOIN contacts c ON m.member_type = 'contact' AND c.id = m.member_id AND c.deleted_at IS NULL
           LEFT JOIN accounts  a ON m.member_type = 'account' AND a.id = m.member_id AND a.deleted_at IS NULL
           LEFT JOIN accounts  acc ON acc.id = m.account_id AND acc.deleted_at IS NULL
          WHERE ${whereSql}
          ORDER BY m.added_at DESC
          LIMIT ? OFFSET ?`,
        [...params, Math.min(500, limit), (Math.max(1, page) - 1) * limit],
    );
    return { members: rows.map((r) => ({ ...r, member_name: String(r.member_name ?? '').trim() || r.member_id })), total, page, limit };
}

/** The campaigns one contact or account belongs to. Shown on the record page. */
export function membershipsFor(ctx, memberType, memberId) {
    return all(
        `SELECT m.*, c.name AS campaign_name, c.status AS campaign_status, c.channel
           FROM campaign_members m
           JOIN campaigns c ON c.id = m.campaign_id
          WHERE m.workspace_id = ? AND m.member_type = ? AND m.member_id = ?
          ORDER BY m.added_at DESC`,
        [ctx.workspaceId, memberType, memberId],
    );
}

/* ------------------------------------------------------------ attribution -- */

/**
 * Membership counts and attributed deal value, for many campaigns at once.
 *
 * Bulk by design: the campaign list renders these columns for every row, and a
 * per-row query would make a 50-row page 150 queries.
 */
export function rollupFor(campaignIds, { baseCurrency = 'USD' } = {}) {
    const out = new Map();
    if (!campaignIds.length) return out;
    const placeholders = campaignIds.map(() => '?').join(',');

    for (const campaignId of campaignIds) {
        out.set(campaignId, {
            member_count: 0, member_contacts: 0, member_accounts: 0,
            members_by_status: {},
            // Outreach counters — live on the membership, cheap to roll up here,
            // expensive anywhere else.
            outreach_sent: 0, outreach_replied: 0, outreach_bounced: 0,
            outreach_unsubscribed: 0,
            deal_count: 0, won_count: 0, open_count: 0,
            influenced_one_time: 0, influenced_mrr: 0,
            open_one_time: 0, open_mrr: 0,
            currency: baseCurrency,
        });
    }

    for (const row of all(
        `SELECT campaign_id, member_type, status, COUNT(*) AS n
           FROM campaign_members
          WHERE campaign_id IN (${placeholders}) AND removed_at IS NULL
          GROUP BY campaign_id, member_type, status`,
        campaignIds,
    )) {
        const bucket = out.get(row.campaign_id);
        if (!bucket) continue;
        bucket.member_count += row.n;
        if (row.member_type === 'contact') bucket.member_contacts += row.n;
        else bucket.member_accounts += row.n;
        bucket.members_by_status[row.status] = (bucket.members_by_status[row.status] ?? 0) + row.n;
    }

    // Outreach reachability — counters kept on the membership, same reason
    // calling_assignments keeps call_count there (one query, not one per row).
    for (const row of all(
        `SELECT campaign_id,
                COALESCE(SUM(total_emails_sent), 0) AS sent,
                COALESCE(SUM(total_replies), 0) AS replied,
                SUM(CASE WHEN bounced_at IS NOT NULL THEN 1 ELSE 0 END) AS bounced,
                SUM(CASE WHEN unsubscribed_at IS NOT NULL THEN 1 ELSE 0 END) AS unsubbed
           FROM campaign_members
          WHERE campaign_id IN (${placeholders}) AND removed_at IS NULL
          GROUP BY campaign_id`,
        campaignIds,
    )) {
        const bucket = out.get(row.campaign_id);
        if (!bucket) continue;
        bucket.outreach_sent = row.sent;
        bucket.outreach_replied = row.replied;
        bucket.outreach_bounced = row.bounced;
        bucket.outreach_unsubscribed = row.unsubbed;
    }

    // Deal value comes from LINE ITEMS, never from a column on the deal — the
    // deal deliberately has no amount. Same derivation as everywhere else, so a
    // campaign report and a deal page can never disagree.
    const deals = all(
        `SELECT d.id, d.campaign_id, d.status, d.probability, s.probability AS stage_probability
           FROM deals d
           LEFT JOIN stages s ON s.id = d.stage_id
          WHERE d.campaign_id IN (${placeholders}) AND d.deleted_at IS NULL`,
        campaignIds,
    );
    if (deals.length) {
        const items = all(
            `SELECT * FROM deal_line_items WHERE deal_id IN (${deals.map(() => '?').join(',')}) ORDER BY position`,
            deals.map((d) => d.id),
        );
        const byDeal = new Map();
        for (const item of items) {
            if (!byDeal.has(item.deal_id)) byDeal.set(item.deal_id, []);
            byDeal.get(item.deal_id).push(item);
        }
        for (const deal of deals) {
            const bucket = out.get(deal.campaign_id);
            if (!bucket) continue;
            const values = deriveValues(byDeal.get(deal.id) ?? [], {
                probability: deal.probability ?? deal.stage_probability ?? 0,
                baseCurrency,
            });
            bucket.deal_count += 1;
            if (deal.status === 'won') {
                bucket.won_count += 1;
                bucket.influenced_one_time += values.value_one_time;
                bucket.influenced_mrr += values.value_mrr;
            } else if (deal.status === 'open') {
                bucket.open_count += 1;
                bucket.open_one_time += values.value_one_time;
                bucket.open_mrr += values.value_mrr;
            }
        }
    }

    return out;
}

/**
 * The performance panel for one campaign.
 *
 * Every figure states what it counts. `costPerMember` and `costPerWonDeal` are
 * offered; a single "ROI" number is NOT, because it would have to divide by a
 * blended revenue figure that mixes a one-time fee with a monthly retainer —
 * the exact sum this codebase refuses to make anywhere else.
 */
export function performance(ctx, campaignId) {
    const row = campaign(ctx, campaignId);
    const rollup = rollupFor([campaignId], { baseCurrency: ctx.workspace?.baseCurrency ?? 'USD' }).get(campaignId);

    const funnel = MEMBER_STATUSES.map((status) => ({
        status,
        count: rollup.members_by_status[status] ?? 0,
    }));

    const budget = row.budget_amount ?? null;
    return {
        campaign: row,
        ...rollup,
        funnel,
        budget,
        costPerMember: budget && rollup.member_count ? budget / rollup.member_count : null,
        costPerWonDeal: budget && rollup.won_count ? budget / rollup.won_count : null,
        // Said out loud rather than left for the reader to infer from two
        // adjacent numbers.
        note: 'One-time and recurring revenue are reported separately and never added together. '
            + 'A placement fee and 24 months of retainer are two different things.',
    };
}

/**
 * Removed members are still counted in `reach`, deliberately.
 *
 * "How many people did this campaign touch" and "how many are on the list right
 * now" are different questions, and a campaign report that answers the second
 * while being read as the first understates every finished campaign.
 */
export function reach(campaignId) {
    return get(
        'SELECT COUNT(*) n FROM campaign_members WHERE campaign_id = ?',
        [campaignId],
    ).n;
}
