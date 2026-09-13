// Self-test for @zakkster/lite-perf-gate.
// Run: node --expose-gc --max-semi-space-size=4 --test test/self.test.mjs
//
// This file tests the HARNESS API, not a consumer engine. It proves:
//   1. VERSION agrees with package.json (triple-bump discipline).
//   2. The positive control forces scavenges and the negative control
//      forces ~0 (detector works, no false positives).
//   3. verdict() passes clean results and fails dirty ones with named
//      reasons (scavenge / retained / counter / multiple).
//   4. formatResult() and measure() return the documented shapes, including
//      statsOf counter deltas and the flushMs plumbing.
//   5. suiteGate() reduces SPP slabs to per-budget verdicts, and toNDJSON()
//      serialises both result kinds.
//   6. zgcSuite() is green end-to-end at library defaults, and goes red when
//      the positive control is sabotaged (both via bare child processes).
//
// runGate's detector self-validation at library defaults is covered by
// test/torture.mjs T1 (bare child processes), not here: under `node --test`
// the runner's own allocations mask a broken control.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    measure, verdict, formatResult,
    controlPositive, controlNegative,
    _controlKeepAlive, VERSION,
    suiteGate, toNDJSON,
    zgcSuite, runGate
} from '../PerfGate.js';

assert.ok(typeof globalThis.gc === 'function', 'run with --expose-gc');

const OPTS = { N: 100000, k: 4 };

test('VERSION matches package.json (triple bump)', function () {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.version, VERSION);
});

test('positive control forces scavenges', async function () {
    const r = await measure(controlPositive, OPTS);
    _controlKeepAlive();
    assert.ok(r.minorHi > 3, 'positive control should force scavenges, saw ' + r.minorHi);
});

test('negative control forces ~0 scavenges', async function () {
    const r = await measure(controlNegative, OPTS);
    assert.ok(r.minorHi <= 2, 'negative control forced ' + r.minorHi + ' scavenges');
});

test('verdict passes for a clean result', function () {
    const r = {
        name: 'clean', N: 1000, k: 4,
        minorLo: 0, minorHi: 0, majorLo: 0, majorHi: 0,
        retainedKB_lo: 0, retainedKB_hi: 10,
        counters_lo: { poolGrowths: 0 }, counters_hi: { poolGrowths: 0 }
    };
    const v = verdict(r, { maxScavenges: 2, maxRetainedKB: 64, counters: { poolGrowths: 0 } });
    assert.ok(v.pass);
    assert.equal(v.reasons.length, 0);
});

test('verdict fails for scavenge violation', function () {
    const r = {
        name: 'dirty', N: 1000, k: 4,
        minorLo: 0, minorHi: 10, majorLo: 0, majorHi: 0,
        retainedKB_lo: 0, retainedKB_hi: 10,
        counters_lo: null, counters_hi: null
    };
    const v = verdict(r, { maxScavenges: 2 });
    assert.equal(v.pass, false);
    assert.ok(v.reasons[0].includes('scavenges'));
});

test('verdict fails for retained heap violation', function () {
    const r = {
        name: 'leak', N: 1000, k: 4,
        minorLo: 0, minorHi: 0, majorLo: 0, majorHi: 0,
        retainedKB_lo: 0, retainedKB_hi: 200,
        counters_lo: null, counters_hi: null
    };
    const v = verdict(r, { maxRetainedKB: 64 });
    assert.equal(v.pass, false);
    assert.ok(v.reasons[0].includes('retained'));
});

test('verdict fails for counter violation', function () {
    const r = {
        name: 'pool', N: 1000, k: 4,
        minorLo: 0, minorHi: 0, majorLo: 0, majorHi: 0,
        retainedKB_lo: 0, retainedKB_hi: 0,
        counters_lo: { poolGrowths: 0 }, counters_hi: { poolGrowths: 5 }
    };
    const v = verdict(r, { counters: { poolGrowths: 0 } });
    assert.equal(v.pass, false);
    assert.ok(v.reasons[0].includes('poolGrowths'));
});

