import type { AgentMessage, AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Tool } from '@earendil-works/pi-ai';
import type { ProjectedSessionEntry, SessionEntry } from '@earendil-works/pi-coding-agent';
import type { FoldDetails, NestedFold } from './archive.js';
import { headline, openItems, planFold, renderNote } from './fold.js';
import { estimateTokens, touchedPaths } from './messages.js';
import { parseStamp, readStamp, stampLabel, withStamp } from './stamps.js';
import type { EpisodeState } from './state.js';

/**
 * Folding inside a fork. The child is a plain agent, not a pi session, so there are no
 * session entries to edit: it gets synthetic entries for `planFold` and hides folded spans
 * per request through its `transformContext`. Its tool results are stamped from the
 * session's own counter, so a stamp means one message across parent and children.
 */
export class ForkFolds {
  readonly folds: NestedFold[] = [];
  private readonly forkHandle: string;
  private readonly state: EpisodeState;
  private readonly parentEntries: readonly ProjectedSessionEntry[];
  /** Messages before the child's own: the parent's view plus closed sibling fork calls. */
  private readonly prefixLength: number;
  private readonly siblings: number;
  private readonly omitted = new Set<AgentMessage>();
  private readonly applied = new Set<string>();

  constructor(options: {
    forkHandle: string;
    state: EpisodeState;
    parentEntries: readonly ProjectedSessionEntry[];
    prefixLength: number;
    siblings: number;
  }) {
    this.forkHandle = options.forkHandle;
    this.state = options.state;
    this.parentEntries = options.parentEntries;
    this.prefixLength = options.prefixLength;
    this.siblings = options.siblings;
  }

  /** What the child sees: everything but the spans it folded. */
  view(messages: readonly AgentMessage[]): AgentMessage[] {
    return messages.filter((message) => !this.omitted.has(message));
  }

  /** Stamps a child tool result in place, before the loop sends it. */
  stamp(message: AgentMessage): void {
    if (message.role !== 'toolResult') return;
    message.content = withStamp(message.content, this.state.nextStamp++);
  }

  tool(declaration: Tool, messages: () => readonly AgentMessage[]): AgentTool {
    return {
      ...declaration,
      label: declaration.name,
      executionMode: 'sequential',
      execute: async (toolCallId, args) => this.fold(toolCallId, args, messages())
    };
  }

  private entries(messages: readonly AgentMessage[]): ProjectedSessionEntry[] {
    const own = messages.slice(this.prefixLength - this.siblings).map((message, index) => {
      const sibling = index < this.siblings;
      const id = sibling
        ? `${this.forkHandle}/s${index}`
        : `${this.forkHandle}/${index - this.siblings}`;
      const sourceEntry = {
        type: 'message',
        id,
        parentId: null,
        timestamp: new Date(message.timestamp).toISOString(),
        message
      } as SessionEntry;
      return { sourceEntry, messages: this.omitted.has(message) ? [] : [message] };
    });
    return [...this.parentEntries, ...own];
  }

  private async fold(
    toolCallId: string,
    args: unknown,
    messages: readonly AgentMessage[]
  ): Promise<AgentToolResult<FoldDetails>> {
    const params = args as { since?: unknown; note?: unknown };
    const since = typeof params.since === 'string' ? parseStamp(params.since) : undefined;
    if (since === undefined) {
      throw new Error(`since must be a turn stamp such as "t12", got "${String(params.since)}".`);
    }
    const note = typeof params.note === 'string' ? params.note.trim() : '';
    if (!note) {
      throw new Error('The note is empty. Write what the rest of the task needs from the span.');
    }

    const entries = this.entries(messages);
    // The task is the first entry after the parent's view and the siblings; the fork's own
    // work starts after it.
    const plan = planFold(entries, toolCallId, since, {
      latestStamp: this.state.nextStamp - 1,
      floorIndex: this.parentEntries.length + this.siblings,
      applied: this.applied
    });

    const byId = new Map(entries.map((entry) => [entry.sourceEntry.id, entry]));
    const index = (id: string) => Number(id.slice(this.forkHandle.length + 1));
    const omit: number[] = [];
    for (const edit of plan.edits) {
      // Children have no user messages, so a fold only ever omits.
      if (edit.replacement !== null) continue;
      const message = byId.get(edit.targetId)?.messages[0];
      if (!message) continue;
      this.omitted.add(message);
      omit.push(index(edit.targetId));
    }
    this.applied.add(plan.handle);

    const sinceLabel = stampLabel(since);
    const lastStamp = plan.spanMessages.map(readStamp).findLast((stamp) => stamp !== undefined);
    const until =
      lastStamp !== undefined && lastStamp !== since ? stampLabel(lastStamp) : undefined;
    const touched = touchedPaths(plan.spanMessages, this.state.cwd);
    const tokens = estimateTokens(plan.omitted);
    const record: FoldDetails = {
      kind: 'fold',
      handle: plan.handle,
      since: sinceLabel,
      ...(until ? { until } : {}),
      firstEntryId: plan.firstEntryId,
      lastEntryId: plan.lastEntryId,
      messages: plan.omitted.length,
      tokens,
      headline: headline(note),
      keptUserTurns: plan.keptUserTurns,
      files: touched
    };
    const open = openItems(note);
    if (open) record.open = open;
    this.folds.push({
      record,
      first: index(plan.firstEntryId),
      last: index(plan.lastEntryId),
      omit
    });

    return {
      content: [
        {
          type: 'text',
          text: renderNote({
            handle: plan.handle,
            since: sinceLabel,
            until,
            messages: plan.omitted.length,
            tokens,
            note,
            // The fork's own result carries the working tree diff for all of its work.
            changes: undefined,
            touched,
            keptUserTurns: plan.keptUserTurns,
            cwd: this.state.cwd
          })
        }
      ],
      details: record
    };
  }
}
