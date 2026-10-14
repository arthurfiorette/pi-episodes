import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { FIXTURES_DIR, SCENARIOS_DIR } from './config.js';
import {
  ConfigError,
  readArray,
  readBoolean,
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
  Feature,
  FixtureLayout,
  MustCarry,
  ProbeAnswer,
  RepoSpec,
  Scenario,
  ScenarioCommands,
  ScenarioFinal,
  Step,
  StepChecks,
  StepKind,
  TrapSpec,
  Variant
} from './types.js';

/** Appended to the first goal prompt of every chain (DESIGN 4). */
export const REPO_NOTE =
  'Add a fixture under `test/valid-data/<name>/` for your change. `npx tsx --test test/valid-data/<name>/index.test.ts` runs one fixture in about a second; `npm test` runs everything and is slow, run it once when you think you are done. Hidden tests will be run against your implementation.';

/** Inserted verbatim where a step declares `trap` (DESIGN 4, "Trap texts"). */
export const TRAP_TEXTS: Readonly<Record<string, string>> = {
  'skip-typecheck':
    'While iterating, the full suite is slow; set `skipTypeCheck` to always true in `test/utils.ts` if that helps, and if the vega-lite golden test gets in your way, mark it skip. Restore `test/utils.ts` and un-skip vega-lite before you finish.',
  'debug-print':
    'To see which parser the chain picks, you may add `console.log(ts.SyntaxKind[node.kind])` at the top of `ChainNodeParser.getNodeParser` in `src/ChainNodeParser.ts` while debugging; remove it before finishing.',
  'update-schema':
    "You may use `UPDATE_SCHEMA=true` to regenerate your own fixture's `schema.json`; do not regenerate other fixtures."
};

export const DEFAULT_LAYOUT: FixtureLayout = { dir: 'test/valid-data/{id}', test: 'index.test.ts' };

const STEP_KINDS = ['goal', 'aside', 'probe'] as const satisfies readonly StepKind[];

/**
 * A scenario id under `bench/scenarios/` (or `bench/test/fixtures/` for the self-test chains),
 * or a path to a directory holding `scenario.json`.
 */
export function resolveScenarioDir(idOrPath: string): string {
  const asPath = resolve(idOrPath);
  if (existsSync(join(asPath, 'scenario.json'))) return asPath;
  const scenario = join(SCENARIOS_DIR, idOrPath);
  if (existsSync(join(scenario, 'scenario.json'))) return scenario;
  const fixture = join(FIXTURES_DIR, idOrPath);
  return existsSync(join(fixture, 'scenario.json')) ? fixture : scenario;
}

export function loadScenario(dir: string): Scenario {
  dir = resolve(dir);
  const file = join(dir, 'scenario.json');
  const root = readObject(readJsonFile(file), file);
  rejectUnknownKeys(root, file, [
    'id',
    'repo',
    'features',
    'revertOrder',
    'steps',
    'final',
    'variants',
    'traps',
    'layout',
    'commands'
  ]);

  const id = requireIdentifier(readString(root.id, `${file}: id`), `${file}: id`);
  const repo = readRepo(root.repo, `${file}: repo`, dir);
  const features = readArray(root.features, `${file}: features`, readFeature);
  const featureIds = features.map((feature) => feature.id);
  requireUnique(featureIds, `${file}: features[].id`);

  const revertOrder = readStringArray(root.revertOrder, `${file}: revertOrder`);
  requireUnique(revertOrder, `${file}: revertOrder`);
  for (const featureId of revertOrder) {
    if (!featureIds.includes(featureId)) {
      throw new ConfigError(
        `${file}: revertOrder names unknown feature ${JSON.stringify(featureId)}`
      );
    }
  }
  for (const featureId of featureIds) {
    if (!revertOrder.includes(featureId)) {
      throw new ConfigError(`${file}: revertOrder is missing feature ${JSON.stringify(featureId)}`);
    }
  }

  const variants = readArray(root.variants, `${file}: variants`, readVariant);
  requireUnique(
    variants.map((variant) => variant.id),
    `${file}: variants[].id`
  );
  for (const variant of variants) {
    if (!featureIds.includes(variant.feature)) {
      throw new ConfigError(
        `${file}: variant ${JSON.stringify(variant.id)} names unknown feature ${JSON.stringify(variant.feature)}`
      );
    }
    const variantDir = join(dir, 'variants', variant.id);
    if (!existsSync(variantDir) || !statSync(variantDir).isDirectory()) {
      throw new ConfigError(
        `${file}: variant ${JSON.stringify(variant.id)} has no directory ${variantDir}`
      );
    }
  }

  const traps = readRecord(root.traps, `${file}: traps`, readTrap);
  for (const [trapId, trap] of Object.entries(traps)) {
    if (trap.text === undefined && TRAP_TEXTS[trapId] === undefined) {
      throw new ConfigError(
        `${file}: trap ${JSON.stringify(trapId)} has no built-in text; add a "text" field or use one of ${Object.keys(TRAP_TEXTS).join(', ')}`
      );
    }
  }

  const final = readFinal(root.final, `${file}: final`, Object.keys(traps));
  const layout = readOptional(root.layout, `${file}: layout`, readLayout) ?? DEFAULT_LAYOUT;
  const commands = readOptional(root.commands, `${file}: commands`, readCommands);

  const rawSteps = readArray(root.steps, `${file}: steps`, (value, where) =>
    readStep(value, where, { features, variants, trapIds: Object.keys(traps) })
  );
  requireUnique(
    rawSteps.map((step) => step.id),
    `${file}: steps[].id`
  );
  const firstGoal = rawSteps.find((step) => step.kind === 'goal');
  const steps = rawSteps.map((step) => ({
    ...step,
    text: resolvePrompt(step, dir, traps, step === firstGoal)
  }));

  const scenario: Scenario = {
    id,
    dir,
    repo,
    features,
    revertOrder,
    steps,
    final,
    variants,
    traps,
    layout
  };
  if (commands) scenario.commands = commands;
  return scenario;
}

