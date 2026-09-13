# 0003 -- Closing the allocation bypasses: old-gen and external signals,
        chosen from a GC-kind census, not from a guess

Status: accepted
Date: 2026-09-13
Session: P3 (v1.5.0)
Findings: PG-02 (S1), PG-03a (S1), PG-03b (S1)
Measured on: darwin 25.6.0, Node v26.3.1, npm 12.0.2, flags
`--expose-gc --max-semi-space-size=4`. Every number below is pasted
verbatim from `test/probes/census-0003.mjs` (repo-only, never shipped);
the corpus stage was run THREE times and the ambient stage once (100
reps x 2 scenarios). Where three runs agreed to the unit, one value is
shown; the two cells that jittered are shown as a set.

## The problem

- PG-02. `verdict()` never reads `majorLo`/`majorHi`, so allocation that
  skips the young generation is invisible. A hot loop building a 600KB
  string per iteration (large-object space) churned ~2.4GB through the
  heap inside one `measure()`: `minorHi=2, majorHi=0`, `verdict().pass
  === true` with default thresholds. The measurement records majors; the
  judgment ignores them.
- PG-03a. Transient external memory is invisible: 512KB `Float64Array`
  per iteration, ~2.1GB external churn -> `minorHi=1, majorHi=1`, PASS.
- PG-03b. Retained external memory is invisible: a pool holding 16MB of
  buffers -> `retainedKB_hi=4.6` (threshold 64) because `heapUsed`
  excludes backing stores, PASS, while `memoryUsage().arrayBuffers` grew
  16.0MB. The exact blind spot lite-gc-profiler gates with
  `maxArrayBuffersGrowth`; the gate here had no rule that could see it.

Boundary law (BRIEF): this is GATE HARDENING, not profiler creep. New
signals speak the same one-line verdict vocabulary; no GC-kind breakdown
on `MeasureResult` beyond the two counter fields; every new failure
message ends with "diagnose with @zakkster/lite-gc-profiler".

## The census

The probe re-implements `meterOnce`'s pass structure around a raw
`PerformanceObserver` and classifies every 'gc' entry by kind, flags and
timing (before-open / in-window / after-close), then reopens a second
observer around the settle `gc2()`. The corpus is pinned to the ROADMAP
reproductions: C1 = 600KB-string LO churn (PG-02), C2 = 512KB
Float64Array churn (PG-03a), C3 = 16MB retained ArrayBuffer pool
(PG-03b), C4 = the ring positive control, C5 = pure-arithmetic negative
control, C6a/C6b = two 256KB-string `controlLarge` candidates.

### Corpus, in-window GC kinds (hi pass = k*N), 3 runs

The four kind counts are the observer tally BETWEEN observer-open and
observer-close; `oldGen = major + incremental`; `settleTot` is the total
'gc' entries during the settle `gc2()`; `abKB` and `retKB` are the
`memoryUsage()` deltas at the two OUTSIDE-window capture points.

| scenario (hi) | minor | major | incr | weakcb | oldGen | settleTot | abKB | retKB | afterClose |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 600KB LO string | 2 | 0 | 0 | 0 | **0** | 2 | 0 | 46 | 0 |
| C2 512KB Float64 churn | 1 | 1 | 1 | 0 | **2** | 2 | 0 | 25 | 1 |
| C3 16MB AB pool | 0 | 0 | 0 | 0 | **0** | 2 | **16384** | 43 | 0 |
| C4 ring control | 43 | 0 | 0 | 0 | 0 | 2 | 0 | 21 | 1 |
| C5 arithmetic | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 16 | 0 |
| C6a str 1/2048 | 0 | 0 | 0 | 0 | **0** | 2 | **0** | 21 | 0 |
| C6b str 1/1024 | 0 | 0 | 0 | 0 | **0** | 2 | **0** | 16-21 | 0 |

