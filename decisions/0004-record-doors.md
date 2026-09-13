# 0004 -- Record doors for suiteGate: what throws, what fails, and the
        one comparison authority minCount had to go through

Status: accepted
Date: 2026-09-13
Session: P4 (v1.6.0)
Findings: PG-06 (S1), PG-12 (S3), PG-13 (S3)
Measured on: darwin 25.6.0, Node v26.3.1, npm 12.0.2, flags
`--expose-gc --max-semi-space-size=4`. Every number in "The cost" is
pasted verbatim from `test/probes/doors-0004.mjs` (repo-only, never
shipped), run BEFORE the doors landed and again AFTER, same process
shape, same slab, same budgets.

## The problem

- PG-06. The same over-budget record reaches three different verdicts
  depending only on the CONTAINER it arrives in.
  - As a `Float64Array` slab: FAIL (correct).
  - As a `Float32Array`: PASS. `TypedArray.prototype.forEach` invokes
    `cb(value, index, array)`, so the four SPP parameters
    `(packed, t, a, b)` receive `(element, elementIndex, theArray,
    undefined)`. The selected slot is then the ARRAY OBJECT: `sum`
    becomes NaN, `val > maxv[i]` is false for every record, so `maxv`
    never leaves its `-Infinity` seed while `count` is nonzero -- and
    `value = -Infinity` passes every finite `max`. A violating stream
    reads as clean.
  - As a plain array of `[packed, t, a, b]` tuples: PASS with `count 0`.
    `Array.prototype.forEach` binds the TUPLE onto `packed`;
    `packed & 0xFFFF` on an object is 0, no budget matches, zero
    records are reduced, and "nothing matched" is reported as a pass.
  No door anywhere: `visit` never checked that `packed` is a u32 nor
  that the slots are numbers.
- PG-12. Inherited prototype keys corrupt budget validation three ways.
  `SUITE_SLOTS['toString']` is a function, not `undefined`, so
  `slot: 'toString'` is ACCEPTED and silently reads slot `b` (the
  `=== undefined` guard is the only gate). `SUITE_REDUCES['constructor']`
  likewise accepts `reduce: 'constructor'`, which then falls through
  every `else if` and behaves as `last`. And `seen = {}` inherits, so a
  budget legitimately NAMED `toString` is rejected as a duplicate on
  first sight. Same class as the blueprint's AR-04.
  Fourth instance, found while planning this session: `counters` and
  `ct` in the reduce block are `{}` literals keyed by USER-CONTROLLED
  budget names, so a budget named `__proto__` does not create an own
  property -- it invokes the `Object.prototype.__proto__` setter. The
  budget would then fail with 'not a number (fail closed)' for a
  perfectly valid measurement. Null-proto is required on those two
  objects, not merely nice.
- PG-13. `{ op: 0x0F01 }` (CONT) is accepted at config, can never match
  (`visit` skips CONT globally, by protocol), and therefore passes
  vacuously forever. The v1.1 self-test PINS this as intended behavior.
  Fail-closed says a budget that can never match is a caller bug, not a
  pass.
- The neighbor hole (no ID, the reason `minCount` exists): a budget
  whose `op` is a typo matches zero records, reduces to 0, and passes
  forever. `count: 0` is reported, and nothing in the library ever
  looks at it.

## The doors

Naming: a door that THROWS is a data-integrity refusal (the caller
handed us something we cannot read); a door that FAILS a budget is a
verdict (we read it, and it is out of budget). The split from the
BRIEF, made concrete:

| Door | Where | Lane | Outcome |
| --- | --- | --- | --- |
| D-A u32 per record | slab driver loop | hot | RangeError, record index |
| D-A' u32 per record | `visitChecked` wrapper | forEach only | RangeError, invocation index |
| D-B slot shape, every invocation | `visitChecked` | forEach only | RangeError, invocation index + slot |
| D-C typed-view dispatch | source dispatch | cold | RangeError, record 0 |
| D-D non-finite reduced value | `verdict()` counter lane | cold | FAIL, P2 reason |
| D-E CONT target | `suiteMatcher` | cold | RangeError at config |
| D-F inherited keys | null-proto tables | cold | RangeError at config |
| D-G minCount shortfall | `verdict()`, 2nd call | cold | FAIL, contract reason |

