/**
 * Renewal automation: the notice-window sweep, and the status a person reads.
 *
 * ── THE ONE RULE ─────────────────────────────────────────────────────────────
 *
 *   IF the agreement is signed, has an expiry date, has not been renewed or
 *   terminated, AND today >= expiry - notice window
 *   THEN raise exactly one renewal task and exactly one notification for this
 *   agreement's current expiry cycle.
 *
 * "Exactly one" is the hard part. `agreements.renewal_notice_sent_at` plus
 * `renewal_notice_expiry` (lib/db.mjs COLUMN_MIGRATIONS) is the marker: set
 * together, cleared automatically the moment the expiry date itself changes
 * (a renewed or amended contract is a new cycle, not a continuation), and
 * checked before anything is written. A defensive query for an existing open
 * task backs the marker up — belt and suspenders, not two competing sources
 * of truth.
 *
 * ── WHY THIS FILE, AND NOT A REQUEST HANDLER ────────────────────────────────
 *
 * The whole point is that it runs whether or not anyone has the CRM open.
 * `server.mjs` wires `sweepAllWorkspaces` into the same kind of `setInterval`
 * that already drives the Smartlead sync — see the comment there for why that
 * is the one scheduling mechanism this product has.
 */
import { all, get, run, id, now } from './db.mjs';
import { audit } from './repo.mjs';
import { setting } from './settings.mjs';
import { notifyTaskAssigned, notifyAgreementRenewalDue } from './notify.mjs';

