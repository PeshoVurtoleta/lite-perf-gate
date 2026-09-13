// Fixture: a controls-only detector smoke run at LIBRARY DEFAULTS. Proves
// decision 0002 policy 6 -- with allowEmpty: true an empty scenarios array
// registers ONLY the detector-validation test, and that test names its
// reduced job ('detector validation only (allowEmpty, 0 scenarios)').
// Spawned as a child by self.test.mjs so its TAP output can be inspected.
import {zgcSuite} from '../../PerfGate.js';
zgcSuite({scenarios: [], allowEmpty: true});
