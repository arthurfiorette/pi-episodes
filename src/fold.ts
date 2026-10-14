import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import type {
  ContextEditEntryDraft,
  ExtensionAPI,
  ProjectedSessionEntry
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import {
  appliedFolds,
  FOLD_APPLIED_TYPE,
  FOLD_REQUEST_TYPE,
  FOLD_TOOL,
  type FoldDetails,
  isFoldDetails,
  ThreadIndex
} from './archive.js';
import { anchorGapTokens } from './cache.js';
import { type FoldRejection, recordEvent } from './events.js';
import { estimateTokens, readOnlyPaths, touchedPaths } from './messages.js';
import type { DiskChange } from './snapshots.js';
import { parseStamp, readStamp, stampLabel, unstampedText } from './stamps.js';
import type { EpisodeState } from './state.js';
import { episodeStats, statsLines } from './stats.js';
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
  /** Messages before the span, and those the request that called fold was sent with. */
  before: AgentMessage[];
  sent: AgentMessage[];
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

function isFoldNote(entry: ProjectedSessionEntry, applied: ReadonlySet<string>): boolean {
  const message = entryMessage(entry);
  if (entry.messages.length === 0 || message?.role !== 'toolResult') return false;
  if (message.toolName !== FOLD_TOOL || message.isError) return false;
  // A note whose edits never landed left its span in context; it is not a boundary.
  return isFoldDetails(message.details) && applied.has(message.details.handle);
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

export interface FoldableTurn {
  stamp: number;
  label: string;
}

const PREVIEW_WIDTH = 72;

/**
 * Stamped turns a fold can start from, newest first: those after the latest applied note or
 * compaction summary, with a one-line preview to recognize them by.
 */
export function foldableTurns(entries: readonly ProjectedSessionEntry[]): FoldableTurn[] {
  const applied = appliedFolds(entries.map((entry) => entry.sourceEntry));
  const boundary = entries.findLastIndex(
    (entry) => entry.sourceEntry.type === 'compaction' || isFoldNote(entry, applied)
  );
  const turns: FoldableTurn[] = [];
  for (const entry of entries.slice(boundary + 1)) {
    for (const message of entry.messages) {
      const stamp = readStamp(message);
      if (stamp === undefined || (message.role !== 'user' && message.role !== 'toolResult')) {
        continue;
      }
      const who = message.role === 'user' ? 'you' : message.toolName;
      const line =
        unstampedText(message.content)
          .split('\n')
          .find((text) => text.trim())
          ?.trim() ?? '';
      const preview = line.length > PREVIEW_WIDTH ? `${line.slice(0, PREVIEW_WIDTH - 3)}...` : line;
      turns.push({ stamp, label: `${stampLabel(stamp)}  ${who}: ${preview}` });
    }
  }
  return turns.reverse();
}

export interface FoldOptions {
  /** The newest stamp written in the session, to tell a made-up stamp from one that is gone. */
  latestStamp?: number;
  /** No span may start at or before this index; a fork folds only its own work. */
  floorIndex?: number;
  /** Handles of folds that took effect, when they are not recorded as session entries. */
  applied?: ReadonlySet<string>;
}

/** A fold the tool refused, with why, so rejections can be counted by cause. */
export class FoldError extends Error {
  readonly reason: FoldRejection;

  constructor(reason: FoldRejection, message: string) {
    super(message);
    this.reason = reason;
  }
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
  since: number,
  options: FoldOptions = {}
): FoldPlan {
  const { latestStamp, floorIndex = -1 } = options;
  const foldIndex = entries.findIndex((entry) => callsTool(entry, foldCallId));
  if (foldIndex < 0) {
    throw new FoldError(
      'not-in-context',
      'The response that called fold is not in the current context.'
    );
  }

  const foldResponse = entryMessage(entries[foldIndex]!);
  const firstFold =
    foldResponse?.role === 'assistant'
      ? foldResponse.content.find((block) => block.type === 'toolCall' && block.name === FOLD_TOOL)
      : undefined;
  if (firstFold?.type === 'toolCall' && firstFold.id !== foldCallId) {
    throw new FoldError('one-per-response', 'Only one fold per response; this one was ignored.');
  }

  // Nothing before the latest applied note or the compaction summary can be folded: the
  // note already stands for its span, and the summary for everything it replaced.
  const applied = options.applied ?? appliedFolds(entries.map((entry) => entry.sourceEntry));
  const lastNote = entries.findLastIndex(
    (entry, index) => index < foldIndex && isFoldNote(entry, applied)
  );
  const compaction = entries.findLastIndex(
    (entry, index) => index < foldIndex && entry.sourceEntry.type === 'compaction'
  );
  const boundary = Math.max(lastNote, compaction, floorIndex);
  const earliest = entries
    .slice(boundary + 1, foldIndex)
    .flatMap((entry) => entry.messages.map(readStamp))
    .find((stamp) => stamp !== undefined);
  const pick =
    earliest === undefined
      ? 'Nothing before this call can be folded yet.'
      : `The earliest stamp you can fold from is ${stampLabel(earliest)}.`;

  if (latestStamp !== undefined && since > latestStamp) {
    throw new FoldError(
      'no-such-stamp',
      `${stampLabel(since)} does not exist; the latest stamp is ${stampLabel(latestStamp)}. ${pick}`
    );
  }
  const sinceIndex = entries.findIndex((entry) =>
    entry.messages.some((message) => readStamp(message) === since)
  );
  if (sinceIndex < 0) {
    // A compaction summary can still mention it, but the turn itself is gone.
    throw new FoldError(
      'gone',
      `${stampLabel(since)} is no longer in your context: it was compacted or already folded. ${pick}`
    );
  }
  if (sinceIndex >= foldIndex) {
    throw new FoldError('not-before-call', `${stampLabel(since)} is not before this fold call.`);
  }

  let startIndex = sinceIndex;
  const sinceMessage = entryMessage(entries[sinceIndex]!);
  if (sinceMessage?.role === 'toolResult') {
    const caller = entries.findLastIndex(
      (entry, index) => index < sinceIndex && callsTool(entry, sinceMessage.toolCallId)
    );
    if (caller >= 0) startIndex = caller;
  }

  if (startIndex <= boundary) {
    const [reason, what]: [FoldRejection, string] =
      boundary === lastNote
        ? ['behind-note', 'an earlier fold note']
        : boundary === compaction
          ? ['behind-compaction', 'the compaction summary']
          : ['behind-fork-start', 'the start of this fork; a fork folds only its own work'];
    throw new FoldError(reason, `A fold cannot reach behind ${what}. ${pick}`);
  }

  const span = entries.slice(startIndex, foldIndex);
  if (
    !span.some((entry) => entry.messages.length > 0 && entryMessage(entry)?.role === 'assistant')
  ) {
    throw new FoldError(
      'nothing-to-fold',
      `Nothing to fold from ${stampLabel(since)}: the span holds no responses.`
    );
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
    before: entries.slice(0, startIndex).flatMap((entry) => entry.messages),
    sent: entries.slice(0, foldIndex).flatMap((entry) => entry.messages),
    keptUserTurns,
    edits
  };
}

const SECTION = /^\s*[-*]?\s*\**\s*(changed|learned|decided|rejected|handled|open)\b[^:]*:\**\s*/i;
const NOTHING_OPEN = /^(none|nothing|n\/a|-)\.?$/i;

/**
 * The note's Open section, as the template asks for it: from the line that starts with
 * "Open:" to the next section or blank line. Undefined when there is none or it says none.
 */
export function openItems(note: string): string | undefined {
  const lines = note.split('\n');
  const start = lines.findIndex((line) => SECTION.exec(line)?.[1]?.toLowerCase() === 'open');
  if (start < 0) return undefined;

  const items = [lines[start]!.replace(SECTION, '').trim()];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || SECTION.test(line)) break;
    items.push(line.trim());
  }
  const text = items.filter(Boolean).join(' ').trim();
  return text && !NOTHING_OPEN.test(text) ? text : undefined;
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
  until: string | undefined;
  messages: number;
  tokens: number;
  note: string;
  changes: readonly DiskChange[] | undefined;
  touched: readonly string[];
  keptUserTurns: readonly string[];
  cwd: string;
}): string {
  const lines = [
    `[fold ${options.handle}: ${options.messages} messages, ${options.until ? `${options.since}-${options.until}` : `from ${options.since} on`}, ~${formatTokens(options.tokens)} tokens, archived]`,
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

// Descriptions here cover only how to call the tool; when to fold and the note format live in
// prompt.ts. Read its token budget comment before adding text to either.
const FoldParams = Type.Object({
  since: Type.String({
    description:
      'Stamp of the first message inside the episode, such as "t13". If it is a tool result, the fold starts at the response that made that call.'
  }),
  note: Type.String({
    description:
      'Replaces the span. First line: the question and how it ended. Then changed, learned, decided and rejected, handled, open, as the system prompt describes.'
  })
});

export function registerFold(pi: ExtensionAPI, state: EpisodeState): void {
  pi.registerTool({
    name: FOLD_TOOL,
    label: 'Fold',
    description:
      'Fold a finished episode: remove the span starting at `since` from your context, archive it, and keep `note` in its place. User messages from the span stay. recall and ask still reach the span.',
    promptSnippet: 'Fold a finished episode into a note; the span is archived and stays reachable',
    parameters: FoldParams,
    executionMode: 'sequential',
    renderCall: foldRenderers.renderCall,
    renderResult: foldRenderers.renderResult,

    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      // A /fold request is used up by this call, whether it succeeds or not.
      const manual = state.manualFold;
      state.manualFold = undefined;
      let plan: FoldPlan;
      let since: number | undefined;
      const note = params.note.trim();
      try {
        since = parseStamp(params.since);
        if (since === undefined) {
          throw new FoldError(
            'bad-stamp',
            `since must be a turn stamp such as "t12", got "${params.since}".`
          );
        }
        if (!note) {
          throw new FoldError(
            'empty-note',
            'The note is empty. Write what the rest of the task needs from the span.'
          );
        }
        plan = planFold(ctx.sessionManager.buildSessionProjection().entries, toolCallId, since, {
          latestStamp: state.nextStamp - 1
        });
      } catch (error) {
        if (error instanceof FoldError) {
          recordEvent(pi, { kind: 'fold-rejected', toolCallId, reason: error.reason });
        }
        throw error;
      }
      const sinceLabel = stampLabel(since);
      const lastStamp = plan.spanMessages.map(readStamp).findLast((stamp) => stamp !== undefined);
      const untilLabel =
        lastStamp !== undefined && lastStamp !== since ? stampLabel(lastStamp) : undefined;
      const touched = touchedPaths(plan.spanMessages, state.cwd);
      const files = new Set(touched);

      let changes: DiskChange[] | undefined;
      let treeAfter: string | undefined;
      const snapshots = state.snapshots;
      const anchorPlaced = state.anchorPlaced;
      if (snapshots) {
        treeAfter = await snapshots.snapshot();
        // The span starts from the tree at its last stamp before the first response, such as
        // the user's prompt; the anchor before the span can be from an earlier run, and files
        // the user edited between runs are not the episode's changes.
        let from: string | undefined;
        for (const stamp of [...plan.laterStamps].reverse().concat(plan.anchorStamp ?? [])) {
          from ??= await snapshots.treeAt(stamp);
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
        ...(untilLabel ? { until: untilLabel } : {}),
        firstEntryId: plan.firstEntryId,
        lastEntryId: plan.lastEntryId,
        messages: plan.omitted.length,
        tokens,
        headline: headline(note),
        keptUserTurns: plan.keptUserTurns,
        files: [...files]
      };
      if (treeAfter) details.treeAfter = treeAfter;
      const open = openItems(note);
      if (open) details.open = open;
      const readOnly = readOnlyPaths(
        plan.spanMessages,
        state.cwd,
        (changes ?? []).map((change) => change.path)
      );
      if (readOnly.length > 0) details.readOnly = readOnly;
      details.noteTokens = Math.ceil(note.length / 4);
      if (manual) details.manual = manual;
      const gapTokens = anchorGapTokens(plan.sent, plan.before);
      details.anchor = {
        ...(anchorPlaced === undefined ? {} : { placed: anchorPlaced }),
        ...(gapTokens === undefined ? {} : { gapTokens })
      };

      // A /fold request ends the run here; an autonomous fold continues the task.
      const terminate = manual !== undefined;

      return {
        content: [
          {
            type: 'text',
            text: renderNote({
              handle: plan.handle,
              since: sinceLabel,
              until: untilLabel,
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
    return {
      entries: [
        ...event.entries,
        ...applied.flatMap((fold) => [
          ...fold.edits,
          { type: 'custom' as const, customType: FOLD_APPLIED_TYPE, data: { handle: fold.handle } }
        ])
      ]
    };
  });

  // The status counts records on the branch, so it refreshes once the edits are committed.
  pi.on('turn_end', (_event, ctx) => {
    refreshStatus(ctx, state);
  });

  // The edits from the last turn_end are committed after its handlers run; a fold that ended
  // the run would otherwise not show until the next response.
  pi.on('agent_settled', (_event, ctx) => {
    state.pendingFolds.clear();
    state.manualFold = undefined;
    refreshStatus(ctx, state);
  });

  pi.registerCommand('fold', {
    description: 'Fold now: pick the turn the span starts at, and the agent writes the note',
    handler: async (args, ctx) => {
      let since = args.trim() ? parseStamp(args) : undefined;
      if (args.trim() && since === undefined) {
        ctx.ui.notify('Usage: /fold [tN]', 'error');
        return;
      }

      await ctx.waitForIdle();
      // Picking the start by hand is the post's baseline: the scope is the user's, so there is
      // no false fold. Without a dialog to pick in, the agent picks.
      if (since === undefined && ctx.hasUI) {
        const turns = foldableTurns(ctx.sessionManager.buildSessionProjection().entries);
        if (turns.length === 0) {
          ctx.ui.notify('Nothing can be folded yet: no turns since the last note.', 'info');
          return;
        }
        const choice = await ctx.ui.select(
          'Fold from which turn? The span runs from there to now; the agent writes the note.',
          turns.map((turn) => turn.label)
        );
        if (choice === undefined) return;
        since = turns.find((turn) => turn.label === choice)?.stamp;
        if (since === undefined) return;
      }
      state.manualFold = since === undefined ? 'request' : 'since';
      const target =
        since === undefined ? 'Pick the span that is done' : `Use since "${stampLabel(since)}"`;
      pi.sendMessage(
        {
          customType: FOLD_REQUEST_TYPE,
          display: true,
          content: `The user asked you to fold now. ${target}, write the note, and call only fold in this response.`
        },
        { triggerTurn: true }
      );
    }
  });

  pi.registerMessageRenderer(FOLD_REQUEST_TYPE, (message, _options, theme) => {
    const text = typeof message.content === 'string' ? message.content : '';
    const since = /since "(t\d+)"/.exec(text)?.[1];
    return new Text(
      theme.fg('dim', `episodes: asked the agent to fold${since ? ` from ${since}` : ''}`),
      0,
      0
    );
  });

  pi.registerCommand('episodes', {
    description:
      'List the folded spans and forks archived on this branch; /episodes stats shows the numbers',
    getArgumentCompletions: (prefix) =>
      'stats'.startsWith(prefix.trim())
        ? [{ value: 'stats', label: 'stats', description: 'Measurements for this branch' }]
        : null,
    handler: async (args, ctx) => {
      if (args.trim() === 'stats') {
        const lines = statsLines(episodeStats(ctx.sessionManager.getBranch(), state.cwd));
        ctx.ui.notify(lines.join('\n'), 'info');
        return;
      }
      if (args.trim()) {
        ctx.ui.notify('Usage: /episodes [stats]', 'error');
        return;
      }
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
