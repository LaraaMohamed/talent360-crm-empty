/**
 * Reading and writing .docx packages, with no dependencies.
 *
 * A .docx is a ZIP of XML parts. Generating one faithfully does not require a
 * document library — it requires leaving the template alone. Everything that
 * carries the design (styles.xml, theme, headers, footers, embedded fonts, the
 * images, numbering, section properties) is copied through **as its original
 * compressed bytes**, and only `word/document.xml` is decompressed, edited and
 * re-deflated.
 *
 * That is the whole reason this file exists rather than a dependency: byte-level
 * passthrough is both the simplest implementation and the strongest fidelity
 * guarantee available. Nothing can drift in a part we never decode.
 *
 * `node:zlib` provides raw deflate/inflate, which is exactly what ZIP method 8
 * stores. The rest is header bookkeeping.
 *
 * Not supported, deliberately, because Word does not produce them here:
 * ZIP64 archives and encrypted entries. Both throw rather than silently
 * producing a file that opens wrong somewhere else.
 */
import zlib from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/* ------------------------------------------------------------------ crc32 -- */

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

export function crc32(buf) {
    let c = 0 ^ -1;
    for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
    return (c ^ -1) >>> 0;
}

/* ------------------------------------------------------------------- read -- */

/**
 * Parses a .docx (or any ZIP) into its entries.
 *
 * The central directory is the authority on names, sizes and CRCs — not the
 * local headers, which may carry zeroes when a data descriptor was used. Each
 * entry keeps its RAW compressed bytes so it can be written back out untouched.
 *
 * @param {Buffer} buffer
 * @returns {{entries: Array, byName: Map<string, object>}}
 */
export function readZip(buffer) {
    const eocdOffset = findEocd(buffer);
    if (eocdOffset < 0) throw new Error('Not a ZIP file: no end-of-central-directory record found.');

    if (buffer.readUInt32LE(eocdOffset - 20) === SIG_ZIP64_EOCD) {
        throw new Error('ZIP64 archives are not supported.');
    }

    const entryCount = buffer.readUInt16LE(eocdOffset + 10);
    let offset = buffer.readUInt32LE(eocdOffset + 16);

    const entries = [];
    for (let i = 0; i < entryCount; i++) {
        if (buffer.readUInt32LE(offset) !== SIG_CENTRAL) {
            throw new Error(`Corrupt ZIP: expected a central directory entry at byte ${offset}.`);
        }
        const flags = buffer.readUInt16LE(offset + 8);
        if (flags & 0x1) throw new Error('Encrypted ZIP entries are not supported.');

        const method = buffer.readUInt16LE(offset + 10);
        const modTime = buffer.readUInt16LE(offset + 12);
        const modDate = buffer.readUInt16LE(offset + 14);
        const crc = buffer.readUInt32LE(offset + 16);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const uncompressedSize = buffer.readUInt32LE(offset + 24);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localOffset = buffer.readUInt32LE(offset + 42);
        const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

        // The local header's own name/extra lengths are what locate the data —
        // the central directory's extra field is frequently a different length.
        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;

        entries.push({
            name,
            method,
            flags,
            modTime,
            modDate,
            crc,
            compressedSize,
            uncompressedSize,
            compressed: buffer.subarray(dataStart, dataStart + compressedSize),
        });

        offset += 46 + nameLength + extraLength + commentLength;
    }

    return { entries, byName: new Map(entries.map((e) => [e.name, e])) };
}

/** Decompresses one entry to a Buffer. */
export function readEntry(entry) {
    if (entry.method === METHOD_STORE) return Buffer.from(entry.compressed);
    if (entry.method === METHOD_DEFLATE) return zlib.inflateRawSync(entry.compressed);
    throw new Error(`Unsupported ZIP compression method ${entry.method} for "${entry.name}".`);
}

/** Reads one named part as UTF-8 text. Throws if the part is absent. */
export function readPart(zip, name) {
    const entry = zip.byName.get(name);
    if (!entry) throw new Error(`This .docx has no "${name}" part — it may not be a Word document.`);
    return readEntry(entry).toString('utf8');
}

/* ------------------------------------------------------------------ write -- */

/**
 * Writes entries back out, in their original order.
 *
 * `replacements` maps a part name to new UTF-8 content; every other entry is
 * emitted with the exact compressed bytes, CRC and timestamps it arrived with.
 * Entry order is preserved because `[Content_Types].xml` must come first for
 * some consumers, and because a diff against the template stays readable.
 *
 * @param {{entries: Array}} zip From readZip.
 * @param {Object<string, string|Buffer>} replacements
 * @returns {Buffer}
 */
export function writeZip(zip, replacements = {}) {
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const entry of zip.entries) {
        const replacement = replacements[entry.name];

        let method = entry.method;
        let crc = entry.crc;
        let compressed = entry.compressed;
        let uncompressedSize = entry.uncompressedSize;

        if (replacement !== undefined) {
            const raw = Buffer.isBuffer(replacement) ? replacement : Buffer.from(replacement, 'utf8');
            method = METHOD_DEFLATE;
            crc = crc32(raw);
            uncompressedSize = raw.length;
            compressed = zlib.deflateRawSync(raw, { level: 9 });
        }

        const nameBuf = Buffer.from(entry.name, 'utf8');
        // Bit 3 (data descriptor) is cleared: every size and CRC is known here
        // and written in the header, so a trailing descriptor would be a lie.
        const flags = entry.flags & ~0x8;

        const local = Buffer.alloc(30);
        local.writeUInt32LE(SIG_LOCAL, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(entry.modTime, 10);
        local.writeUInt16LE(entry.modDate, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(uncompressedSize, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);

        chunks.push(local, nameBuf, compressed);

        const cdir = Buffer.alloc(46);
        cdir.writeUInt32LE(SIG_CENTRAL, 0);
        cdir.writeUInt16LE(20, 4);
        cdir.writeUInt16LE(20, 6);
        cdir.writeUInt16LE(flags, 8);
        cdir.writeUInt16LE(method, 10);
        cdir.writeUInt16LE(entry.modTime, 12);
        cdir.writeUInt16LE(entry.modDate, 14);
        cdir.writeUInt32LE(crc, 16);
        cdir.writeUInt32LE(compressed.length, 20);
        cdir.writeUInt32LE(uncompressedSize, 24);
        cdir.writeUInt16LE(nameBuf.length, 28);
        cdir.writeUInt32LE(offset, 42);
        central.push(Buffer.concat([cdir, nameBuf]));

        offset += local.length + nameBuf.length + compressed.length;
    }

    const centralBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(zip.entries.length, 8);
    eocd.writeUInt16LE(zip.entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);

    return Buffer.concat([...chunks, centralBuf, eocd]);
}

/* ---------------------------------------------------------------- helpers -- */

/**
 * Finds the end-of-central-directory record.
 *
 * Scanned backwards because the record is last, and its 22-byte fixed part may
 * be followed by a variable comment. 64KB is the maximum a comment can be.
 */
function findEocd(buffer) {
    const start = Math.max(0, buffer.length - 22 - 0xffff);
    for (let i = buffer.length - 22; i >= start; i--) {
        if (buffer.readUInt32LE(i) === SIG_EOCD) return i;
    }
    return -1;
}
