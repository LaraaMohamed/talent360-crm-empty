/**
 * Named date ranges, resolved in the WORKSPACE'S timezone.
 *
 * "How many deals did I win today" is a question about a day in Riyadh, not a
 * day in UTC. Three hours of every night belong to the wrong day if you resolve
 * it anywhere else, and the answer changes depending on when you ask — which is
 * exactly the kind of number a dashboard should never produce.
 *
 * Timestamps in the database are ISO-8601 UTC. A range is therefore a pair of
 * UTC instants: `from` inclusive, `to` EXCLUSIVE, so a month boundary belongs to
 * one month rather than being counted in both or neither.
 */

export const PRESETS = ['today', 'week', 'month', 'quarter', 'year', 'all', 'custom'];

const LABELS = {
    today: 'Today',
    week: 'This week',
    month: 'This month',
    quarter: 'This quarter',
    year: 'This year',
    all: 'All time',
};

/**
 * How far the given instant's local time is ahead of UTC, in milliseconds.
 *
 * Asked of the instant rather than assumed, so a zone that changes offset
 * during the year answers correctly on both sides of the change. (Riyadh never
 * does; plenty of places do, and the cost of being right is four lines.)
 */
function offsetMs(instant, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(instant).reduce((acc, p) => {
        if (p.type !== 'literal') acc[p.type] = Number(p.value);
        return acc;
    }, {});

    const asUtc = Date.UTC(
        parts.year, parts.month - 1, parts.day,
        parts.hour % 24, parts.minute, parts.second,
    );
    return asUtc - instant.getTime();
}

/** The local calendar parts of an instant, in the given zone. */
function localParts(instant, timeZone) {
    const shifted = new Date(instant.getTime() + offsetMs(instant, timeZone));
    return {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth(),
        day: shifted.getUTCDate(),
        weekday: shifted.getUTCDay(),
    };
}

/** The UTC instant of local midnight on the given local date. */
function startOfLocalDay({ year, month, day }, timeZone) {
    const guess = Date.UTC(year, month, day, 0, 0, 0);
    // The offset has to be measured near the target, not at "now" — otherwise a
    // range that spans a clock change is built with the wrong one.
    const offset = offsetMs(new Date(guess), timeZone);
    return new Date(guess - offset);
}

function addDays(parts, n) {
    const d = new Date(Date.UTC(parts.year, parts.month, parts.day + n));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() };
}

/**
 * Which weekday a week starts on, derived from the workspace's weekend rather
 * than assumed. Weekend [5,6] (Friday, Saturday) means the week starts Sunday;
 * [6,0] means it starts Monday.
 */
export function weekStartsOn(weekendDays) {
    const weekend = Array.isArray(weekendDays) ? weekendDays.map(Number).filter((d) => d >= 0 && d <= 6) : [];
    if (!weekend.length) return 1;
    for (let start = 0; start < 7; start += 1) {
        // The first day that is NOT a weekend day and whose previous day IS.
        const previous = (start + 6) % 7;
        if (!weekend.includes(start) && weekend.includes(previous)) return start;
    }
    return 1;
}

/**
 * Resolve a requested range into instants.
 *
 * `to` is exclusive and always the END of the period, not "now" — asking for
 * this month on the 10th gives the whole month, so a widget can say "3 won of a
 * month that is not over" rather than silently comparing a third of a month
 * against a whole one.
 */
export function resolveRange(input = {}, { timeZone = 'UTC', weekendDays = [5, 6], now = new Date() } = {}) {
    const preset = PRESETS.includes(input.preset) ? input.preset : 'month';

    if (preset === 'all') {
        return { preset, from: null, to: null, label: LABELS.all };
    }

    if (preset === 'custom') {
        const from = dayStart(input.from, timeZone);
        const to = dayEnd(input.to, timeZone);
        if (!from || !to) {
            // An incomplete custom range is a request nobody can answer; fall
            // back rather than inventing a boundary.
            return resolveRange({ preset: 'month' }, { timeZone, weekendDays, now });
        }
        // Labelled from what was asked for, not from the instants: the local
        // day 2026-08-01 starts at 2026-07-31T21:00Z in Riyadh, and a label
        // reading "31 July" for a range someone asked to start on 1 August is
        // the kind of off-by-one that makes people distrust the whole number.
        return {
            preset,
            from,
            to,
            label: `${String(input.from).slice(0, 10)} – ${String(input.to).slice(0, 10)}`,
        };
    }

    const today = localParts(now, timeZone);
    let startParts;
    let endParts;

    if (preset === 'today') {
        startParts = today;
        endParts = addDays(today, 1);
    } else if (preset === 'week') {
        const start = weekStartsOn(weekendDays);
        const back = (today.weekday - start + 7) % 7;
        startParts = addDays(today, -back);
        endParts = addDays(startParts, 7);
    } else if (preset === 'month') {
        startParts = { year: today.year, month: today.month, day: 1 };
        endParts = { year: today.year, month: today.month + 1, day: 1 };
    } else if (preset === 'quarter') {
        const q = Math.floor(today.month / 3) * 3;
        startParts = { year: today.year, month: q, day: 1 };
        endParts = { year: today.year, month: q + 3, day: 1 };
    } else {
        startParts = { year: today.year, month: 0, day: 1 };
        endParts = { year: today.year + 1, month: 0, day: 1 };
    }

    return {
        preset,
        from: startOfLocalDay(startParts, timeZone).toISOString(),
        to: startOfLocalDay(endParts, timeZone).toISOString(),
        label: LABELS[preset],
    };
}

function dayStart(value, timeZone) {
    const day = String(value ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const [year, month, d] = day.split('-').map(Number);
    return startOfLocalDay({ year, month: month - 1, day: d }, timeZone).toISOString();
}

function dayEnd(value, timeZone) {
    const day = String(value ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const [year, month, d] = day.split('-').map(Number);
    // Exclusive: the instant the following local day begins.
    return startOfLocalDay({ year, month: month - 1, day: d + 1 }, timeZone).toISOString();
}

