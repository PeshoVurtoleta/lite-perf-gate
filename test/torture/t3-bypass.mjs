// test/torture/t3-bypass.mjs -- T3 tier: the allocation-bypass corpus as
// permanent fixtures (PG-02 / PG-03a / PG-03b), each measured in a bare child
// at a pinned deterministic window and judged at DEFAULT thresholds. Where the
// census (decisions/0003) proved a bypass is catchable, T3 asserts it is
// caught by its recorded signal; where it proved a bypass fires no countable
// signal on this Node (C1, Axis A4), T3 asserts the measured HOLE so a future
// Node that closes it will flip the fixture.
//
// T6 control-for-the-control: TORTURE_CONTROL=zero-signal routes
// PGT_SABOTAGE=zero-signal into every child, which zeroes oldGenHi and
// arrayBuffersKB_hi BEFORE the child's verdict (test-code only, never a library
// flag). That defeats the two new lanes, so t3b (oldgen) and t3c (arrayBuffers)
// are no longer caught and the tier MUST fail -- proving the new signals are
// load-bearing.

import {fileURLToPath} from 'node:url';
import {die, note, runChild, CONTROL} from './harness.mjs';

function fx(name) {
    return fileURLToPath(new URL('./fixtures/' + name, import.meta.url));
}

function needle(reasons, s) {
    return reasons.join(' | ').indexOf(s) >= 0;
}

export async function t3() {
    note('T3 bypass corpus (PG-02/PG-03 as permanent fixtures)' +
        (CONTROL === 'zero-signal' ? ' -- CONTROL: zero-signal (oldgen/arrayBuffers zeroed in child)' : ''));

    const env = CONTROL === 'zero-signal' ? {PGT_SABOTAGE: 'zero-signal'} : {};

    const a = runChild(fx('t3a-lo-string.mjs'), env).result;
    note('T3a C1 600KB-string LO churn (PG-02): pass=' + a.pass + ' oldGenHi=' + a.oldGenHi +
        ' arrayBuffersKB_hi=' + a.arrayBuffersKB_hi.toFixed(0) + ' minorHi=' + a.minorHi +
        ' retainedKB_hi=' + a.retainedKB_hi.toFixed(0) + ' node ' + a.node);

    const b = runChild(fx('t3b-ab-churn.mjs'), env).result;
    note('T3b C2 512KB Float64Array churn (PG-03a): pass=' + b.pass + ' oldGenHi=' + b.oldGenHi +
        ' reasons=' + JSON.stringify(b.reasons) + ' node ' + b.node);

    const c = runChild(fx('t3c-ab-pool.mjs'), env).result;
    note('T3c C3 16MB retained pool (PG-03b): pass=' + c.pass + ' arrayBuffersKB_hi=' +
        c.arrayBuffersKB_hi.toFixed(0) + ' retainedKB_hi=' + c.retainedKB_hi.toFixed(0) +
        ' reasons=' + JSON.stringify(c.reasons) + ' node ' + c.node);

    const d = runChild(fx('t3d-ring.mjs'), env).result;
    note('T3d ring scavenge control: pass=' + d.pass + ' minorHi=' + d.minorHi +
        ' reasons=' + JSON.stringify(d.reasons) + ' node ' + d.node);

    // t3a -- the A4 documented hole. C1 fires no countable signal on this Node,
    // so it PASSES at defaults; T3 asserts the measured signature of the hole.
    // The zero-signal sabotage does not change it (both new fields already 0).
    if (!(a.pass === true && a.oldGenHi === 0 && a.arrayBuffersKB_hi < 64 &&
          a.minorHi <= 2 && a.retainedKB_hi < 64)) {
        die('T3a: C1 documented hole (A4) changed signature -- pass=' + a.pass +
            ' oldGenHi=' + a.oldGenHi + ' arrayBuffersKB_hi=' + a.arrayBuffersKB_hi +
            ' minorHi=' + a.minorHi + ' retainedKB_hi=' + a.retainedKB_hi +
            ' (expected pass=true, oldGen 0, arrayBuffers<64, minor<=2, retained<64) node ' + a.node);
    }

    // t3b -- must be CAUGHT by the oldgen lane. Under zero-signal sabotage the
    // catch disappears and this assertion fails, failing the tier.
    if (!(b.pass === false && needle(b.reasons, 'oldgen:'))) {
        die('T3b: C2 Float64Array churn must be caught by oldgen -- pass=' + b.pass +
            ' reasons=' + JSON.stringify(b.reasons) + ' node ' + b.node);
    }

    // t3c -- must be CAUGHT by the arrayBuffers lane, and retained must still be
    // blind to it (the PG-03b inversion). Sabotage defeats the catch -> fail.
    if (!(c.pass === false && needle(c.reasons, 'arrayBuffers:') && c.retainedKB_hi < 64)) {
        die('T3c: C3 retained pool must be caught by arrayBuffers with retained blind -- pass=' +
            c.pass + ' retainedKB_hi=' + c.retainedKB_hi + ' reasons=' +
            JSON.stringify(c.reasons) + ' node ' + c.node);
    }

    // t3d -- the scavenge lane still catches classic churn (sabotage is scoped
    // to the new lanes; minorHi is untouched).
    if (!(d.pass === false && needle(d.reasons, 'scavenges:'))) {
        die('T3d: ring churn must stay caught by scavenges -- pass=' + d.pass +
            ' reasons=' + JSON.stringify(d.reasons) + ' node ' + d.node);
    }

    note('T3 ACTIVE: 4 bypass fixtures -- C2 caught by oldgen, C3 by arrayBuffers, ' +
        'ring by scavenges, C1 (PG-02) recorded as a documented hole (decisions/0003 A4)');
}
