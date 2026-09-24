/**
 * Filter AST -> SQL.
 *
 * A filter is a tree:
 *
 *   { op: 'and' | 'or', children: [ <group> | <condition> ] }
 *   condition = { field, operator, value }
 *
 * The same tree is produced by the filter builder in the UI, stored on saved
 * views and dynamic lists, and accepted by the API. One grammar, one compiler —
 * so a filter that works in a view works identically in a list, an export and a
 * dashboard widget.
 *
 * Everything is parameterised. Field names are resolved against the object
 * registry and never interpolated from user input, so an unknown field is an
 * error rather than an injection point.
 */
import { fieldMap, objectDef, verdictPlane } from './objects.mjs';
import { badRequest } from './http.mjs';
import { phoneDigitsSql, phoneMatchCandidates } from './phone.mjs';

const EMPTY = { op: 'and', children: [] };

export function compileFilter(objectKey, workspaceId, filter, alias) {
    const table = alias ?? objectDef(objectKey).table;
    const fields = fieldMap(objectKey, workspaceId);
    const params = [];
    const sql = compileNode(filter ?? EMPTY, { table, fields, params, objectKey });
    return { sql: sql || '1=1', params };
}

function compileNode(node, ctx) {
    if (!node || typeof node !== 'object') return '';

    if (Array.isArray(node.children)) {
        const op = String(node.op ?? 'and').toLowerCase() === 'or' ? ' OR ' : ' AND ';
        const parts = node.children.map((child) => compileNode(child, ctx)).filter(Boolean);
        if (!parts.length) return '';
        return `(${parts.join(op)})`;
    }

    return compileCondition(node, ctx);
}

function compileCondition(cond, ctx) {
    const { field: key, operator, value } = cond;
    const field = ctx.fields.get(key);
    if (!field) throw badRequest(`Unknown field "${key}" in filter.`);
    if (!field.filterable) {
        throw badRequest(
            `"${field.label}" cannot be filtered.${field.excludedBecause ? ` ${field.excludedBecause}` : ''}`,
        );
    }

    if (field.computed === 'verdict') return verdictCondition(field, operator, value, ctx);
    if (field.computed === 'calling_queue') return callingQueueCondition(operator, value, ctx);

    const expr = fieldExpression(field, ctx);
    return operatorSql(expr, field, operator, value, ctx.params);
}

/** The SQL expression that yields the field's value for a row. */
export function fieldExpression(field, ctx) {
    if (field.custom) {
        // json_extract returns the JSON value; TEXT comparison is right for
        // everything except numbers and dates, which are cast at the operator.
        return `json_extract(${ctx.table}.properties, '$."${field.property.replace(/"/g, '')}"')`;
    }
    if (!field.column) throw badRequest(`"${field.label}" has no queryable column.`);
    /**
     * A column that already names its table is used as it stands.
     *
     * The calling queue's useful fields — the contact's name and phone, the
     * company, the SDR — live in tables it joins rather than in
     * `calling_assignments`, so their definitions carry `c.full_name` and the
     * like. Prefixing those with the alias again would compile `a.c.full_name`.
     * Any object with a join can expose a filterable field this way.
     */
    if (field.column.includes('.')) return field.column;
    return `${ctx.table}.${field.column}`;
}

/**
 * `contains`/`not contains`/`starts with` against a phone field, matched
 * digit-normalized on both sides rather than as literal text — the same
 * reason global search and the calling queue's own quick search do (see
 * lib/phone.mjs): "+20 2 555 0199" and "0225550199" are one number typed
 * two ways, and a plain LIKE against the stored, formatted column only
 * ever matches the one someone happened to type identically. Without this,
 * typing a number stripped of its spaces/parens/+ into a Phone filter
 * silently matched nothing, even once the field itself accepted the whole
 * number being typed. `phoneMatchCandidates` also tries a leading trunk
 * zero stripped ("0501234567" → "501234567"), which is what makes a
 * locally-dialled number find one stored in international form.
 *
 * Empty below two digits rather than matching on an empty string —
 * `phone_digits LIKE '%%'` matches every row with ANY phone number at all,
 * which is not what a one-character search means. The caller falls back to
 * a literal LIKE in that case, same as it always has.
 */
