import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { basename, join } from 'node:path';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { ArgsError, parseArgs } from '../args.js';
import {
  BENCH_DIR,
  DEFAULT_AUTH_PATH,
  DEFAULT_MODELS_CONFIG,
  DEFAULT_PI_MODELS_PATH,
  DEFAULT_RUN_CONFIG,
  FAUX_MODELS_CONFIG,
  loadModels,
  loadRunConfig,
  RESULTS_DIR,
  resolvePiModelsPath
} from '../config.js';
import { type FauxScript, loadFauxScript } from '../faux.js';
import { ConfigError, readJsonFile, readObject, requireIdentifier } from '../fields.js';
import { createHooks } from '../hooks.js';
import { EPISODE_TOOLS, isThrottledText, sha256 } from '../jsonl.js';
import { Logger } from '../log.js';
import { writeMetricsJson } from '../metrics.js';
import {
  describeEntry,
  expandPlan,
  infraExhausted,
  loadPlan,
  markInterrupted,
  nextPending,
  planSummary,
  resetInterrupted,
  savePlan,
  scheduleInfraRerun
} from '../plan.js';
import { killRunningProcesses } from '../repo.js';
import { loadScenario, resolveScenarioDir } from '../scenario.js';
import {
  applyIsolatedEnv,
  buildSettings,
  closeTrialSession,
  completeAudit,
  createIsolatedDirs,
  createTrialSession,
  driveStep,
  dryRunPromptId,
  type IsolatedDirs,
  loadedExtensionPaths,
  mergeSettings,
  PI_VERSION,
  preflightModels,
  writeSettings
} from '../session.js';
import type {
  ConditionSpec,
  HarnessOutcome,
  Hooks,
  ModelSpec,
  PiSettings,
  PlanEntry,
  ProviderKind,
  RunConfig,
  Scenario,
  Step,
  StepCaps,
  StepResult,
  TrialContext,
  TrialFinal,
  TrialJson,
  TrialRecord
} from '../types.js';

const FLAGS = ['keep'] as const;
const OPTIONS = [
  'config',
  'models',
  'scenarios',
  'runs',
  'parallel',
  'conditions',
  'run-id',
  'resume',
  'keep',
  'provider'
] as const;
/** With `--resume` the manifest is the config; only these may be given alongside. */
const RESUME_OPTIONS = ['resume', 'parallel', 'keep', 'provider'] as const;
const SCRIPTS_DIR = join(BENCH_DIR, 'test/scripts');
/** DESIGN 5.6: this many throttled responses in one trial make it `infra`. */
const THROTTLE_INFRA_COUNT = 3;
/** This many `infra` trials in a row mean the environment is broken, not the provider; the run stops. */
export const CONSECUTIVE_INFRA_STOP = 4;
/** Exit status of a run stopped by SIGINT or SIGTERM. */
const SIGNAL_EXIT_CODE = 130;

export interface RunOptions {
  runId: string;
  config: RunConfig;
  configPath: string;
  models: ModelSpec[];
  conditions: ConditionSpec[];
  scenarios: Scenario[];
  provider: ProviderKind;
  authPath: string;
  /** pi `models.json` with custom endpoints, or `null`; see `resolvePiModelsPath`. */
  modelsPath: string | null;
  resume: boolean;
  keep: boolean;
  /** Default `bench/results`. */
  resultsDir?: string;
  /** Default the system temp dir; the run works under `<tmpRoot>/pi-bench/<run-id>/`. */
  tmpRoot?: string;
  /** Faux script per chain; default `bench/test/scripts/<chain>.ts`. */
  fauxScript?: (chain: string) => Promise<FauxScript>;
  /** Extra settings merged into every trial's settings (tests use it for short retries). */
  settings?: Partial<PiSettings>;
  /** Terse stderr output; the per-trial `stdout.log` is always complete. Default true. */
  stderr?: boolean;
}

export interface RunDeps {
  hooks: Hooks;
}

