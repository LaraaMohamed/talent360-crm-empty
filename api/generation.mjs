/**
 * Document generation endpoints.
 *
 * Thin: every decision lives in `lib/doc-generation.mjs` and the registry it
 * reads. These handlers resolve the request, check the capability, and shape
 * the response.
 *
 * ── WHY THERE IS NO "MARK AS OPENED" ENDPOINT ───────────────────────────────
 *
 * Tracking is recorded inside the EXISTING document link and download handlers
 * (api/documents.mjs) rather than as endpoints of its own. A client that has to
 * remember to report an open is a client that will forget, and a count anyone
 * can post is not a measurement. Opening a generated document through the
 * ordinary document UI is counted for the same reason.
 */
import { readBody, readJson, badRequest, notFound } from '../lib/http.mjs';
import { require$, requireWrite } from '../lib/auth.mjs';
import { all, get, run, id, now, json, REMOTE } from '../lib/db.mjs';
import { getRecord, audit, updateRecord } from '../lib/repo.mjs';
import {
    availableTypes, prefillFields, validate, previewGeneration, generate, historyFor,
    serviceSelection, setServiceSelection, commercialRegistration, serviceGate,
    installTemplate, currentTemplate, accountServiceLines,
    uploadVersion, UPLOAD_MODES,
} from '../lib/doc-generation.mjs';
import { DOCUMENT_TYPES, SERVICE_REGISTRY } from '../lib/document-types.mjs';
import { setting } from '../lib/settings.mjs';

const MAX_TEMPLATE = 32 * 1024 * 1024;

/* ------------------------------------------------------- the wizard data -- */

/**
 * Everything the generate dialog needs, in one call: which documents this
 * account can produce, the HCM scopes, and the prefilled values for each type.
 *
 * One request rather than four because the dialog cannot usefully render until
 * it has all of it, and four round trips is four chances to show a half-built
 * form.
 *
 * A deal id in the query narrows it to that deal and records the generation
 * against it. The two entry points share this handler entirely, which is what
 * stops the deal flow and the account flow from drifting apart.
 */
function documentOptions(ctx, subject) {
    const gate = serviceGate(ctx, subject);
    const types = gate.ok ? availableTypes(ctx, subject) : [];

    const prefills = {};
    for (const type of types) {
        // A type with no template cannot be generated; asking for its prefill
        // would only produce values nobody can use.
        if (!type.template) continue;
        prefills[type.key] = prefillFields(ctx, subject, type.key).fields;
    }

    return {
        gate,
        types: types.map(({ template, ...rest }) => ({
            ...rest,
            template: template ? { id: template.id, label: template.label, version: template.version } : null,
        })),
        // The workspace's service LINES — hcm, offshoring — which is what the
        // account buys and what decides which documents exist. Not to be
        // confused with `services` below, the scopes inside an HCM document.
        // The wizard offers these so a service can be chosen while writing the
        // proposal and recorded on the account, rather than being a precondition
        // somebody has to go and satisfy somewhere else first.
        serviceLines: all(
            'SELECT key, label FROM service_lines WHERE workspace_id = ? ORDER BY position',
            [ctx.workspaceId],
        ),
        services: SERVICE_REGISTRY.map((s) => ({ key: s.key, label: s.labelEn, labelAr: s.labelAr })),
        selectedServices: serviceSelection(ctx, {
            accountId: subject.accountId, dealId: subject.dealId ?? null,
        }),
        prefills,
        // The dialog finishes the job `prefillFields` can only start: it derives
        // the end date server-side, but on a first generation there is no start
        // date yet to derive it from, so the field the hint promises would be
        // filled in stays empty. The term goes with it so the browser applies
        // the workspace's convention rather than assuming a year.
        contractYears: Number(setting(ctx.workspaceId, 'doc_default_contract_years')) || 1,
    };
}

/**
 * Everything the dialog shows ABOUT the client, read from the account rather
 * than asked for again. The document is written from the company record;
 * this is that record, not a copy of it. Shared between the account and the
 * deal entry points — the deal one used to skip this entirely, so `account`
 * was undefined for the whole dialog and every `options.account.id` in the
 * frontend threw the moment it was reached.
 */
