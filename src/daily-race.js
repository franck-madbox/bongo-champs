// Daily race: today's taps (Paris time, reset at midnight, frozen at 18:00), the race strip docked on a screen
// edge (draggable, vertical on left/right edges, horizontal on top/bottom), the 18:00 podium window and the
// capsule rewards for the top 3.

const path = require('path');
const crypto = require('crypto');
const { app, BrowserWindow, screen } = require('electron');
const { RaceClient } = require('./race-client');
const { raceClock } = require('./race-time');

// Strip size: its thickness across the edge, and its length as a share of that edge.
const STRIP_THICKNESS = { vertical: 132, horizontal: 150 };
const STRIP_LENGTH_RATIO = 0.7;
const PODIUM_SIZE = { width: 560, height: 440 };
const PODIUM_VISIBLE_MS = 15 * 1000;
// Capsules won on the podium: 1st, 2nd, 3rd.
const PODIUM_REWARDS = [3, 2, 1];
const CLOCK_TICK_MS = 15 * 1000;
// Leaves the last score updates time to reach the board before asking for the final standings.
const FINAL_STANDINGS_DELAY_MS = 12 * 1000;
const STRIP_PUSH_MS = 1000;

class DailyRace {
    /**
     * @param {{store: object, getCatalog: () => object, getServerUrl: () => string,
     *          onReward: (capsules: number) => void, onStatus: (status: object) => void}} options
     *   onStatus: race open/closed changes, for the "next race" marker next to the local Champ.
     */
    constructor(options) {
        this.store = options.store;
        this.getCatalog = options.getCatalog;
        this.onReward = options.onReward;
        this.onStatus = options.onStatus;
        this.publicId = crypto.createHash('sha256').update(this.store.get().id).digest('hex').slice(0, 16);
        this.standings = null;
        this.stripWindow = null;
        this.podiumWindow = null;
        this.pushTimer = null;
        this.lastClock = raceClock();
        this.client = new RaceClient({
            getEntry: () => this.entry(),
            getServerUrl: options.getServerUrl,
            onStandings: (message) => this.handleStandings(message),
        });
    }

    start() {
        if (this.store.get().raceVisible !== false) {
            this.createStrip();
        }
        this.client.start();
        setInterval(() => this.tickClock(), CLOCK_TICK_MS);
    }

    // ---------- Today's score ----------

    /** Today's taps (0 once the Paris day changed). */
    myDaily() {
        const daily = this.store.get().daily || {};
        return daily.day === raceClock().day ? daily.count : 0;
    }

    entry() {
        const state = this.store.get();
        // The app version only feeds the admin stats (versions in use); it is never shown to other players.
        return {
            id: state.id,
            name: state.name,
            hue: state.hue,
            hat: state.hat,
            daily: this.myDaily(),
            day: raceClock().day,
            version: app.getVersion(),
        };
    }

    /** Called on every tap: counts until 18:00 Paris time. */
    registerTap() {
        const clock = raceClock();
        if (!clock.open) {
            return;
        }
        this.store.set({ daily: { day: clock.day, count: this.myDaily() + 1 } });
        this.client.markDirty();
        this.schedulePush();
    }

    /** Name, color or hat changed. */
    profileChanged() {
        this.client.markDirty();
        this.schedulePush();
    }

    serverChanged() {
        this.client.restart();
    }

    // ---------- Standings, podium, rewards ----------

    handleStandings(message) {
        this.standings = message;
        this.pushToStrip();
        const clock = raceClock();
        if (!clock.open && message.day === clock.day) {
            this.finishRace(message);
        }
    }

    /** Detects 18:00 (final standings) and midnight (fresh race). */
    tickClock() {
        const clock = raceClock();
        if (this.lastClock.open && !clock.open) {
            // Last score of the day, then the podium once the board has everyone's final numbers.
            this.client.markDirty();
            setTimeout(() => this.client.requestStandings(), FINAL_STANDINGS_DELAY_MS);
        }
        if (clock.day !== this.lastClock.day) {
            this.client.markDirty();
            this.client.requestStandings();
        }
        this.lastClock = clock;
        this.syncStripVisibility();
        this.pushToStrip();
        this.onStatus(this.status());
    }

