import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  type AssistantMessage,
  getSystemMessageText,
  type SystemMessage,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
  type Usage
} from '@earendil-works/pi-ai';
import {
  type CompactionEntry,
  type ContextEditEntry,
  type CustomEntry,
  type CustomMessageEntry,
  type FileEntry,
  migrateSessionEntries,
  parseSessionEntries,
  type SessionEntry,
  type SessionHeader,
  type SessionMessageEntry
} from '@earendil-works/pi-coding-agent';

/** pi does not export it by name: the `usage` entry cache warming appends. */
export type UsageEntry = Extract<SessionEntry, { type: 'usage' }>;

export type {
  CompactionEntry,
  ContextEditEntry,
  CustomEntry,
  CustomMessageEntry,
  SessionEntry,
  SessionHeader,
  SessionMessageEntry
};

// Names and shapes that pi-episodes writes into sessions. Declared here instead of imported
// from `src/` so a stored session from any pi-episodes build can be analyzed.
export const FOLD_TOOL = 'fold';
export const RECALL_TOOL = 'recall';
export const ASK_TOOL = 'ask';
export const FORK_TOOL = 'fork';
export const EPISODE_TOOLS = [FOLD_TOOL, RECALL_TOOL, ASK_TOOL, FORK_TOOL] as const;
/** `custom` entry appended with a fold's context edits; a fold result without one never took effect. */
export const FOLD_APPLIED_TYPE = 'episodes-fold-applied';
/** `custom_message` with the open items of folds since the last reminder. */
export const REMINDER_TYPE = 'episodes-open';
/** `custom_message` appended after a pi compaction naming the archived handle. */
export const COMPACTION_NOTICE_TYPE = 'episodes-compacted';
export const FOLD_REQUEST_TYPE = 'episodes-fold-request';

/**
 * DESIGN 5.6: a 429 or 5xx provider error. Status codes are matched as whole numbers in the
 * 5xx set providers use, or any 5xx after "status", "HTTP" or "code", so "line 512" or
 * "512 KB" in an error text do not count.
 */
const THROTTLED_RE =
  /\b429\b|\b5(?:0[0-4]|2[04]|29)\b|\b(?:status|http|code)\s*:?\s*5\d\d\b|rate.?limit|too many requests|overloaded|service.?unavailable|internal server error/i;

export function isThrottledText(text: string): boolean {
  return THROTTLED_RE.test(text);
}

export function isThrottledError(message: AssistantMessage): boolean {
  return (
    message.stopReason === 'error' &&
    message.errorMessage !== undefined &&
    isThrottledText(message.errorMessage)
  );
}

export interface FoldDetails {
  kind: 'fold';
  handle: string;
  since: string;
  until?: string;
  firstEntryId: string;
  lastEntryId: string;
  messages: number;
  tokens: number;
  headline: string;
  open?: string;
  keptUserTurns: string[];
  files: string[];
  treeAfter?: string;
}

export interface ForkDetails {
  kind: 'fork';
  handle: string;
  task: string;
  parentEntryId: string;
  turns: number;
  headline: string;
  open?: string;
  files: string[];
  treeAfter?: string;
  archive?: string;
  usage?: Usage;
}

export interface RecallDetails {
  query: string;
  threads: number;
  shown: number;
  total: number;
  file?: string;
}

export interface AskDetails {
  handle: string;
  question: string;
}

