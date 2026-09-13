// Fixture: a minimal consumer suite at LIBRARY DEFAULTS. Spawned as a child
// by self.test.mjs. Must be green on a healthy machine (PG-01 inverted).
import {zgcSuite} from '../../PerfGate.js';
zgcSuite({
    scenarios: [{
        name: 'arith-only',
        setup: function () { return {acc: 0}; },
        hot: function (s, n) { let a = s.acc; for (let i = 0; i < n; i++) a += (i * 3) ^ i; s.acc = a; }
    }]
});
