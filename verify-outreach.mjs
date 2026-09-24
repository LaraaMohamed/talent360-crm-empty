import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-outreach-verify-'));
process.env.CRM_DB = path.join(TMP, 'test.db');
process.env.CRM_STORAGE = path.join(TMP, 'storage');

const db = await import('./lib/db.mjs');
const auth = await import('./lib/auth.mjs');
import * as smartlead from './lib/smartlead.mjs';
import * as outreach from './lib/outreach.mjs';

let passed = 0, failed = 0;
const failures = [];
let group = '';
function describe(name) { group = name; console.log(`\n=== ${name} ===`); }
function check(name, fn) {
    try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
    catch (e) { failed += 1; const msg = `${group} :: ${name}\n      ${e.message}`; failures.push(msg); console.log(`  ✗ ${name}\n    ${e.message}`); }
}
async function checkAsync(name, fn) {
    try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
    catch (e) { failed += 1; const msg = `${group} :: ${name}\n      ${e.message}`; failures.push(msg); console.log(`  ✗ ${name}\n    ${e.message}`); }
}
function equal(a, b, msg) {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg ?? 'not equal'}\n      expected ${JSON.stringify(b)}\n      actual   ${JSON.stringify(a)}`);
}

db.migrate();
const WS = db.id('wsp');
db.run(`INSERT INTO workspaces (id, name, base_currency, timezone, locale, weekend_days, verdict_stale_days, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    [WS, 'Test', 'SAR', 'Asia/Riyadh', 'en', '[5,6]', 180, db.now()]);
const suffix = Date.now();
const admin = auth.createUser({ email: `admin-${suffix}@test.local`, name: 'Admin', password: 'test-password-1', role: 'owner', workspaceId: WS });
const rep = auth.createUser({ email: `rep-${suffix}@test.local`, name: 'Rep', password: 'test-password-2', role: 'rep', workspaceId: WS });
const ctx = { workspaceId: WS, userId: admin.id, role: 'owner', user: { id: admin.id, name: 'Admin' }, workspace: { id: WS, baseCurrency: 'SAR', timezone: 'Asia/Riyadh', verdictStaleDays: 180, name: 'Test' } };
const repCtx = { ...ctx, userId: rep.id, role: 'rep', user: { id: rep.id, name: 'Rep' } };

for (const [key, label, model] of [['recruitment', 'Recruitment', 'placement_fee'], ['hcm', 'HCM', 'per_seat'], ['offshoring', 'Offshoring', 'per_headcount'], ['od', 'OD', 'fixed_fee']]) {
    db.run('INSERT INTO service_lines (id, workspace_id, key, label, pricing_model, position) VALUES (?,?,?,?,?,?)', [db.id('svc'), WS, key, label, model, 0]);
}
const PIPE = db.id('pip');
db.run('INSERT INTO pipelines (id, workspace_id, key, label, object_key, is_default, position, created_at) VALUES (?,?,?,?,?,1,0,?)', [PIPE, WS, 'default', 'Default', 'deal', db.now()]);
const STAGE_OPEN = db.id('stg');
db.run('INSERT INTO stages (id, workspace_id, pipeline_id, key, label, position, probability, type, required_fields) VALUES (?,?,?,?,?,0,0.2,?,?)', [STAGE_OPEN, WS, PIPE, 'open', 'Open', 'open', '["close_date"]']);
db.run('INSERT INTO stages (id, workspace_id, pipeline_id, key, label, position, probability, type, required_fields) VALUES (?,?,?,?,?,2,1,?,?)', [db.id('stg'), WS, PIPE, 'won', 'Won', 'won', '[]']);

function fakeFetch(map) {
    return async (url, init) => {
        for (const [substr, resp] of Object.entries(map)) {
            if (String(url).includes(substr)) {
                return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, text: async () => JSON.stringify(resp.body) };
            }
        }
        throw new Error(`Unexpected fetch: ${url}`);
    };
}

