'use strict';
/* Renderer bootstrap: state, IPC wiring, view routing, one rAF loop.
   Nothing here touches Node: everything goes through window.netpulse. */
(function () {
  const NP = (window.NP = window.NP || {});
  const { el, fmt, toast, text } = NP;
  const api = window.netpulse;

  const state = {
    snap: null,
    active: 'overview',
    instances: new Map(),
    history: { down: [], up: [] },
    // Live link-rate ring, fed once per snapshot regardless of which view is
    // open, so a chart is never empty when you switch to it mid-download.
    linkRate: { down: [], up: [] },
    lastFrame: performance.now(),
    fps: 0,
    frames: 0,
    fpsAt: performance.now(),
  };
  NP.state = state;

  const ctx = {
    runTest: async (kind, opts) => {
      const btns = [...document.querySelectorAll('button')];
      btns.forEach((b) => {
        if (/run|test|ramp|benchmark|sweep/i.test(b.textContent)) b.disabled = true;
      });
      try {
        const res = await api.runTest(kind, opts);
        if (res && res.error) toast(`${kind}: ${res.error}`, 'warn');
        else if (kind === 'speed') toast(`download ${res.down ? fmt.mbps(res.down.mbps) : '—'} / upload ${res.up ? fmt.mbps(res.up.mbps) : '—'} Mbps`);
        else if (kind === 'ramp') toast(`ceiling ${fmt.mbps(res.peakMbps)} Mbps at ${res.peakStreams} streams`);
        else if (kind === 'bufferbloat') toast(`bufferbloat +${fmt.ms(res.deltaMs, 1)} ms (${res.grade})`);
        else if (kind === 'dns') toast(`fastest resolver: ${res.fastest}`);
        else if (kind === 'mtu') toast(`MTU verdict: ${res.verdict}`);
        return res;
      } catch (e) {
        toast(`${kind} failed: ${e.message}`, 'error');
        return null;
      } finally {
        btns.forEach((b) => (b.disabled = false));
      }
    },
    setSettings: async (patch) => {
      const next = await api.setSettings(patch);
      if (state.snap) state.snap.settings = next;
      applySettings(next);
      if (patch && patch.theme && api.setTheme) api.setTheme(patch.theme);
      return next;
    },
    togglePause: async () => {
      const paused = !(state.snap && state.snap.overhead.paused);
      const s = await api.setPaused(paused);
      state.snap = s;
      document.getElementById('btn-pause').textContent = paused ? '▶' : '⏸';
      toast(paused ? 'sampling paused' : 'sampling resumed');
    },
    pushHistory: (dir, res) => {
      const arr = state.history[dir];
      if (arr.some((p) => p[0] === res.at)) return;
      arr.push([res.at, res.mbps, 0]);
      arr.sort((a, b) => a[0] - b[0]);
      if (arr.length > 300) arr.splice(0, arr.length - 300);
    },
    history: (dir) => state.history[dir],
    copy: (text) => api.copyText(text),
    applyMtu: () => api.applyMtuFix(),
    revertMtu: () => api.revertMtu(),
    exportReport: () => api.exportReport(),
    previewReport: async () => {
      const r = await api.previewReport();
      showModal('Report preview', r.markdown);
      return r;
    },
    dataStats: () => api.dataStats(),
    openPath: (p) => api.openPath(p),
    quit: () => api.windowAction('close'),
  };
  NP.ctx = ctx;

  /* -------------------------------------------------------------------- views */
  function viewFor(key) {
    if (!state.instances.has(key)) {
      const factory = NP.views[key] || NP.views.overview;
      const inst = factory(ctx);
      state.instances.set(key, inst);
    }
    return state.instances.get(key);
  }

  function switchView(key) {
    if (!NP.views[key]) key = 'overview';
    state.active = key;
    document.body.dataset.view = key;
    const root = document.getElementById('view-root');
    const inst = viewFor(key);
    root.replaceChildren(inst.node);
    if (state.snap && inst.update) inst.update(state.snap);
    if (NP.invalidateCharts) NP.invalidateCharts();
    [...document.querySelectorAll('[data-nav]')].forEach((b) => b.classList.toggle('active', b.dataset.nav === key));
    root.scrollTop = 0;
  }

  /* ---------------------------------------------------------------- HUD chips */
  const chipLink = document.getElementById('chip-link');
  const chipIsp = document.getElementById('chip-isp');
  const chipMtu = document.getElementById('chip-mtu');
  const chipRate = document.getElementById('chip-rate');
  const chipOverhead = document.getElementById('chip-overhead');
  const subtitle = document.getElementById('tb-subtitle');

  function updateHud(s) {
    const link = s.link && s.link.primary;
    text(chipLink, link ? `${link.name} · ${link.linkSpeed}` : '—');
    chipLink.style.color = link && link.linkBottleneck ? 'var(--warn)' : '';
    text(chipIsp, s.isp && s.isp.ok ? `${s.isp.ip} · ${(s.isp.org || '').replace(/^AS\d+\s*/, '')}` : '—');
    text(chipMtu, s.mtu ? `${s.mtu.liveMtu ?? '?'} live / ${s.mtu.pathMtu ?? '?'} path (${s.mtu.verdict})` : '...');
    chipMtu.style.color = s.mtu && s.mtu.verdict === 'blackhole' ? 'var(--bad)' : '';
    const q = s.quality;
    text(chipOverhead, `${q.score ?? '—'}/100 ${q.grade} · ${fmt.n(s.overhead.cpuPct, 1)}% cpu · ${s.overhead.children} procs`);
    // What the machine is actually moving right now, including traffic this app
    // did not generate (a browser in the background, a Windows update, a NAS).
    const lr = s.linkRate;
    if (lr && lr.downMbps != null) {
      text(chipRate, `\u2193 ${fmt.mbps(lr.downMbps)} \u00b7 \u2191 ${fmt.mbps(lr.upMbps)} Mbps`);
      chipRate.style.color = lr.underLoad ? 'var(--accent)' : '';
    } else {
      text(chipRate, '—');
    }
    // A stale plan setting must not turn into "busy 500 % of plan": above 200 %
    // the percentage is noise, so say it is over plan instead of printing it.
    const util = lr && lr.utilPct != null && lr.utilPct <= 200 ? ` ${lr.utilPct}%` : lr && lr.utilPct != null ? ' (over plan)' : '';
    const load = lr && lr.underLoad ? `link busy${util} · ` : '';
    text(subtitle, `${load}${s.link && s.link.interface ? s.link.interface : 'no interface'} · uptime ${fmt.dur(s.overhead.uptimeSec)} · ${s.overhead.paused ? 'paused' : 'sampling'}`);
  }

  /* ------------------------------------------------------------------ gadget */
  /* Same document, smaller window: entering gadget mode hides the dashboard and
     shows three readouts. No probe, chart or ring buffer is restarted. */
  const gadgetEl = document.getElementById('gadget');
  const gEls = {
    down: document.getElementById('g-down'),
    downSub: document.getElementById('g-down-sub'),
    downU: document.getElementById('g-down-u'),
    canvasDown: document.getElementById('g-spark-down'),
    up: document.getElementById('g-up'),
    upSub: document.getElementById('g-up-sub'),
    upU: document.getElementById('g-up-u'),
    canvasUp: document.getElementById('g-spark-up'),
    lat: document.getElementById('g-lat'),
    latSub: document.getElementById('g-lat-sub'),
    state: document.getElementById('g-state'),
    canvas: document.getElementById('g-spark'),
  };
  let gSpark = null;
  let gSparkDown = null;
  let gSparkUp = null;
  let gadgetOn = false;

  function accentColor() {
    return (getComputedStyle(document.body).getPropertyValue('--accent') || '#4dd4ff').trim() || '#4dd4ff';
  }
  function okColor() {
    return (getComputedStyle(document.body).getPropertyValue('--ok') || '#34d399').trim() || '#34d399';
  }

  function updateGadget(s) {
    if (!s || !gadgetOn) return;
    const lr = s.linkRate || {};
    const live = lr.downMbps != null;
    const downMbps = live ? lr.downMbps : null;
    const upMbps = live ? lr.upMbps : null;
    const downBusy = live && downMbps >= 0.5;
    const upBusy = live && upMbps >= 0.5;
    const isMbps = (s.settings && s.settings.gadgetUnit === 'mbps');
    text(gEls.downU, isMbps ? 'Mbps' : 'MB/s');
    text(gEls.upU, isMbps ? 'Mbps' : 'MB/s');

    // Reported in either MB/s or Mbps based on user toggle:
    const mbs = (mbps) => fmt.n(mbps / 8, mbps / 8 >= 100 ? 0 : 2);

    if (downMbps != null) {
      if (isMbps) {
        text(gEls.down, fmt.mbps(downMbps));
        text(gEls.downSub, `live · ${fmt.n(downMbps / 8, 2)} MB/s${lr.peakDownMbps ? ` · peak ${fmt.mbps(lr.peakDownMbps)}` : ''}`);
      } else {
        text(gEls.down, mbs(downMbps));
        text(gEls.downSub, `live · ${fmt.mbps(downMbps)} Mbps${lr.peakDownMbps ? ` · peak ${fmt.mbps(lr.peakDownMbps)}` : ''}`);
      }
    } else {
      text(gEls.down, '—');
      text(gEls.downSub, 'sampling adapter…');
    }

    if (upMbps != null) {
      if (isMbps) {
        text(gEls.up, fmt.mbps(upMbps));
        text(gEls.upSub, `live · ${fmt.n(upMbps / 8, 2)} MB/s${lr.peakUpMbps ? ` · peak ${fmt.mbps(lr.peakUpMbps)}` : ''}`);
      } else {
        text(gEls.up, mbs(upMbps));
        text(gEls.upSub, `live · ${fmt.mbps(upMbps)} Mbps${lr.peakUpMbps ? ` · peak ${fmt.mbps(lr.peakUpMbps)}` : ''}`);
      }
    } else {
      text(gEls.up, '—');
      text(gEls.upSub, 'sampling adapter…');
    }

    const cells = gadgetEl ? gadgetEl.querySelectorAll('.g-cell') : [];
    if (cells.length >= 2) {
      cells[0].dataset.busy = downBusy ? '1' : '0';
      cells[1].dataset.busy = upBusy ? '1' : '0';
    }

    const targets = (s.latency && s.latency.targets) || [];
    const hero = targets.find((t) => t.label !== 'Gateway') || targets[0];
    const st = hero && hero.stats;
    // The freshest probe, not the window average: a live latency readout that
    // averages away a 200 ms spike is the one number a monitor must not smooth.
    const recent = hero && hero.recent && hero.recent.length ? hero.recent[hero.recent.length - 1] : null;
    const current = recent && recent.rtt != null ? recent.rtt : st ? st.avg : null;
    text(gEls.lat, current != null ? fmt.ms(current, 1) : '—');
    const bits = [];
    // A latency sample taken while the line is saturated is not an idle sample.
    if (lr.underLoad) bits.push('under load');
    if (st && st.avg != null) bits.push(`avg ${fmt.ms(st.avg, 1)}`);
    // stats.jitter is the {meanDelta, stddev} pair, not a number.
    const jit = st && st.jitter ? (st.jitter.meanDelta ?? st.jitter.stddev) : null;
    if (jit != null) bits.push(`jit ${fmt.ms(jit, 1)}`);
    if (st && st.lossPct) bits.push(`${fmt.n(st.lossPct, 1)}% loss`);
    if (!lr.underLoad && hero && hero.label) bits.push(hero.label);
    text(gEls.latSub, bits.join(' · ') || 'waiting for sample');
    text(gEls.state, s.overhead.paused ? 'paused' : s.overhead.busy ? 'testing' : lr.underLoad ? 'busy' : 'live');
    document.body.dataset.paused = s.overhead.paused ? '1' : '0';

    if (gEls.canvasDown) {
      if (!gSparkDown) gSparkDown = new NP.Sparkline(gEls.canvasDown, { color: accentColor(), zeroBaseline: true });
      const pts = (state.linkRate.down || []).slice(-60).map((p) => [p[0], p[1] / 8]);
      gSparkDown.setPoints(pts, accentColor());
      gSparkDown.draw();
    }

    if (gEls.canvasUp) {
      if (!gSparkUp) gSparkUp = new NP.Sparkline(gEls.canvasUp, { color: okColor(), zeroBaseline: true });
      const pts = (state.linkRate.up || []).slice(-60).map((p) => [p[0], p[1] / 8]);
      gSparkUp.setPoints(pts, okColor());
      gSparkUp.draw();
    }

    if (gEls.canvas) {
      if (!gSpark) gSpark = new NP.Sparkline(gEls.canvas, { color: accentColor() });
      const pts = ((hero && hero.samples) || []).slice(-90).map((p) => [p[0], p[1]]);
      gSpark.setPoints(pts, accentColor());
      gSpark.draw();
    }
  }

  function applyGadget(on) {
    gadgetOn = Boolean(on);
    document.body.dataset.gadget = gadgetOn ? '1' : '0';
    if (gadgetEl) gadgetEl.hidden = !gadgetOn;
    const btn = document.getElementById('btn-gadget');
    if (btn) btn.classList.toggle('active', gadgetOn);
    if (gadgetOn) {
      // The canvas only has a size once the gadget is laid out.
      requestAnimationFrame(() => {
        if (gSpark) gSpark._dirty = true;
        if (gSparkDown) gSparkDown._dirty = true;
        if (gSparkUp) gSparkUp._dirty = true;
        updateGadget(state.snap);
      });
    }
  }

  /* ------------------------------------------------------------------- modal */
  const modal = document.getElementById('modal');
  const modalBody = document.getElementById('modal-body');
  const modalTitle = document.getElementById('modal-title');
  let lastReportFile = null;

  function showModal(title, body) {
    modalTitle.textContent = title;
    modalBody.textContent = body;
    modal.hidden = false;
  }
  document.getElementById('modal-close').onclick = () => (modal.hidden = true);
  document.getElementById('modal-copy').onclick = async () => {
    await api.copyText(modalBody.textContent);
    toast('copied to clipboard');
  };
  document.getElementById('modal-save').onclick = async () => {
    const r = await api.exportReport();
    lastReportFile = r.file;
    modalBody.textContent = r.markdown;
    toast(`saved ${r.file.split(/[\\/]/).pop()}`);
  };
  document.getElementById('modal-open').onclick = async () => {
    const st = await api.dataStats();
    await api.openPath(st.reportsDir || st.dir);
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') modal.hidden = true;
    if (e.key === '1') switchView('overview');
    if (e.key === '2') switchView('throughput');
    if (e.key === '3') switchView('latency');
    if (e.key === '4') switchView('diagnostics');
    if (e.key === '5') switchView('settings');
    if (e.key.toLowerCase() === 'g' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      api.setGadget(document.body.dataset.gadget !== '1');
    }
  });

  /* ------------------------------------------------------------- settings app */
  function applySettings(s) {
    if (!s) return;
    const theme = s.theme === 'light' ? 'light' : s.theme === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : 'dark';
    document.body.dataset.theme = theme;
    document.body.dataset.themeMode = s.theme || 'dark';
    document.body.dataset.accent = s.accent || 'cyan';
    document.body.dataset.density = s.density || 'comfortable';
    document.body.dataset.anim = String(Math.round((s.animationIntensity ?? 70) / 10));
    NP.motion.intensity = (s.animationIntensity ?? 70) / 100;
    NP.motion.reduced = Boolean(s.reducedMotion) || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Canvas ink is read from CSS variables at draw time, so a theme flip has to
    // force one repaint or the charts keep the previous palette.
    if (NP.invalidateCharts) NP.invalidateCharts();
    // Charts cache colours at draw time; nudge them so a theme/accent flip is
    // visible immediately instead of on the next data tick.
    if (state.snap) {
      const inst = state.instances.get(state.active);
      if (inst && inst.update) inst.update(state.snap, true);
    }
  }

  /* ------------------------------------------------------------- main loop */
  function loop(now) {
    const dt = Math.min(80, now - state.lastFrame);
    state.lastFrame = now;
    state.frames += 1;
    if (now - state.fpsAt > 1000) {
      state.fps = Math.round((state.frames * 1000) / (now - state.fpsAt));
      state.frames = 0;
      state.fpsAt = now;
    }
    const inst = state.instances.get(state.active);
    if (inst && inst.frame) {
      try {
        inst.frame(dt);
      } catch (e) {
        if (!state._frameErr || Date.now() - state._frameErr > 5000) {
          state._frameErr = Date.now();
          toast(`render error: ${e.message}`, 'error');
        }
      }
    }
    if (gadgetOn) {
      if (gSparkDown) gSparkDown.draw();
      if (gSparkUp) gSparkUp.draw();
      if (gSpark) gSpark.draw();
    }
    requestAnimationFrame(loop);
  }

  /* --------------------------------------------------------------- IPC wiring */
  function wire() {
    api.on('np:snapshot', (s) => {
      state.snap = s;
      // Occluded windows get no paint work at all; the main process forces a
      // snapshot as soon as the window is shown again.
      if (document.hidden) return;
      const lr = s.linkRate;
      if (lr && lr.at && lr.downMbps != null) {
        const { down, up } = state.linkRate;
        if (!down.length || down[down.length - 1][0] !== lr.at) {
          down.push([lr.at, lr.downMbps]);
          up.push([lr.at, lr.upMbps]);
          if (down.length > 600) down.splice(0, down.length - 600);
          if (up.length > 600) up.splice(0, up.length - 600);
        }
      }
      try {
        // Settings can change from the IPC side too (settings view, QA, another
        // window), so the chrome follows the snapshot rather than only clicks.
        const sig = s.settings ? `${s.settings.theme}|${s.settings.accent}|${s.settings.density}|${s.settings.animationIntensity}|${s.settings.reducedMotion}` : '';
        if (sig !== state.settingsSig) {
          state.settingsSig = sig;
          applySettings(s.settings);
        }
        updateHud(s);
        updateGadget(s);
        const inst = state.instances.get(state.active);
        if (inst && inst.update) inst.update(s);
        // Fresh data means every chart of the visible view is stale. Marking is
        // cheap, the rAF loop coalesces it into one repaint per frame, and it
        // guarantees the graphs can never sit frozen on old pixels.
        if (NP.invalidateCharts) NP.invalidateCharts();
      } catch (e) {
        if (!state._updErr || Date.now() - state._updErr > 5000) {
          state._updErr = Date.now();
          toast(`update error: ${e.message}`, 'error');
        }
      }
    });
    api.on('np:event', (ev) => {
      if (ev.level === 'warn' || ev.level === 'error') toast(ev.msg, ev.level);
    });
    api.on('np:test-phase', (p) => {
      const inst = state.instances.get('throughput');
      if (inst && inst.onPhase) inst.onPhase(p);
    });
    api.on('np:ramp-step', (p) => {
      const inst = state.instances.get('throughput');
      if (inst && inst.onRampStep) inst.onRampStep(p);
    });
    api.on('np:window-state', (st) => {
      const btn = document.querySelector('[data-win="maximize"]');
      if (btn) btn.textContent = st.maximized ? '❐' : '▢';
    });
    api.on('np:qa-view', (v) => switchView(v));
    api.on('np:gadget', (st) => applyGadget(st && st.gadget));
    api.on('np:test-progress', (p) => {
      // Live streaming speed telemetry while a test runs:
      if (p && p.mbps && state.snap && state.snap.linkRate) {
        if (p.direction === 'down') state.snap.linkRate.downMbps = p.mbps;
        if (p.direction === 'up') state.snap.linkRate.upMbps = p.mbps;
        const now = Date.now();
        state.snap.linkRate.at = now;
        const ring = p.direction === 'up' ? state.linkRate.up : state.linkRate.down;
        ring.push([now, p.mbps]);
        if (ring.length > 600) ring.splice(0, ring.length - 600);
      }
      const inst = state.instances.get(state.active);
      if (inst && inst.onProgress) inst.onProgress(p);
      if (inst && inst.update) inst.update(state.snap);
      if (NP.invalidateCharts) NP.invalidateCharts();
      updateGadget(state.snap);
    });

    document.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.nav)));
    // The minimize control collapses the dashboard into the gadget instead of
    // hiding the app: a network monitor you cannot see is a monitor you forget.
    document.querySelectorAll('[data-win]').forEach((b) =>
      b.addEventListener('click', () => {
        if (b.dataset.win === 'minimize') api.setGadget(true);
        else api.windowAction(b.dataset.win);
      })
    );
    document.getElementById('btn-pause').addEventListener('click', () => ctx.togglePause());
    document.getElementById('rail-test').addEventListener('click', () => ctx.runTest('speed', { direction: 'down' }));
    document.getElementById('rail-bb').addEventListener('click', () => ctx.runTest('bufferbloat'));
    document.getElementById('rail-report').addEventListener('click', () => ctx.previewReport());
    const gadgetToggle = () => api.setGadget(document.body.dataset.gadget !== '1');
    document.getElementById('btn-gadget').addEventListener('click', gadgetToggle);
    document.getElementById('g-expand').addEventListener('click', () => api.setGadget(false));
    document.getElementById('g-close').addEventListener('click', () => api.windowAction('close'));
    document.getElementById('g-test').addEventListener('click', () => ctx.runTest('speed', { direction: 'down' }));
    document.getElementById('g-pause').addEventListener('click', () => ctx.togglePause());
    // Double-clicking the gadget bar is the muscle-memory way back to the app.
    document.getElementById('g-drag').addEventListener('dblclick', () => api.setGadget(false));

    // Clicking either throughput card toggles between MB/s and Mbps:
    const toggleGadgetUnit = () => {
      const current = (state.snap && state.snap.settings && state.snap.settings.gadgetUnit) || 'mbs';
      const next = current === 'mbps' ? 'mbs' : 'mbps';
      // Apply locally FIRST, then persist. The settings round trip resyncs the probe
      // streams and can take over a second, and a toggle that lags its own click
      // reads as a broken control. The persisted value converges on the next snapshot.
      if (state.snap && state.snap.settings) state.snap.settings.gadgetUnit = next;
      // Write the labels directly: updateGadget() is gated on gadget mode being the
      // active view, and the unit switch must not inherit that gate.
      const label = next === 'mbps' ? 'Mbps' : 'MB/s';
      const du = document.getElementById('g-down-u');
      const uu = document.getElementById('g-up-u');
      if (du) du.textContent = label;
      if (uu) uu.textContent = label;
      window.__npUnitToggle = { current, next, applied: (state.snap && state.snap.settings && state.snap.settings.gadgetUnit) || null, gadgetOn, label, at: Date.now() };
      if (gadgetOn) updateGadget(state.snap);
      if (NP.gadget && NP.gadget.feed) NP.gadget.feed(state.snap);
      ctx.setSettings({ gadgetUnit: next });
    };
    const cDown = document.getElementById('g-cell-down');
    const cUp = document.getElementById('g-cell-up');
    if (cDown) cDown.addEventListener('click', toggleGadgetUnit);
    if (cUp) cUp.addEventListener('click', toggleGadgetUnit);

    // Sampling is pointless while the window is hidden and the probes cost CPU;
    // honor the setting when the user hides the app.
    document.addEventListener('visibilitychange', () => {
      const s = state.snap;
      if (!document.hidden && NP.invalidateCharts) NP.invalidateCharts();
      if (!s || !s.settings.pauseWhenHidden) return;
      api.setPaused(document.hidden);
    });
    // A restored/refocused window can come back with its canvas backing store
    // cleared. Force one repaint rather than showing an empty panel.
    window.addEventListener('focus', () => {
      if (NP.invalidateCharts) NP.invalidateCharts();
    });
  }

  /* ------------------------------------------------------------------- boot */
  async function boot() {
    wire();
    try {
      const s = await api.snapshot();
      state.snap = s;
      const lr = s.linkRate;
      if (lr && lr.at && lr.downMbps != null) {
        state.linkRate.down.push([lr.at, lr.downMbps]);
        state.linkRate.up.push([lr.at, lr.upMbps]);
      }
      applySettings(s.settings);
      updateHud(s);
      if (document.body.dataset.gadget === '1') applyGadget(true);
    } catch (e) {
      toast(`initial snapshot failed: ${e.message}`, 'error');
    }
    try {
      const hist = await api.history({ days: 1, kind: 'throughput', limit: 400 });
      for (const h of hist) {
        const dir = h.direction === 'up' ? 'up' : 'down';
        state.history[dir].push([h.t, h.mbps, 0]);
      }
      state.history.down.sort((a, b) => a[0] - b[0]);
      state.history.up.sort((a, b) => a[0] - b[0]);
    } catch {
      /* history is optional */
    }
    switchView('overview');
    requestAnimationFrame(loop);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
