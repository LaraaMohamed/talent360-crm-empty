/**
 * FULL-APP AUDIT - boots server.mjs against a throwaway DB and verifies
 * requirements by driving the REAL HTTP API with real sessions, then checks
 * the database directly. Behavior verification, not code inspection.
 *
 *   node verify-app.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-audit-'));
const PORT = 5199;
const BASE = 'http://127.0.0.1:' + PORT;
process.env.CRM_DB = path.join(TMP, 'app.db');
process.env.CRM_STORAGE = path.join(TMP, 'storage');

/* ---- seed workspace + one user of each role BEFORE boot (same migrate) ---- */
const db = await import('./lib/db.mjs');
const auth = await import('./lib/auth.mjs');
db.migrate();
const WS = db.id('wsp');
const stamp = Date.now();
db.run('INSERT INTO workspaces (id,name,base_currency,timezone,locale,weekend_days,verdict_stale_days,created_at) VALUES (?,?,?,?,?,?,?,?)',
    [WS, 'Audit', 'USD', 'UTC', 'en', '[5,6]', 180, db.now()]);
const U = {};
for (const [key, role] of [['owner','owner'],['admin','admin'],['manager','manager'],['rep','rep'],['sarah','sdr'],['sdr2','sdr']]) {
    U[key] = auth.createUser({ email: key+'-'+stamp+'@audit.local', name: key.toUpperCase(), password: 'audit-password-1', role, workspaceId: WS });
}
for (const [k,l,m] of [
    ['recruitment','Recruitment','placement_fee'], ['hcm','HCM','per_seat'],
    ['offshoring','Offshoring','per_headcount'], ['od','OD','fixed_fee'],
    ['training_team_building','Training & Team Building','fixed_fee'],
]) db.run('INSERT INTO service_lines (id,workspace_id,key,label,pricing_model,position) VALUES (?,?,?,?,?,0)', [db.id('svc'), WS, k, l, m]);
for (const t of ['call','email','meeting','linkedin','whatsapp','note']) {
    db.run('INSERT INTO activity_types (id,workspace_id,key,label,icon,color,manual,position) VALUES (?,?,?,?,?,?,0,0)',
        [db.id('aty'), WS, t, t[0].toUpperCase()+t.slice(1), 'dot', 'info']);
}
// Commercial pipeline with every stage the calling automation can target.
const PIPE = db.id('pip');
db.run('INSERT INTO pipelines (id,workspace_id,key,label,object_key,is_default,position,created_at) VALUES (?,?,?,?,?,1,0,?)', [PIPE, WS, 'commercial', 'Commercial', 'deal', db.now()]);
const STAGE = {}; let pos = 0;
for (const k of ['in_campaign','ready_to_call','interested','send_profile','follow_up','meeting_scheduled','proposal_preparing','proposal_sent','negotiation','won','lost']) {
    const type = k === 'won' ? 'won' : k === 'lost' ? 'lost' : 'open';
    STAGE[k] = db.id('stg');
    db.run('INSERT INTO stages (id,workspace_id,pipeline_id,key,label,position,probability,type,required_fields) VALUES (?,?,?,?,?,?,?,?,?)',
        [STAGE[k], WS, PIPE, k, k.replace(/_/g,' '), pos++, type==='won'?1:type==='lost'?0:0.05*pos, type, '[]']);
}
db.run('INSERT OR IGNORE INTO loss_reasons (id,workspace_id,key,label,position) VALUES (?,?,?,?,0)', [db.id('lsr'), WS, 'other', 'Other']);

/* ------------------------------------------------------------- helpers --- */
let passed = 0; const failed = []; let group = '';
function describe(g) { group = g; console.log('\n== ' + g); }
async function step(name, fn) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed.push(group + ' :: ' + name + ' :: ' + e.message); console.log('  FAIL ' + name + '\n       ' + e.message); }
}
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m??'mismatch')+'\n       expected '+JSON.stringify(b)+'\n       actual   '+JSON.stringify(a)); }
function assert(c, m) { if (!c) throw new Error(m ?? 'assertion failed'); }

