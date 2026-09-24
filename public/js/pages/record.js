/**
 * The record detail page — one implementation for every object, with
 * object-specific panels bolted on.
 *
 * For an account this is the most-visited screen in the product, and the
 * VERDICT PANEL sits above the fold, because the verdict is why the account is
 * in the system at all.
 *
 * Fields auto-save on blur with a visible saving/saved indicator. Modals and
 * wizards use explicit submit. The two are never mixed.
 */
import {
    h, mount, navigate, toast, modal, confirm, money, number, date, clock, relative, humanise, bytes, debounce,
} from '../core.js';
import { api, listUrl } from '../api.js';
import * as store from '../store.js';
import {
    verdictBadge, evidenceCard, reasonList, recordForm, fieldControl, timelineList,
    emptyState, skeletonRows, avatar, statTile, cellContent, icon,
    editEntity, entityActions, deleteEntity, dateInput,
} from '../components.js';
import { setPageTitle } from '../app.js';
import { promptText, showQualificationResult, pickCampaign } from './list.js';
import { generateDocumentDialog } from './generate.js';
import { outreachCard, campaignOutreachPanel } from '../outreach.js';
import { makeContractCard, makeReviewCard, makeRegistrationCard, makeDealSizeCard, makePriceHistoryCard, makeStageHistoryCard, makeEmailHealthCard, makeKeyFactsCard, makeDetailsCard, makeCustomerCard, renewalCountdown } from '../cards/record-cards.mjs';

