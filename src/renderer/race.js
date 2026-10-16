// Daily race strip: mini Champs racing towards the 18:00 finish line, best score closest to it.
// Vertical when docked on a left/right edge (finish at the top), horizontal on top/bottom (finish on the right).

// Runners drawn on the track: the top MAX_RUNNERS, plus the local player wherever they rank.
const MAX_RUNNERS = 8;
// Room taken by one runner along the track, and where the track starts / ends, per orientation.
const LAYOUT = {
    vertical: { runnerSize: 52, finishSize: 84, startMargin: 26 },
    horizontal: { runnerSize: 70, finishSize: 104, startMargin: 10 },
};

const api = window.bongo;
const template = document.getElementById('champ-template');
const runnersEl = document.getElementById('runners');
/** @type {Map<string, {root: HTMLElement, champ: Champ, info: HTMLElement}>} */
const runners = new Map();
let orientation = 'vertical';
let lastData = null;
let dragging = false;

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
        // New runners start at the start line and slide to their place.
        if (orientation === 'vertical') {
            root.style.top = `${window.innerHeight}px`;
        } else {
            root.style.left = '0px';
        }
        runnersEl.appendChild(root);
        runner = { root, champ, info };
        runners.set(id, runner);
    }
    return runner;
}

/**
 * Distance of each runner from the finish line: the leader touches it, the others are proportionally further,
 * never overlapping, and never past the start of the track.
 */
function distancesFromFinish(shown) {
    const config = LAYOUT[orientation];
    const length = orientation === 'vertical' ? window.innerHeight : window.innerWidth;
    const span = Math.max(0, length - config.finishSize - config.startMargin - config.runnerSize);
    const best = Math.max(1, shown[0] ? shown[0].daily : 1);
    let previous = -Infinity;
    return shown.map((entry) => {
        let distance = (1 - entry.daily / best) * span;
        distance = Math.max(distance, previous + config.runnerSize);
        previous = distance;
        return Math.min(distance, span);
    });
}

/** Places a runner at `distance` from the finish (top edge when vertical, right end when horizontal). */
function placeRunner(root, distance) {
    const config = LAYOUT[orientation];
    if (orientation === 'vertical') {
        root.style.top = `${config.finishSize + distance}px`;
    } else {
        root.style.left = `${window.innerWidth - config.finishSize - config.runnerSize - distance}px`;
    }
}

/** Orientation follows the dock edge; runners are rebuilt so they slide in along the new axis. */
function applyOrientation(next) {
    if (next === orientation) {
        return;
    }
    orientation = next;
    document.body.classList.toggle('horizontal', orientation === 'horizontal');
    for (const runner of runners.values()) {
        runner.root.remove();
    }
    runners.clear();
}

function render(data) {
    lastData = data;
    applyOrientation(data.orientation || 'vertical');
    const countdown = document.getElementById('countdown');
    const left = formatDuration(data.msUntilEnd);
    countdown.textContent = data.open ? (left ? `${left} left` : 'Last sprint!') : '🏆 Podium!';
    countdown.classList.toggle('closed', !data.open);
    // After the podium: when the next race starts (midnight, Paris time).
    const nextRace = document.getElementById('next-race');
    const untilNext = formatDuration(data.msUntilNextRace);
    nextRace.textContent = data.open ? '' : `Next race in ${untilNext || '1 min'}`;

    const shown = selectRunners(data);
    const distances = distancesFromFinish(shown);
    const seen = new Set();
    shown.forEach((entry, index) => {
        seen.add(entry.id);
        const runner = getRunner(entry.id);
        runner.root.classList.toggle('me', entry.id === data.me.id);
        placeRunner(runner.root, distances[index]);
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

// The window is resized when it docks on another edge.
window.addEventListener('resize', () => {
    if (lastData) {
        render(lastData);
    }
});

// ---------- Drag handle: the finish line ----------
// The window lets clicks through everywhere; hovering the finish line makes it grabbable.

const handle = document.querySelector('.finish');
handle.addEventListener('mouseenter', () => api.setRaceInteractive(true));
handle.addEventListener('mouseleave', () => {
    if (!dragging) {
        api.setRaceInteractive(false);
    }
});
document.addEventListener('pointerdown', () => {
    dragging = true;
});
document.addEventListener('pointerup', () => {
    dragging = false;
    // After snapping to an edge the pointer may no longer be over the handle.
    setTimeout(() => api.setRaceInteractive(handle.matches(':hover')), 300);
});

setupWindowDrag(api, {});
