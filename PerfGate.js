/**
 * @zakkster/lite-perf-gate
 * Zero-GC and performance regression gate for node:test.
 *
 * Three measurement signals, each for what it can actually see:
 *   1. Scavenge count (perf_hooks 'gc', minor) -- the reliable detector
 *      of TRANSIENT allocation. Retained-heap misses it (freed before
 *      snapshot); the V8 sampling profiler misses it (reports live-at-stop).
 *   2. Custom counters (user-supplied statsOf) -- exact engine internals.
 *   3. Retained-heap delta (memoryUsage + gc) -- leak detector.
 *
 * Pass/fail uses scaling: measure at N and k*N. Zero-alloc => ~0 scavenges
 * at both; allocation => scavenges scale with total bytes. Controls validate
 * the detector on every run.
 *
 * Copyright (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License
 */

export const VERSION = '1.0.0';

import {PerformanceObserver, constants} from 'node:perf_hooks';
import {setTimeout as sleep} from 'node:timers/promises';
import {test} from 'node:test';
import assert from 'node:assert/strict';

const MINOR = constants.NODE_PERFORMANCE_GC_MINOR;
const MAJOR = constants.NODE_PERFORMANCE_GC_MAJOR;

// ---------------------------------------------------------------------------
// GC counter
// ---------------------------------------------------------------------------

function makeGcCounter() {
    const c = {minor: 0, major: 0};
    const obs = new PerformanceObserver(function (list) {
        for (const e of list.getEntries()) {
            const k = e.detail ? e.detail.kind : e.kind;
            if (k === MINOR) c.minor++;
            else if (k === MAJOR) c.major++;
        }
    });
    obs.observe({entryTypes: ['gc']});
    return {
        c: c, close: function () {
            obs.disconnect();
        }
    };
}

function gc2() {
    if (typeof globalThis.gc === 'function') {
        globalThis.gc();
        globalThis.gc();
    }
}

// ---------------------------------------------------------------------------
// Core measurement
// ---------------------------------------------------------------------------

async function meterOnce(scenario, iters) {
    const state = scenario.setup();
    scenario.hot(state, Math.min(iters, 20000));
    gc2();

    const statsBefore = scenario.statsOf ? scenario.statsOf(state) : null;
    const heapBefore = process.memoryUsage().heapUsed;

    const gcc = makeGcCounter();
    scenario.hot(state, iters);
    await sleep(40);
    const minor = gcc.c.minor;
    const major = gcc.c.major;
    gcc.close();

    gc2();
    const heapAfter = process.memoryUsage().heapUsed;
    const statsAfter = scenario.statsOf ? scenario.statsOf(state) : null;
    if (scenario.teardown) scenario.teardown(state);

    let counters = null;
    if (statsBefore !== null && statsAfter !== null) {
        counters = {};
        for (const key in statsAfter) {
            if (typeof statsAfter[key] === 'number' && typeof statsBefore[key] === 'number') {
                counters[key] = statsAfter[key] - statsBefore[key];
            }
        }
    }

    return {minor: minor, major: major, retainedKB: (heapAfter - heapBefore) / 1024, counters: counters};
}

// ---------------------------------------------------------------------------
// measure -- public, returns raw numbers
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Scenario
 * @property {string} name
 * @property {() => any} setup          Build the graph / state. Called once.
 * @property {(state: any, n: number) => void} hot
 *   The hot loop. Must run `n` iterations against `state`. This is the ONLY
 *   code inside the measurement window.
 * @property {(state: any) => object} [statsOf]
 *   Return an object of numeric counters. Called before and after; deltas
 *   are computed automatically.
 * @property {(state: any) => void} [teardown]
 */

/**
 * Measure a scenario at two iteration counts (N and k*N) to detect
 * allocation via scavenge scaling.
 *
 * @param {Scenario} scenario
 * @param {{ N?: number, k?: number }} [options]
 * @returns {Promise<MeasureResult>}
 */
export async function measure(scenario, options) {
    const N = (options && options.N) || 200000;
    const k = (options && options.k) || 8;
    const lo = await meterOnce(scenario, N);
    const hi = await meterOnce(scenario, k * N);
    return {
        name: scenario.name, N: N, k: k,
        minorLo: lo.minor, minorHi: hi.minor,
        majorLo: lo.major, majorHi: hi.major,
        retainedKB_lo: lo.retainedKB, retainedKB_hi: hi.retainedKB,
        counters_lo: lo.counters, counters_hi: hi.counters
    };
}

// ---------------------------------------------------------------------------
// Built-in controls
// ---------------------------------------------------------------------------

const __posKeep = [];

/** @internal -- reference to keep the positive-control sink alive. */
export function _controlKeepAlive() {
    return __posKeep.length;
}

/** Positive control: allocates a heap object per iteration. */
export const controlPositive = {
    name: 'CONTROL+ (allocates {x,y,z,w} per iter)',
    setup: function () {
        return {};
    },
    hot: function (_s, n) {
        for (let i = 0; i < n; i++) __posKeep.push({x: i, y: i + 1, z: i + 2, w: i + 3});
        if (__posKeep.length > 3000000) __posKeep.length = 0;
    }
};

