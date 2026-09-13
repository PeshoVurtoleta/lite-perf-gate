// test/probes/census-0003.mjs -- P3 GC-kind census, the input to
// decisions/0003-bypass-signals.md. Repo-only: never in package.json files[],
// never imported by PerfGate.js, never run by npm test or npm run torture.
//
// Run (all stages):     node --expose-gc --max-semi-space-size=4 test/probes/census-0003.mjs
// Corpus only:          PGC_MODE=corpus  node --expose-gc --max-semi-space-size=4 test/probes/census-0003.mjs
// Ambient only (100x):  PGC_MODE=ambient node --expose-gc --max-semi-space-size=4 test/probes/census-0003.mjs
//
// Every line starting "PGC " or "PGCAMB " is one JSON object: paste them
// verbatim into decisions/0003. Nothing else is written to stdout.
//
// The pass structure mirrors meterOnce EXACTLY (warmup -> gc2 -> capture
// before -> observer open -> hot -> flush sleep -> read+close -> settle gc2 ->
// capture after) so the numbers describe the library's real window, not a
// probe-shaped one. The only addition is a SECOND observer around the settle
// gc2 (decision shape 4) and per-entry timing/flags retention.
//
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>

import {PerformanceObserver, constants, performance} from 'node:perf_hooks';
import {setTimeout as sleep} from 'node:timers/promises';

if (typeof globalThis.gc !== 'function') {
    process.stderr.write('census: run with --expose-gc --max-semi-space-size=4\n');
    process.exit(2);
}

const MINOR = constants.NODE_PERFORMANCE_GC_MINOR;
const MAJOR = constants.NODE_PERFORMANCE_GC_MAJOR;
const INCR = constants.NODE_PERFORMANCE_GC_INCREMENTAL;
const WEAK = constants.NODE_PERFORMANCE_GC_WEAKCB;
const MODE = process.env.PGC_MODE || 'all';

function kindName(k) {
    if (k === MINOR) return 'minor';
    if (k === MAJOR) return 'major';
    if (k === INCR) return 'incremental';
    if (k === WEAK) return 'weakcb';
    return 'kind_' + String(k);
}

function makeRawCounter() {
    const rec = {minor: 0, major: 0, incremental: 0, weakcb: 0, other: 0, flags: {}, ent: []};
    const obs = new PerformanceObserver(function (list) {
        const es = list.getEntries();
        for (let i = 0; i < es.length; i++) {
            const e = es[i];
            const d = e.detail || {};
            const k = d.kind !== undefined ? d.kind : e.kind;
            const f = d.flags !== undefined ? d.flags : -1;
            const n = kindName(k);
            if (n === 'minor' || n === 'major' || n === 'incremental' || n === 'weakcb') rec[n]++;
            else rec.other++;
            const fk = n + '/' + String(f);
            rec.flags[fk] = (rec.flags[fk] || 0) + 1;
            rec.ent.push({k: n, f: f, s: e.startTime, d: e.duration});
        }
    });
    obs.observe({entryTypes: ['gc']});
    return {rec: rec, close: function () { obs.disconnect(); }};
}

async function gc2() {
    globalThis.gc();
    await new Promise(function (r) { setImmediate(r); });
    globalThis.gc();
}

function kinds(rec) {
    return {minor: rec.minor, major: rec.major, incremental: rec.incremental,
        weakcb: rec.weakcb, other: rec.other};
}

function timing(rec, open, close) {
    const t = {before: 0, inWin: 0, afterClose: 0, lateByKind: {},
        firstOffsetMs: null, lastOffsetMs: null};
    for (let i = 0; i < rec.ent.length; i++) {
        const e = rec.ent[i];
        const off = e.s - open;
        if (t.firstOffsetMs === null || off < t.firstOffsetMs) t.firstOffsetMs = off;
        if (t.lastOffsetMs === null || off > t.lastOffsetMs) t.lastOffsetMs = off;
        if (e.s < open) t.before++;
        else if (e.s <= close) t.inWin++;
        else {
            t.afterClose++;
            t.lateByKind[e.k] = (t.lateByKind[e.k] || 0) + 1;
        }
    }
    return t;
}

