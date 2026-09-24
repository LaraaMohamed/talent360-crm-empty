/**
 * Import endpoints.
 *
 * The flow the docs specify, one endpoint per step:
 *
 *   profile   what is in this file, and what does each column look like
 *   preview   exactly what execution will do — create/update/skip/reject
 *   execute   the same walk, writing
 *   summary   a record that outlives the browser tab
 *   undo      removes what the batch created, and says what it did not revert
 *
 * The file itself is held by the CLIENT between profile and execute rather than
 * in a server-side session. That keeps the server stateless, means a refresh
 * cannot strand a half-configured import, and makes the preview and the run
 * demonstrably the same bytes.
 */
import {
    profile, process as runImport, createBatch, finishBatch, listBatches, batchDetail,
    undoBatch, saveTemplate, listTemplates, deleteTemplate, IMPORTABLE_OBJECTS,
    uploadHistory, deleteUpload, restoreUpload,
} from '../lib/import.mjs';
import { profileCustomers, processCustomers } from '../lib/import-customers.mjs';
import { objectFromRoute } from './records.mjs';
import { readBody, readJson, badRequest, sendBuffer } from '../lib/http.mjs';
import { require$, can } from '../lib/auth.mjs';
import { audit } from '../lib/repo.mjs';
import { toCsvRows } from '../lib/csv.mjs';
import { OBJECTS } from '../lib/objects.mjs';

/**
 * Step 1–2: parse and describe.
 *
 * Takes the raw file as the body, so a 20 MB lead list is not base64-inflated
 * to 27 MB on the wire. Nothing is written and nothing is remembered.
 */
export async function profileFile({ req, url, ctx }) {
    requireImport(ctx);
    const objectKey = objectKeyFrom(url);
    const text = (await readBody(req)).toString('utf8');
    if (!text.trim()) throw badRequest('That file is empty.');

    const result = await profile(text, objectKey, ctx.workspaceId);
    return {
        ...result,
        templates: listTemplates(ctx, objectKey),
        objects: IMPORTABLE_OBJECTS,
    };
}

/** Step 3–6: classify every row, write nothing. */
export async function preview({ req, url, ctx }) {
    requireImport(ctx);
    const objectKey = objectKeyFrom(url);
    const body = await readJson(req);
    if (!body.text) throw badRequest('Send the file contents as `text`.');

    const result = await runImport(ctx, {
        text: body.text,
        objectKey,
        mapping: body.mapping,
        defaults: body.defaults,
        duplicateStrategy: body.duplicateStrategy ?? 'update',
        apply: false,
    });

    return {
        ...result,
        // Only the first slice of per-row detail travels back: the counts and
        // the grouped reasons are what a decision is made on, and 10,000 row
        // objects would make the preview slower than the import.
        results: result.results.slice(0, 100),
        truncatedResults: result.results.length > 100,
        note: 'These counts are produced by the same code that will run the import, over the same rows. '
            + 'Execution will do exactly this.',
    };
}

/**
 * Step 7–8: execute, and record a summary that outlives the tab.
 *
 * Runs under the CALLER's permissions — every row goes through the normal
 * create/update path, so an import cannot write a field or a record the user
 * could not write by hand.
 */
export async function execute({ req, url, ctx }) {
    requireImport(ctx);
    const objectKey = objectKeyFrom(url);
    const body = await readJson(req);
    if (!body.text) throw badRequest('Send the file contents as `text`.');

    const batchId = createBatch(ctx, {
        objectKey,
        filename: body.filename,
        source: body.source ?? 'upload',
        mapping: body.mapping,
        options: { defaults: body.defaults ?? {}, duplicateStrategy: body.duplicateStrategy ?? 'update' },
        totalRows: 0,
    });

    let result;
    try {
        result = await runImport(ctx, {
            text: body.text,
            objectKey,
            mapping: body.mapping,
            defaults: body.defaults,
            duplicateStrategy: body.duplicateStrategy ?? 'update',
            apply: true,
            batchId,
        });
    } catch (err) {
        finishBatch(ctx, batchId, { create: 0, update: 0, skip: 0, reject: 0 }, err.message);
        throw err;
    }

    finishBatch(ctx, batchId, result.counts);
    audit(ctx, {
        objectKey,
        recordId: null,
        action: 'imported',
        after: { batchId, filename: body.filename ?? null, ...result.counts },
    });

    return {
        batchId,
        ...result,
        results: result.results.slice(0, 100),
        truncatedResults: result.results.length > 100,
    };
}

/* ------------------------------------------------ existing customers --- */

/**
 * The same four-step shape (profile, preview, execute) as the generic
 * importer above, aimed at `lib/import-customers.mjs` instead — one file
 * mapped once, writing Account + Contact + Deal + Agreement together. See
 * that module's header for why it is not just another `objectKey`.
 */
export async function profileCustomersFile({ req, ctx }) {
    requireImport(ctx);
    const text = (await readBody(req)).toString('utf8');
    if (!text.trim()) throw badRequest('That file is empty.');
    return profileCustomers(text);
}

export async function previewCustomers({ req, ctx }) {
    requireImport(ctx);
    const body = await readJson(req);
    if (!body.text) throw badRequest('Send the file contents as `text`.');
    const result = await processCustomers(ctx, { text: body.text, mapping: body.mapping, apply: false });
    return {
        ...result,
        results: result.results.slice(0, 100),
        truncatedResults: result.results.length > 100,
        note: 'These counts are produced by the same code that will run the import, over the same rows. '
            + 'Execution will do exactly this.',
    };
}

