'use strict';
/**
 * Shared constants: targets, defaults, grading tables.
 * Kept dependency-free so both the Electron main process and plain-node
 * self-tests can require it.
 */

const ENDPOINTS = {
  // Cloudflare's speed endpoints: no API key, cached at the local POP (DAC here).
  down: (bytes, salt) =>
    `https://speed.cloudflare.com/__down?bytes=${bytes}${salt ? `&r=${salt}` : ''}`,
  up: 'https://speed.cloudflare.com/__up',
  meta: 'https://speed.cloudflare.com/meta',
  ipinfo: 'https://ipinfo.io/json',
  // Mirrors used only when Cloudflare answers 429. They are fixed-size files, so
  // the measurement uses bytes that actually arrived, not the requested count.
  // Verified reachable from this link: OVH ~44 Mbps, thinkbroadband slower.
  downFallbacks: [
    (bytes) => `https://proof.ovh.net/files/${bytes <= 20_000_000 ? '10Mb' : bytes <= 120_000_000 ? '100Mb' : '1Gb'}.dat`,
    () => 'https://download.thinkbroadband.com/50MB.zip',
  ],
};

const TEST_HOSTS = ['1.1.1.1', '8.8.8.8'];

const DNS_DOMAINS = ['github.com', 'wikipedia.org', 'cloudflare.com', 'microsoft.com'];
const DNS_RESOLVERS = [
  { label: 'Cloudflare', servers: ['1.1.1.1', '1.0.0.1'] },
  { label: 'Google', servers: ['8.8.8.8', '8.8.4.4'] },
  { label: 'Quad9', servers: ['9.9.9.9', '149.112.112.112'] },
  { label: 'System', servers: null },
];

const TEST_SIZES = [
  { key: 'quick', label: 'Quick', bytes: 10_000_000, streams: 1 },
  { key: 'standard', label: 'Standard', bytes: 50_000_000, streams: 6 },
  { key: 'full', label: 'Full', bytes: 100_000_000, streams: 8 },
];

const DEFAULT_SETTINGS = {
  // --- sampling ---
  latencyIntervalMs: 1000,
  latencyTimeoutMs: 1500,
  chartWindowSec: 120,
  historyKeepDays: 14,
  pauseWhenHidden: true,

  // --- targets ---
  targets: [
    { host: '1.1.1.1', label: 'Cloudflare', enabled: true, color: '#4dd4ff' },
    { host: '8.8.8.8', label: 'Google DNS', enabled: true, color: '#a78bfa' },
  ],
  gateway: { enabled: true, host: null, label: 'Gateway', color: '#34d399' },

  // --- throughput ---
  downStreams: 6,
  upStreams: 1,
  testSizeBytes: 50_000_000,
  uploadSizeBytes: 30_000_000,
  rampMaxStreams: 8,
  autoSpeedTestMinutes: 0, // 0 = off
  warmOnStart: true, // run DNS + a quick throughput pass on launch so no panel opens blank
  planDownMbps: 60, // used only to compute "share of plan"

  // --- gadget window ---
  // Size is remembered per machine: a 4K desk wants expanded, a laptop standard.
  gadgetSize: 'standard',
  // Set when the user drags the gadget to their own size; overrides the preset.
  gadgetCustom: null,
  // Which series the live graph draws. Order is the draw order (last paints on top).
  gadgetSeries: ['down', 'up', 'lat', 'jit'],
  gadgetPin: true,
  planUpMbps: 100,

  // --- bufferbloat ---
  bbStreams: 4,
  bbBytesPerStream: 40_000_000,
  bbSampleMs: 250,

  // --- alerts ---
  alertLossPct: 2,
  alertRttMs: 150,
  alertDownFloorMbps: 20,

  // --- ui ---
  accent: 'cyan',
  theme: 'dark',
  animationIntensity: 70,
  density: 'comfortable',
  reducedMotion: false,
};

const BB_GRADES = [
  { max: 30, grade: 'A+', note: 'no queueing under load' },
  { max: 60, grade: 'A', note: 'excellent' },
  { max: 100, grade: 'B', note: 'good' },
  { max: 200, grade: 'C', note: 'noticeable lag under load' },
  { max: 400, grade: 'D', note: 'bufferbloat hurting real use' },
  { max: Infinity, grade: 'F', note: 'severe bufferbloat' },
];

const ACCENTS = {
  cyan: { base: '#4dd4ff', soft: '#4dd4ff22', glow: 'rgba(77,212,255,0.45)' },
  violet: { base: '#a78bfa', soft: '#a78bfa22', glow: 'rgba(167,139,250,0.45)' },
  emerald: { base: '#34d399', soft: '#34d39922', glow: 'rgba(52,211,153,0.45)' },
  amber: { base: '#fbbf24', soft: '#fbbf2422', glow: 'rgba(251,191,36,0.45)' },
  rose: { base: '#fb7185', soft: '#fb718522', glow: 'rgba(251,113,133,0.45)' },
};

function gradeBufferbloat(deltaMs) {
  const row = BB_GRADES.find((g) => deltaMs <= g.max);
  return { grade: row.grade, note: row.note };
}

function letter(value, bands) {
  for (const b of bands) if (value <= b.max) return b.grade;
  return 'F';
}

module.exports = {
  ENDPOINTS,
  TEST_HOSTS,
  DNS_DOMAINS,
  DNS_RESOLVERS,
  TEST_SIZES,
  DEFAULT_SETTINGS,
  BB_GRADES,
  ACCENTS,
  gradeBufferbloat,
  letter,
};
