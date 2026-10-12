import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Agent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core';
import { getCurrentTools, type Tool } from '@earendil-works/pi-ai';
import {
  convertToLlm,
  type ExtensionAPI,
  type ExtensionToolContext
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  archiveDir,
  FOLD_TOOL,
  FORK_TOOL,
  type ForkArchive,
  type ForkDetails,
  writeForkArchive
} from './archive.js';
import { changeLines, headline } from './fold.js';
import type { ForkRegistry, LiveFork } from './forks-view.js';
import { textOf, touchedPaths } from './messages.js';
import { addUsage, emptyUsage, requestOptions } from './requests.js';
import type { DiskChange } from './snapshots.js';
import type { EpisodeState } from './state.js';
import { forkRenderers, refreshStatus } from './ui.js';

const MAX_START_PERCENT = 70;
/** A fork that runs this long is not finishing; it is stopped and its work archived. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The other fork calls in the same response have no result yet. Pi would close them with a
 * synthetic error, which the child would read as a failed sibling; this reads as what it is.
 */
/** `episodes.forkTimeoutMs` in pi's settings, which have no slot for extension keys. */
function forkTimeout(settings: object): number | undefined {
  const episodes = (settings as { episodes?: { forkTimeoutMs?: unknown } }).episodes;
  const value = episodes?.forkTimeoutMs;
  return typeof value === 'number' && value > 0 ? value : undefined;
}

function siblingResults(prefix: readonly AgentMessage[], toolCallId: string): AgentMessage[] {
  const last = prefix.at(-1);
  const caller = prefix.findLast((message) => message.role === 'assistant');
  if (caller?.role !== 'assistant') return [];
  const answered = new Set(
    prefix.flatMap((message) => (message.role === 'toolResult' ? [message.toolCallId] : []))
  );
  return caller.content.flatMap((block) =>
    block.type === 'toolCall' &&
    block.name === FORK_TOOL &&
    block.id !== toolCallId &&
    !answered.has(block.id)
      ? [
          {
            role: 'toolResult' as const,
            toolCallId: block.id,
            toolName: FORK_TOOL,
            content: [
              {
                type: 'text' as const,
                text: 'Another fork is running this in parallel; not your task.'
              }
            ],
            isError: false,
            timestamp: last?.timestamp ?? Date.now()
          }
        ]
      : []
  );
}

function brief(handle: string, task: string): string {
  return [
    `[fork ${handle}] You are a fork of the agent above: same context, same tools, same workspace. The parent waits until you finish and will not see your work, only your final message.`,
    'Do the task below. Then end with a final message written as a note for the parent. Its first line is the result itself, specific enough to stand alone ("Tests pass, 3/3, after regenerating src/client"), not an introduction. Then what changed, what you learned (with caveats), what you decided or rejected and why, and what is still open. Quote exact paths, symbols, commands and error strings.',
    'Do not ask the user anything. fold and fork are not available inside a fork.',
    '',
    `Task: ${task}`
  ].join('\n');
}

/**
 * Declares exactly what the parent's transcript declares, so the child's requests carry the
 * same tools block, and runs every call through the parent's tools with their validation,
 * hooks and permission checks.
 */
function childTool(declaration: Tool, ctx: ExtensionToolContext): AgentTool {
  const tool: AgentTool = {
    ...declaration,
    label: declaration.name,
    async execute(_toolCallId, args, signal) {
      if (declaration.name === FOLD_TOOL || declaration.name === FORK_TOOL) {
        return {
          content: [
            {
              type: 'text',
              text: `${declaration.name} is not available inside a fork. Finish the task and end with your note.`
            }
          ],
          details: undefined,
          isError: true
        };
      }
      const outcome = await ctx.executeTool(declaration.name, args, signal ? { signal } : {});
      return outcome.isError ? { ...outcome.result, isError: true } : outcome.result;
    }
  };
  const mode = ctx.tools.find((callable) => callable.name === declaration.name)?.executionMode;
  if (mode) tool.executionMode = mode;
  return tool;
}

