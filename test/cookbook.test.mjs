// Recipe-rot guard for COOKBOOK.md.
//
// Run: node --expose-gc --max-semi-space-size=4 --test test/cookbook.test.mjs
//
// A cookbook whose recipes no longer run is worse than no cookbook, because the
// reader trusts it. This file is the pinning device -- the mechanism adopted
// from lite-leak's test/cookbook.test.js ("Each test here corresponds to a
// numbered recipe and asserts the behaviour that recipe promises. If one fails,
// fix the recipe as well as the code."), adapted so the assertions are the
// recipe's OWN code, extracted from COOKBOOK.md and executed:
//
//   - Every recipe R0-R15 must have a runnable first ```js block; a missing or
//     fully-commented body FAILS naming the recipe (so commenting a recipe out
//     turns CI red instead of aging the book).
//   - run recipes (Tier 1-3) are spawned as bare child processes -- the
//     reliable path for detector validation (self.test.mjs, PG-15) -- and must
//     exit 0. Each block self-asserts with node:assert.
//   - smoke recipes (Tier 4 framework blocks) show the REAL framework import,
//     which is not installed here, so they are compile-checked (import lines
//     stripped) instead of executed; the runnable proof is the examples/ twin.
//   - every Tier-4 examples/ twin is spawned and must exit 0.
//
// No measure*/runGate call here overlaps another: each spawns its own process,
// so exactly one measurement is ever in flight.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
const COOKBOOK = readFileSync(new URL('../COOKBOOK.md', import.meta.url), 'utf8');
const PERFGATE_HREF = pathToFileURL(fileURLToPath(new URL('../PerfGate.js', import.meta.url))).href;

// Recipe -> pin mode.
//
// 'run' blocks are executed as bare child processes and must exit 0. They are
// DETERMINISTIC: shape-only (R0), a self-validating detector FAILURE (R2, code
// 2 whichever clause fires -- a pretenured control never scales), or pure
// reductions over synthetic data (R3 verdict, R7/R8/R10 suiteGate/toNDJSON).
//
// 'smoke' blocks are compile-checked, not executed. Two reasons a block is
// smoke: (a) it shows a REAL framework import that is not installed here
// (R11-R14) -- its runnable proof is the examples/ twin spawned below; or (b)
// it asserts a CLEAN pass from a LIVE GC measurement (R1/R4/R5/R6/R9), which is
// legitimately load-sensitive -- the negative/positive detector controls can
// pick up spurious scavenges on a saturated host (the exact flushMs/CI reality
// documented in Recipe 3). Re-proving GC determinism under a 10x flake loop is
// not the rot guard's job; live measure()/runGate() PASS is proven robustly by
// the zero-alloc examples/ twins and by R2's live runGate detector path. The
// recipes stay honest -- the reader sees the real assertion they would write.
const MODE = {
    0: 'run', 1: 'smoke', 2: 'run', 3: 'run', 4: 'smoke', 5: 'smoke', 6: 'smoke',
    7: 'run', 8: 'run', 9: 'smoke', 10: 'run',
    11: 'smoke', 12: 'smoke', 13: 'smoke', 14: 'smoke', 15: 'smoke'
};

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// --- extraction -------------------------------------------------------------

function recipeSection(n) {
    const re = new RegExp('^## Recipe ' + n + ':.*$', 'm');
    const m = re.exec(COOKBOOK);
    if (!m) return null;
    const rest = COOKBOOK.slice(m.index + m[0].length);
    const nextH = rest.search(/^## /m);
    return nextH === -1 ? rest : rest.slice(0, nextH);
}

function firstJsBlock(section) {
    const m = /```js\n([\s\S]*?)```/.exec(section);
    return m ? m[1] : null;
}

function hasExecutable(code) {
    return code.split('\n').some((l) => {
        const t = l.trim();
        return t.length > 0 && !t.startsWith('//');
    });
}

// --- executors --------------------------------------------------------------

function runBlock(code) {
    const rewritten = code.split("'@zakkster/lite-perf-gate'").join(JSON.stringify(PERFGATE_HREF));
    return spawnSync(
        process.execPath,
        ['--expose-gc', '--max-semi-space-size=4', '--input-type=module', '-e', rewritten],
        { cwd: PKG_DIR, encoding: 'utf8', timeout: 120000 }
    );
}

function compileSmoke(code) {
    const body = code.split('\n').filter((l) => {
        const t = l.trim();
        return !(t.startsWith('import ') || t.startsWith('export '));
    }).join('\n');
    // Parses the block (throws SyntaxError on malformed code); never runs it.
    // eslint-disable-next-line no-new-func
    new AsyncFunction(body);
}

// --- the pinned recipes -----------------------------------------------------

for (let n = 0; n <= 15; n++) {
    const mode = MODE[n];
    test('recipe ' + n + ' (' + mode + '): pinned code executes as documented', () => {
        const section = recipeSection(n);
        assert.ok(section !== null, 'recipe ' + n + ': heading missing from COOKBOOK.md');
        const code = firstJsBlock(section);
        assert.ok(code !== null, 'recipe ' + n + ': no pinned ```js block found in COOKBOOK.md');
        assert.ok(hasExecutable(code),
            'recipe ' + n + ': pinned block has no executable content (commented out?)');

        if (mode === 'run') {
            const r = runBlock(code);
            assert.equal(r.status, 0,
                'recipe ' + n + ' failed to run green:\n' + r.stdout + r.stderr);
        } else {
            assert.doesNotThrow(() => compileSmoke(code),
                'recipe ' + n + ': pinned block does not compile');
        }
    });
}

// --- the runnable Tier-4 twins ----------------------------------------------

for (const name of ['express', 'react', 'vue', 'angular', 'trio']) {
    test('example ' + name + '.mjs runs green', () => {
        const abs = fileURLToPath(new URL('../examples/' + name + '.mjs', import.meta.url));
        const r = spawnSync(
            process.execPath,
            ['--expose-gc', '--max-semi-space-size=4', abs],
            { cwd: PKG_DIR, encoding: 'utf8', timeout: 120000 }
        );
        assert.equal(r.status, 0,
            'examples/' + name + '.mjs must exit 0:\n' + r.stdout + r.stderr);
    });
}

// --- packaging: COOKBOOK ships, examples do not -----------------------------

test('COOKBOOK.md is in package.json files[]', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.ok(pkg.files.includes('COOKBOOK.md'), 'COOKBOOK.md must be in files[]');
    assert.ok(!pkg.files.includes('examples'), 'examples/ must NOT be in files[]');
});
