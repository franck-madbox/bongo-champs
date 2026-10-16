// Daily race connection: reports today's tap count to the shared board (<serverUrl>/race) and receives standings.
// Independent from session rooms: everyone with the app races, in a session or not.

const WebSocket = require('ws');

// Score updates are batched: at most one every UPDATE_INTERVAL_MS while tapping, plus a heartbeat
// so the board is rebuilt after a server restart. Keeps the free Cloudflare quota safe for a whole studio.
const UPDATE_INTERVAL_MS = 10 * 1000;
const HEARTBEAT_MS = 60 * 1000;
const MAX_RECONNECT_DELAY_MS = 30 * 1000;

class RaceClient {
    /**
     * @param {{getEntry: () => {id: string, name: string, hue: number, hat: string|null, daily: number, day: string},
     *          getServerUrl: () => string, onStandings: (message: object) => void}} options
     */
    constructor(options) {
        this.getEntry = options.getEntry;
        this.getServerUrl = options.getServerUrl;
        this.onStandings = options.onStandings;
        this.ws = null;
        this.dirty = false;
        this.lastSentAt = 0;
        this.reconnectDelay = 2000;
        this.reconnectTimer = null;
        this.timer = setInterval(() => this.tick(), UPDATE_INTERVAL_MS);
    }

    start() {
        this.connect();
    }

    /** Taps or profile changed: sent with the next batch. */
    markDirty() {
        this.dirty = true;
    }

    /** Asks for fresh standings (e.g. right after the podium time). */
    requestStandings() {
        this.send({ t: 'race-get' });
    }

    /** Server URL changed in Settings: reconnect. */
    restart() {
        this.close();
        this.connect();
    }

    close() {
        clearTimeout(this.reconnectTimer);
        if (this.ws) {
            const ws = this.ws;
            this.ws = null;
            ws.removeAllListeners();
            ws.on('error', () => {});
            ws.close();
        }
    }

    send(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
            return true;
        }
        return false;
    }

    connect() {
        const url = `${this.getServerUrl().replace(/\/+$/, '')}/race`;
        let ws;
        try {
            ws = new WebSocket(url, { handshakeTimeout: 8000 });
        } catch {
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;
        ws.on('open', () => {
            this.reconnectDelay = 2000;
            this.dirty = false;
            this.lastSentAt = Date.now();
            this.send({ t: 'race-join', ...this.getEntry() });
        });
        ws.on('message', (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                return;
            }
            if (msg.t === 'race') {
                this.onStandings(msg);
            }
        });
        ws.on('close', () => {
            if (this.ws === ws) {
                this.ws = null;
                this.scheduleReconnect();
            }
        });
        // 'close' always follows 'error', reconnect is handled there.
        ws.on('error', () => {});
    }

    scheduleReconnect() {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    }

    tick() {
        const heartbeatDue = Date.now() - this.lastSentAt >= HEARTBEAT_MS;
        if (!this.dirty && !heartbeatDue) {
            return;
        }
        const entry = this.getEntry();
        if (this.send({ t: 'race-update', daily: entry.daily, day: entry.day, name: entry.name, hue: entry.hue, hat: entry.hat })) {
            this.dirty = false;
            this.lastSentAt = Date.now();
        }
    }
}

module.exports = { RaceClient };
