import assert from 'node:assert/strict';
import {
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
import { renderCharts } from '../src/charts.js';
import { run as reportCommand } from '../src/commands/report.js';
import { buildReport, loadRun, ReportError, TABLE_HEADER } from '../src/report.js';
import { createRng, normal } from '../src/stats.js';
import type {
  ChecksJson,
  InputSeriesPoint,
  MetricsJson,
  ReportJson,
  TrialAudit,
  TrialCategory,
  TrialRecord
} from '../src/types.js';

const fixtures = fileURLToPath(new URL('./fixtures/sessions', import.meta.url));
const CHAINS = ['fn-utils', 'mapped-types'];
const CONDITIONS = ['A', 'B@3ad2a3039322'];
const RUNS = 3;
const MODEL = 'faux-1';

interface TrialSpec {
  model?: string;
  condition: string;
  chain: string;
  runIndex: number;
  attended: number;
  scoreCode: number;
  pass: boolean;
  category?: TrialCategory;
  folds?: number;
  audit?: Partial<TrialAudit>;
  withSession?: boolean;
  /** `errors.terminal` of the metrics. */
  terminal?: number;
  /** `trial.json` error text (infra trials). */
  error?: string;
}

function audit(condition: string, overrides: Partial<TrialAudit> = {}): TrialAudit {
  const base: TrialAudit = {
    model: 'faux/faux-1',
    provider: 'faux',
    modelId: 'faux-1',
    thinking: 'off',
    settings: {} as TrialAudit['settings'],
    tools:
      condition === 'A'
        ? ['read', 'bash', 'edit', 'write']
        : ['read', 'bash', 'edit', 'write', 'fold', 'recall', 'ask', 'fork'],
    systemPromptHash: condition === 'A' ? 'hash-a' : 'hash-b',
    extensionPaths: condition === 'A' ? [] : ['/x/src/index.ts'],
    piVersion: '1.1.0',
    nodeVersion: 'v24'
  };
  if (condition !== 'A') base.promptId = condition.slice(2);
  return { ...base, ...overrides };
}

function metricsFor(spec: TrialSpec): MetricsJson {
  const requests = 12;
  const isB = spec.condition !== 'A';
  const folds = spec.folds ?? (isB ? 2 : 0);
  const inputSeries: InputSeriesPoint[] = Array.from({ length: requests }, (_, index) => ({
    index,
    stepId: index < 6 ? 'goal-1' : index < 10 ? 'goal-2' : 'probe-1',
    attended: Math.round((spec.attended / requests) * (0.6 + index / requests)),
    markers:
      isB && (index === 5 || index === 9) && folds > 0
        ? ['fold']
        : index === 7 && !isB
          ? ['compaction']
          : []
  }));
  return {
    requests,
    turns: requests,
    toolCalls: { bash: 6, read: 3, ...(isB ? { fold: folds, recall: 1 } : {}) },
    tokens: {
      input: spec.attended / 10,
      cacheRead: (spec.attended * 8) / 10,
      cacheWrite: spec.attended / 10,
      cacheWrite1h: 0,
      output: 900 + spec.runIndex * 50,
      reasoning: 0
    },
    tokenBasis: 'ok',
    contextAttended: spec.attended,
    contextAttendedAll: spec.attended,
    peakContext: Math.round(spec.attended / 6),
    cacheHitRate: { overall: 0.8, medianPerRequest: 0.9, shareBelowHalf: 0.1 },
    cost: {
      total: spec.attended / 1e6,
      overhead: { fold: 0, ask: 0, fork: 0, compaction: 0, cacheWarm: 0 }
    },
    wallTimeS: 600 + spec.runIndex * 30,
    compactions: isB ? [] : [{ requestIndex: 7, tokensBefore: 150000 }],
    folds: Array.from({ length: folds }, (_, i) => ({
      handle: `ep-0000000${i}`,
      since: `t${3 + i * 4}`,
      requestIndex: 5 + i * 4,
      messages: 8,
      tokens: 2500 + i * 100,
      noteTokens: 120,
      noteSpanRatio: 120 / 2500,
      under2k: false,
      files: [],
      notAlone: i === 1,
      beforeFinalReply: false
    })),
    rejectedFolds: isB && spec.runIndex === 0 ? [{ requestIndex: 4, error: 'nope' }] : [],
    recalls: isB
      ? [{ requestIndex: 8, query: 'x', total: 1, regex: false, quoted: false, stalenessLines: 0 }]
      : [],
    asks: [],
    forks: [],
    reminders: isB ? 1 : 0,
    errors: { throttled: 0, toolSchema: 0, terminal: spec.terminal ?? 0 },
    inputSeries,
    category: spec.category ?? 'passed',
    flags: [],
    scoreStep: { 'goal-1': spec.scoreCode, 'goal-2': Math.min(1, spec.scoreCode + 0.1) },
    scoreCode: spec.scoreCode,
    scoreProbe: 1,
    pass: spec.pass
  };
}

function writeTrial(runDir: string, spec: TrialSpec): string {
  const model = spec.model ?? MODEL;
  const id = `${model}__${spec.condition}__${spec.chain}__r${String(spec.runIndex).padStart(2, '0')}`;
  const dir = join(runDir, 'trials', id);
  mkdirSync(dir, { recursive: true });
  const category = spec.category ?? 'passed';
  const trial: TrialRecord = {
    model,
    condition: spec.condition,
    chain: spec.chain,
    runIndex: spec.runIndex,
    runId: 'test-run',
    trialId: id,
    startedAt: '2026-10-14T00:00:00.000Z',
    endedAt: '2026-10-14T00:30:00.000Z',
    audit: audit(spec.condition, spec.audit),
    steps: [
      {
        id: 'goal-1',
        kind: 'goal',
        startedAt: '2026-10-14T00:00:00.000Z',
        durationMs: 300_000,
        end: 'settled',
        requests: 6,
        toolCalls: {},
        compactions: 0,
        retries: 0,
        errors: [],
        score: spec.scoreCode
      },
      {
        id: 'goal-2',
        kind: 'goal',
        startedAt: '2026-10-14T00:05:00.000Z',
        durationMs: 300_000,
        end: 'settled',
        requests: 4,
        toolCalls: {},
        compactions: 0,
        retries: 0,
        errors: []
      },
      {
        id: 'probe-1',
        kind: 'probe',
        startedAt: '2026-10-14T00:10:00.000Z',
        durationMs: 10_000,
        end: 'settled',
        requests: 2,
        toolCalls: {},
        compactions: 0,
        retries: 0,
        errors: []
      }
    ],
    category,
    flags: [],
    ...(spec.error === undefined ? {} : { error: spec.error })
  };
  writeFileSync(join(dir, 'trial.json'), JSON.stringify(trial, null, 2));
  const checks: ChecksJson = {
    steps: [
      {
        snapshot: 'step-1',
        stepId: 'goal-1',
        fixtures: {},
        variants: {},
        traps: {},
        flags: [],
        score: spec.scoreCode
      }
    ],
    final: {
      snapshot: 'final',
      fixtures: {},
      variants: {},
      traps: {},
      flags: [],
      score: spec.scoreCode
    },
    answers: [],
    scoreCode: spec.scoreCode,
    scoreProbe: 1,
    pass: spec.pass,
    category,
    flags: []
  };
  writeFileSync(join(dir, 'checks.json'), JSON.stringify(checks, null, 2));
  if (spec.withSession) {
    cpSync(join(fixtures, 'b-episodes.jsonl'), join(dir, 'session.jsonl'));
    cpSync(join(fixtures, 'b-episodes.episodes'), join(dir, 'session.episodes'), {
      recursive: true
    });
  } else {
    writeFileSync(join(dir, 'metrics.json'), JSON.stringify(metricsFor(spec), null, 2));
  }
  return dir;
}

/** 2 chains x 2 conditions x 3 runs; B attends about 60% of A's tokens with the same scores. */
function makeRun(
  root: string,
  options: { name?: string; ratio?: number; heldOut?: string[]; runsPerCell?: number } = {}
): string {
  const runDir = join(root, options.name ?? 'run-1');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'manifest.json'),
    JSON.stringify({
      runId: options.name ?? 'run-1',
      config: {
        scenarios: CHAINS,
        heldOut: options.heldOut ?? ['mapped-types'],
        ...(options.runsPerCell === undefined ? {} : { runsPerCell: options.runsPerCell })
      },
      promptIds: { B: '3ad2a3039322' },
      piVersion: '1.1.0'
    })
  );
  const rng = createRng(99);
  for (const chain of CHAINS) {
    for (const condition of CONDITIONS) {
      for (let runIndex = 0; runIndex < RUNS; runIndex++) {
        const base = chain === 'fn-utils' ? 3_000_000 : 4_000_000;
        const scale = condition === 'A' ? 1 : (options.ratio ?? 0.6);
        writeTrial(runDir, {
          condition,
          chain,
          runIndex,
          attended: Math.round(base * scale * Math.exp(0.2 * normal(rng))),
          scoreCode: 0.9 - (runIndex === 2 ? 0.2 : 0),
          pass: runIndex !== 2
        });
      }
    }
  }
  return runDir;
}

