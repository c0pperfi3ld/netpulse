#!/usr/bin/env node
'use strict';
/**
 * Keeps the local Electron install working when the package-manager download
 * hook is skipped or blocked (devDependency omitted, offline, OneDrive-induced
 * timeout). Uses the Electron cache in %LOCALAPPDATA% if a zip is already there,
 * otherwise tells you the one command that fixes it.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const PKG = path.join(ROOT, 'node_modules', 'electron', 'path.txt');

// electron/index.js resolves the binary as path.join(__dirname, 'dist', path.txt).
// So path.txt must hold the name of the exe relative to dist/ ("electron.exe"),
// NOT "dist/electron.exe" -- the latter yields dist/dist/electron.exe and ENOENT.
const EXE = process.platform === 'win32' ? 'electron.exe' : 'electron';

function log(m) {
  process.stdout.write(`${m}\n`);
}

/**
 * Writes the exe name into path.txt in the form electron's loader expects.
 * Normalises values written by earlier versions of this script ("dist/electron.exe")
 * and by the package installer itself.
 */
function writePathTxt(pkgDir) {
  try {
    fs.writeFileSync(path.join(pkgDir || path.join(ROOT, 'node_modules', 'electron'), 'path.txt'), EXE);
    return true;
  } catch {
    return false;
  }
}

function electronVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).devDependencies.electron.replace(/[^\d.]/g, '');
  } catch {
    return '31.7.7';
  }
}

function cacheZips() {
  const dirs = [
    path.join(os.homedir(), 'AppData', 'Local', 'electron', 'Cache'),
    path.join(os.homedir(), '.cache', 'electron'),
    path.join(os.homedir(), 'Library', 'Caches', 'electron'),
  ];
  const out = [];
  for (const d of dirs) {
    try {
      for (const f of fs.readdirSync(d)) if (/^electron-v[\d.]+-.*\.zip$/.test(f)) out.push(path.join(d, f));
    } catch {
      /* not present */
    }
  }
  return out;
}

// Repair path.txt even when dist/ is already present: a stale/corrupt value there
// makes `electron .` spawn dist/dist/electron.exe and die with ENOENT.
let pathTxt = '';
try {
  pathTxt = fs.readFileSync(PKG, 'utf8').trim();
} catch {
  /* missing */
}
if (pathTxt !== EXE) {
  if (writePathTxt()) log(`repaired electron path.txt: "${pathTxt || '(missing)'}" -> "${EXE}"`);
}

if (fs.existsSync(path.join(DIST, EXE))) {
  log(`electron dist present: ${path.join(DIST, EXE)}`);
  process.exit(0);
}

const wanted = electronVersion();
const zips = cacheZips();
const match = zips.find((z) => z.includes(`electron-v${wanted}`)) || zips[0];

if (match) {
  log(`extracting cached build: ${match}`);
  fs.mkdirSync(DIST, { recursive: true });
  try {
    if (process.platform === 'win32') {
      execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${match}' -DestinationPath '${DIST}' -Force`], { stdio: 'inherit' });
    } else {
      execFileSync('unzip', ['-o', '-q', match, '-d', DIST], { stdio: 'inherit' });
    }
    if (fs.existsSync(DIST)) writePathTxt();
    log('electron restored from cache');
    process.exit(0);
  } catch (e) {
    log(`extract failed: ${e.message}`);
  }
}

log('no usable electron dist and no cached zip found. Run one of:');
log('  npm install --include=dev --foreground-scripts');
log('  npm config get omit      # must NOT list dev');
process.exit(1);
