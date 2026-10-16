// Bongo Champs - main process.
// Owns the overlay + settings windows, the tray, the global input hook and the session connection.

const path = require('path');
const { execFile } = require('child_process');
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, systemPreferences, clipboard, shell, dialog } = require('electron');
const { Store } = require('./store');
const { SessionClient } = require('./session-client');
const gacha = require('./gacha');
const { DailyRace } = require('./daily-race');

const PROTOCOL = 'bongochamps';
const ASSETS_DIR = path.join(__dirname, 'renderer', 'assets');
const ACCESSIBILITY_POLL_MS = 3000;
// On-screen size of the overlay. The scale factors themselves live in renderer/overlay.js.
const CHAMP_SIZES = [
    { id: 'small', label: 'Small' },
    { id: 'medium', label: 'Medium' },
    { id: 'large', label: 'Large' },
];
const PLAY_TICK_MS = 60 * 1000;
const UPDATE_CHECK_MS = 4 * 60 * 60 * 1000;

let store = null;
let session = null;
let dailyRace = null;
let overlayWindow = null;
let settingsWindow = null;
let tray = null;
let pendingDeepLink = null;
let inputHookStarted = false;
let permissionMissing = false;
// Version downloaded by the auto-updater and ready to install on restart, or null.
let updateReady = null;

// ---------- Single instance + deep links (bongochamps://join/CODE) ----------

// Dev/testing: BONGO_USER_DATA=<folder> runs an independent instance (own settings, own lock),
// e.g. to test a session with two Champs on one machine without touching the installed app.
if (process.env.BONGO_USER_DATA) {
    app.setPath('userData', path.resolve(process.env.BONGO_USER_DATA));
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
}

if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
} else {
    app.setAsDefaultProtocolClient(PROTOCOL);
}

/** Extracts a session code from a bongochamps://join/CODE link, or null. */
function parseDeepLink(url) {
    const match = /^bongochamps:\/\/join\/([A-Za-z0-9]{4,8})/.exec(url || '');
    return match ? match[1].toUpperCase() : null;
}

function handleDeepLink(url) {
    const code = parseDeepLink(url);
    if (!code) {
        return;
    }
    if (!session) {
        pendingDeepLink = code;
        return;
    }
    joinSession(code);
}

app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
});

app.on('second-instance', (_event, argv) => {
    const link = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
    if (link) {
        handleDeepLink(link);
    }
    if (overlayWindow) {
        overlayWindow.showInactive();
    }
});

// ---------- Session helpers ----------

/** Generates a readable session code (no 0/O/1/I to avoid confusion when shared by voice). */
function generateSessionCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return code;
}

function inviteText(code) {
    return `Join my Bongo Champs session! Code: ${code}  (or open ${PROTOCOL}://join/${code})`;
}

function createSession() {
    joinSession(generateSessionCode());
}

function joinSession(code) {
    store.set({ room: code });
    session.join(code);
    refreshTray();
    sendToOverlay('session', session.getStatus());
}

function leaveSession() {
    store.set({ room: null });
    session.leave();
    refreshTray();
    sendToOverlay('session', session.getStatus());
}

function copyInvite() {
    const code = store.get().room;
    if (code) {
        clipboard.writeText(inviteText(code));
    }
}

// ---------- Windows ----------

function sendToOverlay(channel, payload) {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send(channel, payload);
    }
}

function sendToSettings(channel, payload) {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send(channel, payload);
    }
}

const DEFAULT_WINDOW_SIZE = { width: 260, height: 220 };
// Horizontal room per friend when friends are lined up next to the local Champ (before they are moved).
const PEER_SLOT_WIDTH = 210;
const PEER_GAP_PX = 8;

/** Friends' Champ windows, by peer id: each Champ is its own window so it can be placed anywhere. */
const peerWindows = new Map();

