/**
 * The qualification module's own screen: the rules, their history, the impact
 * preview before publishing a change, and the REVIEW queue.
 *
 * The impact preview is the reason this page exists in this shape. Changing the
 * HCM headcount band once moved 117 of 223 verdicts, three of them out of
 * QUALIFIED, and nothing recorded it. Here the change is simulated against
 * stored evidence and the damage is named before anything is written.
 */
import { h, mount, toast, modal, confirm, number, date, relative, humanise, setParams } from '../core.js';
import { api } from '../api.js';
import * as store from '../store.js';
import { verdictBadge, verdictBar, emptyState, skeletonRows, statTile, pager, errorState,} from '../components.js';
import { setPageTitle } from '../app.js';
import { showQualificationResult } from './list.js';

export async function qualificationPage(content, { tab } = {}) {
    setPageTitle('Qualification');
    const container = h('div.content-inner');
    mount(content, container);

    let data = await api.get('/api/qualification/rules');
    let activeRule = data.rules[0]?.key ?? null;
    let queue = null;
    let uploader = null;
    /**
     * A failed load, HELD rather than toasted.
     *
     * Both loaders run from a tab click rather than from the route, so a
     * rejection is unhandled and the screen keeps its skeleton. A toast fades
     * and leaves that skeleton looking like a queue still loading — which is
     * the same mistake the calling queue made and fixed.
     */
    let loadError = null;
    let activeTab = tab ?? 'uploader';

    /**
     * The uploaded list, held in the browser between inspect and qualify.
     *
     * Same reason the importer does it: the server stays stateless, a refresh
     * cannot strand a half-configured run, and the bytes that were inspected
     * are demonstrably the bytes that get qualified.
     */
    const upload = {
        filename: null,
        text: null,
        inspection: null,
        columnIndex: null,
        selector: 'hcm',
        result: null,
        busy: false,
    };

    const TABS = [
        { key: 'uploader', label: 'Upload & qualify' },
        { key: 'rules', label: 'Rules' },
        { key: 'review', label: 'Review queue' },
    ];

    let queuePage = 1;

    /**
     * Both of these are called from a click, not from the route, so a rejection
     * would be unhandled and the screen would keep the skeleton it was showing.
     * The error is HELD rather than toasted: a toast fades, and what is left
     * behind it looks exactly like a queue that is still loading.
     */
    async function loadQueue(ruleKey, page = 1) {
        queuePage = page;
        try {
            queue = await api.get(`/api/qualification/review-queue?rule=${ruleKey}&page=${page}`);
            loadError = null;
        } catch (err) {
            loadError = err.message;
        }
        paint();
    }

    async function loadUploader() {
        try {
            uploader = await api.get('/api/qualification/uploader');
            loadError = null;
        } catch (err) {
            loadError = err.message;
        }
        paint();
    }

    function paint() {
        mount(container,
            h('div.tabs', TABS.map((t) => h('button.tab', {
                class: t.key === activeTab ? 'active' : '',
                onclick: () => {
                    activeTab = t.key;
                    setParams({ tab: t.key === 'uploader' ? null : t.key });
                    paint();
                    if (t.key === 'uploader' && !uploader) loadUploader();
                    if (t.key === 'review' && !queue && activeRule) loadQueue(activeRule);
                },
            }, t.label))),
            loadError
                ? errorState(loadError, () => {
                    loadError = null;
                    paint();
                    if (activeTab === 'uploader') loadUploader();
                    else if (activeTab === 'review' && activeRule) loadQueue(activeRule);
                })
                : [
                    activeTab === 'uploader' ? uploaderTab() : null,
                    activeTab === 'rules' ? rulesTab() : null,
                    activeTab === 'review' ? reviewTab() : null,
                ],
        );
    }

    /* ---- upload and qualify, in the CRM -------------------------------- */

    /**
     * Upload a lead list, apply the rules, download the qualified rows.
     *
     * This used to be an iframe onto `local-scraper/server.mjs`, which meant it
     * only worked on a laptop — that program's qualify step is welded to a
     * collect step that drives a signed-in Chrome, so the hosted CRM could only
     * offer an instruction to go and use a different computer.
     *
     * It runs here now. The rules are the same modules, read from the same
     * folder as always; what changed is where the EVIDENCE comes from — the
     * shared database rather than one machine's snapshots.json. Collecting a
     * company nobody has collected still needs the browser, and that is the
     * only thing the card at the bottom is about.
     */
    function uploaderTab() {
        if (!uploader) return skeletonRows(4);

        return [
            uploadCard(),
            upload.inspection && !upload.result ? configureCard() : null,
            upload.result ? resultCard() : null,
            collectorCard(),
        ];
    }

    function uploadCard() {
        const fileInput = h('input', {
            type: 'file', accept: '.csv,text/csv,text/plain',
            onchange: (e) => readFile(e.target.files[0]),
        });

        const dropZone = h('div.dropzone', {
            ondragover: (e) => { e.preventDefault(); dropZone.classList.add('over'); },
            ondragleave: () => dropZone.classList.remove('over'),
            ondrop: (e) => {
                e.preventDefault();
                dropZone.classList.remove('over');
                const file = e.dataTransfer.files?.[0];
                if (file) readFile(file);
            },
            onclick: () => fileInput.click(),
        },
        h('div.strong', upload.filename ? `${upload.filename} — choose another` : 'Drop a lead list here'),
        h('p.small.muted', 'or click to choose one. Any CSV with a LinkedIn company-URL column; every other column '
            + 'is carried through to the download untouched.'),
        fileInput,
        );

        return h('div.card',
            h('div.card-header',
                h('h2', 'Upload & qualify'),
                h('div.actions',
                    h('span.xs.dim', `${number(uploader.collected ?? 0)} companies collected and ready to qualify`),
                ),
            ),
            h('div.card-body',
                h('div.note-box',
                    h('div.strong', 'This runs here, against the evidence already in this database'),
                    h('p.small',
                        'The rules are applied on the server to evidence that has already been collected — no browser, '
                        + 'nothing to start, and the same rule versions the rest of the CRM uses. A company nobody has '
                        + 'collected yet cannot be judged and is reported as unjudged, never as rejected.'),
                    h('p.xs.dim', { style: { marginBlockStart: 'var(--space-1)' } },
                        'Nothing is written. This filters a spreadsheet; it does not record a verdict against any '
                        + 'record. To do that, qualify the company on its own page.'),
                ),
                upload.busy ? skeletonRows(3) : dropZone,
            ),
        );
    }

    /* ---- 2. pick the column and the rule -------------------------------- */

    function configureCard() {
        const info = upload.inspection;

        return h('div.card',
            h('div.card-header',
                h('h2', 'What is in this file'),
                h('div.actions', h('span.xs.dim', upload.filename)),
            ),
            h('div.card-body.stack',
                h('div.totals-grid',
                    h('div.total-cell', statTile('Rows', number(info.rowCount))),
                    h('div.total-cell', statTile('Companies', number(info.companies ?? 0), 'unique LinkedIn slugs')),
                    h('div.total-cell', statTile('Can be judged', number(info.collected ?? 0), 'evidence is already stored')),
                    h('div.total-cell', statTile('No evidence', number(info.missing ?? 0), 'never collected')),
                ),

                /**
                 * The uncollected count, stated before the button rather than
                 * discovered after it. On the hosted CRM these companies cannot
                 * be collected at all, so a mostly-uncollected file is a file to
                 * take to a laptop — and that is worth knowing now.
                 */
                info.missing > 0 && h('div.note-box',
                    h('div.strong', `${number(info.missing)} of these companies have never been collected`),
                    h('p.small',
                        'The rules have nothing to read for them, so they cannot be judged and will not appear in the '
                        + 'download. They are counted as unjudged, not rejected — absence of evidence is not a "no".'),
                    h('p.xs.dim', { style: { marginBlockStart: 'var(--space-1)' } },
                        'Collecting them opens a signed-in Chrome, so it runs on a computer with that browser profile. '
                        + 'See the card below.'),
                ),

                h('div.field',
                    h('label', 'Which column holds the LinkedIn company URL'),
                    h('select.input', {
                        onchange: async (e) => {
                            upload.columnIndex = Number(e.target.value);
                            await inspect();
                        },
                    }, info.columns.map((c) => h('option', {
                        value: c.index,
                        selected: c.index === upload.columnIndex,
                    }, `${c.name} — ${number(c.companies)} compan${c.companies === 1 ? 'y' : 'ies'}`))),
                    h('span.help', 'Detected from the values, not the header name: lead lists call this column a '
                        + 'dozen different things but they all hold the same recognisable URL.'),
                ),

                h('div.field',
                    h('label', 'Keep the rows for companies that are'),
                    h('select.input', {
                        onchange: (e) => { upload.selector = e.target.value; },
                    }, Object.entries(info.selectors ?? {}).map(([key, label]) => h('option', {
                        value: key, selected: key === upload.selector,
                    }, label))),
                    h('span.help', 'REVIEW is never treated as qualified. It means the evidence could not answer the '
                        + 'question, and shipping those rows as leads is the mistake the three-verdict model exists '
                        + 'to prevent — they are waiting for you in the review queue instead.'),
                ),

                h('div.row',
                    store.can('qualification.run')
                        ? h('button.btn.primary', { onclick: qualify }, 'Qualify this list')
                        : h('p.small.dim', 'You do not have permission to run qualification.'),
                    h('button.btn.ghost', {
                        onclick: () => {
                            Object.assign(upload, { filename: null, text: null, inspection: null, columnIndex: null, result: null });
                            paint();
                        },
                    }, 'Start over'),
                ),
            ),
        );
    }

    /* ---- 3. the answer -------------------------------------------------- */

    function resultCard() {
        const { stats, tally, companies } = upload.result;
        const rules = data.rules.filter((r) => tally[r.key]);

        return h('div.card',
            h('div.card-header',
                h('h2', 'Qualified'),
                h('div.actions',
                    h('button.btn.sm.primary', {
                        onclick: () => saveCsv(upload.result.csv, upload.result.filename),
                    }, 'Download the qualified rows'),
                    h('button.btn.sm.ghost', {
                        onclick: () => saveCsv(upload.result.reportCsv, upload.result.reportFilename),
                    }, 'Download the full report'),
                ),
            ),
            h('div.card-body.stack',
                h('div.totals-grid',
                    h('div.total-cell', statTile('Rows kept', number(stats.outputRows), `of ${number(stats.inputRows)} uploaded`)),
                    h('div.total-cell', statTile('Companies qualified', number(stats.companiesQualified), `of ${number(stats.companies)}`)),
                    h('div.total-cell', statTile('Could not be judged', number(stats.companiesNotCollected), 'no evidence collected')),
                    h('div.total-cell', statTile('Rows with no URL', number(stats.rowsWithoutUrl))),
                ),

                h('p.small', upload.result.note),

                rules.map((rule) => h('div.stack.tight',
                    h('div.row',
                        h('span.strong.small', rule.label),
                        h('span.xs.dim', `rule v${upload.result.ruleVersions[rule.key] ?? rule.version}`),
                    ),
                    verdictBar(Object.entries(tally[rule.key])
                        .map(([verdict, count]) => ({ verdict, count }))),
                )),

                companies.length > 0 && h('details',
                    h('summary.small', `Every company in the file (${number(companies.length)}`
                        + `${upload.result.companiesTruncated ? ' shown; the full list is in the report CSV' : ''})`),
                    h('div.table-wrap', { style: { marginBlockStart: 'var(--space-2)' } },
                        h('table.table',
                            h('thead', h('tr',
                                h('th', 'Company'),
                                rules.map((rule) => h('th', rule.label)),
                                h('th', 'Headcount'),
                            )),
                            h('tbody', companies.map((c) => h('tr',
                                h('td', c.collected === false
                                    ? h('span.dim', c.name)
                                    : c.name),
                                // The reason lines hang off the cell, so the
                                // answer can always be checked against the
                                // arithmetic that produced it without leaving
                                // the page.
                                rules.map((rule) => h('td', {
                                    title: (c.verdicts?.[rule.key]?.reasons ?? []).join('\n'),
                                }, verdictBadge(c.verdicts?.[rule.key]?.verdict, { rule: rule.key }))),
                                h('td.num', c.headcount ?? ''),
                            ))),
                        ),
                    ),
                ),

                h('p.xs.dim', upload.result.writesNote),

                h('div.row',
                    h('button.btn.ghost', {
                        onclick: () => { upload.result = null; paint(); },
                    }, 'Change the column or the rule'),
                    h('button.btn.ghost', {
                        onclick: () => {
                            Object.assign(upload, { filename: null, text: null, inspection: null, columnIndex: null, result: null });
                            paint();
                        },
                    }, 'Qualify another list'),
                ),
            ),
        );
    }

    /* ---- the collector, which still needs a browser --------------------- */

    /**
     * Collection is the part that genuinely cannot move to the server: it
     * drives a real Chrome through a signed-in LinkedIn profile, and that
     * profile is a live login nobody should deploy. So this card is about ONE
     * thing — getting evidence for companies nobody has collected — rather than
     * standing between the user and qualifying the ones already collected.
     */
    function collectorCard() {
        if (!uploader.installed && uploader.remote) {
            return h('div.card',
                h('div.card-header', h('h3', 'Collecting new companies')),
                h('div.card-body',
                    h('div.note-box',
                        h('div.strong', 'Collecting runs on your computer, not here'),
                        h('p.small',
                            'Fetching a company nobody has collected opens Chrome and signs in to LinkedIn, so it '
                            + 'needs a machine with that browser profile. This CRM has neither, and deploying a '
                            + 'signed-in profile to a server is not something to fix.'),
                        h('p.small',
                            'Run it on your computer — it writes to this same database, so everything it collects '
                            + 'becomes qualifiable here for everyone:'),
                        h('p', h('code.small', 'npm run collect')),
                        h('p.xs.dim',
                            'Qualifying a list does not need any of that, and works on this page as it is.'),
                    ),
                ),
            );
        }

        if (!uploader.installed) {
            return h('div.card',
                h('div.card-header', h('h3', 'Collecting new companies')),
                h('div.card-body',
                    h('div.note-box.danger',
                        h('div.strong', 'The collector was not found'),
                        h('p.small', `Looked in ${uploader.directory}. The CRM runs it from the local-scraper project `
                            + 'rather than copying it, so the two can never disagree. Set QUALIFIER_DIR if that folder '
                            + 'has moved. Qualifying already-collected companies does not need it.'),
                    ),
                ),
            );
        }

        return h('div.card',
            h('div.card-header',
                h('h3', 'Collecting new companies'),
                h('div.actions',
                    h('span.badge', { class: uploader.running ? 'success' : 'warning' },
                        uploader.running ? 'Running' : 'Not running'),
                    !uploader.running && store.can('qualification.run') && h('button.btn.sm', {
                        onclick: async (e) => {
                            const button = e.currentTarget;
                            button.disabled = true;
                            button.textContent = 'Starting…';
                            try {
                                await api.post('/api/qualification/uploader/start', {});
                                toast('Collector started.', 'success');
                            } catch (err) {
                                toast(err.message, 'error');
                            }
                            loadUploader();
                        },
                    }, 'Start it'),
                    uploader.running && h('a.btn.sm.ghost', {
                        href: '/qualifier', target: '_blank', rel: 'noreferrer',
                    }, 'Open it ↗'),
                ),
            ),
            h('div.card-body',
                h('p.small', 'A company with no stored evidence cannot be judged. Collecting one opens a Chrome '
                    + 'window and may ask you to sign in to LinkedIn — which is why it is a separate local process, '
                    + 'the same one "npm run ui" starts in the local-scraper folder.'),
                h('p.xs.dim', { style: { marginBlockStart: 'var(--space-1)' } },
                    `It writes to ${uploader.snapshotsFile}`
                    + `${uploader.snapshots !== null ? ` (${number(uploader.snapshots)} companies)` : ''}`
                    + '. Import them with import-snapshots.mjs to make them qualifiable here.'),
            ),
        );
    }

    /* ---- the work ------------------------------------------------------- */

    function readFile(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            upload.filename = file.name;
            upload.text = String(reader.result);
            upload.result = null;
            upload.columnIndex = null;
            inspect();
        };
        reader.onerror = () => toast('That file could not be read.', 'error');
        // UTF-8. A BOM is stripped by the parser, which builds it from its code
        // point rather than carrying an invisible character in source.
        reader.readAsText(file, 'utf-8');
    }

    /**
     * Re-run on every column change, so the counts always describe the column
     * that is actually selected. Choosing the wrong column is the one mistake
     * this page invites, and "0 of 2,000 can be judged" is what makes it
     * obvious — but only if the numbers follow the picker.
     */
    async function inspect() {
        upload.busy = true;
        paint();
        try {
            const column = upload.columnIndex === null ? '' : `?column=${upload.columnIndex}`;
            upload.inspection = await api.postText(`/api/qualification/list/inspect${column}`, upload.text);
            if (upload.columnIndex === null) upload.columnIndex = upload.inspection.detectedColumn;
            if (upload.columnIndex < 0) {
                toast('No LinkedIn company-URL column was detected. Pick the one with the company links.', 'error');
                upload.columnIndex = 0;
            }
        } catch (err) {
            toast(err.message, 'error');
            upload.inspection = null;
        }
        upload.busy = false;
        paint();
    }

    async function qualify() {
        upload.busy = true;
        paint();
        try {
            upload.result = await api.post('/api/qualification/list/qualify', {
                text: upload.text,
                columnIndex: upload.columnIndex,
                selector: upload.selector,
                filename: upload.filename,
            });
        } catch (err) {
            toast(err.message, 'error');
        }
        upload.busy = false;
        paint();
    }

    /**
     * Saves a CSV the server already built, without a second round trip.
     *
     * The filtered list came back with the counts it is derived from, so
     * re-requesting it to download would be asking the same question twice and
     * would need the server to hold the answer in the meantime.
     */
    function saveCsv(text, filename) {
        const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
        const link = h('a', { href: url, download: filename, style: { display: 'none' } });
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    }

    function rulesTab() {
        return h('div.card',
            h('div.card-header',
                h('h2', 'Rules'),
                h('div.actions', h('span.xs.dim', `Engine: ${data.engineSource}`)),
            ),
            h('div.card-body',
                h('div.stack',
                    data.rules.map((rule) => ruleCard(rule)),
                ),
            ),
        );
    }

    function reviewTab() {
        return h('div.card',
            h('div.card-header',
                h('h2', 'Review queue'),
                h('div.actions',
                    h('select.input', {
                        style: { inlineSize: 'auto' },
                        onchange: (e) => { activeRule = e.target.value; loadQueue(activeRule, 1); },
                    }, data.rules.map((r) => h('option', { value: r.key, selected: r.key === activeRule }, r.label))),
                ),
            ),
            h('div.card-body',
                h('div.note-box',
                    'REVIEW means the evidence could not answer the question — not that the answer was no. '
                    + 'LinkedIn lists only the top few rows of each panel, so "not listed" means "not in the top five". '
                    + 'These are leads still to be checked, ordered so the most promising comes first. '
                    + 'Check the company on LinkedIn, then record what you found with Decide.'),
            ),
            h('div.card-body.flush', queue ? reviewQueue() : skeletonRows(4)),
        );
    }

    function ruleCard(rule) {
        const tally = data.tally[rule.key] ?? {};
        const buckets = ['QUALIFIED', 'REVIEW', 'REJECTED', 'UNRESOLVED', 'ERROR']
            .map((v) => ({ verdict: v, count: tally[v] ?? 0 }));

        return h('div.stack.tight', { style: { paddingBlockEnd: 'var(--space-4)', borderBlockEnd: '1px solid var(--color-border-subtle)' } },
            h('div.row.between',
                h('div',
                    h('div.strong', rule.label, h('span.dim.xs', ` v${rule.version}`)),
                    h('code.xs.dim', rule.summary),
                ),
                h('div.row',
                    h('button.btn.sm', { onclick: () => showHistory(rule) }, `History (${rule.history.length})`),
                    store.can('qualification.run') && h('button.btn.sm.primary', { onclick: () => editRule(rule) }, 'Edit thresholds'),
                ),
            ),

            verdictBar(buckets),

            h('div.note-box',
                h('strong', rule.claimType === 'absence' ? 'Absence test' : 'Presence test'),
                ' — ', rule.explanation,
                h('div.xs.dim', { style: { marginBlockStart: 'var(--space-1)' } },
                    `Coverage gates the ${rule.coverageGates}.`),
            ),
        );
    }

    function reviewQueue() {
        if (!queue.items.length) {
            return emptyState('Nothing in review', 'Every account this rule has seen produced a definitive answer.');
        }
        return h('div.stack', h('div.table-wrap', h('table.data',
            h('thead', h('tr',
                h('th', 'Account'), h('th.num', 'Employees'), h('th', 'Industry'),
                h('th.num', 'Unaccounted'), h('th.num', 'Egypt alumni'), h('th', 'What is missing'), h('th', ''),
            )),
            h('tbody', queue.items.map((item) => h('tr',
                h('td', h('a.cell-link', { href: `/accounts/${item.accountId}` }, item.name)),
                h('td.num', number(item.employeeCount)),
                h('td.small', item.industry ?? h('span.dim', '—')),
                h('td.num', { title: 'Headcount the listed panels do not explain — the bigger this is, the more a manual check can change' },
                    item.unaccounted ? number(item.unaccounted) : h('span.dim', '—')),
                h('td.num', { title: 'Employees who studied at Egyptian institutions — talent-pipeline evidence, never counted as location' },
                    item.affinity ? number(item.affinity) : h('span.dim', '—')),
                h('td.xs.muted', { style: { maxInlineSize: '24rem' } }, item.notes[0] ?? '—'),
                h('td', h('div.row',
                    item.linkedinSlug && h('a.btn.sm.ghost', {
                        href: `https://www.linkedin.com/company/${item.linkedinSlug}/people/`,
                        target: '_blank', rel: 'noreferrer noopener',
                        title: item.nextStep,
                    }, 'Check ↗'),
                    store.can('qualification.run') && h('button.btn.sm', {
                        title: 'Record what you found. It is appended as a new verdict — the engine\'s answer stays in the history.',
                        onclick: () => decide(item),
                    }, 'Decide'),
                )),
            ))))),
            pager({
                page: queue.page, pages: queue.pages, total: queue.total, limit: queue.limit, unit: 'account',
                onPage: (p) => loadQueue(activeRule, p),
            }),
        );
    }

    /**
     * Settling a REVIEW by hand.
     *
     * The reason is required and the dialog says why: this verdict will be read
     * months later by someone deciding whether to trust it, and "a person set
     * this" without "because I counted 4 people in Cairo on the People tab" is
     * not enough to act on.
     */
    async function decide(item) {
        const reason = h('textarea.input', {
            dir: 'auto', rows: 3,
            placeholder: 'e.g. Filtered the People tab by Egypt — 6 employees listed, well past the threshold of 2.',
        });
        const errorBox = h('div.error');
        let chosen = null;

        const result = await modal({
            title: `Decide — ${item.name}`,
            size: 'wide',
            body: (close) => h('div.stack',
                errorBox,
                h('div.note-box',
                    h('div.strong', `The ${activeRule.toUpperCase()} rule returned REVIEW`),
                    h('p.small', item.notes[0] ?? 'The evidence could not settle it.'),
                    item.linkedinSlug && h('p.small',
                        h('a', {
                            href: `https://www.linkedin.com/company/${item.linkedinSlug}/people/`,
                            target: '_blank', rel: 'noreferrer noopener',
                        }, 'Open the People tab on LinkedIn ↗'), ' — ', item.nextStep),
                ),
                h('div.field',
                    h('label', 'What did you find?', h('span.required', '*')),
                    reason,
                    h('span.help', 'Required. This is recorded on the verdict and on the account timeline.'),
                ),
                h('div.row',
                    ['QUALIFIED', 'REVIEW', 'REJECTED'].map((v) => h('button.btn', {
                        onclick: () => { chosen = v; close({ verdict: v }); },
                    }, verdictBadge(v, { legend: true }))),
                ),
                h('p.xs.dim',
                    'Appended as a new verdict, attributed to you. The rule\'s own answer stays in this account\'s '
                    + 'history, and re-running the rule later supersedes your decision with a fresh computed one.'),
            ),
            footer: (close) => h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
        });

        if (!result) return;
        try {
            const outcome = await api.post(`/api/accounts/${item.accountId}/decision`, {
                rule: activeRule,
                verdict: result.verdict,
                reason: reason.value,
            });
            toast(`${item.name}: ${outcome.previous ?? 'no verdict'} → ${outcome.verdict}.`, 'success');
            await loadQueue(activeRule);
        } catch (err) {
            toast(err.message, 'error');
            // The reason survives the failure — retyping it is the fastest way
            // to make someone stop recording reasons.
            await decide(item);
        }
    }

    /* ---- editing a rule ---------------------------------------------- */

    async function editRule(rule) {
        const draft = { ...rule.config };
        const previewBox = h('div');
        const errorBox = h('div.error');

        const numberField = (key, label, help, { allowNull = false } = {}) => h('div.field',
            h('label', label),
            h('input.input', {
                type: 'number',
                value: draft[key] ?? '',
                oninput: (e) => {
                    draft[key] = e.target.value === '' ? (allowNull ? null : '') : Number(e.target.value);
                },
            }),
            help && h('span.help', help),
        );

        const fields = rule.key === 'hcm'
            ? [
                numberField('minHeadcount', 'Minimum headcount', 'Inclusive: headcount ≥ this.'),
                numberField('maxHeadcount', 'Maximum headcount', 'Inclusive ceiling. Leave empty to remove it — but note that over-ceiling is a definitive rejection, not a REVIEW.', { allowNull: true }),
                numberField('maxHrCount', 'Maximum HR employees', 'The gap being looked for. HR count is the MAX across signals, never the sum — the 87 people in the HR function and the 48 with HR skills are largely the same people.'),
                numberField('minCoverage', 'Minimum coverage', 'Between 0 and 1. This gates the QUALIFY, because finding no HR proves nothing unless the panels covered everyone.'),
            ]
            : [
                /**
                 * The ONLY field the engine reads — `local-scraper/lib/
                 * offshoring.js` has only ever checked `config.minEgyptCount`.
                 * This form used to show Minimum headcount / Minimum
                 * employees in country / Country, none of which the engine
                 * looks at: editing them here changed nothing about how any
                 * account was actually qualified. Fixed at the source
                 * (`summariseConfig`, `validateRuleConfig` in lib/
                 * qualification.mjs) as well as here.
                 */
                numberField('minEgyptCount', 'Minimum Egypt-based employees', 'Inclusive: Egypt headcount ≥ this qualifies.'),
                numberField('minCoverage', 'Minimum coverage', 'Between 0 and 1. This gates the REJECT, because observing the required count proves it at any coverage.'),
            ];

        const runPreview = async () => {
            mount(previewBox, h('div.row', h('div.spinner'), h('span.small', 'Simulating against stored evidence…')));
            try {
                const impact = await api.post(`/api/qualification/rules/${rule.key}/preview`, { config: draft });
                mount(previewBox, impactView(impact));
                errorBox.textContent = '';
                return impact;
            } catch (err) {
                errorBox.textContent = err.message;
                mount(previewBox);
                return null;
            }
        };

        const saved = await modal({
            title: `${rule.label} — thresholds`,
            size: 'wide',
            body: h('div.stack',
                errorBox,
                h('div.note-box',
                    'Publishing creates a NEW rule version. Existing verdicts keep pointing at the version that produced '
                    + 'them, so every account can still answer "why did this change?".'),
                h('div.grid', { style: { gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))' } }, fields),
                h('div.row',
                    h('button.btn', { onclick: runPreview }, 'Preview impact'),
                    h('span.xs.dim', 'Free — it re-runs the rule against stored evidence and writes nothing.'),
                ),
                previewBox,
            ),
            footer: (close) => [
                h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
                h('button.btn.primary', {
                    onclick: async (event) => {
                        const button = event.currentTarget;
                        const impact = await runPreview();
                        if (!impact) return;
                        if (impact.dangerousTotal > 0) {
                            const ok = await confirm({
                                title: 'Publish anyway?',
                                message: `${impact.dangerousTotal} account(s) would stop qualifying`
                                    + `${impact.withOpenDeals ? `, ${impact.withOpenDeals} of them with an open deal` : ''}. `
                                    + 'The old verdicts stay readable, but reps working those accounts will see them change.',
                                confirmLabel: 'Publish', danger: true,
                            });
                            if (!ok) return;
                        }
                        button.disabled = true;
                        try {
                            await api.post(`/api/qualification/rules/${rule.key}/publish`, { config: draft });
                            close(true);
                        } catch (err) {
                            errorBox.textContent = err.message;
                            button.disabled = false;
                        }
                    },
                }, 'Publish new version'),
            ],
        });

        if (!saved) return;
        toast('Published. Re-run the rule to apply it to accounts.', 'success');

        const runNow = await confirm({
            title: 'Re-qualify now?',
            message: 'The new version only affects verdicts once the rule is re-run. Until then, accounts show the '
                + 'verdicts the previous version produced.',
            confirmLabel: 'Re-qualify all accounts',
        });
        if (runNow) {
            const result = await api.post('/api/qualification/run', { all: true, filter: { op: 'and', children: [] } });
            await showQualificationResult(result);
        }
        data = await api.get('/api/qualification/rules');
        await loadQueue(activeRule);
    }

    function impactView(impact) {
        return h('div.stack',
            h('div.grid', { style: { gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))' } },
                h('div.total-cell', statTile('Evaluated', number(impact.evaluated), 'accounts with evidence')),
                h('div.total-cell', statTile('Would change', number(impact.transitions.reduce((a, t) => a + t.count, 0)))),
                h('div.total-cell', statTile('Lose QUALIFIED', number(impact.dangerousTotal), impact.withOpenDeals ? `${impact.withOpenDeals} with open deals` : null)),
            ),

            h('div.stack.tight',
                h('div.strong.small', 'Resulting distribution'),
                verdictBar(['QUALIFIED', 'REVIEW', 'REJECTED', 'ERROR'].map((v) => ({ verdict: v, count: impact.tally[v] ?? 0 }))),
            ),

            impact.transitions.length > 0 && h('div.stack.tight',
                h('div.strong.small', 'Transitions'),
                h('div.row', impact.transitions.map((t) => h('span.chip', `${t.label} · ${t.count}`))),
            ),

            // Named, not counted. "3 accounts will stop qualifying" is a
            // statistic; the names are what someone decides on.
            impact.dangerous.length > 0 && h('div.note-box.warning',
                h('div.strong', 'These accounts would stop qualifying'),
                h('ul', { style: { marginBlockStart: 'var(--space-2)', display: 'grid', gap: 'var(--space-1)' } },
                    impact.dangerous.map((d) => h('li',
                        h('a', { href: `/accounts/${d.accountId}`, target: '_blank' }, d.name),
                        ` — ${d.from} → ${d.to}`,
                        d.hasOpenDeal && h('strong', ' · has an open deal'),
                    )),
                ),
            ),

            h('p.xs.dim', impact.note),
        );
    }

    async function showHistory(rule) {
        await modal({
            title: `${rule.label} — version history`,
            size: 'wide',
            body: h('div.table-wrap', h('table.data',
                h('thead', h('tr', h('th', 'Version'), h('th', 'Rule'), h('th', 'Published'))),
                h('tbody', rule.history.map((v) => h('tr',
                    h('td', `v${v.version}`),
                    h('td', h('code.xs', v.summary)),
                    h('td', { title: date(v.createdAt, { withTime: true }) }, relative(v.createdAt)),
                ))),
            )),
            footer: (close) => h('button.btn.primary', { onclick: () => close(true) }, 'Close'),
        });
    }

    paint();
    await loadUploader();
    if (activeRule) await loadQueue(activeRule);
    return undefined;
}
