# 0002 -- Fail closed: thresholds, measurements, counters, the instrument,
        the process contract, and the empty gate

Status: accepted
Date: 2026-09-13
Session: P2 (v1.4.0)
Findings: PG-04 (S1), PG-05 (S1), PG-08 (S2), PG-09 (S2), PG-11 (S2),
          PG-14 (S3)
Measured on: darwin, Node v26.3.1, npm 12, flags
`--expose-gc --max-semi-space-size=4` unless stated. Every reproduction
cited below is from ROADMAP.md section 2 and was run before this record
was written.

## The problem

A gate exists to refuse. v1.3.0 made the instrument honest (0001); this
record makes the JUDGMENT honest. Six reproduced ways to obtain a green
verdict -- or a meaningless one -- without a sound measurement:

- PG-04, both directions. `{maxScavenges: NaN, maxRetainedKB: NaN,
  counters: {g: NaN}}` passes a result carrying 999 scavenges and 9999KB
  retained (probe PG-C1); a result carrying `minorHi: NaN,
  retainedKB_hi: NaN` passes the DEFAULT thresholds (probe PG-C2). Every
  comparison in verdict() is `measured > limit` and every NaN comparison
  is false, so "no reason pushed" reads as "clean".
- PG-05. `counters_hi = {poolGrowths: 99}` judged against
  `counters: {poolGrowth: 0}` -- singular, a typo -- passes with zero
  reasons (probe PG-D). The threshold gates nothing, forever, silently.
- PG-08. `zgcSuite({scenarios: []})` registers 2 control tests and
  reports `pass 2 fail 0`; `runGate({scenarios: []})` prints
  `PASS -- 0/0 scenarios` (probe-empty-suite.test.mjs). A build glitch
  that yields [] turns CI's gate into a rubber stamp.
- PG-09. `measure(controlPositive, {N: -1})` skips every loop including
  the warmup and the POSITIVE CONTROL reports minorHi = 0 -- zero-alloc,
  by the gate's own instrument. `{k: 0.5}` inverts the two-scale design
  (hi < lo). `{flushMs: -50}` is accepted; Node clamps it with a
  TimeoutNegativeWarning and the observer window collapses to ~1ms.
  `{flushMs: 0}` is silently impossible, because `|| DEFAULT` cannot
  distinguish 0 from absent (probes PG-H1, PG-H2).
- PG-11. Without --expose-gc, gc2() no-ops, nothing throws, nothing is
  flagged, and the retained signal judges uncollected garbage: a plain
  `node` run produced a spurious FAIL, `retained: 2901KB > 64KB`, on a
  loop retaining ~1.5MB (probe PG-K). llms.txt says "--expose-gc is
  required"; only the prose said so.
- PG-14. runGate's doc comment promises exit codes 0/1/2. It sets none:
  `process.exitCode` is undefined after a detector-validation failure,
  and the return value distinguishes "detector broken" from "allocation
  found" only by `results.length === 0` (probe PG-J).

## The six policies

### 1. Thresholds throw at config time

A threshold value is caller-authored data on a cold path, so a bad one
is a caller bug and gets a throw, not a verdict:

    maxScavenges    finite number >= 0
    maxRetainedKB   finite number >= 0
    counters[key]   finite number

TypeError for the wrong type, RangeError for the wrong value, both
prefixed `lite-perf-gate: <where>: ` and both naming the field and the
offending value. Precedent: lite-gc-profiler throws on bad rule values
on its ops/frames lanes; a budget you cannot compare against is not a
budget.

Why counter maxima are finite-only and NOT required >= 0: suiteGate
delegates every per-budget comparison to verdict() by packing
`{[name]: budget.max}` into `thresholds.counters`, and an SPP budget
whose max is negative (a metric that must shrink) is legitimate and is
accepted by suiteGate today (`typeof max === 'number' && isFinite(max)`,
PerfGate.js). Forcing >= 0 on the counters lane would break the one
comparison authority for a rule that buys nothing: negative is a
meaningful bound, NaN is not. Scavenge counts and retained kilobytes
cannot be negative in any universe, so those two keep the >= 0 clause.

### 2. A NaN measurement FAILS; it does not throw

    '<signal>: not a number (fail closed)'

emitted for `scavenges`, for `retained`, and for any counter delta whose
measured value is NaN or not a number (undefined, null, string and NaN
all land here -- one reason string, because to a gate they are one fact:
the instrument did not produce a number). A NaN measurement is evidence
of a broken instrument, never of a clean hot path. The full non-finite
door (Infinity/-Infinity reduced values) lands with P4's record doors
(PG-06); until then such values are unreachable from suiteGate's
reducers.

