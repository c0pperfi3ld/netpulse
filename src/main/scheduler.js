'use strict';
/**
 * Scheduler: owns the live latency streams, the periodic probes, back-pressure
 * (only one bandwidth-consuming test at a time), ring buffers, event rules and
 * the snapshot the renderer renders from.
 *
 * Design notes:
 *  - rendering is decoupled: probes write into ring buffers, and a single 4 Hz
 *    tick pushes a snapshot. Nothing paints the UI per packet.
 *  - a throughput-ish task holds `this.busy`; concurrent heavy tests would
 *    contaminate each other's numbers, so they queue instead.
 */
const { EventEmitter } = require('node:events');
const { startLatencyStream, pingOnce, rollup, jitterStats } = require('./measure/ping');
const {
  downloadTest,
  uploadTest,
  rampTest,
  bufferbloatTest,
} = require('./measure/throughput');
const { benchResolvers } = require('./measure/dns');
const { mtuReport } = require('./measure/mtu');
const { linkSnapshot, ispIdentity, ipv6Check } = require('./measure/link');
const { qualityScore } = require('./measure/quality');
const { createLinkRateSampler } = require('./measure/linkRate');
const { startTopAppsSampler } = require('./measure/topApps');
const { childCount, killAll } = require('./util/proc');

const RING_CAP = 3600;

