/**
 * A minimal SMTP client, written against Node's own `net`/`tls` — no
 * dependency, matching this product's "zero runtime dependencies" stance
 * (package.json). It speaks exactly the subset this CRM's low-volume
 * business email needs: EHLO, STARTTLS or implicit TLS, AUTH LOGIN, and a
 * single message to one or more recipients. It is not a mail queue, a retry
 * engine, or a general MTA client — one call is one attempt, and the caller
 * (lib/email-delivery.mjs) decides what a failure means for the record it
 * was sending.
 */
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

const CRLF = '\r\n';

/** Buffers raw socket data into complete SMTP response blocks (multi-line, dash-continued). */
function responseReader(socket) {
    let buffer = '';
    const waiters = [];

    function tryDeliver() {
        while (waiters.length) {
            const lines = buffer.split(CRLF).filter(Boolean);
            // A response is complete once its LAST line has a space (not a
            // dash) after the three-digit code — "250-foo" continues,
            // "250 bar" ends it.
            const lastComplete = lines.length && buffer.endsWith(CRLF) && /^\d{3} /.test(lines[lines.length - 1]);
            if (!lastComplete) return;
            const code = Number(lines[0].slice(0, 3));
            const text = lines.map((l) => l.slice(4)).join('\n');
            buffer = '';
            waiters.shift().resolve({ code, text });
        }
    }

    socket.on('data', (chunk) => { buffer += chunk.toString('utf8'); tryDeliver(); });

    return () => new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
        tryDeliver();
    });
}

function send(socket, line) {
    socket.write(line + CRLF);
}

/** Dot-stuffing: an SMTP DATA line that begins with '.' must be escaped, or the server reads it as end-of-message. */
function dotStuff(message) {
    return message.split(CRLF).map((line) => (line.startsWith('.') ? `.${line}` : line)).join(CRLF);
}

class SmtpError extends Error {
    constructor(step, code, text) {
        super(`SMTP ${step} failed (${code}): ${text}`);
        this.step = step;
        this.code = code;
    }
}

/**
 * Sends one message over one connection. Resolves on success; throws
 * `SmtpError` naming exactly which step failed, so a caller can show "the
 * server rejected the recipient" rather than a bare socket error.
 *
 * @param {{host: string, port: number, secure: 'tls'|'starttls'|'none', username?: string, password?: string,
 *           from: string, to: string[], raw: string, timeoutMs?: number, heloName?: string}} opts
 */
export async function sendMail({ host, port, secure = 'starttls', username, password, from, to, raw, timeoutMs = 15000, heloName = 'crm.local' }) {
    const socket = await new Promise((resolve, reject) => {
        const s = secure === 'tls'
            ? tlsConnect({ host, port, rejectUnauthorized: true })
            : netConnect({ host, port });
        const onError = (err) => reject(err);
        s.once('error', onError);
        s.once(secure === 'tls' ? 'secureConnect' : 'connect', () => { s.off('error', onError); resolve(s); });
        s.setTimeout(timeoutMs, () => { s.destroy(new Error('SMTP connection timed out')); });
    });

    let read = responseReader(socket);
    let currentSocket = socket;

    async function expect(step, ...okCodes) {
        const { code, text } = await read();
        if (!okCodes.includes(code)) throw new SmtpError(step, code, text);
        return text;
    }

    async function upgradeToTls() {
        const upgraded = await new Promise((resolve, reject) => {
            const t = tlsConnect({ socket: currentSocket, host, rejectUnauthorized: true });
            t.once('error', reject);
            t.once('secureConnect', () => resolve(t));
        });
        currentSocket = upgraded;
        read = responseReader(upgraded);
        return upgraded;
    }

    try {
        await expect('connect', 220);

        send(currentSocket, `EHLO ${heloName}`);
        await expect('EHLO', 250);

        if (secure === 'starttls') {
            send(currentSocket, 'STARTTLS');
            await expect('STARTTLS', 220);
            await upgradeToTls();
            send(currentSocket, `EHLO ${heloName}`);
            await expect('EHLO (post-STARTTLS)', 250);
        }

        if (username) {
            send(currentSocket, 'AUTH LOGIN');
            await expect('AUTH LOGIN', 334);
            send(currentSocket, Buffer.from(username, 'utf8').toString('base64'));
            await expect('AUTH LOGIN (username)', 334);
            send(currentSocket, Buffer.from(password ?? '', 'utf8').toString('base64'));
            await expect('AUTH LOGIN (password)', 235);
        }

        send(currentSocket, `MAIL FROM:<${from}>`);
        await expect('MAIL FROM', 250);

        for (const recipient of to) {
            send(currentSocket, `RCPT TO:<${recipient}>`);
            await expect(`RCPT TO <${recipient}>`, 250, 251);
        }

        send(currentSocket, 'DATA');
        await expect('DATA', 354);
        currentSocket.write(dotStuff(raw) + CRLF + '.' + CRLF);
        await expect('message body', 250);

        send(currentSocket, 'QUIT');
        // Some servers close the socket immediately on QUIT without a
        // reply — not treated as a send failure, the message is already
        // accepted by the time QUIT is sent.
        await expect('QUIT', 221).catch(() => {});
    } finally {
        currentSocket.end();
    }
}
