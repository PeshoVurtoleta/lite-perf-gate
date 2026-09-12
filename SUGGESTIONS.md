**`lite-perf-gate` is a specialized, node:test-native *harness and gate* for proving zero-allocation (and related performance budgets) on hot paths, with a strong emphasis on detecting *transient* allocation via scavenge counting.** It sits alongside the other two tools but occupies a distinct niche in the Lite ecosystem’s performance/zero-GC toolkit.

### Roles of the three modules (clear separation)

| Module | Primary concern | What it measures / detects | Typical use | Runtime focus | Key strength |
|--------|-----------------|----------------------------|-------------|---------------|--------------|
| **lite-gc-profiler** | Falsifiable GC & heap budgets (zero-GC claim made testable) | Precise GC events (node), heap-drop heuristics (Chrome), long-frame anomalies elsewhere; retained bytes/op, major GC count, array-buffer growth, alloc rates | `measureOps` / `assertOps` / `measureFrames`, CI gates, badges, explain tooling | Node + browser | Broad, multi-source measurement + three-verdict gating (`pass`/`fail`/`inconclusive`); rich diagnostics and cookbook |
| **lite-leak** | Resource/owner-tree leak diagnosis | Targets that outlive their `lite-signal` owner (FinalizationRegistry + auto-untrack via `onCleanup`); specialized kernels (raf-orphan, worker, GL, emitter, etc.); audit API | Track resources inside effects/roots; get structured leak reports with owner-path attribution | Node + browser (FR required) | Attribution + classification of *true leaks* (surviving GC), not just allocation volume |
| **lite-perf-gate** | CI-friendly zero-alloc *regression gate* for hot paths | Scavenge (minor GC) counts at two scales (N and k·N), retained-heap delta, custom counters from the engine under test; detector self-validation + must-fail scenarios | `zgcSuite` inside `node:test`, `measure`/`verdict`/`runGate`, plus newer `suiteGate` for SPP probe streams | Node only (perf_hooks + `--expose-gc`) | Reliable detection of *transient* garbage (the exact pressure a zero-alloc claim is about); scaling verdict; built-in positive/negative controls so the detector cannot silently lie |

**lite-gc-profiler** is the general-purpose measurement and budgeting engine. It answers “how many bytes retained per op / did a major GC fire / what’s the alloc rate?” across environments and produces rich reports that can be gated or visualized.

**lite-leak** answers a different question: “did this specific resource escape its owner and survive?” It is attribution- and classification-oriented (kernels for common orphan patterns) and lives in the reactive/owner-tree world of `lite-signal` + `lite-cleanup`.

**lite-perf-gate** is the strict, self-validating *test harness* that turns the zero-alloc claim into a CI pass/fail for a concrete hot-path scenario. Its core insight (documented in the README) is that retained-heap deltas and sampling profilers both miss transient allocation; only scavenge counting reliably sees the GC pressure that a “zero-GC hot path” claim is really about. It therefore:

- Runs each scenario at two scales and checks that scavenges do *not* scale with work.
- Validates its own detector on every run (positive control must produce scavenges; negative control must not).
- Supports custom engine counters and must-fail scenarios.
- Has grown a secondary role (`suiteGate` + `toNDJSON`) for consuming Scope Probe Protocol (SPP) streams from tools such as `lite-scope` without creating package coupling.

### Should `lite-perf-gate` be developed further, without overlap?

**Yes — it has a clear, non-overlapping role and is worth deepening**, provided the boundaries stay sharp.

**Where it already differentiates cleanly**
- It is *harness-first* and `node:test`-native, not a general profiler.
- Its primary signal (scavenge counting + scaling) is deliberately chosen to catch what retained-heap and sampling miss.
- Detector self-validation and must-fail scenarios give it a unique reliability guarantee that the other two do not attempt.
- The newer SPP/`suiteGate` path positions it as a *consumer of probe streams* rather than a producer of measurements, which keeps it complementary to both `lite-gc-profiler` and any future scope/probe tooling.

**Recommended directions that stay non-overlapping**
1. **Harden and document the scavenge methodology further** — more guidance on `--max-semi-space-size`, flush timing under saturated CI, interaction with FinalizationRegistry / WeakRef teardown (already partially addressed via `gc2()`), and how escape analysis can still defeat naïve positive controls.
2. **Expand the SPP/`suiteGate` surface** — richer reducers, more budget kinds, better NDJSON/artifact story for CI, and explicit examples of combining GC-pause, leak-orphan, and input-latency budgets from a single probe stream. This is the least overlapping growth area.
3. **Deeper engine-counter integration patterns** — cookbook-style recipes showing how a pool-based or ECS-style engine exposes `statsOf` so the gate can assert “pool growth = 0” *and* “scavenges ≈ 0” in one verdict.
4. **Self-test and robustness polish** — more must-fail scenarios, clearer “detector broken” diagnostics, optional baseline comparison for scavenge rates across runs.
5. **Keep the measurement surface thin** — avoid turning it into a general-purpose GC observer or browser-capable profiler. Those jobs already belong to `lite-gc-profiler`. Likewise, leave owner-tree attribution and kernel classification to `lite-leak`.

**What to avoid (to prevent overlap)**
- Re-implementing rich retained-bytes-per-op, major-GC kind breakdowns, Chrome heuristics, or frame-lane measurement (already covered by `lite-gc-profiler`).
- Building its own leak-classification kernels or owner-path tracking (already covered by `lite-leak`).
- Becoming a full benchmark runner with throughput focus; the README correctly positions it as a *gate*, not a throughput tool.

### Practical ecosystem picture

In a typical Lite-module CI setup you would use them together without redundancy:

- **lite-perf-gate** (`zgcSuite` or `suiteGate`) as the primary zero-alloc regression gate on the hottest paths.
- **lite-gc-profiler** for deeper diagnosis when a gate fails, for browser environments, for frame-loop budgets, or for producing badges/explain reports.
- **lite-leak** for resource-lifecycle and owner-tree correctness (especially anything that uses `lite-signal` effects/roots).

`lite-perf-gate` is currently the smallest and most specialized of the three (only a handful of commits visible). That makes it a good candidate for focused evolution around the scavenge + scaling + self-validation + SPP-consumer axes, while the other two continue to own the broader measurement and leak-diagnosis spaces.