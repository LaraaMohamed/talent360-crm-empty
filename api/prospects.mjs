/**
 * Prospecting-specific endpoints: verdicts, evidence and requalification.
 */
import { all, get, run, id, now } from '../lib/db.mjs';
import { getRecord, idsMatching } from '../lib/repo.mjs';
import { readJson, badRequest } from '../lib/http.mjs';
import { require$, can } from '../lib/auth.mjs';
import { previewPromotion, promote } from '../lib/promotion.mjs';
import { audit } from '../lib/repo.mjs';
import {
    activeRules, recordEvidence, qualifyProspect, verdictHistory, evidenceHistory,
} from '../lib/qualification.mjs';

export async function verdicts({ params, ctx }) {
    const prospect = getRecord('prospecting_company', ctx, params.id);
    const rules = activeRules(ctx.workspaceId);
    const history = verdictHistory(ctx.workspaceId, params.id, 'prospect');
    const staleDays = ctx.workspace.verdictStaleDays;

    const current = {};
    for (const rule of rules) {
        const row = history.find((v) => v.rule_key === rule.key && v.is_current);
        current[rule.key] = {
            rule: rule.key,
            label: rule.label,
            summary: rule.summary,
            claimType: rule.claim_type,
            ruleVersion: rule.version,
            verdict: row?.verdict ?? 'UNRESOLVED',
            confidence: row?.confidence ?? null,
            metrics: row?.metrics ?? {},
            source: row?.source ?? 'engine',
            decisionNote: row?.decision_note ?? null,
            reasons: row?.reasons ?? [],
            notes: row?.notes ?? (prospect.linkedin_slug
                ? ['No verdict yet. Run the rule to evaluate the collected evidence.']
                : ['No LinkedIn slug on this prospect, so there is no identity to collect evidence against.']),
            computedAt: row?.computed_at ?? null,
            evidenceId: row?.evidence_id ?? null,
            stale: row ? Date.now() - new Date(row.computed_at).getTime() > staleDays * 864e5 : true,
        };
    }

    const deciderNames = new Map(all('SELECT id, name FROM users').map((u) => [u.id, u.name]));
    return {
        prospect,
        current,
        history: history.map((v) => ({
            id: v.id,
            rule: v.rule_key,
            ruleVersion: v.rule_version,
            verdict: v.verdict,
            confidence: v.confidence,
            computedAt: v.computed_at,
            supersededAt: v.superseded_at,
            isCurrent: !!v.is_current,
            reasons: v.reasons,
            notes: v.notes,
            source: v.source ?? 'engine',
            decidedBy: v.decided_by ?? null,
            decidedByName: v.decided_by ? deciderNames.get(v.decided_by) ?? 'Unknown' : null,
            decisionNote: v.decision_note ?? null,
        })),
        staleDays,
    };
}

export async function evidence({ params, ctx }) {
    const prospect = getRecord('prospecting_company', ctx, params.id);
    const snapshots = evidenceHistory(ctx.workspaceId, params.id, 25, 'prospect');
    const latest = snapshots[0] ?? null;
    return {
        prospect,
        latest: latest ? shapeEvidence(latest) : null,
        history: snapshots.map((s) => ({
            id: s.id,
            provider: s.provider,
            collectedAt: s.collected_at,
            error: s.error,
            hasPanels: !!(s.payload?.locations?.length || s.payload?.functions?.length),
        })),
        gaps: latest ? describeGaps(latest.payload) : [],
    };
}

/**
 * Promote qualified prospects into the CRM.
 *
 * Preview and execute share one implementation, so what the dialog promises is
 * literally what runs.
 */
export async function previewImport({ req, ctx }) {
    const body = await readJson(req);
    const ids = await resolveIds(body, ctx);
    return previewPromotion(ctx, ids, { force: body.force === true });
}

