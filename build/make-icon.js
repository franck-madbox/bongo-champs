// Renders build/icon.png (1024x1024) from the Champ rig. Run with: npx electron build/make-icon.js
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const SIZE = 1024;
const assets = path.join(__dirname, '..', 'src', 'renderer', 'assets').replace(/\\/g, '/');

const html = `<!doctype html><html><head><style>
html, body { margin: 0; width: ${SIZE}px; height: ${SIZE}px; background: transparent; overflow: hidden; }
.bg { position: absolute; inset: 80px; border-radius: 190px; background: linear-gradient(160deg, #ffb54d, #ff8a1f); }
.stage { position: absolute; left: 46%; top: 55%; width: 242px; height: 152px; transform: translate(-50%, -50%) scale(3.4); }
.part { position: absolute; background-size: 100% 100%; }
.head { left: 63px; top: 14px; width: 178px; height: 111px; background-image: url("file://${assets}/champs_bongo_head.png"); }
.arm { width: 128px; height: 128px; }
.l { left: 3px; top: 26px; background-image: url("file://${assets}/left_arm_top.png"); }
.r { left: 128px; top: 29px; background-image: url("file://${assets}/right_arm_bot.png"); }
</style></head><body><div class="bg"></div>
<div class="stage"><div class="part head"></div><div class="part arm l"></div><div class="part arm r"></div></div>
</body></html>`;

app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
    const tmp = path.join(app.getPath('temp'), 'bongo-icon.html');
    fs.writeFileSync(tmp, html);
    await win.loadFile(tmp);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, 'icon.png'), image.resize({ width: SIZE, height: SIZE }).toPNG());
    app.quit();
});