test('verdict collects multiple reasons', function () {
    const r = {
        name: 'multi', N: 1000, k: 4,
        minorLo: 0, minorHi: 15, majorLo: 0, majorHi: 0,
        retainedKB_lo: 0, retainedKB_hi: 200,
        counters_lo: { poolGrowths: 0 }, counters_hi: { poolGrowths: 3 }
    };
    const v = verdict(r, { maxScavenges: 2, maxRetainedKB: 64, counters: { poolGrowths: 0 } });
    assert.equal(v.pass, false);
    assert.equal(v.reasons.length, 3);
});

test('formatResult produces a string with the scenario name', function () {
    const r = {
        name: 'test-scenario', N: 1000, k: 4,
        minorLo: 0, minorHi: 0, majorLo: 0, majorHi: 0,
        retainedKB_lo: 0, retainedKB_hi: 5,
        counters_lo: null, counters_hi: null
    };
    const s = formatResult(r);
    assert.ok(s.includes('test-scenario'));
    assert.ok(s.includes('scavenges'));
    assert.ok(s.includes('retained'));
});

test('formatResult includes counter deltas when present', function () {
    const r = {
        name: 'with-counters', N: 1000, k: 4,
        minorLo: 0, minorHi: 0, majorLo: 0, majorHi: 0,
        retainedKB_lo: 0, retainedKB_hi: 5,
        counters_lo: { poolGrowths: 0, totalAllocs: 100 },
        counters_hi: { poolGrowths: 0, totalAllocs: 800 }
    };
    const s = formatResult(r);
    assert.ok(s.includes('poolGrowths'));
    assert.ok(s.includes('totalAllocs'));
});

test('measure returns correct shape', async function () {
    const sc = {
        name: 'shape-check',
        setup: function () { return { acc: 0 }; },
        hot: function (s, n) { for (let i = 0; i < n; i++) s.acc += i; }
    };
    const r = await measure(sc, { N: 1000, k: 2 });
    assert.equal(r.name, 'shape-check');
    assert.equal(r.N, 1000);
    assert.equal(r.k, 2);
    assert.equal(typeof r.minorLo, 'number');
    assert.equal(typeof r.minorHi, 'number');
    assert.equal(typeof r.retainedKB_hi, 'number');
    assert.equal(r.counters_hi, null);
});

test('measure computes counter deltas from statsOf', async function () {
    let allocCount = 0;
    const sc = {
        name: 'counter-delta',
        setup: function () { allocCount = 0; return {}; },
        hot: function (_s, n) { allocCount += n; },
        statsOf: function () { return { allocs: allocCount }; }
    };
    const r = await measure(sc, { N: 1000, k: 2 });
    assert.ok(r.counters_hi !== null);
    assert.equal(typeof r.counters_hi.allocs, 'number');
    assert.ok(r.counters_hi.allocs >= 2000, 'expected ~k*N counter delta');
});

test('flushMs option is honored (short value still measures correctly on local runs)', async function () {
    // Verifies the option plumbs through measure() -> meterOnce() and the
    // observer still catches scavenges on a fast machine even with a
    // trimmed wait. CI runners may need the default 100ms floor -- this
    // test uses a permissive threshold so it doesn't flake on slow CI.
    const r = await measure(controlPositive, { N: 100000, k: 4, flushMs: 20 });
    _controlKeepAlive();
    assert.ok(r.minorHi > 0, 'flushMs still allows observer to catch some entries locally');
});

// ---------------------------------------------------------------------------
// suiteGate (v1.1) -- SPP stream-fed budgets
// ---------------------------------------------------------------------------

// SPP v1 packing, PROTOCOL.md section 2 (protocol, not a package import).
function spp(stream, op) { return ((stream << 16) | op) >>> 0; }
const OP_CONT = 0x0F01;

function slabOf(records) {
    const out = new Float64Array(records.length * 4);
    for (let i = 0; i < records.length; i++) out.set(records[i], i * 4);
    return out;
}

test('suiteGate: passing budget over a slab', function () {
    const slab = slabOf([
        [spp(2, 0x0201), 1, 3, 0],
        [spp(2, 0x0201), 2, 5, 0]
    ]);
    const g = suiteGate({
        source: slab,
        budgets: [{ name: 'gc.pause.max', stream: 2, op: 0x0201, slot: 'a', reduce: 'max', max: 8 }]
    });
    assert.equal(g.pass, true);
    assert.deepEqual(g.reasons, []);
    assert.equal(g.budgets[0].value, 5);
    assert.equal(g.budgets[0].count, 2);
});

