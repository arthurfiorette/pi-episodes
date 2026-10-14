import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ToolCall } from '@earendil-works/pi-ai';
import { BENCH_DIR, DEFAULT_AUTH_PATH } from './config.js';
import {
  ConfigError,
  readJsonFile,
  readObject,
  readOptional,
  readString,
  readStringArray,
  rejectUnknownKeys
} from './fields.js';
import {
  activeBranch,
  appliedFoldHandles,
  EPISODE_TOOLS,
  FOLD_TOOL,
  FORK_TOOL,
  type FoldDetails,
  type ForkArchive,
  isFoldDetails,
  isForkDetails,
  isRecallDetails,
  RECALL_TOOL,
  REMINDER_TYPE,
  type Request,
  readForkArchives,
  readSession,
  requests as requestsOf,
  type SessionEntry,
  stampOf,
  textOf,
  toolResults
} from './jsonl.js';
import { computeMetrics, STALENESS_LINE, stepIdsByRequest } from './metrics.js';
import { createModelRuntime, resolveModel } from './session.js';
import type {
  ChecksJson,
  JudgeConfig,
  JudgeExtract,
  JudgeExtractBlock,
  JudgeItemVerdict,
  JudgeJson,
  JudgeLabel,
  JudgeVerdict,
  KappaCell,
  MetricsJson,
  NullCheckResult,
  RubricId,
  RubricItem,
  RubricSummary,
  Scenario,
  Step,
  StepResult,
  TrialRecord
} from './types.js';

export const DEFAULT_JUDGE_CONFIG = join(BENCH_DIR, 'judge', 'judge.json');
export const DEFAULT_LABELS_PATH = join(BENCH_DIR, 'judge', 'labels.jsonl');

/** DESIGN 9, judge prompt shape. The second line names the JSON keys the first line refers to. */
export const JUDGE_SYSTEM_PROMPT =
  'You grade one property of a coding agent\'s transcript. Answer with the JSON object only.\nThe object is {"answer": "PASS" | "FAIL", "evidence": "<verbatim quote from the input>", "reason": "<one line>"}.';
export const JUDGE_PROMPT_TAIL =
  'Quote the evidence exactly; if the property cannot be decided from the input, answer FAIL and say why.';

/** Turns (assistant messages) after a fold or around a trigger that a1, a4, c2, c3 and c6 look at. */
export const WINDOW = 3;
/** Head and tail kept of a tool result in a judge extract (DESIGN 9). */
export const RESULT_CUT = 2000;
const TURNS_AFTER_PROBE = 5;
const TURNS_AFTER_TRIGGER_JUDGE = 5;

// ---------------------------------------------------------------------------
// Note sections, as src/fold.ts renders and parses them
// ---------------------------------------------------------------------------

/**
 * Same regex as `SECTION` in `src/fold.ts`: a line that starts a section of the note template
 * (Changed, Learned, Decided, Rejected, Handled, Open), with an optional bullet or emphasis.
 */
const SECTION = /^\s*[-*]?\s*\**\s*(changed|learned|decided|rejected|handled|open)\b[^:]*:\**\s*/i;
const NOTHING_OPEN = /^(none|nothing|n\/a|-)\.?$/i;

export type NoteSection = 'changed' | 'learned' | 'decided' | 'rejected' | 'handled' | 'open';

/**
 * The text of one section: from its header line to the next section or blank line, the way
 * `openItems` in `src/fold.ts` reads the Open section. Undefined when absent or "none".
 */
export function noteSection(note: string, name: NoteSection): string | undefined {
  const lines = note.split('\n');
  const start = lines.findIndex((line) => SECTION.exec(line)?.[1]?.toLowerCase() === name);
  if (start < 0) return undefined;
  const items = [lines[start]!.replace(SECTION, '').trim()];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || SECTION.test(line)) break;
    items.push(line.trim());
  }
  const text = items.filter(Boolean).join(' ').trim();
  return text && !NOTHING_OPEN.test(text) ? text : undefined;
}

