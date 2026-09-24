/**
 * Which build is running.
 *
 * "Are my changes live?" was only answerable by guessing: the code on GitHub,
 * the code on Render and the code in a browser could be three different
 * things. This reads the checked-out commit once at boot — no child process,
 * no dependency — and /api/meta ships it, so the Settings page can say
 * exactly what is serving you.
 *
 * Render also injects RENDER_GIT_COMMIT; it wins when present because on the
 * platform it is authoritative for what was actually built.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './db.mjs';

let cached;

export function getBuild() {
    if (cached !== undefined) return cached;
    cached = null;
    try {
        if (process.env.RENDER_GIT_COMMIT) {
            cached = String(process.env.RENDER_GIT_COMMIT).slice(0, 7);
        } else {
            const head = readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8').trim();
            const ref = head.startsWith('ref:')
                ? head.slice(4).trim()
                : null;
            if (ref) {
                cached = readFileSync(path.join(ROOT, '.git', ref), 'utf8').trim().slice(0, 7);
            } else {
                // Detached HEAD: the value IS the sha.
                cached = head.slice(0, 7);
            }
        }
    } catch {
        cached = null;   // no .git beside us (some deploys ship tarballs)
    }
    return cached;
}
