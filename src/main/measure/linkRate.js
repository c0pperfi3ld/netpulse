'use strict';
/**
 * Link rate for the whole machine.
 *
 * Two Windows sources exist and they do NOT agree:
 *
 *  1. `netstat -e` — the IP stack's cumulative byte counter. Cheap, but on a
 *     machine with a local proxy, tunnelling or virtual switches it counts the
 *     same payload more than once. Measured here at ~300 Mbps while a transfer
 *     was actually running at ~51 Mbps: a 5x over-report, which is exactly what
 *     makes a monitor look like it is lying.
 *
 *  2. PDH `\Network Interface(*)\Bytes Received/sec` — the per-adapter counters
 *     Task Manager uses. Summing the physical adapters tracked that same
 *     transfer at 55-68 Mbps against a measured 50.7 Mbps.
 *
 * So the adapter counters are the primary source; netstat is only a fallback
 * while PDH has produced nothing at all. A persistent `typeperf` process
 * streams one CSV row per second. No native modules, no admin rights.
 */
const { run, streamLines } = require('../util/proc');

const COUNTERS = ['\\Network Interface(*)\\Bytes Received/sec', '\\Network Interface(*)\\Bytes Sent/sec'];
const RE_COLUMN = /Interface\((.*?)\)\\Bytes (Received|Sent)\/sec\s*$/i;

/* Loopback, tunnels and virtual switches either invent traffic or count the
   same bytes twice; the physical adapter is what reaches the internet. */
const VIRTUAL = /loopback|isatap|teredo|vethernet|hyper-v|virtual|vpn|tap|wintun|bluetooth|pseudo|6to4|tunneling/i;

const RE_BYTES = /^\s*Bytes\s+(\d+)\s+(\d+)/im;

/** Parse `netstat -e` into cumulative {rx, tx} byte counters, or null. */
function parseNetstatE(stdout) {
  const m = RE_BYTES.exec(stdout || '');
  if (!m) return null;
  return { rx: Number(m[1]), tx: Number(m[2]) };
}

async function sampleLinkBytes() {
  try {
    const { stdout } = await run('netstat', ['-e'], { timeoutMs: 4000 });
    return parseNetstatE(stdout);
  } catch {
    return null;
  }
}

/** CSV row -> cells. typeperf quotes every field. */
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

/** Header row -> [{adapter, dir}] in column order. */
function parseAdapterHeader(line) {
  const cells = splitCsv(line);
  const cols = [];
  for (let i = 1; i < cells.length; i += 1) {
    const m = RE_COLUMN.exec(cells[i]);
    cols.push(m ? { adapter: m[1], dir: m[2].toLowerCase() } : null);
  }
  return cols;
}

/**
 * One CSV row -> Mbps. Physical adapters are summed; if none is recognised the
 * full set is summed, because reporting 0 would be a worse failure than an
 * imprecise number.
 */
function ratesFromSample(line, cols, preferredAdapter = null) {
  const cells = splitCsv(line);
  const all = [];
  for (let i = 1; i < cells.length && i <= cols.length; i += 1) {
    const col = cols[i - 1];
    if (!col) continue;
    const v = Number(cells[i]);
    if (!Number.isFinite(v) || v < 0) continue;
    all.push({ adapter: col.adapter, dir: col.dir, mbps: (v * 8) / 1e6 });
  }

  // Precision adapter matching: If an active default interface description is
  // known (e.g. 'Realtek PCIe GbE Family Controller'), match directly against it.
  // This completely eliminates ghost throughput spikes from inactive Wi-Fi/Ethernet adapters.
  if (preferredAdapter) {
    const prefClean = String(preferredAdapter).toLowerCase().replace(/[^a-z0-9]/g, '');
    const matched = all.filter((r) => {
      const adClean = r.adapter.toLowerCase().replace(/[^a-z0-9]/g, '');
      return adClean.includes(prefClean) || prefClean.includes(adClean);
    });
    if (matched.length) {
      const sum = (dir) => matched.filter((r) => r.dir === dir).reduce((acc, r) => acc + r.mbps, 0);
      return { downMbps: sum('received'), upMbps: sum('sent'), adapters: matched, physicalCount: matched.length, matchedPrimary: true };
    }
  }

  const physical = all.filter((r) => !VIRTUAL.test(r.adapter));
  const use = physical.length ? physical : all;
  const sum = (dir) => use.filter((r) => r.dir === dir).reduce((acc, r) => acc + r.mbps, 0);
  return { downMbps: sum('received'), upMbps: sum('sent'), adapters: use, physicalCount: physical.length, matchedPrimary: false };
}

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * Streams the adapter counters and reports a short average, so a bursty
 * transfer still reads as a steady speed and one bad sample cannot spike it.
 * onRate({ at, downMbps, upMbps, windowMs, source, peakDownMbps, peakUpMbps })
 */