/** ISO date, `days` away from `dateStr` (negative goes backwards). */
function addDays(dateStr, days) {
    const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

function daysBetween(fromStr, toStr) {
    const from = new Date(`${String(fromStr).slice(0, 10)}T00:00:00Z`).getTime();
    const to = new Date(`${String(toStr).slice(0, 10)}T00:00:00Z`).getTime();
    return Math.round((to - from) / 864e5);
}

/**
 * The exact date the notice window opens: expiry minus notice days.
 *
 * An agreement's own `notice_days` wins over the workspace default — a
 * negotiated notice period is a fact about that contract, not a preference.
 */
export function noticeDateFor(agreement, workspaceId) {
    if (!agreement.expiry_date) return null;
    const noticeDays = Number.isFinite(Number(agreement.notice_days)) && agreement.notice_days !== null && agreement.notice_days !== ''
        ? Number(agreement.notice_days)
        : Number(setting(workspaceId, 'default_renewal_notice_days')) || 45;
    return addDays(agreement.expiry_date, -noticeDays);
}

/**
 * The label a person reads: Upcoming | Notice Due | Renewal In Progress |
 * Renewed | Expiring | Expired | Terminated.
 *
 * `hasOpenRenewalTask` is optional — callers showing a single record (the
 * Agreement page, the Account's Customer section) pass the real answer;
 * bulk callers (a list, the dashboard) can omit it and get "Notice Due"
 * rather than "Renewal In Progress", which is a fair simplification and not
 * a wrong one — both mean the same clock has started.
 */
export function renewalStatus(agreement, { workspaceId, today = null, hasOpenRenewalTask = false, wasRenewed = false } = {}) {
    if (agreement.status === 'terminated') return 'terminated';
    if (wasRenewed) return 'renewed';
    if (agreement.status === 'expired') return 'expired';
    if (agreement.status !== 'signed') return 'upcoming';
    if (!agreement.expiry_date) return 'upcoming';
    // Not meant to renew — never enters the notice states, however close
    // the expiry date gets.
    if (agreement.renewable === 0 || agreement.renewable === false) return 'upcoming';

    const now_ = today ?? new Date().toISOString().slice(0, 10);
    const daysToExpiry = daysBetween(now_, agreement.expiry_date);
    if (daysToExpiry < 0) return 'expiring';

    const noticeDate = noticeDateFor(agreement, workspaceId);
    if (noticeDate && now_ >= noticeDate) return hasOpenRenewalTask ? 'renewal_in_progress' : 'notice_due';
    return 'upcoming';
}

export const RENEWAL_STATUS_LABELS = {
    upcoming: 'Active',
    notice_due: 'Renewal notice due',
    renewal_in_progress: 'Renewal in progress',
    renewed: 'Renewed',
    expiring: 'Expiring',
    expired: 'Expired',
    terminated: 'Terminated',
};

/**
 * Whether THIS agreement was itself renewed — a later agreement points back
 * at it through `supersedes_agreement_id`. One query, reusable everywhere the
 * status above needs it.
 */
export function wasRenewedInto(workspaceId, agreementId) {
    return !!get(
        'SELECT id FROM agreements WHERE workspace_id = ? AND supersedes_agreement_id = ? AND deleted_at IS NULL',
        [workspaceId, agreementId],
    );
}

/**
 * One workspace's sweep: every signed, dated, un-renewed, un-terminated
 * agreement past its notice window gets exactly one task and one
 * notification, addressed to the account or deal owner.
 */
export function sweepRenewals(workspaceId) {
    const today = new Date().toISOString().slice(0, 10);
    const ctx = { workspaceId, userId: null };

    const rows = all(
        `SELECT a.*, ac.name AS account_name, ac.owner_id AS account_owner_id, d.owner_id AS deal_owner_id, d.name AS deal_name
           FROM agreements a
           JOIN accounts ac ON ac.id = a.account_id
      LEFT JOIN deals d ON d.id = a.deal_id
          WHERE a.workspace_id = ? AND a.deleted_at IS NULL AND a.status = 'signed' AND a.expiry_date IS NOT NULL`,
        [workspaceId],
    );

    let created = 0;
    for (const a of rows) {
        // Not meant to renew at all — a fixed-term engagement ending for
        // good. No notice, no task, ever, for this agreement. Unset
        // (never explicitly turned off) defaults to renewable, matching
        // `renewalStatus` below and the field's own `default: true` — an
        // agreement created before this field existed, or through any path
        // that never touched it, must not silently stop raising notices.
        if (a.renewable === 0 || a.renewable === false) continue;

        // A cycle already handled, for THIS expiry date. A changed expiry
        // date (renewed, amended) makes this comparison fail on its own —
        // no separate reset step needed.
        if (a.renewal_notice_sent_at && a.renewal_notice_expiry === a.expiry_date) continue;

        const noticeDate = noticeDateFor(a, workspaceId);
        if (!noticeDate || today < noticeDate) continue;

        // Renewed already (a later agreement supersedes this one) — the
        // decision was made, so the clock stops without a task ever firing.
        if (wasRenewedInto(workspaceId, a.id)) continue;

        // Defensive: an open renewal task already exists for this agreement
        // (e.g. a previous sweep wrote the task but died before stamping the
        // marker). Stamp and move on rather than raising a second one.
        const existingTask = get(
            `SELECT id FROM tasks WHERE workspace_id = ? AND parent_type = 'agreement' AND parent_id = ?
               AND status IN ('open','in_progress') AND deleted_at IS NULL
               AND json_extract(properties, '$.renewal.kind') = 'notice_due' LIMIT 1`,
            [workspaceId, a.id],
        );
        const stamp = now();
        if (!existingTask) {
            const ownerId = a.account_owner_id ?? a.deal_owner_id ?? null;
            const taskId = id('tsk');
            const title = `Renewal: ${a.deal_name ?? a.account_name}`;
            run(
                `INSERT INTO tasks
                   (id, workspace_id, parent_type, parent_id, account_id, title, description,
                    assignee_id, due_at, priority, status, properties, created_by, created_at, updated_at)
                 VALUES (?,?,'agreement',?,?,?,?,?,?,?,'open',?,?,?,?)`,
                [
                    taskId, workspaceId, a.id, a.account_id,
                    title,
                    `Agreement ${a.number} (${a.account_name}) expires ${a.expiry_date}. Renewal notice reached.`,
                    ownerId, noticeDate, 'A',
                    JSON.stringify({ renewal: { kind: 'notice_due', agreement_id: a.id, expiry_date: a.expiry_date } }),
                    null, stamp, stamp,
                ],
            );
            notifyTaskAssigned(ctx, { assigneeId: ownerId, taskId, subject: title, accountName: a.account_name });
            // Both owners, not just whichever the task landed on — the deal
            // owner is running the relationship even when the account itself
            // is owned by someone else (a house account, a team lead's book).
            // A `Set` so the common case of one person owning both sends
            // exactly one notification, not two identical ones.
            const renewalValueLabel = a.contract_value ? `${a.currency ?? ''} ${a.contract_value}`.trim() : null;
            for (const recipientId of new Set([a.account_owner_id, a.deal_owner_id].filter(Boolean))) {
                notifyAgreementRenewalDue(ctx, {
                    ownerId: recipientId,
                    agreementId: a.id,
                    accountName: a.account_name,
                    number: a.number,
                    expiryLabel: a.expiry_date,
                    valueLabel: renewalValueLabel,
                });
            }
            audit(ctx, {
                objectKey: 'agreement', recordId: a.id, accountId: a.account_id,
                action: 'renewal_notice_raised', source: 'automation',
                after: { taskId, noticeDate, expiryDate: a.expiry_date },
            });
            created += 1;
        }
        run(
            'UPDATE agreements SET renewal_notice_sent_at = ?, renewal_notice_expiry = ? WHERE id = ?',
            [stamp, a.expiry_date, a.id],
        );
    }
    return { workspaceId, checked: rows.length, created };
}

export function sweepAllWorkspaces() {
    const workspaces = all('SELECT id FROM workspaces');
    return workspaces.map((w) => sweepRenewals(w.id));
}
