/*
 * sim.js - Microscopic traffic simulation + signal controllers for the
 * "Real-Time Traffic Signal Optimization" prototype.
 *
 * Runs unchanged in the browser (window.TrafficSim) and in Node (require).
 * Units: metres, seconds. y axis points down on screen (North is up).
 *
 * The controllers never read ground-truth vehicle data. They only see what the
 * hardware prototype can measure: IR presence beams at the stop line, at 25 m
 * and at the far end of the monitored zone, plus entry/exit counts.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TrafficSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const APPROACHES = ['N', 'E', 'S', 'W'];
  const PHASE_OF = { N: 0, S: 0, E: 1, W: 1 };
  const PHASE_NAMES = ['North-South', 'East-West'];
  const GEOM = { half: 8.5, laneOff: 1.9, roadHalf: 3.8, spawnD: 150, exitLen: 140 };
  // unit travel vector of vehicles on each approach (screen coordinates, y down)
  const DIR = { N: [0, 1], S: [0, -1], E: [-1, 0], W: [1, 0] };
  const STOP_PT = { N: [0, -GEOM.half], S: [0, GEOM.half], E: [GEOM.half, 0], W: [-GEOM.half, 0] };

  const VEH_TYPES = {
    car:  { len: 4.5, width: 1.9, v0: 11.1, a: 2.0, b: 3.0, T: 1.3, s0: 1.6 },
    bike: { len: 2.0, width: 0.8, v0: 11.5, a: 2.8, b: 3.0, T: 1.1, s0: 1.2 },
    bus:  { len: 9.0, width: 2.5, v0: 9.5,  a: 1.2, b: 2.8, T: 1.5, s0: 2.0 },
    amb:  { len: 5.2, width: 2.0, v0: 13.9, a: 2.5, b: 3.5, T: 1.0, s0: 1.5 }
  };
  const MIX = [['car', 0.62], ['bike', 0.25], ['bus', 0.13]];

  const DEFAULTS = {
    mode: 'adaptive',            // fixed | adaptive | manual
    fixedGreen: { ns: 30, ew: 30 },
    yellow: 3, allRed: 2,
    minGreen: 8, maxGreen: 50, gapOut: 2.5, switchRatio: 1.3, waitWeight: 0.15,
    preempt: true, emergencyRange: 100, safetyGreen: 3,
    sensorRange: 45, sensorMiss: 0,
    rates: { N: 400, E: 400, S: 400, W: 400 },   // veh/h per approach
    ambRate: 0,                                  // random ambulances per hour
    seed: 1, dt: 0.1, warmup: 0, record: true
  };

  const idleLitresPerSec = 0.8 / 3600;   // assumed idle burn: 0.8 L/h per vehicle (indicative)
  const kgCo2PerLitre = 2.3;             // petrol, approximate

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const zero4 = (v) => ({ N: v, E: v, S: v, W: v });

  function losFromDelay(d) {      // HCM 6th ed. signalised intersection thresholds (s/veh)
    if (d <= 10) return 'A';
    if (d <= 20) return 'B';
    if (d <= 35) return 'C';
    if (d <= 55) return 'D';
    if (d <= 80) return 'E';
    return 'F';
  }

  /* ------------------------------------------------------------------ */
  class Simulation {
    constructor(cfg) {
      this.cfg = Object.assign(clone(DEFAULTS), clone(cfg || {}));
      this.reset();
    }

    reset(seed) {
      if (seed !== undefined) this.cfg.seed = seed;
      this.t = 0;
      this.rng = mulberry32(this.cfg.seed);
      this.nextId = 1;
      this.veh = { N: [], E: [], S: [], W: [] };
      this.backlog = zero4(0);
      this.pendingAmb = zero4(0);
      this._nextType = {};
      this.sig = { startCount: 0, phase: 0, stage: 'GREEN', timer: 0, next: 1, manual: 0, hold: false, preempting: false };
      this.sens = {};
      APPROACHES.forEach((a) => {
        this.sens[a] = { in: 0, out: 0, near: false, far: false, count: 0, wait: 0, sinceSeen: 99, idle: 0 };
      });
      this.sensorOverride = null;
      this.emerg = zero4(false);
      this.rates = clone(this.cfg.rates);
      this.schedule = []; this.schedIdx = 0;
      this.stats = this._newStats();
      this.series = [];
      this.phaseLog = [{ t: 0, code: 0 }];
      this._lastSample = 0;
      this.recent = [];
      this.events = [];     // textual event log for the UI / serial console
      if (this.onEvent === undefined) this.onEvent = null;
      this._signature = '';
    }

    _newStats() {
      return {
        crossed: 0, delaySum: 0, stopsSum: 0, maxDelay: 0,
        spawned: 0, idleSec: 0,
        qInt: zero4(0), qMax: zero4(0), crossedBy: zero4(0), delayBy: zero4(0),
        green: [0, 0], phaseChanges: 0, preemptions: 0,
        amb: { n: 0, delaySum: 0, max: 0 },
        byType: { car: 0, bike: 0, bus: 0, amb: 0 }
      };
    }

    loadScenario(scn) {
      this.schedule = clone(scn.schedule || [{ t: 0, rates: scn.rates }]);
      this.schedIdx = 0;
      this.cfg.ambRate = scn.ambRate || 0;
      this._applySchedule();
    }
    _applySchedule() {
      while (this.schedIdx < this.schedule.length && this.schedule[this.schedIdx].t <= this.t) {
        this.rates = Object.assign({}, this.rates, this.schedule[this.schedIdx].rates);
        this.schedIdx++;
      }
    }
    setRates(r) { this.schedule = []; this.rates = Object.assign({}, this.rates, r); }
    setMode(mode) {
      this.cfg.mode = mode;
      if (mode === 'manual') this.sig.manual = this.sig.stage === 'GREEN' || this.sig.stage === 'YELLOW' ? this.sig.phase : this.sig.next;
      this._emit('MODE ' + mode.toUpperCase());
    }
    setManual(target) { this.sig.manual = target; this._emit('MANUAL TARGET ' + target); }
    dispatchEmergency(a) { this.pendingAmb[a]++; this._emit('EMERGENCY VEHICLE DISPATCHED FROM ' + a); }

    _emit(msg) {
      const e = { t: this.t, msg };
      this.events.push(e); if (this.events.length > 300) this.events.shift();
      if (this.onEvent) this.onEvent(e);
    }

    /* ---------------------------- signals --------------------------- */
    signalOf(a) {
      const s = this.sig;
      if (PHASE_OF[a] !== s.phase) return 'R';
      return s.stage === 'GREEN' ? 'G' : s.stage === 'YELLOW' ? 'Y' : 'R';
    }
    signalCode() {   // 0 NS green, 1 EW green, 2 yellow, 3 all red  (for the timeline)
      const s = this.sig;
      if (s.stage === 'GREEN') return s.phase;
      return s.stage === 'YELLOW' ? 2 : 3;
    }

    _count(a) {
      const o = this.sensorOverride;
      if (o && o[a] !== undefined && o[a] !== null) return o[a];
      return this.sens[a].count;
    }
    _score(phase) {
      let sc = 0;
      for (const a of APPROACHES) {
        if (PHASE_OF[a] !== phase) continue;
        const c = this._count(a);
        if (c > 0) sc += c + this.cfg.waitWeight * this.sens[a].wait;
      }
      return sc;
    }
    _demand(phase) {
      let n = 0;
      for (const a of APPROACHES) if (PHASE_OF[a] === phase) n += this._count(a);
      return n;
    }
    _gapClear(phase) {
      for (const a of APPROACHES) if (PHASE_OF[a] === phase && this.sens[a].sinceSeen < this.cfg.gapOut) return false;
      return true;
    }

    _shouldTerminate() {
      const c = this.cfg, s = this.sig, cur = s.phase, oth = 1 - cur;

      // 1. emergency pre-emption overrides every controller
      s.preempting = false;
      if (c.preempt && c.mode !== 'manual') {
        const curEm = APPROACHES.some((a) => PHASE_OF[a] === cur && this.emerg[a]);
        const othEm = APPROACHES.some((a) => PHASE_OF[a] === oth && this.emerg[a]);
        if (curEm && s.timer < c.maxGreen + 40) { s.preempting = true; return false; }
        if (othEm && s.timer >= c.safetyGreen) { s.preempting = true; this.stats.preemptions++; return true; }
      }

      if (c.mode === 'manual') {
        const tgt = s.manual;
        if (tgt === cur) return false;
        return s.timer >= 5;                 // safety interlock: never cut a green shorter than 5 s
      }
      if (c.mode === 'fixed') {
        const g = cur === 0 ? c.fixedGreen.ns : c.fixedGreen.ew;
        return s.timer >= g;
      }
      // adaptive: demand-responsive green extension / termination
      const need = Math.min(c.maxGreen, Math.max(c.minGreen, 4 + 2.0 * (s.startCount || 0)));   // time needed to discharge the queue present at green start
      if (s.timer < need) return false;
      const demOth = this._demand(oth);
      if (s.timer >= c.maxGreen + 30) return true;          // fail-safe recall: a sensor fault can never hold one phase indefinitely
      if (s.timer >= c.maxGreen) return demOth > 0;
      if (demOth === 0) return false;                       // nobody waiting: rest in green
      if (this._demand(cur) === 0 && this._gapClear(cur)) return true;   // gap-out
      return this._score(oth) > c.switchRatio * this._score(cur) + 1;      // pressure comparison with hysteresis
    }

    _signalStep(dt) {
      const s = this.sig, c = this.cfg;
      s.timer += dt;
      if (s.stage === 'GREEN') {
        if (this._shouldTerminate()) {
          s.stage = 'YELLOW'; s.timer = 0; s.next = 1 - s.phase;
          if (c.mode === 'manual' && s.manual !== 'allred' && s.manual !== s.phase) s.next = s.manual;
          this.stats.phaseChanges++;
        }
      } else if (s.stage === 'YELLOW') {
        if (s.timer >= c.yellow) { s.stage = 'ALLRED'; s.timer = 0; }
      } else {
        if (c.mode === 'manual' && s.manual === 'allred') { s.timer = Math.min(s.timer, c.allRed); }
        else if (s.timer >= c.allRed) {
          s.phase = (c.mode === 'manual' && typeof s.manual === 'number') ? s.manual : s.next;
          s.stage = 'GREEN'; s.timer = 0; s.startCount = this._demand(s.phase);
        }
      }
      const sigStr = APPROACHES.map((a) => this.signalOf(a)).join('');
      if (sigStr !== this._signature) {
        this._signature = sigStr;
        this.phaseLog.push({ t: this.t, code: this.signalCode() });
        if (this.phaseLog.length > 4000) this.phaseLog.shift();
        this._emit('SIGNAL ' + APPROACHES.map((a) => a + ':' + this.signalOf(a)).join(' '));
      }
    }

    /* ---------------------------- vehicles -------------------------- */
    _pickType() {
      let r = this.rng();
      for (const [t, p] of MIX) { if ((r -= p) < 0) return t; }
      return 'car';
    }
    _trySpawn(a, type) {
      const T = VEH_TYPES[type], list = this.veh[a];
      const last = list.length ? list[list.length - 1] : null;
      let ve = T.v0 * 0.9;
      if (last) {
        ve = Math.min(ve, last.v + 1);
        if (GEOM.spawnD - (last.d + last.len) < T.s0 + 3 + ve * T.T) return false;
      }
      list.push({
        id: this.nextId++, type, T, len: T.len, d: GEOM.spawnD, prevD: GEOM.spawnD + 1, v: ve,
        t0: this.t, stopped: false, hadSpeed: false, stops: 0, crossed: false, idle: 0,
        hue: Math.floor(this.rng() * 360)
      });
      this.stats.spawned++;
      return true;
    }
    _spawn(dt) {
      const c = this.cfg;
      for (const a of APPROACHES) {
        const lam = (this.rates[a] || 0) / 3600;
        if (this.rng() < 1 - Math.exp(-lam * dt)) this.backlog[a]++;
        if (this.pendingAmb[a] > 0) { if (this._trySpawn(a, 'amb')) this.pendingAmb[a]--; }
        else if (this.backlog[a] > 0) {
          const type = this._peekType(a);
          if (this._trySpawn(a, type)) { this.backlog[a]--; this._nextType[a] = null; }
        }
      }
      if (c.ambRate > 0 && this.rng() < 1 - Math.exp(-(c.ambRate / 3600) * dt)) {
        const a = APPROACHES[Math.floor(this.rng() * 4)];
        this.dispatchEmergency(a);
      }
    }
    _peekType(a) {
      if (!this._nextType) this._nextType = {};
      if (!this._nextType[a]) this._nextType[a] = this._pickType();
      return this._nextType[a];
    }

    _moveApproach(a, dt) {
      const list = this.veh[a], sg = this.signalOf(a), n = list.length;
      if (!n) return;
      const acc = new Array(n);
      for (let i = 0; i < n; i++) {
        const v = list[i], T = v.T;
        let gap = Infinity, vl = v.v;
        if (i > 0) { const L = list[i - 1]; gap = v.d - (L.d + L.len); vl = L.v; }
        if (v.d > 0) {
          let stop = false;
          if (sg === 'R') stop = true;
          else if (sg === 'Y') stop = v.d > v.v * 1.0 + (v.v * v.v) / 7;
          if (stop) { const g2 = v.d - 0.5; if (g2 < gap) { gap = g2; vl = 0; } }
        }
        if (gap < 0.05) gap = 0.05;
        const dv = v.v - vl;
        const sStar = T.s0 + Math.max(0, v.v * T.T + (v.v * dv) / (2 * Math.sqrt(T.a * T.b)));
        let ac = T.a * (1 - Math.pow(v.v / T.v0, 4) - (gap === Infinity ? 0 : Math.pow(sStar / gap, 2)));
        if (ac < -9) ac = -9;
        acc[i] = ac;
      }
      const st = this.stats, past = this.t >= this.cfg.warmup;
      let removeCount = 0;
      for (let i = 0; i < n; i++) {
        const v = list[i];
        v.prevD = v.d;
        v.v = Math.max(0, v.v + acc[i] * dt);
        v.d -= v.v * dt;
        if (i > 0) {                       // hard no-overlap safety net
          const L = list[i - 1], lim = L.d + L.len + 0.1;
          if (v.d < lim) { v.d = lim; if (v.v > L.v) v.v = L.v; }
        }
        if (v.d > 0) {
          if (v.v < 0.5) {
            v.idle += dt;
            if (past) st.idleSec += dt;
            if (!v.stopped && v.hadSpeed) { v.stopped = true; v.stops++; }
          } else if (v.v > 2) { v.stopped = false; v.hadSpeed = true; }
        }
        if (v.prevD > 0 && v.d <= 0) this._onCross(a, v, past);
        if (v.d < -(2 * GEOM.half + GEOM.exitLen)) removeCount++;
      }
      // vehicles leave in FIFO order from the front of the array
      if (removeCount) list.splice(0, removeCount);
    }

    _onCross(a, v, past) {
      v.crossed = true;
      const s = this.sens[a];
      if (this.rng() >= this.cfg.sensorMiss) s.out++;
      const delay = Math.max(0, (this.t - v.t0) - GEOM.spawnD / v.T.v0);
      this.recent.push({ t: this.t, delay });
      if (!past) return;
      const st = this.stats;
      if (v.type === 'amb') {
        st.amb.n++; st.amb.delaySum += delay; st.amb.max = Math.max(st.amb.max, delay);
      }
      st.crossed++; st.delaySum += delay; st.stopsSum += v.stops; st.maxDelay = Math.max(st.maxDelay, delay);
      st.crossedBy[a]++; st.delayBy[a] += delay; st.byType[v.type]++;
    }

    _updateSensors(dt) {
      const c = this.cfg, pos = [3, c.sensorRange];
      for (const a of APPROACHES) {
        const s = this.sens[a], list = this.veh[a];
        s.near = s.far = false;
        for (let i = 0; i < list.length; i++) {
          const v = list[i];
          if (v.d <= pos[0] && v.d + v.len >= pos[0]) s.near = true;
          
          if (v.d <= pos[1] && v.d + v.len >= pos[1]) s.far = true;
          if (v.prevD > pos[1] && v.d <= pos[1] && this.rng() >= c.sensorMiss) s.in++;
        }
        if (s.out > s.in) s.in = s.out;
        const any = s.near || s.far;
        if (any) { s.sinceSeen = 0; s.idle = 0; } else { s.sinceSeen += dt; s.idle += dt; }
        if (s.idle > 15 && s.in !== s.out) s.in = s.out;      // self-correction of count drift
        s.count = s.in - s.out;
        if (this.signalOf(a) === 'R' && s.count > 0) s.wait += dt; else s.wait = 0;
        // emergency beacon receiver
        let em = false;
        for (let i = 0; i < list.length; i++) {
          const v = list[i];
          if (v.type === 'amb' && v.d <= c.emergencyRange && v.d > -6) { em = true; break; }
        }
        this.emerg[a] = em;
      }
    }

    trueQueue(a) {
      let q = 0; const list = this.veh[a];
      for (let i = 0; i < list.length; i++) if (list[i].d > 0 && list[i].v < 2) q++;
      return q;
    }

    /* ----------------------------- stepping -------------------------- */
    step(dt) {
      dt = dt || this.cfg.dt;
      this._applySchedule();
      this._spawn(dt);
      this._signalStep(dt);
      for (const a of APPROACHES) this._moveApproach(a, dt);
      this._updateSensors(dt);

      const st = this.stats;
      if (this.t >= this.cfg.warmup) {
        for (const a of APPROACHES) {
          const q = this.trueQueue(a);
          st.qInt[a] += q * dt;
          if (q > st.qMax[a]) st.qMax[a] = q;
        }
        if (this.sig.stage === 'GREEN') st.green[this.sig.phase] += dt;
      }
      this.t += dt;

      if (this.cfg.record && this.t - this._lastSample >= 1) {
        this._lastSample = this.t;
        while (this.recent.length && this.recent[0].t < this.t - 60) this.recent.shift();
        let ds = 0; for (const r of this.recent) ds += r.delay;
        this.series.push({
          t: this.t,
          q: APPROACHES.map((a) => this.trueQueue(a)),
          delay: this.recent.length ? ds / this.recent.length : null,
          thr: this.recent.length,                      // vehicles crossed in the last 60 s = veh/min
          code: this.signalCode()
        });
        if (this.series.length > 1800) this.series.shift();
      }
    }
    run(seconds) {
      const n = Math.round(seconds / this.cfg.dt);
      for (let i = 0; i < n; i++) this.step();
    }

    inSystem() {
      let n = 0;
      for (const a of APPROACHES) for (const v of this.veh[a]) if (v.d > 0) n++;
      for (const a of APPROACHES) n += this.backlog[a];
      return n;
    }

    summary() {
      const st = this.stats, T = Math.max(1, this.t - this.cfg.warmup);
      const avgDelay = st.crossed ? st.delaySum / st.crossed : 0;
      const qAvg = APPROACHES.reduce((s, a) => s + st.qInt[a], 0) / 4 / T;
      const fuel = st.idleSec * idleLitresPerSec;
      const gT = st.green[0] + st.green[1] || 1;
      return {
        duration: T,
        crossed: st.crossed,
        avgDelay,
        maxDelay: st.maxDelay,
        throughput: st.crossed / T * 3600,                 // veh/h
        avgQueue: qAvg,
        maxQueue: Math.max(...APPROACHES.map((a) => st.qMax[a])),
        stopsPerVeh: st.crossed ? st.stopsSum / st.crossed : 0,
        residual: this.inSystem(),
        idleFuelL: fuel,
        co2kg: fuel * kgCo2PerLitre,
        los: losFromDelay(avgDelay),
        ambDelay: st.amb.n ? st.amb.delaySum / st.amb.n : null,
        ambN: st.amb.n,
        greenShare: [st.green[0] / gT, st.green[1] / gT],
        delayBy: APPROACHES.map((a) => (st.crossedBy[a] ? st.delayBy[a] / st.crossedBy[a] : 0)),
        phaseChanges: st.phaseChanges,
        preemptions: st.preemptions
      };
    }
  }

  /* ------------------------------ scenarios ------------------------- */
  const SCENARIOS = {
    balanced: { label: 'Balanced flow (400 veh/h each)', schedule: [{ t: 0, rates: { N: 400, E: 400, S: 400, W: 400 } }] },
    rush_ew:  { label: 'Rush hour: East-West heavy', schedule: [{ t: 0, rates: { N: 200, S: 200, E: 650, W: 650 } }] },
    asym:     { label: 'Asymmetric arrivals', schedule: [{ t: 0, rates: { N: 550, E: 300, S: 150, W: 500 } }] },
    heavy:    { label: 'Near-saturation (650 veh/h each)', schedule: [{ t: 0, rates: { N: 650, E: 650, S: 650, W: 650 } }] },
    night:    { label: 'Night / low demand (90 veh/h each)', schedule: [{ t: 0, rates: { N: 90, E: 90, S: 90, W: 90 } }] },
    surge:    { label: 'Time-varying demand (3 regimes)', schedule: [
      { t: 0,    rates: { N: 600, S: 600, E: 150, W: 150 } },
      { t: 600,  rates: { N: 150, S: 150, E: 600, W: 600 } },
      { t: 1200, rates: { N: 350, S: 350, E: 350, W: 350 } } ] },
    emergency:{ label: 'Emergency vehicles (balanced + ambulances)', ambRate: 20,
                schedule: [{ t: 0, rates: { N: 400, E: 400, S: 400, W: 400 } }] }
  };

  function scenarioAvgRates(scn, duration) {
    const sch = scn.schedule, out = zero4(0);
    for (let i = 0; i < sch.length; i++) {
      const t0 = sch[i].t, t1 = i + 1 < sch.length ? Math.min(sch[i + 1].t, duration) : duration;
      if (t1 <= t0) continue;
      for (const a of APPROACHES) out[a] += (sch[i].rates[a] || 0) * (t1 - t0) / duration;
    }
    return out;
  }

  // Webster (1958) fixed-time plan: C0 = (1.5 L + 5) / (1 - Y); greens split in proportion to critical flow ratios
  function websterPlan(rates, cfg) {
    const s = 1500;                                           // saturation flow, veh/h/lane (measured for the simulated mixed fleet: 2.4 s headway)
    const yNS = Math.max(rates.N, rates.S) / s, yEW = Math.max(rates.E, rates.W) / s;
    const Y = Math.min(0.9, yNS + yEW), L = 8;                // 4 s lost time per phase
    const C = Math.max(30, Math.min(120, (1.5 * L + 5) / (1 - Y)));
    const gTot = C - L, lostAdj = 4 - (cfg.yellow + cfg.allRed);
    const split = (y) => Math.max(10, Math.round(gTot * (y / (yNS + yEW || 1)) + lostAdj));
    return { ns: split(yNS), ew: split(yEW), cycle: Math.round(C) };
  }

  const CONTROLLERS = {
    fixed:       { label: 'Fixed-time 30/30 s', mode: 'fixed', preempt: false, fixedGreen: { ns: 30, ew: 30 } },
    webster:     { label: 'Webster-tuned fixed', mode: 'fixed', preempt: false, webster: true },
    adaptive:    { label: 'Adaptive (proposed)', mode: 'adaptive', preempt: false },
    adaptive_ep: { label: 'Adaptive + pre-emption', mode: 'adaptive', preempt: true }
  };

  function runOnce(scn, ctl, seed, duration, warmup) {
    const cfg = { seed, warmup, record: false, mode: ctl.mode, preempt: ctl.preempt };
    if (ctl.fixedGreen) cfg.fixedGreen = ctl.fixedGreen;
    const sim = new Simulation(cfg);
    if (ctl.webster) sim.cfg.fixedGreen = websterPlan(scenarioAvgRates(scn, duration), sim.cfg);
    sim.loadScenario(scn);
    sim.run(duration);
    return { sum: sim.summary(), plan: sim.cfg.fixedGreen };
  }

  const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) * (x - m)))); };

  /* Runs every scenario x controller x seed. Calls onProgress(done,total) and yields to the
     event loop between runs when `async` is true so the browser UI stays responsive. */
  async function runBenchmark(opts, onProgress) {
    opts = Object.assign({ scenarios: ['balanced', 'rush_ew', 'asym', 'heavy', 'night', 'surge', 'emergency'], seeds: 5, duration: 1800, warmup: 120, yieldUI: false }, opts || {});
    const results = {}; let done = 0;
    const total = opts.scenarios.reduce((s, k) => s + (k === 'emergency' ? 4 : 3), 0) * opts.seeds;
    for (const key of opts.scenarios) {
      const scn = SCENARIOS[key];
      const ctls = key === 'emergency' ? ['fixed', 'adaptive', 'adaptive_ep', 'webster'] : ['fixed', 'webster', 'adaptive'];
      results[key] = { label: scn.label, ctl: {} };
      for (const cid of ctls) {
        const runs = [];
        let plan = null;
        for (let k = 0; k < opts.seeds; k++) {
          const r = runOnce(scn, CONTROLLERS[cid], 101 + k * 17, opts.duration, opts.warmup);
          runs.push(r.sum); plan = r.plan;
          done++;
          if (onProgress) onProgress(done, total, key, cid);
          if (opts.yieldUI) await new Promise((res) => setTimeout(res, 0));
        }
        const agg = {};
        ['avgDelay', 'avgQueue', 'throughput', 'stopsPerVeh', 'residual', 'co2kg', 'maxDelay'].forEach((m) => {
          const arr = runs.map((r) => r[m]); agg[m] = { mean: mean(arr), sd: sd(arr) };
        });
        const amb = runs.map((r) => r.ambDelay).filter((x) => x !== null);
        agg.ambDelay = amb.length ? { mean: mean(amb), sd: sd(amb) } : null;
        agg.los = losFromDelay(agg.avgDelay.mean);
        agg.greenShare = [mean(runs.map((r) => r.greenShare[0])), mean(runs.map((r) => r.greenShare[1]))];
        agg.plan = cid === 'webster' ? plan : null;
        results[key].ctl[cid] = agg;
      }
    }
    return { opts, results };
  }

  return {
    Simulation, SCENARIOS, CONTROLLERS, VEH_TYPES, APPROACHES, PHASE_OF, PHASE_NAMES, GEOM, DIR, STOP_PT,
    DEFAULTS, websterPlan, scenarioAvgRates, runBenchmark, runOnce, losFromDelay, mulberry32
  };
});
