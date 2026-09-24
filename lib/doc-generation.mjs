/**
 * Generating a proposal or agreement for an account.
 *
 * The CRM-facing half of the Apps Script port: this is where CRM data meets
 * `lib/document-types.mjs` (the registry) and `lib/docx-template.mjs` (the
 * engine). Neither of those knows anything about deals, accounts or SQLite, and
 * that separation is what makes the parity tests possible without a database.
 *
 * ── WHY THE ACCOUNT IS THE SUBJECT ──────────────────────────────────────────
 *
 * The Apps Script generated from an Opportunity because a row in a sheet was
 * the only record it had. Everything a proposal actually needs — the company
 * name, the commercial registration, the services sold, the contacts — is a
 * fact about the COMPANY, and in this CRM that is the account. Requiring a deal
 * first put a second record between the user and a document that never needed
 * one, which is why nothing could be generated in a workspace with hundreds of
 * accounts and no deals.
 *
 * A deal is therefore optional context: pass one and it is recorded on the
 * generation and its scope selection is read in preference to the account's.
 * Everything else is identical, so the two entry points cannot diverge.
 *
 * ── WHAT THIS REUSES RATHER THAN REBUILDS ───────────────────────────────────
 *
 * The generated file is a row in `documents`, stored and served exactly like an
 * uploaded one — same folder, same signed URLs, same authorisation. It hangs
 * off the account, so it appears there with no new plumbing.
 * `document_generations` adds only what `documents` cannot answer: which
 * template and which inputs produced this file, and which version it is.
 *
 * ── NOTHING PARTIAL IS EVER SAVED ───────────────────────────────────────────
 *
 * Validation runs before a byte is written; the render is checked for leftover
 * `{{TOKENS}}` before the file is created; and the file, the `documents` row and
 * the `document_generations` row are written in one transaction. A failure
 * leaves no half-made contract behind for someone to send.
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { all, get, run, tx, id, now, json, REMOTE } from './db.mjs';
import { writeFile, readFile, removeFile } from './document-store.mjs';
import { badRequest, notFound } from './http.mjs';
import {
    getRecord, insert, update, audit, reindex, nextDocumentNumber, moveDealForAgreement, advanceDealForProposal,
    ensureDealForAgreement, syncAgreementAndDeal,
} from './repo.mjs';
import { openApprovalTask } from './approvals.mjs';
import { setting } from './settings.mjs';
import { deriveValues } from './money.mjs';
import { readZip, readPart, writeZip } from './docx.mjs';
import { renderDocumentXml, stripYellow, FORMATTED_PARTS } from './docx-template.mjs';
import {
    DOCUMENT_TYPES, documentType, documentTypesForProduct, enabledServicesFor,
    validateGeneration, buildDocumentName, computeContractEndDate, formatDate,
    normalizeDateValue, parseDateValue,
    describeVariables, SOURCE, SERVICE_KEYS, SERVICE_REGISTRY,
} from './document-types.mjs';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/* ------------------------------------------------------------- templates -- */

/** The current (non-retired) template for a document type, or null. */
export function currentTemplate(workspaceId, templateKey) {
    return get(
        `SELECT * FROM document_templates
          WHERE workspace_id = ? AND key = ? AND retired_at IS NULL
          ORDER BY version DESC LIMIT 1`,
        [workspaceId, templateKey],
    ) ?? null;
}

/**
 * The .docx a template row points at. A row whose bytes have gone is worth
 * saying out loud — it is the difference between "this template is broken" and
 * a stack trace about a missing path.
 */
function templateBytes(template) {
    const bytes = readFile(template.storage_key);
    if (!bytes) {
        throw notFound(`The file for template "${template.key}" (v${template.version}) is missing from storage. Upload it again.`);
    }
    return bytes;
}

/**
 * Registers a .docx as the template for a document type.
 *
 * Uploading a new one supersedes rather than replaces: the old row is retired,
 * keeping every past generation's `template_id` pointing at the bytes that
 * actually produced it.
 */
export function installTemplate(ctx, { templateKey, label, buffer, fileName }) {
    if (!Object.values(DOCUMENT_TYPES).some((dt) => dt.templateKey === templateKey)) {
        throw badRequest(`"${templateKey}" is not a known template.`);
    }
    // Parsed before it is stored: a file that is not a readable .docx must be
    // refused here, not discovered by the first person trying to send a contract.
    try {
        readPart(readZip(buffer), 'word/document.xml');
    } catch (err) {
        throw badRequest(`That file is not a readable .docx template: ${err.message}`);
    }

    const previous = currentTemplate(ctx.workspaceId, templateKey);
    const templateId = id('tpl');
    const storageKey = path.join(ctx.workspaceId, 'templates', `${templateId}.docx`);
    writeFile(storageKey, buffer);

    if (previous) run('UPDATE document_templates SET retired_at = ? WHERE id = ?', [now(), previous.id]);
    insert('document_templates', {
        id: templateId, workspace_id: ctx.workspaceId, key: templateKey,
        label: label ?? fileName ?? templateKey,
        version: (previous?.version ?? 0) + 1,
        storage_key: storageKey,
        checksum: crypto.createHash('sha256').update(buffer).digest('hex'),
        size_bytes: buffer.length, uploaded_by: ctx.userId ?? null, created_at: now(),
    });
    return {
        ...get('SELECT * FROM document_templates WHERE id = ?', [templateId]),
        remoteStored: REMOTE,
    };
}

/* ------------------------------------------------------ account context -- */

/**
 * Resolves the subject of a generation: an account, and optionally a deal.
 *
 * Accepts either shape — `{ accountId }`, `{ dealId }`, or both — so the
 * account page, the deal page and every test can call the same functions. A
 * deal always resolves its own account, and a deal that names a different
 * account than the one passed is a caller bug rather than something to
 * silently pick a winner for.
 */
export function resolveSubject(ctx, { accountId = null, dealId = null } = {}) {
    const deal = dealId ? getRecord('deal', ctx, dealId) : null;
    if (deal && !deal.account_id) {
        throw badRequest('This deal is not linked to an account, and every document names the client.');
    }
    const id$ = accountId ?? deal?.account_id ?? null;
    if (!id$) throw badRequest('A document is generated for an account. None was given.');
    if (deal && accountId && deal.account_id !== accountId) {
        throw badRequest('That deal belongs to a different account.');
    }
    return { account: getRecord('account', ctx, id$), deal };
}

/** The service lines this account buys — `accounts.services`, as keys. */
export function accountServiceLines(account) {
    const list = json(account?.services, []);
    return Array.isArray(list) ? list.filter(Boolean).map(String) : [];
}

/**
 * The HCM scope selection that applies here. Everything on, until someone says
 * otherwise — the same default the Apps Script's blank selection row had.
 *
 * A deal reads its OWN row first and falls back to the account's, so scoping a
 * deal differently is possible without making every account-level document ask
 * a question it already has an answer to.
 */
export function serviceSelection(ctx, { accountId, dealId = null } = {}) {
    const row = (dealId && get(
        'SELECT services FROM hcm_service_selections WHERE workspace_id = ? AND account_id = ? AND deal_id = ?',
        [ctx.workspaceId, accountId, dealId],
    )) || get(
        "SELECT services FROM hcm_service_selections WHERE workspace_id = ? AND account_id = ? AND deal_id = ''",
        [ctx.workspaceId, accountId],
    );
    if (!row) return [...SERVICE_KEYS];
    const chosen = json(row.services, []);
    // Filtered through the canonical order, so a stored list can never change
    // the numbering by being saved in click order.
    return SERVICE_KEYS.filter((key) => chosen.includes(key));
}

