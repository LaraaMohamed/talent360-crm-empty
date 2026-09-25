/**
 * Phone-number normalisation for search.
 *
 * A phone number is compared as digits, never as a formatted string — the
 * same number typed with spaces, hyphens, parentheses, a leading `+` or none
 * of those is one fact recorded several different ways, and none of those
 * differences should decide whether a search finds it. FTS5's tokenizer
 * cannot be trusted for this on its own: "+971 50 123 4567" tokenizes into
 * four separate tokens while "+971501234567" tokenizes into one fused token,
 * so a query formatted differently from how the number happens to be stored
 * simply misses — see api/search.mjs for the dedicated match this feeds.
 */
import { POSTGRES } from './db.mjs';

/**
 * Arabic-Indic (٠-٩, U+0660-0669) and Extended Arabic-Indic/Persian (۰-۹,
 * U+06F0-06F9) digits, mapped to their ASCII equivalents.
 *
 * A phone number typed or pasted on an Arabic keyboard — the default input
 * in exactly the region this product's own test data is from (+20, +966) —
 * comes in these digits, not ASCII 0-9. `\d` and `\D` only ever recognise
 * ASCII digits, so without this translation first, phoneDigits() silently
 * reduces a number typed entirely in Arabic-Indic digits to an empty string
 * instead of stripping only the punctuation around it.
 */
const EASTERN_DIGITS = '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹';
function toAsciiDigits(value) {
    return String(value ?? '').replace(/[٠-٩۰-۹]/g, (ch) => String(EASTERN_DIGITS.indexOf(ch) % 10));
}

/** Strips everything but digits — the form phone numbers are compared in. */
export function phoneDigits(value) {
    return toAsciiDigits(value).replace(/\D+/g, '');
}

/**
 * Whether a raw search string should be treated as a phone-number search.
 *
 * Deliberately strict about letters (a name or an email is never a phone
 * number, so this must never intercept one) and loose about punctuation (+,
 * spaces, hyphens, parentheses, dots are all things a person types around a
 * phone number). A short run of digits is left to the normal keyword search —
 * five is enough to rule out a stray short number while still catching a
 * phone number someone has not finished typing.
 */
export function looksLikePhoneQuery(raw) {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed || /\p{L}/u.test(trimmed)) return false;
    // Arabic-Indic/Persian digits belong here alongside ASCII \d and the
    // punctuation a phone number is typed with — without them, a number
    // typed on an Arabic keyboard never reached the phone match at all.
    if (!/^[+()\-.\s\d٠-٩۰-۹]+$/.test(trimmed)) return false;
    return phoneDigits(trimmed).length >= 5;
}

/**
 * Invisible Unicode formatting characters that can end up inside a phone
 * number pasted from an RTL context — bidi marks/embeddings/isolates and
 * zero-width joiners. `phoneDigits()` (the query side) already drops these
 * for free: `\D` matches anything that is not an ASCII digit, invisible or
 * not. `phoneDigitsSql()` (the column side) had no equivalent — it only ever
 * stripped a fixed list of VISIBLE punctuation — so a stored number carrying
 * one of these silently broke the digit run into pieces no LIKE '%...%' could
 * match, even though the number looked perfectly normal on screen.
 */
const INVISIBLE_CHARS = [
    '​', '‌', '‍', '‎', '‏', '؜',
    '‪', '‫', '‬', '‭', '‮',
    '⁦', '⁧', '⁨', '⁩',
];

/**
 * `char(N)` builds the character from its Unicode code point INSIDE SQLite,
 * rather than this file writing the actual multi-byte character into the SQL
 * text. Every other REPLACE target here is one ASCII byte; these are not,
 * and the query text is what actually travels to the database — over HTTP,
 * for a hosted Turso workspace (see lib/db.mjs), not read out of a local
 * file the way it is in dev. Nothing guarantees a non-ASCII byte sequence
 * embedded in SQL text survives that trip unchanged rather than through a
 * local SQLite file handle, and this makes the question moot: the generated
 * SQL is plain ASCII, and the character exists only once the database
 * itself constructs it from a number.
 *
 * Postgres names the same function `chr`, not `char` — the one other
 * SQLite-specific name in phoneDigitsSql() below, alongside `instr`
 * (Postgres: `strpos`, same 1-indexed/0-if-absent semantics). `substr`,
 * `length`, `CAST(... AS TEXT)` and `WITH RECURSIVE` as a scalar subquery
 * are all standard SQL both engines already accept unchanged.
 */
const charSql = (ch) => `${POSTGRES ? 'chr' : 'char'}(${ch.codePointAt(0)})`;

/**
 * Characters to drop entirely: the six punctuation marks plus every
 * invisible formatting character, built via `char()`/`||` rather than a
 * chain of nested `REPLACE()` calls (see below for why).
 */
const STRIP_CHARS_SQL = [' ', '-', '(', ')', '+', '.']
    .map((ch) => `'${ch}'`)
    .concat(INVISIBLE_CHARS.map(charSql))
    .join(' || ');

