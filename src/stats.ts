import { resolve } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import {
  appliedFolds,
  FOLD_APPLIED_TYPE,
  FOLD_TOOL,
  FORK_TOOL,
  isFoldDetails,
  isForkDetails
} from './archive.js';
import { COMPACTION_NOTICE_TYPE } from './compaction.js';
import { type EpisodeEvent, EVENT_TYPE } from './events.js';
import { EPISODES_SECTION } from './prompt.js';
import { REMINDER_TYPE } from './reminder.js';
import { isStampBlock, parseStamp, readStamp } from './stamps.js';
import type { AskDetails, RecallDetails, StaleThread } from './ui.js';

/** The prompt's threshold: folding less than this saves less than the note and cache write cost. */
const SMALL_SPAN_TOKENS = 2000;
/** Responses after a cue or staleness line in which acting on it still counts as following it. */
const FOLLOW_WINDOW = 3;

export interface RequestPoint {
  /** Tokens the request was sent with: input plus cache read and write. */
  tokens: number;
  /** The first request after a fold or a compaction, where the context should drop. */
  after?: 'fold' | 'compaction';
}

export interface EpisodeStats {
  /** Main-thread requests on the branch, oldest first. */
  requests: RequestPoint[];
  folds: {
    count: number;
    /** By /fold, with the user picking the span start, or the agent picking it. */
    pickedByUser: number;
    requestedByUser: number;
    /** Estimated tokens the folds took out of context. */
    tokens: number;
    spanTokens: number[];
    small: number;
    noteTokens: number;
    /** Folds sharing their response with other tool calls, which the prompt asks against. */
    notAlone: number;
    /** Folds followed directly by the final reply, which the prompt asks against. */
    beforeFinal: number;
    /** Estimated tokens not sent: each fold's span minus its note, on every later request. */
    saved: number;
    rejected: number;
    /** Rejections whose next fold call succeeded. */
    retriedOk: number;
    /**
     * Input not read from cache (uncached input plus cache write) on the first request after
     * each fold: what the fold cost in re-sent prefix. Providers that do not report cache
     * writes bill the whole miss as input, so the sum compares across providers.
     */
    uncachedAfter: number[];
    /** Folds whose request reported on the anchor, and those where it was placed. */
    anchorKnown: number;
    anchored: number;
    /** Only where the provider takes breakpoints; elsewhere there is no anchor to measure. */
    gapTokens: number[];
  };
  recall: { count: number; empty: number; compacted: number };
  ask: { count: number };
  stale: { shown: number; reread: number };
  cues: { shown: number; followed: number; readOnly: number; capped: number };
  /** Heavy-result nudges, and those followed by a fold covering that result. */
  nudges: { shown: number; followed: number };
  forks: {
    count: number;
    turns: number;
    folds: number;
    failed: number;
    /** Refused before starting, such as for a context too full to fork from. */
    refused: number;
    cost: number;
  };
  compactions: number;
  reminders: number;
  /** Estimated tokens the extension added to the transcript, and its prompt section. */
  overhead: { stamps: number; cues: number; notices: number; prompt: number };
}

function tokensOf(chars: number): number {
  return Math.ceil(chars / 4);
}

function message(entry: SessionEntry | undefined): AgentMessage | undefined {
  return entry?.type === 'message' ? entry.message : undefined;
}

function toolCalls(entry: SessionEntry | undefined): { id: string; name: string; path?: string }[] {
  const found = message(entry);
  if (found?.role !== 'assistant') return [];
  return found.content.flatMap((block) =>
    block.type === 'toolCall'
      ? [
          {
            id: block.id,
            name: block.name,
            ...(typeof block.arguments.path === 'string' ? { path: block.arguments.path } : {})
          }
        ]
      : []
  );
}

/** Tool calls made by the next `count` responses after `index`. */
function callsAfter(
  entries: readonly SessionEntry[],
  index: number,
  count: number
): { id: string; name: string; path?: string }[] {
  const calls: { id: string; name: string; path?: string }[] = [];
  let responses = 0;
  for (const entry of entries.slice(index + 1)) {
    if (message(entry)?.role !== 'assistant') continue;
    calls.push(...toolCalls(entry));
    if (++responses >= count) break;
  }
  return calls;
}

function textChars(found: AgentMessage, keep: (text: string) => boolean): number {
  if (found.role !== 'user' && found.role !== 'toolResult' && found.role !== 'custom') return 0;
  if (typeof found.content === 'string') return keep(found.content) ? found.content.length : 0;
  return found.content.reduce(
    (sum, block) => sum + (block.type === 'text' && keep(block.text) ? block.text.length : 0),
    0
  );
}

