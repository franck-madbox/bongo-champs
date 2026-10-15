// Local Champ window: your Champ, emoji bar, capsule badge and the macOS permission banner.
// Friends each get their own window (peer.js) so every Champ can be placed independently.

// Slightly above the relay's 1.5 s cooldown so local bubbles never show an emoji friends won't get.
const EMOJI_COOLDOWN_MS = 2000;

const template = document.getElementById('champ-template');
const permissionEl = document.getElementById('permission');
const contentEl = document.getElementById('content');

/** Falls back to a fake API when the page is opened in a regular browser (keyboard = taps). */
const api = window.bongo || createDemoApi();
const requestFit = createFitter(api, contentEl);

const me = new Champ(template, { isMe: true });
const giftEl = me.root.querySelector('.gift');
const updateEl = me.root.querySelector('.update');
const emojiBar = createEmojiBar();

let profile = null;
let sessionStatus = { room: null, state: 'offline', peers: [] };

// ---------- Rendering ----------

function renderMyLabel() {
    const inSession = Boolean(sessionStatus.room);
    const label = inSession ? `${profile.name} - ${sessionStatus.room}` : profile.name;
    me.setName(label, inSession ? sessionStatus.state : null);
}

/** Local Champ visuals that depend on the profile: color, hat, 🎁 badge and owned Mojis. */
function applyMyProfile() {
    me.setHue(profile.hue);
    me.setHat(hatFile(profile.catalog, profile.hat));
    giftEl.textContent = `🎁 ${profile.tokens}`;
    giftEl.classList.toggle('hidden', !(profile.tokens > 0));
    updateEl.textContent = `⬆ Update ${profile.updateReady || ''}`;
    updateEl.classList.toggle('hidden', !profile.updateReady);
    renderEmojiBar(profile.ownedMojis || []);
}

// ---------- Emojis ----------

function createEmojiBar() {
    const bar = document.createElement('div');
    bar.className = 'emoji-bar hidden';
    // Shown above the local Champ's counter.
    me.root.insertBefore(bar, me.root.querySelector('.count'));
    return bar;
}

let renderedMojis = '';

/** Fills the emoji bar with the Mojis the player owns (rebuilt only when that list changes). */
function renderEmojiBar(ownedIds) {
    const key = ownedIds.join(',');
    if (key === renderedMojis) {
        return;
    }
    renderedMojis = key;
    emojiBar.textContent = '';
    for (const moji of profile.catalog.mojis) {
        if (!ownedIds.includes(moji.id)) {
            continue;
        }
        const button = document.createElement('button');
        button.title = moji.name;
        const img = document.createElement('img');
        img.src = moji.file;
        img.alt = moji.name;
        button.appendChild(img);
        button.addEventListener('click', () => sendEmoji(moji.id));
        emojiBar.appendChild(button);
    }
}

function toggleEmojiBar(visible) {
    emojiBar.classList.toggle('hidden', !visible);
    requestFit();
}

let lastEmojiAt = 0;

function sendEmoji(emoji) {
    const now = Date.now();
    if (now - lastEmojiAt < EMOJI_COOLDOWN_MS) {
        return;
    }
    lastEmojiAt = now;
    me.showEmoji(emojiContent(profile.catalog, emoji));
    api.sendEmoji(emoji);
    toggleEmojiBar(false);
}

// ---------- Events from the main process ----------

api.on('tap', (payload) => {
    me.tap(payload.side, false);
    me.setCount(payload.count);
});

api.on('release', () => me.release());

api.on('profile', (newProfile) => {
    profile = newProfile;
    applyMyProfile();
    applySize(contentEl, profile.size, requestFit);
    renderMyLabel();
});

api.on('session', (status) => {
    sessionStatus = status;
    renderMyLabel();
});

api.on('permission', ({ missing }) => {
    permissionEl.classList.toggle('hidden', !missing);
    requestFit();
});

document.getElementById('permission-fix').addEventListener('click', async () => {
    const result = await api.fixAccessibility();
    document.getElementById('permission-text').textContent = result && result.resetOk
        ? 'Now turn on Bongo Champs in System Settings > Accessibility.'
        : 'The old permission could not be cleared automatically.';
    // Manual fallback that always works: an entry made for an older build ignores its switch.
    document.querySelector('.permission-hint').textContent =
        'Still not counted? In the list, select Bongo Champs, click "-", then click Fix it again.';
    requestFit();
});

// ---------- Window drag + clicks ----------

giftEl.addEventListener('click', () => api.openSettings());
updateEl.addEventListener('click', () => api.installUpdate());

setupWindowDrag(api, {
    // Buttons that must receive normal clicks instead of starting a window drag.
    isInteractive: (target) => permissionEl.contains(target) || emojiBar.contains(target) || giftEl.contains(target) || updateEl.contains(target),
    // A click (no drag) on the Champ toggles the emoji bar; anywhere else closes it.
    onClick: (target) => toggleEmojiBar(me.stage.contains(target) && emojiBar.classList.contains('hidden')),
});

// ---------- Boot ----------

async function init() {
    const state = await api.getState();
    profile = state;
    document.getElementById('row').appendChild(me.root);
    applyMyProfile();
    me.setCount(profile.count);
    applySize(contentEl, profile.size, requestFit);
    sessionStatus = state.session;
    permissionEl.classList.toggle('hidden', !state.permissionMissing);
    renderMyLabel();
}

init();

// ---------- Browser demo mode (no Electron) ----------

function createDemoApi() {
    const listeners = {};
    const emit = (channel, payload) => (listeners[channel] || []).forEach((cb) => cb(payload));
    let count = 1234;
    let side = 0;

    window.addEventListener('keydown', (event) => {
        if (event.repeat) {
            return;
        }
        side = 1 - side;
        count += 1;
        emit('tap', { side, count });
    });
    window.addEventListener('keyup', () => emit('release', {}));

    return {
        getState: async () => ({
            name: 'Franck', hue: 0, count, tokens: 1, hat: null, catalog: { hats: [], mojis: [] }, ownedMojis: [],
            session: { room: null, state: 'offline', peers: [] },
        }),
        on: (channel, cb) => {
            (listeners[channel] = listeners[channel] || []).push(cb);
        },
        resize: () => {},
        drag: () => {},
        dragEnd: () => {},
        openMenu: () => {},
        fixAccessibility: async () => ({ resetOk: true }),
        sendEmoji: () => {},
        openSettings: () => {},
        installUpdate: () => {},
    };
}