export interface Manifest {
  runId: string;
  startedAt: string;
  endedAt?: string;
  resumedAt?: string[];
  configPath: string;
  config: RunConfig;
  provider: ProviderKind;
  models: Array<ModelSpec & { declared?: { contextWindow: number; maxTokens: number } }>;
  /** The `models.pi.json` real-provider sessions loaded, with the sha256 of its content; `null` when there was none. */
  piModels: { path: string; sha256: string } | null;
  conditions: ConditionSpec[];
  scenarios: Array<{ id: string; dir: string; baseCommit?: string }>;
  /** Condition id to prompt id, for conditions with an extension. */
  promptIds: Record<string, string>;
  piVersion: string;
  nodeVersion: string;
  episodes: Record<string, { commit?: string; dirty?: boolean }>;
  settings: PiSettings;
  env: Record<string, string>;
  machine: {
    platform: string;
    release: string;
    arch: string;
    cpus: number;
    cpuModel: string;
    memoryGb: number;
  };
}

export interface RunSummary {
  runDir: string;
  manifest: Manifest;
  plan: PlanEntry[];
  trials: TrialJson[];
  /** Set when the run stopped itself before the plan was exhausted (consecutive infra trials). */
  stoppedReason?: string;
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv, FLAGS);
  args.assertKnown(OPTIONS);
  const hooks = createHooks();
  const options = optionsFromArgs(args);
  const summary = await runBench(options, { hooks });
  return reportExit(summary, (text) => process.stdout.write(text));
}

/** One summary line and the exit code: 1 when trials are left pending or a cell ran out of reruns. */
export function reportExit(summary: RunSummary, write: (text: string) => void): number {
  const counts = planSummary(summary.plan);
  const exhausted = infraExhausted(summary.plan);
  write(
    `${summary.runDir}: ${counts.done} done, ${counts.infra} infra, ${counts.pending} pending${summary.stoppedReason === undefined ? '' : ` (stopped: ${summary.stoppedReason})`}\n`
  );
  for (const entry of exhausted) {
    write(`insufficient: ${describeEntry(entry)} is infra and its cell has no reruns left\n`);
  }
  return counts.pending === 0 && exhausted.length === 0 ? 0 : 1;
}

function parallelFromArgs(args: ReturnType<typeof parseArgs>): number | undefined {
  const parallel = args.number('parallel');
  if (parallel !== undefined && (!Number.isInteger(parallel) || parallel < 1)) {
    throw new ConfigError('--parallel must be a positive integer');
  }
  return parallel;
}

export function optionsFromArgs(
  args: ReturnType<typeof parseArgs>,
  resultsDir: string = RESULTS_DIR
): RunOptions {
  const provider = args.string('provider') ?? 'real';
  if (provider !== 'real' && provider !== 'faux') {
    throw new ConfigError(`--provider must be real or faux, got ${provider}`);
  }
  const keep = args.flag('keep');
  const resumeId = args.string('resume');
  if (resumeId !== undefined) {
    const rejected = OPTIONS.filter(
      (name) => args.has(name) && !(RESUME_OPTIONS as readonly string[]).includes(name)
    );
    if (rejected.length > 0) {
      throw new ArgsError(
        `--resume takes the run's manifest as config; drop ${rejected.map((name) => `--${name}`).join(', ')} (only --parallel, --keep and --provider apply)`
      );
    }
    const runDir = join(resultsDir, requireIdentifier(resumeId, '--resume'));
    const manifest = readManifest(runDir);
    const parallel = parallelFromArgs(args);
    return {
      runId: resumeId,
      config: parallel === undefined ? manifest.config : { ...manifest.config, parallel },
      configPath: manifest.configPath,
      models: manifest.models.map(({ label, model, thinking }) => ({ label, model, thinking })),
      conditions: manifest.conditions,
      scenarios: manifest.scenarios.map((scenario) => loadScenario(scenario.dir)),
      provider: args.has('provider') ? provider : manifest.provider,
      authPath: DEFAULT_AUTH_PATH,
      modelsPath: resolvePiModelsPath(),
      resume: true,
      keep,
      resultsDir
    };
  }

  const configPath = args.string('config') ?? DEFAULT_RUN_CONFIG;
  const config = loadRunConfig(configPath);
  const runs = args.number('runs');
  if (runs !== undefined) {
    if (!Number.isInteger(runs) || runs < 1)
      throw new ConfigError('--runs must be a positive integer');
    config.runsPerCell = runs;
  }
  const parallel = parallelFromArgs(args);
  if (parallel !== undefined) config.parallel = parallel;

  const allModels = loadModels(provider === 'faux' ? FAUX_MODELS_CONFIG : DEFAULT_MODELS_CONFIG);
  const models = pick(allModels, args.list('models'), (model) => model.label, '--models');
  const conditions = pick(
    config.conditions,
    args.list('conditions'),
    (condition) => condition.id,
    '--conditions'
  );
  const scenarioIds = args.list('scenarios') ?? config.scenarios;
  const scenarios = scenarioIds.map((id) => loadScenario(resolveScenarioDir(id)));

  return {
    runId: requireIdentifier(args.string('run-id') ?? defaultRunId(), '--run-id'),
    config,
    configPath,
    models,
    conditions,
    scenarios,
    provider,
    authPath: DEFAULT_AUTH_PATH,
    modelsPath: resolvePiModelsPath(),
    resume: false,
    keep
  };
}

