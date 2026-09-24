/**
 * Session, workspace metadata and admin configuration.
 *
 * `GET /api/meta` is the one call the client makes on load: objects, fields,
 * pipelines, stages, activity types, service lines, users, rules and settings.
 * Everything the UI renders comes from here, which is what stops the front end
 * from hard-coding a list of lifecycle stages that then disagrees with the
 * server.
 */
import { randomBytes } from 'node:crypto';
import { all, get, run, id, now, json, REMOTE } from '../lib/db.mjs';
import {
    OBJECTS, fieldsFor, operatorsFor, OPERATOR_LABELS, LIFECYCLE_STAGES, VERDICTS, ACCOUNT_TYPES,
    STATUS_TONES, BILLING_CURRENCIES,
    invalidateFieldDefs,
} from '../lib/objects.mjs';
import { billingTypeForPricingModel } from '../lib/money.mjs';
import { DOCUMENT_TYPES } from '../lib/document-types.mjs';
import { activeRules } from '../lib/qualification.mjs';
import { allSettings, setSetting, setting } from '../lib/settings.mjs';

/**
 * Settings whose VALUE must never reach a browser.
 *
 * A credential for a third-party service is not configuration. It is writable
 * by an admin and readable by nobody — the server is the only thing that needs
 * the string, and `/api/meta` is fetched by every signed-in session.
 */
const SECRET_SETTINGS = ['bounceban_api_key', 'smartlead_api_key', 'smartlead_webhook_secret', 'apollo_api_key', 'smtp_password'];

function publicSettings(workspaceId) {
    const out = allSettings(workspaceId);
    for (const key of SECRET_SETTINGS) out[key] = null;
    return out;
}
import {
    login, logout, sessionFor, listMembers, createUser, ROLES, can, require$, COOKIE,
    changeOwnPassword, issuePasswordReset, consumePasswordReset, updateUser,
    issueApiKey, apiKeysFor, revokeApiKey,
} from '../lib/auth.mjs';
import {
    readJson, setCookie, clearCookie, useSecureCookies, badRequest, notFound, unauthorized, clientIp,
    serviceUnavailable,
} from '../lib/http.mjs';
import { audit } from '../lib/repo.mjs';
import { getBuild } from '../lib/build.mjs';
import { STATUS_META as VERIFICATION_STATUS_META } from '../lib/verification.mjs';

/* ------------------------------------------------------------------ auth -- */

export async function doLogin({ req, res }) {
    const body = await readJson(req);
    const result = login({
        email: body.email,
        password: body.password,
        userAgent: req.headers['user-agent'],
        ip: clientIp(req),
    });
    setCookie(res, COOKIE, result.token, { maxAge: result.maxAge, secure: useSecureCookies(req) });
    return { user: result.user, role: result.role };
}

export async function doLogout({ req, res, token }) {
    logout(token);
    clearCookie(res, COOKIE, { secure: useSecureCookies(req) });
    return { ok: true };
}

/**
 * Changing your own password.
 *
 * `setPassword` signs the user out everywhere, which is the whole point of a
 * password change — so a fresh session is issued here for the browser that just
 * did it. Being logged out for changing your password correctly teaches people
 * not to change their password.
 */
export async function changePassword({ req, res, ctx }) {
    if (!ctx) throw unauthorized();
    const body = await readJson(req);
    changeOwnPassword({
        userId: ctx.userId,
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
    });
    const result = login({
        email: ctx.user.email,
        password: body.newPassword,
        userAgent: req.headers['user-agent'],
    });
    setCookie(res, COOKIE, result.token, { maxAge: result.maxAge, secure: useSecureCookies(req) });
    return { ok: true, signedOutElsewhere: true };
}

/**
 * Issues a one-time reset link for another member.
 *
 * The link is returned to the admin to hand over, because this system sends no
 * email. It is shown once and cannot be looked up again — only its hash is
 * stored — so losing it means issuing another.
 */
