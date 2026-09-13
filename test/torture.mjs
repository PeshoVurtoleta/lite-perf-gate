// test/torture.mjs -- node --expose-gc --max-semi-space-size=4 test/torture.mjs
//
// The gate that guards the gate. Where the self-test proves the API shape,
// the torture suite proves the INSTRUMENT: that on a fresh, bare process --
// no test runner masking the numbers -- the detector still detects, the
// positive control still scales, and one measurement never poisons the next.
//
// Tiers (run in order, stdout stays empty until the final "ok"):
//   T1  detector matrix -- spawns bare children at LIBRARY DEFAULTS and
//       asserts runGate self-validates (PG-01 inverted), the ring control
//       scales at N in {50000, 200000}, and a negative measure survives a
//       positive one in the same process (PG-10 inverted).
//   T2  fail-closed doors -- every door hit from OUTSIDE, each with its
//       passing twin, plus two bare children without --expose-gc.
//   T3  bypass corpus            -- P3 (skipped).
//   T4  suiteGate reduction gate -- P4 (skipped).
//   T5  footprint + 4096-cycle soak -- bounds the control's heap growth and
//       proves the churn loop retains nothing (lite-leak registration count
//       back to 0, heap band flat, checkNoGc pass over the profiler window).
//
// Controls for the controls (T6, env-gated -- normal run is neither):
//   TORTURE_CONTROL=stock-control npm run torture   -> T1 MUST fail
//   TORTURE_CONTROL=leaky-soak    npm run torture    -> T5 MUST fail
//   TORTURE_CONTROL=no-doors      npm run torture    -> T2 MUST fail
//
// @zakkster/lite-gc-profiler and @zakkster/lite-leak are devDependencies,
// never runtime deps: the library ships zero dependencies. They gate the
// gate here, in test/, and nowhere the published tarball can reach.

import {fileURLToPath} from 'node:url';
import {GcProfiler, checkNoGc} from '@zakkster/lite-gc-profiler';
import {createLeakTracker} from '@zakkster/lite-leak';
import {die, note, runChild, TIER_SKIP, CONTROL} from './torture/harness.mjs';
import {t2} from './torture/t2-doors.mjs';
import {
    measure, suiteGate, toNDJSON,
    controlPositive, controlNegative, _controlKeepAlive
} from '../PerfGate.js';

function fx(name) {
    return fileURLToPath(new URL('./torture/fixtures/' + name, import.meta.url));
}

async function settleGc() {
    globalThis.gc();
    await new Promise(function (r) { setImmediate(r); });
    globalThis.gc();
}

// ---------------------------------------------------------------------------
// T1 -- detector matrix (bare child processes, library defaults)
// ---------------------------------------------------------------------------

async function t1() {
    const sabotage = CONTROL === 'stock-control';
    const base = sabotage ? {PGT_SABOTAGE: 'stock'} : {};

    const a = runChild(fx('t1a-rungate.mjs'), base).result;
    note('T1a runGate: passed=' + a.passed + ' resultsLen=' + a.resultsLen +
        ' sawFailureLine=' + a.sawFailureLine + ' node ' + a.node);

    const b1 = runChild(fx('t1b-scale.mjs'), Object.assign({PGT_N: '50000'}, base)).result;
    note('T1b N=' + b1.N + ': minorLo=' + b1.minorLo + ' minorHi=' + b1.minorHi +
        ' majorHi=' + b1.majorHi + ' retainedKB_hi=' + b1.retainedKB_hi.toFixed(1) +
        ' keepAlive=' + b1.keepAlive + ' node ' + b1.node);

    const b2 = runChild(fx('t1b-scale.mjs'), Object.assign({PGT_N: '200000'}, base)).result;
    note('T1b N=' + b2.N + ': minorLo=' + b2.minorLo + ' minorHi=' + b2.minorHi +
        ' majorHi=' + b2.majorHi + ' retainedKB_hi=' + b2.retainedKB_hi.toFixed(1) +
        ' keepAlive=' + b2.keepAlive + ' node ' + b2.node);

    const c = runChild(fx('t1c-poison.mjs'), base).result;
    note('T1c poison: posMinorLo=' + c.posMinorLo + ' posMinorHi=' + c.posMinorHi +
        ' heapGrowthKB=' + c.heapGrowthKB.toFixed(1) + ' negMinorLo=' + c.negMinorLo +
        ' negMinorHi=' + c.negMinorHi + ' keepAlive=' + c.keepAlive + ' node ' + c.node);

    if (!(a.passed === true && a.sawFailureLine === false)) {
        die('T1 detector validation: runGate passed=' + a.passed +
            ' sawFailureLine=' + a.sawFailureLine +
            ' (expected passed=true, sawFailureLine=false) node ' + a.node);
    }
    const bs = [b1, b2];
    for (let i = 0; i < bs.length; i++) {
        const b = bs[i];
        if (!(b.minorHi >= 6)) {
            die('T1 ring scaling N=' + b.N + ': minorHi=' + b.minorHi +
                ' < 6 node ' + b.node);
        }
        if (!(b.minorLo === 0 || b.minorHi >= 2 * b.minorLo)) {
            die('T1 ring scaling N=' + b.N + ': minorHi=' + b.minorHi +
                ' did not scale over minorLo=' + b.minorLo +
                ' (need >=' + (2 * b.minorLo) + ') node ' + b.node);
        }
    }
    if (!(c.heapGrowthKB < 1024)) {
        die('T1 poison: heapGrowthKB=' + c.heapGrowthKB.toFixed(1) +
            ' >= 1024 (the sink poisons the process) node ' + c.node);
    }
    if (!(c.negMinorHi <= 2)) {
        die('T1 poison: negMinorHi=' + c.negMinorHi +
            ' > 2 (a prior measure poisoned the negative control) node ' + c.node);
    }
}