/** `<session>.episodes/fk-*.json`, written by pi-episodes after every fork turn. */
export interface ForkArchive {
  handle: string;
  task: string;
  parentEntryId: string;
  siblings?: AgentMessage[];
  messages: AgentMessage[];
  folds?: { record: FoldDetails; first: number; last: number; omit: number[] }[];
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

export function isRecallDetails(value: unknown): value is RecallDetails {
  return isRecord(value) && typeof value.query === 'string' && typeof value.total === 'number';
}

export function isAskDetails(value: unknown): value is AskDetails {
  return isRecord(value) && typeof value.handle === 'string' && typeof value.question === 'string';
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface Session {
  path: string;
  header?: SessionHeader;
  entries: SessionEntry[];
}

export function parseSession(content: string, path = '<memory>'): Session {
  const fileEntries: FileEntry[] = parseSessionEntries(content);
  migrateSessionEntries(fileEntries);
  const header = fileEntries.find((entry): entry is SessionHeader => entry.type === 'session');
  const entries = fileEntries.filter((entry): entry is SessionEntry => entry.type !== 'session');
  return header ? { path, header, entries } : { path, entries };
}

export function readSession(path: string): Session {
  return parseSession(readFileSync(path, 'utf8'), path);
}

/**
 * The path from the leaf to the root, oldest first. The leaf is the last entry in the file,
 * as `SessionManager` picks it on load.
 */
export function activeBranch(entries: readonly SessionEntry[]): SessionEntry[] {
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  const branch: SessionEntry[] = [];
  let current = entries.at(-1);
  while (current) {
    branch.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return branch.reverse();
}

/** Directory holding fork transcripts for a session file: `<name>.episodes` next to it. */
export function archiveDirOf(sessionPath: string): string {
  return sessionPath.replace(/\.jsonl$/, '').concat('.episodes');
}

/** Fork archives by handle, from `<session>.episodes/fk-*.json`; empty when there are none. */
export function readForkArchives(sessionPath: string): Map<string, ForkArchive> {
  const dir = archiveDirOf(sessionPath);
  const archives = new Map<string, ForkArchive>();
  if (!existsSync(dir)) return archives;
  for (const name of readdirSync(dir).sort()) {
    if (!/^fk-[0-9a-f]+\.json$/.test(name)) continue;
    const archive = JSON.parse(readFileSync(join(dir, name), 'utf8')) as ForkArchive;
    archives.set(archive.handle, archive);
  }
  return archives;
}

// ---------------------------------------------------------------------------
// Accessors over a branch
// ---------------------------------------------------------------------------

export interface Request {
  /** 0-based position among the assistant messages on the branch. */
  index: number;
  /** Position of the entry on the branch. */
  position: number;
  entry: SessionMessageEntry;
  message: AssistantMessage;
}

export interface ToolCallRef {
  requestIndex: number;
  position: number;
  entry: SessionMessageEntry;
  call: ToolCall;
  /** Other tool calls in the same assistant message. */
  siblings: ToolCall[];
}

export interface ToolResultRef {
  /** Index of the request that made the call, or -1 when the call is not on the branch. */
  requestIndex: number;
  position: number;
  entry: SessionMessageEntry;
  message: ToolResultMessage;
  call?: ToolCall;
}

/** Main-thread requests: assistant messages on the branch, in order. */
export function requests(branch: readonly SessionEntry[]): Request[] {
  const found: Request[] = [];
  branch.forEach((entry, position) => {
    if (entry.type === 'message' && entry.message.role === 'assistant') {
      found.push({ index: found.length, position, entry, message: entry.message });
    }
  });
  return found;
}

export function toolCalls(branch: readonly SessionEntry[], name?: string): ToolCallRef[] {
  const found: ToolCallRef[] = [];
  for (const request of requests(branch)) {
    const calls = request.message.content.filter(
      (block): block is ToolCall => block.type === 'toolCall'
    );
    for (const call of calls) {
      if (name !== undefined && call.name !== name) continue;
      found.push({
        requestIndex: request.index,
        position: request.position,
        entry: request.entry,
        call,
        siblings: calls.filter((other) => other !== call)
      });
    }
  }
  return found;
}

export function toolResults(branch: readonly SessionEntry[], toolName?: string): ToolResultRef[] {
  const callsById = new Map<string, ToolCallRef>();
  for (const ref of toolCalls(branch)) callsById.set(ref.call.id, ref);
  const found: ToolResultRef[] = [];
  branch.forEach((entry, position) => {
    if (entry.type !== 'message' || entry.message.role !== 'toolResult') return;
    const message = entry.message;
    if (toolName !== undefined && message.toolName !== toolName) return;
    const caller = callsById.get(message.toolCallId);
    const ref: ToolResultRef = {
      requestIndex: caller?.requestIndex ?? -1,
      position,
      entry,
      message
    };
    if (caller) ref.call = caller.call;
    found.push(ref);
  });
  return found;
}

export function compactions(branch: readonly SessionEntry[]): CompactionEntry[] {
  return branch.filter((entry): entry is CompactionEntry => entry.type === 'compaction');
}

export function contextEdits(branch: readonly SessionEntry[]): ContextEditEntry[] {
  return branch.filter((entry): entry is ContextEditEntry => entry.type === 'context_edit');
}

/** Requests pi made outside the model's turns (cache warming is `kind: "cache_warm"`). */
export function usageEntries(branch: readonly SessionEntry[], kind?: string): UsageEntry[] {
  return branch.filter(
    (entry): entry is UsageEntry =>
      entry.type === 'usage' && (kind === undefined || entry.kind === kind)
  );
}

export function customMessages(
  branch: readonly SessionEntry[],
  customType?: string
): CustomMessageEntry[] {
  return branch.filter(
    (entry): entry is CustomMessageEntry =>
      entry.type === 'custom_message' &&
      (customType === undefined || entry.customType === customType)
  );
}

export function customEntries(branch: readonly SessionEntry[], customType?: string): CustomEntry[] {
  return branch.filter(
    (entry): entry is CustomEntry =>
      entry.type === 'custom' && (customType === undefined || entry.customType === customType)
  );
}

/** Handles of folds whose context edits landed. */
export function appliedFoldHandles(branch: readonly SessionEntry[]): Set<string> {
  const handles = new Set<string>();
  for (const entry of customEntries(branch, FOLD_APPLIED_TYPE)) {
    const handle = (entry.data as { handle?: unknown } | undefined)?.handle;
    if (typeof handle === 'string') handles.add(handle);
  }
  return handles;
}

export function systemMessages(branch: readonly SessionEntry[]): SystemMessage[] {
  return branch.flatMap((entry) =>
    entry.type === 'message' && entry.message.role === 'system' ? [entry.message] : []
  );
}

/** Text of a message's content blocks, without a trailing `[tN]` stamp block. */
export function textOf(
  content: string | readonly { type: string; text?: string }[],
  options: { keepStamp?: boolean } = {}
): string {
  if (typeof content === 'string') return content;
  const last = content.at(-1);
  const blocks =
    !options.keepStamp && last && last.type === 'text' && isStampText(last.text ?? '')
      ? content.slice(0, -1)
      : content;
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

const STAMP_BLOCK = /^\[t(\d+)\]$/;

function isStampText(text: string): boolean {
  return STAMP_BLOCK.test(text);
}

/** The `[tN]` stamp pi-episodes appends to user messages and tool results. */
export function stampOf(message: AgentMessage): number | undefined {
  if (message.role !== 'user' && message.role !== 'toolResult') return undefined;
  if (!Array.isArray(message.content)) return undefined;
  const last = message.content.at(-1);
  if (last?.type !== 'text') return undefined;
  const match = STAMP_BLOCK.exec(last.text);
  return match ? Number(match[1]) : undefined;
}

/** Stamps by entry id for every stamped message on the branch. */
export function stamps(branch: readonly SessionEntry[]): Map<string, number> {
  const found = new Map<string, number>();
  for (const entry of branch) {
    if (entry.type !== 'message') continue;
    const stamp = stampOf(entry.message);
    if (stamp !== undefined) found.set(entry.id, stamp);
  }
  return found;
}

/** Parses `t12`, `[t12]` or `12` as the model writes `since`. */
export function parseStamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^\[?t?(\d+)\]?$/i.exec(value.trim());
  return match ? Number(match[1]) : undefined;
}

// ---------------------------------------------------------------------------
// Prompt id (DESIGN 2)
// ---------------------------------------------------------------------------

/** pi renders the `episodes` section as `<episodes>\n...\n</episodes>`; the hash covers the inner text. */
const EPISODES_SECTION_RE = /<episodes>\n([\s\S]*?)\n<\/episodes>/;

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * First 12 hex characters of `sha256(EPISODES_SECTION + "\n" + descriptions joined by "\n")`.
 * `systemPrompt` is the rendered prompt (the JSONL system message through
 * `getSystemMessageText`, or `session.systemPrompt` during a run); the `<episodes>` section is
 * cut out of it, so the hashed text is the extension's constant. Undefined when the prompt has
 * no episodes section.
 */
export function promptIdFrom(
  systemPrompt: string,
  toolDescriptions: readonly string[]
): string | undefined {
  const match = EPISODES_SECTION_RE.exec(systemPrompt);
  if (match === null || toolDescriptions.length !== EPISODE_TOOLS.length) return undefined;
  return sha256(`${match[1]}\n${toolDescriptions.join('\n')}`).slice(0, 12);
}

/** The fold, recall, ask and fork descriptions in hash order, or undefined when one is missing. */
export function episodesToolDescriptions(tools: readonly Tool[]): string[] | undefined {
  const descriptions: string[] = [];
  for (const name of EPISODE_TOOLS) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined) return undefined;
    descriptions.push(tool.description);
  }
  return descriptions;
}

/** Prompt id of a stored session's leading system message (sections plus `toolsAdded`). */
export function promptIdFromSystemMessage(message: SystemMessage): string | undefined {
  const descriptions = episodesToolDescriptions(message.toolsAdded ?? []);
  return descriptions === undefined
    ? undefined
    : promptIdFrom(getSystemMessageText(message), descriptions);
}

/**
 * Prompt id from the first system message on the active branch; undefined for a plain pi
 * session. Later system messages that patch the section are not followed, so a mid-session
 * change shows up as an audit mismatch.
 */
export function promptIdFromSession(entries: readonly SessionEntry[]): string | undefined {
  const system = systemMessages(activeBranch(entries))[0];
  return system === undefined ? undefined : promptIdFromSystemMessage(system);
}
