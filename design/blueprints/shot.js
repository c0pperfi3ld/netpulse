'use strict';
/**
 * Blueprint shotter — renders design/blueprints/gadget-blueprint.html at each
 * window size and writes PNGs. Run: electron design/blueprints/shot.js
 * Offscreen-ish (hidden window, paintWhenInitiallyHidden) so nothing flashes.
 */
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const DIR = __dirname;
const HTML = path.join(DIR, 'gadget-blueprint.html');
const OUT = path.join(DIR, 'out');

const SHOTS = [
  { name: 'gadget-standard.png',          query: 'mode=standard',                 w: 700, h: 430 },
  { name: 'gadget-testing.png',           query: 'mode=standard&end=test',        w: 700, h: 430 },
  { name: 'gadget-compact.png',           query: 'mode=compact',                  w: 640, h: 350 },
  { name: 'gadget-expanded.png',          query: 'mode=expanded',                 w: 800, h: 490 },
  { name: 'gadget-expanded-isolate.png',  query: 'mode=expanded&hide=up,lat',      w: 800, h: 490 },
  { name: 'gadget-hover-tooltip.png',     query: 'mode=expanded&end=test&hover',   w: 800, h: 490 },
  { name: 'gadget-standard-light.png',    query: 'mode=standard&light',           w: 700, h: 430 },
  { name: 'gadget-blueprint-anatomy.png', query: 'mode=standard&annot',           w: 900, h: 340 },
  { name: 'gadget-sizes-sheet.png',       query: 'sheet=1', file: path.join(DIR, 'preview.html'), w: 600, h: 950 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(cfg) {
  const win = new BrowserWindow({
    width: cfg.w,
    height: cfg.h,
    show: false,
    frame: false,
    resizable: false,
    webPreferences: { offscreen: false, contextIsolation: true, nodeIntegration: false },
  });
  const url = `file:///${(cfg.file || HTML).replace(/\\/g, '/')}?${cfg.query}`;
  win.webContents.on('console-message', (_e, _level, msg) => {
    if (typeof msg === 'string' && msg.startsWith('PROBE')) console.log(`  ${msg}`);
  });
  await win.loadURL(url);
  await sleep(1100); // canvas rAF + the 60 ms redraw pass
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, cfg.name), img.toPNG());
  console.log(`shot ${cfg.name}  ${img.getSize().width}x${img.getSize().height}`);
  win.destroy();
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const cfg of SHOTS) {
    try { await shot(cfg); } catch (e) { console.error(`FAIL ${cfg.name}: ${e.message}`); }
  }
  app.quit();
});
app.on('window-all-closed', () => {});
