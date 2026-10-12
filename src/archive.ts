import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Usage } from '@earendil-works/pi-ai';
import {
  buildSessionProjection,
  type CompactionEntry,
  type ExtensionContext,
  type SessionEntry,
  sessionEntryToContextMessages
} from '@earendil-works/pi-coding-agent';
import { readStamp, stampLabel } from './stamps.js';

export type SessionView = ExtensionContext['sessionManager'];

export const FOLD_TOOL = 'fold';
export const FORK_TOOL = 'fork';
/** The message /fold sends to ask for a fold. */
export const FOLD_REQUEST_TYPE = 'episodes-fold-request';
/**
 * Appended with a fold's context edits, in the same all-or-nothing batch. A fold result
 * without it never took effect: pi drops every boundary draft when any is invalid, and a crash
 * can land between the result and the turn end.
 */
export const FOLD_APPLIED_TYPE = 'episodes-fold-applied';

/** Handles of folds whose edits are among these entries. */
export function appliedFolds(entries: readonly SessionEntry[]): Set<string> {
  const handles = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== FOLD_APPLIED_TYPE) continue;
    const handle = (entry.data as { handle?: unknown } | undefined)?.handle;
    if (typeof handle === 'string') handles.add(handle);
  }
  return handles;
}

/** Stored on the fold tool result, so the record follows the branch it belongs to. */
export interface FoldDetails {
  kind: 'fold';
  handle: string;
  since: string;
  firstEntryId: string;
  lastEntryId: string;
  /** Last stamp inside the span, so the range it covered can be shown. */
  until?: string;
  messages: number;
  tokens: number;
  headline: string;
  /** The note's open items, for the reminder after the fold. */
  open?: string;
  keptUserTurns: string[];
  /** Absolute paths touched or changed inside the span. */
  files: string[];
  /** Working tree at fold time, to tell later readers which of `files` changed since. */
  treeAfter?: string;
}

export interface ForkDetails {
  kind: 'fork';
  handle: string;
  task: string;
  /** The assistant entry that called fork; the child started from the view at that entry. */
  parentEntryId: string;
  turns: number;
  headline: string;
  /** The final note's open items, for the reminder after the fork. */
  open?: string;
  /** Absolute paths touched or changed while the fork ran. */
  files: string[];
  /** Working tree when the fork finished. */
  treeAfter?: string;
  /** Child transcript file, absent for in-memory sessions. */
  archive?: string;
  /** The child's own model calls. */
  usage?: Usage;
}

/**
 * The turns a pi compaction summarized away, as one more archived thread. Derived from the
 * compaction entry itself; nothing is stored for it.
 */
export interface CompactionRecord {
  kind: 'compaction';
  handle: string;
  entryId: string;
  headline: string;
  tokens: number;
  /** Files pi's default compaction recorded as modified, as recorded (possibly relative). */
  files: string[];
  /** Never set; present so every record can be read the same way. */
  open?: string;
  /** Never set; there is no snapshot from compaction time. */
  treeAfter?: string;
}

export type ThreadRecord = FoldDetails | ForkDetails | CompactionRecord;

export function compactionHandle(entryId: string): string {
  return `cp-${entryId.slice(0, 8)}`;
}

function compactionRecord(entry: CompactionEntry): CompactionRecord {
  // Only modified files: compactions list every file read, which would make the file-touch
  // cue fire on nearly everything.
  const modified = (entry.details as { modifiedFiles?: unknown } | undefined)?.modifiedFiles;
  return {
    kind: 'compaction',
    handle: compactionHandle(entry.id),
    entryId: entry.id,
    headline: `turns compacted at ${entry.timestamp.slice(0, 16).replace('T', ' ')}`,
    tokens: entry.tokensBefore,
    files: Array.isArray(modified)
      ? modified.filter((path): path is string => typeof path === 'string')
      : []
  };
}

export interface ForkArchive {
  handle: string;
  task: string;
  parentEntryId: string;
  /** Results that closed sibling fork calls in the child's prefix, so `ask` rebuilds it as it was. */
  siblings?: AgentMessage[];
  /** Messages the child added after the parent prefix, starting with the task. */
  messages: AgentMessage[];
}

