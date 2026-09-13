# 0001 -- The positive control is a bounded ring, and its validation margin
        is its own

Status: accepted
Date: 2026-09-13
Session: P1 (v1.3.0)
Findings: PG-01 (S1), PG-10 (S2)
Measured on: darwin, Node v26.3.1, single install at /usr/local/bin/node,
flags `--expose-gc --max-semi-space-size=4` unless stated. Every number
below was reproduced twice.

## The problem

The gate's founding claim is that scavenge counts scale with transient
allocation. The positive control exists to prove, on every run, that the
instrument can see allocation at all. On current V8 it proves the
opposite: at LIBRARY DEFAULTS (N=200000, k=8) in a fresh process it
forces 2 scavenges at N and 1 at 8N -- the count goes DOWN as the work
goes up -- and runGate refuses with DETECTOR VALIDATION FAILED.

## Mechanism

Two V8 adaptations, not one, stand between a JS loop and a scavenge.

1. Escape analysis / scalar replacement (the README already knows this
   one). An object that provably never escapes its frame is never
   allocated; its fields become registers. A control that builds
   {x,y,z,w} and drops it measures nothing. The historical fix was to
   store every object into a module-level array -- making it escape --
   and that fix is why `__posKeep` exists.

2. Allocation-site pretenuring (the new one). V8 tracks, per allocation
   SITE, what fraction of the objects born there survive a scavenge.
   A site whose objects keep surviving is marked pretenured and its
   future allocations go straight to old space. Old-space allocation
   does not fill the young generation, so it does not trigger
   scavenges. The v1.0 fix for (1) is precisely the input that trains
   (2): every object the control ever allocated was still strongly
   reachable from `__posKeep`, a 100% survival ratio, the strongest
   possible pretenuring signal. The control taught V8 to make the
   control invisible.

A correct control must escape AND die young. Those are not in tension:
an object can be stored somewhere real and then be overwritten a few
iterations later.

## Measured

Fresh bare process, N=200000, k=8, `--expose-gc --max-semi-space-size=4`:

| control                          | minorLo | minorHi | majorLo | majorHi | retainedKB_hi |
| -------------------------------- | ------- | ------- | ------- | ------- | ------------- |
| stock grow-forever `__posKeep`   | 2       | 1       | 1       | 1       | ~100784       |
| 64-slot ring, same object shape  | 2       | 21      | 0       | 0       | ~11           |

Knock-on of the stock sink, same process: heapUsed grows ~113MB and
survives a double gc(); `_controlKeepAlive()` returns 1840000; a
NEGATIVE-control measure taken afterwards in the same process forces 6
scavenges (ceiling 2) and fails validation on its own. One measurement
poisoned every measurement after it.

Under `node --test` the stock control can still pass, because the test
runner's own allocations add scavenges inside the window. That is the
whole reason this package's self-test was green while its default
configuration was broken, and the reason T1 spawns bare children.

## Options

A. RING SINK (chosen). A module-level 64-slot array; the hot body writes
   `__posRing[i & 63] = {x, y, z, w}`. The store escapes, so (1) cannot
   elide it. Each object is overwritten within 64 iterations, so the
   site's survival ratio is ~0 and (2) never fires. Numbers above.
   Footprint is bounded by construction at 64 objects (~3KB), so PG-10
   dies in the same move: there is nothing left to poison the next
   measurement with.

B. PERIODIC TRUNCATION. Keep the growing array, reset `.length` every M
   pushes. REJECTED. Between resets the survival ratio is still ~100%
   -- pretenuring is trained by what survives a scavenge, and with M
   large enough to be cheap, a scavenge lands inside the window every
   time. It also leaves the footprint as a tuning parameter (M times the
   object size) instead of a constant, and the truncation itself is a
   branch inside the measured hot body. A was measured stable; B was
   not measured because A removed the reason to.

C. WEAKREF SINK -- keep the big sink, hold each object behind a WeakRef
   so the retention "does not count". REJECTED. WeakRef targets are kept
   alive for the remainder of the current microtask checkpoint and the
   allocation site's survival ratio is unchanged for exactly as long as
   it matters, so it does not address the mechanism at all; it adds one
   WeakRef allocation per iteration to the hot body; and it turns a
   deterministic control into one whose behavior depends on collection
   timing. Complexity with no measured advantage.

