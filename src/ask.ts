import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { convertToLlm, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { ThreadIndex } from './archive.js';
import { textOf } from './messages.js';
import { staleness } from './recall.js';
import { requestOptions } from './requests.js';
import type { EpisodeState } from './state.js';
import { type AskDetails, askRenderers } from './ui.js';

function question(text: string): AgentMessage {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `[question from the main thread, which no longer holds this span]\n${text}\n\nAnswer from what this thread already contains. Do not call tools. If the answer needs new reads or commands, say what is missing instead.`
      }
    ],
    timestamp: Date.now()
  };
}

const AskParams = Type.Object({
  handle: Type.String({
    description: 'Archived thread to ask, such as "ep-1a2b3c4d" or "fk-1a2b3c4d".'
  }),
  question: Type.String({
    description: 'A judgment question about that work: why something was done, what was ruled out.'
  })
});

export function registerAsk(pi: ExtensionAPI, state: EpisodeState): void {
  pi.registerTool<typeof AskParams, AskDetails>({
    name: 'ask',
    label: 'Ask',
    description:
      'Ask an archived thread (folded span or finished fork) one question. The thread is resumed with everything it held, answers once without acting, and only the answer comes back. Use recall instead when you know the exact text to look for.',
    promptSnippet: 'Ask an archived thread a question; it answers from its full context',
    parameters: AskParams,
    renderCall: askRenderers.renderCall,
    renderResult: askRenderers.renderResult,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const model = ctx.model;
      if (!model) throw new Error('No model selected.');

      const thread = await new ThreadIndex(ctx.sessionManager, state.forkArchives).find(
        params.handle
      );
      if (!thread) throw new Error(`No archived thread ${params.handle}.`);

      // The thread's own system messages carry its prompt and tools, so the request repeats
      // its prefix byte for byte and can read it from the cache while it is alive.
      const messages = [...thread.context(), question(params.question)];
      const response = await ctx.modelRegistry
        .streamSimple(
          model,
          { messages: convertToLlm(messages) },
          requestOptions(pi, ctx, messages, signal)
        )
        .result();

      if (response.stopReason === 'error' || response.stopReason === 'aborted') {
        throw new Error(response.errorMessage ?? `ask ${response.stopReason}`);
      }

      const answer =
        textOf(
          response.content.flatMap((block) => (block.type === 'text' ? [block] : []))
        ).trim() ||
        'The thread tried to act instead of answering. Use fork if the question needs new work.';
      const notes = await staleness(state, [thread]);

      return {
        content: [
          { type: 'text', text: [...notes, `[${thread.handle} answers]`, answer].join('\n') }
        ],
        details: { handle: thread.handle, question: params.question },
        usage: response.usage
      };
    }
  });
}
