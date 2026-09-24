/**
 * The document template engine — a port of `Automation/HCM/apps-script-dms/
 * DocumentEngine.gs`, working on OOXML instead of the Google Docs API.
 *
 * The Apps Script had three jobs and this file has the same three, in the same
 * order, because the order is load-bearing: structural removals happen first,
 * then numbering, then placeholder replacement.
 *
 *   1. applyDynamicBlocks — delete the service blocks that are switched off
 *   2. renumber the survivors
 *   3. replace every {{PLACEHOLDER}}
 *
 * ── WHY THIS EDITS XML AND NOT A DOCUMENT MODEL ─────────────────────────────
 *
 * Everything that carries the design of these documents — styles, theme,
 * embedded Arabic fonts, header, footer, logos, table formatting — lives in
 * parts we never open (see lib/docx.mjs). Editing `word/document.xml` as text
 * and copying the rest through byte for byte is what makes "visually identical
 * to the template" a property of the implementation rather than a hope.
 *
 * ── ONE DELIBERATE DIFFERENCE FROM THE APPS SCRIPT ──────────────────────────
 *
 * The Apps Script numbers blocks by walking SERVICE_REGISTRY and replacing each
 * service's own {{NUM:KEY}} wherever it physically sits. That is correct only
 * while the template's block order matches the registry's. It does for the HCM
 * Proposal; it does NOT for the HCM Agreement, whose blocks are authored in a
 * different order — so the script prints its Arabic articles 1, 2, 7, 6, 3, 4, 5
 * while `Draft - HCM Agreement (1).docx`, the document the template was built
 * from, reads 1-7 in order.
 *
 * This engine numbers by DOCUMENT ORDER: the surviving blocks, top to bottom,
 * get 1..N. For the HCM Proposal that is identical to the Apps Script's output
 * (the two orders agree); for the HCM Agreement it is what the authored draft
 * says. See docs/10-automation-port-map.md.
 */

/** Matches a whole placeholder, including the {{SEC:KEY}} / {{NUM:KEY}} control tokens. */
const TOKEN = /\{\{[^{}]{1,64}\}\}/g;

/** The text nodes of a Word document. Content is escaped text, never elements. */
const TEXT_NODE = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;

