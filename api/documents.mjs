/**
 * Documents.
 *
 * The row holds a storage key; the bytes are reached through a short-lived
 * signed URL and fetched by lib/document-store.mjs, which decides whether they
 * come off the disk or out of the database. That is the same shape an S3-backed
 * deployment needs, so moving to object storage later replaces one module
 * rather than every caller.
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { all, get, run, id, now, json } from '../lib/db.mjs';
import { writeFile, readFile, hasFile } from '../lib/document-store.mjs';
import { getRecord, audit, insert, reindex } from '../lib/repo.mjs';
import { requireWrite } from '../lib/auth.mjs';
import { readBody, badRequest, notFound, forbidden, sendBuffer } from '../lib/http.mjs';
import { setting, setSetting } from '../lib/settings.mjs';
import { generationForDocument, recordEvent } from '../lib/doc-generation.mjs';
import { documentType } from '../lib/document-types.mjs';

const URL_TTL_SECONDS = 300;
const MAX_FILE = 32 * 1024 * 1024;

function secret(workspaceId) {
    let value = setting(workspaceId, 'document_signing_key');
    if (!value) {
        value = crypto.randomBytes(32).toString('base64');
        setSetting(workspaceId, 'document_signing_key', value);
    }
    return value;
}

function sign(workspaceId, documentId, expires) {
    return crypto.createHmac('sha256', secret(workspaceId))
        .update(`${documentId}.${expires}`)
        .digest('base64url');
}

export function signedUrl(workspaceId, documentId) {
    const expires = Math.floor(Date.now() / 1000) + URL_TTL_SECONDS;
    return `/api/documents/${documentId}/download?expires=${expires}&sig=${sign(workspaceId, documentId, expires)}`;
}

/**
 * Upload.
 *
 * Raw bytes in the body with metadata in the query string, rather than
 * multipart. One file per request, no boundary parsing, and no base64 inflating
 * a 20 MB attachment to 27 MB on the wire.
 */
export async function upload({ req, url, ctx }) {
    const name = url.searchParams.get('name');
    const parentType = url.searchParams.get('parent_type');
    const parentId = url.searchParams.get('parent_id');
    if (!name) throw badRequest('A file name is required.');
    if (!parentType || !parentId) throw badRequest('Attach the file to a record: pass parent_type and parent_id.');

    // Confirms the parent exists in THIS workspace before a byte is written.
    const parent = getRecord(parentType, ctx, parentId);
    // Reading the parent (above) only proves it is visible — uploading a file
    // onto it is a WRITE, and had no check of its own at all: a readonly
    // user could attach anything to any record in the workspace. Same rule
    // every other write to a record goes through.
    requireWrite(ctx, parent, parentType);
    const accountId = parentType === 'account' ? parent.id : parent.account_id ?? null;

    const buffer = await readBody(req);
    if (!buffer.length) throw badRequest('The file is empty.');
    if (buffer.length > MAX_FILE) throw badRequest('That file is larger than the 32 MB limit.');

    const documentId = id('doc');
    const safeName = path.basename(String(name)).replace(/[^\w.\-؀-ۿ ]+/g, '_').slice(0, 180);
    // Restricted to the file types the CRM actually knows how to hand back
    // (the same list `guessMime` below recognises) — not a security boundary
    // by itself (downloads are always served `attachment`, never executed
    // inline), but there is no reason to accept a type nothing in the product
    // opens or expects, and it closes off the class of "someone uploads
    // something nobody meant this for."
    const extension = path.extname(safeName).toLowerCase();
    if (!MIMES[extension]) {
        throw badRequest(`That file type isn't supported for upload. Allowed types: ${Object.keys(MIMES).join(', ')}.`);
    }
    // Stored under the record id, not the user's file name — two people
    // uploading "contract.pdf" must not overwrite each other.
    const storageKey = path.join(ctx.workspaceId, `${documentId}${path.extname(safeName)}`);
    writeFile(storageKey, buffer);

    insert('documents', {
        id: documentId, workspace_id: ctx.workspaceId, parent_type: parentType, parent_id: parentId,
        account_id: accountId, name: safeName, kind: 'file',
        mime: url.searchParams.get('mime') || guessMime(safeName),
        size_bytes: buffer.length, storage_key: storageKey,
        checksum: crypto.createHash('sha256').update(buffer).digest('hex'),
        uploaded_by: ctx.userId, created_at: now(),
    });
    audit(ctx, {
        objectKey: 'document', recordId: documentId, accountId, action: 'created',
        after: { name: safeName, size: buffer.length, parentType, parentId },
    });
    reindex('document', ctx.workspaceId, documentId);

    return { document: getRecord('document', ctx, documentId), url: signedUrl(ctx.workspaceId, documentId) };
}

export async function link({ params, ctx }) {
    const document = getRecord('document', ctx, params.id);
    // Asking for a link is the act of opening it. Recorded here rather than in
    // an endpoint the client is trusted to call, because a count anyone can
    // post is not a measurement — and this way the ordinary document UI counts
    // too, without knowing anything about generated documents.
    trackDocumentAccess(ctx, document.id, 'opened');
    return { url: signedUrl(ctx.workspaceId, document.id), expiresIn: URL_TTL_SECONDS, document };
}

/**
 * Notes an open or a download against the generation a document belongs to.
 *
 * Silent for uploaded documents: they have no generation, and there is nothing
 * to record. Never allowed to fail the request it is attached to — a tracking
 * write must not be the reason somebody cannot open their own contract.
 */
function trackDocumentAccess(ctx, documentId, eventType) {
    if (!ctx?.workspaceId) return;
    try {
        const generation = generationForDocument(ctx, documentId);
        if (generation) {
            recordEvent(ctx, { generationId: generation.id, documentId, eventType });
        }
    } catch {
        // Deliberately swallowed. See above.
    }
}

