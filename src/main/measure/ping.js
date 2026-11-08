'use strict';
/**
 * Latency / jitter / loss measurement.
 *
 * Live series uses one long-lived `ping -t` per target, parsed incrementally.
 * Point-in-time probes use a bounded `ping -n`. The count/timeout/payload/DF
 * spellings differ between Windows and POSIX and are shimmed in util/proc.
 */
const { run, streamLines, pingArgs } = require('../util/proc');

const RE_REPLY = /Reply from .*?:\s*bytes[=\s]*(\d+)\s*time([=<])\s*([\d.]+)\s*ms\s*TTL=(\d+)/i;
const RE_REPLY_POSIX = /bytes from .*?:\s*icmp_seq[=\s]*(\d+).*?ttl[=\\s]*(\\d+).*?time[=<]\s*([\d.]+)\s*ms/i;
const RE_TIMEOUT = /Request timed out|timed out/i;
const RE_UNREACH = /Destination (host|net) unreachable|General failure|host unreachable/i;
const RE_FRAG = /Packet needs to be fragmented|Fragmentation needed|message too long/i;
const RE_SUMMARY_AVG = /Average\s*=\s*(\d+)ms/i;

/** Parse one ping stdout line into a sample or null. */
function parsePingLine(line, now = Date.now()) {
  let m = RE_REPLY.exec(line);
  if (m) {
    const isLessThan = m[2] === '<';
    const rawVal = Number(m[3]);
    // Windows 'time<1ms' is sub-millisecond; returning 0.5 ms prevents local/gateway RTT
    // from falsely reading as a full 1 ms integer floor.
    const rtt = isLessThan ? Math.max(0.2, Math.min(0.8, rawVal * 0.5)) : rawVal;
    return { t: now, rtt, ttl: Number(m[4]), status: 'ok', subMs: isLessThan };
  }
  m = RE_REPLY_POSIX.exec(line);
  if (m) {
    const rtt = Number(m[3]);
    return { t: now, rtt, ttl: Number(m[2]), status: 'ok' };
  }
  if (RE_FRAG.test(line)) return { t: now, rtt: null, status: 'frag', line };
  if (RE_TIMEOUT.test(line)) return { t: now, rtt: null, status: 'timeout', line };
  if (RE_UNREACH.test(line)) return { t: now, rtt: null, status: 'unreachable', line };
  return null;
}

/**
 * Continuous latency sampler for one host.
 * Returns { pid, kill() }. Samples are pushed via onSample({t, rtt, status}).
 */
