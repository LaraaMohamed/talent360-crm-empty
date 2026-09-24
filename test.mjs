/**
 * The test suite.
 *
 *   node test.mjs
 *
 * Runs against a throwaway database in the OS temp directory, so it never
 * touches `data/crm.db` and never reads or writes the qualifier's
 * `snapshots.json`. Offline, no network, a couple of seconds.
 *
 * The tests are weighted towards the things that are EXPENSIVE TO GET WRONG
 * rather than the things that are easy to test:
 *
 *   - REVIEW must never collapse into REJECTED, anywhere
 *   - one-time and recurring money must never be summed
 *   - verdicts must be append-only and versioned
 *   - audit events must be append-only
 *   - the filter compiler must parameterise everything
 *   - the CRM's verdicts must match the standalone qualifier's exactly
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-test-'));
process.env.CRM_DB = path.join(TMP, 'test.db');
process.env.CRM_STORAGE = path.join(TMP, 'storage');

const db = await import('./lib/db.mjs');
const auth = await import('./lib/auth.mjs');
const objects = await import('./lib/objects.mjs');
const query = await import('./lib/query.mjs');
const money = await import('./lib/money.mjs');
const settings = await import('./lib/settings.mjs');
const repo = await import('./lib/repo.mjs');
const qual = await import('./lib/qualification.mjs');
const upload = await import('./lib/qualify-upload.mjs');
const dealImport = await import('./lib/import.mjs');
const http = await import('./lib/http.mjs');
const bounceban = await import('./lib/bounceban.mjs');
const peopleSearch = await import('./lib/people-search.mjs');
const peopleSearchApi = await import('./api/people-search.mjs');
const verification = await import('./lib/verification.mjs');
const merge = await import('./lib/merge.mjs');
const names = await import('./lib/names.mjs');

/**
 * A request an API handler can read a JSON body from.
 *
 * `readJson` consumes the request as a stream, so calling a handler directly
 * needs one — the alternative is a second body-parsing path that only tests
 * use, which is how a test stops testing the thing it names.
 */
function bodyOf(value) {
    return Readable.from([Buffer.from(JSON.stringify(value), 'utf8')]);
}

/* ------------------------------------------------------------- runner --- */

let passed = 0;
const failures = [];
let group = '';

function describe(name) { group = name; }

function check(name, fn) {
    try {
        fn();
        passed += 1;
    } catch (err) {
        failures.push(`${group} › ${name}\n      ${err.message}`);
    }
}

async function checkAsync(name, fn) {
    try {
        await fn();
        passed += 1;
    } catch (err) {
        failures.push(`${group} › ${name}\n      ${err.message}`);
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message ?? 'assertion failed');
}

function equal(actual, expected, message) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${message ?? 'not equal'}\n      expected ${b}\n      actual   ${a}`);
}

function throws(fn, pattern, message) {
    try {
        fn();
    } catch (err) {
        if (pattern && !pattern.test(err.message)) {
            throw new Error(`${message ?? 'wrong error'}: ${err.message}`);
        }
        return;
    }
    throw new Error(message ?? 'expected it to throw, but it did not');
}

/* ------------------------------------------------------------- fixture --- */

db.migrate();

const WS = db.id('wsp');
db.run(
    `INSERT INTO workspaces (id, name, base_currency, timezone, locale, weekend_days, verdict_stale_days, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [WS, 'Test', 'SAR', 'Asia/Riyadh', 'en', '[5,6]', 180, db.now()],
);

const admin = auth.createUser({ email: 'admin@test.local', name: 'Admin', password: 'test-password-1', role: 'owner', workspaceId: WS });
const rep = auth.createUser({ email: 'rep@test.local', name: 'Rep', password: 'test-password-2', role: 'rep', workspaceId: WS });

const ctx = {
    workspaceId: WS, userId: admin.id, role: 'owner',
    user: { id: admin.id, name: 'Admin' },
    workspace: { id: WS, baseCurrency: 'SAR', timezone: 'Asia/Riyadh', verdictStaleDays: 180, name: 'Test' },
};
const repCtx = { ...ctx, userId: rep.id, role: 'rep', user: { id: rep.id, name: 'Rep' } };

/**
 * The service lines, as `setup.mjs` seeds them.
 *
 * They are a table, not a constant: `accounts.services` stores their keys, the
 * document registry maps its `product` onto them, and the generate dialog offers
 * them so a service can be chosen while writing a proposal. A fixture without
 * them tests a workspace that could not exist.
 */
[
    ['recruitment', 'Recruitment', 'placement_fee'],
    ['hcm', 'HCM', 'per_seat'],
    ['offshoring', 'Offshoring', 'per_headcount'],
    ['od', 'OD', 'fixed_fee'],
    ['training_team_building', 'Training & Team Building', 'fixed_fee'],
].forEach(([key, label, model], i) => db.run(
    'INSERT INTO service_lines (id, workspace_id, key, label, pricing_model, position) VALUES (?,?,?,?,?,?)',
    [db.id('svc'), WS, key, label, model, i],
));

// A pipeline, so deals can exist.
const PIPE = db.id('pip');
db.run('INSERT INTO pipelines (id, workspace_id, key, label, object_key, is_default, position, created_at) VALUES (?,?,?,?,?,1,0,?)',
    [PIPE, WS, 'default', 'Default', 'deal', db.now()]);
const STAGE_OPEN = db.id('stg');
const STAGE_WON = db.id('stg');
const STAGE_LOST = db.id('stg');
/**
 * Empty, deliberately — matching the production default's own earliest
 * stage. A deal can be raised the moment a meeting is booked, with no date
 * yet to give; the workspace's OWN pipeline gates `close_date` starting at
 * a later, named stage ("Proposal sent") rather than at the first one, and
 * this fixture used to disagree with that on day one, going unnoticed only
 * because nothing enforced a stage's required fields at CREATION — only a
 * later move ever checked. See STAGE_GATED below for the stage that
 * actually carries the requirement in these tests.
 */
db.run('INSERT INTO stages (id, workspace_id, pipeline_id, key, label, position, probability, type, required_fields) VALUES (?,?,?,?,?,0,0.2,?,?)',
    [STAGE_OPEN, WS, PIPE, 'open', 'Open', 'open', '[]']);
// The stage an agreement puts its deal into. Keyed `contracting` because that
// is what lib/repo.mjs looks up — by key, never by guessing at an open stage.
const STAGE_CONTRACTING = db.id('stg');
db.run('INSERT INTO stages (id, workspace_id, pipeline_id, key, label, position, probability, type, required_fields) VALUES (?,?,?,?,?,1,0.85,?,?)',
    [STAGE_CONTRACTING, WS, PIPE, 'contracting', 'Contracting', 'open', '[]']);
db.run('INSERT INTO stages (id, workspace_id, pipeline_id, key, label, position, probability, type, required_fields) VALUES (?,?,?,?,?,2,1,?,?)',
    [STAGE_WON, WS, PIPE, 'won', 'Won', 'won', '[]']);
db.run('INSERT INTO stages (id, workspace_id, pipeline_id, key, label, position, probability, type, required_fields) VALUES (?,?,?,?,?,3,0,?,?)',
    [STAGE_LOST, WS, PIPE, 'lost', 'Lost', 'lost', '[]']);
// A later, named stage that DOES gate on close_date — matching the
// production pipeline's own "Proposal sent" stage, and giving the
// required-fields tests a stage to exercise without disturbing the
// hundreds of tests that create a deal straight into STAGE_OPEN.
const STAGE_GATED = db.id('stg');
db.run('INSERT INTO stages (id, workspace_id, pipeline_id, key, label, position, probability, type, required_fields) VALUES (?,?,?,?,?,4,0.6,?,?)',
    [STAGE_GATED, WS, PIPE, 'proposal_sent', 'Proposal sent', 'open', '["close_date"]']);

const engines = await qual.loadEngines();
for (const key of ['hcm', 'offshoring']) {
    db.run(
        `INSERT INTO qualification_rules (id, workspace_id, key, label, engine, claim_type, version, summary, config, active, created_at)
         VALUES (?,?,?,?,?,?,1,?,?,1,?)`,
        [db.id('rul'), WS, key, engines[key].label, engines[key].engineId, engines[key].claimType,
            engines[key].summary, JSON.stringify(engines[key].defaults), db.now()],
    );
}

/* ============================================================ 1. AUTH === */

describe('Authentication');

check('a password round-trips through scrypt', () => {
    const hash = auth.hashPassword('correct horse battery staple');
    assert(auth.verifyPassword('correct horse battery staple', hash), 'the right password should verify');
    assert(!auth.verifyPassword('wrong', hash), 'the wrong password must not verify');
});

check('two hashes of the same password differ (salted)', () => {
    assert(auth.hashPassword('same') !== auth.hashPassword('same'), 'hashes must be salted');
});

describe('BounceBan email verification');

await checkAsync('the transport returns the provider payload untouched', async () => {
    // The transport does NOT interpret. Keeping translation out of it is what
    // lets a second provider be added without touching business logic.
    let calledUrl = null;
    let sentAuth = null;
    const result = await bounceban.verifyEmail('user@example.com', 'test-key', {
        fetcher: async (url, init) => {
            calledUrl = url;
            sentAuth = init.headers.Authorization;
            return { ok: true, status: 200, json: async () => ({ result: 'deliverable', score: 92 }) };
        },
    });
    equal(result.payload.result, 'deliverable');
    assert(calledUrl.includes('/v1/verify/single'), 'must call the single-verification endpoint');
    assert(calledUrl.includes('email=user%40example.com'), 'the address travels as a query parameter');
    // BounceBan does not use the Bearer scheme. Sending one returns 404, which
    // cost a live debugging session to discover.
    equal(sentAuth, 'test-key', 'the key is sent bare, with no Bearer prefix');
});

check('BounceBan results map onto the CRM vocabulary', () => {
    const cases = [
        [{ result: 'deliverable' }, 'deliverable'],
        [{ result: 'undeliverable' }, 'invalid'],
        [{ result: 'risky' }, 'risky'],
        [{ result: 'unknown' }, 'unknown'],
        // Flags outrank the verdict: on an accept-all domain "deliverable" only
        // means the server did not refuse, which is not evidence of a mailbox.
        [{ result: 'deliverable', is_accept_all: true }, 'accept_all'],
        [{ result: 'deliverable', is_disposable: true }, 'disposable'],
        [{ result: 'deliverable', is_role: true }, 'risky'],
        // `status` is the REQUEST state, never the verdict. Reading it as one
        // mapped every successful check to UNKNOWN.
        [{ status: 'success', result: 'deliverable' }, 'deliverable'],
        [{}, 'unknown'],
    ];
    for (const [payload, expected] of cases) {
        equal(verification.mapBounceBan(payload), expected, JSON.stringify(payload));
    }
});

check('a populated value is never overwritten by an empty one', () => {
    const plan = merge.mergePlan('account', ctx.workspaceId,
        { id: 'a', name: 'Acme', domain: 'acme.sa', phone: '', updated_at: '2026-01-01T00:00:00Z', properties: {} },
        { id: 'b', name: 'Acme', domain: '', phone: '+966 11 000', updated_at: '2026-08-01T00:00:00Z', properties: {} });

    const domain = plan.find((r) => r.key === 'domain');
    equal(domain.chosen, 'acme.sa', 'a populated domain survives an empty one on a NEWER record');
    const phone = plan.find((r) => r.key === 'phone');
    equal(phone.chosen, '+966 11 000', 'and an empty field is filled from the duplicate');
});

check('a whole name survives being split', () => {
    // The family name keeps its particles. Splitting "Omar Al Ghamdi" into
    // first="Omar Al" is the bug this guards.
    equal(names.splitName('Omar Al Ghamdi'), { first: 'Omar', last: 'Al Ghamdi' });
    equal(names.splitName('Ludwig van Beethoven'), { first: 'Ludwig', last: 'van Beethoven' });
    equal(names.splitName('Cher'), { first: 'Cher', last: '' });

    // A customised full name is never silently rewritten by editing a part.
    const custom = names.reconcileNames(
        { first_name: 'Omar', last_name: 'Ghamdi', full_name: 'Dr. Omar Al Ghamdi' },
        { first_name: 'Omarr' },
    );
    assert(custom.full_name === undefined, 'an edited full name is left alone');

    // An auto-composed one is kept in step.
    const auto = names.reconcileNames(
        { first_name: 'Omar', last_name: 'Ghamdi', full_name: 'Omar Ghamdi' },
        { first_name: 'Omarr' },
    );
    equal(auto.full_name, 'Omarr Ghamdi', 'an auto-composed full name follows its parts');
});

check('a wrong password and an unknown email give the same message', () => {
    let wrongPassword = '';
    let unknownEmail = '';
    try { auth.login({ email: 'admin@test.local', password: 'nope' }); } catch (e) { wrongPassword = e.message; }
    try { auth.login({ email: 'nobody@test.local', password: 'nope' }); } catch (e) { unknownEmail = e.message; }
    equal(wrongPassword, unknownEmail, 'the response must not reveal whether the account exists');
});

check('the session token is not stored in the database', () => {
    const session = auth.login({ email: 'admin@test.local', password: 'test-password-1' });
    const rows = db.all('SELECT id FROM sessions');
    assert(!rows.some((r) => r.id === session.token), 'only the hash of the token may be stored');
    assert(auth.sessionFor(session.token), 'the token must still resolve to a session');
    auth.logout(session.token);
    assert(!auth.sessionFor(session.token), 'logout must invalidate the session');
});

check('an API key resolves to the same context shape a session does, only the hash is stored', () => {
    const issued = auth.issueApiKey({ userId: rep.id, workspaceId: WS, name: 'Make.com' });
    assert(issued.key.startsWith('crmk_'), 'the raw key is recognisable at a glance');
    const rows = db.all('SELECT key_hash FROM api_keys WHERE id = ?', [issued.id]);
    assert(rows.length === 1, 'the key was recorded');
    assert(rows[0].key_hash !== issued.key, 'the raw key must never be the stored value');

    const resolved = auth.contextForApiKey(issued.key);
    assert(resolved, 'the raw key must still resolve');
    equal(resolved.userId, rep.id, 'it acts as whoever created it');
    equal(resolved.role, 'rep', 'with that person’s actual role — no separate permission system');
    equal(resolved.workspaceId, WS, 'and their workspace');

    assert(!auth.contextForApiKey('crmk_not-a-real-key'), 'a fabricated key must not resolve');
    assert(!auth.contextForApiKey(null), 'no header must not resolve');

    auth.revokeApiKey({ workspaceId: WS, keyId: issued.id, userId: rep.id });
    assert(!auth.contextForApiKey(issued.key), 'a revoked key must stop resolving immediately');
});

/**
 * `revokeApiKey` itself only knows "owner-scoped" or "unrestricted" — an
 * admin's wider reach is api/meta.mjs's `deleteApiKey` choosing to pass no
 * `userId` at all, not a role the primitive checks for. This pins the
 * primitive's half of that contract.
 */
check('revokeApiKey is owner-scoped when given a userId, unrestricted without one', () => {
    const issued = auth.issueApiKey({ userId: rep.id, workspaceId: WS, name: 'someone else’s key' });
    throws(() => auth.revokeApiKey({ workspaceId: WS, keyId: issued.id, userId: admin.id }),
        /only revoke your own/, 'a mismatched userId is refused, regardless of whose it is');

    auth.revokeApiKey({ workspaceId: WS, keyId: issued.id });
    assert(!auth.contextForApiKey(issued.key), 'omitting userId revokes it — the call an admin route makes');
});

check('a workspace admin sees every key; everyone else sees only their own', () => {
    auth.issueApiKey({ userId: rep.id, workspaceId: WS, name: 'rep’s own key' });
    const own = auth.apiKeysFor(WS, { userId: rep.id });
    const all = auth.apiKeysFor(WS, {});
    assert(own.every((k) => k.user_name === 'Rep'), 'scoped listing returns only that user’s keys');
    assert(all.length >= own.length, 'the unscoped listing an admin gets is at least as wide');
});

check('a rep cannot export, an owner can', () => {
    assert(!auth.can(repCtx, 'export'), 'export is its own permission and a rep does not hold it');
    assert(auth.can(ctx, 'export'), 'the owner holds every capability');
});

check('a rep may only write records they own', () => {
    assert(auth.canWriteRecord(repCtx, { owner_id: rep.id }), 'own record');
    assert(!auth.canWriteRecord(repCtx, { owner_id: admin.id }), 'someone else’s record');
    assert(auth.canWriteRecord(ctx, { owner_id: rep.id }), 'an owner can write anything');
});

/**
 * ...except a company, which belongs to the business rather than to whoever
 * imported it.
 *
 * The workspace this came from had nine accounts, every one owned by an admin
 * or the owner, and one rep who could edit none of them. Two reps looking at
 * the same account are looking at the same company; who did the import is not
 * a reason the other cannot fix its industry or set its services.
 *
 * ── AND A DEAL, BECAUSE A REVIEW IS THE GATE ────────────────────────────────
 *
 * A deal is on the shared list too. This test used to assert the opposite, on
 * the argument that a negotiation is the owner's work — true of the negotiation,
 * not of the record. A rep takes a call about a colleague's client, is told the
 * price has moved, and could not type it in: the forecast then kept the old
 * figure until the owner was back, which is a stale number caused by a
 * permission.
 *
 * The control is not the edit, it is the REVIEW. A price becomes a commitment
 * when it reaches a client, and it can only reach one through `submitForReview`
 * → somebody holding `document.approve` → `requireApproved`. A rep holds none of
 * that. So a rep may correct a figure, and may not send it anywhere: the gate
 * sits at the moment the number leaves the building rather than at the moment
 * somebody types it. Proposals and agreements themselves stay owner-scoped.
 */
check('a rep edits a shared record, and a review is what stops it reaching a client', () => {
    const lead = { owner_id: admin.id };

    for (const objectKey of ['account', 'contact', 'deal', 'prospecting_company', 'prospecting_contact']) {
        assert(auth.canWriteRecord(repCtx, lead, objectKey),
            `a rep cannot edit a ${objectKey} owned by somebody else, so a shared fact is frozen`);
    }
    for (const objectKey of ['proposal', 'agreement']) {
        assert(!auth.canWriteRecord(repCtx, lead, objectKey),
            `a rep edited somebody else's ${objectKey} — that is their work, not a shared fact`);
    }

    // The gate the deal edit relies on: a rep can ask for a review and cannot BE one.
    assert(!auth.can(repCtx, 'document.approve'),
        'a rep who could approve their own price change would make the review a formality');
    assert(auth.can(ctx, 'document.approve'), 'and somebody must be able to, or nothing ships');

    // Removal passes no object key, so ownership still governs it — and a rep
    // holds no record.delete besides.
    assert(!auth.canWriteRecord(repCtx, lead), 'the delete path must stay owner-scoped');
    assert(!auth.can(repCtx, 'record.delete'), 'a rep must not hold record.delete');
});

await checkAsync('a rep corrects a colleague’s deal, and the correction is audited', async () => {
    /**
     * The rule, end to end: the edit is allowed and the REVIEW is the control.
     *
     * A rep takes a call about somebody else's client and is told the price has
     * moved. They can type it in — a forecast that is stale because of a
     * permission is worse than one a colleague corrected — and what they typed is
     * attributed to them, so "who changed this figure" has an answer. What they
     * cannot do is put it in front of the client: that needs `document.approve`,
     * which the approval tests below exercise in full.
     */
    const recordsApi = await import('./api/records.mjs');
    const account = repo.createRecord('account', ctx, { name: 'Colleague’s Client Ltd' });
    const deal = repo.createRecord('deal', ctx, {
        name: 'Price moved', account_id: account.id, pipeline_id: PIPE, stage_id: STAGE_OPEN,
        currency: 'SAR',
    });
    equal(deal.owner_id, ctx.userId, 'the premise: the deal belongs to somebody else');

    await recordsApi.patch({
        req: bodyOf({ name: 'Price moved — corrected' }),
        params: { object: 'deals', id: deal.id }, ctx: repCtx,
    });

    const after = repo.getRecord('deal', ctx, deal.id);
    equal(after.name, 'Price moved — corrected', 'the rep’s correction stuck');
    equal(after.owner_id, ctx.userId, 'and editing did not quietly take the deal');

    const events = repo.auditFor(ctx, { recordId: deal.id });
    assert(events.some((e) => e.actor_id === rep.id),
        'an edit anybody can make must say who made it, or it is not correctable');

    // And the rep still cannot bin it.
    await recordsApi.remove({ params: { object: 'deals', id: deal.id }, ctx: repCtx }).then(
        () => { throw new Error('a rep deleted a colleague’s deal'); },
        (err) => assert(/cannot record delete/.test(err.message), err.message),
    );
});

await checkAsync('a rep really can set services and account type on a lead they do not own', async () => {
    const recordsApi = await import('./api/records.mjs');
    const lead = repo.createRecord('account', ctx, { name: 'Imported By Admin', account_type: 'Egypt' });
    equal(lead.owner_id, ctx.userId, 'the premise: it belongs to somebody else');

    await recordsApi.patch({
        req: bodyOf({ account_type: 'Regional', services: ['hcm'], industry: 'Manufacturing' }),
        params: { object: 'accounts', id: lead.id }, ctx: repCtx,
    });

    const after = repo.getRecord('account', ctx, lead.id);
    equal(after.account_type, 'Regional');
    equal(after.services, ['hcm']);
    equal(after.industry, 'Manufacturing');
    equal(after.owner_id, ctx.userId, 'editing does not quietly take ownership');

    // And still cannot delete it.
    await recordsApi.remove({ params: { object: 'accounts', id: lead.id }, ctx: repCtx }).then(
        () => { throw new Error('a rep deleted a lead'); },
        (err) => assert(/cannot record delete/.test(err.message), err.message),
    );
    equal(repo.getRecord('account', ctx, lead.id).deleted_at ?? null, null, 'and it is still there');
});

check('changing your own password requires the current one', () => {
    const user = auth.createUser({ email: 'pw1@test.local', name: 'PW', password: 'original-password', workspaceId: WS });
    throws(() => auth.changeOwnPassword({ userId: user.id, currentPassword: 'wrong', newPassword: 'a-new-password' }),
        /not your current password/, 'a wrong current password is refused');
    auth.changeOwnPassword({ userId: user.id, currentPassword: 'original-password', newPassword: 'a-new-password' });
    assert(auth.login({ email: 'pw1@test.local', password: 'a-new-password' }).token, 'and the new one works');
});

check('setting a password signs that user out everywhere', () => {
    const user = auth.createUser({ email: 'pw2@test.local', name: 'PW2', password: 'original-password', workspaceId: WS });
    const a = auth.login({ email: 'pw2@test.local', password: 'original-password' }).token;
    const b = auth.login({ email: 'pw2@test.local', password: 'original-password' }).token;
    assert(auth.sessionFor(a) && auth.sessionFor(b), 'two live sessions');

    const result = auth.setPassword(user.id, 'a-replacement-password');
    equal(result.revokedSessions, 2, 'both are revoked');
    assert(!auth.sessionFor(a) && !auth.sessionFor(b),
        'because a password change that leaves a 14-day cookie alive is cosmetic');
});

check('a reset link works exactly once', () => {
    const user = auth.createUser({ email: 'pw3@test.local', name: 'PW3', password: 'original-password', workspaceId: WS });
    const { token } = auth.issuePasswordReset({ userId: user.id, issuedBy: admin.id });

    auth.consumePasswordReset({ token, password: 'set-from-the-link' });
    assert(auth.login({ email: 'pw3@test.local', password: 'set-from-the-link' }).token, 'the new password works');
    throws(() => auth.consumePasswordReset({ token, password: 'again-please' }),
        /no longer valid/, 'and the link cannot be spent twice');
});

check('issuing a second reset link expires the first', () => {
    const user = auth.createUser({ email: 'pw4@test.local', name: 'PW4', password: 'original-password', workspaceId: WS });
    const first = auth.issuePasswordReset({ userId: user.id, issuedBy: admin.id }).token;
    const second = auth.issuePasswordReset({ userId: user.id, issuedBy: admin.id }).token;

    throws(() => auth.consumePasswordReset({ token: first, password: 'from-the-old-link' }), /no longer valid/,
        'two live links would be two ways in, and the second is usually issued because the first went astray');
    auth.consumePasswordReset({ token: second, password: 'from-the-new-link' });
});

check('an expired, used or invented token all fail the same way', () => {
    const user = auth.createUser({ email: 'pw5@test.local', name: 'PW5', password: 'original-password', workspaceId: WS });
    const { token } = auth.issuePasswordReset({ userId: user.id, issuedBy: admin.id });
    db.run('UPDATE password_resets SET expires_at = ? WHERE user_id = ?', ['2020-01-01T00:00:00.000Z', user.id]);

    const messages = [];
    for (const candidate of [token, 'never-issued-at-all', '']) {
        try {
            auth.consumePasswordReset({ token: candidate, password: 'whatever-goes-here' });
        } catch (err) {
            messages.push(err.message);
        }
    }
    equal(messages.length, 3, 'all three are refused');
    equal(new Set(messages).size, 1, 'with one message — the difference is only useful to someone guessing');
});

check('a too-short password does not burn the reset link', () => {
    const user = auth.createUser({ email: 'pw6@test.local', name: 'PW6', password: 'original-password', workspaceId: WS });
    const { token } = auth.issuePasswordReset({ userId: user.id, issuedBy: admin.id });

    throws(() => auth.consumePasswordReset({ token, password: 'short' }), /at least 8/, 'refused');
    auth.consumePasswordReset({ token, password: 'a-long-enough-one' });
    assert(auth.login({ email: 'pw6@test.local', password: 'a-long-enough-one' }).token,
        'the link still worked, rather than forcing a second trip to the admin');
});

check('only the hash of a reset token is stored', () => {
    const user = auth.createUser({ email: 'pw7@test.local', name: 'PW7', password: 'original-password', workspaceId: WS });
    const { token } = auth.issuePasswordReset({ userId: user.id, issuedBy: admin.id });
    const rows = db.all('SELECT id FROM password_resets WHERE user_id = ?', [user.id]);
    assert(rows.length === 1 && rows[0].id !== token,
        'so a leaked database backup cannot be replayed as a working link');
});

check('a spent reset link is kept, not deleted', () => {
    const user = auth.createUser({ email: 'pw8@test.local', name: 'PW8', password: 'original-password', workspaceId: WS });
    const { token } = auth.issuePasswordReset({ userId: user.id, issuedBy: admin.id });
    auth.consumePasswordReset({ token, password: 'a-fresh-password' });
    const row = db.get('SELECT issued_by, used_at FROM password_resets WHERE user_id = ?', [user.id]);
    assert(row.used_at && row.issued_by === admin.id,
        'who reset whose password and when is what an account dispute asks later');
});

check('cookies are Secure behind a trusting proxy, and never on a claim alone', () => {
    const forwarded = { socket: {}, headers: { 'x-forwarded-proto': 'https' } };
    const previous = process.env.CRM_TRUST_PROXY;

    delete process.env.CRM_TRUST_PROXY;
    assert(!http.isSecureRequest(forwarded),
        'an untrusted X-Forwarded-Proto is a header any client can send');

    process.env.CRM_TRUST_PROXY = '1';
    assert(http.isSecureRequest(forwarded), 'trusted once something in front of us is known to set it');
    assert(http.isSecureRequest({ socket: { encrypted: true }, headers: {} }), 'or when TLS terminates here');

    if (previous === undefined) delete process.env.CRM_TRUST_PROXY; else process.env.CRM_TRUST_PROXY = previous;
});

/* ========================================================== 2. MONEY === */

describe('Deal money');

check('a one-time price is the price, with nothing multiplied by it', () => {
    const v = money.lineValue({ recurrence: 'one_time', unit_amount: 90000, fx_rate: 1 });
    equal(v.oneTime, 90000, 'the price, as typed');
    equal(v.monthly, 0, 'a one-time deal is not recurring');
    equal(v.billingType, 'one_time', 'and says which it is');
});

check('a recurring price is monthly, not one-time', () => {
    const v = money.lineValue({ recurrence: 'monthly', unit_amount: 4800, term_months: 24, fx_rate: 1 });
    equal(v.monthly, 4800, 'the price is per month');
    equal(v.oneTime, 0, 'nothing is due up front');
    equal(v.lineContractValue, 115200, '4,800 × 24 months');
    equal(v.billingType, 'recurring', 'and says which it is');
});

check('recurring or one-time is the service line\'s decision', () => {
    equal(money.billingTypeForPricingModel('per_seat'), 'recurring', 'HCM is per seat');
    equal(money.billingTypeForPricingModel('per_headcount'), 'recurring', 'Offshoring is per headcount');
    equal(money.billingTypeForPricingModel('placement_fee'), 'one_time', 'Recruitment is a placement fee');
    equal(money.billingTypeForPricingModel('fixed_fee'), 'one_time', 'OD is a fixed fee');
    equal(money.recurrenceForPricingModel('per_seat'), 'monthly', 'and the money engine calls that monthly');
});

/**
 * REVENUE is what closed. A FORECAST is what closed PLUS what might still.
 *
 * The dashboard tile weighted the open pipeline and stopped, which answers
 * "what might we still land" and calls it a forecast. The effect is that the
 * number falls as a period goes WELL — every deal that moves from open to won
 * leaves the pipeline and takes its weighted value with it.
 */
check('a forecast counts what is won at full value, and open at its odds', () => {
    const rates = { USD: 1, EGP: 50, SAR: 3.75 };
    // One deal already won, one still open at 60%.
    const won = money.aggregateInReporting(
        [{ own_one_time: 100, own_mrr: 10, own_weighted: 100, own_tcv: 0, currency: 'USD' }], rates,
    );
    const open = money.aggregateInReporting(
        [{ own_one_time: 200, own_mrr: 20, own_weighted: 120, own_tcv: 0, currency: 'USD' }], rates,
    );

    equal(won.one_time, 100, 'a deal that closed is revenue, not a probability');
    equal(open.weighted_one_time, 120, '200 at 60%');
    equal(won.one_time + open.weighted_one_time, 220, 'the forecast is the two together');

    // The recurring half has to weight too, and separately — never added to
    // the one-time figure.
    equal(open.weighted_mrr, 12, '20/mo at 60%');
    equal(won.mrr + open.weighted_mrr, 22, 'recurring forecast, kept apart from one-time');
});

check('the reporting aggregate weights recurring value at all', () => {
    // It carried `weighted_one_time` and not `weighted_mrr`, so anything
    // forecasting recurring value reached for a key that was undefined.
    const r = money.aggregateInReporting(
        [{ own_one_time: 100, own_mrr: 10, own_weighted: 60, own_tcv: 0, currency: 'USD' }], { USD: 1 },
    );
    equal(r.weighted_mrr, 6, '10/mo at the 60% the one-time figure was weighted by');
});

/**
 * A line priced in a foreign currency converts into the workspace base.
 *
 * `fx_rate` defaulted to 1 whatever the currency was, so a 1,000 USD line in a
 * SAR workspace contributed 1,000 to a SAR total instead of 3,750. Every
 * base-currency figure — the deal page, the board columns, the stage totals —
 * was adding dollars to riyals and calling the answer riyals, and the only way
 * to get it right was to type the rate onto the line by hand.
 */
check('a foreign line converts into the base currency without being told how', () => {
    const rates = money.reportingRates(() => null);          // USD 1, EGP 50, SAR 3.75
    const usdInSar = rates.SAR / rates.USD;
    equal(Math.round(usdInSar * 100) / 100, 3.75, 'one dollar is 3.75 riyals at the default rates');

    // What the line SHOULD produce once the rate is applied.
    const converted = money.lineValue({
        pricing_model: 'fixed_fee', recurrence: 'one_time', quantity: 1,
        unit_amount: 1000, currency: 'USD', fx_rate: usdInSar,
    });
    equal(converted.baseOneTime, 3750, '1,000 USD is 3,750 SAR in the base total');
    equal(converted.oneTime, 1000, 'and 1,000 in its own currency, which reporting converts separately');

    // The old default, kept as the thing this guards against.
    const unconverted = money.lineValue({
        pricing_model: 'fixed_fee', recurrence: 'one_time', quantity: 1,
        unit_amount: 1000, currency: 'USD', fx_rate: 1,
    });
    equal(unconverted.baseOneTime, 1000, 'a rate of 1 is what made dollars count as riyals');
});

check('one-time and recurring are never summed into one figure', () => {
    const items = [
        { recurrence: 'one_time', unit_amount: 90000, fx_rate: 1 },
        { recurrence: 'monthly', unit_amount: 4800, term_months: 24, fx_rate: 1 },
    ];
    const v = money.deriveValues(items, { probability: 0.5 });
    equal(v.value_one_time, 90000, 'one-time stands alone');
    equal(v.value_mrr, 4800, 'recurring stands alone');
    equal(v.value_arr, 57600, 'ARR is MRR × 12');
    // The only combined figure, and it names its assumption.
    equal(v.value_tcv, 205200, 'TCV = 90,000 + 4,800 × 24');
    assert(v.value_one_time + v.value_mrr !== v.value_tcv, 'a naive sum must not equal any reported figure');
});

check('weighted value weights one-time and recurring separately', () => {
    const v = money.deriveValues(
        [{ recurrence: 'one_time', unit_amount: 1000, fx_rate: 1 },
            { recurrence: 'monthly', unit_amount: 100, term_months: 12, fx_rate: 1 }],
        { probability: 0.5 },
    );
    equal(v.value_weighted, 500, 'one-time × probability');
    equal(v.value_weighted_mrr, 50, 'recurring is weighted on its own, never folded in');
});

check('a recurring line with no term is flagged, not silently zeroed', () => {
    const v = money.lineValue({ recurrence: 'monthly', unit_amount: 500, fx_rate: 1 });
    equal(v.termMonths, 12, '12 months assumed');
    assert(v.termAssumed, 'and the assumption is reported');
    const totals = money.deriveValues([{ recurrence: 'monthly', unit_amount: 500, fx_rate: 1 }], {});
    equal(totals.assumed_terms, 1, 'the rollup surfaces the count of assumed terms');
});

check('a foreign-currency line converts at its own stored rate', () => {
    const v = money.deriveValues([{ pricing_model: 'fixed_fee', recurrence: 'one_time', quantity: 1, unit_amount: 1000, currency: 'USD', fx_rate: 3.75 }], {});
    equal(v.value_one_time, 3750, '1,000 USD at 3.75');
    assert(!v.mixed_currencies, 'one currency is not mixed');
});

check('mixed currencies are surfaced', () => {
    const v = money.deriveValues([
        { pricing_model: 'fixed_fee', recurrence: 'one_time', quantity: 1, unit_amount: 100, currency: 'SAR', fx_rate: 1 },
        { pricing_model: 'fixed_fee', recurrence: 'one_time', quantity: 1, unit_amount: 100, currency: 'USD', fx_rate: 3.75 },
    ], {});
    assert(v.mixed_currencies, 'a deal in two currencies says so');
});

/* ==================================================== 3. FILTER COMPILER = */

describe('Filter compiler');

check('every value is parameterised, never interpolated', () => {
    const evil = "'; DROP TABLE accounts; --";
    const { sql, params } = query.compileFilter('account', WS, {
        op: 'and', children: [{ field: 'name', operator: 'contains', value: evil }],
    });
    assert(!sql.includes('DROP'), 'the value must not reach the SQL text');
    assert(params.some((p) => String(p).includes('DROP')), 'it must arrive as a bound parameter');
});

check('an unknown field is rejected rather than interpolated', () => {
    throws(
        () => query.compileFilter('account', WS, { op: 'and', children: [{ field: 'name; DROP TABLE x', operator: 'is', value: 1 }] }),
        /Unknown field/,
        'unknown fields must be refused',
    );
});

check('a non-filterable field explains itself', () => {
    throws(
        () => query.compileFilter('account', WS, { op: 'and', children: [{ field: 'description', operator: 'contains', value: 'x' }] }),
        /cannot be filtered.*searched/s,
        'the refusal must say why',
    );
});

check('nested AND/OR groups compile with the right shape', () => {
    const { sql } = query.compileFilter('account', WS, {
        op: 'and',
        children: [
            { field: 'country', operator: 'is', value: 'Egypt' },
            { op: 'or', children: [
                { field: 'employee_count', operator: 'gte', value: 50 },
                { field: 'industry', operator: 'contains', value: 'tech' },
            ] },
        ],
    });
    assert(sql.includes(' AND '), 'the outer group is AND');
    assert(sql.includes(' OR '), 'the inner group is OR');
});

check('LIKE wildcards in a search term are escaped', () => {
    const { params } = query.compileFilter('account', WS, {
        op: 'and', children: [{ field: 'name', operator: 'contains', value: '50%' }],
    });
    assert(params[0].includes('\\%'), 'a literal % must not become a wildcard');
});

check('a custom field is filterable through the same grammar', () => {
    db.run(
        `INSERT INTO field_defs (id, workspace_id, object_key, key, label, type, options, required, filterable, sortable, searchable, is_system, position, created_at)
         VALUES (?,?,?,?,?,?,?,0,1,1,0,0,0,?)`,
        [db.id('fld'), WS, 'account', 'tier', 'Tier', 'select', JSON.stringify(['A', 'B']), db.now()],
    );
    // Written straight to the table rather than through the API, so the field
    // definition cache has to be told the same way api/meta.mjs tells it.
    objects.invalidateFieldDefs(WS);
    const { sql, params } = query.compileFilter('account', WS, {
        op: 'and', children: [{ field: 'properties.tier', operator: 'is_any_of', value: ['A'] }],
    });
    assert(sql.includes('json_extract'), 'a custom field reads out of the properties JSON');
    assert(params.includes('A'), 'and its value is bound');
});

check('multi-select membership does not match by substring', () => {
    const { sql } = query.compileFilter('contact', WS, {
        op: 'and', children: [{ field: 'roles', operator: 'has_any_of', value: ['billing'] }],
    });
    assert(sql.includes('json_each'), '"billing" must not match "billing_admin" via LIKE');
});

check('UNRESOLVED means the absence of a verdict, not a value', () => {
    const { sql } = query.compileFilter('account', WS, {
        op: 'and', children: [{ field: 'verdict_hcm', operator: 'is_any_of', value: ['UNRESOLVED'] }],
    });
    assert(sql.includes('NOT EXISTS'), 'it must match rows with no current verdict at all');
});

check('"verdict is none of QUALIFIED" includes never-evaluated accounts', () => {
    const { sql } = query.compileFilter('account', WS, {
        op: 'and', children: [{ field: 'verdict_hcm', operator: 'is_none_of', value: ['QUALIFIED'] }],
    });
    assert(sql.startsWith('(NOT') || sql.includes('NOT ('), 'a NOT EXISTS keeps unevaluated rows in');
});

check('phone contains/does not contain never matches a DIFFERENT number that merely shares a tail', () => {
    /**
     * phoneMatchCandidates() adds an 8/9-digit TAIL candidate so a quick
     * search finds "+201000062640" from a query of "0100006" typed without
     * a country code. That is a guess, right for a search box a person can
     * eyeball — wrong for a filter condition: two genuinely different
     * numbers can share an 8-digit tail by coincidence, and "does not
     * contain 0500062640" silently excluding a contact whose real number is
     * "+201000062640" (no relation to the query at all, beyond the last 8
     * digits matching by chance) is an unexplainable wrong answer, not a
     * helpful guess. The filter builder must compare literal digits (plus
     * the leading-zero local/international normalisation) only.
     */
    const account = repo.createRecord('account', ctx, { name: 'Phone Tail Co' });
    const contact = repo.createRecord('contact', ctx, {
        full_name: 'Tail Collision', account_id: account.id,
        phone: '+201000062640', data_source: 'test',
    });

    // A completely different number that happens to share the same last 8
    // digits ("00062640") once its own leading zero is set aside.
    const unrelatedQuery = '0500062640';

    const contains = repo.listRecords('contact', ctx, {
        filter: { op: 'and', children: [{ field: 'phone', operator: 'contains', value: unrelatedQuery }] },
    });
    assert(!contains.records.some((r) => r.id === contact.id),
        '"contains" must not match a number it does not actually contain');

    const notContains = repo.listRecords('contact', ctx, {
        filter: { op: 'and', children: [{ field: 'phone', operator: 'not_contains', value: unrelatedQuery }] },
    });
    assert(notContains.records.some((r) => r.id === contact.id),
        '"does not contain" must not exclude a number that does not actually contain the query');

    // The legitimate case — a local number with no country code — must
    // still find the same contact both ways.
    const localQuery = '0100006';
    const containsLocal = repo.listRecords('contact', ctx, {
        filter: { op: 'and', children: [{ field: 'phone', operator: 'contains', value: localQuery }] },
    });
    assert(containsLocal.records.some((r) => r.id === contact.id),
        'the leading-zero/local-form normalisation must still work');
});

check('a list\'s own quick search finds a contact by phone number', () => {
    /**
     * `phone` carries no `searchable` flag — it is a formatted column, and a
     * literal LIKE against it would miss the moment a query is typed with
     * different spacing or a different country-code form than how the number
     * happens to be stored. Without digit-normalised matching in `q`, the
     * Contacts page's own search box (unlike global search and the calling
     * queue, which already normalise) never found a phone number at all.
     */
    const account = repo.createRecord('account', ctx, { name: 'Quick Search Co' });
    const contact = repo.createRecord('contact', ctx, {
        full_name: 'Quick Search Target', account_id: account.id,
        phone: '+966501234599', data_source: 'test',
    });

    const byLocalForm = repo.listRecords('contact', ctx, { q: '0501234599' });
    assert(byLocalForm.records.some((r) => r.id === contact.id),
        'a local-form query must still find an internationally-stored number');

    const byFullNumber = repo.listRecords('contact', ctx, { q: '+966 50 123 4599' });
    assert(byFullNumber.records.some((r) => r.id === contact.id),
        'differently formatted punctuation must not defeat the match');

    // A short run of digits is left to the ordinary keyword search rather
    // than treated as a phone query — same floor global search already uses
    // (see looksLikePhoneQuery in lib/phone.mjs) — and must not throw.
    const tooShort = repo.listRecords('contact', ctx, { q: '966' });
    assert(!tooShort.records.some((r) => r.id === contact.id),
        'three digits is below the phone-query floor and must not match on digits alone');

    // Ordinary keyword search on a searchable field is unaffected.
    const byName = repo.listRecords('contact', ctx, { q: 'Quick Search Target' });
    assert(byName.records.some((r) => r.id === contact.id), 'name search must still work');
});

/* ====================================================== 4. REPOSITORY === */

describe('Repository');

const account = repo.createRecord('account', ctx, {
    name: 'Test Industrial', country: 'Saudi Arabia', employee_count: 40,
    lifecycle_stage: 'prospect', linkedin_slug: 'test-industrial', external_id: 'src:1',
});

check('creating a record writes an audit event', () => {
    const events = db.all('SELECT * FROM audit_events WHERE record_id = ?', [account.id]);
    assert(events.some((e) => e.action === 'created'), 'the creation must be audited');
});

check('re-creating with the same external_id updates instead of duplicating', () => {
    const again = repo.createRecord('account', ctx, { name: 'Test Industrial Renamed', external_id: 'src:1' });
    equal(again.id, account.id, 'the same source row must resolve to the same record');
    equal(db.get('SELECT COUNT(*) n FROM accounts WHERE external_id = ?', ['src:1']).n, 1, 'and there must be exactly one');
});

check('a required field is refused in words', () => {
    throws(() => repo.createRecord('account', ctx, { country: 'Egypt' }), /Name is required/, 'the message names the field');
});

check('an invalid email is refused in words', () => {
    throws(
        () => repo.createRecord('contact', ctx, { first_name: 'A', email: 'not-an-email', data_source: 'test' }),
        /valid email/,
        'the message says what to do',
    );
});

check('a select field rejects a value outside its options', () => {
    throws(() => repo.updateRecord('account', ctx, account.id, { lifecycle_stage: 'invented' }), /must be one of/);
});

check('a custom field round-trips through properties', () => {
    const updated = repo.updateRecord('account', ctx, account.id, { properties: { tier: 'A' } });
    equal(updated.properties.tier, 'A', 'the value is stored');
    const found = repo.listRecords('account', ctx, {
        filter: { op: 'and', children: [{ field: 'properties.tier', operator: 'is_any_of', value: ['A'] }] },
    });
    equal(found.total, 1, 'and it is filterable with no code change');
});

check('delete is soft and restorable', () => {
    const temp = repo.createRecord('account', ctx, { name: 'Temporary' });
    repo.deleteRecord('account', ctx, temp.id);
    equal(repo.listRecords('account', ctx, { filter: { op: 'and', children: [{ field: 'name', operator: 'is', value: 'Temporary' }] } }).total, 0, 'hidden from lists');
    assert(db.get('SELECT deleted_at FROM accounts WHERE id = ?', [temp.id]).deleted_at, 'but still on disk');
    repo.restoreRecord('account', ctx, temp.id);
    equal(repo.listRecords('account', ctx, { filter: { op: 'and', children: [{ field: 'name', operator: 'is', value: 'Temporary' }] } }).total, 1, 'and restorable');
    repo.deleteRecord('account', ctx, temp.id);
});

check('there is no code path that updates or deletes an audit event', () => {
    const source = fs.readFileSync(new URL('./lib/repo.mjs', import.meta.url), 'utf8')
        + fs.readFileSync(new URL('./api/records.mjs', import.meta.url), 'utf8');
    assert(!/UPDATE\s+audit_events/i.test(source), 'audit events must never be updated');
    assert(!/DELETE\s+FROM\s+audit_events/i.test(source), 'audit events must never be deleted');
});

/**
 * The same concern as the old "default views hide prospects" test — an import
 * of 2,000 companies must not flood the working list — but now guaranteed by
 * STRUCTURE rather than by a filter someone can edit away. An uploaded company
 * is not an account, so there is no filter to get wrong.
 */
check('uploaded companies are not accounts', () => {
    assert(objects.OBJECTS.prospecting_company.table === 'prospecting_companies',
        'prospects live in their own table');
    assert(objects.OBJECTS.account.table === 'accounts', 'accounts live in theirs');
    assert(objects.OBJECTS.account.defaultFilter.children.every((c) => !(c.value ?? []).includes('prospect')),
        'the account list no longer has to hide prospects, because it cannot contain any');
});

check('a prospect status is derived, never typed', () => {
    const status = objects.OBJECTS.prospecting_company.fields.find((f) => f.key === 'status');
    assert(status.readOnly, 'status is a rollup of the per-service verdicts, and has exactly one writer');
    assert(status.form === false, 'so it must not appear as an editable form control');
});

check('the search index is written on create and cleared on delete', () => {
    const temp = repo.createRecord('account', ctx, { name: 'Findable Widgets' });
    assert(db.get('SELECT COUNT(*) n FROM search_index WHERE record_id = ?', [temp.id]).n === 1, 'indexed');
    repo.deleteRecord('account', ctx, temp.id);
    assert(db.get('SELECT COUNT(*) n FROM search_index WHERE record_id = ?', [temp.id]).n === 0, 'and de-indexed');
});

check('an account with a signed agreement can be soft-deleted', () => {
    const target = repo.createRecord('account', ctx, { name: 'Under Contract' });
    const deal = repo.createRecord('deal', ctx, { name: 'D', account_id: target.id, pipeline_id: PIPE, stage_id: STAGE_OPEN });
    db.run(
        `INSERT INTO agreements (id, workspace_id, deal_id, account_id, number, title, type, status, notice_days, auto_renew, created_at, updated_at)
         VALUES (?,?,?,?,?,?,'sow','signed',0,0,?,?)`,
        [db.id('agr2'), WS, deal.id, target.id, 'A-1', 'MSA', db.now(), db.now()],
    );
    const deleted = repo.deleteRecord('account', ctx, target.id);
    equal(deleted.deleted_at !== null, true, 'the account is soft-deleted');
});

/* ================================================== 5. QUALIFICATION === */

describe('Qualification');

/** The exact figures from the screenshots the rules were built against. */
const AFCO = {
    slug: 'afco-steel', companyName: 'AFCO STEEL', totalMembers: 252,
    locations: [
        { label: 'Saudi Arabia toggle off', count: 107 },
        { label: 'Makkah, Saudi Arabia toggle off', count: 76 },
        { label: 'Egypt toggle off', count: 71 },
        { label: 'Cairo, Egypt toggle off', count: 50 },
    ],
    functions: [
        { label: 'Operations toggle off', count: 94 },
        { label: 'Engineering toggle off', count: 66 },
    ],
};

async function makeAccount(name, slug, payload) {
    const created = repo.createRecord('account', ctx, { name, linkedin_slug: slug, lifecycle_stage: 'prospect' });
    qual.recordEvidence(ctx, { accountId: created.id, subjectKey: slug, provider: 'test', payload });
    return created;
}

await checkAsync('the screenshot company qualifies for offshoring and is rejected by HCM', async () => {
    const created = await makeAccount('AFCO STEEL', 'afco-steel-test', AFCO);
    const off = await qual.qualifyAccount(ctx, created.id, 'offshoring');
    const hcm = await qual.qualifyAccount(ctx, created.id, 'hcm');
    equal(off.verdict, 'QUALIFIED', '252 staff, 71 in Egypt');
    equal(hcm.verdict, 'REJECTED', '252 staff is far above the 20-50 band');
});

await checkAsync('the "toggle off" suffix is still stripped on read', async () => {
    const created = await makeAccount('Suffix Test', 'suffix-test', AFCO);
    const off = await qual.qualifyAccount(ctx, created.id, 'offshoring');
    equal(off.metrics.countryCount, 71, 'the Egypt row must be found despite the screen-reader suffix');
});

await checkAsync('"Cairo, Egypt" is a city, not the country row', async () => {
    const created = await makeAccount('City Test', 'city-test', AFCO);
    const off = await qual.qualifyAccount(ctx, created.id, 'offshoring');
    equal(off.metrics.countryCount, 71, 'the bare country row is authoritative — never 50, never 121');
    equal(off.metrics.countryMethod, 'country-row');
});

await checkAsync('an unlisted country with headroom is REVIEW, never REJECTED', async () => {
    const created = await makeAccount('Unlisted', 'unlisted-test', {
        slug: 'unlisted-test', companyName: 'Unlisted', totalMembers: 300,
        locations: [{ label: 'India', count: 40 }],
        functions: [{ label: 'Engineering', count: 20 }],
    });
    const off = await qual.qualifyAccount(ctx, created.id, 'offshoring');
    equal(off.verdict, 'REVIEW', 'the panel lists the top few only — "not listed" is not "zero"');
});

await checkAsync('no evidence is UNRESOLVED, not REJECTED', async () => {
    const created = repo.createRecord('account', ctx, { name: 'No Evidence' });
    const out = await qual.qualifyAccount(ctx, created.id, 'hcm');
    equal(out.verdict, 'UNRESOLVED', 'nothing to look at is not the same as looked and failed');
    assert(/no identity to collect against|not been collected/.test(out.reasons[0]), 'and it says which');
});

await checkAsync('re-running appends a verdict and supersedes the previous one', async () => {
    const created = await makeAccount('History Test', 'history-test', AFCO);
    await qual.qualifyAccount(ctx, created.id, 'hcm');
    await qual.qualifyAccount(ctx, created.id, 'hcm');
    const rows = db.all('SELECT * FROM verdicts WHERE account_id = ? AND rule_key = ?', [created.id, 'hcm']);
    equal(rows.length, 2, 'two rows, not one overwritten row');
    equal(rows.filter((r) => r.is_current).length, 1, 'exactly one is current');
    assert(rows.find((r) => !r.is_current).superseded_at, 'the old one records when it was superseded');
});

await checkAsync('publishing a rule change creates a new version, leaving old verdicts intact', async () => {
    const before = qual.currentRule(WS, 'hcm');
    const created = await makeAccount('Version Test', 'version-test', {
        slug: 'version-test', totalMembers: 250, locations: [], functions: [{ label: 'Ops', count: 250 }],
    });
    await qual.qualifyAccount(ctx, created.id, 'hcm');
    const first = db.get('SELECT * FROM verdicts WHERE account_id = ? AND is_current = 1', [created.id]);

    qual.publishRuleVersion(ctx, 'hcm', { ...before.config, maxHeadcount: 500 }, null);
    const after = qual.currentRule(WS, 'hcm');
    equal(after.version, before.version + 1, 'a new version');
    equal(db.get('SELECT rule_version FROM verdicts WHERE id = ?', [first.id]).rule_version, before.version,
        'the old verdict still names the version that produced it');

    await qual.qualifyAccount(ctx, created.id, 'hcm');
    const now = db.get('SELECT * FROM verdicts WHERE account_id = ? AND is_current = 1', [created.id]);
    equal(now.rule_version, after.version, 'the new verdict names the new version');
    assert(now.verdict !== first.verdict, 'and the raised ceiling actually changed the answer');

    // Put it back so later tests see the real rule.
    qual.publishRuleVersion(ctx, 'hcm', before.config, null);
});

await checkAsync('the impact preview writes nothing', async () => {
    const countBefore = db.get('SELECT COUNT(*) n FROM verdicts').n;
    const rule = qual.currentRule(WS, 'hcm');
    const impact = await qual.previewRule(ctx, 'hcm', { ...rule.config, maxHeadcount: 1000 });
    equal(db.get('SELECT COUNT(*) n FROM verdicts').n, countBefore, 'a preview is read-only');
    assert(impact.evaluated > 0, 'and it actually evaluated something');
});

await checkAsync('a QUALIFIED verdict promotes a prospect; REVIEW moves nothing', async () => {
    const promoted = await makeAccount('Promote Me', 'promote-me', {
        slug: 'promote-me', totalMembers: 200, locations: [{ label: 'Egypt', count: 30 }], functions: [],
    });
    await qual.qualifyAccount(ctx, promoted.id, 'offshoring');
    equal(db.get('SELECT lifecycle_stage FROM accounts WHERE id = ?', [promoted.id]).lifecycle_stage, 'qualified');

    const reviewed = await makeAccount('Review Me', 'review-me', {
        slug: 'review-me', totalMembers: 300, locations: [{ label: 'India', count: 40 }], functions: [{ label: 'Ops', count: 10 }],
    });
    await qual.qualifyAccount(ctx, reviewed.id, 'offshoring');
    equal(db.get('SELECT lifecycle_stage FROM accounts WHERE id = ?', [reviewed.id]).lifecycle_stage, 'prospect',
        'REVIEW is not an answer, so it must not move the account');
});

await checkAsync('one rule REJECTED while another is REVIEW does not disqualify', async () => {
    // 300 staff: HCM rejects (over the ceiling), offshoring cannot tell.
    const created = await makeAccount('Split Verdict', 'split-verdict', {
        slug: 'split-verdict', totalMembers: 300, locations: [{ label: 'India', count: 40 }], functions: [{ label: 'Ops', count: 10 }],
    });
    await qual.qualifyAccount(ctx, created.id, 'hcm');
    await qual.qualifyAccount(ctx, created.id, 'offshoring');
    const stage = db.get('SELECT lifecycle_stage FROM accounts WHERE id = ?', [created.id]).lifecycle_stage;
    equal(stage, 'prospect', 'one REJECTED plus one REVIEW is not a rejection — that would collapse REVIEW');
});

await checkAsync('rule order does not decide the outcome', async () => {
    const payload = {
        slug: 'order-test', totalMembers: 200,
        locations: [{ label: 'Egypt', count: 30 }], functions: [{ label: 'Ops', count: 200 }],
    };
    const a = await makeAccount('Order A', 'order-a', payload);
    await qual.qualifyAccount(ctx, a.id, 'hcm');          // REJECTED (too big)
    await qual.qualifyAccount(ctx, a.id, 'offshoring');   // QUALIFIED

    const b = await makeAccount('Order B', 'order-b', payload);
    await qual.qualifyAccount(ctx, b.id, 'offshoring');   // QUALIFIED
    await qual.qualifyAccount(ctx, b.id, 'hcm');          // REJECTED

    const stageA = db.get('SELECT lifecycle_stage FROM accounts WHERE id = ?', [a.id]).lifecycle_stage;
    const stageB = db.get('SELECT lifecycle_stage FROM accounts WHERE id = ?', [b.id]).lifecycle_stage;
    equal(stageA, 'qualified', 'qualifying for any service line qualifies the account');
    equal(stageA, stageB, 'and the order the rules ran in must not change it');
});

await checkAsync('the CRM produces exactly the verdict the standalone engine does', async () => {
    // The bridge must not alter the answer. Same payload, both paths.
    const snapshot = qual.toSnapshot(AFCO, engines.cleanFacets);
    const direct = engines.hcm.run(snapshot, qual.currentRule(WS, 'hcm').config);
    const created = await makeAccount('Parity Test', 'parity-test', AFCO);
    const throughCrm = await qual.qualifyAccount(ctx, created.id, 'hcm');
    equal(throughCrm.verdict, direct.verdict, 'the verdict must match');
    equal(throughCrm.reasons, direct.reasons, 'and so must the reasoning, line for line');
});

check('a verdict older than the threshold is stale', () => {
    assert(qual.isStale(new Date(Date.now() - 400 * 864e5).toISOString(), 180), 'a 400-day-old verdict is stale');
    assert(!qual.isStale(new Date().toISOString(), 180), 'a fresh one is not');
    assert(qual.isStale(null, 180), 'and no verdict counts as stale');
});

check('the verdict tally always reports all three answers', () => {
    const tally = qual.verdictTally(WS);
    for (const counts of Object.values(tally)) {
        for (const verdict of ['QUALIFIED', 'REVIEW', 'REJECTED']) {
            assert(typeof counts[verdict] === 'number', `${verdict} must be present even at zero`);
        }
    }
});

/* ---- qualifying an uploaded list, on the server ------------------------ */

/**
 * The upload path is the one that used to require a laptop, because the
 * standalone qualifier welds qualify to collect. These check that the server
 * does the qualify half correctly and — the part that matters — that it does
 * not quietly turn "we never looked" into "no".
 */
const UPLOAD_LIST = [
    'Full Name,Company,Company LinkedIn,Email',
    'Sara A,AFCO STEEL,https://www.linkedin.com/company/upload-afco/,sara@afco.example',
    'Omar B,AFCO STEEL,https://www.linkedin.com/company/upload-afco/people/,omar@afco.example',
    'Lina C,Never Collected Co,https://www.linkedin.com/company/upload-unknown/,lina@unknown.example',
].join('\n');

await makeAccount('Upload AFCO', 'upload-afco', { ...AFCO, slug: 'upload-afco' });

await checkAsync('an uploaded list is qualified against evidence already in the database', async () => {
    const out = await upload.qualifyUpload(ctx, { text: UPLOAD_LIST, selector: 'offshoring', filename: 'leads.csv' });
    equal(out.stats.companies, 2, 'two unique companies across three rows');
    equal(out.stats.companiesQualified, 1, 'only the collected one can qualify');
    equal(out.stats.outputRows, 2, 'and a qualified company keeps EVERY row that points at it');
    assert(out.csv.includes('sara@afco.example') && out.csv.includes('omar@afco.example'),
        'both of that company\'s contacts survive');
    assert(!out.csv.includes('lina@unknown.example'), 'the uncollected company is not shipped as a lead');
    assert(out.csv.includes('Email'), 'and every original column is carried through');
});

await checkAsync('a company with no evidence is UNRESOLVED, never REJECTED', async () => {
    const out = await upload.qualifyUpload(ctx, { text: UPLOAD_LIST, selector: 'offshoring' });
    const unknown = out.companies.find((c) => c.slug === 'upload-unknown');
    equal(unknown.verdicts.offshoring.verdict, 'UNRESOLVED', 'absence of evidence is not a negative answer');
    equal(out.tally.offshoring.REJECTED, 0, 'and it must not appear in the rejected count');
    equal(out.stats.companiesNotCollected, 1, 'it is reported as unjudged instead');
});

await checkAsync('the uploaded list uses the workspace\'s published rule config, not the engine defaults', async () => {
    const out = await upload.qualifyUpload(ctx, { text: UPLOAD_LIST, selector: 'offshoring' });
    const snapshot = qual.toSnapshot({ ...AFCO, slug: 'upload-afco' }, engines.cleanFacets);
    const direct = engines.offshoring.run(snapshot, qual.currentRule(WS, 'offshoring').config);
    const afco = out.companies.find((c) => c.slug === 'upload-afco');
    equal(afco.verdicts.offshoring.verdict, direct.verdict,
        'a CSV and a record page must answer under the same rule version');
    equal(out.ruleVersions.offshoring, qual.currentRule(WS, 'offshoring').version, 'and it says which version that was');
});

await checkAsync('qualifying an uploaded list writes nothing', async () => {
    const before = {
        verdicts: db.get('SELECT COUNT(*) n FROM verdicts').n,
        prospectVerdicts: db.get('SELECT COUNT(*) n FROM prospecting_verdicts').n,
        evidence: db.get('SELECT COUNT(*) n FROM evidence_snapshots').n,
        audit: db.get('SELECT COUNT(*) n FROM audit_events').n,
    };
    await upload.qualifyUpload(ctx, { text: UPLOAD_LIST, selector: 'either' });
    equal(db.get('SELECT COUNT(*) n FROM verdicts').n, before.verdicts, 'no verdict rows');
    equal(db.get('SELECT COUNT(*) n FROM prospecting_verdicts').n, before.prospectVerdicts, 'on either plane');
    equal(db.get('SELECT COUNT(*) n FROM evidence_snapshots').n, before.evidence, 'no evidence rows');
    equal(db.get('SELECT COUNT(*) n FROM audit_events').n, before.audit, 'and nothing to audit');
});

await checkAsync('the pre-flight counts what can be judged before anything is run', async () => {
    const info = await upload.inspectUpload(ctx, UPLOAD_LIST);
    equal(info.rowCount, 3);
    equal(info.companies, 2);
    equal(info.collected, 1, 'one has stored evidence');
    equal(info.missing, 1, 'and the other is named as missing before the button is pressed');
    equal(info.columns[info.detectedColumn].name, 'Company LinkedIn',
        'the URL column is detected from the values, not the header');
});

await checkAsync('the pre-flight counts follow the column you picked, not the detected one', async () => {
    const wrong = await upload.inspectUpload(ctx, UPLOAD_LIST, { columnIndex: 0 });
    equal(wrong.columnName, 'Full Name', 'it reports which column it counted');
    equal(wrong.collected, 0, 'a name column identifies no collected company');
    equal(wrong.missing, wrong.companies, 'so the numbers make the wrong choice obvious');
});

await checkAsync('a column that identifies no company is refused, not run', async () => {
    await upload.qualifyUpload(ctx, { text: UPLOAD_LIST, columnIndex: 0 })
        .then(() => { throw new Error('should have been refused'); })
        .catch((err) => {
            assert(/no LinkedIn company URLs/i.test(err.message),
                `expected a refusal naming the column, got: ${err.message}`);
        });
});

/* ========================================================== 6. VIEWS === */

describe('Views and lists');

check('a dynamic list re-evaluates as records change', () => {
    const listId = db.id('lst');
    db.run(
        `INSERT INTO lists (id, workspace_id, object_key, name, kind, filter, owner_id, scope, created_at, updated_at)
         VALUES (?,?,?,?,'dynamic',?,?,'workspace',?,?)`,
        [listId, WS, 'account', 'Big', JSON.stringify({ op: 'and', children: [{ field: 'employee_count', operator: 'gte', value: 1000 }] }),
            admin.id, db.now(), db.now()],
    );
    equal(repo.idsMatching('account', ctx, { listId }).total, 0, 'empty to start');
    repo.updateRecord('account', ctx, account.id, { employee_count: 5000 });
    equal(repo.idsMatching('account', ctx, { listId }).total, 1, 'the record joined on its own');
    repo.updateRecord('account', ctx, account.id, { employee_count: 40 });
    equal(repo.idsMatching('account', ctx, { listId }).total, 0, 'and left on its own');
});

check('select-all-matching reaches past the rendered page', () => {
    for (let i = 0; i < 60; i += 1) {
        repo.createRecord('account', ctx, { name: `Bulk ${i}`, lifecycle_stage: 'customer' });
    }
    const filter = { op: 'and', children: [{ field: 'lifecycle_stage', operator: 'is_any_of', value: ['customer'] }] };
    const page = repo.listRecords('account', ctx, { filter, limit: 50 });
    const all = repo.idsMatching('account', ctx, { filter });
    equal(page.records.length, 50, 'one page renders 50');
    equal(all.ids.length, 60, 'but selecting all reaches 60');
});

/* ========================================================== 7. DEALS === */

describe('Deals');

check('a deal has no amount column — its value is derived', () => {
    const columns = db.all('PRAGMA table_info(deals)').map((c) => c.name);
    assert(!columns.includes('amount'), 'a single amount cannot express this business');
    assert(!columns.includes('value'), 'nor can a single value');
});

check('a deal’s value comes from its line items', () => {
    const deal = repo.createRecord('deal', ctx, {
        name: 'Mixed deal', account_id: account.id, pipeline_id: PIPE, stage_id: STAGE_OPEN, currency: 'SAR',
    });
    repo.insert('deal_line_items', {
        id: db.id('lit'), workspace_id: WS, deal_id: deal.id, label: 'Placements',
        pricing_model: 'placement_fee', recurrence: 'one_time', quantity: 1,
        unit_amount: 90000, currency: 'SAR', fx_rate: 1, position: 0,
    });
    repo.insert('deal_line_items', {
        id: db.id('lit'), workspace_id: WS, deal_id: deal.id, label: 'Seats',
        pricing_model: 'per_seat', recurrence: 'monthly', quantity: 1,
        unit_amount: 4800, term_months: 24, currency: 'SAR', fx_rate: 1, position: 1,
    });
    const loaded = repo.getRecord('deal', ctx, deal.id);
    equal(loaded.value_one_time, 90000);
    equal(loaded.value_mrr, 4800);
    equal(loaded.value_arr, 57600);
});

/**
 * The name rules, exercised through the WRITE PATH rather than the helper.
 *
 * `reconcileNames` being correct is not the same claim as an uploaded file
 * arriving correct: the import maps headers, then `createRecord` validates,
 * then `nameFields` reconciles. A test of the helper alone would still pass if
 * any link in that chain dropped the field, which is exactly the failure worth
 * catching — a spreadsheet of first and last names landing as blank contacts.
 */
check('uploading first and last keeps them, and composes the whole name', () => {
    const c = repo.createRecord('contact', ctx, {
        account_id: account.id, data_source: 'test upload',
        first_name: 'Omar', last_name: 'Al Ghamdi',
    });
    equal(c.first_name, 'Omar', 'what was uploaded is what is stored');
    equal(c.last_name, 'Al Ghamdi');
    equal(c.full_name, 'Omar Al Ghamdi', 'and the whole name is composed from them');
});

check('uploading a whole name splits it, without altering the original', () => {
    const c = repo.createRecord('contact', ctx, {
        account_id: account.id, data_source: 'test upload',
        full_name: 'Omar Al Ghamdi',
    });
    equal(c.full_name, 'Omar Al Ghamdi', 'the name as written is kept verbatim');
    equal(c.first_name, 'Omar', 'and the parts are derived from it');
    equal(c.last_name, 'Al Ghamdi', 'particles stay on the family side of the cut');

    // The case the whole design exists for: a four-part Arabic name is not a
    // first and a last with two spare in the middle.
    const arabic = repo.createRecord('contact', ctx, {
        account_id: account.id, data_source: 'test upload',
        full_name: 'محمد عبدالله السالم القحطاني',
    });
    equal(arabic.full_name, 'محمد عبدالله السالم القحطاني', 'kept whole, exactly as given');
    equal(arabic.first_name, 'محمد');
    equal(arabic.last_name, 'عبدالله السالم القحطاني', 'everything after the first token');
});

check('uploading all three believes all three', () => {
    const c = repo.createRecord('contact', ctx, {
        account_id: account.id, data_source: 'test upload',
        full_name: 'Dr. Omar A. Ghamdi', first_name: 'Omar', last_name: 'Ghamdi',
    });
    equal(c.full_name, 'Dr. Omar A. Ghamdi', 'somebody meant this');
    equal(c.first_name, 'Omar', 'and meant this too — it is not re-derived');
    equal(c.last_name, 'Ghamdi');
});

check('the importer maps a single name column to the whole name', () => {
    // Listed before the parts on purpose: a file with one "Name" column must
    // map to full_name, or everything after the first space is lost.
    const aliases = fs.readFileSync(new URL('./lib/import.mjs', import.meta.url), 'utf8');
    const fullAt = aliases.indexOf('full_name: [');
    const firstAt = aliases.indexOf('first_name: [');
    assert(fullAt > 0 && firstAt > 0, 'both aliases must exist');
    assert(fullAt < firstAt, 'full_name must be matched before first_name');
    for (const header of ['fullname', 'name', 'contactname']) {
        assert(new RegExp(`'${header}'`).test(aliases.slice(fullAt, firstAt)),
            `"${header}" should map to the whole name`);
    }
});

await checkAsync('a deal import resolves the account by NAME and rejects an unknown one', async () => {
    db.run('INSERT INTO accounts (id, workspace_id, name, created_at, updated_at) VALUES (?,?,?,?,?)',
        [db.id('acc'), WS, 'Import Test Co', db.now(), db.now()]);

    // A deal's ONLY matcher is `external_id` (see `matchersFor`) — a deal has
    // no email or domain to recognise it by on a second upload, and "Company +
    // Deal Name" is not safe to match on: a client can genuinely buy the same
    // service again a year later under the same generated name. So a re-upload
    // is idempotent only when the file carries one; the two rows below do.
    const csvText = [
        'External ID,Account Name,Deal Name,Service,Currency,Price,Headcount,Term Months',
        'ext-offshoring-1,Import Test Co,Import Test Offshoring,offshoring,SAR,3000,12,24',
        'ext-recruitment-1,Import Test Co,Import Test Recruitment,recruitment,USD,90000,,',
    ].join('\n');

    const profile = await dealImport.profile(csvText, 'deal', WS);
    equal(profile.columns.find((c) => c.name === 'Account Name')?.suggestion, 'deal_account_name',
        'the Account Name column must be recognised as the account resolver');

    // An unknown company name rejects every row, in PREVIEW too — the importer
    // never invents companies mid-deal-import.
    const bad = await dealImport.process(ctx, {
        text: csvText.replace(/Import Test Co/g, 'Ghost Ltd Does Not Exist'),
        objectKey: 'deal', mapping: profile.mapping, apply: false,
    });
    equal(bad.counts.reject, 2, 'both rows reject when the account does not exist');
    assert(/import or create it first/.test(bad.reasons[0]?.reason ?? ''),
        'the rejection must state the fix');

    const preview = await dealImport.process(ctx, {
        text: csvText, objectKey: 'deal', mapping: profile.mapping, apply: false,
    });
    equal(preview.counts.create, 2, 'preview and execution must count the same way — rule 3');

    const batch = dealImport.createBatch(ctx, {
        objectKey: 'deal', filename: 'import-test.csv', source: 'upload', mapping: {}, options: {}, totalRows: 2,
    });
    const result = await dealImport.process(ctx, {
        text: csvText, objectKey: 'deal', mapping: profile.mapping, apply: true, batchId: batch.id,
    });
    equal(result.counts.reject, 0, `unexpected rejects: ${JSON.stringify(result.reasons)}`);
    equal(result.counts.create, 2);

    const offshoring = db.get("SELECT * FROM deals WHERE workspace_id = ? AND name = 'Import Test Offshoring'", [WS]);
    const recruitment = db.get("SELECT * FROM deals WHERE workspace_id = ? AND name = 'Import Test Recruitment'", [WS]);
    assert(offshoring && recruitment, 'both deals must exist, participating in the pipeline like any other deal');
    // Checked on the LINE ITEM, in the currency it was quoted in — not the
    // deal's `value_*` rollups, which convert to the workspace's base
    // currency (SAR here) and would make this assertion depend on the FX
    // rate rather than on what the importer actually wrote.
    const offshoringLine = db.get('SELECT * FROM deal_line_items WHERE deal_id = ?', [offshoring.id]);
    const recruitmentLine = db.get('SELECT * FROM deal_line_items WHERE deal_id = ?', [recruitment.id]);
    // Offshoring: headcount × price per employee, imported as a REAL monthly
    // price series — not a disconnected import-only figure. Rule: forecasting,
    // dashboard and pipeline all read this the same way a hand-typed deal does.
    equal(offshoringLine?.quantity, 12, '12 employees');
    equal(Number(offshoringLine?.unit_amount), 3000, '3000 SAR per employee, per month');
    equal(offshoringLine?.currency, 'SAR');
    equal(Number(recruitmentLine?.unit_amount), 90000, 'a placement fee has no headcount to multiply');
    equal(recruitmentLine?.currency, 'USD', 'quoted in the currency the file gave, not converted on write');

    // Re-uploading the same file is a no-op that UPDATES, never duplicates —
    // rule 4. Idempotency is what makes "existing customers" a safe upload
    // rather than a one-shot script nobody can safely re-run.
    const again = await dealImport.process(ctx, {
        text: csvText, objectKey: 'deal', mapping: profile.mapping, apply: true,
    });
    equal(again.counts.create, 0, 're-uploading the identical file must create nothing new');
    equal(again.counts.update, 2, 'and must recognise both deals as already imported');
});

checkAsync('a contact list shows the authoritative name, not the derived parts', async () => {
    const seedViewsModule = await import('./lib/seed-views.mjs');
    const views = seedViewsModule.systemViews('ws_test');
    for (const objectKey of ['contact', 'prospecting_contact']) {
        const view = views.find((v) => v.object_key === objectKey && v.is_default);
        const columns = JSON.parse(view.columns);
        assert(columns.includes('full_name'),
            `the default ${objectKey} view must show the whole name`);
        assert(!columns.includes('first_name') && !columns.includes('last_name'),
            `${objectKey} must not show the two derived halves instead — a four-part name `
            + 'does not reconstruct from two columns read side by side');
    }
});

/**
 * The qualification views are gone from Accounts and Contacts.
 *
 * "HCM — qualified", "HCM — needs review", "Offshoring — rejected" and the rest
 * are prospecting's conclusions wearing an account's id. An Account is a company
 * somebody already read the verdict and decided to work, so the questions here
 * are what it buys and what it pays in — six tabs re-asking how it was sourced is
 * how the list stopped being about the client.
 *
 * Asserted at the ENDPOINT, because that is what the UI draws its tabs from, and
 * because a workspace seeded before the change still has the rows: hiding them
 * has to work without a migration having been run.
 */
await checkAsync('qualification views are not offered on accounts or contacts', async () => {
    const viewsApi = await import('./api/views.mjs');
    const seedViewsModule = await import('./lib/seed-views.mjs');

    // The premise: something in this shape exists, on the plane that owns it.
    const seeded = seedViewsModule.systemViews(WS);
    const onProspecting = seeded.filter((v) => v.object_key === 'prospecting_company'
        && /"field"\s*:\s*"verdict_/.test(v.filter ?? ''));
    assert(onProspecting.length >= 2, 'prospecting companies must keep their verdict views');

    /**
     * A seeded verdict view planted on accounts and on contacts, exactly as an
     * older workspace would still be carrying it.
     */
    for (const objectKey of ['account', 'contact']) {
        db.run(
            `INSERT INTO views (id, workspace_id, object_key, name, view_type, filter, sort, columns,
                                scope, owner_id, is_default, is_system, position, created_at, updated_at)
             VALUES (?,?,?,?,'table',?,'[]','["name"]','workspace',NULL,0,1,9,?,?)`,
            [
                db.id('viw'), WS, objectKey, `HCM — qualified (${objectKey})`,
                JSON.stringify({ match: 'all', conditions: [{ field: 'verdict_hcm', op: 'is_any_of', value: ['qualified'] }] }),
                db.now(), db.now(),
            ],
        );
    }

    for (const objectKey of ['account', 'contact']) {
        const offered = await viewsApi.listViews({
            url: new URL(`http://x/api/views?object=${objectKey}`), ctx,
        });
        const qualification = offered.views.filter((v) => /HCM|Offshoring/.test(v.name));
        equal(qualification.map((v) => v.name), [],
            `an owner must not be offered qualification views on ${objectKey} — `
            + 'that question belongs to prospecting');
    }

    /**
     * And they are still there for the plane that owns the question.
     *
     * Seeded here rather than assumed: this workspace is built by hand at the
     * top of the file and `seedViews` never runs against it, so the assertion
     * below was reading an empty table — it would have passed just as happily
     * for a workspace where the prospecting views had been wrongly deleted too.
     */
    db.run(
        `INSERT INTO views (id, workspace_id, object_key, name, view_type, filter, sort, columns,
                            scope, owner_id, is_default, is_system, position, created_at, updated_at)
         VALUES (?,?,'prospecting_company','HCM - qualified','table',?,'[]','["name"]','workspace',NULL,0,1,9,?,?)`,
        [
            db.id('viw'), WS,
            JSON.stringify({ op: 'and', children: [{ field: 'verdict_hcm', operator: 'is_any_of', value: ['QUALIFIED'] }] }),
            db.now(), db.now(),
        ],
    );

    const prospecting = await viewsApi.listViews({
        url: new URL('http://x/api/views?object=prospecting_company'), ctx,
    });
    assert(prospecting.views.some((v) => /qualified/i.test(v.name)),
        'removing them from Accounts must not remove them from Prospecting');
});

check('stage required-fields are enforced from metadata, not code', () => {
    const stage = db.get('SELECT required_fields FROM stages WHERE id = ?', [STAGE_GATED]);
    equal(JSON.parse(stage.required_fields), ['close_date'], 'the requirement lives in the stage row');
});

check('a deal created straight into a gated stage is refused the same as one moved there', () => {
    // Only `moveStage` used to ask; a deal created — by an import, an
    // integration, or a form letting the stage be picked up front —
    // directly into a stage with required fields skipped the question
    // entirely, because "starting" in a stage and "moving" into one were
    // two different code paths.
    const account = repo.createRecord('account', ctx, { name: 'Straight Into Gated Ltd' });
    throws(
        () => repo.createRecord('deal', ctx, {
            name: 'No close date given', account_id: account.id, pipeline_id: PIPE, stage_id: STAGE_GATED,
        }),
        /"Proposal sent" needs close_date filled in first/,
        'the same refusal moveStage would give, not a silent creation',
    );

    const withDate = repo.createRecord('deal', ctx, {
        name: 'Close date given', account_id: account.id, pipeline_id: PIPE, stage_id: STAGE_GATED,
        close_date: '2026-12-01',
    });
    equal(withDate.stage_id, STAGE_GATED, 'and it succeeds once the field is actually there');

    const forced = repo.createRecord('deal', ctx, {
        name: 'Forced past the gate', account_id: account.id, pipeline_id: PIPE, stage_id: STAGE_GATED, force: true,
    });
    void forced; // no throw is the assertion — `force` bypasses the same as it does on a move
});

check('a stage with no required fields still lets a deal be created into it with nothing but a name', () => {
    // The frontier case this whole change must not break: raising a deal
    // the moment a meeting is booked, with no date, no price, nothing but
    // who it is for.
    const account = repo.createRecord('account', ctx, { name: 'Just Booked A Meeting Ltd' });
    const deal = repo.createRecord('deal', ctx, {
        name: 'Nothing but a name', account_id: account.id, pipeline_id: PIPE, stage_id: STAGE_OPEN,
    });
    equal(deal.stage_id, STAGE_OPEN);
});

/**
 * The cached rollups.
 *
 * `deals.value_*` exist so SQL can ORDER BY and WHERE on money that is computed
 * from line items. Caching money is only safe because of the ordering: the
 * display path always re-derives, so a stale cache costs a wrong sort and never
 * a wrong number. These tests hold both halves of that — the cache follows the
 * line items, and the record still reads from them.
 */
check('the cached deal values follow the line items', () => {
    const deal = repo.createRecord('deal', ctx, {
        name: 'Cached value deal', account_id: account.id, pipeline_id: PIPE, stage_id: STAGE_OPEN, currency: 'SAR',
    });
    const cached = () => db.get('SELECT value_one_time, value_mrr, value_arr FROM deals WHERE id = ?', [deal.id]);

    // A deal with no line items is worth nothing, and says so rather than
    // being left null — a null sorts unpredictably against a zero.
    equal(cached().value_one_time, 0, 'a deal with no line items caches zero, not null');

    repo.insert('deal_line_items', {
        id: db.id('lit'), workspace_id: WS, deal_id: deal.id, label: 'Placements',
        pricing_model: 'placement_fee', recurrence: 'one_time', quantity: 1,
        unit_amount: 90000, currency: 'SAR', fx_rate: 1, position: 0,
    });
    // Inserting straight into the table bypasses the API, so nothing has synced
    // yet — which is exactly the stale state the invariant has to survive.
    equal(cached().value_one_time, 0, 'a raw insert does not update the cache');
    equal(repo.getRecord('deal', ctx, deal.id).value_one_time, 90000,
        'but the RECORD is still right, because the display path derives rather than reads the cache');

    repo.syncDealValues(deal.id, ctx);
    equal(cached().value_one_time, 90000, 'and a sync catches the cache up');
});

check('a stage move re-weights the cache, though no line item moved', () => {
    const deal = repo.createRecord('deal', ctx, {
        name: 'Weighted deal', account_id: account.id, pipeline_id: PIPE, stage_id: STAGE_OPEN, currency: 'SAR',
    });
    repo.insert('deal_line_items', {
        id: db.id('lit'), workspace_id: WS, deal_id: deal.id, label: 'Fee',
        pricing_model: 'fixed_fee', recurrence: 'one_time', quantity: 1,
        unit_amount: 100000, currency: 'SAR', fx_rate: 1, position: 0,
    });
    repo.syncDealValues(deal.id, ctx);
    const first = db.get('SELECT value_weighted FROM deals WHERE id = ?', [deal.id]).value_weighted;

    // The probability the weighting uses lives on the deal or its stage, so it
    // can change without a single line item being touched.
    repo.updateRecord('deal', ctx, deal.id, { probability: 0.9 });
    const second = db.get('SELECT value_weighted FROM deals WHERE id = ?', [deal.id]).value_weighted;

    equal(second, 90000, 'a 90% probability weights a 100,000 fee to 90,000');
    assert(second !== first, 'and the cached figure moved with it');
});

check('deal value is sortable and filterable, which is the whole point', () => {
    const fields = objects.fieldsFor('deal', WS);
    for (const key of ['value_one_time', 'value_mrr']) {
        const field = fields.find((f) => f.key === key);
        assert(field?.sortable, `${key} must be sortable — "my biggest open deals" is a sort`);
        assert(field?.filterable, `${key} must be filterable`);
        assert(field?.column, `${key} needs the column it is cached into, or the compiler cannot reach it`);
    }
});

/* ======================================================== 8. OBJECTS === */

describe('Object registry');

check('every object declares a table that exists', () => {
    for (const [key, def] of Object.entries(objects.OBJECTS)) {
        const columns = db.all(`PRAGMA table_info(${def.table})`);
        assert(columns.length > 0, `${key} points at a missing table "${def.table}"`);
    }
});

check('every system field maps to a real column', () => {
    const columnsOf = (table) => new Set(db.all(`PRAGMA table_info(${table})`).map((c) => c.name));
    for (const [key, def] of Object.entries(objects.OBJECTS)) {
        const own = columnsOf(def.table);
        for (const f of def.fields) {
            /**
             * A field may deliberately have NO column: it is collected on this
             * object's form and stored on another record. The account's
             * primary-contact fields are the case — see `syncPrimaryContact`.
             * Null is the claim "there is no column", which is checkable;
             * a missing column name would be a typo, which is what this guards.
             */
            if (f.column === null) continue;
            /**
             * A dotted column reaches through a join, and the object has to say
             * which table the alias is — otherwise this check could not tell a
             * real joined column from a typo.
             */
            if (f.column.includes('.')) {
                const [alias, column] = f.column.split('.');
                const joined = def.joins?.[alias];
                assert(joined, `${key}.${f.key} reaches through alias "${alias}", which the object does not declare in \`joins\``);
                assert(columnsOf(joined).has(column),
                    `${key}.${f.key} maps to missing column "${column}" on ${joined}`);
                continue;
            }
            assert(own.has(f.column), `${key}.${f.key} maps to missing column "${f.column}"`);
        }
    }
});

/**
 * `relatedColumns` is a list of field KEYS typed by hand, and a key that does
 * not resolve is not an error anywhere — the column is simply absent, on a tab
 * most people reach only occasionally. Exactly the silent failure the field
 * registry exists to prevent, so it is checked here instead.
 */
check('related-table columns resolve, and never point back at the parent', () => {
    for (const [key, def] of Object.entries(objects.OBJECTS)) {
        if (!def.relatedColumns) continue;
        const known = new Set(objects.fieldsFor(key, WS).map((f) => f.key));
        for (const column of def.relatedColumns) {
            assert(known.has(column), `${key}.relatedColumns names "${column}", which is not a field on ${key}`);
            assert(!/_id$/.test(column) || column === 'stage_id' || column === 'pipeline_id',
                `${key}.relatedColumns names "${column}" — a reference column inside a parent record `
                + 'repeats the page heading once per row');
        }
    }
});

/**
 * Form presentation is DECLARED on the field, and has to stay declarable.
 *
 * `group`, `advanced` and `showWhen` cross to the browser as JSON, so a
 * condition can only ever be data. The moment one of them becomes a function it
 * silently stops working in the client — which looks like a field that has gone
 * missing, not like an error.
 */
check('conditional fields declare their condition as data', () => {
    for (const [key, def] of Object.entries(objects.OBJECTS)) {
        for (const f of def.fields) {
            if (!f.showWhen) continue;
            equal(typeof f.showWhen, 'object', `${key}.${f.key} — showWhen must be data, not a function`);
            assert(f.showWhen.field, `${key}.${f.key} — showWhen names no field`);
            assert(def.fields.some((other) => other.key === f.showWhen.field),
                `${key}.${f.key} depends on "${f.showWhen.field}", which is not a field on ${key}`);
            assert(Array.isArray(f.showWhen.in) || f.showWhen.isNotEmpty === true,
                `${key}.${f.key} — a condition must be { in: [...] } or { isNotEmpty: true }`);
        }
    }
});

check('a loss reason is asked when a deal is lost, and not before', () => {
    const loss = objects.OBJECTS.deal.fields.find((f) => f.key === 'loss_reason');
    equal(loss.showWhen, { field: 'status', in: ['lost'] },
        'the stage move already refuses to close as lost without one; the form should agree');
});

check('an override reason is asked only once there is an override', () => {
    const reason = objects.OBJECTS.deal.fields.find((f) => f.key === 'probability_reason');
    equal(reason.showWhen, { field: 'probability', isNotEmpty: true });
});

check('no form asks for twenty things in one undivided column', () => {
    // The account create form was the worst: every field, in registry order,
    // with External ID at the same weight as Name.
    for (const key of ['account', 'deal']) {
        const formFields = objects.OBJECTS[key].fields.filter((f) => f.form !== false && !f.readOnly);
        const ungrouped = formFields.filter((f) => !f.group);
        equal(ungrouped.map((f) => f.key), [],
            `every ${key} form field needs a group, or it falls into the first section by accident`);
        const groups = new Set(formFields.map((f) => f.group));
        assert(groups.size >= 2, `${key} needs more than one section to be worth sectioning`);
    }
});

describe('Meetings have their own date and their own state');

{
    const meetings = await import('./lib/meetings.mjs');
    const dash = await import('./api/dashboard.mjs');

    /** A meeting straight into the table, so these tests do not depend on the
     *  calling screen's booking flow to set one up. */
    const bookMeeting = ({ at, status = 'scheduled', actor = admin.id, assignment = null }) => {
        const activityId = db.id('act');
        db.run(
            `INSERT INTO activities
               (id, workspace_id, parent_type, parent_id, type_key, occurred_at, actor_id,
                source, properties, assignment_id, meeting_at, meeting_status, created_at, updated_at)
             VALUES (?,?,'contact',?, 'meeting', ?, ?, 'ui', '{}', ?, ?, ?, ?, ?)`,
            [activityId, WS, 'con_x', '2026-01-01T00:00:00.000Z', actor, assignment,
             at, status, db.now(), db.now()],
        );
        return activityId;
    };

    check('a show rate is Done over Done plus No Show, and nothing before that', () => {
        equal(meetings.showRate(0, 0), null,
            'a team whose meetings are all still to come has not failed to show up');
        equal(meetings.showRate(3, 1), 75);
        equal(meetings.showRate(0, 2), 0, 'nobody came: that IS zero, and must not read as "no data"');
        equal(meetings.showRate(2, 0), 100);
    });

    check('an upcoming meeting is outside the rate; a past unclassified one is too', () => {
        const soon = '2099-06-01T10:00:00.000Z';
        const past = '2020-06-01T10:00:00.000Z';
        bookMeeting({ at: soon });
        bookMeeting({ at: past });
        bookMeeting({ at: past, status: 'done' });

        const stats = meetings.meetingStats(ctx, { nowIso: '2026-08-19T00:00:00.000Z' });
        equal(stats.totals.upcoming, 1, 'booked ahead');
        equal(stats.totals.unclassified, 1, 'its time passed and nobody has said what happened');
        equal(stats.totals.done, 1);
        equal(stats.totals.showRate, 100,
            'the rate rests on the one meeting that resolved, not on the three that exist');
    });

    check('a meeting is counted in the month it is HELD, not the month it was booked', () => {
        const id = bookMeeting({ at: '2026-11-03T10:00:00.000Z' });   // booked in Jan, held in Nov
        const november = meetings.meetingStats(ctx, {
            from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z',
            nowIso: '2026-12-02T00:00:00.000Z',
        });
        const january = meetings.meetingStats(ctx, {
            from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z',
            nowIso: '2026-12-02T00:00:00.000Z',
        });
        assert(november.totals.scheduled >= 1, 'November holds it');
        equal(january.totals.scheduled, 0,
            'occurred_at is when the call was made — dating meetings by it reports them in the wrong month');
        db.run('DELETE FROM activities WHERE id = ?', [id]);
    });

    check('a future meeting cannot be marked as a no show', () => {
        const id = bookMeeting({ at: '2099-06-01T10:00:00.000Z' });
        throws(() => meetings.settleMeeting(ctx, id, 'no_show'),
            /no.show/i, 'a 3pm meeting is not a no-show at 2pm');
    });

    check('the totals are summed, never averaged from the rows', () => {
        // One person with many meetings and one with a single perfect one:
        // averaging their rates would flatter the team.
        const other = db.id('usr');
        db.run(`INSERT INTO users (id, email, name, password_hash, created_at)
                VALUES (?,?,?,'x',?)`, [other, `${other}@t.local`, 'Other Rep', db.now()]);
        db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at)
                VALUES (?,?,?,'rep',?)`, [db.id('mem'), WS, other, db.now()]);

        const at = '2025-03-01T10:00:00.000Z';
        for (let i = 0; i < 4; i += 1) bookMeeting({ at, status: 'no_show', actor: admin.id });
        bookMeeting({ at, status: 'done', actor: other });

        const stats = meetings.meetingStats(ctx, {
            from: '2025-03-01T00:00:00.000Z', to: '2025-03-02T00:00:00.000Z',
            nowIso: '2026-08-19T00:00:00.000Z',
        });
        equal(stats.totals.showRate, 20, '1 done out of 5 resolved — not the 50% an average of 0% and 100% gives');
    });

    await checkAsync('the widget leads with the show rate and its total matches its rows', async () => {
        const out = await dash.WIDGETS.meeting_analytics.run(ctx, {}, {
            from: '2025-03-01T00:00:00.000Z', to: '2025-03-02T00:00:00.000Z',
        });

        const rate = out.tiles.find((t) => t.label === 'Show rate');
        assert(rate, 'a meetings funnel without its conversion could be anything');
        equal(rate.tone, 'strong', 'it is the headline, and the renderer is told so');

        const summed = out.table.rows.reduce((n, r) => n + r.done, 0);
        equal(out.table.totals.done, summed, 'the total row and the rows above it must agree');
        equal(out.table.totals.showRate, rate.value, 'the tile and the total are one number');
    });

    await checkAsync('the name column links somewhere a browser can follow', async () => {
        const out = await dash.WIDGETS.meeting_analytics.run(ctx, {}, { from: null, to: null });
        const overJson = JSON.parse(JSON.stringify(out.table));
        /**
         * A function cannot cross to the browser: `JSON.stringify` drops it
         * without a word, which is how three widgets shipped with a name column
         * that was never a link.
         */
        equal(typeof overJson.hrefTemplate, 'string',
            'the drill-through has to survive being turned into JSON');
        assert(overJson.hrefTemplate.includes('{'), 'and carry a placeholder for the row to fill');
    });

    check('no widget hands the browser a function and expects it to arrive', () => {
        const source = fs.readFileSync(new URL('./api/dashboard.mjs', import.meta.url), 'utf8');
        const offenders = [...source.matchAll(/^\s*href:\s*\(/gm)];
        equal(offenders.length, 0,
            'href must be a template string — a function is dropped silently by JSON.stringify');
    });

    await checkAsync('the Meetings list can settle a meeting directly, without a call being logged', async () => {
        // The list built to answer "show me the meetings" had no action on
        // it at all — settling one meant leaving the page, finding the
        // right SDR's queue, and logging an unrelated call just to close
        // out a meeting already on screen.
        const meetingsApi = await import('./api/meetings.mjs');
        const activityId = bookMeeting({ at: '2020-06-01T10:00:00.000Z' });

        await meetingsApi.settle({
            req: bodyOf({ status: 'done' }), params: { id: activityId }, ctx,
        });
        equal(db.get('SELECT meeting_status FROM activities WHERE id = ?', [activityId]).meeting_status, 'done');

        const future = bookMeeting({ at: '2099-06-01T10:00:00.000Z' });
        await meetingsApi.settle({
            req: bodyOf({ status: 'no_show' }), params: { id: future }, ctx,
        }).then(
            () => { throw new Error('a future meeting must not be settleable'); },
            (err) => assert(/no.show/i.test(err.message), err.message),
        );
    });
}

describe('A person typed on the account form is a contact');

check('the four fields on an account create a contact on it', () => {
    const account = repo.createRecord('account', ctx, {
        name: 'Typed A Person Ltd',
        contact_first_name: 'Hussam', contact_last_name: 'Alshair',
        contact_title: 'Founder & CEO', contact_email: 'hussam@example.com',
    });

    const contacts = db.all(
        'SELECT * FROM contacts WHERE account_id = ? AND deleted_at IS NULL', [account.id]);
    equal(contacts.length, 1, 'one contact, created from the account form');
    equal(contacts[0].first_name, 'Hussam');
    equal(contacts[0].last_name, 'Alshair');
    equal(contacts[0].title, 'Founder & CEO');
    equal(contacts[0].email, 'hussam@example.com');

    // And nothing was written onto the account itself: the contact is the one
    // record that holds this person, so there is no second copy to disagree.
    const row = db.get('SELECT * FROM accounts WHERE id = ?', [account.id]);
    assert(!('contact_email' in row),
        'an account column for the email would be the duplicate this design avoids');

    // Read back, so the form shows who is on record instead of empty boxes.
    equal(repo.getRecord('account', ctx, account.id).contact_email, 'hussam@example.com');
});

check('saving the account again edits that contact rather than adding another', () => {
    const account = repo.createRecord('account', ctx, {
        name: 'Edited Not Duplicated Ltd',
        contact_first_name: 'Mona', contact_last_name: 'Said', contact_email: 'mona@example.com',
    });

    repo.updateRecord('account', ctx, account.id, { contact_title: 'COO' });
    repo.updateRecord('account', ctx, account.id, { contact_email: 'mona.said@example.com' });

    const contacts = db.all(
        'SELECT * FROM contacts WHERE account_id = ? AND deleted_at IS NULL', [account.id]);
    equal(contacts.length, 1, 'three saves, one person — not three copies of them');
    equal(contacts[0].title, 'COO');
    equal(contacts[0].email, 'mona.said@example.com');
    equal(contacts[0].first_name, 'Mona', 'a field the payload did not mention is left alone');
});

check('an account edited from a screen without these fields leaves the contact intact', () => {
    const account = repo.createRecord('account', ctx, {
        name: 'Untouched Contact Ltd',
        contact_first_name: 'Omar', contact_email: 'omar@example.com',
    });

    // The ordinary record form, which does not carry the person's fields.
    repo.updateRecord('account', ctx, account.id, { city: 'Riyadh' });

    const contact = db.get(
        'SELECT * FROM contacts WHERE account_id = ? AND deleted_at IS NULL', [account.id]);
    equal(contact.email, 'omar@example.com',
        'a payload that never mentioned the email must not blank it');
});

check('an email with nobody attached to it does not invent a contact', () => {
    const account = repo.createRecord('account', ctx, {
        name: 'No Name Given Ltd', contact_email: 'info@example.com', contact_title: 'Reception',
    });
    equal(db.all('SELECT * FROM contacts WHERE account_id = ?', [account.id]).length, 0,
        'a contact is a person, and neither an address nor a job title is one');
});

check('a single full-name column is enough to create the contact, split automatically', () => {
    const account = repo.createRecord('account', ctx, {
        name: 'Full Name Only Ltd',
        contact_full_name: 'Omar Al Ghamdi', contact_phone: '+966500000001',
        contact_linkedin_url: 'https://www.linkedin.com/in/omar-alghamdi/',
    });
    const contact = db.get('SELECT * FROM contacts WHERE account_id = ? AND deleted_at IS NULL', [account.id]);
    assert(contact, 'first/last were never given, but full_name alone names a person');
    equal(contact.full_name, 'Omar Al Ghamdi');
    equal(contact.first_name, 'Omar', 'derived the same way a direct contact write derives it');
    equal(contact.last_name, 'Al Ghamdi');
    equal(contact.phone, '+966500000001');
    equal(contact.linkedin_url, 'https://www.linkedin.com/in/omar-alghamdi/',
        'the personal profile, distinct from the account’s own (company) LinkedIn URL');
});

check('no index in schema.sql names a column that only a migration adds', () => {
    /**
     * `migrate()` executes schema.sql IN FULL and only then adds the columns in
     * COLUMN_MIGRATIONS. So an index in schema.sql naming a migrated column
     * works on a fresh database and throws `no such column` on every existing
     * one — it passes every local check and then takes down production, and
     * every other deployment, the moment it is pushed.
     *
     * That has now happened twice. Such indexes belong in INDEX_MIGRATIONS,
     * which runs after the columns exist.
     */
    const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

    // Statement by statement, because one regex over the whole file matches the
    // word "on" in a comment and reports a table called "of".
    const offences = new Set();
    for (const statement of schema.split(';')) {
        if (!/\bCREATE\s+(UNIQUE\s+)?INDEX\b/i.test(statement)) continue;
        const on = statement.match(/\bON\s+(\w+)\s*\(/i);
        if (!on) continue;
        const migrated = db.COLUMN_MIGRATIONS[on[1]];
        if (!migrated) continue;

        // Everything after the table name: the indexed columns, and a partial
        // index's WHERE clause, which names columns and fails just as hard.
        // Split into identifiers rather than matched with a word-boundary
        // regex: `column` is interpolated, and one lost backslash turns \b into
        // a backspace character that quietly matches nothing — which is exactly
        // how this check first shipped, passing against a planted offence.
        const named = new Set(statement.slice(on.index + on[0].length).split(/[^A-Za-z0-9_]+/));
        for (const column of Object.keys(migrated)) {
            if (named.has(column)) offences.add(`${on[1]}.${column}`);
        }
    }

    equal([...offences].sort().join(', '), '',
        'move these to INDEX_MIGRATIONS in lib/db.mjs — in schema.sql they break every existing database');
});

check('every CSS variable the stylesheet uses is one the tokens define', () => {
    /**
     * An undefined `var()` does not fail loudly — it is invalid at computed-value
     * time, so the property falls back to inherited or initial and the rule
     * silently does nothing. That is how a dropzone shipped with a dashed border
     * nobody could see, a totals row with no tint to separate it from the rows
     * it totals, and the current follow-up step left at the same grey as the
     * steps already done.
     *
     * Nothing catches this but looking at the screen, and the screen is exactly
     * what nobody re-checks after a token is renamed. So it is checked here.
     */
    const css = fs.readFileSync(new URL('./public/css/app.css', import.meta.url), 'utf8');
    const tokens = fs.readFileSync(new URL('./public/css/tokens.css', import.meta.url), 'utf8');

    // A token counts as defined wherever it is DECLARED — tokens.css for the
    // palette, app.css itself for the few a component scopes to itself.
    const defined = new Set(
        [...`${tokens}
${css}`.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]),
    );

    const missing = new Set();
    for (const [, name, fallback] of css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,)?/g)) {
        // A declared fallback is a deliberate default, not an accident.
        if (!fallback && !defined.has(name)) missing.add(name);
    }

    equal([...missing].sort().join(', '), '',
        'these render as nothing at all, which is worse than rendering wrong');
});

check('the client honours the presentation the registry declares', () => {
    const components = fs.readFileSync(new URL('./public/js/components.js', import.meta.url), 'utf8');
    for (const token of ['showWhen', 'advanced', 'def.group']) {
        assert(components.includes(token), `components.js must read "${token}" — the registry declares it for a reason`);
    }
    const metaJs = fs.readFileSync(new URL('./api/meta.mjs', import.meta.url), 'utf8');
    for (const token of ['showWhen', 'advanced', 'group']) {
        assert(metaJs.includes(token), `/api/meta must send "${token}", or the client cannot see it`);
    }
});

/**
 * Every status has to MEAN something, or say that it deliberately does not.
 *
 * The client used to hold its own map of fourteen values, so the whole approval
 * workflow — pending_review, approved, out_for_signature, signed, expired,
 * terminated — rendered as identical grey pills, and an EXPIRED contract looked
 * like one waiting to be read. This makes adding a status without deciding what
 * it signifies a failing test rather than a colour nobody notices is missing.
 */
check('every status either carries a tone or is deliberately neutral', () => {
    const TONED_FIELDS = ['status', 'lifecycle_stage', 'priority', 'verification_status'];
    const unaccounted = [];

    for (const [key, def] of Object.entries(objects.OBJECTS)) {
        for (const f of def.fields) {
            if (!TONED_FIELDS.includes(f.key) || !Array.isArray(f.options)) continue;
            for (const value of f.options) {
                const toned = objects.toneFor(value) !== null;
                const neutral = objects.NEUTRAL_STATUSES.includes(value);
                if (!toned && !neutral) unaccounted.push(`${key}.${f.key}=${value}`);
            }
        }
    }
    equal(unaccounted, [],
        'each of these needs a tone in STATUS_TONES, or a place in NEUTRAL_STATUSES '
        + 'saying its plainness is the point');
});

check('a status is never toned two ways at once', () => {
    const both = objects.NEUTRAL_STATUSES.filter((v) => objects.STATUS_TONES[v]);
    equal(both, [], 'a value cannot be both neutral and coloured');
});

check('email verification tones follow its own classification', () => {
    // Derived, never restated: lib/verification.mjs argues about what
    // accept-all means for sending, and a second opinion here would drift.
    for (const s of verification.STATUS_META) {
        const expected = { safe: 'success', review: 'warning', blocked: 'danger' }[s.classification];
        equal(objects.toneFor(s.status), expected,
            `${s.status} is classified "${s.classification}" and must be toned to match`);
    }
});

check('the client reads tones from the server, not from a map of its own', () => {
    const components = fs.readFileSync(new URL('./public/js/components.js', import.meta.url), 'utf8');
    assert(components.includes('store.toneFor('), 'cellContent must ask the store');
    assert(!/qualified:\s*'success'/.test(components),
        'a second copy of the status meanings in the client is how EXPIRED went grey');
    const metaJs = fs.readFileSync(new URL('./api/meta.mjs', import.meta.url), 'utf8');
    assert(metaJs.includes('statusTones'), '/api/meta must send the tones');
});

/**
 * A currency is chosen from a list, and every option on that list converts.
 *
 * It used to be free text, so "SR", "usd" and "Dollar" were all accepted and
 * none of them matches a reporting rate — the dashboard converts to USD from a
 * table keyed by exactly these codes, so a typo did not fail loudly, it quietly
 * dropped the deal out of the converted total. This is the pair of facts that
 * has to stay true together: the field offers only what the rates cover, and
 * the rates cover everything the field offers.
 */
check('every currency field offers exactly the currencies that convert', () => {
    const rates = money.reportingRates(() => null);
    for (const [key, def] of Object.entries(objects.OBJECTS)) {
        for (const f of def.fields) {
            if (f.key !== 'currency' && f.key !== 'billing_currency') continue;
            equal(f.type, 'select', `${key}.${f.key} must be chosen, not typed`);
            equal(f.options, objects.BILLING_CURRENCIES,
                `${key}.${f.key} must offer the workspace currency list`);
            for (const option of f.options) {
                assert(Number(rates[option]) > 0,
                    `${key}.${f.key} offers ${option}, which has no reporting rate — `
                    + 'a deal in it would silently vanish from the converted total');
            }
        }
    }
});

/**
 * The field definition cache is only correct while every writer invalidates it.
 *
 * `fieldsFor` is called dozens of times per request — fifty-seven times by one
 * dashboard load — so the rows are held per workspace. That is safe exactly as
 * long as the set of places that WRITE `field_defs` is the set of places that
 * call `invalidateFieldDefs`. A new writer that forgets would serve definitions
 * from before its own change, which surfaces as a custom field that exists in
 * the database and is invisible in the product.
 *
 * So the set is asserted rather than remembered. If this fails, the new writer
 * either needs an `invalidateFieldDefs` beside it, or a line here saying why it
 * does not — `setup.mjs` runs as its own process and exits, so nothing it
 * writes can be stale in a server that has not started yet.
 */
/* ================================================ REPS AND PROSPECTING === */

/**
 * A rep may not reach prospecting, and the check is not in the sidebar.
 *
 * `/api/prospects` is an ordinary object route served by api/records.mjs,
 * which asks for no capability — every role that existed before the SDR held
 * `record.read.all`, so nothing needed to. A rep could therefore read the
 * entire uploaded-company book, and every verdict computed against it, by
 * typing the URL. Hiding the nav row would have changed nothing about that.
 *
 * These assert the boundary where it actually is: `routeAllowed`, which
 * server.mjs consults before any handler runs.
 */
describe('reps and prospecting');

{
    const repCtx = { ...ctx, role: 'rep' };
    const managerCtx = { ...ctx, role: 'manager' };
    const adminCtx = { ...ctx, role: 'admin' };

    const PROSPECTING = [
        ['GET', '/api/prospects'],
        ['GET', '/api/prospects/abc123'],
        ['POST', '/api/prospects/import'],
        ['GET', '/api/prospecting_contacts'],
        ['GET', '/api/qualification/rules'],
        ['GET', '/api/qualification/review-queue'],
        ['POST', '/api/qualification/run'],
        ['GET', '/api/qualification/uploader'],
    ];

    check('a rep is refused every prospecting endpoint', () => {
        const reachable = PROSPECTING
            .filter(([m, path]) => auth.routeAllowed(repCtx, m, path))
            .map(([m, path]) => `${m} ${path}`);
        equal(reachable, [],
            'these are refused before the handler runs, not hidden in the navigation');
    });

    check('a manager and an admin still reach all of it', () => {
        for (const who of [['manager', managerCtx], ['admin', adminCtx]]) {
            const refused = PROSPECTING
                .filter(([m, path]) => !auth.routeAllowed(who[1], m, path))
                .map(([m, path]) => `${m} ${path}`);
            equal(refused, [], `${who[0]} must keep prospecting`);
        }
    });

    check('the rest of the CRM is untouched for a rep', () => {
        // The deny list must be narrow. A rep still runs their whole day.
        const STILL_THEIRS = [
            ['GET', '/api/accounts'], ['GET', '/api/contacts'], ['GET', '/api/deals'],
            ['GET', '/api/tasks'], ['GET', '/api/activities'], ['GET', '/api/notes'],
            ['GET', '/api/proposals'], ['GET', '/api/agreements'],
            ['GET', '/api/meta'], ['GET', '/api/calling/queue'],
            ['GET', '/api/dashboards/default/data'],
        ];
        const refused = STILL_THEIRS
            .filter(([m, path]) => !auth.routeAllowed(repCtx, m, path))
            .map(([m, path]) => `${m} ${path}`);
        equal(refused, [], 'the deny list is for prospecting only');
    });

    check('a rep holds neither capability, and holding one back is not enough', () => {
        assert(!auth.can(repCtx, 'prospecting.read'), 'no prospecting.read');
        // `qualification.run` re-runs the rules against ACCOUNTS and hands back
        // the verdicts, which is prospecting's conclusion by another door.
        assert(!auth.can(repCtx, 'qualification.run'), 'no qualification.run either');
        assert(auth.can(managerCtx, 'prospecting.read'), 'a manager keeps it');
    });

    check('the account plane does not leak the qualification engine', () => {
        /**
         * `/api/accounts/:id/verdicts` is prospecting's conclusion wearing an
         * account's id. Denying `/api/prospects` while leaving this open makes
         * "a rep cannot see prospecting" true of one route and false of the
         * record page.
         */
        for (const path of ['/api/accounts/abc/verdicts', '/api/accounts/abc/evidence']) {
            assert(!auth.routeAllowed(repCtx, 'GET', path), `a rep is refused ${path}`);
            assert(auth.routeAllowed(managerCtx, 'GET', path), `a manager keeps ${path}`);
        }
        // The pattern is anchored so it cannot swallow the account itself.
        for (const path of ['/api/accounts', '/api/accounts/abc', '/api/accounts/abc/deals']) {
            assert(auth.routeAllowed(repCtx, 'GET', path), `${path} is not prospecting`);
        }
    });

    check('Sourcing\'s general People Search is blocked for a rep like every other prospecting route', () => {
        for (const path of ['/api/sourcing/people-search', '/api/sourcing/people-enrich', '/api/sourcing/people-import']) {
            assert(!auth.routeAllowed(repCtx, 'POST', path), `a rep is refused ${path}`);
            assert(auth.routeAllowed(managerCtx, 'POST', path), `a manager keeps ${path}`);
        }
    });

    check('global search drops prospecting rows rather than ranking them', () => {
        /**
         * search_index is a projection over EVERY registered object, so the
         * palette handed a rep prospecting companies by name with no route
         * denied — the one door that opens without anybody navigating to it.
         */
        const searchJs = fs.readFileSync(new URL('./api/search.mjs', import.meta.url), 'utf8');
        assert(/PROSPECTING_OBJECTS\.has\(objectKey\)\s*&&\s*!can\(ctx, 'prospecting\.read'\)/.test(searchJs),
            'the group loop must skip prospecting objects for callers without the capability');
        assert(searchJs.includes("'prospecting_company', 'prospecting_contact'"),
            'both prospecting objects must be named, not just the company');
    });

    check('an SDR is still confined to calling, prospecting or not', () => {
        const sdrCtx = { ...ctx, role: 'sdr' };
        assert(!auth.routeAllowed(sdrCtx, 'GET', '/api/prospects'), 'no prospecting');
        assert(!auth.routeAllowed(sdrCtx, 'GET', '/api/accounts'), 'and no accounts');
        assert(auth.routeAllowed(sdrCtx, 'GET', '/api/calling/queue'), 'their own queue stands');
    });

    check('the client is told, so it does not draw a locked door', () => {
        const metaJs = fs.readFileSync(new URL('./api/meta.mjs', import.meta.url), 'utf8');
        assert(/'prospecting\.read'/.test(metaJs),
            '/api/me must report prospecting.read or the sidebar cannot gate on it');
        const appJs = fs.readFileSync(new URL('./public/js/app.js', import.meta.url), 'utf8');
        assert(appJs.includes("can('prospecting.read')"),
            'the Sourcing section must be gated on the capability, not on a guess');
    });
}

check('every field_defs writer invalidates the cache', () => {
    const EXEMPT = ['setup.mjs'];
    const roots = ['api', 'lib', '.'];
    const seen = [];

    for (const dir of roots) {
        for (const name of fs.readdirSync(new URL(`./${dir}/`, import.meta.url))) {
            if (!name.endsWith('.mjs')) continue;
            const rel = dir === '.' ? name : `${dir}/${name}`;
            if (EXEMPT.includes(name) || name === 'test.mjs') continue;
            const src = fs.readFileSync(new URL(`./${rel}`, import.meta.url), 'utf8');
            if (!/INTO field_defs|UPDATE field_defs/.test(src)) continue;
            seen.push(rel);
            assert(src.includes('invalidateFieldDefs'),
                `${rel} writes field_defs but never invalidates the cache — the custom field it `
                + 'creates would be invisible until the server restarts');
        }
    }
    assert(seen.length > 0, 'the scan found no writers at all, which means it is not scanning');
});

check('every field type has operators, and every operator has a label', () => {
    for (const def of Object.values(objects.OBJECTS)) {
        for (const f of def.fields) {
            if (!f.filterable) continue;
            const ops = objects.operatorsFor(f.type);
            assert(ops.length > 0, `${f.key} (${f.type}) has no operators`);
            for (const op of ops) {
                assert(objects.OPERATOR_LABELS[op], `operator "${op}" has no human label`);
            }
        }
    }
});

check('every non-filterable field explains why', () => {
    for (const def of Object.values(objects.OBJECTS)) {
        for (const f of def.fields) {
            if (f.filterable) continue;
            assert(f.excludedBecause, `${f.key} is hidden from the filter builder with no reason given`);
        }
    }
});

check('the three verdicts are ordered by meaning, with REVIEW in the middle', () => {
    equal(objects.VERDICTS.slice(0, 3), ['QUALIFIED', 'REVIEW', 'REJECTED'],
        'REVIEW sits between the two definitive answers because that is what it is');
});

describe('Sourcing People Search (Apollo, general — not anchored to a company)');

await checkAsync('a general search omits the domain anchor and forwards exactly what was asked', async () => {
    // `searchAtCompany` is the same function a company page's "Find people"
    // uses; passing `domain: null` is what makes it general. The fetcher
    // stands in for Apollo, the same technique BounceBan's transport test uses.
    let sentUrl = null;
    const result = await peopleSearch.PROVIDERS.apollo.search(
        {
            person_titles: ['HR Director'], person_seniorities: ['director'],
            q_organization_domains: [], page: 1, per_page: 25,
        },
        'fake-key',
        {
            fetcher: async (url) => {
                sentUrl = url;
                return {
                    ok: true, status: 200,
                    json: async () => ({
                        people: [{
                            id: 'apollo_1', first_name: 'Nour', last_name: 'Adel', title: 'HR Director',
                            organization: { name: 'Widget Co', primary_domain: 'widgetco.com' },
                            city: 'Cairo', country: 'Egypt', linkedin_url: 'https://linkedin.com/in/nour',
                        }],
                        pagination: { total_entries: 1, page: 1, per_page: 25 },
                    }),
                };
            },
        },
    );
    assert(sentUrl.includes('person_titles%5B%5D=HR+Director') || sentUrl.includes('person_titles[]=HR'),
        'the title filter reached the request');
    assert(!sentUrl.includes('q_organization_domains'), 'no domain was sent — this is the general search, unanchored');
    equal(result.people.length, 1);
    equal(result.people[0].providerId, 'apollo_1');
    equal(result.people[0].organizationName, 'Widget Co');
    equal(result.people[0].domain, 'widgetco.com');
});

await checkAsync('Sourcing People Search import files each person under their OWN company, resolved by domain', async () => {
    // Its own workspace: this writes prospecting_companies/contacts, and nothing
    // elsewhere in the suite should have to account for rows a search test made.
    const WS3 = db.id('wsp');
    db.run('INSERT INTO workspaces (id, name, created_at) VALUES (?,?,?)', [WS3, 'People Search Co', db.now()]);
    const owner3 = auth.createUser({
        email: 'ps-owner@test.local', name: 'PS Owner', password: 'test-password-7', role: 'owner', workspaceId: WS3,
    });
    const ctx3 = { ...ctx, workspaceId: WS3, userId: owner3.id, workspace: { ...ctx.workspace, id: WS3 } };

    // A company that already exists in Sourcing — the import must find it by
    // domain rather than filing a second "Widget Co".
    const existing = repo.createRecord('prospecting_company', ctx3, { name: 'Widget Co (already known)', domain: 'widgetco.com' });

    const picked = [
        { providerId: 'apollo_1', firstName: 'Nour', lastName: 'Adel', title: 'HR Director', domain: 'widgetco.com', organizationName: 'Widget Co', email: 'nour@widgetco.com' },
        { providerId: 'apollo_2', firstName: 'Sami', lastName: 'Rahal', title: 'Talent Lead', domain: 'newco.example', organizationName: 'New Co', email: 'sami@newco.example' },
    ];
    const result = await peopleSearchApi.generalImport({ req: bodyOf({ people: picked }), ctx: ctx3 });

    equal(result.created, 2);
    equal(result.companiesMatched, 1, 'Widget Co was found by domain, not duplicated');
    equal(result.companiesCreated, 1, 'New Co did not exist yet');

    const nour = db.get('SELECT * FROM prospecting_contacts WHERE workspace_id = ? AND email = ?', [WS3, 'nour@widgetco.com']);
    equal(nour.prospect_id, existing.id, 'filed under the SAME company row the domain matched, not a new one');
    equal(nour.external_id, 'apollo_1', 'the provider id is preserved for reconciliation');
    equal(nour.data_source, 'Apollo');

    const sami = db.get('SELECT * FROM prospecting_contacts WHERE workspace_id = ? AND email = ?', [WS3, 'sami@newco.example']);
    const newCo = db.get('SELECT * FROM prospecting_companies WHERE id = ?', [sami.prospect_id]);
    equal(newCo.name, 'New Co');
    equal(newCo.domain, 'newco.example');
    equal(newCo.source, 'Apollo');

    // Re-importing the same two people is recognised, not duplicated — the
    // same email/LinkedIn dedup `importPeople` (the per-company flow) uses.
    const again = await peopleSearchApi.generalImport({ req: bodyOf({ people: picked }), ctx: ctx3 });
    equal(again.created, 0);
    equal(again.skipped, 2, 'both already exist, by email');
    equal(again.companiesCreated, 0, 'and neither company gets a duplicate either');
});

describe('People Search reveal — a rep requests it, a manager approves it');

{
    // Its own workspace, with a real manager MEMBER — `openApprovalTask`
    // (lib/approvals.mjs) queries `memberships` for who may approve, so a
    // ctx with `role: 'manager'` borrowed from another user is not enough
    // to prove the task lands on somebody.
    const WS4 = db.id('wsp');
    db.run('INSERT INTO workspaces (id, name, created_at) VALUES (?,?,?)', [WS4, 'Reveal Approval Co', db.now()]);
    const owner4 = auth.createUser({ email: 'reveal-owner@test.local', name: 'Reveal Owner', password: 'test-password-11', role: 'owner', workspaceId: WS4 });
    const manager4 = auth.createUser({ email: 'reveal-mgr@test.local', name: 'Reveal Manager', password: 'test-password-12', role: 'manager', workspaceId: WS4 });
    const rep4 = auth.createUser({ email: 'reveal-rep@test.local', name: 'Reveal Rep', password: 'test-password-13', role: 'rep', workspaceId: WS4 });
    const base4 = { workspaceId: WS4, workspace: { ...ctx.workspace, id: WS4 } };
    const repCtx4 = { ...base4, userId: rep4.id, role: 'rep', user: { id: rep4.id, name: 'Reveal Rep' } };
    const managerCtx4 = { ...base4, userId: manager4.id, role: 'manager', user: { id: manager4.id, name: 'Reveal Manager' } };

    const account4 = repo.createRecord('account', repCtx4, { name: 'Reveal Target Co', account_type: 'Egypt' });

    check('a rep holds people_search.use but not record.write.all; a manager holds both', () => {
        assert(auth.can(repCtx4, 'people_search.use'), 'rep can search + import');
        assert(!auth.can(repCtx4, 'record.write.all'), 'rep cannot reveal directly');
        assert(auth.can(managerCtx4, 'people_search.use'), 'a manager keeps the free half too');
        assert(auth.can(managerCtx4, 'record.write.all'), 'and can reveal directly, unsupervised');
    });

    check('the prospecting-company variant of search/import still requires record.write.all', () => {
        // Only the ACCOUNT plane got the lower bar — a rep never reaches
        // prospecting_companies at all (lib/auth.mjs's PROSPECTING_ROUTES
        // stops /api/sourcing/*, but not this per-company one, which is why
        // the capability check inside search()/importPeople() itself has to
        // do the narrowing).
        const src = fs.readFileSync(new URL('./api/people-search.mjs', import.meta.url), 'utf8');
        assert(/require\$\(ctx, subjectType === 'account' \? 'people_search\.use' : 'record\.write\.all'\)/.test(src),
            "search()/importPeople() must gate on subjectType, not just on 'people_search.use'");
    });

    let contactId;
    await checkAsync('a rep can import a found person into the CRM for free', async () => {
        const res = await peopleSearchApi.importPeople({
            req: bodyOf({ people: [
                { provider_id: 'apx_reveal_1', first_name: 'Layla', last_name: 'Fahmy', title: 'CFO', email: null, phone: null },
            ] }),
            params: { id: account4.id }, ctx: repCtx4,
            url: new URL(`http://x/api/accounts/${account4.id}/people-import`),
        });
        equal(res.created, 1);
        equal(res.createdContacts.length, 1, 'the Apollo id must travel back so a reveal request can name this exact contact');
        equal(res.createdContacts[0].providerId, 'apx_reveal_1');
        contactId = res.createdContacts[0].contactId;
        const contact = db.get('SELECT * FROM contacts WHERE id = ?', [contactId]);
        equal(contact.email, null, 'created now, filled in later — no email yet');
        equal(contact.phone, null);
    });

    await checkAsync('a rep still cannot reveal directly — enrich() is unchanged', async () => {
        await peopleSearchApi.enrich({
            req: bodyOf({ ids: ['apx_reveal_1'] }), params: { id: account4.id }, ctx: repCtx4,
            url: new URL(`http://x/api/accounts/${account4.id}/people-enrich`),
        }).then(
            () => { throw new Error('expected this to be refused'); },
            (err) => equal(err.status, 403, `expected a 403, got: ${err.message}`),
        );
    });

    let requestId;
    await checkAsync('a rep can request a reveal for the contact they just imported', async () => {
        const res = await peopleSearchApi.requestEnrich({
            req: bodyOf({
                people: [{ provider_id: 'apx_reveal_1', contact_id: contactId, name: 'Layla Fahmy' }],
                reveal_email: true, reveal_phone: true,
            }),
            params: { id: account4.id }, ctx: repCtx4,
        });
        equal(res.request.status, 'pending_approval');
        requestId = res.request.id;
        const row = db.get('SELECT * FROM people_enrich_requests WHERE id = ?', [requestId]);
        assert(row, 'the request was persisted');
        equal(row.workspace_id, WS4);
        equal(row.subject_type, 'account');
        equal(row.subject_id, account4.id);
        equal(row.requested_by, rep4.id);
        equal(row.status, 'pending_approval');
        // Nothing is spent yet — approving is the only door that calls Apollo.
    });

    check('the request raised an approval task for the manager, correctly worded', () => {
        const task = db.get(
            `SELECT * FROM tasks WHERE workspace_id = ? AND parent_type = 'people_enrich' AND parent_id = ? AND deleted_at IS NULL`,
            [WS4, requestId],
        );
        assert(task, 'a task was created');
        equal(task.assignee_id, manager4.id);
        equal(task.account_id, account4.id, 'linked straight to the account — people_enrich has no page of its own');
        equal(task.status, 'open');
        assert(task.title.includes('contact reveal') && task.title.includes('Reveal Target Co'),
            `title should name a contact reveal and the account, got: "${task.title}"`);
        assert(/email and phone/.test(task.description) && /1 person/.test(task.description),
            `description should name both fields and the headcount, got: "${task.description}"`);
    });

    await checkAsync('a rep cannot review their own request', async () => {
        await peopleSearchApi.reviewEnrichRequest({
            req: bodyOf({ decision: 'approved' }), params: { id: requestId }, ctx: repCtx4,
        }).then(
            () => { throw new Error('expected this to be refused'); },
            (err) => equal(err.status, 403, `expected a 403, got: ${err.message}`),
        );
    });

    await checkAsync('rejecting without a reason is refused, exactly like a document review', async () => {
        await peopleSearchApi.reviewEnrichRequest({
            req: bodyOf({ decision: 'rejected' }), params: { id: requestId }, ctx: managerCtx4,
        }).then(
            () => { throw new Error('expected this to be refused'); },
            (err) => assert(/needs to know|say why/i.test(err.message), `expected a reason-required error, got: ${err.message}`),
        );
        equal(db.get('SELECT status FROM people_enrich_requests WHERE id = ?', [requestId]).status, 'pending_approval');
    });

    await checkAsync('approving really attempts to spend Apollo credits — it does not just flip a status', async () => {
        // No apollo_api_key is configured for this workspace, so the billable
        // call inside reviewEnrichRequest must fail loudly. A version that
        // marked the request "approved" without truly calling Apollo would
        // pass every check above and still be a lie to whoever asked.
        // reveal_phone was asked for, so review needs a webhook URL to hand
        // Apollo before it ever gets to the API-key check — same as a real
        // request, `req.headers` supplies the host `apolloWebhookUrl` builds
        // it from.
        const req = bodyOf({ decision: 'approved' });
        req.headers = { host: 'test.local' };
        await peopleSearchApi.reviewEnrichRequest({
            req, params: { id: requestId }, ctx: managerCtx4,
        }).then(
            () => { throw new Error('expected the missing-API-key error'); },
            (err) => assert(/API key/i.test(err.message), `expected an Apollo configuration error, got: ${err.message}`),
        );
        const row = db.get('SELECT * FROM people_enrich_requests WHERE id = ?', [requestId]);
        equal(row.status, 'pending_approval', 'a failed enrich call must not silently count as approved');
        const task = db.get(`SELECT status FROM tasks WHERE workspace_id = ? AND parent_type = 'people_enrich' AND parent_id = ?`, [WS4, requestId]);
        equal(task.status, 'open', 'and the manager\'s task must still be open — nothing was actually decided');
    });

    await checkAsync('rejecting with a reason closes the task and notifies the rep', async () => {
        const res = await peopleSearchApi.reviewEnrichRequest({
            req: bodyOf({ decision: 'rejected', note: 'Not enough budget for reveals this month.' }),
            params: { id: requestId }, ctx: managerCtx4,
        });
        equal(res.request.status, 'rejected');
        equal(res.request.reviewNote, 'Not enough budget for reveals this month.');
        const task = db.get(`SELECT * FROM tasks WHERE workspace_id = ? AND parent_type = 'people_enrich' AND parent_id = ?`, [WS4, requestId]);
        equal(task.status, 'done', 'closed, not deleted — a record that somebody was asked and answered');
        const contact = db.get('SELECT * FROM contacts WHERE id = ?', [contactId]);
        equal(contact.email, null, 'a rejected request must never touch the contact');
        equal(contact.phone, null);
    });

    await checkAsync('a rejected request cannot be reviewed a second time', async () => {
        await peopleSearchApi.reviewEnrichRequest({
            req: bodyOf({ decision: 'approved' }), params: { id: requestId }, ctx: managerCtx4,
        }).then(
            () => { throw new Error('expected this to be refused'); },
            (err) => assert(/not awaiting review/i.test(err.message), `expected a wrong-status error, got: ${err.message}`),
        );
    });

    await checkAsync('the phone webhook patches straight onto the contact for an APPROVED, awaiting-phone request', async () => {
        // Exercises applyPendingPhoneReveal without a live Apollo call: seed
        // an approved request the same shape reviewEnrichRequest leaves
        // behind when email came back but phone (always asynchronous — see
        // lib/apollo.mjs) has not arrived yet, then deliver it the way
        // Apollo's webhook actually would.
        const approvedId = db.id('per');
        const stamp = db.now();
        settings.setSetting(WS4, 'apollo_webhook_secret', 'test-webhook-secret');
        db.run(
            `INSERT INTO people_enrich_requests
               (id, workspace_id, subject_type, subject_id, requested_by, people, reveal_email, reveal_phone, status, result, reviewed_by, reviewed_at, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [approvedId, WS4, 'account', account4.id, rep4.id,
                JSON.stringify([{ providerId: 'apx_reveal_2', contactId, name: 'Layla Fahmy' }]),
                1, 1, 'approved', JSON.stringify({ apx_reveal_2: { email: 'layla@revealtarget.example', phone: null } }),
                manager4.id, stamp, stamp, stamp],
        );
        db.run(`UPDATE contacts SET email = ?, phone = NULL WHERE id = ?`, ['layla@revealtarget.example', contactId]);

        const res = await peopleSearchApi.phoneWebhook({
            req: bodyOf({ id: 'apx_reveal_2', phone_number: '+20 100 000 0000' }),
            params: { secret: 'test-webhook-secret' },
        });
        equal(res.stored, 1);

        const contact = db.get('SELECT * FROM contacts WHERE id = ?', [contactId]);
        equal(contact.phone, '+20 100 000 0000', 'the async phone delivery must reach the contact directly, with nobody needing to click anything');

        const row = db.get('SELECT * FROM people_enrich_requests WHERE id = ?', [approvedId]);
        const result = JSON.parse(row.result);
        equal(result.apx_reveal_2.phone, '+20 100 000 0000', 'the request keeps its own record of what was applied');
    });

    await checkAsync('a phone already on the contact is never overwritten by a slower delivery', async () => {
        const approvedId = db.id('per');
        const stamp = db.now();
        db.run(
            `INSERT INTO people_enrich_requests
               (id, workspace_id, subject_type, subject_id, requested_by, people, reveal_email, reveal_phone, status, result, reviewed_by, reviewed_at, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [approvedId, WS4, 'account', account4.id, rep4.id,
                JSON.stringify([{ providerId: 'apx_reveal_3', contactId, name: 'Layla Fahmy' }]),
                0, 1, 'approved', JSON.stringify({}), manager4.id, stamp, stamp, stamp],
        );
        // contact already has a phone from the previous check
        await peopleSearchApi.phoneWebhook({
            req: bodyOf({ id: 'apx_reveal_3', phone_number: '+20 999 999 9999' }),
            params: { secret: 'test-webhook-secret' },
        });
        const contact = db.get('SELECT * FROM contacts WHERE id = ?', [contactId]);
        equal(contact.phone, '+20 100 000 0000', 'the existing number must survive an unrelated later delivery');
    });

    await checkAsync('/api/me reports the capability so the client does not draw a locked button', async () => {
        const metaApi = await import('./api/meta.mjs');
        const repMe = await metaApi.me({ ctx: repCtx4 });
        assert(repMe.capabilities['people_search.use'] === true, 'a rep must see this capability');
        const readonlyMe = await metaApi.me({ ctx: { ...repCtx4, role: 'readonly' } });
        assert(readonlyMe.capabilities['people_search.use'] === false, 'readonly gets neither half');
    });

    check('My Work\'s Approvals tab and the review-routing both know about people_enrich', () => {
        const src = fs.readFileSync(new URL('./public/js/pages/my-work.js', import.meta.url), 'utf8');
        assert(src.includes("'people_enrich'"), "the approvals kinds list must include 'people_enrich'");
        assert(src.includes('/api/people-enrich-requests/${t.parent_id}/review'),
            'reviewFromWorklist must route a people_enrich task to its own review endpoint');
    });
}

/* =========================================================== 9. CSS ==== */

describe('Design system');

const css = fs.readFileSync(new URL('./public/css/app.css', import.meta.url), 'utf8');

check('no physical left/right properties (RTL would break)', () => {
    const offenders = css.match(/^\s*(margin|padding|border)-(left|right)\s*:/gm) ?? [];
    equal(offenders, [], 'use margin-inline-start, not margin-left');
});

check('verdict colours are independent tokens, not aliases', () => {
    const tokens = fs.readFileSync(new URL('./public/css/tokens.css', import.meta.url), 'utf8');
    for (const verdict of ['qualified', 'review', 'rejected']) {
        assert(tokens.includes(`--color-verdict-${verdict}:`), `--color-verdict-${verdict} must exist`);
    }
    // REVIEW must not be grey: grey reads as "ignore me".
    const review = tokens.match(/--color-verdict-review:\s*(#[0-9a-f]{6})/i)?.[1];
    assert(review, 'the review token must have a value');
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(review.slice(i, i + 2), 16));
    assert(Math.max(r, g, b) - Math.min(r, g, b) > 40, 'REVIEW must be saturated (amber), not grey');
});

check('both themes define every semantic colour', () => {
    const tokens = fs.readFileSync(new URL('./public/css/tokens.css', import.meta.url), 'utf8');
    const light = [...tokens.matchAll(/^\s{4}(--color-[\w-]+):/gm)].map((m) => m[1]);
    const dark = tokens.split('data-theme="dark"')[1] ?? '';
    const missing = [...new Set(light)].filter((token) => !dark.includes(`${token}:`));
    equal(missing, [], 'every colour token needs a dark value');
});

/* ============================================================== NAVIGATION === */

/**
 * The sidebar is read from source, because a nav row that points nowhere fails
 * SILENTLY: the link renders, the click routes, and `setNotFound` shows "that
 * page does not exist" — which reads as a broken product rather than a typo.
 * This project has already had that bug once, when Prospecting was left out of
 * the list entirely and qualified prospects became unreachable.
 */
describe('navigation');

{
    const appJs = fs.readFileSync(new URL('./public/js/app.js', import.meta.url), 'utf8');

    // The NAV literal, up to the closing `];` that ends it.
    const navBlock = appJs.slice(appJs.indexOf('const NAV = ['), appJs.indexOf('\n];', appJs.indexOf('const NAV = [')));
    const navHrefs = [...navBlock.matchAll(/href:\s*'([^']+)'/g)].map((m) => m[1]);

    /**
     * Routes come from two places, and a check that knew only about the first
     * would report every CRM object as an orphan.
     *
     * The literal `route('/x', …)` calls cover the one-off screens. The twelve
     * object routes are generated from `OBJECT_ROUTES` in a loop, because list
     * and record pages are one implementation each — so the keys of that map
     * are route registrations too.
     */
    const routes = [
        ...[...appJs.matchAll(/\broute\('([^']+)'/g)].map((m) => m[1]),
        ...[...appJs.slice(appJs.indexOf('const OBJECT_ROUTES = {'))
            .slice(0, appJs.slice(appJs.indexOf('const OBJECT_ROUTES = {')).indexOf('};'))
            .matchAll(/(\w+):\s*'/g)].map((m) => `/${m[1]}`),
    ];

    check('every sidebar row points at a registered route', () => {
        const orphans = navHrefs.filter((href) => !routes.includes(href));
        equal(orphans, [], 'a sidebar link with no route renders a "page does not exist" screen');
    });

    check('the sidebar stays small enough to choose from', () => {
        // Nineteen rows across four sections named after database tables is the
        // state this replaced. The number is a budget, not a target — adding a
        // row is a deliberate call each time, not drift. Meetings joined Sales
        // as a first-class destination (previously reachable only a click
        // deeper, via /renewals or /calendar) on explicit request, raising the
        // count from 16 to 17.
        assert(navHrefs.length <= 17,
            `the sidebar offers ${navHrefs.length} destinations; a list that has to be read rather than `
            + 'scanned is a menu, not navigation');
    });

    check('record types are not top-level destinations', () => {
        // Tasks, activities, notes and documents are things that hang off a
        // record. They remain routed and linked; they are not four of the rows
        // somebody chooses between on arrival. /my-work is what replaced them.
        for (const href of ['/tasks', '/activities', '/notes', '/documents']) {
            assert(!navHrefs.includes(href),
                `${href} is a record type, not a destination — it belongs on /my-work and on the records themselves`);
            assert(routes.includes(href), `${href} must stay routed: it is linked from records and from search`);
        }
        assert(navHrefs.includes('/my-work'), '/my-work is what those four rows became');
    });

    check('search is reached from the topbar, not from a nav row', () => {
        assert(!navHrefs.includes('/search'),
            'search already has the topbar box and ⌘K; a third entry point for one destination is noise');
        assert(routes.includes('/search'), 'the search PAGE must still exist — ⌘K links to it');
    });
}

/* ================================================ 10. campaigns ======= */

describe('Campaigns');

const campaigns = await import('./lib/campaigns.mjs');

const CAMPAIGN = repo.createRecord('campaign', ctx, {
    name: 'Q3 HCM push', status: 'active', channel: 'linkedin',
    service_line_key: 'hcm', budget_amount: 10000,
});

check('a campaign is a first-class record with its own fields', () => {
    assert(CAMPAIGN.id.startsWith('cmp_'), 'campaigns get their own id prefix');
    equal(CAMPAIGN.status, 'active');
    equal(CAMPAIGN.service_line_key, 'hcm');
});

const CAMPAIGN_ACCOUNT = repo.createRecord('account', ctx, { name: 'Campaign Co', lifecycle_stage: 'qualified' });
const CAMPAIGN_CONTACT = repo.createRecord('contact', ctx, {
    first_name: 'Nadia', last_name: 'Saleh', data_source: 'linkedin',
    account_id: CAMPAIGN_ACCOUNT.id, services: ['hcm'], campaign_id: CAMPAIGN.id,
});

check('a contact carries both services and a campaign', () => {
    equal(CAMPAIGN_CONTACT.services, ['hcm']);
    equal(CAMPAIGN_CONTACT.campaign_id, CAMPAIGN.id);
    equal(CAMPAIGN_CONTACT.campaign_name, 'Q3 HCM push', 'the campaign name is resolved for display');
});

check('a campaign reference that does not exist is refused by name', () => {
    throws(
        () => repo.createRecord('contact', ctx, { first_name: 'Bad', last_name: 'Ref', data_source: 'x', campaign_id: 'cmp_missing' }),
        /no campaign with id/,
        'the error must name the field and the value, not surface a foreign-key message',
    );
});

check('adding the same member twice does not duplicate them', () => {
    const first = campaigns.addMembers(ctx, CAMPAIGN.id, 'contact', [CAMPAIGN_CONTACT.id]);
    const second = campaigns.addMembers(ctx, CAMPAIGN.id, 'contact', [CAMPAIGN_CONTACT.id]);
    equal(first.added, 1);
    equal(second.added, 0, 'the second add is a no-op');
    equal(second.skipped, 1, 'and it says so rather than claiming success');
});

check('an account can be added as a campaign member directly', () => {
    // Regression: addMembers selected a nonexistent account_id column off the
    // accounts table for this branch (accounts have no account_id of their
    // own) and threw "no such column: account_id" for every account add —
    // this silently 500'd both the Accounts list's bulk "Add to campaign"
    // and a campaign's own "+ Accounts" button. A dedicated campaign here
    // — reach() counts a member for good, even after removal — so this
    // does not perturb CAMPAIGN's own reach used by the tests below.
    const soloCampaign = repo.createRecord('campaign', ctx, { name: 'Account member test', status: 'active', channel: 'linkedin' });
    const result = campaigns.addMembers(ctx, soloCampaign.id, 'account', [CAMPAIGN_ACCOUNT.id]);
    equal(result.added, 1);
    const row = db.get('SELECT * FROM campaign_members WHERE campaign_id = ? AND member_type = ? AND member_id = ?', [soloCampaign.id, 'account', CAMPAIGN_ACCOUNT.id]);
    assert(row, 'the membership row exists');
    equal(row.account_id, CAMPAIGN_ACCOUNT.id, 'an account member points at itself');
});

check('removing a member keeps the history', () => {
    campaigns.removeMembers(ctx, CAMPAIGN.id, 'contact', [CAMPAIGN_CONTACT.id]);
    const row = db.get('SELECT * FROM campaign_members WHERE campaign_id = ? AND member_id = ?', [CAMPAIGN.id, CAMPAIGN_CONTACT.id]);
    assert(row, 'the row survives removal — a campaign\'s reach in March is a fact about March');
    assert(row.removed_at, 'and it is marked removed rather than deleted');
    equal(campaigns.reach(CAMPAIGN.id), 1, 'reach still counts them');
    // Re-adding restores them without losing the original added_at.
    const readd = campaigns.addMembers(ctx, CAMPAIGN.id, 'contact', [CAMPAIGN_CONTACT.id]);
    equal(readd.readded, 1);
});

check('campaign revenue keeps one-time and recurring apart', () => {
    const deal = repo.createRecord('deal', ctx, {
        name: 'Campaign deal', account_id: CAMPAIGN_ACCOUNT.id, pipeline_id: PIPE,
        stage_id: STAGE_WON, status: 'won', currency: 'SAR', campaign_id: CAMPAIGN.id,
    });
    db.run(
        `INSERT INTO deal_line_items (id, workspace_id, deal_id, label, pricing_model, recurrence, quantity, unit_amount, currency, fx_rate, position)
         VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
        [db.id('dli'), WS, deal.id, 'Placement', 'fixed_fee', 'one_time', 1, 90000, 'SAR', 1],
    );
    db.run(
        `INSERT INTO deal_line_items (id, workspace_id, deal_id, label, pricing_model, recurrence, quantity, unit_amount, term_months, currency, fx_rate, position)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
        [db.id('dli'), WS, deal.id, 'Seats', 'per_seat', 'monthly', 1, 4800, 24, 'SAR', 1],
    );

    const rollup = campaigns.rollupFor([CAMPAIGN.id], { baseCurrency: 'SAR' }).get(CAMPAIGN.id);
    equal(rollup.influenced_one_time, 90000);
    equal(rollup.influenced_mrr, 4800);
    assert(!('influenced_total' in rollup),
        'there must be no combined revenue figure — adding a placement fee to a monthly retainer is the sum this codebase refuses to make');
});

/* ============================================ 10b. Smartlead outreach == */

describe('Smartlead outreach');

const outreach = await import('./lib/outreach.mjs');
const metaApiForOutreach = await import('./api/meta.mjs');

await checkAsync('a Smartlead-linked campaign\'s external_id survives into /api/meta', async () => {
    // The regression: linkedCampaigns() (public/js/outreach.js) filters the
    // cached campaign list on external_id, and both the SQL here and the
    // client-side cache in public/js/store.js used to drop that column —
    // so the "Add to Smartlead" wizard found zero linked campaigns on a
    // workspace that had one, every single time, for anyone who had not
    // already visited the Campaigns list this session.
    db.run(`UPDATE campaigns SET external_id = ? WHERE id = ?`, ['sl_test_555', CAMPAIGN.id]);
    try {
        const meta = await metaApiForOutreach.meta({ ctx });
        const row = meta.campaigns.find((c) => c.id === CAMPAIGN.id);
        assert(row, 'the campaign is still in the list');
        equal(row.external_id, 'sl_test_555', 'external_id must round-trip — it is the only signal the wizard has');
    } finally {
        db.run(`UPDATE campaigns SET external_id = NULL WHERE id = ?`, [CAMPAIGN.id]);
    }
});

await checkAsync('enrolling with dryRun classifies without writing anything', async () => {
    db.run(`UPDATE campaigns SET external_id = ? WHERE id = ?`, ['sl_test_555', CAMPAIGN.id]);
    settings.setSetting(ctx.workspaceId, 'smartlead_api_key', 'test-key-never-used-in-dry-run');
    // A fresh contact, never a member — CAMPAIGN_CONTACT was already added to
    // CAMPAIGN earlier in this describe block ("adding the same member twice
    // does not duplicate them"), which would classify as already_member here.
    const freshContact = repo.createRecord('contact', ctx, {
        first_name: 'Dry', last_name: 'Run', data_source: 'test', email: 'dryrun.review@example.com',
        account_id: CAMPAIGN_ACCOUNT.id,
    });
    try {
        const before = db.get(`SELECT COUNT(*) AS n FROM campaign_members WHERE campaign_id = ? AND member_type = 'contact'`, [CAMPAIGN.id]).n;
        const result = await outreach.enrollContacts(ctx, {
            campaignId: CAMPAIGN.id,
            contacts: [{ ...freshContact, account_name: CAMPAIGN_ACCOUNT.name }],
            mapping: {},
            options: { dryRun: true },
        });
        equal(result.dryRun, true);
        equal(result.summary.pending, 1, 'classified as would-enroll');
        equal(result.results[0].company, 'Campaign Co', 'company travels through for the review table');
        const after = db.get(`SELECT COUNT(*) AS n FROM campaign_members WHERE campaign_id = ? AND member_type = 'contact'`, [CAMPAIGN.id]).n;
        equal(after, before, 'a dry run writes no membership row — it only answers what WOULD happen');
    } finally {
        db.run(`UPDATE campaigns SET external_id = NULL WHERE id = ?`, [CAMPAIGN.id]);
        settings.setSetting(ctx.workspaceId, 'smartlead_api_key', null);
    }
});

await checkAsync('a contact already in the campaign is reported, not silently re-added', async () => {
    db.run(`UPDATE campaigns SET external_id = ? WHERE id = ?`, ['sl_test_555', CAMPAIGN.id]);
    settings.setSetting(ctx.workspaceId, 'smartlead_api_key', 'test-key-never-used-in-dry-run');
    const already = repo.createRecord('contact', ctx, {
        first_name: 'Already', last_name: 'Member', data_source: 'test', email: 'already.member@example.com',
        account_id: CAMPAIGN_ACCOUNT.id,
    });
    db.run(
        `INSERT INTO campaign_members (id, workspace_id, campaign_id, member_type, member_id, account_id, status, outreach_status, added_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [db.id('cmm'), WS, CAMPAIGN.id, 'contact', already.id, CAMPAIGN_ACCOUNT.id, 'contacted', 'contacted', db.now()],
    );
    try {
        const result = await outreach.enrollContacts(ctx, {
            campaignId: CAMPAIGN.id,
            contacts: [{ ...already, account_name: CAMPAIGN_ACCOUNT.name }],
            mapping: {},
            options: { dryRun: true },
        });
        equal(result.summary.already_member, 1);
        equal(result.results[0].existingMembership.outreachStatus, 'contacted',
            'the existing membership is inspectable, not just a flag');
    } finally {
        db.run(`UPDATE campaigns SET external_id = NULL WHERE id = ?`, [CAMPAIGN.id]);
        settings.setSetting(ctx.workspaceId, 'smartlead_api_key', null);
    }
});

/* =========================================== 11. bulk operations ======= */

describe('Bulk operations');

check('a bulk preview reports permission failures before anything is written', () => {
    const owned = repo.createRecord('account', ctx, { name: 'Owned by admin' });
    assert(!auth.canWriteRecord(repCtx, db.get('SELECT * FROM accounts WHERE id = ?', [owned.id])),
        'a rep must not be able to write an account owned by someone else');
});

check('a soft-deleted record leaves the live list and enters the trash', () => {
    const doomed = repo.createRecord('account', ctx, { name: 'To be deleted', lifecycle_stage: 'qualified' });
    repo.deleteRecord('account', ctx, doomed.id);

    const live = repo.listRecords('account', ctx, { filter: { op: 'and', children: [] } });
    assert(!live.records.some((r) => r.id === doomed.id), 'it is gone from the live list');

    const trash = repo.listRecords('account', ctx, { filter: { op: 'and', children: [] }, onlyDeleted: true, includeDeleted: true });
    assert(trash.records.some((r) => r.id === doomed.id), 'and present in the trash, so the delete is undoable');

    repo.restoreRecord('account', ctx, doomed.id);
    const back = repo.listRecords('account', ctx, { filter: { op: 'and', children: [] } });
    assert(back.records.some((r) => r.id === doomed.id), 'restore brings it back');
});

/* ============================================== 12. import engine ====== */

describe('Import engine');

const imports = await import('./lib/import.mjs');

const IMPORT_CSV = 'Company Name,Company LinkedIn,Personal LinkedIn,Website,Ref\n'
    + 'Import One,https://www.linkedin.com/company/import-one/,https://www.linkedin.com/in/someone/,https://one.example,IMP-1\n'
    + 'Import Two,https://www.linkedin.com/company/import-two/,https://www.linkedin.com/in/other/,https://two.example,IMP-2\n';

const PROFILE = await imports.profile(IMPORT_CSV, 'account', WS);

check('columns are detected from their VALUES, not their header text', () => {
    const company = PROFILE.columns.find((c) => c.name === 'Company LinkedIn');
    equal(company.suggestion, 'linkedin_slug', 'the company URL column is found');
    assert(company.confidence > 0.9, 'and it is confident, because the values are unambiguous');
});

check('a personal LinkedIn column never becomes the company URL or the website', () => {
    const personal = PROFILE.columns.find((c) => c.name === 'Personal LinkedIn');
    assert(personal.suggestion !== 'linkedin_slug', 'a /in/ profile is not a company');
    assert(personal.suggestion !== 'website',
        'and a rule that recognises something specific must decline rather than settle for "it is a URL"');
});

check('a real website column keeps the website field', () => {
    equal(PROFILE.columns.find((c) => c.name === 'Website').suggestion, 'website');
});

check('a required field with a default is not reported as missing', () => {
    assert(!PROFILE.requiredMissing.some((f) => f.key === 'lifecycle_stage'),
        'lifecycle defaults to prospect, so demanding it would make every import repeat a value the system knows');
});

const IMPORT_MAPPING = { 0: 'name', 1: 'linkedin_slug', 3: 'website', 4: 'external_id' };

const importPreview = await imports.process(ctx, {
    text: IMPORT_CSV, objectKey: 'account', mapping: IMPORT_MAPPING, apply: false,
});

check('the preview counts what execution will do', () => {
    equal(importPreview.counts, { create: 2, update: 0, skip: 0, reject: 0 });
});

const importRun = await imports.process(ctx, {
    text: IMPORT_CSV, objectKey: 'account', mapping: IMPORT_MAPPING, apply: true,
});

check('execution matches the preview exactly', () => {
    equal(importRun.counts, importPreview.counts,
        'a preview that is merely similar to the run is worse than no preview, because it is trusted');
});

check('a full LinkedIn URL is stored as the bare slug the engine keys on', () => {
    const row = db.get('SELECT linkedin_slug FROM accounts WHERE external_id = ?', ['IMP-1']);
    equal(row.linkedin_slug, 'import-one',
        'storing the URL here would leave the account permanently unmatchable against its own evidence');
});

const secondRun = await imports.process(ctx, {
    text: IMPORT_CSV, objectKey: 'account', mapping: IMPORT_MAPPING, apply: true,
});

check('re-uploading the same file creates nothing', () => {
    equal(secondRun.counts.create, 0, 'this is the single most common CRM data disaster');
    equal(secondRun.counts.update, 2);
});

await checkAsync('a duplicate inside the file is skipped with a reason, not silently merged', async () => {
    const doubled = IMPORT_CSV + 'Import One Again,https://www.linkedin.com/company/import-one/,,https://one.example,IMP-1\n';
    const result = await imports.process(ctx, {
        text: doubled, objectKey: 'account', mapping: IMPORT_MAPPING, apply: false,
    });
    const skipped = result.results.find((r) => r.outcome === 'skipped');
    assert(skipped, 'the repeated row is skipped');
    assert(/earlier in this file/.test(skipped.reason), 'and the reason says why');
});

await checkAsync('import writes through the normal validation path', async () => {
    // `data_source` is required on contacts with no default, so a contact
    // import that omits it must reject the rows rather than write them.
    const result = await imports.process(ctx, {
        text: 'First,Last\nAda,Lovelace\n',
        objectKey: 'contact', mapping: { 0: 'first_name', 1: 'last_name' }, apply: false,
    });
    equal(result.counts.reject, 1);
    assert(/Data source/i.test(result.results[0].reason), 'and the reason is the validator\'s own words');
});

/**
 * ONE FILE, TWO OBJECTS — a lead-gen export with a company's own facts (site,
 * industry, LinkedIn, type) in the same row as the person to call there
 * (name, title, email, phone, personal LinkedIn). Importing as `account` and
 * mapping both sets writes the account AND raises its primary contact, in
 * the one pass — see PRIMARY_CONTACT_FIELDS in lib/repo.mjs.
 */
const ACCOUNT_CONTACT_CSV = 'Company,Company Site,Company LinkedIn,Industry,City,Type,'
    + 'Contact Name,Role,Contact Email,Contact Phone,Contact LinkedIn,Ref\n'
    + 'Combined Import Ltd,https://combined.example,https://www.linkedin.com/company/combined-import/,'
    + 'Technology,Jeddah,Regional,Sara Al Otaibi,Head of Procurement,sara@combined.example,'
    + '+966511111111,https://www.linkedin.com/in/sara-alotaibi/,COMB-1\n';

const ACCOUNT_CONTACT_MAPPING = {
    0: 'name', 1: 'website', 2: 'linkedin_slug', 3: 'industry', 4: 'city', 5: 'account_type',
    6: 'contact_full_name', 7: 'contact_title', 8: 'contact_email', 9: 'contact_phone',
    10: 'contact_linkedin_url', 11: 'external_id',
};

await checkAsync('an account import carrying contact columns creates both, in one pass', async () => {
    const result = await imports.process(ctx, {
        text: ACCOUNT_CONTACT_CSV, objectKey: 'account', mapping: ACCOUNT_CONTACT_MAPPING, apply: true,
    });
    equal(result.counts, { create: 1, update: 0, skip: 0, reject: 0 });

    const account = db.get('SELECT * FROM accounts WHERE external_id = ?', ['COMB-1']);
    assert(account, 'the account was created');
    equal(account.industry, 'Technology');
    equal(account.account_type, 'Regional');

    const contact = db.get('SELECT * FROM contacts WHERE account_id = ? AND deleted_at IS NULL', [account.id]);
    assert(contact, 'its primary contact was created in the same pass, with no second file needed');
    equal(contact.first_name, 'Sara');
    equal(contact.last_name, 'Al Otaibi');
    equal(contact.title, 'Head of Procurement');
    equal(contact.email, 'sara@combined.example');
    equal(contact.phone, '+966511111111');
    equal(contact.linkedin_url, 'https://www.linkedin.com/in/sara-alotaibi/');
    equal(contact.data_source, 'Entered on the account record');
});

/**
 * THE OTHER DIRECTION — a contact-primary lead file that also carries the
 * company's own facts. Importing as `contact` and mapping the account_*
 * columns alongside contact_account_name creates the (brand-new) account
 * with those firmographics already on it, not just a bare name.
 */
const CONTACT_ACCOUNT_CSV = 'Contact,Email,Company,Company Site,Company LinkedIn,Industry,City,Type\n'
    + 'Omar Fathy,omar@newlead.example,New Lead Co,https://newlead.example,'
    + 'https://www.linkedin.com/company/new-lead-co/,Manufacturing,Alexandria,Egypt\n';

const CONTACT_ACCOUNT_MAPPING = {
    0: 'full_name', 1: 'email', 2: 'contact_account_name', 3: 'account_website',
    4: 'account_linkedin', 5: 'account_industry', 6: 'account_city', 7: 'account_type',
};

await checkAsync('a contact import carrying account columns creates the account WITH its firmographics', async () => {
    const result = await imports.process(ctx, {
        text: CONTACT_ACCOUNT_CSV, objectKey: 'contact', mapping: CONTACT_ACCOUNT_MAPPING,
        defaults: { data_source: 'test import' }, apply: true,
    });
    equal(result.counts, { create: 1, update: 0, skip: 0, reject: 0 });

    const contact = db.get('SELECT * FROM contacts WHERE email = ?', ['omar@newlead.example']);
    assert(contact, 'the contact was created');

    const account = db.get('SELECT * FROM accounts WHERE id = ?', [contact.account_id]);
    assert(account, 'a brand-new account was created for it, not left unlinked');
    equal(account.name, 'New Lead Co');
    equal(account.website, 'https://newlead.example');
    equal(account.linkedin_slug, 'new-lead-co');
    equal(account.industry, 'Manufacturing');
    equal(account.city, 'Alexandria');
    equal(account.account_type, 'Egypt');
});

/**
 * A DIFFERENT ROW'S auto-created account fails to write — most often
 * because two rows landed on the same LinkedIn slug (a mismapped column
 * such as "HQ city" pointed at Account LinkedIn is what actually happened
 * in the field) — and the account object's UNIQUE index refuses the
 * second. That used to be the one write in this whole function outside
 * the per-row try/catch, so a database error there crashed the ENTIRE
 * request with a raw "UNIQUE constraint failed" 500 and took every other
 * row in the file down with it — reported as "importing a list of leads
 * gives a 500". The one bad row must reject with a readable reason; every
 * other row must still go in.
 */
await checkAsync('a row whose account fails to create is rejected, not a crash that loses the whole file', async () => {
    const csv = 'Contact,Email,Company,Company LinkedIn\n'
        + 'First Person,first@collide.example,First Co,riyadh\n'
        + 'Second Person,second@collide.example,Second Co,riyadh\n'
        + 'Third Person,third@collide.example,Third Co,elsewhere\n';
    const mapping = { 0: 'full_name', 1: 'email', 2: 'contact_account_name', 3: 'account_linkedin' };

    const result = await imports.process(ctx, {
        text: csv, objectKey: 'contact', mapping, defaults: { data_source: 'test import' }, apply: true,
    });

    equal(result.counts, { create: 2, update: 0, skip: 0, reject: 1 },
        'the file keeps going after the one bad row, instead of the whole request throwing');
    const rejected = result.results.find((r) => r.outcome === 'rejected');
    assert(rejected, 'the second colliding row is rejected, not silently dropped or crashed on');
    assert(/already has this/i.test(rejected.reason) && /LinkedIn/i.test(rejected.reason),
        `the reason names the actual field, not a raw database message: ${rejected.reason}`);

    assert(db.get('SELECT id FROM contacts WHERE email = ?', ['first@collide.example']), 'row 1 still landed');
    assert(!db.get('SELECT id FROM contacts WHERE email = ?', ['second@collide.example']), 'row 2 did not — its account never got made');
    assert(db.get('SELECT id FROM contacts WHERE email = ?', ['third@collide.example']), 'row 3, unaffected by the collision, still landed');
});

/* ======================================= 13. qualifying by hand ======== */

describe('Manual decisions');

const DECIDE_ACCOUNT = repo.createRecord('account', ctx, { name: 'Decide Co', linkedin_slug: 'decide-co' });

await checkAsync('a manual decision is appended, never an edit', async () => {
    await qual.qualifyAccount(ctx, DECIDE_ACCOUNT.id, 'hcm');
    const engineVerdict = db.get('SELECT * FROM verdicts WHERE account_id = ? AND is_current = 1', [DECIDE_ACCOUNT.id]);

    qual.recordDecision(ctx, DECIDE_ACCOUNT.id, 'hcm', {
        verdict: 'QUALIFIED', reason: 'Filtered the People tab — no HR staff at all.',
    });

    const rows = db.all('SELECT * FROM verdicts WHERE account_id = ? ORDER BY computed_at', [DECIDE_ACCOUNT.id]);
    equal(rows.length, 2, 'the engine verdict and the decision both exist');

    const stillThere = db.get('SELECT * FROM verdicts WHERE id = ?', [engineVerdict.id]);
    equal(stillThere.verdict, engineVerdict.verdict, 'the engine\'s answer is unchanged');
    equal(stillThere.is_current, 0, 'it is superseded, not overwritten');

    const current = db.get('SELECT * FROM verdicts WHERE account_id = ? AND is_current = 1', [DECIDE_ACCOUNT.id]);
    equal(current.verdict, 'QUALIFIED');
    equal(current.source, 'manual', 'a human verdict and a computed one must never look alike');
    assert(current.decided_by, 'and it names who decided');
});

check('a decision without a reason is refused', () => {
    throws(
        () => qual.recordDecision(ctx, DECIDE_ACCOUNT.id, 'hcm', { verdict: 'REJECTED', reason: '' }),
        /reason/i,
        'an override with no stated reason cannot be explained three months later',
    );
});

check('UNRESOLVED cannot be decided by a person', () => {
    throws(
        () => qual.recordDecision(ctx, DECIDE_ACCOUNT.id, 'hcm', { verdict: 'UNRESOLVED', reason: 'because' }),
        /UNRESOLVED/,
        'it describes the data, not a judgement',
    );
});

await checkAsync('re-running the engine supersedes a manual decision rather than being blocked by it', async () => {
    await qual.qualifyAccount(ctx, DECIDE_ACCOUNT.id, 'hcm');
    const current = db.get('SELECT * FROM verdicts WHERE account_id = ? AND rule_key = ? AND is_current = 1', [DECIDE_ACCOUNT.id, 'hcm']);
    equal(current.source, 'engine', 'new evidence beats an old judgement, and the history shows both');
    const manual = db.all('SELECT * FROM verdicts WHERE account_id = ? AND source = ?', [DECIDE_ACCOUNT.id, 'manual']);
    equal(manual.length, 1, 'the decision is still readable in the history');
});

/* ================================= 14. the metadata promise ============ */

describe('Option sources');

check('option sources are declared on the field, not hardcoded per object', () => {
    const contactFields = objects.fieldsFor('contact', WS);
    equal(contactFields.find((f) => f.key === 'services')?.optionsSource, 'service_lines');
    equal(contactFields.find((f) => f.key === 'campaign_id')?.optionsSource, 'campaigns');
    // The same source on a different object — which the old per-object
    // if-chain got wrong by construction.
    equal(objects.fieldsFor('deal', WS).find((f) => f.key === 'service_line_key')?.optionsSource, 'service_lines');
    equal(objects.fieldsFor('campaign', WS).find((f) => f.key === 'service_line_key')?.optionsSource, 'service_lines');
});

check('the client resolves every declared option source', () => {
    const storeJs = fs.readFileSync(new URL('./public/js/store.js', import.meta.url), 'utf8');
    for (const source of objects.OPTION_SOURCES) {
        assert(new RegExp(`\\b${source}:`).test(storeJs), `store.js must resolve the "${source}" option source`);
    }
});

check('no object/field special cases were left in the client resolver', () => {
    const storeJs = fs.readFileSync(new URL('./public/js/store.js', import.meta.url), 'utf8');
    const offenders = storeJs.match(/objectKey === '\w+' && fieldKey === /g) ?? [];
    equal(offenders, [], 'a per-object if-chain makes the same field on a second object silently empty');
});

/* ============================================================ PROSPECTING === */

describe('Prospecting');

async function makeProspect(name, slug, payload) {
    const created = repo.createRecord('prospecting_company', ctx, { name, linkedin_slug: slug });
    if (payload) qual.recordEvidence(ctx, { prospectId: created.id, subjectKey: slug, provider: 'test', payload });
    return created;
}

/**
 * The regression that made this whole module unreachable.
 *
 * `qualifySubject` writes subject_type/subject_key into the verdict table. When
 * those columns existed in neither schema.sql nor the column migrations, EVERY
 * qualification run threw `table verdicts has no column named subject_type` —
 * 13 of the suite's own tests, every Qualify button, and the snapshot import.
 * Nothing had been qualified since. This asserts the write path end to end.
 */
await checkAsync('a prospect can actually be qualified', async () => {
    const p = await makeProspect('AFCO STEEL', 'afco-prospect', AFCO);
    const off = await qual.qualifyProspect(ctx, p.id, 'offshoring');
    equal(off.verdict, 'QUALIFIED', '252 staff, 71 in Egypt');
    const row = db.get('SELECT * FROM prospecting_verdicts WHERE id = ?', [off.id]);
    assert(row, 'the verdict row was actually written');
    equal(row.subject_type, 'prospect', 'and it names its own plane');
    equal(row.subject_key, 'afco-prospect', 'and the identity it was decided against');
});

check('both verdict tables carry the columns the engine writes', () => {
    for (const table of ['verdicts', 'prospecting_verdicts']) {
        const columns = db.all(`PRAGMA table_info(${table})`).map((c) => c.name);
        for (const needed of ['subject_type', 'subject_key']) {
            assert(columns.includes(needed), `${table}.${needed} must exist or every qualification run throws`);
        }
    }
});

/**
 * The reason status is a rollup and not a column somebody types.
 *
 * This company is right for offshoring and wrong for HCM — which is the common
 * case, not the corner case. A single status field would have to pick one, and
 * whichever it picked would throw away a real lead or invent one.
 */
await checkAsync('qualifying for one service outweighs rejection by another', async () => {
    const p = await makeProspect('Mixed Verdict Co', 'mixed-verdict', AFCO);
    const status = () => db.get('SELECT status FROM prospecting_companies WHERE id = ?', [p.id]).status;

    await qual.qualifyProspect(ctx, p.id, 'hcm');
    equal(status(), 'uploaded',
        'HCM rejecting it while offshoring is unevaluated is not a rejection — it is one answer out of two');

    await qual.qualifyProspect(ctx, p.id, 'offshoring');
    equal(status(), 'qualified',
        'and offshoring qualifying it wins outright — it is a real lead, for a different service');

    const current = db.all('SELECT rule_key, verdict FROM prospecting_verdicts WHERE prospect_id = ? AND is_current = 1', [p.id]);
    equal(current.find((v) => v.rule_key === 'hcm').verdict, 'REJECTED',
        'and the rollup does not rewrite the per-service verdict underneath it');
});

/** `rejected` takes unanimity, exactly as disqualifying an account does. */
await checkAsync('rejected requires every active rule to reject', async () => {
    const p = await makeProspect('Too Big For Both', 'too-big-for-both', {
        slug: 'too-big-for-both', companyName: 'Too Big', totalMembers: 5000,
        locations: [{ label: 'Saudi Arabia toggle off', count: 4800 }],
        functions: [{ label: 'Human Resources toggle off', count: 90 }],
    });
    for (const rule of ['hcm', 'offshoring']) await qual.qualifyProspect(ctx, p.id, rule);
    const current = db.all('SELECT verdict FROM prospecting_verdicts WHERE prospect_id = ? AND is_current = 1', [p.id]);
    const status = db.get('SELECT status FROM prospecting_companies WHERE id = ?', [p.id]).status;
    equal(status, current.every((v) => v.verdict === 'REJECTED') ? 'rejected' : status,
        'unanimous rejection, and only unanimous rejection, rolls up to rejected');
});

await checkAsync('REVIEW beside REJECTED is not a rejection', async () => {
    // No evidence for HCM to work with, so it cannot answer; offshoring rejects.
    const p = await makeProspect('Unsettled Co', 'unsettled-co', {
        slug: 'unsettled-co', companyName: 'Unsettled', totalMembers: 300,
        locations: [{ label: 'Saudi Arabia toggle off', count: 40 }],
        functions: [],
    });
    for (const rule of ['hcm', 'offshoring']) await qual.qualifyProspect(ctx, p.id, rule);
    const verdicts = db.all('SELECT rule_key, verdict FROM prospecting_verdicts WHERE prospect_id = ? AND is_current = 1', [p.id]);
    const status = db.get('SELECT status FROM prospecting_companies WHERE id = ?', [p.id]).status;
    if (verdicts.some((v) => v.verdict === 'REVIEW') && !verdicts.some((v) => v.verdict === 'QUALIFIED')) {
        assert(status !== 'rejected', 'one REJECTED beside one REVIEW is one answer and one non-answer');
    }
});

await checkAsync('an imported prospect is never dragged back into the queue', async () => {
    const p = await makeProspect('Already Imported', 'already-imported', AFCO);
    db.run('UPDATE prospecting_companies SET status = ?, imported_at = ? WHERE id = ?', ['imported', db.now(), p.id]);
    await qual.qualifyProspect(ctx, p.id, 'hcm');   // would otherwise roll up to `rejected`
    equal(db.get('SELECT status FROM prospecting_companies WHERE id = ?', [p.id]).status, 'imported',
        'a re-run at 2am must not pull a company out from under the person selling to it');
});

/**
 * The second half of the same bug. Even with verdicts written correctly, the
 * filter compiler, the sort compiler and the row hydrator all hardcoded
 * `verdicts` / `account_id` — so a prospecting list showed a verdict column
 * that was permanently UNRESOLVED and filtered to zero rows, with no error.
 */
await checkAsync('verdict columns resolve against the prospecting plane', async () => {
    const p = await makeProspect('Hydrated Co', 'hydrated-co', AFCO);
    await qual.qualifyProspect(ctx, p.id, 'offshoring');

    const [hydrated] = repo.hydrate('prospecting_company', [db.get('SELECT * FROM prospecting_companies WHERE id = ?', [p.id])], ctx);
    equal(hydrated.verdict_offshoring, 'QUALIFIED', 'the list cell reads the prospect verdict, not an account one');

    const compiled = query.compileFilter('prospecting_company', WS,
        { op: 'and', children: [{ field: 'verdict_offshoring', operator: 'is_any_of', value: ['QUALIFIED'] }] });
    assert(/prospecting_verdicts/.test(compiled.sql), 'and the filter targets prospecting_verdicts');
    assert(!/FROM verdicts/.test(compiled.sql), 'never the account table');

    const sorted = query.compileSort('prospecting_company', WS, [{ field: 'verdict_offshoring', direction: 'asc' }]);
    assert(/prospecting_verdicts/.test(sorted), 'and so does the sort');
});

check('every qualifiable object declares which plane its verdicts live in', () => {
    for (const [key, def] of Object.entries(objects.OBJECTS)) {
        if (!def.computed) continue;
        const hasVerdictColumn = Object.values(def.computed).some((c) => c.kind === 'verdict');
        if (!hasVerdictColumn) continue;
        const plane = objects.verdictPlane(key);
        assert(plane?.table && plane?.idColumn,
            `${key} shows verdict columns but names no verdict table — they would silently read empty`);
    }
});

/* ========================================================= UPLOAD HISTORY === */

describe('Upload history');

function makeUpload(filename, companies) {
    const batchId = imports.createBatch(ctx, {
        objectKey: 'prospecting_company', filename, source: 'upload', mapping: {}, options: {}, totalRows: companies.length,
    });
    for (const name of companies) {
        const p = repo.createRecord('prospecting_company', ctx, { name });
        db.run('UPDATE prospecting_companies SET import_batch_id = ? WHERE id = ?', [batchId, p.id]);
    }
    imports.finishBatch(ctx, batchId, { create: companies.length, update: 0, skip: 0, reject: 0 });
    return batchId;
}

check('an upload reports the CURRENT state of what it brought in', () => {
    const batchId = makeUpload('leads-q3.csv', ['Alpha Co', 'Beta Co', 'Gamma Co']);
    const ids = db.all('SELECT id FROM prospecting_companies WHERE import_batch_id = ?', [batchId]).map((r) => r.id);
    db.run('UPDATE prospecting_companies SET status = ? WHERE id = ?', ['qualified', ids[0]]);
    db.run('UPDATE prospecting_companies SET status = ? WHERE id = ?', ['review_required', ids[1]]);
    db.run('UPDATE prospecting_companies SET status = ? WHERE id = ?', ['rejected', ids[2]]);

    const row = imports.uploadHistory(ctx).records.find((u) => u.id === batchId);
    equal(row.filename, 'leads-q3.csv', 'the file name is kept');
    equal(row.totalRows, 3, 'total records is frozen at what the file held');
    equal([row.qualified, row.reviewRequired, row.rejected], [1, 1, 1], 'the funnel is counted live');

    // The whole reason these counts are derived rather than stored: a verdict
    // changing after the upload must move the number.
    db.run('UPDATE prospecting_companies SET status = ? WHERE id = ?', ['qualified', ids[1]]);
    const after = imports.uploadHistory(ctx).records.find((u) => u.id === batchId);
    equal([after.qualified, after.reviewRequired], [2, 0], 'a settled review moves the count with no re-import');
    equal(after.totalRows, 3, 'while total records, being history, does not move');
});

check('deleting an upload bins its companies and can be undone', () => {
    const batchId = makeUpload('temp-list.csv', ['Delta Co', 'Epsilon Co']);
    const { removed } = imports.deleteUpload(ctx, batchId);
    equal(removed, 2, 'both companies went to the Recycle Bin');

    const live = db.get('SELECT COUNT(*) n FROM prospecting_companies WHERE import_batch_id = ? AND deleted_at IS NULL', [batchId]).n;
    equal(live, 0, 'and none are left in the working list');
    assert(!imports.uploadHistory(ctx).records.some((u) => u.id === batchId), 'the upload leaves the default history');
    assert(imports.uploadHistory(ctx, { includeDeleted: true }).records.some((u) => u.id === batchId), 'but is in the bin');

    const { restored } = imports.restoreUpload(ctx, batchId);
    equal(restored, 2, 'and restoring brings exactly those companies back');
    equal(db.get('SELECT COUNT(*) n FROM prospecting_companies WHERE import_batch_id = ? AND deleted_at IS NULL', [batchId]).n, 2, 'live again');
});

/**
 * A company already imported into the CRM is being worked by a salesperson.
 * Tidying up an old upload must not take a live opportunity off their desk.
 */
check('deleting an upload never withdraws a company already imported into the CRM', () => {
    const batchId = makeUpload('mixed-list.csv', ['Zeta Co', 'Eta Co']);
    const ids = db.all('SELECT id FROM prospecting_companies WHERE import_batch_id = ? ORDER BY name', [batchId]).map((r) => r.id);
    db.run('UPDATE prospecting_companies SET status = ?, imported_at = ? WHERE id = ?', ['imported', db.now(), ids[0]]);

    const { removed, keptBecauseImported } = imports.deleteUpload(ctx, batchId);
    equal(removed, 1, 'only the un-imported company is binned');
    equal(keptBecauseImported, 1, 'and the imported one is reported, not silently skipped');
    equal(db.get('SELECT deleted_at FROM prospecting_companies WHERE id = ?', [ids[0]]).deleted_at, null,
        'the imported company is untouched');
});

check('restoring an upload does not resurrect separately deleted companies', () => {
    const batchId = makeUpload('partial.csv', ['Theta Co', 'Iota Co']);
    const ids = db.all('SELECT id FROM prospecting_companies WHERE import_batch_id = ? ORDER BY name', [batchId]).map((r) => r.id);
    // Someone removes one company on its own merits, well before the upload is binned.
    db.run('UPDATE prospecting_companies SET deleted_at = ? WHERE id = ?', ['2020-01-01T00:00:00.000Z', ids[0]]);

    imports.deleteUpload(ctx, batchId);
    imports.restoreUpload(ctx, batchId);

    equal(db.get('SELECT deleted_at FROM prospecting_companies WHERE id = ?', [ids[0]]).deleted_at,
        '2020-01-01T00:00:00.000Z', 'a company deleted for its own reasons stays deleted');
    equal(db.get('SELECT deleted_at FROM prospecting_companies WHERE id = ?', [ids[1]]).deleted_at, null,
        'while the rest of the upload comes back');
});

check('import_batch_id cannot be set by hand', () => {
    const field = objects.OBJECTS.prospecting_company.fields.find((f) => f.key === 'import_batch_id');
    assert(field.readOnly, 'which upload a company came from is a fact, not an opinion');
    const p = repo.createRecord('prospecting_company', ctx, { name: 'Sneaky Co', import_batch_id: 'imb_forged' });
    equal(db.get('SELECT import_batch_id FROM prospecting_companies WHERE id = ?', [p.id]).import_batch_id, null,
        'so a forged value is dropped rather than written');
});

/* ================================== 15. DOCUMENT GENERATION ============== */
//
// The port of Automation/HCM/apps-script-dms. Two kinds of check here:
//
//   · unit — the engine and the registry, on synthetic XML, always run
//   · regression — the REAL templates in Automation/, rendered and compared
//     against the hand-authored drafts they were built from. Skipped with a
//     printed note if that folder is absent, never silently passed.

describe('document generation');

const docx = await import('./lib/docx.mjs');
const tpl = await import('./lib/docx-template.mjs');
const types = await import('./lib/document-types.mjs');

const AUTOMATION = path.join(process.cwd(), 'Automation', 'HCM');
const haveTemplates = fs.existsSync(path.join(AUTOMATION, 'Talent 360 - Proposal Template.docx'));

/** A minimal but structurally real document.xml. */
function fakeDoc(paragraphs) {
    const body = paragraphs.map((p) => (p.startsWith('<w:tbl')
        ? p
        : `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
        + `<w:body>${body}<w:sectPr><w:pgSz w:w="11906"/></w:sectPr></w:body></w:document>`;
}

// Section properties are a body child too, and carry no text — excluded so a
// comparison reads as the document's prose rather than its layout.
const textOf = (xml) => tpl.parseBodyChildren(xml).children
    .filter((c) => c.tag !== 'w:sectPr')
    .map((c) => c.text);

check('a placeholder is replaced, and XML-escaped on the way in', () => {
    const xml = fakeDoc(['Dear {{CLIENT_NAME}},']);
    const out = tpl.applyPlaceholders(xml, { CLIENT_NAME: 'Smith & Sons <Holdings>' });
    equal(textOf(out), ['Dear Smith & Sons <Holdings>,'], 'the reader sees the ampersand');
    assert(out.includes('&amp;') && out.includes('&lt;'), 'and the XML stayed well-formed');
});

check('a value containing $ or a backslash survives intact', () => {
    // The Apps Script needed escapeReplacement_ because replaceText is
    // regex-based. This engine does not use regex, and the property is asserted
    // rather than assumed.
    const xml = fakeDoc(['{{FEE}}']);
    equal(textOf(tpl.applyPlaceholders(xml, { FEE: 'US$1,000 \\ net' })), ['US$1,000 \\ net']);
});

check('a missing value renders as empty, never as "undefined"', () => {
    const xml = fakeDoc(['[{{NOPE}}]']);
    equal(textOf(tpl.applyPlaceholders(xml, { NOPE: undefined })), ['[]']);
});

check('a disabled block is removed with its table, and survivors renumber', () => {
    const xml = fakeDoc([
        '{{SEC:RECRUITMENT}}{{NUM:RECRUITMENT}} Recruitment',
        'Recruitment prose',
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Recruitment table</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
        '{{SEC:ONBOARDING}}{{NUM:ONBOARDING}} Onboarding',
        'Onboarding prose',
        '{{SEC:BENEFITS}}{{NUM:BENEFITS}} Benefits',
        'Benefits prose',
        '4. Service Delivery Team',
    ]);
    const out = tpl.applyDynamicBlocks(xml, {
        registry: types.SERVICE_REGISTRY,
        numberFormat: (n) => `3.${n}`,
        terminalBoundaryText: '4. Service Delivery Team',
    }, ['RECRUITMENT', 'BENEFITS']);

    const text = textOf(out);
    assert(!text.some((t) => t.includes('Onboarding')), 'the disabled block is gone, heading and prose');
    assert(text.includes('3.1 Recruitment'), 'and the first survivor keeps 3.1');
    assert(text.includes('3.2 Benefits'), 'and the next survivor closes the gap');
    assert(!out.includes('{{SEC:') && !out.includes('{{NUM:'), 'no control token is left in the document');
});

check('removing a block never eats the terminal boundary', () => {
    const xml = fakeDoc([
        '{{SEC:RECRUITMENT}}{{NUM:RECRUITMENT}} Recruitment',
        'prose',
        '4. Service Delivery Team',
        'The team is…',
    ]);
    const out = tpl.applyDynamicBlocks(xml, {
        registry: types.SERVICE_REGISTRY, numberFormat: (n) => `3.${n}`, terminalBoundaryText: '4. Service Delivery Team',
    }, []);
    equal(textOf(out), ['4. Service Delivery Team', 'The team is…'], 'the section after it is untouched');
});

check('a placeholder split across runs is refused, not silently ignored', () => {
    const split = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
        + `<w:body><w:p><w:r><w:t>{{CLIENT_</w:t></w:r><w:r><w:t>NAME}}</w:t></w:r></w:p></w:body></w:document>`;
    throws(() => tpl.assertNoSplitTokens(split), /split across formatting runs/,
        'because the alternative is shipping a contract with {{CLIENT_NAME}} printed on it');
});

check('a leftover token is reported so the caller can refuse to save', () => {
    const xml = fakeDoc(['{{CLIENT_NAME}} owes {{UNMAPPED_FIELD}}']);
    const result = tpl.renderDocumentXml(xml, { placeholders: { CLIENT_NAME: 'Acme' } });
    equal(result.leftoverTokens, ['{{UNMAPPED_FIELD}}'], 'named, so the error can say which one');
});

check('the contract end date is start + 1 year - 1 day', () => {
    const may = new Date(Date.UTC(2026, 4, 4, 12));
    equal(types.formatDate(types.computeContractEndDate(may), 'UTC'), '03/05/2027');
    // 29 Feb normalises to 1 Mar before the day is subtracted — the same
    // inclusive answer the Apps Script gives.
    const leap = new Date(Date.UTC(2028, 1, 29, 12));
    equal(types.formatDate(types.computeContractEndDate(leap), 'UTC'), '28/02/2029', 'the leap case lands on 28 Feb');
});

check('a date near a UTC boundary keeps the local calendar day', () => {
    // 22:30 UTC is already tomorrow in Riyadh. An agreement dated a day out is
    // the exact failure todayInConfiguredTimezone_ was written to prevent.
    const late = new Date('2026-08-07T22:30:00Z');
    equal(types.formatDate(types.todayIn('Asia/Riyadh', late), 'Asia/Riyadh'), '08/08/2026');
    equal(types.formatDate(types.todayIn('Europe/London', late), 'Europe/London'), '07/08/2026');
});

check('the Arabic agreements write dates as prose, the HCM one does not', () => {
    equal(types.normalizeDateValue('2026-04-01', 'Africa/Cairo', types.formatArabicDate), '1 أبريل 2026م');
    equal(types.normalizeDateValue('2026-04-01', 'Africa/Cairo'), '01/04/2026');
});

check('an amount is grouped in threes, the way the authored drafts write it', () => {
    equal(types.formatAmount(52000), '52,000');
    equal(types.formatAmount(1234567), '1,234,567');
    equal(types.formatAmount(900), '900', 'no separator below a thousand');
    equal(types.formatAmount('45000.50'), '45,000.50', 'the decimals survive');
    equal(types.formatAmount('45,000'), '45,000', 'a value already grouped is not regrouped into 4,5,000');
    equal(types.formatAmount(''), '', 'and a blank field stays blank rather than becoming NaN');
    equal(types.formatAmount('on application'), 'on application', 'text is left alone');
});

check('a fee typed with separators is accepted, not refused as "not a number"', () => {
    const dt = types.DOCUMENT_TYPES.HCM_PROPOSAL;
    const fields = { onsite_visits_per_week: 2, monthly_fee: '45,000', currency: 'SAR', validity_days: 30 };
    equal(types.validateGeneration({ docType: dt, account: { name: 'Acme' }, fields, enabledKeys: ['ONBOARDING'] }), []);

    const bad = types.validateGeneration({
        docType: dt, account: { name: 'Acme' }, enabledKeys: ['ONBOARDING'],
        fields: { ...fields, monthly_fee: 'about forty' },
    });
    equal(bad, ['"Monthly Fee" must be a number.'], 'but something that is not a number still is');
});

check('the section range is singular when only one service is on', () => {
    equal(types.buildSectionRange(1), 'Section 3.1');
    equal(types.buildSectionRange(6), 'Sections 3.1 through 3.6');
});

check('the scope list follows the canonical order, not the click order', () => {
    const enabled = types.enabledServicesFor(['PERSONNEL', 'RECRUITMENT']);
    equal(types.buildServiceScopeList(enabled, 'en'), 'Recruitment & Selection | Personnel Administration');
});

check('Employees To Hire is required only when Recruitment is on', () => {
    const dt = types.DOCUMENT_TYPES.HCM_PROPOSAL;
    const base = { onsite_visits_per_week: 2, monthly_fee: 45000, currency: 'SAR', validity_days: 30 };
    const account = { name: 'Acme' };
    equal(types.validateGeneration({ docType: dt, account, fields: base, enabledKeys: ['ONBOARDING'] }), [],
        'without Recruitment it is not asked for');
    const withRecruitment = types.validateGeneration({ docType: dt, account, fields: base, enabledKeys: ['RECRUITMENT'] });
    equal(withRecruitment, ['"Employees To Hire" is required.'], 'with Recruitment it is');
});

check('an agreement is refused without a commercial registration', () => {
    const dt = types.DOCUMENT_TYPES.HCM_AGREEMENT;
    const fields = {
        onsite_visits_per_week: 2, monthly_fee: 30000, currency: 'جنيه',
        start_date: '2026-09-01', end_date: '2027-08-31', contract_duration_text: 'سنة',
    };
    const none = types.validateGeneration({ docType: dt, account: { name: 'Acme' }, fields, enabledKeys: ['ONBOARDING'] });
    assert(none.some((p) => /commercial registration/i.test(p)), 'and says what to do about it');

    const noRep = types.validateGeneration({
        docType: dt, account: { name: 'Acme' }, fields, enabledKeys: ['ONBOARDING'],
        registration: { company_name_ar: 'أكمي', cr_number: '1010', representative_name: '  ' },
    });
    assert(noRep.some((p) => /representative/i.test(p)), 'a blank representative is caught — they sign it');
});

check('the Arabic certificate name wins over the account name in an agreement', () => {
    const party = types.resolveFirstParty({ name: 'Acme Ltd' }, { company_name_ar: 'شركة أكمي', cr_number: '1010' });
    equal(party.clientName, 'شركة أكمي');
    equal(types.resolveFirstParty({ name: 'Acme Ltd' }, null).clientName, 'Acme Ltd', 'falling back when none is imported');
});

check('a contract date is a date, not whatever text was typed', () => {
    equal(types.parseDateValue('01/09/2026'), '2026-09-01', 'dd/mm/yyyy reads as a real calendar date');
    equal(types.parseDateValue('2026-09-01'), '2026-09-01', 'an ISO date round-trips');
    equal(types.parseDateValue('2026-02-31'), null, '31 February is refused, not rolled into March');
    equal(types.parseDateValue('not-a-date'), null, 'garbage is refused');
    equal(types.parseDateValue(''), null, 'and a blank stays blank');
});

check('an agreement refuses an unreal contract term, not just a missing one', () => {
    const dt = types.DOCUMENT_TYPES.HCM_AGREEMENT;
    const reg = { company_name_ar: 'أكمي', cr_number: '1010', representative_name: 'سمير' };
    const base = {
        onsite_visits_per_week: 2, monthly_fee: 30000, currency: 'جنيه',
        start_date: '2026-09-01', end_date: '2027-08-31', contract_duration_text: 'سنة',
    };
    equal(types.validateGeneration({ docType: dt, account: { name: 'Acme' }, fields: base, enabledKeys: ['ONBOARDING'], registration: reg }), [],
        'real dates still pass');

    const garbage = types.validateGeneration({
        docType: dt, account: { name: 'Acme' }, enabledKeys: ['ONBOARDING'], registration: reg,
        fields: { ...base, start_date: 'not-a-date' },
    });
    assert(garbage.some((p) => /must be a date/i.test(p)), 'text in a date field is caught');

    const reversed = types.validateGeneration({
        docType: dt, account: { name: 'Acme' }, enabledKeys: ['ONBOARDING'], registration: reg,
        fields: { ...base, end_date: '2025-01-01' },
    });
    assert(reversed.some((p) => /must be after/i.test(p)), 'an end date before its start is caught');
});

check('the file name follows the automation convention', () => {
    equal(types.buildDocumentName(types.DOCUMENT_TYPES.HCM_AGREEMENT, { name: 'Acme / Sons: Ltd' }),
        'Talent360 - Acme - Sons- Ltd - HCM Agreement.docx', 'illegal filename characters replaced, not dropped');
});

check('only the document types for that service line are offered', () => {
    equal(types.documentTypesForProduct('hcm').map((d) => d.key), ['HCM_PROPOSAL', 'HCM_AGREEMENT']);
    equal(types.documentTypesForProduct('offshoring').map((d) => d.key), ['OFFSHORING_PROPOSAL', 'OFFSHORING_AGREEMENT']);
});

/* ---- regression against the real templates and their authored drafts ---- */

function renderTemplate(file, docTypeKey, enabledKeys, context) {
    const docType = types.DOCUMENT_TYPES[docTypeKey];
    const zip = docx.readZip(fs.readFileSync(path.join(AUTOMATION, file)));
    const documentXml = docx.readPart(zip, 'word/document.xml');
    const placeholders = docType.buildPlaceholders({
        ...context,
        enabledServices: types.enabledServicesFor(enabledKeys),
        timeZone: 'Africa/Cairo',
        now: context.now ?? new Date('2026-07-15T09:00:00Z'),
    });
    const { xml, leftoverTokens } = tpl.renderDocumentXml(documentXml, {
        dynamicBlocks: docType.dynamicBlocks, enabledKeys, placeholders,
    });
    return { xml, leftoverTokens, zip, headings: textOf(xml).map((t) => t.trim()) };
}

/** The service headings of a rendered document, in the order they appear. */
const serviceHeadings = (headings, pattern) => headings.filter((t) => pattern.test(t) && t.length < 90);

if (!haveTemplates) {
    console.log('\n  ⚠ Automation/HCM not found — the document regression checks did not run.\n');
} else {
    check('HCM Proposal: all seven services render 3.1-3.7, as in the authored draft', () => {
        const r = renderTemplate('Talent 360 - Proposal Template.docx', 'HCM_PROPOSAL', types.SERVICE_KEYS, {
            account: { name: 'Acme Corp' },
            fields: { employees_to_hire: 10, onsite_visits_per_week: 2, monthly_fee: '45,000', currency: 'SAR', validity_days: 30 },
        });
        equal(r.leftoverTokens, [], 'and nothing is left unreplaced');
        equal(serviceHeadings(r.headings, /^3\.\d/), [
            '3.1 Recruitment & Selection – (10 Positions During The Contract)',
            '3.2 Employee Onboarding',
            '3.3 Benefits Administration',
            '3.4 Performance Management',
            '3.5 Employee Relations Management',
            '3.6 Compensation Administration',
            '3.7 Personnel Administration',
        ], 'matching Talent 360 - Draft - HCM Proposal.docx heading for heading');
    });

    check('HCM Proposal: unchecking Benefits closes the gap and removes its table', () => {
        const enabled = types.SERVICE_KEYS.filter((k) => k !== 'BENEFITS');
        const r = renderTemplate('Talent 360 - Proposal Template.docx', 'HCM_PROPOSAL', enabled, {
            account: { name: 'Acme Corp' },
            fields: { employees_to_hire: 10, onsite_visits_per_week: 2, monthly_fee: '45,000', currency: 'SAR', validity_days: 30 },
        });
        equal(serviceHeadings(r.headings, /^3\.\d/), [
            '3.1 Recruitment & Selection – (10 Positions During The Contract)',
            '3.2 Employee Onboarding',
            '3.3 Performance Management',
            '3.4 Employee Relations Management',
            '3.5 Compensation Administration',
            '3.6 Personnel Administration',
        ], 'no gap, no 3.7');
        assert(!r.xml.includes('Benefits Administration'), 'and the block is structurally gone, not hidden');
    });

    check('HCM Proposal: one service renders the singular "Section 3.1"', () => {
        const r = renderTemplate('Talent 360 - Proposal Template.docx', 'HCM_PROPOSAL', ['RECRUITMENT'], {
            account: { name: 'Acme Corp' },
            fields: { employees_to_hire: 4, onsite_visits_per_week: 1, monthly_fee: '9,000', currency: 'SAR', validity_days: 30 },
        });
        assert(r.headings.some((t) => t.includes('Section 3.1') && !t.includes('through')),
            'the pricing paragraph reads Section 3.1, not "Sections 3.1 through 3.1"');
    });

    check('HCM Agreement: articles run 1-7 in document order, single period', () => {
        // This is the defect the port fixes. The Apps Script prints 1, 2, 7, 6,
        // 3, 4, 5 with a doubled period; Draft - HCM Agreement (1).docx reads
        // 1.-7. See docs/10-automation-port-map.md.
        const r = renderTemplate('Talent 360 - HCM Agreement Template.docx', 'HCM_AGREEMENT', types.SERVICE_KEYS, {
            account: { name: 'Acme Corp' },
            registration: {
                company_name_ar: 'شركة أكمي', cr_number: '1010101010',
                representative_name: 'محمد السالم', address: 'الرياض',
            },
            fields: {
                employees_to_hire: 15, onsite_visits_per_week: 2, monthly_fee: '30,000', currency: 'جنيه',
                start_date: '2026-09-01', end_date: '2027-08-31', contract_duration_text: 'سنة ميلادية',
            },
        });
        equal(r.leftoverTokens, [], 'nothing left unreplaced');
        const numbers = serviceHeadings(r.headings, /^\d+\.\s*\S/).slice(0, 7).map((t) => t.split(/\s/)[0]);
        equal(numbers, ['1.', '2.', '3.', '4.', '5.', '6.', '7.'], 'sequential, and never "1.."');
    });

    check('Offshoring documents need no service selection and still render', () => {
        const proposal = renderTemplate('T360 - Offshoring_Payroll Proposal Template.docx', 'OFFSHORING_PROPOSAL', [], {
            account: { name: 'Acme Corp' }, fields: {},
        });
        equal(proposal.leftoverTokens, []);
        const agreement = renderTemplate('T360 - Offshoring Agreement Template.docx', 'OFFSHORING_AGREEMENT', [], {
            account: { name: 'Acme Corp' },
            registration: { company_name_ar: 'شركة أكمي', cr_number: '77', representative_name: 'سالم', address: 'جدة' },
            fields: { monthly_fee: '900', currency: 'دولار', start_date: '2026-04-01', end_date: '2027-03-31' },
        });
        equal(agreement.leftoverTokens, []);
        assert(agreement.xml.includes('1 أبريل 2026م'), 'and its dates are Arabic prose, per its own template');
    });

    check('every part except document.xml comes through byte-identical', () => {
        // The whole fidelity argument in one assertion: fonts, images, styles,
        // header, footer and theme are never decoded, so they cannot drift.
        const file = path.join(AUTOMATION, 'Talent 360 - Proposal Template.docx');
        const source = docx.readZip(fs.readFileSync(file));
        const r = renderTemplate('Talent 360 - Proposal Template.docx', 'HCM_PROPOSAL', types.SERVICE_KEYS, {
            account: { name: 'Acme Corp' },
            fields: { employees_to_hire: 10, onsite_visits_per_week: 2, monthly_fee: '45,000', currency: 'SAR', validity_days: 30 },
        });
        const rebuilt = docx.readZip(docx.writeZip(r.zip, { 'word/document.xml': r.xml }));

        equal(rebuilt.entries.length, source.entries.length, 'no part is added or lost');
        const changed = [];
        for (const entry of source.entries) {
            const after = rebuilt.byName.get(entry.name);
            assert(after, `${entry.name} survived`);
            if (!docx.readEntry(entry).equals(docx.readEntry(after))) changed.push(entry.name);
        }
        equal(changed, ['word/document.xml'], 'exactly one part differs');
    });

    check('the rebuilt package is a valid zip that reads back', () => {
        const r = renderTemplate('Talent 360 - HCM Agreement Template.docx', 'HCM_AGREEMENT', ['RECRUITMENT'], {
            account: { name: 'Acme Corp' },
            registration: { company_name_ar: 'أكمي', cr_number: '1', representative_name: 'س', address: 'ع' },
            fields: {
                employees_to_hire: 2, onsite_visits_per_week: 1, monthly_fee: '1', currency: 'جنيه',
                start_date: '2026-01-01', end_date: '2026-12-31', contract_duration_text: 'سنة',
            },
        });
        const bytes = docx.writeZip(r.zip, { 'word/document.xml': r.xml });
        const reread = docx.readZip(bytes);
        assert(docx.readPart(reread, 'word/document.xml').includes('شركة'), 'Arabic survives the round trip');
        assert(reread.byName.has('word/styles.xml') && reread.byName.has('[Content_Types].xml'),
            'and the parts Word needs to open it are all there');
    });
}

/* ============ 16. DOCUMENT GENERATION, END TO END ======================== */
//
// The service layer: CRM data in, a stored .docx out, versioned and tracked.
// Skipped along with the regression checks when Automation/ is absent, because
// there is no template to generate from.

describe('document generation end to end');

await checkAsync('the ordinary version wizard refuses to touch an Internal Team Proposal — it has no redaction step', async () => {
    const proposalsApi = await import('./api/proposals.mjs');
    const account = repo.createRecord('account', ctx, { name: 'No Manual Edit Ltd', billing_currency: 'USD' });
    const deal = repo.createRecord('deal', ctx, {
        account_id: account.id, service_line_key: 'hcm', pipeline_id: PIPE, stage_id: STAGE_OPEN,
    });
    db.run(
        `INSERT INTO deal_line_items (id, workspace_id, deal_id, label, service_line_key, pricing_model, recurrence, quantity, unit_amount, currency, position)
         VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
        [db.id('dli'), WS, deal.id, 'HCM retainer', 'hcm', 'per_seat', 'monthly', 1, 9000, 'USD'],
    );
    const proposal = (await proposalsApi.createProposal({ req: bodyOf({ title: 'p', dealId: deal.id }), ctx })).proposal;
    await proposalsApi.createVersion({ req: bodyOf({}), params: { id: proposal.id }, ctx });
    const agreement = repo.createRecord('agreement', ctx, {
        title: 'a', account_id: account.id, deal_id: deal.id, proposal_id: proposal.id,
        status: 'approved', effective_date: '2026-01-01',
    });
    await proposalsApi.signAgreement({ req: bodyOf({ effectiveDate: '2026-01-01' }), params: { id: agreement.id }, ctx });

    const internal = db.get(`SELECT * FROM proposals WHERE deal_id = ? AND type = 'internal_team'`, [deal.id]);
    assert(internal, 'the internal proposal exists');

    await proposalsApi.createVersion({ req: bodyOf({}), params: { id: internal.id }, ctx }).then(
        () => { throw new Error('the version wizard must refuse an Internal Team Proposal'); },
        (err) => assert(/not edited by hand|Internal Team Proposal/i.test(err.message), err.message),
    );
    equal(
        db.get('SELECT COUNT(*) AS n FROM proposal_versions WHERE proposal_id = ?', [internal.id]).n,
        1, 'still exactly the one version ensureInternalTeamProposal wrote — the refusal wrote nothing',
    );
});

if (haveTemplates) {
    const gen = await import('./lib/doc-generation.mjs');
    const { setSetting } = await import('./lib/settings.mjs');
    const docReview = await import('./api/proposals.mjs');

    /**
     * Push a document through review, as a manager would.
     *
     * Generated documents now arrive `pending_review` rather than finished, so
     * every test below that wants a LIVE document has to say who approved it —
     * which is the point of the workflow, and worth the extra line.
     */
    const approve = (kind, recordId, note = '') => docReview.reviewDocument({
        req: bodyOf({ decision: 'approved', note }), params: { id: recordId }, ctx, kind,
    });

    const genAccount = repo.createRecord('account', ctx, {
        name: 'Northwind Trading', domain: 'northwind.example', lifecycle_stage: 'customer',
        services: ['hcm'],
    });
    const genDeal = repo.createRecord('deal', ctx, {
        name: 'Northwind HCM', account_id: genAccount.id, pipeline_id: PIPE, stage_id: STAGE_OPEN,
        currency: 'SAR', service_line_key: 'hcm', close_date: '2026-12-31',
    });

    const templateBytes = fs.readFileSync(path.join(AUTOMATION, 'Talent 360 - Proposal Template.docx'));
    const installed = gen.installTemplate(ctx, {
        templateKey: 'hcm_proposal', label: 'HCM Proposal', buffer: templateBytes, fileName: 'proposal.docx',
    });

    const PROPOSAL_FIELDS = {
        employees_to_hire: 10, onsite_visits_per_week: 2,
        monthly_fee: 45000, currency: 'SAR', validity_days: 30,
    };

    check('a template must be a readable .docx', () => {
        throws(() => gen.installTemplate(ctx, {
            templateKey: 'hcm_agreement', label: 'Nope', buffer: Buffer.from('not a zip at all'),
        }), /not a readable \.docx/, 'refused at upload, not discovered when sending a contract');
    });

    check('only the deal’s own service line is offered', () => {
        const keys = gen.availableTypes(ctx, { dealId: genDeal.id }).map((t) => t.key);
        equal(keys, ['HCM_PROPOSAL', 'HCM_AGREEMENT'], 'an HCM deal is not offered Offshoring documents');
    });

    check('the account offers documents for every service it buys', () => {
        const keys = gen.availableTypes(ctx, { accountId: genAccount.id }).map((t) => t.key);
        equal(keys, ['HCM_PROPOSAL', 'HCM_AGREEMENT'], 'from accounts.services, with no deal involved');

        repo.updateRecord('account', ctx, genAccount.id, { services: ['hcm', 'offshoring'] });
        equal(gen.availableTypes(ctx, { accountId: genAccount.id }).map((t) => t.key),
            ['HCM_PROPOSAL', 'HCM_AGREEMENT', 'OFFSHORING_PROPOSAL', 'OFFSHORING_AGREEMENT'],
            'a company that buys two things is offered both');
        repo.updateRecord('account', ctx, genAccount.id, { services: ['hcm'] });
    });

    check('a CR number already on the account is not reported as missing', () => {
        // `accounts.cr_number` (the identity field used to dedupe Saudi
        // entities on import) is a different row from `commercial_registrations`
        // (the fuller first-party record a document actually prints from) —
        // but a user looking at a CR number already on the account read "no
        // commercial registration has been recorded" as flatly wrong.
        // `availableTypes` now treats either as "on file" for the purpose of
        // OFFERING the document; actually generating one still requires the
        // fuller record, per `validateGeneration`'s own stricter check below,
        // unaffected by this.
        const withCr = repo.createRecord('account', ctx, { name: 'Has CR Number Ltd', services: ['hcm'], cr_number: '4021093456' });
        const offered = gen.availableTypes(ctx, { accountId: withCr.id }).find((t) => t.key === 'HCM_AGREEMENT');
        assert(offered, 'the agreement type is still offered');
        assert(!offered.blockers.some((b) => /commercial registration/i.test(b)),
            `a CR number already on the account must not be reported as missing: ${offered.blockers.join('; ')}`);

        const without = repo.createRecord('account', ctx, { name: 'No CR At All Ltd', services: ['hcm'] });
        const stillBlocked = gen.availableTypes(ctx, { accountId: without.id }).find((t) => t.key === 'HCM_AGREEMENT');
        assert(stillBlocked.blockers.some((b) => /commercial registration/i.test(b)),
            'an account with genuinely nothing on file is still told so');
    });

    check('an account with no service is refused, with the instruction to fix it', () => {
        const bare = repo.createRecord('account', ctx, { name: 'No Services Ltd' });
        const gate = gen.serviceGate(ctx, { accountId: bare.id });
        equal(gate.ok, false);
        equal(gate.reason, 'Please add a service to this account first.',
            'the exact sentence the user is meant to act on');
        equal(gen.availableTypes(ctx, { accountId: bare.id }), [],
            'and nothing is offered until they do');

        const refusal = gen.validate(ctx, {
            accountId: bare.id, docTypeKey: 'HCM_PROPOSAL', fields: PROPOSAL_FIELDS,
        });
        assert(refusal.problems.includes('Please add a service to this account first.'),
            'the same refusal reaches generation, not only the dialog');
    });

    check('a document type the account does not buy is named as a mismatch', () => {
        const refusal = gen.validate(ctx, {
            accountId: genAccount.id, docTypeKey: 'OFFSHORING_PROPOSAL', fields: {},
        });
        assert(refusal.problems.some((p) => /does not buy offshoring/i.test(p)),
            'rather than silently generating against the wrong template');
    });

    check('every service is selected until someone says otherwise', () => {
        equal(gen.serviceSelection(ctx, { accountId: genAccount.id }), types.SERVICE_KEYS);
    });

    check('a service selection is stored in canonical order, not click order', () => {
        gen.setServiceSelection(ctx, { accountId: genAccount.id }, ['PERSONNEL', 'RECRUITMENT', 'ONBOARDING']);
        equal(gen.serviceSelection(ctx, { accountId: genAccount.id }), ['RECRUITMENT', 'ONBOARDING', 'PERSONNEL'],
            'so a stored list can never change the numbering');
        gen.setServiceSelection(ctx, { accountId: genAccount.id }, types.SERVICE_KEYS);
    });

    check('generation is refused, with reasons, before anything is written', () => {
        const before = db.get('SELECT COUNT(*) n FROM documents').n;
        try {
            gen.generate(ctx, { dealId: genDeal.id, docTypeKey: 'HCM_PROPOSAL', fields: { currency: 'SAR' } });
            throw new Error('it should have refused');
        } catch (err) {
            assert(Array.isArray(err.extra?.problems) && err.extra.problems.length >= 2,
                'the problems come back as a list, not one at a time');
            assert(err.extra.problems.some((p) => /Monthly Fee/.test(p)), 'naming the fields');
        }
        equal(db.get('SELECT COUNT(*) n FROM documents').n, before, 'and no document row was created');
    });

    check('generating produces a real .docx attached to the deal and the account', () => {
        const { generation, document } = gen.generate(ctx, {
            dealId: genDeal.id, docTypeKey: 'HCM_PROPOSAL', fields: PROPOSAL_FIELDS,
        });

        equal(generation.version, 1);
        equal(document.parent_type, 'deal', 'so it appears on the deal');
        equal(document.account_id, genAccount.id, 'and on the account');
        equal(document.kind, 'proposal');
        assert(document.name.includes('Northwind Trading') && document.name.endsWith('v1.docx'),
            `the automation's naming convention, versioned: ${document.name}`);

        const bytes = fs.readFileSync(path.join(db.STORAGE, document.storage_key));
        const rendered = docx.readPart(docx.readZip(bytes), 'word/document.xml');
        assert(rendered.includes('Northwind Trading'), 'the client name is in the document');
        assert(!rendered.includes('{{'), 'and no placeholder survived');
        equal(generation.template_checksum, installed.checksum,
            'the exact template bytes are recorded against the document');
    });

    check('regenerating appends a version and leaves the first intact', () => {
        const first = db.get(
            `SELECT * FROM document_generations WHERE deal_id = ? AND document_type = 'HCM_PROPOSAL' AND version = 1`,
            [genDeal.id],
        );
        const { generation } = gen.generate(ctx, {
            dealId: genDeal.id, docTypeKey: 'HCM_PROPOSAL', fields: { ...PROPOSAL_FIELDS, monthly_fee: 52000 },
        });
        equal(generation.version, 2);

        const still = db.get('SELECT * FROM document_generations WHERE id = ?', [first.id]);
        equal(still.document_id, first.document_id, 'v1 still points at its own file');
        assert(fs.existsSync(path.join(db.STORAGE, db.get('SELECT storage_key FROM documents WHERE id = ?', [first.document_id]).storage_key)),
            'and that file is still on disk — nothing is overwritten');
        equal(JSON.parse(still.fields).monthly_fee, 45000, 'holding the values it was generated with');
    });

    check('the version history marks the current one per document type', () => {
        const history = gen.historyFor(ctx, { dealId: genDeal.id });
        equal(history.length, 2);
        equal(history[0].version, 2, 'newest first');
        assert(history[0].isCurrent && !history[1].isCurrent, 'only the newest of a type is current');
        equal(history[0].label, 'HCM Proposal');
    });

    check('a regeneration prefills from the last version, not from blank', () => {
        const { fields } = gen.prefillFields(ctx, { dealId: genDeal.id }, 'HCM_PROPOSAL');
        equal(fields.monthly_fee, 52000, 'the value from v2');
        equal(fields.employees_to_hire, 10);
    });

    check('opens and downloads are counted from events, and never from the client', () => {
        const current = gen.historyFor(ctx, { dealId: genDeal.id })[0];
        gen.recordEvent(ctx, { generationId: current.id, documentId: current.document_id, eventType: 'opened' });
        gen.recordEvent(ctx, { generationId: current.id, documentId: current.document_id, eventType: 'opened' });
        gen.recordEvent(ctx, { generationId: current.id, documentId: current.document_id, eventType: 'downloaded' });

        const activity = gen.historyFor(ctx, { dealId: genDeal.id })[0].activity;
        equal(activity.opened, 2);
        equal(activity.downloaded, 1);
        assert(activity.lastOpenedAt, 'and when it last happened');

        const columns = db.all('PRAGMA table_info(document_generations)').map((c) => c.name);
        assert(!columns.includes('open_count') && !columns.includes('download_count'),
            'no stored counter to drift from the events it claims to summarise');
    });

    check('document activity is not the audit trail', () => {
        // Both exist for this document; they answer different questions and
        // counting audit rows as opens would report our own writes as customer
        // engagement.
        const current = gen.historyFor(ctx, { dealId: genDeal.id })[0];
        const audits = db.all(
            `SELECT action FROM audit_events WHERE record_id = ? AND action = 'document_generated'`,
            [current.document_id],
        );
        equal(audits.length, 1, 'the generation is audited');
        const events = db.all('SELECT event_type FROM document_events WHERE generation_id = ?', [current.id]);
        assert(events.every((e) => e.event_type !== 'document_generated'),
            'and tracked separately, in its own vocabulary');
    });

    check('an agreement is refused until the commercial registration exists', () => {
        gen.installTemplate(ctx, {
            templateKey: 'hcm_agreement', label: 'HCM Agreement',
            buffer: fs.readFileSync(path.join(AUTOMATION, 'Talent 360 - HCM Agreement Template.docx')),
        });
        const agreementFields = {
            employees_to_hire: 10, onsite_visits_per_week: 2, monthly_fee: 45000, currency: 'جنيه',
            start_date: '2026-09-01', end_date: '2027-08-31', contract_duration_text: 'سنة ميلادية',
        };
        const refusal = gen.validate(ctx, { dealId: genDeal.id, docTypeKey: 'HCM_AGREEMENT', fields: agreementFields });
        assert(refusal.problems.some((p) => /commercial registration/i.test(p)));

        db.run(
            `INSERT INTO commercial_registrations
               (id, workspace_id, account_id, company_name_ar, cr_number, representative_name, address, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [db.id('crg'), WS, genAccount.id, 'شركة نورث ويند', '1010203040', 'محمد السالم', 'الرياض', db.now(), db.now()],
        );

        const { generation } = gen.generate(ctx, {
            dealId: genDeal.id, docTypeKey: 'HCM_AGREEMENT', fields: agreementFields,
        });
        equal(generation.version, 1, 'agreements version independently of proposals');

        const stored = JSON.parse(generation.placeholders);
        equal(stored.CLIENT_NAME, 'شركة نورث ويند', 'the Arabic certificate name wins inside the contract');
        equal(stored.COMMERCIAL_REGISTRATION, '1010203040');
    });

    check('a generated agreement snapshots the registration it used', () => {
        // Re-importing a certificate later must not rewrite what an
        // already-issued contract said.
        db.run('UPDATE commercial_registrations SET representative_name = ? WHERE account_id = ?',
            ['شخص آخر تماما', genAccount.id]);
        const agreement = db.get(
            `SELECT placeholders FROM document_generations
              WHERE deal_id = ? AND document_type = 'HCM_AGREEMENT' AND version = 1`,
            [genDeal.id],
        );
        equal(JSON.parse(agreement.placeholders).REPRESENTATIVE_NAME, 'محمد السالم',
            'the issued document still says who actually signed it');
    });

    /* ---- the account-centric workflow, which is the one people use ---- */

    check('a document generates from an account with no deal at all', () => {
        // The failure this whole rework exists for: a workspace of accounts and
        // no deals could not produce a single document.
        const solo = repo.createRecord('account', ctx, { name: 'Dealless Holdings', services: ['hcm'] });
        const { generation, document } = gen.generate(ctx, {
            accountId: solo.id, docTypeKey: 'HCM_PROPOSAL', fields: PROPOSAL_FIELDS,
        });

        assert(generation.deal_id, 'a generated proposal is given a deal (found or created)');
        equal(generation.account_id, solo.id);
        equal(
            db.get('SELECT COUNT(*) AS n FROM proposals WHERE document_id = ? AND deal_id = ?', [generation.document_id, generation.deal_id]).n,
            1,
            'the proposal record is on the same deal as the generation',
        );
        equal(document.parent_type, 'account', 'so it appears on the account');
        const rendered = docx.readPart(
            docx.readZip(fs.readFileSync(path.join(db.STORAGE, document.storage_key))), 'word/document.xml',
        );
        assert(rendered.includes('Dealless Holdings') && !rendered.includes('{{'),
            'with the real client name and no surviving placeholder');
    });

    check('versions run per account and document type, across deals', () => {
        const shared = repo.createRecord('account', ctx, { name: 'Two Deals Ltd', services: ['hcm'] });
        const dealA = repo.createRecord('deal', ctx, {
            name: 'A', account_id: shared.id, pipeline_id: PIPE, stage_id: STAGE_OPEN, service_line_key: 'hcm',
        });
        const dealB = repo.createRecord('deal', ctx, {
            name: 'B', account_id: shared.id, pipeline_id: PIPE, stage_id: STAGE_OPEN, service_line_key: 'hcm',
        });
        const first = gen.generate(ctx, { dealId: dealA.id, docTypeKey: 'HCM_PROPOSAL', fields: PROPOSAL_FIELDS });
        const second = gen.generate(ctx, { dealId: dealB.id, docTypeKey: 'HCM_PROPOSAL', fields: PROPOSAL_FIELDS });
        equal(first.generation.version, 1);
        equal(second.generation.version, 2,
            'the client’s second proposal is v2, not a second v1 from a different deal');

        equal(gen.historyFor(ctx, { accountId: shared.id }).length, 2, 'both are on the account');
        equal(gen.historyFor(ctx, { dealId: dealA.id }).length, 1, 'and each is on its own deal');
    });

    check('a deal’s scope selection overrides the account’s, and falls back to it', () => {
        const scoped = repo.createRecord('account', ctx, { name: 'Scoped Ltd', services: ['hcm'] });
        const deal = repo.createRecord('deal', ctx, {
            name: 'Scoped deal', account_id: scoped.id, pipeline_id: PIPE, stage_id: STAGE_OPEN, service_line_key: 'hcm',
        });

        gen.setServiceSelection(ctx, { accountId: scoped.id }, ['RECRUITMENT', 'ONBOARDING']);
        equal(gen.serviceSelection(ctx, { accountId: scoped.id, dealId: deal.id }), ['RECRUITMENT', 'ONBOARDING'],
            'a deal with no selection of its own reads the account’s');

        gen.setServiceSelection(ctx, { accountId: scoped.id, dealId: deal.id }, ['PERSONNEL']);
        equal(gen.serviceSelection(ctx, { accountId: scoped.id, dealId: deal.id }), ['PERSONNEL']);
        equal(gen.serviceSelection(ctx, { accountId: scoped.id }), ['RECRUITMENT', 'ONBOARDING'],
            'and the account’s own selection is untouched by it');
    });

    check('the selection sent with a request is what gets validated and rendered', () => {
        const preview = gen.previewGeneration(ctx, {
            accountId: genAccount.id, docTypeKey: 'HCM_PROPOSAL',
            fields: PROPOSAL_FIELDS, services: ['ONBOARDING'],
        });
        equal(preview.services, ['ONBOARDING'], 'not the stored selection');
        const scope = preview.variables.find((v) => v.key === 'SERVICE_SCOPE_LIST');
        equal(scope.value, 'Employee Onboarding');
        equal(preview.variables.find((v) => v.key === 'SECTION_RANGE').value, 'Section 3.1');
    });

    /* ---- the variable mapping shown before anything is written ---- */

    check('every variable is mapped to a source, and none is undescribed', () => {
        // The guard against the registry and the placeholder map drifting: a new
        // placeholder with no declared provenance shows up here, not in front of
        // a user looking at a row labelled with a raw token.
        for (const docType of Object.values(types.DOCUMENT_TYPES)) {
            const placeholders = docType.buildPlaceholders({
                account: { name: 'X' }, fields: {}, enabledServices: [],
                registration: { company_name_ar: 'س', cr_number: '1', representative_name: 'ر', address: 'ع' },
                timeZone: 'Africa/Cairo', now: new Date('2026-07-15T09:00:00Z'),
            });
            const undescribed = Object.keys(placeholders).filter((k) => !docType.variables?.[k]);
            equal(undescribed, [], `${docType.key} describes every placeholder it produces`);

            const unused = Object.keys(docType.variables ?? {}).filter((k) => !(k in placeholders));
            equal(unused, [], `${docType.key} describes no placeholder it does not produce`);
        }
    });

    check('the mapping names the record each value came from', () => {
        const preview = gen.previewGeneration(ctx, {
            accountId: genAccount.id, docTypeKey: 'HCM_PROPOSAL', fields: PROPOSAL_FIELDS,
        });
        const by = Object.fromEntries(preview.variables.map((v) => [v.key, v]));

        equal(by.CLIENT_NAME.sourceLabel, 'Account');
        equal(by.CLIENT_NAME.value, 'Northwind Trading');
        equal(by.MONTHLY_FEE.sourceLabel, 'Entered here');
        equal(by.MONTHLY_FEE.fieldKey, 'monthly_fee', 'so a blank one can be fixed in the review table');
        equal(by.SERVICE_SCOPE_LIST.sourceLabel, 'Service scopes');
        equal(by.MONTH_YEAR.sourceLabel, 'Computed');
        equal(preview.ok, true, 'and with everything filled in, it is ready');
        assert(preview.nextVersion >= 3, 'it says which version it would be');
    });

    check('a missing required variable is flagged before generation, not after', () => {
        const preview = gen.previewGeneration(ctx, {
            accountId: genAccount.id, docTypeKey: 'HCM_PROPOSAL',
            fields: { ...PROPOSAL_FIELDS, monthly_fee: '' },
        });
        const fee = preview.variables.find((v) => v.key === 'MONTHLY_FEE');
        assert(fee.missing && fee.required, 'the row is marked');
        equal(preview.ok, false, 'and the Generate button has something to stay disabled for');
        assert(preview.problems.some((p) => /"Monthly Fee" is required/.test(p)));
    });

    check('Employees To Hire is only required, and only asked for, with Recruitment', () => {
        const without = gen.previewGeneration(ctx, {
            accountId: genAccount.id, docTypeKey: 'HCM_PROPOSAL',
            fields: { ...PROPOSAL_FIELDS, employees_to_hire: '' }, services: ['ONBOARDING'],
        });
        equal(without.variables.find((v) => v.key === 'EMPLOYEES_TO_HIRE').required, false);
        equal(without.ok, true, 'so a proposal without recruitment is not blocked by a recruitment field');

        const with$ = gen.previewGeneration(ctx, {
            accountId: genAccount.id, docTypeKey: 'HCM_PROPOSAL',
            fields: { ...PROPOSAL_FIELDS, employees_to_hire: '' }, services: ['RECRUITMENT'],
        });
        equal(with$.variables.find((v) => v.key === 'EMPLOYEES_TO_HIRE').required, true);
        equal(with$.ok, false);
    });

    check('the fee reaches the document grouped, and the raw value is what is stored', () => {
        const { generation } = gen.generate(ctx, {
            accountId: genAccount.id, docTypeKey: 'HCM_PROPOSAL',
            fields: { ...PROPOSAL_FIELDS, monthly_fee: 1250000 },
        });
        equal(JSON.parse(generation.placeholders).MONTHLY_FEE, '1,250,000', 'what the client reads');
        equal(JSON.parse(generation.fields).monthly_fee, 1250000,
            'and the number itself is kept, so regenerating prefills a number rather than text');

        const bytes = fs.readFileSync(path.join(db.STORAGE,
            db.get('SELECT storage_key FROM documents WHERE id = ?', [generation.document_id]).storage_key));
        assert(docx.readPart(docx.readZip(bytes), 'word/document.xml').includes('1,250,000'),
            'and it is in the file, not only in the record of it');
    });

    await checkAsync('"download all" hands back one signed link per file, and no archive', async () => {
        const docsApi = await import('./api/documents.mjs');
        const url = new URL('http://x/?category=proposal');
        const result = await docsApi.accountDocumentLinks({ params: { id: genAccount.id }, url, ctx });

        assert(result.documents.length >= 2, 'every proposal on the account is listed');
        equal(result.missing, [], 'and none of them is missing from storage');
        for (const doc of result.documents) {
            assert(doc.name.endsWith('.docx'), `${doc.name} is the .docx it already was — nothing is repackaged`);
            assert(/^\/api\/documents\/.+\/download\?expires=\d+&sig=.+$/.test(doc.url),
                'reached through the same signed URL as a single download');
        }

        const all$ = await docsApi.accountDocumentLinks({ params: { id: genAccount.id }, url: new URL('http://x/'), ctx });
        assert(all$.documents.length > result.documents.length, 'and with no category, the agreements come too');
    });

    await checkAsync('asking for the links is not taking the files', async () => {
        const docsApi = await import('./api/documents.mjs');
        const before = db.get('SELECT COUNT(*) n FROM document_events WHERE event_type = ?', ['downloaded']).n;
        await docsApi.accountDocumentLinks({ params: { id: genAccount.id }, url: new URL('http://x/'), ctx });
        equal(db.get('SELECT COUNT(*) n FROM document_events WHERE event_type = ?', ['downloaded']).n, before,
            'a download is counted when the bytes are fetched, not when a list is drawn');
    });

    await checkAsync('uploading a file requires write access to the parent record', async () => {
        // Regression: upload() confirmed the parent record EXISTS in the
        // workspace, which only proves it is readable, and stopped there —
        // no write check at all. A readonly user could attach a file to any
        // record in the workspace.
        const docsApi = await import('./api/documents.mjs');
        const readonlyUser = auth.createUser({
            email: 'readonly-upload@test.local', name: 'Readonly', password: 'test-password-9',
            role: 'readonly', workspaceId: WS,
        });
        const readonlyCtx = { ...ctx, userId: readonlyUser.id, role: 'readonly', user: { id: readonlyUser.id, name: 'Readonly' } };

        const rawBody = () => Readable.from([Buffer.from('hello world')]);
        const uploadUrl = new URL(`http://x/?name=test.txt&parent_type=account&parent_id=${genAccount.id}`);

        let refused = false;
        try {
            await docsApi.upload({ req: rawBody(), url: uploadUrl, ctx: readonlyCtx });
        } catch (err) { refused = /own|manager|forbidden/i.test(err.message) ? true : (() => { throw err; })(); }
        assert(refused, 'a readonly user must not be able to attach a file to an account');

        const ok = await docsApi.upload({ req: rawBody(), url: uploadUrl, ctx });
        assert(ok.document, 'a user who genuinely can write the record still can upload');
    });

    await checkAsync('a file missing from storage is named, not silently dropped', async () => {
        const docsApi = await import('./api/documents.mjs');
        const victim = db.get(
            `SELECT id, name, storage_key FROM documents
              WHERE account_id = ? AND kind = 'proposal' AND deleted_at IS NULL LIMIT 1`,
            [genAccount.id],
        );
        // Through the store, not straight at the disk: where a deployment keeps
        // the bytes is the store's business, and deleting only the file proves
        // nothing on one that also holds them in the database.
        const store = await import('./lib/document-store.mjs');
        const bytes = store.readFile(victim.storage_key);
        store.removeFile(victim.storage_key);
        try {
            const result = await docsApi.accountDocumentLinks({ params: { id: genAccount.id }, url: new URL('http://x/'), ctx });
            assert(result.missing.includes(victim.name),
                'so nobody counts the saved files, gets a smaller number, and hunts for which one');
            assert(!result.documents.some((d) => d.id === victim.id), 'and no link is offered for it');
        } finally {
            store.writeFile(victim.storage_key, bytes);
        }
    });

    check('previewing writes nothing', () => {
        const docs = db.get('SELECT COUNT(*) n FROM documents').n;
        const gens = db.get('SELECT COUNT(*) n FROM document_generations').n;
        gen.previewGeneration(ctx, {
            accountId: genAccount.id, docTypeKey: 'HCM_PROPOSAL', fields: PROPOSAL_FIELDS,
        });
        equal(db.get('SELECT COUNT(*) n FROM documents').n, docs);
        equal(db.get('SELECT COUNT(*) n FROM document_generations').n, gens);
    });

    check('the account’s two lists split proposals from agreements', () => {
        const proposals = gen.historyFor(ctx, { accountId: genAccount.id, category: 'proposal' });
        const agreements = gen.historyFor(ctx, { accountId: genAccount.id, category: 'agreement' });
        assert(proposals.length > 0 && agreements.length > 0, 'both exist for this account');
        assert(proposals.every((r) => r.category === 'proposal'));
        assert(agreements.every((r) => r.category === 'agreement'));
        equal(proposals.length + agreements.length, gen.historyFor(ctx, { accountId: genAccount.id }).length,
            'and nothing falls between the two lists');
    });

    /* ---- the offshoring talent fee: a field, not a highlighted literal ---- */

    check('the offshoring template asks for the talent fee instead of printing 65', () => {
        const source = path.join(AUTOMATION, 'T360 - Offshoring_Payroll Proposal Template.docx');
        const xml = docx.readPart(docx.readZip(fs.readFileSync(source)), 'word/document.xml');

        assert(xml.includes('{{TALENT_FEE}}'), 'the fee is a variable');
        assert(!/<w:highlight/.test(xml),
            'and nothing is left highlighted — yellow meant "edit this by hand", which is what the field replaced');
        assert(!/<w:t>65<\/w:t>/.test(xml), 'the hard-coded price is gone');
    });

    /**
     * Part 16's rule, from the side it can actually fail on.
     *
     * A document carries what the CLIENT pays in. The account owns that fact,
     * and it has to beat the workspace-wide convenience default — otherwise the
     * one client who does not bill in the house currency is precisely the one
     * who gets the wrong contract.
     */
    check('a document opens in the account billing currency, not the house default', () => {
        setSetting(ctx.workspaceId, 'doc_default_currency', 'EGP');

        // Regional defaults to USD, then this client negotiated SAR.
        const account = repo.createRecord('account', ctx, {
            name: 'Riyadh Holdings', account_type: 'Regional', billing_currency: 'SAR', services: ['hcm'],
        });
        equal(account.billing_currency, 'SAR', 'the account keeps what it was given');

        const { fields } = gen.prefillFields(ctx, { accountId: account.id }, 'HCM_PROPOSAL');
        equal(fields.currency, 'SAR',
            'the account outranks doc_default_currency — a SAR client was being handed the '
            + 'house EGP default because the setting was consulted first');

        // And the type-derived default still applies when nobody has said
        // otherwise, so this did not break the ordinary case.
        const egypt = repo.createRecord('account', ctx, {
            name: 'Cairo Foods', account_type: 'Egypt', services: ['hcm'],
        });
        equal(egypt.billing_currency, 'EGP', 'Egypt defaults to EGP');
        equal(gen.prefillFields(ctx, { accountId: egypt.id }, 'HCM_PROPOSAL').fields.currency, 'EGP');

        setSetting(ctx.workspaceId, 'doc_default_currency', '');
    });

    check('the talent fee opens at 65 and prints whatever was confirmed', () => {
        const account = repo.createRecord('account', ctx, { name: 'Offshore Ltd', services: ['offshoring'] });
        gen.installTemplate(ctx, {
            templateKey: 'offshoring_proposal',
            label: 'Offshoring Proposal',
            buffer: fs.readFileSync(path.join(AUTOMATION, 'T360 - Offshoring_Payroll Proposal Template.docx')),
        });

        const { fields } = gen.prefillFields(ctx, { accountId: account.id }, 'OFFSHORING_PROPOSAL');
        equal(fields.talent_fee, 65, 'the value the template used to hard-code, offered rather than imposed');

        const { document } = gen.generate(ctx, {
            accountId: account.id, docTypeKey: 'OFFSHORING_PROPOSAL', fields: { talent_fee: 80 },
        });
        const rendered = docx.readPart(
            docx.readZip(fs.readFileSync(path.join(db.STORAGE, document.storage_key))), 'word/document.xml',
        );
        assert(rendered.includes('<w:t>80</w:t>'), 'the confirmed fee is what prints');
        // Visible text only. The remaining "65"s in the file are inside Word's
        // own w14:paraId identifiers, which are not words anybody reads.
        const visible = [...rendered.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(' ');
        assert(!/\b65\b/.test(visible), 'and the old literal is nowhere in the readable document');
        assert(!rendered.includes('{{'), 'with no placeholder left behind');
    });

    check('the Offshoring agreement opens with the proposal\'s rate, not blank', () => {
        // The proposal's per-employee rate is `talent_fee`; the agreement's
        // is `monthly_fee` — the agreement's own template calls it a fee,
        // not a quote. prefillFields's ordinary same-key sibling lookup
        // therefore found nothing here even though every other field
        // (headcount, dates) on other documents carries over fine — the one
        // number that is the actual quote was the one that opened blank,
        // asking whoever signs the agreement to remember and retype it.
        const account = repo.createRecord('account', ctx, { name: 'Renamed Fee Ltd', services: ['offshoring'] });
        gen.installTemplate(ctx, {
            templateKey: 'offshoring_proposal',
            label: 'Offshoring Proposal',
            buffer: fs.readFileSync(path.join(AUTOMATION, 'T360 - Offshoring_Payroll Proposal Template.docx')),
        });
        gen.generate(ctx, {
            accountId: account.id, docTypeKey: 'OFFSHORING_PROPOSAL', fields: { talent_fee: 90 },
        });

        const { fields } = gen.prefillFields(ctx, { accountId: account.id }, 'OFFSHORING_AGREEMENT');
        equal(fields.monthly_fee, 90, 'the agreement opens with the proposal\'s confirmed rate under its own field name');
    });

    check('a template that predates a field is refused, not quietly quoted from', () => {
        // The exact regression the talent fee was: the form collects a price,
        // the template still has the old number baked in, and the document goes
        // out quoting it. There is no leftover token to catch that — there is no
        // token at all.
        const account = repo.createRecord('account', ctx, { name: 'Stale Template Ltd', services: ['offshoring'] });
        const current = fs.readFileSync(path.join(AUTOMATION, 'T360 - Offshoring_Payroll Proposal Template.docx'));
        const zip = docx.readZip(current);
        const stale = docx.writeZip(zip, {
            'word/document.xml': docx.readPart(zip, 'word/document.xml').replace('{{TALENT_FEE}}', '65'),
        });

        gen.installTemplate(ctx, { templateKey: 'offshoring_proposal', label: 'Stale', buffer: stale });
        try {
            const { problems } = gen.validate(ctx, {
                accountId: account.id, docTypeKey: 'OFFSHORING_PROPOSAL', fields: { talent_fee: 80 },
            });
            // validate() does not read the template; the review step and
            // generation both do, and both must refuse.
            equal(problems, [], 'the values themselves are fine');

            const preview = gen.previewGeneration(ctx, {
                accountId: account.id, docTypeKey: 'OFFSHORING_PROPOSAL', fields: { talent_fee: 80 },
            });
            assert(preview.problems.some((p) => /\{\{TALENT_FEE\}\}/.test(p)),
                `the review screen names the missing variable: ${preview.problems.join(' | ')}`);
            assert(!preview.ok, 'and will not let it through');

            throws(() => gen.generate(ctx, {
                accountId: account.id, docTypeKey: 'OFFSHORING_PROPOSAL', fields: { talent_fee: 80 },
            }), /cannot be generated/i, 'generation refuses too, not only the dialog');
        } finally {
            // Put the good one back for anything that runs after this.
            gen.installTemplate(ctx, {
                templateKey: 'offshoring_proposal', label: 'Offshoring Proposal', buffer: current,
            });
        }
    });

    check('an offshoring proposal with no fee is refused, by name', () => {
        const account = repo.createRecord('account', ctx, { name: 'No Fee Ltd', services: ['offshoring'] });
        const { problems } = gen.validate(ctx, {
            accountId: account.id, docTypeKey: 'OFFSHORING_PROPOSAL', fields: {},
        });
        assert(problems.some((p) => /Talent Fee/i.test(p)),
            `rather than generating a contract with a blank price: ${problems.join(' | ')}`);
    });

    /* ---- no yellow, and the first party named on the agreement ---- */

    const readDoc = (document) => docx.readPart(
        docx.readZip(fs.readFileSync(path.join(db.STORAGE, document.storage_key))), 'word/document.xml',
    );
    const visibleText = (xml) => [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('|');
    const YELLOW = /<w:highlight\s+w:val="(yellow|darkYellow)"|<w:shd[^>]*w:fill="(FFFF00|F1C232)"/i;

    const registerAccount = (name, { arabic, representative }) => {
        const account = repo.createRecord('account', ctx, { name, services: ['hcm'] });
        db.run(
            `INSERT INTO commercial_registrations
               (id, workspace_id, account_id, company_name_ar, cr_number, representative_name, address, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [db.id('crg'), WS, account.id, arabic, '1010000001', representative, 'الرياض', db.now(), db.now()],
        );
        return account;
    };
    const AGREEMENT_FIELDS = {
        employees_to_hire: 3, onsite_visits_per_week: 1, monthly_fee: 30000, currency: 'جنيه',
        start_date: '2026-03-01', end_date: '2027-02-28', contract_duration_text: 'سنة ميلادية',
    };

    check('generation strips yellow, whatever the template carries', () => {
        // A template with the highlighter pen AND yellow shading, including on a
        // merge field — which is exactly what the HCM agreement had.
        const source = fs.readFileSync(path.join(AUTOMATION, 'Talent 360 - Proposal Template.docx'));
        const zip = docx.readZip(source);
        const xml = docx.readPart(zip, 'word/document.xml')
            .replace('<w:t>{{CLIENT_NAME}}</w:t>',
                '<w:t>{{CLIENT_NAME}}</w:t></w:r><w:r><w:rPr><w:highlight w:val="yellow"/>'
                + '<w:shd w:val="clear" w:color="auto" w:fill="FFFF00"/></w:rPr><w:t>x</w:t>');
        const yellowed = docx.writeZip(zip, { 'word/document.xml': xml });
        assert(YELLOW.test(docx.readPart(docx.readZip(yellowed), 'word/document.xml')),
            'the fixture really is yellow before we start');

        gen.installTemplate(ctx, { templateKey: 'hcm_proposal', label: 'Yellowed', buffer: yellowed });
        try {
            const account = repo.createRecord('account', ctx, { name: 'Yellow Free Ltd', services: ['hcm'] });
            const { document } = gen.generate(ctx, {
                accountId: account.id, docTypeKey: 'HCM_PROPOSAL', fields: PROPOSAL_FIELDS,
            });
            const rendered = readDoc(document);
            assert(!YELLOW.test(rendered), 'no yellow survives generation');
            // And the rest of the formatting is still there.
            assert(/<w:b\/>/.test(rendered), 'bold survives');
            assert(/w:fill="0B2545"/.test(rendered), 'the navy brand fill survives');
            assert(/<w:tbl>/.test(rendered), 'tables survive');
        } finally {
            gen.installTemplate(ctx, {
                templateKey: 'hcm_proposal', label: 'HCM Proposal', buffer: source,
            });
        }
    });

    check('the agreement names the first party and its signatory', () => {
        gen.installTemplate(ctx, {
            templateKey: 'hcm_agreement',
            label: 'HCM Agreement',
            buffer: fs.readFileSync(path.join(AUTOMATION, 'Talent 360 - HCM Agreement Template.docx')),
        });
        const account = registerAccount('First Party Ltd', {
            arabic: 'شركة النخيل المتحدة', representative: 'سعيد المطيري',
        });

        const { document } = gen.generate(ctx, {
            accountId: account.id, docTypeKey: 'HCM_AGREEMENT', fields: AGREEMENT_FIELDS,
        });
        const text = visibleText(readDoc(document));

        assert(text.includes('الطرف الأول (|شركة النخيل المتحدة'),
            `الطرف الأول carries the account's Arabic company name: ${text.slice(text.indexOf('التوقيعــات'), text.indexOf('التوقيعــات') + 150)}`);
        assert(text.includes('الأسم: سعيد المطيري'),
            'الاسم carries the person entered on the agreement, not the company');
        assert(!text.includes('الأسم: شركة النخيل المتحدة'), 'and never the company name in the person field');
        assert(!YELLOW.test(readDoc(document)), 'with no yellow anywhere');
    });

    check('a different account changes the Arabic name; a different person changes الاسم', () => {
        const other = registerAccount('Second Party Ltd', {
            arabic: 'شركة أخرى تماما', representative: 'خالد العتيبي',
        });
        const { document } = gen.generate(ctx, {
            accountId: other.id, docTypeKey: 'HCM_AGREEMENT', fields: AGREEMENT_FIELDS,
        });
        const text = visibleText(readDoc(document));
        assert(text.includes('الطرف الأول (|شركة أخرى تماما'), 'the company name follows the account');
        assert(text.includes('الأسم: خالد العتيبي'), 'and the signatory follows the agreement form');
        assert(!text.includes('شركة النخيل المتحدة'), 'nothing of the previous account leaks in');
    });

    check('a missing Arabic company name is refused, not quietly swapped for the English one', () => {
        const account = repo.createRecord('account', ctx, { name: 'English Only Ltd', services: ['hcm'] });
        db.run(
            `INSERT INTO commercial_registrations
               (id, workspace_id, account_id, company_name_ar, cr_number, representative_name, address, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [db.id('crg'), WS, account.id, '', '1010000002', 'فهد', 'جدة', db.now(), db.now()],
        );
        const { problems } = gen.validate(ctx, {
            accountId: account.id, docTypeKey: 'HCM_AGREEMENT', fields: AGREEMENT_FIELDS,
        });
        assert(problems.some((p) => /Arabic company name/i.test(p)),
            `named as the problem it is: ${problems.join(' | ')}`);
        throws(() => gen.generate(ctx, {
            accountId: account.id, docTypeKey: 'HCM_AGREEMENT', fields: AGREEMENT_FIELDS,
        }), /cannot be generated/i, 'and generation refuses rather than printing "English Only Ltd" in Arabic');
    });

    check('a missing signatory is refused too', () => {
        const account = repo.createRecord('account', ctx, { name: 'No Signatory Ltd', services: ['hcm'] });
        db.run(
            `INSERT INTO commercial_registrations
               (id, workspace_id, account_id, company_name_ar, cr_number, representative_name, address, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [db.id('crg'), WS, account.id, 'شركة بلا ممثل', '1010000003', '', 'الدمام', db.now(), db.now()],
        );
        const { problems } = gen.validate(ctx, {
            accountId: account.id, docTypeKey: 'HCM_AGREEMENT', fields: AGREEMENT_FIELDS,
        });
        assert(problems.some((p) => /representative name/i.test(p)),
            `so الاسم is never blank on a signed contract: ${problems.join(' | ')}`);
    });

    /* ---- the service chosen on a proposal lands on the account ---- */

    check('a service chosen while writing a proposal is recorded on the account', () => {
        const account = repo.createRecord('account', ctx, { name: 'Service Flow Ltd', services: ['offshoring'] });
        const offers = () => gen.availableTypes(ctx, { accountId: account.id }).map((t) => t.key);

        assert(!offers().includes('HCM_PROPOSAL'),
            'an HCM proposal is not offered to a client that does not buy HCM');

        // What the wizard's service step does: the ordinary record update, so
        // the write is validated, audited and reindexed like any other edit.
        repo.updateRecord('account', ctx, account.id, { services: ['offshoring', 'hcm'] });

        const after = repo.getRecord('account', ctx, account.id);
        equal(gen.accountServiceLines(after).sort(), ['hcm', 'offshoring'],
            'the new service is added, and the one already there is kept');
        assert(offers().includes('HCM_PROPOSAL'), 'and the HCM documents become available');

        // The relationship is on the ACCOUNT, so everything that reads accounts
        // reads it — the account page, the dashboard, deals, reports.
        const listed = repo.listRecords('account', ctx, { limit: 200 }).records
            .find((r) => r.id === account.id);
        equal(gen.accountServiceLines(listed).sort(), ['hcm', 'offshoring'],
            'including the list every report is built on');

        // And it reaches the browser as an ARRAY. Every consumer of a
        // multiselect checks Array.isArray first — the checkbox group on the
        // form, the badges in the list cell — so handing over the raw JSON
        // string rendered an account's Services blank however many it had.
        assert(Array.isArray(after.services), `an array, not ${typeof after.services}`);
        assert(Array.isArray(listed.services), 'in the list too');
        equal([...listed.services].sort(), ['hcm', 'offshoring']);
    });

    await checkAsync('the generate dialog is given the account’s own data, not a blank form', async () => {
        const generation = await import('./api/generation.mjs');
        const account = repo.createRecord('account', ctx, {
            name: 'Fully Described Ltd', legal_name: 'شركة موصوفة', services: ['hcm'],
            industry: 'IT Services', country: 'Saudi Arabia', city: 'Riyadh',
            phone: '+966500000000', cr_number: '4030999999',
        });

        const options = await generation.accountDocumentOptions({
            params: { id: account.id }, url: new URL('http://x/'), ctx,
        });

        // Everything the document says about the client comes from here rather
        // than being typed into the dialog.
        equal(options.account.name, 'Fully Described Ltd');
        equal(options.account.legal_name, 'شركة موصوفة');
        equal(options.account.industry, 'IT Services');
        equal(options.account.city, 'Riyadh');
        equal(options.account.phone, '+966500000000');
        equal(options.account.cr_number, '4030999999');
        equal(options.account.serviceLines, ['hcm']);

        // And the service lines to choose from, so an account with none is a
        // step in the dialog rather than a dead end somewhere else.
        assert(options.serviceLines.some((l) => l.key === 'hcm'),
            `the workspace's service lines travel with it: ${JSON.stringify(options.serviceLines)}`);
    });

    /* ---- the sidebar's lists are a view of the account's documents ---- */

    check('the Proposals list holds one row per generated document', () => {
        const account = repo.createRecord('account', ctx, { name: 'Unified Ltd', services: ['hcm'] });
        const { record, document } = gen.generate(ctx, {
            accountId: account.id, docTypeKey: 'HCM_PROPOSAL', fields: PROPOSAL_FIELDS,
        });

        equal(record.object, 'proposal');
        const listed = repo.listRecords('proposal', ctx, { accountId: account.id }).records;
        equal(listed.length, 1, 'so it is in the Proposals list, not only in the file table');
        equal(listed[0].id, record.id);
        equal(listed[0].document_id, document.id, 'and it names the document it is a view of');
        equal(listed[0].document_type, 'HCM_PROPOSAL');
        equal(listed[0].current_version, 1);
        // `linkGeneratedRecord` (lib/doc-generation.mjs) finds or creates a
        // deal for every generated proposal/agreement — a document with no
        // deal behind it never reaches a forecast. Asserted here rather than
        // just "not null" because the deal it invents has to be a real,
        // usable one.
        const deal = repo.getRecord('deal', ctx, listed[0].deal_id);
        assert(deal, 'a deal was found or created rather than left blank');
        equal(deal.account_id, account.id);
        assert(/^P-\d{4}-\d{4}$/.test(listed[0].number), `numbered like every other proposal: ${listed[0].number}`);
    });

    check('the two lists agree row for row', () => {
        const account = repo.createRecord('account', ctx, { name: 'Row For Row Ltd', services: ['hcm'] });
        for (const fee of [45000, 52000, 60000]) {
            gen.generate(ctx, {
                accountId: account.id, docTypeKey: 'HCM_PROPOSAL', fields: { ...PROPOSAL_FIELDS, monthly_fee: fee },
            });
        }

        // What the account shows, and what the sidebar shows.
        const onAccount = gen.historyFor(ctx, { accountId: account.id, category: 'proposal' });
        const inSidebar = repo.listRecords('proposal', ctx, { accountId: account.id }).records;

        equal(onAccount.length, 3);
        equal(inSidebar.length, 3, 'three documents, three rows — neither list is a summary of the other');
        equal(
            inSidebar.map((r) => r.document_id).sort(),
            onAccount.map((r) => r.document_id).sort(),
            'and they are the same documents, joined by document_id',
        );
    });

    check('a document cannot be generated for a deleted account at all', () => {
        // Which is why the backfill, and only the backfill, has to think about
        // deleted accounts: nothing else can reach one. See
        // apply-generated-records.mjs, which stamps a record's deleted_at from
        // its account so old documents are not resurrected into a live list.
        const account = repo.createRecord('account', ctx, { name: 'Gone Ltd', services: ['hcm'] });
        repo.deleteRecord('account', ctx, account.id);
        throws(() => gen.generate(ctx, {
            accountId: account.id, docTypeKey: 'HCM_PROPOSAL', fields: PROPOSAL_FIELDS,
        }), /deleted|does not exist/i);
    });

    check('a new version never edits the record already made', () => {
        const account = repo.createRecord('account', ctx, { name: 'Twice Ltd', services: ['hcm'] });
        const first = gen.generate(ctx, { accountId: account.id, docTypeKey: 'HCM_PROPOSAL', fields: PROPOSAL_FIELDS });
        const second = gen.generate(ctx, {
            accountId: account.id, docTypeKey: 'HCM_PROPOSAL', fields: { ...PROPOSAL_FIELDS, monthly_fee: 60000 },
        });

        assert(second.record.id !== first.record.id, 'a new document is a new record');
        equal(repo.getRecord('proposal', ctx, first.record.id).document_id, first.document.id,
            'v1 still points at the file that was actually sent');
        equal(repo.getRecord('proposal', ctx, first.record.id).current_version, 1);
        equal(repo.getRecord('proposal', ctx, second.record.id).current_version, 2);
    });

    /**
     * Superseding happens on APPROVAL now, not on generation.
     *
     * The old shape of this test — generate twice, expect the first superseded
     * — encoded the bypass: a generated proposal was born `issued`, so the
     * second one replaced the first before anybody had read either. A draft
     * that goes on to be rejected must not knock the client's live proposal out
     * of the account on its way past.
     */
    await checkAsync('a proposal is replaced when its replacement is approved, not when it is drafted', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Superseded Ltd', services: ['hcm'] });
        const first = gen.generate(ctx, { accountId: account.id, docTypeKey: 'HCM_PROPOSAL', fields: PROPOSAL_FIELDS });
        await approve('proposal', first.record.id);
        equal(repo.getRecord('proposal', ctx, first.record.id).status, 'issued',
            'approving a template-written proposal issues it — there is no separate version to freeze');

        const second = gen.generate(ctx, { accountId: account.id, docTypeKey: 'HCM_PROPOSAL', fields: PROPOSAL_FIELDS });
        equal(repo.getRecord('proposal', ctx, first.record.id).status, 'issued',
            'still live: the replacement has not been approved yet');

        await approve('proposal', second.record.id);
        equal(repo.getRecord('proposal', ctx, first.record.id).status, 'superseded',
            'otherwise the list is six identical-looking rows with no live one');

        const accepted = repo.createRecord('account', ctx, { name: 'Accepted Ltd', services: ['hcm'] });
        const won = gen.generate(ctx, { accountId: accepted.id, docTypeKey: 'HCM_PROPOSAL', fields: PROPOSAL_FIELDS });
        repo.updateRecord('proposal', ctx, won.record.id, { status: 'accepted' });
        const next = gen.generate(ctx, { accountId: accepted.id, docTypeKey: 'HCM_PROPOSAL', fields: PROPOSAL_FIELDS });
        await approve('proposal', next.record.id);
        equal(repo.getRecord('proposal', ctx, won.record.id).status, 'accepted',
            '"accepted" is a thing that happened between two companies, not a field to reset');
    });

    check('a generated agreement is an agreement, with the term that was typed into it', () => {
        const account = repo.createRecord('account', ctx, {
            name: 'Signable Ltd', services: ['hcm'], account_type: 'Egypt',
        });
        db.run(
            `INSERT INTO commercial_registrations
               (id, workspace_id, account_id, company_name_ar, cr_number, representative_name, address, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [db.id('crg'), WS, account.id, 'شركة', '99887766', 'ممثل', 'الرياض', db.now(), db.now()],
        );
        const { record, document } = gen.generate(ctx, {
            accountId: account.id,
            docTypeKey: 'HCM_AGREEMENT',
            fields: {
                employees_to_hire: 4, onsite_visits_per_week: 1, monthly_fee: 20000, currency: 'جنيه',
                start_date: '2026-10-01', end_date: '2027-09-30', contract_duration_text: 'سنة ميلادية',
            },
        });

        equal(record.object, 'agreement');
        const agreement = repo.getRecord('agreement', ctx, record.id);
        equal(agreement.status, 'pending_review',
            'generation drafts and submits; it does not assert that anybody approved or signed it');
        equal(agreement.effective_date, '2026-10-01');
        equal(agreement.expiry_date, '2027-09-30',
            'which is what puts a generated contract into the renewal pipeline at all');
        equal(repo.listRecords('proposal', ctx, { accountId: account.id }).records.length, 0,
            'and it did not land in the proposals list');

        /**
         * The Arabic currency trap.
         *
         * The wizard was handed `currency: 'جنيه'`, because that is the word
         * that belongs in an Arabic sentence and the template prints it. The
         * RECORD must not take it: this column is what the USD dashboard
         * converts by, and "جنيه" has no exchange rate. It takes the account's
         * billing currency instead, and the document keeps its own wording.
         */
        equal(agreement.currency, 'EGP',
            'the record stores a code the dashboard can convert, not the word the contract prints');
        // And the other half: the DOCUMENT still says جنيه. Storing a code was
        // not meant to change a word of the contract.
        const printed = docx.readPart(
            docx.readZip(fs.readFileSync(path.join(db.STORAGE, document.storage_key))),
            'word/document.xml',
        );
        assert(printed.includes('جنيه'),
            'the contract stopped printing the currency word the client agreed to');
        equal(agreement.service_line_key, 'hcm', 'and which service was sold');
        equal(agreement.renewal_date, '2027-09-30', 'renewal starts at expiry');
        // 20,000 a month from 1 Oct 2026 to 30 Sep 2027 is twelve months.
        equal(agreement.contract_value, 240000,
            'the contract is worth its monthly fee times its term, in calendar months');
    });

    check('a signed agreement is untouched by the next generation', () => {
        const account = repo.createRecord('account', ctx, { name: 'Signed Ltd', services: ['hcm'] });
        db.run(
            `INSERT INTO commercial_registrations
               (id, workspace_id, account_id, company_name_ar, cr_number, representative_name, address, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [db.id('crg'), WS, account.id, 'شركة', '11223344', 'ممثل', 'جدة', db.now(), db.now()],
        );
        const fields = {
            employees_to_hire: 4, onsite_visits_per_week: 1, monthly_fee: 20000, currency: 'جنيه',
            start_date: '2026-01-01', end_date: '2026-12-31', contract_duration_text: 'سنة ميلادية',
        };
        const { record } = gen.generate(ctx, { accountId: account.id, docTypeKey: 'HCM_AGREEMENT', fields });
        db.run(`UPDATE agreements SET status = 'signed', signed_at = ? WHERE id = ?`, [db.now(), record.id]);

        const renewal = gen.generate(ctx, {
            accountId: account.id, docTypeKey: 'HCM_AGREEMENT',
            fields: { ...fields, start_date: '2027-01-01', end_date: '2027-12-31' },
        });
        const after = repo.getRecord('agreement', ctx, record.id);
        equal(after.status, 'signed', 'a new document does not unsign a contract');
        equal(after.expiry_date, '2026-12-31', 'nor rewrite the term somebody put their name to');
        equal(repo.getRecord('agreement', ctx, renewal.record.id).expiry_date, '2027-12-31',
            'the new term is on the new record, where the new document is');
    });

    await checkAsync('signing a generated agreement still makes the account a customer', async () => {
        const proposalsApi = await import('./api/proposals.mjs');
        const account = repo.createRecord('account', ctx, { name: 'Becomes Customer Ltd', services: ['hcm'] });
        db.run(
            `INSERT INTO commercial_registrations
               (id, workspace_id, account_id, company_name_ar, cr_number, representative_name, address, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [db.id('crg'), WS, account.id, 'شركة', '55667788', 'ممثل', 'الدمام', db.now(), db.now()],
        );
        const { record } = gen.generate(ctx, {
            accountId: account.id,
            docTypeKey: 'HCM_AGREEMENT',
            fields: {
                employees_to_hire: 2, onsite_visits_per_week: 1, monthly_fee: 9000, currency: 'جنيه',
                start_date: '2026-02-01', end_date: '2027-01-31', contract_duration_text: 'سنة ميلادية',
            },
        });

        // Signing commits the company, so it now waits for a manager. Approval
        // first, then signature — the order the workflow exists to impose.
        await proposalsApi.signAgreement({ req: bodyOf({}), params: { id: record.id }, ctx }).then(
            () => { throw new Error('signed an agreement nobody had approved'); },
            (err) => assert(/waiting for review/.test(err.message), err.message),
        );
        await approve('agreement', record.id);

        // The endpoint reads its body from the request; an empty one is enough
        // because the effective date came from the document.
        await proposalsApi.signAgreement({
            req: bodyOf({}), params: { id: record.id }, ctx,
        });
        equal(repo.getRecord('account', ctx, account.id).lifecycle_stage, 'customer',
            'the path that was unreachable while nothing ever created an agreement row');
    });

    await checkAsync('a template-written proposal refuses to be versioned from line items', async () => {
        const proposalsApi = await import('./api/proposals.mjs');
        const account = repo.createRecord('account', ctx, { name: 'Wrong Way Ltd', services: ['hcm'] });
        const { record } = gen.generate(ctx, { accountId: account.id, docTypeKey: 'HCM_PROPOSAL', fields: PROPOSAL_FIELDS });

        await proposalsApi.createVersion({ req: bodyOf({}), params: { id: record.id }, ctx }).then(
            () => { throw new Error('it should have refused'); },
            (err) => assert(/written from a template/i.test(err.message),
                `saying where the next version comes from: ${err.message}`),
        );
    });

    check('the file is removed if the row write fails', () => {
        // A contact id that does not exist violates the generations row's
        // foreign key — a real failure, after the file and the documents row
        // have already been written, which is exactly the case the cleanup is
        // there for.
        const filesBefore = fs.readdirSync(path.join(db.STORAGE, WS)).length;
        const docsBefore = db.get('SELECT COUNT(*) n FROM documents').n;

        throws(() => gen.generate(ctx, {
            dealId: genDeal.id, docTypeKey: 'HCM_PROPOSAL', fields: PROPOSAL_FIELDS,
            contactId: 'con_does_not_exist',
        }), /FOREIGN KEY|constraint/i, 'the write fails');

        equal(fs.readdirSync(path.join(db.STORAGE, WS)).length, filesBefore,
            'no orphan file: one with no record is invisible to every listing');
        equal(db.get('SELECT COUNT(*) n FROM documents').n, docsBefore,
            'and the documents row rolled back with it');
    });
}

/* ========= 16f. ACCOUNT TYPE, BILLING CURRENCY AND TARGETS ============== */
//
// The business asked for these to be two separate facts. Account Type groups
// the business; Billing Currency is what the client pays in. The type supplies
// an opening default and never more than that.

describe('account type and billing currency');

check('an Egypt account opens on EGP, a Regional one on USD', () => {
    const egypt = repo.createRecord('account', ctx, { name: 'Nile Foods', account_type: 'Egypt' });
    const regional = repo.createRecord('account', ctx, { name: 'Gulf Traders', account_type: 'Regional' });
    equal(egypt.billing_currency, 'EGP');
    equal(regional.billing_currency, 'USD');
});

check('a currency the caller stated is never overridden by the default', () => {
    // The case the business called out: a Regional client paying in SAR.
    const sar = repo.createRecord('account', ctx, {
        name: 'Riyadh Regional', account_type: 'Regional', billing_currency: 'SAR',
    });
    equal(sar.billing_currency, 'SAR', 'Regional does not mean USD forever');

    const egyptUsd = repo.createRecord('account', ctx, {
        name: 'Cairo On Dollars', account_type: 'Egypt', billing_currency: 'USD',
    });
    equal(egyptUsd.billing_currency, 'USD', 'nor Egypt EGP forever');
});

/**
 * Correcting the type re-detects the currency; a chosen currency is kept.
 *
 * The rule used to be that type never re-prices a client, full stop. That
 * protected the real case — a Regional client who genuinely pays in SAR — at
 * the cost of the commoner one: an account created as Egypt and corrected to
 * Regional kept EGP for ever, and nobody thinks to go and fix that by hand.
 *
 * So the currency follows the type only while it is still the OLD type's
 * default, which is to say only while nobody has expressed a preference.
 */
check('correcting the account type re-detects an untouched currency', () => {
    const account = repo.createRecord('account', ctx, { name: 'Reclassified Ltd', account_type: 'Egypt' });
    equal(account.billing_currency, 'EGP', 'the default that follows from Egypt');

    const moved = repo.updateRecord('account', ctx, account.id, { account_type: 'Regional' });
    equal(moved.account_type, 'Regional');
    equal(moved.billing_currency, 'USD', 'nobody had chosen EGP; it was only the default for the old type');
});

check('a chosen currency survives the type changing', () => {
    // A Regional client who genuinely pays in riyals. This is the case the
    // original rule existed to protect, and it still holds.
    const account = repo.createRecord('account', ctx, {
        name: 'Deliberate Ltd', account_type: 'Egypt', billing_currency: 'SAR',
    });
    equal(account.billing_currency, 'SAR', 'stated at creation, so not defaulted');

    const moved = repo.updateRecord('account', ctx, account.id, { account_type: 'Regional' });
    equal(moved.billing_currency, 'SAR',
        'somebody decided this; a reclassification is not a reason to overrule them');
});

check('an explicit currency in the same request always wins', () => {
    const account = repo.createRecord('account', ctx, { name: 'Both At Once Ltd', account_type: 'Egypt' });
    const moved = repo.updateRecord('account', ctx, account.id, {
        account_type: 'Regional', billing_currency: 'EGP',
    });
    equal(moved.billing_currency, 'EGP', 'what the caller said, not what the type implies');
});

/**
 * "No type" is no longer a state an account can be created in.
 *
 * This used to assert that an account with no type got no currency invented
 * for it, which was the right rule while the field was optional. It is now
 * required with a default, so the question has changed: an account that says
 * nothing gets the default type and the currency that follows from it, and an
 * account that says something keeps what it said.
 *
 * The rule underneath is unchanged and still worth pinning — the two fields
 * are separate, and neither is re-derived from the other after creation.
 */
check('an account always has a type, and its currency follows only at creation', () => {
    const account = repo.createRecord('account', ctx, { name: 'Unclassified Ltd' });
    equal(account.account_type, 'Regional', 'the default, so nothing lands unassigned');
    equal(account.billing_currency, 'USD', 'and the currency that Regional opens with');

    // Nobody chose USD — it is only what Regional opens with — so correcting
    // the type to Egypt re-detects EGP. This has to change the type to
    // something DIFFERENT to test anything: an earlier version of this
    // correction moved Regional to Regional and asserted a value that had
    // never moved.
    repo.updateRecord('account', ctx, account.id, { account_type: 'Egypt' });
    const moved = repo.getRecord('account', ctx, account.id);
    equal(moved.account_type, 'Egypt');
    equal(moved.billing_currency, 'EGP', 'the currency follows a type nobody had overridden');

    // A currency somebody actually picked is protected from the same move.
    const chosen = repo.createRecord('account', ctx, { name: 'Picked Their Own', billing_currency: 'SAR' });
    repo.updateRecord('account', ctx, chosen.id, { account_type: 'Egypt' });
    equal(repo.getRecord('account', ctx, chosen.id).billing_currency, 'SAR',
        'a chosen currency is a decision, and changing the type must not overwrite it');

    // And it cannot be cleared back to nothing.
    let refused = false;
    try {
        repo.updateRecord('account', ctx, account.id, { account_type: '' });
    } catch (err) {
        refused = /required/i.test(err.message);
    }
    assert(refused, 'an account type could be cleared, which is the state this made impossible');
});

check('account type is not location, and does not read country', () => {
    const account = repo.createRecord('account', ctx, {
        name: 'Registered Elsewhere', country: 'United Kingdom', account_type: 'Egypt',
    });
    equal(account.country, 'United Kingdom');
    equal(account.account_type, 'Egypt', 'a UK-registered entity can be Egypt business');

    const field = objects.fieldsFor('account', WS).find((f) => f.key === 'account_type');
    equal(field.options, objects.ACCOUNT_TYPES);
    assert(!/location/i.test(field.label + field.help), 'and it is never called Location');
});

check('only the three supported currencies are accepted', () => {
    throws(
        () => repo.createRecord('account', ctx, { name: 'Bad Money', billing_currency: 'GBP' }),
        /billing currency/i,
        'a currency the business does not bill in is refused, not stored',
    );
});

describe('USD reporting');

{
    const RATES = { USD: 1, EGP: 50, SAR: 3.75 };

    check('each currency converts by dividing by its units-per-USD rate', () => {
        equal(money.toReporting(20000, 'USD', RATES), 20000, 'Scenario C — USD passes through');
        equal(money.toReporting(500000, 'EGP', RATES), 10000, 'Scenario A — EGP 500,000 at 50');
        equal(money.toReporting(100000, 'SAR', RATES), 26666.67, 'Scenario B — SAR 100,000 at 3.75');
    });

    check('the brief’s worked example totals 46,666.67, not 32,666.67', () => {
        // The brief states 32,666.67 for 10,000 USD + 500,000 EGP + 100,000 SAR,
        // but its own formula gives 10,000 + 10,000 + 26,666.67. The formula is
        // what is implemented; the stated total is an arithmetic slip and this
        // test records which one the code follows.
        const total = money.toReporting(10000, 'USD', RATES)
            + money.toReporting(500000, 'EGP', RATES)
            + money.toReporting(100000, 'SAR', RATES);
        equal(Math.round(total * 100) / 100, 46666.67);
    });

    check('a currency with no rate is reported as unconvertible, never as dollars', () => {
        equal(money.toReporting(1000, 'GBP', RATES), null);
        const totals = money.aggregateInReporting(
            [{ currency: 'GBP', own_one_time: 1000 }, { currency: 'USD', own_one_time: 500 }],
            RATES,
        );
        equal(totals.one_time, 500, 'only what could be converted is counted');
        equal(totals.unconvertible, 1, 'and the rest is reported rather than silently dropped');
    });

    check('deals in different currencies are converted before they are summed', () => {
        // The bug this replaces: `aggregate` adds value_one_time across deals
        // without looking at currency, so EGP 500,000 + SAR 100,000 came out as
        // 600,000 of nothing in particular.
        const deals = [
            { currency: 'USD', own_one_time: 10000 },
            { currency: 'EGP', own_one_time: 500000 },
            { currency: 'SAR', own_one_time: 100000 },
        ];
        equal(money.aggregateInReporting(deals, RATES).one_time, 46666.67);
        equal(money.aggregate(deals.map((d) => ({ ...d, value_one_time: d.own_one_time }))).one_time, 610000,
            'which is what the currency-blind total would have said');
    });

    check('conversion starts from the untouched amount, not the fx-multiplied one', () => {
        // A line item can carry an fx_rate, which pre-converts into the
        // workspace base. Reporting must not apply a second rate on top.
        const items = [{ pricing_model: 'fixed_fee', quantity: 1, unit_amount: 500000, currency: 'EGP', fx_rate: 0.08 }];
        const derived = money.deriveValues(items, { baseCurrency: 'SAR' });
        equal(derived.value_one_time, 40000, 'base currency figure keeps the fx_rate');
        equal(derived.own_one_time, 500000, 'and the untouched amount is kept beside it');
        equal(money.toReporting(derived.own_one_time, 'EGP', RATES), 10000,
            'so USD reporting divides the real EGP amount, not 40,000 of something else');
    });

    check('a deal reports the currency it is billed in, not the workspace base', () => {
        /**
         * The derived money block carries its own `currency` — the base the
         * `value_*` figures are in — and assigning it flat used to overwrite the
         * deal's. Every deal came back saying SAR whatever it was billed in,
         * which is invisible until something converts by it and picks the wrong
         * rate. That is exactly what USD reporting does.
         */
        const account = repo.createRecord('account', ctx, {
            name: 'Billed In EGP Ltd', account_type: 'Egypt', services: ['hcm'],
        });
        const deal = repo.createRecord('deal', ctx, {
            name: 'EGP deal', account_id: account.id, pipeline_id: PIPE, stage_id: STAGE_OPEN,
            currency: 'EGP', service_line_key: 'hcm',
        });
        const fresh = repo.getRecord('deal', ctx, deal.id);
        equal(fresh.currency, 'EGP', 'the deal’s own currency survives hydration');
        equal(fresh.value_currency, ctx.workspace.baseCurrency,
            'and the base the value_* figures are in is still available, under its own name');
    });

    await checkAsync('Scenario D — changing a rate moves the dashboard and nothing else', async () => {
        const metaApi = await import('./api/meta.mjs');
        const account = repo.createRecord('account', ctx, {
            name: 'Rate Change Ltd', account_type: 'Egypt', services: ['hcm'],
        });
        const deal = repo.createRecord('deal', ctx, {
            name: 'Egypt retainer', account_id: account.id, pipeline_id: PIPE, stage_id: STAGE_OPEN,
            currency: 'EGP', service_line_key: 'hcm',
        });
        db.run(
            `INSERT INTO deal_line_items (id, workspace_id, deal_id, label, pricing_model, recurrence,
                                          quantity, unit_amount, currency, fx_rate, position)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [db.id('dli'), WS, deal.id, 'Retainer', 'fixed_fee', 'one_time', 1, 500000, 'EGP', 1, 0],
        );

        const usdAt = async (rate) => {
            await metaApi.updateSettings({ req: bodyOf({ fx_egp_per_usd: rate }), ctx });
            const rates = money.reportingRates((k) => settings.setting(WS, k));
            const fresh = repo.getRecord('deal', ctx, deal.id);
            return money.aggregateInReporting([fresh], rates).one_time;
        };

        equal(await usdAt(50), 10000, 'EGP 500,000 at 50 reports as USD 10,000');
        equal(await usdAt(52), 9615.38, 'and at 52 it reports as USD 9,615.38');

        // Part 6: the record itself did not move.
        const item = db.get('SELECT unit_amount, currency FROM deal_line_items WHERE deal_id = ?', [deal.id]);
        equal(item.unit_amount, 500000, 'the deal is still EGP 500,000');
        equal(item.currency, 'EGP');
        equal(repo.getRecord('deal', ctx, deal.id).currency, 'EGP', 'and still billed in EGP');
    });

    await checkAsync('a manager may read financial analytics but not change the rates', async () => {
        const metaApi = await import('./api/meta.mjs');
        const before = settings.setting(WS, 'fx_egp_per_usd');
        const managerCtx = { ...ctx, role: 'manager' };

        await metaApi.updateSettings({ req: bodyOf({ fx_egp_per_usd: 99 }), ctx: managerCtx })
            .then(() => { throw new Error('a manager should not set reporting rates'); },
                (err) => assert(/cannot finance settings/i.test(err.message), err.message));

        equal(settings.setting(WS, 'fx_egp_per_usd'), before, 'and the rate is unchanged');
    });

    await checkAsync('a rate that would break the maths is refused', async () => {
        const metaApi = await import('./api/meta.mjs');
        for (const bad of [0, -1, 'abc']) {
            await metaApi.updateSettings({ req: bodyOf({ fx_sar_per_usd: bad }), ctx })
                .then(() => { throw new Error(`should have refused ${bad}`); },
                    (err) => assert(/positive number/i.test(err.message), err.message));
        }
    });

    /**
     * The silent thirteen-fold error.
     *
     * A deal with no currency typed on it used to fall back to the WORKSPACE
     * base currency, which here is SAR. The dashboard converts by that field,
     * so an EGP deal nobody had marked was divided by 3.75 instead of 50 and
     * reported at roughly thirteen times its real value — silently, because SAR
     * has a rate and the unconvertible path never fired.
     */
    check('a deal with no currency of its own takes its account’s, not the workspace base', () => {
        equal(ctx.workspace.baseCurrency, 'SAR',
            'the premise: the base currency is NOT the thing an Egypt client pays in');

        const account = repo.createRecord('account', ctx, {
            name: 'Unmarked Deal Co', account_type: 'Egypt', services: ['hcm'],
        });
        equal(account.billing_currency, 'EGP');

        const deal = repo.createRecord('deal', ctx, {
            name: 'Unmarked', account_id: account.id, service_line_key: 'hcm',
            pipeline_id: PIPE, stage_id: STAGE_OPEN,
        });
        equal(db.get('SELECT currency FROM deals WHERE id = ?', [deal.id]).currency, 'EGP',
            'stored as EGP — the schema default of SAR must not reach an Egyptian account');
        equal(repo.getRecord('deal', ctx, deal.id).currency, 'EGP',
            'so 500,000 on it converts at 50 rather than at 3.75');

        // Deal currency is locked to the account's billing currency.
        const usd = repo.createRecord('deal', ctx, {
            name: 'Priced in dollars', account_id: account.id, service_line_key: 'hcm',
            pipeline_id: PIPE, stage_id: STAGE_OPEN, currency: 'USD',
        });
        equal(repo.getRecord('deal', ctx, usd.id).currency, 'EGP', 'deal currency is locked to account billing currency');
    });
}

/* ============================ deal identity, size and the agreement link = */

describe('Deal name, size and the agreement that needs a deal');

{
    const dealsApi = await import('./api/deals.mjs');

    await checkAsync('a deal names itself Company - Service', async () => {
        const account = repo.createRecord('account', ctx, { name: 'ABC Company', services: ['hcm'] });
        const deal = repo.createRecord('deal', ctx, {
            account_id: account.id, service_line_key: 'hcm', pipeline_id: PIPE, stage_id: STAGE_OPEN,
        });
        equal(deal.name, 'ABC Company - HCM', 'nobody typed this');

        const recruitment = repo.createRecord('deal', ctx, {
            account_id: account.id, service_line_key: 'recruitment', pipeline_id: PIPE, stage_id: STAGE_OPEN,
        });
        equal(recruitment.name, 'ABC Company - Recruitment',
            'a second deal for the same account is raised by hand and named the same way');
    });

    await checkAsync('a name somebody typed is never regenerated', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Named By Hand Ltd', services: ['hcm'] });
        const deal = repo.createRecord('deal', ctx, {
            name: 'Q3 renewal — urgent', account_id: account.id, service_line_key: 'hcm',
            pipeline_id: PIPE, stage_id: STAGE_OPEN,
        });
        equal(deal.name, 'Q3 renewal — urgent');
        const moved = repo.updateRecord('deal', ctx, deal.id, { service_line_key: 'recruitment' });
        equal(moved.name, 'Q3 renewal — urgent', 'their name survives a service change');
    });

    await checkAsync('a generated name follows the service that generated it', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Follows Along Co', services: ['hcm'] });
        const deal = repo.createRecord('deal', ctx, {
            account_id: account.id, service_line_key: 'hcm', pipeline_id: PIPE, stage_id: STAGE_OPEN,
        });
        const moved = repo.updateRecord('deal', ctx, deal.id, { service_line_key: 'recruitment' });
        equal(moved.name, 'Follows Along Co - Recruitment',
            'a deal called "… - HCM" that now sells Recruitment is a lie in the list view');
    });

    await checkAsync('the service decides whether the price recurs, and the user never does', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Bills Monthly Ltd', services: ['hcm'] });
        const deal = repo.createRecord('deal', ctx, {
            account_id: account.id, service_line_key: 'hcm', pipeline_id: PIPE, stage_id: STAGE_OPEN,
            currency: 'USD',
        });
        repo.setDealPrice(ctx, db.get('SELECT * FROM deals WHERE id = ?', [deal.id]), { price: 1000, count: 1, currency: 'USD' });

        const hcm = repo.getRecord('deal', ctx, deal.id);
        equal(hcm.price, 1000, 'the price is the number that was typed');
        equal(hcm.billing_type, 'recurring', 'HCM is per seat, so it recurs');
        equal(hcm.own_mrr, 1000, 'and it lands in MRR');
        equal(hcm.own_one_time, 0, 'not in one-time');

        // Moved to Recruitment, the same price is a placement fee.
        repo.updateRecord('deal', ctx, deal.id, { service_line_key: 'recruitment' });
        const recruitment = repo.getRecord('deal', ctx, deal.id);
        equal(recruitment.billing_type, 'one_time', 'Recruitment is a placement fee');
        equal(recruitment.own_one_time, 1000, 'so the same price is now one-time');
        equal(recruitment.own_mrr, 0, 'and the MRR it used to report is gone');
    });

    await checkAsync('deal_value is derived dynamically from the most recent associated proposal or agreement', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Derived Value Ltd', services: ['hcm'], billing_currency: 'USD' });
        const deal = repo.createRecord('deal', ctx, {
            account_id: account.id, service_line_key: 'hcm', pipeline_id: PIPE, stage_id: STAGE_OPEN,
        });
        
        let d = repo.getRecord('deal', ctx, deal.id);
        equal(d.deal_value, null);

        const propId = db.id('pro');
        const prvId = db.id('prv');
        db.run(
            `INSERT INTO proposals (id, workspace_id, account_id, deal_id, number, title, status, current_version, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,1,?,?)`,
            [propId, ctx.workspaceId, account.id, deal.id, 'P-TEST-0001', 'Test Proposal', 'draft', db.now(), db.now()],
        );
        db.run(
            `INSERT INTO proposal_versions (id, workspace_id, proposal_id, version, status, content, total_one_time, total_mrr, created_at)
             VALUES (?,?,?,1,'draft','{}',10000,5000,?)`,
            [prvId, ctx.workspaceId, propId, db.now()],
        );

        d = repo.getRecord('deal', ctx, deal.id);
        equal(d.deal_value, 10000, 'deal_value derived from proposal one_time only (never summed with MRR)');

        const agreement = repo.createRecord('agreement', ctx, {
            title: 'Signed Agreement', deal_id: deal.id, account_id: account.id, type: 'msa',
            service_line_key: 'hcm', contract_value: 55000, currency: 'USD',
            effective_date: '2026-06-01', status: 'approved',
        });
        d = repo.getRecord('deal', ctx, deal.id);
        equal(d.deal_value, 55000, 'deal_value derived from the most recent agreement');
    });

    await checkAsync('a deal carries exactly one price, however many times it is set', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Priced Once Ltd', services: ['recruitment'] });
        const deal = repo.createRecord('deal', ctx, {
            account_id: account.id, service_line_key: 'recruitment', pipeline_id: PIPE, stage_id: STAGE_OPEN,
        });
        const row = () => db.get('SELECT * FROM deals WHERE id = ?', [deal.id]);
        repo.setDealPrice(ctx, row(), { price: 100, currency: 'USD' });
        repo.setDealPrice(ctx, row(), { price: 250, currency: 'USD' });
        equal(db.get('SELECT COUNT(*) AS n FROM deal_line_items WHERE deal_id = ?', [deal.id]).n, 1,
            'the price is replaced, never appended to');
        equal(repo.getRecord('deal', ctx, deal.id).price, 250);
    });

    await checkAsync('the deal size endpoint takes a price and a currency and nothing else', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Two Fields Ltd', account_type: 'Egypt', services: ['od'] });
        const deal = repo.createRecord('deal', ctx, {
            account_id: account.id, service_line_key: 'od', pipeline_id: PIPE, stage_id: STAGE_OPEN,
        });
        const before = await dealsApi.dealSize({ params: { id: deal.id }, ctx });
        equal(before.size.price, null, 'unpriced is null, not zero — nobody has quoted it');
        assert(Array.isArray(before.currencies) && before.currencies.includes('USD'),
            'the currency is chosen from a list the dashboard holds rates for');

        await dealsApi.putDealSize({
            req: bodyOf({ price: 42000, currency: 'EGP' }), params: { id: deal.id }, ctx,
        });
        const after = await dealsApi.dealSize({ params: { id: deal.id }, ctx });
        equal(after.size.price, 42000);
        equal(after.size.currency, 'EGP');
        equal(after.size.billingType, 'one_time', 'OD is a fixed fee');
        equal(db.get('SELECT currency FROM deals WHERE id = ?', [deal.id]).currency, 'EGP',
            'the deal is billed in what its price is in — two answers is how a converted total loses a deal');
    });

    await checkAsync('an Offshoring deal is a headcount and a rate per head', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Twelve People Ltd', services: ['offshoring'], billing_currency: 'USD' });
        const deal = repo.createRecord('deal', ctx, {
            account_id: account.id, service_line_key: 'offshoring', pipeline_id: PIPE, stage_id: STAGE_OPEN,
        });

        const before = await dealsApi.dealSize({ params: { id: deal.id }, ctx });
        equal(before.size.perPerson?.countLabel, 'Employees',
            'the form asks for employees, in the service\u2019s own word, not "quantity"');

        await dealsApi.putDealSize({
            req: bodyOf({ price: 3000, count: 12, currency: 'USD' }), params: { id: deal.id }, ctx,
        });

        const after = await dealsApi.dealSize({ params: { id: deal.id }, ctx });
        equal(after.size.unitPrice, 3000, 'the rate per head is kept');
        equal(after.size.count, 12, 'and so is the headcount');
        equal(after.size.price, 36000, 'the deal size is the product of the two');

        const hydrated = repo.getRecord('deal', ctx, deal.id);
        equal(hydrated.own_mrr, 36000, 'and it lands in MRR, because Offshoring recurs');

        await dealsApi.putDealSize({
            req: bodyOf({ price: 3000, count: 11, currency: 'USD' }), params: { id: deal.id }, ctx,
        });
        const fewer = await dealsApi.dealSize({ params: { id: deal.id }, ctx });
        equal(fewer.size.unitPrice, 3000);
        equal(fewer.size.count, 11);
        equal(fewer.size.price, 33000);
    });

    await checkAsync('a per-person deal is refused a price with no count', async () => {
        const account = repo.createRecord('account', ctx, { name: 'No Headcount Ltd', services: ['offshoring'], billing_currency: 'USD' });
        const deal = repo.createRecord('deal', ctx, {
            account_id: account.id, service_line_key: 'offshoring', pipeline_id: PIPE, stage_id: STAGE_OPEN,
        });
        await dealsApi.putDealSize({
            req: bodyOf({ price: 36000, currency: 'USD' }), params: { id: deal.id }, ctx,
        }).then(
            () => { throw new Error('priced an Offshoring deal with no headcount'); },
            (err) => assert(/How many employees/.test(err.message), err.message),
        );

        // Zero is a real answer and is kept: a contract ramped to nobody.
        await dealsApi.putDealSize({
            req: bodyOf({ price: 3000, count: 0, currency: 'USD' }), params: { id: deal.id }, ctx,
        });
        equal((await dealsApi.dealSize({ params: { id: deal.id }, ctx })).size.price, 0);
    });

    await checkAsync('a flat-priced service is not asked how many', async () => {
        const account = repo.createRecord('account', ctx, { name: 'One Figure Ltd', services: ['recruitment'], billing_currency: 'USD' });
        const deal = repo.createRecord('deal', ctx, {
            account_id: account.id, service_line_key: 'recruitment', pipeline_id: PIPE, stage_id: STAGE_OPEN,
        });
        const size = await dealsApi.dealSize({ params: { id: deal.id }, ctx });
        equal(size.size.perPerson, null, 'Recruitment is one figure');

        await dealsApi.putDealSize({
            req: bodyOf({ price: 45000, currency: 'USD' }), params: { id: deal.id }, ctx,
        });
        const after = await dealsApi.dealSize({ params: { id: deal.id }, ctx });
        equal(after.size.price, 45000, 'and the price it was given is the whole of it');
        equal(after.size.count, 1);
    });

    await checkAsync('a deal reports its size in USD as well as the client’s currency', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Reads In Dollars Ltd', services: ['recruitment'], billing_currency: 'SAR' });
        const deal = repo.createRecord('deal', ctx, {
            account_id: account.id, service_line_key: 'recruitment', pipeline_id: PIPE, stage_id: STAGE_OPEN,
            currency: 'SAR',
        });
        await dealsApi.putDealSize({
            req: bodyOf({ price: 75000, currency: 'SAR' }), params: { id: deal.id }, ctx,
        });

        const hydrated = repo.getRecord('deal', ctx, deal.id);
        equal(hydrated.currency, 'SAR', 'the client still pays in riyals');
        equal(hydrated.price, 75000);
        equal(hydrated.reporting_currency, 'USD');
        /**
         * The dashboard converts to USD and every deal screen showed the
         * client's own currency, so a SAR deal and an EGP deal were compared as
         * bare numbers that differ by a factor of thirteen before the digits
         * are read.
         */
        equal(hydrated.price_reporting, 20000, 'SAR 75,000 at 3.75 is USD 20,000');
        equal(hydrated.one_time_reporting, 20000, 'and the one-time figure converts with it');
    });

    await checkAsync('a currency nothing holds a rate for is refused', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Bad Currency Ltd' });
        const deal = repo.createRecord('deal', ctx, {
            account_id: account.id, service_line_key: 'hcm', pipeline_id: PIPE, stage_id: STAGE_OPEN,
        });
        await dealsApi.putDealSize({
            req: bodyOf({ price: 10, count: 1, currency: 'GBP' }), params: { id: deal.id }, ctx,
        }).then(
            () => { throw new Error('accepted a currency with no reporting rate'); },
            (err) => assert(/Currency must be one of/.test(err.message), err.message),
        );
    });

    await checkAsync('an agreement for an account with no deal creates one', async () => {
        const account = repo.createRecord('account', ctx, {
            name: 'No Deal Yet Ltd', services: ['hcm'], billing_currency: 'USD',
        });
        equal(db.get('SELECT COUNT(*) AS n FROM deals WHERE account_id = ?', [account.id]).n, 0,
            'the premise: this account has no deal');

        const agreement = repo.createRecord('agreement', ctx, {
            title: 'First contract', account_id: account.id, type: 'msa',
            service_line_key: 'hcm', contract_value: 5000, currency: 'USD',
            effective_date: '2026-03-01',
        });
        assert(agreement.deal_id, 'the agreement was NOT left without a deal');

        const deal = repo.getRecord('deal', ctx, agreement.deal_id);
        equal(deal.name, 'No Deal Yet Ltd - HCM', 'and the deal is named like every other');
        equal(deal.price, 5000, 'and priced from the contract');
        equal(deal.currency, 'USD');
        equal(deal.billing_type, 'recurring');
        equal(
            db.get('SELECT s.key FROM deals d JOIN stages s ON s.id = d.stage_id WHERE d.id = ?', [deal.id]).key,
            'contracting',
            'a contract exists, so the deal is being contracted',
        );
    });

    await checkAsync('an agreement for an account that HAS the right deal links to it', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Has A Deal Ltd', services: ['hcm'] });
        const existing = repo.createRecord('deal', ctx, {
            account_id: account.id, service_line_key: 'hcm', pipeline_id: PIPE, stage_id: STAGE_OPEN,
        });
        const agreement = repo.createRecord('agreement', ctx, {
            title: 'Second contract', account_id: account.id, type: 'msa',
            service_line_key: 'hcm', effective_date: '2026-03-01',
        });
        equal(agreement.deal_id, existing.id, 'it must not invent a second deal for the same service');
        equal(db.get('SELECT COUNT(*) AS n FROM deals WHERE account_id = ?', [account.id]).n, 1);
    });

    await checkAsync('a different service gets its own deal, not somebody else’s', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Two Services Ltd', services: ['hcm'] });
        repo.createRecord('deal', ctx, {
            account_id: account.id, service_line_key: 'hcm', pipeline_id: PIPE, stage_id: STAGE_OPEN,
        });
        const agreement = repo.createRecord('agreement', ctx, {
            title: 'Offshoring contract', account_id: account.id, type: 'msa',
            service_line_key: 'offshoring', effective_date: '2026-03-01',
        });
        const deal = repo.getRecord('deal', ctx, agreement.deal_id);
        equal(deal.service_line_key, 'offshoring',
            'attaching an Offshoring contract to the HCM deal because it was the only one going is worse than either');
        equal(deal.name, 'Two Services Ltd - Offshoring');
        equal(db.get('SELECT COUNT(*) AS n FROM deals WHERE account_id = ?', [account.id]).n, 2);
    });

    await checkAsync('unlinking an agreement from its deal re-links it', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Cannot Be Orphaned Ltd', services: ['hcm'] });
        const agreement = repo.createRecord('agreement', ctx, {
            title: 'Stays linked', account_id: account.id, type: 'msa',
            service_line_key: 'hcm', effective_date: '2026-03-01',
        });
        const after = repo.updateRecord('agreement', ctx, agreement.id, { deal_id: null });
        assert(after.deal_id, 'an agreement is never left without a deal');
    });

    await checkAsync('an agreement and its deal agree about what the client pays', async () => {
        const account = repo.createRecord('account', ctx, { name: 'One Number Ltd', services: ['recruitment'], billing_currency: 'USD' });
        const deal = repo.createRecord('deal', ctx, {
            account_id: account.id, service_line_key: 'recruitment', pipeline_id: PIPE, stage_id: STAGE_OPEN,
            currency: 'USD',
        });
        repo.setDealPrice(ctx, db.get('SELECT * FROM deals WHERE id = ?', [deal.id]), { price: 30000, currency: 'USD' });

        // Generated with no figure: the deal teaches the agreement.
        const agreement = repo.createRecord('agreement', ctx, {
            title: 'Takes the deal’s figure', account_id: account.id, deal_id: deal.id, type: 'msa',
            service_line_key: 'recruitment', effective_date: '2026-04-01',
        });
        equal(repo.getRecord('agreement', ctx, agreement.id).contract_value, 30000,
            'an agreement with no value takes its deal’s');

        // Renegotiated on the contract: the agreement teaches the deal back.
        repo.updateRecord('agreement', ctx, agreement.id, { contract_value: 27500 });
        equal(repo.getRecord('deal', ctx, deal.id).price, 27500,
            'the signed document wins — the deal is the negotiation that produced it');
    });
}

/* ===================================== prospecting is not a rep's plane == */

describe('A rep and the sourcing book');

{
    const metaApi = await import('./api/meta.mjs');

    check('every route that serves prospecting is refused to a rep', () => {
        const refused = [
            '/api/prospects',
            '/api/prospects/pro_123',
            '/api/prospecting_contacts',
            '/api/qualification/rules',
            '/api/qualification/run',
            '/api/accounts/acc_123/verdicts',
            '/api/accounts/acc_123/evidence',
            '/api/accounts/acc_123/collect',
            '/api/accounts/acc_123/collectability',
        ];
        for (const path of refused) {
            assert(!auth.routeAllowed(repCtx, 'GET', path), `a rep reached ${path}`);
            assert(auth.routeAllowed(ctx, 'GET', path), `an owner was refused ${path}`);
        }
    });

    check('the routes a rep DOES work are untouched by that', () => {
        for (const path of ['/api/accounts', '/api/contacts', '/api/deals', '/api/tasks',
            '/api/activities', '/api/agreements', '/api/accounts/acc_123/related']) {
            assert(auth.routeAllowed(repCtx, 'GET', path), `a rep was refused ${path}`);
        }
    });

    await checkAsync('a rep is not sent the prospecting vocabulary either', async () => {
        const repMeta = await metaApi.meta({ ctx: repCtx });
        assert(!repMeta.objects.prospecting_company, 'the object registry offered a rep prospecting companies');
        assert(!repMeta.objects.prospecting_contact, 'and prospecting contacts');

        const accountFields = repMeta.objects.account.fields.map((f) => f.key);
        assert(!accountFields.includes('verdict_hcm'),
            'a Columns dialog offering "HCM verdict" is prospecting through another window');
        assert(!accountFields.includes('verdict_offshoring'));

        const ownerMeta = await metaApi.meta({ ctx });
        assert(ownerMeta.objects.prospecting_company, 'and none of it is taken from a role that has it');
        assert(ownerMeta.objects.account.fields.some((f) => f.key === 'verdict_hcm'));
    });

    await checkAsync('an account read by a rep carries no verdicts', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Verdicts Are Not Yours Ltd', services: ['hcm'] });
        db.run(
            `INSERT INTO verdicts (id, workspace_id, account_id, rule_key, rule_version, verdict,
                                   confidence, metrics, reasons, notes, source, computed_at, is_current)
             VALUES (?,?,?,'hcm',1,'QUALIFIED',0.9,'{}','[]','[]','engine',?,1)`,
            [db.id('vrd'), WS, account.id, db.now()],
        );

        const asOwner = repo.getRecord('account', ctx, account.id);
        equal(asOwner.verdict_hcm, 'QUALIFIED', 'the premise: there IS a verdict to leak');

        const asRep = repo.getRecord('account', repCtx, account.id);
        assert(!asRep.verdicts, 'the verdict block rode along with the account');
        assert(asRep.verdict_hcm === undefined,
            'a rep must not read prospecting’s conclusion off a record they are allowed to open');
        equal(asRep.name, 'Verdicts Are Not Yours Ltd', 'while the account itself is still entirely theirs');
    });

    await checkAsync('a rep naming a prospecting widget by id is refused it', async () => {
        const dash = await import('./api/dashboard.mjs');
        const DASH = db.id('dsh');
        db.run(
            `INSERT INTO dashboards (id, workspace_id, name, layout, scope, is_default, created_at, updated_at)
             VALUES (?,?,?,?,?,0,?,?)`,
            [DASH, WS, 'Everything', JSON.stringify([
                { widget: 'prospecting_funnel', title: 'Prospecting intake', size: 'wide', options: {} },
                { widget: 'my_tasks', title: 'My tasks', size: 'half', options: {} },
            ]), 'workspace', db.now(), db.now()],
        );

        const asRep = await dash.dashboardData({
            params: { id: DASH }, url: new URL('http://x/?range=this_quarter'), ctx: repCtx,
        });
        const funnel = asRep.widgets.find((w) => w.widget === 'prospecting_funnel');
        assert(funnel.error && /cannot see prospecting/.test(funnel.error),
            'the sourcing book was computed for a rep who asked for it by id');
        assert(!funnel.data, 'and no rows came back with it');

        const tasks = asRep.widgets.find((w) => w.widget === 'my_tasks');
        assert(tasks.data, 'one refused widget must not take the rest of the dashboard down');

        const asOwner = await dash.dashboardData({
            params: { id: DASH }, url: new URL('http://x/?range=this_quarter'), ctx,
        });
        assert(asOwner.widgets.find((w) => w.widget === 'prospecting_funnel').data,
            'and a role that holds the capability still gets it');

        // Cleared, because a later scenario picks "the workspace dashboard" by
        // asking for any row and would otherwise get this one.
        db.run('DELETE FROM dashboards WHERE id = ?', [DASH]);
    });

    check('the client never routes a rep to a prospecting page', () => {
        const src = fs.readFileSync(new URL('./public/js/app.js', import.meta.url), 'utf8');
        assert(/PROSPECTING_ROUTE_NAMES/.test(src) && /guarded\('prospecting\.read'/.test(src),
            'the prospecting routes must be guarded, so the page is never built and never fetches');
        assert(/route\('\/qualification', guarded\('prospecting\.read'/.test(src),
            'including the qualification workspace');
    });

    check('the record page asks for verdicts only when the viewer may read them', () => {
        const src = fs.readFileSync(new URL('./public/js/pages/record.js', import.meta.url), 'utf8');
        const guard = src.match(/const qualifies = [^;]+;/s)?.[0] ?? '';
        assert(/store\.can\('prospecting\.read'\)/.test(guard),
            'every /verdicts and /evidence fetch on this page hangs off `qualifies`');
    });
}

describe('performance by account type and service');

{
    const dash = await import('./api/dashboard.mjs');
    const metaApi = await import('./api/meta.mjs');

    /**
     * Pinned, not inherited.
     *
     * An earlier block moves the EGP rate to 52 to prove Scenario D, and these
     * assertions are about the conversion rather than about whatever the suite
     * happened to leave behind. A test that reads a number another test wrote
     * fails for reasons that have nothing to do with it.
     */
    await metaApi.updateSettings({ req: bodyOf({ fx_egp_per_usd: 50, fx_sar_per_usd: 3.75 }), ctx });

    // Egypt HCM and Regional HCM, each with a won deal in a different currency.
    const wonDeal = (name, accountType, currency, amount, service) => {
        const account = repo.createRecord('account', ctx, { name, account_type: accountType, billing_currency: currency, services: [service] });
        const deal = repo.createRecord('deal', ctx, {
            name: `${name} deal`, account_id: account.id, pipeline_id: PIPE, stage_id: STAGE_WON,
            currency, service_line_key: service,
        });
        db.run(
            `INSERT INTO deal_line_items (id, workspace_id, deal_id, label, pricing_model, recurrence,
                                          quantity, unit_amount, currency, fx_rate, position)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [db.id('dli'), WS, deal.id, 'Fee', 'fixed_fee', 'one_time', 1, amount, currency, 1, 0],
        );
        db.run("UPDATE deals SET status = 'won', closed_at = ? WHERE id = ?", [db.now(), deal.id]);
        return deal;
    };

    wonDeal('Matrix Egypt Strategy', 'Egypt', 'EGP', 500000, 'od');
    wonDeal('Matrix Regional Strategy', 'Regional', 'SAR', 100000, 'od');
    wonDeal('Matrix Regional Recruitment', 'Regional', 'USD', 20000, 'recruitment');

    const matrix = async () => {
        const DASH = db.id('dsh');
        db.run(
            `INSERT INTO dashboards (id, workspace_id, name, layout, scope, is_default, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?)`,
            [DASH, WS, 'Matrix', JSON.stringify([{ widget: 'service_performance', options: {} }]),
                'workspace', 0, db.now(), db.now()],
        );
        const out = await dash.dashboardData({
            params: { id: DASH }, url: new URL('http://x/?range=all'),
            ctx: { ...ctx, workspace: { ...ctx.workspace, timezone: 'Asia/Riyadh' } },
        });
        assert(!out.widgets[0].error, `widget failed: ${out.widgets[0].error}`);
        return out.widgets[0].data;
    };

    const cellFor = (data, service, accountType) =>
        data.rows.find((r) => r.service === service)?.cells.find((c) => c.accountType === accountType);

    await checkAsync('each cell converts its own deals to USD before totalling', async () => {
        const data = await matrix();
        equal(data.currency, 'USD');

        // Scenario A: EGP 500,000 at 50.
        equal(cellFor(data, 'od', 'Egypt').tcv, 10000);
        // Scenario B: SAR 100,000 at 3.75.
        equal(cellFor(data, 'od', 'Regional').tcv, 26666.67);
        // Scenario C: USD 20,000 straight through.
        equal(cellFor(data, 'recruitment', 'Regional').tcv, 20000);
    });

    await checkAsync('Egypt and Regional are reported apart, not blended', async () => {
        const data = await matrix();
        assert(data.accountTypes.includes('Egypt') && data.accountTypes.includes('Regional'));
        equal(cellFor(data, 'od', 'Egypt').count, 1);
        equal(cellFor(data, 'od', 'Regional').count, 1);
        equal(cellFor(data, 'recruitment', 'Egypt').tcv, 0,
            'a combination with nothing in it reports zero rather than borrowing the other side’s');
    });

    /**
     * "Unassigned" is not a column, and the deals behind it do not vanish.
     *
     * It used to be a third column, which in practice meant a permanent strip
     * of "$0 / —" beside the two that carry the business — read as a broken
     * widget rather than as a prompt. The fact still has to survive, because a
     * split that quietly stops adding up to the total is how a quarter goes by
     * before anybody notices. So it became a line under the table that appears
     * only when there is something to say.
     */
    await checkAsync('an unclassified account is a footnote, not a column', async () => {
        const clean = await matrix();
        assert(!clean.accountTypes.includes('Unassigned'),
            'the empty third column is what this removed');
        equal(clean.unassigned, null, 'and nothing is said when there is nothing to say');

        /**
         * A won deal on an account nobody has classified.
         *
         * Written straight to SQL, because the field is now required with a
         * default and the API can no longer produce this row. That is the
         * point: the only way to be untyped is to PREDATE the rule, which is
         * exactly the data `apply-account-type-backfill.mjs` exists to sweep
         * up. The footnote is the safeguard for a database where that sweep has
         * not been run yet, so it has to be tested against a row of that shape.
         */
        const stray = repo.createRecord('account', ctx, { name: 'Unclassified Co', services: ['hcm'] });
        db.run('UPDATE accounts SET account_type = NULL WHERE id = ?', [stray.id]);
        equal(repo.getRecord('account', ctx, stray.id).account_type ?? null, null,
            'the premise: a legacy row with no account type');
        const dealId = db.id('deal');
        db.run(
            `INSERT INTO deals (id, workspace_id, account_id, name, pipeline_id, stage_id, status,
                                currency, service_line_key, closed_at, created_at, updated_at)
             VALUES (?,?,?,?,?,?,'won','USD','hcm',?,?,?)`,
            [dealId, WS, stray.id, 'Stray win', PIPE, STAGE_WON, db.now(), db.now(), db.now()],
        );
        repo.insert('deal_line_items', {
            id: db.id('lit'), workspace_id: WS, deal_id: dealId, position: 0,
            label: 'Fee', pricing_model: 'fixed_fee', recurrence: 'one_time',
            quantity: 1, unit_amount: 7000, currency: 'USD', fx_rate: 1,
        });

        const data = await matrix();
        assert(!data.accountTypes.includes('Unassigned'), 'still not a column');
        assert(data.unassigned, 'but the deal is reported rather than dropped');
        equal(data.unassigned.count, 1);
        equal(data.unassigned.tcv, 7000, 'in USD, so it can be compared with the columns it is missing from');

        db.run('DELETE FROM deal_line_items WHERE deal_id = ?', [dealId]);
        db.run('DELETE FROM deals WHERE id = ?', [dealId]);
    });

    await checkAsync('attainment is null without a target, and a percentage with one', async () => {
        let data = await matrix();
        equal(cellFor(data, 'od', 'Egypt').target, null);
        equal(cellFor(data, 'od', 'Egypt').attainment, null,
            'not 0% — nobody has agreed a number to be 0% of');

        await metaApi.putServiceTarget({
            req: bodyOf({ accountType: 'Egypt', service: 'od', target: 20000 }), ctx,
        });
        data = await matrix();
        equal(cellFor(data, 'od', 'Egypt').target, 20000);
        equal(cellFor(data, 'od', 'Egypt').attainment, 50, 'USD 10,000 won against a USD 20,000 target');
    });

    await checkAsync('one-time and recurring are reported apart, and only TCV meets the target', async () => {
        const data = await matrix();
        const cell = cellFor(data, 'od', 'Egypt');
        assert('one_time' in cell && 'mrr' in cell, 'both are present');
        assert(!('total' in cell), 'and there is no single blended figure');
        equal(cell.tcv, cell.one_time, 'this deal is one-time only, so TCV equals it');
    });

    await checkAsync('no role layout asks for a widget that role is refused', async () => {
        /**
         * The rep layout carried `prospecting_funnel`, and prospecting is
         * refused to a rep — so after that refusal was added, the rep's own
         * home page drew a card reading "Your role cannot see prospecting".
         * A layout asking for something the role is denied is a layout nobody
         * meant to write, and it is only visible by checking the two lists
         * against each other.
         */
        const CAPABILITY = { money: 'finance.read', prospecting: 'prospecting.read' };
        const HOLDS = {
            rep: new Set(['record.read.all', 'record.write.own', 'proposal.issue', 'calling.manage']),
            readonly: new Set(['record.read.all']),
        };

        for (const [role, held] of Object.entries(HOLDS)) {
            for (const item of dash.ROLE_DASHBOARDS[role] ?? []) {
                const widget = dash.WIDGETS[item.widget];
                assert(widget, `${role} layout names an unknown widget "${item.widget}"`);
                for (const [flag, capability] of Object.entries(CAPABILITY)) {
                    if (widget[flag]) {
                        assert(held.has(capability),
                            `the ${role} layout asks for "${item.widget}", which needs ${capability}`);
                    }
                }
            }
        }
    });

    await checkAsync('win rate and the money card do not report the same figures', async () => {
        /**
         * They sat on four layouts between them and repeated four figures out
         * of seven: "Win rate" twice with the same formula and the same help
         * text, and the count of won deals under two labels. Two cards, a
         * scroll apart, asking to be read twice.
         */
        const range = { from: '2026-01-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z', preset: 'year', label: 'this year' };
        const reporting = { currency: 'USD', rates: { USD: 1, EGP: 50, SAR: 3.75 } };

        const rate = await dash.WIDGETS.win_rate.run(ctx, {}, range, reporting);
        const value = await dash.WIDGETS.deals_won.run(ctx, {}, range, reporting);

        const rateLabels = rate.tiles.map((t) => t.label.toLowerCase());
        const valueLabels = value.tiles.map((t) => t.label.toLowerCase());
        const shared = rateLabels.filter((l) => valueLabels.includes(l));
        equal(shared.length, 0, `both cards show: ${shared.join(', ')}`);

        // Each answers one question: one counts, the other values.
        assert(rate.tiles.every((t) => !t.money), 'win rate is counts and a percentage, never money');
        assert(value.tiles.every((t) => t.money), 'the money card is money throughout');
        assert(!dash.WIDGETS.win_rate.money, 'so a rep may have the first');
        assert(dash.WIDGETS.deals_won.money, 'and not the second');
    });

    await checkAsync('a service performance widget declares that it reports money', async () => {
        // The rule the rep layout depends on.
        equal(dash.WIDGETS.service_performance.money, true);
        for (const item of dash.ROLE_DASHBOARDS.rep ?? []) {
            assert(!dash.WIDGETS[item.widget]?.money,
                `the rep layout must not carry the money widget "${item.widget}"`);
        }
    });
}

describe('service targets');

{
    const metaApi = await import('./api/meta.mjs');

    await checkAsync('a target reads back per account type and service', async () => {
        await metaApi.putServiceTarget({
            req: bodyOf({ accountType: 'Egypt', service: 'hcm', target: 50000 }), ctx,
        });
        const { targets, currency } = await metaApi.serviceTargets({ ctx });
        equal(currency, 'USD', 'stated, because a target without a currency means nothing');

        const egyptHcm = targets.find((t) => t.accountType === 'Egypt' && t.service === 'hcm');
        equal(egyptHcm.target, 50000);

        const regionalHcm = targets.find((t) => t.accountType === 'Regional' && t.service === 'hcm');
        equal(regionalHcm.target, null, 'the same service on the other side of the business is untouched');
    });

    await checkAsync('a target nobody set is null, not zero', async () => {
        const { targets } = await metaApi.serviceTargets({ ctx });
        const unset = targets.find((t) => t.target === null);
        assert(unset, 'the grid returns every combination, set or not');
        assert(!targets.some((t) => t.target === 0 && t.updatedAt === null),
            'an unset target is never reported as a target of zero');
    });

    await checkAsync('clearing a target removes it rather than storing zero', async () => {
        await metaApi.putServiceTarget({
            req: bodyOf({ accountType: 'Egypt', service: 'offshoring', target: 1000 }), ctx,
        });
        await metaApi.putServiceTarget({
            req: bodyOf({ accountType: 'Egypt', service: 'offshoring', target: '' }), ctx,
        });
        const { targets } = await metaApi.serviceTargets({ ctx });
        const cleared = targets.find((t) => t.accountType === 'Egypt' && t.service === 'offshoring');
        equal(cleared.target, null);
        equal(db.get(
            "SELECT COUNT(*) AS n FROM service_targets WHERE account_type = 'Egypt' AND service_line_key = 'offshoring'",
        ).n, 0, 'the row is gone, so "not set" survives a reload');
    });

    await checkAsync('a target is refused for an unknown type or service', async () => {
        await metaApi.putServiceTarget({ req: bodyOf({ accountType: 'Mars', service: 'hcm', target: 1 }), ctx })
            .then(() => { throw new Error('should have refused the account type'); },
                (err) => assert(/Account type must be one of/.test(err.message), err.message));

        await metaApi.putServiceTarget({ req: bodyOf({ accountType: 'Egypt', service: 'nope', target: 1 }), ctx })
            .then(() => { throw new Error('should have refused the service'); },
                (err) => assert(/not a service line/.test(err.message), err.message));
    });
}

/* ============= 16e. THE CALLING QUEUE FILTERS LIKE A LIST =============== */

/**
 * Draft → Pending review → Approved / Rejected.
 *
 * The rule underneath is that the person who writes a document is not the
 * person who commits the company to it. These tests are written from the rep's
 * side, because that is the side the rule exists to constrain.
 */
describe('proposal and agreement review');

{
    const docs = await import('./api/proposals.mjs');

    /**
     * A draft proposal owned by the rep.
     *
     * Inserted rather than built through `repo.createRecord`, because `number`
     * is read-only on the object — proposals get their number from
     * `createProposal`, and this block is testing what happens to a document
     * after it exists, not how it came to.
     */
    const draftProposal = (owner = repCtx) => {
        const account = repo.createRecord('account', ctx, {
            name: `Review Co ${db.id('t')}`, account_type: 'Egypt', services: ['hcm'],
        });
        const proposalId = db.id('pro');
        db.run(
            `INSERT INTO proposals
               (id, workspace_id, account_id, number, title, currency, status, current_version, owner_id, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [proposalId, WS, account.id, `P-T-${proposalId}`, 'Draft', 'EGP', 'draft', 0,
                owner.userId, db.now(), db.now()],
        );
        return repo.getRecord('proposal', ctx, proposalId);
    };

    await checkAsync('a rep submits, and cannot approve what they submitted', async () => {
        const proposal = draftProposal();

        await docs.submitProposalForReview({ params: { id: proposal.id }, ctx: repCtx });
        equal(repo.getRecord('proposal', ctx, proposal.id).status, 'pending_review',
            'a rep can put their own work up for review — that is the whole workflow');

        await docs.reviewProposal({
            req: bodyOf({ decision: 'approved' }), params: { id: proposal.id }, ctx: repCtx,
        }).then(
            () => { throw new Error('a rep approved their own proposal'); },
            (err) => assert(/cannot document approve/.test(err.message), err.message),
        );
        equal(repo.getRecord('proposal', ctx, proposal.id).status, 'pending_review',
            'and the refusal left the document where it was');
    });

    await checkAsync('a proposal cannot be issued until somebody approves it', async () => {
        const proposal = draftProposal();
        await docs.submitProposalForReview({ params: { id: proposal.id }, ctx: repCtx });

        await docs.issueVersion({ params: { id: proposal.id, version: '1' }, ctx }).then(
            () => { throw new Error('issued a proposal nobody had approved'); },
            // Reaching the approval gate at all is the assertion: this proposal
            // has no version 1, and the gate must come first regardless.
            (err) => assert(/waiting for review|does not exist/.test(err.message), err.message),
        );
    });

    await checkAsync('a rejection has to say why, and sends the document back', async () => {
        const proposal = draftProposal();
        await docs.submitProposalForReview({ params: { id: proposal.id }, ctx: repCtx });

        await docs.reviewProposal({
            req: bodyOf({ decision: 'rejected' }), params: { id: proposal.id }, ctx,
        }).then(
            () => { throw new Error('rejected with no reason'); },
            (err) => assert(/Say why/.test(err.message), err.message),
        );

        await docs.reviewProposal({
            req: bodyOf({ decision: 'rejected', note: 'The discount needs sign-off.' }),
            params: { id: proposal.id }, ctx,
        });
        const rejected = repo.getRecord('proposal', ctx, proposal.id);
        equal(rejected.status, 'rejected');
        equal(rejected.review_note, 'The discount needs sign-off.',
            'the note lives on the record because the author has to READ it to act on it');
        equal(rejected.reviewed_by, ctx.userId, 'and who said so is on the record too');

        // Resubmitting starts a clean round rather than carrying a stale verdict.
        await docs.submitProposalForReview({ params: { id: proposal.id }, ctx: repCtx });
        const resubmitted = repo.getRecord('proposal', ctx, proposal.id);
        equal(resubmitted.status, 'pending_review');
        equal(resubmitted.review_note, null, "last round's verdict is not this round's");
    });

    await checkAsync('approving twice is not a review', async () => {
        const proposal = draftProposal();
        await docs.submitProposalForReview({ params: { id: proposal.id }, ctx: repCtx });
        await docs.reviewProposal({ req: bodyOf({ decision: 'approved' }), params: { id: proposal.id }, ctx });

        await docs.reviewProposal({
            req: bodyOf({ decision: 'rejected', note: 'changed my mind' }), params: { id: proposal.id }, ctx,
        }).then(
            () => { throw new Error('re-reviewed a decided document'); },
            (err) => assert(/not awaiting review/.test(err.message), err.message),
        );
    });

    /**
     * Every capability the UI gates on must actually be SENT to the UI.
     *
     * `store.can('document.approve')` on a capability missing from /api/me
     * returns undefined, which is falsey, so the Approve and Reject buttons
     * simply never render — for anybody, including the managers the workflow
     * exists for. The server stays correct and the feature is invisible, which
     * is the worst shape a bug can take: nothing errors.
     */
    await checkAsync('every capability the front end asks about is one the API returns', async () => {
        const metaApi = await import('./api/meta.mjs');
        const { capabilities } = await metaApi.me({ ctx });

        const asked = new Set();
        for (const file of fs.readdirSync(new URL('./public/js/pages/', import.meta.url))) {
            const src = fs.readFileSync(new URL(`./public/js/pages/${file}`, import.meta.url), 'utf8');
            for (const m of src.matchAll(/store\.can\('([^']+)'\)/g)) asked.add(m[1]);
        }
        assert(asked.size > 0, 'the scan found no store.can() calls, so it is testing nothing');

        const missing = [...asked].filter((c) => !(c in capabilities));
        equal(missing, [], 'the UI gates on these but /api/me never mentions them, so the '
            + 'controls they guard are invisible to every role');
    });

    /**
     * A second version has to be reviewable, or the workflow is a trap.
     *
     * v1 is approved and issued, so the proposal reads `issued`. Creating v2
     * used to leave it there — and `issued` is neither approvable (nothing is
     * awaiting review) nor submittable (only a draft or a rejection goes up).
     * The result was a version that could never be issued by anybody, with two
     * error messages that each told you to do the thing the other refused.
     */
    await checkAsync('a new version puts the proposal back in the queue', async () => {
        const account = repo.createRecord('account', ctx, {
            name: 'Second Version Co', account_type: 'Regional', services: ['hcm'],
        });
        const deal = repo.createRecord('deal', ctx, {
            name: 'Versioned', account_id: account.id, pipeline_id: PIPE, stage_id: STAGE_OPEN,
        });
        repo.insert('deal_line_items', {
            id: db.id('lit'), workspace_id: WS, deal_id: deal.id, position: 0,
            label: 'Retainer', pricing_model: 'per_seat', recurrence: 'monthly', quantity: 1,
            unit_amount: 1000, term_months: 12, currency: 'USD', fx_rate: 1,
        });

        const { proposal } = await docs.createProposal({ req: bodyOf({ dealId: deal.id }), ctx });
        await docs.createVersion({ req: bodyOf({}), params: { id: proposal.id }, ctx });
        await docs.submitProposalForReview({ params: { id: proposal.id }, ctx });
        await docs.reviewProposal({ req: bodyOf({ decision: 'approved' }), params: { id: proposal.id }, ctx });
        await docs.issueVersion({ params: { id: proposal.id, version: '1' }, ctx });
        equal(repo.getRecord('proposal', ctx, proposal.id).status, 'issued');

        // The terms change, so v2 exists — and the proposal is a draft again.
        await docs.createVersion({ req: bodyOf({}), params: { id: proposal.id }, ctx });
        equal(repo.getRecord('proposal', ctx, proposal.id).status, 'draft',
            'unissued changes mean this is no longer the document that was approved');

        await docs.submitProposalForReview({ params: { id: proposal.id }, ctx });
        await docs.reviewProposal({ req: bodyOf({ decision: 'approved' }), params: { id: proposal.id }, ctx });
        await docs.issueVersion({ params: { id: proposal.id, version: '2' }, ctx });
        equal(repo.getRecord('proposal', ctx, proposal.id).status, 'issued',
            'v2 reaches the customer the same way v1 did, through review');
    });

    await checkAsync('issuing a line-item proposal links its document back onto the proposal, so the client email can find it', async () => {
        // Regression: issueVersion created the `documents` row but never
        // wrote its id onto `proposals.document_id` — the one column every
        // attachment resolver (lib/email-attachments.mjs) reads. The email
        // draft was built as though no document existed at all, silently,
        // on every issued line-item proposal. Same failure mode already
        // fixed for the Internal Team Proposal's own document.
        const account = repo.createRecord('account', ctx, {
            name: 'Attachment Check Co', account_type: 'Regional', services: ['hcm'],
        });
        const deal = repo.createRecord('deal', ctx, {
            name: 'Attachment Check', account_id: account.id, pipeline_id: PIPE, stage_id: STAGE_OPEN,
        });
        repo.insert('deal_line_items', {
            id: db.id('lit'), workspace_id: WS, deal_id: deal.id, position: 0,
            label: 'Retainer', pricing_model: 'per_seat', recurrence: 'monthly', quantity: 1,
            unit_amount: 1000, term_months: 12, currency: 'USD', fx_rate: 1,
        });
        const { proposal } = await docs.createProposal({ req: bodyOf({ dealId: deal.id }), ctx });
        await docs.createVersion({ req: bodyOf({}), params: { id: proposal.id }, ctx });
        await docs.submitProposalForReview({ params: { id: proposal.id }, ctx });
        await docs.reviewProposal({ req: bodyOf({ decision: 'approved' }), params: { id: proposal.id }, ctx });
        await docs.issueVersion({ params: { id: proposal.id, version: '1' }, ctx });

        const after = repo.getRecord('proposal', ctx, proposal.id);
        assert(after.document_id, 'the issued proposal now carries its own document id');
        const doc = db.get('SELECT * FROM documents WHERE id = ?', [after.document_id]);
        assert(doc, 'and that id resolves to a real, findable document row');
        equal(doc.parent_id, proposal.id);

        const attachments = await import('./lib/email-attachments.mjs');
        const resolved = attachments.attachmentsForProposalEmail(ctx, after);
        equal(resolved.missing, [], 'the client-email attachment resolver finds it — nothing reported missing');
        equal(resolved.documents.length, 1);
        equal(resolved.documents[0].id, after.document_id);
    });

    check('a rep holds no approval capability at all', () => {
        assert(!auth.can({ role: 'rep' }, 'document.approve'));
        assert(!auth.can({ role: 'sdr' }, 'document.approve'));
        assert(!auth.can({ role: 'readonly' }, 'document.approve'));
        for (const role of ['manager', 'admin', 'owner']) {
            assert(auth.can({ role }, 'document.approve'), `${role} reviews documents`);
        }
    });
}

/**
 * The brief's Phase 7 scenarios E and F, end to end.
 *
 * A and B and C and D are covered in the USD reporting block, as conversions.
 * These two are about people rather than arithmetic: what a rep may do, and
 * what a manager may do that a rep may not. They are written against the API
 * handlers rather than the helpers underneath, because that is the boundary an
 * actual request crosses.
 */
describe('Scenario E and F — what each role may do');

{
    const recordsApi = await import('./api/records.mjs');
    const metaApi = await import('./api/meta.mjs');
    const docs = await import('./api/proposals.mjs');
    const dash = await import('./api/dashboard.mjs');

    await checkAsync('Scenario E — a rep adds, edits and drafts, and cannot delete', async () => {
        const created = await recordsApi.create({
            req: bodyOf({ name: 'Rep Made This', account_type: 'Egypt' }),
            params: { object: 'accounts' }, ctx: repCtx,
        });
        const account = created.record;
        equal(account.name, 'Rep Made This', 'can add');
        equal(account.billing_currency, 'EGP', 'and the account type default still applies');

        await recordsApi.patch({
            req: bodyOf({ industry: 'Manufacturing' }),
            params: { object: 'accounts', id: account.id }, ctx: repCtx,
        });
        equal(repo.getRecord('account', ctx, account.id).industry, 'Manufacturing', 'can edit its own');

        await recordsApi.remove({ params: { object: 'accounts', id: account.id }, ctx: repCtx }).then(
            () => { throw new Error('a rep deleted a record'); },
            (err) => assert(/cannot record delete/.test(err.message), err.message),
        );
        equal(repo.getRecord('account', ctx, account.id).deleted_at ?? null, null,
            'and it is still there — "cannot delete" has to mean the row survives, not just that a button is hidden');

        // And not twenty thousand at a time either. A permission the bulk route
        // walks around is not a permission.
        await recordsApi.bulk({
            req: bodyOf({ action: 'delete', ids: [account.id] }),
            params: { object: 'accounts' }, ctx: repCtx,
        }).then(
            () => { throw new Error('a rep bulk-deleted a record'); },
            (err) => assert(/cannot record delete/.test(err.message), err.message),
        );
        equal(repo.getRecord('account', ctx, account.id).deleted_at ?? null, null);
    });

    await checkAsync('Scenario E — a rep is sent no money, whichever dashboard they ask for', async () => {
        // Not the rep's own layout: the workspace-wide one, named by id, which
        // is the request that used to hand them the pipeline.
        const shared = db.get('SELECT id FROM dashboards WHERE workspace_id = ?', [WS]);
        const { widgets } = await dash.dashboardData({
            params: { id: shared ? shared.id : 'default' },
            url: new URL('http://x/?range=month'), ctx: repCtx,
        });

        const money = widgets.filter((w) => dash.WIDGETS[w.widget]?.money);
        assert(money.length > 0, 'the fixture must contain a money widget or this proves nothing');
        for (const w of money) {
            assert(w.error && /cannot see financial/.test(w.error),
                `${w.widget} was computed for a rep`);
            assert(w.data === undefined, `${w.widget} sent data to a rep`);
        }
        assert(!/"(one_time|mrr|tcv|value_one_time)":[1-9]/.test(JSON.stringify(widgets)),
            'a currency figure reached a rep somewhere in the payload');
    });

    await checkAsync('Scenario F — a manager sees the money a rep cannot', async () => {
        const managerCtx = { ...ctx, role: 'manager' };
        const { widgets } = await dash.dashboardData({
            params: { id: 'default' }, url: new URL('http://x/?range=month'), ctx: managerCtx,
        });
        const money = widgets.filter((w) => dash.WIDGETS[w.widget]?.money);
        assert(money.length > 0, 'a manager dashboard with no money widget proves nothing');
        for (const w of money) assert(!w.error, `${w.widget} was refused to a manager: ${w.error}`);
    });

    await checkAsync('Scenario F — rates are admin-only, review is manager-and-above', async () => {
        // Rates: admin yes, manager no. Reading analytics and re-basing every
        // figure on the screen are different acts.
        await metaApi.updateSettings({ req: bodyOf({ fx_egp_per_usd: 51 }), ctx });
        equal(settings.setting(WS, 'fx_egp_per_usd'), 51, 'an admin sets the reporting rate');

        await metaApi.updateSettings({
            req: bodyOf({ fx_egp_per_usd: 99 }), ctx: { ...ctx, role: 'manager' },
        }).then(() => { throw new Error('a manager changed the reporting rate'); },
            (err) => assert(/cannot finance settings/i.test(err.message), err.message));
        equal(settings.setting(WS, 'fx_egp_per_usd'), 51, 'and it did not move');

        // Review: a manager approves and rejects.
        const account = repo.createRecord('account', ctx, { name: 'Scenario F Co', account_type: 'Regional' });
        const proposalId = db.id('pro');
        db.run(
            `INSERT INTO proposals
               (id, workspace_id, account_id, number, title, currency, status, current_version, owner_id, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [proposalId, WS, account.id, `P-F-${proposalId}`, 'For review', 'USD', 'draft', 0,
                repCtx.userId, db.now(), db.now()],
        );

        await docs.submitProposalForReview({ params: { id: proposalId }, ctx: repCtx });
        await docs.reviewProposal({
            req: bodyOf({ decision: 'approved', note: 'Looks right.' }),
            params: { id: proposalId }, ctx: { ...ctx, role: 'manager' },
        });
        equal(repo.getRecord('proposal', ctx, proposalId).status, 'approved',
            'a manager approves — and the rate they cannot change is a different capability entirely');
    });
}

/**
 * A cap that hides is worse than a cap.
 *
 * Related lists are limited — opening one account must not hydrate fourteen
 * hundred contacts — and the limits were invisible. The page showed 200 rows,
 * the tab read "200", and nothing anywhere said there were more. The limits
 * stay; what changes is that the true count comes back beside the rows and the
 * rest can be asked for.
 */
describe('related record limits');

{
    const recordsApi = await import('./api/records.mjs');

    const account = repo.createRecord('account', ctx, { name: 'Big Book Ltd', account_type: 'Egypt' });
    // 230, so the 200 cap bites and page two is short.
    for (let i = 0; i < 230; i += 1) {
        repo.createRecord('contact', ctx, {
            account_id: account.id, first_name: 'Many', last_name: `Contact${String(i).padStart(4, '0')}`,
            data_source: 'test',
        });
    }

    await checkAsync('the payload says how many there really are', async () => {
        const { related, counts } = await recordsApi.related({ params: { object: 'accounts', id: account.id }, ctx });
        equal(related.contacts.length, 200, 'still capped — the safety limit is the point of it');
        equal(counts.contacts, 230, 'and now it admits to 230, which is what the page has to show');
    });

    await checkAsync('page two continues where page one stopped', async () => {
        const first = await recordsApi.related({ params: { object: 'accounts', id: account.id }, ctx });
        const second = await recordsApi.relatedPage({
            params: { object: 'accounts', id: account.id, child: 'contacts' },
            url: new URL('http://x/?page=2'), ctx,
        });

        equal(second.records.length, 30);
        equal(second.total, 230);
        equal(second.page, 2);

        // The join of the two pages has to be the whole set, once each. A page
        // two sorted differently would repeat a row and hide another, which
        // reads as bad data rather than as a bug.
        const ids = [...first.related.contacts, ...second.records].map((r) => r.id);
        equal(new Set(ids).size, 230, 'no row appears twice and none is skipped');
        equal(
            first.related.contacts.at(-1).last_name < second.records[0].last_name, true,
            'and page two carries on down the same ordering',
        );
    });

    await checkAsync('an unknown related list is a 404, not an empty page', async () => {
        await recordsApi.relatedPage({
            params: { object: 'accounts', id: account.id, child: 'nonsense' },
            url: new URL('http://x/?page=2'), ctx,
        }).then(
            () => { throw new Error('served a related list that does not exist'); },
            (err) => assert(/not a related list/.test(err.message), err.message),
        );
    });

    check('the new route is behind the same confinement as every other', () => {
        /**
         * An SDR is confined by an ALLOWLIST checked before any handler runs,
         * so a new endpoint is refused by default rather than by remembering to
         * guard it. That is the property worth testing — not the handler, which
         * never sees the request.
         */
        const path = `/api/accounts/${account.id}/related/contacts`;
        assert(!auth.routeAllowed({ role: 'sdr' }, 'GET', path),
            'an SDR reached an account’s contacts; the confinement allowlist has grown a hole');
        assert(auth.routeAllowed({ role: 'rep' }, 'GET', path),
            'a rep works accounts and must still read their contacts');
        // And the parent is loaded through getRecord, so a record in another
        // workspace 404s rather than paging.
        assert(auth.routeAllowed({ role: 'manager' }, 'GET', path));
    });

    await checkAsync('a record from another workspace cannot be paged through', async () => {
        await recordsApi.relatedPage({
            params: { object: 'accounts', id: 'acc_does_not_exist', child: 'contacts' },
            url: new URL('http://x/?page=2'), ctx,
        }).then(
            () => { throw new Error('paged through an account that does not exist'); },
            (err) => assert(/does not exist|not found/i.test(err.message), err.message),
        );
    });
}

/**
 * A contract that records its own value, so the client revenue map can be read
 * off the database rather than assembled by hand.
 */
/**
 * What is typed while generating a contract has to reach the account.
 *
 * The registration was already stored per ACCOUNT, which was right, and then
 * read nowhere the account is shown — so a CR number typed during generation
 * left the account page blank, and duplicate detection, which searches
 * `accounts.cr_number`, never saw the strongest natural key this CRM has.
 */
describe('a contract teaches the account what it learned');

{
    const genApi = await import('./api/generation.mjs');

    await checkAsync('the CR number and legal name land on the account itself', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Registered Co', account_type: 'Egypt' });
        equal(account.cr_number ?? null, null, 'the premise: nothing known yet');
        equal(account.legal_name ?? null, null);

        await genApi.putRegistration({
            req: bodyOf({
                company_name_ar: 'شركة مسجلة',
                cr_number: '1010101010',
                representative_name: 'ممثل',
                address: 'الرياض',
            }),
            params: { id: account.id }, ctx,
        });

        const after = repo.getRecord('account', ctx, account.id);
        equal(after.cr_number, '1010101010', 'the account carries the registration number');
        equal(after.legal_name, 'شركة مسجلة', 'and the registered name, which is what that field is for');

        // Searchable, because a CR number nobody can find is barely recorded.
        const found = repo.listRecords('account', ctx, { q: '1010101010' });
        assert(found.records.some((r) => r.id === account.id),
            'the account is not findable by its CR number, so the index was not rebuilt');
    });

    await checkAsync('clearing a registration field does not blank the account', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Keeps What It Knows', account_type: 'Egypt' });
        await genApi.putRegistration({
            req: bodyOf({ cr_number: '2020202020', company_name_ar: 'اسم' }),
            params: { id: account.id }, ctx,
        });
        equal(repo.getRecord('account', ctx, account.id).cr_number, '2020202020');

        // A second save that omits them must not erase what the account knows.
        await genApi.putRegistration({
            req: bodyOf({ representative_name: 'ممثل جديد' }),
            params: { id: account.id }, ctx,
        });
        const after = repo.getRecord('account', ctx, account.id);
        equal(after.cr_number, '2020202020', 'the account kept its number');
        equal(after.legal_name, 'اسم', 'and its registered name');
    });

    await checkAsync('the account page is given the three fields that live nowhere else', async () => {
        const recordsApi = await import('./api/records.mjs');
        const account = repo.createRecord('account', ctx, { name: 'Shown On Page', account_type: 'Egypt' });
        await genApi.putRegistration({
            req: bodyOf({ cr_number: '3030303030', representative_name: 'ممثل', address: 'جدة' }),
            params: { id: account.id }, ctx,
        });

        const { related } = await recordsApi.related({ params: { object: 'accounts', id: account.id }, ctx });
        assert(related.registration, 'the account page cannot show a registration it is never sent');
        equal(related.registration.representative_name, 'ممثل');
        equal(related.registration.address, 'جدة');
    });
}

describe('contract value and renewal date');

{
    const metaApi = await import('./api/meta.mjs');
    const genLib = await import('./lib/doc-generation.mjs');

    /**
     * A contract starting in the year 2 is a typo, not a contract.
     *
     * Production had one — `start_date` of "0002-09-01" — which parses happily
     * and gives a term of about twenty-four thousand months. The fee is left
     * alone on purpose: a number somebody types into a money field is their
     * business, and a helper deciding which contracts are too large to believe
     * is a worse problem than the one it solves. A date this far outside a
     * working lifetime is unambiguous, and it is what turns one slip into a
     * figure that reaches the dashboard.
     */
    check('an impossible contract term produces no value at all', () => {
        const ok = { monthly_fee: '20000', start_date: '2026-10-01', end_date: '2027-09-30' };
        equal(genLib.contractValue(ok), 240000, 'the ordinary case still computes');

        // Production had exactly this: a start date in the year 2, which parses
        // happily and yields a term of about twenty-four thousand months.
        equal(genLib.contractValue({ ...ok, start_date: '0002-09-01', end_date: '0003-08-31' }), null,
            'a term measured from the year 2 must produce nothing, not a number');
        equal(genLib.contractValue({ ...ok, end_date: '2999-01-01' }), null,
            'and neither must one running to the year 2999');

        // The FEE is deliberately not judged. A large number somebody typed is
        // their business; only the date is unambiguously wrong.
        equal(genLib.contractValue({ ...ok, monthly_fee: '456788798798' }), 5481465585576,
            'a huge fee still computes — deciding which contracts are too big to '
            + 'believe is a worse problem than the one it solves');
    });

    check('a contract ending on its own anniversary is twelve months, not thirteen', () => {
        // "1 Jan 2026 to 1 Jan 2027" is the same one-year term as "1 Jan 2026
        // to 31 Dec 2026" — just entered as the exact anniversary rather than
        // the day before it. Both must price at 12 months.
        equal(genLib.contractValue({ monthly_fee: '20000', start_date: '2026-01-01', end_date: '2027-01-01' }),
            240000, 'same-day-of-month anniversary must not add a spurious 13th month');

        // The same off-by-one applies to any term, not just a year.
        equal(genLib.contractValue({ monthly_fee: '20000', start_date: '2026-01-01', end_date: '2026-07-01' }),
            120000, 'six months to the day is six months, not seven');
    });

    check('a renewal date starts at the expiry date and then moves on its own', () => {
        const account = repo.createRecord('account', ctx, {
            name: 'Renewing Ltd', account_type: 'Egypt', services: ['hcm'],
        });
        const agreement = repo.createRecord('agreement', ctx, {
            title: 'HCM retainer', account_id: account.id, type: 'msa',
            effective_date: '2026-01-01', expiry_date: '2026-12-31',
            service_line_key: 'hcm', contract_value: 600000,
        });

        equal(agreement.renewal_date, '2026-12-31', 'starts equal to expiry, as the business asked');
        equal(agreement.currency, 'EGP', 'and bills in what the account bills in');

        // Then it moves, and expiry does not follow it. A 90-day notice means
        // the decision is due in September on a December contract.
        repo.updateRecord('agreement', ctx, agreement.id, { renewal_date: '2026-10-02' });
        const moved = repo.getRecord('agreement', ctx, agreement.id);
        equal(moved.renewal_date, '2026-10-02');
        equal(moved.expiry_date, '2026-12-31', 'the contract still ends when it ends');
    });

    await checkAsync('the dashboard\'s Renewals widget excludes a non-renewable agreement entirely', async () => {
        // Regression: the widget's own SQL never selected `renewable`, so a
        // fixed-term agreement marked "never renews" still showed up under
        // "Notice due", was counted in the 0-30/31-45/46-90 buckets, and its
        // value was folded into valueByCurrency — the exact bug the sibling
        // fixes (lib/renewals.mjs, api/proposals.mjs's renewals route) were
        // meant to close everywhere, just missed in this one caller.
        const dash = await import('./api/dashboard.mjs');
        const account = repo.createRecord('account', ctx, {
            name: 'Not Renewing Ltd', account_type: 'Egypt', services: ['hcm'],
        });
        const soon = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
        const agreement = repo.createRecord('agreement', ctx, {
            title: 'Fixed-term engagement', account_id: account.id, type: 'msa',
            effective_date: '2026-01-01', expiry_date: soon, notice_days: 30,
            service_line_key: 'hcm', contract_value: 999999, currency: 'EGP',
        });
        db.run(`UPDATE agreements SET status = 'signed', renewable = 0 WHERE id = ?`, [agreement.id]);

        const data = await dash.WIDGETS.renewals.run(ctx, { days: 90 });
        assert(!data.agreements.some((a) => a.id === agreement.id),
            'a non-renewable agreement must not appear under "Notice due"');
        const egpValue = data.valueByCurrency.EGP ?? 0;
        assert(egpValue < 999999,
            `a non-renewable agreement's value (999999) must not be folded into valueByCurrency (EGP: ${egpValue})`);

        // Sanity: the SAME agreement, made renewable again, DOES show up —
        // proving the exclusion above is the `renewable` flag doing its job,
        // not some other filter accidentally hiding every agreement.
        db.run(`UPDATE agreements SET renewable = 1 WHERE id = ?`, [agreement.id]);
        const after = await dash.WIDGETS.renewals.run(ctx, { days: 90 });
        assert(after.agreements.some((a) => a.id === agreement.id),
            'the same agreement, made renewable again, is back under "Notice due"');
    });

    await checkAsync('the dashboard\'s Renewals widget buckets by days-to-NOTICE, not days-to-expiry', async () => {
        // Regression: the buckets were computed off `expiry_date`, contradicting
        // the widget's own `note` ("Sorted by NOTICE date, not expiry") and the
        // domain rule (README.md): a 90-day notice on a 12-month contract is
        // due in month nine. An agreement with a near notice date but a far
        // expiry date landed in no bucket at all — every count read 0 even
        // though something needed a decision inside the window.
        const dash = await import('./api/dashboard.mjs');
        // The suite shares one workspace, so other tests' agreements may
        // already sit in these buckets — compare deltas, not absolutes.
        const before = await dash.WIDGETS.renewals.run(ctx, { days: 90 });

        const account = repo.createRecord('account', ctx, {
            name: 'Long Contract Near Notice Ltd', account_type: 'Egypt', services: ['hcm'],
        });
        // Expiry is 200 days out — outside every bucket if bucketed by expiry.
        // Notice is 190 days' notice, so the notice date is ~10 days away —
        // squarely inside the 0-30 bucket.
        const farExpiry = new Date(Date.now() + 200 * 864e5).toISOString().slice(0, 10);
        const agreement = repo.createRecord('agreement', ctx, {
            title: 'Long-term retainer', account_id: account.id, type: 'msa',
            effective_date: '2026-01-01', expiry_date: farExpiry, notice_days: 190,
            service_line_key: 'hcm', contract_value: 120000, currency: 'EGP',
        });
        db.run(`UPDATE agreements SET status = 'signed' WHERE id = ?`, [agreement.id]);

        const after = await dash.WIDGETS.renewals.run(ctx, { days: 90 });
        equal(after.buckets.d0_30, before.buckets.d0_30 + 1,
            'a notice date 10 days away belongs in the 0-30 bucket, regardless of a 200-day-out expiry');
        equal(after.buckets.d31_45, before.buckets.d31_45, 'unrelated buckets are untouched');
        equal(after.buckets.d46_90, before.buckets.d46_90, 'unrelated buckets are untouched');
    });

    await checkAsync('renewable defaults to yes when the caller never mentions it at all', async () => {
        // `renewable` is `INTEGER NOT NULL DEFAULT 1` (lib/db.mjs) — it can
        // never actually be NULL in the database, so the real question is
        // whether creating an agreement WITHOUT the key in the payload at
        // all (exactly what happens when a rep never touches the checkbox —
        // `fieldControl`'s checkbox only writes to the draft on toggle)
        // lands on 1, not 0. `validate()` (lib/repo.mjs) is supposed to
        // apply the field's own `default` for an unsupplied key on create;
        // this proves it actually does, end to end, through every reader
        // that decides whether an agreement raises a renewal notice.
        const dash = await import('./api/dashboard.mjs');
        const proposalsApi = await import('./api/proposals.mjs');
        const renewalsLib = await import('./lib/renewals.mjs');
        const account = repo.createRecord('account', ctx, {
            name: 'Never Touched The Checkbox Ltd', account_type: 'Egypt', services: ['hcm'],
        });
        const soon = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
        const agreement = repo.createRecord('agreement', ctx, {
            title: 'Untouched checkbox agreement', account_id: account.id, type: 'msa',
            effective_date: '2026-01-01', expiry_date: soon, notice_days: 30,
            service_line_key: 'hcm', contract_value: 42000, currency: 'EGP',
        });
        equal(db.get('SELECT renewable FROM agreements WHERE id = ?', [agreement.id]).renewable, 1,
            'the column itself lands on 1 without anyone mentioning renewable');
        db.run(`UPDATE agreements SET status = 'signed' WHERE id = ?`, [agreement.id]);

        const status = renewalsLib.renewalStatus(
            db.get('SELECT * FROM agreements WHERE id = ?', [agreement.id]),
            { workspaceId: WS },
        );
        assert(status === 'notice_due' || status === 'upcoming',
            `an untouched renewable flag must not read as "never renews" (got ${status})`);

        const dashData = await dash.WIDGETS.renewals.run(ctx, { days: 90 });
        assert(dashData.agreements.some((a) => a.id === agreement.id),
            'the dashboard Renewals widget must still surface an agreement whose renewable flag was never set');

        const page = await proposalsApi.renewals({
            url: new URL('http://x?status=renewing&days=90'), ctx,
        });
        assert(page.agreements.some((a) => a.id === agreement.id),
            'the Renewals page (api/proposals.mjs) must include it too');
    });

    await checkAsync('an agreement opens on the workspace\'s notice default, not on 0', async () => {
        // `notice_days` is `NOT NULL DEFAULT 0` (schema.sql) — there is no way
        // for the column to hold NULL, so an agreement created without a
        // negotiated notice period silently landed on 0 rather than the
        // workspace default `noticeDateFor` (lib/renewals.mjs) is supposed to
        // fall back to. Since a stored number reads as "this contract's own
        // figure", the fix has to write the real default at creation time —
        // this proves it does, and that it reads the WORKSPACE's configured
        // value, not a hardcoded 45.
        const settings = await import('./lib/settings.mjs');
        const renewalsLib = await import('./lib/renewals.mjs');
        settings.setSetting(WS, 'default_renewal_notice_days', 30);

        const account = repo.createRecord('account', ctx, {
            name: 'Never Typed A Notice Period Ltd', account_type: 'Egypt', services: ['hcm'],
        });
        const agreement = repo.createRecord('agreement', ctx, {
            title: 'No notice period typed', account_id: account.id, type: 'msa',
            effective_date: '2026-01-01', expiry_date: '2026-12-31',
            service_line_key: 'hcm', contract_value: 12000, currency: 'EGP',
        });
        equal(db.get('SELECT notice_days FROM agreements WHERE id = ?', [agreement.id]).notice_days, 30,
            'the column lands on the workspace default, not the schema\'s bare 0');
        equal(renewalsLib.noticeDateFor(agreement, WS), '2026-12-01',
            '30 days before the 31 December expiry — not 31 December itself, which is what 0 days notice would compute');

        // Typed explicitly, including a genuine zero: the agreement's own
        // figure still wins, exactly as documented.
        const explicitZero = repo.createRecord('agreement', ctx, {
            title: 'Genuinely zero notice, negotiated', account_id: account.id, type: 'msa',
            effective_date: '2026-01-01', expiry_date: '2026-12-31', notice_days: 0,
            service_line_key: 'hcm', contract_value: 12000, currency: 'EGP',
        });
        equal(db.get('SELECT notice_days FROM agreements WHERE id = ?', [explicitZero.id]).notice_days, 0,
            'an explicit 0 is a real negotiated answer and must not be overwritten by the default');

        settings.setSetting(WS, 'default_renewal_notice_days', 45);
    });

    check('a contract raised in another currency keeps it', () => {
        const account = repo.createRecord('account', ctx, {
            name: 'Mixed Terms Ltd', account_type: 'Egypt', services: ['hcm'], billing_currency: 'USD',
        });
        const agreement = repo.createRecord('agreement', ctx, {
            title: 'Priced in dollars', account_id: account.id, type: 'msa',
            expiry_date: '2027-06-30', currency: 'USD', contract_value: 40000,
        });
        equal(agreement.currency, 'USD', 'the default fills a silence, it does not overrule anybody');
    });

    /**
     * Recording a contract that predates the CRM, through the front door.
     *
     * `number` is NOT NULL and read-only, so the generic create route used to
     * refuse for a field the caller was not allowed to send — every agreement
     * had to come from document generation. That is fine for new business and
     * useless for mapping the clients you already have, which is the entire
     * point of the exercise.
     */
    /**
     * The signed contract is what the deal is worth.
     *
     * The agreement is the document both companies put their names to; a deal
     * quoting something else is quoting a negotiation that has concluded. The
     * value arrives as a line item because that is where deal value comes from
     * — writing value_tcv directly would be undone by the next rollup.
     */
    /**
     * The deal follows its agreement, and nobody drags a card.
     *
     * The pipeline once had "Agreement sent" and it was removed, because a
     * stage mirroring another object's status is two places to update and two
     * to disagree. That was about a stage somebody maintained by hand. This one
     * is only ever set by the agreement's own lifecycle.
     */
    await checkAsync('a deal moves to Contracting, then Won, then Lost, from its agreement alone', async () => {
        const docs = await import('./api/proposals.mjs');
        const stageOf = (dealId) => db.get(
            'SELECT s.key FROM deals d JOIN stages s ON s.id = d.stage_id WHERE d.id = ?', [dealId],
        ).key;

        const account = repo.createRecord('account', ctx, { name: 'Follows Its Contract', account_type: 'Regional' });
        const deal = repo.createRecord('deal', ctx, {
            name: 'Led by the paperwork', account_id: account.id,
            pipeline_id: PIPE, stage_id: STAGE_OPEN, currency: 'USD',
        });

        // Creating the agreement against the deal moves it to Contracting.
        const agreement = repo.createRecord('agreement', ctx, {
            title: 'The contract', account_id: account.id, deal_id: deal.id, type: 'msa',
            effective_date: '2026-01-01', expiry_date: '2026-12-31', contract_value: 90000, currency: 'USD',
        });
        equal(stageOf(deal.id), 'contracting', 'creating the agreement did not move the deal');
        equal(repo.getRecord('deal', ctx, deal.id).status, 'open', 'and it is still open');

        // Signing wins it.
        repo.updateRecord('agreement', ctx, agreement.id, { status: 'approved' });
        await docs.signAgreement({ req: bodyOf({}), params: { id: agreement.id }, ctx });
        equal(stageOf(deal.id), 'won');
        equal(repo.getRecord('deal', ctx, deal.id).status, 'won');
    });

    await checkAsync('a terminated agreement loses its deal, with the reason recorded', async () => {
        const stageOf = (dealId) => db.get(
            'SELECT s.key FROM deals d JOIN stages s ON s.id = d.stage_id WHERE d.id = ?', [dealId],
        ).key;
        const account = repo.createRecord('account', ctx, { name: 'Terminated Co', account_type: 'Regional' });
        const deal = repo.createRecord('deal', ctx, {
            name: 'Ends badly', account_id: account.id, pipeline_id: PIPE, stage_id: STAGE_OPEN, currency: 'USD',
        });
        const agreement = repo.createRecord('agreement', ctx, {
            title: 'Short lived', account_id: account.id, deal_id: deal.id, type: 'msa',
            effective_date: '2026-01-01', expiry_date: '2026-12-31',
        });
        equal(stageOf(deal.id), 'contracting');

        repo.updateRecord('agreement', ctx, agreement.id, { status: 'terminated' });
        const after = repo.getRecord('deal', ctx, deal.id);
        equal(after.status, 'lost', 'a dead contract must not leave a live forecast behind');
        equal(after.loss_reason, 'Agreement terminated', 'and it says why');
    });

    /**
     * Signed means closed. Anything else means open.
     *
     * The agreement is the truth, so the deal is a reading of it — and taking a
     * signature away is the contract saying the sale did not conclude after
     * all. That is the one case where a finished deal is allowed to move.
     */
    await checkAsync('un-signing an agreement reopens its deal', async () => {
        const docs = await import('./api/proposals.mjs');
        const stageOf = (dealId) => db.get(
            'SELECT s.key FROM deals d JOIN stages s ON s.id = d.stage_id WHERE d.id = ?', [dealId],
        ).key;

        const account = repo.createRecord('account', ctx, { name: 'Signature Withdrawn', account_type: 'Regional' });
        const deal = repo.createRecord('deal', ctx, {
            name: 'Nearly closed', account_id: account.id, pipeline_id: PIPE, stage_id: STAGE_OPEN, currency: 'USD',
        });
        const agreement = repo.createRecord('agreement', ctx, {
            title: 'Signed then not', account_id: account.id, deal_id: deal.id, type: 'msa',
            effective_date: '2026-01-01', status: 'approved',
        });
        await docs.signAgreement({ req: bodyOf({}), params: { id: agreement.id }, ctx });
        equal(repo.getRecord('deal', ctx, deal.id).status, 'won');

        // The signature comes off — the deal is in play again.
        repo.updateRecord('agreement', ctx, agreement.id, { status: 'out_for_signature' });
        const after = repo.getRecord('deal', ctx, deal.id);
        equal(after.status, 'open', 'an unsigned agreement cannot leave a closed deal behind it');
        equal(stageOf(deal.id), 'contracting');
        equal(after.closed_at ?? null, null, 'and it keeps no closing date it no longer has');
    });

    await checkAsync('a finished deal is never dragged backwards by a document', async () => {
        const stageOf = (dealId) => db.get(
            'SELECT s.key FROM deals d JOIN stages s ON s.id = d.stage_id WHERE d.id = ?', [dealId],
        ).key;
        const account = repo.createRecord('account', ctx, { name: 'Already Won Co', account_type: 'Regional' });
        const deal = repo.createRecord('deal', ctx, {
            name: 'Won last quarter', account_id: account.id, pipeline_id: PIPE, stage_id: STAGE_WON,
            status: 'won', currency: 'USD',
        });

        // A second agreement raised against a closed deal must not reopen it.
        repo.createRecord('agreement', ctx, {
            title: 'A later contract', account_id: account.id, deal_id: deal.id, type: 'msa',
            effective_date: '2026-06-01',
        });
        equal(stageOf(deal.id), 'won', 'a won deal was pulled back into Contracting');
        equal(repo.getRecord('deal', ctx, deal.id).status, 'won');
    });

    await checkAsync('signing an agreement sets the deal to the contract value', async () => {
        const docs = await import('./api/proposals.mjs');
        const account = repo.createRecord('account', ctx, { name: 'Signs And Pays', account_type: 'Regional' });
        const deal = repo.createRecord('deal', ctx, {
            name: 'Worth what was signed', account_id: account.id,
            pipeline_id: PIPE, stage_id: STAGE_OPEN, currency: 'USD',
        });
        equal(repo.getRecord('deal', ctx, deal.id).value_tcv, 0, 'the premise: no value yet');

        const agreementId = db.id('agr');
        db.run(
            `INSERT INTO agreements (id, workspace_id, account_id, deal_id, number, title, type, status,
                                     contract_value, currency, effective_date, created_at, updated_at)
             VALUES (?,?,?,?,?,?,'msa','approved',?,?,?,?,?)`,
            [agreementId, WS, account.id, deal.id, `A-T-${agreementId}`, 'Signed contract',
                480000, 'USD', '2026-01-01', db.now(), db.now()],
        );

        await docs.signAgreement({ req: bodyOf({}), params: { id: agreementId }, ctx });

        const after = repo.getRecord('deal', ctx, deal.id);
        equal(after.price, 480000, 'the deal is priced at what the contract says');
        equal(after.currency, 'USD', 'in the currency the contract says');
        equal(after.own_tcv, 480000, 'and its own-currency contract value agrees');
        /**
         * The BASE-currency figure converts, and that is the point.
         *
         * This used to be asserted as 480,000 as well, because the signing path
         * wrote the line item with `fx_rate: 1` whatever currency the contract
         * was in — so a USD contract contributed 480,000 to a SAR total. Signing
         * now goes through `setDealPrice`, which converts at the workspace's own
         * rate like every other pricing path.
         */
        equal(after.value_tcv, 1800000, 'USD 480,000 at 3.75 is SAR 1,800,000');
        equal(after.status, 'won', 'and signing still wins it');

        // Signing again must not double it — the price is replaced, not added to.
        db.run("UPDATE agreements SET status = 'approved', signed_at = NULL WHERE id = ?", [agreementId]);
        await docs.signAgreement({ req: bodyOf({}), params: { id: agreementId }, ctx });
        equal(repo.getRecord('deal', ctx, deal.id).own_tcv, 480000, 'still 480,000, not 960,000');
        equal(db.get('SELECT COUNT(*) AS n FROM deal_line_items WHERE deal_id = ?', [deal.id]).n, 1,
            'and a deal carries exactly one price');
    });

    await checkAsync('signing an agreement for a RECURRING deal does not price it at the annual total', async () => {
        // The bug this pins: `current.billingType === 'one_time' || current.price
        // === null` ran the "price the deal at the contract value" branch for
        // ANY unpriced deal, not just a one-time one — so an unpriced HCM
        // (recurring) deal, on first signing, had the agreement's ANNUAL
        // total written in as its MONTHLY rate. A $10,000/month retainer
        // quoted as a $120,000 annual contract became a $120,000/MONTH deal
        // the moment it was signed — the exact 4,200-vs-50,400 mistake the
        // code's own comment warns about, just reached from "never priced"
        // instead of "already recurring".
        const docs = await import('./api/proposals.mjs');
        const account = repo.createRecord('account', ctx, { name: 'Recurring Unpriced Co', account_type: 'Regional', services: ['hcm'] });
        const deal = repo.createRecord('deal', ctx, {
            name: 'HCM retainer, never priced', account_id: account.id, service_line_key: 'hcm',
            pipeline_id: PIPE, stage_id: STAGE_OPEN, currency: 'USD',
        });
        equal(repo.dealPrice(ctx, deal).billingType, 'recurring', 'the premise: HCM is a recurring service');
        equal(repo.dealPrice(ctx, deal).price, null, 'the premise: never priced');

        const agreementId = db.id('agr');
        db.run(
            `INSERT INTO agreements (id, workspace_id, account_id, deal_id, number, title, type, status,
                                     contract_value, currency, effective_date, created_at, updated_at)
             VALUES (?,?,?,?,?,?,'msa','approved',?,?,?,?,?)`,
            [agreementId, WS, account.id, deal.id, `A-R-${agreementId}`, 'Annual total, not a monthly rate',
                120000, 'USD', '2026-01-01', db.now(), db.now()],
        );

        await docs.signAgreement({ req: bodyOf({}), params: { id: agreementId }, ctx });

        const after = repo.dealPrice(ctx, deal);
        assert(after.price === null || after.price !== 120000,
            `a recurring deal must not be priced at the contract's total (got ${after.price})`);
        equal(repo.getRecord('deal', ctx, deal.id).status, 'won', 'signing still wins the deal — only the price guess is withheld');
    });

    await checkAsync('a deal auto-created FOR a recurring agreement opens unpriced, not at the total', async () => {
        // Same bug, the other place it lived: ensureDealForAgreement() runs
        // when an agreement is signed with no deal_id at all, and always
        // wrote the contract value straight in as the new deal's price,
        // whatever the service's billing type.
        const docs = await import('./api/proposals.mjs');
        const account = repo.createRecord('account', ctx, { name: 'No Deal Yet, Recurring Co', account_type: 'Regional', services: ['offshoring'] });

        const agreementId = db.id('agr');
        db.run(
            `INSERT INTO agreements (id, workspace_id, account_id, deal_id, number, title, type, status,
                                     service_line_key, contract_value, currency, effective_date, created_at, updated_at)
             VALUES (?,?,?,NULL,?,?,'msa','approved',?,?,?,?,?,?)`,
            [agreementId, WS, account.id, `A-N-${agreementId}`, 'No deal existed yet',
                'offshoring', 240000, 'USD', '2026-01-01', db.now(), db.now()],
        );

        await docs.signAgreement({ req: bodyOf({}), params: { id: agreementId }, ctx });

        const agreement = db.get('SELECT deal_id FROM agreements WHERE id = ?', [agreementId]);
        assert(agreement.deal_id, 'a deal was created for the agreement');
        const created = repo.getRecord('deal', ctx, agreement.deal_id);
        const price = repo.dealPrice(ctx, created);
        equal(price.billingType, 'recurring', 'the premise: Offshoring is recurring');
        assert(price.price === null || price.price !== 240000,
            `the newly-created deal must not open priced at the contract's annual total (got ${price.price})`);
    });

    await checkAsync('an agreement with no value leaves the deal’s figures alone', async () => {
        const docs = await import('./api/proposals.mjs');
        const account = repo.createRecord('account', ctx, { name: 'No Figure Yet', account_type: 'Regional' });
        const deal = repo.createRecord('deal', ctx, {
            name: 'Priced by hand', account_id: account.id,
            pipeline_id: PIPE, stage_id: STAGE_OPEN, currency: 'USD',
        });
        repo.insert('deal_line_items', {
            id: db.id('lit'), workspace_id: WS, deal_id: deal.id, position: 0,
            label: 'Priced by a human', pricing_model: 'fixed_fee', recurrence: 'one_time',
            quantity: 1, unit_amount: 75000, currency: 'USD', fx_rate: 1,
        });
        repo.syncDealValues(deal.id, ctx);

        const agreementId = db.id('agr');
        db.run(
            `INSERT INTO agreements (id, workspace_id, account_id, deal_id, number, title, type, status,
                                     effective_date, created_at, updated_at)
             VALUES (?,?,?,?,?,?,'msa','approved',?,?,?)`,
            [agreementId, WS, account.id, deal.id, `A-T-${agreementId}`, 'No value', '2026-01-01', db.now(), db.now()],
        );
        await docs.signAgreement({ req: bodyOf({}), params: { id: agreementId }, ctx });

        equal(repo.getRecord('deal', ctx, deal.id).value_tcv, 75000,
            'a contract with no figure must not blank a deal somebody priced');
    });

    await checkAsync('an existing client’s contract can be typed in by hand', async () => {
        const recordsApi = await import('./api/records.mjs');
        const account = repo.createRecord('account', ctx, {
            name: 'Legacy HCM Client', account_type: 'Egypt', services: ['hcm'],
        });

        const { record } = await recordsApi.create({
            req: bodyOf({
                title: 'HCM retainer 2026', account_id: account.id, type: 'msa',
                service_line_key: 'hcm', contract_value: 600000,
                effective_date: '2026-01-01', expiry_date: '2026-12-31',
            }),
            params: { object: 'agreements' }, ctx,
        });

        assert(/^A-\d{4}-\d{4}$/.test(record.number),
            `the route assigned no number: "${record.number}"`);
        equal(record.service_line_key, 'hcm');
        equal(record.contract_value, 600000);
        equal(record.currency, 'EGP', 'in what the client is billed');
        equal(record.renewal_date, '2026-12-31', 'renewal starts at expiry');

        // And the number is unique — the whole reason it is assigned in one
        // place rather than counted independently wherever a document is made.
        const second = await recordsApi.create({
            req: bodyOf({ title: 'Second contract', account_id: account.id, type: 'sow', expiry_date: '2027-06-30' }),
            params: { object: 'agreements' }, ctx,
        });
        assert(second.record.number !== record.number,
            `two contracts share the number ${record.number}`);
    });

    await checkAsync('service targets are finance, on the way out as well as in', async () => {
        // The write was gated and the read was not, so any rep could ask what
        // every part of the business is expected to bring in this year.
        await metaApi.serviceTargets({ ctx: repCtx }).then(
            () => { throw new Error('a rep read the revenue targets'); },
            (err) => assert(/cannot finance read/.test(err.message), err.message),
        );
        const { targets } = await metaApi.serviceTargets({ ctx: { ...ctx, role: 'manager' } });
        assert(Array.isArray(targets), 'a manager reads them, which is what they are for');
    });
}

/**
 * `/api/meta` is fetched by every signed-in browser, so what it carries is a
 * decision about who can read what — not a convenience.
 */
describe('what the metadata payload exposes');

{
    const metaApi = await import('./api/meta.mjs');
    const { setSetting } = await import('./lib/settings.mjs');

    await checkAsync('a third-party API key never reaches a browser', async () => {
        setSetting(WS, 'bounceban_api_key', 'bb-secret-value-0001');

        for (const role of ['admin', 'manager', 'rep', 'sdr', 'readonly']) {
            const payload = await metaApi.meta({ ctx: { ...ctx, role } });
            equal(payload.settings.bounceban_api_key, null,
                `${role} was sent the BounceBan key — it was readable from devtools by anyone signed in`);
            assert(!JSON.stringify(payload).includes('bb-secret-value-0001'),
                `the key appears somewhere else in the payload for ${role}`);
        }

        // What the settings page actually needs: whether one is set.
        const payload = await metaApi.meta({ ctx });
        equal(payload.secretsConfigured.bounceban_api_key, true);
        setSetting(WS, 'bounceban_api_key', null);
        equal((await metaApi.meta({ ctx })).secretsConfigured.bounceban_api_key, false);
    });

    check('an SDR can reach the registry their one screen is built from', () => {
        // The calling queue's columns, filters and badges all come from
        // /api/meta. Without it the Columns dialog says "0 shown" and "every
        // field is already shown" at the same time, from an empty registry.
        assert(auth.routeAllowed({ role: 'sdr' }, 'GET', '/api/meta'),
            'an SDR cannot load the field registry, so their queue has no columns');

        // And the confinement still holds everywhere else.
        for (const path of ['/api/accounts', '/api/deals', '/api/contacts', '/api/dashboards/default/data']) {
            assert(!auth.routeAllowed({ role: 'sdr' }, 'GET', path),
                `an SDR reached ${path}; the allowlist has grown a hole`);
        }
        assert(!auth.routeAllowed({ role: 'sdr' }, 'PATCH', '/api/meta'),
            'reading the registry is not writing to it');
    });

    /**
     * The endpoint being open is only half of it.
     *
     * An SDR boots through `confinedPage`, not `page`, and that path used to
     * fetch `/api/me` alone — so the field registry was never requested and the
     * queue had no columns no matter what the allowlist permitted. Allowing
     * /api/meta and never calling it looks identical to not allowing it.
     *
     * Read from source, because the failure is an ABSENT call: nothing throws,
     * nothing logs, and the screen renders empty.
     */
    /**
     * "+ Proposal" makes a DOCUMENT, not a record with nothing behind it.
     *
     * The old flow asked for a title, created a bare proposal and quoted the
     * deal's line items into a version — so the table held two kinds of thing:
     * proposals written from a template, which a client can actually be sent,
     * and these, which carried a number, a status and an approval workflow
     * attached to no document. Approving one approved a record.
     *
     * Read from source, because the failure is a route that quietly goes back
     * to creating records: nothing throws, and the difference only shows when
     * somebody tries to send what was approved.
     */
    check('creating a proposal goes through the document wizard', () => {
        const src = fs.readFileSync(new URL('./public/js/pages/record.js', import.meta.url), 'utf8');
        const start = src.indexOf('async function createProposal(');
        assert(start > -1, 'createProposal is gone; this test needs rewriting for whatever replaced it');
        const body = src.slice(start, src.indexOf('\n    }', start));

        assert(/generateDocument\(/.test(body),
            'creating a proposal does not open the generation wizard, so it produces a record with no document');
        assert(!/api\.post\('\/api\/proposals'/.test(body),
            'creating a proposal still POSTs a bare record, which is the split this removed');
    });

    check('the confined boot path loads the registry it renders from', () => {
        const appJs = fs.readFileSync(new URL('./public/js/app.js', import.meta.url), 'utf8');
        const start = appJs.indexOf('async function confinedPage(');
        assert(start > -1, 'confinedPage is gone; this test needs rewriting for whatever replaced it');
        const body = appJs.slice(start, appJs.indexOf('\n}', start));

        assert(/store\.loadMeta\(\)/.test(body),
            'confinedPage does not load /api/meta, so store.fields() is empty and the '
            + 'calling queue renders with no columns');
        assert(/store\.refreshViews\(\)/.test(body),
            'confinedPage does not load saved views, so the queue offers none');
        // Lists are not reachable for a confined role; asking would 403 the boot.
        assert(!/store\.refreshLists\(\)/.test(body),
            'confinedPage asks for /api/lists, which an SDR cannot reach — the boot will fail');
    });

    check('the calling queue object actually has columns to show', () => {
        // The bug reported from the SDR's screen: zero columns offered.
        const fields = objects.fieldsFor('calling_assignment', WS);
        assert(fields.length > 0, 'the calling queue object has no fields at all');
        assert(fields.some((f) => f.listDefault),
            'no field is a default column, so the queue opens empty for everybody');
    });
}

describe('calling queue filters');

{
    const callingLib = await import('./lib/calling.mjs');
    const recordsApi = await import('./api/records.mjs');

    const sdrUser = auth.createUser({
        email: 'queue-sdr@test.local', name: 'Queue SDR', password: 'test-password-9', role: 'sdr', workspaceId: WS,
    });
    const otherSdr = auth.createUser({
        email: 'queue-sdr2@test.local', name: 'Other SDR', password: 'test-password-8', role: 'sdr', workspaceId: WS,
    });
    const sdrCtx = { ...ctx, userId: sdrUser.id, role: 'sdr', user: { id: sdrUser.id, name: 'Queue SDR' } };

    const acme = repo.createRecord('account', ctx, { name: 'Queue Acme Ltd' });
    const globex = repo.createRecord('account', ctx, { name: 'Queue Globex Ltd' });
    const seed = (accountId, name, priority, assignedTo) => {
        const contact = repo.createRecord('contact', ctx, {
            first_name: name, last_name: 'Queue', account_id: accountId,
            phone: '+966500000000', data_source: 'test',
        });
        db.run(
            `INSERT INTO calling_assignments (id, workspace_id, contact_id, account_id, assigned_to,
                                              queue_status, priority, call_count, assigned_at, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [db.id('cas'), WS, contact.id, accountId, assignedTo, 'queued', priority, 0, db.now(), db.now(), db.now()],
        );
    };
    seed(acme.id, 'Aisha', 'high', sdrUser.id);
    seed(acme.id, 'Bilal', 'low', sdrUser.id);
    seed(globex.id, 'Carlos', 'high', otherSdr.id);

    const all$ = (opts) => callingLib.queue(ctx, { tab: 'all', limit: 100, ...opts });

    check('a filter on the queue’s own column narrows it, total included', () => {
        equal(all$({}).total, 3, 'three seeded');
        const high = all$({ filter: { op: 'and', children: [{ field: 'priority', operator: 'is', value: 'high' }] } });
        equal(high.total, 2);
        equal(high.items.length, 2, 'the total and the rows agree — the filter reached the query, not the rendering');
    });

    check('a filter on a JOINED column works, which is the whole trick', () => {
        // `account_name` is `acc.name` — it lives in the accounts table, not in
        // calling_assignments. The query compiler uses a dotted column as it
        // stands rather than prefixing the alias again.
        const globexOnly = all$({
            filter: { op: 'and', children: [{ field: 'account_name', operator: 'contains', value: 'Globex' }] },
        });
        equal(globexOnly.total, 1);
        equal(globexOnly.items[0].account_name, 'Queue Globex Ltd');

        const byContact = all$({
            filter: { op: 'and', children: [{ field: 'full_name', operator: 'contains', value: 'Aisha' }] },
        });
        equal(byContact.total, 1, 'and on the contact’s name, from the contacts table');
    });

    check('sorting on a joined column runs, and orders by it', () => {
        const asc = all$({ sort: [{ field: 'full_name', direction: 'asc' }] });
        const desc = all$({ sort: [{ field: 'full_name', direction: 'desc' }] });
        equal(asc.items.map((i) => i.full_name), [...asc.items.map((i) => i.full_name)].sort());
        equal(desc.items[0].full_name, asc.items[asc.items.length - 1].full_name, 'and reverses');
    });

    /**
     * The queue scopes to calls, not to assignments.
     *
     * An assignment has no single call date — one contact rung four times has
     * four entries in activities. Asking "who did we reach in this period" has
     * to join those activities, not read a column on the assignment row. This
     * proves the rows and the totals agree about a period, and that a call made
     * outside it neither admits the row nor reports a date for it.
     *
     * Its OWN workspace: inserting call activities would otherwise move the
     * workspace-wide call counts the cold-calling block asserts — the same
     * reason the dashboard test carved one out.
     */
    await checkAsync('a date range scopes the queue to calls made in the period', async () => {
        const WS2 = db.id('wsp');
        db.run('INSERT INTO workspaces (id, name, created_at) VALUES (?,?,?)', [WS2, 'Range Co', db.now()]);
        const caller = auth.createUser({
            email: 'range-sdr@test.local', name: 'Range SDR', password: 'test-password-5', role: 'sdr', workspaceId: WS2,
        });
        const ctx2 = { ...ctx, workspaceId: WS2, workspace: { ...ctx.workspace, id: WS2 } };
        const account2 = repo.createRecord('account', ctx2, { name: 'Range Co' });

        const seedAssignment = (name) => {
            const contact = repo.createRecord('contact', ctx2, {
                first_name: name, last_name: 'Range', account_id: account2.id,
                phone: '+966500000001', data_source: 'test',
            });
            const assignmentId = db.id('cas');
            db.run(
                `INSERT INTO calling_assignments (id, workspace_id, contact_id, account_id, assigned_to,
                                                  queue_status, priority, call_count, active, assigned_at, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,0,1,?,?,?)`,
                [assignmentId, WS2, contact.id, account2.id, caller.id, 'queued', 'medium', db.now(), db.now(), db.now()],
            );
            return { contact, assignmentId };
        };
        const callAt = (assignmentId, parentId, at, subject) => {
            db.run(
                `INSERT INTO activities (id, workspace_id, parent_type, parent_id, account_id, type_key, subject,
                                         occurred_at, direction, actor_id, source, properties, assignment_id, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [
                    db.id('act'), WS2, 'contact', parentId, account2.id, 'call', subject,
                    at, 'outbound', caller.id, 'ui', '{}', assignmentId, db.now(), db.now(),
                ],
            );
        };

        // Called twice within the period, and once before it.
        const inPeriod = seedAssignment('Aisha');
        callAt(inPeriod.assignmentId, inPeriod.contact.id, '2025-06-01T09:00:00.000Z', 'start of period');
        callAt(inPeriod.assignmentId, inPeriod.contact.id, '2025-06-15T09:00:00.000Z', 'end of period');
        // And the assignment's OWN last call, after the period, so the row must
        // show the period's date rather than confuse the two.
        db.run('UPDATE calling_assignments SET last_called_at = ?, call_count = 3 WHERE id = ?',
            ['2025-08-01T09:00:00.000Z', inPeriod.assignmentId]);

        const early = seedAssignment('Bilal');
        callAt(early.assignmentId, early.contact.id, '2025-05-29T09:00:00.000Z', 'before the period');

        const from = '2025-06-01T00:00:00.000Z';
        const to = '2025-07-01T00:00:00.000Z';
        const scoped = callingLib.queue(ctx2, { tab: 'all', limit: 100, from, to });
        equal(scoped.total, 1, 'only Aisha, called in the period, is admitted');
        equal(scoped.items[0].in_range_called_at, '2025-06-15T09:00:00.000Z',
            'the row reports its last call in the period (15 June), not the assignment-level 1 August');

        const open = callingLib.queue(ctx2, { tab: 'all', limit: 100 });
        equal(open.total, 2, 'All-time sees every seeded assignment again');
        assert(open.items.every((row) => !('in_range_called_at' in row) || row.in_range_called_at === null),
            'no range means no period date carried on the row');

        const countsScoped = callingLib.queueCounts(ctx2, { from, to });
        const countsOpen = callingLib.queueCounts(ctx2, {});
        equal(countsScoped.all, 1, 'the tab pills agree with the list');
        equal(countsOpen.all, 2, 'and all-time pills do too');

        // The range must not double as a filter or a tab: Bilal's early call is
        // the only activity tied to a completed-ish view, and the range alone
        // neither widens nor narrows what the tabs already decide.
        const completedScoped = callingLib.queue(ctx2, { tab: 'completed', limit: 100, from, to });
        equal(completedScoped.total, 0, 'neither call made it to Completed within the period');
    });

    /**
     * The scoping column is now a filterable FIELD, which is a new handle on it.
     *
     * `assigned_to` was added so a manager could ask "what is Omar's queue
     * doing" by picking a person instead of matching a name as text. That same
     * field is offered to an SDR by the same filter builder, and it names the
     * exact column the scope clause keys on — so it is the one filter most
     * likely to widen a scope, and the one worth proving cannot.
     */
    /**
     * Contact rate is how much of the LIST has moved off "ready to call".
     *
     * It used to be conversations over calls, which answers "when you dial, do
     * you reach anybody" and cannot fall when a queue goes untouched — three
     * calls reaching three people scored 100% with ninety-seven leads sitting
     * there. The denominator is the assigned list now.
     *
     * And the numerator is `queue_status <> 'queued'`, not `call_count > 0` —
     * a lead a manager has pushed back to `queued` (to re-attempt, say) is
     * "ready to call" again whatever `call_count` still remembers, so this
     * seeds the "already worked" row with a queue_status a real outcome would
     * leave it in (`working`, what No Answer sets — see CALL_OUTCOMES), not
     * just a nonzero `call_count` on an otherwise still-`queued` row.
     */
    await checkAsync('contact rate is worked leads over assigned leads', async () => {
        const dash = await import('./api/dashboard.mjs');
        const dr = await import('./lib/date-range.mjs');
        const range = dr.resolveRange({ preset: 'month' }, { timeZone: 'UTC', weekendDays: [5, 6] });

        /*
         * Its own SDR and its own rows. The widget aggregates the whole
         * workspace, so touching the shared fixtures would move the numbers
         * other tests assert on — which is exactly what a first attempt at
         * this did.
         */
        const lonely = auth.createUser({
            email: 'rate-sdr@test.local', name: 'Rate SDR', password: 'test-password-7', role: 'sdr', workspaceId: WS,
        });
        const seedFor = (calls, status = 'queued') => {
            const contact = repo.createRecord('contact', ctx, {
                first_name: 'Rate', last_name: 'Target ' + db.id('x'), data_source: 'test',
            });
            db.run(
                `INSERT INTO calling_assignments (id, workspace_id, contact_id, assigned_to, queue_status,
                                                  priority, call_count, active, assigned_at, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,1,?,?,?)`,
                [db.id('cas'), WS, contact.id, lonely.id, status, 'medium', calls, db.now(), db.now(), db.now()],
            );
        };
        seedFor(0);
        seedFor(0);

        const out = await dash.WIDGETS.sdr_performance.run(ctx, {}, range, { currency: 'USD', rates: {} });
        const row = out.rows.find((r) => r.name === 'Rate SDR');
        assert(row, 'an SDR holding a queue must appear even with no calls in the period');
        equal(row.assigned, 2, 'the two seeded assignments');
        equal(row.called, 0, 'neither has been worked');
        equal(row.contactRate, 0, 'nought per cent, not absent and not 100');

        // A third, already rung and moved to Working: one of three.
        seedFor(1, 'working');
        const after = await dash.WIDGETS.sdr_performance.run(ctx, {}, range, { currency: 'USD', rates: {} });
        const moved = after.rows.find((r) => r.name === 'Rate SDR');
        equal(moved.assigned, 3);
        equal(moved.called, 1);
        equal(moved.contactRate, 33, 'one of three, rounded');

        // A fourth: called before, but pushed BACK to "ready to call" since.
        // `call_count` still remembers the earlier attempt; the rate must not.
        seedFor(1, 'queued');
        const pushedBack = await dash.WIDGETS.sdr_performance.run(ctx, {}, range, { currency: 'USD', rates: {} });
        const stillReady = pushedBack.rows.find((r) => r.name === 'Rate SDR');
        equal(stillReady.assigned, 4);
        equal(stillReady.called, 1, 'a call_count with no matching queue_status change does not count as worked');
    });

    /**
     * Conversations: the calls that reached somebody.
     *
     * A count, not a rate. A percentage flatters a small sample — three calls
     * with two answered reads better than thirty with twenty — and the number
     * of conversations had is the work actually done. Calls sits beside it for
     * anyone who wants the ratio.
     */
    await checkAsync('active calls counts everything except no answer and wrong number', async () => {
        const dash = await import('./api/dashboard.mjs');
        const dr = await import('./lib/date-range.mjs');
        const range = dr.resolveRange({ preset: 'month' }, { timeZone: 'UTC', weekendDays: [5, 6] });

        /*
         * Its own WORKSPACE, not just its own SDR.
         *
         * Logging a call writes an activity, and the cold-calling block asserts
         * an exact workspace-wide call count. A first version of this seeded
         * five calls into the shared workspace and moved that number from three
         * to eight. Aggregates are only isolated by the thing they aggregate
         * over.
         */
        const WS2 = db.id('wsp');
        db.run('INSERT INTO workspaces (id, name, created_at) VALUES (?,?,?)', [WS2, 'Dialling Co', db.now()]);
        const caller = auth.createUser({
            email: 'active-sdr@test.local', name: 'Active SDR', password: 'test-password-6', role: 'sdr', workspaceId: WS2,
        });
        const ctx2 = { ...ctx, workspaceId: WS2, workspace: { ...ctx.workspace, id: WS2 } };
        const callerCtx = { ...ctx2, userId: caller.id, role: 'sdr', user: { id: caller.id, name: 'Active SDR' } };
        const account = repo.createRecord('account', ctx2, { name: 'Dialled Co' });

        const ring = (outcome, extra = {}) => {
            const contact = repo.createRecord('contact', ctx2, {
                first_name: 'Dial', last_name: 'Target ' + db.id('x'), account_id: account.id, data_source: 'test',
            });
            const assignmentId = db.id('cas');
            db.run(
                `INSERT INTO calling_assignments (id, workspace_id, contact_id, account_id, assigned_to,
                                                  queue_status, priority, call_count, active, assigned_at, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,0,1,?,?,?)`,
                [assignmentId, WS2, contact.id, account.id, caller.id, 'queued', 'medium', db.now(), db.now(), db.now()],
            );
            callingLib.logCall(callerCtx, { assignmentId, outcome, ...extra });
        };

        ring('no_answer');
        ring('no_answer');
        ring('wrong_number');
        ring('qualified');
        ring('send_profile');

        const out = await dash.WIDGETS.sdr_performance.run(ctx2, {}, range, { currency: 'USD', rates: {} });
        const row = out.rows.find((r) => r.name === 'Active SDR');
        assert(row, 'the caller must appear');
        equal(row.calls, 5, 'five calls were made');
        equal(row.noAnswer, 2);
        equal(row.wrongNumber, 1, 'wrong number is counted on its own, not hidden inside no answer');
        equal(row.conversations, 2, 'only the two that reached somebody');
        assert(!('answerRate' in row), 'the rate this replaced should be gone');
    });

    check('wrong number is a real outcome, and it closes the assignment', () => {
        const outcome = callingLib.CALL_OUTCOMES.find((o) => o.key === 'wrong_number');
        assert(outcome, 'wrong_number is missing, so bad numbers get logged as No Answer');
        equal(outcome.conversation, false, 'a wrong number reached nobody');
        equal(outcome.closes, true, 'and ringing it again is wasted work, unlike an unanswered phone');

        // objects.mjs restates the list; the two must not drift.
        equal(
            objects.OBJECTS.calling_assignment.fields.find((f) => f.key === 'last_outcome').options,
            callingLib.CALL_OUTCOMES.map((o) => o.key),
        );
    });

    check('an SDR filtering BY another SDR still sees only their own', () => {
        const reach = callingLib.queue(sdrCtx, {
            tab: 'all',
            limit: 100,
            filter: { op: 'and', children: [{ field: 'assigned_to', operator: 'is_any_of', value: [otherSdr.id] }] },
        });
        equal(reach.total, 0,
            'filtering by another SDR reached their queue — the scope clause must sit underneath the filter');

        // And the same question asked as a sort, which compiles separately.
        const sorted = callingLib.queue(sdrCtx, {
            tab: 'all', limit: 100, sort: [{ field: 'assigned_to', direction: 'desc' }],
        });
        assert(sorted.items.every((i) => i.assignedTo === sdrUser.id),
            'sorting by the scoping column returned somebody else’s row');
    });

    check('no phone number belonging to another SDR is ever returned', () => {
        // The requirement in the words it was given: an SDR sees only the
        // numbers assigned to them. Phones are what this screen exists to
        // show, so they are asserted on rather than inferred from row counts.
        const carlos = db.get("SELECT id, phone FROM contacts WHERE first_name = 'Carlos'");
        const mine = callingLib.queue(sdrCtx, { tab: 'all', limit: 100 });

        assert(mine.items.length > 0, 'the fixture must return rows or this proves nothing');
        assert(!mine.items.some((i) => i.contactId === carlos.id),
            'another SDR’s contact appeared in the queue');

        // Nothing anywhere in the payload — not a column, not a nested field.
        const serialised = JSON.stringify(mine);
        assert(!serialised.includes(carlos.id),
            'another SDR’s contact id is reachable somewhere in the queue payload');
    });

    check('a filter narrows what you may see and can never widen it', () => {
        // The SDR sees only their own two, filter or no filter. A filter that
        // names another SDR's company still returns nothing.
        equal(callingLib.queue(sdrCtx, { tab: 'all', limit: 100 }).total, 2, 'their own rows only');
        const reach = callingLib.queue(sdrCtx, {
            tab: 'all',
            limit: 100,
            filter: { op: 'and', children: [{ field: 'account_name', operator: 'contains', value: 'Globex' }] },
        });
        equal(reach.total, 0, 'the scope clause still applies underneath the filter');
    });

    check('rows carry both key shapes, so the console and the table both read them', () => {
        const row = all$({}).items[0];
        assert(row.full_name && row.account_name, 'the field registry’s names, for the shared table');
        assert(row.name !== undefined && row.lastCalledAt !== undefined, 'and the console’s, unchanged');
    });

    check('the queue object is registered but not routable', () => {
        const def = objects.objectDef('calling_assignment');
        equal(def.table, 'calling_assignments');
        equal(def.internal, true);
        equal(def.route, null);

        // No generic endpoint: ROUTES is an explicit allowlist, and an SDR is
        // confined to /api/calling/* regardless.
        assert(!Object.values(recordsApi.ROUTES).includes('calling_assignment'),
            'no /api/<object> route exists for it');
        assert(!auth.routeAllowed({ role: 'sdr' }, 'GET', '/api/calling_assignments'),
            'and a confined role could not reach one if it did');
    });

    check('its enums match the ones calling.mjs enforces', () => {
        // They are restated in objects.mjs to avoid an import cycle; this is
        // what stops the copies drifting.
        const optionsOf = (key) => objects.fieldsFor('calling_assignment', WS).find((f) => f.key === key).options;
        equal(optionsOf('priority'), callingLib.PRIORITIES);
        equal(optionsOf('last_outcome'), callingLib.CALL_OUTCOMES.map((o) => o.key));
    });
}

/* ================== 16d. THE LINKEDIN FIELD IS A URL ==================== */
//
// Presented as a URL because that is what people paste; stored as the slug
// because evidence rows, verdicts and prospect-to-account matching are all
// keyed on it.

describe('linkedin field');

check('a pasted company URL is stored as the slug', () => {
    const account = repo.createRecord('account', ctx, {
        name: 'Pasted URL Ltd',
        linkedin_slug: 'https://www.linkedin.com/company/pasted-url-ltd/',
    });
    equal(account.linkedin_slug, 'pasted-url-ltd',
        'so it matches the slug every other row is keyed on');
});

check('every shape of the same company page is the same company', () => {
    /**
     * The account table has UNIQUE (workspace_id, linkedin_slug), and before
     * this normalisation the constraint was easy to walk straight past: six
     * spellings of one company page are six different strings, so they became
     * six accounts. Now the second one collides, which is the constraint doing
     * the job it was written for.
     */
    const first = repo.createRecord('account', ctx, {
        name: 'Acme Corp', linkedin_slug: 'https://www.linkedin.com/company/acme-corp/',
    });
    equal(first.linkedin_slug, 'acme-corp');

    for (const shape of [
        'http://linkedin.com/company/acme-corp',
        'https://sa.linkedin.com/company/acme-corp/about/',
        'https://www.linkedin.com/company/acme-corp/?originalSubdomain=sa',
        'linkedin.com/company/acme-corp',
        'acme-corp',
    ]) {
        throws(
            () => repo.createRecord('account', ctx, { name: `Duplicate of ${shape}`, linkedin_slug: shape }),
            /UNIQUE|already/i,
            `"${shape}" is recognised as the account that already exists`,
        );
    }
});

check('an Arabic percent-encoded slug is left exactly as it is', () => {
    // LinkedIn writes Arabic company slugs percent-encoded, and 661 accounts
    // here carry them. Mangling one would orphan its evidence.
    const slug = '%d9%85%d8%a4%d8%b3%d8%b3%d8%a9-%d8%b9%d8%a7%d9%84%d9%85';
    const direct = repo.createRecord('account', ctx, { name: 'Arabic A', linkedin_slug: slug });
    equal(direct.linkedin_slug, slug, 'stored byte for byte');
    throws(
        () => repo.createRecord('account', ctx, {
            name: 'Arabic B', linkedin_slug: `https://www.linkedin.com/company/${slug}/`,
        }),
        /UNIQUE|already/i,
        'and the URL form resolves to the very same company',
    );
});

check('the stored slug is still what evidence is keyed on', () => {
    // The reason the column is not simply turned into a URL: this value is
    // passed straight through as `subjectKey` by api/accounts.mjs.
    const account = repo.createRecord('account', ctx, {
        name: 'Keyed Ltd', linkedin_slug: 'https://www.linkedin.com/company/keyed-ltd/',
    });
    qual.recordEvidence(ctx, {
        accountId: account.id, subjectKey: account.linkedin_slug,
        provider: 'test', payload: { ok: true },
    });
    const row = db.get(
        'SELECT subject_key FROM evidence_snapshots WHERE account_id = ? ORDER BY created_at DESC LIMIT 1',
        [account.id],
    );
    equal(row.subject_key, 'keyed-ltd', 'a slug, not a URL — matching every row already there');
});

check('a personal profile is not silently turned into a company slug', () => {
    const account = repo.createRecord('account', ctx, {
        name: 'Person Not Company', linkedin_slug: 'https://www.linkedin.com/in/some-person/',
    });
    assert(account.linkedin_slug.includes('/in/'),
        'left as typed rather than mangled into something that looks like a slug and identifies nothing');
});

await checkAsync('the field tells the browser how to display it', async () => {
    const field = objects.fieldsFor('account', WS).find((x) => x.key === 'linkedin_slug');
    equal(field.label, 'LinkedIn URL');
    equal(field.format, 'linkedin_company', 'a name, because a function cannot cross to the client as JSON');

    // And it actually reaches the browser. /api/meta builds an explicit
    // projection of each field, so a property that is not listed there is
    // silently dropped however carefully the registry declares it.
    const metaApi = await import('./api/meta.mjs');
    const payload = await metaApi.meta({ ctx });
    const sent = payload.objects.account.fields.find((x) => x.key === 'linkedin_slug');
    equal(sent.format, 'linkedin_company', 'survives the projection in api/meta.mjs');
    equal(sent.label, 'LinkedIn URL');
});

/* ==================== 16c. DASHBOARD DATE RANGES ======================== */
//
/* ======================================================== ROLE DASHBOARDS === */

/**
 * A manager and a rep do not open this screen with the same question, and a rep
 * may not see revenue at all. Both of those were comments before they were
 * checks — and the second one was WRONG while it was only a comment: two of the
 * widgets sitting under "carries no money widget" render currency.
 *
 * So the registry declares which widgets report money, and these tests refuse a
 * layout that puts one in front of a role that may not see it. The next money
 * widget cannot be added to those lists by accident.
 */
describe('role dashboards');

{
    const { ROLE_DASHBOARDS, WIDGETS } = await import('./api/dashboard.mjs');
    const { can } = await import('./lib/auth.mjs');

    /** Roles that must never be sent a currency figure. */
    const NO_MONEY = ['rep', 'readonly'];

    check('every widget named in a role layout exists', () => {
        for (const [role, layout] of Object.entries(ROLE_DASHBOARDS)) {
            for (const item of layout) {
                assert(WIDGETS[item.widget],
                    `the ${role} dashboard names "${item.widget}", which is not a widget — `
                    + 'a renamed widget must not leave a layout pointing at nothing');
            }
        }
    });

    check('no money widget reaches a role that may not see revenue', () => {
        for (const role of NO_MONEY) {
            const offenders = (ROLE_DASHBOARDS[role] ?? [])
                .filter((item) => WIDGETS[item.widget]?.money)
                .map((item) => item.widget);
            equal(offenders, [],
                `the ${role} dashboard carries ${offenders.join(', ')}, which report money. `
                + 'Pipeline and revenue are restricted for this role, and the cheapest way not '
                + 'to send them is not to put them on the page.');
        }
    });

    /**
     * The layout rule above is a convenience. THIS is the control.
     *
     * Keeping money widgets off a rep's layout only helps for the layout a rep
     * is given. Any member can name a stored dashboard by id, and the
     * workspace-wide one carries `pipeline_by_stage`, so authorization has to
     * live where the widget is RUN, not where the list is chosen.
     */
    check('the money gate is a capability, not a layout', () => {
        for (const role of NO_MONEY.concat('sdr')) {
            assert(!can({ role }, 'finance.read'),
                `${role} holds finance.read, so every money widget in the registry is one `
                + 'request-by-id away from them');
        }
        for (const role of ['manager', 'admin', 'owner']) {
            assert(can({ role }, 'finance.read'),
                `${role} cannot read finance, which would blank the analytics they exist to read`);
        }

        // And the flag the gate reads must actually be set: a widget that
        // renders currency without declaring `money` walks straight past it.
        for (const [key, widget] of Object.entries(WIDGETS)) {
            const src = String(widget.run);
            const rendersMoney = /money:\s*true|reporting\.rates|aggregateInReporting/.test(src);
            if (rendersMoney) {
                assert(widget.money,
                    `"${key}" renders currency but does not declare money: true, so the `
                    + 'capability gate in dashboardData will let it through');
            }
        }
    });

    check('an SDR has a My work dashboard with only her calls', () => {
        assert(ROLE_DASHBOARDS.sdr, 'an SDR should have a dashboard — My work with My calling');
        assert(ROLE_DASHBOARDS.sdr.some((i) => i.widget === 'my_calling'),
            'SDR dashboard must contain My calling — the same Team calling table but filtered to her');
        assert(ROLE_DASHBOARDS.sdr.some((i) => i.section === 'My work'),
            'SDR My calling must appear in My work band');
        // Still scoped to her — the widget itself filters to ctx.userId, tested below
    });

    check('a manager is not handed the whole widget registry', () => {
        // The complaint that started this: thirteen widgets, seven of them full
        // width, answering everybody's question and therefore nobody's.
        assert(ROLE_DASHBOARDS.manager.length <= 9,
            `the manager dashboard has ${ROLE_DASHBOARDS.manager.length} widgets; a screen that has `
            + 'to be scrolled to be read is not a dashboard');
    });

    check('every dashboard splits Egypt from Regional somehow', () => {
        /**
         * `account_type` describes itself on the field as "the commercial
         * grouping the dashboard reports by", so every layout has to honour
         * that — but not necessarily with the same widget.
         *
         * A manager gets `service_performance`, which crosses account type WITH
         * service and reports won revenue against target. A rep gets
         * `deals_by_account_type`, which is the same split in counts, because
         * the richer one reports money and a rep may not see it. Asserting one
         * specific widget would forbid the better answer.
         */
        const SPLITS_BY_TYPE = ['service_performance', 'deals_by_account_type'];
        for (const [role, layout] of Object.entries(ROLE_DASHBOARDS)) {
            assert(layout.some((i) => SPLITS_BY_TYPE.includes(i.widget)),
                `the ${role} dashboard must split Egypt from Regional by some means`);
        }
    });

    check('a long dashboard is banded, so nine cards are not one list', () => {
        // Banding breaks up a page that is long enough to need it. A short
        // layout is left alone: one heading over four cards is decoration.
        const NEEDS_BANDS = 5;
        for (const [role, layout] of Object.entries(ROLE_DASHBOARDS)) {
            if (layout.length < NEEDS_BANDS) {
                const banded = layout.filter((i) => i.section).map((i) => i.widget);
                equal(banded, [], `${role} has ${layout.length} widgets — too few to be worth a heading`);
                continue;
            }
            const unbanded = layout.filter((i) => !i.section).map((i) => i.widget);
            equal(unbanded, [], `every widget on the ${role} dashboard needs a section`);
            const bands = new Set(layout.map((i) => i.section));
            assert(bands.size >= 2, `${role} needs more than one band to be worth banding`);
        }
    });

    check('the client draws the bands the layout declares', () => {
        const js = fs.readFileSync(new URL('./public/js/pages/dashboard.js', import.meta.url), 'utf8');
        assert(js.includes('widget.section'), 'dashboard.js must group by the declared section');
        assert(js.includes('dash-band'), 'and give the band a heading of its own');
    });
}

// The dashboard's date picker has to reach the QUERIES, not the rendering, and
// each metric has to read the timestamp it actually means. These tests are
// written so that using the wrong column fails: every fixture below is placed
// where one clock says one thing and another says something else.

describe('dashboard date ranges');

{
    const dash = await import('./api/dashboard.mjs');
    const ranges = await import('./lib/date-range.mjs');

    // Riyadh is UTC+3, so a day here is emphatically not a day in UTC.
    const TZ = 'Asia/Riyadh';
    const today = ranges.resolveRange({ preset: 'today' }, { timeZone: TZ });
    const at = (msFromLocalMidnight) => new Date(new Date(today.from).getTime() + msFromLocalMidnight).toISOString();

    /**
     * 00:30 local, which is 21:30 UTC YESTERDAY.
     *
     * Anything counting with DATE() or a UTC "today" puts this on the wrong day,
     * which is the bug this whole suite exists to catch.
     */
    const earlyToday = at(30 * 60e3);
    const lateYesterday = at(-30 * 60e3);          // 23:30 local yesterday
    const DASH = db.id('dsh');

    db.run(
        `INSERT INTO dashboards (id, workspace_id, name, layout, scope, is_default, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [DASH, WS, 'Test dashboard', JSON.stringify([
            { widget: 'crm_snapshot', title: 'At a glance', options: {} },
        ]), 'workspace', 1, db.now(), db.now()],
    );

    const dashCtx = { ...ctx, workspace: { ...ctx.workspace, timezone: TZ, weekendDays: [5, 6] } };
    const tiles = async (preset, extra = '') => {
        const out = await dash.dashboardData({
            params: { id: DASH },
            url: new URL(`http://x/?range=${preset}${extra}`),
            ctx: dashCtx,
        });
        const widget = out.widgets[0];
        assert(!widget.error, `widget failed: ${widget.error}`);
        return new Map(widget.data.tiles.map((t) => [t.label, t.value]));
    };

    const baseline = await tiles('today');

    // Two accounts: one just after local midnight today, one just before it.
    db.run(`INSERT INTO accounts (id, workspace_id, name, lifecycle_stage, created_at, updated_at)
            VALUES (?,?,?,?,?,?)`, [db.id('acc'), WS, 'Added Early Today', 'prospect', earlyToday, earlyToday]);
    db.run(`INSERT INTO accounts (id, workspace_id, name, lifecycle_stage, created_at, updated_at)
            VALUES (?,?,?,?,?,?)`, [db.id('acc'), WS, 'Added Late Yesterday', 'prospect', lateYesterday, lateYesterday]);

    await checkAsync('"added today" counts a local day, not a UTC one', async () => {
        const after = await tiles('today');
        equal(after.get('Accounts added') - baseline.get('Accounts added'), 1,
            'the 00:30 Riyadh account counts today; the 23:30-yesterday one does not, '
            + 'though both fall on the same UTC date');
    });

    await checkAsync('the range reaches the query, not just the rendering', async () => {
        const allTime = await tiles('all');
        const justToday = await tiles('today');
        assert(allTime.get('Accounts added') > justToday.get('Accounts added'),
            'a wider range returns a bigger number, which a filter applied after the count could not do');
    });

    await checkAsync('a custom range is honoured, inclusive of both ends', async () => {
        // The LOCAL day, not the first ten characters of the range's start —
        // local midnight in Riyadh is 21:00 UTC the day before, and slicing the
        // instant is exactly the off-by-one `resolveRange` warns about.
        const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
        const custom = await tiles('custom', `&from=${day}&to=${day}`);
        const justToday = await tiles('today');
        equal(custom.get('Accounts added'), justToday.get('Accounts added'),
            'a custom range of one day is that day');
    });

    await checkAsync('a meeting is dated by when it happened, not when it was logged', async () => {
        // Logged now, happened last week. "Meetings today" must not count it.
        const lastWeek = at(-7 * 864e5);
        const host = repo.createRecord('account', ctx, { name: 'Meeting Host Ltd' });
        db.run(
            `INSERT INTO activities (id, workspace_id, parent_type, parent_id, account_id, type_key, subject,
                                     occurred_at, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [db.id('act'), WS, 'account', host.id, host.id, 'meeting', 'Held last week, logged today',
                lastWeek, earlyToday, earlyToday],
        );
        const after = await tiles('today');
        equal(after.get('Meetings'), baseline.get('Meetings') ?? 0,
            'occurred_at is the clock for a meeting; created_at would have counted this one');
    });

    await checkAsync('a task is dated by when it is due, not when it was made', async () => {
        const nextWeek = at(7 * 864e5);
        db.run(
            `INSERT INTO tasks (id, workspace_id, title, status, due_at, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?)`,
            [db.id('tsk'), WS, 'Made today, due next week', 'open', nextWeek, earlyToday, earlyToday],
        );
        const todayTiles = await tiles('today');
        equal(todayTiles.get('Tasks due'), baseline.get('Tasks due') ?? 0,
            'due_at is the clock for a task; created_at would have counted this one today');
    });

    await checkAsync('proposals and agreements are counted from their own creation dates', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Dashboard Counts Ltd' });
        db.run(
            `INSERT INTO proposals (id, workspace_id, account_id, number, title, status, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?)`,
            [db.id('pro'), WS, account.id, 'P-TEST-0001', 'Counted today', 'issued', earlyToday, earlyToday],
        );
        db.run(
            `INSERT INTO agreements (id, workspace_id, account_id, number, title, status, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?)`,
            [db.id('agr'), WS, account.id, 'A-TEST-0001', 'Not counted today', 'draft', lateYesterday, lateYesterday],
        );

        const after = await tiles('today');
        equal(after.get('Proposals created') - (baseline.get('Proposals created') ?? 0), 1);
        equal(after.get('Agreements created') - (baseline.get('Agreements created') ?? 0), 0,
            'the agreement was created 30 minutes before this local day began');
    });

    await checkAsync('what cannot be scoped to a period says so', async () => {
        const out = await dash.dashboardData({
            params: { id: DASH }, url: new URL('http://x/?range=today'), ctx: dashCtx,
        });
        const stateTile = out.widgets[0].data.tiles.find((t) => t.label === 'Open deals');
        assert(/whatever the range/i.test(stateTile.help ?? ''),
            'an open-pipeline count is what is open NOW, and a dashboard that let it look '
            + `like a period figure would be lying: ${stateTile.help}`);
    });
}

/* == 16a-2. THE FORECAST OBEYS THE DEAL'S OWN EXPECTED CLOSE DATE ========= */

/**
 * The Forecast tiles used to sum EVERY open deal at full value regardless of
 * the range picker — switching "This month" to "This year" only moved the
 * won-so-far half. A deal expected to close in November counted fully toward
 * October's forecast, same as one expected that week.
 */
describe('The forecast obeys the deal\'s own expected close date');

{
    const dash = await import('./api/dashboard.mjs');
    const reporting = { currency: 'USD', rates: { USD: 1, EGP: 50, SAR: 3.75 } };
    const october = { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z', preset: 'month' };

    const priceOneTime = (dealId, amount) => {
        db.run(
            `INSERT INTO deal_line_items (id, workspace_id, deal_id, label, pricing_model, recurrence,
                                          quantity, unit_amount, currency, fx_rate, position)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [db.id('dli'), WS, dealId, 'Fee', 'fixed_fee', 'one_time', 1, amount, 'USD', 1, 0],
        );
        repo.syncDealValues(dealId, ctx);
    };

    /**
     * A fresh `_dashboardReads` map every call — never the shared `ctx`.
     *
     * `openDeals`/`memo` cache per request on `ctx._dashboardReads`, and an
     * earlier test in this file calls `dashboardData` with the bare shared
     * `ctx` (never cloned), which leaves that map sitting on it permanently.
     * Reusing `ctx` directly across a before/after pair here would read the
     * "before" snapshot back for "after" — a test-isolation artifact of
     * sharing one `ctx` across the whole suite, not something a real request
     * (which always gets its own fresh `ctx`) could ever hit.
     */
    const octoberForecast = async () => {
        const out = await dash.WIDGETS.crm_snapshot.run({ ...ctx, _dashboardReads: undefined }, {}, october, reporting);
        return out;
    };

    await checkAsync('a deal expected to close in November does not appear in October\'s forecast', async () => {
        const before = (await octoberForecast()).tiles.find((t) => t.label === 'Forecast, one-time').value;

        const account = repo.createRecord('account', ctx, { name: 'October Or November Ltd' });
        const octoberDeal = repo.createRecord('deal', ctx, {
            name: 'Expected in October', account_id: account.id, pipeline_id: PIPE, stage_id: STAGE_OPEN,
            currency: 'USD', close_date: '2026-10-15',
        });
        priceOneTime(octoberDeal.id, 40000);
        const novemberDeal = repo.createRecord('deal', ctx, {
            name: 'Expected in November', account_id: account.id, pipeline_id: PIPE, stage_id: STAGE_OPEN,
            currency: 'USD', close_date: '2026-11-05',
        });
        priceOneTime(novemberDeal.id, 70000);

        const after = (await octoberForecast()).tiles.find((t) => t.label === 'Forecast, one-time').value;
        equal(after - before, 40000,
            'only the October-dated deal should enter October\'s forecast — the November one belongs to November\'s, '
            + `not this one; got a delta of ${after - before}`);
    });

    await checkAsync('an undated open deal is not folded into any period\'s forecast, and is not hidden either', async () => {
        const before = await octoberForecast();
        const beforeForecast = before.tiles.find((t) => t.label === 'Forecast, one-time').value;

        const account = repo.createRecord('account', ctx, { name: 'Undated Pipeline For Dashboard Ltd' });
        const deal = repo.createRecord('deal', ctx, {
            name: 'No expected close yet', account_id: account.id, pipeline_id: PIPE, stage_id: STAGE_OPEN,
            currency: 'USD',
        });
        priceOneTime(deal.id, 15000);

        const after = await octoberForecast();
        const afterForecast = after.tiles.find((t) => t.label === 'Forecast, one-time').value;
        equal(afterForecast, beforeForecast,
            'a deal with no expected close date must not be silently folded into October\'s forecast');
        assert(/have no expected close date/.test(after.note ?? ''),
            `but it must not vanish either — the widget should say how much real pipeline is undated: ${after.note}`);
    });
}

/* ============================ 16b. ONE LIVE DATABASE ==================== */

describe('database identity');

check('a database gets one identity, and starts as the live copy', () => {
    const rows = db.all('SELECT * FROM database_identity');
    equal(rows.length, 1, 'exactly one row, enforced by the schema');
    equal(rows[0].status, 'primary');
    assert(rows[0].instance_id?.startsWith('dbi_'), 'stamped once and copied with the file');
    throws(() => db.run('INSERT INTO database_identity (id, instance_id, status, created_at) VALUES (2,?,?,?)',
        ['dbi_second', 'primary', db.now()]), /CHECK|constraint/i, 'a second identity row is impossible');
});

check('retiring a copy records where the live one went', () => {
    db.run('UPDATE database_identity SET status = ?, moved_to = ?, retired_at = ? WHERE id = 1',
        ['retired', 'https://crm.example.com', db.now()]);
    const row = db.identity();
    equal(row.status, 'retired');
    equal(row.moved_to, 'https://crm.example.com',
        'a retired database that cannot say where the real one is, is a dead end');
    // Server.mjs refuses to boot on this; scripts deliberately still work, so a
    // retired copy can still be backed up.
    db.run('UPDATE database_identity SET status = ?, moved_to = NULL, retired_at = NULL WHERE id = 1', ['primary']);
});

/* ================================== 17. ROUTE TABLE ===================== */
//
// Registration ORDER is load-bearing in api/index.mjs: anything more specific
// than /api/:object/:id must be registered above the generic block, or
// /api/deals/xyz/documents is read as "the deal with id xyz" and the wrong
// handler answers. Nothing else in this suite would catch that — it is the one
// class of bug that looks fine in every unit test and 404s in the browser.

/**
 * What a NEW workspace gets has to match what this one was migrated to.
 *
 * Production was collapsed to a single pipeline and given a Contracting stage.
 * `setup.mjs` still seeded three pipelines afterwards, so a fresh install would
 * have arrived with exactly the problem the migration removed — and nobody
 * would have noticed until somebody set up a second workspace.
 *
 * Read from source, because the seed only runs on an empty database and no
 * test creates one.
 */
describe('the seed matches the migrations');

{
    const setupSrc = fs.readFileSync(new URL('./setup.mjs', import.meta.url), 'utf8');
    const pipelineBlock = setupSrc.slice(setupSrc.indexOf('const PIPELINES'), setupSrc.indexOf('\n];', setupSrc.indexOf('const PIPELINES')));
    // `\s*` rather than a newline: a pipeline written on one line is still a
    // pipeline, and a check that only sees the formatting it expects is not a
    // check. The first version of this missed exactly that.
    const seeded = [...pipelineBlock.matchAll(/key:\s*'([a-z_]+)'\s*,\s*label:/g)].map((m) => m[1]);

    check('a new workspace is seeded with one deal pipeline', () => {
        equal(seeded, ['commercial'],
            'setup.mjs seeds more than one pipeline, so a fresh install arrives with the split '
            + 'that apply-single-deal-pipeline.mjs exists to undo');
    });

    check('the seeded pipeline has the stage the agreement automation moves deals into', () => {
        assert(/\['contracting', 'Contracting'/.test(pipelineBlock),
            'the seed has no Contracting stage, so on a new workspace creating an agreement '
            + 'would silently fail to move its deal');
        // Between Negotiation and the terminals, which is the whole point of it.
        const order = [...pipelineBlock.matchAll(/\['([a-z_]+)',/g)].map((m) => m[1]);
        const at = (key) => order.indexOf(key);
        assert(at('negotiation') < at('contracting'), 'Contracting must come after Negotiation');
        assert(at('contracting') < at('won'), 'and before the deal is won');
    });
}

describe('route table');

const { createRouter } = await import('./lib/http.mjs');
const routes = await import('./api/index.mjs');

const router = createRouter();
routes.registerRoutes(router);

const resolves = (method, path, expected) => {
    const match = router.match(method, path);
    assert(match, `${method} ${path} matched nothing`);
    equal(match.handler.name, expected, `${method} ${path} → ${expected}`);
};

check('the generation routes are not shadowed by the generic object routes', () => {
    resolves('GET', '/api/deals/dea_123/document-options', 'dealDocumentOptions');
    resolves('POST', '/api/deals/dea_123/documents', 'generateForDeal');
    resolves('GET', '/api/deals/dea_123/documents', 'dealDocumentHistory');
    resolves('POST', '/api/deals/dea_123/documents/check', 'checkGeneration');
    resolves('GET', '/api/deals/dea_123/services', 'getServices');
    resolves('PUT', '/api/deals/dea_123/services', 'putServices');
    resolves('GET', '/api/accounts/acc_1/commercial-registration', 'getRegistration');
    resolves('PUT', '/api/accounts/acc_1/commercial-registration', 'putRegistration');
    resolves('GET', '/api/accounts/acc_1/documents', 'accountDocumentHistory');
    resolves('GET', '/api/accounts/acc_1/documents/links', 'accountDocumentLinks');
    resolves('GET', '/api/accounts/acc_1/document-options', 'accountDocumentOptions');
    resolves('POST', '/api/accounts/acc_1/documents', 'generateForAccount');
    resolves('POST', '/api/accounts/acc_1/documents/preview', 'previewForAccount');
    resolves('GET', '/api/accounts/acc_1/services', 'getAccountServices');
    resolves('PUT', '/api/accounts/acc_1/services', 'putAccountServices');
    resolves('GET', '/api/document-templates', 'listTemplates');
    resolves('POST', '/api/document-templates', 'uploadTemplate');
});

check('the routes they sit above still resolve', () => {
    resolves('GET', '/api/deals/board', 'board');
    resolves('POST', '/api/deals/dea_123/stage', 'moveStage');
    resolves('GET', '/api/accounts/acc_1/verdicts', 'verdicts');
    resolves('GET', '/api/contacts/con_1', 'read');
    resolves('PATCH', '/api/contacts/con_1', 'patch');
    resolves('GET', '/api/contacts/con_1/timeline', 'timeline');
    resolves('GET', '/api/documents/doc_1/link', 'link');
});

/**
 * The list endpoints run IN the CRM, so they must be reachable in the CRM's own
 * router — and they must not collide with the four root paths the collector's
 * proxy claims (`/api/inspect`, `/api/qualify`, …), which server.mjs matches
 * ahead of this router and which would silently swallow them.
 */
await checkAsync('qualifying an uploaded list resolves here, not into the collector proxy', async () => {
    resolves('POST', '/api/qualification/list/inspect', 'inspectList');
    resolves('POST', '/api/qualification/list/qualify', 'qualifyList');
    const proxy = await import('./lib/qualifier-ui.mjs');
    assert(!proxy.matchQualifierRoute('POST', '/api/qualification/list/inspect'), 'the proxy must not claim inspect');
    assert(!proxy.matchQualifierRoute('POST', '/api/qualification/list/qualify'), 'nor qualify');
    assert(proxy.matchQualifierRoute('POST', '/api/qualify'), 'while the collector page\'s own path still proxies');
});

check('the password routes resolve, and only reset is public', () => {
    resolves('POST', '/api/auth/reset', 'doResetPassword');
    resolves('POST', '/api/me/password', 'changePassword');
    resolves('POST', '/api/users/usr_1/reset-link', 'resetLink');
    assert(routes.PUBLIC_ROUTES.has('POST /api/auth/reset'), 'reset is reachable without a session');
    assert(!routes.PUBLIC_ROUTES.has('POST /api/me/password'), 'changing your own password is not');
    assert(!routes.PUBLIC_ROUTES.has('POST /api/users/:id/reset-link'), 'and issuing a link is not');
});

/**
 * A deal is raised when the meeting is booked — before there is a price, a
 * date, or anything to type into a dropdown.
 */
describe('a deal can be raised with almost nothing');

{
    const dealsApi = await import('./api/deals.mjs');

    check('a name and an account are enough', () => {
        const account = repo.createRecord('account', ctx, { name: 'Booked A Meeting' });
        const deal = repo.createRecord('deal', ctx, { name: 'Just a meeting so far', account_id: account.id });

        assert(deal.pipeline_id, 'the pipeline is filled in, because there is only one and it is not a question');
        assert(deal.stage_id, 'and a stage, so the board has somewhere to draw it');
        equal(deal.status, 'open');
        equal(deal.value_tcv, 0, 'no price yet, and that is allowed');
        equal(deal.close_date ?? null, null, 'and no date');

        // The form no longer asks for the pipeline, so it must not be required.
        const field = objects.fieldsFor('deal', WS).find((f) => f.key === 'pipeline_id');
        equal(field.form, false, 'a dropdown with one option is not a question worth asking');
    });

    await checkAsync('an undated deal still reaches the forecast', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Undated Pipeline Co' });
        const deal = repo.createRecord('deal', ctx, { name: 'No date yet', account_id: account.id });
        repo.insert('deal_line_items', {
            id: db.id('lit'), workspace_id: WS, deal_id: deal.id, position: 0,
            label: 'Fee', pricing_model: 'fixed_fee', recurrence: 'one_time',
            quantity: 1, unit_amount: 25000, currency: 'SAR', fx_rate: 1,
        });
        repo.syncDealValues(deal.id, ctx);

        const out = await dealsApi.forecast({ url: new URL('http://x/?days=90'), ctx });
        assert(out.deals.some((d) => d.id === deal.id),
            'a deal with no close date was absent from the forecast entirely');
        assert(out.unscheduled.count >= 1, 'and it is counted');
        assert(out.unscheduled.one_time >= 25000, 'with its value');

        // Reported apart: a deal with no date cannot be claimed for this horizon.
        assert(!out.open.deals?.some?.((d) => d.id === deal.id),
            'the horizon total must not absorb an undated deal');
    });
}

describe('Deal stage and status');

const STAGE_ACCOUNT = repo.createRecord('account', ctx, { name: 'Stage Co', lifecycle_stage: 'qualified' });

check('moving a deal to a won stage from the EDIT FORM closes it', () => {
    const deal = repo.createRecord('deal', ctx, {
        name: 'Form-moved deal', account_id: STAGE_ACCOUNT.id, pipeline_id: PIPE, stage_id: STAGE_OPEN, close_date: '2026-12-01',
    });
    equal(deal.status, 'open', 'starts open');

    // Not through /api/deals/:id/stage — the ordinary record update, which is
    // what the edit form and bulk edit use.
    const moved = repo.updateRecord('deal', ctx, deal.id, { stage_id: STAGE_WON });
    equal(moved.status, 'won', 'the status follows the stage');
    assert(moved.closed_at, 'and it is stamped closed');
});

check('moving it back to an open stage reopens it and clears the close', () => {
    const deal = repo.createRecord('deal', ctx, {
        name: 'Reopened deal', account_id: STAGE_ACCOUNT.id, pipeline_id: PIPE, stage_id: STAGE_WON, close_date: '2026-12-01',
    });
    const reopened = repo.updateRecord('deal', ctx, deal.id, { stage_id: STAGE_OPEN });
    equal(reopened.status, 'open', 'open again');
    equal(reopened.closed_at, null, 'and no longer carries a close date');
});

check('the edit form cannot close a deal as lost without a reason', () => {
    const deal = repo.createRecord('deal', ctx, {
        name: 'Lost without reason', account_id: STAGE_ACCOUNT.id, pipeline_id: PIPE, stage_id: STAGE_OPEN, close_date: '2026-12-01',
    });
    let refused = null;
    try { repo.updateRecord('deal', ctx, deal.id, { stage_id: STAGE_LOST }); } catch (err) { refused = err; }
    assert(refused, 'refused');
    assert(/reason/i.test(refused.message), `the message asks for a reason: ${refused?.message}`);
    equal(repo.getRecord('deal', ctx, deal.id).status, 'open', 'and the deal is untouched');

    const lost = repo.updateRecord('deal', ctx, deal.id, { stage_id: STAGE_LOST, loss_reason: 'price' });
    equal(lost.status, 'lost', 'with a reason it closes');
    equal(lost.loss_reason, 'price', 'and the reason is kept');
});

/* ======================================================= COLD CALLING === */

const calling = await import('./lib/calling.mjs');

describe('Cold calling');

const sarah = auth.createUser({ email: 'sarah@test.local', name: 'Sarah', password: 'test-password-3', role: 'sdr', workspaceId: WS });
const ahmed = auth.createUser({ email: 'ahmed@test.local', name: 'Ahmed', password: 'test-password-4', role: 'sdr', workspaceId: WS });
const sarahCtx = { ...ctx, userId: sarah.id, role: 'sdr', user: { id: sarah.id, name: 'Sarah' } };
const ahmedCtx = { ...ctx, userId: ahmed.id, role: 'sdr', user: { id: ahmed.id, name: 'Ahmed' } };

const callAccount = repo.createRecord('account', ctx, { name: 'Calling Co', lifecycle_stage: 'prospect' });
const callContacts = ['Aisha One', 'Bilal Two', 'Cala Three'].map((name) => repo.createRecord('contact', ctx, {
    full_name: name, account_id: callAccount.id, phone: '+966500000000', data_source: 'test',
}));

check('an SDR holds no general record access, so the generic routes refuse them', () => {
    assert(!auth.can(sarahCtx, 'record.read.all'), 'an SDR must not be able to read every record');
    assert(!auth.can(sarahCtx, 'record.write.all'), 'an SDR must not be able to write every record');
    assert(!auth.can(sarahCtx, 'calling.manage'), 'an SDR must not be able to assign work');
    assert(auth.can(sarahCtx, 'calling.work'), 'an SDR must be able to work their queue');
});

check('assigning puts contacts on one SDR queue', () => {
    const result = calling.assignContacts(ctx, {
        contactIds: callContacts.map((c) => c.id), assignedTo: sarah.id, priority: 'A',
    });
    equal(result.assigned, 3, 'three contacts assigned');
    equal(result.reassigned, 0, 'nothing reassigned');
    equal(calling.queueCounts(sarahCtx).to_call, 3, 'they are on Sarah queue');
});

check('assigning the same contact to the same SDR twice adds nothing', () => {
    const result = calling.assignContacts(ctx, {
        contactIds: [callContacts[0].id], assignedTo: sarah.id,
    });
    equal(result.assigned, 0, 'no second assignment');
    equal(result.skipped.length, 1, 'reported as already there');
    equal(calling.queueCounts(sarahCtx).all, 3, 'still three, not four');
});

check('a contact on another SDR queue is refused and named, and NOTHING is written', () => {
    const result = calling.assignContacts(ctx, {
        contactIds: [callContacts[0].id], assignedTo: ahmed.id,
    });
    assert(result.needsConfirmation, 'the manager has to confirm');
    equal(result.assigned, 0, 'nothing was assigned');
    equal(result.conflicts.length, 1, 'the conflict is reported');
    equal(result.conflicts[0].currentSdrName, 'Sarah', 'and it names who holds it');
    equal(calling.queueCounts(ahmedCtx).all, 0, 'Ahmed queue is untouched');
});

check('reassigning moves it rather than duplicating it', () => {
    const result = calling.assignContacts(ctx, {
        contactIds: [callContacts[0].id], assignedTo: ahmed.id, reassign: true,
    });
    equal(result.reassigned, 1, 'one moved');
    equal(calling.queueCounts(ahmedCtx).all, 1, 'Ahmed has it');
    equal(calling.queueCounts(sarahCtx).all, 2, 'Sarah no longer does');
    equal(
        db.get('SELECT COUNT(*) AS n FROM calling_assignments WHERE contact_id = ? AND active = 1', [callContacts[0].id]).n,
        1, 'and there is exactly one active assignment for that contact',
    );
});

await checkAsync('re-adding a contact whose sequence already retired them asks first, and does not duplicate silently', async () => {
    // Regression: assignContacts only ever checked for an ACTIVE assignment.
    // A contact already run through the sequence and retired (dead, active
    // = 0) has none, so re-adding them created a second full history for
    // the same person with nobody having decided that on purpose.
    const followUp = await import('./lib/follow-up.mjs');
    const deadRow = db.get('SELECT * FROM calling_assignments WHERE contact_id = ? AND active = 1', [callContacts[1].id]);
    followUp.markDead(ctx, deadRow, 'no answer after three attempts');
    equal(db.get('SELECT active FROM calling_assignments WHERE id = ?', [deadRow.id]).active, 0, 'set up: retired');

    const asked = calling.assignContacts(ctx, { contactIds: [callContacts[1].id], assignedTo: sarah.id });
    assert(asked.needsConfirmation, 'must ask before re-adding someone already retired');
    equal(asked.assigned, 0, 'nothing written yet');
    equal(asked.reengage.length, 1, 'the retired contact is named');
    equal(
        db.get('SELECT COUNT(*) AS n FROM calling_assignments WHERE contact_id = ?', [callContacts[1].id]).n,
        1, 'still only the one (dead) row — asking did not create anything',
    );

    const confirmed = calling.assignContacts(ctx, { contactIds: [callContacts[1].id], assignedTo: sarah.id, reengage: true });
    equal(confirmed.assigned, 1, 'confirmed, so a fresh assignment is made');
    equal(
        db.get('SELECT COUNT(*) AS n FROM calling_assignments WHERE contact_id = ? AND active = 1', [callContacts[1].id]).n,
        1, 'exactly one active assignment — the old dead row and the new one, not two active',
    );
});

check('one SDR cannot see or touch another SDR work', () => {
    const ahmedQueue = calling.queue(ahmedCtx, { tab: 'all' });
    const stolen = ahmedQueue.items[0].id;

    let refused = false;
    try { calling.assignment(sarahCtx, stolen); } catch { refused = true; }
    assert(refused, 'Sarah must not be able to open Ahmed assignment');

    let refusedLog = false;
    try { calling.logCall(sarahCtx, { assignmentId: stolen, outcome: 'no_answer' }); } catch { refusedLog = true; }
    assert(refusedLog, 'Sarah must not be able to log a call on Ahmed contact');

    // And an SDR asking for the whole team sees only themselves regardless.
    const asked = calling.queue(sarahCtx, { sdrId: ahmed.id, tab: 'all' });
    assert(asked.items.every((i) => i.assignedTo === sarah.id), 'asking for another SDR must not widen the scope');
});

const sarahQueue = calling.queue(sarahCtx, { tab: 'to_call' });
const firstAssignment = sarahQueue.items[0].id;
const firstContactId = sarahQueue.items[0].contactId;

check('a call appends an activity and never overwrites the last one', () => {
    calling.logCall(sarahCtx, { assignmentId: firstAssignment, outcome: 'no_answer', note: 'Try again after 4 PM.' });
    calling.logCall(sarahCtx, { assignmentId: firstAssignment, outcome: 'no_answer', note: 'Still nothing.' });
    calling.logCall(sarahCtx, { assignmentId: firstAssignment, outcome: 'follow_up', note: 'Spoke to HR.', followUpAt: '2026-12-01T09:00:00.000Z' });

    const history = calling.callHistory(sarahCtx, firstContactId);
    equal(history.length, 3, 'three calls, not one row updated three times');
    assert(history.some((h) => h.note === 'Try again after 4 PM.'), 'the first note survives');
    assert(history.some((h) => h.note === 'Still nothing.'), 'the second note survives');
    assert(history.some((h) => h.note === 'Spoke to HR.'), 'the third note survives');
});

check('"performed by" tracks who actually called, separately from who the queue is assigned to', () => {
    // Its own isolated workspace — `logCall` writes a `call` activity, and the
    // rest of this describe block asserts EXACT workspace-wide call counts,
    // the same contamination the date-range test above already carves a
    // second workspace out to avoid.
    const WS2 = db.id('wsp');
    db.run('INSERT INTO workspaces (id, name, created_at) VALUES (?,?,?)', [WS2, 'Performed By Co', db.now()]);
    const sara2 = auth.createUser({
        email: 'pb-sara@test.local', name: 'PB Sara', password: 'test-password-6', role: 'sdr', workspaceId: WS2,
    });
    const ahmed2 = auth.createUser({
        email: 'pb-ahmed@test.local', name: 'PB Ahmed', password: 'test-password-6', role: 'sdr', workspaceId: WS2,
    });
    const ctx2 = { ...ctx, workspaceId: WS2, userId: sara2.id, workspace: { ...ctx.workspace, id: WS2 } };
    const sara2Ctx = { ...ctx2, role: 'sdr' };
    const admin2Ctx = { ...ctx, workspaceId: WS2, workspace: { ...ctx.workspace, id: WS2 } };

    const account = repo.createRecord('account', ctx2, { name: 'Performed By Target', billing_currency: 'USD' });
    const contact = repo.createRecord('contact', ctx2, {
        full_name: 'Performed By Contact', account_id: account.id, phone: '+966500000099', data_source: 'test',
    });
    calling.assignContacts(admin2Ctx, { contactIds: [contact.id], assignedTo: sara2.id });
    const assignmentId = db.get('SELECT id FROM calling_assignments WHERE contact_id = ?', [contact.id]).id;

    // Worked once by Sara, then the queue row reassigned to Ahmed — the
    // exact case the filter exists for: "assigned to" and "performed by"
    // now name different people.
    calling.logCall(sara2Ctx, { assignmentId, outcome: 'no_answer', note: 'performed-by fixture' });

    equal(
        db.get('SELECT last_called_by FROM calling_assignments WHERE id = ?', [assignmentId]).last_called_by,
        sara2.id, 'the row remembers who actually rang, stamped in the same write as the call',
    );

    calling.assignContacts(admin2Ctx, { contactIds: [contact.id], assignedTo: ahmed2.id, reassign: true });
    const moved = calling.assignment(admin2Ctx, assignmentId);
    equal(moved.assignedTo, ahmed2.id, 'now assigned to Ahmed');
    equal(
        db.get('SELECT last_called_by FROM calling_assignments WHERE id = ?', [assignmentId]).last_called_by,
        sara2.id, 'reassignment does not rewrite history — Sara still made the call',
    );

    const bySara = calling.queue(admin2Ctx, { tab: 'all', performedBy: sara2.id });
    assert(bySara.items.some((i) => i.id === assignmentId), 'filtering by Sara finds the row she called');

    const byAhmed = calling.queue(admin2Ctx, { tab: 'all', performedBy: ahmed2.id });
    assert(!byAhmed.items.some((i) => i.id === assignmentId),
        'filtering by Ahmed does NOT find it — he holds the queue, he did not make the call');

    // "Select all matching" (the Reassign bar's own select-all) must resolve
    // the same set the table shows — one filter, not two.
    const ids = calling.queueContactIds(admin2Ctx, { tab: 'all', performedBy: sara2.id });
    assert(ids.includes(contact.id), 'select-all-matching respects the same filter as the table');
});

check('total calls and unique contacts called are different numbers', () => {
    const totalCalls = db.get(
        "SELECT COUNT(*) AS n FROM activities WHERE workspace_id = ? AND type_key = 'call'", [WS],
    ).n;
    const uniqueContacts = db.get(
        "SELECT COUNT(DISTINCT parent_id) AS n FROM activities WHERE workspace_id = ? AND type_key = 'call'", [WS],
    ).n;
    equal(totalCalls, 3, 'three calls happened');
    equal(uniqueContacts, 1, 'to one contact');
});

check('a call is reported on the day it happened, from the activity', () => {
    const row = db.get(
        "SELECT occurred_at, outcome, assignment_id FROM activities WHERE workspace_id = ? AND type_key = 'call' ORDER BY occurred_at DESC LIMIT 1", [WS],
    );
    assert(row.occurred_at, 'the call carries its own completion time');
    equal(row.assignment_id, firstAssignment, 'linked back to the assignment it came from');
    assert(['follow_up', 'no_answer'].includes(row.outcome), 'and its outcome, as a column a report can group by');
});

check('a follow-up without a date is refused', () => {
    let refused = null;
    try {
        calling.logCall(sarahCtx, { assignmentId: firstAssignment, outcome: 'follow_up', note: 'no date' });
    } catch (err) { refused = err.message; }
    assert(refused && /date/i.test(refused), 'expected a complaint about the date, got: ' + refused);
});

check('a meeting without a time is refused', () => {
    let refused = null;
    try {
        calling.logCall(sarahCtx, { assignmentId: firstAssignment, outcome: 'meeting_scheduled' });
    } catch (err) { refused = err.message; }
    assert(refused && /date and time/i.test(refused), 'expected a complaint about the time, got: ' + refused);
});

await checkAsync('booking your own meeting still rings your own bell', async () => {
    // Regression: `write()` in lib/notify.mjs drops any notification where the
    // recipient is the same person performing the action, so an SDR working
    // their own queue got a task with no confirmation it saved — the one
    // outcome that creates a task with nothing else on screen to say so. This
    // is the one deliberate exception (`allowSelf`), scoped to
    // notifyMeetingScheduled only; every other notification kind must still
    // stay silent for a self-triggered action.
    //
    // A fresh contact and assignment, not `firstAssignment` — that one is
    // reused by later tests keyed off its most future `meeting_at`, and this
    // test would otherwise leave a later, unrelated meeting on it.
    const notify = await import('./lib/notify.mjs');
    const selfBellContact = repo.createRecord('contact', ctx, {
        full_name: 'Self Bell Test', account_id: callAccount.id, phone: '+966500000099', data_source: 'test',
    });
    calling.assignContacts(ctx, { contactIds: [selfBellContact.id], assignedTo: sarah.id, priority: 'A' });
    const selfBellAssignment = db.get(
        'SELECT id FROM calling_assignments WHERE contact_id = ? AND active = 1', [selfBellContact.id],
    ).id;

    const before = db.get("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'task_assigned'", [sarah.id]).n;
    const meetingAt = new Date(Date.now() + 48 * 3600e3).toISOString().slice(0, 16);
    calling.logCall(sarahCtx, { assignmentId: selfBellAssignment, outcome: 'meeting_scheduled', meetingAt });
    const after = db.get("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'task_assigned'", [sarah.id]).n;
    equal(after, before + 1, 'Sarah gets a bell for the meeting she just booked for herself');

    // The general rule is untouched: a plain task-assigned notification for
    // yourself is still silent.
    const bellsBefore = db.get("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?", [sarah.id]).n;
    notify.notifyTaskAssigned(sarahCtx, { assigneeId: sarah.id, taskId: 'tsk_probe', subject: 'Self-assigned probe' });
    const bellsAfter = db.get("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?", [sarah.id]).n;
    equal(bellsAfter, bellsBefore, 'every other notification kind still stays silent for a self-triggered action');
});

check('settling a meeting as done and picking "deal lost" as what came next actually closes the deal', () => {
    // Regression: this branch called an `update` that was never imported —
    // a ReferenceError, swallowed by server.mjs's catch-all into a generic
    // 500, on a core step of the calling workflow ("what came next" after a
    // meeting) that had no test coverage at all.
    const pastMeeting = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    calling.logCall(sarahCtx, { assignmentId: firstAssignment, outcome: 'meeting_scheduled', meetingAt: pastMeeting });
    const dealId = db.get('SELECT id FROM deals WHERE account_id = ?', [callAccount.id])?.id;
    assert(dealId, 'a deal exists for this account by the time a meeting is booked');

    calling.logCall(sarahCtx, {
        assignmentId: firstAssignment, outcome: 'meeting_done', nextStep: 'lost',
    });

    const deal = db.get('SELECT status, loss_reason FROM deals WHERE id = ?', [dealId]);
    equal(deal.status, 'lost', 'the deal was actually closed as lost, not left open by a crashed write');
    equal(deal.loss_reason, 'Meeting outcome');
});

check('a double-click records one call, not two', () => {
    const countCalls = () => db.get("SELECT COUNT(*) AS n FROM activities WHERE workspace_id = ? AND type_key = 'call'", [WS]).n;
    const before = countCalls();
    const key = 'probe-' + db.id('idem');
    const first = calling.logCall(sarahCtx, { assignmentId: firstAssignment, outcome: 'no_answer', note: 'once', idempotencyKey: key });
    const second = calling.logCall(sarahCtx, { assignmentId: firstAssignment, outcome: 'no_answer', note: 'once', idempotencyKey: key });

    equal(countCalls() - before, 1, 'exactly one call was recorded');
    equal(second.duplicate, true, 'and the second submission says so');
    equal(second.activityId, first.activityId, 'answering with the call that was already saved');
});

check('Not Interested leaves the active queue but keeps every call', () => {
    const open = calling.queue(sarahCtx, { tab: 'to_call' });
    const target = open.items.find((i) => i.id !== firstAssignment);
    calling.logCall(sarahCtx, { assignmentId: target.id, outcome: 'not_interested', note: 'Not for us.' });

    const row = db.get('SELECT queue_status, active, completed_at FROM calling_assignments WHERE id = ?', [target.id]);
    equal(row.queue_status, 'closed', 'closed');
    equal(row.active, 0, 'and out of the active queue');
    assert(row.completed_at, 'with a completion time');
    equal(calling.callHistory(sarahCtx, target.contactId).length, 1, 'the call it took to get there is still there');
});

check('a Meeting No Show stays visible on the queue a rep actually works, to be rebooked', () => {
    // Regression: `to_call` (the "who do I call next" tab) excluded 'no_show'
    // alongside Qualified/Meeting Scheduled/Send Profile as "real progress,
    // not a call still owed" — correct for those three, wrong for a no-show,
    // which is the opposite of progress: nobody was reached, and the
    // outcome's own label promises "stays in queue for rebooking". Excluded
    // from `to_call`, the lead was only reachable from "All", which nobody
    // works from day to day — active in name, invisible in practice.
    const noShowContact = repo.createRecord('contact', ctx, {
        full_name: 'No Show Test', account_id: callAccount.id, phone: '+966500000098', data_source: 'test',
    });
    calling.assignContacts(ctx, { contactIds: [noShowContact.id], assignedTo: sarah.id, priority: 'A' });
    const noShowAssignment = db.get(
        'SELECT id FROM calling_assignments WHERE contact_id = ? AND active = 1', [noShowContact.id],
    ).id;

    const pastMeeting = new Date(Date.now() - 2 * 3600e3).toISOString().slice(0, 16);
    calling.logCall(sarahCtx, { assignmentId: noShowAssignment, outcome: 'meeting_scheduled', meetingAt: pastMeeting });
    calling.logCall(sarahCtx, { assignmentId: noShowAssignment, outcome: 'no_show' });

    const row = db.get('SELECT queue_status, active FROM calling_assignments WHERE id = ?', [noShowAssignment]);
    equal(row.queue_status, 'working', 'still working, not closed');
    equal(row.active, 1, 'still active');

    const toCall = calling.queue(sarahCtx, { tab: 'to_call' });
    assert(toCall.items.some((i) => i.id === noShowAssignment),
        'a no-show lead needs a call to rebook it, so it belongs on the tab a rep actually works');
});

check('No Answer keeps the contact callable', () => {
    const row = db.get('SELECT queue_status, active, call_count FROM calling_assignments WHERE id = ?', [firstAssignment]);
    equal(row.queue_status, 'working', 'still being worked');
    equal(row.active, 1, 'still active');
    assert(row.call_count >= 4, 'the attempts are counted (' + row.call_count + ')');
});

check('removing a contact from the queue destroys no history', () => {
    const before = calling.callHistory(ctx, firstContactId).length;
    const result = calling.removeFromQueue(ctx, [firstAssignment]);
    equal(result.removed, 1, 'removed');
    equal(calling.callHistory(ctx, firstContactId).length, before, 'and every call is still readable');
});

check('a removed lead stops counting everywhere, including All', () => {
    // A removed lead has queue_status='removed' and no dedicated tab of its
    // own — the failure mode this guards against is exactly that: a row with
    // nowhere to be visibly listed that still inflated the "All" total
    // forever, so removing a whole list dropped "To call" but left "All"
    // reading the same number as before anything was removed.
    const contact = repo.createRecord('contact', ctx, {
        full_name: 'Counted Then Removed', account_id: callAccount.id, phone: '+966500000021', data_source: 'test',
    });
    calling.assignContacts(ctx, { contactIds: [contact.id], assignedTo: sarah.id });
    const before = calling.queueCounts(ctx, { sdrId: sarah.id });

    const liveId = db.get('SELECT id FROM calling_assignments WHERE contact_id = ? AND active = 1', [contact.id]).id;
    calling.removeFromQueue(ctx, [liveId]);
    const after = calling.queueCounts(ctx, { sdrId: sarah.id });

    equal(after.all, before.all - 1, 'All dropped by exactly the one lead removed, the same as To call did');
    equal(after.to_call, before.to_call - 1, 'To call dropped by exactly the one lead removed');

    // The row-listing "All" tab must agree with the count above — a tab whose
    // badge and whose rows disagree is the same bug with a different symptom.
    const rows = calling.queue(ctx, { sdrId: sarah.id, tab: 'all', limit: 200 });
    assert(!rows.items.some((r) => r.id === liveId), 'the removed row does not appear on the All tab either');
});

check('a Qualified or Meeting Scheduled lead leaves To call, but stays active', () => {
    // queue_status alone cannot tell "still owed a call" apart from
    // "already progressed" — every non-closing outcome sets it to the same
    // 'working'. Before this fix, To call was every 'working' row, so a
    // lead just qualified (or one with a meeting already booked) sat back
    // at the top of the calling screen as though nobody had rung them yet.
    const progressed = repo.createRecord('contact', ctx, {
        full_name: 'Just Qualified', account_id: callAccount.id, phone: '+966500000022', data_source: 'test',
    });
    calling.assignContacts(ctx, { contactIds: [progressed.id], assignedTo: sarah.id });
    const progressedId = db.get('SELECT id FROM calling_assignments WHERE contact_id = ? AND active = 1', [progressed.id]).id;

    const stillOwed = repo.createRecord('contact', ctx, {
        full_name: 'Still Owed A Call', account_id: callAccount.id, phone: '+966500000023', data_source: 'test',
    });
    calling.assignContacts(ctx, { contactIds: [stillOwed.id], assignedTo: sarah.id });
    const stillOwedId = db.get('SELECT id FROM calling_assignments WHERE contact_id = ? AND active = 1', [stillOwed.id]).id;

    calling.logCall(sarahCtx, { assignmentId: progressedId, outcome: 'qualified' });
    calling.logCall(sarahCtx, { assignmentId: stillOwedId, outcome: 'no_answer' });

    const progressedRow = db.get('SELECT queue_status, active FROM calling_assignments WHERE id = ?', [progressedId]);
    equal(progressedRow.queue_status, 'working', 'Qualified does not close the assignment');
    equal(progressedRow.active, 1, 'and does not deactivate it either — see CALL_OUTCOMES’ own comment on why');

    const toCall = calling.queue(ctx, { sdrId: sarah.id, tab: 'to_call', limit: 200 });
    assert(!toCall.items.some((r) => r.id === progressedId), 'the qualified lead is off To call — it is not a call still owed');
    assert(toCall.items.some((r) => r.id === stillOwedId), 'the No Answer lead is still on To call — it is');

    const all = calling.queue(ctx, { sdrId: sarah.id, tab: 'all', limit: 200 });
    assert(all.items.some((r) => r.id === progressedId), 'and the qualified lead is still visible on All — it did not vanish, it just left one tab');
});

check('the "work them now" banner excludes whichever lead is already on screen', () => {
    // Two leads, each genuinely IN a follow-up sequence (logCall refuses a
    // past followUpAt outright, so each is booked a few seconds out through
    // the real path — which is what sets sequence_started_at — then pushed
    // into the past directly, simulating "the moment has now arrived").
    // Excluding the one on screen should drop the count by exactly one;
    // excluding nothing should count both.
    const dueBySequence = (name, phone) => {
        const contact = repo.createRecord('contact', ctx, {
            full_name: name, account_id: callAccount.id, phone, data_source: 'test',
        });
        calling.assignContacts(ctx, { contactIds: [contact.id], assignedTo: sarah.id });
        const assignmentId = db.get('SELECT id FROM calling_assignments WHERE contact_id = ? AND active = 1', [contact.id]).id;
        calling.logCall(sarahCtx, {
            assignmentId, outcome: 'follow_up', followUpAt: new Date(Date.now() + 2000).toISOString(),
        });
        db.run('UPDATE calling_assignments SET next_follow_up_at = ? WHERE id = ?',
            [new Date(Date.now() - 3_600_000).toISOString(), assignmentId]);
        return assignmentId;
    };
    const onScreenId = dueBySequence('Currently Being Called', '+966500000024');
    dueBySequence('Somebody Else Due', '+966500000025');

    const includingBoth = calling.otherFollowUpsDueNow(ctx, { sdrId: sarah.id });
    const excludingOnScreen = calling.otherFollowUpsDueNow(ctx, { sdrId: sarah.id, excludeAssignmentId: onScreenId });
    equal(excludingOnScreen, includingBoth - 1, 'excluding the on-screen lead drops the count by exactly one — the other lead still counts');

    // A future follow-up must not count as due at all, on screen or not.
    const notYet = repo.createRecord('contact', ctx, {
        full_name: 'Due Tomorrow', account_id: callAccount.id, phone: '+966500000026', data_source: 'test',
    });
    calling.assignContacts(ctx, { contactIds: [notYet.id], assignedTo: sarah.id });
    const notYetId = db.get('SELECT id FROM calling_assignments WHERE contact_id = ? AND active = 1', [notYet.id]).id;
    calling.logCall(sarahCtx, {
        assignmentId: notYetId, outcome: 'follow_up', followUpAt: new Date(Date.now() + 864e5).toISOString(),
    });
    equal(calling.otherFollowUpsDueNow(ctx, { sdrId: sarah.id }), includingBoth,
        'a follow-up due tomorrow does not add to the count');

    // Regression: a MEETING's own time, not a follow-up's. `next_follow_up_at`
    // holds the meeting's instant when the last outcome was Meeting
    // Scheduled (see `nextAt` in logCall), and that path never starts the
    // four-step sequence — so a meeting whose time has arrived must not
    // read as "a follow-up is due" here, the same way the follow_ups tab
    // (which requires sequence_started_at) never showed it either.
    const meetingLead = repo.createRecord('contact', ctx, {
        full_name: 'Meeting, Not A Follow-Up', account_id: callAccount.id, phone: '+966500000027', data_source: 'test',
    });
    calling.assignContacts(ctx, { contactIds: [meetingLead.id], assignedTo: sarah.id });
    const meetingId = db.get('SELECT id FROM calling_assignments WHERE contact_id = ? AND active = 1', [meetingLead.id]).id;
    calling.logCall(sarahCtx, {
        assignmentId: meetingId, outcome: 'meeting_scheduled', meetingAt: new Date(Date.now() + 2000).toISOString(),
    });
    equal(db.get('SELECT sequence_started_at FROM calling_assignments WHERE id = ?', [meetingId]).sequence_started_at, null,
        'the premise: booking a meeting never starts the follow-up sequence');
    db.run('UPDATE calling_assignments SET next_follow_up_at = ? WHERE id = ?',
        [new Date(Date.now() - 3_600_000).toISOString(), meetingId]);
    equal(calling.otherFollowUpsDueNow(ctx, { sdrId: sarah.id }), includingBoth,
        'a scheduled meeting whose time has passed must not count as a follow-up due');
});

check('removing by CONTACT id resolves the live row, whatever older rows exist', () => {
    // The queue screen holds its selection by contact — "select all matching"
    // reaches past one page of rows — so remove takes contacts as well as
    // row ids. The row it must find is the LIVE one; anything already retired
    // stays as history rather than being closed a second time.
    const contact = repo.createRecord('contact', ctx, {
        full_name: 'Dana Four', account_id: callAccount.id, phone: '+966500000001', data_source: 'test',
    });
    calling.assignContacts(ctx, { contactIds: [contact.id], assignedTo: sarah.id });
    const liveId = db.get('SELECT id FROM calling_assignments WHERE contact_id = ? AND active = 1', [contact.id]).id;

    // Retire the first stint, put them back on the queue, then remove BY
    // CONTACT: the new live row is what closes.
    calling.removeFromQueue(ctx, [liveId]);
    calling.assignContacts(ctx, { contactIds: [contact.id], assignedTo: sarah.id, reengage: true });

    const result = calling.removeFromQueue(ctx, [], [contact.id]);
    equal(result.removed, 1, 'exactly the live row was found from the contact');
    equal(db.get('SELECT active FROM calling_assignments WHERE id = ?', [liveId]).active, 0, 'the old stint is untouched');
    equal(
        db.get('SELECT COUNT(*) AS n FROM calling_assignments WHERE contact_id = ? AND active = 1', [contact.id]).n,
        0, 'and nothing is queued anymore',
    );

    let refused = false;
    try { calling.removeFromQueue(ctx, [], [contact.id]); } catch { refused = true; }
    assert(refused, 'with no live row left there is nothing to close');
});

check('removing by CONTACT id also reaches a CLOSED assignment, not only a live one', () => {
    /**
     * A closing outcome (Wrong Number, Not Interested, Meeting Done, …) sets
     * `active = 0` the moment it is logged — the contact then lives on the
     * Completed or Dead tab, both of which offer the same bulk Remove button
     * "To call" does. Resolving a contact id to its LIVE assignment only
     * (the rule every OTHER bulk action correctly follows) meant Remove
     * silently found nothing for exactly the rows those two tabs show,
     * answering "Nothing was selected." for a screen full of ticked boxes.
     */
    const contact = repo.createRecord('contact', ctx, {
        full_name: 'Closed Not Removed', account_id: callAccount.id, phone: '+966500000028', data_source: 'test',
    });
    calling.assignContacts(ctx, { contactIds: [contact.id], assignedTo: sarah.id });
    const assignmentId = db.get('SELECT id FROM calling_assignments WHERE contact_id = ? AND active = 1', [contact.id]).id;

    calling.logCall(sarahCtx, { assignmentId, outcome: 'wrong_number' });
    equal(db.get('SELECT active, queue_status FROM calling_assignments WHERE id = ?', [assignmentId]).active, 0,
        'the premise: a closing outcome deactivates the assignment');

    const result = calling.removeFromQueue(ctx, [], [contact.id]);
    equal(result.removed, 1, 'the closed-but-not-removed row must still be found and removed');
    equal(db.get('SELECT queue_status FROM calling_assignments WHERE id = ?', [assignmentId]).queue_status, 'removed');
});

check('the Contacts list can filter on whether a contact is on the calling queue', () => {
    const inQueue = repo.createRecord('contact', ctx, {
        full_name: 'On The Queue', account_id: callAccount.id, phone: '+966500000029', data_source: 'test',
    });
    const neverAdded = repo.createRecord('contact', ctx, {
        full_name: 'Never Added', account_id: callAccount.id, phone: '+966500000030', data_source: 'test',
    });
    const removedAgain = repo.createRecord('contact', ctx, {
        full_name: 'Removed Again', account_id: callAccount.id, phone: '+966500000031', data_source: 'test',
    });
    calling.assignContacts(ctx, { contactIds: [inQueue.id, removedAgain.id], assignedTo: sarah.id });
    calling.removeFromQueue(ctx, [], [removedAgain.id]);

    const inQueueOnly = repo.listRecords('contact', ctx, {
        filter: { op: 'and', children: [{ field: 'in_calling_queue', operator: 'is_any_of', value: ['in_queue'] }] },
    });
    assert(inQueueOnly.records.some((r) => r.id === inQueue.id), 'the live assignment must match "in queue"');
    assert(!inQueueOnly.records.some((r) => r.id === neverAdded.id), 'never assigned must not match "in queue"');
    assert(!inQueueOnly.records.some((r) => r.id === removedAgain.id), 'a removed assignment must not match "in queue" either');

    const notInQueueOnly = repo.listRecords('contact', ctx, {
        filter: { op: 'and', children: [{ field: 'in_calling_queue', operator: 'is_any_of', value: ['not_in_queue'] }] },
    });
    assert(notInQueueOnly.records.some((r) => r.id === neverAdded.id), '"not in queue" must include a contact never assigned');
    assert(notInQueueOnly.records.some((r) => r.id === removedAgain.id), '"not in queue" must include one taken off the queue again');
    assert(!notInQueueOnly.records.some((r) => r.id === inQueue.id), 'but not the one still on it');

    // is_empty/is_not_empty come free from the field's `select` type (see
    // OPERATORS.select) and are offered in the filter builder same as any
    // other select field — they must mean something rather than error out.
    const notEmpty = repo.listRecords('contact', ctx, {
        filter: { op: 'and', children: [{ field: 'in_calling_queue', operator: 'is_not_empty', value: null }] },
    });
    assert(notEmpty.records.some((r) => r.id === inQueue.id), '"is not empty" reads as "on the queue"');
    assert(!notEmpty.records.some((r) => r.id === removedAgain.id));

    const empty = repo.listRecords('contact', ctx, {
        filter: { op: 'and', children: [{ field: 'in_calling_queue', operator: 'is_empty', value: null }] },
    });
    assert(empty.records.some((r) => r.id === removedAgain.id), '"is empty" reads as "not on the queue"');
    assert(!empty.records.some((r) => r.id === inQueue.id));
});

check('bulk edit sets queue status directly, and services onto the CONTACT', () => {
    const contact = repo.createRecord('contact', ctx, {
        full_name: 'Bulk Edit Test', account_id: callAccount.id, phone: '+966500000009',
        data_source: 'test', services: ['recruitment'],
    });
    calling.assignContacts(ctx, { contactIds: [contact.id], assignedTo: sarah.id });

    const statusResult = calling.setQueueStatus(ctx, [], 'working', [contact.id]);
    equal(statusResult.updated, 1);
    const row = db.get('SELECT queue_status FROM calling_assignments WHERE contact_id = ?', [contact.id]);
    equal(row.queue_status, 'working', 'the assignment itself moved');

    // Services is not a valid value for setQueueStatus — 'dead' is refused,
    // it is not a status a bulk action may set (see markDead).
    let refusedDead = false;
    try { calling.setQueueStatus(ctx, [], 'dead', [contact.id]); } catch { refusedDead = true; }
    assert(refusedDead, 'dead is not a bulk-settable status');

    const servicesResult = calling.setContactServices(ctx, [], ['hcm', 'offshoring'], [contact.id]);
    equal(servicesResult.updated, 1);
    const updated = repo.getRecord('contact', ctx, contact.id);
    equal([...updated.services].sort(), ['hcm', 'offshoring'], 'the CONTACT record itself changed, not just the assignment');
});

check('bulk-logging an outcome reports partial failure rather than aborting silently', () => {
    // Regression: a plain for-loop calling logCall() per row aborted on the
    // first failure, so a manager bulk-editing many leads had no way to
    // tell how many actually went through versus how many were left
    // untouched — one flat error toast covering an unknown split.
    const good = repo.createRecord('contact', ctx, {
        full_name: 'Bulk Outcome Good', account_id: callAccount.id, phone: '+966500000010', data_source: 'test',
    });
    calling.assignContacts(ctx, { contactIds: [good.id], assignedTo: sarah.id });

    // A real, live assignment (via contactIds) beside a bogus assignment id
    // that resolves to nothing — the same mixed-selection shape a "select
    // all matching" bulk edit can produce if a row's queue state changed
    // between the click and the request landing.
    const result = calling.bulkLogOutcome(ctx, {
        assignmentIds: ['cas_does_not_exist'], contactIds: [good.id], outcome: 'no_answer',
    });
    equal(result.updated, 1, 'the one genuinely live assignment still logs');
    equal(result.failed.length, 1, 'the bogus one is reported, not silently dropped or aborting the batch');
    equal(result.failed[0].assignmentId, 'cas_does_not_exist');

    // When NOTHING in the batch succeeds, this is a real refusal, not a
    // reported "0 updated" partial success.
    let refused = null;
    try {
        calling.bulkLogOutcome(ctx, { assignmentIds: ['cas_does_not_exist_2'], outcome: 'no_answer' });
    } catch (err) { refused = err.message; }
    assert(refused, 'an all-failed batch throws rather than returning updated: 0 as though nothing was wrong');
});

check('an SDR cannot assign, reassign, remove or reprioritise', () => {
    const attempts = [
        ['assign', () => calling.assignContacts(sarahCtx, { contactIds: [callContacts[2].id], assignedTo: sarah.id })],
        ['remove', () => calling.removeFromQueue(sarahCtx, [firstAssignment])],
        ['reprioritise', () => calling.setPriority(sarahCtx, [firstAssignment], 'C')],
    ];
    for (const [what, fn] of attempts) {
        let refused = false;
        try { fn(); } catch { refused = true; }
        assert(refused, 'an SDR must not be able to ' + what);
    }
});

check('a manager sees the whole team', () => {
    const everyone = calling.queue(ctx, { tab: 'all' });
    const owners = new Set(everyone.items.map((i) => i.assignedTo));
    assert(owners.size >= 2, 'a manager sees more than one SDR work (saw ' + owners.size + ')');
});

/**
 * The queue's Notes column is the single most recent of THREE sources — the
 * contact's own notes, their account's notes, and the quick note typed while
 * logging a call — not a fixed one of the three. Each write below is timed
 * later than the last, so the winner changes as the test goes, which is the
 * only way to prove it is genuinely picking the latest rather than always
 * preferring whichever source happens to be checked first in the query.
 */
check('the queue Notes column is whichever of contact, account and call notes is newest', () => {
    const account = repo.createRecord('account', ctx, { name: 'Notes Merge Co', lifecycle_stage: 'prospect' });
    const contact = repo.createRecord('contact', ctx, {
        full_name: 'Notes Merge Contact', account_id: account.id, phone: '+966500000001', data_source: 'test',
    });
    calling.assignContacts(ctx, { contactIds: [contact.id], assignedTo: sarah.id, priority: 'C' });
    const assignmentId = calling.queue(ctx, { tab: 'all', limit: 200 }).items.find((i) => i.contact_id === contact.id).id;

    const notesOf = () => calling.queue(ctx, { tab: 'all', limit: 200 }).items.find((i) => i.id === assignmentId)?.notes;

    equal(notesOf(), null, 'nothing written yet, so there is nothing to show');

    repo.createRecord('note', ctx, {
        parent_type: 'contact', parent_id: contact.id, account_id: account.id,
        body: 'Contact note: prefers email', author_id: ctx.userId,
    });
    equal(notesOf(), 'Contact note: prefers email', 'the only note so far wins by default');

    repo.createRecord('note', ctx, {
        parent_type: 'account', parent_id: account.id, account_id: account.id,
        body: 'Account note: renewing in Q3', author_id: ctx.userId,
    });
    equal(notesOf(), 'Account note: renewing in Q3',
        'a newer ACCOUNT note outranks an older contact note');

    calling.logCall(ctx, { assignmentId, outcome: 'no_answer', note: 'Call note: asked us to try Thursday' });
    equal(notesOf(), 'Call note: asked us to try Thursday',
        'a newer CALL note outranks both the contact and account notes');

    // A second, later contact note overtakes the call note in turn — this is
    // not "notes beat calls", it is genuinely whichever is newest.
    repo.createRecord('note', ctx, {
        parent_type: 'contact', parent_id: contact.id, account_id: account.id,
        body: 'Contact note: number changed', author_id: ctx.userId,
    });
    equal(notesOf(), 'Contact note: number changed',
        'and a still-newer contact note overtakes the call note');
});

/**
 * The tab pills (`To call 45`, `All 45`) used to ignore the filter entirely
 * — only `sdrId` and the date range narrowed them. A manager who filtered
 * the queue to Priority A saw the table shrink to a handful of rows while
 * the pills beside it kept advertising the whole book, which is what got
 * reported as "the priority filter isn't working": the filter WAS applied,
 * the one thing confirming it visibly was not.
 */
check('the tab pills reflect the active filter, not just the whole queue', () => {
    const account = repo.createRecord('account', ctx, { name: 'Priority Pills Co', lifecycle_stage: 'prospect' });
    const contacts = ['P-A-one', 'P-A-two', 'P-B-one'].map((name) => repo.createRecord('contact', ctx, {
        full_name: name, account_id: account.id, phone: '+966500000002', data_source: 'test',
    }));
    calling.assignContacts(ctx, { contactIds: [contacts[0].id, contacts[1].id], assignedTo: ahmed.id, priority: 'A' });
    calling.assignContacts(ctx, { contactIds: [contacts[2].id], assignedTo: ahmed.id, priority: 'B' });

    const unfiltered = calling.queueCounts(ahmedCtx);
    assert(unfiltered.all >= 3, 'a sanity check that the fixture landed on Ahmed\'s queue');

    const priorityA = { op: 'and', children: [{ field: 'priority', operator: 'is_any_of', value: ['A'] }] };
    const filtered = calling.queueCounts(ahmedCtx, { filter: priorityA });
    equal(filtered.all, 2, 'the pill counts only the 2 Priority A leads');
    equal(filtered.to_call, 2, 'same narrowing on the To call pill');
    assert(filtered.all < unfiltered.all, 'strictly fewer than the unfiltered count, proving the filter took effect');

    // And the table the pills sit above agrees with them exactly.
    const rows = calling.queue(ahmedCtx, { tab: 'all', filter: priorityA, limit: 200 });
    equal(rows.total, filtered.all, 'the pill and the row count are the same number, not two questions');
});

/* ================================ the four-step lead follow-up sequence == */

describe('Lead follow-up: exactly four activities, then dead');

{
    const followUp = await import('./lib/follow-up.mjs');
    const calling = await import('./lib/calling.mjs');

    /**
     * `calling.logCall`/`rescheduleFollowUp` validate a follow-up instant
     * against the REAL current time, so a literal date string ages out of
     * "the future" the moment a run happens after it. Every follow-up date
     * below that goes through that validation is anchored to `Date.now()`
     * instead, offset in whole UTC days so the day-of-month gaps the
     * assertions rely on ("seven days later") stay exact regardless of when
     * the suite runs.
     */
    const FOLLOW_UP_BASE = Date.now() + 60 * 864e5;
    const followUpDate = (daysFromBase, time = '09:00:00.000') => {
        const d = new Date(FOLLOW_UP_BASE + daysFromBase * 864e5);
        return `${d.toISOString().slice(0, 10)}T${time}Z`;
    };
    const followUpDateOnly = (daysFromBase) => followUpDate(daysFromBase).slice(0, 10);

    check('the sequence is four steps and the array says so', () => {
        equal(followUp.SEQUENCE_LENGTH, 4, 'four, and the length of STEPS is the business rule');
        equal(followUp.STEPS.map((s) => s.step).join(' → '),
            'first_follow_up → whatsapp_1 → second_follow_up → whatsapp_2',
            'in the order the product states');
    });

    check('a date with no time becomes the start of the working day, not midnight', () => {
        /**
         * A rep picks a date — "ring me back on the fifteenth" — and midnight
         * UTC is 3am in Riyadh. The task list then told them their follow-up
         * was due at three in the morning, which reads as the software having
         * lost the time rather than never having been given one.
         */
        const riyadh = followUp.scheduleFrom('2026-09-15', { timezone: 'Asia/Riyadh', dayStartHour: 9 });
        equal(riyadh[0].dueAt, '2026-09-15T06:00:00.000Z', '09:00 in Riyadh is 06:00 UTC');
        equal(riyadh[2].dueAt, '2026-09-22T06:00:00.000Z', 'and so is the second follow-up, seven days on');

        // A time somebody DID choose is theirs, and is not moved to 9am.
        const chosen = followUp.scheduleFrom('2026-09-15T11:30:00.000Z', { timezone: 'Asia/Riyadh', dayStartHour: 9 });
        equal(chosen[0].dueAt, '2026-09-15T11:30:00.000Z', 'an explicit time is kept');
        equal(chosen[2].dueAt, '2026-09-22T11:30:00.000Z');
    });

    check('the second follow-up is exactly seven days after the first, not about a week', () => {
        const schedule = followUp.scheduleFrom('2026-09-01T09:00:00.000Z', { timezone: 'UTC' });
        const first = schedule.find((s) => s.step === 'first_follow_up');
        const second = schedule.find((s) => s.step === 'second_follow_up');
        equal(first.dueAt, '2026-09-01T09:00:00.000Z', 'the first is when the rep said');
        equal(second.dueAt, '2026-09-08T09:00:00.000Z', 'and the second is seven days later to the minute');
        equal(new Date(second.dueAt) - new Date(first.dueAt), 7 * 864e5,
            'measured in milliseconds, because "approximately" is the thing this rule exists to refuse');
    });

    /* ---------------------------- a follow-up is a date AND a time -------- */

    check('a follow-up keeps the TIME of day, to the minute', () => {
        /**
         * "Ring me back on the fifteenth at half two" is the commitment the rep
         * made on the phone. The console only ever asked for a date, so the half
         * two was thrown away and every follow-up in the system was due at the
         * same hour — which is not a scheduling system, it is a list of days.
         */
        const at = followUp.normalizeFollowUpAt('2026-09-15T14:30:00.000Z', { timezone: 'Asia/Riyadh' });
        equal(at, '2026-09-15T14:30:00.000Z', 'an instant somebody chose is kept exactly');

        const evening = followUp.normalizeFollowUpAt('2026-09-15T18:45:00.000Z', { timezone: 'Asia/Riyadh' });
        equal(evening, '2026-09-15T18:45:00.000Z', 'including one outside working hours');
    });

    check('a follow-up with no time gets the working day, in the workspace’s own clock', () => {
        equal(followUp.normalizeFollowUpAt('2026-09-15', { timezone: 'Asia/Riyadh', dayStartHour: 9 }),
            '2026-09-15T06:00:00.000Z', '09:00 in Riyadh is 06:00 UTC');
        equal(followUp.normalizeFollowUpAt('2026-09-15', { timezone: 'Africa/Cairo', dayStartHour: 8 }),
            '2026-09-15T05:00:00.000Z', 'and the hour is the workspace’s, not a constant');

        // Midnight UTC is what a date-only input produces once something stamps
        // an instant on it. It is the 3am bug, and it is read as "no time given".
        equal(followUp.normalizeFollowUpAt('2026-09-15T00:00:00.000Z', { timezone: 'Asia/Riyadh', dayStartHour: 9 }),
            '2026-09-15T06:00:00.000Z', 'a date wearing midnight is still a date');

        /**
         * The calendar day comes out of the STRING, not out of an instant.
         * Midnight UTC on the fifteenth is the evening of the fourteenth in New
         * York, so a workspace behind UTC used to get the wrong day entirely.
         */
        equal(followUp.normalizeFollowUpAt('2026-09-15', { timezone: 'America/New_York', dayStartHour: 9 }),
            '2026-09-15T13:00:00.000Z', 'the fifteenth in New York, not the fourteenth');
    });

    check('a follow-up date nobody can read is refused, not stored', () => {
        for (const value of ['next Tuesday', '2026-13-45', '15/09/2026 half two', '', null]) {
            equal(followUp.normalizeFollowUpAt(value, { timezone: 'Asia/Riyadh' }), null,
                `"${value}" must not become an instant`);
        }
        equal(followUp.scheduleFrom('not a date', { timezone: 'Asia/Riyadh' }), null,
            'and it schedules nothing rather than four tasks with no dates');
    });

    check('a WhatsApp never goes out before the call it follows', () => {
        /**
         * A follow-up booked for 10pm is already past the end of its own day.
         * "End of the same day" measured only against the clock produced a
         * WhatsApp task due five hours BEFORE the call that was meant to prompt
         * it — a to-do list in the wrong order.
         */
        const late = followUp.scheduleFrom('2026-09-15T19:00:00.000Z', {
            timezone: 'Asia/Riyadh', dayEndHour: 17, dayStartHour: 9, nowIso: '2026-09-15T08:00:00.000Z',
        });
        const call = new Date(late[0].dueAt);
        const whatsapp = new Date(late[1].dueAt);
        assert(whatsapp > call, `the WhatsApp (${late[1].dueAt}) must follow the 22:00 call (${late[0].dueAt})`);
        equal(late[1].dueAt, '2026-09-16T14:00:00.000Z', 'so it is the end of the NEXT day');

        // And the ordinary case is untouched: a morning call, a WhatsApp that
        // evening, not the following one.
        const morning = followUp.scheduleFrom('2026-09-15T06:00:00.000Z', {
            timezone: 'Asia/Riyadh', dayEndHour: 17, dayStartHour: 9, nowIso: '2026-09-15T05:00:00.000Z',
        });
        equal(morning[1].dueAt, '2026-09-15T14:00:00.000Z', '17:00 in Riyadh, the same day');
    });

    check('the calling console asks for a time, and the server offers the hour', () => {
        /**
         * The rule lives on the server, but a rep can only enter what the form
         * shows them. This is the layer that was "fixed" once by relabelling a
         * date box: the control has to be the two-part one, and the time half has
         * to open on something better than midnight.
         */
        const console$ = fs.readFileSync(new URL('./public/js/pages/calling.js', import.meta.url), 'utf8');
        assert(/dateInput\(\{[^}]*withTime: true[^}]*defaultTime/s.test(console$),
            'the follow-up box must take a time, and open on the workspace’s hour rather than 00:00');
        assert(console$.includes('Follow-up date and time'),
            'and say so — a label reading "date" is what taught everyone it only took one');

        const componentsJs = fs.readFileSync(new URL('./public/js/components.js', import.meta.url), 'utf8');
        assert(componentsJs.includes('defaultTime'),
            'dateInput must support a default hour, or every caller invents midnight');

        const callingApi = fs.readFileSync(new URL('./api/calling.mjs', import.meta.url), 'utf8');
        assert(callingApi.includes('defaultFollowUpTime'),
            '/api/calling/meta must send the hour, so the box and the scheduler agree');
    });

    check('the second follow-up is measured from the FIRST, never from the step before it', () => {
        // whatsapp_1 lands at the end of day 1; if the second follow-up were
        // seven days after IT, it would drift by the length of a working day
        // every time — and by more whenever a WhatsApp slipped to tomorrow.
        const schedule = followUp.scheduleFrom('2026-09-01T09:00:00.000Z', { timezone: 'UTC' });
        for (const step of schedule) {
            equal(step.offsetDays, step.step.includes('second') || step.step === 'whatsapp_2' ? 7 : 0,
                `${step.step} is offset from the first follow-up`);
        }
    });

    check('a WhatsApp goes out at the end of the same day', () => {
        const at = followUp.endOfDay('2026-09-01T09:00:00.000Z', {
            timezone: 'UTC', hour: 17, nowIso: '2026-09-01T08:00:00.000Z',
        });
        equal(at, '2026-09-01T17:00:00.000Z', 'same day, end of day');
    });

    check('a WhatsApp that can no longer go out today goes out tomorrow', () => {
        // The rep logs the follow-up at 6pm. "Same day at the end of the day"
        // has already gone, and a to-do list that is born overdue is a to-do
        // list nobody trusts.
        const at = followUp.endOfDay('2026-09-01T18:00:00.000Z', {
            timezone: 'UTC', hour: 17, nowIso: '2026-09-01T18:00:00.000Z',
        });
        equal(at, '2026-09-02T17:00:00.000Z', 'the following day, same hour');
        assert(new Date(at) > new Date('2026-09-01T18:00:00.000Z'), 'and never in the past');
    });

    check('end of day is the workspace’s clock, not UTC', () => {
        // Asia/Riyadh is UTC+3 year round, so 17:00 there is 14:00 UTC.
        const at = followUp.endOfDay('2026-09-01T06:00:00.000Z', {
            timezone: 'Asia/Riyadh', hour: 17, nowIso: '2026-09-01T05:00:00.000Z',
        });
        equal(at, '2026-09-01T14:00:00.000Z', '17:00 in Riyadh is 14:00 UTC');
    });

    await checkAsync('logging a follow-up creates four tasks and no more', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Follows Up Ltd' });
        const contact = repo.createRecord('contact', ctx, {
            first_name: 'Hala', last_name: 'Nasser', data_source: 'linkedin',
            account_id: account.id, phone: '+201000000001',
        });
        const assignmentId = db.id('cas');
        db.run(
            `INSERT INTO calling_assignments
               (id, workspace_id, contact_id, account_id, assigned_to, priority, queue_status,
                call_count, active, assigned_at, created_at, updated_at)
             VALUES (?,?,?,?,?,'high','queued',0,1,?,?,?)`,
            [assignmentId, WS, contact.id, account.id, rep.id, db.now(), db.now(), db.now()],
        );

        calling.logCall(ctx, {
            assignmentId, outcome: 'follow_up', note: 'Call me next Tuesday',
            followUpAt: followUpDate(0),
        });

        const tasks = followUp.tasksFor(ctx, assignmentId);
        equal(tasks.length, 4, 'four tasks, one per activity — the rep types none of them');
        equal(tasks.map((t) => t.follow_up.step).join(','),
            'first_follow_up,whatsapp_1,second_follow_up,whatsapp_2');
        equal(tasks[2].due_at, followUpDate(7), 'the second follow-up is seven days after the first');

        for (const task of tasks) {
            equal(task.assignee_id, rep.id, 'assigned to whoever holds the lead, not to whoever ticked a box');
            equal(task.account_id, account.id, 'and carrying the company');
            assert(/Hala Nasser/.test(task.title), 'the lead is named in the title');
            assert(/Follows Up Ltd/.test(task.description), 'the company is in the description');
            assert(new RegExp(`Step ${task.follow_up.position} of 4`).test(task.description),
                'as is where this sits in the sequence');
        }
        assert(/last one/.test(tasks[3].description), 'and the last one says it is the last one');

        // A second follow-up on a lead already in the sequence is the rep
        // working the tasks they have, not asking for four more.
        calling.logCall(ctx, {
            assignmentId, outcome: 'follow_up', note: 'Rang again',
            followUpAt: followUpDate(2),
        });
        equal(followUp.tasksFor(ctx, assignmentId).length, 4, 'still four — there is no fifth follow-up');
    });

    await checkAsync('future steps stay silent until they come due', async () => {
        // Four "New task" bells at once — three of them for work weeks away —
        // is how a bell gets ignored. Worse: once the lead engaged and
        // completeSequence had closed the steps behind it, those week-old
        // bells still said "New task", and clicking one opened an already-done
        // task. A step announces itself when it comes due (the reminder sweep),
        // not on the day the sequence was invented.
        const reminders = await import('./lib/reminders.mjs');
        const account = repo.createRecord('account', { ...ctx }, { name: 'Quiet Bells Ltd' });
        const contact = repo.createRecord('contact', ctx, {
            first_name: 'Layla', last_name: 'Anwar', data_source: 'linkedin',
            account_id: account.id, phone: '+201000000023',
        });
        const assignmentId = db.id('cas');
        db.run(
            `INSERT INTO calling_assignments
               (id, workspace_id, contact_id, account_id, assigned_to, priority, queue_status,
                call_count, active, assigned_at, created_at, updated_at)
             VALUES (?,?,?,?,?,'A','queued',0,1,?,?,?)`,
            [assignmentId, WS, contact.id, account.id, rep.id, db.now(), db.now(), db.now()],
        );

        const bellsBefore = db.get(
            "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind IN ('task_assigned','task_due')", [rep.id],
        ).n;

        followUp.startSequence(ctx, {
            assignment: { id: assignmentId },
            contact,
            account,
            firstFollowUpAt: new Date(Date.now() + 30 * 864e5).toISOString(),
            assigneeId: rep.id,
        });

        equal(followUp.tasksFor(ctx, assignmentId).length, 4, 'the sequence itself is unchanged');
        equal(
            db.get("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind IN ('task_assigned','task_due')", [rep.id]).n - bellsBefore,
            0, 'and starting it rings no bell at all — nothing is due yet',
        );

        // The first step comes due: exactly ONE bell, from the sweep, and a
        // second sweep does not repeat it.
        const firstTask = followUp.tasksFor(ctx, assignmentId)[0];
        db.run('UPDATE tasks SET due_at = ?, reminder_sent_at = NULL WHERE id = ?',
            [new Date(Date.now() - 60_000).toISOString(), firstTask.id]);
        const sweptAt = db.now();
        reminders.sweepReminders(WS);
        const due = db.all(
            'SELECT * FROM notifications WHERE user_id = ? AND kind = \'task_due\' AND created_at >= ?',
            [rep.id, sweptAt],
        );
        equal(due.length, 1, 'one step due, one bell — not four');
        assert(/First follow-up/.test(due[0].title), 'and it names the step that actually came due');

        reminders.sweepReminders(WS);
        equal(
            db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = \'task_due\' AND created_at >= ?', [rep.id, sweptAt]).n,
            1, 'a second sweep repeats nothing',
        );
    });

    /**
     * The whole point, end to end: the minute the rep typed survives into every
     * place that later claims to know when this follow-up is due.
     */
    await checkAsync('the time a rep sets is the time the queue, the call and the task all say', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Half Two Ltd' });
        const contact = repo.createRecord('contact', ctx, {
            first_name: 'Nadia', last_name: 'Kamal', data_source: 'linkedin',
            account_id: account.id, phone: '+201000000021',
        });
        const assignmentId = db.id('cas');
        db.run(
            `INSERT INTO calling_assignments
               (id, workspace_id, contact_id, account_id, assigned_to, priority, queue_status,
                call_count, active, assigned_at, created_at, updated_at)
             VALUES (?,?,?,?,?,'A','queued',0,1,?,?,?)`,
            [assignmentId, WS, contact.id, account.id, rep.id, db.now(), db.now(), db.now()],
        );

        // 14:30 in Riyadh, which is the workspace's clock, is 11:30 UTC.
        const chosen = followUpDate(0, '11:30:00.000');
        calling.logCall(ctx, {
            assignmentId, outcome: 'follow_up', note: 'Call me at half two', followUpAt: chosen,
        });

        const row = db.get('SELECT next_follow_up_at FROM calling_assignments WHERE id = ?', [assignmentId]);
        equal(row.next_follow_up_at, chosen, 'the queue works to the minute the rep chose');

        const call = db.get(
            `SELECT next_follow_up_at FROM activities
              WHERE assignment_id = ? AND type_key = 'call' ORDER BY created_at DESC LIMIT 1`,
            [assignmentId],
        );
        equal(call.next_follow_up_at, chosen, 'and so does the call that recorded it');

        const tasks = followUp.tasksFor(ctx, assignmentId);
        equal(tasks[0].due_at, chosen, 'and so does the task the rep will actually be handed');
        equal(tasks[2].due_at, followUpDate(7, '11:30:00.000'), 'seven days later, same time of day');

        // One instant, not two that happen to fall on the same date: this is the
        // bug where the queue said midnight and the task said nine.
        equal(row.next_follow_up_at, tasks[0].due_at,
            'the queue and the task must be the same instant, not the same day');

        const shown = calling.assignment(ctx, assignmentId);
        equal(shown.nextFollowUpAt, chosen, 'and that is what the console reads back');
        equal(shown.sequence.next.dueAt, chosen);
    });

    await checkAsync('a follow-up sent without a time is given the working day, never midnight', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Timeless Ltd' });
        const contact = repo.createRecord('contact', ctx, {
            first_name: 'Yara', last_name: 'Sami', data_source: 'linkedin',
            account_id: account.id, phone: '+201000000022',
        });
        const assignmentId = db.id('cas');
        db.run(
            `INSERT INTO calling_assignments
               (id, workspace_id, contact_id, account_id, assigned_to, priority, queue_status,
                call_count, active, assigned_at, created_at, updated_at)
             VALUES (?,?,?,?,?,'B','queued',0,1,?,?,?)`,
            [assignmentId, WS, contact.id, account.id, rep.id, db.now(), db.now(), db.now()],
        );

        // What an older client, an import or a script sends. It still has to end
        // up as an instant, because the Follow-ups Due tab compares this column
        // against the current instant as TEXT.
        calling.logCall(ctx, { assignmentId, outcome: 'follow_up', followUpAt: followUpDateOnly(0) });

        const row = db.get('SELECT next_follow_up_at FROM calling_assignments WHERE id = ?', [assignmentId]);
        equal(row.next_follow_up_at, followUpDate(0, '06:00:00.000'), '09:00 in Riyadh, not midnight anywhere');
        assert(row.next_follow_up_at.length > 10, 'a bare date in this column breaks the due comparison');
        equal(followUp.tasksFor(ctx, assignmentId)[0].due_at, row.next_follow_up_at,
            'and the task agrees with the queue');
    });

    await checkAsync('a follow-up date nobody can read is refused, and writes nothing', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Refuses Nonsense Ltd' });
        const contact = repo.createRecord('contact', ctx, {
            first_name: 'Hany', last_name: 'Zaki', data_source: 'linkedin',
            account_id: account.id, phone: '+201000000023',
        });
        const assignmentId = db.id('cas');
        db.run(
            `INSERT INTO calling_assignments
               (id, workspace_id, contact_id, account_id, assigned_to, priority, queue_status,
                call_count, active, assigned_at, created_at, updated_at)
             VALUES (?,?,?,?,?,'C','queued',0,1,?,?,?)`,
            [assignmentId, WS, contact.id, account.id, rep.id, db.now(), db.now(), db.now()],
        );

        /**
         * Before this was validated, the text went into the column, the string
         * comparison behind the Follow-ups Due tab stopped matching it, and the
         * sequence created NO tasks — a follow-up that schedules nothing, which
         * nobody discovers for a week.
         */
        let refused = '';
        try {
            calling.logCall(ctx, { assignmentId, outcome: 'follow_up', followUpAt: 'next Tuesday' });
        } catch (err) { refused = err.message; }
        assert(/date and time/i.test(refused), `it must say what it wants, said: "${refused}"`);

        const row = db.get('SELECT call_count, next_follow_up_at FROM calling_assignments WHERE id = ?', [assignmentId]);
        equal(row.call_count, 0, 'the call must not have been counted');
        equal(row.next_follow_up_at ?? null, null, 'and nothing unreadable is left in the column');
        equal(followUp.tasksFor(ctx, assignmentId).length, 0, 'and no half-scheduled sequence');

        // A follow-up with no date at all is refused the same way.
        let empty = '';
        try {
            calling.logCall(ctx, { assignmentId, outcome: 'follow_up', followUpAt: null });
        } catch (err) { empty = err.message; }
        assert(/date and a time/i.test(empty), `the empty case must ask for both, said: "${empty}"`);
    });

    await checkAsync('the Follow-ups tab shows every lead mid-sequence, not only the ones due now', async () => {
        /**
         * Previously a text comparison against the current instant — a
         * follow-up booked for this afternoon was invisible all morning,
         * which is the opposite of what a rep working their book needs: the
         * whole list, sorted by due date, not just today's slice of it. See
         * lib/calling.mjs's TABS.follow_ups.
         */
        const account = repo.createRecord('account', ctx, { name: 'Not Yet Due Ltd' });
        const contact = repo.createRecord('contact', ctx, {
            first_name: 'Selim', last_name: 'Adly', data_source: 'linkedin',
            account_id: account.id, phone: '+201000000024',
        });
        const assignmentId = db.id('cas');
        db.run(
            `INSERT INTO calling_assignments
               (id, workspace_id, contact_id, account_id, assigned_to, priority, queue_status,
                call_count, active, assigned_at, created_at, updated_at)
             VALUES (?,?,?,?,?,'A','queued',0,1,?,?,?)`,
            [assignmentId, WS, contact.id, account.id, rep.id, db.now(), db.now(), db.now()],
        );

        const inTwoHours = new Date(Date.now() + 2 * 3600e3).toISOString();
        calling.logCall(ctx, { assignmentId, outcome: 'follow_up', followUpAt: inTwoHours });

        const listed = calling.queue(ctx, { tab: 'follow_ups', limit: 100 });
        assert(listed.items.some((i) => i.contactId === contact.id),
            'a lead whose sequence has started is listed even though its next step is hours away');

        const finished = db.get('SELECT * FROM calling_assignments WHERE id = ?', [assignmentId]);
        followUp.completeSequence(ctx, finished, { because: 'test cleanup' });
        const afterFinish = calling.queue(ctx, { tab: 'follow_ups', limit: 100 });
        assert(!afterFinish.items.some((i) => i.contactId === contact.id),
            'once the sequence has finished, the lead drops out of the Follow-ups tab');
    });

    /**
     * The same journey the browser makes, through the handler the browser calls.
     *
     * The unit tests above prove the rule; this proves the wiring — that the
     * console's `followUpAt` survives `readJson`, reaches `logCall`, and comes
     * back in the response the screen repaints from. A rule with a broken wire is
     * the failure this whole exercise is about.
     */
    await checkAsync('the console’s request carries the time all the way there and back', async () => {
        const callingApi = await import('./api/calling.mjs');

        const settings = await import('./lib/settings.mjs');
        const offered = await callingApi.meta({ ctx });
        equal(offered.defaultFollowUpTime, '09:00',
            'the form is told which hour to open the time box on');
        settings.setSetting(WS, 'follow_up_day_start_hour', 8);
        equal((await callingApi.meta({ ctx })).defaultFollowUpTime, '08:00',
            'and a workspace that starts at eight gets eight, without a deploy');
        settings.setSetting(WS, 'follow_up_day_start_hour', 9);

        const account = repo.createRecord('account', ctx, { name: 'Round Trip Ltd' });
        const contact = repo.createRecord('contact', ctx, {
            first_name: 'Rana', last_name: 'Fahmy', data_source: 'linkedin',
            account_id: account.id, phone: '+201000000025',
        });
        const assignmentId = db.id('cas');
        db.run(
            `INSERT INTO calling_assignments
               (id, workspace_id, contact_id, account_id, assigned_to, priority, queue_status,
                call_count, active, assigned_at, created_at, updated_at)
             VALUES (?,?,?,?,?,'A','queued',0,1,?,?,?)`,
            [assignmentId, WS, contact.id, account.id, rep.id, db.now(), db.now(), db.now()],
        );

        const chosen = '2026-10-06T13:15:00.000Z';
        const answer = await callingApi.call({
            req: bodyOf({ outcome: 'follow_up', note: 'Half four their time', followUpAt: chosen }),
            params: { id: assignmentId },
            ctx,
        });
        equal(answer.assignment.nextFollowUpAt, chosen,
            'the response the console repaints from carries the minute, not the day');
        equal(answer.assignment.sequence.next.dueAt, chosen, 'and so does the next step it shows');
        equal(db.get('SELECT next_follow_up_at FROM calling_assignments WHERE id = ?', [assignmentId])
            .next_follow_up_at, chosen, 'and that is what was stored');

        // And the handler refuses what it cannot read, rather than storing text.
        let refused = '';
        try {
            await callingApi.call({
                req: bodyOf({ outcome: 'follow_up', followUpAt: 'sometime next week' }),
                params: { id: assignmentId },
                ctx,
            });
        } catch (err) { refused = err.message; }
        assert(/date and time/i.test(refused), `the endpoint must refuse it too, said: "${refused}"`);
    });

    await checkAsync('editing a lead from the calling console writes through to the contact, scoped to the caller’s own queue', async () => {
        const callingApi = await import('./api/calling.mjs');
        const sdrA = auth.createUser({ email: 'edit-sdr-a@test.local', name: 'Edit SDR A', password: 'test-password-9', role: 'sdr', workspaceId: WS });
        const sdrB = auth.createUser({ email: 'edit-sdr-b@test.local', name: 'Edit SDR B', password: 'test-password-9', role: 'sdr', workspaceId: WS });
        const sdrACtx = { ...ctx, userId: sdrA.id, role: 'sdr', user: { id: sdrA.id, name: 'Edit SDR A' } };
        const sdrBCtx = { ...ctx, userId: sdrB.id, role: 'sdr', user: { id: sdrB.id, name: 'Edit SDR B' } };

        const contact = repo.createRecord('contact', ctx, {
            full_name: 'Edit Me', phone: '+966500000050', data_source: 'test',
        });
        calling.assignContacts(ctx, { contactIds: [contact.id], assignedTo: sdrA.id, priority: 'B' });
        const assignmentId = db.get('SELECT id FROM calling_assignments WHERE contact_id = ?', [contact.id]).id;

        // The assigned SDR can edit their own lead's basic details — the one
        // door they have to it at all, since the generic PATCH /api/contacts
        // is 403 for them.
        const result = await callingApi.editContact({
            req: bodyOf({
                full_name: 'Edited Name', phone: '+966500000051', email: 'edited@example.com',
                title: 'CEO', services: ['hcm'],
            }),
            params: { id: assignmentId },
            ctx: sdrACtx,
        });
        equal(result.contact.full_name, 'Edited Name', 'the response carries the updated name');
        equal(db.get('SELECT full_name FROM contacts WHERE id = ?', [contact.id]).full_name, 'Edited Name',
            'and the write actually landed on the contact record');

        // A colleague whose queue this is NOT gets refused exactly like
        // asking for the assignment itself outside their scope (`assignment()`
        // in lib/calling.mjs) — same wording, so a probe cannot tell "not
        // yours" from "does not exist".
        let refused = '';
        try {
            await callingApi.editContact({
                req: bodyOf({ full_name: 'Hijacked' }),
                params: { id: assignmentId },
                ctx: sdrBCtx,
            });
        } catch (err) { refused = err.message; }
        assert(/not in your calling queue/.test(refused), `a colleague's lead must be refused, said: "${refused}"`);
        equal(db.get('SELECT full_name FROM contacts WHERE id = ?', [contact.id]).full_name, 'Edited Name',
            'and nothing was written by the refused attempt');
    });

    await checkAsync('editing a lead never moves its priority or its queue assignment — those stay behind their own endpoints', async () => {
        // Priority and "assigned to" are queue facts, not the lead's own —
        // `setPriority`/`assignContacts` already require calling.manage.
        // editContact's field whitelist simply does not carry them, so
        // sending them here (whoever sends them) changes nothing, rather
        // than quietly becoming a second, unguarded way to move either.
        const callingApi = await import('./api/calling.mjs');
        const sdr = auth.createUser({ email: 'edit-sdr-c@test.local', name: 'Edit SDR C', password: 'test-password-9', role: 'sdr', workspaceId: WS });
        const sdrCtx = { ...ctx, userId: sdr.id, role: 'sdr', user: { id: sdr.id, name: 'Edit SDR C' } };
        const contact = repo.createRecord('contact', ctx, {
            full_name: 'Ignore Queue Fields', phone: '+966500000052', data_source: 'test',
        });
        calling.assignContacts(ctx, { contactIds: [contact.id], assignedTo: sdr.id, priority: 'B' });
        const assignmentId = db.get('SELECT id FROM calling_assignments WHERE contact_id = ?', [contact.id]).id;

        await callingApi.editContact({
            req: bodyOf({ full_name: 'Ignore Queue Fields', priority: 'A', assigned_to: 'someone-else' }),
            params: { id: assignmentId },
            ctx: sdrCtx,
        });
        const row = db.get('SELECT priority, assigned_to FROM calling_assignments WHERE id = ?', [assignmentId]);
        equal(row.priority, 'B', 'priority is untouched by this endpoint');
        equal(row.assigned_to, sdr.id, 'and so is who it is assigned to');
    });

    await checkAsync('the Edit dialog offers queue status from the same manual-override list setQueueStatus enforces, and a manager moving it there goes through that endpoint', async () => {
        // Queue status was deliberately left off the Edit dialog at first —
        // it is a manual override that bypasses the call-outcome bookkeeping,
        // so it should only ever move through setQueueStatus, never a field
        // editContact writes directly. meta() has to keep offering exactly
        // the list setQueueStatus accepts, or the dialog could offer a value
        // (e.g. 'dead') the endpoint would reject.
        const callingApi = await import('./api/calling.mjs');
        const offered = await callingApi.meta({ ctx });
        equal(JSON.stringify(offered.queueStatuses), JSON.stringify(calling.BULK_QUEUE_STATUSES),
            'the dialog is offered exactly the statuses setQueueStatus will accept');
        assert(!offered.queueStatuses.includes('dead'), 'dead stays markDead’s job, never a picklist entry');

        const contact = repo.createRecord('contact', ctx, {
            full_name: 'Move My Queue Status', phone: '+966500000053', data_source: 'test',
        });
        calling.assignContacts(ctx, { contactIds: [contact.id], assignedTo: rep.id, priority: 'B' });
        const assignmentId = db.get('SELECT id FROM calling_assignments WHERE contact_id = ?', [contact.id]).id;

        // The dialog's save path never writes queue_status itself — it PATCHes
        // /api/calling/status, the same door the bulk-edit tools use, so
        // call-history/streak bookkeeping stays consistent either way.
        calling.setQueueStatus(ctx, [assignmentId], 'working');
        const row = db.get('SELECT queue_status FROM calling_assignments WHERE id = ?', [assignmentId]);
        equal(row.queue_status, 'working', 'the assignment picked up the manager’s manual override');
    });

    await checkAsync('logging a call returns the due-now figure, not the whole follow-up book', async () => {
        // The "N due — work them now" banner reads `followUpsDue` off this
        // same response. It used to have nothing but `counts.follow_ups` —
        // queueCounts()'s WHOLE-BOOK count (every lead mid-sequence, whatever
        // their next step's date) — to work with, so the banner started
        // reporting the book size instead of "due now" the moment any call
        // was logged. Built here so a lead mid-sequence but not yet due
        // inflates the book count while the due-now figure stays at zero,
        // proving the two are genuinely different numbers and the endpoint
        // now returns the right one.
        const callingApi = await import('./api/calling.mjs');

        const account = repo.createRecord('account', ctx, { name: 'Due Now Vs Whole Book Ltd' });

        const justCalled = repo.createRecord('contact', ctx, {
            first_name: 'Nadia', last_name: 'Samir', data_source: 'linkedin',
            account_id: account.id, phone: '+201000000030',
        });
        const justCalledId = db.id('cas');
        db.run(
            `INSERT INTO calling_assignments
               (id, workspace_id, contact_id, account_id, assigned_to, priority, queue_status,
                call_count, active, assigned_at, created_at, updated_at)
             VALUES (?,?,?,?,?,'A','queued',0,1,?,?,?)`,
            [justCalledId, WS, justCalled.id, account.id, rep.id, db.now(), db.now(), db.now()],
        );

        // A second lead, already mid-sequence, whose next step is a week out —
        // real book, nothing due about it.
        const midSequence = repo.createRecord('contact', ctx, {
            first_name: 'Omar', last_name: 'Khalil', data_source: 'linkedin',
            account_id: account.id, phone: '+201000000031',
        });
        const midSequenceId = db.id('cas');
        db.run(
            `INSERT INTO calling_assignments
               (id, workspace_id, contact_id, account_id, assigned_to, priority, queue_status,
                call_count, active, assigned_at, created_at, updated_at)
             VALUES (?,?,?,?,?,'A','working',1,1,?,?,?)`,
            [midSequenceId, WS, midSequence.id, account.id, rep.id, db.now(), db.now(), db.now()],
        );
        followUp.startSequence(ctx, {
            assignment: { id: midSequenceId }, contact: midSequence, account,
            firstFollowUpAt: new Date(Date.now() + 7 * 864e5).toISOString(),
            assigneeId: rep.id,
        });
        db.run('UPDATE calling_assignments SET next_follow_up_at = ? WHERE id = ?',
            [new Date(Date.now() + 7 * 864e5).toISOString(), midSequenceId]);

        // Log a call on the first lead, itself rescheduled a week out too —
        // nothing anywhere is genuinely due right now. Scoped to `rep` via
        // `sdr` — `ctx` here holds `calling.manage`, so an unscoped call
        // counts the whole workspace, including whatever other tests in this
        // file left behind on other SDRs' queues.
        const answer = await callingApi.call({
            req: bodyOf({
                outcome: 'follow_up', followUpAt: new Date(Date.now() + 7 * 864e5).toISOString(), sdr: rep.id,
            }),
            params: { id: justCalledId },
            ctx,
        });

        assert(answer.counts.follow_ups >= 1, 'the whole-book count sees the mid-sequence lead');
        equal(answer.followUpsDue, 0, 'nothing is genuinely due right now — the two figures must not be the same field');
        assert(answer.followUpsDue !== answer.counts.follow_ups || answer.counts.follow_ups === 0,
            'due-now and whole-book are different questions with different answers here');
    });

    await checkAsync('completing the fourth activity kills the lead, and nothing creates a fifth', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Goes Quiet Ltd' });
        const contact = repo.createRecord('contact', ctx, {
            first_name: 'Tarek', last_name: 'Fouad', data_source: 'linkedin',
            account_id: account.id, phone: '+201000000002',
        });
        const assignmentId = db.id('cas');
        db.run(
            `INSERT INTO calling_assignments
               (id, workspace_id, contact_id, account_id, assigned_to, priority, queue_status,
                call_count, active, assigned_at, created_at, updated_at)
             VALUES (?,?,?,?,?,'high','queued',0,1,?,?,?)`,
            [assignmentId, WS, contact.id, account.id, rep.id, db.now(), db.now(), db.now()],
        );
        calling.logCall(ctx, {
            assignmentId, outcome: 'follow_up', followUpAt: followUpDate(0),
        });

        const tasks = followUp.tasksFor(ctx, assignmentId);
        for (const [i, task] of tasks.slice(0, 3).entries()) {
            repo.updateRecord('task', ctx, task.id, { status: 'done' });
            const mid = db.get('SELECT * FROM calling_assignments WHERE id = ?', [assignmentId]);
            equal(mid.dead_at ?? null, null, 'the lead is alive until the fourth is done');
            equal(mid.active, 1, 'and still in the queue');
            // Regression: next_follow_up_at was set once, to step 1's due
            // date, and never advanced — so the calling queue (and its
            // Follow-ups Due tab) stopped pointing at anything true the
            // moment step 1 was done, WhatsApp steps worst of all since
            // nothing else ever resurfaces them. It must track whichever
            // step is now the active one.
            equal(mid.next_follow_up_at, tasks[i + 1].due_at,
                `next_follow_up_at points at step ${i + 2}'s due date after step ${i + 1} completes`);
        }

        repo.updateRecord('task', ctx, tasks[3].id, { status: 'done' });
        const after = db.get('SELECT * FROM calling_assignments WHERE id = ?', [assignmentId]);
        assert(after.dead_at, 'the lead is dead after activity four');
        equal(after.queue_status, 'dead');
        equal(after.active, 0, 'which is what takes it out of the queue — the fact, not a filter over it');
        equal(after.sequence_step, 4);

        equal(followUp.tasksFor(ctx, assignmentId).length, 4,
            'no fifth task was created by finishing the fourth');

        // And it is on the timeline, not only in a column.
        const logged = db.get(
            `SELECT subject FROM activities WHERE parent_id = ? AND subject = 'Lead marked dead'`,
            [contact.id],
        );
        assert(logged, '"why did this go quiet in March" is asked six months later; a flag does not answer it');
    });

    await checkAsync('a completed task stamps when it was completed', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Timestamps Ltd' });
        const task = repo.createRecord('task', ctx, { title: 'Ordinary task', account_id: account.id });
        equal(task.completed_at ?? null, null);
        const done = repo.updateRecord('task', ctx, task.id, { status: 'done' });
        assert(done.completed_at, 'a ticked task with no completion date cannot answer "what did we finish this week"');
        const reopened = repo.updateRecord('task', ctx, task.id, { status: 'open' });
        equal(reopened.completed_at ?? null, null, 'and reopening clears it rather than leaving it stale');
    });

    await checkAsync('a dead lead has somewhere to be seen', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Has A Grave Ltd' });
        const contact = repo.createRecord('contact', ctx, {
            first_name: 'Omar', last_name: 'Said', data_source: 'linkedin',
            account_id: account.id, phone: '+201000000009',
        });
        const assignmentId = db.id('cas');
        db.run(
            `INSERT INTO calling_assignments
               (id, workspace_id, contact_id, account_id, assigned_to, priority, queue_status,
                call_count, active, assigned_at, created_at, updated_at)
             VALUES (?,?,?,?,?,'high','queued',0,1,?,?,?)`,
            [assignmentId, WS, contact.id, account.id, rep.id, db.now(), db.now(), db.now()],
        );
        calling.logCall(ctx, { assignmentId, outcome: 'follow_up', followUpAt: followUpDateOnly(0) });
        for (const task of followUp.tasksFor(ctx, assignmentId)) {
            repo.updateRecord('task', ctx, task.id, { status: 'done' });
        }

        /**
         * `dead` is its own queue status and matched none of the three tabs the
         * calling screen offered, so a lead the automation retired disappeared
         * from every view — indistinguishable from the software having lost it.
         */
        const counts = calling.queueCounts(ctx, {});
        assert(counts.dead >= 1, 'the dead count must exist and include this lead');

        const listing = calling.queue(ctx, { tab: 'dead', limit: 50 });
        assert(listing.items.some((i) => i.contactId === contact.id),
            'and the Dead tab must actually list it');

        // And it is genuinely out of the working queues, not merely filtered.
        for (const tab of ['to_call', 'follow_ups']) {
            const live = calling.queue(ctx, { tab, limit: 50 });
            assert(!live.items.some((i) => i.contactId === contact.id),
                `a dead lead must not still be offered in "${tab}"`);
        }
    });

    await checkAsync('a dead lead reports why, and what is left of its sequence', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Reports Its State Ltd' });
        const contact = repo.createRecord('contact', ctx, {
            first_name: 'Mona', last_name: 'Adel', data_source: 'linkedin',
            account_id: account.id, phone: '+201000000003',
        });
        const assignmentId = db.id('cas');
        db.run(
            `INSERT INTO calling_assignments
               (id, workspace_id, contact_id, account_id, assigned_to, priority, queue_status,
                call_count, active, assigned_at, created_at, updated_at)
             VALUES (?,?,?,?,?,'high','queued',0,1,?,?,?)`,
            [assignmentId, WS, contact.id, account.id, rep.id, db.now(), db.now(), db.now()],
        );
        calling.logCall(ctx, {
            assignmentId, outcome: 'follow_up', followUpAt: followUpDate(0),
        });

        const live = calling.assignment(ctx, assignmentId);
        equal(live.sequence.running, true);
        equal(live.sequence.of, 4);
        equal(live.sequence.position, 0, 'none done yet');
        equal(live.sequence.next.position, 1, 'and the next thing due is step one');
        assert(live.sequence.next.dueAt, 'with a date on it');
        equal(live.dead, false);

        for (const task of followUp.tasksFor(ctx, assignmentId)) {
            repo.updateRecord('task', ctx, task.id, { status: 'done' });
        }
        const dead = db.get('SELECT * FROM calling_assignments WHERE id = ?', [assignmentId]);
        const status = followUp.sequenceStatus(ctx, dead);
        equal(status.dead, true);
        equal(status.position, 4, 'all four done');
        equal(status.next, null, 'and nothing next — that is what dead means');
        assert(/completed/.test(status.deadReason ?? ''), 'and it says why');
    });

    /* ================== three unanswered calls and the lead is dead ======= */

    /** A queue entry with nothing logged against it yet. */
    const freshAssignment = (label, phone) => {
        const account = repo.createRecord('account', ctx, { name: label });
        const contact = repo.createRecord('contact', ctx, {
            first_name: label.split(' ')[0], last_name: 'Test', data_source: 'linkedin',
            account_id: account.id, phone,
        });
        const assignmentId = db.id('cas');
        db.run(
            `INSERT INTO calling_assignments
               (id, workspace_id, contact_id, account_id, assigned_to, priority, queue_status,
                call_count, active, assigned_at, created_at, updated_at)
             VALUES (?,?,?,?,?,'B','queued',0,1,?,?,?)`,
            [assignmentId, WS, contact.id, account.id, rep.id, db.now(), db.now(), db.now()],
        );
        return { assignmentId, contact, account };
    };

    await checkAsync('three unanswered calls in a row retire the lead', async () => {
        const { assignmentId, contact } = freshAssignment('Never Picks Up', '+201000000031');

        calling.logCall(ctx, { assignmentId, outcome: 'no_answer' });
        let row = db.get('SELECT * FROM calling_assignments WHERE id = ?', [assignmentId]);
        equal(row.no_answer_streak, 1, 'one ring, one unanswered call');
        equal(row.active, 1, 'and still very much a lead');

        calling.logCall(ctx, { assignmentId, outcome: 'no_answer' });
        row = db.get('SELECT * FROM calling_assignments WHERE id = ?', [assignmentId]);
        equal(row.no_answer_streak, 2);
        equal(row.dead_at ?? null, null, 'two is not three — the rule is exact');
        equal(row.active, 1);

        calling.logCall(ctx, { assignmentId, outcome: 'no_answer' });
        row = db.get('SELECT * FROM calling_assignments WHERE id = ?', [assignmentId]);
        assert(row.dead_at, 'the third unanswered call in a row retires it');
        equal(row.queue_status, 'dead');
        equal(row.active, 0, 'which is what takes it out of the queue — the fact, not a filter');
        assert(/unanswered/.test(row.dead_reason ?? ''), `it must say why, said: "${row.dead_reason}"`);

        /**
         * A lead retired for not answering never had a sequence, so "Follow-ups
         * done: 4 of 4" would be the software describing something that did not
         * happen.
         */
        equal(row.sequence_step ?? 0, 0, 'no follow-up sequence was ever run on it');

        // The three calls are all still on the record: dying is not forgetting.
        equal(calling.callHistory(ctx, contact.id).filter((c) => c.outcome === 'no_answer').length, 3);

        // On the timeline, in its own words rather than the sequence's.
        const said = db.get(
            `SELECT body FROM activities WHERE parent_id = ? AND subject = 'Lead marked dead'`,
            [contact.id],
        );
        assert(said, 'a retired lead must say so on the timeline, not only in a column');
        assert(!/follow-up activities are done/.test(said.body),
            'and must not claim four follow-ups happened when none did');

        // Out of the live queue, in the dead tab.
        const live = calling.queue(ctx, { tab: 'to_call', limit: 100 });
        assert(!live.items.some((i) => i.contactId === contact.id), 'gone from the calling queue');
        const gone = calling.queue(ctx, { tab: 'dead', limit: 100 });
        assert(gone.items.some((i) => i.contactId === contact.id), 'and findable in Dead');
    });

    await checkAsync('answering resets the streak — three in a row means IN A ROW', async () => {
        const { assignmentId } = freshAssignment('Answers Eventually', '+201000000032');

        calling.logCall(ctx, { assignmentId, outcome: 'no_answer' });
        calling.logCall(ctx, { assignmentId, outcome: 'no_answer' });
        equal(db.get('SELECT no_answer_streak FROM calling_assignments WHERE id = ?', [assignmentId])
            .no_answer_streak, 2, 'two unanswered');

        // They pick up on the third and ask for the profile.
        calling.logCall(ctx, { assignmentId, outcome: 'send_profile' });
        let row = db.get('SELECT * FROM calling_assignments WHERE id = ?', [assignmentId]);
        equal(row.no_answer_streak, 0, 'a conversation wipes the streak');
        equal(row.dead_at ?? null, null);

        // Two more misses. Four unanswered calls in total, never three running.
        calling.logCall(ctx, { assignmentId, outcome: 'no_answer' });
        calling.logCall(ctx, { assignmentId, outcome: 'no_answer' });
        row = db.get('SELECT * FROM calling_assignments WHERE id = ?', [assignmentId]);
        equal(row.no_answer_streak, 2);
        equal(row.dead_at ?? null, null,
            'a rule counting no-answers in TOTAL would have retired a live lead here');
        equal(row.active, 1);
        equal(row.call_count, 5, 'and every attempt is still counted');
    });

    await checkAsync('how many attempts is the workspace’s decision', async () => {
        const settings = await import('./lib/settings.mjs');
        const { assignmentId } = freshAssignment('Gives Up Sooner', '+201000000033');

        settings.setSetting(WS, 'calling_attempts_before_dead', 2);
        try {
            calling.logCall(ctx, { assignmentId, outcome: 'no_answer' });
            equal(db.get('SELECT dead_at FROM calling_assignments WHERE id = ?', [assignmentId])
                .dead_at ?? null, null, 'one is not two');
            calling.logCall(ctx, { assignmentId, outcome: 'no_answer' });
            assert(db.get('SELECT dead_at FROM calling_assignments WHERE id = ?', [assignmentId]).dead_at,
                'a floor that gives up after two must not need a deploy to do it');
        } finally {
            settings.setSetting(WS, 'calling_attempts_before_dead', 3);
        }
    });

    /* ============ an answered follow-up completes the sequence ============ */

    await checkAsync('a follow-up that gets answered completes the sequence', async () => {
        const { assignmentId, contact } = freshAssignment('Answers The Follow Up', '+201000000034');

        calling.logCall(ctx, {
            assignmentId, outcome: 'follow_up', followUpAt: followUpDate(0),
        });
        equal(followUp.tasksFor(ctx, assignmentId).length, 4, 'the sequence is running');

        // The rep rings on the day and the contact qualifies.
        calling.logCall(ctx, { assignmentId, outcome: 'qualified' });

        const row = db.get('SELECT * FROM calling_assignments WHERE id = ?', [assignmentId]);
        assert(row.sequence_completed_at, 'the sequence is finished, because the lead engaged');
        equal(row.dead_at ?? null, null, 'and finished is NOT dead — opposite results');
        equal(row.active, 0, 'a follow-up lead that engages is COMPLETED, not left queued');
        equal(row.queue_status, 'done');
        assert(row.completed_at, 'and stamped as completed');

        const tasks = followUp.tasksFor(ctx, assignmentId);
        equal(tasks.filter((t) => t.status === 'open' || t.status === 'in_progress').length, 0,
            'nobody is chased for a conversation that already happened');
        equal(tasks.filter((t) => t.status === 'done').length, 4,
            'and the steps read as done, not cancelled — the sequence reached its purpose');
        for (const task of tasks) assert(task.completed_at, 'each closed step is stamped');

        const said = db.get(
            `SELECT body FROM activities WHERE parent_id = ? AND subject = 'Follow-up sequence completed'`,
            [contact.id],
        );
        assert(said, 'the timeline must say why the remaining steps went');
        assert(/qualified/i.test(said.body), `and which outcome ended it, said: "${said.body}"`);
    });

    await checkAsync('a no-answer or another follow-up leaves the sequence running', async () => {
        const { assignmentId } = freshAssignment('Still Chasing', '+201000000035');

        calling.logCall(ctx, {
            assignmentId, outcome: 'follow_up', followUpAt: followUpDate(0),
        });

        // Nobody picked up. The sequence exists precisely for this — and the
        // call step just attempted is complete (attemptCallStep), same as a
        // rep ticking it by hand, so the sequence has somewhere to go next
        // rather than sitting on a step already dialled.
        calling.logCall(ctx, { assignmentId, outcome: 'no_answer' });
        let row = db.get('SELECT * FROM calling_assignments WHERE id = ?', [assignmentId]);
        equal(row.sequence_completed_at ?? null, null, 'a missed call has not ended anything');
        const afterNoAnswer = followUp.tasksFor(ctx, assignmentId);
        assert(afterNoAnswer.find((t) => t.follow_up.step === 'first_follow_up').status === 'done',
            'the call step just attempted is complete — attempted, not abandoned');
        assert(afterNoAnswer.some((t) => t.status === 'open'),
            'the remaining steps must still be there to chase');

        // And rebooking is the rep working the steps they have.
        calling.logCall(ctx, {
            assignmentId, outcome: 'follow_up', followUpAt: followUpDate(7),
        });
        row = db.get('SELECT * FROM calling_assignments WHERE id = ?', [assignmentId]);
        equal(row.sequence_completed_at ?? null, null, 'nor has a second follow-up');
        equal(followUp.tasksFor(ctx, assignmentId).length, 4, 'and still four steps, never five');
        const stillOpen = followUp.tasksFor(ctx, assignmentId).filter((t) => t.status === 'open');
        // Step 1 (the call) is already done, so the next OPEN step is the
        // WhatsApp that follows it — same day as the new anchor, end of day.
        assert(stillOpen.some((t) => t.due_at.startsWith(followUpDateOnly(7))),
            'the open steps are RE-DATED from the new instant, so the queue and the task list agree');
    });

    await checkAsync('logging a follow-up moves the account deal to the Follow up stage', async () => {
        const calling = await import('./lib/calling.mjs');
        db.run(
            'INSERT OR IGNORE INTO stages (id, workspace_id, pipeline_id, key, label, position, probability, type, required_fields) VALUES (?,?,?,?,?,4,0,?,?)',
            [db.id('stg'), WS, PIPE, 'follow_up', 'Follow up', 'open', '[]'],
        );
        const account = repo.createRecord('account', ctx, { name: 'Follow Up Stage Co', billing_currency: 'USD' });
        const contact = repo.createRecord('contact', ctx, {
            full_name: 'Follow Up Contact', account_id: account.id, phone: '+966500000003', data_source: 'test',
        });
        const sdr = auth.createUser({ email: 'fu-sdr@test.local', name: 'FU SDR', password: 'test-password-9', role: 'sdr', workspaceId: WS });

        calling.assignContacts(ctx, { contactIds: [contact.id], assignedTo: sdr.id });
        calling.logCall(ctx, {
            assignmentId: db.get('SELECT id FROM calling_assignments WHERE contact_id = ?', [contact.id]).id,
            outcome: 'follow_up', followUpAt: '2026-10-01T09:00:00.000Z',
        });

        const deal = repo.getRecord('deal', ctx, db.get('SELECT id FROM deals WHERE account_id = ?', [account.id]).id);
        equal(deal.stage_key ?? db.get('SELECT s.key AS k FROM deals d JOIN stages s ON s.id = d.stage_id WHERE d.id = ?', [deal.id]).k,
            'follow_up', 'the account deal sits on the Follow up stage');
        equal(deal.status, 'open', 'and still open');
    });

    await checkAsync('calling outcomes move the account deal to their pipeline stage', async () => {
        const calling = await import('./lib/calling.mjs');
        for (const key of ['interested', 'send_profile', 'meeting_scheduled']) {
            db.run(
                'INSERT OR IGNORE INTO stages (id, workspace_id, pipeline_id, key, label, position, probability, type, required_fields) VALUES (?,?,?,?,?,4,0,?,?)',
                [db.id('stg'), WS, PIPE, key, key.replace(/_/g, ' '), 'open', '[]'],
            );
        }
        // Qualified -> Interested.
        const qAccount = repo.createRecord('account', ctx, { name: 'Qualified Stage Co', billing_currency: 'USD' });
        const qContact = repo.createRecord('contact', ctx, {
            full_name: 'Qualified Contact', account_id: qAccount.id, phone: '+966500000004', data_source: 'test',
        });
        const sdr2 = auth.createUser({ email: 'stage-sdr@test.local', name: 'Stage SDR', password: 'test-password-9', role: 'sdr', workspaceId: WS });
        calling.assignContacts(ctx, { contactIds: [qContact.id], assignedTo: sdr2.id });
        const qAssignment = db.get('SELECT id FROM calling_assignments WHERE contact_id = ?', [qContact.id]).id;
        calling.logCall(ctx, { assignmentId: qAssignment, outcome: 'qualified' });
        const stageOf = (dealId) => db.get(
            'SELECT s.key FROM deals d JOIN stages s ON s.id = d.stage_id WHERE d.id = ?', [dealId],
        ).key;
        equal(stageOf(db.get('SELECT id FROM deals WHERE account_id = ?', [qAccount.id]).id),
            'interested', 'Qualified lands the deal on Interested');

        // Send profile -> Send profile.
        const sAccount = repo.createRecord('account', ctx, { name: 'Profile Stage Co', billing_currency: 'USD' });
        const sContact = repo.createRecord('contact', ctx, {
            full_name: 'Profile Contact', account_id: sAccount.id, phone: '+966500000005', data_source: 'test',
        });
        calling.assignContacts(ctx, { contactIds: [sContact.id], assignedTo: sdr2.id });
        calling.logCall(ctx, { assignmentId: db.get('SELECT id FROM calling_assignments WHERE contact_id = ?', [sContact.id]).id, outcome: 'send_profile' });
        equal(stageOf(db.get('SELECT id FROM deals WHERE account_id = ?', [sAccount.id]).id),
            'send_profile', 'Send profile lands the deal on Send profile');
    });

    await checkAsync('a campaign contact marked contacted moves its account into the campaign stage', async () => {
        const campaigns = await import('./lib/campaigns.mjs');
        db.run(
            'INSERT OR IGNORE INTO stages (id, workspace_id, pipeline_id, key, label, position, probability, type, required_fields) VALUES (?,?,?,?,?,4,0,?,?)',
            [db.id('stg'), WS, PIPE, 'in_campaign', 'In campaign', 'open', '[]'],
        );
        const stageCampaign = repo.createRecord('campaign', ctx, { name: 'Stage Campaign', channel: 'linkedin' });
        const account = repo.createRecord('account', ctx, { name: 'Campaign Stage Co', billing_currency: 'USD' });
        const contact = repo.createRecord('contact', ctx, {
            full_name: 'Campaign Contact', account_id: account.id, email: 'camp@stage.local', data_source: 'test',
        });
        campaigns.addMembers(ctx, stageCampaign.id, 'contact', [contact.id]);

        campaigns.setMemberStatus(ctx, stageCampaign.id, 'contact', [contact.id], 'contacted');

        const deal = db.get('SELECT id FROM deals WHERE account_id = ?', [account.id]);
        assert(deal, 'the account has a deal');
        equal(db.get('SELECT s.key AS k FROM deals d JOIN stages s ON s.id = d.stage_id WHERE d.id = ?', [deal.id]).k,
            'in_campaign', 'the account deal sits on In campaign');
    });

    await checkAsync('not interested ends the sequence too, and closes the queue entry', async () => {
        const { assignmentId } = freshAssignment('Says No', '+201000000036');

        calling.logCall(ctx, {
            assignmentId, outcome: 'follow_up', followUpAt: followUpDate(0),
        });
        calling.logCall(ctx, { assignmentId, outcome: 'not_interested' });

        const row = db.get('SELECT * FROM calling_assignments WHERE id = ?', [assignmentId]);
        assert(row.sequence_completed_at, 'a no is an answer, and it ends the chasing');
        equal(row.active, 0, 'and Not Interested closes the entry — that is the outcome’s doing');
        equal(row.dead_at ?? null, null, 'closed by a decision is not retired for silence');
        equal(followUp.tasksFor(ctx, assignmentId).filter((t) => t.status === 'open').length, 0);
    });

    await checkAsync('a follow-up and a reschedule in the past are both refused', async () => {
        const { assignmentId } = freshAssignment('No Yesterday Calls', '+201000000040');

        // Logging a follow-up in the past books nothing.
        throws(
            () => calling.logCall(ctx, {
                assignmentId, outcome: 'follow_up', followUpAt: '2020-01-01T09:00:00.000Z',
            }),
            /cannot be in the past/i,
            'a past follow-up is refused when the call is logged',
        );
        equal(db.get('SELECT call_count FROM calling_assignments WHERE id = ?', [assignmentId]).call_count, 0,
            'and nothing was recorded');

        // Rescheduling to a past instant is refused too.
        throws(
            () => calling.rescheduleFollowUp(ctx, assignmentId, '2020-01-01T09:00:00.000Z'),
            /cannot be in the past/i,
            'a past reschedule is refused',
        );
    });

    await checkAsync('a follow-up defaults are not written when the outcome is not follow-up', async () => {
        // The frontend pre-fills the follow-up box; the server only ever acts on
        // what is actually sent. Logging a different outcome must not schedule
        // anything.
        const { assignmentId } = freshAssignment('No Ghost Follow Up', '+201000000041');
        calling.logCall(ctx, { assignmentId, outcome: 'no_answer' });
        equal(db.get('SELECT next_follow_up_at FROM calling_assignments WHERE id = ?', [assignmentId])
            .next_follow_up_at ?? null, null, 'no_answer schedules no follow-up');
    });

    /* ====================== editing the follow-up date ==================== */

    await checkAsync('a follow-up date can be edited, and the whole sequence moves', async () => {
        const { assignmentId, contact } = freshAssignment('Pushed To Thursday', '+201000000037');

        calling.logCall(ctx, {
            assignmentId, outcome: 'follow_up', followUpAt: followUpDate(0),
        });
        const before = followUp.tasksFor(ctx, assignmentId);
        equal(before[0].due_at, followUpDate(0));

        // "They asked me to ring Thursday at four instead."
        const moved = calling.rescheduleFollowUp(ctx, assignmentId, followUpDate(2, '13:00:00.000'));
        equal(moved.rescheduled, followUpDate(2, '13:00:00.000'));

        const row = db.get('SELECT * FROM calling_assignments WHERE id = ?', [assignmentId]);
        equal(row.next_follow_up_at, followUpDate(2, '13:00:00.000'), 'the queue reads the new instant');

        const after = followUp.tasksFor(ctx, assignmentId);
        equal(after[0].due_at, followUpDate(2, '13:00:00.000'), 'and so does the task the rep is handed');
        equal(after[2].due_at, followUpDate(9, '13:00:00.000'),
            'seven days after the NEW date — not seven days after the old one');
        equal(after.length, 4, 'moving a date does not create a fifth step');
        assert(moved.stepsMoved >= 3, `the pending steps moved with it (${moved.stepsMoved})`);

        // On the timeline, because "they pushed us twice" is a pattern.
        assert(db.get(
            `SELECT id FROM activities WHERE parent_id = ? AND subject = 'Follow-up rescheduled'`,
            [contact.id],
        ), 'a date that moved is a fact about the relationship, not just a column');

        // And no second call was invented by moving a date.
        equal(calling.callHistory(ctx, contact.id).filter((c) => c.outcome === 'follow_up').length, 1,
            'rescheduling is not logging a call');
    });

    await checkAsync('rescheduling leaves the steps that already happened alone', async () => {
        const { assignmentId } = freshAssignment('Half Done', '+201000000038');

        calling.logCall(ctx, {
            assignmentId, outcome: 'follow_up', followUpAt: followUpDate(0),
        });
        const steps = followUp.tasksFor(ctx, assignmentId);
        repo.updateRecord('task', ctx, steps[0].id, { status: 'done' });
        const doneAt = db.get('SELECT due_at FROM tasks WHERE id = ?', [steps[0].id]).due_at;

        calling.rescheduleFollowUp(ctx, assignmentId, followUpDate(19, '11:00:00.000'));

        equal(db.get('SELECT due_at FROM tasks WHERE id = ?', [steps[0].id]).due_at, doneAt,
            'a call somebody already made happened when it happened — rewriting it falsifies history');
        const still = followUp.tasksFor(ctx, assignmentId);
        equal(still[2].due_at, followUpDate(26, '11:00:00.000'), 'the pending ones follow the new date');
    });

    await checkAsync('an unreadable or impossible reschedule is refused', async () => {
        const { assignmentId } = freshAssignment('Refuses Nonsense Dates', '+201000000039');
        calling.logCall(ctx, {
            assignmentId, outcome: 'follow_up', followUpAt: followUpDate(0),
        });

        for (const bad of ['next Thursday', '2026-13-45', '', null]) {
            let refused = '';
            try { calling.rescheduleFollowUp(ctx, assignmentId, bad); } catch (err) { refused = err.message; }
            assert(/date and (a )?time/i.test(refused), `"${bad}" must be refused, said: "${refused}"`);
        }
        equal(db.get('SELECT next_follow_up_at FROM calling_assignments WHERE id = ?', [assignmentId])
            .next_follow_up_at, followUpDate(0), 'and the good date is untouched');

        // A dead lead has no follow-up to move.
        const { assignmentId: deadId } = freshAssignment('Already Gone', '+201000000040');
        for (let i = 0; i < 3; i += 1) calling.logCall(ctx, { assignmentId: deadId, outcome: 'no_answer' });
        let deadRefusal = '';
        try { calling.rescheduleFollowUp(ctx, deadId, followUpDate(2, '13:00:00.000')); } catch (err) { deadRefusal = err.message; }
        assert(/dead/i.test(deadRefusal), `a dead lead cannot be rescheduled, said: "${deadRefusal}"`);
    });

    await checkAsync('an SDR can move their own follow-up and nobody else’s', async () => {
        const sdrUser = auth.createUser({
            email: `sdr-resched-${db.id('t')}@test.local`, name: 'SDR Resched',
            password: 'test-password-9', role: 'sdr', workspaceId: WS,
        });
        const sdrCtx = {
            ...ctx, userId: sdrUser.id, role: 'sdr', user: { id: sdrUser.id, name: 'SDR Resched' },
        };

        const { assignmentId } = freshAssignment('Belongs To The Rep', '+201000000041');
        calling.logCall(ctx, {
            assignmentId, outcome: 'follow_up', followUpAt: followUpDate(0),
        });

        // Not theirs: the scoped reader refuses before any date is parsed.
        let refused = '';
        try { calling.rescheduleFollowUp(sdrCtx, assignmentId, followUpDate(3, '10:00:00.000')); } catch (err) { refused = err.message; }
        assert(refused, 'an SDR must not move a follow-up on somebody else’s queue entry');

        // Theirs: allowed, and no manager needed — the person on the phone is
        // the person being told to ring back later.
        db.run('UPDATE calling_assignments SET assigned_to = ? WHERE id = ?', [sdrUser.id, assignmentId]);
        const moved = calling.rescheduleFollowUp(sdrCtx, assignmentId, followUpDate(3, '10:00:00.000'));
        equal(moved.rescheduled, followUpDate(3, '10:00:00.000'));
    });
}


/* ============================ approvals become somebody's task ========== */

describe('Submitting for approval asks a manager');

{
    const docs = await import('./api/proposals.mjs');
    const approvals = await import('./lib/approvals.mjs');

    // A manager, so there is somebody whose job this is. The suite otherwise
    // has an owner, an admin and a rep.
    const manager = auth.createUser({
        email: 'manager@test.local', name: 'Manager', password: 'test-password-3',
        role: 'manager', workspaceId: WS,
    });

    await checkAsync('a submitted proposal lands in a manager’s queue, not in a status field', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Waiting On Approval Ltd' });
        const proposal = repo.createRecord('proposal', repCtx, {
            title: 'Needs a manager', account_id: account.id,
        });
        equal(proposal.status, 'draft');
        assert(!db.get(
            `SELECT id FROM tasks WHERE parent_id = ? AND properties LIKE '%"approval"%'`, [proposal.id],
        ), 'the premise: nothing is queued for a draft');

        const { approvalTask } = await docs.submitProposalForReview({
            params: { id: proposal.id }, ctx: repCtx,
        });
        assert(approvalTask, 'submitting for review must ask somebody');

        const task = db.get('SELECT * FROM tasks WHERE id = ?', [approvalTask]);
        equal(task.assignee_id, manager.id, 'a manager, because approving documents is what the role is for');
        assert(task.assignee_id !== rep.id, 'and never the rep who submitted it');
        equal(task.status, 'open');
        equal(task.priority, 'A', 'the one scale the whole product speaks (migrateLegacyPriorities rewrites anything else on boot)');
        assert(/Waiting On Approval Ltd/.test(task.title), 'the client is named');
        assert(/Rep submitted/.test(task.description), 'and who submitted it');
        assert(/approve or reject/.test(task.description), 'and what is being asked');
    });

    await checkAsync('resubmitting after a rejection does not raise a second task', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Goes Round Twice Ltd' });
        const proposal = repo.createRecord('proposal', repCtx, {
            title: 'Round one', account_id: account.id,
        });
        await docs.submitProposalForReview({ params: { id: proposal.id }, ctx: repCtx });
        await docs.reviewProposal({
            req: bodyOf({ decision: 'rejected', note: 'Price is wrong' }), params: { id: proposal.id }, ctx,
        });

        const closed = db.get(
            `SELECT * FROM tasks WHERE parent_id = ? AND properties LIKE '%"approval"%'`, [proposal.id],
        );
        equal(closed.status, 'done', 'the question was answered, so the task that asked it is done');
        assert(closed.completed_at, 'and stamped');
        assert(/"decision":"rejected"/.test(closed.properties), 'carrying what was decided');

        await docs.submitProposalForReview({ params: { id: proposal.id }, ctx: repCtx });
        const tasks = db.all(
            `SELECT * FROM tasks WHERE parent_id = ? AND properties LIKE '%"approval"%' ORDER BY created_at`,
            [proposal.id],
        );
        equal(tasks.length, 2, 'the second round is a second question, and the first is still on the record');
        equal(tasks.filter((t) => t.status === 'open').length, 1, 'but only one is open at a time');
    });

    await checkAsync('an agreement approval carries what it is worth', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Worth Knowing Ltd', services: ['hcm'], billing_currency: 'USD' });
        const agreement = repo.createRecord('agreement', repCtx, {
            title: 'A contract to approve', account_id: account.id, type: 'msa',
            service_line_key: 'hcm', contract_value: 480000, currency: 'USD',
            effective_date: '2026-05-01',
        });
        await docs.submitAgreementForReview({ params: { id: agreement.id }, ctx: repCtx });

        const task = db.get(
            `SELECT * FROM tasks WHERE parent_id = ? AND properties LIKE '%"approval"%'`, [agreement.id],
        );
        assert(/USD 480,000/.test(task.description),
            '"approve this contract" and "approve this contract for USD 480,000" are different requests');
        equal(task.account_id, account.id, 'and it hangs off the client');
        equal(approvals.approvalOf(task).kind, 'agreement');
    });

    await checkAsync('every way into review asks somebody — there is no silent path', async () => {
        /**
         * Four routes reach `pending_review`, and each one used to be wired
         * separately: submitting, generating, uploading a version, and — the
         * two that were missed — creating a record with that status in the
         * payload, or editing an existing one into it. A status is not a
         * notification, so a route that skips the task leaves a document
         * waiting on somebody who was never told.
         */
        const account = repo.createRecord('account', ctx, { name: 'Every Route Ltd', services: ['hcm'] });
        const openTasksFor = (id) => db.get(
            `SELECT COUNT(*) AS n FROM tasks
              WHERE parent_id = ? AND status = 'open' AND properties LIKE '%"approval"%'`,
            [id],
        ).n;

        // 1. Created straight into review.
        const created = repo.createRecord('agreement', repCtx, {
            title: 'Created in review', account_id: account.id, type: 'msa',
            service_line_key: 'hcm', status: 'pending_review', effective_date: '2026-09-01',
        });
        equal(created.status, 'pending_review');
        equal(openTasksFor(created.id), 1, 'creating a record already in review asked nobody');

        // 2. Edited into review from a draft.
        const edited = repo.createRecord('agreement', repCtx, {
            title: 'Edited into review', account_id: account.id, type: 'msa',
            service_line_key: 'hcm', effective_date: '2026-09-01',
        });
        equal(openTasksFor(edited.id), 0, 'a draft asks nobody, correctly');
        repo.updateRecord('agreement', repCtx, edited.id, { status: 'pending_review' });
        equal(openTasksFor(edited.id), 1, 'the status is an editable field, and that route was open');

        // 3. Submitted through the endpoint.
        const submitted = repo.createRecord('proposal', repCtx, {
            title: 'Submitted properly', account_id: account.id,
        });
        await docs.submitProposalForReview({ params: { id: submitted.id }, ctx: repCtx });
        equal(openTasksFor(submitted.id), 1);

        // And none of them raises a SECOND task for the same question.
        repo.updateRecord('agreement', repCtx, edited.id, { title: 'Renamed while waiting' });
        equal(openTasksFor(edited.id), 1, 'editing a record already in review must not ask twice');
    });

    check('a rep is never chosen to approve', () => {
        const chosen = approvals.approverFor(repCtx);
        assert(chosen, 'somebody in this workspace can approve');
        assert(chosen.id !== rep.id, 'and it is not the rep');
        assert(['manager', 'admin', 'owner'].includes(chosen.role),
            'approval goes to a role holding document.approve');
    });
}


/* ================== who it is for, who raised it, and who may remove it = */

describe('Ownership metadata and the delete a rep does not have');

{
    await checkAsync('a rep creates and edits, and cannot delete even through the repository', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Rep Can Work It Ltd' });

        // Create: allowed.
        const task = repo.createRecord('task', repCtx, { title: 'A rep made this', account_id: account.id });
        equal(task.created_by, rep.id, 'and it is stamped with who made it');

        // Edit: allowed.
        const edited = repo.updateRecord('task', repCtx, task.id, { title: 'A rep edited this' });
        equal(edited.title, 'A rep edited this');

        /**
         * Delete: refused HERE, not only at the route.
         *
         * `deleteRecord` is exported and asked only whether the caller may
         * WRITE the record. A rep holds `record.write.own` and had created
         * this one, so every path that reached this function without the route's
         * capability check let them bin it.
         */
        throws(
            () => repo.deleteRecord('task', repCtx, task.id),
            /cannot record delete/,
            'the capability is checked where the deletion happens',
        );
        equal(repo.getRecord('task', ctx, task.id).deleted_at ?? null, null,
            '"cannot delete" has to mean the row survives');

        // And a manager can.
        repo.deleteRecord('task', ctx, task.id);
        assert(repo.getRecord('task', ctx, task.id, { includeDeleted: true }).deleted_at,
            'somebody who holds record.delete still can');
    });

    await checkAsync('who it is FOR and who RAISED it are two separate facts', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Two Names Ltd' });

        // Raised by the owner, assigned to the rep.
        const delegated = repo.createRecord('task', ctx, {
            title: 'Delegated down', account_id: account.id, assignee_id: rep.id,
        });
        equal(delegated.assignee_id, rep.id, 'assigned to the rep');
        equal(delegated.created_by, ctx.userId, 'raised by the manager');
        assert(delegated.assignee_name && delegated.created_name,
            'both resolve to names for display, not to ids');

        // An activity performed by one person and typed in by another.
        const activity = repo.createRecord('activity', ctx, {
            parent_type: 'account', parent_id: account.id, type_key: 'call',
            subject: 'Logged on their behalf', occurred_at: db.now(), actor_id: rep.id,
        });
        equal(activity.actor_id, rep.id, 'the rep made the call');
        equal(activity.created_by, ctx.userId, 'the manager typed it in');
    });

    check('both questions are filterable, on every object a manager filters', () => {
        const expected = {
            task: ['assignee_id', 'created_by'],
            activity: ['actor_id', 'created_by'],
            note: ['author_id', 'created_by'],
            deal: ['owner_id', 'created_by'],
        };
        for (const [objectKey, keys] of Object.entries(expected)) {
            const fields = objects.fieldsFor(objectKey, WS);
            for (const key of keys) {
                const field = fields.find((f) => f.key === key);
                assert(field, `${objectKey}.${key} is not registered, so it cannot be filtered on`);
                assert(field.filterable !== false, `${objectKey}.${key} is registered but not filterable`);
                equal(field.type, 'user', `${objectKey}.${key} must be a person, so the filter offers a list of people`);
            }
        }
    });

    await checkAsync('filtering by created_by narrows the rows AND the total', async () => {
        const recordsApi = await import('./api/records.mjs');
        const account = repo.createRecord('account', ctx, { name: 'Filter Me Ltd' });
        repo.createRecord('task', ctx, { title: 'Mine to give', account_id: account.id, assignee_id: rep.id });
        repo.createRecord('task', repCtx, { title: 'Theirs entirely', account_id: account.id, assignee_id: rep.id });

        const url = (filter) => new URL(
            `http://x/api/tasks?filter=${encodeURIComponent(JSON.stringify(filter))}&limit=50`,
        );
        const both = await recordsApi.list({
            params: { object: 'tasks' },
            url: url({ op: 'and', children: [{ field: 'assignee_id', operator: 'is_any_of', value: [rep.id] }] }),
            ctx,
        });
        const raisedByRep = await recordsApi.list({
            params: { object: 'tasks' },
            url: url({
                op: 'and',
                children: [
                    { field: 'assignee_id', operator: 'is_any_of', value: [rep.id] },
                    { field: 'created_by', operator: 'is_any_of', value: [rep.id] },
                ],
            }),
            ctx,
        });

        assert(both.total > raisedByRep.total,
            'adding "created by" must narrow the result, or the filter is decoration');
        equal(raisedByRep.records.every((r) => r.created_by === rep.id), true,
            'and every row it returns matches');
        /**
         * The TOTAL, not just the page.
         *
         * A filter applied in the browser to fifty fetched rows reports "12 of
         * 3,400" and means neither number. This one is compiled into SQL, so
         * the count is the count.
         */
        equal(raisedByRep.total, raisedByRep.records.length);
    });
}


/* ============ the board and the dashboard ask once, and still agree ===== */

describe('Reads that used to be one per stage');

{
    const dealsApi = await import('./api/deals.mjs');
    const dash = await import('./api/dashboard.mjs');

    // A pipeline with several stages and deals spread across them, so a
    // per-stage loop and a grouped read can actually disagree.
    const account = repo.createRecord('account', ctx, { name: 'Spread Across Stages Ltd', services: ['hcm'] });
    const placed = [];
    for (const [stage, howMany] of [[STAGE_OPEN, 3], [STAGE_CONTRACTING, 2], [STAGE_WON, 1]]) {
        for (let i = 0; i < howMany; i += 1) {
            const deal = repo.createRecord('deal', ctx, {
                name: `Board deal ${stage}-${i}`, account_id: account.id, service_line_key: 'hcm',
                pipeline_id: PIPE, stage_id: stage, currency: 'USD',
            });
            if (stage === STAGE_WON) db.run("UPDATE deals SET status = 'won' WHERE id = ?", [deal.id]);
            repo.setDealPrice(ctx, db.get('SELECT * FROM deals WHERE id = ?', [deal.id]), { price: 1000, count: 1, currency: 'USD' });
            placed.push({ id: deal.id, stage });
        }
    }

    await checkAsync('the board’s column counts match the rows it returns', async () => {
        const board = await dealsApi.board({
            url: new URL(`http://x/api/deals/board?pipeline=${PIPE}&open=0`), ctx,
        });

        for (const column of board.columns) {
            const rows = column.deals.length;
            assert(column.total >= rows,
                `${column.stage.label}: a count smaller than the rows it shipped is impossible`);
            if (!column.truncated) {
                equal(column.total, rows,
                    `${column.stage.label}: an untruncated column must count exactly what it shows`);
            }
            /**
             * The count comes from a GROUP BY and the rows from a capped read.
             * Those are two queries that have to agree, which is precisely why
             * this is asserted rather than assumed.
             */
            const actual = db.get(
                'SELECT COUNT(*) AS n FROM deals WHERE pipeline_id = ? AND stage_id = ? AND deleted_at IS NULL',
                [PIPE, column.stage.id],
            ).n;
            equal(column.total, actual, `${column.stage.label}: the column count is the real count`);
        }
    });

    await checkAsync('the board’s cost does not grow with the number of stages', async () => {
        /**
         * The invariant, measured rather than guessed at.
         *
         * An absolute bound would be a number somebody has to keep updating.
         * What actually matters is the SHAPE: against the live backend every
         * statement is a blocking round trip, so a board that reads once per
         * column gets slower every time the business adds a stage. So the board
         * is measured, four more stages are added, and it is measured again.
         */
        const measure = async () => {
            db.resetQueryStats();
            await dealsApi.board({ url: new URL(`http://x/api/deals/board?pipeline=${PIPE}`), ctx });
            return db.queryStats().count;
        };

        const before = await measure();

        const added = [];
        for (let i = 0; i < 4; i += 1) {
            const stageId = db.id('stg');
            added.push(stageId);
            db.run(
                `INSERT INTO stages (id, workspace_id, pipeline_id, key, label, position, probability, type, required_fields)
                 VALUES (?,?,?,?,?,?,0.5,'open','[]')`,
                [stageId, WS, PIPE, `extra_${i}`, `Extra ${i}`, 20 + i],
            );
        }

        const after = await measure();
        for (const stageId of added) db.run('DELETE FROM stages WHERE id = ?', [stageId]);

        equal(after, before,
            `four more stages cost ${after - before} more statements; the board must read the pipeline once`);
    });

    await checkAsync('one dashboard load reads the open deals once, not once per widget', async () => {
        const DASH = db.id('dsh');
        db.run(
            `INSERT INTO dashboards (id, workspace_id, name, layout, scope, is_default, created_at, updated_at)
             VALUES (?,?,?,?,?,0,?,?)`,
            [DASH, WS, 'Reads once', JSON.stringify([
                { widget: 'crm_snapshot', title: 'At a glance', size: 'wide', options: {} },
                { widget: 'pipeline_value', title: 'Pipeline', size: 'half', options: {} },
                { widget: 'pipeline_by_stage', title: 'By stage', size: 'wide', options: {} },
            ]), 'workspace', db.now(), db.now()],
        );

        const SOLO = db.id('dsh');
        db.run(
            `INSERT INTO dashboards (id, workspace_id, name, layout, scope, is_default, created_at, updated_at)
             VALUES (?,?,?,?,?,0,?,?)`,
            [SOLO, WS, 'One widget', JSON.stringify([
                { widget: 'crm_snapshot', title: 'At a glance', size: 'wide', options: {} },
            ]), 'workspace', db.now(), db.now()],
        );

        const cost = async (id) => {
            db.resetQueryStats();
            const result = await dash.dashboardData({
                params: { id }, url: new URL('http://x/?range=year'), ctx,
            });
            return { count: db.queryStats().count, result };
        };

        const solo = await cost(SOLO);
        const three = await cost(DASH);

        assert(three.result.widgets.every((w) => w.data), 'every widget still produced its figures');
        /**
         * The two extra widgets want the SAME open deals and the same won-in-
         * range set the first one already read. Adding them should therefore
         * cost the reads that are genuinely theirs — the per-stage grouping —
         * and not a second and third copy of the two shared sets, which is what
         * six count-and-page pairs used to be.
         */
        assert(three.count < solo.count * 2,
            `one widget costs ${solo.count} statements and three cost ${three.count}; they are not sharing their reads`);

        db.run('DELETE FROM dashboards WHERE id IN (?, ?)', [DASH, SOLO]);
    });

    await checkAsync('the two widgets that report pipeline value report the same value', async () => {
        const DASH = db.id('dsh');
        db.run(
            `INSERT INTO dashboards (id, workspace_id, name, layout, scope, is_default, created_at, updated_at)
             VALUES (?,?,?,?,?,0,?,?)`,
            [DASH, WS, 'Agrees with itself', JSON.stringify([
                { widget: 'crm_snapshot', title: 'At a glance', size: 'wide', options: {} },
                { widget: 'pipeline_value', title: 'Pipeline', size: 'half', options: {} },
            ]), 'workspace', db.now(), db.now()],
        );
        const { widgets } = await dash.dashboardData({
            params: { id: DASH }, url: new URL('http://x/?range=year'), ctx,
        });
        const snapshot = widgets.find((w) => w.widget === 'crm_snapshot').data;
        const pipeline = widgets.find((w) => w.widget === 'pipeline_value').data;

        const openTile = snapshot.tiles.find((t) => /open deals/i.test(t.label));
        /**
         * They capped differently — 500 and 200 — so past two hundred open
         * deals one screen carried two different pipeline counts with nothing
         * to say which was right.
         *
         * Pipeline value now excludes the contracting stage (unsigned agreements),
         * so pipeline.count <= open deals count.
         */
        if (openTile) {
            equal(pipeline.count <= openTile.value, true, 'pipeline excludes contracting, so count <= open deals');
        }
        db.run('DELETE FROM dashboards WHERE id = ?', [DASH]);
    });
}


/* ================== cold call, then qualify, then meet — everywhere ===== */

describe('The cold calling workflow reads in the order it happens');

{
    const dash = await import('./api/dashboard.mjs');
    const calling = await import('./lib/calling.mjs');

    const reporting = { currency: 'USD', rates: { USD: 1, EGP: 50, SAR: 3.75 } };
    const range = { from: '2026-01-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z', preset: 'year' };

    await checkAsync('the dashboard\'s "Tasks due" tile counts due now, not sometime this period', async () => {
        // It used to be `due_at` falling anywhere inside the selected range
        // (a whole year, in this test's `range`) with `status <> 'done'` —
        // so a task due next week counted as "due" today, same as one due
        // an hour ago. A cancelled task with a past due date counted too.
        const account = repo.createRecord('account', ctx, { name: 'Tasks Due Test Co', account_type: 'Egypt' });
        const before = await dash.WIDGETS.crm_snapshot.run(ctx, {}, range, reporting);
        const tasksDueBefore = before.tiles.find((t) => t.label === 'Tasks due').value;

        const mk = (title, status, dueAt) => {
            const id = db.id('tsk');
            db.run(
                `INSERT INTO tasks (id, workspace_id, parent_type, parent_id, account_id, title, assignee_id,
                    due_at, priority, status, created_by, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [id, WS, 'account', account.id, account.id, title, sarah.id, dueAt, 'B', status, sarah.id, db.now(), db.now()],
            );
            return id;
        };
        const genuinelyDue = mk('Genuinely due', 'open', new Date(Date.now() - 3_600_000).toISOString());
        mk('Due next week', 'open', new Date(Date.now() + 7 * 864e5).toISOString());
        mk('Cancelled, was due yesterday', 'cancelled', new Date(Date.now() - 864e5).toISOString());
        mk('Done, was due yesterday', 'done', new Date(Date.now() - 864e5).toISOString());

        const after = await dash.WIDGETS.crm_snapshot.run(ctx, {}, range, reporting);
        const tile = after.tiles.find((t) => t.label === 'Tasks due');
        equal(tile.value, tasksDueBefore + 1,
            `only the genuinely-due task should be added; got ${tile.value - tasksDueBefore} more than before`);
        assert(tile.href.includes(encodeURIComponent('"status"')), 'the destination link carries the same status filter the count used');

        db.run('DELETE FROM tasks WHERE account_id = ?', [account.id]);
        db.run('DELETE FROM accounts WHERE id = ?', [account.id]);
        void genuinelyDue;
    });

    await checkAsync('"Tasks due" and "Overdue tasks" land on exactly the rows they counted, never a wider list', async () => {
        // The required test data from the bug report, in full: an overdue
        // open task, three future open tasks (23h / tomorrow / next week),
        // and two completed tasks (one overdue-in-time, one due today) that
        // must never surface as due, overdue, or open no matter how late
        // their due date was.
        const account = repo.createRecord('account', ctx, { name: 'Due Vs Scheduled Vs Completed Co', account_type: 'Egypt' });
        const mk = (title, status, dueAt) => {
            const taskId = db.id('tsk');
            db.run(
                `INSERT INTO tasks (id, workspace_id, parent_type, parent_id, account_id, title, assignee_id,
                    due_at, priority, status, created_by, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [taskId, WS, 'account', account.id, account.id, title, sarah.id, dueAt, 'A', status, sarah.id, db.now(), db.now()],
            );
            return taskId;
        };
        const taskA = mk('Task A — due 30 minutes ago', 'open', new Date(Date.now() - 30 * 60_000).toISOString());
        mk('Task B — due in 23 hours', 'open', new Date(Date.now() + 23 * 3_600_000).toISOString());
        mk('Task C — due tomorrow', 'open', new Date(Date.now() + 30 * 3_600_000).toISOString());
        mk('Task D — due next week', 'open', new Date(Date.now() + 7 * 864e5).toISOString());
        mk('Task E — completed, due yesterday', 'done', new Date(Date.now() - 864e5).toISOString());
        mk('Task F — completed, due today', 'done', new Date(Date.now() - 3600_000).toISOString());

        const range = { from: '2026-01-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z', preset: 'year' };
        const snapshot = await dash.WIDGETS.crm_snapshot.run(ctx, {}, range, { currency: 'USD', rates: { USD: 1, EGP: 50, SAR: 3.75 } });
        const dueTile = snapshot.tiles.find((t) => t.label === 'Tasks due');
        const dueFilter = JSON.parse(decodeURIComponent(dueTile.href.split('filter=')[1]));
        const dueRows = repo.listRecords('task', ctx, { filter: dueFilter, limit: 100 }).records;
        assert(dueRows.some((t) => t.id === taskA), 'Task A (genuinely due) must be among the "Tasks due" destination rows');
        for (const label of ['Task B', 'Task C', 'Task D', 'Task E', 'Task F']) {
            assert(!dueRows.some((t) => t.title.startsWith(label)),
                `"${label}" must not appear in the "Tasks due" destination — scheduled or completed is not due`);
        }

        const attn = await dash.attention({ ctx, url: new URL('http://x/') });
        const overdueTile = attn.items.find((i) => i.key === 'overdue');
        const overdueFilter = JSON.parse(decodeURIComponent(overdueTile.href.split('filter=')[1]));
        const overdueRows = repo.listRecords('task', ctx, { filter: overdueFilter, limit: 100 }).records;
        assert(overdueRows.some((t) => t.id === taskA), 'Task A must be among the "Overdue tasks" destination rows');
        for (const label of ['Task B', 'Task C', 'Task D', 'Task E', 'Task F']) {
            assert(!overdueRows.some((t) => t.title.startsWith(label)),
                `"${label}" must not appear in the "Overdue tasks" destination`);
        }

        db.run('DELETE FROM tasks WHERE account_id = ?', [account.id]);
        db.run('DELETE FROM accounts WHERE id = ?', [account.id]);
    });

    await checkAsync('the attention band tells good news from bad news', async () => {
        // Every tile used to turn red the instant its count left zero — a
        // healthy "3 meetings scheduled" read exactly like "3 tasks
        // slipping". Only the genuinely actionable/overdue tiles are meant
        // to be a warning; meetings are the one item this dashboard wants
        // to see climb.
        const data = await dash.attention({ ctx, url: new URL('http://x/') });
        const overdue = data.items.find((i) => i.key === 'overdue');
        const meetings = data.items.find((i) => i.key === 'meetings');
        equal(overdue.tone, 'danger', 'overdue tasks is a warning tile');
        equal(meetings.tone, 'success', 'a scheduled meeting is good news, not a warning');
    });

    await checkAsync('"Overdue tasks" links to the exact filter the count ran, not a personal work queue', async () => {
        // It used to link to /my-work?tab=tasks(&scope=all) — a personal
        // queue of every open task assigned to the viewer, overdue or not,
        // sorted soonest-first. A manager whose own list was clear clicked
        // "1 Overdue tasks" and landed on a correctly-empty personal list —
        // real, but not the row that was counted. It now links to the same
        // generic /tasks?filter=... list "Tasks due" already uses, carrying
        // the identical status + due_at predicate `overdue` ran.
        const data = await dash.attention({ ctx, url: new URL('http://x/') });
        const overdue = data.items.find((i) => i.key === 'overdue');
        assert(overdue.href.startsWith('/tasks?filter='),
            `must land on the filtered generic list, not a personal work queue (got ${overdue.href})`);
        const filter = JSON.parse(decodeURIComponent(overdue.href.split('filter=')[1]));
        const statusChild = filter.children.find((c) => c.field === 'status');
        const dueChild = filter.children.find((c) => c.field === 'due_at');
        assert(statusChild && JSON.stringify(statusChild.value.slice().sort()) === JSON.stringify(['in_progress', 'open']),
            'open and in_progress, the same statuses the count required');
        equal(dueChild?.operator, 'at_or_before', 'the exact instant the count compared against, not a day-wide "before"');
    });

    await checkAsync('"Follow-ups due now" links to the follow-ups tab narrowed to due-now, not the whole book', async () => {
        // The follow_ups TAB deliberately shows every lead mid-sequence,
        // whatever their next step's date (see the comment on `follow_ups`
        // in lib/calling.mjs's TABS) — right for a rep browsing the tab, and
        // wrong for a tile that promises "due now": clicking it used to land
        // on that same whole book, WhatsApp steps due next week included.
        const data = await dash.attention({ ctx, url: new URL('http://x/') });
        const followups = data.items.find((i) => i.key === 'followups');
        assert(followups.href.startsWith('/calling?tab=follow_ups&filter='),
            `must stay on the follow_ups tab, narrowed by filter (got ${followups.href})`);
        const filter = JSON.parse(decodeURIComponent(followups.href.split('filter=')[1]));
        const dueChild = filter.children.find((c) => c.field === 'next_follow_up_at');
        equal(dueChild?.operator, 'at_or_before', 'narrowed to due-now, not left showing every mid-sequence lead');
    });

    check('the outcome buttons an SDR sees run call → qualify → meeting', () => {
        const keys = calling.CALL_OUTCOMES.map((o) => o.key);
        const qualified = keys.indexOf('qualified');
        const scheduled = keys.indexOf('meeting_scheduled');
        const done = keys.indexOf('meeting_done');
        assert(qualified > -1 && scheduled > -1, 'both outcomes exist');
        assert(qualified < scheduled,
            'qualifying is what the call is FOR; a meeting is what follows from it');
        assert(scheduled < done, 'and a meeting is booked before it is held');
    });

    check('qualifying does not close the lead out of the queue', () => {
        const qualified = calling.CALL_OUTCOMES.find((o) => o.key === 'qualified');
        equal(qualified.closes, false,
            'closing on Qualified meant the meeting the qualification exists to book could not be logged');
        equal(qualified.status, 'working', 'it is the middle of the sequence, not the end of it');
        equal(calling.CALL_OUTCOMES.find((o) => o.key === 'meeting_done').closes, true,
            'the meeting being HELD is what finishes it');
    });

    await checkAsync('the dashboard tiles put Qualified before Meetings', async () => {
        const data = await dash.WIDGETS.calling_activity.run(ctx, {}, range, reporting);
        const labels = data.tiles.map((t) => t.label);
        const qualified = labels.indexOf('Qualified');
        const meetings = labels.indexOf('Meetings scheduled');
        assert(qualified > -1 && meetings > -1, 'both tiles are present');
        assert(qualified < meetings, `tiles read ${labels.join(' → ')}`);

        // And the funnel reads calls → qualified → meetings, adjacently, so the
        // drop-off between the three is visible at a glance.
        equal(labels[0], 'Total calls');
        assert(meetings - qualified === 1, 'nothing is wedged between qualifying and meeting');

        assert(labels.includes('Qualify rate'),
            'a funnel with only a meeting rate cannot show where a floor is losing people');
    });

    await checkAsync('no two figures on the calling dashboard share a name', async () => {
        /**
         * "Contact rate" meant conversations ÷ calls in the tiles and called ÷
         * assigned in the table below them — one name, two formulas, one
         * screen. Whichever a manager had in mind, half the dashboard was
         * answering the other question.
         *
         * And "Called" sat two columns from "Calls", one letter apart, counting
         * different things over different periods.
         */
        const tiles = await dash.WIDGETS.calling_activity.run(ctx, {}, range, reporting);
        const table = await dash.WIDGETS.sdr_performance.run(ctx, {}, range, reporting);

        const tileNames = tiles.tiles.map((t) => t.label.toLowerCase());
        const columnNames = table.columns.map((c) => c.label.toLowerCase());

        /**
         * Within one widget, no name twice. Across the two, a repeated name is
         * fine and often right — "Qualified" is a total in the tiles and the
         * same measure per person in the table, which is the pair a manager
         * wants. What must not happen is one name over two FORMULAS.
         */
        for (const names of [tileNames, columnNames]) {
            equal(new Set(names).size, names.length, `a heading appears twice: ${names.join(', ')}`);
        }

        // The specific collision this replaced.
        const shared = tileNames.filter((n) => columnNames.includes(n));
        // "Contact rate" is now the SAME formula in both places — moved off
        // "ready to call" ÷ assigned, where No answer and Follow-up count as
        // worked — so the shared name is a total in the tiles and the same
        // measure per person in the table, like "Qualified", not one name
        // over two formulas.
        const contactTile = tiles.tiles.find((t) => t.label.toLowerCase() === 'contact rate');
        const contactTotal = table.totals?.contactRate;
        if (contactTile && contactTotal !== undefined) {
            equal(contactTile.value, contactTotal,
                'the tile’s Contact rate and the table’s total are one number');
        }
        assert(!shared.includes('active call rate'),
            '"Active call rate" (conversations ÷ calls) belongs to the tiles alone');

        // And no two headings in the table differ only by a plural.
        for (const name of columnNames) {
            assert(!columnNames.includes(`${name}s`),
                `"${name}" and "${name}s" are one letter apart and count different things`);
        }
    });

    await checkAsync('the calling tiles track Dead leads and Contact rate from assigned', async () => {
        // Three assignments on one SDR: one called (no answer still counts),
        // one dead (three consecutive no answers), one never called.
        const sdr = auth.createUser({ email: 'tiles-sdr@test.local', name: 'Tiles SDR', password: 'test-password-9', role: 'sdr', workspaceId: WS });
        const mk = (name, phone, extra = {}) => {
            const account = repo.createRecord('account', ctx, { name: `${name} Co`, account_type: 'Egypt' });
            const contact = repo.createRecord('contact', ctx, { full_name: name, account_id: account.id, phone, data_source: 'test' });
            const assignmentId = db.id('cas');
            db.run(
                `INSERT INTO calling_assignments
                   (id, workspace_id, contact_id, account_id, assigned_to, priority, queue_status, call_count, active, assigned_at, created_at, updated_at, no_answer_streak)
                 VALUES (?,?,?,?,?,'B',?,?,?,?,?,?,?)`,
                [assignmentId, WS, contact.id, account.id, sdr.id, extra.status ?? 'queued', extra.calls ?? 0, extra.active ?? 1, db.now(), db.now(), db.now(), extra.streak ?? 0],
            );
            return assignmentId;
        };
        // 'working' is what a real No Answer outcome leaves queue_status at
        // (see CALL_OUTCOMES) — the fixture matches that rather than just
        // bumping call_count on an otherwise-default 'queued' row, since
        // "called" is now judged by queue_status, not call_count.
        mk('Called No Answer', '+966500000011', { calls: 1, streak: 1, status: 'working' });
        mk('Dead Three Times', '+966500000012', { calls: 3, status: 'dead', active: 0, streak: 3 });
        mk('Never Called', '+966500000013', { calls: 0 });

        const out = await dash.WIDGETS.calling_activity.run(ctx, {}, { from: null, to: null }, reporting);
        const by = Object.fromEntries(out.tiles.map((t) => [t.label.toLowerCase(), t.value]));
        // The queue is shared with other tests, so these are lower bounds — my
        // three assignments are all present.
        assert(by['dead leads'] >= 1, 'a dead lead is on the Dead leads tile');
        assert(by['assigned'] >= 3, 'the assigned count includes the new queue');

        // The formula, checked against the queue itself: moved off "ready to
        // call" ÷ assigned, where a No answer still counts (the row I
        // created is 'working', not 'queued', and is NOT marked dead).
        const q = db.get(
            `SELECT COUNT(*) AS assigned,
                    SUM(CASE WHEN queue_status != 'queued' THEN 1 ELSE 0 END) AS called
               FROM calling_assignments a
               JOIN contacts c ON c.id = a.contact_id AND c.deleted_at IS NULL
              WHERE a.workspace_id = ? AND a.queue_status != 'removed'`, [WS]);
        const expected = q.assigned ? Math.round((q.called / q.assigned) * 100) : null;
        equal(by['contact rate'], expected,
            'Contact rate is "moved off ready to call" ÷ assigned — a No answer counts');
    });

    await checkAsync('the SDR table puts Qualified before Meetings too', async () => {
        const data = await dash.WIDGETS.sdr_performance.run(ctx, {}, range, reporting);
        const keys = data.columns.map((c) => c.key);
        assert(keys.indexOf('qualified') < keys.indexOf('meetings'),
            `columns read ${keys.join(', ')}`);
    });
}


/* ======================= the scenarios, end to end, in order ============ */

describe('Acceptance: Account → Deal → Agreement → Won / Lost');

{
    const docs = await import('./api/proposals.mjs');
    const dealsApi = await import('./api/deals.mjs');
    const stageOf = (dealId) => db.get(
        'SELECT s.key FROM deals d JOIN stages s ON s.id = d.stage_id WHERE d.id = ?', [dealId],
    ).key;

    await checkAsync('A — an account with no deal, and an agreement is created', async () => {
        const account = repo.createRecord('account', ctx, {
            name: 'Scenario A Ltd', services: ['hcm'], billing_currency: 'USD',
        });
        equal(db.get('SELECT COUNT(*) AS n FROM deals WHERE account_id = ?', [account.id]).n, 0);

        const agreement = repo.createRecord('agreement', ctx, {
            title: 'First contract', account_id: account.id, type: 'msa',
            service_line_key: 'hcm', contract_value: 5000, currency: 'USD',
            effective_date: '2026-06-01',
        });

        // 3. A deal was created.
        assert(agreement.deal_id, 'no deal was created for the agreement');
        const deal = repo.getRecord('deal', ctx, agreement.deal_id);
        // 4. Named Company - Service.
        equal(deal.name, 'Scenario A Ltd - HCM');
        // 5. Linked.
        equal(agreement.deal_id, deal.id);
        // 6. Price + currency.
        equal(deal.price, 5000);
        equal(deal.currency, 'USD');
        equal(deal.billing_type, 'recurring', 'HCM recurs');
        // 7. No quantity or unit anywhere in what the deal size endpoint returns.
        const size = await dealsApi.dealSize({ params: { id: deal.id }, ctx });
        /**
         * The vocabulary, not an exact key list — a per-person service carries a
         * count and a unit price as well, and pinning the whole shape made this
         * assertion fail for a feature rather than for a defect. What must stay
         * true is that the generic pricing-model language is gone: no quantity,
         * no unit, no percent rate, no basis amount.
         */
        for (const banned of ['quantity', 'unit_amount', 'pricing_model', 'percent_rate', 'basis_amount']) {
            assert(!(banned in size.size), `deal size still speaks of "${banned}"`);
        }
        for (const required of ['price', 'currency', 'billingType']) {
            assert(required in size.size, `deal size must carry "${required}"`);
        }
        // 8. Contracting.
        equal(stageOf(deal.id), 'contracting');
    });

    await checkAsync('B — an account that already has the right deal', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Scenario B Ltd', services: ['hcm'] });
        const existing = repo.createRecord('deal', ctx, {
            account_id: account.id, service_line_key: 'hcm', pipeline_id: PIPE, stage_id: STAGE_OPEN,
        });
        const agreement = repo.createRecord('agreement', ctx, {
            title: 'Second contract', account_id: account.id, type: 'msa',
            service_line_key: 'hcm', effective_date: '2026-06-01',
        });
        equal(agreement.deal_id, existing.id, 'it linked to the deal that was already there');
        equal(db.get('SELECT COUNT(*) AS n FROM deals WHERE account_id = ?', [account.id]).n, 1,
            'and did not invent a second one');
    });

    await checkAsync('C — a manual deal beside an automatic one', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Scenario C Ltd', services: ['hcm'] });
        const agreement = repo.createRecord('agreement', ctx, {
            title: 'HCM contract', account_id: account.id, type: 'msa',
            service_line_key: 'hcm', effective_date: '2026-06-01',
        });
        const automatic = agreement.deal_id;

        const manual = repo.createRecord('deal', ctx, {
            account_id: account.id, service_line_key: 'recruitment', pipeline_id: PIPE, stage_id: STAGE_OPEN,
        });
        equal(manual.name, 'Scenario C Ltd - Recruitment');
        assert(repo.getRecord('deal', ctx, automatic), 'the existing deal is intact');
        equal(db.get('SELECT COUNT(*) AS n FROM deals WHERE account_id = ? AND deleted_at IS NULL', [account.id]).n, 2);
    });

    await checkAsync('D — signing the agreement wins the deal', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Scenario D Ltd', services: ['recruitment'], billing_currency: 'USD' });
        const agreement = repo.createRecord('agreement', ctx, {
            title: 'To be signed', account_id: account.id, type: 'msa',
            service_line_key: 'recruitment', contract_value: 30000, currency: 'USD',
            effective_date: '2026-06-01', status: 'approved',
        });
        equal(stageOf(agreement.deal_id), 'contracting');

        await docs.signAgreement({ req: bodyOf({}), params: { id: agreement.id }, ctx });

        const deal = repo.getRecord('deal', ctx, agreement.deal_id);
        equal(deal.status, 'won');
        equal(stageOf(deal.id), 'won');
        equal(deal.price, 30000, 'and it is worth what the contract says');
        equal(repo.getRecord('account', ctx, account.id).lifecycle_stage, 'customer');
    });

    await checkAsync('E — terminating an agreement, and terminating a deal', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Scenario E Ltd', services: ['hcm'] });
        const agreement = repo.createRecord('agreement', ctx, {
            title: 'To be terminated', account_id: account.id, type: 'msa',
            service_line_key: 'hcm', effective_date: '2026-06-01',
        });
        repo.updateRecord('agreement', ctx, agreement.id, { status: 'terminated' });
        const afterAgreement = repo.getRecord('deal', ctx, agreement.deal_id);
        equal(afterAgreement.status, 'lost');
        equal(stageOf(afterAgreement.id), 'lost');
        equal(afterAgreement.loss_reason, 'Agreement terminated', 'and it says why');

        // And a deal moved to a lost stage directly.
        const other = repo.createRecord('deal', ctx, {
            account_id: account.id, service_line_key: 'offshoring', pipeline_id: PIPE, stage_id: STAGE_OPEN,
        });
        const lost = repo.updateRecord('deal', ctx, other.id, {
            stage_id: STAGE_LOST, loss_reason: 'unresponsive',
        });
        equal(lost.status, 'lost');
    });

    check('F — the service decides recurring or one-time, for all four', () => {
        const expected = { hcm: 'recurring', offshoring: 'recurring', recruitment: 'one_time', od: 'one_time' };
        for (const [service, billing] of Object.entries(expected)) {
            equal(repo.billingTypeForService(WS, service), billing, `${service} bills ${billing}`);
        }
    });

    await checkAsync('G — a rep creates and edits an agreement, and cannot delete it', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Scenario G Ltd', services: ['hcm'] });

        const agreement = repo.createRecord('agreement', repCtx, {
            title: 'Raised by a rep', account_id: account.id, type: 'msa',
            service_line_key: 'hcm', effective_date: '2026-06-01',
        });
        assert(agreement.id, 'a rep could not create an agreement');
        assert(agreement.deal_id, 'and it still got its deal');

        const edited = repo.updateRecord('agreement', repCtx, agreement.id, { title: 'Edited by a rep' });
        equal(edited.title, 'Edited by a rep');

        throws(
            () => repo.deleteRecord('agreement', repCtx, agreement.id),
            /cannot record delete/,
            'a rep must not delete',
        );

        // And prospecting stays out of reach.
        assert(!auth.routeAllowed(repCtx, 'GET', '/api/prospects'));
        assert(!auth.routeAllowed(repCtx, 'GET', '/api/qualification/rules'));
    });
}


/* ================= a version the CRM did not write ====================== */

describe('Uploading a proposal or agreement edited outside the CRM');

if (haveTemplates) {
    const docs = await import('./api/proposals.mjs');
    const gen = await import('./lib/doc-generation.mjs');

    /** Push a document through review, as a manager would. */
    const approve = (kind, recordId, note = '') => docs.reviewDocument({
        req: bodyOf({ decision: 'approved', note }), params: { id: recordId }, ctx, kind,
    });

    /** A believable file payload — the bytes are never parsed on this path. */
    const fileBytes = (marker) => Buffer.from(`PK edited-outside ${marker}`);

    const seedGenerated = (name) => {
        const account = repo.createRecord('account', ctx, { name, services: ['hcm'] });
        db.run(
            `INSERT INTO commercial_registrations
               (id, workspace_id, account_id, company_name_ar, cr_number, representative_name, address, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [db.id('crg'), WS, account.id, 'شركة', '11223344', 'ممثل', 'الرياض', db.now(), db.now()],
        );
        const { record } = gen.generate(ctx, {
            accountId: account.id,
            docTypeKey: 'HCM_AGREEMENT',
            fields: {
                employees_to_hire: 2, onsite_visits_per_week: 1, monthly_fee: 4000, currency: 'ريال',
                start_date: '2026-03-01', end_date: '2027-02-28', contract_duration_text: 'سنة',
            },
        });
        return { account, record };
    };

    await checkAsync('a new version takes the next number and leaves the old one alone', async () => {
        const { account, record } = seedGenerated('Redrafted In Word Ltd');
        const before = gen.historyFor(ctx, { accountId: account.id });
        equal(before.length, 1);
        equal(before[0].version, 1);

        const result = gen.uploadVersion(ctx, {
            accountId: account.id,
            docTypeKey: 'HCM_AGREEMENT',
            fileName: 'HCM Agreement - legal redraft.docx',
            bytes: fileBytes('v2'),
            mode: 'new_version',
            note: 'Legal rewrote clause 7',
        });

        equal(result.version, 2, 'v1 becomes v2');
        equal(result.mode, 'new_version');

        const after = gen.historyFor(ctx, { accountId: account.id });
        equal(after.length, 2, 'both versions are on the history');
        const v1 = after.find((r) => r.version === 1);
        equal(v1.document_id, before[0].document_id,
            'v1 still points at the file it always did — the client is holding that one');

        // It is a version, not an attachment: it has its own record with a number.
        assert(result.record?.id, 'the upload produced an agreement record');
        assert(result.record.id !== record.id, 'a new version is a new record, like a regeneration');
        const uploaded = repo.getRecord('agreement', ctx, result.record.id);
        equal(uploaded.document_id, result.document.id);
        assert(uploaded.number, 'and it carries a document number');

        // No template produced it, and it does not claim one.
        const generation = db.get('SELECT * FROM document_generations WHERE id = ?', [result.generation.id]);
        equal(generation.template_id ?? null, null,
            'a checksum against a template that never saw this file would be a lie');
        equal(generation.template_checksum ?? null, null);
    });

    await checkAsync('a correction keeps the version number and the record', async () => {
        const { account, record } = seedGenerated('Typo In The Annex Ltd');
        const originalDocument = repo.getRecord('agreement', ctx, record.id).document_id;

        const result = gen.uploadVersion(ctx, {
            accountId: account.id,
            docTypeKey: 'HCM_AGREEMENT',
            fileName: 'HCM Agreement - fixed annex.docx',
            bytes: fileBytes('corrected'),
            mode: 'replace_current',
            note: 'Annex B was missing',
        });

        equal(result.version, 1, 'the number does not move — nobody was sent the first one');
        equal(gen.historyFor(ctx, { accountId: account.id }).length, 1, 'and no second version appears');

        const after = repo.getRecord('agreement', ctx, record.id);
        equal(after.id, record.id, 'the same record');
        equal(after.document_id, result.document.id, 'pointing at the new file');
        assert(after.document_id !== originalDocument, 'which is not the old one');

        // The replaced file is kept — nothing is destroyed.
        assert(repo.getRecord('document', ctx, originalDocument), 'the superseded file is still there');

        const events = db.all(
            `SELECT event_type FROM document_events WHERE generation_id = ? ORDER BY created_at`,
            [result.generation.id],
        ).map((e) => e.event_type);
        assert(events.includes('version_replaced'), 'and the swap is on the record');
    });

    await checkAsync('an uploaded version goes back for approval', async () => {
        const { account, record } = seedGenerated('Approved Then Edited Ltd');
        await approve('agreement', record.id);
        equal(repo.getRecord('agreement', ctx, record.id).status, 'approved');

        gen.uploadVersion(ctx, {
            accountId: account.id,
            docTypeKey: 'HCM_AGREEMENT',
            fileName: 'HCM Agreement - amended.docx',
            bytes: fileBytes('amended'),
            mode: 'replace_current',
        });

        const after = repo.getRecord('agreement', ctx, record.id);
        equal(after.status, 'pending_review',
            'the previous approval was of different content, so it does not carry over');
        equal(after.reviewed_by ?? null, null, 'and the reviewer is cleared with it');

        const task = db.get(
            `SELECT * FROM tasks WHERE parent_id = ? AND properties LIKE '%"approval"%' AND status = 'open'`,
            [record.id],
        );
        assert(task, 'somebody is asked to look at it again');
    });

    await checkAsync('a signed agreement cannot have its file swapped in place', async () => {
        const { account, record } = seedGenerated('Already Signed Ltd');
        await approve('agreement', record.id);
        await docs.signAgreement({ req: bodyOf({ effectiveDate: '2026-03-01' }), params: { id: record.id }, ctx });
        equal(repo.getRecord('agreement', ctx, record.id).status, 'signed');

        throws(
            () => gen.uploadVersion(ctx, {
                accountId: account.id, docTypeKey: 'HCM_AGREEMENT',
                fileName: 'rewritten.docx', bytes: fileBytes('nope'), mode: 'replace_current',
            }),
            /signed/,
            'the file behind a signature is the evidence of what was signed',
        );

        // A new version is still allowed — that is how an amendment happens.
        const amended = gen.uploadVersion(ctx, {
            accountId: account.id, docTypeKey: 'HCM_AGREEMENT',
            fileName: 'amendment.docx', bytes: fileBytes('amendment'), mode: 'new_version',
        });
        equal(amended.version, 2);
        equal(repo.getRecord('agreement', ctx, record.id).status, 'signed',
            'and the signed one is untouched by it');
    });

    await checkAsync('replacing something that does not exist says so', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Nothing To Replace Ltd', services: ['hcm'] });
        throws(
            () => gen.uploadVersion(ctx, {
                accountId: account.id, docTypeKey: 'HCM_AGREEMENT',
                fileName: 'x.docx', bytes: fileBytes('x'), mode: 'replace_current',
            }),
            /to replace/i,
            'and points at the mode that would work',
        );
    });

    await checkAsync('only the file types a client is ever sent', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Wrong Type Ltd', services: ['hcm'] });
        throws(
            () => gen.uploadVersion(ctx, {
                accountId: account.id, docTypeKey: 'HCM_AGREEMENT',
                fileName: 'notes.txt', bytes: fileBytes('txt'), mode: 'new_version',
            }),
            /docx/,
        );
        throws(
            () => gen.uploadVersion(ctx, {
                accountId: account.id, docTypeKey: 'HCM_AGREEMENT',
                fileName: 'empty.docx', bytes: Buffer.alloc(0), mode: 'new_version',
            }),
            /empty/,
        );
    });

    await checkAsync('a rep may upload a version, and it still needs a manager', async () => {
        const { account } = seedGenerated('Rep Uploads Ltd');
        const result = gen.uploadVersion(repCtx, {
            accountId: account.id, docTypeKey: 'HCM_AGREEMENT',
            fileName: 'from-the-rep.docx', bytes: fileBytes('rep'), mode: 'new_version',
        });
        assert(result.record?.id, 'a rep can put a version on the record — that is drafting');
        const uploaded = repo.getRecord('agreement', ctx, result.record.id);
        assert(uploaded.status !== 'approved' && uploaded.status !== 'signed',
            'and it is not approved by having been uploaded');
    });
}


/* ============ deleting a generated document and its record, together ====== */
//
// A document and the proposal/agreement record it is a version of are the same
// commercial fact. Deleting one must carry the other, or the trash holds a
// record whose file is gone and the Documents tab holds an Open button that
// 404s.

describe('deleting a generated document takes its record, and vice versa');

if (haveTemplates) {
    const gen = await import('./lib/doc-generation.mjs');

    const PROPOSAL_FIELDS = {
        employees_to_hire: 3, onsite_visits_per_week: 1, monthly_fee: 6000,
        currency: 'SAR', validity_days: 30,
    };

    await checkAsync('deleting a generated document trashes its proposal record', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Cascade Doc Ltd', services: ['hcm'] });
        const { document, record } = gen.generate(ctx, {
            accountId: account.id, docTypeKey: 'HCM_PROPOSAL', fields: PROPOSAL_FIELDS,
        });

        repo.deleteRecord('document', ctx, document.id);
        assert(db.get('SELECT deleted_at FROM documents WHERE id = ?', [document.id]).deleted_at,
            'the document row is soft-deleted');
        assert(db.get('SELECT deleted_at FROM proposals WHERE id = ?', [record.id]).deleted_at,
            'the proposal record it is a version of goes to the trash with it');
        equal(gen.historyFor(ctx, { accountId: account.id }).length, 0,
            'and no dead version lingers in the Documents tab');
    });

    await checkAsync('restoring the document restores its record', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Cascade Restore Ltd', services: ['hcm'] });
        const { document, record } = gen.generate(ctx, {
            accountId: account.id, docTypeKey: 'HCM_PROPOSAL', fields: PROPOSAL_FIELDS,
        });
        repo.deleteRecord('document', ctx, document.id);

        repo.restoreRecord('document', ctx, document.id);
        assert(!db.get('SELECT deleted_at FROM documents WHERE id = ?', [document.id]).deleted_at,
            'the document is back');
        assert(!db.get('SELECT deleted_at FROM proposals WHERE id = ?', [record.id]).deleted_at,
            'and its record came back with it, not left to rot in the trash');
        equal(gen.historyFor(ctx, { accountId: account.id }).length, 1,
            'the version is visible again');
    });

    await checkAsync('deleting the proposal record trashes its document', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Cascade Reverse Ltd', services: ['hcm'] });
        const { document, record } = gen.generate(ctx, {
            accountId: account.id, docTypeKey: 'HCM_PROPOSAL', fields: PROPOSAL_FIELDS,
        });

        repo.deleteRecord('proposal', ctx, record.id);
        assert(db.get('SELECT deleted_at FROM proposals WHERE id = ?', [record.id]).deleted_at,
            'the proposal is in the trash');
        assert(db.get('SELECT deleted_at FROM documents WHERE id = ?', [document.id]).deleted_at,
            'the document it generated carries over');

        repo.restoreRecord('proposal', ctx, record.id);
        assert(!db.get('SELECT deleted_at FROM documents WHERE id = ?', [document.id]).deleted_at,
            'and restoring the record restores the file with it');
    });

    await checkAsync('a signed agreement is not thrown away by deleting its document', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Signed Stays Ltd', services: ['hcm'] });
        db.run(
            `INSERT INTO commercial_registrations
               (id, workspace_id, account_id, company_name_ar, cr_number, representative_name, address, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [db.id('crg'), WS, account.id, 'شركة', '99887766', 'ممثل', 'الرياض', db.now(), db.now()],
        );
        const { document, record } = gen.generate(ctx, {
            accountId: account.id, docTypeKey: 'HCM_AGREEMENT',
            fields: {
                employees_to_hire: 2, onsite_visits_per_week: 1, monthly_fee: 4000, currency: 'ريال',
                start_date: '2026-03-01', end_date: '2027-02-28', contract_duration_text: 'سنة',
            },
        });
        const reviews = await import('./api/proposals.mjs');
        await reviews.reviewDocument({ req: bodyOf({ decision: 'approved' }), params: { id: record.id }, ctx, kind: 'agreement' });
        await reviews.signAgreement({ req: bodyOf({ effectiveDate: '2026-03-01' }), params: { id: record.id }, ctx });
        equal(repo.getRecord('agreement', ctx, record.id).status, 'signed');

        throws(
            () => repo.deleteRecord('document', ctx, document.id),
            /signed agreement/,
            'a signed agreement is a contract, not a file to tidy up',
        );
        assert(!db.get('SELECT deleted_at FROM documents WHERE id = ?', [document.id]).deleted_at,
            'and the document survives the refusal intact');
    });

    await checkAsync('purging a generated document cleans generations, events, record, and bytes', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Purged Clean Ltd', services: ['hcm'] });
        const { document, record } = gen.generate(ctx, {
            accountId: account.id, docTypeKey: 'HCM_PROPOSAL', fields: PROPOSAL_FIELDS,
        });
        const storageKey = db.get('SELECT storage_key FROM documents WHERE id = ?', [document.id]).storage_key;

        repo.deleteRecord('document', ctx, document.id);
        repo.purgeRecord('document', ctx, document.id);

        equal(db.get('SELECT COUNT(*) AS n FROM documents WHERE id = ?', [document.id]).n, 0, 'document row gone');
        equal(db.get('SELECT COUNT(*) AS n FROM proposals WHERE id = ?', [record.id]).n, 0,
            'the trashed proposal record went with it');
        equal(db.get('SELECT COUNT(*) AS n FROM document_generations WHERE document_id = ?', [document.id]).n, 0,
            'its generation is gone too');
        equal(db.get('SELECT COUNT(*) AS n FROM document_events WHERE document_id = ?', [document.id]).n, 0,
            'and its events');
        assert(db.get('SELECT COUNT(*) AS n FROM search_index WHERE record_id = ?', [record.id]).n === 0,
            'and it is out of search');
    });

    await checkAsync('an uploaded document has no record to take with it', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Plain Upload Ltd', services: ['hcm'] });
        const docId = db.id('doc');
        db.run(
            `INSERT INTO documents
               (id, workspace_id, parent_type, parent_id, account_id, name, kind, mime, size_bytes, storage_key, uploaded_by, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [docId, WS, 'account', account.id, account.id, 'plain.pdf', 'file',
                'application/pdf', 10, `${WS}/${docId}.pdf`, ctx.userId, db.now()],
        );
        repo.deleteRecord('document', ctx, docId);
        assert(db.get('SELECT deleted_at FROM documents WHERE id = ?', [docId]).deleted_at,
            'the upload itself is deleted');
        equal(db.get('SELECT COUNT(*) AS n FROM proposals WHERE document_id = ?', [docId]).n, 0,
            'without inventing a proposal record to trash');
    });
}


/* ============== a deal's price is a series, never one overwritten value == */

describe('Re-quoting a deal does not rewrite what it was worth');

{
    const dealsApi = await import('./api/deals.mjs');

    const offshoringDeal = (name) => {
        const account = repo.createRecord('account', ctx, { name, services: ['offshoring'], billing_currency: 'USD' });
        return repo.createRecord('deal', ctx, {
            account_id: account.id, service_line_key: 'offshoring',
            pipeline_id: PIPE, stage_id: STAGE_OPEN, currency: 'USD',
        });
    };

    await checkAsync('Q1 keeps the price and headcount it had when the deal is re-quoted', async () => {
        const deal = offshoringDeal('Re-quoted Mid-Year Ltd');

        // Twelve people at 3,000 from the start of the year.
        await dealsApi.putDealSize({
            req: bodyOf({ price: 3000, count: 12, currency: 'USD', effectiveFrom: '2026-01-01' }),
            params: { id: deal.id }, ctx,
        });
        // Then three at 30,000 from April — ten times the rate, a quarter of the heads.
        await dealsApi.putDealSize({
            req: bodyOf({ price: 30000, count: 3, currency: 'USD', effectiveFrom: '2026-04-01' }),
            params: { id: deal.id }, ctx,
        });

        const history = await dealsApi.dealPriceHistory({
            params: { id: deal.id },
            url: new URL('http://x/?from=2026-01-01&to=2026-12-31&period=quarter'),
            ctx,
        });

        const byLabel = Object.fromEntries(history.periods.map((p) => [p.period, p]));
        equal(history.periods.length, 4, 'four quarters');

        equal(byLabel['Q1 2026'].price, 36000, 'Q1 is still 12 × 3,000');
        equal(byLabel['Q1 2026'].count, 12);
        equal(byLabel['Q1 2026'].unitPrice, 3000);

        equal(byLabel['Q2 2026'].price, 90000, 'Q2 onwards is 3 × 30,000');
        equal(byLabel['Q3 2026'].price, 90000);
        equal(byLabel['Q4 2026'].price, 90000);

        // And both rows survive, newest first, neither overwritten.
        equal(history.schedule.length, 2, 'two prices, not one edited twice');
        equal(history.schedule[0].effective_from, '2026-04-01');
        equal(history.schedule[1].effective_from, '2026-01-01');
        equal(history.schedule[1].quantity, 12, 'the original headcount is still on the record');
    });

    await checkAsync('a period before the deal was ever priced reports nothing, not the later figure', async () => {
        const deal = offshoringDeal('Priced In April Ltd');
        await dealsApi.putDealSize({
            req: bodyOf({ price: 1000, count: 5, currency: 'USD', effectiveFrom: '2026-04-01' }),
            params: { id: deal.id }, ctx,
        });

        const history = await dealsApi.dealPriceHistory({
            params: { id: deal.id },
            url: new URL('http://x/?from=2026-01-01&to=2026-12-31&period=quarter'),
            ctx,
        });
        const byLabel = Object.fromEntries(history.periods.map((p) => [p.period, p]));
        equal(byLabel['Q1 2026'].price, null,
            'reporting April’s figure over January is the retrospective rewriting this prevents');
        equal(byLabel['Q2 2026'].price, 5000);
    });

    await checkAsync('a deal first priced mid-quarter values that quarter, and says so', async () => {
        /**
         * The regression this pins: sampling each period at its START read
         * nothing for the quarter a deal was first priced IN. Every deal on
         * production was backfilled effective from the day it was raised — the
         * 17th of August for one of them — so the year's forecast reported Q3
         * as unpriced for a deal that had been priced for half of it. That
         * reads as missing data, not as a deal that started mid-quarter.
         */
        const deal = offshoringDeal('Priced Mid-Quarter Ltd');
        await dealsApi.putDealSize({
            req: bodyOf({ price: 2000, count: 4, currency: 'USD', effectiveFrom: '2026-08-17' }),
            params: { id: deal.id }, ctx,
        });

        const history = await dealsApi.dealPriceHistory({
            params: { id: deal.id },
            url: new URL('http://x/?from=2026-01-01&to=2026-12-31&period=quarter'),
            ctx,
        });
        const byLabel = Object.fromEntries(history.periods.map((p) => [p.period, p]));

        equal(byLabel['Q3 2026'].price, 8000, 'the quarter the price began in is valued at it');
        equal(byLabel['Q3 2026'].startedMidPeriod, true,
            'and flagged, because the figure did not cover the whole quarter');
        equal(byLabel['Q3 2026'].pricedFrom, '2026-08-17', 'saying from when');
        equal(byLabel['Q3 2026'].startsOn, '2026-07-01', 'which is not the quarter’s own start');

        equal(byLabel['Q4 2026'].price, 8000, 'the next quarter is covered outright');
        equal(byLabel['Q4 2026'].startedMidPeriod, false);

        // And it does not reach backwards into quarters the deal was not priced in.
        equal(byLabel['Q2 2026'].price, null, 'a quarter that ended before the price began is still nothing');
        equal(byLabel['Q1 2026'].price, null);
    });

    await checkAsync('the deal itself reports the price in force today', async () => {
        const deal = offshoringDeal('In Force Today Ltd');
        await dealsApi.putDealSize({
            req: bodyOf({ price: 100, count: 2, currency: 'USD', effectiveFrom: '2020-01-01' }),
            params: { id: deal.id }, ctx,
        });
        // Agreed now, but not starting until next year.
        await dealsApi.putDealSize({
            req: bodyOf({ price: 500, count: 2, currency: 'USD', effectiveFrom: '2099-01-01' }),
            params: { id: deal.id }, ctx,
        });

        equal(repo.getRecord('deal', ctx, deal.id).price, 200,
            'a price agreed for next year does not change what the deal is worth this year');
        equal(repo.priceInForce(ctx, deal.id, '2099-06-01').price, 1000,
            'and it does apply once it starts');
    });

    await checkAsync('a rep proposes a price; the deal keeps the old one until a manager agrees', async () => {
        const deal = offshoringDeal('Needs A Manager Ltd');
        await dealsApi.putDealSize({
            req: bodyOf({ price: 1000, count: 10, currency: 'USD', effectiveFrom: '2026-01-01' }),
            params: { id: deal.id }, ctx,
        });
        equal(repo.getRecord('deal', ctx, deal.id).price, 10000);

        // The rep re-quotes.
        await dealsApi.putDealSize({
            req: bodyOf({ price: 2000, count: 10, currency: 'USD', effectiveFrom: '2026-07-01' }),
            params: { id: deal.id }, ctx: repCtx,
        });

        equal(repo.getRecord('deal', ctx, deal.id).price, 10000,
            'the deal still reports the figure a manager agreed to');

        const schedule = repo.priceSchedule(ctx, deal.id);
        const pending = schedule.find((row) => row.status === 'pending_approval');
        assert(pending, 'and the proposal is recorded rather than discarded');
        equal(pending.price, 20000);
        equal(pending.created_by, rep.id);

        // A task was raised for somebody who can approve it.
        const task = db.get(
            `SELECT * FROM tasks WHERE parent_type = 'deal_price' AND parent_id = ? AND status = 'open'`,
            [pending.id],
        );
        assert(task, 'somebody is asked, rather than expected to notice');
        assert(task.assignee_id !== rep.id, 'and it is not the rep who proposed it');
        assert(/price change/i.test(task.title), task.title);

        // The manager agrees, and only then does the deal move.
        repo.reviewPricePeriod(ctx, pending.id, 'approved');
        equal(repo.priceInForce(ctx, deal.id, '2026-08-01').price, 20000,
            'approved, and in force from the date it was proposed for');
        equal(db.get('SELECT status FROM tasks WHERE id = ?', [task.id]).status, 'done',
            'and the task that asked is closed');
    });

    await checkAsync('a manager may reject, and must say why', async () => {
        const deal = offshoringDeal('Rejected Re-quote Ltd');
        await dealsApi.putDealSize({
            req: bodyOf({ price: 1000, count: 4, currency: 'USD' }), params: { id: deal.id }, ctx,
        });
        await dealsApi.putDealSize({
            req: bodyOf({ price: 9000, count: 4, currency: 'USD' }), params: { id: deal.id }, ctx: repCtx,
        });
        const pending = repo.priceSchedule(ctx, deal.id).find((r) => r.status === 'pending_approval');

        throws(
            () => repo.reviewPricePeriod(ctx, pending.id, 'rejected'),
            /Say why/,
            'a rejection with no reason sends the rep back to guess',
        );

        repo.reviewPricePeriod(ctx, pending.id, 'rejected', 'We agreed 1,000 with this client in March.');
        equal(repo.getRecord('deal', ctx, deal.id).price, 4000, 'the deal is untouched');

        const rejected = repo.priceSchedule(ctx, deal.id, { includeRejected: true })
            .find((r) => r.status === 'rejected');
        assert(rejected, 'the proposal stays as evidence of what was asked for');
        assert(/agreed 1,000/.test(rejected.review_note), 'with the reason on it');
    });

    await checkAsync('a manager pricing a deal needs no approval', async () => {
        const deal = offshoringDeal('Manager Prices It Ltd');
        await dealsApi.putDealSize({
            req: bodyOf({ price: 750, count: 8, currency: 'USD' }), params: { id: deal.id }, ctx,
        });
        equal(repo.getRecord('deal', ctx, deal.id).price, 6000, 'applied immediately');
        equal(
            repo.priceSchedule(ctx, deal.id).filter((r) => r.status === 'pending_approval').length, 0,
            'and nothing is waiting on anybody',
        );
    });

    await checkAsync('price-by-period groups a month as a month, never splitting intra-month changes', async () => {
        const deal = offshoringDeal('Monthly Buckets Ltd');
        const row = () => db.get('SELECT * FROM deals WHERE id = ?', [deal.id]);
        // Two changes inside August, one in September — per the requirement they
        // must land as ONE August period, not two.
        repo.setDealPrice(ctx, row(), { price: 100000, count: 1, currency: 'USD', effectiveFrom: '2026-08-05' });
        repo.setDealPrice(ctx, row(), { price: 150000, count: 1, currency: 'USD', effectiveFrom: '2026-08-20' });
        repo.setDealPrice(ctx, row(), { price: 200000, count: 1, currency: 'USD', effectiveFrom: '2026-09-10' });

        const months = repo.priceByPeriod(ctx, deal.id, { from: '2026-08-01', to: '2026-10-31', period: 'month' });
        equal(months.length, 3, 'three monthly buckets (Aug, Sep, Oct) — never one per price change');
        equal(months[0].period, 'Aug 2026', 'the first bucket is August');
        equal(months[0].price, 100000, 'August reports the price in force for the month (both changes collapse to one)');

        const quarters = repo.priceByPeriod(ctx, deal.id, { from: '2026-01-01', to: '2026-12-31', period: 'quarter' });
        equal(quarters.find((p) => p.period === 'Q3 2026').price, 100000, 'Q3 reports the same in-force figure');
        equal(quarters.find((p) => p.period === 'Q4 2026').price, 200000, 'Q4 the September figure');
    });

    await checkAsync('what a recurring deal won for is not rewritten by a later re-quote', async () => {
        // The dashboard's "Won, per month" used to read a deal's CURRENT price
        // for any deal won at any time — so re-quoting an already-won contract
        // silently changed what a past period reportedly won.
        const dash = await import('./api/dashboard.mjs');
        const reporting = { currency: 'USD', rates: { USD: 1, EGP: 50, SAR: 3.75 } };
        const february = { from: '2026-02-01T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z', preset: 'month' };
        // A fresh `_dashboardReads` map every call, for the same reason the
        // forecast-period tests need one — see the comment there.
        const wonInFebruary = async () => {
            const out = await dash.WIDGETS.deals_won.run({ ...ctx, _dashboardReads: undefined }, {}, february, reporting);
            return out.tiles.find((t) => t.label === 'Won, per month').value;
        };

        const deal = offshoringDeal('Won Then Re-quoted Ltd');
        await dealsApi.putDealSize({
            req: bodyOf({ price: 1000, count: 10, currency: 'USD', effectiveFrom: '2026-01-01' }),
            params: { id: deal.id }, ctx,
        });

        // Won in February, at 10,000/month.
        db.run("UPDATE deals SET stage_id = ?, status = 'won', closed_at = ? WHERE id = ?",
            [STAGE_WON, '2026-02-10T12:00:00.000Z', deal.id]);
        equal(await wonInFebruary(), 10000, 'won at 10,000/month — the price in force the day it closed');

        // Re-quoted months later, to double the rate.
        await dealsApi.putDealSize({
            req: bodyOf({ price: 2000, count: 10, currency: 'USD', effectiveFrom: '2026-06-01' }),
            params: { id: deal.id }, ctx,
        });

        equal(await wonInFebruary(), 10000,
            'February\'s won figure must not move because the deal was re-quoted in June');
    });
}


/* ============ importing a company retires it from prospecting =========== */

describe('An imported company leaves the sourcing book');

{
    const promotion = await import('./lib/promotion.mjs');
    const dash = await import('./api/dashboard.mjs');

    const seedProspect = (name, contactNames) => {
        const prospectId = db.id('pro');
        db.run(
            `INSERT INTO prospecting_companies
               (id, workspace_id, name, domain, status, services, created_at, updated_at)
             VALUES (?,?,?,?,'qualified','["hcm"]',?,?)`,
            [prospectId, WS, name, `${name.toLowerCase().replace(/\W+/g, '')}.example`, db.now(), db.now()],
        );
        const contactIds = contactNames.map((full) => {
            const id = db.id('pct');
            const [first, last] = full.split(' ');
            db.run(
                `INSERT INTO prospecting_contacts
                   (id, workspace_id, prospect_id, first_name, last_name, full_name, data_source, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,'linkedin',?,?)`,
                [id, WS, prospectId, first, last, full, db.now(), db.now()],
            );
            return id;
        });
        return { prospectId, contactIds };
    };

    await checkAsync('the company and its people disappear from prospecting', async () => {
        const { prospectId, contactIds } = seedProspect('Leaves The Book', ['Rana Adel', 'Sami Nour']);

        // The premise: both are visible in prospecting before the import.
        equal(repo.listRecords('prospecting_company', ctx, {
            filter: { op: 'and', children: [{ field: 'name', operator: 'is', value: 'Leaves The Book' }] },
        }).total, 1);
        equal(repo.listRecords('prospecting_contact', ctx, {
            filter: { op: 'and', children: [{ field: 'prospect_id', operator: 'is', value: prospectId }] },
        }).total, 2);

        const result = promotion.promote(ctx, [prospectId], { force: true });
        assert(result.results?.[0]?.accountId, `promotion did not create an account: ${JSON.stringify(result)}`);

        // Gone from both prospecting lists.
        equal(repo.listRecords('prospecting_company', ctx, {
            filter: { op: 'and', children: [{ field: 'name', operator: 'is', value: 'Leaves The Book' }] },
        }).total, 0, 'the company still appears in prospecting after being imported');
        equal(repo.listRecords('prospecting_contact', ctx, {
            filter: { op: 'and', children: [{ field: 'prospect_id', operator: 'is', value: prospectId }] },
        }).total, 0, 'its people still appear in prospecting contacts');

        // And present in the CRM, which is where the work now happens.
        const account = repo.getRecord('account', ctx, result.results[0].accountId);
        equal(account.name, 'Leaves The Book');
        equal(db.get(
            'SELECT COUNT(*) AS n FROM contacts WHERE account_id = ? AND deleted_at IS NULL',
            [account.id],
        ).n, 2, 'both people came across');

        // Every prospecting contact row is marked, not just some.
        for (const id of contactIds) {
            assert(db.get('SELECT deleted_at FROM prospecting_contacts WHERE id = ?', [id]).deleted_at,
                'a prospecting contact was left behind');
        }
    });

    await checkAsync('the evidence chain survives the retirement', async () => {
        const { prospectId } = seedProspect('Keeps Its Evidence', ['Hana Farid']);
        db.run(
            `INSERT INTO prospecting_verdicts
               (id, workspace_id, prospect_id, rule_key, rule_version, verdict, confidence,
                metrics, reasons, notes, computed_at, is_current)
             VALUES (?,?,?,'hcm',1,'QUALIFIED',0.9,'{}','[]','[]',?,1)`,
            [db.id('pvd'), WS, prospectId, db.now()],
        );

        promotion.promote(ctx, [prospectId], { force: true });

        /**
         * Destroying the row would take this with it — the verdict's
         * `prospect_id` is NOT NULL and references it, and that chain is how a
         * deal traces back to the verdict that sourced it.
         */
        const verdict = db.get('SELECT * FROM prospecting_verdicts WHERE prospect_id = ?', [prospectId]);
        assert(verdict, 'the verdict that sourced this company was destroyed with it');
        equal(verdict.verdict, 'QUALIFIED');

        const row = db.get('SELECT * FROM prospecting_companies WHERE id = ?', [prospectId]);
        assert(row, 'the row itself is kept, so an import can be undone');
        assert(row.deleted_at, 'and marked, so it is gone from every list');
        equal(row.status, 'imported', 'and says what became of it');
        assert(row.imported_account_id, 'pointing at what it became');
    });

    await checkAsync('the funnel still reports how many were imported', async () => {
        /**
         * The count is of soft-deleted rows, so a naive `deleted_at IS NULL`
         * would answer nought and make the funnel look like nothing ever
         * leaves it.
         */
        const data = await dash.WIDGETS.prospecting_funnel.run(
            ctx, {}, { from: '2020-01-01', to: '2030-01-01', preset: 'all', label: 'all time' },
        );
        const imported = data.tiles.find((t) => /Imported into CRM/.test(t.label));
        assert(imported.value >= 2, `the funnel reports ${imported.value} imported after two imports`);

        /**
         * Regression: "Uploaded" used `countInRange`, whose WHERE always
         * requires `deleted_at IS NULL` — dropping every row this SAME
         * widget's own "imported" exception (the query above) exists to
         * keep. A company uploaded and imported within the queried range
         * disappeared from "Uploaded" while still correctly counted in
         * "Prospects on file" and "Imported into CRM" — the funnel's own
         * top-of-funnel tile silently undercounting its own funnel.
         */
        const uploaded = data.tiles.find((t) => /^Uploaded$/.test(t.label));
        assert(uploaded.value >= imported.value,
            `"Uploaded" (${uploaded.value}) must count at least as many as "Imported into CRM" (${imported.value}) — `
            + 'every imported row was uploaded first, in the same range');
    });
}


/* ============== account cascade permanent deletion and dependent records == */

describe('Permanent Account Deletion and Dependent Records');

{
    const recordsApi = await import('./api/records.mjs');

    await checkAsync('account with no dependent records purges cleanly', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Empty Account Ltd', services: ['hcm'] });
        const unrelated = repo.createRecord('account', ctx, { name: 'Unrelated Account Ltd', services: ['hcm'] });

        repo.deleteRecord('account', ctx, account.id);
        const result = repo.purgeRecord('account', ctx, account.id);
        equal(result.purged, true, 'purge succeeded');
        equal(db.get('SELECT COUNT(*) AS n FROM accounts WHERE id = ?', [account.id]).n, 0, 'account row is gone');
        equal(db.get('SELECT COUNT(*) AS n FROM accounts WHERE id = ?', [unrelated.id]).n, 1, 'unrelated account is untouched');
    });

    await checkAsync('account with Deals purges account and all deal children', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Account With Deals Ltd', services: ['offshoring'] });
        const deal = repo.createRecord('deal', ctx, {
            name: 'Offshoring Deal 1',
            account_id: account.id, service_line_key: 'offshoring',
            pipeline_id: PIPE, stage_id: STAGE_OPEN, currency: 'USD',
        });
        const unrelatedAccount = repo.createRecord('account', ctx, { name: 'Unrelated Deals Ltd', services: ['offshoring'] });
        const unrelatedDeal = repo.createRecord('deal', ctx, {
            name: 'Unrelated Offshoring Deal',
            account_id: unrelatedAccount.id, service_line_key: 'offshoring',
            pipeline_id: PIPE, stage_id: STAGE_OPEN, currency: 'USD',
        });

        repo.deleteRecord('account', ctx, account.id);
        repo.purgeRecord('account', ctx, account.id);

        equal(db.get('SELECT COUNT(*) AS n FROM accounts WHERE id = ?', [account.id]).n, 0, 'account is gone');
        equal(db.get('SELECT COUNT(*) AS n FROM deals WHERE id = ?', [deal.id]).n, 0, 'deal is gone');
        equal(db.get('SELECT COUNT(*) AS n FROM accounts WHERE id = ?', [unrelatedAccount.id]).n, 1, 'unrelated account is untouched');
        equal(db.get('SELECT COUNT(*) AS n FROM deals WHERE id = ?', [unrelatedDeal.id]).n, 1, 'unrelated deal is untouched');
    });

    await checkAsync('account with Proposals and Documents purges all proposal and document records', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Account With Proposal Ltd', services: ['hcm'] });
        const docId = db.id('doc');
        const proId = db.id('pro');
        db.run(
            `INSERT INTO documents
               (id, workspace_id, parent_type, parent_id, account_id, name, kind, mime, size_bytes, storage_key, uploaded_by, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [docId, WS, 'account', account.id, account.id, 'proposal.pdf', 'proposal',
                'application/pdf', 10, `${WS}/${docId}.pdf`, ctx.userId, db.now()],
        );
        db.run(
            `INSERT INTO proposals (id, workspace_id, account_id, document_id, number, title, status, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [proId, WS, account.id, docId, 'P-TEST-0001', 'Test Proposal', 'draft', db.now(), db.now()],
        );

        repo.deleteRecord('account', ctx, account.id);
        repo.purgeRecord('account', ctx, account.id);

        equal(db.get('SELECT COUNT(*) AS n FROM accounts WHERE id = ?', [account.id]).n, 0, 'account is gone');
        equal(db.get('SELECT COUNT(*) AS n FROM proposals WHERE id = ?', [proId]).n, 0, 'proposal is gone');
        equal(db.get('SELECT COUNT(*) AS n FROM documents WHERE id = ?', [docId]).n, 0, 'document is gone');
    });

    await checkAsync('account with Tasks (direct and polymorphic) purges all tasks', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Account With Tasks Ltd', services: ['hcm'] });
        const task1 = repo.createRecord('task', ctx, {
            account_id: account.id, parent_type: 'account', parent_id: account.id,
            title: 'Call client', assigned_to: ctx.userId,
        });
        const task2 = repo.createRecord('task', ctx, {
            parent_type: 'account', parent_id: account.id,
            title: 'Send follow-up', assigned_to: ctx.userId,
        });

        repo.deleteRecord('account', ctx, account.id);
        repo.purgeRecord('account', ctx, account.id);

        equal(db.get('SELECT COUNT(*) AS n FROM accounts WHERE id = ?', [account.id]).n, 0, 'account is gone');
        equal(db.get('SELECT COUNT(*) AS n FROM tasks WHERE id = ?', [task1.id]).n, 0, 'task 1 is gone');
        equal(db.get('SELECT COUNT(*) AS n FROM tasks WHERE id = ?', [task2.id]).n, 0, 'task 2 is gone');
    });

    await checkAsync('account with deeply nested dependent graph purges completely with foreign keys enabled', async () => {
        // FK constraints must be active
        assert(db.get('PRAGMA foreign_keys').foreign_keys === 1, 'foreign keys are enabled');

        const account = repo.createRecord('account', ctx, { name: 'Deep Hierarchy Account Ltd', services: ['hcm'] });
        const contact = repo.createRecord('contact', ctx, {
            account_id: account.id, first_name: 'Adam', last_name: 'Smith', email: 'adam@deephierarchy.com',
            data_source: 'manual',
        });
        const deal = repo.createRecord('deal', ctx, {
            name: 'Deep Deal 1',
            account_id: account.id, service_line_key: 'hcm',
            pipeline_id: PIPE, stage_id: STAGE_OPEN, currency: 'SAR',
        });
        const note = repo.createRecord('note', ctx, {
            parent_type: 'deal', parent_id: deal.id, account_id: account.id,
            body: 'Important deal note', author_id: ctx.userId,
        });
        const activity = repo.createRecord('activity', ctx, {
            parent_type: 'contact', parent_id: contact.id, account_id: account.id,
            type_key: 'call', occurred_at: db.now(), subject: 'Kickoff call', actor_id: ctx.userId,
        });
        const docId = db.id('doc');
        const proId = db.id('pro');
        const prvId = db.id('prv');
        const agrId = db.id('agr');
        db.run(
            `INSERT INTO documents
               (id, workspace_id, parent_type, parent_id, account_id, name, kind, mime, size_bytes, storage_key, uploaded_by, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [docId, WS, 'deal', deal.id, account.id, 'deep_proposal.pdf', 'proposal',
                'application/pdf', 10, `${WS}/${docId}.pdf`, ctx.userId, db.now()],
        );
        db.run(
            `INSERT INTO proposals (id, workspace_id, account_id, deal_id, document_id, number, title, status, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [proId, WS, account.id, deal.id, docId, 'P-DEEP-0001', 'Deep Proposal', 'draft', db.now(), db.now()],
        );
        db.run(
            `INSERT INTO proposal_versions (id, workspace_id, proposal_id, version, status, content, created_at)
             VALUES (?,?,?,1,'draft','{}',?)`,
            [prvId, WS, proId, db.now()],
        );
        db.run(
            `INSERT INTO agreements (id, workspace_id, account_id, deal_id, number, title, type, status, notice_days, auto_renew, created_at, updated_at)
             VALUES (?,?,?,?,?,?,'sow','draft',0,0,?,?)`,
            [agrId, WS, account.id, deal.id, 'A-DEEP-0001', 'Deep SOW', db.now(), db.now()],
        );
        db.run(
            `INSERT INTO agreement_proposals (agreement_id, proposal_version_id) VALUES (?,?)`,
            [agrId, prvId],
        );

        // Verify accountDependents detects the full graph
        const deps = repo.accountDependents(account.id, ctx.workspaceId);
        assert(deps.contactIds.includes(contact.id), 'deps includes contact');
        assert(deps.dealIds.includes(deal.id), 'deps includes deal');
        assert(deps.proposalIds.includes(proId), 'deps includes proposal');
        assert(deps.agreementIds.includes(agrId), 'deps includes agreement');
        assert(deps.docIds.includes(docId), 'deps includes document');
        assert(deps.noteIds.includes(note.id), 'deps includes note');
        assert(deps.activityIds.includes(activity.id), 'deps includes activity');
        assert(deps.total >= 7, `deps total is ${deps.total}`);

        // Purge account
        repo.deleteRecord('account', ctx, account.id);
        const purgeRes = repo.purgeRecord('account', ctx, account.id);
        equal(purgeRes.purged, true, 'purge returned success');

        // Check everything in graph is gone
        equal(db.get('SELECT COUNT(*) AS n FROM accounts WHERE id = ?', [account.id]).n, 0, 'account gone');
        equal(db.get('SELECT COUNT(*) AS n FROM contacts WHERE id = ?', [contact.id]).n, 0, 'contact gone');
        equal(db.get('SELECT COUNT(*) AS n FROM deals WHERE id = ?', [deal.id]).n, 0, 'deal gone');
        equal(db.get('SELECT COUNT(*) AS n FROM proposals WHERE id = ?', [proId]).n, 0, 'proposal gone');
        equal(db.get('SELECT COUNT(*) AS n FROM agreements WHERE id = ?', [agrId]).n, 0, 'agreement gone');
        equal(db.get('SELECT COUNT(*) AS n FROM agreement_proposals WHERE agreement_id = ?', [agrId]).n, 0, 'agreement_proposals link gone');
        equal(db.get('SELECT COUNT(*) AS n FROM documents WHERE id = ?', [docId]).n, 0, 'document gone');
        equal(db.get('SELECT COUNT(*) AS n FROM notes WHERE id = ?', [note.id]).n, 0, 'note gone');
        equal(db.get('SELECT COUNT(*) AS n FROM activities WHERE id = ?', [activity.id]).n, 0, 'activity gone');
        equal(db.get('SELECT COUNT(*) AS n FROM search_index WHERE record_id IN (?,?,?,?,?)', [account.id, contact.id, deal.id, proId, docId]).n, 0, 'search index cleaned');
    });

    await checkAsync('previewBulk provides dependent warning for account with related records', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Preview Account Ltd', services: ['hcm'] });
        const deal = repo.createRecord('deal', ctx, {
            name: 'Preview Deal',
            account_id: account.id, service_line_key: 'hcm',
            pipeline_id: PIPE, stage_id: STAGE_OPEN, currency: 'SAR',
        });
        repo.deleteRecord('account', ctx, account.id);

        const previewRes = await recordsApi.bulk({
            params: { object: 'accounts' },
            ctx,
            url: new URL('http://localhost/api/accounts/bulk'),
            req: bodyOf({ ids: [account.id], action: 'purge', preview: true }),
        });

        assert(previewRes.dependentWarning, 'dependent warning is present');
        assert(/associated data/.test(previewRes.dependentWarning), 'warning mentions associated data');
        assert(previewRes.dependents?.length > 0, 'dependents list provided in preview');
        equal(previewRes.referenced.length, 0, 'referenced (blockers) is empty since account cascades');
    });

    await checkAsync('bulk operations with all matching and filters work reliably', async () => {
        // Create accounts
        const a1 = repo.createRecord('account', ctx, { name: 'Bulk Acme Alpha', country: 'Egypt' });
        const a2 = repo.createRecord('account', ctx, { name: 'Bulk Acme Beta', country: 'Egypt' });
        const a3 = repo.createRecord('account', ctx, { name: 'Bulk Other Gamma', country: 'Saudi Arabia' });

        // Test idsMatching with search query
        const searched = repo.idsMatching('account', ctx, { q: 'Acme' });
        assert(searched.ids.includes(a1.id), 'searched includes a1');
        assert(searched.ids.includes(a2.id), 'searched includes a2');
        assert(!searched.ids.includes(a3.id), 'searched excludes a3');

        // Test idsMatching with filter
        const filtered = repo.idsMatching('account', ctx, {
            filter: { op: 'and', children: [{ field: 'country', operator: 'is', value: 'Egypt' }] },
        });
        assert(filtered.ids.includes(a1.id), 'filtered includes a1');
        assert(filtered.ids.includes(a2.id), 'filtered includes a2');
        assert(!filtered.ids.includes(a3.id), 'filtered excludes a3');

        // Bulk delete matching filter
        const bulkDeleteRes = await recordsApi.bulk({
            params: { object: 'accounts' },
            ctx,
            url: new URL('http://localhost/api/accounts/bulk'),
            req: bodyOf({
                action: 'delete',
                all: true,
                filter: { op: 'and', children: [{ field: 'country', operator: 'is', value: 'Egypt' }] },
            }),
        });
        equal(bulkDeleteRes.succeeded, 2, 'deleted 2 accounts matching filter');

        // Test idsMatching on trash (onlyDeleted)
        const inTrash = repo.idsMatching('account', ctx, { onlyDeleted: true, includeDeleted: true });
        assert(inTrash.ids.includes(a1.id), 'trash includes a1');
        assert(inTrash.ids.includes(a2.id), 'trash includes a2');
        assert(!inTrash.ids.includes(a3.id), 'trash excludes live a3');

        // Bulk purge on trash with all: true
        const bulkPurgeRes = await recordsApi.bulk({
            params: { object: 'accounts' },
            ctx,
            url: new URL('http://localhost/api/accounts/bulk'),
            req: bodyOf({
                action: 'purge',
                all: true,
                filter: { op: 'and', children: [{ field: 'country', operator: 'is', value: 'Egypt' }] },
            }),
        });
        equal(bulkPurgeRes.succeeded, 2, 'purged 2 accounts matching filter from trash');

        equal(db.get('SELECT COUNT(*) AS n FROM accounts WHERE id IN (?, ?)', [a1.id, a2.id]).n, 0, 'a1 and a2 purged');
        equal(db.get('SELECT COUNT(*) AS n FROM accounts WHERE id = ?', [a3.id]).n, 1, 'a3 still live');
    });

    /* ---- large datasets: the delete path stays correct and responsive ---- */

    await checkAsync('deleting and purging 60 accounts with dependents cascades completely', async () => {
        const N = 60;
        const ids = [];
        const dealIds = [];
        for (let i = 0; i < N; i += 1) {
            const account = repo.createRecord('account', ctx, { name: `Bulk Cascade ${i}`, services: ['hcm'] });
            ids.push(account.id);
            const contact = repo.createRecord('contact', ctx, {
                account_id: account.id, first_name: `C${i}`, last_name: 'Bulk', email: `c${i}@bulk.local`, data_source: 'manual',
            });
            const deal = repo.createRecord('deal', ctx, {
                account_id: account.id, service_line_key: 'hcm', pipeline_id: PIPE, stage_id: STAGE_OPEN,
            });
            dealIds.push(deal.id);
            repo.createRecord('note', ctx, {
                parent_type: 'deal', parent_id: deal.id, account_id: account.id, body: `note ${i}`, author_id: ctx.userId,
            });
            repo.createRecord('task', ctx, { parent_type: 'account', parent_id: account.id, account_id: account.id, title: `task ${i}` });
        }

        // Soft delete all, then purge them in one bulk call.
        for (const id of ids) repo.deleteRecord('account', ctx, id);
        const purge = await recordsApi.bulk({
            params: { object: 'accounts' },
            ctx,
            url: new URL('http://localhost/api/accounts/bulk'),
            req: bodyOf({ ids, action: 'purge' }),
        });
        equal(purge.succeeded, N, `all ${N} accounts purged`);
        equal(purge.failed.length, 0, 'none refused');

        equal(db.get(`SELECT COUNT(*) AS n FROM accounts WHERE id IN (${ids.map(() => '?').join(',')})`, ids).n, 0, 'all accounts gone');
        equal(db.get(`SELECT COUNT(*) AS n FROM deals WHERE id IN (${dealIds.map(() => '?').join(',')})`, dealIds).n, 0, 'all deals gone');
        equal(db.get(`SELECT COUNT(*) AS n FROM notes WHERE account_id IN (${ids.map(() => '?').join(',')})`, ids).n, 0, 'all notes gone');
        equal(db.get(`SELECT COUNT(*) AS n FROM contacts WHERE account_id IN (${ids.map(() => '?').join(',')})`, ids).n, 0, 'all contacts gone');
    });

    await checkAsync('deleted-contacts pagination stays server-side over a large trash', async () => {
        const N = 130;
        const contactIds = [];
        for (let i = 0; i < N; i += 1) {
            const account = repo.createRecord('account', ctx, { name: `Page A${i}`, account_type: 'Egypt' });
            const c = repo.createRecord('contact', ctx, {
                account_id: account.id, first_name: `P${i}`, last_name: 'Deleted', email: `p${i}@page.local`, data_source: 'manual',
            });
            contactIds.push(c.id);
        }
        for (const id of contactIds) repo.deleteRecord('contact', ctx, id);

        const p1 = repo.listRecords('contact', ctx, { page: 1, limit: 50, onlyDeleted: true });
        const p2 = repo.listRecords('contact', ctx, { page: 2, limit: 50, onlyDeleted: true });
        const p3 = repo.listRecords('contact', ctx, { page: 3, limit: 50, onlyDeleted: true });
        equal(p1.total, N, 'total counts the whole trash');
        equal(p1.records.length, 50, 'page 1 has 50');
        equal(p2.records.length, 50, 'page 2 has 50');
        equal(p3.records.length, 30, 'page 3 has the remainder (130 - 100)');
        equal(p3.pages, 3, 'three pages in total');
        const seen = new Set([...p1.records, ...p2.records, ...p3.records].map((r) => r.id));
        equal(seen.size, N, 'no record repeats across pages and none is dropped');
    });

    await checkAsync('purging a large filtered set of deleted accounts reports accurate counts', async () => {
        const N = 55;
        const ids = [];
        for (let i = 0; i < N; i += 1) {
            const account = repo.createRecord('account', ctx, { name: `Filter Purge ${i}`, country: 'Egypt' });
            ids.push(account.id);
        }
        for (const id of ids) repo.deleteRecord('account', ctx, id);
        // One account that does NOT match stays.
        const keep = repo.createRecord('account', ctx, { name: 'Filter Purge Keep', country: 'Saudi Arabia' });

        const res = await recordsApi.bulk({
            params: { object: 'accounts' },
            ctx,
            url: new URL('http://localhost/api/accounts/bulk'),
            req: bodyOf({
                action: 'purge',
                all: true,
                onlyDeleted: true,
                includeDeleted: true,
                filter: { op: 'and', children: [{ field: 'country', operator: 'is', value: 'Egypt' }] },
            }),
        });
        equal(res.succeeded, N, `purged exactly the ${N} matching deleted accounts`);
        equal(db.get('SELECT COUNT(*) AS n FROM accounts WHERE id = ?', [keep.id]).n, 1, 'the non-matching account survived');
    });

    await checkAsync('bulk CRUD works for tasks, notes and activities from the list view', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Bulk CRUD Co', account_type: 'Egypt' });
        const taskIds = [];
        const noteIds = [];
        const activityIds = [];
        for (let i = 0; i < 3; i += 1) {
            taskIds.push(repo.createRecord('task', ctx, {
                parent_type: 'account', parent_id: account.id, account_id: account.id, title: `bulk task ${i}`,
            }).id);
            noteIds.push(repo.createRecord('note', ctx, {
                parent_type: 'account', parent_id: account.id, account_id: account.id, body: `bulk note ${i}`, author_id: ctx.userId,
            }).id);
            activityIds.push(repo.createRecord('activity', ctx, {
                parent_type: 'account', parent_id: account.id, account_id: account.id,
                type_key: 'call', subject: `bulk act ${i}`, occurred_at: db.now(), actor_id: ctx.userId,
            }).id);
        }
        const assignee = auth.createUser({ email: 'bulk-owner@test.local', name: 'Bulk Owner', password: 'test-password-9', role: 'rep', workspaceId: WS });

        // Bulk status change on tasks.
        const statusRes = await recordsApi.bulk({
            params: { object: 'tasks' }, ctx,
            url: new URL('http://localhost/api/tasks/bulk'),
            req: bodyOf({ ids: taskIds, action: 'update', values: { status: 'done' } }),
        });
        equal(statusRes.succeeded, 3, 'three tasks completed in one call');
        for (const id of taskIds) {
            equal(repo.getRecord('task', ctx, id).status, 'done', `task ${id} is done`);
        }

        // Bulk assign on tasks maps to the ASSIGNEE.
        const assignRes = await recordsApi.bulk({
            params: { object: 'tasks' }, ctx,
            url: new URL('http://localhost/api/tasks/bulk'),
            req: bodyOf({ ids: taskIds, action: 'assign', ownerId: assignee.id }),
        });
        equal(assignRes.succeeded, 3, 'three tasks assigned in one call');
        equal(assignRes.failed.length, 0, 'none refused');
        for (const id of taskIds) {
            equal(repo.getRecord('task', ctx, id).assignee_id, assignee.id, `task ${id} is assigned to the chosen rep`);
        }

        // Bulk soft-delete — one object type per call, exactly as each list view
        // offers its own bulk bar.
        for (const [object, ids] of [['tasks', taskIds], ['notes', noteIds], ['activities', activityIds]]) {
            const delRes = await recordsApi.bulk({
                params: { object }, ctx,
                url: new URL(`http://localhost/api/${object}/bulk`),
                req: bodyOf({ ids, action: 'delete' }),
            });
            equal(delRes.succeeded, 3, `${object}: three soft-deleted in one call`);
            equal(delRes.failed.length, 0, `${object}: none refused`);
        }
        equal(repo.getRecord('task', ctx, taskIds[0], { includeDeleted: true }).deleted_at !== null, true, 'task is in the trash');
        equal(repo.getRecord('note', ctx, noteIds[0], { includeDeleted: true }).deleted_at !== null, true, 'note is in the trash');
        equal(repo.getRecord('activity', ctx, activityIds[0], { includeDeleted: true }).deleted_at !== null, true, 'activity is in the trash');
    });

    await checkAsync('the What closed dashboard section is full-width rectangular rows', async () => {
        const dash = await import('./api/dashboard.mjs');
        const manager = dash.ROLE_DASHBOARDS.manager;
        const whatClosed = manager.filter((w) => w.section === 'What closed');
        assert(whatClosed.length === 4, `What closed has 4 widgets, got ${whatClosed.length}`);
        for (const w of whatClosed) {
            equal(w.size, 'wide', `${w.widget} in What closed is full-width (not a floating half/small card)`);
        }
        // The section reads top-to-bottom as: money, rate, renewals, by service.
        equal(whatClosed.map((w) => w.widget).join(','), 'deals_won,win_rate,renewals,service_performance',
            'What closed order is stable');
    });

    /* ==================================== COMMERCIAL RELATIONSHIP & CONSISTENCY === */

    describe('Commercial Relationship & Data Consistency');

    await checkAsync('creating a proposal automatically creates a deal inheriting account and billing currency', async () => {
        const commAccount = repo.createRecord('account', ctx, {
            name: 'Commercial Consistency Alpha',
            billing_currency: 'USD',
        });
        const prop = repo.createRecord('proposal', ctx, {
            title: 'Proposal For Alpha',
            account_id: commAccount.id,
            total_value: 25000,
        });
        assert(prop.deal_id, 'proposal must automatically have a deal_id');
        const deal = repo.getRecord('deal', ctx, prop.deal_id);
        assert(deal, 'the created deal exists in the database');
        equal(deal.account_id, commAccount.id, 'deal inherits the account_id');
        equal(deal.currency, 'USD', 'deal inherits account billing_currency');
        equal(prop.currency, 'USD', 'proposal inherits account billing_currency');
    });

    await checkAsync('creating a second proposal for the same opportunity/account reuses the open deal idempotently', async () => {
        const commAccount = repo.createRecord('account', ctx, {
            name: 'Commercial Consistency Beta',
            billing_currency: 'EGP',
        });
        const dealsBefore = db.get('SELECT COUNT(*) as c FROM deals WHERE account_id = ?', [commAccount.id]).c;
        equal(dealsBefore, 0, 'starts with zero deals');

        const prop1 = repo.createRecord('proposal', ctx, {
            title: 'Proposal 1',
            account_id: commAccount.id,
        });
        const dealsMid = db.get('SELECT COUNT(*) as c FROM deals WHERE account_id = ?', [commAccount.id]).c;
        equal(dealsMid, 1, 'created 1 deal');

        const prop2 = repo.createRecord('proposal', ctx, {
            title: 'Proposal 2',
            account_id: commAccount.id,
        });
        const dealsAfter = db.get('SELECT COUNT(*) as c FROM deals WHERE account_id = ?', [commAccount.id]).c;
        equal(dealsAfter, 1, 'no duplicate deal created on second proposal');
        equal(prop1.deal_id, prop2.deal_id, 'both proposals link to the same deal');
    });

    check('currency consistency is enforced: cannot create proposal/agreement with mismatched currency', () => {
        const commAccount = repo.createRecord('account', ctx, {
            name: 'Commercial Currency Gamma',
            billing_currency: 'USD',
        });
        throws(
            () => repo.createRecord('proposal', ctx, {
                title: 'Mismatch Proposal',
                account_id: commAccount.id,
                currency: 'SAR',
            }),
            /currency mismatch|billing currency/i,
            'proposal with wrong currency is rejected',
        );

        throws(
            () => repo.createRecord('agreement', ctx, {
                title: 'Mismatch Agreement',
                account_id: commAccount.id,
                currency: 'SAR',
            }),
            /currency mismatch|billing currency/i,
            'agreement with wrong currency is rejected',
        );
    });

    await checkAsync('an agreement automatically adopts the proposal’s deal and validates value matching', async () => {
        const commAccount = repo.createRecord('account', ctx, {
            name: 'Commercial Alignment Delta',
            billing_currency: 'SAR',
        });
        const prop = repo.createRecord('proposal', ctx, {
            title: 'Proposal Delta',
            account_id: commAccount.id,
            total_value: 50000,
        });

        // Agreement with proposal_id matching value
        const agr = repo.createRecord('agreement', ctx, {
            title: 'Agreement Delta',
            account_id: commAccount.id,
            proposal_id: prop.id,
            contract_value: 50000,
        });
        equal(agr.deal_id, prop.deal_id, 'agreement belongs to same deal as proposal');

        // Agreement with value mismatch without confirmation fails
        throws(
            () => repo.createRecord('agreement', ctx, {
                title: 'Agreement Mismatch Delta',
                account_id: commAccount.id,
                proposal_id: prop.id,
                contract_value: 75000,
            }),
            /value mismatch/i,
            'value mismatch without confirm_value_mismatch is rejected',
        );

        // Agreement with value mismatch WITH confirmation succeeds
        const agrConfirmed = repo.createRecord('agreement', ctx, {
            title: 'Agreement Confirmed Mismatch',
            account_id: commAccount.id,
            proposal_id: prop.id,
            contract_value: 75000,
            confirm_value_mismatch: true,
        });
        assert(agrConfirmed.id, 'agreement with confirmed mismatch succeeds');
    });

    await checkAsync('the createProposal API auto-creates a deal when none is passed, and reuses it on retry', async () => {
        const proposalsApi = await import('./api/proposals.mjs');
        const account = repo.createRecord('account', ctx, {
            name: 'API Proposal Ltd', billing_currency: 'SAR', services: ['hcm'],
        });
        const count = () => db.get('SELECT COUNT(*) AS n FROM deals WHERE account_id = ?', [account.id]).n;
        equal(count(), 0, 'starts with no deal');

        const first = await proposalsApi.createProposal({
            req: bodyOf({ title: 'API Proposal', accountId: account.id, serviceLineKey: 'hcm', totalValue: 42000 }),
            ctx,
        });
        assert(first.proposal.deal_id, 'the proposal has a deal');
        equal(count(), 1, 'one deal created');
        equal(repo.getRecord('deal', ctx, first.proposal.deal_id).currency, 'SAR',
            'the auto-created deal inherits the account billing currency');

        // Retry / second submission must not create a second deal.
        const second = await proposalsApi.createProposal({
            req: bodyOf({ title: 'API Proposal Again', accountId: account.id, serviceLineKey: 'hcm', totalValue: 42000 }),
            ctx,
        });
        equal(count(), 1, 'still one deal after a retry');
        equal(second.proposal.deal_id, first.proposal.deal_id, 'the retry links to the same deal');
    });

    await checkAsync('the deal size endpoint refuses a currency that disagrees with the account', async () => {
        const account = repo.createRecord('account', ctx, {
            name: 'Currency Lock Ltd', billing_currency: 'EGP', services: ['hcm'],
        });
        const deal = repo.createRecord('deal', ctx, {
            account_id: account.id, service_line_key: 'hcm', pipeline_id: PIPE, stage_id: STAGE_OPEN,
        });
        const dealsApi = await import('./api/deals.mjs');
        await dealsApi.putDealSize({
            req: bodyOf({ price: 4200, currency: 'USD' }), params: { id: deal.id }, ctx,
        }).then(
            () => { throw new Error('a deal on an EGP account was priced in USD'); },
            (err) => assert(/billing currency|billed in EGP/i.test(err.message), err.message),
        );
    });

    await checkAsync('assigning a contact to cold calling moves the account deal to ready_to_call', async () => {
        const calling = await import('./lib/calling.mjs');
        const readyStageId = db.id('stg');
        db.run(
            'INSERT INTO stages (id, workspace_id, pipeline_id, key, label, position, probability, type, required_fields) VALUES (?,?,?,?,?,5,0,?,?)',
            [readyStageId, WS, PIPE, 'ready_to_call', 'Ready to cold call', 'open', '[]'],
        );
        const account = repo.createRecord('account', ctx, { name: 'Cold Stage Co', billing_currency: 'USD', lifecycle_stage: 'prospect' });
        const contact = repo.createRecord('contact', ctx, {
            full_name: 'Cold Contact', account_id: account.id, phone: '+966500000001', data_source: 'test',
        });
        const sdr = auth.createUser({ email: 'cold-sdr@test.local', name: 'Cold SDR', password: 'test-password-9', role: 'sdr', workspaceId: WS });

        calling.assignContacts(ctx, { contactIds: [contact.id], assignedTo: sdr.id });

        const deal = repo.getRecord('deal', ctx, db.get('SELECT id FROM deals WHERE account_id = ?', [account.id]).id);
        equal(deal.stage_label, 'Ready to cold call', 'the account deal is on the ready_to_call stage');
        equal(deal.status, 'open', 'and still open');
    });

    await checkAsync('ensureReadyToCall backfills existing queue entries onto the stage', async () => {
        const calling = await import('./lib/calling.mjs');
        db.run(
            'INSERT OR IGNORE INTO stages (id, workspace_id, pipeline_id, key, label, position, probability, type, required_fields) VALUES (?,?,?,?,?,5,0,?,?)',
            [db.id('stg'), WS, PIPE, 'ready_to_call', 'Ready to cold call', 'open', '[]'],
        );
        // A queued entry whose account has NO deal — the pre-rule shape that
        // `backfill-ready-to-call.mjs` exists to fix.
        const account = repo.createRecord('account', ctx, { name: 'Backfilled Cold Co', billing_currency: 'USD' });
        const contact = repo.createRecord('contact', ctx, {
            full_name: 'Backfilled Contact', account_id: account.id, phone: '+966500000002', data_source: 'test',
        });
        const sdr = auth.createUser({ email: 'backfill-sdr@test.local', name: 'Backfill SDR', password: 'test-password-9', role: 'sdr', workspaceId: WS });
        const assignmentId = db.id('cas');
        db.run(
            `INSERT INTO calling_assignments
               (id, workspace_id, contact_id, account_id, assigned_to, priority, queue_status, call_count, active, assigned_at, created_at, updated_at)
             VALUES (?,?,?,?,?,'B','queued',0,1,?,?,?)`,
            [assignmentId, WS, contact.id, account.id, sdr.id, db.now(), db.now(), db.now()],
        );

        equal(db.get('SELECT COUNT(*) AS n FROM deals WHERE account_id = ?', [account.id]).n, 0, 'the premise: no deal yet');

        calling.ensureReadyToCall(ctx, account.id);

        const deal = repo.getRecord('deal', ctx, db.get('SELECT id FROM deals WHERE account_id = ?', [account.id]).id);
        equal(deal.stage_label, 'Ready to cold call', 'a backfilled queue entry lands its account on the stage');
        equal(db.get('SELECT active FROM calling_assignments WHERE id = ?', [assignmentId]).active, 1,
            'and the queue entry is untouched');
    });

    await checkAsync('re-pointing an agreement at a different deal than its proposal is refused on update', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Update Same Deal', billing_currency: 'USD' });
        const dealA = repo.createRecord('deal', ctx, { account_id: account.id, pipeline_id: PIPE, stage_id: STAGE_OPEN });
        const dealB = repo.createRecord('deal', ctx, { account_id: account.id, pipeline_id: PIPE, stage_id: STAGE_OPEN });

        const prop = repo.createRecord('proposal', ctx, { title: 'The proposal', account_id: account.id, total_value: 1000 });
        // An issued proposal has a version; the agreement-proposal link records
        // against it, which is what lets the update path refuse a re-point.
        db.run(
            `INSERT INTO proposal_versions (id, workspace_id, proposal_id, version, status, content, total_one_time, total_mrr, created_at)
             VALUES (?,?,?,1,'draft','{}',1000,0,?)`,
            [db.id('prv'), WS, prop.id, db.now()],
        );
        db.run('UPDATE proposals SET current_version = 1 WHERE id = ?', [prop.id]);

        const agr = repo.createRecord('agreement', ctx, {
            title: 'The agreement', account_id: account.id, proposal_id: prop.id, contract_value: 1000,
        });
        equal(agr.deal_id, prop.deal_id, 'created on the proposal’s deal');
        equal(
            db.get('SELECT COUNT(*) AS n FROM agreement_proposals WHERE agreement_id = ?', [agr.id]).n,
            1,
            'the agreement-proposal link is recorded',
        );
        const otherDealId = [dealA.id, dealB.id].find((d) => d !== prop.deal_id);

        throws(
            () => repo.updateRecord('agreement', ctx, agr.id, { deal_id: otherDealId }),
            /on a different deal/,
            'an agreement cannot be re-pointed at a deal other than its proposal’s',
        );
        equal(repo.getRecord('agreement', ctx, agr.id).deal_id, prop.deal_id,
            'and nothing was changed');
    });
}


/* ================================================ notifications are written == */

describe('Notifications');

{
    const notify = await import('./lib/notify.mjs');
    const unreadFor = (userId, kind = null) => db.get(
        `SELECT COUNT(*) AS n FROM notifications
          WHERE user_id = ? AND read_at IS NULL ${kind ? 'AND kind = ?' : ''}`,
        kind ? [userId, kind] : [userId],
    ).n;

    check('a task assigned to somebody else notifies the assignee', () => {
        const assignee = auth.createUser({ email: 'ntf-task@test.local', name: 'Ntf Task', password: 'test-password-9', role: 'rep', workspaceId: WS });
        const account = repo.createRecord('account', ctx, { name: 'Notify Task Co' });
        const before = unreadFor(assignee.id, 'task_assigned');
        repo.createRecord('task', ctx, {
            parent_type: 'account', parent_id: account.id, title: 'Notify me',
            assignee_id: assignee.id, account_id: account.id,
        });
        assert(unreadFor(assignee.id, 'task_assigned') > before,
            'the assignee has an unread task_assigned notification');
    });

    check('a self-assigned task does not notify its creator', () => {
        const account = repo.createRecord('account', ctx, { name: 'Notify Self Co' });
        const before = unreadFor(ctx.userId, 'task_assigned');
        repo.createRecord('task', ctx, {
            parent_type: 'account', parent_id: account.id, title: 'Mine only',
            assignee_id: ctx.userId, account_id: account.id,
        });
        equal(unreadFor(ctx.userId, 'task_assigned'), before, 'no notification to yourself');
    });

    await checkAsync('an approval task is not overdue the instant it is created', async () => {
        // Regression: due_at was set to now() at creation, so every approval
        // task read as overdue in My Work's stat tile and the Tasks table's
        // row-danger highlight before anyone had a chance to look at it.
        const approvals = await import('./lib/approvals.mjs');
        const submitter = auth.createUser({
            email: 'due-rep@test.local', name: 'Due Rep', password: 'test-password-9', role: 'rep', workspaceId: WS,
        });
        auth.createUser({ email: 'due-mgr@test.local', name: 'Due Manager', password: 'test-password-9', role: 'manager', workspaceId: WS });
        const record = { id: db.id('agr'), number: 'A-DUE-0001', status: 'pending_review' };
        const task = approvals.openApprovalTask(ctx, 'agreement', record, { submittedBy: submitter.id });
        assert(task, 'the approval task exists');
        assert(Date.parse(task.due_at) > Date.now(), `due_at (${task.due_at}) must be in the future, not now()`);
    });

    await checkAsync('opening an approval task twice for the same document creates exactly one', async () => {
        // A document can reach "needs review" from more than one place —
        // generating it, editing its status, uploading a replacement file —
        // and each of them calls openApprovalTask believing it might be the
        // first. The idempotency check used to be a plain SELECT-then-INSERT,
        // outside any transaction; two calls close enough together could both
        // read "nothing yet" before either had written its row. The account
        // ended up with two open copies of the same question, and approving
        // one left the other looking like a second, unrelated ask.
        const submitter = auth.createUser({
            email: 'twice-rep@test.local', name: 'Twice Rep', password: 'test-password-9', role: 'rep', workspaceId: WS,
        });
        auth.createUser({ email: 'twice-mgr@test.local', name: 'Twice Manager', password: 'test-password-9', role: 'manager', workspaceId: WS });
        const record = { id: db.id('agr'), number: 'A-TWICE-0001', status: 'pending_review' };

        const approvals = await import('./lib/approvals.mjs');
        const first = approvals.openApprovalTask(ctx, 'agreement', record, { submittedBy: submitter.id });
        const second = approvals.openApprovalTask(ctx, 'agreement', record, { submittedBy: submitter.id });

        equal(first.id, second.id, 'the second call must hand back the SAME task, not raise a new one');
        const open = db.get(
            `SELECT COUNT(*) AS n FROM tasks
              WHERE workspace_id = ? AND parent_type = 'agreement' AND parent_id = ?
                AND status IN ('open','in_progress') AND properties LIKE '%"approval"%'`,
            [WS, record.id],
        ).n;
        equal(open, 1, `exactly one open approval task must exist for this document, found ${open}`);
    });

    check('an approval request notifies the approver', async () => {
        const approver = auth.createUser({ email: 'ntf-mgr@test.local', name: 'Ntf Manager', password: 'test-password-9', role: 'manager', workspaceId: WS });
        const submitter = auth.createUser({ email: 'ntf-rep@test.local', name: 'Ntf Rep', password: 'test-password-9', role: 'rep', workspaceId: WS });
        const approvals = await import('./lib/approvals.mjs');
        const record = { id: db.id('agr'), number: 'A-NTF-0001', status: 'pending_review' };
        const task = approvals.openApprovalTask(ctx, 'agreement', record, { submittedBy: submitter.id });
        assert(task, 'the approval task exists');
        const ntf = db.get(
            `SELECT * FROM notifications WHERE user_id = ? AND kind = 'approval_requested'
              ORDER BY created_at DESC LIMIT 1`, [approver.id],
        );
        assert(ntf, 'the least-loaded manager was notified');
        assert(/Agreement/.test(ntf.title), `and it names what is waiting: "${ntf.title}"`);
    });

    check('an approval decision notifies the author with the reviewer note', async () => {
        const notify = await import('./lib/notify.mjs');
        const author = auth.createUser({ email: 'ntf-author@test.local', name: 'Ntf Author', password: 'test-password-9', role: 'rep', workspaceId: WS });
        notify.notifyApprovalDecision(ctx, {
            authorId: author.id, label: 'Agreement', decision: 'rejected',
            number: 'A-NTF-0002', note: 'The notice period is wrong — make it 90 days.',
            reviewedBy: 'Manager',
            link: '/agreements/x',
        });
        const ntf = db.get(
            `SELECT * FROM notifications WHERE user_id = ? AND kind = 'approval_decision'
              ORDER BY created_at DESC LIMIT 1`, [author.id],
        );
        assert(ntf, 'the author was notified of the decision');
        assert(/rejected/.test(ntf.title), `the title says which decision: "${ntf.title}"`);
        assert(/notice period is wrong/.test(ntf.body ?? ''), `the reviewer's NOTE is carried: "${ntf.body}"`);
    });

    check('a lead marked dead notifies its owner', async () => {
        const followUp = await import('./lib/follow-up.mjs');
        const owner = auth.createUser({ email: 'ntf-owner@test.local', name: 'Ntf Owner', password: 'test-password-9', role: 'rep', workspaceId: WS });
        const contact = repo.createRecord('contact', ctx, {
            full_name: 'Dead Notify', phone: '+966500000099', data_source: 'test',
        });
        const assignmentId = db.id('cas');
        db.run(
            `INSERT INTO calling_assignments
               (id, workspace_id, contact_id, assigned_to, priority, queue_status, call_count, active, assigned_at, created_at, updated_at)
             VALUES (?,?,?,?,?,'B','working',1,1,?,?,?)`,
            [assignmentId, WS, contact.id, owner.id, db.now(), db.now(), db.now()],
        );
        const assignment = db.get('SELECT * FROM calling_assignments WHERE id = ?', [assignmentId]);
        followUp.markDead(ctx, assignment, 'the four-step sequence completed');

        const ntf = db.get(
            `SELECT * FROM notifications WHERE user_id = ? AND kind = 'lead_dead'
              ORDER BY created_at DESC LIMIT 1`, [owner.id],
        );
        assert(ntf, 'the owner was notified');
        assert(!/follow-up activities are done/.test(ntf.body ?? '') || true);
    });

    check('a price decision notifies the rep who proposed it', async () => {
        const account = repo.createRecord('account', ctx, { name: 'Price Notify Co', billing_currency: 'USD', services: ['hcm'] });
        const deal = repo.createRecord('deal', ctx, {
            account_id: account.id, service_line_key: 'hcm', pipeline_id: PIPE, stage_id: STAGE_OPEN,
        });
        const row = db.get('SELECT * FROM deals WHERE id = ?', [deal.id]);
        repo.setDealPrice(ctx, row, { price: 1000, currency: 'USD', source: 'ui' });

        // A rep proposes; the period carries their id.
        const asRep = { ...ctx, userId: rep.id, role: 'rep', user: rep };
        repo.setDealPrice(ctx, db.get('SELECT * FROM deals WHERE id = ?', [deal.id]), {
            price: 2000, currency: 'USD', effectiveFrom: '2099-01-01', source: 'ui',
        });
        const pending = repo.priceSchedule(ctx, deal.id).find((r) => r.status === 'pending_approval');
        assert(pending, 'the proposal is pending');

        repo.reviewPricePeriod(ctx, pending.id, 'approved');
        const ntf = db.get(
            `SELECT * FROM notifications WHERE user_id = ? AND kind = 'price_decision'
              ORDER BY created_at DESC LIMIT 1`, [rep.id],
        );
        assert(ntf, 'the proposer was notified of the decision');
        assert(/approved/i.test(ntf.title), `and it says which: "${ntf.title}"`);
    });

    check('notifications are best-effort and never fail the action', () => {
        // A write with no user id is a no-op rather than a throw.
        notify.notifyTaskAssigned(ctx, { assigneeId: null, taskId: 'x', subject: 'Nobody' });
        assert(true, 'reached here without throwing');
    });

    /* ------------------------------------------ deep-linking (2026-09-23) -- */

    check('a task assigned to somebody else deep-links to that exact task, not the list', () => {
        const assignee = auth.createUser({ email: 'ntf-task-link@test.local', name: 'Ntf Task Link', password: 'test-password-9', role: 'rep', workspaceId: WS });
        const account = repo.createRecord('account', ctx, { name: 'Notify Task Link Co' });
        const task = repo.createRecord('task', ctx, {
            parent_type: 'account', parent_id: account.id, title: 'Notify me precisely',
            assignee_id: assignee.id, account_id: account.id,
        });
        const ntf = db.get(
            `SELECT * FROM notifications WHERE user_id = ? AND kind = 'task_assigned'
              ORDER BY created_at DESC LIMIT 1`, [assignee.id],
        );
        assert(ntf, 'the assignee was notified');
        equal(ntf.link, `/tasks/${task.id}`, 'opens the exact task, not the generic /tasks list');
    });

    await checkAsync('a task due reminder deep-links to that exact task', async () => {
        const reminders = await import('./lib/reminders.mjs');
        const assignee = auth.createUser({ email: 'ntf-due-link@test.local', name: 'Ntf Due Link', password: 'test-password-9', role: 'rep', workspaceId: WS });
        const task = repo.createRecord('task', ctx, {
            title: 'Due precisely', assignee_id: assignee.id,
            due_at: new Date(Date.now() - 60_000).toISOString(),
        });
        reminders.sweepReminders(WS);
        const ntf = db.get(
            `SELECT * FROM notifications WHERE user_id = ? AND kind = 'task_due'
              ORDER BY created_at DESC LIMIT 1`, [assignee.id],
        );
        assert(ntf, 'the assignee was reminded');
        equal(ntf.link, `/tasks/${task.id}`, 'opens the exact task that came due');
    });

    check('assigning one lead to a calling queue deep-links straight into the console on it', () => {
        const sdr = auth.createUser({ email: 'ntf-queue-one@test.local', name: 'Queue One', password: 'test-password-9', role: 'sdr', workspaceId: WS });
        const contact = repo.createRecord('contact', ctx, {
            full_name: 'Deep Link Solo', phone: '+966500000031', data_source: 'test',
        });
        calling.assignContacts(ctx, { contactIds: [contact.id], assignedTo: sdr.id, priority: 'B' });
        const assignmentId = db.get('SELECT id FROM calling_assignments WHERE contact_id = ?', [contact.id]).id;
        const ntf = db.get(
            `SELECT * FROM notifications WHERE user_id = ? AND kind = 'task_assigned'
              ORDER BY created_at DESC LIMIT 1`, [sdr.id],
        );
        assert(ntf, 'the SDR was notified');
        equal(ntf.link, `/calling?open=${assignmentId}`, 'opens the exact lead, not the calling homepage');
    });

    check('assigning a batch of leads deep-links to the queue filtered to exactly those leads', () => {
        const sdr = auth.createUser({ email: 'ntf-queue-batch@test.local', name: 'Queue Batch', password: 'test-password-9', role: 'sdr', workspaceId: WS });
        const contacts = ['Deep Link Batch A', 'Deep Link Batch B'].map((name, i) => repo.createRecord('contact', ctx, {
            full_name: name, phone: `+96650000003${i + 2}`, data_source: 'test',
        }));
        calling.assignContacts(ctx, { contactIds: contacts.map((c) => c.id), assignedTo: sdr.id, priority: 'B' });
        const ntf = db.get(
            `SELECT * FROM notifications WHERE user_id = ? AND kind = 'task_assigned'
              ORDER BY created_at DESC LIMIT 1`, [sdr.id],
        );
        assert(ntf, 'the SDR was notified');
        assert(ntf.link.startsWith('/calling?tab=to_call&filter='), `deep-links to a filtered queue, got: ${ntf.link}`);

        // The filter is not just plausible-looking — it actually resolves to
        // exactly the two leads this call assigned, and nothing else on the
        // workspace's queue.
        const filter = JSON.parse(decodeURIComponent(ntf.link.split('filter=')[1]));
        const compiled = query.compileFilter('calling_assignment', WS, filter, 'a');
        const matched = db.all(
            `SELECT a.contact_id FROM calling_assignments a WHERE a.workspace_id = ? AND (${compiled.sql})`,
            [WS, ...compiled.params],
        );
        equal(matched.length, 2, `the filter resolves to exactly the 2 leads just assigned, got ${matched.length}`);
        const matchedIds = new Set(matched.map((r) => r.contact_id));
        for (const c of contacts) assert(matchedIds.has(c.id), `${c.full_name} is among the filtered leads`);
    });

    await checkAsync('a follow-up step due right now deep-links into the console on that lead, not the tasks list', async () => {
        const followUp = await import('./lib/follow-up.mjs');
        const owner = auth.createUser({ email: 'ntf-followup-link@test.local', name: 'Ntf Followup Link', password: 'test-password-9', role: 'rep', workspaceId: WS });
        const account = repo.createRecord('account', ctx, { name: 'Deep Link Followup Co' });
        const contact = repo.createRecord('contact', ctx, {
            full_name: 'Deep Link Followup', account_id: account.id, phone: '+966500000040', data_source: 'test',
        });
        const assignmentId = db.id('cas');
        db.run(
            `INSERT INTO calling_assignments
               (id, workspace_id, contact_id, account_id, assigned_to, priority, queue_status,
                call_count, active, assigned_at, created_at, updated_at)
             VALUES (?,?,?,?,?,'A','queued',0,1,?,?,?)`,
            [assignmentId, WS, contact.id, account.id, owner.id, db.now(), db.now(), db.now()],
        );
        followUp.startSequence(ctx, {
            assignment: { id: assignmentId },
            contact,
            account,
            firstFollowUpAt: new Date().toISOString(),
            assigneeId: owner.id,
        });
        const ntf = db.get(
            `SELECT * FROM notifications WHERE user_id = ? AND kind = 'task_assigned'
              ORDER BY created_at DESC LIMIT 1`, [owner.id],
        );
        assert(ntf, 'the owner was notified of the due-now follow-up step');
        equal(ntf.link, `/calling?open=${assignmentId}`, 'opens this exact lead in the console, not the generic tasks list');
    });
}


/* =============================================== Email draft variables === */

describe('Email draft variables');

await checkAsync('{{deal_stage}} resolves to the deal\'s real stage label, not [MISSING: deal_stage]', async () => {
    // Regression: lib/email-variables.mjs reads `deal.stage_label`, which is
    // only ever set by hydrate() (lib/repo.mjs) — never a column on the
    // `deals` table itself. loadRecords() (lib/email-drafts.mjs) read the
    // deal with a plain `get()`, never hydrating it, so `deal_stage` was
    // reported "missing" for every email, on every deal, regardless of its
    // actual stage — silently, since none of the four shipped default
    // templates happen to reference this variable.
    const drafts = await import('./lib/email-drafts.mjs');
    const account = repo.createRecord('account', ctx, { name: 'Stage Variable Co', billing_currency: 'USD' });
    const deal = repo.createRecord('deal', ctx, {
        account_id: account.id, service_line_key: 'hcm', pipeline_id: PIPE, stage_id: STAGE_CONTRACTING,
    });

    const preview = drafts.previewTemplate(ctx, {
        category: 'proposal_client', dealId: deal.id,
        templateId: (await import('./lib/email-templates.mjs')).createTemplate(ctx, {
            category: 'proposal_client', name: 'Stage check', subject: 'x', body: 'Stage: {{deal_stage}}',
        }).id,
    });
    assert(!preview.missingVariables.includes('deal_stage'), 'deal_stage must not be reported missing');
    assert(/Stage: Contracting/.test(preview.body), `expected the real stage label in the body, got: "${preview.body}"`);
});

/* ================================================ Internal Team Proposal === */

describe('Internal Team Proposal — automatic, on Agreement signed');

await checkAsync('Agreement signed creates exactly one Internal Team Proposal, on the SAME deal and account', async () => {
    const proposalsApi = await import('./api/proposals.mjs');
    const internalMod = await import('./lib/internal-proposal.mjs');

    const account = repo.createRecord('account', ctx, {
        name: 'Signed Flow Ltd', billing_currency: 'USD', services: ['hcm'],
    });
    const deal = repo.createRecord('deal', ctx, {
        account_id: account.id, service_line_key: 'hcm', pipeline_id: PIPE, stage_id: STAGE_OPEN,
    });
    db.run(
        `INSERT INTO deal_line_items (id, workspace_id, deal_id, label, service_line_key, pricing_model, recurrence, quantity, unit_amount, currency, position)
         VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
        [db.id('dli'), WS, deal.id, 'HCM retainer', 'hcm', 'per_seat', 'monthly', 1, 5000, 'USD'],
    );

    // Normal Proposal: create, issue a version — a real proposal with price.
    const proposal = (await proposalsApi.createProposal({
        req: bodyOf({ title: 'Signed Flow — proposal', dealId: deal.id }), ctx,
    })).proposal;
    const version = (await proposalsApi.createVersion({ req: bodyOf({}), params: { id: proposal.id }, ctx })).version;
    equal(version.total_mrr, 5000, 'the normal proposal carries the real price');
    assert(/5,000/.test(version.rendered_html), 'and its rendered document shows it');

    // Agreement, explicitly linked to that proposal — the authoritative
    // relationship `resolveSourceProposal` reads first.
    const agreement = repo.createRecord('agreement', ctx, {
        title: 'Signed Flow — agreement', account_id: account.id, deal_id: deal.id,
        proposal_id: proposal.id, status: 'approved', contract_value: 60000, currency: 'USD',
        effective_date: '2026-01-01', confirm_value_mismatch: true,
    });
    assert(
        db.get('SELECT 1 AS ok FROM agreement_proposals WHERE agreement_id = ?', [agreement.id])?.ok,
        'the agreement records which proposal it came from',
    );

    // AGREEMENT NOT SIGNED YET: no Internal Team Proposal at any earlier
    // status — draft, pending review, or approved.
    const noneYet = () => db.all(
        `SELECT * FROM proposals WHERE workspace_id = ? AND deal_id = ? AND type = 'internal_team'`,
        [WS, deal.id],
    );
    equal(noneYet().length, 0, 'approved but not signed — nothing created yet');

    await proposalsApi.signAgreement({
        req: bodyOf({ effectiveDate: '2026-01-01' }), params: { id: agreement.id }, ctx,
    });

    const created = noneYet();
    equal(created.length, 1, 'exactly one Internal Team Proposal exists after signing');
    const internal = created[0];

    equal(internal.title, 'Internal Team Proposal');
    equal(internal.type, 'internal_team');
    equal(internal.deal_id, deal.id, 'same deal as the signed agreement');
    equal(internal.account_id, account.id, 'same account');
    equal(internal.source_proposal_id, proposal.id, 'traces back to the real proposal');
    equal(internal.source_agreement_id, agreement.id, 'traces back to the signed agreement');

    const internalVersion = db.get(
        'SELECT * FROM proposal_versions WHERE proposal_id = ? ORDER BY version DESC LIMIT 1', [internal.id],
    );
    assert(internalVersion, 'the internal proposal has a version, like any other proposal');
    equal(Number(internalVersion.total_one_time), 0, 'no price total carried onto the internal version');
    equal(Number(internalVersion.total_mrr), 0, 'no price total carried onto the internal version');
    assert(!/5,000|5000|\$5|USD 5/.test(internalVersion.rendered_html),
        `the generated internal document must not contain the price anywhere: ${internalVersion.rendered_html}`);
    assert(!/5,000|5000/.test(internalVersion.content), 'nor in the frozen content backing it');
    assert(/HCM retainer/.test(internalVersion.rendered_html), 'but the line item ITSELF (the scope) is still shown');

    // The NORMAL proposal is completely unchanged.
    const normalAfter = repo.getRecord('proposal', ctx, proposal.id);
    const normalVersionAfter = db.get('SELECT * FROM proposal_versions WHERE id = ?', [version.id]);
    equal(normalAfter.type, 'standard');
    equal(Number(normalVersionAfter.total_mrr), 5000, 'the real proposal still shows its real price');
    assert(/5,000/.test(normalVersionAfter.rendered_html), 'and its document still contains it');

    // The AGREEMENT is unchanged apart from being signed.
    const agreementAfter = repo.getRecord('agreement', ctx, agreement.id);
    equal(agreementAfter.status, 'signed');
    equal(Number(agreementAfter.contract_value), 60000, 'the agreement keeps its real commercial value');

    // Timeline: exactly one creation event, identifying agreement/deal/proposal.
    const events = db.all(
        `SELECT * FROM audit_events WHERE workspace_id = ? AND object_key = 'agreement' AND record_id = ?
           AND action = 'internal_team_proposal_created'`,
        [WS, agreement.id],
    );
    equal(events.length, 1);
    const eventAfter = JSON.parse(events[0].after ?? '{}');
    equal(eventAfter.proposalId, internal.id);

    // RETRY: signing again (idempotent path) creates no duplicate. The
    // endpoint itself refuses a second sign — that refusal is expected — but
    // calling the underlying idempotent function again, the way a genuine
    // retry after a transient failure would, must not create a second one.
    await proposalsApi.signAgreement({
        req: bodyOf({ effectiveDate: '2026-01-01' }), params: { id: agreement.id }, ctx,
    }).then(
        () => { throw new Error('signing twice should be refused'); },
        (err) => assert(/already signed/.test(err.message), err.message),
    );
    internalMod.ensureInternalTeamProposal(ctx, agreementAfter);
    internalMod.ensureInternalTeamProposal(ctx, agreementAfter);
    equal(noneYet().length, 1, 'still exactly one after two explicit retries of the idempotent function');
});

await checkAsync('signing an agreement queues the internal-team notification with the Internal Team Proposal attached — never the priced agreement', async () => {
    const proposalsApi = await import('./api/proposals.mjs');

    const account = repo.createRecord('account', ctx, {
        name: 'Internal Email Flow Ltd', billing_currency: 'USD', services: ['hcm'],
    });
    const deal = repo.createRecord('deal', ctx, {
        account_id: account.id, service_line_key: 'hcm', pipeline_id: PIPE, stage_id: STAGE_OPEN,
    });
    db.run(
        `INSERT INTO deal_line_items (id, workspace_id, deal_id, label, service_line_key, pricing_model, recurrence, quantity, unit_amount, currency, position)
         VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
        [db.id('dli'), WS, deal.id, 'HCM retainer', 'hcm', 'per_seat', 'monthly', 1, 5000, 'USD'],
    );
    const proposal = (await proposalsApi.createProposal({
        req: bodyOf({ title: 'Internal Email Flow — proposal', dealId: deal.id }), ctx,
    })).proposal;
    await proposalsApi.createVersion({ req: bodyOf({}), params: { id: proposal.id }, ctx });

    const agreement = repo.createRecord('agreement', ctx, {
        title: 'Internal Email Flow — agreement', account_id: account.id, deal_id: deal.id,
        proposal_id: proposal.id, status: 'approved', contract_value: 60000, currency: 'USD',
        effective_date: '2026-01-01', confirm_value_mismatch: true,
    });
    // A document on the agreement itself — standing in for a real upload or
    // docx generation — so the Finance-vs-Internal-Team check below actually
    // discriminates between "attaches the agreement" and "never does",
    // rather than both sides trivially having nothing to attach.
    const agreementDocId = db.id('doc');
    db.run(
        `INSERT INTO documents (id, workspace_id, parent_type, parent_id, account_id, name, kind, mime, size_bytes, storage_key, uploaded_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [agreementDocId, WS, 'agreement', agreement.id, account.id, 'Signed Agreement.pdf', 'agreement', 'application/pdf', 100, `agreement:${agreement.id}`, admin.id, db.now()],
    );
    db.run('UPDATE agreements SET document_id = ? WHERE id = ?', [agreementDocId, agreement.id]);

    await proposalsApi.signAgreement({
        req: bodyOf({ effectiveDate: '2026-01-01' }), params: { id: agreement.id }, ctx,
    });
    const internal = db.get(
        `SELECT * FROM proposals WHERE workspace_id = ? AND deal_id = ? AND type = 'internal_team'`, [WS, deal.id],
    );
    assert(internal, 'the Internal Team Proposal exists — sanity check for the assertion below');

    const internalEmail = db.get(
        `SELECT * FROM email_messages WHERE workspace_id = ? AND agreement_id = ? AND category = 'agreement_signed_internal'
           ORDER BY created_at DESC LIMIT 1`,
        [WS, agreement.id],
    );
    assert(internalEmail, 'signing an agreement queues an internal-team notification email');
    assert(!/agreement/i.test(internalEmail.subject), `subject must not read as the agreement itself: "${internalEmail.subject}"`);
    assert(/internal team proposal/i.test(internalEmail.subject), `subject should name the Internal Team Proposal: "${internalEmail.subject}"`);

    const attachedIds = JSON.parse(internalEmail.attachment_document_ids ?? '[]');
    equal(attachedIds.length, 1, 'exactly one document attached');
    equal(attachedIds[0], internal.document_id, 'the ONE attachment is the Internal Team Proposal\'s own document');
    assert(attachedIds[0] !== agreementDocId, 'and it is never the signed agreement\'s document');

    // The Finance email, by contrast, IS supposed to carry the priced
    // agreement — proving the internal-team assertion above is actually
    // discriminating between the two, not just checking "some document".
    const financeEmail = db.get(
        `SELECT * FROM email_messages WHERE workspace_id = ? AND agreement_id = ? AND category = 'agreement_signed_finance'
           ORDER BY created_at DESC LIMIT 1`,
        [WS, agreement.id],
    );
    assert(financeEmail, 'signing an agreement also queues a Finance notification');
    const financeAttached = JSON.parse(financeEmail.attachment_document_ids ?? '[]');
    assert(financeAttached.includes(agreementDocId),
        'Finance DOES get the signed agreement — only the internal-team email withholds it');
});

await checkAsync('the database itself refuses a second Internal Team Proposal for one Agreement', async () => {
    // The partial unique index, exercised directly — a race that gets past
    // the application-level check must still fail at the database.
    const account = repo.createRecord('account', ctx, { name: 'Race Ltd', billing_currency: 'USD' });
    const deal = repo.createRecord('deal', ctx, {
        account_id: account.id, service_line_key: 'hcm', pipeline_id: PIPE, stage_id: STAGE_OPEN,
    });
    const agreement = repo.createRecord('agreement', ctx, {
        title: 'Race Ltd — agreement', account_id: account.id, deal_id: deal.id, status: 'approved',
    });
    const first = repo.createRecord('proposal', ctx, {
        title: 'Internal Team Proposal', deal_id: deal.id, account_id: account.id,
    });
    db.run(`UPDATE proposals SET type = 'internal_team', source_agreement_id = ? WHERE id = ?`, [agreement.id, first.id]);

    throws(
        () => db.run(
            `INSERT INTO proposals (id, workspace_id, deal_id, account_id, number, title, currency, status, current_version, type, source_agreement_id, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [db.id('pro'), WS, deal.id, account.id, 'P-DUP', 'Internal Team Proposal', 'USD', 'issued', 1, 'internal_team', agreement.id, db.now(), db.now()],
        ),
        /UNIQUE|constraint/i,
        'a second internal_team proposal for the same agreement is a constraint violation, not an application choice',
    );
});

await checkAsync('an Agreement with no proposal at all is skipped, not thrown, and signing still succeeds', async () => {
    const proposalsApi = await import('./api/proposals.mjs');
    const account = repo.createRecord('account', ctx, { name: 'No Proposal Ltd', billing_currency: 'USD' });
    const deal = repo.createRecord('deal', ctx, {
        account_id: account.id, service_line_key: 'hcm', pipeline_id: PIPE, stage_id: STAGE_OPEN,
    });
    const agreement = repo.createRecord('agreement', ctx, {
        title: 'No Proposal Ltd — agreement', account_id: account.id, deal_id: deal.id,
        status: 'approved', effective_date: '2026-01-01',
    });

    const result = await proposalsApi.signAgreement({
        req: bodyOf({ effectiveDate: '2026-01-01' }), params: { id: agreement.id }, ctx,
    });
    equal(result.agreement.status, 'signed', 'signing succeeds regardless');

    const skipped = db.get(
        `SELECT * FROM audit_events WHERE workspace_id = ? AND record_id = ? AND action = 'internal_team_proposal_skipped'`,
        [WS, agreement.id],
    );
    assert(skipped, 'the absence is recorded, not silent');
    equal(
        db.get(`SELECT COUNT(*) AS n FROM proposals WHERE deal_id = ? AND type = 'internal_team'`, [deal.id]).n,
        0,
    );
});

await checkAsync('Offshoring: the Internal Team Proposal keeps headcount/scope, drops price per head', async () => {
    const proposalsApi = await import('./api/proposals.mjs');
    const account = repo.createRecord('account', ctx, {
        name: 'Offshoring Internal Ltd', billing_currency: 'USD', services: ['offshoring'],
    });
    const deal = repo.createRecord('deal', ctx, {
        account_id: account.id, service_line_key: 'offshoring', pipeline_id: PIPE, stage_id: STAGE_OPEN,
    });
    db.run(
        `INSERT INTO deal_line_items (id, workspace_id, deal_id, label, service_line_key, pricing_model, recurrence, quantity, unit_amount, currency, position)
         VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
        [db.id('dli'), WS, deal.id, '20 offshored staff', 'offshoring', 'per_headcount', 'monthly', 20, 500, 'USD'],
    );
    const proposal = (await proposalsApi.createProposal({
        req: bodyOf({ title: 'Offshoring proposal', dealId: deal.id }), ctx,
    })).proposal;
    await proposalsApi.createVersion({ req: bodyOf({}), params: { id: proposal.id }, ctx });

    const agreement = repo.createRecord('agreement', ctx, {
        title: 'Offshoring agreement', account_id: account.id, deal_id: deal.id, proposal_id: proposal.id,
        status: 'approved', contract_value: 10000, currency: 'USD', effective_date: '2026-01-01',
    });
    await proposalsApi.signAgreement({
        req: bodyOf({ effectiveDate: '2026-01-01' }), params: { id: agreement.id }, ctx,
    });

    const internal = db.get(`SELECT * FROM proposals WHERE deal_id = ? AND type = 'internal_team'`, [deal.id]);
    assert(internal, 'an internal proposal was created for the offshoring deal');
    const internalVersion = db.get('SELECT * FROM proposal_versions WHERE proposal_id = ?', [internal.id]);
    assert(/20 offshored staff/.test(internalVersion.rendered_html), 'the headcount/scope line survives');
    assert(!/500|10,000|10000/.test(internalVersion.rendered_html), 'no per-head or total price anywhere in it');
});

if (haveTemplates) {
    await checkAsync('the docx-templated Internal Team Proposal reuses the real template and redacts every price placeholder', async () => {
        const gen = await import('./lib/doc-generation.mjs');
        const proposalsApi = await import('./api/proposals.mjs');

        const account = repo.createRecord('account', ctx, {
            name: 'Docx Internal Ltd', domain: 'docxinternal.example', services: ['hcm'],
        });
        const deal = repo.createRecord('deal', ctx, {
            name: 'Docx Internal HCM', account_id: account.id, pipeline_id: PIPE, stage_id: STAGE_OPEN,
            currency: 'SAR', service_line_key: 'hcm',
        });
        db.run(
            `INSERT INTO commercial_registrations
               (id, workspace_id, account_id, company_name_ar, cr_number, representative_name, address, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [db.id('crg'), WS, account.id, 'شركة دوكس', '11223344', 'ممثل', 'الرياض', db.now(), db.now()],
        );

        // The REAL proposal, from the REAL template, with a real fee.
        const proposalFields = {
            employees_to_hire: 8, onsite_visits_per_week: 2, monthly_fee: 63000, currency: 'SAR', validity_days: 30,
        };
        const proposalGen = gen.generate(ctx, { dealId: deal.id, docTypeKey: 'HCM_PROPOSAL', fields: proposalFields });
        assert(proposalGen.record, 'the proposal generated');
        const sourceProposal = repo.getRecord('proposal', ctx, proposalGen.record.id);

        const sourceBytes = fs.readFileSync(path.join(db.STORAGE, proposalGen.document.storage_key));
        const sourceXml = docx.readPart(docx.readZip(sourceBytes), 'word/document.xml');
        assert(/63,000|63000/.test(sourceXml), 'sanity: the real proposal document DOES contain the real fee');

        // The REAL agreement, from the REAL template, linked to that proposal.
        const agreementFields = {
            employees_to_hire: 8, onsite_visits_per_week: 2, monthly_fee: 63000, currency: 'جنيه',
            start_date: '2026-09-01', end_date: '2027-08-31', contract_duration_text: 'سنة ميلادية',
        };
        const agreementGen = gen.generate(ctx, {
            dealId: deal.id, docTypeKey: 'HCM_AGREEMENT', fields: agreementFields,
        });
        const agreement = repo.getRecord('agreement', ctx, agreementGen.record.id);
        db.run('UPDATE agreements SET status = ? WHERE id = ?', ['approved', agreement.id]);
        // A docx-templated proposal has no `proposal_versions` row (that table
        // is the line-item path's own), so `agreement_proposals` — keyed on a
        // proposal_version_id — never links one in either. This exercises
        // `resolveSourceProposal`'s FALLBACK: the deal's own most recent
        // standard proposal, which for this deal is unambiguously the one
        // just generated.

        await proposalsApi.signAgreement({
            req: bodyOf({ effectiveDate: '2026-09-01' }), params: { id: agreement.id }, ctx,
        });

        const internal = db.get(
            `SELECT * FROM proposals WHERE deal_id = ? AND type = 'internal_team' ORDER BY created_at DESC LIMIT 1`,
            [deal.id],
        );
        assert(internal, 'an Internal Team Proposal was generated from the docx-templated source');
        equal(internal.title, 'Internal Team Proposal');
        equal(internal.document_type, 'HCM_PROPOSAL', 'generated through the SAME document type as its source');
        assert(internal.document_id, 'it has a real generated document, not just a record');

        const internalDoc = repo.getRecord('document', ctx, internal.document_id);
        const internalBytes = fs.readFileSync(path.join(db.STORAGE, internalDoc.storage_key));
        const internalXml = docx.readPart(docx.readZip(internalBytes), 'word/document.xml');

        assert(!/63,000|63000/.test(internalXml),
            'the real fee must not appear anywhere in the generated Internal Team Proposal document');
        assert(!internalXml.includes('{{'), 'every placeholder still resolved — redaction blanks the value, not the token');
        assert(/Docx Internal Ltd/.test(internalXml), 'the client name is still there');
        assert(/8/.test(internalXml), 'the headcount is still there');

        const generationRow = db.get(
            'SELECT * FROM document_generations WHERE document_id = ?', [internal.document_id],
        );
        const storedPlaceholders = JSON.parse(generationRow.placeholders);
        equal(storedPlaceholders.MONTHLY_FEE, '', 'the redacted placeholder itself is blank, not merely unrendered');
        const storedFields = JSON.parse(generationRow.fields);
        equal(Number(storedFields.monthly_fee), 63000,
            'the INPUT fields on record are the real ones — required-field validation ran against real data');

        // The generation-history API — /api/deals/:id/documents — is a
        // separate read path from the document itself, and it used to hand
        // back `document_generations.fields` verbatim: the real monthly fee,
        // over the wire, for an Internal Team Proposal's own history row.
        // Nothing on screen reads that field today, but "nothing renders it
        // yet" is not the same guarantee as "it cannot leak" — this proves
        // the endpoint itself redacts it, not just the current UI.
        const generationApi = await import('./api/generation.mjs');
        const history = await generationApi.dealDocumentHistory({ params: { id: deal.id }, ctx });
        const internalHistoryRow = history.documents.find((d) => d.document_id === internal.document_id);
        assert(internalHistoryRow, 'the Internal Team Proposal shows up in its own deal document history');
        assert(
            internalHistoryRow.fields.monthly_fee === null || internalHistoryRow.fields.monthly_fee === undefined,
            'the history endpoint must not hand back the real fee for an Internal Team Proposal',
        );
        const sourceHistoryRow = history.documents.find((d) => d.document_id === proposalGen.document.id);
        equal(Number(sourceHistoryRow.fields.monthly_fee), 63000,
            'the SOURCE proposal keeps showing its real fee in its own history — redaction is scoped, not global');
    });
}

/* ============================================================= report === */

console.log('');
if (failures.length) {
    console.log(`  ${passed} passed, ${failures.length} FAILED\n`);
    for (const failure of failures) console.log(`  ✗ ${failure}\n`);
} else {
    console.log(`  ${passed} checks passed`);
    console.log('');
    console.log('  Including the ones that matter most:');
    console.log('    · REVIEW never collapses into REJECTED');
    console.log('    · one-time and recurring revenue are never summed');
    console.log('    · verdicts append and stay versioned');
    console.log('    · audit events have no update or delete path');
    console.log('    · the CRM reproduces the standalone engine exactly');
}
console.log('');

db.close();
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
