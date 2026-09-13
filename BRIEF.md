---
package: "@zakkster/lite-perf-gate"
version_target: 1.4.0
status: in-progress
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [PG-04, PG-05, PG-08, PG-09, PG-11, PG-14]
depends_on: [P1]
blocks: [P3, P4]
---

# lite-perf-gate -- a gate that can be talked past is not a gate (P2)

PURPOSE
  Six reproduced ways to get a green verdict (or a meaningless one)
  without a sound measurement, all documented with probes in ROADMAP.md
  section 2: NaN thresholds pass everything (PG-04); NaN measurements
  pass (PG-04); a typo'd counter-threshold key gates nothing forever
  (PG-05); an empty scenario list is a green suite (PG-08); N=-1 makes
  the positive control itself pass as zero-alloc, k=0.5 inverts the
  scaling design, negative flushMs collapses the observer window
  (PG-09); a missing --expose-gc silently judges with a dead instrument
  (PG-11); and runGate's docstring promises exit codes 0/1/2 it never
  delivers (PG-14). One session, one law: fail closed.

THE DECISION (write decisions/0002-fail-closed.md BEFORE coding)
  1. THRESHOLDS: NaN / non-finite / negative / non-number threshold
     values (maxScavenges, maxRetainedKB, per-counter maxima) throw
     TypeError/RangeError at config time, library-prefixed, naming the
     field and value. Precedent: lite-gc-profiler throws on bad rule
     values on its ops/frames lanes.
  2. MEASURED NaN: a NaN measured value (minorHi, retainedKB_hi, a
     counter delta) makes verdict FAIL with reason
     '<signal>: not a number (fail closed)'. A NaN measurement is
     evidence of a broken instrument, never of a clean hot path.
  3. UNKNOWN COUNTER KEYS: cannot be validated at config time (counter
     names exist only at runtime), so verdict FAILS with reason
     '<key>: no such counter measured (statsOf keys: ...)'. ALSO
     fail closed on the null case: thresholds.counters present but the
     result has counters_hi === null (scenario had no statsOf) -> FAIL
     with a reason saying so. Follows the gc-profiler v1.10+ unknown-
     rule-keys precedent in spirit; record why it is fail-at-verdict
     here rather than throw-at-config.
  4. MISSING --expose-gc: measure() (and therefore zgcSuite/runGate)
     throws at entry when typeof globalThis.gc !== 'function', message
     carrying the exact run command. Escape hatch `allowNoGc: true`
     (measure options + GateConfig). Decide the retained-signal shape
     under allowNoGc; options for the planner to weigh:
       A (recommended): allowNoGc + an EXPLICIT maxRetainedKB in the
         same config throws at config time ('retained is ungateable
         without --expose-gc'); with allowNoGc the retained rule is NOT
         applied at all (default threshold included), the result
         carries `retainedReliable: false`, and retainedKB_* stay as
         diagnostics. Scavenges and counters still gate. Rationale:
         the caller explicitly traded the retained signal away; gating
         it anyway would judge noise (PG-11's spurious FAIL showed
         2901KB of uncollected garbage).
       B: keep the default retained rule and fail it with an
         'unreliable' reason whenever retainedReliable is false --
         rejected candidate: makes the escape hatch useless.
     Record the choice and the rejection.
  5. runGate PROCESS CONTRACT: add `code: 0 | 1 | 2` to GateResult
     (0 pass, 1 scenario or mustFail failure, 2 detector-validation
     failure). `passed === (code === 0)`. runGate NEVER touches
     process.exitCode (suite law: runner semantics stay in the runner
     layer); the docstring is rewritten to say "map result.code to your
     exit code" and the CHANGELOG corrects the old 0/1/2 wording.
  6. EMPTY GATES: zgcSuite and runGate throw on a missing, non-array,
     or empty scenarios array unless `allowEmpty: true` is passed --
     the option exists for controls-only detector smoke runs (torture
     t1a is exactly that consumer) and its JSDoc says so.

TASKS
  - decisions/0002-fail-closed.md first (the six policies above, with
    the PG reproductions cited and the rejected shapes recorded).
  - One shared option validator used by measure/zgcSuite/runGate:
    N integer >= 1; k integer >= 2; flushMs finite >= 0 -- and 0 must
    now be HONORED (replace every `(x && x.f) || DEFAULT` resolution
    with `!== undefined` semantics); allowNoGc/allowEmpty strictly
    boolean (truthy non-true throws -- the lite-leak 1.10.0 precedent).
  - Scenario shape validation at the same door: name non-empty string,
    setup/hot functions, statsOf/teardown functions when present;
    applied to scenarios[], mustFail[], positiveControl, negativeControl.
  - Threshold validation per decision 1; measured-NaN policy per 2;
    unknown/null counter policy per 3; --expose-gc policy per 4;
    GateResult.code per 5; empty-gate doors per 6.
  - INTRA-REPO CONSUMERS (grep test/ for every measure(/runGate(/
    zgcSuite( call and audit each against the new doors):
    * test/torture/fixtures/t1a-rungate.mjs calls
      runGate({ scenarios: [] }) -- must become
      runGate({ scenarios: [], allowEmpty: true }) and thereby becomes
      the torture-side proof of the new option.
    * the T5 soak's measure(tiny, {N: 200, k: 2, flushMs: 1}) is legal
      under the new doors -- assert, do not change.
    * test/fixtures/*.test.mjs zgcSuite configs have non-empty
      scenarios -- legal; leave.
  - Torture T2 tier filled (replaces the skipped stub): every door hit
    from OUTSIDE -- NaN thresholds, NaN measured (hand-built result),
    typo'd counter key, counters-without-statsOf, N/k/flushMs garbage,
    non-boolean allowNoGc, empty scenarios, scenario-shape garbage --
    each with its passing twin one valid step away; plus a CHILD
    process spawned WITHOUT --expose-gc asserting measure() throws
    with the run command in the message (exit non-zero, never a hang),
    and a child WITH allowNoGc asserting retainedReliable === false
    and the decision-4 retained behavior.
  - Self-test additions: runGate code values 0/1/2 exercised (0: green
    controls-only allowEmpty run; 1: a mustFail that is not caught or
    a failing scenario; 2: sabotaged control) -- reuse the P1 fixture
    pattern (bare children, pinned N=20000 k=8 for deterministic
    sabotage; the ~31%-flake lesson from P1 review is law here).
  - PerfGate.d.ts: GateConfig gains allowEmpty?/allowNoGc?/flushMs
    stays; measure options gain allowNoGc; MeasureResult gains
    retainedReliable?: boolean; GateResult gains code: 0 | 1 | 2.
  - llms.txt: minimal additions only (new options, code field, the
    throw-on-no-gc sentence replacing "required" prose) -- the full
    rewrite stays P6.
  - Three-place sync 1.3.0 -> 1.4.0; CHANGELOG 1.4.0 entry (Changed:
    throwing doors where garbage was accepted, each PG finding named;
    Added: allowNoGc/allowEmpty/code/retainedReliable).

HOT PATH
  All doors are config-time or verdict-time -- cold. meterOnce's
  measurement window (between makeGcCounter() and gcc.close()) and
  suiteGate's visit gain ZERO instructions; diff proves it. suiteGate
  itself is untouched this session (its doors are P4).

ASSERTIONS
  - Every PG-04/05/08/09/11/14 reproduction from ROADMAP section 2,
    inverted: the exact calls that passed now throw or fail with the
    documented reason string.
  - verdict(r, {maxScavenges: NaN}) throws; NaN minorHi fails with the
    named reason; typo'd counter key fails naming the available keys;
    counters thresholds against counters_hi null fails.
  - measure(controlPositive, {N: -1}) throws; {k: 0.5} throws;
    {k: 1} throws; {flushMs: 0} is accepted AND honored (prove the 0
    actually reaches the sleep: e.g. duration delta vs flushMs: 200).
  - Plain node (no flags): measure() throws with the run command in
    the message; with allowNoGc: true it runs, retainedReliable is
    false, and the decision-4 retained behavior holds.
  - zgcSuite({scenarios: []}) throws; with allowEmpty: true it
    registers the detector test only and the test name says so.
  - runGate returns code 0/1/2 per the contract; process.exitCode is
    untouched in all three cases; passed === (code === 0).
  - torture prints ok with T2 now ACTIVE (stderr shows T2 numbers, not
    "skipped"); TORTURE_CONTROL sabotages still fail; a NEW T2 control
    (one door deliberately removed via env flag) fails T2.
  - npm test green inside 90s (expect ~34 tests); npm run torture ok
    inside 180s; npm pack --dry-run still 7 files; ASCII; EOF newline;
    HEAD advances only by orchestrator commits.

NON-GOALS
  No new signals (P3: maxMajors/maxArrayBuffersKB). No suiteGate doors
  (P4). No inconclusive third verdict (rejection ledger stands). No
  README work. NO git commits by subagents; NO npm publish of any kind
  this session (the user publishes; registry currently at 1.3.0).

DONE WHEN
  every fail-open reproduction fails closed with a named reason; the
  doors are torture-gated with controls that provably fail; decision
  0002 recorded; three-place sync 1.4.0