export function setServiceSelection(ctx, { accountId, dealId = null }, keys) {
    const clean = SERVICE_KEYS.filter((key) => (keys ?? []).includes(key));
    run(
        `INSERT INTO hcm_service_selections (workspace_id, account_id, deal_id, services, updated_at, updated_by)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(workspace_id, account_id, deal_id) DO UPDATE SET
           services = excluded.services, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        [ctx.workspaceId, accountId, dealId ?? '', JSON.stringify(clean), now(), ctx.userId ?? null],
    );
    return clean;
}

export function commercialRegistration(ctx, accountId) {
    return get('SELECT * FROM commercial_registrations WHERE workspace_id = ? AND account_id = ?',
        [ctx.workspaceId, accountId]) ?? null;
}

/**
 * Whether the account has ANY commercial-registration information on file —
 * the fuller first-party record this table holds, or just the CR NUMBER
 * already typed on the account itself (`accounts.cr_number`, the identity
 * field used to dedupe Saudi entities on import).
 *
 * The generation blocker used to fire whenever `commercial_registrations`
 * had no row at all, even for an account whose CR number was already on
 * file — "no commercial registration has been recorded" read as flatly
 * wrong to someone looking at the number right there on the account. This
 * does not change what a document actually PRINTS: `commercialRegistration`
 * above, and the dialog's own fields, still read from the dedicated table,
 * and still ask for whatever it is missing (Arabic name, representative,
 * address). It only decides whether generation is offered at all rather
 * than refused before the user can even open the dialog to fill in the rest.
 */
export function hasRegistrationOnFile(ctx, account) {
    return Boolean(commercialRegistration(ctx, account.id) || account?.cr_number);
}

/**
 * Everything a generation reads, gathered once.
 *
 * When a deal is in play its recurring value is computed here so `monthly_fee`
 * can be prefilled from the line items rather than typed twice. It is a PREFILL
 * and not a calculation: the automation has no such derivation, so the number is
 * offered to the user and whatever they confirm is what prints. Without a deal
 * there is nothing to derive and the field simply opens empty, exactly as the
 * automation's did.
 */
export function generationContext(ctx, subject) {
    const { account, deal } = resolveSubject(ctx, subject);

    const items = deal ? all('SELECT * FROM deal_line_items WHERE deal_id = ?', [deal.id]) : [];
    const derived = deriveValues(items, { baseCurrency: ctx.workspace?.baseCurrency ?? 'USD' });

    return {
        account,
        deal,
        registration: commercialRegistration(ctx, account.id),
        services: serviceSelection(ctx, { accountId: account.id, dealId: deal?.id ?? null }),
        serviceLines: accountServiceLines(account),
        lineItems: items,
        derived,
        timeZone: setting(ctx.workspaceId, 'doc_timezone') ?? 'Africa/Cairo',
    };
}

/**
 * The form values to open the wizard with.
 *
 * Order of preference, and the reason for it:
 *   1. the last version's values — regenerating is nearly always a small edit
 *   2. the ACCOUNT's billing currency, for the currency field only
 *   3. a workspace default, for the fields that have one
 *   4. something derived from the deal (the recurring total)
 *
 * A field with none of those opens blank rather than guessed.
 *
 * Step 2 sits above the workspace default on purpose, and it is the only field
 * that jumps the queue. `doc_default_currency` is a convenience for a workspace
 * that mostly bills in one currency; the account's `billing_currency` is a fact
 * about THIS client. A SAR client was being handed the house default because
 * the setting was consulted first, and a contract in the wrong currency is not
 * a cosmetic defect.
 */
export function prefillFields(ctx, subject, docTypeKey) {
    const docType = documentType(docTypeKey);
    if (!docType) throw notFound('No such document type.');

    const context = generationContext(ctx, subject);
    const previous = get(
        `SELECT fields FROM document_generations
          WHERE workspace_id = ? AND account_id = ? AND document_type = ? AND status = 'generated'
          ORDER BY version DESC LIMIT 1`,
        [ctx.workspaceId, context.account.id, docTypeKey],
    );
    const last = previous ? json(previous.fields, {}) : {};

    /**
     * AN AGREEMENT IS THE SAME DEAL AS ITS PROPOSAL, so it starts with the
     * same answers — not blank.
     *
     * `last` above only ever looks at THIS document type's own history, so
     * the first agreement generated for an account always opened empty even
     * when the proposal it is turning into had every field filled in a
     * minute earlier: same employee count, same visit frequency, same
     * monthly fee, quoted once and typed twice. This looks at the most
     * recent generation of any SIBLING type for the same product — the
     * proposal, or an older agreement — and falls back to it field by field.
     *
     * Only a field whose `type` and `settingKey` agree between the two
     * document types is carried over. That excludes `currency`: the
     * proposal's is an English code ("USD") and the agreement's is an Arabic
     * word ("دولار") — same key, same-looking field, a different fact — and
     * copying it across languages would put a wrong word in a legal
     * document rather than a blank one waiting to be typed. Everything that
     * genuinely means the same thing on both documents (headcount, visit
     * frequency, the fee itself) has no such mismatch and copies cleanly.
     */
    const sibling = {};
    for (const other of documentTypesForProduct(docType.product)) {
        if (other.key === docType.key) continue;
        const row = get(
            `SELECT fields FROM document_generations
              WHERE workspace_id = ? AND account_id = ? AND document_type = ? AND status = 'generated'
              ORDER BY version DESC LIMIT 1`,
            [ctx.workspaceId, context.account.id, other.key],
        );
        if (!row) continue;
        const fields = json(row.fields, {});
        for (const field of other.fields) {
            if (sibling[field.key] !== undefined) continue;
            if (fields[field.key] === undefined || fields[field.key] === null || fields[field.key] === '') continue;
            sibling[field.key] = { value: fields[field.key], type: field.type, settingKey: field.settingKey ?? null };
        }
    }

    const out = {};
    for (const field of docType.fields) {
        if (last[field.key] !== undefined && last[field.key] !== null && last[field.key] !== '') {
            out[field.key] = last[field.key];
            continue;
        }
        /**
         * `siblingKey` is for the field that means the same thing on both
         * documents but is not SPELLED the same — the Offshoring proposal's
         * per-employee rate is `talent_fee`, the agreement's is `monthly_fee`
         * (the agreement's own template calls it a fee, not a quote), so the
         * ordinary same-key lookup below found nothing and this one value —
         * the actual number being sold — was the one prefill silently missed
         * while headcount and dates on other documents carried over fine.
         * Declaring the alias is trusted outright (type still checked): the
         * settingKey equality below exists to stop a DIFFERENT concept with
         * the same key colliding (the two-language currency fields), which
         * does not apply when the author has already named the two as one.
         */
        const carried = sibling[field.siblingKey ?? field.key];
        if (carried && carried.type === field.type
            && (field.siblingKey || carried.settingKey === (field.settingKey ?? null))) {
            out[field.key] = carried.value;
            continue;
        }
        /**
         * The currency the CLIENT pays in, which the account owns.
         *
         * Only reached by fields declaring `prefillFrom: 'deal_currency'`, so
         * the Arabic currency-word fields — which carry a settingKey and no
         * prefill — are untouched. "جنيه" is a word in a sentence, not a code.
         */
        if (field.prefillFrom === 'deal_currency') {
            out[field.key] = context.account?.billing_currency
                || context.deal?.currency
                || setting(ctx.workspaceId, field.settingKey)
                || ctx.workspace?.baseCurrency
                || 'USD';
            continue;
        }
        if (field.settingKey) {
            const value = setting(ctx.workspaceId, field.settingKey);
            if (value !== undefined && value !== null && value !== '') {
                out[field.key] = value;
                continue;
            }
        }
        if (field.prefillFrom === 'deal_mrr' && context.derived.mrr > 0) {
            out[field.key] = context.derived.mrr;
            continue;
        }
        out[field.key] = '';
    }

    // The inclusive-term convention, offered rather than imposed — the field
    // stays editable because not every contract runs a year.
    const years = setting(ctx.workspaceId, 'doc_default_contract_years');
    for (const field of docType.fields) {
        if (!field.autoCalcFrom || out[field.key]) continue;
        const start = out[field.autoCalcFrom];
        if (!start) continue;
        const end = computeContractEndDate(new Date(`${String(start).slice(0, 10)}T12:00:00Z`), years);
        if (end) out[field.key] = end.toISOString().slice(0, 10);
    }

    return { fields: out, context };
}

/**
 * The document types this account can produce, and why each one can or cannot
 * be generated right now.
 *
 * Narrowed by SERVICE LINE — the CRM's own name for what the automation called
 * Product. An account that buys HCM is offered the HCM proposal and agreement,
 * and nothing else; the account's `services` is the single source for that, so
 * adding a fifth document type for a new service line needs no change here.
 *
 * A deal narrows further to its own service line, because a deal is a specific
 * piece of business and the account may buy several things.
 *
 * Every type is returned WITH its blockers rather than being filtered out.
 * "There is no HCM Agreement here" and "the HCM Agreement needs a commercial
 * registration first" are different answers, and hiding the second as the first
 * is how a user concludes the feature is broken.
 */
export function availableTypes(ctx, subject) {
    const context = generationContext(ctx, subject);
    const { account, deal } = context;

    const lines = deal?.service_line_key ? [deal.service_line_key] : accountServiceLines(account);
    const types = lines.flatMap((line) => documentTypesForProduct(line));

    return types.map((dt) => {
        const template = currentTemplate(ctx.workspaceId, dt.templateKey);
        const blockers = [];
        if (!template) {
            blockers.push(`No ${dt.label} template has been uploaded yet. Add one in Settings → Documents.`);
        }
        if (dt.requiresCommercialRegistration && !hasRegistrationOnFile(ctx, account)) {
            blockers.push(
                'No commercial registration has been recorded for this account yet. '
                + 'Add it so the first-party details can be filled in automatically.',
            );
        }
        return {
            key: dt.key,
            label: dt.label,
            category: dt.category,
            product: dt.product,
            hasServiceSelection: dt.hasServiceSelection,
            requiresCommercialRegistration: dt.requiresCommercialRegistration,
            template,
            blockers,
            fields: dt.fields.map((f) => ({
                key: f.key, label: f.label, type: f.type,
                required: f.required === true,
                requiredWithRecruitment: typeof f.requiredIf === 'function' && f.requiredIf(['RECRUITMENT']),
                hint: f.hint ?? null,
                autoCalcFrom: f.autoCalcFrom ?? null,
            })),
        };
    });
}

/**
 * The one refusal that comes before everything else: an account with no service
 * on it cannot produce any document, because the service is what decides which
 * document and which scopes.
 *
 * Returned as a value rather than thrown, so the caller can render it as the
 * instruction it is instead of an error.
 */
export function serviceGate(ctx, subject) {
    const { account, deal } = resolveSubject(ctx, subject);
    /**
     * The deal's own service, UNION the account's — never the deal's alone.
     *
     * An account genuinely buying more than one service (its own `services`
     * field says so explicitly: "a company can genuinely buy Recruitment
     * AND Offshoring") has ONE deal per service, but a rep generating this
     * account's HCM agreement from its Recruitment deal — or from an
     * account-level wizard that has not resolved a deal yet — must not be
     * refused because that one deal's stored service has no templates of
     * its own. The deal's service still comes first when it IS usable,
     * so a single-service deal behaves exactly as before; the account's
     * other services widen what is offered rather than narrowing it.
     */
    const dealLine = deal?.service_line_key ? [deal.service_line_key] : [];
    const lines = [...new Set([...dealLine, ...accountServiceLines(account)])];
    if (!lines.length) {
        return {
            ok: false,
            reason: 'Please add a service to this account first.',
            detail: 'Open the account, set Services to the service line this client buys, and generate again.',
        };
    }
    const types = lines.flatMap((line) => documentTypesForProduct(line));
    if (!types.length) {
        return {
            ok: false,
            reason: `No document templates exist for ${lines.join(', ')}.`,
            detail: 'Documents are defined per service line. Add the service line this client buys, '
                + 'or add a document type for it in lib/document-types.mjs.',
        };
    }
    return { ok: true, serviceLines: lines };
}

/* -------------------------------------------------------------- generate -- */

/**
 * Variables the form collects that this template never mentions.
 *
 * The registry and the templates are code and data, and they drift: a template
 * uploaded before a field existed still has the old hard-coded value where the
 * field's value should go. The form asks for a price, the user types one, and
 * the document goes out quoting the number that was baked into the .docx.
 *
 * Leftover-token checking cannot catch that — there is no token to be left
 * over. Read against the RAW template, so a variable that only appears inside a
 * dynamic block still counts as mentioned.
 */
function missingFieldTokens(docType, templateXml) {
    return Object.entries(docType.variables ?? {})
        .filter(([, meta]) => meta?.source === SOURCE.FIELD)
        .map(([key]) => key)
        .filter((key) => !templateXml.includes(`{{${key}}}`));
}

function staleTemplateProblem(docType, missing) {
    return `This ${docType.label} template does not contain ${missing.map((k) => `{{${k}}}`).join(', ')}, `
        + 'so what the form collects for it could not appear in the document. '
        + 'Upload the current template in Settings → Documents.';
}

/**
 * Everything wrong with this request, before anything is written.
 *
 * Returns sentences, not codes: the caller shows them as a list, and being told
 * about the missing address only after fixing the currency is how a
 * five-second correction becomes five round trips.
 */
export function validate(ctx, { accountId = null, dealId = null, docTypeKey, fields, services = null }) {
    const docType = documentType(docTypeKey);
    if (!docType) throw notFound('No such document type.');

    const context = generationContext(ctx, { accountId, dealId });
    const problems = [];

    // First, the refusal that makes every later one moot.
    const gate = serviceGate(ctx, { accountId: context.account.id, dealId: context.deal?.id ?? null });
    if (!gate.ok) problems.push(gate.reason);

    // A document type the account's services do not include is a mismatch worth
    // naming, not a silent success against the wrong template.
    const offered = (gate.serviceLines ?? []).flatMap((line) => documentTypesForProduct(line));
    if (gate.ok && !offered.some((dt) => dt.key === docType.key)) {
        problems.push(
            `This account does not buy ${docType.product}, so a ${docType.label} does not apply to it. `
            + `Please complete the configuration for ${docType.product} on the account before generating.`,
        );
    }

    // An explicit selection from the request wins over the stored one, so the
    // review screen validates what the user is looking at.
    const enabledKeys = docType.hasServiceSelection
        ? SERVICE_KEYS.filter((key) => (services ?? context.services).includes(key))
        : [];

    problems.push(...validateGeneration({
        docType,
        account: context.account,
        fields,
        enabledKeys,
        registration: context.registration,
    }));

    if (!currentTemplate(ctx.workspaceId, docType.templateKey)) {
        problems.push(`No ${docType.label} template has been uploaded yet. Add one in Settings → Documents.`);
    }
    return { problems, context, docType, enabledKeys };
}

/**
 * The review step: every variable this document will fill, where each value
 * comes from, and what is still missing — without writing anything.
 *
 * Deliberately runs the SAME `buildPlaceholders` the generation runs, so the
 * table is the document's actual contents rather than a second opinion about
 * them. It also renders the template when one is installed, which is what turns
 * "we think this is complete" into "nothing is left unreplaced".
 */
export function previewGeneration(ctx, request) {
    const { problems, context, docType, enabledKeys } = validate(ctx, request);

    const placeholders = docType.buildPlaceholders({
        account: context.account,
        deal: context.deal,
        fields: request.fields ?? {},
        enabledServices: enabledServicesFor(enabledKeys),
        registration: context.registration,
        timeZone: context.timeZone,
        now: new Date(),
    });

    const variables = describeVariables(docType, placeholders, enabledKeys);

    // A dry render, when there is a template to render. Catching a leftover
    // token here means the user sees it on the review screen instead of as a
    // failure after pressing Generate.
    let leftoverTokens = [];
    const template = currentTemplate(ctx.workspaceId, docType.templateKey);
    if (template) {
        try {
            const zip = readZip(templateBytes(template));
            const documentXml = readPart(zip, 'word/document.xml');
            const missing = missingFieldTokens(docType, documentXml);
            if (missing.length) problems.push(staleTemplateProblem(docType, missing));
            ({ leftoverTokens } = renderDocumentXml(documentXml, {
                dynamicBlocks: docType.dynamicBlocks, enabledKeys, placeholders,
            }));
        } catch (err) {
            problems.push(`This ${docType.label} template cannot be rendered: ${err.message}`);
        }
    }

    return {
        documentType: docType.key,
        label: docType.label,
        category: docType.category,
        account: { id: context.account.id, name: context.account.name },
        deal: context.deal ? { id: context.deal.id, name: context.deal.name } : null,
        services: enabledKeys,
        variables,
        problems,
        leftoverTokens,
        ok: problems.length === 0 && leftoverTokens.length === 0,
        nextVersion: nextVersion(ctx, context.account.id, docType.key),
    };
}

/**
 * Generates one document, records the version, and returns both.
 *
 * The whole write — file, `documents` row, `document_generations` row, the
 * `generated` event — is one transaction. A render that fails, or produces a
 * document still containing a placeholder, throws before any of it happens.
 */
/**
 * Every placeholder key `docType.variables` marks `money: true` — the exact
 * ones `generate()` blanks when asked to redact.
 *
 * Reads the SAME metadata `previewGeneration` shows a reviewer ("where does
 * each variable come from"), so a document type that adds a new price field
 * and marks it money-bearing is protected here with no second list to keep
 * in step — and one that forgets to mark it is a mistake visible in the
 * review table too, not a silent leak.
 */
function moneyPlaceholderKeys(docType) {
    return Object.entries(docType.variables ?? {})
        .filter(([, def]) => def.money === true)
        .map(([key]) => key);
}

/**
 * Blanks every money-bearing placeholder AFTER `buildPlaceholders` has run.
 *
 * Deliberately not earlier: required-field validation (`validateGeneration`,
 * called from `validate()` before this ever runs) checks the REAL fields —
 * a monthly fee of null would fail as "required" before generation got this
 * far, which is backwards for a document whose whole point is to carry every
 * other real fact about the deal. Redacting the rendered VALUE rather than
 * the INPUT is what lets the internal proposal be generated from genuinely
 * complete data and still show no price.
 */
function redactMoneyPlaceholders(docType, placeholders) {
    const keys = moneyPlaceholderKeys(docType);
    if (!keys.length) return placeholders;
    const redacted = { ...placeholders };
    for (const key of keys) redacted[key] = '';
    return redacted;
}

/**
 * The Offshoring Proposal's "Budget" table, gone from the INTERNAL copy only.
 *
 * Blanking `{{TALENT_FEE}}` above leaves the row reading "Talent fees:  USD
 * per employee / month" — a price with the number missing, which is not
 * informative for the internal team, it just says a redaction happened. The
 * external proposal is untouched: this runs only when `redactMoney` is true,
 * on the RENDERED xml in memory, never on the stored template — an ordinary
 * commercial proposal always gets its real Budget table.
 *
 * Defensive by construction: a template without a "Budget" cell (HCM, the
 * agreements) or one whose structure has since changed is left exactly as
 * rendered. This is an internal-only cosmetic improvement, not a contract —
 * failing to find it is a no-op, never an error.
 */
/** The `n`th (0-based) bare `<w:tc>...</w:tc>` in a row, as a `[start, end)` span — or null. */
function nthCellSpan(row, n) {
    let idx = -1;
    for (let i = 0; i <= n; i++) {
        idx = row.indexOf('<w:tc>', idx + 1);
        if (idx < 0) return null;
    }
    const end = row.indexOf('</w:tc>', idx);
    if (end < 0) return null;
    return [idx, end + '</w:tc>'.length];
}

/**
 * The HCM Proposal's whole Monthly Fee COLUMN — header cell, data cell and
 * the grid column behind both — gone from the INTERNAL copy only, before
 * either placeholder token is substituted.
 *
 * Deleting only the data cell (an earlier version of this function did
 * exactly that) leaves the table lopsided: the header row still carries a
 * "Monthly Fee" column with nothing under it, because the last row's cell
 * count no longer matches the header's. That reads as a half-finished
 * redaction, not a clean one, so this removes the SAME column — same
 * position, found by counting `<w:tc>` cells up to the "Monthly Fee"
 * header label — from every row in the table, and drops the matching
 * `<w:gridCol>` so the grid stays rectangular.
 *
 * Runs on the RAW template (before renderDocumentXml substitutes
 * placeholders), because by the time a redacted MONTHLY_FEE/CURRENCY have
 * been blanked to '', nothing distinct is left in the rendered XML to
 * search for. Searching for the literal `{{MONTHLY_FEE}}` token to locate
 * the table means this must be scoped to the HCM Proposal specifically —
 * the Offshoring and HCM Agreement templates also carry a MONTHLY_FEE
 * token, in tables this function has no business touching (see the
 * caller's own docType check).
 *
 * Defensive by construction: a template that has since changed shape, or
 * whose fee column has already been reworded or reordered, is left exactly
 * as rendered — failing to find it is a no-op, never an error.
 */
function stripRedactedHcmFeeColumn(xml) {
    const tokenIdx = xml.indexOf('{{MONTHLY_FEE}}');
    if (tokenIdx < 0) return xml;
    const tblStart = xml.lastIndexOf('<w:tbl>', tokenIdx);
    if (tblStart < 0) return xml;
    const tblEndTagIdx = xml.indexOf('</w:tbl>', tokenIdx);
    if (tblEndTagIdx < 0) return xml;
    const tblEnd = tblEndTagIdx + '</w:tbl>'.length;

    let table = xml.slice(tblStart, tblEnd);

    const headerLabelIdx = table.search(/Monthly Fee/i);
    if (headerLabelIdx < 0) return xml;
    const columnIndex = (table.slice(0, headerLabelIdx).match(/<w:tc>/g) ?? []).length - 1;
    if (columnIndex < 0) return xml;

    const gridMatch = table.match(/<w:tblGrid>[\s\S]*?<\/w:tblGrid>/);
    if (gridMatch) {
        const cols = [...gridMatch[0].matchAll(/<w:gridCol[^>]*\/>/g)];
        const col = cols[columnIndex];
        if (col) {
            const trimmedGrid = gridMatch[0].slice(0, col.index) + gridMatch[0].slice(col.index + col[0].length);
            table = table.slice(0, gridMatch.index) + trimmedGrid + table.slice(gridMatch.index + gridMatch[0].length);
        }
    }

    table = table.replace(/<w:tr[ >][\s\S]*?<\/w:tr>/g, (row) => {
        const span = nthCellSpan(row, columnIndex);
        return span ? row.slice(0, span[0]) + row.slice(span[1]) : row;
    });

    return xml.slice(0, tblStart) + table + xml.slice(tblEnd);
}

function stripRedactedBudgetSection(xml) {
    const budgetIdx = xml.indexOf('>Budget<');
    if (budgetIdx < 0) return xml;
    const tableStart = xml.lastIndexOf('<w:tbl>', budgetIdx);
    if (tableStart < 0) return xml;
    const nextHeadingIdx = xml.indexOf('>Payment Terms<', budgetIdx);
    if (nextHeadingIdx < 0) return xml;
    const runStart = xml.lastIndexOf('<w:r>', nextHeadingIdx);
    const paragraphStart = xml.lastIndexOf('<w:p ', runStart);
    if (paragraphStart < 0 || paragraphStart <= tableStart) return xml;
    return xml.slice(0, tableStart) + xml.slice(paragraphStart);
}

/**
 * The raw `fields` a generation was built from carry the same money-bearing
 * values as its placeholders — `historyFor` below redacts these too, for the
 * same reason: an Internal Team Proposal's own generation-history row must
 * not hand the real monthly fee back to the browser just because nothing
 * currently renders it. Same `money: true` metadata, keyed by `fieldKey`
 * (the input field name) instead of the placeholder token.
 */
function moneyFieldKeys(docType) {
    return Object.values(docType?.variables ?? {})
        .filter((def) => def.money === true && def.fieldKey)
        .map((def) => def.fieldKey);
}

function redactMoneyFields(docType, fields) {
    const keys = moneyFieldKeys(docType);
    if (!keys.length) return fields;
    const redacted = { ...fields };
    for (const key of keys) redacted[key] = null;
    return redacted;
}

export function generate(ctx, {
    accountId = null, dealId = null, docTypeKey, fields, services = null, contactId = null, redactMoney = false,
    recordOverrides = null,
}) {
    const { problems, context, docType, enabledKeys } = validate(
        ctx, { accountId, dealId, docTypeKey, fields, services },
    );
    if (problems.length) {
        throw badRequest(`This ${docType.label.toLowerCase()} cannot be generated yet.`, { problems });
    }

    const template = currentTemplate(ctx.workspaceId, docType.templateKey);
    const zip = readZip(templateBytes(template));
    const documentXml = readPart(zip, 'word/document.xml');

    // Checked here too, not only on the review screen: a stale template is the
    // one failure that produces a document which looks right and quotes the
    // wrong number, and nothing downstream would ever notice. Against the
    // UNSTRIPPED xml — the fee cell stripped below is removed deliberately,
    // not a sign the template is missing something.
    const missing = missingFieldTokens(docType, documentXml);
    if (missing.length) {
        throw badRequest(`This ${docType.label.toLowerCase()} cannot be generated yet.`, {
            problems: [staleTemplateProblem(docType, missing)],
        });
    }

    // Scoped to the HCM Proposal specifically — see stripRedactedHcmFeeColumn's
    // own comment on why this must not run for the other templates that also
    // carry a MONTHLY_FEE token.
    const templateForRender = (redactMoney && docType.templateKey === 'hcm_proposal')
        ? stripRedactedHcmFeeColumn(documentXml)
        : documentXml;

    const builtPlaceholders = docType.buildPlaceholders({
        account: context.account,
        deal: context.deal,
        fields,
        enabledServices: enabledServicesFor(enabledKeys),
        registration: context.registration,
        timeZone: context.timeZone,
        now: new Date(),
    });
    /**
     * Explicit, not implicit. `redactMoney` is read exactly once, here — the
     * one place downstream of it (`renderDocumentXml`) never sees the real
     * figure at all, so there is no template variable it could leak through
     * by accident. See `redactMoneyPlaceholders` for what gets blanked and
     * why validation above still ran against the real values.
     */
    const placeholders = redactMoney ? redactMoneyPlaceholders(docType, builtPlaceholders) : builtPlaceholders;

    const { xml, leftoverTokens } = renderDocumentXml(templateForRender, {
        dynamicBlocks: docType.dynamicBlocks,
        enabledKeys,
        placeholders,
    });

    if (leftoverTokens.length) {
        // Never saved. A contract that goes out reading "{{MONTHLY_FEE}}" is
        // worse than one that was never produced.
        throw badRequest(
            `${docType.label} generation stopped: the template still contains `
            + `${leftoverTokens.join(', ')} after filling it in. Nothing was saved.`,
        );
    }

    /**
     * No generated document carries yellow, whatever the template does.
     *
     * The templates used it to mark what somebody had to fill in by hand —
     * including, on the HCM agreement, the merge fields themselves — so every
     * contract came out pre-marked as a draft. Stripping it HERE rather than
     * only from the stored templates means a template uploaded tomorrow cannot
     * put it back, and that automated generation obeys the same rule as the
     * dialog. Every other bit of formatting is untouched.
     */
    const redactedXml = redactMoney ? stripRedactedBudgetSection(xml) : xml;
    const replacements = { 'word/document.xml': stripYellow(redactedXml) };
    for (const entry of zip.entries) {
        if (entry.name === 'word/document.xml' || !FORMATTED_PARTS.test(entry.name)) continue;
        const part = readPart(zip, entry.name);
        const cleaned = stripYellow(part);
        if (cleaned !== part) replacements[entry.name] = cleaned;
    }
    const buffer = writeZip(zip, replacements);
    const version = nextVersion(ctx, context.account.id, docTypeKey);
    const documentId = id('doc');
    const generationId = id('dgn');
    const fileName = buildDocumentName(docType, context.account).replace(/\.docx$/, ` - v${version}.docx`);
    const storageKey = path.join(ctx.workspaceId, `${documentId}.docx`);

    writeFile(storageKey, buffer);

    let linked = null;
    try {
        tx(() => {
            insert('documents', {
                id: documentId, workspace_id: ctx.workspaceId,
                // Attached to the deal when there is one, so it appears on both;
                // to the account otherwise. `account_id` is set either way, which
                // is what the account's document list actually reads.
                parent_type: context.deal ? 'deal' : 'account',
                parent_id: context.deal?.id ?? context.account.id,
                account_id: context.account.id,
                name: fileName, kind: docType.category === 'agreement' ? 'agreement' : 'proposal',
                mime: DOCX_MIME, size_bytes: buffer.length, storage_key: storageKey,
                checksum: crypto.createHash('sha256').update(buffer).digest('hex'),
                uploaded_by: ctx.userId ?? null, created_at: now(),
            });
            insert('document_generations', {
                id: generationId, workspace_id: ctx.workspaceId,
                account_id: context.account.id, deal_id: context.deal?.id ?? null,
                contact_id: contactId,
                document_type: docTypeKey, version, document_id: documentId,
                template_id: template.id, template_checksum: template.checksum,
                fields: JSON.stringify(fields ?? {}),
                placeholders: JSON.stringify(placeholders),
                services: JSON.stringify(enabledKeys),
                status: 'generated', generated_by: ctx.userId ?? null, created_at: now(),
            });
            // Inside the same transaction as the file's row: a document on the
            // account with no row in the proposals list is the exact split this
            // is here to close, and one write succeeding without the other is
            // how it would come back.
            linked = linkGeneratedRecord(ctx, {
                docType, account: context.account, deal: context.deal, fields, version, documentId,
                overrides: recordOverrides,
            });
            // The generation row is written before linking, so when linking
            // found or created a deal for an account-level document, the
            // generation records it too — one document, one deal, everywhere.
            if (!context.deal && linked.deal_id) {
                run('UPDATE document_generations SET deal_id = ? WHERE id = ?', [linked.deal_id, generationId]);
            }
            recordEvent(ctx, {
                generationId, documentId, eventType: version === 1 ? 'generated' : 'version_created',
                metadata: { version, template: template.id, record: linked.id },
            });
            audit(ctx, {
                objectKey: 'document', recordId: documentId, accountId: context.account.id,
                action: 'document_generated',
                after: { document_type: docTypeKey, version, name: fileName, record: linked.id },
            });
        });
    } catch (err) {
        // The row write failed, so the file on disk is an orphan. Remove it —
        // a file with no record is invisible to every listing and impossible to
        // clean up later.
        removeFile(storageKey);
        throw err;
    }

    return {
        generation: get('SELECT * FROM document_generations WHERE id = ?', [generationId]),
        document: getRecord('document', ctx, documentId),
        // The proposal or agreement this is a version of, so the caller can send
        // the user to it rather than to a file with no record behind it.
        record: linked
            ? { object: docType.category === 'agreement' ? 'agreement' : 'proposal', id: linked.id, number: linked.number }
            : null,
    };
}

/* -------------------------------------------- the record it is a version of -- */

/**
 * The proposal or agreement record for a generated document.
 *
 * ── ONE RECORD PER DOCUMENT ─────────────────────────────────────────────────
 *
 * The account is where documents live, and it lists every generated version as
 * its own row. The sidebar's Proposals and Agreements lists are wired to THAT:
 * one row here for one row there, `document_id` joining them, so the two
 * screens cannot show different things. Regenerating produces a new document,
 * therefore a new record — it never edits the one already made, because that
 * one is still the file somebody was sent.
 *
 * The record is what the rest of the CRM can act on that a file cannot carry: a
 * number, an owner, a status, and — for agreements — the contract term, which
 * is what the renewals report reads.
 */
function linkGeneratedRecord(ctx, { docType, account, deal, fields, version, documentId, overrides = null }) {
    const agreement = docType.category === 'agreement';
    const objectKey = agreement ? 'agreement' : 'proposal';
    const table = agreement ? 'agreements' : 'proposals';

    /**
     * Every commercial document belongs to a DEAL — the opportunity it quotes.
     *
     * An AGREEMENT generated from an account still belongs to a deal: a
     * contract is the close of a specific sale of a specific service, and it
     * is what moves that sale into Contracting and then into Won. A PROPOSAL
     * is the same — it is written to move that sale forward, and a proposal
     * with no deal behind it never reaches a forecast. Both find or create
     * the deal here, so the wizard path — which never had a deal to pass —
     * cannot orphan a document again.
     *
     * The service comes from the DOCUMENT: an HCM agreement is an HCM deal.
     */
    if (!deal) {
        deal = ensureDealForAgreement(ctx, {
            accountId: account.id,
            serviceLineKey: docType.product ?? accountServiceLines(account)[0] ?? null,
            currency: account.billing_currency ?? null,
            price: contractValue(fields),
        });
    }

    // On a database that still has the old NOT NULL deal_id, an account-level
    // generation would die on a foreign-key constraint after the file was
    // written. Said as the instruction it is, and only in the case that cannot
    // work — generating from a deal is unaffected either way.
    if (!deal && !dealIdIsNullable(table)) {
        throw badRequest(
            `This database still requires a deal on every ${objectKey}. `
            + 'Run `node apply-generated-records.mjs --apply` to finish the migration, '
            + 'or generate this document from a deal.',
        );
    }

    /**
     * Superseding the previous proposal used to happen HERE, and now happens
     * when the replacement is approved (api/proposals.mjs, reviewDocument).
     *
     * Generating a document is no longer the moment it becomes real, so it is
     * no longer the moment the old one stops being real. A draft that gets
     * rejected must not have knocked the client's live proposal out of the
     * account on its way past.
     */
    const recordId = id(agreement ? 'agr' : 'pro');
    insert(table, {
        id: recordId, workspace_id: ctx.workspaceId,
        account_id: account.id, deal_id: deal?.id ?? null,
        document_type: docType.key, document_id: documentId,
        number: nextDocumentNumber(ctx, table, agreement ? 'A' : 'P'),
        title: overrides?.title ?? `${docType.label} v${version} — ${account.name}`,
        /**
         * Generated documents go for review like every other document.
         *
         * A generated proposal used to be created `issued` — produced by a
         * template, numbered, filed against the account and treated as a
         * finished document nobody had read. That is exactly the bypass the
         * review workflow exists to close: automation is a faster way to draft,
         * not a way to skip the manager.
         *
         * `pending_review` rather than `draft` because generating one is a
         * deliberate act, so it arrives already submitted. Agreements land the
         * same way and still need signing after approval.
         *
         * `overrides.status` exists for exactly one caller: the Internal Team
         * Proposal (lib/internal-proposal.mjs), which is generated from data
         * a manager already approved once — the signed agreement — and is
         * not a document anybody outside the company reviews. Raising an
         * approval task for it would be the "noisy notification for
         * document creation" the feature's own spec says not to add.
         */
        status: overrides?.status ?? 'pending_review',
        submitted_at: now(),
        ...(overrides?.type !== undefined ? { type: overrides.type } : {}),
        ...(overrides?.sourceProposalId !== undefined ? { source_proposal_id: overrides.sourceProposalId } : {}),
        ...(overrides?.sourceAgreementId !== undefined ? { source_agreement_id: overrides.sourceAgreementId } : {}),
        ...(agreement
            ? {
                // These templates are the whole service agreement between the
                // two companies, not a statement of work under an existing
                // one — MSA by default. `overrides.type` exists for exactly
                // one other caller: renewAgreement (api/proposals.mjs), which
                // generates the identical document again with new dates and
                // needs the record to say `renewal`, not another MSA.
                type: overrides?.type ?? 'msa',
                // The chain back to the contract this one replaces — set only
                // by a renewal. Read by the renewals report and the record
                // page so a contract's history is a chain, not a pile of
                // similarly-named PDFs.
                ...(overrides?.supersedesAgreementId !== undefined
                    ? { supersedes_agreement_id: overrides.supersedesAgreementId } : {}),
                // The contract term, as the person generating it typed it. This
                // is what puts a generated agreement into the renewals report,
                // which reads `expiry_date` and never had anything to read.
                effective_date: dateField(fields?.start_date),
                expiry_date: dateField(fields?.end_date),
                /**
                 * The revenue side of the contract, from the same wizard.
                 *
                 * This path inserts directly rather than going through
                 * `createRecord`, so the defaults that live there do not apply
                 * and are repeated here deliberately. A generated agreement is
                 * the commonest kind in this workspace; leaving it without a
                 * value or a service would make the client revenue map a report
                 * about the contracts somebody happened to type by hand.
                 */
                renewal_date: dateField(fields?.end_date),
                /**
                 * `notice_days` is `NOT NULL DEFAULT 0` at the schema level, so
                 * leaving it out here does not mean "use the workspace
                 * default" — it means every generated agreement silently
                 * negotiated a zero-day notice period, which is what "the
                 * default renewal notice shows 0" turned out to be. The same
                 * default `defaultAgreementFields` (lib/repo.mjs) resolves for
                 * the `createRecord` path, repeated here for the reason the
                 * comment above states.
                 */
                notice_days: Number(setting(ctx.workspaceId, 'default_renewal_notice_days')) || 45,
                /**
                 * The service comes from the DOCUMENT first — same rule as
                 * the deal-creation branch above, and for the same reason.
                 * Falling straight to `deal?.service_line_key` meant
                 * generating an HCM agreement against a deal that had been
                 * created (or last generated) for a different service left
                 * the new agreement record tagged with that STALE service —
                 * an HCM document whose own record said "Recruitment"
                 * because that is what the deal still said. The document
                 * being generated is the freshest fact about what this
                 * contract is for; the deal and the account are only
                 * fallbacks for the document types with no fixed product
                 * (OD, Recruitment — see DOCUMENT_TYPES).
                 */
                service_line_key: docType.product ?? deal?.service_line_key ?? accountServiceLines(account)[0] ?? null,
                contract_value: contractValue(fields),
                /**
                 * The ACCOUNT's currency, deliberately not the wizard's.
                 *
                 * `fields.currency` is not always a code: the Arabic templates
                 * ask for the currency as a WORD, because "جنيه" is what belongs
                 * in an Arabic sentence. That is right for the document and
                 * wrong for a column the dashboard converts by, so the record
                 * takes the account's billing currency and the document keeps
                 * its own wording.
                 */
                currency: account.billing_currency || ctx.workspace?.baseCurrency || null,
            }
            : {
                current_version: version,
                // The confirmed field first — it is what the document itself
                // says — then the account, which is the source of truth for
                // what this client pays in. The workspace base is a last
                // resort and is nobody's billing currency in particular.
                currency: String(fields?.currency ?? '').trim()
                    || account.billing_currency
                    || ctx.workspace?.baseCurrency || 'USD',
                owner_id: ctx.userId ?? null,
            }),
        created_at: now(), updated_at: now(),
    });
    audit(ctx, {
        objectKey, recordId, accountId: account.id,
        action: 'created', source: 'automation',
        after: { document_type: docType.key, version, document: documentId },
    });
    // This path inserts directly rather than through createRecord, so the rule
    // that lives there is repeated: a contract exists, the deal is contracting.
    if (agreement && deal?.id) {
        moveDealForAgreement(ctx, deal.id, 'contracting', `agreement ${docType.label} generated`);
        // And the deal's size is the contract's value, both ways round.
        syncAgreementAndDeal(ctx, recordId);
    }
    // A generated proposal is the same signal a hand-built one is (see
    // api/proposals.mjs, createProposal): the deal is being quoted, so the
    // board should say Proposal preparing. Forward-only — see
    // advanceDealForProposal in lib/repo.mjs.
    if (!agreement && deal?.id) {
        advanceDealForProposal(ctx, deal.id, `${docType.label} generated`);
    }
    reindex(objectKey, ctx.workspaceId, recordId);
    const created = get(`SELECT * FROM ${table} WHERE id = ?`, [recordId]);
    /**
     * Generated documents are created ALREADY submitted, so they need the
     * same approval task the submit endpoint raises.
     *
     * This path inserts directly rather than going through
     * `submitForReview`, which is exactly why the rule is repeated here:
     * generating is the commonest way a document reaches review in this
     * workspace, and it is the path that would otherwise leave a manager
     * with nothing in their queue.
     *
     * Only when it actually landed in `pending_review` — `overrides.status`
     * skips that state entirely for the one caller that uses it, and an
     * approval task for a status the record was never in is a task nobody
     * can act on.
     */
    if (created.status === 'pending_review') openApprovalTask(ctx, objectKey, created);
    return created;
}

/**
 * Has `apply-generated-records.mjs` run here?
 *
 * Cached: the answer cannot change while the process is up, since the script
 * that changes it rebuilds the table from a separate run.
 */
const NULLABLE_DEAL = new Map();
function dealIdIsNullable(table) {
    if (!NULLABLE_DEAL.has(table)) {
        const column = all(`PRAGMA table_info(${table})`).find((c) => c.name === 'deal_id');
        NULLABLE_DEAL.set(table, column ? column.notnull === 0 : true);
    }
    return NULLABLE_DEAL.get(table);
}

/** A date field as the date column wants it, or null when it was never filled. */
/**
 * A contract date, normalized to a real ISO calendar date.
 *
 * The generation form collects these as typed text and the wizard already
 * refuses anything that is not a date, but the record must hold a date, not a
 * slice of whatever string arrived — so `effective_date` and `expiry_date`
 * stay real enough to sort, filter and feed the renewals report.
 */
function dateField(value) {
    return parseDateValue(value);
}

/**
 * What this contract is worth over its whole term.
 *
 * The wizard collects a MONTHLY fee and a start and end date, so the contract
 * value is the one multiplied by the other. Returns null rather than 0 when
 * either is missing: nought is a claim about a contract, and "we did not
 * capture it" is not the same claim.
 *
 * Months are counted from the calendar rather than from a day count, because a
 * year of monthly invoices is twelve of them whether or not it is a leap year.
 */
export function contractValue(fields) {
    const monthly = Number(fields?.monthly_fee);
    const start = dateField(fields?.start_date);
    const end = dateField(fields?.end_date);
    if (!Number.isFinite(monthly) || monthly <= 0 || !start || !end) return null;

    const from = new Date(`${start}T12:00:00Z`);
    const to = new Date(`${end}T12:00:00Z`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return null;

    /**
     * A contract starting in the year 2 is a typo, not a contract.
     *
     * Production has one: `start_date` of "0002-09-01", which parses happily
     * and yields a term of about twenty-four thousand months. The fee is left
     * alone — a number somebody types into a money field is their business and
     * this is not the place to decide what is too large — but a date this far
     * outside a working lifetime is unambiguous, and multiplying by it turns
     * one slip into a figure that reaches the dashboard.
     */
    if (from.getUTCFullYear() < 2000 || to.getUTCFullYear() > 2100) return null;

    const months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12
        + (to.getUTCMonth() - from.getUTCMonth())
        /**
         * An end date past (or a day short of, for shorter months) the same
         * day of the month completes that month. A 1 Oct 2026 – 30 Sep 2027
         * term is twelve months, not eleven.
         *
         * An end date landing EXACTLY on the same day of the month is the
         * exception: that is a whole number of months already — a 1 Jan 2026
         * – 1 Jan 2027 term is twelve months, not thirteen. Without this
         * exception every contract entered as "one year later, same date"
         * (rather than "the day before") priced at thirteen months.
         */
        + (to.getUTCDate() !== from.getUTCDate() && to.getUTCDate() >= from.getUTCDate() - 1 ? 1 : 0);

    return months > 0 ? Math.round(monthly * months) : null;
}


/**
 * The next version number for this document type on this account.
 *
 * Per (account, type) rather than per deal: a client's HCM Agreement is one
 * document with a history, and numbering it from 1 again because it was written
 * from a different deal is how "v1" stops meaning anything.
 */
function nextVersion(ctx, accountId, docTypeKey) {
    const row = get(
        'SELECT MAX(version) AS v FROM document_generations WHERE workspace_id = ? AND account_id = ? AND document_type = ?',
        [ctx.workspaceId, accountId, docTypeKey],
    );
    return (row?.v ?? 0) + 1;
}

/* -------------------------------------------------------------- tracking -- */

/**
 * Records something that happened to a document.
 *
 * Server-side only, and never accepting a count from the client: an open count
 * a browser can set is a number that means nothing.
 */
export function recordEvent(ctx, { generationId, documentId = null, eventType, metadata = null }) {
    const eventId = id('dev');
    run(
        `INSERT INTO document_events (id, workspace_id, generation_id, document_id, event_type, user_id, metadata, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
            eventId, ctx.workspaceId, generationId, documentId, eventType,
            ctx.userId ?? null, metadata ? JSON.stringify(metadata) : null, now(),
        ],
    );
    return eventId;
}

