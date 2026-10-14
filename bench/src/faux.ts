import { pathToFileURL } from 'node:url';
import {
  type AssistantMessage,
  type FauxModelDefinition,
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxProvider,
  getSystemMessageText,
  type Message,
  type SimpleStreamOptions,
  type TranscriptContext
} from '@earendil-works/pi-ai';
import type { PiSettings } from './types.js';

export { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';

/** One scripted response, as in `test/session.test.ts`; `options.signal` fires on `session.abort()`. */
export type FauxStep = (
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined
) => AssistantMessage | Promise<AssistantMessage>;

export interface FauxScriptInfo {
  /** The session loaded pi-episodes (condition B). */
  episodes: boolean;
  cwd: string;
}

/** Module shape of `bench/test/scripts/<name>.ts`. */
export interface FauxScript {
  /** Static list, or a builder when the script differs between A and B. */
  steps: FauxStep[] | ((info: FauxScriptInfo) => FauxStep[]);
  /** Faux model fields; `contextWindow: 4000` makes pi's compaction fire early. */
  model?: Partial<FauxModelDefinition>;
  /** Merged over the run settings for every trial that uses this script (A and B alike). */
  settings?: Partial<PiSettings>;
  /** Reply to pi's compaction summary requests; default: a short fixed summary. */
  summary?: FauxStep;
}

export interface FauxDriver {
  handle: FauxProviderHandle;
  /** Assertion errors thrown inside steps; the provider turns them into error responses. */
  failures: unknown[];
  pending(): number;
  requests: TranscriptContext[];
}

export const FAUX_PROVIDER_ID = 'faux';
export const FAUX_MODEL_ID = 'faux-1';

const SUMMARY_PROMPT_HEAD = 'You are a context summarization assistant';

/** `await import()` is the only way to load a script by path; the rest of bench uses static imports. */
export async function loadFauxScript(path: string): Promise<FauxScript> {
  const module = (await import(pathToFileURL(path).href)) as Partial<FauxScript> & {
    default?: Partial<FauxScript>;
  };
  // A default export wins: it can carry `model` and `settings` next to `steps`.
  const script = module.default?.steps !== undefined ? module.default : module;
  if (script?.steps === undefined) {
    throw new Error(`${path}: a faux script must export \`steps\``);
  }
  return script as FauxScript;
}

/**
 * A fresh faux provider for one session, scripted by `script`. Compaction summary requests are
 * answered without consuming a step, so scripts count only their own turns.
 */
export function createFauxDriver(script: FauxScript, info: FauxScriptInfo): FauxDriver {
  const handle = fauxProvider({
    provider: FAUX_PROVIDER_ID,
    api: FAUX_PROVIDER_ID,
    models: [{ id: FAUX_MODEL_ID, ...script.model }]
  });
  const steps = typeof script.steps === 'function' ? script.steps(info) : [...script.steps];
  const summary: FauxStep = script.summary ?? (() => fauxAssistantMessage(DEFAULT_SUMMARY));
  const failures: unknown[] = [];
  const requests: TranscriptContext[] = [];
  let index = 0;

  // One factory per step; a summary request re-queues the step it displaced.
  const respond = (context: TranscriptContext, options: SimpleStreamOptions | undefined) => {
    requests.push(context);
    const step = isSummaryRequest(context) ? summary : steps[index++];
    if (step === undefined) throw new Error('No more faux responses queued');
    try {
      return step(context, options);
    } catch (error) {
      failures.push(error);
      throw error;
    }
  };
  // Summary requests consume a queued factory but not a script step, so queue spare factories;
  // past the script's end `respond` reports exhaustion like the provider itself would.
  handle.setResponses(Array.from({ length: steps.length + 64 }, () => respond));

  return {
    handle,
    failures,
    requests,
    pending: () => steps.length - index
  };
}

export const DEFAULT_SUMMARY = '## Goal\nContinue the task.\n\n## Progress\nSee the recent turns.';

export function isSummaryRequest(context: TranscriptContext): boolean {
  const system = context.messages.find((message) => message.role === 'system');
  return system?.role === 'system' && getSystemMessageText(system).startsWith(SUMMARY_PROMPT_HEAD);
}

/** Whether the request declares `name` as a tool (so a script can tell B from A). */
export function hasTool(context: TranscriptContext, name: string): boolean {
  return context.messages.some(
    (message) =>
      message.role === 'system' && (message.toolsAdded ?? []).some((tool) => tool.name === name)
  );
}

/** Plain text of a message; tool calls show as their name. */
export function messageText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'toolCall') return block.name;
      return '';
    })
    .join('\n');
}

/** Messages the model sees, without the system prompt. */
export function conversation(context: TranscriptContext): Message[] {
  return context.messages.filter((message) => message.role !== 'system');
}

/** Text of the last message in the request; typically the tool result the step is reacting to. */
export function lastText(context: TranscriptContext): string {
  const last = conversation(context).at(-1);
  return last === undefined ? '' : messageText(last);
}

/** A response that resolves after `ms`, or as soon as the request is aborted. */
export function stallingResponse(ms: number, text = 'late'): FauxStep {
  return (_context, options) =>
    new Promise<AssistantMessage>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve(fauxAssistantMessage(text));
      };
      const timer = setTimeout(done, ms);
      options?.signal?.addEventListener('abort', done, { once: true });
    });
}

/** A provider error pi retries: `stopReason: "error"` with a 429 text. */
export function throttledResponse(
  errorMessage = 'HTTP 429 Too Many Requests: rate limit exceeded'
): FauxStep {
  return () => fauxAssistantMessage([], { stopReason: 'error', errorMessage });
}

/** A text reply of roughly `tokens` tokens, for filling a small context window. */
export function longText(tokens: number, seed = 'line'): string {
  const lines: string[] = [];
  let length = 0;
  for (let index = 0; length < tokens * 4; index++) {
    const line = `${seed} ${index}: ${'x'.repeat(60)}`;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join('\n');
}
