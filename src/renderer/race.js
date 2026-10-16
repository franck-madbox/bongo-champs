// Daily race strip: mini Champs climbing towards the 18:00 finish line, best score at the top.

// Runners drawn on the track: the top MAX_RUNNERS, plus the local player wherever they rank.
const MAX_RUNNERS = 8;
const RUNNER_HEIGHT = 52;
const TRACK_TOP = 84;
const TRACK_BOTTOM_MARGIN = 26;

const api = window.bongo;
const template = document.getElementById('champ-template');
const runnersEl = document.getElementById('runners');
/** @type {Map<string, {root: HTMLElement, champ: Champ, info: HTMLElement}>} */
const runners = new Map();

/** "4h12", "12 min" or null under a minute. */
function formatDuration(ms) {
    const minutes = Math.floor(ms / 60000);
    if (minutes >= 60) {
        return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`;
    }
    return minutes >= 1 ? `${minutes} min` : null;
}

/** Standings with the local player's live score, ranked; keeps the top ones plus the local player. */
function selectRunners(data) {
    const entries = data.standings.filter((entry) => entry.id !== data.me.id);
    const serverMe = data.standings.find((entry) => entry.id === data.me.id);
    // The local count is ahead of the board between two batched updates.
    entries.push({ ...data.me, daily: Math.max(data.me.daily, serverMe ? serverMe.daily : 0) });
    entries.sort((a, b) => b.daily - a.daily);
    const ranked = entries.map((entry, index) => ({ ...entry, rank: index + 1 }));
    const shown = ranked.slice(0, MAX_RUNNERS);
    if (!shown.some((entry) => entry.id === data.me.id)) {
        shown.push(ranked.find((entry) => entry.id === data.me.id));
    }
    return shown;
}

function getRunner(id) {
    let runner = runners.get(id);
    if (!runner) {
        const root = document.createElement('div');
        root.className = 'runner';
        const mini = document.createElement('div');
        mini.className = 'mini';
        const champ = new Champ(template, { isMe: false });
        mini.appendChild(champ.root);
        const info = document.createElement('div');
        info.className = 'info';
        root.append(mini, info);
        // New runners start at the bottom and slide to their place.
        root.style.top = `${window.innerHeight}px`;
        runnersEl.appendChild(root);
        runner = { root, champ, info };
        runners.set(id, runner);
    }
    return runner;
}

/** Leader near the finish line, others proportionally lower, never overlapping. */
function layout(shown) {
    const trackBottom = window.innerHeight - TRACK_BOTTOM_MARGIN - RUNNER_HEIGHT;
    const span = Math.max(0, trackBottom - TRACK_TOP);
    const best = Math.max(1, shown[0] ? shown[0].daily : 1);
    let previousTop = -Infinity;
    return shown.map((entry) => {
        let top = TRACK_TOP + (1 - entry.daily / best) * span;
        top = Math.max(top, previousTop + RUNNER_HEIGHT);
        previousTop = top;
        return Math.min(top, trackBottom);
    });
}

function render(data) {
    const countdown = document.getElementById('countdown');
    const left = formatDuration(data.msUntilEnd);
    countdown.textContent = data.open ? (left ? `${left} left` : 'Last sprint!') : '🏆 Podium!';
    countdown.classList.toggle('closed', !data.open);
    // After the podium: when the next race starts (midnight, Paris time).
    const nextRace = document.getElementById('next-race');
    const untilNext = formatDuration(data.msUntilNextRace);
    nextRace.textContent = data.open ? '' : `Next race in ${untilNext || '1 min'}`;

    const shown = selectRunners(data);
    const tops = layout(shown);
    const seen = new Set();
    shown.forEach((entry, index) => {
        seen.add(entry.id);
        const runner = getRunner(entry.id);
        runner.root.classList.toggle('me', entry.id === data.me.id);
        runner.root.style.top = `${tops[index]}px`;
        runner.champ.setHue(entry.hue);
        runner.champ.setHat(hatFile(data.catalog, entry.hat));
        runner.info.textContent = '';
        const rank = document.createElement('span');
        rank.className = `rank r${entry.rank}`;
        rank.textContent = `#${entry.rank}`;
        const taps = document.createElement('div');
        taps.className = 'taps';
        taps.textContent = entry.daily.toLocaleString();
        const who = document.createElement('div');
        who.className = 'who';
        who.textContent = entry.id === data.me.id ? 'You' : entry.name;
        runner.info.append(rank, taps, who);
    });
    for (const [id, runner] of runners) {
        if (!seen.has(id)) {
            runner.root.remove();
            runners.delete(id);
        }
    }
}

api.on('race', render);
