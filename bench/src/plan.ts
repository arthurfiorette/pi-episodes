import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, readJsonFile } from './fields.js';
import type { ModelSpec, PlanEntry, PlanStatus, TrialId } from './types.js';

export const PLAN_FILE = 'plan.json';
/** DESIGN 5.6: at most this many infra reruns per cell. */
export const MAX_INFRA_RERUNS = 2;
const STATUSES: readonly PlanStatus[] = ['pending', 'running', 'done', 'infra', 'interrupted'];

/** `<label>__<condition>__<chain>__r<NN>`; `condition` is `A` or `B@<prompt-id>`. */
export function trialDirName(id: TrialId): string {
  return `${id.model}__${id.condition}__${id.chain}__r${String(id.runIndex).padStart(2, '0')}`;
}

export function cellKey(id: Pick<TrialId, 'model' | 'condition' | 'chain'>): string {
  return `${id.model}__${id.condition}__${id.chain}`;
}

/**
 * DESIGN 8.4 order: per model, run indices outermost so every chain gets its first run before
 * any gets its second; chains round-robin inside a run; conditions in config order on even run
 * indices and reversed on odd ones, so provider drift lands on both.
 */
export function expandPlan(
  models: readonly ModelSpec[],
  conditionIds: readonly string[],
  chains: readonly string[],
  runs: number
): PlanEntry[] {
  if (conditionIds.length === 0) throw new ConfigError('plan: no conditions');
  if (chains.length === 0) throw new ConfigError('plan: no scenarios');
  if (!Number.isInteger(runs) || runs < 1)
    throw new ConfigError(`plan: runs must be >= 1, got ${runs}`);
  const plan: PlanEntry[] = [];
  for (const model of models) {
    for (let runIndex = 0; runIndex < runs; runIndex++) {
      const order = runIndex % 2 === 0 ? [...conditionIds] : [...conditionIds].reverse();
      for (const chain of chains) {
        for (const condition of order) {
          const id: TrialId = { model: model.label, condition, chain, runIndex };
          plan.push({ ...id, status: 'pending', trialDir: `trials/${trialDirName(id)}` });
        }
      }
    }
  }
  return plan;
}

export function savePlan(runDir: string, plan: readonly PlanEntry[]): void {
  const path = join(runDir, PLAN_FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(plan, null, 2)}\n`);
  renameSync(tmp, path);
}

export function loadPlan(runDir: string): PlanEntry[] {
  const path = join(runDir, PLAN_FILE);
  if (!existsSync(path)) throw new ConfigError(`${path}: not found; nothing to resume`);
  const raw = readJsonFile(path);
  if (!Array.isArray(raw)) throw new ConfigError(`${path}: expected an array`);
  return raw.map((item, index) => readEntry(item, `${path}[${index}]`));
}

function readEntry(value: unknown, where: string): PlanEntry {
  if (typeof value !== 'object' || value === null)
    throw new ConfigError(`${where}: expected an object`);
  const object = value as Record<string, unknown>;
  const string = (key: string) => {
    const item = object[key];
    if (typeof item !== 'string' || item.length === 0) {
      throw new ConfigError(`${where}.${key}: expected a non-empty string`);
    }
    return item;
  };
  const runIndex = object.runIndex;
  if (typeof runIndex !== 'number' || !Number.isInteger(runIndex) || runIndex < 0) {
    throw new ConfigError(`${where}.runIndex: expected a non-negative integer`);
  }
  const status = string('status');
  if (!STATUSES.includes(status as PlanStatus)) {
    throw new ConfigError(`${where}.status: expected one of ${STATUSES.join(', ')}`);
  }
  const entry: PlanEntry = {
    model: string('model'),
    condition: string('condition'),
    chain: string('chain'),
    runIndex,
    status: status as PlanStatus,
    trialDir: string('trialDir')
  };
  if (object.rerunOf !== undefined) entry.rerunOf = string('rerunOf');
  return entry;
}

/**
 * `--resume`: trials that were `running` when the process died, or `interrupted` by a signal,
 * start over; `done` and `infra` ones are kept. Returns the entries reset so the caller can
 * clear their directories.
 */
export function resetInterrupted(plan: PlanEntry[]): PlanEntry[] {
  const reset: PlanEntry[] = [];
  for (const entry of plan) {
    if (entry.status === 'running' || entry.status === 'interrupted') {
      entry.status = 'pending';
      reset.push(entry);
    }
  }
  return reset;
}

/** Signal handling: every `running` entry becomes `interrupted`; returns the entries changed. */
export function markInterrupted(plan: PlanEntry[]): PlanEntry[] {
  const marked: PlanEntry[] = [];
  for (const entry of plan) {
    if (entry.status === 'running') {
      entry.status = 'interrupted';
      marked.push(entry);
    }
  }
  return marked;
}

/**
 * Infra entries with no rerun scheduled: their cell used its `MAX_INFRA_RERUNS` and is
 * `insufficient` in the report (DESIGN 5.6), which `bench run` reports with exit code 1.
 */
export function infraExhausted(plan: readonly PlanEntry[]): PlanEntry[] {
  const rerunOf = new Set(plan.map((entry) => entry.rerunOf));
  return plan.filter((entry) => entry.status === 'infra' && !rerunOf.has(entry.trialDir));
}

/** The first pending entry, marked `running`; undefined when the plan is exhausted. */
export function nextPending(plan: PlanEntry[]): PlanEntry | undefined {
  const entry = plan.find((candidate) => candidate.status === 'pending');
  if (entry !== undefined) entry.status = 'running';
  return entry;
}

export function countReruns(
  plan: readonly PlanEntry[],
  cell: Pick<TrialId, 'model' | 'condition' | 'chain'>
): number {
  const key = cellKey(cell);
  return plan.filter((entry) => entry.rerunOf !== undefined && cellKey(entry) === key).length;
}

/**
 * DESIGN 5.6: an `infra` trial is rerun once under a new run index at the end of the plan, at
 * most `MAX_INFRA_RERUNS` times per cell. Returns the scheduled entry, or undefined when the
 * cell has used its reruns (the report then calls it `insufficient`).
 */
export function scheduleInfraRerun(plan: PlanEntry[], failed: PlanEntry): PlanEntry | undefined {
  if (countReruns(plan, failed) >= MAX_INFRA_RERUNS) return undefined;
  const key = cellKey(failed);
  const runIndex =
    Math.max(...plan.filter((entry) => cellKey(entry) === key).map((entry) => entry.runIndex)) + 1;
  const id: TrialId = {
    model: failed.model,
    condition: failed.condition,
    chain: failed.chain,
    runIndex
  };
  const entry: PlanEntry = {
    ...id,
    status: 'pending',
    trialDir: `trials/${trialDirName(id)}`,
    rerunOf: failed.trialDir
  };
  plan.push(entry);
  return entry;
}

export function planSummary(plan: readonly PlanEntry[]): Record<PlanStatus, number> {
  const summary: Record<PlanStatus, number> = {
    pending: 0,
    running: 0,
    done: 0,
    infra: 0,
    interrupted: 0
  };
  for (const entry of plan) summary[entry.status]++;
  return summary;
}

export function describeEntry(entry: PlanEntry): string {
  const base = `${entry.model} ${entry.condition} ${entry.chain} r${entry.runIndex}`;
  return entry.rerunOf === undefined ? base : `${base} (rerun of ${entry.rerunOf})`;
}
