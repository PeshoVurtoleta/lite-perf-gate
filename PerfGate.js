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

export const VERSION = '1.4.0';

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
// Fail-closed doors (v1.4.0) -- all cold path
// ---------------------------------------------------------------------------

const NO_GC_MSG = 'lite-perf-gate: measure: globalThis.gc is not a function -- ' +
    'the retained signal cannot be measured and the scavenge counts are unsettled. ' +
    'Run: node --expose-gc --max-semi-space-size=4 <entry> ' +
    '(or node --expose-gc --max-semi-space-size=4 --test <file>). ' +
    'Pass allowNoGc: true to gate scavenges and counters only.';
const NO_RETAINED = 'retained is ungateable without --expose-gc ' +
    '(allowNoGc: true with an explicit maxRetainedKB) -- drop one of them.';
const EMPTY_HINT = ' -- pass allowEmpty: true for a controls-only detector smoke run.';

/**
 * The ONE option/threshold/scenario door. measure, verdict, zgcSuite and
 * runGate all call it; nothing bypasses it and there is no skip flag.
 * Cold path by construction -- no caller is a hot body.
 *
 * @param {'measure'|'verdict'|'zgcSuite'|'runGate'} where  message prefix + mode
 * @param {object|undefined|null} cfg   measure options / verdict thresholds / gate config
 * @param {Scenario|null} scenario      the single scenario for measure(), else null
 * @returns {{N: number, k: number, flushMs: number, allowNoGc: boolean, allowEmpty: boolean}}
 * @throws {TypeError|RangeError} naming the field and the offending value
 */