/** Negative control: pure arithmetic, zero allocation. */
export const controlNegative = {
    name: 'CONTROL- (pure arithmetic)',
    setup: function () {
        return {acc: 0};
    },
    hot: function (s, n) {
        let a = s.acc;
        for (let i = 0; i < n; i++) a += (i * 3) ^ i;
        s.acc = a;
    }
};

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 * Evaluate a measurement against thresholds.
 *
 * @param {MeasureResult} r
 * @param {object} [thresholds]
 * @param {number} [thresholds.maxScavenges=2]
 * @param {number} [thresholds.maxRetainedKB=64]
 * @param {Record<string, number>} [thresholds.counters]
 *   Per-counter maximum allowed delta. E.g. `{ poolGrowths: 0 }`.
 * @returns {{ pass: boolean, reasons: string[] }}
 */
export function verdict(r, thresholds) {
    const maxScav = (thresholds && thresholds.maxScavenges !== undefined) ? thresholds.maxScavenges : 2;
    const maxRetKB = (thresholds && thresholds.maxRetainedKB !== undefined) ? thresholds.maxRetainedKB : 64;
    const ct = (thresholds && thresholds.counters) || null;
    const reasons = [];

    if (r.minorHi > maxScav) {
        reasons.push('scavenges: ' + r.minorHi + ' > ' + maxScav + ' (transient allocation)');
    }
    if (r.retainedKB_hi > maxRetKB) {
        reasons.push('retained: ' + r.retainedKB_hi.toFixed(0) + 'KB > ' + maxRetKB + 'KB');
    }
    if (ct !== null && r.counters_hi !== null) {
        for (const key in ct) {
            const actual = r.counters_hi[key];
            if (actual !== undefined && actual > ct[key]) {
                reasons.push(key + ': ' + actual + ' > ' + ct[key]);
            }
        }
    }
    return {pass: reasons.length === 0, reasons: reasons};
}

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

/**
 * One-line summary of a measurement result.
 * @param {MeasureResult} r
 * @returns {string}
 */
export function formatResult(r) {
    let s = r.name +
        '\n    scavenges  N:' + String(r.minorLo).padStart(3) +
        '  ' + r.k + 'N:' + String(r.minorHi).padStart(3) +
        '   retained ' + r.retainedKB_hi.toFixed(0) + 'KB';
    if (r.counters_hi !== null) {
        for (const key in r.counters_hi) {
            s += '   ' + key + ' \u0394' + String(r.counters_hi[key]).padStart(6);
        }
    }
    return s;
}

// ---------------------------------------------------------------------------
// zgcSuite -- the node:test integration (primary public API)
// ---------------------------------------------------------------------------

/**
 * Register node:test cases that validate detector controls, measure each
 * scenario, and assert the zero-GC verdict.
 *
 * @example
 *   import { zgcSuite } from '@zakkster/lite-perf-gate';
 *
 *   zgcSuite({
 *       scenarios: [
 *           { name: 'deep chain', setup: buildDeep, hot: runDeep,
 *             statsOf: s => s.registry.stats() },
 *       ],
 *       counters: { poolGrowths: 0, totalAllocations: 0 },
 *       mustFail: [injectedAllocScenario]
 *   });
 *
 * Run with: node --expose-gc --max-semi-space-size=4 --test your.test.mjs
 *
 * @param {object} config
 * @param {Scenario[]} config.scenarios       Zero-GC scenarios to gate.
 * @param {number} [config.N=200000]          Iteration count (low).
 * @param {number} [config.k=8]              Scale factor (high = k*N).
 * @param {number} [config.maxScavenges=2]    Max allowed scavenges at k*N.
 * @param {number} [config.maxRetainedKB=64]  Max retained heap growth.
 * @param {Record<string, number>} [config.counters]
 *   Counter thresholds for statsOf deltas.
 * @param {Scenario} [config.positiveControl]  Override positive control.
 * @param {Scenario} [config.negativeControl]  Override negative control.
 * @param {Scenario[]} [config.mustFail]
 *   Scenarios that MUST trip the gate (injected allocation self-tests).
 */
