// T3b child: the PG-03a bypass -- 512KB Float64Array transient churn. Measured
// at the pinned window N=512 k=8 (~2.1GB external churn), judged at DEFAULT
// thresholds. The census (decisions/0003, Axis B1) proved this fires oldGen=2
// in-window while arrayBuffers reads 0 (transient, already collected at the
// capture points): CAUGHT by the old-gen lane. PGT_SABOTAGE=zero-signal
// (test-only) zeroes oldGenHi/arrayBuffersKB_hi before the verdict, which
// makes the catch disappear -- proving the signal is load-bearing (T3 then
// fails). Emits one PGT1 line on stdout.
if (typeof globalThis.gc !== 'function') { process.stderr.write('fixture: missing --expose-gc\n'); process.exit(2); }

import {measure, verdict} from '../../../PerfGate.js';

const RING = new Array(16).fill(null);
const scenario = {
    name: 't3b 512KB Float64Array churn (PG-03a)',
    setup: function () { return {}; },
    hot: function (_s, n) {
        for (let i = 0; i < n; i++) RING[i & 15] = new Float64Array(65536);
    }
};

const r = await measure(scenario, {N: 512, k: 8});
if (process.env.PGT_SABOTAGE === 'zero-signal') { r.oldGenHi = 0; r.arrayBuffersKB_hi = 0; }
const v = verdict(r, {});

process.stdout.write('PGT1 ' + JSON.stringify({
    case: 't3b',
    node: process.version,
    pass: v.pass,
    reasons: v.reasons,
    minorHi: r.minorHi,
    oldGenHi: r.oldGenHi,
    arrayBuffersKB_hi: r.arrayBuffersKB_hi,
    retainedKB_hi: r.retainedKB_hi
}) + '\n');
