import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ArgsError, parseArgs } from '../args.js';
import { meanOf } from '../checks.js';
import { resolvePiModelsPath } from '../config.js';
import {
  type CallModel,
  createModelCaller,
  DEFAULT_JUDGE_CONFIG,
  DEFAULT_LABELS_PATH,
  groupOf,
  judgeExtracts,
  judgeTrial,
  kappaReport,
  loadJudgeConfig,
  loadTrialInput,
  nullCheck,
  pickJudgeModel,
  RUBRIC_GROUPS,
  type RubricGroup,
  readLabels,
  renderKappa,
  type TrialInput
} from '../judge.js';
import { loadScenario, resolveScenarioDir } from '../scenario.js';
import type {
  ChecksJson,
  JudgeConfig,
  JudgeJson,
  KappaCell,
  NullCheckResult,
  RubricSummary,
  Scenario,
  TrialRecord
} from '../types.js';
import { propagateChecks } from './check.js';
import { resolveRunDir } from './report.js';

const FLAGS = ['null-check', 'kappa'];
const OPTIONS = ['rubrics', 'null-check', 'kappa', 'judge', 'config', 'labels'];

export interface JudgeCommandOptions {
  runDir: string;
  groups: readonly RubricGroup[];
  nullCheckOnly: boolean;
  kappa: boolean;
  /** Overrides the per-trial choice from `config.models`. */
  judgeModel?: string;
  config: JudgeConfig;
  /** pi `models.json` with custom endpoints, or `null`; see `resolvePiModelsPath`. */
  modelsPath: string | null;
  labelsPath: string;
}