async function withTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'bench-report-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('buildReport writes the per-model table, pooled row, verdict, mechanics and categories', async () => {
  await withTempDir((root) => {
    const runDir = makeRun(root);
    const built = buildReport(runDir, { reps: 300, seed: 1 });
    const { report, markdown } = built;
    assert.equal(report.runId, 'run-1');
    assert.deepEqual(report.conditions, CONDITIONS);
    assert.deepEqual(report.heldOut, ['mapped-types']);
    assert.equal(report.models.length, 1);
    const model = report.models[0]!;
    assert.equal(model.model, MODEL);
    assert.equal(model.conditionB, 'B@3ad2a3039322');
    assert.equal(model.promptId, '3ad2a3039322');
    assert.deepEqual(
      model.rows.map((row) => [row.chain, row.heldOut, row.a.used, row.b.used]),
      [
        ['fn-utils', false, 3, 3],
        ['mapped-types', true, 3, 3]
      ]
    );
    assert.equal(model.pooled.chain, 'pooled');
    assert.equal(model.pooled.a.n, 6);
    assert.ok(
      model.pooled.tokens.value < 0.8 && model.pooled.tokens.value > 0.4,
      String(model.pooled.tokens.value)
    );
    assert.ok(
      model.pooled.tokens.lower! <= model.pooled.tokens.value &&
        model.pooled.tokens.value <= model.pooled.tokens.upper!
    );
    for (const row of model.rows) {
      assert.ok(row.tokens.lower! <= row.tokens.value && row.tokens.value <= row.tokens.upper!);
      assert.ok(row.pBelow >= 0.8, `${row.chain} P(B<A) ${row.pBelow}`);
      assert.equal(row.a.pass.c, 2);
      assert.equal(row.a.passPow3, 0);
      assert.ok(Math.abs(row.a.flip! - 2 / 3) < 1e-12);
      assert.equal(row.b.episodes.folds, 2);
      assert.equal(row.a.compactions, 1);
      assert.equal(row.b.compactions, 0);
      assert.ok(Math.abs(row.scoreCodeDiff.value) < 1e-9);
      assert.ok(Number.isFinite(row.cost.value));
    }
    // n = 3 per cell is below the planned n, so the verdict is insufficient, with the reasons listed.
    assert.equal(model.verdict.verdict, 'insufficient');
    assert.ok(model.verdict.plannedN >= 10);
    assert.ok(model.verdict.reasons.some((reason) => /3 usable trials, planned/.test(reason)));
    assert.equal(model.verdict.h1.outcome, 'below');
    assert.equal(model.verdict.h2.holds, true);
    assert.equal(model.verdict.h3.holds, true);
    assert.equal(model.variance.cells.length, 4);
    assert.ok(model.variance.cells.every((cell) => cell.n === 3 && Number.isFinite(cell.sdLog)));
    assert.equal(model.foldMechanics.trials, 6);
    assert.equal(model.foldMechanics.folds, 12);
    assert.equal(model.foldMechanics.rejected, 2);
    assert.equal(model.foldMechanics.notAlone, 6);
    assert.equal(model.foldMechanics.under2k, 0);
    assert.equal(model.foldMechanics.recalls.count, 6);
    assert.equal(model.foldMechanics.reminders, 6);
    assert.equal(model.judge, undefined);

    assert.match(markdown, /^# Benchmark report: run-1/);
    assert.ok(markdown.includes(`| ${TABLE_HEADER.join(' | ')} |`));
    assert.match(markdown, /\| fn-utils \| 3 \/ 3 \|/);
    assert.match(markdown, /\| mapped-types \(held out\) \|/);
    assert.match(markdown, /\| \*\*pooled\*\* \| 6 \/ 6 \|/);
    assert.match(
      markdown,
      /\*\*Verdict: insufficient\.\*\* H1 tokens ratio 0\.\d\d \[0\.\d\d, 0\.\d\d\] \(upper bound < 1\); H2 .* \(holds\); H3 .* \(holds\); planned n per cell \d+\./
    );
    assert.match(markdown, /Variance note: SD of log context_attended per cell/);
    assert.match(
      markdown,
      /### Fold mechanics \(B\)\n\n- B trials: 6; folds: 12 \(2\.0 per run\); rejected: 2/
    );
    assert.match(markdown, /### Categories\n\n\| condition \| passed \|/);
    assert.match(markdown, /No judge\.json in this run/);
    // JSON is complete and serializable.
    const roundTrip = JSON.parse(JSON.stringify(report)) as ReportJson;
    assert.equal(roundTrip.models[0]!.rows.length, 2);
  });
});

