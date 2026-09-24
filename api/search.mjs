/**
 * Global search.
 *
 * Backed by SQLite FTS5 over a single index that every object writes into, so
 * one query covers accounts, contacts, deals, notes and documents at once and
 * the command palette does not have to fan out.
 *
 * Two decisions worth stating:
 *
 *  - Terms are turned into PREFIX queries (`acme*`). Search in a CRM is used
 *    while typing a half-remembered name; exact-token matching feels broken.
 *  - The user's raw string never reaches FTS5's query grammar. `AND`, `NEAR`,
 *    quotes and `*` in a company name would otherwise be parsed as syntax and
 *    throw, so tokens are extracted and re-quoted.
 */
import { all, get } from '../lib/db.mjs';
import { OBJECTS } from '../lib/objects.mjs';
import { can } from '../lib/auth.mjs';
import { looksLikePhoneQuery, phoneMatchCandidates, phoneDigitsSql } from '../lib/phone.mjs';

/** The objects that belong to the sourcing plane rather than the CRM. */
const PROSPECTING_OBJECTS = new Set(['prospecting_company', 'prospecting_contact']);
import { hydrate } from '../lib/repo.mjs';
import { readOwnScopeObject } from './records.mjs';

const LIMIT_PER_OBJECT = 8;

export async function search({ url, ctx }) {
    const raw = String(url.searchParams.get('q') ?? '').trim();
    if (raw.length < 2) return { query: raw, groups: [], total: 0, counts: {} };

    const objectFilter = url.searchParams.get('object');
    const limit = Math.min(50, Number(url.searchParams.get('limit')) || LIMIT_PER_OBJECT);
    // The palette wants a handful per object; the search PAGE wants everything
    // it can render, so the ceiling is raised rather than the page having to
    // call repeatedly and stitch the answers together.
    const scan = Math.min(1000, Number(url.searchParams.get('scan')) || 200);

    const match = toMatchQuery(raw);
    // A query that looks like a phone number is matched on digits alone (see
    // phoneMatches below) — kept separate from `match` because it never
    // fires for anything containing a letter, so name/email/company search
    // through `match` is completely unaffected either way.
    const phoneQuery = looksLikePhoneQuery(raw) ? phoneMatchCandidates(raw) : null;
    if (!match && !phoneQuery) return { query: raw, groups: [], total: 0, counts: {} };

    let rows = [];
    if (match) {
        try {
            rows = all(
                `SELECT record_id, object_key, title, bm25(search_index) AS score
                   FROM search_index
                  WHERE search_index MATCH ? AND workspace_id = ?
                    ${objectFilter ? 'AND object_key = ?' : ''}
                  ORDER BY score
                  LIMIT ?`,
                objectFilter ? [match, ctx.workspaceId, objectFilter, scan] : [match, ctx.workspaceId, scan],
            );
        } catch {
            // A query FTS5 still refuses (unbalanced quotes in a pathological name)
            // falls back to a plain scan rather than erroring at the user.
            rows = all(
                `SELECT record_id, object_key, title, 0 AS score FROM search_index
                  WHERE workspace_id = ? AND (title LIKE ? OR body LIKE ?) LIMIT ?`,
                [ctx.workspaceId, `%${raw}%`, `%${raw}%`, scan],
            );
        }
    }
    // Whether the KEYWORD scan hit its ceiling — computed before the phone
    // matches below are merged in, so a phone number found on top of a
    // complete keyword scan can never make that scan look incomplete.
    const ftsCapped = rows.length >= scan;

    /**
     * Counts per object, over the whole match — not over the page.
     *
     * This is what makes the object filter honest: "Contacts 41" has to mean 41
     * whether or not the current view is showing contacts, or the chips become
     * a description of the page rather than of the results.
     */
    const counts = {};
    let matchedTotal = 0;
    if (match) {
        try {
            for (const row of all(
                `SELECT object_key, COUNT(*) AS n FROM search_index
                  WHERE search_index MATCH ? AND workspace_id = ? GROUP BY object_key`,
                [match, ctx.workspaceId],
            )) {
                counts[row.object_key] = row.n;
                matchedTotal += row.n;
            }
        } catch {
            for (const row of rows) counts[row.object_key] = (counts[row.object_key] ?? 0) + 1;
            matchedTotal = rows.length;
        }
    }

    /**
     * Phone numbers, normalised on both sides.
     *
     * FTS can't be trusted for this on its own — see lib/phone.mjs — so a
     * query that looks like a phone number is ALSO matched here, digits-only,
     * against every object with a real phone column (`phoneSearchTargets`).
     * Additive to the keyword match above: results already found by keyword
     * are not double-counted, and phone hits are put first because a
     * normalised digit match is exact and has no business ranking behind a
     * fuzzy keyword one.
     */
    if (phoneQuery) {
        const known = new Set(rows.map((r) => `${r.object_key}:${r.record_id}`));
        const phoneHits = phoneMatches(ctx, phoneQuery, objectFilter, scan)
            .filter((r) => !known.has(`${r.object_key}:${r.record_id}`));
        for (const hit of phoneHits) {
            counts[hit.object_key] = (counts[hit.object_key] ?? 0) + 1;
            matchedTotal += 1;
        }
        rows = [...phoneHits, ...rows];
    }

    const byObject = new Map();
    for (const row of rows) {
        if (!byObject.has(row.object_key)) byObject.set(row.object_key, []);
        const bucket = byObject.get(row.object_key);
        if (bucket.length < limit) bucket.push(row.record_id);
    }

    const groups = [];
    let total = 0;
    for (const [objectKey, ids] of byObject) {
        /**
         * Prospecting rows are dropped for anybody who may not read them.
         *
         * The index is a projection over every registered object, so a rep
         * searching for a company name was handed prospecting companies and
         * contacts — the same book `/api/prospects` refuses them, reached
         * through a route nobody thought to deny. Filtered here rather than at
         * the route, because the query legitimately spans objects and only some
         * of them are out of bounds.
         */
        if (PROSPECTING_OBJECTS.has(objectKey) && !can(ctx, 'prospecting.read')) continue;
        const def = OBJECTS[objectKey];
        if (!def || !ids.length) continue;
        /**
         * The same own-only read scope the list/detail routes already
         * enforce (`readOwnScopeObject`, api/records.mjs) — a rep's own
         * notes and logged activities, not a colleague's. The search index
         * is a projection over every registered object, so without this a
         * rep typing a colleague's name into global search got back note
         * bodies and activity detail the note/activity list would refuse
         * them outright.
         */
        const scopeColumn = readOwnScopeObject(ctx, objectKey);
        const records = scopeColumn
            ? all(
                `SELECT * FROM ${def.table} WHERE id IN (${ids.map(() => '?').join(',')})
                   AND deleted_at IS NULL AND ${scopeColumn} = ?`,
                [...ids, ctx.userId],
            )
            : all(
                `SELECT * FROM ${def.table} WHERE id IN (${ids.map(() => '?').join(',')}) AND deleted_at IS NULL`,
                ids,
            );
        if (!records.length) continue;
        // Re-ordered to match the relevance ranking, which the IN clause loses.
        const order = new Map(ids.map((x, i) => [x, i]));
        records.sort((a, b) => order.get(a.id) - order.get(b.id));
        const hydrated = hydrate(objectKey, records, ctx);
        total += hydrated.length;
        /**
         * A contact found here can also be sitting on somebody's calling
         * queue — a screen this same search never lands on, because
         * `calling_assignment` is a view over contacts, not its own indexed
         * object (see phoneSearchTargets above). Without this, opening a
         * contact from search was a dead end for "is this lead being called,
         * and by whom" — the only way to find out was to already know to
         * check Cold Calling separately.
         */
        const callingByContact = objectKey === 'contact' ? callingAssignments(ctx, hydrated.map((r) => r.id)) : null;
        groups.push({
            object: objectKey,
            label: def.plural,
            route: def.route,
            icon: def.icon,
            records: hydrated.map((r) => ({
                id: r.id,
                title: title(objectKey, r),
                subtitle: subtitle(objectKey, r),
                calling: callingByContact?.get(r.id) ?? null,
            })),
        });
    }

    // Accounts first — in this product the account is the thing everything else
    // hangs off, so it is almost always what the searcher meant.
    const rank = ['account', 'contact', 'deal', 'campaign', 'proposal', 'agreement', 'task', 'note', 'document', 'activity'];
    groups.sort((a, b) => rank.indexOf(a.object) - rank.indexOf(b.object));

    return {
        query: raw,
        groups,
        total,
        counts,
        matchedTotal,
        // True when the scan hit its ceiling, so the page can say "showing the
        // best 200 of 1,400" instead of quietly implying it found everything.
        capped: ftsCapped,
        objects: Object.entries(counts)
            .filter(([key]) => OBJECTS[key])
            .map(([key, n]) => ({ key, label: OBJECTS[key].plural, route: OBJECTS[key].route, count: n }))
            .sort((a, b) => rank.indexOf(a.key) - rank.indexOf(b.key)),
    };
}

