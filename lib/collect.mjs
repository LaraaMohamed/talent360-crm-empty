/**
 * Collecting evidence for ONE company, on demand.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Re-qualifying is free and offline: it re-runs the rules over evidence that is
 * already stored. That is invariant I1, and it is why re-qualifying 223
 * companies takes seconds. But it has a dead end. A company with no evidence
 * qualifies to UNRESOLVED with the reason "no evidence has been collected for
 * this prospect yet" — and there was nothing in the product that could act on
 * that sentence. The only way to get evidence was the Qualifier page: build a
 * CSV, upload it, collect the whole batch. For one company somebody is looking
 * at right now, that is not a path anybody takes.
 *
 * So: collect this one, now.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 * It does not scrape anything itself. `local-scraper/scrape.mjs` is the
 * collector — the persistent browser profile, the sign-in wait, the 4–9 second
 * pacing, the panel reading and the resumable writes are all its, and they are
 * the parts that took the longest to get right. This module chooses a slug,
 * runs that script for it, and turns what comes back into an evidence row.
 * Reimplementing collection here would be a second collector that drifts from
 * the first, which is the same mistake as copying the rule files.
 *
 * ── TWO SOURCES, IN ORDER ───────────────────────────────────────────────────
 * `snapshots.json` is checked FIRST. If this company was collected before —
 * during a batch run, or by somebody at the terminal — the evidence already
 * exists on disk and is free to adopt. Opening a browser to re-fetch a page we
 * already have would cost a minute, spend rate limit budget against LinkedIn,
 * and produce the same answer. Only a company nobody has collected is fetched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { get, id, now } from './db.mjs';
import { badRequest } from './http.mjs';
import { QUALIFIER_DIR } from './qualifier-ui.mjs';
import { SNAPSHOTS_FILE, recordEvidence, latestEvidence, qualifySubject, activeRules } from './qualification.mjs';

const SUBJECT_TABLES = {
    account: { table: 'accounts', label: 'account' },
    prospect: { table: 'prospecting_companies', label: 'prospecting company' },
};

/** How long one company is given before the job is declared stuck. */
const TIMEOUT_MS = Number(process.env.CRM_COLLECT_TIMEOUT_MS) || 12 * 60 * 1000;

export function scraperInstalled() {
    return fs.existsSync(path.join(QUALIFIER_DIR, 'scrape.mjs'));
}

function readSnapshots() {
    try {
        if (!fs.existsSync(SNAPSHOTS_FILE)) return {};
        return JSON.parse(fs.readFileSync(SNAPSHOTS_FILE, 'utf8'));
    } catch {
        // A malformed snapshots file is not a reason to refuse to collect; it
        // just means there is nothing to adopt from it.
        return {};
    }
}

/**
 * The LinkedIn slug this subject is identified by.
 *
 * Accepts a full URL as well as a bare slug, because that is what ends up in
 * the column after a CSV import, and refusing it would be pedantry about a
 * value the collector itself normalises.
 */
