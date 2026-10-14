import { relative, resolve } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent
} from '@earendil-works/pi-coding-agent';
import { FOLD_TOOL, threadRecords } from './archive.js';
import { registerAsk } from './ask.js';
import { cacheAnchor, placeAnchor } from './cache.js';
import { registerCompactionNotice } from './compaction.js';
import { registerStampDisplay } from './display.js';
import { recordEvent, recordMeta } from './events.js';
import { registerFold } from './fold.js';
import { registerFork } from './fork.js';
import { ForkRegistry, registerForksView } from './forks-view.js';
import { FILE_TOOLS } from './messages.js';
import { EPISODES_SECTION } from './prompt.js';
import { registerRecall } from './recall.js';
import { registerReminder } from './reminder.js';
import { episodesSettings } from './settings.js';
import { unstampedText, withStamp } from './stamps.js';
import { EpisodeState } from './state.js';
import { formatTokens, refreshStatus } from './ui.js';

const STALE_STAMP = /\s*\[t\d+\]\s*$/;
const MAX_SURFACED_THREADS = 2;

export default function episodes(pi: ExtensionAPI): void {
  const state = new EpisodeState();
  const forks = new ForkRegistry();

  pi.on('session_start', (_event, ctx) => {
    state.reset(ctx);
    recordMeta(pi, ctx);
    refreshStatus(ctx, state);
  });

  pi.on('session_tree', (_event, ctx) => {
    refreshStatus(ctx, state);
  });

  pi.on('session_shutdown', async () => {
    await state.dispose();
  });

  pi.on('before_agent_start', (event) => {
    event.systemPromptOptions.sections.episodes = EPISODES_SECTION;
  });

  // Text copied back from an earlier message (for example by /tree) carries its old stamp
  // inline; the new message gets its own. Only an exact copy is touched, so a user who types
  // a stamp at the end of a question keeps it.
  pi.on('input', (event, ctx) => {
    const text = event.text.replace(STALE_STAMP, '');
    if (text === event.text) return { action: 'continue' };
    const copied = ctx.sessionManager
      .getEntries()
      .some(
        (entry) =>
          entry.type === 'message' &&
          entry.message.role === 'user' &&
          unstampedText(entry.message.content) === text
      );
    if (!copied) return { action: 'continue' };
    return event.images
      ? { action: 'transform', text, images: event.images }
      : { action: 'transform', text };
  });

  // Stamps are written when the message is persisted, never later, so they never change
  // bytes that are already cached.
  pi.on('message_end', (event, ctx) => {
    const message = event.message;
    // The graph moves with each response, not only at the end of a turn.
    if (message.role === 'assistant') refreshStatus(ctx, state, message);
    if (message.role !== 'user' && message.role !== 'toolResult') return undefined;

    const stamp = state.nextStamp++;
    // Results of a tool batch are saved after every call in it finished, so the tree is final
    // for this stamp. Not awaited: tool calls wait for it below.
    state.snapshots?.recordAt(stamp);
    return { message: { ...message, content: withStamp(message.content, stamp) } };
  });

  // The anchor comes from the model's view, not the raw branch: after a compaction the
  // newest stamped user message may only exist in the summary.
  pi.on('before_provider_request', (event, ctx) => {
    const anchor = episodesSettings(pi.getSettings()).cacheAnchor
      ? cacheAnchor(ctx.sessionManager.buildSessionProjection().messages)
      : undefined;
    const placed = placeAnchor(event.payload, anchor);
    state.anchorPlaced = placed.placed;
    return placed.payload;
  });

  // A snapshot still being written must not see the changes of the next tool call.
  pi.on('tool_call', async () => {
    await state.snapshots?.settled();
  });

  // The cue for a folded thread is attached to the tool result that touches one of its
  // files again.
  const fileCue = (event: ToolResultEvent, ctx: ExtensionContext): string[] => {
    if (!FILE_TOOLS.has(event.toolName)) return [];
    const path = event.input.path;
    if (typeof path !== 'string' || !path) return [];

    const absolute = resolve(state.cwd, path);
    const matched = threadRecords(ctx.sessionManager.getBranch()).filter(
      (record) =>
        // Compactions record paths as the tools received them, possibly relative.
        record.files.some((file) => resolve(state.cwd, file) === absolute) &&
        !state.surfaced.has(`${record.handle}:${absolute}`)
    );
    // A cue that points at many threads primes none of them; the newest ones are the likely
    // ones, and the rest stay one recall away.
    const records = matched.slice(-MAX_SURFACED_THREADS);
    if (records.length === 0) return [];

    const shown = relative(state.cwd, absolute);
    recordEvent(pi, {
      kind: 'cue',
      toolCallId: event.toolCallId,
      file: shown,
      threads: records.map((record) => ({
        handle: record.handle,
        readOnly: record.kind !== 'compaction' && (record.readOnly?.includes(absolute) ?? false)
      })),
      matched: matched.length
    });
    return records.map((record) => {
      state.surfaced.add(`${record.handle}:${absolute}`);
      const kind = { fold: 'folded span', fork: 'fork', compaction: 'compacted turns' }[
        record.kind
      ];
      const back =
        record.kind === 'compaction'
          ? `recall("<exact words>", handle "${record.handle}")`
          : `recall, or ask("${record.handle}", "<question>")`;
      return `[episodes] ${shown} was also touched in ${kind} ${record.handle} (${record.headline}). If what happened there matters now: ${back}.`;
    });
  };

  // The prompt's boundary test is abstract and far back; a result this big is the concrete
  // thing to fold, read at the moment the model is about to use it. It names no stamp: the
  // one benchmark fold that was given a start folded reads still needed.
  const heavyResultNudge = (event: ToolResultEvent): string[] => {
    const settings = episodesSettings(pi.getSettings());
    if (!settings.heavyResultNudge || event.toolName === FOLD_TOOL) return [];
    const chars = event.content.reduce(
      (sum, block) => sum + (block.type === 'text' ? block.text.length : 0),
      0
    );
    const tokens = Math.ceil(chars / 4);
    if (tokens < settings.heavyResultTokens) return [];
    recordEvent(pi, { kind: 'nudge', toolCallId: event.toolCallId, tokens });
    return [
      `[episodes] This result is ~${formatTokens(tokens)} tokens. Fold the span it belongs to once you have taken what you need from it.`
    ];
  };

  // Lines for the model are attached to the tool result as it is saved, never edited in
  // later. Both read as "[episodes] ..." so the stats count them as overhead.
  pi.on('tool_result', (event, ctx) => {
    if (event.parentToolCallId) return undefined;
    const lines = [...fileCue(event, ctx), ...heavyResultNudge(event)];
    if (lines.length === 0) return undefined;
    const content = [...event.content, { type: 'text' as const, text: lines.join('\n') }];
    // Replacing content alone would drop structured output for programmatic callers.
    return event.structuredContent === undefined
      ? { content }
      : { content, structuredContent: event.structuredContent };
  });

  registerFold(pi, state);
  registerRecall(pi, state);
  registerAsk(pi, state);
  registerFork(pi, state, forks);
  registerForksView(pi, forks);
  registerReminder(pi);
  registerStampDisplay(pi);
  registerCompactionNotice(pi);
}
