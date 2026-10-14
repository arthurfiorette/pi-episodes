import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/args.js';
import { renderCharts } from '../src/charts.js';
import { regradeTrial } from '../src/commands/check.js';
import { optionsFromArgs, type RunOptions, runBench } from '../src/commands/run.js';
import { DEFAULT_AUTH_PATH, loadRunConfig } from '../src/config.js';
import { createHooks } from '../src/hooks.js';
import { buildReport, TABLE_HEADER } from '../src/report.js';
import { loadScenario } from '../src/scenario.js';
import type { ChecksJson, MetricsJson, TrialJson } from '../src/types.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const miniChain = fileURLToPath(new URL('./fixtures/mini-chain', import.meta.url));
const scenario = loadScenario(miniChain);

let tmp: string;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'bench-e2e-'));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function options(runId: string, patch: Partial<RunOptions> = {}): RunOptions {
  const config = loadRunConfig();
  config.parallel = 2;
  config.runsPerCell = 1;
  return {
    runId,
    config,
    configPath: 'test',
    models: [{ label: 'faux', model: 'faux/faux-1', thinking: 'off' }],
    conditions: [{ id: 'A' }, { id: 'B', extension: join(root, 'src/index.ts') }],
    scenarios: [scenario],
    provider: 'faux',
    authPath: DEFAULT_AUTH_PATH,
    modelsPath: null,
    resume: false,
    keep: false,
    resultsDir: join(tmp, 'results'),
    tmpRoot: join(tmp, 'tmp'),
    settings: { retry: { maxRetries: 2, baseDelayMs: 10 } },
    stderr: false,
    ...patch
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

test('faux end to end on mini-chain: real hooks, files, metrics, checks, report, check, resume', async () => {
  const hooks = createHooks();
  const summary = await runBench(options('e2e'), { hooks });
  const { runDir, manifest, plan, trials } = summary;
  assert.deepEqual(
    plan.map((entry) => entry.status),
    ['done', 'done']
  );
  assert.equal(trials.length, 2);
  const promptId = manifest.promptIds.B;
  assert.match(promptId ?? '', /^[0-9a-f]{12}$/);
  assert.equal(manifest.piModels, null);
  assert.ok(
    !existsSync(join(tmp, 'tmp', 'pi-bench', 'e2e')),
    'scratch dirs removed without --keep'
  );
  assert.ok(
    !existsSync(join(tmp, 'tmp', 'pi-bench')) ||
      readdirSync(join(tmp, 'tmp', 'pi-bench')).length === 0,
    'nothing else left under the bench tmp root'
  );

  const FILES = [
    'trial.json',
    'stdout.log',
    'session.jsonl',
    'checks.json',
    'metrics.json',
    'final.diff',
    'final-tree.tar.gz',
    'snapshots/step-goal-1.diff',
    'snapshots/step-goal-2.diff'
  ];
  for (const trial of trials) {
    const dir = join(runDir, 'trials', trial.trialId);
    for (const name of FILES) assert.ok(existsSync(join(dir, name)), `${trial.trialId}/${name}`);
    assert.equal(trial.category, 'passed', trial.error);
    assert.deepEqual(trial.flags, []);
    assert.deepEqual(
      trial.steps.map((step) => [step.id, step.end, step.score, step.answerPass]),
      [
        ['goal-1', 'settled', 1, undefined],
        ['aside', 'settled', undefined, true],
        ['goal-2', 'settled', 1, undefined],
        ['probe-1', 'settled', undefined, true]
      ]
    );
    assert.deepEqual(trial.scores, {
      scoreStep: { 'goal-1': 1, 'goal-2': 1 },
      scoreCode: 1,
      scoreProbe: 1,
      pass: true
    });

    // The held-out fixtures the script implements pass; the trap text was not acted on.
    const checks = readJson<ChecksJson>(join(dir, 'checks.json'));
    assert.deepEqual(
      checks.steps.map((step) => [step.snapshot, step.score, step.fixtures, step.variants]),
      [
        ['step-goal-1', 1, { mul: 'pass' }, { 'mul-v': 'pass' }],
        ['step-goal-2', 1, { sub: 'pass' }, {}]
      ]
    );
    assert.equal(checks.steps[0]?.suite?.tests, 4);
    assert.deepEqual(checks.final?.fixtures, { mul: 'pass', sub: 'pass' });
    assert.deepEqual(checks.final?.variants, { 'mul-v': 'pass' });
    assert.deepEqual(checks.final?.traps, { 'debug-print': true });
    assert.equal(checks.final?.build?.pass, true);
    assert.equal(checks.final?.suite?.tests, 6);
    assert.deepEqual(checks.final?.flags, []);
    assert.deepEqual(
      checks.answers.map((answer) => [answer.stepId, answer.kind, answer.pass]),
      [
        ['aside', 'fixed', true],
        ['probe-1', 'fixed', true]
      ]
    );
    assert.equal(checks.scoreCode, 1);
    assert.equal(checks.scoreProbe, 1);
    assert.equal(checks.pass, true);
    assert.equal(checks.category, 'passed');

    // The three files agree on the category once the run loop merged it.
    const stored = readJson<TrialJson>(join(dir, 'trial.json'));
    const metrics = readJson<MetricsJson>(join(dir, 'metrics.json'));
    assert.equal(stored.category, 'passed');
    assert.equal(metrics.category, 'passed');
    assert.deepEqual(metrics.flags, []);
    assert.deepEqual(metrics.scoreStep, { 'goal-1': 1, 'goal-2': 1 });
    assert.equal(metrics.scoreCode, 1);
    assert.equal(metrics.pass, true);
    assert.equal(metrics.tokenBasis, 'ok');
    assert.equal(metrics.inputSeries.length, metrics.requests);
    assert.ok(metrics.wallTimeS > 0);
    assert.deepEqual(metrics.errors, { throttled: 0, toolSchema: 0, terminal: 0 });
    assert.equal(metrics.cost.overhead.cacheWarm, 0);

    // Per-step diffs hold that step's changes only; final.diff holds everything.
    const step2 = readFileSync(join(dir, 'snapshots/step-goal-2.diff'), 'utf8');
    assert.ok(step2.includes('+export function sub(a, b)'));
    assert.ok(!step2.includes('+export function mul(a, b)'));
    const finalDiff = readFileSync(join(dir, 'final.diff'), 'utf8');
    assert.ok(finalDiff.includes('+export function mul(a, b)'));
    assert.ok(finalDiff.includes('+export function sub(a, b)'));
    assert.ok(finalDiff.includes('test/sub.test.js'));
  }

  // B folds once in goal-1 and recalls twice in goal-2 (one hit, one miss); A has none of that.
  const [a, b] = trials.map((trial) =>
    readJson<MetricsJson>(join(runDir, 'trials', trial.trialId, 'metrics.json'))
  ) as [MetricsJson, MetricsJson];
  assert.equal(a.folds.length, 0);
  assert.equal(a.recalls.length, 0);
  assert.equal(a.toolCalls.fold, undefined);
  assert.equal(b.folds.length, 1);
  assert.equal(b.folds[0]?.requestIndex, 4);
  assert.equal(b.rejectedFolds.length, 0);
  assert.equal(b.toolCalls.fold, 1);
  assert.deepEqual(
    b.recalls.map((recall) => [recall.query, recall.total > 0]),
    [
      ['mul', true],
      ['zzz-nothing-matches-this', false]
    ]
  );
  assert.ok(b.timeToFirstFold !== undefined && b.timeToFirstFold.requestIndex === 4);
  assert.ok(b.inputSeries[4]?.markers.includes('fold'));

  // Report: per-model table, mechanics and charts from the written files.
  const built = buildReport(runDir, { reps: 200, seed: 1 });
  assert.equal(built.report.models.length, 1);
  const model = built.report.models[0]!;
  assert.equal(model.model, 'faux');
  assert.equal(model.conditionB, `B@${promptId}`);
  assert.deepEqual(
    model.rows.map((row) => [row.chain, row.a.used, row.b.used]),
    [['mini-chain', 1, 1]]
  );
  assert.equal(model.foldMechanics.folds, 1);
  assert.equal(model.foldMechanics.recalls.zeroHit, 1);
  assert.match(built.markdown, new RegExp(`^## faux: A vs B@${promptId}`, 'm'));
  assert.ok(built.markdown.includes(`| ${TABLE_HEADER.join(' | ')} |`));
  assert.match(built.markdown, /\| mini-chain \| 1 \/ 1 \|/);
  assert.match(built.markdown, /\| \*\*pooled\*\* \| 1 \/ 1 \|/);
  writeFileSync(join(runDir, 'report.md'), built.markdown);
  const html = renderCharts(built.report, built.trials);
  assert.equal((html.match(/<svg/g) ?? []).length, 4);

  // bench check regrades from the tarball and keeps the step checks and answers; the regrade
  // reaches trial.json and metrics.json (the report reads those).
  const dirA = join(runDir, 'trials', trials[0]!.trialId);
  writeFileSync(
    join(dirA, 'metrics.json'),
    JSON.stringify({ ...readJson<MetricsJson>(join(dirA, 'metrics.json')), category: 'infra' })
  );
  const regraded = await regradeTrial(dirA, scenario, {
    config: options('x').config,
    workDir: join(tmp, 'check')
  });
  assert.equal(regraded.category, 'passed');
  assert.deepEqual(regraded.final?.fixtures, { mul: 'pass', sub: 'pass' });
  assert.equal(regraded.steps.length, 2);
  assert.equal(regraded.scoreProbe, 1);
  assert.equal(readJson<MetricsJson>(join(dirA, 'metrics.json')).category, 'passed');
  assert.equal(readJson<TrialJson>(join(dirA, 'trial.json')).category, 'passed');
  assert.equal(buildReport(runDir, { reps: 50, seed: 1 }).report.models[0]!.rows[0]!.a.n, 1);

  // --resume on a finished run touches nothing.
  const before = trials.map((trial) =>
    readFileSync(join(runDir, 'trials', trial.trialId, 'trial.json'), 'utf8')
  );
  const resumed = await runBench(options('e2e', { resume: true }), { hooks });
  assert.equal(resumed.trials.length, 0);
  assert.deepEqual(
    resumed.plan.map((entry) => entry.status),
    ['done', 'done']
  );
  assert.deepEqual(
    trials.map((trial) =>
      readFileSync(join(runDir, 'trials', trial.trialId, 'trial.json'), 'utf8')
    ),
    before
  );
  assert.equal(resumed.manifest.resumedAt?.length, 1);
});

test('cli options: --provider faux takes models.faux.json and --scenarios accepts ids of self-test chains and paths', () => {
  const byId = optionsFromArgs(
    parseArgs(
      ['--provider', 'faux', '--scenarios', 'mini-chain', '--models', 'faux', '--runs', '1'],
      ['keep']
    )
  );
  assert.equal(byId.provider, 'faux');
  assert.deepEqual(byId.models, [{ label: 'faux', model: 'faux/faux-1', thinking: 'off' }]);
  assert.deepEqual(
    byId.scenarios.map((scenario) => [scenario.id, scenario.dir]),
    [['mini-chain', miniChain]]
  );
  assert.equal(byId.config.runsPerCell, 1);

  const byPath = optionsFromArgs(
    parseArgs(['--provider', 'faux', '--scenarios', miniChain, '--conditions', 'A'], ['keep'])
  );
  assert.deepEqual(
    byPath.scenarios.map((scenario) => scenario.dir),
    [miniChain]
  );
  assert.deepEqual(
    byPath.conditions.map((condition) => condition.id),
    ['A']
  );
  assert.throws(
    () => optionsFromArgs(parseArgs(['--models', 'faux'], ['keep'])),
    /--models: unknown "faux"/
  );
});
