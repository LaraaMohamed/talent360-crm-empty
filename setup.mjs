/**
 * First-run setup: create the database, seed a workspace, make an admin.
 *
 *   node setup.mjs
 *   node setup.mjs --email you@example.com --password "something long"
 *
 * Safe to re-run: it only ever ADDS missing configuration. Existing rows are
 * left alone, so a workspace that has renamed a stage or edited a view does not
 * lose that work when setup runs again.
 */
import crypto from 'node:crypto';
import { migrate, get, run, all, id, now, close, DB_FILE } from './lib/db.mjs';
import { createUser } from './lib/auth.mjs';
import { loadEngines } from './lib/qualification.mjs';
import { seedViews } from './lib/seed-views.mjs';
import { DEFAULT_DASHBOARD } from './api/dashboard.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const WORKSPACE_NAME = arg('workspace', 'Talent 360');
const ADMIN_EMAIL = arg('email', 'business-growth@talent-360.me');
const ADMIN_NAME = arg('name', 'Admin');
const GENERATED = crypto.randomBytes(9).toString('base64url');
const ADMIN_PASSWORD = arg('password', GENERATED);

migrate();

let workspace = get('SELECT * FROM workspaces LIMIT 1');
if (!workspace) {
    const wsId = id('wsp');
    run(
        `INSERT INTO workspaces (id, name, base_currency, timezone, locale, weekend_days, verdict_stale_days, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [wsId, WORKSPACE_NAME, 'SAR', 'Asia/Riyadh', 'en', '[5,6]', 180, now()],
    );
    workspace = get('SELECT * FROM workspaces WHERE id = ?', [wsId]);
    console.log(`  workspace          ${workspace.name}`);
}

const WS = workspace.id;

/* ------------------------------------------------------------------ admin -- */

let admin = get('SELECT * FROM users WHERE email = ?', [ADMIN_EMAIL.toLowerCase()]);
let printedPassword = null;
if (!admin) {
    admin = createUser({
        email: ADMIN_EMAIL, name: ADMIN_NAME, password: ADMIN_PASSWORD, role: 'owner', workspaceId: WS,
    });
    printedPassword = ADMIN_PASSWORD;
    console.log(`  admin              ${admin.email}`);
} else if (!get('SELECT id FROM memberships WHERE workspace_id = ? AND user_id = ?', [WS, admin.id])) {
    run('INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES (?,?,?,?,?)',
        [id('mem'), WS, admin.id, 'owner', now()]);
}

const ACTOR = { workspaceId: WS, userId: admin.id, role: 'owner' };

/* ------------------------------------------------------------ seed helper -- */

function seed(table, uniqueWhere, params, row) {
    const existing = get(`SELECT * FROM ${table} WHERE ${uniqueWhere}`, params);
    if (existing) return existing;
    const keys = Object.keys(row);
    run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => row[k]));
    return get(`SELECT * FROM ${table} WHERE ${uniqueWhere}`, params);
}

/* -------------------------------------------------------------- pipelines -- */

// Two pipelines from the start, because recruitment and managed services
// genuinely have different shapes. Forcing them into one is why consultancies
// abandon generic CRMs.
const PIPELINES = [
    /**
     * The commercial pipeline — the one the dashboard reports on.
     *
     * ── A NOTE ON THE EARLY STAGES ──────────────────────────────────────────
     * The first six stages are OUTREACH states, not opportunities: a company
     * "In campaign" has not agreed to anything. They carry probability 0 on
     * purpose, so they appear on the board without inflating the weighted
     * forecast, and `win_rate` counts only closed deals so they never enter
     * that denominator either. Without both of those, adding a cold list to a
     * campaign would visibly "grow pipeline" and quietly sink the win rate.
     */
    {
        key: 'commercial',
        label: 'Commercial',
        isDefault: 1,
        stages: [
            ['in_campaign', 'In campaign', 0, 'open', []],
            ['ready_to_call', 'Ready to cold call', 0, 'open', []],
            ['interested', 'Interested', 0, 'open', []],
            ['send_profile', 'Send profile', 0, 'open', []],
            ['follow_up', 'Follow up', 0, 'open', []],
            ['meeting_scheduled', 'Meeting scheduled', 10, 'open', []],
            ['proposal_preparing', 'Proposal preparing', 30, 'open', []],
            ['proposal_sent', 'Proposal sent', 50, 'open', ['close_date']],
            ['negotiation', 'Negotiation', 70, 'open', []],
            ['contracting', 'Contracting', 85, 'open', []],
            ['kickoff', 'Kickoff', 95, 'open', []],
            // The two terminals, adjacent. "Agreement sent" used to sit
            // between Negotiation and the win; it was removed because the state
            // it described — a contract out for signature — is already an
            // `agreement` record moving from issued to signed, and signing is
            // what moves the deal into Deal Won (api/proposals.mjs). A stage
            // that mirrors another object's status is two places to update and
            // two places to disagree.
            ['won', 'Deal Won', 100, 'won', []],
            ['lost', 'Deal Lost', 0, 'lost', []],
            // Last, after both terminals — not a step on the way to Won, but a
            // parking spot a deal can be pulled into (and back out of) from
            // anywhere in the pipeline, so it reads as the exception column
            // rather than sitting mid-flow.
            ['on_hold', 'On hold', 0, 'open', []],
        ],
    },
    /*
     * ONE pipeline, on purpose.
     *
     * There were three — Commercial, Recruitment, and Managed services (HCM /
     * Offshoring) — which presented three STAGE FLOWS as though they were three
     * kinds of business. They are different questions. What this company sells
     * is OD, Recruitment, HCM and Offshoring, those are service lines, and
     * every deal already carries one; with the sale encoded in the pipeline,
     * "show me the OD deals" was a question the board could not be asked and a
     * Recruitment deal could never appear beside an HCM one.
     *
     * The board is sliced by service now (api/deals.mjs), and the other two
     * flows were subsets of Commercial's arc under different names. A workspace
     * that still has them is collapsed by apply-single-deal-pipeline.mjs, which
     * maps every retired stage onto a surviving one by name and refuses to
     * write if it meets one it does not recognise.
     */
];

for (const [pi, p] of PIPELINES.entries()) {
    const pipeline = seed('pipelines', 'workspace_id = ? AND key = ?', [WS, p.key], {
        id: id('pip'), workspace_id: WS, key: p.key, label: p.label, object_key: 'deal',
        is_default: p.isDefault, position: pi, created_at: now(),
    });
    for (const [si, [key, label, probability, type, required]] of p.stages.entries()) {
        seed('stages', 'pipeline_id = ? AND key = ?', [pipeline.id, key], {
            id: id('stg'), workspace_id: WS, pipeline_id: pipeline.id, key, label,
            position: si, probability: probability / 100, type,
            required_fields: JSON.stringify(required), wip_limit: null,
        });
    }
}

/* --------------------------------------------------------- activity types -- */

// Seed data, not enum members in code. A workspace adding its own type writes
// no code — it adds a row here.
const ACTIVITY_TYPES = [
    ['call', 'Call', 'phone', 'info'],
    ['email', 'Email', 'mail', 'info'],
    ['meeting', 'Meeting', 'calendar', 'accent'],
    ['linkedin', 'LinkedIn message', 'linkedin', 'accent'],
    ['whatsapp', 'WhatsApp', 'chat', 'success'],
    ['proposal_sent', 'Proposal sent', 'doc', 'accent'],
    // Kickoff, where Site visit used to be — and last in the arc rather than
    // sixth. Going to the client's premises was never a step this business
    // takes; handing a signed deal to delivery is. Existing workspaces are
    // moved by apply-kickoff-activity-type.mjs, which RENAMES the row so the
    // activities already logged against it keep their history.
    ['kickoff', 'Kickoff', 'flag', 'success'],
    ['note', 'Logged note', 'note', 'info'],
];
ACTIVITY_TYPES.forEach(([key, label, icon, color], i) => {
    seed('activity_types', 'workspace_id = ? AND key = ?', [WS, key], {
        id: id('aty'), workspace_id: WS, key, label, icon, color, manual: 1, position: i,
    });
});

/* ----------------------------------------------------------- service lines -- */

const pipelineId = (key) => get('SELECT id FROM pipelines WHERE workspace_id = ? AND key = ?', [WS, key])?.id ?? null;

const SERVICE_LINES = [
    ['recruitment', 'Recruitment', 'placement_fee', null],
    ['hcm', 'HCM', 'per_seat', 'hcm'],
    ['offshoring', 'Offshoring', 'per_headcount', 'offshoring'],
    // OD, not "Strategy & Performance": the business sells four services and
    // the service line was renamed across the board by apply-od-service.mjs;
    // a fresh one starts where they ended up.
    ['od', 'OD', 'fixed_fee', null],
    // Training and team building joined the book as ONE service — the
    // business quotes and delivers them together, not as two separate
    // line items a client picks between. Project work like OD and
    // Recruitment, so it is quoted ONCE, not per month like HCM and
    // Offshoring. `pricing_model` is what the money engine reads, so
    // `fixed_fee` here is the whole of the recurrence rule.
    ['training_team_building', 'Training & Team Building', 'fixed_fee', null],
    // Not a priced engagement like the others — a tag for accounts/contacts
    // that are partners rather than paying clients of a specific service.
    // `fixed_fee` for the same reason as OD: nothing per-seat or
    // per-headcount to compute if it ever ends up on a deal.
    ['partner', 'Partner', 'fixed_fee', null],
];
SERVICE_LINES.forEach(([key, label, model, ruleKey], i) => {
    seed('service_lines', 'workspace_id = ? AND key = ?', [WS, key], {
        id: id('svc'), workspace_id: WS, key, label, pricing_model: model, rule_key: ruleKey, position: i,
    });
});

const LOSS_REASONS = [
    ['price', 'Price'],
    ['timing', 'Timing / no budget now'],
    ['competitor', 'Went with a competitor'],
    ['in_house', 'Decided to do it in house'],
    ['no_decision', 'No decision made'],
    ['unresponsive', 'Went quiet'],
    ['bad_fit', 'Not a fit after all'],
];
LOSS_REASONS.forEach(([key, label], i) => {
    seed('loss_reasons', 'workspace_id = ? AND key = ?', [WS, key], {
        id: id('lrs'), workspace_id: WS, key, label, position: i,
    });
});

/* ----------------------------------------------------- qualification rules -- */

// Seeded from the engine's own DEFAULTS, so the CRM's version 1 of each rule is
// by construction identical to what the command line runs today. If those
// defaults ever change, this seed follows automatically instead of drifting.
const engines = await loadEngines();
for (const key of ['hcm', 'offshoring']) {
    const engine = engines[key];
    const existing = get('SELECT * FROM qualification_rules WHERE workspace_id = ? AND key = ?', [WS, key]);
    if (existing) continue;
    run(
        `INSERT INTO qualification_rules
           (id, workspace_id, key, label, engine, claim_type, version, summary, config, active, created_at, created_by)
         VALUES (?,?,?,?,?,?,1,?,?,1,?,?)`,
        [
            id('rul'), WS, key, engine.label, engine.engineId, engine.claimType,
            engine.summary, JSON.stringify(engine.defaults), now(), admin.id,
        ],
    );
    console.log(`  rule               ${key} v1 — ${engine.summary}`);
}

/* ------------------------------------------------------------------ views -- */

// The view definitions live in lib/seed-views.mjs so that shipping a new system
// view reaches databases that already exist, not only fresh installs.
const addedViews = seedViews(WS);
console.log(`  views              ${addedViews} seeded`);

/* -------------------------------------------------------------- dashboard -- */

if (!get('SELECT id FROM dashboards WHERE workspace_id = ? AND is_default = 1', [WS])) {
    run(
        'INSERT INTO dashboards (id, workspace_id, name, layout, owner_id, scope, is_default, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)',
        [
            id('dsh'), WS, 'Overview',
            /**
             * The default dashboard reports the COMMERCIAL pipeline.
             *
             * Qualification is preprocessing and is represented here by one
             * intake strip, not by three widgets of verdicts. The detail lives
             * on the Qualification page, where it is worked. A dashboard whose
             * top half is verdicts answers "how is the data cleaning going?" —
             * which is not the question anyone opens a CRM dashboard to ask.
             */
            JSON.stringify(DEFAULT_DASHBOARD),
            null, 'workspace', now(), now(),
        ],
    );
}

/* ------------------------------------------------------------ custom field -- */

// One example custom field, so the metadata path is exercised from the first
// run rather than the first time someone needs it.
if (!get('SELECT id FROM field_defs WHERE workspace_id = ? AND object_key = ? AND key = ?', [WS, 'account', 'priority_tier'])) {
    run(
        `INSERT INTO field_defs (id, workspace_id, object_key, key, label, type, options, required, filterable, sortable, searchable, is_system, help, position, created_at)
         VALUES (?,?,?,?,?,?,?,0,1,1,0,0,?,0,?)`,
        [
            id('fld'), WS, 'account', 'priority_tier', 'Priority tier', 'select',
            JSON.stringify(['A', 'B', 'C']),
            'An example custom field. It appears in the list, the form, the filter builder and the API with no code change.',
            now(),
        ],
    );
}

/* ------------------------------------------------------------------ done -- */

const counts = {
    accounts: get('SELECT COUNT(*) n FROM accounts').n,
    views: get('SELECT COUNT(*) n FROM views').n,
    rules: all('SELECT DISTINCT key FROM qualification_rules').length,
};

console.log('');
console.log('  Setup complete.');
console.log(`  database           ${DB_FILE}`);
console.log(`  views              ${counts.views}`);
console.log(`  rules              ${counts.rules}`);
console.log(`  accounts           ${counts.accounts}`);
if (printedPassword) {
    console.log('');
    console.log('  ────────────────────────────────────────────────');
    console.log(`   Sign in with   ${ADMIN_EMAIL}`);
    console.log(`   Password       ${printedPassword}`);
    console.log('  ────────────────────────────────────────────────');
    console.log('   This is shown once. Only its scrypt hash is stored.');
}
console.log('');
console.log('  Next:  node import-snapshots.mjs      bring in the collected companies');
console.log('         npm start                      open http://127.0.0.1:5180');
console.log('');

close();
