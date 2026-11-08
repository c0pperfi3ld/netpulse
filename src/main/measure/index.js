'use strict';
/**
 * Probe registry. Every measurement the app can run is reachable from here with
 * a plain settings object, which is what makes `npm run selftest` possible
 * without Electron: the same code path the UI uses, driven from a script.
 */
const { pingOnce, rollup, jitterStats } = require('./ping');
const { downloadTest, uploadTest, rampTest, bufferbloatTest } = require('./throughput');
const { benchResolvers } = require('./dns');
const { mtuReport, discoverPathMtu } = require('./mtu');
const { linkSnapshot, ispIdentity, ipv6Check } = require('./link');
const { qualityScore } = require('./quality');
const { DEFAULT_SETTINGS } = require('../../shared/constants');

/** Multi-host latency sweep (point-in-time; the live series lives in the scheduler). */
async function latencySweep(hosts, { count = 10, timeoutMs = 1500 } = {}) {
  const out = [];
  for (const h of hosts) {
    // eslint-disable-next-line no-await-in-loop
    const r = await pingOnce(h, { count, timeoutMs });
    out.push({
      host: h,
      sent: r.sent,
      recv: r.recv,
      lossPct: r.lossPct,
      min: r.min,
      avg: r.avg == null ? null : Math.round(r.avg * 100) / 100,
      max: r.max,
      p50: r.p50,
      p95: r.p95,
      jitter: jitterStats(r.rtts),
    });
  }
  return out;
}

/** Everything the CLI audit ran, in one call. Used by the self-test and QA runs. */
async function fullAudit(settings = DEFAULT_SETTINGS, hooks = {}) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const ifaceHint = hooks.ifaceName || null;
  const link = await linkSnapshot({ ifaceName: ifaceHint });
  const hosts = s.targets.filter((t) => t.enabled).map((t) => t.host).concat(['8.8.8.8']);

  const [latency, mtu, dns, isp, ipv6] = await Promise.all([
    latencySweep([...new Set(hosts)], { count: hooks.latencyCount || 10 }),
    mtuReport({ ifaceName: link.interface }),
    benchResolvers({}),
    ispIdentity(),
    ipv6Check(),
  ]);

  const download = await downloadTest({
    bytes: hooks.downloadBytes || s.testSizeBytes,
    streams: hooks.downloadStreams || s.downStreams,
  });
  const upload = await uploadTest({
    bytes: hooks.uploadBytes || s.uploadSizeBytes,
    streams: s.upStreams,
  });
  const bufferbloat = await bufferbloatTest({
    host: s.targets[0] ? s.targets[0].host : '1.1.1.1',
    streams: s.bbStreams,
    bytesPerStream: s.bbBytesPerStream,
  });

  const primaryLatency = latency.find((l) => l.host === (s.targets[0] && s.targets[0].host)) || latency[0];
  const bestDns = dns.rows.filter((r) => r.avgMs != null).sort((a, b) => a.avgMs - b.avgMs)[0];
  const quality = qualityScore({
    latency: {
      avg: primaryLatency ? primaryLatency.avg : null,
      lossPct: primaryLatency ? primaryLatency.lossPct : null,
      jitter: primaryLatency ? primaryLatency.jitter : null,
    },
    bufferbloat: { deltaMs: bufferbloat.deltaMs, grade: bufferbloat.grade },
    dns: bestDns ? { avgMs: bestDns.avgMs } : null,
    download: { mbps: download.mbps },
    upload: { mbps: upload.mbps },
    plan: { down: s.planDownMbps, up: s.planUpMbps },
  });

  return {
    at: new Date().toISOString(),
    interface: link.interface,
    link,
    latency,
    mtu,
    dns,
    isp,
    ipv6,
    download,
    upload,
    bufferbloat,
    quality,
  };
}

module.exports = {
  latencySweep,
  fullAudit,
  downloadTest,
  uploadTest,
  rampTest,
  bufferbloatTest,
  benchResolvers,
  mtuReport,
  discoverPathMtu,
  linkSnapshot,
  ispIdentity,
  ipv6Check,
  qualityScore,
  pingOnce,
  rollup,
};