/**
 * Download.
 *
 * Accepts either a valid session or a signed URL, and verifies the signature in
 * constant time. An expired link is refused with an explanation rather than a
 * blank 403, because "the link expired, ask for a new one" is actionable and
 * "Forbidden" is not.
 */
export async function download({ url, params, ctx, res }) {
    const documentId = params.id;
    const expires = Number(url.searchParams.get('expires'));
    const sig = url.searchParams.get('sig');

    let workspaceId = ctx?.workspaceId;
    if (sig) {
        // The signature names the workspace implicitly: it only verifies under
        // that workspace's key, so a document cannot be fetched across tenants.
        const row = get('SELECT workspace_id FROM documents WHERE id = ?', [documentId]);
        if (!row) throw notFound('That document does not exist.');
        workspaceId = row.workspace_id;

        if (!Number.isFinite(expires) || expires * 1000 < Date.now()) {
            throw forbidden('That download link has expired. Open the record again for a fresh one.');
        }
        const expected = Buffer.from(sign(workspaceId, documentId, expires));
        const actual = Buffer.from(String(sig));
        if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
            throw forbidden('That download link is not valid.');
        }
    } else if (!ctx) {
        throw forbidden('Sign in, or use a signed link.');
    }

    const document = get('SELECT * FROM documents WHERE id = ? AND workspace_id = ?', [documentId, workspaceId]);
    if (!document || document.deleted_at) throw notFound('That document does not exist.');

    // Counted after authorisation, so a refused request is never a download.
    // A signed-link fetch has no session, and is still a real download by the
    // person we sent it to — recorded with a null user rather than dropped.
    trackDocumentAccess({ workspaceId, userId: ctx?.userId ?? null }, document.id, 'downloaded');

    // Proposals are generated, not uploaded: their bytes live in the version row.
    if (document.storage_key.startsWith('proposal:')) {
        const version = get('SELECT rendered_html FROM proposal_versions WHERE id = ?', [document.storage_key.slice(9)]);
        if (!version) throw notFound('That generated document is no longer available.');
        return sendBuffer(res, 200, Buffer.from(version.rendered_html ?? '', 'utf8'), {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Disposition': `inline; filename="${encodeURIComponent(document.name)}"`,
        });
    }

    const bytes = readFile(document.storage_key);
    if (!bytes) throw notFound('The file is missing from storage.');

    sendBuffer(res, 200, bytes, {
        'Content-Type': document.mime || 'application/octet-stream',
        // filename* carries the UTF-8 form so Arabic file names survive.
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(document.name)}`,
        'Cache-Control': 'private, max-age=60',
    });
    return undefined;
}

/**
 * A signed link for every file on an account, so "download all" can save each
 * one as the .docx it already is.
 *
 * ── WHY NOT A ZIP ───────────────────────────────────────────────────────────
 *
 * A ZIP is one more thing to extract before anyone can read a contract, and the
 * files inside it are already the finished documents. Handing back the links
 * lets the browser save them individually, each byte-identical to what the
 * template produced, and it keeps every download flowing through the same
 * signed-URL path as a single one — same authorisation, same counting, no
 * second way to get a file out of this system.
 *
 * `?category=proposal|agreement` narrows it to the generated documents of that
 * kind — what the account's two tabs are showing — and `?type=HCM_PROPOSAL` to
 * one document type. No filter takes everything attached to the account,
 * generated and uploaded alike.
 *
 * Nothing is counted here. Asking for the links is not taking the files; the
 * download endpoint counts each one when its bytes are actually fetched.
 */
export async function accountDocumentLinks({ params, url, ctx }) {
    const account = getRecord('account', ctx, params.id);
    const category = url.searchParams.get('category');
    const typeKey = url.searchParams.get('type');

    let rows = all(
        `SELECT * FROM documents
          WHERE workspace_id = ? AND account_id = ? AND deleted_at IS NULL
          ORDER BY created_at DESC`,
        [ctx.workspaceId, account.id],
    );

    if (category || typeKey) {
        // Filtered through the registry rather than on documents.kind, so this
        // and the tab it sits on can never disagree about what a proposal is.
        const generations = new Map(
            all('SELECT document_id, document_type FROM document_generations WHERE workspace_id = ? AND account_id = ?',
                [ctx.workspaceId, account.id]).map((g) => [g.document_id, g.document_type]),
        );
        rows = rows.filter((row) => {
            const key = generations.get(row.id);
            if (typeKey && key !== typeKey) return false;
            return category ? documentType(key)?.category === category : Boolean(key);
        });
    }

    // A row whose file has gone missing is REPORTED rather than quietly left out
    // of the list, so nobody counts the saved files, gets a smaller number, and
    // has to work out which one never arrived.
    const present = [];
    const missing = [];
    for (const row of rows) {
        const exists = row.storage_key.startsWith('proposal:')
            ? Boolean(get('SELECT id FROM proposal_versions WHERE id = ?', [row.storage_key.slice(9)]))
            : hasFile(row.storage_key);
        (exists ? present : missing).push(row);
    }

    return {
        documents: present.map((row) => ({
            id: row.id,
            name: row.name,
            size_bytes: row.size_bytes,
            url: signedUrl(ctx.workspaceId, row.id),
        })),
        missing: missing.map((row) => row.name),
        expiresIn: URL_TTL_SECONDS,
    };
}

const MIMES = {
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.csv': 'text/csv', '.txt': 'text/plain',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip', '.html': 'text/html', '.json': 'application/json',
};
function guessMime(name) {
    return MIMES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}
