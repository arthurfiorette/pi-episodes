import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { CACHE_DIR } from './config.js';
import type { Logger } from './log.js';
import type { AgentDiff, DiffFile, Feature, Scenario, Snapshot, Variant } from './types.js';

/** Setup, snapshot or archive failed; the trial is `infra` (DESIGN 5.6). */
export class RepoError extends Error {}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

export interface ProcessResult {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  /** Kills the whole process group when exceeded. */
  timeoutMs?: number;
}

const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'bench',
  GIT_AUTHOR_EMAIL: 'bench@localhost',
  GIT_COMMITTER_NAME: 'bench',
  GIT_COMMITTER_EMAIL: 'bench@localhost'
};

/** Process groups still running; killed when this process exits so no suite outlives `bench`. */
const running = new Set<number>();

/**
 * SIGKILLs every process group `runProcess` started and has not seen close. Node emits `exit`
 * only on a normal exit, so the signal handlers in `bench run` call this as well.
 */
export function killRunningProcesses(): number {
  let killed = 0;
  for (const pid of running) {
    try {
      process.kill(-pid, 'SIGKILL');
      killed++;
    } catch {}
  }
  return killed;
}
process.once('exit', () => {
  killRunningProcesses();
});

export function runProcess(
  file: string,
  args: string[],
  options: ProcessOptions
): Promise<ProcessResult> {
  const started = Date.now();
  const command = [file, ...args].join(' ');
  return new Promise((resolvePromise) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
    const child = spawn(file, args, {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true
    });
    if (child.pid !== undefined) running.add(child.pid);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      }, options.timeoutMs);
    }
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      if (child.pid !== undefined) running.delete(child.pid);
      resolvePromise({
        command,
        exitCode: null,
        signal: null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: `${Buffer.concat(stderr).toString('utf8')}${error.message}\n`,
        durationMs: Date.now() - started,
        timedOut
      });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (child.pid !== undefined) running.delete(child.pid);
      resolvePromise({
        command,
        exitCode: code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Date.now() - started,
        timedOut
      });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/**
 * Runs `command` through `/bin/sh -c` with colors off. `NODE_TEST_CONTEXT` is dropped: when the
 * caller itself runs under `node --test`, a child `node --test` would otherwise inherit it and
 * emit the serialized reporter protocol instead of text.
 */
export function runShell(command: string, options: ProcessOptions): Promise<ProcessResult> {
  return runProcess('/bin/sh', ['-c', command], {
    ...options,
    env: { NO_COLOR: '1', FORCE_COLOR: '0', ...options.env, NODE_TEST_CONTEXT: undefined }
  });
}

