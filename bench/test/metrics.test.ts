import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  activeBranch,
  readForkArchives,
  readSession,
  requests,
  toolResults
} from '../src/jsonl.js';
import { attended, computeMetrics, stepIdsByRequest, usageInvariantHolds } from '../src/metrics.js';
import type { ChecksJson, StepResult, TrialRecord } from '../src/types.js';

const fixtures = fileURLToPath(new URL('./fixtures/sessions', import.meta.url));

function steps(list: [id: string, kind: StepResult['kind'], requests: number][]): StepResult[] {
  return list.map(([id, kind, count], index) => ({
    id,
    kind,
    startedAt: new Date(index * 60_000).toISOString(),
    endedAt: new Date(index * 60_000 + 30_000).toISOString(),
    durationMs: 30_000,
    end: 'settled',
    requests: count,
    toolCalls: {},
    compactions: 0,
    retries: 0,
    errors: []
  }));
}

function record(stepList: StepResult[]): Pick<TrialRecord, 'steps' | 'category' | 'flags'> {
  return { steps: stepList, category: 'passed', flags: [] };
}

test('episodes session: folds, recalls, asks, forks, reminders and the input series', () => {
  const sessionPath = join(fixtures, 'b-episodes.jsonl');
  const checks: ChecksJson = {
    steps: [
      {
        snapshot: 'step-1',
        stepId: 'goal-1',
        fixtures: {},
        variants: {},
        traps: {},
        flags: [],
        score: 0.5
      }
    ],
    final: { snapshot: 'final', fixtures: {}, variants: {}, traps: {}, flags: [], score: 0.75 },
    answers: [],
    scoreCode: 0.75,
    scoreProbe: 1,
    pass: false,
    category: 'checks_failed',
    flags: ['trap_left']
  };
  const trialRecord = record(
    steps([
      ['goal-1', 'goal', 5],
      ['aside', 'aside', 10],
      ['probe-1', 'probe', 2]
    ])
  );
  const metrics = computeMetrics({ sessionPath, trialRecord, checks });

  assert.equal(metrics.requests, 17);
  assert.equal(metrics.turns, 17);
  assert.deepEqual(metrics.toolCalls, { bash: 5, fold: 4, recall: 3, ask: 1, fork: 1, read: 1 });
  assert.equal(metrics.tokenBasis, 'ok');

  // Token sums agree with the raw usage on the branch.
  const branch = activeBranch(readSession(sessionPath).entries);
  const main = requests(branch);
  const sum = (pick: (usage: (typeof main)[number]['message']['usage']) => number) =>
    main.reduce((total, request) => total + pick(request.message.usage), 0);
  assert.equal(
    metrics.tokens.input,
    sum((usage) => usage.input)
  );
  assert.equal(
    metrics.tokens.output,
    sum((usage) => usage.output)
  );
  assert.equal(metrics.contextAttended, sum(attended));
  assert.equal(
    metrics.peakContext,
    Math.max(...main.map((request) => attended(request.message.usage)))
  );
  assert.ok(metrics.cacheHitRate.overall > 0.5 && metrics.cacheHitRate.overall < 1);
  assert.ok(metrics.cacheHitRate.medianPerRequest > 0.9);
  assert.ok(metrics.cacheHitRate.shareBelowHalf > 0 && metrics.cacheHitRate.shareBelowHalf < 0.2);

  // Ask usage and the fork child's own requests count in context_attended_all.
  const ask = toolResults(branch, 'ask')[0]!.message.usage!;
  const archive = [...readForkArchives(sessionPath).values()][0]!;
  const childAttended = archive.messages.reduce(
    (total, message) => total + (message.role === 'assistant' ? attended(message.usage) : 0),
    0
  );
  assert.ok(childAttended > 0);
  assert.equal(metrics.contextAttendedAll, metrics.contextAttended + attended(ask) + childAttended);

  assert.equal(metrics.folds.length, 2);
  const [first, second] = metrics.folds;
  assert.ok(first && second);
  assert.match(first.handle, /^ep-[0-9a-f]{8}$/);
  assert.equal(first.since, 't2');
  assert.equal(first.until, 't4');
  assert.equal(first.requestIndex, 3);
  assert.equal(first.messages, 6);
  assert.ok(first.tokens > 0 && first.under2k);
  assert.equal(
    first.noteTokens,
    Math.ceil(
      'Build passes after regenerating the client.\n- Open: remove the debug flag in vite.config.ts.'
        .length / 4
    )
  );
  assert.ok(Math.abs(first.noteSpanRatio - first.noteTokens / first.tokens) < 1e-12);
  assert.equal(first.notAlone, false);
  assert.equal(first.beforeFinalReply, true);
  assert.ok(first.files.some((file) => file.endsWith('/a.txt')));
  assert.equal(first.cacheWriteAfter, main[4]!.message.usage.cacheWrite);
  assert.equal(second.since, 't7');
  assert.equal(second.requestIndex, 13);
  assert.equal(second.notAlone, true);
  assert.equal(second.beforeFinalReply, true);

  assert.deepEqual(
    metrics.rejectedFolds.map((fold) => fold.requestIndex),
    [11, 12]
  );
  assert.match(metrics.rejectedFolds[0]!.error, /cannot reach behind an earlier fold note/);
  assert.match(metrics.rejectedFolds[1]!.error, /since must be a turn stamp/);

  assert.equal(metrics.recalls.length, 3);
  assert.deepEqual(
    metrics.recalls.map((recall) => [
      recall.query,
      recall.total,
      recall.regex,
      recall.quoted,
      recall.stalenessLines
    ]),
    [
      ['"TS2322"', 2, false, true, 1],
      ['nothing-here-xyz', 0, false, false, 0],
      ['TS\\d+', 2, true, false, 1]
    ]
  );

  assert.equal(metrics.asks.length, 1);
  assert.equal(metrics.asks[0]!.handle, first.handle);
  assert.equal(metrics.asks[0]!.usage?.cacheRead, ask.cacheRead);
  assert.equal(metrics.forks.length, 1);
  assert.equal(metrics.forks[0]!.turns, 2);
  assert.equal(metrics.forks[0]!.folds, 0);
  assert.ok((metrics.forks[0]!.usage?.cacheRead ?? 0) > 0);
  assert.equal(metrics.reminders, 1);
  assert.deepEqual(metrics.errors, { throttled: 0, toolSchema: 1, terminal: 0 });
  assert.equal(metrics.cost.overhead.cacheWarm, 0);
  assert.equal(metrics.compactions.length, 0);
  assert.equal(metrics.timeToFirstFold?.requestIndex, 3);
  assert.ok((metrics.timeToFirstFold?.seconds ?? -1) >= 0);

  // One point per request; step ids follow the trial record's per-step request counts.
  assert.equal(metrics.inputSeries.length, 17);
  assert.deepEqual(
    metrics.inputSeries.map((point) => point.stepId),
    [...Array(5).fill('goal-1'), ...Array(10).fill('aside'), ...Array(2).fill('probe-1')]
  );
  const markersAt = (index: number) => metrics.inputSeries[index]!.markers;
  assert.deepEqual(markersAt(3), ['fold']);
  assert.deepEqual(markersAt(13), ['fold']);
  assert.deepEqual(markersAt(9), ['ask']);
  assert.deepEqual(markersAt(10), ['fork']);
  assert.ok(
    metrics.inputSeries.every((point, index) => point.index === index && point.attended > 0)
  );
  assert.equal(metrics.inputSeries.filter((point) => point.markers.length > 0).length, 4);

  assert.equal(metrics.wallTimeS, 90);
  assert.equal(metrics.category, 'checks_failed');
  assert.deepEqual(metrics.flags, ['trap_left']);
  assert.deepEqual(metrics.scoreStep, { 'goal-1': 0.5 });
  assert.equal(metrics.scoreCode, 0.75);
  assert.equal(metrics.scoreProbe, 1);
  assert.equal(metrics.pass, false);
  assert.equal(metrics.cost.total, 0);
});