// ---------------------------------------------------------------------------
// T5 -- footprint + 4096-cycle soak (in-process)
// ---------------------------------------------------------------------------

const CYCLES = 4096;
const SLAB_RECORDS = 64;
const OP = 0x0100;
const NOOP = function () {};

async function t5() {
    // --- footprint gate: one measure(controlPositive) at defaults must not
    // grow the post-gc heap by a megabyte (stock sink grew ~113MB, PG-10).
    await settleGc();
    const fpBefore = process.memoryUsage().heapUsed;
    await measure(controlPositive, {});
    _controlKeepAlive();
    await settleGc();
    const fpAfter = process.memoryUsage().heapUsed;
    const footprintKB = (fpAfter - fpBefore) / 1024;
    note('T5 footprint: measure(controlPositive) heap growth ' +
        footprintKB.toFixed(1) + ' KB (limit 1024) keepAlive ' +
        _controlKeepAlive() + ' node ' + process.version);
    if (!(footprintKB < 1024)) {
        die('T5 footprint: heap growth ' + footprintKB.toFixed(1) +
            ' KB >= 1024 KB after one measure(controlPositive)');
    }

    // --- soak. The SPP slab is allocated ONCE, outside the loop; the cycle
    // reads it, never grows it. BUDGETS are set above the slab's values so
    // the soak gates retention and GC, not budget outcomes.
    const SLAB = new Float64Array(SLAB_RECORDS * 4);
    for (let i = 0; i < SLAB_RECORDS; i++) {
        SLAB[i * 4] = ((1 << 16) | OP) >>> 0; // packed stream=1 op=OP
        SLAB[i * 4 + 1] = i;                   // t
        SLAB[i * 4 + 2] = i % 10;              // a (max 9)
        SLAB[i * 4 + 3] = 0;                   // b
    }
    const BUDGETS = [
        {name: 'soak.a.max', op: OP, slot: 'a', reduce: 'max', max: 100},
        {name: 'soak.count', op: OP, reduce: 'count', max: 100000}
    ];
    const META = {pkg: 'lite-perf-gate', tier: 'T5'};
    const tiny = {
        name: 'soak-tiny',
        setup: function () { return {acc: 0}; },
        hot: function (s, n) { let a = s.acc; for (let i = 0; i < n; i++) a += (i * 3) ^ i; s.acc = a; }
    };

    // lite-leak's owner-tree kernels need signal owners this plain-function
    // package does not have, so the honest check is registration
    // collectability -- tracker.size() back to 0 -- and nothing more. NOOP
    // and the numeric cycle index honour the held-value contract: neither
    // closes over the tracked result object.
    const tracker = createLeakTracker({name: 'perf-gate-soak'});
    const leaky = CONTROL === 'leaky-soak';
    const leakSink = [];

    const gcp = new GcProfiler(4096, {heap: true}).start();
    gcp.sampleHeap(performance.now(), process.memoryUsage().heapUsed);

    const samples = [];
    const t0 = Date.now();

    for (let c = 0; c < CYCLES; c++) {
        const r = await measure(tiny, {N: 200, k: 2, flushMs: 1});
        const g = suiteGate({source: SLAB, budgets: BUDGETS});
        const nd = toNDJSON([g, r], META);
        const handle = tracker.track(r, NOOP, c);

        if (leaky) {
            leakSink.push(r);    // witness 2a: the result retained forever
            leakSink.push(nd);   // witness 2b: its serialized output too
            // witness 1: registration never released (no untrack)
        } else {
            void nd;             // discarded: the normal cycle keeps nothing
            tracker.untrack(handle);
        }

        if ((c & 255) === 0) {
            await settleGc();
            samples.push(process.memoryUsage().heapUsed);
        }

        if (Date.now() - t0 > 120000) die('T5 soak exceeded 120s');
    }

    gcp.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    await gcp.settle();
    const summary = gcp.summary();
    gcp.stop();

    const trackerSize = tracker.size();
    const heapBandKB = (samples[samples.length - 1] - samples[0]) / 1024;
    // maxMajor is deliberately NOT a rule: measure() forces globalThis.gc()
    // four times per cycle, so the window is full of collections the library
    // caused on purpose. foreignForced is a diagnostic only.
    // maxPauseMs is 8, not the 4ms suite budget: that budget applies to the
    // package's OWN hot paths, but this window is dominated by ~32800 forced
    // full collections from the harness under test (observed maxMs 1.8-3.2ms
    // on the reference machine). The bound is set at 8 to gate a real pause
    // regression without banking on a 1.2x margin against forced-GC noise.
    const report = checkNoGc(summary, {maxPauseMs: 8});

    note('T5 soak: cycles ' + CYCLES + ' trackerSize ' + trackerSize +
        ' heapBand ' + heapBandKB.toFixed(1) + ' KB (limit 2048) samples ' +
        samples.length + ' | gc major ' + summary.gc.major + ' minor ' +
        summary.gc.minor + ' maxMs ' + summary.gc.maxMs.toFixed(2) +
        ' foreignForced ' + summary.gc.foreignForced + ' | verdict ' +
        report.verdict + ' node ' + process.version);

    let failed = false;
    if (trackerSize !== 0) {
        note('T5 witness: trackerSize=' + trackerSize + ' (must be 0)');
        failed = true;
    }
    if (!(heapBandKB < 2048)) {
        note('T5 witness: heapBandKB=' + heapBandKB.toFixed(1) + ' over 2048 KB limit');
        failed = true;
    }
    if (report.verdict !== 'pass') {
        note('T5 witness: checkNoGc verdict=' + report.verdict);
        for (let i = 0; i < report.violations.length; i++) {
            const v = report.violations[i];
            note('  violation ' + v.metric + ' limit=' + v.limit + ' actual=' + v.actual);
        }
        failed = true;
    }
    if (failed) {
        die('T5 soak: trackerSize=' + trackerSize + ', heapBandKB=' +
            heapBandKB.toFixed(1) + ', verdict=' + report.verdict);
    }
}

// ---------------------------------------------------------------------------
// Tier registry + driver
// ---------------------------------------------------------------------------

const TIERS = [
    {id: 'T1', name: 'detector matrix (child processes, library defaults)', run: t1},
    {id: 'T2', name: 'fail-closed doors (every door hit from outside)', run: t2},
    {id: 'T3', name: 'bypass corpus',            skip: 'P3'},
    {id: 'T4', name: 'suiteGate reduction gate', skip: 'P4'},
    {id: 'T5', name: 'footprint + 4096-cycle soak', run: t5}
];

async function main() {
    if (typeof globalThis.gc !== 'function') {
        die('run with --expose-gc: npm run torture');
    }
    for (let i = 0; i < TIERS.length; i++) {
        const tier = TIERS[i];
        if (tier.skip) {
            TIER_SKIP(tier.id, tier.skip);
            continue;
        }
        await tier.run();
    }
    process.stdout.write('ok\n');
    process.exit(0);
}

await main();
