import assert from 'node:assert/strict';
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
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
import {
  archiveFinalTree,
  diffTrees,
  extractFinalTree,
  featureRange,
  fixtureDir,
  git,
  restoredPaths,
  runProcess,
  runShell,
  setupTrialRepo,
  snapshotForChecks,
  teardownTrial,
  variantTestSource,
  workingTree
} from '../src/repo.js';
import { loadScenario } from '../src/scenario.js';
import type { Scenario } from '../src/types.js';

const miniChain = fileURLToPath(new URL('./fixtures/mini-chain', import.meta.url));

/** A fake `node_modules` template: `pkg-a` requires `pkg-b`, which only resolves from a real `node_modules` dir. */
function writeTemplate(dir: string): void {
  mkdirSync(join(dir, 'pkg-a'), { recursive: true });
  mkdirSync(join(dir, 'pkg-b'), { recursive: true });
  writeFileSync(join(dir, 'pkg-a', 'package.json'), '{"name":"pkg-a","main":"index.js"}');
  writeFileSync(join(dir, 'pkg-a', 'index.js'), "module.exports = require('pkg-b');\n");
  writeFileSync(join(dir, 'pkg-b', 'package.json'), '{"name":"pkg-b","main":"index.js"}');
  writeFileSync(join(dir, 'pkg-b', 'index.js'), 'module.exports = 42;\n');
}