/** `manifest.piModels`: the file and its content hash, so the endpoints of a run are known and a resume refuses a changed file. */
function piModelsRecord(modelsPath: string | null): Manifest['piModels'] {
  if (modelsPath === null) return null;
  return { path: modelsPath, sha256: sha256(readFileSync(modelsPath, 'utf8')) };
}

function pick<T>(
  all: T[],
  wanted: string[] | undefined,
  key: (item: T) => string,
  flag: string
): T[] {
  if (wanted === undefined) return all;
  return wanted.map((id) => {
    const item = all.find((candidate) => key(candidate) === id);
    if (item === undefined) {
      throw new ConfigError(
        `${flag}: unknown ${JSON.stringify(id)}; have ${all.map(key).join(', ')}`
      );
    }
    return item;
  });
}

export function defaultRunId(now = new Date()): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
    .replace('T', '-');
}

function readManifest(runDir: string): Manifest {
  const path = join(runDir, 'manifest.json');
  if (!existsSync(path)) throw new ConfigError(`${path}: not found; nothing to resume`);
  return readObject(readJsonFile(path), path) as unknown as Manifest;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Resolved condition id for trial names: `A`, or `B@<prompt-id>` when the condition has an extension. */
export function conditionKey(condition: ConditionSpec, promptIds: Record<string, string>): string {
  if (condition.extension === undefined) return condition.id;
  const promptId = promptIds[condition.id];
  if (promptId === undefined) throw new ConfigError(`no prompt id for condition ${condition.id}`);
  return `${condition.id}@${promptId}`;
}

/**
 * The whole run: results dir, isolated environment, preflight, prompt-id dry runs, plan,
 * worker pool, manifest. Trials are driven by `runTrial`; `repo`, `checks` and `metrics` are
 * reached only through `deps.hooks` (the signal handler's process reaper is the one exception).
 */
export async function runBench(options: RunOptions, deps: RunDeps): Promise<RunSummary> {
  const resultsDir = options.resultsDir ?? RESULTS_DIR;
  const runDir = join(resultsDir, options.runId);
  const tmpRoot = options.tmpRoot ?? tmpdir();
  if (!options.resume && existsSync(runDir)) {
    throw new ConfigError(
      `${runDir} exists; pick another --run-id or use --resume ${options.runId}`
    );
  }
  mkdirSync(join(runDir, 'trials'), { recursive: true });
  mkdirSync(join(runDir, 'prompts'), { recursive: true });
  const log = new Logger({ file: join(runDir, 'run.log'), stderr: options.stderr ?? true });

  // One isolated HOME and agent dir per run: pi's bash tool copies process.env at spawn time,
  // so with parallel trials in one process the environment cannot differ per trial. The
  // settings file is the same for every trial anyway (DESIGN 6). Everything scratch lives
  // under `<tmpRoot>/pi-bench/<run-id>/`, so two runs never share a trial dir and a crash
  // leaves one directory to remove.
  const runTmp = join(tmpRoot, 'pi-bench', options.runId);
  mkdirSync(runTmp, { recursive: true });
  const dirs = createIsolatedDirs(runTmp);
  const settings = buildSettings(options.config, options.settings);
  writeSettings(dirs, settings);
  const restoreEnv = applyIsolatedEnv(dirs);
  const cleanupTmp = () => {
    if (!options.keep) rmSync(runTmp, { recursive: true, force: true });
  };

  const onUnhandledRejection = (reason: unknown) => {
    log.error('unhandled rejection', { error: describeError(reason) });
  };
  // A 75-hour `nohup` run must not lose the reason it died: both go to run.log first. A
  // rejection nobody awaited is logged and the run goes on; an uncaught exception still ends
  // the process, with the plan saved so `--resume` restarts the interrupted trials.
  let shared: SharedRun | undefined;
  const onUncaughtException = (error: unknown) => {
    log.error('uncaught exception', {
      error: describeError(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    if (shared !== undefined) interruptRun(shared, 'uncaughtException');
    process.exit(1);
  };
  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtException', onUncaughtException);

  const onSignal = (signal: NodeJS.Signals) => {
    log.warn('signal received; stopping', { signal });
    if (shared !== undefined) interruptRun(shared, signal);
    restoreEnv();
    cleanupTmp();
    process.exit(SIGNAL_EXIT_CODE);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    // Preflight (DESIGN 5.1): a missing key or checkout fails here, not as a chain of infra
    // trials after a full repo setup each; the template `npm ci` runs before the first trial.
    if (options.provider === 'real') {
      await preflightModels(options.models, options.authPath, options.modelsPath);
    }
    await deps.hooks.prepare?.(options.scenarios, log);

    const promptIds: Record<string, string> = {};
    const firstModel = options.models[0];
    if (firstModel === undefined) throw new ConfigError('no models to run');
    for (const condition of options.conditions) {
      if (condition.extension === undefined) continue;
      const dry = await dryRunPromptId(condition, firstModel, dirs, settings, options.authPath);
      promptIds[condition.id] = dry.promptId;
      log.info('prompt id', { condition: condition.id, promptId: dry.promptId });
      const promptFile = join(runDir, 'prompts', `${dry.promptId}.md`);
      if (!existsSync(promptFile)) {
        writeFileSync(
          promptFile,
          [
            `# Prompt ${dry.promptId}`,
            '',
            `Condition \`${condition.id}\`, extension \`${condition.extension}\`.`,
            'Hashed material: the `<episodes>` section and the fold, recall, ask and fork descriptions.',
            '',
            '## Tool descriptions',
            '',
            ...dry.toolDescriptions.map(
              (description, index) => `- ${EPISODE_TOOLS[index]}: ${description}`
            ),
            '',
            '## System prompt as rendered in the dry run',
            '',
            '```',
            dry.systemPrompt,
            '```',
            ''
          ].join('\n')
        );
      }
    }

    const piModels = piModelsRecord(options.modelsPath);
    let manifest: Manifest;
    let plan: PlanEntry[];
    if (options.resume) {
      manifest = readManifest(runDir);
      for (const [id, promptId] of Object.entries(promptIds)) {
        if (manifest.promptIds[id] !== promptId) {
          throw new ConfigError(
            `condition ${id}: prompt id ${promptId} differs from the run's ${manifest.promptIds[id]}; the extension changed`
          );
        }
      }
      // Same guard as the prompt id: a resumed trial must hit the endpoints the run started with.
      if (JSON.stringify(manifest.piModels ?? null) !== JSON.stringify(piModels)) {
        throw new ConfigError(
          `${piModels?.path ?? manifest.piModels?.path ?? DEFAULT_PI_MODELS_PATH}: content ${piModels?.sha256 ?? 'absent'} differs from the run's ${manifest.piModels?.sha256 ?? 'absent'}; the custom endpoints changed`
        );
      }
      manifest.resumedAt = [...(manifest.resumedAt ?? []), new Date().toISOString()];
      plan = loadPlan(runDir);
      for (const entry of resetInterrupted(plan)) {
        rmSync(join(runDir, entry.trialDir), { recursive: true, force: true });
        log.warn('restarting interrupted trial', { trial: basename(entry.trialDir) });
      }
    } else {
      manifest = {
        runId: options.runId,
        startedAt: new Date().toISOString(),
        configPath: options.configPath,
        config: options.config,
        provider: options.provider,
        models: options.models.map((model) => ({ ...model })),
        piModels,
        conditions: options.conditions,
        scenarios: options.scenarios.map((scenario) => ({
          id: scenario.id,
          dir: scenario.dir,
          ...(scenario.repo.baseCommit === undefined
            ? {}
            : { baseCommit: scenario.repo.baseCommit })
        })),
        promptIds,
        piVersion: PI_VERSION,
        nodeVersion: process.version,
        episodes: {},
        settings,
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => key.startsWith('PI_') || key.startsWith('npm_config_') || key === 'HOME'
          )
        ) as Record<string, string>,
        machine: {
          platform: platform(),
          release: release(),
          arch: arch(),
          cpus: cpus().length,
          cpuModel: cpus()[0]?.model ?? 'unknown',
          memoryGb: Math.round(totalmem() / 1024 ** 3)
        }
      };
      plan = expandPlan(
        options.models,
        options.conditions.map((condition) => conditionKey(condition, promptIds)),
        options.scenarios.map((scenario) => scenario.id),
        options.config.runsPerCell
      );
    }
    writeJson(join(runDir, 'manifest.json'), manifest);
    savePlan(runDir, plan);
    log.info('plan', { ...planSummary(plan), parallel: options.config.parallel });

    const state: SharedRun = {
      options,
      deps,
      runDir,
      runTmp,
      tmpRoot,
      dirs,
      settings,
      promptIds,
      manifest,
      plan,
      log,
      sessions: new Set(),
      consecutiveInfra: 0
    };
    shared = state;
    const trials: TrialJson[] = [];
    const worker = async () => {
      while (state.stoppedReason === undefined) {
        const entry = nextPending(plan);
        if (entry === undefined) return;
        // One trial's failure outside `runTrial`'s own try (a plan mismatch, a full disk while
        // copying the session) must not take the other worker's trial down with it.
        try {
          savePlan(runDir, plan);
          log.info('trial start', { trial: describeEntry(entry) });
          const trial = await runTrial(entry, state);
          trials.push(trial);
          entry.status = trial.category === 'infra' ? 'infra' : 'done';
          if (entry.status === 'infra') {
            noteInfra(state, entry, trial.error);
          } else {
            state.consecutiveInfra = 0;
            log.info('trial done', { trial: basename(entry.trialDir), category: trial.category });
          }
        } catch (error) {
          entry.status = 'infra';
          log.error('trial crashed outside the trial loop', {
            trial: basename(entry.trialDir),
            error: describeError(error),
            stack: error instanceof Error ? error.stack : undefined
          });
          noteInfra(state, entry, describeError(error));
        }
        try {
          savePlan(runDir, plan);
        } catch (error) {
          log.error('plan.json could not be written', { error: describeError(error) });
        }
      }
    };
    await Promise.allSettled(Array.from({ length: options.config.parallel }, worker));

    for (const trial of trials) {
      if (trial.audit?.episodesCommit === undefined) continue;
      manifest.episodes[trial.condition.split('@')[0]!] = {
        commit: trial.audit.episodesCommit,
        ...(trial.audit.episodesDirty === undefined ? {} : { dirty: trial.audit.episodesDirty })
      };
    }
    manifest.endedAt = new Date().toISOString();
    writeJson(join(runDir, 'manifest.json'), manifest);
    const summary: RunSummary = { runDir, manifest, plan, trials };
    if (state.stoppedReason !== undefined) summary.stoppedReason = state.stoppedReason;
    return summary;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('unhandledRejection', onUnhandledRejection);
    process.off('uncaughtException', onUncaughtException);
    restoreEnv();
    cleanupTmp();
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Books an infra trial: schedules its rerun and trips the circuit breaker after a streak. */
function noteInfra(shared: SharedRun, entry: PlanEntry, error: string | undefined): void {
  const rerun = scheduleInfraRerun(shared.plan, entry);
  shared.log.warn('trial infra', {
    trial: basename(entry.trialDir),
    error,
    rerun: rerun === undefined ? 'cell exhausted its reruns' : basename(rerun.trialDir)
  });
  shared.consecutiveInfra++;
  if (shared.consecutiveInfra >= CONSECUTIVE_INFRA_STOP && shared.stoppedReason === undefined) {
    shared.stoppedReason = `${shared.consecutiveInfra} infra trials in a row (last: ${error ?? 'unknown'}); the environment, not the provider, is likely broken. Fix it and \`bench run --resume ${shared.options.runId}\``;
    shared.log.error('stopping the run', { reason: shared.stoppedReason });
  }
}

/**
 * SIGINT or SIGTERM: child process groups are killed, live sessions aborted, `running` plan
 * entries saved as `interrupted` so `--resume` restarts them. The caller exits right after.
 */
export function interruptRun(shared: SharedRun, signal: string): void {
  const killed = killRunningProcesses();
  for (const session of shared.sessions) {
    session.abort().catch(() => {});
  }
  const marked = markInterrupted(shared.plan);
  try {
    savePlan(shared.runDir, shared.plan);
  } catch (error) {
    shared.log.error('plan.json could not be written', { error: describeError(error) });
  }
  shared.log.warn('run interrupted', {
    signal,
    killedProcesses: killed,
    abortedSessions: shared.sessions.size,
    interrupted: marked.map((entry) => basename(entry.trialDir))
  });
}

export interface SharedRun {
  options: RunOptions;
  deps: RunDeps;
  runDir: string;
  /** `<tmpRoot>/pi-bench/<run-id>`: HOME, agent dir and every trial's scratch dir. */
  runTmp: string;
  tmpRoot: string;
  dirs: IsolatedDirs;
  settings: PiSettings;
  promptIds: Record<string, string>;
  manifest: Manifest;
  plan: PlanEntry[];
  log: Logger;
  /** Sessions currently driving a trial, for the signal handler. */
  sessions: Set<AgentSession>;
  consecutiveInfra: number;
  /** Set once the circuit breaker tripped; workers take no more entries. */
  stoppedReason?: string;
}

function stepCaps(step: Step, config: RunConfig, deadline: number): StepCaps {
  const minutes = step.kind === 'goal' ? config.caps.goalStepMinutes : config.caps.otherStepMinutes;
  const wallMs = Math.max(1, Math.min(minutes * 60_000, deadline - Date.now()));
  return step.kind === 'goal' ? { wallMs, turns: config.caps.goalStepTurns } : { wallMs };
}

function skipped(step: Step): StepResult {
  const now = new Date().toISOString();
  return {
    id: step.id,
    kind: step.kind,
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    end: 'skipped',
    requests: 0,
    toolCalls: {},
    compactions: 0,
    retries: 0,
    errors: []
  };
}

/** Pattern answers are scored here; `diff`, `abstain` and `judge` answers wait for checks and the judge. */
export function scoreFixedAnswer(step: Step, result: StepResult): void {
  if (step.answer?.kind !== 'fixed' || result.answer === undefined) return;
  result.answerPass = new RegExp(step.answer.pattern).test(result.answer);
}

class InfraError extends Error {}

/** DESIGN 2 and 5.1 step 5: the prompt the model saw must be the one the run expects. */
function auditProblem(
  session: Awaited<ReturnType<typeof createTrialSession>>,
  condition: ConditionSpec,
  promptIds: Record<string, string>
): string | undefined {
  const problem = completeAudit(session.session, session.audit);
  if (problem !== undefined) return `audit: ${problem}`;
  const expected = promptIds[condition.id];
  if (expected !== undefined && session.audit.promptId !== expected) {
    return `prompt id ${session.audit.promptId ?? 'none'} differs from the run's ${expected}`;
  }
  if (expected === undefined && session.audit.promptId !== undefined) {
    return `condition ${condition.id} loaded an episodes section`;
  }
  return undefined;
}

/** One trial: setup, session, step loop with checks between goal steps, finalize, teardown, `trial.json`. */
export async function runTrial(entry: PlanEntry, shared: SharedRun): Promise<TrialJson> {
  const { options, deps, runDir } = shared;
  const trialId = basename(entry.trialDir);
  const trialDir = join(runDir, entry.trialDir);
  rmSync(trialDir, { recursive: true, force: true });
  mkdirSync(trialDir, { recursive: true });
  const log = new Logger({
    file: join(trialDir, 'stdout.log'),
    context: { trial: trialId },
    stderr: options.stderr ?? true
  });

  const conditionId = entry.condition.split('@')[0]!;
  const condition = options.conditions.find((candidate) => candidate.id === conditionId);
  const model = options.models.find((candidate) => candidate.label === entry.model);
  const scenario = options.scenarios.find((candidate) => candidate.id === entry.chain);
  if (condition === undefined || model === undefined || scenario === undefined) {
    throw new ConfigError(`plan entry ${trialId} names an unknown model, condition or scenario`);
  }

  const record: TrialRecord = {
    model: entry.model,
    condition: entry.condition,
    chain: entry.chain,
    runIndex: entry.runIndex,
    runId: options.runId,
    trialId,
    ...(entry.rerunOf === undefined ? {} : { rerunOf: entry.rerunOf }),
    startedAt: new Date().toISOString(),
    steps: [],
    flags: []
  };
  const harness: HarnessOutcome = {};
  const trial: TrialContext = {
    record,
    scenario,
    model,
    condition,
    config: options.config,
    runDir,
    trialDir,
    tmpDir: join(shared.runTmp, trialId),
    tmpRoot: shared.tmpRoot,
    keep: options.keep,
    harness,
    log
  };
  const json: TrialJson = record;
  const writeTrial = () => writeJson(join(trialDir, 'trial.json'), json);
  writeTrial();

  let final: TrialFinal | undefined;
  let session: Awaited<ReturnType<typeof createTrialSession>> | undefined;
  let setupDone = false;
  const deadline = Date.now() + options.config.caps.trialHours * 3_600_000;

  try {
    const setup = await deps.hooks.setup(trial);
    setupDone = true;
    record.baseTree = setup.baseTree;
    log.info('setup done', { repoDir: setup.repoDir, baseTree: setup.baseTree });

    // A faux script may carry settings (a small compaction threshold); the same script drives
    // A and B, so they stay identical within a cell.
    let settings = shared.settings;
    let fauxScript: FauxScript | undefined;
    if (options.provider === 'faux') {
      fauxScript = await (options.fauxScript ?? defaultFauxScript)(scenario.id);
      if (fauxScript.settings !== undefined) {
        settings = buildSettings(
          options.config,
          mergeSettings(options.settings ?? {}, fauxScript.settings)
        );
      }
    }
    session = await createTrialSession({
      model,
      condition,
      cwd: setup.repoDir,
      sessionDir: join(trial.tmpDir, 'session'),
      dirs: shared.dirs,
      settings,
      authPath: options.authPath,
      modelsPath: options.modelsPath,
      provider: options.provider,
      ...(fauxScript === undefined ? {} : { fauxScript })
    });
    shared.sessions.add(session.session);
    record.audit = session.audit;
    const expectedPaths = condition.extension === undefined ? [] : [condition.extension];
    const loaded = loadedExtensionPaths(session.audit);
    if (JSON.stringify(loaded) !== JSON.stringify(expectedPaths)) {
      throw new InfraError(
        `loaded extensions ${JSON.stringify(loaded)}, expected ${JSON.stringify(expectedPaths)}`
      );
    }
    writeTrial();

    let stopped = false;
    let throttled = 0;
    for (const [index, step] of scenario.steps.entries()) {
      if (stopped) {
        record.steps.push(skipped(step));
        continue;
      }
      if (Date.now() >= deadline) {
        harness.category = 'timeout';
        harness.error = `trial cap of ${options.config.caps.trialHours} h reached before ${step.id}`;
        stopped = true;
        record.steps.push(skipped(step));
        continue;
      }
      const drive = await driveStep(
        session.session,
        step,
        stepCaps(step, options.config, deadline),
        log.child({ step: step.id })
      );
      let result: StepResult = drive;
      throttled += drive.throttled;
      if (index === 0) {
        const problem = auditProblem(session, condition, shared.promptIds);
        if (problem !== undefined) {
          record.steps.push(drive);
          throw new InfraError(problem);
        }
      }

      // Every terminal error is logged with its text, so an asymmetric error rate between the
      // conditions is visible in the logs even before the report counts `errors.terminal`.
      for (const text of result.errors) {
        log.warn('provider error', {
          step: step.id,
          throttled: isThrottledText(text),
          error: text
        });
      }
      if (drive.overflow) {
        harness.category = 'context_overflow';
        harness.error = result.errors.join('; ');
        stopped = true;
      } else if (result.end === 'timeout' || result.end === 'turn_cap') {
        harness.category = result.end;
        harness.error = `${step.id}: ${result.end}`;
        stopped = true;
      } else if (result.end === 'error') {
        harness.category = 'infra';
        harness.error = `${step.id}: ${result.errors.at(-1) ?? 'step ended on an error'}`;
        stopped = true;
      }

      if (step.kind === 'goal' && result.end === 'settled') {
        result = await deps.hooks.afterGoalStep(trial, step, result);
      } else if (step.kind !== 'goal') {
        scoreFixedAnswer(step, result);
      }
      record.steps.push(result);
      writeTrial();
    }

    if (throttled >= THROTTLE_INFRA_COUNT && harness.category !== 'infra') {
      harness.category = 'infra';
      harness.error = `${throttled} throttled responses`;
    }

    if (session.session.sessionFile !== undefined) trial.sessionFile = session.session.sessionFile;
    final = await deps.hooks.finalize(trial);
    json.scores = final.scores;
  } catch (error) {
    harness.category = 'infra';
    harness.error = error instanceof Error ? error.message : String(error);
    log.error('trial failed', {
      error: harness.error,
      stack: error instanceof Error ? error.stack : undefined
    });
  } finally {
    if (session !== undefined) {
      shared.sessions.delete(session.session);
      await closeTrialSession(session.session).catch((error: unknown) => {
        log.warn('session close failed', { error: String(error) });
      });
      copySession(session.session.sessionFile, trialDir, log);
    }
    if (setupDone || existsSync(trial.tmpDir)) {
      await deps.hooks.teardown(trial).catch((error: unknown) => {
        log.warn('teardown failed', { error: String(error) });
      });
    }
  }

  // `finalize` already folded the harness outcome (caps, overflow, infra) into the checks'
  // category in DESIGN 5.5 order; the run loop only adds "finalize never ran".
  record.category = harness.category === 'infra' || final === undefined ? 'infra' : final.category;
  record.flags = final?.flags ?? [];
  if (harness.error !== undefined) record.error = harness.error;
  record.endedAt = new Date().toISOString();
  json.harness = harness;
  writeTrial();
  try {
    writeMetricsJson(trialDir, record, final?.checks);
  } catch (error) {
    log.warn('metrics failed', { error: describeError(error) });
  }
  log.info('trial end', { category: record.category, flags: record.flags, error: record.error });
  return json;
}

/** `session.jsonl` and `session.episodes/` beside `trial.json`, so stored sessions keep pi-episodes' naming. */
function copySession(sessionFile: string | undefined, trialDir: string, log: Logger): void {
  if (sessionFile === undefined || !existsSync(sessionFile)) {
    log.warn('no session file to copy');
    return;
  }
  cpSync(sessionFile, join(trialDir, 'session.jsonl'));
  const episodes = sessionFile.replace(/\.jsonl$/, '.episodes');
  if (existsSync(episodes))
    cpSync(episodes, join(trialDir, 'session.episodes'), { recursive: true });
}

async function defaultFauxScript(chain: string): Promise<FauxScript> {
  const path = join(SCRIPTS_DIR, `${chain}.ts`);
  if (!existsSync(path)) throw new ConfigError(`--provider faux: no script ${path}`);
  return loadFauxScript(path);
}
