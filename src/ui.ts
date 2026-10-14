import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ImageContent, TextContent } from '@earendil-works/pi-ai';
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
import { episodeStats, sparkline } from './stats.js';

export interface RecallDetails {
  query: string;
  threads: number;
  shown: number;
  total: number;
  /** Where the matches past the limit were written. */
  file?: string;
  /** Threads with a match among those shown. */
  hits?: string[];
  /** Shown threads whose files changed since they were archived. */
  stale?: StaleThread[];
}

export interface StaleThread {
  handle: string;
  /** Absolute paths. */
  files: string[];
}

export interface AskDetails {
  handle: string;
  question: string;
  stale?: StaleThread[];
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

    const range = details.until ? `${details.since}-${details.until}` : `${details.since} on`;
    const summary =
      `${theme.fg('success', '▸')} ${theme.fg('accent', details.handle)} ${theme.fg('accent', range)} ` +
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
    // Total tokens would count the inherited prefix on every turn and read as millions; the
    // split shows what the fork actually paid for.
    const usage = details.usage;
    const spend = usage
      ? `, in ${formatTokens(usage.input)}, cache r ${formatTokens(usage.cacheRead)} w ${formatTokens(usage.cacheWrite)}, out ${formatTokens(usage.output)}${usage.cost.total > 0 ? `, $${usage.cost.total.toFixed(3)}` : ''}`
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

const STATUS_BARS = 16;

/**
 * Footer status: context per request as a small graph, what is archived on this branch, and
 * whether a fork is running. `pending` is a response that ended but is not saved yet.
 */
export function refreshStatus(
  ctx: ExtensionContext,
  state: EpisodeState,
  pending?: AssistantMessage
): void {
  if (!ctx.hasUI) return;
  const branch = ctx.sessionManager.getBranch();
  const records = threadRecords(branch);
  const folds = records.filter(isFoldDetails);
  const forks = records.filter(isForkDetails);
  const archived = folds.reduce((sum, fold) => sum + fold.tokens, 0);

  const points = episodeStats(branch, state.cwd).requests;
  const usage = pending?.usage;
  const tokens = usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
  if (tokens > 0) points.push({ tokens });

  // Dim like pi's own footer lines. Each piece is colored on its own: a colored bar ends with
  // a reset, which would clear a dim wrapped around the whole line.
  const theme = ctx.ui.theme;
  const dim = (text: string) => theme.fg('dim', text);
  const parts: string[] = [];
  if (points.length > 1) {
    // Drops after a fold are the point of the graph; those after a compaction are pi's.
    parts.push(
      sparkline(points, STATUS_BARS, (bar, point) =>
        point.after === 'fold'
          ? theme.fg('success', bar)
          : point.after === 'compaction'
            ? theme.fg('warning', bar)
            : dim(bar)
      )
    );
  }
  const counts: string[] = [];
  if (folds.length > 0) counts.push(`${folds.length} folded (~${formatTokens(archived)})`);
  if (forks.length > 0) counts.push(`${forks.length} fork(s)`);
  if (state.runningForks > 0) counts.push(`forking (${state.runningForks})`);
  if (counts.length > 0) parts.push(dim(counts.join(', ')));
  ctx.ui.setStatus(
    'episodes',
    parts.length > 0 ? `${dim('episodes')} ${parts.join(dim(' '))}` : undefined
  );
}
