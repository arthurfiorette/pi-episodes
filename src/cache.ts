import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { FOLD_TOOL } from './archive.js';
import { readStamp, stampLabel } from './stamps.js';

/**
 * Anthropic allows four cache breakpoints per request. Pi uses three with an API key (system
 * prompt, last tool, end of conversation) and four with OAuth, where the required Claude Code
 * identity block gets its own. Each request only reads and refreshes its longest matching
 * entry, so during a long episode the entry where the episode started expires, and the next
 * fold rewrites everything before it. A breakpoint at the latest point a fold can start from
 * keeps that entry alive. Anthropic caches tools, then system, then messages, so the identity
 * breakpoint covers about a dozen tokens beyond the tools breakpoint and is the one to give up.
 */

const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const MAX_BREAKPOINTS = 4;

/** Where the extra breakpoint goes: a fold note's tool result, or a stamped user message. */
export type CacheAnchor = { toolUseId: string } | { stamp: string };

/**
 * The newest fold note or user message. A fold cannot start before the latest note, and
 * episodes usually start after a user message, so whichever is newer is the closest point
 * before the next fold that is already known.
 */
export function cacheAnchor(messages: readonly AgentMessage[]): CacheAnchor | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === 'toolResult' && message.toolName === FOLD_TOOL && !message.isError) {
      return { toolUseId: message.toolCallId };
    }
    const stamp = message.role === 'user' ? readStamp(message) : undefined;
    if (stamp !== undefined) return { stamp: `[${stampLabel(stamp)}]` };
  }
  return undefined;
}

type Block = Record<string, unknown>;

function isBlock(value: unknown): value is Block {
  return typeof value === 'object' && value !== null;
}

function blocksOf(value: unknown): Block[] {
  return Array.isArray(value) ? value.filter(isBlock) : [];
}

interface AnthropicPayload {
  system?: unknown;
  tools?: unknown;
  messages: { role: unknown; content: unknown }[];
}

function isAnthropicPayload(payload: unknown): payload is AnthropicPayload {
  return (
    isBlock(payload) &&
    Array.isArray(payload.messages) &&
    // Anthropic carries the prompt in a top-level `system` array; OpenAI-style payloads do not.
    Array.isArray(payload.system)
  );
}

/** Pi rewrites tool call ids from other providers into this form before sending them. */
function normalizeToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function findTarget(payload: AnthropicPayload, anchor: CacheAnchor): Block | undefined {
  const ids =
    'toolUseId' in anchor
      ? new Set([anchor.toolUseId, normalizeToolCallId(anchor.toolUseId)])
      : new Set<string>();
  let target: Block | undefined;
  for (const message of payload.messages) {
    if (message.role !== 'user') continue;
    for (const block of blocksOf(message.content)) {
      const matches =
        'toolUseId' in anchor
          ? block.type === 'tool_result' && ids.has(String(block.tool_use_id))
          : block.type === 'text' && block.text === anchor.stamp;
      if (matches) target = block;
    }
  }
  return target;
}

/**
 * Puts a cache breakpoint on the anchor. Mutates and returns the payload when it changed
 * anything, `undefined` otherwise.
 */
export function anchorBreakpoint(payload: unknown, anchor: CacheAnchor | undefined): unknown {
  if (!anchor || !isAnthropicPayload(payload)) return undefined;

  const system = blocksOf(payload.system);
  const holders = [
    ...system,
    ...blocksOf(payload.tools),
    ...payload.messages.flatMap((message) => blocksOf(message.content))
  ].filter((block) => block.cache_control !== undefined);

  // Anthropic requires longer TTLs before shorter ones. The anchor sits before the
  // conversation's last breakpoint, so copying that one's marker keeps the order valid.
  const marker = holders.at(-1)?.cache_control;
  if (marker === undefined) return undefined;

  const target = findTarget(payload, anchor);
  if (!target || target.cache_control !== undefined) return undefined;

  if (holders.length >= MAX_BREAKPOINTS) {
    const identity = system[0];
    if (
      system.length < 2 ||
      identity?.text !== CLAUDE_CODE_IDENTITY ||
      identity.cache_control === undefined
    ) {
      return undefined;
    }
    delete identity.cache_control;
  }

  target.cache_control = marker;
  return payload;
}
