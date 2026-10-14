import assert from 'node:assert/strict';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatTable, validateScenario } from '../src/commands/validate.js';
import { loadScenario } from '../src/scenario.js';
import type { ValidateJson } from '../src/types.js';

const miniChain = fileURLToPath(new URL('./fixtures/mini-chain', import.meta.url));

const REFERENCE_ADD = [
  'export function add(a, b) {',
  '  return a + b;',
  '}',
  '',
  'export function mul(a, b) {',
  '  return a * b;',
  '}',
  '',
  'export function sub(a, b) {',
  '  return a - b;',
  '}',
  ''
].join('\n');

/** A temp copy of the mini-chain; `reference/` is the overlay validate applies for the restored side. */
function scenarioCopy(dir: string, options: { reference?: boolean; featureInRepo?: boolean } = {}) {
  const scenarioDir = join(dir, 'scenario');
  cpSync(miniChain, scenarioDir, { recursive: true });
  if (options.reference) {
    mkdirSync(join(scenarioDir, 'reference', 'src'), { recursive: true });
    writeFileSync(join(scenarioDir, 'reference', 'src', 'add.js'), REFERENCE_ADD);
  }
  if (options.featureInRepo) {
    writeFileSync(join(scenarioDir, 'repo', 'src', 'add.js'), REFERENCE_ADD);
  }
  return loadScenario(scenarioDir);
}

test('the two-sided gate is green on the mini-chain with a reference overlay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-validate-'));
  try {
    const scenario = scenarioCopy(dir, { reference: true });
    const result = await validateScenario(scenario, { repeat: 2, workDir: join(dir, 'work') });
    const table = formatTable(result);
    assert.equal(result.ok, true, table);
    assert.deepEqual(result.failures, []);
    assert.equal(result.suiteTests.sealed, 1);
    assert.equal(result.suiteTests.restored, 3);
    assert.deepEqual(result.fixtureTests, { mul: 1, sub: 1 });
    assert.deepEqual(result.preChange, {});
    const names = result.rows.map((row) => row.name);
    for (const expected of [
      'no AGENTS.md',
      'no .pi',
      'held-out mul absent',
      '[1/2] sealed: typecheck passes',
      '[1/2] sealed: mul fails',
      '[1/2] sealed: variant mul-v fails',
      '[1/2] sealed: suite green',
      '[1/2] restored: mul passes',
      '[1/2] restored: sub passes',
      '[1/2] restored: variant mul-v passes',
      '[1/2] restored: suite green',
      '[2/2] suite counts add up'
    ]) {
      assert.ok(names.includes(expected), `${expected} missing from:\n${table}`);
    }
    assert.match(table, /gate: green/);
    const written = JSON.parse(
      readFileSync(join(scenario.dir, 'validate.json'), 'utf8')
    ) as ValidateJson;
    assert.equal(written.ok, true);
    assert.equal(written.repeats, 2);
    assert.equal(written.suiteTests.sealed, 1);
    assert.ok(!('rows' in written));
    assert.ok(existsSync(join(scenario.dir, 'variants', 'mul-v', 'index.test.js')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the gate goes red when the reference does not make the held-out fixtures pass', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-validate-'));
  try {
    const scenario = scenarioCopy(dir);
    const result = await validateScenario(scenario, { repeat: 1, workDir: join(dir, 'work') });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((failure) => failure.startsWith('[1/1] restored: mul passes')));
    assert.ok(
      result.failures.some((failure) => failure.startsWith('[1/1] restored: variant mul-v passes'))
    );
    assert.ok(result.failures.some((failure) => failure.startsWith('[1/1] restored: suite green')));
    assert.ok(!result.failures.some((failure) => failure.includes('sealed:')));
    assert.match(formatTable(result), /gate: \d+ failure/);
    const written = JSON.parse(
      readFileSync(join(scenario.dir, 'validate.json'), 'utf8')
    ) as ValidateJson;
    assert.equal(written.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the gate goes red when the sealed tree already contains the feature', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-validate-'));
  try {
    const scenario = scenarioCopy(dir, { reference: true, featureInRepo: true });
    const result = await validateScenario(scenario, { repeat: 1, workDir: join(dir, 'work') });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((failure) => failure.startsWith('[1/1] sealed: mul fails')));
    assert.ok(
      result.failures.some((failure) => failure.startsWith('[1/1] sealed: variant mul-v fails'))
    );
    assert.ok(!result.failures.some((failure) => failure.includes('restored:')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('forbidden files and a broken sealed suite are reported', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-validate-'));
  try {
    const scenario = scenarioCopy(dir, { reference: true });
    writeFileSync(join(scenario.dir, 'repo', 'AGENTS.md'), 'hints\n');
    appendFileSync(
      join(scenario.dir, 'repo', 'test', 'add.test.js'),
      "test('broken', () => { throw new Error('x'); });\n"
    );
    const result = await validateScenario(scenario, { repeat: 1, workDir: join(dir, 'work') });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((failure) => failure.startsWith('no AGENTS.md')));
    assert.ok(result.failures.some((failure) => failure.startsWith('[1/1] sealed: suite green')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
