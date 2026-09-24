/**
 * EmailTemplateService — the four business-email templates, and nothing
 * else. Not a marketing template builder: `CATEGORIES` below is the whole
 * list, and it is not meant to grow into one.
 *
 * ── SYSTEM TEMPLATES ─────────────────────────────────────────────────────────
 *
 * Every workspace gets one template per category, seeded on first read
 * (`ensureDefaults`) with the exact subject/body the product ships with. A
 * system template's CATEGORY can never change — that is what "system" means
 * here: the automation that fires `agreement_signed_finance` has to find
 * something in that category, always, or the workspace's finance team
 * silently stops hearing about signed agreements. Its subject and body are
 * editable like any other template; only the category and the `is_system`
 * flag are locked. A system template can be deactivated but not deleted, for
 * the same reason — deactivating leaves the automation with nothing active
 * to send from, which is a decision an admin gets to make deliberately, not
 * a side effect of tidying up templates.
 */
import { all, get, run, id, now } from './db.mjs';
import { badRequest, notFound } from './http.mjs';

export const CATEGORIES = [
    'proposal_client',
    'agreement_client',
    'agreement_signed_finance',
    'agreement_signed_internal',
];

const CATEGORY_LABELS = {
    proposal_client: 'Proposal → Client',
    agreement_client: 'Agreement → Client',
    agreement_signed_finance: 'Agreement Signed → Finance',
    // Triggered by the signature, but the content is the proposal's scope
    // (redacted of price) — see lib/internal-proposal.mjs.
    agreement_signed_internal: 'Proposal Scope → Internal Team',
};
export function categoryLabel(category) { return CATEGORY_LABELS[category] ?? category; }

/** The exact defaults from the product spec — one per category. */
const DEFAULT_TEMPLATES = {
    proposal_client: {
        name: 'Proposal to client',
        subject: 'Proposal for {{company_name}} - {{service}}',
        body: `Hi {{contact_name}},

It was a pleasure connecting with you.

Please find attached our proposal for {{company_name}} covering {{service}}.

Scope:
{{scope}}

Duration:
{{duration}}

Please let us know if you have any questions.

Best regards,
{{sender_name}}`,
    },
    agreement_client: {
        name: 'Agreement to client',
        subject: 'Agreement for {{company_name}} - {{service}}',
        body: `Hi {{contact_name}},

Please find attached the agreement for {{company_name}} covering {{service}}.

Scope:
{{scope}}

Duration:
{{duration}}

Please review the agreement and let us know if you have any questions.

Best regards,
{{sender_name}}`,
    },
    agreement_signed_finance: {
        name: 'Agreement signed — Finance',
        subject: 'New Signed Agreement - {{company_name}} - {{service}}',
        body: `Hi Finance Team,

The agreement with {{company_name}} has been signed.

Client:
{{company_name}}

Contact:
{{contact_name}}

Email:
{{contact_email}}

Website:
{{website}}

Service:
{{service}}

Scope:
{{scope}}

Duration:
{{duration}}

Agreement Start:
{{agreement_start_date}}

Agreement End:
{{agreement_end_date}}

Deal Value:
{{deal_size}} {{currency}}

Please find attached:

1. Signed Agreement
2. Client Proposal

Best regards,
{{sender_name}}`,
    },
    agreement_signed_internal: {
        name: 'Agreement signed — Internal team',
        // "Internal Team Proposal" in the subject, not "Agreement" — this
        // email attaches the pricing-stripped internal proposal, never the
        // signed agreement itself (that goes to Finance only). The subject
        // says so up front so it is never mistaken for the agreement email
        // at a glance.
        subject: 'Internal Team Proposal - {{company_name}} - {{service}}',
        body: `Hi Team,

The agreement with {{company_name}} has been signed — please find the Internal Team Proposal attached below.

Client:
{{company_name}}

Contact:
{{contact_name}}

Email:
{{contact_email}}

Website:
{{website}}

Service:
{{service}}

Scope:
{{scope}}

Duration:
{{duration}}

Attached: the Internal Team Proposal. Client information, service and scope only — no pricing.

Best regards,
{{sender_name}}`,
    },
};

function row(r) {
    return r ? { ...r, is_system: !!r.is_system } : null;
}

