import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Message, ToolCall } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { withStamp } from '../src/stamps.js';

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};

export function user(text: string, stamp?: number): Message {
  return {
    role: 'user',
    content: stamp === undefined ? text : withStamp(text, stamp),
    timestamp: 0
  };
}

export function call(id: string, name: string, args: Record<string, string> = {}): ToolCall {
  return { type: 'toolCall', id, name, arguments: args };
}

export function assistant(...content: (string | ToolCall)[]): AssistantMessage {
  return {
    role: 'assistant',
    content: content.map((part) =>
      typeof part === 'string' ? { type: 'text', text: part } : part
    ),
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'test',
    usage,
    stopReason: content.some((part) => typeof part !== 'string') ? 'toolUse' : 'stop',
    timestamp: 0
  };
}

export function result(
  toolCallId: string,
  toolName: string,
  text: string,
  stamp?: number
): Message {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content:
      stamp === undefined ? [{ type: 'text', text }] : withStamp([{ type: 'text', text }], stamp),
    isError: false,
    timestamp: 0
  };
}

/** A session holding `messages` in order, with the id of each appended entry. */
export function session(messages: readonly AgentMessage[]): {
  manager: SessionManager;
  ids: string[];
} {
  const manager = SessionManager.inMemory('/repo');
  const ids = messages.map((message) => manager.appendMessage(message as Message));
  return { manager, ids };
}
