// T3c child: the PG-03b bypass -- a pool RETAINING 16MB of ArrayBuffers.
// Measured at the pinned window N=32 k=8 (256 x 64KB = 16MB), judged at DEFAULT
// thresholds. The census (decisions/0003, Axis B1) proved arrayBuffers grows
// 16384KB while retained (heapUsed) reads < 64KB -- the exact PG-03b inversion:
// the retained lane still cannot see it, the external lane does. CAUGHT by
// arrayBuffers. PGT_SABOTAGE=zero-signal (test-only) zeroes the two new fields
// before the verdict, making the catch disappear (T3 then fails). Emits one
// PGT1 line on stdout.
if (typeof globalThis.gc !== 'function') { process.stderr.write('fixture: missing --expose-gc\n'); process.exit(2); }

import {measure, verdict} from '../../../PerfGate.js';

const scenario = {
    name: 't3c 16MB retained ArrayBuffer pool (PG-03b)',
    setup: function () { return {pool: []}; },
    hot: function (s, n) {
        for (let i = 0; i < n; i++) s.pool.push(new ArrayBuffer(65536));
    }
};

const r = await measure(scenario, {N: 32, k: 8});
if (process.env.PGT_SABOTAGE === 'zero-signal') { r.oldGenHi = 0; r.arrayBuffersKB_hi = 0; }
const v = verdict(r, {});

process.stdout.write('PGT1 ' + JSON.stringify({
    case: 't3c',
    node: process.version,
    pass: v.pass,
    reasons: v.reasons,
    minorHi: r.minorHi,
    oldGenHi: r.oldGenHi,
    arrayBuffersKB_hi: r.arrayBuffersKB_hi,
    retainedKB_hi: r.retainedKB_hi
}) + '\n');
