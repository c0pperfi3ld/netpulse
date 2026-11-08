'use strict';
/**
 * Throughput measurement (download + upload) with the methodology that made the
 * CLI audit correct:
 *
 *   effective rate = bytes / (time_total - time_starttransfer)
 *
 * time_total includes DNS + TCP + TLS setup, which on a short transfer is most
 * of the wall clock and understates the link badly. Parallel streams measure the
 * aggregate ceiling, which is what exposes an ISP policer (a cap that does not
 * move when you add connections).
 */
const { run, resolveCurl, SINK, payloadPath, mbps } = require('../util/proc');
const { ENDPOINTS } = require('../../shared/constants');

const W_FORMAT = '%{http_code} %{size_download} %{time_starttransfer} %{time_total} %{speed_download}';

function parseCurlW(stdout) {
  const parts = String(stdout).trim().split(/\s+/).map(Number);
  const [code, size, ttfb, total, speed] = parts;
  return {
    httpCode: Number.isFinite(code) ? code : 0,
    size: Number.isFinite(size) ? size : 0,
    ttfb: Number.isFinite(ttfb) ? ttfb : 0,
    total: Number.isFinite(total) ? total : 0,
    speedField: Number.isFinite(speed) ? speed : 0,
  };
}

function effectiveMbps(size, ttfb, total) {
  const transfer = Math.max(0.001, total - ttfb);
  return mbps(size, transfer);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Cloudflare rate-limits bursts with HTTP 429. A 429 is not "0 Mbps" - it is
 * "ask again shortly", so surface it distinctly and retry once with backoff
 * instead of reporting a fake zero.
 */
function detectRateLimit(res) {
  const codes = res.map((r) => r.httpCode);
  return codes.includes(429) || codes.includes(403);
}

function summarize(res, bytesPerStream, streams, wallSec) {
  const ok = res.filter((r) => r.httpCode >= 200 && r.httpCode < 400 && r.size > 0);
  const totalBytes = ok.reduce((a, r) => a + r.size, 0);
  const perStream = ok.map((r) => effectiveMbps(r.size, r.ttfb, r.total));
  const sumEffective = perStream.reduce((a, b) => a + b, 0);
  const wallMbps = mbps(totalBytes, wallSec);
  const mean = perStream.length ? sumEffective / perStream.length : 0;
  const spreadPct = perStream.length > 1 && mean > 0
    ? Math.round((((Math.max(...perStream) - Math.min(...perStream)) / mean) * 100 + Number.EPSILON) * 10) / 10
    : 0;
  const codes = [...new Set(res.map((r) => r.httpCode))];
  return {
    streams,
    streamsOk: ok.length,
    bytesPerStream,
    totalBytes,
    wallMs: Math.round(wallSec * 1000),
    mbps: Math.round(wallMbps * 100) / 100, // honest end-to-end aggregate
    mbpsStreamSum: Math.round(sumEffective * 100) / 100, // excludes per-stream setup
    mbpsPerStream: perStream.map((v) => Math.round(v * 100) / 100),
    mbpsPerStreamMin: perStream.length ? Math.round(Math.min(...perStream) * 100) / 100 : null,
    mbpsPerStreamMax: perStream.length ? Math.round(Math.max(...perStream) * 100) / 100 : null,
    spreadPct,
    ttfbMs: ok.length ? Math.round((ok.reduce((a, r) => a + r.ttfb, 0) / ok.length) * 1000) : null,
    httpCodes: codes,
    rateLimited: detectRateLimit(res),
    failures: res.length - ok.length,
    status: ok.length === res.length ? 'ok' : detectRateLimit(res) ? 'rate-limited' : 'partial',
  };
}

async function curlOne(args, timeoutMs) {
  const curl = resolveCurl();
  const { stdout } = await run(curl, [...args, '--max-time', String(Math.ceil(timeoutMs / 1000))], {
    timeoutMs: timeoutMs + 4000,
  });
  return parseCurlW(stdout);
}

/** Parallel download test. Returns per-stream + aggregate stats. */
async function downloadOnce({
  bytes = 50_000_000,
  streams = 1,
  timeoutMs = 60_000,
  staggerMs = 90,
  onProgress,
  onStreamStart,
  onStreamDone,
  endpoint = null,
  label = 'cloudflare',
} = {}) {
  const started = Date.now();
  const jobs = [];
  for (let i = 0; i < streams; i += 1) {
    const url = endpoint || ENDPOINTS.down(bytes, `${i}-${started}`);
    if (onStreamStart) onStreamStart(i);
    // Stagger just enough to avoid a same-millisecond burst, which is what
    // Cloudflare's limiter keys on.
    if (i > 0 && staggerMs > 0) await sleep(staggerMs);
    jobs.push(
      curlOne(['-s', '-o', SINK, '-w', W_FORMAT, '--compressed', url], timeoutMs)
        // Reporting each finished stream turns a silent 8 s test into a live
        // counter: "3/6 streams, 41.2 Mbps so far".
        .then((r) => {
          if (onStreamDone) onStreamDone(i, r);
          return r;
        })
        .catch(() => ({
          httpCode: 0,
          size: 0,
          ttfb: 0,
          total: 0,
          speedField: 0,
        }))
    );
  }
  const res = await Promise.all(jobs);
  const wallSec = (Date.now() - started) / 1000;
  if (onProgress) onProgress(1);
  return { direction: 'down', endpoint: label, ...summarize(res, bytes, streams, wallSec), raw: res };
}

/* Download with a retry ladder.
   Cloudflare answers 429 when a client bursts; the answer is not "0 Mbps", it is
   "fewer streams, later, elsewhere". Ladder: same endpoint after a pause, then
   half the streams, then a fixed-size mirror that ignores query bursts. */
async function downloadTest(opts = {}) {
  const first = await downloadOnce(opts);
  if (!first.rateLimited) return first;

  await sleep(opts.retryDelayMs || 4000);
  const second = await downloadOnce({ ...opts, streams: Math.max(1, Math.min(2, opts.streams || 1)) });
  if (!second.rateLimited) {
    return { ...second, retried: true, attempts: 2, firstAttempt: { httpCodes: first.httpCodes, mbps: first.mbps } };
  }

  const mirrors = (ENDPOINTS.downFallbacks || []).slice();
  for (let i = 0; i < mirrors.length; i += 1) {
    await sleep(1500);
    const m = mirrors[i];
    const url = typeof m === 'function' ? m(opts.bytes || 50_000_000) : m;
    const alt = await downloadOnce({ ...opts, streams: 2, endpoint: url, label: `mirror-${i + 1}`, timeoutMs: opts.timeoutMs || 45_000 });
    if (!alt.rateLimited) {
      return { ...alt, retried: true, attempts: 3 + i, firstAttempt: { httpCodes: first.httpCodes, mbps: first.mbps } };
    }
  }
  return { ...second, retried: true, attempts: 3, rateLimited: true };
}

/** Parallel upload test. Payload is a cached 1 MB-pattern file, generated once. */
async function uploadOnce({
  bytes = 30_000_000,
  streams = 1,
  timeoutMs = 60_000,
  staggerMs = 90,
  onProgress,
  onStreamDone,
} = {}) {
  const file = payloadPath(bytes);
  const started = Date.now();
  const jobs = [];
  for (let i = 0; i < streams; i += 1) {
    if (i > 0 && staggerMs > 0) await sleep(staggerMs);
    jobs.push(
      curlOne(
        [
          '-s',
          '-o',
          SINK,
          '-w',
          W_FORMAT,
          '-X',
          'POST',
          '--data-binary',
          `@${file}`,
          '-H',
          'Content-Type: application/octet-stream',
          ENDPOINTS.up,
        ],
        timeoutMs
      )
        .then((r) => {
          if (onStreamDone) onStreamDone(i, { ...r, size: bytes });
          return r;
        })
        .catch(() => ({ httpCode: 0, size: 0, ttfb: 0, total: 0, speedField: 0 }))
    );
  }
  const res = await Promise.all(jobs);
  const wallSec = (Date.now() - started) / 1000;
  if (onProgress) onProgress(1);
  // __up may answer before consuming the body; per-stream "size" is the response
  // length, so count the bytes we actually sent instead.
  const mapped = res.map((r) => ({ ...r, size: bytes }));
  const s = summarize(mapped, bytes, streams, wallSec);
  return { direction: 'up', ...s, raw: res };
}

async function uploadTest(opts = {}) {
  const first = await uploadOnce(opts);
  if (!first.rateLimited) return first;
  await sleep(opts.retryDelayMs || 5000);
  const second = await uploadOnce(opts);
  return { ...second, retried: true, firstAttempt: { httpCodes: first.httpCodes, mbps: first.mbps } };
}

/**
 * Stream ramp: 1, 2, 4, 8 ... streams. The ceiling is where adding connections
 * stops buying throughput - the policer signature. Sequential so the numbers are
 * comparable, not contending with each other.
 */
async function rampTest({
  maxStreams = 8,
  bytesPerStream = 20_000_000,
  direction = 'down',
  timeoutMs = 90_000,
  onStep,
} = {}) {
  const steps = [];
  for (let s = 1; s <= maxStreams; s *= 2) steps.push(s);
  const points = [];
  const fn = direction === 'down' ? downloadTest : uploadTest;
  for (const streams of steps) {
    const r = await fn({ bytes: bytesPerStream, streams, timeoutMs });
    points.push({ streams, mbps: r.mbps, mbpsStreamSum: r.mbpsStreamSum, perStream: r.mbpsPerStream });
    if (onStep) onStep({ streams, mbps: r.mbps });
  }
  const peak = points.reduce((a, b) => (b.mbps > a.mbps ? b : a), points[0]);
  const ceiling = points.find((p) => p.mbps >= peak.mbps * 0.95) || peak;
  const gainFromOne = points.length > 1 ? Math.round((peak.mbps / points[0].mbps - 1) * 100) : 0;
  return {
    direction,
    points,
    peakMbps: peak.mbps,
    peakStreams: peak.streams,
    ceilingMbps: ceiling.mbps,
    ceilingStreams: ceiling.streams,
    singleStreamMbps: points[0].mbps,
    scalingGainPct: gainFromOne,
    verdict:
      gainFromOne < 8
        ? 'flat - a hard policer caps this link; more connections will not help'
        : gainFromOne < 40
          ? 'partial scaling - policer above single-stream rate'
          : 'scales well - single connections were the limit, not the ISP',
  };
}

/**
 * Bufferbloat: idle latency baseline, then latency sampled while the downlink is
 * saturated. Grade comes from the added latency, not the absolute RTT.
 */
async function bufferbloatTest({
  host = '1.1.1.1',
  streams = 4,
  bytesPerStream = 40_000_000,
  sampleMs = 250,
  timeoutMs = 90_000,
  onPhase,
} = {}) {
  const { pingOnce, startLatencyStream, jitterStats } = require('./ping');
  if (onPhase) onPhase('idle');
  const idle = await pingOnce(host, { count: 6, timeoutMs: 1200 });
  const idleAvg = idle.avg ?? null;

  if (onPhase) onPhase('loaded');
  const loaded = [];
  const stream = startLatencyStream(host, { timeoutMs: 1500 }, (s) => loaded.push(s));
  const loadPromise = downloadTest({ bytes: bytesPerStream, streams, timeoutMs });
  const hardStop = setTimeout(() => stream.kill(), timeoutMs + 2000);
  const result = await loadPromise;
  clearTimeout(hardStop);
  await new Promise((r) => setTimeout(r, 1200));
  stream.kill();

  const loadedRtts = loaded.map((s) => s.rtt).filter((v) => typeof v === 'number');
  const loadedAvg = loadedRtts.length ? loadedRtts.reduce((a, b) => a + b, 0) / loadedRtts.length : null;
  const delta = loadedAvg != null && idleAvg != null ? loadedAvg - idleAvg : null;
  const losses = loaded.filter((s) => s.status !== 'ok').length;
  const grade = delta != null ? require('../../shared/constants').gradeBufferbloat(Math.max(0, delta)) : { grade: '?', note: 'no data' };
  return {
    host,
    idleMs: idleAvg != null ? Math.round(idleAvg * 100) / 100 : null,
    loadedMs: loadedAvg != null ? Math.round(loadedAvg * 100) / 100 : null,
    loadedMaxMs: loadedRtts.length ? Math.max(...loadedRtts) : null,
    deltaMs: delta != null ? Math.round(delta * 100) / 100 : null,
    grade: grade.grade,
    gradeNote: grade.note,
    samples: loaded.length,
    lossPct: loaded.length ? Math.round((losses / loaded.length) * 1000) / 10 : null,
    jitter: jitterStats(loadedRtts),
    throughputMbps: result.mbps,
    sampleMs,
  };
}

module.exports = {
  downloadTest,
  uploadTest,
  rampTest,
  bufferbloatTest,
  parseCurlW,
  effectiveMbps,
};
