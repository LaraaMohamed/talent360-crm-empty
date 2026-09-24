/**
 * Builds one raw RFC 5322 / MIME message — a plain-text body plus zero or
 * more binary attachments — for `lib/smtp-client.mjs` to hand to a server
 * exactly as written. No dependency: base64 and header folding are both
 * a handful of lines, and pulling in a library for them would be the
 * opposite of what "zero runtime dependencies" (package.json) asks for.
 */
import { randomBytes } from 'node:crypto';

const CRLF = '\r\n';

/**
 * RFC 2047 "B" encoding for a header value that might not be plain ASCII —
 * this product's own company names are routinely Arabic. Left alone if the
 * value is already ASCII, so an ordinary subject line stays readable in a
 * raw message dump rather than needlessly encoded.
 */
function encodeHeaderValue(value) {
    const s = String(value ?? '');
    // eslint-disable-next-line no-control-regex
    if (/^[\x00-\x7F]*$/.test(s)) return s;
    return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/** An address, optionally with a display name — `"Jane Doe" <jane@x.com>` or bare `jane@x.com`. */
function formatAddress(email, name) {
    if (!name) return email;
    return `${encodeHeaderValue(name)} <${email}>`;
}

/** Base64, wrapped at 76 characters — the line-length limit RFC 2045 sets for MIME body content. */
function base64Wrapped(buffer) {
    const b64 = buffer.toString('base64');
    const lines = [];
    for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
    return lines.join(CRLF);
}

/**
 * @param {{from: {email:string,name?:string}, to: {email:string,name?:string}[], cc?: {email:string,name?:string}[],
 *           subject: string, text: string, attachments?: {name:string, contentType?:string, data:Buffer}[]}} msg
 * @returns {string} the raw message, ready for the SMTP client's DATA command
 */
export function buildMimeMessage({ from, to, cc = [], subject, text, attachments = [] }) {
    const boundary = `----crm-${randomBytes(12).toString('hex')}`;
    const messageId = `<${randomBytes(16).toString('hex')}@${(from.email.split('@')[1] || 'crm.local')}>`;

    const headers = [
        `From: ${formatAddress(from.email, from.name)}`,
        `To: ${to.map((r) => formatAddress(r.email, r.name)).join(', ')}`,
        cc.length ? `Cc: ${cc.map((r) => formatAddress(r.email, r.name)).join(', ')}` : null,
        `Subject: ${encodeHeaderValue(subject)}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: ${messageId}`,
        'MIME-Version: 1.0',
    ].filter(Boolean);

    if (!attachments.length) {
        headers.push('Content-Type: text/plain; charset=UTF-8');
        headers.push('Content-Transfer-Encoding: base64');
        return headers.join(CRLF) + CRLF + CRLF + base64Wrapped(Buffer.from(text, 'utf8'));
    }

    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

    const parts = [
        `--${boundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        base64Wrapped(Buffer.from(text, 'utf8')),
        '',
    ];
    for (const att of attachments) {
        parts.push(
            `--${boundary}`,
            `Content-Type: ${att.contentType ?? 'application/octet-stream'}; name="${att.name}"`,
            `Content-Disposition: attachment; filename="${att.name}"`,
            'Content-Transfer-Encoding: base64',
            '',
            base64Wrapped(att.data),
            '',
        );
    }
    parts.push(`--${boundary}--`);

    return headers.join(CRLF) + CRLF + CRLF + parts.join(CRLF);
}
