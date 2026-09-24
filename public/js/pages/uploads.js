/**
 * Upload History — every upload ever made, and what became of it.
 *
 * ── WHAT THIS PAGE IS FOR ───────────────────────────────────────────────────
 *
 * "What did that upload actually do?" is asked days later, usually by someone
 * who was not the uploader. Before this page the only answer was a terminal
 * scrollback that no longer existed.
 *
 * Two groups of numbers, kept visually apart because they mean different
 * things and age at different rates:
 *
 *   TOTAL RECORDS   what the file contained. Frozen — it is history.
 *   the funnel      where those companies are NOW. Live, and it keeps moving
 *                   as rules re-run, reviews get settled and companies get
 *                   imported.
 *
 * Collapsing the two into one row of numbers is how a stale count ends up
 * being read as a fresh one.
 */
import { h, mount, navigate, toast, confirm, number, date, relative } from '../core.js';
import { api } from '../api.js';
import * as store from '../store.js';
import { emptyState, skeletonRows, statTile, pager, errorState,} from '../components.js';
import { setPageTitle } from '../app.js';

export async function uploadsPage(content) {
    setPageTitle('Upload history');
    const container = h('div.content-inner');
    mount(content, container);
    mount(container, skeletonRows(4));

    let uploads = [];
    let showDeleted = false;
    let page = 1;
    let pages = 1;
    let total = 0;
    const limit = 50;

    async function load() {
        const params = new URLSearchParams({ page: String(page), limit: String(limit) });
        if (showDeleted) params.set('deleted', '1');
        // Reloaded after every delete and restore, so a failure here lands on a
        // screen the user is still looking at.
        let data;
        try {
            data = await api.get(`/api/import/uploads?${params}`);
        } catch (err) {
            mount(container, errorState(err.message, () => load()));
            return;
        }
        uploads = data.uploads;
        total = data.total;
        pages = data.pages;
        page = data.page;
        paint();
    }

    /**
     * A funnel cell.
     *
     * Zero is rendered as a dimmed dash rather than "0". A column of zeroes
     * reads as noise and hides the one number that is not zero, which is the
     * number the reader came for.
     */
    const cell = (value, tone = '') => (value
        ? h(`span.funnel-count${tone ? `.${tone}` : ''}`, number(value))
        : h('span.dim', '—'));

    function paint() {
        if (!uploads.length) {
            mount(container,
                header(),
                emptyState(
                    showDeleted ? 'Nothing in the Recycle Bin' : 'No uploads yet',
                    showDeleted
                        ? 'Deleted uploads appear here with the companies they brought in, and can be restored.'
                        : 'Every upload you make will be listed here with its file name, who uploaded it, and what '
                          + 'became of the companies it contained.',
                    !showDeleted && h('a.btn.primary', { href: '/import' }, 'Upload a list'),
                ),
            );
            return;
        }

        // Totals across every upload on screen, so the page answers the
        // whole-pipeline question without making anyone add up columns.
        const sum = (key) => uploads.reduce((a, u) => a + (u[key] ?? 0), 0);

        mount(container,
            header(),
            h('div.grid', { style: { marginBlockEnd: 'var(--space-4)' } },
                h('div.span-3', statTile('Uploads', number(uploads.length))),
                h('div.span-3', statTile('Companies', number(sum('companies')), 'still in Prospecting')),
                h('div.span-3', statTile('Qualified', number(sum('qualified')), 'for at least one service')),
                h('div.span-3', statTile('Imported', number(sum('imported')), 'now CRM Accounts')),
            ),
            h('div.card',
                h('div.table-wrap',
                    h('table.data',
                        h('thead', h('tr',
                            h('th', 'File'),
                            h('th', 'Uploaded'),
                            h('th', 'By'),
                            h('th.num', 'Total records'),
                            h('th.num', 'Qualified'),
                            h('th.num', 'Review required'),
                            h('th.num', 'Rejected'),
                            h('th.num', 'Imported'),
                            h('th', ''),
                        )),
                        h('tbody', uploads.map(row)),
                    ),
                ),
                pager({
                    page, pages, total, limit, unit: 'upload',
                    onPage: (p) => { page = p; load(); },
                }),
            ),
        );
    }

    function header() {
        return h('div.row', { style: { marginBlockEnd: 'var(--space-4)', alignItems: 'center' } },
            h('div',
                h('h1', { style: { margin: 0, fontSize: 'var(--text-xl)' } }, 'Upload history'),
                h('p.small.dim', { style: { margin: 0 } },
                    'Every upload ever made. Companies stay in Prospecting as historical data — '
                    + 'deleting an upload moves them to the Recycle Bin, it does not erase them.'),
            ),
            h('div.spacer'),
            h('button.btn.sm', {
                class: showDeleted ? 'active' : '',
                onclick: async () => {
                    showDeleted = !showDeleted;
                    page = 1;
                    mount(container, skeletonRows(4));
                    await load();
                },
            }, showDeleted ? '← Back to uploads' : '🗑 Recycle Bin'),
            !showDeleted && h('a.btn.sm.primary', { href: '/import' }, 'Upload a list'),
        );
    }

    function row(u) {
        return h('tr', { class: u.deletedAt ? 'dim' : '' },
            h('td',
                h('div.strong.truncate', u.filename),
                h('div.xs.dim',
                    u.source === 'collector' ? 'From the LinkedIn collector' : `Uploaded file · ${u.source}`,
                    u.contacts > 0 && ` · ${number(u.contacts)} contacts`,
                ),
            ),
            h('td', h('span', { title: date(u.uploadedAt, { withTime: true }) }, relative(u.uploadedAt))),
            h('td.small', u.uploadedBy),
            h('td.num', number(u.totalRows)),
            h('td.num', cell(u.qualified, 'is-qualified')),
            h('td.num', cell(u.reviewRequired, 'is-review')),
            h('td.num', cell(u.rejected, 'is-rejected')),
            h('td.num', cell(u.imported)),
            h('td',
                h('div.row', { style: { gap: 'var(--space-1)', justifyContent: 'flex-end' } },
                    h('button.btn.sm.ghost', {
                        title: 'Show the companies this upload brought in',
                        onclick: () => navigate(`/prospects?filter=${encodeURIComponent(JSON.stringify({
                            op: 'and',
                            children: [{ field: 'import_batch_id', operator: 'is', value: u.id }],
                        }))}`),
                    }, 'View companies'),
                    u.deletedAt
                        ? h('button.btn.sm', { onclick: () => restore(u) }, 'Restore')
                        : store.can('record.delete') && h('button.btn.sm.ghost.danger', { onclick: () => remove(u) }, 'Delete'),
                ),
            ),
        );
    }

    async function remove(u) {
        /**
         * The consequences are stated BEFORE the click, with the actual numbers
         * from this upload — including the one thing that will NOT be removed.
         * A confirmation that says "are you sure?" and nothing else is a dialog
         * people learn to dismiss without reading.
         */
        const alreadyImported = u.imported;
        const ok = await confirm({
            title: `Delete "${u.filename}"?`,
            message: `${number(u.companies - alreadyImported)} companies will move to the Recycle Bin, `
                + 'along with their qualification verdicts and collected evidence. Nothing is erased — '
                + 'restoring the upload brings all of it back.'
                + (alreadyImported
                    ? ` ${number(alreadyImported)} companies have already been imported into the CRM and will be left `
                      + 'alone: their Accounts are being worked.'
                    : ''),
            confirmLabel: 'Move to Recycle Bin',
            danger: true,
        });
        if (!ok) return;
        try {
            const result = await api.delete(`/api/import/uploads/${u.id}`);
            toast(result.note, 'success');
            await load();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    async function restore(u) {
        try {
            const { restored } = await api.post(`/api/import/uploads/${u.id}/restore`, {});
            toast(`${number(restored)} companies restored.`, 'success');
            await load();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    await load();
    return undefined;
}
