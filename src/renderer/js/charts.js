'use strict';
/* Canvas chart primitives, hand-rolled so the app ships without a chart library.

   Accuracy/polish rules encoded here:
     - axis labels never collide with the panel edge: every plot reserves real
       padding and clips to its own box
     - curves are monotone-cubic smoothed (no overshoot below measured values)
     - every series carries its unit in the tooltip and the axis caption
     - 1px grid lines land on device pixels, so nothing looks half-lit
     - empty states say so instead of drawing an empty box

   Performance contract: draw() is a pure read of already-computed arrays, one
   ResizeObserver per canvas, DPR-aware backing store, no per-frame allocation
   beyond the stroked path. */
(function () {
  const NP = (window.NP = window.NP || {});
  const { el } = NP;

  const tooltip = el('div', { class: 'tooltip', hidden: '' });
  const ready = () => {
    if (!tooltip.isConnected) document.body.append(tooltip);
  };

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.body).getPropertyValue(name).trim();
    return v || fallback;
  }

  /* Every chart registers itself so a theme or accent flip can force exactly one
     repaint, instead of leaving stale dark ink on canvas after the DOM went
     light (or the other way round). */
  const registry = new Set();
  NP.invalidateCharts = () => {
    for (const c of registry) c._dirty = true;
  };

  const hexA = (hex, alpha) => {
    const h = String(hex).replace('#', '');
    if (h.length !== 6) return hex;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  };

  /** Pick a readable precision for an axis label. */
  function axisFmt(v, span) {
    if (v == null) return '';
    if (span < 3) return v.toFixed(2);
    if (span < 12) return v.toFixed(1);
    if (span < 120) return v.toFixed(0);
    return v >= 1000 ? `${Math.round(v / 100) / 10}k` : v.toFixed(0);
  }

  class CanvasBase {
    constructor(canvas, { onHover } = {}) {
      this.canvas = canvas;
      // Data charts repaint only when their inputs change. The views still call
      // draw() from their rAF loop, so this is what stops an idle dashboard from
      // re-stroking every curve 60 times a second.
      this._dirty = true;
      registry.add(this);
      this.onHover = onHover;
      this.ctx = canvas.getContext('2d');
      this.w = 0;
      this.h = 0;
      this.dpr = 1;
      this.mouse = null;
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(canvas.parentElement || canvas);
      if (onHover) {
        canvas.addEventListener('mousemove', (e) => {
          const r = canvas.getBoundingClientRect();
          this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
        });
        canvas.addEventListener('mouseleave', () => {
          this.mouse = null;
          tooltip.hidden = true;
        });
      }
      this.resize();
    }

    resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(10, Math.round(rect.width));
      const h = Math.max(10, Math.round(rect.height));
      if (w === this.w && h === this.h && this.dpr === dpr) return;
      this.w = w;
      this.h = h;
      this.dpr = dpr;
      this._dirty = true;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    clear() {
      this.ctx.clearRect(0, 0, this.w, this.h);
    }


    showTip(x, y, lines) {
      ready();
      tooltip.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
      tooltip.hidden = false;
      const r = this.canvas.getBoundingClientRect();
      const tw = tooltip.offsetWidth || 140;
      const th = tooltip.offsetHeight || 40;
      let left = r.left + x + 14;
      if (left + tw > window.innerWidth - 8) left = Math.max(8, r.left + x - tw - 14);
      let top = r.top + y - th / 2;
      top = Math.max(8, Math.min(window.innerHeight - th - 8, top));
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    }

    hideTip() {
      tooltip.hidden = true;
    }
    destroy() {
      this.ro.disconnect();
    }
  }

  /* --------------------------------------------------------------- smoothing */
  /** Monotone cubic interpolation (Fritsch-Carlson): smooth, never overshoots. */
  function smoothPath(ctx, pts) {
    if (!pts.length) return;
    if (pts.length < 3) {
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i][0], pts[i][1]);
      return;
    }
    const n = pts.length;
    const dx = [];
    const dy = [];
    const slope = [];
    for (let i = 0; i < n - 1; i += 1) {
      dx[i] = pts[i + 1][0] - pts[i][0];
      dy[i] = pts[i + 1][1] - pts[i][1];
      slope[i] = dx[i] === 0 ? 0 : dy[i] / dx[i];
    }
    const m = [slope[0]];
    for (let i = 1; i < n - 1; i += 1) {
      if (slope[i - 1] * slope[i] <= 0) m[i] = 0;
      else m[i] = (slope[i - 1] + slope[i]) / 2;
    }
    m[n - 1] = slope[n - 2];
    for (let i = 0; i < n - 1; i += 1) {
      if (slope[i] === 0) {
        m[i] = 0;
        m[i + 1] = 0;
        continue;
      }
      const a = m[i] / slope[i];
      const b = m[i + 1] / slope[i];
      const h = Math.hypot(a, b);
      if (h > 3) {
        m[i] = (3 / h) * a * slope[i];
        m[i + 1] = (3 / h) * b * slope[i];
      }
    }
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 0; i < n - 1; i += 1) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      const h = (x1 - x0) / 3;
      ctx.bezierCurveTo(x0 + h, y0 + m[i] * h, x1 - h, y1 - m[i + 1] * h, x1, y1);
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, h / 2, w / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function truncate(ctx, text, maxW) {
    let t = String(text);
    if (ctx.measureText(t).width <= maxW) return t;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
    return `${t}…`;
  }

  function emptyState(ctx, w, h, text) {
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillStyle = cssVar('--txt-2', '#7d8caa');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2);
  }

  /* ---------------------------------------------------------------- TimeSeries */
  class TimeSeries extends CanvasBase {
    constructor(canvas, opts = {}) {
      super(canvas, { onHover: true });
      this.windowSec = opts.windowSec || 120;
      this.series = [];
      this.yMax = opts.yMax || null;
      this.area = opts.area !== false;
      this.lossMarkers = opts.lossMarkers !== false;
      this.unit = opts.unit || 'ms';
      this.refLines = opts.refLines || [];
      this.smooth = opts.smooth !== false;
      this.smoothY = { max: opts.yMax || 10 };
      this.pad = { l: 38, r: 8, t: 10, b: 16 };
      this.showLoss = true;
      this.draw();
    }

    setSeries(list) {
      this._dirty = true;
      this.series = list.map((s) => ({ ...s, points: s.points || [] }));
    }

    setRefLines(lines) {
      this._dirty = true;
      this.refLines = lines || [];
    }

    visibleRanges() {
      const now = Date.now();
      const full = this.windowSec * 1000;
      // Grow the window into the data. A series that is 30 s old used to be
      // squeezed into the last pixels of a 135 s axis, which reads as "no graph
      // at all" on a fresh start.
      let first = now;
      for (const s of this.series) {
        if (s.points.length) first = Math.min(first, s.points[0][0]);
      }
      const span = Math.max(20_000, Math.min(full, now - first + 6_000));
      const since = now - span;
      let max = 0;
      const out = this.series.map((s) => {
        const pts = [];
        for (const p of s.points) {
          if (p[0] < since) continue;
          if (typeof p[1] === 'number') max = Math.max(max, p[1]);
          pts.push(p);
        }
        return { ...s, visible: pts };
      });
      return { out, max, now, since, span };
    }

    draw() {
      // Never consume the dirty flag on a canvas that has no size yet: the view
      // is built detached, and eating the flag there left it blank until the
      // next data change.
      if (!this._dirty) return;
      if (this.w < 40 || this.h < 30) return;
      this._dirty = false;
      const ctx = this.ctx;
      this.clear();
      const { out, max, since, span } = this.visibleRanges();
      const P = this.pad;
      const plotW = this.w - P.l - P.r;
      const plotH = this.h - P.t - P.b;
      if (plotW < 10 || plotH < 10) return;

      const hasData = out.some((s) => s.visible.length);
      const target = this.yMax || Math.max(4, max * 1.18);
      this.smoothY.max += (target - this.smoothY.max) * 0.2;
      // Keep asking for frames while the y-axis is still easing into place.
      if (Math.abs(target - this.smoothY.max) > 0.05) this._dirty = true;
      const yTop = this.yMax || this.smoothY.max;
      const xOf = (t) => P.l + Math.max(0, Math.min(1, (t - since) / span)) * plotW;
      const yOf = (v) => P.t + plotH - Math.max(0, Math.min(1, v / (yTop || 1))) * plotH;

      // --- grid: horizontal value lines + vertical time lines
      const steps = 4;
      ctx.font = '9.5px ui-monospace, monospace';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 1;
      for (let i = 0; i <= steps; i += 1) {
        const v = (yTop / steps) * i;
        const y = Math.round(yOf(v)) + 0.5;
        ctx.strokeStyle = i === 0 ? cssVar('--line', 'rgba(120,160,220,.16)') : cssVar('--grid', 'rgba(120,160,220,.09)');
        ctx.beginPath();
        ctx.moveTo(P.l, y);
        ctx.lineTo(this.w - P.r, y);
        ctx.stroke();
        ctx.fillStyle = cssVar('--txt-2', '#7d8caa');
        ctx.textAlign = 'right';
        ctx.fillText(axisFmt(v, yTop), P.l - 7, y);
      }
      for (let i = 0; i <= 3; i += 1) {
        const t = since + (span * i) / 3;
        const x = Math.round(xOf(t)) + 0.5;
        ctx.strokeStyle = cssVar('--grid', 'rgba(120,160,220,.07)');
        ctx.beginPath();
        ctx.moveTo(x, P.t);
        ctx.lineTo(x, P.t + plotH);
        ctx.stroke();
        ctx.fillStyle = cssVar('--txt-2', '#7d8caa');
        ctx.textAlign = i === 0 ? 'left' : i === 3 ? 'right' : 'center';
        const d = new Date(t);
        ctx.fillText(`${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`, x, this.h - 10);
      }
      // unit caption
      ctx.textAlign = 'left';
      ctx.fillStyle = cssVar('--txt-2', '#7d8caa');
      ctx.fillText(this.unit, 2, P.t - 4);

      // --- reference lines (p50/p95, plan level, threshold)
      for (const ref of this.refLines) {
        if (ref.value == null || ref.value > yTop) continue;
        const y = Math.round(yOf(ref.value)) + 0.5;
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = ref.color || cssVar('--chart-ink-faint', 'rgba(200,225,255,.28)');
        ctx.beginPath();
        ctx.moveTo(P.l, y);
        ctx.lineTo(this.w - P.r, y);
        ctx.stroke();
        ctx.restore();
        if (ref.label) {
          ctx.font = '9px ui-monospace, monospace';
          ctx.fillStyle = ref.color || cssVar('--chart-ink-dim', 'rgba(200,225,255,.5)');
          ctx.textAlign = 'right';
          ctx.fillText(ref.label, this.w - P.r - 2, y - 6);
        }
      }

      if (!hasData) {
        emptyState(ctx, this.w, this.h, 'waiting for samples');
        return;
      }

      for (const s of out) {
        if (!s.visible.length) continue;
        const coords = s.visible.filter((p) => p[1] != null).map((p) => [xOf(p[0]), yOf(p[1])]);
        if (coords.length) {
          if (this.area && out.length === 1) {
            const grad = ctx.createLinearGradient(0, P.t, 0, P.t + plotH);
            grad.addColorStop(0, hexA(s.color, 0.34));
            grad.addColorStop(0.6, hexA(s.color, 0.10));
            grad.addColorStop(1, hexA(s.color, 0));
            ctx.beginPath();
            smoothPath(ctx, coords);
            ctx.lineTo(coords[coords.length - 1][0], P.t + plotH);
            ctx.lineTo(coords[0][0], P.t + plotH);
            ctx.closePath();
            ctx.fillStyle = grad;
            ctx.fill();
          }
          ctx.save();
          ctx.lineWidth = s.width || 1.8;
          ctx.strokeStyle = s.color;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          const glow = NP.motionScale() * 7;
          if (glow > 0) {
            ctx.shadowBlur = glow;
            ctx.shadowColor = hexA(s.color, 0.55);
          }
          ctx.beginPath();
          smoothPath(ctx, coords);
          ctx.stroke();
          ctx.restore();

          const last = coords[coords.length - 1];
          const pulse = 1 + 0.35 * Math.sin(performance.now() / 420) * NP.motionScale();
          ctx.fillStyle = hexA(s.color, 0.22);
          ctx.beginPath();
          ctx.arc(last[0], last[1], 6 * pulse, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = s.color;
          ctx.beginPath();
          ctx.arc(last[0], last[1], 2.6, 0, Math.PI * 2);
          ctx.fill();
        }

        // loss markers: small triangles on the baseline
        if (this.lossMarkers && s.showLoss !== false) {
          ctx.fillStyle = cssVar('--bad', '#fb7185');
          for (const p of s.visible) {
            if (!p[2]) continue;
            const x = xOf(p[0]);
            ctx.beginPath();
            ctx.moveTo(x, P.t + plotH);
            ctx.lineTo(x - 2.4, P.t + plotH - 5);
            ctx.lineTo(x + 2.4, P.t + plotH - 5);
            ctx.closePath();
            ctx.fill();
          }
        }
      }

      // --- crosshair + tooltip
      if (this.mouse && this.mouse.x > P.l && this.mouse.x < this.w - P.r) {
        const mx = this.mouse.x;
        const t = since + ((mx - P.l) / plotW) * span;
        ctx.strokeStyle = cssVar('--chart-ink-faint', 'rgba(200,225,255,.26)');
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(mx, P.t);
        ctx.lineTo(mx, P.t + plotH);
        ctx.stroke();
        const lines = [`<b>${new Date(t).toTimeString().slice(0, 8)}</b>`];
        for (const s of out) {
          let best = null;
          for (const p of s.visible) if (best == null || Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
          if (!best) continue;
          const v = best[1] == null ? '<span style="color:#fb7185">lost</span>' : `<b>${best[1]}</b> ${this.unit}`;
          lines.push(`<span style="color:${s.color}">●</span> ${s.label} ${v}`);
          if (best[1] != null) {
            const cx = xOf(best[0]);
            const cy = yOf(best[1]);
            ctx.fillStyle = s.color;
            ctx.beginPath();
            ctx.arc(cx, cy, 3.4, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = cssVar('--bg-1', '#070b14');
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        }
        this.showTip(mx, this.mouse.y, lines);
      } else if (this.mouse) {
        this.hideTip();
      }
    }
  }

  /* ------------------------------------------------------------------ Sparkline */
  class Sparkline extends CanvasBase {
    constructor(canvas, opts = {}) {
      super(canvas);
      this.color = opts.color || '#4dd4ff';
      this.points = [];
      this.fill = opts.fill !== false;
      this.zeroBaseline = Boolean(opts.zeroBaseline);
    }
    setPoints(points, color) {
      this._dirty = true;
      this.points = points || [];
      if (color) this.color = color;
    }
    draw() {
      if (!this._dirty) return;
      if (this.w < 20 || this.h < 8) return;
      this._dirty = false;
      this.clear();
      const ctx = this.ctx;
      const pts = this.points.filter((p) => typeof p[1] === 'number');
      if (pts.length < 2 || this.w < 20) return;
      const vals = pts.map((p) => p[1]);
      const max = Math.max(...vals);
      const min = this.zeroBaseline ? 0 : Math.min(...vals);
      const span = max - min || Math.max(1, max * 0.1);
      const xOf = (i) => 1 + (i / (pts.length - 1)) * (this.w - 4);
      const yOf = (v) => 3 + (1 - (v - min) / span) * (this.h - 8);
      const coords = pts.map((p, i) => [xOf(i), yOf(p[1])]);
      if (this.fill) {
        const grad = ctx.createLinearGradient(0, 0, 0, this.h);
        grad.addColorStop(0, hexA(this.color, 0.30));
        grad.addColorStop(1, hexA(this.color, 0));
        ctx.beginPath();
        smoothPath(ctx, coords);
        ctx.lineTo(coords[coords.length - 1][0], this.h);
        ctx.lineTo(coords[0][0], this.h);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
      }
      ctx.beginPath();
      smoothPath(ctx, coords);
      ctx.strokeStyle = this.color;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      const glow = NP.motionScale() * 5;
      if (glow > 0) {
        ctx.shadowBlur = glow;
        ctx.shadowColor = hexA(this.color, 0.5);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      const last = coords[coords.length - 1];
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.arc(last[0], last[1], 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* ---------------------------------------------------------------------- Gauge */
  class Gauge extends CanvasBase {
    constructor(canvas, opts = {}) {
      super(canvas);
      this.min = opts.min != null ? opts.min : 0;
      this.max = opts.max != null ? opts.max : 100;
      this.value = opts.value || 0;
      this.shown = this.value;
      this.unit = opts.unit || '';
      this.caption = opts.caption || '';
      this.thresholds = opts.thresholds || null;
      this.ticks = opts.ticks !== false;
    }
    set(v) {
      this.value = v;
    }
    draw() {
      this.clear();
      if (this.w < 40 || this.h < 40) return;
      const ctx = this.ctx;
      const cx = this.w / 2;
      const cy = this.h * 0.74;
      const r = Math.min(this.w / 2 - 16, this.h * 0.62);
      const start = Math.PI * 1.13;
      const end = Math.PI * 1.87;
      const ease = NP.motionScale() === 0 ? 1 : 0.18;
      this.shown += (this.value - this.shown) * ease;
      const norm = Math.max(0, Math.min(1, (this.shown - this.min) / (this.max - this.min || 1)));
      const accent = this.thresholds ? this.thresholds(this.shown) : cssVar('--accent', '#4dd4ff');

      // track
      ctx.lineCap = 'round';
      ctx.lineWidth = 8;
      ctx.strokeStyle = cssVar('--chart-axis', 'rgba(120,160,220,.14)');
      ctx.beginPath();
      ctx.arc(cx, cy, r, start, end);
      ctx.stroke();

      // ticks
      if (this.ticks) {
        for (let i = 0; i <= 10; i += 1) {
          const a = start + ((end - start) * i) / 10;
          const major = i % 5 === 0;
          const r1 = r + 7;
          const r2 = r + (major ? 12 : 10);
          ctx.beginPath();
          ctx.strokeStyle = major
            ? cssVar('--chart-axis-major', 'rgba(200,225,255,.30)')
            : cssVar('--chart-axis-minor', 'rgba(200,225,255,.14)');
          ctx.lineWidth = 1;
          ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
          ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
          ctx.stroke();
        }
      }

      // progress arc with gradient
      const grad = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy);
      grad.addColorStop(0, hexA(accent, 0.55));
      grad.addColorStop(1, accent);
      ctx.lineWidth = 8;
      ctx.strokeStyle = grad;
      ctx.shadowBlur = NP.motionScale() * 12;
      ctx.shadowColor = hexA(accent, 0.55);
      ctx.beginPath();
      ctx.arc(cx, cy, r, start, start + (end - start) * norm);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // value
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = cssVar('--txt-0', '#eaf1ff');
      const size = Math.max(20, Math.round(r * 0.52));
      ctx.font = `600 ${size}px ui-monospace, monospace`;
      ctx.fillText(this.caption || String(Math.round(this.shown)), cx, cy - r * 0.02);
      if (this.unit) {
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillStyle = cssVar('--txt-2', '#7d8caa');
        ctx.fillText(this.unit, cx, cy + 14);
      }
    }
  }

  /* ----------------------------------------------------------------------- Bars */
  class Bars extends CanvasBase {
    constructor(canvas, opts = {}) {
      super(canvas, { onHover: true });
      this.rows = [];
      this.unit = opts.unit || '';
      this.suffix = opts.suffix || '';
      this.rowH = opts.rowH || 20;
      this.colors = opts.colors || null;
      this.pad = { l: 52, r: 56, t: 4, b: 4 };
      this.grid = opts.grid !== false;
    }
    setRows(rows) {
      this._dirty = true;
      this.rows = rows || [];
      this.draw();
    }
    draw() {
      if (!this._dirty) return;
      if (this.w < 60 || this.h < 20) return;
      this._dirty = false;
      this.clear();
      const ctx = this.ctx;
      const rows = this.rows;
      if (!rows.length) {
        emptyState(ctx, this.w, this.h, 'no data yet');
        return;
      }
      const P = this.pad;
      const rowH = Math.min(this.rowH, Math.max(12, (this.h - P.t - P.b) / rows.length));
      const max = Math.max(...rows.map((r) => r.value || 0), 1);
      const barW = Math.max(8, this.w - P.l - P.r);
      ctx.font = '10.5px ui-monospace, monospace';
      ctx.textBaseline = 'middle';

      // gridlines at 25/50/75%
      if (this.grid) {
        for (let i = 1; i < 4; i += 1) {
          const x = Math.round(P.l + (barW * i) / 4) + 0.5;
          ctx.strokeStyle = cssVar('--grid', 'rgba(120,160,220,.09)');
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, P.t);
          ctx.lineTo(x, this.h - P.b);
          ctx.stroke();
        }
      }

      rows.forEach((r, i) => {
        const cy = P.t + i * rowH + rowH / 2;
        // label
        ctx.fillStyle = cssVar('--txt-1', '#b7c6e0');
        ctx.textAlign = 'left';
        ctx.fillText(truncate(ctx, r.label, P.l - 8), 0, cy);
        // track
        ctx.fillStyle = cssVar('--chart-fill', 'rgba(120,160,220,.10)');
        roundRect(ctx, P.l, cy - (rowH - 8) / 2, barW, rowH - 8, 3);
        ctx.fill();
        // bar
        const w = Math.max(2, Math.min(barW, ((r.value || 0) / max) * barW));
        const color = r.color || (this.colors ? this.colors[i % this.colors.length] : cssVar('--accent', '#4dd4ff'));
        const grad = ctx.createLinearGradient(P.l, 0, P.l + w, 0);
        grad.addColorStop(0, hexA(color, 0.45));
        grad.addColorStop(1, color);
        ctx.fillStyle = grad;
        roundRect(ctx, P.l, cy - (rowH - 8) / 2, w, rowH - 8, 3);
        ctx.fill();
        // value
        ctx.fillStyle = cssVar('--txt-0', '#eaf1ff');
        ctx.textAlign = 'right';
        const txt = r.value == null ? '—' : `${r.value}${r.unit || this.suffix}`;
        ctx.fillText(txt, this.w, cy);
      });

      if (this.mouse) {
        const i = Math.floor((this.mouse.y - P.t) / rowH);
        const row = rows[i];
        if (row) this.showTip(P.l + 10, this.mouse.y, [`<b>${row.label}</b>`, `${row.value}${this.unit || this.suffix}`]);
        else this.hideTip();
      }
    }
  }

  /* ------------------------------------------------------------------ Histogram */
  class Histogram extends CanvasBase {
    constructor(canvas, opts = {}) {
      super(canvas);
      this.bins = [];
      this.unit = opts.unit || 'ms';
      this.color = opts.color || null;
      this.min = 0;
      this.max = 0;
      this.mean = null;
    }
    setValues(values, binCount = 24) {
      this._dirty = true;
      const vals = (values || []).filter((v) => typeof v === 'number');
      if (!vals.length) {
        this.bins = [];
        return;
      }
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const span = max - min || 1;
      const bins = new Array(binCount).fill(0);
      for (const v of vals) bins[Math.min(binCount - 1, Math.floor(((v - min) / span) * binCount))] += 1;
      this.bins = bins.map((count, i) => ({ from: min + (span * i) / binCount, to: min + (span * (i + 1)) / binCount, count }));
      this.min = min;
      this.max = max;
      this.mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    draw() {
      if (!this._dirty) return;
      if (this.w < 60 || this.h < 40) return;
      this._dirty = false;
      this.clear();
      const ctx = this.ctx;
      if (!this.bins.length) {
        emptyState(ctx, this.w, this.h, 'no samples yet');
        return;
      }
      const color = this.color || cssVar('--accent', '#4dd4ff');
      const P = { l: 20, r: 8, t: 8, b: 16 };
      const plotH = this.h - P.t - P.b;
      const maxCount = Math.max(...this.bins.map((b) => b.count), 1);
      const bw = (this.w - P.l - P.r) / this.bins.length;
      // baseline
      ctx.strokeStyle = cssVar('--line', 'rgba(120,160,220,.16)');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(P.l, P.t + plotH + 0.5);
      ctx.lineTo(this.w - P.r, P.t + plotH + 0.5);
      ctx.stroke();
      this.bins.forEach((b, i) => {
        const h = (b.count / maxCount) * plotH;
        const x = P.l + i * bw;
        const grad = ctx.createLinearGradient(0, P.t + plotH - h, 0, P.t + plotH);
        grad.addColorStop(0, color);
        grad.addColorStop(1, hexA(color, 0.25));
        ctx.fillStyle = grad;
        roundRect(ctx, x + 0.8, P.t + plotH - h, Math.max(1.6, bw - 1.6), h, 2);
        ctx.fill();
      });
      // mean marker
      if (this.mean != null && this.max > this.min) {
        const x = P.l + ((this.mean - this.min) / (this.max - this.min)) * (this.w - P.l - P.r);
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = cssVar('--chart-ink-dim', 'rgba(200,225,255,.5)');
        ctx.beginPath();
        ctx.moveTo(x, P.t);
        ctx.lineTo(x, P.t + plotH);
        ctx.stroke();
        ctx.restore();
        ctx.font = '9px ui-monospace, monospace';
        ctx.fillStyle = cssVar('--chart-ink', '#eaf1ff');
        ctx.textAlign = 'center';
        ctx.fillText(`mean ${this.mean.toFixed(1)}${this.unit}`, x, P.t + 8);
      }
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillStyle = cssVar('--txt-2', '#7d8caa');
      ctx.textAlign = 'left';
      ctx.fillText(`${this.min.toFixed(1)}${this.unit}`, 0, this.h - 4);
      ctx.textAlign = 'right';
      ctx.fillText(`${this.max.toFixed(1)}${this.unit}`, this.w, this.h - 4);
    }
  }

  /* ---------------------------------------------------------------- MTU ladder */
  class Ladder extends CanvasBase {
    constructor(canvas) {
      super(canvas);
      this.rows = [];
    }
    setRows(rows) {
      this._dirty = true;
      this.rows = rows || [];
    }
    draw() {
      if (!this._dirty) return;
      if (this.w < 80 || this.h < 30) return;
      this._dirty = false;
      this.clear();
      const ctx = this.ctx;
      const rows = this.rows.slice(0, 16);
      if (!rows.length) {
        emptyState(ctx, this.w, this.h, 'probe to map the path MTU');
        return;
      }
      const labelW = 52;
      const valueW = 42;
      const rowH = Math.min(14, (this.h - 6) / rows.length);
      ctx.font = '9.5px ui-monospace, monospace';
      ctx.textBaseline = 'middle';
      rows.forEach((r, i) => {
        const y = 3 + i * rowH + rowH / 2;
        ctx.fillStyle = cssVar('--txt-2', '#7d8caa');
        ctx.textAlign = 'left';
        ctx.fillText(`${r.total}`, 0, y);
        const bw = Math.max(10, this.w - labelW - valueW);
        ctx.fillStyle = cssVar('--chart-fill', 'rgba(120,160,220,.10)');
        roundRect(ctx, labelW, y - rowH / 2 + 1, bw, rowH - 3, 2);
        ctx.fill();
        const ok = r.ok;
        const color = ok ? cssVar('--ok', '#34d399') : r.frag ? cssVar('--warn', '#fbbf24') : cssVar('--bad', '#fb7185');
        ctx.fillStyle = hexA(color, 0.85);
        roundRect(ctx, labelW, y - rowH / 2 + 1, Math.max(3, bw * Math.min(1, r.total / 1500)), rowH - 3, 2);
        ctx.fill();
        ctx.textAlign = 'right';
        ctx.fillStyle = color;
        ctx.fillText(ok ? 'pass' : r.frag ? 'frag' : 'drop', this.w, y);
      });
    }
  }

  /* ------------------------------------------------------------------ FlowStrip */
  class FlowStrip extends CanvasBase {
    constructor(canvas, opts = {}) {
      super(canvas);
      this.speed = 0;
      this.target = 0;
      this.color = opts.color || null;
      this.particles = Array.from({ length: 22 }, (_, i) => ({ p: i / 22, lane: i % 2 }));
    }
    setRate(mbps) {
      this.target = Math.max(0, Math.min(1, (mbps || 0) / 120));
    }
    draw(dt = 16) {
      this.clear();
      const ctx = this.ctx;
      if (this.w < 30 || this.h < 20) return;
      const color = this.color || cssVar('--accent', '#4dd4ff');
      const scale = NP.motionScale();
      this.speed += (this.target - this.speed) * 0.08;
      const h = this.h;
      ctx.strokeStyle = cssVar('--chart-axis', 'rgba(120,160,220,.16)');
      ctx.lineWidth = 1;
      [0.34, 0.68].forEach((f) => {
        const y = Math.round(h * f) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(this.w, y);
        ctx.stroke();
      });
      for (const p of this.particles) {
        p.p += (0.0005 + this.speed * 0.011) * (dt / 16) * (scale === 0 ? 0 : 1);
        if (p.p > 1) p.p -= 1;
        const x = p.p * this.w;
        const y = h * (p.lane === 0 ? 0.34 : 0.68);
        ctx.fillStyle = hexA(color, 0.25 + 0.6 * scale);
        ctx.beginPath();
        ctx.arc(x, y, 1.3 + this.speed * 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /* ------------------------------------------------------------------------
     MultiPulse — the gadget's live graph. Every series shares ONE transparent
     canvas and is drawn overlapping, with a left Mbps range and a right ms
     range on independent scales.

     Accuracy rules, because a monitor that smooths away a spike is lying:
       - x is derived from real sample timestamps, so a dropped probe is a GAP
         and a late sample is never silently stretched into place
       - the auto-range is EMA-smoothed AND snapped to 1·2·5·10ⁿ, so the axis
         cannot breathe between frames and invent a trend
       - fills composite additively, so where upload overlaps download the two
         colours blend instead of one trace occluding the other
       - the newest value is never averaged, and the hover readout reports the
         exact sample nearest the cursor, to the series' own precision

     Cost: one clearRect + 4 paths + text per frame, no per-frame allocation of
     the sample arrays (callers hand over their ring buffers by reference).
     ------------------------------------------------------------------------ */
  class MultiPulse extends CanvasBase {
    constructor(canvas, opts = {}) {
      super(canvas);
      this.windowMs = opts.windowMs || 60000;
      /* { key, label, varName, fallback, axis: 'left'|'right', dash, fill, points } */
      this.series = [];
      this.refs = { left: null, right: null };
      this.hidden = new Set();
      this.head = {};
      this.hoverX = null;
      this.loadBand = null;
      this.range = { left: 0, right: 0 };
      this.ink = null;
      this.inkAt = 0;
      this.pad = { l: 30, r: 36, t: 20, b: 15 };
      this.geom = null;
    }

    setSeries(series) { this.series = series || []; this._dirty = true; }
    setHidden(keys) { this.hidden = new Set(keys || []); this._dirty = true; }
    setRefs(refs) { this.refs = { ...this.refs, ...(refs || {}) }; this._dirty = true; }
    setLoadBand(band) { this.loadBand = band || null; this._dirty = true; }
    setHover(x) { this.hoverX = x; this._dirty = true; }

    /** Largest value any visible series holds, per axis, within the visible window. */
    maxOf(axis, tMin = 0) {
      let max = 0;
      for (const s of this.series) {
        if (this.hidden.has(s.key) || s.axis !== axis) continue;
        for (const p of s.points) {
          if (tMin && p[0] < tMin) continue;
          if (p[1] != null && p[1] > max) max = p[1];
        }
      }
      return max;
    }

    /** 1·2·5·10ⁿ so an axis label is always a round number. */
    static niceMax(v) {
      if (!isFinite(v) || v <= 0) return 1;
      const e = Math.pow(10, Math.floor(Math.log10(v)));
      const m = v / e;
      return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * e;
    }

    /** The exact sample nearest a timestamp, per visible series (null = dropped). */
    sampleAt(t) {
      const out = {};
      for (const s of this.series) {
        if (this.hidden.has(s.key)) continue;
        let best = null;
        let bestD = Infinity;
        for (const p of s.points) {
          const d = Math.abs(p[0] - t);
          if (d < bestD) { bestD = d; best = p; }
        }
        out[s.key] = best ? { t: best[0], v: best[1], lost: best[2] === 1 } : null;
      }
      return out;
    }

    draw() {
      if (!this._dirty) return;
      if (this.w < 40 || this.h < 30) return;
      this._dirty = false;
      this.clear();
      const ctx = this.ctx;
      const w = this.w;
      const h = this.h;
      const now = performance.now();

      /* Inks are read from CSS at most twice a second: getComputedStyle per frame
         would cost more than the whole rest of the draw. */
      if (!this.ink || now - this.inkAt > 2000) {
        this.ink = {};
        for (const s of this.series) this.ink[s.key] = cssVar(s.varName, s.fallback);
        this.inkAt = now;
      }
      const ink = (s) => this.ink[s.key] || s.fallback;

      const { l: padL, r: padR, t: padT, b: padB } = this.pad;
      const x0 = padL;
      const x1 = w - padR - 3;
      const y0 = padT;
      const y1 = h - padB;
      const tMax = Date.now();
      const tMin = tMax - this.windowMs;
      const X = (t) => x0 + ((t - tMin) / this.windowMs) * (x1 - x0);

      /* --- auto-range: EMA toward the live max in the current window, then snap. */
      const liveMaxL = this.maxOf('left', tMin);
      const wantL = MultiPulse.niceMax(Math.max(liveMaxL, 0.5) * 1.15);
      const liveMaxR = this.maxOf('right', tMin);
      const wantR = MultiPulse.niceMax(Math.max(liveMaxR, 10) * 1.15);
      this.range.left = this.range.left ? this.range.left * 0.8 + wantL * 0.2 : wantL;
      this.range.right = this.range.right ? this.range.right * 0.8 + wantR * 0.2 : wantR;
      const maxL = MultiPulse.niceMax(this.range.left);
      const maxR = MultiPulse.niceMax(this.range.right);
      const Y = (v, m) => y1 - (Math.max(0, Math.min(v, m)) / m) * (y1 - y0);

      /* --- grid + both scales. Throughput numbers live in the LEFT gutter and
             latency numbers in the RIGHT one: two axes, two sides, no ambiguity. */
      const axis = cssVar('--chart-axis', 'rgba(120,160,220,.12)');
      const inkDim = cssVar('--chart-ink-dim', 'rgba(200,225,255,.5)');
      const inkFaint = cssVar('--chart-ink-faint', 'rgba(200,225,255,.28)');
      ctx.lineWidth = 1;
      ctx.font = '600 8.5px ui-monospace, Consolas, monospace';
      for (let i = 0; i <= 4; i++) {
        const y = y0 + (i / 4) * (y1 - y0);
        ctx.strokeStyle = i === 4 ? cssVar('--chart-axis-major', 'rgba(200,225,255,.3)') : axis;
        ctx.beginPath();
        ctx.moveTo(x0, y + 0.5);
        ctx.lineTo(x1, y + 0.5);
        ctx.stroke();
        ctx.textAlign = 'right';
        ctx.fillStyle = inkDim;
        ctx.fillText(String(Math.round(maxL - (i / 4) * maxL)), x0 - 5, y + 3);
        ctx.textAlign = 'left';
        ctx.fillStyle = cssVar('--series-lat', '#a78bfa');
        ctx.globalAlpha = 0.72;
        ctx.fillText(String(Math.round(maxR - (i / 4) * maxR)), x1 + 5, y + 3);
        ctx.globalAlpha = 1;
      }
      ctx.font = '600 8.5px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'right';
      ctx.fillStyle = inkFaint;
      ctx.fillText('Mbps', x0 - 5, y0 - 7);
      ctx.textAlign = 'left';
      ctx.fillStyle = cssVar('--series-lat', '#a78bfa');
      ctx.globalAlpha = 0.8;
      ctx.fillText('ms', x1 + 5, y0 - 7);
      ctx.globalAlpha = 1;

      /* --- plot clipping: keep all fills, strokes, and markers inside the graph area */
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.clip();

      /* --- saturated-link band. A probe taken while the line was busy is not an
             idle probe; without the band a bufferbloat ramp reads as a fault. */
      if (this.loadBand) {
        const bx0 = Math.max(x0, X(this.loadBand[0]));
        const bx1 = Math.min(x1, X(this.loadBand[1]));
        if (bx1 > bx0 + 1) {
          ctx.fillStyle = cssVar('--warn', '#fbbf24');
          ctx.globalAlpha = 0.055;
          ctx.fillRect(bx0, y0, bx1 - bx0, y1 - y0);
          ctx.globalAlpha = 1;
          ctx.setLineDash([2, 3]);
          ctx.strokeStyle = cssVar('--warn', '#fbbf24');
          ctx.globalAlpha = 0.26;
          ctx.beginPath();
          ctx.moveTo(bx0, y0);
          ctx.lineTo(bx0, y1);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
      }

      /* --- fills first, composited additively: overlap blends into a third hue
             instead of the last-drawn trace hiding the one underneath. */
      ctx.globalCompositeOperation = 'lighter';
      for (const s of this.series) {
        if (this.hidden.has(s.key) || !s.fill) continue;
        const max = s.axis === 'right' ? maxR : maxL;
        const vis = s.points.filter((p) => p[0] >= tMin - 2000 && p[1] != null && p[2] !== 1);
        if (vis.length < 2) continue;
        const pts = vis.map((p) => [X(p[0]), Y(p[1], max)]);
        const g = ctx.createLinearGradient(0, y0, 0, y1);
        g.addColorStop(0, hexA(ink(s), 0.22));
        g.addColorStop(1, hexA(ink(s), 0));
        ctx.beginPath();
        smoothPath(ctx, pts);
        ctx.lineTo(pts[pts.length - 1][0], y1);
        ctx.lineTo(pts[0][0], y1);
        ctx.closePath();
        ctx.fillStyle = g;
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';

      /* --- strokes. Solid for throughput, dashed for latency: hue AND pattern,
             so the traces stay separable without colour vision. */
      for (const s of this.series) {
        if (this.hidden.has(s.key)) continue;
        const max = s.axis === 'right' ? maxR : maxL;
        const vis = s.points.filter((p) => p[0] >= tMin - 2000);
        if (!vis.length) continue;
        ctx.strokeStyle = ink(s);
        ctx.lineWidth = s.fill ? 1.1 : 0.9;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        if (s.dash) ctx.setLineDash(s.dash);
        const glow = NP.motionScale() * 2.2;
        if (glow > 0) {
          ctx.shadowBlur = glow;
          ctx.shadowColor = hexA(ink(s), 0.45);
        }
        let run = [];
        for (const p of vis) {
          if (p[1] == null || p[2] === 1) {
            if (run.length >= 2) {
              ctx.beginPath();
              smoothPath(ctx, run);
              ctx.stroke();
            } else if (run.length === 1) {
              ctx.beginPath();
              ctx.arc(run[0][0], run[0][1], 0.8, 0, Math.PI * 2);
              ctx.stroke();
            }
            run = [];
          } else {
            run.push([X(p[0]), Y(p[1], max)]);
          }
        }
        if (run.length >= 2) {
          ctx.beginPath();
          smoothPath(ctx, run);
          ctx.stroke();
        } else if (run.length === 1) {
          ctx.beginPath();
          ctx.arc(run[0][0], run[0][1], 0.8, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.shadowBlur = 0;
      }

      /* --- loss columns: a lost probe owns its whole column as a hairline. */
      for (const s of this.series) {
        if (this.hidden.has(s.key)) continue;
        for (const p of s.points) {
          if (p[0] < tMin || p[2] !== 1) continue;
          const x = X(p[0]);
          ctx.fillStyle = cssVar('--bad', '#fb7185');
          ctx.globalAlpha = 0.35;
          ctx.fillRect(x - 0.5, y0 + 1, 1, y1 - y0 - 1);
          ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.arc(x, y0 + 3, 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      /* --- heads: the newest point glides to its value instead of teleporting,
             and carries a pulse so the eye can find "now" instantly. */
      const scale = NP.motionScale();
      for (const s of this.series) {
        if (this.hidden.has(s.key)) continue;
        const max = s.axis === 'right' ? maxR : maxL;
        let last = null;
        for (let i = s.points.length - 1; i >= 0; i--) {
          const p = s.points[i];
          if (p[0] >= tMin && p[1] != null && p[2] !== 1) { last = p; break; }
        }
        if (!last) continue;
        const prev = this.head[s.key];
        const shown = prev == null ? last[1] : prev + (last[1] - prev) * 0.25;
        this.head[s.key] = shown;
        if (Math.abs(shown - last[1]) < 0.01) this.head[s.key] = last[1];
        const x = X(last[0]);
        const y = Y(this.head[s.key], max);
        const pulse = 1 + 0.3 * Math.sin(now / 420) * scale;
        ctx.fillStyle = hexA(ink(s), 0.22);
        ctx.beginPath();
        ctx.arc(x, y, 4 * pulse, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = ink(s);
        ctx.beginPath();
        ctx.arc(x, y, 1.7, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore(); // end plot clipping

      /* --- time axis: five ticks, the majors brighter than the minors. */
      ctx.font = '600 8px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'center';
      const spanSec = this.windowMs / 1000;
      for (let i = 0; i <= 4; i++) {
        const x = x0 + (i / 4) * (x1 - x0);
        const major = i === 0 || i === 2 || i === 4;
        ctx.fillStyle = major ? inkDim : inkFaint;
        const sec = -spanSec + (i / 4) * spanSec;
        ctx.fillText(i === 4 ? 'now' : `${Math.round(sec)}s`, x, y1 + 10);
      }
      ctx.textAlign = 'left';

      /* --- crosshair on the hovered instant. */
      if (this.hoverX != null) {
        const hx = Math.max(x0, Math.min(this.hoverX, x1));
        ctx.strokeStyle = cssVar('--chart-axis-major', 'rgba(200,225,255,.3)');
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(hx, y0);
        ctx.lineTo(hx, y1);
        ctx.stroke();
        ctx.setLineDash([]);
        const t = tMin + ((hx - x0) / (x1 - x0)) * this.windowMs;
        for (const s of this.series) {
          if (this.hidden.has(s.key)) continue;
          const max = s.axis === 'right' ? maxR : maxL;
          let best = null;
          let bestD = Infinity;
          for (const p of s.points) {
            if (p[1] == null) continue;
            const d = Math.abs(p[0] - t);
            if (d < bestD) { bestD = d; best = p; }
          }
          if (!best) continue;
          const px = X(best[0]);
          const py = Y(best[1], max);
          ctx.beginPath();
          ctx.arc(px, py, 2.4, 0, Math.PI * 2);
          ctx.fillStyle = cssVar('--surface-0', '#0a0f1a');
          ctx.fill();
          ctx.strokeStyle = ink(s);
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      this.geom = { x0, x1, y0, y1, tMin, tMax, maxL, maxR };
    }
  }

  Object.assign(NP, {
    TimeSeries,
    Sparkline,
    MultiPulse,
    Gauge,
    Bars,
    Histogram,
    Ladder,
    FlowStrip,
    CanvasBase,
    roundRect,
    truncate,
    smoothPath,
    hexA,
  });
})();