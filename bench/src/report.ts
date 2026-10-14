import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { computeMetrics } from './metrics.js';
import {
  bootstrapRatioOfGeomeans,
  type Cell,
  flipRate,
  geomean,
  logSd,
  mean,
  meanCI,
  meanDiffCI,
  median,
  newcombe,
  passPowK,
  plannedN as plannedNFor,
  pooledCvRatio,
  pooledLogRatio,
  pooledMeanDiff,
  pooledPassPowK,
  wilson
} from './stats.js';
import type {
  ChainRow,
  ChecksJson,
  CompareModel,
  CompareRow,
  ConditionSummary,
  Estimate,
  FoldMechanics,
  MetricsJson,
  ModelReport,
  ReportJson,
  TrialAudit,
  TrialCategory,
  TrialRecord,
  VarianceCell,
  Verdict
} from './types.js';

/** A results dir cannot be reported as asked; the message says why. */
export class ReportError extends Error {}

export const DEFAULT_HELD_OUT = ['mapped-types'];
/** H2: B's `score_code` may not be lower than A's by more than this (DESIGN 1). */
export const SCORE_MARGIN = 0.1;
/** H3: B's share of bad endings may not exceed A's by more than this (DESIGN 1). */
export const CATEGORY_MARGIN = 0.1;
const BAD_CATEGORIES: TrialCategory[] = ['timeout', 'turn_cap', 'build_broken', 'context_overflow'];
/** `flagged` trials leave H1 and H2; above this share of a cell the model is `insufficient`. */
const MAX_EXCLUDED_SHARE = 0.3;
/** DESIGN 8.4: a run planned below this n is a pilot and is never read for B vs A. */
export const PILOT_MAX_N = 10;
const PILOT_REASON = 'pilot-sized run (n < 10), read the n column and the variance note';
const AUDIT_FIELDS: (keyof TrialAudit)[] = [
  'model',
  'provider',
  'modelId',
  'thinking',
  'settings',
  'tools',
  'systemPromptHash',
  'extensionPaths',
  'promptId',
  'piVersion',
  'episodesCommit'
];

/** `trial.json` as `bench run` writes it; `scores` is the run loop's copy of the checks' scores. */
export interface TrialFile extends TrialRecord {
  scores?: {
    scoreStep: Record<string, number>;
    scoreCode?: number;
    scoreProbe?: number;
    pass?: boolean;
  };
}

export interface LoadedTrial {
  id: string;
  dir: string;
  trial: TrialFile;
  metrics: MetricsJson;
  checks?: ChecksJson;
  judge?: unknown;
}

/** The subset of `manifest.json` the report reads; written by `bench run`. */
export interface ManifestView {
  runId?: string;
  /** `runsPerCell` is the planned n of the verdict (DESIGN 1, 8.4). */
  config?: { scenarios?: string[]; heldOut?: string[]; runsPerCell?: number };
  promptIds?: Record<string, string>;
  piVersion?: string;
  episodes?: Record<string, { commit?: string; dirty?: boolean }>;
  startedAt?: string;
  endedAt?: string;
}

export interface LoadedRun {
  runDir: string;
  runId: string;
  manifest?: ManifestView;
  trials: LoadedTrial[];
  warnings: string[];
}

export interface BuildReportOptions {
  compare?: string;
  /** Bootstrap resamples; tests lower it. Default 10000. */
  reps?: number;
  seed?: number;
}

