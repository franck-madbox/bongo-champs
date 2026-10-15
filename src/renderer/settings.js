// Settings window: Champ look (live preview), hat + Moji capsule machines, capsule purchase and session.

const api = window.bongo;
const $ = (id) => document.getElementById(id);
const template = $('champ-template');

// Length of the capsule shake before the prize is revealed.
const CAPSULE_SHAKE_MS = 1100;
const TAB_STORAGE_KEY = 'bongo-settings-tab';

// Small Champ in the header + big live preview next to the color slider.
const avatar = new Champ(template, { isMe: true });
$('avatar').appendChild(avatar.root);
const preview = new Champ(template, { isMe: true });
$('champ-preview').appendChild(preview.root);

let latestState = null;
let selectedSize = 'medium';
let opening = false;

// ---------- Tabs ----------

function selectTab(tab) {
    for (const button of document.querySelectorAll('.tabs button')) {
        button.classList.toggle('active', button.dataset.tab === tab);
    }
    for (const section of document.querySelectorAll('section.tab')) {
        section.classList.toggle('hidden', section.dataset.tab !== tab);
    }
    try {
        localStorage.setItem(TAB_STORAGE_KEY, tab);
    } catch {
        // Storage unavailable: the tab is just not remembered.
    }
}

for (const button of document.querySelectorAll('.tabs button')) {
    button.addEventListener('click', () => selectTab(button.dataset.tab));
}

function initialTab() {
    try {
        return localStorage.getItem(TAB_STORAGE_KEY) || 'champ';
    } catch {
        return 'champ';
    }
}

// ---------- Champ look ----------

/** Current form values, as sent to the main process. */
function formValues() {
    return { name: $('name').value, hue: $('hue').value, serverUrl: $('server').value, size: selectedSize };
}

function renderSize(size) {
    selectedSize = size;
    for (const button of $('size').querySelectorAll('button')) {
        button.classList.toggle('active', button.dataset.size === size);
    }
}

function findItem(state, collectionId, id) {
    return state.catalog[collectionId].find((item) => item.id === id) || null;
}

/** Both Champs (header + preview) show the worn hat and the given color. */
function renderChamps(state, hue) {
    const worn = findItem(state, 'hats', state.hat);
    for (const champ of [avatar, preview]) {
        champ.setHue(hue);
        champ.setHat(worn ? worn.file : null);
    }
    preview.setName($('name').value || state.name, null);
    preview.setCount(state.count);
}

// Live preview while dragging the slider or typing the name (saved with the Save button).
$('hue').addEventListener('input', () => renderChamps(latestState, Number($('hue').value)));
$('name').addEventListener('input', () => preview.setName($('name').value || latestState.name, null));
$('hue-reset').addEventListener('click', () => {
    $('hue').value = 0;
    renderChamps(latestState, 0);
});

// Size applies right away so it can be judged on screen.
for (const button of $('size').querySelectorAll('button')) {
    button.addEventListener('click', () => {
        renderSize(button.dataset.size);
        api.saveProfile(formValues());
    });
}

$('save').addEventListener('click', async () => {
    renderAll(await api.saveProfile(formValues()));
    $('save').textContent = 'Saved!';
    setTimeout(() => {
        $('save').textContent = 'Save';
    }, 1200);
});

// ---------- Capsules ----------

function formatDuration(ms) {
    const minutes = Math.max(1, Math.ceil(ms / 60000));
    return minutes >= 60 ? '1 h' : `${minutes} min`;
}

function isComplete(state, collectionId) {
    const owned = collectionId === 'hats' ? state.hats : state.ownedMojis;
    return owned.length >= state.catalog[collectionId].length;
}

/** Capsule stock, hourly countdown and tap points towards the next purchase. */
function renderCapsuleBar(state) {
    const cost = state.catalog.capsuleCost;
    $('tokens').textContent = `🎁 ${state.tokens} capsule${state.tokens === 1 ? '' : 's'}`;
    $('next-token').textContent = `+1 free in ${formatDuration(state.nextTokenMs)}`;
    $('points').textContent = state.points.toLocaleString();
    $('points-cost').textContent = cost.toLocaleString();
    $('points-fill').style.width = `${Math.min(100, (state.points / cost) * 100)}%`;
    $('buy-capsule').disabled = state.points < cost;
    $('buy-capsule').classList.toggle('primary', state.points >= cost);
    $('buy-capsule').title = state.points >= cost
        ? `Spend ${cost.toLocaleString()} taps for one capsule (${Math.floor(state.points / cost)} affordable)`
        : 'Keep typing and clicking to afford a capsule';
    for (const machine of document.querySelectorAll('.machine')) {
        const collectionId = machine.dataset.collection;
        const button = machine.querySelector('.open');
        const complete = isComplete(state, collectionId);
        button.disabled = opening || state.tokens <= 0 || complete;
        button.textContent = complete ? 'Collection complete!' : 'Open a capsule';
    }
}

$('buy-capsule').addEventListener('click', async () => {
    const result = await api.buyCapsule();
    if (result.ok) {
        renderAll(result.state);
    }
});

