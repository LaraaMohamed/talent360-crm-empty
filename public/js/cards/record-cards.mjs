/**
 * Record detail cards — extracted from the 3,700-line record.js monolith.
 *
 * These are the agreement/proposal cards that were buried in one file
 * doing eleven jobs. They are now pure render functions: same markup,
 * same behavior, testable in isolation, and the record page shrinks
 * without changing what it shows.
 *
 * Each factory receives its dependencies explicitly — no hidden closure
 * over record.js locals — so the next extraction (dealSize, emailHealth)
 * follows the same pattern.
 */
import { h } from '../core.js';

/**
 * The renewal countdown a person reads at a glance — "45 days until renewal",
 * counting down toward zero as the notice window nears, then past it into
 * expiry. Mirrors the exact arithmetic `lib/renewals.mjs` runs server-side
 * (expiry minus notice_days), so the number on screen is never a rounding
 * disagreement with the task the automation actually raises.
 */
export function renewalCountdown(record, defaultNoticeDays = 45) {
    if (!record.expiry_date) return null;
    if (record.status === 'terminated') return { label: 'Terminated', tone: '' };
    if (record.status === 'expired') return { label: 'Expired', tone: 'danger' };
    if (record.status !== 'signed') return null;
    if (record.renewable === 0 || record.renewable === false) return { label: 'Not renewable', tone: '' };

    const noticeDays = Number.isFinite(Number(record.notice_days)) && record.notice_days !== null && record.notice_days !== ''
        ? Number(record.notice_days) : defaultNoticeDays;
    const expiry = new Date(`${String(record.expiry_date).slice(0, 10)}T00:00:00Z`).getTime();
    const noticeAt = expiry - noticeDays * 864e5;
    const daysToExpiry = Math.ceil((expiry - Date.now()) / 864e5);
    const daysToNotice = Math.ceil((noticeAt - Date.now()) / 864e5);

    if (daysToExpiry < 0) return { label: 'Expiring — past its end date', tone: 'danger' };
    if (daysToNotice <= 0) return { label: `${daysToExpiry} day${daysToExpiry === 1 ? '' : 's'} until it expires — renewal notice is due`, tone: 'warning' };
    return { label: `${daysToNotice} day${daysToNotice === 1 ? '' : 's'} until renewal notice`, tone: '' };
}

