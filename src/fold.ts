import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import type {
  ContextEditEntryDraft,
  ExtensionAPI,
  ProjectedSessionEntry
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { FOLD_TOOL, type FoldDetails, ThreadIndex } from './archive.js';
import { estimateTokens, touchedPaths } from './messages.js';
import type { DiskChange } from './snapshots.js';
import { parseStamp, readStamp, stampLabel } from './stamps.js';
import type { EpisodeState } from './state.js';
import { foldRenderers, formatTokens, refreshStatus } from './ui.js';

/** User text above this size is kept as a head plus a pointer into the archive. */
export const USER_TEXT_CAP = 4000;
const MAX_LISTED_CHANGES = 40;

export interface FoldPlan {
  handle: string;
  /** Stamp of the last message that stays before the span, if any. */
  anchorStamp: number | undefined;
  /** Stamps inside the span before its first response, in order. */
  laterStamps: number[];
  firstEntryId: string;
  lastEntryId: string;
  /** Messages leaving the context. */
  omitted: AgentMessage[];
  /** Everything the span held, for file tracking. */
  spanMessages: AgentMessage[];
  keptUserTurns: string[];
  edits: ContextEditEntryDraft[];
}

function entryMessage(entry: ProjectedSessionEntry): AgentMessage | undefined {
  return entry.sourceEntry.type === 'message' ? entry.sourceEntry.message : undefined;
}

function callsTool(entry: ProjectedSessionEntry, toolCallId: string): boolean {
  const message = entryMessage(entry);
  return (
    message?.role === 'assistant' &&
    message.content.some((block) => block.type === 'toolCall' && block.id === toolCallId)
  );
}

function isFoldNote(entry: ProjectedSessionEntry): boolean {
  const message = entryMessage(entry);
  return (
    entry.messages.length > 0 &&
    message?.role === 'toolResult' &&
    message.toolName === FOLD_TOOL &&
    !message.isError
  );
}

function capUserContent(
  content: string | (TextContent | ImageContent)[],
  handle: string
): (TextContent | ImageContent)[] | undefined {
  const blocks: (TextContent | ImageContent)[] =
    typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  const total = blocks.reduce(
    (sum, block) => sum + (block.type === 'text' ? block.text.length : 0),
    0
  );
  if (total <= USER_TEXT_CAP) return undefined;

  let budget = USER_TEXT_CAP;
  return blocks.map((block, index) => {
    // The trailing stamp block must survive untouched so the turn stays addressable.
    if (block.type !== 'text' || index === blocks.length - 1) return block;
    if (block.text.length <= budget) {
      budget -= block.text.length;
      return block;
    }
    const head = block.text.slice(0, budget);
    const cut = block.text.length - budget;
    budget = 0;
    return {
      type: 'text',
      text: `${head}\n[${cut} more characters of this message are in ${handle}; recall can search them]`
    };
  });
}

/**
 * Works out which entries a fold removes. `since` names the first stamped message inside
 * the episode; when that is a tool result, the span starts at the response that made the
 * call, so the episode is folded from its turn boundary and no call loses its result. The
 * span ends before the response that called fold: that response and the fold result stay,
 * so the context still ends on a tool result.
 */
export function planFold(
  entries: readonly ProjectedSessionEntry[],
  foldCallId: string,
  since: number
): FoldPlan {
  const foldIndex = entries.findIndex((entry) => callsTool(entry, foldCallId));
  if (foldIndex < 0) {
    throw new Error('The response that called fold is not in the current context.');
  }

  const foldResponse = entryMessage(entries[foldIndex]!);
  const firstFold =
    foldResponse?.role === 'assistant'
      ? foldResponse.content.find((block) => block.type === 'toolCall' && block.name === FOLD_TOOL)
      : undefined;
  if (firstFold?.type === 'toolCall' && firstFold.id !== foldCallId) {
    throw new Error('Only one fold per response; this one was ignored.');
  }

  const sinceIndex = entries.findIndex((entry) =>
    entry.messages.some((message) => readStamp(message) === since)
  );
  if (sinceIndex < 0) {
    throw new Error(
      `${stampLabel(since)} is not in the current context. It may already be folded or compacted.`
    );
  }
  if (sinceIndex >= foldIndex) {
    throw new Error(`${stampLabel(since)} is not before this fold call.`);
  }

  let startIndex = sinceIndex;
  const sinceMessage = entryMessage(entries[sinceIndex]!);
  if (sinceMessage?.role === 'toolResult') {
    const caller = entries.findLastIndex(
      (entry, index) => index < sinceIndex && callsTool(entry, sinceMessage.toolCallId)
    );
    if (caller >= 0) startIndex = caller;
  }

  const lastNote = entries.findLastIndex((entry, index) => index < foldIndex && isFoldNote(entry));
  if (startIndex <= lastNote) {
    throw new Error(
      'A fold cannot reach behind an earlier fold note. Pick a stamp after the last note.'
    );
  }

  const span = entries.slice(startIndex, foldIndex);
  if (
    !span.some((entry) => entry.messages.length > 0 && entryMessage(entry)?.role === 'assistant')
  ) {
    throw new Error(`Nothing to fold from ${stampLabel(since)}: the span holds no responses.`);
  }

  const first = span[0]!;
  const last = span.at(-1)!;
  // Derived from the call, not the span, so folding the same span again on another branch
  // gets its own handle.
  const handle = `ep-${createHash('sha256').update(foldCallId).digest('hex').slice(0, 8)}`;
  const edits: ContextEditEntryDraft[] = [];
  const omitted: AgentMessage[] = [];
  const keptUserTurns: string[] = [];
  const laterStamps: number[] = [];
  let reachedResponse = false;

  for (const entry of span) {
    if (entry.messages.length === 0) continue;
    const source = entry.sourceEntry;
    const message = entryMessage(entry);
    const projected = entry.messages[0]!;
    if (message?.role === 'assistant') reachedResponse = true;
    if (!reachedResponse) {
      const stamp = readStamp(projected);
      if (stamp !== undefined) laterStamps.push(stamp);
    }

    if (message?.role === 'user' && projected.role === 'user') {
      const stamp = readStamp(projected);
      if (stamp !== undefined) keptUserTurns.push(stampLabel(stamp));
      const capped = capUserContent(projected.content, handle);
      if (capped)
        edits.push({ type: 'context_edit', targetId: source.id, replacement: { content: capped } });
      continue;
    }

    if (
      source.type === 'custom_message' ||
      message?.role === 'assistant' ||
      message?.role === 'toolResult'
    ) {
      edits.push({ type: 'context_edit', targetId: source.id, replacement: null });
      omitted.push(...entry.messages);
    }
    // System messages, compaction checkpoints and `!` commands are not editable and stay.
  }

  let anchorStamp: number | undefined;
  for (let index = startIndex - 1; index >= 0 && anchorStamp === undefined; index--) {
    anchorStamp = entries[index]!.messages.map(readStamp).findLast((stamp) => stamp !== undefined);
  }

  return {
    handle,
    anchorStamp,
    laterStamps,
    firstEntryId: first.sourceEntry.id,
    lastEntryId: last.sourceEntry.id,
    omitted,
    spanMessages: span.flatMap((entry) => entry.messages),
    keptUserTurns,
    edits
  };
}

export function headline(note: string): string {
  const line = note.split('\n').find((text) => text.trim()) ?? '';
  const clean = line.replace(/^[\s#*-]+/, '').trim();
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
}

/** What changed on disk, from the working tree diff, or the touched files when there is none. */
export function changeLines(
  changes: readonly DiskChange[] | undefined,
  touched: readonly string[],
  cwd: string
): string[] {
  if (!changes) {
    return touched.length === 0
      ? []
      : [
          'Files used by file tools (no working tree diff is available, so shell side effects are not listed):',
          ...touched.map((path) => relative(cwd, path))
        ];
  }
  if (changes.length === 0) return ['Working tree unchanged.'];

  const lines = ['Changed on disk (working tree diff):'];
  for (const change of changes.slice(0, MAX_LISTED_CHANGES)) {
    lines.push(`${change.status} ${relative(cwd, change.path)}`);
  }
  if (changes.length > MAX_LISTED_CHANGES) {
    lines.push(`... and ${changes.length - MAX_LISTED_CHANGES} more`);
  }
  return lines;
}

export function renderNote(options: {
  handle: string;
  since: string;
  messages: number;
  tokens: number;
  note: string;
  changes: readonly DiskChange[] | undefined;
  touched: readonly string[];
  keptUserTurns: readonly string[];
  cwd: string;
}): string {
  const lines = [
    `[fold ${options.handle}: ${options.messages} messages from ${options.since} on, ~${formatTokens(options.tokens)} tokens, archived]`,
    '',
    options.note.trim(),
    '',
    ...changeLines(options.changes, options.touched, options.cwd)
  ];

  if (options.keptUserTurns.length > 0) {
    lines.push(
      '',
      `User messages from inside the span stay above with their stamps: ${options.keptUserTurns.join(', ')}.`
    );
  }

  lines.push(
    '',
    `To go back: recall("<exact words>") searches this span; ask("${options.handle}", "<question>") asks it.`
  );
  return lines.join('\n');
}

const FoldParams = Type.Object({
  since: Type.String({
    description:
      'Stamp of the first message inside the episode, such as "t13", usually the result of its first tool call. The fold starts at the response that made that call and runs up to this call.'
  }),
  note: Type.String({
    description:
      'Replaces the span. Changed (files, config, external state); learned, with caveats; decided and rejected, with why; still open. Quote exact paths, symbols, commands and error strings.'
  })
});

export function registerFold(pi: ExtensionAPI, state: EpisodeState): void {
  pi.registerTool({
    name: FOLD_TOOL,
    label: 'Fold',
    description:
      'Fold a finished episode: remove the span starting at `since` from your context, archive it, and keep `note` in its place. User messages from the span stay. Call it alone, once the next step no longer depends on the span beyond the note.',
    promptSnippet: 'Fold a finished episode into a note; the span is archived and stays reachable',
    parameters: FoldParams,
    executionMode: 'sequential',
    renderCall: foldRenderers.renderCall,
    renderResult: foldRenderers.renderResult,

    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const since = parseStamp(params.since);
      if (since === undefined) {
        throw new Error(`since must be a turn stamp such as "t12", got "${params.since}".`);
      }
      const note = params.note.trim();
      if (!note) {
        throw new Error('The note is empty. Write what the rest of the task needs from the span.');
      }

      const plan = planFold(ctx.sessionManager.buildSessionProjection().entries, toolCallId, since);
      const sinceLabel = stampLabel(since);
      const touched = touchedPaths(plan.spanMessages, state.cwd);
      const files = new Set(touched);

      let changes: DiskChange[] | undefined;
      let treeAfter: string | undefined;
      const snapshots = state.snapshots;
      if (snapshots) {
        treeAfter = await snapshots.snapshot();
        // The tree recorded before the span's first request is the state the span started from.
        let from: string | undefined;
        for (const stamp of [plan.anchorStamp, ...plan.laterStamps]) {
          if (stamp !== undefined) from ??= await snapshots.treeAt(stamp);
        }
        if (from && treeAfter) {
          changes = await snapshots.diff(from, treeAfter);
          for (const change of changes ?? []) files.add(change.path);
        }
      }

      const tokens = estimateTokens(plan.omitted);
      state.pendingFolds.set(toolCallId, {
        handle: plan.handle,
        messages: plan.omitted.length,
        tokens,
        edits: plan.edits
      });

      const details: FoldDetails = {
        kind: 'fold',
        handle: plan.handle,
        since: sinceLabel,
        firstEntryId: plan.firstEntryId,
        lastEntryId: plan.lastEntryId,
        messages: plan.omitted.length,
        tokens,
        headline: headline(note),
        keptUserTurns: plan.keptUserTurns,
        files: [...files]
      };
      if (treeAfter) details.treeAfter = treeAfter;

      // A /fold request ends the run here; an autonomous fold continues the task.
      const terminate = state.manualFold;
      state.manualFold = false;

      return {
        content: [
          {
            type: 'text',
            text: renderNote({
              handle: plan.handle,
              since: sinceLabel,
              messages: plan.omitted.length,
              tokens,
              note,
              changes,
              touched,
              keptUserTurns: plan.keptUserTurns,
              cwd: state.cwd
            })
          }
        ],
        details,
        terminate
      };
    }
  });

  // Context edits can only be appended at a turn boundary; by then the fold result exists,
  // so the call and its note stay paired and the next request already sees the fold.
  pi.on('turn_end', (event, ctx) => {
    const applied = event.toolResults
      .filter((result) => result.toolName === FOLD_TOOL && !result.isError)
      .flatMap((result) => {
        const pending = state.pendingFolds.get(result.toolCallId);
        state.pendingFolds.delete(result.toolCallId);
        return pending ? [pending] : [];
      });
    if (applied.length === 0) return undefined;

    for (const fold of applied) {
      ctx.ui.notify(
        `Folded ${fold.messages} messages (~${formatTokens(fold.tokens)} tokens) into ${fold.handle}`,
        'info'
      );
    }
    return { entries: [...event.entries, ...applied.flatMap((fold) => fold.edits)] };
  });

  // The status counts records on the branch, so it refreshes once the edits are committed.
  pi.on('turn_end', (_event, ctx) => {
    refreshStatus(ctx, state);
  });

  pi.on('agent_settled', () => {
    state.pendingFolds.clear();
    state.manualFold = false;
  });

  pi.registerCommand('fold', {
    description: 'Ask the agent to fold the finished episode now. Optional: /fold t12',
    handler: async (args, ctx) => {
      const since = args.trim() ? parseStamp(args) : undefined;
      if (args.trim() && since === undefined) {
        ctx.ui.notify('Usage: /fold [tN]', 'error');
        return;
      }

      await ctx.waitForIdle();
      state.manualFold = true;
      const target =
        since === undefined ? 'Pick the span that is done' : `Use since "${stampLabel(since)}"`;
      pi.sendMessage(
        {
          customType: 'episodes-fold-request',
          display: true,
          content: `The user asked you to fold now. ${target}, write the note, and call only fold in this response.`
        },
        { triggerTurn: true }
      );
    }
  });

  pi.registerCommand('episodes', {
    description: 'List the folded spans and forks archived on this branch',
    handler: async (_args, ctx) => {
      const threads = await new ThreadIndex(ctx.sessionManager, state.forkArchives).onBranch();
      if (threads.length === 0) {
        ctx.ui.notify('Nothing archived on this branch yet.', 'info');
        return;
      }
      const lines = threads.map((thread) => {
        const size =
          thread.record.kind === 'fold'
            ? `${thread.record.messages} messages, ~${formatTokens(thread.record.tokens)} tokens`
            : `${thread.messages.length} messages`;
        return `${thread.handle}  ${thread.label} (${size})  ${thread.record.headline}`;
      });
      ctx.ui.notify(lines.join('\n'), 'info');
    }
  });
}