function toMatchQuery(raw) {
    const tokens = raw
        .toLowerCase()
        .split(/[^\p{L}\p{N}@._-]+/u)
        .filter((t) => t.length >= 2)
        .slice(0, 8);
    if (!tokens.length) return null;
    // Quoted, then starred: quoting neutralises FTS5 operators inside the term,
    // and the star outside the quotes still applies prefix matching.
    return tokens.map((t) => `"${t.replace(/"/g, '')}"*`).join(' AND ');
}

/**
 * Every object with a real, own-table phone column — driven by the field
 * registry rather than a hand-kept list, the same way `searchable` decides
 * what feeds the keyword index above. `calling_assignment` is excluded by
 * `!def.route` (it is `internal: true`, route: null — a queue view over
 * `contacts`, not a record of its own) and its `phone` field is a JOINED
 * column (`c.phone`) anyway, which the `!x.column.includes('.')` guard also
 * rules out.
 */
function phoneSearchTargets() {
    const targets = [];
    for (const [key, def] of Object.entries(OBJECTS)) {
        if (def.internal || !def.route) continue;
        const field = (def.fields ?? []).find((x) => x.type === 'phone' && x.column && !x.column.includes('.'));
        if (field) targets.push({ objectKey: key, table: def.table, column: field.column });
    }
    return targets;
}