const cookies = {};
async function api(as, method, p, body, opts = {}) {
    const res = await fetch(BASE + p, {
        method,
        headers: {
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(cookies[as] ? { cookie: cookies[as] } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual',
    });
    if (opts.full) return res;
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) { const err = new Error(method + ' ' + p + ' -> ' + res.status + ' ' + String(text).slice(0, 200)); err.status = res.status; throw err; }
    return json;
}

async function waitForServer(tries = 80) {
    for (let i = 0; i < tries; i++) {
        try { const r = await fetch(BASE + '/login', { redirect: 'manual' }); if (r.status < 500) return; } catch {}
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('server did not start');
}

/* ================================================================ boot === */
const child = spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SMARTLEAD_SYNC_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });
process.on('exit', () => { try { child.kill(); } catch {} });

await waitForServer();
console.log('server up on ' + BASE);

/* ------------------------------------------------------------- sessions -- */
async function login(as) {
    const res = await fetch(BASE + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: U[as].email, password: 'audit-password-1' }),
    });
    if (!res.ok) throw new Error('login ' + as + ' failed: ' + res.status);
    const setCookie = res.headers.get('set-cookie') ?? '';
    cookies[as] = setCookie.split(';')[0];
}
for (const as of Object.keys(U)) await login(as);

const dealStageKey = async (dealId) => {
    if (!dealId) return null;
    const meta = await api('owner', 'GET', '/api/meta');
    const d = await api('owner', 'GET', '/api/deals/' + dealId);
    const st = (meta.stages ?? []).find((s) => s.id === d.record.stage_id);
    return st?.key ?? null;
};

/* ===================================================== A. REP/SDR BLOCK == */
describe('A. Rep/SDR blocked from sourcing');
await step('rep GET /api/prospects -> 403', async () => {
    try { await api('rep', 'GET', '/api/prospects'); throw new Error('should have been refused'); }
    catch (e) { eq(e.status, 403, 'status'); }
});
await step('sdr GET /api/prospects -> 403 (confined)', async () => {
    try { await api('sarah', 'GET', '/api/prospects'); throw new Error('should have been refused'); }
    catch (e) { eq(e.status, 403, 'status'); }
});
await step('meta hides prospecting objects from rep', async () => {
    const meta = await api('rep', 'GET', '/api/meta');
    assert(!meta.objects.prospecting_company, 'prospecting_company present for rep');
    assert(!meta.capabilities['prospecting.read'], 'rep holds prospecting.read');
});
await step('manager keeps sourcing', async () => {
    const meta = await api('manager', 'GET', '/api/meta');
    assert(meta.capabilities['prospecting.read'], 'manager lost sourcing');
});

/* ========================================================= B/C. MY WORK == */
describe('B/C. SDR My Work + CRUD scoping');
let sdrTaskId = null;
await step('sdr creates a task (own scope)', async () => {
    const { record } = await api('sarah', 'POST', '/api/tasks', { title: 'SDR own task', priority: 'B', assignee_id: U.sarah.id });
    sdrTaskId = record.id;
    assert(sdrTaskId, 'no id');
});
await step('other SDR cannot read it', async () => {
    const list = await api('sdr2', 'GET', '/api/tasks');
    assert(!list.records.some((t) => t.id === sdrTaskId), 'leaked across SDRs');
});
await step('owner sees it in the global list', async () => {
    const list = await api('owner', 'GET', '/api/tasks');
    assert(list.records.some((t) => t.id === sdrTaskId), 'owner lost row');
});
await step('task edit + delete persist after re-read', async () => {
    await api('sarah', 'PATCH', '/api/tasks/' + sdrTaskId, { title: 'renamed by owner of it' });
    let one = await api('sarah', 'GET', '/api/tasks/' + sdrTaskId);
    eq(one.record.title, 'renamed by owner of it');
    // Confined roles cannot hard-delete (record.delete is deliberately not
    // theirs) — the product's delete for them is status=cancelled.
    await api('sarah', 'PATCH', '/api/tasks/' + sdrTaskId, { status: 'cancelled' });
    one = await api('sarah', 'GET', '/api/tasks/' + sdrTaskId);
    eq(one.record.status, 'cancelled');
});
await step('activities + notes lists answer for sdr', async () => {
    const a = await api('sarah', 'GET', '/api/activities');
    const n = await api('sarah', 'GET', '/api/notes');
    assert(Array.isArray(a.records) && Array.isArray(n.records));
});

