/**
 * Estimators from DESIGN 8: percentile bootstrap over runs within a cell, chain fixed effects
 * for pooling, Wilson and Newcombe for proportions, tau-bench pass^k, flip rate. Pure
 * functions; every bootstrap takes a seed so results are reproducible.
 */

export interface BootstrapOptions {
  /** Resamples. Default 10000. */
  reps?: number;
  seed?: number;
  /** Two-sided level for `lower`/`upper`. Default 0.95. */
  level?: number;
}

export interface Interval {
  value: number;
  lower: number;
  upper: number;
}

export interface RatioEstimate extends Interval {
  /** Share of (b, a) pairs with b < a. */
  pBelow: number;
  nB: number;
  nA: number;
}

export interface DiffEstimate extends Interval {
  /** One-sided lower bound at `alpha` (DESIGN H2). */
  lowerOneSided: number;
  nB: number;
  nA: number;
}

export interface Cell<T = number[]> {
  chain: string;
  b: T;
  a: T;
}

export interface PooledEstimate<P> extends Interval {
  perChain: P[];
  chains: number;
}

const DEFAULT_REPS = 10000;

/** mulberry32: small, seedable, good enough for resampling indices. */
export function createRng(seed = 1): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draw (Box-Muller), for synthetic data in tests. */
export function normal(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Sample standard deviation (n - 1). */
export function sd(values: readonly number[]): number {
  if (values.length < 2) return NaN;
  const m = mean(values);
  let sum = 0;
  for (const value of values) sum += (value - m) ** 2;
  return Math.sqrt(sum / (values.length - 1));
}

export function geomean(values: readonly number[]): number {
  return Math.exp(mean(values.map(Math.log)));
}

/** SD of log values: the spread the n planning uses. */
export function logSd(values: readonly number[]): number {
  return sd(values.map(Math.log));
}

export function cv(values: readonly number[]): number {
  return sd(values) / mean(values);
}

/** Linear-interpolated quantile of a sorted array, `p` in [0, 1]. */
export function quantileSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position);
  const high = Math.min(low + 1, sorted.length - 1);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
}

export function quantile(values: readonly number[], p: number): number {
  return quantileSorted(
    [...values].sort((x, y) => x - y),
    p
  );
}

export function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

function resample(values: readonly number[], rng: () => number, into: number[]): number[] {
  for (let i = 0; i < values.length; i++) into[i] = values[Math.floor(rng() * values.length)]!;
  return into;
}

/**
 * Bootstrap of a statistic over cells: the estimate is the mean over chains of
 * `statistic(b, a)` (chain fixed effects), the interval the percentile interval from
 * resampling runs within every cell. Cells where either side is empty are skipped.
 */
export function pooledBootstrap(
  cells: readonly Cell[],
  statistic: (b: readonly number[], a: readonly number[]) => number,
  options: BootstrapOptions = {}
): { value: number; lower: number; upper: number; draws: number[]; used: Cell[] } {
  const used = cells.filter((cell) => cell.b.length > 0 && cell.a.length > 0);
  if (used.length === 0) return { value: NaN, lower: NaN, upper: NaN, draws: [], used };
  const reps = options.reps ?? DEFAULT_REPS;
  const level = options.level ?? 0.95;
  const rng = createRng(options.seed ?? 1);
  const value = mean(used.map((cell) => statistic(cell.b, cell.a)));
  const draws = new Array<number>(reps);
  const buffersB = used.map((cell) => new Array<number>(cell.b.length));
  const buffersA = used.map((cell) => new Array<number>(cell.a.length));
  for (let r = 0; r < reps; r++) {
    let sum = 0;
    for (let c = 0; c < used.length; c++) {
      const cell = used[c]!;
      sum += statistic(resample(cell.b, rng, buffersB[c]!), resample(cell.a, rng, buffersA[c]!));
    }
    draws[r] = sum / used.length;
  }
  draws.sort((x, y) => x - y);
  return {
    value,
    lower: quantileSorted(draws, (1 - level) / 2),
    upper: quantileSorted(draws, 1 - (1 - level) / 2),
    draws,
    used
  };
}

function logRatioStatistic(b: readonly number[], a: readonly number[]): number {
  return mean(b.map(Math.log)) - mean(a.map(Math.log));
}

function meanDiffStatistic(b: readonly number[], a: readonly number[]): number {
  return mean(b) - mean(a);
}

function logCvRatioStatistic(b: readonly number[], a: readonly number[]): number {
  return Math.log(cv(b)) - Math.log(cv(a));
}

