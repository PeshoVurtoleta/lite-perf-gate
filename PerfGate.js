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

export const VERSION = '1.2.0';

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

async function gc2() {
    if (typeof globalThis.gc === 'function') {
        globalThis.gc();
        // Yield one task tick so any FinalizationRegistry cleanup callbacks
        // registered from the first gc() get a chance to run before the
        // second pass. Without this, WeakRef/FinalizationRegistry-driven
        // teardown (used across the ecosystem in lite-cleanup / lite-observe
        // / lite-floating) can leave the heap in an intermediate state
        // between the two collections, inflating the retained delta.
        await new Promise(function (r) {
            setImmediate(r);
        });
        globalThis.gc();
    }
}

// Default post-hot sleep before reading the GC observer buffer. The Node
// perf_hooks 'gc' entries are delivered asynchronously, so we need to yield
// long enough for the observer callback to fire. 100ms is a safe floor on
// most systems; noisy CI runners (shared GitHub Actions, Docker under
// contention) can stall the event loop for tens of milliseconds and drop
// entries with a shorter wait. Override per-measurement via the `flushMs`
// option, or globally via the PERF_GATE_FLUSH_MS environment variable.
let DEFAULT_FLUSH_MS = 100;
if (typeof process !== 'undefined' && process.env && process.env.PERF_GATE_FLUSH_MS) {
    const envMs = parseInt(process.env.PERF_GATE_FLUSH_MS, 10);
    if (envMs > 0 && envMs < 60000) DEFAULT_FLUSH_MS = envMs;
}

// ---------------------------------------------------------------------------
// Core measurement
// ---------------------------------------------------------------------------

