#!/usr/bin/env node
'use strict';
/**
 * Verification gate #1: run the whole measurement core in plain Node (no
 * Electron) and print the numbers, so they can be diffed against the CLI audit
 * that produced 56 Mbps down / 90 Mbps up / 2.2 ms local RTT / path MTU 1480.
 *
 *   node scripts/selftest.js            human-readable
 *   node scripts/selftest.js --json     machine-readable
 *   node scripts/selftest.js --fast     10 MB probes instead of 50/30 MB
 */
const path = require('node:path');
const { fullAudit, latencySweep } = require('../src/main/measure');
const { startLatencyStream } = require('../src/main/measure/ping');
const { DEFAULT_SETTINGS } = require('../src/shared/constants');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const fast = args.includes('--fast');

function bar(v, max, width = 24) {
  if (v == null) return '';
  const n = Math.max(0, Math.min(width, Math.round((v / max) * width)));
  return '#'.repeat(n) + '.'.repeat(width - n);
}

async function streamCheck(host, ms = 6000) {
  const samples = [];
  const stream = startLatencyStream(host, { timeoutMs: 1500 }, (s) => samples.push(s));
  await new Promise((r) => setTimeout(r, ms));
  stream.kill();
  const rtts = samples.map((s) => s.rtt).filter((v) => typeof v === 'number');
  return {
    host,
    windowMs: ms,
    samples: samples.length,
    rtts: rtts.length,
    live: samples.length > 1,
    avg: rtts.length ? Math.round((rtts.reduce((a, b) => a + b, 0) / rtts.length) * 100) / 100 : null,
  };
}

(async () => {
  const started = Date.now();
  const t0 = (msg) => {
    if (!asJson) process.stderr.write(`  ... ${msg}\n`);
  };

  const link = await require('../src/main/measure/link').linkSnapshot({});
  const iface = link.interface;

  t0(`streaming latency check on ${DEFAULT_SETTINGS.targets[0].host}`);
  const stream = await streamCheck(DEFAULT_SETTINGS.targets[0].host, fast ? 4000 : 7000);

  const audit = await fullAudit(
    {
      ...DEFAULT_SETTINGS,
      testSizeBytes: fast ? 10_000_000 : 50_000_000,
      downStreams: fast ? 4 : 6,
      uploadSizeBytes: fast ? 10_000_000 : 30_000_000,
      bbBytesPerStream: fast ? 15_000_000 : 40_000_000,
    },
    { ifaceName: iface, latencyCount: fast ? 6 : 12, downloadBytes: fast ? 10_000_000 : 50_000_000, downloadStreams: fast ? 4 : 6 }
  );

  const result = { at: new Date().toISOString(), durationMs: Date.now() - started, stream, ...audit };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const L = (s) => process.stdout.write(`${s}\n`);
  L('');
  L(`NetPulse self-test                     ${result.at}   (${(result.durationMs / 1000).toFixed(1)}s)`);
  L('='.repeat(78));
  L(`interface          ${result.link.interface}   ${result.link.primary ? result.link.primary.linkSpeed : '?'}`);
  L(`                            ${result.link.primary ? result.link.primary.description : ''}`);
  L(`public IP / ISP    ${result.isp.ok ? `${result.isp.ip}  ${result.isp.org} (${result.isp.city}, ${result.isp.country})` : `unavailable (${result.isp.error})`}`);
  L(`IPv6 reachable     ${result.ipv6.available ? 'yes' : `no (${result.ipv6.error})`}`);
  L('');
  L('LATENCY (bounded sweep)');
  for (const l of result.latency) {
    L(`  ${l.host.padEnd(14)} avg ${String(l.avg).padStart(7)} ms  min ${String(l.min).padStart(4)}  max ${String(l.max).padStart(5)}  p95 ${String(l.p95).padStart(5)}  jitter ${String(l.jitter.meanDelta).padStart(5)}  loss ${l.lossPct}%`);
  }
  L(`  live stream      ${result.stream.samples} samples / ${result.stream.windowMs}ms window  (streaming ${result.stream.live ? 'OK' : 'NOT WORKING'})`);
  L('');
  L('THROUGHPUT');
  L(`  download         ${String(result.download.mbps).padStart(7)} Mbps  ${bar(result.download.mbps, 120)}  ${result.download.mbpsStreamSum} Mbps stream-sum, ${result.download.streams} stream(s)`);
  L(`  upload           ${String(result.upload.mbps).padStart(7)} Mbps  ${bar(result.upload.mbps, 120)}  ${result.upload.streams} stream(s)`);
  L('');
  L('BUFFERBLOAT');
  L(`  idle ${result.bufferbloat.idleMs} ms -> loaded ${result.bufferbloat.loadedMs} ms  (+${result.bufferbloat.deltaMs} ms)  loss ${result.bufferbloat.lossPct}%  verdict ${result.bufferbloat.grade}`);
  L('');
  L('MTU');
  L(`  adapter ${result.mtu.liveMtu}  path ${result.mtu.pathMtu}  verdict ${result.mtu.verdict}`);
  L(`  ${result.mtu.advice}`);
  L('');
  L('DNS');
  for (const r of result.dns.rows) {
    L(`  ${r.label.padEnd(11)} avg ${String(r.avgMs).padStart(7)} ms  min ${String(r.minMs).padStart(6)}  max ${String(r.maxMs).padStart(6)}  recursive ${String(r.recursiveAvgMs).padStart(7)}  answered ${r.answered}/${r.detail.length}`);
  }
  L('');
  L(`QUALITY SCORE      ${result.quality.score}/100  (${result.quality.grade})`);
  for (const d of result.quality.dimensions) {
    L(`  ${d.label.padEnd(24)} ${String(d.value).padStart(9)} ${d.unit.padEnd(5)} grade ${String(d.grade).padStart(2)}  w=${d.weight}`);
  }
  L('');
  L('EXPECTATIONS (from the CLI audit in this workspace)');
  const checks = [
    ['path MTU is 1480', result.mtu.pathMtu === 1480],
    ['adapter MTU <= path MTU', result.mtu.liveMtu != null && result.mtu.liveMtu <= result.mtu.pathMtu],
    ['download in 40-75 Mbps band', result.download.mbps > 40 && result.download.mbps < 75],
    ['upload above 60 Mbps', result.upload.mbps > 60],
    ['local RTT under 10 ms', result.latency.some((l) => l.avg != null && l.avg < 10)],
    ['live latency stream emits samples', result.stream.live],
  ];
  for (const [name, pass] of checks) L(`  [${pass ? 'PASS' : 'FAIL'}] ${name}`);
  L('');
})();
