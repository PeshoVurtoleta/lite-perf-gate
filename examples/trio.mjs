// The trio: gate, diagnose, attribute -- one leak, three tools.
//
//   node --expose-gc examples/trio.mjs
//
// Unlike the framework examples, this one uses the REAL sibling packages
// (@zakkster/lite-gc-profiler and @zakkster/lite-leak are devDependencies), so
// nothing is hand-rolled. It demonstrates the division of labour:
//   1. lite-perf-gate GATES the hot path and fails on the regression;
//   2. lite-gc-profiler DIAGNOSES how many bytes leaked per call;
//   3. lite-leak ATTRIBUTES what outlived its owner.
// This is the D1 demo's script in prose. The example exits 0 when the gate
// correctly CATCHES the planted leak -- catching it is the success condition.

import { measure, verdict } from '../PerfGate.js';
import { measureAllocs } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';

// A leaky handler: it pushes one record per call into a cache that is never
// bounded -- the classic "gets slower the longer it runs" server leak.
const cache = [];
function handle(i) { const rec = { id: i, at: i * 2 }; cache.push(rec); return rec; }

// 1) GATE -- perf-gate sees the transient allocation and fails.
const scenario = {
    name: 'leaky handler',
    setup: () => { cache.length = 0; return {}; },
    hot: (_s, n) => { for (let i = 0; i < n; i++) handle(i); }
};
const r = await measure(scenario, { N: 50000, k: 4 });
const v = verdict(r, { maxScavenges: 2 });
console.log('1. perf-gate  :', v.pass ? 'PASS (unexpected!)' : 'FAIL -- ' + v.reasons.join('; '));

// 2) DIAGNOSE -- gc-profiler quantifies retained bytes per call.
cache.length = 0;
const allocs = measureAllocs((i) => handle(i), { iterations: 5000, batches: 8 });
console.log('2. gc-profiler: bytesPerCall floor =', allocs.bytesPerCall);

// 3) ATTRIBUTE -- lite-leak names what outlived its owner.
const tracker = createLeakTracker({ name: 'trio' });
const rec = handle(-1);
const id = rec.id;                                   // detached primitive (held-value contract)
const h = tracker.track(rec, () => { void id; }, 'cache-record');
console.log('3. lite-leak  : tracking', tracker.size(), 'live handle(s) for tag "cache-record"');
tracker.untrack(h);

// Success condition: the gate must have CAUGHT the planted leak.
if (v.pass) {
    console.error('trio: the gate FAILED to catch a known leak -- instrument is blind');
    process.exit(1);
}
console.log('\ntrio: gate caught it, profiler sized it, leak attributed it.');