export function slugFor(subject) {
    const raw = String(subject.linkedin_slug ?? '').trim();
    if (!raw) return null;
    return raw
        .replace(/^https?:\/\/(www\.)?linkedin\.com\/company\//i, '')
        .replace(/\/.*$/, '')
        .trim() || null;
}

/* -------------------------------------------------------------------- jobs -- */

/**
 * In memory, deliberately.
 *
 * A collection is a live browser session belonging to one person watching one
 * screen. It cannot survive a restart in any meaningful sense — the child
 * process does not — so persisting the job row would only create records that
 * claim to be running when nothing is.
 */
const jobs = new Map();

function newJob(fields) {
    const job = {
        id: id('col'),
        status: 'running',
        startedAt: now(),
        finishedAt: null,
        log: [],
        error: null,
        result: null,
        ...fields,
    };
    jobs.set(job.id, job);
    // Old jobs are dropped once there are plenty, so a long-lived server does
    // not accumulate them. The cap is generous; this is one user, one browser.
    if (jobs.size > 50) {
        const oldest = [...jobs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
        if (oldest && oldest.status !== 'running') jobs.delete(oldest.id);
    }
    return job;
}

function note(job, line) {
    const text = String(line).trim();
    if (!text) return;
    job.log.push(text);
    if (job.log.length > 60) job.log.shift();
    // The sign-in prompt is the one line the person watching has to act on, so
    // it is promoted out of the log rather than left to be spotted in it.
    if (/SIGN IN/i.test(text)) job.needsSignIn = true;
    if (/Signed in\./i.test(text)) job.needsSignIn = false;
}

export function jobStatus(jobId) {
    const job = jobs.get(jobId);
    if (!job) throw badRequest('That collection is no longer being tracked. Start it again.');
    return {
        id: job.id,
        status: job.status,
        subjectType: job.subjectType,
        subjectId: job.subjectId,
        slug: job.slug,
        needsSignIn: !!job.needsSignIn,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        error: job.error,
        result: job.result,
        log: job.log.slice(-12),
    };
}

/* --------------------------------------------------------------- collection -- */

/**
 * Starts a collection and returns the job immediately.
 *
 * It returns rather than awaits because collecting one company means launching
 * a browser, possibly waiting for somebody to sign in, and reading three pages
 * with deliberate pauses between them. Holding an HTTP request open for that is
 * how a request times out halfway through and leaves a browser running with
 * nothing watching it.
 */
export function startCollection(ctx, subjectType, subjectId, { force = false } = {}) {
    const info = SUBJECT_TABLES[subjectType];
    if (!info) throw badRequest(`Unknown subject type "${subjectType}".`);

    const subject = get(`SELECT * FROM ${info.table} WHERE id = ? AND workspace_id = ?`, [subjectId, ctx.workspaceId]);
    if (!subject) throw badRequest(`That ${info.label} does not exist.`);

    const slug = slugFor(subject);
    if (!slug) {
        throw badRequest(
            `${subject.name ?? 'That company'} has no LinkedIn slug, so there is no identity to collect against. `
            + 'Add its LinkedIn company URL first — the collector reads the company\'s own /people/ page, and the '
            + 'slug is how it finds it.',
        );
    }

    if (!force && latestEvidence(ctx.workspaceId, subjectId, subjectType)) {
        throw badRequest(
            'This company already has evidence. Re-qualifying evaluates the rules against it, which is free and '
            + 'offline — collecting again would spend a browser session to fetch a page that is already stored.',
        );
    }

    const job = newJob({ subjectType, subjectId, slug, name: subject.name ?? slug, workspaceId: ctx.workspaceId });

    // Deliberately not awaited: the caller gets the job id, and the browser
    // work happens behind it.
    runCollection(ctx, job).catch((err) => {
        job.status = 'failed';
        job.error = err.message;
        job.finishedAt = now();
    });

    return jobStatus(job.id);
}

async function runCollection(ctx, job) {
    const existing = readSnapshots()[job.slug];

    if (existing && !existing.error) {
        note(job, 'Already collected — adopting the stored snapshot instead of opening a browser.');
        await adopt(ctx, job, existing, 'snapshot-file');
        return;
    }

    if (!scraperInstalled()) {
        throw new Error(
            `The collector was not found at ${QUALIFIER_DIR}. The CRM runs it from the local-scraper project rather `
            + 'than copying it. Set QUALIFIER_DIR to point at that folder.',
        );
    }

    note(job, `Collecting ${job.slug} from LinkedIn. A Chrome window will open — sign in there if it asks.`);
    await runScraper(job);

    const collected = readSnapshots()[job.slug];
    if (!collected) {
        throw new Error(
            'The collector finished without writing a snapshot for this company. Its log is above — the usual '
            + 'causes are a slug that does not exist on LinkedIn and a sign-in that never completed.',
        );
    }
    // An error snapshot is still evidence: "we looked and this is what
    // happened" is a fact worth keeping, and it is what makes the verdict ERROR
    // rather than a silent UNRESOLVED.
    await adopt(ctx, job, collected, 'linkedin');
}

function runScraper(job) {
    return new Promise((resolve, reject) => {
        // A plain text file, one slug per line — the collector's own default
        // input format, so no CSV column has to be guessed at.
        const tmp = path.join(os.tmpdir(), `crm-collect-${job.id}.txt`);
        fs.writeFileSync(tmp, `${job.slug}\n`, 'utf8');

        const child = spawn(process.execPath, ['scrape.mjs', '--input', tmp, '--limit', '1'], {
            cwd: QUALIFIER_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        job.child = child;

        const timer = setTimeout(() => {
            note(job, `Giving up after ${Math.round(TIMEOUT_MS / 60000)} minutes.`);
            child.kill();
        }, TIMEOUT_MS);

        const lines = (stream) => {
            let buffer = '';
            stream.setEncoding('utf8');
            stream.on('data', (chunk) => {
                buffer += chunk;
                const parts = buffer.split(/\r?\n/);
                buffer = parts.pop() ?? '';
                parts.forEach((l) => note(job, l));
            });
        };
        lines(child.stdout);
        lines(child.stderr);

        child.on('close', (code) => {
            clearTimeout(timer);
            job.child = null;
            fs.rmSync(tmp, { force: true });
            // A non-zero exit is not resolved as success, but it is not thrown
            // either: the collector writes its snapshot before it exits, so
            // there may still be evidence to adopt. The caller decides.
            if (code !== 0) note(job, `The collector exited with code ${code}.`);
            resolve();
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            job.child = null;
            fs.rmSync(tmp, { force: true });
            reject(new Error(`Could not start the collector: ${err.message}`));
        });
    });
}

/** Stores a snapshot as evidence and re-qualifies against it. */
async function adopt(ctx, job, snapshot, source) {
    const evidenceId = recordEvidence(ctx, {
        accountId: job.subjectType === 'account' ? job.subjectId : null,
        prospectId: job.subjectType === 'prospect' ? job.subjectId : null,
        subjectKey: job.slug,
        provider: 'local-browser',
        collectedAt: snapshot.collectedAt ?? now(),
        payload: snapshot,
        error: snapshot.error ?? null,
    });

    const verdicts = [];
    for (const rule of activeRules(ctx.workspaceId)) {
        // Sequential: each appends a verdict row, and the order they land in is
        // the order they are read back in.
        // eslint-disable-next-line no-await-in-loop
        const outcome = await qualifySubject(ctx, job.subjectType, job.subjectId, rule.key, { source: 'collect' });
        verdicts.push({ rule: rule.key, label: rule.label, verdict: outcome.verdict, changed: outcome.changed });
    }

    note(job, `Qualified: ${verdicts.map((v) => `${v.rule} ${v.verdict}`).join(', ')}.`);
    job.status = 'done';
    job.finishedAt = now();
    job.result = {
        source,
        evidenceId,
        collectedAt: snapshot.collectedAt ?? null,
        error: snapshot.error ?? null,
        headcount: Number.isFinite(snapshot.totalMembers) ? snapshot.totalMembers : null,
        verdicts,
    };
}
