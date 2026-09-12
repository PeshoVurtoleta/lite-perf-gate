---
package: "@zakkster/lite-perf-gate"
version_target: 1.2.2
status: in-progress
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: []
findings: [PG-07, PG-16-partial]
blocks: [P1]
---

# lite-perf-gate -- stop publishing a version string that is false (P0)

PURPOSE
  npm has 1.2.1 shipping VERSION '1.2.0' and a CHANGELOG that ends at
  1.2.0. The local suite fails on exactly this. The guard test did its
  job; publishing went around it because nothing wires the suite into the
  publish path. Fix the number, then make the bypass impossible.

CONTEXT (verified 2026-09-13, see ROADMAP.md section 0 and finding PG-07)
  - Registry versions: 1.0.0, 1.0.1, 1.2.0, 1.2.1. No 1.1.0 was ever
    published, yet CHANGELOG.md carries a 1.1.0 entry (its features first
    reached the registry inside 1.2.0).
  - The published 1.2.1 tarball was unpacked and verified: PerfGate.js
    line 20 reads `export const VERSION = '1.2.0';` and its CHANGELOG has
    no 1.2.1 entry.
  - `npm test` fails right now: `'1.2.1' !== '1.2.0'` in
    'VERSION matches package.json (triple bump)' (25 pass / 1 fail).
  - package.json has no prepublishOnly script.
  - The working tree carries an uncommitted var -> let/const cleanup in
    PerfGate.js that also DELETES the trailing newline at EOF.
  - demo/index.html <title> still says "lite-perf-gate 1.0.0".

TASKS
  - Three-place sync to 1.2.2: package.json, VERSION const, CHANGELOG.
  - CHANGELOG honesty: add a 1.2.1 entry retroactively, stating what it
    contained and that its tarball shipped VERSION '1.2.0'. Annotate the
    1.1.0 entry: never published standalone; its features first reached
    the registry inside 1.2.0.
  - `"prepublishOnly": "npm test"` in package.json. This is the actual
    fix; the version bump is the symptom relief.
  - Self-test: drop the literal pin (`assert.equal(VERSION, '1.2.0')`),
    KEEP the manifest equality assert. The literal forces a test edit
    every release, which is the friction that got skipped; the manifest
    assert is the guard that works without maintenance.
  - Restore the trailing newline at EOF of PerfGate.js (keep the
    var -> let/const cleanup itself).
  - Ride-along, one word: demo/index.html <title> version; nothing else
    in the demo.
  - Publishing 1.2.2 itself is OUT OF SCOPE for the pipeline run: the
    session ends with the tree ready to publish. No `npm publish` and no
    git commits from subagents; the orchestrator commits after qa.

ASSERTIONS
  - `npm test` green (26/26).
  - `npm pack --dry-run`: 7 files, test/ and demo/ excluded, README,
    CHANGELOG.md, llms.txt, LICENSE, PerfGate.js, PerfGate.d.ts,
    package.json included.
  - A locally built tarball (npm pack) greps `VERSION = '1.2.2'`; delete
    the tarball afterwards.
  - With a deliberately broken test, `npm publish --dry-run` exits
    non-zero via prepublishOnly and does not proceed; revert the forced
    failure afterwards. (Never run a real `npm publish`.)
  - PerfGate.js ends with exactly one trailing newline; source remains
    ASCII-only.

NON-GOALS
  No behavior change. No API change. No control fix (that is P1). No new
  tests beyond editing the version test. Keep this patch small enough to
  ship within the hour.

DONE WHEN
  npm test green; prepublishOnly wired; tarball VERSION matches;
  working tree contains only the intended P0 diff, ready to commit
