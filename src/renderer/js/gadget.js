'use strict';
/* Gadget controller: the live graph, the legend, the micro strip, the hover
   readout and the window interactions for the mini window.

   Design contract
   ---------------
   - One graph, every series overlapping, on ONE transparent canvas. Series are
     distinguished by hue AND dash pattern AND legend label, so the chart still
     reads without colour vision.
   - Nothing here restarts a probe. The graph is fed from the ring buffers the
     rest of the app already fills (NP.state.linkRate, latency windowed samples),
     so entering the gadget costs no measurement.
   - No second snapshot subscription: values arrive on the same np:snapshot event
     the dashboard uses, so the numbers in the gadget and the dashboard can never
     disagree.
   - The rAF loop runs only while the gadget is on screen and the window is
     visible: a 460 px widget must not burn CPU behind a minimised window. */
(function () {
  const NP = (window.NP = window.NP || {});
  const api = window.netpulse;
  if (!api) return;
  const { text } = NP;
  const $$ = (id) => document.getElementById(id);

  /* ---------------------------------------------------------------- series */
  /* axis: which scale the series is plotted against. ref: line colour name. */
  const SERIES = [
    { key: 'down', label: 'DOWN', varName: '--series-down', fallback: '#4dd4ff', axis: 'left', fill: true, dash: null, unit: 'Mbps', digits: 1 },
    { key: 'up', label: 'UP', varName: '--series-up', fallback: '#34d399', axis: 'left', fill: true, dash: null, unit: 'Mbps', digits: 1 },
    { key: 'lat', label: 'LAT', varName: '--series-lat', fallback: '#a78bfa', axis: 'right', fill: false, dash: [2, 3], unit: 'ms', digits: 1 },
    { key: 'jit', label: 'JIT', varName: '--series-jit', fallback: '#fbbf24', axis: 'right', fill: false, dash: [1, 2.5], unit: 'ms', digits: 1 },
  ];
  const SIZES = ['compact', 'standard', 'expanded'];

  const el = {
    root: $$('gadget'),
    graph: $$('g-graph'),
    canvas: $$('g-pulse'),
    legend: $$('g-legend'),
    readout: $$('g-readout'),
    tip: $$('g-tip'),
    pill: $$('g-state'),
    strip: $$('g-strip'),
    jitCell: null,
    size: $$('g-size'),
    pin: $$('g-pin'),
    quality: $$('g-quality'),
    ring: $$('g-ring'),
    dns: $$('g-dns'),
    bloat: $$('g-bloat'),
    util: $$('g-util'),
    peak: $$('g-peak'),
    top: $$('g-top'),
    jit: $$('g-jit'),
    jitSub: $$('g-jit-sub'),
    downCell: $$('g-cell-down'),
    upCell: $$('g-cell-up'),
  };

  const state = {
    on: false,
    snap: null,
    settingsSig: '',
    series: [],            // as handed to the chart, rebuilt per snapshot
    hidden: new Set(),
    hoverT: null,
    jitRing: [],           // [t, |Δrtt|] — the app's own jitter definition
    lastLatT: null,
    lastLatV: null,
    loadFrom: null,        // start of the current/last saturated stretch
    loadTo: null,
    peakDown: null,
    raf: null,
    lastFrame: 0,
    lastMotion: null,
  };

  let chart = null;

  /* ------------------------------------------------------------ formatting */
  const fmtMbps = (v) => (v == null ? '—' : v >= 100 ? String(Math.round(v)) : v.toFixed(1));
  const fmtMs = (v) => (v == null ? '—' : `${v.toFixed(1)}`);

  /* -------------------------------------------------------------- settings */
  function syncFromSettings(s) {
    const size = SIZES.includes(s && s.gadgetSize) ? s.gadgetSize : 'standard';
    if (el.root.dataset.size !== size) el.root.dataset.size = size;
    const wanted = Array.isArray(s && s.gadgetSeries) ? s.gadgetSeries : SERIES.map((x) => x.key);
    // Hidden = known series the user switched off in the legend.
    state.hidden = new Set(SERIES.map((x) => x.key).filter((k) => !wanted.includes(k)));
    if (el.pin) el.pin.classList.toggle('on', Boolean(s && s.gadgetPin));
  }

  /* ------------------------------------------------------------------ legend */
  function buildLegend() {
    if (!el.legend) return;
    if (el.legend.children.length !== SERIES.length) {
      el.legend.innerHTML = '';
      for (const s of SERIES) {
        const chip = document.createElement('span');
        chip.className = 'g-lg' + (state.hidden.has(s.key) ? ' off' : '');
        chip.dataset.series = s.key;
        chip.dataset.dash = s.dash ? '1' : '0';
        chip.style.setProperty('--tone', `var(${s.varName})`);
        chip.title = `${s.label} (${s.unit}) — click to isolate`;
        chip.innerHTML = `<span class="sw"></span>${s.label} <b>—</b>`;
        chip.addEventListener('click', () => toggleSeries(s.key));
        el.legend.append(chip);
      }
    }
    paintLegendValues();
  }

  function toggleSeries(key) {
    if (state.hidden.has(key)) state.hidden.delete(key);
    else state.hidden.add(key);
    // The last visible series wins by being un-hideable: an empty graph is not a
    // useful state, and it looks like a bug rather than a choice.
    if (state.hidden.size >= SERIES.length) state.hidden.delete(key);
    api.setSettings({ gadgetSeries: SERIES.map((x) => x.key).filter((k) => !state.hidden.has(k)) });
    // Update the chips IN PLACE. Rebuilding the legend would detach the element the
    // user just clicked (and with it the hover/focus state), so the chip they see
    // would not be the chip that carries the new state.
    paintLegendValues();
    if (chart) chart.setHidden([...state.hidden]);
    markDirty();
  }

  function paintLegendValues() {
    if (!el.legend) return;
    const isMbps = Boolean(state.snap && state.snap.settings && state.snap.settings.gadgetUnit === 'mbps');
    const jit = jitterStats();
    for (const s of SERIES) {
      const chip = el.legend.querySelector(`.g-lg[data-series="${s.key}"]`);
      if (!chip) continue;
      const b = chip.querySelector('b');
      if (s.key === 'jit') {
        text(b, jit.mean != null ? jit.mean.toFixed(1) : '—');
      } else {
        const pts = (state.series.find((x) => x.key === s.key) || {}).points || [];
        let last = null;
        for (let i = pts.length - 1; i >= 0; i--) {
          if (pts[i][1] != null && pts[i][2] !== 1) { last = pts[i]; break; }
        }
        let val = '—';
        if (last && last[1] != null) {
          if (s.key === 'down' || s.key === 'up') {
            const v = isMbps ? last[1] : (last[1] / 8);
            val = fmtMbps(v);
          } else {
            val = last[1].toFixed(s.digits);
          }
        }
        text(b, val);
      }
      chip.classList.toggle('off', state.hidden.has(s.key));
    }
  }

  /* ------------------------------------------------------------------- data */
  /**
   * Build the series arrays the chart draws. Everything is a reference to an
   * existing buffer plus a thin derived series — no per-snapshot copying of the
   * link-rate ring, which is already capped at 600 points by the renderer.
   */
  function buildSeries(s) {
    const shared = NP.state || {};
    const ring = shared.linkRate || { down: [], up: [] };
    const targets = (s.latency && s.latency.targets) || [];
    const hero = targets.find((t) => t.label !== 'Gateway') || targets[0] || null;
    const latPts = (hero && hero.samples) || [];

    // Jitter is the mean absolute delta between consecutive probes — the app's own
    // definition — so a bufferbloat ramp does not get reported as jitter.
    if (latPts.length) {
      const newest = latPts[latPts.length - 1];
      if (newest[0] !== state.lastLatT) {
        if (state.lastLatV != null && newest[1] != null) {
          state.jitRing.push([newest[0], Math.abs(newest[1] - state.lastLatV)]);
          if (state.jitRing.length > 600) state.jitRing.splice(0, state.jitRing.length - 600);
        }
        if (newest[1] != null) { state.lastLatV = newest[1]; }
        state.lastLatT = newest[0];
      }
    }

    const points = {
      down: ring.down || [],
      up: ring.up || [],
      lat: latPts,
      jit: state.jitRing,
    };
    return SERIES.map((s2) => ({ ...s2, points: points[s2.key] || [] }));
  }

  /* The gadget shows the last 60 s: an always-on-top strip wants the recent edge,
     not the two-minute window the dashboard charts are tuned for. */
  function windowSec() { return 60; }

  /** Windowed mean of a [t, v] ring — used for the latency average readout. */
  function meanOf(pts) {
    let sum = 0;
    let n = 0;
    for (const p of pts) {
      if (p[1] == null) continue;
      sum += p[1];
      n++;
    }
    return n ? sum / n : null;
  }

  function jitterStats() {
    const d = state.jitRing.map((p) => p[1]).filter((v) => v != null);
    if (!d.length) return { mean: null, sd: null, p95: null };
    const mean = d.reduce((a, b) => a + b, 0) / d.length;
    const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length);
    const sorted = d.slice().sort((a, b) => a - b);
    return { mean, sd, p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] };
  }

  /* ------------------------------------------------------------------- strip */
  function paintStrip(s) {
    const lr = s.linkRate || {};
    const q = s.quality || {};
    if (el.quality) {
      text(el.quality, q.score == null ? '—' : `${q.score}${q.grade ? ` · ${q.grade}` : ''}`);
      const host = el.quality.closest('.g-chip');
      if (host) {
        host.dataset.tone = q.score == null ? '' : q.score >= 80 ? 'good' : q.score >= 60 ? 'warn' : 'bad';
        if (el.ring) {
          el.ring.style.setProperty('--p', String(q.score || 0));
          el.ring.style.setProperty('--ring', q.score >= 80 ? 'var(--ok)' : q.score >= 60 ? 'var(--warn)' : 'var(--bad)');
        }
      }
    }
    if (el.dns) {
      const rows = (s.dns && s.dns.rows) || [];
      const best = rows.filter((r) => r.avgMs != null).sort((a, b) => a.avgMs - b.avgMs)[0];
      text(el.dns, best ? `${best.avgMs.toFixed(1)} ms` : '—');
    }
    if (el.bloat) {
      const bb = s.lastTests && s.lastTests.bufferbloat;
      text(el.bloat, bb ? `+${Math.round(bb.deltaMs || 0)} ms · ${bb.grade}` : '—');
      const host = el.bloat.closest('.g-chip');
      if (host && bb) {
        host.dataset.tone = bb.grade === 'A' ? 'good' : bb.grade === 'B' ? 'warn' : 'bad';
      }
    }
    if (el.util) {
      const plan = (s.settings && s.settings.planDownMbps) || null;
      const util = lr.utilPct;
      text(el.util, util == null ? '—' : plan ? `${Math.min(util, 999)}% of plan` : `${util}%`);
      const host = el.util.closest('.g-chip');
      if (host) host.dataset.tone = util != null && util > 90 ? 'warn' : '';
    }
    if (el.peak) {
      const peak = lr.peakDownMbps != null ? lr.peakDownMbps : s.lastTests && s.lastTests.down ? s.lastTests.down.mbps : null;
      text(el.peak, peak == null ? '—' : `${fmtMbps(peak)} Mbps`);
    }
    if (el.top) {
      const rows = (s.topApps && (s.topApps.rows || s.topApps.apps || s.topApps.list)) || [];
      const first = rows[0] || null;
      const name = first ? String(first.name || first.app || first.proc || first.process || '').replace(/\.exe$/i, '') : '';
      text(el.top, name || '—');
    }
  }

  /* --------------------------------------------------------------- readouts */
  /* The three hero cells are written by app.js's updateGadget() — the single
     source of truth for those numbers, shared with the QA harness. This module
     only owns what the redesign added: the jitter tile, the state pill and the
     contextual hint line. */
  function paintReadouts(s) {
    const jit = jitterStats();
    if (el.jit) text(el.jit, jit.mean == null ? '—' : jit.mean.toFixed(1));
    if (el.jitSub) {
      text(el.jitSub, jit.mean == null ? 'waiting for sample' : `σ ${fmtMs(jit.sd)} · p95 ${fmtMs(jit.p95)}`);
    }
    const jitCell = el.jit && el.jit.closest('.g-jit');
    if (jitCell) jitCell.dataset.busy = jit.mean != null && jit.mean >= 1 ? '1' : '0';

    if (el.pill) {
      text(el.pill, s.overhead && s.overhead.paused ? 'paused' : s.overhead && s.overhead.busy ? 'testing' : (s.linkRate && s.linkRate.underLoad) ? 'busy' : 'live');
    }
    if (el.tip) {
      text(el.tip, s.linkRate && s.linkRate.underLoad
        ? 'link saturated — the latency trace is measured under load'
        : 'hover the graph for exact values · click a chip to isolate a series');
    }
  }

  /* ------------------------------------------------------------- saturation */
  function trackLoadBand(s) {
    const busy = Boolean(s.linkRate && s.linkRate.underLoad);
    const now = Date.now();
    if (busy) {
      if (state.loadFrom == null) state.loadFrom = now;
      state.loadTo = null;
    } else if (state.loadFrom != null && state.loadTo == null) {
      state.loadTo = now;
    }
    // Keep the band while any part of it is still inside the visible window, so a
    // bufferbloat stretch stays explained while the latency curve is still rising.
    const windowMs = state.snap && state.snap.settings && state.snap.settings.chartWindowSec
      ? state.snap.settings.chartWindowSec * 1000 : 60000;
    const end = state.loadTo || now;
    if (state.loadFrom == null || end - state.loadFrom < 1500 || end < now - windowMs) {
      if (!busy && state.loadTo) { state.loadFrom = null; state.loadTo = null; }
      return null;
    }
    // A real busy link is at least a second long; a one-sample flicker is noise.
    if (state.loadFrom != null && now - state.loadFrom < 1000) return null;
    return [state.loadFrom, end];
  }

  /* ------------------------------------------------------------------ paint */
  function markDirty() {
    if (chart) chart._dirty = true;
  }

  function feed(s) {
    state.snap = s;
    // Settings can change from the dashboard, the settings view or another
    // window, so the gadget follows the snapshot rather than only its own clicks.
    const sig = `${s.settings && s.settings.gadgetSize}|${s.settings && s.settings.gadgetPin}|${((s.settings && s.settings.gadgetSeries) || []).join(',')}`;
    if (sig !== state.settingsSig) {
      state.settingsSig = sig;
      syncFromSettings(s.settings || {});
      buildLegend();
    }
    state.series = buildSeries(s);
    // The gadget owns its own unit labels: the MB/s vs Mbps choice is a property of
    // this graph (its axis caption and its legend use the same unit), so the widget
    // applies it from the snapshot instead of depending on who else happens to paint.
    const isMbps = Boolean(s.settings && s.settings.gadgetUnit === 'mbps');
    text($$('g-down-u'), isMbps ? 'Mbps' : 'MB/s');
    text($$('g-up-u'), isMbps ? 'Mbps' : 'MB/s');
    if (chart) {
      chart.setSeries(state.series);
      chart.setHidden([...state.hidden]);
      chart.setLoadBand(trackLoadBand(s));
      markDirty();
    }
    paintLegendValues();
    paintStrip(s);
    paintReadouts(s);
    const shared = NP.state || {};
    const ring = shared.linkRate || {};
    const d = ring.down && ring.down.length ? ring.down[ring.down.length - 1][1] : null;
    const u = ring.up && ring.up.length ? ring.up[ring.up.length - 1][1] : null;
    if (el.downCell) el.downCell.dataset.busy = d != null && d >= 1 ? '1' : '0';
    if (el.upCell) el.upCell.dataset.busy = u != null && u >= 1 ? '1' : '0';
  }

  /* --------------------------------------------------------------- the loop */
  /* 30 Hz is deliberate: the traces at 1 Hz plus a gliding head do not need 60,
     and halving the repaint halves the gadget's share of the CPU budget. */
  function loop(ts) {
    state.raf = null;
    if (!state.on) return;
    if (document.hidden) return schedule();
    if (ts - state.lastFrame >= 30) {
      state.lastFrame = ts;
      const scale = NP.motionScale ? NP.motionScale() : 1;
      const motion = scale > 0 ? 'on' : 'off';
      if (motion !== state.lastMotion) {
        document.body.dataset.motion = motion;
        state.lastMotion = motion;
      }
      if (chart) {
        chart._dirty = true;      // the graph pans on wall-clock time, so it always has new pixels
        // A chart that throws must not kill the loop that keeps the window alive,
        // and the failure must be visible instead of silently blank.
        try {
          chart.draw();
        } catch (err) {
          window.__npGadgetErr = `${err && err.message}`;
          if (!state.drawErrorLogged) {
            state.drawErrorLogged = true;
            console.error('gadget graph draw failed:', err && err.message);
          }
        }
      }
    }
    schedule();
  }
  function schedule() {
    if (!state.on || state.raf) return;
    state.raf = requestAnimationFrame(loop);
  }
  function start() {
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = null;
    state.lastFrame = 0;
    schedule();
  }
  function stop() {
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = null;
    if (state.lastMotion !== 'off' && NP.motionScale && NP.motionScale() === 0) {
      document.body.dataset.motion = 'off';
      state.lastMotion = 'off';
    }
  }

  /* ---------------------------------------------------------------- hover */
  function onMove(ev) {
    if (!chart || !el.graph) return;
    const r = el.graph.getBoundingClientRect();
    const x = ev.clientX - r.left;
    chart.setHover(x);
    markDirty();
    const geom = chart.geom;
    if (!geom || !el.readout) return;
    const t = geom.tMin + ((Math.max(geom.x0, Math.min(x, geom.x1)) - geom.x0) / (geom.x1 - geom.x0)) * (geom.tMax - geom.tMin);
    const samples = chart.sampleAt(t);
    const rows = SERIES.filter((s) => !state.hidden.has(s.key) && samples[s.key]);
    if (!rows.length) { el.readout.hidden = true; return; }
    const secs = Math.round((t - geom.tMax) / 1000);
    const isMbps = Boolean(state.snap && state.snap.settings && state.snap.settings.gadgetUnit === 'mbps');
    el.readout.innerHTML = `<div class="t">${secs === 0 ? 'now' : `${secs}s ago`}</div>` +
      rows.map((s) => {
        const p = samples[s.key];
        let valStr = 'loss';
        if (!p.lost && p.v != null) {
          if (s.key === 'down' || s.key === 'up') {
            const v = isMbps ? p.v : (p.v / 8);
            valStr = `${v.toFixed(s.digits)} ${isMbps ? 'Mbps' : 'MB/s'}`;
          } else {
            valStr = `${p.v.toFixed(s.digits)} ${s.unit}`;
          }
        }
        return `<div class="r" style="--tone:var(${s.varName})"><span class="sw"></span>${s.label}` +
          `<b>${valStr}</b></div>`;
      }).join('');
    el.readout.hidden = false;
    // Flip the card before it runs off the right edge.
    const w = el.readout.offsetWidth || 96;
    const left = x + 10 + w > r.width ? Math.max(2, x - 10 - w) : x + 10;
    el.readout.style.left = `${left}px`;
    el.readout.style.top = '6px';
  }

  function onLeave() {
    if (chart) { chart.setHover(null); markDirty(); }
    if (el.readout) el.readout.hidden = true;
  }

  /* ------------------------------------------------------------ interactions */
  function cycleSize() {
    const cur = el.root.dataset.size || 'standard';
    const next = SIZES[(SIZES.indexOf(cur) + 1) % SIZES.length];
    el.root.dataset.size = next;
    api.setGadgetSize(next);
    if (chart) {
      chart._dirty = true;
      chart.range = { left: 0, right: 0 };  // re-fit the axis for the new box
    }
    NP.toast && NP.toast(`gadget: ${next}`);
  }

  function wire() {
    if (el.size) el.size.addEventListener('click', cycleSize);
    if (el.pin) {
      el.pin.addEventListener('click', () => {
        const on = !el.pin.classList.contains('on');
        el.pin.classList.toggle('on', on);
        api.setGadgetPin(on);
        NP.toast && NP.toast(on ? 'gadget pinned on top' : 'gadget no longer on top');
      });
    }
    if (el.graph) {
      el.graph.addEventListener('mousemove', onMove);
      el.graph.addEventListener('mouseleave', onLeave);
      el.graph.addEventListener('mouseenter', (e) => onMove(e));
    }
    document.addEventListener('keydown', (e) => {
      if (!state.on) return;
      const tag = (e.target && e.target.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
      if (e.key === 's' || e.key === ']') { e.preventDefault(); cycleSize(); }
      else if (e.key === 'p') { e.preventDefault(); el.pin && el.pin.click(); }
      else if (e.key === 'i') {
        e.preventDefault();
        // Isolate the busiest series and mute the rest in one keystroke.
        const busiest = SERIES.map((s) => ({ s, v: (state.series.find((x) => x.key === s.key) || {}).points }))
          .map(({ s, v }) => ({ s, last: v && v.length ? [...v].reverse().find((p) => p[1] != null) : null }))
          .filter((x) => x.last)
          .sort((a, b) => (b.last[1] || 0) - (a.last[1] || 0))[0];
        if (!busiest) return;
        const only = state.hidden.size === SERIES.length - 1 && !state.hidden.has(busiest.s.key);
        state.hidden = only ? new Set() : new Set(SERIES.map((x) => x.key).filter((k) => k !== busiest.s.key));
        api.setSettings({ gadgetSeries: SERIES.map((x) => x.key).filter((k) => !state.hidden.has(k)) });
        paintLegendValues();
        if (chart) chart.setHidden([...state.hidden]);
        markDirty();
      }
    });
  }

  /* ------------------------------------------------------------------- boot */
  function applyGadget(on) {
    const was = state.on;
    state.on = Boolean(on);
    if (state.on === was) {
      if (state.on) start();
      return;
    }
    if (state.on) {
      // The canvas was display:none while the dashboard was up: its ResizeObserver
      // entry is stale at this instant and the backing store is whatever the last
      // visible measurement was, so measure it explicitly instead of waiting for a
      // resize that may never come.
      if (NP.invalidateCharts) NP.invalidateCharts();
      const remeasure = () => { if (chart && state.on) chart.resize(); };
      remeasure();
      requestAnimationFrame(remeasure);
      setTimeout(remeasure, 120);
      if (chart) chart.range = { left: 0, right: 0 };
      start();
    } else {
      stop();
      onLeave();
    }
  }

  function boot() {
    if (!el.root || !el.canvas) return;
    chart = new NP.MultiPulse(el.canvas, { windowMs: windowSec() * 1000 });
    chart.setHidden([...state.hidden]);
    wire();

    // Every listener on 'np:snapshot' is an EventEmitter listener: if one throws,
    // the listeners registered after it NEVER RUN. app.js registers the dashboard
    // update on this same channel, so an exception thrown here would silently stop
    // the hero readouts and the unit toggle from ever repainting. Catch everything.
    api.on('np:snapshot', (s) => {
      if (!state.on || !s) return;
      // Same rule as the dashboard handler: an occluded window gets no paint work
      // at all (that is the app's whole performance contract), so the gadget must
      // not update its DOM while document.hidden is set — otherwise the widget and
      // the dashboard would disagree about which frame they are showing.
      if (document.hidden) return;
      try {
        feed(s);
      } catch (err) {
        window.__npGadgetFeedErr = `${err && err.message}`;
        if (!state.feedErrorLogged) {
          state.feedErrorLogged = true;
          console.error('gadget feed failed:', err && err.message);
        }
      }
    });
    api.on('np:gadget', (st) => applyGadget(st && st.gadget));
    api.on('np:test-progress', () => {
      if (!state.on || !NP.state || !NP.state.snap) return;
      if (document.hidden) return; // same paint contract as above
      try {
        feed(NP.state.snap);
      } catch (err) {
        window.__npGadgetFeedErr = `${err && err.message}`;
      }
    });

    // Entering the gadget from a fresh launch: pull one snapshot so the graph is
    // never blank while waiting for the next sample.
    if (document.body.dataset.gadget === '1') applyGadget(true);
    buildLegend();
  }

  NP.gadget = { boot, applyGadget, feed: (s) => state.on && feed(s), cycleSize, syncFromSettings, get chart() { return chart; }, get state() { return state; } };

  // Self-boot: this script sits at the end of the body, so the gadget DOM exists.
  // NP.state (the shared link-rate ring) is created by app.js, which loads after
  // this file — every read of it is lazy, so registration order does not matter.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