export function makeContractCard(env) {
    const { h: hh, money: mm, date: dd, humanise: hum, statTile: st, store: stt } = env;
    return function contractCardInner(record, extras, objectKey, linkAgreementToDeal, retryInternalProposal) {
        if (objectKey !== 'agreement') return null;
        const value = Number(record.contract_value);
        const priced = Number.isFinite(value) && value > 0;
        const service = stt.serviceLines().find((s) => s.key === record.service_line_key);
        const recurring = service?.billing_type === 'recurring';
        const state = record.status === 'signed'
            ? { tone: 'success', label: 'Signed', note: record.signed_at ? `Signed ${dd(record.signed_at)}.` : 'Signed.' }
            : record.status === 'terminated' ? { tone: 'danger', label: 'Terminated', note: 'The deal behind this contract is marked lost.' }
            : record.status === 'expired' ? { tone: 'danger', label: 'Expired', note: 'The deal behind this contract is marked lost.' }
            : record.status === 'out_for_signature' ? { tone: 'warning', label: 'Out for signature', note: 'Waiting on the client. Signing moves the deal to Deal Won.' }
            : { tone: '', label: hum(record.status), note: null };
        const countdown = env.renewalCountdown?.(record);
        return hh('div.card',
            hh('div.card-header', hh('h2', 'Contract'), hh('div.actions',
                countdown && hh('span.badge', { class: countdown.tone }, countdown.label),
                hh('span.badge', { class: state.tone }, state.label),
            )),
            hh('div.card-body',
                hh('div.stat-grid',
                    st('Value', priced ? mm(value, record.currency) : '—', recurring ? 'Per month, in the client’s currency' : 'The whole contract, in the client’s currency'),
                    st('Currency', record.currency ?? '—', 'What the client pays in'),
                    st('Service', service?.label ?? '—', service ? `Billed ${recurring ? 'monthly' : 'once'}.` : 'No service recorded'),
                    st('Term', record.effective_date ? `${dd(record.effective_date)}${record.expiry_date ? ` → ${dd(record.expiry_date)}` : ''}` : '—',
                        record.notice_days ? `${record.notice_days} days' notice — the window opens that many days before it expires.` : 'When it runs from, and to'),
                ),
                hh('div', { style: { marginBlockStart: 'var(--space-4)' } },
                    hh('h3.small.dim', 'The sale this closes'),
                    record.deal_id
                        ? hh('div.row.between.linked-record',
                            hh('div.stack.tight',
                                hh('a.strong', { href: `/deals/${record.deal_id}` }, record.deal_name ?? 'The linked deal'),
                                hh('span.xs.dim', 'Signing this agreement moves it to Deal Won; terminating moves it to Deal Lost.'),
                            ),
                            (stt.can('record.write.all') || stt.can('record.write.own')) && hh('button.btn.sm.ghost', { onclick: () => linkAgreementToDeal() }, 'Change'),
                        )
                        : hh('div.note-box.warning',
                            hh('div.strong.small', 'This contract is not attached to a deal'),
                            hh('p.xs', 'So it moves no pipeline and appears on no forecast. One will be found or created for this account and service.'),
                            hh('button.btn.sm.primary', { style: { marginBlockStart: 'var(--space-2)' }, onclick: () => linkAgreementToDeal() }, 'Attach it to a deal'),
                        ),
                ),
                record.status === 'signed' && hh('div', { style: { marginBlockStart: 'var(--space-4)' } },
                    hh('h3.small.dim', 'Internal Team Proposal'),
                    hh('div.row.between',
                        extras?.internalProposal
                            ? hh('a.strong', { href: `/proposals/${extras.internalProposal.id}` }, `${extras.internalProposal.number} — Internal Team Proposal`)
                            : hh('span.xs.dim', 'Not created yet — automatic on signing; recorded on this agreement’s timeline.'),
                        stt.can('agreement.sign') && retryInternalProposal
                            && hh('button.btn.sm.ghost', { onclick: () => retryInternalProposal() },
                                extras?.internalProposal ? 'Send email' : 'Create it now'),
                    ),
                ),
                state.note && hh('p.xs.dim', { style: { marginBlockStart: 'var(--space-3)' } }, state.note),
            ),
        );
    };
}

/**
 * The account's own commercial state — "Customer / Agreement" — built from
 * the agreements already fetched for the Agreements tab (`data.related.
 * agreements`), so this costs no extra round trip. Shows nothing for an
 * account with no signed agreement: a prospect is not a customer, and this
 * card exists to answer "is this one" — silence IS the answer for a name
 * that never got in here.
 */
export function makeCustomerCard(env) {
    const { h: hh, money: mm, date: dd, statTile: st, store: stt } = env;
    return function customerCardInner(record, data, objectKey) {
        if (objectKey !== 'account') return null;
        const agreements = (data?.related?.agreements ?? []).filter((a) => !a.deleted_at);
        if (!agreements.length) return null;

        // The one to lead with: signed and not yet expired if there is one,
        // else whichever expires soonest — either way, the contract closest
        // to needing a decision.
        const signed = agreements.filter((a) => a.status === 'signed');
        const lead = signed.sort((a, b) => (a.expiry_date ?? '9999').localeCompare(b.expiry_date ?? '9999'))[0]
            ?? agreements.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0];

        const service = stt.serviceLines().find((s) => s.key === lead.service_line_key);
        const countdown = env.renewalCountdown?.(lead);
        const activeCount = signed.length;

        return hh('div.card',
            hh('div.card-header', hh('h2', 'Customer / Agreement'),
                hh('div.actions', hh('span.badge', { class: signed.length ? 'success' : '' }, signed.length ? 'Active' : 'Not currently a customer'))),
            hh('div.card-body',
                hh('div.stat-grid',
                    st('Active agreements', String(activeCount), activeCount === 1 ? '1 currently signed' : `${activeCount} currently signed`),
                    st(service?.label ?? 'Service', lead.contract_value ? mm(Number(lead.contract_value), lead.currency) : '—', service ? undefined : 'No service recorded'),
                    st('Agreement', lead.effective_date ? `${dd(lead.effective_date)}${lead.expiry_date ? ` → ${dd(lead.expiry_date)}` : ''}` : '—', lead.number),
                    st('Next renewal', lead.renewal_date ? dd(lead.renewal_date) : (lead.expiry_date ? dd(lead.expiry_date) : '—'),
                        lead.notice_days ? `${lead.notice_days} days' notice` : undefined),
                ),
                countdown && hh('p.xs', { style: { marginBlockStart: 'var(--space-3)' } },
                    hh('span.badge', { class: countdown.tone }, countdown.label)),
                agreements.length > 1 && hh('p.xs.dim', { style: { marginBlockStart: 'var(--space-2)' } },
                    `${agreements.length} agreements total — see the Agreements tab for the full history.`),
                hh('p.xs.dim', { style: { marginBlockStart: 'var(--space-2)' } },
                    hh('a', { href: `/agreements/${lead.id}` }, `Open ${lead.number}`)),
            ),
        );
    };
}