function createLinkRateSampler({ samples = 3, onRate, fallbackIntervalMs = 1000, getPreferredAdapter = null } = {}) {
  const window = []; // { at, downMbps, upMbps }
  let cols = null;
  let stopped = false;
  let peakDown = 0;
  let peakUp = 0;
  let emitted = 0;
  let pdhWorking = false;
  let fbPrev = null;

  const emit = (down, up, source, spanMs, primaryMatched = false) => {
    const d = round1(Math.max(0, down));
    const u = round1(Math.max(0, up));
    peakDown = Math.max(peakDown, d);
    peakUp = Math.max(peakUp, u);
    emitted += 1;
    if (onRate) {
      onRate({ at: Date.now(), downMbps: d, upMbps: u, windowMs: spanMs, source, peakDownMbps: peakDown, peakUpMbps: peakUp, primaryMatched });
    }
  };

  const feed = (downMbps, upMbps, source, primaryMatched = false) => {
    const at = Date.now();
    window.push({ at, downMbps, upMbps });
    while (window.length > samples) window.shift();
    const spanMs = at - window[0].at;
    const avg = (key) => window.reduce((acc, s) => acc + s[key], 0) / window.length;
    emit(avg('downMbps'), avg('upMbps'), source, Math.max(1000, spanMs), primaryMatched);
  };

  const child = streamLines('typeperf', [...COUNTERS, '-si', '1'], {
    stderr: false,
    onLine: (line) => {
      if (!line.startsWith('"')) return;
      if (line.startsWith('"(PDH-CSV')) {
        cols = parseAdapterHeader(line);
        return;
      }
      if (!cols) return;
      const pref = typeof getPreferredAdapter === 'function' ? getPreferredAdapter() : getPreferredAdapter;
      const r = ratesFromSample(line, cols, pref);
      if (!r.adapters.length) return;
      pdhWorking = true;
      feed(r.downMbps, r.upMbps, 'adapter', r.matchedPrimary);
    },
  });

  // Fallback only while PDH has produced nothing: netstat can over-report, but
  // "roughly right" beats "nothing at all" on a machine without PDH counters.
  // It is held back for a moment so the inflated netstat value cannot flash on
  // screen before the adapter counters have had their first sample.
  let fallbackArmed = false;
  const armTimer = setTimeout(() => {
    fallbackArmed = true;
  }, 3000);
  const fbTimer = setInterval(async () => {
    if (stopped || pdhWorking || !fallbackArmed) return;
    const raw = await sampleLinkBytes();
    if (!raw) return;
    const prev = fbPrev;
    fbPrev = { at: Date.now(), rx: raw.rx, tx: raw.tx };
    if (!prev) return;
    const dt = (Date.now() - prev.at) / 1000;
    if (dt <= 0) return;
    feed(((raw.rx - prev.rx) * 8) / dt / 1e6, ((raw.tx - prev.tx) * 8) / dt / 1e6, 'netstat');
  }, fallbackIntervalMs);

  return {
    get source() {
      return pdhWorking ? 'adapter' : 'netstat';
    },
    get emitted() {
      return emitted;
    },
    stop() {
      stopped = true;
      clearTimeout(armTimer);
      clearInterval(fbTimer);
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

module.exports = {
  createLinkRateSampler,
  parseNetstatE,
  sampleLinkBytes,
  parseAdapterHeader,
  ratesFromSample,
  splitCsv,
};