/**
 * Numbers for one branch of a session, read from its entries alone: the tool results carry
 * the fold, fork, recall and ask records, and `episodes-event` entries the rest. Nothing is
 * kept in memory, so a resumed or older session reads the same way, and a script outside pi
 * can call this on a parsed session file.
 */
export function episodeStats(entries: readonly SessionEntry[], cwd: string): EpisodeStats {
  const stats: EpisodeStats = {
    requests: [],
    folds: {
      count: 0,
      pickedByUser: 0,
      requestedByUser: 0,
      tokens: 0,
      spanTokens: [],
      small: 0,
      noteTokens: 0,
      notAlone: 0,
      beforeFinal: 0,
      saved: 0,
      rejected: 0,
      retriedOk: 0,
      uncachedAfter: [],
      anchorKnown: 0,
      anchored: 0,
      gapTokens: []
    },
    recall: { count: 0, empty: 0, compacted: 0 },
    ask: { count: 0 },
    stale: { shown: 0, reread: 0 },
    cues: { shown: 0, followed: 0, readOnly: 0, capped: 0 },
    nudges: { shown: 0, followed: 0 },
    forks: { count: 0, turns: 0, folds: 0, failed: 0, refused: 0, cost: 0 },
    compactions: 0,
    reminders: 0,
    overhead: { stamps: 0, cues: 0, notices: 0, prompt: tokensOf(EPISODES_SECTION.length) }
  };

  const applied = appliedFolds(entries);
  const foldNet = new Map<string, number>();
  /** Net tokens of folds in effect, saved again on every request until a compaction. */
  let active = 0;
  let mark: RequestPoint['after'];

  /** A recall that matched the thread, or an ask of it, within the next few responses. */
  const followed = (index: number, handle: string) => {
    const ids = new Set(callsAfter(entries, index, FOLLOW_WINDOW).map((call) => call.id));
    return entries.some((entry) => {
      const found = message(entry);
      if (found?.role !== 'toolResult' || found.isError || !ids.has(found.toolCallId)) return false;
      if (found.toolName === 'ask') {
        return (found.details as AskDetails | undefined)?.handle === handle;
      }
      if (found.toolName === 'recall') {
        return (found.details as RecallDetails | undefined)?.hits?.includes(handle) ?? false;
      }
      return false;
    });
  };

  /** An applied fold within the next few responses whose span holds the nudged result. */
  const foldedAfter = (index: number, toolCallId: string) => {
    const nudged = entries.find((entry) => {
      const found = message(entry);
      return found?.role === 'toolResult' && found.toolCallId === toolCallId;
    });
    const result = message(nudged);
    const stamp = result ? readStamp(result) : undefined;
    if (stamp === undefined) return false;
    const ids = new Set(callsAfter(entries, index, FOLLOW_WINDOW).map((call) => call.id));
    return entries.some((entry) => {
      const found = message(entry);
      if (found?.role !== 'toolResult' || found.isError || !ids.has(found.toolCallId)) return false;
      if (found.toolName !== FOLD_TOOL || !isFoldDetails(found.details)) return false;
      if (!applied.has(found.details.handle)) return false;
      const since = parseStamp(found.details.since);
      const until = found.details.until ? parseStamp(found.details.until) : undefined;
      return since !== undefined && since <= stamp && (until === undefined || stamp <= until);
    });
  };

  const countStale = (stale: readonly StaleThread[] | undefined, index: number) => {
    if (!stale || stale.length === 0) return;
    stats.stale.shown += stale.length;
    const reads = callsAfter(entries, index, FOLLOW_WINDOW)
      .filter((call) => call.name === 'read' && call.path)
      .map((call) => resolve(cwd, call.path!));
    for (const thread of stale) {
      if (thread.files.some((file) => reads.includes(file))) stats.stale.reread++;
    }
  };

  entries.forEach((entry, index) => {
    if (entry.type === 'compaction') {
      stats.compactions++;
      active = 0;
      mark = 'compaction';
      return;
    }
    if (entry.type === 'custom' && entry.customType === FOLD_APPLIED_TYPE) {
      const handle = (entry.data as { handle?: string } | undefined)?.handle;
      active += (handle && foldNet.get(handle)) || 0;
      mark = 'fold';
      return;
    }
    if (entry.type === 'custom' && entry.customType === EVENT_TYPE) {
      const event = entry.data as EpisodeEvent;
      if (event.kind === 'fold-rejected') {
        stats.folds.rejected++;
        // The event is written before the rejected call's own error result.
        const next = entries.slice(index + 1).find((later) => {
          const found = message(later);
          return (
            found?.role === 'toolResult' &&
            found.toolName === FOLD_TOOL &&
            found.toolCallId !== event.toolCallId
          );
        });
        const result = message(next);
        if (result?.role === 'toolResult' && !result.isError) stats.folds.retriedOk++;
      } else if (event.kind === 'cue') {
        stats.cues.shown += event.threads.length;
        stats.cues.readOnly += event.threads.filter((thread) => thread.readOnly).length;
        if (event.matched > event.threads.length) stats.cues.capped++;
        for (const thread of event.threads) {
          if (followed(index, thread.handle)) stats.cues.followed++;
        }
      } else if (event.kind === 'nudge') {
        stats.nudges.shown++;
        if (foldedAfter(index, event.toolCallId)) stats.nudges.followed++;
      }
      return;
    }
    if (entry.type === 'custom_message') {
      if (entry.customType === REMINDER_TYPE) stats.reminders++;
      if (entry.customType === REMINDER_TYPE || entry.customType === COMPACTION_NOTICE_TYPE) {
        const content = entry.content;
        stats.overhead.notices += tokensOf(
          typeof content === 'string'
            ? content.length
            : content.reduce(
                (sum, block) => sum + (block.type === 'text' ? block.text.length : 0),
                0
              )
        );
      }
      return;
    }

    const found = message(entry);
    if (!found) return;

    if (found.role === 'assistant') {
      const usage = found.usage;
      const tokens = usage.input + usage.cacheRead + usage.cacheWrite;
      if (tokens === 0) return;
      stats.requests.push(mark ? { tokens, after: mark } : { tokens });
      if (mark === 'fold') stats.folds.uncachedAfter.push(usage.input + usage.cacheWrite);
      mark = undefined;
      stats.folds.saved += active;
      return;
    }

    if (found.role === 'user' || found.role === 'toolResult') {
      stats.overhead.stamps += tokensOf(
        textChars(found, (text) => isStampBlock({ type: 'text', text }))
      );
    }
    if (found.role !== 'toolResult') return;
    stats.overhead.cues += tokensOf(textChars(found, (text) => text.startsWith('[episodes] ')));

    const details = found.details;
    if (found.toolName === FOLD_TOOL && isFoldDetails(details) && applied.has(details.handle)) {
      const folds = stats.folds;
      folds.count++;
      if (details.manual === 'since') folds.pickedByUser++;
      if (details.manual === 'request') folds.requestedByUser++;
      folds.tokens += details.tokens;
      folds.spanTokens.push(details.tokens);
      if (details.tokens < SMALL_SPAN_TOKENS) folds.small++;
      folds.noteTokens += details.noteTokens ?? 0;
      foldNet.set(details.handle, Math.max(0, details.tokens - (details.noteTokens ?? 0)));
      if (details.anchor?.placed !== undefined) {
        folds.anchorKnown++;
        if (details.anchor.placed) folds.anchored++;
        if (details.anchor.gapTokens !== undefined) folds.gapTokens.push(details.anchor.gapTokens);
      }

      const caller = entries
        .slice(0, index)
        .findLast((earlier) => toolCalls(earlier).some((call) => call.id === found.toolCallId));
      if (toolCalls(caller).length > 1) folds.notAlone++;
      // A /fold ends the run on purpose; the reply after it answers a new prompt.
      const next = message(
        entries.slice(index + 1).find((later) => message(later)?.role === 'assistant')
      );
      if (
        !details.manual &&
        next?.role === 'assistant' &&
        next.stopReason === 'stop' &&
        !next.content.some((block) => block.type === 'toolCall')
      ) {
        folds.beforeFinal++;
      }
      return;
    }
    // A fork that failed or was stopped still returns its record.
    if (found.toolName === FORK_TOOL) {
      const forks = stats.forks;
      if (!isForkDetails(details)) {
        if (found.isError) forks.refused++;
        return;
      }
      forks.count++;
      forks.turns += details.turns;
      forks.folds += details.folds ?? 0;
      if (details.status && details.status !== 'done') forks.failed++;
      forks.cost += details.usage?.cost.total ?? 0;
      return;
    }
    if (found.isError) return;
    if (found.toolName === 'recall') {
      const recall = details as RecallDetails | undefined;
      stats.recall.count++;
      if (recall?.total === 0) stats.recall.empty++;
      if (recall?.hits?.some((handle) => handle.startsWith('cp-'))) stats.recall.compacted++;
      countStale(recall?.stale, index);
    } else if (found.toolName === 'ask') {
      stats.ask.count++;
      countStale((details as AskDetails | undefined)?.stale, index);
    }
  });

  return stats;
}