function operatorSql(expr, field, operator, rawValue, params) {
    const numeric = ['number', 'currency', 'percent'].includes(field.type);
    const cast = (e) => (numeric ? `CAST(${e} AS REAL)` : e);
    const value = rawValue;

    switch (operator) {
        case 'is':
            if (field.type === 'checkbox') {
                params.push(truthy(value) ? 1 : 0);
                return `COALESCE(${expr}, 0) = ?`;
            }
            params.push(scalar(value));
            return `${expr} = ?`;

        case 'is_not':
            params.push(scalar(value));
            return `(${expr} IS NULL OR ${expr} <> ?)`;

        case 'contains': {
            // No tail candidates: a filter condition is exact, not a guess.
            // See the note on `includeTail` in phoneMatchCandidates.
            const candidates = field.type === 'phone' ? phoneMatchCandidates(value, { includeTail: false }) : [];
            if (candidates.length) {
                const col = phoneDigitsSql(expr);
                params.push(...candidates.map((d) => `%${d}%`));
                return `(${candidates.map(() => `${col} LIKE ?`).join(' OR ')})`;
            }
            params.push(`%${like(value)}%`);
            return `${expr} LIKE ? ESCAPE '\\'`;
        }

        case 'not_contains': {
            // No tail candidates here especially: AND-ing a guessed tail
            // match into "does not contain" would silently exclude a
            // contact whose number merely ends the same as an unrelated
            // one. See the note on `includeTail` in phoneMatchCandidates.
            const candidates = field.type === 'phone' ? phoneMatchCandidates(value, { includeTail: false }) : [];
            if (candidates.length) {
                const col = phoneDigitsSql(expr);
                params.push(...candidates.map((d) => `%${d}%`));
                return `(${expr} IS NULL OR (${candidates.map(() => `${col} NOT LIKE ?`).join(' AND ')}))`;
            }
            params.push(`%${like(value)}%`);
            return `(${expr} IS NULL OR ${expr} NOT LIKE ? ESCAPE '\\')`;
        }

        case 'starts_with': {
            const candidates = field.type === 'phone' ? phoneMatchCandidates(value, { includeTail: false }) : [];
            if (candidates.length) {
                const col = phoneDigitsSql(expr);
                params.push(...candidates.map((d) => `${d}%`));
                return `(${candidates.map(() => `${col} LIKE ?`).join(' OR ')})`;
            }
            params.push(`${like(value)}%`);
            return `${expr} LIKE ? ESCAPE '\\'`;
        }

        case 'is_empty':
            return `(${expr} IS NULL OR ${expr} = '' OR ${expr} = '[]')`;

        case 'is_not_empty':
            return `(${expr} IS NOT NULL AND ${expr} <> '' AND ${expr} <> '[]')`;

        case 'eq': params.push(num(value)); return `${cast(expr)} = ?`;
        case 'neq': params.push(num(value)); return `(${expr} IS NULL OR ${cast(expr)} <> ?)`;
        case 'gt': params.push(num(value)); return `${cast(expr)} > ?`;
        case 'gte': params.push(num(value)); return `${cast(expr)} >= ?`;
        case 'lt': params.push(num(value)); return `${cast(expr)} < ?`;
        case 'lte': params.push(num(value)); return `${cast(expr)} <= ?`;

        case 'between': {
            const [a, b] = Array.isArray(value) ? value : [null, null];
            if (numeric) {
                params.push(num(a), num(b));
                return `${cast(expr)} BETWEEN ? AND ?`;
            }
            params.push(scalar(a), endOfDay(b));
            return `${expr} BETWEEN ? AND ?`;
        }

        // Dates are stored as ISO-8601 UTC strings, which sort lexically, so a
        // day comparison is a prefix range rather than a function call — that
        // keeps the index usable.
        case 'on': {
            const day = dayOnly(value);
            params.push(day, `${day}T23:59:59.999Z`);
            return `${expr} BETWEEN ? AND ?`;
        }
        case 'before': params.push(dayOnly(value)); return `${expr} < ?`;
        case 'after': params.push(endOfDay(value)); return `${expr} > ?`;

        /**
         * The INSTANT `value` names, not the day it falls on.
         *
         * `before`/`after`/`on` exist for a person picking a date in the filter
         * builder, and widening to the whole day is right for that — nobody
         * means "before 09:14:02" when they pick a date. But a "due now" or
         * "overdue" comparison built by the server IS about the instant: a task
         * due at 6pm is not due at 10am, and truncating the cutoff to "today"
         * would count it as due six hours before it actually is. Dates are
         * stored as sortable ISO-8601 strings (see the comment on `on` above),
         * so the comparison is the value as given, unchanged.
         *
         * Deliberately absent from `OPERATORS_BY_TYPE` in lib/objects.mjs — this
         * is for a dashboard or a query built in code to hand the filter
         * compiler the exact cutoff it already computed, not a choice offered
         * in the filter builder, where "at or before this instant" is not a
         * question anyone building a filter by hand is asking.
         */
        case 'at_or_before': params.push(String(value)); return `${expr} <= ?`;
        case 'at_or_after': params.push(String(value)); return `${expr} >= ?`;

        case 'in_last_days': {
            const days = Math.max(0, Number(value) || 0);
            params.push(new Date(Date.now() - days * 864e5).toISOString(), new Date().toISOString());
            return `${expr} BETWEEN ? AND ?`;
        }
        case 'in_next_days': {
            const days = Math.max(0, Number(value) || 0);
            params.push(new Date().toISOString(), new Date(Date.now() + days * 864e5).toISOString());
            return `${expr} BETWEEN ? AND ?`;
        }

        case 'is_any_of': {
            const list = toList(value);
            if (!list.length) return '1=0';
            params.push(...list);
            return `${expr} IN (${list.map(() => '?').join(',')})`;
        }
        case 'is_none_of': {
            const list = toList(value);
            if (!list.length) return '1=1';
            params.push(...list);
            return `(${expr} IS NULL OR ${expr} NOT IN (${list.map(() => '?').join(',')}))`;
        }

        // Multi-select values are stored as a JSON array in one column, so
        // membership is an EXISTS over json_each rather than a LIKE — "billing"
        // must not match "billing_admin".
        case 'has_any_of': {
            const list = toList(value);
            if (!list.length) return '1=0';
            params.push(...list);
            return `EXISTS (SELECT 1 FROM json_each(${expr}) je WHERE je.value IN (${list.map(() => '?').join(',')}))`;
        }
        case 'has_all_of': {
            const list = toList(value);
            if (!list.length) return '1=1';
            return list.map((v) => {
                params.push(v);
                return `EXISTS (SELECT 1 FROM json_each(${expr}) je WHERE je.value = ?)`;
            }).join(' AND ');
        }
        case 'has_none_of': {
            const list = toList(value);
            if (!list.length) return '1=1';
            params.push(...list);
            return `NOT EXISTS (SELECT 1 FROM json_each(${expr}) je WHERE je.value IN (${list.map(() => '?').join(',')}))`;
        }

        default:
            throw badRequest(`Unsupported operator "${operator}" for "${field.label}".`);
    }
}