export function makeReviewCard(env) {
    const { h: hh, date: dd, humanise: hum, store: stt } = env;
    return function reviewCardInner(record, objectKey) {
        if (objectKey !== 'proposal' && objectKey !== 'agreement') return null;
        const states = {
            pending_review: { tone: 'warning', label: 'Waiting for review' },
            approved: { tone: 'success', label: 'Approved' },
            rejected: { tone: 'danger', label: 'Sent back' },
            /**
             * A template-written (docx) proposal skips straight from
             * `approved` to `issued` the instant it is approved — see
             * reviewDocument in api/proposals.mjs. review_note and
             * reviewed_by are still on the record from that approval, but
             * this card returned null the moment status moved past
             * `approved`, so the reviewer's note vanished from the page for
             * the one document type where approval and issuing are the same
             * click. Shown only when there is actually something from a
             * review to say — an issued proposal that was never routed
             * through review at all has neither field set.
             */
            issued: record.review_note || record.reviewed_by ? { tone: 'success', label: 'Approved' } : null,
        };
        const state = states[record.status];
        if (!state) return null;
        return hh('div.card',
            hh('div.card-header', hh('h2', 'Review'), hh('span.badge', { class: state.tone }, state.label)),
            hh('div.card-body', hh('div.stack.tight',
                record.status === 'pending_review' ? hh('p.small.dim', stt.can('document.approve') ? 'Approve or reject this from the buttons above.' : 'A manager has to approve this before it can go out.') : null,
                record.review_note ? hh('div.note-box', hh('div.strong.small', record.status === 'rejected' ? 'What needs to change' : 'Reviewer’s note'), hh('div.small', record.review_note)) : null,
                record.reviewed_by ? hh('p.xs.dim', `${record.status === 'rejected' ? 'Rejected' : 'Approved'} by ${record.reviewed_name ?? 'a manager'}${record.reviewed_at ? ` · ${dd(record.reviewed_at)}` : ''}`) : null,
            )),
        );
    };
}

export function makeRegistrationCard(env) {
    const { h: hh } = env;
    return function registrationCardInner(record, data, objectKey) {
        if (objectKey !== 'account') return null;
        const reg = data?.related?.registration;
        if (!reg) return null;
        const rows = [
            ['Company name (Arabic)', reg.company_name_ar, 'rtl'],
            ['Representative', reg.representative_name],
            ['Address', reg.address],
        ].filter(([, v]) => v);
        if (!rows.length) return null;
        return hh('div.card',
            hh('div.card-header', hh('h2', 'Commercial registration'), hh('span.xs.dim', 'From the documents generated for this account')),
            hh('div.card-body', hh('dl.detail-list', rows.flatMap(([label, value, dir]) => [hh('dt', label), hh('dd', dir ? hh('span', { dir }, value) : value)]))),
        );
    };
}

