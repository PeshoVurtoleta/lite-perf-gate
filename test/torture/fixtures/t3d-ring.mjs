// T3d child: the still-caught-by-scavenges control -- classic small-object
// churn into a 64-slot ring, measured at the pinned window N=50000 k=8 and
// judged at DEFAULT thresholds. This is transient young-generation allocation:
// the ORIGINAL scavenge lane catches it (minorHi >> 2), and it must keep doing
// so even while the two new lanes exist. PGT_SABOTAGE=zero-signal (test-only)
// zeroes only oldGenHi/arrayBuffersKB_hi, NOT minorHi, so t3d stays caught --
// it proves the sabotage is scoped to the new lanes and the scavenge lane is
// untouched. Emits one PGT1 line on stdout.
if (typeof globalThis.gc !== 'function') { process.stderr.write('fixture: missing --expose-gc\n'); process.exit(2); }

import {measure, verdict} from '../../../PerfGate.js';

const RING = new Array(64).fill(null);
const scenario = {
    name: 't3d small-object ring churn (scavenge control)',
    setup: function () { return {}; },
    hot: function (_s, n) {
        for (let i = 0; i < n; i++) RING[i & 63] = {x: i, y: i + 1, z: i + 2, w: i + 3};
    }
};

const r = await measure(scenario, {N: 50000, k: 8});
if (process.env.PGT_SABOTAGE === 'zero-signal') { r.oldGenHi = 0; r.arrayBuffersKB_hi = 0; }
const v = verdict(r, {});

process.stdout.write('PGT1 ' + JSON.stringify({
    case: 't3d',
    node: process.version,
    pass: v.pass,
    reasons: v.reasons,
    minorHi: r.minorHi,
    oldGenHi: r.oldGenHi,
    arrayBuffersKB_hi: r.arrayBuffersKB_hi,
    retainedKB_hi: r.retainedKB_hi
}) + '\n');