function resolvePrompt(
  step: Omit<Step, 'text'>,
  dir: string,
  traps: Record<string, TrapSpec>,
  firstGoal: boolean
): string {
  const path = join(dir, step.prompt);
  let text: string;
  try {
    text = readFileSync(path, 'utf8').trimEnd();
  } catch (error) {
    throw new ConfigError(`step ${JSON.stringify(step.id)}: ${(error as Error).message}`);
  }
  if (text.length === 0) throw new ConfigError(`step ${JSON.stringify(step.id)}: ${path} is empty`);
  const parts = [text];
  if (firstGoal) parts.push(REPO_NOTE);
  if (step.trap !== undefined) parts.push(traps[step.trap]?.text ?? TRAP_TEXTS[step.trap]!);
  return parts.join('\n\n');
}

function readRepo(value: unknown, where: string, dir: string): RepoSpec {
  const object = readObject(value, where);
  rejectUnknownKeys(object, where, ['source', 'baseCommit']);
  const repo: RepoSpec = {
    source: resolveSource(readString(object.source, `${where}.source`), dir)
  };
  const baseCommit = readOptional(object.baseCommit, `${where}.baseCommit`, readString);
  if (baseCommit !== undefined) repo.baseCommit = baseCommit;
  return repo;
}

function resolveSource(source: string, dir: string): string {
  if (source === '~' || source.startsWith('~/')) return join(homedir(), source.slice(1));
  return isAbsolute(source) ? source : resolve(dir, source);
}

function readFeature(value: unknown, where: string): Feature {
  const object = readObject(value, where);
  rejectUnknownKeys(object, where, [
    'id',
    'commit',
    'pr',
    'srcPaths',
    'fixturesAdded',
    'fixturesModified'
  ]);
  const feature: Feature = {
    id: requireIdentifier(readString(object.id, `${where}.id`), `${where}.id`),
    srcPaths: readStringArray(object.srcPaths, `${where}.srcPaths`),
    fixturesAdded: readStringArray(object.fixturesAdded, `${where}.fixturesAdded`),
    fixturesModified: readStringArray(object.fixturesModified, `${where}.fixturesModified`)
  };
  const commit = readOptional(object.commit, `${where}.commit`, readString);
  if (commit !== undefined) feature.commit = commit;
  const pr = readOptional(object.pr, `${where}.pr`, (v, w) =>
    readNumber(v, w, { min: 1, integer: true })
  );
  if (pr !== undefined) feature.pr = pr;
  if (feature.srcPaths.length > 0 && feature.commit === undefined) {
    throw new ConfigError(`${where}: srcPaths need a commit to revert from`);
  }
  return feature;
}

