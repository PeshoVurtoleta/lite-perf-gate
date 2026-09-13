---
package: "@zakkster/lite-perf-gate"
version_target: 1.5.0
status: in-progress
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [PG-02, PG-03]
depends_on: [P2]
blocks: [P5]
---

# lite-perf-gate -- 2.4GB of churn must not pass a zero-alloc gate (P3)

PURPOSE
  Reproduced (ROADMAP section 2): a hot path building a 600KB string per
  iteration churned ~2.4GB through large-object space and PASSED
  (minorHi=2, majorHi=0, retained 15KB) -- PG-02. A path churning 2.1GB
  of Float64Array backing stores PASSED (minor 1, major 1, retained
  NEGATIVE) -- PG-03a. A pool retaining 16MB of buffers PASSED the 64KB
  retained threshold (heapUsed excludes backing stores; measured delta
  4.6KB) -- PG-03b. The one-line promise is "prove your hot path
  allocates nothing -- or name what did"; today it cannot name anything
  big, external, or old-gen.

  Boundary law, decided up front: this is GATE HARDENING, not profiler
  creep. New thresholds in the same three-line verdict vocabulary; no
  GC-kind breakdowns in results, no per-callsite tables, no explain
  reports. When a new signal trips, the failure message points the user
  at lite-gc-profiler for diagnosis. That sentence ships in the reason
  string or its docs, and the CHANGELOG repeats the boundary.

