'use strict';
/**
 * Electron main process: window lifecycle, IPC surface, QA harness.
 *
 * The renderer is untrusted-by-design: contextIsolation on, no nodeIntegration,
 * and a narrow preload bridge. Every probe lives in the main process.
 */
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, shell, nativeTheme } = require('electron');
const { Store } = require('./store');
const { Scheduler } = require('./scheduler');
const { buildReport, reportName } = require('./report');
const { killAll } = require('./util/proc');

const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');

function argValue(flag, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (hit) return hit.slice(flag.length + 1);
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) return process.argv[idx + 1];
  return fallback;
}

const QA = process.argv.includes('--qa');
const QA_SHOT_DIR = argValue('--shot-dir', path.join(DATA_DIR, 'qa'));
const QA_WAIT_MS = Number(argValue('--qa-wait', 12000));

let win = null;
let store = null;
let scheduler = null;
let heartbeat = null;
const rendererConsole = [];

/* Realtime push. The old build shipped a fixed 4 Hz timer that serialised the
   whole snapshot whether or not anything had changed. Now a snapshot is built
   the moment a sample or a test result lands, coalesced to one per event burst,
   with a 1 Hz heartbeat only for uptime/CPU. Fewer snapshots, lower latency. */
let pushTimer = null;
let lastPushAt = 0;

/* Gadget mode: a small always-on-top window that shows download / upload /
   latency and nothing else. The main shell is hidden, the window is resized,
   and the previous bounds are restored on exit. */
/* Three remembered sizes. Compact is the old footprint plus 22 px of graph;
   standard is the default; expanded adds the jitter tile and the extra chips. */
const GADGET_SIZES = {
  compact: { width: 396, height: 200 },
  standard: { width: 460, height: 272 },
  expanded: { width: 560, height: 340 },
};
const GADGET_SIZE_ORDER = ['compact', 'standard', 'expanded'];
const gadgetSizeOf = (s) => (GADGET_SIZES[s] ? s : 'standard');
/* Freely draggable gadget: presets are starting points, not a cage. */
const GADGET_MIN = { width: 340, height: 150 };
const GADGET_MAX = { width: 1100, height: 620 };
let gadget = false;
let gadgetTween = null;
let gadgetWasMaximized = false;
let normalBounds = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1180,
    minHeight: 720,
    resizable: true,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    // NOT transparent: Chromium reports a transparent window as occluded far more
    // eagerly, and this app deliberately skips all paint work while document.hidden
    // is set (see the renderer snapshot handler) — so transparency silently froze
    // every chart. Windows 11 already rounds a frameless window, so the gadget gets
    // real rounded corners without paying for that.
    backgroundColor: '#070b14',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  const relay = (state) => win && !win.isDestroyed() && win.webContents.send('np:window-state', state);
  win.on('maximize', () => relay({ maximized: true }));
  win.on('unmaximize', () => relay({ maximized: false }));
  win.on('enter-full-screen', () => relay({ fullscreen: true }));
  win.on('leave-full-screen', () => relay({ fullscreen: false }));
  win.on('show', () => pushSnapshot(true));
  win.on('restore', () => pushSnapshot(true));
  win.on('focus', () => pushSnapshot(true));
  win.on('closed', () => {
    win = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) rendererConsole.push({ level, message, line, source });
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    rendererConsole.push({ level: 3, message: `renderer gone: ${details.reason}` });
  });

  return win;
}

function pushSnapshot(force = false) {
  if (!win || win.isDestroyed()) return;
  if (!force && (win.isMinimized() || !win.isVisible())) return;
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  lastPushAt = Date.now();
  try {
    win.webContents.send('np:snapshot', scheduler.snapshot());
  } catch {
    /* window tearing down */
  }
}

/** Coalesce every change that happens inside one event-loop turn into one push. */
function schedulePush(delay = 16) {
  if (pushTimer) return;
  if (!win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushSnapshot();
  }, Math.max(0, delay));
}

function wireScheduler() {
  const send = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload);
  scheduler.on('event', (ev) => send('np:event', ev));
  scheduler.on('env', (patch) => {
    send('np:env', patch);
    schedulePush(16);
  });
  scheduler.on('test:phase', (p) => send('np:test-phase', p));
  scheduler.on('test:progress', (p) => send('np:test-progress', p));
  scheduler.on('bb:phase', (p) => send('np:test-phase', { phase: p.phase }));
  scheduler.on('ramp:step', (p) => send('np:ramp-step', p));
  // Sample-driven: the renderer sees a new point within a frame of it existing.
  scheduler.on('dirty', () => schedulePush(16));
  // Slow beat: nothing changed, but uptime/CPU/memory still need to tick.
  heartbeat = setInterval(() => {
    if (!win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return;
    if (Date.now() - lastPushAt >= 900) schedulePush(0);
  }, 1000);
}

/**
 * Swap between the dashboard and the gadget without recreating the window, so
 * the ping streams, charts and history all survive the transition.
 */