test('setupTrialRepo seals the mini-chain to one commit without held-out fixtures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-repo-'));
  try {
    const scenario = loadScenario(miniChain);
    const trial = await setupTrialRepo(scenario, join(dir, 'trial'));
    assert.equal(trial.repoDir, join(dir, 'trial', 'repo'));
    assert.match(trial.baseTree, /^[0-9a-f]{40}$/);
    assert.ok(existsSync(join(trial.repoDir, '.git')));
    assert.ok(existsSync(join(trial.repoDir, 'src/add.js')));
    const count = await git(trial.repoDir, ['rev-list', '--count', 'HEAD']);
    assert.equal(count.stdout.trim(), '1');
    const log = await git(trial.repoDir, ['log', '--format=%s %an']);
    assert.equal(log.stdout.trim(), 'init bench');
    for (const id of ['mul', 'sub']) {
      assert.ok(!existsSync(join(trial.repoDir, fixtureDir(scenario, id))));
    }
    assert.ok(!existsSync(join(trial.repoDir, 'test/held-out')));
    assert.equal(await workingTree(trial.repoDir), trial.baseTree);
    const status = await git(trial.repoDir, ['status', '--porcelain']);
    assert.equal(status.stdout, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshotForChecks adds held-out fixtures, variants and a node_modules symlink', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-repo-'));
  try {
    const scenario = loadScenario(miniChain);
    const trial = await setupTrialRepo(scenario, join(dir, 'trial'));
    mkdirSync(join(trial.repoDir, 'node_modules', 'left-pad'), { recursive: true });
    const snapshot = await snapshotForChecks(trial, join(dir, 'snapshots', 'step-1'), {
      fixtures: ['mul', 'sub'],
      variants: ['mul-v']
    });
    assert.equal(snapshot.tree, trial.baseTree);
    assert.ok(existsSync(join(snapshot.dir, 'src/add.js')));
    assert.ok(existsSync(join(snapshot.dir, 'test/held-out/mul/index.test.js')));
    assert.ok(existsSync(join(snapshot.dir, 'test/held-out/sub/index.test.js')));
    assert.ok(existsSync(join(snapshot.dir, 'test/held-out/__bench_mul-v/index.test.js')));
    assert.ok(!existsSync(join(snapshot.dir, '.git')));
    assert.ok(lstatSync(join(snapshot.dir, 'node_modules')).isSymbolicLink());
    assert.ok(existsSync(join(snapshot.dir, 'node_modules', 'left-pad')));
    // The agent's tree is untouched by the snapshot.
    assert.ok(!existsSync(join(trial.repoDir, 'test/held-out')));
    assert.equal((await git(trial.repoDir, ['status', '--porcelain'])).stdout, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('archiveFinalTree writes the tarball and the diff against the sealed tree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-repo-'));
  try {
    const scenario = loadScenario(miniChain);
    const trial = await setupTrialRepo(scenario, join(dir, 'trial'));
    mkdirSync(join(trial.repoDir, 'node_modules', 'x'), { recursive: true });
    appendFileSync(
      join(trial.repoDir, 'src/add.js'),
      '\nexport function mul(a, b) {\n  return a * b;\n}\n'
    );
    writeFileSync(join(trial.repoDir, 'test/mul.test.js'), "import { test } from 'node:test';\n");
    // Agent commits must not hide changes from the diff.
    await git(trial.repoDir, ['add', '-A']);
    await git(trial.repoDir, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'agent work']);

    const archive = await archiveFinalTree(trial, join(dir, 'out'));
    assert.ok(existsSync(archive.tarball));
    assert.ok(existsSync(archive.diffFile));
    assert.match(archive.diff.text, /\+export function mul/);
    assert.match(archive.diff.text, /test\/mul\.test\.js/);
    assert.deepEqual(archive.diff.files.map((file) => `${file.status} ${file.path}`).sort(), [
      'A test/mul.test.js',
      'M src/add.js'
    ]);
    const listing = await runProcess('tar', ['-tzf', archive.tarball], { cwd: dir });
    assert.ok(listing.stdout.includes('./src/add.js'));
    assert.ok(listing.stdout.includes('./.git/'));
    assert.ok(!listing.stdout.includes('node_modules'));

    const regrade = await extractFinalTree(scenario, archive.tarball, join(dir, 'regrade'));
    assert.equal(regrade.baseTree, trial.baseTree);
    assert.equal(await workingTree(regrade.repoDir), archive.tree);
    const again = await diffTrees(regrade.repoDir, regrade.baseTree, archive.tree);
    assert.equal(again.text, archive.diff.text);

    teardownTrial(join(dir, 'trial'), true);
    assert.ok(existsSync(trial.repoDir));
    teardownTrial(join(dir, 'trial'), false);
    assert.ok(!existsSync(trial.repoDir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractFinalTree clones the node_modules template as a real directory, so packages resolve their own dependencies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-repo-'));
  try {
    const scenario = loadScenario(miniChain);
    const trial = await setupTrialRepo(scenario, join(dir, 'trial'));
    const archive = await archiveFinalTree(trial, join(dir, 'out'));
    // The template is keyed by lockfile hash and so never named `node_modules`; a symlink to
    // it would make Node look for pkg-b next to the real path and fail.
    const template = join(dir, 'node_modules-abc123');
    writeTemplate(template);
    const regrade = await extractFinalTree(scenario, archive.tarball, join(dir, 'regrade'), {
      nodeModulesTemplate: template
    });
    const nodeModules = join(regrade.repoDir, 'node_modules');
    assert.ok(lstatSync(nodeModules).isDirectory());
    assert.ok(!lstatSync(nodeModules).isSymbolicLink());
    const direct = await runShell('node -e "process.stdout.write(String(require(\'pkg-a\')))"', {
      cwd: regrade.repoDir
    });
    assert.equal(direct.exitCode, 0, direct.stderr);
    assert.equal(direct.stdout, '42');
    // The check snapshot links to the clone, and the link's real path is named `node_modules`.
    const snapshot = await snapshotForChecks(regrade, join(dir, 'snap'), {
      fixtures: ['mul'],
      variants: []
    });
    const viaSnapshot = await runShell(
      'node -e "process.stdout.write(String(require(\'pkg-a\')))"',
      { cwd: snapshot.dir }
    );
    assert.equal(viaSnapshot.exitCode, 0, viaSnapshot.stderr);
    assert.equal(viaSnapshot.stdout, '42');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshotForChecks restores trap files and non-allowed schema.json from the reference clone, snapshot only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-repo-'));
  try {
    const base = loadScenario(miniChain);
    const scenario: Scenario = {
      ...base,
      final: { traps: ['skip-typecheck', 'debug-print'], allowedSchemaChanges: ['mine'] },
      traps: {
        'skip-typecheck': { files: ['test/utils.ts'], mustBeUnchanged: true },
        // A src/ trap file is never restored: the checks run on the agent's code.
        'debug-print': { files: ['src/add.js'], mustBeUnchanged: true, grep: 'console\\.' }
      }
    };
    assert.deepEqual(
      restoredPaths(scenario, [
        'test/held-out/mine/schema.json',
        'test/held-out/theirs/schema.json',
        'src/add.js'
      ]).sort(),
      ['test/held-out/theirs/schema.json', 'test/utils.ts']
    );
    // Seed the reference template with a utils file and a golden file the agent will weaken.
    const source = join(dir, 'source');
    cpSync(join(miniChain, 'repo'), source, { recursive: true });
    writeFileSync(join(source, 'test/utils.ts'), 'export const skipTypeCheck = false;\n');
    mkdirSync(join(source, 'test/held-out/theirs'), { recursive: true });
    writeFileSync(join(source, 'test/held-out/theirs/schema.json'), '{"golden":true}\n');
    const sealed: Scenario = { ...scenario, repo: { source } };
    const trial = await setupTrialRepo(sealed, join(dir, 'trial'));
    writeFileSync(join(trial.repoDir, 'test/utils.ts'), 'export const skipTypeCheck = true;\n');
    writeFileSync(join(trial.repoDir, 'test/held-out/theirs/schema.json'), '{"golden":false}\n');
    appendFileSync(join(trial.repoDir, 'src/add.js'), 'export const mul = 1;\n');
    // src/add.js is a trap file that must stay unchanged, yet the agent's work there is kept:
    // its trap is scored from the diff, the fixtures run on what the agent wrote.
    const snapshot = await snapshotForChecks(trial, join(dir, 'snap'), {
      fixtures: [],
      variants: []
    });
    assert.equal(
      readFileSync(join(snapshot.dir, 'test/utils.ts'), 'utf8'),
      'export const skipTypeCheck = false;\n'
    );
    assert.equal(
      readFileSync(join(snapshot.dir, 'test/held-out/theirs/schema.json'), 'utf8'),
      '{"golden":true}\n'
    );
    assert.match(readFileSync(join(snapshot.dir, 'src/add.js'), 'utf8'), /mul = 1/);
    // The agent's tree is as left: the diff rules and trap checks still see the weakening.
    assert.match(readFileSync(join(trial.repoDir, 'test/utils.ts'), 'utf8'), /= true/);
    const diff = await diffTrees(trial.repoDir, trial.baseTree, snapshot.tree);
    assert.ok(diff.files.some((file) => file.path === 'test/utils.ts'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('featureRange and the generated variant test mirror the repo fixtures', () => {
  assert.deepEqual(
    featureRange({ id: 'x', srcPaths: [], fixturesAdded: [], fixturesModified: [] }),
    undefined
  );
  assert.deepEqual(
    featureRange({ id: 'x', commit: 'abc', srcPaths: [], fixturesAdded: [], fixturesModified: [] }),
    { from: 'abc^', to: 'abc' }
  );
  assert.deepEqual(
    featureRange({
      id: 'x',
      commit: 'a^..b',
      srcPaths: [],
      fixturesAdded: [],
      fixturesModified: []
    }),
    { from: 'a^', to: 'b' }
  );
  const scenario = {
    layout: { dir: 'test/valid-data/{id}', test: 'index.test.ts' }
  } as unknown as Scenario;
  const source = variantTestSource(
    scenario,
    { id: 'parameters-v', feature: 'parameters', rootType: 'HandlerArgs' },
    'test/valid-data/__bench_parameters-v'
  );
  assert.equal(
    source,
    [
      'import { assertValidSchema } from "../../utils";',
      'import { test } from "node:test";',
      '',
      'test("valid-data - __bench_parameters-v", assertValidSchema("__bench_parameters-v", "HandlerArgs"));',
      ''
    ].join('\n')
  );
});
