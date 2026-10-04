// T3b child: the PG-03a bypass -- 512KB Float64Array transient churn into a
// 64-slot ring. Measured at the pinned window N=512 k=8 (~2.1GB external
// churn, 32MB transient live set), judged at DEFAULT thresholds. MUST be
// caught by the old-gen lane on every supported Node (decisions/0003, Node 22
// amendment):
//   Node 26.8: minor 1, incremental 1, major/40 1 (external-memory major) ->
//     oldGen=2, the ONLY reason (scavenges/arrayBuffers/retained all clear).
//   Node 22.23: minor 63..112, major/0 + incremental/0 pairs -> oldGen
//     30..56 (40/40 reps at load avg 10-14), caught by oldgen AND scavenges.
// Why 64 slots, not the census's 16: on Node 22 a 16-slot ring is reclaimed
// entirely by scavenges (~49 allocations per scavenge; a buffer dead within 16
// never promotes), so oldGen reads 0 on a clean heap and flips to 2 with 4MB of
// unrelated old-space ballast -- heap-state noise, not a fixture signal. At 32
// slots it is unstable (2/10/16); at 64 every buffer outlives a scavenge,
// promotes, and dies in old space (2x margin; 128 adds nothing). Node 26's
// reading is identical at 16/64/128. PGT_SABOTAGE=zero-signal (test-only)
// zeroes oldGenHi/arrayBuffersKB_hi before the verdict, which removes the
// oldgen reason on both Nodes -- proving the signal is load-bearing (T3 then
// fails). Emits one PGT1 line on stdout.
if (typeof globalThis.gc !== 'function') { process.stderr.write('fixture: missing --expose-gc\n'); process.exit(2); }

import {measure, verdict} from '../../../PerfGate.js';

const RING = new Array(64).fill(null);
const scenario = {
    name: 't3b 512KB Float64Array churn (PG-03a)',
    setup: function () { return {}; },
    hot: function (_s, n) {
        for (let i = 0; i < n; i++) RING[i & 63] = new Float64Array(65536);
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
