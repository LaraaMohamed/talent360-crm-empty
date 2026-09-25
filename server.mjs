/**
 * The CRM server.
 *
 *   node server.mjs        then open http://127.0.0.1:5180
 *
 * Node's own http module and `node:sqlite`. No dependencies, no build step, no
 * database to install — the same choice the qualifier UI already makes in this
 * project, for the same reasons.
 *
 * Binds to 127.0.0.1 by default. This holds a customer database and personal
 * contact data; it does not get a public interface by accident.
 */
import http from 'node:http';
import path from 'node:path';
import { migrate, close, identity, ROOT, describe, get, HOSTED } from './lib/db.mjs';
import {
    createRouter, sendJson, serveStatic, parseCookies, HttpError, unauthorized, forbidden,
} from './lib/http.mjs';
import { sessionFor, routeAllowed, COOKIE, contextForApiKey, API_KEY_HEADER } from './lib/auth.mjs';
import { registerRoutes, PUBLIC_ROUTES, SIGNED_ROUTES, WEBHOOK_ROUTES } from './api/index.mjs';
import { matchQualifierRoute, proxy as proxyToQualifier, shutdown as shutdownQualifier } from './lib/qualifier-ui.mjs';
import { handleMcpRequest } from './api/mcp.mjs';

const PORT = Number(process.env.PORT) || 3000;
// Defaults to loopback-only, matching the comment above: this holds a customer
// database and personal contact data, so exposing it to the network is an
// explicit choice (HOST=0.0.0.0, as render.yaml and deploy/crm.service both
// set deliberately), never a fallback nobody asked for.
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(ROOT, 'public');
process.env.CRM_TRUST_PROXY = process.env.CRM_TRUST_PROXY ?? '1';

migrate();

/**
 * There is one live database, and this is how that stays true.
 *
 * A copy that has been retired refuses to serve. Without this, the CRM moves to
 * a server and someone eventually starts the old laptop copy, works in it for a
 * day, and the two histories have to be reconciled by hand — which is not a
 * restore, and loses whichever edits nobody noticed.
 *
 * Scripts are deliberately unaffected: a retired copy can still be backed up,
 * inspected or restored from. Only serving it is refused, because serving is
 * what lets it be edited.
 */
const db = identity();
if (db?.status === 'retired') {
    console.error('');
    console.error('  This database has been retired and will not be served.');
    console.error('');
    console.error(`  database   ${describe()}`);
    console.error(`  retired    ${db.retired_at}`);
    if (db.moved_to) console.error(`  live copy  ${db.moved_to}`);
    if (db.note) console.error(`  note       ${db.note}`);
    console.error('');
    console.error('  Working in two copies at once is not recoverable by restoring one of');
    console.error('  them. Use the live system above.');
    console.error('');
    console.error('  If THIS copy is meant to be the live one — you have just restored it');
    console.error('  onto a new machine, say — activate it deliberately:');
    console.error('');
    console.error('      node retire-database.mjs --activate');
    console.error('');
    process.exit(1);
}

const router = createRouter();
registerRoutes(router);

