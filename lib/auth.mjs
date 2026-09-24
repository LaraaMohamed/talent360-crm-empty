/**
 * Authentication and permissions.
 *
 * Passwords: scrypt with a per-user salt, compared in constant time.
 * Sessions:  an opaque random token in an HttpOnly SameSite=Strict cookie; only
 *            its SHA-256 lands in the database, so a leaked database backup
 *            cannot be replayed as a login.
 * API keys:  the same idea for a caller with no browser — an `X-Api-Key`
 *            header instead of a cookie, resolved by `contextForApiKey`
 *            rather than `sessionFor`. See "api keys" below.
 * Roles:     carried by the MEMBERSHIP, never by the user (docs/03 §2).
 */
import crypto from 'node:crypto';
import { all, get, run, id, now, bind } from './db.mjs';
import { unauthorized, forbidden, badRequest, conflict, notFound, tooManyRequests } from './http.mjs';

export const COOKIE = 'crm_session';
const SESSION_DAYS = 14;

/**
 * Login attempts are rate-limited in-process, in memory.
 *
 * This is a single Node process — the same assumption server.mjs already
 * makes for its three background sweeps — so an in-memory map is enough
 * without reaching for a shared store. It fully stops the common case (one
 * attacker guessing against one running instance); if this CRM is ever scaled
 * to more than one instance, a distributed attacker could spread attempts
 * across them, the same limit the sweeps' *_DISABLED env vars already exist
 * to manage for that scenario.
 *
 * Two keys, not one: by email, so nobody can grind through one account's
 * password no matter how many addresses they call from; by IP, so nobody can
 * spray short passwords across many accounts from one address without also
 * getting rate-limited, even though each individual account's own counter
 * stays low.
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_EMAIL = 5;
const MAX_FAILURES_PER_IP = 20;

const loginFailures = new Map();

function checkNotLocked(key) {
    const entry = loginFailures.get(key);
    if (entry?.lockedUntil && entry.lockedUntil > Date.now()) {
        const minutes = Math.ceil((entry.lockedUntil - Date.now()) / 60000);
        throw tooManyRequests(`Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    }
}

function recordLoginFailure(key, max) {
    const at = Date.now();
    let entry = loginFailures.get(key);
    if (!entry || entry.firstAt + LOGIN_WINDOW_MS < at) entry = { count: 0, firstAt: at, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= max) entry.lockedUntil = at + LOGIN_LOCKOUT_MS;
    loginFailures.set(key, entry);

    // Opportunistic cleanup, so a long-idle map does not grow without bound —
    // cheap enough at this scale to run inline rather than on its own timer.
    if (loginFailures.size > 500) {
        for (const [k, e] of loginFailures) {
            if (e.lockedUntil < at && e.firstAt + LOGIN_WINDOW_MS < at) loginFailures.delete(k);
        }
    }
}

function clearLoginFailures(key) {
    loginFailures.delete(key);
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
    const [scheme, N, r, p, salt, key] = String(stored ?? '').split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(key, 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, {
        N: Number(N), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(expected, actual);
}

/* --------------------------------------------------------------- accounts -- */