/** Runs git with the user's config disabled; throws `RepoError` on a non-zero exit. */
export async function git(
  cwd: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {}
): Promise<ProcessResult> {
  const result = await runProcess('git', args, {
    cwd,
    env: { ...GIT_ENV, ...options.env },
    ...(options.input !== undefined ? { input: options.input } : {}),
    timeoutMs: 10 * 60 * 1000
  });
  if (result.exitCode !== 0 && !options.allowFailure) {
    throw new RepoError(
      `git ${args.join(' ')} in ${cwd} exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Reference clone and node_modules template (DESIGN 5.1)
// ---------------------------------------------------------------------------

function sha12(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/** `bench/cache/repo/<hash>` for a repo with history; the scenario's template dir otherwise. */
export function referenceCloneDir(scenario: Scenario): string {
  if (scenario.repo.baseCommit === undefined) return scenario.repo.source;
  return join(CACHE_DIR, 'repo', sha12(`${scenario.repo.source}@${scenario.repo.baseCommit}`));
}

/**
 * Clones `scenario.repo.source` at `baseCommit` into the cache once per machine. The clone is
 * only ever read from; trial repos are copies of it.
 */
export async function ensureReferenceClone(scenario: Scenario, log?: Logger): Promise<string> {
  const dir = referenceCloneDir(scenario);
  const baseCommit = scenario.repo.baseCommit;
  if (baseCommit === undefined) {
    if (!existsSync(dir)) throw new RepoError(`repo template ${dir} does not exist`);
    return dir;
  }
  if (existsSync(join(dir, '.git'))) {
    const head = await git(dir, ['rev-parse', 'HEAD'], { allowFailure: true });
    if (head.exitCode === 0 && head.stdout.trim() === baseCommit) return dir;
    log?.warn('reference clone is not at the base commit; recloning', { dir });
    rmSync(dir, { recursive: true, force: true });
  } else if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!existsSync(scenario.repo.source)) {
    throw new RepoError(`repo source ${scenario.repo.source} does not exist`);
  }
  log?.info('cloning reference repo', { source: scenario.repo.source, dir });
  mkdirSync(dirname(dir), { recursive: true });
  // Clone into a scratch dir and rename, so two `bench` processes starting on a fresh machine
  // do not both clone into `dir` (the second `git clone` would fail on the existing directory).
  const scratch = `${dir}.clone-${process.pid}`;
  rmSync(scratch, { recursive: true, force: true });
  await git(dirname(dir), ['clone', '-q', '--no-checkout', scenario.repo.source, scratch]);
  await git(scratch, ['checkout', '-q', '--detach', baseCommit]);
  if (existsSync(dir)) rmSync(scratch, { recursive: true, force: true });
  else renameSync(scratch, dir);
  return dir;
}

/** Hash of the lockfile; the template directory is keyed by it. */
export function nodeModulesTemplateDir(refClone: string): string | undefined {
  const lockfile = join(refClone, 'package-lock.json');
  if (!existsSync(lockfile)) return undefined;
  return join(CACHE_DIR, `node_modules-${sha12(readFileSync(lockfile, 'utf8'))}`);
}

/**
 * `bench/cache/node_modules-<lockfile sha>`, built once with `npm ci --ignore-scripts` in a
 * scratch dir that holds only the manifests, with an isolated npm cache. Undefined when the repo
 * has no `package-lock.json` (mini-chain).
 */
export async function ensureNodeModulesTemplate(
  refClone: string,
  log?: Logger
): Promise<string | undefined> {
  const dir = nodeModulesTemplateDir(refClone);
  if (dir === undefined) return undefined;
  if (existsSync(dir)) return dir;
  const scratch = `${dir}.build-${process.pid}`;
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  for (const name of ['package.json', 'package-lock.json', '.npmrc']) {
    const source = join(refClone, name);
    if (existsSync(source)) cpSync(source, join(scratch, name));
  }
  log?.info('building node_modules template', { dir });
  // The run's isolated env sets `npm_config_offline=true` process-wide (session.ts); this is
  // the one install that seeds the cache, so it must be allowed online.
  const result = await runProcess(
    'npm',
    ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(CACHE_DIR, 'npm')],
    { cwd: scratch, env: { npm_config_offline: undefined }, timeoutMs: 20 * 60 * 1000 }
  );
  if (result.exitCode !== 0) {
    rmSync(scratch, { recursive: true, force: true });
    throw new RepoError(`npm ci failed (${result.exitCode}): ${result.stderr.trim()}`);
  }
  if (existsSync(dir)) {
    rmSync(scratch, { recursive: true, force: true });
    return dir;
  }
  renameSync(join(scratch, 'node_modules'), dir);
  rmSync(scratch, { recursive: true, force: true });
  log?.info('node_modules template ready', { dir, durationMs: result.durationMs });
  return dir;
}

// ---------------------------------------------------------------------------
// Tree copies
// ---------------------------------------------------------------------------

/** Copies a directory tree; APFS clones on macOS (`cp -Rc`), a plain copy elsewhere. */
export async function cloneTree(source: string, dest: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  if (process.platform === 'darwin') {
    const result = await runProcess('cp', ['-Rc', source, dest], { cwd: dirname(dest) });
    if (result.exitCode === 0) return;
    rmSync(dest, { recursive: true, force: true });
  }
  cpSync(source, dest, { recursive: true, verbatimSymlinks: true });
}

function copyExcluding(source: string, dest: string, excluded: string[]): void {
  cpSync(source, dest, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (path) => !excluded.includes(basename(path)) || path === source
  });
}

export function fixtureDir(scenario: Scenario, id: string): string {
  return scenario.layout.dir.replaceAll('{id}', id);
}

/** `{ from, to }` revisions whose diff is the feature; `commit` may be `A..B` for a range. */
export function featureRange(feature: Feature): { from: string; to: string } | undefined {
  if (feature.commit === undefined) return undefined;
  const range = /^(.+?)\.\.(.+)$/.exec(feature.commit);
  if (range) return { from: range[1]!, to: range[2]! };
  return { from: `${feature.commit}^`, to: feature.commit };
}

// ---------------------------------------------------------------------------
// Trial setup (DESIGN 5.1 steps 2 to 4)
// ---------------------------------------------------------------------------

export interface TrialRepo {
  scenario: Scenario;
  refClone: string;
  /** `<trialDir>/repo`. */
  repoDir: string;
  /** Tree hash of the sealed init commit. */
  baseTree: string;
}

export interface SetupOptions {
  refClone?: string;
  nodeModulesTemplate?: string;
  log?: Logger;
}

const SETUP_CLUTTER = ['dist', '.serena', '.pi', 'coverage'];

/**
 * Copies the reference clone to `<trialDir>/repo`, reverts the features in `revertOrder`,
 * removes held-out fixtures and build output, then seals the history to one commit.
 */
export async function setupTrialRepo(
  scenario: Scenario,
  trialDir: string,
  options: SetupOptions = {}
): Promise<TrialRepo> {
  const log = options.log;
  const refClone = options.refClone ?? (await ensureReferenceClone(scenario, log));
  const template = options.nodeModulesTemplate ?? (await ensureNodeModulesTemplate(refClone, log));
  const repoDir = join(trialDir, 'repo');
  rmSync(repoDir, { recursive: true, force: true });
  mkdirSync(trialDir, { recursive: true });
  await cloneTree(refClone, repoDir);
  rmSync(join(repoDir, 'node_modules'), { recursive: true, force: true });
  if (template !== undefined) await cloneTree(template, join(repoDir, 'node_modules'));
  // The copied index carries the reference clone's stat data; `apply --3way` needs it current.
  if (existsSync(join(repoDir, '.git'))) {
    await git(repoDir, ['update-index', '-q', '--refresh'], { allowFailure: true });
  }

  for (const featureId of scenario.revertOrder) {
    const feature = scenario.features.find((f) => f.id === featureId)!;
    const range = featureRange(feature);
    if (range === undefined || feature.srcPaths.length === 0) continue;
    const patch = await git(refClone, ['diff', range.from, range.to, '--', ...feature.srcPaths]);
    if (patch.stdout.trim().length === 0) {
      throw new RepoError(`feature ${feature.id}: empty diff for ${feature.srcPaths.join(', ')}`);
    }
    await git(repoDir, ['apply', '-R', '--3way', '--whitespace=nowarn'], { input: patch.stdout });
    log?.debug('reverted feature', { feature: feature.id });
  }

  for (const feature of scenario.features) {
    for (const id of feature.fixturesAdded) {
      rmSync(join(repoDir, fixtureDir(scenario, id)), { recursive: true, force: true });
    }
    const range = featureRange(feature);
    for (const id of feature.fixturesModified) {
      if (range === undefined) continue;
      const dir = fixtureDir(scenario, id);
      rmSync(join(repoDir, dir), { recursive: true, force: true });
      await git(repoDir, ['checkout', range.from, '--', dir]);
    }
  }

  for (const name of SETUP_CLUTTER) rmSync(join(repoDir, name), { recursive: true, force: true });
  for (const name of readdirSync(repoDir)) {
    if (name.endsWith('.tsbuildinfo')) rmSync(join(repoDir, name), { force: true });
  }

  const baseTree = await seal(repoDir);
  log?.info('trial repo sealed', { repoDir, baseTree });
  return { scenario, refClone, repoDir, baseTree };
}

/**
 * `rm -rf .git && git init && git add -A && git commit`: one orphan commit, nothing to find with
 * `git log`. Files ignored by the repo's own `.gitignore` but tracked upstream (the root `*.ts`
 * files here) are force-added; only `node_modules` is left out.
 */
async function seal(repoDir: string): Promise<string> {
  rmSync(join(repoDir, '.git'), { recursive: true, force: true });
  await git(repoDir, ['init', '-q']);
  await git(repoDir, ['add', '-A', '-f', '--', '.', ':(exclude)node_modules']);
  await git(repoDir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return (await git(repoDir, ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
}

/**
 * Puts the reference implementation back into a sealed repo: feature `srcPaths` from the
 * reference clone, or the scenario's `reference/` overlay when the repo has no history.
 * Used by `bench validate` for the restored side of the gate.
 */
export async function restoreReferenceSources(trial: TrialRepo): Promise<void> {
  const { scenario, refClone, repoDir } = trial;
  for (const feature of scenario.features) {
    if (feature.commit === undefined) continue;
    for (const path of feature.srcPaths) {
      const source = join(refClone, path);
      if (!existsSync(source)) {
        rmSync(join(repoDir, path), { recursive: true, force: true });
        continue;
      }
      mkdirSync(dirname(join(repoDir, path)), { recursive: true });
      cpSync(source, join(repoDir, path), { recursive: true });
    }
  }
  const overlay = join(scenario.dir, 'reference');
  if (scenario.repo.baseCommit === undefined && existsSync(overlay)) {
    cpSync(overlay, repoDir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Trees and diffs
// ---------------------------------------------------------------------------

/**
 * Tree hash of the working tree, untracked files included (`.gitignore` honored). Uses a
 * throwaway index so the agent's index and HEAD are untouched; only unreferenced objects land
 * in `.git/objects`.
 */
export async function workingTree(repoDir: string): Promise<string> {
  const index = join(tmpdir(), `bench-index-${randomBytes(6).toString('hex')}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(repoDir, ['read-tree', 'HEAD'], { env });
    await git(repoDir, ['add', '-A'], { env });
    return (await git(repoDir, ['write-tree'], { env })).stdout.trim();
  } finally {
    rmSync(index, { force: true });
  }
}

/** Tree of the sealed init commit: the root of the trial repo's history. */
export async function initTree(repoDir: string): Promise<string> {
  const roots = (await git(repoDir, ['rev-list', '--max-parents=0', 'HEAD'])).stdout
    .trim()
    .split('\n');
  const root = roots[roots.length - 1]!;
  return (await git(repoDir, ['rev-parse', `${root}^{tree}`])).stdout.trim();
}

export async function diffTrees(repoDir: string, from: string, to: string): Promise<AgentDiff> {
  const text = (await git(repoDir, ['diff-tree', '-p', '--no-renames', '--no-color', from, to]))
    .stdout;
  const status = (
    await git(repoDir, ['diff-tree', '-r', '--no-renames', '--name-status', from, to])
  ).stdout;
  const files: DiffFile[] = [];
  for (const line of status.split('\n')) {
    const match = /^([A-Z])\d*\t(.+)$/.exec(line);
    if (match) files.push({ status: match[1]!, path: match[2]! });
  }
  return { fromTree: from, toTree: to, text, files };
}

/** File content at a tree, or undefined when absent. */
export async function fileAtTree(
  repoDir: string,
  tree: string,
  path: string
): Promise<string | undefined> {
  const result = await git(repoDir, ['show', `${tree}:${path}`], { allowFailure: true });
  return result.exitCode === 0 ? result.stdout : undefined;
}

// ---------------------------------------------------------------------------
// Snapshots (DESIGN 5.3)
// ---------------------------------------------------------------------------

export interface SnapshotItems {
  /** Held-out fixture ids copied into the snapshot (from `<scenario>/fixtures/` or the reference clone). */
  fixtures: string[];
  /** Variant ids copied as `__bench_<id>` with a generated test file. */
  variants: string[];
}

/** Test file for a variant with a `rootType`, mirroring the repo's fixture tests. */
export function variantTestSource(scenario: Scenario, variant: Variant, dir: string): string {
  const utils = relative(dir, 'test/utils').split(sep).join('/');
  const name = `__bench_${variant.id}`;
  const prefix = scenario.layout.dir.startsWith('test/valid-data/') ? 'valid-data - ' : '';
  return [
    `import { assertValidSchema } from "${utils}";`,
    'import { test } from "node:test";',
    '',
    `test("${prefix}${name}", assertValidSchema("${name}", ${JSON.stringify(variant.rootType)}));`,
    ''
  ].join('\n');
}

/**
 * Files the check snapshot takes from the reference clone instead of the agent's tree (DESIGN
 * 5.3, 5.4): the test-infrastructure files of traps that must stay unchanged (`test/utils.ts`,
 * the vega-lite test) and every existing `schema.json` outside `allowedSchemaChanges`. The
 * checks then never run with a weakened `test/utils.ts` or a regenerated golden file, while
 * the diff rules and the trap checks, which read the agent's tree, still score what the agent
 * left behind. A trap file under `src/` (`ChainNodeParser.ts`) is never restored: the
 * fixtures must run against the agent's code, and its trap is scored from the diff.
 */
export function restoredPaths(scenario: Scenario, agentFiles: readonly string[]): string[] {
  const paths = new Set<string>();
  for (const trap of Object.values(scenario.traps)) {
    if (!trap.mustBeUnchanged) continue;
    for (const file of trap.files) if (file.startsWith('test/')) paths.add(file);
  }
  const fixturePattern = new RegExp(
    `^${scenario.layout.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{id\\}', '([^/]+)')}/`
  );
  for (const path of agentFiles) {
    if (!path.endsWith('schema.json')) continue;
    const id = fixturePattern.exec(path)?.[1];
    if (id === undefined || !scenario.final.allowedSchemaChanges.includes(id)) paths.add(path);
  }
  return [...paths];
}

/** Files of the sealed tree that `tree` modified or deleted. */
async function changedFiles(repoDir: string, baseTree: string, tree: string): Promise<string[]> {
  return (await diffTrees(repoDir, baseTree, tree)).files
    .filter((file) => file.status !== 'A')
    .map((file) => file.path);
}

/**
 * Copies the agent's tree (no `node_modules`, no `.git`) to `dest`, symlinks `node_modules`,
 * restores the harness-critical files from the reference clone (`restoredPaths`), then adds
 * the held-out fixtures and variants. The agent's own tree never contains them.
 */
export async function snapshotForChecks(
  trial: TrialRepo,
  dest: string,
  items: SnapshotItems
): Promise<Snapshot> {
  const { scenario, repoDir, refClone } = trial;
  const tree = await workingTree(repoDir);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  copyExcluding(repoDir, dest, ['node_modules', '.git']);
  const nodeModules = join(repoDir, 'node_modules');
  if (existsSync(nodeModules)) symlinkSync(nodeModules, join(dest, 'node_modules'));

  for (const path of restoredPaths(scenario, await changedFiles(repoDir, trial.baseTree, tree))) {
    const source = join(refClone, path);
    if (!existsSync(source)) continue;
    mkdirSync(dirname(join(dest, path)), { recursive: true });
    cpSync(source, join(dest, path));
  }

  for (const id of items.fixtures) {
    const dir = fixtureDir(scenario, id);
    const shipped = join(scenario.dir, 'fixtures', dir);
    const source = existsSync(shipped) ? shipped : join(refClone, dir);
    if (!existsSync(source)) throw new RepoError(`fixture ${id}: ${source} does not exist`);
    rmSync(join(dest, dir), { recursive: true, force: true });
    copyExcluding(source, join(dest, dir), []);
  }

  for (const id of items.variants) {
    const variant = scenario.variants.find((v) => v.id === id);
    if (variant === undefined) throw new RepoError(`unknown variant ${id}`);
    const source = join(scenario.dir, 'variants', id);
    const dir = fixtureDir(scenario, `__bench_${id}`);
    rmSync(join(dest, dir), { recursive: true, force: true });
    copyExcluding(source, join(dest, dir), []);
    const testFile = join(dest, dir, scenario.layout.test);
    if (!existsSync(testFile)) {
      if (variant.rootType === undefined) {
        throw new RepoError(`variant ${id} has neither ${scenario.layout.test} nor a rootType`);
      }
      writeFileSync(testFile, variantTestSource(scenario, variant, dir));
    }
  }
  return { dir: dest, tree };
}

// ---------------------------------------------------------------------------
// Archive and teardown (DESIGN 5.7)
// ---------------------------------------------------------------------------

export interface FinalArchive {
  tarball: string;
  diffFile: string;
  diff: AgentDiff;
  tree: string;
}

/** `final-tree.tar.gz` (no `node_modules`, no `dist`; `.git` kept for `bench check`) and `final.diff`. */
export async function archiveFinalTree(trial: TrialRepo, dest: string): Promise<FinalArchive> {
  mkdirSync(dest, { recursive: true });
  const tarball = join(dest, 'final-tree.tar.gz');
  const result = await runProcess(
    'tar',
    ['-czf', tarball, '--exclude', 'node_modules', '--exclude', 'dist', '-C', trial.repoDir, '.'],
    { cwd: dest, timeoutMs: 10 * 60 * 1000 }
  );
  if (result.exitCode !== 0) throw new RepoError(`tar failed: ${result.stderr.trim()}`);
  const tree = await workingTree(trial.repoDir);
  const diff = await diffTrees(trial.repoDir, trial.baseTree, tree);
  const diffFile = join(dest, 'final.diff');
  writeFileSync(diffFile, diff.text);
  return { tarball, diffFile, diff, tree };
}

/**
 * Unpacks `final-tree.tar.gz` into `<dest>/repo` and clones `node_modules` from the template,
 * as `setupTrialRepo` does. A symlink would not do: Node resolves packages from the real path,
 * and `bench/cache/node_modules-<sha>` is not named `node_modules`, so `tsx` could not find
 * its own dependencies and every fixture would be `load_error`.
 */
export async function extractFinalTree(
  scenario: Scenario,
  tarball: string,
  dest: string,
  options: SetupOptions = {}
): Promise<TrialRepo> {
  const refClone = options.refClone ?? (await ensureReferenceClone(scenario, options.log));
  const template =
    options.nodeModulesTemplate ?? (await ensureNodeModulesTemplate(refClone, options.log));
  const repoDir = join(dest, 'repo');
  rmSync(repoDir, { recursive: true, force: true });
  mkdirSync(repoDir, { recursive: true });
  const result = await runProcess('tar', ['-xzf', resolve(tarball), '-C', repoDir], {
    cwd: dest,
    timeoutMs: 10 * 60 * 1000
  });
  if (result.exitCode !== 0) throw new RepoError(`tar failed: ${result.stderr.trim()}`);
  if (!existsSync(join(repoDir, '.git'))) {
    throw new RepoError(`${tarball} has no .git; cannot diff against the sealed tree`);
  }
  if (template !== undefined && !existsSync(join(repoDir, 'node_modules'))) {
    await cloneTree(template, join(repoDir, 'node_modules'));
  }
  return { scenario, refClone, repoDir, baseTree: await initTree(repoDir) };
}

export function teardownTrial(trialDir: string, keep: boolean): void {
  if (keep) return;
  if (existsSync(trialDir) && statSync(trialDir).isDirectory()) {
    rmSync(trialDir, { recursive: true, force: true });
  }
}
