import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bootstrapRatioOfGeomeans,
  choose,
  createRng,
  cvRatio,
  flipRate,
  geomean,
  holm,
  logSd,
  meanCI,
  meanDiffCI,
  newcombe,
  nonInferiorityLowerBound,
  normal,
  passPowK,
  pBelow,
  plannedN,
  pooledLogRatio,
  pooledMeanDiff,
  pooledPassPowK,
  quantile,
  sd,
  wilson
} from '../src/stats.js';

test('the seeded rng is deterministic and uniform-ish', () => {
  const a = createRng(42);
  const b = createRng(42);
  const draws = Array.from({ length: 1000 }, () => a());
  assert.deepEqual(
    draws.slice(0, 5),
    Array.from({ length: 5 }, () => b())
  );
  assert.ok(draws.every((x) => x >= 0 && x < 1));
  const m = draws.reduce((s, x) => s + x, 0) / draws.length;
  assert.ok(Math.abs(m - 0.5) < 0.05);
});

test('bootstrap ratio of geometric means covers the true ratio at least 94% of 200 replications', () => {
  // Log-normal tokens: A ~ exp(N(12, 0.5)), B = 0.7 x A in distribution; n = 20 per arm.
  const rng = createRng(7);
  const trueRatio = 0.7;
  let covered = 0;
  const replications = 200;
  for (let r = 0; r < replications; r++) {
    const a = Array.from({ length: 20 }, () => Math.exp(12 + 0.5 * normal(rng)));
    const b = Array.from({ length: 20 }, () => trueRatio * Math.exp(12 + 0.5 * normal(rng)));
    const estimate = bootstrapRatioOfGeomeans(b, a, { reps: 1000, seed: r + 1 });
    if (estimate.lower <= trueRatio && trueRatio <= estimate.upper) covered++;
    assert.ok(estimate.lower <= estimate.value && estimate.value <= estimate.upper);
  }
  assert.ok(covered / replications >= 0.94, `coverage ${covered / replications}`);
});

test('ratio and P(B<A) on a deterministic sample', () => {
  const a = [100, 200, 400];
  const b = [50, 100, 200];
  const estimate = bootstrapRatioOfGeomeans(b, a, { reps: 500, seed: 3 });
  assert.ok(Math.abs(estimate.value - 0.5) < 1e-12);
  assert.ok(estimate.lower <= 0.5 && 0.5 <= estimate.upper);
  assert.equal(estimate.pBelow, pBelow(b, a));
  assert.equal(pBelow(b, a), 6 / 9);
  assert.equal(estimate.nA, 3);
  assert.equal(estimate.nB, 3);
  assert.ok(Math.abs(geomean([1, 100]) - 10) < 1e-12);
});

test('pooled log ratio is the mean of per-chain log ratios with chain fixed effects', () => {
  const cells = [
    { chain: 'x', a: [100, 100, 100, 100], b: [50, 50, 50, 50] },
    { chain: 'y', a: [1000, 1000, 1000, 1000], b: [2000, 2000, 2000, 2000] },
    { chain: 'empty', a: [], b: [10] }
  ];
  const pooled = pooledLogRatio(cells, { reps: 300, seed: 5 });
  // exp(mean(log 0.5, log 2)) = 1; constant cells give a degenerate interval.
  assert.ok(Math.abs(pooled.value - 1) < 1e-12);
  assert.ok(Math.abs(pooled.lower - 1) < 1e-12 && Math.abs(pooled.upper - 1) < 1e-12);
  assert.equal(pooled.chains, 2);
  assert.deepEqual(
    pooled.perChain.map((chain) => [chain.chain, Number(chain.value.toFixed(9))]),
    [
      ['x', 0.5],
      ['y', 2]
    ]
  );
  assert.equal(pooled.pBelow, 0.5);
});

test('mean difference, one-sided bound and pooled difference', () => {
  const b = [0.8, 0.9, 1.0, 0.7];
  const a = [0.9, 1.0, 0.8, 0.9];
  const diff = meanDiffCI(b, a, { reps: 2000, seed: 11 });
  assert.ok(Math.abs(diff.value - (0.85 - 0.9)) < 1e-12);
  assert.ok(diff.lower <= diff.value && diff.value <= diff.upper);
  assert.ok(diff.lowerOneSided >= diff.lower);
  assert.ok(diff.lowerOneSided <= diff.value);
  assert.equal(nonInferiorityLowerBound(b, a, 0.05, { reps: 2000, seed: 11 }), diff.lowerOneSided);

  const pooled = pooledMeanDiff(
    [
      { chain: 'x', b, a },
      { chain: 'y', b: [1, 1], a: [0.5, 0.5] }
    ],
    { reps: 500, seed: 2 }
  );
  assert.ok(Math.abs(pooled.value - (-0.05 + 0.5) / 2) < 1e-12);
  assert.equal(pooled.perChain.length, 2);

  const single = meanCI([1, 2, 3], { reps: 200, seed: 1 });
  assert.equal(single.value, 2);
  assert.ok(single.lower >= 1 && single.upper <= 3);
});