D. SCATTERED ALLOCATION SITES -- emit the object from N different call
   sites so no single site accumulates a pretenuring decision. REJECTED
   for the same reason: no measured advantage over A, and it makes the
   control's cost a function of how V8 chose to inline it that day.

## The validation margin

The old predicate, in two forked copies (zgcSuite and runGate), was

    pos.minorHi > maxScavenges + 3

This COUPLES the evidence the instrument must produce to the budget the
user set for their own code. A consumer who writes `maxScavenges: 40`
silently demands a 43-scavenge positive control and gets
DETECTOR VALIDATION FAILED for a working detector. The control's job has
nothing to do with the consumer's budget. REJECTED.

Chosen, as one predicate used by both call sites:

    CONTROL_FLOOR    = 6   scavenges
    CONTROL_SCALE    = 2   x
    CONTROL_NEG_CEIL = 2   scavenges

    valid  iff  pos.minorHi >= CONTROL_FLOOR
           and (pos.minorLo === 0 or pos.minorHi >= CONTROL_SCALE * pos.minorLo)
           and  neg.minorHi <= min(maxScavenges, CONTROL_NEG_CEIL)

Why 6, from the numbers. The ring measured 21 at k*N here, so the floor
sits at 3.5x below the observed value: the control may lose 71% of its
scavenges before this clause trips. The realistic loss is not a slower
CPU (scavenge count is a function of bytes allocated per semi-space
byte, not of speed) but a LARGER semi-space: a run without
`--max-semi-space-size=4` gets V8's default young generation, up to 4x
larger, and ~1.6M x ~40 bytes of churn then buys roughly 5-6 scavenges
instead of 21. A floor of 8 or 10 would red-light that machine. In the
other direction, 6 is 3x the negative control's ceiling of 2, so a
machine noisy enough to manufacture a passing positive has already
failed the negative clause. 6 is also strictly above the old effective
floor (`> maxScavenges + 3` = 6 at the default maxScavenges of 2), so no
configuration that validated before validates less strictly now.

Why the scaling clause is `>= 2x` and skipped at zero. By construction
the high pass does 8x the work, and the ring measured 10.5x. A 2x
requirement leaves 4x of headroom, so one ambient scavenge landing in
the low window cannot invert the verdict. When `minorLo === 0` -- a
legitimate outcome on a machine whose young generation swallows the low
pass whole -- there is no ratio to compute and the absolute floor is the
only honest gate; the clause is skipped rather than divided by zero.
This clause is what would have caught PG-01 as a SCALING inversion
rather than as a low count.

Why the negative clause is `min(maxScavenges, 2)` and not `maxScavenges`.
Same decoupling, other direction: a consumer raising their own budget to
40 must not thereby certify an instrument that fires 40 times on a pure
arithmetic loop. The `min` can only ever tighten, never loosen, so a
consumer running at the default 2 sees no change.

Every clause is written `!(measured >= limit)` rather than
`measured < limit`, so a NaN count fails closed today. The full
NaN policy is P2's (decisions/0002).

## Consequences

- `controlPositive.name` changes to name the ring. Anyone matching on
  the old string breaks loudly; nobody gates on it.
- `_controlKeepAlive()` now returns ring occupancy, 0..64, instead of a
  monotonically growing push count. Its purpose is unchanged: a read
  that touches every slot so V8 cannot sink the stores.
- A consumer who passed their own `positiveControl` keeps full control
  of the scenario but is now judged against CONTROL_FLOOR = 6 instead
  of `maxScavenges + 3`. Two cases: a consumer at the default
  maxScavenges: 2 sees the identical effective floor; a consumer who
  raised maxScavenges above 3 sees their control validated MORE easily
  than before, which is the bug being fixed. A custom positive control
  that is itself defeated by pretenuring will now fail, correctly, and
  the failure message names the floor, both counts and the run flags.
- One predicate, one place. A future change to the margin cannot land in
  zgcSuite and miss runGate, which is how the two drifted from the
  README in the first place.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