function startLatencyStream(host, { timeoutMs = 1500 } = {}, onSample, onExit) {
  const args = pingArgs({ host, continuous: true, timeoutMs });
  let dead = false;
  // Watchdog: Windows ping -t prints nothing for a down host, which is
  // indistinguishable from a buffered pipe. If we see no line at all within
  // 4s, emit a synthetic timeout so the UI still shows loss.
  let sawLine = false;
  const watchdog = setInterval(() => {
    if (sawLine || dead) return;
    onSample && onSample({ t: Date.now(), rtt: null, status: 'timeout', synthetic: true });
  }, 2000);
  if (watchdog.unref) watchdog.unref();

  const proc = streamLines('ping', args, {
    onLine: (line) => {
      const s = parsePingLine(line);
      if (!s) return;
      sawLine = true;
      onSample && onSample(s);
    },
    onExit: (code, err) => {
      dead = true;
      clearInterval(watchdog);
      onExit && onExit(code, err);
    },
  });

  return {
    pid: proc.pid,
    kill() {
      dead = true;
      clearInterval(watchdog);
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Bounded point probe. `payload` + `df` are used by the MTU ladder.
 * Returns { sent, recv, lossPct, min, avg, max, rtts, mtuSignal, raw }
 */
async function pingOnce(host, { count = 4, timeoutMs = 1500, payload = 32, df = false } = {}) {
  const args = pingArgs({ host, count, timeoutMs, payload, df });
  const started = Date.now();
  const { stdout, stderr, code } = await run('ping', args, { timeoutMs: count * timeoutMs + 8000 });
  const text = `${stdout}\n${stderr}`;
  const rtts = [];
  let timeouts = 0;
  let unreachable = 0;
  let frag = false;
  for (const line of text.split(/\r?\n/)) {
    const s = parsePingLine(line);
    if (!s) continue;
    if (s.status === 'ok') rtts.push(s.rtt);
    else if (s.status === 'timeout') timeouts += 1;
    else if (s.status === 'unreachable') unreachable += 1;
    else if (s.status === 'frag') frag = true;
  }
  // POSIX ships the final count in the summary; trust parsed replies when present.
  const summary = /Received = (\d+)/i.exec(text) || /(\d+) received/i.exec(text);
  const recv = rtts.length || (summary ? Number(summary[1]) : 0);
  const sentMatch = /Sent = (\d+)/i.exec(text) || /(\d+) packets transmitted/i.exec(text);
  const sent = sentMatch ? Number(sentMatch[1]) : count;
  const avgMatch = RE_SUMMARY_AVG.exec(text) || /avg[=/]([\d.]+)/i.exec(text);
  const sorted = [...rtts].sort((a, b) => a - b);
  return {
    host,
    payload,
    df,
    sent,
    recv,
    lossPct: sent ? Math.round(((sent - recv) / sent) * 1000) / 10 : 0,
    min: sorted.length ? sorted[0] : null,
    avg: rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null,
    max: sorted.length ? sorted[sorted.length - 1] : null,
    p50: percentile(rtts, 50),
    p95: percentile(rtts, 95),
    rtts,
    timeouts,
    unreachable,
    frag,
    summaryAvg: avgMatch ? Number(avgMatch[1]) : null,
    elapsedMs: Date.now() - started,
    exitCode: code,
    raw: text.trim().slice(0, 2000),
  };
}

function percentile(values, p) {
  const arr = values.filter((v) => typeof v === 'number' && !Number.isNaN(v)).sort((a, b) => a - b);
  if (!arr.length) return null;
  const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil((p / 100) * arr.length) - 1));
  return arr[idx];
}

/** RFC3550-style instantaneous jitter plus spread stats over an RTT series. */
function jitterStats(rtts) {
  const clean = rtts.filter((v) => typeof v === 'number' && !Number.isNaN(v));
  if (clean.length < 2) return { meanDelta: 0, rfc3550: 0, stddev: 0, samples: clean.length };
  let sumDelta = 0;
  let jitter = 0;
  for (let i = 1; i < clean.length; i += 1) {
    const d = Math.abs(clean[i] - clean[i - 1]);
    sumDelta += d;
    jitter += (d - jitter) / 16;
  }
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const variance = clean.reduce((a, b) => a + (b - mean) ** 2, 0) / clean.length;
  return {
    meanDelta: Math.round((sumDelta / (clean.length - 1)) * 100) / 100,
    rfc3550: Math.round(jitter * 100) / 100,
    stddev: Math.round(Math.sqrt(variance) * 100) / 100,
    samples: clean.length,
  };
}

/** Roll a sample array into the numbers the UI shows for a target. */
function rollup(samples) {
  const rtts = samples.map((s) => s.rtt).filter((v) => typeof v === 'number');
  const lost = samples.filter((s) => s.status !== 'ok').length;
  return {
    count: samples.length,
    recv: rtts.length,
    lost,
    lossPct: samples.length ? Math.round((lost / samples.length) * 1000) / 10 : 0,
    min: rtts.length ? Math.min(...rtts) : null,
    max: rtts.length ? Math.max(...rtts) : null,
    avg: rtts.length ? Math.round((rtts.reduce((a, b) => a + b, 0) / rtts.length) * 100) / 100 : null,
    p50: percentile(rtts, 50),
    p95: percentile(rtts, 95),
    p99: percentile(rtts, 99),
    jitter: jitterStats(rtts),
  };
}

module.exports = { startLatencyStream, pingOnce, parsePingLine, jitterStats, percentile, rollup };