test('suiteGate: failing budget produces verdict()-formatted reasons', function () {
    const slab = slabOf([[spp(2, 0x0201), 1, 12, 0]]);
    const g = suiteGate({
        source: slab,
        budgets: [{ name: 'gc.pause.max', stream: 2, op: 0x0201, max: 8 }]
    });
    assert.equal(g.pass, false);
    assert.equal(g.budgets[0].pass, false);
    // Reason text comes verbatim from verdict(): 'key: actual > max'
    assert.deepEqual(g.reasons, ['gc.pause.max: 12 > 8']);
    // Delegation cross-check: verdict() alone produces the identical reason.
    const v = verdict(
        { name: 'x', minorHi: 0, majorHi: 0, retainedKB_hi: 0, counters_hi: { 'gc.pause.max': 12 } },
        { counters: { 'gc.pause.max': 8 } }
    );
    assert.deepEqual(g.reasons, v.reasons);
});

test('suiteGate: reduce modes count, sum, max, mean, last', function () {
    const slab = slabOf([
        [spp(1, 0x0100), 1, 10, 0],
        [spp(1, 0x0100), 2, 20, 0],
        [spp(1, 0x0100), 3, 6, 0]
    ]);
    const g = suiteGate({
        source: slab,
        budgets: [
            { name: 'n', op: 0x0100, reduce: 'count', max: 99 },
            { name: 's', op: 0x0100, reduce: 'sum', max: 99 },
            { name: 'x', op: 0x0100, reduce: 'max', max: 99 },
            { name: 'm', op: 0x0100, reduce: 'mean', max: 99 },
            { name: 'l', op: 0x0100, reduce: 'last', max: 99 }
        ]
    });
    const byName = {};
    for (const b of g.budgets) byName[b.name] = b.value;
    assert.deepEqual(byName, { n: 3, s: 36, x: 20, m: 12, l: 6 });
});

test('suiteGate: slot selection t, a, b', function () {
    const slab = slabOf([[spp(1, 0x0100), 7, 8, 9]]);
    const g = suiteGate({
        source: slab,
        budgets: [
            { name: 't', op: 0x0100, slot: 't', max: 99 },
            { name: 'a', op: 0x0100, slot: 'a', max: 99 },
            { name: 'b', op: 0x0100, slot: 'b', max: 99 }
        ]
    });
    assert.deepEqual(g.budgets.map(function (b) { return b.value; }), [7, 8, 9]);
});

test('suiteGate: packed, stream+op, and op-only matching', function () {
    const slab = slabOf([
        [spp(1, 0x0100), 1, 1, 0],
        [spp(2, 0x0100), 2, 2, 0],
        [spp(2, 0x0201), 3, 4, 0]
    ]);
    const g = suiteGate({
        source: slab,
        budgets: [
            { name: 'packed', packed: spp(2, 0x0201), reduce: 'count', max: 99 },
            { name: 'streamop', stream: 1, op: 0x0100, reduce: 'count', max: 99 },
            { name: 'oponly', op: 0x0100, reduce: 'count', max: 99 }
        ]
    });
    const byName = {};
    for (const b of g.budgets) byName[b.name] = b.value;
    assert.deepEqual(byName, { packed: 1, streamop: 1, oponly: 2 });
});

test('suiteGate: zero-match budget reduces to 0 with count 0', function () {
    const slab = slabOf([[spp(1, 0x0100), 1, 50, 0]]);
    const g = suiteGate({
        source: slab,
        budgets: [{ name: 'quiet', op: 0x0300, reduce: 'max', max: 5 }]
    });
    assert.equal(g.pass, true);
    assert.equal(g.budgets[0].value, 0);
    assert.equal(g.budgets[0].count, 0);
});

