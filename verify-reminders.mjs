import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-reminders-verify-'));
process.env.CRM_DB = path.join(TMP, 'test.db');
process.env.CRM_STORAGE = path.join(TMP, 'storage');

const db = await import('./lib/db.mjs');
const auth = await import('./lib/auth.mjs');
const repo = await import('./lib/repo.mjs');
const reminders = await import('./lib/reminders.mjs');

let passed = 0, failed = 0;
const failures = [];
function check(name, fn) {
    try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
    catch (e) { failed += 1; failures.push(`${name}\n      ${e.message}`); console.log(`  ✗ ${name}\n    ${e.message}`); }
}
function equal(a, b, msg) {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg ?? 'not equal'}\n      expected ${JSON.stringify(b)}\n      actual   ${JSON.stringify(a)}`);
}

db.migrate();
const WS = db.id('wsp');
db.run(`INSERT INTO workspaces (id, name, base_currency, timezone, locale, weekend_days, verdict_stale_days, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    [WS, 'Test', 'SAR', 'Asia/Riyadh', 'en', '[5,6]', 180, db.now()]);
const rep = auth.createUser({ email: `rep-${Date.now()}@test.local`, name: 'Rep', password: 'test-password-1', role: 'rep', workspaceId: WS });
const ctx = { workspaceId: WS, userId: rep.id, role: 'rep', user: { id: rep.id, name: 'Rep' }, workspace: { id: WS, baseCurrency: 'SAR', timezone: 'Asia/Riyadh', verdictStaleDays: 180, name: 'Test' } };

const account = repo.createRecord('account', ctx, { name: 'Reminder Co' });
const contact = repo.createRecord('contact', ctx, { first_name: 'Rana', last_name: 'Test', data_source: 'x', account_id: account.id });

const past = new Date(Date.now() - 60_000).toISOString();
const future = new Date(Date.now() + 3600_000).toISOString();

check('a task due in the past gets exactly one reminder', () => {
    const taskId = db.id('tsk');
    db.run(
        `INSERT INTO tasks (id, workspace_id, parent_type, parent_id, title, assignee_id, due_at, priority, status, properties, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [taskId, WS, 'contact', contact.id, 'Call back', rep.id, past, 'A', 'open', '{}', db.now(), db.now()],
    );
    const result = reminders.sweepReminders(WS);
    equal(result.tasksReminded, 1, 'one task reminded');
    const notified = db.get('SELECT * FROM notifications WHERE workspace_id = ? AND user_id = ? AND kind = ?', [WS, rep.id, 'task_due']);
    if (!notified) throw new Error('no notification written');

    // Idempotent: a second sweep must not re-notify the same task.
    const again = reminders.sweepReminders(WS);
    equal(again.tasksReminded, 0, 'not reminded twice');
    const count = db.get('SELECT COUNT(*) AS n FROM notifications WHERE workspace_id = ? AND kind = ?', [WS, 'task_due']);
    equal(count.n, 1, 'exactly one notification exists, ever');
});

check('a task due in the future is left alone', () => {
    const taskId = db.id('tsk');
    db.run(
        `INSERT INTO tasks (id, workspace_id, parent_type, parent_id, title, assignee_id, due_at, priority, status, properties, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [taskId, WS, 'contact', contact.id, 'Future task', rep.id, future, 'A', 'open', '{}', db.now(), db.now()],
    );
    const result = reminders.sweepReminders(WS);
    equal(result.tasksReminded, 0, 'nothing due yet');
    equal(db.get('SELECT reminder_sent_at FROM tasks WHERE id = ?', [taskId]).reminder_sent_at, null, 'unstamped');
});

check('a done task is never reminded, even if its due date has passed', () => {
    const taskId = db.id('tsk');
    db.run(
        `INSERT INTO tasks (id, workspace_id, parent_type, parent_id, title, assignee_id, due_at, priority, status, properties, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [taskId, WS, 'contact', contact.id, 'Already done', rep.id, past, 'A', 'done', '{}', db.now(), db.now()],
    );
    const before = db.get('SELECT COUNT(*) AS n FROM notifications WHERE workspace_id = ?', [WS]).n;
    reminders.sweepReminders(WS);
    const after = db.get('SELECT COUNT(*) AS n FROM notifications WHERE workspace_id = ?', [WS]).n;
    equal(after, before, 'no new notification for a task already done');
});

check('an unassigned task due in the past is skipped, not crashed on', () => {
    const taskId = db.id('tsk');
    db.run(
        `INSERT INTO tasks (id, workspace_id, parent_type, parent_id, title, assignee_id, due_at, priority, status, properties, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [taskId, WS, 'contact', contact.id, 'Nobody owns this', null, past, 'A', 'open', '{}', db.now(), db.now()],
    );
    const result = reminders.sweepReminders(WS);
    equal(result.tasksReminded, 0, 'unassigned work has nobody to remind');
});

check('a scheduled meeting whose start time has arrived gets exactly one reminder', () => {
    const actId = db.id('act');
    db.run(
        `INSERT INTO activities (id, workspace_id, parent_type, parent_id, type_key, subject, occurred_at, actor_id, source, properties, meeting_at, meeting_status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [actId, WS, 'contact', contact.id, 'call', 'Meeting booked', db.now(), rep.id, 'ui', '{}', past, 'scheduled', db.now(), db.now()],
    );
    const result = reminders.sweepReminders(WS);
    equal(result.meetingsReminded, 1, 'one meeting reminded');
    const notified = db.get('SELECT * FROM notifications WHERE workspace_id = ? AND user_id = ? AND kind = ?', [WS, rep.id, 'meeting_due']);
    if (!notified) throw new Error('no notification written');

    const again = reminders.sweepReminders(WS);
    equal(again.meetingsReminded, 0, 'not reminded twice');
});

check('a meeting already done or no-show is never reminded', () => {
    const actId = db.id('act');
    db.run(
        `INSERT INTO activities (id, workspace_id, parent_type, parent_id, type_key, subject, occurred_at, actor_id, source, properties, meeting_at, meeting_status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [actId, WS, 'contact', contact.id, 'call', 'Old meeting', db.now(), rep.id, 'ui', '{}', past, 'done', db.now(), db.now()],
    );
    const before = db.get('SELECT COUNT(*) AS n FROM notifications WHERE workspace_id = ? AND kind = ?', [WS, 'meeting_due']).n;
    reminders.sweepReminders(WS);
    const after = db.get('SELECT COUNT(*) AS n FROM notifications WHERE workspace_id = ? AND kind = ?', [WS, 'meeting_due']).n;
    equal(after, before, 'no reminder for a meeting that already happened');
});

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log(`  ${f}`); process.exit(1); }
console.log('  All reminder checks passed.');