const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let url;
    try {
        url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    } catch {
        return sendJson(res, 400, { error: 'Bad request URL' });
    }

    try {
        /**
         * The MCP server (api/mcp.mjs) — matched before everything else,
         * including the CSRF check right below.
         *
         * It is NOT cookie-authenticated (an MCP client is Claude/ChatGPT/
         * Gemini's own backend, not a browser holding this site's session
         * cookie), so the CSRF defense built for cookies — an Origin check —
         * is the wrong tool here and would only ever reject a legitimate
         * client that (correctly) sends no Origin header at all, or a
         * mismatched one. What actually protects this route is the bearer
         * token every request must carry (`ctxForMcpRequest` in api/mcp.mjs)
         * — a credential a cross-site page cannot attach the way it can ride
         * an ambient cookie, which is the entire premise CSRF exploits.
         * CORS is opened wide for the same reason: nothing here is reachable
         * without that same explicit header, so an arbitrary origin reading
         * the response teaches it nothing a stolen cookie would have.
         */
        if (url.pathname === '/mcp') {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version');
            res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                return res.end();
            }
            if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
                return sendJson(res, 405, { error: 'Method not allowed' });
            }
            return await handleMcpRequest(req, res);
        }

        /**
         * CSRF: session cookies are SameSite=Strict, and every state-changing
         * request must also carry an Origin matching this server. Together
         * those close the hole without a token the client has to remember to
         * attach.
         */
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
            const origin = req.headers.origin;
            if (origin) {
                const host = req.headers['x-forwarded-host'] || req.headers.host;
                const allowed = `http://${host}`;
                const allowedHttps = `https://${host}`;
                const allowedRaw = `http://${req.headers.host}`;
                const allowedRawHttps = `https://${req.headers.host}`;
                if (origin !== allowed && origin !== allowedHttps && origin !== allowedRaw && origin !== allowedRawHttps) {
                    try {
                        const originUrl = new URL(origin);
                        const hostName = (host || req.headers.host || '').split(':')[0];
                        const originHostName = originUrl.hostname;
                        // The localhost/127.0.0.1/Cloud-Run allowances below exist for
                        // local development and testing against a throwaway database,
                        // and only make sense there. HOSTED means this process is
                        // talking to the shared hosted database — real customer data,
                        // reachable from the open internet — so on that path an origin
                        // must match the request's own Host exactly, no exceptions.
                        const devAllowance = !HOSTED && (originHostName === 'localhost' || originHostName === '127.0.0.1' || originHostName.endsWith('.run.app') || originHostName.endsWith('.google.com'));
                        if (originHostName !== hostName && !devAllowance) {
                            return sendJson(res, 403, { error: 'Cross-origin request refused.' });
                        }
                    } catch {
                        return sendJson(res, 403, { error: 'Cross-origin request refused.' });
                    }
                }
            }
        }

        /**
         * The qualifier's own UI, mounted inside the CRM.
         *
         * Matched BEFORE the API router, so the paths that page asks for at the
         * root (/app.css, /api/inspect, /api/progress/:id …) never reach the
         * CRM's own endpoints. It is proxied unmodified — see lib/qualifier-ui.mjs
         * for why it is not reimplemented — and it sits behind the CRM session,
         * so embedding it does not open an unauthenticated door.
         */
        const qualifierPath = matchQualifierRoute(req.method, url.pathname);
        if (qualifierPath) {
            const token = parseCookies(req.headers.cookie)[COOKIE];
            if (!sessionFor(token)) throw unauthorized();
            return proxyToQualifier(req, res, qualifierPath + (url.search || ''));
        }

        if (url.pathname.startsWith('/api/')) {
            const match = router.match(req.method, url.pathname);
            if (!match) return sendJson(res, 404, { error: `No such endpoint: ${req.method} ${url.pathname}` });

            const token = parseCookies(req.headers.cookie)[COOKIE];
            // A browser sends the cookie; a tool with no session (Make,
            // Zapier, a script) sends this header instead. The cookie wins
            // when both are somehow present, since it is the one a person is
            // actually sitting behind.
            const ctx = sessionFor(token) ?? contextForApiKey(req.headers[API_KEY_HEADER]);
            const route = `${req.method} ${url.pathname}`;
            // A signed document URL carries its own authorisation, verified
            // against the workspace key inside the handler. It is not public —
            // it is authenticated by a different credential.
            const isOpen = PUBLIC_ROUTES.has(route)
                || SIGNED_ROUTES.some((re) => re.test(route))
                || WEBHOOK_ROUTES.some((re) => re.test(route));
            if (!ctx && !isOpen) throw unauthorized();

            /**
             * A confined role reaches only the endpoints its role names, and
             * this is where that is decided — before the handler, for every
             * route, including ones written after this line.
             *
             * The generic record routes ask for no capability of their own, so
             * without this an SDR typing /api/contacts would be answered with
             * the contact database. Enforced here rather than per-handler so
             * that adding an endpoint cannot quietly widen anyone's access.
             */
            if (ctx && !routeAllowed(ctx, req.method, url.pathname)) {
                throw forbidden('Your role does not have access to that part of the CRM.');
            }

            const result = await match.handler({ req, res, url, params: match.params, ctx, token });
            if (result !== undefined && !res.writableEnded) sendJson(res, 200, result);
            return;
        }

        // Everything else is the single-page app. Deep links like
        // /accounts/acc_123 are routed in the browser, so unknown paths get the
        // shell rather than a 404.
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
        const file = url.pathname === '/' || !path.extname(url.pathname) ? '/index.html' : url.pathname;
        return serveStatic(res, PUBLIC_DIR, file);
    } catch (err) {
        if (res.writableEnded) return;
        if (err instanceof HttpError) {
            return sendJson(res, err.status, { error: err.message, ...err.extra });
        }
        console.error(`  ${req.method} ${url.pathname} failed after ${Date.now() - started}ms`);
        console.error(err);
        return sendJson(res, 500, { error: 'Something went wrong on the server.' });
    }
});

server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  CRM');
    console.log('');
    console.log(`  Open      http://${HOST}:${PORT}`);
    console.log(`  Database  ${describe()}`);
    console.log('');
    console.log('  Ctrl+C to stop.');
    console.log('');
    /**
     * Not a hard failure, because a workspace with no Smartlead campaigns
     * linked never calls apolloWebhookUrl/outreach's webhook registration and
     * would never notice PUBLIC_BASE_URL was missing until it did. But it is
     * exactly the kind of gap a founder-facing audit found by reading code,
     * not by anything failing loudly — so it is said once, at boot, where an
     * operator watching deploy logs will actually see it.
     */
    if (HOSTED && !process.env.PUBLIC_BASE_URL) {
        console.log('  ⚠ PUBLIC_BASE_URL is not set. Smartlead and Apollo webhook');
        console.log('    registration will fail with a clear error the moment anyone');
        console.log('    tries to use them — set it to this server\'s real public URL.');
        console.log('');
    }
});

