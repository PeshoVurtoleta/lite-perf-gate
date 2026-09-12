// Self-test for @zakkster/lite-perf-gate.
// Run: node --expose-gc --max-semi-space-size=4 --test test/self.test.mjs
//
// This file tests the HARNESS, not a consumer engine. It proves:
//   1. The positive control forces scavenges (detector works).
//   2. The negative control forces ~0 scavenges (no false positives).
//   3. verdict() returns pass for a clean result.
//   4. verdict() returns fail with reasons for a dirty result.
//   5. zgcSuite registers tests against the built-in controls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    measure, verdict, formatResult,
    controlPositive, controlNegative,
    _controlKeepAlive, VERSION,
    suiteGate, toNDJSON
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
