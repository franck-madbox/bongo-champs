// Tiny JSON persistence for the local profile, counter and window position.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WELCOME_TOKENS } = require('./gacha');

const SAVE_DELAY_MS = 2000;

// Baked at build time from package.json "bongoServerUrl"; BONGO_SERVER_URL overrides it for local testing.
// Each user can still change it in the settings window (Advanced).
const DEFAULT_SERVER_URL = process.env.BONGO_SERVER_URL || require('../package.json').bongoServerUrl || 'ws://localhost:8787';

function defaultState() {
    return {
        id: crypto.randomUUID(),
        name: 'Champ',
        hue: 0,
        count: 0,
        // Overlay size: 'small' | 'medium' | 'large' (local only, never sent to the session).
        size: 'medium',
        // Hats: owned ids, the one worn (synced to friends), gacha tokens and play time towards the next one.
        hats: [],
        hat: null,
        tokens: WELCOME_TOKENS,
        playMs: 0,
        // Mojis won at the capsule machine (starters are implicit), and tap points spendable on capsules.
        mojis: [],
        points: 0,
        // Daily race: today's taps (Paris day), strip visibility, and the last podium shown / reward claimed.
        daily: { day: null, count: 0 },
        raceVisible: true,
        // Race strip dock: screen edge ('left' | 'right' | 'top' | 'bottom') and the strip's center point.
        raceDock: null,
        podiumShownDay: null,
        raceClaimedDay: null,
        // Only set when the user typed another server: otherwise the built-in default is used,
        // so shipping a build with a new server URL moves everyone to it.
        customServerUrl: null,
        room: null,
        // Window bounds of the local Champ, and of each friend's Champ by peer id (placed independently).
        bounds: null,
        peerPositions: {},
    };
}

class Store {
    constructor(filePath) {
        this.filePath = filePath;
        this.saveTimer = null;
        this.state = defaultState();
        try {
            const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            // Older versions persisted the effective URL as "serverUrl": ignore it.
            delete saved.serverUrl;
            this.state = { ...this.state, ...saved };
        } catch {
            // First launch or unreadable file: keep defaults.
        }
        this.state.serverUrl = this.state.customServerUrl || DEFAULT_SERVER_URL;
        this.flush();
    }

    /** Current state; "serverUrl" is the effective server (custom one or default). */
    get() {
        return this.state;
    }

    set(patch) {
        this.state = { ...this.state, ...patch };
        if ('serverUrl' in patch) {
            const url = patch.serverUrl || DEFAULT_SERVER_URL;
            this.state.customServerUrl = url === DEFAULT_SERVER_URL ? null : url;
            this.state.serverUrl = url;
        }
        this.scheduleSave();
    }

    /** Increments the lifetime tap counter (and the spendable tap points) and returns the new count. */
    increment() {
        this.state.count += 1;
        this.state.points += 1;
        this.scheduleSave();
        return this.state.count;
    }

    scheduleSave() {
        if (this.saveTimer) {
            return;
        }
        this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    }

    flush() {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            const persisted = { ...this.state };
            delete persisted.serverUrl;
            fs.writeFileSync(this.filePath, JSON.stringify(persisted, null, 2));
        } catch (error) {
            console.error('Failed to save settings', error);
        }
    }
}

module.exports = { Store };
