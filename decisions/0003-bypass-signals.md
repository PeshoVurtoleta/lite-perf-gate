# 0003 -- Closing the allocation bypasses: old-gen and external signals,
        chosen from a GC-kind census, not from a guess

Status: accepted
Date: 2026-09-13
Session: P3 (v1.5.0 interim target; shipped in the consolidated 1.4.0 release -- the interim number was never published)
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

> Withdrawn in part 2026-10-04: the C1 fixture stored a cons-rope, not a
> 600KB string, so "C1 is a documented hole" below is a fixture artifact.
> Flattened, PG-02 is caught by the scavenge AND old-gen lanes on Node 22
> and 26. The oldGen composition (`major + incremental`) and the C2 catch
> stand. See "Amendment (2026-10-04) -- PG-02 re-census" at the end.

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

   (Point 1's premise is corrected by the PG-02 re-census amendment: C6a/C6b
   stored cons-ropes. Flattened they DO fire old-gen, but 2..4 on a clean
   heap and 0 under 128MB of unrelated heap on Node 26 -- the string
   `controlLarge` stays dead, for that reason.)

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
  the fixture will tell us. (Withdrawn 2026-10-04 -- C1 was a cons-rope;
  flat PG-02 is caught. See the PG-02 re-census amendment.)
- `MeasureResult` gains `oldGenLo/_Hi` and `arrayBuffersKB_lo/_hi`
  (additive; no existing key changes). `toNDJSON`'s measure line carries
  them. Hand-built results without the fields (suiteGate's per-budget
  `verdict()` call) are gated on field presence and keep passing.
- `allowNoGc: true` with an explicit `maxArrayBuffersKB` now throws, the
  same door as `maxRetainedKB`.

## Amendment (2026-10-04) -- Node 22: C2 is not an old-gen fixture there; T3b widened to a 64-slot ring

Trigger: `npm run torture` failed T3b on Node v22.23.3 (pass on v26.8.2), at
1.4.2 HEAD and at 1.4.3: `T3b C2 ... pass=false oldGenHi=0 reasons=["scavenges:
84 > 2"]`. The gate still CAUGHT C2 -- through the scavenge lane, not the
old-gen lane T3b asserts. T3b is the oldGen lane's only true-positive proof
(Axis D: "torture T3's must-catch C2 fixture ... prove the true positive"), so
on Node 22 that lane was unproven. Measured on darwin 27.0.0, Node v22.23.3 and
v26.8.2, flags `--expose-gc --max-semi-space-size=4`, bare children.

### Census, same method and probe (`PGC_MODE=corpus`, 3 runs per Node)

| scenario (hi) | Node | minor | major | incr | oldGen | abKB |
| --- | --- | --- | --- | --- | --- | --- |
| C2 512KB Float64 churn, 16-slot ring | 26.8.2 | 1 | 1 | 1 | **2** | 0 |
| C2 512KB Float64 churn, 16-slot ring | 22.23.3 | **84** | 0 | 0 | **0** | 0 |

Identical in all 3 runs on each Node. Every other corpus row (C1, C3, C4, C5,
C6a/b) has the same kind signature on both Nodes as the original table.
Flags: Node 26 `{minor/0:1, incremental/0:1, major/40:1}` (40 = the
external-memory major, as recorded above); Node 22 `{minor/0:84}`.

Mechanism (measured counts; reading): Node 22 runs a scavenge about every 49
buffer allocations (4096 / 84). A buffer that is dead within 16 allocations
never survives a scavenge, so it never promotes, and the external churn is
reclaimed entirely by the young generation. Node 26 does not scavenge on it
and instead fires one external-memory major. The 16-slot C2 is NOT a bypass
on Node 22 -- the scavenge lane already catches it -- but it is also not an
old-gen fixture there.

### The 16-slot ring is heap-state noise on Node 22, not a signal

Real `measure()` at the pinned window, bare child, C2 16-slot ring, with N MB of
unrelated retained old-space ballast allocated first:

| ballast | 0 | 2MB | 4MB | 6MB | 8MB |
| --- | --- | --- | --- | --- | --- |
| Node 22 oldGenHi | 0 | 0 | 2 | 2 | 2 |
| Node 26 oldGenHi | 2 | 2 | 2 | 2 | 2 |

The same 0 -> 2 flip appeared with an import-time probe that allocated other
candidates' rings, and once in a raw-observer pass (`major/40` in-window at
ring 16 on Node 22). On Node 22 a C2 old-gen reading depends on the
surrounding heap, so it cannot be a must-catch.

### Ring-size sweep (real `measure()`, 3 reps per cell, effective live slots)

