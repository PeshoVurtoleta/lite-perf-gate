# Cookbook

The README is a reference. It answers *what does this API do?*

This is the cookbook. It answers *how do I gate X?*

Every recipe here documents the FINAL, post-P4 surface: five signals
(scavenges, retained heap, old-gen activity, external/arrayBuffers, custom
counters), fail-closed doors, `minCount` presence assertions, the
`GateResult.code` contract, `allowNoGc` / `allowEmpty`, and the built-in
detector controls. A recipe that fails its own gate is the lesson in print --
so every runnable recipe below is executed by `test/cookbook.test.mjs`, and if
the surface moves under it, CI goes red instead of the book quietly rotting.

Recipes are graded in four tiers:

- **First verdict (0-3)** -- see a number, run your first gate, read a
  detector-validation failure, and choose thresholds you can defend.
- **Engine counters (4-6)** -- gate an object pool and a `lite-arena` ECS on
  their own internal counters, and prove the gate still catches a planted
  allocation.
- **Streams + CI (7-10)** -- reduce a `lite-scope` memory sink to per-budget
  verdicts, ship the result as a CI artifact, map exit codes in a bare script,
  and gate one stream against three budgets at once.
- **Framework integration (11-15)** -- gate a server route handler (this
  package's home turf), a React render, a Vue tick, Angular change detection,
  and the full trio where perf-gate gates, gc-profiler diagnoses, and lite-leak
  attributes the same failure.

Read them in order if you are new; jump around if you know what you want.

Each recipe has the same shape:

- **Goal** -- what you are trying to prove.
- **Primitive** -- which entry point.
- **Code** -- the smallest correct usage.
- **Reading the verdict** -- what each field means for your goal.
- **Gotchas** -- the traps that bite first.

Everything below assumes you have run `npm i -D @zakkster/lite-perf-gate` and
that your test process starts with `node --expose-gc --max-semi-space-size=4`.
`--expose-gc` is required: `measure()` throws without it (with the run command
in the message), unless you opt out with `allowNoGc: true`.
`--max-semi-space-size=4` sharpens scavenge sensitivity.

## Contents

**First verdict**

0. [Just show me a number](#recipe-0-just-show-me-a-number)
1. [My first gate](#recipe-1-my-first-gate)
2. [Reading a detector-validation failure](#recipe-2-reading-a-detector-validation-failure)
3. [Thresholds you can defend](#recipe-3-thresholds-you-can-defend)

**Engine counters**

4. [Gating an object pool on its own counters](#recipe-4-gating-an-object-pool-on-its-own-counters)
5. [Gating a lite-arena ECS: spawn/retire counters + a zero-alloc tick](#recipe-5-gating-a-lite-arena-ecs-spawnretire-counters--a-zero-alloc-tick)
6. [mustFail: proving the gate catches a planted allocation](#recipe-6-mustfail-proving-the-gate-catches-a-planted-allocation)

**Streams + CI**

7. [suiteGate over a lite-scope memory sink](#recipe-7-suitegate-over-a-lite-scope-memory-sink)
8. [toNDJSON as a GitHub Actions artifact](#recipe-8-tondjson-as-a-github-actions-artifact)
9. [runGate in a bare script: mapping result.code](#recipe-9-rungate-in-a-bare-script-mapping-resultcode)
10. [One stream, three budgets](#recipe-10-one-stream-three-budgets)

**Framework integration**

11. [Gating an Express / Fastify route handler](#recipe-11-gating-an-express--fastify-route-handler)
12. [Gating a React render loop](#recipe-12-gating-a-react-render-loop)
13. [Gating a Vue reactivity tick](#recipe-13-gating-a-vue-reactivity-tick)
14. [Gating Angular change detection](#recipe-14-gating-angular-change-detection)
15. [The trio: gate, diagnose, attribute](#recipe-15-the-trio-gate-diagnose-attribute)

---

## Tier 1 -- First verdict

## Recipe 0: Just show me a number

**Goal.** See what a hot path actually costs -- scavenges and retained heap --
before deciding anything gates. Gating is the second thing you do, not the
first.

**Primitive.** `measure` + `formatResult`. `measure` measures at N and k*N and
returns the raw `MeasureResult`; it never throws a budget error, because you
have not set a budget.

**Code.**

```js
import assert from 'node:assert/strict';
import { measure, formatResult } from '@zakkster/lite-perf-gate';

const scenario = {
    name: 'accumulate',
    setup: () => ({ acc: 0 }),
    hot: (s, n) => { let a = s.acc; for (let i = 0; i < n; i++) a += (i * 3) ^ i; s.acc = a; }
};

const r = await measure(scenario, { N: 50000, k: 4 });
console.log(formatResult(r));

assert.equal(typeof r.minorHi, 'number');
assert.equal(typeof r.retainedKB_hi, 'number');
assert.equal(typeof formatResult(r), 'string');
```

`formatResult` prints one line: scavenges at N and k*N, retained KB, and
(when non-zero) old-gen collections, external arrayBuffers, and counter deltas.

**Reading the verdict.** There is no verdict here -- that is the point. The two
numbers that matter first are `minorHi` (scavenges at k*N) and `retainedKB_hi`
(heap the workload kept alive, bracketed by two forced collections). A pure
arithmetic loop reads ~0 scavenges and a few KB retained; a loop that allocates
one object per iteration reads scavenges that *scale* with N. That scaling --
not the absolute number -- is what the gate turns into a pass or a fail.

**Gotchas.**

- Scavenge counts arrive asynchronously (`perf_hooks`). `measure` waits
  `flushMs` (default 100) after the hot loop before reading them; if a workload
  that should allocate reports zero, your wait is too short (Recipe 3).
- Retained heap is *retained*, not allocated. Transient garbage freed before
  the second collection is invisible here -- that is why the scavenge counter,
  not the heap delta, is the primary transient-allocation detector.

---

## Recipe 1: My first gate

**Goal.** Prove one hot path allocates nothing, as a build step that fails on a
regression.

**Primitive.** `zgcSuite` for `node:test`; `runGate` for a bare script. Both
share the same config shape and both validate the detector controls before
judging your scenario.

**Code (the runnable core, `runGate`).**

```js
import assert from 'node:assert/strict';
import { runGate } from '@zakkster/lite-perf-gate';

const scenario = {
    name: 'accumulate',
    setup: () => ({ acc: 0 }),
    hot: (s, n) => { let a = s.acc; for (let i = 0; i < n; i++) a += (i * 3) ^ i; s.acc = a; }
};

const report = await runGate({ scenarios: [scenario] });   // N=200000, k=8 defaults
assert.equal(report.passed, true);
assert.equal(report.code, 0);
```

**The idiomatic `node:test` form** registers the cases for you:

```js
// gate.test.mjs -- node --expose-gc --max-semi-space-size=4 --test gate.test.mjs
import { zgcSuite } from '@zakkster/lite-perf-gate';

zgcSuite({
    scenarios: [{
        name: 'accumulate',
        setup: () => ({ acc: 0 }),
        hot: (s, n) => { let a = s.acc; for (let i = 0; i < n; i++) a += (i * 3) ^ i; s.acc = a; }
    }]
});
```

`zgcSuite` registers one detector-validation test plus one test per scenario.
Run it with the flags above.

**Reading the verdict.** `runGate` returns `{ passed, code, results }`. `code`
is `0` on pass, `1` on a scenario or must-fail failure, `2` when the detector
controls could not validate the instrument. `passed === (code === 0)`. It never
touches `process.exitCode` -- you map `code` yourself (Recipe 9).

**Gotchas.**

- The `hot(state, n)` function is the ONLY code inside the measured window.
  Build the graph in `setup()`; anything you allocate in `hot` is what the gate
  sees.
- `zgcSuite` and `runGate` behave differently under a test runner. The detector
  self-validation is reliable in a bare process (a child, or `runGate` in a
  script); under `node --test` the runner's own allocations can land in the
  window. That is why this cookbook's own tests spawn the `runGate` recipes as
  bare child processes.

---

## Recipe 2: Reading a detector-validation failure

**Goal.** Understand `code: 2` -- the gate refusing to judge because its own
instrument failed a self-check -- and know which of the four clauses tripped.

**Primitive.** The built-in controls, validated on every `zgcSuite` /
`runGate` call. Here we sabotage the positive control on purpose to see the
refusal.

**Code.**

```js
import assert from 'node:assert/strict';
import { runGate } from '@zakkster/lite-perf-gate';

// A "stock" positive control: it grows a module-level array forever, so every
// object it allocates keeps surviving. This is the shape decisions/0001
// rejected -- we use it here on purpose to trip the detector.
const sink = [];
const stock = {
    name: 'stock+',
    setup: () => ({}),
    hot: (_s, n) => {
        for (let i = 0; i < n; i++) {
            sink.push({ x: i, y: i + 1, z: i + 2, w: i + 3 });
            if (sink.length > 3e6) sink.length = 0;
        }
    }
};

const report = await runGate({
    scenarios: [], allowEmpty: true, positiveControl: stock, N: 20000, k: 8
});
assert.equal(report.code, 2);        // detector validation failed
assert.equal(report.passed, false);
```

**The pretenuring story, in two sentences.** V8 tracks, per allocation *site*,
what fraction of the objects born there survive a scavenge; a site whose
objects keep surviving is marked *pretenured* and its future allocations go
straight to old space, which never fills the young generation and so never
triggers a scavenge (decisions/0001). The stock control above -- storing every
object into a forever-growing array -- is a 100% survival ratio, the strongest
possible pretenuring signal, so it teaches V8 to make the control invisible and
the gate correctly refuses to trust a blind instrument.

**Reading the verdict -- the five checks.** `validateDetector` runs three
controls and checks five things; any one failing yields `code: 2` with a named
reason:

1. **Positive floor.** The positive control must force at least **6** scavenges
   at k*N (`pos.minorHi >= 6`). Below that, the scavenge signal is too weak to
   trust -- exactly what the sabotaged control above produces.
2. **Positive scaling.** Scavenges must at least **double** from N to k*N
   (`pos.minorHi >= 2 * pos.minorLo`). A count that stays flat or drops as work
   grows is a pretenured site, not a working detector.
3. **Negative ceiling.** The negative control (pure arithmetic) must force at
   most **2** scavenges (`neg.minorHi <= 2`). A nonzero here means a noisy
   process or a prior measurement's residue, not a clean hot path. The ceiling
   tightens to your `maxScavenges` when that is stricter than 2.
4. **Negative old-gen.** The same negative control must force **no** old-gen
   collections (`neg.oldGenHi <= 0`); a nonzero reading means a noisy
   instrument, so the gate refuses to judge the old-gen lane on it.
5. **Large-control floor.** The external/arrayBuffers control must grow at
   least **277 KB** of backing-store memory at k*N (`large.arrayBuffersKB_hi >=
   277`). Below that, the external lane is blind -- it cannot prove it would
   catch a real backing-store leak (this control measures ~832 KB
   deterministically; 277 is a 3x margin under it, and 4x over the default
   64 KB gate).

**Gotchas.**

- `code: 2` is not a scenario failure. Your hot path was never judged -- the
  results array is empty. Fix the instrument (usually: run with `--expose-gc
  --max-semi-space-size=4` in a clean process), then re-run.
- A too-short window can trip the floor or scaling clause on a *healthy*
  control, because pretenuring wins faster in a short loop. If detector
  validation flakes, raise N before you suspect your code.

---

## Recipe 3: Thresholds you can defend

**Goal.** Set numbers you will not have to explain away next month.

**Primitive.** `verdict` -- the one comparison authority. Every lane fails
closed: a non-finite measured value reads `not a number (fail closed)` rather
than silently passing.

**Code.**

```js
import assert from 'node:assert/strict';
import { verdict } from '@zakkster/lite-perf-gate';

// A synthetic measurement that trips every gated lane at once.
const dirty = {
    name: 'dirty', N: 200000, k: 8,
    minorHi: 40,               // scavenges (transient allocation)
    retainedKB_hi: 512,        // retained heap growth
    oldGenHi: 3,               // old-gen collections (major + incremental)
    arrayBuffersKB_hi: 4096,   // external / backing-store memory
    counters_hi: { poolGrowths: 5 },
    retainedReliable: true
};

const v = verdict(dirty, {
    maxScavenges: 2,           // default 2
    maxRetainedKB: 64,         // default 64
    maxOldGen: 0,              // default 0 -- a GATE signal
    maxArrayBuffersKB: 64,     // default 64 -- a GATE signal
    counters: { poolGrowths: 0 }
});

assert.equal(v.pass, false);
assert.equal(v.reasons.length, 5);   // one reason per lane
```

**The five thresholds.**

- **`maxScavenges` (default 2).** The primary transient-allocation detector.
  Set it at your measured scavenge floor plus a small margin, not at a round
  number you like.
- **`maxRetainedKB` (default 64).** Retained heap growth between two forced
  collections -- the leak detector. Skipped under `allowNoGc` (an explicit
  value then throws).
- **`maxOldGen` (default 0).** Old-gen collections (major + incremental). A
  GATE signal: when it trips, the reason names it and points you at
  `@zakkster/lite-gc-profiler` for diagnosis. Gated even under `allowNoGc`,
  because it comes from the observer, not `memoryUsage`.
- **`maxArrayBuffersKB` (default 64).** External backing-store memory that
  `heapUsed` excludes. The other GATE signal; skipped under `allowNoGc`.
- **`counters` (opt-in).** Per-counter maximum deltas from your scenario's
  `statsOf` (Recipes 4-5). A typo'd key fails closed naming the real keys.

**N and k.** `N` (default 200000) is the low iteration count; `k` (default 8)
is the scale factor, so the high measurement runs at k*N. Zero-alloc means ~0
scavenges at *both* points; a leak scales with N. Raise N until a known-bad
build fails, then leave it -- a window that shrinks to pass is not a gate.

**flushMs on saturated CI.** `perf_hooks` delivers GC entries asynchronously,
so `measure` waits `flushMs` (default 100) after the hot loop before reading
them. On a saturated runner that wait can be too short and a genuinely allocating
scenario reports zero scavenges -- a false pass. Bump `flushMs` (option) or
`PERF_GATE_FLUSH_MS` to 250-500 on such hosts.

**The C1 documented hole, honestly.** There is one workload shape this gate
cannot see: large-object *string* churn. On current V8, gigabytes of
600 KB-plus string allocation are served without a scavenge, an old-gen
collection, or an incremental mark that the observer can count -- so a string
churn that never promotes reads clean on every lane, and no invented signal
would be honest (decisions/0003). If your hot path is string-heavy, gate its
*retained* growth and reach for `@zakkster/lite-gc-profiler`'s allocation-rate
lanes; this instrument's transient-allocation claim is about heap objects, not
LO strings.

**One documented residue.** In the `suiteGate` reducers, a `NaN` slot fails
closed only when the reducer propagates it (`sum`/`mean`, or `max`/`last` at the
extremum); under `count` or a `max`/`last` where finite records dominate, a
lone `NaN` is silently excluded and the budget can pass (decisions/0004) -- so
prefer `sum`/`mean` when a `NaN` in the stream must never pass.

**Gotchas.**

- Bad thresholds throw at config time (`maxScavenges: NaN`, `-1`, a `NaN`
  counter max). A measured value that is `NaN`/`Infinity` fails the verdict --
  the door is at both ends.
- `maxRetainedKB` and `maxArrayBuffersKB` with `allowNoGc: true` throw: the
  deltas they gate are bracketed by collections that no-op without
  `--expose-gc`, so the gate refuses to fabricate a reading.

---

## Tier 2 -- Engine counters

## Recipe 4: Gating an object pool on its own counters

**Goal.** Prove a pool reuses slots instead of allocating -- gate on the pool's
own `poolGrowths` counter, not just on scavenges.

**Primitive.** `measure` + `verdict` with a `counters` threshold, fed by the
scenario's `statsOf`.

**Code.**

```js
import assert from 'node:assert/strict';
import { measure, verdict } from '@zakkster/lite-perf-gate';

// A fixed-size object pool. acquire() reuses a free slot; release() returns it.
// poolGrowths counts every time the pool had to allocate a new slot -- the
// number a zero-GC pool must keep at 0 under steady load.
function makePool(size) {
    const free = [];
    let growths = 0;
    for (let i = 0; i < size; i++) free.push({ v: 0 });
    return {
        acquire() { if (free.length === 0) { growths++; free.push({ v: 0 }); } return free.pop(); },
        release(o) { o.v = 0; free.push(o); },
        stats() { return { poolGrowths: growths }; }
    };
}

const scenario = {
    name: 'pool acquire/release',
    setup: () => makePool(64),
    hot: (pool, n) => { for (let i = 0; i < n; i++) { const o = pool.acquire(); o.v = i; pool.release(o); } },
    statsOf: (pool) => pool.stats()
};

const r = await measure(scenario, { N: 100000, k: 4 });
const v = verdict(r, { maxScavenges: 2, counters: { poolGrowths: 0 } });
assert.equal(v.pass, true, v.reasons.join('; '));
```

**Reading the verdict.** `statsOf` runs at both N and k*N; `measure` computes
the *delta* automatically and exposes it as `counters_hi`. `{ poolGrowths: 0 }`
says the pool may not grow at all under load. This catches a class of bug the
scavenge lane cannot: a pool that grows once and then reuses forever allocates
almost nothing on the heap, but the growth is the design failure you want named.

**Gotchas.**

- A counter threshold with no `statsOf` fails closed: `counters: thresholds set
  (...) but the scenario measured no counters -- add statsOf`.
- Counters measure *deltas*, so a counter that only increments during `setup`
  (before the window) reads 0 -- which is correct: the window is `hot`, not
  `setup`.

---

## Recipe 5: Gating a lite-arena ECS: spawn/retire counters + a zero-alloc tick

**Goal.** Prove an ECS integration tick allocates nothing and never retires a
generational slot, gated on `@zakkster/lite-arena`'s own counters.

**Primitive.** `measure` + `verdict` over a scenario whose `hot` is the
canonical hoist-and-iterate ECS loop, and whose `statsOf` reads
`arena.retiredCount`.

**Code (real `@zakkster/lite-arena` as a devDependency).**

```js
import assert from 'node:assert/strict';
import { measure, verdict } from '@zakkster/lite-perf-gate';
import { Arena } from '@zakkster/lite-arena';

const arena = new Arena(10000);
const Pos = arena.registerComponent({ x: Float32Array, y: Float32Array });
const Vel = arena.registerComponent({ vx: Float32Array, vy: Float32Array });

const scenario = {
    name: 'ecs integrate',
    setup: () => {
        arena.clear();
        for (let i = 0; i < 2000; i++) {
            const e = arena.spawn();
            const p = Pos.add(e); Pos.data.x[p] = i; Pos.data.y[p] = -i;
            const v = Vel.add(e); Vel.data.vx[v] = 1; Vel.data.vy[v] = 2;
        }
        return {};
    },
    hot: (_s, n) => {
        // zero-alloc: hoist the typed-array refs, iterate the packed dense range
        const cnt = Pos.count;
        const x = Pos.data.x, y = Pos.data.y, vx = Vel.data.vx, vy = Vel.data.vy;
        for (let k = 0; k < n; k++) { const i = k % cnt; x[i] += vx[i]; y[i] += vy[i]; }
    },
    statsOf: () => ({ retired: arena.retiredCount })
};

const r = await measure(scenario, { N: 50000, k: 4 });
const v = verdict(r, { maxScavenges: 2, counters: { retired: 0 } });
assert.equal(v.pass, true, v.reasons.join('; '));
```

**Reading the verdict.** `retired: 0` proves no generational slot exhausted its
4095 live generations during the window -- lite-arena's conservation law holds
and no handle can alias as stale. The scavenge lane proves the tick itself
retains nothing: all state lives in pre-allocated `Float32Array`s, so the loop
allocates zero heap objects.

**Gotchas.**

- Hoist `Pos.data.x` etc. *inside* `hot`, but never across a `reserve()` -- a
  growth reallocates every backing array and staled refs read garbage. This
  arena never grows (`spawn()` at capacity throws), so the hoist is safe.
- `arena.clear()` in `setup` resets in place without reallocating, so the two
  measurement passes start identical -- essential for a stable delta.

---

## Recipe 6: mustFail: proving the gate catches a planted allocation

**Goal.** Prove the instrument still works -- that a *known* allocator trips the
gate. A gate that only ever passes is indistinguishable from a broken one.

**Primitive.** `mustFail` on `zgcSuite` / `runGate`. Each listed scenario MUST
trip the gate; if one passes clean, the run fails.

**Code.**

```js
import assert from 'node:assert/strict';
import { runGate, controlPositive } from '@zakkster/lite-perf-gate';

// controlPositive is a KNOWN allocator: one {x,y,z,w} per iteration into a
// 64-slot ring. Handing it to mustFail asserts the gate can still catch a
// planted allocation. "passed" here means "the planted alloc WAS caught".
const report = await runGate({ scenarios: [], allowEmpty: true, mustFail: [controlPositive] });
assert.equal(report.passed, true);
assert.equal(report.code, 0);
```

**Reading the verdict.** A must-fail scenario inverts the pass logic: the run is
green only when every must-fail entry trips the gate. If `controlPositive`
above ever read clean, `report.passed` would be `false` with `code: 1` -- a
loud signal that the scavenge detector has gone blind on this build.

**Gotchas.**

- A pure-arithmetic scenario can *never* be a valid must-fail -- it allocates
  nothing, so it is always MISSED and the run always fails. Plant a real
  allocation.
- `allowEmpty: true` lets you run a controls-and-must-fail-only gate with no
  real scenarios -- exactly the "is the instrument alive?" smoke test.

---

## Tier 3 -- Streams + CI

## Recipe 7: suiteGate over a lite-scope memory sink

**Goal.** Reduce a stream of `@zakkster/lite-scope` records to per-budget
verdicts, without importing lite-scope into your gate.

**Primitive.** `suiteGate`. lite-perf-gate does not import lite-scope; they are
coupled only by the SPP v1 protocol (a record is four numbers
`[packed, t, a, b]`). Any `forEach`-style source works -- a memory sink, or its
`toSlab()` Float64Array.

**Code (real `@zakkster/lite-scope` as a devDependency).**

```js
import assert from 'node:assert/strict';
import { suiteGate } from '@zakkster/lite-perf-gate';
import { createScope, createMemorySink } from '@zakkster/lite-scope';

const sink = createMemorySink(256);
const scope = createScope({ sink });
const gc = scope.register({ name: 'gc', ops: [{ code: 0x0200, name: 'pause', kind: 1 }] });

// A probe writes pause samples in ms into slot a.
for (let i = 0; i < 10; i++) gc.write(0x0200, scope.now(), i % 5, 0);

const result = suiteGate({
    name: 'gc-gate',
    source: sink.toSlab(),          // a forEach source (the live sink) also works
    budgets: [
        { name: 'gc-pause', op: 0x0200, slot: 'a', reduce: 'max', max: 8, minCount: 1 }
    ]
});

assert.equal(result.pass, true);
assert.equal(result.budgets[0].count, 10);
```

**Reading the verdict.** Each budget reduces the matching records' chosen slot
(`t`/`a`/`b`, default `a`) with a reducer (`count`/`sum`/`max`/`mean`/`last`,
default `max`) and compares against `max` -- delegating the comparison to
`verdict`, so there is one authority for the pass/fail string. `count` reports
how many records matched, so you can tell silence from luck. `minCount: 1`
turns silence into a failure (Recipe 10).

**Gotchas.**

- Pass a same-realm `Float64Array` slab or a real `forEach` sink. A native
  `Array.forEach` binds `(value, index, array)` onto `(packed, t, a, b)`, which
  `suiteGate` detects and rejects rather than silently mis-reading.
- `suiteGate` never touches exit codes. Bridge its verdict to your runner
  (Recipe 9) or serialise it (Recipe 8).

---

## Recipe 8: toNDJSON as a GitHub Actions artifact

**Goal.** Turn a gate result into a CI artifact a machine can diff and a human
can read in a job summary.

**Primitive.** `toNDJSON` -- one JSON object per line, budget lines before the
suite-gate summary line, trailing newline.

**Code.**

```js
import assert from 'node:assert/strict';
import { suiteGate, toNDJSON } from '@zakkster/lite-perf-gate';

const slab = Float64Array.from([
    // packed = (stream 1 << 16 | op 0x0200), t, a = pause ms, b
    ((1 << 16) | 0x0200) >>> 0, 1, 3, 0,
    ((1 << 16) | 0x0200) >>> 0, 2, 7, 0
]);
const result = suiteGate({
    name: 'gc-gate',
    source: slab,
    budgets: [{ name: 'gc-pause', stream: 1, op: 0x0200, slot: 'a', reduce: 'max', max: 8, minCount: 1 }]
});

const ndjson = toNDJSON(result, { run: process.env.GITHUB_RUN_ID || 'local', pkg: 'my-app' });
process.stdout.write(ndjson);

const lines = ndjson.trim().split('\n').map((l) => JSON.parse(l));
assert.equal(lines[0].type, 'budget');
assert.equal(lines[lines.length - 1].type, 'suite-gate');
assert.equal(lines[lines.length - 1].pass, true);
```

**The workflow (illustrative).** Emit the NDJSON, upload it as an artifact, and
fold a line into the job summary:

```yaml
name: perf-gate
on: [push, pull_request]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: node --expose-gc --max-semi-space-size=4 test/gate.mjs > perf-gate.ndjson
      - uses: actions/upload-artifact@v4
        with: { name: perf-gate, path: perf-gate.ndjson }
      - run: |
          tail -n 1 perf-gate.ndjson | node -e \
            'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(`perf-gate: ${r.pass?"pass":"FAIL"}`)})' \
            >> "$GITHUB_STEP_SUMMARY"
```

**Reading the verdict.** `meta` fields (run id, package) merge into every line;
core fields win on collision. The frozen budget-line shape carries `value`,
`count`, `max`, and `pass` -- but not `minCount` (that stays on the in-process
result object). Archive the JSON; the narrated forms are for reading.

**Gotchas.**

- `toNDJSON` accepts a `suiteGate` result, a `measure` result, or an array
  mixing both. A row that is neither throws naming its index.
- The trailing newline is intentional -- append multiple gates to one file and
  each line stays valid NDJSON.

---

## Recipe 9: runGate in a bare script: mapping result.code

**Goal.** Gate from a plain `node` script (no test runner) and map the verdict
to an exit code CI can read.

**Primitive.** `runGate`. It returns `{ passed, code, results }` and never sets
`process.exitCode` -- the mapping is yours, on purpose.

**Code.**

```js
import assert from 'node:assert/strict';
import { runGate, controlNegative } from '@zakkster/lite-perf-gate';

// code 0 = pass, 1 = gate/must-fail failure, 2 = detector validation failed.
const pass = await runGate({ scenarios: [], allowEmpty: true });
assert.equal(pass.code, 0);

// A pure-arithmetic mustFail can never trip -> MISSED -> code 1.
const fail = await runGate({ scenarios: [], allowEmpty: true, mustFail: [controlNegative] });
assert.equal(fail.code, 1);

// In your CI entry point, the whole script is one line:
//   process.exit((await runGate(config)).code);
```

**Reading the verdict.** Keep the three codes distinct in your pipeline: `0`
ships, `1` is a real regression (read the printed reasons), `2` means the
instrument could not validate -- investigate the runtime (usually a missing
`--expose-gc`), do not paper over it. `passed` is the boolean convenience for
`code === 0`.

**Gotchas.**

- `runGate` prints a human report to stdout as a side effect; capture it for
  your logs. The machine-readable form is `toNDJSON(result)` (Recipe 8).
- An empty `scenarios` array throws unless you pass `allowEmpty: true` -- a
  gate with nothing to gate is a bug, not a pass.

---

## Recipe 10: One stream, three budgets

**Goal.** Gate one record stream against several independent budgets at once --
a gc-pause ceiling, a leak-orphan count, and an input-latency ceiling -- with
presence assertions so a silent probe fails instead of passing.

**Primitive.** `suiteGate` with multiple budgets and `minCount`.

**Code.**

```js
import assert from 'node:assert/strict';
import { suiteGate } from '@zakkster/lite-perf-gate';
import { createScope, createMemorySink } from '@zakkster/lite-scope';

const sink = createMemorySink(512);
const scope = createScope({ sink });
const gc = scope.register({ name: 'gc', ops: [{ code: 0x0200, name: 'pause', kind: 1 }] });
const leak = scope.register({ name: 'leak', ops: [{ code: 0x0800, name: 'orphan', kind: 0 }] });
const inp = scope.register({ name: 'inp', ops: [{ code: 0x0600, name: 'latency', kind: 1 }] });

for (let i = 0; i < 6; i++) gc.write(0x0200, scope.now(), i, 0);        // pause ms in slot a
for (let i = 0; i < 3; i++) inp.write(0x0600, scope.now(), 40 + i, 0);  // latency ms in slot a
// deliberately: NO leak-orphan records this frame.

const result = suiteGate({
    name: 'frame budgets',
    source: sink,
    budgets: [
        { name: 'gc-pause',      stream: gc.id,   op: 0x0200, slot: 'a', reduce: 'max',   max: 8,   minCount: 1 },
        { name: 'leak-orphan',   stream: leak.id, op: 0x0800, slot: 'a', reduce: 'count', max: 0,   minCount: 0 },
        { name: 'input-latency', stream: inp.id,  op: 0x0600, slot: 'a', reduce: 'max',   max: 100, minCount: 1 }
    ]
});

assert.equal(result.pass, true);
assert.equal(result.budgets.find((b) => b.name === 'gc-pause').count, 6);
assert.equal(result.budgets.find((b) => b.name === 'leak-orphan').value, 0);
```

**Reading the verdict.** Three budgets, three reducers, one pass:

- **gc-pause** (`max`, `minCount: 1`): the worst pause must be under 8 ms AND at
  least one sample must exist. A probe that stopped emitting fails on presence,
  not on a fake zero.
- **leak-orphan** (`count`, `max: 0`, `minCount: 0`): zero orphan records is a
  pass, and *silence is legitimately a pass here* -- so `minCount: 0` (the
  default) is correct; you are asserting "no orphans", not "orphans were
  measured".
- **input-latency** (`max`, `minCount: 1`): the worst input latency under 100 ms,
  with presence required.

`minCount` is the one surface addition that distinguishes "the budget was under
its ceiling" from "the budget matched nothing and reduced to zero by default".
Without it, a typo'd `op` matches zero records and passes forever.

**Gotchas.**

- Pick `minCount` per budget by intent: `1` when a missing sample is a bug (a
  probe died); `0` when absence is the pass (no orphans, no dropped frames).
- A `NaN` in the stream fails closed under `sum`/`mean` but can be silently
  excluded under `count`/`max`/`last` (decisions/0004). If a `NaN` must never
  pass a budget, reduce with `sum` or `mean`.

---

## Tier 4 -- Framework integration

These recipes show the **real framework** import, the way you would write it in
your own repo. Because this package ships zero runtime dependencies, the
frameworks are not installed here -- so each recipe has a **runnable,
zero-dependency twin** in [`examples/`](examples/), which hand-rolls a ~15-line
stand-in for the framework's tick and gates the part you actually control. The
stand-in isolates *your* handler / render / effect body; swapping in the real
framework changes what *drives* the tick, not what `measure` measures. The
cookbook rot-guard runs each twin, so these stay honest.

## Recipe 11: Gating an Express / Fastify route handler

**Goal.** Prove a route handler retains nothing per request. Server-side is this
package's home turf: a handler that allocates per request is straight GC
pressure under load.

**Primitive.** `measure` + `verdict`. The hot path is invoking the handler with
fresh input; you gate the handler body, not the framework's router.

**Code (real Express + node:test).**

```js
// Runnable, zero-dependency twin: examples/express.mjs
//   node --expose-gc examples/express.mjs
import test from 'node:test';
import express from 'express';
import { measure, verdict } from '@zakkster/lite-perf-gate';

test('the /price handler retains nothing per request', async () => {
    const app = express();
    // Your handler -- reuses res.locals, allocates no per-request object.
    const price = (req, res) => { res.locals.total = req.query.qty * 2; };
    app.get('/price', price);

    const scenario = {
        name: 'GET /price',
        setup: () => ({ req: { query: { qty: 0 } }, res: { locals: {} } }),
        hot: (s, n) => { for (let i = 0; i < n; i++) { s.req.query.qty = i; price(s.req, s.res); } }
    };
    const r = await measure(scenario, { N: 100000, k: 4 });
    const v = verdict(r, { maxScavenges: 2 });
    if (!v.pass) throw new Error(v.reasons.join('; '));
});
```

**Reading the verdict.** Gate the handler *function*, called with a reused
`req`/`res` shape, not the full HTTP stack -- the stand-in drives the same body
the router would. Fastify is identical: gate the `async (request, reply) => ...`
body. A handler that builds a fresh response object per call reads scavenges
that scale with N; one that writes into a reused buffer reads ~0.

**Gotchas.**

- Do not gate the router, the JSON serializer, or the socket -- those allocate
  per request by design and are not your code. Isolate the handler body, as the
  twin does.
- If the handler is genuinely async (awaits a DB call), the allocation you care
  about is usually synchronous graph-building before the await; measure that,
  and use `@zakkster/lite-gc-profiler`'s async lane for the awaited part.

---

## Recipe 12: Gating a React render loop

**Goal.** Prove a component re-render with new props retains nothing per render.

**Primitive.** `measure` + `verdict`. The hot path is one render pass.

**Code (real React + node:test).**

```js
// Runnable, zero-dependency twin: examples/react.mjs
//   node --expose-gc examples/react.mjs
import test from 'node:test';
import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { measure, verdict } from '@zakkster/lite-perf-gate';

test('a render retains nothing per pass', async () => {
    let root;
    TestRenderer.act(() => { root = TestRenderer.create(createElement(Row, { i: 0 })); });

    const scenario = {
        name: 'Row render',
        setup: () => ({}),
        hot: (_s, n) => { for (let i = 0; i < n; i++) TestRenderer.act(() => root.update(createElement(Row, { i }))); }
    };
    const r = await measure(scenario, { N: 2000, k: 4 });
    const v = verdict(r, { maxScavenges: 2 });
    if (!v.pass) throw new Error(v.reasons.join('; '));
});
```

**Reading the verdict.** React itself allocates an element per `createElement`,
so a strict scavenge gate on the *full* render path measures React's floor, not
yours. Gate your render body in isolation (as the twin does) or set a defensible
threshold above the framework floor. `act()` must wrap every update or React
batches unpredictably and smears allocation across the window.

**Gotchas.**

- Feed genuinely changing props (`i` above) or React bails out of the render
  and you measure a skipped pass that allocates nothing and proves nothing.
- Lower N for framework recipes -- a render pass is far heavier than an
  arithmetic op, so `N: 2000` keeps the measurement quick and honest.

---

## Recipe 13: Gating a Vue reactivity tick

**Goal.** Prove a reactive effect re-run retains nothing per tick.

**Primitive.** `measure` + `verdict`. The hot path is mutating the reactive
source, which re-runs the effect synchronously.

**Code (real Vue reactivity + node:test).**

```js
// Runnable, zero-dependency twin: examples/vue.mjs
//   node --expose-gc examples/vue.mjs
import test from 'node:test';
import { ref, effect } from '@vue/reactivity';   // or 'vue'
import { measure, verdict } from '@zakkster/lite-perf-gate';

test('a reactive tick retains nothing', async () => {
    const count = ref(0);
    const view = { total: 0 };                     // preallocated derived-state slot
    effect(() => { view.total = count.value * 2; });

    const scenario = {
        name: 'reactive tick',
        setup: () => ({}),
        hot: (_s, n) => { for (let i = 0; i < n; i++) { count.value = i; } }   // re-runs the effect
    };
    const r = await measure(scenario, { N: 20000, k: 4 });
    const v = verdict(r, { maxScavenges: 2 });
    if (!v.pass) throw new Error(v.reasons.join('; '));
});
```

**Reading the verdict.** `count.value = i` re-runs the effect synchronously
(`@vue/reactivity`); the effect writes into a preallocated `view` slot, so the
tick retains nothing. A computed that returns a fresh object each run will never
read zero -- that is the finding, not a false positive: reuse the slot.

**Gotchas.**

- Gate the *sync* `effect`, not a `watchEffect` under the full runtime -- the
  latter flushes on a microtask, pushing allocation outside the measured
  window.
- Mutating the ref is the tick; building the reactive graph belongs in `setup`,
  outside the window.

---

## Recipe 14: Gating Angular change detection

**Goal.** Prove one change-detection cycle retains nothing per tick.

**Primitive.** `measure` + `verdict`. The hot path is one `detectChanges()` (or
one signal `effect` flush).

**Code (real Angular + node:test).**

```js
// Runnable, zero-dependency twin: examples/angular.mjs
//   node --expose-gc examples/angular.mjs
import test from 'node:test';
import { TestBed } from '@angular/core/testing';
import { measure, verdict } from '@zakkster/lite-perf-gate';

test('a change-detection cycle retains nothing', async () => {
    const fixture = TestBed.createComponent(RowComponent);

    const scenario = {
        name: 'detectChanges',
        setup: () => ({}),
        hot: (_s, n) => { for (let i = 0; i < n; i++) { fixture.componentInstance.i = i; fixture.detectChanges(); } }
    };
    const r = await measure(scenario, { N: 2000, k: 4 });
    const v = verdict(r, { maxScavenges: 2 });
    if (!v.pass) throw new Error(v.reasons.join('; '));
});
```

**Reading the verdict.** Zone.js and the full TestBed allocate per cycle around
your component, so a strict zero gates the framework, not your template --
isolate the binding update (as the twin does) or gate above the framework floor.
`OnPush` skips cycles when inputs are referentially equal, so feed a genuinely
changing input.

**Gotchas.**

- For a signals component, gate the `effect` flush instead -- set the signal and
  let the graph recompute, the same shape as the Vue recipe.
- Keep N small; a CD cycle is expensive.

---

## Recipe 15: The trio: gate, diagnose, attribute

**Goal.** One workflow, three roles: `lite-perf-gate` gates the hot path and
fails, `@zakkster/lite-gc-profiler` diagnoses *how much* leaked, and
`@zakkster/lite-leak` attributes *what* outlived its owner.

**Primitive.** `verdict` (the gate), `measureAllocs` (the diagnosis),
`createLeakTracker` (the attribution).

**Code (all three packages; runnable twin: [`examples/trio.mjs`](examples/trio.mjs)).**

```js
// node --expose-gc examples/trio.mjs
import { measure, verdict } from '@zakkster/lite-perf-gate';
import { measureAllocs } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';

// A leaky handler: it pushes one record per call into a cache that is never
// bounded -- the classic "gets slower the longer it runs" server leak.
const cache = [];
function handle(i) { const rec = { id: i, at: Date.now() }; cache.push(rec); return rec; }

// 1) GATE -- perf-gate sees the transient allocation and fails.
const scenario = {
    name: 'leaky handler',
    setup: () => { cache.length = 0; return {}; },
    hot: (_s, n) => { for (let i = 0; i < n; i++) handle(i); }
};
const r = await measure(scenario, { N: 200000, k: 8 });
const v = verdict(r, { maxScavenges: 2 });
console.log('perf-gate:', v.pass ? 'PASS' : 'FAIL -- ' + v.reasons.join('; '));

// 2) DIAGNOSE -- gc-profiler quantifies retained bytes per call.
const allocs = measureAllocs((i) => handle(i), { iterations: 5000, batches: 8 });
console.log('gc-profiler: bytesPerCall floor =', allocs.bytesPerCall);

// 3) ATTRIBUTE -- lite-leak names what outlived its owner.
const tracker = createLeakTracker({ name: 'trio' });
const rec = handle(-1);
const id = rec.id;                                   // detached primitive, per the held-value contract
const h = tracker.track(rec, () => { void id; }, 'cache-record');
console.log('lite-leak: tracking', tracker.size(), 'live handle(s)');
tracker.untrack(h);
```

**Reading the verdict.** The three tools answer three different questions about
the same failure. perf-gate's `verdict` is the CI gate -- red or green. Once it
is red, gc-profiler's `bytesPerCall` tells you the size of the leak per call,
and lite-leak's tracker tells you which resource outlived its owner. This is the
D1 demo's script in prose: gate first, then diagnose, then attribute.

**Gotchas.**

- Keep exactly one measurement in flight. Never run `measureAllocs` (or any
  `measure*`) concurrently with a perf-gate window -- two measurements on the
  shared heap contaminate each other.
- lite-leak's held-value contract: neither the `cleanup` closure nor the `tag`
  may close over the tracked object, or the finalizer can never fire. Pass what
  you need by value (`id` above), never `rec`.

---

MIT (c) Zahary Shinikchiev &lt;shinikchiev@yahoo.com&gt;
