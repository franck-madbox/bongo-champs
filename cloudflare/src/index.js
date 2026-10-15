// Bongo Champs relay on Cloudflare Workers.
// Each session is one Durable Object (looked up by its code), clients connect to wss://<host>/room/<CODE>.
// Same message protocol as server/server.js. Only counts, hats and emoji reactions are transmitted: no key codes, no text.

import { DurableObject } from 'cloudflare:workers';

const MAX_PLAYERS_PER_ROOM = 16;
const MAX_TAPS_PER_UPDATE = 100;
const ROOM_PATH_REGEX = /^\/room\/([A-Za-z0-9]{4,8})\/?$/;
const HAT_ID_REGEX = /^[a-z0-9-]{1,32}$/;
// Emoji reactions: Moji ids (catalog in src/catalog.js) or the standard emojis sent by 1.1.0 apps.
// Keep in sync with server/server.js and src/renderer/overlay.js.
const LEGACY_EMOJIS = ['😂', '🔥', '👍', '❤️', '😮', '🎉', '💀', '👋'];
const MOJI_ID_REGEX = /^[a-z0-9-]{1,32}$/;
const EMOJI_COOLDOWN_MS = 1500;

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === '/health') {
            return Response.json({ ok: true });
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