export function makeDealSizeCard(env) {
    const { h: hh, money: mm, number: nn, date: dd, statTile: st, store: stt } = env;
    return function dealSizeCardInner(record, extras, editDealSize) {
        const size = extras?.size?.size;
        if (!size) return null;
        const recurring = size.billingType === 'recurring';
        const priced = size.price !== null && size.price !== undefined;
        const totals = extras.size.totals ?? { currency: size.currency, value_one_time: 0, value_mrr: 0 };
        const agreements = extras.size.agreements ?? [];
        return hh('div.card',
            hh('div.card-header', hh('h2', 'Deal size'),
                hh('div.actions', (stt.can('record.write.all') || stt.can('record.write.own')) && hh('button.btn.sm.primary', { onclick: () => editDealSize() }, priced ? 'Edit price' : 'Set price'))),
            hh('div.card-body',
                hh('div.stat-grid',
                    st('Deal size', priced ? mm(size.price, size.currency) : '—',
                        size.perPerson && priced ? `${nn(size.count)} × ${mm(size.unitPrice, size.currency)}${recurring ? ' per month' : ''}` : recurring ? 'Per month, in the client’s currency' : 'One payment, in the client’s currency'),
                    st(`In ${extras.size.deal?.reporting_currency ?? 'USD'}`,
                        priced ? (record.price_reporting === null || record.price_reporting === undefined ? '—' : mm(record.price_reporting, record.reporting_currency ?? 'USD')) : '—',
                        record.price_reporting === null && priced ? `No conversion rate is set for ${size.currency}.` : 'Converted at the workspace rate, as the dashboard reports.'),
                    size.perPerson ? st(size.perPerson.countLabel, priced ? nn(size.count) : '—', `${size.serviceLabel ?? 'This service'} is priced per ${size.perPerson.unit}.`) : st('Currency', size.currency, 'What the client pays in'),
                    st('Billing', size.billingLabel, `${size.serviceLabel ?? 'This service'} is billed ${recurring ? 'monthly' : 'once'}.`, { tone: recurring ? 'success' : '' }),
                    st('Service', size.serviceLabel ?? '—', 'Which line of business this deal sells'),
                ),
                priced && recurring && hh('div.note-box', { style: { marginBlockStart: 'var(--space-3)' } },
                    `${mm(size.price, size.currency)} a month${size.termMonths ? ` over ${size.termMonths} months is ${mm(size.price * size.termMonths, size.currency)} in total.` : ' — reports assume a 12-month term until a contract states one, and say so.'}`),
                priced && hh('div.note-box', { style: { marginBlockStart: 'var(--space-3)' } },
                    'One-time and recurring revenue are reported separately, because adding them produces a number that means nothing. In '
                    + `${totals.currency}: ${mm(totals.value_one_time)} one-time, ${mm(totals.value_mrr)}/mo recurring.`),
                !priced && hh('div.note-box.warning', { style: { marginBlockStart: 'var(--space-3)' } },
                    'This deal has no price yet, so it contributes nothing to the forecast. An unpriced deal is not a deal worth nothing — it is one nobody has quoted.'),
                agreements?.length > 0 && hh('div', { style: { marginBlockStart: 'var(--space-4)' } },
                    hh('h3.small.dim', 'Agreements'),
                    hh('div.table-wrap', hh('table.data',
                        hh('thead', hh('tr', hh('th', 'Number'), hh('th', 'Status'), hh('th.num', 'Contract value'), hh('th', 'Term'))),
                        hh('tbody', agreements.map((a) => hh('tr',
                            hh('td', hh('a', { href: `/agreements/${a.id}` }, a.number)),
                            hh('td', hh('span.badge', { class: { signed: 'success', terminated: 'danger', expired: 'danger', rejected: 'danger', approved: 'accent' }[a.status] ?? '' }, a.status)),
                            hh('td.num', Number(a.contract_value) > 0 ? mm(a.contract_value, a.currency || size.currency) : hh('span.dim', '—')),
                            hh('td.small.dim', a.effective_date ? `${dd(a.effective_date)}${a.expiry_date ? ` → ${dd(a.expiry_date)}` : ''}` : '—'),
                        ))),
                    )),
                ),
            ),
        );
    };
}

