'use strict';
/**
 * DNS resolver benchmark.
 *
 * Times A-record lookups against each resolver explicitly (Node's Resolver can
 * be pointed at arbitrary servers), plus the OS resolver, and separately probes
 * an unlikely-to-exist name so we can tell a cached answer from real recursion.
 */
const dns = require('node:dns');
const { DNS_DOMAINS, DNS_RESOLVERS } = require('../../shared/constants');

function randLabel() {
  return `np${Math.random().toString(36).slice(2, 12)}`;
}

function timedLookup(resolver, name, timeoutMs) {
  const server = resolver.servers ? new dns.promises.Resolver({ timeout: timeoutMs, tries: 1 }) : dns.promises;
  if (resolver.servers) server.setServers(resolver.servers);
  const started = process.hrtime.bigint();
  return new Promise((resolve) => {
    const finish = (answers, error) => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ ms: Math.round(ms * 100) / 100, answers: answers || [], error: error || null });
    };
    const t = setTimeout(() => finish([], 'timeout'), timeoutMs + 250);
    server
      .resolve4(name)
      .then((a) => {
        clearTimeout(t);
        finish(a, null);
      })
      .catch((e) => {
        clearTimeout(t);
        // NXDOMAIN for the random probe is expected and is still a valid timing
        // sample of the recursive path.
        finish([], e && e.code ? e.code : String(e));
      });
  });
}

async function benchResolvers({
  domains = DNS_DOMAINS,
  resolvers = DNS_RESOLVERS,
  timeoutMs = 2500,
} = {}) {
  const rows = [];
  for (const resolver of resolvers) {
    const hits = [];
    const misses = [];
    for (const d of domains) {
      const r = await timedLookup(resolver, d, timeoutMs);
      hits.push({ name: d, ...r });
    }
    // 2 uncached-path probes: random label under a well-known zone.
    for (const d of domains.slice(0, 2)) {
      const probe = `${randLabel()}.${d}`;
      const r = await timedLookup(resolver, probe, timeoutMs);
      misses.push({ name: probe, ...r, expected: r.error === 'ENOTFOUND' || r.error === 'ENODATA' });
    }
    const okHits = hits.filter((h) => h.answers.length).map((h) => h.ms);
    const okMiss = misses.filter((m) => m.expected).map((m) => m.ms);
    const all = [...okHits, ...okMiss];
    rows.push({
      label: resolver.label,
      servers: resolver.servers || ['(system)'],
      queries: all.length,
      answered: okHits.length,
      minMs: all.length ? Math.min(...all) : null,
      avgMs: all.length ? Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 100) / 100 : null,
      maxMs: all.length ? Math.max(...all) : null,
      recursiveAvgMs: okMiss.length ? Math.round((okMiss.reduce((a, b) => a + b, 0) / okMiss.length) * 100) / 100 : null,
      errors: [...new Set([...hits, ...misses].filter((r) => r.error && !r.expected).map((r) => r.error))],
      detail: hits,
    });
  }
  const ranked = [...rows].filter((r) => r.avgMs != null).sort((a, b) => a.avgMs - b.avgMs);
  return {
    rows,
    fastest: ranked[0] ? ranked[0].label : null,
    recommendation:
      ranked.length && ranked[0].avgMs < 20
        ? `keep ${ranked[0].label} (${ranked[0].avgMs} ms avg)`
        : 'all resolvers are slow - try a local caching resolver',
  };
}

module.exports = { benchResolvers, timedLookup };
