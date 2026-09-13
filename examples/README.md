# Framework integration examples

Runnable, zero-dependency examples of gating a hot path in each of the big
frameworks, plus the full trio. Each prints its verdict and exits 0 on success:

```bash
node --expose-gc examples/express.mjs
node --expose-gc examples/react.mjs
node --expose-gc examples/vue.mjs
node --expose-gc examples/angular.mjs
node --expose-gc examples/trio.mjs
```

| File | Gates | Cookbook recipe |
| --- | --- | --- |
| [`express.mjs`](express.mjs) | a server **route handler** per request | Recipe 11 |
| [`react.mjs`](react.mjs) | a component **render** per pass | Recipe 12 |
| [`vue.mjs`](vue.mjs) | a reactivity **effect** re-run per tick | Recipe 13 |
| [`angular.mjs`](angular.mjs) | a **change-detection** cycle per tick | Recipe 14 |
| [`trio.mjs`](trio.mjs) | gate + diagnose + attribute one leak | Recipe 15 |

## Why hand-rolled stand-ins

`@zakkster/lite-perf-gate` ships **zero runtime dependencies** by law, so the
framework examples cannot `import` Express, React, Vue, or Angular. Each file
instead contains a ~12-line hand-rolled stand-in for that framework's tick
(a `req`/`res` pair, a render + `useState`, a `ref`/`effect`, a `detectChanges`
cycle), clearly marked, with the one-line swap to the real import shown in a
comment at the top.

The stand-in is not a toy: it isolates **your** code -- the handler body, the
render body, the effect body, the template update block -- which is the part you
control and the part worth gating. Swapping in the real framework changes what
*drives* the tick, not what `measure` measures. See the COOKBOOK (Recipes 11-15)
for the real-framework + `node:test` wiring.

`trio.mjs` is the exception: it uses the **real** sibling packages
(`@zakkster/lite-gc-profiler` and `@zakkster/lite-leak`, both devDependencies),
because the whole point of that recipe is the three tools composing.

## The pattern, in one line

The framework examples are all the same shape:

```js
const scenario = { name, setup: () => ({ ... }), hot: (s, n) => { /* one tick, n times */ } };
const r = await measure(scenario, { N, k: 4 });
const v = verdict(r, { maxScavenges: 2 });   // pass = the tick retains nothing
```

`measure` requires `--expose-gc` (it forces collections to bracket the retained
delta). Your test runner already passes it: `node --expose-gc --test ...`.

## Not published; pinned by the rot-guard

These files are examples only -- they are not in the package `files[]` and do not
ship in the tarball. Unlike a static snippet, they are executed by the cookbook
rot-guard (`test/cookbook.test.mjs`), so if the gate surface changes under them,
CI goes red instead of the examples quietly rotting.
