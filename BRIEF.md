---
package: "@zakkster/lite-perf-gate"
version_target: 1.4.2
status: shipped
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: []
findings: [PG-15, PG-16]
depends_on: [P5]
blocks: []
---

# lite-perf-gate -- write the README the surface now deserves, once (P6)

PURPOSE
  The README predates the blueprint spine and four sessions of surface
  truth-making (P1 ring control, P2 doors, P3 bypass signals, P4 record
  doors + minCount, P5 cookbook). Writing it earlier would have meant
  writing it twice. It also gets the section this package uniquely owes
  its ecosystem: the boundary statement (what lives here vs
  lite-gc-profiler vs lite-leak -- SUGGESTIONS.md's table, made
  canonical). The cookbook shipped in P5; this session links it and
  freezes docs/code agreement behind a drift-guard test.

NAMING TRUTH (read before copying anything from ROADMAP.md's P6 draft)
  The roadmap's P6 brief predates the P3 naming decision. The SHIPPED
  threshold is `maxOldGen` (old-gen = major + incremental, decisions/
  0003), NOT `maxMajors`. The result fields are `oldGenLo/Hi`, and the
  five signals are: scavenges / counters / retainedKB / oldGen /
  arrayBuffersKB. Every table and signature in the new docs uses the
  shipped names -- verify each against PerfGate.js by grep, never from
  the roadmap draft or from memory.

BLUEPRINT LAW
  README.md is rebuilt on ../LiteSepforge/README.md -- the spine, same
  sections, same order (CLAUDE.md Docs law): title + one-line blockquote
  tagline; badges; positioning H2 ("The CI gate the ecosystem was
  missing") with inline install + runnable quick-start; TOC; Why this
  exists; What you get; <details> deep-dive on the measurement core
  (five signals, two scales, pretenuring + escape-analysis story from
  decisions/0001, controls incl. controlLarge ordering from 0003);
  API reference (signatures + a constants table); Composability (one
  full end-to-end pipeline in code); <details> Zero-GC design notes
  (allocation table + gated T4 numbers from decisions/0004); Design
  decisions worth knowing (linking decisions/0001..0004); Testing
  (real test counts + npm scripts incl. torture); What this is not
  (boundary law verbatim, reach-for pointers, the C1 documented hole);
  Ecosystem; License. The coder READS the LiteSepforge README first;
  do not invent a spine.

TASKS
  - README.md rebuilt per BLUEPRINT LAW. Constants table rows verified
    by grep against PerfGate.js: N 200000, k 8, flushMs 100 (+ env
    PERF_GATE_FLUSH_MS), maxScavenges 2, maxRetainedKB 64, maxOldGen 0,
    maxArrayBuffersKB 64, CONTROL_FLOOR 6, CONTROL_SCALE 2,
    CONTROL_NEG_CEIL 2, CONTROL_LARGE_FLOOR 277, CONTROL_RING_SIZE 64
    (exact names re-checked in source; the table prints what the code
    says, and the drift test enforces it thereafter).
  - Composability section, one runnable-shaped pipeline: engine statsOf
    -> zgcSuite in CI; gate failure -> lite-gc-profiler diagnosis ->
    lite-leak attribution; lite-scope sink -> suiteGate (minCount) ->
    toNDJSON artifact. Quick-start stays small; depth defers to
    COOKBOOK.md (linked from positioning H2 and Testing).
  - llms.txt: complete-enough-to-write-a-correct-gate-alone audit --
    five signals, every threshold + default, every door (what throws vs
    what fails closed), minCount, allowNoGc/allowEmpty, control floors
    (currently missing), formatResult, GateResult.code. Fix the stray
    mid-sentence line break in the v1.4.1 paragraph.
  - PerfGate.d.ts final sync against exports; JSDoc gains flushMs on
    zgcSuite (PG-16). PerfGate.js changes are VERSION + comments ONLY.
  - Docs-drift guard test (new test/docs.test.mjs or a self.test.mjs
    section -- planner decides): BOTH directions -- (a) every named
    export of PerfGate.js appears in llms.txt AND in README's API
    section; (b) every documented option/threshold name in the README
    constants table and llms.txt exists in PerfGate.js source. Plus:
    every relative link in README resolves; constants-table values
    match source values. Must be provably load-bearing (break one
    direction, watch it fail, restore -- the T6 instinct).
  - decisions/0001..0004 linked from README (Design decisions section)
    and from the PerfGate.js header comment block; decisions/ stays out
    of files[] (npm pack asserted, still 8 files).
  - CHANGELOG 1.4.2 dated 2026-09-13 (docs-only release: README
    blueprint rebuild, boundary statement, llms/d.ts sync, drift
    guard); three-place sync 1.4.1 -> 1.4.2.
  - Grep every new/rewritten file for stray tool-call tags and
    non-ASCII before trusting it.

HOT PATH
  None. Docs session: the diff outside test/ contains no logic.
  PerfGate.js diff vs HEAD is the VERSION line plus comment-only lines
  (zgcSuite JSDoc flushMs, header decision links) -- diff-proven; every
  hot body byte-identical.

ASSERTIONS
  - Drift guard green, and provably load-bearing in both directions
    (temporarily removing one export mention from llms.txt fails it;
    temporarily documenting a fake option fails it; both restored).
  - README section order matches ../LiteSepforge/README.md's spine
    exactly; every relative link resolves; COOKBOOK.md linked.
  - Every constants-table value greps to the same value in PerfGate.js.
  - npm pack --dry-run: 8 files; decisions/, test/, demo/, examples/
    out; README/CHANGELOG/llms.txt/COOKBOOK.md in.
  - npm test 10x green, single run < 90s (report new total count);
    npm run torture untouched, "ok", < 180s.
  - ASCII-only (-> <= x --); no "Karadjov" anywhere; three-place sync
    1.4.2; no publish (registry latest: 1.4.1; user ships 1.4.2).
  - PerfGate.js diff vs HEAD: VERSION + comments only.

NON-GOALS
  No behavior change, no new surface, no threshold moves. No demo/
  rebuild (demo-audit is a separate decision for a separate day). No
  COOKBOOK.md content changes beyond nothing at all -- recipe edits are
  P5's ledger, not P6's. D1 (trio demo) is its own build after this.

DONE WHEN
  README/llms.txt/d.ts/code agree and a test enforces it; boundary
  statement + cookbook linked; npm test and torture green; commit
  ready for the user to review and publish 1.4.2