// ------------------------------------------------------------------ fixtures

const campaignId = db.id('cmp');
db.run(`INSERT INTO campaigns (id, workspace_id, key, name, status, channel, external_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    [campaignId, WS, 'outreach-q1', 'Q1 Outreach', 'active', 'email', 'SL_123', db.now(), db.now()]);
const accountId = db.id('acc');
db.run(`INSERT INTO accounts (id, workspace_id, name, created_at, updated_at) VALUES (?,?,?,?,?)`, [accountId, WS, 'Acme', db.now(), db.now()]);
function addContact(email) {
    const cId = db.id('con');
    db.run(`INSERT INTO contacts (id, workspace_id, account_id, first_name, last_name, email, owner_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        [cId, WS, accountId, 'Ann', 'Lee', email, admin.id, db.now(), db.now()]);
    return cId;
}

// ============================================================ transport ===

describe('Smartlead transport');
await checkAsync('testConnection succeeds on 200', async () => {
    const fetcher = fakeFetch({ '/campaigns/': { status: 200, body: [{ id: 1, name: 'A' }] } });
    const result = await smartlead.testConnection({ apiKey: 'k', fetcher });
    equal(result.ok, true, 'ok');
});
await checkAsync('testConnection throws SmartleadError on 401', async () => {
    const fetcher = fakeFetch({ '/campaigns/': { status: 401, body: { message: 'Invalid API Key' } } });
    try { await smartlead.testConnection({ apiKey: 'bad', fetcher }); throw new Error('should throw'); }
    catch (e) { if (!e.authFailed) throw new Error(`expected authFailed, got ${e.message}`); }
});
await checkAsync('addLeads batches at 100', async () => {
    let calls = 0;
    const fetcher = async () => { calls += 1; return { ok: true, status: 200, text: async () => JSON.stringify({ added_count: 75, skipped_count: 0, skipped_leads: [] }) }; };
    const leads = Array.from({ length: 150 }, (_, i) => ({ email: `u${i}@example.com` }));
    const result = await smartlead.addLeadsToCampaign(123, leads, undefined, { apiKey: 'k', fetcher });
    equal(calls, 2, 'two batches');
    equal(result.added_count, 150, 'sum');
});

// ============================================================ events ===

describe('Event normalization');
check('flat EMAIL_REPLY', () => {
    const ev = outreach.normalizeEvent({ event_type: 'EMAIL_REPLY', to_email: 'A@Example.COM', to_name: 'Ann', campaign_id: 5, campaign_name: 'X', sequence_number: 2, time_replied: '2026-08-20T10:00:00Z', subject: 'Re: hi', reply_body: '<p>yes</p>' });
    equal(ev.email, 'a@example.com', 'lowercased');
    equal(ev.type, 'EMAIL_REPLY', 'type');
    equal(ev.campaignRef, 5, 'campaign');
});
check('nested shape', () => {
    const ev = outreach.normalizeEvent({ event: 'EMAIL_REPLY', campaign_id: 9, lead: { email: 'b@example.com' }, reply: { body: 'reply' }, timestamp: '2026-08-20T11:00:00Z' });
    equal(ev.email, 'b@example.com', 'email');
});
check('LEAD_UNSUBSCRIBED uses lead_email', () => {
    const ev = outreach.normalizeEvent({ event_type: 'LEAD_UNSUBSCRIBED', lead_email: 'c@example.com', campaign_id: 1 });
    equal(ev.email, 'c@example.com', 'lead_email');
});
check('rejects payload with no email', () => {
    equal(outreach.normalizeEvent({ event_type: 'EMAIL_SENT', campaign_id: 1 }), null, 'null');
});
check('fingerprint stable and requestId wins', () => {
    const ev = { type: 'EMAIL_SENT', email: 'a@example.com', campaignRef: 1, messageId: 'm1', occurredAt: '2026-08-20T10:00:00Z' };
    equal(outreach.eventFingerprint(ev, null), outreach.eventFingerprint(ev, null), 'stable');
    equal(outreach.eventFingerprint(ev, 'req-1'), 'req-1', 'requestId');
});

