// T2a child: measure() WITHOUT --expose-gc must throw with the exact run
// command in the message (PG-11 inverted). Spawned by t2-doors.mjs with an
// EMPTY node-flags list, so globalThis.gc is undefined. No --expose-gc guard:
// the missing flag is the point. Emits exactly one PGT1 line, exits 0, never
// hangs.
import {measure} from '../../../PerfGate.js';

const tiny = {
    name: 't2a',
    setup: function () { return {a: 0}; },
    hot: function (s, n) { let a = s.a; for (let i = 0; i < n; i++) a += (i * 3) ^ i; s.a = a; }
};

let threw = false;
let msg = '';
try {
    await measure(tiny, {N: 2000, k: 2});
} catch (e) {
    threw = true;
    msg = e.message;
}

process.stdout.write('PGT1 ' + JSON.stringify({
    case: 't2a',
    node: process.version,
    threw: threw,
    msg: msg
}) + '\n');
process.exit(0);
