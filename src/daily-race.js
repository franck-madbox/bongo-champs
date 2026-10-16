// Daily race: today's taps (Paris time, reset at midnight, frozen at 18:00), the race strip on the right edge
// of the screen, the 18:00 podium window and the capsule rewards for the top 3.

const path = require('path');
const crypto = require('crypto');
const { BrowserWindow, screen } = require('electron');
const { RaceClient } = require('./race-client');
const { raceClock } = require('./race-time');

const STRIP_WIDTH = 132;
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
        return { id: state.id, name: state.name, hue: state.hue, hat: state.hat, daily: this.myDaily(), day: raceClock().day };
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
        const workArea = screen.getPrimaryDisplay().workArea;
        this.stripWindow = createOverlayWindow({
            x: workArea.x + workArea.width - STRIP_WIDTH,
            y: workArea.y,
            width: STRIP_WIDTH,
            height: workArea.height,
        }, 'race.html', () => raceClock().open);
        this.stripWindow.webContents.on('did-finish-load', () => this.pushToStrip());
        this.stripWindow.on('closed', () => {
            this.stripWindow = null;
        });
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
 */
function createOverlayWindow(bounds, page, shouldShow) {
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
    win.setIgnoreMouseEvents(true);
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