export async function runImport({ req, ctx }) {
    require$(ctx, can(ctx, 'record.write.all') ? 'record.write.all' : 'record.write.own');
    const body = await readJson(req);
    const ids = await resolveIds(body, ctx);
    if (!ids.length) throw badRequest('Select some companies to import.');
    if (ids.length > 2000) throw badRequest(`That is ${ids.length} companies. Narrow the selection.`);

    const result = promote(ctx, ids, { force: body.force === true, ownerId: body.ownerId ?? null });
    return {
        ...result,
        note: `${result.accountsCreated} account${result.accountsCreated === 1 ? '' : 's'} created`
            + `${result.accountsMerged ? `, ${result.accountsMerged} matched an existing account` : ''}`
            + `, ${result.contactsCreated} contact${result.contactsCreated === 1 ? '' : 's'} imported`
            + `${result.contactsExcluded ? `, ${result.contactsExcluded} excluded by the "${result.policy}" email policy` : ''}.`,
    };
}

async function resolveIds(body, ctx) {
    if (Array.isArray(body.ids) && body.ids.length) return body.ids;
    if (body.all) {
        return idsMatching('prospecting_company', ctx, {
            filter: body.filter ?? null, listId: body.listId ?? null, q: body.q ?? null,
        }).ids;
    }
    return [];
}

export async function runOne({ req, params, ctx }) {
    require$(ctx, 'qualification.run');
    const body = await readJson(req).catch(() => ({}));
    const rules = Array.isArray(body.rules) && body.rules.length
        ? body.rules
        : activeRules(ctx.workspaceId).map((r) => r.key);
    const results = [];
    for (const rule of rules) {
        results.push(await qualifyProspect(ctx, params.id, rule, { source: 'ui' }));
    }
    return { results };
}

export async function attachEvidence({ req, params, ctx }) {
    require$(ctx, 'qualification.run');
    const prospect = getRecord('prospecting_company', ctx, params.id);
    const body = await readJson(req);
    if (!body.payload || typeof body.payload !== 'object') {
        throw badRequest('Send the observation as a `payload` object — the raw panels, exactly as collected.');
    }

    const evidenceId = recordEvidence(ctx, {
        prospectId: prospect.id,
        subjectKey: prospect.linkedin_slug ?? prospect.domain ?? prospect.id,
        provider: body.provider ?? 'manual',
        collectedAt: body.collectedAt ?? now(),
        payload: body.payload,
        error: body.error ?? null,
    });
    audit(ctx, {
        objectKey: 'prospecting_company', recordId: prospect.id, action: 'evidence_recorded',
        after: { evidenceId, provider: body.provider ?? 'manual' },
    });

    const results = [];
    for (const rule of activeRules(ctx.workspaceId)) {
        results.push(await qualifyProspect(ctx, prospect.id, rule.key, { source: 'api' }));
    }
    return { evidenceId, results };
}

function shapeEvidence(row) {
    const p = row.payload ?? {};
    const clean = (rows) => (rows === undefined || rows === null ? null : rows.map((r) => ({
        label: String(r.label ?? '').replace(/\s*toggle (on|off)\s*/gi, '').trim(),
        rawLabel: r.label,
        count: r.count,
    })));
    return {
        id: row.id,
        provider: row.provider,
        collectedAt: row.collected_at,
        subjectKey: row.subject_key,
        error: row.error,
        companyName: p.companyName ?? null,
        companyUrl: p.companyUrl ?? null,
        totalMembers: p.totalMembers ?? null,
        panels: {
            location: clean(p.locations),
            function: clean(p.functions),
            school: clean(p.schools),
            skill: clean(p.skills),
        },
        usedBy: {
            location: ['offshoring'],
            function: ['hcm'],
            school: ['offshoring (affinity only)'],
            skill: ['hcm'],
        },
        about: p.about ?? null,
        jobs: p.jobs ?? null,
        raw: p,
    };
}

function describeGaps(payload) {
    const gaps = [];
    if (!payload?.schools) {
        gaps.push('No "Where they studied" panel was saved for this collection, so the Egyptian-education affinity signal reads empty — that is a missing field, not a missing signal.');
    }
    if (!payload?.skills) {
        gaps.push('No "What they are skilled at" panel was saved, so the HR-skills signal reads empty for the same reason.');
    }
    if (!payload?.about) {
        gaps.push('No company About tab was collected, so industry, website and founding year are unknown rather than absent.');
    }
    return gaps;
}