Every cell above was identical across all three corpus runs except C6b
`retKB` (14.7 / 21.3 / 21.0 -- heap noise, ungated). C2 flags histogram:
`{minor/0:1, incremental/0:1, major/40:1}`; its one `afterClose` entry is
the `major/40` landing inside the 100ms flush sleep (so `flushMs: 0`
would drop it -- recorded for the risk ledger). All settle passes read
`{major/4:2}` -- the two forced full collections of `gc2()`, the same
baseline for every scenario including C5.

### Corpus, lo pass (N), for completeness

| scenario (lo) | minor | major | incr | oldGen | abKB |
| --- | --- | --- | --- | --- | --- |
| C1 | 0 | 0 | 0 | 0 | 0 |
| C2 | 1 | 1 | 1 | 2 | 0 |
| C3 | 0 | 0 | 0 | 0 | 2048 |
| C4 | 5 | 0 | 0 | 0 | 0 |
| C5 | 0 | 0 | 0 | 0 | 0 |

### Ambient, 100 reps of C4/C5 at hi (k*N = 1.6M), library flush

min / p50 / p95 / max, plus the two hard maxima the defaults answer to.

| scenario | minor | oldGen | settleTot | abKB | retKB | maxPauseMs | maxOldGen | maxAbKB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C4 ring | 21/21/43/86 | 0/0/0/0 | 2/2/2/2 | 0/0/0/0 | -189/18/25/54 | .046/.091/.153/.267 | **0** | **0** |
| C5 arith | 0/0/0/0 | 0/0/0/0 | 2/2/2/2 | 0/0/0/0 | 14/15/16/25 | 0/0/0/0 | **0** | **0** |

Across 200 measured reps, `oldGen` was 0 every time and `arrayBuffersKB`
was 0 every time. The zero-spurious-failure question for `maxOldGen: 0`
and `maxArrayBuffersKB: 64` is answered directly: 0 of 200 reps exceed
either default. The defaults do NOT move.

### controlLarge candidates, real instrument at {N:200000,k:8}

The census `controlLarge` string candidates trip nothing, so the shape
was re-measured with the actual `measure()` (see below, Axis D). An
accumulating mask-gated 64KB-ArrayBuffer pool at 1/131072 reads
`arrayBuffersKB_hi = 832` (6/6, deterministic), `oldGenHi = 0`, ~200ms --
13x the 64KB gate (larger pools poison the next measurement regardless of
size, so the shape is small + measured last; see "controlLarge residue").
The Float64Array oldGen control at defaults reads `oldGenHi =
2944/2744/2822` (jitter ~7%), `minorHi 11840`, one measure 2730ms.

## The branch taken (each names the census cell that decided it)

### Axis A -- event-class counter: **A4** (not the expected A2)

C1 hi in-window `major=0, incremental=0` -> `oldGen=0`, identical across
3 runs. A2 requires `major + incremental >= 4`; it is 0, so A2 is
impossible. A3 requires `settleTotal(C1) > settleTotal(C5) + 1`; both are
2, so the deferred-collection settle window does NOT distinguish C1 from
baseline either. The only nonzero in-window kind for C1 is `minor=2`,
which belongs to the EXISTING scavenge lane and equals the default
`maxScavenges` (2), so the scavenge lane cannot catch it either. On this
Node, 2.4GB of large-object string churn fires NO countable GC event that
any lane can gate. That is A4: `oldGen = major + incremental` still ships
as `oldGenLo/oldGenHi` and still gates (`maxOldGen` default 0), and it
DOES catch C2 (below) -- but **C1 is a documented, measured hole**. The
scavenge counter drops nothing new; V8 v26 serves LO string churn without
promoting, marking, or scavenging in a way the observer can see. No
invented signal. Torture T3's t3a asserts C1's measured signature (the
hole); the CHANGELOG repeats it.

The field NAME `oldGen` is fixed; only its composition (`major +
incremental`) is set by the data. WEAKCB is counted by `makeGcCounter`
but never summed into it.