export function createUser({ email, name, password, role = 'rep', workspaceId, team = null }) {
    const clean = String(email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw badRequest('Enter a valid email address.');
    assertPasswordAcceptable(password);
    if (get('SELECT id FROM users WHERE email = ?', [clean])) {
        throw conflict('An account with that email already exists.');
    }

    const userId = id('usr');
    run(
        'INSERT INTO users (id, email, name, password_hash, status, created_at) VALUES (?,?,?,?,?,?)',
        [userId, clean, String(name ?? '').trim() || clean, hashPassword(password), 'active', now()],
    );
    if (workspaceId) {
        run(
            'INSERT INTO memberships (id, workspace_id, user_id, role, team, created_at) VALUES (?,?,?,?,?,?)',
            [id('mem'), workspaceId, userId, role, bind(team), now()],
        );
    }
    return get('SELECT id, email, name, status, created_at FROM users WHERE id = ?', [userId]);
}

export function login({ email, password, userAgent, ip }) {
    const clean = String(email ?? '').trim().toLowerCase();
    const emailKey = `email:${clean}`;
    const ipKey = ip ? `ip:${ip}` : null;

    checkNotLocked(emailKey);
    if (ipKey) checkNotLocked(ipKey);

    const user = get('SELECT * FROM users WHERE email = ?', [clean]);
    // Same message and roughly the same work for "no such user" and "wrong
    // password", so the response cannot be used to enumerate accounts.
    const ok = user
        ? verifyPassword(String(password ?? ''), user.password_hash)
        : verifyPassword(String(password ?? ''), hashPassword('decoy-value-never-matches'));
    if (!user || !ok) {
        recordLoginFailure(emailKey, MAX_FAILURES_PER_EMAIL);
        if (ipKey) recordLoginFailure(ipKey, MAX_FAILURES_PER_IP);
        throw unauthorized('That email and password do not match.');
    }
    if (user.status !== 'active') throw forbidden('That account has been deactivated.');

    clearLoginFailures(emailKey);
    if (ipKey) clearLoginFailures(ipKey);

    const membership = get('SELECT * FROM memberships WHERE user_id = ? ORDER BY created_at LIMIT 1', [user.id]);
    if (!membership) throw forbidden('That account is not a member of any workspace.');

    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
    run(
        'INSERT INTO sessions (id, user_id, workspace_id, created_at, expires_at, user_agent) VALUES (?,?,?,?,?,?)',
        [tokenHash(token), user.id, membership.workspace_id, now(), expires, bind(userAgent)],
    );
    return { token, maxAge: SESSION_DAYS * 86400, user: publicUser(user), role: membership.role };
}

export function logout(token) {
    if (token) run('DELETE FROM sessions WHERE id = ?', [tokenHash(token)]);
}

/** Resolves a cookie token into the request context, or null. */
export function sessionFor(token) {
    if (!token) return null;
    const row = get(
        `SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.email, u.name, u.status, u.timezone,
                m.workspace_id, m.role, m.team, w.name AS workspace_name, w.base_currency, w.timezone AS ws_timezone,
                w.weekend_days, w.verdict_stale_days, w.locale
           FROM sessions s
           JOIN users u        ON u.id = s.user_id
           JOIN memberships m  ON m.user_id = s.user_id AND m.workspace_id = s.workspace_id
           JOIN workspaces w   ON w.id = s.workspace_id
          WHERE s.id = ?`,
        [tokenHash(token)],
    );
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) {
        run('DELETE FROM sessions WHERE id = ?', [row.session_id]);
        return null;
    }
    if (row.status !== 'active') return null;

    return {
        sessionId: row.session_id,
        userId: row.user_id,
        workspaceId: row.workspace_id,
        role: row.role,
        team: row.team,
        user: { id: row.user_id, email: row.email, name: row.name, timezone: row.timezone },
        workspace: {
            id: row.workspace_id,
            name: row.workspace_name,
            baseCurrency: row.base_currency,
            timezone: row.ws_timezone,
            locale: row.locale,
            weekendDays: JSON.parse(row.weekend_days || '[5,6]'),
            verdictStaleDays: row.verdict_stale_days,
        },
    };
}

function tokenHash(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function publicUser(u) {
    return { id: u.id, email: u.email, name: u.name, timezone: u.timezone };
}

/* ------------------------------------------------------------- passwords -- */

/** How long a reset link is good for. Long enough to hand over, short enough to matter. */
const RESET_HOURS = 24;

/** The minimum, stated once so every path that sets a password agrees. */
export const MIN_PASSWORD_LENGTH = 8;

function assertPasswordAcceptable(password) {
    if (String(password ?? '').length < MIN_PASSWORD_LENGTH) {
        throw badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
}

/**
 * Sets a password and signs that user out everywhere.
 *
 * Revoking the sessions is the point, not a side effect: a password is changed
 * either because it might be known to someone else, or because the person has
 * left. Leaving a fourteen-day cookie alive after either would make the change
 * cosmetic. The person changing their own password gets a fresh session from
 * the caller so they are not bounced to the login screen for doing the right
 * thing.
 */
export function setPassword(userId, password) {
    assertPasswordAcceptable(password);
    const user = get('SELECT id FROM users WHERE id = ?', [userId]);
    if (!user) throw notFound('That user does not exist.');
    run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(password), userId]);
    const revoked = all('SELECT id FROM sessions WHERE user_id = ?', [userId]).length;
    run('DELETE FROM sessions WHERE user_id = ?', [userId]);
    return { revokedSessions: revoked };
}

