# @zakkster/lite-perf-gate

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-perf-gate.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-perf-gate)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Hot%20path-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-perf-gate?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-perf-gate)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-perf-gate?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-perf-gate)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-perf-gate?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-perf-gate)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

> Prove your hot path allocates nothing -- or name what did.

Zero-GC and performance regression gate for `node:test`. Scavenge-counting with scaling verdict, built-in detector self-validation, and CI pass/fail. No sampling, no heuristics, no false passes.

```bash
npm install @zakkster/lite-perf-gate
```

## Why this exists

`benchmark.js` is dead. `tinybench` and `mitata` measure throughput but don't **gate** -- they can't fail a CI build when a hot path starts allocating. The V8 sampling heap profiler reports live-at-stop bytes, silently **missing transient garbage** -- the exact GC pressure a zero-alloc claim is about. Retained-heap delta (`heapUsed` before/after + `gc()`) misses it too: freed before snapshot.

Scavenge-counting is the only reliable detector of transient allocation. This library packages the methodology into a `node:test`-native harness that validates its own detector on every run.

## Quick start

```js
// test/zero-gc.test.mjs
import { zgcSuite } from '@zakkster/lite-perf-gate';

zgcSuite({
    scenarios: [
        {
            name: 'steady-state propagation',
            setup() {
                const engine = buildYourGraph();
                return engine;
            },
            hot(engine, n) {
                for (let i = 0; i < n; i++) engine.update(i);
            },
            statsOf(engine) {
                return engine.stats();  // { poolGrowths, totalAllocations, ... }
            }
        }
    ],
    counters: { poolGrowths: 0, totalAllocations: 0 }
});
```

```bash
node --expose-gc --max-semi-space-size=4 --test test/zero-gc.test.mjs
```

## What it does

1. **Validates the detector.** A positive control (allocates per iteration) must force scavenges. A negative control (pure arithmetic) must force ~0. If either fails, the gate refuses to judge -- you get an explicit "detector broken" error, not a silent false pass.

2. **Measures at two scales.** Each scenario runs at N and k\*N iterations. A zero-alloc path shows ~0 scavenges at both; an allocating path shows scavenges scaling with bytes. The comparison is not hostage to one absolute threshold.

3. **Asserts the verdict.** Scavenges, retained-heap, and custom counter deltas are checked against thresholds. A failure names the signal that tripped.

4. **Self-tests the gate.** `mustFail` scenarios inject a known allocation and assert the gate catches it. If your gate can't catch a leak, it tells you.

## Three signals, each for what it can see

| Signal | Detects | Misses |
|--------|---------|--------|
| Scavenge count (`perf_hooks` GC minor) | Transient allocation (the GC pressure zero-alloc claims are about) | Nothing in the young-gen domain |
| Custom counters (`statsOf` deltas) | Exact engine internals (pool growth, node allocation) | Anything outside the engine's own bookkeeping |
| Retained-heap delta (`memoryUsage` + `gc()`) | Leaks (memory that survives GC) | Transient garbage (freed before snapshot) |

## API

### `zgcSuite(config)`

Register `node:test` cases for detector validation, scenario gating, and must-fail self-tests.

```ts
interface GateConfig {
    scenarios: Scenario[];          // your hot-path scenarios
    N?: number;                     // iteration count, default 200000
    k?: number;                     // scale factor, default 8
    maxScavenges?: number;          // threshold at k*N, default 2
    maxRetainedKB?: number;         // heap growth threshold, default 64
    counters?: Record<string, number>; // per-counter max delta
    positiveControl?: Scenario;     // override built-in
    negativeControl?: Scenario;     // override built-in
    mustFail?: Scenario[];          // must trip the gate
}
```

### `measure(scenario, options?)`

Raw measurement at N and k\*N. Returns `MeasureResult` with scavenge counts, retained heap, and counter deltas.

### `verdict(result, thresholds?)`

Evaluate a `MeasureResult` against thresholds. Returns `{ pass: boolean, reasons: string[] }`.

### `runGate(config)`

Standalone human-readable report. Same config as `zgcSuite`. Returns `{ passed, results }`.

### `Scenario`

```ts
interface Scenario<State = any> {
    name: string;
    setup(): State;
    hot(state: State, n: number): void;
    statsOf?(state: State): Record<string, number>;
    teardown?(state: State): void;
}
```

The `hot` function is the ONLY code inside the measurement window. `setup` and `teardown` run outside.

## Measurement traps (why it's built this way)

Two approaches were tried and rejected -- both produce **false passes**:

- **Retained-heap delta alone** only sees retention. A hot path that allocates and frees every iteration shows ~0 delta -- yet that transient churn is exactly the GC pressure the claim is about.
- **V8 sampling heap profiler** (`HeapProfiler.startSampling`) reports live-at-stop sampled bytes, so it likewise misses transient garbage.

Two V8 gotchas the controls handle:

- **Escape analysis / scalar replacement** erases function-local throwaway allocations entirely. The positive control allocates into a module-level sink that genuinely escapes.
- **GC PerformanceObserver entries are async.** The window is followed by a timer tick before the count is read, and the count is snapshotted before the harness's own `gc()` calls.

## `--max-semi-space-size=4`

The default V8 semi-space is 16MB. At 200k iterations of 64-byte objects, you produce ~12MB -- possibly fitting without a single scavenge. `--max-semi-space-size=4` shrinks the young generation to 4MB, forcing scavenges on smaller cumulative allocation and sharpening sensitivity. The four-field positive control (`{x,y,z,w}`) provides margin even without this flag, but the flag is recommended for production gates.

## CI tuning

Node's `perf_hooks` delivers GC entries to the observer asynchronously. After the hot loop the harness waits before reading the entry count so the observer has time to flush. Default wait is **100ms**, which is safe on a dev machine but can be marginal on saturated CI runners.

If you see intermittent zero-scavenge reports on scenarios that clearly allocate:

- Bump globally via env var: `PERF_GATE_FLUSH_MS=300 node --test ...`
- Per-suite: `zgcSuite({ scenarios, flushMs: 300 })`
- Per-call: `measure(scenario, { flushMs: 500 })`

`gc2()` (the harness's forced-collection helper) does one `gc()`, yields a `setImmediate` tick to let `FinalizationRegistry` cleanups run, then does a second `gc()`. Without the yield, WeakRef/finalizer-driven teardown (used across the ecosystem in `lite-cleanup`, `lite-observe`, `lite-floating`) can leave the heap in an intermediate state between the two collections and inflate the retained-heap delta.

## License

MIT (c) Zahary Shinikchiev