/** The generation a document belongs to, if it was generated rather than uploaded. */
export function generationForDocument(ctx, documentId) {
    return get('SELECT * FROM document_generations WHERE workspace_id = ? AND document_id = ?',
        [ctx.workspaceId, documentId]) ?? null;
}

/**
 * Counters, derived from the events rather than stored beside them.
 *
 * A stored counter and the events it summarises are two truths that drift. This
 * is one indexed group-by per document and cannot disagree with itself.
 */
export function activityFor(ctx, generationIds) {
    if (!generationIds.length) return new Map();
    const placeholders = generationIds.map(() => '?').join(',');
    const rows = all(
        `SELECT generation_id, event_type, COUNT(*) AS n, MAX(created_at) AS last_at
           FROM document_events
          WHERE workspace_id = ? AND generation_id IN (${placeholders})
          GROUP BY generation_id, event_type`,
        [ctx.workspaceId, ...generationIds],
    );
    const out = new Map();
    for (const gid of generationIds) {
        out.set(gid, { opened: 0, downloaded: 0, lastOpenedAt: null, lastDownloadedAt: null });
    }
    for (const row of rows) {
        const entry = out.get(row.generation_id);
        if (!entry) continue;
        if (row.event_type === 'opened') { entry.opened = row.n; entry.lastOpenedAt = row.last_at; }
        if (row.event_type === 'downloaded') { entry.downloaded = row.n; entry.lastDownloadedAt = row.last_at; }
    }
    return out;
}

