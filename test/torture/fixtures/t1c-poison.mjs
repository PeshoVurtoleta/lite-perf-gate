// T1c child: the in-process poisoning regression (PG-10). Measure the
// positive control at defaults, force a double gc(), then measure the
// NEGATIVE control in the SAME process. The stock sink retained ~113MB and
// its knock-on forced 6 scavenges on the later negative measure; the ring
// keeps <=64 objects, so heap growth stays sub-MB and the negative control
// still validates. PGT_SABOTAGE=stock reproduces the old poison. Emits
// exactly one PGT1 line on stdout.
if (typeof globalThis.gc !== 'function') { process.stderr.write('fixture: missing --expose-gc\n'); process.exit(2); }

import {measure, controlPositive, controlNegative, _controlKeepAlive} from '../../../PerfGate.js';

const sink = [];
const stockControl = {
    name: 'CONTROL+ (stock grow-forever sink -- SABOTAGE)',
    setup: function () { return {}; },
    hot: function (_s, n) {
        for (let i = 0; i < n; i++) sink.push({x: i, y: i + 1, z: i + 2, w: i + 3});
        if (sink.length > 3000000) sink.length = 0;
    }
};

const positive = process.env.PGT_SABOTAGE === 'stock' ? stockControl : controlPositive;

function settleGc() {
    globalThis.gc();
    return new Promise(function (r) { setImmediate(r); }).then(function () { globalThis.gc(); });
}

await settleGc();
const heapBefore = process.memoryUsage().heapUsed;

const pos = await measure(positive, {});
const keepAlive = _controlKeepAlive();

await settleGc();
const heapAfter = process.memoryUsage().heapUsed;

const neg = await measure(controlNegative, {});

process.stdout.write('PGT1 ' + JSON.stringify({
    case: 't1c',
    node: process.version,
    posMinorLo: pos.minorLo,
    posMinorHi: pos.minorHi,
    heapGrowthKB: (heapAfter - heapBefore) / 1024,
    negMinorLo: neg.minorLo,
    negMinorHi: neg.minorHi,
    keepAlive: keepAlive
}) + '\n');
