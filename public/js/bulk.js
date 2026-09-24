/**
 * Bulk writes — the machinery every screen that lists rows shares.
 *
 * ── WHY THIS IS NOT PART OF THE LIST PAGE ───────────────────────────────────
 *
 * It began there, and while the list page was the only place offering bulk
 * actions, every other surface showing rows — My work's Tasks, Activities and
 * Notes tabs among them — was a place where changing ten records meant opening
 * ten records.
 *
 * The rule these dialogs enforce matters more than the buttons do: NOTHING IS
 * WRITTEN UNTIL THE CONSEQUENCE HAS BEEN SHOWN. Every action previews first,
 * says how many records it touches and how many the caller may not change, and
 * reports partial failure rather than swallowing it. A second, looser copy of
 * that on another screen is the copy that loses somebody's data, so there is
 * one copy and every screen imports it.
 */
import { h, mount, modal, toast, number } from './core.js';
import { api } from './api.js';
import * as store from './store.js';
import { fieldControl, statTile, icon } from './components.js';

/**
 * Whether this person can create or change records at all.
 *
 * A `readonly` role holds `record.read.all` and nothing else, so every write
 * button on this page answered 403 — the New button, bulk edit, assign owner,
 * add to campaign, verify emails, import into the CRM. Offering an action that
 * cannot succeed is worse than not offering it: the user reasonably concludes
 * the product is broken rather than that they lack permission.
 *
 * The server is still the authority. This only stops us drawing a door that is
 * locked.
 */
export function canWrite() {
    return store.can('record.write.all') || store.can('record.write.own');
}

/* ----------------------------------------------------------- the dialogs -- */

/**
 * The bulk edit dialog.
 *
 * Fields are opted INTO one at a time. A form that shows every field with its
 * current value and writes all of them would blank every field the user did not
 * touch — the classic bulk-edit disaster — so nothing is sent unless it was
 * explicitly added here.
 *
 * "Clear this field" is a separate, deliberate checkbox rather than "leave it
 * empty", because an empty text box is ambiguous and clearing 900 records is
 * not something to infer.
 */
export async function pickBulkEdit(objectKey) {
    const def = store.object(objectKey);
    const editable = store.fields(objectKey)
        .filter((f) => f.form !== false && !f.readOnly && !f.computed);

    const chosen = new Map();          // key -> { def, value, clear }
    const rowsHost = h('div.stack');
    const picker = h('select.input',
        h('option', { value: '' }, 'Add a field to change…'),
        editable.map((f) => h('option', { value: f.key }, f.label + (f.custom ? ' (custom)' : ''))),
    );

    const repaint = () => {
        mount(rowsHost, chosen.size === 0
            ? h('p.xs.dim', 'No fields chosen yet. Only the fields you add here are written — everything else is left '
                + 'exactly as it is.')
            : [...chosen.values()].map((entry) => h('div.field',
                h('div.row',
                    h('label', { style: { margin: 0 } }, entry.def.label),
                    h('div.spacer'),
                    h('label.checkbox',
                        h('input', {
                            type: 'checkbox', checked: entry.clear,
                            onchange: (e) => { entry.clear = e.target.checked; repaint(); },
                        }),
                        h('span.xs', 'Clear it'),
                    ),
                    h('button.btn.sm.ghost', {
                        onclick: () => { chosen.delete(entry.def.key); repaint(); },
                    }, '✕'),
                ),
                entry.clear
                    ? h('div.note-box.warning', `Every selected record will have ${entry.def.label} emptied.`)
                    : fieldControl(objectKey, entry.def, entry.value, (v) => { entry.value = v; }),
                entry.def.help && h('span.help', entry.def.help),
            )));
    };
    repaint();

    picker.addEventListener('change', () => {
        const field = editable.find((f) => f.key === picker.value);
        if (field && !chosen.has(field.key)) {
            chosen.set(field.key, { def: field, value: null, clear: false });
            repaint();
        }
        picker.value = '';
    });

    const result = await modal({
        title: `Edit ${def.plural.toLowerCase()}`,
        size: 'wide',
        body: h('div.stack',
            h('div.note-box',
                'Only the fields you add below are changed. Everything else on each record is left alone — a bulk edit '
                + 'that quietly blanks untouched fields is the fastest way to lose a database.'),
            h('div.field', h('label', 'Field'), picker),
            rowsHost,
        ),
        footer: (close) => [
            h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
            h('button.btn.primary', {
                onclick: () => {
                    if (!chosen.size) return close(undefined);
                    const values = {};
                    for (const entry of chosen.values()) {
                        // properties.<key> is the address a custom field takes
                        // everywhere else, and the API accepts it here too.
                        values[entry.def.key] = entry.clear ? null : entry.value;
                    }
                    return close(values);
                },
            }, 'Continue'),
        ],
    });
    return result ?? null;
}

/**
 * The preview, shown before every bulk write.
 *
 * It answers the three questions that decide whether to press the button: how
 * many records, which ones the user cannot change, and — for an edit — how many
 * rows the change actually differs from. "2,431 selected, 12 will change" stops
 * a lot of accidents that a plain "Are you sure?" does not.
 */
