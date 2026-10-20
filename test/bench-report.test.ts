import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type TestContext, test } from 'node:test';

const repo = resolve(import.meta.dirname, '..');

function fixture(t: TestContext) {
  const out = join(repo, 'bench', '.out');
  mkdirSync(out, { recursive: true });
  const dir = mkdtempSync(join(out, 'report-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  for (const arm of ['pi', 'pi-episodes']) {
    const trial = join(dir, arm);
    mkdirSync(trial);
    writeFileSync(
      join(trial, 'result.json'),
      JSON.stringify({
        id: arm,
        task_name: 'example/task',
        agent_info: { name: arm, version: '1.1.0' },
        config: { agent: { model_name: 'example/model' } },
        agent_result: { n_input_tokens: 100, n_output_tokens: 10, cost_usd: 0.1 },
        verifier_result: { rewards: { reward: 1, partial: 1 } },
        agent_execution: {
          started_at: '2026-10-14T12:00:00Z',
          finished_at: '2026-10-14T12:01:00Z'
        }
      })
    );
  }
  return dir;
}

function report(args: string[]) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'bench/scripts/report.ts', ...args],
    {
      cwd: repo,
      encoding: 'utf8',
      timeout: 30_000
    }
  );
  assert.ifError(result.error);
  return result;
}

for (const args of [[], ['--format', 'html'], ['--format']]) {
  test(`report rejects a missing or unsupported format: ${args.join(' ')}`, (t) => {
    const dir = fixture(t);
    const result = report([dir, ...args]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(dir, 'report.md')), false);
    assert.equal(existsSync(join(dir, 'trials.csv')), false);
    assert.equal(existsSync(join(dir, 'rows.yaml')), false);
  });
}

test('Markdown mode prints and writes Markdown; table mode preserves identical exports', (t) => {
  const dir = fixture(t);
  const markdown = report([dir, '--format', 'md']);
  assert.equal(markdown.status, 0, markdown.stderr);
  assert.match(markdown.stdout, /\| model \| tasks \| pass \|/);
  assert.equal(readFileSync(join(dir, 'report.md'), 'utf8'), markdown.stdout);
  const csv = readFileSync(join(dir, 'trials.csv'), 'utf8');
  const yaml = readFileSync(join(dir, 'rows.yaml'), 'utf8');

  const tables = report(['--format', 'table', dir]);
  assert.equal(tables.status, 0, tables.stderr);
  assert.match(tables.stdout, /\(index\)/);
  assert.match(tables.stdout, /Episodes against plain pi/);
  assert.match(tables.stdout, /example\/model/);
  assert.doesNotMatch(tables.stdout, /^##? /m);
  assert.equal(readFileSync(join(dir, 'report.md'), 'utf8'), markdown.stdout);
  assert.equal(readFileSync(join(dir, 'trials.csv'), 'utf8'), csv);
  assert.equal(readFileSync(join(dir, 'rows.yaml'), 'utf8'), yaml);
});

test('table mode does not create a Markdown report', (t) => {
  const dir = fixture(t);
  const result = report([dir, '--format', 'table']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(dir, 'report.md')), false);
  assert.ok(existsSync(join(dir, 'trials.csv')));
  assert.ok(existsSync(join(dir, 'rows.yaml')));
});
