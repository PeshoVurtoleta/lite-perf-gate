# Changelog

## [1.4.0] - 2026-09-13

> One release, three roadmap sessions. The registry latest was 1.3.0;
> sessions P2, P3 and P4 were developed against interim targets 1.4.0,
> 1.5.0 and 1.6.0 -- none of which was ever published -- and ship
> together here as 1.4.0. Session records under decisions/ keep their
> original target numbers as history.

### suiteGate record doors, inherited-key hardening, CONT rejection, minCount (session P4)

#### Added

- **`minCount`, the presence assertion (the ONE surface addition).** An
  optional per-budget integer >= 0. Without it, a budget whose `op` is a
  typo matches zero records, reduces to 0, and passes forever -- the
  `count: 0` was reported and nothing ever looked at it. With
  `minCount: n`, a budget that matched fewer than `n` records FAILS with
  `'<name>: matched <count> < minCount <n>'`. It delegates through a
  SECOND `verdict()` call carrying the shortfall (`minCount - count`) as a
  maximum of 0 -- one comparison authority, and `verdict()` stays
  max-only and unaware a minimum exists (decisions/0004 D-G).
  `SuiteBudgetResult` gains `minCount` (0 when omitted); the NDJSON budget
  line is deliberately UNCHANGED (schema frozen).
- **Back-compat, stated and pinned:** WITHOUT `minCount`, a zero-match
  budget still reduces to 0, still reports `count: 0`, and still PASSES
  (v1.1 behavior). `minCount: 0` is provably inert (result deep-equal to
  omitting it). Presence assertions are opt-in because silence is
  legitimately a pass for budgets like 'no gc pause over 8ms'.
- **Torture T4 activates: the suiteGate reduction gate.** `measureOps`
  over `suiteGate` on a preallocated 1M-record slab with 8 budgets, gated
  on per-record retained bytes (the 1M-vs-1K `bytesPerOp` difference),
  `checkOps(maxBytesPerOp)`, `checkNoGc(maxMajor 0, maxArrayBuffersGrowth
  0)`, and an `nsPerRecord < 25` catastrophe ceiling. Runs BEFORE T5 so no
  `measureOps` is ever in flight inside T5's `GcProfiler` window. A
  `TORTURE_CONTROL=allocating-visit` lane (test-code only) drives a
  forEach shim that RETAINS one object per record and MUST fail T4.

#### Changed

- **PG-06: wrong-shaped record sources now THROW, naming the record
  index.** The same over-budget record used to reach three different
  verdicts by container: FAIL as a `Float64Array` slab (correct), PASS as
  a `Float32Array` (native `forEach` binds `(value, index, array)` ->
  reduced value `-Infinity`, count 1), PASS as an array of tuples
  (count 0). Now: a slab record whose packed header is not a u32 throws a
  `RangeError` naming the record index (D-A, in the slab driver loop);
  a non-`Float64Array` (or cross-realm) typed-array source throws at
  dispatch naming its constructor (D-C); a `forEach` source whose ANY
  invocation is not four numbers throws naming the invocation index and
  the failing slot (D-B, checked on every record -- a `null`/`'3'`/`true`
  slot at a later record would finitely coerce and pass a budget silently
  otherwise). A NaN slot is a number and passes D-B by design: it fails
  closed at D-D only when the reducer PROPAGATES it (`sum`/`mean`, or
  `max`/`last` at the extremum); under `max`/`last`/`count` a NaN
  coexisting with finite records is silently excluded and the budget can
  pass (count inflated, minCount satisfied), identically on both lanes --
  a documented residue (decisions/0004).
- **PG-06 / D-D: a reduced value that is not finite FAILS closed.**
  `verdict()`'s counter lane predicate widened by ONE line from
  `actual !== actual` to `!isFinite(actual)`, so `Infinity` and
  `-Infinity` now read `'<name>: not a number (fail closed)'`. This closes
  the `-Infinity` fail-open the P2 reviewer documented as
  unreachable-until-P4. Public side effect: a `statsOf` counter delta of
  `Infinity` now reads `'k: not a number (fail closed)'` instead of
  `'k: Infinity > 0'` -- still a failure, only the wording changed. The
  other four verdict lanes keep the NaN-only predicate (decisions/0004
  D-D scope note).
