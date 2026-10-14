// Compares the arms of a finished Harbor job: pass rate, tokens, cost, time and the episode
// numbers, per model, with bootstrap intervals over tasks.
//
//   pnpm bench:report bench/runs/<job>
//
// Writes report.md, trials.csv and rows.yaml (Harbor Hub leaderboard rows) into the job dir.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { type SessionNumbers, sessionNumbers } from './session.js';

const RESAMPLES = 2000;
const BASELINE = 'pi';

interface TrialResult {
  id: string;
  task_name: string;
  agent_info: { name: string; version: string };
  config: { agent: { model_name?: string; kwargs?: Record<string, unknown> } };
  agent_result?: {
    n_input_tokens?: number | null;
    n_cache_tokens?: number | null;
    n_output_tokens?: number | null;
    cost_usd?: number | null;
    metadata?: Partial<SessionNumbers> | null;
  } | null;
  verifier_result?: { rewards?: Record<string, number> | null } | null;
  exception_info?: { exception_type: string } | null;
  agent_execution?: { started_at?: string | null; finished_at?: string | null } | null;
}

interface Trial {
  id: string;
  task: string;
  arm: string;
  model: string;
  /** Missing when the trial errored before the verifier wrote one; counted as 0. */
  reward: number | undefined;
  /** Share of the task's tests passing, where the verifier reports it (DeepSWE does). */
  partial: number | undefined;
  error: string | undefined;
  /** Input including cache reads and writes, as Harbor reports it. */
  input: number;
  cached: number;
  output: number;
  cost: number;
  minutes: number | undefined;
  numbers: SessionNumbers | undefined;
}

