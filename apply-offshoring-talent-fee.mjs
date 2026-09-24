/**
 * Turns the offshoring proposal's talent fee into a variable.
 *
 *   node apply-offshoring-talent-fee.mjs            # show what would change
 *   node apply-offshoring-talent-fee.mjs --apply    # write it
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 *
 * The template read "-Talent fees:  65 USD per employee / month", with the 65
 * highlighted yellow. Yellow is the convention for "somebody edits this by hand
 * before sending" — which is the same thing as saying it should have been a
 * field. Every offshoring proposal the CRM generated therefore came out quoting
 * 65 with a highlighter mark around it, and the price had to be corrected in
 * Word afterwards, outside the CRM, where nothing records what was quoted.
 *
 * ── WHAT THIS DOES ──────────────────────────────────────────────────────────
 *
 * Rewrites the one run holding the 65: the text becomes {{TALENT_FEE}} and the
 * <w:highlight> is dropped, leaving the run's size and font exactly as they
 * were. Nothing else in the document is touched — a .docx is a zip of XML, and
 * everything but `word/document.xml` is copied through byte for byte.
 *
 * It patches the SOURCE file under Automation/ so `install-templates.mjs`
 * reproduces it, then installs the result as a new template version in every
 * workspace that has one. Installing supersedes rather than replaces, so every
 * proposal already generated keeps pointing at the bytes that actually produced
 * it.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { migrate, all, close, ROOT } from './lib/db.mjs';
import { readZip, readPart, writeZip } from './lib/docx.mjs';
import { installTemplate, currentTemplate } from './lib/doc-generation.mjs';

const APPLY = process.argv.includes('--apply');
const SOURCE = path.join(ROOT, 'Automation', 'HCM', 'T360 - Offshoring_Payroll Proposal Template.docx');
const TEMPLATE_KEY = 'offshoring_proposal';

/**
 * The run holding the highlighted 65, matched as a whole.
 *
 * Anchored on the literal text and the highlight together rather than on "65"
 * alone: the document has other numbers, and a bare search-and-replace over XML
 * is how a template quietly loses a font size or a table width.
 */
const RUN = /<w:r><w:rPr>((?:(?!<\/w:rPr>).)*?)<w:highlight w:val="yellow"\/>(?:(?!<\/w:rPr>).)*?<\/w:rPr><w:t>65<\/w:t><\/w:r>/;

function patch(xml) {
    if (xml.includes('{{TALENT_FEE}}')) return { xml, already: true };
    const match = xml.match(RUN);
    if (!match) return { xml, missing: true };
    // The run's own properties, minus the highlight. Rebuilt from the captured
    // prefix so the size and font survive rather than being retyped here.
    const kept = match[0]
        .replace('<w:highlight w:val="yellow"/>', '')
        .replace('<w:t>65</w:t>', '<w:t>{{TALENT_FEE}}</w:t>');
    return { xml: xml.replace(RUN, kept), patched: true };
}

migrate();

if (!fs.existsSync(SOURCE)) {
    console.error(`The source template is missing: ${SOURCE}`);
    close();
    process.exit(1);
}

const original = fs.readFileSync(SOURCE);
const zip = readZip(original);
const result = patch(readPart(zip, 'word/document.xml'));

if (result.missing) {
    console.error('Could not find the highlighted "65" run in the template. Nothing was changed.');
    close();
    process.exit(1);
}

// The bytes that WOULD be installed, so the comparison below is against the
// patched file rather than whatever is on disk right now.
const patchedBytes = result.patched ? writeZip(zip, { 'word/document.xml': result.xml }) : original;
const checksum = crypto.createHash('sha256').update(patchedBytes).digest('hex');

const workspaces = all('SELECT id, name FROM workspaces');
const plan = [];
if (result.patched) plan.push(`${path.basename(SOURCE)}: highlighted "65" → {{TALENT_FEE}}, highlight removed`);

const targets = [];
for (const workspace of workspaces) {
    const installed = currentTemplate(workspace.id, TEMPLATE_KEY);
    if (!installed) {
        plan.push(`  ${workspace.name}: no offshoring proposal template installed — skipped`);
        continue;
    }
    // Re-running must not pile up identical versions. install-templates.mjs
    // makes the same check, for the same reason: a version number should mean a
    // change, not a number of times somebody ran a script.
    if (installed.checksum === checksum) {
        plan.push(`  ${workspace.name}: already on these bytes (v${installed.version}) — nothing to install`);
        continue;
    }
    plan.push(`  ${workspace.name}: install v${installed.version + 1} (v${installed.version} retired, still readable)`);
    targets.push(workspace);
}

if (!plan.length || (!result.patched && !targets.length)) {
    console.log('The talent fee is already a variable everywhere. Nothing to do.');
    close();
    process.exit(0);
}

console.log(plan.join('\n'));

if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write it.');
    close();
    process.exit(0);
}

if (result.patched) {
    fs.writeFileSync(SOURCE, patchedBytes);
    console.log(`\nRewrote ${path.basename(SOURCE)}.`);
}

for (const workspace of targets) {
    const row = installTemplate(
        { workspaceId: workspace.id, userId: null },
        { templateKey: TEMPLATE_KEY, label: 'Offshoring Proposal', buffer: patchedBytes, fileName: path.basename(SOURCE) },
    );
    console.log(`  ${workspace.name}: installed v${row.version}`);
}

console.log(`\nApplied. ${targets.length} workspace(s) updated.`);
close();