/** A transparent, frameless, always-on-top window for one Champ. */
function createChampWindow(bounds, page, query) {
    const win = new BrowserWindow({
        ...DEFAULT_WINDOW_SIZE,
        ...bounds,
        show: false,
        transparent: true,
        frame: false,
        resizable: false,
        hasShadow: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        focusable: true,
        fullscreenable: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.loadFile(path.join(__dirname, 'renderer', page), { query });
    // Shown without stealing focus from the app the user is typing in.
    win.once('ready-to-show', () => {
        if (!overlayWindow || overlayWindow === win || overlayWindow.isVisible()) {
            win.showInactive();
        }
    });
    win.on('moved', () => saveWindowPosition(win));
    return win;
}

/** Saved bounds if they are still on a connected screen (a monitor may have been unplugged). */
function visibleBounds(bounds) {
    if (!bounds || typeof bounds.x !== 'number') {
        return null;
    }
    const workArea = screen.getDisplayMatching({ x: bounds.x, y: bounds.y, width: 60, height: 60 }).workArea;
    const onScreen = bounds.x + 60 > workArea.x && bounds.x < workArea.x + workArea.width
        && bounds.y + 60 > workArea.y && bounds.y < workArea.y + workArea.height;
    return onScreen ? bounds : null;
}

function defaultOverlayBounds() {
    const workArea = screen.getPrimaryDisplay().workArea;
    return {
        x: workArea.x + workArea.width - DEFAULT_WINDOW_SIZE.width - 40,
        y: workArea.y + workArea.height - DEFAULT_WINDOW_SIZE.height - 20,
    };
}

/** Friends start lined up on the left of the local Champ, bottom-aligned with it. */
function defaultPeerBounds(index) {
    const anchor = overlayWindow ? overlayWindow.getBounds() : { ...defaultOverlayBounds(), ...DEFAULT_WINDOW_SIZE };
    return {
        // Windows shrink towards their bottom-right corner once fitted, so place that corner.
        x: Math.round(anchor.x - PEER_GAP_PX - DEFAULT_WINDOW_SIZE.width - index * PEER_SLOT_WIDTH),
        y: Math.round(anchor.y + anchor.height - DEFAULT_WINDOW_SIZE.height),
    };
}

function createOverlayWindow() {
    const bounds = visibleBounds(store.get().bounds) || defaultOverlayBounds();
    overlayWindow = createChampWindow(bounds, 'index.html');
    overlayWindow.on('closed', () => {
        overlayWindow = null;
    });
}

function createPeerWindow(peerId, index) {
    const saved = (store.get().peerPositions || {})[peerId];
    const win = createChampWindow(visibleBounds(saved) || defaultPeerBounds(index), 'peer.html', { id: peerId });
    win.on('closed', () => {
        if (peerWindows.get(peerId) === win) {
            peerWindows.delete(peerId);
        }
    });
    peerWindows.set(peerId, win);
}

/** One window per friend in the session: opens new ones, closes the ones of friends who left. */
function syncPeerWindows(peers) {
    const ids = new Set();
    peers.forEach((peer, index) => {
        ids.add(peer.id);
        if (!peerWindows.has(peer.id)) {
            createPeerWindow(peer.id, index);
        }
    });
    for (const [id, win] of peerWindows) {
        if (!ids.has(id)) {
            win.destroy();
            peerWindows.delete(id);
        }
    }
}

function sendToPeer(peerId, channel, payload) {
    const win = peerWindows.get(peerId);
    if (win && !win.isDestroyed()) {
        win.webContents.send(channel, payload);
    }
}

function sendToPeers(channel, payload) {
    for (const id of peerWindows.keys()) {
        sendToPeer(id, channel, payload);
    }
}

function peerIdOfWindow(win) {
    for (const [id, peerWin] of peerWindows) {
        if (peerWin === win) {
            return id;
        }
    }
    return null;
}

/** Remembers where the user placed a Champ (size included, so it does not drift when re-fitted). */
function saveWindowPosition(win) {
    if (!win || win.isDestroyed()) {
        return;
    }
    const bounds = win.getBounds();
    if (win === overlayWindow) {
        store.set({ bounds });
        return;
    }
    const peerId = peerIdOfWindow(win);
    if (peerId) {
        store.set({ peerPositions: { ...(store.get().peerPositions || {}), [peerId]: bounds } });
    }
}

/** Puts the local Champ back in the bottom-right corner and lines friends up next to it. */
function resetPositions() {
    if (overlayWindow) {
        const size = overlayWindow.getBounds();
        const workArea = screen.getPrimaryDisplay().workArea;
        overlayWindow.setPosition(workArea.x + workArea.width - size.width - 40, workArea.y + workArea.height - size.height - 20);
        saveWindowPosition(overlayWindow);
    }
    store.set({ peerPositions: {} });
    let index = 0;
    for (const win of peerWindows.values()) {
        const target = defaultPeerBounds(index++);
        const size = win.getBounds();
        win.setPosition(target.x, target.y + DEFAULT_WINDOW_SIZE.height - size.height);
    }
}

function isValidSize(size) {
    return CHAMP_SIZES.some((entry) => entry.id === size);
}

/** State shared with the renderer pages: stored profile + derived gacha info. */
function publicState() {
    const state = store.get();
    return {
        ...state,
        nextTokenMs: gacha.msUntilNextToken(state),
        catalog: gacha.getCatalog(),
        ownedMojis: gacha.ownedIds(state, 'mojis'),
        appVersion: app.getVersion(),
        updateReady,
    };
}

/** Pushes the profile to every window and the tray after a local change. */
function notifyProfile() {
    const state = publicState();
    sendToOverlay('profile', state);
    sendToSettings('profile', state);
    // Friends' windows only need the catalog (hats, Mojis) and the size.
    sendToPeers('profile', { catalog: state.catalog, size: state.size });
    refreshTray();
}

function setChampSize(size) {
    if (!isValidSize(size)) {
        return;
    }
    store.set({ size });
    notifyProfile();
}

// ---------- Hats gacha ----------

/** Counts time with the app open towards gacha tokens (one per hour). */
function startPlayClock() {
    let lastTick = Date.now();
    setInterval(() => {
        const now = Date.now();
        // A sleeping computer pauses timers: don't count the sleep itself.
        const elapsed = Math.min(now - lastTick, PLAY_TICK_MS * 2);
        lastTick = now;
        const before = store.get().tokens;
        store.set(gacha.addPlayTime(store.get(), elapsed));
        if (store.get().tokens !== before) {
            notifyProfile();
        } else {
            sendToSettings('profile', publicState());
        }
    }, PLAY_TICK_MS);
}

/** Opens a capsule in a collection ('hats' or 'mojis'). */
function openCapsule(collectionId) {
    const result = gacha.pull(store.get(), collectionId);
    if (result.error) {
        return { ok: false, error: result.error };
    }
    store.set(result.patch);
    if (collectionId === 'hats') {
        session.updateProfile();
        dailyRace.profileChanged();
    }
    notifyProfile();
    return { ok: true, item: result.item, state: publicState() };
}

/** Spends tap points for one capsule. */
function buyCapsule() {
    const result = gacha.buyCapsule(store.get());
    if (result.error) {
        return { ok: false, error: result.error };
    }
    store.set(result.patch);
    notifyProfile();
    return { ok: true, state: publicState() };
}

function wearHat(hatId) {
    const id = hatId || null;
    if (!gacha.isOwnedHat(store.get(), id)) {
        return;
    }
    store.set({ hat: id });
    session.updateProfile();
    dailyRace.profileChanged();
    notifyProfile();
}

function openSettingsWindow() {
    if (settingsWindow) {
        settingsWindow.show();
        settingsWindow.focus();
        return;
    }
    settingsWindow = new BrowserWindow({
        width: 420,
        height: 720,
        resizable: false,
        title: 'Bongo Champs',
        backgroundColor: '#1d2230',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    settingsWindow.setMenuBarVisibility(false);
    settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
    settingsWindow.on('closed', () => {
        settingsWindow = null;
    });
    if (process.platform === 'darwin') {
        app.focus({ steal: true });
    }
}

// ---------- Tray ----------

function createTray() {
    const icon = nativeImage.createFromPath(path.join(ASSETS_DIR, 'champs_bongo_head.png')).resize({ height: 16 });
    tray = new Tray(icon);
    tray.setToolTip('Bongo Champs');
    refreshTray();
}

function buildMenuTemplate() {
    const state = store.get();
    const inSession = Boolean(state.room);
    const visible = overlayWindow ? overlayWindow.isVisible() : false;
    return [
        { label: `${state.name} - ${state.count.toLocaleString()} taps`, enabled: false },
        updateReady ? { label: `Restart to update (${updateReady})`, click: installUpdate } : null,
        { type: 'separator' },
        inSession
            ? { label: `Session ${state.room} (${session.getStatus().state})`, enabled: false }
            : { label: 'Create session', click: createSession },
        inSession ? { label: 'Copy invite', click: copyInvite } : { label: 'Join session...', click: openSettingsWindow },
        inSession ? { label: 'Leave session', click: leaveSession } : null,
        { type: 'separator' },
        state.tokens > 0 ? { label: `Open a capsule (${state.tokens})`, click: openSettingsWindow } : null,
        { label: 'Settings...', click: openSettingsWindow },
        {
            label: 'Size',
            submenu: CHAMP_SIZES.map((entry) => ({
                label: entry.label,
                type: 'radio',
                checked: state.size === entry.id,
                click: () => setChampSize(entry.id),
            })),
        },
        { label: visible ? 'Hide Champ' : 'Show Champ', click: toggleOverlay },
        {
            label: 'Daily race',
            type: 'checkbox',
            checked: dailyRace ? dailyRace.isVisible() : false,
            click: (item) => {
                dailyRace.setVisible(item.checked);
                refreshTray();
            },
        },
        { label: 'Reset positions', click: resetPositions },
        { type: 'separator' },
        { label: 'Quit Bongo Champs', click: () => app.quit() },
    ].filter(Boolean);
}

function refreshTray() {
    if (tray) {
        tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate()));
    }
}

/** Hides or shows every Champ window (local + friends). */
function toggleOverlay() {
    if (!overlayWindow) {
        createOverlayWindow();
        refreshTray();
        return;
    }
    const show = !overlayWindow.isVisible();
    for (const win of [overlayWindow, ...peerWindows.values()]) {
        if (show) {
            win.showInactive();
        } else {
            win.hide();
        }
    }
    refreshTray();
}

// ---------- Auto-update ----------

/**
 * Checks GitHub Releases (see "publish" in package.json) for a newer version, downloads it in the background,
 * then offers "Update" in the overlay, Settings and menu. Installed builds only.
 */
function startAutoUpdater() {
    if (!app.isPackaged) {
        return;
    }
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    // Also installs a downloaded update when the user simply quits the app.
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-downloaded', (info) => {
        updateReady = info.version;
        notifyProfile();
    });
    autoUpdater.on('error', (error) => console.error('Auto-update failed', error));
    const check = () => autoUpdater.checkForUpdates().catch((error) => console.error('Update check failed', error));
    check();
    setInterval(check, UPDATE_CHECK_MS);
}

