'use strict';
/* Throughput view: run tests, watch them, and read the stream-scaling curve that
   separates a per-connection limit from an ISP policer. Fits one screen. */
(function () {
  const NP = (window.NP = window.NP || {});
  NP.views = NP.views || {};
  const { el, fmt, card, mini, slider, seg, plot } = NP;

  NP.views.throughput = function throughput(ctx) {
    let snap = null;
    let phase = null;
    let sizeBytes = 50_000_000;
    let dir = 'down';
    // Live link rate, shared with the overview: these series move without a
    // speed test running, so this view is never a static snapshot.
    const liveDown = NP.state.linkRate.down;
    const liveUp = NP.state.linkRate.up;

    const sizeSeg = seg({
      options: [
        { key: 'quick', label: '10 MB' },
        { key: 'standard', label: '50 MB' },
        { key: 'full', label: '100 MB' },
      ],
      value: 'standard',
      onChange: (k) => {
        sizeBytes = { quick: 10_000_000, standard: 50_000_000, full: 100_000_000 }[k];
        sizeSlider.set(sizeBytes / 1_000_000);
      },
    });
    const sizeSlider = slider({ label: 'Test size', min: 5, max: 500, step: 5, value: 50, unit: ' MB', onCommit: (v) => (sizeBytes = v * 1_000_000) });
    const downStreams = slider({ label: 'Download streams', min: 1, max: 16, value: 6, onCommit: (v) => ctx.setSettings({ downStreams: v }) });
    const upStreams = slider({ label: 'Upload streams', min: 1, max: 8, value: 1, onCommit: (v) => ctx.setSettings({ upStreams: v }) });
    const dirSeg = seg({
      options: [
        { key: 'down', label: 'Down' },
        { key: 'up', label: 'Up' },
        { key: 'both', label: 'Both' },
      ],
      value: 'down',
      onChange: (k) => (dir = k),
    });

    const controls = card('Test runner', { sub: 'one bandwidth test at a time', bodyClass: 'fill' });
    controls.body.append(
      el('div', { class: 'row' }, [sizeSeg.node]),
      sizeSlider.node,
      downStreams.node,
      upStreams.node,
      el('div', { class: 'row' }, [dirSeg.node]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn primary sm', text: 'Run test', onClick: () => ctx.runTest('speed', { direction: dir, bytes: sizeBytes, streams: Number(downStreams.input.value) }) }),
        el('button', { class: 'btn sm', text: 'Ramp', onClick: () => ctx.runTest('ramp', { direction: dir === 'up' ? 'up' : 'down' }) }),
        el('button', { class: 'btn sm', text: 'Bufferbloat', onClick: () => ctx.runTest('bufferbloat') }),
      ])
    );

    const phaseLabel = el('div', { class: 'muted', style: { fontSize: '10.5px' }, text: 'idle' });
    const progressWrap = el('div', { class: 'progress', hidden: '' }, [el('i')]);
    const streamBars = el('canvas');
    const resultGrid = el('div', { class: 'stat-grid' });
    const liveCard = card('Live test', { sub: 'per-stream effective rate', bodyClass: 'fill' });
    liveCard.body.append(phaseLabel, progressWrap, plot(streamBars), resultGrid);

    const dlChart = el('canvas');
    const upChart = el('canvas');
    const historyCard = card('Throughput history', { sub: 'last 30 minutes of results', bodyClass: 'fill' });
    historyCard.body.append(
      el('div', { class: 'legend' }, [
        el('span', {}, [el('i', { style: { background: 'var(--accent)' } }), 'download']),
        el('span', {}, [el('i', { style: { background: '#a78bfa' } }), 'upload']),
      ]),
      plot(dlChart, 'fixed-md'),
      plot(upChart)
    );

    const rampChart = el('canvas');
    const rampVerdict = el('div', { class: 'warn-box ok', hidden: '' });
    const rampTable = el('div', { class: 'tbl-wrap' });
    const rampCard = card('Stream scaling', { sub: 'flat = policer, rising = headroom', bodyClass: 'fill' });
    rampCard.body.append(rampVerdict, plot(rampChart), rampTable);

    const bbGrade = el('div', { class: 'row' });
    const bbStats = el('div', { class: 'stat-grid' });
    const bbHist = el('canvas');
    const bbCard = card('Bufferbloat', { sub: 'added latency under saturation', bodyClass: 'fill' });
    bbCard.body.append(bbGrade, bbStats, plot(bbHist));

    const root = el('div', { class: 'view-grid rows-even' }, [
      el('div', { class: 'cols-2' }, [controls.node, liveCard.node]),
      el('div', { class: 'cols-3' }, [historyCard.node, rampCard.node, bbCard.node]),
    ]);

    let bars = null;
    let rampBars = null;
    let histogram = null;
    let dlSeries = null;
    let upSeries = null;

    function ensure() {
      if (!bars) {
        bars = new NP.Bars(streamBars, { suffix: ' Mbps', rowH: 19, maxRows: 8 });
        rampBars = new NP.Bars(rampChart, { suffix: ' Mbps', rowH: 22 });
        histogram = new NP.Histogram(bbHist, { unit: ' ms' });
        // 5 minutes, not 30: the live link line has to be able to move. Test
        // history beyond this window lives in the table and the saved report.
        dlSeries = new NP.TimeSeries(dlChart, { windowSec: 300, area: true, lossMarkers: false });
        upSeries = new NP.TimeSeries(upChart, { windowSec: 300, area: true, lossMarkers: false });
      }
    }

    function update(s) {
      snap = s;
      ensure();
      sizeSlider.set(Math.round(s.settings.testSizeBytes / 1_000_000));
      sizeBytes = s.settings.testSizeBytes;
      downStreams.set(s.settings.downStreams);
      upStreams.set(s.settings.upStreams);

      progressWrap.hidden = !s.overhead.busy;
      if (!s.overhead.busy && !phase) phaseLabel.textContent = 'idle';

      const d = s.lastTests.down;
      const u = s.lastTests.up;
      if (d) bars.setRows(d.mbpsPerStream.slice(0, 8).map((p, i) => ({ label: `stream ${i + 1}`, value: p })));
      resultGrid.replaceChildren(
        NP.stat('download', d ? `${fmt.mbps(d.mbps, 2)} Mbps` : '—', d && d.status === 'ok' ? 'ok' : d ? 'warn' : ''),
        NP.stat('upload', u ? `${fmt.mbps(u.mbps, 2)} Mbps` : '—', u && u.status === 'ok' ? 'ok' : u ? 'warn' : ''),
        NP.stat('dl MB/s', d ? fmt.mbs(d.mbps) : '—'),
        NP.stat('ul MB/s', u ? fmt.mbs(u.mbps) : '—'),
        NP.stat('streams ok', d ? `${d.streamsOk}/${d.streams}` : '—'),
        NP.stat('spread', d ? `${fmt.n(d.spreadPct, 1)}%` : '—', d ? NP.severity(d.spreadPct, 15, 35) : ''),
        NP.stat(
          'link now',
          s.linkRate && s.linkRate.downMbps != null
            ? `${fmt.mbps(s.linkRate.downMbps)} ↓ / ${fmt.mbps(s.linkRate.upMbps)} ↑`
            : '—',
          s.linkRate && s.linkRate.underLoad ? 'warn' : ''
        ),
        NP.stat('ttfb', d ? `${fmt.ms(d.ttfbMs, 1)} ms` : '—'),
        NP.stat('http', d ? (d.httpCodes || []).join(',') : '—', d && d.status !== 'ok' ? 'warn' : '')
      );

      const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim();
      const good = getComputedStyle(document.body).getPropertyValue('--ok').trim() || '#34d399';
      dlSeries.setSeries([
        { key: 'down', label: 'download test', color: accent, points: ctx.history('down') },
        { key: 'link', label: 'link now', color: good, points: liveDown },
      ]);
      upSeries.setSeries([
        { key: 'up', label: 'upload test', color: '#a78bfa', points: ctx.history('up') },
        { key: 'link', label: 'link now', color: good, points: liveUp },
      ]);

      const r = s.lastTests.ramp;
      if (r) {
        rampBars.setRows(r.points.map((p) => ({ label: `${p.streams}x`, value: p.mbps })));
        rampVerdict.hidden = false;
        rampVerdict.className = `warn-box ${r.scalingGainPct < 8 ? 'warn' : 'ok'}`;
        rampVerdict.replaceChildren(
          el('strong', { text: `${r.singleStreamMbps} → ${r.peakMbps} Mbps (${r.scalingGainPct > 0 ? '+' : ''}${r.scalingGainPct}%)` }),
          el('p', { text: r.verdict })
        );
        rampTable.replaceChildren(
          el('table', { class: 'data' }, [
            el('thead', {}, [el('tr', {}, [el('th', { text: 'streams' }), el('th', { text: 'Mbps' }), el('th', { text: 'per-stream' })])]),
            el('tbody', {}, r.points.slice(0, 3).map((p) => el('tr', {}, [
              el('td', { text: String(p.streams) }),
              el('td', { text: fmt.mbps(p.mbps, 2) }),
              el('td', { text: p.perStream.map((x) => fmt.mbps(x, 1)).join(' / ') }),
            ]))),
          ])
        );
      }

      const b = s.lastTests.bufferbloat;
      if (b) {
        bbGrade.replaceChildren(...NP.gradeChip(b.grade, b.gradeNote || '').children);
        bbStats.replaceChildren(
          NP.stat('idle', b.idleMs == null ? '—' : `${fmt.ms(b.idleMs, 1)} ms`),
          NP.stat('loaded', b.loadedMs == null ? '—' : `${fmt.ms(b.loadedMs, 1)} ms`, NP.severity(b.deltaMs || 0, 30, 100)),
          NP.stat('added', b.deltaMs == null ? '—' : `+${fmt.ms(b.deltaMs, 1)} ms`, NP.severity(b.deltaMs || 0, 30, 100)),
          NP.stat('load Mbps', `${fmt.mbps(b.throughputMbps)}`),
          NP.stat('loss', b.lossPct == null ? '—' : `${fmt.n(b.lossPct, 1)}%`)
        );
        if (b.loadedSamples && b.loadedSamples.length) histogram.setValues(b.loadedSamples);
      }
    }

    let phaseBase = '';
    let phaseAt = 0;
    let partial = null;

    function paintPhase() {
      if (!phase) {
        phaseLabel.textContent = 'idle';
        return;
      }
      const elapsed = phaseAt ? ((performance.now() - phaseAt) / 1000).toFixed(1) : '0.0';
      const live = partial
        ? ` · ${partial.streamsDone}/${partial.streams} streams · ${fmt.mbps(partial.mbps)} Mbps so far`
        : '';
      phaseLabel.textContent = `${phaseBase}${live} · ${elapsed}s`;
    }

    function onPhase(p) {
      phase = p.phase === 'idle' ? null : p.phase;
      progressWrap.hidden = !phase;
      partial = null;
      if (phase) {
        phaseBase = `${phase}${p.streams ? ` · ${p.streams} stream(s)` : ''}${p.bytes ? ` · ${fmt.bytes(p.bytes)}` : ''}`;
        phaseAt = performance.now();
      }
      paintPhase();
    }

    /** Partial results from the main process while the test is still running. */
    function onProgress(p) {
      if (!p || !p.streamsDone) return;
      partial = p;
      if (!phase) {
        phase = p.direction === 'up' ? 'upload' : 'download';
        progressWrap.hidden = false;
        phaseBase = phase;
        phaseAt = performance.now();
      }
      paintPhase();
    }

    function onRampStep(step) {
      phaseLabel.textContent = `ramp ${step.streams} stream(s) → ${fmt.mbps(step.mbps)} Mbps`;
    }

    function frame() {
      // Tick the elapsed counter only when the tenth changes: text churn every
      // frame would force layout for a number nobody can read that fast.
      if (phase && Math.floor((performance.now() - phaseAt) / 100) !== frame._lastTick) {
        frame._lastTick = Math.floor((performance.now() - phaseAt) / 100);
        paintPhase();
      }
      if (bars) bars.draw();
      if (rampBars) rampBars.draw();
      if (histogram) histogram.draw();
      if (dlSeries) dlSeries.draw();
      if (upSeries) upSeries.draw();
    }

    return { node: root, update, frame, onPhase, onProgress, onRampStep };
  };
})();