    /** For the local Champ: the "next race" marker shows while the track is hidden (18:00 to midnight). */
    status() {
        const clock = raceClock();
        return { enabled: this.store.get().raceVisible !== false, open: clock.open, msUntilNextRace: clock.msUntilNextRace };
    }

    /** Once per day: credits the podium reward and shows the podium window. */
    finishRace(message) {
        const state = this.store.get();
        const podium = message.standings.filter((entry) => entry.daily > 0).slice(0, 3);
        if (podium.length === 0 || state.podiumShownDay === message.day) {
            return;
        }
        const rank = message.standings.findIndex((entry) => entry.id === this.publicId) + 1;
        const reward = rank >= 1 && rank <= 3 ? PODIUM_REWARDS[rank - 1] : 0;
        this.store.set({ podiumShownDay: message.day });
        if (reward > 0 && state.raceClaimedDay !== message.day) {
            this.store.set({ raceClaimedDay: message.day });
            this.onReward(reward);
        }
        this.showPodium({ podium, rank, reward, myDaily: this.myDaily(), total: message.total, day: message.day });
    }

    // ---------- Windows ----------

    /** Whether the race track is enabled (Menu > Daily race). It is still hidden between the podium and midnight. */
    isVisible() {
        return Boolean(this.stripWindow);
    }

    /** The track only shows while the race is running. */
    syncStripVisibility() {
        if (!this.stripWindow || this.stripWindow.isDestroyed()) {
            return;
        }
        const open = raceClock().open;
        if (open && !this.stripWindow.isVisible()) {
            this.stripWindow.showInactive();
        } else if (!open && this.stripWindow.isVisible()) {
            this.stripWindow.hide();
        }
    }

    setVisible(visible) {
        this.store.set({ raceVisible: visible });
        if (visible && !this.stripWindow) {
            this.createStrip();
        } else if (!visible && this.stripWindow) {
            this.stripWindow.destroy();
            this.stripWindow = null;
        }
        this.onStatus(this.status());
    }

    createStrip() {
        this.stripWindow = createOverlayWindow(this.dockBounds(), 'race.html', () => raceClock().open, true);
        this.stripWindow.webContents.on('did-finish-load', () => this.pushToStrip());
        this.stripWindow.on('closed', () => {
            this.stripWindow = null;
        });
    }

    ownsWindow(win) {
        return Boolean(win) && win === this.stripWindow;
    }

    /** Saved dock (edge + center point), or the right edge of the main screen by default. */
    dock() {
        const saved = this.store.get().raceDock;
        if (saved && ['left', 'right', 'top', 'bottom'].includes(saved.edge) && typeof saved.x === 'number') {
            return saved;
        }
        const workArea = screen.getPrimaryDisplay().workArea;
        return { edge: 'right', x: workArea.x + workArea.width, y: workArea.y + workArea.height / 2 };
    }

    orientation() {
        const edge = this.dock().edge;
        return edge === 'top' || edge === 'bottom' ? 'horizontal' : 'vertical';
    }

    /** Window bounds flush against the dock edge, 70% of that edge long, kept on the screen. */
    dockBounds(dock = this.dock()) {
        const workArea = screen.getDisplayNearestPoint({ x: Math.round(dock.x), y: Math.round(dock.y) }).workArea;
        const horizontal = dock.edge === 'top' || dock.edge === 'bottom';
        const width = horizontal ? Math.round(workArea.width * STRIP_LENGTH_RATIO) : STRIP_THICKNESS.vertical;
        const height = horizontal ? STRIP_THICKNESS.horizontal : Math.round(workArea.height * STRIP_LENGTH_RATIO);
        const clamp = (value, min, max) => Math.round(Math.max(min, Math.min(max, value)));
        let x = clamp(dock.x - width / 2, workArea.x, workArea.x + workArea.width - width);
        let y = clamp(dock.y - height / 2, workArea.y, workArea.y + workArea.height - height);
        if (dock.edge === 'left') {
            x = workArea.x;
        } else if (dock.edge === 'right') {
            x = workArea.x + workArea.width - width;
        } else if (dock.edge === 'top') {
            y = workArea.y;
        } else {
            y = workArea.y + workArea.height - height;
        }
        return { x, y, width, height };
    }

