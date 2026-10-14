import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/args.js';
import {
  CONSECUTIVE_INFRA_STOP,
  defaultRunId,
  interruptRun,
  optionsFromArgs,
  type RunOptions,
  reportExit,
  runBench,
  type SharedRun,
  scoreFixedAnswer
} from '../src/commands/run.js';
import { DEFAULT_AUTH_PATH, loadRunConfig } from '../src/config.js';
import { type FauxScript, loadFauxScript } from '../src/faux.js';
import { sha256 } from '../src/jsonl.js';
import { Logger } from '../src/log.js';
import { loadPlan, resetInterrupted, savePlan } from '../src/plan.js';
import { loadScenario } from '../src/scenario.js';
import type {
  ConditionSpec,
  Hooks,
  ModelSpec,
  PlanEntry,
  RunConfig,
  Step,
  StepResult,
  TrialContext
} from '../src/types.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const miniChain = fileURLToPath(new URL('./fixtures/mini-chain', import.meta.url));
const scripts = fileURLToPath(new URL('./scripts', import.meta.url));
const scenario = loadScenario(miniChain);
const model: ModelSpec = { label: 'faux', model: 'faux/faux-1', thinking: 'off' };
const A: ConditionSpec = { id: 'A' };
const B: ConditionSpec = { id: 'B', extension: join(root, 'src/index.ts') };
const CHECK_DELAY_MS = 300;

let tmp: string;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'bench-run-'));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface HookCall {
  hook: keyof Hooks;
  trial: string;
  step?: string;
  /** Steps recorded on the trial when the hook ran. */
  steps: number;
  at: number;
}

/** In-memory stand-in for repo.ts and checks.ts: a sealed copy of the fixture repo, trivial scores. */
function fakeHooks(calls: HookCall[]): Hooks {
  const note = (hook: keyof Hooks, trial: TrialContext, step?: string) =>
    calls.push({
      hook,
      trial: trial.record.trialId,
      ...(step === undefined ? {} : { step }),
      steps: trial.record.steps.length,
      at: Date.now()
    });
  return {
    async setup(trial) {
      note('setup', trial);
      const repoDir = join(trial.tmpDir, 'repo');
      cpSync(trial.scenario.repo.source, repoDir, { recursive: true });
      const git = (args: string[]) =>
        execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
      git(['init', '-q']);
      git(['add', '-A']);
      git(['commit', '-qm', 'init']);
      return { repoDir, baseTree: git(['rev-parse', 'HEAD^{tree}']) };
    },
    async afterGoalStep(trial, step, result) {
      note('afterGoalStep', trial, step.id);
      await new Promise((resolve) => setTimeout(resolve, CHECK_DELAY_MS));
      const source = readFileSync(join(trial.tmpDir, 'repo', 'src', 'add.js'), 'utf8');
      return { ...result, score: source.includes(`function ${step.feature}`) ? 1 : 0 };
    },
    async finalize(trial) {
      note('finalize', trial);
      const scoreStep: Record<string, number> = {};
      for (const step of trial.record.steps) {
        if (step.score !== undefined) scoreStep[step.id] = step.score;
      }
      const scores = Object.values(scoreStep);
      const answers = trial.record.steps.filter((step) => step.answerPass !== undefined);
      const scoreCode = scores.length === 0 ? 0 : scores.reduce((a, b) => a + b, 0) / scores.length;
      const scoreProbe =
        answers.length === 0
          ? 0
          : answers.filter((step) => step.answerPass).length / answers.length;
      // Like hooks.ts: the harness outcome (caps, overflow) is folded in here, in DESIGN 5.5 order.
      return {
        category: trial.harness?.category ?? (scoreCode === 1 ? 'passed' : 'checks_failed'),
        flags: [],
        scores: { scoreStep, scoreCode, scoreProbe, pass: scoreCode === 1 }
      };
    },
    async teardown(trial) {
      note('teardown', trial);
      if (!trial.keep) rmSync(trial.tmpDir, { recursive: true, force: true });
    }
  };
}

function options(
  runId: string,
  patch: Partial<RunOptions> & { caps?: Partial<RunConfig['caps']>; script?: string } = {}
): RunOptions {
  const config = loadRunConfig();
  config.parallel = 2;
  config.runsPerCell = 1;
  config.caps = { ...config.caps, ...patch.caps };
  const script = patch.script ?? 'mini-chain';
  const { caps: _caps, script: _script, ...rest } = patch;
  return {
    runId,
    config,
    configPath: 'test',
    models: [model],
    conditions: [A, B],
    scenarios: [scenario],
    provider: 'faux',
    authPath: DEFAULT_AUTH_PATH,
    modelsPath: null,
    resume: false,
    keep: false,
    resultsDir: join(tmp, 'results'),
    tmpRoot: join(tmp, 'tmp'),
    fauxScript: (): Promise<FauxScript> => loadFauxScript(join(scripts, `${script}.ts`)),
    settings: { retry: { maxRetries: 2, baseDelayMs: 10 } },
    stderr: false,
    ...rest
  };
}

