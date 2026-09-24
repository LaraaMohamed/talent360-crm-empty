/**
 * The first party's name and signatory, on the agreements that left them blank.
 *
 *   node apply-agreement-signature-fields.mjs            # show what would change
 *   node apply-agreement-signature-fields.mjs --apply    # write it
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 *
 * Both Arabic agreements end in a signature table with two columns. Talent 360's
 * side is complete — الطرف الثاني names the company and الأسم names the person
 * who signs. The client's side was not:
 *
 *   HCM agreement          الطرف الأول (  )      empty parentheses
 *                          الأسم:                empty
 *   Offshoring agreement   الطرف الأول ({{CLIENT_NAME}})   already correct
 *                          الاسم :               empty
 *
 * So every generated contract went out with a blank where the client's legal
 * name and their signatory should be, and somebody typed them into Word
 * afterwards — outside the CRM, where nothing records what was agreed.
 *
 * Both values already exist and are already validated: CLIENT_NAME is the
 * account's Arabic company name from its commercial registration, and
 * REPRESENTATIVE_NAME is the person entered on the agreement form. Neither is
 * hard-coded here; changing the account changes the first, and changing the
 * form changes the second.
 *
 * ── AND THE YELLOW ──────────────────────────────────────────────────────────
 *
 * The same signature cells are shaded solid yellow, and on the HCM agreement so
 * are the runs holding {{CLIENT_NAME}} and {{CONTRACT_DURATION_TEXT}} — the
 * merge fields themselves. Generation strips yellow from every document it
 * produces (lib/doc-generation.mjs), so this is belt and braces: it also cleans
 * the stored templates, so what is uploaded matches what comes out.
 *
 * Nothing else is touched. Only <w:highlight> and yellow <w:shd> are removed;
 * bold, italics, borders, fonts, sizes, alignment and every non-yellow fill
 * (the navy and teal brand colours) are copied through unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { migrate, all, close, ROOT } from './lib/db.mjs';
import { readZip, readPart, writeZip } from './lib/docx.mjs';
import { stripYellow, FORMATTED_PARTS } from './lib/docx-template.mjs';
import { installTemplate, currentTemplate } from './lib/doc-generation.mjs';

const APPLY = process.argv.includes('--apply');

const TEMPLATES = [
    {
        key: 'hcm_agreement',
        label: 'HCM Agreement',
        file: 'Talent 360 - HCM Agreement Template.docx',
        edits: [
            {
                what: 'الطرف الأول → {{CLIENT_NAME}}',
                // The two runs are the opening and closing parenthesis of an
                // empty pair. Matched together so the token lands between them
                // and nowhere else in a document that says الطرف الأول twice.
                find: /(<w:r>(?:(?!<\/w:r>)[\s\S])*?<w:t>الطرف الأول \(<\/w:t><\/w:r>)(<w:r>((?:(?!<\/w:r>)[\s\S])*?)<w:t>\(<\/w:t><\/w:r>)/,
                replace: (_m, open, closeRun, closeProps) =>
                    `${open}<w:r>${closeProps}<w:t>{{CLIENT_NAME}}</w:t></w:r>${closeRun}`,
            },
            {
                what: 'الأسم → {{REPRESENTATIVE_NAME}}',
                find: /<w:t>الأسم:<\/w:t>/,
                replace: () => '<w:t xml:space="preserve">الأسم: {{REPRESENTATIVE_NAME}}</w:t>',
            },
        ],
    },
    {
        key: 'offshoring_agreement',
        label: 'Offshoring Agreement',
        file: 'T360 - Offshoring Agreement Template.docx',
        edits: [
            {
                what: 'الاسم → {{REPRESENTATIVE_NAME}}',
                find: /<w:t>الاسم :<\/w:t>/,
                replace: () => '<w:t xml:space="preserve">الاسم : {{REPRESENTATIVE_NAME}}</w:t>',
            },
        ],
    },
    { key: 'hcm_proposal', label: 'HCM Proposal', file: 'Talent 360 - Proposal Template.docx', edits: [] },
    { key: 'offshoring_proposal', label: 'Offshoring Proposal', file: 'T360 - Offshoring_Payroll Proposal Template.docx', edits: [] },
];

migrate();

/** Applies one template's edits and yellow-stripping. Returns the new bytes, or null. */
function rebuild(spec) {
    const file = path.join(ROOT, 'Automation', 'HCM', spec.file);
    if (!fs.existsSync(file)) return { missing: file };

    const original = fs.readFileSync(file);
    const zip = readZip(original);
    const notes = [];

    let documentXml = readPart(zip, 'word/document.xml');
    for (const edit of spec.edits) {
        if (edit.find.test(documentXml)) {
            documentXml = documentXml.replace(edit.find, edit.replace);
            notes.push(edit.what);
        } else if (/\{\{(CLIENT_NAME|REPRESENTATIVE_NAME)\}\}/.test(documentXml) && edit.what.includes('→')) {
            // Already applied by an earlier run, or authored correctly.
            notes.push(`${edit.what} (already present)`);
        } else {
            return { problem: `could not find the anchor for: ${edit.what}` };
        }
    }

    const replacements = {};
    // Compared against the POST-edit body: otherwise an edit above shows up as
    // "yellow removed", which is a report of work that did not happen.
    const cleanedBody = stripYellow(documentXml);
    if (cleanedBody !== documentXml) notes.push('yellow removed');
    replacements['word/document.xml'] = cleanedBody;

    for (const entry of zip.entries) {
        if (entry.name === 'word/document.xml' || !FORMATTED_PARTS.test(entry.name)) continue;
        const part = readPart(zip, entry.name);
        const cleaned = stripYellow(part);
        if (cleaned !== part) {
            replacements[entry.name] = cleaned;
            notes.push(`yellow removed from ${entry.name}`);
        }
    }

    const buffer = writeZip(zip, replacements);
    return { file, buffer, notes, changed: !buffer.equals(original) };
}

