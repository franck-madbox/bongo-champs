// Bongo Champs relay server.
// Groups clients into rooms (sessions) and relays each player's counter, tap bursts, hat and emoji reactions.
// Only counts are ever transmitted: no key codes, no text.

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { raceClock } = require('../src/race-time');
const { createBoard, applyRaceMessage, removeRacer, standingsMessage } = require('../src/race-board');

const PORT = Number(process.env.PORT) || 8787;
const MAX_PLAYERS_PER_ROOM = Number(process.env.MAX_PLAYERS_PER_ROOM) || 16;
const HEARTBEAT_MS = 15000;
const ROOM_CODE_REGEX = /^[A-Z0-9]{4,8}$/;
const HAT_ID_REGEX = /^[a-z0-9-]{1,32}$/;
const MAX_TAPS_PER_UPDATE = 100;
// Emoji reactions: Moji ids (catalog in src/catalog.js) or the standard emojis sent by 1.1.0 apps.
// Keep in sync with cloudflare/src/index.js and src/renderer/overlay.js.
const LEGACY_EMOJIS = ['😂', '🔥', '👍', '❤️', '😮', '🎉', '💀', '👋'];
const MOJI_ID_REGEX = /^[a-z0-9-]{1,32}$/;
const EMOJI_COOLDOWN_MS = 1500;

/** @type {Map<string, Map<string, {ws: import('ws').WebSocket, peer: object}>>} */
const rooms = new Map();

// ---------- Daily race (one board for everyone, clients connect to /race) ----------

const RACE_BROADCAST_MS = 2000;
const raceBoard = createBoard();
const raceClients = new Set();
let lastRaceBroadcast = 0;
let raceBroadcastTimer = null;

/** Public id broadcast in standings: a hash, so the private id stays secret. */
function publicRaceId(privateId) {
    return crypto.createHash('sha256').update(privateId).digest('hex').slice(0, 16);
}

function broadcastRace() {
    clearTimeout(raceBroadcastTimer);
    raceBroadcastTimer = null;
    lastRaceBroadcast = Date.now();
    const payload = JSON.stringify(standingsMessage(raceBoard, raceClock()));
    for (const ws of raceClients) {
        if (ws.readyState === ws.OPEN) {
            ws.send(payload);
        }
    }
}

/** At most one standings broadcast every RACE_BROADCAST_MS, the latest state always goes out. */
function scheduleRaceBroadcast() {
    const wait = RACE_BROADCAST_MS - (Date.now() - lastRaceBroadcast);
    if (wait <= 0) {
        broadcastRace();
    } else if (!raceBroadcastTimer) {
        raceBroadcastTimer = setTimeout(broadcastRace, wait);
    }
}

function handleRaceMessage(ws, msg) {
    const clock = raceClock();
    if (msg.t === 'race-get') {
        send(ws, standingsMessage(raceBoard, clock));
        return;
    }
    if (msg.t === 'race-leave') {
        if (ws.racePrivateId && removeRacer(raceBoard, ws.racePrivateId)) {
            scheduleRaceBroadcast();
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
        ws.racePrivateId = privateId;
        ws.racePublicId = publicRaceId(privateId);
    }
    if (!ws.racePrivateId) {
        return;
    }
    applyRaceMessage(raceBoard, ws.racePrivateId, ws.racePublicId, msg, clock);
    if (msg.t === 'race-join') {
        send(ws, standingsMessage(raceBoard, clock));
    }
    scheduleRaceBroadcast();
}

// Plain HTTP endpoint so hosting platforms can health-check the service.
const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
        let players = 0;
        for (const room of rooms.values()) {
            players += room.size;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, rooms: rooms.size, players }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bongo Champs relay server');
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: 4 * 1024 });

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

