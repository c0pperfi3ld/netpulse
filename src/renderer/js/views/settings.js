'use strict';
/* Settings: every knob the probes honor, applied live, in a single non-scrolling
   grid. */
(function () {
  const NP = (window.NP = window.NP || {});
  NP.views = NP.views || {};
  const { el, card, slider, toggle, seg } = NP;

  NP.views.settings = function settings(ctx) {
    let snap = null;
    let running = false;
    let queued = null;

    async function apply(patch) {
      // Never drop a click: merge into the pending patch and let the in-flight
      // call finish first. Two fast theme clicks used to lose the second one.
      queued = { ...(queued || {}), ...patch };
      if (running) return;
      running = true;
      try {
        while (queued) {
          const next = queued;
          queued = null;
          const s = await ctx.setSettings(next);
          if (s) {
            if (snap) snap.settings = s;
            renderTargets();
          }
        }
      } finally {
        running = false;
      }
    }

    const interval = slider({ label: 'Latency interval', min: 200, max: 5000, step: 100, value: 1000, unit: ' ms', onCommit: (v) => apply({ latencyIntervalMs: v }) });
    const timeout = slider({ label: 'Ping timeout', min: 300, max: 4000, step: 100, value: 1500, unit: ' ms', onCommit: (v) => apply({ latencyTimeoutMs: v }) });
    const windowSec = slider({ label: 'Chart window', min: 15, max: 600, step: 15, value: 120, unit: ' s', onCommit: (v) => apply({ chartWindowSec: v }) });
    const pauseHidden = toggle({ label: 'Pause sampling when hidden', checked: true, onChange: (v) => apply({ pauseWhenHidden: v }) });
    const sampling = card('Sampling', { sub: 'latency series cadence', bodyClass: 'fill' });
    sampling.body.append(interval.node, timeout.node, windowSec.node, pauseHidden.node);

    const downStreams = slider({ label: 'Download streams', min: 1, max: 16, value: 6, onCommit: (v) => apply({ downStreams: v }) });
    const upStreams = slider({ label: 'Upload streams', min: 1, max: 8, value: 1, onCommit: (v) => apply({ upStreams: v }) });
    const testSize = slider({ label: 'Download size', min: 5, max: 500, step: 5, value: 50, unit: ' MB', onCommit: (v) => apply({ testSizeBytes: v * 1_000_000 }) });
    const upSize = slider({ label: 'Upload size', min: 5, max: 200, step: 5, value: 30, unit: ' MB', onCommit: (v) => apply({ uploadSizeBytes: v * 1_000_000 }) });
    const sizes = card('Test sizes', { sub: 'parallelism and volume', bodyClass: 'fill' });
    sizes.body.append(downStreams.node, upStreams.node, testSize.node, upSize.node);

    const rampMax = slider({ label: 'Ramp ceiling', min: 2, max: 16, value: 8, unit: ' streams', onCommit: (v) => apply({ rampMaxStreams: v }) });
    const autoTest = slider({ label: 'Auto speed test', min: 0, max: 120, step: 5, value: 0, unit: ' min', format: (v) => (v === 0 ? 'off' : `${v}`), onCommit: (v) => apply({ autoSpeedTestMinutes: v }) });
    const planDown = slider({ label: 'Plan download', min: 10, max: 2000, step: 10, value: 60, unit: ' Mbps', onCommit: (v) => apply({ planDownMbps: v }) });
    const planUp = slider({ label: 'Plan upload', min: 10, max: 2000, step: 10, value: 100, unit: ' Mbps', onCommit: (v) => apply({ planUpMbps: v }) });
    const warmOnStart = toggle({ label: 'Measure on launch', checked: true, onChange: (v) => apply({ warmOnStart: v }) });
    const automation = card('Automation & plan', { sub: 'what you pay for', bodyClass: 'fill' });
    automation.body.append(rampMax.node, autoTest.node, warmOnStart.node, planDown.node, planUp.node);

    const alertRtt = slider({ label: 'High RTT', min: 20, max: 500, step: 5, value: 150, unit: ' ms', onCommit: (v) => apply({ alertRttMs: v }) });
    const alertLoss = slider({ label: 'Loss', min: 0, max: 20, step: 0.5, value: 2, unit: ' %', onCommit: (v) => apply({ alertLossPct: v }) });
    const alertFloor = slider({ label: 'Download floor', min: 1, max: 500, value: 20, unit: ' Mbps', onCommit: (v) => apply({ alertDownFloorMbps: v }) });
    const bbStreams = slider({ label: 'Saturation streams', min: 1, max: 12, value: 4, onCommit: (v) => apply({ bbStreams: v }) });
    const bbBytes = slider({ label: 'Bufferbloat load', min: 5, max: 200, step: 5, value: 40, unit: ' MB', onCommit: (v) => apply({ bbBytesPerStream: v * 1_000_000 }) });
    const alerts = card('Alerts & load', { sub: 'event thresholds, saturation size', bodyClass: 'fill' });
    alerts.body.append(alertRtt.node, alertLoss.node, alertFloor.node, bbStreams.node, bbBytes.node);

    /* targets */
    const targetList = el('div', { class: 'stack' });
    const newHost = el('input', { type: 'text', placeholder: '9.9.9.9 or one.one.one.one', 'aria-label': 'new latency target' });
    const targetsCard = card('Latency targets', { sub: 'one ping process per enabled target', bodyClass: 'fill' });
    targetsCard.body.append(
      targetList,
      el('div', { class: 'row' }, [
        newHost,
        el('button', {
          class: 'btn sm primary',
          text: 'Add',
          onClick: () => {
            const host = newHost.value.trim();
            if (!host || !snap) return;
            const colors = ['#4dd4ff', '#a78bfa', '#34d399', '#fbbf24', '#fb7185'];
            apply({ targets: [...snap.settings.targets, { host, label: host, enabled: true, color: colors[snap.settings.targets.length % colors.length] }] });
            newHost.value = '';
          },
        }),
      ])
    );

    const theme = seg({
      options: [
        { key: 'dark', label: 'Dark' },
        { key: 'light', label: 'Light' },
        { key: 'system', label: 'System' },
      ],
      value: 'dark',
      onChange: (v) => apply({ theme: v }),
    });
    const accent = seg({
      options: [
        { key: 'cyan', label: 'Cyan' },
        { key: 'violet', label: 'Violet' },
        { key: 'emerald', label: 'Emerald' },
        { key: 'amber', label: 'Amber' },
        { key: 'rose', label: 'Rose' },
      ],
      value: 'cyan',
      onChange: (v) => apply({ accent: v }),
    });
    const density = seg({
      options: [
        { key: 'comfortable', label: 'Normal' },
        { key: 'compact', label: 'Compact' },
      ],
      value: 'comfortable',
      onChange: (v) => apply({ density: v }),
    });
    const anim = slider({ label: 'Animation intensity', min: 0, max: 100, value: 70, unit: '%', onCommit: (v) => apply({ animationIntensity: v }) });
    const reduced = toggle({ label: 'Reduced motion', checked: false, onChange: (v) => apply({ reducedMotion: v }) });
    const keepDays = slider({ label: 'Keep history', min: 1, max: 90, value: 14, unit: ' d', onCommit: (v) => apply({ historyKeepDays: v }) });
    const appearance = card('Appearance, motion, retention', { sub: 'applies immediately', bodyClass: 'fill' });
    appearance.body.append(
      el('div', { class: 'row' }, [el('span', { class: 'k', text: 'Theme' }), theme.node, accent.node]),
      el('div', { class: 'row' }, [el('span', { class: 'k', text: 'Density' }), density.node]),
      anim.node,
      reduced.node,
      keepDays.node
    );

    const root = el('div', { class: 'view-grid rows-even' }, [
      el('div', { class: 'cols-4' }, [sampling.node, sizes.node, automation.node, alerts.node]),
      el('div', { class: 'cols-2' }, [targetsCard.node, appearance.node]),
    ]);

    function renderTargets() {
      if (!snap) return;
      const s = snap;
      const rows = s.settings.targets.map((t, i) =>
        el('div', { class: 'target-row' }, [
          el('i', { class: 'dot', style: { background: t.color || '#4dd4ff' } }),
          el('input', {
            type: 'text',
            value: t.label || t.host,
            'aria-label': `label for ${t.host}`,
            onChange: (e) => apply({ targets: s.settings.targets.map((x, xi) => (xi === i ? { ...x, label: e.target.value } : x)) }),
          }),
          el('button', {
            class: 'btn sm',
            text: t.enabled ? 'on' : 'off',
            onClick: () => apply({ targets: s.settings.targets.map((x, xi) => (xi === i ? { ...x, enabled: !x.enabled } : x)) }),
          }),
          el('button', { class: 'btn sm danger', text: '×', onClick: () => apply({ targets: s.settings.targets.filter((_x, xi) => xi !== i) }) }),
        ])
      );
      const gw = s.settings.gateway;
      rows.push(
        el('div', { class: 'target-row' }, [
          el('i', { class: 'dot', style: { background: gw.color || '#34d399' } }),
          el('span', { class: 'clip', text: `Gateway ${gw.host || '(auto)'}` }),
          el('button', { class: 'btn sm', text: gw.enabled ? 'on' : 'off', onClick: () => apply({ gateway: { ...gw, enabled: !gw.enabled } }) }),
          el('span'),
        ])
      );
      targetList.replaceChildren(...rows);
    }

    function update(s) {
      snap = s;
      const st = s.settings;
      interval.set(st.latencyIntervalMs);
      timeout.set(st.latencyTimeoutMs);
      windowSec.set(st.chartWindowSec);
      pauseHidden.input.checked = st.pauseWhenHidden;
      downStreams.set(st.downStreams);
      upStreams.set(st.upStreams);
      testSize.set(Math.round(st.testSizeBytes / 1_000_000));
      upSize.set(Math.round(st.uploadSizeBytes / 1_000_000));
      rampMax.set(st.rampMaxStreams);
      autoTest.set(st.autoSpeedTestMinutes);
      warmOnStart.input.checked = st.warmOnStart !== false;
      planDown.set(st.planDownMbps);
      planUp.set(st.planUpMbps);
      alertRtt.set(st.alertRttMs);
      alertLoss.set(st.alertLossPct);
      alertFloor.set(st.alertDownFloorMbps);
      bbStreams.set(st.bbStreams);
      bbBytes.set(Math.round(st.bbBytesPerStream / 1_000_000));
      anim.set(st.animationIntensity);
      theme.set(st.theme || 'dark');
      accent.set(st.accent || 'cyan');
      density.set(st.density || 'comfortable');
      reduced.input.checked = st.reducedMotion;
      keepDays.set(st.historyKeepDays);
      const sig = JSON.stringify(st.targets.map((t) => [t.host, t.label, t.enabled, t.color, st.gateway.enabled]));
      if (targetList.dataset.sig !== sig) {
        targetList.dataset.sig = sig;
        renderTargets();
      }
    }

    return { node: root, update, frame() {} };
  };
})();