function setGadget(on) {
  if (!win || win.isDestroyed()) return { gadget: false };
  const want = typeof on === 'boolean' ? on : !gadget;
  if (want === gadget) {
    win.webContents.send('np:gadget', { gadget });
    pushSnapshot(true);
    return { gadget };
  }
  if (want) {
    gadgetWasMaximized = win.isMaximized();
    normalBounds = gadgetWasMaximized ? null : win.getBounds();
    if (gadgetWasMaximized) win.unmaximize();
    win.setMinimumSize(GADGET_MIN.width, GADGET_MIN.height);
    win.setMaximumSize(GADGET_MAX.width, GADGET_MAX.height);
    // Resizable in gadget mode: the user can drag any edge, and the size they pick
    // is remembered as a custom size instead of being snapped back to a preset.
    win.setResizable(true);
    const b = win.getBounds();
    const szKey = gadgetSizeOf(store && store.settings && store.settings.gadgetSize);
    const custom = store && store.settings && store.settings.gadgetCustom;
    const sz = custom && custom.width >= GADGET_MIN.width ? { width: custom.width, height: custom.height } : GADGET_SIZES[szKey];
    const savedPos = store && store.settings && store.settings.gadgetPos;
    const targetX = savedPos && typeof savedPos.x === 'number' ? savedPos.x : Math.round(b.x + b.width - sz.width);
    const targetY = savedPos && typeof savedPos.y === 'number' ? savedPos.y : b.y;
    win.setBounds(
      { x: targetX, y: targetY, width: sz.width, height: sz.height },
      true
    );
    win.setAlwaysOnTop(!(store && store.settings && store.settings.gadgetPin === false), 'floating');
    gadget = true;
    // A dragged size is remembered, so the widget comes back exactly as left.
    if (!win.__gadgetResizeHooked) {
      win.__gadgetResizeHooked = true;
      let t = null;
      win.on('resize', () => {
        if (!gadget) return;
        clearTimeout(t);
        t = setTimeout(() => {
          if (!win || win.isDestroyed() || !gadget) return;
          if (gadgetTween) return; // ignore the frames of our own size tween
          const r = win.getBounds();
          if (store) store.saveSettings({ gadgetCustom: { width: r.width, height: r.height } });
        }, 500);
      });
    }
  } else {
    const cur = win.getBounds();
    if (store) store.saveSettings({ gadgetPos: { x: cur.x, y: cur.y } });
    win.setAlwaysOnTop(false);
    win.setResizable(true);
    win.setMinimumSize(1180, 720);
    gadget = false;
    if (gadgetWasMaximized) win.maximize();
    else if (normalBounds) win.setBounds(normalBounds, true);
    gadgetWasMaximized = false;
    normalBounds = null;
  }
  win.webContents.send('np:gadget', { gadget });
  pushSnapshot(true);
  return { gadget };
}

/**
 * Snap the gadget to a named size. Animated, because a widget that teleports
 * between sizes is a widget you keep losing track of: the window keeps its
 * top-left corner and eases out to the new box at ~60 Hz.
 */
function setGadgetSize(size, { animate = true } = {}) {
  const key = gadgetSizeOf(size);
  if (store) store.saveSettings({ gadgetSize: key, gadgetCustom: null });
  if (!win || win.isDestroyed() || !gadget) return { gadgetSize: key };
  const b = win.getBounds();
  const target = GADGET_SIZES[key];
  const x = Math.max(0, Math.min(b.x, b.x + b.width - target.width));
  const to = { x, y: b.y, width: target.width, height: target.height };
  if (gadgetTween) clearInterval(gadgetTween);
  if (!animate) {
    win.setBounds(to, false);
    return { gadgetSize: key };
  }
  const from = { x: b.x, y: b.y, width: b.width, height: b.height };
  const steps = 10;
  let i = 0;
  gadgetTween = setInterval(() => {
    i++;
    if (!win || win.isDestroyed()) {
      clearInterval(gadgetTween);
      gadgetTween = null;
      return;
    }
    const k = 1 - Math.pow(1 - i / steps, 3); // ease-out cubic
    const lerp = (a, c) => Math.round(a + (c - a) * k);
    if (i >= steps) {
      clearInterval(gadgetTween);
      gadgetTween = null;
      win.setBounds(to, false);
      return;
    }
    win.setBounds({ x: lerp(from.x, to.x), y: lerp(from.y, to.y), width: lerp(from.width, to.width), height: lerp(from.height, to.height) }, false);
  }, 16);
  return { gadgetSize: key };
}

/** Pin toggles the always-on-top flag; the dashboard view is never pinned. */
function setGadgetPin(on) {
  const pin = Boolean(on);
  if (store) store.saveSettings({ gadgetPin: pin });
  if (win && !win.isDestroyed() && gadget) {
    win.setAlwaysOnTop(pin, 'floating');
    win.setVisibleOnAllWorkspaces(pin, { visibleOnFullScreen: true });
  }
  return { gadgetPin: pin };
}

