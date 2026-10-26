/* app.js - UI, rendering and hardware-link logic for the AdaptiveSignal Control Console */
(function () {
  'use strict';
  const S = TrafficSim, A = S.APPROACHES, G = S.GEOM;
  const $ = (id) => document.getElementById(id);
  const COL = { N: '#60a5fa', E: '#fbbf24', S: '#34d399', W: '#c084fc' };
  const NAME = { N: 'North', E: 'East', S: 'South', W: 'West' };

  /* --------------------------- state --------------------------- */
  const sim = new S.Simulation({ seed: 7, mode: 'adaptive' });
  let scenarioKey = 'balanced';
  sim.loadScenario(S.SCENARIOS[scenarioKey]);
  const ui = { running: true, speed: 1, showSens: true, showLbl: true, tab: 'live', acc: 0, last: 0, uiT: 0, chartT: 0, dragging: false };

  /* ------------------------ hardware link ----------------------- */
  const HW = { connected: false, port: null, writer: null, reader: null, lines: [], lastC: -10, useSensors: false, baud: 115200 };
  function hwLog(kind, text) {
    HW.lines.push({ kind, text, t: sim.t });
    if (HW.lines.length > 400) HW.lines.shift();
    HW.dirty = true;
  }
  async function hwSend(line) {
    hwLog('tx', line);
    if (HW.connected && HW.writer) {
      try { await HW.writer.write(new TextEncoder().encode(line + '\n')); } catch (e) { hwLog('err', 'write failed: ' + e.message); }
    } else {
      hwLog('rx', 'OK');        // virtual ESP32 acknowledges immediately
    }
  }
  sim.onEvent = (e) => {
    if (e.msg.startsWith('SIGNAL ')) hwSend('S,' + A.map((a) => sim.signalOf(a)).join(','));
    else if (e.msg.startsWith('EMERGENCY')) hwSend('E,' + e.msg.slice(-1));
  };
  function hwVirtualTick() {
    if (HW.connected) return;
    if (sim.t - HW.lastC >= 2) {
      HW.lastC = sim.t;
      hwLog('rx', 'C,' + A.map((a) => sim.sens[a].count).join(','));
    }
  }
  async function hwConnect() {
    if (!('serial' in navigator)) { hwLog('err', 'Web Serial API not available in this browser. Use Chrome or Edge on desktop.'); return; }
    try {
      HW.port = await navigator.serial.requestPort();
      await HW.port.open({ baudRate: HW.baud });
      HW.writer = HW.port.writable.getWriter();
      HW.connected = true;
      setHwStatus();
      hwLog('info', 'Serial port opened at ' + HW.baud + ' baud');
      readLoop();
    } catch (e) { hwLog('err', 'Connect failed: ' + e.message); }
  }
  async function readLoop() {
    const dec = new TextDecoder(); let buf = '';
    try {
      HW.reader = HW.port.readable.getReader();
      for (;;) {
        const { value, done } = await HW.reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          hwLog('rx', line);
          const p = line.split(',');
          if (p[0] === 'C' && p.length === 5 && HW.useSensors) {
            sim.sensorOverride = {}; A.forEach((a, k) => { sim.sensorOverride[a] = parseInt(p[k + 1], 10) || 0; });
          }
        }
      }
    } catch (e) { hwLog('err', 'read error: ' + e.message); }
  }
  async function hwDisconnect() {
    try { if (HW.reader) { await HW.reader.cancel(); HW.reader.releaseLock(); } if (HW.writer) HW.writer.releaseLock(); if (HW.port) await HW.port.close(); } catch (e) { /* ignore */ }
    HW.connected = false; HW.port = HW.writer = HW.reader = null; sim.sensorOverride = null;
    hwLog('info', 'Serial port closed – virtual controller active'); setHwStatus();
  }
  function setHwStatus() {
    $('hwDot').className = 'dot ' + (HW.connected ? 'on' : '');
    $('hwTxt').textContent = HW.connected ? 'Hardware connected' : 'Virtual controller';
    $('hwConnect').style.display = HW.connected ? 'none' : '';
    $('hwDisc').style.display = HW.connected ? '' : 'none';
  }

  /* ------------------------ canvas rendering --------------------- */
  const cv = $('simCanvas');
  const pos = (a, d, lat) => {
    const u = S.DIR[a], sp = S.STOP_PT[a], left = [u[1], -u[0]];
    return [sp[0] - u[0] * d + left[0] * lat, sp[1] - u[1] * d + left[1] * lat];
  };
  function rrect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1, r = cv.getBoundingClientRect();
    const w = Math.round(r.width), h = Math.round(r.height);
    if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const k = Math.min(w, h) / 104, cx = w / 2, cy = h / 2;
    const X = (x) => cx + x * k, Y = (y) => cy + y * k, RH = G.roadHalf;

    ctx.fillStyle = '#0c161d'; ctx.fillRect(0, 0, w, h);
    // city blocks
    ctx.fillStyle = '#10202b'; ctx.strokeStyle = '#17293a'; ctx.lineWidth = 1;
    [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([sx, sy]) => {
      const x0 = (RH + 2.4) * sx, y0 = (RH + 2.4) * sy, x1 = 200 * sx, y1 = 200 * sy;
      rrect(ctx, Math.min(X(x0), X(x1)), Math.min(Y(y0), Y(y1)), Math.abs(X(x1) - X(x0)), Math.abs(Y(y1) - Y(y0)), 10); ctx.fill(); ctx.stroke();
    });
    // asphalt
    ctx.fillStyle = '#262d3a';
    ctx.fillRect(0, Y(-RH), w, 2 * RH * k); ctx.fillRect(X(-RH), 0, 2 * RH * k, h);
    // kerbs
    ctx.strokeStyle = '#3a4860'; ctx.lineWidth = 1.2; ctx.beginPath();
    [-RH, RH].forEach((o) => {
      ctx.moveTo(0, Y(o)); ctx.lineTo(X(-RH), Y(o)); ctx.moveTo(X(RH), Y(o)); ctx.lineTo(w, Y(o));
      ctx.moveTo(X(o), 0); ctx.lineTo(X(o), Y(-RH)); ctx.moveTo(X(o), Y(RH)); ctx.lineTo(X(o), h);
    }); ctx.stroke();
    // centre lines (double yellow)
    ctx.strokeStyle = 'rgba(251,191,36,.55)'; ctx.lineWidth = 1;
    [-0.28, 0.28].forEach((o) => {
      ctx.beginPath();
      ctx.moveTo(0, Y(o)); ctx.lineTo(X(-G.half), Y(o)); ctx.moveTo(X(G.half), Y(o)); ctx.lineTo(w, Y(o));
      ctx.moveTo(X(o), 0); ctx.lineTo(X(o), Y(-G.half)); ctx.moveTo(X(o), Y(G.half)); ctx.lineTo(X(o), h);
      ctx.stroke();
    });
    // zebra crossings + stop lines
    A.forEach((a) => {
      const u = S.DIR[a];
      ctx.fillStyle = 'rgba(226,232,240,.78)';
      for (let i = 0; i < 7; i++) {
        const lat = -RH + 0.6 + i * ((2 * RH - 1.2) / 6);
        const c = [pos(a, -0.8, lat - 0.45), pos(a, -0.8, lat + 0.45), pos(a, -3.8, lat + 0.45), pos(a, -3.8, lat - 0.45)];
        ctx.beginPath(); c.forEach((p, j) => (j ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])))); ctx.closePath(); ctx.fill();
      }
      // stop line, across the incoming lane only
      const l1 = pos(a, 0, 0.1), l2 = pos(a, 0, RH);
      ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.moveTo(X(l1[0]), Y(l1[1])); ctx.lineTo(X(l2[0]), Y(l2[1])); ctx.stroke();
      // direction arrow
      const ap = pos(a, 14, G.laneOff), ang = Math.atan2(u[1], u[0]);
      ctx.save(); ctx.translate(X(ap[0]), Y(ap[1])); ctx.rotate(ang); ctx.fillStyle = 'rgba(226,232,240,.35)';
      ctx.beginPath(); ctx.moveTo(2.4 * k, 0); ctx.lineTo(-0.2 * k, -0.9 * k); ctx.lineTo(-0.2 * k, 0.9 * k); ctx.closePath(); ctx.fill();
      ctx.fillRect(-2.6 * k, -0.28 * k, 2.6 * k, 0.56 * k); ctx.restore();
    });

    // IR beams
    if (ui.showSens) {
      A.forEach((a) => {
        const se = sim.sens[a], u = S.DIR[a];
        [[3, se.near], [sim.cfg.sensorRange, se.far]].forEach(([d, on]) => {
          const p1 = pos(a, d, G.laneOff - 1.6), p2 = pos(a, d, G.laneOff + 1.6);
          ctx.strokeStyle = on ? '#2dd4bf' : 'rgba(110,130,165,.55)'; ctx.lineWidth = on ? 2.6 : 1.2;
          ctx.setLineDash(on ? [] : [3, 3]); ctx.shadowColor = '#2dd4bf'; ctx.shadowBlur = on ? 10 : 0;
          ctx.beginPath(); ctx.moveTo(X(p1[0]), Y(p1[1])); ctx.lineTo(X(p2[0]), Y(p2[1])); ctx.stroke();
          ctx.setLineDash([]); ctx.shadowBlur = 0;
        });
      });
    }

    // vehicles
    const tms = performance.now();
    A.forEach((a) => {
      const u = S.DIR[a], ang = Math.atan2(u[1], u[0]);
      sim.veh[a].forEach((v) => {
        const p = pos(a, v.d + v.len / 2, G.laneOff);
        if (Math.abs(p[0]) > 110 || Math.abs(p[1]) > 56) return;
        const L = v.len * k, W = v.T.width * k;
        ctx.save(); ctx.translate(X(p[0]), Y(p[1])); ctx.rotate(ang);
        ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 4;
        let body = `hsl(${v.hue},62%,64%)`;
        if (v.type === 'bus') body = '#f59e0b'; else if (v.type === 'bike') body = '#fbbf24'; else if (v.type === 'amb') body = '#f8fafc';
        ctx.fillStyle = body; rrect(ctx, -L / 2, -W / 2, L, W, Math.min(W / 2.4, 4)); ctx.fill(); ctx.shadowBlur = 0;
        if (v.type === 'car' || v.type === 'amb') {
          ctx.fillStyle = 'rgba(15,23,42,.72)'; ctx.fillRect(L * 0.1, -W * 0.38, L * 0.2, W * 0.76); ctx.fillRect(-L * 0.36, -W * 0.34, L * 0.1, W * 0.68);
        } else if (v.type === 'bus') {
          ctx.fillStyle = 'rgba(15,23,42,.6)'; for (let i = 0; i < 4; i++) ctx.fillRect(-L * 0.38 + i * L * 0.19, -W * 0.34, L * 0.13, W * 0.68);
        } else { ctx.fillStyle = 'rgba(15,23,42,.8)'; ctx.fillRect(-L * 0.1, -W * 0.3, L * 0.25, W * 0.6); }
        if (v.type === 'amb') {
          const on = Math.floor(tms / 180) % 2;
          ctx.fillStyle = '#ef4444'; ctx.fillRect(-L * 0.45, -W * 0.14, L * 0.9, W * 0.28);
          ctx.shadowColor = on ? '#ef4444' : '#3b82f6'; ctx.shadowBlur = 14; ctx.fillStyle = on ? '#fecaca' : '#bfdbfe';
          ctx.fillRect(-L * 0.05, -W * 0.5, L * 0.1, W); ctx.shadowBlur = 0;
        }
        if (v.v < 0.5 && v.d > 0 && v.type !== 'amb') { ctx.fillStyle = '#ef4444'; ctx.fillRect(-L / 2, -W * 0.42, 1.6, W * 0.84); }
        ctx.restore();
      });
    });

    // signal heads
    A.forEach((a) => {
      const sg = sim.signalOf(a), p = pos(a, -1.2, RH + 2.1);
      const x = X(p[0]), y = Y(p[1]), bw = 15, bh = 40;
      ctx.fillStyle = '#05080d'; ctx.strokeStyle = '#334155'; ctx.lineWidth = 1; rrect(ctx, x - bw / 2, y - bh / 2, bw, bh, 5); ctx.fill(); ctx.stroke();
      [['R', '#ef4444'], ['Y', '#fbbf24'], ['G', '#22c55e']].forEach(([c, col], i) => {
        const on = sg === c;
        ctx.beginPath(); ctx.arc(x, y - 12 + i * 12, 4.4, 0, 6.3);
        ctx.fillStyle = on ? col : 'rgba(100,116,139,.22)'; ctx.shadowColor = col; ctx.shadowBlur = on ? 16 : 0; ctx.fill(); ctx.shadowBlur = 0;
      });
    });

    // approach labels
    if (ui.showLbl) {
      ctx.font = '600 12px "Segoe UI", sans-serif';
      A.forEach((a) => {
        const se = sim.sens[a], p = pos(a, 34, G.laneOff + 9.5), x = X(p[0]), y = Y(p[1]);
        const txt = a + '  ' + sim._count(a) + ' sensed' + (se.wait > 1 ? ' · wait ' + Math.round(se.wait) + ' s' : '');
        const tw = ctx.measureText(txt).width + 18;
        ctx.fillStyle = 'rgba(10,15,24,.82)'; ctx.strokeStyle = COL[a]; ctx.lineWidth = 1.2; rrect(ctx, x - tw / 2, y - 12, tw, 24, 12); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#e7edf7'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(txt, x, y + 0.5);
      });
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
  }

  /* ------------------------ UI refresh --------------------------- */
  function fmtClock(t) {
    const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = Math.floor(t % 60);
    return [h, m, s].map((x) => String(x).padStart(2, '0')).join(':');
  }
  function buildStatic() {
    const tb = document.querySelector('#apprTbl tbody');
    tb.innerHTML = A.map((a) => `<tr id="ar-${a}"><td><span class="tag" style="background:${COL[a]}">${a}</span>${NAME[a]}</td><td><span class="sig-dot"></span><span class="st">Red</span></td><td class="sn">0</td><td class="qq">0</td><td class="ww">0 s</td></tr>`).join('');
    $('rateSliders').innerHTML = A.map((a) => `<div class="field"><label><span><span class="tag" style="background:${COL[a]}">${a}</span>${NAME[a]} approach</span><b id="vr${a}">400 veh/h</b></label><input type="range" id="r${a}" min="0" max="900" step="10" value="400"></div>`).join('');
    $('scenario').innerHTML = Object.entries(S.SCENARIOS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('') + '<option value="custom">Custom (slider adjusted)</option>';
    $('apprLegend').innerHTML = A.map((a) => `<span><i style="background:${COL[a]}"></i>${NAME[a]}</span>`).join('');
    // hardware tab static parts
    $('pinTbl').innerHTML = '<thead><tr><th>Approach</th><th>R · Y · G (GPIO)</th><th>Stop beam</th><th>Far beam</th></tr></thead><tbody>' +
      A.map((a) => { const p = PINS[a]; return `<tr><td><span class="tag" style="background:${COL[a]}">${a}</span>${NAME[a]}</td><td class="mono">${p.led.join(' · ')}</td><td class="mono">${p.stop}</td><td class="mono">${p.far}</td></tr>`; }).join('') + '</tbody>';
    document.querySelector('#hwSensTbl tbody').innerHTML = A.map((a) => `<tr><td><span class="tag" style="background:${COL[a]}">${a}</span>${NAME[a]}</td><td><span class="det" id="hd-${a}"><i></i><i></i></span></td><td class="hi">0</td><td class="ho">0</td><td class="hc">0</td></tr>`).join('');
    $('hwSvgBox').innerHTML = hwSvg();
  }

  const PINS = {
    N: { led: [16, 17, 18], stop: 34, far: 35 },
    E: { led: [19, 21, 22], stop: 36, far: 39 },
    S: { led: [23, 25, 26], stop: 4, far: 13 },
    W: { led: [27, 32, 33], stop: 14, far: 15 }
  };

  function hwSvg() {
    let s = '<svg class="hw-svg" viewBox="0 0 760 470" xmlns="http://www.w3.org/2000/svg" font-family="Segoe UI, sans-serif">';
    s += '<rect x="290" y="70" width="180" height="300" rx="12" fill="#162033" stroke="#2dd4bf" stroke-width="1.6"/>';
    s += '<text x="380" y="106" text-anchor="middle" fill="#e7edf7" font-size="15" font-weight="600">ESP32-DevKitC</text>';
    s += '<text x="380" y="126" text-anchor="middle" fill="#8d9bb5" font-size="11">Signal controller · firmware v1</text>';
    s += '<rect x="320" y="378" width="120" height="26" rx="4" fill="#0a0f18" stroke="#5d6c88"/><text x="380" y="396" text-anchor="middle" fill="#8d9bb5" font-size="11">USB → PC console</text>';
    A.forEach((a, i) => {
      const y = 62 + i * 98, p = PINS[a];
      s += `<line x1="150" y1="${y + 28}" x2="290" y2="${y + 28 + (i - 1.5) * 8}" stroke="${COL[a]}" stroke-width="1.4" opacity=".8"/>`;
      s += `<rect x="108" y="${y}" width="44" height="58" rx="8" fill="#05080d" stroke="#334155"/>`;
      ['R', 'Y', 'G'].forEach((c, j) => { s += `<circle id="hl-${a}-${c}" cx="130" cy="${y + 13 + j * 16}" r="5.5" fill="#26334b"/>`; });
      s += `<text x="14" y="${y + 18}" fill="${COL[a]}" font-size="13" font-weight="600">${NAME[a]}</text>`;
      s += `<text x="14" y="${y + 36}" fill="#8d9bb5" font-size="11">GPIO ${p.led.join(' / ')}</text>`;
      s += `<text x="14" y="${y + 52}" fill="#5d6c88" font-size="10.5">3 × LED + 220 Ω</text>`;
      // sensors
      const ys = [y + 6, y + 36];
      [['stop', p.stop], ['far', p.far]].forEach(([nm, g], j) => {
        s += `<line x1="470" y1="${y + 28 + (i - 1.5) * 8}" x2="570" y2="${ys[j] + 8}" stroke="${COL[a]}" stroke-width="1.2" opacity=".7"/>`;
        s += `<rect x="570" y="${ys[j]}" width="32" height="16" rx="4" fill="#05080d" stroke="#334155"/><circle id="hs-${a}-${nm}" cx="586" cy="${ys[j] + 8}" r="4.5" fill="#26334b"/>`;
        s += `<text x="612" y="${ys[j] + 12}" fill="#8d9bb5" font-size="11">${a} ${nm} · GPIO ${g}</text>`;
      });
    });
    s += '<text x="470" y="40" fill="#8d9bb5" font-size="11">IR beams: E18-D80NK, 3.3 V pull-up</text>';
    s += '</svg>';
    return s;
  }

  function refreshHwTab() {
    A.forEach((a) => {
      const sg = sim.signalOf(a);
      ['R', 'Y', 'G'].forEach((c) => {
        const el = $(`hl-${a}-${c}`); if (!el) return;
        const on = sg === c, col = { R: '#ef4444', Y: '#fbbf24', G: '#22c55e' }[c];
        el.setAttribute('fill', on ? col : '#26334b'); el.style.filter = on ? `drop-shadow(0 0 5px ${col})` : 'none';
      });
      const se = sim.sens[a];
      [['stop', se.near], ['far', se.far]].forEach(([nm, on]) => {
        const el = $(`hs-${a}-${nm}`); if (!el) return;
        el.setAttribute('fill', on ? '#2dd4bf' : '#26334b'); el.style.filter = on ? 'drop-shadow(0 0 5px #2dd4bf)' : 'none';
      });
      const row = $('hd-' + a).closest('tr'), dots = $('hd-' + a).children;
      dots[0].className = se.near ? 'on' : ''; dots[1].className = se.far ? 'on' : '';
      row.querySelector('.hi').textContent = se.in; row.querySelector('.ho').textContent = se.out; row.querySelector('.hc').textContent = sim._count(a);
    });
    if (HW.dirty) {
      const c = $('console'), atBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - 30;
      c.innerHTML = HW.lines.slice(-160).map((l) => `<div class="${l.kind}">[${fmtClock(l.t).slice(3)}] ${l.kind === 'tx' ? 'TX →' : l.kind === 'rx' ? 'RX ←' : '··'} ${l.text.replace(/</g, '&lt;')}</div>`).join('');
      if (atBottom) c.scrollTop = c.scrollHeight;
      HW.dirty = false;
    }
  }

  function refreshLive() {
    const s = sim.sig, sm = sim.summary();
    const stageTxt = { GREEN: 'green', YELLOW: 'yellow', ALLRED: 'all-red clearance' }[s.stage];
    $('hudMode').textContent = { fixed: 'Fixed-time', adaptive: 'Adaptive', manual: 'Manual override' }[sim.cfg.mode];
    $('hudPhaseTxt').textContent = (s.stage === 'ALLRED' ? 'All red · next ' + S.PHASE_NAMES[s.next] : S.PHASE_NAMES[s.phase] + ' ' + stageTxt);
    $('hudDot').className = 'sig-dot ' + (s.stage === 'GREEN' ? 'G' : s.stage === 'YELLOW' ? 'Y' : '');
    $('hudTimer').textContent = s.timer.toFixed(1) + ' s';
    $('hudClock').textContent = 'Sim time ' + fmtClock(sim.t).slice(3);
    $('clockPill').textContent = fmtClock(sim.t);
    $('preemptBanner').classList.toggle('show', !!s.preempting);

    $('kDelay').textContent = sm.avgDelay.toFixed(1);
    const los = $('kLos'); los.textContent = sm.los; los.className = 'los ' + sm.los;
    const last = sim.series[sim.series.length - 1];
    $('kThr').textContent = last ? last.thr : 0;
    $('kServed').textContent = sm.crossed;
    $('kServedFoot').textContent = sim.inSystem() + ' in system';
    const qs = A.reduce((n, a) => n + sim.trueQueue(a), 0);
    $('kQ').textContent = qs; $('kQFoot').textContent = 'Max ' + sm.maxQueue + ' on one approach';
    $('kStops').textContent = sm.stopsPerVeh.toFixed(2);
    $('kCo2').textContent = sm.co2kg.toFixed(2);

    A.forEach((a) => {
      const r = $('ar-' + a), sg = sim.signalOf(a), se = sim.sens[a];
      r.querySelector('.sig-dot').className = 'sig-dot ' + (sg === 'G' ? 'G' : sg === 'Y' ? 'Y' : '');
      r.querySelector('.st').textContent = { G: 'Green', Y: 'Yellow', R: 'Red' }[sg];
      r.querySelector('.sn').textContent = sim._count(a);
      r.querySelector('.qq').textContent = sim.trueQueue(a);
      r.querySelector('.ww').textContent = Math.round(se.wait) + ' s';
    });
    if (!ui.dragging) A.forEach((a) => { $('r' + a).value = sim.rates[a]; $('vr' + a).textContent = Math.round(sim.rates[a]) + ' veh/h'; });
    if (scenarioKey !== 'custom') $('scenario').value = scenarioKey;
    $('mNS').classList.toggle('primary', sim.sig.manual === 0); $('mEW').classList.toggle('primary', sim.sig.manual === 1); $('mAR').classList.toggle('primary', sim.sig.manual === 'allred');
  }

  function refreshAnalytics() {
    const win = sim.series.slice(-600);
    const mk = (f) => win.map((p) => ({ x: p.t, y: f(p) }));
    const xs = win.length ? { xMin: win[0].t, xMax: win[win.length - 1].t } : {};
    Charts.line($('chQueue'), { series: A.map((a, i) => ({ name: a, color: COL[a], data: mk((p) => p.q[i]) })), ...xs });
    Charts.line($('chDelay'), { series: [{ color: '#2dd4bf', data: mk((p) => p.delay), width: 2.2 }], ...xs, yFmt: (v) => v.toFixed(0) });
    Charts.line($('chThr'), { series: [{ color: '#60a5fa', data: mk((p) => p.thr), width: 2.2 }], ...xs });
    Charts.timeline($('chPhase'), sim.phaseLog, sim.t, Math.max(60, Math.min(600, sim.t)));
    const st = sim.stats, tot = Math.max(1, sim.t), clr = Math.max(0, tot - st.green[0] - st.green[1]);
    Charts.simpleBars($('chSplit'), { labels: ['North-South green', 'East-West green', 'Yellow + all-red'], values: [st.green[0] / tot * 100, st.green[1] / tot * 100, clr / tot * 100], colors: ['#4ade80', '#38bdf8', '#f87171'], valFmt: (v) => v.toFixed(0) + '%', yFmt: (v) => v + '%' });
    const sm = sim.summary();
    Charts.simpleBars($('chApprDelay'), { labels: A.map((a) => NAME[a]), values: sm.delayBy, colors: A.map((a) => COL[a]), valFmt: (v) => v.toFixed(1) });
  }

  /* ------------------------ benchmark UI ------------------------- */
  const SHORT = { balanced: 'Balanced', rush_ew: 'Rush hour (E-W)', asym: 'Asymmetric', heavy: 'Near saturation', night: 'Night / low', surge: 'Time-varying', emergency: 'Emergency' };
  const CTL_COL = { fixed: '#94a3b8', webster: '#fbbf24', adaptive: '#2dd4bf', adaptive_ep: '#60a5fa' };
  const METRICS = [
    { k: 'avgDelay', label: 'Average delay (s/veh)', d: 1, low: true },
    { k: 'avgQueue', label: 'Average queue (veh/approach)', d: 2, low: true },
    { k: 'stopsPerVeh', label: 'Stops per vehicle', d: 2, low: true },
    { k: 'residual', label: 'Vehicles left in system', d: 0, low: true },
    { k: 'co2kg', label: 'Idle CO₂ (kg)', d: 2, low: true },
    { k: 'throughput', label: 'Throughput (veh/h)', d: 0, low: false }
  ];
  let bench = null, metricKey = 'avgDelay';
  function renderBench() {
    if (!bench) return;
    const R = bench.results, keys = Object.keys(R), m = METRICS.find((x) => x.k === metricKey);
    $('metricChips').innerHTML = METRICS.map((x) => `<span class="chip ${x.k === metricKey ? 'active' : ''}" data-k="${x.k}">${x.label}</span>`).join('');
    const ctls = ['fixed', 'webster', 'adaptive'];
    Charts.bars($('chBench'), {
      groups: keys.map((k) => SHORT[k]),
      series: ctls.map((c) => ({ name: c, color: CTL_COL[c], values: keys.map((k) => (R[k].ctl[c] ? R[k].ctl[c][metricKey].mean : null)) })),
      valFmt: (v) => v.toFixed(m.d), yFmt: (v) => (m.d ? v.toFixed(m.d > 1 ? 1 : 0) : v.toFixed(0))
    });
    $('benchLegend').innerHTML = ctls.map((c) => `<span><i style="background:${CTL_COL[c]}"></i>${S.CONTROLLERS[c].label}</span>`).join('');
    let h = '<thead><tr><th>Scenario</th><th>Controller</th><th>Avg delay (s/veh)</th><th>LOS</th><th>Avg queue</th><th>Stops/veh</th><th>Throughput (veh/h)</th><th>Left in system</th><th>Idle CO₂ (kg)</th><th>Delay vs fixed</th></tr></thead><tbody>';
    keys.filter((k) => k !== 'emergency').forEach((k) => {
      ctls.forEach((c, i) => {
        const a = R[k].ctl[c], base = R[k].ctl.fixed.avgDelay.mean, dd = (a.avgDelay.mean - base) / base * 100;
        h += `<tr><td>${i === 0 ? SHORT[k] : ''}</td><td><span class="dot" style="background:${CTL_COL[c]}"></span> ${S.CONTROLLERS[c].label}${a.plan ? ` <span class="sub">(${a.plan.ns}/${a.plan.ew} s)</span>` : ''}</td><td>${a.avgDelay.mean.toFixed(1)} <span class="sub">±${a.avgDelay.sd.toFixed(1)}</span></td><td><span class="los ${a.los}">${a.los}</span></td><td>${a.avgQueue.mean.toFixed(2)}</td><td>${a.stopsPerVeh.mean.toFixed(2)}</td><td>${a.throughput.mean.toFixed(0)}</td><td>${a.residual.mean.toFixed(1)}</td><td>${a.co2kg.mean.toFixed(2)}</td><td>${c === 'fixed' ? '—' : `<span class="${dd < 0 ? 'good' : 'bad'}">${dd > 0 ? '+' : ''}${dd.toFixed(0)}%</span>`}</td></tr>`;
      });
    });
    $('benchTbl').innerHTML = h + '</tbody>';
    const em = R.emergency;
    if (em) {
      let t = '<thead><tr><th>Controller</th><th>Ambulance delay (s)</th><th>Other traffic: avg delay (s/veh)</th><th>Throughput (veh/h)</th></tr></thead><tbody>';
      ['fixed', 'webster', 'adaptive', 'adaptive_ep'].forEach((c) => {
        const a = em.ctl[c]; if (!a) return;
        t += `<tr><td><span class="dot" style="background:${CTL_COL[c]}"></span> ${S.CONTROLLERS[c].label}</td><td>${a.ambDelay ? a.ambDelay.mean.toFixed(1) + ' <span class="sub">±' + a.ambDelay.sd.toFixed(1) + '</span>' : '—'}</td><td>${a.avgDelay.mean.toFixed(1)}</td><td>${a.throughput.mean.toFixed(0)}</td></tr>`;
      });
      $('ambTbl').innerHTML = t + '</tbody>';
    }
  }
  async function runBench() {
    $('benchRun').disabled = true; $('benchMsg').textContent = 'Running…'; $('benchProg').style.width = '0';
    const seeds = parseInt($('benchSeeds').value, 10);
    const res = await S.runBenchmark({ seeds, yieldUI: true }, (d, t, key) => { $('benchProg').style.width = (d / t * 100) + '%'; $('benchMsg').textContent = `${d}/${t} runs · ${SHORT[key]}`; });
    bench = res; window.__bench = res;
    $('benchOut').style.display = ''; $('benchMsg').textContent = `Done · ${seeds} seeds × 7 scenarios`; $('benchRun').disabled = false;
    renderBench();
  }

  /* ------------------------ wiring ------------------------------- */
  function setTab(t) {
    ui.tab = t;
    document.querySelectorAll('.tab').forEach((e) => e.classList.toggle('active', e.id === 'tab-' + t));
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    requestAnimationFrame(() => { if (t === 'analytics') refreshAnalytics(); if (t === 'hw') { HW.dirty = true; refreshHwTab(); } if (t === 'bench') renderBench(); });
  }
  function setMode(m) {
    sim.setMode(m); document.body.dataset.mode = m;
    document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  }
  function applyScenario(key) {
    scenarioKey = key;
    if (key !== 'custom') { sim.loadScenario(S.SCENARIOS[key]); sim.rates = Object.assign({}, S.SCENARIOS[key].schedule[0].rates); }
  }
  function resetSim() {
    const mode = sim.cfg.mode, cfg = sim.cfg;
    sim.reset(); sim.cfg = cfg; sim.cfg.mode = mode; sim.rates = Object.assign({}, S.DEFAULTS.rates);
    if (scenarioKey !== 'custom') { sim.loadScenario(S.SCENARIOS[scenarioKey]); }
    HW.lines = []; HW.lastC = -10; HW.dirty = true; ui.acc = 0;
    hwLog('info', 'Simulation reset');
  }

  function bind() {
    document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
    document.querySelectorAll('#modeSeg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    document.querySelectorAll('#speedSeg button').forEach((b) => b.addEventListener('click', () => {
      ui.speed = parseFloat(b.dataset.s); document.querySelectorAll('#speedSeg button').forEach((x) => x.classList.toggle('active', x === b));
    }));
    $('playBtn').addEventListener('click', () => {
      ui.running = !ui.running; $('playBtn').textContent = ui.running ? 'Pause' : 'Resume';
      $('runTxt').textContent = ui.running ? 'Running' : 'Paused'; $('runDot').className = 'dot ' + (ui.running ? 'on' : 'warn');
    });
    $('resetBtn').addEventListener('click', resetSim);
    $('showSens').addEventListener('change', (e) => { ui.showSens = e.target.checked; });
    $('showLbl').addEventListener('change', (e) => { ui.showLbl = e.target.checked; });
    $('preempt').addEventListener('change', (e) => { sim.cfg.preempt = e.target.checked; });
    const slide = (id, vid, fn, unit) => $(id).addEventListener('input', (e) => { const v = parseFloat(e.target.value); $(vid).textContent = v + (unit || ' s'); fn(v); });
    slide('fgNS', 'vFgNS', (v) => { sim.cfg.fixedGreen.ns = v; });
    slide('fgEW', 'vFgEW', (v) => { sim.cfg.fixedGreen.ew = v; });
    slide('minG', 'vMin', (v) => { sim.cfg.minGreen = v; if ($('maxG').value < v + 10) { $('maxG').value = v + 10; $('maxG').dispatchEvent(new Event('input')); } });
    slide('maxG', 'vMax', (v) => { sim.cfg.maxGreen = v; });
    A.forEach((a) => {
      const el = $('r' + a);
      el.addEventListener('pointerdown', () => { ui.dragging = true; });
      el.addEventListener('pointerup', () => { ui.dragging = false; });
      el.addEventListener('input', (e) => {
        sim.setRates({ [a]: parseFloat(e.target.value) }); scenarioKey = 'custom'; $('scenario').value = 'custom';
        $('vr' + a).textContent = e.target.value + ' veh/h';
      });
    });
    $('scenario').addEventListener('change', (e) => applyScenario(e.target.value));
    document.querySelectorAll('#ambBtns button').forEach((b) => b.addEventListener('click', () => sim.dispatchEmergency(b.dataset.a)));
    $('mNS').addEventListener('click', () => { setMode('manual'); sim.setManual(0); });
    $('mEW').addEventListener('click', () => { setMode('manual'); sim.setManual(1); });
    $('mAR').addEventListener('click', () => { setMode('manual'); sim.setManual('allred'); });
    $('benchRun').addEventListener('click', runBench);
    $('metricChips').addEventListener('click', (e) => { const k = e.target.dataset && e.target.dataset.k; if (k) { metricKey = k; renderBench(); } });
    $('hwConnect').addEventListener('click', hwConnect);
    $('hwDisc').addEventListener('click', hwDisconnect);
    $('hwUseSensors').addEventListener('change', (e) => { HW.useSensors = e.target.checked; if (!e.target.checked) sim.sensorOverride = null; });
    window.addEventListener('resize', () => { if (ui.tab === 'analytics') refreshAnalytics(); if (ui.tab === 'bench') renderBench(); });
  }

  /* ------------------------ main loop ---------------------------- */
  function frame(ts) {
    const dtReal = Math.min(0.1, (ts - ui.last) / 1000 || 0); ui.last = ts;
    if (ui.running) {
      ui.acc += dtReal * ui.speed;
      const n = Math.min(Math.floor(ui.acc / sim.cfg.dt), 600);
      for (let i = 0; i < n; i++) sim.step();
      ui.acc -= n * sim.cfg.dt; if (n === 600) ui.acc = 0;
      hwVirtualTick();
    }
    draw();
    if (ts - ui.uiT > 200) { ui.uiT = ts; refreshLive(); if (ui.tab === 'hw') refreshHwTab(); }
    if (ui.tab === 'analytics' && ts - ui.chartT > 700) { ui.chartT = ts; refreshAnalytics(); }
    requestAnimationFrame(frame);
  }

  buildStatic(); bind(); setMode('adaptive'); setHwStatus();
  hwLog('info', 'Virtual ESP32 ready – connect a serial port to drive the physical prototype');
  requestAnimationFrame(frame);

  // handle for automated testing / screenshots
  window.app = {
    sim, HW, setTab, setMode, applyScenario, resetSim, runBench,
    fastForward(sec) { sim.run(sec); hwVirtualTick(); refreshLive(); draw(); },
    pause() { ui.running = true; $('playBtn').click(); },
    refresh() { refreshLive(); refreshAnalytics(); refreshHwTab(); draw(); }
  };
})();