// ============================================================ webhook ===

describe('Webhook ingestion');
const contactEmail = `ann.${Date.now()}@example.com`;
const contactId = addContact(contactEmail);

check('first EMAIL_SENT creates membership + contacted + activity', () => {
    const beforeMembers = db.all(`SELECT * FROM campaign_members WHERE workspace_id = ?`, [WS]).length;
    const beforeActivities = db.all(`SELECT * FROM activities WHERE workspace_id = ?`, [WS]).length;
    const result = outreach.ingestWebhookEvent(WS, { event_type: 'EMAIL_SENT', to_email: contactEmail, to_name: 'Ann Lee', campaign_id: 'SL_123', campaign_name: 'Q1 Outreach', sequence_number: 1, time_sent: '2026-08-20T10:00:00Z', message_id: 'mid-1' }, 'req-sent-1');
    equal(result.status, 'processed', 'processed');
    const member = db.get(`SELECT * FROM campaign_members WHERE campaign_id = ? AND member_id = ?`, [campaignId, contactId]);
    if (!member) throw new Error('no member');
    equal(member.total_emails_sent, 1, 'sent');
    equal(member.status, 'contacted', 'contacted');
    if (db.all(`SELECT * FROM activities WHERE workspace_id = ?`, [WS]).length <= beforeActivities) throw new Error('no activity');
});

check('duplicate delivery (same requestId) is a no-op', () => {
    const result = outreach.ingestWebhookEvent(WS, { event_type: 'EMAIL_SENT', to_email: contactEmail, campaign_id: 'SL_123', sequence_number: 1, time_sent: '2026-08-20T10:00:00Z', message_id: 'mid-1' }, 'req-sent-1');
    equal(result.status, 'duplicate', 'duplicate');
    const member = db.get(`SELECT * FROM campaign_members WHERE campaign_id = ? AND member_id = ?`, [campaignId, contactId]);
    equal(member.total_emails_sent, 1, 'still 1');
});

check('EMAIL_OPEN updates counters silently — no new activity', () => {
    const before = db.all(`SELECT * FROM activities WHERE workspace_id = ?`, [WS]).length;
    outreach.ingestWebhookEvent(WS, { event_type: 'EMAIL_OPEN', to_email: contactEmail, campaign_id: 'SL_123', time_opened: '2026-08-20T12:00:00Z' }, 'req-open-1');
    const member = db.get(`SELECT * FROM campaign_members WHERE campaign_id = ? AND member_id = ?`, [campaignId, contactId]);
    equal(member.total_opens, 1, 'opens');
    equal(db.all(`SELECT * FROM activities WHERE workspace_id = ?`, [WS]).length, before, 'no activity');
});

check('EMAIL_REPLY moves to responded + inbound activity', () => {
    const before = db.all(`SELECT * FROM activities WHERE workspace_id = ? AND direction = 'inbound'`, [WS]).length;
    outreach.ingestWebhookEvent(WS, { event_type: 'EMAIL_REPLY', to_email: contactEmail, campaign_id: 'SL_123', time_replied: '2026-08-21T09:00:00Z', subject: 'Re: hi', reply_body: '<p>interested</p>' }, 'req-reply-1');
    const member = db.get(`SELECT * FROM campaign_members WHERE campaign_id = ? AND member_id = ?`, [campaignId, contactId]);
    equal(member.status, 'responded', 'responded');
    if (!member.replied_at) throw new Error('no replied_at');
    equal(member.total_replies, 1, 'replies');
    if (db.all(`SELECT * FROM activities WHERE workspace_id = ? AND direction = 'inbound'`, [WS]).length <= before) throw new Error('no inbound activity');
});