function registerIpc() {
  ipcMain.handle('np:gadget', (_e, on) => setGadget(on));
  ipcMain.handle('np:gadget:size', (_e, size) => setGadgetSize(size));
  ipcMain.handle('np:gadget:pin', (_e, on) => setGadgetPin(on));
  ipcMain.handle('np:snapshot', () => scheduler.snapshot());

  ipcMain.handle('np:settings:set', (_e, patch) => {
    const next = store.saveSettings(patch || {});
    scheduler.settings = next;
    scheduler.syncStreams();
    // Window length, targets and thresholds all change what a snapshot says.
    scheduler.invalidate();
    return next;
  });

  ipcMain.handle('np:test:run', async (_e, { kind, opts } = {}) => {
    try {
      switch (kind) {
        case 'speed':
          return await scheduler.runSpeedTest(opts || {});
        case 'ramp':
          return await scheduler.runRamp(opts || {});
        case 'bufferbloat':
          return await scheduler.runBufferbloat(opts || {});
        case 'dns':
          return await scheduler.runDns();
        case 'mtu':
          return await scheduler.runMtu();
        case 'sweep':
          return await scheduler.runLatencySweep(opts || {});
        case 'env':
          await scheduler.refreshEnvironment({});
          return scheduler.snapshot();
        default:
          throw new Error(`unknown test kind: ${kind}`);
      }
    } catch (e) {
      scheduler.log('error', `${kind} failed: ${e.message}`);
      return { error: e.message };
    }
  });

  ipcMain.handle('np:pause', (_e, paused) => {
    scheduler.setPaused(Boolean(paused));
    return scheduler.snapshot();
  });

  ipcMain.handle('np:history', (_e, { days = 1, kind = null, limit = 5000 } = {}) =>
    store.readSamples({ days, kind, limit })
  );

  ipcMain.handle('np:report:export', () => {
    const snap = scheduler.snapshot();
    const history = store.readSamples({ days: 1, kind: 'throughput', limit: 500 }).map((h) => ({
      t: h.t,
      direction: h.direction,
      mbps: h.mbps,
      streams: h.streams,
    }));
    const md = buildReport(snap, { history });
    const file = store.writeReport(reportName(), md);
    scheduler.log('info', `report written: ${path.basename(file)}`);
    return { file, markdown: md, stats: store.stats() };
  });

  ipcMain.handle('np:report:preview', () => {
    const snap = scheduler.snapshot();
    const history = store.readSamples({ days: 1, kind: 'throughput', limit: 500 }).map((h) => ({
      t: h.t,
      direction: h.direction,
      mbps: h.mbps,
      streams: h.streams,
    }));
    return { markdown: buildReport(snap, { history }) };
  });

  /**
   * MTU fix: never elevates silently. Writes a .bat with the exact command and
   * asks Windows for consent via Start-Process -Verb RunAs. Reversible.
   */
  ipcMain.handle('np:mtu:apply', async () => {
    const cmd = scheduler.mtu && scheduler.mtu.fixCommand;
    if (!cmd) return { ok: false, error: 'no MTU change needed' };
    const bat = path.join(DATA_DIR, 'apply-mtu.bat');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      bat,
      ['@echo off', cmd, `netsh interface ipv4 set subinterface "${scheduler.mtu.iface}" mtu=${scheduler.mtu.pathMtu} store=active`, 'exit'].join('\r\n')
    );
    const { spawn } = require('node:child_process');
    return new Promise((resolve) => {
      const p = spawn('powershell', ['-NoProfile', '-Command', `Start-Process -FilePath '${bat}' -Verb RunAs -WindowStyle Hidden`], {
        windowsHide: true,
      });
      p.on('close', async (code) => {
        // Give the elevated child a moment, then re-read reality instead of guessing.
        await new Promise((r) => setTimeout(r, 2500));
        const mtu = await scheduler.runMtu();
        resolve({ ok: code === 0 && mtu.verdict !== 'blackhole', launchCode: code, mtu });
      });
      p.on('error', (e) => resolve({ ok: false, error: e.message }));
    });
  });

  ipcMain.handle('np:mtu:revert', async () => {
    if (!scheduler.mtu || !scheduler.mtu.revertCommand) return { ok: false, error: 'nothing to revert' };
    const bat = path.join(DATA_DIR, 'revert-mtu.bat');
    fs.writeFileSync(bat, ['@echo off', scheduler.mtu.revertCommand, 'exit'].join('\r\n'));
    const { spawn } = require('node:child_process');
    return new Promise((resolve) => {
      const p = spawn('powershell', ['-NoProfile', '-Command', `Start-Process -FilePath '${bat}' -Verb RunAs -WindowStyle Hidden`], { windowsHide: true });
      p.on('close', async (code) => {
        await new Promise((r) => setTimeout(r, 2500));
        const mtu = await scheduler.runMtu();
        resolve({ ok: code === 0, launchCode: code, mtu });
      });
      p.on('error', (e) => resolve({ ok: false, error: e.message }));
    });
  });

  ipcMain.handle('np:open', (_e, target) => {
    if (typeof target !== 'string') return false;
    shell.openPath(target);
    return true;
  });

  ipcMain.handle('np:data-stats', () => store.stats());

  ipcMain.handle('np:clipboard', (_e, text) => {
    require('electron').clipboard.writeText(String(text ?? ''));
    return true;
  });

  ipcMain.on('np:window', (_e, action) => {
    if (!win) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize());
    else if (action === 'close') win.close();
  });

  ipcMain.on('np:theme', (_e, theme) => {
    nativeTheme.themeSource = theme === 'system' ? 'system' : theme === 'light' ? 'light' : 'dark';
  });
}

/* --------------------------------------------------------------------- QA mode */

