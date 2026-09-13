// T3a child: the PG-02 bypass -- 600KB-string large-object churn. Measured at
// the pinned window N=500 k=8 (~2.4GB churned), then judged at DEFAULT
// thresholds. The census (decisions/0003, Axis A4) proved this fires NO
// countable GC event on Node v26.3.1: oldGen 0, arrayBuffers 0, minor 2
// (== default maxScavenges), retained < 64KB. It PASSES the gate -- a
// documented, measured hole, asserted as such by t3-bypass.mjs. If a future
// Node fires an old-gen event here, this fixture flips to caught and tells us.
// PGT_SABOTAGE=zero-signal (test-only) zeroes the two new fields before the
// verdict; it does not change this hole. Emits one PGT1 line on stdout.
if (typeof globalThis.gc !== 'function') { process.stderr.write('fixture: missing --expose-gc\n'); process.exit(2); }

import {measure, verdict} from '../../../PerfGate.js';

const RING = new Array(16).fill(null);
const CHARS = ['a', 'b', 'c', 'd'];
const scenario = {
    name: 't3a 600KB-string LO churn (PG-02)',
    setup: function () { return {}; },
    hot: function (_s, n) {
        for (let i = 0; i < n; i++) RING[i & 15] = CHARS[i & 3].repeat(614400);
    }
};

const r = await measure(scenario, {N: 500, k: 8});
if (process.env.PGT_SABOTAGE === 'zero-signal') { r.oldGenHi = 0; r.arrayBuffersKB_hi = 0; }
const v = verdict(r, {});

process.stdout.write('PGT1 ' + JSON.stringify({
    case: 't3a',
    node: process.version,
    pass: v.pass,
    reasons: v.reasons,
    minorHi: r.minorHi,
    oldGenHi: r.oldGenHi,
    arrayBuffersKB_hi: r.arrayBuffersKB_hi,
    retainedKB_hi: r.retainedKB_hi
}) + '\n');