export interface Thread {
  handle: string;
  kind: ThreadRecord['kind'];
  label: string;
  /** What the thread itself held, unedited. */
  messages: AgentMessage[];
  /**
   * The full context the thread ran with: everything before it plus the thread. Absent for
   * compacted turns, which filled the window when they were compacted; `ask` cannot resume them.
   */
  context?: () => AgentMessage[];
  record: ThreadRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isFoldDetails(value: unknown): value is FoldDetails {
  return isRecord(value) && value.kind === 'fold' && typeof value.handle === 'string';
}

export function isForkDetails(value: unknown): value is ForkDetails {
  return isRecord(value) && value.kind === 'fork' && typeof value.handle === 'string';
}

function toolDetails(entry: SessionEntry, toolName: string): unknown {
  if (entry.type !== 'message' || entry.message.role !== 'toolResult') return undefined;
  if (entry.message.toolName !== toolName) return undefined;
  // A failed fold changed nothing, but a failed fork still did work worth recalling.
  if (entry.message.isError && toolName === FOLD_TOOL) return undefined;
  return entry.message.details;
}

export function foldRecords(entries: readonly SessionEntry[]): FoldDetails[] {
  const applied = appliedFolds(entries);
  return entries
    .map((entry) => toolDetails(entry, FOLD_TOOL))
    .filter(isFoldDetails)
    .filter((record) => applied.has(record.handle));
}

export function forkRecords(entries: readonly SessionEntry[]): ForkDetails[] {
  return entries.map((entry) => toolDetails(entry, FORK_TOOL)).filter(isForkDetails);
}

/** Folds, forks and compactions on these entries, in order. */
export function threadRecords(entries: readonly SessionEntry[]): ThreadRecord[] {
  const applied = appliedFolds(entries);
  return entries.flatMap((entry): ThreadRecord[] => {
    if (entry.type === 'compaction') return [compactionRecord(entry)];
    const record = toolDetails(entry, FOLD_TOOL) ?? toolDetails(entry, FORK_TOOL);
    if (isFoldDetails(record)) return applied.has(record.handle) ? [record] : [];
    return isForkDetails(record) ? [record] : [];
  });
}

/** Directory next to the session file where fork transcripts are kept. */
export function archiveDir(sessions: SessionView): string | undefined {
  const file = sessions.getSessionFile();
  if (!file) return undefined;
  return join(dirname(file), `${basename(file, extname(file))}.episodes`);
}

export async function writeForkArchive(
  dir: string | undefined,
  archive: ForkArchive
): Promise<string | undefined> {
  if (!dir) return undefined;
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${archive.handle}.json`);
  // Written after every turn; a crash mid-write must not leave a truncated transcript.
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(archive));
  await rename(temporary, file);
  return file;
}

export class ThreadIndex {
  private readonly sessions: SessionView;
  private readonly memory: ReadonlyMap<string, ForkArchive>;

  constructor(sessions: SessionView, memory: ReadonlyMap<string, ForkArchive>) {
    this.sessions = sessions;
    this.memory = memory;
  }

  /** Threads archived on the current branch, oldest first. */
  async onBranch(): Promise<Thread[]> {
    const threads: Thread[] = [];
    for (const record of threadRecords(this.sessions.getBranch())) {
      const thread =
        record.kind === 'fold'
          ? this.foldThread(record)
          : record.kind === 'fork'
            ? await this.forkThread(record)
            : this.compactionThread(record);
      if (thread) threads.push(thread);
    }
    return threads;
  }

  /** Any archived thread in the session, on this branch or an abandoned one. */
  async find(handle: string): Promise<Thread | undefined> {
    const entries = this.sessions.getEntries();
    const fold = foldRecords(entries).find((record) => record.handle === handle);
    if (fold) return this.foldThread(fold);
    const fork = forkRecords(entries).find((record) => record.handle === handle);
    if (fork) return this.forkThread(fork);
    const compaction = entries.find(
      (entry): entry is CompactionEntry =>
        entry.type === 'compaction' && compactionHandle(entry.id) === handle
    );
    return compaction ? this.compactionThread(compactionRecord(compaction)) : undefined;
  }

  /**
   * What the compaction summarized: the view just before it (folds applied, so folded spans
   * stay in their own threads), from after the previous summary up to the first kept entry.
   */
  private compactionThread(record: CompactionRecord): Thread | undefined {
    const entries = this.sessions.getEntries();
    const entry = entries.find((candidate) => candidate.id === record.entryId);
    if (entry?.type !== 'compaction' || !entry.parentId) return undefined;

    const before = buildSessionProjection(entries, entry.parentId).entries;
    const start = before[0]?.sourceEntry.type === 'compaction' ? 1 : 0;
    const kept = before.findIndex(
      (candidate) => candidate.sourceEntry.id === entry.firstKeptEntryId
    );
    const messages = before
      .slice(start, kept < 0 ? before.length : kept)
      .flatMap((candidate) => candidate.messages)
      .filter((message) => message.role !== 'system');
    if (messages.length === 0) return undefined;

    const stamps = messages.map(readStamp).filter((stamp) => stamp !== undefined);
    const first = stamps[0];
    const last = stamps.at(-1);
    return {
      handle: record.handle,
      kind: 'compaction',
      label:
        first !== undefined && last !== undefined
          ? `turns ${stampLabel(first)}-${stampLabel(last)}, compacted`
          : 'compacted turns',
      messages,
      record
    };
  }

  private foldThread(fold: FoldDetails): Thread | undefined {
    const path = this.sessions.getBranch(fold.lastEntryId);
    const start = path.findIndex((entry) => entry.id === fold.firstEntryId);
    if (start < 0) return undefined;

    return {
      handle: fold.handle,
      kind: 'fold',
      label: fold.until ? `turns ${fold.since}-${fold.until}` : `turns from ${fold.since} on`,
      messages: path.slice(start).flatMap(sessionEntryToContextMessages),
      context: () => {
        const messages = buildSessionProjection(
          this.sessions.getEntries(),
          fold.lastEntryId
        ).messages;
        // A span folded through /fold ends with the request to fold; a question appended
        // after it would read as that request, and the thread would try to fold again.
        while (isFoldRequest(messages.at(-1))) messages.pop();
        return messages;
      },
      record: fold
    };
  }

  private async forkThread(fork: ForkDetails): Promise<Thread | undefined> {
    const archive = this.memory.get(fork.handle) ?? (await readArchive(fork.archive));
    if (!archive) return undefined;

    return {
      handle: fork.handle,
      kind: 'fork',
      label: `fork: ${fork.task.slice(0, 80)}`,
      messages: archive.messages,
      context: () => [
        ...buildSessionProjection(this.sessions.getEntries(), fork.parentEntryId).messages,
        ...(archive.siblings ?? []),
        ...archive.messages
      ],
      record: fork
    };
  }
}

function isFoldRequest(message: AgentMessage | undefined): boolean {
  return message?.role === 'custom' && message.customType === FOLD_REQUEST_TYPE;
}

async function readArchive(file: string | undefined): Promise<ForkArchive | undefined> {
  if (!file) return undefined;
  try {
    return JSON.parse(await readFile(file, 'utf8')) as ForkArchive;
  } catch {
    return undefined;
  }
}