export function noteHeadline(note: string): string {
  const line = note.split('\n').find((text) => text.trim()) ?? '';
  return line.replace(/^[\s#*-]+/, '').trim();
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

const ERROR_LINE = /\b(error|exception|failed|failing|fatal|cannot|not found|ENOENT|TS\d{4})\b/i;
const STAMP_RE = /\[t\d+\]/g;
const HANDLE_RE = /\b(ep|fk|cp)-[0-9a-f]{8}\b/g;
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'into',
  'npx',
  'npm',
  'run',
  'node',
  'echo',
  'cat',
  'git',
  'tsx',
  'test',
  'tests',
  'src',
  'error',
  'errors',
  'file',
  'files',
  'pass',
  'fail',
  'true',
  'false',
  'null',
  'print',
  'printf'
]);

/**
 * Identifier-like tokens: words, paths, symbols, error codes, lowercased; paths also yield
 * their basename and the basename without extension. Short and generic words are dropped.
 */
export function tokens(text: string): Set<string> {
  const found = new Set<string>();
  for (const raw of text.toLowerCase().split(/[\s"'`(){}[\],;:=<>|&!?*#]+/)) {
    const word = raw.replace(/^[./-]+|[./-]+$/g, '');
    if (word.length < 3 || STOP_WORDS.has(word) || /^\d+$/.test(word)) continue;
    found.add(word);
    if (word.includes('/') || word.includes('.')) {
      const base = word.split('/').at(-1) ?? word;
      if (base.length >= 3 && !STOP_WORDS.has(base)) found.add(base);
      const stem = base.replace(/\.[a-z0-9]+$/, '');
      if (stem.length >= 3 && !STOP_WORDS.has(stem)) found.add(stem);
    }
  }
  return found;
}

function shared(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  return [...a].filter((token) => b.has(token));
}

const MARKER_STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'this', 'that']);

/** Words of a trailing marker or trap name that an Open section must mention; only filler is dropped. */
export function markerTokens(text: string): string[] {
  const found = new Set<string>();
  for (const raw of text.toLowerCase().split(/[\s"'`(){}[\],;:=<>|&!?*#]+/)) {
    const word = raw.replace(/^[./-]+|[./-]+$/g, '');
    if (word.length >= 3 && !MARKER_STOP_WORDS.has(word)) found.add(word);
  }
  return [...found];
}

/** Error-ish lines of a tool result, whitespace-normalized, long enough to be distinctive. */
export function errorLines(text: string): string[] {
  return text
    .replace(STAMP_RE, '')
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line.length >= 12 && ERROR_LINE.test(line));
}

/** Head and tail of a long text with a marker that says how much was cut. */
export function cut(text: string, keep = RESULT_CUT): string {
  if (text.length <= keep * 2) return text;
  const removed = text.length - keep * 2;
  return `${text.slice(0, keep)}\n[... ${removed} characters cut ...]\n${text.slice(-keep)}`;
}

function messageText(message: AgentMessage): string {
  switch (message.role) {
    case 'user':
    case 'toolResult':
    case 'custom':
      return textOf(message.content);
    case 'assistant':
      return message.content
        .map((block) => {
          if (block.type === 'text') return block.text;
          if (block.type === 'toolCall') return `${block.name}(${JSON.stringify(block.arguments)})`;
          return '';
        })
        .filter(Boolean)
        .join('\n');
    case 'bashExecution':
      return `$ ${message.command}\n${message.output}`;
    case 'branchSummary':
    case 'compactionSummary':
      return message.summary;
    default:
      return '';
  }
}

function argString(call: ToolCall, key: string): string | undefined {
  const value = call.arguments[key];
  return typeof value === 'string' ? value : undefined;
}

// ---------------------------------------------------------------------------
// Trial input
// ---------------------------------------------------------------------------

export interface TrialInput {
  /** Trial directory name, for messages. */
  id: string;
  /** Active branch of the session, oldest first. */
  branch: SessionEntry[];
  /** The agent's cwd (session header); fold `files` are absolute paths under it. */
  cwd: string;
  scenario: Scenario;
  trialRecord: Pick<TrialRecord, 'steps' | 'condition'> & Partial<TrialRecord>;
  checks?: ChecksJson;
  metrics?: MetricsJson;
  archives: ReadonlyMap<string, ForkArchive>;
  /**
   * Content of a file in the git tree a fold recorded as `treeAfter`; undefined when the
   * objects are gone (pi-episodes keeps them in a temp store that the trial teardown removes),
   * in which case d1 falls back to the fold's `files` list and says so.
   */
  readTreeFile?: (tree: string, path: string) => string | undefined;
}

/** Reads `session.jsonl`, `trial.json`, `checks.json` and `metrics.json` (computed when absent) of a trial dir. */
export function loadTrialInput(trialDir: string, scenario: Scenario): TrialInput {
  const sessionPath = join(trialDir, 'session.jsonl');
  const trialPath = join(trialDir, 'trial.json');
  if (!existsSync(sessionPath)) throw new Error(`${trialDir}: no session.jsonl`);
  if (!existsSync(trialPath)) throw new Error(`${trialDir}: no trial.json`);
  const trialRecord = JSON.parse(readFileSync(trialPath, 'utf8')) as TrialRecord;
  const session = readSession(sessionPath);
  const checksPath = join(trialDir, 'checks.json');
  const checks = existsSync(checksPath)
    ? (JSON.parse(readFileSync(checksPath, 'utf8')) as ChecksJson)
    : undefined;
  const metricsPath = join(trialDir, 'metrics.json');
  const metrics = existsSync(metricsPath)
    ? (JSON.parse(readFileSync(metricsPath, 'utf8')) as MetricsJson)
    : computeMetrics(checks ? { sessionPath, trialRecord, checks } : { sessionPath, trialRecord });
  const input: TrialInput = {
    id: basename(trialDir),
    branch: activeBranch(session.entries),
    cwd: session.header?.cwd ?? '',
    scenario,
    trialRecord,
    metrics,
    archives: readForkArchives(sessionPath)
  };
  if (checks) input.checks = checks;
  return input;
}

// ---------------------------------------------------------------------------
// Steps, folds, archives, actions, triggers
// ---------------------------------------------------------------------------

export interface StepRange {
  id: string;
  kind: StepResult['kind'];
  /** Scenario step; absent when the record names a step the scenario does not have. */
  step?: Step;
  firstRequest: number;
  lastRequest: number;
  /** Branch position of the user prompt that started the step. */
  userPosition: number;
  userStamp?: number;
  /** First tool result stamp of the step, the `since` the prompt asks for; the user stamp when the step had none. */
  firstStamp?: number;
  lastStamp?: number;
  stamps: number[];
}

interface Archive {
  kind: 'fold' | 'fork';
  handle: string;
  requestIndex: number;
  /** Branch position of the fold or fork result. */
  position: number;
  headline: string;
  open?: string;
  /** Relative to the agent's cwd. */
  files: string[];
  commands: Set<string>;
  errors: Set<string>;
}

export interface Fold extends Archive {
  kind: 'fold';
  details: FoldDetails;
  note: string;
  since: number;
  until?: number;
  /** Entries of the archived span, from `firstEntryId` to `lastEntryId`. */
  span: SessionEntry[];
  /** The step whose stamps hold `since`. */
  step?: StepRange;
  /** The step the fold call sits in. */
  callStep?: StepRange;
}

type ActionKind = 'read' | 'edit' | 'write' | 'bash' | 'recall' | 'ask';

interface Action {
  kind: ActionKind;
  requestIndex: number;
  call: ToolCall;
  /** Absolute path for read, edit, write. */
  path?: string;
  /** Normalized command for bash. */
  command?: string;
  /** Query or question plus handle, for recall and ask. */
  query?: string;
  handle?: string;
  /** Result text, when the result is on the branch. */
  result?: string;
  /** Branch position of the result. */
  resultPosition?: number;
  isError: boolean;
}

export type TriggerKind = 'edit' | 'error' | 'command' | 'user';

export interface Trigger {
  id: string;
  kind: TriggerKind;
  requestIndex: number;
  /** The archive the trigger points at. */
  handle: string;
  text: string;
  tokens: Set<string>;
}

export interface TrialAnalysis {
  input: TrialInput;
  requests: Request[];
  steps: StepRange[];
  folds: Fold[];
  archives: Archive[];
  actions: Action[];
  triggers: Trigger[];
  items: RubricItem[];
  extracts: JudgeExtract[];
}

const cwdRoots = new Map<string, string[]>();

/**
 * Roots a trial path may be written under: the session cwd, its realpath, and on macOS the
 * `/private` form (the header stores `/var/...` while pi-episodes resolves to `/private/var/...`).
 */
function rootsOf(cwd: string): string[] {
  let roots = cwdRoots.get(cwd);
  if (roots) return roots;
  roots = [cwd];
  if (cwd.startsWith('/var/') || cwd.startsWith('/tmp/')) roots.push(`/private${cwd}`);
  try {
    roots.push(realpathSync(cwd));
  } catch {
    // The trial directory is gone after teardown; the textual roots still match.
  }
  cwdRoots.set(cwd, [...new Set(roots)]);
  return cwdRoots.get(cwd)!;
}

/** A path as the agent would write it relative to its cwd; absolute paths outside it stay absolute. */
export function relPath(cwd: string, path: string): string {
  if (!isAbsolute(path)) return normalize(path);
  for (const root of rootsOf(cwd)) {
    const rel = relative(root, path);
    if (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
  }
  return path;
}

export function stepRanges(input: TrialInput, requests: Request[]): StepRange[] {
  const ids = stepIdsByRequest(input.trialRecord.steps, requests.length);
  const ranges: StepRange[] = [];
  for (const result of input.trialRecord.steps) {
    const indices = ids.flatMap((id, index) => (id === result.id ? [index] : []));
    if (indices.length === 0) continue;
    const firstRequest = indices[0]!;
    const lastRequest = indices.at(-1)!;
    let userPosition = requests[firstRequest]!.position;
    while (userPosition > 0) {
      const entry = input.branch[userPosition]!;
      if (entry.type === 'message' && entry.message.role === 'user') break;
      userPosition--;
    }
    const range: StepRange = {
      id: result.id,
      kind: result.kind,
      firstRequest,
      lastRequest,
      userPosition,
      stamps: []
    };
    const step = input.scenario.steps.find((candidate) => candidate.id === result.id);
    if (step) range.step = step;
    ranges.push(range);
  }
  ranges.forEach((range, index) => {
    const end = ranges[index + 1]?.userPosition ?? input.branch.length;
    for (const entry of input.branch.slice(range.userPosition, end)) {
      if (entry.type !== 'message') continue;
      const stamp = stampOf(entry.message);
      if (stamp !== undefined) range.stamps.push(stamp);
    }
    const user = input.branch[range.userPosition];
    const userStamp = user?.type === 'message' ? stampOf(user.message) : undefined;
    if (userStamp !== undefined) range.userStamp = userStamp;
    // The `since` the prompt asks for: the first tool result of the work, which is neither the
    // prompt nor the note of a fold that opened the request (a fold cannot reach behind a note).
    const first = input.branch.slice(range.userPosition, end).flatMap((entry) => {
      if (entry.type !== 'message' || entry.message.role !== 'toolResult') return [];
      if (entry.message.toolName === FOLD_TOOL && !entry.message.isError) return [];
      const stamp = stampOf(entry.message);
      return stamp === undefined ? [] : [stamp];
    })[0];
    const firstStamp = first ?? userStamp ?? range.stamps[0];
    if (firstStamp !== undefined) range.firstStamp = firstStamp;
    const last = range.stamps.at(-1);
    if (last !== undefined) range.lastStamp = last;
  });
  return ranges;
}

function stepOfStamp(steps: readonly StepRange[], stamp: number): StepRange | undefined {
  return steps.find(
    (step) => step.stamps.length > 0 && stamp >= step.stamps[0]! && stamp <= step.lastStamp!
  );
}

function stepOfRequest(steps: readonly StepRange[], index: number): StepRange | undefined {
  return steps.find((step) => index >= step.firstRequest && index <= step.lastRequest);
}

function actionsOf(input: TrialInput, requests: Request[]): Action[] {
  const results = new Map<string, { text: string; position: number; isError: boolean }>();
  for (const ref of toolResults(input.branch)) {
    results.set(ref.message.toolCallId, {
      text: textOf(ref.message.content),
      position: ref.position,
      isError: ref.message.isError
    });
  }
  const actions: Action[] = [];
  for (const request of requests) {
    for (const block of request.message.content) {
      if (block.type !== 'toolCall') continue;
      const kind = block.name as ActionKind;
      if (!['read', 'edit', 'write', 'bash', 'recall', 'ask'].includes(kind)) continue;
      const result = results.get(block.id);
      const action: Action = {
        kind,
        requestIndex: request.index,
        call: block,
        isError: result?.isError ?? false
      };
      const path = argString(block, 'path');
      if (path !== undefined && (kind === 'read' || kind === 'edit' || kind === 'write')) {
        action.path = relPath(input.cwd, path);
      }
      const command = argString(block, 'command');
      if (command !== undefined && kind === 'bash') action.command = normalizeCommand(command);
      if (kind === 'recall') {
        action.query = argString(block, 'query') ?? '';
        const handle = argString(block, 'handle');
        if (handle !== undefined) action.handle = handle;
      }
      if (kind === 'ask') {
        action.query = argString(block, 'question') ?? '';
        action.handle = argString(block, 'handle') ?? '';
      }
      if (result) {
        action.result = result.text;
        action.resultPosition = result.position;
      }
      actions.push(action);
    }
  }
  return actions;
}

function spanOf(branch: readonly SessionEntry[], details: FoldDetails): SessionEntry[] {
  const first = branch.findIndex((entry) => entry.id === details.firstEntryId);
  const last = branch.findIndex((entry) => entry.id === details.lastEntryId);
  if (first < 0 || last < 0 || last < first) return [];
  return branch.slice(first, last + 1);
}

function archiveOf(
  cwd: string,
  kind: 'fold' | 'fork',
  handle: string,
  requestIndex: number,
  position: number,
  headline: string,
  files: readonly string[],
  messages: readonly AgentMessage[]
): Archive {
  const commands = new Set<string>();
  const errors = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type !== 'toolCall' || block.name !== 'bash') continue;
        const command = argString(block, 'command');
        if (command !== undefined) commands.add(normalizeCommand(command));
      }
    } else if (
      message.role === 'toolResult' &&
      !EPISODE_TOOLS.includes(message.toolName as never)
    ) {
      for (const line of errorLines(textOf(message.content))) errors.add(line);
    }
  }
  return {
    kind,
    handle,
    requestIndex,
    position,
    headline,
    files: files.map((file) => relPath(cwd, file)),
    commands,
    errors
  };
}