export async function executeCustomers({ req, ctx }) {
    requireImport(ctx);
    const body = await readJson(req);
    if (!body.text) throw badRequest('Send the file contents as `text`.');

    const batchId = createBatch(ctx, {
        objectKey: 'account', filename: body.filename, source: 'upload',
        mapping: body.mapping, options: { workflow: 'existing_customers' }, totalRows: 0,
    });

    let result;
    try {
        result = await processCustomers(ctx, { text: body.text, mapping: body.mapping, apply: true, batchId });
    } catch (err) {
        finishBatch(ctx, batchId, { create: 0, update: 0, skip: 0, reject: 0 }, err.message);
        throw err;
    }

    finishBatch(ctx, batchId, {
        create: result.counts.rows.create, update: 0, skip: 0, reject: result.counts.rows.reject,
    });
    audit(ctx, {
        objectKey: 'account', recordId: null, action: 'imported',
        after: { batchId, filename: body.filename ?? null, workflow: 'existing_customers', ...result.counts },
    });

    return {
        batchId,
        ...result,
        results: result.results.slice(0, 100),
        truncatedResults: result.results.length > 100,
    };
}

export async function summaries({ ctx }) {
    return { batches: listBatches(ctx), objects: IMPORTABLE_OBJECTS };
}

export async function summary({ params, ctx }) {
    const detail = batchDetail(ctx, params.id);
    return {
        ...detail,
        rows: detail.rows.slice(0, 200),
        rowsTruncated: detail.rows.length > 200,
    };
}

/** The rejected rows, as a CSV you can fix and re-upload. */
export async function errorReport({ params, ctx, res }) {
    const { batch, rejected } = batchDetail(ctx, params.id);
    const columns = [
        { key: 'row_number', label: 'Row' },
        { key: 'reason', label: 'Why it was rejected' },
        { key: 'raw', label: 'Original row' },
    ];
    const body = await toCsvRows(columns, rejected, (row, column) => {
        if (column.key === 'raw') {
            try { return JSON.parse(row.raw).join(' | '); } catch { return row.raw ?? ''; }
        }
        return row[column.key] ?? '';
    });
    sendBuffer(res, 200, Buffer.from(body, 'utf8'), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="import ${batch.id} rejected.csv"`,
    });
    return undefined;
}

export async function undo({ params, ctx }) {
    require$(ctx, 'record.delete');
    return undoBatch(ctx, params.id);
}

/* -------------------------------------------------------- upload history -- */

/**
 * Every upload ever made, with the current state of what it brought in.
 *
 * Separate from `summaries` on purpose. That endpoint answers "what did the
 * importer DO?" — created/updated/skipped/rejected, frozen at run time. This one
 * answers "where did those companies GET TO?" — qualified, in review, imported —
 * which keeps moving. Two different questions with two different lifetimes; one
 * endpoint returning both would have to explain which numbers were stale.
 */
export async function uploads({ url, ctx }) {
    const { records, total, page, pages, limit } = uploadHistory(ctx, {
        limit: Number(url.searchParams.get('limit')) || 50,
        page: Number(url.searchParams.get('page')) || 1,
        includeDeleted: url.searchParams.get('deleted') === '1',
    });
    return { uploads: records, total, page, pages, limit };
}

export async function removeUpload({ params, ctx }) {
    require$(ctx, 'record.delete');
    const result = deleteUpload(ctx, params.id);
    return {
        ...result,
        note: result.keptBecauseImported
            ? `${result.removed} companies moved to the Recycle Bin. `
              + `${result.keptBecauseImported} were left because they have already been imported into the CRM — `
              + 'their Accounts are being worked, and withdrawing them would take live opportunities off a desk.'
            : `${result.removed} companies moved to the Recycle Bin. Restore the upload to bring them back.`,
    };
}

export async function undeleteUpload({ params, ctx }) {
    require$(ctx, 'record.delete');
    return restoreUpload(ctx, params.id);
}

/* ----------------------------------------------------------- templates -- */

export async function templates({ url, ctx }) {
    return { templates: listTemplates(ctx, url.searchParams.get('object')) };
}

export async function createTemplate({ req, ctx }) {
    requireImport(ctx);
    const body = await readJson(req);
    if (!body.name?.trim()) throw badRequest('Give the template a name.');
    if (!OBJECTS[body.object_key]) throw badRequest(`Unknown object "${body.object_key}".`);
    const templateId = saveTemplate(ctx, {
        objectKey: body.object_key,
        name: body.name.trim(),
        mapping: body.mapping ?? {},
        options: body.options ?? {},
    });
    return { id: templateId, templates: listTemplates(ctx, body.object_key) };
}

export async function removeTemplate({ params, ctx }) {
    requireImport(ctx);
    return deleteTemplate(ctx, params.id);
}

/* ------------------------------------------------------------- helpers -- */

function requireImport(ctx) {
    require$(ctx, can(ctx, 'record.write.all') ? 'record.write.all' : 'record.write.own');
}

function objectKeyFrom(url) {
    const route = url.searchParams.get('object');
    if (!route) throw badRequest('Say which object to import into, e.g. ?object=accounts.');
    // Accepts either the route segment ("accounts") or the object key
    // ("account"), because both appear in the UI and neither is wrong.
    return OBJECTS[route] ? route : objectFromRoute(route);
}