test('the non-inferiority bound is monotone in n for the same empirical distribution', () => {
  const patternB = [0.6, 0.8, 0.9, 1.0, 0.7];
  const patternA = [0.7, 0.9, 1.0, 0.8, 0.9];
  const repeat = (pattern: number[], times: number) =>
    Array.from({ length: times }, () => pattern).flat();
  const bounds = [1, 2, 4, 8].map((times) =>
    nonInferiorityLowerBound(repeat(patternB, times), repeat(patternA, times), 0.05, {
      reps: 4000,
      seed: 17
    })
  );
  for (let i = 1; i < bounds.length; i++) {
    assert.ok(bounds[i]! > bounds[i - 1]!, `bounds ${bounds.join(', ')}`);
  }
  // The bound approaches the point estimate (-0.06) from below.
  assert.ok(bounds.at(-1)! < -0.06);
});

test('pass^k and flip rate reproduce the tau-bench example (c=6, n=10)', () => {
  assert.equal(choose(10, 3), 120);
  assert.equal(choose(6, 3), 20);
  assert.equal(passPowK(6, 10, 3), 20 / 120);
  assert.equal(passPowK(6, 10, 1), 0.6);
  assert.equal(passPowK(2, 10, 3), 0);
  assert.equal(passPowK(6, 2, 3), undefined);
  assert.ok(Math.abs(flipRate(6, 10)! - (2 * 6 * 4) / 90) < 1e-12);
  assert.equal(flipRate(10, 10), 0);
  assert.equal(flipRate(1, 1), undefined);
  assert.equal(
    pooledPassPowK(
      [
        { c: 6, n: 10 },
        { c: 10, n: 10 },
        { c: 1, n: 2 }
      ],
      3
    ),
    (20 / 120 + 1) / 2
  );
});

test('Wilson and Newcombe intervals', () => {
  const w = wilson(8, 10);
  assert.equal(w.value, 0.8);
  assert.ok(Math.abs(w.lower - 0.4902) < 0.001, String(w.lower));
  assert.ok(Math.abs(w.upper - 0.9433) < 0.001, String(w.upper));
  assert.deepEqual([wilson(0, 10).lower, wilson(10, 10).upper], [0, 1]);
  assert.ok(Number.isNaN(wilson(0, 0).value));

  const n = newcombe(8, 10, 8, 10);
  assert.equal(n.value, 0);
  assert.ok(n.lower < 0 && n.upper > 0 && Math.abs(n.lower + n.upper) < 1e-12);
  const better = newcombe(10, 10, 5, 10);
  assert.equal(better.value, 0.5);
  assert.ok(better.lower > 0);
});

test('CV ratio, Holm correction and n planning', () => {
  const ratio = cvRatio([10, 20, 30], [5, 10, 15], { reps: 300, seed: 1 });
  assert.ok(Math.abs(ratio.value - 1) < 1e-12);
  // Under 5 per side the interval is withheld (resamples with all values equal give log 0).
  assert.ok(Number.isNaN(ratio.lower) && Number.isNaN(ratio.upper));
  const five = cvRatio([10, 20, 30, 40, 50], [5, 10, 15, 20, 25], { reps: 300, seed: 1 });
  assert.ok(Number.isFinite(five.lower) && Number.isFinite(five.upper));
  assert.ok(five.lower <= 1 && 1 <= five.upper);
  assert.ok(Number.isNaN(cvRatio([1], [1, 2]).value));

  // Step-down: 3 x 0.01, then max(2 x 0.03, 0.03), then max(1 x 0.04, 0.06).
  assert.deepEqual(holm([0.01, 0.04, 0.03]), [0.03, 0.06, 0.06]);
  assert.deepEqual(holm([]), []);

  assert.equal(plannedN(0.55, 3), 13);
  assert.equal(plannedN(0.3, 3), 10);
  assert.equal(plannedN(1.0, 3), 20);
  assert.equal(plannedN(Number.NaN, 3), 10);
  assert.equal(plannedN(0.55, 3, 0.5), 10);

  assert.ok(Math.abs(logSd([Math.E, Math.E ** 3]) - Math.SQRT2) < 1e-12);
  assert.equal(sd([2, 4, 4, 4, 5, 5, 7, 9]), Math.sqrt(32 / 7));
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
});