### Axis B -- external lane: **B1**

C2 hi `oldGen=2 > maxOldGen(0)` -- caught by the old-gen lane (its 512KB
Float64Array backing stores are transient and already collected at the
two outside-window capture points, so `arrayBuffersKB=0`; the collection
work itself is the major+incremental the observer sees in-window). C3 hi
`arrayBuffersKB=16384 > maxArrayBuffersKB(64)` while `retKB=43 < 64` --
caught by the external lane, invisible to retained, the exact PG-03b
inversion. So both new signals earn their keep on different bypasses:
oldGen catches C2, arrayBuffers catches C3. `arrayBuffersKB_lo/_hi` are
captured at the SAME two `memoryUsage()` points as `heapUsed`, outside
the window (zero in-window instructions), and inherit P2 policy 4: under
`retainedReliable === false` the arrayBuffers rule is not applied, and
`allowNoGc: true` with an explicit `maxArrayBuffersKB` throws
(`NO_ARRAYBUFFERS`, mirroring `NO_RETAINED`).

### Axis C -- absolute, not scaling

Scaling would need ambient C4/C5 `oldGen.p95 > 0`; both are 0. A scaling
lane on a signal that is 0-or-1-or-2 is noise amplification. Absolute:
`oldGenHi > maxOldGen`, `arrayBuffersKB_hi > maxArrayBuffersKB`.

### Axis D -- controlLarge placement: **adapted D1** (deviation, census-forced)

The pasted D-axis is oldGen-centric and assumed a 256KB-string
`controlLarge` would trip `oldGenHi >= 4`. The census falsifies both
premises:

1. C6a and C6b (the two string candidates) trip `oldGen=0` AND
   `arrayBuffers=0` -- they are not controls for any new signal. D1/D2
   (which need `oldGenHi >= 4`) are therefore impossible; the string
   `controlLarge` is dead.
