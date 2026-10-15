// WebSocket client for shared sessions: keeps the connection alive, batches taps, tracks peers.

const WebSocket = require('ws');

// Kept low-frequency so a whole studio stays within the free Cloudflare request quota.
const FLUSH_INTERVAL_MS = 500;
const MAX_RECONNECT_DELAY_MS = 15000;

class SessionClient {
    /**
     * @param {{getProfile: () => object, onEvent: (channel: string, payload: any) => void, onError: (message: string) => void}} options
     */
    constructor(options) {
        this.getProfile = options.getProfile;
        this.onEvent = options.onEvent;
        this.onError = options.onError;
        this.ws = null;
        this.room = null;
        this.state = 'offline';
        this.peers = new Map();
        this.pendingTaps = 0;
        this.profileDirty = false;
        this.reconnectDelay = 1000;
        this.reconnectTimer = null;
        this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    }

    getStatus() {
        return { room: this.room, state: this.state, peers: Array.from(this.peers.values()) };
    }

    join(room) {
        this.leave();
        this.room = room;
        this.connect();
    }

    leave() {
        clearTimeout(this.reconnectTimer);
        this.room = null;
        this.peers.clear();
        if (this.ws) {
            const ws = this.ws;
            this.ws = null;
            ws.removeAllListeners();
            ws.on('error', () => {});
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ t: 'leave' }));
            }
            ws.close();
        }
        this.setState('offline');
    }

    /** Called on every local tap: taps are batched and sent every FLUSH_INTERVAL_MS. */
    addTap() {
        this.pendingTaps += 1;
    }

    /** Sends an emoji reaction to the session (the server enforces the allowed set and a cooldown). */
    sendEmoji(emoji) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN && this.state === 'online') {
            this.ws.send(JSON.stringify({ t: 'emoji', e: emoji }));
        }
    }

    updateProfile() {
        this.profileDirty = true;
    }

    setState(state) {
        this.state = state;
        this.onEvent('session', this.getStatus());
    }

    connect() {
        const profile = this.getProfile();
        this.setState('connecting');

        let ws;
        try {
            // One URL per session: the Cloudflare relay routes /room/<CODE> to that session's Durable Object.
            const url = `${profile.serverUrl.replace(/\/+$/, '')}/room/${this.room}`;
            ws = new WebSocket(url, { handshakeTimeout: 8000 });
        } catch (error) {
            this.onError(`Invalid server URL: ${profile.serverUrl}`);
            this.leave();
            return;
        }
        this.ws = ws;

        ws.on('open', () => {
            this.reconnectDelay = 1000;
            const current = this.getProfile();
            ws.send(JSON.stringify({ t: 'join', room: this.room, id: current.id, name: current.name, hue: current.hue, count: current.count, hat: current.hat }));
        });

        ws.on('message', (raw) => this.handleMessage(raw));

        ws.on('close', () => {
            if (this.ws !== ws) {
                return;
            }
            this.ws = null;
            this.peers.clear();
            this.scheduleReconnect();
        });

        // 'close' always follows 'error', reconnect is handled there.
        ws.on('error', () => {});
    }

    scheduleReconnect() {
        if (!this.room) {
            return;
        }
        this.setState('reconnecting');
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    }

    handleMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return;
        }
        switch (msg.t) {
            case 'welcome':
                this.peers.clear();
                for (const peer of msg.peers) {
                    this.peers.set(peer.id, peer);
                }
                this.setState('online');
                break;
            case 'peer-join':
                this.peers.set(msg.peer.id, msg.peer);
                this.onEvent('session', this.getStatus());
                break;
            case 'peer-leave':
                this.peers.delete(msg.id);
                this.onEvent('session', this.getStatus());
                break;
            case 'peer-update':
                this.peers.set(msg.peer.id, msg.peer);
                this.onEvent('peer-update', { peer: msg.peer, taps: msg.taps });
                break;
            case 'peer-emoji':
                this.onEvent('peer-emoji', { id: msg.id, e: msg.e });
                break;
            case 'error':
                this.onError(msg.message || 'Session error.');
                this.leave();
                break;
            default:
                break;
        }
    }

    flush() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.state !== 'online') {
            this.pendingTaps = 0;
            return;
        }
        if (this.pendingTaps === 0 && !this.profileDirty) {
            return;
        }
        const profile = this.getProfile();
        this.ws.send(JSON.stringify({ t: 'update', taps: this.pendingTaps, count: profile.count, name: profile.name, hue: profile.hue, hat: profile.hat }));
        this.pendingTaps = 0;
        this.profileDirty = false;
    }
}

module.exports = { SessionClient };