test('suiteGate: accepts a forEach record source (memory-sink shaped)', function () {
    const records = [[spp(1, 0x0100), 1, 3, 0], [spp(1, 0x0100), 2, 9, 0]];
    const source = {
        forEach: function (cb) {
            for (const r of records) cb(r[0], r[1], r[2], r[3]);
        }
    };
    const g = suiteGate({
        source: source,
        budgets: [{ name: 'x', op: 0x0100, max: 10 }]
    });
    assert.equal(g.pass, true);
    assert.equal(g.budgets[0].value, 9);
});

test('suiteGate: CONT records never match budgets', function () {
    const slab = slabOf([
        [spp(1, 0x0101), 1, 2, 0],
        [spp(1, OP_CONT), 500, 500, 500] // continuation payload must not gate
    ]);
    const g = suiteGate({
        source: slab,
        budgets: [
            { name: 'base', op: 0x0101, reduce: 'max', max: 5 },
            { name: 'cont', op: OP_CONT, reduce: 'count', max: 0 }
        ]
    });
    assert.equal(g.pass, true);
    assert.equal(g.budgets[0].value, 2);
    assert.equal(g.budgets[1].value, 0);
});

test('suiteGate: validation throws at init, with budget names in messages', function () {
    const slab = new Float64Array(0);
    assert.throws(function () { suiteGate({ source: slab, budgets: [] }); }, TypeError);
    assert.throws(function () {
        suiteGate({ source: slab, budgets: [{ name: 'x', op: 0x0100, max: 1 }, { name: 'x', op: 0x0101, max: 1 }] });
    }, /duplicate budget name/);
    assert.throws(function () {
        suiteGate({ source: slab, budgets: [{ name: 'x', op: 0x0100, max: 1, reduce: 'p95' }] });
    }, /reduce must be/);
    assert.throws(function () {
        suiteGate({ source: slab, budgets: [{ name: 'x', op: 0x0100, max: 1, slot: 'c' }] });
    }, /slot must be/);
    assert.throws(function () {
        suiteGate({ source: slab, budgets: [{ name: 'x', max: 1 }] });
    }, RangeError);
    assert.throws(function () {
        suiteGate({ source: new Float64Array(3), budgets: [{ name: 'x', op: 0x0100, max: 1 }] });
    }, /divisible by 4/);
});

// ---------------------------------------------------------------------------
// toNDJSON (v1.2)
// ---------------------------------------------------------------------------

test('toNDJSON: suiteGate result -> budget lines then summary line', function () {
    const slab = slabOf([[spp(2, 0x0201), 1, 12, 0]]);
    const g = suiteGate({
        source: slab, name: 'ci-gate',
        budgets: [{ name: 'gc.pause.max', op: 0x0201, max: 8 }]
    });
    const nd = toNDJSON(g, { pkg: 'lite-signal', run: 42 });
    const lines = nd.trim().split('\n').map(function (l) { return JSON.parse(l); });
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], {
        pkg: 'lite-signal', run: 42, type: 'budget', gate: 'ci-gate',
        name: 'gc.pause.max', value: 12, count: 1, max: 8, pass: false
    });
    assert.equal(lines[1].type, 'suite-gate');
    assert.equal(lines[1].pass, false);
    assert.deepEqual(lines[1].reasons, ['gc.pause.max: 12 > 8']);
    assert.ok(nd.endsWith('\n'));
});

test('toNDJSON: measure result line', async function () {
    const r = await measure(controlNegative, OPTS);
    const nd = toNDJSON(r, { pkg: 'x' });
    const line = JSON.parse(nd.trim());
    assert.equal(line.type, 'measure');
    assert.equal(line.name, controlNegative.name);
    assert.equal(line.N, OPTS.N);
    assert.equal(typeof line.minorHi, 'number');
});

test('toNDJSON: array input mixes result kinds; meta never overrides core fields', async function () {
    const slab = slabOf([[spp(1, 0x0100), 1, 1, 0]]);
    const g = suiteGate({ source: slab, budgets: [{ name: 'x', op: 0x0100, max: 5 }] });
    const r = await measure(controlNegative, OPTS);
    const nd = toNDJSON([g, r], { type: 'SPOOFED', run: 7 });
    const lines = nd.trim().split('\n').map(function (l) { return JSON.parse(l); });
    assert.deepEqual(lines.map(function (l) { return l.type; }), ['budget', 'suite-gate', 'measure']);
    assert.ok(lines.every(function (l) { return l.run === 7; }));
});

