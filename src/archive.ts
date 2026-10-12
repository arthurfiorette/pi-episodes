import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Usage } from '@earendil-works/pi-ai';
import {
  buildSessionProjection,
  type ExtensionContext,
  type SessionEntry,
  sessionEntryToContextMessages
} from '@earendil-works/pi-coding-agent';

export type SessionView = ExtensionContext['sessionManager'];

export const FOLD_TOOL = 'fold';
export const FORK_TOOL = 'fork';

/** Stored on the fold tool result, so the record follows the branch it belongs to. */
export interface FoldDetails {
  kind: 'fold';
  handle: string;
  since: string;
  firstEntryId: string;
  lastEntryId: string;
  messages: number;
  tokens: number;
  headline: string;
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
  /** Absolute paths touched or changed while the fork ran. */
  files: string[];
  /** Working tree when the fork finished. */
  treeAfter?: string;
  /** Child transcript file, absent for in-memory sessions. */
  archive?: string;
  /** The child's own model calls. */
  usage?: Usage;
}

export type ThreadRecord = FoldDetails | ForkDetails;

export interface ForkArchive {
  handle: string;
  task: string;
  parentEntryId: string;
  /** Messages the child added after the parent prefix, starting with the task. */
  messages: AgentMessage[];
}

export interface Thread {
  handle: string;
  kind: 'fold' | 'fork';
  label: string;
  /** What the thread itself held, unedited. */
  messages: AgentMessage[];
  /** The full context the thread ran with: everything before it plus the thread. */
  context(): AgentMessage[];
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
  return entries.map((entry) => toolDetails(entry, FOLD_TOOL)).filter(isFoldDetails);
}

export function forkRecords(entries: readonly SessionEntry[]): ForkDetails[] {
  return entries.map((entry) => toolDetails(entry, FORK_TOOL)).filter(isForkDetails);
}

/** Folds and forks on these entries, in order. */
export function threadRecords(entries: readonly SessionEntry[]): ThreadRecord[] {
  return entries.flatMap((entry) => {
    const record = toolDetails(entry, FOLD_TOOL) ?? toolDetails(entry, FORK_TOOL);
    return isFoldDetails(record) || isForkDetails(record) ? [record] : [];
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
  await writeFile(file, JSON.stringify(archive));
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
        record.kind === 'fold' ? this.foldThread(record) : await this.forkThread(record);
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
    return fork ? this.forkThread(fork) : undefined;
  }

  private foldThread(fold: FoldDetails): Thread | undefined {
    const path = this.sessions.getBranch(fold.lastEntryId);
    const start = path.findIndex((entry) => entry.id === fold.firstEntryId);
    if (start < 0) return undefined;

    return {
      handle: fold.handle,
      kind: 'fold',
      label: `turns from ${fold.since} on`,
      messages: path.slice(start).flatMap(sessionEntryToContextMessages),
      context: () => buildSessionProjection(this.sessions.getEntries(), fold.lastEntryId).messages,
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
        ...archive.messages
      ],
      record: fork
    };
  }
}

async function readArchive(file: string | undefined): Promise<ForkArchive | undefined> {
  if (!file) return undefined;
  try {
    return JSON.parse(await readFile(file, 'utf8')) as ForkArchive;
  } catch {
    return undefined;
  }
}