/* ===================================================== D/E. FOLLOW-UP ==== */
describe('D/E. Follow-up automation & no-answer rule');
let followAssignment = null, contactFU = null;
await step('seed lead on Sarah queue', async () => {
    const accId = db.id('acc');
    db.run('INSERT INTO accounts (id,workspace_id,name,created_at,updated_at) VALUES (?,?,?,?,?)', [accId, WS, 'Northwind', db.now(), db.now()]);
    contactFU = db.id('con');
    db.run('INSERT INTO contacts (id,workspace_id,account_id,first_name,last_name,full_name,phone,owner_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [contactFU, WS, accId, 'Fiona', 'Green', 'Fiona Green', '+15550100', U.sarah.id, db.now(), db.now()]);
    const r = await api('manager', 'POST', '/api/calling/assign', { contactIds: [contactFU], assignedTo: U.sarah.id, priority: 'A' });
    eq(r.assigned, 1, 'assigned');
    followAssignment = db.get('SELECT * FROM calling_assignments WHERE contact_id=?', [contactFU]);
});
await step('follow_up outcome creates EXACTLY 4 tasks with correct spacing', async () => {
    const firstAt = new Date(Date.now() + 26 * 3600 * 1000).toISOString().slice(0, 16);
    await api('manager', 'POST', '/api/calling/assignments/' + followAssignment.id + '/call',
        { outcome: 'follow_up', note: 'start', followUpAt: firstAt });
    const tasks = db.all("SELECT * FROM tasks WHERE properties LIKE '%\"assignment_id\":\"' || ? || '\"%' ORDER BY created_at", [followAssignment.id])
        .sort((a, b) => a.due_at.localeCompare(b.due_at));
    eq(tasks.length, 4, 'four steps');
    // Step 2 same day end-of-day or next day (never before step 1)
    const t1 = new Date(tasks[0].due_at), t2 = new Date(tasks[1].due_at), t3 = new Date(tasks[2].due_at);
    assert(t2 > t1, 'step2 before step1');
    assert((t3 - t1) / 86400000 >= 6.9 && (t3 - t1) / 86400000 <= 7.1, 'step3 not exactly ~7 days after step1: ' + ((t3 - t1) / 86400000));
    // Notifications went to the assignee
    const bells = db.all("SELECT * FROM notifications WHERE user_id=? AND kind='task_assigned'", [U.sarah.id]);
    assert(bells.length >= 4, 'expected >=4 task bells, got ' + bells.length);
});
await step('completing all 4 marks the lead DEAD and stops the sequence', async () => {
    let tasks = db.all("SELECT * FROM tasks WHERE properties LIKE ? AND deleted_at IS NULL ORDER BY due_at", ['%"assignment_id":"' + followAssignment.id + '"%']);
    if (tasks.length !== 4) throw new Error('expected 4 sequence tasks, found ' + tasks.length + ' sample=' + JSON.stringify(db.get("SELECT properties FROM tasks WHERE properties LIKE '%assignment_id%' LIMIT 1")));
    for (const t of tasks) await api('sarah', 'PATCH', '/api/tasks/' + t.id, { status: 'done' });
    const a = db.get('SELECT * FROM calling_assignments WHERE id=?', [followAssignment.id]);
    assert(a.dead_at, 'lead not dead after 4th');
    tasks = db.all("SELECT * FROM tasks WHERE properties LIKE ? AND deleted_at IS NULL", ['%"assignment_id":"' + followAssignment.id + '"%']);
    const open = tasks.filter((t) => t.status === 'open' || t.status === 'in_progress');
    eq(open.length, 0, 'an open follow-up task survived completion');
});
await step('No Answer retires at THREE consecutive, conversation resets streak', async () => {
    const accId = db.id('acc'); db.run('INSERT INTO accounts (id,workspace_id,name,created_at,updated_at) VALUES (?,?,?,?,?)', [accId, WS, 'StreakCo', db.now(), db.now()]);
    const c = db.id('con'); db.run('INSERT INTO contacts (id,workspace_id,account_id,first_name,last_name,full_name,phone,owner_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [c, WS, accId, 'S', 'T', 'S T', '+15550111', U.sarah.id, db.now(), db.now()]);
    await api('manager', 'POST', '/api/calling/assign', { contactIds: [c], assignedTo: U.sarah.id });
    const asgId = db.get('SELECT id FROM calling_assignments WHERE contact_id=?', [c]).id;
    const call = (outcome) => api('sarah', 'POST', '/api/calling/assignments/' + asgId + '/call', { outcome });
    await call('no_answer'); await call('no_answer');
    await call('interested');            // conversation resets the streak
    const mid = db.get('SELECT * FROM calling_assignments WHERE id=?', [asgId]); eq(mid.no_answer_streak, 0);
    await call('no_answer'); await call('no_answer'); await call('no_answer');
    const dead = db.get('SELECT * FROM calling_assignments WHERE id=?', [asgId]);
    assert(dead.dead_at, 'not dead after 3 consecutive');
});


/* ============================================== F/S. CALLING -> PIPELINE = */
describe('F/S. Cold calling workflow -> pipeline + campaign');
let flowAcc = null, flowContact = null, flowAsgId = null, flowDealId = null;
await step('capture assignment + auto deal after assign (ready_to_call)', async () => {
    flowAcc = db.id('acc');
    db.run('INSERT INTO accounts (id,workspace_id,name,created_at,updated_at) VALUES (?,?,?,?,?)', [flowAcc, WS, 'FlowCo', db.now(), db.now()]);
    flowContact = db.id('con');
    db.run('INSERT INTO contacts (id,workspace_id,account_id,first_name,last_name,full_name,phone,owner_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [flowContact, WS, flowAcc, 'P', 'Q', 'P Q', '+15550200', U.sarah.id, db.now(), db.now()]);
    const r = await api('manager', 'POST', '/api/calling/assign', { contactIds: [flowContact], assignedTo: U.sarah.id });
    const deal = db.get('SELECT * FROM deals WHERE account_id=? AND deleted_at IS NULL', [flowAcc]);
    flowDealId = deal?.id ?? null; assert(flowDealId, 'no auto deal');
    flowAsgId = db.get('SELECT id FROM calling_assignments WHERE contact_id=?', [flowContact]).id;
    eq(await dealStageKey(flowDealId), 'ready_to_call', 'stage after assign');
});
for (const pair of [['interested','interested'],['send_profile','send_profile'],['follow_up','follow_up'],['meeting_scheduled','meeting_scheduled']]) {
    const outcome = pair[0], stage = pair[1];
    await step(outcome + ' -> ' + stage, async () => {
        const body = { outcome };
        if (outcome === 'follow_up') body.followUpAt = new Date(Date.now() + 30*3600e3).toISOString().slice(0,16);
        if (outcome === 'meeting_scheduled') body.meetingAt = new Date(Date.now() + 48*3600e3).toISOString().slice(0,16);
        await api('sarah', 'POST', '/api/calling/assignments/' + flowAsgId + '/call', body);
        eq(await dealStageKey(flowDealId), stage);
    });
}
let campaignId = null;
await step('campaign member contacted -> In campaign', async () => {
    campaignId = db.id('cmp');
    db.run("INSERT INTO campaigns (id,workspace_id,key,name,status,channel,created_at,updated_at) VALUES (?,?,?,'Camp Q1','active','email',?,?)", [campaignId, WS, 'camp'+stamp, db.now(), db.now()]);
    await api('manager', 'POST', '/api/campaigns/' + campaignId + '/members', { memberType: 'contact', ids: [flowContact] });
    await api('manager', 'PATCH', '/api/campaigns/' + campaignId + '/members', { memberType: 'contact', ids: [flowContact], status: 'contacted' });
    eq(await dealStageKey(flowDealId), 'in_campaign', 'stage after campaign contact');
});
await step('meeting done -> Proposal preparing chosen by user', async () => {
    // The booked meeting sits in the future; settle it to the past first, as
    // reality would, because a future meeting must never be markable done.
    db.run("UPDATE activities SET meeting_at = ? WHERE assignment_id = ? AND meeting_at IS NOT NULL", [new Date(Date.now() - 3600e3).toISOString(), flowAsgId]);
    await api('sarah', 'POST', '/api/calling/assignments/' + flowAsgId + '/call', { outcome: 'meeting_done', nextStep: 'proposal_preparing' });
    eq(await dealStageKey(flowDealId), 'proposal_preparing');
});

/* ================================================= H/P/K/I. DEAL SIZE ==== */
describe('H/P/K/I. Deal size approval, naming, recurrence');
let offDeal = null, offPeriodId = null;
await step('deal name auto-generates Company - Service', async () => {
    const accId = db.id('acc'); db.run('INSERT INTO accounts (id,workspace_id,name,billing_currency,created_at,updated_at) VALUES (?,?,?,?,?,?)', [accId, WS, 'SizeCo', 'USD', db.now(), db.now()]);
    const r = await api('rep', 'POST', '/api/deals', { account_id: accId, service_line_key: 'offshoring' });
    offDeal = r.record.id;
    assert(/SizeCo\s*-\s*Offshoring/.test(r.record.name), 'name was: ' + r.record.name);
});
await step('REP price change -> PENDING + tasks for manager AND admin', async () => {
    await api('rep', 'PUT', '/api/deals/' + offDeal + '/size', { price: 3000, count: 12, currency: 'USD', termMonths: 24 });
    const sizeNow = await api('owner', 'GET', '/api/deals/' + offDeal + '/size');
    assert(!(Number(sizeNow.size?.price) > 0), 'pending price leaked onto deal');
    const tasks = db.all("SELECT t.* FROM tasks t WHERE t.parent_type='deal_price' AND t.status='open' AND t.parent_id IN (SELECT id FROM deal_price_periods WHERE deal_id=?)", [offDeal]);
    assert(tasks.length >= 2, 'expected >=2 approver tasks, got ' + tasks.length);
    offPeriodId = db.get('SELECT id FROM deal_price_periods WHERE deal_id=? ORDER BY created_at DESC LIMIT 1', [offDeal]).id;
});
await step('MANAGER approves -> deal updates immediately, both tasks close', async () => {
    await api('manager', 'POST', '/api/deals/' + offDeal + '/price-periods/' + offPeriodId + '/review', { decision: 'approved' });
    const size = await api('owner', 'GET', '/api/deals/' + offDeal + '/size');
    eq(size.size.unitPrice, 3000, 'unit price per head');
    eq(size.size.count, 12, 'headcount');
    const deal = await api('owner', 'GET', '/api/deals/' + offDeal);
    eq(deal.record.value_mrr, 36000, 'MRR should be 12 x 3,000 monthly');
    const open = db.all("SELECT * FROM tasks WHERE parent_type='deal_price' AND status='open'");
    eq(open.length, 0, 'an approval task stayed open');
});
await step('price history shows the active period', async () => {
    const h = await api('owner', 'GET', '/api/deals/' + offDeal + '/price-history');
    assert(JSON.stringify(h).includes('"active"'), 'no active period in history payload');
});
await step('service billing types derive correctly', async () => {
    const meta = await api('rep', 'GET', '/api/meta');
    const by = Object.fromEntries(meta.serviceLines.map((s) => [s.key, s.billingType ?? s.billing_type]));
    eq(by.offshoring, 'recurring', 'offshoring');
    eq(by.hcm, 'recurring', 'hcm');
    for (const k of ['recruitment','od','training_team_building']) eq(by[k], 'one_time', k);
});

/* ================================================= L/M. AGREEMENT->DEAL == */
describe('L/M. Agreement finds/creates deal; sign -> won');
let agrId = null, agrDealId = null;
await step('agreement with no deal gets one automatically', async () => {
    const accId = db.get("SELECT id FROM accounts WHERE name='SizeCo'").id;
    const r = await api('owner', 'POST', '/api/agreements', { account_id: accId, title: 'Audit agreement', service_line_key: 'hcm', status: 'draft' });
    agrId = r.record.id; agrDealId = r.record.deal_id;
    assert(agrDealId, 'agreement created without a deal');
});
await step('signing agreement moves the deal to Deal Won', async () => {
    try { await api('owner', 'POST', '/api/agreements/' + agrId + '/sign', { effectiveDate: new Date().toISOString().slice(0,10) }); }
    catch (e) {
        if (/approv/i.test(e.message)) {
            try { await api('owner', 'POST', '/api/agreements/' + agrId + '/submit', {}); } catch {}
            try { await api('owner', 'POST', '/api/agreements/' + agrId + '/review', { decision: 'approved' }); } catch {}
            await api('owner', 'POST', '/api/agreements/' + agrId + '/sign', { effectiveDate: new Date().toISOString().slice(0,10) });
        } else { throw e; }
    }
    const d = await api('owner', 'GET', '/api/deals/' + agrDealId);
    eq(d.record.status, 'won', 'deal status after signing');
});

/* ==================================================== N/O. APPROVALS ===== */
describe('N/O. Proposal approval tasks + notifications');
await step('submit proposal -> manager+admin tasks linking doc + bells', async () => {
    const accId = db.get("SELECT id FROM accounts WHERE name='Northwind'").id;
    const pr = await api('rep', 'POST', '/api/proposals', { accountId: accId, title: 'Audit proposal' });
    await api('rep', 'POST', '/api/proposals/' + pr.proposal.id + '/submit', {});
    const tasks = db.all('SELECT * FROM tasks WHERE parent_type=\'proposal\' AND parent_id=?', [pr.proposal.id]);
    assert(tasks.length >= 2, 'expected >=2 approver tasks, got ' + tasks.length);
    const bells = db.all("SELECT * FROM notifications WHERE kind='approval_requested' AND link LIKE '%/proposals/%'");
    assert(bells.length >= 2, 'approval notifications missing');
});

/* ============================================ Q/U/X/R. DATA FLOWS ======== */
describe('Q. Import existing deals into forecasting');
await step('CSV deal lands priced and forecastable', async () => {
    const csvText = 'External ID,Account Name,Deal Name,Service,Currency,Price,Headcount,Term Months\nAUD-1,Northwind,Audit Offshore,offshoring,SAR,2500,10,12';
    const p2 = await fetch(BASE + '/api/import/profile?object=deal', { method: 'POST', headers: { 'Content-Type': 'text/csv', cookie: cookies.owner }, body: csvText });
    if (!p2.ok) throw new Error('profile ' + p2.status + ' ' + (await p2.text()).slice(0,150));
    const profile = await p2.json();
    const ex = await fetch(BASE + '/api/import/execute?object=deal', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: cookies.owner }, body: JSON.stringify({ text: csvText, mapping: profile.mapping, duplicateStrategy: 'update', filename: 'audit.csv' }) });
    const run = await ex.json();
    const created = run.counts?.create ?? 0;
    if (created !== 1) throw new Error('import create count ' + created + ' full=' + JSON.stringify(run).slice(0, 400));
    const dealRow = db.get("SELECT * FROM deals WHERE external_id='AUD-1'");
    assert(dealRow, 'imported deal missing');
    assert(Number(dealRow.value_mrr) > 0, 'not forecastable, mrr=' + dealRow.value_mrr);
});

describe('U. Sourcing -> CRM is a MOVE');
await step('qualified prospect imports then leaves sourcing', async () => {
    const pid = db.id('pco');
    db.run('INSERT INTO prospecting_companies (id,workspace_id,name,domain,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [pid, WS, 'MoveCo Ltd', 'moveco.example', 'qualified', U.owner.id, db.now(), db.now()]);
    const pc = db.id('pct');
    db.run('INSERT INTO prospecting_contacts (id,workspace_id,prospect_id,first_name,last_name,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [pc, WS, pid, 'Mo', 'Ved', 'mo@moveco.example', db.now(), db.now()]);
    await api('owner', 'POST', '/api/prospects/import-preview', { ids: [pid] });
    await api('owner', 'POST', '/api/prospects/import', { ids: [pid] });
    const row = db.get('SELECT * FROM prospecting_companies WHERE id=?', [pid]);
    eq(row.status, 'imported', 'status'); assert(row.deleted_at, 'still visible in sourcing');
    const acc = db.get("SELECT * FROM accounts WHERE name LIKE 'MoveCo%' AND deleted_at IS NULL");
    assert(acc, 'CRM account not created');
});

describe('X. Select All means ALL matching');
await step('120 contacts matched by all:true filter', async () => {
    for (let i = 0; i < 120; i++) {
        const cid = db.id('con');
        db.run('INSERT INTO contacts (id,workspace_id,first_name,last_name,full_name,data_source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
            [cid, WS, 'Bulk', String(i), 'Bulk ' + i, 'audit-bulk', db.now(), db.now()]);
    }
    const bulk = await api('owner', 'POST', '/api/contacts/bulk', { action: 'update', values: { data_source: 'audit-bulk' }, all: true, filter: { field: 'data_source', operator: 'is', value: 'audit-bulk' }, preview: true });
    assert(bulk.requested >= 120, 'requested only ' + bulk.requested);
});

await step('settings tabs served', async () => {
    const js = await fetch(BASE + '/js/pages/settings.js').then((r) => r.text());
    const wanted = ['general', 'revenue', 'scoring', 'integrations', 'people', 'documents', 'data'];
    for (const k of wanted) assert(js.includes("'" + k + "'"), 'missing section ' + k);
});

describe('AA. Deal close-date preset filter');
await step('between filter changes backend results', async () => {
    const accId = db.get("SELECT id FROM accounts WHERE name='SizeCo'").id;
    const mk = async (name, days) => {
        const r = await api('rep', 'POST', '/api/deals', { account_id: accId, service_line_key: 'recruitment' });
        await api('rep', 'PATCH', '/api/deals/' + r.record.id, { name, close_date: new Date(Date.now() + days * 864e5).toISOString().slice(0, 10) });
        return r.record.id;
    };
    const soon = await mk('Audit closes soon', 5);
    const far = await mk('Audit closes later', 200);
    const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const nextMonth = new Date(monthStart); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const filter = { op: 'and', children: [{ field: 'close_date', operator: 'between', value: [monthStart.toISOString(), nextMonth.toISOString()] }] };
    const list = await api('owner', 'GET', '/api/deals?filter=' + encodeURIComponent(JSON.stringify(filter)));
    const ids = list.records.map((r) => r.id);
    assert(ids.includes(soon), 'this-month deal missing from between-filter');
    assert(!ids.includes(far), 'next-year deal leaked into between-filter');
});

describe('R + served assets');
await step('queue items expose service_line_key on every tab', async () => {
    const q = await api('owner', 'GET', '/api/calling/queue?tab=to_call');
    assert(q.items.every((i) => 'service_line_key' in i), 'service key absent');
    const done = await api('owner', 'GET', '/api/calling/queue?tab=completed');
    assert(Array.isArray(done.items), 'completed tab failed');
});
await step('record page ships dateInput component', async () => {
    const rec = await fetch(BASE + '/js/pages/record.js').then((r) => r.text());
    assert(rec.includes('dateInput'), 'dateInput missing');
});

child.kill();
console.log('==================== AUDIT SUMMARY ====================');
console.log('passed: ' + passed + '   failed: ' + failed.length);
if (failed.length) { console.log('FAILURES:'); failed.forEach((f) => console.log('  - ' + f)); process.exitCode = 1; }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
