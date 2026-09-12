# Changelog

## [1.2.2] - 2026-09-13

- **Version truth**: `VERSION` reads `1.2.2` and agrees with
  `package.json` and this file. The published 1.2.1 tarball shipped
  `VERSION = '1.2.0'`; see the 1.2.1 entry below.
- **`prepublishOnly: npm test`** -- the publish path now runs the suite.
  The guard test caught the 1.2.1 slip locally; nothing forced it to run
  before `npm publish`. That gap, not the string, was the defect.
- **Self-test**: the VERSION test no longer pins a literal; it asserts
  only `VERSION === package.json.version`. The literal forced a test edit
  every release, which is the friction that got skipped.
- Housekeeping: `var -> let/const` in `PerfGate.js`, trailing newline at
  EOF restored, demo `<title>` version.
- No API change and no behavior change to any exported function.

## [1.2.1] - 2026-07-08

Retroactive entry, written 2026-09-13: 1.2.1 was published with no
changelog entry.

- Housekeeping only: `var -> let/const` cleanup in `PerfGate.js` and the
  `package.json` bump. Verified by unpacking the published tarball: no
  API change and no behavior change relative to 1.2.0.
- **Known defect, fixed in 1.2.2**: the tarball shipped
  `export const VERSION = '1.2.0';` and a CHANGELOG ending at 1.2.0. The
  self-test that asserts VERSION against the manifest would have caught
  it; there was no `prepublishOnly` to make it run.

## [1.2.0] - 2026-07-07

- **`toNDJSON(x, meta?)`** -- NDJSON verdict output for CI artifacts.
  Accepts a `suiteGate()` result, a `measure()` result, or an array of
  either; emits `budget` lines before their `suite-gate` summary line and
  `measure` lines, with optional per-run `meta` fields merged into every
  line. Otherwise the API is frozen, per the suite roadmap.

## [1.1.0] - 2026-07-07

> Never published standalone. The registry has 1.0.0, 1.0.1, 1.2.0,
> 1.2.1 -- no 1.1.0. The features below first reached the registry
> inside 1.2.0.

- **`suiteGate(config)`** -- SPP stream-fed budgets. Consumes a Float64Array
  slab or any forEach record source (a lite-scope memory sink qualifies),
  reduces per-budget metrics (count/sum/max/mean/last over slot t/a/b,
  matched by packed header, stream+op, or op-only), and delegates every
  threshold comparison to `verdict()` -- one comparison authority,
  per-budget structured results. No package import: lite-perf-gate speaks
  the Scope Probe Protocol (SPP v1), it does not depend on lite-scope.
  suiteGate never touches process exit codes; runner semantics (0/1/3 in
  the VersionMatrix scripts, 0/1/2 in `runGate`) stay in the runner layer.
  CONT continuation records are never budget targets in v1.1.
- **Version discipline fix**: `VERSION` now reads `1.2.0` and the self-test
  asserts it against `package.json` (the published 1.0.1 tarball shipped
  `VERSION = '1.0.0'` because the old test pinned a literal instead of the
  manifest -- that class of slip is now structurally impossible).

## [1.0.0] - 2026-07-07

Initial release. Generalized from the `@zakkster/lite-signal` zero-GC gate
(`test/zgc/`) into a standalone, engine-agnostic library.

### Public API

- **`zgcSuite(config)`** -- register `node:test` cases for detector
  validation, scenario gating, and must-fail self-tests.
- **`measure(scenario, options?)`** -- raw measurement at N and k*N.
- **`verdict(result, thresholds?)`** -- evaluate against thresholds.
- **`runGate(config)`** -- standalone human-readable report.
- **`formatResult(result)`** -- one-line summary.
- **`controlPositive` / `controlNegative`** -- built-in detector controls.

### Methodology

Three signals: scavenge count (transient allocation), custom counters
(exact engine internals via `statsOf`), retained-heap delta (leaks).
Scaling verdict: measure at N and k*N. Detector self-validation: the gate
refuses to judge if the controls misbehave.

### CI tuning

- `flushMs` option (default 100ms; env var `PERF_GATE_FLUSH_MS`) controls
  how long the harness waits after the hot loop before reading the
  perf_hooks GC observer buffer. Bump to 250-500ms on noisy CI runners
  where event-loop stalls can drop GC entries.
- `gc2()` yields a `setImmediate` tick between its two `globalThis.gc()`
  passes so any `FinalizationRegistry` cleanups scheduled by the first
  pass run before the second. Prevents WeakRef/finalizer-driven teardown
  (used in `lite-cleanup`, `lite-observe`, `lite-floating`) from leaving
  the heap in an intermediate state and inflating retained deltas.

### Tests

12 self-tests covering controls, verdict logic, counter deltas, and
result shape.
