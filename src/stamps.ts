import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';

// A stamp is its own trailing text block so it can be found again without parsing the
// message text, and so the original text stays byte-identical.
const STAMP_BLOCK = /^\[t(\d+)\]$/;
const STAMP_ARG = /^\[?t?(\d+)\]?$/i;

export function stampLabel(stamp: number): string {
  return `t${stamp}`;
}

function stampBlock(stamp: number): TextContent {
  return { type: 'text', text: `[t${stamp}]` };
}

export function isStampBlock(block: TextContent | ImageContent): boolean {
  return block.type === 'text' && STAMP_BLOCK.test(block.text);
}

/** The stamp carried by a user or tool-result message, if it has one. */
export function readStamp(message: AgentMessage): number | undefined {
  if (message.role !== 'user' && message.role !== 'toolResult') {
    return undefined;
  }

  if (!Array.isArray(message.content)) {
    return undefined;
  }

  const last = message.content.at(-1);
  if (last?.type !== 'text') {
    return undefined;
  }

  const match = STAMP_BLOCK.exec(last.text);
  return match ? Number(match[1]) : undefined;
}

/** Parses what the model passes as `since`: `t12`, `[t12]` or `12`. */
export function parseStamp(value: string): number | undefined {
  const match = STAMP_ARG.exec(value.trim());
  return match ? Number(match[1]) : undefined;
}

/**
 * Appends the stamp, or replaces one that is already there: content copied from an older
 * message (another extension, an RPC client) would otherwise carry its stamp, and two
 * messages sharing a stamp would make `since` ambiguous.
 */
export function withStamp(
  content: string | (TextContent | ImageContent)[],
  stamp: number
): (TextContent | ImageContent)[] {
  const blocks: (TextContent | ImageContent)[] =
    typeof content === 'string' ? [{ type: 'text', text: content }] : [...content];
  const last = blocks.at(-1);
  if (last && isStampBlock(last)) blocks.pop();
  blocks.push(stampBlock(stamp));
  return blocks;
}

/** The text of a message's content without its stamp block, joined as pi joins it. */
export function unstampedText(content: string | readonly (TextContent | ImageContent)[]): string {
  if (typeof content === 'string') return content;
  const last = content.at(-1);
  const blocks = last && isStampBlock(last) ? content.slice(0, -1) : content;
  return blocks
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('');
}