test('plain pi session has no episode events', () => {
  const metrics = computeMetrics({
    sessionPath: join(fixtures, 'a-plain.jsonl'),
    trialRecord: record(
      steps([
        ['goal-1', 'goal', 4],
        ['probe-1', 'probe', 2]
      ])
    )
  });
  assert.equal(metrics.requests, 6);
  assert.deepEqual(metrics.toolCalls, { bash: 3, read: 1 });
  assert.equal(
    metrics.folds.length + metrics.recalls.length + metrics.asks.length + metrics.forks.length,
    0
  );
  assert.equal(metrics.reminders, 0);
  assert.equal(metrics.compactions.length, 0);
  assert.equal(metrics.contextAttendedAll, metrics.contextAttended);
  assert.ok(metrics.inputSeries.every((point) => point.markers.length === 0));
  assert.equal(metrics.timeToFirstFold, undefined);
  assert.equal(metrics.category, 'passed');
});

test('compaction fires with a 4600-token faux model and is counted with its marker', () => {
  const sessionPath = join(fixtures, 'b-compaction.jsonl');
  const metrics = computeMetrics({
    sessionPath,
    trialRecord: record(
      steps([
        ['goal-1', 'goal', 4],
        ['probe-1', 'probe', 2]
      ])
    )
  });
  assert.equal(metrics.requests, 6);
  assert.equal(metrics.compactions.length, 1);
  const [compaction] = metrics.compactions;
  assert.ok(compaction);
  assert.ok(compaction.tokensBefore > 3000);
  assert.ok((compaction.summaryUsage?.input ?? 0) > 0);
  // The compaction sits between request 1 and request 2: the marker goes on the first request
  // that ran on the summary, and that request's cacheWrite is the cost of the rewritten prefix.
  assert.equal(compaction.requestIndex, 2);
  const main = requests(activeBranch(readSession(sessionPath).entries));
  assert.equal(compaction.cacheWriteAfter, main[2]!.message.usage.cacheWrite);
  assert.ok((compaction.cacheWriteAfter ?? 0) > 500);
  // The fold right after the compaction removed the big turn.
  assert.equal(metrics.folds.length, 1);
  assert.equal(metrics.folds[0]!.requestIndex, 2);
  assert.equal(metrics.folds[0]!.since, 't3');
  assert.deepEqual(metrics.inputSeries[2]!.markers.sort(), ['compaction', 'fold']);
  assert.equal(
    metrics.inputSeries.filter((point) => point.markers.includes('compaction')).length,
    1
  );
  const summary = compaction.summaryUsage!;
  assert.equal(
    metrics.contextAttendedAll,
    metrics.contextAttended + summary.input + summary.cacheRead + summary.cacheWrite
  );
});

test('the usage invariant is flagged when a response violates it', () => {
  const ok = computeMetrics({
    sessionPath: join(fixtures, 'b-episodes.jsonl'),
    trialRecord: record(steps([['goal-1', 'goal', 17]]))
  });
  assert.equal(ok.tokenBasis, 'ok');
  const suspect = computeMetrics({
    sessionPath: join(fixtures, 'b-suspect.jsonl'),
    trialRecord: record(steps([['goal-1', 'goal', 2]]))
  });
  assert.equal(suspect.tokenBasis, 'suspect');
  const main = requests(activeBranch(readSession(join(fixtures, 'b-suspect.jsonl')).entries));
  assert.equal(usageInvariantHolds(main[0]!.message.usage), true);
  assert.equal(usageInvariantHolds(main[1]!.message.usage), false);
});

test('stepIdsByRequest attributes leftover requests to the last step', () => {
  const list = [
    { id: 'a', requests: 2 },
    { id: 'b', requests: 1 }
  ];
  assert.deepEqual(stepIdsByRequest(list, 5), ['a', 'a', 'b', 'b', 'b']);
  assert.deepEqual(stepIdsByRequest(list, 2), ['a', 'a']);
  assert.deepEqual(stepIdsByRequest([], 2), ['', '']);
});