/**
 * Every generated document for an account (or one deal), newest first.
 *
 * `category` narrows it to proposals or agreements, which is what the account's
 * two tabs ask for. The filter is applied over the registry rather than over a
 * column, so a new document type lands in the right tab by declaring its
 * category and nothing else.
 *
 * `documentType` narrows it to one type, which is what a proposal or agreement
 * record asks for: those rows ARE its versions.
 */
export function historyFor(ctx, { dealId = null, accountId = null, category = null, documentType: typeKey = null } = {}) {
    const where = dealId ? 'g.deal_id = ?' : 'g.account_id = ?';
    let rows = all(
        `SELECT g.*, d.name AS document_name, d.size_bytes, u.name AS generated_by_name
           FROM document_generations g
           LEFT JOIN documents d ON d.id = g.document_id
           LEFT JOIN users u     ON u.id = g.generated_by
          WHERE g.workspace_id = ? AND ${where}
            -- A version whose file was deleted is not a version any more: the
            -- row stays (it is what the delete-cascade audit points at), but
            -- the account's Documents tab must not offer an Open button that
            -- 404s. Failed generations have no document and keep showing.
            AND (d.id IS NULL OR d.deleted_at IS NULL)
          ORDER BY g.created_at DESC`,
        [ctx.workspaceId, dealId ?? accountId],
    );
    if (typeKey) rows = rows.filter((row) => row.document_type === typeKey);
    if (category) {
        rows = rows.filter((row) => documentType(row.document_type)?.category === category);
    }
    const activity = activityFor(ctx, rows.map((r) => r.id));

    // A generation whose linked document is an Internal Team Proposal's own
    // document carries the SAME real fields (monthly fee, currency) the
    // source proposal was generated from — those are exactly the values the
    // Internal Team Proposal must never hand back, in the rendered document
    // or here. Nothing currently reads this endpoint's `fields` on screen,
    // but that is not a reason to let it sit on the wire unredacted.
    const docIds = rows.map((r) => r.document_id).filter(Boolean);
    const internalDocIds = docIds.length
        ? new Set(
            all(
                `SELECT document_id FROM proposals
                  WHERE workspace_id = ? AND type = 'internal_team' AND deleted_at IS NULL
                    AND document_id IN (${docIds.map(() => '?').join(',')})`,
                [ctx.workspaceId, ...docIds],
            ).map((r) => r.document_id),
        )
        : new Set();

    // "Current" is per document type, so a deal showing Proposal v3 and
    // Agreement v1 marks both — they are different documents, not a sequence.
    const seen = new Set();
    return rows.map((row) => {
        const isCurrent = !seen.has(row.document_type) && row.status === 'generated';
        if (isCurrent) seen.add(row.document_type);
        const rawFields = json(row.fields, {});
        const fields = internalDocIds.has(row.document_id)
            ? redactMoneyFields(documentType(row.document_type), rawFields)
            : rawFields;
        return {
            ...row,
            label: documentType(row.document_type)?.label ?? row.document_type,
            category: documentType(row.document_type)?.category ?? null,
            fields,
            services: json(row.services, []),
            isCurrent,
            activity: activity.get(row.id),
        };
    });
}