/** Injectable pieces so tests run the command without a provider. */
export interface JudgeCommandDeps {
  /** Stands in for every judge model. */
  callModel?: CallModel;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

/** `judge-summary.json` at the run level: the null check and rubric totals per condition. */
export interface JudgeSummaryJson {
  runId: string;
  generatedAt: string;
  /** The `--judge` override, when given. */
  judgeModel?: string;
  /** Every judge model used, one per trial model family (DESIGN 9). */
  judgeModels: string[];
  nullCheck: NullCheckResult;
  withheld: boolean;
  trials: number;
  conditions: Record<
    string,
    { trials: number; rubrics: Record<string, Omit<RubricSummary, 'items'>> }
  >;
  kappa?: KappaCell[];
}

interface RunTrial {
  dir: string;
  record: TrialRecord;
  input: TrialInput;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Scenario dirs from the run manifest, falling back to `bench/scenarios/<chain>`. */
function scenarioLoader(runDir: string): (chain: string) => Scenario {
  const manifestPath = join(runDir, 'manifest.json');
  const manifest = existsSync(manifestPath)
    ? readJson<{ scenarios?: { id: string; dir: string }[] }>(manifestPath)
    : undefined;
  const cache = new Map<string, Scenario>();
  return (chain) => {
    let scenario = cache.get(chain);
    if (scenario) return scenario;
    const listed = manifest?.scenarios?.find((entry) => entry.id === chain)?.dir;
    const dir = listed !== undefined && existsSync(listed) ? listed : resolveScenarioDir(chain);
    scenario = loadScenario(dir);
    cache.set(chain, scenario);
    return scenario;
  };
}

export function loadRunTrials(runDir: string, warn: (text: string) => void): RunTrial[] {
  const trialsDir = join(runDir, 'trials');
  if (!existsSync(trialsDir)) throw new ArgsError(`${trialsDir} does not exist`);
  const scenarioOf = scenarioLoader(runDir);
  const trials: RunTrial[] = [];
  for (const name of readdirSync(trialsDir).sort()) {
    const dir = join(trialsDir, name);
    if (!existsSync(join(dir, 'trial.json')) || !existsSync(join(dir, 'session.jsonl'))) {
      warn(`${name}: no trial.json or session.jsonl; skipped`);
      continue;
    }
    const record = readJson<TrialRecord>(join(dir, 'trial.json'));
    if (record.category === 'infra') {
      warn(`${name}: infra trial; skipped`);
      continue;
    }
    trials.push({ dir, record, input: loadTrialInput(dir, scenarioOf(record.chain)) });
  }
  return trials;
}

/**
 * DESIGN 4, 9: `abstain` and `judge` probe answers are scored by the judge. Their verdicts go
 * back into `checks.json` (`answers[].pass`, `scoreProbe`), then `trial.json` and
 * `metrics.json` follow, so `score_probe` has the same denominator before and after judging.
 * Returns whether anything changed.
 */
export function mergeJudgedProbes(
  trialDir: string,
  checks: ChecksJson | undefined,
  judged: JudgeJson
): boolean {
  if (checks === undefined) return false;
  let changed = false;
  for (const item of judged.rubrics?.probes?.items ?? []) {
    if (typeof item.pass !== 'boolean') continue;
    const answer = checks.answers.find(
      (candidate) =>
        candidate.stepId === item.subject &&
        (candidate.kind === 'abstain' || candidate.kind === 'judge')
    );
    if (answer === undefined || answer.pass === item.pass) continue;
    answer.pass = item.pass;
    changed = true;
  }
  if (!changed) return false;
  const scored = checks.answers.filter((answer) => answer.pass !== undefined);
  checks.scoreProbe = meanOf(scored.map((answer) => answer.pass === true));
  writeJson(join(trialDir, 'checks.json'), checks);
  propagateChecks(trialDir, checks);
  return true;
}

function withoutItems(
  rubrics: Record<string, RubricSummary>
): Record<string, Omit<RubricSummary, 'items'>> {
  return Object.fromEntries(
    Object.entries(rubrics).map(([id, { pass, total, pending, invalid }]) => [
      id,
      { pass, total, pending, invalid }
    ])
  );
}

export function parseJudgeArgs(argv: string[]): JudgeCommandOptions {
  const args = parseArgs(argv, FLAGS);
  args.assertKnown(OPTIONS);
  const runId = args.positionals[0];
  if (runId === undefined) throw new ArgsError('missing <run-id>');
  if (args.positionals.length > 1)
    throw new ArgsError(`unexpected argument ${args.positionals[1]}`);
  const groups = args.list('rubrics') ?? [...RUBRIC_GROUPS];
  for (const group of groups) {
    if (!(RUBRIC_GROUPS as readonly string[]).includes(group)) {
      throw new ArgsError(`--rubrics: unknown group ${group}; use ${RUBRIC_GROUPS.join(', ')}`);
    }
  }
  const options: JudgeCommandOptions = {
    runDir: resolveRunDir(runId),
    groups: groups as RubricGroup[],
    nullCheckOnly: args.flag('null-check'),
    kappa: args.flag('kappa'),
    config: loadJudgeConfig(args.string('config') ?? DEFAULT_JUDGE_CONFIG),
    modelsPath: resolvePiModelsPath(),
    labelsPath: args.string('labels') ?? DEFAULT_LABELS_PATH
  };
  const judgeModel = args.string('judge');
  if (judgeModel !== undefined) options.judgeModel = judgeModel;
  return options;
}

function kappaCommand(options: JudgeCommandOptions, stdout: (text: string) => void): KappaCell[] {
  const runId = basename(options.runDir);
  const labels = readLabels(options.labelsPath).filter(
    (label) => label.run === runId || label.run === options.runDir
  );
  const cells = kappaReport(labels, (_run, trial) => {
    const path = join(options.runDir, 'trials', trial, 'judge.json');
    return existsSync(path) ? readJson<JudgeJson>(path) : undefined;
  });
  stdout(`${labels.length} label(s) for ${runId}\n${renderKappa(cells)}`);
  writeJson(join(options.runDir, 'judge-kappa.json'), { runId, labels: labels.length, cells });
  return cells;
}

export async function runJudge(
  options: JudgeCommandOptions,
  deps: JudgeCommandDeps = {}
): Promise<number> {
  const stdout = deps.stdout ?? ((text) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text) => process.stderr.write(text));
  if (options.kappa) {
    kappaCommand(options, stdout);
    return 0;
  }

  const runId = basename(options.runDir);
  const trials = loadRunTrials(options.runDir, (text) => stderr(`bench judge: ${text}\n`));
  if (trials.length === 0) throw new ArgsError(`no judgeable trials under ${options.runDir}`);

  const check = nullCheck(trials.map((trial) => trial.input));
  for (const problem of check.problems) stderr(`bench judge: null check: ${problem}\n`);
  stdout(
    `null check on ${check.trials} condition A trial(s): ${check.ok ? 'ok' : `${check.problems.length} problem(s), rubric or extractor invalid`}\n`
  );
  if (options.nullCheckOnly) return check.ok ? 0 : 1;

