'use strict';
/* Overview: latency, download and upload are the heroes; everything else is the
   supporting evidence, sized to fit the window without scrolling. */
(function () {
  const NP = (window.NP = window.NP || {});
  NP.views = NP.views || {};
  const { el, fmt, card, mini, plot, text } = NP;

  NP.views.overview = function overview(ctx) {
    let snap = null;
    let primaryHost = null;
    let spark = null;
    let liveSeries = null;
    let dlSeries = null;
    let ulSeries = null;
    // Live link rate comes from the shared ring in app state: test results
    // alone never move on a download started outside the app.
    const liveDown = NP.state.linkRate.down;
    const liveUp = NP.state.linkRate.up;
    let gauge = null;
    let flow = null;
    let lastDlStamp = null;
    let lastUlStamp = null;
    let lastTargetSig = '';

    /* ---------------------------------------------------------- latency hero */
    const rttValue = el('div', { class: 'hero-value', dataset: { readout: 'rtt' }, text: '—' });
    const rttSub = el('div', { class: 'hero-sub', text: 'waiting for samples…' });
    const rttSpark = el('canvas');
    const rttMinis = el('div', { class: 'hero-foot' });
    const targetChips = el('div', { class: 'row', style: { gap: '4px' } });
    const rttCard = card('Latency', {
      sub: 'live RTT to the edge',
      class: 'hero',
      actions: [el('button', { class: 'btn sm', text: 'Sweep', onClick: () => ctx.runTest('sweep', { count: 12 }) })],
      bodyClass: 'fill',
    });
    rttCard.body.append(
      el('div', { class: 'hero-block' }, [
        el('div', { class: 'hero-label', text: 'Round-trip time' }),
        el('div', {}, [rttValue, el('span', { class: 'hero-unit', text: 'ms' })]),
        rttSub,
      ]),
      plot(rttSpark, 'spark'),
      rttMinis,
      targetChips
    );

    /* --------------------------------------------------------- download hero */
    const dlValue = el('div', { class: 'hero-value', dataset: { readout: 'down' }, text: '—' });
    const dlSub = el('div', { class: 'hero-sub', text: 'no test yet' });
    const dlChart = el('canvas');
    const dlMinis = el('div', { class: 'hero-foot' });
    const dlCard = card('Download', {
      sub: 'aggregate · policer lives here',
      class: 'hero',
      actions: [
        el('button', { class: 'btn sm primary', text: 'Test', onClick: () => ctx.runTest('speed', { direction: 'down' }) }),
        el('button', { class: 'btn sm', text: 'Ramp', onClick: () => ctx.runTest('ramp', { direction: 'down' }) }),
      ],
      bodyClass: 'fill',
    });
    dlCard.body.append(
      el('div', { class: 'hero-block' }, [
        el('div', { class: 'hero-label', text: 'Download throughput' }),
        el('div', {}, [dlValue, el('span', { class: 'hero-unit', text: 'Mbps' })]),
        dlSub,
      ]),
      plot(dlChart, 'hero'),
      dlMinis
    );

    /* ----------------------------------------------------------- upload hero */
    const ulValue = el('div', { class: 'hero-value', dataset: { readout: 'up' }, text: '—' });
    const ulSub = el('div', { class: 'hero-sub', text: 'no test yet' });
    const ulChart = el('canvas');
    const ulMinis = el('div', { class: 'hero-foot' });
    const ulCard = card('Upload', {
      sub: 'single-transfer speed',
      class: 'hero',
      actions: [el('button', { class: 'btn sm primary', text: 'Test', onClick: () => ctx.runTest('speed', { direction: 'up' }) })],
      bodyClass: 'fill',
    });
    ulCard.body.append(
      el('div', { class: 'hero-block' }, [
        el('div', { class: 'hero-label', text: 'Upload throughput' }),
        el('div', {}, [ulValue, el('span', { class: 'hero-unit', text: 'Mbps' })]),
        ulSub,
      ]),
      plot(ulChart, 'hero'),
      ulMinis
    );

    /* ------------------------------------------------- live multi-target RTT */
    const liveChart = el('canvas');
    const legend = el('div', { class: 'legend' });
    const liveCard = card('Live latency — all targets', {
      sub: 'red ticks on the baseline are lost probes',
      actions: [el('button', { class: 'btn sm', text: 'Pause', onClick: () => ctx.togglePause() })],
      bodyClass: 'fill',
    });
    liveCard.body.append(legend, plot(liveChart));

    /* --------------------------------------------------------------- quality */
    const qualityGauge = el('canvas');
    const qualityList = el('div', { class: 'stack' });
    const qCard = card('Quality score', { sub: 'weighted composite', bodyClass: 'fill' });
    qCard.body.append(plot(qualityGauge, 'gauge'), qualityList);

    /* ------------------------------------------------------------ env + flow */
    const flowCanvas = el('canvas');
    const envList = el('div', { class: 'stat-grid' });
    const envCard = card('Environment', { sub: 'what the probes see', bodyClass: 'fill' });
    envCard.body.append(plot(flowCanvas, 'fixed-sm flow'), envList);

    const appsCard = card('Bandwidth apps', { sub: 'live MB/s · apps with sockets', bodyClass: 'fill' });
    const appsList = el('div', { class: 'app-list' });
    const appsNote = el('div', { class: 'app-note', text: 'per-app I/O (network + disk); Windows has no public per-app network counter' });
    appsCard.body.append(appsList, appsNote);

    const eventsCard = card('Events', { sub: 'rule engine output', bodyClass: 'fill' });
    const eventsList = el('div', { class: 'list' });
    eventsCard.body.append(eventsList);

    const root = el('div', { class: 'view-grid rows-hero' }, [
      el('div', { class: 'cols-hero' }, [rttCard.node, dlCard.node, ulCard.node]),
      el('div', { class: 'cols-2-1' }, [liveCard.node, qCard.node]),
      el('div', { class: 'cols-apps' }, [appsCard.node, eventsCard.node, envCard.node]),
    ]);

    const readout = new NP.SpringText(rttValue, 0, (v) => (v > 0 ? fmt.ms(v, 0) : '—'));
    const dlSpring = new NP.SpringText(dlValue, 0, (v) => (v > 0 ? fmt.mbps(v, 1) : '—'));
    const ulSpring = new NP.SpringText(ulValue, 0, (v) => (v > 0 ? fmt.mbps(v, 1) : '—'));

    function ensure() {
      if (!spark) {
        const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#4dd4ff';
        spark = new NP.Sparkline(rttSpark, { color: accent });
        liveSeries = new NP.TimeSeries(liveChart, { windowSec: 120, unit: 'ms', area: false });
        dlSeries = new NP.TimeSeries(dlChart, { windowSec: 180, unit: 'Mbps', area: true, lossMarkers: false, window: 180 });
        ulSeries = new NP.TimeSeries(ulChart, { windowSec: 180, unit: 'Mbps', area: true, lossMarkers: false, window: 180 });
        gauge = new NP.Gauge(qualityGauge, { min: 0, max: 100, unit: 'score', thresholds: (v) => (v >= 80 ? '#34d399' : v >= 60 ? '#fbbf24' : '#fb7185') });
        flow = new NP.FlowStrip(flowCanvas);
      }
    }

    function heroTarget(s) {
      if (!s.latency.targets.length) return null;
      if (!primaryHost || !s.latency.targets.some((t) => t.host === primaryHost)) {
        primaryHost = (s.latency.targets.find((t) => t.label !== 'Gateway') || s.latency.targets[0]).host;
      }
      return s.latency.targets.find((t) => t.host === primaryHost) || s.latency.targets[0];
    }

    function update(s) {
      snap = s;
      ensure();

      const hero = heroTarget(s);
      if (hero && hero.stats) {
        const live = hero.recent && hero.recent.length ? hero.recent[hero.recent.length - 1] : null;
        readout.set(live && live.rtt != null ? live.rtt : hero.stats.avg || 0);
        const rate = hero.stats.count && s.latency.windowSec ? (hero.stats.count / s.latency.windowSec).toFixed(1) : '0';
        const loadTag = s.linkRate && s.linkRate.underLoad ? 'UNDER LOAD · ' : '';
        rttSub.textContent = `${loadTag}${hero.label} · avg ${fmt.ms(hero.stats.avg, 2)} · σ ${fmt.ms(hero.stats.jitter.stddev, 2)} · ${rate} samples/s`;
        spark.setPoints(hero.samples.slice(-90).map((p) => [p[0], p[1] == null ? hero.stats.avg || 0 : p[1], p[2]]), hero.color);
        rttMinis.replaceChildren(
          mini('min', `${fmt.ms(hero.stats.min, 1)} ms`),
          mini('avg', `${fmt.ms(hero.stats.avg, 2)} ms`),
          mini('p95', `${fmt.ms(hero.stats.p95, 1)} ms`),
          mini('max', `${fmt.ms(hero.stats.max, 1)} ms`),
          mini('σ stddev', `${fmt.ms(hero.stats.jitter.stddev, 2)} ms`),
          mini('jitter', `${fmt.ms(hero.stats.jitter.meanDelta, 2)} ms`),
          mini('loss', `${hero.stats.lost}/${hero.stats.count}`, NP.severity(hero.stats.lossPct, 0.5, 2))
        );
        const sig = `${hero.host}:${hero.stats.count}`;
        if (sig !== lastTargetSig) {
          lastTargetSig = sig;
          targetChips.replaceChildren(
            ...s.latency.targets.map((t) =>
              el('button', {
                class: `btn sm${t.host === primaryHost ? ' sel' : ''}`,
                text: `${t.label} ${fmt.ms(t.stats.avg, 0)}`,
                onClick: () => {
                  primaryHost = t.host;
                  lastTargetSig = '';
                  if (snap) update(snap);
                },
              })
            )
          );
        }
      }

      const d = s.lastTests.down;
      const u = s.lastTests.up;
      const lr = s.linkRate || {};
      const moving = lr.downMbps != null && (s.overhead.busy || lr.downMbps >= 0.5);
      if (moving) {
        // Something is using the link right now (a browser, an update, this
        // app's own test): show that, not the last measured sample.
        dlSpring.set(lr.downMbps);
        text(
          dlSub,
          `live ${fmt.n(lr.downMbps / 8, 2)} MB/s (${fmt.mbps(lr.downMbps)} Mbps)` +
            `${lr.peakDownMbps ? ` · peak ${fmt.mbps(lr.peakDownMbps)} Mbps` : ''}` +
            ` · last test ${d ? fmt.mbps(d.mbps) : '—'} Mbps`
        );
      } else if (d) {
        dlSpring.set(d.mbps);
        const share = s.settings.planDownMbps ? Math.round((d.mbps / s.settings.planDownMbps) * 100) : null;
        const dlHist = ctx.history('down');
        const prev = dlHist.length > 1 ? dlHist[dlHist.length - 2][1] : null;
        const delta = prev ? Math.round((d.mbps - prev) * 100) / 100 : null;
        text(dlSub, `${fmt.mbs(d.mbps)} MB/s · ${d.streamsOk}/${d.streams} streams · ${share != null ? `${share}% of ${s.settings.planDownMbps} Mbps plan` : 'no plan set'}` +
          `${delta != null ? ` · ${delta >= 0 ? '+' : ''}${delta} vs prev` : ''} · ${fmt.ago(d.at)}`);
        dlMinis.replaceChildren(
          mini('aggregate', `${fmt.mbps(d.mbps, 2)} Mbps`),
          mini('stream-sum', `${fmt.mbps(d.mbpsStreamSum, 2)}`),
          mini('per-stream', `${fmt.mbps(d.mbpsPerStreamMin, 1)}–${fmt.mbps(d.mbpsPerStreamMax, 1)}`),
          mini('spread', `${fmt.n(d.spreadPct, 1)}%`, NP.severity(d.spreadPct, 15, 35)),
          mini('ttfb', `${fmt.ms(d.ttfbMs, 0)} ms`),
          mini('volume', fmt.bytes(d.totalBytes))
        );
      }
      const upMoving = lr.upMbps != null && (s.overhead.busy || lr.upMbps >= 0.5);
      if (upMoving) {
        ulSpring.set(lr.upMbps);
        text(
          ulSub,
          `live ${fmt.n(lr.upMbps / 8, 2)} MB/s (${fmt.mbps(lr.upMbps)} Mbps)` +
            `${lr.peakUpMbps ? ` · peak ${fmt.mbps(lr.peakUpMbps)} Mbps` : ''}` +
            ` · last test ${u ? fmt.mbps(u.mbps) : '—'} Mbps`
        );
      } else if (u) {
        ulSpring.set(u.mbps);
        const share = s.settings.planUpMbps ? Math.round((u.mbps / s.settings.planUpMbps) * 100) : null;
        ulSub.textContent = `${fmt.mbs(u.mbps)} MB/s · ${u.streamsOk}/${u.streams} streams · ${share != null ? `${share}% of ${s.settings.planUpMbps} Mbps plan` : 'no plan set'} · ${fmt.ago(u.at)}`;
        ulMinis.replaceChildren(
          mini('aggregate', `${fmt.mbps(u.mbps, 2)} Mbps`),
          mini('MB/s', fmt.mbs(u.mbps)),
          mini('ttfb', `${fmt.ms(u.ttfbMs, 0)} ms`),
          mini('volume', fmt.bytes(u.totalBytes)),
          mini('streams', String(u.streams)),
          mini('codes', (u.httpCodes || []).join(','))
        );
      }
      if (lastDlStamp !== (d && d.finishedAt)) {
        lastDlStamp = d && d.finishedAt;
        if (d) ctx.pushHistory('down', d);
      }
      if (lastUlStamp !== (u && u.finishedAt)) {
        lastUlStamp = u && u.finishedAt;
        if (u) ctx.pushHistory('up', u);
      }
      const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim();
      const good = getComputedStyle(document.body).getPropertyValue('--ok').trim() || '#34d399';
      dlSeries.setSeries([
        { key: 'down', label: 'download test', color: accent, points: ctx.history('down') },
        { key: 'live', label: 'link now', color: good, points: liveDown },
      ]);
      dlSeries.setRefLines(s.settings.planDownMbps ? [{ value: s.settings.planDownMbps, label: `plan ${s.settings.planDownMbps}`, color: 'rgba(200,225,255,.35)' }] : []);
      ulSeries.setSeries([
        { key: 'up', label: 'upload test', color: '#a78bfa', points: ctx.history('up') },
        { key: 'live', label: 'link now', color: good, points: liveUp },
      ]);
      ulSeries.setRefLines(s.settings.planUpMbps ? [{ value: s.settings.planUpMbps, label: `plan ${s.settings.planUpMbps}`, color: 'rgba(200,225,255,.35)' }] : []);

      liveSeries.windowSec = s.settings.chartWindowSec;
      liveSeries.setSeries(s.latency.targets.map((t) => ({ key: t.host, label: t.label, color: t.color, points: t.samples.slice(-600) })));
      const legendSig = s.latency.targets.map((t) => `${t.host}:${t.stats.avg}:${t.stats.lossPct}`).join('|');
      if (legend.dataset.sig !== legendSig) {
        legend.dataset.sig = legendSig;
        legend.replaceChildren(
          ...s.latency.targets.map((t) =>
            el('span', {}, [
              el('i', { style: { background: t.color } }),
              `${t.label} ${fmt.ms(t.stats.avg, 0)} ms${t.stats.lossPct ? ` · ${fmt.n(t.stats.lossPct, 1)}% loss` : ''}`,
            ])
          )
        );
      }

      if (gauge) gauge.set(s.quality.score || 0);
      const keys = ['latency', 'loss', 'download', 'upload', 'bufferbloat'];
      const dims = s.quality.dimensions.filter((dd) => keys.includes(dd.key));
      const qSig = dims.map((dd) => `${dd.key}:${dd.value}:${dd.grade}`).join('|');
      if (qualityList.dataset.sig !== qSig) {
        qualityList.dataset.sig = qSig;
        qualityList.replaceChildren(
          ...dims.map((dd) =>
            el('div', { class: 'kv' }, [
              el('span', { class: 'k', text: dd.label }),
              el('span', { class: 'v', text: `${dd.value == null ? '—' : dd.value} ${dd.unit}` }),
              el('span', { class: `pill ${NP.gradeClass(dd.grade) === 'a' ? 'ok' : NP.gradeClass(dd.grade) === 'c' ? 'warn' : NP.gradeClass(dd.grade) === 'f' ? 'bad' : ''}`, text: dd.grade }),
            ])
          )
        );
      }

      if (flow) flow.setRate(d ? d.mbps : 0);
      const envSig = JSON.stringify([s.link && s.link.interface, s.link && s.link.primary && s.link.primary.linkSpeed, s.isp && s.isp.ip, s.ipv6 && s.ipv6.available, s.mtu && s.mtu.verdict, s.overhead.cpuPct]);
      if (envList.dataset.sig !== envSig) {
        envList.dataset.sig = envSig;
        envList.replaceChildren(
          NP.stat('interface', s.link && s.link.interface ? s.link.interface : '—'),
          NP.stat('link', s.link && s.link.primary ? s.link.primary.linkSpeed : '—', s.link && s.link.primary && s.link.primary.linkBottleneck ? 'warn' : ''),
          NP.stat('mtu live/path', s.mtu ? `${s.mtu.liveMtu ?? '—'}/${s.mtu.pathMtu ?? '—'}` : '—', s.mtu && s.mtu.verdict === 'blackhole' ? 'bad' : 'ok'),
          NP.stat('isp', s.isp && s.isp.ok ? `${s.isp.asn || ''}`.trim() || '—' : '—'),
          NP.stat('ipv6', s.ipv6 ? (s.ipv6.available ? 'yes' : 'no') : '…'),
          NP.stat('monitor cpu', `${fmt.n(s.overhead.cpuPct, 1)}%`, s.overhead.cpuPct > 4 ? 'warn' : '')
        );
      }

      const ta = s.topApps;
      const appRows = (ta && ta.rows) || [];
      const linkTxt = s.linkRate && s.linkRate.downMbps != null ? `link ↓${fmt.mbps(s.linkRate.downMbps)} Mbps · ` : '';
      text(appsNote, `${linkTxt}per-app I/O incl. disk; Windows has no public per-app network counter`);
      const appSig = `${ta && ta.at}|${appRows.map((r) => `${r.name}:${r.mbs}`).join(',')}`;
      if (appsList.dataset.sig !== appSig) {
        appsList.dataset.sig = appSig;
        if (!appRows.length) {
          appsList.replaceChildren(
            el('div', {
              class: 'app-empty',
              text: ta && ta.error
                ? ta.error
                : s.overhead && s.overhead.busy
                  ? 'speed test running (this app, not counted)'
                  : s.linkRate && s.linkRate.downMbps > 0.3
                    ? 'measuring...'
                    : 'link is idle',
            })
          );
        } else {
          const max = Math.max(...appRows.map((r) => r.mbs), 0.01);
          appsList.replaceChildren(
            ...appRows.slice(0, 5).map((r, i) =>
              el('div', { class: 'app-row', title: `${r.name} · ${fmt.n(r.mbs, 2)} MB/s · ${fmt.n(r.totalMb || 0, 0)} MB this session` }, [
                el('span', { class: 'app-rank', text: String(i + 1) }),
                el('span', { class: 'app-name', text: r.name }),
                el('span', { class: 'app-bar' }, [el('i', { style: { width: `${Math.max(3, Math.round((r.mbs / max) * 100))}%` } })]),
                el('span', { class: 'app-val', text: fmt.n(r.mbs, 2) }),
              ])
            )
          );
        }
      }

      const latest = s.events.slice(-5).reverse();
      const evSig = latest.map((e) => e.t).join(',');
      if (eventsList.dataset.sig !== evSig) {
        eventsList.dataset.sig = evSig;
        eventsList.replaceChildren(
          ...(latest.length
            ? latest.map((e) => el('div', { class: `event ${e.level}` }, [el('time', { text: fmt.clock(e.t) }), el('div', { text: e.msg })]))
            : [el('div', { class: 'muted', style: { fontSize: '11px' }, text: 'no events yet — probes are quiet' })])
        );
      }
    }

    function frame(dt) {
      readout.tick(dt);
      dlSpring.tick(dt);
      ulSpring.tick(dt);
      if (spark) spark.draw();
      if (liveSeries) liveSeries.draw();
      if (dlSeries) dlSeries.draw();
      if (ulSeries) ulSeries.draw();
      if (gauge) gauge.draw(dt);
      if (flow) flow.draw(dt);
    }

    return { node: root, update, frame };
  };
})();