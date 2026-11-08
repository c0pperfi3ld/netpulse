'use strict';
/**
 * Composite quality score.
 *
 * Turns the raw measurements into one 0-100 number plus per-dimension grades, so
 * the UI can show "how good is this link" without hiding the evidence: every
 * dimension carries the value it was derived from.
 */

const BANDS = {
  latency: [
    { max: 5, grade: 'A+', note: 'local edge - essentially zero queueing' },
    { max: 15, grade: 'A', note: 'excellent' },
    { max: 30, grade: 'B', note: 'good for a long-haul path' },
    { max: 60, grade: 'C', note: 'noticeable' },
    { max: 100, grade: 'D', note: 'poor' },
    { max: Infinity, grade: 'F', note: 'unusable for interactive work' },
  ],
  jitter: [
    { max: 2, grade: 'A+', note: 'rock steady' },
    { max: 5, grade: 'A', note: 'very steady' },
    { max: 10, grade: 'B', note: 'acceptable' },
    { max: 25, grade: 'C', note: 'audible/visible in calls' },
    { max: Infinity, grade: 'F', note: 'too jittery for realtime' },
  ],
  loss: [
    { max: 0, grade: 'A+', note: 'no loss' },
    { max: 1, grade: 'B', note: 'trace loss' },
    { max: 3, grade: 'C', note: 'retransmits likely' },
    { max: 10, grade: 'D', note: 'hurting throughput' },
    { max: Infinity, grade: 'F', note: 'severe' },
  ],
  bufferbloat: [
    { max: 30, grade: 'A+', note: 'no queueing under load' },
    { max: 60, grade: 'A', note: 'excellent' },
    { max: 100, grade: 'B', note: 'good' },
    { max: 200, grade: 'C', note: 'laggy under load' },
    { max: 400, grade: 'D', note: 'bad' },
    { max: Infinity, grade: 'F', note: 'severe' },
  ],
  dns: [
    { max: 10, grade: 'A+', note: 'near-instant' },
    { max: 25, grade: 'A', note: 'fast' },
    { max: 50, grade: 'B', note: 'fine' },
    { max: 100, grade: 'C', note: 'slows first loads' },
    { max: Infinity, grade: 'F', note: 'resolver is a bottleneck' },
  ],
  throughput: [
    { max: 0, grade: 'F', note: 'failed' },
    { max: 1, grade: 'D', note: 'almost nothing' },
    { max: 10, grade: 'C', note: 'basic browsing only' },
    { max: 30, grade: 'B', note: 'usable for HD' },
    { max: 100, grade: 'A', note: 'comfortable' },
    { max: Infinity, grade: 'A+', note: 'fast' },
  ],
};

function bandScore(key, value) {
  const table = BANDS[key];
  if (!table || value == null) return { score: null, grade: '?', note: 'no data' };
  const idx = table.findIndex((b) => value <= b.max);
  const row = table[Math.max(0, idx)];
  const pct = 100 - (idx / (table.length - 1)) * 85; // 100 down to 15 across bands
  return { score: Math.round(pct), grade: row.grade, note: row.note };
}

function ratioScore(measured, plan) {
  if (!measured || !plan) return { score: null, grade: '?', note: 'no plan configured' };
  const ratio = measured / plan;
  if (ratio >= 0.95) return { score: 100, grade: 'A+', note: 'meets the configured plan' };
  if (ratio >= 0.8) return { score: 88, grade: 'A', note: 'close to plan' };
  if (ratio >= 0.6) return { score: 72, grade: 'B', note: 'well below plan' };
  if (ratio >= 0.4) return { score: 55, grade: 'C', note: 'far below plan' };
  if (ratio >= 0.2) return { score: 35, grade: 'D', note: 'a fraction of plan' };
  return { score: 18, grade: 'F', note: 'plan not being delivered' };
}

function overallGrade(score) {
  if (score == null) return '?';
  if (score >= 90) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

/**
 * @param {object} s snapshot pieces, any of which may be missing
 *   { latency:{avg,jitter:{meanDelta},lossPct}, bufferbloat:{deltaMs}, dns:{avgMs},
 *     download:{mbps}, upload:{mbps}, plan:{down,up} }
 */
function qualityScore(s = {}) {
  const dims = [];
  const push = (key, label, value, unit, weight, extra = {}) => {
    const b = bandScore(key, value);
    dims.push({ key, label, value, unit, weight, ...b, ...extra });
  };

  push('latency', 'Latency', s.latency ? s.latency.avg : null, 'ms', 0.2);
  push('jitter', 'Jitter', s.latency && s.latency.jitter ? s.latency.jitter.meanDelta : null, 'ms', 0.1);
  push('loss', 'Packet loss', s.latency ? s.latency.lossPct : null, '%', 0.15);

  const bb = s.bufferbloat && s.bufferbloat.deltaMs != null ? s.bufferbloat.deltaMs : null;
  push('bufferbloat', 'Bufferbloat (added ms)', bb, 'ms', 0.1,
    s.bufferbloat && s.bufferbloat.grade ? { grade: s.bufferbloat.grade } : {});

  const dl = s.download ? ratioScore(s.download.mbps, s.plan ? s.plan.down : null) : { score: null, grade: '?', note: 'not measured' };
  dims.push({ key: 'download', label: 'Download vs plan', value: s.download ? s.download.mbps : null, unit: 'Mbps', weight: 0.2, ...dl });
  const ul = s.upload ? ratioScore(s.upload.mbps, s.plan ? s.plan.up : null) : { score: null, grade: '?', note: 'not measured' };
  dims.push({ key: 'upload', label: 'Upload vs plan', value: s.upload ? s.upload.mbps : null, unit: 'Mbps', weight: 0.15, ...ul });

  push('dns', 'DNS', s.dns ? s.dns.avgMs : null, 'ms', 0.1);

  let wsum = 0;
  let total = 0;
  for (const d of dims) {
    if (d.score == null) continue;
    total += d.score * d.weight;
    wsum += d.weight;
  }
  const score = wsum ? Math.round(total / wsum) : null;
  return { score, grade: overallGrade(score), dimensions: dims };
}

module.exports = { qualityScore, bandScore, ratioScore, overallGrade, BANDS };
