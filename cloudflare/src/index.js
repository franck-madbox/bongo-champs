// Bongo Champs relay on Cloudflare Workers.
// Each session is one Durable Object (looked up by its code), clients connect to wss://<host>/room/<CODE>.
// Same message protocol as server/server.js. Only counts, hats and emoji reactions are transmitted: no key codes, no text.

import { DurableObject } from 'cloudflare:workers';
import { raceClock } from '../../src/race-time.js';
import { applyRaceMessage, removeRacer, standingsMessage, serializeBoard, deserializeBoard } from '../../src/race-board.js';

const MAX_PLAYERS_PER_ROOM = 16;
const MAX_TAPS_PER_UPDATE = 100;
const ROOM_PATH_REGEX = /^\/room\/([A-Za-z0-9]{4,8})\/?$/;
const HAT_ID_REGEX = /^[a-z0-9-]{1,32}$/;
// Emoji reactions: Moji ids (catalog in src/catalog.js) or the standard emojis sent by 1.1.0 apps.
// Keep in sync with server/server.js and src/renderer/overlay.js.
const LEGACY_EMOJIS = ['😂', '🔥', '👍', '❤️', '😮', '🎉', '💀', '👋'];
const MOJI_ID_REGEX = /^[a-z0-9-]{1,32}$/;
const EMOJI_COOLDOWN_MS = 1500;
// Daily race: one Durable Object for everyone. Saved at most once per RACE_SAVE_MS (free-plan write quota);
// clients re-send their score regularly, so a restart loses nothing.
const RACE_SAVE_MS = 60 * 1000;
const RACE_BROADCAST_MS = 2000;

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === '/health') {
            return Response.json({ ok: true });
        }

        if (url.pathname === '/race') {
            if (request.headers.get('Upgrade') !== 'websocket') {
                return new Response('Expected a WebSocket upgrade', { status: 426 });
            }
            return env.RACE.get(env.RACE.idFromName('global')).fetch(request);
        }

        const match = ROOM_PATH_REGEX.exec(url.pathname);
        if (!match) {
            return new Response('Bongo Champs relay server', { status: 200 });
        }
        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('Expected a WebSocket upgrade', { status: 426 });
        }

        const roomCode = match[1].toUpperCase();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(roomCode));
        return stub.fetch(request);
    },
};

function isAllowedEmoji(emoji) {
    return LEGACY_EMOJIS.includes(emoji) || (typeof emoji === 'string' && MOJI_ID_REGEX.test(emoji));
}

/** Sanitizes the public profile fields a client is allowed to set. */
function sanitizePeer(id, data) {
    return {
        id,
        name: String(data.name || 'Champ').slice(0, 20),
        hue: Math.max(0, Math.min(360, Number(data.hue) || 0)),
        count: Math.max(0, Math.floor(Number(data.count) || 0)),
        hat: typeof data.hat === 'string' && HAT_ID_REGEX.test(data.hat) ? data.hat : null,
    };
}

/**
 * One session. Uses the WebSocket Hibernation API: the object is evicted from memory between messages,
 * so each socket keeps its own state in its attachment ({ room, peer }).
 */