function accountFields(ctx, accountId) {
    const account = getRecord('account', ctx, accountId);
    return {
        account: {
            id: account.id, name: account.name, legal_name: account.legal_name,
            lifecycle_stage: account.lifecycle_stage, industry: account.industry,
            country: account.country, city: account.city,
            phone: account.phone, website: account.website, domain: account.domain,
            cr_number: account.cr_number,
            serviceLines: accountServiceLines(account),
        },
        contacts: all(
            `SELECT id, full_name, first_name, last_name, title, email FROM contacts
              WHERE workspace_id = ? AND account_id = ? AND deleted_at IS NULL
              ORDER BY last_name, first_name LIMIT 100`,
            [ctx.workspaceId, account.id],
        ),
    };
}

/** The generate dialog's data, for an account. */
export async function accountDocumentOptions({ params, url, ctx }) {
    const account = getRecord('account', ctx, params.id);
    const dealId = url.searchParams.get('deal') || null;
    const subject = { accountId: account.id, dealId };

    return {
        ...accountFields(ctx, account.id),
        registration: commercialRegistration(ctx, account.id),
        ...documentOptions(ctx, subject),
    };
}

/** The same dialog, opened from a deal. */
export async function dealDocumentOptions({ params, ctx }) {
    const deal = getRecord('deal', ctx, params.id);
    const subject = { accountId: deal.account_id, dealId: deal.id };
    return {
        deal: { id: deal.id, name: deal.name, account_id: deal.account_id, service_line_key: deal.service_line_key },
        ...accountFields(ctx, deal.account_id),
        registration: commercialRegistration(ctx, deal.account_id),
        ...documentOptions(ctx, subject),
    };
}

/**
 * The review step: the variable map, with every value resolved, before anything
 * is written.
 *
 * A POST because it takes the form values being reviewed — this is a question
 * about a proposed document, not a fetch of a stored one, and it writes nothing.
 */
export async function previewForAccount({ req, params, ctx }) {
    const body = await readJson(req);
    if (!DOCUMENT_TYPES[body.documentType]) throw badRequest('Choose a document type.');
    return previewGeneration(ctx, {
        accountId: params.id,
        dealId: body.dealId ?? null,
        docTypeKey: body.documentType,
        fields: body.fields ?? {},
        services: Array.isArray(body.services) ? body.services : null,
    });
}

/** Dry run: the same checks generation makes, without writing anything. */
export async function checkGeneration({ req, params, ctx }) {
    const body = await readJson(req);
    const { problems } = validate(ctx, {
        dealId: params.id, docTypeKey: body.documentType, fields: body.fields ?? {},
        services: Array.isArray(body.services) ? body.services : null,
    });
    return { ok: problems.length === 0, problems };
}

/**
 * Generation, from an account.
 *
 * The scope selection travels WITH the request and is saved as part of it, so
 * what the review screen showed is what the document contains — a separate
 * "save services" call could succeed while the generation failed, leaving the
 * account describing a document that was never produced.
 */
export async function generateForAccount({ req, params, ctx }) {
    require$(ctx, 'proposal.issue');
    const account = getRecord('account', ctx, params.id);
    const body = await readJson(req);
    if (!DOCUMENT_TYPES[body.documentType]) throw badRequest('Choose a document type.');

    const services = Array.isArray(body.services) ? body.services : null;
    const result = generate(ctx, {
        accountId: account.id,
        dealId: body.dealId ?? null,
        docTypeKey: body.documentType,
        fields: body.fields ?? {},
        services,
        contactId: body.contactId ?? null,
    });

    if (services && DOCUMENT_TYPES[body.documentType].hasServiceSelection) {
        setServiceSelection(ctx, { accountId: account.id, dealId: body.dealId ?? null }, services);
    }

    return {
        generation: { id: result.generation.id, version: result.generation.version },
        document: result.document,
        record: result.record,
    };
}

export async function generateForDeal({ req, params, ctx }) {
    require$(ctx, 'proposal.issue');
    const deal = getRecord('deal', ctx, params.id);
    const body = await readJson(req);
    if (!DOCUMENT_TYPES[body.documentType]) throw badRequest('Choose a document type.');

    const services = Array.isArray(body.services) ? body.services : null;
    const result = generate(ctx, {
        accountId: deal.account_id,
        dealId: deal.id,
        docTypeKey: body.documentType,
        fields: body.fields ?? {},
        services,
        contactId: body.contactId ?? null,
    });
    if (services && DOCUMENT_TYPES[body.documentType].hasServiceSelection) {
        setServiceSelection(ctx, { accountId: deal.account_id, dealId: deal.id }, services);
    }
    return {
        generation: { id: result.generation.id, version: result.generation.version },
        document: result.document,
        record: result.record,
    };
}