test('the verdict rules: win and lose when every cell has the planned n', async () => {
  await withTempDir((root) => {
    const runDir = join(root, 'big');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'manifest.json'),
      JSON.stringify({
        runId: 'big',
        config: { scenarios: ['fn-utils'], heldOut: [], runsPerCell: 10 }
      })
    );
    const rng = createRng(5);
    const write = (condition: string, scale: number, score: number, category?: TrialCategory) => {
      for (let runIndex = 0; runIndex < 10; runIndex++) {
        writeTrial(runDir, {
          condition,
          chain: 'fn-utils',
          runIndex,
          attended: Math.round(3_000_000 * scale * Math.exp(0.1 * normal(rng))),
          scoreCode: score,
          pass: score >= 0.9,
          ...(category && runIndex < 3 ? { category } : {})
        });
      }
    };
    write('A', 1, 0.9);
    write('B@x', 0.6, 0.9);
    let report = buildReport(runDir, { reps: 300, seed: 1 }).report;
    assert.equal(report.models[0]!.verdict.verdict, 'win');
    assert.equal(report.models[0]!.verdict.plannedN, 10);

    // Same tokens, score 0.5 instead of 0.9: H2 fails, so lose even with the token win.
    rmSync(join(runDir, 'trials'), { recursive: true });
    write('A', 1, 0.9);
    write('B@x', 0.6, 0.5);
    report = buildReport(runDir, { reps: 300, seed: 1 }).report;
    assert.equal(report.models[0]!.verdict.verdict, 'lose');
    assert.equal(report.models[0]!.verdict.h2.holds, false);

    // Three of ten B trials time out: H3 fails.
    rmSync(join(runDir, 'trials'), { recursive: true });
    write('A', 1, 0.9);
    write('B@x', 0.6, 0.9, 'timeout');
    report = buildReport(runDir, { reps: 300, seed: 1 }).report;
    assert.equal(report.models[0]!.verdict.verdict, 'lose');
    assert.equal(report.models[0]!.verdict.h3.holds, false);
    assert.equal(report.models[0]!.pooled.b.categories.timeout, 3);

    // Equal tokens: tie.
    rmSync(join(runDir, 'trials'), { recursive: true });
    write('A', 1, 0.9);
    write('B@x', 1, 0.9);
    report = buildReport(runDir, { reps: 300, seed: 1 }).report;
    assert.equal(report.models[0]!.verdict.verdict, 'tie');
    assert.equal(report.models[0]!.verdict.h1.outcome, 'covers');
  });
});

