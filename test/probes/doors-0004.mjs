// test/probes/doors-0004.mjs -- repo-only, NEVER in files[].
// Run: node --expose-gc --max-semi-space-size=4 test/probes/doors-0004.mjs
//
// The measurement that decides whether the per-record D-A door ships (P4,
// decisions/0004). It runs measureOps over suiteGate on a preallocated
// 1M-record slab with 8 budgets, plus a 1K-slab lane, 5 back-to-back reps,
// against WHATEVER PerfGate.js is on disk. Run it once BEFORE the doors land
// (v1.5.0 row) and once AFTER (v1.6.0 row); paste both into decisions/0004.
//
// Per-record allocation is proven by DIFFERENCE: one suiteGate() call
// legitimately allocates its config arrays + result, so per-CALL zero is not
// the claim. The honest estimator is
//   (bytesPerOp(1M) - bytesPerOp(1K)) / (1e6 - 1e3).

import {measureOps} from '@zakkster/lite-gc-profiler';
import {suiteGate, VERSION} from '../../PerfGate.js';

const BIG = 1_000_000;
const SMALL = 1_000;
const REPS = 5;

// SPP v1 packing (protocol, not a package import).
function spp(stream, op) { return ((stream << 16) | op) >>> 0; }
const P_A = spp(1, 0x0100);
const P_B = spp(2, 0x0201);
const P_C = spp(1, 0x0300);
const HEADERS = [P_A, P_B, P_C];

function buildSlab(records) {
    const slab = new Float64Array(records * 4);
    for (let r = 0; r < records; r++) {
        slab[r * 4] = HEADERS[r % 3];
        slab[r * 4 + 1] = r;
        slab[r * 4 + 2] = r % 97;
        slab[r * 4 + 3] = r % 13;
    }
    return slab;
}

const BUDGETS = [
    {name: 'packed.b', packed: P_B, slot: 'a', reduce: 'max', max: 1e18},
    {name: 'so.a', stream: 1, op: 0x0100, slot: 't', reduce: 'sum', max: 1e18},
    {name: 'op.count', op: 0x0100, reduce: 'count', max: 1e18},
    {name: 'op.mean', op: 0x0201, slot: 'b', reduce: 'mean', max: 1e18},
    {name: 'op.last', op: 0x0100, slot: 'b', reduce: 'last', max: 1e18},
    {name: 'so.c', stream: 1, op: 0x0300, slot: 't', reduce: 'count', max: 1e18},
    {name: 'packed.a', packed: P_A, slot: 'a', reduce: 'sum', max: 1e18},
    {name: 'op.max2', op: 0x0201, slot: 't', reduce: 'max', max: 1e18}
];

// Slabs allocated ONCE, outside every measured window.
const bigSlab = buildSlab(BIG);
const smallSlab = buildSlab(SMALL);

let sink = 0;
function fnBig() { sink += suiteGate({source: bigSlab, budgets: BUDGETS}).budgets.length; }
function fnSmall() { sink += suiteGate({source: smallSlab, budgets: BUDGETS}).budgets.length; }

function pct(sorted, p) {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
    return sorted[idx];
}

function nsPerRecord(res, records) {
    return (1e9 / res.opsPerSec) / records;
}

function num(x, d) { return x === null || x === undefined ? 'null' : x.toFixed(d); }

const OPTS = {ops: 8, warmup: 2, stabilize: 'deep', source: 'gc'};

const nsBig = [];
const bpoBig = [];
const bpoSmall = [];
const perRecBytes = [];

console.log('doors-0004 probe -- PerfGate VERSION ' + VERSION + ', node ' + process.version);
console.log('slab BIG=' + BIG + ' SMALL=' + SMALL + ' budgets=' + BUDGETS.length + ' reps=' + REPS);
console.log('');

for (let rep = 0; rep < REPS; rep++) {
    const big = measureOps(fnBig, OPTS);
    const small = measureOps(fnSmall, OPTS);
    const nsB = nsPerRecord(big, BIG);
    const haveBoth = big.bytesPerOp !== null && small.bytesPerOp !== null;
    const prb = haveBoth ? (big.bytesPerOp - small.bytesPerOp) / (BIG - SMALL) : null;
    nsBig.push(nsB);
    if (big.bytesPerOp !== null) bpoBig.push(big.bytesPerOp);
    if (small.bytesPerOp !== null) bpoSmall.push(small.bytesPerOp);
    if (prb !== null) perRecBytes.push(prb);
    console.log('rep ' + rep +
        ': nsPerRecord=' + nsB.toFixed(4) +
        ' opsPerSec=' + big.opsPerSec.toFixed(1) +
        ' bytesPerOp(1M)=' + num(big.bytesPerOp, 1) +
        ' bytesPerOp(1K)=' + num(small.bytesPerOp, 1) +
        ' perRecordB=' + num(prb, 5) +
        ' bigInv=' + big.bracketInverted + ' smallInv=' + small.bracketInverted +
        ' bigVerdict=' + big.verdict + ' smallVerdict=' + small.verdict);
}

const sortedNs = nsBig.slice().sort(function (a, b) { return a - b; });
const sortedBpoBig = bpoBig.slice().sort(function (a, b) { return a - b; });
const sortedBpoSmall = bpoSmall.slice().sort(function (a, b) { return a - b; });
const sortedPrb = perRecBytes.slice().sort(function (a, b) { return a - b; });

console.log('');
console.log('SUMMARY VERSION ' + VERSION);
console.log('  nsPerRecord   min=' + pct(sortedNs, 0).toFixed(4) +
    ' p50=' + pct(sortedNs, 0.5).toFixed(4) +
    ' max=' + pct(sortedNs, 1).toFixed(4));
console.log('  bytesPerOp1M  n=' + sortedBpoBig.length + ' min=' + num(pct(sortedBpoBig, 0), 1) +
    ' p50=' + num(pct(sortedBpoBig, 0.5), 1) +
    ' max=' + num(pct(sortedBpoBig, 1), 1));
console.log('  bytesPerOp1K  n=' + sortedBpoSmall.length + ' min=' + num(pct(sortedBpoSmall, 0), 1) +
    ' p50=' + num(pct(sortedBpoSmall, 0.5), 1) +
    ' max=' + num(pct(sortedBpoSmall, 1), 1));
console.log('  perRecordB    n=' + sortedPrb.length + ' min=' + num(pct(sortedPrb, 0), 5) +
    ' p50=' + num(pct(sortedPrb, 0.5), 5) +
    ' max=' + num(pct(sortedPrb, 1), 5));
console.log('  noise band (nsPerRecord, same build): ' +
    pct(sortedNs, 0).toFixed(4) + ' / ' + pct(sortedNs, 0.5).toFixed(4) +
    ' / ' + pct(sortedNs, 1).toFixed(4) + ' (min/p50/max)');
console.log('sink=' + sink);
