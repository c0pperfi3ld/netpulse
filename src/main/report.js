'use strict';
/**
 * Markdown report generator: turns a snapshot (and optional history) into the
 * same shape of report the CLI audit produced, so app findings and terminal
 * findings can be diffed line by line.
 */
const { dayKey } = require('./store');

function fmt(v, digits = 2) {
  return v == null ? 'n/a' : Number(v).toFixed(digits).replace(/\.?0+$/, '');
}

function bar(v, max, width = 28) {
  if (v == null) return '';
  const n = Math.max(0, Math.min(width, Math.round((v / max) * width)));
  return `${'█'.repeat(n)}${'░'.repeat(width - n)}`;
}

function table(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `|${headers.map(() => '---').join('|')}|`;
  return [head, sep, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

function buildReport(snap, { history = [], previous = null } = {}) {
  const s = snap;
  const lat = s.latency;
  const down = s.lastTests && s.lastTests.down;
  const up = s.lastTests && s.lastTests.up;
  const bb = s.lastTests && s.lastTests.bufferbloat;
  const lines = [];

  lines.push(`# NetPulse report — ${new Date().toLocaleString()}`);
  lines.push('');
  lines.push(`Interface **${s.link && s.link.interface ? s.link.interface : 'unknown'}** · ` +
    `${s.link && s.link.primary ? s.link.primary.description : ''} · ` +
    `link **${s.link && s.link.primary ? s.link.primary.linkSpeed : '?'}**`);
  if (s.isp && s.isp.ok) lines.push(`Public IP **${s.isp.ip}** · ${s.isp.org} · ${s.isp.city}, ${s.isp.country}`);
  lines.push(`IPv6: ${s.ipv6 ? (s.ipv6.available ? 'available' : 'not available') : 'unknown'}`);
  lines.push('');
  lines.push(`## Quality: ${s.quality.score}/100 (${s.quality.grade})`);
  lines.push('');
  lines.push(
    table(
      ['Dimension', 'Value', 'Grade', 'Weight', 'Note'],
      s.quality.dimensions.map((d) => [d.label, `${d.value == null ? 'n/a' : d.value} ${d.unit}`, d.grade, d.weight, d.note])
    )
  );
  lines.push('');

  lines.push('## Latency, jitter and loss');
  lines.push('');
  lines.push(
    table(
      ['Target', 'avg ms', 'min', 'max', 'p50', 'p95', 'p99', 'jitter ms', 'loss %', 'samples'],
      lat.targets.map((t) => [
        t.label || t.host,
        fmt(t.stats.avg),
        fmt(t.stats.min, 0),
        fmt(t.stats.max, 0),
        fmt(t.stats.p50, 0),
        fmt(t.stats.p95, 0),
        fmt(t.stats.p99, 0),
        fmt(t.stats.jitter.meanDelta),
        fmt(t.stats.lossPct, 1),
        t.stats.count,
      ])
    )
  );
  lines.push('');

  lines.push('## Throughput');
  lines.push('');
  if (down) {
    lines.push(`- **Download:** ${down.mbps} Mbps (${fmt(down.mbps / 8, 2)} MB/s) — ${down.streams} stream(s), ${down.streamsOk} ok, ` +
      `per-stream ${down.mbpsPerStream.join(' / ')} Mbps, ${down.ttfbMs} ms TTFB`);
    lines.push(`  \`${bar(down.mbps, 200)}\``);
  } else lines.push('- Download: not measured yet');
  if (up) {
    lines.push(`- **Upload:** ${up.mbps} Mbps (${fmt(up.mbps / 8, 2)} MB/s) — ${up.streams} stream(s), ${up.streamsOk} ok`);
    lines.push(`  \`${bar(up.mbps, 200)}\``);
  } else lines.push('- Upload: not measured yet');
  if (previous && previous.downloadMbps != null && down) {
    const delta = down.mbps - previous.downloadMbps;
    lines.push(`- Change since previous report: ${delta >= 0 ? '+' : ''}${fmt(delta)} Mbps download`);
  }
  lines.push('');

  if (s.lastTests && s.lastTests.ramp) {
    const r = s.lastTests.ramp;
    lines.push('### Stream scaling');
    lines.push('');
    lines.push(table(['Streams', 'Aggregate Mbps', 'Per-stream Mbps'], r.points.map((p) => [p.streams, p.mbps, p.perStream.join(' / ')])));
    lines.push('');
    lines.push(`Verdict: **${r.verdict}** (single ${r.singleStreamMbps} → peak ${r.peakMbps} Mbps at ${r.peakStreams} streams)`);
    lines.push('');
  }

  if (bb) {
    lines.push('## Bufferbloat');
    lines.push('');
    lines.push(`Idle **${bb.idleMs} ms** → loaded **${bb.loadedMs} ms** = **+${bb.deltaMs} ms** (grade **${bb.grade}**, ${bb.gradeNote}); ` +
      `jitter under load ${bb.jitter.meanDelta} ms, loss ${bb.lossPct}%`);
    lines.push('');
  }

  if (s.mtu) {
    lines.push('## MTU / path');
    lines.push('');
    lines.push(`Adapter MTU **${s.mtu.liveMtu}**, path MTU **${s.mtu.pathMtu}** (max DF payload ${s.mtu.payloadMax}), ` +
      `verdict **${s.mtu.verdict}**, fragment signalling ${s.mtu.fragSignalled ? 'present' : 'absent'}`);
    lines.push('');
    lines.push(`> ${s.mtu.advice}`);
    if (s.mtu.fixCommand) {
      lines.push('');
      lines.push('```bash');
      lines.push(s.mtu.fixCommand);
      lines.push('```');
    }
    lines.push('');
  }

  if (s.dns) {
    lines.push('## DNS');
    lines.push('');
    lines.push(
      table(
        ['Resolver', 'Servers', 'avg ms', 'min', 'max', 'recursive avg ms'],
        s.dns.rows.map((r) => [r.label, r.servers.join(', '), fmt(r.avgMs), fmt(r.minMs), fmt(r.maxMs), fmt(r.recursiveAvgMs)])
      )
    );
    lines.push('');
    lines.push(`Fastest: **${s.dns.fastest}** — ${s.dns.recommendation}`);
    lines.push('');
  }

  if (s.link && s.link.issues && s.link.issues.length) {
    lines.push('## Link issues');
    lines.push('');
    for (const i of s.link.issues) lines.push(`- **${i.title}** — ${i.detail}`);
    lines.push('');
  }

  if (history.length) {
    lines.push('## History (throughput samples in the last 24h)');
    lines.push('');
    const rows = history.slice(-30).map((h) => [
      new Date(h.t).toLocaleTimeString(),
      h.direction || '?',
      h.mbps,
      h.streams,
    ]);
    lines.push(table(['time', 'direction', 'Mbps', 'streams'], rows));
    lines.push('');
  }

  if (s.events && s.events.length) {
    lines.push('## Recent events');
    lines.push('');
    lines.push(table(['time', 'level', 'event'], s.events.slice(-20).map((e) => [new Date(e.t).toLocaleTimeString(), e.level, e.msg])));
    lines.push('');
  }

  lines.push('---');
  lines.push(`Generated by NetPulse ${new Date().toISOString()} · sampling overhead ${s.overhead ? s.overhead.cpuPct : '?'}% CPU, ` +
    `${s.overhead ? s.overhead.children : '?'} active probe process(es)`);
  lines.push('');
  return lines.join('\n');
}

function reportName() {
  return `netpulse-${dayKey()}-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.md`;
}

module.exports = { buildReport, reportName };