function pauses(rec) {
    const a = [];
    for (let i = 0; i < rec.ent.length; i++) a.push(rec.ent[i].d);
    a.sort(function (x, y) { return x - y; });
    if (a.length === 0) return {n: 0, p50: 0, p95: 0, max: 0};
    return {n: a.length, p50: a[Math.floor(a.length * 0.5)],
        p95: a[Math.min(a.length - 1, Math.floor(a.length * 0.95))], max: a[a.length - 1]};
}

// One pass = one meterOnce, instrumented. settleMs is the wait after the
// settle gc2 so its deferred entries are delivered before the second read.
async function censusPass(sc, iters, flushMs, settleMs) {
    const state = sc.setup();
    sc.hot(state, Math.min(iters, 20000));
    await gc2();

    const mb = process.memoryUsage();
    const wall0 = performance.now();

    const g = makeRawCounter();
    const open = performance.now();
    sc.hot(state, iters);
    const close = performance.now();
    await sleep(flushMs);
    const rec = g.rec;
    g.close();

    const s = makeRawCounter();
    const sOpen = performance.now();
    await gc2();
    await sleep(settleMs);
    const srec = s.rec;
    s.close();

    const ma = process.memoryUsage();
    const wall1 = performance.now();
    if (sc.teardown) sc.teardown(state);

    return {
        iters: iters,
        hotMs: close - open,
        passMs: wall1 - wall0,
        window: kinds(rec),
        windowFlags: rec.flags,
        windowTiming: timing(rec, open, close),
        windowPauseMs: pauses(rec),
        settle: kinds(srec),
        settleFlags: srec.flags,
        settleTotal: srec.minor + srec.major + srec.incremental + srec.weakcb + srec.other,
        settlePauseMs: pauses(srec),
        settleOpenOffsetMs: sOpen - open,
        retainedKB: (ma.heapUsed - mb.heapUsed) / 1024,
        arrayBuffersKB: (ma.arrayBuffers - mb.arrayBuffers) / 1024,
        externalKB: (ma.external - mb.external) / 1024
    };
}

// --------------------------------------------------------------------------
// The corpus. Every size is PINNED to the ROADMAP section 2 reproductions:
// C1 hi = 4000 x 600KB = 2.4GB (PG-02), C2 hi = 4096 x 512KB = 2.1GB (PG-03a),
// C3 hi = 256 x 64KB = 16MB retained (PG-03b). C4/C5 run at LIBRARY DEFAULTS.
// --------------------------------------------------------------------------

const LO_RING = new Array(16).fill(null);
const CHARS = ['a', 'b', 'c', 'd'];

const C1 = {
    name: 'C1 600KB-string LO churn (PG-02)',
    N: 500, k: 8,
    setup: function () { return {}; },
    hot: function (_s, n) {
        for (let i = 0; i < n; i++) LO_RING[i & 15] = CHARS[i & 3].repeat(614400);
    }
};

const AB_RING = new Array(16).fill(null);
const C2 = {
    name: 'C2 512KB Float64Array churn (PG-03a)',
    N: 512, k: 8,
    setup: function () { return {}; },
    hot: function (_s, n) {
        for (let i = 0; i < n; i++) AB_RING[i & 15] = new Float64Array(65536);
    }
};

const C3 = {
    name: 'C3 16MB retained ArrayBuffer pool (PG-03b)',
    N: 32, k: 8,
    setup: function () { return {pool: []}; },
    hot: function (s, n) {
        for (let i = 0; i < n; i++) s.pool.push(new ArrayBuffer(65536));
    }
};

const RING = new Array(64).fill(null);
const C4 = {
    name: 'C4 ring control (library positive control)',
    N: 200000, k: 8,
    setup: function () { return {}; },
    hot: function (_s, n) {
        for (let i = 0; i < n; i++) RING[i & 63] = {x: i, y: i + 1, z: i + 2, w: i + 3};
    }
};

const C5 = {
    name: 'C5 pure arithmetic (library negative control)',
    N: 200000, k: 8,
    setup: function () { return {acc: 0}; },
    hot: function (s, n) { let a = s.acc; for (let i = 0; i < n; i++) a += (i * 3) ^ i; s.acc = a; }
};

