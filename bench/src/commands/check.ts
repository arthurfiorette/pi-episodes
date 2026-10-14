import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArgsError, parseArgs } from '../args.js';
import { assembleChecks, finalItems, runFinalChecks, type SessionOutcome } from '../checks.js';
import { loadRunConfig, RESULTS_DIR } from '../config.js';
import { ConfigError } from '../fields.js';
import { scoresOf } from '../hooks.js';
import { Logger } from '../log.js';
import { writeMetricsJson } from '../metrics.js';
import { extractFinalTree, snapshotForChecks } from '../repo.js';
import { loadScenario, resolveScenarioDir } from '../scenario.js';
import type { ChecksJson, RunConfig, Scenario, TrialJson } from '../types.js';

export interface RegradeOptions {
  config: RunConfig;
  log?: Logger;
  /** Scratch directory; a temp dir by default. */
  workDir?: string;
}

/** Session-derived inputs the final tree cannot reproduce; taken from the old `checks.json` and `trial.json`. */
function sessionOutcome(
  trial: TrialJson | undefined,
  previous: ChecksJson | undefined
): SessionOutcome {
  const outcome: SessionOutcome = {};
  const category = trial?.harness?.category ?? trial?.category ?? previous?.category;
  if (category === 'infra') outcome.infra = true;
  if (category === 'context_overflow') outcome.contextOverflow = true;
  const ends = trial?.steps.map((step) => step.end) ?? [];
  if (ends.includes('timeout') || category === 'timeout') outcome.timeout = true;
  if (ends.includes('turn_cap') || category === 'turn_cap') outcome.turnCap = true;
  const escaped = [...(previous?.steps ?? []), ...(previous?.final ? [previous.final] : [])]
    .flatMap((checks) => checks.flags)
    .filter((hit) => hit.flag === 'escaped_tree');
  if (previous?.flags.includes('escaped_tree') && escaped.length === 0) {
    outcome.sessionFlags = [{ flag: 'escaped_tree', lines: ['(from the original run)'] }];
  }
  return outcome;
}

/**
 * Rewrites `trial.json` (category, flags, scores) and `metrics.json` from a regraded or
 * re-scored `checks.json`, so the report, which reads `metrics.json` first, sees the change.
 * `bench judge` uses it too after merging judged probe answers.
 */
export function propagateChecks(trialDir: string, checks: ChecksJson): void {
  const trialFile = join(trialDir, 'trial.json');
  let record: TrialJson | undefined;
  if (existsSync(trialFile)) {
    record = JSON.parse(readFileSync(trialFile, 'utf8')) as TrialJson;
    record.category = checks.category;
    record.flags = checks.flags;
    record.scores = scoresOf(checks);
    for (const answer of checks.answers) {
      const step = record.steps?.find((candidate) => candidate.id === answer.stepId);
      if (step !== undefined && answer.pass !== undefined) step.answerPass = answer.pass;
    }
    writeFileSync(trialFile, `${JSON.stringify(record, null, 2)}\n`);
  }
  writeMetricsJson(trialDir, { ...record, steps: record?.steps ?? [] }, checks);
}

/** Regrades one trial dir from its `final-tree.tar.gz`; rewrites `checks.json`, `trial.json` and `metrics.json`, keeps step checks and answers. */
export async function regradeTrial(
  trialDir: string,
  scenario: Scenario,
  options: RegradeOptions
): Promise<ChecksJson> {
  const log = options.log ?? new Logger({ stderr: false });
  const tarball = join(trialDir, 'final-tree.tar.gz');
  if (!existsSync(tarball)) throw new Error(`${trialDir}: no final-tree.tar.gz`);
  const checksFile = join(trialDir, 'checks.json');
  const trialFile = join(trialDir, 'trial.json');
  const previous = existsSync(checksFile)
    ? (JSON.parse(readFileSync(checksFile, 'utf8')) as ChecksJson)
    : undefined;
  const trial = existsSync(trialFile)
    ? (JSON.parse(readFileSync(trialFile, 'utf8')) as TrialJson)
    : undefined;

  const workDir = options.workDir ?? mkdtempSync(join(tmpdir(), 'bench-check-'));
  try {
    const repo = await extractFinalTree(scenario, tarball, workDir, { log });
    const snapshot = await snapshotForChecks(repo, join(workDir, 'final'), finalItems(scenario));
    const final = await runFinalChecks(snapshot, scenario, options.config, { trial: repo, log });
    const checks = assembleChecks(
      previous?.steps ?? [],
      final,
      previous?.answers ?? [],
      sessionOutcome(trial, previous)
    );
    writeFileSync(checksFile, `${JSON.stringify(checks, null, 2)}\n`);
    propagateChecks(trialDir, checks);
    return checks;
  } finally {
    if (options.workDir === undefined) rmSync(workDir, { recursive: true, force: true });
  }
}

interface ManifestView {
  scenarios?: { id: string; dir: string }[];
  config?: RunConfig;
}

/** Chain id to scenario dir and the config as `bench run` recorded them; a run may have been given a scenario path. */
function readManifest(runDir: string): ManifestView {
  const path = join(runDir, 'manifest.json');
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as ManifestView;
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  args.assertKnown(['trial', 'config']);
  const runId = args.positionals[0];
  if (runId === undefined) throw new ArgsError('run id required');
  const runDir = join(RESULTS_DIR, runId);
  const trialsDir = join(runDir, 'trials');
  if (!existsSync(trialsDir)) throw new ConfigError(`no such run: ${runDir}`);
  const only = args.string('trial');
  const names = readdirSync(trialsDir)
    .filter((name) => only === undefined || name === only)
    .sort();
  if (names.length === 0) throw new ConfigError(`no trial ${only ?? ''} under ${trialsDir}`);
  const manifest = readManifest(runDir);
  // The run's own config (its `checks.fullSuite`) regrades it, unless another is named.
  const configPath = args.string('config');
  const config =
    configPath !== undefined ? loadRunConfig(configPath) : (manifest.config ?? loadRunConfig());
  const log = new Logger({ stderr: true });
  const scenarioDirs = Object.fromEntries(
    (manifest.scenarios ?? []).map((entry) => [entry.id, entry.dir])
  );
  let failures = 0;
  for (const name of names) {
    const trialDir = join(trialsDir, name);
    const trialFile = join(trialDir, 'trial.json');
    if (!existsSync(trialFile)) {
      log.warn('skipping trial without trial.json', { trial: name });
      continue;
    }
    const trial = JSON.parse(readFileSync(trialFile, 'utf8')) as TrialJson;
    const scenario = loadScenario(scenarioDirs[trial.chain] ?? resolveScenarioDir(trial.chain));
    try {
      const checks = await regradeTrial(trialDir, scenario, {
        config,
        log: log.child({ trial: name })
      });
      process.stdout.write(
        `${name}: ${checks.category} score_code=${checks.scoreCode?.toFixed(2) ?? '-'} flags=${checks.flags.join(',') || '-'}\n`
      );
    } catch (error) {
      failures++;
      log.error('regrade failed', { trial: name, error: (error as Error).message });
    }
  }
  return failures === 0 ? 0 : 1;
}
