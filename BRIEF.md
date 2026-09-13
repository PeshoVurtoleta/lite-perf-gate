---
package: "@zakkster/lite-perf-gate"
version_target: 1.3.0
status: shipped
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [PG-01, PG-10, PG-15-partial]
depends_on: [P0]
blocks: [P2]
---

# lite-perf-gate -- the detector must detect, in a fresh process, today (P1)

PURPOSE
  The positive control's grow-forever sink teaches V8's allocation-site
  pretenuring that the site is long-lived; allocation moves to old space
  and the scavenge signal dies. Measured on Node v26.3.1, defaults,
  fresh process: minorLo=2, minorHi=1 -- inverse scaling -- and runGate
  refuses with DETECTOR VALIDATION FAILED. The same sink retains 113MB
  for the process lifetime and poisons every later measurement in it
  (the negative control then forced 6 scavenges and failed validation).
  A gate whose self-validation fails on a healthy machine is worse than
  a gate with no self-validation: it trains users to expect red.

MEASURED BASELINES (2026-09-13, Node v26.3.1, --expose-gc
--max-semi-space-size=4; reuse as regression anchors)
  - Stock controlPositive, fresh process, N=200000 k=8:
    minorLo=2, minorHi=1, majorLo=1, majorHi=1, retainedKB_hi ~100784.
    runGate: "DETECTOR VALIDATION FAILED: positive 2 (need >5)".
    Reproduced twice, deterministic.
  - Ring variant (64-slot module array, same {x,y,z,w} shape, hot writes
    ring[i & 63] = {...}): minorLo=2, minorHi=21, majorLo=0, majorHi=0,
    retainedKB_hi ~11. Reproduced twice.
  - Poisoning: after one measure(controlPositive) at defaults, heapUsed
    grows ~113MB (survives double gc()), _controlKeepAlive() -> 1840000,
    and a subsequent negative-control measure in the SAME process forced
    6 scavenges (needs <=2) -> validation fails in-process.
  - Under `node --test` the control test can pass at defaults because the
    test-runner's own allocations add scavenges during the window; in a
    bare process it fails. The self-test also measures at non-default
    N=100000 k=4, which is why today's suite is green while the default
    configuration is broken. T1 therefore runs LIBRARY DEFAULTS in bare
    child processes.

THE DECISION (write decisions/0001-positive-control.md BEFORE coding)
  Control redesign, options:
  A. RING SINK (recommended) -- module-level 64-slot array, hot writes
     `ring[i & 63] = {x,y,z,w}`. Objects escape to the heap (defeats
     scalar replacement -- the README's existing concern) and die young
     within 64 iterations (defeats pretenuring -- the new one). Numbers
     above. Footprint bounded at 64 objects; the 113MB retention and the
     in-process poisoning die in the same move.
  B. PERIODIC TRUNCATION -- keep the growing sink, reset length every M
     pushes. Still trains pretenuring between resets (survival ratio
     stays high); reject unless A measures unstable.
  Also decide THE VALIDATION MARGIN. Today zgcSuite demands
  `posMinorHi > maxScavenges + 3`, COUPLING the control's required
  evidence to the user's scenario budget (maxScavenges: 40 silently
  demands a 43-scavenge control). Give the control its own floor,
  decoupled and scaling-aware, e.g.:
    posMinorHi >= CONTROL_FLOOR (own constant, independent of
    thresholds) AND posMinorHi >= 2 * posMinorLo when posMinorLo > 0.
  Planner proposes the exact inequality and CONTROL_FLOOR value from the
  measured numbers (ring: lo=2 hi=21); record it and the rejection of
  the coupled form. The SAME predicate must be used by zgcSuite and
  runGate -- extract one shared helper, do not fork the logic.
  Also record why `spawn`-style fixes such as keeping the big sink but
  hiding it behind WeakRef, or scattering allocation sites, are rejected
  (complexity without a measured advantage).