export function pBelow(b: readonly number[], a: readonly number[]): number {
  if (b.length === 0 || a.length === 0) return NaN;
  let count = 0;
  for (const x of b) for (const y of a) if (x < y) count++;
  return count / (b.length * a.length);
}

/** Ratio of geometric means B/A with a percentile bootstrap interval and P(B < A). */
export function bootstrapRatioOfGeomeans(
  b: readonly number[],
  a: readonly number[],
  options: BootstrapOptions = {}
): RatioEstimate {
  const boot = pooledBootstrap([{ chain: '', b: [...b], a: [...a] }], logRatioStatistic, options);
  return {
    value: Math.exp(boot.value),
    lower: Math.exp(boot.lower),
    upper: Math.exp(boot.upper),
    pBelow: pBelow(b, a),
    nB: b.length,
    nA: a.length
  };
}

export interface PooledRatio extends PooledEstimate<RatioEstimate & { chain: string }> {
  /** Mean over chains of P(B < A). */
  pBelow: number;
}

/** Pooled per model: mean over chains of the per-chain log ratio, CI by resampling runs within cells. */
export function pooledLogRatio(
  cells: readonly Cell[],
  options: BootstrapOptions = {}
): PooledRatio {
  const boot = pooledBootstrap(cells, logRatioStatistic, options);
  const perChain = boot.used.map((cell, index) => ({
    chain: cell.chain,
    ...bootstrapRatioOfGeomeans(cell.b, cell.a, {
      ...options,
      seed: (options.seed ?? 1) + index + 1
    })
  }));
  return {
    value: Math.exp(boot.value),
    lower: Math.exp(boot.lower),
    upper: Math.exp(boot.upper),
    perChain,
    chains: boot.used.length,
    pBelow: perChain.length > 0 ? mean(perChain.map((chain) => chain.pBelow)) : NaN
  };
}

/** Mean difference B - A with a percentile bootstrap interval. */
export function meanDiffCI(
  b: readonly number[],
  a: readonly number[],
  options: BootstrapOptions & { alpha?: number } = {}
): DiffEstimate {
  const boot = pooledBootstrap([{ chain: '', b: [...b], a: [...a] }], meanDiffStatistic, options);
  return {
    value: boot.value,
    lower: boot.lower,
    upper: boot.upper,
    lowerOneSided: quantileSorted(boot.draws, options.alpha ?? 0.05),
    nB: b.length,
    nA: a.length
  };
}

/** Percentile bootstrap interval of a single mean. */
export function meanCI(values: readonly number[], options: BootstrapOptions = {}): Interval {
  if (values.length === 0) return { value: NaN, lower: NaN, upper: NaN };
  const boot = pooledBootstrap([{ chain: '', b: [...values], a: [0] }], meanDiffStatistic, options);
  return { value: boot.value, lower: boot.lower, upper: boot.upper };
}

/** One-sided (1 - alpha) lower bound of mean(b) - mean(a), the H2 guardrail quantity. */
export function nonInferiorityLowerBound(
  b: readonly number[],
  a: readonly number[],
  alpha = 0.05,
  options: BootstrapOptions = {}
): number {
  return meanDiffCI(b, a, { ...options, alpha }).lowerOneSided;
}

export type PooledDiff = PooledEstimate<DiffEstimate & { chain: string }> & {
  lowerOneSided: number;
};

export function pooledMeanDiff(
  cells: readonly Cell[],
  options: BootstrapOptions & { alpha?: number } = {}
): PooledDiff {
  const boot = pooledBootstrap(cells, meanDiffStatistic, options);
  return {
    value: boot.value,
    lower: boot.lower,
    upper: boot.upper,
    lowerOneSided: quantileSorted(boot.draws, options.alpha ?? 0.05),
    perChain: boot.used.map((cell, index) => ({
      chain: cell.chain,
      ...meanDiffCI(cell.b, cell.a, { ...options, seed: (options.seed ?? 1) + index + 1 })
    })),
    chains: boot.used.length
  };
}

/** Below this many per side a resample often has every value equal (CV 0, log -Infinity); no interval then. */
const CV_INTERVAL_MIN_N = 5;

/** Ratio of coefficients of variation B/A (predictability), bootstrap interval; needs n >= 2 each. */
export function cvRatio(
  b: readonly number[],
  a: readonly number[],
  options: BootstrapOptions = {}
): Interval {
  if (b.length < 2 || a.length < 2) return { value: NaN, lower: NaN, upper: NaN };
  const value = Math.exp(logCvRatioStatistic(b, a));
  if (b.length < CV_INTERVAL_MIN_N || a.length < CV_INTERVAL_MIN_N) {
    return { value, lower: NaN, upper: NaN };
  }
  const boot = pooledBootstrap([{ chain: '', b: [...b], a: [...a] }], logCvRatioStatistic, options);
  return { value, lower: Math.exp(boot.lower), upper: Math.exp(boot.upper) };
}

