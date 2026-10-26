const S = require('../prototype/js/sim.js');
const fs = require('fs');
(async () => {
  const out = {};
  console.time('bench');
  out.bench = await S.runBenchmark({ seeds: 10 });
  console.timeEnd('bench');
  const seeds = [0,1,2,3,4,5,6,7,8,9].map(k => 101 + k * 17);
  const mean = a => a.reduce((s,x)=>s+x,0)/a.length;
  const run = (scn, cfg, ctlOver) => {
    const d = [], q = [], r = [], st = [];
    for (const sd of seeds) {
      const sim = new S.Simulation(Object.assign({ seed: sd, warmup: 120, record: false, preempt: false }, cfg));
      if (cfg.webster) sim.cfg.fixedGreen = S.websterPlan(S.scenarioAvgRates(scn, 1800), sim.cfg);
      sim.loadScenario(scn); sim.run(1800); const m = sim.summary();
      d.push(m.avgDelay); q.push(m.avgQueue); r.push(m.residual); st.push(m.stopsPerVeh);
    }
    return { delay: mean(d), queue: mean(q), resid: mean(r), stops: mean(st) };
  };
  // (a) delay vs demand level (balanced demand per approach)
  out.load = [];
  for (const rate of [100, 200, 300, 400, 500, 600, 700, 800]) {
    const scn = { schedule: [{ t: 0, rates: { N: rate, E: rate, S: rate, W: rate } }] };
    out.load.push({ rate,
      fixed: run(scn, { mode: 'fixed', fixedGreen: { ns: 30, ew: 30 } }),
      webster: run(scn, { mode: 'fixed', webster: true }),
      adaptive: run(scn, { mode: 'adaptive' }) });
    console.log('load', rate, out.load[out.load.length-1].fixed.delay.toFixed(1), out.load[out.load.length-1].webster.delay.toFixed(1), out.load[out.load.length-1].adaptive.delay.toFixed(1));
  }
  // (b) detector miss-rate sensitivity
  out.miss = [];
  for (const sm of [0, 0.02, 0.05, 0.1, 0.2, 0.3]) {
    out.miss.push({ miss: sm, surge: run(S.SCENARIOS.surge, { mode: 'adaptive', sensorMiss: sm }), rush: run(S.SCENARIOS.rush_ew, { mode: 'adaptive', sensorMiss: sm }) });
    console.log('miss', sm, out.miss[out.miss.length-1].surge.delay.toFixed(1), out.miss[out.miss.length-1].rush.delay.toFixed(1));
  }
  // (c) minimum-green / max-green parameter sweep
  out.mingreen = [];
  for (const mg of [4, 6, 8, 12, 16, 20]) {
    out.mingreen.push({ mg, surge: run(S.SCENARIOS.surge, { mode: 'adaptive', minGreen: mg }), asym: run(S.SCENARIOS.asym, { mode: 'adaptive', minGreen: mg }) });
    console.log('mingreen', mg, out.mingreen[out.mingreen.length-1].surge.delay.toFixed(1), out.mingreen[out.mingreen.length-1].asym.delay.toFixed(1));
  }
  out.maxgreen = [];
  for (const mx of [30, 40, 50, 60, 80]) {
    out.maxgreen.push({ mx, heavy: run(S.SCENARIOS.heavy, { mode: 'adaptive', maxGreen: mx }), surge: run(S.SCENARIOS.surge, { mode: 'adaptive', maxGreen: mx }) });
    console.log('maxgreen', mx, out.maxgreen[out.maxgreen.length-1].heavy.delay.toFixed(1), out.maxgreen[out.maxgreen.length-1].surge.delay.toFixed(1));
  }
  fs.writeFileSync(__dirname + '/results.json', JSON.stringify(out, null, 1));
})();