Why fail and not throw: measured values arrive from the instrument, not
from the caller. A throw would abort the whole suite on one bad
scenario and lose every other verdict in the run; a FAIL names the
signal, keeps the run going, and is already the vocabulary the consumer
reads. Thresholds throw (caller bug); measurements fail (instrument
bug). That split is the whole of policies 1 and 2.

Only GATED signals are checked. minorLo, majorLo/majorHi and
retainedKB_lo are diagnostics in v1.4.0 and are never NaN-gated, so
hand-built results carrying only the three gated fields -- which is what
suiteGate passes to verdict() per budget -- keep working unchanged.

### 3. Unknown counter keys and absent counters FAIL at verdict time

    '<key>: no such counter measured (statsOf keys: a, b, c)'
    '<key>: no such counter measured (statsOf keys: none)'

and, when thresholds name counters but the result has
`counters_hi === null` (the scenario has no statsOf at all), ONE reason
naming every orphaned key:

    'counters: thresholds set (k1, k2) but the scenario measured no
     counters -- add statsOf (fail closed)'

Why fail-at-verdict rather than throw-at-config, where
lite-gc-profiler's v1.10+ unknown-rule-keys door throws: counter names
do not exist until a scenario's statsOf has run. gc-profiler knows its
rule namespace statically; this package cannot know a consumer's engine
counters before measuring, so config time has nothing to compare
against. Verdict time is the FIRST moment the question is answerable,
and answering it there is strictly better than the status quo, where it
is never answered. The spirit is identical: a threshold that matches
nothing is a failure, never a pass.

One reason for the null case, not one per key: the fact is singular (the
scenario has no statsOf) and repeating it per key would bury the other
reasons in the same report.

### 4. Missing --expose-gc throws; allowNoGc trades the retained signal
   away entirely (shape A)

measure() throws at entry when `typeof globalThis.gc !== 'function'`,
with the exact run command in the message:

    Run: node --expose-gc --max-semi-space-size=4 <entry>

zgcSuite and runGate inherit the throw through measure(). The escape
hatch is `allowNoGc: true`, accepted in measure options and in
GateConfig, strictly boolean.

Under allowNoGc:
  - the result carries `retainedReliable: false` (measure() always
    stamps this field: true when globalThis.gc is a function);
  - verdict() does NOT apply the retained rule at all -- the DEFAULT
    64KB threshold included -- and emits no retained reason;
  - `retainedKB_lo` / `retainedKB_hi` stay on the result as diagnostics;
  - scavenges and counters gate exactly as before;
  - `allowNoGc: true` together with an EXPLICIT maxRetainedKB throws:
    'retained is ungateable without --expose-gc'. zgcSuite and runGate
    raise it at config time, before a single iteration runs; verdict()
    raises the same message when handed `thresholds.maxRetainedKB !==
    undefined` and a result with `retainedReliable === false`, which is
    the only way a direct verdict() caller could otherwise slip past the
    config door. zgcSuite/runGate therefore pass
    `maxRetainedKB: undefined` into thresholds when allowNoGc is set --
    they have already thrown if it was explicit.

Rationale, from the PG-11 probe: without gc(), the retained delta is not
a weak signal, it is a DIFFERENT signal -- it measures uncollected
garbage. The probe's spurious FAIL reported 2901KB against a loop
retaining ~1.5MB. A caller who writes `allowNoGc: true` has explicitly
traded that instrument away; gating on it anyway would judge noise.

allowNoGc ungates retained only when the instrument is actually missing
(retainedReliable false); with --expose-gc present, allowNoGc is inert
and the retained rule gates normally.

