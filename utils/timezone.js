// Time-zone helpers built on Intl (no extra dependency).
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidTimeZone(tz) {
    if (typeof tz !== "string" || !tz || tz.length > 64) return false;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
    } catch (_) {
        return false;
    }
}

const isValidTime = (t) => typeof t === "string" && TIME_RE.test(t);

const pad = (n) => String(n).padStart(2, "0");

// Wall-clock parts of `date` in the zone `tz`.
function localParts(date, tz) {
    const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz, hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const o = {};
    for (const p of fmt.formatToParts(date)) o[p.type] = p.value;
    const year = +o.year, month = +o.month, day = +o.day;
    const hour = +o.hour % 24, minute = +o.minute, second = +o.second;
    return {
        year, month, day, hour, minute, second,
        dateKey: `${year}-${pad(month)}-${pad(day)}`,   // YYYY-MM-DD in the user's zone
        timeKey: `${pad(hour)}:${pad(minute)}`,         // HH:MM in the user's zone
    };
}

// The instant at which the local day of `date` started in `tz` (handles DST).
function startOfLocalDay(date, tz) {
    const p = localParts(date, tz);
    const midnightAsUTC = Date.UTC(p.year, p.month - 1, p.day);
    let guess = midnightAsUTC - (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000);
    for (let i = 0; i < 2; i++) {
        const q = localParts(new Date(guess), tz);
        const offset = Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second) - Math.floor(guess / 1000) * 1000;
        guess = midnightAsUTC - offset;
    }
    return new Date(guess);
}

const minutesOf = (hhmm) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);

module.exports = { isValidTimeZone, isValidTime, localParts, startOfLocalDay, minutesOf };