/** Seeds the one system template per category this workspace does not have yet. Safe to call repeatedly. */
export function ensureDefaults(ctx) {
    for (const category of CATEGORIES) {
        const existing = get(
            'SELECT id FROM email_templates WHERE workspace_id = ? AND category = ? AND is_system = 1 AND deleted_at IS NULL',
            [ctx.workspaceId, category],
        );
        if (existing) continue;
        const def = DEFAULT_TEMPLATES[category];
        const stamp = now();
        run(
            `INSERT INTO email_templates (id, workspace_id, category, name, subject, body, status, is_system, created_by, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,1,?,?,?)`,
            [id('emt'), ctx.workspaceId, category, def.name, def.subject, def.body, 'active', ctx.userId ?? null, stamp, stamp],
        );
    }
}

export function listTemplates(ctx) {
    ensureDefaults(ctx);
    return all(
        'SELECT * FROM email_templates WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY category, is_system DESC, name',
        [ctx.workspaceId],
    ).map(row);
}

export function getTemplate(ctx, templateId) {
    const t = get('SELECT * FROM email_templates WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL', [templateId, ctx.workspaceId]);
    if (!t) throw notFound('That email template does not exist.');
    return row(t);
}

/** The template a category's workflow actually sends from — the active one, or the workspace's default if none is active. */
export function activeTemplateFor(ctx, category) {
    ensureDefaults(ctx);
    return row(
        get(
            `SELECT * FROM email_templates WHERE workspace_id = ? AND category = ? AND deleted_at IS NULL
               ORDER BY (status = 'active') DESC, is_system DESC, updated_at DESC LIMIT 1`,
            [ctx.workspaceId, category],
        ),
    );
}

export function createTemplate(ctx, { category, name, subject, body }) {
    if (!CATEGORIES.includes(category)) throw badRequest(`"${category}" is not a template category this system uses.`);
    if (!name?.trim()) throw badRequest('Give the template a name.');
    if (!subject?.trim()) throw badRequest('The subject cannot be empty.');
    if (!body?.trim()) throw badRequest('The body cannot be empty.');
    const stamp = now();
    const templateId = id('emt');
    run(
        `INSERT INTO email_templates (id, workspace_id, category, name, subject, body, status, is_system, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,0,?,?,?)`,
        [templateId, ctx.workspaceId, category, name.trim(), subject, body, 'draft', ctx.userId ?? null, stamp, stamp],
    );
    return getTemplate(ctx, templateId);
}

/**
 * Editable: name, subject, body, status. NEVER editable: category, is_system
 * — a system template's trigger is a product guarantee, not a user setting.
 */
export function updateTemplate(ctx, templateId, patch) {
    const existing = getTemplate(ctx, templateId);
    const next = {};
    if (patch.name !== undefined) {
        if (!patch.name.trim()) throw badRequest('Give the template a name.');
        next.name = patch.name.trim();
    }
    if (patch.subject !== undefined) {
        if (!patch.subject.trim()) throw badRequest('The subject cannot be empty.');
        next.subject = patch.subject;
    }
    if (patch.body !== undefined) {
        if (!patch.body.trim()) throw badRequest('The body cannot be empty.');
        next.body = patch.body;
    }
    if (patch.status !== undefined) {
        if (!['draft', 'active', 'inactive'].includes(patch.status)) throw badRequest(`"${patch.status}" is not a valid status.`);
        next.status = patch.status;
    }
    if (['category', 'is_system'].some((k) => Object.prototype.hasOwnProperty.call(patch, k))) {
        throw badRequest(existing.is_system
            ? "A system template's category cannot be changed — it is what the automation for that trigger looks for."
            : 'A template category cannot be changed after it is created — duplicate it into the right category instead.');
    }
    if (!Object.keys(next).length) return existing;
    next.updated_at = now();
    run(
        `UPDATE email_templates SET ${Object.keys(next).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
        [...Object.values(next), templateId],
    );
    return getTemplate(ctx, templateId);
}

export function duplicateTemplate(ctx, templateId) {
    const source = getTemplate(ctx, templateId);
    return createTemplate(ctx, {
        category: source.category,
        name: `${source.name} (copy)`,
        subject: source.subject,
        body: source.body,
    });
}

/** A system template is deactivated, never deleted — see the file header. */
export function deleteTemplate(ctx, templateId) {
    const existing = getTemplate(ctx, templateId);
    if (existing.is_system) {
        throw badRequest('A system template cannot be deleted — deactivate it instead, from the status control.');
    }
    run('UPDATE email_templates SET deleted_at = ?, updated_at = ? WHERE id = ?', [now(), now(), templateId]);
    return { ok: true };
}