/**
 * Outreach reconciliation — the webhook's own repair.
 *
 * There is no queue runner or scheduler elsewhere in the product (jobs is dead
 * schema; the nightly backup timer is the only cron that exists). This is the
 * second one, and it is deliberately tiny: one interval on one process.
 *
 * On Render that process is the single web service. On the Doha VM it is
 * crm.service. Horizontally scaling this server without turning this off would
 * run the same sync N times — the work IS idempotent, but the API cost is not.
 * SMARTLEAD_SYNC_DISABLED=1 kills it without a deploy for exactly that case.
 */
if (process.env.SMARTLEAD_SYNC_DISABLED !== '1') {
    const SYNC_EVERY_MS = 15 * 60 * 1000;
    let syncRunning = false;
    async function runOutreachSync() {
        if (syncRunning) return;
        syncRunning = true;
        try {
            const { syncAllWorkspaces } = await import('./lib/outreach.mjs');
            await syncAllWorkspaces();
        } catch (error) {
            console.error('  outreach sync sweep failed:', error?.message ?? error);
        } finally {
            syncRunning = false;
        }
    }
    // First sweep five minutes after boot — webhooks deserve a head start, and
    // a fresh deploy should not hammer Smartlead the instant it comes up.
    setTimeout(runOutreachSync, 5 * 60 * 1000).unref();
    setInterval(runOutreachSync, SYNC_EVERY_MS).unref();
}

/**
 * Renewal notice sweep — the third interval on this process.
 *
 * Day-granularity work (a notice window is measured in days, never minutes),
 * so an hourly cadence is a wide safety margin rather than a tight schedule.
 * Same shape as the Smartlead sync above: idempotent by design (see
 * lib/renewals.mjs), so a second run inside the same notice window is a
 * no-op, and RENEWAL_SYNC_DISABLED=1 kills it the same way for a scaled
 * deployment.
 */
if (process.env.RENEWAL_SYNC_DISABLED !== '1') {
    const RENEWAL_SWEEP_EVERY_MS = 60 * 60 * 1000;
    let renewalSweepRunning = false;
    async function runRenewalSweep() {
        if (renewalSweepRunning) return;
        renewalSweepRunning = true;
        try {
            const { sweepAllWorkspaces } = await import('./lib/renewals.mjs');
            sweepAllWorkspaces();
        } catch (error) {
            console.error('  renewal sweep failed:', error?.message ?? error);
        } finally {
            renewalSweepRunning = false;
        }
    }
    setTimeout(runRenewalSweep, 2 * 60 * 1000).unref();
    setInterval(runRenewalSweep, RENEWAL_SWEEP_EVERY_MS).unref();
}

/**
 * Due-reminder sweep — the fourth and last interval on this process.
 *
 * Minute-granularity work, unlike the renewal sweep above — a task or a
 * meeting is "due" at a specific moment, and someone reading a reminder an
 * hour after the fact has already missed it. Five minutes is close enough to
 * that moment to be useful without being a busy-loop; idempotent the same
 * way (lib/reminders.mjs's reminder_sent_at / meeting_reminder_sent_at
 * markers), so a second run before the next due item never double-sends.
 */
if (process.env.REMINDER_SWEEP_DISABLED !== '1') {
    const REMINDER_SWEEP_EVERY_MS = 5 * 60 * 1000;
    let reminderSweepRunning = false;
    async function runReminderSweep() {
        if (reminderSweepRunning) return;
        reminderSweepRunning = true;
        try {
            const { sweepAllWorkspaces } = await import('./lib/reminders.mjs');
            sweepAllWorkspaces();
        } catch (error) {
            console.error('  reminder sweep failed:', error?.message ?? error);
        } finally {
            reminderSweepRunning = false;
        }
    }
    setTimeout(runReminderSweep, 30 * 1000).unref();
    setInterval(runReminderSweep, REMINDER_SWEEP_EVERY_MS).unref();
}

/**
 * There is no error tracking or alerting anywhere in this project — the only
 * way anyone finds out about a crash today is reading Render's raw log
 * output after the fact. This does not add monitoring; it makes sure the one
 * thing that already exists (the log) actually says something findable
 * instead of the process just disappearing. Every request handler already
 * runs inside server.mjs's own try/catch, so reaching here means something
 * escaped that — a throw from a timer callback, or off the main request path
 * entirely.
 *
 * Both still exit deliberately, matching Node's own default behaviour for an
 * uncaught exception: past this point the process's state is not something
 * to trust, and Render restarts the service the moment it exits. A handler
 * that logs and carries on would only be trading a clean, visible restart for
 * a process quietly limping along broken.
 */
for (const event of ['uncaughtException', 'unhandledRejection']) {
    process.on(event, (error) => {
        console.error(`  ${event.toUpperCase()} — exiting so the platform restarts a clean process:`);
        console.error(error);
        process.exit(1);
    });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        // A qualifier the CRM started is the CRM's to stop. One started by hand
        // is left alone — see lib/qualifier-ui.mjs.
        shutdownQualifier();
        server.close(() => {
            close();
            process.exit(0);
        });
        // Don't hang forever on a keep-alive connection nobody is using.
        setTimeout(() => process.exit(0), 2000).unref();
    });
}
