// test/torture/t2-doors.mjs -- T2 tier: the fail-closed doors (v1.4.0).
//
// Every door of decision 0002 hit from OUTSIDE the published surface --
// verdict(), measure(), runGate() -- each with its passing twin one valid
// step away, plus two children spawned WITHOUT --expose-gc. A normal torture
// run prints T2 NUMBERS on stderr (never "skipped"); a bad build dies here.
//
// T6 control-for-the-control: TORTURE_CONTROL=no-doors routes the three
// measured-NaN doors (D4/D5/D6) through a LOCAL legacy fail-open verdict shim
// -- the v1.3.0 `measured > limit` body, defined here, never touching
// PerfGate.js -- so those doors read as PASS and the tier MUST fail.

import {fileURLToPath} from 'node:url';
import {die, note, runChild, CONTROL} from './harness.mjs';
import {measure, verdict, runGate} from '../../PerfGate.js';

function fx(name) {
    return fileURLToPath(new URL('./fixtures/' + name, import.meta.url));
}

// The v1.3.0 fail-OPEN verdict body: `measured > limit` only, no NaN gate, no
// threshold validation, no unknown-key check. Used ONLY under the no-doors
// control so the sabotage lives here, not in the library.
function legacyVerdict(r, thresholds) {
    const maxScav = (thresholds && thresholds.maxScavenges !== undefined) ? thresholds.maxScavenges : 2;
    const maxRetKB = (thresholds && thresholds.maxRetainedKB !== undefined) ? thresholds.maxRetainedKB : 64;
    const ct = (thresholds && thresholds.counters) || null;
    const reasons = [];
    if (r.minorHi > maxScav) reasons.push('scavenges');
    if (r.retainedKB_hi > maxRetKB) reasons.push('retained');
    if (ct !== null && r.counters_hi !== null) {
        for (const key in ct) {
            const a = r.counters_hi[key];
            if (a !== undefined && a > ct[key]) reasons.push(key);
        }
    }
    return {pass: reasons.length === 0, reasons: reasons};
}

const tiny = {
    name: 'd',
    setup: function () { return {a: 0}; },
    hot: function (s, n) { let a = s.a; for (let i = 0; i < n; i++) a += (i * 3) ^ i; s.a = a; }
};

let cases = 0;
function hit(id, snippet) {
    cases++;
    note('T2 ' + id + ': ' + String(snippet).slice(0, 60));
}

function verdictThrows(id, thresholdsList) {
    const r = {name: 'x', minorHi: 0, retainedKB_hi: 0, counters_hi: {g: 0}};
    let lastMsg = '';
    for (let i = 0; i < thresholdsList.length; i++) {
        let threw = false;
        try { verdict(r, thresholdsList[i]); } catch (e) { threw = true; lastMsg = e.message; }
        if (!threw) die('T2 ' + id + ': verdict threshold ' + JSON.stringify(thresholdsList[i]) + ' did not throw');
    }
    hit(id, lastMsg);
}

function mustFailClosed(id, vfn, r, thresholds, needle) {
    const v = vfn(r, thresholds);
    if (v.pass !== false) {
        die('T2 ' + id + ': expected FAIL closed, got pass reasons=' + JSON.stringify(v.reasons));
    }
    if (needle && v.reasons.join(' | ').indexOf(needle) < 0) {
        die('T2 ' + id + ': reason missing "' + needle + '" got ' + JSON.stringify(v.reasons));
    }
    hit(id, v.reasons.join('; '));
}

async function measureThrows(id, optsList) {
    let lastMsg = '';
    for (let i = 0; i < optsList.length; i++) {
        let threw = false;
        try { await measure(tiny, optsList[i]); } catch (e) { threw = true; lastMsg = e.message; }
        if (!threw) die('T2 ' + id + ': measure(' + JSON.stringify(optsList[i]) + ') did not throw');
    }
    hit(id, lastMsg);
}

async function runGateRejects(id, cfgList) {
    // Each cfg throws at validateGate (runGate's first statement) before any
    // console.log, so no stdout pollution.
    let lastMsg = '';
    for (let i = 0; i < cfgList.length; i++) {
        let threw = false;
        try { await runGate(cfgList[i]); } catch (e) { threw = true; lastMsg = e.message; }
        if (!threw) die('T2 ' + id + ': runGate config #' + i + ' did not reject');
    }
    hit(id, lastMsg);
}

async function silent(fn) {
    const real = console.log;
    console.log = function () {};
    try { return await fn(); } finally { console.log = real; }
}