function installUpdate() {
    if (updateReady) {
        require('electron-updater').autoUpdater.quitAndInstall();
    }
}

// ---------- Global input hook ----------

/**
 * Starts counting keyboard + mouse presses system-wide.
 * Only the fact that "a key/button went down" is used: the key itself is never stored nor sent.
 */
function startInputHook() {
    if (inputHookStarted) {
        return;
    }
    if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
        // Shows the macOS prompt once, then waits for the user to grant access.
        if (!permissionMissing) {
            systemPreferences.isTrustedAccessibilityClient(true);
        }
        permissionMissing = true;
        sendToOverlay('permission', { missing: true });
        setTimeout(startInputHook, ACCESSIBILITY_POLL_MS);
        return;
    }

    const { uIOhook } = require('uiohook-napi');
    const pressedKeys = new Set();
    let nextSide = 0;

    uIOhook.on('keydown', (event) => {
        // Holding a key fires repeated keydowns: only count the first one.
        if (pressedKeys.has(event.keycode)) {
            return;
        }
        pressedKeys.add(event.keycode);
        nextSide = 1 - nextSide;
        registerTap(nextSide);
    });

    uIOhook.on('keyup', (event) => {
        pressedKeys.delete(event.keycode);
        sendToOverlay('release', {});
    });

    uIOhook.on('mousedown', (event) => {
        // Left click = left paw, any other button = right paw.
        registerTap(event.button === 1 ? 0 : 1);
    });

    uIOhook.on('mouseup', () => {
        sendToOverlay('release', {});
    });

    try {
        uIOhook.start();
        inputHookStarted = true;
        permissionMissing = false;
        sendToOverlay('permission', { missing: false });
    } catch (error) {
        console.error('Failed to start input hook', error);
        setTimeout(startInputHook, ACCESSIBILITY_POLL_MS);
    }
}