export async function resetLink({ req, params, ctx }) {
    require$(ctx, 'record.write.all');
    const member = get(
        'SELECT u.id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.id = ?',
        [ctx.workspaceId, params.id],
    );
    // Checked against the workspace, not just the user table: an admin here
    // must not be able to mint a reset link for somebody in another workspace.
    if (!member) throw notFound('That person is not a member of this workspace.');

    const issued = issuePasswordReset({ userId: params.id, issuedBy: ctx.userId });
    audit(ctx, {
        objectKey: 'user', recordId: params.id, action: 'password_reset_issued',
        after: { for: issued.user.email },
    });
    return {
        token: issued.token,
        path: `/reset?token=${encodeURIComponent(issued.token)}`,
        user: issued.user,
        expiresInHours: issued.expiresInHours,
    };
}

/** Spends a reset link. Public — the token is the credential. */
export async function doResetPassword({ req }) {
    const body = await readJson(req);
    consumePasswordReset({ token: body.token, password: body.password });
    return { ok: true };
}

/**
 * Health check — for an external uptime monitor, not for the CRM itself.
 *
 * Public on purpose: an uptime service has no session cookie to send. It
 * proves the process is answering AND the database is actually reachable —
 * this CRM's whole value depends on that connection (see lib/turso.mjs), so a
 * Node process that answers 200 from memory while the database is unreachable
 * would report "healthy" right through the outage that actually matters. One
 * trivial round trip catches that instead.
 */
export async function health() {
    try {
        get('SELECT 1 AS ok');
    } catch {
        throw serviceUnavailable('Database unreachable.');
    }
    return { ok: true, time: new Date().toISOString() };
}

/**
 * First-run setup endpoint. Creates the admin user when no users exist.
 *
 * Unauthenticated, because there is nobody to authenticate as yet. "No users
 * exist" is therefore the only thing standing between a public URL and whoever
 * calls this first, which on a database that is empty for any reason — a fresh
 * deploy, a failed restore — means the CRM is claimed by a stranger. So it also
 * wants a secret when one is configured.
 *
 * On a hosted database that secret is not optional: REMOTE means this server
 * is reachable from the open internet (or will be, the moment it is deployed),
 * so "the token was never set" must fail closed rather than silently degrade
 * to "whoever calls this first owns the CRM." Locally, with no hosted database
 * configured, only this machine can reach the endpoint anyway, so the token
 * stays optional for development convenience.
 */