check('EMAIL_BOUNCE moves to excluded', () => {
    const email2 = `bounce.${Date.now()}@example.com`;
    const c2 = addContact(email2);
    outreach.ingestWebhookEvent(WS, { event_type: 'EMAIL_SENT', to_email: email2, campaign_id: 'SL_123', sequence_number: 1, time_sent: '2026-08-20T10:00:00Z' }, `req-bounce-sent-${Date.now()}`);
    outreach.ingestWebhookEvent(WS, { event_type: 'EMAIL_BOUNCE', to_email: email2, campaign_id: 'SL_123' }, `req-bounce-${Date.now()}`);
    const member = db.get(`SELECT * FROM campaign_members WHERE campaign_id = ? AND member_id = ?`, [campaignId, c2]);
    equal(member.status, 'excluded', 'excluded');
    if (!member.bounced_at) throw new Error('no bounced_at');
});

check('LEAD_UNSUBSCRIBED moves to excluded', () => {
    const email3 = `unsub.${Date.now()}@example.com`;
    const c3 = addContact(email3);
    outreach.ingestWebhookEvent(WS, { event_type: 'EMAIL_SENT', to_email: email3, campaign_id: 'SL_123', sequence_number: 1, time_sent: '2026-08-20T10:00:00Z' }, `req-unsub-sent-${Date.now()}`);
    outreach.ingestWebhookEvent(WS, { event_type: 'LEAD_UNSUBSCRIBED', lead_email: email3, campaign_id: 'SL_123' }, `req-unsub-${Date.now()}`);
    const member = db.get(`SELECT * FROM campaign_members WHERE campaign_id = ? AND member_id = ?`, [campaignId, c3]);
    equal(member.status, 'excluded', 'excluded');
    if (!member.unsubscribed_at) throw new Error('no unsubscribed_at');
});

check('unknown campaign is recorded as failed', () => {
    const result = outreach.ingestWebhookEvent(WS, { event_type: 'EMAIL_SENT', to_email: contactEmail, campaign_id: 'SL_UNKNOWN', sequence_number: 1, time_sent: '2026-08-20T10:00:00Z' }, `req-unknown-${Date.now()}`);
    equal(result.status, 'failed', 'failed');
});

check('malformed payload is rejected', () => {
    const result = outreach.ingestWebhookEvent(WS, { nonsense: true }, `req-malformed-${Date.now()}`);
    equal(result.status, 'rejected', 'rejected');
});

check('webhook after reply does not move status backward (reopened?)', () => {
    // A late-coming EMAIL_SENT after a reply must not un-respond the lead
    outreach.ingestWebhookEvent(WS, { event_type: 'EMAIL_SENT', to_email: contactEmail, campaign_id: 'SL_123', sequence_number: 3, time_sent: '2026-08-22T10:00:00Z' }, `req-late-sent-${Date.now()}`);
    const member = db.get(`SELECT * FROM campaign_members WHERE campaign_id = ? AND member_id = ?`, [campaignId, contactId]);
    equal(member.status, 'responded', 'still responded');
});

// ============================================================ enrollment ===