/**
 * One-click repair for the macOS permission. After an update made with a different signature, the old
 * "Bongo Champs" entry in System Settings no longer applies and toggling it does nothing: clear this app's
 * entry (only this app's), ask again, and open the right Settings pane.
 */
/** @returns {Promise<{resetOk: boolean}>} whether the old entry could be cleared automatically. */
function fixAccessibility() {
    if (process.platform !== 'darwin') {
        return Promise.resolve({ resetOk: true });
    }
    const openSettings = () => {
        systemPreferences.isTrustedAccessibilityClient(true);
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    };
    // In dev the process is Electron itself: never reset another app's permission.
    if (!app.isPackaged) {
        openSettings();
        return Promise.resolve({ resetOk: true });
    }
    const bundleId = require('../package.json').build.appId;
    return new Promise((resolve) => {
        // Can fail without admin rights on some macOS versions: the overlay then explains the manual "-" step.
        execFile('tccutil', ['reset', 'Accessibility', bundleId], (error) => {
            openSettings();
            resolve({ resetOk: !error });
        });
    });
}

let trayRefreshTimer = null;

function registerTap(side) {
    const count = store.increment();
    sendToOverlay('tap', { side, count });
    session.addTap(count);
    dailyRace.registerTap();

    // The tray label shows the count: refresh it lazily, not on every key.
    if (!trayRefreshTimer) {
        trayRefreshTimer = setTimeout(() => {
            trayRefreshTimer = null;
            refreshTray();
            // Keeps the tap points / "Buy" button live in Settings.
            sendToSettings('profile', publicState());
        }, 1000);
    }
}

