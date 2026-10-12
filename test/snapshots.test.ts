import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Snapshots } from '../src/snapshots.js';

test('diffs the working tree between stamps, untracked files included', async () => {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'pi-episodes-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('config', 'commit.gpgsign', 'false');
    await writeFile(join(repo, 'a.ts'), 'a');
    await writeFile(join(repo, 'b.ts'), 'b');
    git('add', '.');
    git('commit', '-qm', 'init');

    const objects = git('count-objects').toString();
    const snapshots = new Snapshots(repo, 'test');
    snapshots.recordAt(1);
    await snapshots.settled();
    await writeFile(join(repo, 'a.ts'), 'changed');
    await writeFile(join(repo, 'new file.ts'), 'untracked');
    const before = await snapshots.treeAt(1);
    const now = await snapshots.snapshot();

    assert.ok(before && now);
    assert.deepEqual(await snapshots.diff(before, now), [
      { status: 'M', path: join(repo, 'a.ts') },
      { status: 'A', path: join(repo, 'new file.ts') }
    ]);
    assert.deepEqual(await snapshots.diff(before, now, [join(repo, 'b.ts')]), []);
    // Paths outside the work tree would make git fail; they are skipped instead.
    assert.deepEqual(await snapshots.diff(before, now, ['/elsewhere/a.ts', join(repo, 'a.ts')]), [
      { status: 'M', path: join(repo, 'a.ts') }
    ]);
    // Neither the user's index nor the repository's object store sees the snapshots.
    assert.equal(git('diff', '--cached', '--name-only').toString(), '');
    assert.equal(git('count-objects').toString(), objects);
    await snapshots.dispose();
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('does nothing outside a git repository', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-episodes-'));
  try {
    const snapshots = new Snapshots(dir, 'test');
    assert.equal(await snapshots.snapshot(), undefined);
    snapshots.recordAt(1);
    assert.equal(await snapshots.treeAt(1), undefined);
    assert.equal(await snapshots.diff('a', 'b'), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
