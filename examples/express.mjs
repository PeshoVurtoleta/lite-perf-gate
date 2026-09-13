// Gating a server route handler for zero per-request retention.
//
//   node --expose-gc examples/express.mjs
//
// The question this answers: does a route handler retain anything per request?
// A handler that builds a fresh object per call is straight GC pressure under
// load -- the server that "gets slower the more traffic it takes".
//
// ZERO-DEP STAND-IN: this package ships no runtime dependencies (suite law), so
// this file cannot import Express or Fastify. The `req`/`res` below are a
// hand-rolled stand-in. In a real project you delete them and drive the real
// handler under your framework's test harness:
//
//   import express from 'express';
//   const app = express();
//   app.get('/price', price);
//   // ...then gate `price` with measure() exactly as here.
//
// The COOKBOOK (Recipe 11) shows the real-Express + node:test form. Swapping in
// the real framework changes what *routes* to the handler, not what measure()
// measures -- your handler body.

import { measure, verdict } from '../PerfGate.js';

// --- YOUR handler: reuses res.locals, allocates no per-request object --------
function price(req, res) { res.locals.total = req.query.qty * 2; }

// --- the hot path under gate: invoke the handler with fresh input -----------
const scenario = {
    name: 'GET /price',
    setup: () => ({ req: { query: { qty: 0 } }, res: { locals: {} } }),
    hot: (s, n) => { for (let i = 0; i < n; i++) { s.req.query.qty = i; price(s.req, s.res); } }
};

const r = await measure(scenario, { N: 100000, k: 4 });
const v = verdict(r, { maxScavenges: 2 });

console.log('Express /price handler -- verdict:', v.pass ? 'pass' : 'FAIL',
    '| scavenges', r.minorLo, '->', r.minorHi, '| retained', r.retainedKB_hi.toFixed(0) + 'KB');
if (!v.pass) {
    console.error('reasons:', v.reasons.join('; '));
    process.exit(1);
}