// ---------- IPC ----------

function registerIpc() {
    ipcMain.handle('get-state', () => ({ ...publicState(), session: session.getStatus(), permissionMissing }));

    ipcMain.handle('open-capsule', (_event, collectionId) => openCapsule(String(collectionId)));

    ipcMain.handle('buy-capsule', () => buyCapsule());

    ipcMain.handle('wear-hat', (_event, hatId) => wearHat(hatId));

    ipcMain.on('send-emoji', (_event, emoji) => session.sendEmoji(String(emoji)));

    ipcMain.on('open-settings', openSettingsWindow);

    ipcMain.on('install-update', installUpdate);

    // Resize / drag / menu come from any Champ window: act on the window that sent them.
    ipcMain.on('overlay-resize', (event, size) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win) {
            return;
        }
        const bounds = win.getBounds();
        const width = Math.max(120, Math.min(2000, Math.round(size.width)));
        const height = Math.max(120, Math.min(800, Math.round(size.height)));
        if (bounds.width === width && bounds.height === height) {
            return;
        }
        // Grow/shrink towards the top-left so the Champ's feet stay where the user placed it.
        win.setBounds({ x: bounds.x + bounds.width - width, y: bounds.y + bounds.height - height, width, height });
        saveWindowPosition(win);
    });

    ipcMain.on('overlay-drag', (event, delta) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            const [x, y] = win.getPosition();
            win.setPosition(Math.round(x + delta.dx), Math.round(y + delta.dy));
        }
    });

    ipcMain.on('overlay-drag-end', (event) => saveWindowPosition(BrowserWindow.fromWebContents(event.sender)));

    ipcMain.on('overlay-menu', (event) => {
        Menu.buildFromTemplate(buildMenuTemplate()).popup({ window: BrowserWindow.fromWebContents(event.sender) });
    });

    ipcMain.handle('get-peer-state', (_event, peerId) => ({
        catalog: gacha.getCatalog(),
        size: store.get().size,
        peer: session.getStatus().peers.find((peer) => peer.id === peerId) || null,
    }));

    ipcMain.handle('save-profile', (_event, profile) => {
        const previousServer = store.get().serverUrl;
        store.set({
            name: String(profile.name || 'Champ').trim().slice(0, 20) || 'Champ',
            hue: Math.max(0, Math.min(360, Number(profile.hue) || 0)),
            serverUrl: String(profile.serverUrl || '').trim() || store.get().serverUrl,
            size: isValidSize(profile.size) ? profile.size : store.get().size,
        });
        session.updateProfile();
        dailyRace.profileChanged();
        if (store.get().serverUrl !== previousServer) {
            dailyRace.serverChanged();
        }
        notifyProfile();
        return publicState();
    });

    ipcMain.handle('create-session', () => {
        createSession();
        return store.get().room;
    });

    ipcMain.handle('join-session', (_event, code) => {
        const clean = String(code || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{4,8}$/.test(clean)) {
            return { ok: false, error: 'Session codes are 4 to 8 letters/digits.' };
        }
        joinSession(clean);
        return { ok: true };
    });

    ipcMain.handle('leave-session', () => {
        leaveSession();
    });

    ipcMain.handle('copy-invite', () => {
        copyInvite();
        return store.get().room;
    });

    ipcMain.handle('fix-accessibility', () => fixAccessibility());
}

