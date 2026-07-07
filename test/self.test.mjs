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
import {
    measure, verdict, formatResult,
    controlPositive, controlNegative,
    _controlKeepAlive, VERSION
} from '../PerfGate.js';

assert.ok(typeof globalThis.gc === 'function', 'run with --expose-gc');

const OPTS = { N: 100000, k: 4 };

test('VERSION is set', function () {
    assert.equal(VERSION, '1.0.0');
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
