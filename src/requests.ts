import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ModelsSimpleStreamOptions, Usage } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { anchorBreakpoint, cacheAnchor } from './cache.js';

/**
 * Options for requests made outside pi's agent loop (ask, fork) that should look like the
 * main thread's own requests to the provider: same session id for cache routing, same
 * reasoning settings, same breakpoint placement.
 */
export function requestOptions(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  /** The messages being sent, or a way to read them per request when they keep changing. */
  messages: readonly AgentMessage[] | (() => readonly AgentMessage[]),
  signal: AbortSignal | undefined
): ModelsSimpleStreamOptions {
  const current = typeof messages === 'function' ? messages : () => messages;
  const options: ModelsSimpleStreamOptions = {
    sessionId: ctx.sessionManager.getSessionId(),
    onPayload: (payload) => anchorBreakpoint(payload, cacheAnchor(current()))
  };
  const level = ctx.thinkingLevel ?? pi.getThinkingLevel();
  if (level !== 'off') options.reasoning = level;
  const settings = pi.getSettings();
  if (settings.thinkingBudgets) options.thinkingBudgets = settings.thinkingBudgets;
  // The main thread's provider-level retries and timeouts; pi's own run-level retry and
  // compaction do not exist outside its agent loop.
  const retry = settings.retry?.provider;
  if (retry?.timeoutMs !== undefined) options.timeoutMs = retry.timeoutMs;
  if (retry?.maxRetries !== undefined) options.maxRetries = retry.maxRetries;
  if (retry?.maxRetryDelayMs !== undefined) options.maxRetryDelayMs = retry.maxRetryDelayMs;
  if (signal) options.signal = signal;
  return options;
}

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}

export function addUsage(total: Usage, usage: Usage): void {
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.totalTokens += usage.totalTokens;
  total.cost.input += usage.cost.input;
  total.cost.output += usage.cost.output;
  total.cost.cacheRead += usage.cost.cacheRead;
  total.cost.cacheWrite += usage.cost.cacheWrite;
  total.cost.total += usage.cost.total;
}