export function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/** Undoes the five XML entities Word writes, so paragraph text compares as text. */
function unescapeXml(value) {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

/* --------------------------------------------------------- body scanning -- */

/**
 * Splits `word/document.xml` into its top-level body children.
 *
 * A body child is a `<w:p>`, a `<w:tbl>`, or the final `<w:sectPr>` — the same
 * children `Body#getChild(i)` walked in the Apps Script. Returned as spans into
 * the original string so a removal is a splice and every byte we keep is a byte
 * from the template.
 *
 * @param {string} xml
 * @returns {{children: Array<{start:number,end:number,tag:string,text:string}>}}
 */
export function parseBodyChildren(xml) {
    const bodyOpen = xml.indexOf('<w:body');
    if (bodyOpen === -1) throw new Error('document.xml has no <w:body> element.');
    const bodyStart = xml.indexOf('>', bodyOpen) + 1;
    const bodyEnd = xml.lastIndexOf('</w:body>');
    if (bodyEnd === -1) throw new Error('document.xml has no closing </w:body>.');

    const children = [];
    let depth = 0;
    let childStart = -1;
    let i = bodyStart;

    while (i < bodyEnd) {
        const lt = xml.indexOf('<', i);
        if (lt === -1 || lt >= bodyEnd) break;

        // Comments, processing instructions and declarations are not elements.
        if (xml.startsWith('<!--', lt)) { i = xml.indexOf('-->', lt) + 3; continue; }
        if (xml.startsWith('<?', lt)) { i = xml.indexOf('?>', lt) + 2; continue; }

        const gt = xml.indexOf('>', lt);
        if (gt === -1) break;

        const isClose = xml[lt + 1] === '/';
        const isSelfClosing = xml[gt - 1] === '/';

        if (isClose) {
            depth -= 1;
            if (depth === 0 && childStart !== -1) {
                children.push(makeChild(xml, childStart, gt + 1));
                childStart = -1;
            }
        } else if (isSelfClosing) {
            if (depth === 0) children.push(makeChild(xml, lt, gt + 1));
        } else {
            if (depth === 0) childStart = lt;
            depth += 1;
        }

        i = gt + 1;
    }

    return { children, bodyStart, bodyEnd };
}

function makeChild(xml, start, end) {
    const source = xml.slice(start, end);
    const tagMatch = /^<\s*([\w:.-]+)/.exec(source);
    return {
        start,
        end,
        tag: tagMatch ? tagMatch[1] : '',
        text: elementText(source),
    };
}

/** The visible text of an element: every `<w:t>` node, concatenated. */
export function elementText(source) {
    let text = '';
    for (const match of source.matchAll(TEXT_NODE)) text += unescapeXml(match[1]);
    return text;
}

/* ----------------------------------------------------------- block removal -- */

/**
 * Removes the blocks whose service is switched off, then numbers what is left.
 *
 * A block runs from the paragraph carrying its `{{SEC:KEY}}` token up to (not
 * including) the next `{{SEC:` paragraph or the type's terminal boundary text —
 * exactly the rule `findNextBlockBoundary_` implements, which is why the
 * templates need no end markers.
 *
 * @param {string} xml `word/document.xml`
 * @param {{registry: Array<{key:string}>, numberFormat: function(number):string, terminalBoundaryText: string}} config
 * @param {Array<string>} enabledKeys Service keys to KEEP.
 * @returns {string}
 */
export function applyDynamicBlocks(xml, config, enabledKeys) {
    const { children } = parseBodyChildren(xml);

    const blockStarts = [];
    children.forEach((child, index) => {
        const match = /\{\{SEC:([A-Z_]+)\}\}/.exec(child.text);
        if (match) blockStarts.push({ index, key: match[1] });
    });

    const boundaryIndex = (fromIndex) => {
        for (let i = fromIndex; i < children.length; i++) {
            const { text } = children[i];
            if (text.includes('{{SEC:')) return i;
            if (config.terminalBoundaryText && text.includes(config.terminalBoundaryText)) return i;
        }
        return children.length;
    };

    // Collect the spans to drop before touching the string, so every index
    // below still refers to the same document. The Apps Script re-scanned after
    // each removal for the same reason; this achieves it by not mutating at all
    // until the end.
    const removals = [];
    for (const block of blockStarts) {
        if (enabledKeys.includes(block.key)) continue;
        const end = boundaryIndex(block.index + 1);
        removals.push({
            start: children[block.index].start,
            end: children[end - 1].end,
        });
    }

    let out = xml;
    for (const span of removals.sort((a, b) => b.start - a.start)) {
        out = out.slice(0, span.start) + out.slice(span.end);
    }

    return renumberBlocks(out, config);
}

/**
 * Numbers the surviving blocks 1..N in document order and strips the control
 * tokens. See the file header for why this is document order and not registry
 * order.
 */
function renumberBlocks(xml, config) {
    const { children } = parseBodyChildren(xml);
    let sequence = 0;
    let out = xml;

    // Right to left, so replacing a token never moves a span we have not
    // processed yet.
    const blocks = [];
    for (const child of children) {
        const match = /\{\{SEC:([A-Z_]+)\}\}/.exec(child.text);
        if (match) blocks.push({ child, key: match[1], number: ++sequence });
    }

    for (const block of blocks.reverse()) {
        const source = out.slice(block.child.start, block.child.end);
        const replaced = source
            .split(`{{NUM:${block.key}}}`).join(escapeXml(config.numberFormat(block.number)))
            .split(`{{SEC:${block.key}}}`).join('');
        out = out.slice(0, block.child.start) + replaced + out.slice(block.child.end);
    }

    return out;
}

/* ---------------------------------------------------- placeholder replacing -- */

/**
 * Replaces every `{{KEY}}` from the map, inside text nodes only.
 *
 * The Apps Script escaped both the search pattern and the replacement because
 * `Body#replaceText` is regex-based, where a client name containing `$` or `\`
 * could corrupt the output. Here the substitution is a plain string split/join,
 * so that class of bug cannot occur at all — the only escaping needed is XML's.
 *
 * @param {string} xml
 * @param {Object<string, *>} placeholders
 * @returns {string}
 */
export function applyPlaceholders(xml, placeholders) {
    const entries = Object.entries(placeholders);
    if (!entries.length) return xml;
    /**
     * One pass over the ORIGINAL text, not one pass per key.
     *
     * Substituting key-by-key (the previous shape) fed each substitution's
     * output back in as the input to the next — so a field whose value
     * happened to contain literal text like "{{MONTHLY_FEE}}" (a client
     * name pasted from somewhere that used the same bracket convention,
     * say) would have that text replaced a second time by whichever
     * field's token it collided with, if that key came later in
     * `Object.entries` order. A single alternation regex over the
     * original string can only ever match a REAL `{{KEY}}` token once,
     * so an already-substituted value is never rescanned.
     */
    const rendered = new Map(entries.map(([key, value]) => [
        key,
        value === undefined || value === null ? '' : escapeXml(value),
    ]));
    const pattern = new RegExp(
        `\\{\\{(${entries.map(([key]) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\}\\}`,
        'g',
    );
    return xml.replace(TEXT_NODE, (whole, inner) => {
        const text = inner.replace(pattern, (token, key) => rendered.get(key) ?? token);
        return whole.replace(inner, text);
    });
}

/* ------------------------------------------------------------- the pipeline -- */

/**
 * Runs a template through the whole pipeline and reports anything left over.
 *
 * `leftoverTokens` is the safety net Phase 19 asks for: a document that still
 * contains `{{SOMETHING}}` is a broken document, and the caller must refuse to
 * save it rather than handing a customer a contract with a visible placeholder.
 *
 * @param {string} documentXml
 * @param {{dynamicBlocks?: object, enabledKeys?: Array<string>, placeholders: object}} options
 * @returns {{xml: string, leftoverTokens: Array<string>}}
 */
export function renderDocumentXml(documentXml, options) {
    assertNoSplitTokens(documentXml);

    let xml = documentXml;
    if (options.dynamicBlocks) {
        xml = applyDynamicBlocks(xml, options.dynamicBlocks, options.enabledKeys ?? []);
    }
    xml = applyPlaceholders(xml, options.placeholders ?? {});

    const leftover = [];
    const { children } = parseBodyChildren(xml);
    for (const child of children) {
        for (const token of child.text.match(TOKEN) ?? []) {
            if (!leftover.includes(token)) leftover.push(token);
        }
    }

    return { xml, leftoverTokens: leftover };
}

/**
 * Refuses a template whose placeholder is split across text nodes.
 *
 * Word splits a paragraph into runs whenever formatting, spell-check state or a
 * language boundary changes, and a placeholder typed in pieces can end up
 * spanning several — at which point a text-node substitution silently does
 * nothing and the document goes out with `{{CLIENT_NAME}}` printed on it.
 *
 * None of the four current templates has a split token (verified against all
 * four .docx files). Rather than silently rewriting runs — which would discard
 * whatever formatting difference caused the split — this reports the paragraph
 * so whoever edits the template can retype that placeholder in one go.
 */
export function assertNoSplitTokens(xml) {
    const { children } = parseBodyChildren(xml);
    const broken = [];

    for (const child of children) {
        const tokens = child.text.match(TOKEN);
        if (!tokens) continue;
        const source = xml.slice(child.start, child.end);
        const nodes = [...source.matchAll(TEXT_NODE)].map((m) => unescapeXml(m[1]));
        for (const token of tokens) {
            if (!nodes.some((node) => node.includes(token))) {
                broken.push({ token, context: child.text.slice(0, 80) });
            }
        }
    }

    if (broken.length) {
        const detail = broken.map((b) => `${b.token} (in "${b.context}…")`).join('; ');
        throw new Error(
            `This template has ${broken.length} placeholder(s) split across formatting runs, `
            + `which cannot be replaced reliably: ${detail}. `
            + 'Open the template, delete each one and retype it in a single edit, then re-upload.',
        );
    }
}

/* ------------------------------------------------------------- yellow -- */

/**
 * Yellow, as Word can express it.
 *
 * Two mechanisms, and looking for only one of them is why "no highlighting"
 * was reported for a template whose signature block is solid yellow:
 *
 *   <w:highlight w:val="yellow"/>          the highlighter pen, on a text run
 *   <w:shd w:fill="FFFF00"/>               shading, on a run OR a table cell
 *
 * The template authors used both, and used them for the same purpose — marking
 * what somebody has to fill in by hand. `F1C232` sits on the runs holding
 * {{CLIENT_NAME}} and {{CONTRACT_DURATION_TEXT}}: the merge fields themselves
 * were highlighted, so every generated document arrived pre-marked as a draft.
 *
 * ── WHY A HUE TEST AND NOT A LIST OF COLOURS ────────────────────────────────
 *
 * The same documents carry navy 0D2B4E, 0B2545, 0D183C, teal 3DD9B8 and pale
 * blue EBF3FA as deliberate brand colours, and those must survive untouched. A
 * hard-coded list of yellows would miss the next shade somebody picks out of
 * the colour wheel; a hue window keeps the brand palette and catches the lot.
 * Everything else — bold, italics, borders, fonts, alignment, tables — is
 * untouched, because only the two elements above are ever removed.
 */
const YELLOW_HIGHLIGHTS = new Set(['yellow', 'darkyellow']);

function isYellowHex(hex) {
    const value = String(hex ?? '').trim();
    if (!/^[0-9A-Fa-f]{6}$/.test(value)) return false;
    const r = parseInt(value.slice(0, 2), 16) / 255;
    const g = parseInt(value.slice(2, 4), 16) / 255;
    const b = parseInt(value.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lightness = (max + min) / 2;
    if (max === min) return false;                                   // grey has no hue
    const delta = max - min;
    const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (saturation < 0.25 || lightness < 0.15 || lightness > 0.97) return false;

    let hue;
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue = (hue * 60 + 360) % 360;

    // 40°–70°: amber through to pure yellow. Navy sits near 212°, teal near 166°.
    return hue >= 40 && hue <= 70;
}

/**
 * Removes every yellow highlight and every yellow shading from one XML part.
 *
 * Applied to the RENDERED document rather than only to the stored template, so
 * a template uploaded tomorrow with a yellow field cannot put it back. That is
 * what makes "no generated document contains yellow" a property of generation
 * and not a promise about the files somebody uploads.
 */
export function stripYellow(xml) {
    let out = String(xml).replace(
        /<w:highlight\s+w:val="([^"]*)"\s*\/>/g,
        (match, value) => (YELLOW_HIGHLIGHTS.has(String(value).toLowerCase()) ? '' : match),
    );

    // `<w:shd>` appears self-closing and, rarely, with a body. Both forms go
    // when the fill is yellow; a non-yellow fill is left exactly as authored.
    out = out.replace(/<w:shd\b[^>]*\/>/g, (match) => {
        const fill = /w:fill="([^"]*)"/.exec(match)?.[1];
        return isYellowHex(fill) ? '' : match;
    });
    out = out.replace(/<w:shd\b[^>]*>[\s\S]*?<\/w:shd>/g, (match) => {
        const fill = /w:fill="([^"]*)"/.exec(match)?.[1];
        return isYellowHex(fill) ? '' : match;
    });

    return out;
}

/** Every part of a .docx that can carry formatting, so nothing hides in a header. */
export const FORMATTED_PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
