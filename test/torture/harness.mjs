// test/torture/harness.mjs -- shared plumbing for test/torture.mjs.
//
// stdout is reserved for the single "ok" the top-level harness prints on a
// full pass; everything else (per-tier numbers, notes, failures) goes to
// stderr. A failed gate ends the process via die(): stderr line then exit 1.

import {spawnSync} from 'node:child_process';

/** Fail closed: name the reason on stderr and exit 1. */
export function die(msg) {
    process.stderr.write('torture: FAIL -- ' + msg + '\n');
    process.exit(1);
}

/** Diagnostic line on stderr (stdout is reserved for the single "ok"). */
export function note(msg) {
    process.stderr.write(msg + '\n');
}

/**
 * Spawn a torture child fixture in a bare process with GC flags. Uses
 * spawnSync (NOT execFileSync, which throws on non-zero exits -- T6 inspects
 * exit codes). Fails closed on timeout/signal, on a missing --expose-gc
 * (child exits 2), and on an unparseable result line.
 *
 * @param {string} fixtureAbsPath  absolute path to the child fixture
 * @param {object} [env]           extra env vars merged over process.env
 * @param {string[]} [flags]       node flags before the fixture path.
 *   Defaults to the GC flags; T2's no-gc children pass [] to prove the
 *   missing --expose-gc throw fires in a bare process.
 * @returns {{ result: object, r: object }}
 */
export function runChild(fixtureAbsPath, env, flags) {
    const nodeFlags = flags === undefined ? ['--expose-gc', '--max-semi-space-size=4'] : flags;
    const r = spawnSync(
        process.execPath,
        nodeFlags.concat([fixtureAbsPath]),
        {encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, env || {})}
    );
    if (r.status === null) {
        die('child ' + fixtureAbsPath + ' did not exit cleanly (signal=' +
            String(r.signal) + ', likely a timeout).');
    }
    if (r.status === 2) {
        die('child ran without --expose-gc: ' + fixtureAbsPath);
    }
    const result = parseResult(r.stdout);
    if (result === null) {
        die('child ' + fixtureAbsPath + ' produced no parseable PGT1 line. ' +
            'exit=' + r.status + ' stderr:\n' + (r.stderr || '').trim());
    }
    return {result: result, r: r};
}

/**
 * The LAST line beginning with "PGT1 " carries a JSON payload. Returns the
 * parsed object (must have at least {case, node}) or null on any failure.
 *
 * @param {string} stdout
 * @returns {object | null}
 */
export function parseResult(stdout) {
    if (typeof stdout !== 'string') return null;
    const lines = stdout.split('\n');
    let payload = null;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('PGT1 ') === 0) payload = lines[i].slice(5);
    }
    if (payload === null) return null;
    let obj;
    try {
        obj = JSON.parse(payload);
    } catch (_e) {
        return null;
    }
    if (!obj || typeof obj !== 'object') return null;
    if (typeof obj.case !== 'string' || typeof obj.node !== 'string') return null;
    return obj;
}

/** Announce a not-yet-implemented tier on stderr. */
export function TIER_SKIP(id, session) {
    note(id + ' skipped (' + session + ')');
}

// Sabotage selector for T6. The normal run is '' (empty). The control runs
// are the only other legal values; anything else is a typo and fails closed
// rather than silently running the green path.
export const CONTROL = process.env.TORTURE_CONTROL || '';
if (CONTROL !== '' && CONTROL !== 'stock-control' && CONTROL !== 'leaky-soak' &&
    CONTROL !== 'no-doors' && CONTROL !== 'zero-signal' &&
    CONTROL !== 'allocating-visit') {
    die('unknown TORTURE_CONTROL=' + CONTROL +
        ' (expected stock-control, leaky-soak, no-doors, zero-signal, or allocating-visit)');
}