test('the planned n of the verdict is the manifest runsPerCell; a run planned below 10 is a pilot with no verdict', async () => {
  await withTempDir((root) => {
    // 3 runs per cell planned and delivered: no shortfall, but a pilot (DESIGN 8.4) is never
    // read for B vs A, so the verdict is insufficient with that one reason; tables stay.
    const runDir = makeRun(root, { runsPerCell: 3 });
    const { report, markdown } = buildReport(runDir, { reps: 300, seed: 1 });
    const model = report.models[0]!;
    assert.equal(model.verdict.plannedN, 3);
    assert.equal(model.verdict.verdict, 'insufficient');
    assert.deepEqual(model.verdict.reasons, [
      'pilot-sized run (n < 10), read the n column and the variance note'
    ]);
    assert.equal(model.verdict.h1.outcome, 'below');
    assert.equal(model.rows.length, 2);
    assert.ok(model.variance.plannedN >= 10, 'post-hoc sizing advice is still the formula');
    assert.match(markdown, /planned n per cell 3\. Reasons: pilot-sized run \(n < 10\)/);
    assert.match(markdown, /sizing for the next run\): \d+\./);
    assert.match(markdown, /\| fn-utils \| 3 \/ 3 \|/);
    // Planned 12, delivered 3: insufficient with the shortfall named, not the pilot reason.
    const short = buildReport(makeRun(root, { name: 'short', runsPerCell: 12 }), {
      reps: 300,
      seed: 1
    }).report.models[0]!;
    assert.equal(short.verdict.verdict, 'insufficient');
    assert.equal(short.verdict.plannedN, 12);
    assert.ok(short.verdict.reasons.some((reason) => /3 usable trials, planned 12/.test(reason)));
    assert.ok(!short.verdict.reasons.some((reason) => /pilot-sized/.test(reason)));
  });
});