/** Folds that changed the context: a result whose edits never landed (metrics.ts, `rejectedFolds`) is not one. */
export function foldsOf(input: TrialInput, steps: readonly StepRange[]): Fold[] {
  const folds: Fold[] = [];
  const applied = appliedFoldHandles(input.branch);
  for (const ref of toolResults(input.branch, FOLD_TOOL)) {
    if (ref.message.isError || !isFoldDetails(ref.message.details)) continue;
    const details = ref.message.details;
    if (!applied.has(details.handle)) continue;
    const since = Number(/\d+/.exec(details.since)?.[0] ?? Number.NaN);
    const span = spanOf(input.branch, details);
    const messages = span.flatMap((entry) => (entry.type === 'message' ? [entry.message] : []));
    const note = (ref.call && argString(ref.call, 'note')) ?? '';
    const archive = archiveOf(
      input.cwd,
      'fold',
      details.handle,
      ref.requestIndex,
      ref.position,
      details.headline,
      details.files,
      messages
    );
    const fold: Fold = { ...archive, kind: 'fold', details, note, since, span };
    const open = details.open ?? noteSection(note, 'open');
    if (open !== undefined) fold.open = open;
    const until = details.until === undefined ? undefined : Number(/\d+/.exec(details.until)?.[0]);
    if (until !== undefined && !Number.isNaN(until)) fold.until = until;
    const step = Number.isNaN(since) ? undefined : stepOfStamp(steps, since);
    if (step) fold.step = step;
    const callStep = stepOfRequest(steps, ref.requestIndex);
    if (callStep) fold.callStep = callStep;
    folds.push(fold);
  }
  return folds;
}

function forkArchivesOf(input: TrialInput): Archive[] {
  const forks: Archive[] = [];
  for (const ref of toolResults(input.branch, FORK_TOOL)) {
    if (ref.message.isError || !isForkDetails(ref.message.details)) continue;
    const details = ref.message.details;
    const transcript = input.archives.get(details.handle);
    const archive = archiveOf(
      input.cwd,
      'fork',
      details.handle,
      ref.requestIndex,
      ref.position,
      details.headline,
      details.files,
      transcript?.messages ?? []
    );
    if (details.open !== undefined) archive.open = details.open;
    forks.push(archive);
  }
  return forks;
}

/** The text names the path as a whole token, not as the tail of a longer name. */
function namesPath(text: string, path: string): boolean {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w/.-])${escaped}($|[^\\w-])`).test(text);
}

function triggersOf(
  input: TrialInput,
  requests: Request[],
  archives: readonly Archive[],
  actions: readonly Action[]
): Trigger[] {
  const triggers: Trigger[] = [];
  const seen = new Set<string>();
  const add = (kind: TriggerKind, requestIndex: number, handle: string, text: string) => {
    const id = `${kind}@r${requestIndex}:${handle}:${text}`;
    if (seen.has(id)) return;
    seen.add(id);
    triggers.push({ id, kind, requestIndex, handle, text, tokens: tokens(text) });
  };

  for (const action of actions) {
    const after = archives.filter((archive) => archive.requestIndex < action.requestIndex);
    if ((action.kind === 'edit' || action.kind === 'write') && action.path !== undefined) {
      for (const archive of after) {
        if (archive.files.includes(action.path)) {
          add('edit', action.requestIndex, archive.handle, action.path);
        }
      }
    }
    if (action.kind === 'bash' && action.command !== undefined) {
      for (const archive of after) {
        if (archive.commands.has(action.command)) {
          add('command', action.requestIndex, archive.handle, action.command);
        }
      }
    }
    // Recall, ask and fold results quote the archive; an error line there is not a recurrence.
    if (
      action.result !== undefined &&
      !['recall', 'ask'].includes(action.kind) &&
      !action.isError
    ) {
      const lines = errorLines(action.result);
      for (const archive of after) {
        for (const line of lines) {
          if (archive.errors.has(line)) add('error', action.requestIndex, archive.handle, line);
        }
      }
    }
  }

  input.branch.forEach((entry, position) => {
    if (entry.type !== 'message' || entry.message.role !== 'user') return;
    const next = requests.find((request) => request.position > position);
    if (!next) return;
    const text = textOf(entry.message.content);
    const handles = new Set(text.match(HANDLE_RE) ?? []);
    for (const archive of archives) {
      if (archive.position >= position) continue;
      if (handles.has(archive.handle)) add('user', next.index, archive.handle, archive.handle);
      for (const file of archive.files) {
        if (file && namesPath(text, file)) add('user', next.index, archive.handle, file);
      }
    }
  });

  return triggers.sort((a, b) => a.requestIndex - b.requestIndex);
}

// ---------------------------------------------------------------------------
// Rendering for judge extracts
// ---------------------------------------------------------------------------

function renderEntry(
  entry: SessionEntry,
  requestIndexOf: (entry: SessionEntry) => number | undefined
): string | undefined {
  if (entry.type === 'custom_message') {
    return `[${entry.customType}] ${textOf(entry.content)}`;
  }
  if (entry.type !== 'message') return undefined;
  const message = entry.message;
  const stamp = stampOf(message);
  const label = stamp !== undefined ? `t${stamp}` : `r${requestIndexOf(entry) ?? '?'}`;
  switch (message.role) {
    case 'user':
      return `[${label}] user: ${textOf(message.content)}`;
    case 'assistant':
      return `[${label}] assistant: ${messageText(message)}`;
    case 'toolResult':
      return `[${label}] ${message.toolName}${message.isError ? ' (error)' : ''}: ${cut(textOf(message.content))}`;
    default:
      return undefined;
  }
}

function renderer(requests: Request[]): (entry: SessionEntry) => number | undefined {
  const byId = new Map(requests.map((request) => [request.entry.id, request.index]));
  return (entry) => byId.get(entry.id);
}

/** `[tNN] role: text` lines for a slice of the branch. */
export function renderEntries(entries: readonly SessionEntry[], requests: Request[]): string {
  const index = renderer(requests);
  return entries.flatMap((entry) => renderEntry(entry, index) ?? []).join('\n');
}

/** The assistant turns `from` to `from + count - 1` with the results that followed each. */
export function renderTurns(
  branch: readonly SessionEntry[],
  requests: Request[],
  from: number,
  count: number
): string {
  const first = requests[from];
  if (!first) return '(no turns)';
  const lastRequest = requests[Math.min(from + count, requests.length) - 1]!;
  const next = requests[from + count];
  const end = next ? next.position : branch.length;
  const slice = branch.slice(first.position, Math.max(end, lastRequest.position + 1));
  // The next request's prompt and reminders sit between its predecessor and it; not these turns.
  while (slice.length > 0) {
    const last = slice.at(-1)!;
    const prompt = last.type === 'message' && last.message.role === 'user';
    if (!prompt && last.type !== 'custom_message') break;
    slice.pop();
  }
  return renderEntries(slice, requests);
}

function blocksOfNote(fold: Fold): JudgeExtractBlock[] {
  return [{ name: 'note', text: fold.note }];
}

function scriptFields(step: Step | undefined): JudgeExtractBlock[] {
  if (!step) return [];
  const fields = {
    id: step.id,
    kind: step.kind,
    ...(step.endEvent === undefined ? {} : { endEvent: step.endEvent }),
    ...(step.mustCarry === undefined ? {} : { mustCarry: step.mustCarry }),
    ...(step.rejected === undefined ? {} : { rejected: step.rejected }),
    ...(step.trailing === undefined ? {} : { trailing: step.trailing }),
    ...(step.trap === undefined ? {} : { trap: step.trap })
  };
  return [{ name: 'step', text: JSON.stringify(fields, null, 2) }];
}

/** The common fold extract of DESIGN 9: note, span, 3 messages before `since`, 3 turns after, siblings, step fields. */
export function foldExtract(analysis: TrialAnalysis, fold: Fold): JudgeExtractBlock[] {
  const { input, requests, folds } = analysis;
  const spanStart = fold.span[0] ? input.branch.indexOf(fold.span[0]) : -1;
  const before =
    spanStart > 0
      ? input.branch
          .slice(0, spanStart)
          .filter((entry) => entry.type === 'message')
          .slice(-3)
      : [];
  const siblings = folds.filter((other) => other !== fold).map((other) => `- ${other.headline}`);
  return [
    ...blocksOfNote(fold),
    { name: 'span', text: renderEntries(fold.span, requests) },
    { name: 'before', text: renderEntries(before, requests) },
    { name: 'after', text: renderTurns(input.branch, requests, fold.requestIndex + 1, WINDOW) },
    { name: 'siblings', text: siblings.join('\n') || '(none)' },
    ...scriptFields(fold.step?.step)
  ];
}

// ---------------------------------------------------------------------------
// Script rubrics
// ---------------------------------------------------------------------------

function item(
  rubric: RubricId,
  subject: string,
  pass: RubricItem['pass'],
  evidence: string,
  requestIndex: number,
  value?: number
): RubricItem {
  const built: RubricItem = { rubric, subject, pass, evidence, requestIndex };
  if (value !== undefined) built.value = value;
  return built;
}

function describeStep(step: StepRange): string {
  return `${step.id} (r${step.firstRequest}-r${step.lastRequest}, user t${step.userStamp ?? '?'}, first result t${step.firstStamp ?? '?'}, last t${step.lastStamp ?? '?'})`;
}

function boundaryItems(analysis: TrialAnalysis): RubricItem[] {
  const items: RubricItem[] = [];
  for (const fold of analysis.folds) {
    const step = fold.step;
    if (!step) {
      const why = `since t${fold.since} is in no step of the trial record`;
      items.push(item('a1', fold.handle, false, why, fold.requestIndex));
      items.push(item('a2', fold.handle, false, why, fold.requestIndex));
      continue;
    }
    const lateness = fold.requestIndex - step.lastRequest;
    const midStep = lateness <= 0;
    items.push(
      item(
        'a1',
        fold.handle,
        lateness >= 1 && lateness <= WINDOW,
        `fold at r${fold.requestIndex}, ${midStep ? 'inside' : `${lateness} turn(s) after the end of`} step ${describeStep(step)}`,
        fold.requestIndex,
        lateness
      )
    );
    const first = step.firstStamp ?? step.userStamp ?? fold.since;
    const error = fold.since - first;
    items.push(
      item(
        'a2',
        fold.handle,
        Math.abs(error) <= 2,
        `since t${fold.since}, step ${step.id} first result t${first}: error ${error >= 0 ? '+' : ''}${error} (positive folds too little, negative reaches back)`,
        fold.requestIndex,
        error
      )
    );
    if (step.kind === 'goal') {
      items.push(
        item(
          'a3',
          fold.handle,
          !midStep,
          midStep
            ? `fold at r${fold.requestIndex} before the end event of goal step ${step.id} (last request r${step.lastRequest})`
            : `fold at r${fold.requestIndex} after the end of goal step ${step.id} (r${step.lastRequest})`,
          fold.requestIndex
        )
      );
    }
  }
  return items;
}

function spanNeededItems(analysis: TrialAnalysis): RubricItem[] {
  const items: RubricItem[] = [];
  for (const fold of analysis.folds) {
    const window = analysis.actions.filter(
      (action) =>
        action.requestIndex > fold.requestIndex && action.requestIndex <= fold.requestIndex + WINDOW
    );
    let recallAt: number | undefined;
    let offending: string | undefined;
    for (const action of window) {
      if (action.kind === 'recall' || action.kind === 'ask') {
        recallAt ??= action.requestIndex;
        continue;
      }
      if (recallAt !== undefined) continue;
      if (action.kind === 'read' && action.path !== undefined && fold.files.includes(action.path)) {
        offending = `read ${action.path} at r${action.requestIndex} (in the fold's files)`;
        break;
      }
      if (
        action.kind === 'bash' &&
        action.command !== undefined &&
        fold.commands.has(action.command)
      ) {
        offending = `reran ${JSON.stringify(action.command)} at r${action.requestIndex} (run inside the span)`;
        break;
      }
    }
    items.push(
      item(
        'a4',
        fold.handle,
        offending === undefined,
        offending ??
          `no read of a folded file or repeated span command in r${fold.requestIndex + 1}-r${fold.requestIndex + WINDOW} without a recall`,
        fold.requestIndex
      )
    );
  }
  return items;
}

