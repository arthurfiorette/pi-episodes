import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompactionModelOverride } from '@earendil-works/pi-coding-agent';
import {
  ConfigError,
  readArray,
  readEnum,
  readJsonFile,
  readNumber,
  readObject,
  readOptional,
  readRecord,
  readString,
  readStringArray,
  rejectUnknownKeys,
  requireIdentifier,
  requireUnique
} from './fields.js';
import type {
  ConditionSpec,
  FullSuiteFrequency,
  ModelSpec,
  RunCaps,
  RunConfig,
  ThinkingLevel
} from './types.js';

export const BENCH_DIR = fileURLToPath(new URL('..', import.meta.url));
export const CONFIG_DIR = join(BENCH_DIR, 'config');
export const SCENARIOS_DIR = join(BENCH_DIR, 'scenarios');
/** Self-test scenarios (DESIGN 12); `resolveScenarioDir` falls back here. */
export const FIXTURES_DIR = join(BENCH_DIR, 'test/fixtures');
export const RESULTS_DIR = join(BENCH_DIR, 'results');
export const CACHE_DIR = join(BENCH_DIR, 'cache');

export const DEFAULT_RUN_CONFIG = join(CONFIG_DIR, 'run.json');
export const DEFAULT_MODELS_CONFIG = join(CONFIG_DIR, 'models.json');
/** Model labels for `--provider faux`; the faux driver supplies the model itself. */
export const FAUX_MODELS_CONFIG = join(CONFIG_DIR, 'models.faux.json');
/** Gitignored; same format as pi's `auth.json`, passed as `authPath` to `ModelRuntime.create`. */
export const DEFAULT_AUTH_PATH = join(CONFIG_DIR, 'auth.json');
/**
 * Optional pi `models.json` (docs/models.md, "Configure a compatible endpoint") for proxies and
 * OpenAI- or Anthropic-compatible servers; `models.pi.example.json` shows the shape. Not
 * gitignored, so `apiKey` must be a `$ENV` reference, never a literal key.
 */
export const DEFAULT_PI_MODELS_PATH = join(CONFIG_DIR, 'models.pi.json');

/**
 * `modelsPath` for `ModelRuntime.create`: the file when it exists, else `null`, which loads no
 * file at all (`undefined` would load `~/.pi/agent/models.json`, and the runner never reads
 * `~/.pi`). The one place that looks for the file; every runtime gets the result as an option.
 */
export function resolvePiModelsPath(path: string = DEFAULT_PI_MODELS_PATH): string | null {
  return existsSync(path) ? path : null;
}

export const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
] as const satisfies readonly ThinkingLevel[];

export const FULL_SUITE_FREQUENCIES = [
  'goal-steps',
  'chain-end',
  'never'
] as const satisfies readonly FullSuiteFrequency[];