test('infra trials are counted per cell with their error texts; terminal errors are summed', async () => {
  await withTempDir((root) => {
    const runDir = makeRun(root, { runsPerCell: 3 });
    const before = buildReport(runDir, { reps: 300, seed: 1 }).report.models[0]!;
    writeTrial(runDir, {
      condition: 'B@3ad2a3039322',
      chain: 'fn-utils',
      runIndex: 3,
      attended: 1,
      scoreCode: 0,
      pass: false,
      category: 'infra',
      error: 'goal-1: HTTP 429 Too Many Requests'
    });
    // Same scores as the r01 it replaces, with two terminal errors recorded.
    writeTrial(runDir, {
      condition: 'A',
      chain: 'fn-utils',
      runIndex: 1,
      attended: 3_000_000,
      scoreCode: 0.9,
      pass: true,
      terminal: 2
    });
    const { report, markdown } = buildReport(runDir, { reps: 300, seed: 1 });
    const model = report.models[0]!;
    const row = model.rows[0]!;
    assert.equal(row.b.n, 3);
    assert.equal(row.b.infra, 1);
    assert.equal(row.b.categories.infra, 1);
    assert.deepEqual(row.b.infraErrors, [
      'faux-1__B@3ad2a3039322__fn-utils__r03: goal-1: HTTP 429 Too Many Requests'
    ]);
    assert.equal(row.a.infra, 0);
    assert.equal(row.a.terminalErrors, 2);
    assert.equal(model.pooled.b.infra, 1);
    assert.equal(model.pooled.a.terminalErrors, 2);
    // Still outside every denominator: H1 to H3 are what they were without the infra trial,
    // and the only reason is the pilot size (runsPerCell 3), not a shortfall.
    assert.equal(model.verdict.h1.outcome, before.verdict.h1.outcome);
    assert.equal(model.verdict.h2.holds, before.verdict.h2.holds);
    assert.equal(model.verdict.h3.holds, before.verdict.h3.holds);
    assert.deepEqual(model.verdict.reasons, before.verdict.reasons);
    assert.ok(!model.verdict.reasons.some((reason) => /usable trials/.test(reason)));
    assert.match(markdown, /\| fn-utils \| 3 \/ 3 \(\+0\/1 infra\) \|/);
    assert.match(markdown, /\| condition \| passed \|.*\| infra \| terminal errors \|/);
    assert.match(
      markdown,
      /\| B@3ad2a3039322 \| 6 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 1 \| 0 \|/
    );
    assert.match(markdown, /\| A \| 6 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 2 \|/);
    assert.match(
      markdown,
      /Infra trials \(outside every denominator, DESIGN 5\.6\):\n\n- faux-1__B@3ad2a3039322__fn-utils__r03: goal-1: HTTP 429/
    );
  });
});

test('refuses to pool trials whose audit fields differ within a cell', async () => {
  await withTempDir((root) => {
    const runDir = makeRun(root);
    writeTrial(runDir, {
      condition: 'A',
      chain: 'fn-utils',
      runIndex: 1,
      attended: 3_000_000,
      scoreCode: 0.9,
      pass: true,
      audit: { systemPromptHash: 'hash-other' }
    });
    assert.throws(
      () => buildReport(runDir, { reps: 50 }),
      (error: unknown) =>
        error instanceof ReportError &&
        /refusing to pool faux-1 A fn-utils: audit field systemPromptHash differs between faux-1__A__fn-utils__r00 and faux-1__A__fn-utils__r01/.test(
          error.message
        )
    );
    // Infra trials are not audited: they are out of every denominator.
    writeTrial(runDir, {
      condition: 'A',
      chain: 'fn-utils',
      runIndex: 1,
      attended: 3_000_000,
      scoreCode: 0.9,
      pass: true,
      category: 'infra',
      audit: { systemPromptHash: 'hash-other' }
    });
    const report = buildReport(runDir, { reps: 50 }).report;
    assert.equal(report.models[0]!.rows[0]!.a.n, 2);
    // Settings are compared structurally too.
    writeTrial(runDir, {
      condition: 'B@3ad2a3039322',
      chain: 'mapped-types',
      runIndex: 0,
      attended: 2_000_000,
      scoreCode: 0.9,
      pass: true,
      audit: { settings: { compaction: { enabled: false } } as TrialAudit['settings'] }
    });
    assert.throws(() => buildReport(runDir, { reps: 50 }), /audit field settings differs/);
  });
});

