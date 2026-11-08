'use strict';
/* Formatting + DOM helpers. No framework: everything is a plain element. */
(function () {
  const NP = (window.NP = window.NP || {});

  const fmt = {
    n(v, d = 0) {
      if (v == null || Number.isNaN(v)) return '—';
      return Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
    },
    ms(v, d = 0) {
      if (v == null || Number.isNaN(v)) return '—';
      const n = Number(v);
      return n < 10 ? n.toFixed(Math.min(2, d + 1)) : n.toFixed(d);
    },
    mbps(v, d = 1) {
      if (v == null || Number.isNaN(v)) return '—';
      return Number(v).toFixed(v >= 100 ? 0 : d);
    },
    mbs(mbps) {
      if (mbps == null) return '—';
      return (mbps / 8).toFixed(mbps / 8 >= 100 ? 0 : 1);
    },
    bytes(b) {
      if (b == null) return '—';
      const u = ['B', 'KB', 'MB', 'GB', 'TB'];
      let i = 0;
      let v = Number(b);
      while (v >= 1024 && i < u.length - 1) {
        v /= 1024;
        i += 1;
      }
      return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
    },
    ago(t) {
      if (!t) return '—';
      const s = Math.max(0, Math.round((Date.now() - t) / 1000));
      if (s < 60) return `${s}s ago`;
      if (s < 3600) return `${Math.round(s / 60)}m ago`;
      return `${Math.round(s / 3600)}h ago`;
    },
    clock(t) {
      const d = new Date(t || Date.now());
      return d.toTimeString().slice(0, 8);
    },
    dur(sec) {
      if (sec == null) return '—';
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = Math.floor(sec % 60);
      return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
    },
  };

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      // DOM event names are lowercase and case-sensitive: 'onClick' must become
      // 'click', never 'Click' (addEventListener is case-sensitive for event
      // types, so 'Click' binds nothing and the control is silently dead).
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c == null || c === false) continue;
      node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  /** Text write that skips identical values: every avoided write is a skipped
      style/layout invalidation, and the HUD rewrites ~10 nodes per sample. */
  function text(node, value) {
    if (!node) return;
    const s = value == null ? '' : String(value);
    if (node.textContent !== s) node.textContent = s;
  }

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function card(title, opts = {}) {
    const head = el('div', { class: 'card-head' }, [
      el('div', { class: 'card-title' }, [title, opts.sub ? el('span', { class: 'card-sub', text: opts.sub }) : null]),
      opts.actions ? el('div', { class: 'card-actions' }, opts.actions) : null,
    ]);
    const body = el('div', { class: `card-body ${opts.bodyClass || ''}`.trim() });
    const node = el('section', { class: `card${opts.class ? ` ${opts.class}` : ''}` }, [head, body]);
    return { node, body, head };
  }

  /* Canvas inside a flex-filling box: the canvas is absolutely positioned so the
     layout can never be pushed around by the drawing surface. */
  function plot(canvas, size = '') {
    return el('div', { class: `plot ${size}`.trim() }, [canvas]);
  }

  function stat(k, v, cls = '') {
    return el('div', { class: 'stat' }, [el('div', { class: 'stat-k', text: k }), el('div', { class: `stat-v ${cls}`, text: v })]);
  }

  function mini(k, v, cls = '') {
    return el('div', { class: 'mini' }, [el('div', { class: 'mini-k', text: k }), el('div', { class: `mini-v ${cls}`, text: v })]);
  }

  function toast(msg, kind = '', ms = 4200) {
    const box = document.getElementById('toasts');
    if (!box) return;
    const t = el('div', { class: `toast ${kind}`, text: msg });
    box.append(t);
    setTimeout(() => {
      t.style.opacity = '0';
      t.style.transform = 'translateY(6px)';
      setTimeout(() => t.remove(), 240);
    }, ms);
  }

  /** Range input with a live value bubble and a filled track. */
  function slider({ label, min, max, step = 1, value, unit = '', format, onInput, onCommit }) {
    const vLabel = el('span', { class: 'v', text: `${value}${unit}` });
    const input = el('input', { type: 'range', min, max, step, value, 'aria-label': label });
    const paint = () => {
      const pct = ((input.value - min) / (max - min)) * 100;
      input.style.setProperty('--fill', `${pct}%`);
      vLabel.textContent = `${format ? format(Number(input.value)) : input.value}${unit}`;
    };
    input.addEventListener('input', () => {
      paint();
      if (onInput) onInput(Number(input.value));
    });
    input.addEventListener('change', () => onCommit && onCommit(Number(input.value)));
    paint();
    return {
      node: el('label', { class: 'field' }, [
        el('div', { class: 'label-row' }, [el('span', { class: 'k', text: label }), vLabel]),
        input,
      ]),
      input,
      set(v) {
        input.value = v;
        paint();
      },
    };
  }

  function toggle({ label, checked, onChange }) {
    const input = el('input', { type: 'checkbox' });
    input.checked = Boolean(checked);
    input.addEventListener('change', () => onChange(input.checked));
    return { node: el('label', { class: 'toggle' }, [input, el('span', { text: label })]), input };
  }

  function seg({ options, value, onChange }) {
    const wrap = el('div', { class: 'seg' });
    const buttons = options.map((o) => {
      const b = el('button', { class: o.key === value ? 'active' : '', text: o.label, onClick: () => { set(o.key); onChange(o.key); } });
      return b;
    });
    function set(key) { buttons.forEach((x, i) => x.classList.toggle('active', options[i].key === key)); }
    buttons.forEach((b) => wrap.append(b));
    return { node: wrap, buttons, set };
  }

  function gradeClass(g) {
    if (!g) return '';
    if (g.startsWith('A')) return 'a';
    if (g.startsWith('B')) return '';
    if (g.startsWith('C')) return 'c';
    return 'f';
  }

  function gradeChip(g, note) {
    return el('div', { class: 'row' }, [
      el('div', { class: `grade ${gradeClass(g)}`, text: g || '?' }),
      note ? el('div', { class: 'muted', style: { fontSize: '12px' }, text: note }) : null,
    ]);
  }

  /** Colour a value by how bad it is; used across the readouts. */
  function severity(v, warnAt, badAt) {
    if (v == null) return '';
    if (v >= badAt) return 'bad';
    if (v >= warnAt) return 'warn';
    return 'ok';
  }

  Object.assign(NP, { fmt, el, text, $, $$, card, plot, stat, mini, toast, slider, toggle, seg, gradeClass, gradeChip, severity });
})();
