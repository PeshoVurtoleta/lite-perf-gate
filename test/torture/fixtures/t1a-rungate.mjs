// T1a child: runGate at LIBRARY DEFAULTS in a bare process. Proves the
// detector self-validates (PG-01 inverted) where the self-test could not,
// because the test runner's own allocations mask the broken control.
// PGT_SABOTAGE=stock swaps in the grow-forever control so T6 can prove the
// tier fails. Emits exactly one PGT1 line on stdout.
if (typeof globalThis.gc !== 'function') { process.stderr.write('fixture: missing --expose-gc\n'); process.exit(2); }

import {runGate, controlPositive} from '../../../PerfGate.js';

const sink = [];
const stockControl = {
    name: 'CONTROL+ (stock grow-forever sink -- SABOTAGE)',
    setup: function () { return {}; },
    hot: function (_s, n) {
        for (let i = 0; i < n; i++) sink.push({x: i, y: i + 1, z: i + 2, w: i + 3});
        if (sink.length > 3000000) sink.length = 0;
    }
};

const sabotage = process.env.PGT_SABOTAGE === 'stock';
// allowEmpty: the torture-side proof of decision 0002 policy 6 -- a
// controls-only detector smoke run. Without it runGate now throws on [].
const config = {scenarios: [], allowEmpty: true};
if (sabotage) config.positiveControl = stockControl;

// Buffer console.log so the human report never pollutes stdout; the only
// stdout line this fixture emits is the PGT1 payload below.
const buffer = [];
const realLog = console.log;
console.log = function () {
    let s = '';
    for (let i = 0; i < arguments.length; i++) s += (i ? ' ' : '') + String(arguments[i]);
    buffer.push(s);
};
let out;
try {
    out = await runGate(config);
} finally {
    console.log = realLog;
}
void controlPositive;

const joined = buffer.join('\n');
const sawFailureLine = joined.indexOf('DETECTOR VALIDATION FAILED') >= 0;

process.stdout.write('PGT1 ' + JSON.stringify({
    case: 't1a',
    node: process.version,
    passed: out.passed,
    resultsLen: out.results.length,
    sawFailureLine: sawFailureLine
}) + '\n');
