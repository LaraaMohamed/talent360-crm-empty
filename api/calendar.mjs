/**
 * The CRM calendar — renewal dates and scheduled meetings, in one month
 * view. Not a generic events system: these are the two dates this product
 * already tracks that a person needs to see laid out on a calendar rather
 * than read off a list (lib/renewals.mjs's dashboard widget and /renewals
 * already cover "what's coming up as a list" — this is the same facts,
 * placed on the day they fall).
 */
import { all } from '../lib/db.mjs';
import { badRequest } from '../lib/http.mjs';
import { noticeDateFor } from '../lib/renewals.mjs';

/** `YYYY-MM` -> the first and last calendar day of that month, as ISO dates. */
function monthBounds(monthParam) {
    const m = /^(\d{4})-(\d{2})$/.exec(monthParam ?? '');
    if (!m) throw badRequest('Give a month as YYYY-MM.');
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12) throw badRequest('That is not a real month.');
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0));
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export async function calendar({ url, ctx }) {
    const { start, end } = monthBounds(url.searchParams.get('month'));

    const renewalRows = all(
        `SELECT a.id, a.number, a.title, a.expiry_date, a.notice_days, a.account_id, ac.name AS account_name
           FROM agreements a JOIN accounts ac ON ac.id = a.account_id
          WHERE a.workspace_id = ? AND a.deleted_at IS NULL AND a.status = 'signed'
            AND a.expiry_date IS NOT NULL AND a.expiry_date BETWEEN ? AND ?`,
        [ctx.workspaceId, start, end],
    );

    const meetingRows = all(
        `SELECT act.id, act.subject, act.meeting_at, act.meeting_status, act.account_id, act.parent_type, act.parent_id,
                ac.name AS account_name
           FROM activities act LEFT JOIN accounts ac ON ac.id = act.account_id
          WHERE act.workspace_id = ? AND act.deleted_at IS NULL AND act.meeting_at IS NOT NULL
            AND date(act.meeting_at) BETWEEN ? AND ?`,
        [ctx.workspaceId, start, end],
    );

    const events = [
        ...renewalRows.map((r) => ({
            id: `renewal:${r.id}`, kind: 'renewal', date: r.expiry_date,
            title: `${r.account_name} — ${r.title || r.number} renewal`,
            link: `/agreements/${r.id}`, accountId: r.account_id,
            // The notice date is when the window OPENS, not a deadline — see
            // api/proposals.mjs's renewals() for the fuller explanation.
            detail: `Notice window opens ${noticeDateFor(r, ctx.workspaceId)}`,
        })),
        ...meetingRows.map((m) => ({
            id: `meeting:${m.id}`, kind: 'meeting', date: String(m.meeting_at).slice(0, 10),
            title: m.subject || (m.account_name ? `Meeting — ${m.account_name}` : 'Meeting'),
            link: m.parent_type === 'contact' ? `/contacts/${m.parent_id}` : (m.account_id ? `/accounts/${m.account_id}` : null),
            accountId: m.account_id, status: m.meeting_status,
        })),
    ].sort((a, b) => a.date.localeCompare(b.date));

    return { month: url.searchParams.get('month'), start, end, events };
}