export async function setup({ req }) {
    const body = await readJson(req);

    const expected = process.env.CRM_SETUP_TOKEN;
    if (REMOTE && !expected) {
        throw badRequest('CRM_SETUP_TOKEN must be set before first-run setup can be used on a hosted database.');
    }
    if (expected && body.token !== expected) {
        throw badRequest('Setup is not available.');
    }

    const userCount = get('SELECT COUNT(*) n FROM users');
    if (userCount && userCount.n > 0) {
        throw badRequest('Users already exist. Use the login page.');
    }
    if (!body.email || !body.password) {
        throw badRequest('Email and password are required.');
    }
    if (body.password.length < 8) {
        throw badRequest('Password must be at least 8 characters.');
    }

    // Create workspace
    const wsId = id('wsp');
    run(
        `INSERT INTO workspaces (id, name, base_currency, timezone, locale, weekend_days, verdict_stale_days, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [wsId, body.workspace || 'Talent 360', 'SAR', 'Asia/Riyadh', 'en', '[5,6]', 180, now()],
    );

    // Create admin user
    const user = createUser({
        email: body.email,
        name: body.name || 'Admin',
        password: body.password,
        role: 'admin',
        workspaceId: wsId,
    });

    return {
        ok: true,
        message: 'Admin user created. You can now log in.',
        user: { email: body.email, name: body.name || 'Admin' },
    };
}

export async function me({ ctx }) {
    if (!ctx) throw unauthorized();
    return {
        user: ctx.user,
        role: ctx.role,
        team: ctx.team,
        workspace: ctx.workspace,
        capabilities: Object.fromEntries(
            ['record.read.all', 'record.write.all', 'record.write.own', 'record.delete', 'export', 'qualification.run',
                'calling.manage', 'calling.work', 'calling.assign_own', 'calling.clear_activity', 'finance.read', 'finance.settings', 'prospecting.read',
                'view.share', 'list.write', 'proposal.issue', 'agreement.sign', 'deal.stage.change',
                'document.approve', 'people_search.use']
                .map((c) => [c, can(ctx, c)]),
        ),
    };
}

/* ------------------------------------------------------------------ meta -- */

export async function meta({ ctx }) {
    const objects = {};
    // What each status MEANS, so the client colours a badge from the domain
    // rather than from a lookup table of its own that covered a quarter of the
    // values and none of the approval workflow. See STATUS_TONES in objects.mjs.
    /**
     * Objects and fields this VIEWER has, which is not all of them.
     *
     * The registry is the whole vocabulary; what a role is offered is a subset
     * of it. Prospecting objects and the verdict columns that hang off accounts
     * are refused at the API (lib/auth.mjs) and stripped from hydration
     * (lib/repo.mjs) — sending their definitions anyway would leave a rep with
     * a Columns dialog offering "HCM verdict" and a filter builder offering a
     * field every query on it comes back empty from.
     */
    const seesProspecting = can(ctx, 'prospecting.read');
    for (const [key, def] of Object.entries(OBJECTS)) {
        if (!seesProspecting && (key === 'prospecting_company' || key === 'prospecting_contact')) continue;
        const fields = fieldsFor(key, ctx.workspaceId)
            .filter((f) => seesProspecting || f.computed !== 'verdict');
        objects[key] = {
            key,
            label: def.label,
            plural: def.plural,
            route: def.route,
            icon: def.icon,
            titleField: def.titleField,
            // Registered for its fields, not as something a user picks from a
            // list of objects. The client keeps these out of its pickers.
            internal: def.internal === true,
            defaultFilter: def.defaultFilter ?? null,
            // The columns this object shows when listed inside a parent record.
            // Null means "no opinion", and the client falls back to the list
            // defaults minus whatever points back at the parent.
            relatedColumns: def.relatedColumns ?? null,
            fields: fields.map((f) => ({
                id: f.id ?? null,
                key: f.key,
                label: f.label,
                type: f.type,
                options: f.options,
                // Where the options come from when they are workspace data
                // rather than a fixed list. The client resolves this generically
                // instead of holding a table of object/field special cases.
                optionsSource: f.optionsSource ?? null,
                references: f.references ?? null,
                required: !!f.required,
                readOnly: !!f.readOnly,
                custom: !!f.custom,
                computed: f.computed ?? null,
                rule: f.rule ?? null,
                help: f.help ?? null,
                // How the client should DISPLAY a value it stores differently —
                // a name, not a function, because this crosses as JSON. The
                // server keeps the other half: `normalise` on the field
                // definition reduces whatever is typed back on every write.
                format: f.format ?? null,
                form: f.form !== false,
                // How the form arranges itself: which section, whether it is
                // behind the "advanced" disclosure, and the condition under
                // which it is asked at all. Declarations, not functions — this
                // crosses as JSON.
                group: f.group ?? null,
                advanced: !!f.advanced,
                showWhen: f.showWhen ?? null,
                listDefault: !!f.listDefault,
                filterable: !!f.filterable,
                sortable: f.sortable !== false,
                searchable: !!f.searchable,
                operators: f.filterable ? operatorsFor(f.type) : [],
                excludedBecause: f.filterable ? null : (f.excludedBecause ?? 'This field is not indexed for filtering.'),
            })),
        };
    }

    const pipelines = all('SELECT * FROM pipelines WHERE workspace_id = ? ORDER BY position', [ctx.workspaceId]);
    const stages = all(
        `SELECT s.* FROM stages s JOIN pipelines p ON p.id = s.pipeline_id
          WHERE p.workspace_id = ? ORDER BY p.position, s.position`,
        [ctx.workspaceId],
    ).map((s) => ({ ...s, required_fields: json(s.required_fields, []) }));

    return {
        workspace: ctx.workspace,
        user: ctx.user,
        role: ctx.role,
        objects,
        /**
         * The roles, from the capability matrix rather than a list typed out
         * again in the browser. The invite dropdown was hardcoded, so adding
         * `sdr` to the server did nothing visible and the role could not be
         * given to anybody — a second copy of a list is a second copy to
         * forget.
         */
        roles: ROLES,
        pipelines: pipelines.map((p) => ({ ...p, stages: stages.filter((s) => s.pipeline_id === p.id) })),
        stages,
        activityTypes: all('SELECT * FROM activity_types WHERE workspace_id = ? ORDER BY position', [ctx.workspaceId]),
        /**
         * The service lines, each carrying how it BILLS.
         *
         * `billing_type` is derived from the pricing model rather than stored,
         * so the browser and the server cannot disagree about whether HCM
         * recurs. It is what the deal form reads to label a price "per month"
         * without asking anybody to choose.
         */
        serviceLines: all('SELECT * FROM service_lines WHERE workspace_id = ? ORDER BY position', [ctx.workspaceId])
            .map((line) => ({ ...line, billing_type: billingTypeForPricingModel(line.pricing_model) })),
        // The currencies a deal, an account or a contract may be priced in —
        // exactly the ones the dashboard holds a conversion rate for.
        billingCurrencies: BILLING_CURRENCIES,
        /**
         * The document types this workspace can produce, as a name and a
         * category — never the field definitions, which are large and belong to
         * the generation wizard's own call.
         *
         * Here so that "upload a version of which document?" can be asked
         * without first fetching the whole generation payload for an account.
         */
        documentTypes: Object.fromEntries(
            Object.entries(DOCUMENT_TYPES).map(([key, type]) => [key, {
                key, label: type.label, category: type.category, product: type.product ?? null,
            }]),
        ),
        lossReasons: all('SELECT * FROM loss_reasons WHERE workspace_id = ? ORDER BY position', [ctx.workspaceId]),
        // Campaigns are records, but they are also an option source for the
        // campaign field on accounts, contacts and deals, so the picker has them
        // without a second round trip. Only the live ones — a cancelled campaign
        // stays readable on the records that point at it but is not offered for
        // new attribution.
        campaigns: all(
            // external_id is what marks a campaign Smartlead-linked — see
            // linkedCampaigns() in public/js/outreach.js, which filters on
            // exactly this field. Missing it here meant the "Add to
            // Smartlead" wizard found no linked campaign for anyone who
            // had not already visited the Campaigns list page this
            // session (the only other path that repopulates this cache,
            // via store.refreshCampaigns) — on a workspace that had one.
            `SELECT id, name, status, channel, service_line_key, external_id FROM campaigns
              WHERE workspace_id = ? AND deleted_at IS NULL
              ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, name`,
            [ctx.workspaceId],
        ),
        rules: activeRules(ctx.workspaceId),
        users: listMembers(ctx.workspaceId),
        lifecycleStages: LIFECYCLE_STAGES,
        verdicts: VERDICTS,
        // The email-verification vocabulary, with what each status means for
        // sending. Shipped as metadata so the UI never has to decide for itself
        // whether "accept-all" is good news.
        verificationStatuses: VERIFICATION_STATUS_META,
        // value -> tone, for every badge the client draws.
        statusTones: STATUS_TONES,
        operatorLabels: OPERATOR_LABELS,
        /**
         * Settings, with the secrets taken out.
         *
         * `/api/meta` is fetched by every signed-in browser, and this object was
         * carrying `bounceban_api_key` in it — so a third-party API key was
         * readable from devtools by any rep, and rendered into an input on the
         * settings page for anyone who could open it. Nobody needs to READ a
         * key back: setting one means typing a new one.
         *
         * So the value never leaves the server, and what ships instead is
         * whether one is configured, which is all the UI has to show.
         */
        settings: publicSettings(ctx.workspaceId),
        secretsConfigured: Object.fromEntries(
            SECRET_SETTINGS.map((key) => [key, Boolean(setting(ctx.workspaceId, key))]),
        ),
        /**
         * What is actually running. "Are my changes live?" ends here: this is
         * the commit the server booted from (or Render's build commit), and
         * Settings shows it beside your name.
         */
        build: getBuild(),
        capabilities: (await me({ ctx })).capabilities,
    };
}

/* ------------------------------------------------------------ custom fields -- */

/**
 * Creating a custom field.
 *
 * This is the whole metadata promise in one endpoint: the field appears in the
 * list, the record form, the filter builder, the import mapper, the export and
 * the API immediately, because none of those contain a list of fields.
 */
export async function createField({ req, ctx }) {
    require$(ctx, 'record.write.all');
    const body = await readJson(req);
    if (!OBJECTS[body.object_key]) throw badRequest(`Unknown object "${body.object_key}".`);

    const key = String(body.key ?? '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!key || /^\d/.test(key)) throw badRequest('A field key must start with a letter and hold only letters, numbers and underscores.');
    if (!operatorsFor(body.type)) throw badRequest(`Unknown field type "${body.type}".`);
    if (get('SELECT id FROM field_defs WHERE workspace_id = ? AND object_key = ? AND key = ?', [ctx.workspaceId, body.object_key, key])) {
        throw badRequest(`A field called "${key}" already exists on ${OBJECTS[body.object_key].label}.`);
    }

    const fieldId = id('fld');
    run(
        `INSERT INTO field_defs (id, workspace_id, object_key, key, label, type, options, required,
                                 filterable, sortable, searchable, is_system, help, position, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`,
        [
            fieldId, ctx.workspaceId, body.object_key, key,
            String(body.label ?? key).slice(0, 80), body.type,
            body.options ? JSON.stringify(body.options) : null,
            body.required ? 1 : 0,
            body.filterable === false ? 0 : 1,
            body.sortable === false ? 0 : 1,
            body.searchable ? 1 : 0,
            body.help ?? null, Number(body.position) || 100, now(),
        ],
    );
    // The definitions are cached per workspace; a new one is not visible
    // until that cache is told.
    invalidateFieldDefs(ctx.workspaceId);
    return { field: get('SELECT * FROM field_defs WHERE id = ?', [fieldId]) };
}

/**
 * Deleting a custom field is blocked while anything still references it.
 *
 * The referrer is NAMED. "Cannot delete, in use" sends someone hunting; "used
 * by the view 'HCM — qualified'" is a link to click.
 */
export async function deleteField({ params, ctx }) {
    require$(ctx, 'record.write.all');
    const field = get('SELECT * FROM field_defs WHERE id = ? AND workspace_id = ?', [params.id, ctx.workspaceId]);
    if (!field) throw notFound('That field does not exist.');

    const path = `properties.${field.key}`;
    const referrers = [];
    for (const view of all('SELECT id, name, filter, sort, columns FROM views WHERE workspace_id = ? AND object_key = ?', [ctx.workspaceId, field.object_key])) {
        const blob = `${view.filter}${view.sort}${view.columns}`;
        if (blob.includes(path)) referrers.push({ type: 'view', id: view.id, name: view.name });
    }
    for (const list of all('SELECT id, name, filter FROM lists WHERE workspace_id = ? AND object_key = ?', [ctx.workspaceId, field.object_key])) {
        if (String(list.filter).includes(path)) referrers.push({ type: 'list', id: list.id, name: list.name });
    }
    if (referrers.length) {
        throw badRequest(
            `"${field.label}" is still used by ${referrers.map((r) => `the ${r.type} "${r.name}"`).join(', ')}. `
            + 'Remove it there first.',
            { referrers },
        );
    }

    // Soft delete. The values stay in each record's properties, so restoring the
    // field brings the data back rather than resurrecting an empty column.
    run('UPDATE field_defs SET deleted_at = ? WHERE id = ?', [now(), params.id]);
    invalidateFieldDefs(ctx.workspaceId);
    return { ok: true, note: 'Existing values are kept. Re-creating the field with the same key restores them.' };
}

/* ----------------------------------------------------------------- admin -- */

/**
 * Change somebody's role.
 *
 * There was no way to do this at all, which only became a problem once a role
 * existed that people would be moved INTO: an SDR invited as a rep could not
 * become an SDR without editing the database by hand.
 *
 * Two guards, both about not locking anybody out. You cannot change your own
 * role — an admin demoting themselves has no way back — and the last remaining
 * owner or admin cannot be demoted, because a workspace with nobody who can
 * administer it cannot be repaired from inside.
 */
export async function patchMember({ req, params, ctx }) {
    require$(ctx, 'record.write.all');
    const body = await readJson(req);
    if (!ROLES.includes(body.role)) throw badRequest(`Role must be one of: ${ROLES.join(', ')}.`);

    const membership = get(
        'SELECT * FROM memberships WHERE workspace_id = ? AND user_id = ?',
        [ctx.workspaceId, params.id],
    );
    if (!membership) throw notFound('That person is not a member of this workspace.');

    if (params.id === ctx.userId) {
        throw badRequest('You cannot change your own role. Ask another admin to do it.');
    }

    if (['owner', 'admin'].includes(membership.role) && !['owner', 'admin'].includes(body.role)) {
        const others = get(
            `SELECT COUNT(*) AS n FROM memberships m JOIN users u ON u.id = m.user_id
              WHERE m.workspace_id = ? AND m.user_id <> ? AND m.role IN ('owner','admin') AND u.status = 'active'`,
            [ctx.workspaceId, params.id],
        )?.n ?? 0;
        if (!others) throw badRequest('This is the only admin left. Promote somebody else first.');
    }

    run('UPDATE memberships SET role = ? WHERE workspace_id = ? AND user_id = ?',
        [body.role, ctx.workspaceId, params.id]);

    audit(ctx, {
        objectKey: 'user', recordId: params.id, action: 'role_changed',
        before: { role: membership.role }, after: { role: body.role },
    });

    return { user: { id: params.id, role: body.role } };
}

export async function updateMemberProfile({ req, params, ctx }) {
    require$(ctx, 'record.write.all');
    const body = await readJson(req);
    const userId = params.id;
    if (!userId) throw badRequest('User id is required.');

    // Before/after on the record: a person's name or login changing is exactly
    // the kind of fact an audit exists for. The password is never written here
    // — only the fact that one was set.
    const before = get('SELECT id, name, email FROM users WHERE id = ?', [userId]);
    if (!before) throw notFound('That user does not exist.');

    const updated = updateUser({ userId, name: body.name, email: body.email, password: body.password });

    audit(ctx, {
        objectKey: 'user', recordId: userId,
        action: 'user_updated',
        before: { name: before.name, email: before.email },
        after: {
            name: updated?.name ?? body.name ?? before.name,
            email: updated?.email ?? body.email ?? before.email,
            password_changed: body.password !== undefined && body.password !== null && body.password !== '',
        },
    });

    return { user: updated };
}

export async function inviteUser({ req, ctx }) {
    require$(ctx, 'record.write.all');
    const body = await readJson(req);
    if (!ROLES.includes(body.role)) throw badRequest(`Role must be one of: ${ROLES.join(', ')}.`);
    const user = createUser({
        email: body.email, name: body.name, password: body.password,
        role: body.role, workspaceId: ctx.workspaceId, team: body.team ?? null,
    });
    return { user };
}

/**
 * The reporting rates are ADMIN settings, not manager settings.
 *
 * A manager reads financial analytics; changing the rate those analytics are
 * computed with moves every figure on the dashboard at once, which is a
 * different act. `finance.settings` appears in nobody's explicit capability
 * list, so only the roles holding `*` — owner and admin — pass.
 */
const FX_SETTINGS = new Set(['reporting_currency', 'fx_egp_per_usd', 'fx_sar_per_usd']);

export async function updateSettings({ req, ctx }) {
    require$(ctx, 'record.write.all');
    const body = await readJson(req);
    if (Object.keys(body).some((key) => FX_SETTINGS.has(key))) {
        require$(ctx, 'finance.settings');
    }

    const out = {};
    for (const [key, value] of Object.entries(body)) {
        if (key === 'document_signing_key') continue;   // never settable over the API
        if (key === 'reporting_currency' && String(value).toUpperCase() !== 'USD') {
            throw badRequest('The reporting currency is USD. Rates are expressed as units per USD.');
        }
        /**
         * `base_currency` lives on the `workspaces` row, not the key-value
         * `settings` table every other field here writes to — it is what a
         * new account/deal falls back to when nothing more specific (the
         * account's own billing currency, an explicit choice) says
         * otherwise. Set once at setup and never editable since, which is
         * how a workspace whose books moved from SAR to USD kept minting
         * new deals in SAR forever with no field anywhere to fix it.
         */
        if (key === 'base_currency') {
            require$(ctx, 'finance.settings');
            const currency = String(value ?? '').trim().toUpperCase();
            if (!currency || currency.length !== 3) throw badRequest('Base currency must be a 3-letter code, e.g. USD.');
            run('UPDATE workspaces SET base_currency = ? WHERE id = ?', [currency, ctx.workspaceId]);
            audit(ctx, {
                objectKey: 'workspace', recordId: ctx.workspaceId, action: 'base_currency_changed',
                before: { base_currency: ctx.workspace.baseCurrency }, after: { base_currency: currency },
            });
            out.base_currency = currency;
            continue;
        }
        if (key === 'fx_egp_per_usd' || key === 'fx_sar_per_usd') {
            const rate = Number(value);
            if (!Number.isFinite(rate) || rate <= 0) {
                throw badRequest('An exchange rate must be a positive number of units per USD.');
            }
            out[key] = setSetting(ctx.workspaceId, key, rate);
            audit(ctx, {
                objectKey: 'workspace', recordId: ctx.workspaceId, action: 'reporting_rate_changed',
                after: { [key]: rate },
            });
            continue;
        }
        out[key] = setSetting(ctx.workspaceId, key, value);
        /**
         * Connecting Smartlead mints the webhook secret in the same breath.
         *
         * The webhook URL is the only credential Smartlead presents — it signs
         * nothing — so the path segment has to be unguessable and it must exist
         * before the first campaign is linked, not after somebody notices events
         * are being refused. Regenerating means re-registering webhooks; that
         * is what Integration health's reconnect is for.
         */
        if (key === 'smartlead_api_key' && value && !setting(ctx.workspaceId, 'smartlead_webhook_secret')) {
            out.smartlead_webhook_secret = setSetting(
                ctx.workspaceId, 'smartlead_webhook_secret', randomBytes(24).toString('base64url'),
            );
            // Never echo the secret back either.
            delete out.smartlead_webhook_secret;
        }
    }
    return { settings: out };
}

/* ------------------------------------------------------- service targets -- */

/**
 * What each part of the business is aiming at, per service.
 *
 * Returned as a full grid — every account type crossed with every service line
 * — with `target` null where nobody has set one. A missing target is not a
 * target of zero, and the difference matters the moment the dashboard reports
 * attainment: 0% against a target nobody agreed is a number that starts
 * arguments.
 */
export async function serviceTargets({ ctx }) {
    /**
     * A target is a revenue figure, so it is finance.
     *
     * The WRITE was gated and the read was not, which meant any rep could ask
     * for `/api/service-targets` and read what every part of the business is
     * expected to bring in this year — one of the more sensitive numbers in the
     * company, and precisely the sort the brief put behind Admin and Manager.
     * Targets appear on the dashboard inside a money widget, which is already
     * gated the same way; this is the endpoint behind it agreeing.
     */
    require$(ctx, 'finance.read');
    const rows = all(
        'SELECT account_type, service_line_key, target_amount, updated_at FROM service_targets WHERE workspace_id = ?',
        [ctx.workspaceId],
    );
    const set = new Map(rows.map((r) => [`${r.account_type}:${r.service_line_key}`, r]));
    const services = all('SELECT key, label FROM service_lines WHERE workspace_id = ? ORDER BY position', [ctx.workspaceId]);

    return {
        // The reporting currency these are held in. Stated rather than assumed,
        // because a target is meaningless without it.
        currency: 'USD',
        accountTypes: ACCOUNT_TYPES,
        services,
        targets: ACCOUNT_TYPES.flatMap((accountType) => services.map((service) => {
            const row = set.get(`${accountType}:${service.key}`);
            return {
                accountType,
                service: service.key,
                serviceLabel: service.label,
                target: row ? row.target_amount : null,
                updatedAt: row?.updated_at ?? null,
            };
        })),
    };
}

/**
 * Sets or clears one target.
 *
 * A null or empty amount DELETES the row rather than storing 0, so "not set"
 * stays expressible. Manager and above, because a target is a commitment.
 */
export async function putServiceTarget({ req, ctx }) {
    require$(ctx, 'record.write.all');
    const body = await readJson(req);

    if (!ACCOUNT_TYPES.includes(body.accountType)) {
        throw badRequest(`Account type must be one of: ${ACCOUNT_TYPES.join(', ')}.`);
    }
    const service = get(
        'SELECT key FROM service_lines WHERE workspace_id = ? AND key = ?',
        [ctx.workspaceId, body.service],
    );
    if (!service) throw badRequest(`"${body.service}" is not a service line in this workspace.`);

    const raw = body.target;
    const cleared = raw === null || raw === undefined || String(raw).trim() === '';
    if (cleared) {
        run(
            'DELETE FROM service_targets WHERE workspace_id = ? AND account_type = ? AND service_line_key = ?',
            [ctx.workspaceId, body.accountType, service.key],
        );
        audit(ctx, {
            objectKey: 'workspace', recordId: ctx.workspaceId, action: 'service_target_cleared',
            after: { accountType: body.accountType, service: service.key },
        });
        return { target: null };
    }

    const amount = Number(String(raw).replace(/[,\s]/g, ''));
    if (!Number.isFinite(amount) || amount < 0) throw badRequest('A target must be a number, and not negative.');

    run(
        `INSERT INTO service_targets (workspace_id, account_type, service_line_key, target_amount, updated_at, updated_by)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(workspace_id, account_type, service_line_key) DO UPDATE SET
           target_amount = excluded.target_amount, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        [ctx.workspaceId, body.accountType, service.key, amount, now(), ctx.userId ?? null],
    );
    audit(ctx, {
        objectKey: 'workspace', recordId: ctx.workspaceId, action: 'service_target_set',
        after: { accountType: body.accountType, service: service.key, target: amount },
    });
    return { target: amount };
}

export async function activityTypes({ ctx }) {
    return { types: all('SELECT * FROM activity_types WHERE workspace_id = ? ORDER BY position', [ctx.workspaceId]) };
}

export async function createActivityType({ req, ctx }) {
    require$(ctx, 'record.write.all');
    const body = await readJson(req);
    const key = String(body.key ?? '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!key) throw badRequest('An activity type needs a key.');
    if (get('SELECT id FROM activity_types WHERE workspace_id = ? AND key = ?', [ctx.workspaceId, key])) {
        throw badRequest(`An activity type called "${key}" already exists.`);
    }
    const typeId = id('aty');
    run(
        'INSERT INTO activity_types (id, workspace_id, key, label, icon, color, manual, position) VALUES (?,?,?,?,?,?,1,?)',
        [typeId, ctx.workspaceId, key, body.label ?? key, body.icon ?? 'dot', body.color ?? 'info', Number(body.position) || 100],
    );
    return { type: get('SELECT * FROM activity_types WHERE id = ?', [typeId]) };
}

/* --------------------------------------------------------------- api keys -- */

/**
 * Personal integration tokens for tools like Make or Zapier that call the
 * CRM's API directly instead of a person clicking through it.
 *
 * A key acts as whoever created it (see `issueApiKey`), so there is no
 * separate role to assign here — only who may SEE which keys. An admin sees
 * every key in the workspace, because a departing teammate's automations
 * need to be shut off from somewhere; everybody else sees only their own.
 */
export async function listApiKeys({ ctx }) {
    const isAdmin = ['owner', 'admin'].includes(ctx.role);
    return { keys: apiKeysFor(ctx.workspaceId, isAdmin ? {} : { userId: ctx.userId }) };
}

export async function createApiKey({ req, ctx }) {
    const body = await readJson(req);
    const created = issueApiKey({ userId: ctx.userId, workspaceId: ctx.workspaceId, name: body.name });
    audit(ctx, {
        objectKey: 'api_key', recordId: created.id, action: 'api_key_created',
        after: { name: created.name, keyPrefix: created.keyPrefix },
    });
    return created;
}

export async function deleteApiKey({ params, ctx }) {
    const isAdmin = ['owner', 'admin'].includes(ctx.role);
    revokeApiKey({ workspaceId: ctx.workspaceId, keyId: params.id, userId: isAdmin ? null : ctx.userId });
    audit(ctx, { objectKey: 'api_key', recordId: params.id, action: 'api_key_revoked' });
    return { ok: true };
}

/* --------------------------------------------------------- notifications -- */

export async function notifications({ url, ctx }) {
    const unreadOnly = url.searchParams.get('unread') === '1';
    const rows = all(
        `SELECT * FROM notifications WHERE user_id = ? AND workspace_id = ? ${unreadOnly ? 'AND read_at IS NULL' : ''}
          ORDER BY created_at DESC LIMIT 50`,
        [ctx.userId, ctx.workspaceId],
    );
    const unread = get('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL', [ctx.userId]).n;
    return { notifications: rows, unread };
}

export async function markNotificationsRead({ req, ctx }) {
    const body = await readJson(req).catch(() => ({}));
    if (body.ids?.length) {
        for (const notificationId of body.ids) {
            run('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?', [now(), notificationId, ctx.userId]);
        }
    } else {
        run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [now(), ctx.userId]);
    }
    return { ok: true };
}