### D-A, and why it is in the LOOP and not in `visit`

`packed === packed >>> 0` rejects NaN, negatives, fractions, values
above 0xFFFFFFFF, and every object/undefined coercion in one compare.
The BRIEF's candidate put it inside `visit`. It goes in the SLAB DRIVER
LOOP instead, for one reason that is not style: `visit(packed, t, a, b)`
has no index to name, and giving it one means either a fifth parameter
(the forEach lane cannot supply it) or a per-record counter write in the
hot body. The loop already holds `r`. Putting the compare there gives
the identical per-record cost, a free `r >> 2` index computed ONLY
inside the cold thrower, and leaves `visit`'s body byte-identical to
v1.5.0 -- which is also what makes the before/after measurement below a
measurement of the door and nothing else.

### D-B / D-C, and why the Float32Array case cannot be a per-record door

Measured while planning: `spp(2, 0x0201)` is 131585, below 2**24, so it
survives a Float32Array round trip EXACTLY. Under the arity collision
the values that land in `packed` are the f32 elements themselves --
packed headers, timestamps, small slot integers -- and the great
majority of them are exact u32s. D-A therefore does NOT reliably catch
PG-06's Float32Array case; only the SHAPE of the invocation does
(`typeof a === 'object'`, `typeof b === 'undefined'`). Two doors
follow:
- D-C, cold and free: `ArrayBuffer.isView(source) && !(source instanceof
  Float64Array)` throws at dispatch, before one record is read, naming
  the view's constructor. Every typed-array-that-is-not-a-same-realm-slab
  dies here -- deterministically, regardless of the values inside.
- D-B, forEach lane, EVERY invocation: the u32 check on `packed` plus
  `typeof t/a/b === 'number'` on all three slots, on every record, not
  only record 0. This is the door for generic forEach sources (a sink
  that regressed to 3-arg callbacks, an NDJSON re-parse that yields
  tuples) which D-C cannot see -- AND for a non-native sink that is clean
  at record 0 but emits a non-number slot later. A first-invocation-only
  check was the initial design and was REJECTED at review: a slot of
  `null`/`'3'`/`true` at record N>0 finitely coerces (0 / 3 / 1) or is
  absorbed by a max reducer and passes a budget silently -- and a `null`
  slot even satisfies `minCount`, so this session's own presence
  assertion would report `pass count 2` on two `null` records. "null is
  not zero." D-D cannot close it, because the reduced value stays finite.
  The full per-invocation check is the fix; the forEach lane is not the
  T4-measured slab hot path, so it costs nothing T4 gates.
Cross-realm note: a cross-realm `Float64Array` fails `instanceof` but
`ArrayBuffer.isView` is realm-agnostic, so it is caught by D-C at
dispatch (its constructor is named `Float64Array`, from the foreign
realm) and never reaches the arity-collision forEach path. A strict
improvement on v1.5.0, recorded so it is not a surprise.
NaN edge: `typeof NaN === 'number'`, so a NaN slot PASSES D-B on both
lanes by design -- it is a number, just not a finite one. What happens
next depends on the REDUCER. Under `sum` and `mean` (and under `max` or
`last` when the NaN is the extremum or the only record), NaN propagates
into the reduced value and D-D fails it closed
(`'<name>: not a number (fail closed)'`). Under `max`, `last`, and
`count`, a NaN slot that coexists with finite records is SILENTLY
EXCLUDED -- `NaN > 5` is false, so the running max ignores it -- and the
reduced value stays finite: the budget can PASS with `count` inflated by
the NaN record and `minCount` satisfied. This is identical on the slab
lane (a `Float64Array` NaN slot behaves the same way). The typeof door
catches wrong-TYPE slots; D-D catches non-finite reduced VALUES; the gap
between them -- a NaN swallowed by a non-propagating reducer -- is the
residue recorded below.

