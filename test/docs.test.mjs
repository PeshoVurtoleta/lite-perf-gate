// Docs-drift guard for @zakkster/lite-perf-gate.
//
// Run: node --test test/docs.test.mjs   (no --expose-gc needed: this file is
// side-effect-free -- it never calls measure()/runGate()/zgcSuite(), it only
// imports the namespace and parses the docs).
//
// The truth is the RUNTIME namespace (import * as PG), not a source regex, so a
// re-export or a rename cannot fool it. Both directions are enforced:
//   (a) every named export appears in llms.txt AND in the README API reference;
//   (b) every constants-table row name and every documented option/threshold
//       name resolves to a real identifier in PerfGate.js source;
//   (c) every constants-table value equals the source literal it documents;
//   (d) every relative README link resolves on disk.
// Provably load-bearing: deleting an export mention from llms.txt (a), adding a
// fake row such as maxMajors to the table (b), and breaking a relative link (d)
// each turn a test in this file red.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as PG from '../PerfGate.js';

const ROOT = new URL('../', import.meta.url);
const README = readFileSync(new URL('README.md', ROOT), 'utf8');
const LLMS = readFileSync(new URL('llms.txt', ROOT), 'utf8');
const SOURCE = readFileSync(new URL('PerfGate.js', ROOT), 'utf8');

const EXPORTS = Object.keys(PG).sort();

