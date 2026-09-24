/**
 * The notification bell — one implementation, two shells.
 *
 * ── WHY THIS EXISTS AS A MODULE ─────────────────────────────────────────────
 * The CRM topbar had a bell; the SDR's calling workspace (a separate shell,
 * because a confined role cannot boot the CRM one) had none, so half the team
 * had no way to learn anything had happened. The badge logic, the panel and
 * the mark-read flow now live here once and mount wherever a header is.
 *
 * ── THE POLLING ─────────────────────────────────────────────────────────────
 * The count used to be read ONCE when the shell built and never again, so a
 * notification that arrived while you were working did not exist until a full
 * reload — which reads as "notifications are broken". A small GET every 45s
 * (and on tab focus) keeps the badge honest at a cost that rounds to zero.
 */
import { h, modal, relative } from './core.js';
import { api } from './api.js';

const POLL_MS = 45_000;

/**
 * One tick, synthesized — no audio file to fetch, host or fail to load,
 * matching the zero-dependency rule the rest of this product holds to.
 *
 * As simple as a notification sound gets: a single sine tone, gone in
 * under a twentieth of a second. No layering, no noise burst — one pure,
 * short note read as a tick, not a beep or an alarm.
 *
 * Muted by a browser that has not seen a user gesture yet (autoplay policy)
 * — that throw is swallowed, silently, on purpose: a notification sound
 * that occasionally cannot play is normal browser behaviour, not a bug to
 * surface.
 */
let audioCtx = null;
function playChime() {
    try {
        audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
        const ctx = audioCtx;
        const now = ctx.currentTime;
        const duration = 0.045;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1800, now);
        gain.gain.setValueAtTime(0.4, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + duration);
    } catch { /* autoplay blocked, or no Web Audio — the badge still updates */ }
}

export function createNotificationBell() {
    let badgeText = '';
    // null until the first successful read — the very first poll on page
    // load must not chime for notifications that were already sitting there
    // before this tab even opened.
    let lastUnread = null;
    const bell = h('button.btn.ghost.icon', {
        title: 'Notifications',
        'aria-label': `Notifications${badgeText ? ` — ${badgeText} unread` : ''}`,
        onclick: openFromBell,
    }, '🔔');
    const badge = h('span.badge.danger.xs', { style: { display: 'none' } });
    const el = h('div.row', { style: { gap: '0.15rem', alignItems: 'center' } }, bell, badge);

    let timer = null;

    async function refresh() {
        try {
            const { unread } = await api.get('/api/notifications?unread=1');
            // A rise in the unread count is a NEW notification having landed
            // since the last poll — the only moment worth a sound. Reading
            // (which lowers the count) or a flat count between polls must
            // stay silent, or every 45s tick would chime for nothing.
            if (lastUnread !== null && unread > lastUnread) playChime();
            lastUnread = unread;
            badge.textContent = unread > 99 ? '99+' : String(unread);
            badge.style.display = unread ? 'inline-flex' : 'none';
            // The accessible name tracks the state, not just the icon.
            badgeText = unread > 0 ? String(unread) : '';
            bell.setAttribute('aria-label', `Notifications${badgeText ? ` — ${badgeText} unread` : ''}`);
        } catch {
            // An unreachable server must not turn the bell into an error lamp.
            badge.style.display = 'none';
        }
    }

    function startPolling() {
        refresh();
        if (timer) clearInterval(timer);
        timer = setInterval(refresh, POLL_MS);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) refresh();
        });
    }

    // Opening the panel and closing it both re-read the count, so what the
    // badge says can never be older than the last time you looked at it.
    function openFromBell() {
        return openPanel().finally(refresh);
    }

    return { el, refresh, startPolling };
}

/**
 * READING IS MARKING READ.
 *
 * Clicking a notification is the act of having seen it; leaving it glowing
 * unread afterwards is how a badge ends up permanently showing 4. An unread
 * row marks itself read the moment it is clicked (the API takes explicit ids,
 * so nothing else in the list is touched), then the panel closes — the Open
 * link inside navigates through the normal router on its way out. Read rows
 * are not clickable again; there is nothing left to do to them here.
 */
export async function openPanel() {
    let data;
    try {
        data = await api.get('/api/notifications');
    } catch (err) {
        const { toast } = await import('./core.js');
        return toast(err.message, 'error');
    }

    const markRead = async (n) => {
        if (n.read_at) return;
        n.read_at = new Date().toISOString();
        try { await api.post('/api/notifications/read', { ids: [n.id] }); } catch { /* best-effort */ }
    };

    const { navigate } = await import('./core.js');

    await modal({
        title: 'Notifications',
        size: 'wide',
        body: (close) => h('div.stack',
            data.notifications.length === 0
                ? h('div.empty',
                    h('p', 'Nothing to catch up on.'),
                    h('p.xs.dim', 'You are notified about work that lands on YOU — queue assignments, follow-up tasks, meetings booked, replies, approvals. Actions you take yourself do not ring your own bell.'))
                : h('div.stack.tight', data.notifications.map((n) => h('div.row', {
                    class: n.read_at ? 'dim' : '',
                    style: {
                        alignItems: 'flex-start', gap: 'var(--space-3)',
                        cursor: n.read_at ? 'default' : 'pointer',
                    },
                    onclick: () => { markRead(n); close(true); if (n.link) navigate(n.link); },
                },
                h('span', n.read_at ? '·' : '●'),
                h('div', { style: { minInlineSize: 0 } },
                    h('div.small.strong', n.title),
                    n.body && h('div.xs.dim', n.body),
                    n.link && h('span.xs', { style: { color: 'var(--color-accent)' } }, 'Open'),
                ),
                h('div.spacer'),
                h('span.xs.dim', relative(n.created_at)),
                ))),
        ),
        footer: (close) => [
            data.unread > 0 && h('button.btn', {
                onclick: async () => {
                    await api.post('/api/notifications/read', {});
                    close(true);
                },
            }, `Mark ${data.unread} as read`),
            h('div.spacer'),
            h('button.btn.primary', { onclick: () => close(true) }, 'Close'),
        ],
    });

    return undefined;
}
