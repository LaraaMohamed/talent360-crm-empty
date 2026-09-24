/**
 * The upload-and-qualify UI, mounted inside the CRM.
 *
 * ── WHY THIS IS A PROXY AND NOT A REWRITE ───────────────────────────────────
 * `local-scraper/server.mjs` is working software in daily use. Its page does
 * upload → pre-flight → collect → qualify → download, and its collection path
 * runs `scrape.mjs` as a child process so the browser profile, the sign-in
 * wait, the 4–9 s pacing and resumability all behave exactly as they do from
 * the terminal. Reimplementing that inside the CRM would produce a second
 * collection path that drifts from the first, which is the same mistake as
 * copying the rule files instead of importing them.
 *
 * So the CRM proxies it. Not one line of the qualifier changes, and the page
 * arrives SAME-ORIGIN, which means it can be framed inside the CRM shell and
 * sits behind the CRM's own session check instead of being an open port.
 *
 * ── WHAT IS PROXIED ─────────────────────────────────────────────────────────
 * Exactly the paths that page asks for, and nothing else:
 *
 *     GET  /qualifier            ->  GET /            the page
 *     GET  /qualifier/app.css        /app.css
 *     GET  /qualifier/app.js         /app.js
 *     POST /api/inspect              (pre-flight)
 *     POST /api/qualify              (start a run)
 *     GET  /api/progress/:id         (server-sent events)
 *     GET  /api/download/:id         (the filtered CSV)
 *
 * The page requests its assets and API from the ROOT path, so those four /api
 * paths are claimed at the CRM's root too. None of them collide: the CRM's own
 * endpoints are /api/<object> for a registered object, and `inspect`,
 * `qualify`, `progress` and `download` are not objects. They are matched here,
 * before the API router, so the router never sees them.
 *
 * ── THE CHILD PROCESS ───────────────────────────────────────────────────────
 * If nothing is listening on the qualifier's port, the CRM can start it — the
 * same `node server.mjs` a person would run by hand, in the same directory. It
 * is a supervised child, not a fork: stopping the CRM stops it, and a qualifier
 * already running (started from a terminal) is adopted rather than duplicated.
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { REMOTE } from './db.mjs';
import { SCRAPER_ROOT } from './qualification.mjs';

/**
 * Same folder the rules come from, resolved the same way — the project has
 * lived both beside this one and inside it. Taking it from qualification.mjs
 * rather than repeating the rule here is deliberate: two copies of "where the
 * scraper is" is how one of them ends up pointing at nothing, which is exactly
 * what happened when the folder moved.
 */
export const QUALIFIER_DIR = process.env.QUALIFIER_DIR ?? SCRAPER_ROOT;

export const QUALIFIER_PORT = Number(process.env.QUALIFIER_PORT) || 5173;
const QUALIFIER_HOST = '127.0.0.1';

/** Paths the embedded page asks for at the CRM's root, mapped to the child's. */
const PROXIED = [
    { method: 'GET', pattern: /^\/qualifier\/?$/, to: () => '/' },
    { method: 'GET', pattern: /^\/qualifier\/(app\.(css|js))$/, to: (m) => `/${m[1]}` },
    { method: 'GET', pattern: /^\/app\.(css|js)$/, to: (m) => `/app.${m[1]}` },
    { method: 'POST', pattern: /^\/api\/inspect$/, to: () => '/api/inspect' },
    { method: 'POST', pattern: /^\/api\/qualify$/, to: () => '/api/qualify' },
    { method: 'GET', pattern: /^\/api\/progress\/([^/]+)$/, to: (m) => `/api/progress/${m[1]}` },
    { method: 'GET', pattern: /^\/api\/download\/([^/]+)$/, to: (m) => `/api/download/${m[1]}` },
];

export function matchQualifierRoute(method, pathname) {
    for (const route of PROXIED) {
        if (route.method !== method) continue;
        const m = route.pattern.exec(pathname);
        if (m) return route.to(m);
    }
    return null;
}

export function isInstalled() {
    return fs.existsSync(path.join(QUALIFIER_DIR, 'server.mjs'));
}

/* -------------------------------------------------------------- lifecycle -- */

let child = null;
let startPromise = null;
const startupLog = [];

function note(line) {
    startupLog.push(`${new Date().toISOString()} ${line}`);
    if (startupLog.length > 50) startupLog.shift();
}

