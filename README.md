# Bongo Champs

A Bongo Cat-style desktop buddy with a Champ, for Mac and Windows.
Your Champ sits on top of your screen and taps along with every key and click, with a lifetime counter.
You can create a **session** and invite friends: their Champs show up next to yours, animating live with their counters.

Privacy: only the tap **count** is shared. Keys are never recorded or sent.

## Install

Download the latest version from **[Releases](https://github.com/franck-madbox/bongo-champs/releases/latest)**:
`BongoChamps-<version>-universal.dmg` (Mac, Intel + Apple Silicon) or `BongoChamps-Setup-<version>.exe` (Windows).
Install once: next versions download in the background and a green **Update** button restarts the app on them.

## Use it

- Right-click your Champ (or use the tray/menu-bar icon) to open the menu: create/join a session, copy an invite, settings.
- **Every Champ is movable**: yours and each friend's are separate windows. Drag any of them anywhere (even to another
  screen); each position is remembered. Menu > *Reset positions* lines everyone up again.
- **Size**: Small / Medium / Large from the menu or Settings.
- **Mojis**: click your Champ to open the emoji bar with your Pocket Champs Mojis; the bubble shows above your Champ
  for everyone in the session. 8 Mojis are given, the other 68 are won at the Moji capsule machine.
- **Capsules**: one free capsule per hour with the app open (plus one on first launch), or **buy one for 2,500 taps**
  (keys + clicks; the displayed counter never goes down). Capsules open in Settings > Hats or Settings > Mojis.
  Hats: Common 60%, Rare 28%, Epic 10%, Legendary 2%. Mojis: all equal. Never a duplicate.
  Your worn hat is visible to friends.
- **Daily race**: everyone at Madbox races on today's taps. A click-through track on the right edge of the screen shows
  the top 8 mini Champs (plus you) climbing towards the 🏁 finish. Taps count from midnight to **18:00 Paris time**;
  at 18:00 a podium pops up and the top 3 win **3 / 2 / 1 capsules**. A new race starts at midnight.
  Menu > *Daily race* hides or shows the track.
- **macOS:** the first launch asks for **Accessibility** access (System Settings > Privacy & Security > Accessibility). It's required to count keys and clicks in other apps.

## Develop

```bash
npm install
npm run server          # relay on ws://localhost:8787
npm start               # the app (connects to bongoServerUrl from package.json)
```

The overlay can also be previewed in a regular browser (demo mode with fake friends): serve `src/renderer/` and open `index.html`.

## Relay server

Clients connect to `<serverUrl>/room/<CODE>`. Two interchangeable implementations of the same protocol:

### Production: Cloudflare Workers (free plan, always on, no card)

`cloudflare/` runs each session as a Durable Object (WebSocket Hibernation API, nothing stored).

```bash
cd cloudflare
npm install
npx wrangler login      # once, opens the browser
npm run deploy          # prints https://bongo-champs.<your-subdomain>.workers.dev
```

Current production URL: `wss://bongo-champs.bongo-champs-cloudflare.workers.dev` (already set as `bongoServerUrl` in `package.json`).
Installed apps follow the built-in URL unless a user typed a custom one in Settings > Advanced.

Free plan quota: clients send at most one update every 500 ms while typing (`FLUSH_INTERVAL_MS` in `src/session-client.js`).

### Local / self-hosted: Node

`server/` is the same relay for Node or Docker (exposes `/health`). `npm run server` starts it on `ws://localhost:8787`.

```bash
cd server && docker build -t bongo-champs-server . && docker run -p 8787:8787 bongo-champs-server
```

## Release a new version

1. Bump `version` in `package.json`, commit and push.
2. `gh release create v<version> --target main --title "Bongo Champs <version>" --notes "..."`
3. `GH_TOKEN=$(gh auth token) npx electron-builder --mac --win --publish always`

Installed apps pick it up within 4 hours (or at next launch) through `latest-mac.yml` / `latest.yml`.

## Build installers

```bash
npm run dist:mac        # dist/Bongo Champs-<version>-universal.dmg (Intel + Apple Silicon)
npm run dist:win        # dist/Bongo Champs Setup <version>.exe (can be built from a Mac)
```

App icon: `build/icon.png`, generated from the Champ art by `npx electron build/make-icon.js`.

### Signing

- **macOS**: signed with the self-signed **"Bongo Champs Signing"** certificate by `build/sign-mac.js` (afterPack hook).
  The app identity is `identifier "io.madbox.bongochamps" and certificate root = <cert>`, which does not change between
  builds, so the **Accessibility permission survives updates**. Users still see "unidentified developer" on first open:
  right-click > Open, or System Settings > Privacy & Security > *Open Anyway*.
  - The certificate lives in the login keychain of the build Mac; its files are in `~/.bongo-champs-signing/`
    (`bongo-champs-signing.p12` + `p12-password.txt`). **Back them up** (e.g. 1Password). If lost, a new certificate
    means every Mac user re-grants Accessibility once.
  - Building on another Mac: `security import bongo-champs-signing.p12 -k ~/Library/Keychains/login.keychain-db -P <password> -T /usr/bin/codesign`.
  - Long-term: a Madbox *Developer ID Application* certificate + notarization also removes the Gatekeeper warning
    (then use `mac.identity`, re-enable `hardenedRuntime`, and drop the afterPack hook).
  - If a user lost the permission (e.g. coming from an older ad-hoc build): the overlay shows a **Fix it** button that
    clears the app's old entry (`tccutil reset Accessibility io.madbox.bongochamps`) and asks again.
- **Windows**: SmartScreen shows "Windows protected your PC" > *More info* > *Run anyway*. An Authenticode certificate removes it.

## Art

Sprites live in `src/renderer/assets/` (head + up/down for each arm). Their positions are in `src/renderer/overlay.css`
(`.head`, `.arm.*.up/.down`) and were fitted against `bongo_champs.gif`.

### Hats and Mojis

Catalog (ids, names, rarities, files): `src/catalog.js`. Capsule rules and the tap cost: `src/gacha.js`.
Mojis are exported from the Figma file "PC - Pocket Board", page "Moji Renders" (released ones only),
resized to 128 px PNGs in `src/renderer/assets/mojis/`. To add one: export it, add its id to `MOJI_IDS`.

Hats: placeholder sprites in `src/renderer/assets/hats/*.svg`.
To replace one, export your art in a **130 x 110** frame with the **bottom-center of the hat at (65, 95)**
(that point lands on top of the head), as PNG or SVG, and update its `file` in `src/catalog.js`.
Never rename a hat `id`: ids are what friends' apps receive. To add a hat, add an entry with a new id.