/** Changing your own password requires proving you know the current one. */
export function changeOwnPassword({ userId, currentPassword, newPassword }) {
    const user = get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) throw notFound('That user does not exist.');
    if (!verifyPassword(String(currentPassword ?? ''), user.password_hash)) {
        throw unauthorized('That is not your current password.');
    }
    return setPassword(userId, newPassword);
}

/**
 * Issues a one-time reset link for someone else.
 *
 * There is no email in this system, so the admin hands the URL over directly.
 * The raw token is returned exactly once and never stored — only its hash is —
 * so a lost link is reissued rather than looked up.
 *
 * Any earlier unused link for that user is expired first. Two live links is two
 * ways in, and the second one is usually issued precisely because the first went
 * astray.
 */
export function issuePasswordReset({ userId, issuedBy }) {
    const user = get('SELECT id, email, name FROM users WHERE id = ?', [userId]);
    if (!user) throw notFound('That user does not exist.');

    run('UPDATE password_resets SET expires_at = ? WHERE user_id = ? AND used_at IS NULL AND expires_at > ?',
        [now(), userId, now()]);

    const token = crypto.randomBytes(32).toString('base64url');
    run(
        'INSERT INTO password_resets (id, user_id, issued_by, created_at, expires_at) VALUES (?,?,?,?,?)',
        [tokenHash(token), userId, bind(issuedBy), now(), new Date(Date.now() + RESET_HOURS * 3600e3).toISOString()],
    );
    return { token, user: publicUser(user), expiresInHours: RESET_HOURS };
}

/**
 * Spends a reset link on a new password.
 *
 * Deliberately vague on failure: an expired link, a used one and a fabricated
 * one all say the same thing, because the difference is only useful to someone
 * guessing.
 */
export function consumePasswordReset({ token, password }) {
    const row = get('SELECT * FROM password_resets WHERE id = ?', [tokenHash(token ?? '')]);
    const valid = row && !row.used_at && new Date(row.expires_at).getTime() > Date.now();
    if (!valid) throw badRequest('That reset link is no longer valid. Ask for a new one.');

    // Checked before the token is spent, so a too-short password does not burn
    // the link and force a second trip to the admin.
    assertPasswordAcceptable(password);

    setPassword(row.user_id, password);
    run('UPDATE password_resets SET used_at = ? WHERE id = ?', [now(), row.id]);
    return { ok: true };
}

export function listMembers(workspaceId) {
    return all(
        `SELECT u.id, u.name, u.email, u.status, m.role, m.team
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = ? ORDER BY u.name`,
        [workspaceId],
    );
}

/**
 * Admin update of a user's profile (name, email) and optionally password.
 *
 * Only owner/admin can call this. The email must be unique across the whole
 * user table (not just the workspace), because login is global.
 */
export function updateUser({ userId, name, email, password }) {
    const user = get('SELECT id, email FROM users WHERE id = ?', [userId]);
    if (!user) throw notFound('That user does not exist.');

    const updates = [];
    const params = [];

    if (name !== undefined) {
        const cleanName = String(name ?? '').trim();
        if (!cleanName) throw badRequest('Name cannot be empty.');
        updates.push('name = ?');
        params.push(cleanName);
    }

    if (email !== undefined) {
        const clean = String(email ?? '').trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw badRequest('Enter a valid email address.');
        if (clean !== user.email) {
            const exists = get('SELECT id FROM users WHERE email = ?', [clean]);
            if (exists) throw conflict('An account with that email already exists.');
        }
        updates.push('email = ?');
        params.push(clean);
    }

    if (password !== undefined) {
        assertPasswordAcceptable(password);
        updates.push('password_hash = ?');
        params.push(hashPassword(password));
    }

    if (!updates.length) return { ok: true, note: 'Nothing to update.' };

    params.push(userId);
    run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);

    return get('SELECT id, email, name, status, created_at FROM users WHERE id = ?', [userId]);
}