RESIDUE, dated 2026-09-13 (NaN under non-propagating reducers): a NaN
slot coexisting with finite records under `max`, `last`, or `count`
reduces to a finite value and the budget can PASS -- `count` counts the
NaN record and `minCount` is satisfied by it -- on BOTH the slab and
forEach lanes. Accepted, not closed, for two reasons. First,
`typeof NaN === 'number'` is intended: the type door refuses wrong-TYPE
slots, and a NaN IS the number type; drawing the line at finiteness in
D-B would duplicate D-D's finiteness authority in a second place.
Second, catching it at reduction would put a per-record `isFinite` check
inside `visit`'s slab aggregation -- the one T4-measured hot body, whose
entire door budget this session is a single `!==` compare -- and would
change the pinned reduce semantics of `max`/`last`/`count` (today a NaN
is excluded from a max exactly as `-Infinity` is; making it fail the
budget would be a semantics change, not a door). Revisit if a real SPP
stream ever surfaces NaN slots: the lane to harden is then the PRODUCER
(a probe emitting NaN is the bug), or the consumer adds a `sum`/`mean`
sentinel budget over the same op, which propagates the NaN into D-D. The
residual is pinned by a canary test (`test/self.test.mjs`, the
NaN-under-max case asserting the CURRENT `pass true value 5 count 2`
signature) so a future change that closes it fails that test and forces
this ledger entry to be updated deliberately.

### The cost (T4, the measurement that decides what ships)

Preallocated 1M-record slab (`Float64Array(4_000_000)`, 32MB, allocated
once outside every measured window), 8 budgets spanning packed /
stream+op / op-only, slots t/a/b, reduces count/sum/max/mean/last.
`measureOps(fn, { ops: 8, warmup: 2, stabilize: 'deep', source: 'gc' })`,
one measurement in flight, tiers sequential. `nsPerRecord` is the p50
across 5 back-to-back reps; `bytesPerOp` settles to 0 in steady state
(the early reps carry V8 heap-accounting noise recorded in the noise
band). Per-record bytes is the min across the reps whose 1K lane did not
bracket-invert.

| Build | ns/record | opsPerSec | bytesPerOp (1M) | bytesPerOp (1K) | per-record bytes |
| --- | --- | --- | --- | --- | --- |
| v1.5.0 (no doors) | 15.5310 | 64.4 | 0 (noise to 491) | 0 (noise to 151) | 0.00000 (noise to 0.00034) |
| v1.6.0 (D-A) | 15.7637 | 63.4 | 0 (noise to 1377) | 0 (noise to 151) | 0.00000 (noise to 0.00123) |
| delta | +0.2327 | -- | 0 | -- | ~0 |

Noise band, v1.5.0 measured 5 times back to back:
15.3637 / 15.5310 / 18.0343 ns/record (min/p50/max) -- a spread of
2.6706 ns/record, dominated by the cold first rep. The door ships iff
its delta falls inside that band. SHIPPED: the p50 delta is +0.2327
ns/record and the min delta is +0.0661 ns/record, both far inside the
2.6706 ns spread -- exactly what a single `!==` compare against a
Float64Array element already in a register should cost. D-A ships per
record, in the slab driver loop.
- If it had NOT been within noise: fall back per the ROADMAP -- drop D-A
  from the slab loop, keep D-B (first record strict, both lanes, via a
  cold pre-read of `source[0..3]` on the slab lane) and rely on D-D for
  everything a corrupt later record can do to a reduction. The fallback
  is strictly weaker (a slab corrupted at record 500000 reduces to a
  non-finite value and FAILS rather than THROWS). It did not ship; the
  measurement did not charge that price.