export function makePriceHistoryCard(env) {
    const { h: hh, money: mm, date: dd, relative: rel, humanise: hum } = env;
    return function priceHistoryCardInner(extras) {
        const schedule = extras?.size?.schedule ?? [];
        const periods = extras?.size?.periods ?? [];
        const pending = schedule.filter((row) => row.status === 'pending_approval');
        const settled = schedule.filter((row) => row.status !== 'pending_approval');
        if (!schedule.length && !periods.length) return null;
        // Keep the original card's structure: quarters + history table when needed
        return hh('div.card',
            hh('div.card-header', hh('h2', 'Price history')),
            hh('div.card-body',
                pending.length ? hh('div.note-box.warning', `Price change pending approval — ${pending.length} period(s) awaiting review.`) : null,
                settled.length ? hh('div.table-wrap', hh('table.data',
                    hh('thead', hh('tr', hh('th', 'From'), hh('th', 'Price'), hh('th', 'Status'))),
                    hh('tbody', settled.map((p) => hh('tr',
                        hh('td', dd(p.effective_from ?? p.effectiveFrom)),
                        hh('td.num', mm(p.price ?? p.unit_amount, p.currency)),
                        hh('td', hh('span.badge', hum(p.status))),
                    ))),
                )) : hh('p.xs.dim', 'No price history yet.'),
                periods.length > 1 ? hh('div.note-box', { style: { marginBlockStart: 'var(--space-3)' } }, 'Quarters reflect the current price schedule.') : null,
            ),
        );
    };
}