/** Is anything listening on the qualifier's port — ours or a hand-started one? */
export function ping(timeoutMs = 800) {
    return new Promise((resolve) => {
        const req = http.request(
            { host: QUALIFIER_HOST, port: QUALIFIER_PORT, path: '/', method: 'HEAD', timeout: timeoutMs },
            (res) => { res.resume(); resolve(true); },
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}

export async function status() {
    const running = await ping();
    return {
        running,
        // A qualifier the CRM did not start is still a qualifier. Adopting it
        // rather than starting a second one on the same port is the difference
        // between "already running" and an EADDRINUSE crash loop.
        managed: !!child,
        installed: isInstalled(),
        directory: QUALIFIER_DIR,
        port: QUALIFIER_PORT,
        url: `http://${QUALIFIER_HOST}:${QUALIFIER_PORT}`,
        log: startupLog.slice(-10),
    };
}

export async function ensureRunning({ timeoutMs = 15000 } = {}) {
    if (await ping()) return { started: false, alreadyRunning: true };
    if (!isInstalled()) {
        /**
         * On a server this is not a misconfiguration and there is nothing to
         * point at. Collection drives a real browser through a signed-in
         * profile, which is a laptop activity: the profile is a live login, and
         * the repository ships the RULES (local-scraper/lib) precisely because
         * they are the part a server needs. Saying "set QUALIFIER_DIR" here
         * sends someone looking for a folder that was never deployed.
         */
        if (REMOTE) {
            throw new Error(
                'Collecting runs a browser against a signed-in profile, so it only runs on a machine that has one '
                + '— not on the hosted CRM. Upload and qualify from the local-scraper project on your computer; '
                + 'everything it produces shows up here.',
            );
        }
        throw new Error(
            `The qualifier was not found at ${QUALIFIER_DIR}. The CRM runs it from the local-scraper project rather `
            + 'than copying it, so the two can never disagree. Set QUALIFIER_DIR to point at that folder.',
        );
    }
    if (startPromise) return startPromise;

    startPromise = new Promise((resolve, reject) => {
        note(`starting: node server.mjs in ${QUALIFIER_DIR}`);
        child = spawn(process.execPath, ['server.mjs'], {
            cwd: QUALIFIER_DIR,
            env: { ...process.env, PORT: String(QUALIFIER_PORT) },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => chunk.split(/\r?\n/).filter(Boolean).forEach(note));
        child.stderr.on('data', (chunk) => chunk.split(/\r?\n/).filter(Boolean).forEach((l) => note(`stderr: ${l}`)));

        child.on('exit', (code) => {
            note(`qualifier exited with code ${code}`);
            child = null;
        });
        child.on('error', (err) => {
            note(`could not start: ${err.message}`);
            child = null;
            startPromise = null;
            reject(new Error(`Could not start the qualifier: ${err.message}`));
        });

        // Poll rather than trust a log line: the child prints its banner before
        // the socket is necessarily accepting, and "it said it started" is not
        // the same claim as "it answers".
        const deadline = Date.now() + timeoutMs;
        const poll = async () => {
            if (await ping(500)) {
                startPromise = null;
                return resolve({ started: true, alreadyRunning: false });
            }
            if (Date.now() > deadline) {
                startPromise = null;
                return reject(new Error(`The qualifier did not answer on port ${QUALIFIER_PORT} within ${Math.round(timeoutMs / 1000)}s. Last output: ${startupLog.slice(-3).join(' | ') || 'none'}`));
            }
            return setTimeout(poll, 350);
        };
        setTimeout(poll, 400);
    });

    return startPromise;
}

/** Only ever stops a child the CRM started. A hand-started one is not ours to kill. */
export function stop() {
    if (!child) return { stopped: false, reason: 'The CRM did not start this qualifier, so it will not stop it.' };
    child.kill();
    child = null;
    return { stopped: true };
}

export function shutdown() {
    if (child) {
        child.kill();
        child = null;
    }
}

/* ------------------------------------------------------------------ proxy -- */

/**
 * Streams a request through to the qualifier and back.
 *
 * Bodies are piped rather than buffered, which matters for two reasons: a 32 MB
 * lead list should not be held twice in memory, and `/api/progress/:id` is a
 * server-sent event stream that must arrive as it happens. Nothing here
 * transforms the payload — an intermediary that edits what it forwards is a
 * source of bugs nobody can see from either end.
 */
export function proxy(req, res, targetPath) {
    const headers = { ...req.headers, host: `${QUALIFIER_HOST}:${QUALIFIER_PORT}`, 'accept-encoding': 'identity' };
    // The CRM session cookie is not the qualifier's business, and forwarding
    // credentials to a child process that never checks them is how a proxy
    // becomes an accident. DELETED, not set to undefined — Node rejects an
    // undefined header value outright rather than treating it as absent.
    delete headers.cookie;
    delete headers.authorization;

    const upstream = http.request(
        {
            host: QUALIFIER_HOST,
            port: QUALIFIER_PORT,
            path: targetPath,
            method: req.method,
            headers,
        },
        (upstreamRes) => {
            const headers = { ...upstreamRes.headers };
            // Frameable by this origin only. The page is embedded in the CRM
            // shell, and nothing else should be able to embed it.
            headers['content-security-policy'] = "frame-ancestors 'self'";
            if (targetPath.startsWith('/api/progress/')) {
                headers['cache-control'] = 'no-cache, no-transform';
                headers['x-accel-buffering'] = 'no';
            }
            res.writeHead(upstreamRes.statusCode ?? 502, headers);
            upstreamRes.pipe(res);
        },
    );

    upstream.on('error', (err) => {
        if (res.writableEnded) return;
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            error: `The qualifier is not answering on port ${QUALIFIER_PORT} (${err.code ?? err.message}). `
                + 'Start it from the Qualifier page, or run "npm run ui" in the local-scraper folder.',
        }));
    });

    req.pipe(upstream);
    // A closed browser tab must not leave the upstream request hanging — SSE
    // streams stay open for the whole run, so this is the normal ending, not an
    // edge case.
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
}
