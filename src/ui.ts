import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import {
  type ExtensionContext,
  getMarkdownTheme,
  type Theme
} from '@earendil-works/pi-coding-agent';
import { Container, Markdown, Spacer, Text } from '@earendil-works/pi-tui';
import {
  type FoldDetails,
  type ForkDetails,
  isFoldDetails,
  isForkDetails,
  threadRecords
} from './archive.js';
import { isStampBlock } from './stamps.js';
import type { EpisodeState } from './state.js';

export interface RecallDetails {
  query: string;
  threads: number;
  shown: number;
  total: number;
  /** Where the matches past the limit were written. */
  file?: string;
}

export interface AskDetails {
  handle: string;
  question: string;
}

/** Result text without the trailing turn stamp, which resumed sessions render with. */
function resultText(content: readonly (TextContent | ImageContent)[]): string {
  const last = content.at(-1);
  const blocks = last && isStampBlock(last) ? content.slice(0, -1) : content;
  return blocks
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

function title(theme: Theme, name: string, rest: string): Text {
  return new Text(`${theme.fg('toolTitle', theme.bold(name))} ${rest}`, 0, 0);
}

function markdown(text: string, theme: Theme): Markdown {
  return new Markdown(text, 0, 0, getMarkdownTheme(), {
    color: theme.fg.bind(theme, 'toolOutput')
  });
}

function firstLines(text: string, count: number): string {
  const lines = text.split('\n').filter((line) => line.trim());
  const shown = lines.slice(0, count).join('\n');
  return lines.length > count ? `${shown}\n...` : shown;
}

/**
 * Markdown either way, so ctrl+o changes how much is shown and not how it looks. Collapsed,
 * the first `count` non-empty lines and a dim count of the rest.
 */
function markdownPreview(text: string, expanded: boolean, count: number, theme: Theme): Container {
  const container = new Container();
  const lines = text.split('\n').filter((line) => line.trim());
  if (expanded || lines.length <= count) {
    container.addChild(markdown(text, theme));
    return container;
  }
  container.addChild(markdown(lines.slice(0, count).join('\n'), theme));
  container.addChild(
    new Text(theme.fg('dim', `... ${lines.length - count} more lines, ctrl+o to expand`), 0, 0)
  );
  return container;
}

export const foldRenderers = {
  renderCall(args: { since?: string; note?: string }, theme: Theme): Text {
    const since = args.since ? theme.fg('accent', args.since) : theme.fg('dim', '...');
    return title(theme, 'fold', `${theme.fg('muted', 'from')} ${since}`);
  },

  renderResult(
    result: AgentToolResult<FoldDetails>,
    { expanded }: { expanded: boolean },
    theme: Theme
  ): Text | Container {
    const details = result.details;
    if (!isFoldDetails(details)) {
      return new Text(theme.fg('error', resultText(result.content)), 0, 0);
    }

    const summary =
      `${theme.fg('success', '▸')} ${theme.fg('accent', details.handle)} ` +
      theme.fg(
        'muted',
        `${details.messages} messages, ~${formatTokens(details.tokens)} tokens archived`
      );
    const note = resultText(result.content).split('\n').slice(1).join('\n').trim();
    if (!expanded) {
      return new Text(`${summary}\n${theme.fg('toolOutput', details.headline)}`, 0, 0);
    }

    const container = new Container();
    container.addChild(new Text(summary, 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(markdown(note, theme));
    return container;
  }
};

export const recallRenderers = {
  renderCall(args: { query?: string; handle?: string }, theme: Theme): Text {
    const where = args.handle
      ? ` ${theme.fg('muted', 'in')} ${theme.fg('accent', args.handle)}`
      : '';
    return title(theme, 'recall', `${theme.fg('dim', `"${args.query ?? ''}"`)}${where}`);
  },

  renderResult(
    result: AgentToolResult<RecallDetails | undefined>,
    { expanded }: { expanded: boolean },
    theme: Theme
  ): Text {
    const text = resultText(result.content);
    const details = result.details;
    // Validation failures and thrown errors carry no details.
    if (!details || result.isError) {
      const color = result.isError ? 'error' : 'toolOutput';
      return new Text(theme.fg(color, firstLines(text, expanded ? 100 : 6)), 0, 0);
    }

    if (details.total === 0) {
      return new Text(theme.fg('dim', `no match in ${details.threads} thread(s)`), 0, 0);
    }
    const head =
      theme.fg('success', `${details.total} match(es)`) +
      theme.fg(
        'muted',
        ` in ${details.threads} thread(s)${details.shown < details.total ? `, ${details.shown} shown` : ''}`
      );
    const tail = details.file ? `\n${theme.fg('dim', `rest in ${details.file}`)}` : '';
    return new Text(
      `${head}\n${theme.fg('toolOutput', firstLines(text, expanded ? 200 : 4))}${tail}`,
      0,
      0
    );
  }
};

export const askRenderers = {
  renderCall(args: { handle?: string; question?: string }, theme: Theme): Text {
    return title(
      theme,
      'ask',
      `${theme.fg('accent', args.handle ?? '')} ${theme.fg('dim', `"${args.question ?? ''}"`)}`
    );
  },

  renderResult(
    result: AgentToolResult<AskDetails | undefined>,
    { expanded }: { expanded: boolean },
    theme: Theme
  ): Text | Container {
    const text = resultText(result.content);
    if (result.isError) return new Text(theme.fg('error', firstLines(text, 6)), 0, 0);
    return markdownPreview(text, expanded, 6, theme);
  }
};

export const forkRenderers = {
  renderCall(args: { task?: string }, theme: Theme): Text {
    return title(theme, 'fork', theme.fg('dim', firstLines(args.task ?? '', 2)));
  },

  renderResult(
    result: AgentToolResult<ForkDetails | undefined>,
    { expanded }: { expanded: boolean },
    theme: Theme
  ): Text | Container {
    const details = result.details;
    const text = resultText(result.content);
    if (!isForkDetails(details)) {
      // Progress updates while the fork runs, or an error before it started.
      return new Text(theme.fg(result.isError ? 'error' : 'muted', firstLines(text, 2)), 0, 0);
    }

    const icon = result.isError ? theme.fg('error', '✗') : theme.fg('success', '✓');
    const spend = details.usage
      ? `, ~${formatTokens(details.usage.totalTokens)} tokens${details.usage.cost.total > 0 ? ` $${details.usage.cost.total.toFixed(3)}` : ''}`
      : '';
    const summary = `${icon} ${theme.fg('accent', details.handle)} ${theme.fg('muted', `${details.turns} turns${spend}`)}`;
    const note = text.split('\n').slice(1).join('\n').trim();
    if (!expanded) {
      return new Text(`${summary}\n${theme.fg('toolOutput', details.headline)}`, 0, 0);
    }

    const container = new Container();
    container.addChild(new Text(summary, 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(markdown(note, theme));
    return container;
  }
};

/** Footer status: what is archived on this branch, and whether a fork is running. */
export function refreshStatus(ctx: ExtensionContext, state: EpisodeState): void {
  const records = threadRecords(ctx.sessionManager.getBranch());
  const folds = records.filter(isFoldDetails);
  const forks = records.filter(isForkDetails);
  const archived = folds.reduce((sum, fold) => sum + fold.tokens, 0);

  const parts: string[] = [];
  if (folds.length > 0) parts.push(`${folds.length} folded, ~${formatTokens(archived)} tokens out`);
  if (forks.length > 0) parts.push(`${forks.length} fork(s)`);
  if (state.runningForks > 0) parts.push(`forking (${state.runningForks})`);
  ctx.ui.setStatus('episodes', parts.length > 0 ? `episodes: ${parts.join(', ')}` : undefined);
  ctx.ui.setWorkingMessage(state.runningForks > 0 ? 'Forked, waiting for the child' : undefined);
}