Per-record allocation is proven by DIFFERENCE, not by `maxBytesPerOp:
0`: one `suiteGate()` call legitimately allocates its config arrays
(5 arrays of n, the perBudget objects, the result), so per-CALL zero is
not the claim and asserting it would be theater. The claim is
per-RECORD zero, and the honest estimator is
`(bytesPerOp(1M) - bytesPerOp(1K)) / (1e6 - 1e3)`, gated at
<= 0.01 B/record -- measured 0.00000 (min) with noise to 0.00123.

### The allocating-visit control, and why it must RETAIN, not just allocate

The T4 control that must FAIL is a test-code-only forEach shim standing
in for a `visit` that allocates. `measureOps` is SYNCHRONOUS: it never
yields to the event loop inside its measured window, so the perf_hooks
'gc' entries a young-generation scavenge produces are queued and never
delivered before `summary()` is read. `summary.gc.minor` therefore reads
0 no matter how much transient garbage the loop churned (verified: an
allocating shim that pushed one throwaway object per record still read
minor 0 / major 0). A heap-delta instrument is likewise blind to
transient allocation collected inside the window -- both the
`stabilize:'deep'` retained figure and the raw transient figure returned
`per-record bytes ~= 0` for a shim whose objects died within the op.

So the control does the one thing that IS measurable and is exactly the
regression a per-record allocation would be in production: it RETAINS one
object per record (pushes into a sink that survives the forced GC at each
steady boundary). Under `stabilize:'deep'` this is surviving-allocation
delta, and it is unmistakable:

| Shim | bytesPerOp (1M) | per-record bytes | checkOps(maxBytesPerOp) |
| --- | --- | --- | --- |
| legit visit | 626 (noise) | 0.00063 | pass |
| retaining visit | 128,260,490 | 128.26 | fail |

The control blows both the `maxBytesPerOp` gate and the per-record bytes
gate by five orders of magnitude, and T4 dies. This is a documented
adaptation of the BRIEF's "allocates one object per record": a purely
transient allocation is invisible to every heap-delta gate and to a
synchronous measureOps' scavenge count, so the control retains, which is
the measurable and production-meaningful form of the same defect.

### D-D -- the non-finite door lives in `verdict()`, one line

