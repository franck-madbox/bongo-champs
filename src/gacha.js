// Capsule rules shared by every collection (hats, Mojis). Main process only:
// the renderer receives the catalog and owned items through the state.

const { RARITIES, HATS, MOJIS, STARTER_MOJIS } = require('./catalog');

const HOUR_MS = 60 * 60 * 1000;
const WELCOME_TOKENS = 1;
// Taps (keys + clicks) spent to buy one capsule. The displayed lifetime counter never goes down.
const CAPSULE_TAP_COST = 2500;

const COLLECTIONS = {
    hats: { items: HATS, stateKey: 'hats', starters: [] },
    mojis: { items: MOJIS, stateKey: 'mojis', starters: STARTER_MOJIS },
};

function getCatalog() {
    return { rarities: RARITIES, hats: HATS, mojis: MOJIS, capsuleCost: CAPSULE_TAP_COST };
}

/** Ids owned in a collection: free starters + items won. */
function ownedIds(state, collectionId) {
    const collection = COLLECTIONS[collectionId];
    return [...collection.starters, ...(state[collection.stateKey] || [])];
}

function isOwnedHat(state, hatId) {
    return hatId === null || ownedIds(state, 'hats').includes(hatId);
}

/**
 * Adds play time and converts each full hour into a capsule token.
 * @returns {object} the state patch.
 */
function addPlayTime(state, elapsedMs) {
    const playMs = state.playMs + elapsedMs;
    const earned = Math.floor(playMs / HOUR_MS);
    return { playMs: playMs - earned * HOUR_MS, tokens: state.tokens + earned };
}

/** Milliseconds of play left before the next token. */
function msUntilNextToken(state) {
    return HOUR_MS - state.playMs;
}

/** Converts CAPSULE_TAP_COST tap points into one capsule token. */
function buyCapsule(state) {
    if (state.points < CAPSULE_TAP_COST) {
        return { error: 'not-enough-points' };
    }
    return { patch: { points: state.points - CAPSULE_TAP_COST, tokens: state.tokens + 1 } };
}

/**
 * Opens one capsule in a collection: picks a rarity by weight among rarities with unowned items
 * (items without rarity count as common), then a random unowned item in it. No duplicates.
 * @returns {{patch: object, item: object}|{error: string}}
 */
function pull(state, collectionId, random = Math.random) {
    const collection = COLLECTIONS[collectionId];
    if (!collection) {
        return { error: 'unknown-collection' };
    }
    if (state.tokens <= 0) {
        return { error: 'no-token' };
    }

    const owned = ownedIds(state, collectionId);
    const unownedByRarity = {};
    for (const item of collection.items) {
        if (!owned.includes(item.id)) {
            const rarity = item.rarity || 'common';
            (unownedByRarity[rarity] = unownedByRarity[rarity] || []).push(item);
        }
    }
    const rarities = Object.keys(unownedByRarity);
    if (rarities.length === 0) {
        return { error: 'complete' };
    }

    let total = 0;
    for (const rarity of rarities) {
        total += RARITIES[rarity].weight;
    }
    let roll = random() * total;
    let chosen = rarities[rarities.length - 1];
    for (const rarity of rarities) {
        roll -= RARITIES[rarity].weight;
        if (roll < 0) {
            chosen = rarity;
            break;
        }
    }

    const pool = unownedByRarity[chosen];
    const item = pool[Math.floor(random() * pool.length)];
    const patch = {
        tokens: state.tokens - 1,
        [collection.stateKey]: [...(state[collection.stateKey] || []), item.id],
    };
    // A new hat is worn right away.
    if (collectionId === 'hats') {
        patch.hat = item.id;
    }
    return { item, patch };
}

module.exports = {
    HOUR_MS, WELCOME_TOKENS, CAPSULE_TAP_COST,
    getCatalog, ownedIds, isOwnedHat, addPlayTime, msUntilNextToken, buyCapsule, pull,
};