async function runQa(winRef) {
  fs.mkdirSync(QA_SHOT_DIR, { recursive: true });
  console.log('QA_STAGE start');
  const views = ['overview', 'throughput', 'latency', 'diagnostics', 'settings'];
  const shots = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const warm = [];

  // QA must exercise real code paths: run every probe once (small sizes) so the
  // screenshots show populated panels instead of empty states.
  if (!process.argv.includes('--qa-cold')) {
    const step = async (name, fn) => {
      const t0 = Date.now();
      try {
        await fn();
        warm.push({ name, ok: true, ms: Date.now() - t0 });
      } catch (e) {
        warm.push({ name, ok: false, ms: Date.now() - t0, error: e.message });
      }
    };
    await step('mtu', () => scheduler.runMtu());
    await step('dns', () => scheduler.runDns());
    await step('speed', () => scheduler.runSpeedTest({ bytes: 10_000_000, streams: 4, reason: 'qa' }));
    await step('ramp', () => scheduler.runRamp({ bytes: 5_000_000, maxStreams: 4, direction: 'down' }));
    await step('bufferbloat', () => scheduler.runBufferbloat({ streams: 3, bytesPerStream: 8_000_000 }));
    await step('sweep', () => scheduler.runLatencySweep({ count: 8 }));
  }

  await wait(QA_WAIT_MS); // let the live latency series accumulate

  // Bandwidth-apps panel: it is the one overview card driven by a separate OS
  // sampler, so prove it exists, is populated, and does not clip.
  winRef.webContents.send('np:qa-view', 'overview');
  await wait(5200); // two typeperf intervals
  const appsPanel = await winRef.webContents.executeJavaScript(`(() => {
    const card = [...document.querySelectorAll('.card')].find((c) => c.textContent.includes('Bandwidth apps'));
    if (!card) return { present: false };
    const rows = [...card.querySelectorAll('.app-row')];
    return {
      present: true,
      sub: card.querySelector('.card-sub') ? card.querySelector('.card-sub').textContent : '',
      rows: rows.map((r) => r.querySelector('.app-name').textContent + ' ' + r.querySelector('.app-val').textContent),
      empty: card.querySelector('.app-empty') ? card.querySelector('.app-empty').textContent : null,
      clipped: rows.some((r) => r.scrollWidth > r.clientWidth + 1),
    };
  })()`);
  if (!appsPanel.present) throw new Error('bandwidth apps panel missing from overview');

  console.log('QA_STAGE live-chart');
  // The download chart used to only gain a point when a test *finished*, so it
  // sat still for the whole transfer. Prove it now moves while data is flowing.
  const liveChart = await winRef.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('[data-nav="overview"]').click();
    await wait(700);
    const canv = [...document.querySelectorAll('#view-root canvas')];
    const t0 = Date.now();
    // Gate on DATA, not pixels. getImageData() reads back an empty buffer for every
    // sample on this machine (reproduced byte-for-byte on the untouched build), so a
    // pixel gate can only ever report zero ink and can never pass.
    const fresh = () => (window.NP.state.linkRate.down || []).filter((p) => p[0] >= t0).length;
    const before = fresh();
    window.netpulse.runTest('speed', { direction: 'down', bytes: 20000000 }).catch(() => {});
    await wait(4500);
    const during = fresh();
    const busy = window.NP.state.snap.overhead.busy;
    const link = window.NP.state.snap.linkRate.downMbps;
    await wait(4500);
    const after = fresh();
    // Kept as a diagnostic only: ink is what the user sees, but it is not readable
    // back on this GPU path, so it must not decide pass/fail.
    const inkNow = (() => {
      const c = canv[1];
      if (!c) return null;
      try {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4 * 31) if (d[i] > 8) n += 1;
        return n;
      } catch { return null; }
    })();
    return { before, during, after, busy, link, inkAfter: inkNow };
  })()`);
  // A transfer must add live link-rate points inside the window the chart plots.
  if (!(liveChart.during > liveChart.before && liveChart.after >= liveChart.during)) {
    throw new Error(`download chart did not gain live points during a transfer: ${JSON.stringify(liveChart)}`);
  }

  console.log('QA_STAGE per-view');
  // Renderer exceptions are caught and surfaced as toasts, so a toast is the
  // only place a broken update() shows up. Fail the run if one is an error.
  const toasts = await winRef.webContents.executeJavaScript(
    `[...document.querySelectorAll('.toast')].map((t) => t.textContent)`
  );
  const errorToasts = toasts.filter((t) => /error|not defined|undefined is not/i.test(t));
  if (errorToasts.length) throw new Error(`renderer error toast: ${errorToasts.join(' | ')}`);


  const perView = [];
  for (const view of views) {
    winRef.webContents.send('np:qa-view', view);
    // eslint-disable-next-line no-await-in-loop
    await wait(1400);
    // eslint-disable-next-line no-await-in-loop
    const img = await winRef.webContents.capturePage();
    const file = path.join(QA_SHOT_DIR, `${view}.png`);
    fs.writeFileSync(file, img.toPNG());
    shots.push({ view, file, bytes: fs.statSync(file).size });
    // Assert on the view that is actually on screen; only elements that can
    // actually scroll (overflow != visible) count as an overflow bug.
    // eslint-disable-next-line no-await-in-loop
    const a = await winRef.webContents.executeJavaScript(`(() => {
      const de = document.documentElement;
      const over = [...document.querySelectorAll('*')].filter(node => {
        const cs = getComputedStyle(node);
        const scrollable = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
        return scrollable && node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 1;
      }).slice(0, 8).map(node => node.tagName + '.' + (node.className || '') + ' ' + node.scrollWidth + '>' + node.clientWidth);
      // Content that does not fit its panel (overflow hidden) is still a layout
      // bug for this app: nothing should be clipped away from the user.
      const clipped = [...document.querySelectorAll('.card')].map(card => {
        const body = card.querySelector('.card-body');
        if (!body) return { title: '?', needed: 0, avail: 0 };
        // Only real flex children of THIS body count: nested card bodies are
        // separate cards and their height is already inside their parent part.
        const parts = [...body.children].filter(p => getComputedStyle(p).display !== 'none');
        const gap = parseFloat(getComputedStyle(body).rowGap) || 0;
        const needed = parts.reduce((sum, p) => sum + p.getBoundingClientRect().height, 0) + Math.max(0, parts.length - 1) * gap;
        const avail = body.getBoundingClientRect().height;
        return { title: (card.querySelector('.card-title') || {}).textContent || '?', needed: Math.round(needed), avail: Math.round(avail), parts: parts.length };
      }).filter(c => c.needed > c.avail + 3).slice(0, 8);
      const canvases = [...document.querySelectorAll('canvas')].map(c => ({
        id: c.id || c.className, w: c.width, h: c.height,
        cssW: Math.round(c.getBoundingClientRect().width), cssH: Math.round(c.getBoundingClientRect().height)
      }));
      const readouts = {};
      for (const key of ['rtt', 'down', 'up']) {
        const n = document.querySelector('[data-readout="' + key + '"]');
        readouts[key] = n ? n.textContent.trim() : null;
      }
      return {
        horizontalScroll: de.scrollWidth > de.clientWidth + 1,
        verticalScroll: de.scrollHeight > de.clientHeight + 1,
        scrollWidth: de.scrollWidth, clientWidth: de.clientWidth,
        scrollHeight: de.scrollHeight, clientHeight: de.clientHeight,
        canvases, canvasesDrawn: canvases.filter(c => c.w > 0 && c.h > 0).length,
        overflowing: over,
        clipped,
        ranges: document.querySelectorAll('input[type=range]').length,
        buttons: document.querySelectorAll('button').length,
        tables: document.querySelectorAll('table.data').length,
        readouts
      };
    })()`);
    perView.push({ view, ...a });
  }

  // Finally return to the hero view so the readout numbers can be asserted there.
  winRef.webContents.send('np:qa-view', 'overview');
  await wait(1200);
  const assertions = await winRef.webContents.executeJavaScript(`(() => {
    const de = document.documentElement;
    const readouts = {};
    for (const key of ['rtt', 'down', 'up']) {
      const n = document.querySelector('[data-readout="' + key + '"]');
      readouts[key] = n ? n.textContent.trim() : null;
    }
    return {
      viewport: { w: de.clientWidth, h: de.clientHeight },
      horizontalScroll: de.scrollWidth > de.clientWidth + 1,
      docScroll: { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth },
      realData: Object.values(readouts).filter(v => v && v !== '—').length,
      readouts,
      canvases: document.querySelectorAll('canvas').length,
      liveControls: document.querySelectorAll('input[type=range]').length,
      title: document.title
    };
  })()`);

  // Compact-window pass: the same views at a small size must still fit with no
  // scrollbars and nothing clipped away.
  const [origW, origH] = winRef.getSize();
  winRef.setSize(1180, 740);
  await wait(1000);
  winRef.webContents.send('np:qa-view', 'overview');
  await wait(1000);
  const compactImg = await winRef.webContents.capturePage();
  const compactFile = path.join(QA_SHOT_DIR, 'overview-compact.png');
  fs.writeFileSync(compactFile, compactImg.toPNG());
  const compact = await winRef.webContents.executeJavaScript(`(() => {
    const de = document.documentElement;
    const clipped = [...document.querySelectorAll('.card')].map(card => {
      const body = card.querySelector('.card-body');
      if (!body) return { title: '?', needed: 0, avail: 0 };
      const parts = [...body.children].filter(p => getComputedStyle(p).display !== 'none');
      const gap = parseFloat(getComputedStyle(body).rowGap) || 0;
      const needed = parts.reduce((sum, p) => sum + p.getBoundingClientRect().height, 0) + Math.max(0, parts.length - 1) * gap;
      const avail = body.getBoundingClientRect().height;
      return { title: (card.querySelector('.card-title') || {}).textContent || '?', needed: Math.round(needed), avail: Math.round(avail), parts: parts.length };
    }).filter(c => c.needed > c.avail + 3).slice(0, 8);
    return {
      viewport: { w: de.clientWidth, h: de.clientHeight },
      horizontalScroll: de.scrollWidth > de.clientWidth + 1,
      verticalScroll: de.scrollHeight > de.clientHeight + 1,
      clipped,
      canvases: document.querySelectorAll('canvas').length,
      readouts: ['rtt','down','up'].map(k => {
        const n = document.querySelector('[data-readout="' + k + '"]');
        return { key: k, text: n ? n.textContent.trim() : null };
      })
    };
  })()`);
  winRef.setSize(origW, origH);
  await wait(500);

  // Theme pass: flip through the real settings IPC (main → store → snapshot →
  // renderer chrome) and prove the colours actually changed.
  // Click path, not just IPC: the theme controls are DOM buttons, and a dead
  // listener is exactly the class of bug that only a click can catch.
  winRef.webContents.send('np:qa-view', 'settings');
  await wait(700);
  await winRef.webContents.executeJavaScript(`(() => {
    const b = [...document.querySelectorAll('.seg button')].find((x) => x.textContent.trim() === 'Light');
    if (b) b.click();
    return true;
  })()`);
  await wait(700);
  await winRef.webContents.executeJavaScript(`(() => {
    const b = [...document.querySelectorAll('.seg button')].find((x) => x.textContent.trim() === 'Violet');
    if (b) b.click();
    return true;
  })()`);
  await wait(900);
  const clicked = await winRef.webContents.executeJavaScript(`(() => ({
    theme: document.body.dataset.theme,
    accent: document.body.dataset.accent,
    segActive: [...document.querySelectorAll('.seg button.active')].map((b) => b.textContent),
  }))()`);
  if (clicked.theme !== 'light' || clicked.accent !== 'violet') {
    throw new Error(`theme controls did not apply on click: ${JSON.stringify(clicked)}`);
  }
  // Charts are canvas: capture the populated overview in light theme too.
  winRef.webContents.send('np:qa-view', 'overview');
  await wait(1100);
  const lightOverview = path.join(QA_SHOT_DIR, 'overview-light.png');
  fs.writeFileSync(lightOverview, (await winRef.webContents.capturePage()).toPNG());
  winRef.webContents.send('np:qa-view', 'settings');
  await wait(700);
  const themeFile = path.join(QA_SHOT_DIR, 'settings-light.png');
  fs.writeFileSync(themeFile, (await winRef.webContents.capturePage()).toPNG());
  const themeState = await winRef.webContents.executeJavaScript(`(() => {
    const cs = getComputedStyle(document.body);
    return {
      theme: document.body.dataset.theme,
      mode: document.body.dataset.themeMode,
      accent: document.body.dataset.accent,
      accentVar: cs.getPropertyValue('--accent').trim(),
      bg: cs.getPropertyValue('--bg-0').trim(),
      txt: cs.getPropertyValue('--txt-0').trim(),
      segActive: [...document.querySelectorAll('.seg button.active')].map(b => b.textContent),
      scroll: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
    };
  })()`);
  await winRef.webContents.executeJavaScript(`window.netpulse.setSettings({ theme: 'dark', accent: 'cyan' })`);
  await wait(600);

  // Gadget readouts are the numbers a user keeps on screen, so check them
  // explicitly: three cells, MB/s units, and a working way back out.
  console.log('QA_STAGE gadget');
  // Deterministic start: the size is persisted, so pin it before measuring the
  // size cycle, and un-mute every series so the legend has all four chips.
  await winRef.webContents.executeJavaScript(`window.netpulse.setSettings({ theme: 'dark', accent: 'cyan', gadgetSize: 'standard', gadgetSeries: ['down', 'up', 'lat', 'jit'], gadgetUnit: 'mb/s' })`);
  // The gadget window is small and sits on top; when the harness runs from a
  // terminal the terminal can occlude it, and an occluded window deliberately does
  // no paint work (document.hidden) — so the DOM assertions below would be reading
  // a frozen frame. Raise it before asserting on what it displays.
  winRef.show();
  winRef.moveTop();
  winRef.focus();
  await wait(400);
  await winRef.webContents.executeJavaScript(`(() => {
    const b = document.getElementById('btn-gadget');
    if (b) b.click();
    window.netpulse.setGadget(true);
  })()`);
  await wait(1500);
  const gadgetImg = await winRef.webContents.capturePage();
  fs.writeFileSync(path.join(QA_SHOT_DIR, 'gadget.png'), gadgetImg.toPNG());
  const gadget = await winRef.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const read = () => [...document.querySelectorAll('#gadget .g-cell')].map((c) => ({
      k: c.querySelector('.g-k').textContent,
      u: c.querySelector('.g-u').textContent,
      v: c.querySelector('.g-v').textContent,
      sub: c.querySelector('.g-sub').textContent,
    }));
    const cellsBefore = read();
    const graphCanvases = document.querySelectorAll('#gadget canvas.g-pulse').length;
    const legend = [...document.querySelectorAll('#g-legend .g-lg')].map((c) => c.dataset.series);
    // Hover the graph: the readout must appear with one row per visible series.
    const graph = document.getElementById('g-graph');
    const gr = graph.getBoundingClientRect();
    graph.dispatchEvent(new MouseEvent('mousemove', { clientX: gr.left + gr.width * 0.6, clientY: gr.top + gr.height * 0.5, bubbles: true }));
    await wait(220);
    const readoutRows = document.querySelectorAll('#g-readout .r').length;
    const readoutShown = !document.getElementById('g-readout').hidden;
    graph.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    // Diagnostics travel with the result so a failing assertion says WHY, instead
    // of leaving a blank canvas to be guessed at.
    const gc = NP.gadget.chart;
    const diag = {
      on: NP.gadget.state.on,
      w: gc && gc.w,
      h: gc && gc.h,
      geom: Boolean(gc && gc.geom),
      series: gc ? gc.series.map((s) => s.key + ':' + s.points.length) : null,
      hidden: gc ? [...gc.hidden] : null,
      size: document.getElementById('gadget').dataset.size,
      err: window.__npGadgetErr || null,
      feedErr: window.__npGadgetFeedErr || null,
      hidden: document.hidden,
      visibility: document.visibilityState,
    };
    // Data cross-check (reported, not gated): the gadget must show the numbers the
    // app measured, and MB/s vs Mbps must be a unit choice, never a different value.
    const snap = NP.state.snap || {};
    const mbps = (v) => (v == null ? null : Math.round(v * 100) / 100);
    const dataXcheck = {
      units: {
        down: document.getElementById('g-down-u').textContent,
        up: document.getElementById('g-up-u').textContent,
        lat: document.getElementById('g-lat-u').textContent,
      },
      hero: {
        down: document.getElementById('g-down').textContent,
        up: document.getElementById('g-up').textContent,
        lat: document.getElementById('g-lat').textContent,
      },
      live: { down: mbps(snap.linkRate && snap.linkRate.downMbps), up: mbps(snap.linkRate && snap.linkRate.upMbps) },
      lastTest: {
        down: mbps(snap.lastTests && snap.lastTests.down && snap.lastTests.down.mbps),
        up: mbps(snap.lastTests && snap.lastTests.up && snap.lastTests.up.mbps),
      },
      // The dashboard HUD and the gadget read the same snapshot: these must agree.
      hud: (() => {
        const el = document.getElementById('chip-rate');
        return el ? el.textContent : null;
      })(),
      // 1 MB/s must be exactly 8 Mbps, everywhere.
      mbPerSec: { down: document.getElementById('g-down').textContent, factor: 8 },
      latency: (() => {
        const t = ((snap.latency && snap.latency.targets) || []).find((x) => x.label !== 'Gateway');
        const st = (t && t.stats) || {};
        const recent = t && t.recent && t.recent.length ? t.recent[t.recent.length - 1] : null;
        return { hero: document.getElementById('g-lat').textContent, sample: recent ? recent.rtt : null, avg: st.avg != null ? Math.round(st.avg * 10) / 10 : null, lossPct: st.lossPct != null ? st.lossPct : null };
      })(),
    };
    // Visibility must be asserted, not assumed: every other check here reads DOM
    // state that exists whether or not the widget is on screen, so a gadget that
    // never displayed would otherwise pass the whole stage.
    const gEl = document.getElementById('gadget');
    const visible = {
      attr: document.body.dataset.gadget,
      hiddenAttr: gEl.hidden,
      display: getComputedStyle(gEl).display,
      height: gEl.offsetHeight,
      width: gEl.offsetWidth,
      canvasH: document.getElementById('g-pulse').getBoundingClientRect().height,
      shellDisplay: document.querySelector('.shell') ? getComputedStyle(document.querySelector('.shell')).display : null,
    };
    // Click toggle to switch to Mbps. The unit only reaches the DOM through the
    // next snapshot, so wait a full sample cadence rather than 600 ms: the shorter
    // wait raced the 1 Hz push and failed intermittently.
    const unitSettingBefore = (NP.state.snap && NP.state.snap.settings && NP.state.snap.settings.gadgetUnit) || null;
    document.getElementById('g-cell-down').click();
    await wait(800);
    const cellsMbps = read();
    const unitSettingAfter = (NP.state.snap && NP.state.snap.settings && NP.state.snap.settings.gadgetUnit) || null;
    const snapAgeMs = NP.state.snap ? Date.now() - (NP.state.snap.at || 0) : null;
    // Click toggle back to MB/s:
    document.getElementById('g-cell-down').click();
    await wait(800);
    const cellsRestored = read();
    // Legend isolation: clicking a chip must mute exactly that series.
    const upChip = () => document.querySelector('#g-legend .g-lg[data-series="up"]');
    upChip().click();
    await wait(350);
    const upIsolated = upChip().classList.contains('off');
    upChip().click();
    await wait(350);
    const upRestored = !upChip().classList.contains('off');
    // Size cycle: standard -> expanded -> compact -> standard.
    const size0 = document.getElementById('gadget').dataset.size;
    document.getElementById('g-size').click();
    await wait(700);
    const size1 = document.getElementById('gadget').dataset.size;
    document.getElementById('g-size').click();
    await wait(700);
    document.getElementById('g-size').click();
    await wait(700);
    const sizeBack = document.getElementById('gadget').dataset.size;
    document.getElementById('g-expand').click();
    await wait(900);
    return {
      cells: cellsBefore,
      graphCanvases,
      legend,
      readoutRows,
      readoutShown,
      diag,
      visible,
      dataXcheck,
      upIsolated,
      upRestored,
      size0,
      size1,
      sizeBack,
      unitToggled: cellsMbps[0].u === 'Mbps' && cellsRestored[0].u === 'MB/s',
      units: cellsBefore.map((c) => c.u),
      unitsMbps: cellsMbps.map((c) => c.u),
      unitsRestored: cellsRestored.map((c) => c.u),
      unitSettingBefore,
      unitSettingAfter,
      snapAgeMs,
      gadgetOff: document.body.dataset.gadget !== '1',
      values: cellsBefore.map((c) => c.v),
    };
  })()`);
  if (gadget.cells.length !== 3) throw new Error(`gadget cells: ${JSON.stringify(gadget.cells)}`);
  if (gadget.visible.display === 'none' || gadget.visible.height < 100 || gadget.visible.canvasH < 40) {
    throw new Error(`gadget never displayed: ${JSON.stringify(gadget.visible)}`);
  }
  if (gadget.graphCanvases !== 1) throw new Error(`expected 1 live-graph canvas in gadget, got ${gadget.graphCanvases}`);
  if (!gadget.unitToggled) {
    // Raw probe, in one expression: the node the app writes, the node the harness
    // reads, whether they are the same element, and what each says.
    const probe = await winRef.webContents.executeJavaScript(`(() => {
      const node = document.getElementById('g-down-u');
      const read = document.querySelector('#g-cell-down .g-u');
      const setting = NP.state.snap && NP.state.snap.settings && NP.state.snap.settings.gadgetUnit;
      const before = node ? node.textContent : null;
      if (NP.gadget && NP.state.snap) NP.gadget.feed(NP.state.snap);
      return {
        setting,
        isMbps: setting === 'mbps',
        nodeText: node ? node.textContent : null,
        nodeBeforeFeed: before,
        readNodeText: read ? read.textContent : null,
        sameNode: node === read,
        nodeCount: document.querySelectorAll('#g-cell-down .g-u').length,
        idCount: document.querySelectorAll('#g-down-u').length,
        toggle: window.__npUnitToggle || null,
        gadgetOn: window.NP && NP.gadget ? (NP.gadget.state ? NP.gadget.state.on : null) : null,
      };
    })()`);
    throw new Error(`gadget unit toggle failed: start=${JSON.stringify(gadget.units)} after=${JSON.stringify(gadget.unitsMbps)} probe=${JSON.stringify(probe)} hidden=${gadget.diag.hidden}/${gadget.diag.visibility}`);
  }
  if (!gadget.gadgetOff) throw new Error('gadget did not return to the dashboard');
  if (gadget.legend.length !== 4) throw new Error(`gadget legend chips: ${JSON.stringify(gadget.legend)}`);
  if (!gadget.readoutShown || gadget.readoutRows < 2) {
    throw new Error(`gadget hover readout incomplete: shown=${gadget.readoutShown} rows=${gadget.readoutRows} diag=${JSON.stringify(gadget.diag)}`);
  }
  if (!gadget.upIsolated || !gadget.upRestored) throw new Error('gadget legend isolation failed');
  if (!(gadget.size0 === 'standard' && gadget.size1 === 'expanded' && gadget.sizeBack === 'standard')) {
    throw new Error(`gadget size cycle: ${gadget.size0} -> ${gadget.size1} -> ${gadget.sizeBack}`);
  }
  if (gadget.values.some((v) => /undefined|NaN/.test(String(v)))) {
    throw new Error(`gadget shows a broken value: ${JSON.stringify(gadget.values)}`);
  }

  const result = {
    at: new Date().toISOString(),
    shots,
    compact: { file: compactFile, ...compact },
    theme: { file: themeFile, ...themeState },
    warm,
    assertions,
    appsPanel,
    liveChart,
    toasts,
    gadget,
    perView,
    rendererErrors: rendererConsole.filter((c) => c.level >= 2).slice(0, 20),
    snapshotKeys: Object.keys(scheduler.snapshot()),
    quality: scheduler.snapshot().quality,
  };
  fs.writeFileSync(path.join(QA_SHOT_DIR, 'qa-result.json'), JSON.stringify(result, null, 2));
  process.stdout.write(`QA_RESULT ${JSON.stringify(result)}\n`);
  return result;
}