/** "3d 4h", "2h", "under an hour" — the resolution a stage duration is worth reading at. */
function formatDuration(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ''}`;
    if (hours > 0) return `${hours}h`;
    const minutes = Math.floor(seconds / 60);
    return minutes > 0 ? `${minutes}m` : 'under a minute';
}

/**
 * How long this deal sat in each stage it has visited — from
 * `deal_stage_history`, written by every path a deal's stage changes on
 * (see moveDealToStage and followStage in lib/repo.mjs). The row with no
 * `exitedAt` is where the deal is right now, timed against the moment the
 * page loaded rather than a stored end date it does not have yet.
 */
export function makeStageHistoryCard(env) {
    const { h: hh, date: dd } = env;
    return function stageHistoryCardInner(extras) {
        const history = extras?.stageHistory?.history ?? [];
        if (!history.length) return null;
        return hh('div.card',
            hh('div.card-header', hh('h2', 'Time in stage')),
            hh('div.card-body.flush', hh('div.table-wrap', hh('table.data',
                hh('thead', hh('tr', hh('th', 'Stage'), hh('th', 'Entered'), hh('th', 'Left'), hh('th.num', 'Time there'))),
                hh('tbody', [...history].reverse().map((row) => hh('tr',
                    hh('td', row.stage_label ?? row.stage_key ?? '—'),
                    hh('td', dd(row.entered_at, { withTime: true })),
                    hh('td', row.current ? hh('span.badge.info', 'Current') : dd(row.exitedAt, { withTime: true })),
                    hh('td.num', formatDuration(row.seconds)),
                ))),
            ))),
        );
    };
}

export function makeEmailHealthCard(env) {
    const { h: hh, humanise: hum, relative: rel, date: dd, store: stt } = env;
    function classifyStatus(status) {
        const described = stt.verificationStatus(status);
        if (described) return described.classification;
        if (['verified', 'deliverable'].includes(status)) return 'safe';
        if (['invalid', 'disposable', 'do_not_email'].includes(status)) return 'blocked';
        return 'review';
    }
    return function emailHealthCardInner(record, extras, verifyContactEmail) {
        const tone = { safe: 'success', blocked: 'danger', review: 'warning' };
        const status = record.verification_status;
        const described = status ? stt.verificationStatus(status) : null;
        const health = extras.verificationHistory;
        return hh('div.card',
            hh('div.card-header', hh('h3', 'Email health')),
            hh('div.card-body', hh('div.stack.tight',
                hh('div.row', { style: { alignItems: 'center', gap: 'var(--space-2)' } },
                    hh('span.small.truncate', { dir: 'auto' }, record.email || hh('span.dim', 'No email address')),
                ),
                status
                    ? hh('div.stack.tight',
                        hh('div.row', { style: { gap: 'var(--space-2)', alignItems: 'center' } },
                            hh('span.badge', { class: tone[classifyStatus(status)] ?? '' }, described?.label ?? hum(status)),
                            hh('span.xs.dim', classifyStatus(status) === 'safe' ? 'Safe to send' : 'Not safe to send'),
                        ),
                        described?.help && hh('p.xs.dim', described.help),
                        record.verified_at && hh('div.xs.dim',
                            `Checked ${rel(record.verified_at)}`,
                            record.verification_provider ? ` · ${record.verification_provider}` : '',
                            record.verification_confidence !== null && record.verification_confidence !== undefined ? ` · confidence ${Math.round(record.verification_confidence * 100)}%` : '',
                        ),
                    )
                    : hh('p.xs.dim', 'Never checked. That is not the same as bad — nobody has asked yet.'),
                record.email && (() => {
                    const btn = hh('button.btn.sm', {
                        onclick: async () => {
                            if (btn.disabled) return;
                            btn.disabled = true;
                            btn.textContent = 'Verifying…';
                            try { await verifyContactEmail(); }
                            finally { btn.disabled = false; btn.textContent = status ? 'Re-verify' : 'Verify now'; }
                        },
                    }, status ? 'Re-verify' : 'Verify now');
                    return btn;
                })(),
                health?.entries?.length > 1 && hh('details',
                    hh('summary.xs.dim', `History (${health.entries.length})`),
                    hh('div.stack.tight', { style: { marginBlockStart: 'var(--space-2)' } },
                        health.entries.map((e) => hh('div.row.between',
                            hh('span.xs', { title: e.help ?? '' }, e.label ?? hum(e.status)),
                            hh('span.xs.dim', `${rel(e.checkedAt)} · ${e.provider}`),
                        )),
                    ),
                ),
            )),
        );
    };
}

export function makeKeyFactsCard(env) {
    const { h: hh, store: stt, cellContent } = env;
    return function keyFactsCardInner(record, objectKey, def) {
        const covered = new Set((env.COVERED_BY_CARD?.[objectKey] ?? []));
        const defs = stt.fields(objectKey).filter((f) => f.listDefault && f.key !== def.titleField && !covered.has(f.key));
        if (!defs.length) return null;
        return hh('div.card',
            hh('div.card-header', hh('h2', 'Key facts')),
            hh('div.card-body', hh('dl.detail-list', defs.flatMap((fieldDef) => [hh('dt', fieldDef.label), hh('dd', cellContent(objectKey, fieldDef, record))]))),
        );
    };
}

export function makeDetailsCard(env) {
    const { h: hh, store: stt, cellContent, icon } = env;
    return function detailsCardInner(record, objectKey, def, data, editDetails) {
        const inKeyFacts = new Set(stt.fields(objectKey).filter((f) => f.listDefault && f.key !== def.titleField).map((f) => f.key));
        const hideForInternal = objectKey === 'proposal' && record.type === 'internal_team' ? new Set(['currency']) : new Set();
        /**
         * A full name built FROM first and last is the same fact told twice —
         * Details listed "Full name", "First name" and "Last name" as three
         * separate rows all naming the one person. Full name stays: editing
         * it is the only way to rename a contact (nothing else on the page
         * offers that), and saving it reconciles first/last automatically
         * (see `nameFields` in lib/repo.mjs) — so dropping the two derived
         * parts loses no information and no editing ability. Matches the
         * reasoning the list view already applies to the same pair (see the
         * contact object's own field comments).
         */
        const nameParts = ['contact', 'prospecting_contact'].includes(objectKey) ? new Set(['first_name', 'last_name']) : new Set();
        const rest = stt.fields(objectKey).filter((f) => f.form !== false && !f.computed
            && !inKeyFacts.has(f.key) && !hideForInternal.has(f.key) && !nameParts.has(f.key));
        const editable = stt.can('record.write.all') || stt.can('record.write.own');
        const leafEditOwnedByHeader = ['task', 'note', 'activity'].includes(objectKey);
        return hh('div.card',
            hh('div.card-header', hh('h2', 'Details'), editable && !leafEditOwnedByHeader && hh('div.actions', hh('button.btn.sm', { onclick: () => editDetails() }, hh('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' } }, icon('edit'), 'Edit')))),
            hh('div.card-body', rest.length === 0 ? hh('p.xs.dim', 'Everything on this record is shown above.') : hh('dl.detail-list', rest.flatMap((fieldDef) => [hh('dt', fieldDef.label), hh('dd', cellContent(objectKey, fieldDef, record))]))),
        );
    };
}