export async function confirmBulk(preview, { title, confirmLabel, danger, objectKey }) {
    const def = store.object(objectKey);
    return modal({
        title,
        size: 'wide',
        body: h('div.stack',
            h('div.totals-grid',
                h('div.total-cell', statTile('Selected', number(preview.requested), def.plural.toLowerCase())),
                preview.blockedCount > 0 && h('div.total-cell',
                    statTile('You cannot change', number(preview.blockedCount), 'owned by someone else')),
            ),

            preview.changes?.length > 0 && h('div.stack.tight',
                h('div.strong.small', 'What changes'),
                h('ul', { style: { paddingInlineStart: 'var(--space-4)', listStyle: 'disc' } },
                    preview.changes.map((c) => h('li',
                        h('strong', c.label), ' → ',
                        c.clearing
                            ? h('span.badge.warning', 'cleared')
                            : h('code.xs', String(c.value)),
                        preview.sampled < preview.requested
                            ? h('span.xs.dim', ` (${c.differingInSample} of the first ${preview.sampled} differ today)`)
                            : h('span.xs.dim', ` (${c.differingInSample} of ${preview.requested} differ today)`),
                    )),
                ),
            ),

            preview.sample?.length > 0 && h('div.stack.tight',
                h('div.strong.small', 'For example'),
                h('div.row', preview.sample.map((s) => h('span.chip', s.title))),
                preview.requested > preview.sample.length
                    && h('span.xs.dim', `…and ${number(preview.requested - preview.sample.length)} more.`),
            ),

            preview.note && h('div.note-box.warning', preview.note),

            preview.dependentWarning && h('div.note-box.danger',
                h('strong', 'Warning: '),
                preview.dependentWarning,
            ),

            preview.dependents?.length > 0 && h('details',
                { open: true },
                h('summary.small', `${preview.dependents.length} account(s) have associated records that will also be permanently deleted`),
                h('div.stack.tight', { style: { marginBlockStart: 'var(--space-2)' } },
                    preview.dependents.map((r) => h('div.row.between',
                        h('span.xs.strong', r.title),
                        h('span.xs.dim', r.items.map((b) => `${b.count} ${b.label}`).join(', ')),
                    )),
                ),
            ),

            // Named, not counted. "12 will be refused" is a statistic; knowing
            // it is the account with three open deals is a decision.
            preview.referenced?.length > 0 && h('details',
                h('summary.small', `${preview.referenced.length} still have records pointing at them`),
                h('div.stack.tight', { style: { marginBlockStart: 'var(--space-2)' } },
                    preview.referenced.map((r) => h('div.row.between',
                        h('span.xs', r.title),
                        h('span.xs.dim', r.blockers.map((b) => `${b.count} in ${b.table}`).join(', ')),
                    )),
                ),
            ),

            preview.irreversible && !preview.dependentWarning
                ? h('div.note-box.danger',
                    h('strong', 'This cannot be undone. '),
                    'The records, their files on disk and their qualification history are destroyed. The audit trail '
                    + 'keeps what they contained and who deleted them; nothing else does. Anything still referenced by '
                    + 'another record is refused rather than destroyed.')
                : (danger && !preview.dependentWarning && h('div.note-box',
                    'Deletes are soft: the records are hidden, keep everything attached to them, and can be restored '
                    + 'from the Deleted view.')),
        ),
        footer: (close) => [
            h('button.btn', { onclick: () => close(false) }, 'Cancel'),
            h(`button.btn.${danger ? 'danger' : 'primary'}`, {
                onclick: () => close(true),
            }, `${confirmLabel} ${number(preview.requested)}`),
        ],
    }).then((v) => v === true);
}

export async function pickOwner() {
    const select = h('select.input', store.users().map((u) => h('option', { value: u.id }, u.name)));
    return modal({
        title: 'Assign owner',
        size: 'narrow',
        body: h('div.field', h('label', 'Owner'), select),
        footer: (close) => [
            h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
            h('button.btn.primary', { onclick: () => close(select.value) }, 'Assign'),
        ],
    });
}

/**
 * Partial failure is REPORTED, not swallowed.
 *
 * And the verb matches what happened. "1 record(s) updated" after a permanent
 * delete is not a rounding error in the wording — it is the wrong fact, at the
 * one moment the user most needs to know exactly what the system just did.
 */
const BULK_VERB = {
    delete: 'moved to the trash',
    restore: 'restored',
    purge: 'permanently deleted',
    assign: 'reassigned',
    update: 'updated',
};

function reportBulk(result) {
    const verb = BULK_VERB[result.action] ?? 'updated';
    if (result.failed.length) {
        toast(`${result.succeeded} ${verb}, ${result.failed.length} refused: ${result.failed[0].error}`, 'error');
    } else {
        toast(`${result.succeeded} record(s) ${verb}.`, 'success');
    }
}

/* ------------------------------------------------------------- the write -- */

/**
 * Preview, confirm, write, report — in that order, every time.
 *
 * `selection` is the shape the server accepts: `{ ids }` for what is ticked, or
 * `{ all: true, filter, ... }` for every record matching the filter on screen.
 * Returns whether a write actually ran, so the caller refreshes because
 * something changed rather than because a dialog was opened and dismissed.
 */