// controlLarge candidates: one 256KB string (> V8's ~128KB regular-object
// limit, so large-object space) every Mth iteration, into a 16-slot ring.
// Cost and signal strength here decide decision 3 (placement).
const CL_RING = new Array(16).fill(null);
function largeCandidate(label, mask) {
    return {
        name: 'C6 controlLarge candidate 1/' + (mask + 1) + ' x 256KB (' + label + ')',
        N: 200000, k: 8,
        setup: function () { return {}; },
        hot: function (_s, n) {
            for (let i = 0; i < n; i++) {
                if ((i & mask) === 0) CL_RING[(i >> 11) & 15] = CHARS[i & 3].repeat(262144);
            }
        }
    };
}

const CORPUS = [C1, C2, C3, C4, C5, largeCandidate('a', 2047), largeCandidate('b', 1023)];

function emit(tag, obj) {
    process.stdout.write(tag + ' ' + JSON.stringify(obj) + '\n');
}

async function corpusStage() {
    for (let i = 0; i < CORPUS.length; i++) {
        const sc = CORPUS[i];
        const lo = await censusPass(sc, sc.N, 100, 100);
        emit('PGC', Object.assign({scenario: sc.name, pass: 'lo', N: sc.N, k: sc.k,
            node: process.version, flags: '--expose-gc --max-semi-space-size=4'}, lo));
        const hi = await censusPass(sc, sc.k * sc.N, 100, 100);
        emit('PGC', Object.assign({scenario: sc.name, pass: 'hi', N: sc.N, k: sc.k,
            node: process.version, flags: '--expose-gc --max-semi-space-size=4'}, hi));
    }
}

// 100 reps of C4/C5 at the HI pass (k*N = 1.6M), library flush. This is the
// distribution that justifies (or moves) the maxOldGen / maxArrayBuffersKB
// defaults, and it folds in the T5 pause-noise question.
const REPS = 100;

async function ambientStage() {
    const scs = [C4, C5];
    for (let si = 0; si < scs.length; si++) {
        const sc = scs[si];
        const maj = [], inc = [], weak = [], minor = [], settle = [], abkb = [], rkb = [];
        const allPauses = [];
        for (let r = 0; r < REPS; r++) {
            const p = await censusPass(sc, sc.k * sc.N, 100, 25);
            maj.push(p.window.major); inc.push(p.window.incremental);
            weak.push(p.window.weakcb); minor.push(p.window.minor);
            settle.push(p.settleTotal); abkb.push(p.arrayBuffersKB); rkb.push(p.retainedKB);
            allPauses.push(p.windowPauseMs.max);
            emit('PGCAMBREP', {scenario: sc.name, rep: r, minor: p.window.minor,
                major: p.window.major, incremental: p.window.incremental,
                weakcb: p.window.weakcb, oldGen: p.window.major + p.window.incremental,
                settleTotal: p.settleTotal, arrayBuffersKB: p.arrayBuffersKB,
                retainedKB: p.retainedKB, maxPauseMs: p.windowPauseMs.max});
        }
        emit('PGCAMB', {scenario: sc.name, reps: REPS, node: process.version,
            minor: dist(minor), major: dist(maj), incremental: dist(inc),
            weakcb: dist(weak), oldGen: dist(add(maj, inc)), settleTotal: dist(settle),
            arrayBuffersKB: dist(abkb), retainedKB: dist(rkb), maxPauseMs: dist(allPauses),
            maxOldGen: Math.max.apply(null, add(maj, inc)),
            maxArrayBuffersKB: Math.max.apply(null, abkb)});
    }
}

function add(a, b) {
    const o = [];
    for (let i = 0; i < a.length; i++) o.push(a[i] + b[i]);
    return o;
}

function dist(a) {
    const s = a.slice().sort(function (x, y) { return x - y; });
    return {min: s[0], p50: s[Math.floor(s.length * 0.5)],
        p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], max: s[s.length - 1]};
}

if (MODE === 'corpus' || MODE === 'all') await corpusStage();
if (MODE === 'ambient' || MODE === 'all') await ambientStage();
process.exit(0);