/* ----------------------------------------------------------- permissions -- */

/**
 * Capability matrix. Ordered from most to least privileged; a role holds every
 * capability listed for it.
 *
 * `export` is deliberately its own capability rather than implied by `read`.
 * Reading one record on screen and walking out with the whole database as a CSV
 * are different acts, and every serious buyer asks about the second one.
 */
const CAPABILITIES = {
    owner: ['*'],
    admin: ['*'],
    /**
     * `finance.read` is the right to see money, and it stops here.
     *
     * A manager reads commercial analytics; a rep works records and a deal's
     * own figures, but never the aggregate — deal size across the team,
     * pipeline value, revenue. That distinction was previously expressed only
     * by which widgets were listed on which layout, which meant it held right
     * up until somebody requested a different layout by id.
     *
     * Note this is NOT `finance.settings`. Reading a converted total and
     * changing the rate every total on the screen is computed with are two
     * different acts, and only owner and admin do the second.
     */
    manager: [
        'record.read.all', 'record.write.all', 'record.delete',
        'deal.stage.change', 'qualification.run', 'export', 'view.share', 'list.write',
        'proposal.issue', 'agreement.sign', 'member.read', 'finance.read', 'document.approve',
        /**
         * Prospecting is a MANAGER's plane, not a rep's.
         *
         * It holds every company ever uploaded and every verdict computed
         * against one — the sourcing book, not the customer book. A rep works
         * accounts that somebody already decided to work.
         */
        'prospecting.read',
        /**
         * `people_search.use` is the free half of Apollo People Search —
         * search and add-to-CRM, which cost nothing. It says nothing about
         * REVEALING an email or phone, which is billable and stays behind
         * `record.write.all` (below `enrich()` in api/people-search.mjs) —
         * a manager already holds that, a rep does not, and that gap is what
         * makes a rep's reveal go through approval instead. See
         * `people_enrich` in lib/approvals.mjs.
         */
        'people_search.use',
        /**
         * A manager can run the calling floor.
         *
         * They held NEITHER calling capability, while a rep held
         * `calling.manage` — so the role named after managing was the one role
         * that could not open the queue, reassign a lead, or see who was
         * ringing whom. `/api/calling/queue` answered it 403 ("your role
         * cannot calling work"), which reads as a bug in the product rather
         * than as a decision anybody made.
         *
         * `calling.manage` is the wider of the two: it scopes queue reads to
         * everybody rather than to yourself, and it is what `/api/calling/assign`
         * requires. A manager does not get `calling.work` — they are not being
         * handed a queue of their own to grind through.
         */
        'calling.manage',
    ],
    /**
     * A rep DRAFTS documents. `proposal.issue` is what lets them do that, and
     * the name is now half a lie — it opens the door to creating a proposal and
     * submitting it, but issuing the finished version needs the document to
     * have been approved first, which needs `document.approve`, which is not
     * here. Renaming it would break every workspace's stored capability
     * expectations for no gain; the gate that matters is the one it does not
     * hold.
     */
    /**
     * A rep works ACCOUNTS. Neither `prospecting.read` nor `qualification.run`
     * is here, and the pair is deliberate: the first keeps the uploaded-company
     * book out of reach, and the second would otherwise let a rep re-run the
     * rules and read the verdicts back through the account plane — the same
     * data by a different door.
     */
    rep: [
        'record.read.all', 'record.write.own', 'deal.stage.change',
        'view.share', 'list.write', 'proposal.issue', 'member.read',
        /**
         * Search Apollo for people at an account they own, and add what comes
         * back straight to the CRM — both free. Revealing an email or phone
         * is billable and NOT granted by this: a rep lacks `record.write.all`,
         * so `enrich()` still refuses them, and the UI instead lets them
         * submit a reveal for a manager to approve (`people_enrich_requests`,
         * lib/approvals.mjs) rather than spend credits unsupervised.
         */
        'people_search.use',
        /**
         * `calling.work`, not `calling.manage`: a rep's queue is their own,
         * the same as an SDR's. `calling.manage` scopes reads to EVERY SDR's
         * queue and is what lets a manager run the floor — a rep does not
         * run the floor.
         *
         * `calling.assign_own` is separate from `calling.work` on purpose —
         * an SDR holds `calling.work` too (to work the queue they were
         * given) but must never be able to put something ON it themselves;
         * only a rep or a manager decides what an SDR calls. `assignContacts`
         * (lib/calling.mjs) checks this specifically, not `calling.work`, so
         * an SDR stays refused even though both roles share the other one.
         */
        'calling.work', 'calling.assign_own',
    ],
    readonly: ['record.read.all', 'member.read'],

    /**
     * An SDR works a calling queue and nothing else.
     *
     * The important part of this list is what is NOT in it. No
     * `record.read.all`, so every generic `/api/<object>` route refuses them —
     * accounts, contacts, deals, prospecting, the lot — without a single check
     * being added to any of those handlers. Data isolation is the ABSENCE of a
     * capability, not a hidden navigation item, so typing a URL gets a 403 for
     * the same reason the menu does not offer it.
     *
     * They read contact details only through the calling endpoints, which reach
     * a contact by joining through an assignment that names them. There is no
     * query path in the module that can return another SDR's contact.
     */
    // Own-work rights: a confined caller raises and completes their own
    // tasks/notes from My Work (reads stay scoped to themselves separately).
    sdr: ['calling.work', 'member.read', 'record.write.own'],
};