export interface BuiltReport {
  report: ReportJson;
  markdown: string;
  trials: LoadedTrial[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadRun(runDir: string): LoadedRun {
  if (!existsSync(runDir)) throw new ReportError(`no such run: ${runDir}`);
  const warnings: string[] = [];
  const manifestPath = join(runDir, 'manifest.json');
  const manifest = existsSync(manifestPath) ? (readJson(manifestPath) as ManifestView) : undefined;
  if (!manifest)
    warnings.push(
      `${manifestPath} is missing; held-out chains default to ${DEFAULT_HELD_OUT.join(', ')}`
    );
  const trialsDir = join(runDir, 'trials');
  if (!existsSync(trialsDir)) throw new ReportError(`no trials dir: ${trialsDir}`);

  const trials: LoadedTrial[] = [];
  for (const name of readdirSync(trialsDir).sort()) {
    const dir = join(trialsDir, name);
    const trialPath = join(dir, 'trial.json');
    if (!existsSync(trialPath)) continue;
    const trial = readJson(trialPath) as TrialFile;
    const checksPath = join(dir, 'checks.json');
    const checks = existsSync(checksPath) ? (readJson(checksPath) as ChecksJson) : undefined;
    const metricsPath = join(dir, 'metrics.json');
    const sessionPath = join(dir, 'session.jsonl');
    let metrics: MetricsJson;
    if (existsSync(metricsPath)) {
      metrics = readJson(metricsPath) as MetricsJson;
    } else if (existsSync(sessionPath)) {
      // A run that stopped before metrics were written still has the session; derive them.
      metrics = computeMetrics(
        checks ? { sessionPath, trialRecord: trial, checks } : { sessionPath, trialRecord: trial }
      );
    } else {
      warnings.push(`${name}: no metrics.json and no session.jsonl; skipped`);
      continue;
    }
    const loaded: LoadedTrial = { id: name, dir, trial, metrics };
    if (checks) loaded.checks = checks;
    const judgePath = join(dir, 'judge.json');
    if (existsSync(judgePath)) loaded.judge = readJson(judgePath);
    trials.push(loaded);
  }
  const run: LoadedRun = { runDir, runId: manifest?.runId ?? basename(runDir), trials, warnings };
  if (manifest) run.manifest = manifest;
  return run;
}

function category(trial: LoadedTrial): TrialCategory {
  return trial.metrics.category ?? trial.trial.category ?? 'infra';
}

function scoreCodeOf(trial: LoadedTrial): number | undefined {
  return trial.metrics.scoreCode ?? trial.trial.scores?.scoreCode;
}

function passOf(trial: LoadedTrial): boolean | undefined {
  return trial.metrics.pass ?? trial.trial.scores?.pass;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** DESIGN 6: trials of one cell must agree on every audit field, or nothing is pooled. */
export function assertSameAudit(cellName: string, trials: readonly LoadedTrial[]): void {
  const first = trials[0];
  if (!first) return;
  for (const other of trials.slice(1)) {
    for (const field of AUDIT_FIELDS) {
      const left = stableJson(first.trial.audit?.[field]);
      const right = stableJson(other.trial.audit?.[field]);
      if (left !== right) {
        throw new ReportError(
          `refusing to pool ${cellName}: audit field ${field} differs between ${first.id} and ${other.id}`
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Grouping and estimation
// ---------------------------------------------------------------------------

interface CellTrials {
  /** Non-infra trials: the denominator for categories and H3. */
  all: LoadedTrial[];
  /** `all` minus `flagged`: the trials behind every estimate. */
  used: LoadedTrial[];
  /** Infra trials: outside every denominator, counted and listed so an asymmetric rate shows. */
  infra: LoadedTrial[];
}

function cellOf(
  trials: readonly LoadedTrial[],
  model: string,
  condition: string,
  chain: string
): CellTrials {
  const members = trials.filter(
    (trial) =>
      trial.trial.model === model &&
      trial.trial.condition === condition &&
      trial.trial.chain === chain
  );
  const all = members.filter((trial) => category(trial) !== 'infra');
  return {
    all,
    used: all.filter((trial) => category(trial) !== 'flagged'),
    infra: members.filter((trial) => category(trial) === 'infra')
  };
}

function positive(values: readonly number[]): number[] {
  return values.filter((value) => Number.isFinite(value) && value > 0);
}

function toEstimate(interval: { value: number; lower: number; upper: number }): Estimate {
  return { value: interval.value, lower: interval.lower, upper: interval.upper };
}

function conditionSummary(
  condition: string,
  cell: CellTrials,
  reps: number,
  seed: number
): ConditionSummary {
  const used = cell.used;
  const scores = used.map(scoreCodeOf).filter((score): score is number => score !== undefined);
  const passes = used.map(passOf).filter((pass): pass is boolean => pass !== undefined);
  const c = passes.filter(Boolean).length;
  const w = wilson(c, passes.length);
  const categories: Partial<Record<TrialCategory, number>> = {};
  for (const trial of cell.all) {
    const kind = category(trial);
    categories[kind] = (categories[kind] ?? 0) + 1;
  }
  if (cell.infra.length > 0) categories.infra = cell.infra.length;
  const meanOf = (pick: (trial: LoadedTrial) => number) =>
    used.length > 0 ? mean(used.map(pick)) : NaN;
  const tokens = positive(used.map((trial) => trial.metrics.contextAttended));
  const summary: ConditionSummary = {
    condition,
    n: cell.all.length,
    infra: cell.infra.length,
    infraErrors: cell.infra.map((trial) => `${trial.id}: ${trial.trial.error ?? 'unknown'}`),
    terminalErrors: cell.all.reduce((sum, trial) => sum + (trial.metrics.errors.terminal ?? 0), 0),
    excluded: cell.all.length - used.length,
    used: used.length,
    scoreCode: toEstimate(meanCI(scores, { reps, seed })),
    pass: { value: w.value, lower: w.lower, upper: w.upper, c },
    cacheHit: meanOf((trial) => trial.metrics.cacheHitRate.overall),
    compactions: meanOf((trial) => trial.metrics.compactions.length),
    categories,
    episodes: {
      folds: meanOf((trial) => trial.metrics.folds.length),
      recalls: meanOf((trial) => trial.metrics.recalls.length),
      asks: meanOf((trial) => trial.metrics.asks.length),
      forks: meanOf((trial) => trial.metrics.forks.length)
    },
    tokensGeomean: tokens.length > 0 ? geomean(tokens) : NaN,
    sdLogTokens: tokens.length >= 2 ? logSd(tokens) : NaN
  };
  const pow3 = passPowK(c, passes.length, 3);
  if (pow3 !== undefined) summary.passPow3 = pow3;
  const flip = flipRate(c, passes.length);
  if (flip !== undefined) summary.flip = flip;
  return summary;
}

type Quantity = 'tokens' | 'output' | 'cost' | 'turns' | 'wall' | 'peak';
const QUANTITIES: Record<Quantity, (metrics: MetricsJson) => number> = {
  tokens: (metrics) => metrics.contextAttended,
  output: (metrics) => metrics.tokens.output,
  cost: (metrics) => metrics.cost.total,
  turns: (metrics) => metrics.requests,
  wall: (metrics) => metrics.wallTimeS,
  peak: (metrics) => metrics.peakContext
};

function quantityCells(
  chains: readonly string[],
  cells: (chain: string) => { a: CellTrials; b: CellTrials },
  pick: (metrics: MetricsJson) => number
): Cell[] {
  return chains.map((chain) => {
    const { a, b } = cells(chain);
    return {
      chain,
      b: positive(b.used.map((trial) => pick(trial.metrics))),
      a: positive(a.used.map((trial) => pick(trial.metrics)))
    };
  });
}

function scoreCells(
  chains: readonly string[],
  cells: (chain: string) => { a: CellTrials; b: CellTrials }
): Cell[] {
  return chains.map((chain) => {
    const { a, b } = cells(chain);
    const scores = (trials: LoadedTrial[]) =>
      trials.map(scoreCodeOf).filter((score): score is number => score !== undefined);
    return { chain, b: scores(b.used), a: scores(a.used) };
  });
}

function chainRow(
  chain: string,
  heldOut: boolean,
  a: CellTrials,
  b: CellTrials,
  conditionA: string,
  conditionB: string,
  reps: number,
  seed: number
): ChainRow {
  const cells = () => ({ a, b });
  const ratio = (quantity: Quantity) => {
    const [cell] = quantityCells([chain], cells, QUANTITIES[quantity]);
    return toEstimate(bootstrapRatioOfGeomeans(cell!.b, cell!.a, { reps, seed }));
  };
  const [tokenCell] = quantityCells([chain], cells, QUANTITIES.tokens);
  const tokens = bootstrapRatioOfGeomeans(tokenCell!.b, tokenCell!.a, { reps, seed });
  const [score] = scoreCells([chain], cells);
  const diff = meanDiffCI(score!.b, score!.a, { reps, seed });
  const summaryA = conditionSummary(conditionA, a, reps, seed);
  const summaryB = conditionSummary(conditionB, b, reps, seed + 1);
  const cv = pooledCvRatio([tokenCell!], { reps, seed });
  return {
    chain,
    pooled: false,
    heldOut,
    a: summaryA,
    b: summaryB,
    scoreCodeDiff: { ...toEstimate(diff), lowerOneSided: diff.lowerOneSided },
    passDiff: toEstimate(newcombe(summaryB.pass.c, summaryB.used, summaryA.pass.c, summaryA.used)),
    tokens: toEstimate(tokens),
    pBelow: tokens.pBelow,
    output: ratio('output'),
    cost: ratio('cost'),
    turns: ratio('turns'),
    wall: ratio('wall'),
    peak: ratio('peak'),
    cvRatio: toEstimate(cv)
  };
}

function pooledRow(
  chains: readonly string[],
  cells: (chain: string) => { a: CellTrials; b: CellTrials },
  conditionA: string,
  conditionB: string,
  reps: number,
  seed: number
): ChainRow {
  const merge = (side: 'a' | 'b'): CellTrials => ({
    all: chains.flatMap((chain) => cells(chain)[side].all),
    used: chains.flatMap((chain) => cells(chain)[side].used),
    infra: chains.flatMap((chain) => cells(chain)[side].infra)
  });
  const a = merge('a');
  const b = merge('b');
  const summaryA = conditionSummary(conditionA, a, reps, seed);
  const summaryB = conditionSummary(conditionB, b, reps, seed + 1);
  const perChain = (side: 'a' | 'b') =>
    chains.map((chain) => {
      const passes = cells(chain)
        [side].used.map(passOf)
        .filter((pass): pass is boolean => pass !== undefined);
      return { c: passes.filter(Boolean).length, n: passes.length };
    });
  for (const [side, summary] of [
    ['a', summaryA],
    ['b', summaryB]
  ] as const) {
    const pow3 = pooledPassPowK(perChain(side), 3);
    if (pow3 !== undefined) summary.passPow3 = pow3;
    else delete summary.passPow3;
    const flips = perChain(side)
      .map((cell) => flipRate(cell.c, cell.n))
      .filter((flip): flip is number => flip !== undefined);
    if (flips.length > 0) summary.flip = mean(flips);
    else delete summary.flip;
  }
  const ratio = (quantity: Quantity) =>
    toEstimate(pooledLogRatio(quantityCells(chains, cells, QUANTITIES[quantity]), { reps, seed }));
  const tokens = pooledLogRatio(quantityCells(chains, cells, QUANTITIES.tokens), { reps, seed });
  const diff = pooledMeanDiff(scoreCells(chains, cells), { reps, seed });
  return {
    chain: 'pooled',
    pooled: true,
    heldOut: false,
    a: summaryA,
    b: summaryB,
    scoreCodeDiff: { ...toEstimate(diff), lowerOneSided: diff.lowerOneSided },
    passDiff: toEstimate(newcombe(summaryB.pass.c, summaryB.used, summaryA.pass.c, summaryA.used)),
    tokens: toEstimate(tokens),
    pBelow: tokens.pBelow,
    output: ratio('output'),
    cost: ratio('cost'),
    turns: ratio('turns'),
    wall: ratio('wall'),
    peak: ratio('peak'),
    cvRatio: toEstimate(
      pooledCvRatio(quantityCells(chains, cells, QUANTITIES.tokens), { reps, seed })
    )
  };
}

function badShare(cell: CellTrials): number {
  if (cell.all.length === 0) return NaN;
  return (
    cell.all.filter((trial) => BAD_CATEGORIES.includes(category(trial))).length / cell.all.length
  );
}

function verdictFor(
  rows: readonly ChainRow[],
  pooled: ChainRow,
  chains: readonly string[],
  cells: (chain: string) => { a: CellTrials; b: CellTrials },
  planned: number
): Verdict {
  const reasons: string[] = [];
  if (planned < PILOT_MAX_N) reasons.push(PILOT_REASON);
  const ratio = pooled.tokens;
  const outcome: Verdict['h1']['outcome'] =
    ratio.upper === undefined || ratio.lower === undefined || Number.isNaN(ratio.value)
      ? 'none'
      : ratio.upper < 1
        ? 'below'
        : ratio.lower > 1
          ? 'above'
          : 'covers';
  const h2Holds = pooled.scoreCodeDiff.lowerOneSided > -SCORE_MARGIN;
  const allA: CellTrials = {
    all: chains.flatMap((chain) => cells(chain).a.all),
    used: [],
    infra: []
  };
  const allB: CellTrials = {
    all: chains.flatMap((chain) => cells(chain).b.all),
    used: [],
    infra: []
  };
  const shareA = badShare(allA);
  const shareB = badShare(allB);
  const h3Holds = !(shareB - shareA > CATEGORY_MARGIN);

  for (const row of rows) {
    for (const side of ['a', 'b'] as const) {
      const summary = row[side];
      if (summary.used < planned) {
        reasons.push(
          `${row.chain} ${summary.condition}: ${summary.used} usable trials, planned ${planned}`
        );
      }
      if (summary.n > 0 && summary.excluded / summary.n > MAX_EXCLUDED_SHARE) {
        reasons.push(
          `${row.chain} ${summary.condition}: ${summary.excluded} of ${summary.n} trials flagged`
        );
      }
    }
  }
  if (outcome === 'none') reasons.push('no token ratio could be estimated');

  let verdict: Verdict['verdict'];
  if (reasons.length > 0) verdict = 'insufficient';
  else if (!h2Holds || !h3Holds || outcome === 'above') verdict = 'lose';
  else if (outcome === 'below') verdict = 'win';
  else verdict = 'tie';
  if (!h2Holds)
    reasons.push(
      `H2 fails: lower bound ${pooled.scoreCodeDiff.lowerOneSided.toFixed(3)} <= -${SCORE_MARGIN}`
    );
  if (!h3Holds)
    reasons.push(
      `H3 fails: bad-ending share B ${pct(shareB)} exceeds A ${pct(shareA)} by more than ${pct(CATEGORY_MARGIN)}`
    );
  return {
    verdict,
    h1: { ratio, outcome },
    h2: { lowerOneSided: pooled.scoreCodeDiff.lowerOneSided, margin: SCORE_MARGIN, holds: h2Holds },
    h3: { shareA, shareB, margin: CATEGORY_MARGIN, holds: h3Holds },
    plannedN: planned,
    reasons
  };
}

function foldMechanics(trials: readonly LoadedTrial[]): FoldMechanics {
  const folds = trials.flatMap((trial) => trial.metrics.folds);
  const recalls = trials.flatMap((trial) => trial.metrics.recalls);
  const forks = trials.flatMap((trial) => trial.metrics.forks);
  const firstFolds = trials.flatMap((trial) =>
    trial.metrics.timeToFirstFold ? [trial.metrics.timeToFirstFold] : []
  );
  const mechanics: FoldMechanics = {
    trials: trials.length,
    folds: folds.length,
    rejected: trials.reduce((sum, trial) => sum + trial.metrics.rejectedFolds.length, 0),
    notAlone: folds.filter((fold) => fold.notAlone).length,
    beforeFinalReply: folds.filter((fold) => fold.beforeFinalReply).length,
    under2k: folds.filter((fold) => fold.under2k).length,
    reminders: trials.reduce((sum, trial) => sum + trial.metrics.reminders, 0),
    recalls: {
      count: recalls.length,
      zeroHit: recalls.filter((recall) => recall.total === 0).length,
      regex: recalls.filter((recall) => recall.regex).length,
      quoted: recalls.filter((recall) => recall.quoted).length,
      stalenessLines: recalls.reduce((sum, recall) => sum + recall.stalenessLines, 0)
    },
    asks: trials.reduce((sum, trial) => sum + trial.metrics.asks.length, 0),
    forks: {
      count: forks.length,
      turns: forks.reduce((sum, fork) => sum + fork.turns, 0),
      foldsInside: forks.reduce((sum, fork) => sum + fork.folds, 0)
    },
    toolSchemaErrors: trials.reduce((sum, trial) => sum + trial.metrics.errors.toolSchema, 0)
  };
  if (folds.length > 0)
    mechanics.noteSpanRatioMedian = median(folds.map((fold) => fold.noteSpanRatio));
  if (firstFolds.length > 0) {
    mechanics.timeToFirstFoldMedianS = median(firstFolds.map((fold) => fold.seconds));
    mechanics.firstFoldRequestMedian = median(firstFolds.map((fold) => fold.requestIndex));
  }
  return mechanics;
}

function summarizeJudge(trials: readonly LoadedTrial[]): unknown {
  const judged = trials.filter((trial) => trial.judge !== undefined);
  if (judged.length === 0) return undefined;
  const rubrics: Record<string, { pass: number; total: number }> = {};
  for (const trial of judged) {
    const source = (trial.judge as { rubrics?: unknown }).rubrics;
    if (typeof source !== 'object' || source === null) continue;
    for (const [id, value] of Object.entries(source as Record<string, unknown>)) {
      const item = value as { pass?: unknown; total?: unknown };
      if (typeof item.pass !== 'number' || typeof item.total !== 'number') continue;
      const slot = rubrics[id] ?? { pass: 0, total: 0 };
      slot.pass += item.pass;
      slot.total += item.total;
      rubrics[id] = slot;
    }
  }
  return { trials: judged.length, rubrics };
}

export function conditionsOf(trials: readonly LoadedTrial[]): string[] {
  return [...new Set(trials.map((trial) => trial.trial.condition))].sort((x, y) =>
    x === 'A' ? -1 : y === 'A' ? 1 : x.localeCompare(y)
  );
}

export function modelsOf(trials: readonly LoadedTrial[]): string[] {
  return [...new Set(trials.map((trial) => trial.trial.model))].sort();
}

export function chainsOf(trials: readonly LoadedTrial[], manifest?: ManifestView): string[] {
  const seen = [...new Set(trials.map((trial) => trial.trial.chain))];
  const ordered = manifest?.config?.scenarios?.filter((chain) => seen.includes(chain)) ?? [];
  return [...ordered, ...seen.filter((chain) => !ordered.includes(chain)).sort()];
}

function modelReport(
  run: LoadedRun,
  model: string,
  conditionA: string,
  conditionB: string,
  chains: readonly string[],
  heldOut: readonly string[],
  reps: number,
  seed: number
): ModelReport {
  const cache = new Map<string, { a: CellTrials; b: CellTrials }>();
  const cells = (chain: string) => {
    let found = cache.get(chain);
    if (!found) {
      found = {
        a: cellOf(run.trials, model, conditionA, chain),
        b: cellOf(run.trials, model, conditionB, chain)
      };
      cache.set(chain, found);
    }
    return found;
  };
  for (const chain of chains) {
    assertSameAudit(`${model} ${conditionA} ${chain}`, cells(chain).a.all);
    assertSameAudit(`${model} ${conditionB} ${chain}`, cells(chain).b.all);
  }

  const rows = chains.map((chain, index) =>
    chainRow(
      chain,
      heldOut.includes(chain),
      cells(chain).a,
      cells(chain).b,
      conditionA,
      conditionB,
      reps,
      seed + index * 10
    )
  );
  const pooled = pooledRow(chains, cells, conditionA, conditionB, reps, seed);

  const variance: VarianceCell[] = rows.flatMap((row) => [
    { chain: row.chain, condition: conditionA, n: row.a.used, sdLog: row.a.sdLogTokens },
    { chain: row.chain, condition: conditionB, n: row.b.used, sdLog: row.b.sdLogTokens }
  ]);
  const variances = variance.map((cell) => cell.sdLog ** 2).filter((v) => Number.isFinite(v));
  const sdLogPooled = variances.length > 0 ? Math.sqrt(mean(variances)) : NaN;
  // The verdict's planned n is the n the run was planned with (DESIGN 8.4 sizes it from the
  // pilot before the grid, never below 10, so a smaller `runsPerCell` is a pilot and gets no
  // verdict); the post-hoc value from this run's SD is sizing advice for the next run and
  // goes into the variance note only. A manifest without `runsPerCell` (hand-made results)
  // falls back to the post-hoc value.
  const postHocN = plannedNFor(sdLogPooled, chains.length);
  const planned = run.manifest?.config?.runsPerCell ?? postHocN;
  const verdict = verdictFor(rows, pooled, chains, cells, planned);

  const trialsB = chains.flatMap((chain) => cells(chain).b.all);
  const suspectTokens: Record<string, number> = {};
  for (const condition of [conditionA, conditionB]) {
    suspectTokens[condition] = chains
      .flatMap((chain) => cells(chain)[condition === conditionA ? 'a' : 'b'].all)
      .filter((trial) => trial.metrics.tokenBasis === 'suspect').length;
  }
  const report: ModelReport = {
    model,
    conditionA,
    conditionB,
    rows,
    pooled,
    verdict,
    variance: { cells: variance, sdLogPooled, plannedN: postHocN },
    foldMechanics: foldMechanics(trialsB),
    suspectTokens
  };
  // `manifest.promptIds` is keyed by the condition id (`B`), trials by `B@<prompt-id>`.
  const promptId =
    run.manifest?.promptIds?.[conditionB.split('@')[0]!] ?? trialsB[0]?.trial.audit?.promptId;
  if (promptId !== undefined) report.promptId = promptId;
  const judge = summarizeJudge(
    chains.flatMap((chain) => [...cells(chain).a.all, ...cells(chain).b.all])
  );
  if (judge !== undefined) report.judge = judge;
  return report;
}

// ---------------------------------------------------------------------------
// --compare
// ---------------------------------------------------------------------------

function compareRow(
  chain: string,
  heldOut: boolean,
  mine: CellTrials,
  other: CellTrials,
  reps: number,
  seed: number
): CompareRow {
  const tokens = bootstrapRatioOfGeomeans(
    positive(other.used.map((trial) => trial.metrics.contextAttended)),
    positive(mine.used.map((trial) => trial.metrics.contextAttended)),
    { reps, seed }
  );
  const scores = (trials: LoadedTrial[]) =>
    trials.map(scoreCodeOf).filter((score): score is number => score !== undefined);
  const diff = meanDiffCI(scores(other.used), scores(mine.used), { reps, seed });
  const passes = (trials: LoadedTrial[]) =>
    trials.map(passOf).filter((pass): pass is boolean => pass !== undefined);
  const pow3 = (trials: LoadedTrial[]) => {
    const p = passes(trials);
    return passPowK(p.filter(Boolean).length, p.length, 3);
  };
  const foldsPerRun = (trials: LoadedTrial[]) =>
    trials.length > 0 ? mean(trials.map((trial) => trial.metrics.folds.length)) : NaN;
  const row: CompareRow = {
    chain,
    heldOut,
    nThis: mine.used.length,
    nOther: other.used.length,
    tokens: toEstimate(tokens),
    pBelow: tokens.pBelow,
    scoreCodeDiff: { ...toEstimate(diff), lowerOneSided: diff.lowerOneSided },
    foldsPerRun: { this: foldsPerRun(mine.used), other: foldsPerRun(other.used) },
    passPow3: {}
  };
  const mineP = pow3(mine.used);
  const otherP = pow3(other.used);
  if (mineP !== undefined) row.passPow3.this = mineP;
  if (otherP !== undefined) row.passPow3.other = otherP;
  return row;
}

function pooledCompare(
  rows: readonly CompareRow[],
  cells: readonly { chain: string; mine: CellTrials; other: CellTrials }[],
  reps: number,
  seed: number
): CompareRow | undefined {
  if (cells.length === 0) return undefined;
  const tokens = pooledLogRatio(
    cells.map((cell) => ({
      chain: cell.chain,
      b: positive(cell.other.used.map((trial) => trial.metrics.contextAttended)),
      a: positive(cell.mine.used.map((trial) => trial.metrics.contextAttended))
    })),
    { reps, seed }
  );
  const scores = (trials: LoadedTrial[]) =>
    trials.map(scoreCodeOf).filter((score): score is number => score !== undefined);
  const diff = pooledMeanDiff(
    cells.map((cell) => ({
      chain: cell.chain,
      b: scores(cell.other.used),
      a: scores(cell.mine.used)
    })),
    { reps, seed }
  );
  const sum = (pick: (row: CompareRow) => number) =>
    rows.reduce((total, row) => total + pick(row), 0);
  const row: CompareRow = {
    chain: 'pooled',
    heldOut: rows.every((row) => row.heldOut),
    nThis: sum((row) => row.nThis),
    nOther: sum((row) => row.nOther),
    tokens: toEstimate(tokens),
    pBelow: tokens.pBelow,
    scoreCodeDiff: { ...toEstimate(diff), lowerOneSided: diff.lowerOneSided },
    foldsPerRun: {
      this: mean(rows.map((row) => row.foldsPerRun.this).filter(Number.isFinite)),
      other: mean(rows.map((row) => row.foldsPerRun.other).filter(Number.isFinite))
    },
    passPow3: {}
  };
  const mineP = rows.map((r) => r.passPow3.this).filter((p): p is number => p !== undefined);
  const otherP = rows.map((r) => r.passPow3.other).filter((p): p is number => p !== undefined);
  if (mineP.length > 0) row.passPow3.this = mean(mineP);
  if (otherP.length > 0) row.passPow3.other = mean(otherP);
  return row;
}

function compareRuns(
  mine: LoadedRun,
  other: LoadedRun,
  heldOut: readonly string[],
  reps: number,
  seed: number
): CompareModel[] {
  const models = modelsOf(mine.trials).filter((model) => modelsOf(other.trials).includes(model));
  const bOf = (run: LoadedRun) => conditionsOf(run.trials).find((condition) => condition !== 'A');
  const conditionThis = bOf(mine);
  const conditionOther = bOf(other);
  if (conditionThis === undefined || conditionOther === undefined) {
    throw new ReportError('--compare needs a B condition in both runs');
  }
  return models.map((model) => {
    const chains = chainsOf(mine.trials, mine.manifest).filter((chain) =>
      chainsOf(other.trials).includes(chain)
    );
    const cells = chains.map((chain) => {
      const cell = {
        chain,
        mine: cellOf(mine.trials, model, conditionThis, chain),
        other: cellOf(other.trials, model, conditionOther, chain)
      };
      assertSameAudit(`${model} ${conditionThis} ${chain} (this run)`, cell.mine.all);
      assertSameAudit(`${model} ${conditionOther} ${chain} (compare run)`, cell.other.all);
      return cell;
    });
    const rows = cells.map((cell, index) =>
      compareRow(
        cell.chain,
        heldOut.includes(cell.chain),
        cell.mine,
        cell.other,
        reps,
        seed + index
      )
    );
    const tuning = cells.filter((cell) => !heldOut.includes(cell.chain));
    const held = cells.filter((cell) => heldOut.includes(cell.chain));
    const pooledTuning = pooledCompare(
      rows.filter((row) => !row.heldOut),
      tuning,
      reps,
      seed
    );
    const pooledHeldOut = pooledCompare(
      rows.filter((row) => row.heldOut),
      held,
      reps,
      seed
    );
    const result: CompareModel = { model, conditionThis, conditionOther, rows };
    if (pooledTuning) result.pooledTuning = pooledTuning;
    if (pooledHeldOut) result.pooledHeldOut = pooledHeldOut;
    if (
      pooledTuning &&
      pooledHeldOut &&
      Number.isFinite(pooledTuning.tokens.value) &&
      Number.isFinite(pooledHeldOut.tokens.value)
    ) {
      result.heldOutAgrees =
        Math.sign(Math.log(pooledTuning.tokens.value)) ===
        Math.sign(Math.log(pooledHeldOut.tokens.value));
    }
    return result;
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildReport(runDir: string, options: BuildReportOptions = {}): BuiltReport {
  const reps = options.reps ?? 10000;
  const seed = options.seed ?? 1;
  const run = loadRun(runDir);
  if (run.trials.length === 0) throw new ReportError(`no trials with results under ${runDir}`);
  const heldOut = run.manifest?.config?.heldOut ?? DEFAULT_HELD_OUT;
  const conditions = conditionsOf(run.trials);
  const conditionA = conditions.find((condition) => condition === 'A');
  if (conditionA === undefined) throw new ReportError('no condition A among the trials');
  const conditionsB = conditions.filter((condition) => condition !== conditionA);
  if (conditionsB.length === 0) throw new ReportError('no B condition among the trials');
  const chains = chainsOf(run.trials, run.manifest);

  const models: ModelReport[] = [];
  for (const model of modelsOf(run.trials)) {
    for (const conditionB of conditionsB) {
      models.push(modelReport(run, model, conditionA, conditionB, chains, heldOut, reps, seed));
    }
  }
  const report: ReportJson = {
    runId: run.runId,
    generatedAt: new Date().toISOString(),
    heldOut: [...heldOut],
    conditions,
    models
  };
  const warnings = [...run.warnings];
  if (options.compare !== undefined) {
    const other = loadRun(options.compare);
    warnings.push(...other.warnings.map((warning) => `compare: ${warning}`));
    report.compare = { runId: other.runId, models: compareRuns(run, other, heldOut, reps, seed) };
  }
  return { report, markdown: renderMarkdown(report, run), trials: run.trials, warnings };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function num(value: number | undefined, digits = 2): string {
  return value === undefined || !Number.isFinite(value) ? '-' : value.toFixed(digits);
}

function pct(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : '-';
}

function interval(estimate: Estimate, digits = 2): string {
  if (!Number.isFinite(estimate.value)) return '-';
  const bounds =
    estimate.lower !== undefined && estimate.upper !== undefined && Number.isFinite(estimate.lower)
      ? ` [${num(estimate.lower, digits)}, ${num(estimate.upper, digits)}]`
      : '';
  return `${num(estimate.value, digits)}${bounds}`;
}

function pair(a: string, b: string): string {
  return `${a} / ${b}`;
}

function passText(summary: ConditionSummary): string {
  if (summary.used === 0) return '-';
  return `${summary.pass.c}/${summary.used} [${num(summary.pass.lower)}, ${num(summary.pass.upper)}]`;
}

function categoriesText(summary: ConditionSummary): string {
  const entries = Object.entries(summary.categories).sort(([x], [y]) => x.localeCompare(y));
  return entries.length > 0 ? entries.map(([kind, count]) => `${kind} ${count}`).join(', ') : '-';
}

export const TABLE_HEADER = [
  'chain',
  'n_A/n_B',
  'score_code A/B',
  'pass A/B',
  'tokens attended ratio',
  'P(B<A)',
  'output ratio',
  'cost ratio',
  'turns ratio',
  'wall ratio',
  'peak ratio',
  'cache hit A/B',
  'CV ratio',
  'pass^3 A/B',
  'flip A/B',
  'folds/recalls/asks/forks per B run',
  'compactions A/B',
  'categories A/B'
];

function rowCells(row: ChainRow): string[] {
  const episodes = row.b.episodes;
  return [
    row.pooled ? '**pooled**' : row.heldOut ? `${row.chain} (held out)` : row.chain,
    pair(String(row.a.used), String(row.b.used)) +
      (row.a.excluded + row.b.excluded > 0
        ? ` (+${row.a.excluded}/${row.b.excluded} flagged)`
        : '') +
      (row.a.infra + row.b.infra > 0 ? ` (+${row.a.infra}/${row.b.infra} infra)` : ''),
    pair(interval(row.a.scoreCode), interval(row.b.scoreCode)),
    pair(passText(row.a), passText(row.b)),
    interval(row.tokens),
    num(row.pBelow),
    interval(row.output),
    interval(row.cost),
    interval(row.turns),
    interval(row.wall),
    interval(row.peak),
    pair(num(row.a.cacheHit), num(row.b.cacheHit)),
    interval(row.cvRatio),
    pair(num(row.a.passPow3), num(row.b.passPow3)),
    pair(num(row.a.flip), num(row.b.flip)),
    [episodes.folds, episodes.recalls, episodes.asks, episodes.forks]
      .map((value) => num(value, 1))
      .join('/'),
    pair(num(row.a.compactions, 1), num(row.b.compactions, 1)),
    pair(categoriesText(row.a), categoriesText(row.b))
  ];
}

function table(header: readonly string[], rows: readonly string[][]): string {
  const line = (cells: readonly string[]) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

function verdictLine(verdict: Verdict): string {
  const h1 = `H1 tokens ratio ${interval(verdict.h1.ratio)} (${verdict.h1.outcome === 'below' ? 'upper bound < 1' : verdict.h1.outcome === 'above' ? 'lower bound > 1' : verdict.h1.outcome === 'covers' ? 'covers 1' : 'not estimable'})`;
  const h2 = `H2 score_code lower bound ${num(verdict.h2.lowerOneSided, 3)} vs -${verdict.h2.margin} (${verdict.h2.holds ? 'holds' : 'fails'})`;
  const h3 = `H3 bad endings A ${pct(verdict.h3.shareA)} B ${pct(verdict.h3.shareB)} (${verdict.h3.holds ? 'holds' : 'fails'})`;
  const reasons = verdict.reasons.length > 0 ? ` Reasons: ${verdict.reasons.join('; ')}.` : '';
  return `**Verdict: ${verdict.verdict}.** ${h1}; ${h2}; ${h3}; planned n per cell ${verdict.plannedN}.${reasons}`;
}

function mechanicsBlock(m: FoldMechanics): string {
  const share = (count: number) =>
    m.folds > 0 ? `${count} (${pct(count / m.folds)})` : String(count);
  const lines = [
    `- B trials: ${m.trials}; folds: ${m.folds} (${num(m.trials > 0 ? m.folds / m.trials : NaN, 1)} per run); rejected: ${m.rejected}`,
    `- folds not alone in their response: ${share(m.notAlone)}; right before a final reply: ${share(m.beforeFinalReply)}; under 2k tokens: ${share(m.under2k)}`,
    `- note/span ratio median: ${num(m.noteSpanRatioMedian, 3)}; time to first fold median: ${num(m.timeToFirstFoldMedianS, 0)} s at request ${num(m.firstFoldRequestMedian, 0)}`,
    `- recalls: ${m.recalls.count} (zero-hit ${m.recalls.zeroHit}, regex ${m.recalls.regex}, quoted ${m.recalls.quoted}, staleness lines ${m.recalls.stalenessLines}); asks: ${m.asks}; forks: ${m.forks.count} (${m.forks.turns} child turns, ${m.forks.foldsInside} folds inside)`,
    `- open-item reminders: ${m.reminders}; tool schema errors: ${m.toolSchemaErrors}`
  ];
  return lines.join('\n');
}

function categoryTable(report: ModelReport): string {
  const kinds: TrialCategory[] = [
    'passed',
    'checks_failed',
    'build_broken',
    'timeout',
    'turn_cap',
    'context_overflow',
    'stopped_early',
    'flagged',
    'infra'
  ];
  const rows = [report.pooled.a, report.pooled.b].map((summary) => [
    summary.condition,
    ...kinds.map((kind) => String(summary.categories[kind] ?? 0)),
    String(summary.terminalErrors)
  ]);
  const lines = [table(['condition', ...kinds, 'terminal errors'], rows)];
  const infra = [report.pooled.a, report.pooled.b].flatMap((summary) => summary.infraErrors);
  if (infra.length > 0) {
    lines.push(
      '',
      'Infra trials (outside every denominator, DESIGN 5.6):',
      '',
      ...infra.map((line) => `- ${line}`)
    );
  }
  return lines.join('\n');
}

function compareBlock(model: CompareModel): string {
  const header = [
    'chain',
    'set',
    'n this/other',
    'tokens ratio other/this',
    'P(other<this)',
    'score_code diff other-this',
    'pass^3 this/other',
    'folds per run this/other'
  ];
  const cells = (row: CompareRow, set: string) => [
    row.chain,
    set,
    pair(String(row.nThis), String(row.nOther)),
    interval(row.tokens),
    num(row.pBelow),
    `${interval(row.scoreCodeDiff)} (lower ${num(row.scoreCodeDiff.lowerOneSided, 3)})`,
    pair(num(row.passPow3.this), num(row.passPow3.other)),
    pair(num(row.foldsPerRun.this, 1), num(row.foldsPerRun.other, 1))
  ];
  const rows = model.rows.map((row) => cells(row, row.heldOut ? 'held-out' : 'tuning'));
  if (model.pooledTuning)
    rows.push(cells({ ...model.pooledTuning, chain: '**pooled tuning**' }, 'tuning'));
  if (model.pooledHeldOut)
    rows.push(cells({ ...model.pooledHeldOut, chain: '**pooled held-out**' }, 'held-out'));
  const agrees =
    model.heldOutAgrees === undefined
      ? 'Held-out agreement: not computable (a set has no data).'
      : `Held-out chains agree in sign with the tuning chains: ${model.heldOutAgrees ? 'yes' : 'no'}.`;
  return `${table(header, rows)}\n\n${agrees}`;
}

export function renderMarkdown(report: ReportJson, run?: LoadedRun): string {
  const out: string[] = [`# Benchmark report: ${report.runId}`, ''];
  out.push(
    `Generated ${report.generatedAt}. Conditions: ${report.conditions.join(', ')}. Held-out chains: ${report.heldOut.join(', ') || 'none'}.`
  );
  if (run?.manifest?.piVersion) out.push(`pi ${run.manifest.piVersion}.`);
  out.push('');
  out.push(
    "Ratios are B/A geometric means with 95% percentile bootstrap intervals over runs within each cell; the pooled row uses chain fixed effects. `score_code` is the mean with its bootstrap interval; `pass` is c/n with a Wilson interval. Flagged trials are excluded from every estimate and counted in the categories; infra trials are excluded from everything and listed under the category table. `terminal errors` counts provider errors other than 429/5xx that ended a step (the trial went on and the checks decided its category). The planned n per cell is the run's `runsPerCell` (the formula of DESIGN 8.4 applied to this run's SD is in the variance note as sizing advice); a run planned below 10 per cell is a pilot and gets no verdict."
  );
  for (const model of report.models) {
    out.push(
      '',
      `## ${model.model}: ${model.conditionA} vs ${model.conditionB}${model.promptId ? ` (prompt ${model.promptId})` : ''}`,
      ''
    );
    out.push(table(TABLE_HEADER, [...model.rows, model.pooled].map(rowCells)), '');
    out.push(verdictLine(model.verdict), '');
    const cells = model.variance.cells
      .map((cell) => `${cell.chain} ${cell.condition}: ${num(cell.sdLog)} (n=${cell.n})`)
      .join('; ');
    out.push(
      `Variance note: SD of log context_attended per cell: ${cells}. Pooled within-cell SD ${num(model.variance.sdLogPooled)}; n per cell this SD asks for to detect a 30% token reduction (sizing for the next run): ${model.variance.plannedN}.`,
      ''
    );
    const suspect = Object.entries(model.suspectTokens).filter(([, count]) => count > 0);
    if (suspect.length > 0) {
      out.push(
        `Token basis suspect (usage invariant failed) in: ${suspect.map(([condition, count]) => `${condition} ${count}`).join(', ')}.`,
        ''
      );
    }
    out.push('### Fold mechanics (B)', '', mechanicsBlock(model.foldMechanics), '');
    out.push('### Categories', '', categoryTable(model), '');
    out.push('### Judge', '');
    if (model.judge === undefined) {
      out.push('No judge.json in this run; run `bench judge` to fill this block.', '');
    } else {
      const judge = model.judge as {
        trials: number;
        rubrics: Record<string, { pass: number; total: number }>;
      };
      const rubrics = Object.entries(judge.rubrics).map(
        ([id, value]) => `${id} ${value.pass}/${value.total}`
      );
      out.push(
        `${judge.trials} judged trials. ${rubrics.length > 0 ? rubrics.join(', ') : 'No rubric totals found.'}`,
        ''
      );
    }
  }
  if (report.compare) {
    out.push('', `## Comparison with ${report.compare.runId}`, '');
    for (const model of report.compare.models) {
      out.push(
        `### ${model.model}: ${model.conditionThis} (this) vs ${model.conditionOther} (other)`,
        '',
        compareBlock(model),
        ''
      );
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}
