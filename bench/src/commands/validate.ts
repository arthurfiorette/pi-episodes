import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArgsError, parseArgs } from '../args.js';
import {
  assertKnownAnswerKeys,
  finalItems,
  leakStrings,
  parseTestSummary,
  readValidateJson,
  runFixture,
  runSuite,
  runTypecheck
} from '../checks.js';
import { Logger } from '../log.js';
import {
  ensureNodeModulesTemplate,
  ensureReferenceClone,
  featureRange,
  fixtureDir,
  git,
  restoreReferenceSources,
  runProcess,
  setupTrialRepo,
  snapshotForChecks,
  type TrialRepo
} from '../repo.js';
import { loadScenario, resolveScenarioDir } from '../scenario.js';
import type { PreChangeOutcome, Scenario, ValidateJson } from '../types.js';

export interface ValidateOptions {
  /** Gate repetitions. Default 3. */
  repeat?: number;
  /** Skip the full-suite runs (counts are then left at 0). */
  skipSuite?: boolean;
  /** Scratch directory; a temp dir by default. */
  workDir?: string;
  keep?: boolean;
  log?: Logger;
}

export interface GateRow {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ValidateResult extends ValidateJson {
  rows: GateRow[];
}

const FORBIDDEN_FILES = ['AGENTS.md', 'CLAUDE.md', '.pi', '.serena', '.cursorrules'];

function allFixtures(scenario: Scenario): { added: string[]; modified: string[] } {
  const added: string[] = [];
  const modified: string[] = [];
  for (const feature of scenario.features) {
    added.push(...feature.fixturesAdded);
    modified.push(...feature.fixturesModified);
  }
  return { added, modified };
}

/** Root type of a held-out fixture, from `assertValidSchema("<name>", "<type>")` in its test file. */
function fixtureRootType(scenario: Scenario, refClone: string, id: string): string | undefined {
  const dir = fixtureDir(scenario, id);
  for (const base of [join(scenario.dir, 'fixtures'), refClone]) {
    const file = join(base, dir, scenario.layout.test);
    if (!existsSync(file)) continue;
    const match = /assertValidSchema\(\s*"[^"]+",\s*"([^"]+)"/.exec(readFileSync(file, 'utf8'));
    return match?.[1];
  }
  return undefined;
}

const PRE_CHANGE_SCRIPT = `import path from "node:path";
import { createGenerator } from "./factory/generator.js";
const [dir, type] = process.argv.slice(2);
try {
  const schema = createGenerator({ path: path.resolve(dir, "*.ts"), type, skipTypeCheck: true }).createSchema(type);
  process.stdout.write(JSON.stringify({ threw: false, schema }));
} catch (error) {
  process.stdout.write(JSON.stringify({ threw: true, message: error instanceof Error ? error.message : String(error) }));
}
`;

/**
 * What the generator does for a held-out fixture on the sealed tree: the thrown message, or the
 * root definition's `description` when it produced a schema (the generator's "Failed to correctly
 * infer type" convention). Only for repos with `factory/generator.ts`.
 */
async function preChangeOutcome(
  snapshotDir: string,
  scenario: Scenario,
  id: string,
  rootType: string
): Promise<PreChangeOutcome | undefined> {
  if (!existsSync(join(snapshotDir, 'factory/generator.ts'))) return undefined;
  const script = join(snapshotDir, '__bench_prechange.ts');
  writeFileSync(script, PRE_CHANGE_SCRIPT);
  try {
    const result = await runProcess(
      'npx',
      ['tsx', '__bench_prechange.ts', fixtureDir(scenario, id), rootType],
      { cwd: snapshotDir, timeoutMs: 5 * 60 * 1000 }
    );
    const start = result.stdout.indexOf('{');
    if (result.exitCode !== 0 || start === -1) {
      return { threw: true, message: result.stderr.trim().split('\n')[0] ?? 'unknown' };
    }
    const parsed = JSON.parse(result.stdout.slice(start)) as PreChangeOutcome;
    if (parsed.threw) return { threw: true, message: parsed.message ?? '' };
    const outcome: PreChangeOutcome = { threw: false };
    const description = rootDescription(parsed.schema, rootType);
    if (description !== undefined) outcome.message = description;
    return outcome;
  } finally {
    rmSync(script, { force: true });
  }
}

function rootDescription(schema: unknown, rootType: string): string | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined;
  const definitions = (schema as { definitions?: Record<string, unknown> }).definitions ?? {};
  const candidates = rootType === '*' ? Object.values(definitions) : [definitions[rootType]];
  for (const definition of candidates) {
    const description = (definition as { description?: unknown } | undefined)?.description;
    if (typeof description === 'string') return description;
  }
  return undefined;
}

async function leakScan(trial: TrialRepo): Promise<GateRow[]> {
  const rows: GateRow[] = [];
  for (const needle of leakStrings(trial.scenario)) {
    // The vega-lite golden schema is upstream data (TS handbook URLs mention "type-predicates").
    const result = await git(
      trial.repoDir,
      ['grep', '-l', '-F', '-e', needle, '--', '.', ':(exclude)test/vega-lite/schema.json'],
      { allowFailure: true }
    );
    const files = result.stdout.trim();
    rows.push({
      name: `no leak: ${needle}`,
      ok: result.exitCode !== 0 || files.length === 0,
      detail: files.length > 0 ? files.split('\n').join(', ') : 'absent from the sealed tree'
    });
  }
  return rows;
}

/** Runs the two-sided gate (DESIGN 11) and writes `<scenario>/validate.json`. */
export async function validateScenario(
  scenario: Scenario,
  options: ValidateOptions = {}
): Promise<ValidateResult> {
  const log = options.log ?? new Logger({ stderr: false });
  const repeat = options.repeat ?? 3;
  const rows: GateRow[] = [];
  const result: ValidateResult = {
    scenario: scenario.id,
    validatedAt: new Date().toISOString(),
    repeats: repeat,
    suiteTests: { sealed: 0, restored: 0 },
    suiteDurationMs: { sealed: 0, restored: 0 },
    fixtureTests: {},
    fixtureRootTypes: {},
    preChange: {},
    ok: false,
    failures: [],
    rows
  };
  if (scenario.repo.baseCommit !== undefined) result.baseCommit = scenario.repo.baseCommit;
  // `--skip-suite` keeps the counts of the last full validation instead of recording zeros.
  const previous = options.skipSuite ? readValidateJson(scenario.dir) : undefined;
  if (previous !== undefined) {
    result.suiteTests = previous.suiteTests;
    result.suiteDurationMs = previous.suiteDurationMs;
  }
  const row = (name: string, ok: boolean, detail: string) => {
    rows.push({ name, ok, detail });
    log.log(ok ? 'info' : 'error', name, { ok, detail });
    return ok;
  };

  try {
    assertKnownAnswerKeys(scenario);
    row('answer keys known', true, '');
  } catch (error) {
    row('answer keys known', false, (error as Error).message);
  }

  const refClone = await ensureReferenceClone(scenario, log);
  const template = await ensureNodeModulesTemplate(refClone, log);
  if (scenario.repo.baseCommit !== undefined) {
    for (const feature of scenario.features) {
      const range = featureRange(feature);
      if (range === undefined) continue;
      const exists = await git(refClone, ['cat-file', '-e', `${range.to}^{commit}`], {
        allowFailure: true
      });
      if (!row(`commit ${feature.id}`, exists.exitCode === 0, feature.commit ?? '')) {
        return finish(scenario, result);
      }
    }
  }

  const workDir = options.workDir ?? mkdtempSync(join(tmpdir(), 'bench-validate-'));
  try {
    const setup = {
      refClone,
      log,
      ...(template !== undefined ? { nodeModulesTemplate: template } : {})
    };
    const sealed = await setupTrialRepo(scenario, join(workDir, 'sealed'), setup);
    const restored = await setupTrialRepo(scenario, join(workDir, 'restored'), setup);
    await restoreReferenceSources(restored);

    for (const name of FORBIDDEN_FILES) {
      row(`no ${name}`, !existsSync(join(sealed.repoDir, name)), '');
    }
    const { added, modified } = allFixtures(scenario);
    for (const id of added) {
      row(
        `held-out ${id} absent`,
        !existsSync(join(sealed.repoDir, fixtureDir(scenario, id))),
        fixtureDir(scenario, id)
      );
    }
    rows.push(...(await leakScan(sealed)));
    for (const id of [...added, ...modified]) {
      const rootType = fixtureRootType(scenario, refClone, id);
      if (rootType !== undefined) result.fixtureRootTypes[id] = rootType;
    }

    const heldOut = [...added, ...modified];
    // Fixtures a step checks must fail without the feature; others (deleted at setup but not
    // checked, like one that passes anyway) only need to pass on the restored side.
    const checked = finalItems(scenario).fixtures;
    const variantIds = scenario.variants.map((variant) => variant.id);
    const generated = scenario.variants.filter(
      (variant) =>
        variant.rootType !== undefined &&
        !existsSync(join(scenario.dir, 'variants', variant.id, scenario.layout.test))
    );

    // Variant schemas come from the reference implementation, never by hand (DESIGN 4).
    if (generated.length > 0) {
      const snapshot = await snapshotForChecks(restored, join(workDir, 'generate'), {
        fixtures: [],
        variants: variantIds
      });
      for (const variant of generated) {
        const run = await runFixture(snapshot.dir, scenario, `__bench_${variant.id}`, {
          UPDATE_SCHEMA: 'true'
        });
        const schema = join(
          snapshot.dir,
          fixtureDir(scenario, `__bench_${variant.id}`),
          'schema.json'
        );
        const ok = existsSync(schema);
        if (ok)
          writeFileSync(
            join(scenario.dir, 'variants', variant.id, 'schema.json'),
            readFileSync(schema)
          );
        row(
          `variant ${variant.id} schema generated`,
          ok,
          ok ? `variants/${variant.id}/schema.json` : run.command.tail || run.command.head
        );
      }
    }

    for (let round = 1; round <= repeat; round++) {
      const tag = `[${round}/${repeat}]`;

      // Sealed side: tsc passes, held-out and variant fixtures fail, the rest of the suite is green.
      const sealedSnap = await snapshotForChecks(sealed, join(workDir, 'sealed-snapshot'), {
        fixtures: heldOut,
        variants: variantIds
      });
      const sealedTsc = await runTypecheck(sealedSnap.dir, scenario);
      row(`${tag} sealed: typecheck passes`, sealedTsc.pass, `${sealedTsc.durationMs} ms`);
      const sealedCounts: Record<string, number> = {};
      for (const id of heldOut) {
        const run = await runFixture(sealedSnap.dir, scenario, id);
        sealedCounts[id] = parseTestSummary(run.result.stdout).tests ?? 0;
        row(
          checked.includes(id) ? `${tag} sealed: ${id} fails` : `${tag} sealed: ${id} (unchecked)`,
          !checked.includes(id) || run.outcome !== 'pass',
          `${run.outcome}, ${run.command.durationMs} ms`
        );
        if (round === 1) {
          const rootType = result.fixtureRootTypes[id];
          const outcome =
            rootType === undefined
              ? undefined
              : await preChangeOutcome(sealedSnap.dir, scenario, id, rootType);
          if (outcome !== undefined) {
            result.preChange[id] = outcome;
            log.info('pre-change outcome', { fixture: id, ...outcome });
          }
        }
      }
      for (const id of variantIds) {
        const run = await runFixture(sealedSnap.dir, scenario, `__bench_${id}`);
        row(
          `${tag} sealed: variant ${id} fails`,
          run.outcome !== 'pass',
          `${run.outcome}, ${run.command.durationMs} ms`
        );
      }
      if (!options.skipSuite) {
        const suiteSnap = await snapshotForChecks(sealed, join(workDir, 'sealed-suite'), {
          fixtures: [],
          variants: []
        });
        const suite = await runSuite(suiteSnap.dir, scenario, 1);
        result.suiteTests.sealed = suite.tests;
        result.suiteDurationMs.sealed = suite.durationMs;
        row(
          `${tag} sealed: suite green`,
          suite.pass,
          `tests ${suite.tests}, fail ${suite.fail}, ${suite.durationMs} ms`
        );
      }

      // Restored side: everything passes.
      const restoredSnap = await snapshotForChecks(restored, join(workDir, 'restored-snapshot'), {
        fixtures: heldOut,
        variants: variantIds
      });
      const restoredTsc = await runTypecheck(restoredSnap.dir, scenario);
      row(`${tag} restored: typecheck passes`, restoredTsc.pass, `${restoredTsc.durationMs} ms`);
      for (const id of heldOut) {
        const run = await runFixture(restoredSnap.dir, scenario, id);
        const tests = parseTestSummary(run.result.stdout).tests ?? 0;
        result.fixtureTests[id] = tests - (modified.includes(id) ? (sealedCounts[id] ?? 0) : 0);
        row(
          `${tag} restored: ${id} passes`,
          run.outcome === 'pass',
          `${run.outcome}, ${tests} tests, ${run.command.durationMs} ms`
        );
      }
      for (const id of variantIds) {
        const run = await runFixture(restoredSnap.dir, scenario, `__bench_${id}`);
        row(
          `${tag} restored: variant ${id} passes`,
          run.outcome === 'pass',
          `${run.outcome}, ${run.command.durationMs} ms`
        );
      }
      if (!options.skipSuite) {
        const suiteSnap = await snapshotForChecks(restored, join(workDir, 'restored-suite'), {
          fixtures: heldOut,
          variants: []
        });
        const suite = await runSuite(suiteSnap.dir, scenario, 1);
        result.suiteTests.restored = suite.tests;
        result.suiteDurationMs.restored = suite.durationMs;
        row(
          `${tag} restored: suite green`,
          suite.pass,
          `tests ${suite.tests}, fail ${suite.fail}, ${suite.durationMs} ms`
        );
        const delta = Object.values(result.fixtureTests).reduce((sum, n) => sum + n, 0);
        row(
          `${tag} suite counts add up`,
          result.suiteTests.sealed + delta === suite.tests,
          `sealed ${result.suiteTests.sealed} + held-out ${delta} = ${result.suiteTests.sealed + delta}, restored ${suite.tests}`
        );
      }
    }
  } catch (error) {
    row('gate', false, (error as Error).stack ?? String(error));
  } finally {
    if (!options.keep && options.workDir === undefined) {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
  return finish(scenario, result);
}

function finish(scenario: Scenario, result: ValidateResult): ValidateResult {
  result.failures = result.rows.filter((row) => !row.ok).map((row) => `${row.name}: ${row.detail}`);
  result.ok = result.failures.length === 0;
  const { rows, ...json } = result;
  writeFileSync(join(scenario.dir, 'validate.json'), `${JSON.stringify(json, null, 2)}\n`);
  return result;
}

export function formatTable(result: ValidateResult): string {
  const width = Math.max(...result.rows.map((row) => row.name.length));
  const lines = result.rows.map(
    (row) => `${row.ok ? 'ok  ' : 'FAIL'}  ${row.name.padEnd(width)}  ${row.detail}`
  );
  lines.push('');
  lines.push(
    `suite tests: sealed ${result.suiteTests.sealed} (${Math.round(result.suiteDurationMs.sealed / 1000)} s), restored ${result.suiteTests.restored} (${Math.round(result.suiteDurationMs.restored / 1000)} s)`
  );
  for (const [id, outcome] of Object.entries(result.preChange)) {
    lines.push(
      `pre-change ${id}: ${outcome.threw ? 'threw' : 'schema'} ${JSON.stringify(outcome.message ?? '')}`
    );
  }
  lines.push(result.ok ? 'gate: green' : `gate: ${result.failures.length} failure(s)`);
  return `${lines.join('\n')}\n`;
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv, ['skip-suite', 'keep', 'quiet']);
  args.assertKnown(['repeat', 'skip-suite', 'keep', 'quiet']);
  const target = args.positionals[0];
  if (target === undefined) throw new ArgsError('scenario id or path required');
  const scenario = loadScenario(resolveScenarioDir(target));
  const options: ValidateOptions = {
    log: new Logger({ stderr: !args.flag('quiet') }),
    keep: args.flag('keep'),
    skipSuite: args.flag('skip-suite')
  };
  const repeat = args.number('repeat');
  if (repeat !== undefined) options.repeat = repeat;
  const result = await validateScenario(scenario, options);
  process.stdout.write(formatTable(result));
  return result.ok ? 0 : 1;
}