// ---------- Lifecycle ----------

app.whenReady().then(() => {
    if (process.platform === 'darwin' && app.dock) {
        app.dock.hide();
    }

    store = new Store(path.join(app.getPath('userData'), 'settings.json'));

    // Created before the input hook starts: every tap also counts for the daily race.
    dailyRace = new DailyRace({
        store,
        getCatalog: () => gacha.getCatalog(),
        getServerUrl: () => store.get().serverUrl,
        // Podium capsules land in the shared capsule stock.
        onReward: (capsules) => {
            store.set({ tokens: store.get().tokens + capsules });
            notifyProfile();
        },
    });

    session = new SessionClient({
        getProfile: () => store.get(),
        onEvent: (channel, payload) => {
            // Friends' taps and emojis go to that friend's own window.
            if (channel === 'peer-update') {
                if (!peerWindows.has(payload.peer.id)) {
                    syncPeerWindows(session.getStatus().peers);
                }
                sendToPeer(payload.peer.id, channel, payload);
                return;
            }
            if (channel === 'peer-emoji') {
                sendToPeer(payload.id, channel, payload);
                return;
            }
            sendToOverlay(channel, payload);
            sendToSettings(channel, payload);
            if (channel === 'session') {
                syncPeerWindows(payload.peers);
                refreshTray();
            }
        },
        onError: (message) => {
            // The server refused the session (full, invalid...): forget it so we don't retry on next launch.
            store.set({ room: null });
            refreshTray();
            if (settingsWindow) {
                sendToSettings('session-error', message);
            } else {
                dialog.showErrorBox('Bongo Champs', message);
            }
        },
    });

    registerIpc();
    createOverlayWindow();
    createTray();
    startInputHook();
    startPlayClock();
    startAutoUpdater();

    dailyRace.start();
    refreshTray();

    const startupLink = process.argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
    const startupCode = pendingDeepLink || parseDeepLink(startupLink);
    if (startupCode) {
        joinSession(startupCode);
    } else if (store.get().room) {
        session.join(store.get().room);
    }
});

// Keep running in the tray when windows are closed.
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
    if (store) {
        store.flush();
    }
    if (session) {
        session.leave();
    }
    if (inputHookStarted) {
        require('uiohook-napi').uIOhook.stop();
    }
});
