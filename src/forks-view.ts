import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Usage } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import {
  Key,
  matchesKey,
  ScrollView,
  Text,
  type TUI,
  truncateToWidth,
  visibleWidth
} from '@earendil-works/pi-tui';
import { messageText } from './messages.js';
import { formatTokens } from './ui.js';

export type ForkStatus = 'running' | 'done' | 'failed' | 'aborted';

/** One fork as the view sees it: the child's own messages, updated while it runs. */
export interface LiveFork {
  handle: string;
  task: string;
  status: ForkStatus;
  startedAt: number;
  endedAt?: number;
  turns: number;
  messages: AgentMessage[];
  usage: Usage;
  /** What the child is doing right now, for the widget. */
  activity: string | undefined;
}

const REFRESH_MS = 500;
const RESULT_PREVIEW_LINES = 12;

export class ForkRegistry {
  readonly forks = new Map<string, LiveFork>();
  private readonly listeners = new Set<() => void>();

  get running(): LiveFork[] {
    return [...this.forks.values()].filter((fork) => fork.status === 'running');
  }

  add(fork: LiveFork): void {
    this.forks.set(fork.handle, fork);
    this.changed();
  }

  changed(): void {
    for (const listener of this.listeners) listener();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Forget the forks and the listeners of a session that ended. */
  clear(): void {
    this.forks.clear();
    this.listeners.clear();
  }
}

function elapsed(fork: LiveFork): string {
  const seconds = Math.round(((fork.endedAt ?? Date.now()) - fork.startedAt) / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`;
}

function statusIcon(theme: Theme, status: ForkStatus): string {
  switch (status) {
    case 'running':
      return theme.fg('warning', '●');
    case 'done':
      return theme.fg('success', '✓');
    case 'failed':
      return theme.fg('error', '✗');
    case 'aborted':
      return theme.fg('muted', '○');
  }
}

/** The lines shown above the editor while forks run. */
export function widgetLines(registry: ForkRegistry, theme: Theme): string[] | undefined {
  const running = registry.running;
  if (running.length === 0) return undefined;
  return [
    ...running.map(
      (fork) =>
        `${statusIcon(theme, 'running')} ${theme.fg('accent', fork.handle)} ${theme.fg('muted', `turn ${fork.turns + 1}, ${elapsed(fork)}`)} ${theme.fg('dim', fork.activity ?? 'thinking')}`
    ),
    theme.fg('dim', 'ctrl+shift+e or /forks to watch')
  ];
}

function transcriptLines(fork: LiveFork, theme: Theme, width: number): string[] {
  const lines: string[] = [];
  const push = (text: string) => {
    for (const line of text.split('\n')) lines.push(truncateToWidth(line, width));
  };

  push(`${theme.fg('muted', 'task:')} ${fork.task}`);
  lines.push('');
  for (const message of fork.messages) {
    // The first message is the brief with the task; it is already shown above.
    if (message === fork.messages[0]) continue;
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'text' && block.text.trim()) {
          push(theme.fg('text', block.text.trim()));
        } else if (block.type === 'toolCall') {
          const args = JSON.stringify(block.arguments);
          push(
            `${theme.fg('toolTitle', theme.bold(block.name))} ${theme.fg('dim', args.length > 160 ? `${args.slice(0, 157)}...` : args)}`
          );
        }
      }
      if (message.stopReason === 'error') push(theme.fg('error', message.errorMessage ?? 'error'));
    } else if (message.role === 'toolResult') {
      const text = messageText(message).replace(/\n?\[t\d+\]$/, '');
      const shown = text.split('\n').slice(0, RESULT_PREVIEW_LINES);
      const rest = text.split('\n').length - shown.length;
      push(theme.fg(message.isError ? 'error' : 'toolOutput', shown.join('\n')));
      if (rest > 0) push(theme.fg('dim', `... ${rest} more lines`));
    }
    lines.push('');
  }
  if (fork.status === 'running') push(theme.fg('warning', '● running'));
  return lines;
}

class ForkOverlay {
  private readonly registry: ForkRegistry;
  private readonly theme: Theme;
  private readonly tui: TUI;
  private readonly done: () => void;
  private readonly body = new Text('', 1, 0);
  private readonly scroll: ScrollView;
  private selected = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: () => void;

  constructor(registry: ForkRegistry, theme: Theme, tui: TUI, done: () => void) {
    this.registry = registry;
    this.theme = theme;
    this.tui = tui;
    this.done = done;
    this.scroll = new ScrollView(this.body, { follow: 'end', scrollbar: 'auto' });
    this.selected = Math.max(0, this.order().length - 1);
    this.unsubscribe = registry.onChange(() => this.tui.requestRender());
    // Elapsed time moves even when nothing else changes.
    this.timer = setInterval(() => {
      if (this.registry.running.length > 0) this.tui.requestRender();
    }, REFRESH_MS);
  }

  /** Oldest first, like the transcript; the newest is selected when the overlay opens. */
  private order(): LiveFork[] {
    return [...this.registry.forks.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  handleInput(data: string): void {
    const forks = this.order();
    if (
      matchesKey(data, 'escape') ||
      matchesKey(data, 'q') ||
      matchesKey(data, Key.ctrlShift('e'))
    ) {
      this.close();
    } else if (matchesKey(data, 'left') || matchesKey(data, 'tab') || matchesKey(data, 'right')) {
      if (forks.length > 0) {
        const step = matchesKey(data, 'left') ? -1 : 1;
        this.selected = (this.selected + step + forks.length) % forks.length;
        this.scroll.scrollToEnd();
      }
    } else if (matchesKey(data, 'up')) {
      this.scroll.scrollBy(-1);
    } else if (matchesKey(data, 'down')) {
      this.scroll.scrollBy(1);
    } else if (matchesKey(data, 'pageUp')) {
      this.scroll.scrollBy(-20);
    } else if (matchesKey(data, 'pageDown')) {
      this.scroll.scrollBy(20);
    } else if (matchesKey(data, 'home')) {
      this.scroll.scrollToStart();
    } else if (matchesKey(data, 'end')) {
      this.scroll.scrollToEnd();
    }
    this.tui.requestRender();
  }

  private close(): void {
    this.done();
  }

  invalidate(): void {
    this.body.invalidate();
    this.scroll.invalidate();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe();
  }

  render(width: number): string[] {
    const theme = this.theme;
    const inner = Math.max(20, width - 2);
    const row = (content: string) => {
      const text = truncateToWidth(content, inner);
      return `${theme.fg('border', '│')}${text}${' '.repeat(Math.max(0, inner - visibleWidth(text)))}${theme.fg('border', '│')}`;
    };

    const forks = this.order();
    const lines: string[] = [theme.fg('border', `╭${'─'.repeat(inner)}╮`)];
    if (forks.length === 0) {
      lines.push(row(` ${theme.fg('muted', 'No forks in this session yet.')}`));
    } else {
      const tabs = forks
        .map((fork, index) => {
          const label = `${statusIcon(theme, fork.status)} ${fork.handle}`;
          return index === this.selected
            ? theme.fg('accent', theme.bold(label))
            : theme.fg('muted', label);
        })
        .join('  ');
      lines.push(row(` ${tabs}`));

      const fork = forks[Math.min(this.selected, forks.length - 1)]!;
      const summary = `${fork.status}, ${fork.turns} turns, ${elapsed(fork)}, ~${formatTokens(fork.usage.totalTokens)} tokens`;
      lines.push(row(` ${theme.fg('dim', summary)}`));
      lines.push(theme.fg('border', `├${'─'.repeat(inner)}┤`));

      this.body.setText(transcriptLines(fork, theme, inner - 2).join('\n'));
      for (const line of this.scroll.render(inner)) lines.push(row(line));
    }
    lines.push(theme.fg('border', `├${'─'.repeat(inner)}┤`));
    lines.push(
      row(` ${theme.fg('dim', 'tab/←/→ switch fork   ↑/↓ pgup/pgdn scroll   esc close')}`)
    );
    lines.push(theme.fg('border', `╰${'─'.repeat(inner)}╯`));
    return lines;
  }
}

export function registerForksView(pi: ExtensionAPI, registry: ForkRegistry): void {
  let open = false;

  const show = async (ctx: ExtensionContext) => {
    if (open || ctx.mode !== 'tui') return;
    open = true;
    try {
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => new ForkOverlay(registry, theme, tui, () => done()),
        { overlay: true, overlayOptions: { width: '90%', maxHeight: '85%', anchor: 'center' } }
      );
    } finally {
      open = false;
    }
  };

  pi.registerShortcut(Key.ctrlShift('e'), {
    description: 'Watch running and finished forks',
    handler: show
  });

  pi.registerCommand('forks', {
    description: 'Watch running and finished forks',
    handler: async (_args, ctx) => show(ctx)
  });

  // The widget is only worth its space while something runs; it disappears afterwards and
  // the fork's result stays in the transcript.
  pi.on('session_start', (_event, ctx) => {
    registry.clear();
    // Only the TUI has a theme and a place for the widget.
    if (ctx.mode !== 'tui') return;
    let ticker: ReturnType<typeof setInterval> | undefined;
    registry.onChange(() => {
      ctx.ui.setWidget('episodes-forks', widgetLines(registry, ctx.ui.theme));
      // The elapsed time in the widget moves even when the child is quiet.
      const running = registry.running.length > 0;
      if (running && !ticker) ticker = setInterval(() => registry.changed(), REFRESH_MS);
      if (!running && ticker) {
        clearInterval(ticker);
        ticker = undefined;
      }
    });
  });
}