/**
 * Roles confined to a named set of endpoints, and the reason it is a list of
 * what is ALLOWED rather than a set of capability checks.
 *
 * The generic record routes ask for no capability at all — every role that
 * existed before this one held `record.read.all`, so nothing needed to. That
 * made "an SDR simply lacks the capability" a comfortable assumption and a
 * false one: `GET /api/contacts` answered 200 for an SDR, which is the entire
 * contact database.
 *
 * Adding a check to each of the CRM's endpoints would work until somebody adds
 * the eighty-first and forgets, and the cost of forgetting is one SDR reading
 * another's leads — or the whole book. So this is deny-by-default, asked once,
 * in one place: an endpoint invented tomorrow is refused to a confined role
 * until somebody adds it here deliberately.
 */
const CONFINED = {
    sdr: [
        // The session itself, and changing their own password.
        /^GET \/api\/me$/,
        /^POST \/api\/me\/password$/,
        /^POST \/api\/auth\/(login|logout)$/,
        /**
         * The field registry, which their one screen is built out of.
         *
         * The whole UI is metadata-driven: the calling queue's columns, its
         * filter builder and its badges all come from `/api/meta`. Confining
         * the SDR without it left the Columns dialog reporting "0 shown" and
         * "every field is already shown" in the same breath — both true, from
         * an empty registry, and neither of any use.
         *
         * It carries schema and workspace vocabulary — field definitions,
         * stages, service lines, colleagues — and no customer records. The one
         * thing it used to carry that an SDR should not see was the BounceBan
         * key, which is now write-only for everybody.
         */
        /^GET \/api\/meta$/,
        /**
         * Saved views, so an SDR can keep a filter instead of rebuilding it.
         *
         * A view is a stored FILTER, not data — and every one of these handlers
         * already answers the ownership question for itself: you may edit or
         * delete your own, `view.share` is needed to publish one workspace-wide
         * and an SDR does not hold it, and the list only ever returns your own
         * plus what somebody deliberately shared. So this widens what an SDR can
         * SAVE, and not one row of what they can read.
         */
        /^GET \/api\/views$/,
        /^POST \/api\/views$/,
        /^(PATCH|DELETE) \/api\/views\/[^/]+$/,
        // Their calling workspace, which scopes every read to them internally.
        /^(GET|POST|PATCH) \/api\/calling(\/.+)?$/,
        /**
         * MY WORK — the SDR's own tasks, activities and notes.
         *
         * The routes below are the same generic record routes every role uses;
         * what makes them safe for a confined role is the SCOPE the list,
         * read, create and status-update handlers force onto them: a confined
         * caller only ever sees rows where they are the assignee, actor or
         * author (see `ownScopeObject` in api/records.mjs). No other record
         * becomes reachable, and no query runs without that scope.
         */
        /^GET \/api\/tasks(\/|$)/,
        /^(PATCH|POST) \/api\/tasks\/[^/]+$/,
        // Creating their OWN work is part of My Work: a confined caller may
        // raise a task or a note (the write paths stamp them as author), they
        // just cannot see anybody else's rows afterwards.
        /^POST \/api\/tasks$/,
        /^POST \/api\/notes$/,
        /^GET \/api\/activities(\/|$)/,
        /^GET \/api\/notes(\/|$)/,
        // Lists, so My Work can boot — the page() shell loads them eagerly.
        /^GET \/api\/lists$/,
        /^GET \/api\/notifications/,
        /^POST \/api\/notifications\/read$/,
        /**
         * MEETINGS — the ones this SDR booked off their own calls.
         *
         * These look like the same routes a manager uses to run the whole
         * team's book. What makes them safe for a confined role is
         * `list()` and `settle()` in api/meetings.mjs forcing the scope to
         * their own userId whenever `ctx.role === 'sdr'` — the same shape
         * as the tasks/notes scope above, just enforced in the meetings
         * handler instead of `ownScopeObject`.
         */
        /^GET \/api\/meetings$/,
        /^GET \/api\/meetings\/meta$/,
        /^PATCH \/api\/meetings\/[^/]+\/settle$/,
    ],
};

