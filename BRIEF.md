---
package: "@zakkster/lite-perf-gate"
version_target: 1.4.1
status: in-progress
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak", "@zakkster/lite-arena", "@zakkster/lite-scope"]
findings: []
depends_on: [P3, P4]
blocks: [P6, D1]
---

# lite-perf-gate -- the cookbook the siblings already have (P5)

PURPOSE
  lite-gc-profiler ships a 25-recipe COOKBOOK.md with runnable
  examples/{react,vue,angular}.mjs and a template; lite-leak ships a
  4-tier cookbook whose recipes are PINNED BY TEST
  (test/cookbook.test.js, llms.txt: "19 recipes, 4 tiers, pinned ...
  so recipes cannot rot"). lite-perf-gate -- the CI-facing member of
  the trio -- has neither. The surface froze in P2-P4 (five signals,
  fail-closed doors, minCount, GateResult.code, allowNoGc/allowEmpty,
  controlLarge, dated residues); every recipe documents the FINAL API.

HOUSE-PATTERN LAW (read before writing a single recipe)
  The planner and coder MUST read, as pattern sources, not from memory:
  - ../LiteGcProfiler/COOKBOOK.md (structure, voice, the graded arc,
    recipes 23-25 framework tier) and ../LiteGcProfiler/examples/
    (README + react.mjs + vue.mjs + angular.mjs -- note HOW they stay
    runnable and what dependency posture they take; mirror it).
  - ../LiteLeak/COOKBOOK.md (tier structure) and lite-leak's
    test/cookbook.test.js (the recipe-rot pinning device -- adopt its
    mechanism adapted to this package).
  Do not invent a house style; both siblings already agree on one.

TASKS
  - COOKBOOK.md, four tiers, ~15 recipes, ASCII, added to files[]
    (7 -> 8; npm pack asserted):
    Tier 1 -- first verdict:
      R0 just show me a number (measure + formatResult)
      R1 my first gate (zgcSuite, one scenario, the run flags)
      R2 reading a detector-validation failure (positive floor /
         scaling / negative ceiling / large-control clause -- what
         each clause means and what to do about it; the pretenuring
         story from decisions/0001 in two sentences)
      R3 thresholds you can defend (maxScavenges / maxRetainedKB /
         maxOldGen / maxArrayBuffersKB / counters; N and k; flushMs on
         saturated CI; what the C1 documented hole means for string-
         heavy workloads, honestly, one paragraph)
    Tier 2 -- engine counters (SUGGESTIONS direction 3):
      R4 pool engine: statsOf + counters {poolGrowths: 0}
      R5 lite-arena ECS: spawn/retire counters + zero-alloc tick
         (lite-arena as devDep; verify its actual API from
         ../LiteArena/llms.txt -- never from memory)
      R6 mustFail: proving the gate can catch a planted allocation
    Tier 3 -- streams + CI:
      R7 suiteGate over a lite-scope memory sink (toSlab -> budgets;
         lite-scope as devDep; API from ../LiteScope/llms.txt)
      R8 toNDJSON as a GitHub Actions artifact + job summary (workflow
         yaml block included, marked illustrative)
      R9 runGate in a bare script; mapping result.code 0/1/2
      R10 one stream, three budgets: gc-pause + leak-orphan +
          input-latency shapes over one slab, with minCount presence
          assertions (the SUGGESTIONS example, runnable)
    Tier 4 -- framework integration (mirrors gc-profiler 23-25):
      R11 Express/Fastify route-handler gating (server-side FIRST --
          this package's home turf; follow the sibling dependency
          posture for how the example stays runnable)
      R12 React render loop  R13 Vue reactivity tick
      R14 Angular change detection
      R15 the trio recipe: perf-gate gates, gc-profiler diagnoses the
          failure, lite-leak attributes it -- one runnable file; this
          doubles as the D1 demo's script in prose.
  - examples/ directory (repo-only, NEVER in files[]): one runnable
    .mjs per Tier-4 recipe + trio.mjs + README, each with one
    documented run command, mirroring the gc-profiler examples/
    posture exactly (including its dependency stance).
  - Recipe rot guard (the lite-leak device): test/cookbook.test.mjs
    executes every recipe's code (or its examples/ twin) so a surface
    change fails CI instead of aging the book. Heavy framework recipes
    may be smoke-level (import + one tick). npm test stays < 90s.
  - devDependencies: add @zakkster/lite-arena and @zakkster/lite-scope
    (versions verified against the registry/catalog: arena ^1.9.0,
    scope ^1.2.0); npm install; lockfile stays gitignored. Framework
    deps follow the sibling posture -- if gc-profiler's examples avoid
    installing frameworks, so do ours, the same way.
  - package.json files[] gains COOKBOOK.md; CHANGELOG 1.4.1 dated
    2026-09-13 (Added: cookbook + examples + rot guard; note the
    recipes document the post-P4 surface).
  - Three-place sync 1.4.0 -> 1.4.1.

HOT PATH
  Docs session; the library diff is EMPTY (PerfGate.js untouched
  except nothing at all -- version const only). The recipe code itself
  obeys every law it teaches: a cookbook recipe that fails its own
  gate is the AR-02 lesson in print, and the rot-guard test enforces
  exactly that.

ASSERTIONS
  - Every recipe R0-R15 exists in COOKBOOK.md under its tier; every
    Tier-4 recipe has a runnable examples/ twin; examples/README
    documents one command per example.
  - test/cookbook.test.mjs green and genuinely load-bearing: deleting
    one pinned recipe's code makes it fail (spot-check one, revert,
    prove restoration).
  - npm pack --dry-run: 8 files, COOKBOOK.md in; examples/, test/,
    decisions/, test/probes/ out.
  - npm test 10x loop green, single run < 90s (new total reported);
    npm run torture untouched and still ok < 180s.
  - PerfGate.js diff vs HEAD: VERSION line only.
  - ASCII everywhere; three-place sync 1.4.1; no "Karadjov"; HEAD
    (d7d1477) moves only by orchestrator commits; no publish
    (registry: 1.3.0 latest published; the consolidated 1.4.0 pending user).

NON-GOALS
  No README rewrite (P6). No new library surface -- a recipe that
  needs one is a ledger finding, not a feature. No browser recipes
  (NOT FOR stands; streams are the browser story and live in D1). No
  demo work (D1 is its own build with its own brief).

DONE WHEN
  cookbook ships in the tarball, recipes pinned by test, examples
  runnable, siblings' bar met (graded arc + framework tier + CI tier)