class Scheduler extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.settings = store.settings;
    this.rings = new Map(); // host -> [{t,rtt,status}]
    this.streams = new Map(); // host -> {kill}
    this.link = null;
    this.mtu = null;
    this.dns = null;
    this.isp = null;
    this.ipv6 = null;
    this.lastTests = { down: null, up: null, ramp: null, bufferbloat: null };
    this.inFlight = null;
    this.busy = false;
    this.startedAt = Date.now();
    this.timers = [];
    this.cpuLast = process.cpuUsage();
    this.cpuPct = 0;
    this.paused = false;
    this.events = store.events.slice(-200);
    // The windowed latency view is rebuilt only when a sample actually arrives,
    // not on every snapshot read (the old code recomputed it twice per tick).
    this._latCache = null;
    this._lastSampleAt = new Map(); // host -> timestamp of last accepted sample
    // Real throughput of the machine, including traffic NetPulse did not start.
    this.linkRate = { at: null, downMbps: null, upMbps: null, utilPct: null, underLoad: false };
    this.rateSampler = null;
    // Ranked per-process I/O, refreshed every couple of seconds.
    this.topApps = { at: null, rows: [], totalMbs: 0, error: null };
    this.appMb = new Map(); // process name -> MB seen this session
    this.topAppsSampler = null;
  }

  /* ---------------------------------------------------------------- lifecycle */

  async start({ warm = true } = {}) {
    this.store.prune();
    await this.refreshEnvironment({ quiet: true });
    this.syncStreams();
    this.syncTimers();
    this.tickTimer = setInterval(() => this.tick(), 250);
    this.autoTimer = setInterval(() => this.maybeAutoTest(), 30_000);
    this.envTimer = setInterval(() => this.refreshEnvironment({ quiet: true }), 120_000);
    this.pruneTimer = setInterval(() => this.store.prune(), 6 * 60 * 60 * 1000);
    this.startRateSampler();
    this.startTopApps();
    this.log('info', 'monitor started', { interface: this.link && this.link.interface });
    if (warm) this.startupTimer = setTimeout(() => this.warmUp(), 1200);
  }

  /**
   * First-run warm-up. A monitor that opens onto a wall of "-" reads as broken, so
   * the cheap probes run themselves: DNS bench, a quick download+upload, then a
   * short bufferbloat pass. Everything here is skippable (warmOnStart: false) and
   * it yields to any test the user starts by hand.
   */
  async warmUp({ stageGapMs = 400 } = {}) {
    if (this.settings.warmOnStart === false) return;
    // The window is created hidden and shown on ready-to-show; the renderer pauses
    // sampling while hidden, so wait for it to be visible instead of measuring for
    // nobody.
    for (let i = 0; i < 24 && this.paused; i += 1) await new Promise((r) => setTimeout(r, 500));
    if (this.paused) return;
    const step = async (name, fn) => {
      if (this.paused) return;
      if (this.busy) {
        // A manual test owns the link; a queued warm-up would contaminate it.
        this.log('info', `startup ${name} skipped: link busy`, { code: 'warm-skip' });
        return;
      }
      try {
        await fn();
      } catch (e) {
        this.log('warn', `startup ${name} skipped: ${e.message}`, { code: 'warm-skip' });
      }
      await new Promise((r) => setTimeout(r, stageGapMs));
    };
    await step('dns', () => this.runDns());
    // Active throughput tests are NOT run automatically: a network monitor should
    // be a pure, passive observer and never saturate the connection on its own.
    this.log('info', 'startup warm-up complete');
  }

  stop() {
    for (const [, s] of this.streams) {
      try {
        s.kill();
      } catch {
        /* ignore */
      }
    }
    this.streams.clear();
    for (const t of this.timers) clearInterval(t);
    clearInterval(this.tickTimer);
    clearInterval(this.autoTimer);
    clearInterval(this.envTimer);
    clearInterval(this.pruneTimer);
    clearTimeout(this.startupTimer);
    this.stopRateSampler();
    this.stopTopApps();
    this._latCache = null;
    this.store.flushSync();
    killAll();
  }

  setPaused(paused) {
    this.paused = paused;
    if (paused) {
      this.stopRateSampler();
      this.stopTopApps();
      for (const [, s] of this.streams) {
        try {
          s.kill();
        } catch {
          /* ignore */
        }
      }
      this.streams.clear();
    } else {
      this.syncStreams();
      this.startRateSampler();
      this.startTopApps();
    }
    this.log('info', paused ? 'sampling paused' : 'sampling resumed');
    this.emit('dirty');
  }

  /* ------------------------------------------------------------------ latency */

  activeTargets() {
    const list = this.settings.targets.filter((t) => t.enabled).map((t) => ({
      host: t.host,
      label: t.label || t.host,
      color: t.color,
    }));
    if (this.settings.gateway.enabled && this.gatewayHost()) {
      list.unshift({
        host: this.gatewayHost(),
        label: this.settings.gateway.label || 'Gateway',
        color: this.settings.gateway.color || '#34d399',
      });
    }
    return list;
  }

  gatewayHost() {
    if (this.settings.gateway.host) return this.settings.gateway.host;
    const gw = this.link && this.link.ip && this.link.ip.gateways && this.link.ip.gateways[0];
    return gw || null;
  }

  /* Watchdog for the long-lived ping streams: if one dies (network change,
     adapter reset, sleep/resume) the monitor must recover on its own instead of
     going silent. syncStreams() is idempotent, so this is cheap. */
  syncTimers() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [
      setInterval(() => {
        if (this.paused) return;
        try {
          const want = this.desiredStreams();
          const missing = [...want.keys()].some((k) => !this.streams.has(k));
          if (missing || this.streams.size !== want.size) this.syncStreams();
        } catch (e) {
          this.log('warn', `stream watchdog: ${e.message}`);
        }
      }, 20_000),
    ];
  }

  /**
   * Windows `ping -t` emits exactly one reply per second, so an interval below
   * 1 s can only be met by running several staggered samplers per host. This is
   * the fan-out; desiredStreams() is the resulting process plan.
   */
  laneCount() {
    const interval = Math.max(200, this.settings.latencyIntervalMs || 1000);
    if (interval >= 900) return 1;
    return Math.max(2, Math.min(5, Math.round(1000 / interval)));
  }

  desiredStreams() {
    const lanes = this.laneCount();
    const out = new Map();
    for (const t of this.activeTargets()) {
      for (let lane = 0; lane < lanes; lane += 1) out.set(`${t.host}#${lane}`, { host: t.host, lane });
    }
    return out;
  }

  syncStreams() {
    if (this.paused) return;
    const want = this.desiredStreams();
    for (const [key, s] of this.streams) {
      if (!want.has(key)) {
        try {
          s.kill();
        } catch {
          /* ignore */
        }
        this.streams.delete(key);
      }
    }
    // Lane 0 starts now, lane N starts N intervals later, so the 1 Hz replies of
    // each process land evenly spaced instead of arriving in a burst.
    const interval = Math.max(200, this.settings.latencyIntervalMs || 1000);
    for (const [key, { host, lane }] of want) {
      if (this.streams.has(key)) continue;
      const start = () => {
        if (this.paused || !this.desiredStreams().has(key)) return;
        const stream = startLatencyStream(host, { timeoutMs: this.settings.latencyTimeoutMs }, (s) => this.pushSample(host, s), () => {
          this.streams.delete(key);
          if (!this.paused) setTimeout(() => this.syncStreams(), 1500);
        });
        this.streams.set(key, stream);
      };
      if (lane === 0) start();
      else {
        const t = setTimeout(start, lane * interval);
        if (t.unref) t.unref();
      }
    }
  }

  /* --------------------------------------------------------------- link rate */

  startRateSampler() {
    if (this.rateSampler || this.paused) return;
    this.rateSampler = createLinkRateSampler({
      samples: 3,
      getPreferredAdapter: () => (this.link && this.link.primary && (this.link.primary.description || this.link.primary.name)) || null,
      onRate: (r) => this.onLinkRate(r),
    });
  }

  stopRateSampler() {
    if (!this.rateSampler) return;
    this.rateSampler.stop();
    this.rateSampler = null;
  }

  startTopApps() {
    if (this.topAppsSampler || this.paused) return;
    this.topAppsSampler = startTopAppsSampler({
      intervalSec: 2,
      onSample: (sample) => {
        // Integrate the rate between samples so each row can also answer "how
        // much has it moved in this session", not just "how fast right now".
        const prevAt = this.topApps && this.topApps.at;
        const dt = prevAt ? Math.min(30, Math.max(0, (sample.at - prevAt) / 1000)) : 0;
        if (dt > 0) {
          for (const r of sample.rows) {
            this.appMb.set(r.name, (this.appMb.get(r.name) || 0) + r.mbs * dt);
          }
        }
        this.topApps = {
          ...sample,
          rows: sample.rows.map((r) => ({ ...r, totalMb: Math.round(this.appMb.get(r.name) || 0) })),
        };
        this.emit('dirty');
      },
    });
  }

  stopTopApps() {
    if (!this.topAppsSampler) return;
    this.topAppsSampler.stop();
    this.topAppsSampler = null;
  }

  /**
   * A latency reading taken while the link is saturated is not the same number
   * as an idle one. Mark it, so the UI can say "under load" instead of showing
   * a healthy 2 ms next to a link that is actually pinned at 100 %.
   */
  onLinkRate(r) {
    const plan = this.settings.planDownMbps || 0;
    const utilPct = plan > 0 ? Math.round((r.downMbps / plan) * 100) : null;
    const underLoad = r.downMbps >= 1 && (utilPct != null ? utilPct >= 45 : r.downMbps >= 25);
    this.linkRate = { ...r, utilPct, underLoad };
    this.emit('dirty');
  }

  /** Anything that changes what a snapshot would contain calls this. */
  invalidate() {
    this._latCache = null;
    this.emit('dirty');
  }

  pushSample(host, sample) {
    if (!this.rings.has(host)) this.rings.set(host, []);
    const ring = this.rings.get(host);
    const interval = Math.max(200, this.settings.latencyIntervalMs || 1000);
    const lastAt = this._lastSampleAt.get(host) || 0;
    // Staggered lanes land one interval apart; anything closer than half an
    // interval is duplicate output from one ping process and is dropped.
    if (!sample.synthetic && sample.t - lastAt < interval * 0.45) return;
    this._lastSampleAt.set(host, sample.t);
    ring.push({ t: sample.t, rtt: sample.rtt, status: sample.status });
    if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
    this._latCache = null;
    this.store.appendSample('latency', { host, rtt: sample.rtt, status: sample.status });
    this.evaluateLatencyRules(host, sample);
    // Pushing exactly when data lands is what makes the UI read as live; the
    // window coalesces bursts, so this never turns into a flood.
    this.emit('dirty');
  }

  /**
   * Windowed series + stats, memoised. Every consumer (chart, hero readout,
   * quality score) reads the same object instead of re-filtering the rings.
   * The one-second bucket keeps a sliding window sliding even when no sample
   * arrives (e.g. every target timing out).
   */
  latencySnapshot() {
    const bucket = Math.floor(Date.now() / 1000);
    if (this._latCache && this._latCache.bucket === bucket) return this._latCache.data;
    const windowSec = this.settings.chartWindowSec;
    const since = Date.now() - windowSec * 1000;
    const targets = this.activeTargets().map((t) => {
      const ring = this.rings.get(t.host) || [];
      const windowed = ring.filter((s) => s.t >= since);
      const stat = rollup(windowed);
      return {
        ...t,
        samples: windowed.map((s) => [s.t, s.rtt, s.status === 'ok' ? 0 : 1]),
        stats: stat,
        recent: ring.slice(-2),
      };
    });
    const data = { windowSec, targets };
    this._latCache = { bucket, data };
    return data;
  }

  /* -------------------------------------------------------------------- ticks */

  tick() {
    // CPU used by this process over the last tick - shown so the monitor never
    // silently becomes the thing that slows the link down.
    const now = process.cpuUsage();
    const dUser = now.user - this.cpuLast.user;
    const dSys = now.system - this.cpuLast.system;
    this.cpuPct = Math.round(((dUser + dSys) / 1000 / 250) * 1000) / 10;
    this.cpuLast = now;
    if (this.paused) return;
    this.emit('tick');
  }

  maybeAutoTest() {
    const mins = this.settings.autoSpeedTestMinutes;
    if (!mins || mins <= 0 || this.busy) return;
    const last = this.lastTests.down && this.lastTests.down.finishedAt;
    if (!last || Date.now() - last > mins * 60_000) {
      this.runSpeedTest({ reason: 'auto' }).catch(() => {});
    }
  }

  /* --------------------------------------------------------------- throughput */

  /** Live "n of N streams, X Mbps so far" reporter for a running test. */
  streamProgress(direction, streams) {
    const started = Date.now();
    let done = 0;
    let bytes = 0;
    return (i, r) => {
      done += 1;
      bytes += (r && r.size) || 0;
      const sec = Math.max(0.15, (Date.now() - started) / 1000);
      this.emit('test:progress', {
        direction,
        streamsDone: done,
        streams,
        mbps: Math.round(((bytes * 8) / sec / 1e6) * 10) / 10,
      });
    };
  }

  async runSpeedTest({ bytes, streams, upBytes, reason = 'manual', direction = 'both' } = {}) {
    return this.exclusive(async () => {
      // Cloudflare rate-limits repeated bursts; keep a minimum gap between
      // bandwidth tests so a rapid clicking user cannot poison their own data.
      const gap = 12_000;
      const since = Date.now() - (this.lastBandwidthAt || 0);
      if (since < gap) await new Promise((r) => setTimeout(r, gap - since));
      this.lastBandwidthAt = Date.now();

      const size = bytes || this.settings.testSizeBytes;
      const st = streams || this.settings.downStreams;
      const out = { reason, at: Date.now() };
      if (direction !== 'up') {
        this.emit('test:phase', { phase: 'download', streams: st, bytes: size });
        const down = await downloadTest({
          bytes: size,
          streams: st,
          onProgress: (p) => this.emit('test:progress', { direction: 'down', p }),
          onStreamDone: this.streamProgress('down', st),
        });
        down.finishedAt = Date.now();
        this.lastBandwidthAt = down.finishedAt;
        if (down.rateLimited && down.mbps === 0) {
          // Keep the last good measurement visible rather than flashing a fake 0.
          this.log('warn', `download rate-limited by the endpoint (HTTP ${down.httpCodes.join(',')}) — kept previous result`, { code: 'rate-limited' });
        } else {
          this.lastTests.down = { ...down, at: down.finishedAt, bytes: size, streamsRequested: st };
          this.store.appendSample('throughput', { direction: 'down', ...down });
          this.evaluateThroughputRules('down', down);
          this.log('info', `download test: ${down.mbps} Mbps (${down.streams} stream${down.streams === 1 ? '' : 's'}, spread ${down.spreadPct}%)`, {
            code: down.status === 'ok' ? undefined : 'partial',
          });
        }
        out.down = down;
      }
      if (direction !== 'down') {
        const upSize = upBytes || this.settings.uploadSizeBytes;
        this.emit('test:phase', { phase: 'upload', streams: this.settings.upStreams, bytes: upSize });
        const up = await uploadTest({
          bytes: upSize,
          streams: this.settings.upStreams,
          onProgress: (p) => this.emit('test:progress', { direction: 'up', p }),
          onStreamDone: this.streamProgress('up', this.settings.upStreams),
        });
        up.finishedAt = Date.now();
        this.lastBandwidthAt = up.finishedAt;
        if (up.rateLimited && up.mbps === 0) {
          this.log('warn', `upload rate-limited by the endpoint (HTTP ${up.httpCodes.join(',')})`, { code: 'rate-limited' });
        } else {
          this.lastTests.up = { ...up, at: up.finishedAt, streamsRequested: this.settings.upStreams };
          this.store.appendSample('throughput', { direction: 'up', ...up });
          this.evaluateThroughputRules('up', up);
          this.log('info', `upload test: ${up.mbps} Mbps (${up.streams} stream${up.streams === 1 ? '' : 's'})`);
        }
        out.up = up;
      }
      this.emit('test:phase', { phase: 'idle' });
      this.emit('test:done', out);
      return out;
    });
  }

  async runRamp({ maxStreams, bytes, direction = 'down' } = {}) {
    return this.exclusive(async () => {
      const gap = 12_000;
      const since = Date.now() - (this.lastBandwidthAt || 0);
      if (since < gap) await new Promise((r) => setTimeout(r, gap - since));
      this.lastBandwidthAt = Date.now();
      const res = await rampTest({
        maxStreams: maxStreams || this.settings.rampMaxStreams,
        bytesPerStream: bytes || Math.max(10_000_000, Math.round(this.settings.testSizeBytes / 3)),
        direction,
        onStep: (s) => this.emit('ramp:step', s),
      });
      res.finishedAt = Date.now();
      this.lastBandwidthAt = res.finishedAt;
      this.lastTests.ramp = res;
      this.store.appendSample('ramp', res);
      this.log('info', `stream ramp: ${res.singleStreamMbps} -> ${res.peakMbps} Mbps at ${res.peakStreams} streams (${res.scalingGainPct}% gain)`);
      return res;
    });
  }

  async runBufferbloat(opts = {}) {
    return this.exclusive(async () => {
      const gap = 12_000;
      const since = Date.now() - (this.lastBandwidthAt || 0);
      if (since < gap) await new Promise((r) => setTimeout(r, gap - since));
      this.lastBandwidthAt = Date.now();
      const res = await bufferbloatTest({
        host: opts.host || (this.settings.targets[0] && this.settings.targets[0].host) || '1.1.1.1',
        streams: opts.streams || this.settings.bbStreams,
        bytesPerStream: opts.bytesPerStream || this.settings.bbBytesPerStream,
        sampleMs: opts.sampleMs || this.settings.bbSampleMs,
        onPhase: (phase) => this.emit('bb:phase', { phase }),
      });
      res.finishedAt = Date.now();
      this.lastBandwidthAt = res.finishedAt;
      this.lastTests.bufferbloat = res;
      this.store.appendSample('bufferbloat', res);
      this.log('info', `bufferbloat: +${res.deltaMs} ms under load (${res.grade})`);
      return res;
    });
  }

  /* ------------------------------------------------------------- environment */

  async refreshEnvironment({ quiet = false } = {}) {
    try {
      const link = await linkSnapshot({});
      const prevIface = this.link && this.link.interface;
      this.link = link;
      this.emit('env', { link });
      if (link.primary && link.primary.linkBottleneck) {
        if (!this._linkWarned || this._linkWarned !== link.primary.linkSpeed) {
          this._linkWarned = link.primary.linkSpeed;
          this.log('warn', `${link.primary.name} negotiated ${link.primary.linkSpeed} on Gigabit hardware - check the cable/port`, { code: 'link-negotiation' });
        }
      }
      if (prevIface && link.interface && prevIface !== link.interface) {
        this.log('info', `primary interface changed: ${prevIface} -> ${link.interface}`);
        this.mtu = null;
      }
      if (!quiet) this.syncStreams();
    } catch (e) {
      if (!quiet) this.log('error', `link probe failed: ${e.message}`);
    }
    // MTU + ISP are slower; refresh them on every 5th environment pass or first run.
    this.envPasses = (this.envPasses || 0) + 1;
    if (this.envPasses % 5 === 1 || !this.mtu) {
      const before = this.mtu && this.mtu.verdict;
      mtuReport({ ifaceName: this.link && this.link.interface })
        .then((r) => {
          this.mtu = r;
          this.emit('env', { mtu: r });
          if (before && before !== r.verdict) this.log('warn', `MTU verdict changed: ${before} -> ${r.verdict}`);
          if (this.envPasses % 5 === 1) this.store.appendSample('mtu', { pathMtu: r.pathMtu, liveMtu: r.liveMtu, verdict: r.verdict });
        })
        .catch(() => {});
      if (!this.isp) {
        ispIdentity()
          .then((r) => {
            this.isp = r;
            this.emit('env', { isp: r });
          })
          .catch(() => {});
        ipv6Check()
          .then((r) => {
            this.ipv6 = r;
            this.emit('env', { ipv6: r });
          })
          .catch(() => {});
      }
    }
    this.syncStreams();
  }

  async runDns() {
    this.emit('test:phase', { phase: 'dns' });
    const res = await benchResolvers({});
    this.dns = res;
    this.store.appendSample('dns', { fastest: res.fastest, rows: res.rows.map((r) => ({ label: r.label, avgMs: r.avgMs })) });
    this.emit('test:phase', { phase: 'idle' });
    this.log('info', `DNS bench: fastest ${res.fastest}`);
    return res;
  }

  async runMtu() {
    const r = await mtuReport({ ifaceName: this.link && this.link.interface });
    this.mtu = r;
    this.log(r.verdict === 'blackhole' ? 'warn' : 'info', `MTU audit: ${r.verdict} (adapter ${r.liveMtu}, path ${r.pathMtu})`);
    return r;
  }

  async runLatencySweep({ count = 12 } = {}) {
    const hosts = this.activeTargets().map((t) => t.host);
    const out = [];
    for (const h of hosts) {
      // eslint-disable-next-line no-await-in-loop
      const r = await pingOnce(h, { count, timeoutMs: this.settings.latencyTimeoutMs });
      out.push({
        host: h,
        avg: r.avg == null ? null : Math.round(r.avg * 100) / 100,
        min: r.min,
        max: r.max,
        p50: r.p50,
        p95: r.p95,
        lossPct: r.lossPct,
        jitter: jitterStats(r.rtts),
        rtts: r.rtts,
      });
    }
    return out;
  }

  /* ------------------------------------------------------------------- rules */

  evaluateLatencyRules(host, sample) {
    const key = `rtt:${host}`;
    const state = (this._ruleState = this._ruleState || {});
    if (sample.status === 'ok' && sample.rtt != null && sample.rtt > this.settings.alertRttMs) {
      state[key] = (state[key] || 0) + 1;
      if (state[key] === 5) {
        this.log('warn', `${host} latency ${sample.rtt} ms is above the ${this.settings.alertRttMs} ms threshold`, { code: 'rtt-high', host });
      }
    } else if (state[key]) {
      state[key] = 0;
    }
  }

  evaluateThroughputRules(direction, res) {
    const floor = this.settings.alertDownFloorMbps;
    if (direction === 'down' && res.mbps < floor) {
      this.log('warn', `download ${res.mbps} Mbps is below the ${floor} Mbps floor`, { code: 'speed-floor' });
    }
    const prev = this._prevSpeed && this._prevSpeed[direction];
    if (prev && prev > 10 && Math.abs(res.mbps - prev) / prev > 0.3) {
      this.log('info', `${direction} speed moved ${prev} -> ${res.mbps} Mbps`);
    }
    this._prevSpeed = { ...(this._prevSpeed || {}), [direction]: res.mbps };
  }

  log(level, msg, extra = {}) {
    const ev = this.store.appendEvent({ level, msg, ...extra });
    this.events.push(ev);
    if (this.events.length > 200) this.events = this.events.slice(-200);
    this.emit('event', ev);
    return ev;
  }

  /* ------------------------------------------------------------------ output */

  quality(lat = null) {
    const view = lat || this.latencySnapshot();
    const first = view.targets.find((t) => t.label !== 'Gateway') || view.targets[0];
    const bestDns = this.dns && this.dns.rows.filter((r) => r.avgMs != null).sort((a, b) => a.avgMs - b.avgMs)[0];
    return qualityScore({
      latency: {
        avg: first && first.stats ? first.stats.avg : null,
        lossPct: first && first.stats ? first.stats.lossPct : null,
        jitter: first && first.stats ? first.stats.jitter : null,
      },
      bufferbloat: this.lastTests.bufferbloat
        ? { deltaMs: Math.max(0, this.lastTests.bufferbloat.deltaMs || 0), grade: this.lastTests.bufferbloat.grade }
        : null,
      dns: bestDns ? { avgMs: bestDns.avgMs } : null,
      download: this.lastTests.down ? { mbps: this.lastTests.down.mbps } : null,
      upload: this.lastTests.up ? { mbps: this.lastTests.up.mbps } : null,
      plan: { down: this.settings.planDownMbps, up: this.settings.planUpMbps },
    });
  }

  snapshot() {
    const latency = this.latencySnapshot();
    return {
      at: Date.now(),
      settings: this.settings,
      latency,
      lastTests: this.lastTests,
      link: this.link,
      mtu: this.mtu,
      dns: this.dns,
      isp: this.isp,
      ipv6: this.ipv6,
      quality: this.quality(latency),
      linkRate: this.linkRate,
      topApps: this.topApps,
      events: this.events.slice(-80),
      overhead: {
        cpuPct: this.cpuPct,
        children: childCount(),
        uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
        busy: this.busy,
        inFlight: this.inFlight,
        paused: this.paused,
        memMB: Math.round(process.memoryUsage().rss / 1048576),
      },
    };
  }

  /** Serialise bandwidth-consuming work: contaminated numbers are worse than slow ones. */
  async exclusive(fn) {
    if (this.busy) throw new Error('a bandwidth test is already running');
    this.busy = true;
    try {
      const r = await fn();
      return r;
    } finally {
      this.busy = false;
      this.emit('test:idle');
      this.emit('dirty');
    }
  }
}

module.exports = { Scheduler, RING_CAP };