function readTrial(dir: string): Trial | undefined {
  const file = join(dir, 'result.json');
  if (!existsSync(file)) return undefined;
  const result = JSON.parse(readFileSync(file, 'utf8')) as TrialResult;
  if (!result.agent_info || !result.task_name) return undefined;
  const agent = result.agent_result ?? {};
  const started = result.agent_execution?.started_at;
  const finished = result.agent_execution?.finished_at;

  let numbers = agent.metadata?.stats ? (agent.metadata as SessionNumbers) : undefined;
  if (!numbers) {
    // The agent attaches these after the run; recompute when that step failed.
    const sessions = join(dir, 'agent', 'pi', 'sessions');
    const files = existsSync(sessions)
      ? readdirSync(sessions).filter((name) => name.endsWith('.jsonl'))
      : [];
    if (files.length > 0) numbers = sessionNumbers(join(sessions, files.sort().at(-1)!));
  }

  return {
    id: result.id,
    task: result.task_name,
    arm: result.agent_info.name,
    model: result.config.agent.model_name ?? 'unknown',
    reward: result.verifier_result?.rewards?.reward,
    partial: result.verifier_result?.rewards?.partial,
    error: result.exception_info?.exception_type,
    input: agent.n_input_tokens ?? 0,
    cached: agent.n_cache_tokens ?? 0,
    output: agent.n_output_tokens ?? 0,
    cost: agent.cost_usd ?? 0,
    minutes:
      started && finished ? (Date.parse(finished) - Date.parse(started)) / 60_000 : undefined,
    numbers
  };
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (values: readonly number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN;

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * 95% percentile interval of `statistic` over tasks resampled with replacement. Tasks, not
 * trials, are the unit: attempts on one task are not independent of each other.
 */
function bootstrap<T>(
  items: readonly T[],
  statistic: (sample: readonly T[]) => number
): [number, number] {
  if (items.length < 2) return [Number.NaN, Number.NaN];
  const random = seeded(1);
  const values: number[] = [];
  for (let i = 0; i < RESAMPLES; i++) {
    const sample = items.map(() => items[Math.floor(random() * items.length)]!);
    const value = statistic(sample);
    if (Number.isFinite(value)) values.push(value);
  }
  values.sort((a, b) => a - b);
  return [
    values[Math.floor(values.length * 0.025)]!,
    values[Math.ceil(values.length * 0.975) - 1]!
  ];
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

const reward = (trial: Trial) => trial.reward ?? 0;
const partial = (trial: Trial) => trial.partial ?? trial.reward ?? 0;
const tokens = (trial: Trial) => trial.input + trial.output;
const peak = (trial: Trial) =>
  Math.max(0, ...(trial.numbers?.stats.requests.map((r) => r.tokens) ?? []));

/** Per task, the mean of `value` over its attempts. */
function perTask(trials: readonly Trial[], value: (trial: Trial) => number): Map<string, number> {
  return new Map(
    [...groupBy(trials, (trial) => trial.task)].map(([task, group]) => [
      task,
      mean(group.map(value))
    ])
  );
}

interface ArmSummary {
  model: string;
  arm: string;
  trials: number;
  tasks: number;
  errors: number;
  pass: number;
  passCi: [number, number];
  partial: number;
  /** Tasks whose attempts all passed or all failed. */
  consistent: number;
  tokens: number;
  output: number;
  cost: number;
  minutes: number;
  requests: number;
  peak: number;
  compactions: number;
  folds: number;
  folded: number;
  saved: number;
  recalls: number;
  asks: number;
  forks: number;
  foldErrors: number;
  promptHashes: string[];
  episodesVersions: string[];
  trialIds: string[];
}

function summarize(model: string, arm: string, trials: readonly Trial[]): ArmSummary {
  const passByTask = [...perTask(trials, reward).values()];
  const byTask = [...groupBy(trials, (trial) => trial.task).values()];
  const stat = (pick: (numbers: SessionNumbers) => number) =>
    mean(trials.filter((trial) => trial.numbers).map((trial) => pick(trial.numbers!)));
  const metas = trials.flatMap((trial) =>
    trial.numbers?.episodes ? [trial.numbers.episodes] : []
  );
  return {
    model,
    arm,
    trials: trials.length,
    tasks: passByTask.length,
    errors: trials.filter((trial) => trial.error && trial.reward === undefined).length,
    pass: mean(passByTask),
    passCi: bootstrap(passByTask, mean),
    partial: mean([...perTask(trials, partial).values()]),
    consistent:
      byTask.filter((group) => new Set(group.map((trial) => reward(trial) >= 1)).size === 1)
        .length / byTask.length,
    tokens: median(trials.map(tokens)),
    output: median(trials.map((trial) => trial.output)),
    cost: mean(trials.map((trial) => trial.cost)),
    minutes: median(
      trials.flatMap((trial) => (trial.minutes === undefined ? [] : [trial.minutes]))
    ),
    requests: stat((numbers) => numbers.stats.requests.length),
    peak: median(trials.filter((trial) => trial.numbers).map(peak)),
    compactions: stat((numbers) => numbers.stats.compactions),
    folds: stat((numbers) => numbers.stats.folds.count),
    folded: stat((numbers) => numbers.stats.folds.tokens),
    saved: stat((numbers) => numbers.stats.folds.saved),
    recalls: stat((numbers) => numbers.stats.recall.count),
    asks: stat((numbers) => numbers.stats.ask.count),
    forks: stat((numbers) => numbers.stats.forks.count),
    foldErrors: stat((numbers) => numbers.stats.folds.rejected),
    promptHashes: [...new Set(metas.map((meta) => meta.promptHash))],
    episodesVersions: [...new Set(metas.map((meta) => meta.version))],
    trialIds: trials.map((trial) => trial.id)
  };
}

interface Paired {
  model: string;
  tasks: number;
  pass: number;
  passCi: [number, number];
  partial: number;
  partialCi: [number, number];
  /** Geometric mean over tasks of episodes / baseline, minus one. */
  tokens: number;
  tokensCi: [number, number];
  cost: number;
  costCi: [number, number];
  minutes: number;
  peak: number;
  better: number;
  worse: number;
}

/** Episodes against the baseline on the tasks both ran, per model. */
function compare(
  model: string,
  base: readonly Trial[],
  episodes: readonly Trial[]
): Paired | undefined {
  const tasks = [...new Set(base.map((trial) => trial.task))].filter((task) =>
    episodes.some((trial) => trial.task === task)
  );
  if (tasks.length === 0) return undefined;

  const pair = (value: (trial: Trial) => number) => {
    const a = perTask(base, value);
    const b = perTask(episodes, value);
    return tasks.map((task) => ({ base: a.get(task)!, episodes: b.get(task)! }));
  };
  const diff = (pairs: readonly { base: number; episodes: number }[]) =>
    mean(pairs.map((p) => p.episodes - p.base));
  const ratio = (pairs: readonly { base: number; episodes: number }[]) => {
    const logs = pairs
      .filter((p) => p.base > 0 && p.episodes > 0)
      .map((p) => Math.log(p.episodes / p.base));
    return Math.exp(mean(logs)) - 1;
  };

  const passes = pair(reward);
  const partials = pair(partial);
  const tokenPairs = pair(tokens);
  const costPairs = pair((trial) => trial.cost);
  return {
    model,
    tasks: tasks.length,
    pass: diff(passes),
    passCi: bootstrap(passes, diff),
    partial: diff(partials),
    partialCi: bootstrap(partials, diff),
    tokens: ratio(tokenPairs),
    tokensCi: bootstrap(tokenPairs, ratio),
    cost: ratio(costPairs),
    costCi: bootstrap(costPairs, ratio),
    minutes: ratio(pair((trial) => trial.minutes ?? 0)),
    peak: ratio(pair(peak)),
    better: passes.filter((p) => p.episodes > p.base).length,
    worse: passes.filter((p) => p.episodes < p.base).length
  };
}

const pct = (value: number) => (Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '-');
const signed = (value: number) =>
  Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%` : '-';
const range = ([low, high]: [number, number], format: (value: number) => string) =>
  Number.isFinite(low) ? `${format(low)} .. ${format(high)}` : '-';
const k = (value: number) =>
  !Number.isFinite(value)
    ? '-'
    : value >= 1e6
      ? `${(value / 1e6).toFixed(2)}M`
      : value >= 1e3
        ? `${(value / 1e3).toFixed(0)}k`
        : value.toFixed(1);
const num = (value: number, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : '-');

function table(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`)
  ].join('\n');
}