export { SERVICE_REGISTRY, SERVICE_KEYS, formatDate };

/* ------------------------------------- a version produced outside the CRM -- */

/**
 * Uploading a proposal or agreement that was edited somewhere else.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * The generator writes from a template, and a real negotiation does not stay
 * inside a template. A clause gets redrafted in Word, legal sends a marked-up
 * copy back, a client returns a scanned signature page. Until now the only way
 * to get any of that into the CRM was `POST /api/documents` — which files it as
 * a loose attachment with no version, no place in the proposal's history and no
 * connection to the record whose number is on the front page. So the document
 * everybody was actually working from was the one the CRM did not know about.
 *
 * ── TWO MODES, BECAUSE THERE ARE TWO SITUATIONS ─────────────────────────────
 *
 *   new_version      v3 becomes v4. The client has been sent something
 *                    different from what v3 said, so v3 stays exactly as it
 *                    was and the new file is its own version with its own
 *                    record. This is the normal case.
 *
 *   replace_current  v3's FILE is corrected and stays v3. For the case the
 *                    version history should not record as a negotiation step:
 *                    a typo, a missing annex, the wrong logo. The superseded
 *                    file is kept and reachable — nothing is destroyed — but
 *                    the version number does not move, because nothing was
 *                    sent between the two.
 *
 * ── WHAT REPLACING DOES NOT LET YOU DO ──────────────────────────────────────
 *
 * Rewrite what a client has signed. A signed agreement refuses replacement and
 * says to upload a new version instead: the file behind a signature is the
 * evidence of what was signed, and a product that lets it be swapped in place
 * has no signature worth the name.
 *
 * ── AND IT GOES BACK FOR REVIEW ─────────────────────────────────────────────
 *
 * Either mode returns the record to `pending_review` and raises the approval
 * task, because the content changed and the previous approval was of different
 * content. That is the same rule generation follows, and it is the reason a rep
 * may do this at all.
 */
