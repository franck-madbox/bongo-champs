// Daily race leaderboard logic, shared by server/server.js (Node) and the Cloudflare worker (bundled by wrangler).
// Entries are keyed by the player's private id; only a hashed public id is ever broadcast, so nobody can
// update someone else's score by reusing their id.

const HAT_ID_REGEX = /^[a-z0-9-]{1,32}$/;
const VERSION_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
// Apps that don't report their version (1.4.1 and older).
const UNKNOWN_VERSION = '<= 1.4.1';
// Sanity cap on a day's taps (a very fast typist all day is far below this).
const MAX_DAILY_TAPS = 500000;
// Standings sent to clients: they display the top few plus themselves.
const STANDINGS_SIZE = 30;

function createBoard() {
    return { day: null, entries: new Map() };
}

/** Profile fields present in the message, sanitized (absent fields are left untouched). */
function sanitizeProfile(msg) {
    const profile = {};
    if ('name' in msg) {
        profile.name = String(msg.name || 'Champ').slice(0, 20);
    }
    if ('hue' in msg) {
        profile.hue = Math.max(0, Math.min(360, Number(msg.hue) || 0));
    }
    if ('hat' in msg) {
        profile.hat = typeof msg.hat === 'string' && HAT_ID_REGEX.test(msg.hat) ? msg.hat : null;
    }
    if (isValidVersion(msg.version)) {
        profile.version = msg.version;
    }
    return profile;
}

/**
 * Applies a 'race-join' / 'race-update' message. A new Paris day starts a fresh board.
 * Taps only count while the race is open (before the podium) and for the current day.
 * @returns {boolean} whether the board changed.
 */
function applyRaceMessage(board, privateId, publicId, msg, clock) {
    if (board.day !== clock.day) {
        board.day = clock.day;
        board.entries = new Map();
    }
    const entry = board.entries.get(privateId) || { id: publicId, name: 'Champ', hue: 0, hat: null, daily: 0 };
    Object.assign(entry, sanitizeProfile(msg));
    if (clock.open && msg.day === clock.day) {
        const daily = Math.max(0, Math.min(MAX_DAILY_TAPS, Math.floor(Number(msg.daily) || 0)));
        // Never lower a score: a stale client reconnecting must not erase taps.
        entry.daily = Math.max(entry.daily, daily);
    }
    board.entries.set(privateId, entry);
    return true;
}

/** A player leaves today's race (e.g. a test client cleaning up). */
function removeRacer(board, privateId) {
    return board.entries.delete(privateId);
}

/** Whether a value is a plain 'major.minor.patch' app version. */
function isValidVersion(version) {
    return typeof version === 'string' && VERSION_REGEX.test(version);
}

/**
 * Message broadcast to every racer: the day's best scores, best first.
 * @param {string|null} [latestVersion] newest released app version (set in the admin), so apps check for updates right away.
 */
function standingsMessage(board, clock, latestVersion = null) {
    const entries = board.day === clock.day ? Array.from(board.entries.values()) : [];
    entries.sort((a, b) => b.daily - a.daily);
    return {
        t: 'race',
        day: clock.day,
        open: clock.open,
        total: entries.length,
        // Only public fields are broadcast (the app version stays on the server, for admin stats).
        standings: entries.slice(0, STANDINGS_SIZE).map(({ id, name, hue, hat, daily }) => ({ id, name, hue, hat, daily })),
        latestVersion: isValidVersion(latestVersion) ? latestVersion : null,
    };
}

/** Admin summary of a day: players, total taps and app versions (counts only). */
function summarizeDay(board) {
    let taps = 0;
    const versions = {};
    for (const entry of board.entries.values()) {
        taps += entry.daily;
        const version = entry.version || UNKNOWN_VERSION;
        versions[version] = (versions[version] || 0) + 1;
    }
    return { day: board.day, players: board.entries.size, taps, versions };
}

/** Plain-object form for storage (Cloudflare Durable Object storage). */
function serializeBoard(board) {
    return { day: board.day, entries: Object.fromEntries(board.entries) };
}

function deserializeBoard(data) {
    return data ? { day: data.day, entries: new Map(Object.entries(data.entries || {})) } : createBoard();
}

module.exports = { createBoard, applyRaceMessage, removeRacer, standingsMessage, isValidVersion, summarizeDay, serializeBoard, deserializeBoard };
