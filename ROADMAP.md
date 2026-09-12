# lite-perf-gate -- enriched roadmap

Six BRIEF sessions for one package, plus a self-torture-suite spec.
Follows the `BLUEPRINT_ROADMAP.md` method: every finding below was
**reproduced by running the code on 2026-09-13 (darwin, Node v26.3.1,
`--expose-gc --max-semi-space-size=4` unless stated otherwise)**, not
inferred from reading. Incorporates the module evaluation in
`SUGGESTIONS.md` -- the role separation and the five growth directions --
and the standing constraints from `PROFILER-SUITE-ROADMAP.md` ("suiteGate
delegates to verdict(), never reimplements; exit codes stay in the runner
layer; the five-of-six rejection discipline stands").

**Why this roadmap exists.** lite-leak and lite-gc-profiler are the proven
pillars; lite-perf-gate is the smallest of the three and holds a real,
non-overlapping niche: the node:test-native, self-validating CI gate whose
primary signal is scavenge counting at two scales. The niche is right. The
implementation currently is not: the detector the whole methodology rests
on is dead on current Node out of the box, the verdict fails open on NaN
and typos, two whole allocation classes bypass all three signals, and the
published 1.2.1 ships a wrong `VERSION` while the local test suite fails
today. This roadmap is hardening-first: it makes the existing promises
true before it grows any surface, and the one surface addition it allows
(`minCount` budgets) exists to close a fail-open hole, not to add reach.

| Package | State | What it needs |
| --- | --- | --- |
| **lite-gc-profiler** | v1.16.0, mature: COOKBOOK, INCONCLUSIVE.md, decisions/, torture docs | Nothing here -- the boundary neighbor. Owns broad measurement, browser lanes, frame budgets, explain tooling |
| **lite-leak** | v1.10.0, mature | Nothing here -- the boundary neighbor. Owns owner-tree attribution and orphan kernels |
| **lite-perf-gate** | v1.2.1 on npm **with `VERSION = '1.2.0'` inside**, 4 commits, 26 self-tests (**1 failing right now**), no torture gate, no decisions/, no prepublishOnly, detector validation fails in a fresh process on Node 26 | Everything below: version truth, detector truth, fail-closed doors, bypass closure, suiteGate doors, then docs |

None of the sessions is padding. Each one is anchored to reproduced
finding IDs.

---

## 0. Ship-today facts (verified before planning anything)

1. **The published package is lying about its version.** The npm registry
   has `1.0.0, 1.0.1, 1.2.0, 1.2.1` (no 1.1.0 -- yet CHANGELOG.md carries a
   1.1.0 entry). The `1.2.1` tarball was downloaded and unpacked:
   `PerfGate.js:20` inside it reads `export const VERSION = '1.2.0';` and
   its CHANGELOG has no 1.2.1 entry. The 1.1.0 changelog entry says this
   class of slip is "now structurally impossible". It happened again, in
   production, one day after that sentence was written.
2. **`npm test` fails right now** on the working tree:
   `'1.2.1' !== '1.2.0'` in `VERSION matches package.json (triple bump)`.
   The guard works; the release process ignored it, because
3. **there is no `prepublishOnly` script.** Nothing forces the suite to
   pass before `npm publish`. The guard existed and publishing went around
   it. That is the actual bug; the version string is the symptom.
4. **package.json metadata verified clean** -- homepage/repository/bugs all
   point at `PeshoVurtoleta/lite-perf-gate`, consistent with the
   lite-gc-profiler and lite-leak metadata pattern (checked against both).
   No lite-arena-style cross-wiring. `npm pack --dry-run`: 7 files, test/
   and demo/ excluded, README/CHANGELOG/llms.txt included. Good.
5. The working tree carries an uncommitted `var -> let/const` cleanup that
   also **drops the trailing newline at EOF**, and `demo/index.html`'s
   `<title>` still says `1.0.0`.

---

## 1. Shared law (holds across every session)

1. **A gate that cannot fail is decoration.** Every signal the verdict
   checks gets a control that proves the detector can see it, and every
   control gets a broken variant that proves the gate can go red. This is
   the package's founding idea (positive/negative controls, mustFail);
   the sessions below extend it to every NEW signal, never suspend it.
2. **Fail closed on every unverified state.** NaN is not a number you can
   compare your way past; a threshold key that matches nothing is not a
   pass; a source of the wrong shape is not an empty stream; a missing
   `--expose-gc` is not a working instrument. Refusing to judge
   (loudly) is always acceptable; judging garbage is never.
3. **The boundary is the identity** (from SUGGESTIONS.md, kept verbatim as
   law): no rich retained-bytes-per-op reports, no major-GC kind
   breakdowns, no Chrome heuristics, no frame lanes (lite-gc-profiler's
   land); no leak-classification kernels, no owner-path attribution
   (lite-leak's land); no throughput benchmarking (nobody's land -- this
   is a gate). New GATE SIGNALS that close a bypass are in-bounds; new
   MEASUREMENT DOMAINS are not.
4. **`suiteGate` delegates every comparison to `verdict()`** -- one
   comparison authority (PROFILER-SUITE-ROADMAP risk 3). Exit codes stay
   in the runner layer; the library never touches `process.exitCode`.
5. **Bytes in a hot body, not instructions.** The only hot body in this
   package is `suiteGate`'s per-record `visit`. Any door added there is
   measured (lite-gc-profiler `measureOps`) before it lands, and the cost
   is recorded in the decision file.
6. **Three-place version sync** (`package.json`, `VERSION`, CHANGELOG),
   enforced at publish time by `prepublishOnly`, not by memory.
7. **Coverage is not exercise.** A test (or a header comment) that names a
   behavior and does not run its code path is a green light over a hole --
   this package currently has one of each (PG-15). The reviewer question
   is always "would this fail if the feature were broken".
8. ASCII-only source and docs (`->`, `<=`, `x`, `--`); single-file ESM;
   zero runtime deps; node:test only.

---

## 2. Verified findings

All reproduced 2026-09-13 against the working tree (= published 1.2.1
plus a cosmetic var cleanup). Severity: **S1** = the gate delivers a
false verdict or cannot deliver one at all, **S2** = broken documented
guarantee / vacuous-pass footgun, **S3** = hygiene or contract gap.

### The detector itself

| ID | Sev | Finding | Reproduction |
| --- | --- | --- | --- |
| **PG-01** | **S1** | **The positive control is defeated by allocation-site pretenuring on modern V8.** Every `{x,y,z,w}` it allocates survives into the module-level `__posKeep` array, so V8 learns the site is long-lived and allocates straight to old space -- scavenges vanish. Fresh process, default config (`N=200000, k=8`): `minorLo=2, minorHi=1` -- the count goes DOWN at 8x the work, inverting the package's own scaling law -- and `runGate` prints `DETECTOR VALIDATION FAILED: positive 2 (need >5)`. Deterministic across runs on Node v26.3.1. A control whose objects all survive validates retention, not the transient allocation the gate exists to detect. The proof of the fix shape: an otherwise-identical control writing into a 64-slot ring (objects escape EA but die young) shows `minorHi=21`, retained 11KB. | `runGate({scenarios:[]})` fresh process -> validation failure, twice; ring-vs-stock probe, twice |
| **PG-02** | **S1** | **`verdict()` never reads `majorLo`/`majorHi`**, so allocation that skips the young generation is invisible. A hot loop building a 600KB string per iteration (large-object space) churned **~2.4GB** through the heap inside one `measure()`: `minorHi=2, majorHi=0`, `verdict().pass === true` with default thresholds. The measurement records majors; the judgment ignores them. | probe PG-A |
| **PG-03** | **S1** | **ArrayBuffer/external memory is invisible to all three signals.** (a) Transient: 512KB `Float64Array` per iteration, ~2.1GB external churn -> `minorHi=1, majorHi=1`, PASS. (b) Retained: a pool holding 16MB of buffers -> `retainedKB_hi=4.6` (threshold 64) because `heapUsed` excludes backing stores -> PASS while `memoryUsage().arrayBuffers` grew 16.0MB. This is the exact blind spot lite-gc-profiler documents as 152x and gates with `maxArrayBuffersGrowth`; the gate here has no rule that can see it. | probes PG-B1, PG-B2 |
| **PG-10** | S2 | **The control sink retains ~113MB for the life of the process and poisons later measurements.** One `measure(controlPositive)` at defaults leaves 1,840,000 objects strongly held (`heapUsed` +113MB survives double `gc()`). Knock-on, observed in-process: the NEGATIVE control afterwards forced 6 scavenges (needs <=2), so detector validation fails for every subsequent gate in the same process. | probe PG-I; probes.mjs PG-J run |
| **PG-11** | S2 | **Missing `--expose-gc` is silently tolerated.** llms.txt says "--expose-gc is required"; nothing enforces it. `measure()` runs, `gc2()` no-ops, the retained signal judges uncollected garbage: a plain-node run produced a spurious FAIL (`retained: 2901KB > 64KB` on a loop retaining ~1.5MB). No throw, no flag on the result -- the caller cannot tell an instrumented verdict from an uninstrumented one. | probe PG-K, run without flags |

### The verdict and options layer

| ID | Sev | Finding | Reproduction |
| --- | --- | --- | --- |
| **PG-04** | **S1** | **`verdict()` fails open on NaN, both directions.** `{maxScavenges: NaN, maxRetainedKB: NaN, counters:{g:NaN}}` passes a result with 999 scavenges and 9999KB retained; a result carrying `minorHi: NaN, retainedKB_hi: NaN` passes default thresholds. Every comparison is `measured > limit`, and NaN comparisons are false -- silently "pass". | probes PG-C1, PG-C2 |
| **PG-05** | **S1** | **A typo'd counter-threshold key is silently skipped.** `counters_hi = {poolGrowths: 99}` judged against `counters: {poolGrowth: 0}` (singular) -> PASS, zero reasons. The threshold gates nothing, forever, with no signal. Precedent to follow: lite-gc-profiler throws on unknown rule keys since v1.10.0. | probe PG-D |
| **PG-08** | S2 | **An empty scenario list is a green gate that gates nothing.** `zgcSuite({scenarios: []})` under `node --test`: 2 control tests, `pass 2 fail 0`. `runGate({scenarios: []})` accepts equally (its summary math would print `PASS -- 0/0 scenarios` once the detector validates). A build glitch that produces `[]` turns the CI gate into a rubber stamp. | probe-empty-suite.test.mjs |
| **PG-09** | S2 | **`measure()` options are unvalidated.** `{N: -1}` skips every loop including the warmup: the POSITIVE control "passes" as zero-alloc (`minorHi=0`). `{k: 0.5}` inverts the two-scale design (hi < lo). `{flushMs: -50}` is accepted (Node clamps with a TimeoutNegativeWarning -- the observer window collapses to ~1ms). `flushMs: 0` is silently impossible (`|| DEFAULT` pattern). | probes PG-H1, PG-H2 |
| **PG-14** | S3 | **`runGate`'s doc comment promises exit codes `0/1/2`; it sets none** (`process.exitCode` undefined after a detector-validation failure) and its return value only distinguishes "detector broken" from "allocation found" by `results.length === 0`. CHANGELOG repeats the 0/1/2 claim. | probe PG-J prints |

### suiteGate (the SPP consumer)

| ID | Sev | Finding | Reproduction |
| --- | --- | --- | --- |
| **PG-06** | **S1** | **A wrong-shaped source reduces silently to a vacuous or corrupt verdict.** The same over-budget record: as a `Float64Array` slab -> FAIL (correct); as a `Float32Array` (native `forEach` binds `(value, index, array)` onto `(packed, t, a, b)`) -> **PASS** with `value=-Infinity, count=1`; as a plain array of `[packed,t,a,b]` tuples -> PASS with `count=0`. Both wrong shapes are things a caller plausibly produces (NDJSON re-parse, f32 ring). No door anywhere: `visit` never checks that `packed` is a u32 or that slots are numbers. | probe PG-F |
| **PG-12** | S3 | **Inherited-prototype keys corrupt budget validation.** `slot: 'toString'` is accepted (lookup hits `Object.prototype`) and silently reads slot `b`; `reduce: 'constructor'` is accepted and behaves as `last`; a budget legitimately NAMED `toString` is rejected as a "duplicate" on first sight (`seen = {}` inherits). Same class as the blueprint's AR-04. | probes PG-E1..E3 |
| **PG-13** | S3 | A budget explicitly targeting the CONT opcode (`op: 0x0F01`) is accepted at config time, can never match (visit skips CONT globally), and passes vacuously. The self-test pins this as intended; fail-closed says reject it at config. | probe PG-G |

### Process and docs

| ID | Sev | Finding | Reproduction |
| --- | --- | --- | --- |
| **PG-07** | **S2** | **Three-place version sync broken in production.** package.json `1.2.1` vs `VERSION '1.2.0'` vs CHANGELOG topping out at `1.2.0`; npm test failing on it today; the published 1.2.1 tarball verified to carry the stale const; no `prepublishOnly` to stop the next one; CHANGELOG documents a 1.1.0 that was never published. | section 0; registry + tarball |
| **PG-15** | S3 | **Self-test drift, AR-02 class.** The file header claims item 5 "zgcSuite registers tests against the built-in controls" -- no such test exists; `zgcSuite`, `runGate`, and the whole `mustFail` path have zero coverage. Sharper: the self-test measures controls at `N=100000, k=4`, NOT the library defaults `N=200000, k=8` -- which is precisely why PG-01's default-config detector failure is invisible to a green `npm test`. And the VERSION test pins a literal (`'1.2.0'`), forcing a test edit every release. | read test/self.test.mjs; compare probe results |
| **PG-16** | S3 | Hygiene set: README does not follow the LiteSepforge blueprint spine (no TOC, no positioning H2, no What-you-get, no Composability, no Zero-GC design notes, no Testing, no What-this-is-not, no Ecosystem); demo `<title>` says 1.0.0; the parked var cleanup drops the EOF newline; `zgcSuite`'s JSDoc omits `flushMs` (d.ts and README have it). | inspection; section 0 |

---

## 3. The self-torture suite (`test/torture.mjs`) -- spec

The pipeline law says every module change is proven by
`node --expose-gc test/torture.mjs` with `@zakkster/lite-leak` +
`@zakkster/lite-gc-profiler` as devDeps. For a package that IS a gate,
the torture suite has a second job: prove the gate's own machinery obeys
the laws it enforces on others, on every Node the engines field admits.

```
test/
  self.test.mjs         # unit surface (exists; extended by P1/P2/P4)
  torture.mjs           # entry: tiers in order, prints exactly "ok", exit 0/1
  torture/
    harness.mjs         # child-process spawner, seeded PRNG, scratch slabs
    t1-detector.mjs     # fresh-process detector matrix at LIBRARY DEFAULTS
    t2-doors.mjs        # every fail-closed door, hit from outside
    t3-bypass.mjs       # the mustFail corpus: PG-02/PG-03 probes as scenarios
    t4-reduction.mjs    # suiteGate visit loop: zero alloc per record
    t5-footprint.mjs    # harness self-footprint + leak_cycles soak
    t6-controls.mjs     # every gate above, deliberately broken, must fail
```

- **T1 detector matrix.** Spawn a CHILD `node --expose-gc
  --max-semi-space-size=4` per case (fresh heap -- pretenuring feedback and
  test-runner allocation noise both die with the process; PG-01 showed the
  in-runner and bare-process answers differ). Cases: `runGate` detector
  validation at library defaults; controls at `k*N` for N in {5e4, 2e5};
  positive control minor counts must scale (`minorHi >= 2 * minorLo` or an
  absolute floor -- P1 decides and records). This tier is the PG-01
  regression net and the only tier allowed to be Node-version-sensitive:
  it prints the Node version next to every number.
- **T2 doors.** NaN thresholds throw; NaN measured values fail with a
  named reason; unknown counter keys fail; `N/k/flushMs` garbage throws;
  empty scenarios throw; missing `--expose-gc` throws (child process
  without the flag); wrong-shaped suiteGate sources throw; inherited-key
  budgets throw; CONT budgets throw. Every door has a positive twin (the
  valid neighbor value passes).
- **T3 bypass corpus.** The reproduction scenarios from section 2 become
  permanent `mustFail` fixtures: 600KB-string churn (PG-02), 512KB-buffer
  churn (PG-03a), retained-pool growth (PG-03b), plus the classic
  per-iteration object. After P3, the gate must CATCH all four.
- **T4 reduction gate.** lite-gc-profiler `measureOps` over `suiteGate`
  on a preallocated 1M-record slab with 8 budgets:
  `maxMajor: 0, maxArrayBuffersGrowth: 0, stabilize: 'deep'`. Per-record
  allocation is zero; the config-time arrays are once-per-call and stay.
  `toNDJSON` is exempt from zero-alloc (it builds strings by contract)
  but gets a linear-growth bound. Profiler discipline: one measurement in
  flight at a time; tiers run sequentially; never resolve an unexpected
  `inconclusive` with `allowInconclusive`.
- **T5 footprint + soak.** After `measure(controlPositive)` at defaults,
  post-gc `heapUsed` growth < 1MB (today: 113MB, PG-10). Then
  `leak_cycles: 4096` alternating measure/suiteGate/toNDJSON cycles under
  lite-leak: zero surviving targets, flat heap across cycles.
- **T6 controls for the gate's own gates.** A detector matrix child with
  the observer disconnected must fail T1; a deliberately-allocating visit
  must fail T4; a sink truncation removed must fail T5; a door removed
  must fail T2. If a control passes, the tier is decorative.

`test/` never enters `files[]`; `npm pack --dry-run` proves it each time.

---

## 4. Session order

```
P0 --> P1 --> P2 --> P3 --> P5
               \--> P4 ----/
```

- **P0 today**: the package is lying on the registry and the local suite
  is red; nothing else ships over a failing `npm test`.
- **P1 before everything**: every later DONE-WHEN leans on the torture
  suite, and the torture suite leans on a detector that works in a fresh
  process on current Node.
- **P2 before P3/P4**: the doors (NaN, unknown keys, option validation)
  define the failure vocabulary the new signals and the suiteGate
  hardening reuse.
- **P3 and P4 are independent** (meterOnce/verdict vs suiteGate config
  and visit) and may land in either order; both block P5.
- **P5 last**: docs describe a finished surface, written once.

---

## 5. The briefs

===============================================================================
# P0 -- v1.2.2 -- version truth + the publish gate (URGENT, ship today)
===============================================================================

```markdown
---
package: "@zakkster/lite-perf-gate"
version_target: 1.2.2
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: []
findings: [PG-07, PG-16-partial]
blocks: [P1]
---

# lite-perf-gate -- stop publishing a version string that is false

PURPOSE
  npm has 1.2.1 shipping VERSION '1.2.0' and a CHANGELOG that ends at
  1.2.0. The local suite fails on exactly this. The guard test did its
  job; publishing went around it because nothing wires the suite into the
  publish path. Fix the number, then make the bypass impossible.

TASKS
  - Three-place sync to 1.2.2: package.json, VERSION const, CHANGELOG.
  - CHANGELOG honesty: add a 1.2.1 entry retroactively, stating what it
    contained (metadata/republish) and that its tarball shipped
    VERSION '1.2.0'. Annotate the 1.1.0 entry: never published standalone;
    its features first reached the registry inside 1.2.0.
  - `"prepublishOnly": "npm test"` in package.json. This is the actual
    fix; the version bump is the symptom relief.
  - Self-test: drop the literal pin (`assert.equal(VERSION, '1.2.0')`),
    KEEP the manifest equality assert. The literal forces a test edit
    every release, which is the friction that got skipped; the manifest
    assert is the guard that works without maintenance.
  - Commit the parked var->const cleanup WITH the trailing newline
    restored (the working tree currently deletes it).
  - Ride-alongs, one word each: demo/index.html <title> version; nothing
    else in the demo.
  - Publish 1.2.2.

ASSERTIONS
  - `npm test` green (26/26).
  - `npm pack --dry-run`: 7 files, test/ and demo/ excluded.
  - Tarball for 1.2.2 (npm pack, local) greps VERSION = '1.2.2'.
  - `npm publish` with a deliberately broken test exits non-zero and does
    not publish (verify with a dry run + a forced test failure, then
    revert the forced failure).

NON-GOALS
  No behavior change. No API change. No control fix (P1). Keep this
  patch small enough to ship within the hour.

DONE WHEN
  registry has 1.2.2 whose tarball VERSION matches; npm test green;
  prepublishOnly wired; working tree clean
```

===============================================================================
# P1 -- v1.3.0 -- detector truth on modern V8 + the torture skeleton
===============================================================================

```markdown
---
package: "@zakkster/lite-perf-gate"
version_target: 1.3.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [PG-01, PG-10, PG-15-partial]
depends_on: [P0]
blocks: [P2]
---

# lite-perf-gate -- the detector must detect, in a fresh process, today

PURPOSE
  The positive control's grow-forever sink teaches V8's allocation-site
  pretenuring that the site is long-lived; allocation moves to old space
  and the scavenge signal dies. Measured on Node v26.3.1, defaults,
  fresh process: minorLo=2, minorHi=1 -- inverse scaling -- and runGate
  refuses with DETECTOR VALIDATION FAILED. The same sink retains 113MB
  for the process lifetime and poisons every later measurement in it
  (the negative control then fails validation too). The library's
  README already knows about escape analysis; pretenuring is the second
  V8 adaptation, and it defeats the current design deterministically.

  A gate whose self-validation fails on a healthy machine is worse than
  a gate with no self-validation: it trains users to expect red.

THE DECISION (record in decisions/0001-positive-control.md BEFORE coding)
  Control redesign, options:
  A. RING SINK (recommended) -- module-level 64-slot array, hot writes
     `ring[i & 63] = {x,y,z,w}`. Objects escape (defeats scalar
     replacement -- the README's existing concern) and die young within
     64 iterations (defeats pretenuring -- the new one). Measured on the
     failing machine: minorLo=2, minorHi=21, retained 11KB, zero majors.
     Footprint bounded at 64 objects; PG-10 dies in the same move.
  B. PERIODIC TRUNCATION -- keep the growing sink, reset length inside
     the loop every M pushes. Still trains pretenuring between resets
     (survival ratio stays high); rejected unless A measures unstable.
  C. sink + `%DebugPrint`-style flag games -- out: not portable, not
     zero-config.
  Also decide: the validation margin. Today zgcSuite demands
  `posMinorHi > maxScavenges + 3`, COUPLING the control's required
  evidence to the user's scenario budget (a user setting maxScavenges: 40
  silently demands a 43-scavenge control). Give the control its own
  constant floor (e.g. must exceed max(scavenge threshold, 5) AND must
  scale: posMinorHi >= 2 * posMinorLo when posMinorLo > 0). Record the
  chosen inequality and why.

TASKS
  - Implement the chosen control. Export names stay: `controlPositive`,
    `controlNegative`, `_controlKeepAlive` (returns ring occupancy).
    CHANGELOG Changed entry: semantics of the positive control.
  - Decouple the validation margin per the decision.
  - devDeps: `@zakkster/lite-gc-profiler`, `@zakkster/lite-leak`
    (verify the scope spelling against the registry -- one `s`).
  - Stand up test/torture.mjs + test/torture/harness.mjs with tiers
    T1 (detector matrix, child processes, LIBRARY DEFAULTS -- the exact
    configuration PG-01 fails and the current self-test does not run),
    T5 (footprint + soak), T6 (controls). Register T2/T3/T4 as empty
    tiers for P2/P3/P4 to fill.
  - `"torture": "node --expose-gc --max-semi-space-size=4 test/torture.mjs"`
    in scripts; keep it out of files[].
  - Self-test additions (PG-15): a child-process test running zgcSuite
    end-to-end at defaults (green on a healthy machine), and one running
    it with a sabotaged control (must go red). Fix the file header list
    to match reality.
  - Node matrix note in CHANGELOG: which Node versions T1 was run on and
    the control counts observed (engines says >=18; verify at least one
    pre-MinorMS LTS and current, record numbers per version).

HOT PATH
  None of this touches suiteGate's visit. The control hot loop is the
  instrument, not the subject -- but its footprint IS gated now (T5:
  post-measure growth < 1MB, today 113MB).

ASSERTIONS
  - Fresh-process `runGate({scenarios: []})`... rather: fresh-process
    detector validation passes at library defaults on every tested Node
    (the PG-01 reproduction, inverted into a regression test).
  - Positive control scales: minorHi >= 2 * minorLo across T1 cases.
  - After measure(controlPositive) at defaults: post-gc heapUsed growth
    < 1MB, and a subsequent negative-control measure in the SAME process
    still validates (the PG-10 poisoning case, inverted).
  - T6: disconnecting the observer makes T1 fail; removing the ring
    truncation makes T5 fail.
  - torture prints exactly "ok", exit 0; npm test green.

NON-GOALS
  No verdict changes (P2). No new signals (P3). No suiteGate work (P4).

DONE WHEN
  detector validates at defaults in a fresh process on current Node;
  control footprint bounded; torture skeleton green with controls that
  can provably fail; decision recorded
```

===============================================================================
# P2 -- v1.4.0 -- fail-closed verdict, options, and process contract
===============================================================================

```markdown
---
package: "@zakkster/lite-perf-gate"
version_target: 1.4.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [PG-04, PG-05, PG-08, PG-09, PG-11, PG-14]
depends_on: [P1]
blocks: [P3, P4]
---

# lite-perf-gate -- a gate that can be talked past is not a gate

PURPOSE
  Six reproduced ways to get a green verdict (or a meaningless one)
  without a sound measurement: NaN thresholds pass everything; NaN
  measurements pass; a typo'd counter key gates nothing forever; an
  empty scenario list is a green suite; N=-1 makes the positive control
  itself pass as zero-alloc; a missing --expose-gc silently judges with
  a dead instrument. One session, one law: fail closed.

THE DECISION (record in decisions/0002-fail-closed.md BEFORE coding)
  - NaN/invalid THRESHOLDS: throw TypeError at config time (caller bug,
    cold path). NaN MEASURED values: verdict fails with reason
    '<signal>: not a number (fail closed)' -- a NaN measurement is
    evidence of a broken instrument, never of a clean hot path.
  - Unknown counter-threshold keys: cannot be validated at config time
    (counter names exist only at runtime), so verdict FAILS with reason
    '<key>: no such counter measured (statsOf keys: ...)'. Follows the
    lite-gc-profiler v1.10 precedent in spirit; record why it is
    fail-at-verdict here rather than throw-at-config.
  - Missing globalThis.gc: measure() throws at entry with the exact
    run command. Escape hatch `allowNoGc: true` (measure options +
    GateConfig): proceeds, sets `retainedReliable: false` on the result,
    and verdict treats a retained-threshold check against an unreliable
    retained value as a failure reason, not a pass. llms.txt already
    says "required"; make the code agree. Record the hatch's shape.
  - runGate exit codes: the docstring promises 0/1/2 and delivers
    nothing. Runner semantics stay in the runner layer (suite law), so:
    add `code: 0 | 1 | 2` to GateResult (0 pass, 1 scenario/mustFail
    failure, 2 detector validation failure), fix the docstring to say
    "map result.code to your exit code", never touch process.exitCode.

TASKS
  - Threshold validation shared by verdict/zgcSuite/runGate: numbers
    must be finite, >= 0.
  - Option doors, one validator used by measure/zgcSuite/runGate:
    N integer >= 1; k integer >= 2; flushMs finite >= 0 (0 now legal --
    replace the `|| default` pattern with `!== undefined`); scenario
    shape (name non-empty string, setup/hot functions, statsOf/teardown
    functions when present). Throw TypeError/RangeError naming the field
    and the value, library-prefixed.
  - Empty gates: zgcSuite and runGate throw on missing/empty scenarios
    unless `allowEmpty: true` is passed (the option exists for
    controls-only detector smoke runs and says what it is for).
  - PG-05: implement the unknown-counter-key policy per the decision.
  - PG-04: implement the NaN policies per the decision.
  - PG-11: implement the --expose-gc policy per the decision.
  - PG-14: `code` field + docstring fix; CHANGELOG corrects the 0/1/2
    claim's wording.
  - Self-test: every door exercised from outside (T2 tier filled), each
    with its passing twin. Child-process cases for the no-gc throw and
    for runGate code values 0/1/2.

HOT PATH
  All doors are config-time or verdict-time -- cold. meterOnce's window
  gains zero instructions; diff proves it.

ASSERTIONS
  - Every PG-04/05/08/09/11/14 reproduction from section 2, inverted:
    the exact calls that passed now throw or fail with the documented
    reason.
  - `verdict(r, {maxScavenges: NaN})` throws; NaN minorHi fails with the
    named reason; typo'd counter key fails naming available keys.
  - `measure(controlPositive, {N: -1})` throws; `{k: 0.5}` throws;
    `{flushMs: 0}` is accepted and honored.
  - Plain `node` (no flags) calling measure() throws with the run
    command in the message; `allowNoGc: true` run has
    retainedReliable false and a retained check fails closed.
  - zgcSuite({scenarios: []}) throws; with allowEmpty true it registers
    controls only and says so in the test names.
  - torture "ok"; T2 controls (doors removed) fail; npm test green.

NON-GOALS
  No new signals (P3). No suiteGate doors (P4 -- same law, different
  surface). No baseline files, no inconclusive verdict lane (rejection
  ledger, section 6).

DONE WHEN
  every fail-open reproduction from section 2 fails closed with a named
  reason; the doors are torture-gated; decision recorded
```

===============================================================================
# P3 -- v1.5.0 -- close the allocation bypasses (the headline session)
===============================================================================

```markdown
---
package: "@zakkster/lite-perf-gate"
version_target: 1.5.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [PG-02, PG-03]
depends_on: [P2]
blocks: [P5]
---

# lite-perf-gate -- 2.4GB of churn must not pass a zero-alloc gate

PURPOSE
  Reproduced: a hot path building a 600KB string per iteration churned
  ~2.4GB and PASSED (large-object space -- no scavenges, and verdict
  ignores the majors that meterOnce already records). A hot path
  churning 2.1GB of Float64Array backing stores PASSED (external
  memory -- invisible to scavenges, majors-ignored, and excluded from
  heapUsed). A pool retaining 16MB of buffers PASSED the 64KB retained
  threshold. The package's one-line promise is "prove your hot path
  allocates nothing -- or name what did"; today it cannot name anything
  that is big, external, or old-gen.

  Boundary note, decided up front: this is GATE HARDENING, not profiler
  creep. Two thresholds and one delta-signal, same three-line verdict
  vocabulary. No GC-kind breakdowns, no per-callsite tables, no
  explain reports -- when a new signal trips, the failure message tells
  the user to reach for lite-gc-profiler for diagnosis. That sentence
  goes in the README too.

THE DECISION (record in decisions/0003-bypass-signals.md BEFORE coding)
  - `maxMajors` default: 0 or a small tolerance? After gc2 settling, a
    genuinely zero-alloc loop has no reason to trigger a major; but
    ambient FinalizationRegistry/incremental activity must be measured
    first (run controls 100x, record the major-count distribution, pick
    the floor with data, not vibes). Recommendation to test first: 0.
  - External signal shape: `arrayBuffersKB` delta measured like
    retainedKB (post-gc2 before/after), gated by `maxArrayBuffersKB`
    (default 64, mirroring retained). Transient external churn is
    caught by majors (external pressure triggers them -- PG-B1 showed
    majorHi=1); retained external by the delta. Verify both claims
    with the T3 corpus before freezing defaults.
  - Third control: the self-validation law says a signal without a
    control is decoration. Add `controlLarge` (large-object churn, must
    trip majors) -- or one combined bypass control? Decide by what T1
    can keep fast; record it.
  - Scaling lane for majors: majorLo vs majorHi comparison, or absolute
    only? (Scavenge scaling is the package's signature; majors are
    rarer events -- absolute may be the honest lane. Decide, record.)

TASKS
  - meterOnce: capture `memoryUsage().arrayBuffers` alongside heapUsed
    (same before/after points). MeasureResult gains
    `arrayBuffersKB_lo/_hi`. d.ts, llms.txt updated.
  - verdict: `maxMajors` and `maxArrayBuffersKB` thresholds, same
    reason-string format, fail-closed NaN semantics from P2 inherited.
  - zgcSuite/runGate: plumb both; detector validation extends to the
    new control per the decision.
  - mustFail corpus (T3): the three PG-02/PG-03 probe scenarios become
    permanent fixtures and must now be CAUGHT, plus the classic small
    object as the control that still trips scavenges.
  - formatResult: majors and external delta appear when nonzero.
  - CHANGELOG: the "Three signals" table becomes five; documented as
    Added (new thresholds have defaults that can fail previously-green
    suites ONLY when majors/external actually move -- call that out
    honestly as the point of the release).

HOT PATH
  Two memoryUsage() reads per meterOnce pass, outside the measurement
  window (same points as heapUsed today). The window itself gains zero
  instructions; diff proves it.

ASSERTIONS
  - PG-A probe (600KB strings): verdict FAILS naming majors.
  - PG-B1 probe (512KB buffers, transient): FAILS naming majors or
    external -- whichever the decision assigns; the test asserts the
    recorded choice.
  - PG-B2 probe (16MB retained pool): FAILS naming arrayBuffersKB.
  - Negative control still passes with maxMajors at its default across
    the T1 matrix (no new flakiness -- 100-run soak, zero spurious
    majors, or the default moves and the decision file says why).
  - torture "ok"; T3 filled; T6 gains a broken-signal control (external
    delta zeroed out must fail T3).

NON-GOALS
  No GC-kind breakdowns, no pause-time budgets (lite-gc-profiler owns
  pauses), no RSS/PSS lanes, no browser anything. No throughput or
  wall-time thresholds -- latency budgets belong in suiteGate over SPP
  streams where a probe measured them.

DONE WHEN
  all three bypass reproductions are caught and named; new signals have
  controls; defaults chosen from measured distributions; decision
  recorded; five-signal table true in code, d.ts, llms.txt
```

===============================================================================
# P4 -- v1.6.0 -- suiteGate doors + the one deliberate surface addition
===============================================================================

```markdown
---
package: "@zakkster/lite-perf-gate"
version_target: 1.6.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler"]
findings: [PG-06, PG-12, PG-13]
depends_on: [P2]
blocks: [P5]
---

# lite-perf-gate -- the SPP consumer must reject what it cannot read

PURPOSE
  suiteGate is the package's growth axis (SUGGESTIONS direction 2) and
  its only hot body. Today it silently mis-reduces a Float32Array
  (native forEach arity collision -> a violating stream PASSES with
  value -Infinity), silently ignores an array-of-tuples source
  (count 0 -> PASS), accepts 'toString' as a slot name via prototype
  inheritance, rejects a budget legitimately named 'toString' as a
  duplicate, and lets a budget target CONT records that can never
  match. Fail-open, all of it -- and this is the surface CI trusts.

THE DECISION (record in decisions/0004-record-doors.md BEFORE coding)
  - Per-record door cost. The u32 check `packed === packed >>> 0`
    rejects NaN, negatives, fractions, and object coercions in one
    comparison per record and catches every wrong-shape case reproduced
    (Float32Array elements survive it only when they are exact u32s --
    ALSO check the selected slot value with `val === val` at reduce
    time, which catches the arity collision where a slot is an object
    -> NaN). Measure both doors with measureOps over the 1M-record
    slab; the budget is "within noise of v1.5.0". If the doors cost
    more than noise, fall back to validating the FIRST record strictly
    plus the NaN-at-reduce door, and record the tradeoff.
  - Throw vs fail? A corrupt RECORD is data-integrity, not budget
    violation: throw RangeError naming the record index (a stream you
    cannot parse must never become "all budgets pass"). A NaN REDUCED
    value fails that budget closed. Record the split.
  - `minCount`: the one surface addition. `{ minCount: 1 }` on a budget
    fails it when fewer records matched -- the presence assertion that
    turns "typo'd op passes forever" (PG-F's cousin, PG-13's neighbor)
    into a named failure. Reduce semantics unchanged; `max` still gates
    the reduced value. Alternative rejected in the ledger: a global
    requireAllMatch flag (too blunt; budgets differ).

TASKS
  - `SUITE_REDUCES`/`SUITE_SLOTS`/`seen` -> null-prototype objects
    (Object.create(null)); own-key semantics for slot/reduce lookup and
    duplicate detection. A budget named 'toString' is legal; slot
    'toString' throws the existing slot message.
  - suiteMatcher: `op === 0x0F01` (CONT) throws at config --
    'CONT records are never budget targets (SPP v1)'. The self-test
    that pins the silent-vacuous behavior changes deliberately;
    CHANGELOG Changed entry.
  - Record doors per the decision (slab path AND forEach path).
  - `minCount` per the decision: validation (integer >= 0), reduction
    unchanged, per-budget reason
    '<name>: matched <count> < minCount <n>'. Comparison stays
    delegated: feed it through verdict() like max (count as a counter),
    so the one-comparison-authority law holds.
  - d.ts + llms.txt: SuiteBudget gains minCount; source contract
    documents the doors (what throws, what fails).
  - Self-test: every PG-06/12/13 reproduction inverted; Float32Array
    and tuple-array sources now throw with the record index; minCount
    positive and negative cases; a 'toString'-named budget round-trips
    through toNDJSON.

HOT PATH
  visit() is THE hot body. The doors land only after measureOps proves
  them within noise on the 1M-record slab (T4). No allocation added at
  any record count; the reason strings build only on failure.

ASSERTIONS
  - The PG-F triple: Float64Array still fails correctly; Float32Array
    and tuple-array sources now THROW naming the first bad record.
  - slot 'toString' throws; reduce 'constructor' throws; budget NAMED
    'toString' works end to end.
  - CONT budget throws at config.
  - Typo'd op with minCount: 1 fails with the matched-count reason;
    without minCount it still passes and reports count 0 (documented,
    backward compatible).
  - T4: measureOps on visit within noise of v1.5.0; zero per-record
    allocation; maxArrayBuffersGrowth 0.
  - torture "ok"; npm test green.

NON-GOALS
  No new reduce kinds (p95 stays rejected -- needs a sort or a sketch,
  both allocate; ledger). No CONT payload decoding (SPP v2 problem;
  a lite-scope-side bridge can pre-reduce wide records). No stream
  discovery, no record emission, no lite-scope import -- protocol
  coupling only, per the suite roadmap.

DONE WHEN
  every wrong-shape reproduction throws with an index; inherited-key
  holes closed; minCount shipped and delegated through verdict();
  visit measured within noise; decisions recorded
```

===============================================================================
# P5 -- v1.6.1 -- docs to the blueprint, drift-guarded
===============================================================================

```markdown
---
package: "@zakkster/lite-perf-gate"
version_target: 1.6.1
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: []
findings: [PG-15, PG-16]
depends_on: [P3, P4]
---

# lite-perf-gate -- write the README the surface now deserves, once

PURPOSE
  The README predates the blueprint spine and three sessions of surface
  truth-making. Writing it earlier would have meant writing it twice
  (the R4 lesson). It also gets the two sections this package uniquely
  owes its ecosystem: the boundary statement (what lives here vs
  lite-gc-profiler vs lite-leak -- SUGGESTIONS.md's table, made
  canonical) and the engine-counter cookbook (SUGGESTIONS direction 3).

TASKS
  - Rebuild README.md on the LiteSepforge spine, in order: title +
    tagline; badges; positioning H2 ("The CI gate the ecosystem was
    missing") with inline install + runnable quick-start; TOC; Why this
    exists; What you get; <details> deep-dive on the measurement core
    (five signals, two scales, pretenuring/escape-analysis notes from
    decisions/0001); API reference with signatures + a constants table
    (defaults: N, k, maxScavenges, maxRetainedKB, maxMajors,
    maxArrayBuffersKB, flushMs, control floors); Composability -- one
    full end-to-end pipeline in code: engine statsOf -> zgcSuite in CI,
    gate failure -> lite-gc-profiler measureOps diagnosis ->
    lite-leak attribution, plus lite-scope sink -> suiteGate ->
    toNDJSON artifact; <details> Zero-GC design notes with the
    allocation table (visit: 0 B/record, config: bounded, toNDJSON:
    linear by contract) + gated numbers from T4; Design decisions worth
    knowing (linking decisions/); Testing (counts + npm scripts incl.
    torture); What this is not (the boundary law verbatim: not a
    profiler, not a leak classifier, not a benchmark runner -- with the
    "reach for" pointers); Ecosystem; License. ASCII-only.
  - Engine-counter cookbook subsection (SUGGESTIONS 3): two recipes --
    a pool-based engine exposing poolGrowths/totalAllocations, and an
    ECS arena exposing spawn/retire counters -- each ending in the
    one-line counters threshold that gates it.
  - llms.txt: five signals, all thresholds, all doors (what throws),
    minCount, allowNoGc/allowEmpty, the control floors. This is the
    file sibling packages read; it must be complete enough to write a
    correct gate from alone.
  - PerfGate.d.ts final sync; JSDoc gains flushMs on zgcSuite (PG-16).
  - Docs-drift guard test (the R4 device): every named export of
    PerfGate.js appears in llms.txt and README's API section; every
    documented option name exists in the source. Both directions, one
    test, fails CI on the next drift.
  - decisions/0001..0004 exist, are linked from README and source
    headers, and decisions/ stays out of files[].
  - Grep the new files for stray tool-call tags before trusting them.

ASSERTIONS
  - Drift guard green both directions; every relative link resolves.
  - README spine section order matches LiteSepforge exactly.
  - Every constant in the constants table greps to the same value in
    PerfGate.js.
  - `npm pack --dry-run`: README/CHANGELOG/llms.txt in, decisions/ and
    test/ and demo/ out.
  - torture "ok"; npm test green; three-place sync 1.6.1.

NON-GOALS
  No behavior change; the diff outside test/ contains no logic. Demo
  rebuild is NOT in scope (one-word title fix landed in P0; a full
  demo-audit pass is a separate decision for a separate day).

DONE WHEN
  README/llms.txt/d.ts/code agree and a test enforces it; the boundary
  statement and cookbook shipped; /release 1.6.1 clean
```

---

## 6. How to run it

In order: P0 today, then P1 -> P2 -> {P3, P4} -> P5.
`status: planned -> shipped` after each `/release`. Author the brief in
the package, then planner -> coder -> reviewer -> qa, then `/release`.
Reviewer REJECTED goes back to coder, never forward.

The budget frontmatter is identical everywhere: the package has exactly
one identity -- a self-validating gate whose own machinery obeys the laws
it enforces -- and no number in it ever moves.

### If you only do a subset

1. **P0 today.** The registry is serving a false VERSION and the local
   suite is red. It is a one-hour patch and everything else ships over
   it.
2. **P1 is non-negotiable.** The detector fails self-validation in a
   fresh process at default settings on current Node. Until it lands,
   every green this gate has ever produced on Node 24+ deserves an
   asterisk, and every red it produces trains users to ignore it.
3. **P3 is the headline.** "Prove your hot path allocates nothing" while
   2.4GB of large-object churn and 16MB of retained ArrayBuffers pass is
   the package's central claim failing on data a user hits by accident
   (strings and typed arrays are not exotic). It is also the session
   that most sharpens the boundary with lite-gc-profiler instead of
   blurring it: same verdict vocabulary, two new thresholds, and a
   failure message that hands diagnosis to the profiler.
4. **P2 before P3/P4, always.** The doors define the failure vocabulary;
   retrofitting fail-closed onto new signals costs double.

### The rejection ledger (the five-of-six discipline, continued)

Standing rejections, recorded so they are not re-litigated by accident:

- **Cross-run baseline files** (SUGGESTIONS direction 4 floated it):
  scavenge counts are V8-version- and machine-sensitive -- PG-01 proved
  a single Node upgrade inverts them. The two-scale design exists
  precisely so every run carries its own baseline. Revisit only if the
  T1 matrix shows counts stable across three consecutive Node majors.
- **p95/percentile reducers**: need a sort or a sketch; both allocate in
  the one hot body this package has. count/sum/max/mean/last stay.
- **Wall-time / throughput thresholds in measure()**: a gate, not a
  benchmark runner (the README's own line). Latency budgets enter
  through suiteGate over SPP streams, where a probe actually measured
  them.
- **Browser lanes, frame budgets, GC-kind breakdowns, pause budgets**:
  lite-gc-profiler's land. **Attribution and orphan kernels**:
  lite-leak's land.
- **Callback-shaped scenario APIs** (onIteration etc.): user code
  re-entering the measurement window is the one contamination the
  Scenario contract exists to prevent.
- **An `inconclusive` third verdict**: gc-profiler's three-verdict
  system fits a diagnostic tool; a CI gate is binary by job description.
  The P2 doors convert "cannot measure" into loud refusal (throw /
  detector-validation failure), which is stricter than inconclusive and
  simpler than three-state plumbing in every consumer.

### The habit this roadmap is built around

Every S1 above was invisible in review and obvious in a five-line probe.
PG-01 hid behind a self-test that exercises a DIFFERENT configuration
than the library defaults -- the AR-02 lesson wearing new clothes: the
suite was green, the tool was broken, and the green was the reason
nobody looked. The torture suite's T1 tier runs the defaults in a fresh
child process for exactly that reason, and T6 keeps every tier honest by
proving it can still fail. When a session says "measure the door before
it lands", that is the same instinct: the hot-body law is a measurement,
not a review opinion.

MIT (c) Zahary Shinikchiev
