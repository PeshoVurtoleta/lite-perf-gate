// Gating a Vue reactivity tick for zero per-tick retention.
//
//   node --expose-gc examples/vue.mjs
//
// The question this answers: does re-running a reactive effect retain anything
// per tick? An effect that allocates on every dependency change turns a smooth
// component into a GC generator under load.
//
// ZERO-DEP STAND-IN: this package ships no dependencies, so `ref`/`effect`
// below are a ~12-line hand-rolled stand-in for Vue's reactivity primitives. In
// a real project you delete them and import the real ones:
//
//   import { ref, effect } from '@vue/reactivity';   // or 'vue'
//
// ...then mutate the ref inside the hot loop exactly as here. The COOKBOOK
// (Recipe 13) shows the real-Vue + node:test form.

import { measure, verdict } from '../PerfGate.js';

// --- hand-rolled Vue-shaped reactivity (replace with @vue/reactivity) --------
let activeEffect = null;
function ref(value) {
    const subs = [];                       // array, not a Set: index loop is zero-alloc
    return {
        get value() { if (activeEffect && subs.indexOf(activeEffect) === -1) subs.push(activeEffect); return value; },
        set value(v) { value = v; for (let j = 0; j < subs.length; j++) subs[j](); }
    };
}
function effect(fn) { activeEffect = fn; fn(); activeEffect = null; }
// ----------------------------------------------------------------------------

const count = ref(0);
const view = { total: 0 };                 // preallocated derived-state slot
effect(() => { view.total = count.value * 2; });

const scenario = {
    name: 'reactive tick',
    setup: () => ({}),
    hot: (_s, n) => { for (let i = 0; i < n; i++) { count.value = i; } }   // re-runs the effect
};

const r = await measure(scenario, { N: 20000, k: 4 });
const v = verdict(r, { maxScavenges: 2 });

console.log('Vue reactive tick -- verdict:', v.pass ? 'pass' : 'FAIL',
    '| scavenges', r.minorLo, '->', r.minorHi, '| view.total', view.total);
if (!v.pass) {
    console.error('reasons:', v.reasons.join('; '));
    process.exit(1);
}