/**
 * A renewal: the exact same signed agreement, regenerated with new dates.
 *
 * "The same template except for the date" is read literally — this does not
 * open the generation wizard a second time for someone to retype the client
 * name, the price and the terms they already confirmed once. It reads the
 * ORIGINAL generation's own `fields` and `services` straight back (the same
 * mechanism the Internal Team Proposal uses to reproduce a source document
 * exactly — see `fromDocxSource` in lib/internal-proposal.mjs) and reruns
 * `generate()` with only `start_date`/`end_date` replaced.
 *
 * The two facts that make it a renewal and not a second original: `type:
 * 'renewal'` and `supersedes_agreement_id` pointing at the contract it
 * replaces — the chain the agreements table has carried since it was built
 * and nothing had ever written to.
 */
export async function renewAgreement({ req, params, ctx }) {
    require$(ctx, 'proposal.issue');
    const source = getRecord('agreement', ctx, params.id);
    if (!source.document_type || !source.document_id) {
        throw badRequest(
            'This agreement was not generated from a template, so there is nothing to regenerate from the same way. '
            + 'Create the renewal as a new agreement and set "Supersedes" to this one.',
        );
    }
    const body = await readJson(req);
    if (!body.startDate || !body.endDate) throw badRequest('Pick the renewal’s start and end dates.');

    const generation = get(
        `SELECT * FROM document_generations WHERE workspace_id = ? AND document_id = ? ORDER BY created_at DESC LIMIT 1`,
        [ctx.workspaceId, source.document_id],
    );
    if (!generation) {
        throw badRequest('The generation this agreement was produced from could not be found, so it cannot be regenerated automatically.');
    }

    const fields = { ...json(generation.fields, {}), start_date: body.startDate, end_date: body.endDate };
    const services = json(generation.services, []);

    const result = generate(ctx, {
        accountId: source.account_id,
        dealId: source.deal_id,
        docTypeKey: source.document_type,
        fields,
        services: services.length ? services : null,
        recordOverrides: {
            title: source.title.startsWith('Renewal — ') ? source.title : `Renewal — ${source.title}`,
            type: 'renewal',
            supersedesAgreementId: source.id,
        },
    });

    return {
        generation: { id: result.generation.id, version: result.generation.version },
        document: result.document,
        record: result.record,
    };
}

/**
 * Uploading a proposal or agreement produced outside the CRM.
 *
 * `readBody` rather than `readJson`: this is the file's bytes, with the name,
 * the type and the mode in the query string — the same shape the ordinary
 * document upload uses, so the browser can post a File without a multipart
 * parser existing anywhere in this codebase.
 *
 * Takes `proposal.issue`, which is what a rep holds and what generating takes:
 * putting a version on the record is drafting, and the approval that follows is
 * the gate. Writing to the ACCOUNT is checked too, for the same reason the
 * generation wizard checks it.
 */
export async function uploadDocumentVersion({ req, url, params, ctx }) {
    require$(ctx, 'proposal.issue');
    const account = getRecord('account', ctx, params.id);
    requireWrite(ctx, account, 'account');

    const documentType = url.searchParams.get('type');
    if (!DOCUMENT_TYPES[documentType]) throw badRequest('Choose which document this is a version of.');

    const bytes = await readBody(req);
    if (bytes.length > MAX_TEMPLATE) throw badRequest('That file is larger than the 32 MB limit.');

    return uploadVersion(ctx, {
        accountId: account.id,
        dealId: url.searchParams.get('deal') || null,
        docTypeKey: documentType,
        fileName: url.searchParams.get('name') || 'upload.docx',
        bytes,
        mode: url.searchParams.get('mode') || 'new_version',
        note: url.searchParams.get('note') || null,
    });
}

export async function dealDocumentHistory({ params, ctx }) {
    getRecord('deal', ctx, params.id);
    return { documents: historyFor(ctx, { dealId: params.id }) };
}

/**
 * `?category=proposal|agreement` is what the account's two tabs ask for, and
 * `?type=HCM_PROPOSAL` narrows to one document type — what a single proposal or
 * agreement record asks for to find its own document among that account's.
 */
