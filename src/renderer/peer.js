// One friend's Champ, in its own transparent window so it can be placed anywhere on screen.
// The main process only sends this window the events of its friend (id in the URL).

const api = window.bongo;
const contentEl = document.getElementById('content');
const requestFit = createFitter(api, contentEl);
const champ = new Champ(document.getElementById('champ-template'), { isMe: false });
document.getElementById('row').appendChild(champ.root);

let catalog = null;

function applyPeer(peer) {
    champ.setName(peer.name, null);
    champ.setHue(peer.hue);
    champ.setHat(hatFile(catalog, peer.hat));
}

api.on('profile', (state) => {
    catalog = state.catalog;
    applySize(contentEl, state.size, requestFit);
});

api.on('peer-update', ({ peer, taps }) => {
    applyPeer(peer);
    champ.playBurst(taps, peer.count, NETWORK_FLUSH_MS);
});

api.on('peer-emoji', ({ e }) => {
    const content = emojiContent(catalog, e);
    if (content) {
        champ.showEmoji(content);
    }
});

setupWindowDrag(api, {});

async function init() {
    const peerId = new URLSearchParams(location.search).get('id');
    const state = await api.getPeerState(peerId);
    catalog = state.catalog;
    if (state.peer) {
        applyPeer(state.peer);
        champ.setCount(state.peer.count);
    }
    applySize(contentEl, state.size, requestFit);
}

init();
