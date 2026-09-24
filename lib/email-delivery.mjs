/**
 * Delivers ONE queued email — the piece the previous phase deliberately
 * left unbuilt. Everything upstream (lib/email-drafts.mjs,
 * lib/email-automation.mjs) already produces a fully-resolved, attachment-
 * ready `email_messages` row at `queued`; this is what turns that into an
 * actual SMTP send, using the workspace's own configured relay
 * (lib/settings.mjs's `smtp_*` keys) rather than a third-party sending
 * service — this is low-volume business mail, not bulk outbound, and a
 * relay the workspace already owns (Gmail, Outlook/M365, its own mail
 * server) is the right shape for that.
 *
 * A delivery attempt is exactly that: one attempt, synchronous with the
 * call, no retry queue. `queued` becomes `sent` or `failed`, with the SMTP
 * server's own words kept on `error` — a failure is diagnosable, not a
 * silent disappearance.
 */
import { get, run, now } from './db.mjs';
import { setting } from './settings.mjs';
import { readFile } from './document-store.mjs';
import { buildMimeMessage } from './mime.mjs';
import { sendMail } from './smtp-client.mjs';
import { badRequest } from './http.mjs';

/** The workspace's SMTP configuration, or `null` if delivery has not been set up yet. */
export function smtpConfig(workspaceId) {
    const host = setting(workspaceId, 'smtp_host');
    const fromEmail = setting(workspaceId, 'smtp_from_email');
    if (!host || !fromEmail) return null;
    return {
        host,
        port: Number(setting(workspaceId, 'smtp_port')) || 587,
        secure: setting(workspaceId, 'smtp_secure') || 'starttls',
        username: setting(workspaceId, 'smtp_username') || null,
        password: setting(workspaceId, 'smtp_password') || null,
        fromEmail,
        fromName: setting(workspaceId, 'smtp_from_name') || null,
    };
}

function attachmentsFor(ctx, documentIds) {
    const attachments = [];
    for (const docId of documentIds) {
        const doc = get('SELECT * FROM documents WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL', [docId, ctx.workspaceId]);
        if (!doc) continue;
        const data = readFile(doc.storage_key);
        if (!data) continue;
        attachments.push({ name: doc.name, contentType: doc.mime || 'application/octet-stream', data });
    }
    return attachments;
}

/**
 * Attempts delivery of one `queued` email_messages row. Always returns —
 * never throws — because a delivery failure is a fact about THIS message,
 * recorded on it, not an exception the caller has to guard against.
 */
export async function deliverMessage(ctx, message) {
    if (message.status !== 'queued') {
        return { delivered: false, reason: `This email is ${message.status}, not queued.` };
    }

    const config = smtpConfig(ctx.workspaceId);
    if (!config) {
        return { delivered: false, reason: 'No SMTP relay is configured yet (Settings → Email templates).' };
    }

    const cc = Array.isArray(message.cc_emails) ? message.cc_emails : [];
    const to = message.recipient_email ? [message.recipient_email] : [];
    const recipients = [...to, ...cc];
    if (!recipients.length) {
        return { delivered: false, reason: 'This email has no recipient.' };
    }

    const attachments = attachmentsFor(ctx, message.attachment_document_ids ?? []);

    const raw = buildMimeMessage({
        from: { email: config.fromEmail, name: config.fromName },
        to: to.length ? [{ email: message.recipient_email, name: message.recipient_name }] : cc.map((e) => ({ email: e })),
        cc: to.length ? cc.map((e) => ({ email: e })) : [],
        subject: message.subject,
        text: message.body,
        attachments,
    });

    try {
        await sendMail({
            host: config.host, port: config.port, secure: config.secure,
            username: config.username, password: config.password,
            from: config.fromEmail, to: recipients, raw,
        });
        run('UPDATE email_messages SET status = ?, sent_at = ?, error = NULL, updated_at = ? WHERE id = ?', ['sent', now(), now(), message.id]);
        return { delivered: true };
    } catch (err) {
        const reason = String(err?.message ?? err).slice(0, 500);
        run('UPDATE email_messages SET status = ?, error = ?, updated_at = ? WHERE id = ?', ['failed', reason, now(), message.id]);
        return { delivered: false, reason };
    }
}

/**
 * Settings' "Send a test email" — proves the relay actually works before an
 * admin trusts it with a real client send. Delivers immediately; nothing is
 * queued or logged as a business email, because it is not one.
 */
export async function sendTestEmail(ctx, toAddress) {
    const config = smtpConfig(ctx.workspaceId);
    if (!config) throw badRequest('Set a host and a from-address before sending a test.');
    const raw = buildMimeMessage({
        from: { email: config.fromEmail, name: config.fromName },
        to: [{ email: toAddress }],
        subject: 'Test email from your CRM',
        text: `This confirms ${config.host}:${config.port} (${config.secure}) is configured correctly for outgoing mail.\n\nSent ${new Date().toISOString()}.`,
    });
    /**
     * sendMail throws a plain `SmtpError` (or a raw socket/TLS Error), not an
     * HttpError — server.mjs's top-level handler only forwards an
     * HttpError's own message to the response; everything else becomes the
     * generic "Something went wrong on the server." That threw away exactly
     * the message this is built to surface ("SMTP auth failed (535):
     * Invalid credentials", a connection refused, a TLS handshake failure),
     * leaving "Send a test email" answer with nothing anyone could act on.
     */
    try {
        await sendMail({
            host: config.host, port: config.port, secure: config.secure,
            username: config.username, password: config.password,
            from: config.fromEmail, to: [toAddress], raw,
        });
    } catch (err) {
        throw badRequest(`Test email failed: ${err.message}`);
    }
    return { ok: true };
}
