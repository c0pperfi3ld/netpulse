'use strict';
/* Diagnostics: NIC negotiation, path MTU, resolver speed, ISP identity, storage
   and the event log - laid out to fit one screen. */
(function () {
  const NP = (window.NP = window.NP || {});
  NP.views = NP.views || {};
  const { el, fmt, card, mini, plot, toast } = NP;

  NP.views.diagnostics = function diagnostics(ctx) {
    let snap = null;
    let ladder = null;
    let dnsBars = null;

    const linkIssues = el('div', { class: 'stack' });
    const linkTable = el('div', { class: 'tbl-wrap' });
    const linkCard = card('Link layer', {
      sub: 'NIC negotiation is the invisible ceiling',
      actions: [el('button', { class: 'btn sm', text: 'Re-probe', onClick: () => ctx.runTest('env') })],
      bodyClass: 'fill',
    });
    linkCard.body.append(linkIssues, linkTable);

    const mtuVerdict = el('div', { class: 'warn-box ok', text: 'probing…' });
    const mtuStats = el('div', { class: 'stat-grid' });
    const ladderCanvas = el('canvas');
    const fixCmd = el('div', { class: 'cmd', hidden: '', text: '' });
    const mtuCard = card('Path MTU', {
      sub: 'silent drops here cause stalls and VPN failures',
      actions: [
        el('button', { class: 'btn sm', text: 'Probe', onClick: () => ctx.runTest('mtu') }),
        el('button', { class: 'btn sm', text: 'Copy fix', onClick: async () => { if (snap && snap.mtu && snap.mtu.fixCommand) { await ctx.copy(snap.mtu.fixCommand); toast('MTU command copied'); } } }),
        el('button', { class: 'btn sm danger', text: 'Apply', onClick: async () => { const r = await ctx.applyMtu(); toast(r.ok ? `MTU applied (live ${r.mtu && r.mtu.liveMtu})` : `not applied: ${r.error || 'declined'}`, r.ok ? '' : 'warn'); } }),
        el('button', { class: 'btn sm', text: 'Revert', onClick: async () => { const r = await ctx.revertMtu(); toast(r.ok ? 'reverted to 1500' : 'revert failed', r.ok ? '' : 'warn'); } }),
      ],
      bodyClass: 'fill',
    });
    mtuCard.body.append(mtuVerdict, mtuStats, fixCmd, plot(ladderCanvas));

    const dnsChart = el('canvas');
    const dnsTable = el('div', { class: 'tbl-wrap' });
    const dnsCard = card('DNS resolvers', {
      sub: 'affects every first load',
      actions: [el('button', { class: 'btn sm', text: 'Bench', onClick: () => ctx.runTest('dns') })],
      bodyClass: 'fill',
    });
    dnsCard.body.append(plot(dnsChart, 'fixed-sm'), dnsTable);

    const eventsBody = el('div', { class: 'list' });
    const eventsCard = card('Event log', { sub: 'rule engine output', bodyClass: 'fill' });
    eventsCard.body.append(eventsBody);

    const ispBody = el('div', { class: 'stat-grid' });
    const storageBody = el('div', { class: 'stat-grid' });
    const ispCard = card('Identity & storage', {
      sub: 'public IP, ASN, protocol, history',
      actions: [
        el('button', { class: 'btn sm', text: 'Report', onClick: () => ctx.previewReport() }),
        el('button', { class: 'btn sm', text: 'Folder', onClick: async () => { const st = await ctx.dataStats(); await ctx.openPath(st.dir); } }),
      ],
      bodyClass: 'fill',
    });
    ispCard.body.append(ispBody, storageBody);

    const root = el('div', { class: 'view-grid rows-even' }, [
      el('div', { class: 'cols-2' }, [linkCard.node, mtuCard.node]),
      el('div', { class: 'cols-3' }, [dnsCard.node, eventsCard.node, ispCard.node]),
    ]);

    function ensure() {
      if (!ladder) {
        ladder = new NP.Ladder(ladderCanvas);
        dnsBars = new NP.Bars(dnsChart, { suffix: ' ms', rowH: 21 });
      }
    }

    function update(s) {
      snap = s;
      ensure();

      const linkSig = JSON.stringify((s.link && s.link.adapters ? s.link.adapters : []).map((a) => [a.name, a.linkSpeed, a.status]));
      if (linkTable.dataset.sig !== linkSig) {
        linkTable.dataset.sig = linkSig;
        linkTable.replaceChildren(
          el('table', { class: 'data' }, [
            el('thead', {}, [el('tr', {}, [
              el('th', { text: 'iface', style: { width: '30%' } }),
              el('th', { text: 'negotiated', style: { width: '22%' } }),
              el('th', { text: 'state', style: { width: '16%' } }),
              el('th', { text: 'kind' }),
            ])]),
            el('tbody', {}, (s.link && s.link.adapters ? s.link.adapters : []).map((a) => el('tr', { title: `${a.description} · ${a.mac || ''}` }, [
              el('td', { text: a.name }),
              el('td', { text: a.linkSpeed || '—', style: a.linkBottleneck ? { color: 'var(--warn)' } : {} }),
              el('td', { text: a.status }),
              el('td', { text: a.gigabitCapable ? (a.linkBottleneck ? 'GbE → 100M' : 'GbE') : a.virtual ? 'virtual' : 'FE' }),
            ]))),
          ])
        );
      }
      const issues = (s.link && s.link.issues) || [];
      const issueSig = issues.map((i) => i.code).join(',');
      if (linkIssues.dataset.sig !== issueSig) {
        linkIssues.dataset.sig = issueSig;
        linkIssues.replaceChildren(
          ...(issues.length
            ? issues.map((i) => el('div', { class: 'warn-box warn' }, [el('strong', { text: i.title }), el('p', { text: i.detail })]))
            : [el('div', { class: 'warn-box ok' }, [el('strong', { text: 'No link-layer problems' }), el('p', { text: 'Negotiated speed matches the hardware.' })])])
        );
      }

      if (s.mtu) {
        const m = s.mtu;
        mtuVerdict.className = `warn-box ${m.verdict === 'ok' ? 'ok' : m.verdict === 'blackhole' ? 'bad' : 'warn'}`;
        mtuVerdict.replaceChildren(
          el('strong', { text: `${m.verdict === 'ok' ? 'Healthy' : m.verdict === 'blackhole' ? 'PMTUD black hole' : m.verdict} · adapter ${m.liveMtu ?? '?'} / path ${m.pathMtu ?? '?'}` }),
          el('p', { text: m.advice })
        );
        mtuStats.replaceChildren(
          mini('adapter', String(m.liveMtu ?? '—')),
          mini('path', String(m.pathMtu ?? '—')),
          mini('max payload', String(m.payloadMax ?? '—')),
          mini('frag signal', m.fragSignalled ? 'yes' : 'no'),
          mini('persistent', m.persistentMatchesLive ? 'set' : 'no'),
          mini('iface', m.iface || '—')
        );
        ladder.setRows(m.ladder || []);
        fixCmd.hidden = !m.fixCommand;
        fixCmd.textContent = m.fixCommand || '';
      }

      if (s.dns) {
        dnsBars.setRows(s.dns.rows.map((r) => ({ label: r.label, value: r.avgMs, color: r.label === s.dns.fastest ? '#34d399' : undefined })));
        const dnsSig = s.dns.rows.map((r) => `${r.label}:${r.avgMs}`).join('|');
        if (dnsTable.dataset.sig !== dnsSig) {
          dnsTable.dataset.sig = dnsSig;
          dnsTable.replaceChildren(
            el('table', { class: 'data' }, [
              el('thead', {}, [el('tr', {}, [
                el('th', { text: 'resolver' }), el('th', { text: 'avg' }), el('th', { text: 'min' }), el('th', { text: 'max' }), el('th', { text: 'recurs' }),
              ])]),
              el('tbody', {}, s.dns.rows.map((r) => el('tr', {}, [
                el('td', { text: r.label }),
                el('td', { text: fmt.ms(r.avgMs, 1) }),
                el('td', { text: fmt.ms(r.minMs, 1) }),
                el('td', { text: fmt.ms(r.maxMs, 0) }),
                el('td', { text: fmt.ms(r.recursiveAvgMs, 1) }),
              ]))),
            ])
          );
        }
      }

      const evSig = s.events.map((e) => e.t).join(',');
      if (eventsBody.dataset.sig !== evSig) {
        eventsBody.dataset.sig = evSig;
        eventsBody.replaceChildren(
          ...(s.events.length
            ? s.events.slice(-10).reverse().map((e) => el('div', { class: `event ${e.level}` }, [
                el('time', { text: fmt.clock(e.t) }),
                el('div', { text: e.msg }),
              ]))
            : [el('div', { class: 'muted', style: { fontSize: '11px' }, text: 'no events yet' })])
        );
      }

      const idSig = JSON.stringify([s.isp && s.isp.ip, s.ipv6 && s.ipv6.available, s.link && s.link.mac, s.link && s.link.ip && s.link.ip.dns]);
      if (ispBody.dataset.sig !== idSig) {
        ispBody.dataset.sig = idSig;
        ispBody.replaceChildren(
          mini('public ip', s.isp && s.isp.ok ? s.isp.ip : '—'),
          mini('ASN', s.isp && s.isp.ok ? s.isp.asn || '—' : '—'),
          mini('carrier', s.isp && s.isp.ok ? (s.isp.org || '').replace(/^AS\d+\s*/, '') : '—'),
          mini('location', s.isp && s.isp.ok ? `${s.isp.city}, ${s.isp.country}` : '—'),
          mini('IPv6', s.ipv6 ? (s.ipv6.available ? 'yes' : 'no') : '…'),
          mini('gateway', s.link && s.link.ip && s.link.ip.gateways[0] ? s.link.ip.gateways[0] : '—'),
          mini('dns', s.link && s.link.ip && s.link.ip.dns.length ? s.link.ip.dns.join(', ') : '—'),
          mini('mac', s.link && s.link.mac ? s.link.mac : '—')
        );
      }

      ctx.dataStats().then((st) => {
        const sig = `${st.files}:${st.bytes}:${s.overhead.children}:${Math.round(s.overhead.cpuPct)}`;
        if (storageBody.dataset.sig === sig) return;
        storageBody.dataset.sig = sig;
        storageBody.replaceChildren(
          mini('history files', String(st.files)),
          mini('history size', fmt.bytes(st.bytes)),
          mini('retention', `${s.settings.historyKeepDays} d`),
          mini('probes', String(s.overhead.children)),
          mini('monitor cpu', `${fmt.n(s.overhead.cpuPct, 1)}%`),
          mini('uptime', fmt.dur(s.overhead.uptimeSec))
        );
      });
    }

    function frame() {
      if (ladder) ladder.draw();
      if (dnsBars) dnsBars.draw();
    }

    return { node: root, update, frame };
  };
})();