/**
 * Endpoints that are PROSPECTING, whoever is asking.
 *
 * CONFINED above is an allow-list for a role that may reach almost nothing.
 * This is the opposite shape and needs to be: a rep may reach almost
 * everything, and the few things they may not are better named once here than
 * asserted in each of a dozen handlers, where the twelfth would eventually be
 * added without one.
 *
 * The generic record routes are the important entries. `/api/prospects` and
 * `/api/prospecting_contacts` are ordinary object routes served by
 * api/records.mjs, which asks for no capability at all — every role that
 * existed before this one held `record.read.all`, so nothing needed to. That
 * is exactly how a rep could read the entire uploaded-company book by typing
 * the URL.
 *
 * `/api/qualification/*` covers the rules, the review queue and the collector.
 * It also covers `/api/qualification/run`, which re-runs the rules against
 * ACCOUNTS — a rep loses that too, on purpose: reading a verdict off an account
 * is reading prospecting's conclusion through another window.
 */
const PROSPECTING_ROUTES = [
    /^\/api\/prospects(\/|$)/,
    /^\/api\/prospecting_contacts(\/|$)/,
    /^\/api\/qualification(\/|$)/,
    /**
     * The account plane's window onto the same engine.
     *
     * `/api/accounts/:id/verdicts` and `/evidence` return what the
     * qualification rules concluded and the panels they read to conclude it.
     * That is prospecting's output wearing an account's id, so it is denied by
     * the same capability — otherwise "a rep cannot see prospecting" would be
     * true of one route and false of the record page.
     */
    /^\/api\/accounts\/[^/]+\/(verdicts|evidence|collectability|collect|decision)$/,
    /**
     * Sourcing's own People Search — Apollo's whole database, not anchored to
     * an account or prospecting company already in the CRM. Unambiguously the
     * sourcing plane: it can only ever produce prospecting_company/contact
     * rows, never a live account. See api/people-search.mjs generalSearch.
     */
    /^\/api\/sourcing(\/|$)/,
];

/** Whether this role may reach this endpoint at all, before any handler runs. */
export function routeAllowed(ctx, method, pathname) {
    if (PROSPECTING_ROUTES.some((p) => p.test(pathname)) && !can(ctx, 'prospecting.read')) {
        return false;
    }
    const patterns = CONFINED[ctx?.role];
    if (!patterns) return true;
    return patterns.some((pattern) => pattern.test(`${method} ${pathname}`));
}

