// Fixture: same minimal consumer suite, but the positive control is
// SABOTAGED with the stock grow-forever shape that PG-01 documented -- a
// module-level array that pushes {x,y,z,w} per iter and truncates at 3M.
// Its objects survive every scavenge, so V8 pretenures the site to old
// space and the scavenge signal dies (minorHi drops below the floor). The
// suite must go red with DETECTOR VALIDATION FAILED / need >=6. The
// sabotage lives HERE, never in the library.
import {zgcSuite} from '../../PerfGate.js';

const sink = [];
const stockControl = {
    name: 'CONTROL+ (stock grow-forever sink -- SABOTAGE)',
    setup: function () {
        return {};
    },
    hot: function (_s, n) {
        for (let i = 0; i < n; i++) sink.push({x: i, y: i + 1, z: i + 2, w: i + 3});
        if (sink.length > 3000000) sink.length = 0;
    }
};

// N is pinned SMALL on purpose. Under `node --test`, the runner's own
// allocations land inside the measurement window and SCALE with its length,
// so at library defaults (N=200000) the harness noise (~30 scavenges at 8N)
// swamps the pretenured control and the sabotage becomes invisible -- the
// exact masking decisions/0001 documents and the reason T1 spawns BARE
// children. At N=20000 the window is short enough that noise stays minimal
// while pretenuring still kills the signal, so the floor clause trips
// deterministically (measured 4 scavenges at 8N, need >=6, 10/10 runs).
// The CONTROL SHAPE is the faithful historical bug; only the iteration
// count is chosen so the bug is observable under a test runner at all.
zgcSuite({
    N: 20000,
    k: 8,
    positiveControl: stockControl,
    scenarios: [{
        name: 'arith-only',
        setup: function () { return {acc: 0}; },
        hot: function (s, n) { let a = s.acc; for (let i = 0; i < n; i++) a += (i * 3) ^ i; s.acc = a; }
    }]
});
