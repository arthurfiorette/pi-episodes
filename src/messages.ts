import { resolve } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';

export const FILE_TOOLS = new Set(['read', 'edit', 'write']);

function blocksText(content: string | readonly (TextContent | ImageContent)[]): string {
  if (typeof content === 'string') {
    return content;
  }

  return content.map((block) => (block.type === 'text' ? block.text : '[image]')).join('\n');
}

/**
 * Everything a message holds as searchable text: tool calls with their arguments, tool
 * outputs and, where the provider returned it, reasoning.
 */
export function messageText(message: AgentMessage): string {
  switch (message.role) {
    case 'user':
    case 'toolResult':
    case 'custom':
      return blocksText(message.content);
    case 'assistant':
      return message.content
        .map((block) => {
          if (block.type === 'text') return block.text;
          if (block.type === 'thinking')
            return block.redacted ? '' : `(thinking) ${block.thinking}`;
          return `${block.name}(${JSON.stringify(block.arguments)})`;
        })
        .filter(Boolean)
        .join('\n');
    case 'bashExecution':
      return `$ ${message.command}\n${message.output}`;
    case 'branchSummary':
    case 'compactionSummary':
      return message.summary;
    default:
      return '';
  }
}

/** Rough token count, only used to tell the user and the model how much a fold saved. */
export function estimateTokens(messages: readonly AgentMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += messageText(message).length;
  }
  return Math.ceil(chars / 4);
}

/** Absolute paths that file tools read or wrote in these messages. */
export function touchedPaths(messages: readonly AgentMessage[], cwd: string): string[] {
  const paths = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type !== 'toolCall' || !FILE_TOOLS.has(block.name)) continue;
      const path = block.arguments.path;
      if (typeof path === 'string' && path) paths.add(resolve(cwd, path));
    }
  }
  return [...paths];
}

export function textOf(content: readonly (TextContent | ImageContent)[]): string {
  return content
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