export function zgcSuite(config) {
    const scenarios = config.scenarios;
    const opts = {N: config.N || 200000, k: config.k || 8};
    const thresholds = {
        maxScavenges: config.maxScavenges !== undefined ? config.maxScavenges : 2,
        maxRetainedKB: config.maxRetainedKB !== undefined ? config.maxRetainedKB : 64,
        counters: config.counters || null
    };
    const posCtrl = config.positiveControl || controlPositive;
    const negCtrl = config.negativeControl || controlNegative;
    const mustFail = config.mustFail || [];
    const maxScav = thresholds.maxScavenges;

    test('perf-gate: detector sees a known allocation (positive control)', async function () {
        const r = await measure(posCtrl, opts);
        _controlKeepAlive();
        assert.ok(r.minorHi > maxScav + 3,
            'positive control should force scavenges, saw ' + r.minorHi +
            ' (need >' + (maxScav + 3) + '). Run with --expose-gc --max-semi-space-size=4.');
    });

    test('perf-gate: detector reads ~0 for a non-allocating loop (negative control)', async function () {
        const r = await measure(negCtrl, opts);
        assert.ok(r.minorHi <= maxScav,
            'no-op control forced ' + r.minorHi + ' scavenges (need <=' + maxScav + ')');
    });

    for (let i = 0; i < scenarios.length; i++) {
        (function (sc) {
            test('zero-GC: ' + sc.name, async function () {
                const r = await measure(sc, opts);
                const v = verdict(r, thresholds);
                assert.ok(v.pass,
                    sc.name + ' FAILED:\n  ' + v.reasons.join('\n  ') +
                    '\n  ' + formatResult(r));
            });
        })(scenarios[i]);
    }

    for (let j = 0; j < mustFail.length; j++) {
        (function (sc) {
            test('perf-gate: MUST CATCH ' + sc.name, async function () {
                const r = await measure(sc, opts);
                const v = verdict(r, thresholds);
                assert.ok(!v.pass,
                    'gate failed to flag a known allocation: ' + sc.name +
                    '\n  ' + formatResult(r));
            });
        })(mustFail[j]);
    }
}

// ---------------------------------------------------------------------------
// runGate -- standalone human-readable report
// ---------------------------------------------------------------------------

/**
 * Run a gate check and print a human-readable report. Exit codes:
 *   0 = pass, 1 = allocation detected, 2 = detector validation failed.
 *
 * @param {object} config  Same shape as zgcSuite.
 * @returns {Promise<{ passed: boolean, results: MeasureResult[] }>}
 */
export async function runGate(config) {
    const scenarios = config.scenarios;
    const opts = {N: config.N || 200000, k: config.k || 8};
    const thresholds = {
        maxScavenges: config.maxScavenges !== undefined ? config.maxScavenges : 2,
        maxRetainedKB: config.maxRetainedKB !== undefined ? config.maxRetainedKB : 64,
        counters: config.counters || null
    };
    const posCtrl = config.positiveControl || controlPositive;
    const negCtrl = config.negativeControl || controlNegative;
    const mustFail = config.mustFail || [];
    const maxScav = thresholds.maxScavenges;
    const N = opts.N;
    const k = opts.k;

    console.log('Zero-GC gate \u2014 scavenge scaling (N=' + N + ', ' + k + 'N=' + (k * N) + ')\n');

    const pos = await measure(posCtrl, opts);
    const neg = await measure(negCtrl, opts);
    console.log('== controls ==');
    console.log(formatResult(pos));
    console.log(formatResult(neg));
    _controlKeepAlive();

    if (pos.minorHi <= maxScav + 3 || neg.minorHi > maxScav) {
        console.log('\n!! DETECTOR VALIDATION FAILED: positive ' + pos.minorHi +
            ' (need >' + (maxScav + 3) + '), negative ' + neg.minorHi +
            ' (need <=' + maxScav + ').');
        return {passed: false, results: []};
    }
    console.log('\ndetector validated: positive forced ' + pos.minorHi +
        ' scavenges, negative forced ' + neg.minorHi + '.\n');

    console.log('== scenarios ==');
    const results = [];
    for (let i = 0; i < scenarios.length; i++) {
        const r = await measure(scenarios[i], opts);
        results.push(r);
        console.log(formatResult(r));
    }

    let mustFailOK = true;
    if (mustFail.length > 0) {
        console.log('\n== must-fail (gate self-test) ==');
        for (let j = 0; j < mustFail.length; j++) {
            const mf = await measure(mustFail[j], opts);
            const mfv = verdict(mf, thresholds);
            if (mfv.pass) mustFailOK = false;
            console.log((mfv.pass ? 'MISSED ' : 'CAUGHT ') + formatResult(mf));
        }
    }

    console.log('\n' + '='.repeat(72));
    const failures = [];
    for (let s = 0; s < results.length; s++) {
        const v = verdict(results[s], thresholds);
        console.log('  ' + (v.pass ? 'PASS' : 'FAIL') + '  ' + results[s].name);
        if (!v.pass) {
            failures.push(results[s]);
            for (let ri = 0; ri < v.reasons.length; ri++) {
                console.log('       ' + v.reasons[ri]);
            }
        }
    }
    console.log('='.repeat(72));

    const passed = failures.length === 0 && mustFailOK;
    if (passed) {
        console.log('\nZERO-GC GATE: PASS \u2014 ' + results.length + '/' + results.length + ' scenarios.');
    } else {
        const why = failures.map(function (f) {
            return f.name;
        });
        if (!mustFailOK) why.push('must-fail scenario was not caught');
        console.log('\nZERO-GC GATE: FAIL \u2014 ' + why.join('; '));
    }
    return {passed: passed, results: results};
}