function stampNumber(label: string): number | undefined {
  const match = /\d+/.exec(label);
  return match ? Number(match[0]) : undefined;
}

function noteItems(analysis: TrialAnalysis): RubricItem[] {
  const items: RubricItem[] = [];
  for (const fold of analysis.folds) {
    const handled = noteSection(fold.note, 'handled') ?? '';
    // The prompt the fold call answers is inside the span when the fold opens the next request;
    // it is the current task, not a handled message.
    const current = fold.callStep?.userStamp;
    for (const label of fold.details.keptUserTurns) {
      const stamp = stampNumber(label);
      if (stamp !== undefined && current !== undefined && stamp >= current) continue;
      const listed = new RegExp(`\\bt${stamp ?? label}\\b`).test(handled);
      items.push(
        item(
          'b5',
          `${fold.handle}:${label}`,
          listed,
          listed
            ? `Handled: ${handled}`
            : `${label} kept from the span; Handled section: ${handled || '(none)'}`,
          fold.requestIndex
        )
      );
    }
    const trailing = fold.step?.step?.trailing ?? [];
    const open = (fold.open ?? '').toLowerCase();
    for (const marker of trailing) {
      const words = markerTokens(marker);
      const missing = words.filter((word) => !open.includes(word));
      items.push(
        item(
          'b6',
          `${fold.handle}:${marker}`,
          words.length > 0 && missing.length === 0,
          fold.open === undefined
            ? `no Open section in the note; trailing marker ${JSON.stringify(marker)}`
            : missing.length === 0
              ? `Open: ${fold.open}`
              : `Open: ${fold.open}; missing ${missing.join(', ')}`,
          fold.requestIndex
        )
      );
    }
  }
  return items;
}

function windowOf(index: number): [number, number] {
  return [index - WINDOW, index + WINDOW];
}

function recallShares(action: Action, trigger: Trigger): string[] {
  const found = shared(tokens(action.query ?? ''), trigger.tokens);
  if (action.handle !== undefined && action.handle === trigger.handle) found.push(action.handle);
  return found;
}

function goingBackItems(analysis: TrialAnalysis): RubricItem[] {
  const items: RubricItem[] = [];
  const { actions, archives, triggers } = analysis;
  const archiveOf = (handle: string) => archives.find((archive) => archive.handle === handle);

  for (const trigger of triggers) {
    const [from, to] = windowOf(trigger.requestIndex);
    items.push(
      item(
        'c1',
        trigger.id,
        true,
        `${trigger.kind}: ${trigger.text} (archive ${trigger.handle})`,
        trigger.requestIndex
      )
    );

    const archive = archiveOf(trigger.handle);
    const after = archive?.requestIndex ?? -1;
    const recalls = actions.filter(
      (action) =>
        (action.kind === 'recall' || action.kind === 'ask') &&
        action.requestIndex > after &&
        action.requestIndex >= from &&
        action.requestIndex <= to
    );
    const hit = recalls
      .map((action) => ({ action, shared: recallShares(action, trigger) }))
      .find((candidate) => candidate.shared.length > 0);
    items.push(
      item(
        'c2',
        trigger.id,
        hit !== undefined,
        hit
          ? `${hit.action.kind}(${JSON.stringify(hit.action.query)}) at r${hit.action.requestIndex} shares ${hit.shared.join(', ')}`
          : recalls.length === 0
            ? `no recall or ask in r${from}-r${to}`
            : `recalls in r${from}-r${to} share no token with the trigger: ${recalls.map((action) => JSON.stringify(action.query)).join(', ')}`,
        trigger.requestIndex
      )
    );

    let redo: string | undefined;
    for (const action of actions) {
      if (action.requestIndex <= after || action.requestIndex < from || action.requestIndex > to) {
        continue;
      }
      const before = actions.some(
        (other) =>
          (other.kind === 'recall' || other.kind === 'ask') &&
          other.requestIndex >= from &&
          other.requestIndex <= action.requestIndex
      );
      if (before) continue;
      if (
        action.kind === 'read' &&
        action.path !== undefined &&
        archive?.files.includes(action.path)
      ) {
        redo = `read ${action.path} at r${action.requestIndex} with no recall before it`;
        break;
      }
      if (
        action.kind === 'bash' &&
        action.command !== undefined &&
        archive?.commands.has(action.command)
      ) {
        redo = `reran ${JSON.stringify(action.command)} at r${action.requestIndex} with no recall before it`;
        break;
      }
    }
    items.push(
      item(
        'c3',
        trigger.id,
        redo === undefined,
        redo ??
          `no re-read of ${trigger.handle}'s files or rerun of its commands in r${from}-r${to} without a recall`,
        trigger.requestIndex
      )
    );
  }

  for (const action of actions) {
    if (action.kind !== 'recall' && action.kind !== 'ask') continue;
    const [from, to] = windowOf(action.requestIndex);
    const near = triggers.filter(
      (trigger) => trigger.requestIndex >= from && trigger.requestIndex <= to
    );
    const cue = actions.some(
      (other) =>
        other.requestIndex >= from &&
        other.requestIndex <= action.requestIndex &&
        other.result?.includes('[episodes] ') &&
        other.result.includes('was also touched in')
    );
    const hits = action.kind === 'recall' ? recallTotal(analysis, action) : undefined;
    const spurious = near.length === 0 && !cue;
    items.push(
      item(
        'c6',
        `${action.kind}@r${action.requestIndex}:${action.query ?? ''}`,
        !spurious,
        spurious
          ? `${action.kind}(${JSON.stringify(action.query)}) with no trigger in r${from}-r${to}${hits === undefined ? '' : `, ${hits} hit(s)`}`
          : `${action.kind}(${JSON.stringify(action.query)}) ${near.length > 0 ? `near trigger ${near[0]!.id}` : 'after a file-touch cue'}${hits === undefined ? '' : `, ${hits} hit(s)`}`,
        action.requestIndex,
        hits
      )
    );
  }

  return items;
}