const ForkParams = Type.Object({
  task: Type.String({
    description:
      'What the fork should do and when it is done. It already knows everything you know; do not restate context.'
  })
});

export function registerFork(pi: ExtensionAPI, state: EpisodeState, registry: ForkRegistry): void {
  pi.registerTool<typeof ForkParams, ForkDetails | undefined>({
    name: FORK_TOOL,
    label: 'Fork',
    description:
      'Run a copy of yourself on a task that continues your own work, such as making the build pass. The fork starts with your full current context, so there is no prompt to write. It runs to completion and returns its final note; its transcript is archived for recall and ask. Several forks can run in parallel. Not for reviews or second opinions, where independence matters.',
    promptSnippet: 'Run a copy of yourself, with your context, on a self-contained task',
    parameters: ForkParams,
    renderCall: forkRenderers.renderCall,
    renderResult: forkRenderers.renderResult,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const model = ctx.model;
      if (!model) throw new Error('No model selected.');

      // The child has no compaction of its own and starts as large as the parent, so it
      // would overflow within a few turns.
      const percent = ctx.getContextUsage()?.percent;
      if (percent != null && percent > MAX_START_PERCENT) {
        throw new Error(
          `Context is ${Math.round(percent)}% full, too large to fork from. Fold finished episodes first.`
        );
      }

      const projection = ctx.sessionManager.buildSessionProjection();
      const parent = projection.entries.findLast((entry) => {
        const source = entry.sourceEntry;
        return (
          source.type === 'message' &&
          source.message.role === 'assistant' &&
          source.message.content.some(
            (block) => block.type === 'toolCall' && block.id === toolCallId
          )
        );
      });
      if (!parent) throw new Error('The response that called fork is not in the current context.');

      const handle = `fk-${randomUUID().slice(0, 8)}`;
      // The parent's view is the child's prefix, so every child request starts with the
      // parent's cached bytes; only the task and the child's own work are new.
      const prefix = [...projection.messages, ...siblingResults(projection.messages, toolCallId)];
      const task: AgentMessage = {
        role: 'toolResult',
        toolCallId,
        toolName: FORK_TOOL,
        content: [{ type: 'text', text: brief(handle, params.task) }],
        isError: false,
        timestamp: Date.now()
      };

      const options = requestOptions(pi, ctx, prefix, undefined);
      // The agent loop passes its own settings, but not these.
      const limits: Pick<typeof options, 'timeoutMs' | 'maxRetries'> = {};
      if (options.timeoutMs !== undefined) limits.timeoutMs = options.timeoutMs;
      if (options.maxRetries !== undefined) limits.maxRetries = options.maxRetries;
      const agentOptions: ConstructorParameters<typeof Agent>[0] = {
        initialState: {
          model,
          thinkingLevel: ctx.thinkingLevel ?? pi.getThinkingLevel(),
          tools: getCurrentTools(prefix).map((declaration) => childTool(declaration, ctx)),
          messages: [...prefix, task]
        },
        convertToLlm,
        streamFn: (requestModel, context, streamOptions) =>
          ctx.modelRegistry.streamSimple(requestModel, context, { ...streamOptions, ...limits }),
        sessionId: ctx.sessionManager.getSessionId()
      };
      if (options.onPayload) agentOptions.onPayload = options.onPayload;
      if (options.thinkingBudgets) agentOptions.thinkingBudgets = options.thinkingBudgets;
      if (options.maxRetryDelayMs !== undefined)
        agentOptions.maxRetryDelayMs = options.maxRetryDelayMs;
      const agent = new Agent(agentOptions);

      const usage = emptyUsage();
      let turns = 0;
      const live: LiveFork = {
        handle,
        task: params.task,
        status: 'running',
        startedAt: Date.now(),
        turns: 0,
        messages: [task],
        usage,
        activity: undefined
      };
      registry.add(live);
      agent.subscribe((event) => {
        if (event.type === 'message_end') {
          if (event.message.role === 'assistant') {
            turns++;
            live.turns = turns;
            addUsage(usage, event.message.usage);
            live.activity = undefined;
          }
          live.messages = agent.state.messages.slice(prefix.length);
        } else if (event.type === 'tool_execution_start') {
          live.activity = event.toolName;
          onUpdate?.({
            content: [{ type: 'text', text: `${handle}: turn ${turns + 1}, ${event.toolName}` }],
            details: undefined
          });
        } else {
          return;
        }
        registry.changed();
      });

      if (signal?.aborted) throw new Error(`Fork ${handle} was aborted.`);
      const snapshots = state.snapshots;
      const treeBefore = await snapshots?.snapshot();

      // The transcript is written after every turn, so a crash or reload mid-fork keeps
      // what the child did so far.
      const archive: ForkArchive = {
        handle,
        task: params.task,
        parentEntryId: parent.sourceEntry.id,
        messages: []
      };
      const dir = archiveDir(ctx.sessionManager);
      let writing: Promise<unknown> = Promise.resolve();
      const persist = () => {
        archive.messages = agent.state.messages.slice(prefix.length);
        if (!dir) {
          state.forkArchives.set(handle, archive);
          return;
        }
        writing = writing.then(() => writeForkArchive(dir, archive)).catch(() => undefined);
      };
      agent.subscribe((event) => {
        if (event.type === 'turn_end') persist();
      });

      let timedOut = false;
      const timeoutMs = forkTimeout(pi.getSettings()) ?? DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        timedOut = true;
        agent.abort();
      }, timeoutMs);
      const abort = () => agent.abort();
      signal?.addEventListener('abort', abort, { once: true });
      state.runningForks++;
      refreshStatus(ctx, state);
      try {
        await agent.continue();
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        state.runningForks--;
        refreshStatus(ctx, state);
      }

      const messages = agent.state.messages.slice(prefix.length);
      const final = messages.findLast((message) => message.role === 'assistant');
      live.messages = messages;
      live.endedAt = Date.now();
      persist();
      await writing;
      const file = dir ? join(dir, `${handle}.json`) : undefined;

      const aborted = final?.role === 'assistant' && final.stopReason === 'aborted';
      if (aborted && !timedOut) {
        live.status = 'aborted';
        registry.changed();
        throw new Error(`Fork ${handle} was aborted.`);
      }

      const treeAfter = await snapshots?.snapshot();
      let changes: DiskChange[] | undefined;
      if (snapshots && treeBefore && treeAfter) {
        changes = await snapshots.diff(treeBefore, treeAfter);
      }
      const touched = touchedPaths(messages, state.cwd);
      const files = new Set([...touched, ...(changes ?? []).map((change) => change.path)]);

      const failed = (final?.role === 'assistant' && final.stopReason === 'error') || timedOut;
      live.status = failed ? 'failed' : 'done';
      registry.changed();
      const note =
        final?.role === 'assistant'
          ? textOf(final.content.flatMap((block) => (block.type === 'text' ? [block] : []))).trim()
          : '';
      const details: ForkDetails = {
        kind: 'fork',
        handle,
        task: params.task,
        parentEntryId: parent.sourceEntry.id,
        turns,
        headline: headline(note),
        files: [...files],
        usage
      };
      if (file) details.archive = file;
      if (treeAfter) details.treeAfter = treeAfter;

      const status = timedOut
        ? `stopped after ${Math.round(timeoutMs / 60_000)} minutes and ${turns} turns; its work so far is archived`
        : failed
          ? `failed after ${turns} turns: ${(final?.role === 'assistant' && final.errorMessage) || 'unknown error'}`
          : `finished after ${turns} turns`;
      return {
        content: [
          {
            type: 'text',
            text: [
              `[fork ${handle} ${status}]`,
              '',
              note || '(the fork ended without a final message)',
              '',
              ...changeLines(changes, touched, state.cwd),
              '',
              `Full transcript archived as ${handle}: recall searches it, ask("${handle}", "<question>") asks it.`
            ].join('\n')
          }
        ],
        details,
        usage,
        isError: failed
      };
    }
  });
}
