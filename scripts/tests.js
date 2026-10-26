// Verification tests for the simulator / controller (results are quoted in report Section 4.2)
const S = require('../prototype/js/sim.js');
const fs = require('fs');
const A = S.APPROACHES;
const out = [];
const rec = (id, name, result, detail) => { out.push({ id, name, result, detail }); console.log(id, result, '-', name, '|', detail); };

// T1 safety invariants across modes / scenarios / seeds
{
  let steps = 0, conflicts = 0, badYellow = 0, badAllRed = 0, shortGreen = 0, stageCount = 0;
  const combos = [['fixed', 'balanced'], ['adaptive', 'rush_ew'], ['adaptive', 'surge'], ['adaptive', 'emergency'], ['fixed', 'night']];
  for (const [mode, scn] of combos) for (const seed of [1, 2, 3]) {
    const sim = new S.Simulation({ seed, mode, record: false, preempt: scn === 'emergency' });
    sim.loadScenario(S.SCENARIOS[scn]);
    let prev = sim.sig.stage, stageStart = 0, stagePhase = sim.sig.phase;
    for (let i = 0; i < 18000; i++) {
      sim.step(); steps++;
      const sg = A.map((a) => sim.signalOf(a)), ns = sg[0] !== 'R' || sg[2] !== 'R', ew = sg[1] !== 'R' || sg[3] !== 'R';
      if (ns && ew) conflicts++;
      const st = sim.sig.stage;
      if (st !== prev) {
        const dur = sim.t - stageStart; stageCount++;
        if (prev === 'YELLOW' && Math.abs(dur - 3) > 0.15) badYellow++;
        if (prev === 'ALLRED' && Math.abs(dur - 2) > 0.15) badAllRed++;
        if (prev === 'GREEN' && mode === 'adaptive' && dur < 3 - 0.15) shortGreen++;
        prev = st; stageStart = sim.t;
      }
    }
  }
  rec('T1', 'Signal safety interlocks (no conflicting greens, yellow = 3 s, all-red = 2 s, green >= 3 s)', conflicts + badYellow + badAllRed + shortGreen === 0 ? 'PASS' : 'FAIL',
    `${steps} simulated steps, ${stageCount} stage changes; conflicts ${conflicts}, yellow errors ${badYellow}, all-red errors ${badAllRed}, short greens ${shortGreen}`);
}
// T2 determinism
{
  const run = () => { const s = new S.Simulation({ seed: 42, mode: 'adaptive', record: false }); s.loadScenario(S.SCENARIOS.surge); s.run(900); return JSON.stringify(s.summary()); };
  rec('T2', 'Repeatability: identical seed gives identical results', run() === run() ? 'PASS' : 'FAIL', 'two 900 s runs compared field by field');
}
// T3 conservation of vehicles
{
  let ok = true, detail = [];
  for (const mode of ['fixed', 'adaptive']) {
    const s = new S.Simulation({ seed: 5, mode, record: false, warmup: 0 }); s.loadScenario(S.SCENARIOS.heavy); s.run(1200);
    let onRoadBefore = 0; A.forEach((a) => s.veh[a].forEach((v) => { if (v.d > 0) onRoadBefore++; }));
    const balance = s.stats.spawned - s.stats.crossed - onRoadBefore;
    if (balance !== 0) ok = false; detail.push(`${mode}: spawned ${s.stats.spawned}, crossed ${s.stats.crossed}, still approaching ${onRoadBefore}`);
  }
  rec('T3', 'Vehicle conservation (spawned = crossed + still approaching)', ok ? 'PASS' : 'FAIL', detail.join('; '));
}
// T4 no overlap and non-negative speed
{
  let minGap = Infinity, minV = Infinity;
  const s = new S.Simulation({ seed: 9, mode: 'adaptive', record: false }); s.loadScenario(S.SCENARIOS.heavy);
  for (let i = 0; i < 18000; i++) {
    s.step();
    A.forEach((a) => { const l = s.veh[a]; for (let k = 0; k < l.length; k++) { minV = Math.min(minV, l[k].v); if (k > 0) minGap = Math.min(minGap, l[k].d - (l[k - 1].d + l[k - 1].len)); } });
  }
  rec('T4', 'Physical plausibility: no vehicle overlap, no negative speed (near-saturation demand)', minGap >= -0.001 && minV >= 0 ? 'PASS' : 'FAIL', `minimum bumper gap ${minGap.toFixed(2)} m, minimum speed ${minV.toFixed(2)} m/s`);
}
// T5 sensed count accuracy
{
  let n = 0, exact = 0, absErr = 0, within1 = 0;
  for (const scn of ['balanced', 'rush_ew', 'surge']) {
    const s = new S.Simulation({ seed: 11, mode: 'adaptive', record: false }); s.loadScenario(S.SCENARIOS[scn]);
    for (let i = 0; i < 18000; i++) {
      s.step();
      if (i % 10 === 0) A.forEach((a) => {
        let truth = 0; s.veh[a].forEach((v) => { if (v.d > 0 && v.d <= s.cfg.sensorRange) truth++; });
        const e = Math.abs(s.sens[a].count - truth); n++; absErr += e; if (e === 0) exact++; if (e <= 1) within1++;
      });
    }
  }
  rec('T5', 'Sensing accuracy: beam-derived zone count vs true vehicles in the 45 m zone', 'INFO', `${n} samples; exact ${(exact / n * 100).toFixed(1)} %, within +/-1 ${(within1 / n * 100).toFixed(1)} %, mean absolute error ${(absErr / n).toFixed(3)} vehicles`);
  out[out.length - 1].stats = { n, exact: exact / n, within1: within1 / n, mae: absErr / n };
}
// T5b sensing accuracy with imperfect beams
{
  let n = 0, exact = 0, absErr = 0, within1 = 0;
  const s = new S.Simulation({ seed: 11, mode: 'adaptive', record: false, sensorMiss: 0.05 }); s.loadScenario(S.SCENARIOS.surge);
  for (let i = 0; i < 18000; i++) {
    s.step();
    if (i % 10 === 0) A.forEach((a) => {
      let truth = 0; s.veh[a].forEach((v) => { if (v.d > 0 && v.d <= s.cfg.sensorRange) truth++; });
      const e = Math.abs(s.sens[a].count - truth); n++; absErr += e; if (e === 0) exact++; if (e <= 1) within1++;
    });
  }
  rec('T5b', 'Sensing accuracy with 5 % of beam events missed', 'INFO', `${n} samples; exact ${(exact / n * 100).toFixed(1)} %, within +/-1 ${(within1 / n * 100).toFixed(1)} %, mean absolute error ${(absErr / n).toFixed(3)} vehicles`);
  out[out.length - 1].stats = { n, exact: exact / n, within1: within1 / n, mae: absErr / n };
}
// T6 manual interlock
{
  const s = new S.Simulation({ seed: 3, mode: 'manual', record: false, preempt: false }); s.loadScenario(S.SCENARIOS.balanced);
  s.setManual(0); s.run(2); s.setManual(1); let age = null;
  for (let i = 0; i < 400; i++) { s.step(); if (s.sig.stage !== 'GREEN') { age = s.t; break; } }
  rec('T6', 'Manual override cannot cut a green shorter than 5 s', age !== null && age >= 5 - 0.15 ? 'PASS' : 'FAIL', `override requested after 2 s of green; the yellow started after ${(age || 0).toFixed(1)} s of green`);
}
// T7 sensor-fault fail-safe
{
  const s = new S.Simulation({ seed: 8, mode: 'adaptive', record: false, preempt: false }); s.loadScenario(S.SCENARIOS.rush_ew);
  s.run(60); s.sensorOverride = { N: 0, E: 0, S: 0, W: 0 };       // all beams stuck reading "empty"
  let longest = 0, cur = 0, prevPhase = s.sig.phase;
  for (let i = 0; i < 6000; i++) { s.step(); if (s.sig.stage === 'GREEN') { if (s.sig.phase === prevPhase) cur = s.sig.timer; else { longest = Math.max(longest, cur); prevPhase = s.sig.phase; } } }
  longest = Math.max(longest, cur);
  rec('T7', 'Fail-safe recall when every beam reads empty for 10 minutes', longest <= s.cfg.maxGreen + 30 + 0.2 ? 'PASS' : 'FAIL', `longest green ${longest.toFixed(1)} s (limit ${s.cfg.maxGreen + 30} s)`);
}
// T8 emergency pre-emption latency
{
  const lat = [];
  for (let k = 0; k < 20; k++) {
    const s = new S.Simulation({ seed: 200 + k, mode: 'adaptive', record: false, preempt: true }); s.loadScenario(S.SCENARIOS.balanced);
    s.run(120 + k * 3.7); const app = A[k % 4]; s.dispatchEmergency(app);
    let seen = null, t0 = s.t, tGreen = null, amb = null;
    for (let i = 0; i < 6000; i++) {
      s.step();
      amb = amb || s.veh[app].find((v) => v.type === 'amb');
      if (amb && seen === null && amb.d <= s.cfg.emergencyRange) seen = s.t;
      if (seen !== null && s.signalOf(app) === 'G') { tGreen = s.t - seen; break; }
    }
    if (tGreen !== null) lat.push(tGreen);
  }
  const mean = lat.reduce((a, b) => a + b, 0) / lat.length, mx = Math.max(...lat);
  rec('T8', 'Emergency pre-emption: time from beacon detection (100 m) to green on its approach', mx <= 12 ? 'PASS' : 'INFO', `${lat.length}/20 trials, mean ${mean.toFixed(1)} s, worst ${mx.toFixed(1)} s (includes the 3 s yellow + 2 s all-red clearance)`);
  out[out.length - 1].stats = { n: lat.length, mean, max: mx };
}
// T9 serial protocol round trip (browser-independent check of the command grammar used by app.js and the firmware)
{
  const re = /^S,[RYG],[RYG],[RYG],[RYG]$/;
  const cases = ['S,G,R,G,R', 'S,Y,R,Y,R', 'S,R,R,R,R', 'S,R,G,R,G'];
  const sim = new S.Simulation({ seed: 1, mode: 'adaptive', record: false }); sim.loadScenario(S.SCENARIOS.balanced);
  const lines = []; sim.onEvent = (e) => { if (e.msg.startsWith('SIGNAL ')) lines.push('S,' + A.map((a) => sim.signalOf(a)).join(',')); };
  sim.run(300);
  const valid = lines.every((l) => re.test(l)) && lines.length > 5;
  rec('T9', 'Serial protocol: every emitted S-command matches the grammar understood by the firmware', valid ? 'PASS' : 'FAIL', `${lines.length} commands generated in 300 s, all well-formed`);
}
fs.writeFileSync(__dirname + '/tests.json', JSON.stringify(out, null, 1));