function recallTotal(analysis: TrialAnalysis, action: Action): number {
  const ref = toolResults(analysis.input.branch, RECALL_TOOL).find(
    (result) => result.message.toolCallId === action.call.id
  );
  if (ref && isRecallDetails(ref.message.details)) return ref.message.details.total;
  const metric = analysis.input.metrics?.recalls.find(
    (recall) => recall.requestIndex === action.requestIndex && recall.query === action.query
  );
  return metric?.total ?? 0;
}

/** Tokens that name a trap in a note: its files' basenames, the grep literal and the step's trailing markers. */
function trapTokens(scenario: Scenario, trapId: string, step: Step | undefined): string[] {
  const trap = scenario.traps[trapId];
  const found = new Set<string>();
  for (const file of trap?.files ?? []) {
    for (const token of markerTokens(file)) found.add(token);
    const base = basename(file);
    found.add(base.toLowerCase());
    found.add(base.replace(/\.[a-z0-9]+$/i, '').toLowerCase());
  }
  if (trap?.grep !== undefined) {
    const literal = trap.grep
      .replace(/\\(.)/g, '$1')
      .replace(/[.*+?^${}()|[\]]/g, '')
      .toLowerCase();
    if (literal.length >= 3) found.add(literal);
  }
  for (const marker of step?.trailing ?? []) {
    for (const token of markerTokens(marker)) found.add(token);
  }
  return [...found].filter((token) => token.length >= 3);
}

function trapItems(analysis: TrialAnalysis): RubricItem[] {
  const items: RubricItem[] = [];
  const { input, folds } = analysis;
  const { scenario } = input;

  for (const fold of folds) {
    const step = fold.step?.step;
    const trapId = step?.trap;
    if (!step || trapId === undefined) continue;
    const trap = scenario.traps[trapId];
    if (!trap) continue;
    const subject = `${fold.handle}:${trapId}`;

    let present: boolean;
    let how: string;
    const tree = fold.details.treeAfter;
    const base = input.trialRecord.baseTree;
    // A trap with a grep is found by it; one without (files that must stay unchanged) by a
    // difference from the sealed tree, which needs `baseTree` from trial.json.
    const decidable = trap.grep !== undefined || base !== undefined;
    if (tree !== undefined && input.readTreeFile && decidable) {
      const read = input.readTreeFile;
      const hits = trap.files.filter((file) => {
        const content = read(tree, file);
        if (content === undefined) return false;
        if (trap.grep !== undefined) return new RegExp(trap.grep).test(content);
        return read(base!, file) !== content;
      });
      present = hits.length > 0;
      const what =
        trap.grep === undefined ? 'differs from the sealed tree' : `matches /${trap.grep}/`;
      how = present
        ? `tree ${tree.slice(0, 12)}: ${hits.join(', ')} ${what}`
        : `tree ${tree.slice(0, 12)}: no trap file ${what}`;
    } else {
      const inFiles = trap.files.filter((file) => fold.files.includes(file));
      const leftAtEnd = input.checks?.final?.traps[trapId] === false;
      present = inFiles.length > 0 || leftAtEnd;
      how = `proxy (treeAfter objects not available): ${inFiles.length > 0 ? `${inFiles.join(', ')} in the fold's files` : "trap files not in the fold's files"}${leftAtEnd ? '; trap left on the final tree' : ''}`;
    }
    items.push(item('d1', subject, present, how, fold.requestIndex));
    if (!present) continue;

    const open = (fold.open ?? '').toLowerCase();
    const names = trapTokens(scenario, trapId, step);
    const named = names.filter((token) => open.includes(token));
    items.push(
      item(
        'd2',
        subject,
        named.length > 0,
        fold.open === undefined
          ? `no Open section in the note (looked for ${names.join(', ')})`
          : named.length > 0
            ? `Open names ${named.join(', ')}: ${fold.open}`
            : `Open: ${fold.open}; none of ${names.join(', ')}`,
        fold.requestIndex
      )
    );

    const reminder = input.branch
      .slice(fold.position + 1)
      .find((entry) => entry.type === 'custom_message' && entry.customType === REMINDER_TYPE);
    const text = reminder?.type === 'custom_message' ? textOf(reminder.content) : '';
    const reminded = text.includes(fold.handle);
    items.push(
      item(
        'd3',
        subject,
        reminded,
        reminder === undefined
          ? 'no episodes-open reminder after the fold'
          : reminded
            ? `reminder names ${fold.handle}: ${text.split('\n').find((line) => line.includes(fold.handle)) ?? ''}`
            : `reminder after the fold does not name ${fold.handle}: ${text}`,
        fold.requestIndex
      )
    );
  }

  for (const trapId of scenario.final.traps) {
    const result = input.checks?.final?.traps[trapId];
    items.push(
      item(
        'd4',
        trapId,
        result === undefined ? 'pending' : result,
        result === undefined
          ? 'no final trap result in checks.json'
          : result
            ? 'reverted on the final tree (checks.json)'
            : 'left on the final tree (checks.json)',
        -1
      )
    );
  }
  return items;
}

interface StaleLine {
  action: Action;
  handle: string;
  paths: string[];
  line: string;
}

function staleLines(analysis: TrialAnalysis): StaleLine[] {
  const found: StaleLine[] = [];
  for (const action of analysis.actions) {
    if ((action.kind !== 'recall' && action.kind !== 'ask') || action.result === undefined)
      continue;
    for (const line of action.result.split('\n')) {
      if (!STALENESS_LINE.test(line)) continue;
      const handle = /^(ep|fk)-[0-9a-f]{8}/.exec(line)?.[0] ?? '';
      const list =
        /predates changes to: (.+?)\. Conclusions/.exec(line)?.[1] ??
        line.replace(/^.*predates changes to: /, '');
      const paths = list
        .split(',')
        .map((path) => path.trim().replace(/\.$/, ''))
        .filter(Boolean)
        .map((path) => relPath(analysis.input.cwd, path));
      found.push({ action, handle, paths, line: line.trim() });
    }
  }
  return found;
}

/** The action edits, writes or names (in a bash command) the relative path. */
function touches(action: Action, path: string): boolean {
  if ((action.kind === 'edit' || action.kind === 'write') && action.path === path) return true;
  return action.kind === 'bash' && action.command !== undefined && action.command.includes(path);
}