function main(): number {
  const dir = process.argv[2];
  if (!dir || !existsSync(dir)) {
    console.error('usage: pnpm bench:report bench/runs/<job>');
    return 2;
  }
  const trials = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => readTrial(join(dir, entry.name)) ?? []);
  if (trials.length === 0) {
    console.error(`No trial results in ${dir}`);
    return 1;
  }

  const summaries = [...groupBy(trials, (trial) => `${trial.model}\0${trial.arm}`)]
    .map(([key, group]) => {
      const [model, arm] = key.split('\0') as [string, string];
      return summarize(model, arm, group);
    })
    .sort((a, b) => a.model.localeCompare(b.model) || a.arm.localeCompare(b.arm));
  const paired = [...groupBy(trials, (trial) => trial.model)].flatMap(([model, group]) => {
    const result = compare(
      model,
      group.filter((trial) => trial.arm === BASELINE),
      group.filter((trial) => trial.arm !== BASELINE)
    );
    return result ? [result] : [];
  });

  const lines = [
    `# ${dir.split('/').filter(Boolean).at(-1)}`,
    '',
    `${trials.length} trials. Intervals are 95% bootstrap over tasks. Missing rewards (errored trials) count as failures.`,
    '',
    '## Episodes against plain pi',
    '',
    'Pass is the change in pass rate, partial the change in the share of tests passing (points). Tokens, cost, time and peak context are the geometric mean over tasks of episodes / pi; negative is fewer.',
    '',
    table(
      [
        'model',
        'tasks',
        'pass',
        'pass CI',
        'partial',
        'partial CI',
        'better/worse tasks',
        'tokens',
        'tokens CI',
        'cost',
        'cost CI',
        'time',
        'peak context'
      ],
      paired.map((p) => [
        p.model,
        String(p.tasks),
        signed(p.pass),
        range(p.passCi, signed),
        signed(p.partial),
        range(p.partialCi, signed),
        `${p.better}/${p.worse}`,
        signed(p.tokens),
        range(p.tokensCi, signed),
        signed(p.cost),
        range(p.costCi, signed),
        signed(p.minutes),
        signed(p.peak)
      ])
    ),
    '',
    '## Per arm',
    '',
    'Tokens, output, time and peak context are medians per trial; cost and the rest are means. Consistent: tasks whose attempts all passed or all failed.',
    '',
    table(
      [
        'model',
        'arm',
        'trials',
        'errors',
        'pass',
        'pass CI',
        'partial',
        'consistent',
        'tokens',
        'output',
        'cost $',
        'minutes',
        'requests',
        'peak context',
        'compactions'
      ],
      summaries.map((s) => [
        s.model,
        s.arm,
        String(s.trials),
        String(s.errors),
        pct(s.pass),
        range(s.passCi, pct),
        pct(s.partial),
        pct(s.consistent),
        k(s.tokens),
        k(s.output),
        num(s.cost, 2),
        num(s.minutes),
        num(s.requests),
        k(s.peak),
        num(s.compactions, 2)
      ])
    ),
    '',
    '## Episodes',
    '',
    'Means per trial.',
    '',
    table(
      [
        'model',
        'arm',
        'folds',
        'folded',
        'sent less',
        'fold errors',
        'recalls',
        'asks',
        'forks',
        'version',
        'prompt'
      ],
      summaries
        .filter((s) => s.arm !== BASELINE)
        .map((s) => [
          s.model,
          s.arm,
          num(s.folds),
          k(s.folded),
          k(s.saved),
          num(s.foldErrors),
          num(s.recalls),
          num(s.asks),
          num(s.forks),
          s.episodesVersions.join(', ') || '-',
          s.promptHashes.join(', ') || '-'
        ])
    )
  ];
  const mixed = summaries.filter((s) => s.promptHashes.length > 1);
  if (mixed.length > 0) {
    lines.push(
      '',
      `Warning: trials with different prompt hashes are averaged together for ${mixed.map((s) => s.model).join(', ')}.`
    );
  }
  const errors = [
    ...groupBy(
      trials.filter((trial) => trial.error),
      (trial) => trial.error!
    )
  ];
  if (errors.length > 0) {
    lines.push('', '## Errors', '', ...errors.map(([type, group]) => `- ${type}: ${group.length}`));
  }
  const report = `${lines.join('\n')}\n`;
  writeFileSync(join(dir, 'report.md'), report);

  const columns: [string, (trial: Trial) => unknown][] = [
    ['task', (t) => t.task],
    ['arm', (t) => t.arm],
    ['model', (t) => t.model],
    ['reward', (t) => t.reward ?? ''],
    ['partial', (t) => t.partial ?? ''],
    ['error', (t) => t.error ?? ''],
    ['input', (t) => t.input],
    ['cached', (t) => t.cached],
    ['output', (t) => t.output],
    ['cost', (t) => t.cost],
    ['minutes', (t) => t.minutes?.toFixed(2) ?? ''],
    ['requests', (t) => t.numbers?.stats.requests.length ?? ''],
    ['peak', (t) => (t.numbers ? peak(t) : '')],
    ['compactions', (t) => t.numbers?.stats.compactions ?? ''],
    ['folds', (t) => t.numbers?.stats.folds.count ?? ''],
    ['folded', (t) => t.numbers?.stats.folds.tokens ?? ''],
    ['saved', (t) => t.numbers?.stats.folds.saved ?? ''],
    ['recalls', (t) => t.numbers?.stats.recall.count ?? ''],
    ['asks', (t) => t.numbers?.stats.ask.count ?? ''],
    ['forks', (t) => t.numbers?.stats.forks.count ?? ''],
    ['prompt', (t) => t.numbers?.episodes?.promptHash ?? ''],
    ['id', (t) => t.id]
  ];
  writeFileSync(
    join(dir, 'trials.csv'),
    `${[columns.map(([name]) => name).join(','), ...trials.map((trial) => columns.map(([, get]) => JSON.stringify(get(trial))).join(','))].join('\n')}\n`
  );

  writeFileSync(
    join(dir, 'rows.yaml'),
    stringify({
      rows: summaries.map((s) => ({
        metadata: {
          agent: s.arm,
          model: s.model,
          episodes: s.episodesVersions.join(', ') || null,
          prompt: s.promptHashes.join(', ') || null
        },
        metrics: {
          pass_rate: s.pass,
          partial: s.partial,
          tokens_median: s.tokens,
          cost_usd_mean: s.cost,
          minutes_median: s.minutes,
          peak_context_median: s.peak,
          compactions_mean: s.compactions,
          folds_mean: s.folds
        },
        trial_ids: s.trialIds
      }))
    })
  );

  process.stdout.write(report);
  return 0;
}

process.exit(main());