THE CENSUS COMES FIRST (this session's anti-vibes law)
  The naive design -- "verdict reads the majors meterOnce already
  records" -- is FALSIFIED by the probe data: PG-02's LO churn showed
  majorLo=0, majorHi=0 in-window on Node v26.3.1. makeGcCounter counts
  only NODE_PERFORMANCE_GC_MINOR and _MAJOR; INCREMENTAL and WEAKCB
  entries are dropped, and V8 may also defer LO collection past the
  flush window entirely. Therefore, BEFORE any design freezes, the
  planner specifies and the coder runs a KIND CENSUS probe: a raw
  PerformanceObserver logging kind + flags + timing for every 'gc'
  entry across the full bypass corpus --
    C1 600KB-string LO churn        (the PG-02 probe, verbatim)
    C2 512KB Float64Array churn     (PG-03a)
    C3 16MB retained pool           (PG-03b)
    C4 classic small-object churn   (the ring control, as baseline)
    C5 pure arithmetic              (negative baseline)
  each at the pinned deterministic window sizes the probes used, plus
  the ambient distribution: 100 repetitions of C4/C5 recording
  major/incremental counts and pause distribution (this also folds in
  the T5 pause-noise question -- 11.6-12.9ms transient spikes were seen
  under external host load in P2 verification).
  The census numbers go INTO decisions/0003-bypass-signals.md verbatim,
  and the signal design follows the numbers. If some bypass fires no
  countable GC event on this Node, the decision record says exactly
  that, and the corpus asserts what IS catchable instead of pretending.

THE DECISION (decisions/0003-bypass-signals.md, drafted by planner from
census data; the shapes to weigh)
  1. Event-class signal: count MAJOR only, or MAJOR+INCREMENTAL as one
     "old-gen activity" counter (WEAKCB policy stated either way)?
     Threshold name and default (recommendation to test first:
     maxMajors 0 -- but the census, not the recommendation, decides the
     default and whether the counter includes incremental steps).
     Scaling lane vs absolute: majors are rare events; absolute is
     likely the honest lane -- decide with the census.
  2. External signal: arrayBuffersKB delta measured at the same points
     heapUsed already is (post-gc2 before/after, OUTSIDE the counting
     window -- the window gains zero instructions, law). Threshold
     maxArrayBuffersKB, default mirroring maxRetainedKB (64). Verify
     with C2 whether TRANSIENT external churn is caught by the
     event-class signal or needs its own lane; C3 proves the retained
     case.
  3. Detector integrity: every gated signal gets a control. Shape:
     controlLarge (LO churn that must trip the chosen event-class
     signal and/or external delta). Where it runs: always in
     zgcSuite/runGate validation (cost ~1-2s, a gate may be thorough)
     vs only when the new thresholds gate (they gate by default, so
     this collapses to always) vs torture-only. Decide with measured
     cost; record. validateDetector grows the clause; the P1 law holds:
     ONE predicate, both call sites, no fork.
  4. If the census shows a bypass class that NO cheap signal catches
     in-window (deferred LO collection), the fallback design to weigh:
     count events during the SECOND gc2 (the settle pass) into a
     separate settle-window counter -- forced-collection work there
     scales with what the hot loop left behind. Only if needed; only
     with census evidence; the measurement window itself stays
     untouched either way.

TASKS (beyond the census and decision)
  - meterOnce: capture memoryUsage().arrayBuffers alongside heapUsed at
    the SAME two points; MeasureResult gains arrayBuffersKB_lo/_hi (and
    whatever event-class fields the decision adds). Names are contract:
    coordinate with formatResult, verdict reasons, d.ts, llms.txt.
  - makeGcCounter: extend per the decision (count the chosen kinds;
    keep MINOR/MAJOR fields back-compatible).
  - verdict: new thresholds with P2's fail-closed semantics inherited
    exactly (finite >= 0 at config; NaN measured fails with the P2
    reason format; unknown keys already impossible by construction --
    thresholds are named fields). Reason strings follow the house
    format and the failure message for the new signals appends the
    boundary pointer ("diagnose with lite-gc-profiler").
  - zgcSuite/runGate: plumb thresholds + the decision-3 control;
    validateDetector extended, still one predicate.
  - mustFail corpus becomes torture T3 (replaces the skipped stub):
    C1/C2/C3 as permanent fixtures that the gate must now CATCH, plus
    C4 as the still-caught-by-scavenges control; T6-style zeroed-signal
    shim (test-code only, never a library flag) must make T3 fail.
  - formatResult: event-class count and external delta shown when
    nonzero.
  - PerfGate.d.ts + llms.txt: new fields/thresholds, minimal (P6 owns
    the rewrite). CHANGELOG 1.5.0: the five-signal table, the census
    table, the honest note that new defaults can fail previously-green
    suites exactly when majors/external move -- that is the release.
  - Three-place sync 1.4.0 -> 1.5.0.
  - Consumer audit (grep, like P2): t1b/t1c fixtures print major
    fields -- update expectations if the counter fields change shape;
    T5 soak and existing fixtures must stay green under the new
    defaults (the census C4/C5 ambient data justifies the chosen
    defaults against exactly this).

HOT PATH
  The measurement window between makeGcCounter() and gcc.close() gains
  ZERO instructions -- both new captures happen at the existing
  before/after points. The observer callback may gain at most the same
  kind-compare-and-increment shape it already has for the new kinds.
  suiteGate untouched entirely (P4's domain). Diff proves all three.

ASSERTIONS
  - The census table exists in decisions/0003 with real numbers from
    this machine, kinds broken out, 100-rep ambient distribution
    included.
  - PG-02 probe (600KB strings): verdict FAILS naming the chosen
    signal. PG-03a (512KB churn): FAILS naming its signal per the
    decision. PG-03b (16MB pool): FAILS naming arrayBuffersKB. All
    three as torture T3 fixtures, plus in-session one-off runs pasted.
  - Negative + ring controls still validate at defaults across the
    ambient 100-rep distribution: zero spurious failures from the new
    signals, or the default moves and the decision file shows the
    numbers that moved it.
  - New thresholds inherit P2 doors: NaN threshold throws; NaN measured
    value fails with the P2 format; {maxMajors: -1} (or the decided
    name) throws.
  - T3 active in torture stderr; zeroed-signal control fails T3;
    stock-control/leaky-soak/no-doors still fail their tiers.
  - npm test green inside 90s; torture ok inside 180s; pack --dry-run
    7 files; ASCII; EOF newline; three-place sync 1.5.0; HEAD moves
    only by orchestrator commits (current HEAD: 56c3af4).

NON-GOALS
  No GC-kind breakdown in MeasureResult beyond the decided counter
  fields (kind census lives in the decision record, not the API). No
  pause budgets (gc-profiler owns pauses). No RSS/PSS lanes. No browser
  anything. No suiteGate changes (P4). No baseline files (ledger). NO
  git commits by subagents; NO npm publish of any kind (registry is at
  1.3.0; 1.4.0 publish is the user's).

DONE WHEN
  all three bypass reproductions are caught and named by torture-gated
  fixtures; every gated signal has a control that provably fails;
  defaults chosen from the census distribution; decision recorded with
  the census table; five-signal story true in code, d.ts, llms.txt