async function meterOnce(scenario, iters, flushMs) {
    const state = scenario.setup();
    scenario.hot(state, Math.min(iters, 20000));
    await gc2();

    const statsBefore = scenario.statsOf ? scenario.statsOf(state) : null;
    const heapBefore = process.memoryUsage().heapUsed;

    const gcc = makeGcCounter();
    scenario.hot(state, iters);
    await sleep(flushMs);
    const minor = gcc.c.minor;
    const major = gcc.c.major;
    gcc.close();

    await gc2();
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
 * @param {{ N?: number, k?: number, flushMs?: number }} [options]
 *   flushMs: how long to wait after the hot loop before reading the GC
 *   observer buffer. Default 100ms (or PERF_GATE_FLUSH_MS env var).
 *   Bump if you see zero scavenges on scenarios that should allocate --
 *   noisy CI runners may need 250-500ms.
 * @returns {Promise<MeasureResult>}
 */
export async function measure(scenario, options) {
    const N = (options && options.N) || 200000;
    const k = (options && options.k) || 8;
    const flushMs = (options && options.flushMs) || DEFAULT_FLUSH_MS;
    const lo = await meterOnce(scenario, N, flushMs);
    const hi = await meterOnce(scenario, k * N, flushMs);
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
    const opts = {N: config.N || 200000, k: config.k || 8, flushMs: config.flushMs};
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
    const opts = {N: config.N || 200000, k: config.k || 8, flushMs: config.flushMs};
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

// ---------------------------------------------------------------------------
// suiteGate -- SPP stream-fed budgets (v1.1)
// ---------------------------------------------------------------------------
// lite-perf-gate does NOT import @zakkster/lite-scope. Probes, gates, and
// consumers are coupled by the Scope Probe Protocol (SPP v1 -- PROTOCOL.md
// in lite-scope), never by packages. The two protocol facts used here:
//   - a record is 4 numbers [packed, t, a, b], where
//     packed = (streamId << 16 | opcode) >>> 0, both u16;
//   - opcode 0x0F01 (CONT) is a wide-record continuation and is never a
//     budget target. Budgets therefore see the base record's t/a/b slots;
//     extended CONT payload slots are out of scope for v1.1 (a lite-scope
//     side bridge can pre-reduce wide records if that ever gates).
// suiteGate never touches process exit codes: runner semantics (0 pass /
// 1 regression / 3 recapture in the VersionMatrix scripts, 0/1/2 in
// runGate) stay in the runner layer. All threshold comparison is delegated
// to verdict() -- one comparison authority, per-budget.

const SPP_OP_CONT = 0x0F01;

const SUITE_REDUCES = {count: 1, sum: 1, max: 1, mean: 1, last: 1};
const SUITE_SLOTS = {t: 1, a: 2, b: 3};

function suiteMatcher(b, i) {
    if (b.packed !== undefined) {
        if (!Number.isInteger(b.packed) || b.packed < 0 || b.packed > 0xFFFFFFFF) {
            throw new RangeError('suiteGate: budget[' + i + '] packed must be a u32');
        }
        return {exact: b.packed >>> 0, op: -1};
    }
    if (b.op === undefined || !Number.isInteger(b.op) || b.op < 0 || b.op > 0xFFFF) {
        throw new RangeError('suiteGate: budget[' + i + '] needs a u16 op (with optional stream), or packed');
    }
    if (b.stream !== undefined) {
        if (!Number.isInteger(b.stream) || b.stream < 0 || b.stream > 0xFFFF) {
            throw new RangeError('suiteGate: budget[' + i + '] stream must be a u16');
        }
        return {exact: ((b.stream << 16) | b.op) >>> 0, op: -1};
    }
    return {exact: -1, op: b.op}; // op-only: matches the op on any stream
}

/**
 * Evaluate SPP stream records against numeric budgets. Pure reduction plus
 * per-budget delegation to verdict(); no measurement, no exit codes, no
 * record emission (callers bridge verdicts to GATE_VERDICT meta records).
 *
 * @param {object} config
 * @param {Float64Array | { forEach: (cb: (packed: number, t: number, a: number, b: number) => void) => void }} config.source
 *   A contiguous SPP slab (length divisible by 4) or any forEach-style
 *   record source (e.g. a lite-scope memory sink).
 * @param {Array<{
 *   name: string,
 *   packed?: number, stream?: number, op?: number,
 *   slot?: 't' | 'a' | 'b',
 *   reduce?: 'count' | 'sum' | 'max' | 'mean' | 'last',
 *   max: number
 * }>} config.budgets
 *   slot defaults to 'a', reduce to 'max'. Budgets that match zero records
 *   reduce to 0 (count 0 is reported so callers can tell silence from luck).
 * @param {string} [config.name='suite-gate']
 * @returns {{
 *   name: string, pass: boolean, reasons: string[],
 *   budgets: Array<{ name: string, value: number, count: number, max: number, pass: boolean, reasons: string[] }>
 * }}
 */
export function suiteGate(config) {
    if (!config || typeof config !== 'object') {
        throw new TypeError('suiteGate: expects a config object');
    }
    const source = config.source;
    const budgets = config.budgets;
    if (!Array.isArray(budgets) || budgets.length === 0) {
        throw new TypeError('suiteGate: budgets must be a non-empty array');
    }

    const n = budgets.length;
    const match = new Array(n);
    const slot = new Array(n);
    const reduce = new Array(n);
    const seen = {};
    for (let i = 0; i < n; i++) {
        const b = budgets[i];
        if (!b || typeof b.name !== 'string' || b.name.length === 0) {
            throw new TypeError('suiteGate: budget[' + i + '] needs a non-empty name');
        }
        if (seen[b.name]) throw new RangeError('suiteGate: duplicate budget name "' + b.name + '"');
        seen[b.name] = 1;
        if (typeof b.max !== 'number' || !isFinite(b.max)) {
            throw new RangeError('suiteGate: budget "' + b.name + '" needs a finite numeric max');
        }
        const sl = b.slot === undefined ? 'a' : b.slot;
        if (SUITE_SLOTS[sl] === undefined) {
            throw new RangeError('suiteGate: budget "' + b.name + '" slot must be t, a, or b');
        }
        const rd = b.reduce === undefined ? 'max' : b.reduce;
        if (SUITE_REDUCES[rd] === undefined) {
            throw new RangeError('suiteGate: budget "' + b.name + '" reduce must be count, sum, max, mean, or last');
        }
        match[i] = suiteMatcher(b, i);
        slot[i] = SUITE_SLOTS[sl];
        reduce[i] = rd;
    }

    const count = new Float64Array(n);
    const sum = new Float64Array(n);
    const maxv = new Float64Array(n);
    const last = new Float64Array(n);
    maxv.fill(-Infinity);

    function visit(packed, t, a, b) {
        const op = packed & 0xFFFF;
        if (op === SPP_OP_CONT) return;
        for (let i = 0; i < n; i++) {
            const m = match[i];
            if (m.exact >= 0 ? (packed >>> 0) !== m.exact : op !== m.op) continue;
            const val = slot[i] === 1 ? t : slot[i] === 2 ? a : b;
            count[i] += 1;
            sum[i] += val;
            if (val > maxv[i]) maxv[i] = val;
            last[i] = val;
        }
    }

    if (source && typeof source.forEach === 'function' && !(source instanceof Float64Array)) {
        source.forEach(visit);
    } else if (source instanceof Float64Array) {
        if (source.length % 4 !== 0) {
            throw new RangeError('suiteGate: slab length must be divisible by 4');
        }
        for (let r = 0; r < source.length; r += 4) {
            visit(source[r], source[r + 1], source[r + 2], source[r + 3]);
        }
    } else {
        throw new TypeError('suiteGate: source must be a Float64Array slab or a forEach record source');
    }

    const perBudget = [];
    const reasons = [];
    let pass = true;
    for (let i = 0; i < n; i++) {
        const b = budgets[i];
        let value;
        if (reduce[i] === 'count') value = count[i];
        else if (reduce[i] === 'sum') value = sum[i];
        else if (reduce[i] === 'max') value = count[i] > 0 ? maxv[i] : 0;
        else if (reduce[i] === 'mean') value = count[i] > 0 ? sum[i] / count[i] : 0;
        else value = count[i] > 0 ? last[i] : 0;

        const counters = {};
        counters[b.name] = value;
        const ct = {};
        ct[b.name] = b.max;
        const v = verdict(
            {name: b.name, minorHi: 0, majorHi: 0, retainedKB_hi: 0, counters_hi: counters},
            {counters: ct}
        );
        if (!v.pass) pass = false;
        for (let ri = 0; ri < v.reasons.length; ri++) reasons.push(v.reasons[ri]);
        perBudget.push({
            name: b.name, value: value, count: count[i], max: b.max,
            pass: v.pass, reasons: v.reasons
        });
    }

    return {
        name: typeof config.name === 'string' ? config.name : 'suite-gate',
        pass: pass,
        reasons: reasons,
        budgets: perBudget
    };
}

// ---------------------------------------------------------------------------
// toNDJSON -- verdict output for CI artifacts (v1.2)
// ---------------------------------------------------------------------------

function ndjsonSuiteGate(r, meta, lines) {
    for (let i = 0; i < r.budgets.length; i++) {
        const b = r.budgets[i];
        lines.push(JSON.stringify(Object.assign({}, meta, {
            type: 'budget', gate: r.name, name: b.name,
            value: b.value, count: b.count, max: b.max, pass: b.pass
        })));
    }
    lines.push(JSON.stringify(Object.assign({}, meta, {
        type: 'suite-gate', name: r.name, pass: r.pass, reasons: r.reasons
    })));
}

function ndjsonMeasure(r, meta, lines) {
    lines.push(JSON.stringify(Object.assign({}, meta, {
        type: 'measure', name: r.name, N: r.N, k: r.k,
        minorLo: r.minorLo, minorHi: r.minorHi,
        majorLo: r.majorLo, majorHi: r.majorHi,
        retainedKB_lo: r.retainedKB_lo, retainedKB_hi: r.retainedKB_hi,
        counters_lo: r.counters_lo, counters_hi: r.counters_hi
    })));
}

/**
 * Serialize gate output as NDJSON for CI artifacts: one JSON object per
 * line, budget lines before their suite-gate summary line, trailing
 * newline. Accepts a suiteGate() result, a measure() result, or an array
 * mixing both. `meta` fields (run id, package, version, ...) are merged
 * into every line; core fields win on collision.
 *
 * @param {object | object[]} x
 * @param {object} [meta]
 * @returns {string}
 */
export function toNDJSON(x, meta) {
    const rows = Array.isArray(x) ? x : [x];
    const m = meta && typeof meta === 'object' ? meta : {};
    const lines = [];
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r && Array.isArray(r.budgets) && typeof r.pass === 'boolean') {
            ndjsonSuiteGate(r, m, lines);
        } else if (r && typeof r.minorHi === 'number' && typeof r.N === 'number') {
            ndjsonMeasure(r, m, lines);
        } else {
            throw new TypeError('toNDJSON: row ' + i + ' is neither a suiteGate result nor a measure result');
        }
    }
    return lines.join('\n') + '\n';
}