BRIEF item 1(b) asks for a reduce-time door emitting the P2 reason
format. It is implemented as a one-line widening of the counter lane's
validity predicate in `verdict()`:

    } else if (typeof actual !== 'number' || !isFinite(actual)) {
        reasons.push(key + ': not a number (fail closed)');

Why there and not in suiteGate's reduce block: any suiteGate-side check
would have to REPRODUCE the string `'<name>: not a number (fail
closed)'`, and two places that own one contract string is exactly the
duplication the one-comparison-authority law exists to prevent. Because
suiteGate feeds the reduced value through the counter lane already, the
door is reached with zero new plumbing, and it applies identically to
`statsOf` counter deltas -- an engine that reports `Infinity` growths
now reads 'not a number (fail closed)' instead of 'k: Infinity > 0'.
Both are failures; only the wording changed.

This closes the fail-open the P2 reviewer documented as
unreachable-until-P4: `-Infinity` compared against any finite max is
`false`, i.e. a pass. It is now a named failure.

Scope, deliberately narrow: the scavenges / retained / oldgen /
arrayBuffers lanes keep their exact v1.5.0 bodies (`x !== x`). Their
`-Infinity` fail-open is unreachable from `suiteGate` (hand-built
results carry literal 0s) and from `meterOnce` (counts and byte deltas
are finite by construction), and P3 pinned those lanes three sessions
ago. RESIDUE, dated 2026-09-13: a hand-built MeasureResult carrying
`minorHi: -Infinity` still passes. Not reachable through the public
measurement path; revisit if a consumer ever hand-builds results.

### D-E -- CONT is a config error

`suiteMatcher` throws for both spellings, `{op: 0x0F01}` and any
`{packed}` whose low 16 bits are 0x0F01:

    'suiteGate: budget[i] targets CONT (0x0F01): CONT records are never
     budget targets (SPP v1)'

`visit` skips CONT globally by protocol, so such a budget is a promise
the library cannot keep. Accepting it and reporting a pass is the
vacuous-green failure mode this package exists to attack. The self-test
that PINS the old behavior is rewritten this session, deliberately, and
the CHANGELOG's Changed section names it.

### D-F -- null prototypes, and own-key semantics for free

    const SUITE_REDUCES = {__proto__: null, count: 1, sum: 1, max: 1, mean: 1, last: 1};
    const SUITE_SLOTS   = {__proto__: null, t: 1, a: 2, b: 3};
    const seen          = Object.create(null);   // per call, cold
    const counters      = {__proto__: null};     // per budget, cold
    const ct            = {__proto__: null};     // per budget, cold

Null prototypes rather than `Object.prototype.hasOwnProperty.call(...)`
guards: the guard form adds a call at every lookup site and leaves the
NEXT inherited-key site (there were four) to be found by hand. A null
prototype makes the whole class impossible at the data structure, which
is where the class lives. On a null-proto object `obj['__proto__'] = v`
creates an ordinary own data property -- there is no accessor to invoke
-- which is precisely what makes a budget named `__proto__` legal end to
end, including through `toNDJSON` (`JSON.stringify` serializes the own
key; no escaping question arises -- verified against budget names
`toString`, `hasOwnProperty`, `__proto__`, `constructor`, and a name
carrying quotes and a newline).

### D-G -- minCount, and the delegation that keeps verdict max-only

`verdict()` compares `measured > limit`. A MINIMUM has no expression in
that vocabulary -- but a minimum on `count` is exactly a maximum of 0 on
the SHORTFALL, `minCount - count`. The inversion happens at the call
site; `verdict` stays monotone, max-only, and unaware that a presence
assertion exists:

    const shortfall = mc - count[i];              // negative when satisfied
    const mv = verdict(
        {name: b.name, minorHi: 0, majorHi: 0, retainedKB_hi: 0,
         counters_hi: {__proto__: null, shortfall: shortfall}},
        {counters: {__proto__: null, shortfall: 0}}
    );
    if (!mv.pass) {
        v2 = b.name + ': matched ' + count[i] + ' < minCount ' + mc;
    }

A SECOND verdict call, not a second key in the first call. The BRIEF's
candidate encoding (shortfall as an extra key alongside the value in
one call) works, but it puts a synthesized key into a namespace the
USER owns: a budget named `lat.p99` plus a synthesized `lat.p99#min`
collides the moment another budget is named `lat.p99#min`. Giving the
shortfall its own call gives it its own namespace, so the fixed
internal key `shortfall` can never alias a user name no matter what the
user names things. Cost: one extra cold `verdict()` call per
minCount-BEARING budget, zero for every budget without one (`mc === 0`
is inert and skips the call -- semantically identical, since
`0 - count <= 0` always passes).

Reason ordering is fixed and documented: value-lane reasons first (from
the first verdict call, verbatim), then the minCount reason. A budget
that is both over-max and under-count reports both, in that order.

`minCount` validation: `Number.isInteger(mc) && mc >= 0`, else
RangeError naming the budget and the value -- the same fail-closed shape
as `max`, `slot`, and `reduce`. `-1`, `1.5`, `NaN`, `'1'`, `Infinity`
all throw.

Back-compat, stated as a promise and pinned by a test: WITHOUT
`minCount`, a zero-match budget still reduces to 0, still reports
`count: 0`, and still PASSES. That is v1.1 behavior and it stays. The
presence assertion is opt-in because silence is legitimately a pass for
budgets like 'gc pauses over 8ms' -- the one case a global flag gets
wrong, which is the next rejection.

## Rejected

- **A global `requireAllMatch` flag.** Too blunt, and wrong for the
  budgets most worth writing: 'no gc pause over 8ms' is a budget whose
  correct result is zero matches. A flag makes every such budget a
  false failure, and the workaround is a per-budget exemption -- i.e.
  `minCount`, spelled worse. Per-budget from the start.
- **p95 / percentile reducers.** Standing rejection (ROADMAP section 6
  and P4 NON-GOALS), re-affirmed here with the P4 measurement in hand: a
  percentile needs a sort or a sketch, and both allocate in the one hot
  body this package has -- the same hot body whose entire door budget
  this session is one compare. `count/sum/max/mean/last` stay.
- **CONT payload decoding.** SPP v2 problem. v1 CONT records are
  continuation frames whose slot semantics are defined by the base
  record's opcode, which this package deliberately does not know (no
  lite-scope import; protocol coupling only). A lite-scope-side bridge
  that pre-reduces wide records into base records is the in-scope answer
  if this ever gates. Recorded, not re-litigated.