export async function runBulk({ objectKey, routeName, selection, payload, title, confirmLabel, danger = false }) {
    if (!selection.all && !(selection.ids?.length)) {
        toast('No records selected.', 'error');
        return false;
    }

    const isBatchDelete = payload.action === 'delete' || payload.action === 'purge';
    const endpoint = isBatchDelete ? `/api/${routeName}/batch-delete` : `/api/${routeName}/bulk`;

    let preview;
    try {
        preview = await api.post(`/api/${routeName}/bulk`, { ...payload, ...selection, preview: true });
    } catch (err) {
        toast(err.message, 'error');
        return false;
    }

    const ok = await confirmBulk(preview, { title, confirmLabel, danger, objectKey });
    if (!ok) return false;

    const count = preview.requested;
    const loadingToast = toast(isBatchDelete
        ? `Deleting ${number(count)} record(s)...`
        : `Processing ${number(count)} record(s)...`, 'loading');

    try {
        // Ensure UI yields and does not freeze during batch operation
        await new Promise((resolve) => setTimeout(resolve, 0));
        const result = await api.post(endpoint, { ...payload, ...selection });
        loadingToast?.remove?.();
        reportBulk(result);
    } catch (err) {
        loadingToast?.remove?.();
        toast(err.message, 'error');
    }
    return true;
}

/* ----------------------------------------------------------- the buttons -- */

/**
 * The actions that mean the same thing wherever rows are listed.
 *
 * Edit any field; move tasks between their three states; hand the selection to
 * somebody else. They are an ARRAY rather than a component so a page can place
 * its own object-specific actions among them — the list page puts "Add to
 * campaign" and "Verify emails" in the middle of this set — without either page
 * owning a second definition of what "Complete" does.
 *
 * `selection` is a FUNCTION: it is read when a button is pressed, not when the
 * bar is drawn, so a bar rendered once still acts on what is ticked now.
 */
export function bulkEditActions({ objectKey, routeName, selection, disabled = false, onDone = () => {} }) {
    if (!canWrite()) return [];

    const run = async (payload, opts) => {
        const ran = await runBulk({ objectKey, routeName, selection: selection(), payload, ...opts });
        if (ran) onDone();
    };

    const status = (value, { label, title, confirmLabel, extra = {} }) => h('button.btn.sm', {
        title, disabled,
        onclick: () => run({ action: 'update', values: { status: value, ...extra } }, { title, confirmLabel }),
    }, label);

    return [
        h('button.btn.sm.primary', {
            title: 'Change any field on every selected record',
            disabled,
            onclick: async () => {
                const values = await pickBulkEdit(objectKey);
                if (!values) return;
                await run({ action: 'update', values }, { title: 'Apply this change?', confirmLabel: 'Apply' });
            },
        }, icon('edit'), 'Edit'),

        /**
         * `done` — the value the field actually takes.
         *
         * This button used to send `completed`, which is not one of the four
         * statuses a task has, so every record in the selection came back
         * refused: "Status must be one of: open, in_progress, done, cancelled."
         * The completion timestamp is not sent either; the server stamps
         * `completed_at` when the status changes, and it is read-only here.
         */
        objectKey === 'task' && status('done', {
            label: [icon('check'), 'Complete'],
            title: 'Mark selected tasks as completed',
            confirmLabel: 'Complete',
        }),
        objectKey === 'task' && status('in_progress', {
            label: 'In progress',
            title: 'Mark selected tasks as in progress',
            confirmLabel: 'In Progress',
        }),
        objectKey === 'task' && status('open', {
            label: 'Reopen',
            title: 'Mark selected tasks as open',
            confirmLabel: 'Reopen',
        }),

        // A task is assigned to an ASSIGNEE; accounts, deals and contacts are
        // owned. Notes and activities have no assignable owner — their
        // author/actor is who wrote them, not who owns them — so this action is
        // not offered there.
        ['account', 'deal', 'contact', 'task'].includes(objectKey) && h('button.btn.sm', {
            disabled,
            onclick: async () => {
                const owner = await pickOwner();
                if (!owner) return;
                await run({ action: 'assign', ownerId: owner }, {
                    title: objectKey === 'task' ? 'Reassign these tasks?' : 'Reassign these records?',
                    confirmLabel: 'Assign',
                });
            },
        }, objectKey === 'task' ? 'Assign' : 'Assign owner'),
    ];
}

/**
 * Delete, over a live list.
 *
 * The trash has the opposite pair — restore, and delete permanently — which
 * only the list page draws, because only it can show the trash.
 */
export function bulkDeleteAction({ objectKey, routeName, selection, disabled = false, onDone = () => {} }) {
    if (!store.can('record.delete')) return null;
    return h('button.btn.sm.danger', {
        disabled,
        onclick: async () => {
            const ran = await runBulk({
                objectKey, routeName, selection: selection(), payload: { action: 'delete' },
                title: 'Delete these records?', confirmLabel: 'Delete', danger: true,
            });
            if (ran) onDone();
        },
    }, 'Delete');
}