TASKS
  - Write decisions/0001-positive-control.md first (mechanism: what
    allocation-site pretenuring is, the measured table, the options, the
    choice, the margin inequality). decisions/ stays OUT of files[].
  - Implement the chosen control in PerfGate.js. Export names stay:
    `controlPositive`, `controlNegative`, `_controlKeepAlive` (now
    returns the ring occupancy or equivalent live-sink size; its purpose
    -- a read that stops dead-code elimination -- stays; update its
    JSDoc). No other exported function changes behavior.
  - Replace the coupled validation predicate in BOTH zgcSuite and
    runGate with the shared decoupled helper per the decision. Failure
    messages keep naming the numbers and the run flags.
  - devDependencies (lite-arena convention): "@zakkster/lite-gc-profiler"
    ^1.16.0 and "@zakkster/lite-leak" ^1.10.0. Add .gitignore with
    /node_modules/, /package-lock.json, .DS_Store (lockfile is NOT
    committed in this suite). Run npm install so the torture suite can
    import them.
  - BEFORE using either peer API, READ
    /Users/zakkster/Work/Portfolio/LiteLibrariesSuite/LiteGcProfiler/llms.txt
    and /Users/zakkster/Work/Portfolio/LiteLibrariesSuite/LiteLeak/llms.txt.
    Do not write a single profiler or leak call from memory. Known
    profiler constraints: one measurement in flight at a time (nested
    measure* throws "already in flight"); unknown rule keys THROW since
    v1.10; there is no maxExternalGrowth; never resolve an unexpected
    inconclusive with allowInconclusive. If lite-leak's owner-tree API
    does not fit a plain-function package, use the narrowest honest
    check it supports (e.g. collectability of measure() state after
    teardown) and say so in a comment -- do not force-fit kernels.
  - Stand up test/torture.mjs + test/torture/harness.mjs:
      T1 detector matrix -- spawn bare child processes
        (node --expose-gc --max-semi-space-size=4, NOT under --test):
        (a) runGate detector validation at library defaults passes;
        (b) positive control scales per the decision inequality at
            N in {50000, 200000};
        (c) after a positive measure, a negative measure in the same
            child still validates (the poisoning regression);
        Each child prints machine-readable results; the parent asserts
        and prints the Node version next to every number.
      T5 footprint + soak -- in-process: post-gc heapUsed growth after
        measure(controlPositive) at defaults < 1MB (today 113MB);
        then leak_cycles=4096 cycles of {measure with tiny N (e.g.
        N=200, k=2), suiteGate over a small slab, toNDJSON}, heap
        sampled every 256 cycles, flat within a stated band; use the
        gc-profiler and/or lite-leak for the gating per their real
        APIs.
      T6 controls for the controls -- sabotage hooks that prove tiers
        can fail: a child with the stock grow-forever control (T1 must
        fail it), a deliberately leaky cycle (T5 must fail it). Wire
        them behind env flags (e.g. TORTURE_CONTROL=...) so the normal
        run stays green and the control run is one command each.
      T2/T3/T4 -- register as named empty tiers that print "skipped
        (P2/P3/P4)" so later sessions fill them without reshaping the
        harness.
      torture.mjs prints exactly "ok" on success, exits 0; any failure
      exits 1 with the tier and numbers.
  - package.json: `"torture": "node --expose-gc --max-semi-space-size=4
    test/torture.mjs"`. Keep test/ and decisions/ out of files[].
  - Self-test additions (fix PG-15): (a) child-process test that runs a
    minimal zgcSuite file end-to-end at LIBRARY DEFAULTS under
    node --test in the child and asserts green; (b) same with a
    sabotaged positive control (stock grow-forever shape) and asserts
    the control test goes red; (c) fix the self.test.mjs header list to
    match what the file actually covers. Keep total `npm test` runtime
    under ~90s.
  - Three-place sync 1.2.2 -> 1.3.0 (package.json, VERSION, CHANGELOG).
    CHANGELOG 1.3.0 entry: Changed -- positive-control semantics (ring
    sink, why), decoupled validation margin (the inequality), Added --
    torture suite tiers T1/T5/T6, devDeps, .gitignore; record the
    measured before/after numbers and that they were taken on Node
    v26.3.1 (darwin). State plainly that the multi-Node matrix is a CI
    intent; only v26.3.1 was measured on this machine (no nvm here).

HOT PATH
  None of this touches suiteGate's visit. The control hot loop is the
  instrument, not the subject -- but its footprint IS gated now (T5).
  meterOnce's measurement window gains zero instructions; diff proves it.

ASSERTIONS
  - Fresh bare-process detector validation passes at library defaults on
    this machine (the PG-01 reproduction, inverted into T1a).
  - Ring control scales: the decision inequality holds at both T1b sizes.
  - After measure(controlPositive) at defaults: post-gc heapUsed growth
    < 1MB, and a subsequent negative-control measure in the same process
    validates (T1c/T5).
  - T6: the stock grow-forever control makes T1 fail; the leaky cycle
    makes T5 fail. Run both sabotage commands and paste the failures.
  - `npm test` green (existing 26 + new child-process tests), under ~90s.
  - `npm run torture` prints "ok", exit 0, under ~180s.
  - `npm pack --dry-run`: still 7 files; decisions/, test/, .gitignore,
    node_modules excluded.
  - Three-place sync at 1.3.0; ASCII-only in every touched text file;
    PerfGate.js keeps exactly one trailing newline.

NON-GOALS
  No verdict changes (P2). No new signals -- maxMajors and external
  deltas are P3. No suiteGate work (P4). No README rewrite (P5) beyond
  nothing at all. NO git commits by subagents; NO npm publish (not even
  --dry-run this session). The registry currently serves 1.2.1 and the
  1.2.2 publish is the user's to run.

DONE WHEN
  detector validates at defaults in a fresh process on current Node;
  control footprint bounded; torture skeleton green with controls that
  provably fail; decision recorded; three-place sync 1.3.0
