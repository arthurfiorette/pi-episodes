import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { isStampBlock } from './stamps.js';

const TRAILING_STAMP = /\s*\[t\d+\]\s*$/;

/** User message Markdown as pi renders it: the text blocks joined, the stamp glued to the end. */
export function hideStamp(markdown: string): string {
  return markdown.replace(TRAILING_STAMP, '');
}

/**
 * Stamps are for the model, which needs them to name `since`. They are hidden from the
 * transcript only; the saved messages and the requests keep them.
 */
export function registerStampDisplay(pi: ExtensionAPI): void {
  pi.registerMarkdownTransformer((markdown, context) =>
    context.messageType === 'user' ? hideStamp(markdown) : markdown
  );

  // Tool results are stamped when saved, after the live render, so the stamp only shows when a
  // session is resumed or replayed. Tools without a renderer of their own use pi's fallback,
  // which cannot be wrapped and still shows it.
  pi.registerToolRenderer((_toolName, next) => {
    const renderers = next();
    const renderResult = renderers?.renderResult;
    if (!renderers || !renderResult) return renderers;
    return {
      ...renderers,
      renderResult: (result, options, theme, context) => {
        const last = result.content.at(-1);
        const content = last && isStampBlock(last) ? result.content.slice(0, -1) : result.content;
        return renderResult({ ...result, content }, options, theme, context);
      }
    };
  });
}
