import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { resolvePiModelsPath } from '../src/config.js';
import { ConfigError } from '../src/fields.js';
import { createModelRuntime, preflightModels, resolveModel } from '../src/session.js';

/** A `models.json` as docs/models.md "Configure a compatible endpoint" describes it. */
const PROXY_MODELS = {
  providers: {
    'my-proxy': {
      baseUrl: 'http://127.0.0.1:9/v1',
      api: 'anthropic-messages',
      apiKey: '$MY_PROXY_KEY',
      models: [
        {
          id: 'proxied-sonnet',
          contextWindow: 200000,
          maxTokens: 64000,
          cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
        }
      ]
    }
  }
};

let tmp: string;
let modelsPath: string;
let authPath: string;
const savedEnv = new Map<string, string | undefined>();

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'bench-models-path-'));
  modelsPath = join(tmp, 'models.json');
  authPath = join(tmp, 'auth.json');
  writeFileSync(modelsPath, JSON.stringify(PROXY_MODELS));
  for (const key of ['PI_OFFLINE', 'MY_PROXY_KEY']) savedEnv.set(key, process.env[key]);
  process.env.PI_OFFLINE = '1';
  delete process.env.MY_PROXY_KEY;
});

after(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

test('resolvePiModelsPath: null when the file is absent, the path when present', () => {
  assert.equal(resolvePiModelsPath(join(tmp, 'absent.json')), null);
  assert.equal(resolvePiModelsPath(modelsPath), modelsPath);
});

test('ModelRuntime.create with a models.json makes the custom provider resolvable offline', async () => {
  const runtime = await ModelRuntime.create({
    modelsPath,
    authPath,
    modelsStorePath: join(tmp, 'store.json')
  });
  assert.equal(runtime.getError(), undefined);
  assert.ok(runtime.getProvider('my-proxy'));
  const model = runtime.getModel('my-proxy', 'proxied-sonnet');
  assert.ok(model);
  // The fields the trial audit records come from this object, as declared in the file.
  assert.equal(model.provider, 'my-proxy');
  assert.equal(model.api, 'anthropic-messages');
  assert.equal(model.baseUrl, 'http://127.0.0.1:9/v1');
  assert.equal(model.contextWindow, 200000);
  assert.equal(model.maxTokens, 64000);
  assert.deepEqual(model.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  // `$MY_PROXY_KEY` is the credential: unset, the model is not available; set, it is.
  assert.equal(runtime.hasConfiguredAuth('my-proxy'), false);
  process.env.MY_PROXY_KEY = 'test-key';
  try {
    const withKey = await ModelRuntime.create({
      modelsPath,
      authPath,
      modelsStorePath: join(tmp, 'store.json')
    });
    assert.ok(withKey.hasConfiguredAuth('my-proxy'));
    assert.deepEqual(withKey.getProviderAuthStatus('my-proxy'), {
      configured: true,
      source: 'environment',
      label: 'MY_PROXY_KEY'
    });
    const available = await withKey.getAvailable();
    assert.deepEqual(
      available.filter((entry) => entry.provider === 'my-proxy').map((entry) => entry.id),
      ['proxied-sonnet']
    );
  } finally {
    delete process.env.MY_PROXY_KEY;
  }
  // A null modelsPath loads no file: the provider is unknown.
  const bare = await ModelRuntime.create({ modelsPath: null, authPath });
  assert.equal(bare.getProvider('my-proxy'), undefined);
});

test('createModelRuntime and resolveModel: the proxy resolves, errors name the file', async () => {
  const runtime = await createModelRuntime(authPath, modelsPath);
  assert.throws(
    () => resolveModel(runtime, 'my-proxy/proxied-sonnet', authPath, modelsPath),
    (error: unknown) =>
      error instanceof ConfigError &&
      /no credentials for my-proxy: add them to .*auth\.json/.test(error.message)
  );
  process.env.MY_PROXY_KEY = 'test-key';
  try {
    const withKey = await createModelRuntime(authPath, modelsPath);
    const model = resolveModel(withKey, 'my-proxy/proxied-sonnet', authPath, modelsPath);
    assert.equal(model.id, 'proxied-sonnet');
    await preflightModels(
      [{ label: 'proxy', model: 'my-proxy/proxied-sonnet', thinking: 'off' }],
      authPath,
      modelsPath
    );
    await assert.rejects(
      preflightModels([{ label: 'x', model: 'nope/none', thinking: 'off' }], authPath, modelsPath),
      new RegExp(
        `unknown model nope/none: provider nope is not built into pi and not defined in ${modelsPath}`
      )
    );
    await assert.rejects(
      preflightModels(
        [{ label: 'x', model: 'my-proxy/other', thinking: 'off' }],
        authPath,
        modelsPath
      ),
      new RegExp(`provider my-proxy has no model other; see pi --list-models or ${modelsPath}`)
    );
  } finally {
    delete process.env.MY_PROXY_KEY;
  }
  // pi's catalog cache is not written next to the config file.
  assert.ok(!readdirSync(tmp).includes('models-store.json'));

  // A file pi would silently drop (a model without `api`, invalid JSON) is a ConfigError here.
  const broken = join(tmp, 'broken.json');
  writeFileSync(broken, JSON.stringify({ providers: { bad: { models: [{ id: 'x' }] } } }));
  await assert.rejects(
    createModelRuntime(authPath, broken),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message.startsWith(`${broken}: `) &&
      /Provider "bad": .*no "api" specified/.test(error.message)
  );
  writeFileSync(broken, '{ not json');
  await assert.rejects(
    createModelRuntime(authPath, broken),
    (error: unknown) =>
      error instanceof ConfigError && /Failed to parse models\.json/.test(error.message)
  );
});
