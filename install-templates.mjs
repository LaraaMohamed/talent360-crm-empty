/**
 * Installs the four .docx templates from `Automation/` into the CRM.
 *
 *   node install-templates.mjs            # show what would change
 *   node install-templates.mjs --apply    # install them
 *
 * The templates can also be uploaded one at a time in Settings → Documents, and
 * that is the normal route once the product is in use. This script exists for
 * the first install, because until a template is registered NOTHING can be
 * generated — an empty `document_templates` table is a dead end that looks
 * exactly like a broken feature, and it is the state the CRM shipped in.
 *
 * Installing the same file twice is safe: `installTemplate` retires the
 * previous row rather than replacing it, so every past generation keeps
 * pointing at the exact bytes that produced it. This script skips a template
 * whose checksum already matches, so re-running it is a no-op rather than a
 * pile of identical versions.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { migrate, all, close, ROOT } from './lib/db.mjs';
import { installTemplate, currentTemplate } from './lib/doc-generation.mjs';

const APPLY = process.argv.includes('--apply');

/** Template key → the file in Automation/ that is that template. */
const TEMPLATES = [
    ['hcm_proposal', 'HCM Proposal', 'Talent 360 - Proposal Template.docx'],
    ['hcm_agreement', 'HCM Agreement', 'Talent 360 - HCM Agreement Template.docx'],
    ['offshoring_proposal', 'Offshoring Proposal', 'T360 - Offshoring_Payroll Proposal Template.docx'],
    ['offshoring_agreement', 'Offshoring Agreement', 'T360 - Offshoring Agreement Template.docx'],
];

const SOURCE_DIR = path.join(ROOT, 'Automation', 'HCM');

migrate();

const workspaces = all('SELECT id, name FROM workspaces');
if (!workspaces.length) {
    console.log('No workspaces. Run `node setup.mjs` first.');
    close();
    process.exit(0);
}

let installed = 0;
let missing = 0;

for (const workspace of workspaces) {
    console.log(`\n${workspace.name}`);
    const ctx = { workspaceId: workspace.id, userId: null };

    for (const [key, label, fileName] of TEMPLATES) {
        const file = path.join(SOURCE_DIR, fileName);
        if (!fs.existsSync(file)) {
            console.log(`  ✗ ${label.padEnd(22)} ${fileName} not found in Automation/HCM`);
            missing += 1;
            continue;
        }

        const buffer = fs.readFileSync(file);
        const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
        const existing = currentTemplate(workspace.id, key);

        if (existing?.checksum === checksum) {
            console.log(`  · ${label.padEnd(22)} already installed, unchanged (v${existing.version})`);
            continue;
        }

        if (!APPLY) {
            console.log(`  → ${label.padEnd(22)} would install${existing ? ` as v${existing.version + 1}` : ''}`);
            continue;
        }

        const row = installTemplate(ctx, { templateKey: key, label, buffer, fileName });
        console.log(`  ✓ ${label.padEnd(22)} installed as v${row.version}`);
        installed += 1;
    }
}

if (!APPLY) console.log('\nDry run. Re-run with --apply to install.');
else console.log(`\n${installed} template(s) installed.`);
if (missing) console.log(`${missing} template file(s) were not found and were skipped.`);

close();
