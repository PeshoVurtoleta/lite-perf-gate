---
package: "@zakkster/lite-perf-gate"
version_target: 1.6.0
status: in-progress
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [PG-06, PG-12, PG-13]
depends_on: [P2]
blocks: [P5]
---

# lite-perf-gate -- the SPP consumer must reject what it cannot read (P4)

PURPOSE
  suiteGate is the package's growth axis and its ONLY hot body, and it
  is the one surface still fail-open after P2/P3. Reproduced (ROADMAP
  section 2): the same over-budget record FAILS as a Float64Array slab,
  PASSES as a Float32Array (native forEach arity collision binds
  (value, index, array) onto (packed, t, a, b) -- reduced value
  -Infinity, count 1), and PASSES as a plain array of tuples (count 0)
  -- PG-06. slot: 'toString' is accepted via Object.prototype and
  silently reads slot b; reduce: 'constructor' acts as 'last'; a budget
  legitimately NAMED 'toString' is falsely rejected as a duplicate --
  PG-12. A budget explicitly targeting CONT (op 0x0F01) is accepted at
  config, can never match, and passes vacuously (the self-test PINS
  this; changing it is deliberate) -- PG-13. Plus the one surface
  addition this roadmap allows: minCount, the presence assertion that
  turns "typo'd op passes forever with count 0" into a named failure.

THE DECISION (decisions/0004-record-doors.md BEFORE coding)
  1. Record doors, cost-measured. Candidate door set:
     (a) per-record `packed === packed >>> 0` in visit -- rejects NaN,
         negatives, fractions, object coercions in one compare; throws
         RangeError naming the record index (slab path) or invocation
         index (forEach path). A corrupt RECORD is data-integrity, not
         a budget miss: throw, never fail-a-budget.
     (b) reduce-time non-finite door -- a budget whose reduced value is
         not a finite number FAILS that budget closed with the P2
         reason format ('<name>: not a number (fail closed)' -- align
         the exact string with decisions/0002 policy 2's wording and
         its P4-forward promise about the non-finite class: Infinity /
         -Infinity now fail too, closing the -Infinity fail-open the
         P2 reviewer documented as unreachable-until-P4).
     (c) optional strict first-record shape check (t/a/b numbers).
     The door set that ships is decided by MEASUREMENT: lite-gc-profiler
     measureOps over suiteGate on a preallocated 1M-record slab with 8
     budgets, before/after, must be within noise; if (a)+(b) blow the
     budget, fall back per the ROADMAP brief (first-record strict +
     reduce-time door) and record the measured numbers either way.
     This measurement BECOMES torture T4 (the tier exists as a skipped
     stub; it activates this session).
  2. Null-prototype tables + own-key semantics (PG-12): SUITE_REDUCES /
     SUITE_SLOTS / the `seen` duplicate map become null-proto or
     own-property-checked; slot 'toString' throws the existing slot
     message; reduce 'constructor' throws the reduce message; a budget
     named 'toString'/'hasOwnProperty'/'__proto__' is legal end to end
     (through toNDJSON too -- verify the JSON path).
  3. CONT rejection (PG-13): suiteMatcher throws at config on
     op === 0x0F01 (and on a packed whose low 16 bits are 0x0F01) --
     'CONT records are never budget targets (SPP v1)'. The pinned
     self-test changes deliberately; CHANGELOG Changed entry names it.
  4. minCount (the ONE addition): optional integer >= 0 per budget;
     validation fail-closed like every other budget field; failure
     reason '<name>: matched <count> < minCount <n>'. The comparison
     MUST delegate through verdict() (one-comparison-authority law) --
     candidate encoding: shortfall = minCount - count when positive,
     fed as a counter with max 0, with suiteGate mapping the verdict
     reason back to the contract string; if the planner finds a cleaner
     delegation that keeps verdict() max-only, take it and record why.
     Rejected in the ledger (state it): a global requireAllMatch flag
     (too blunt); p95/percentile reducers (allocate; sort in the hot
     body); CONT payload decoding (SPP v2; a lite-scope bridge
     pre-reduces wide records if that ever gates).

TASKS
  - decisions/0004 first (door set + measured costs; the PG-12 class;
    CONT policy; minCount encoding; rejections).
  - suiteGate config validation hardening per decision 2/3/4; record
    doors per decision 1; reduce-time non-finite door.
  - Torture T4 activates: measureOps on visit over the 1M slab,
    maxArrayBuffersGrowth 0 + stabilize deep, before/after-doors delta
    within noise (profiler discipline: one measurement in flight;
    sequential with T5; no measureOps inside T5's window). T6-style
    control: a deliberately allocating visit shim (test code only)
    must fail T4.
  - Self-test: every PG-06/12/13 reproduction inverted (Float32Array
    and tuple-array sources THROW naming the first bad record index;
    'toString' budget round-trips through suiteGate AND toNDJSON;
    slot/reduce inherited keys throw; CONT throws at config; the old
    pinned CONT test rewritten to assert the throw); minCount positive
    and negative cases + validation doors with twins; the -Infinity
    reduced-value case now FAILS (the P2 reviewer's documented
    fail-open, closed).
  - decisions/0002 policy 2: update its P4-forward sentence to state
    the non-finite door has now landed (keep history honest -- add a
    dated line, do not rewrite the original).
  - PerfGate.d.ts (SuiteBudget.minCount + doc), llms.txt (doors, what
    throws vs what fails, minCount), CHANGELOG 1.6.0 dated 2026-09-13
    (Changed: CONT now config-throws, non-finite reduced values now
    fail, wrong-shaped sources now throw -- each with its PG finding;
    Added: minCount; the T4 numbers).
  - Three-place sync 1.5.0 -> 1.6.0. Consumer audit (grep suiteGate(
    across test/ and demo/ -- the demo's index.html is NOT in scope,
    note only if it calls suiteGate with shapes the doors would
    reject).

HOT PATH
  visit() IS the hot body of this package. Doors land only with T4
  measurement proof (within noise on the 1M slab, zero per-record
  allocation, reason strings built only on failure). meterOnce, gc2,
  verdict's existing lanes, zgcSuite/runGate: zero changed lines
  except where minCount delegation touches suiteGate-side composition.

ASSERTIONS
  - PG-F triple inverted: Float64Array still fails correctly;
    Float32Array and tuple-array sources THROW with a record index.
  - slot 'toString' throws; reduce 'constructor' throws; budget NAMED
    'toString' works end to end incl. NDJSON lines.
  - CONT budget (op and packed forms) throws at config.
  - Typo'd op with minCount 1 fails with the matched-count reason;
    without minCount it still passes reporting count 0 (back-compat,
    documented); minCount 0 is legal and inert; minCount -1 / 1.5 /
    NaN / '1' throw.
  - Reduced -Infinity now fails closed with the recorded reason.
  - T4 ACTIVE in torture stderr with the measured numbers; allocating-
    visit control fails T4; all four earlier controls still fail their
    tiers; npm test 10x loop all green (flake law); torture ok < 180s;
    npm test < 90s; pack 7 files; ASCII; three-place sync 1.6.0; HEAD
    moves only by orchestrator commits (current HEAD: effa1b5).

NON-GOALS
  No new reduce kinds. No CONT decoding. No stream discovery. No
  lite-scope import. No README work (P6). NO commits by subagents; NO
  publish (registry at 1.3.0; 1.4.0/1.5.0 publishes are the user's).

DONE WHEN
  every wrong-shape reproduction throws with an index; inherited-key
  holes closed; minCount shipped and delegated through verdict();
  visit measured within noise on the 1M slab; decisions 0004 recorded;
  three-place sync 1.6.0
