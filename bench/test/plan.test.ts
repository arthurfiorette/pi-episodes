import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  cellKey,
  countReruns,
  expandPlan,
  loadPlan,
  MAX_INFRA_RERUNS,
  nextPending,
  planSummary,
  resetInterrupted,
  savePlan,
  scheduleInfraRerun,
  trialDirName
} from '../src/plan.js';
import type { ModelSpec, PlanEntry } from '../src/types.js';

const models: ModelSpec[] = [
  { label: 'm1', model: 'anthropic/x', thinking: 'medium' },
  { label: 'm2', model: 'openai/y', thinking: 'low' }
];
const conditions = ['A', 'B@0123456789ab'];

function describe(entry: PlanEntry): string {
  return `${entry.model}:${entry.chain}:${entry.condition}:r${entry.runIndex}`;
}

test('expandPlan interleaves per DESIGN 8.4: chains round-robin, A B on even runs, B A on odd', () => {
  const plan = expandPlan(models, conditions, ['c1', 'c2'], 2);
  assert.deepEqual(plan.map(describe), [
    'm1:c1:A:r0',
    'm1:c1:B@0123456789ab:r0',
    'm1:c2:A:r0',
    'm1:c2:B@0123456789ab:r0',
    'm1:c1:B@0123456789ab:r1',
    'm1:c1:A:r1',
    'm1:c2:B@0123456789ab:r1',
    'm1:c2:A:r1',
    'm2:c1:A:r0',
    'm2:c1:B@0123456789ab:r0',
    'm2:c2:A:r0',
    'm2:c2:B@0123456789ab:r0',
    'm2:c1:B@0123456789ab:r1',
    'm2:c1:A:r1',
    'm2:c2:B@0123456789ab:r1',
    'm2:c2:A:r1'
  ]);
  assert.ok(plan.every((entry) => entry.status === 'pending'));
  assert.equal(plan[1]?.trialDir, 'trials/m1__B@0123456789ab__c1__r00');
  assert.equal(
    trialDirName({ model: 'sonnet-4-5-med', condition: 'A', chain: 'fn-utils', runIndex: 12 }),
    'sonnet-4-5-med__A__fn-utils__r12'
  );
  assert.deepEqual(planSummary(plan), {
    pending: 16,
    running: 0,
    done: 0,
    infra: 0,
    interrupted: 0
  });
  assert.throws(() => expandPlan(models, [], ['c1'], 1), /no conditions/);
  assert.throws(() => expandPlan(models, conditions, ['c1'], 0), /runs must be >= 1/);
});

test('nextPending hands out entries in order and marks them running', () => {
  const plan = expandPlan([models[0]!], ['A'], ['c1'], 3);
  const first = nextPending(plan);
  assert.equal(first?.runIndex, 0);
  assert.equal(first?.status, 'running');
  const second = nextPending(plan);
  assert.equal(second?.runIndex, 1);
  first!.status = 'done';
  assert.equal(nextPending(plan)?.runIndex, 2);
  assert.equal(nextPending(plan), undefined);
});

test('scheduleInfraRerun appends one rerun per infra trial, at most two per cell', () => {
  const plan = expandPlan([models[0]!], conditions, ['c1'], 1);
  const failed = plan[1]!;
  failed.status = 'infra';
  const rerun1 = scheduleInfraRerun(plan, failed);
  assert.ok(rerun1);
  assert.equal(plan.length, 3);
  assert.equal(plan.at(-1), rerun1);
  assert.deepEqual(
    { ...rerun1 },
    {
      model: 'm1',
      condition: 'B@0123456789ab',
      chain: 'c1',
      runIndex: 1,
      status: 'pending',
      trialDir: 'trials/m1__B@0123456789ab__c1__r01',
      rerunOf: 'trials/m1__B@0123456789ab__c1__r00'
    }
  );
  assert.equal(cellKey(rerun1), cellKey(failed));
  assert.equal(countReruns(plan, failed), 1);

  rerun1.status = 'infra';
  const rerun2 = scheduleInfraRerun(plan, rerun1);
  assert.equal(rerun2?.runIndex, 2);
  assert.equal(rerun2?.rerunOf, rerun1.trialDir);
  assert.equal(countReruns(plan, failed), MAX_INFRA_RERUNS);

  rerun2!.status = 'infra';
  assert.equal(scheduleInfraRerun(plan, rerun2!), undefined);
  assert.equal(plan.length, 4);
  // The other cell is untouched and still gets its own two.
  const other = plan[0]!;
  other.status = 'infra';
  assert.equal(scheduleInfraRerun(plan, other)?.runIndex, 1);
});

test('plan.json round-trips and --resume resets interrupted trials only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-plan-'));
  try {
    const plan = expandPlan([models[0]!], conditions, ['c1'], 2);
    plan[0]!.status = 'done';
    plan[1]!.status = 'done';
    plan[2]!.status = 'running';
    savePlan(dir, plan);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')), plan);

    const loaded = loadPlan(dir);
    assert.deepEqual(loaded, plan);
    const reset = resetInterrupted(loaded);
    assert.deepEqual(
      reset.map((entry) => entry.trialDir),
      [plan[2]!.trialDir]
    );
    assert.deepEqual(
      loaded.map((entry) => entry.status),
      ['done', 'done', 'pending', 'pending']
    );
    assert.deepEqual(
      [nextPending(loaded)?.trialDir, nextPending(loaded)?.trialDir, nextPending(loaded)],
      [plan[2]!.trialDir, plan[3]!.trialDir, undefined]
    );
    assert.throws(() => loadPlan(join(dir, 'missing')), /nothing to resume/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