- **PG-12: inherited prototype keys no longer corrupt validation.**
  `SUITE_SLOTS` / `SUITE_REDUCES` are null-proto, so `slot: 'toString'`
  throws `slot must be` and `reduce: 'constructor'` throws `reduce must
  be`; the duplicate-name map (`seen`) and the per-budget `counters`/`ct`
  objects are null-proto, so a budget legitimately NAMED `toString`,
  `hasOwnProperty`, `__proto__`, or `constructor` is legal end to end,
  through `toNDJSON` too (verified by round-trip, incl. a name with a
  quote and a newline).
- **PG-13: a budget targeting CONT (0x0F01) now throws at config,** both
  the `{op: 0x0F01}` and the packed low-16-bits forms:
  `'CONT records are never budget targets (SPP v1)'`. `visit` skips CONT
  by protocol, so such a budget passed vacuously forever. The v1.1
  self-test that PINNED that vacuous pass is rewritten this release,
  deliberately; the CONT RECORD-in-slab protocol behavior is unchanged.
- **`visit`'s body is byte-identical to v1.5.0.** The D-A per-record door
  lives in the slab driver loop (`if (p !== p >>> 0) badRecord(r >> 2, p)`),
  which already holds the index; the `forEach` lane gets a separate
  `visitChecked` wrapper. `meterOnce`, `gc2`, `zgcSuite`, `runGate` are
  unchanged; `verdict()` changed exactly one line.
- **T4 cost (darwin 25.6.0, Node v26.3.1, `--expose-gc
  --max-semi-space-size=4`):** nsPerRecord p50 15.5310 (v1.5.0) ->
  15.7637 (v1.6.0), delta +0.2327 ns/record; min delta +0.0661. The
  v1.5.0 back-to-back noise band was 15.3637 / 15.5310 / 18.0343
  (min/p50/max), a 2.6706 ns spread -- the door's delta is far inside it,
  so D-A ships per record. Per-record retained bytes measured 0.00000
  (min, noise to 0.00123), well under the 0.01 gate (decisions/0004).

### Bypass signals -- oldGen + arrayBuffers lanes, census-driven (session P3)

#### Added

- **Two new gate signals, chosen from a GC-kind census, close the
  allocation bypasses (PG-02, PG-03).** The gate now measures FIVE
  signals: scavenges, custom counters, retained heap, plus (4) **old-gen
  activity** (`major + incremental`, threshold `maxOldGen` default 0) and
  (5) **external/arrayBuffers growth** (`memoryUsage().arrayBuffers`
  delta, threshold `maxArrayBuffersKB` default 64). Both are GATE signals,
  not a profiler: each over-budget reason ends with "diagnose with
  @zakkster/lite-gc-profiler". The boundary law holds -- no GC-kind
  breakdown on results beyond the two composed counters.
- **The GC-kind census (decisions/0003).** Before any signal froze, a raw
  `PerformanceObserver` census (`test/probes/census-0003.mjs`, repo-only)
  logged kind + flags + timing across the bypass corpus, three corpus
  runs plus a 100-rep x 2 ambient distribution. It falsified the naive
  design: on Node v26.3.1, C1's 600KB-string LO churn (PG-02) fires
  `oldGen=0` in-window and a flat settle, so it is a DOCUMENTED HOLE, not
  a catch (Axis A4). C2's Float64Array churn fires `oldGen=2` (caught).
  C3's 16MB pool grows `arrayBuffers` 16384KB while retained reads <64KB
  (caught). Ambient old-gen and arrayBuffers were 0 across all 200 reps,
  so the defaults (0 / 64) cause zero spurious failures.
