'use strict';
/**
 * Per-process bandwidth ranking.
 *
 * Windows exposes no per-application *network* byte counter without a kernel
 * driver or admin-level ETW session. What it does expose, to any user, is the
 * PDH per-process I/O counters. Those include disk traffic, so this is a
 * ranking of "what is moving data right now", which is the useful signal when
 * the link is saturated: the process at the top is almost always the downloader.
 *
 * `typeperf` is used instead of PowerShell: it is a small native tool that
 * streams one CSV row per interval from a single long-lived process (~2 % of
 * one core), where a Get-Counter or CIM query costs 1-10 s per sample.
 *
 * Counter names are the English PDH paths; on a localized Windows the spawn
 * fails and the caller shows "unavailable" rather than a wrong number.
 */
const { run, streamLines } = require('../util/proc');

const COUNTERS = ['\\Process(*)\\IO Read Bytes/sec', '\\Process(*)\\IO Write Bytes/sec'];
const RE_COLUMN = /Process\((.*?)\)\\IO (Read|Write) Bytes\/sec\s*$/i;
/* NetPulse itself is excluded: its own speed tests are the app measuring the
   link, not an application consuming it. Hiding it also stops the panel from
   blaming the monitor for the traffic its probes generated. */
const HIDE = /^(_total|idle|memory compression|electron)$/i;
const label = (name) => name;

/** CSV row -> cells. typeperf quotes every field and escapes "" inside quotes. */
function splitCsv(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Header row -> [{instance, kind}] in column order. */
function parseHeader(line) {
  const cells = splitCsv(line);
  const cols = [];
  for (let i = 1; i < cells.length; i += 1) {
    const m = RE_COLUMN.exec(cells[i]);
    cols.push(m ? { name: m[1], kind: m[2].toLowerCase() } : null);
  }
  return cols;
}

/**
 * Aggregate one data row into per-app Mbps. Duplicate instances of the same
 * image (`chrome#1`, `chrome#2`, ...) are one app, not five.
 */
function rowsFromSample(line, cols, limit = 8) {
  const cells = splitCsv(line);
  const bytes = new Map();
  for (let i = 1; i < cells.length && i <= cols.length; i += 1) {
    const col = cols[i - 1];
    if (!col) continue;
    const v = Number(cells[i]);
    if (!Number.isFinite(v) || v <= 0) continue;
    const key = col.name.replace(/#\d+$/, '');
    bytes.set(key, (bytes.get(key) || 0) + v);
  }
  const rows = [];
  for (const [name, bps] of bytes) {
    if (HIDE.test(name)) continue;
    // Megabytes per second, because that is the unit the panel reports and the
    // unit people compare against a file or a download dialog.
    const mbs = Math.round((bps / 1e6) * 100) / 100;
    if (mbs <= 0) continue;
    rows.push({ name: label(name), mbs, bytesPerSec: Math.round(bps) });
  }
  // Ranked by the number that is displayed, so the order can never disagree
  // with the values on screen.
  rows.sort((a, b) => b.mbs - a.mbs || a.name.localeCompare(b.name));
  return rows.slice(0, limit);
}

/**
 * Names of processes that currently hold a live network socket (TCP or UDP)
 * to a non-loopback destination.
 *
 * Per-process I/O counters count registry and file traffic too, which is why an
 * unfiltered ranking is topped by Registry / RuntimeBroker / WmiPrvSE instead of
 * the browser pulling the file.
 *
 * Excludes local loopback sockets (127.0.0.1 / [::1]) so internal IPC does not
 * falsely mark a local background service as an active network consumer.
 */
async function networkOwners() {
  const [tasks, conns] = await Promise.all([
    run('tasklist', ['/fo', 'csv', '/nh'], { timeoutMs: 6000 }),
    run('netstat', ['-ano'], { timeoutMs: 6000 }),
  ]);
  const pidToName = new Map();
  for (const line of (tasks.stdout || '').split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (m) pidToName.set(m[2], m[1].replace(/\.exe$/i, ''));
  }
  const names = new Set();
  for (const line of (conns.stdout || '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const proto = parts[0].toUpperCase();
    const remote = parts[2];
    const state = proto === 'TCP' ? parts[3] : '';
    const pid = parts[parts.length - 1];
    const name = pidToName.get(pid);
    if (!name) continue;

    // Reject internal loopback & listening bindings
    const isLoopback = remote.startsWith('127.') || remote.startsWith('[::1]') || remote.startsWith('0.0.0.0') || remote.startsWith('*');
    if (!isLoopback && (state === 'ESTABLISHED' || state === 'SYN_SENT' || proto === 'UDP')) {
      names.add(name.toLowerCase());
    }
  }
  return names;
}

/**
 * Start sampling. onSample({ at, rows: [{name, mbs, bytesPerSec}], totalMbs }).
 * Returns { stop() }.
 */
function startTopAppsSampler({ intervalSec = 2, onSample, connTtlMs = 5000 } = {}) {
  let cols = null;
  let errored = false;
  let owners = null; // Set of names with a live connection, null until first read
  let ownersAt = 0;
  let ownersBusy = false;

  const refreshOwners = () => {
    if (ownersBusy) return;
    ownersBusy = true;
    networkOwners()
      .then((set) => {
        owners = set;
        ownersAt = Date.now();
      })
      .catch(() => {})
      .finally(() => {
        ownersBusy = false;
      });
  };
  refreshOwners();

  const child = streamLines('typeperf', [...COUNTERS, '-si', String(intervalSec)], {
    stderr: false,
    onLine: (line) => {
      if (!line.startsWith('"')) return;
      if (line.startsWith('"(PDH-CSV')) {
        cols = parseHeader(line);
        return;
      }
      if (!cols) return;
      if (Date.now() - ownersAt > connTtlMs) refreshOwners();
      let rows = rowsFromSample(line, cols);
      // Until the first owner list lands, show the raw ranking rather than an
      // empty panel; afterwards only socket-holding processes qualify.
      if (owners) rows = rows.filter((r) => owners.has(r.name.toLowerCase()));
      const totalMbs = Math.round(rows.reduce((a, r) => a + r.mbs, 0) * 10) / 10;
      if (onSample) onSample({ at: Date.now(), rows, totalMbs });
    },
    onExit: (code) => {
      if (code !== 0 && !errored) {
        errored = true;
        if (onSample) onSample({ at: Date.now(), rows: [], totalMbs: 0, error: 'process counters unavailable' });
      }
    },
  });

  return {
    stop() {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

module.exports = { startTopAppsSampler, parseHeader, rowsFromSample, splitCsv, networkOwners, COUNTERS };