`retainedReliable === false` is the only unreliable state; an ABSENT
field means reliable. Hand-built results (suiteGate's per-budget
delegation, consumer fixtures, this package's own self-tests) omit the
field, and treating absence as unreliable would silently disable the
retained rule for every one of them -- fail-open through a fail-closed
door. Only measure() sets the flag, and it only ever sets it false when
it knows the instrument was missing.

REJECTED, shape B: keep the default retained rule under allowNoGc and
fail it with an 'unreliable' reason whenever retainedReliable is false.
This makes the escape hatch useless -- every allowNoGc run is red before
it measures anything -- so callers would work around it by raising
maxRetainedKB to Infinity, which policy 1 now forbids, or by not using
the gate. An escape hatch that cannot be taken is a wall with a sign on
it.

REJECTED, shape C (not in the brief, recorded so it is not
re-litigated): auto-enable allowNoGc when gc is missing, with a warning
on stderr. A warning in CI output is a line nobody reads; the whole
finding is that the run LOOKED instrumented. Fail closed means the
caller types the words.

### 5. runGate reports a code; the runner owns the exit

GateResult gains `code: 0 | 1 | 2`:

    0  pass
    1  a scenario failed, or a mustFail scenario was NOT caught
    2  detector validation failed

`passed === (code === 0)` is an invariant, asserted by test. runGate
NEVER touches process.exitCode -- suite law, ROADMAP section 1 item 4:
runner semantics stay in the runner layer, as suiteGate already
documents in its header. The docstring is rewritten from "Exit codes:
0 = pass, ..." to "Returns { passed, code, results }; map result.code to
your exit code: `process.exit((await runGate(cfg)).code)`", and the
CHANGELOG corrects the old 0/1/2 wording where it repeated the claim.

Why the missed-mustFail case is 1 and not 2: a mustFail scenario the
gate did not catch is a statement about the SCENARIO corpus, not about
the instrument -- the controls validated, or the run would have returned
2 before any scenario executed. Code 2 means one thing only: this
process could not be trusted to judge anything.

The field is additive. Nothing in this repo asserts an exact key set of
the runGate return (verified: test/self.test.mjs reads `out.passed`,
test/torture/fixtures/t1a-rungate.mjs reads `out.passed` and
`out.results.length`), and toNDJSON never serialises a GateResult.

### 6. The empty gate throws, unless it says it meant to

zgcSuite and runGate throw when `scenarios` is missing, not an array, or
empty -- unless `allowEmpty: true` is passed:

    'scenarios must be a non-empty array -- pass allowEmpty: true for a
     controls-only detector smoke run.'

allowEmpty exists for exactly one use: running the detector's own
validation with nothing to gate. The torture suite's T1a child is that
consumer -- it spawns runGate at library defaults purely to prove the
detector self-validates in a bare process (the PG-01 regression net) --
and its JSDoc says so. With allowEmpty and zero scenarios, zgcSuite
names the reduced job in the test title:

    'perf-gate: detector validation only (allowEmpty, 0 scenarios)'

and runGate's summary prints 'detector only (allowEmpty, 0 scenarios
gated)' instead of the PG-08 rubber stamp 'PASS -- 0/0 scenarios'.

## The one door

One function, `validateGate(where, cfg, scenario)`, called by measure,
verdict, zgcSuite and runGate. No bypass parameter: an internal "already
validated" flag is a door with a key under the mat, and the four call
sites are all cold.

It is called TWICE per suite scenario -- once by zgcSuite/runGate on the
config, once by the measure() it delegates to -- and once per budget by
suiteGate's post-reduction verdict() loop. That is deliberate and
recorded: measure() and verdict() are PUBLIC entries and must be sound
when called directly, the cost is O(number of fields) plain typeof and
Number.isInteger comparisons on paths that then sleep for flushMs
milliseconds and force four full collections, and suiteGate's `visit`
-- the package's only hot body -- gains zero instructions, as does
meterOnce's measurement window (the gc door sits at measure()'s entry,
outside it; `meterOnce` and `gc2` are byte-identical in this release).

## Rejected: an `inconclusive` third verdict

Raised again by policies 2 and 4 -- "cannot measure" is genuinely
neither pass nor fail. It stays rejected, per the standing rejection
ledger, ROADMAP.md section 6: gc-profiler's three-verdict system fits a
diagnostic tool, while a CI gate is binary by job description. The doors
above convert "cannot measure" into a LOUD refusal -- a throw at config
time, or a named FAIL at verdict time -- which is strictly stricter than
inconclusive, and avoids three-state plumbing in every consumer's
assert. A caller who wants the inconclusive lane already has one:
@zakkster/lite-gc-profiler, whose boundary this package does not cross.

## Consequences for existing consumers

- `runGate({scenarios: []})` now throws. Two intra-repo consumers are
  affected and both are detector smoke runs that gain
  `allowEmpty: true`: test/torture/fixtures/t1a-rungate.mjs (the T1a
  child) and the bare-child sabotage case in test/self.test.mjs. t1a is
  thereby also the torture-side proof of the new option.
- `flushMs: 0` used to mean 100ms and now means zero wait. A consumer
  who passed 0 expecting the default will see the observer buffer read
  immediately and may report fewer scavenges. Documented as Changed in
  the CHANGELOG; the option was unusable before by construction.
- `k: 1` and fractional k now throw. No intra-repo consumer uses them;
  the lowest k in this repo is 2 (test/self.test.mjs measure-shape and
  counter-delta cases, test/torture.mjs T5 soak), which is the new floor
  and is unaffected.
- A scenario missing `name`/`setup`/`hot`, or carrying a non-function
  `statsOf`/`teardown`, now throws at config time naming its position
  (`scenarios[2]`, `mustFail[0]`, `positiveControl`).
- suiteGate sources that reduce to NaN now produce
  '<budget>: not a number (fail closed)' instead of a silent pass. That
  is a down payment on PG-06; the record doors themselves are P4.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