const workspaces = all('SELECT id, name FROM workspaces');
const plan = [];
const built = [];

for (const spec of TEMPLATES) {
    const result = rebuild(spec);
    if (result.missing) { plan.push(`  ⚠ ${spec.label}: source file missing (${result.missing})`); continue; }
    if (result.problem) { plan.push(`  ⚠ ${spec.label}: ${result.problem}`); continue; }

    if (!result.notes.length && !result.changed) {
        plan.push(`${spec.label}: already correct`);
        continue;
    }
    plan.push(`${spec.label}: ${result.notes.join(', ') || 'rewritten'}`);
    built.push({ spec, result });
}

// Which workspaces would receive a new version.
const checksumOf = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const installs = [];
for (const { spec, result } of built) {
    for (const workspace of workspaces) {
        const installed = currentTemplate(workspace.id, spec.key);
        if (!installed) { plan.push(`  ${workspace.name}: no ${spec.label} installed — skipped`); continue; }
        if (installed.checksum === checksumOf(result.buffer)) {
            plan.push(`  ${workspace.name}: ${spec.label} already on these bytes (v${installed.version})`);
            continue;
        }
        plan.push(`  ${workspace.name}: ${spec.label} → v${installed.version + 1} (v${installed.version} retired, still readable)`);
        installs.push({ spec, result, workspace });
    }
}

if (!built.length && !installs.length) {
    console.log('The agreements already name their first party and signatory, and carry no yellow. Nothing to do.');
    close();
    process.exit(0);
}

console.log(plan.join('\n'));

if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write it.');
    close();
    process.exit(0);
}

for (const { spec, result } of built) {
    if (result.changed) {
        fs.writeFileSync(result.file, result.buffer);
        console.log(`\nRewrote ${spec.file}`);
    }
}

for (const { spec, result, workspace } of installs) {
    const row = installTemplate(
        { workspaceId: workspace.id, userId: null },
        { templateKey: spec.key, label: spec.label, buffer: result.buffer, fileName: spec.file },
    );
    console.log(`  ${workspace.name}: ${spec.label} installed v${row.version}`);
}

console.log(`\nApplied. ${installs.length} template version(s) installed.`);
close();
