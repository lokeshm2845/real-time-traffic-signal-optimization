# AdaptiveSignal Control Console

Software prototype for the Design Experience II project **Real-Time Traffic Signal Optimization**.
It is the simulation, control and monitoring side of the hardware junction model (ESP32 + IR beam
sensors + LED signal heads).

## Run it

No build step and no internet connection needed.

1. Double-click `index.html` (Chrome or Edge recommended).
2. Use the four tabs: **Live control**, **Analytics**, **Benchmark**, **Hardware link**.

## What is inside

| File | Purpose |
|------|---------|
| `index.html`, `css/style.css` | Console layout |
| `js/sim.js` | Traffic simulator, signal state machine, fixed / Webster / adaptive controllers, benchmark runner. Runs in the browser and in Node (`require('./js/sim.js')`). |
| `js/charts.js` | Dependency-free canvas charts |
| `js/app.js` | Rendering, controls, benchmark UI, serial link |
| `firmware/traffic_controller/` | Reference ESP32 firmware that speaks the same serial protocol (not yet compiled or flashed) |

## Controllers

* **Fixed-time** : repeats a pre-set green split (default 30 s / 30 s).
* **Adaptive** : sees only what the IR beams measure (entry minus exit counts, presence). Ends green on
  gap-out, on max green, or when the opposing demand score exceeds 1.3 x the active score; the
  green is never shorter than the time needed to discharge the queue present when it started.
* **Manual** : operator override with a 5 s minimum-green interlock; yellow and all-red are always enforced.
* **Emergency pre-emption** : an ambulance beacon within 100 m switches or holds the green for its approach.

## Hardware link

The console talks to the board over a serial port (Web Serial API, Chrome or Edge on desktop).
With no board connected a virtual ESP32 acknowledges the protocol, so the whole chain can be tested at the desk.

```
S,G,R,G,R   console -> board : signal states for N, E, S, W
E,N         console -> board : emergency vehicle on approach N
C,3,0,2,1   board -> console : vehicles inside each monitored zone
OK          board -> console : acknowledgement
```

Tick **Use hardware sensor counts as controller input** to let the physical beam counts drive the adaptive controller.
Hardware-in-the-loop operation has only been exercised against the virtual board so far.

## Reproduce the benchmark from the command line

```
node scripts/analysis.js     # writes scripts/results.json (10 seeds, all scenarios and sensitivity runs)
```

## Assumptions and limits

* Single lane per approach, straight-through movements only, two-phase signal, left-hand traffic.
* Car-following uses the Intelligent Driver Model; two-wheelers queue in single file (no filtering).
* Idle emissions assume 0.8 L/h per stopped vehicle and 2.3 kg CO2 per litre; treat as indicative.
* Delay levels of service follow the HCM 6th edition thresholds for signalised intersections.
