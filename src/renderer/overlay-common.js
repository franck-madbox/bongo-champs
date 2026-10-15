// Shared by the local Champ window (overlay.js) and each friend's window (peer.js).

// Must match FLUSH_INTERVAL_MS in session-client.js: remote taps are replayed over this duration.
const NETWORK_FLUSH_MS = 500;
const DRAG_THRESHOLD_PX = 3;
// Overlay scale per size setting (large = the sprites' native size, so it stays sharp).
const SIZE_SCALES = { small: 0.7, medium: 0.85, large: 1 };
// Standard emojis sent by 1.1.0 apps, still displayed for friends who haven't updated.
// Keep in sync with LEGACY_EMOJIS in server/server.js and cloudflare/src/index.js.
const LEGACY_EMOJIS = ['😂', '🔥', '👍', '❤️', '😮', '🎉', '💀', '👋'];

/** Sprite path of a hat id from the catalog (unknown ids, e.g. from a newer app version, show no hat). */
function hatFile(catalog, hatId) {
    const hat = catalog && hatId ? catalog.hats.find((entry) => entry.id === hatId) : null;
    return hat ? hat.file : null;
}

/** What to show in a bubble for an emoji id: a Moji image, a legacy emoji, or null for anything unknown. */
function emojiContent(catalog, emojiId) {
    const moji = catalog ? catalog.mojis.find((entry) => entry.id === emojiId) : null;
    if (moji) {
        return { file: moji.file, label: moji.name };
    }
    return LEGACY_EMOJIS.includes(emojiId) ? { text: emojiId } : null;
}

/** Returns a function asking the main process to resize the transparent window around `contentEl`. */
function createFitter(api, contentEl) {
    let queued = false;
    return function requestFit() {
        if (queued) {
            return;
        }
        queued = true;
        requestAnimationFrame(() => {
            queued = false;
            const rect = contentEl.getBoundingClientRect();
            api.resize({ width: Math.ceil(rect.width), height: Math.ceil(rect.height) });
        });
    };
}

function applySize(contentEl, size, requestFit) {
    contentEl.style.zoom = String(SIZE_SCALES[size] || SIZE_SCALES.medium);
    requestFit();
}

/**
 * Drag-to-move for the whole window, plus right-click menu.
 * @param {{isInteractive?: (target: Element) => boolean, onClick?: (target: Element) => void}} options
 *   isInteractive: elements that keep normal clicks; onClick: a press released without moving.
 */
function setupWindowDrag(api, options) {
    const isInteractive = options.isInteractive || (() => false);
    let dragStart = null;

    document.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || isInteractive(event.target)) {
            return;
        }
        dragStart = { x: event.screenX, y: event.screenY, moved: false, target: event.target };
        document.body.setPointerCapture(event.pointerId);
    });

    document.addEventListener('pointermove', (event) => {
        if (!dragStart) {
            return;
        }
        const dx = event.screenX - dragStart.x;
        const dy = event.screenY - dragStart.y;
        if (!dragStart.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD_PX) {
            return;
        }
        dragStart.moved = true;
        document.body.classList.add('dragging');
        api.drag({ dx, dy });
        dragStart.x = event.screenX;
        dragStart.y = event.screenY;
    });

    document.addEventListener('pointerup', () => {
        if (dragStart && dragStart.moved) {
            api.dragEnd();
        } else if (dragStart && options.onClick) {
            options.onClick(dragStart.target);
        }
        dragStart = null;
        document.body.classList.remove('dragging');
    });

    document.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        api.openMenu();
    });
}
