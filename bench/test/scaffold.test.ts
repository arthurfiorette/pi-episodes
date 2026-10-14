import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/args.js';
import { BENCH_DIR, loadModels, loadRunConfig } from '../src/config.js';
import { ConfigError } from '../src/fields.js';
import { Logger } from '../src/log.js';
import { loadScenario, REPO_NOTE, resolveScenarioDir, TRAP_TEXTS } from '../src/scenario.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const miniChain = fileURLToPath(new URL('./fixtures/mini-chain', import.meta.url));

test('run.json loads with absolute extension paths', () => {
  const config = loadRunConfig();
  assert.deepEqual(config.scenarios, ['fn-utils', 'expr-parsers', 'mapped-types']);
  assert.equal(config.conditions[0]?.id, 'A');
  assert.equal(config.conditions[0]?.extension, undefined);
  assert.equal(config.conditions[1]?.extension, join(root, 'src/index.ts'));
  assert.equal(config.caps.goalStepTurns, 150);
  assert.equal(config.checks.fullSuite, 'goal-steps');
  assert.deepEqual(config.compactionOverrides, {});
});

test('models.json loads', () => {
  const models = loadModels();
  assert.equal(models.length, 2);
  assert.deepEqual(models[0], {
    label: 'sonnet-4-5-med',
    model: 'anthropic/claude-sonnet-4-5',
    thinking: 'medium'
  });
});

test('config errors name the file and field', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-config-'));
  try {
    const path = join(dir, 'models.json');
    writeFileSync(path, JSON.stringify([{ label: 'x', model: 'anthropic/x', thinking: 'loud' }]));
    assert.throws(
      () => loadModels(path),
      (error: unknown) =>
        error instanceof ConfigError &&
        /models\.json\[0\]\.thinking: expected one of/.test(error.message)
    );
    const run = join(dir, 'run.json');
    writeFileSync(
      run,
      JSON.stringify({
        ...JSON.parse(readFileSync(join(BENCH_DIR, 'config/run.json'), 'utf8')),
        capz: {}
      })
    );
    assert.throws(() => loadRunConfig(run), /run\.json: unknown field capz/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mini-chain scenario loads with trap text and repo note inserted', () => {
  const scenario = loadScenario(miniChain);
  assert.equal(scenario.id, 'mini-chain');
  assert.equal(scenario.dir, miniChain);
  assert.equal(scenario.repo.source, join(miniChain, 'repo'));
  assert.equal(scenario.repo.baseCommit, undefined);
  assert.deepEqual(scenario.layout, { dir: 'test/held-out/{id}', test: 'index.test.js' });
  assert.equal(scenario.commands?.fixture, 'node --test {file}');
  assert.deepEqual(
    scenario.steps.map((step) => step.kind),
    ['goal', 'aside', 'goal', 'probe']
  );

  const [goal1, aside, goal2, probe] = scenario.steps;
  assert.ok(goal1 && aside && goal2 && probe);
  assert.ok(goal1.text.startsWith('`src/add.js` only exports `add`.'));
  assert.ok(goal1.text.endsWith(`\n\n${REPO_NOTE}`));
  assert.ok(!goal1.text.includes(TRAP_TEXTS['debug-print']!));
  assert.ok(goal2.text.startsWith('Back to the arithmetic work.'));
  assert.ok(goal2.text.endsWith(`\n\n${TRAP_TEXTS['debug-print']}`));
  assert.ok(!goal2.text.includes(REPO_NOTE));
  assert.ok(!aside.text.includes(REPO_NOTE));
  assert.deepEqual(probe.answer, { kind: 'fixed', pattern: 'src/add\\.js' });
  assert.equal(resolveScenarioDir(miniChain), miniChain);
  assert.equal(resolveScenarioDir('fn-utils'), join(BENCH_DIR, 'scenarios/fn-utils'));
});

test('scenario validation rejects dangling references', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-scenario-'));
  try {
    cpSync(miniChain, dir, { recursive: true });
    interface RawScenario {
      steps: { checks?: { fixtures: string[] }; trap?: string }[];
      traps: Record<string, unknown>;
      final: { traps: string[] };
      revertOrder: string[];
      variants: unknown[];
    }
    const base = JSON.parse(readFileSync(join(miniChain, 'scenario.json'), 'utf8')) as RawScenario;
    const write = (patch: (json: RawScenario) => void) => {
      const json = structuredClone(base);
      patch(json);
      writeFileSync(join(dir, 'scenario.json'), JSON.stringify(json));
    };
    write((json) => {
      json.steps[0]!.checks!.fixtures = ['nope'];
    });
    assert.throws(
      () => loadScenario(dir),
      /checks\.fixtures: "nope" is not a fixture of feature "mul"/
    );
    write((json) => {
      json.steps[2]!.trap = 'skip-typecheck';
    });
    assert.throws(() => loadScenario(dir), /trap: unknown trap "skip-typecheck"/);
    write((json) => {
      json.traps.custom = { files: ['x'], mustBeUnchanged: true };
      json.final.traps.push('custom');
    });
    assert.throws(() => loadScenario(dir), /trap "custom" has no built-in text/);
    write((json) => {
      json.revertOrder = ['mul'];
    });
    assert.throws(() => loadScenario(dir), /revertOrder is missing feature "sub"/);
    write((json) => {
      json.variants = [];
    });
    assert.throws(() => loadScenario(dir), /checks\.variants: unknown variant "mul-v"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseArgs handles values, flags and positionals', () => {
  const args = parseArgs(
    ['fn-utils', '--runs', '3', '--keep', 'x', '--models=a,b', '--resume', '--', '--literal'],
    ['keep']
  );
  assert.deepEqual(args.positionals, ['fn-utils', 'x', '--literal']);
  assert.equal(args.number('runs'), 3);
  assert.equal(args.flag('keep'), true);
  assert.deepEqual(args.list('models'), ['a', 'b']);
  assert.equal(args.flag('resume'), true);
  assert.equal(args.string('missing'), undefined);
  assert.throws(() => args.assertKnown(['runs', 'keep', 'models']), /unknown option --resume/);
});

test('logger writes JSON lines with context', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-log-'));
  try {
    const file = join(dir, 'nested', 'stdout.log');
    const log = new Logger({ file, stderr: false }).child({ trial: 't1' });
    log.info('step start', { step: 'goal-1', n: 1 });
    log.child({ step: 'goal-1' }).warn('slow');
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].level, 'info');
    assert.equal(lines[0].trial, 't1');
    assert.equal(lines[0].step, 'goal-1');
    assert.equal(lines[0].n, 1);
    assert.match(lines[0].ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(lines[1], {
      ...lines[1],
      level: 'warn',
      trial: 't1',
      step: 'goal-1',
      msg: 'slow'
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli --help exits 0 and lists the six commands with a description each', () => {
  const result = spawnSync(join(root, 'node_modules/.bin/tsx'), ['bench/src/cli.ts', '--help'], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  for (const name of ['run', 'validate', 'check', 'report', 'judge', 'probe']) {
    assert.match(result.stdout, new RegExp(`^  bench ${name}\\b.*\\n      \\S.*[.]$`, 'm'));
  }
  assert.equal((result.stdout.match(/^ {2}bench /gm) ?? []).length, 6);
  const stub = spawnSync(join(root, 'node_modules/.bin/tsx'), ['bench/src/cli.ts', 'report', 'x'], {
    cwd: root,
    encoding: 'utf8'
  });
  // `report` is implemented: an unknown run id is a clean error, not a crash.
  assert.equal(stub.status, 1);
  assert.match(stub.stderr, /bench report: no such run/);
});