2. The only cheap way to fire `oldGen >= 4` is a Float64Array churn, and
   at suite defaults it costs 2730ms (over Axis D's 2000ms ceiling) and
   jitters 2744..2944 -- a per-run oldGen FLOOR would be exactly the
   noise amplification Axis C rejects.
3. A mask-gated ACCUMULATING 64KB-ArrayBuffer pool (1/131072) reads
   `arrayBuffersKB_hi = 832` deterministically (6/6), `oldGen=0`,
   in ~200ms -- cheap, deterministic, always-on-affordable.

So `controlLarge` validates the EXTERNAL lane, not the oldGen lane, and
the `validateDetector` clause is `!(large.arrayBuffersKB_hi >=
CONTROL_LARGE_FLOOR)` with `CONTROL_LARGE_FLOOR = floor(832 / 3) =
277` (3x margin under the reading, 4x over the default threshold, so
the same measurement both validates the detector and demonstrates the
gate catches it). Placement is D1: measured ALWAYS in `zgcSuite` and
`runGate` detector validation, at the PINNED window `{N:200000, k:8}` so
the control's evidence does not get cheaper when a consumer lowers N
(decisions/0001's principle). It is the third argument to the ONE
`validateDetector(pos, neg, large, maxScav)` predicate -- one predicate,
both call sites, no fork, no skip flag; a `largeControl` config override
(symmetric with positive/negativeControl, shape-checked by `validateGate`)
lets the detector-integrity self-test swap in a zero-alloc control.

The oldGen lane's detector integrity is therefore split, honestly, across
tiers: the NEGATIVE-control old-gen clause (below) proves no false
positive, and torture T3's must-catch C2 fixture plus the zero-signal
sabotage lane prove the true positive and that it is load-bearing. A
per-run oldGen floor was rejected as noise (point 2).

#### controlLarge residue (mechanism, measured)

A retained ArrayBuffer pool shows the delta only by growing external
memory across the window, and that leaves a residue that poisons the NEXT
scavenge-gated measurement: in `runGate`'s sequential control order, the
following pure-arithmetic measurement read `minorHi = 12` where it should
read 0. Two hypotheses fit that symptom, and they are distinguishable by
each spurious entry's `startTime` relative to the poisoned window:

- H-a: V8 external-pressure scavenge SCHEDULING lingers -- the entries
  genuinely START inside the new window.
- H-b: LATE DELIVERY -- the large pass's own 'gc' entries arrive
  asynchronously after the next observer opens, so their `startTime`
  PRECEDES the new window's open (old entries counted late).

A census-style raw observer recording per-entry `startTime` against the
window open/close, looped until a failing rep was caught, settled it.
Three caught reps, every one identical in shape:

    POISONED minor=6 | window open..close dur=19.9ms
      entries BEFORE open (late-delivered): 0
      entries IN window: 6 -> minor@3.6 minor@7.0 minor@10.2 minor@13.4 minor@16.5 minor@19.5
      entries AFTER close: 0

**H-a confirmed, H-b falsified.** All six spurious scavenges START inside
the ~20ms window, evenly ~3.3ms apart, zero delivered late. These are
genuine V8-scheduled scavenges driven by the external-memory accounting
the large pass bumped -- not uncollected garbage, and not a delivery-queue
artifact.

The fix followed the mechanism, not a guess:

1. Forcing collections does NOT help -- it makes it WORSE. Draining N
   rounds of `gc()`+tick after `controlLarge`, cold process, 10 reps
   each: N=8 -> 3/10 poisoned, N=20 -> 8/10, N=40 -> 9/10. The
   "wait until `arrayBuffers` returns to baseline" barrier is inapplicable
   -- `arrayBuffers` is ALREADY at baseline after one gc (the pool frees);
   the residue is scheduler state, not live memory.
2. No pool size is immune: 6.3MB poisoned 3/24, and even 256KB poisoned
   2/50, in a warm loop. Cold single-shot processes poisoned ~33%.
3. The residue is FORWARD-ONLY -- it affects the next scavenge-gated
   measurement, nothing measured earlier. So the fix is ORDERING:
   `controlLarge` is measured AFTER every scavenge-gated pass. `runGate`
   measures pos/neg, all scenarios and all must-fail cases, THEN
   `controlLarge`, THEN validates (still returning code 2 / results:[] if
   the instrument is broken). `zgcSuite` already measures `controlLarge`
   last inside its detector `node:test` block, whose block boundary
   dissipates the residue before the first scenario test -- verified
   green 15/15, and `npm test` green 20/20 after the reorder.

Kept regardless: the pool is small (1/131072, 832KB -- a smaller blast
radius and still 13x the gate) and `controlLarge.teardown()` drops it
(self-documenting; travels with a `largeControl` override). `meterOnce`,
`gc2`, and the measurement window are byte-identical to v1.4.0; the fix is
statement ordering in `runGate` plus the shared `measureLargeControl`
helper, no new hot-path code.

### WEAKCB policy -- counted, never gated

`makeGcCounter` tallies `c.weakcb` (census/back-compat only); it is never
summed into `oldGen`, never a `MeasureResult` field, never gated. The
reverse trigger (C5 ambient `weakcb.max === 0` AND C1 `weakcb > 0`) is
NOT met: C1 `weakcb = 0` too. FinalizationRegistry cleanup is ambient and
consumer-independent; gating it would fail suites for their dependencies'
teardown.

### Negative-control clause -- added

Ambient C5 `oldGen.max === 0` AND `arrayBuffersKB.max === 0` (<= 0.5), so
`validateDetector` gains `if (!(neg.oldGenHi <= 0))` -- a nonzero old-gen
count on the pure-arithmetic control means a noisy instrument, not a
clean hot path, and the oldgen lane refuses to judge on it. No
arrayBuffers negative clause was added: the arrayBuffers lane's negative
evidence is the same neg control reading `arrayBuffersKB=0`, and the
positive control (`controlLarge`) is the load-bearing one there.

### In-process control noise (self-test robustness, distinct from the residue)

A SECOND, separate flake surfaced during P3 verification and is recorded
so it is not confused with the controlLarge residue: the self-test
`negative control forces ~0 scavenges` (`measure(controlNegative)` judged
`minorHi <= 2`) failed ~5% of full `npm test` runs -- HEAD 0/65, P3
~5/110, so P3's added test load amplified a latent HEAD flake. Mechanism,
by the same startTime instrumentation used above: the spurious scavenge
STARTS in-window or during the async flush sleep (H-a, not late delivery),
and it is INJECTED BY THE `node --test` RUNNER -- it never reproduces in a
bare loop (0/40 across positive-pressure and barrier variants), only under
the runner. Isolated it (2-test mini file) is clean 0/40; add
event-loop-blocking `spawnSync` tests (as the real suite has) and it
returns (~1/30), so the trigger is another test's synchronous stall
landing in this measurement's open flush window. Fixes that FAILED,
recorded so they are not retried: a bare child (cold-start JIT/alloc noise
made it WORSE, ~25%); `--test-concurrency=1` (no effect, 2/30); a library
gc-drain barrier (the noise is external to the library -- 0/40 in bare
loops -- so no seam barrier can suppress it). The fix that holds, with no
loosening of the `<= 2` bound: BEST-OF-3 -- the negative control's true
value is 0, so a transient runner stall clears on retry while a genuinely
allocating control fails all three attempts. Verified 80/80 full `npm
test` runs. `positiveControl` (`minorHi > 3`) is unaffected because the
noise only ADDS scavenges; authoritative negative-control validation
remains torture T1c's bare child. `controlLarge`'s residue (above) is a
DIFFERENT mechanism (V8 external pressure, reproducible in bare loops)
with a different fix (ordering) -- the two must not be conflated.

## Rejected shapes

- In-window `memoryUsage()` sampling for the external delta: violates the
  zero-in-window-instructions law. Both captures reuse the existing
  before/after points, outside the counting window.
- A GC-kind breakdown on `MeasureResult` (per-kind minor/major/incr/weak):
  boundary law -- the kind census lives in this record, not the API. Only
  `oldGenLo/_Hi` (one composed counter) and `arrayBuffersKB_lo/_hi` ship.
- A scaling lane on old-gen (Axis C): a 0-or-2 signal does not scale;
  scaling would manufacture reasons from noise.
- Gating WEAKCB: it is dependency teardown, not the consumer's hot path.
- A per-run oldGen detector floor (the pasted Axis-D clause): 2730ms and
  ~7% jitter; replaced by the deterministic arrayBuffers control plus the
  T3 oldGen must-catch.

## Consequences for existing consumers

- New defaults CAN fail a previously-green suite -- exactly when a hot
  path fires an old-gen collection (`maxOldGen: 0`) or grows external
  memory past 64KB (`maxArrayBuffersKB: 64`). That is the release: the
  gate now sees PG-03a and PG-03b. The census (0/200 ambient reps) is the
  evidence that a genuinely zero-alloc path does not trip either.
- C1's 600KB-string LO churn (PG-02) is NOT caught on Node v26.3.1 and is
  recorded as a documented hole; T3 asserts its signature so a future
  Node that DOES fire an old-gen event on it will flip t3a to caught and
  the fixture will tell us.
- `MeasureResult` gains `oldGenLo/_Hi` and `arrayBuffersKB_lo/_hi`
  (additive; no existing key changes). `toNDJSON`'s measure line carries
  them. Hand-built results without the fields (suiteGate's per-budget
  `verdict()` call) are gated on field presence and keep passing.
- `allowNoGc: true` with an explicit `maxArrayBuffersKB` now throws, the
  same door as `maxRetainedKB`.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