function reEsc(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function word(name, hay) {
    return new RegExp('\\b' + reEsc(name) + '\\b').test(hay);
}
function h2Section(md, heading) {
    const re = new RegExp('^## ' + reEsc(heading) + '.*$', 'm');
    const m = re.exec(md);
    if (!m) return null;
    const rest = md.slice(m.index + m[0].length);
    const next = rest.search(/^## /m);
    return next === -1 ? rest : rest.slice(0, next);
}

const API = h2Section(README, 'API reference');

// --- (a) exports are documented in both llms.txt and the README API reference

test('docs: every named export is documented in the README API reference', () => {
    assert.ok(API !== null, 'README is missing its "## API reference" section');
    for (const name of EXPORTS) {
        assert.ok(word(name, API),
            'export "' + name + '" is not documented in the README API reference section');
    }
});

test('docs: every named export is documented in llms.txt', () => {
    for (const name of EXPORTS) {
        assert.ok(word(name, LLMS),
            'export "' + name + '" is not documented in llms.txt');
    }
});

// --- the constants table ----------------------------------------------------

const CONSTANTS = h2Section(README, 'API reference');

function tableRows() {
    // Only the Constants sub-table uses `name` | `value` cells; other tables in
    // the README do not wrap both of the first two cells in single backticks.
    const start = CONSTANTS.indexOf('### Constants');
    assert.ok(start >= 0, 'README API reference is missing its "### Constants" table');
    const body = CONSTANTS.slice(start);
    const rowRe = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/gm;
    const rows = [];
    let m;
    while ((m = rowRe.exec(body)) !== null) {
        rows.push({ name: m[1], value: m[2].replace(/^'|'$/g, '') });
    }
    return rows;
}

// name -> expected value (VERSION from the runtime namespace, the rest literal)
const EXPECTED = {
    VERSION: PG.VERSION,
    N: '200000',
    k: '8',
    flushMs: '100',
    maxScavenges: '2',
    maxRetainedKB: '64',
    maxOldGen: '0',
    maxArrayBuffersKB: '64',
    CONTROL_FLOOR: '6',
    CONTROL_SCALE: '2',
    CONTROL_NEG_CEIL: '2',
    CONTROL_LARGE_FLOOR: '277',
    CONTROL_RING_SIZE: '64'
};

// name -> a regex proving PerfGate.js binds that name to that value
const SOURCE_BINDING = {
    VERSION: (v) => new RegExp("export const VERSION = '" + reEsc(v) + "'"),
    N: (v) => new RegExp('let N = ' + v + ';'),
    k: (v) => new RegExp('let k = ' + v + ';'),
    flushMs: (v) => new RegExp('let DEFAULT_FLUSH_MS = ' + v + ';'),
    maxScavenges: (v) => new RegExp('maxScavenges !== undefined \\? [\\w.]+ : ' + v),
    maxRetainedKB: (v) => new RegExp('maxRetainedKB !== undefined \\? [\\w.]+ : ' + v),
    maxOldGen: (v) => new RegExp('maxOldGen !== undefined \\? [\\w.]+ : ' + v),
    maxArrayBuffersKB: (v) => new RegExp('maxArrayBuffersKB !== undefined \\? [\\w.]+ : ' + v),
    CONTROL_FLOOR: (v) => new RegExp('const CONTROL_FLOOR = ' + v + '\\b'),
    CONTROL_SCALE: (v) => new RegExp('const CONTROL_SCALE = ' + v + '\\b'),
    CONTROL_NEG_CEIL: (v) => new RegExp('const CONTROL_NEG_CEIL = ' + v + '\\b'),
    CONTROL_LARGE_FLOOR: (v) => new RegExp('const CONTROL_LARGE_FLOOR = ' + v + '\\b'),
    CONTROL_RING_SIZE: (v) => new RegExp('const CONTROL_RING_SIZE = ' + v + '\\b')
};

// --- (b) no fabricated constants: every table row name is real in the source

test('docs: every constants-table row name exists in PerfGate.js source', () => {
    const rows = tableRows();
    assert.ok(rows.length >= Object.keys(EXPECTED).length,
        'constants table has fewer rows (' + rows.length + ') than expected');
    for (const row of rows) {
        assert.ok(word(row.name, SOURCE),
            'constants-table row "' + row.name + '" names no identifier in PerfGate.js ' +
            '(a fabricated or renamed constant -- e.g. maxMajors is not the shipped name)');
    }
});

// --- (c) every documented constant value equals the source literal ----------

test('docs: every constants-table value equals the PerfGate.js source literal', () => {
    const rows = tableRows();
    const byName = Object.create(null);
    for (const row of rows) byName[row.name] = row.value;
    for (const name of Object.keys(EXPECTED)) {
        assert.equal(byName[name], EXPECTED[name],
            'constants table for "' + name + '" reads "' + byName[name] +
            '", expected "' + EXPECTED[name] + '"');
        const re = SOURCE_BINDING[name](EXPECTED[name]);
        assert.ok(re.test(SOURCE),
            'PerfGate.js does not bind "' + name + '" to ' + EXPECTED[name] +
            ' (' + re + ')');
    }
});

// --- (b, cont.) documented option/threshold names resolve in the source -----

// Every config option and threshold name the docs document, across GateConfig /
// MeasureOptions / Thresholds / Scenario / SuiteBudget. Cross-checked against
// llms.txt and the README API reference; if the docs grow a new option, add it
// here so the "every documented option resolves in source" claim stays literal.
const OPTION_NAMES = [
    'N', 'k', 'flushMs', 'PERF_GATE_FLUSH_MS', 'maxScavenges', 'maxRetainedKB',
    'maxOldGen', 'maxArrayBuffersKB', 'counters', 'minCount', 'allowNoGc',
    'allowEmpty', 'mustFail', 'scenarios', 'positiveControl', 'negativeControl',
    'largeControl', 'name', 'packed', 'stream', 'op', 'slot', 'reduce', 'max'
];

test('docs: every documented option/threshold name exists in PerfGate.js source', () => {
    for (const name of OPTION_NAMES) {
        const inReadme = word(name, README);
        const inLlms = word(name, LLMS);
        if (inReadme || inLlms) {
            assert.ok(word(name, SOURCE),
                'documented option/threshold "' + name + '" does not exist in PerfGate.js source');
        }
    }
});

// --- (d) every relative README link resolves --------------------------------

test('docs: every relative README link resolves on disk', () => {
    // Every ](...) target that is not an external URL (http/https/mailto) and not
    // a pure in-page anchor (#...) is a file path and must resolve on disk.
    const linkRe = /\]\(([^)]+)\)/g;
    const seen = new Set();
    let m;
    while ((m = linkRe.exec(README)) !== null) {
        const target = m[1].trim();
        if (/^(https?:\/\/|mailto:)/i.test(target)) continue;   // external
        const path = target.split('#')[0];                      // drop any fragment
        if (path === '') continue;                              // pure anchor
        seen.add(path);
    }
    assert.ok(seen.size > 0, 'README has no relative links to check (expected decisions/, COOKBOOK, LICENSE)');
    for (const rel of seen) {
        const abs = fileURLToPath(new URL(rel, ROOT));
        assert.ok(existsSync(abs), 'relative README link "' + rel + '" does not resolve to a file');
    }
});
