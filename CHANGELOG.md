# Changelog

## [1.0.0] - 2026-07-07

Initial release. Generalized from the `@zakkster/lite-signal` zero-GC gate
(`test/zgc/`) into a standalone, engine-agnostic library.

### Public API

- **`zgcSuite(config)`** -- register `node:test` cases for detector
  validation, scenario gating, and must-fail self-tests.
- **`measure(scenario, options?)`** -- raw measurement at N and k*N.
- **`verdict(result, thresholds?)`** -- evaluate against thresholds.
- **`runGate(config)`** -- standalone human-readable report.
- **`formatResult(result)`** -- one-line summary.
- **`controlPositive` / `controlNegative`** -- built-in detector controls.

### Methodology

Three signals: scavenge count (transient allocation), custom counters
(exact engine internals via `statsOf`), retained-heap delta (leaks).
Scaling verdict: measure at N and k*N. Detector self-validation: the gate
refuses to judge if the controls misbehave.

### Tests

12 self-tests covering controls, verdict logic, counter deltas, and
result shape.
