// Exposes a minimal, safe API to the renderer pages.

const { contextBridge, ipcRenderer } = require('electron');

const LISTENED_CHANNELS = ['tap', 'release', 'session', 'peer-update', 'peer-emoji', 'profile', 'permission', 'session-error', 'race', 'podium'];

contextBridge.exposeInMainWorld('bongo', {
    getState: () => ipcRenderer.invoke('get-state'),
    getPeerState: (peerId) => ipcRenderer.invoke('get-peer-state', peerId),
    on: (channel, callback) => {
        if (LISTENED_CHANNELS.includes(channel)) {
            ipcRenderer.on(channel, (_event, payload) => callback(payload));
        }
    },
    resize: (size) => ipcRenderer.send('overlay-resize', size),
    drag: (delta) => ipcRenderer.send('overlay-drag', delta),
    dragEnd: () => ipcRenderer.send('overlay-drag-end'),
    openMenu: () => ipcRenderer.send('overlay-menu'),
    saveProfile: (profile) => ipcRenderer.invoke('save-profile', profile),
    createSession: () => ipcRenderer.invoke('create-session'),
    joinSession: (code) => ipcRenderer.invoke('join-session', code),
    leaveSession: () => ipcRenderer.invoke('leave-session'),
    copyInvite: () => ipcRenderer.invoke('copy-invite'),
    fixAccessibility: () => ipcRenderer.invoke('fix-accessibility'),
    openCapsule: (collectionId) => ipcRenderer.invoke('open-capsule', collectionId),
    buyCapsule: () => ipcRenderer.invoke('buy-capsule'),
    wearHat: (hatId) => ipcRenderer.invoke('wear-hat', hatId),
    sendEmoji: (emoji) => ipcRenderer.send('send-emoji', emoji),
    openSettings: () => ipcRenderer.send('open-settings'),
    installUpdate: () => ipcRenderer.send('install-update'),
});