export async function t2() {
    note('T2 fail-closed doors (every door hit from outside)' +
        (CONTROL === 'no-doors' ? ' -- CONTROL: no-doors (D4/D5/D6 sabotaged)' : ''));

    const vfn = CONTROL === 'no-doors' ? legacyVerdict : verdict;

    // ---- threshold doors throw (PG-04) ------------------------------------
    verdictThrows('D1', [{maxScavenges: NaN}]);
    verdictThrows('D2', [{maxRetainedKB: -1}]);
    verdictThrows('D3', [{counters: {g: NaN}}]);

    // ---- measured NaN fails closed (PG-04); D4/D5/D6 are the sabotage lane -
    mustFailClosed('D4', vfn, {name: 'x', minorHi: NaN, retainedKB_hi: 0, counters_hi: null}, {}, 'scavenges: not a number');
    mustFailClosed('D5', vfn, {name: 'x', minorHi: 0, retainedKB_hi: NaN, counters_hi: null}, {}, 'retained: not a number');
    mustFailClosed('D6', vfn, {name: 'x', minorHi: 0, retainedKB_hi: 0, counters_hi: {g: NaN}}, {counters: {g: 0}}, 'g: not a number');

    // ---- unknown / absent counters fail closed (PG-05) --------------------
    mustFailClosed('D7', verdict, {name: 'x', minorHi: 0, retainedKB_hi: 0, counters_hi: {poolGrowths: 99}}, {counters: {poolGrowth: 0}}, 'no such counter measured');
    mustFailClosed('D8', verdict, {name: 'x', minorHi: 0, retainedKB_hi: 0, counters_hi: null}, {counters: {poolGrowth: 0}}, 'measured no counters');

    // ---- measure option doors throw (PG-09) -------------------------------
    await measureThrows('D9', [{N: -1}, {N: 0}, {N: 1.5}]);
    await measureThrows('D10', [{k: 0.5}, {k: 1}, {k: NaN}]);
    await measureThrows('D11', [{flushMs: -50}, {flushMs: NaN}, {flushMs: '10'}]);
    await measureThrows('D12', [{allowNoGc: 1}, {allowNoGc: 'yes'}]);
    await measureThrows('D13', [{allowEmpty: 1}]);

    // ---- empty / non-array scenarios and scenario shape (PG-08) -----------
    await runGateRejects('D14', [{}, {scenarios: 'x'}, {scenarios: []}]);
    await runGateRejects('D15', [
        {scenarios: [{}]},
        {scenarios: [tiny], mustFail: [{}]},
        {scenarios: [tiny], positiveControl: {}}
    ]);

    // ---- allowNoGc + explicit maxRetainedKB (PG-11) -----------------------
    await runGateRejects('D16', [{scenarios: [tiny], allowNoGc: true, maxRetainedKB: 64}]);

    // ---- passing twins, one valid step away from each door ----------------
    twinPass('D1', {name: 'x', minorHi: 0, retainedKB_hi: 0, counters_hi: {g: 0}}, {maxScavenges: 2});
    twinPass('D2', {name: 'x', minorHi: 0, retainedKB_hi: 0, counters_hi: {g: 0}}, {maxRetainedKB: 0});
    twinPass('D3', {name: 'x', minorHi: 0, retainedKB_hi: 0, counters_hi: {g: 0}}, {counters: {g: 0}});
    twinPass('D4', {name: 'x', minorHi: 0, retainedKB_hi: 0, counters_hi: null}, {});
    twinPass('D5', {name: 'x', minorHi: 0, retainedKB_hi: 0, counters_hi: null}, {});
    twinPass('D6', {name: 'x', minorHi: 0, retainedKB_hi: 0, counters_hi: {g: 0}}, {counters: {g: 0}});
    twinPass('D7', {name: 'x', minorHi: 0, retainedKB_hi: 0, counters_hi: {poolGrowths: 0}}, {counters: {poolGrowths: 0}});
    twinPass('D8', {name: 'x', minorHi: 0, retainedKB_hi: 0, counters_hi: {poolGrowth: 0}}, {counters: {poolGrowth: 0}});
    await twinNoThrow('D9', function () { return measure(tiny, {N: 2000, k: 2, flushMs: 1}); });
    await twinNoThrow('D10', function () { return measure(tiny, {N: 2000, k: 2, flushMs: 1}); });
    await twinNoThrow('D11', function () { return measure(tiny, {N: 2000, k: 2, flushMs: 0}); });
    await twinNoThrow('D12', function () { return measure(tiny, {N: 2000, k: 2, flushMs: 1, allowNoGc: true}); });
    await twinNoThrow('D13', function () { return silent(function () { return runGate({scenarios: [], allowEmpty: true, N: 2000, k: 2, flushMs: 1}); }); });
    await twinNoThrow('D14', function () { return silent(function () { return runGate({scenarios: [], allowEmpty: true, N: 2000, k: 2, flushMs: 1}); }); });
    await twinNoThrow('D15', function () { return silent(function () { return runGate({scenarios: [tiny], N: 2000, k: 2, flushMs: 1}); }); });
    await twinNoThrow('D16', function () { return silent(function () { return runGate({scenarios: [], allowEmpty: true, allowNoGc: true, N: 2000, k: 2, flushMs: 1}); }); });

    // ---- two bare children, spawned WITHOUT --expose-gc (flags: []) -------
    const a = runChild(fx('t2a-nogc.mjs'), {}, []).result;
    note('T2 child t2a: threw=' + a.threw + ' msg=' + String(a.msg).slice(0, 40));
    if (!(a.threw === true && /--expose-gc/.test(a.msg) && /allowNoGc/.test(a.msg))) {
        die('T2 t2a: measure without --expose-gc must throw with the run command; threw=' +
            a.threw + ' msg=' + a.msg);
    }
    const b = runChild(fx('t2b-allownogc.mjs'), {}, []).result;
    note('T2 child t2b: retainedReliable=' + b.retainedReliable +
        ' noThreshReasons=' + b.noThreshReasonCount + ' retThrew=' + b.retThrew);
    if (!(b.retainedReliable === false && b.noThreshReasonCount === 0 && b.retThrew === true)) {
        die('T2 t2b: allowNoGc contract broken: ' + JSON.stringify(b));
    }

    note('T2 ACTIVE: ' + cases + ' door cases + 2 bare children, all hit from outside' +
        (CONTROL === 'no-doors' ? ' (no-doors control should have failed above)' : ''));
}

function twinPass(id, r, thresholds) {
    const v = verdict(r, thresholds);
    if (!v.pass) die('T2 ' + id + ' twin should pass, reasons=' + JSON.stringify(v.reasons));
}

async function twinNoThrow(id, fn) {
    try { await fn(); } catch (e) { die('T2 ' + id + ' twin should not throw: ' + e.message); }
}