/** Loads and validates `run.json`. `conditions[].extension` comes back absolute. */
export function loadRunConfig(path: string = DEFAULT_RUN_CONFIG): RunConfig {
  const root = readObject(readJsonFile(path), path);
  rejectUnknownKeys(root, path, [
    'scenarios',
    'conditions',
    'runsPerCell',
    'parallel',
    'caps',
    'checks',
    'retry',
    'compactionOverrides',
    'heldOut'
  ]);

  const scenarios = readStringArray(root.scenarios, `${path}: scenarios`);
  if (scenarios.length === 0) throw new ConfigError(`${path}: scenarios must not be empty`);
  for (const [index, id] of scenarios.entries()) {
    requireIdentifier(id, `${path}: scenarios[${index}]`);
  }
  requireUnique(scenarios, `${path}: scenarios`);

  const conditions = readArray(root.conditions, `${path}: conditions`, (value, where) =>
    readCondition(value, where, dirname(path))
  );
  if (conditions.length === 0) throw new ConfigError(`${path}: conditions must not be empty`);
  requireUnique(
    conditions.map((condition) => condition.id),
    `${path}: conditions[].id`
  );

  const caps = readObject(root.caps, `${path}: caps`);
  rejectUnknownKeys(caps, `${path}: caps`, [
    'goalStepMinutes',
    'otherStepMinutes',
    'goalStepTurns',
    'trialHours'
  ]);
  const runCaps: RunCaps = {
    goalStepMinutes: readNumber(caps.goalStepMinutes, `${path}: caps.goalStepMinutes`, { min: 0 }),
    otherStepMinutes: readNumber(caps.otherStepMinutes, `${path}: caps.otherStepMinutes`, {
      min: 0
    }),
    goalStepTurns: readNumber(caps.goalStepTurns, `${path}: caps.goalStepTurns`, {
      min: 1,
      integer: true
    }),
    trialHours: readNumber(caps.trialHours, `${path}: caps.trialHours`, { min: 0 })
  };

  const checks = readObject(root.checks, `${path}: checks`);
  rejectUnknownKeys(checks, `${path}: checks`, ['fullSuite']);
  const retry = readObject(root.retry, `${path}: retry`);
  rejectUnknownKeys(retry, `${path}: retry`, ['maxRetries', 'baseDelayMs']);

  const compactionOverrides =
    readOptional(root.compactionOverrides, `${path}: compactionOverrides`, (value, where) =>
      readRecord(value, where, readCompactionOverride)
    ) ?? {};
  for (const key of Object.keys(compactionOverrides)) {
    if (!key.includes('/')) {
      throw new ConfigError(
        `${path}: compactionOverrides key ${JSON.stringify(key)} must be provider/modelId`
      );
    }
  }

  const heldOut = readOptional(root.heldOut, `${path}: heldOut`, readStringArray);
  for (const [index, id] of (heldOut ?? []).entries()) {
    if (!scenarios.includes(id)) {
      throw new ConfigError(
        `${path}: heldOut[${index}]: ${JSON.stringify(id)} is not in scenarios`
      );
    }
  }

  const config: RunConfig = {
    scenarios,
    conditions,
    runsPerCell: readNumber(root.runsPerCell, `${path}: runsPerCell`, { min: 1, integer: true }),
    parallel: readNumber(root.parallel, `${path}: parallel`, { min: 1, integer: true }),
    caps: runCaps,
    checks: {
      fullSuite: readEnum(checks.fullSuite, `${path}: checks.fullSuite`, FULL_SUITE_FREQUENCIES)
    },
    retry: {
      maxRetries: readNumber(retry.maxRetries, `${path}: retry.maxRetries`, {
        min: 0,
        integer: true
      }),
      baseDelayMs: readNumber(retry.baseDelayMs, `${path}: retry.baseDelayMs`, { min: 0 })
    },
    compactionOverrides
  };
  if (heldOut !== undefined) config.heldOut = heldOut;
  return config;
}

function readCondition(value: unknown, where: string, configDir: string): ConditionSpec {
  const object = readObject(value, where);
  rejectUnknownKeys(object, where, ['id', 'extension']);
  const id = requireIdentifier(readString(object.id, `${where}.id`), `${where}.id`);
  const extension = readOptional(object.extension, `${where}.extension`, readString);
  return extension === undefined ? { id } : { id, extension: resolve(configDir, extension) };
}

function readCompactionOverride(value: unknown, where: string): CompactionModelOverride {
  const object = readObject(value, where);
  rejectUnknownKeys(object, where, ['reserveTokens', 'keepRecentTokens']);
  const override: CompactionModelOverride = {};
  const reserveTokens = readOptional(object.reserveTokens, `${where}.reserveTokens`, (v, w) =>
    readNumber(v, w, { min: 0, integer: true })
  );
  const keepRecentTokens = readOptional(
    object.keepRecentTokens,
    `${where}.keepRecentTokens`,
    (v, w) => readNumber(v, w, { min: 0, integer: true })
  );
  if (reserveTokens !== undefined) override.reserveTokens = reserveTokens;
  if (keepRecentTokens !== undefined) override.keepRecentTokens = keepRecentTokens;
  return override;
}

/** Loads and validates `models.json`. */
export function loadModels(path: string = DEFAULT_MODELS_CONFIG): ModelSpec[] {
  const models = readArray(readJsonFile(path), path, readModel);
  if (models.length === 0) throw new ConfigError(`${path}: must list at least one model`);
  requireUnique(
    models.map((model) => model.label),
    `${path}: label`
  );
  return models;
}

function readModel(value: unknown, where: string): ModelSpec {
  const object = readObject(value, where);
  rejectUnknownKeys(object, where, ['label', 'model', 'thinking']);
  const label = requireIdentifier(readString(object.label, `${where}.label`), `${where}.label`);
  const model = readString(object.model, `${where}.model`);
  if (!/^[^/\s]+\/[^\s]+$/.test(model)) {
    throw new ConfigError(`${where}.model: ${JSON.stringify(model)} must be provider/modelId`);
  }
  return {
    label,
    model,
    thinking: readEnum(object.thinking, `${where}.thinking`, THINKING_LEVELS)
  };
}
