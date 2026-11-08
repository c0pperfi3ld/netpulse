'use strict';
/**
 * Persistence: settings, per-sample JSONL history, event log, rotating storage.
 *
 * Deliberately file-based (no native modules). Samples are appended as one JSON
 * object per line so the history stays greppable and the app never has to load a
 * whole blob into memory. Daily files older than `historyKeepDays` are pruned.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_SETTINGS } = require('../shared/constants');

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.reportsDir = path.join(dataDir, 'reports');
    this.qaDir = path.join(dataDir, 'qa');
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.reportsDir, { recursive: true });
    this.settingsPath = path.join(this.dir, 'settings.json');
    this.eventsPath = path.join(this.dir, 'events.jsonl');
    this.settings = this.loadSettings();
    this.events = this.loadEvents(400);
    this.streams = {};
    // Writes are batched: a latency sample lands every second per target and a
    // synchronous append per sample blocks the same thread that parses ping
    // output. Lines accumulate here and hit the disk once per flush window.
    this._pending = new Map();
    this._flushTimer = null;
    this._writeChain = Promise.resolve();
  }

  loadSettings() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
      return { ...DEFAULT_SETTINGS, ...raw };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  saveSettings(patch = {}) {
    this.settings = { ...this.settings, ...patch };
    try {
      fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2));
    } catch (e) {
      this.events.push({ t: Date.now(), level: 'error', msg: `settings write failed: ${e.message}` });
    }
    return this.settings;
  }

  sampleFile() {
    return path.join(this.dir, `samples-${dayKey()}.jsonl`);
  }

  /** Queue a line for the next flush instead of hitting the disk inline. */
  _enqueue(file, line) {
    this._pending.set(file, (this._pending.get(file) || '') + line);
    if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => this.flush(), 750);
      if (this._flushTimer.unref) this._flushTimer.unref();
    }
  }

  /** Write everything queued so far. Non-blocking; serialised through a chain. */
  flush() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (!this._pending.size) return this._writeChain;
    const batch = this._pending;
    this._pending = new Map();
    this._writeChain = this._writeChain
      .then(() => Promise.all([...batch].map(([file, data]) => fs.promises.appendFile(file, data))))
      .catch(() => {});
    return this._writeChain;
  }

  /** Used by readers/report builders that must see every sample already taken. */
  flushSync() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (!this._pending.size) return;
    const batch = this._pending;
    this._pending = new Map();
    for (const [file, data] of batch) {
      try {
        fs.appendFileSync(file, data);
      } catch {
        /* history is best-effort; never break a measurement over it */
      }
    }
  }

  appendSample(kind, payload) {
    this._enqueue(this.sampleFile(), `${JSON.stringify({ t: Date.now(), kind, ...payload })}\n`);
  }

  appendEvent(ev) {
    const rec = { t: Date.now(), ...ev };
    this.events.push(rec);
    if (this.events.length > 400) this.events = this.events.slice(-400);
    this._enqueue(this.eventsPath, `${JSON.stringify(rec)}\n`);
    return rec;
  }

  loadEvents(limit) {
    try {
      const lines = fs.readFileSync(this.eventsPath, 'utf8').trim().split(/\r?\n/);
      return lines.slice(-limit).map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Read back today's (and optionally yesterday's) samples for report generation. */
  readSamples({ days = 1, kind = null, limit = 20000 } = {}) {
    this.flushSync();
    const out = [];
    for (let i = 0; i < days; i += 1) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const file = path.join(this.dir, `samples-${dayKey(d)}.jsonl`);
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
      for (const l of lines) {
        if (!l) continue;
        try {
          const rec = JSON.parse(l);
          if (!kind || rec.kind === kind) out.push(rec);
        } catch {
          /* skip malformed line */
        }
      }
    }
    return out.slice(-limit);
  }

  /** Delete JSONL files older than the retention window. */
  prune(retainDays = this.settings.historyKeepDays || 14) {
    this.flushSync();
    let removed = 0;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retainDays);
    try {
      for (const f of fs.readdirSync(this.dir)) {
        const m = /^samples-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
        if (!m) continue;
        if (new Date(`${m[1]}T00:00:00Z`) < cutoff) {
          fs.unlinkSync(path.join(this.dir, f));
          removed += 1;
        }
      }
    } catch {
      /* ignore */
    }
    return removed;
  }

  writeReport(name, markdown) {
    const file = path.join(this.reportsDir, name);
    fs.writeFileSync(file, markdown);
    return file;
  }

  stats() {
    let bytes = 0;
    let files = 0;
    try {
      for (const f of fs.readdirSync(this.dir)) {
        const st = fs.statSync(path.join(this.dir, f));
        if (st.isFile()) {
          bytes += st.size;
          files += 1;
        }
      }
    } catch {
      /* ignore */
    }
    return { dir: this.dir, files, bytes, reportsDir: this.reportsDir };
  }
}

module.exports = { Store, dayKey };
