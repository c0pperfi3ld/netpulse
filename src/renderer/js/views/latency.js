'use strict';
/* Latency view: the long chart, one compact card per target, the RTT
   distribution and a loss timeline. Everything fits without scrolling. */
(function () {
  const NP = (window.NP = window.NP || {});
  NP.views = NP.views || {};
  const { el, fmt, card, mini, slider, plot } = NP;

  NP.views.latency = function latency(ctx) {
    let snap = null;
    let series = null;
    let lossSeries = null;
    let histogram = null;
    let pctChart = null;
    const targetCards = new Map();

    const bigChart = el('canvas');
    const legend = el('div', { class: 'legend' });
    const windowSlider = slider({
      label: 'Window',
      min: 15,
      max: 600,
      step: 15,
      value: 120,
      unit: ' s',
      onCommit: (v) => ctx.setSettings({ chartWindowSec: v }),
    });
    const chartCard = card('Live latency', {
      sub: 'every target · gaps are losses',
      actions: [el('button', { class: 'btn sm', text: 'Sweep 20', onClick: () => ctx.runTest('sweep', { count: 20 }) })],
      bodyClass: 'fill',
    });
    chartCard.body.append(el('div', { class: 'row' }, [windowSlider.node, legend]), plot(bigChart));

    const targetGrid = el('div', { class: 'cols-3' });
    const cardsCard = card('Per-target detail', { sub: 'sparkline + live stats', bodyClass: 'fill' });
    cardsCard.body.append(targetGrid);

    const hist = el('canvas');
    const pctBars = el('canvas');
    const distCard = card('Distribution', { sub: 'primary target', bodyClass: 'fill' });
    distCard.body.append(plot(hist, 'fixed-sm'), plot(pctBars));

    const lossChart = el('canvas');
    const lossCard = card('Loss timeline', { sub: 'one tick per lost probe', bodyClass: 'fill' });
    lossCard.body.append(plot(lossChart));

    const root = el('div', { class: 'view-grid rows-hero' }, [
      chartCard.node,
      cardsCard.node,
      el('div', { class: 'cols-2' }, [distCard.node, lossCard.node]),
    ]);

    function ensure() {
      if (!series) {
        series = new NP.TimeSeries(bigChart, { windowSec: 120, unit: 'ms', area: false });
        lossSeries = new NP.TimeSeries(lossChart, { windowSec: 120, unit: 'ms', area: false, lossMarkers: true, yMax: 20 });
        histogram = new NP.Histogram(hist, { unit: ' ms' });
        pctChart = new NP.Bars(pctBars, { suffix: ' ms', rowH: 21 });
      }
    }

    function update(s) {
      snap = s;
      ensure();
      series.windowSec = s.settings.chartWindowSec;
      lossSeries.windowSec = s.settings.chartWindowSec;
      const targets = s.latency.targets;

      series.setSeries(targets.map((t) => ({ key: t.host, label: t.label, color: t.color, points: t.samples.slice(-900) })));
      lossSeries.setSeries(targets.map((t) => ({ key: t.host, label: t.label, color: t.color, points: t.samples.slice(-900) })));

      const sig = targets.map((t) => `${t.host}:${t.stats.avg}:${t.stats.max}:${t.stats.lossPct}`).join('|');
      if (legend.dataset.sig !== sig) {
        legend.dataset.sig = sig;
        legend.replaceChildren(
          ...targets.map((t) => el('span', {}, [
            el('i', { style: { background: t.color } }),
            `${t.label} ${fmt.ms(t.stats.avg, 1)} ms${t.stats.lossPct ? ` · ${fmt.n(t.stats.lossPct, 1)}% loss` : ''}`,
          ]))
        );
      }

      // Keep at most three target cards so the row can never overflow.
      for (const t of targets.slice(0, 3)) {
        let ref = targetCards.get(t.host);
        if (!ref) {
          const sparkCanvas = el('canvas');
          const stats = el('div', { class: 'hero-foot' });
          const box = el('div', { class: 'card', style: { padding: '8px 10px' } }, [
            el('div', { class: 'spread' }, [
              el('div', { class: 'row', style: { gap: '5px' } }, [el('i', { class: 'dot', style: { background: t.color } }), el('strong', { class: 'clip', style: { fontSize: '11.5px' }, text: t.label })]),
              el('span', { class: 'muted mono', style: { fontSize: '10px' }, text: t.host }),
            ]),
            plot(sparkCanvas, 'spark'),
            stats,
          ]);
          ref = { box, stats, spark: new NP.Sparkline(sparkCanvas, { color: t.color }) };
          targetCards.set(t.host, ref);
          targetGrid.append(box);
        }
        ref.spark.setPoints(t.samples.slice(-90).map((p) => [p[0], p[1] == null ? 0 : p[1], p[2]]), t.color);
        const k = `${t.stats.avg}:${t.stats.min}:${t.stats.max}:${t.stats.p50}:${t.stats.p95}:${t.stats.p99}:${t.stats.jitter.rfc3550}:${t.stats.lost}:${t.stats.count}`;
        if (ref.sig !== k) {
          ref.sig = k;
          ref.stats.replaceChildren(
            mini('avg', `${fmt.ms(t.stats.avg, 2)} ms`),
            mini('p50', `${fmt.ms(t.stats.p50, 1)}`),
            mini('p95', `${fmt.ms(t.stats.p95, 1)}`),
            mini('p99', `${fmt.ms(t.stats.p99, 1)}`),
            mini('max', `${fmt.ms(t.stats.max, 1)}`),
            mini('jit', `${fmt.ms(t.stats.jitter.rfc3550, 2)}`),
            mini('loss', `${t.stats.lost}/${t.stats.count}`, NP.severity(t.stats.lossPct, 0.5, 2))
          );
        }
      }
      for (const [host, ref] of targetCards) {
        if (!targets.some((t) => t.host === host)) {
          ref.box.remove();
          targetCards.delete(host);
        }
      }

      const primary = targets.find((t) => t.label !== 'Gateway') || targets[0];
      if (primary) {
        histogram.setValues(primary.samples.filter((p) => p[1] != null).map((p) => p[1]));
        pctChart.setRows([
          { label: 'p50', value: primary.stats.p50, color: '#34d399' },
          { label: 'p95', value: primary.stats.p95, color: '#fbbf24' },
          { label: 'p99', value: primary.stats.p99, color: '#fb7185' },
        ]);
        distCard.head.querySelector('.card-sub').textContent = `${primary.label} · n=${primary.stats.count} · σ ${fmt.ms(primary.stats.jitter.stddev, 2)} ms`;
        series.setRefLines([
          { value: primary.stats.p50, label: `p50 ${fmt.ms(primary.stats.p50, 1)}`, color: 'rgba(52,211,153,.45)' },
          { value: primary.stats.p95, label: `p95 ${fmt.ms(primary.stats.p95, 1)}`, color: 'rgba(251,191,36,.45)' },
        ]);
      }
    }

    function frame() {
      if (series) series.draw();
      if (lossSeries) lossSeries.draw();
      if (histogram) histogram.draw();
      if (pctChart) pctChart.draw();
      for (const ref of targetCards.values()) ref.spark.draw();
    }

    return { node: root, update, frame };
  };
})();