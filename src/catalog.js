// Collectible catalog: hats and Mojis. Ids are synced to friends' apps: never rename one, only add new ones.
// Art lives in src/renderer/assets/ (paths are relative to the renderer folder). See README > Art.

// Hat drop chances per rarity (renormalized over the rarities that still have hats to win).
const RARITIES = {
    common: { label: 'Common', weight: 60 },
    rare: { label: 'Rare', weight: 28 },
    epic: { label: 'Epic', weight: 10 },
    legendary: { label: 'Legendary', weight: 2 },
};

const HAT_LIST = [
    ['party', 'Party Hat', 'common'],
    ['beanie', 'Beanie', 'common'],
    ['cap', 'Cap', 'common'],
    ['flower', 'Flower', 'common'],
    ['chef', 'Chef Hat', 'common'],
    ['straw', 'Straw Hat', 'common'],
    ['bucket', 'Bucket Hat', 'common'],
    ['bow', 'Bow', 'common'],
    ['tophat', 'Top Hat', 'rare'],
    ['cowboy', 'Cowboy Hat', 'rare'],
    ['viking', 'Viking Helmet', 'rare'],
    ['sombrero', 'Sombrero', 'rare'],
    ['graduation', 'Graduation Cap', 'rare'],
    ['santa', 'Santa Hat', 'rare'],
    ['poop', 'Poop', 'rare'],
    ['wizard', 'Wizard Hat', 'epic'],
    ['pirate', 'Pirate Hat', 'epic'],
    ['jester', 'Jester Hat', 'epic'],
    ['samurai', 'Samurai Helmet', 'epic'],
    ['dino', 'Dino Hood', 'epic'],
    ['crown', 'Crown', 'legendary'],
    ['unicorn-horn', 'Unicorn Horn', 'legendary'],
    ['mini-champ', 'Mini Champ', 'legendary'],
];

const HATS = HAT_LIST.map(([id, name, rarity]) => ({ id, name, rarity, file: `assets/hats/${id}.svg` }));

// Pocket Champs Mojis, exported from the Figma "Moji Renders" page (released ones only), in Figma order.
const MOJI_IDS = [
    'crying', 'happy', 'heart', 'mad', 'sunglasses', 'surprised', 'tired', 'tongue', 'falling', 'footfan-gg',
    'monkey-questioning', 'one-hand', 'shiba-wow', 'heart-hug',
    'magician-hat', 'unicorn', 'devil-laugh', 'dino-clap', 'hello', 'sleepy', 'super-angry', 'thumb-up', 'waterfall',
    'birthday-hat', 'birthday-cake', 'grateful', 'anxious', 'wrestler',
    'spooky-cat', 'snowball', 'surrender', 'panda-kungfu', 'lion-roaring', 'burger-chief', 'trophy', 'dragon-sleep',
    'on-fire', 'robot-wink', 'anubis-dance', 'gift', 'frozen', 'penguin',
    'champuccino', 'teddy-kiss', 'chicky', 'ostrich-bot', 'vampyr-wakeup', 'fairie', 'steal-trophy', 'angel',
    'spooky-pilot-onfire', 'yeti', 'slurp-dog', 'basket', 'cool-parot', 'dragon-fire',
    'christmas-tree-dancing', 'walrus-fish', 'frog-kiss', 'fire-horse', 'sakura-shy', 'kpop-rabbit', 'pride',
    'blueberry', 'bat-tongue', 'spooky-pirate', 'raccoon-bin', 'candle-fire', 'friend-gift',
    'beetle-bot', 'slime', 'elf-snowball', 'cheetah-bot-sleep', 'ice-jarl', 'valkyrie', 'knight-fighting',
];

// Display names that title-casing the id gets wrong.
const MOJI_NAMES = {
    'footfan-gg': 'Footfan GG',
    'one-hand': '#1 Hand',
    'cool-parot': 'Cool Parrot',
    'kpop-rabbit': 'K-pop Rabbit',
    'spooky-pilot-onfire': 'Spooky Pilot On Fire',
};

function titleCase(id) {
    return id.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

const MOJIS = MOJI_IDS.map((id) => ({ id, name: MOJI_NAMES[id] || titleCase(id), file: `assets/mojis/${id}.png` }));

// Given to everyone: they replace the standard emojis in the emoji bar.
const STARTER_MOJIS = ['happy', 'heart', 'crying', 'mad', 'thumb-up', 'hello', 'sunglasses', 'surprised'];

module.exports = { RARITIES, HATS, MOJIS, STARTER_MOJIS };