export class Room extends DurableObject {
    async fetch(request) {
        const roomCode = ROOM_PATH_REGEX.exec(new URL(request.url).pathname)[1].toUpperCase();
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ room: roomCode, peer: null });
        return new Response(null, { status: 101, webSocket: client });
    }

    /** Sockets that completed a join, with their attachment. */
    joinedSockets() {
        const result = [];
        for (const ws of this.ctx.getWebSockets()) {
            const attachment = ws.deserializeAttachment();
            if (attachment && attachment.peer) {
                result.push({ ws, attachment });
            }
        }
        return result;
    }

    send(ws, message) {
        try {
            ws.send(JSON.stringify(message));
        } catch {
            // Socket already closing: ignore.
        }
    }

    broadcast(message, exceptWs) {
        const payload = JSON.stringify(message);
        for (const { ws } of this.joinedSockets()) {
            if (ws !== exceptWs) {
                try {
                    ws.send(payload);
                } catch {
                    // Socket already closing: ignore.
                }
            }
        }
    }

    async webSocketMessage(ws, raw) {
        let msg;
        try {
            msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
        } catch {
            return;
        }
        switch (msg.t) {
            case 'join':
                this.handleJoin(ws, msg);
                break;
            case 'update':
                this.handleUpdate(ws, msg);
                break;
            case 'emoji':
                this.handleEmoji(ws, msg);
                break;
            case 'leave':
                this.leave(ws);
                break;
            default:
                break;
        }
    }

    handleJoin(ws, msg) {
        const attachment = ws.deserializeAttachment();
        const peerId = String(msg.id || '').slice(0, 64);
        if (String(msg.room || '').toUpperCase() !== attachment.room || !peerId) {
            this.send(ws, { t: 'error', code: 'bad-request', message: 'Invalid session code.' });
            return;
        }

        // Same player reconnecting (e.g. after a network drop): silently drop the stale socket.
        for (const other of this.joinedSockets()) {
            if (other.ws !== ws && other.attachment.peer.id === peerId) {
                other.ws.serializeAttachment({ room: attachment.room, peer: null });
                try {
                    other.ws.close(4000, 'replaced');
                } catch {
                    // Already closed.
                }
            }
        }

        const peers = [];
        for (const other of this.joinedSockets()) {
            if (other.ws !== ws) {
                peers.push(other.attachment.peer);
            }
        }
        if (peers.length >= MAX_PLAYERS_PER_ROOM) {
            this.send(ws, { t: 'error', code: 'room-full', message: 'This session is full.' });
            return;
        }

        const peer = sanitizePeer(peerId, msg);
        ws.serializeAttachment({ room: attachment.room, peer });
        this.send(ws, { t: 'welcome', room: attachment.room, peers });
        this.broadcast({ t: 'peer-join', peer }, ws);
    }

    handleUpdate(ws, msg) {
        const attachment = ws.deserializeAttachment();
        if (!attachment.peer) {
            return;
        }
        const peer = sanitizePeer(attachment.peer.id, { ...attachment.peer, ...msg });
        ws.serializeAttachment({ ...attachment, peer });
        const taps = Math.max(0, Math.min(MAX_TAPS_PER_UPDATE, Math.floor(Number(msg.taps) || 0)));
        this.broadcast({ t: 'peer-update', peer, taps }, ws);
    }

    /** Relays an emoji reaction from the allowed set, at most one per EMOJI_COOLDOWN_MS per player. */
    handleEmoji(ws, msg) {
        const attachment = ws.deserializeAttachment();
        if (!attachment.peer || !isAllowedEmoji(msg.e)) {
            return;
        }
        const now = Date.now();
        if (attachment.lastEmojiAt && now - attachment.lastEmojiAt < EMOJI_COOLDOWN_MS) {
            return;
        }
        ws.serializeAttachment({ ...attachment, lastEmojiAt: now });
        this.broadcast({ t: 'peer-emoji', id: attachment.peer.id, e: msg.e }, ws);
    }

    leave(ws) {
        const attachment = ws.deserializeAttachment();
        if (!attachment || !attachment.peer) {
            return;
        }
        ws.serializeAttachment({ ...attachment, peer: null });
        this.broadcast({ t: 'peer-leave', id: attachment.peer.id }, ws);
    }

    async webSocketClose(ws) {
        this.leave(ws);
        try {
            ws.close(1000, 'bye');
        } catch {
            // Already closed.
        }
    }

    async webSocketError(ws) {
        this.leave(ws);
    }
}

/** Public id broadcast in standings: a hash, so the private id stays secret. Same as server/server.js. */
async function publicRaceId(privateId) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(privateId));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/** The daily race board shared by all Madbox players. */
export class Race extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.board = deserializeBoard(null);
        this.lastBroadcast = 0;
        this.broadcastTimer = null;
        ctx.blockConcurrencyWhile(async () => {
            this.board = deserializeBoard(await ctx.storage.get('board'));
        });
    }

    async fetch() {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ privateId: null, publicId: null });
        return new Response(null, { status: 101, webSocket: client });
    }

    send(ws, message) {
        try {
            ws.send(JSON.stringify(message));
        } catch {
            // Socket already closing: ignore.
        }
    }

    broadcast() {
        clearTimeout(this.broadcastTimer);
        this.broadcastTimer = null;
        this.lastBroadcast = Date.now();
        const payload = standingsMessage(this.board, raceClock());
        for (const ws of this.ctx.getWebSockets()) {
            this.send(ws, payload);
        }
    }

    /** At most one standings broadcast every RACE_BROADCAST_MS, the latest state always goes out. */
    scheduleBroadcast() {
        const wait = RACE_BROADCAST_MS - (Date.now() - this.lastBroadcast);
        if (wait <= 0) {
            this.broadcast();
        } else if (!this.broadcastTimer) {
            this.broadcastTimer = setTimeout(() => this.broadcast(), wait);
        }
    }

    async scheduleSave() {
        if ((await this.ctx.storage.getAlarm()) === null) {
            await this.ctx.storage.setAlarm(Date.now() + RACE_SAVE_MS);
        }
    }

    async alarm() {
        await this.ctx.storage.put('board', serializeBoard(this.board));
    }

    async webSocketMessage(ws, raw) {
        let msg;
        try {
            msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
        } catch {
            return;
        }
        const clock = raceClock();
        if (msg.t === 'race-get') {
            this.send(ws, standingsMessage(this.board, clock));
            return;
        }
        let attachment = ws.deserializeAttachment();
        if (msg.t === 'race-leave') {
            if (attachment.privateId && removeRacer(this.board, attachment.privateId)) {
                await this.scheduleSave();
                this.scheduleBroadcast();
            }
            return;
        }
        if (msg.t !== 'race-join' && msg.t !== 'race-update') {
            return;
        }
        if (msg.t === 'race-join') {
            const privateId = String(msg.id || '').slice(0, 64);
            if (!privateId) {
                return;
            }
            attachment = { privateId, publicId: await publicRaceId(privateId) };
            ws.serializeAttachment(attachment);
        }
        if (!attachment.privateId) {
            return;
        }
        applyRaceMessage(this.board, attachment.privateId, attachment.publicId, msg, clock);
        await this.scheduleSave();
        if (msg.t === 'race-join') {
            this.send(ws, standingsMessage(this.board, clock));
        }
        this.scheduleBroadcast();
    }

    async webSocketClose(ws) {
        try {
            ws.close(1000, 'bye');
        } catch {
            // Already closed.
        }
    }
}