test('metrics are derived from session.jsonl when metrics.json is missing', async () => {
  await withTempDir((root) => {
    const runDir = makeRun(root);
    writeTrial(runDir, {
      condition: 'B@3ad2a3039322',
      chain: 'fn-utils',
      runIndex: 3,
      attended: 0,
      scoreCode: 0.9,
      pass: true,
      withSession: true
    });
    const loaded = loadRun(runDir);
    const derived = loaded.trials.find((trial) =>
      trial.id.endsWith('B@3ad2a3039322__fn-utils__r03')
    );
    assert.ok(derived);
    assert.equal(derived.metrics.requests, 17);
    assert.equal(derived.metrics.folds.length, 2);
    assert.equal(derived.metrics.scoreCode, 0.9);
    assert.deepEqual(loaded.warnings, []);
  });
});

test('charts.html holds four svg elements per model and the report command writes all three files', async () => {
  await withTempDir(async (root) => {
    const runDir = makeRun(root);
    const built = buildReport(runDir, { reps: 100, seed: 2 });
    const html = renderCharts(built.report, built.trials);
    assert.equal((html.match(/<svg\b/g) ?? []).length, 4);
    assert.equal((html.match(/<\/svg>/g) ?? []).length, 4);
    assert.ok(!html.includes('<script'));
    for (const title of [
      'Attended tokens per request',
      'context_attended per trial',
      'score_step and score_code',
      'Event timeline (B trials)'
    ]) {
      assert.ok(html.includes(`<strong>${title}</strong>`), title);
    }
    assert.ok(html.includes('<polygon'), 'fold markers are drawn');
    assert.ok(html.includes('fn-utils r00'), 'timeline rows are labeled');

    // Two models: eight charts.
    const rng = createRng(3);
    for (const condition of CONDITIONS) {
      for (let runIndex = 0; runIndex < 2; runIndex++) {
        writeTrial(runDir, {
          model: 'other',
          condition,
          chain: 'fn-utils',
          runIndex,
          attended: Math.round(2_000_000 * Math.exp(0.1 * normal(rng))),
          scoreCode: 1,
          pass: true
        });
      }
    }
    const out = join(root, 'out');
    const code = await reportCommand([runDir, '--out', out, '--reps', '100']);
    assert.equal(code, 0);
    for (const name of ['report.md', 'report.json', 'charts.html'])
      assert.ok(existsSync(join(out, name)), name);
    const json = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as ReportJson;
    assert.deepEqual(
      json.models.map((model) => model.model),
      ['faux-1', 'other']
    );
    const page = readFileSync(join(out, 'charts.html'), 'utf8');
    assert.equal((page.match(/<svg\b/g) ?? []).length, 8);
    assert.equal(await reportCommand([join(root, 'missing')]), 1);
  });
});

test('--compare pairs runs by chain and splits tuning from held-out chains', async () => {
  await withTempDir((root) => {
    const runDir = makeRun(root, { name: 'run-1' });
    const other = makeRun(root, { name: 'run-2', ratio: 0.45 });
    const { report, markdown } = buildReport(runDir, { compare: other, reps: 200, seed: 4 });
    assert.ok(report.compare);
    assert.equal(report.compare.runId, 'run-2');
    const model = report.compare.models[0]!;
    assert.deepEqual(
      model.rows.map((row) => [row.chain, row.heldOut, row.nThis, row.nOther]),
      [
        ['fn-utils', false, 3, 3],
        ['mapped-types', true, 3, 3]
      ]
    );
    for (const row of model.rows)
      assert.ok(row.tokens.value < 1, `${row.chain} ${row.tokens.value}`);
    assert.ok(model.pooledTuning && model.pooledHeldOut);
    assert.equal(model.pooledTuning.nThis, 3);
    assert.equal(model.pooledHeldOut.nThis, 3);
    assert.equal(model.heldOutAgrees, true);
    assert.match(markdown, /## Comparison with run-2/);
    assert.match(markdown, /\| fn-utils \| tuning \| 3 \/ 3 \|/);
    assert.match(markdown, /\| mapped-types \| held-out \|/);
    assert.match(markdown, /\*\*pooled held-out\*\*/);
    assert.match(markdown, /Held-out chains agree in sign with the tuning chains: yes\./);
  });
});
