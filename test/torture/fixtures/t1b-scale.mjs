// T1b child: measure the positive control at PGT_N (k=8) and report the raw
// scavenge counts so the parent can assert the ring scales (minorHi >= 6 and
// minorHi >= 2*minorLo when minorLo > 0). PGT_SABOTAGE=stock swaps in the
// grow-forever control, whose pretenured site inverts the scaling. Emits
// exactly one PGT1 line on stdout.
if (typeof globalThis.gc !== 'function') { process.stderr.write('fixture: missing --expose-gc\n'); process.exit(2); }

import {measure, controlPositive, _controlKeepAlive} from '../../../PerfGate.js';

const sink = [];
const stockControl = {
    name: 'CONTROL+ (stock grow-forever sink -- SABOTAGE)',
    setup: function () { return {}; },
    hot: function (_s, n) {
        for (let i = 0; i < n; i++) sink.push({x: i, y: i + 1, z: i + 2, w: i + 3});
        if (sink.length > 3000000) sink.length = 0;
    }
};

const N = Number(process.env.PGT_N);
const k = 8;
const control = process.env.PGT_SABOTAGE === 'stock' ? stockControl : controlPositive;

const r = await measure(control, {N: N, k: k});
const keepAlive = _controlKeepAlive();

process.stdout.write('PGT1 ' + JSON.stringify({
    case: 't1b',
    node: process.version,
    N: N,
    k: k,
    minorLo: r.minorLo,
    minorHi: r.minorHi,
    majorLo: r.majorLo,
    majorHi: r.majorHi,
    oldGenHi: r.oldGenHi,
    arrayBuffersKB_hi: r.arrayBuffersKB_hi,
    retainedKB_hi: r.retainedKB_hi,
    keepAlive: keepAlive
}) + '\n');