- **`controlLarge` + external detector integrity.** A bounded, mask-gated
  retained 64KB-ArrayBuffer pool (deterministic 832KB arrayBuffers at the
  pinned k*N, 13x the gate) validates signal 5 on every `zgcSuite`/`runGate`
  run, as the third argument to the ONE `validateDetector(pos, neg, large,
  maxScav)` predicate (no fork). A `largeControl` config override and a
  negative-control old-gen clause (the arithmetic control must fire 0
  old-gen) complete the detector. Because a retained-external control
  leaves a V8 scheduled-scavenge residue that poisons the next
  scavenge-gated measurement (mechanism proven in decisions/0003, not
  drainable), `controlLarge` is measured LAST in `runGate` and last in
  `zgcSuite`'s detector block; nothing scavenge-gated follows it.
- **`MeasureResult` gains `oldGenLo/oldGenHi` and
  `arrayBuffersKB_lo/arrayBuffersKB_hi`** (additive -- no existing key
  changes). `toNDJSON`'s measure line carries them. `formatResult` shows
  old-gen and arrayBuffers only when nonzero.
- **Torture T3** activates: the PG-02/PG-03 bypasses as permanent
  bare-child fixtures at pinned windows, all judged at default thresholds,
  plus a `TORTURE_CONTROL=zero-signal` lane (test-code only) that zeroes
  the two new fields in-child and MUST make T3 fail.

#### Changed

- **New defaults CAN fail a previously-green suite** -- exactly when a hot
  path fires an old-gen collection (`maxOldGen: 0`) or grows external
  memory past 64KB (`maxArrayBuffersKB: 64`). That is the release: the
  gate now sees PG-03a and PG-03b. The 0/200 ambient census reps are the
  evidence a genuinely zero-alloc path trips neither.
- **PG-02 (600KB-string LO churn) is recorded as an uncatchable hole on
  Node v26.3.1**, not silently "fixed": it fires no countable GC event any
  lane can gate, and T3's t3a asserts its measured signature so a future
  Node that closes the hole will flip the fixture.
- **`allowNoGc: true` with an explicit `maxArrayBuffersKB` throws** (new
  `NO_ARRAYBUFFERS` door, mirroring `maxRetainedKB`); the arrayBuffers
  lane is not applied at all when `retainedReliable === false`. The
  old-gen lane comes from the observer, not `memoryUsage`, so it gates
  even under `allowNoGc`.
- **The measurement window and `suiteGate` are byte-identical to v1.4.0.**
  The observer callback gained two compare-and-increment branches
  (incremental, weakcb -- outside the hot body); `incremental` is read
  after `gcc.close()`, and the arrayBuffers captures reuse the existing
  before/after `memoryUsage()` points. `gc2` and `suiteGate` are
  untouched (P4 owns suiteGate).

### Fail-closed doors -- thresholds, options, instrument, process contract (session P2)

#### Changed

- **Thresholds throw instead of passing everything (PG-04).**
  `maxScavenges` and `maxRetainedKB` must be finite numbers >= 0 and
  every `counters` maximum must be a finite number; NaN, Infinity,
  negative counts and non-numbers now raise TypeError/RangeError at
  config time, prefixed `lite-perf-gate: <where>: ` and naming the
  field and the value. Reproduction inverted:
  `verdict(r, {maxScavenges: NaN, maxRetainedKB: NaN})` used to pass a
  result carrying 999 scavenges and 9999KB retained.
- **A NaN measurement fails instead of passing (PG-04).** A gated signal
  that is not a finite number now produces
  `'<signal>: not a number (fail closed)'` -- `scavenges`, `retained`,
  or the counter's own key. A NaN measurement is evidence of a broken
  instrument, never of a clean hot path.
- **A counter threshold that matches nothing fails (PG-05).** A typo'd
  key produces `'<key>: no such counter measured (statsOf keys: ...)'`;
  counter thresholds set against a scenario with no `statsOf` produce
  one `'counters: ... (fail closed)'` reason. Previously
  `{poolGrowth: 0}` against a measured `poolGrowths: 99` passed with
  zero reasons, forever, silently.
- **Missing `--expose-gc` throws (PG-11).** `measure()` -- and so
  `zgcSuite`/`runGate` -- refuses at entry when `globalThis.gc` is not
  a function, with the exact run command in the message. Previously
  `gc2()` no-opped and the retained signal judged uncollected garbage
  (a plain-node run produced a spurious `retained: 2901KB > 64KB`).
