import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getSystemMessageText, type SystemMessage } from '@earendil-works/pi-ai';
import { EPISODES_SECTION } from '../../src/prompt.js';
import { DEFAULT_AUTH_PATH, loadRunConfig } from '../src/config.js';
import { type FauxScript, loadFauxScript } from '../src/faux.js';
import {
  EPISODE_TOOLS,
  episodesToolDescriptions,
  promptIdFrom,
  promptIdFromSession,
  readSession,
  sha256
} from '../src/jsonl.js';
import { Logger } from '../src/log.js';
import { loadScenario } from '../src/scenario.js';
import {
  applyIsolatedEnv,
  buildSettings,
  closeTrialSession,
  completeAudit,
  createIsolatedDirs,
  createTrialSession,
  driveStep,
  dryRunPromptId,
  findSystemMessage,
  isolatedEnv,
  loadedExtensionPaths,
  preflightModels,
  systemPromptHash,
  type TrialSession,
  writeSettings
} from '../src/session.js';
import type { ConditionSpec, ModelSpec, Step } from '../src/types.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const miniChain = fileURLToPath(new URL('./fixtures/mini-chain', import.meta.url));
const scripts = fileURLToPath(new URL('./scripts', import.meta.url));
const scenario = loadScenario(miniChain);
const config = loadRunConfig();
const model: ModelSpec = { label: 'faux', model: 'faux/faux-1', thinking: 'off' };
const A: ConditionSpec = { id: 'A' };
const B: ConditionSpec = { id: 'B', extension: join(root, 'src/index.ts') };
const log = new Logger({ stderr: false });

let tmp: string;
let restoreEnv: () => void;
let dirs: ReturnType<typeof createIsolatedDirs>;
const settings = buildSettings(config, { retry: { maxRetries: 2, baseDelayMs: 10 } });

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'bench-session-'));
  dirs = createIsolatedDirs(join(tmp, 'run'), join(tmp, 'npm-cache'));
  writeSettings(dirs, settings);
  restoreEnv = applyIsolatedEnv(dirs);
});

after(() => {
  restoreEnv();
  rmSync(tmp, { recursive: true, force: true });
});

