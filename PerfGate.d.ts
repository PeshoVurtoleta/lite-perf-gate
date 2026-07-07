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