function validateGate(where, cfg, scenario) {
    const P = 'lite-perf-gate: ' + where + ': ';
    if (cfg !== undefined && cfg !== null && typeof cfg !== 'object') {
        throw new TypeError(P + 'config must be an object (got ' + typeof cfg + ')');
    }
    const c = cfg || {};

    let N = 200000;
    if (c.N !== undefined) {
        if (!Number.isInteger(c.N) || c.N < 1) {
            throw new RangeError(P + 'N must be an integer >= 1 (got ' + String(c.N) + ')');
        }
        N = c.N;
    }
    let k = 8;
    if (c.k !== undefined) {
        if (!Number.isInteger(c.k) || c.k < 2) {
            throw new RangeError(P + 'k must be an integer >= 2 (got ' + String(c.k) + ')');
        }
        k = c.k;
    }
    let flushMs = DEFAULT_FLUSH_MS;
    if (c.flushMs !== undefined) {
        if (typeof c.flushMs !== 'number' || !isFinite(c.flushMs) || c.flushMs < 0) {
            throw new RangeError(P + 'flushMs must be a finite number >= 0 (got ' + String(c.flushMs) + ')');
        }
        flushMs = c.flushMs; // 0 is legal and IS honored (PG-09)
    }
    if (c.allowNoGc !== undefined && c.allowNoGc !== true && c.allowNoGc !== false) {
        throw new TypeError(P + 'allowNoGc must be true or false (got ' + String(c.allowNoGc) + ')');
    }
    if (c.allowEmpty !== undefined && c.allowEmpty !== true && c.allowEmpty !== false) {
        throw new TypeError(P + 'allowEmpty must be true or false (got ' + String(c.allowEmpty) + ')');
    }
    const allowNoGc = c.allowNoGc === true;
    const allowEmpty = c.allowEmpty === true;

    if (where !== 'measure') {
        if (c.maxScavenges !== undefined &&
            (typeof c.maxScavenges !== 'number' || !isFinite(c.maxScavenges) || c.maxScavenges < 0)) {
            throw new RangeError(P + 'maxScavenges must be a finite number >= 0 (got ' + String(c.maxScavenges) + ')');
        }
        if (c.maxRetainedKB !== undefined &&
            (typeof c.maxRetainedKB !== 'number' || !isFinite(c.maxRetainedKB) || c.maxRetainedKB < 0)) {
            throw new RangeError(P + 'maxRetainedKB must be a finite number >= 0 (got ' + String(c.maxRetainedKB) + ')');
        }
        if (c.counters !== undefined && c.counters !== null) {
            if (typeof c.counters !== 'object') {
                throw new TypeError(P + 'counters must be an object of numeric maxima (got ' + typeof c.counters + ')');
            }
            for (const key in c.counters) {
                const t = c.counters[key];
                if (typeof t !== 'number' || !isFinite(t)) {
                    throw new RangeError(P + 'counters.' + key + ' must be a finite number (got ' + String(t) + ')');
                }
            }
        }
        if (allowNoGc && c.maxRetainedKB !== undefined) throw new RangeError(P + NO_RETAINED);
    }

    let list = null;
    let labels = null;
    if (where === 'measure') {
        list = [scenario];
        labels = ['scenario'];
    } else if (where === 'zgcSuite' || where === 'runGate') {
        const sc = c.scenarios;
        if (!Array.isArray(sc)) {
            throw new TypeError(P + 'scenarios must be an array (got ' +
                (sc === undefined ? 'undefined' : typeof sc) + ')' + EMPTY_HINT);
        }
        if (sc.length === 0 && !allowEmpty) {
            throw new RangeError(P + 'scenarios must be a non-empty array' + EMPTY_HINT);
        }
        list = [];
        labels = [];
        for (let i = 0; i < sc.length; i++) {
            list.push(sc[i]);
            labels.push('scenarios[' + i + ']');
        }
        if (c.mustFail !== undefined) {
            if (!Array.isArray(c.mustFail)) {
                throw new TypeError(P + 'mustFail must be an array (got ' + typeof c.mustFail + ')');
            }
            for (let i = 0; i < c.mustFail.length; i++) {
                list.push(c.mustFail[i]);
                labels.push('mustFail[' + i + ']');
            }
        }
        if (c.positiveControl !== undefined) {
            list.push(c.positiveControl);
            labels.push('positiveControl');
        }
        if (c.negativeControl !== undefined) {
            list.push(c.negativeControl);
            labels.push('negativeControl');
        }
    }
    if (list !== null) {
        for (let i = 0; i < list.length; i++) {
            const s = list[i];
            const L = labels[i];
            if (!s || typeof s !== 'object') {
                throw new TypeError(P + L + ' must be a Scenario object (got ' +
                    (s === null ? 'null' : typeof s) + ')');
            }
            if (typeof s.name !== 'string' || s.name.length === 0) {
                throw new TypeError(P + L + '.name must be a non-empty string (got ' + String(s.name) + ')');
            }
            if (typeof s.setup !== 'function') {
                throw new TypeError(P + L + ' "' + s.name + '": setup must be a function (got ' + typeof s.setup + ')');
            }
            if (typeof s.hot !== 'function') {
                throw new TypeError(P + L + ' "' + s.name + '": hot must be a function (got ' + typeof s.hot + ')');
            }
            if (s.statsOf !== undefined && typeof s.statsOf !== 'function') {
                throw new TypeError(P + L + ' "' + s.name + '": statsOf must be a function when present (got ' + typeof s.statsOf + ')');
            }
            if (s.teardown !== undefined && typeof s.teardown !== 'function') {
                throw new TypeError(P + L + ' "' + s.name + '": teardown must be a function when present (got ' + typeof s.teardown + ')');
            }
        }
    }
    return {N: N, k: k, flushMs: flushMs, allowNoGc: allowNoGc, allowEmpty: allowEmpty};
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
 * @param {{ N?: number, k?: number, flushMs?: number, allowNoGc?: boolean }} [options]
 *   N integer >= 1 (default 200000), k integer >= 2 (default 8), flushMs a
 *   finite number >= 0 (0 is legal and honored). flushMs is how long to wait
 *   after the hot loop before reading the GC observer buffer. Default 100ms
 *   (or PERF_GATE_FLUSH_MS env var). Bump if you see zero scavenges on
 *   scenarios that should allocate -- noisy CI runners may need 250-500ms.
 *   allowNoGc: run without --expose-gc; the retained signal is dropped and
 *   the result carries retainedReliable: false. Bad values throw.
 * @returns {Promise<MeasureResult>}
 */
export async function measure(scenario, options) {
    const o = validateGate('measure', options, scenario);
    const gcOk = typeof globalThis.gc === 'function';
    if (!gcOk && !o.allowNoGc) throw new Error(NO_GC_MSG);
    const lo = await meterOnce(scenario, o.N, o.flushMs);
    const hi = await meterOnce(scenario, o.k * o.N, o.flushMs);
    return {
        name: scenario.name, N: o.N, k: o.k,
        minorLo: lo.minor, minorHi: hi.minor,
        majorLo: lo.major, majorHi: hi.major,
        retainedKB_lo: lo.retainedKB, retainedKB_hi: hi.retainedKB,
        counters_lo: lo.counters, counters_hi: hi.counters,
        retainedReliable: gcOk
    };
}

// ---------------------------------------------------------------------------
// Built-in controls
// ---------------------------------------------------------------------------

// The positive control must defeat TWO V8 adaptations at once:
//   1. escape analysis / scalar replacement -- an object that never escapes
//      is never allocated, so the control must store it somewhere real;
//   2. allocation-site pretenuring -- a site whose objects keep SURVIVING is
//      promoted to old space, and the scavenge signal dies (PG-01).
// A 64-slot ring satisfies both: the store escapes, and every object is
// overwritten within 64 iterations, so the site's survival ratio stays ~0.
// Measured, fresh process, N=200000 k=8, --expose-gc --max-semi-space-size=4:
// minorLo=2 minorHi=21 majorHi=0 retainedKB_hi~11 (stock sink: 2 -> 1, ~100MB).
// See decisions/0001-positive-control.md.

const CONTROL_RING_SIZE = 64;
const CONTROL_RING_MASK = CONTROL_RING_SIZE - 1;
const __posRing = new Array(CONTROL_RING_SIZE).fill(null);

/**
 * @internal -- the read that keeps the positive-control ring alive.
 * Touches every slot so V8 cannot sink or eliminate the stores in
 * controlPositive.hot, and returns the live occupancy. The sink is bounded
 * by construction: after any number of iterations at most 64 objects (~3KB)
 * are retained, so one measurement can never poison the next (PG-10).
 * @returns {number} occupied ring slots, 0..64
 */
export function _controlKeepAlive() {
    let live = 0;
    for (let i = 0; i < CONTROL_RING_SIZE; i++) {
        const o = __posRing[i];
        if (o !== null && o.w >= o.x) live++;
    }
    return live;
}

/** Positive control: allocates one short-lived heap object per iteration. */
export const controlPositive = {
    name: 'CONTROL+ ({x,y,z,w} per iter into a 64-slot ring)',
    setup: function () {
        return {};
    },
    hot: function (_s, n) {
        for (let i = 0; i < n; i++) {
            __posRing[i & CONTROL_RING_MASK] = {x: i, y: i + 1, z: i + 2, w: i + 3};
        }
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
// Detector validation
// ---------------------------------------------------------------------------

// Detector-validation floors, DECOUPLED from the consumer's scenario
// thresholds on purpose: the evidence the instrument owes does not get
// cheaper because a consumer raised maxScavenges. decisions/0001.
const CONTROL_FLOOR = 6;     // positive control: scavenges at k*N
const CONTROL_SCALE = 2;     // positive control: minorHi / minorLo
const CONTROL_NEG_CEIL = 2;  // negative control: hard ceiling

/**
 * The ONE detector-validation predicate. zgcSuite and runGate both call it;
 * neither forks it. Comparisons are written so a NaN count fails closed.
 *
 * @param {MeasureResult} pos  positive-control measurement
 * @param {MeasureResult} neg  negative-control measurement
 * @param {number} maxScav     suite scavenge threshold (tightens neg only)
 * @returns {{ ok: boolean, reason: string | null }}
 */
function validateDetector(pos, neg, maxScav) {
    const flags = ' Run with --expose-gc --max-semi-space-size=4.';
    if (!(pos.minorHi >= CONTROL_FLOOR)) {
        return {ok: false, reason: 'positive control forced ' + pos.minorHi +
            ' scavenges at ' + pos.k + 'N (need >=' + CONTROL_FLOOR + ').' + flags};
    }
    if (pos.minorLo > 0 && !(pos.minorHi >= CONTROL_SCALE * pos.minorLo)) {
        return {ok: false, reason: 'positive control did not scale: ' +
            pos.minorLo + ' at N, ' + pos.minorHi + ' at ' + pos.k +
            'N (need >=' + (CONTROL_SCALE * pos.minorLo) + ').' + flags};
    }
    const negCeil = maxScav < CONTROL_NEG_CEIL ? maxScav : CONTROL_NEG_CEIL;
    if (!(neg.minorHi <= negCeil)) {
        return {ok: false, reason: 'negative control forced ' + neg.minorHi +
            ' scavenges (need <=' + negCeil + ') -- noisy process, or a prior ' +
            'measurement poisoned it.' + flags};
    }
    return {ok: true, reason: null};
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 * Evaluate a measurement against thresholds.
 *
 * Thresholds are validated at config time (bad values throw); measured
 * signals fail closed with named reasons, in this contract format:
 *   '<signal>: not a number (fail closed)'          -- scavenges / retained / counter
 *   '<key>: no such counter measured (statsOf keys: ...)'  -- typo'd counter key
 *   'counters: thresholds set (...) but the scenario measured no counters
 *    -- add statsOf (fail closed)'                   -- counters_hi === null
 *
 * @param {MeasureResult} r
 * @param {object} [thresholds]
 * @param {number} [thresholds.maxScavenges=2]   finite >= 0, else throws
 * @param {number} [thresholds.maxRetainedKB=64]  finite >= 0, else throws
 * @param {Record<string, number>} [thresholds.counters]
 *   Per-counter maximum allowed delta. E.g. `{ poolGrowths: 0 }`. Each
 *   maximum must be a finite number, else throws.
 * @returns {{ pass: boolean, reasons: string[] }}
 */
export function verdict(r, thresholds) {
    validateGate('verdict', thresholds, null);
    if (thresholds && thresholds.maxRetainedKB !== undefined && r && r.retainedReliable === false) {
        throw new RangeError('lite-perf-gate: verdict: ' + NO_RETAINED);
    }
    const maxScav = (thresholds && thresholds.maxScavenges !== undefined) ? thresholds.maxScavenges : 2;
    const maxRetKB = (thresholds && thresholds.maxRetainedKB !== undefined) ? thresholds.maxRetainedKB : 64;
    const ct = (thresholds && thresholds.counters) || null;
    const reasons = [];

    if (typeof r.minorHi !== 'number' || r.minorHi !== r.minorHi) {
        reasons.push('scavenges: not a number (fail closed)');
    } else if (r.minorHi > maxScav) {
        reasons.push('scavenges: ' + r.minorHi + ' > ' + maxScav + ' (transient allocation)');
    }
    if (r.retainedReliable !== false) {
        if (typeof r.retainedKB_hi !== 'number' || r.retainedKB_hi !== r.retainedKB_hi) {
            reasons.push('retained: not a number (fail closed)');
        } else if (r.retainedKB_hi > maxRetKB) {
            reasons.push('retained: ' + r.retainedKB_hi.toFixed(0) + 'KB > ' + maxRetKB + 'KB');
        }
    }
    if (ct !== null) {
        if (r.counters_hi === null || r.counters_hi === undefined) {
            reasons.push('counters: thresholds set (' + Object.keys(ct).join(', ') +
                ') but the scenario measured no counters -- add statsOf (fail closed)');
        } else {
            const ks = Object.keys(r.counters_hi);
            for (const key in ct) {
                const actual = r.counters_hi[key];
                if (actual === undefined) {
                    reasons.push(key + ': no such counter measured (statsOf keys: ' +
                        (ks.length ? ks.join(', ') : 'none') + ')');
                } else if (typeof actual !== 'number' || actual !== actual) {
                    reasons.push(key + ': not a number (fail closed)');
                } else if (actual > ct[key]) {
                    reasons.push(key + ': ' + actual + ' > ' + ct[key]);
                }
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
 * @param {number} [config.flushMs]
 *   Wait (ms) after the hot loop before reading the GC observer buffer.
 *   Default 100 (or PERF_GATE_FLUSH_MS env var). 0 is legal and honored.
 * @param {boolean} [config.allowEmpty=false]
 *   Permit an empty scenarios array for a controls-only detector smoke run
 *   -- the ONLY reason this option exists.
 * @param {boolean} [config.allowNoGc=false]
 *   Run without --expose-gc; the retained rule is not applied and an
 *   explicit maxRetainedKB throws.
 */
export function zgcSuite(config) {
    const o = validateGate('zgcSuite', config, null);
    const cf = config || {};
    const scenarios = cf.scenarios;
    const opts = {N: o.N, k: o.k, flushMs: o.flushMs, allowNoGc: o.allowNoGc};
    const thresholds = {
        maxScavenges: cf.maxScavenges !== undefined ? cf.maxScavenges : 2,
        maxRetainedKB: o.allowNoGc ? undefined : (cf.maxRetainedKB !== undefined ? cf.maxRetainedKB : 64),
        counters: cf.counters || null
    };
    const posCtrl = cf.positiveControl || controlPositive;
    const negCtrl = cf.negativeControl || controlNegative;
    const mustFail = cf.mustFail || [];
    const maxScav = thresholds.maxScavenges;

    test(scenarios.length === 0
        ? 'perf-gate: detector validation only (allowEmpty, 0 scenarios)'
        : 'perf-gate: detector validation (positive + negative controls)', async function () {
        const pos = await measure(posCtrl, opts);
        _controlKeepAlive();
        const neg = await measure(negCtrl, opts);
        const v = validateDetector(pos, neg, maxScav);
        assert.ok(v.ok, 'DETECTOR VALIDATION FAILED: ' + v.reason +
            '\n  ' + formatResult(pos) + '\n  ' + formatResult(neg));
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
 * Run a gate check and print a human-readable report.
 *
 * Returns `{ passed, code, results }`. `code`: 0 pass, 1 scenario or
 * must-fail failure, 2 detector validation failed; `passed === (code === 0)`.
 * runGate never touches `process.exitCode` -- map `result.code` to your exit
 * code: `process.exit((await runGate(cfg)).code)`.
 *
 * @param {object} config  Same shape as zgcSuite.
 * @returns {Promise<{ passed: boolean, code: 0 | 1 | 2, results: MeasureResult[] }>}
 */
export async function runGate(config) {
    const o = validateGate('runGate', config, null);
    const cf = config || {};
    const scenarios = cf.scenarios;
    const opts = {N: o.N, k: o.k, flushMs: o.flushMs, allowNoGc: o.allowNoGc};
    const thresholds = {
        maxScavenges: cf.maxScavenges !== undefined ? cf.maxScavenges : 2,
        maxRetainedKB: o.allowNoGc ? undefined : (cf.maxRetainedKB !== undefined ? cf.maxRetainedKB : 64),
        counters: cf.counters || null
    };
    const posCtrl = cf.positiveControl || controlPositive;
    const negCtrl = cf.negativeControl || controlNegative;
    const mustFail = cf.mustFail || [];
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

    const dv = validateDetector(pos, neg, maxScav);
    if (!dv.ok) {
        console.log('\n!! DETECTOR VALIDATION FAILED: ' + dv.reason);
        return {passed: false, code: 2, results: []};
    }
    console.log('\ndetector validated: positive forced ' + pos.minorHi +
        ' scavenges at ' + k + 'N (' + pos.minorLo + ' at N, floor ' +
        CONTROL_FLOOR + '), negative forced ' + neg.minorHi + '.\n');

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
        if (results.length === 0) {
            console.log('\nZERO-GC GATE: PASS \u2014 detector only (allowEmpty, 0 scenarios gated).');
        } else {
            console.log('\nZERO-GC GATE: PASS \u2014 ' + results.length + '/' + results.length + ' scenarios.');
        }
    } else {
        const why = failures.map(function (f) {
            return f.name;
        });
        if (!mustFailOK) why.push('must-fail scenario was not caught');
        console.log('\nZERO-GC GATE: FAIL \u2014 ' + why.join('; '));
    }
    const code = passed ? 0 : 1;
    return {passed: passed, code: code, results: results};
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