function stalenessItems(analysis: TrialAnalysis): RubricItem[] {
  const items: RubricItem[] = [];
  const { actions } = analysis;
  for (const stale of staleLines(analysis)) {
    const subject = `${stale.action.kind}@r${stale.action.requestIndex}:${stale.handle}`;
    items.push(item('e1', subject, true, stale.line, stale.action.requestIndex));

    let verdict: boolean | undefined;
    let evidence = `no later edit, write or bash touched ${stale.paths.join(', ')}`;
    for (const path of stale.paths) {
      const next = actions.find(
        (action) => action.requestIndex > stale.action.requestIndex && touches(action, path)
      );
      if (!next) continue;
      const reread = actions.some(
        (action) =>
          action.kind === 'read' &&
          action.path === path &&
          action.requestIndex > stale.action.requestIndex &&
          action.requestIndex <= next.requestIndex
      );
      if (!reread) {
        verdict = false;
        evidence = `${next.kind} on ${path} at r${next.requestIndex} with no read of it after the staleness line at r${stale.action.requestIndex}`;
        break;
      }
      verdict = true;
      evidence = `read ${path} before ${next.kind} on it at r${next.requestIndex}`;
    }
    items.push(item('e2', subject, verdict ?? true, evidence, stale.action.requestIndex));
    if (verdict === false) {
      items.push(
        item(
          'e4',
          subject,
          'pending',
          `the scenario has no planted-change data for ${stale.paths.join(', ')}; a judge decides with e3's quote and the current file`,
          stale.action.requestIndex
        )
      );
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Judge extracts
// ---------------------------------------------------------------------------

function extract(
  rubric: RubricId,
  subject: string,
  requestIndex: number,
  question: string,
  blocks: JudgeExtractBlock[]
): JudgeExtract {
  return { rubric, subject, requestIndex, question, blocks };
}

function triggerTurns(analysis: TrialAnalysis, trigger: Trigger, count: number): string {
  return renderTurns(analysis.input.branch, analysis.requests, trigger.requestIndex, count);
}

function judgeExtractsOf(analysis: TrialAnalysis, items: readonly RubricItem[]): JudgeExtract[] {
  const { input, folds, requests, steps, triggers } = analysis;
  const found: JudgeExtract[] = [];
  const passOf = (rubric: RubricId, subject: string) =>
    items.find((candidate) => candidate.rubric === rubric && candidate.subject === subject)?.pass;

  for (const fold of folds) {
    const headline = noteHeadline(fold.note);
    found.push(
      extract(
        'b1',
        fold.handle,
        fold.requestIndex,
        'Does the first line of the note name a question and how it ended? Quote it.',
        [{ name: 'headline', text: headline }]
      )
    );
    const siblings = folds
      .filter((other) => other !== fold)
      .map((other) => `- ${noteHeadline(other.note)}`);
    if (siblings.length > 0) {
      found.push(
        extract(
          'b2',
          fold.handle,
          fold.requestIndex,
          'Given these sibling headlines, could a reader tell this episode apart from each of them? Quote the headline.',
          [
            { name: 'headline', text: headline },
            { name: 'siblings', text: siblings.join('\n') }
          ]
        )
      );
    }
    const step = fold.step?.step;
    (step?.mustCarry ?? []).forEach((fact, index) => {
      const blocks = [
        ...blocksOfNote(fold),
        { name: 'fact', text: fact.fact },
        { name: 'condition', text: fact.condition }
      ];
      found.push(
        extract(
          'b3',
          `${fold.handle}:fact-${index + 1}`,
          fold.requestIndex,
          'Is this fact present in the note, with or without its condition? Quote the note line that states it.',
          blocks
        )
      );
      found.push(
        extract(
          'b3c',
          `${fold.handle}:fact-${index + 1}`,
          fold.requestIndex,
          'Is this fact present in the note together with its condition? Quote the note line that states the condition.',
          blocks
        )
      );
    });
    (step?.rejected ?? []).forEach((rejected, index) => {
      found.push(
        extract(
          'b4',
          `${fold.handle}:rejected-${index + 1}`,
          fold.requestIndex,
          'Does the note say this approach was rejected and why? Quote it.',
          [...blocksOfNote(fold), { name: 'rejected', text: rejected }]
        )
      );
    });
  }

  const firstFold = folds[0];
  for (const step of steps) {
    const spec = step.step;
    if (!spec || (spec.kind !== 'probe' && spec.kind !== 'aside')) continue;
    const answer = input.checks?.answers.find((candidate) => candidate.stepId === step.id);
    const prompt = input.branch[step.userPosition];
    const promptText =
      prompt?.type === 'message' && prompt.message.role === 'user'
        ? textOf(prompt.message.content)
        : spec.text;
    const expected =
      answer?.expected ??
      (spec.answer?.kind === 'fixed'
        ? `matches /${spec.answer.pattern}/`
        : spec.answer?.kind === 'abstain'
          ? 'the information was never shown to the agent; the correct answer says so'
          : spec.answer?.kind === 'diff'
            ? `derived from the trial's diff (${spec.answer.key})`
            : (spec.answer?.rubric ?? ''));
    if (spec.kind === 'probe' && firstFold && firstFold.requestIndex < step.firstRequest) {
      found.push(
        extract(
          'b7',
          step.id,
          step.firstRequest,
          "Given the probe task and the agent's next turns, did the agent (A) continue correctly from its context, (B) call recall or ask and then continue correctly, or (C) proceed on a wrong assumption? Answer PASS for A or B and FAIL for C. Quote the turn that decides it.",
          [
            { name: 'probe', text: promptText },
            { name: 'expected', text: expected },
            {
              name: 'turns',
              text: renderTurns(input.branch, requests, step.firstRequest, TURNS_AFTER_PROBE)
            }
          ]
        )
      );
    }
    if (spec.answer?.kind === 'abstain') {
      found.push(
        extract(
          'probes',
          step.id,
          step.firstRequest,
          'The agent was never shown the information this question asks for. Does the answer say it does not know or was not shown it, instead of naming a specific value? Quote the sentence that decides it.',
          [
            { name: 'question', text: promptText },
            {
              name: 'answer',
              text:
                answer?.answer ??
                input.trialRecord.steps.find((result) => result.id === step.id)?.answer ??
                ''
            }
          ]
        )
      );
    } else if (spec.answer?.kind === 'judge') {
      found.push(
        extract('probes', step.id, step.firstRequest, spec.answer.rubric, [
          { name: 'question', text: promptText },
          {
            name: 'answer',
            text:
              answer?.answer ??
              input.trialRecord.steps.find((result) => result.id === step.id)?.answer ??
              ''
          }
        ])
      );
    }
  }

  for (const trigger of triggers) {
    const fold = folds.find((candidate) => candidate.handle === trigger.handle);
    if (!fold) continue;
    const consulted = passOf('c2', trigger.id) === true;
    const rederived = passOf('c3', trigger.id) === false;
    if (!consulted && !rederived) {
      const sections = (['learned', 'decided', 'rejected'] as const)
        .map((name) => {
          const text = noteSection(fold.note, name);
          return text === undefined ? undefined : `${name}: ${text}`;
        })
        .filter((line): line is string => line !== undefined);
      found.push(
        extract(
          'c4',
          trigger.id,
          trigger.requestIndex,
          "The agent acted without consulting the archive. Does its action contradict anything in the note's Learned, Decided or Rejected sections? Answer FAIL if it does, PASS if it does not. Quote the action and the note line.",
          [
            { name: 'trigger', text: `${trigger.kind}: ${trigger.text}` },
            { name: 'note-sections', text: sections.join('\n') || '(none)' },
            { name: 'turns', text: triggerTurns(analysis, trigger, WINDOW) }
          ]
        )
      );
    }
    (fold.step?.step?.rejected ?? []).forEach((rejected, index) => {
      found.push(
        extract(
          'c5',
          `${trigger.id}:rejected-${index + 1}`,
          trigger.requestIndex,
          'Do these turns attempt the approach described here? Answer FAIL if they do, PASS if they do not. Quote the turn.',
          [
            { name: 'rejected', text: rejected },
            { name: 'turns', text: triggerTurns(analysis, trigger, TURNS_AFTER_TRIGGER_JUDGE) }
          ]
        )
      );
    });
  }

  for (const fold of folds) {
    const trapId = fold.step?.step?.trap;
    if (trapId === undefined) continue;
    const trap = input.scenario.traps[trapId];
    if (
      !trap ||
      passOf('d4', trapId) !== false ||
      passOf('d1', `${fold.handle}:${trapId}`) !== true
    )
      continue;
    const edits = analysis.actions.filter(
      (action) =>
        action.requestIndex > fold.requestIndex && trap.files.some((file) => touches(action, file))
    );
    if (edits.length === 0) continue;
    const text = edits
      .map(
        (action) =>
          `[r${action.requestIndex}] ${action.kind}(${JSON.stringify(action.call.arguments)})\n${cut(action.result ?? '(no result)')}`
      )
      .join('\n');
    found.push(
      extract(
        'd5',
        `${fold.handle}:${trapId}`,
        fold.requestIndex,
        'Did these edits try to remove the temporary change (the trap marker)? Quote the edit.',
        [
          {
            name: 'trap',
            text: JSON.stringify({ id: trapId, files: trap.files, grep: trap.grep ?? null })
          },
          { name: 'edits', text }
        ]
      )
    );
  }

  for (const stale of staleLines(analysis)) {
    const subject = `${stale.action.kind}@r${stale.action.requestIndex}:${stale.handle}`;
    if (passOf('e2', subject) !== false) continue;
    found.push(
      extract(
        'e3',
        subject,
        stale.action.requestIndex,
        'The archived thread drew conclusions about a file that changed after it was archived. Does any action in these turns assume what the thread said about that file? Answer FAIL if it does, PASS if it does not. Quote the action and the line it assumes.',
        [
          { name: 'staleness', text: stale.line },
          { name: 'result', text: cut(stale.action.result ?? '') },
          {
            name: 'turns',
            text: renderTurns(input.branch, requests, stale.action.requestIndex + 1, WINDOW)
          }
        ]
      )
    );
  }

  return found;
}

// ---------------------------------------------------------------------------
// Analysis entry points
// ---------------------------------------------------------------------------

export function analyzeTrial(input: TrialInput): TrialAnalysis {
  const requests = requestsOf(input.branch);
  const steps = stepRanges(input, requests);
  const folds = foldsOf(input, steps);
  const archives: Archive[] = [...folds, ...forkArchivesOf(input)].sort(
    (a, b) => a.position - b.position
  );
  const actions = actionsOf(input, requests);
  const triggers = triggersOf(input, requests, archives, actions);
  const analysis: TrialAnalysis = {
    input,
    requests,
    steps,
    folds,
    archives,
    actions,
    triggers,
    items: [],
    extracts: []
  };
  analysis.items = [
    ...boundaryItems(analysis),
    ...spanNeededItems(analysis),
    ...noteItems(analysis),
    ...goingBackItems(analysis),
    ...trapItems(analysis),
    ...stalenessItems(analysis)
  ];
  analysis.extracts = judgeExtractsOf(analysis, analysis.items);
  return analysis;
}

/** Every script rubric item of a trial (a1 to a4, b5, b6, c1 to c3, c6, d1 to d4, e1, e2, e4). */
export function scriptRubrics(input: TrialInput): RubricItem[] {
  return analyzeTrial(input).items;
}

/** Every judge question of a trial with its input blocks (b1 to b4, b7, c4, c5, d5, e3, probes). */
export function judgeExtracts(input: TrialInput): JudgeExtract[] {
  return analyzeTrial(input).extracts;
}

// ---------------------------------------------------------------------------
// Judge calls
// ---------------------------------------------------------------------------

export interface JudgeRequest {
  system: string;
  user: string;
}

/** Returns the model's text; tests pass a stub, `createModelCaller` the real thing. */
export type CallModel = (request: JudgeRequest) => Promise<string>;

export function judgePrompt(extract: JudgeExtract): JudgeRequest {
  const inputs = extract.blocks
    .map((block) => `<input name="${block.name}">\n${block.text}\n</input>`)
    .join('\n\n');
  return {
    system: JUDGE_SYSTEM_PROMPT,
    user: `${extract.question}\n\n${inputs}\n\n${JUDGE_PROMPT_TAIL}`
  };
}

function parseVerdict(raw: string): JudgeVerdict | undefined {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const object = parsed as Record<string, unknown>;
  const answer = typeof object.answer === 'string' ? object.answer.trim().toUpperCase() : '';
  if (answer !== 'PASS' && answer !== 'FAIL') return undefined;
  if (typeof object.evidence !== 'string') return undefined;
  return {
    answer,
    evidence: object.evidence,
    reason: typeof object.reason === 'string' ? object.reason : ''
  };
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The evidence must occur in the input blocks; whitespace runs are the only tolerated difference. */
export function evidenceInInput(evidence: string, extract: JudgeExtract): boolean {
  if (evidence.trim().length === 0) return false;
  const input = extract.blocks.map((block) => block.text).join('\n');
  return input.includes(evidence) || collapse(input).includes(collapse(evidence));
}

/** One judge call, repeated once when the verdict is unparsable or its evidence is not in the input. */
export async function askJudge(
  extract: JudgeExtract,
  callModel: CallModel
): Promise<JudgeItemVerdict> {
  const request = judgePrompt(extract);
  let reason = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await callModel(request);
    const verdict = parseVerdict(raw);
    if (!verdict) {
      reason = `no JSON verdict in: ${raw.slice(0, 200)}`;
      continue;
    }
    if (!evidenceInInput(verdict.evidence, extract)) {
      reason = `evidence not in the input: ${verdict.evidence.slice(0, 200)}`;
      continue;
    }
    return { ...verdict, status: 'ok', attempts: attempt };
  }
  return { status: 'invalid', attempts: 2, reason };
}

/**
 * `provider/modelId` without version suffixes: a dated snapshot (`-20250929`, `-2025-08-07`),
 * a Vertex-style `@20250929`, `-latest` or `-preview`. `anthropic/claude-sonnet-4-5` and
 * `anthropic/claude-sonnet-4-5-20250929` are one family; `openai/gpt-5-mini` is its own.
 */
export function modelFamily(model: string): string {
  const [provider, ...rest] = model.split('/');
  let id = rest.join('/').replace(/@.*$/, '');
  for (;;) {
    const stripped = id.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2}|latest|preview)$/i, '');
    if (stripped === id) break;
    id = stripped;
  }
  return `${provider}/${id}`;
}