/**
 * Verdict filters.
 *
 * Two things this must get right:
 *
 *  1. UNRESOLVED means "no identity to collect against", i.e. NO current
 *     verdict row. Filtering for it has to match the absence, not a value.
 *  2. `is_none_of ['QUALIFIED']` must include accounts that were never
 *     evaluated. NOT EXISTS gives that for free; a `<>` on a LEFT JOIN would
 *     silently drop them.
 */
function verdictCondition(field, operator, value, ctx) {
    const rule = field.rule;
    // Which plane this object's verdicts live in. Hardcoding `verdicts` here is
    // what made verdict filters on a prospecting list silently return nothing.
    const plane = verdictPlane(ctx.objectKey);
    if (!plane) throw badRequest(`${ctx.objectKey} records do not carry verdicts.`);
    const { table: vt, idColumn: vid } = plane;

    const exists = (values) => {
        const list = values.filter((v) => v !== 'UNRESOLVED');
        const wantsUnresolved = values.includes('UNRESOLVED');
        const clauses = [];
        if (list.length) {
            ctx.params.push(rule, ...list);
            clauses.push(
                `EXISTS (SELECT 1 FROM ${vt} v WHERE v.${vid} = ${ctx.table}.id
                    AND v.rule_key = ? AND v.is_current = 1 AND v.verdict IN (${list.map(() => '?').join(',')}))`,
            );
        }
        if (wantsUnresolved) {
            ctx.params.push(rule);
            clauses.push(
                `NOT EXISTS (SELECT 1 FROM ${vt} v WHERE v.${vid} = ${ctx.table}.id
                    AND v.rule_key = ? AND v.is_current = 1)`,
            );
        }
        return clauses.length ? `(${clauses.join(' OR ')})` : '1=0';
    };

    switch (operator) {
        case 'is_any_of': return exists(toList(value));
        case 'is': return exists([scalar(value)]);
        case 'is_none_of': {
            const inner = exists(toList(value));
            return inner === '1=0' ? '1=1' : `NOT ${inner}`;
        }
        case 'is_not': {
            const inner = exists([scalar(value)]);
            return `NOT ${inner}`;
        }
        case 'is_not_empty':
            ctx.params.push(rule);
            return `EXISTS (SELECT 1 FROM ${vt} v WHERE v.${vid} = ${ctx.table}.id AND v.rule_key = ? AND v.is_current = 1)`;
        case 'is_empty':
            ctx.params.push(rule);
            return `NOT EXISTS (SELECT 1 FROM ${vt} v WHERE v.${vid} = ${ctx.table}.id AND v.rule_key = ? AND v.is_current = 1)`;
        default:
            throw badRequest(`Verdict fields support "is any of" and "is none of", not "${operator}".`);
    }
}