const BARS = '▁▂▃▄▅▆▇█';

/**
 * One block per request, scaled to the largest shown so the drops stay visible however large
 * the window is. `paint` colors a bar, such as the ones right after a fold.
 */
export function sparkline(
  points: readonly RequestPoint[],
  width: number,
  paint: (bar: string, point: RequestPoint) => string = (bar) => bar
): string {
  const shown = points.slice(-width);
  const max = Math.max(...shown.map((point) => point.tokens));
  return shown
    .map((point) => {
      const level = Math.max(0, Math.ceil((point.tokens / max) * BARS.length) - 1);
      return paint(BARS[level]!, point);
    })
    .join('');
}

function k(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function average(values: readonly number[]): number {
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/** Only the parts that happened, with counts in parentheses when there are any. */
function parts(...items: [number, string][]): string {
  return items
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`)
    .join(', ');
}

/** The /episodes stats view: a few plain lines, each left out when it has nothing to say. */
export function statsLines(stats: EpisodeStats): string[] {
  const lines: string[] = [];
  if (stats.requests.length > 1) {
    lines.push(`context per request  ${sparkline(stats.requests, 48)}`);
  }

  const folds = stats.folds;
  if (folds.count > 0 || folds.rejected > 0) {
    const detail = parts(
      [folds.pickedByUser, 'span picked by you'],
      [folds.requestedByUser, 'asked by you'],
      [folds.small, 'under 2k'],
      [folds.notAlone, 'not alone in their response'],
      [folds.beforeFinal, 'right before a final reply']
    );
    lines.push(
      `folds ${folds.count}${folds.count > 0 ? `, median ~${k(median(folds.spanTokens))}, notes ~${k(folds.noteTokens)}` : ''}${detail ? ` (${detail})` : ''}`
    );
    if (folds.rejected > 0) {
      lines.push(`fold errors ${folds.rejected}, next fold succeeded after ${folds.retriedOk}`);
    }
  }
  if (folds.count > 0 || stats.compactions > 0) {
    lines.push(
      `context ~${k(folds.tokens)} folded, ~${k(folds.saved)} fewer tokens sent since, compactions ${stats.compactions}`
    );
  }
  if (folds.uncachedAfter.length > 0 || folds.anchorKnown > 0) {
    const cache = [
      folds.uncachedAfter.length > 0
        ? `missed after fold avg ~${k(average(folds.uncachedAfter))}`
        : '',
      folds.anchorKnown > 0 ? `anchor placed ${folds.anchored}/${folds.anchorKnown}` : '',
      folds.gapTokens.length > 0 ? `anchor to span start avg ~${k(average(folds.gapTokens))}` : ''
    ].filter(Boolean);
    lines.push(`cache ${cache.join(', ')}`);
  }

  const back = [
    stats.recall.count > 0
      ? `recall ${stats.recall.count}${stats.recall.empty || stats.recall.compacted ? ` (${parts([stats.recall.empty, 'empty'], [stats.recall.compacted, 'in compacted turns'])})` : ''}`
      : '',
    stats.ask.count > 0 ? `ask ${stats.ask.count}` : '',
    stats.stale.shown > 0 ? `stale ${stats.stale.shown} (re-read ${stats.stale.reread})` : ''
  ].filter(Boolean);
  if (back.length > 0) lines.push(back.join(', '));
  const cues = stats.cues;
  if (cues.shown > 0) {
    const detail = parts([cues.readOnly, 'read-only'], [cues.capped, 'capped']);
    lines.push(`cues ${cues.shown}, followed ${cues.followed}${detail ? ` (${detail})` : ''}`);
  }
  if (stats.nudges.shown > 0) {
    lines.push(`heavy-result nudges ${stats.nudges.shown}, folded after ${stats.nudges.followed}`);
  }

  const forks = stats.forks;
  if (forks.count > 0 || forks.refused > 0) {
    const detail = parts(
      [forks.folds, 'folded inside'],
      [forks.failed, 'stopped or failed'],
      [forks.refused, 'refused']
    );
    lines.push(
      `forks ${forks.count}, ${forks.turns} turns${forks.cost > 0 ? `, $${forks.cost.toFixed(2)}` : ''}${detail ? ` (${detail})` : ''}`
    );
  }
  if (stats.reminders > 0) lines.push(`open-item reminders ${stats.reminders}`);

  const overhead = stats.overhead;
  lines.push(
    `added by the extension ~${k(overhead.stamps + overhead.cues + overhead.notices)} (stamps ~${k(overhead.stamps)}, cues ~${k(overhead.cues)}, reminders and notices ~${k(overhead.notices)}), prompt ~${k(overhead.prompt)} per request`
  );
  return lines;
}
