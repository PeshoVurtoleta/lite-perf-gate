/**
 * @zakkster/lite-perf-gate
 * Zero-GC and performance regression gate for node:test.
 *
 * Copyright (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License
 */

export declare const VERSION: string;

/** A measurement scenario. Engine-agnostic. */
export interface Scenario<State = any> {
    /** Human-readable name shown in reports and test labels. */
    name: string;
    /** Build the graph / state. Called once per measurement pass. */
    setup(): State;
    /**
     * The hot loop. Must run `n` iterations against `state`. This is the
     * ONLY code inside the measurement window.
     */
    hot(state: State, n: number): void;
    /**
     * Return an object of numeric counters (e.g. `{ poolGrowths: 0 }`).
     * Called before and after the hot loop; deltas are computed automatically.
     */
    statsOf?(state: State): Record<string, number>;
    /** Clean up after measurement. */
    teardown?(state: State): void;
}

export interface MeasureResult {
    name: string;
    N: number;
    k: number;
    /** Minor GC (scavenge) count at N iterations. */
    minorLo: number;
    /** Minor GC (scavenge) count at k*N iterations. */
    minorHi: number;
    majorLo: number;
    majorHi: number;
    retainedKB_lo: number;
    retainedKB_hi: number;
    /** Custom counter deltas at N, or null if no statsOf. */
    counters_lo: Record<string, number> | null;
    /** Custom counter deltas at k*N, or null if no statsOf. */
    counters_hi: Record<string, number> | null;
}

export interface Thresholds {
    /** Max allowed scavenges at k*N. Default 2. */
    maxScavenges?: number;
    /** Max retained heap growth in KB. Default 64. */
    maxRetainedKB?: number;
    /** Per-counter maximum allowed delta. */
    counters?: Record<string, number>;
}

export interface Verdict {
    pass: boolean;
    reasons: string[];
}

export interface GateConfig {
    /** Zero-GC scenarios to gate. */
    scenarios: Scenario[];
    /** Iteration count (low). Default 200000. */
    N?: number;
    /** Scale factor (high = k*N). Default 8. */
    k?: number;
    /** Max allowed scavenges at k*N. Default 2. */
    maxScavenges?: number;
    /** Max retained heap growth in KB. Default 64. */
    maxRetainedKB?: number;
    /** Counter thresholds for statsOf deltas. */
    counters?: Record<string, number>;
    /** Override positive control. */
    positiveControl?: Scenario;
    /** Override negative control. */
    negativeControl?: Scenario;
    /** Scenarios that MUST trip the gate (injected allocation self-tests). */
    mustFail?: Scenario[];
    /**
     * Wait (ms) after the hot loop before reading the GC observer buffer.
     * Default 100 (or PERF_GATE_FLUSH_MS env var). Bump to 250-500 on
     * noisy CI runners where event-loop stalls > 100ms may drop entries.
     */
    flushMs?: number;
}

export interface GateResult {
    passed: boolean;
    results: MeasureResult[];
}

/**
 * Measure a scenario at N and k*N iterations. Returns raw measurements.
 */
export function measure(
    scenario: Scenario,
    options?: { N?: number; k?: number; flushMs?: number }
): Promise<MeasureResult>;

/**
 * Evaluate a measurement result against thresholds.
 */
export function verdict(r: MeasureResult, thresholds?: Thresholds): Verdict;

/** One-line summary of a measurement result. */
export function formatResult(r: MeasureResult): string;

/** Built-in positive control (allocates per iteration). */
export const controlPositive: Scenario;

/** Built-in negative control (pure arithmetic, zero allocation). */
export const controlNegative: Scenario;

/**
 * Register node:test cases: detector validation, scenario gating, and
 * must-fail self-tests. The primary public API.
 *
 * Run with: `node --expose-gc --max-semi-space-size=4 --test your.test.mjs`
 */
export function zgcSuite(config: GateConfig): void;

/**
 * Standalone human-readable gate report. Returns pass/fail and raw results.
 */
export function runGate(config: GateConfig): Promise<GateResult>;

/** @internal */
export function _controlKeepAlive(): number;

// ---------------------------------------------------------------------------
// suiteGate (v1.1) + toNDJSON (v1.2)
// ---------------------------------------------------------------------------

/** forEach-style SPP record source (e.g. a lite-scope memory sink). */
export interface SppRecordSource {
    forEach(cb: (packed: number, t: number, a: number, b: number) => void): void;
}

export interface SuiteBudget {
    name: string;
    /** Exact packed header (streamId << 16 | opcode). */
    packed?: number;
    /** Stream id; combine with op for an exact match. */
    stream?: number;
    /** Opcode; alone it matches the op on any stream. */
    op?: number;
    /** Record slot to read. Default 'a'. */
    slot?: 't' | 'a' | 'b';
    /** Reduction over matching records. Default 'max'. */
    reduce?: 'count' | 'sum' | 'max' | 'mean' | 'last';
    /** Inclusive budget: verdict() flags value > max. */
    max: number;
}

export interface SuiteBudgetResult {
    name: string;
    value: number;
    count: number;
    max: number;
    pass: boolean;
    reasons: string[];
}

export interface SuiteGateResult {
    name: string;
    pass: boolean;
    reasons: string[];
    budgets: SuiteBudgetResult[];
}

/**
 * Evaluate SPP stream records against numeric budgets. Pure reduction with
 * per-budget delegation to verdict(); no measurement, no process exit
 * codes, no record emission. Wide-record CONT payloads are not budget
 * targets in v1.1 (base-record t/a/b slots only).
 */
export function suiteGate(config: {
    source: Float64Array | SppRecordSource;
    budgets: SuiteBudget[];
    name?: string;
}): SuiteGateResult;

/**
 * Serialize suiteGate() and/or measure() results as NDJSON for CI
 * artifacts: one JSON object per line, budget lines before their
 * suite-gate summary, trailing newline. `meta` fields merge into every
 * line; core fields win on collision.
 */
export function toNDJSON(
    x: SuiteGateResult | MeasureResult | Array<SuiteGateResult | MeasureResult>,
    meta?: Record<string, unknown>
): string;