test('toNDJSON: rejects unknown row shapes', function () {
    assert.throws(function () { toNDJSON({ nope: 1 }); }, TypeError);
});

// ---------------------------------------------------------------------------
// zgcSuite end-to-end (child processes) -- PG-15
// ---------------------------------------------------------------------------

function runFixture(name) {
    const abs = fileURLToPath(new URL('./fixtures/' + name, import.meta.url));
    return spawnSync(
        process.execPath,
        ['--expose-gc', '--max-semi-space-size=4', '--test', abs],
        { encoding: 'utf8', timeout: 60000 }
    );
}

test('zgcSuite is green end-to-end at library defaults (child process)', function () {
    const r = runFixture('default-suite.test.mjs');
    assert.equal(r.status, 0,
        'default zgcSuite should pass at library defaults\n' + r.stdout + r.stderr);
});

// The sabotaged control (stock grow-forever shape) is detected DETERMINISTICALLY
// only OUTSIDE a test runner: under `node --test` the runner's own allocations
// land inside the measurement window and scale with its length, masking a
// pretenured control (decisions/0001 -- the reason T1 spawns bare children,
// and the reason this proof does NOT run zgcSuite under --test). It exercises
// the SHARED validateDetector predicate -- the same code zgcSuite's detector
// test calls -- via runGate in a bare child process, which has no harness
// allocations in the window and so rejects the sabotage every run. The
// `.test.mjs` fixture's own red path is checked directly (not under a parent's
// load) in the release checklist.
const PERFGATE_URL = pathToFileURL(fileURLToPath(new URL('../PerfGate.js', import.meta.url))).href;

test('runGate goes red when the positive control is sabotaged (bare child)', function () {
    const code = [
        'import { runGate } from ' + JSON.stringify(PERFGATE_URL) + ';',
        'const sink = [];',
        'const stock = { name: "stock", setup: () => ({}), hot: (_s, n) => {',
        '  for (let i = 0; i < n; i++) sink.push({ x: i, y: i + 1, z: i + 2, w: i + 3 });',
        '  if (sink.length > 3000000) sink.length = 0;',
        '} };',
        // N is pinned SMALL for the same reason as test/fixtures/sabotaged-suite.test.mjs:
        // a short window lets pretenuring drop the control's minorHi below CONTROL_FLOOR
        // deterministically, whereas at library defaults the pretenured site intermittently
        // clears the floor and the scale clause under load (~31% false-green observed).
        'const out = await runGate({ scenarios: [], allowEmpty: true, positiveControl: stock, N: 20000, k: 8 });',
        // Carry the process contract out on stdout: code 2 (detector), passed
        // false, and process.exitCode UNTOUCHED (read before the explicit exit).
        'process.stdout.write("PG2 " + JSON.stringify({ code: out.code, passed: out.passed, exitCode: String(process.exitCode) }) + "\\n");',
        'process.exit(out.passed ? 0 : 1);'
    ].join('\n');
    const r = spawnSync(
        process.execPath,
        ['--expose-gc', '--max-semi-space-size=4', '--input-type=module', '-e', code],
        { encoding: 'utf8', timeout: 60000 }
    );
    assert.notEqual(r.status, 0, 'sabotaged runGate must fail:\n' + r.stdout + r.stderr);
    assert.match(r.stdout, /DETECTOR VALIDATION FAILED/);
    assert.match(r.stdout, /need >=6/);
    const pg2 = JSON.parse(r.stdout.split('\n').filter(function (l) { return l.indexOf('PG2 ') === 0; }).pop().slice(4));
    assert.equal(pg2.code, 2, 'detector failure is code 2');
    assert.equal(pg2.passed, false);
    assert.equal(pg2.passed, pg2.code === 0);
    assert.equal(pg2.exitCode, 'undefined', 'runGate must not touch process.exitCode');
});

// ---------------------------------------------------------------------------
// Fail-closed doors (v1.4.0, decision 0002) -- PG-04/05/08/09/11/14
// ---------------------------------------------------------------------------