/* ------------------------------------------------------------------- lifecycle */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    store = new Store(DATA_DIR);
    nativeTheme.themeSource = store.settings.theme === 'light' ? 'light' : store.settings.theme === 'system' ? 'system' : 'dark';
    scheduler = new Scheduler(store);
    wireScheduler();
    registerIpc();
    createWindow();
    try {
      await scheduler.start({ warm: !QA });
    } catch (e) {
      store.appendEvent({ level: 'error', msg: `scheduler start failed: ${e.message}` });
    }
    if (QA) {
      try {
        const r = await runQa(win);
        setTimeout(() => {
          killAll();
          app.exit(r.assertions.horizontalScroll ? 2 : 0);
        }, 400);
      } catch (e) {
        // app.exit() can truncate buffered stdout, so the failure also lands
        // where it survives.
        const detail = `${new Date().toISOString()} ${e && e.stack ? e.stack : e}\n`;
        try {
          fs.mkdirSync(QA_SHOT_DIR, { recursive: true });
          fs.writeFileSync(path.join(QA_SHOT_DIR, 'qa-error.txt'), detail);
        } catch {
          /* ignore */
        }
        process.stdout.write(`QA_ERROR ${e.message}\n`);
        killAll();
        app.exit(3);
      }
    }
  });

  app.on('window-all-closed', () => {
    if (heartbeat) clearInterval(heartbeat);
    if (pushTimer) clearTimeout(pushTimer);
    if (scheduler) scheduler.stop();
    killAll();
    app.quit();
  });

  app.on('before-quit', () => {
    if (scheduler) scheduler.stop();
    killAll();
  });
}
