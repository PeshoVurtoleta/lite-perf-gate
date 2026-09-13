# @zakkster/lite-perf-gate

> Prove your hot path allocates nothing -- or name what did.

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-perf-gate.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-perf-gate)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Hot%20path-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-perf-gate?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-perf-gate)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-perf-gate?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-perf-gate)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-perf-gate?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-perf-gate)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

## The CI gate the ecosystem was missing

`lite-perf-gate` is the pass/fail end of the `@zakkster` zero-GC toolkit. `benchmark.js` is dead. `tinybench` and `mitata` measure throughput but cannot **fail a build** when a hot path starts allocating. The V8 sampling heap profiler reports live-at-stop bytes and silently misses transient garbage -- the exact GC pressure a zero-alloc claim is about. Retained-heap delta (`heapUsed` before/after + `gc()`) misses it too: freed before the snapshot. Nothing turned "this hot path allocates nothing" into a `node:test` case that goes red on regression. Perf-gate is that piece: scavenge-counting with a scaling verdict, five signals, and a detector that self-validates on every run so the gate cannot silently lie.

```bash
npm install --save-dev @zakkster/lite-perf-gate
```

```js
// test/zero-gc.test.mjs
import { zgcSuite } from '@zakkster/lite-perf-gate';

zgcSuite({
    scenarios: [
        {
            name: 'steady-state propagation',
            setup() { return buildYourGraph(); },
            hot(engine, n) { for (let i = 0; i < n; i++) engine.update(i); },
            statsOf(engine) { return engine.stats(); }   // { poolGrowths, ... }
        }
    ],
    counters: { poolGrowths: 0, totalAllocations: 0 }
});
```

```bash
node --expose-gc --max-semi-space-size=4 --test test/zero-gc.test.mjs
```

The gate measures the scenario at N and k*N iterations, validates its positive / negative / external controls first, and fails the `node:test` case -- naming the signal that tripped -- the moment the hot path allocates. Depth (16 recipes across four tiers, framework integration, the trio pipeline) lives in [`COOKBOOK.md`](./COOKBOOK.md).

---

## Table of contents

- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [How the gate measures](#how-the-gate-measures)
- [API reference](#api-reference)
  - [The primary API](#the-primary-api)
  - [Verdict and format](#verdict-and-format)
  - [Streams: suiteGate + toNDJSON](#streams-suitegate--tondjson)
  - [Built-in controls and internals](#built-in-controls-and-internals)
  - [Constants](#constants)
- [Composability with the ecosystem](#composability-with-the-ecosystem)
- [Zero-GC design notes](#zero-gc-design-notes)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [Testing](#testing)
- [What this is not](#what-this-is-not)
- [Ecosystem](#ecosystem)

---

## Why this exists

A zero-allocation claim on a hot path is only true if something keeps it true across every commit. Two common ways of "proving" it produce **false passes**:

1. **Retained-heap delta alone.** A hot path that allocates and frees every iteration shows ~0 delta -- yet that transient churn is exactly the GC pressure the claim is about. Retention is not allocation.

2. **The V8 sampling heap profiler.** `HeapProfiler.startSampling` reports live-at-stop sampled bytes, so it likewise misses garbage that was born and collected inside the window.

Scavenge-counting is the only reliable detector of transient young-generation allocation in V8: a zero-alloc path forces ~0 scavenges at both N and k*N, an allocating path forces scavenges that scale with total bytes. This library packages that methodology into a `node:test`-native harness that validates its own detector every run -- if the positive control does not scavenge, or the negative control does, the gate refuses to judge rather than issue a green it cannot stand behind.

Existing options: throughput benchmarkers (measure speed, cannot gate allocation), the sampling profiler (misses transients), or a hand-rolled `heapUsed` diff (misses transients, and drifts). Perf-gate is the API for this specific job.

---

## What you get

- **`zgcSuite(config)`** -- the primary API. Registers `node:test` cases for detector validation, per-scenario gating, and must-fail self-tests. Drop it in a test file, run under `--expose-gc`, done.
- **`measure(scenario, options?)`** -- raw two-scale measurement (N and k*N). Returns a `MeasureResult` with scavenge counts, retained heap, old-gen activity, external/arrayBuffers growth, and custom counter deltas.
- **`verdict(result, thresholds?)`** -- evaluate a `MeasureResult` against thresholds; returns `{ pass, reasons }`. The one comparison authority; every gate delegates to it.
- **`runGate(config)`** -- a standalone, human-readable report. Returns `{ passed, code, results }` and never touches `process.exitCode`.
- **`formatResult(result)`** -- a one-line summary of a measurement.
- **`suiteGate(config)`** -- gate live probe streams, not just measured scenarios: reduce Scope Probe Protocol (SPP) records against per-budget maxima, with fail-closed record doors and `minCount` presence assertions.
- **`toNDJSON(x, meta?)`** -- serialize gate output as NDJSON for CI artifacts, one object per line.
- **Built-in detector controls** -- `controlPositive`, `controlNegative`, `controlLarge` (each overridable), plus the `_controlKeepAlive` internal that keeps the positive-control ring measurable.
- **Five gate signals**, each for what it can actually see (see below), and a **scaling verdict** so no judgment is hostage to one absolute threshold.

Full types ship in [`PerfGate.d.ts`](./PerfGate.d.ts). Every export is documented.

---

## How the gate measures

<details>
<summary>The five signals, the two scales, and the controls that keep the detector honest.</summary>

### Five signals, each for what it can see

| Signal | Detects | Misses |
| --- | --- | --- |
| Scavenge count (`perf_hooks` GC minor) | Transient young-gen allocation -- the GC pressure a zero-alloc claim is about | Nothing in the young-gen domain |
| Custom counters (`statsOf` deltas) | Exact engine internals (pool growth, node allocation) | Anything outside the engine's own bookkeeping |
| Retained-heap delta (`memoryUsage` + `gc()`) | Leaks (memory that survives GC) | Transient garbage (freed before the snapshot) |
| Old-gen activity (`perf_hooks` GC major + incremental) | Churn that promotes or marks old space, which scavenges alone cannot see | (a GATE signal, not a profiler -- diagnose the cause with lite-gc-profiler) |
| External / arrayBuffers delta (`memoryUsage().arrayBuffers` + `gc()`) | Backing-store memory that `heapUsed` excludes | (a GATE signal, not a profiler -- diagnose with lite-gc-profiler) |

Signals 4 and 5 are GATE signals: when either trips, the reason string names it and points at `@zakkster/lite-gc-profiler` for diagnosis. They were chosen from a GC-kind census, not a guess (decisions/0003), and their defaults (`maxOldGen: 0`, `maxArrayBuffersKB: 64`) were measured to cause zero spurious failures across 200 ambient reps -- but they CAN fail a previously-green suite exactly when a hot path fires an old-gen collection or grows external memory.

### The two scales

Each scenario runs at N and k*N iterations. A zero-alloc path shows ~0 scavenges at both; an allocating path shows scavenges scaling with bytes. The scaling comparison (`minorHi >= 2 * minorLo`) is what catches a regression that a single absolute threshold would miss -- and what caught the pretenuring inversion (PG-01) where a broken control's count went DOWN as work went up.

### The controls that self-validate the detector

Before it judges any scenario, the gate proves the instrument works:

- **`controlPositive`** MUST scavenge. It stores one `{x,y,z,w}` per iteration into a bounded 64-slot ring, so the object both escapes (defeating escape analysis / scalar replacement) and dies young (defeating allocation-site pretenuring). A grow-forever sink would train V8 to pretenure the site and the scavenge signal would die -- the exact PG-01 failure decisions/0001 fixes.
- **`controlNegative`** MUST NOT scavenge (pure arithmetic), and must fire zero old-gen collections -- a nonzero count there means a noisy instrument, not a clean hot path.
- **`controlLarge`** validates the external lane: a bounded, mask-gated retained pool of 64KB ArrayBuffers reads ~832KB at the pinned k*N (13x the default gate). Because a retained-external pass leaves a V8 scheduled-scavenge residue that poisons the next scavenge-gated measurement, `controlLarge` is measured LAST -- ordering, not draining, is the fix (decisions/0003).

If any control misbehaves, `runGate` returns `code: 2` (DETECTOR VALIDATION FAILED) and discards results; `zgcSuite` fails its detector test. The gate never issues a green it cannot defend.

</details>

---

## API reference

### The primary API

```ts
zgcSuite(config: GateConfig): void
```

Registers `node:test` cases: one detector-validation test (positive + negative + large controls), one `zero-GC: <name>` test per scenario, and one `MUST CATCH <name>` test per `mustFail` scenario. Run with `node --expose-gc --max-semi-space-size=4 --test your.test.mjs`.

```ts
measure(scenario: Scenario, options?: MeasureOptions): Promise<MeasureResult>
```

Raw measurement at N and k*N. Throws when `globalThis.gc` is not a function (the run command is in the message) unless `allowNoGc: true`. Bad options throw, naming the field and value.

`GateConfig` / `MeasureOptions` keys: `scenarios`, `N` (default 200000), `k` (default 8), `maxScavenges` (default 2), `maxRetainedKB` (default 64), `maxOldGen` (default 0), `maxArrayBuffersKB` (default 64), `counters`, `positiveControl`, `negativeControl`, `largeControl`, `mustFail`, `flushMs` (default 100, or the `PERF_GATE_FLUSH_MS` env var; 0 is legal and honored), `allowEmpty`, `allowNoGc`.

A `Scenario` is `{ name, setup(), hot(state, n), statsOf?(state), teardown?(state) }`. The `hot` function is the ONLY code inside the measurement window; `setup` and `teardown` run outside it.

### Verdict and format

```ts
verdict(r: MeasureResult, thresholds?: Thresholds): { pass: boolean, reasons: string[] }
```

The one comparison authority. Thresholds are validated at config time (bad values throw); measured signals fail closed with named reasons -- e.g. `'scavenges: not a number (fail closed)'`, `'oldgen: 3 > 0 (old-gen GC activity -- diagnose with @zakkster/lite-gc-profiler)'`, `'<key>: no such counter measured (statsOf keys: ...)'`.

```ts
runGate(config: GateConfig): Promise<{ passed: boolean, code: 0 | 1 | 2, results: MeasureResult[] }>
```

Standalone human-readable report. `code`: 0 pass, 1 a failing scenario or an uncaught `mustFail`, 2 detector validation failed; `passed === (code === 0)`. It never sets `process.exitCode` -- map `GateResult.code` yourself: `process.exit((await runGate(cfg)).code)`.

```ts
formatResult(r: MeasureResult): string
```

A one-line summary: scavenges at N and k*N, retained KB, and old-gen / arrayBuffers / counter deltas shown only when nonzero.

### Streams: suiteGate + toNDJSON

```ts
suiteGate(config: { source, budgets, name? }): SuiteGateResult
```

Reduce SPP records (a `Float64Array` slab, or any `forEach(cb(packed, t, a, b))` source -- a `@zakkster/lite-scope` memory sink qualifies) against per-budget maxima, delegating every comparison to `verdict()`. No package coupling: perf-gate speaks the Scope Probe Protocol (SPP v1) and never imports lite-scope. Record doors fail closed (decisions/0004): a non-u32 packed header, a non-`Float64Array` typed-array source, a `forEach` invocation that is not four numbers, an inherited-prototype `slot`/`reduce`, and a budget targeting CONT (0x0F01) all THROW naming the offender; a reduced value that is not finite, or `count < minCount`, FAIL the budget.

```ts
toNDJSON(x, meta?): string
```

One JSON object per line -- `budget` lines then the `suite-gate` summary; `measure()` results serialize as `measure` lines. Optional `meta` fields (package, run id, versions) merge into every line. Pipe to a file and attach it as a CI artifact.

### Built-in controls and internals

- **`controlPositive`** -- positive control (one `{x,y,z,w}` per iteration into a 64-slot ring). Overridable via `config.positiveControl`.
- **`controlNegative`** -- negative control (pure arithmetic, zero allocation). Overridable via `config.negativeControl`.
- **`controlLarge`** -- external/arrayBuffers control (bounded mask-gated 64KB-ArrayBuffer pool). Overridable via `config.largeControl`.
- **`_controlKeepAlive()`** -- `@internal`; reads every ring slot (returns occupancy 0..64) so V8 cannot sink the positive-control stores.

### Constants

Every value below is the source literal, enforced by the docs-drift guard (see [Testing](#testing)).

| Constant | Value | Meaning |
| --- | --- | --- |
| `VERSION` | `'1.4.2'` | Package version string (`=== package.json.version`). |
| `N` | `200000` | Default low iteration count. |
| `k` | `8` | Default scale factor; high pass is `k * N`. |
| `flushMs` | `100` | Wait (ms) after the hot loop before reading the GC observer buffer; env `PERF_GATE_FLUSH_MS`. |
| `maxScavenges` | `2` | Default max scavenges at k*N. |
| `maxRetainedKB` | `64` | Default max retained heap growth (KB). |
| `maxOldGen` | `0` | Default max old-gen activity (major + incremental) at k*N. |
| `maxArrayBuffersKB` | `64` | Default max external/arrayBuffers growth (KB) at k*N. |
| `CONTROL_FLOOR` | `6` | Positive-control scavenges required at k*N. |
| `CONTROL_SCALE` | `2` | Positive-control `minorHi` must be `>= 2 * minorLo`. |
| `CONTROL_NEG_CEIL` | `2` | Negative-control scavenge ceiling. |
| `CONTROL_LARGE_FLOOR` | `277` | `controlLarge` arrayBuffers KB required at k*N. |
| `CONTROL_RING_SIZE` | `64` | Positive-control ring slots. |

---

## Composability with the ecosystem

The whole path, engine to CI artifact, gate to diagnosis to attribution:

```js
import { zgcSuite, suiteGate, toNDJSON } from '@zakkster/lite-perf-gate';

// 1. Gate the engine's steady-state hot path in node:test (the primary use).
//    statsOf exposes the engine's own counters; the gate asserts scavenges ~ 0
//    AND poolGrowths === 0 in one verdict.
zgcSuite({
    scenarios: [{
        name: 'ecs tick',
        setup() { return buildWorld(); },
        hot(world, n) { for (let i = 0; i < n; i++) world.tick(i); },
        statsOf(world) { return world.stats(); }   // { poolGrowths, spawned, retired }
    }],
    counters: { poolGrowths: 0 }
});

// 2. Gate a live probe stream in CI: a lite-scope memory sink emits SPP records;
//    suiteGate reduces each budget's metric and delegates to verdict(). minCount
//    turns a typo'd op from a silent pass into a failure.
const gate = suiteGate({
    name: 'ci-gate',
    source: sink.toSlab(),          // Float64Array slab, or the sink itself
    budgets: [
        { name: 'gc.pause.max', stream: 2, op: 0x0201, slot: 'a', reduce: 'max',   max: 8 },
        { name: 'leak.orphans',            op: 0x0801,            reduce: 'count', max: 0, minCount: 1 },
        { name: 'inp.worst',               op: 0x0601, slot: 'a', reduce: 'max',   max: 200 }
    ]
});

// 3. Emit an NDJSON artifact; exit codes stay in YOUR runner.
process.stdout.write(toNDJSON(gate, { pkg: 'my-lib', run: process.env.CI_RUN }));
if (!gate.pass) process.exitCode = 1;
```

When a gate fails, the trio splits the follow-up cleanly: `@zakkster/lite-gc-profiler` diagnoses WHICH GC kind and how many bytes/op; `@zakkster/lite-leak` attributes WHICH resource outlived its owner. Perf-gate names the signal and points at both -- it does not reimplement either (see [What this is not](#what-this-is-not)). The full runnable trio is Recipe 15 in [`COOKBOOK.md`](./COOKBOOK.md).

---

## Zero-GC design notes

<details>
<summary>What the hot path allocates (nothing per record), and how the doors stay free.</summary>

The package has exactly one hot body of its own: `suiteGate`'s `visit()` over an SPP slab. Everything else -- `meterOnce`'s measurement window, `verdict`, the config doors -- is cold, or runs the CONSUMER's `scenario.hot` (whose allocation is the thing under test, outside this library's ledger).

| Operation | Steady-state allocations |
| --- | --- |
| `suiteGate` `visit()` per slab record | **0** |
| the D-A per-record u32 door | **0** (one `!==` compare; the cold thrower holds the index) |
| `meterOnce` measurement window (`makeGcCounter` -> `close`) | **0** in-window (the `memoryUsage()` captures are outside it) |
| positive-control ring | bounded 64 objects, each overwritten within 64 iterations |
| `suiteGate()` per CALL | cold: the config arrays + result (per call, never per record) |
| `verdict()` per call | cold: the `reasons` array only |

The record doors were held to a byte budget and measured (T4, decisions/0004): the D-A per-record u32 door costs **+0.2327 ns/record** (p50; min delta **+0.0661 ns/record**), landing far inside the v1.5.0 back-to-back noise band of **15.3637 / 15.5310 / 18.0343 ns/record** (min / p50 / max, a 2.6706 ns spread). Per-record retained bytes measured **0.00000** (noise to 0.00123), under the **0.01 B/record** gate -- estimated by difference `(bytesPerOp(1M) - bytesPerOp(1K)) / (1e6 - 1e3)`, because one `suiteGate()` call legitimately allocates its config arrays and asserting per-CALL zero would be theater. Numbers on darwin 25.6.0, Node v26.3.1, `--expose-gc --max-semi-space-size=4`.

The torture harness (`@zakkster/lite-leak` + `@zakkster/lite-gc-profiler`) commits these as gates: the 1M-record reduction at 0 B/record, the leak tracker returning to 0 across a 4096-cycle soak, and the two new gate signals catching their bypass fixtures -- with env-gated "controls for the controls" that MUST make each tier fail, so the gates are provably load-bearing.

</details>

---

## Design decisions worth knowing

Each `decisions/` record carries the measurements, the rejected shapes, and the finding IDs.

- **The positive control is a bounded ring, and its validation margin is its own** ([`./decisions/0001-positive-control.md`](./decisions/0001-positive-control.md), PG-01 / PG-10). A grow-forever sink trains V8's allocation-site pretenuring to 100% survival, promotes the site to old space, and the scavenge signal dies. The 64-slot ring escapes AND dies young. The detector floors (`CONTROL_FLOOR` 6, `CONTROL_SCALE` 2, `CONTROL_NEG_CEIL` 2) are decoupled from the consumer's `maxScavenges` so a raised budget cannot certify a broken instrument.
- **Fail closed on every unverified state** ([`./decisions/0002-fail-closed.md`](./decisions/0002-fail-closed.md), PG-04/05/08/09/11/14). Thresholds throw instead of passing everything; a NaN measurement fails instead of passing; a counter threshold that matches nothing fails; missing `--expose-gc` throws with the run command; empty scenario lists throw unless `allowEmpty`. `null` is never coerced to zero.
- **Old-gen and external signals, chosen from a GC-kind census** ([`./decisions/0003-bypass-signals.md`](./decisions/0003-bypass-signals.md), PG-02/03a/03b). Two new lanes close the allocation bypasses scavenge-counting cannot see. The census also produced a DOCUMENTED HOLE: on Node v26.3.1, C1's 600KB-string large-object churn fires no countable GC event any lane can gate -- it is recorded, not silently "fixed", and a torture fixture asserts its signature so a future Node that closes it flips the fixture.
- **suiteGate record doors and the one comparison authority** ([`./decisions/0004-record-doors.md`](./decisions/0004-record-doors.md), PG-06/12/13). The same over-budget record used to reach three different verdicts by container; now wrong-shaped sources throw, inherited keys are impossible at the data structure (null-proto tables), CONT targeting is a config error, and `minCount` delegates through a SECOND `verdict()` call so `verdict` stays max-only. A dated NaN-under-non-propagating-reducer residue is pinned by a canary test.

---

## Testing

**85 deterministic tests, all pass** (57 self-tests + 22 recipe-rot + 6 docs-drift), plus a torture gate that proves per-record zero-allocation, leak-freedom, and that each new signal catches its bypass.

```bash
npm test          # node:test: self-tests + COOKBOOK recipe-rot guard + docs-drift guard
npm run torture   # @zakkster/lite-leak + lite-gc-profiler: 0 B/record + gated signals; prints "ok"
```

The self-tests (`test/self.test.mjs`) cover the verdict logic and every fail-closed door, the measure option doors including a timing proof that `flushMs: 0` is honored, `runGate` codes 0/1/2 in bare children with `process.exitCode` asserted untouched, the five signals and their defaults, `suiteGate`'s record doors / inherited-key hardening / CONT rejection / `minCount`, `toNDJSON`'s frozen budget-line shape, and two bare-child detector self-tests (green at defaults, red when the positive control is sabotaged with the stock grow-forever shape). The recipe-rot guard (`test/cookbook.test.mjs`) extracts and runs each recipe's first code block from [`COOKBOOK.md`](./COOKBOOK.md), so commenting a recipe out turns CI red. The docs-drift guard (`test/docs.test.mjs`) loads the library with `import * as PG` and enforces, both directions, that every export is documented, every constants-table value equals its source literal, and every relative README link resolves. The torture harness (`test/torture.mjs`) commits the T4 reduction, the leak soak, and the bypass fixtures as gates; no gate output is a FAIL.

---

## What this is not

Perf-gate is a specialized, `node:test`-native **harness and gate** for proving zero-allocation on a concrete hot path, with a deliberate emphasis on catching TRANSIENT allocation via scavenge counting. It stays thin on purpose; the boundaries are sharp.

- **Not a profiler.** No retained-bytes-per-op reports, no major-GC kind breakdowns, no Chrome heuristics, no frame-lane measurement. When a gate signal trips, its reason names the signal and points at `@zakkster/lite-gc-profiler` -- reach for that when you need to know WHICH GC kind fired and how many bytes/op, in Node OR the browser.
- **Not a leak attributor.** No owner-tree tracking, no orphan-kernel classification. Reach for `@zakkster/lite-leak` when the question is "did this specific resource escape its owner and survive GC?".
- **Not a throughput benchmarker.** It gates allocation, not speed. Reach for `tinybench` / `mitata` for MP/s or ops/sec numbers.
- **Not a browser tool.** Node only: it needs `perf_hooks` GC entries and `--expose-gc`. Browser and frame-loop budgets belong to `lite-gc-profiler`.
- **Not an SPP producer.** `suiteGate` CONSUMES probe streams (a lite-scope sink, a slab) and never imports the producer; it speaks SPP v1 by protocol, not by package.
- **A documented hole, stated not hidden.** On Node v26.3.1, C1-style 600KB-string large-object churn (PG-02) fires no countable GC event any lane can gate, so it is NOT caught -- recorded in decisions/0003 and asserted by a torture fixture that will flip if a future Node closes it.

---

## Ecosystem

Part of the **@zakkster** zero-GC stack:

- [`lite-signal`](https://www.npmjs.com/package/@zakkster/lite-signal) -- zero-GC reactive graph for hot paths
- [`lite-gc-profiler`](https://www.npmjs.com/package/@zakkster/lite-gc-profiler) -- falsifiable GC + heap budgets, Node and browser (reach for it to DIAGNOSE a failed gate)
- [`lite-leak`](https://www.npmjs.com/package/@zakkster/lite-leak) -- owner-tree leak attribution and orphan kernels (reach for it to ATTRIBUTE a leak)
- [`lite-scope`](https://www.npmjs.com/package/@zakkster/lite-scope) -- SPP probe streams and memory sinks (a `suiteGate` source)
- [`lite-arena`](https://www.npmjs.com/package/@zakkster/lite-arena) -- pooled ECS storage with `statsOf` counters
- **`lite-perf-gate`** -- this package: the CI zero-alloc regression gate

---

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>. See [`./LICENSE`](./LICENSE).