function send(ws, message) {
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

function broadcast(room, message, exceptId) {
    const payload = JSON.stringify(message);
    for (const [id, client] of room) {
        if (id !== exceptId && client.ws.readyState === client.ws.OPEN) {
            client.ws.send(payload);
        }
    }
}

function leaveRoom(ws) {
    if (!ws.roomCode) {
        return;
    }
    const room = rooms.get(ws.roomCode);
    if (room) {
        room.delete(ws.peerId);
        broadcast(room, { t: 'peer-leave', id: ws.peerId });
        if (room.size === 0) {
            rooms.delete(ws.roomCode);
        }
    }
    ws.roomCode = null;
}

function handleJoin(ws, msg) {
    const roomCode = String(msg.room || '').toUpperCase();
    const peerId = String(msg.id || '').slice(0, 64);
    // Clients connect to /room/<CODE> (same URL scheme as the Cloudflare relay): the join must match it.
    const urlMismatch = ws.urlRoom && ws.urlRoom !== roomCode;
    if (!ROOM_CODE_REGEX.test(roomCode) || !peerId || urlMismatch) {
        send(ws, { t: 'error', code: 'bad-request', message: 'Invalid session code.' });
        return;
    }

    leaveRoom(ws);

    let room = rooms.get(roomCode);
    if (!room) {
        room = new Map();
        rooms.set(roomCode, room);
    }

    // Same player reconnecting (e.g. after a network drop): replace the stale socket.
    const existing = room.get(peerId);
    if (existing && existing.ws !== ws) {
        existing.ws.roomCode = null;
        existing.ws.terminate();
        room.delete(peerId);
    }

    if (room.size >= MAX_PLAYERS_PER_ROOM) {
        send(ws, { t: 'error', code: 'room-full', message: 'This session is full.' });
        return;
    }

    const peer = sanitizePeer(peerId, msg);
    const peers = [];
    for (const client of room.values()) {
        peers.push(client.peer);
    }

    room.set(peerId, { ws, peer });
    ws.roomCode = roomCode;
    ws.peerId = peerId;

    send(ws, { t: 'welcome', room: roomCode, peers });
    broadcast(room, { t: 'peer-join', peer }, peerId);
}

function handleUpdate(ws, msg) {
    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    const client = room ? room.get(ws.peerId) : null;
    if (!client) {
        return;
    }
    const updated = sanitizePeer(ws.peerId, { ...client.peer, ...msg });
    client.peer = updated;
    const taps = Math.max(0, Math.min(MAX_TAPS_PER_UPDATE, Math.floor(Number(msg.taps) || 0)));
    broadcast(room, { t: 'peer-update', peer: updated, taps }, ws.peerId);
}

function isAllowedEmoji(emoji) {
    return LEGACY_EMOJIS.includes(emoji) || (typeof emoji === 'string' && MOJI_ID_REGEX.test(emoji));
}

/** Relays an emoji reaction from the allowed set, at most one per EMOJI_COOLDOWN_MS per player. */
function handleEmoji(ws, msg) {
    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    if (!room || !room.has(ws.peerId) || !isAllowedEmoji(msg.e)) {
        return;
    }
    const now = Date.now();
    if (ws.lastEmojiAt && now - ws.lastEmojiAt < EMOJI_COOLDOWN_MS) {
        return;
    }
    ws.lastEmojiAt = now;
    broadcast(room, { t: 'peer-emoji', id: ws.peerId, e: msg.e }, ws.peerId);
}

wss.on('connection', (ws, req) => {
    if ((req.url || '').split('?')[0] === '/race') {
        raceClients.add(ws);
        ws.isAlive = true;
        ws.on('pong', () => {
            ws.isAlive = true;
        });
        ws.on('message', (raw) => {
            try {
                handleRaceMessage(ws, JSON.parse(raw.toString()));
            } catch {
                // Ignore malformed messages.
            }
        });
        ws.on('close', () => raceClients.delete(ws));
        ws.on('error', () => raceClients.delete(ws));
        return;
    }

    const urlMatch = /^\/room\/([A-Za-z0-9]{4,8})\/?$/.exec(req.url || '');
    ws.urlRoom = urlMatch ? urlMatch[1].toUpperCase() : null;
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return;
        }
        switch (msg.t) {
            case 'join':
                handleJoin(ws, msg);
                break;
            case 'update':
                handleUpdate(ws, msg);
                break;
            case 'emoji':
                handleEmoji(ws, msg);
                break;
            case 'leave':
                leaveRoom(ws);
                break;
            default:
                break;
        }
    });

    ws.on('close', () => leaveRoom(ws));
    ws.on('error', () => leaveRoom(ws));
});

// Drops clients that stopped answering pings (sleeping laptops, dead Wi-Fi...).
const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
        if (!ws.isAlive) {
            leaveRoom(ws);
            ws.terminate();
            continue;
        }
        ws.isAlive = false;
        ws.ping();
    }
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeat));

httpServer.listen(PORT, () => {
    console.log(`Bongo Champs relay listening on :${PORT}`);
});