/** DESIGN 9: the judge is never the model under test, dated aliases included. */
export function sameFamily(a: string, b: string): boolean {
  return modelFamily(a) === modelFamily(b);
}

/**
 * The judge for a trial: `override` when given, else the first configured model whose family
 * differs from the trial's. Undefined when every candidate is the trial's own family (the
 * trial is then refused).
 */
export function pickJudgeModel(
  models: readonly string[],
  trialModel: string | undefined,
  override?: string
): string | undefined {
  if (override !== undefined) return override;
  if (trialModel === undefined) return models[0];
  return models.find((model) => !sameFamily(model, trialModel));
}

export function loadJudgeConfig(path: string = DEFAULT_JUDGE_CONFIG): JudgeConfig {
  const root = readObject(readJsonFile(path), path);
  rejectUnknownKeys(root, path, ['models', 'authPath']);
  const models = readStringArray(root.models, `${path}: models`);
  if (models.length === 0) throw new ConfigError(`${path}: models must not be empty`);
  for (const model of models) {
    if (!/^[^/\s]+\/[^\s]+$/.test(model)) {
      throw new ConfigError(`${path}: model ${JSON.stringify(model)} must be provider/modelId`);
    }
  }
  const authPath = readOptional(root.authPath, `${path}: authPath`, readString);
  return {
    models,
    // Relative to the repository root, as the example in DESIGN 9 writes it.
    authPath: authPath === undefined ? DEFAULT_AUTH_PATH : resolve(BENCH_DIR, '..', authPath)
  };
}

/**
 * A `CallModel` over `ModelRuntime.completeSimple` at temperature 0 with credentials from
 * `authPath`; `modelsPath` lets the judge sit behind a `models.pi.json` endpoint too.
 */
export async function createModelCaller(
  model: string,
  authPath: string,
  modelsPath: string | null
): Promise<CallModel> {
  const runtime = await createModelRuntime(authPath, modelsPath);
  const found = resolveModel(runtime, model, authPath, modelsPath);
  return async (request) => {
    const response = await runtime.completeSimple(
      found,
      {
        systemPrompt: request.system,
        messages: [{ role: 'user', content: request.user, timestamp: Date.now() }]
      },
      { temperature: 0 }
    );
    if (response.stopReason === 'error' || response.stopReason === 'aborted') {
      throw new Error(response.errorMessage ?? `judge call ${response.stopReason}`);
    }
    return response.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
  };
}

// ---------------------------------------------------------------------------
// Trial judging
// ---------------------------------------------------------------------------

export type RubricGroup = 'a' | 'b' | 'c' | 'd' | 'e' | 'probes';
export const RUBRIC_GROUPS: readonly RubricGroup[] = ['a', 'b', 'c', 'd', 'e', 'probes'];

export function groupOf(rubric: RubricId): RubricGroup {
  return rubric === 'probes' ? 'probes' : (rubric[0] as RubricGroup);
}

export interface JudgeTrialOptions {
  judgeModel?: string;
  /** Absent: judge questions stay `pending`. */
  callModel?: CallModel;
  /** Rubric groups to run; default all. */
  groups?: readonly RubricGroup[];
  /** The trial's model, `provider/modelId`; judging is refused when it is `judgeModel`'s family. */
  trialModel?: string;
  /** The previous judge.json of the trial; verdicts of other judge models are carried over. */
  previous?: JudgeJson;
}

export function summarizeItems(items: readonly RubricItem[]): Record<string, RubricSummary> {
  const summary: Record<string, RubricSummary> = {};
  for (const entry of items) {
    const slot = summary[entry.rubric] ?? { pass: 0, total: 0, pending: 0, invalid: 0, items: [] };
    slot.items.push(entry);
    if (entry.pass === 'pending') slot.pending++;
    else if (entry.pass === 'invalid') slot.invalid++;
    else {
      slot.total++;
      if (entry.pass) slot.pass++;
    }
    summary[entry.rubric] = slot;
  }
  return Object.fromEntries(Object.entries(summary).sort(([a], [b]) => a.localeCompare(b)));
}