describe('Enrollment');
const enrollCampaignId = db.id('cmp');
db.run(`INSERT INTO campaigns (id, workspace_id, key, name, status, channel, external_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    [enrollCampaignId, WS, 'enroll-test', 'Enroll Test', 'active', 'email', 'SL_999', db.now(), db.now()]);
db.get(`SELECT 1`) // ensure table exists
import { setSetting as _set } from './lib/settings.mjs';
_set(WS, 'smartlead_api_key', 'test-key');
const enrollEmail = `enroll.${Date.now()}@example.com`;
const enrollContactId = addContact(enrollEmail);
db.run(`UPDATE contacts SET verification_status = 'verified' WHERE id = ?`, [enrollContactId]);

await checkAsync('enrollContacts validates + reports per-contact results', async () => {
    const contact = db.get(`SELECT c.*, a.name AS account_name FROM contacts c LEFT JOIN accounts a ON a.id = c.account_id WHERE c.id = ?`, [enrollContactId]);
    const fetcher = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ added_count: 1, skipped_count: 0, skipped_leads: [] }) });
    const result = await outreach.enrollContacts(ctx, { campaignId: enrollCampaignId, contacts: [contact], mapping: {}, options: { fetcher } });
    equal(result.results[0].result, 'enrolled', 'enrolled');
    const member = db.get(`SELECT * FROM campaign_members WHERE campaign_id = ? AND member_id = ?`, [enrollCampaignId, enrollContactId]);
    if (!member) throw new Error('no member');
});

await checkAsync('already_member reported, not re-added', async () => {
    const contact = db.get(`SELECT c.*, a.name AS account_name FROM contacts c LEFT JOIN accounts a ON a.id = c.account_id WHERE c.id = ?`, [enrollContactId]);
    let calls = 0;
    const fetcher = async () => { calls += 1; return { ok: true, status: 200, text: async () => JSON.stringify({ added_count: 0, skipped_count: 0, skipped_leads: [] }) }; };
    const result = await outreach.enrollContacts(ctx, { campaignId: enrollCampaignId, contacts: [contact], mapping: {}, options: { fetcher } });
    equal(result.results[0].result, 'already_member', 'already_member');
    equal(calls, 0, 'no API call');
});

await checkAsync('suppressed (bounced) contact is held back', async () => {
    const bounceEmail = `suppressed.${Date.now()}@example.com`;
    const bouncedId = addContact(bounceEmail);
    db.run(`UPDATE contacts SET verification_status = 'verified' WHERE id = ?`, [bouncedId]);
    const memId = db.id('cmm');
    db.run(`INSERT INTO campaign_members (id, workspace_id, campaign_id, member_type, member_id, account_id, status, added_at, bounced_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        [memId, WS, campaignId, 'contact', bouncedId, accountId, 'excluded', db.now(), db.now()]);
    const contact = db.get(`SELECT c.*, a.name AS account_name FROM contacts c LEFT JOIN accounts a ON a.id = c.account_id WHERE c.id = ?`, [bouncedId]);
    const result = await outreach.enrollContacts(ctx, { campaignId: enrollCampaignId, contacts: [contact], mapping: {} });
    equal(result.results[0].result, 'skipped', 'skipped');
    if (!/bounced/i.test(result.results[0].reason)) throw new Error(`reason should mention bounce, got ${result.results[0].reason}`);
});

// ============================================================ mapping ===

describe('Field mapping');
check('mapToLead resolves system + custom fields', () => {
    const contact = { email: 'a@example.com', first_name: 'Ann', last_name: 'Lee', title: 'CEO', account_name: 'Acme', properties: JSON.stringify({ industry: 'SaaS' }) };
    const lead = outreach.mapToLead(contact, { company_name: 'account_name', custom: { job_title: 'title', industry: 'industry' } });
    equal(lead.email, 'a@example.com', 'email');
    equal(lead.company_name, 'Acme', 'company');
    equal(lead.custom_fields.job_title, 'CEO', 'job_title');
    equal(lead.custom_fields.industry, 'SaaS', 'industry');
});

// ============================================================ sync ===

describe('Reconciliation');
await checkAsync('syncCampaignLeads pages and updates external_key', async () => {
    let page = 0;
    const fetcher = async (url) => {
        page += 1;
        if (String(url).includes('campaigns/SL_999/leads') && page <= 3) {
            if (page === 1) return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ campaign_lead_map_id: 9001, status: 'INPROGRESS', lead: { email: enrollEmail } }], total_leads: '1', offset: 0, limit: 100 }) };
            // Passes 2 & 3 (replied/bounced filters) return empty
            return { ok: true, status: 200, text: async () => JSON.stringify({ data: [], total_leads: '0', offset: 0, limit: 100 }) };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: [], total_leads: '0', offset: 0, limit: 100 }) };
    };
    const campRow = db.get(`SELECT * FROM campaigns WHERE id = ?`, [enrollCampaignId]);
    await outreach.syncCampaignLeads(WS, campRow, { fetcher });
    const member = db.get(`SELECT * FROM campaign_members WHERE campaign_id = ? AND member_id = ?`, [enrollCampaignId, enrollContactId]);
    equal(member.external_key, '9001', 'external_key');
});

