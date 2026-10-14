import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { prepull } from '../bench/scripts/pull.js';

test('image pulls overlap, stay bounded at four, and skip cached images', async () => {
  let active = 0;
  let peak = 0;
  const pulled: string[] = [];
  await prepull(['cached', 'a', 'b', 'c', 'd', 'e', 'f'], {
    async run(args) {
      const image = args.at(-1)!;
      if (args[0] === 'image') {
        if (image === 'cached') return;
        throw new Error('not cached');
      }
      pulled.push(image);
      peak = Math.max(peak, ++active);
      await setImmediate();
      active--;
    },
    wait: async () => assert.fail('successful pulls need no delay'),
    now: () => 0
  });
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.deepEqual(pulled.sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('registry throttling delays retries and other workers with a shared cooldown', async () => {
  let now = 0;
  let attempts = 0;
  const starts: { image: string; time: number }[] = [];
  const waits: number[] = [];
  await prepull(['a', 'b', 'c', 'd', 'e'], {
    async run(args) {
      if (args[0] === 'image') throw new Error('not cached');
      const image = args.at(-1)!;
      starts.push({ image, time: now });
      if (image === 'a' && ++attempts <= 2) {
        throw Object.assign(new Error('pull failed'), { stderr: 'toomanyrequests: Rate exceeded' });
      }
      await setImmediate();
    },
    async wait(ms) {
      waits.push(ms);
      await setImmediate();
      now += ms;
    },
    now: () => now
  });
  const retries = starts.filter(({ image }) => image === 'a');
  assert.equal(retries.length, 3);
  assert.ok(retries[1]!.time >= 30_000);
  assert.ok(retries[2]!.time >= retries[1]!.time + 60_000);
  assert.ok(starts.find(({ image }) => image === 'e')!.time >= 30_000);
  assert.ok(waits.length > 0);
});

test('a failed image stops new pulls and drains already running pulls', async () => {
  let attempts = 0;
  let drained = 0;
  const running = Promise.withResolvers<void>();
  const job = prepull(['bad', 'running-1', 'running-2', 'running-3', 'never'], {
    async run(args) {
      if (args[0] === 'image') throw new Error('not cached');
      const image = args.at(-1)!;
      assert.notEqual(image, 'never');
      if (image === 'bad') {
        attempts++;
        throw new Error('temporary failure');
      }
      await running.promise;
      drained++;
    },
    wait: async () => {},
    now: () => 0
  });
  await setImmediate();
  assert.equal(attempts, 5);
  assert.equal(drained, 0);
  running.resolve();
  await assert.rejects(job, /Could not pull bad/);
  assert.equal(drained, 3);
});

test('missing Docker fails immediately without retries', async () => {
  let calls = 0;
  await assert.rejects(
    prepull(['a'], {
      async run() {
        calls++;
        throw Object.assign(new Error('docker missing'), { code: 'ENOENT' });
      },
      wait: async () => assert.fail('missing executable must not be retried'),
      now: () => 0
    }),
    /docker missing/
  );
  assert.equal(calls, 1);
});