| live slots (x 512KB) | 16 | 32 | 64 | 128 |
| --- | --- | --- | --- | --- |
| Node 22 oldGenHi | 0 | 2 / 10 / 16 (unstable) | 36..42 | 40..42 |
| Node 26 oldGenHi | 2 | 2 | 2 | 2 |

At 64 slots every buffer outlives at least one scavenge (64 > ~49), promotes,
and dies in old space. Node 22's flags then read `{minor/0:85, incremental/0:20,
major/0:20}` -- ordinary incremental-marking majors, not forced and not the
external-memory flag. 64 is 2x the unstable boundary; 128 adds no signal and
doubles the transient live set (64MB), so 64 was chosen.

### The fix: T3b's fixture ring 16 -> 64; the assertion is unchanged

`t3b-ab-churn.mjs` keeps the size (512KB Float64Array), the pinned window
(N=512 k=8, ~2.1GB churn) and default thresholds, and changes only the ring
(16 -> 64 slots, a 32MB transient live set). `t3-bypass.mjs`'s assertion
(`pass === false` and an `oldgen:` reason) is byte-identical. Evidence:

- Real `measure()`, bare child, HEAD `PerfGate.js`, 20 reps per Node: Node 22
  `oldGenHi 30..56`, `minorHi 63..112`, caught by oldgen 20/20 (oldgen AND
  scavenges); Node 26 `oldGenHi 2`, `minorHi 1`, caught 20/20 with `oldgen:`
  as the ONLY reason (the PG-03a signature is unchanged on Node 26). A further
  20 reps per Node on the pre-1.4.3 library: Node 22 `38..42`, Node 26 `2`.
- Ballast 0/4/8/16/32MB at 64 slots: Node 22 `oldGenHi 40/40/42/46/56`
  (monotone up, never toward 0); Node 26 `2` throughout.
- `TORTURE_CONTROL=zero-signal`: T3 fails at T3b on BOTH Nodes (Node 22
  `reasons=["scavenges: 83 > 2"]`, Node 26 `pass=true reasons=[]`). The
  oldgen lane is load-bearing on both.
- Full `npm run torture` with the patched fixture: Node 22 T1-T5 `ok`, the
  first green Node 22 torture run.

### Negative side on Node 22 (`maxOldGen: 0` default)

Ambient stage, 100 reps each at hi (1.6M), Node v22.23.3: C4 ring `oldGen
0/0/0/0` (min/p50/p95/max), `abKB 0/0/0/0`; C5 arithmetic `oldGen 0/0/0/0`,
`abKB 0/0/0/0`. 0 of 200 reps exceed either default on Node 22 too. The
defaults do not move.

### Rejected

- A per-version T3b expectation (Node 22: "caught by scavenges"). On Node 22
  it would leave the oldGen lane with NO true-positive proof; only t3c's
  arrayBuffers catch would keep the zero-signal control failing there.
  Rejected as a weaker gate.
- Accepting any reason in T3b (`pass === false` only). That is a weakened
  assertion and would not prove the oldgen lane. Rejected.
- Other shapes that reach old-gen on both Nodes, measured and not chosen:
  flattened 600KB strings (oldGen 12..16 / 4..8, but ~530ms and a new shape);
  `new Array(65536)` churn (~1s, Node 22 6..12 jittery); mid-life
  `{x,y,z,w}` rings of 2^17/2^18 slots (oldGen 2..4 on both, but scavenges
  40..56, and one Node 26 rep pretenured to `minorHi 0`). The 64-slot C2
  keeps the PG-03a shape, the size and the window, and has the largest
  stable margin.

## Amendment (2026-10-04) -- PG-02 re-census: C1 was a cons-rope; flat PG-02 is caught

Trigger: `String.prototype.repeat` returns a cons-rope, not a flat string.
Retaining 100 x `'a'.repeat(614400)` grows `heapUsed` by ~60KB; after a
`charCodeAt` on each (which flattens) it grows by ~60003KB (Node 22.23.3 and
26.8.2). C1 (`CHARS[i & 3].repeat(614400)` into a 16-slot ring) never read its
strings, so the census, the T3a fixture and the original PG-02 probe all
measured ~20 small rope nodes per iteration -- not 600KB. Axis A4's "2.4GB
of large-object string churn fires NO countable GC event" described a
fixture that churned no large objects. Measured on darwin 27.0.0, Node
v22.23.3 and v26.8.2, flags `--expose-gc --max-semi-space-size=4`, host load
average 25..40 (other sessions running) throughout.

### What the rope and the flat string actually allocate

`v8.getHeapSpaceStatistics()` deltas, three 600KB strings retained:

| step | Node 22.23.3 | Node 26.8.2 |
| --- | --- | --- |
| `repeat(614400)` x3 | new_space +7KB | new_space +8KB |
| then `charCodeAt` x3 (flatten) | new_large_object_space +600KB, large_object_space +1200KB | same |

A rope is ~2.4KB of young nodes. C1 hi (4000 iters) is ~10MB of small young
churn: `minorHi 2`, equal to the default `maxScavenges` 2, so it passes at
the threshold edge -- correct for what it allocates. A flattened 600KB string
is allocated in YOUNG large-object space (reading: reclaimed by scavenges;
ring survivors end in old LO space and need a major) -- which is why both
lanes see it below.

### The flatten must be sunk

Ring-held heap (16 slots) after the k-th `hot(500)` call, bare process:

| variant (600KB) | Node | call 1 | 10 | 50 | 200 |
| --- | --- | --- | --- | --- | --- |
| rope (C1) | 22 / 26 | 10KB | 10KB | 10KB | 10KB |
| `t.charCodeAt(1);` unused | 22 | 9601KB | **10KB** | 10KB | 10KB |
| `t.charCodeAt(1);` unused | 26 | 9601KB | **6KB** | 9601KB | **10KB** |
| `a = (a + t.charCodeAt(..)) & 1023` (sunk) | 22 / 26 | 9600KB | 9601KB | 9601KB | 9601KB |

Unused, the optimizing tier eliminates the read and the ring silently holds
ropes again (the 256KB C6 shapes behave the same). Every flat shape below
SINKS the char code into scenario state.

### Census, same method and probe (`PGC_MODE=corpus`, 3 runs per Node)

In-window kinds at hi (k*N), from the amended `census-0003.mjs`. New rows: C1f
(flat, sunk), C1fu (flat, unsunk), C6af/C6bf (flat twins of C6a/C6b). The rope
rows reproduce the original table.

| scenario (hi) | Node | minor | oldGen | settleTot | abKB | hotMs |
| --- | --- | --- | --- | --- | --- | --- |
| C1 rope | 22 / 26 | 2 | 0 | 2 | 0 | 1..4 |
| **C1f flat 600KB** | 22 | 653..655 | **42..48** | 2 | 0 | 801..1010 |
| **C1f flat 600KB** | 26 | 41..48 | **10..12** | 2 | 0 | 257..292 |
| C1fu unsunk | 22 | 143 / 656 / **0** | 14 / 54 / **0** | 2 | 0 | 182 / 821 / **1** |
| C1fu unsunk | 26 | 40..48 | 8..14 | 2 | 0 | 257..298 |
| C6a / C6b rope | 22 / 26 | 0 | 0 | 2 | 0 | 3..6 |
| C6af flat 1/2048 | 22 | 51 | 2 | 2 | 0 | 55..77 |
| C6af flat 1/2048 | 26 | 3 | 2 | 2 | 0 | 40..41 |
| C6bf flat 1/1024 | 22 | 102..103 | 4 / 2 / 4 | 2 | 0 | 112..124 |
| C6bf flat 1/1024 | 26 | 6..7 | 2 | 2 | 0 | 54..66 |

C1f flags: `{minor/0, incremental/0, major/64}` on both Nodes (one Node 22 run
adds a `major/0`): ordinary incremental-marking majors, not the
external-memory flag 40. Lo pass C1f: Node 22 minor 80, oldGen 8..10; Node 26
minor 8..44, oldGen 2..10. The C1fu rows are the DCE trap inside the census
itself: on Node 22 the third run read minor 0, oldGen 0 in 1ms, which means no
600KB string was built at all, so an unsunk scenario can measure perfectly
clean. An earlier scratch run of the same rows (sunk read at a fixed index)
gave C1f Node 22 oldGen 72..78 and Node 26 22..46. Side reading, consistent
with the Node 22 amendment's ballast table: with C1f/C1fu run first in the
same process, the 16-slot C2 row read oldGen 0..20 on Node 22 across six runs
(heap state).

### Real `measure()` at the pinned window, bare child, defaults

The proposed T3a fixture (C1f shape, N=500 k=8), 10 reps per Node:

| Node | caught | reasons | minorHi | oldGenHi | one measure |
| --- | --- | --- | --- | --- | --- |
| 22.23.3 | 10/10 | scavenges + oldgen | 649..654 | 72..82 | 2.30..2.63s |
| 26.8.2 | 10/10 | scavenges + oldgen | 24..71 | 8..24 | 0.83..1.00s |

`TORTURE_CONTROL=zero-signal` equivalent (oldGenHi/arrayBuffersKB_hi zeroed
before the verdict, i.e. the pre-P3 verdict), 3 reps per Node: still
`pass=false` on `scavenges:` alone (Node 22 minorHi 654..655, Node 26
25..29), with no `oldgen:` reason. So the flat PG-02 shape was never a
bypass: the scavenge lane catches it with or without the P3 lanes. N=125
was measured too (Node 26 oldGenHi 2..4, too thin a margin) and rejected;
the window stays pinned at N=500.

### The old-gen catch is heap-state dependent; the scavenge catch is not

Same fixture, N MB of unrelated retained old-space ballast allocated first
(3 reps per cell, 10 at 0MB):

| ballast | 0 | 8MB | 32MB | 64MB | 128MB | 256MB |
| --- | --- | --- | --- | --- | --- | --- |
| Node 22 oldGenHi | 72..82 | 56 | 28 | 16..18 | 8..10 | 4 |
| Node 26 oldGenHi | 8..24 | 10..26 | 2..4 | 0 / 2 / 2 | **0** | **0** |
| caught (both Nodes) | yes | yes | yes | yes | yes | yes |

All 50 runs are `pass=false` through `scavenges:` (minimum minorHi 14). The
`oldgen:` reason disappears on Node 26 at >= 64MB of other heap -- a larger
heap raises the old-gen limit, so the promoted strings are not collected
inside the window. That is a property of the shape, not a defect of the lane,
and it does NOT appear in the bare-child fixture (0MB ballast).

### Axis D point 1, re-read

C6a/C6b read `oldGen=0, arrayBuffers=0` because they stored ropes; the
premise "the string candidates trip nothing" is false. Real `measure()` at the
pinned `{N:200000, k:8}` (9 reps per cell at 0MB, 3 at 32/128MB):

| candidate | Node | oldGenHi @0MB | @32MB | @128MB | minorHi | one measure |
| --- | --- | --- | --- | --- | --- | --- |
| C6af flat | 22 | 2 | 2 | 2 / 0 / 2 | 51..52 | 318..402ms |
| C6af flat | 26 | 2 | 2 | **0** | 10..52 | 250..330ms |
| C6bf flat | 22 | 4 | 2 | 2 | 102..104 | 400..490ms |
| C6bf flat | 26 | 2 | 2 | **0** | 23..104 | 260..330ms |

The conclusion -- no string `controlLarge` -- STANDS, on corrected grounds:
the flat candidates read 2 on Node 26 (below D1/D2's `oldGenHi >= 4`), and
`controlLarge` is measured inside the CONSUMER's process, whose heap size is
unknown; at 128MB of heap both read 0 on Node 26, so a floor of 1 would fail
detector validation for any large application. Point 2's "the only cheap way
to fire `oldGen >= 4` is Float64Array churn" is false on Node 22 (C6bf reads
4 in ~450ms) and true on Node 26. Point 3 and the arrayBuffers-pool
`controlLarge` (`CONTROL_LARGE_FLOOR` 277) are untouched.

### The fix

- T3a churns FLAT strings (sunk `charCodeAt` read), size 600KB, ring 16 and
  window N=500 k=8 unchanged, and asserts `pass === false` with BOTH a
  `scavenges:` and an `oldgen:` reason. It replaces the hole-signature
  assertion (which expected `pass === true`); nothing is loosened -- the
  fixture went from "must pass" to "must be caught by two lanes".
- T3a is now a second true-positive proof of the old-gen lane next to T3b,
  and `TORTURE_CONTROL=zero-signal` fails T3 at T3a on both Nodes (the
  `oldgen:` reason vanishes; measured above and in a full torture run).
- The census probe gains C1f, C1fu, C6af, C6bf; C1/C6a/C6b stay as-is so the
  original table remains reproducible.
- Docs that called C1 a documented hole (README, COOKBOOK R3, CHANGELOG,
  `PerfGate.js` comments, torture headers) are corrected. Library code, the
  defaults and every other threshold are unchanged.
- The Node 22 amendment above lists "flattened 600KB strings (oldGen
  12..16 / 4..8, but ~530ms)" under Rejected; those figures are the UNSUNK
  shape (DCE-fragile). The sunk shape reads 72..82 / 8..24 at 0.8..2.6s per
  measure. T3b's choice of the 64-slot C2 is unaffected.

### Rejected

- Keeping a rope fixture that asserts `pass === true`. It asserts a V8
  representation detail (`repeat` returns a rope), not a gate property.
- The unsunk flatten (`t.charCodeAt(1);`): DCE-fragile, measured above.
- Asserting only `oldgen:` in T3a. Both lanes fire in every clean run on
  both Nodes, and the scavenge lane is the heap-independent one.
- Lowering N for speed: N=125 reads oldGenHi 2..4 on Node 26.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
