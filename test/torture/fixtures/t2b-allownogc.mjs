// T2b child: measure(allowNoGc: true) WITHOUT --expose-gc runs, stamps
// retainedReliable false, verdict() drops the retained rule entirely (default
// included), and an EXPLICIT maxRetainedKB throws (decision 0002 policy 4,
// shape A). Spawned by t2-doors.mjs with an EMPTY node-flags list. Emits
// exactly one PGT1 line, exits 0.
import {measure, verdict} from '../../../PerfGate.js';

const tiny = {
    name: 't2b',
    setup: function () { return {a: 0}; },
    hot: function (s, n) { let a = s.a; for (let i = 0; i < n; i++) a += (i * 3) ^ i; s.a = a; }
};

const r = await measure(tiny, {N: 2000, k: 2, allowNoGc: true});
const noThreshReasons = verdict(r, {}).reasons;
let retThrew = false;
try {
    verdict(r, {maxRetainedKB: 64});
} catch (_e) {
    retThrew = true;
}

process.stdout.write('PGT1 ' + JSON.stringify({
    case: 't2b',
    node: process.version,
    retainedReliable: r.retainedReliable,
    noThreshReasonCount: noThreshReasons.length,
    retThrew: retThrew
}) + '\n');
process.exit(0);
