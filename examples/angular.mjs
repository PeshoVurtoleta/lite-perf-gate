// Gating an Angular change-detection cycle for zero per-cycle retention.
//
//   node --expose-gc examples/angular.mjs
//
// The question this answers: does one change-detection cycle retain anything?
// Angular runs detectChanges() constantly under zone.js; a template binding
// that allocates per cycle multiplies straight into jank.
//
// ZERO-DEP STAND-IN: this package ships no dependencies, so the component +
// detectChanges below are a ~12-line hand-rolled stand-in for Angular's change
// detection. In a real project you delete them and drive the real component:
//
//   import { TestBed } from '@angular/core/testing';
//   const fixture = TestBed.createComponent(RowComponent);
//   const hot = (_s, n) => { for (let i = 0; i < n; i++) {
//     fixture.componentInstance.i = i; fixture.detectChanges(); } };
//
// The COOKBOOK (Recipe 14) shows the real-Angular + node:test form.

import { measure, verdict } from '../PerfGate.js';

// --- hand-rolled Angular-shaped change detection (replace with TestBed) ------
// The view model is preallocated; detectChanges writes bindings into it in
// place -- the zero-retention shape a template should compile to.
function createComponent() {
    const view = { index: 0, even: false };   // preallocated binding targets
    const instance = { i: 0 };
    return {
        componentInstance: instance,
        detectChanges() { view.index = instance.i & 255; view.even = (instance.i & 1) === 0; },
        _view: view
    };
}
// ----------------------------------------------------------------------------

const fixture = createComponent();

const scenario = {
    name: 'detectChanges',
    setup: () => ({}),
    hot: (_s, n) => { for (let i = 0; i < n; i++) { fixture.componentInstance.i = i; fixture.detectChanges(); } }
};

const r = await measure(scenario, { N: 20000, k: 4 });
const v = verdict(r, { maxScavenges: 2 });

console.log('Angular detectChanges -- verdict:', v.pass ? 'pass' : 'FAIL',
    '| scavenges', r.minorLo, '->', r.minorHi, '| retained', r.retainedKB_hi.toFixed(0) + 'KB');
if (!v.pass) {
    console.error('reasons:', v.reasons.join('; '));
    process.exit(1);
}
