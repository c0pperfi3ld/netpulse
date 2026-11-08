'use strict';
/**
 * Path-MTU discovery + adapter MTU audit.
 *
 * The failure this catches: adapter says 1500, the path only carries 1480, and
 * oversized packets with DF set vanish without an ICMP "fragmentation needed".
 * That is a PMTUD black hole - TCP usually limps along, large UDP breaks.
 *
 * Strategy: binary-search the largest payload that survives a DF ping. If a
 * larger probe produced an explicit frag-needed response, PMTUD works and the
 * mismatch is benign; if it produced silence, it is a black hole.
 */
const { run } = require('../util/proc');
const { pingOnce } = require('./ping');

async function works(host, payload, probes, timeoutMs) {
  const r = await pingOnce(host, { count: probes, timeoutMs, payload, df: true });
  return { ok: r.recv > 0, result: r };
}

/** Largest payload (bytes) that survives with DF set. */
async function discoverPathMtu({ host = '1.1.1.1', lo = 1200, hi = 1472, probes = 2, timeoutMs = 1500 } = {}) {
  const step = (msg) => ({ msg });
  const ladder = [];
  // Known-good floor first: if even `lo` fails, the path is unusually tight.
  const floor = await works(host, lo, probes, timeoutMs);
  ladder.push({ payload: lo, total: lo + 28, ok: floor.ok, frag: floor.result.frag });
  if (!floor.ok) {
    return {
      host,
      payloadMax: null,
      pathMtu: null,
      ladder,
      fragSignalled: false,
      note: `even ${lo}-byte payloads with DF fail - path MTU is below ${lo + 28}`,
    };
  }
  let best = lo;
  let low = lo;
  let high = hi;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    // eslint-disable-next-line no-await-in-loop
    const r = await works(host, mid, probes, timeoutMs);
    ladder.push({ payload: mid, total: mid + 28, ok: r.ok, frag: r.result.frag });
    if (r.ok) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
      if (r.result.frag) step('icmp-frag-needed');
    }
  }
  const fragSignalled = ladder.some((l) => l.frag);
  return {
    host,
    payloadMax: best,
    pathMtu: best + 28,
    ladder: ladder.sort((a, b) => a.payload - b.payload),
    fragSignalled,
    note: fragSignalled
      ? 'router returns ICMP frag-needed, so PMTUD adapts on its own'
      : 'oversized packets are dropped silently - PMTUD black hole',
  };
}

function parseNetshSubinterfaces(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+\d+\s+\d+\s+\d+\s+(.+?)\s*$/.exec(line);
    if (m) rows.push({ mtu: Number(m[1]), interface: m[2].trim() });
  }
  return rows;
}

async function adapterMtu(ifaceName) {
  const { stdout } = await run('netsh', ['interface', 'ipv4', 'show', 'subinterfaces'], { timeoutMs: 8000 });
  const rows = parseNetshSubinterfaces(stdout);
  const hit = rows.find((r) => r.interface.toLowerCase() === String(ifaceName).toLowerCase());
  return { rows, mtu: hit ? hit.mtu : null, interface: ifaceName };
}

/** MTU values written into the registry (= persistent across reboots). */
async function persistentMtu() {
  const { stdout } = await run(
    'reg',
    ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces', '/s', '/v', 'MTU'],
    { timeoutMs: 10_000 }
  );
  const rows = [];
  let currentKey = null;
  for (const line of String(stdout).split(/\r?\n/)) {
    const k = /^(HKEY_[^\r\n]+)/.exec(line.trim());
    if (k) currentKey = k[1];
    const v = /MTU\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(line);
    if (v) rows.push({ key: currentKey, mtu: parseInt(v[1], 16) });
  }
  return rows;
}

async function mtuReport({ host = '1.1.1.1', ifaceName, lo = 1200, hi = 1472, probes = 2 } = {}) {
  const [path, adapter, persistent] = await Promise.all([
    discoverPathMtu({ host, lo, hi, probes }),
    ifaceName ? adapterMtu(ifaceName) : Promise.resolve({ rows: [], mtu: null, interface: null }),
    persistentMtu(),
  ]);
  const live = adapter.mtu;
  let verdict = 'unknown';
  let advice = 'could not read the adapter MTU';
  if (path.pathMtu != null && live != null) {
    if (live <= path.pathMtu) {
      verdict = 'ok';
      advice = `adapter MTU ${live} fits inside the ${path.pathMtu}-byte path - nothing to fix`;
    } else if (path.fragSignalled) {
      verdict = 'mismatch-benign';
      advice = `adapter ${live} > path ${path.pathMtu}, but the router signals fragmentation, so TCP adapts. Set ${path.pathMtu} anyway for large UDP.`;
    } else {
      verdict = 'blackhole';
      advice = `adapter ${live} > path ${path.pathMtu} and oversized packets are dropped silently. Set the adapter MTU to ${path.pathMtu}.`;
    }
  }
  const iface = adapter.interface || ifaceName || '"Ethernet"';
  return {
    host,
    iface,
    liveMtu: live,
    persistentMtu: persistent,
    persistentMatchesLive: persistent.some((p) => p.mtu === live),
    pathMtu: path.pathMtu,
    payloadMax: path.payloadMax,
    ladder: path.ladder,
    fragSignalled: path.fragSignalled,
    verdict,
    advice,
    fixCommand:
      verdict === 'blackhole' || verdict === 'mismatch-benign'
        ? `netsh interface ipv4 set subinterface "${iface}" mtu=${path.pathMtu} store=persistent`
        : null,
    revertCommand:
      verdict === 'blackhole' || verdict === 'mismatch-benign'
        ? `netsh interface ipv4 set subinterface "${iface}" mtu=1500 store=persistent`
        : null,
    note: path.note,
  };
}

module.exports = {
  discoverPathMtu,
  mtuReport,
  adapterMtu,
  persistentMtu,
  parseNetshSubinterfaces,
};