const UPLOADABLE_MIME = {
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pdf': 'application/pdf',
};

export const UPLOAD_MODES = ['new_version', 'replace_current'];

export function uploadVersion(ctx, {
    accountId, dealId = null, docTypeKey, fileName, bytes, mode = 'new_version', note = null,
}) {
    const docType = DOCUMENT_TYPES[docTypeKey];
    if (!docType) throw badRequest('Choose which document this is a version of.');
    if (!UPLOAD_MODES.includes(mode)) {
        throw badRequest(`Mode must be one of: ${UPLOAD_MODES.join(', ')}.`);
    }
    if (!bytes?.length) throw badRequest('The file is empty.');

    const extension = path.extname(String(fileName ?? '')).toLowerCase();
    if (!UPLOADABLE_MIME[extension]) {
        throw badRequest('Upload a .docx or a .pdf — those are the two a client is ever sent.');
    }

    const { account, deal } = resolveSubject(ctx, { accountId, dealId });

    /**
     * The generation being replaced, or the one the new version follows.
     *
     * `currentGeneration` is the highest version of this type on this account,
     * which is what "the current one" means everywhere else in this file.
     */
    const current = get(
        `SELECT * FROM document_generations
          WHERE workspace_id = ? AND account_id = ? AND document_type = ?
            AND status <> 'failed'
          ORDER BY version DESC LIMIT 1`,
        [ctx.workspaceId, account.id, docTypeKey],
    );

    if (mode === 'replace_current') {
        if (!current) {
            throw badRequest(
                `There is no ${docType.label.toLowerCase()} on this account to replace. `
                + 'Upload it as a new version instead.',
            );
        }
        const record = linkedRecordFor(ctx, docType, current);
        if (record?.status === 'signed') {
            throw badRequest(
                'That agreement is signed, so its file cannot be swapped in place — the file behind a '
                + 'signature is the evidence of what was signed. Upload this as a new version.',
            );
        }
    }

    const version = mode === 'replace_current' ? current.version : nextVersion(ctx, account.id, docTypeKey);
    const documentId = id('doc');
    const storageKey = path.join(ctx.workspaceId, `${documentId}${extension}`);
    const safeName = path.basename(String(fileName)).replace(/[^\w.\-؀-ۿ ]+/g, '_').slice(0, 180);

    writeFile(storageKey, bytes);

    let result = null;
    try {
        tx(() => {
            insert('documents', {
                id: documentId, workspace_id: ctx.workspaceId,
                parent_type: deal ? 'deal' : 'account',
                parent_id: deal?.id ?? account.id,
                account_id: account.id,
                name: safeName,
                kind: docType.category === 'agreement' ? 'agreement' : 'proposal',
                mime: UPLOADABLE_MIME[extension],
                size_bytes: bytes.length,
                storage_key: storageKey,
                checksum: crypto.createHash('sha256').update(bytes).digest('hex'),
                uploaded_by: ctx.userId ?? null,
                created_at: now(),
            });

            if (mode === 'replace_current') {
                /**
                 * The generation row keeps its version, its template lineage
                 * and its frozen field values, and points at the new file.
                 *
                 * The template checksum is NOT cleared. It records which
                 * template produced the version originally, which is still true
                 * and is the question asked when a client disputes a clause;
                 * what changed is that a person edited the output afterwards,
                 * and that is what the event below records.
                 */
                update('document_generations', current.id, { document_id: documentId });
                recordEvent(ctx, {
                    generationId: current.id, documentId, eventType: 'version_replaced',
                    metadata: { version, replaced: current.document_id, name: safeName, note },
                });
                const record = linkedRecordFor(ctx, docType, current);
                if (record) {
                    reopenForReview(ctx, docType, record, documentId, {
                        because: `v${version}'s file was replaced with one edited outside the CRM`,
                    });
                }
                result = { generationId: current.id, record };
            } else {
                const generationId = id('dgn');
                insert('document_generations', {
                    id: generationId, workspace_id: ctx.workspaceId,
                    account_id: account.id, deal_id: deal?.id ?? null,
                    contact_id: null,
                    document_type: docTypeKey, version, document_id: documentId,
                    // No template produced this one, and pretending otherwise
                    // would put a checksum against a file the template never saw.
                    template_id: null, template_checksum: null,
                    fields: JSON.stringify({}),
                    placeholders: JSON.stringify({}),
                    services: JSON.stringify(current ? json(current.services, []) : []),
                    status: 'generated',
                    generated_by: ctx.userId ?? null, created_at: now(),
                });
                const linked = linkGeneratedRecord(ctx, {
                    docType, account, deal, fields: {}, version, documentId,
                });
                recordEvent(ctx, {
                    generationId, documentId, eventType: 'version_created',
                    metadata: { version, uploaded: true, name: safeName, note, record: linked?.id },
                });
                result = { generationId, record: linked };
            }

            audit(ctx, {
                objectKey: 'document', recordId: documentId, accountId: account.id,
                action: mode === 'replace_current' ? 'document_version_replaced' : 'document_version_uploaded',
                after: {
                    document_type: docTypeKey, version, name: safeName,
                    mode, note, record: result.record?.id ?? null,
                },
            });
        });
    } catch (err) {
        // The rows failed, so the file on disk is an orphan — invisible to
        // every listing and impossible to clean up later.
        removeFile(storageKey);
        throw err;
    }

    return {
        mode,
        version,
        generation: get('SELECT * FROM document_generations WHERE id = ?', [result.generationId]),
        document: getRecord('document', ctx, documentId),
        record: result.record
            ? {
                object: docType.category === 'agreement' ? 'agreement' : 'proposal',
                id: result.record.id,
                number: result.record.number,
            }
            : null,
    };
}

