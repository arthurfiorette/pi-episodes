import assert from 'node:assert/strict';
import type { SpawnOptions } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { cleanupRun, runHarbor } from '../bench/scripts/harbor.js';

const root = resolve('bench/runs/owned');
const container = (Id: string, sources: string[], project?: string) => ({
  Id,
  Mounts: sources.map((Source) => ({ Source })),
  Config: { Labels: project ? { 'com.docker.compose.project': project } : null }
});

function docker(containers: ReturnType<typeof container>[], networks: Record<string, string> = {}) {
  const calls: string[][] = [];
  return {
    calls,
    async run(file: string, args: string[]) {
      assert.equal(file, 'docker');
      calls.push(args);
      if (args[0] === 'ps') return { stdout: containers.map(({ Id }) => Id).join('\n') };
      if (args[0] === 'inspect') return { stdout: JSON.stringify(containers) };
      if (args[0] === 'network' && args[1] === 'ls') {
        return { stdout: networks[args.at(-1)!] ?? '' };
      }
      return { stdout: '' };
    }
  };
}

test('cleanup includes mounted main/verifier projects and sidecars, not similar projects', async () => {
  const fake = docker(
    [
      container('main', [`${root}/trial/logs`], 'job'),
      container('sidecar', [], 'job'),
      container('verifier', [`${root}/trial/verifier`], 'job-verifier'),
      container('verifier-sidecar', [], 'job-verifier'),
      container('other-run', [`${root}-other/trial`], 'job-other'),
      container('unrelated', ['/unrelated'], 'unrelated')
    ],
    {
      'label=com.docker.compose.project=job': 'net-main\nnet-sidecar\n',
      'label=com.docker.compose.project=job-verifier': 'net-verifier'
    }
  );
  await cleanupRun(root, fake.run);
  assert.deepEqual(fake.calls.slice(2), [
    ['rm', '-f', 'main', 'sidecar', 'verifier', 'verifier-sidecar'],
    ['network', 'ls', '-q', '--filter', 'label=com.docker.compose.project=job'],
    ['network', 'rm', 'net-main', 'net-sidecar'],
    ['network', 'ls', '-q', '--filter', 'label=com.docker.compose.project=job-verifier'],
    ['network', 'rm', 'net-verifier']
  ]);
});

test('cleanup respects the directory boundary and normalizes separators and dot segments', async () => {
  const fake = docker([
    container('exact', [root]),
    container('normalized', [`${root}/trial/../logs`.replaceAll('/', '\\')]),
    container('prefix', [`${root}-other/logs`]),
    container('parent', [resolve(root, '..')]),
    container('escaped', [`${root}/../other/logs`])
  ]);
  await cleanupRun(`${root}/`, fake.run);
  assert.deepEqual(fake.calls.slice(2), [['rm', '-f', 'exact', 'normalized']]);
});

test('mount matching is case insensitive only on Windows', async () => {
  const fake = docker([container('different-case', [root.toUpperCase()])]);
  await cleanupRun(root, fake.run);
  assert.deepEqual(
    fake.calls.slice(2),
    process.platform === 'win32' ? [['rm', '-f', 'different-case']] : []
  );
});

test('unrelated containers and empty Docker installations require no removals', async () => {
  for (const containers of [[], [container('unrelated', [`${root}-other`], 'other')]]) {
    const fake = docker(containers);
    await cleanupRun(root, fake.run);
    assert.ok(fake.calls.every((args) => args[0] === 'ps' || args[0] === 'inspect'));
  }
});

test('empty project network results never cause a broad network removal', async () => {
  const fake = docker([container('main', [root], 'exact-project')]);
  await cleanupRun(root, fake.run);
  assert.deepEqual(fake.calls.slice(2), [
    ['rm', '-f', 'main'],
    ['network', 'ls', '-q', '--filter', 'label=com.docker.compose.project=exact-project']
  ]);
});

test('Docker failures at every cleanup stage reject rather than report success', async () => {
  for (let stage = 0; stage < 5; stage++) {
    const fake = docker([container('main', [root], 'job')], {
      'label=com.docker.compose.project=job': 'net'
    });
    let index = 0;
    await assert.rejects(
      cleanupRun(root, async (file, args) => {
        if (index++ === stage) throw new Error('Docker failed');
        return fake.run(file, args);
      }),
      /Docker failed/
    );
    assert.equal(index, stage + 1);
  }
});

test('cleanup recognizes Docker Desktop daemon-side Windows mount paths', {
  skip: process.platform !== 'win32'
}, async () => {
  const path = root.replaceAll('\\', '/');
  const mapped = `/run/desktop/mnt/host/${path[0]!.toLowerCase()}${path.slice(2)}/logs`;
  const fake = docker([container('mapped', [mapped], 'job')]);
  await cleanupRun(root, fake.run);
  assert.deepEqual(fake.calls[2], ['rm', '-f', 'mapped']);
});

test('an unrelated container disappearing during inspection does not prevent cleanup', async () => {
  const fake = docker([container('main', [root], 'job')]);
  await cleanupRun(root, async (file, args) => {
    const result = await fake.run(file, args);
    if (args[0] === 'inspect') {
      throw Object.assign(new Error('container disappeared'), {
        stdout: result.stdout,
        stderr: 'Error: No such object: unrelated'
      });
    }
    return result;
  });
  assert.deepEqual(fake.calls[2], ['rm', '-f', 'main']);
});

for (const trigger of ['SIGINT', 'q'] as const) {
  test(`abort via ${trigger} waits for an isolated subprocess and restores listeners`, async (t) => {
    const originalSpawn = childProcess.spawn;
    const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const intListeners = process.listenerCount('SIGINT');
    const termListeners = process.listenerCount('SIGTERM');
    let worker: ReturnType<typeof originalSpawn> | undefined;
    t.after(() => {
      worker?.kill();
      t.mock.restoreAll();
      syncBuiltinESMExports();
      if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
    });
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: trigger === 'q'
    });
    t.mock.method(childProcess, 'spawn', () => {
      // Exercise real OS termination against a disposable Node worker, never a benchmark.
      worker = originalSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'ignore', 'ignore']
      });
      return worker;
    });
    syncBuiltinESMExports();
    const completion = runHarbor([], process.env);
    if (trigger === 'q') process.stdin.emit('data', Buffer.from('q\n'));
    else process.emit('SIGINT');
    assert.equal(await completion, 130);
    assert.ok(worker?.exitCode !== null || worker?.signalCode !== null);
    assert.equal(process.listenerCount('SIGINT'), intListeners);
    assert.equal(process.listenerCount('SIGTERM'), termListeners);
  });
}

test('Harbor is launched in Python UTF-8 mode without changing the caller environment', async (t) => {
  const originalSpawn = childProcess.spawn;
  const env = { ...process.env, PYTHONUTF8: '0', PYTHONIOENCODING: 'cp1252' };
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(childProcess, 'spawn', (_file: string, _args: string[], options: SpawnOptions) => {
    assert.equal(options.env?.PYTHONUTF8, '1');
    assert.equal(options.env?.PYTHONIOENCODING, 'utf-8');
    return originalSpawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  });
  syncBuiltinESMExports();
  assert.equal(await runHarbor([], env), 0);
  assert.equal(env.PYTHONUTF8, '0');
  assert.equal(env.PYTHONIOENCODING, 'cp1252');
});