export async function accountDocumentHistory({ params, url, ctx }) {
    getRecord('account', ctx, params.id);
    return {
        documents: historyFor(ctx, {
            accountId: params.id,
            category: url.searchParams.get('category') || null,
            documentType: url.searchParams.get('type') || null,
        }),
    };
}

/* ---------------------------------------------------- service selection -- */

export async function getAccountServices({ params, url, ctx }) {
    const account = getRecord('account', ctx, params.id);
    return {
        services: SERVICE_REGISTRY.map((s) => ({ key: s.key, label: s.labelEn, labelAr: s.labelAr })),
        selected: serviceSelection(ctx, { accountId: account.id, dealId: url.searchParams.get('deal') || null }),
    };
}

export async function putAccountServices({ req, params, ctx }) {
    const account = getRecord('account', ctx, params.id);
    /**
     * Writing a fact about the ACCOUNT, so it takes the account's write rule.
     *
     * This asked for `record.write.all`, which a rep does not hold — so a rep
     * generating an agreement was refused at the wizard's first step with
     * "cannot record write all", on a screen they are explicitly meant to use.
     * A rep may edit accounts (SHARED_OBJECTS in lib/auth.mjs); they may not
     * delete, and that is unchanged.
     */
    requireWrite(ctx, account, 'account');
    const body = await readJson(req);
    if (!Array.isArray(body.services) || body.services.length === 0) {
        throw badRequest('At least one service scope must stay selected.');
    }
    const selected = setServiceSelection(
        ctx, { accountId: account.id, dealId: body.dealId ?? null }, body.services,
    );
    audit(ctx, {
        objectKey: 'account', recordId: account.id, accountId: account.id,
        action: 'hcm_services_changed', after: { services: selected, deal_id: body.dealId ?? null },
    });
    return { selected };
}

export async function getServices({ params, ctx }) {
    const deal = getRecord('deal', ctx, params.id);
    return {
        services: SERVICE_REGISTRY.map((s) => ({ key: s.key, label: s.labelEn, labelAr: s.labelAr })),
        selected: serviceSelection(ctx, { accountId: deal.account_id, dealId: deal.id }),
    };
}

export async function putServices({ req, params, ctx }) {
    const deal = getRecord('deal', ctx, params.id);
    // The scope belongs to the account's document, not to whoever owns the
    // deal record, so it takes the account's write rule.
    requireWrite(ctx, getRecord('account', ctx, deal.account_id), 'account');
    const body = await readJson(req);
    if (!Array.isArray(body.services) || body.services.length === 0) {
        throw badRequest('At least one service scope must stay selected.');
    }
    const selected = setServiceSelection(ctx, { accountId: deal.account_id, dealId: deal.id }, body.services);
    audit(ctx, {
        objectKey: 'deal', recordId: deal.id, accountId: deal.account_id,
        action: 'hcm_services_changed', after: { services: selected },
    });
    return { selected };
}

/* ----------------------------------------------- commercial registration -- */

export async function getRegistration({ params, ctx }) {
    getRecord('account', ctx, params.id);
    return { registration: commercialRegistration(ctx, params.id) };
}

/**
 * The First Party block, entered by hand.
 *
 * Held at account level because it is a fact about the company. Every agreement
 * already generated keeps its own frozen copy, so editing this never rewrites
 * a contract that has been issued.
 */