  const generatedAt = new Date().toISOString();
  const summary: JudgeSummaryJson = {
    runId,
    generatedAt,
    judgeModels: [],
    nullCheck: check,
    withheld: !check.ok,
    trials: trials.length,
    conditions: {}
  };
  if (options.judgeModel !== undefined) summary.judgeModel = options.judgeModel;

  if (!check.ok) {
    const reason = `null check failed: ${check.problems.join('; ')}`;
    for (const trial of trials) {
      const withheld: JudgeJson = { generatedAt, withheld: true, reason };
      if (options.judgeModel !== undefined) withheld.judgeModel = options.judgeModel;
      writeJson(join(trial.dir, 'judge.json'), withheld);
    }
    writeJson(join(options.runDir, 'judge-summary.json'), summary);
    stderr('bench judge: judge block withheld; fix the extractor and rerun\n');
    return 1;
  }

  // One caller per judge model, created when a trial first needs a judge question answered.
  const callers = new Map<string, CallModel>();
  const callerFor = async (judgeModel: string): Promise<CallModel> => {
    if (deps.callModel !== undefined) return deps.callModel;
    let caller = callers.get(judgeModel);
    if (caller === undefined) {
      caller = await createModelCaller(judgeModel, options.config.authPath, options.modelsPath);
      callers.set(judgeModel, caller);
    }
    return caller;
  };

  for (const trial of trials) {
    const judgePath = join(trial.dir, 'judge.json');
    const previous = existsSync(judgePath) ? readJson<JudgeJson>(judgePath) : undefined;
    const trialModel = trial.record.audit?.model;
    const judgeModel = pickJudgeModel(options.config.models, trialModel, options.judgeModel);
    const needsModel =
      judgeModel !== undefined &&
      judgeExtracts(trial.input).some((extract) =>
        options.groups.includes(groupOf(extract.rubric))
      );
    const callModel = needsModel ? await callerFor(judgeModel) : undefined;
    const result = await judgeTrial(trial.input, {
      groups: options.groups,
      ...(judgeModel === undefined ? {} : { judgeModel }),
      ...(callModel === undefined ? {} : { callModel }),
      ...(trialModel === undefined ? {} : { trialModel }),
      ...(previous === undefined ? {} : { previous })
    });
    if (judgeModel === undefined) {
      result.refused = `no configured judge model outside the trial model's family (${trialModel ?? 'unknown'})`;
    } else if (!summary.judgeModels.includes(judgeModel)) {
      summary.judgeModels.push(judgeModel);
    }
    writeJson(judgePath, result);
    if (mergeJudgedProbes(trial.dir, trial.input.checks, result)) {
      stdout(`${basename(trial.dir)}: score_probe updated from judged probe answers\n`);
    }
    const condition = trial.input.trialRecord.condition;
    const slot = summary.conditions[condition] ?? { trials: 0, rubrics: {} };
    slot.trials++;
    for (const [id, rubric] of Object.entries(result.rubrics ?? {})) {
      const total = slot.rubrics[id] ?? { pass: 0, total: 0, pending: 0, invalid: 0 };
      total.pass += rubric.pass;
      total.total += rubric.total;
      total.pending += rubric.pending;
      total.invalid += rubric.invalid;
      slot.rubrics[id] = total;
    }
    summary.conditions[condition] = slot;
    const line = Object.entries(withoutItems(result.rubrics ?? {}))
      .map(
        ([id, rubric]) =>
          `${id} ${rubric.pass}/${rubric.total}${rubric.pending > 0 ? ` (+${rubric.pending} pending)` : ''}${rubric.invalid > 0 ? ` (${rubric.invalid} invalid)` : ''}`
      )
      .join(', ');
    stdout(
      `${basename(trial.dir)}: ${result.refused ? `refused (${result.refused}); ` : ''}${line || 'no items'}\n`
    );
  }

  writeJson(join(options.runDir, 'judge-summary.json'), summary);
  stdout(`${join(options.runDir, 'judge-summary.json')}\n`);
  return 0;
}

export async function run(argv: string[]): Promise<number> {
  return runJudge(parseJudgeArgs(argv));
}
