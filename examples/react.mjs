// Gating a React render loop for zero per-render retention.
//
//   node --expose-gc examples/react.mjs
//
// The question this answers: does re-rendering a component with new props
// retain anything per render? A render that allocates fresh objects it does not
// need makes reconciliation churn the heap on every keystroke.
//
// ZERO-DEP STAND-IN: this package ships no dependencies, so `render`/`useState`
// below are a ~12-line hand-rolled stand-in for React's render + hook cycle. In
// a real project you delete them and drive the real component:
//
//   import { createElement } from 'react';
//   import TestRenderer from 'react-test-renderer';
//   const hot = (_s, n) => { for (let i = 0; i < n; i++)
//     TestRenderer.act(() => root.update(createElement(Row, { i }))); };
//
// The COOKBOOK (Recipe 12) shows the real-React + node:test form.

import { measure, verdict } from '../PerfGate.js';

// --- hand-rolled React-shaped render (replace with react-test-renderer) ------
// Preallocated vnode + hook storage the component reuses -- the zero-retention
// shape. (Real React allocates an element per render; this stand-in isolates
// YOUR render body, the part your code controls and the part worth gating.
// Note it avoids array-destructuring the hook tuple in the hot path, because
// destructuring an array spins up an iterator object per call.)
const vnode = { type: 'div', props: { children: null } };
let hookState = 0;
const setSelected = (val) => { hookState = val; };   // stable setter, hoisted once
const hookTuple = [0, setSelected];                  // reused, never reallocated
function useState() { hookTuple[0] = hookState; return hookTuple; }
function render(Component, props) { return Component(props); }

function Row(props) {
    const state = useState();
    state[1](props.i & 1);              // state update, as on a real interaction
    vnode.props.children = props.i;     // write into the reused vnode, no new object
    return vnode;
}
// ----------------------------------------------------------------------------

const scenario = {
    name: 'Row render',
    setup: () => ({ props: { i: 0 } }),
    hot: (s, n) => { for (let i = 0; i < n; i++) { s.props.i = i; render(Row, s.props); } }
};

const r = await measure(scenario, { N: 20000, k: 4 });
const v = verdict(r, { maxScavenges: 2 });

console.log('React Row render -- verdict:', v.pass ? 'pass' : 'FAIL',
    '| scavenges', r.minorLo, '->', r.minorHi, '| retained', r.retainedKB_hi.toFixed(0) + 'KB');
if (!v.pass) {
    console.error('reasons:', v.reasons.join('; '));
    process.exit(1);
}