export async function recordPage(content, objectKey, routeName, recordId) {
    const def = store.object(objectKey);
    const container = h('div');
    mount(content, container);

    let data = await api.get(`/api/${routeName}/${recordId}/related`);
    let record = data.record;
    setPageTitle(titleOf(objectKey, record));

    /**
     * Accounts and prospecting companies are both qualification SUBJECTS, and
     * they keep their verdicts in different tables behind different routes.
     * One helper, used everywhere, so a prospect never quietly reads or writes
     * an account's qualification history.
     */
    /**
     * Whether THIS viewer sees the qualification plane on this record.
     *
     * Not just "does this object have verdicts". Qualification is prospecting's
     * conclusion, and an Account is a company somebody decided to work — how it
     * was sourced is upstream of that screen, so the verdict badges, the
     * qualification card and the Verdicts tab are no longer drawn on accounts.
     * They stay on `prospecting_company`, the plane that owns the question.
     *
     * A rep does not hold `prospecting.read` — so for them the tab is not drawn,
     * the badges are not drawn, and, which is the part that matters, `/verdicts`
     * and `/evidence` are never requested. The server refuses both
     * (lib/auth.mjs); asking anyway would draw an error onto a record page that
     * is otherwise theirs to use.
     */
    const qualifies = objectKey === 'prospecting_company' && store.can('prospecting.read');
    const qualRoute = objectKey === 'account' ? 'accounts' : 'prospects';

    /** Both people-objects carry an address a provider can check. */
    const verifiable = objectKey === 'contact' || objectKey === 'prospecting_contact';
    const isOutreachContact = objectKey === 'contact';

    let extras = {};
    if (verifiable) {
        // Never fatal: a contact page must still open when the verification
        // provider is unconfigured or the history table is empty.
        extras.verificationHistory = await api.get(`/api/${routeName}/${recordId}/verification-history`)
            .catch(() => ({ configured: false, entries: [] }));
    }
    if (qualifies) {
        const route = qualRoute;
        const [verdicts, evidence] = await Promise.all([
            api.get(`/api/${route}/${recordId}/verdicts`),
            api.get(`/api/${route}/${recordId}/evidence`),
        ]);
        extras = { verdicts, evidence };
    }
    if (objectKey === 'deal') {
        const [size, generated] = await Promise.all([
            api.get(`/api/deals/${recordId}/size`),
            // Never fatal: a deal must still open when document generation is
            // unavailable or has never been used on it.
            api.get(`/api/deals/${recordId}/documents`).catch(() => ({ documents: [] })),
        ]);
        extras = { size, generated };
    }
    if (objectKey === 'proposal') {
        extras = { detail: await api.get(`/api/proposals/${recordId}/detail`) };
    }
    // The Internal Team Proposal a signed agreement raised, if it has —
    // `ensureInternalTeamProposal` (lib/internal-proposal.mjs) is the only
    // writer of `source_agreement_id`, so this is the same relationship the
    // proposal itself carries, read from the other end.
    if (objectKey === 'agreement') {
        extras = {
            internalProposal: await api.get(listUrl('proposals', {
                filter: { op: 'and', children: [{ field: 'source_agreement_id', operator: 'is', value: recordId }] },
                limit: 1,
            })).then((r) => r.records?.[0] ?? null).catch(() => null),
        };
    }
    // A proposal or agreement written from a template keeps its versions in the
    // generation history, so that is where this page reads them from — the same
    // list the account shows, narrowed to this record's document type.
    if (generatedRecord()) {
        extras.generated = await api.get(`/api/accounts/${record.account_id}/documents?type=${record.document_type}`)
            .catch(() => ({ documents: [] }));
    }
    if (objectKey === 'campaign') {
        const [performance, memberList] = await Promise.all([
            api.get(`/api/campaigns/${recordId}/performance`),
            api.get(`/api/campaigns/${recordId}/members?limit=100`),
        ]);
        extras = { performance, memberList };
    }
    // Which campaigns this person or company is in. Shown on the record rather
    // than only on the campaign, because "why are we emailing them?" is asked
    // from the contact's page, not the campaign's.
    if (objectKey === 'contact' || objectKey === 'account') {
        extras.campaigns = await api.get(`/api/${routeName}/${recordId}/campaigns`);
    }
    if (objectKey === 'contact') {
        extras.outreach = await api.get(`/api/${routeName}/${recordId}/outreach`)
            .then((r) => r.memberships ?? []).catch(() => []);
    }
    /**
     * Whether this contact is currently on somebody's cold calling queue —
     * what the Add/Remove/Open-in-Cold-Calling button needs. Never fatal:
     * a viewer with no calling access at all (neither manage nor
     * assign_own/work) gets `{assignment: null}` from the server rather
     * than a 403, so this never blocks the page from opening.
     */
    if (objectKey === 'contact' && (store.can('calling.manage') || store.can('calling.assign_own') || store.can('calling.work'))) {
        extras.calling = await api.get(`/api/calling/contacts/${recordId}/status`)
            .then((r) => r.assignment).catch(() => null);
    }
    if (objectKey === 'account') {
        // Never fatal: the account page must still open when nothing has ever
        // been generated for it.
        extras.generated = await api.get(`/api/accounts/${recordId}/documents`)
            .catch(() => ({ documents: [] }));
    }

    let activeTab = tabsFor(objectKey)[0].key;

    /**
     * How far each related list has been paged through.
     *
     * Reset by `reload()`, because a reload re-fetches page one — carrying a
     * page number across it would make the next "Load more" skip whatever the
     * reload had just re-read.
     */
    let relatedPaging = {};

    async function reload() {
        data = await api.get(`/api/${routeName}/${recordId}/related`);
        record = data.record;
        relatedPaging = {};
        if (extras) extras.memberListPage = 1;
        if (qualifies) {
            extras.verdicts = await api.get(`/api/${qualRoute}/${recordId}/verdicts`);
            extras.evidence = await api.get(`/api/${qualRoute}/${recordId}/evidence`);
        }
        if (verifiable) {
            extras.verificationHistory = await api.get(`/api/${routeName}/${recordId}/verification-history`)
                .catch(() => extras.verificationHistory ?? { configured: false, entries: [] });
        }
        if (objectKey === 'deal') {
            extras.size = await api.get(`/api/deals/${recordId}/size`);
            extras.generated = await api.get(`/api/deals/${recordId}/documents`)
                .catch(() => extras.generated ?? { documents: [] });
            extras.stageHistory = await api.get(`/api/deals/${recordId}/stage-history`)
                .catch(() => extras.stageHistory ?? { history: [] });
        }
        if (objectKey === 'proposal') {
            extras.detail = await api.get(`/api/proposals/${recordId}/detail`);
        }
        if (objectKey === 'agreement') {
            extras.internalProposal = await api.get(listUrl('proposals', {
                filter: { op: 'and', children: [{ field: 'source_agreement_id', operator: 'is', value: recordId }] },
                limit: 1,
            })).then((r) => r.records?.[0] ?? null).catch(() => extras.internalProposal ?? null);
        }
        if (generatedRecord()) {
            extras.generated = await api.get(`/api/accounts/${record.account_id}/documents?type=${record.document_type}`)
                .catch(() => extras.generated ?? { documents: [] });
        }
        if (objectKey === 'campaign') {
            extras.performance = await api.get(`/api/campaigns/${recordId}/performance`);
            extras.memberList = await api.get(`/api/campaigns/${recordId}/members?limit=100`);
        }
        if (objectKey === 'contact' || objectKey === 'account') {
            extras.campaigns = await api.get(`/api/${routeName}/${recordId}/campaigns`);
        }
        if (objectKey === 'contact') {
            extras.outreach = await api.get(`/api/${routeName}/${recordId}/outreach`)
                .then((r) => r.memberships ?? []).catch(() => extras.outreach ?? []);
        }
        if (objectKey === 'contact' && (store.can('calling.manage') || store.can('calling.assign_own') || store.can('calling.work'))) {
            extras.calling = await api.get(`/api/calling/contacts/${recordId}/status`)
                .then((r) => r.assignment).catch(() => extras.calling ?? null);
        }
        if (objectKey === 'account') {
            extras.generated = await api.get(`/api/accounts/${recordId}/documents`)
                .catch(() => extras.generated ?? { documents: [] });
            // The score breakdown is recomputed live by the server, so this is
            // cheap and always explains the CURRENT inputs. Silent on failure:
            // a score card is decoration next to the record itself.
            extras.score = await api.get(`/api/accounts/${recordId}/score`)
                .catch(() => null);
        }
        paint();
    }

    function paint() {
        mount(container,
            header(),
            h('div.tabs', tabsFor(objectKey).map((t) => h('button.tab', {
                class: t.key === activeTab ? 'active' : '',
                onclick: () => { activeTab = t.key; paint(); },
            }, t.label, countFor(t.key) !== null && h('span.count', String(countFor(t.key)))))),
            h('div.record-layout',
                h('div.stack', tabBody()),
                h('div.stack', sidePanel()),
            ),
        );
    }

    /* ---------------------------------------------------------- header --- */

    function header() {
        const subtitleParts = [];
        if (record.account_id && objectKey !== 'account') {
            subtitleParts.push(h('a', { href: `/accounts/${record.account_id}` }, record.account_name ?? 'Account'));
        }
        if (objectKey === 'account') {
            if (record.industry) subtitleParts.push(h('span', record.industry));
            if (record.country) subtitleParts.push(h('span', record.country));
            if (record.employee_count) subtitleParts.push(h('span', `${number(record.employee_count)} employees`));
            if (record.linkedin_slug) {
                subtitleParts.push(h('a', {
                    href: `https://www.linkedin.com/company/${record.linkedin_slug}/`,
                    target: '_blank', rel: 'noreferrer noopener',
                }, 'LinkedIn ↗'));
            }
        }
        if (objectKey === 'deal') {
            subtitleParts.push(h('span', record.stage_label ?? '—'));
            const hasReporting = record.one_time_reporting != null && record.reporting_currency && record.currency !== record.reporting_currency;
            subtitleParts.push(h('span', `${money(record.value_one_time)} one-time`
                + (hasReporting ? ` (${money(record.one_time_reporting, record.reporting_currency)})` : '')));
            subtitleParts.push(h('span', `${money(record.value_mrr)}/month`
                + (hasReporting ? ` (${money(record.mrr_reporting, record.reporting_currency)}/mo)` : '')));
        }
        subtitleParts.push(h('span', `Updated ${relative(record.updated_at ?? record.created_at)}`));

        return h('div.record-header',
            h('div.record-title',
                h('h1', { dir: 'auto' }, titleOf(objectKey, record)),
                record.lifecycle_stage && h('span.badge', { class: lifecycleKind(record.lifecycle_stage) }, humanise(record.lifecycle_stage)),
                record.status && h('span.badge', { class: { won: 'success', lost: 'danger', signed: 'success' }[record.status] ?? '' }, humanise(record.status)),

                // A price change waiting on a manager is the deal's most
                // urgent fact — the value on screen is not the value proposed.
                objectKey === 'deal' && Number(extras?.size?.openApprovals) > 0
                    ? h('a.badge.warning', {
                        href: '/my-work?tab=approvals',
                        title: `${extras.size.openApprovals} price change(s) awaiting approval — the deal keeps its current value until then.`,
                    }, 'Price approval open')
                    : null,

                // Linked outreach, visible from the campaign header instead of
                // only after opening the right tab.
                objectKey === 'campaign' && record.external_id
                    ? h('button.badge.success', {
                        onclick: () => { activeTab = 'members'; paint(); },
                        title: 'Linked to a Smartlead campaign — open Members for sync, webhook and health.',
                    }, `Smartlead #${record.external_id}`)
                    : null,

                // The verdict, at the top of the account page. It is why the
                // account is here.
                qualifies && Object.values(extras.verdicts?.current ?? {}).map((v) => h('span.row', { style: { gap: '0.2rem' } },
                    h('span.xs.dim', v.label.split(' ')[0]),
                    verdictBadge(v.verdict, { rule: v.rule, at: v.computedAt, stale: v.stale, ruleChangedSinceVerdict: v.ruleChangedSinceVerdict }),
                )),

                h('div.spacer'),
                headerActions(),
            ),
            h('div.record-sub', subtitleParts),
        );
    }

    function headerActions() {
        const actions = [];

        if (qualifies && store.can('qualification.run')) {
            actions.push(h('button.btn', { onclick: () => reQualify() }, icon('qualification'), 'Re-qualify'));
        }

        /**
         * Search + import are free and gated by `people_search.use`, which a
         * rep holds for accounts (lib/auth.mjs). Reveal is a separate,
         * billable step behind `record.write.all` — a rep who opens this
         * dialog gets a request-for-approval flow there instead of a button
         * that 403s (see people-search-dialog.mjs). Prospecting companies
         * stay `record.write.all`-only end to end: a rep never reaches that
         * plane at all.
         */
        const peopleSearchAllowed = objectKey === 'account'
            ? (store.can('people_search.use') || store.can('record.write.all'))
            : objectKey === 'prospecting_company' && store.can('record.write.all');
        if (peopleSearchAllowed) {
            actions.push(h('button.btn', {
                title: 'Find people at this company via Apollo (titles + LinkedIn first; reveal email/phone as you choose)',
                onclick: async () => {
                    const { findPeopleDialog } = await import('../people-search-dialog.mjs');
                    const companyRoute = objectKey === 'prospecting_company' ? 'prospecting_companies' : 'accounts';
                    await findPeopleDialog({ company: record, subjectType: objectKey, subjectId: recordId, companyRoute });
                    await reload();
                },
            }, icon('people'), 'Find people'));
        }
        if (objectKey === 'account') {
            // The entry point to the whole document workflow, on the record the
            // documents are actually about.
            if (store.can('proposal.issue')) {
                actions.push(h('button.btn.primary', {
                    onclick: () => generateDocument(),
                }, icon('proposal'), 'Generate document'));
            }
            if (store.can('record.write.all') || store.can('record.write.own')) {
                actions.push(h('button.btn', { onclick: () => createDeal() }, '+ Deal'));
                actions.push(h('button.btn', { onclick: () => createContact() }, '+ Contact'));
            }
        }

        /**
         * The contact page's own door into Cold Calling — "everything is
         * connected" rather than needing to go find this same contact from
         * inside the calling module's own queue table.
         *
         * On the queue already → Open (deep-links into Cold Calling, see
         * `openInColdCalling`) plus Remove, the latter only for whoever
         * actually holds `calling.manage` (removeFromQueue refuses anyone
         * else server-side — see api/calling.mjs). Not on it → Add, for
         * anyone who can put a contact on a queue at all: a manager picks
         * who it goes to, a rep (calling.assign_own, no calling.manage) can
         * only ever add it to their own, so that one skips the picker.
         */
        if (objectKey === 'contact' && extras.calling !== undefined
            && (store.can('calling.manage') || store.can('calling.assign_own'))) {
            if (extras.calling) {
                actions.push(h('button.btn', { onclick: () => openInColdCalling() }, icon('phone'), 'Open in Cold Calling'));
                if (store.can('calling.manage')) {
                    actions.push(h('button.btn.ghost', { onclick: () => removeFromColdCalling() }, icon('close'), 'Remove from Cold Calling'));
                }
            } else {
                actions.push(h('button.btn', { onclick: () => addToColdCalling() }, icon('phone'), 'Add to Cold Calling'));
            }
        }

        /**
         * Neither an SDR nor a rep may move a contact onto somebody else's
         * calling queue directly — `assignContacts` (lib/calling.mjs) forces
         * `assignedTo = ctx.userId` for anyone without `calling.manage`.
         * This is the door instead: nothing moves until a manager reviews
         * it. A manager/admin already has the real assign flow (Cold
         * Calling's own bulk bar), so this button is exactly the other
         * side of the same rule — see the identical button and comment in
         * public/js/pages/calling.js's call console.
         *
         */
        if (objectKey === 'contact' && !store.can('calling.manage')
            && (store.can('calling.work') || store.can('calling.assign_own'))) {
            actions.push(h('button.btn', { onclick: () => requestReassignment() }, icon('phone'), 'Request reassignment'));
        }

        if (objectKey === 'deal') {
            /**
             * Generating FROM the deal, which the wizard has always supported.
             *
             * `generateDocument` already passes `dealId` when it is called from
             * a deal, `/api/deals/:id/documents` exists, and this page fetches
             * that deal's generation history to show it. The one thing missing
             * was the button — so the only route to a document was the account
             * page, which is the route that produced an agreement attached to
             * no deal. Generating from here attaches it by construction.
             */
            if (store.can('proposal.issue')) {
                actions.push(h('button.btn.primary', {
                    onclick: () => generateDocument(),
                }, icon('proposal'), 'Generate document'));
            }
            if (store.can('deal.stage.change')) {
                actions.push(h('button.btn', { onclick: () => moveStage() }, 'Move stage'));
            }
        }

        /**
         * Draft → Pending review → Approved / Rejected.
         *
         * Two buttons, and which one you see depends on where the document is
         * and what you may do to it — not on your role alone. An author sees
         * "Submit for review" on a draft; a manager sees Approve and Reject on
         * something waiting. Nobody sees a button that would answer 403.
         *
         * The server refuses all of this independently. This decides what is
         * DRAWN, which is a different job from what is allowed.
         */
        if (objectKey === 'proposal' || objectKey === 'agreement') {
            if (['draft', 'rejected'].includes(record.status)
                && (store.can('record.write.all') || store.can('record.write.own'))) {
                actions.push(h('button.btn.primary', {
                    onclick: () => submitForReview(),
                },
                icon(record.status === 'rejected' ? 'refresh' : 'arrowRight'),
                record.status === 'rejected' ? 'Resubmit for review' : 'Submit for review'));
            }
            if (record.status === 'pending_review' && store.can('document.approve')) {
                actions.push(h('button.btn.primary', { onclick: () => reviewDocument('approved') }, icon('check'), 'Approve'));
                actions.push(h('button.btn', { onclick: () => reviewDocument('rejected') }, icon('close'), 'Reject'));
            }
            /**
             * A .docx proposal goes draft → pending_review → issued in one
             * step (no per-version Issue/Mark sent pair like a line-item
             * proposal has — see the Versions card) — so this is its one
             * "the document left the building" moment, moving the deal's
             * pipeline stage to Proposal sent the same way the version-level
             * action does. Gated on `document_type` so a line-item proposal —
             * which reaches this same `issued` status through its OWN
             * per-version button — never shows both at once.
             */
            // An Internal Team Proposal is never "sent" — nobody outside the
            // company reads it, and it does not move a deal's pipeline stage
            // the way a real client send does. Offering the button here read
            // as an instruction to send pricing-stripped internal paperwork
            // to a client.
            if (objectKey === 'proposal' && record.type !== 'internal_team'
                && record.document_type && record.status === 'issued' && store.can('proposal.issue')) {
                actions.push(h('button.btn.primary', {
                    onclick: async () => {
                        await api.post(`/api/proposals/${recordId}/sent`, {});
                        toast('Marked as sent — the deal moved to Proposal sent.', 'success');
                        reload();
                    },
                }, icon('arrowRight'), 'Mark sent'));
            }

            // Client-facing: the two categories a person starts by hand
            // (lib/email-templates.mjs's other two only ever fire from
            // signing). Needs a generated document to attach — nothing to
            // send before that exists.
            if (objectKey === 'proposal' && record.type !== 'internal_team' && record.document_type
                && ['issued', 'sent', 'accepted'].includes(record.status) && store.can('proposal.issue')) {
                actions.push(h('button.btn', {
                    onclick: async () => { const { openSendEmailDialog } = await import('../email-send.js'); await openSendEmailDialog({ category: 'proposal_client', proposalId: recordId }); },
                }, icon('mail'), 'Send email'));
            }
            if (objectKey === 'agreement' && record.document_type
                && ['pending_review', 'approved', 'out_for_signature', 'signed'].includes(record.status) && store.can('proposal.issue')) {
                actions.push(h('button.btn', {
                    onclick: async () => { const { openSendEmailDialog } = await import('../email-send.js'); await openSendEmailDialog({ category: 'agreement_client', agreementId: recordId }); },
                }, icon('mail'), 'Send email'));
            }
        }

        /**
         * "Change deal" used to live here as well as on the Contract card.
         *
         * Two buttons opening one dialog, a scroll apart, and the header's said
         * nothing about why anybody would press it. The card's version sits
         * beside the deal it changes and explains what the link is for, so this
         * one is gone — the header is for the thing you came to this page to
         * DO, and the relationship is edited where it is shown.
         */

        // Signing waits for approval, so the button does too — offering it on an
        // unapproved agreement is offering a 403.
        if (objectKey === 'agreement' && ['approved', 'out_for_signature'].includes(record.status)
            && store.can('agreement.sign')) {
            actions.push(h('button.btn.primary', { onclick: () => signAgreement() }, 'Record signature'));
        }

        // Renewing only makes sense once there is a term to renew — a draft
        // or a rejected agreement has nothing signed to extend.
        if (objectKey === 'agreement' && record.status === 'signed' && store.can('proposal.issue')) {
            actions.push(h('button.btn', { onclick: () => renewAgreement() }, icon('refresh'), 'Create renewal'));
        }

        actions.push(...leafActions());
        if (store.can('record.write.all') || store.can('record.write.own')) {
            actions.push(h('button.btn', { onclick: () => logActivity() }, '＋ Log activity'));
        }
        // Quota: keep header to one row on laptop — first actions + Log/More stay
        // visible, the middle overflows into More. Computed before More itself
        // is built, so its onclick is right the first time — h() elements carry
        // no props/children back out, so there is nothing to patch afterward.
        const overflow = actions.length > 5 ? actions.splice(2, actions.length - 3) : [];
        const moreBtn = h('button.btn.ghost.icon', {
            title: overflow.length ? `More — ${overflow.length} more actions` : 'More',
            onclick: (e) => moreMenu(e, overflow.length ? overflow : null),
        }, icon('more'));
        actions.push(moreBtn);
        return h('div.row', { style: { flexWrap: 'wrap', gap: 'var(--space-2)' } }, actions);
    }

    /**
     * The leaf objects — a task, a note, an activity — carry their own actions.
     *
     * A task page should not make somebody go hunting through the Details card
     * and the More menu for the things a task IS: change it, attach a note to it.
     * So the header offers them directly, with the same dialogs every other
     * surface uses. Log activity is already the button beside them, added below
     * for every object.
     */
    function leafActions() {
        const actions = [];
        if (!['task', 'note', 'activity'].includes(objectKey)) return actions;
        const editable = store.can('record.write.all') || store.can('record.write.own');
        if (editable) {
            actions.push(h('button.btn', { onclick: () => editDetails() }, icon('edit'), 'Edit'));
        }
        // A note records a thought; attaching more notes to a note is a thought
        // about a thought. Tasks and activities are where work accumulates, so
        // they take notes.
        if (objectKey === 'task' || objectKey === 'activity') {
            actions.push(h('button.btn', { onclick: () => addNote() }, '+ Note'));
        }
        return actions;
    }

    async function moreMenu(_e, overflow = null) {
        const choice = await modal({
            title: 'Actions',
            size: 'narrow',
            body: (close) => h('div.stack.tight',
                overflow && overflow.length
                    ? h('div.stack.tight', { style: { paddingBlockEnd: 'var(--space-2)', borderBlockEnd: '1px solid var(--color-border-subtle)', marginBlockEnd: 'var(--space-2)' } },
                        // The overflowed buttons are real elements already built
                        // with their own onclick — h() attaches that via
                        // addEventListener, which .click() re-dispatches to
                        // correctly. Their rendered markup (icon + label) is
                        // cloned in rather than reconstructed from nothing.
                        ...overflow.map((btn) => h('button.btn.block', {
                            onclick: () => { close('__overflow'); btn.click(); },
                        }, h('span', { html: btn.innerHTML }))),
                    ) : null,
                (store.can('record.write.all') || store.can('record.write.own'))
                    && h('button.btn.block', { onclick: () => close('task') }, 'Add task'),
                (store.can('record.write.all') || store.can('record.write.own'))
                    && h('button.btn.block', { onclick: () => close('note') }, 'Add note'),
                (store.can('record.write.all') || store.can('record.write.own'))
                    && h('button.btn.block', { onclick: () => close('upload') }, 'Upload document'),
                objectKey === 'account' && store.can('record.write.all') && h('button.btn.block', { onclick: () => close('addToCampaign') }, 'Add to campaign'),
                objectKey === 'account' && h('button.btn.block', { onclick: () => close('duplicates') }, 'Find duplicates'),
                h('button.btn.block', { onclick: () => close('audit') }, 'Audit trail'),
                store.can('record.delete') && h('button.btn.block.danger', { onclick: () => close('delete') }, 'Delete'),
            ),
        });
        if (choice === 'task') return addTask();
        if (choice === 'note') return addNote();
        if (choice === 'upload') return uploadDocument();
        if (choice === 'addToCampaign') return addAccountToCampaign();
        if (choice === 'duplicates') return showDuplicates();
        if (choice === 'audit') return showAudit();
        if (choice === 'delete') return deleteRecord();
        return undefined;
    }

    /**
     * A single account, from its own record page — the other end of the same
     * flow the Accounts list's bulk "Add to campaign" and a campaign's own
     * "+ Accounts" button already offer. Always pulls in the account's
     * contacts too: an account with no contacts enrolled is not the campaign
     * audience, its people are — see lib/campaigns.mjs's includeContacts cascade.
     */
    async function addAccountToCampaign() {
        const campaignId = await pickCampaign();
        if (!campaignId) return;
        try {
            const result = await api.post(`/api/campaigns/${campaignId}/members`, {
                memberType: 'account', ids: [recordId], includeContacts: true,
            });
            const parts = [`${record.name} added`];
            if (result.skipped) parts.push('already in it');
            if (result.cascaded) parts.push(`plus ${result.cascaded.added} contact(s)`);
            toast(`${parts.join(', ')}.`, 'success');
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    /* ------------------------------------------------------------ tabs --- */

    /**
     * Is this record a proposal or agreement written from a .docx template?
     *
     * The same two objects hold both kinds. One is built from a deal's line
     * items and keeps its versions in `proposal_versions`; the other is
     * generated from a template and keeps them in the generation history. This
     * is the only thing on the page that has to know which.
     */
    function generatedRecord() {
        return (objectKey === 'proposal' || objectKey === 'agreement') && Boolean(record.document_type);
    }

    /**
     * Eleven tabs became six, by merging the ones that were halves of the same
     * question rather than by hiding anything.
     *
     *   Qualification + Evidence   the verdict and the observation it rests on
     *                              are one argument. Reading a verdict meant
     *                              switching tabs to check what it was computed
     *                              from, and switching back.
     *   Proposals + Agreements
     *     + Documents              all three are "what have we sent this
     *                              company", and the reader was doing the
     *                              filtering that three tabs implied.
     *   Timeline + Tasks + Notes   what happened, what is owed and what was
     *                              written down. Nobody asks exactly one of
     *                              those about an account they have opened.
     *
     * Nothing is unreachable and nothing is decided by inferring state — in
     * particular Qualification stays for every account, not only ones that
     * still look like prospects. A customer's verdict history is the answer to
     * "why did we ever call these people", and a lifecycle guess is a poor
     * reason to make it unreachable.
     */
    function tabsFor(key) {
        const base = [{ key: 'overview', label: 'Overview' }];

        // Qualification is prospecting's question. A prospecting company carries
        // its Verdicts tab; an Account is a company somebody decided to work, so
        // the verdict UI is not offered there. Contacts and Deals stay
        // account-only: a prospect has neither until it is imported.
        if (key === 'prospecting_company') {
            base.push({ key: 'verdict', label: 'Qualification' });
        }
        if (key === 'account') {
            base.push(
                { key: 'contacts', label: 'Contacts' },
                { key: 'deals', label: 'Deals' },
            );
        }
        // Deal size is one price and one currency, so it is a card on the
        // overview rather than a tab of line items to go and find.
        if (key === 'proposal' && !generatedRecord()) base.push({ key: 'versions', label: 'Versions' });
        // A generated proposal or agreement IS one document, and it appears
        // inside the Documents tab rather than beside it. There was briefly a
        // "Document" tab next to a "Documents" tab — two labels one letter
        // apart, which is a puzzle rather than a distinction.
        if (key === 'campaign') base.push({ key: 'members', label: 'Members' }, { key: 'performance', label: 'Performance' });

        base.push(
            { key: 'documents', label: 'Documents' },
            { key: 'activity', label: 'Activity' },
        );
        return base;
    }

    const generatedOf = (category) => (extras.generated?.documents ?? [])
        .filter((row) => (category ? row.category === category : true))
        // A generated proposal or agreement IS one document, so its own page
        // shows that one. The other versions are not hidden — they are their
        // own records, sitting beside it in the same list.
        .filter((row) => !generatedRecord() || row.document_id === record.document_id);

    /**
     * A count is shown only where it means ONE unambiguous thing.
     *
     * The merged tabs deliberately carry none. "Activity 14" would be tasks
     * plus notes plus logged calls added together, which is a number nobody
     * asked for and would be read as whichever of the three the reader had in
     * mind. Documents is the exception: every row under it is a document, so
     * the total is the total.
     */
    function countFor(tab) {
        /**
         * The server's count, not the length of what it sent.
         *
         * These are capped lists. A tab reading "200" beside an account with
         * 1,400 contacts is not a smaller truth, it is a wrong one — and it is
         * the number people quote at each other in meetings.
         */
        const map = {
            contacts: data.counts?.contacts ?? data.related.contacts?.length,
            deals: data.counts?.deals ?? data.related.deals?.length,
            // Every file filed against this record, PLUS the record's own
            // generated file when it has one. The comment above this used to
            // say "not plus the generated ones, that double-counts" — true for
            // an ACCOUNT (whose generated proposals/agreements are separate
            // records with their own `documents` rows already in this count),
            // false for a proposal or agreement's OWN page: its generated
            // file is never in `data.related.documents` at all (that relation
            // is uploads/attachments), so this badge read 0 for a document
            // `documentsTabMerged()` was about to show right there in the tab.
            documents: (data.counts?.documents ?? data.related.documents?.length ?? 0) + (generatedRecord() ? 1 : 0),
            versions: extras.detail?.versions?.length,
            members: extras.memberList?.total,
        };
        return map[tab] ?? null;
    }

    function tabBody() {
        switch (activeTab) {
            case 'overview': return overviewTab();
            case 'verdict': return verdictTab();
            case 'contacts': return relatedTable('contact', 'contacts', data.related.contacts ?? []);
            case 'deals': return relatedTable('deal', 'deals', data.related.deals ?? []);
            case 'versions': return versionsTab();
            case 'members': return membersTab();
            case 'performance': return performanceTab();
            case 'documents': return documentsTabMerged();
            case 'activity': return activityTab();
            default: return null;
        }
    }

    /** An account's Internal Team Proposals that were built without a docx template — see the field's own comment in api/records.mjs. */
    function looseInternalProposalsCard() {
        const rows = data.related.looseInternalProposals ?? [];
        if (!rows.length) return null;
        return h('div.card',
            h('div.card-header', h('h2', 'Internal Team Proposals'),
                h('span.xs.dim', 'Built from a proposal with no document template — rendered on open, not a file.')),
            h('div.card-body.flush', h('div.table-wrap', h('table.data',
                h('thead', h('tr', h('th', 'Number'), h('th', 'Title'), h('th', 'Created'), h('th', ''))),
                h('tbody', rows.map((p) => h('tr',
                    h('td', p.number),
                    h('td', p.title),
                    h('td', { title: date(p.created_at, { withTime: true }) }, relative(p.created_at)),
                    h('td', h('a.btn.sm.ghost', { href: `/proposals/${p.id}` }, 'Open')),
                ))),
            ))),
        );
    }

    /**
     * Everything this company has been sent, plus everything filed against it.
     *
     * Proposals and agreements keep their own headed sections — they are
     * different conversations and the distinction is worth a heading — but they
     * are no longer two tabs away from each other and from the files.
     */
    function documentsTabMerged() {
        const cards = [];
        if (objectKey === 'account') {
            cards.push(generatedDocumentsCard('proposal'));
            cards.push(generatedDocumentsCard('agreement'));
            cards.push(looseInternalProposalsCard());
        }
        if (objectKey === 'deal') {
            cards.push(relatedTable('proposal', 'proposals', data.related.proposals ?? []));
        }
        // The record's own generated file, first — on a proposal or an
        // agreement it is the point of the page, not an attachment to it.
        if (generatedRecord()) cards.unshift(generatedDocumentsCard());
        cards.push(documentsTab());
        return cards.flat().filter(Boolean);
    }

    /**
     * What happened, what is owed, and what somebody wrote down.
     *
     * Tasks first, because it is the only one of the three that is a
     * commitment. The timeline is last and longest — it is the thing you scroll,
     * so nothing useful should sit underneath it.
     */
    function activityTab() {
        return [tasksTab(), notesTab(), timelineTab()].flat().filter(Boolean);
    }

    /* -------------------------------------------------------- overview --- */

    /**
     * The overview READS. It does not ask to be filled in.
     *
     * This tab used to be one card containing every editable field on the
     * object — twenty-two of them for an Account, in an auto-fitting grid, each
     * one an input. That is a form, and a form answers no question. Somebody
     * opening a company wants to know what it buys, what is open on it and who
     * owns it; they were handed a data-entry screen and left to find those three
     * facts among the External IDs.
     *
     * So: the facts first, as facts. Everything else is still here, still one
     * click away, and editing is now a thing you choose to do rather than the
     * only mode on offer.
     */
    function overviewTab() {
        const cards = [];

        /**
         * The one thing this page must say before anything else: this is not
         * the commercial proposal, it carries no price, and here is what it
         * came from. `type`/`source_proposal_id`/`source_agreement_id` are
         * system-set (lib/internal-proposal.mjs) — never a form choice — so
         * this reads the record's own columns rather than inferring anything
         * from its title.
         */
        if (objectKey === 'proposal' && record.type === 'internal_team') {
            cards.push(h('div.card',
                h('div.card-body', h('div.note-box',
                    h('div.strong.small', 'Internal Team Proposal — no commercial pricing'),
                    h('p.xs', 'Generated automatically when the agreement below was signed. It carries the same '
                        + 'client, service and scope detail as the commercial proposal it came from — with every '
                        + 'price, total and currency figure omitted, in the document as well as here.'),
                    h('div.row', { style: { gap: 'var(--space-4)', marginBlockStart: 'var(--space-2)' } },
                        record.source_proposal_id && h('a.small', { href: `/proposals/${record.source_proposal_id}` },
                            'View the commercial proposal →'),
                        record.source_agreement_id && h('a.small', { href: `/agreements/${record.source_agreement_id}` },
                            'View the signed agreement →'),
                    ),
                )),
            ));
        }

        if (qualifies && extras.verdicts) {
            cards.push(verdictSummaryCard());
        }
        if (objectKey === 'account' && extras.score) {
            cards.push(scoreCard());
        }
        if (objectKey === 'deal' && extras.size) {
            cards.push(dealSizeCard());
            // Silent unless there is a history to show or a price to agree to.
            const history = priceHistoryCard();
            if (history) cards.push(history);
        }
        if (objectKey === 'deal' && extras.stageHistory) {
            const stages = stageHistoryCard();
            if (stages) cards.push(stages);
        }

        // The contract itself, above its review: what it is worth and what it
        // closes, before who has and has not signed off on it.
        const contract = contractCard();
        if (contract) cards.push(contract);

        const review = reviewCard();
        if (review) cards.push(review);

        const registration = registrationCard();
        if (registration) cards.push(registration);

        const customer = customerCard();
        if (customer) cards.push(customer);

        cards.push(keyFactsCard());
        cards.push(detailsCard());

        return cards.filter(Boolean);
    }

    /**
     * The handful of fields that identify and qualify this record.
     *
     * Which ones those are is NOT decided here — they are the object's
     * `listDefault` fields, the same set the list page shows as columns. One
     * definition, two surfaces: a field that is worth a column in the list is
     * worth a line at the top of the record, and adding a field to one no longer
     * means remembering the other.
     *
     * The title is skipped because the page is already headed by it.
     */
    /**
     * Where this document is in review, and — if it came back — why.
     *
     * Above Key facts, because on a rejected document this is the only thing
     * the author needs from the page. A rejection reason that lives only in the
     * audit trail is a reason nobody reads; the whole point of requiring one is
     * that it reaches the person who has to act on it.
     *
     * Silent on a document nobody has submitted: an unreviewed draft has no
     * review to report, and a card saying so is noise on every new proposal.
     */
    /**
     * An agreement, and everything it is attached to, on one card.
     *
     * ── WHY THIS EXISTS ─────────────────────────────────────────────────────
     *
     * The page could tell you an agreement's number and its dates. Which client
     * it was for was a link in the header; which DEAL it closed was a field in
     * the Details list, printed as a name with no indication of what stage that
     * deal was in or what it was worth; and what the contract was worth was a
     * third field somewhere else. So the three facts that make an agreement
     * mean anything — who, which sale, how much — were three separate reads of
     * three parts of the screen, and the relationship the CRM is built around
     * was the one thing it did not show.
     *
     * The value and the deal's price are the same number by construction now
     * (`syncAgreementAndDeal` in lib/repo.mjs). Shown side by side anyway, and
     * flagged when they differ, because an agreement written before that rule
     * existed can still disagree and a person has to be able to see it.
     */
    const _contractCard = makeContractCard({
        h, money, date, humanise, statTile, store,
        renewalCountdown: (r) => renewalCountdown(r, Number(store.state.meta?.settings?.default_renewal_notice_days) || 45),
    });
    function contractCard() { return _contractCard(record, extras, objectKey, linkAgreementToDeal, retryInternalProposal); }
    const _reviewCard = makeReviewCard({ h, date, humanise, store });
    function reviewCard() { return _reviewCard(record, objectKey); }
    const _registrationCard = makeRegistrationCard({ h });
    function registrationCard() { return _registrationCard(record, data, objectKey); }
    const _customerCard = makeCustomerCard({
        h, money, date, statTile, store,
        renewalCountdown: (r) => renewalCountdown(r, Number(store.state.meta?.settings?.default_renewal_notice_days) || 45),
    });
    function customerCard() { return _customerCard(record, data, objectKey); }
    const COVERED_BY_CARD = {
        agreement: ['contract_value', 'currency', 'service_line_key', 'effective_date', 'expiry_date', 'account_id', 'status'],
        deal: ['price', 'billing_type', 'currency', 'service_line_key', 'account_id'],
    };

    const _keyFactsCard = makeKeyFactsCard({ h, store, cellContent, COVERED_BY_CARD });
    function keyFactsCard() { return _keyFactsCard(record, objectKey, def); }
    const _detailsCard = makeDetailsCard({ h, store, cellContent, icon, COVERED_BY_CARD });
    function detailsCard() { return _detailsCard(record, objectKey, def, data, editDetails); }
    async function editDetails() {
        await modal({
            title: `Edit ${def.label.toLowerCase()}`,
            size: 'wide',
            body: () => h('div.stack',
                h('p.xs.dim', 'Changes save as you leave each field. Close when you are done.'),
                editableFields(),
            ),
            footer: (close) => [
                h('div.spacer'),
                h('button.btn.primary', { onclick: () => close(true) }, 'Done'),
            ],
        });
        // The dialog wrote straight through to the server field by field, so the
        // page behind it is showing values that may now be stale.
        await reload();
    }

    /**
     * Auto-saving field editor.
     *
     * Saves on blur, not on keystroke, with a visible indicator. Validation
     * errors come back from the server in words and sit under the field.
     */
    function editableFields() {
        const defs = store.fields(objectKey).filter((f) => f.form !== false && !f.computed);
        const indicator = h('span.xs.dim');

        const save = async (fieldDef, value, errorEl) => {
            indicator.textContent = 'Saving…';
            const payload = fieldDef.custom
                ? { properties: { [fieldDef.key.replace('properties.', '')]: value } }
                : { [fieldDef.key]: value };
            try {
                const { record: updated } = await api.patch(`/api/${routeName}/${recordId}`, payload);
                record = updated;
                errorEl.textContent = '';
                indicator.textContent = 'Saved';
                setTimeout(() => { if (indicator.textContent === 'Saved') indicator.textContent = ''; }, 1800);
            } catch (err) {
                errorEl.textContent = err.message;
                indicator.textContent = '';
            }
        };

        return h('div.stack',
            h('div.row', h('div.spacer'), indicator),
            h('div.grid', { style: { gridTemplateColumns: 'repeat(auto-fit, minmax(15rem, 1fr))' } },
                defs.map((fieldDef) => {
                    const controlId = `edit_${fieldDef.key.replace(/\W/g, '_')}`;
                    const errorEl = h('span.error');
                    const value = fieldDef.custom
                        ? record.properties?.[fieldDef.key.replace('properties.', '')]
                        : record[fieldDef.key];

                    if (fieldDef.readOnly) {
                        return h('div.field',
                            h('label', fieldDef.label),
                            h('div.small', cellContent(objectKey, fieldDef, record)),
                        );
                    }

                    let pending = value;
                    const control = fieldControl(objectKey, fieldDef, value, (v) => { pending = v; }, { id: controlId });
                    control.addEventListener?.('blur', () => {
                        if (String(pending ?? '') !== String(value ?? '')) save(fieldDef, pending, errorEl);
                    }, true);
                    control.addEventListener?.('change', () => {
                        if (['select', 'checkbox', 'multiselect', 'date', 'datetime'].includes(fieldDef.type)) {
                            save(fieldDef, pending, errorEl);
                        }
                    }, true);

                    return h('div.field',
                        h('label', { for: controlId }, fieldDef.label, fieldDef.required && h('span.required', '*')),
                        control,
                        fieldDef.help && h('span.help', fieldDef.help),
                        errorEl,
                    );
                }),
            ),
        );
    }

    /* ------------------------------------------------------- verdicts --- */

    /**
     * Re-running the rules — and noticing when that cannot possibly help.
     *
     * Re-qualifying is an offline re-read of stored evidence. When there is no
     * evidence it can only ever return UNRESOLVED, and saying "hcm: UNRESOLVED"
     * in a green toast presents a dead end as a result. So the dead end is
     * named, and the thing that actually fixes it is offered in the same
     * breath rather than left to be found on another page.
     */
    async function reQualify() {
        let result;
        try {
            result = await api.post(`/api/${qualRoute}/${recordId}/qualify`, {});
        } catch (err) {
            return toast(err.message, 'error');
        }

        const allUnresolved = result.results.length > 0
            && result.results.every((r) => r.verdict === 'UNRESOLVED');

        if (allUnresolved && !extras.evidence?.latest) {
            const collectNow = await confirm({
                title: 'There is nothing to qualify against',
                message: 'No LinkedIn panels have been collected for this company, so no rule has an answer yet '
                    + '— which describes the data, not the company. Collect it now? A Chrome window opens; sign in '
                    + 'there if it asks. It takes about a minute for one company.',
                confirmLabel: 'Collect from LinkedIn',
            });
            if (collectNow) return collectEvidence();
            await reload();
            return undefined;
        }

        toast(result.results.map((r) => `${r.rule}: ${r.verdict}`).join(' · '), 'success');
        await reload();
        return undefined;
    }

    /**
     * Collect this one company's evidence, now.
     *
     * The job runs behind the request — collection means opening a browser and
     * possibly waiting for a person to sign in — so this polls and shows the
     * collector's own output. Its log is shown rather than summarised: when a
     * scrape goes wrong, the line that says why is the whole diagnosis.
     */
    async function collectEvidence() {
        let check;
        try {
            check = await api.get(`/api/${qualRoute}/${recordId}/collectability`);
        } catch (err) {
            return toast(err.message, 'error');
        }
        if (check.blockedBecause && !check.hasEvidence) return toast(check.blockedBecause, 'error');

        const status = h('div.strong.small', 'Starting…');
        const hint = h('div');
        const logBox = h('pre.xs.dim', { style: { maxBlockSize: '12rem', overflow: 'auto', whiteSpace: 'pre-wrap' } });
        let done = false;
        let closeModal;

        const view = modal({
            title: `Collecting ${record.name ?? 'this company'}`,
            size: 'narrow',
            body: (close) => {
                closeModal = close;
                return h('div.stack', status, hint, logBox);
            },
            footer: (close) => [h('button.btn', { onclick: () => close(false) }, 'Close')],
        });

        try {
            const { job } = await api.post(`/api/${qualRoute}/${recordId}/collect`, {});
            let current = job;

            while (current.status === 'running' && !done) {
                mount(hint, current.needsSignIn
                    ? h('div.note-box.warning', 'Sign in to LinkedIn in the Chrome window that just opened. '
                        + 'Collection starts by itself once you are in — leave both windows open.')
                    : h('p.xs.dim', `Reading linkedin.com/company/${current.slug}/people/. This takes about a minute.`));
                status.textContent = current.needsSignIn ? 'Waiting for sign-in…' : 'Collecting…';
                logBox.textContent = current.log.join('\n');

                // eslint-disable-next-line no-await-in-loop
                await new Promise((r) => { setTimeout(r, 2000); });
                // eslint-disable-next-line no-await-in-loop
                ({ job: current } = await api.get(`/api/qualification/collect/${current.id}`));
            }

            logBox.textContent = current.log.join('\n');

            if (current.status === 'failed') {
                status.textContent = 'Collection failed.';
                mount(hint, h('div.note-box.danger', current.error ?? 'The collector did not say why.'));
                return undefined;
            }

            const verdicts = (current.result?.verdicts ?? []).map((v) => `${v.rule}: ${v.verdict}`).join(' · ');
            status.textContent = current.result?.source === 'snapshot-file'
                ? 'Adopted an existing snapshot — no browser needed.'
                : 'Collected.';
            mount(hint, h('div.note-box', verdicts || 'Evidence stored.'));
            done = true;
            closeModal?.(true);
            toast(verdicts ? `Collected. ${verdicts}` : 'Collected.', 'success');
            await reload();
            return undefined;
        } catch (err) {
            status.textContent = 'Collection failed.';
            mount(hint, h('div.note-box.danger', err.message));
            return undefined;
        } finally {
            done = true;
            await view.catch(() => {});
        }
    }

    function verdictSummaryCard() {
        const current = Object.values(extras.verdicts.current);
        return h('div.card',
            h('div.card-header',
                h('h2', 'Qualification'),
                h('div.actions', h('button.btn.sm', { onclick: () => { activeTab = 'verdict'; paint(); } }, 'Full detail')),
            ),
            h('div.card-body',
                h('div.stack',
                    current.map((v) => h('div.stack.tight',
                        h('div.row',
                            verdictBadge(v.verdict, { size: 'lg', rule: v.rule, at: v.computedAt, stale: v.stale, ruleChangedSinceVerdict: v.ruleChangedSinceVerdict }),
                            h('div',
                                h('div.small.strong', v.label),
                                h('div.xs.dim', `${v.summary} · rule v${v.ruleVersion}`),
                            ),
                        ),
                        v.notes?.length > 0 && h('p.xs.muted', v.notes[0]),
                        v.stale && h('div.stale-note', '⏱ Older than the freshness threshold — re-run before acting on it.'),
                    )),
                ),
            ),
        );
    }

    function verdictTab() {
        const v = extras.verdicts;
        return [
            !extras.evidence?.latest && h('div.card',
                h('div.card-body',
                    h('div.note-box.warning',
                        h('div.strong', 'Nothing has been collected for this company'),
                        h('p.small', 'The rules have nothing to run against, so none of them has an answer — '
                            + 'not because the company failed. Re-running them will change nothing until somebody '
                            + 'collects the LinkedIn panels, or enters what they found by hand.'),
                        store.can('qualification.run') && h('div.row', { style: { marginBlockStart: 'var(--space-3)' } },
                            h('button.btn.primary.sm', { onclick: () => collectEvidence() }, 'Collect from LinkedIn'),
                            h('button.btn.sm', { onclick: () => enterEvidence() }, 'Enter it by hand'),
                        ),
                    ),
                ),
            ),

            h('div.card',
                h('div.card-header',
                    h('h2', 'Current verdicts'),
                    store.can('qualification.run') && h('div.actions',
                        h('button.btn.sm', { onclick: () => enterEvidence() }, 'Enter evidence'),
                        h('button.btn.sm.primary', {
                            onclick: () => reQualify(),
                        }, 'Re-run the rules'),
                    ),
                ),
                h('div.card-body',
                    h('div.stack',
                        Object.values(v.current).map((entry) => h('div.stack.tight',
                            h('div.row',
                                verdictBadge(entry.verdict, { size: 'lg', rule: entry.rule, at: entry.computedAt, stale: entry.stale }),
                                h('div',
                                    h('div.strong', entry.label),
                                    h('div.xs.dim', `${entry.summary} · rule v${entry.ruleVersion}`
                                        + (entry.computedAt ? ` · computed ${relative(entry.computedAt)}` : '')),
                                ),
                                h('div.spacer'),
                                // Accounts only: `/decision` has no prospect
                                // equivalent yet, so offering the button on a
                                // prospect would write to the wrong subject or
                                // fail. The history below is still readable.
                                objectKey === 'account' && store.can('qualification.run') && h('button.btn.sm', {
                                    title: 'Record what you found by hand. Appended as a new verdict — the rule\'s answer stays in the history.',
                                    onclick: () => decideVerdict(entry),
                                }, 'Decide'),
                                entry.confidence !== null && entry.confidence !== undefined
                                    && h('span.badge', { title: 'How much the engine trusts this verdict' }, `confidence ${Math.round(entry.confidence * 100)}%`),
                            ),
                            reasonList(entry.reasons),
                            entry.notes?.length > 0 && h('div.note-box',
                                h('div.stack.tight', entry.notes.map((n) => h('p.small', n)))),
                            h('div.xs.dim', entry.claimType === 'absence'
                                ? 'This is an absence test: finding nothing proves nothing unless the panels covered everyone, '
                                  + 'so coverage gates the QUALIFY. A REJECT is definitive at any coverage.'
                                : 'This is a presence test: observing the required count proves it however much was missed, '
                                  + 'so a QUALIFY is definitive at any coverage and the gate sits on the REJECT.'),
                            h('hr', { style: { border: 'none', borderBlockStart: '1px solid var(--color-border-subtle)' } }),
                        )),
                    ),
                ),
            ),

            h('div.card',
                h('div.card-header',
                    h('h2', 'Verdict history'),
                    h('div.actions', h('span.xs.dim', 'Appended, never overwritten')),
                ),
                h('div.card-body.flush',
                    v.history.length === 0
                        ? h('div.empty', h('p', 'No verdicts computed yet.'))
                        : h('div.table-wrap', h('table.data',
                            h('thead', h('tr',
                                h('th', 'Verdict'), h('th', 'Rule'), h('th', 'Version'),
                                h('th', 'Set by'), h('th', 'Computed'), h('th', 'Status'),
                            )),
                            h('tbody', v.history.map((entry) => h('tr',
                                h('td', verdictBadge(entry.verdict)),
                                h('td', entry.rule),
                                h('td', `v${entry.ruleVersion}`),
                                // A verdict a person set and one the rule
                                // computed must never look alike in the history.
                                h('td', entry.source === 'manual'
                                    ? h('span.badge.warning', { title: entry.decisionNote ?? 'Set by hand' },
                                        `by ${entry.decidedByName ?? 'a person'}`)
                                    : h('span.dim.xs', 'the rule')),
                                h('td', { title: date(entry.computedAt, { withTime: true }) }, relative(entry.computedAt)),
                                h('td', entry.isCurrent
                                    ? h('span.badge.accent', 'current')
                                    : h('span.dim.xs', `superseded ${relative(entry.supersededAt)}`)),
                            ))),
                        )),
                ),
            ),

            /**
             * The evidence, underneath the verdicts it produced.
             *
             * This was its own tab, which meant reading a verdict and then
             * leaving the page that showed it to find out what it was computed
             * from. A verdict without its evidence is the score this product
             * exists not to be; they belong on one screen, in that order.
             */
            ...evidenceTab(),
        ];
    }

    /**
     * Recording a decision a person made.
     *
     * The reason is required, and the dialog says what happens to the engine's
     * answer: nothing. It is superseded, not replaced, and a later re-run
     * supersedes the decision in turn — new evidence beats an old judgement.
     */
    async function decideVerdict(entry) {
        const reason = h('textarea.input', {
            dir: 'auto', rows: 3,
            placeholder: 'e.g. Filtered the People tab by Egypt — 6 employees listed, past the threshold of 2.',
        });
        const result = await modal({
            title: `Decide — ${entry.label}`,
            size: 'wide',
            body: (close) => h('div.stack',
                h('div.note-box',
                    h('div.strong', `The rule currently says ${entry.verdict}`),
                    h('p.small', entry.notes?.[0] ?? entry.summary),
                    record.linkedin_slug && h('p.small',
                        h('a', {
                            href: `https://www.linkedin.com/company/${record.linkedin_slug}/people/`,
                            target: '_blank', rel: 'noreferrer noopener',
                        }, 'Open the People tab on LinkedIn ↗')),
                ),
                h('div.field',
                    h('label', 'What did you find?', h('span.required', '*')),
                    reason,
                    h('span.help', 'Required. Recorded on the verdict and on this account\'s timeline.'),
                ),
                h('div.row', ['QUALIFIED', 'REVIEW', 'REJECTED'].map((verdict) => h('button.btn', {
                    onclick: () => close({ verdict }),
                }, verdictBadge(verdict)))),
                h('p.xs.dim',
                    'Appended as a new verdict, attributed to you. The rule\'s own answer stays in the history below, '
                    + 'and re-running the rule supersedes your decision with a freshly computed one.'),
            ),
            footer: (close) => h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
        });
        if (!result) return;
        try {
            const outcome = await api.post(`/api/accounts/${recordId}/decision`, {
                rule: entry.rule, verdict: result.verdict, reason: reason.value,
            });
            toast(`${outcome.previous ?? 'No verdict'} → ${outcome.verdict}. The rule's answer is still in the history.`, 'success');
            reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    /**
     * Entering an observation by hand.
     *
     * Two ways in, because there are two situations. Someone reading the panels
     * off a LinkedIn page types rows into the table; someone holding a payload
     * from a provider or the collector pastes JSON. Both land in the same
     * append-only evidence store, and both immediately re-run the rules —
     * evidence in, verdict out, in that order and never merged.
     */
    async function enterEvidence() {
        const rows = { location: [], function: [], school: [], skill: [] };
        const totalMembers = h('input.input', { type: 'number', min: '0', placeholder: 'e.g. 240' });
        const companyName = h('input.input', { dir: 'auto', value: record.name ?? '' });
        const jsonBox = h('textarea.input', {
            rows: 8, spellcheck: 'false',
            placeholder: '{ "slug": "acme", "totalMembers": 240, "locations": [{ "label": "Egypt", "count": 6 }] }',
        });
        const errorBox = h('div.error');
        let mode = 'form';

        const panelEditor = (key, label, help) => {
            const host = h('div.stack.tight');
            const repaint = () => mount(host,
                rows[key].map((row, i) => h('div.row',
                    h('input.input', {
                        dir: 'auto', value: row.label, placeholder: 'Label, e.g. Egypt',
                        oninput: (e) => { rows[key][i].label = e.target.value; },
                    }),
                    h('input.input', {
                        type: 'number', min: '0', value: row.count, placeholder: 'Count',
                        style: { inlineSize: '7rem' },
                        oninput: (e) => { rows[key][i].count = Number(e.target.value); },
                    }),
                    h('button.btn.sm.ghost', { onclick: () => { rows[key].splice(i, 1); repaint(); } }, '✕'),
                )),
                h('button.btn.sm', { onclick: () => { rows[key].push({ label: '', count: 0 }); repaint(); } }, '+ Row'),
            );
            repaint();
            return h('div.field', h('label', label), h('span.help', help), host);
        };

        const body = h('div.stack');
        const repaintBody = () => mount(body,
            errorBox,
            h('div.note-box',
                h('div.strong', 'Evidence is stored separately from the verdict'),
                h('p.small', 'What you enter here is kept verbatim and never edited. The rules are then re-run against '
                    + 'it, so the verdict can always be traced back to the observation that produced it.'),
            ),
            h('div.row',
                h('button.btn.sm', { class: mode === 'form' ? 'primary' : '', onclick: () => { mode = 'form'; repaintBody(); } }, 'Type the panels'),
                h('button.btn.sm', { class: mode === 'json' ? 'primary' : '', onclick: () => { mode = 'json'; repaintBody(); } }, 'Paste JSON'),
            ),
            mode === 'form'
                ? h('div.stack',
                    h('div.grid', { style: { gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))' } },
                        h('div.field', h('label', 'Company name'), companyName),
                        h('div.field', h('label', 'Headcount (total members)'), totalMembers,
                            h('span.help', 'The figure LinkedIn shows for associated members. Leave empty if unknown — '
                                + 'unknown produces REVIEW, which is correct, rather than a guess.')),
                    ),
                    panelEditor('location', 'Where they are', 'Country and city rows, exactly as listed. A city is a subset of its country and is never added to it.'),
                    panelEditor('function', 'What they do', 'Function rows. These are mutually exclusive — one function per person — so they can be summed.'),
                    panelEditor('school', 'Where they studied', 'Optional. Feeds the education affinity signal.'),
                    panelEditor('skill', 'What they are skilled at', 'Optional. Feeds the HR-skills signal.'),
                )
                : h('div.field',
                    h('label', 'Payload'),
                    jsonBox,
                    h('span.help', 'The raw shape the collector stores: slug, companyName, totalMembers, locations, '
                        + 'functions, schools, skills. Stored exactly as given.'),
                ),
        );
        repaintBody();

        const saved = await modal({
            title: 'Enter evidence by hand',
            size: 'wide',
            body,
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', {
                    onclick: async (event) => {
                        const button = event.currentTarget;
                        button.disabled = true;
                        let payload;
                        if (mode === 'json') {
                            try {
                                payload = JSON.parse(jsonBox.value);
                            } catch (err) {
                                errorBox.textContent = `That is not valid JSON: ${err.message}`;
                                button.disabled = false;
                                return;
                            }
                        } else {
                            const clean = (list) => list.filter((r) => r.label.trim()).map((r) => ({ label: r.label.trim(), count: Number(r.count) || 0 }));
                            payload = {
                                slug: record.linkedin_slug ?? record.id,
                                companyName: companyName.value || record.name,
                                totalMembers: totalMembers.value === '' ? null : Number(totalMembers.value),
                                locations: clean(rows.location),
                                functions: clean(rows.function),
                                // Only sent when the user actually entered rows.
                                // An empty array claims "collected and LinkedIn
                                // listed nothing", which is a different statement
                                // from "not collected" — the evidence card shows
                                // them differently and it must stay true.
                                ...(rows.school.some((r) => r.label.trim()) ? { schools: clean(rows.school) } : {}),
                                ...(rows.skill.some((r) => r.label.trim()) ? { skills: clean(rows.skill) } : {}),
                            };
                        }
                        try {
                            const result = await api.post(`/api/${qualRoute}/${recordId}/evidence`, {
                                provider: 'manual', payload,
                            });
                            close(result);
                        } catch (err) {
                            errorBox.textContent = err.message;
                            button.disabled = false;
                        }
                    },
                }, 'Save and re-run the rules'),
            ],
        });

        if (!saved) return;
        toast(saved.results.map((r) => `${r.rule}: ${r.verdict}`).join(' · '), 'success');
        reload();
    }

    function evidenceTab() {
        const e = extras.evidence;
        return [
            h('div.card',
                h('div.card-header',
                    h('h2', 'Evidence'),
                    h('div.actions', h('span.xs.dim', `${e.history.length} observation(s) on file`)),
                ),
                h('div.card-body', evidenceCard(e.latest, { gaps: e.gaps })),
            ),
            e.history.length > 1 && h('div.card',
                h('div.card-header', h('h2', 'Collection history')),
                h('div.card-body.flush', h('div.table-wrap', h('table.data',
                    h('thead', h('tr', h('th', 'Collected'), h('th', 'Provider'), h('th', 'Panels'), h('th', 'Error'))),
                    h('tbody', e.history.map((s) => h('tr',
                        h('td', date(s.collectedAt, { withTime: true })),
                        h('td', s.provider),
                        h('td', s.hasPanels ? 'yes' : h('span.dim', 'none')),
                        h('td', s.error ? h('span.badge.danger', s.error) : h('span.dim', '—')),
                    ))),
                ))),
            ),
        ];
    }

    /* -------------------------------------------------------- deal size --- */

    /**
     * What this deal is worth: a price, a currency, and whether it repeats.
     *
     * It used to be a tab of line items, each with a pricing model, a quantity,
     * a unit amount, a percentage and a basis — five questions to record one
     * number somebody had already been quoted. A deal is priced the way it is
     * sold, so this is one card on the overview with one dialog behind it, and
     * there is no tab to go and find.
     *
     * Recurring versus one-time is NOT offered as a choice. It follows the
     * service: HCM and Offshoring repeat, Recruitment and OD do not.
     */
    const _dealSizeCard = makeDealSizeCard({ h, money, number, date, statTile, store });
    function dealSizeCard() { return _dealSizeCard(record, extras, editDealSize); }
    const _priceHistoryCard = makePriceHistoryCard({ h, money, date, relative, humanise });
    function priceHistoryCard() { return _priceHistoryCard(extras); }
    const _stageHistoryCard = makeStageHistoryCard({ h, date });
    function stageHistoryCard() { return _stageHistoryCard(extras); }
    async function editDealSize() {
        const { size } = extras.size;
        const perPerson = size.perPerson;
        const draft = {
            price: size.unitPrice ?? '',
            count: size.count ?? '',
            currency: size.currency,
            termMonths: size.termMonths ?? '',
            effectiveFrom: new Date().toISOString().slice(0, 10),
        };
        const recurring = size.billingType === 'recurring';
        const errorBox = h('div.error');

        const total = h('div.note-box');
        const showTotal = () => {
            const unit = Number(draft.price);
            const count = perPerson ? Number(draft.count) : 1;
            if (!Number.isFinite(unit) || draft.price === '') {
                total.textContent = 'Enter a price to see what the deal is worth.';
                return;
            }
            const value = unit * (perPerson ? (Number.isFinite(count) ? count : 0) : 1);
            total.textContent = perPerson
                ? `${number(count)} ${count === 1 ? perPerson.unit : perPerson.unitPlural} × `
                  + `${money(unit, draft.currency)} = ${money(value, draft.currency)}`
                  + (recurring ? ' a month.' : '.')
                : `${money(value, draft.currency)}${recurring ? ' a month.' : '.'}`;
        };
        showTotal();

        const saved = await modal({
            title: 'Deal size',
            body: h('div.stack',
                errorBox,
                h('div.grid', {
                    style: {
                        gridTemplateColumns: perPerson
                            ? 'minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr)'
                            : 'minmax(0, 2fr) minmax(0, 1fr)',
                        gap: 'var(--space-3)',
                    },
                },
                perPerson && h('div.field',
                    h('label', perPerson.countLabel),
                    h('input.input', {
                        type: 'number', step: '1', min: '0', inputmode: 'numeric',
                        value: draft.count,
                        oninput: (e) => { draft.count = e.target.value; showTotal(); },
                    })),
                h('div.field',
                    h('label', perPerson
                        ? `Price per ${perPerson.unit}${recurring ? ', per month' : ''}`
                        : (recurring ? 'Price per month' : 'Price')),
                    h('input.input', {
                        type: 'number', step: '0.01', min: '0', inputmode: 'decimal',
                        value: draft.price,
                        oninput: (e) => { draft.price = e.target.value; showTotal(); },
                    })),
                h('div.field',
                    h('label', 'Currency'),
                    h('div',
                        h('select.input', { onchange: (e) => { draft.currency = e.target.value; showTotal(); } },
                            store.currencies().map((c) => h('option', { value: c, selected: c === draft.currency }, c))),
                        h('span.help', 'The account\u2019s billing currency — the deal, its proposals and its agreements '
                            + 'all bill in this. Changing it here changes it for the account too.')),
                ),
                ),

                total,
                /**
                 * FROM WHEN, because re-quoting must not rewrite last quarter.
                 *
                 * Defaults to today — the commonest case is "this is what it
                 * costs from now" — and a change agreed today to start in
                 * January is the same form with a different date.
                 */
                h('div.field',
                    h('label', 'From'),
                    dateInput({
                        value: draft.effectiveFrom,
                        onChange: (v) => { draft.effectiveFrom = v; },
                    }),
                    h('span.help', 'Earlier periods keep the price they had. Leave as today unless this is '
                        + 'a scheduled or backdated change.')),

                recurring && h('div.field',
                    h('label', 'Term (months)'),
                    h('input.input', {
                        type: 'number', step: '1', min: '1', value: draft.termMonths,
                        oninput: (e) => { draft.termMonths = e.target.value; },
                    }),
                    h('span.help', 'Leave empty and reports assume 12 months, flagged as assumed.')),
                h('div.note-box',
                    `${size.serviceLabel ?? 'This service'} is billed `
                    + `${recurring ? 'monthly, so this price is a monthly one' : 'once, so this price is the whole of it'}. `
                    + 'That follows the service and is not a choice on this form — change the service to change it.'),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', {
                    onclick: async (event) => {
                        const button = event.currentTarget;
                        button.disabled = true;
                        try {
                            if (draft.currency !== size.currency && record.account_id) {
                                await api.patch(`/api/accounts/${record.account_id}`, { billing_currency: draft.currency });
                            }
                            // PUT /api/deals/:id/size responds { deal, size }, where
                            // `size` is setDealPrice's own return value — `pending`
                            // lives there, not at the top level (api/deals.mjs).
                            const { size: result } = await api.put(`/api/deals/${recordId}/size`, draft);
                            close(true);
                            /**
                             * A price change from someone without record.write.all
                             * is a PROPOSAL, not a write — see setDealPrice's own
                             * comment (lib/repo.mjs). The deal keeps its old price
                             * until a manager approves it, so closing this dialog in
                             * silence looked identical to a normal save and read as
                             * "my change vanished" rather than "it's waiting."
                             */
                            toast(
                                result.pending
                                    ? 'Submitted for manager approval — the deal keeps its current price until then.'
                                    : 'Price saved.',
                                result.pending ? 'warning' : 'success',
                            );
                        } catch (err) {
                            errorBox.textContent = err.message;
                            button.disabled = false;
                        }
                    },
                }, 'Save'),
            ],
        });
        if (saved) reload();
    }

    function scoreCard() {
        const s = extras.score;
        if (!s?.live) return null;
        const overall = s.live.overall;
        const components = Object.entries(s.live.components ?? {});
        return h('div.card',
            h('div.card-header',
                h('h2', 'Lead score'),
                h('div.actions',
                    s.stale && h('span.badge.warning', 'Stale — rescore to refresh'),
                ),
            ),
            h('div.card-body',
                h('div.stat-grid',
                    statTile('Score', overall === null || overall === undefined ? '—' : number(overall),
                        s.stale ? 'The stored score differs from what the current inputs produce.'
                            : 'Recomputed from the current inputs.'),
                    statTile('Stored', s.stored?.overall ?? '—',
                        s.stored?.scoredAt ? `Scored ${relative(s.stored.scoredAt)} · model v${s.stored.modelVersion ?? '?'}`
                            : 'Never scored — run Score from the accounts list.'),
                ),
                components.length > 0 && h('div.stack.tight', { style: { marginBlockStart: 'var(--space-3)' } },
                    components.map(([key, c]) => h('div.row.between',
                        h('span.small', humanise(key)),
                        h('span.small.tabular', number(c.score ?? 0)),
                    ))),
            ),
        );
    }

    /* ------------------------------------------------------- proposals --- */

    function versionsTab() {
        const d = extras.detail;
        // Internal Team Proposal: no commercial figure is shown anywhere on
        // this tab — not the divergence warning (it quotes the deal's live
        // price), not a One-time/MRR column showing an honest but still
        // visible $0. See fieldControl-adjacent notes in
        // lib/internal-proposal.mjs for why the record carries these
        // columns as zero at all: the schema needs a number, the UI does
        // not have to show one.
        const internal = d.proposal.type === 'internal_team';
        return [
            !internal && d.divergence && h('div.card',
                h('div.card-body', h('div.note-box.warning',
                    h('div.strong', 'The deal has changed since this proposal was issued'),
                    h('p.small', d.divergence.message),
                    h('p.small', `Issued: ${money(d.divergence.issued.oneTime)} one-time, ${money(d.divergence.issued.mrr)}/mo. `
                        + `Deal now: ${money(d.divergence.current.oneTime)} one-time, ${money(d.divergence.current.mrr)}/mo.`),
                )),
            ),
            h('div.card',
                h('div.card-header',
                    h('h2', 'Versions'),
                    h('div.actions',
                        d.versions.length >= 2 && h('button.btn.sm', {
                            onclick: async () => {
                                const diff = await api.get(`/api/proposals/${recordId}/diff?from=${d.versions[1].version}&to=${d.versions[0].version}`);
                                modal({
                                    title: `v${diff.from} → v${diff.to}`,
                                    body: diff.changes.length
                                        ? h('div.stack.tight', diff.changes.map((c) => h('div.row.between',
                                            h('span.small', c.field),
                                            h('span.small.dim', `${fmt(c.from)} → ${fmt(c.to)}`),
                                        )))
                                        : h('p.dim', 'These versions are identical.'),
                                    footer: (close) => h('button.btn.primary', { onclick: () => close(true) }, 'Close'),
                                });
                            },
                        }, 'Compare last two'),
                        !internal && h('button.btn.sm.primary', {
                            onclick: async () => {
                                try {
                                    await api.post(`/api/proposals/${recordId}/versions`, {});
                                    toast('New draft version created from the deal’s line items.', 'success');
                                    reload();
                                } catch (err) { toast(err.message, 'error'); }
                            },
                        }, '+ New version'),
                    ),
                ),
                h('div.card-body.flush',
                    d.versions.length === 0
                        ? emptyState('No versions yet', 'Create a version to freeze the deal’s line items into a document.')
                        : h('div.table-wrap', h('table.data',
                            h('thead', h('tr',
                                h('th', 'Version'), h('th', 'Status'),
                                !internal && h('th.num', 'One-time'),
                                !internal && h('th.num', 'MRR'),
                                h('th', 'Issued'), h('th', ''),
                            )),
                            h('tbody', d.versions.map((v) => h('tr',
                                h('td', `v${v.version}`),
                                h('td', h('span.badge', { class: v.status === 'issued' ? 'success' : '' }, v.status)),
                                !internal && h('td.num', money(v.total_one_time, d.proposal.currency)),
                                !internal && h('td.num', money(v.total_mrr, d.proposal.currency)),
                                h('td', v.issued_at ? date(v.issued_at) : h('span.dim', '—')),
                                h('td.row',
                                    h('a.btn.sm.ghost', {
                                        href: `/api/proposals/${recordId}/versions/${v.version}/render`,
                                        target: '_blank', rel: 'noreferrer',
                                    }, 'Preview'),
                                    v.status === 'draft' && h('button.btn.sm', {
                                        onclick: async () => {
                                            const ok = await confirm({
                                                title: `Issue v${v.version}?`,
                                                message: 'Once issued, this version is immutable. A change after this makes a new version — '
                                                    + 'the customer will be holding this one.',
                                                confirmLabel: 'Issue',
                                            });
                                            if (!ok) return;
                                            await api.post(`/api/proposals/${recordId}/versions/${v.version}/issue`, {});
                                            toast('Issued.', 'success');
                                            reload();
                                        },
                                    }, 'Issue'),
                                    // Same rule as the header action: an Internal Team Proposal is
                                    // never "sent" to anyone outside the company.
                                    v.status === 'issued' && !v.sent_at && record.type !== 'internal_team' && h('button.btn.sm', {
                                        onclick: async () => {
                                            await api.post(`/api/proposals/${recordId}/versions/${v.version}/sent`, {});
                                            toast('Marked as sent and logged on the timeline.', 'success');
                                            reload();
                                        },
                                    }, 'Mark sent'),
                                    store.can('record.delete') && h('button.btn.sm.danger', {
                                        onclick: async () => {
                                            const ok = await confirm({
                                                title: `Delete v${v.version}?`,
                                                message: 'This will permanently delete this proposal version.',
                                                confirmLabel: 'Delete',
                                                danger: true,
                                            });
                                            if (!ok) return;
                                            await api.delete(`/api/proposals/${recordId}/versions/${v.version}`);
                                            toast('Proposal version deleted.', 'success');
                                            reload();
                                        },
                                    }, 'Delete'),
                                ),
                            ))),
                        )),
                ),
            ),
        ];
    }

    const fmt = (v) => (typeof v === 'number' ? money(v) : v === null || v === undefined ? '—' : String(v).slice(0, 60));

    /* -------------------------------------------------------- timeline --- */

    function timelineTab() {
        const host = h('div.card-body.flush', skeletonRows(3));
        api.get(`/api/${routeName}/${recordId}/timeline?limit=200`).then((data2) => {
            /**
             * Editing an activity is editing an ACTIVITY, not editing its note.
             *
             * This was a single-line text prompt that wrote `body` and nothing
             * else, so the type, the subject, the direction and — worst — when
             * it actually happened could be created and never corrected. A call
             * logged against the wrong day stayed on the wrong day. It is the
             * same registry-driven dialog the rest of the CRM edits with now.
             */
            mount(host, timelineList(data2.entries, {
                onEdit: async (entry) => {
                    const saved = await editEntity('activity', {
                        record: await api.get(`/api/activities/${entry.id}`).then((r) => r.record).catch(() => entry),
                    });
                    if (saved) paint();
                },
                onDelete: async (entry) => {
                    if (await deleteEntity('activity', entry, { name: entry.subject ?? entry.body })) paint();
                },
            }));
        }).catch((err) => mount(host, h('div.note-box.danger', err.message)));

        return h('div.card',
            h('div.card-header',
                h('h2', 'Timeline'),
                h('div.actions',
                    h('span.xs.dim', 'Activities plus the system events this workspace projects'),
                    h('button.btn.sm.primary', { onclick: () => logActivity() }, '＋ Log'),
                ),
            ),
            host,
        );
    }

    /* ------------------------------------------------- tasks/notes/docs --- */

    function tasksTab() {
        const tasks = data.related.tasks ?? [];
        return h('div.card',
            h('div.card-header',
                h('h2', 'Tasks'),
                h('div.actions', h('button.btn.sm.primary', { onclick: () => addTask() }, '+ Task')),
            ),
            h('div.card-body.flush',
                tasks.length === 0
                    ? emptyState('No tasks', 'Commitments against this record show up here.')
                    : h('div', tasks.map((t) => h('div.timeline-item',
                        h('div.timeline-dot', { class: t.status === 'done' ? 'success' : '' },
                            h('input', {
                                type: 'checkbox', checked: t.status === 'done',
                                'aria-label': `Mark ${t.title} done`,
                                onchange: async (e) => {
                                    await api.patch(`/api/tasks/${t.id}`, {
                                        status: e.target.checked ? 'done' : 'open',
                                        completed_at: e.target.checked ? new Date().toISOString() : null,
                                    });
                                    reload();
                                },
                            }),
                        ),
                        h('div.timeline-body',
                            h('div.timeline-head',
                                h('a.timeline-subject', { href: `/tasks/${t.id}`, style: t.status === 'done' ? { textDecoration: 'line-through', opacity: 0.6 } : {} }, t.title),
                                h('span.timeline-meta',
                                    t.assignee_name ?? 'Unassigned',
                                    t.due_at && h('span', { title: date(t.due_at, { withTime: true }) },
                                        ` · due ${relative(t.due_at)}${clock(t.due_at) ? ` at ${clock(t.due_at)}` : ''}`),
                                    h('span.badge', { class: t.priority === 'A' ? 'danger' : t.priority === 'B' ? 'warning' : '' }, t.priority),
                                ),
                                h('div.spacer'),
                                entityActions('task', t, { onDone: () => reload(), name: t.title }),
                            ),
                            t.description && h('div.timeline-text', t.description),
                        ),
                    ))),
            ),
        );
    }

    function notesTab() {
        const notes = data.related.notes ?? [];
        return h('div.card',
            h('div.card-header',
                h('h2', 'Notes'),
                h('div.actions', h('button.btn.sm.primary', { onclick: () => addNote() }, '+ Note')),
            ),
            h('div.card-body.flush',
                notes.length === 0
                    ? emptyState('No notes', 'Free text about this record, with the author and time kept.')
                    : h('div', notes.map((n) => h('div.timeline-item',
                        h('div.timeline-dot', avatar(n.author_name ?? '?')),
                        h('div.timeline-body',
                            h('div.timeline-head',
                                h('span.timeline-subject', n.author_name ?? 'Unknown'),
                                h('span.timeline-meta', { title: date(n.created_at, { withTime: true }) }, relative(n.created_at)),
                                h('div.spacer'),
                                entityActions('note', n, { onDone: () => reload(), name: n.body }),
                            ),
                            h('div.timeline-text', { dir: 'auto' }, n.body),
                        ),
                    ))),
            ),
        );
    }

    /**
     * Generated proposals and agreements.
     *
     * Shown above the uploaded files rather than mixed in with them: a document
     * the CRM produced from a template has a version, a set of inputs and an
     * open/download history, and a file somebody dragged in has none of that.
     * Flattening the two loses exactly the information anyone came here for.
     */
    /**
     * Putting a file the CRM did not write onto the version history.
     *
     * A negotiation does not stay inside a template: a clause is redrafted in
     * Word, legal sends a marked-up copy back, a client returns a signed scan.
     * Before this, the only home for any of that was a loose attachment with no
     * version and no connection to the record whose number is on its front page
     * — so the document everybody was working from was the one the CRM did not
     * know about.
     *
     * The two modes are two different situations, and the dialog says which is
     * which rather than offering a toggle labelled "replace".
     */
    async function uploadDocumentVersion({ category = null, preselectType = null } = {}) {
        const accountId = objectKey === 'account' ? recordId : record.account_id;
        if (!accountId) return toast('This record has no account, and every document names the client.', 'error');

        const types = Object.entries(store.state.meta?.documentTypes ?? {})
            .filter(([, t]) => !category || t.category === category);
        const known = types.length
            ? types
            : [[preselectType ?? record.document_type, { label: 'This document' }]].filter(([k]) => k);
        if (!known.length) {
            return toast('No document type is configured for this account.', 'error');
        }

        const draft = {
            type: preselectType ?? record.document_type ?? known[0][0],
            mode: 'new_version',
            note: '',
            file: null,
        };
        const errorBox = h('div.error');
        const fileName = h('span.small.dim', 'No file chosen');

        const picker = h('input', {
            type: 'file',
            accept: '.docx,.pdf',
            onchange: (e) => {
                draft.file = e.target.files?.[0] ?? null;
                fileName.textContent = draft.file
                    ? `${draft.file.name} · ${bytes(draft.file.size)}`
                    : 'No file chosen';
            },
        });

        const modeHelp = h('span.help');
        const describeMode = () => {
            modeHelp.textContent = draft.mode === 'replace_current'
                ? 'The version number does not move. For a correction nobody was sent — a typo, a missing '
                  + 'annex. The file it replaces is kept and stays in the history.'
                : 'The current version stays exactly as it is, and this becomes the next one. Use this '
                  + 'whenever the client has been sent something different.';
        };
        describeMode();

        const done = await modal({
            title: 'Upload a version',
            size: 'wide',
            body: h('div.stack',
                errorBox,
                h('div.field', h('label', 'Which document is this a version of?'),
                    h('select.input', { onchange: (e) => { draft.type = e.target.value; } },
                        known.map(([key, t]) => h('option', { value: key, selected: key === draft.type }, t.label ?? key)))),

                h('div.field', h('label', 'File'),
                    h('div.row', { style: { gap: 'var(--space-2)' } },
                        h('button.btn', { onclick: () => picker.click() }, 'Choose a file'),
                        fileName),
                    /**
                     * IN the dialog, visually hidden — not merely unattached.
                     *
                     * An input that is never added to the document still opens
                     * a file dialog when clicked, which is why this pattern
                     * survives; it is also unreachable by anything that walks
                     * the DOM, which means no test and no assistive technology
                     * can see it. `.visually-hidden` keeps it out of the layout
                     * and in the tree.
                     */
                    h('div.visually-hidden', picker),
                    h('span.help', 'A .docx or a .pdf — the two a client is ever sent.')),

                h('div.field', h('label', 'What is this?'),
                    h('select.input', { onchange: (e) => { draft.mode = e.target.value; describeMode(); } },
                        h('option', { value: 'new_version' }, 'A new version'),
                        h('option', { value: 'replace_current' }, 'A correction to the current version')),
                    modeHelp),

                h('div.field', h('label', 'What changed?'),
                    h('input.input', {
                        dir: 'auto',
                        placeholder: 'Optional — kept on the version history',
                        oninput: (e) => { draft.note = e.target.value; },
                    })),

                h('div.note-box', 'Uploading sends the proposal or agreement back for approval, because the '
                    + 'content changed and the last approval was of different content. A signed agreement '
                    + 'cannot be corrected in place — upload it as a new version.'),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', {
                    onclick: async (event) => {
                        const button = event.currentTarget;
                        if (!draft.file) { errorBox.textContent = 'Choose a file first.'; return; }
                        button.disabled = true;
                        button.textContent = 'Uploading…';
                        try {
                            const query = new URLSearchParams({
                                type: draft.type,
                                mode: draft.mode,
                                name: draft.file.name,
                                ...(objectKey === 'deal' ? { deal: recordId } : {}),
                                ...(draft.note ? { note: draft.note } : {}),
                            });
                            const result = await api.postBinary(
                                `/api/accounts/${accountId}/document-versions?${query}`,
                                draft.file,
                            );
                            close(result);
                        } catch (err) {
                            errorBox.textContent = err.message;
                            button.disabled = false;
                            button.textContent = 'Upload';
                        }
                    },
                }, 'Upload'),
            ],
        });

        if (done) {
            toast(done.mode === 'replace_current'
                ? `v${done.version} now points at the uploaded file.`
                : `Uploaded as v${done.version}.`, 'success');
            reload();
        }
    }

    function generatedDocumentsCard(category = null) {
        const own = generatedRecord();
        const rows = generatedOf(category);
        const noun = category === 'agreement' ? 'agreement' : category === 'proposal' ? 'proposal' : 'document';
        const title = own ? 'Document'
            : category === 'agreement' ? 'Agreements'
                : category === 'proposal' ? 'Proposals' : 'Proposals & agreements';
        /**
         * Neither action is safe on an Internal Team Proposal.
         *
         * Both `uploadDocumentVersion` and `generateDocument` go through the
         * ordinary wizard, which knows nothing about redaction — a manually
         * generated "new version" would carry the real price, and an upload
         * could be any file at all. `ensureInternalTeamProposal`
         * (lib/internal-proposal.mjs) is the only writer this record type is
         * meant to have.
         */
        const isInternalTeamProposal = objectKey === 'proposal' && record.type === 'internal_team';

        return h('div.card',
            h('div.card-header',
                h('h2', title),
                h('div.actions',
                    !own && rows.length > 0 && h('button.btn.sm', {
                        onclick: () => downloadAll(category),
                    }, `⭳ Download all (${rows.length} files)`),
                    /**
                     * Two ways a version comes into being, offered together.
                     *
                     * The CRM writes one from a template; a person writes one in
                     * Word and brings it back. Both are versions of the same
                     * document and belong on the same history, so both are on
                     * the same card rather than one being a first-class action
                     * and the other a loose attachment somewhere else.
                     */
                    !isInternalTeamProposal && store.can('proposal.issue') && h('button.btn.sm', {
                        onclick: () => uploadDocumentVersion({
                            category, preselectType: own ? record.document_type : null,
                        }),
                    }, '⭱ Upload a version'),
                    !isInternalTeamProposal && store.can('proposal.issue') && h('button.btn.sm.primary', {
                        onclick: () => generateDocument({
                            category, preselectType: own ? record.document_type : null,
                        }),
                    }, own ? '+ New version' : `+ Generate ${noun}`)),
            ),
            h('div.card-body.flush',
                rows.length === 0
                    ? emptyState(`No ${noun}s generated yet`,
                        `Generate a ${noun} from this ${objectKey}. Every generation is a new version — `
                        + 'nothing is ever overwritten.')
                    : h('div.table-wrap', h('table.data',
                        h('thead', h('tr',
                            h('th', 'Document'), h('th', 'Version'), h('th', 'Scope'), h('th', 'Generated'),
                            h('th.num', 'Opened'), h('th.num', 'Downloaded'), h('th', ''),
                        )),
                        h('tbody', rows.map((row) => h('tr',
                            h('td',
                                h('div', { dir: 'auto' }, row.document_name ?? row.label),
                                h('div.xs.dim', row.label),
                            ),
                            h('td',
                                h('span.badge', { class: row.isCurrent ? 'accent' : '' }, `v${row.version}`),
                                row.isCurrent && h('span.xs.dim', { style: { marginInlineStart: 'var(--space-1)' } }, 'current'),
                            ),
                            // What this version actually covered. A regenerated
                            // proposal usually differs by exactly this.
                            h('td.xs.dim', row.services?.length
                                ? `${row.services.length} scope${row.services.length === 1 ? '' : 's'}`
                                : '—'),
                            h('td', { title: date(row.created_at, { withTime: true }) },
                                h('div', relative(row.created_at)),
                                h('div.xs.dim', row.generated_by_name ?? '—'),
                            ),
                            h('td.num', row.activity?.opened
                                ? h('span', { title: `Last opened ${date(row.activity.lastOpenedAt, { withTime: true })}` },
                                    String(row.activity.opened))
                                : h('span.dim', '0')),
                            h('td.num', row.activity?.downloaded
                                ? h('span', { title: `Last downloaded ${date(row.activity.lastDownloadedAt, { withTime: true })}` },
                                    String(row.activity.downloaded))
                                : h('span.dim', '0')),
                            h('td.num', { style: { whiteSpace: 'nowrap' } },
                                row.document_id && h('button.btn.sm.ghost', {
                                    onclick: () => downloadDocument(row.document_id),
                                }, icon('download'), 'Download'),
                                store.can('proposal.issue') && h('button.btn.sm.ghost', {
                                    onclick: () => generateDocument({ preselectType: row.document_type }),
                                }, 'New version'),
                                store.can('record.delete') && h('button.btn.sm.ghost.danger', {
                                    onclick: async () => {
                                        if (await deleteEntity('document', { ...row, id: row.document_id }, { name: row.document_name ?? row.label })) {
                                            reload();
                                        }
                                    },
                                }, 'Delete'),
                            ),
                        ))),
                    )),
                rows.length > 0 && h('p.xs.dim', { style: { padding: 'var(--space-3)' } },
                    'Every version stays. Opens and downloads are counted server-side when the file is '
                    + 'actually fetched, so the numbers are what happened rather than what a browser reported.'),
            ),
        );
    }

    /**
     * Downloads through a hidden link rather than `window.open`.
     *
     * The response carries `Content-Disposition: attachment`, so the browser
     * saves it and stays where it is. `window.open` would flash a tab that
     * closes itself, and pop-up blockers treat a repeated one as an attack.
     */
    function saveAs(url) {
        const link = h('a', { href: url, download: '', style: { display: 'none' } });
        document.body.appendChild(link);
        link.click();
        link.remove();
    }

    /** One generated document. The signed link is what counts the download. */
    async function downloadDocument(documentId) {
        try {
            const { url } = await api.get(`/api/documents/${documentId}/link`);
            saveAs(url);
            // The counters moved server-side; refresh so the table agrees.
            await reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    /**
     * Every file on the account, saved as the .docx files they already are.
     *
     * Deliberately not a ZIP: these are finished documents, and an archive is
     * one more step between somebody and a contract they need to read. Each
     * file goes through the same signed-link path as a single download, so the
     * authorisation and the counting are identical — there is no second way to
     * get a file out of this system.
     *
     * Spaced apart because a browser handed a dozen simultaneous downloads
     * treats it as an attack and silently drops most of them. Chrome asks once
     * per site whether to allow multiple files, then remembers.
     */
    async function downloadAll(category = null) {
        const account = objectKey === 'account' ? recordId : record.account_id;
        if (!account) return toast('This record is not linked to an account.', 'error');

        let list;
        try {
            list = await api.get(`/api/accounts/${account}/documents/links${category ? `?category=${category}` : ''}`);
        } catch (err) {
            return toast(err.message, 'error');
        }
        if (!list.documents.length) return toast('There is nothing to download here yet.', 'info');

        toast(`Saving ${list.documents.length} file${list.documents.length === 1 ? '' : 's'}…`, 'info');
        for (const [index, doc] of list.documents.entries()) {
            saveAs(doc.url);
            if (index < list.documents.length - 1) {
                await new Promise((resolve) => { setTimeout(resolve, 400); });
            }
        }

        // Named, not just counted: "3 of 4 saved" sends someone hunting for
        // which one, and the answer is already here.
        if (list.missing.length) {
            toast(`Could not download ${list.missing.join(', ')} — missing from storage.`, 'error');
        }
        await reload();
        return undefined;
    }

    /**
     * The generate workflow, which lives in ./generate.js.
     *
     * It is shared with the Proposals and Agreements lists in the sidebar, which
     * is the whole reason it is not defined here any more: while it was inside
     * this closure, "+ New proposal" could not reach it and opened a blank form
     * that produced a record with no document and no company behind it.
     *
     * This page's job is only to say what it already knows — the account, the
     * deal, the document type when asking for another version — and to decide
     * where to land afterwards.
     */
    async function generateDocument({ preselectType = null, category = null } = {}) {
        const fromDeal = objectKey === 'deal';
        const accountId = objectKey === 'account' ? recordId : record.account_id;

        if (!accountId) {
            return toast('This deal is not linked to an account, and every document names the client.', 'error');
        }

        const done = await generateDocumentDialog({
            accountId,
            dealId: fromDeal ? recordId : null,
            preselectType,
            category,
            title: titleOf(objectKey, record),
        });

        if (!done) return undefined;
        toast(
            `${done.document.name} generated (v${done.generation.version})`
            + `${done.record?.number ? ` — ${done.record.number}` : ''}.`,
            'success',
        );
        // A new version is a new document and therefore a new record, so this
        // page is now looking at the superseded one. Go to the new one rather
        // than repainting the old with a success message over it.
        if (generatedRecord() && done.record) {
            return navigate(`/${done.record.object}s/${done.record.id}`);
        }
        // Land on the list the new document is in, so it is visible rather than
        // merely reported. The deal page has one combined list and needs no move.
        if (objectKey === 'account') {
            activeTab = done.record?.object === 'agreement' ? 'agreements' : 'proposals';
        }
        await reload();
        return undefined;
    }

    function documentsTab() {
        const docs = data.related.documents ?? [];
        const uploaded = h('div.card',
            h('div.card-header',
                h('h2', 'Documents'),
                h('div.actions',
                    docs.length > 0 && (objectKey === 'account' || record.account_id) && h('button.btn.sm', {
                        onclick: () => downloadAll(),
                    }, `⭳ Download all (${docs.length} files)`),
                    h('button.btn.sm.primary', { onclick: () => uploadDocument() }, '⭱ Upload')),
            ),
            h('div.card-body.flush',
                docs.length === 0
                    ? emptyState('No documents', 'Files live in object storage and are reached through short-lived signed links, '
                        + 'never as database blobs.')
                    : h('div.table-wrap', h('table.data',
                        h('thead', h('tr', h('th', 'Name'), h('th', 'Kind'), h('th.num', 'Size'), h('th', 'Uploaded'), h('th', ''))),
                        h('tbody', docs.map((d) => h('tr',
                            h('td', { dir: 'auto' }, d.name),
                            h('td', h('span.badge', d.kind)),
                            h('td.num', bytes(d.size_bytes)),
                            h('td', { title: date(d.created_at, { withTime: true }) }, relative(d.created_at)),
                            h('td',
                                h('button.btn.sm.ghost', {
                                    onclick: () => downloadDocument(d.id),
                                }, icon('download'), 'Download'),
                                store.can('record.delete') && h('button.btn.sm.ghost.danger', {
                                    onclick: async () => {
                                        if (await deleteEntity('document', d, { name: d.name })) {
                                            reload();
                                        }
                                    },
                                }, 'Delete'),
                            ),
                        ))),
                    )),
            ),
        );

        // Generated documents lead on a deal, because that is what someone
        // opens this tab for; uploaded files follow.
        return objectKey === 'deal'
            ? h('div.stack', generatedDocumentsCard(), uploaded)
            : uploaded;
    }

    /**
     * A child object listed inside its parent.
     *
     * The columns come from the child's own `relatedColumns`, because what is
     * worth showing here is not what is worth showing on the full list: the
     * parent is already the heading, so any column pointing back at it repeats
     * the page title once per row. Objects that declare nothing fall back to
     * their list defaults with the parent reference removed, which is the same
     * rule applied generically rather than a second, quieter opinion.
     */
    /**
     * Fetches the next page of a related list and appends it in place.
     *
     * Goes through the record's own related endpoint rather than rebuilding the
     * query, so page two is scoped and sorted exactly as page one was. A client
     * that reconstructed it would eventually sort differently and show one row
     * twice while hiding another — a bug that reads as bad data, not a bug.
     */
    async function loadMoreRelated(childRoute, button) {
        const loaded = data.related[childRoute] ?? [];
        const spec = relatedPaging[childRoute] ?? { page: 1 };
        button.disabled = true;
        button.textContent = 'Loading…';
        try {
            const next = await api.get(`/api/${routeName}/${recordId}/related/${childRoute}?page=${spec.page + 1}`);
            data.related[childRoute] = loaded.concat(next.records);
            data.counts[childRoute] = next.total;
            relatedPaging[childRoute] = { page: next.page };
            paint();
        } catch (err) {
            toast(err.message, 'error');
            button.disabled = false;
            button.textContent = 'Load more';
        }
    }

    function relatedTable(childKey, childRoute, records) {
        const childDef = store.object(childKey);
        const parentRef = `${objectKey}_id`;
        const columns = (childDef.relatedColumns
            ?? store.fields(childKey)
                .filter((f) => f.listDefault)
                .map((f) => f.key)
                .slice(0, 6)
        ).filter((key) => key !== parentRef);

        /**
         * "200 of 1,400", and a way to see the rest.
         *
         * The count comes from the server, which knows it exactly; `records`
         * only knows how many arrived. Saying "200" alone was the bug — it
         * presented a truncation as the whole set, and nothing about the page
         * suggested otherwise.
         */
        const total = data.counts?.[childRoute] ?? records.length;
        const more = Math.max(0, total - records.length);

        return h('div.card',
            h('div.card-header',
                h('h2', childDef.plural),
                more > 0
                    ? h('span.badge.warning', `${number(records.length)} of ${number(total)}`)
                    : (total > 0 ? h('span.xs.dim', number(total)) : null),
                h('div.actions',
                    childKey === 'contact' && h('button.btn.sm.primary', { onclick: () => createContact() }, '+ Contact'),
                    childKey === 'deal' && h('button.btn.sm.primary', { onclick: () => createDeal() }, '+ Deal'),
                    childKey === 'proposal' && objectKey === 'deal' && h('button.btn.sm.primary', { onclick: () => createProposal() }, '+ Proposal'),
                ),
            ),
            h('div.card-body.flush',
                records.length === 0
                    ? emptyState(`No ${childDef.plural.toLowerCase()}`, 'Nothing linked yet.')
                    : h('div.table-wrap', h('table.data',
                        h('thead', h('tr', columns.map((key) => h('th', store.field(childKey, key)?.label ?? key)))),
                        h('tbody', records.map((r) => h('tr',
                            columns.map((key, i) => {
                                const col = store.field(childKey, key);
                                return h('td', i === 0
                                    ? h('a.cell-link', { href: `/${childRoute}/${r.id}` }, cellContent(childKey, col, r))
                                    : cellContent(childKey, col, r));
                            }),
                        ))),
                    )),
            ),
            more > 0
                ? h('div.card-footer',
                    h('button.btn.sm', {
                        onclick: (e) => loadMoreRelated(childRoute, e.currentTarget),
                    }, 'Load more'),
                    h('span.xs.dim', ` ${number(more)} more`))
                : null,
        );
    }

    /* -------------------------------------------------------- campaigns --- */

    /**
     * The membership list.
     *
     * Status is editable inline because it is the field that actually moves —
     * "targeted" becomes "responded" one person at a time, and making that a
     * modal is how a funnel stops being maintained and starts being fiction.
     */
    function membersTab() {
        const { members, total } = extras.memberList;
        const statuses = extras.performance.statuses;
        const more = Math.max(0, total - members.length);
        const p = extras.performance ?? {};
        const outreachPanel = campaignOutreachPanel(record, { onChanged: reload });

        // Three cards: outreach linkage, outreach rollup, members.
        const outreachSummary = h('div.card',
            h('div.card-header', h('h3', 'Outreach'),
                h('div.actions', h('span.xs.dim',
                    `${number(p.outreach_sent ?? 0)} sent · ${number(p.outreach_replied ?? 0)} replied`
                    + ` · ${number(p.outreach_bounced ?? 0)} bounced`))),
            h('div.card-body', h('p.xs.dim',
                'Per-member outreach (sent, replies, step) is on each contact — this rollup is the campaign-level sum.')),
        );

        const membersCard = h('div.card',
            h('div.card-header',
                h('h2', 'Members'),
                more > 0
                    ? h('span.badge.warning', `${number(members.length)} of ${number(total)}`)
                    : (total > 0 ? h('span.xs.dim', `${number(total)} current`) : null),
                h('div.actions',
                    h('button.btn.sm', { onclick: () => addMembersFromList('contact') }, '+ Contacts'),
                    h('button.btn.sm', { onclick: () => addMembersFromList('account') }, '+ Accounts'),
                ),
            ),
            h('div.card-body.flush',
                members.length === 0
                    ? emptyState('Nobody in this campaign yet',
                        'Add people from the Contacts list — filter to the ones you want, select them, and use '
                        + '"Add to campaign". Accounts can be added the same way, optionally pulling in their contacts.')
                    : h('div.table-wrap', h('table.data',
                        h('thead', h('tr',
                            h('th', 'Member'), h('th', 'Type'), h('th', 'Account'),
                            h('th', 'Status'), h('th', 'Added'), h('th', ''),
                        )),
                        h('tbody', members.map((m) => h('tr',
                            h('td', h('a.cell-link', {
                                href: `/${m.member_type === 'contact' ? 'contacts' : 'accounts'}/${m.member_id}`,
                            }, m.member_name)),
                            h('td', h('span.badge', m.member_type)),
                            h('td', m.account_id && m.member_type === 'contact'
                                ? h('a', { href: `/accounts/${m.account_id}` }, m.account_name ?? '—')
                                : h('span.dim', '—')),
                            h('td', h('select.input', {
                                style: { inlineSize: 'auto' },
                                onchange: async (e) => {
                                    await api.patch(`/api/campaigns/${recordId}/members`, {
                                        memberType: m.member_type, ids: [m.member_id], status: e.target.value,
                                    });
                                    toast('Status updated.', 'success');
                                    reload();
                                },
                            }, statuses.map((s) => h('option', { value: s, selected: s === m.status }, humanise(s))))),
                            h('td', { title: date(m.added_at, { withTime: true }) }, relative(m.added_at)),
                            h('td', h('button.btn.sm.ghost', {
                                title: 'Remove from the current list. The history stays.',
                                onclick: async () => {
                                    await api.delete(`/api/campaigns/${recordId}/members`, {
                                        memberType: m.member_type, ids: [m.member_id],
                                    });
                                    toast('Removed. Their history in this campaign is kept.', 'success');
                                    reload();
                                },
                            }, 'Remove')),
                        ))),
                    )),
            ),
            more > 0
                ? h('div.card-footer',
                    h('button.btn.sm', {
                        onclick: async (e) => {
                            const btn = e.currentTarget;
                            btn.disabled = true;
                            btn.textContent = 'Loading…';
                            try {
                                const nextPage = (extras.memberListPage ?? 1) + 1;
                                const next = await api.get(`/api/campaigns/${recordId}/members?limit=100&page=${nextPage}`);
                                extras.memberList = {
                                    ...next,
                                    members: extras.memberList.members.concat(next.members),
                                    total: next.total,
                                };
                                extras.memberListPage = nextPage;
                                paint();
                            } catch (err) {
                                toast(err.message, 'error');
                                btn.disabled = false;
                                btn.textContent = 'Load more';
                            }
                        },
                    }, 'Load more'),
                    h('span.xs.dim', ` ${number(more)} more`))
                : null,
        );

        return [outreachPanel, outreachSummary, membersCard];
    }

    /**
     * Campaign performance.
     *
     * Won one-time and won MRR are two figures, never one. There is no single
     * "ROI" number here on purpose — producing one means dividing a budget by a
     * blend of a placement fee and a monthly retainer, which is the same
     * addition this codebase refuses to make on a deal.
     */
    function performanceTab() {
        const p = extras.performance;
        const currency = p.campaign.currency ?? store.baseCurrency();
        const maxCount = Math.max(1, ...p.funnel.map((f) => f.count));

        return [
            h('div.card',
                h('div.card-header', h('h2', 'Result')),
                h('div.card-body',
                    h('div.totals-grid',
                        h('div.total-cell', statTile('Members', number(p.member_count), `${p.member_contacts} contacts · ${p.member_accounts} accounts`)),
                        h('div.total-cell', statTile('Deals attributed', number(p.deal_count), `${p.won_count} won · ${p.open_count} open`)),
                        h('div.total-cell', statTile('Won one-time', money(p.influenced_one_time, currency), 'Placement and fixed fees')),
                        h('div.total-cell', statTile('Won recurring', `${money(p.influenced_mrr, currency)}/mo`, 'Seats and headcount')),
                    ),
                    h('div.totals-grid', { style: { marginBlockStart: 'var(--space-3)' } },
                        h('div.total-cell', statTile('Open one-time', money(p.open_one_time, currency), 'Still in the pipeline')),
                        h('div.total-cell', statTile('Open recurring', `${money(p.open_mrr, currency)}/mo`, 'Still in the pipeline')),
                        h('div.total-cell', statTile('Budget', p.budget ? money(p.budget, currency) : '—',
                            p.costPerMember ? `${money(p.costPerMember, currency)} per member` : 'Set a budget to see cost per member')),
                        h('div.total-cell', statTile('Cost per won deal',
                            p.costPerWonDeal ? money(p.costPerWonDeal, currency) : '—',
                            p.won_count ? `${p.won_count} won` : 'No won deals yet')),
                    ),
                    h('div.note-box', { style: { marginBlockStart: 'var(--space-3)' } }, p.note),
                ),
            ),

            h('div.card',
                h('div.card-header', h('h2', 'Funnel')),
                h('div.card-body',
                    h('div.stack.tight', p.funnel.map((f) => h('div.row',
                        h('span.small', { style: { inlineSize: '7rem' } }, humanise(f.status)),
                        h('div', {
                            style: {
                                blockSize: '1.1rem', background: 'var(--color-accent)', borderRadius: 'var(--radius-sm)',
                                inlineSize: `${Math.max(2, (f.count / maxCount) * 100)}%`, opacity: f.count ? 1 : 0.15,
                            },
                        }),
                        h('span.small.tabular', number(f.count)),
                    ))),
                    // Every bucket is rendered, including the empty ones — the
                    // same reason a verdict chart always shows REVIEW.
                    h('p.xs.dim', { style: { marginBlockStart: 'var(--space-2)' } },
                        'Every stage is shown, including the empty ones. A funnel that hides its zeros looks healthier than it is.'),
                ),
            ),

            h('div.card',
                h('div.card-header',
                    h('h2', 'Attributed deals'),
                    h('div.actions', h('span.xs.dim', `${number(p.dealTotal)} total`)),
                ),
                h('div.card-body.flush',
                    p.deals.length === 0
                        ? emptyState('No deals attributed yet',
                            'Set the Campaign field on a deal to attribute it here. Attribution is explicit — nothing is '
                            + 'inferred from timing, because a guess that looks like a measurement is worse than no measurement.')
                        : h('div.table-wrap', h('table.data',
                            h('thead', h('tr', h('th', 'Deal'), h('th', 'Account'), h('th', 'Stage'), h('th', 'Status'),
                                h('th.num', 'One-time'), h('th.num', 'Monthly'))),
                            h('tbody', p.deals.map((d) => h('tr',
                                h('td', h('a.cell-link', { href: `/deals/${d.id}` }, d.name)),
                                h('td', d.account_id ? h('a', { href: `/accounts/${d.account_id}` }, d.account_name) : '—'),
                                h('td', d.stage_label ?? '—'),
                                h('td', h('span.badge', { class: { won: 'success', lost: 'danger' }[d.status] ?? '' }, humanise(d.status))),
                                h('td.num', money(d.value_one_time, d.currency)),
                                h('td.num', d.value_mrr ? `${money(d.value_mrr, d.currency)}/mo` : h('span.dim', '—')),
                            ))),
                        )),
                ),
            ),
        ];
    }

    /**
     * Adds members to this campaign by filtering the source object.
     *
     * A search box rather than a list of everything: the useful selections are
     * "everyone at qualified accounts" and "these six people", and neither is
     * served by a dropdown of two thousand names.
     */
    async function addMembersFromList(memberType) {
        const route = memberType === 'contact' ? 'contacts' : 'accounts';
        const results = h('div.stack.tight');
        const chosen = new Map();
        const chips = h('div.row');
        const includeContacts = h('input', { type: 'checkbox', checked: true });

        const paintChips = () => mount(chips, [...chosen.entries()].map(([id, label]) => h('span.badge.accent',
            label, ' ',
            h('button.btn.sm.ghost', { style: { padding: 0 }, onclick: () => { chosen.delete(id); paintChips(); } }, '✕'),
        )));

        const search = debounce(async (query) => {
            if (query.length < 2) return mount(results, h('p.xs.dim', 'Type at least two characters.'));
            const data = await api.get(`/api/search?q=${encodeURIComponent(query)}&object=${memberType}&limit=10`);
            const found = data.groups[0]?.records ?? [];
            return mount(results, found.length
                ? found.map((r) => h('button.btn.ghost.block', {
                    style: { justifyContent: 'flex-start' },
                    onclick: () => { chosen.set(r.id, r.title); paintChips(); },
                }, r.title, r.subtitle && h('span.xs.dim', ` — ${r.subtitle}`)))
                : h('p.xs.dim', 'Nothing matched.'));
        }, 220);

        const confirmed = await modal({
            title: `Add ${memberType === 'contact' ? 'contacts' : 'accounts'} to ${record.name}`,
            size: 'wide',
            body: h('div.stack',
                h('div.field',
                    h('label', 'Search'),
                    h('input.input', { type: 'search', oninput: (e) => search(e.target.value.trim()) }),
                    h('span.help', `To add many at once, filter the ${route} list, select the rows, and use "Add to campaign" there.`),
                ),
                results,
                chips,
                memberType === 'account' && h('label.checkbox', includeContacts,
                    h('span.small', 'Also add every active contact at these accounts')),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', { onclick: () => close(true) }, 'Add'),
            ],
        });

        if (!confirmed || !chosen.size) return;
        const result = await api.post(`/api/campaigns/${recordId}/members`, {
            memberType, ids: [...chosen.keys()], includeContacts: includeContacts.checked,
        });
        toast(`${result.added} added${result.skipped ? `, ${result.skipped} already there` : ''}`
            + `${result.cascaded ? `, plus ${result.cascaded.added} contacts` : ''}.`, 'success');
        reload();
    }

    /* ------------------------------------------------------ side panel --- */

    function sidePanel() {
        const cards = [];

        cards.push(h('div.card',
            h('div.card-header', h('h3', 'At a glance')),
            h('div.card-body',
                h('dl.detail-list',
                    h('dt', 'Owner'), h('dd', record.owner_name ?? '—'),
                    h('dt', 'Created'), h('dd', { title: date(record.created_at, { withTime: true }) }, relative(record.created_at)),
                    record.updated_at && [h('dt', 'Updated'), h('dd', { title: date(record.updated_at, { withTime: true }) }, relative(record.updated_at))],
                    objectKey === 'account' && [
                        // The true count, not the length of a capped list.
                        h('dt', 'Contacts'), h('dd', String(data.counts?.contacts ?? data.related.contacts?.length ?? 0)),
                        // Open deals stays a count of what was FETCHED, and is
                        // honest as long as the deals list is whole. It says so
                        // when it is not, rather than quietly undercounting.
                        h('dt', 'Open deals'), h('dd',
                            String((data.related.deals ?? []).filter((d) => d.status === 'open').length)
                            + ((data.counts?.deals ?? 0) > (data.related.deals ?? []).length ? ' of first 100' : '')),
                    ],
                    record.external_id && [h('dt', 'External ID'), h('dd', h('code.xs', record.external_id))],
                ),
            ),
        ));

        if (qualifies && extras.evidence?.latest) {
            cards.push(h('div.card',
                h('div.card-header', h('h3', 'Evidence')),
                h('div.card-body',
                    h('div.stack.tight',
                        h('div.xs.dim', `${extras.evidence.latest.provider} · ${relative(extras.evidence.latest.collectedAt)}`),
                        h('button.btn.sm.block', { onclick: () => { activeTab = 'verdict'; paint(); } }, 'See what was observed'),
                    ),
                ),
            ));
        }

        // Campaign membership, on the record it applies to. "Why are we
        // contacting this person?" is asked here, not on the campaign page.
        if (extras.campaigns) {
            const active = extras.campaigns.memberships.filter((m) => !m.removed_at);
            const past = extras.campaigns.memberships.filter((m) => m.removed_at);
            cards.push(h('div.card',
                h('div.card-header',
                    h('h3', 'Campaigns'),
                    h('div.actions', h('span.xs.dim', `${active.length} current`)),
                ),
                h('div.card-body',
                    extras.campaigns.memberships.length === 0
                        ? h('p.xs.dim', 'Not in any campaign. The Campaign field above records where this record came '
                            + 'from; this list is every campaign it has been targeted by since.')
                        : h('div.stack.tight',
                            active.map((m) => h('div.row',
                                h('a.small', { href: `/campaigns/${m.campaign_id}` }, m.campaign_name),
                                h('div.spacer'),
                                h('span.badge', humanise(m.status)),
                            )),
                            past.length > 0 && h('details',
                                h('summary.xs.dim', `${past.length} past campaign(s)`),
                                h('div.stack.tight', { style: { marginBlockStart: 'var(--space-2)' } },
                                    past.map((m) => h('div.row',
                                        h('a.xs.dim', { href: `/campaigns/${m.campaign_id}` }, m.campaign_name),
                                        h('div.spacer'),
                                        h('span.xs.dim', `removed ${relative(m.removed_at)}`),
                                    )),
                                ),
                            ),
                        ),
                ),
            ));
        }

        /**
         * There is no "Quick actions" card here any more.
         *
         * It listed six buttons, and five of them already existed on the same
         * screen: Log activity is the header's own action, and Add task, Add
         * note, Upload document and Audit trail are the ⋯ menu beside it. Verify
         * email was the sixth, and it has a better home — the Email health card
         * below, next to the answer it changes.
         *
         * Three routes to "Add task" is not three times as discoverable. It
         * makes the reader check all three in case they do different things.
         */
        if (isOutreachContact && extras.outreach?.length) {
            const card = outreachCard(extras.outreach, {
                onSync: async () => {
                    try { await api.post('/api/integrations/smartlead/sync', {}); toast('Sync requested.', 'success'); reload(); }
                    catch (err) { toast(err.message, 'error'); }
                },
            });
            if (card) cards.push(card);
        }
        if (verifiable) cards.push(emailHealthCard());
        return cards;
    }

    /* --------------------------------------------------------- actions --- */

    /**
     * Email Health.
     *
     * Shows the ANSWER, when it was reached, by whom, and what it said before —
     * because "unverified" and "we checked and could not tell" are different
     * facts that a single tick-box conflated. The history matters: an address
     * that was deliverable in March and risky today is a story, and one status
     * field cannot tell it.
     */
    const _emailHealthCard = makeEmailHealthCard({ h, humanise, relative, date, store });
    function emailHealthCard() { return _emailHealthCard(record, extras, verifyContactEmail); }
    function classifyStatus(status) {
        const described = store.verificationStatus(status);
        if (described) return described.classification;
        if (['verified', 'deliverable'].includes(status)) return 'safe';
        if (['invalid', 'disposable', 'do_not_email'].includes(status)) return 'blocked';
        return 'review';
    }

    async function verifyContactEmail() {
        if (!record.email) {
            toast('Cannot verify an email address that is missing.', 'error');
            return;
        }
        try {
            const { verification } = await api.post(`/api/${routeName}/${recordId}/verify-email`, {});
            /**
             * The toast says what the answer MEANS, not just what it is called.
             * "Accept all — BounceBan" read as good news and then the record
             * said "Safe to send: No", which is the same fact stated twice in
             * two vocabularies. A review result is a warning, not a success.
             */
            const tone = { blocked: 'error', review: 'warning', safe: 'success' }[verification.classification]
                ?? 'success';
            toast(`${verification.label} — ${verification.providerLabel}. ${verification.help ?? ''}`.trim(), tone);
            reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    /**
     * Creating a task, an activity or a note.
     *
     * Three one-line functions over ONE dialog. They used to be three
     * hand-written forms — three sets of labels, three date controls, three
     * ideas of what "saving" looks like, and three places to add a field that
     * the object registry already declares. `editEntity` renders whichever
     * object it is handed from that registry, so a new field appears in all
     * three without a line of code here.
     */
    const parentDefaults = () => ({ parent_type: objectKey, parent_id: recordId });

    async function logActivity() {
        const saved = await editEntity('activity', {
            title: 'Log activity',
            defaults: { ...parentDefaults(), occurred_at: new Date().toISOString() },
        });
        if (saved) { activeTab = 'activity'; reload(); }
    }

    async function addTask() {
        const saved = await editEntity('task', {
            title: 'New task',
            defaults: { ...parentDefaults(), assignee_id: store.state.me.user.id, priority: 'B', status: 'open' },
        });
        if (saved) { activeTab = 'activity'; reload(); }
    }

    async function addNote() {
        const saved = await editEntity('note', {
            title: 'New note',
            defaults: parentDefaults(),
        });
        if (saved) { activeTab = 'activity'; reload(); }
    }

    async function uploadDocument() {
        const input = h('input', { type: 'file' });
        input.click();
        await new Promise((resolve) => { input.onchange = resolve; });
        const file = input.files?.[0];
        if (!file) return;
        try {
            await api.upload(file, { parentType: objectKey, parentId: recordId });
            toast(`${file.name} uploaded.`, 'success');
            activeTab = 'documents';
            reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    async function createContact() {
        const draft = { account_id: record.account_id ?? recordId, is_active: true, data_source: 'entered manually' };
        let form;
        const errorBox = h('div.error');
        const saved = await modal({
            title: 'New contact',
            size: 'wide',
            body: () => {
                form = recordForm('contact', draft, {});
                return h('div.stack', errorBox, form.element);
            },
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', {
                    onclick: async (event) => {
                        const button = event.currentTarget;
                        button.disabled = true;
                        try {
                            await api.post('/api/contacts', { ...form.draft, account_id: draft.account_id });
                            close(true);
                        } catch (err) {
                            errorBox.textContent = err.message;
                            button.disabled = false;
                        }
                    },
                }, 'Create'),
            ],
        });
        if (saved) { activeTab = 'contacts'; reload(); }
    }

    /**
     * Raising a deal by hand, beside whatever the automations have created.
     *
     * Manual creation is deliberately still here. An account may already have
     * "ABC Company - HCM" because an agreement was generated for it, and the
     * rep still needs to raise "ABC Company - Recruitment" beside it — one
     * account, several deals, one per thing being sold.
     *
     * The NAME is not asked for. It is generated from the company and the
     * service, server-side, so it reads the same however the deal was raised;
     * the field below shows what it will be and can be overridden for the case
     * this exists for, a second deal in the same service.
     */
    async function createDeal() {
        const pipelines = store.pipelines();
        const services = store.serviceLines();
        const draft = {
            account_id: recordId,
            name: '',
            pipeline_id: pipelines[0]?.id,
            stage_id: pipelines[0]?.stages?.[0]?.id,
            currency: record.billing_currency || store.baseCurrency(),
            service_line_key: services[0]?.key,
            status: 'open',
            price: '',
        };
        const errorBox = h('div.error');
        // Anything typed or changed is work worth keeping: clicking out of the
        // modal must ask before throwing it away.
        let dealDirty = false;
        const markDealDirty = () => { dealDirty = true; };

        const stageSelect = h('select.input', { onchange: (e) => { draft.stage_id = e.target.value; markDealDirty(); } });
        const fillStages = () => {
            const pipeline = pipelines.find((p) => p.id === draft.pipeline_id);
            mount(stageSelect, (pipeline?.stages ?? []).map((s) => h('option', { value: s.id }, s.label)));
            draft.stage_id = pipeline?.stages?.[0]?.id;
        };
        fillStages();

        // What the deal will be called, and how it will bill, both of which
        // follow the service — shown live so neither is a surprise on save.
        const nameHint = h('span.help');
        const billingHint = h('span.help');
        const nameInput = h('input.input', {
            dir: 'auto', value: '', placeholder: '',
            oninput: (e) => { draft.name = e.target.value; markDealDirty(); },
        });
        const refreshHints = () => {
            const service = services.find((s) => s.key === draft.service_line_key);
            const generated = `${record.name}${service ? ` - ${service.label}` : ''}`;
            nameInput.placeholder = generated;
            nameHint.textContent = `Leave empty and it becomes "${generated}".`;
            billingHint.textContent = service
                ? `${service.label} is billed ${store.isRecurringService(service.key) ? 'monthly — the price below is per month' : 'once — the price below is the whole of it'}.`
                : '';
        };
        refreshHints();

        const saved = await modal({
            title: 'New deal',
            body: h('div.stack',
                errorBox,
                h('div.field', h('label', 'Service'),
                    h('select.input', {
                        onchange: (e) => { draft.service_line_key = e.target.value; markDealDirty(); refreshHints(); },
                    }, services.map((s) => h('option', { value: s.key, selected: s.key === draft.service_line_key }, s.label))),
                    billingHint),
                h('div.field', h('label', 'Name'), nameInput, nameHint),
                h('div.grid', { style: { gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 'var(--space-3)' } },
                    h('div.field', h('label', 'Price'),
                        h('input.input', {
                            type: 'number', step: '0.01', min: '0', inputmode: 'decimal',
                            placeholder: 'Optional — add it later',
                            oninput: (e) => { draft.price = e.target.value; markDealDirty(); },
                        })),
                    h('div.field', h('label', 'Currency'),
                        record.billing_currency
                            ? h('div',
                                h('input.input', { value: record.billing_currency, disabled: true }),
                                h('span.help', 'The account’s billing currency. The deal, its proposals and its '
                                    + 'agreements all bill in this.'))
                            : h('select.input', { onchange: (e) => { draft.currency = e.target.value; markDealDirty(); } },
                                store.currencies().map((c) => h('option', { value: c, selected: c === draft.currency }, c)))),
                ),
                h('div.field', h('label', 'Stage'), stageSelect),
                pipelines.length > 1 && h('div.field', h('label', 'Pipeline'),
                    h('select.input', { onchange: (e) => { draft.pipeline_id = e.target.value; markDealDirty(); fillStages(); } },
                        pipelines.map((p) => h('option', { value: p.id }, p.label)))),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', {
                    onclick: async (event) => {
                        const button = event.currentTarget;
                        button.disabled = true;
                        try {
                            const { price, ...fields } = draft;
                            if (!fields.name) delete fields.name;
                            const { record: created } = await api.post('/api/deals', fields);
                            // The price is a second call because it is not a
                            // column on the deal — it is the deal's size, and
                            // one function owns writing it.
                            let pending = false;
                            if (String(price ?? '').trim() !== '') {
                                // { deal, size } — see the note on the same call in
                                // editDealSize above.
                                const { size: priced } = await api.put(`/api/deals/${created.id}/size`, { price, currency: draft.currency });
                                pending = Boolean(priced.pending);
                            }
                            dealDirty = false;
                            close(created);
                            // Same rule as editing a deal's size: someone without
                            // record.write.all proposes a price rather than setting
                            // it, so a rep creating a deal with a price sees it open
                            // unpriced until a manager approves — worth saying,
                            // since nothing else on this dialog would.
                            if (pending) {
                                toast('Deal created. Its price is submitted for manager approval and will show once approved.', 'warning');
                            }
                        } catch (err) {
                            errorBox.textContent = err.message;
                            button.disabled = false;
                        }
                    },
                }, 'Create'),
            ],
            closeGuard: () => {
                if (!dealDirty) return true;
                return confirm({
                    title: 'Discard this deal?',
                    message: 'You have entered details that have not been saved. Closing now loses them.',
                    confirmLabel: 'Discard',
                    danger: true,
                });
            },
        });
        if (saved) navigate(`/deals/${saved.id}`);
    }

    /**
     * "+ Proposal" produces a proposal DOCUMENT, through the same wizard.
     *
     * It used to ask for a title, create a bare record and quote the deal's
     * line items into a version — a proposal with nothing to send. That made
     * two kinds of proposal in one table: the ones written from a template,
     * which have a file a client can read, and these, which had a number, a
     * status and an approval workflow attached to nothing at all. Approving one
     * approved a record rather than a document.
     *
     * There is one route now, and it is `generateDocument` — the same dialog,
     * the same templates, the same fields, narrowed to the proposal category
     * and told which deal it belongs to.
     */
    async function createProposal() {
        return generateDocument({ category: 'proposal' });
    }

    async function moveStage() {
        const pipeline = store.pipelines().find((p) => p.id === record.pipeline_id);
        const stages = pipeline?.stages ?? [];
        const select = h('select.input', stages.map((s) => h('option', { value: s.id, selected: s.id === record.stage_id }, s.label)));
        const reasonWrap = h('div');
        const errorBox = h('div.error');

        const refreshReason = () => {
            const stage = stages.find((s) => s.id === select.value);
            mount(reasonWrap, stage?.type === 'lost'
                ? h('div.field',
                    h('label', 'Loss reason', h('span.required', '*')),
                    h('select.input', { id: 'lossreason' }, store.lossReasons().map((r) => h('option', { value: r.key }, r.label))),
                    h('span.help', 'Loss reasons are the second-best ICP signal after verdict overrides, which is why one is required.'))
                : null);
        };
        select.addEventListener('change', refreshReason);
        refreshReason();

        const moved = await modal({
            title: 'Move stage',
            body: h('div.stack', errorBox, h('div.field', h('label', 'Stage'), select), reasonWrap),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', {
                    onclick: async (event) => {
                        const button = event.currentTarget;
                        button.disabled = true;
                        try {
                            await api.post(`/api/deals/${recordId}/stage`, {
                                stageId: select.value,
                                lossReason: document.getElementById('lossreason')?.value,
                            });
                            close(true);
                        } catch (err) {
                            errorBox.textContent = err.message;
                            if (err.payload?.missing) {
                                errorBox.textContent = `${err.message} Fill those in first, or move to a different stage.`;
                            }
                            button.disabled = false;
                        }
                    },
                }, 'Move'),
            ],
        });
        if (moved) reload();
    }

    /**
     * Puts this contact on a cold calling queue from its own page.
     *
     * A rep (`calling.assign_own`, no `calling.manage`) can only ever add to
     * their OWN queue — `assignContacts` forces that server-side regardless
     * of what is sent — so there is nothing to pick and the request goes out
     * immediately. A manager gets the same SDR choice the Cold Calling
     * module's own assign flow offers, fetched fresh since this page never
     * otherwise loads anything from the calling module.
     */
    async function addToColdCalling() {
        if (!store.can('calling.manage')) {
            try {
                const result = await api.post('/api/calling/assign', { ids: [recordId], priority: 'B' });
                toast(result.message ?? 'Added to your calling queue.', 'success');
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
            return;
        }

        let meta;
        try {
            meta = await api.get('/api/calling/meta');
        } catch (err) {
            toast(err.message, 'error');
            return;
        }
        if (!meta.sdrs?.length) {
            toast('There is nobody in the workspace to assign this to.', 'error');
            return;
        }

        const draft = { assignedTo: meta.sdrs[0].id, priority: 'B' };
        const chosen = await modal({
            title: `Add to Cold Calling — ${titleOf(objectKey, record)}`,
            body: h('div.stack',
                h('div.field',
                    h('label', 'Assign to'),
                    h('select.input', { onchange: (e) => { draft.assignedTo = e.target.value; } },
                        meta.sdrs.map((sdr) => h('option', { value: sdr.id }, `${sdr.name} · ${sdr.role}`))),
                ),
                h('div.field',
                    h('label', 'Priority'),
                    h('select.input', { onchange: (e) => { draft.priority = e.target.value; } },
                        meta.priorities.map((p) => h('option', { value: p, selected: p === draft.priority }, p))),
                ),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(null) }, 'Cancel'),
                h('button.btn.primary', { onclick: () => close(draft) }, 'Add'),
            ],
        });
        if (!chosen) return;

        try {
            const result = await api.post('/api/calling/assign', {
                ids: [recordId], assignedTo: chosen.assignedTo, priority: chosen.priority,
            });
            toast(result.message ?? 'Added to the calling queue.', result.assigned ? 'success' : 'warning');
            await reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    /**
     * Takes this contact off the calling queue entirely — `calling.manage`
     * only, same as the bulk Remove button in Cold Calling itself
     * (`removeFromQueue`, lib/calling.mjs, refuses anyone else).
     */
    async function removeFromColdCalling() {
        const ok = await confirm({
            title: 'Remove from the calling queue?',
            message: `${titleOf(objectKey, record)} comes off the calling screen for everyone. Calls already made are kept.`,
            confirmLabel: 'Remove',
            danger: true,
        });
        if (!ok) return;

        try {
            await api.post('/api/calling/remove', { contactIds: [recordId] });
            toast('Removed from the calling queue.', 'success');
            await reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    /**
     * Deep-links into Cold Calling, pre-filtered to exactly this contact —
     * the phone number as the queue's own quick search term, the same
     * mechanism global search's "On X's queue →" link already uses (see
     * app.js/search.js). `tab=all` because the contact may be sitting on
     * Completed or Dead, not only "To call", and phone (rather than name) is
     * the value least likely to also match somebody else on that SDR's list.
     */
    function openInColdCalling() {
        const term = record.phone || titleOf(objectKey, record);
        navigate(`/calling?sdr=${encodeURIComponent(extras.calling.sdrId)}&q=${encodeURIComponent(term)}&tab=all`);
    }

    /**
     * Asking a manager to hand this contact to somebody else — the contact
     * page's version of the same button on Cold Calling's call console (see
     * `requestReassignment` there, and requestReassign in api/calling.mjs
     * for the door itself). Fetches the colleague list fresh: this page
     * never otherwise loads anything from the calling module.
     */
    async function requestReassignment() {
        let meta;
        try {
            meta = await api.get('/api/calling/meta');
        } catch (err) {
            toast(err.message, 'error');
            return;
        }
        const me = await api.get('/api/me');
        const others = (meta.colleagues ?? []).filter((m) => m.id !== me.user?.id && m.id !== record.owner_id);
        if (!others.length) {
            toast('There is nobody else in the workspace to request this for.', 'error');
            return;
        }

        const draft = { to: others[0].id, note: '' };
        const chosen = await modal({
            title: `Request reassignment — ${titleOf(objectKey, record)}`,
            body: h('div.stack',
                h('div.field',
                    h('label', 'Send this contact to'),
                    h('select.input', { onchange: (e) => { draft.to = e.target.value; } },
                        others.map((m) => h('option', { value: m.id }, `${m.name} · ${m.role}`))),
                ),
                h('div.field',
                    h('label', 'Why (optional)'),
                    h('textarea.input', {
                        rows: 3, placeholder: 'Anything the manager should know before deciding…',
                        oninput: (e) => { draft.note = e.target.value; },
                    }),
                ),
                h('p.xs.dim', 'Nothing moves yet — a manager approves or rejects this before the contact changes hands.'),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(null) }, 'Cancel'),
                h('button.btn.primary', { onclick: () => close(draft) }, 'Send request'),
            ],
        });
        if (!chosen) return;

        try {
            await api.post(`/api/calling/contacts/${recordId}/reassign-request`, chosen);
            toast('Reassignment requested. A manager will review it.', 'success');
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    /** Puts your own document up for review. No dialogue: there is nothing to decide. */
    async function submitForReview() {
        await api.post(`/api/${objectKey}s/${recordId}/submit`, {});
        reload();
    }

    /**
     * Approve or reject, with the reason a rejection has to carry.
     *
     * The note is required for a rejection and optional for an approval,
     * matching the server rather than restating it — sending the author back to
     * guess what was wrong is the failure this prevents.
     */
    async function reviewDocument(decision) {
        const rejecting = decision === 'rejected';
        const note = h('textarea.input', {
            rows: 3,
            placeholder: rejecting ? 'What needs to change before this can go out?' : 'Optional',
        });
        const errorBox = h('div.error');

        const done = await modal({
            title: rejecting ? 'Reject this document' : 'Approve this document',
            body: h('div.stack',
                errorBox,
                h('div.field', h('label', rejecting ? 'Reason' : 'Note'), note),
                h('div.note-box', rejecting
                    ? 'The author sees this on the record and can resubmit once it is addressed.'
                    : 'Approving lets this be issued or signed. Who approved it is recorded.'),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h(`button.btn.${rejecting ? 'danger' : 'primary'}`, {
                    onclick: async (event) => {
                        const button = event.currentTarget;
                        button.disabled = true;
                        try {
                            await api.post(`/api/${objectKey}s/${recordId}/review`, {
                                decision, note: note.value,
                            });
                            close(true);
                        } catch (err) {
                            errorBox.textContent = err.message;
                            button.disabled = false;
                        }
                    },
                }, rejecting ? 'Reject' : 'Approve'),
            ],
        });
        if (done) reload();
    }

    /**
     * Attaches this agreement to one of its account's deals.
     *
     * Offers only that account's deals, because an agreement names a client and
     * a deal belonging to somebody else is never the answer. Signing pushes the
     * contract value onto whatever is linked here, so this is the step that
     * makes "deal size matches the agreement" possible at all.
     */
    async function linkAgreementToDeal() {
        if (!record.account_id) {
            return toast('This agreement has no account, so there are no deals to choose from.', 'error');
        }
        const { records: deals } = await api.get(`/api/deals?account_id=${record.account_id}&limit=200`);

        /**
         * "That account has no deals yet. Create one first, then link it."
         *
         * That sentence used to end this function, and it is a CRM asking a
         * person to do its filing. An agreement is a contract for a service
         * with a client, which is what a deal records — so the server finds the
         * right one or creates it, and the only thing left to choose here is
         * WHICH deal when there is more than one.
         */
        const select = h('select.input', [
            h('option', { value: '' },
                deals.length ? '— raise a new deal for this contract —' : '— raise a deal for this contract —'),
            ...deals.map((d) => h('option', {
                value: d.id, selected: d.id === record.deal_id,
            }, `${d.name}${d.stage_label ? ` · ${d.stage_label}` : ''}`)),
        ]);
        const errorBox = h('div.error');

        const done = await modal({
            title: 'Link to deal',
            body: h('div.stack',
                errorBox,
                h('div.field', h('label', 'Deal'), select),
                h('div.note-box', Number(record.contract_value) > 0
                    ? 'Signing this agreement sets the deal’s size to '
                      + `${money(record.contract_value, record.currency)} and moves it to Deal Won.`
                    : 'This agreement has no contract value yet, so signing will leave the deal’s price alone.'),
                h('div.note-box', 'Leave the deal unchosen and one is found for this account and service, '
                    + 'or created if there is none. An agreement is never left without a deal.'),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', {
                    onclick: async (event) => {
                        event.currentTarget.disabled = true;
                        try {
                            await api.patch(`/api/agreements/${recordId}`, { deal_id: select.value || null });
                            close(true);
                        } catch (err) {
                            errorBox.textContent = err.message;
                            event.currentTarget.disabled = false;
                        }
                    },
                }, 'Link'),
            ],
        });
        if (done) reload();
    }

    /**
     * The manual retry for a signed agreement whose Internal Team Proposal
     * never got raised — see `retryInternalTeamProposal` in api/proposals.mjs.
     * Idempotent on the server, so there is nothing to confirm here.
     */
    async function retryInternalProposal() {
        try {
            const { emails } = await api.post(`/api/agreements/${recordId}/internal-proposal`, {});
            const sent = [emails?.finance, emails?.internalTeam].filter((e) => e && !e.skipped).length;
            toast(sent > 0 ? `Sent ${sent} notification email${sent === 1 ? '' : 's'}.` : 'Already sent — nothing new to send.', 'success');
            reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    async function signAgreement() {
        // Typed or picked, like every other date in the CRM. A signature date
        // read off a signed contract is typed; a renewal date is picked.
        let effectiveValue = record.effective_date ?? new Date().toISOString().slice(0, 10);
        let expiryValue = record.expiry_date ?? '';
        const effective = dateInput({ value: effectiveValue, onChange: (v) => { effectiveValue = v; } });
        const expiry = dateInput({ value: expiryValue, onChange: (v) => { expiryValue = v; } });
        const errorBox = h('div.error');
        const signed = await modal({
            title: 'Record signature',
            body: h('div.stack',
                errorBox,
                h('div.field', h('label', 'Effective date'), effective),
                h('div.field', h('label', 'Expiry date'), expiry),
                h('div.note-box', 'Signing moves the deal to won and the account to customer. '
                    + `The notice date is ${record.notice_days || 0} days before expiry — that is when the renewal decision is due, `
                    + 'not the expiry itself.'),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', {
                    onclick: async (event) => {
                        const button = event.currentTarget;
                        button.disabled = true;
                        try {
                            await api.post(`/api/agreements/${recordId}/sign`, {
                                effectiveDate: effectiveValue, expiryDate: expiryValue || null,
                            });
                            close(true);
                        } catch (err) {
                            errorBox.textContent = err.message;
                            button.disabled = false;
                        }
                    },
                }, 'Record'),
            ],
        });
        if (signed) reload();
    }

    /**
     * A renewal: the same document again, only the term moves.
     *
     * Everything else — client name, price, terms — is read back from the
     * agreement's OWN original generation server-side; this dialog asks for
     * exactly the one thing that changes. The new dates default to picking
     * up where this contract leaves off (day after expiry, one year on),
     * editable for a term that isn't a plain twelve months.
     */
    async function renewAgreement() {
        const oldExpiry = record.expiry_date ? new Date(record.expiry_date) : new Date();
        const defaultStart = new Date(oldExpiry.getTime() + 86400000);
        const defaultEnd = new Date(defaultStart);
        defaultEnd.setFullYear(defaultEnd.getFullYear() + 1);
        defaultEnd.setDate(defaultEnd.getDate() - 1);

        let startValue = defaultStart.toISOString().slice(0, 10);
        let endValue = defaultEnd.toISOString().slice(0, 10);
        const start = dateInput({ value: startValue, onChange: (v) => { startValue = v; } });
        const end = dateInput({ value: endValue, onChange: (v) => { endValue = v; } });
        const errorBox = h('div.error');

        const saved = await modal({
            title: 'Create renewal',
            body: h('div.stack',
                errorBox,
                h('div.note-box', `Generates ${record.number} again from the exact same template, client details, service and price — `
                    + 'only the contract dates change. The original stays exactly as signed.'),
                h('div.field', h('label', 'New start date'), start),
                h('div.field', h('label', 'New end date'), end),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', {
                    onclick: async (event) => {
                        const button = event.currentTarget;
                        if (!startValue || !endValue) {
                            errorBox.textContent = 'Pick both dates.';
                            return;
                        }
                        button.disabled = true;
                        button.textContent = 'Generating…';
                        try {
                            const result = await api.post(`/api/agreements/${recordId}/renew`, {
                                startDate: startValue, endDate: endValue,
                            });
                            close(result);
                        } catch (err) {
                            errorBox.textContent = err.message;
                            button.disabled = false;
                            button.textContent = 'Create renewal';
                        }
                    },
                }, 'Create renewal'),
            ],
        });
        if (saved?.record) {
            toast(`Renewal ${saved.record.number} created.`, 'success');
            navigate(`/${saved.record.object}s/${saved.record.id}`);
        }
    }

    async function showDuplicates() {
        const result = await api.get(`/api/accounts/${recordId}/duplicates`);
        await modal({
            title: 'Possible duplicates',
            size: 'wide',
            body: h('div.stack',
                result.candidates.length === 0
                    ? h('p.dim', 'Nothing else in this workspace matches on registration number, domain, LinkedIn slug or name.')
                    : h('div.table-wrap', h('table.data',
                        h('thead', h('tr', h('th', 'Account'), h('th', 'Matched on'), h('th', 'Confidence'), h('th', ''))),
                        h('tbody', result.candidates.map((c) => h('tr',
                            h('td', h('a', { href: `/accounts/${c.id}` }, c.name)),
                            h('td.small', c.matchers.join(', ')),
                            h('td', h('span.badge', { class: c.confidence === 'certain' ? 'success' : c.confidence === 'high' ? 'accent' : '' }, c.confidence)),
                            h('td', h('button.btn.sm', { onclick: () => compareAndMerge(c) }, 'Compare & merge')),
                        ))),
                    )),
                h('div.note-box', result.note),
            ),
            footer: (close) => h('button.btn.primary', { onclick: () => close(true) }, 'Close'),
        });
    }

    /**
     * The merge comparison.
     *
     * Field-by-field, with the choice made per field rather than "the survivor
     * wins" — which quietly discards the better data whenever the duplicate is
     * the more complete record. Only fields that actually DIFFER are offered;
     * showing forty identical rows to find the three that matter is how a merge
     * screen stops being read.
     *
     * The survivor's value is preselected, and every choice is audited.
     */
    async function compareAndMerge(candidate) {
        /**
         * The plan comes from the SERVER, not from a second copy of the rules
         * here. "Prefer non-empty, prefer verified, never overwrite a populated
         * value with an empty one" existed in both places and had already
         * drifted; a preview that disagrees with the merge it previews is worse
         * than no preview.
         */
        let preview;
        try {
            preview = await api.post('/api/accounts/merge-preview', {
                survivorId: recordId, loserId: candidate.id,
            });
        } catch (err) {
            toast(err.message, 'error');
            return;
        }

        const { plan, moving, conflicts, loser: other } = preview;
        const choices = {};
        for (const row of plan) choices[row.key] = row.from;

        const movingText = Object.entries(moving ?? {})
            .map(([table, n]) => `${n} ${table.replace(/_/g, ' ')}`).join(', ');

        const confirmed = await modal({
            title: `Merge ${other.name} into ${record.name}`,
            size: 'wide',
            body: h('div.stack',
                h('div.note-box',
                    h('div.strong', 'What happens to everything attached'),
                    h('ul', { style: { marginBlockStart: 'var(--space-1)', paddingInlineStart: 'var(--space-4)', listStyle: 'disc' } },
                        h('li', movingText
                            ? `${movingText} move to this account.`
                            : 'Nothing is attached to the duplicate, so nothing moves.'),
                        h('li', 'Verdicts are RE-POINTED, not merged — both evidence trails stay separate and readable, '
                            + 'because they describe two different observed companies.'),
                        h('li', `${other.name} is kept, soft-deleted and marked as merged, so this is reversible.`),
                    ),
                ),

                conflicts > 0 && h('div.note-box.warning',
                    h('div.strong', `${conflicts} field${conflicts === 1 ? '' : 's'} disagree`),
                    h('p.small', 'Both records hold a different, equally current value for these. They are marked '
                        + 'below and have NOT been decided for you — picking one by rule here would quietly '
                        + 'destroy the right answer.'),
                ),

                plan.length === 0
                    ? h('p.dim', 'Every field agrees, so there is nothing to choose. The merge just moves the '
                        + 'attached records across.')
                    : h('div.table-wrap', h('table.data',
                        h('thead', h('tr',
                            h('th', 'Field'),
                            h('th', `${record.name} (keep)`),
                            h('th', other.name),
                            h('th', 'Why'),
                        )),
                        h('tbody', plan.map((row) => {
                            const name = `merge_${row.key}`;
                            return h('tr', { class: row.conflict ? 'is-review' : '' },
                                h('td.small.strong', row.label,
                                    row.conflict && h('span.badge.warning', { style: { marginInlineStart: 'var(--space-1)' } }, 'conflict')),
                                h('td', h('label.checkbox',
                                    h('input', {
                                        type: 'radio', name, checked: choices[row.key] === 'survivor',
                                        onchange: () => { choices[row.key] = 'survivor'; },
                                    }),
                                    h('span.small', { dir: 'auto' }, formatValue(row.survivorValue)),
                                )),
                                h('td', h('label.checkbox',
                                    h('input', {
                                        type: 'radio', name, checked: choices[row.key] === 'loser',
                                        onchange: () => { choices[row.key] = 'loser'; },
                                    }),
                                    h('span.small', { dir: 'auto' }, formatValue(row.loserValue)),
                                )),
                                h('td.xs.dim', { style: { maxInlineSize: '18rem' } }, row.reason),
                            );
                        })),
                    )),
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', { onclick: () => close(true) }, 'Merge'),
            ],
        });

        if (!confirmed) return;

        // Only the fields taken FROM THE DUPLICATE are sent. Sending the
        // survivor's own values back would write a no-op update and fill the
        // audit log with changes nobody made.
        const fieldChoices = {};
        for (const row of plan) {
            if (choices[row.key] === 'loser' && !row.custom) fieldChoices[row.key] = row.loserValue;
        }

        try {
            const result = await api.post('/api/accounts/merge', {
                survivorId: recordId, loserId: other.id, fields: fieldChoices,
            });
            const moved = Object.entries(result.moved ?? {})
                .map(([table, n]) => `${n} ${table.replace(/_/g, ' ')}`).join(', ');
            toast(`Merged.${moved ? ` Moved ${moved}.` : ''} It can be undone.`, 'success');
            reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    async function showAudit() {
        const { events } = await api.get(`/api/${routeName}/${recordId}/audit`);
        await modal({
            title: 'Audit trail',
            size: 'wide',
            body: h('div.stack',
                h('div.note-box', 'Append-only. No user, including an admin, can edit or delete these entries — '
                    + 'which is what separates them from the timeline.'),
                h('div.table-wrap', h('table.data',
                    h('thead', h('tr', h('th', 'When'), h('th', 'Action'), h('th', 'Who'), h('th', 'Change'))),
                    h('tbody', events.map((e) => h('tr',
                        h('td', { title: date(e.created_at, { withTime: true }) }, relative(e.created_at)),
                        h('td', h('span.badge', humanise(e.action))),
                        h('td', e.actor_name),
                        h('td.xs.dim', summariseChange(e)),
                    ))),
                )),
            ),
            footer: (close) => h('button.btn.primary', { onclick: () => close(true) }, 'Close'),
        });
    }

    async function deleteRecord() {
        const ok = await confirm({
            title: `Delete this ${def.label.toLowerCase()}?`,
            message: 'It is soft-deleted and can be restored. Nothing attached to it is destroyed.',
            confirmLabel: 'Delete', danger: true,
        });
        if (!ok) return;
        try {
            await api.delete(`/api/${routeName}/${recordId}`);
            toast('Deleted.', 'success');
            navigate(`/${routeName}`);
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    paint();
    return undefined;
}

/* --------------------------------------------------------------- helpers -- */

/** Empty is shown as "empty", not as a blank cell that reads as a rendering bug. */
function formatValue(value) {
    if (value === null || value === undefined || value === '') return '— empty —';
    if (Array.isArray(value)) return value.join(', ') || '— empty —';
    return String(value).slice(0, 120);
}

function titleOf(objectKey, record) {
    if (objectKey === 'contact' || objectKey === 'prospecting_contact') {
        return record.full_name || `${record.first_name ?? ''} ${record.last_name ?? ''}`.trim() || record.email || 'Contact';
    }
    if (objectKey === 'note') return String(record.body ?? '').slice(0, 60) || 'Note';
    return record.name ?? record.title ?? record.subject ?? record.number ?? record.id;
}

function lifecycleKind(stage) {
    return {
        qualified: 'success', customer: 'success', engaged: 'accent',
        disqualified: 'danger', churned: 'danger',
    }[stage] ?? '';
}

function summariseChange(event) {
    if (!event.after) return '—';
    const keys = Object.keys(event.after).filter((k) => k !== '_reason');
    if (!keys.length) return '—';
    return keys.slice(0, 3).map((k) => {
        const from = event.before?.[k];
        const to = event.after[k];
        return from !== undefined ? `${k}: ${trim(from)} → ${trim(to)}` : `${k}: ${trim(to)}`;
    }).join(', ');
}

function trim(v) {
    if (v === null || v === undefined || v === '') return '∅';
    return String(v).slice(0, 40);
}

function toLocal(iso) {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