test('verdict: threshold doors throw at config time', function () {
    const r = { name: 'x', minorHi: 999, retainedKB_hi: 9999, counters_hi: { g: 1 } };
    assert.throws(function () { verdict(r, { maxScavenges: NaN }); }, RangeError);
    assert.throws(function () { verdict(r, { maxScavenges: -1 }); }, RangeError);
    assert.throws(function () { verdict(r, { maxRetainedKB: NaN }); }, RangeError);
    assert.throws(function () { verdict(r, { counters: { g: NaN } }); }, RangeError);
    // twins one valid step away pass on a clean result
    const clean = { name: 'x', minorHi: 0, retainedKB_hi: 0, counters_hi: { g: 0 } };
    assert.equal(verdict(clean, { maxScavenges: 2 }).pass, true);
    assert.equal(verdict(clean, { maxRetainedKB: 0 }).pass, true);
    assert.equal(verdict(clean, { counters: { g: 0 } }).pass, true);
});

test('verdict: NaN measurements fail closed with named reasons', function () {
    // PG-C2: a result whose gated signals are NaN, against DEFAULT thresholds.
    const bad = { name: 'x', minorHi: NaN, retainedKB_hi: NaN, counters_hi: null };
    const v = verdict(bad);
    assert.equal(v.pass, false);
    assert.ok(v.reasons.includes('scavenges: not a number (fail closed)'));
    assert.ok(v.reasons.includes('retained: not a number (fail closed)'));
    // A3/A2 exact-order proof with the counter lane engaged.
    const bad2 = { name: 'x', minorHi: NaN, retainedKB_hi: NaN, counters_hi: { g: NaN } };
    const v2 = verdict(bad2, { counters: { g: 0 } });
    assert.equal(v2.pass, false);
    assert.deepEqual(v2.reasons, [
        'scavenges: not a number (fail closed)',
        'retained: not a number (fail closed)',
        'g: not a number (fail closed)'
    ]);
    // twin with 0/0 passes.
    const good = { name: 'x', minorHi: 0, retainedKB_hi: 0, counters_hi: null };
    assert.equal(verdict(good).pass, true);
});

test('verdict: unknown and absent counters fail closed', function () {
    // PG-D typo: threshold key poolGrowth vs measured poolGrowths.
    const typo = { name: 'x', minorHi: 0, retainedKB_hi: 0, counters_hi: { poolGrowths: 99 } };
    const v1 = verdict(typo, { counters: { poolGrowth: 0 } });
    assert.equal(v1.pass, false);
    assert.deepEqual(v1.reasons, ['poolGrowth: no such counter measured (statsOf keys: poolGrowths)']);
    // counters_hi null (scenario had no statsOf) -> one reason naming the keys.
    const noStats = { name: 'x', minorHi: 0, retainedKB_hi: 0, counters_hi: null };
    const v2 = verdict(noStats, { counters: { poolGrowth: 0 } });
    assert.equal(v2.pass, false);
    assert.equal(v2.reasons.length, 1);
    assert.ok(v2.reasons[0].startsWith('counters: thresholds set (poolGrowth)'));
    assert.ok(v2.reasons[0].endsWith('(fail closed)'));
    // twin with the correct key -> ordinary over-budget reason.
    const v3 = verdict(typo, { counters: { poolGrowths: 0 } });
    assert.equal(v3.pass, false);
    assert.deepEqual(v3.reasons, ['poolGrowths: 99 > 0']);
});