/**
 * "Cold calling queue" — whether a contact currently has a LIVE row on
 * somebody's queue (`calling_assignments.active = 1`), asked with the same
 * "is any of ['in_queue','not_in_queue']" shape every other select field
 * uses, so the filter builder needs no field-specific UI for it.
 *
 * `is_empty`/`is_not_empty` come free from `type: 'select'` (see
 * `OPERATORS.select`) — offered in the filter builder same as any other
 * select field, so they have to mean something here rather than error out
 * the moment somebody clicks the option that was sitting right there. Read
 * as "nothing found" / "something found": empty = not on the queue.
 */
function callingQueueCondition(operator, value, ctx) {
    const exists = `EXISTS (SELECT 1 FROM calling_assignments ca WHERE ca.contact_id = ${ctx.table}.id AND ca.active = 1)`;

    const matching = (list) => {
        const wantsIn = list.includes('in_queue');
        const wantsOut = list.includes('not_in_queue');
        if (wantsIn && wantsOut) return '1=1';
        if (wantsIn) return exists;
        if (wantsOut) return `NOT (${exists})`;
        return '1=0';
    };

    switch (operator) {
        case 'is_any_of': return matching(toList(value));
        case 'is_none_of': {
            const inner = matching(toList(value));
            if (inner === '1=1') return '1=0';
            if (inner === '1=0') return '1=1';
            return `NOT (${inner})`;
        }
        case 'is_not_empty': return exists;
        case 'is_empty': return `NOT (${exists})`;
        default:
            throw badRequest(`Unsupported operator "${operator}" for "Cold calling queue".`);
    }
}

/* -------------------------------------------------------------- ordering -- */

export function compileSort(objectKey, workspaceId, sort, alias) {
    const table = alias ?? objectDef(objectKey).table;
    const fields = fieldMap(objectKey, workspaceId);
    const parts = [];

    for (const entry of Array.isArray(sort) ? sort : []) {
        const field = fields.get(entry.field);
        if (!field || field.sortable === false) continue;
        const dir = String(entry.direction ?? 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';

        if (field.computed === 'verdict') {
            const plane = verdictPlane(objectKey);
            if (!plane) continue;
            // Ordered by meaning, not alphabetically: QUALIFIED, REVIEW,
            // REJECTED, then the two non-answers.
            parts.push(
                `(SELECT CASE v.verdict WHEN 'QUALIFIED' THEN 0 WHEN 'REVIEW' THEN 1 WHEN 'REJECTED' THEN 2
                                        WHEN 'UNRESOLVED' THEN 3 ELSE 4 END
                    FROM ${plane.table} v
                   WHERE v.${plane.idColumn} = ${table}.id AND v.rule_key = '${field.rule.replace(/'/g, '')}' AND v.is_current = 1
                   LIMIT 1) ${dir}`,
            );
            continue;
        }
        if (field.custom) {
            const numeric = ['number', 'currency', 'percent'].includes(field.type);
            const expr = `json_extract(${table}.properties, '$."${field.property.replace(/"/g, '')}"')`;
            parts.push(`${numeric ? `CAST(${expr} AS REAL)` : expr} ${dir}`);
            continue;
        }
        if (!field.column) continue;
        // A column that already names its table stands as it is — see
        // `fieldExpression` for why a joined field carries its own qualifier.
        const expr = field.column.includes('.') ? field.column : `${table}.${field.column}`;
        // NULLs last in both directions: an empty cell is not "smallest", it is
        // "not filled in", and it belongs at the bottom either way.
        parts.push(`(${expr} IS NULL) ASC, ${expr} ${dir}`);
    }

    return parts.length ? parts.join(', ') : null;
}

/* --------------------------------------------------------------- helpers -- */

function scalar(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (Array.isArray(v)) return v[0] ?? null;
    return v;
}

function num(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) throw badRequest(`"${v}" is not a number.`);
    return n;
}

function toList(v) {
    const list = Array.isArray(v) ? v : [v];
    return list.filter((x) => x !== null && x !== undefined && x !== '').map((x) => (typeof x === 'boolean' ? (x ? 1 : 0) : x));
}

function truthy(v) {
    return v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';
}

/** Escapes LIKE wildcards so a search for "50%" does not match everything. */
function like(v) {
    return String(v ?? '').replace(/[\\%_]/g, (c) => `\\${c}`);
}

function dayOnly(v) {
    const s = String(v ?? '');
    return s.length >= 10 ? s.slice(0, 10) : s;
}

function endOfDay(v) {
    const day = dayOnly(v);
    return day.length === 10 ? `${day}T23:59:59.999Z` : String(v ?? '');
}

export const EMPTY_FILTER = EMPTY;

/** Counts the leaf conditions in a tree, for "3 filters" chips in the UI. */
export function countConditions(node) {
    if (!node || typeof node !== 'object') return 0;
    if (Array.isArray(node.children)) return node.children.reduce((a, c) => a + countConditions(c), 0);
    return node.field ? 1 : 0;
}