/** True when the role is confined, so the UI can route them to their own home. */
export function isConfined(ctx) {
    return Boolean(CONFINED[ctx?.role]);
}

export function can(ctx, capability) {
    const caps = CAPABILITIES[ctx?.role] ?? [];
    return caps.includes('*') || caps.includes(capability);
}

export function require$(ctx, capability) {
    if (!ctx) throw unauthorized();
    if (!can(ctx, capability)) throw forbidden(`Your role (${ctx.role}) cannot ${capability.replace(/\./g, ' ')}.`);
}

/**
 * True when the user may modify this specific record.
 *
 * A rep holds `record.write.own`, which means their own records only —
 * ownership is what scopes writes, so the check needs the record, not just the
 * capability.
 */
/**
 * Records the WHOLE TEAM works, as against one person's private drawer.
 *
 * A company, the people who work there, and the prospects they came from are
 * facts about the world. Two reps looking at the same account are looking at
 * the same company, and whoever happened to import it is not a reason the
 * other cannot correct its industry, set its services or fix its account type.
 *
 * The alternative is what this workspace actually had: nine accounts, every one
 * owned by an admin or the owner, and a rep who could edit none of them. That
 * is not a permission model, it is a queue for the person who did the import.
 *
 * ── WHY A DEAL IS NOW ON THIS LIST ──────────────────────────────────────────
 *
 * It was not, on the argument that a negotiation has an owner in a way a
 * company does not. True of the negotiation; not true of the RECORD. This is a
 * team of about twenty who cover for each other: a rep takes a call about a
 * colleague's client, is told the price has moved, and could not type it in —
 * they got "You can only change records you own", and the deal kept the old
 * figure until the owner was back. A forecast that is stale because of a
 * permission is worse than one a colleague corrected.
 *
 * ── WHAT STILL GUARDS THE COMMERCIALLY DANGEROUS PART ───────────────────────
 *
 * Not this. A price becomes a commitment when it reaches a document, and a
 * document reaches a client only through review: `submitForReview` puts it in
 * front of somebody holding `document.approve`, which a rep does not hold, and
 * `requireApproved` refuses to issue or sign anything that has not been through
 * it. So a rep changing a deal's price changes a forecast — visible, audited,
 * and correctable — while changing what a client is actually offered still
 * needs a manager. That is the gate, and it is the right one: it sits at the
 * moment the number leaves the building rather than at the moment somebody
 * types it.
 *
 * Proposals and agreements themselves stay owner-scoped, and DELETING stays
 * owner-scoped for everything besides needing `record.delete`, which a rep does
 * not hold either.
 */
const SHARED_OBJECTS = new Set(['account', 'contact', 'deal', 'prospecting_company', 'prospecting_contact']);

export function canWriteRecord(ctx, record, objectKey = null) {
    if (can(ctx, 'record.write.all')) return true;
    if (!can(ctx, 'record.write.own')) return false;
    // Passed only by the paths that EDIT. Delete calls omit it on purpose, so
    // the ownership rule below still governs removal.
    if (objectKey && SHARED_OBJECTS.has(objectKey)) return true;
    return record?.owner_id === ctx.userId || record?.created_by === ctx.userId || !record?.owner_id;
}

export function requireWrite(ctx, record, objectKey = null) {
    if (!canWriteRecord(ctx, record, objectKey)) {
        throw forbidden('You can only change records you own. Ask the owner or a manager.');
    }
}

export const ROLES = Object.keys(CAPABILITIES);

/* --------------------------------------------------------------- api keys -- */

/**
 * Personal integration tokens — the credential a tool like Make or Zapier
 * presents in an `X-Api-Key` header instead of a session cookie.
 *
 * A key acts as whoever created it. It carries no role of its own, so a key
 * minted by a rep can do exactly what that rep can do and one minted by an
 * admin can do exactly what an admin can do — the existing capability matrix
 * governs it unchanged, rather than a second permission system invented to
 * keep in sync with the first. That also means `routeAllowed`'s CONFINED list
 * applies here too: an SDR's role cannot mint a key that reaches anything
 * their session couldn't.
 *
 * Only the SHA-256 of the raw key is stored, the same discipline as sessions
 * and reset links above — a leaked database backup cannot be replayed as a
 * working key. `key_prefix` keeps a slice of the raw key in the clear so its
 * owner can tell two keys apart in a list; not enough of it to reconstruct
 * the rest.
 */