test('measure: option doors throw, flushMs 0 is honored', async function () {
    const bads = [{ N: -1 }, { N: 0 }, { N: 1.5 }, { k: 0.5 }, { k: 1 }, { k: NaN },
        { flushMs: -50 }, { flushMs: NaN }, { flushMs: '10' }, { allowNoGc: 1 }, { allowNoGc: 'yes' }];
    for (const opts of bads) {
        await assert.rejects(measure(controlNegative, opts), function (e) {
            return (e instanceof RangeError || e instanceof TypeError) &&
                e.message.indexOf('lite-perf-gate: measure: ') === 0;
        }, 'expected throw for ' + JSON.stringify(opts));
    }
    // twins resolve.
    const tiny = { name: 't', setup: function () { return { a: 0 }; }, hot: function (s, n) { for (let i = 0; i < n; i++) s.a += i; } };
    await measure(tiny, { N: 1, k: 2 });
    await measure(tiny, { flushMs: 0 });
    // timing proof: flushMs 0 reaches sleep(0), flushMs 200 costs 2 passes.
    const s0 = Date.now(); await measure(tiny, { N: 1, k: 2, flushMs: 0 }); const d0 = Date.now() - s0;
    const s1 = Date.now(); await measure(tiny, { N: 1, k: 2, flushMs: 200 }); const d200 = Date.now() - s1;
    assert.ok(d0 < 150, 'flushMs 0 should be fast, saw ' + d0 + 'ms');
    assert.ok(d200 >= 400, 'flushMs 200 (two passes) >= 400ms, saw ' + d200 + 'ms');
    assert.ok(d200 - d0 >= 300, 'delta >= 300ms, saw ' + (d200 - d0) + 'ms');
});

test('zgcSuite/runGate: empty gates throw, allowEmpty opens them', async function () {
    assert.throws(function () { zgcSuite({ scenarios: [] }); }, /non-empty array|must be an array/);
    assert.throws(function () { zgcSuite({}); }, /non-empty array|must be an array/);
    await assert.rejects(runGate({ scenarios: [] }), /non-empty array|must be an array/);
    await assert.rejects(runGate({ scenarios: 'x' }), /non-empty array|must be an array/);
    // allowEmpty opens the gate: the child fixture registers exactly the one
    // detector test and names its reduced job. Proven via TAP, not by
    // re-registering a test in this file (which would run under the parent).
    // Spawned WITHOUT --test (node:test auto-runs top-level tests) and with
    // NODE_TEST_CONTEXT stripped, so the parent runner does not make the child
    // skip its files as a recursive run.
    const abs = fileURLToPath(new URL('./fixtures/empty-allowed.test.mjs', import.meta.url));
    const childEnv = Object.assign({}, process.env);
    delete childEnv.NODE_TEST_CONTEXT;
    const r = spawnSync(
        process.execPath,
        ['--expose-gc', '--max-semi-space-size=4', abs],
        { encoding: 'utf8', timeout: 60000, env: childEnv }
    );
    assert.equal(r.status, 0, 'empty-allowed fixture should pass\n' + r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /detector validation only \(allowEmpty, 0 scenarios\)/);
});

test('runGate: code 0 and code 1 (bare children, library defaults)', function () {
    function child(cfgSrc) {
        const src = [
            'import { runGate, controlNegative } from ' + JSON.stringify(PERFGATE_URL) + ';',
            'void controlNegative;',
            'const out = await runGate(' + cfgSrc + ');',
            'process.stdout.write("PG2 " + JSON.stringify({ code: out.code, passed: out.passed, results: out.results.length, exitCode: String(process.exitCode) }) + "\\n");',
            'process.exit(0);'
        ].join('\n');
        const r = spawnSync(
            process.execPath,
            ['--expose-gc', '--max-semi-space-size=4', '--input-type=module', '-e', src],
            { encoding: 'utf8', timeout: 60000 }
        );
        assert.equal(r.status, 0, 'child errored\n' + r.stdout + r.stderr);
        return JSON.parse(r.stdout.split('\n').filter(function (l) { return l.indexOf('PG2 ') === 0; }).pop().slice(4));
    }
    const c0 = child('{ scenarios: [], allowEmpty: true }');
    assert.equal(c0.code, 0);
    assert.equal(c0.passed, true);
    assert.equal(c0.results, 0);
    assert.equal(c0.exitCode, 'undefined');
    assert.equal(c0.passed, c0.code === 0);

    // A pure-arithmetic must-fail can never trip the gate: MISSED -> code 1.
    const c1 = child('{ scenarios: [], allowEmpty: true, mustFail: [controlNegative] }');
    assert.equal(c1.code, 1);
    assert.equal(c1.passed, false);
    assert.equal(c1.results, 0);
    assert.equal(c1.exitCode, 'undefined');
    assert.equal(c1.passed, c1.code === 0);
});
