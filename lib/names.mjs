/**
 * Keeping full name, first name and last name honest about each other.
 *
 * ── WHY THIS IS NOT A ONE-LINER ─────────────────────────────────────────────
 *
 * `first + ' ' + last` is a Western assumption wearing a helper function. In
 * this workspace most people are named in Arabic, where three and four part
 * names are ordinary — "محمد عبدالله السالم" is not a first and a last name
 * with something spare in the middle. Splitting it to two fields and rebuilding
 * it later returns a different name to the person it belongs to.
 *
 * So the FULL NAME IS THE AUTHORITY. First and last are conveniences derived
 * from it for sorting and for saying "Hi Omar" — useful, and never allowed to
 * overwrite the real thing.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 *  · Given a full name, keep it exactly as written; fill any missing first or
 *    last from it.
 *  · Given only first and last, compose the full name from them.
 *  · Given all three, believe all three. Somebody meant it.
 *  · When first or last later changes, the full name is only re-composed if it
 *    still matches what it used to derive to — that is, if nobody has
 *    customised it. An edited full name is never silently rewritten.
 */

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/**
 * Best-effort split of a whole name.
 *
 * The first token is the given name; EVERYTHING after it is the family name.
 * That one rule already handles the cases a cleverer one gets wrong:
 * "Omar Al Ghamdi" keeps "Al Ghamdi" together, and so does
 * "Ludwig van Beethoven", because the particle simply falls on the family side
 * of the cut rather than needing to be recognised at all.
 *
 * An earlier version here kept a list of particles (al, van, de …) and walked
 * PAST them, which produced first="Omar Al", last="Ghamdi" — the exact error
 * the list was added to prevent. Fewer rules, applied to the right side.
 *
 * This is a CONVENIENCE, not a claim to have understood the name. Some names
 * genuinely cannot be halved, which is why the original is always kept intact
 * in `full_name` and this only ever fills fields that are empty.
 */
export function splitName(fullName) {
    const parts = clean(fullName).split(' ').filter(Boolean);
    if (!parts.length) return { first: '', last: '' };
    if (parts.length === 1) return { first: parts[0], last: '' };
    return { first: parts[0], last: parts.slice(1).join(' ') };
}

export function composeName(first, last) {
    return clean(`${clean(first)} ${clean(last)}`);
}

/**
 * Reconcile the three fields on a write.
 *
 *   current   the record as it stands (empty object when creating)
 *   incoming  only the fields the caller actually supplied
 *
 * Returns the values to write for whichever of the three need to change.
 * Deliberately returns nothing for fields that should stay as they are, so a
 * partial update stays partial and the audit log does not fill with no-ops.
 */
export function reconcileNames(current = {}, incoming = {}) {
    const gave = (key) => Object.prototype.hasOwnProperty.call(incoming, key);
    const out = {};

    const nextFirst = gave('first_name') ? clean(incoming.first_name) : clean(current.first_name);
    const nextLast = gave('last_name') ? clean(incoming.last_name) : clean(current.last_name);
    const currentFull = clean(current.full_name);

    if (gave('full_name') && clean(incoming.full_name)) {
        // The whole name was supplied. It wins, verbatim.
        const full = clean(incoming.full_name);
        out.full_name = full;
        const split = splitName(full);
        // Only fill the parts the caller did not state. Someone sending all
        // three has made a decision, and it is not this function's to revise.
        if (!gave('first_name') && !nextFirst) out.first_name = split.first;
        if (!gave('last_name') && !nextLast) out.last_name = split.last;
        return out;
    }

    const composed = composeName(nextFirst, nextLast);

    if (!currentFull) {
        // Nothing to protect — compose whatever the parts give.
        if (composed) out.full_name = composed;
    } else if (gave('first_name') || gave('last_name')) {
        // The parts changed. Re-compose ONLY if the stored full name was itself
        // auto-composed; a customised one is left alone.
        const wasAuto = currentFull === composeName(current.first_name, current.last_name);
        if (wasAuto && composed && composed !== currentFull) out.full_name = composed;
    }

    if (gave('first_name')) out.first_name = nextFirst;
    if (gave('last_name')) out.last_name = nextLast;
    return out;
}

/** What to display when a contact has no name at all. */
export function displayName(record) {
    return clean(record?.full_name)
        || composeName(record?.first_name, record?.last_name)
        || clean(record?.email)
        || 'Unnamed contact';
}
