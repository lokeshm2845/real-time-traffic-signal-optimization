/* charts.js - tiny dependency-free canvas charts (works offline) */
(function (root) {
  'use strict';
  const FONT = '12px "Segoe UI", system-ui, sans-serif';
  const AX = '#5d6c88', GRID = 'rgba(45,61,90,.55)', TXT = '#8d9bb5';

  function setup(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    const w = Math.max(10, Math.round(r.width)), h = Math.max(10, Math.round(r.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = FONT;
    return { ctx, w, h };
  }

  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
    const n = [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10].find((x) => f <= x + 1e-9);
    return n * p;
  }
  function empty(ctx, w, h, msg) {
    ctx.fillStyle = TXT; ctx.textAlign = 'center'; ctx.fillText(msg || 'Collecting data…', w / 2, h / 2); ctx.textAlign = 'left';
  }
  function frame(ctx, L, T, R, B, yMax, yTicks, fmt) {
    ctx.strokeStyle = GRID; ctx.fillStyle = TXT; ctx.lineWidth = 1; ctx.textAlign = 'right';
    for (let i = 0; i <= yTicks; i++) {
      const v = yMax * i / yTicks, y = B - (B - T) * i / yTicks;
      ctx.beginPath(); ctx.moveTo(L, Math.round(y) + .5); ctx.lineTo(R, Math.round(y) + .5); ctx.stroke();
      ctx.fillText(fmt ? fmt(v) : (Math.round(v * 10) / 10).toString(), L - 8, y + 4);
    }
    ctx.textAlign = 'left';
  }

  function line(canvas, o) {
    const { ctx, w, h } = setup(canvas);
    const L = 44, T = 12, R = w - 14, B = h - 28;
    const pts = o.series.reduce((n, s) => n + s.data.length, 0);
    if (pts < 2) { empty(ctx, w, h); return; }
    let xMin = Infinity, xMax = -Infinity, yMax = o.yMax || 0;
    o.series.forEach((s) => s.data.forEach((p) => {
      if (p.y === null) return;
      xMin = Math.min(xMin, p.x); xMax = Math.max(xMax, p.x); if (!o.yMax) yMax = Math.max(yMax, p.y);
    }));
    if (o.xMax !== undefined) { xMax = o.xMax; xMin = o.xMin; }
    yMax = niceMax(yMax * 1.08);
    frame(ctx, L, T, R, B, yMax, 4, o.yFmt);
    // x ticks
    ctx.fillStyle = TXT; ctx.textAlign = 'center';
    const nT = 5;
    for (let i = 0; i <= nT; i++) {
      const x = L + (R - L) * i / nT, t = xMin + (xMax - xMin) * i / nT;
      ctx.fillText(fmtTime(t), x, B + 17);
    }
    ctx.textAlign = 'left';
    o.series.forEach((s) => {
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.8; ctx.lineJoin = 'round'; ctx.beginPath();
      let started = false;
      s.data.forEach((p) => {
        if (p.y === null) { started = false; return; }
        const x = L + (R - L) * (p.x - xMin) / Math.max(1e-9, xMax - xMin), y = B - (B - T) * p.y / yMax;
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
  }

  function fmtTime(t) {
    t = Math.round(t); const m = Math.floor(t / 60), s = t % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  /* grouped bars. o = {groups:[...], series:[{name,color,values:[...]}], yFmt} */
  function bars(canvas, o) {
    const { ctx, w, h } = setup(canvas);
    const L = 48, T = 14, R = w - 14, B = h - 38;
    let max = 0;
    o.series.forEach((s) => s.values.forEach((v) => { if (v !== null) max = Math.max(max, v); }));
    const yMax = niceMax(max * 1.12);
    frame(ctx, L, T, R, B, yMax, 4, o.yFmt);
    const gw = (R - L) / o.groups.length, n = o.series.length;
    const bw = Math.min(34, (gw * 0.76) / n);
    o.groups.forEach((g, gi) => {
      const x0 = L + gw * gi + (gw - bw * n) / 2;
      o.series.forEach((s, si) => {
        const v = s.values[gi]; if (v === null || v === undefined) return;
        const bh = (B - T) * v / yMax, x = x0 + bw * si;
        ctx.fillStyle = o.colors ? o.colors[gi] : s.color;
        roundRect(ctx, x + 1, B - bh, bw - 2, bh, 3); ctx.fill();
        if (o.labels !== false && bw > 14) {
          ctx.fillStyle = '#cbd5e1'; ctx.textAlign = 'center'; ctx.font = '11px "Segoe UI", sans-serif';
          ctx.fillText(o.valFmt ? o.valFmt(v) : (Math.round(v * 10) / 10).toString(), x + bw / 2, B - bh - 5);
          ctx.font = FONT; ctx.textAlign = 'left';
        }
      });
      ctx.fillStyle = TXT; ctx.textAlign = 'center';
      wrapText(ctx, g, L + gw * gi + gw / 2, B + 16, gw - 6, 14);
      ctx.textAlign = 'left';
    });
  }
  function wrapText(ctx, text, x, y, maxW, lh) {
    const words = text.split(' '); let line = '', yy = y;
    words.forEach((wd) => {
      const test = line ? line + ' ' + wd : wd;
      if (ctx.measureText(test).width > maxW && line) { ctx.fillText(line, x, yy); line = wd; yy += lh; } else line = test;
    });
    ctx.fillText(line, x, yy);
  }
  function roundRect(ctx, x, y, w, h, r) {
    if (h < 1) h = 1;
    r = Math.min(r, h, w / 2);
    ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h); ctx.closePath();
  }

  /* single-series bars with a colour per bar */
  function simpleBars(canvas, o) {
    bars(canvas, { groups: o.labels, series: [{ name: '', color: '#2dd4bf', values: o.values }], yFmt: o.yFmt, valFmt: o.valFmt, colors: o.colors });
  }

  /* phase timeline strip. log = [{t, code}] ; code 0 NS green, 1 EW green, 2 yellow, 3 all red */
  function timeline(canvas, log, tNow, span) {
    const { ctx, w, h } = setup(canvas);
    const L = 14, R = w - 14, T = 38, B = h - 52;
    const cols = ['#4ade80', '#38bdf8', '#fbbf24', '#f87171'];
    const t0 = Math.max(0, tNow - span);
    if (log.length < 2) { empty(ctx, w, h); return; }
    for (let i = 0; i < log.length; i++) {
      const a = Math.max(log[i].t, t0), b = i + 1 < log.length ? log[i + 1].t : tNow;
      if (b <= t0 || b <= a) continue;
      const x1 = L + (R - L) * (a - t0) / span, x2 = L + (R - L) * (b - t0) / span;
      ctx.fillStyle = cols[log[i].code]; ctx.fillRect(x1, T, Math.max(1, x2 - x1), B - T);
    }
    ctx.fillStyle = TXT; ctx.textAlign = 'center';
    for (let i = 0; i <= 5; i++) ctx.fillText(fmtTime(t0 + span * i / 5), L + (R - L) * i / 5, B + 18);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e7edf7'; ctx.fillText('Each coloured block is one signal stage; yellow + red slivers are the clearance interval.', L, 22);
  }

  root.Charts = { line, bars, simpleBars, timeline, setup, fmtTime, niceMax };
})(window);