/** Capsule shake, then the prize pops out (with its rarity glow for hats). */
async function openCapsule(machine) {
    const collectionId = machine.dataset.collection;
    const capsule = machine.querySelector('.capsule');
    const reveal = machine.querySelector('.reveal-item');
    opening = true;
    renderCapsuleBar(latestState);
    reveal.classList.add('hidden');
    capsule.classList.remove('hidden');
    capsule.classList.add('shaking');

    const [result] = await Promise.all([
        api.openCapsule(collectionId),
        new Promise((resolve) => setTimeout(resolve, CAPSULE_SHAKE_MS)),
    ]);
    opening = false;
    capsule.classList.remove('shaking');
    if (!result.ok) {
        renderAll(latestState);
        return;
    }
    capsule.classList.add('hidden');
    const item = result.item;
    reveal.querySelector('img').src = item.file;
    reveal.querySelector('.reveal-name').textContent = item.name;
    const rarityEl = reveal.querySelector('.rarity');
    rarityEl.textContent = item.rarity ? result.state.catalog.rarities[item.rarity].label : 'New Moji!';
    rarityEl.className = `rarity ${item.rarity || 'common'}`;
    reveal.className = `reveal-item ${item.rarity || 'moji'}`;
    renderAll(result.state);
}

for (const machine of document.querySelectorAll('.machine')) {
    machine.querySelector('.open').addEventListener('click', () => openCapsule(machine));
}

// ---------- Collections ----------

function createTile(className, title, content) {
    const tile = document.createElement('button');
    tile.className = className;
    tile.title = title;
    if (typeof content === 'string') {
        tile.textContent = content;
    } else {
        tile.appendChild(content);
    }
    return tile;
}

function itemImage(item) {
    const img = document.createElement('img');
    img.src = item.file;
    img.alt = item.name;
    return img;
}

function renderHats(state) {
    const grid = $('hats-grid');
    grid.textContent = '';
    const none = createTile(`tile none${state.hat === null ? ' worn' : ''}`, 'No hat', 'None');
    none.addEventListener('click', () => api.wearHat(null));
    grid.appendChild(none);
    for (const hat of state.catalog.hats) {
        const owned = state.hats.includes(hat.id);
        const rarityLabel = state.catalog.rarities[hat.rarity].label;
        const tile = createTile(
            `tile ${hat.rarity}${owned ? '' : ' locked'}${state.hat === hat.id ? ' worn' : ''}`,
            owned ? `${hat.name} (${rarityLabel})` : `??? (${rarityLabel})`,
            owned ? itemImage(hat) : '?',
        );
        tile.disabled = !owned;
        tile.addEventListener('click', () => api.wearHat(hat.id));
        grid.appendChild(tile);
    }
    $('hats-progress').textContent = `${state.hats.length} / ${state.catalog.hats.length}`;
}

function renderMojis(state) {
    const grid = $('mojis-grid');
    grid.textContent = '';
    for (const moji of state.catalog.mojis) {
        const owned = state.ownedMojis.includes(moji.id);
        const tile = createTile(`tile moji${owned ? '' : ' locked'}`, owned ? moji.name : '???', owned ? itemImage(moji) : '?');
        tile.disabled = true;
        grid.appendChild(tile);
    }
    $('mojis-progress').textContent = `${state.ownedMojis.length} / ${state.catalog.mojis.length}`;
}

// ---------- Session ----------

function showError(message) {
    $('error').textContent = message || '';
    $('error').classList.toggle('hidden', !message);
}

function renderSession(status) {
    const inSession = Boolean(status.room);
    $('in-session').classList.toggle('hidden', !inSession);
    $('no-session').classList.toggle('hidden', inSession);
    if (!inSession) {
        return;
    }
    $('code').textContent = status.room;
    $('state').textContent = status.state;
    const names = status.peers.map((peer) => peer.name);
    $('peers').textContent = names.length ? `With: ${names.join(', ')}` : 'Waiting for friends... share the invite!';
}

$('create').addEventListener('click', async () => {
    showError('');
    await api.saveProfile(formValues());
    await api.createSession();
});

$('join').addEventListener('click', async () => {
    showError('');
    await api.saveProfile(formValues());
    const result = await api.joinSession($('join-code').value);
    if (!result.ok) {
        showError(result.error);
    }
});

$('join-code').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        $('join').click();
    }
});

$('copy').addEventListener('click', async () => {
    await api.copyInvite();
    $('copy').textContent = 'Copied!';
    setTimeout(() => {
        $('copy').textContent = 'Copy invite';
    }, 1500);
});

$('leave').addEventListener('click', () => api.leaveSession());

$('update-banner').addEventListener('click', () => api.installUpdate());

// ---------- Sync ----------

let renderedCollections = '';

/** Everything except the typed fields (name, color, server), which only change on load. */
function renderAll(state) {
    latestState = state;
    $('total').textContent = `${state.count.toLocaleString()} taps`;
    $('update-banner').classList.toggle('hidden', !state.updateReady);
    $('update-version').textContent = state.updateReady || '';
    $('app-version').textContent = `Bongo Champs ${state.appVersion}`;
    renderSize(state.size);
    renderChamps(state, Number($('hue').value));
    renderCapsuleBar(state);
    // Profile updates arrive every second while typing: only rebuild the grids when a collection changed.
    const collectionsKey = JSON.stringify([state.hats, state.hat, state.ownedMojis]);
    if (!opening && collectionsKey !== renderedCollections) {
        renderedCollections = collectionsKey;
        renderHats(state);
        renderMojis(state);
    }
}

api.on('session', renderSession);
api.on('session-error', showError);
// Changes made elsewhere (menu, play clock, taps) arrive here without touching the typed fields.
api.on('profile', renderAll);

api.getState().then((state) => {
    $('name').value = state.name;
    $('hue').value = state.hue;
    $('server').value = state.serverUrl;
    renderAll(state);
    renderSession(state.session);
    selectTab(initialTab());
});
