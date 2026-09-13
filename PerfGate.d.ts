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
    /** Old-gen activity (major + incremental) at N. */
    oldGenLo: number;
    /** Old-gen activity (major + incremental) at k*N. GATE signal (default max 0). */
    oldGenHi: number;
    retainedKB_lo: number;
    retainedKB_hi: number;
    /** External/backing-store (memoryUsage().arrayBuffers) delta in KB at N. */
    arrayBuffersKB_lo: number;
    /** External delta in KB at k*N. GATE signal (default max 64). */
    arrayBuffersKB_hi: number;
    /** Custom counter deltas at N, or null if no statsOf. */
    counters_lo: Record<string, number> | null;
    /** Custom counter deltas at k*N, or null if no statsOf. */
    counters_hi: Record<string, number> | null;
    /** False when measured without --expose-gc (allowNoGc). Absent means reliable. */
    retainedReliable?: boolean;
}

export interface MeasureOptions {
    /** Iteration count (low). Integer >= 1. Default 200000. */
    N?: number;
    /** Scale factor (high = k*N). Integer >= 2. Default 8. */
    k?: number;
    /** Wait (ms) after the hot loop. Finite >= 0 (0 is legal and honored). Default 100. */
    flushMs?: number;
    /** Run without --expose-gc; retained is dropped and retainedReliable is false. */
    allowNoGc?: boolean;
}

export interface Thresholds {
    /** Max allowed scavenges at k*N. Default 2. */
    maxScavenges?: number;
    /** Max retained heap growth in KB. Default 64. */
    maxRetainedKB?: number;
    /**
     * Max allowed old-gen activity (major + incremental) at k*N. Default 0.
     * When it trips, diagnose the cause with @zakkster/lite-gc-profiler.
     */
    maxOldGen?: number;
    /**
     * Max allowed external/arrayBuffers growth in KB at k*N. Default 64.
     * Ungated under allowNoGc; an explicit value with allowNoGc throws.
     */
    maxArrayBuffersKB?: number;
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
    /** Max old-gen activity (major + incremental) at k*N. Default 0. */
    maxOldGen?: number;
    /** Max external/arrayBuffers growth in KB at k*N. Default 64 (undefined under allowNoGc). */
    maxArrayBuffersKB?: number;
    /** Counter thresholds for statsOf deltas. */
    counters?: Record<string, number>;
    /** Override positive control. */
    positiveControl?: Scenario;
    /** Override negative control. */
    negativeControl?: Scenario;
    /** Override the large/external detector control (controlLarge). */
    largeControl?: Scenario;
    /** Scenarios that MUST trip the gate (injected allocation self-tests). */
    mustFail?: Scenario[];
    /**
     * Wait (ms) after the hot loop before reading the GC observer buffer.
     * Default 100 (or PERF_GATE_FLUSH_MS env var). Bump to 250-500 on
     * noisy CI runners where event-loop stalls > 100ms may drop entries.
     * 0 is legal and honored.
     */
    flushMs?: number;
    /**
     * Permit an empty scenarios array: the ONLY sanctioned empty gate, a
     * controls-only detector smoke run. Otherwise an empty/missing/non-array
     * scenarios throws.
     */
    allowEmpty?: boolean;
    /**
     * Run without --expose-gc. The retained rule is not applied at all (the
     * default 64KB threshold included) and combining it with an explicit
     * maxRetainedKB throws. Scavenges and counters still gate.
     */
    allowNoGc?: boolean;
}

export interface GateResult {
    passed: boolean;
    /** 0 pass, 1 scenario or must-fail failure, 2 detector validation failed. passed === (code === 0). */
    code: 0 | 1 | 2;
    results: MeasureResult[];
}

/**
 * Measure a scenario at N and k*N iterations. Returns raw measurements.
 * Bad options throw; missing --expose-gc throws unless allowNoGc is set.
 */
export function measure(
    scenario: Scenario,
    options?: MeasureOptions
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
 * Built-in large/external control: a bounded, mask-gated retained pool of 64KB
 * ArrayBuffers that trips the arrayBuffers signal. Validates the external
 * detector in zgcSuite/runGate (decisions/0003).
 */
export const controlLarge: Scenario;

/**
 * Register node:test cases: detector validation, scenario gating, and
 * must-fail self-tests. The primary public API.
 *
 * Run with: `node --expose-gc --max-semi-space-size=4 --test your.test.mjs`
 */
export function zgcSuite(config: GateConfig): void;

/**
 * Standalone human-readable gate report. Returns `{ passed, code, results }`;
 * never touches process.exitCode -- map result.code to your exit code.
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
    /**
     * Optional presence assertion. Integer >= 0 (else RangeError at config).
     * Fails the budget when fewer records matched than minCount, with reason
     * '<name>: matched <count> < minCount <n>'. Omitted or 0 is inert: a
     * zero-match budget still reduces to 0 and passes (v1.1 back-compat).
     */
    minCount?: number;
}

export interface SuiteBudgetResult {
    name: string;
    value: number;
    count: number;
    max: number;
    /** The effective minCount (0 when the budget omitted it). */
    minCount: number;
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
 * targets (base-record t/a/b slots only).
 *
 * The source contract (v1.4.0 record doors, decisions/0004):
 *  THROWS (data-integrity refusal): a slab record whose packed header is not
 *  a u32 (RangeError naming the record index); a non-Float64Array or
 *  cross-realm typed-array source (its forEach binds (value, index, array));
 *  a forEach source whose ANY invocation is not four numbers (checked every
 *  record, naming the invocation index and slot); slot/reduce
 *  inherited-prototype keys; a budget targeting CONT (0x0F01), op or packed
 *  form; a bad minCount.
 *  FAILS a budget (verdict): a reduced value that is not finite ->
 *  '<name>: not a number (fail closed)'; count < minCount ->
 *  '<name>: matched <count> < minCount <n>'. Budget names may be any non-empty
 *  string, including 'toString' / '__proto__' / 'constructor'.
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