export function pooledCvRatio(
  cells: readonly Cell[],
  options: BootstrapOptions = {}
): PooledEstimate<Interval & { chain: string }> {
  const usable = cells.filter((cell) => cell.b.length >= 2 && cell.a.length >= 2);
  const boot = pooledBootstrap(usable, logCvRatioStatistic, options);
  return {
    value: Math.exp(boot.value),
    lower: Math.exp(boot.lower),
    upper: Math.exp(boot.upper),
    perChain: boot.used.map((cell, index) => ({
      chain: cell.chain,
      ...cvRatio(cell.b, cell.a, { ...options, seed: (options.seed ?? 1) + index + 1 })
    })),
    chains: boot.used.length
  };
}

// ---------------------------------------------------------------------------
// Proportions and reliability
// ---------------------------------------------------------------------------

export interface Proportion extends Interval {
  c: number;
  n: number;
}

/** Wilson score interval for c successes in n trials. */
export function wilson(c: number, n: number, z = 1.959964): Proportion {
  if (n === 0) return { value: NaN, lower: NaN, upper: NaN, c, n };
  const p = c / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  // The bounds are exactly 0 and 1 at the edges; rounding would otherwise leave 0.999...
  return {
    value: p,
    lower: c === 0 ? 0 : Math.max(0, centre - half),
    upper: c === n ? 1 : Math.min(1, centre + half),
    c,
    n
  };
}

/** Newcombe's hybrid score interval for p1 - p2 (method 10 in Newcombe 1998). */
export function newcombe(c1: number, n1: number, c2: number, n2: number, z = 1.959964): Interval {
  if (n1 === 0 || n2 === 0) return { value: NaN, lower: NaN, upper: NaN };
  const w1 = wilson(c1, n1, z);
  const w2 = wilson(c2, n2, z);
  const diff = w1.value - w2.value;
  return {
    value: diff,
    lower: diff - Math.sqrt((w1.value - w1.lower) ** 2 + (w2.upper - w2.value) ** 2),
    upper: diff + Math.sqrt((w1.upper - w1.value) ** 2 + (w2.value - w2.lower) ** 2)
  };
}

export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
  return Math.round(result);
}

/** tau-bench pass^k: C(c, k) / C(n, k), the chance that k runs drawn without replacement all pass. */
export function passPowK(c: number, n: number, k: number): number | undefined {
  if (n < k || k < 0) return undefined;
  return choose(c, k) / choose(n, k);
}

/** tau-bench's pooled estimator: mean over cells of pass^k, cells with n < k skipped. */
export function pooledPassPowK(
  cells: readonly { c: number; n: number }[],
  k: number
): number | undefined {
  const values = cells.map((cell) => passPowK(cell.c, cell.n, k)).filter((v) => v !== undefined);
  return values.length > 0 ? mean(values) : undefined;
}

/** rerun-bench flip rate: the chance two runs drawn without replacement disagree. */
export function flipRate(c: number, n: number): number | undefined {
  if (n < 2) return undefined;
  return (2 * c * (n - c)) / (n * (n - 1));
}

/** Holm step-down adjusted p-values, same order as the input. */
export function holm(pvalues: readonly number[]): number[] {
  const order = pvalues.map((p, index) => ({ p, index })).sort((x, y) => x.p - y.p);
  const adjusted = new Array<number>(pvalues.length);
  let running = 0;
  order.forEach(({ p, index }, rank) => {
    running = Math.max(running, Math.min(1, (pvalues.length - rank) * p));
    adjusted[index] = running;
  });
  return adjusted;
}

/**
 * Runs per cell to detect a token ratio at 80% power, two-sided 5%, with `chains` strata:
 * `clamp(ceil(15.7 * sd^2 / (S * ln(1/ratio)^2)), 10, 20)` (DESIGN 8.4).
 */
export function plannedN(sdLog: number, chains: number, ratio = 0.7): number {
  if (!Number.isFinite(sdLog) || chains <= 0) return 10;
  const n = Math.ceil((15.7 * sdLog * sdLog) / (chains * Math.log(1 / ratio) ** 2));
  return Math.min(20, Math.max(10, n));
}