export async function putRegistration({ req, params, ctx }) {
    const account = getRecord('account', ctx, params.id);
    // The registration is the account's own paperwork.
    requireWrite(ctx, account, 'account');
    const body = await readJson(req);

    const fields = {
        company_name_ar: String(body.company_name_ar ?? '').trim() || null,
        cr_number: String(body.cr_number ?? '').trim() || null,
        representative_name: String(body.representative_name ?? '').trim() || null,
        address: String(body.address ?? '').trim() || null,
    };

    const existing = commercialRegistration(ctx, account.id);
    if (existing) {
        run(
            `UPDATE commercial_registrations
                SET company_name_ar = ?, cr_number = ?, representative_name = ?, address = ?,
                    updated_at = ?
              WHERE id = ?`,
            [fields.company_name_ar, fields.cr_number, fields.representative_name,
                fields.address, now(), existing.id],
        );
    } else {
        run(
            `INSERT INTO commercial_registrations
               (id, workspace_id, account_id, company_name_ar, cr_number, representative_name, address, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [id('crg'), ctx.workspaceId, account.id, fields.company_name_ar, fields.cr_number,
                fields.representative_name, fields.address, now(), now()],
        );
    }

    audit(ctx, {
        objectKey: 'account', recordId: account.id, accountId: account.id,
        action: existing ? 'commercial_registration_updated' : 'commercial_registration_added',
        before: existing ? { cr_number: existing.cr_number } : null,
        after: { cr_number: fields.cr_number },
    });

    /**
     * The account carries the same two facts, so it learns them here.
     *
     * `accounts.cr_number` and `accounts.legal_name` are fields on the record
     * everybody reads, and they are the same statements as the registration's
     * `cr_number` and `company_name_ar` — the account field even describes
     * itself as "the registered name, often in Arabic". They were being written
     * in one place and read in the other, so typing a CR number while
     * generating a contract left the account page still showing nothing, and
     * the strongest natural key this CRM has stayed blank on the record that
     * duplicate detection actually searches.
     *
     * Through `updateRecord` rather than an UPDATE, so the change is audited
     * and the search index is rebuilt — both fields are searchable, and a CR
     * number nobody can find is barely recorded.
     *
     * Only ever fills from a value the registration actually has: clearing a
     * field on the registration does not blank the account.
     */
    const patch = {};
    if (fields.cr_number && fields.cr_number !== account.cr_number) patch.cr_number = fields.cr_number;
    if (fields.company_name_ar && fields.company_name_ar !== account.legal_name) {
        patch.legal_name = fields.company_name_ar;
    }
    if (Object.keys(patch).length) {
        updateRecord('account', ctx, account.id, patch, {
            source: 'automation', reason: 'Commercial registration',
        });
    }

    return { registration: commercialRegistration(ctx, account.id), account: getRecord('account', ctx, account.id) };
}

/* ------------------------------------------------------------ templates -- */

export async function listTemplates({ ctx }) {
    return {
        templates: Object.values(DOCUMENT_TYPES).map((dt) => {
            const template = currentTemplate(ctx.workspaceId, dt.templateKey);
            return {
                key: dt.templateKey,
                documentType: dt.key,
                label: dt.label,
                installed: template
                    ? {
                        id: template.id, label: template.label, version: template.version,
                        checksum: template.checksum, size_bytes: template.size_bytes,
                        created_at: template.created_at,
                    }
                    : null,
            };
        }),
    };
}

export async function uploadTemplate({ req, url, ctx }) {
    require$(ctx, 'record.write.all');
    const templateKey = url.searchParams.get('key');
    if (!templateKey) throw badRequest('Which template is this? Pass ?key=.');

    /**
     * Refused here, at the real upload endpoint, rather than left as a
     * warning alongside a "successful" install: `installTemplate` retires
     * whichever template currently works the moment it inserts the new row,
     * and `currentTemplate` always serves the newest non-retired one
     * regardless of where its bytes actually live. Without a Turso
     * connection those bytes go to this machine's local disk only — gone the
     * moment this process ends, invisible to Render or anywhere else. That is
     * exactly how the HCM and Offshoring proposal templates were lost once
     * already: installed from a local session with no TURSO_URL set, nobody
     * noticed the warning, and the first sign anything was wrong was
     * production refusing to generate from it. `installTemplate` itself is
     * left alone — the test suite installs fixture templates against a local
     * throwaway database on purpose, and that is a legitimate, different use
     * from an admin updating the template real reps generate contracts from.
     */
    if (!REMOTE) {
        throw badRequest('This server has no connection to the hosted database right now, so a new template cannot be installed safely — it would only save to local disk and silently replace the template that currently works. Connect to the hosted database (TURSO_URL) and try again.');
    }

    const buffer = await readBody(req);
    if (!buffer.length) throw badRequest('The file is empty.');
    if (buffer.length > MAX_TEMPLATE) throw badRequest('That file is larger than the 32 MB limit.');

    const template = installTemplate(ctx, {
        templateKey,
        label: url.searchParams.get('name') || templateKey,
        buffer,
        fileName: url.searchParams.get('name'),
    });
    audit(ctx, {
        objectKey: 'document', recordId: template.id,
        action: 'document_template_installed',
        after: { key: templateKey, version: template.version, checksum: template.checksum },
    });
    return { template };
}