/**
 * Every record whose phone field, once stripped of spaces, hyphens,
 * parentheses, dots and a leading +, CONTAINS one of the searched digit
 * candidates — a match regardless of how either side happened to be
 * formatted, regardless of whether the stored number carries a country
 * code the search didn't (or the other way around), and regardless of
 * whether the search was typed in local form with a leading trunk zero
 * (see `phoneMatchCandidates` in lib/phone.mjs).
 */
function phoneMatches(ctx, candidates, objectFilter, cap) {
    const out = [];
    for (const target of phoneSearchTargets()) {
        if (objectFilter && target.objectKey !== objectFilter) continue;
        const expr = phoneDigitsSql(target.column);
        const clause = candidates.map(() => `${expr} LIKE ?`).join(' OR ');
        const found = all(
            `SELECT id FROM ${target.table}
              WHERE workspace_id = ? AND deleted_at IS NULL
                AND (${clause})
              LIMIT ?`,
            [ctx.workspaceId, ...candidates.map((d) => `%${d}%`), cap],
        );
        for (const row of found) out.push({ object_key: target.objectKey, record_id: row.id });
    }
    return out;
}

/**
 * The active calling-queue assignment for each of these contacts, if any —
 * one query for the whole page rather than one per result. Read-only, no
 * scoping decision of its own: the queue itself (`/api/calling/queue`) is
 * where a role's own read scope actually gets enforced, so a rep seeing
 * "on Sarah's queue" here and then being refused when they click through is
 * the correct, existing behaviour, not something this needs to pre-empt.
 */
function callingAssignments(ctx, contactIds) {
    const out = new Map();
    if (!contactIds.length) return out;
    const holes = contactIds.map(() => '?').join(',');
    const rows = all(
        `SELECT a.contact_id, a.assigned_to, u.name AS sdr_name FROM calling_assignments a
           LEFT JOIN users u ON u.id = a.assigned_to
          WHERE a.workspace_id = ? AND a.active = 1 AND a.contact_id IN (${holes})`,
        [ctx.workspaceId, ...contactIds],
    );
    for (const row of rows) out.set(row.contact_id, { sdrId: row.assigned_to, sdrName: row.sdr_name });
    return out;
}

function title(objectKey, r) {
    // prospecting_contact is the same shape as contact — a person, named by
    // full_name — and without this it fell to `r.title`, the person's JOB
    // title, which is a name only by accident.
    if (objectKey === 'contact' || objectKey === 'prospecting_contact') return r.full_name;
    if (objectKey === 'note') return String(r.body ?? '').slice(0, 90);
    return r.name ?? r.title ?? r.subject ?? r.number ?? r.id;
}

function subtitle(objectKey, r) {
    switch (objectKey) {
        // Phone leads the line on every object that has one: it is usually
        // the reason a phone-number search landed on this record at all, and
        // a result that does not show the number it matched on cannot be
        // visually confirmed against what was typed.
        case 'account': return [r.phone, r.industry, r.country, r.lifecycle_stage].filter(Boolean).join(' · ');
        case 'contact': return [r.title, r.account_name, r.phone, ...(Array.isArray(r.services) ? r.services : []), r.campaign_name, r.email].filter(Boolean).join(' · ');
        case 'prospecting_company': return [r.phone, r.industry, r.country].filter(Boolean).join(' · ');
        // hydrate() attaches the parent company as `prospect_name` here, not
        // `account_name` (see `prospect_id` in lib/repo.mjs) — the default
        // branch below reaches for the wrong key and silently drops it.
        case 'prospecting_contact': return [r.title, r.prospect_name, r.phone, r.email].filter(Boolean).join(' · ');
        case 'deal': return [r.account_name, r.stage_label, r.status].filter(Boolean).join(' · ');
        case 'campaign': return [r.status, r.channel, r.service_line_key].filter(Boolean).join(' · ');
        case 'task': return [r.status, r.account_name].filter(Boolean).join(' · ');
        case 'document': return [r.mime, r.account_name].filter(Boolean).join(' · ');
        default: return r.account_name ?? '';
    }
}

/**
 * Rebuilds the whole index.
 *
 * Needed after a bulk import that wrote rows directly, and after adding
 * `searchable` to a field — the index is a projection of the field definitions,
 * so changing them makes it stale.
 */
export async function reindexAll({ ctx }) {
    const { reindex } = await import('../lib/repo.mjs');
    let n = 0;
    for (const [objectKey, def] of Object.entries(OBJECTS)) {
        const rows = all(`SELECT id FROM ${def.table} WHERE workspace_id = ? AND deleted_at IS NULL`, [ctx.workspaceId]);
        for (const row of rows) {
            reindex(objectKey, ctx.workspaceId, row.id);
            n += 1;
        }
    }
    return { indexed: n };
}
