/**
 * CSV in and out — re-exported from the qualifier's own parser rather than
 * written again.
 *
 * That file has already been hardened against real lead lists: duplicate column
 * names, blank column names, Arabic, embedded newlines, doubled quotes and a
 * BOM built from its code point (a literal BOM in source is invisible in every
 * editor and diff, and this project has already lost time to an invisible byte
 * in exactly that regex). A second implementation here would be a second set of
 * those bugs.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { QUALIFIER_LIB } from './qualification.mjs';

let mod = null;

export async function csv() {
    if (!mod) mod = await import(pathToFileURL(path.join(QUALIFIER_LIB, 'csv.mjs')).href);
    return mod;
}

/** Serialises rows of objects to CSV, header order fixed by `columns`. */
export async function toCsvRows(columns, rows, valueOf) {
    const { toCsv } = await csv();
    return toCsv(
        columns.map((c) => c.label),
        rows.map((row) => columns.map((c) => valueOf(row, c))),
    );
}
