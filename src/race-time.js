// Daily race clock, in Paris time. Shared by the app (main process), server/server.js and the Cloudflare worker
// (bundled by wrangler), so everyone agrees on the race day and the 18:00 podium.

const RACE_TIME_ZONE = 'Europe/Paris';
// Taps count from midnight until this hour; the podium is frozen at that moment until the next day.
const DEFAULT_RACE_END_HOUR = 18;

const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: RACE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
});

/** Dev/testing only: BONGO_RACE_END_HOUR moves the podium (e.g. to now) on the Node server and the app. */
function raceEndHour() {
    const override = typeof process !== 'undefined' && process.env ? Number(process.env.BONGO_RACE_END_HOUR) : NaN;
    return Number.isFinite(override) ? override : DEFAULT_RACE_END_HOUR;
}

/**
 * @returns {{day: string, open: boolean, msUntilEnd: number, msUntilNextRace: number}} day as YYYY-MM-DD in
 *   Paris time, whether taps still count today, the time left before the podium (0 once it's past) and before
 *   the next race starts at midnight.
 */
function raceClock(now = new Date(), endHour = raceEndHour()) {
    const parts = {};
    for (const part of formatter.formatToParts(now)) {
        parts[part.type] = part.value;
    }
    const secondsOfDay = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
    const msUntilEnd = Math.max(0, (endHour * 3600 - secondsOfDay) * 1000 - now.getMilliseconds());
    const msUntilNextRace = (24 * 3600 - secondsOfDay) * 1000 - now.getMilliseconds();
    return { day: `${parts.year}-${parts.month}-${parts.day}`, open: msUntilEnd > 0, msUntilEnd, msUntilNextRace };
}

module.exports = { RACE_TIME_ZONE, DEFAULT_RACE_END_HOUR, raceEndHour, raceClock };