/** Same construction, for the Arabic-Indic/Persian digit lookup. */
const EASTERN_DIGITS_SQL = [...EASTERN_DIGITS].map(charSql).join(' || ');

/**
 * The same normalisation, as a SQL expression over a column.
 *
 * This used to be a chain of ~40 nested `REPLACE(REPLACE(REPLACE(...)))`
 * calls, one level per character being stripped or translated. Local
 * `node:sqlite` parses that fine, but Turso's remote libSQL/Hrana parser
 * has a much lower recursion limit and throws "parser overflowed its
 * stack" on exactly this shape once nesting gets into the 40s — a
 * production-only failure invisible to all local testing, confirmed by
 * reproducing it directly against the hosted database. A flat `||` chain
 * building a lookup string is fine (same parser tolerates that far deeper),
 * so a recursive CTE walks the column one character at a time — fixed,
 * shallow SQL text regardless of how many characters it strips/translates,
 * with the actual iteration happening in the query engine, not the parser.
 */
export function phoneDigitsSql(column) {
    const instr = POSTGRES ? 'strpos' : 'instr';
    return `(WITH RECURSIVE _pd(s, i, out) AS (
        SELECT COALESCE(${column}, ''), 1, ''
        UNION ALL
        SELECT s, i + 1,
            out || (CASE
                WHEN ${instr}((${STRIP_CHARS_SQL}), substr(s, i, 1)) > 0 THEN ''
                WHEN ${instr}((${EASTERN_DIGITS_SQL}), substr(s, i, 1)) > 0
                    THEN CAST((${instr}((${EASTERN_DIGITS_SQL}), substr(s, i, 1)) - 1) % 10 AS TEXT)
                ELSE substr(s, i, 1)
            END)
        FROM _pd WHERE i <= length(s)
    ) SELECT out FROM _pd ORDER BY i DESC LIMIT 1)`;
}

/**
 * The digit strings a phone search should be tried against, in order.
 *
 * A local number is typed with a leading trunk-prefix zero — "0501234567" —
 * while the number is almost always STORED in international form,
 * "+971501234567". That zero is DROPPED, not embedded, when dialling
 * internationally, so "0501234567" is not literally a substring of
 * "971501234567" once both are reduced to digits — the search that matched
 * every other formatting difference still missed this one, silently, for
 * exactly the numbers a workspace in this region types most often.
 *
 * Trying the query a second time with that leading zero stripped is what
 * catches it, without needing to know the country code at all. Only ever
 * ADDS a candidate — the literal digits are always tried first and are
 * usually the only ones that matter.
 */
export function phoneMatchCandidates(value, { includeTail = true } = {}) {
    const digits = phoneDigits(value);
    const candidates = [digits];
    const stripped = digits.replace(/^0+/, '');
    if (stripped && stripped !== digits) candidates.push(stripped);
    /**
     * The number's tail, independent of country code OR leading zero — the
     * direction the trunk-zero fix above does not cover.
     *
     * That fix handles a LOCAL query ("0501234567") finding an INTERNATIONAL
     * stored number ("+971501234567"): strip the query's leading zero and it
     * becomes a prefix match. It does nothing for the opposite and, in a
     * workspace where numbers were entered inconsistently over months or
     * years, equally common case: an INTERNATIONAL query ("+971501234567")
     * against a number that was only ever stored LOCALLY ("0501234567") and
     * never migrated. Neither digit string is a prefix of the other, so
     * nothing above ever matched it — silently, for exactly the contacts
     * whoever typed them left in local form.
     *
     * Comparing tails instead of the whole number sidesteps needing to know
     * any actual country code: a local subscriber number is 8 or 9 digits
     * almost everywhere, so the last 8/9 digits of a fully-qualified query
     * are the same digits the local-only stored value consists of, once its
     * own leading zero is set aside. Only added when the query is LONGER
     * than the tail itself, so a short query is never turned into a
     * needlessly broad match on its own full length.
     *
     * A GUESS, not a fact — two genuinely different numbers can share an
     * 8-digit tail by coincidence, so `includeTail` defaults to true for the
     * quick-search box and the omnisearch bar (see queueSearchClause in
     * lib/calling.mjs and api/search.mjs), where a person types a whole
     * number looking for "the contact this belongs to" and can eyeball the
     * result. `false` is for the filter builder's contains/does-not-contain
     * (lib/query.mjs): there "does not contain 0500062640" excluding a
     * contact whose number is a completely different one that merely ends
     * the same way is a silent, unexplainable wrong answer — worse than
     * failing to catch a local/international formatting difference for a
     * PARTIAL query, which is what a filter condition usually is.
     */
    if (includeTail) {
        const base = stripped || digits;
        for (const tailLength of [9, 8]) {
            if (base.length > tailLength) candidates.push(base.slice(-tailLength));
        }
    }
    return [...new Set(candidates)].filter((d) => d.length >= 2);
}