test('step loop: four prompts, checks between goal steps, answers scored, files written', async () => {
  const calls: HookCall[] = [];
  const summary = await runBench(options('loop'), { hooks: fakeHooks(calls) });
  const { runDir, manifest, plan, trials } = summary;

  assert.deepEqual(
    plan.map((entry) => entry.status),
    ['done', 'done']
  );
  const promptId = manifest.promptIds.B;
  assert.match(promptId ?? '', /^[0-9a-f]{12}$/);
  assert.deepEqual(
    plan.map((entry) => entry.trialDir),
    [`trials/faux__A__mini-chain__r00`, `trials/faux__B@${promptId}__mini-chain__r00`]
  );
  assert.ok(existsSync(join(runDir, 'prompts', `${promptId}.md`)));
  assert.ok(existsSync(join(runDir, 'manifest.json')));
  assert.equal(
    manifest.piVersion,
    JSON.parse(
      readFileSync(join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8')
    ).version
  );
  assert.ok(manifest.endedAt);
  assert.match(manifest.episodes.B?.commit ?? '', /^[0-9a-f]{40}$/);
  assert.equal(manifest.env.PI_OFFLINE, '1');
  assert.ok(!process.env.PI_CODING_AGENT_DIR?.startsWith(join(tmp, 'tmp')), 'env restored');
  // The run's scratch dir `<tmp>/pi-bench/<run-id>` (HOME, agent dir, dry run, trials) is gone.
  assert.ok(!existsSync(join(tmp, 'tmp', 'pi-bench', 'loop')), 'scratch removed');
  assert.equal(manifest.settings.cacheWarming, 'off');

  assert.equal(trials.length, 2);
  for (const trial of trials) {
    assert.equal(trial.category, 'passed', trial.error);
    assert.deepEqual(
      trial.steps.map((step) => [step.id, step.end]),
      [
        ['goal-1', 'settled'],
        ['aside', 'settled'],
        ['goal-2', 'settled'],
        ['probe-1', 'settled']
      ]
    );
    const [goal1, aside, goal2, probe] = trial.steps as [
      StepResult,
      StepResult,
      StepResult,
      StepResult
    ];
    assert.equal(aside.answerPass, true);
    assert.equal(probe.answerPass, true);
    assert.equal(goal1.score, 1);
    assert.equal(goal2.score, 1);
    assert.deepEqual(trial.scores, {
      scoreStep: { 'goal-1': 1, 'goal-2': 1 },
      scoreCode: 1,
      scoreProbe: 1,
      pass: true
    });
    assert.match(trial.baseTree ?? '', /^[0-9a-f]{40}$/);

    // Checks run while the session idles: the goal step's duration stops before the check and
    // the next prompt starts after it.
    assert.ok(goal1.durationMs !== undefined && goal1.endedAt !== undefined);
    assert.ok(Date.parse(aside.startedAt) - Date.parse(goal1.endedAt) >= CHECK_DELAY_MS - 20);
    assert.ok(goal1.durationMs <= Date.parse(goal1.endedAt) - Date.parse(goal1.startedAt) + 20);
    const mine = calls.filter((call) => call.trial === trial.trialId);
    assert.deepEqual(
      mine.map((call) => call.hook),
      ['setup', 'afterGoalStep', 'afterGoalStep', 'finalize', 'teardown']
    );
    assert.deepEqual(
      mine.filter((call) => call.hook === 'afterGoalStep').map((call) => [call.step, call.steps]),
      [
        ['goal-1', 0],
        ['goal-2', 2]
      ]
    );
    const check1 = mine.find((call) => call.step === 'goal-1')!;
    assert.ok(
      check1.at >= Date.parse(goal1.endedAt) - 5 && check1.at <= Date.parse(aside.startedAt)
    );

    const dir = join(runDir, 'trials', trial.trialId);
    const files = readdirSync(dir);
    for (const name of ['trial.json', 'stdout.log', 'session.jsonl'])
      assert.ok(files.includes(name), name);
    const stored = JSON.parse(readFileSync(join(dir, 'trial.json'), 'utf8'));
    assert.equal(stored.category, 'passed');
    assert.equal(stored.audit.systemPromptHash.length, 64);
    const log = readFileSync(join(dir, 'stdout.log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { msg: string; step?: string });
    assert.deepEqual(
      log.filter((line) => line.msg === 'step start').map((line) => line.step),
      ['goal-1', 'aside', 'goal-2', 'probe-1']
    );
    assert.ok(
      readFileSync(join(dir, 'session.jsonl'), 'utf8').includes('"role":"system"'),
      'session copied'
    );
  }

  const [a, b] = trials;
  assert.equal(a?.audit?.promptId, undefined);
  assert.deepEqual(
    a?.audit?.extensionPaths.filter((path) => !path.startsWith('<')),
    []
  );
  assert.equal(b?.audit?.promptId, promptId);
  assert.deepEqual(
    b?.audit?.extensionPaths.filter((path) => !path.startsWith('<')),
    [B.extension]
  );
  assert.equal(
    a?.audit?.settings && JSON.stringify(a.audit.settings),
    JSON.stringify(b?.audit?.settings)
  );
  assert.equal(b?.steps[0]?.toolCalls.fold, 1);
  assert.equal(b?.steps[2]?.toolCalls.recall, 2);
  assert.equal(a?.steps[0]?.toolCalls.fold, undefined);
  assert.equal(a?.audit?.systemPromptHash.length, 64);
  assert.notEqual(a?.audit?.systemPromptHash, b?.audit?.systemPromptHash);
});

test('caps: a stalled step is a timeout at a 1-second cap; twenty turns against a cap of 5 is turn_cap', async () => {
  const stalled = await runBench(
    options('stall', { conditions: [A], script: 'stall', caps: { goalStepMinutes: 1 / 60 } }),
    { hooks: fakeHooks([]) }
  );
  const [stall] = stalled.trials;
  assert.equal(stall?.category, 'timeout');
  assert.equal(stall?.harness?.category, 'timeout');
  assert.deepEqual(
    stall?.steps.map((step) => step.end),
    ['timeout', 'skipped', 'skipped', 'skipped']
  );
  assert.ok(
    (stall?.steps[0]?.durationMs ?? 0) >= 1000 && (stall?.steps[0]?.durationMs ?? 0) < 10_000
  );
  assert.equal(stalled.plan[0]?.status, 'done');

  const capped = await runBench(
    options('turns', { conditions: [A], script: 'many-turns', caps: { goalStepTurns: 5 } }),
    { hooks: fakeHooks([]) }
  );
  const [turns] = capped.trials;
  assert.equal(turns?.category, 'turn_cap');
  assert.equal(turns?.steps[0]?.end, 'turn_cap');
  assert.equal(turns?.steps[0]?.requests, 5);
  assert.deepEqual(
    turns?.steps.slice(1).map((step) => step.end),
    ['skipped', 'skipped', 'skipped']
  );
});

test('infra: three 429 responses make the trial infra, one rerun is scheduled, two per cell at most', async () => {
  const calls: HookCall[] = [];
  const summary = await runBench(options('throttle', { conditions: [A], script: 'throttle' }), {
    hooks: fakeHooks(calls)
  });
  assert.deepEqual(
    summary.plan.map((entry) => [entry.runIndex, entry.status, entry.rerunOf]),
    [
      [0, 'infra', undefined],
      [1, 'infra', 'trials/faux__A__mini-chain__r00'],
      [2, 'infra', 'trials/faux__A__mini-chain__r01']
    ]
  );
  assert.equal(summary.trials.length, 3);
  for (const trial of summary.trials) {
    assert.equal(trial.category, 'infra');
    assert.match(trial.error ?? '', /429/);
    assert.equal(trial.steps[0]?.end, 'error');
    assert.equal(trial.steps[0]?.retries, 2);
    assert.deepEqual(
      trial.steps.slice(1).map((step) => step.end),
      ['skipped', 'skipped', 'skipped']
    );
    assert.ok(
      existsSync(join(summary.runDir, 'trials', trial.trialId, 'trial.json')),
      'infra trial keeps its dir'
    );
  }
  assert.equal(calls.filter((call) => call.hook === 'teardown').length, 3);
  assert.deepEqual(loadPlan(summary.runDir), summary.plan);
  // Three in a row is under the circuit breaker; the exhausted cell still makes the exit code 1.
  assert.equal(summary.stoppedReason, undefined);
  const lines: string[] = [];
  assert.equal(
    reportExit(summary, (text) => lines.push(text)),
    1
  );
  assert.match(lines.join(''), /3 infra, 0 pending/);
  assert.match(lines.join(''), /insufficient: faux A mini-chain r2 .* no reruns left/);
});

test('circuit breaker: four infra trials in a row stop the run with pending entries left for --resume', async () => {
  // One worker, so the fourth infra trial is B's first rerun and nothing else has started.
  const summary = await runBench(
    options('breaker', {
      script: 'throttle',
      config: { ...loadRunConfig(), runsPerCell: 1, parallel: 1 }
    }),
    { hooks: fakeHooks([]) }
  );
  assert.equal(CONSECUTIVE_INFRA_STOP, 4);
  assert.match(summary.stoppedReason ?? '', /4 infra trials in a row .*--resume breaker/);
  const statuses = summary.plan.map((entry) => entry.status);
  assert.equal(statuses.filter((status) => status === 'infra').length, 4);
  assert.equal(statuses.filter((status) => status === 'pending').length, 2);
  const lines: string[] = [];
  assert.equal(
    reportExit(summary, (text) => lines.push(text)),
    1
  );
  assert.match(lines[0] ?? '', /2 pending \(stopped: 4 infra trials in a row/);
  const log = readFileSync(join(summary.runDir, 'run.log'), 'utf8');
  assert.match(log, /"msg":"stopping the run"/);
});

test('a non-throttled provider error is not infra: the step settles and the checks decide', async () => {
  const summary = await runBench(
    options('bad-request', { conditions: [A], script: 'bad-request' }),
    { hooks: fakeHooks([]) }
  );
  const [trial] = summary.trials;
  assert.notEqual(trial?.category, 'infra');
  assert.equal(trial?.steps[0]?.end, 'settled');
  assert.deepEqual(trial?.steps[0]?.errors, [
    'HTTP 400 Bad Request: invalid transcript at line 512'
  ]);
  assert.equal(summary.plan.length, 1);
  assert.equal(summary.plan[0]?.status, 'done');
  const log = readFileSync(join(summary.runDir, 'trials', trial!.trialId, 'stdout.log'), 'utf8');
  assert.match(log, /"msg":"provider error".*"throttled":false.*HTTP 400/);
});

test('interruptRun marks running entries interrupted and saves the plan; --resume restarts them', async () => {
  const runDir = join(tmp, 'results', 'interrupt');
  mkdirSync(runDir, { recursive: true });
  const plan: PlanEntry[] = [
    { model: 'm', condition: 'A', chain: 'c', runIndex: 0, status: 'done', trialDir: 'trials/a' },
    {
      model: 'm',
      condition: 'A',
      chain: 'c',
      runIndex: 1,
      status: 'running',
      trialDir: 'trials/b'
    },
    { model: 'm', condition: 'A', chain: 'c', runIndex: 2, status: 'pending', trialDir: 'trials/c' }
  ];
  const shared = {
    runDir,
    plan,
    sessions: new Set(),
    log: new Logger({ stderr: false })
  } as unknown as SharedRun;
  interruptRun(shared, 'SIGINT');
  assert.deepEqual(
    loadPlan(runDir).map((entry) => entry.status),
    ['done', 'interrupted', 'pending']
  );
  const reloaded = loadPlan(runDir);
  assert.deepEqual(
    resetInterrupted(reloaded).map((entry) => entry.trialDir),
    ['trials/b']
  );
  assert.deepEqual(
    reloaded.map((entry) => entry.status),
    ['done', 'pending', 'pending']
  );
});

test('resume: a plan interrupted after trial 2 of 4 resumes with trials 3 and 4 only', async () => {
  const first = await runBench(
    options('resume', { config: { ...loadRunConfig(), runsPerCell: 2, parallel: 1 } }),
    {
      hooks: fakeHooks([])
    }
  );
  assert.equal(first.plan.length, 4);
  const runDir = first.runDir;
  const plan = loadPlan(runDir);
  const before = plan
    .slice(0, 2)
    .map((entry) => readFileSync(join(runDir, entry.trialDir, 'trial.json'), 'utf8'));
  // As left by a crash: trial 3 was running when the process died, trial 4 never started.
  plan[2]!.status = 'running';
  plan[3]!.status = 'pending';
  savePlan(runDir, plan);
  rmSync(join(runDir, plan[3]!.trialDir), { recursive: true, force: true });
  writeFileSync(join(runDir, plan[2]!.trialDir, 'trial.json'), '{"partial":true}');

  const calls: HookCall[] = [];
  const resumed = await runBench(options('resume', { resume: true }), { hooks: fakeHooks(calls) });
  assert.deepEqual(
    calls.filter((call) => call.hook === 'setup').map((call) => call.trial),
    [plan[2]!.trialDir, plan[3]!.trialDir].map((dir) => dir.slice('trials/'.length))
  );
  assert.deepEqual(
    resumed.plan.map((entry) => entry.status),
    ['done', 'done', 'done', 'done']
  );
  assert.deepEqual(
    plan
      .slice(0, 2)
      .map((entry) => readFileSync(join(runDir, entry.trialDir, 'trial.json'), 'utf8')),
    before
  );
  const third = JSON.parse(readFileSync(join(runDir, plan[2]!.trialDir, 'trial.json'), 'utf8'));
  assert.equal(third.category, 'passed');
  assert.equal(resumed.manifest.resumedAt?.length, 1);
  assert.equal(resumed.manifest.promptIds.B, first.manifest.promptIds.B);
  await assert.rejects(
    runBench(options('resume'), { hooks: fakeHooks([]) }),
    /exists; pick another --run-id or use --resume/
  );
});

test('helpers: run ids, fixed answers and the DESIGN 5.5 category order', () => {
  assert.match(defaultRunId(new Date('2026-10-14T12:34:56.789Z')), /^20261014-123456$/);
  const step: Step = {
    id: 'p',
    kind: 'probe',
    prompt: 'x',
    text: 'x',
    answer: { kind: 'fixed', pattern: 'src/add\\.js' }
  };
  const base: StepResult = {
    id: 'p',
    kind: 'probe',
    startedAt: '',
    end: 'settled',
    requests: 1,
    toolCalls: {},
    compactions: 0,
    retries: 0,
    errors: []
  };
  const hit = { ...base, answer: 'in src/add.js' };
  scoreFixedAnswer(step, hit);
  assert.equal(hit.answerPass, true);
  const miss = { ...base, answer: 'nowhere' };
  scoreFixedAnswer(step, miss);
  assert.equal(miss.answerPass, false);
  const judged = { ...base, answer: 'x' };
  scoreFixedAnswer({ ...step, answer: { kind: 'abstain' } }, judged);
  assert.equal(judged.answerPass, undefined);
});

test('--resume takes the manifest as config and rejects every other option but --parallel, --keep, --provider', async () => {
  const first = await runBench(options('resume-opts'), { hooks: fakeHooks([]) });
  assert.equal(first.plan.length, 2);
  const resultsDir = join(tmp, 'results');
  const parse = (argv: string[]) => optionsFromArgs(parseArgs(argv, ['keep']), resultsDir);
  assert.throws(
    () => parse(['--resume', 'resume-opts', '--runs', '3']),
    /--resume takes the run's manifest as config; drop --runs/
  );
  assert.throws(
    () => parse(['--resume', 'resume-opts', '--models', 'faux', '--config', 'x']),
    /drop --config, --models/
  );
  const resumed = parse(['--resume', 'resume-opts', '--parallel', '1', '--keep']);
  assert.equal(resumed.resume, true);
  assert.equal(resumed.keep, true);
  assert.equal(resumed.config.parallel, 1);
  assert.equal(resumed.config.runsPerCell, 1);
  assert.equal(resumed.provider, 'faux');
  assert.deepEqual(resumed.models, [model]);
  const plain = parse(['--resume', 'resume-opts']);
  assert.equal(plain.config.parallel, 2);
  assert.equal(plain.keep, false);
});

test('the manifest records models.pi.json by path and content hash; --resume refuses a changed file', async () => {
  const modelsPath = join(tmp, 'models.pi.json');
  const content = JSON.stringify({ providers: {} });
  writeFileSync(modelsPath, content);
  const first = await runBench(options('pi-models', { conditions: [A], modelsPath }), {
    hooks: fakeHooks([])
  });
  assert.deepEqual(first.manifest.piModels, { path: modelsPath, sha256: sha256(content) });
  writeFileSync(modelsPath, JSON.stringify({ providers: { changed: { baseUrl: 'http://x' } } }));
  await assert.rejects(
    runBench(options('pi-models', { conditions: [A], modelsPath, resume: true }), {
      hooks: fakeHooks([])
    }),
    new RegExp(`${modelsPath}: content [0-9a-f]{64} differs from the run's ${sha256(content)}`)
  );
  await assert.rejects(
    runBench(options('pi-models', { conditions: [A], modelsPath: null, resume: true }), {
      hooks: fakeHooks([])
    }),
    /content absent differs from the run's/
  );
});