/** A sealed copy of the mini-chain repo, like repo.ts would make. */
function makeRepo(name: string): string {
  const dir = join(tmp, name, 'repo');
  cpSync(join(miniChain, 'repo'), dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

async function open(
  name: string,
  condition: ConditionSpec,
  script: FauxScript
): Promise<TrialSession> {
  const cwd = makeRepo(name);
  return createTrialSession({
    model,
    condition,
    cwd,
    sessionDir: join(tmp, name, 'session'),
    dirs,
    settings,
    authPath: DEFAULT_AUTH_PATH,
    modelsPath: null,
    provider: 'faux',
    fauxScript: script
  });
}

function step(id: string, kind: Step['kind'], text: string): Step {
  return { id, kind, prompt: `steps/${id}.md`, text };
}

test('isolation: empty HOME, settings-only agent dir, exactly the configured extension', async () => {
  const miniScript = await loadFauxScript(join(scripts, 'mini-chain.ts'));
  const a1 = await open('a1', A, miniScript);
  const a2 = await open('a2', A, miniScript);
  const b = await open('b', B, miniScript);
  try {
    assert.deepEqual(readdirSync(dirs.home), []);
    assert.deepEqual(readdirSync(dirs.agent), ['settings.json']);
    assert.deepEqual(JSON.parse(readFileSync(join(dirs.agent, 'settings.json'), 'utf8')), settings);
    for (const [key, value] of Object.entries(isolatedEnv(dirs))) {
      assert.equal(process.env[key], value, key);
    }

    assert.deepEqual(loadedExtensionPaths(a1.audit), []);
    assert.deepEqual(loadedExtensionPaths(b.audit), [B.extension]);
    assert.deepEqual(a1.audit.tools, ['read', 'bash', 'edit', 'write']);
    assert.deepEqual(b.audit.tools, ['read', 'bash', 'edit', 'write', ...EPISODE_TOOLS]);
    assert.equal(a1.audit.model, 'faux/faux-1');
    assert.equal(a1.audit.authKind, 'faux');
    assert.equal(a1.audit.thinking, 'off');
    assert.equal(a1.audit.contextWindow, 128000);
    assert.deepEqual(a1.audit.settings, settings);
    assert.deepEqual(b.audit.settings, settings);
    // Cache warming off in both conditions (DESIGN 2, 6): no requests outside the model's turns.
    assert.equal(settings.cacheWarming, 'off');
    assert.equal(a1.session.settingsManager.getCacheWarmingMode(), 'off');
    assert.equal(b.session.settingsManager.getCacheWarmingMode(), 'off');
    assert.match(a1.audit.piVersion, /^\d+\.\d+\.\d+/);
    assert.equal(a1.audit.episodesCommit, undefined);
    assert.match(b.audit.episodesCommit ?? '', /^[0-9a-f]{40}$/);

    // The prompt fields come from the JSONL system message, written on the first request.
    const goal = scenario.steps[0]!;
    const caps = { wallMs: 30_000, turns: 50 };
    for (const trial of [a1, a2, b]) {
      const result = await driveStep(trial.session, goal, caps, log);
      assert.equal(result.end, 'settled', result.errors.join('; '));
      assert.equal(completeAudit(trial.session, trial.audit), undefined);
      assert.equal(trial.audit.api, 'faux');
    }
    assert.equal(a1.audit.systemPromptHash, a2.audit.systemPromptHash);
    assert.notEqual(a1.audit.systemPromptHash, b.audit.systemPromptHash);
    assert.equal(a1.audit.promptId, undefined);
    assert.match(b.audit.promptId ?? '', /^[0-9a-f]{12}$/);

    // B differs from A only by the episodes section and the four tool declarations: remove
    // them from B's system message and compare with A's.
    const systemA = findSystemMessage(a1.session)!;
    const systemB = findSystemMessage(b.session)!;
    const stripped = stripEpisodes(systemB);
    const { cwd: cwdA, ...sectionsA } = systemA.sections ?? {};
    const { cwd: cwdB, ...sectionsB } = stripped.sections ?? {};
    assert.deepEqual(sectionsB, sectionsA);
    assert.deepEqual(stripped.toolsAdded, systemA.toolsAdded);
    assert.equal(cwdA, `<cwd>\n${join(tmp, 'a1', 'repo')}\n</cwd>`);
    assert.equal(cwdB, `<cwd>\n${join(tmp, 'b', 'repo')}\n</cwd>`);
    assert.equal(systemPromptHash(stripped), a1.audit.systemPromptHash);
    assert.equal(systemPromptHash(systemB), b.audit.systemPromptHash);

    // The id is the DESIGN 2 formula over the extension's own constant and tool descriptions.
    const descriptions = episodesToolDescriptions(systemB.toolsAdded ?? [])!;
    const expected = sha256(`${EPISODES_SECTION}\n${descriptions.join('\n')}`).slice(0, 12);
    assert.equal(b.audit.promptId, expected);
    assert.equal(promptIdFrom(getSystemMessageText(systemB), descriptions), expected);
    assert.equal(promptIdFrom(getSystemMessageText(systemA), descriptions), undefined);

    // The dry run, the live session's audit and the stored JSONL agree on the id (DESIGN 2:
    // one formula, recomputable from any stored session).
    const dry = await dryRunPromptId(B, model, dirs, settings, DEFAULT_AUTH_PATH);
    assert.equal(dry.promptId, b.audit.promptId);
    assert.deepEqual(dry.toolDescriptions, descriptions);
    assert.equal(promptIdFromSession(readSession(b.session.sessionFile!).entries), expected);
    assert.equal(promptIdFromSession(readSession(a1.session.sessionFile!).entries), undefined);
    assert.deepEqual(readdirSync(dirs.agent), ['settings.json']);
    assert.deepEqual(readdirSync(dirs.home), []);
    assert.deepEqual(readdirSync(join(tmp, 'run')), ['agent', 'home'], 'dry run scratch removed');

    assert.ok(b.session.sessionFile?.startsWith(join(tmp, 'b', 'session')));
    assert.equal(b.faux?.failures.length, 0);
  } finally {
    for (const trial of [a1, a2, b]) await closeTrialSession(trial.session);
  }
});

/** B's system message without the `<episodes>` section, the four tools and their `<tools>` lines. */
function stripEpisodes(message: SystemMessage): SystemMessage {
  const sections: Record<string, string | null> = {};
  for (const [name, text] of Object.entries(message.sections ?? {})) {
    if (name === 'episodes') continue;
    sections[name] =
      name === 'tools' && text !== null
        ? text
            .split('\n')
            .filter((line) => !EPISODE_TOOLS.some((tool) => line.startsWith(`- ${tool}: `)))
            .join('\n')
        : text;
  }
  const toolsAdded = (message.toolsAdded ?? []).filter(
    (tool) => !(EPISODE_TOOLS as readonly string[]).includes(tool.name)
  );
  return { ...message, sections, toolsAdded };
}

test('preflightModels rejects an unknown model before any trial', async () => {
  await assert.rejects(
    preflightModels([{ label: 'x', model: 'nope/none', thinking: 'off' }], DEFAULT_AUTH_PATH, null),
    /unknown model nope\/none: provider nope is not built into pi; define it in .*models\.pi\.json/
  );
  await assert.rejects(
    preflightModels(
      [{ label: 'x', model: 'anthropic/no-such-model', thinking: 'off' }],
      DEFAULT_AUTH_PATH,
      null
    ),
    /unknown model anthropic\/no-such-model: provider anthropic has no model no-such-model/
  );
});

test('driveStep counts requests, tool calls and the fold under B', async () => {
  const miniScript = await loadFauxScript(join(scripts, 'mini-chain.ts'));
  const trial = await open('drive-b', B, miniScript);
  try {
    const results = [];
    for (const current of scenario.steps) {
      results.push(await driveStep(trial.session, current, { wallMs: 30_000 }, log));
    }
    assert.equal(trial.faux?.failures.length, 0);
    assert.equal(trial.faux?.pending(), 0);
    const [goal1, aside, goal2, probe] = results;
    assert.equal(goal1?.requests, 6);
    assert.deepEqual(goal1?.toolCalls, { read: 1, write: 2, bash: 1, fold: 1 });
    assert.equal(goal1?.answer, undefined);
    assert.equal(aside?.requests, 1);
    assert.equal(aside?.answer, '`add(2, 3)` returns 5.');
    assert.deepEqual(goal2?.toolCalls, { recall: 2, edit: 1, write: 1, bash: 1 });
    assert.equal(probe?.answer, 'I added `mul` to `src/add.js`.');
    for (const result of results) {
      assert.equal(result.end, 'settled');
      assert.equal(result.retries, 0);
      assert.equal(result.compactions, 0);
      assert.ok((result.durationMs ?? -1) >= 0);
    }
    assert.ok(readFileSync(join(tmp, 'drive-b', 'repo', 'src', 'add.js'), 'utf8').includes('sub'));
    // The fold is a context edit in the JSONL; only forks write transcripts to `.episodes/`.
    const entries = readFileSync(trial.session.sessionFile!, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string });
    assert.ok(
      entries.some((entry) => entry.type === 'context_edit'),
      'fold recorded'
    );
  } finally {
    await closeTrialSession(trial.session);
  }
});

test('driveStep ends a stalled step as timeout at a 1-second cap', async () => {
  const trial = await open('stall', A, await loadFauxScript(join(scripts, 'stall.ts')));
  try {
    const started = Date.now();
    const result = await driveStep(
      trial.session,
      step('goal-1', 'goal', 'go'),
      { wallMs: 1000 },
      log
    );
    assert.equal(result.end, 'timeout');
    assert.ok(Date.now() - started < 10_000, 'abort cut the stall short');
    assert.ok(result.durationMs !== undefined && result.durationMs >= 1000);
  } finally {
    await closeTrialSession(trial.session);
  }
});

test('driveStep ends at the turn cap', async () => {
  const trial = await open('turns', A, await loadFauxScript(join(scripts, 'many-turns.ts')));
  try {
    const result = await driveStep(
      trial.session,
      step('goal-1', 'goal', 'go'),
      { wallMs: 30_000, turns: 5 },
      log
    );
    assert.equal(result.end, 'turn_cap');
    assert.equal(result.requests, 5);
    assert.equal(result.toolCalls.bash, 5);
  } finally {
    await closeTrialSession(trial.session);
  }
});

test('driveStep reports three 429 responses as an error end', async () => {
  const trial = await open('throttle', A, await loadFauxScript(join(scripts, 'throttle.ts')));
  try {
    const result = await driveStep(
      trial.session,
      step('goal-1', 'goal', 'go'),
      { wallMs: 30_000 },
      log
    );
    assert.equal(result.end, 'error');
    assert.equal(result.throttled, 3);
    assert.equal(result.retries, 2);
    assert.equal(result.errors.length, 3);
    assert.match(result.errors[0] ?? '', /429/);
  } finally {
    await closeTrialSession(trial.session);
  }
});

test('driveStep keeps a step settled on a 400: not infra, the error text is recorded', async () => {
  const trial = await open('bad-request', A, await loadFauxScript(join(scripts, 'bad-request.ts')));
  try {
    const result = await driveStep(
      trial.session,
      step('goal-1', 'goal', 'go'),
      { wallMs: 30_000 },
      log
    );
    assert.equal(result.end, 'settled');
    assert.equal(result.throttled, 0);
    assert.equal(result.retries, 0);
    assert.deepEqual(result.errors, ['HTTP 400 Bad Request: invalid transcript at line 512']);
    // The next step goes on in the same session.
    const next = await driveStep(
      trial.session,
      step('probe', 'probe', 'and?'),
      { wallMs: 30_000 },
      log
    );
    assert.equal(next.end, 'settled');
    assert.equal(next.answer, 'ok');
  } finally {
    await closeTrialSession(trial.session);
  }
});

test('the faux driver answers compaction summaries without consuming script steps', async () => {
  const compaction = await loadFauxScript(join(scripts, 'compaction.ts'));
  const cwd = makeRepo('compaction');
  mkdirSync(join(tmp, 'compaction', 'session'), { recursive: true });
  const trial = await createTrialSession({
    model,
    condition: A,
    cwd,
    sessionDir: join(tmp, 'compaction', 'session'),
    dirs,
    settings: buildSettings(config, compaction.settings),
    authPath: DEFAULT_AUTH_PATH,
    modelsPath: null,
    provider: 'faux',
    fauxScript: compaction
  });
  try {
    assert.equal(trial.audit.contextWindow, 4000);
    const result = await driveStep(
      trial.session,
      step('goal-1', 'goal', 'go'),
      { wallMs: 30_000 },
      log
    );
    assert.equal(result.end, 'settled', result.errors.join('; '));
    assert.ok(result.compactions >= 1, `compactions: ${result.compactions}`);
    assert.equal(result.requests, 4);
    assert.equal(trial.faux?.failures.length, 0);
    const entries = readFileSync(trial.session.sessionFile!, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string });
    assert.ok(entries.some((entry) => entry.type === 'compaction'));
  } finally {
    await closeTrialSession(trial.session);
  }
});