- **`minCount` in the NDJSON budget line.** The line shape is a
  consumed artifact schema; adding a field to every budget line for a
  fact that only matters on failure (where the reason string already
  carries it, verbatim) buys nothing and breaks every exact-shape
  assertion downstream. `minCount` appears on the in-process per-budget
  result object; the NDJSON line is unchanged.
- **Widening the non-finite door to all five verdict lanes.** See D-D
  scope note: unreachable from the public measurement path, and P3
  pinned those lanes. Recorded as residue with a date, not fixed
  silently and not left undocumented.

## Consequences for the pinned tests

Four tests in `test/self.test.mjs` change; one must NOT change, and
that is itself the contract.

1. `suiteGate: CONT records never match budgets` (line 320) --
   REWRITTEN. It pinned PG-13's vacuous pass (`budgets[1].value === 0`
   for `{op: OP_CONT}`). It now asserts `assert.throws(..., /CONT
   records are never budget targets \(SPP v1\)/)` for the op form AND
   for the packed form, and keeps a third assertion that a CONT RECORD
   inside the slab still does not gate a legal non-CONT budget (the
   protocol behavior is unchanged; only targeting CONT is now refused).
2. `suiteGate: validation throws at init, with budget names in
   messages` (line 337) -- EXTENDED, existing assertions untouched:
   adds slot `'toString'`, reduce `'constructor'`, and the four
   `minCount` doors.
3. `toNDJSON: suiteGate result -> budget lines then summary line`
   (line 361) -- UNCHANGED and load-bearing: its `deepEqual` on the
   exact budget-line shape is what proves `minCount` did NOT enter the
   artifact schema.
4. `suiteGate: zero-match budget reduces to 0 with count 0` (line 294)
   -- UNCHANGED and load-bearing: it is the back-compat proof that a
   typo'd op WITHOUT `minCount` still passes. If a future session makes
   presence assertions default-on, this test is the thing it must
   consciously delete.
5. `suiteGate: accepts a forEach record source` (line 305) -- unchanged
   and now doubles as D-B's passing twin: its fake sink passes four
   numbers and survives the first-record shape check untouched.
6. `test/torture.mjs` T5 soak (line 194) -- unchanged: its slab is a
   `Float64Array` with u32 packed headers and passes every door. If T5
   goes red this session, a door is wrong, not the soak.

## Appendix to decisions/0002

Appended to policy 2 (not a rewrite -- the original sentence stays):

    2026-09-13 (P4, v1.6.0): the full non-finite door has landed.
    `verdict()`'s counter lane now fails closed on any non-finite
    measured value, not only NaN, so the `Infinity` / `-Infinity` class
    named above -- and specifically the `-Infinity` reduced value this
    policy recorded as unreachable-until-P4 -- now produces
    '<key>: not a number (fail closed)'. The other four lanes keep the
    NaN-only predicate; see decisions/0004 D-D for the scope argument
    and the recorded residue.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