/** The proposal or agreement row a generation produced, if it still exists. */
function linkedRecordFor(ctx, docType, generation) {
    const table = docType.category === 'agreement' ? 'agreements' : 'proposals';
    return get(
        `SELECT * FROM ${table} WHERE workspace_id = ? AND document_id = ? AND deleted_at IS NULL`,
        [ctx.workspaceId, generation.document_id],
    ) ?? null;
}

/**
 * A record whose file changed has not been approved — that approval was of
 * different content.
 *
 * Sends it back to `pending_review` and raises the approval task, which is the
 * same path `submitForReview` takes. A draft that was never submitted stays a
 * draft: there is nothing to un-approve, and dragging it into review would
 * submit somebody's unfinished work on their behalf.
 */
function reopenForReview(ctx, docType, record, documentId, { because }) {
    const table = docType.category === 'agreement' ? 'agreements' : 'proposals';
    const objectKey = docType.category === 'agreement' ? 'agreement' : 'proposal';

    update(table, record.id, {
        document_id: documentId,
        ...(record.status === 'draft' ? {} : {
            status: 'pending_review',
            submitted_at: now(),
            reviewed_by: null,
            reviewed_at: null,
            review_note: null,
        }),
        updated_at: now(),
    });

    audit(ctx, {
        objectKey, recordId: record.id, accountId: record.account_id,
        action: 'document_replaced', source: 'ui',
        before: { status: record.status, document_id: record.document_id },
        after: { status: record.status === 'draft' ? 'draft' : 'pending_review', document_id: documentId, because },
    });

    if (record.status !== 'draft') {
        openApprovalTask(ctx, objectKey, get(`SELECT * FROM ${table} WHERE id = ?`, [record.id]));
    }
}