- **Empty scenario lists throw (PG-08).** `zgcSuite`/`runGate` reject a
  missing, non-array or empty `scenarios`; pass `allowEmpty: true` for a
  controls-only detector smoke run. `runGate`'s old `PASS -- 0/0
  scenarios` rubber stamp is now `detector only (allowEmpty, 0
  scenarios gated)`, and zgcSuite's control test renames itself
  `detector validation only (allowEmpty, 0 scenarios)`.
- **`measure()` options are validated, and `flushMs: 0` is honored
  (PG-09).** `N` integer >= 1, `k` integer >= 2, `flushMs` finite >= 0,
  `allowNoGc`/`allowEmpty` strictly boolean (a truthy non-`true` value
  throws). Every `(options && options.X) || DEFAULT` resolution is now
  `!== undefined`, so `flushMs: 0` reaches the sleep instead of
  silently meaning 100ms -- the one backward-incompatible behavior
  change in this release. `{N: -1}` used to skip every loop and make
  the POSITIVE CONTROL report zero allocation; `{k: 0.5}` used to
  invert the two-scale design; `{flushMs: -50}` used to collapse the
  observer window to ~1ms with a Node TimeoutNegativeWarning.
- **Scenario shapes are validated at the same door.** `name` a non-empty
  string, `setup`/`hot` functions, `statsOf`/`teardown` functions when
  present -- across `scenarios[]`, `mustFail[]`, `positiveControl` and
  `negativeControl`, each named by its position in the message.
- **`runGate`'s exit-code claim is corrected (PG-14).** The old
  docstring -- and the 1.2.0 entry below -- promised "exit codes 0/1/2"
  and set none. `runGate` never touches `process.exitCode`: runner
  semantics stay in the runner layer. It now RETURNS `code` and the
  docs say "map result.code to your exit code".

#### Added

- **`code: 0 | 1 | 2` on GateResult.** 0 pass, 1 a failing scenario or
  an uncaught `mustFail`, 2 detector validation failed.
  `passed === (code === 0)`, asserted by test. Additive: `passed` and
  `results` are unchanged.
- **`allowNoGc`** (measure options + GateConfig). Runs without
  `--expose-gc`; the result carries `retainedReliable: false`, the
  retained rule is not applied at all (the default 64KB threshold
  included), `retainedKB_lo/_hi` remain as diagnostics, and scavenges
  and counters still gate. Combining it with an explicit
  `maxRetainedKB` throws: retained is ungateable without the flag.
- **`allowEmpty`** (GateConfig). The only sanctioned empty gate: a
  controls-only detector smoke run, which is exactly what the torture
  suite's T1a child is.
- **`retainedReliable`** on MeasureResult. `false` only when `measure()`
  ran without `globalThis.gc`; an absent field means reliable.
- **Torture tier T2 -- fail-closed doors** (`test/torture/t2-doors.mjs`):
  sixteen door cases hit from OUTSIDE the library, each with its passing
  twin one valid step away, plus two children spawned WITHOUT
  `--expose-gc` (one asserting the throw carries the run command, one
  asserting the `allowNoGc` retained behavior). Third
  control-for-the-control: `TORTURE_CONTROL=no-doors npm run torture`
  routes the NaN cases through a legacy fail-open shim and T2 MUST fail.
- **Six self-tests** (28 -> 34): threshold doors, NaN measurements,
  unknown/absent counters, measure option doors including a timing proof
  that `flushMs: 0` is honored, the empty-gate doors, and `runGate`
  codes 0/1/2 in bare children with `process.exitCode` asserted
  untouched in all three.
- **`decisions/0002-fail-closed.md`** -- the six policies, the rejected
  `allowNoGc` shapes, and the standing rejection of an `inconclusive`
  third verdict.

#### Notes

- Hot bodies are untouched: `meterOnce`'s measurement window (between
  `makeGcCounter()` and `gcc.close()`) and `suiteGate`'s `visit` have a
  byte-identical diff. Every door is config-time or verdict-time.
- suiteGate sources that reduce to NaN now fail their budget closed
  instead of passing silently -- a down payment on PG-06; the record
  doors themselves are P4.

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