export const API_KEY_HEADER = 'x-api-key';

export function issueApiKey({ userId, workspaceId, name }) {
    const label = String(name ?? '').trim();
    if (!label) throw badRequest('Give the key a name — what is going to use it.');

    const raw = `crmk_${crypto.randomBytes(32).toString('base64url')}`;
    const keyId = id('key');
    run(
        `INSERT INTO api_keys (id, workspace_id, user_id, name, key_hash, key_prefix, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [keyId, workspaceId, userId, label.slice(0, 80), tokenHash(raw), raw.slice(0, 12), now()],
    );
    return { id: keyId, name: label.slice(0, 80), key: raw, keyPrefix: raw.slice(0, 12), createdAt: now() };
}

/** Every key in the workspace, or just one user's — see the admin check in api/meta.mjs. */
export function apiKeysFor(workspaceId, { userId = null } = {}) {
    return all(
        `SELECT k.id, k.name, k.key_prefix, k.created_at, k.last_used_at, k.revoked_at, u.name AS user_name
           FROM api_keys k JOIN users u ON u.id = k.user_id
          WHERE k.workspace_id = ? ${userId ? 'AND k.user_id = ?' : ''}
          ORDER BY k.created_at DESC`,
        userId ? [workspaceId, userId] : [workspaceId],
    );
}

/**
 * Revokes a key. `userId`, when passed, restricts this to keys that person
 * owns — the check a non-admin caller needs; an admin passes none and may
 * revoke anyone's, which is what lets a departing teammate's automations be
 * shut off in one place.
 */
export function revokeApiKey({ workspaceId, keyId, userId = null }) {
    const key = get('SELECT * FROM api_keys WHERE id = ? AND workspace_id = ?', [keyId, workspaceId]);
    if (!key) throw notFound('That key does not exist.');
    if (userId && key.user_id !== userId) throw forbidden('You can only revoke your own keys.');
    if (!key.revoked_at) run('UPDATE api_keys SET revoked_at = ? WHERE id = ?', [now(), keyId]);
    return { ok: true };
}

/** Resolves an `X-Api-Key` header into the same request context `sessionFor` builds. */
export function contextForApiKey(rawKey) {
    if (!rawKey) return null;
    const row = get(
        `SELECT k.id AS key_id, k.revoked_at, u.id AS user_id, u.email, u.name, u.status, u.timezone,
                m.workspace_id, m.role, m.team, w.name AS workspace_name, w.base_currency, w.timezone AS ws_timezone,
                w.weekend_days, w.verdict_stale_days, w.locale
           FROM api_keys k
           JOIN users u        ON u.id = k.user_id
           JOIN memberships m  ON m.user_id = k.user_id AND m.workspace_id = k.workspace_id
           JOIN workspaces w   ON w.id = k.workspace_id
          WHERE k.key_hash = ?`,
        [tokenHash(String(rawKey))],
    );
    if (!row || row.revoked_at) return null;
    if (row.status !== 'active') return null;

    // Opportunistic, like a session's expiry check is not: a failed write
    // here must not fail the request the key is authenticating.
    try { run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [now(), row.key_id]); } catch { /* not fatal */ }

    return {
        userId: row.user_id,
        workspaceId: row.workspace_id,
        role: row.role,
        team: row.team,
        user: { id: row.user_id, email: row.email, name: row.name, timezone: row.timezone },
        workspace: {
            id: row.workspace_id,
            name: row.workspace_name,
            baseCurrency: row.base_currency,
            timezone: row.ws_timezone,
            locale: row.locale,
            weekendDays: JSON.parse(row.weekend_days || '[5,6]'),
            verdictStaleDays: row.verdict_stale_days,
        },
        apiKeyId: row.key_id,
    };
}