/**
 * The exact "insights are all zero" complaint: a campaign linked to
 * Smartlead where a lead exists on the Smartlead side but was never enrolled
 * from the CRM side, so it has no matching contact and no campaign_members
 * row. importLeadsFromSmartlead is the fix — it should create both, and
 * roll in that lead's real status/reply/bounce state in the same call.
 */
await checkAsync('importLeadsFromSmartlead creates the missing contact + membership, and backfills status', async () => {
    const importCampaignId = db.id('cmp');
    db.run(`INSERT INTO campaigns (id, workspace_id, key, name, status, channel, external_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        [importCampaignId, WS, 'import-test', 'Import Test', 'active', 'email', 'SL_IMPORT', db.now(), db.now()]);
    const strangerEmail = `stranger.${Date.now()}@example.com`;

    let call = 0;
    const fetcher = async (url) => {
        call += 1;
        // Call 1: the import's own full leads listing (unfiltered).
        if (call === 1) {
            return {
                ok: true, status: 200,
                text: async () => JSON.stringify({
                    data: [{ campaign_lead_map_id: 5551, status: 'INPROGRESS', lead: { email: strangerEmail, first_name: 'Sam', last_name: 'Stranger' } }],
                    total_leads: '1', offset: 0, limit: 100,
                }),
            };
        }
        // Calls 2-4: the reconcile passes importLeadsFromSmartlead triggers
        // afterward (all / replied / bounced) — report the same lead as replied.
        if (call === 3 && String(url).includes('is_replied')) {
            return {
                ok: true, status: 200,
                text: async () => JSON.stringify({
                    data: [{ campaign_lead_map_id: 5551, status: 'INPROGRESS', lead: { email: strangerEmail } }],
                    total_leads: '1', offset: 0, limit: 100,
                }),
            };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: [], total_leads: '0', offset: 0, limit: 100 }) };
    };

    const result = await outreach.importLeadsFromSmartlead(ctx, importCampaignId, { fetcher });
    equal(result.contactsCreated, 1, 'one contact created');
    equal(result.membersAdded, 1, 'one member added');

    const contact = db.get(`SELECT * FROM contacts WHERE workspace_id = ? AND lower(email) = lower(?)`, [WS, strangerEmail]);
    if (!contact) throw new Error('no contact created for the stranger lead');
    equal(contact.full_name, 'Sam Stranger', 'contact name from the lead');

    const member = db.get(`SELECT * FROM campaign_members WHERE campaign_id = ? AND member_id = ?`, [importCampaignId, contact.id]);
    if (!member) throw new Error('no membership created');
    equal(member.external_key, '5551', 'external_key carried over');
    if (!member.replied_at) throw new Error('reply from the same sweep should have backfilled replied_at');

    // Rerunning must not create a second contact or a second membership.
    call = 0;
    const result2 = await outreach.importLeadsFromSmartlead(ctx, importCampaignId, { fetcher });
    equal(result2.contactsCreated, 0, 're-import creates no new contact');
    equal(result2.alreadyMembers, 1, 're-import reports the existing membership');
});

// ============================================================ health ===

describe('Integration health');
check('integrationStatus returns linked campaigns + event counts', () => {
    const status = outreach.integrationStatus(WS);
    equal(status.configured, true, 'configured');
    if (status.campaignsLinked < 2) throw new Error(`expected >=2 linked, got ${status.campaignsLinked}`);
    if (typeof status.events.total !== 'number') throw new Error('no total');
});

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log(`  ${f}`); }
if (failed) process.exitCode = 1; else console.log('  All outreach checks passed.');

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
