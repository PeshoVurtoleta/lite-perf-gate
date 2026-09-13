# Changelog

## [1.3.0] - 2026-09-13

### Changed

- **Positive control is a bounded 64-slot ring, not a grow-forever sink.**
  The stock control stored every `{x,y,z,w}` into a module-level array to
  defeat escape analysis -- but 100% survival trained V8's allocation-site
  pretenuring, so the site was promoted to old space and the scavenge signal
  died. At LIBRARY DEFAULTS in a fresh process the count went DOWN as the
  work went UP and `runGate` refused with DETECTOR VALIDATION FAILED (PG-01).
  The control now writes `__posRing[i & 63] = {x,y,z,w}`: the store still
  escapes, but every object is overwritten within 64 iterations, so the
  site's survival ratio stays ~0. Measured, fresh process, N=200000 k=8,
  `--expose-gc --max-semi-space-size=4`:

  | control                    | minorLo | minorHi | majorHi | retainedKB_hi |
  | -------------------------- | ------- | ------- | ------- | ------------- |
  | stock grow-forever sink    | 2       | 1       | 1       | ~100784       |
  | 64-slot ring (this release)| 2       | 21      | 0       | ~11           |

  See `decisions/0001-positive-control.md`.
- **Footprint is bounded by construction.** One `measure(controlPositive)`
  at defaults grew the post-gc heap ~113MB with the stock sink and poisoned
  every later measurement in the same process (a subsequent negative control
  then forced 6 scavenges against a ceiling of 2, PG-10). At most 64 objects
  (~3KB) are retained now; post-gc growth is sub-megabyte.
- **`_controlKeepAlive()` returns ring occupancy (0..64), not a push count.**
  Its purpose -- a read that touches every slot so V8 cannot sink the stores
  -- is unchanged; it no longer returns a monotonically growing number.
- **Detector-validation margin is decoupled from the consumer's budget.**
  The old predicate `pos.minorHi > maxScavenges + 3` coupled the evidence
  the instrument owes to the budget the user set for their own code
  (`maxScavenges: 40` silently demanded a 43-scavenge control). One shared
  predicate `validateDetector(pos, neg, maxScav)` now governs both zgcSuite
  and runGate, with its own constants: `CONTROL_FLOOR = 6` (positive control
  scavenges at k*N), `CONTROL_SCALE = 2` (minorHi >= 2*minorLo when
  minorLo > 0), `CONTROL_NEG_CEIL = 2` (negative ceiling, tightened by
  `min(maxScavenges, 2)`). Every clause is written `!(x >= limit)` so a NaN
  count fails closed. A consumer at the default `maxScavenges: 2` sees the
  identical effective floor.
- **One detector-validation test replaces two.** zgcSuite measures positive
  then negative in one test so the negative doubles as the in-suite
  poisoning regression.

### Added

- **Torture suite** (`npm run torture`, `test/torture.mjs` +
  `test/torture/`): T1 detector matrix (bare child processes at library
  defaults -- the PG-01 reproduction inverted, ring scaling at N in
  {50000, 200000}, and the PG-10 poisoning regression) and T5 footprint +
  4096-cycle soak (bounded control footprint, lite-leak registration count
  back to 0, flat heap band, `checkNoGc` pass over the profiler window).
  T2/T3/T4 register as named skipped tiers for P2/P3/P4. Two env-gated
  controls-for-the-controls prove the tiers can fail:
  `TORTURE_CONTROL=stock-control` fails T1, `TORTURE_CONTROL=leaky-soak`
  fails T5.
- **Two child-process self-tests** (PG-15): zgcSuite is green end-to-end at
  library defaults, and goes red (DETECTOR VALIDATION FAILED / need >=6)
  when the positive control is sabotaged with the stock grow-forever shape.
  26 -> 28 self-tests.
- **devDependencies** `@zakkster/lite-gc-profiler ^1.16.0` and
  `@zakkster/lite-leak ^1.10.0` -- dev-only, for the torture suite; the
  library still ships zero runtime dependencies and `files[]` is unchanged.
- **`.gitignore`** for `/node_modules/`, `/package-lock.json`, `.DS_Store`
  (the lockfile is not committed in this suite).

### Notes

- Every number above was measured on a single machine: darwin, Node
  v26.3.1, `--expose-gc --max-semi-space-size=4`, reproduced twice. There
  is no nvm here; the multi-Node matrix is a CI intent, not a claim this
  release verifies. `CONTROL_FLOOR = 6` absorbs the large-semi-space
  direction (a default 16MB young generation buys ~5-6 scavenges instead of
  21); scavenge count is a function of bytes allocated per semi-space byte,
  not of CPU speed.
- No verdict changes (P2), no new signals such as maxMajors or external
  deltas (P3), no suiteGate work (P4), no README rewrite (P5). The
  measurement window in `meterOnce` and suiteGate's visit are byte-identical
  to 1.2.2.
- The demo `<title>` no longer embeds a version; it went stale every release.

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
