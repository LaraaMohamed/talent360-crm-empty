/**
 * HTTP plumbing: a tiny pattern router, body parsing, cookies and typed errors.
 *
 * Node's own http module, no framework. One local page and a JSON API do not
 * justify a dependency tree, and the existing qualifier UI already proves the
 * approach in this project.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_BODY = 32 * 1024 * 1024;

/** Thrown anywhere in a handler; turned into a JSON response by the server. */
export class HttpError extends Error {
    constructor(status, message, extra = {}) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}

export const badRequest = (m, extra) => new HttpError(400, m, extra);
export const unauthorized = (m = 'Sign in to continue') => new HttpError(401, m);
export const forbidden = (m = 'You do not have permission to do that') => new HttpError(403, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);
export const conflict = (m, extra) => new HttpError(409, m, extra);
export const tooManyRequests = (m = 'Too many attempts. Try again later.', extra) => new HttpError(429, m, extra);
export const serviceUnavailable = (m = 'Service temporarily unavailable.', extra) => new HttpError(503, m, extra);

/* ----------------------------------------------------------------- router -- */

export function createRouter() {
    const routes = [];

    /** `add('GET', '/api/accounts/:id', handler)` */
    function add(method, pattern, handler) {
        const keys = [];
        const source = pattern
            .replace(/[.+*?^${}()|[\]\\]/g, '\\$&')
            .replace(/:(\w+)/g, (_, key) => {
                keys.push(key);
                return '([^/]+)';
            });
        routes.push({ method, regex: new RegExp(`^${source}$`), keys, handler });
    }

    function match(method, pathname) {
        for (const route of routes) {
            if (route.method !== method) continue;
            const m = route.regex.exec(pathname);
            if (!m) continue;
            const params = {};
            route.keys.forEach((key, i) => { params[key] = decodeURIComponent(m[i + 1]); });
            return { handler: route.handler, params };
        }
        return null;
    }

    return {
        match,
        get: (p, h) => add('GET', p, h),
        post: (p, h) => add('POST', p, h),
        patch: (p, h) => add('PATCH', p, h),
        put: (p, h) => add('PUT', p, h),
        delete: (p, h) => add('DELETE', p, h),
    };
}

/* ------------------------------------------------------------------ body -- */

export function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                reject(badRequest('Request body is too large (32 MB limit).'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

export async function readJson(req) {
    const buf = await readBody(req);
    if (!buf.length) return {};
    try {
        return JSON.parse(buf.toString('utf8'));
    } catch {
        throw badRequest('Request body is not valid JSON.');
    }
}

/* --------------------------------------------------------------- replies -- */

export function sendJson(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload ?? null), 'utf8');
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
    const body = Buffer.from(text, 'utf8');
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length });
    res.end(body);
}

export function sendBuffer(res, status, buf, headers = {}) {
    res.writeHead(status, { 'Content-Length': buf.length, ...headers });
    res.end(buf);
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
};

/**
 * Serves a file from `root`, refusing anything that resolves outside it.
 * The resolved-path check is the one that matters: `..%2f..%2fetc` survives
 * naive string checks but not `path.resolve` followed by a prefix test.
 */
export function serveStatic(res, root, relative) {
    const target = path.resolve(root, `.${path.posix.normalize(`/${relative}`)}`);
    if (target !== root && !target.startsWith(root + path.sep)) {
        return sendJson(res, 403, { error: 'Forbidden' });
    }
    fs.readFile(target, (err, data) => {
        if (err) return sendJson(res, 404, { error: 'Not found' });
        sendBuffer(res, 200, data, {
            'Content-Type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
            'Cache-Control': 'no-cache',
        });
    });
}

/* --------------------------------------------------------------- cookies -- */

export function parseCookies(header) {
    const out = {};
    for (const part of String(header ?? '').split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    }
    return out;
}

/**
 * Whether this request reached us over TLS.
 *
 * Behind a reverse proxy the app itself speaks plain HTTP, and the only
 * evidence of TLS is `X-Forwarded-Proto` — a header any client can send. It is
 * therefore trusted ONLY when `CRM_TRUST_PROXY=1` says something in front of us
 * is setting it. Trusting it unconditionally would let a caller claim a secure
 * connection it does not have.
 */
export function isSecureRequest(req) {
    if (req?.socket?.encrypted) return true;
    if (process.env.CRM_TRUST_PROXY === '1') {
        const proto = String(req?.headers?.['x-forwarded-proto'] ?? '').split(',')[0].trim();
        if (proto === 'https') return true;
    }
    return false;
}

/**
 * Whether to mark cookies `Secure`.
 *
 * `auto` (the default) follows the request, so localhost development keeps
 * working and a TLS deployment gets the flag with no code change. `1` forces it
 * on, which is what you want the moment the app is only ever reached over
 * HTTPS — a `Secure` cookie is simply never sent over plain HTTP, which is the
 * protection.
 */
export function useSecureCookies(req) {
    const mode = process.env.CRM_SECURE_COOKIES ?? 'auto';
    if (mode === '1') return true;
    if (mode === '0') return false;
    return isSecureRequest(req);
}

/**
 * The caller's address, for rate limiting. Behind a reverse proxy the socket's
 * own address is the proxy's, not the caller's — `X-Forwarded-For` carries the
 * real one, and is trusted only when `CRM_TRUST_PROXY=1` says something in
 * front of us is actually setting it, same gate as `isSecureRequest`. A caller
 * could otherwise forge the header and reset their own rate limit at will.
 */
export function clientIp(req) {
    if (process.env.CRM_TRUST_PROXY === '1') {
        const header = req?.headers?.['x-forwarded-for'];
        if (header) return String(header).split(',')[0].trim();
    }
    return req?.socket?.remoteAddress ?? 'unknown';
}

export function setCookie(res, name, value, { maxAge, secure = false } = {}) {
    const parts = [
        `${name}=${encodeURIComponent(value)}`,
        'Path=/',
        'HttpOnly',
        secure ? 'SameSite=None' : 'SameSite=Lax',
    ];
    if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
    if (secure) parts.push('Secure');
    const existing = res.getHeader('Set-Cookie');
    const list = existing ? [].concat(existing) : [];
    list.push(parts.join('; '));
    res.setHeader('Set-Cookie', list);
}

export function clearCookie(res, name, { secure = false } = {}) {
    setCookie(res, name, '', { maxAge: 0, secure });
}

/* ------------------------------------------------------------------ misc -- */

/** `?a=1&a=2` -> `{a: ['1','2']}` only where repeats are meaningful. */
export function query(url) {
    const out = {};
    for (const [k, v] of url.searchParams) {
        if (k in out) out[k] = [].concat(out[k], v);
        else out[k] = v;
    }
    return out;
}
