// test/torture/t4-reduction.mjs -- T4 tier: the suiteGate reduction gate.
//
// measureOps over suiteGate on a preallocated 1M-record slab with 8 budgets,
// plus a 1K-slab lane, proves the per-record hot body (visit + the D-A door)
// allocates nothing that survives: per-record retained bytes, measured by the
// 1M-vs-1K bytesPerOp DIFFERENCE, must be <= 0.01 (decisions/0004 "The cost").
// One measurement in flight; T4 runs BEFORE T5 so no measureOps is ever inside
// T5's GcProfiler window.
//
// measureOps is SYNCHRONOUS -- perf_hooks 'gc' entries are never delivered
// inside its window, so summary.gc.minor always reads 0 and a purely transient
// allocation is invisible to every heap-delta gate. The allocating-visit
// control therefore RETAINS one object per record (decisions/0004 "The
// allocating-visit control"), which IS measurable and IS the production defect;
// it blows both the per-record bytes gate and checkOps(maxBytesPerOp).
//
// TORTURE_CONTROL=allocating-visit -> T4 MUST fail.

import {measureOps, checkOps, checkNoGc} from '@zakkster/lite-gc-profiler';
import {die, note, CONTROL} from './harness.mjs';
import {suiteGate} from '../../PerfGate.js';

const BIG = 1_000_000;
const SMALL = 1_000;
const MAX_BPO = 65536;         // coarse per-op guard; the perRecord gate is the tight one
const MAX_PER_RECORD = 0.01;   // B/record, decisions/0004
const NS_CEILING = 25;         // catastrophe ceiling, not a regression gate

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

// Test-code-only retaining shim: one object per record survives into `sink`.
// The library is untouched; this is what a per-record allocation would BE.
const allocSink = [];
function retainingShim(slab, records) {
    return {
        forEach: function (cb) {
            for (let r = 0; r < records; r++) {
                const o = {p: slab[r * 4], t: slab[r * 4 + 1], a: slab[r * 4 + 2], b: slab[r * 4 + 3]};
                allocSink.push(o);
                cb(o.p, o.t, o.a, o.b);
            }
        }
    };
}

let sink = 0;

export async function t4() {
    const alloc = CONTROL === 'allocating-visit';
    note('T4 suiteGate reduction gate (1M-record slab, 8 budgets)' +
        (alloc ? ' -- CONTROL: allocating-visit' : ''));

    // Slabs allocated ONCE, outside every measured window.
    const bigSlab = buildSlab(BIG);
    const smallSlab = buildSlab(SMALL);

    let fnBig, fnSmall;
    if (alloc) {
        fnBig = function () { sink += suiteGate({source: retainingShim(bigSlab, BIG), budgets: BUDGETS}).budgets.length; };
        fnSmall = function () { sink += suiteGate({source: retainingShim(smallSlab, SMALL), budgets: BUDGETS}).budgets.length; };
    } else {
        fnBig = function () { sink += suiteGate({source: bigSlab, budgets: BUDGETS}).budgets.length; };
        fnSmall = function () { sink += suiteGate({source: smallSlab, budgets: BUDGETS}).budgets.length; };
    }

    // Fewer ops under the control to bound its retained footprint.
    const OPTS = alloc
        ? {ops: 3, warmup: 1, stabilize: 'deep', source: 'gc'}
        : {ops: 8, warmup: 2, stabilize: 'deep', source: 'gc'};

    const big = measureOps(fnBig, OPTS);
    const small = measureOps(fnSmall, OPTS);

    const nsPerRecord = (1e9 / big.opsPerSec) / BIG;
    const bpoSmall = small.bytesPerOp === null ? 0 : small.bytesPerOp;
    // A null (bracket-inverted) big lane means retention DECREASED across the
    // window -- per-record retained is <= 0, which passes. The control never
    // inverts (it retains), so this null-guard cannot hide its allocation.
    const perRecord = big.bytesPerOp === null ? 0 : (big.bytesPerOp - bpoSmall) / (BIG - SMALL);

    const opsRep = checkOps(big, {maxBytesPerOp: MAX_BPO});
    const gcRep = checkNoGc(big.summary, {maxMajor: 0, maxArrayBuffersGrowth: 0});

    note('T4 ACTIVE: nsPerRecord=' + nsPerRecord.toFixed(3) +
        ' bytesPerOp1M=' + String(big.bytesPerOp) +
        ' bytesPerOp1K=' + String(small.bytesPerOp) +
        ' perRecordBytes=' + perRecord.toFixed(5) +
        ' checkOps=' + opsRep.verdict + ' checkNoGc=' + gcRep.verdict +
        ' sink=' + sink + ' node ' + process.version);

    // An unexpected inconclusive is a die, never an allowInconclusive.
    if (opsRep.verdict === 'inconclusive' || gcRep.verdict === 'inconclusive') {
        die('T4 inconclusive: checkOps=' + opsRep.verdict + ' checkNoGc=' + gcRep.verdict +
            ' (never allowInconclusive -- diagnose the measurement)');
    }

    const why = [];
    if (opsRep.verdict !== 'pass') {
        why.push('checkOps ' + opsRep.verdict + ' (bytesPerOp ' + String(big.bytesPerOp) +
            ' > ' + MAX_BPO + ')');
    }
    if (gcRep.verdict !== 'pass') why.push('checkNoGc ' + gcRep.verdict);
    if (!(perRecord <= MAX_PER_RECORD)) {
        why.push('perRecordBytes ' + perRecord.toFixed(5) + ' > ' + MAX_PER_RECORD);
    }
    if (!(nsPerRecord < NS_CEILING)) {
        why.push('nsPerRecord ' + nsPerRecord.toFixed(3) + ' >= ' + NS_CEILING);
    }
    if (why.length > 0) die('T4 reduction gate: ' + why.join(', ') + ' node ' + process.version);
}