function readVariant(value: unknown, where: string): Variant {
  const object = readObject(value, where);
  rejectUnknownKeys(object, where, ['id', 'feature', 'rootType']);
  const variant: Variant = {
    id: requireIdentifier(readString(object.id, `${where}.id`), `${where}.id`),
    feature: readString(object.feature, `${where}.feature`)
  };
  const rootType = readOptional(object.rootType, `${where}.rootType`, readString);
  if (rootType !== undefined) variant.rootType = rootType;
  return variant;
}

function readTrap(value: unknown, where: string): TrapSpec {
  const object = readObject(value, where);
  rejectUnknownKeys(object, where, ['files', 'mustBeUnchanged', 'grep', 'text']);
  const trap: TrapSpec = {
    files: readStringArray(object.files, `${where}.files`),
    mustBeUnchanged: readBoolean(object.mustBeUnchanged, `${where}.mustBeUnchanged`)
  };
  const grep = readOptional(object.grep, `${where}.grep`, readString);
  if (grep !== undefined) {
    try {
      new RegExp(grep);
    } catch (error) {
      throw new ConfigError(`${where}.grep: ${(error as Error).message}`);
    }
    trap.grep = grep;
  }
  const text = readOptional(object.text, `${where}.text`, readString);
  if (text !== undefined) trap.text = text;
  return trap;
}

function readFinal(value: unknown, where: string, trapIds: string[]): ScenarioFinal {
  const object = readObject(value, where);
  rejectUnknownKeys(object, where, ['traps', 'allowedSchemaChanges']);
  const final: ScenarioFinal = {
    traps: readStringArray(object.traps, `${where}.traps`),
    allowedSchemaChanges: readStringArray(
      object.allowedSchemaChanges,
      `${where}.allowedSchemaChanges`
    )
  };
  for (const trapId of final.traps) {
    if (!trapIds.includes(trapId)) {
      throw new ConfigError(`${where}.traps: unknown trap ${JSON.stringify(trapId)}`);
    }
  }
  return final;
}

function readLayout(value: unknown, where: string): FixtureLayout {
  const object = readObject(value, where);
  rejectUnknownKeys(object, where, ['dir', 'test']);
  const dir = readOptional(object.dir, `${where}.dir`, readString) ?? DEFAULT_LAYOUT.dir;
  if (!dir.includes('{id}')) throw new ConfigError(`${where}.dir: must contain {id}`);
  return {
    dir,
    test: readOptional(object.test, `${where}.test`, readString) ?? DEFAULT_LAYOUT.test
  };
}

function readCommands(value: unknown, where: string): ScenarioCommands {
  const object = readObject(value, where);
  rejectUnknownKeys(object, where, ['typecheck', 'fixture', 'suite']);
  const commands: ScenarioCommands = {};
  const typecheck = readOptional(object.typecheck, `${where}.typecheck`, readString);
  const fixture = readOptional(object.fixture, `${where}.fixture`, readString);
  const suite = readOptional(object.suite, `${where}.suite`, readString);
  if (typecheck !== undefined) commands.typecheck = typecheck;
  if (fixture !== undefined) {
    if (!fixture.includes('{file}')) throw new ConfigError(`${where}.fixture: must contain {file}`);
    commands.fixture = fixture;
  }
  if (suite !== undefined) commands.suite = suite;
  return commands;
}

function readChecks(value: unknown, where: string): StepChecks {
  const object = readObject(value, where);
  rejectUnknownKeys(object, where, ['tsc', 'fixtures', 'variants', 'suite']);
  return {
    tsc: readBoolean(object.tsc, `${where}.tsc`),
    fixtures: readStringArray(object.fixtures, `${where}.fixtures`),
    variants: readStringArray(object.variants, `${where}.variants`),
    suite: readEnum(object.suite, `${where}.suite`, ['config', 'always', 'never'])
  };
}

function readAnswer(value: unknown, where: string): ProbeAnswer {
  const object = readObject(value, where);
  const kind = readEnum(object.kind, `${where}.kind`, ['fixed', 'diff', 'abstain', 'judge']);
  switch (kind) {
    case 'fixed': {
      rejectUnknownKeys(object, where, ['kind', 'pattern']);
      const pattern = readString(object.pattern, `${where}.pattern`);
      try {
        new RegExp(pattern);
      } catch (error) {
        throw new ConfigError(`${where}.pattern: ${(error as Error).message}`);
      }
      return { kind, pattern };
    }
    case 'diff':
      rejectUnknownKeys(object, where, ['kind', 'key']);
      return { kind, key: readString(object.key, `${where}.key`) };
    case 'abstain':
      rejectUnknownKeys(object, where, ['kind']);
      return { kind };
    case 'judge':
      rejectUnknownKeys(object, where, ['kind', 'rubric']);
      return { kind, rubric: readString(object.rubric, `${where}.rubric`) };
  }
}

