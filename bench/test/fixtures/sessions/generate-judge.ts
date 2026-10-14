/**
 * Regenerates the judge fixtures (DESIGN 12, item 10) with pi's faux provider. The JSONL files
 * are committed; run `pnpm tsx bench/test/fixtures/sessions/generate-judge.ts` after a pi or
 * pi-episodes change that alters the session format or the episode tool results. The session
 * helper mirrors `generate.ts`; `write` and `edit` are added to the tool list because the
 * c1 triggers key on them.
 *
 * Fixtures, with the step request counts the judge tests use:
 * - `j-boundary` [4, 1, 6, 1]: a fold right after a step end (since at the step's first
 *   result, a kept user turn listed under Handled, the trap under Open), then a fold mid-step
 *   whose archived command is rerun within 3 turns; the reminder after both names them.
 * - `j-triggers` [4, 6, 6, 4]: a recall after an edit to a folded file, an archived command
 *   and error string rerun without a recall, a spurious zero-hit recall, a staleness line
 *   followed by an edit without a re-read, and one followed by a re-read.
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
  ModelRuntime,
  SessionManager,
  SettingsManager
} from '@earendil-works/pi-coding-agent';
import episodes from '../../../../src/index.js';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));
const TOOLS = ['bash', 'read', 'write', 'edit', 'fold', 'recall', 'ask', 'fork'];

type Step = (context: TranscriptContext) => AssistantMessage;

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

function expectLast(pattern: RegExp): Step {
  return (context) => {
    if (!pattern.test(lastText(context))) {
      throw new Error(`expected ${pattern} in the last message, got: ${lastText(context)}`);
    }
    return fauxAssistantMessage('(unused)');
  };
}

/** Runs `check` on the context, then returns `step`'s response. */
function checked(check: Step, step: Step): Step {
  return (context) => {
    check(context);
    return step(context);
  };
}

async function generate(name: string, prompts: string[], steps: Step[]) {
  const dir = mkdtempSync(join(tmpdir(), `bench-fixture-${name}-`));
  const cwd = join(dir, 'repo');
  mkdirSync(cwd);
  execFileSync('git', ['init', '-q'], { cwd });
  const faux = fauxProvider();
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
    extensionFactories: [(pi) => pi.registerProvider(faux.provider), episodes]
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir: dir,
    model: faux.getModel(),
    thinkingLevel: 'off',
    modelRuntime: await ModelRuntime.create({ modelsPath: null, authPath: join(dir, 'auth.json') }),
    resourceLoader,
    tools: TOOLS,
    sessionManager: SessionManager.create(cwd, join(dir, 'sessions')),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } })
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

const bash = (command: string) => () => fauxAssistantMessage(fauxToolCall('bash', { command }));
const say = (reply: string) => () => fauxAssistantMessage(reply);
const edit = (path: string, oldText: string, newText: string) => () =>
  fauxAssistantMessage(fauxToolCall('edit', { path, edits: [{ oldText, newText }] }));

await generate(
  'j-boundary',
  ['implement mul', 'quick aside: what is 2+3?', 'implement sub', 'which file holds mul?'],
  [
    // goal-1 (r0-r3): user t1, results t2-t4.
    () =>
      fauxAssistantMessage(
        fauxToolCall('write', {
          path: 'src/add.js',
          content: "export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\nconsole.log('debug');\n"
        })
      ),
    bash('echo "1 failing"'),
    bash('echo "tests 2 pass 2"'),
    say('Done: mul added.'),
    // aside (r4): user t5, answered without tools.
    say('5.'),
    // goal-2 (r5-r10): user t6. The fold covers goal-1 and the aside: lateness 2, since at the
    // first result of goal-1, the aside's user turn kept and listed under Handled.
    () =>
      fauxAssistantMessage(
        fauxToolCall('fold', {
          since: 't2',
          note: [
            'mul added to src/add.js: tests pass (2/2).',
            '- Changed: src/add.js now exports mul next to add.',
            '- Learned: mul lives in src/add.js next to add, only when exported.',
            '- Handled: t5: answered 5.',
            '- Open: remove the console.log debug line in src/add.js.'
          ].join('\n')
        })
      ),
    checked(expectLast(/\[fold ep-[0-9a-f]{8}: /), bash('echo "sub: 1 failing"')),
    edit('src/add.js', "console.log('debug');\n", 'export const sub = (a, b) => a - b;\n'),
    // Mid-step fold: since inside goal-2, called before the step's final reply.
    () =>
      fauxAssistantMessage(
        fauxToolCall('fold', {
          since: 't8',
          note: 'Sub added to src/add.js; tests not yet run.\n- Open: run the tests.'
        })
      ),
    // Repeats the archived command of the second fold within 3 turns, with no recall.
    checked(expectLast(/\[fold ep-[0-9a-f]{8}: /), bash('echo "sub: 1 failing"')),
    say('Done: sub added.'),
    // probe-1 (r11): user t12; the reminder before it names both folds.
    checked(
      expectLast(/Open items from work folded since the last reminder/),
      say('mul is in src/add.js.')
    )
  ]
);

await generate(
  'j-triggers',
  ['make it build', 'now the tests', 'anything else?', 'touch src/app.js again'],
  [
    // goal-1 (r0-r3): user t1, results t2-t4.
    () =>
      fauxAssistantMessage(fauxToolCall('write', { path: 'src/app.js', content: 'module.exports = 1;\n' })),
    bash('echo "error TS2322 in src/app.js"'),
    bash('echo "build passed"'),
    say('Build green.'),
    // step 2 (r4-r9): user t5. Fold right after the step end.
    () =>
      fauxAssistantMessage(
        fauxToolCall('fold', {
          since: 't2',
          note: 'Build: TS2322 in src/app.js fixed by rewriting it.\n- Learned: src/app.js must export a number.\n- Open: none.'
        })
      ),
    // Shell change to the folded file, so the recall below carries a staleness line.
    checked(expectLast(/\[fold ep-[0-9a-f]{8}: /), bash('printf two > src/app.js')),
    // Recall before the edit: shares "app.js" with the edit trigger, so c2 passes.
    () => fauxAssistantMessage(fauxToolCall('recall', { query: 'app.js TS2322' })),
    // The staleness line was shown; the edit follows without a re-read (e2 fails).
    checked(
      expectLast(/predates changes to: src\/app\.js/),
      edit('src/app.js', 'two', 'module.exports = 2;')
    ),
    // Archived command and error string rerun, no recall near it that shares a token.
    bash('echo "error TS2322 in src/app.js"'),
    say('Tests next.'),
    // step 3 (r10-r15): user t11. Padding so the recall is more than 3 turns from any trigger,
    // including the one the next prompt raises by naming src/app.js.
    bash('echo pad'),
    bash('echo pad2'),
    () => fauxAssistantMessage(fauxToolCall('recall', { query: 'zzz-nothing-here' })),
    checked(expectLast(/No match for "zzz-nothing-here"/), bash('echo pad3')),
    bash('echo pad4'),
    say('Nothing.'),
    // step 4 (r16-r19): user t17 names src/app.js. Staleness line, re-read, then the edit.
    () => fauxAssistantMessage(fauxToolCall('recall', { query: '"TS2322 in src/app.js"' })),
    checked(
      expectLast(/predates changes to: src\/app\.js/),
      () => fauxAssistantMessage(fauxToolCall('read', { path: 'src/app.js' }))
    ),
    edit('src/app.js', 'module.exports = 2;', 'module.exports = 3;'),
    say('Done.')
  ]
);
