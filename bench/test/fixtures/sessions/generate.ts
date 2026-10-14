/**
 * Regenerates the session fixtures in this directory with pi's faux provider. The JSONL files
 * are committed so the tests do not depend on this script; run it with
 * `pnpm tsx bench/test/fixtures/sessions/generate.ts` after a pi or pi-episodes change that
 * alters the session format or the episode tool results.
 *
 * Fixtures:
 * - `b-episodes`: pi + episodes; fold (alone, right before the final reply), fold that is
 *   rejected, fold sharing its response with another call, recall with a hit and a staleness
 *   line, a zero-hit recall, a regex recall, ask, fork (with its `fk-*.json` archive), an
 *   invalid `since` (tool schema error).
 * - `a-plain`: plain pi, two prompts, bash and read only.
 * - `b-compaction`: pi + episodes with a 4000-token faux model and compaction enabled, so pi's
 *   threshold compaction fires mid-run.
 * - `b-suspect`: pi + episodes where one assistant message's usage violates
 *   `input + cacheRead + cacheWrite + output == totalTokens`. The faux provider recomputes
 *   usage on every response, so the violation is applied by a `message_end` extension hook.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Message,
  type TranscriptContext
} from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager
} from '@earendil-works/pi-coding-agent';
import episodes from '../../../../src/index.js';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

type Step = (context: TranscriptContext) => AssistantMessage;

interface SessionOptions {
  episodes: boolean;
  tools: string[];
  contextWindow?: number;
  compaction?: { enabled: boolean; reserveTokens?: number; keepRecentTokens?: number };
  extraExtensions?: ((pi: ExtensionAPI) => void)[];
}

function text(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((block) =>
      block.type === 'text' ? block.text : block.type === 'toolCall' ? block.name : ''
    )
    .join('\n');
}

function lastText(context: TranscriptContext): string {
  const last = context.messages.at(-1);
  return last ? text(last) : '';
}

function handleIn(pattern: RegExp, context: TranscriptContext): string {
  for (const message of [...context.messages].reverse()) {
    const match = pattern.exec(text(message));
    if (match) return match[0];
  }
  throw new Error(`no ${pattern} in the context`);
}

async function generate(name: string, prompts: string[], steps: Step[], options: SessionOptions) {
  const dir = mkdtempSync(join(tmpdir(), `bench-fixture-${name}-`));
  // The repo the agent works in; sessions live outside it so the working tree diff a fold
  // records does not list the session file itself.
  const cwd = join(dir, 'repo');
  mkdirSync(cwd);
  execFileSync('git', ['init', '-q'], { cwd });
  const faux = fauxProvider(
    options.contextWindow === undefined
      ? {}
      : { models: [{ id: 'faux-1', contextWindow: options.contextWindow }] }
  );
  const failures: unknown[] = [];
  faux.setResponses(
    steps.map((step) => (context) => {
      try {
        return step(context);
      } catch (error) {
        failures.push(error);
        throw error;
      }
    })
  );

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: dir,
    noSkills: true,
    noPromptTemplates: true,
    noExtensions: true,
    extensionFactories: [
      (pi) => pi.registerProvider(faux.provider),
      ...(options.episodes ? [episodes] : []),
      ...(options.extraExtensions ?? [])
    ]
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir: dir,
    model: faux.getModel(),
    thinkingLevel: 'off',
    modelRuntime: await ModelRuntime.create({ modelsPath: null, authPath: join(dir, 'auth.json') }),
    resourceLoader,
    tools: options.tools,
    sessionManager: SessionManager.create(cwd, join(dir, 'sessions')),
    settingsManager: SettingsManager.inMemory({
      compaction: options.compaction ?? { enabled: false }
    })
  });
  await session.bindExtensions({});

  try {
    for (const prompt of prompts) await session.prompt(prompt);
    if (failures[0]) throw failures[0];
    if (faux.getPendingResponseCount() !== 0) {
      throw new Error(`${name}: ${faux.getPendingResponseCount()} faux responses left`);
    }
    const file = session.sessionManager.getSessionFile();
    if (!file) throw new Error(`${name}: session not persisted`);
    session.dispose();

    const target = join(OUT_DIR, `${name}.jsonl`);
    const archives = `${file.slice(0, -'.jsonl'.length)}.episodes`;
    rmSync(target, { force: true });
    rmSync(join(OUT_DIR, `${name}.episodes`), { recursive: true, force: true });
    cpSync(file, target);
    if (existsSync(archives)) {
      cpSync(archives, join(OUT_DIR, `${name}.episodes`), { recursive: true });
    }
    process.stdout.write(`${name}: ${target}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const EPISODE_TOOLS = ['bash', 'read', 'fold', 'recall', 'ask', 'fork'];

await generate(
  'b-episodes',
  ['make it build', 'look back at it', 'wrap up'],
  [
    // Prompt 1: an episode, folded right before the final reply.
    () => fauxAssistantMessage(fauxToolCall('bash', { command: 'printf one > a.txt' })),
    () => fauxAssistantMessage(fauxToolCall('bash', { command: 'echo "error TS2322 in api.ts"' })),
    () => fauxAssistantMessage(fauxToolCall('bash', { command: 'echo build passed' })),
    () =>
      fauxAssistantMessage(
        fauxToolCall('fold', {
          since: 't2',
          note: 'Build passes after regenerating the client.\n- Open: remove the debug flag in vite.config.ts.'
        })
      ),
    () => fauxAssistantMessage('Folded. The build is green.'),
    // Prompt 2: the reminder lands before this request; going back with recall, ask, fork.
    () => fauxAssistantMessage(fauxToolCall('bash', { command: 'printf two > a.txt' })),
    () => fauxAssistantMessage(fauxToolCall('recall', { query: '"TS2322"' })),
    (context) => {
      if (!/predates changes to: a\.txt/.test(lastText(context))) {
        throw new Error(`expected a staleness line, got: ${lastText(context)}`);
      }
      return fauxAssistantMessage(fauxToolCall('recall', { query: 'nothing-here-xyz' }));
    },
    () => fauxAssistantMessage(fauxToolCall('recall', { query: 'TS\\d+', regex: true })),
    (context) =>
      fauxAssistantMessage(
        fauxToolCall('ask', {
          handle: handleIn(/ep-[0-9a-f]{8}/, context),
          question: 'Why did the first build fail?'
        })
      ),
    // The ask request resumes the archived thread.
    () => fauxAssistantMessage('The generated client was stale.'),
    () => fauxAssistantMessage(fauxToolCall('fork', { task: 'Check the tests.' })),
    // The fork child.
    () => fauxAssistantMessage(fauxToolCall('bash', { command: 'echo tests ok' })),
    () => fauxAssistantMessage('Changed: nothing. Learned: tests pass.'),
    // A fold that reaches behind the first note is rejected.
    () => fauxAssistantMessage(fauxToolCall('fold', { since: 't1', note: 'everything' })),
    // A made-up stamp fails validation.
    () => fauxAssistantMessage(fauxToolCall('fold', { since: 'banana', note: 'x' })),
    // A fold sharing its response with another call.
    () =>
      fauxAssistantMessage([
        fauxToolCall('fold', { since: 't7', note: 'Looked back: the client was stale.' }),
        fauxToolCall('bash', { command: 'echo hi' })
      ]),
    () => fauxAssistantMessage('Looked back.'),
    // Prompt 3.
    () => fauxAssistantMessage(fauxToolCall('read', { path: 'a.txt' })),
    () => fauxAssistantMessage('All done.')
  ],
  { episodes: true, tools: EPISODE_TOOLS }
);

await generate(
  'a-plain',
  ['make it build', 'look back at it'],
  [
    () => fauxAssistantMessage(fauxToolCall('bash', { command: 'printf one > a.txt' })),
    () => fauxAssistantMessage(fauxToolCall('bash', { command: 'echo "error TS2322 in api.ts"' })),
    () => fauxAssistantMessage(fauxToolCall('bash', { command: 'echo build passed' })),
    () => fauxAssistantMessage('The build is green.'),
    () => fauxAssistantMessage(fauxToolCall('read', { path: 'a.txt' })),
    () => fauxAssistantMessage('It failed with TS2322 before the fix.')
  ],
  { episodes: false, tools: ['bash', 'read'] }
);

// The system prompt alone is about 3000 faux tokens; the threshold is 4600 - 1000. The
// `seq` output pushes the context over it, so pi compacts after that turn (the summarizer
// consumes the next scripted response) and keeps the `seq` turn. The fold then removes that
// turn, which brings the context back under the threshold; otherwise pi would compact again
// after every later turn.
await generate(
  'b-compaction',
  ['make it build', 'next'],
  [
    () => fauxAssistantMessage(fauxToolCall('bash', { command: 'echo "error TS2322 in api.ts"' })),
    () => fauxAssistantMessage(fauxToolCall('bash', { command: 'seq 1 700' })),
    () => fauxAssistantMessage('## Goal\nMake it build. At t2 the build failed with a type error.'),
    (context) => {
      if (!/archived as cp-[0-9a-f]{8}/.test(lastText(context))) {
        throw new Error(`expected the compaction notice, got: ${lastText(context)}`);
      }
      return fauxAssistantMessage(
        fauxToolCall('fold', { since: 't3', note: 'Listed 700 numbers; nothing needed from it.' })
      );
    },
    () => fauxAssistantMessage('Fixed by regenerating the client.'),
    () => fauxAssistantMessage(fauxToolCall('bash', { command: 'echo ok' })),
    () => fauxAssistantMessage('Done.')
  ],
  {
    episodes: true,
    tools: EPISODE_TOOLS,
    contextWindow: 4600,
    compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 200 }
  }
);

await generate(
  'b-suspect',
  ['make it build'],
  [
    () => fauxAssistantMessage(fauxToolCall('bash', { command: 'echo build passed' })),
    () => fauxAssistantMessage('The build is green.')
  ],
  {
    episodes: true,
    tools: EPISODE_TOOLS,
    extraExtensions: [
      (pi) => {
        let seen = 0;
        pi.on('message_end', (event) => {
          if (event.message.role !== 'assistant' || ++seen !== 2) return undefined;
          const usage = {
            ...event.message.usage,
            totalTokens: event.message.usage.totalTokens + 7
          };
          return { message: { ...event.message, usage } };
        });
      }
    ]
  }
);