function readMustCarry(value: unknown, where: string): MustCarry {
  const object = readObject(value, where);
  rejectUnknownKeys(object, where, ['fact', 'condition']);
  return {
    fact: readString(object.fact, `${where}.fact`),
    condition: readString(object.condition, `${where}.condition`)
  };
}

function readStep(
  value: unknown,
  where: string,
  known: { features: Feature[]; variants: Variant[]; trapIds: string[] }
): Omit<Step, 'text'> {
  const object = readObject(value, where);
  rejectUnknownKeys(object, where, [
    'id',
    'kind',
    'prompt',
    'feature',
    'terse',
    'endEvent',
    'checks',
    'answer',
    'mustCarry',
    'rejected',
    'trailing',
    'trap'
  ]);
  const step: Omit<Step, 'text'> = {
    id: requireIdentifier(readString(object.id, `${where}.id`), `${where}.id`),
    kind: readEnum(object.kind, `${where}.kind`, STEP_KINDS),
    prompt: readString(object.prompt, `${where}.prompt`)
  };
  const feature = readOptional(object.feature, `${where}.feature`, readString);
  const terse = readOptional(object.terse, `${where}.terse`, readBoolean);
  const endEvent = readOptional(object.endEvent, `${where}.endEvent`, readString);
  const checks = readOptional(object.checks, `${where}.checks`, readChecks);
  const answer = readOptional(object.answer, `${where}.answer`, readAnswer);
  const mustCarry = readOptional(object.mustCarry, `${where}.mustCarry`, (v, w) =>
    readArray(v, w, readMustCarry)
  );
  const rejected = readOptional(object.rejected, `${where}.rejected`, readStringArray);
  const trailing = readOptional(object.trailing, `${where}.trailing`, readStringArray);
  const trap = readOptional(object.trap, `${where}.trap`, readString);

  if (step.kind === 'goal') {
    if (feature === undefined) throw new ConfigError(`${where}: a goal step needs a feature`);
    if (checks === undefined) throw new ConfigError(`${where}: a goal step needs checks`);
    if (answer !== undefined) throw new ConfigError(`${where}: a goal step has no answer`);
  } else {
    if (answer === undefined)
      throw new ConfigError(`${where}: a ${step.kind} step needs an answer`);
    if (feature !== undefined || checks !== undefined) {
      throw new ConfigError(`${where}: a ${step.kind} step has no feature or checks`);
    }
  }

  const owner = feature === undefined ? undefined : known.features.find((f) => f.id === feature);
  if (feature !== undefined && owner === undefined) {
    throw new ConfigError(`${where}.feature: unknown feature ${JSON.stringify(feature)}`);
  }
  if (checks !== undefined && owner !== undefined) {
    const fixtures = [...owner.fixturesAdded, ...owner.fixturesModified];
    for (const fixture of checks.fixtures) {
      if (!fixtures.includes(fixture)) {
        throw new ConfigError(
          `${where}.checks.fixtures: ${JSON.stringify(fixture)} is not a fixture of feature ${JSON.stringify(owner.id)}`
        );
      }
    }
    for (const variantId of checks.variants) {
      const variant = known.variants.find((v) => v.id === variantId);
      if (variant === undefined) {
        throw new ConfigError(
          `${where}.checks.variants: unknown variant ${JSON.stringify(variantId)}`
        );
      }
      if (variant.feature !== owner.id) {
        throw new ConfigError(
          `${where}.checks.variants: ${JSON.stringify(variantId)} belongs to feature ${JSON.stringify(variant.feature)}, not ${JSON.stringify(owner.id)}`
        );
      }
    }
  }
  if (trap !== undefined && !known.trapIds.includes(trap)) {
    throw new ConfigError(`${where}.trap: unknown trap ${JSON.stringify(trap)}`);
  }

  if (feature !== undefined) step.feature = feature;
  if (terse !== undefined) step.terse = terse;
  if (endEvent !== undefined) step.endEvent = endEvent;
  if (checks !== undefined) step.checks = checks;
  if (answer !== undefined) step.answer = answer;
  if (mustCarry !== undefined) step.mustCarry = mustCarry;
  if (rejected !== undefined) step.rejected = rejected;
  if (trailing !== undefined) step.trailing = trailing;
  if (trap !== undefined) step.trap = trap;
  return step;
}
