// T3a child: the PG-02 bypass -- 600KB FLAT-string large-object churn into a
// 16-slot ring. Measured at the pinned window N=500 k=8 (~2.4GB of flat string
// bytes), then judged at DEFAULT thresholds. MUST be caught by BOTH the
// scavenge lane and the old-gen lane on every supported Node (decisions/0003,
// PG-02 re-census amendment):
//   Node 22.23: minorHi 649..654, oldGenHi 72..82 (10/10 clean bare children).
//   Node 26.8:  minorHi 24..71,   oldGenHi 8..24  (10/10).
// Why the charCodeAt read: String.prototype.repeat returns a cons-rope (~20
// small nodes, ~2.4KB), not a 600KB string. The original fixture stored the
// rope, churned ~10MB of young nodes (minorHi 2 == default maxScavenges) and
// was recorded as an uncatchable "hole" -- a fixture artifact. charCodeAt
// flattens the rope into one 600KB SeqString, which V8 allocates in YOUNG
// large-object space (scavenge-reclaimed; ring survivors promote to old LO
// space and need a major). The read is SUNK into s.acc: left unused, the
// optimizing tier DCEs it and the ring silently holds ropes again (measured on
// both Nodes once the loop optimizes).
// PGT_SABOTAGE=zero-signal (test-only) zeroes oldGenHi/arrayBuffersKB_hi
// before the verdict: the oldgen reason disappears (scavenges still catches),
// so T3a's must-catch-by-oldgen assertion fails and the tier fails. Emits one
// PGT1 line on stdout.
if (typeof globalThis.gc !== 'function') { process.stderr.write('fixture: missing --expose-gc\n'); process.exit(2); }

import {measure, verdict} from '../../../PerfGate.js';

const RING = new Array(16).fill(null);
const CHARS = ['a', 'b', 'c', 'd'];
const scenario = {
    name: 't3a 600KB flat-string LO churn (PG-02)',
    setup: function () { return {acc: 0}; },
    hot: function (s, n) {
        let a = s.acc;
        for (let i = 0; i < n; i++) {
            const t = CHARS[i & 3].repeat(614400);
            a = (a + t.charCodeAt(i & 1023)) & 1023;
            RING[i & 15] = t;
        }
        s.acc = a;
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