    /** After a drag: snaps to the closest edge of the screen it was dropped on (and turns if needed). */
    dockAfterDrag() {
        if (!this.stripWindow) {
            return;
        }
        const bounds = this.stripWindow.getBounds();
        const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
        const workArea = screen.getDisplayNearestPoint({ x: Math.round(center.x), y: Math.round(center.y) }).workArea;
        const distances = {
            left: center.x - workArea.x,
            right: workArea.x + workArea.width - center.x,
            top: center.y - workArea.y,
            bottom: workArea.y + workArea.height - center.y,
        };
        let edge = 'right';
        for (const candidate of Object.keys(distances)) {
            if (distances[candidate] < distances[edge]) {
                edge = candidate;
            }
        }
        this.store.set({ raceDock: { edge, x: center.x, y: center.y } });
        this.stripWindow.setBounds(this.dockBounds());
        this.pushToStrip();
    }

    /** The grab handle takes the mouse; the rest of the strip lets clicks through to the apps below. */
    setInteractive(interactive) {
        if (this.stripWindow) {
            this.stripWindow.setIgnoreMouseEvents(!interactive, { forward: true });
        }
    }

    /** Own taps refresh the strip at most once per second. */
    schedulePush() {
        if (!this.pushTimer) {
            this.pushTimer = setTimeout(() => {
                this.pushTimer = null;
                this.pushToStrip();
            }, STRIP_PUSH_MS);
        }
    }

    pushToStrip() {
        if (!this.stripWindow || this.stripWindow.isDestroyed()) {
            return;
        }
        const clock = raceClock();
        const state = this.store.get();
        const standings = this.standings && this.standings.day === clock.day ? this.standings : null;
        this.stripWindow.webContents.send('race', {
            orientation: this.orientation(),
            open: clock.open,
            msUntilEnd: clock.msUntilEnd,
            msUntilNextRace: clock.msUntilNextRace,
            total: standings ? standings.total : 0,
            standings: standings ? standings.standings : [],
            me: { id: this.publicId, name: state.name, hue: state.hue, hat: state.hat, daily: this.myDaily() },
            catalog: this.getCatalog(),
        });
    }

    showPodium(result) {
        if (this.podiumWindow && !this.podiumWindow.isDestroyed()) {
            this.podiumWindow.destroy();
        }
        const workArea = screen.getPrimaryDisplay().workArea;
        const win = createOverlayWindow({
            x: Math.round(workArea.x + (workArea.width - PODIUM_SIZE.width) / 2),
            y: Math.round(workArea.y + (workArea.height - PODIUM_SIZE.height) / 2),
            ...PODIUM_SIZE,
        }, 'podium.html', () => true);
        win.webContents.on('did-finish-load', () => {
            win.webContents.send('podium', {
                ...result,
                myId: this.publicId,
                catalog: this.getCatalog(),
                msUntilNextRace: raceClock().msUntilNextRace,
            });
        });
        setTimeout(() => {
            if (!win.isDestroyed()) {
                win.destroy();
            }
        }, PODIUM_VISIBLE_MS);
        this.podiumWindow = win;
    }
}

/**
 * Click-through, always-on-top, transparent window: it never gets in the way of work.
 * @param {() => boolean} shouldShow checked once loaded, so a hidden window never flashes on screen.
 * @param {boolean} [hoverable] keeps receiving mouse moves while click-through (for a grab handle).
 */
function createOverlayWindow(bounds, page, shouldShow, hoverable = false) {
    const win = new BrowserWindow({
        ...bounds,
        show: false,
        transparent: true,
        frame: false,
        resizable: false,
        hasShadow: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        focusable: false,
        fullscreenable: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    win.setIgnoreMouseEvents(true, { forward: hoverable });
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.loadFile(path.join(__dirname, 'renderer', page));
    win.once('ready-to-show', () => {
        if (shouldShow()) {
            win.showInactive();
        }
    });
    return win;
}

module.exports = { DailyRace, PODIUM_REWARDS };