export function pendingItem(extract: JudgeExtract, evidence: string): RubricItem {
  return item(extract.rubric, extract.subject, 'pending', evidence, extract.requestIndex);
}

/** Script rubrics plus judge verdicts for one trial; the result is what `judge.json` holds. */
export async function judgeTrial(
  input: TrialInput,
  options: JudgeTrialOptions = {}
): Promise<JudgeJson> {
  const groups = options.groups ?? RUBRIC_GROUPS;
  const analysis = analyzeTrial(input);
  const items = analysis.items.filter((entry) => groups.includes(groupOf(entry.rubric)));
  const extracts = analysis.extracts.filter((entry) => groups.includes(groupOf(entry.rubric)));
  const judgeModel = options.judgeModel;
  const refused =
    judgeModel !== undefined &&
    options.trialModel !== undefined &&
    sameFamily(judgeModel, options.trialModel)
      ? `judge model ${judgeModel} is the trial model's family (${modelFamily(options.trialModel)})`
      : undefined;

  const previousVerdicts = new Map<string, Record<string, JudgeItemVerdict>>();
  for (const summary of Object.values(options.previous?.rubrics ?? {})) {
    for (const entry of summary.items) {
      if (entry.verdicts) previousVerdicts.set(`${entry.rubric}:${entry.subject}`, entry.verdicts);
    }
  }

  for (const extract of extracts) {
    const key = `${extract.rubric}:${extract.subject}`;
    const verdicts: Record<string, JudgeItemVerdict> = { ...previousVerdicts.get(key) };
    let built: RubricItem;
    if (refused !== undefined) {
      built = pendingItem(extract, `refused: ${refused}`);
    } else if (judgeModel === undefined || options.callModel === undefined) {
      built = pendingItem(
        extract,
        'no judge model configured; question: '.concat(extract.question)
      );
    } else {
      const verdict = await askJudge(extract, options.callModel);
      verdicts[judgeModel] = verdict;
      built =
        verdict.status === 'ok'
          ? item(
              extract.rubric,
              extract.subject,
              verdict.answer === 'PASS',
              verdict.evidence,
              extract.requestIndex
            )
          : item(extract.rubric, extract.subject, 'invalid', verdict.reason, extract.requestIndex);
    }
    if (Object.keys(verdicts).length > 0) built.verdicts = verdicts;
    items.push(built);
  }

  const result: JudgeJson = {
    generatedAt: new Date().toISOString(),
    rubrics: summarizeItems(items)
  };
  if (judgeModel !== undefined) result.judgeModel = judgeModel;
  if (refused !== undefined) result.refused = refused;
  return result;
}

// ---------------------------------------------------------------------------
// Null check (DESIGN 9)
// ---------------------------------------------------------------------------

const NULL_FORBIDDEN = new Set<RubricId>(['d1', 'd2', 'd3']);

function forbiddenOnA(rubric: RubricId): boolean {
  const group = groupOf(rubric);
  return group === 'a' || group === 'b' || group === 'e' || NULL_FORBIDDEN.has(rubric);
}

/**
 * Condition A trials must yield no a, b, d1 to d3 or e items or extracts, and every c2 and d2
 * item there must FAIL. Anything else means an extractor fires without episodes.
 */
export function nullCheck(trials: readonly TrialInput[]): NullCheckResult {
  const problems: string[] = [];
  let count = 0;
  for (const input of trials) {
    if (input.trialRecord.condition.split('@')[0] !== 'A') continue;
    count++;
    const analysis = analyzeTrial(input);
    for (const entry of analysis.items) {
      if (forbiddenOnA(entry.rubric)) {
        problems.push(
          `${input.id}: ${entry.rubric} item ${entry.subject} on a condition A trial (${entry.evidence})`
        );
      } else if ((entry.rubric === 'c2' || entry.rubric === 'd2') && entry.pass === true) {
        problems.push(
          `${input.id}: ${entry.rubric} item ${entry.subject} PASSes on a condition A trial (${entry.evidence})`
        );
      }
    }
    for (const entry of analysis.extracts) {
      if (forbiddenOnA(entry.rubric)) {
        problems.push(
          `${input.id}: ${entry.rubric} judge extract ${entry.subject} on a condition A trial`
        );
      }
    }
  }
  return { trials: count, ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Calibration: labels and Cohen's kappa
// ---------------------------------------------------------------------------

export function readLabels(path: string = DEFAULT_LABELS_PATH): JudgeLabel[] {
  if (!existsSync(path)) return [];
  const labels: JudgeLabel[] = [];
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (!line.trim()) return;
      const where = `${path}:${index + 1}`;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new ConfigError(`${where}: invalid JSON: ${(error as Error).message}`);
      }
      const object = readObject(parsed, where);
      rejectUnknownKeys(object, where, ['run', 'trial', 'rubric', 'subject', 'label', 'note']);
      const label = readString(object.label, `${where}: label`).toUpperCase();
      if (label !== 'PASS' && label !== 'FAIL')
        throw new ConfigError(`${where}: label must be PASS or FAIL`);
      const record: JudgeLabel = {
        run: readString(object.run, `${where}: run`),
        trial: readString(object.trial, `${where}: trial`),
        rubric: readString(object.rubric, `${where}: rubric`),
        subject: readString(object.subject, `${where}: subject`),
        label
      };
      const note = readOptional(object.note, `${where}: note`, readString);
      if (note !== undefined) record.note = note;
      labels.push(record);
    });
  return labels;
}

/** Cohen's kappa for a 2x2 confusion matrix; null when chance agreement is 1. */
export function cohenKappa(tp: number, fp: number, fn: number, tn: number): number | null {
  const n = tp + fp + fn + tn;
  if (n === 0) return null;
  const po = (tp + tn) / n;
  const pe = ((tp + fn) / n) * ((tp + fp) / n) + ((fp + tn) / n) * ((fn + tn) / n);
  if (pe === 1) return null;
  return (po - pe) / (1 - pe);
}

/** Confusion matrix and kappa per (rubric, judge model) over the labels that have a verdict. */
export function kappaReport(
  labels: readonly JudgeLabel[],
  lookup: (run: string, trial: string) => JudgeJson | undefined
): KappaCell[] {
  const cells = new Map<string, KappaCell>();
  for (const label of labels) {
    const judged = lookup(label.run, label.trial);
    const found = judged?.rubrics?.[label.rubric]?.items.find(
      (entry) => entry.subject === label.subject
    );
    if (!found) continue;
    const verdicts: [string, 'PASS' | 'FAIL'][] = [];
    for (const [model, verdict] of Object.entries(found.verdicts ?? {})) {
      if (verdict.status === 'ok') verdicts.push([model, verdict.answer]);
    }
    if (
      verdicts.length === 0 &&
      typeof found.pass === 'boolean' &&
      judged?.judgeModel !== undefined
    ) {
      verdicts.push([judged.judgeModel, found.pass ? 'PASS' : 'FAIL']);
    }
    for (const [model, answer] of verdicts) {
      const key = `${label.rubric}\u0000${model}`;
      const cell = cells.get(key) ?? {
        rubric: label.rubric,
        model,
        n: 0,
        tp: 0,
        fp: 0,
        fn: 0,
        tn: 0,
        agreement: 0,
        kappa: null
      };
      cell.n++;
      if (label.label === 'PASS') {
        if (answer === 'PASS') cell.tp++;
        else cell.fn++;
      } else if (answer === 'PASS') cell.fp++;
      else cell.tn++;
      cells.set(key, cell);
    }
  }
  return [...cells.values()]
    .map((cell) => ({
      ...cell,
      agreement: (cell.tp + cell.tn) / cell.n,
      kappa: cohenKappa(cell.tp, cell.fp, cell.fn, cell.tn)
    }))
    .sort((a, b) => a.rubric.localeCompare(b.rubric) || a.model.localeCompare(b.model));
}

export function renderKappa(cells: readonly KappaCell[]): string {
  if (cells.length === 0) return 'no labeled items with a judge verdict\n';
  const lines = ['rubric  model                              n   tp  fp  fn  tn  agree  kappa'];
  for (const cell of cells) {
    lines.push(
      `${cell.rubric.padEnd(7)} ${cell.model.padEnd(34).slice(0, 34)} ${String(cell.n).padStart(3)} ${String(cell.tp).padStart(4)} ${String(cell.fp).padStart(3)} ${String(cell.fn).padStart(3)} ${String(cell.tn).padStart(3)}  ${cell.agreement.toFixed(2)}   ${cell.kappa === null ? '  n/a' : cell.kappa.toFixed(2).padStart(5)}`
    );
  }
  return `${lines.join('\n')}\n`;
}
