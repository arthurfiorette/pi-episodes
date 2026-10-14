import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type ExtensionAPI, type ExtensionContext, VERSION } from '@earendil-works/pi-coding-agent';
import { FOLD_TOOL, FORK_TOOL } from './archive.js';
import { EPISODES_SECTION } from './prompt.js';
import { episodesSettings } from './settings.js';

/**
 * Measurements that have no record of their own in the session. Written as custom entries,
 * which pi keeps in the session file and never sends to the model. Everything else the stats
 * need is already on the tool results.
 */
export const EVENT_TYPE = 'episodes-event';
/** What was running, so sessions from different versions or settings are not compared blindly. */
export const META_TYPE = 'episodes-meta';

export type FoldRejection =
  | 'bad-stamp'
  | 'empty-note'
  | 'not-in-context'
  | 'one-per-response'
  | 'no-such-stamp'
  | 'gone'
  | 'not-before-call'
  | 'behind-note'
  | 'behind-compaction'
  | 'behind-fork-start'
  | 'nothing-to-fold';

export interface FoldRejectedEvent {
  kind: 'fold-rejected';
  toolCallId: string;
  reason: FoldRejection;
}

export interface CueEvent {
  kind: 'cue';
  /** The tool call whose result carried the cue. */
  toolCallId: string;
  /** Relative to the working directory. */
  file: string;
  threads: { handle: string; readOnly: boolean }[];
  /** Threads that touched the file before the cap cut them to `threads`. */
  matched: number;
}

export interface NudgeEvent {
  kind: 'nudge';
  /** The tool call whose result carried the nudge. */
  toolCallId: string;
  /** Estimated tokens of that result. */
  tokens: number;
}

export type EpisodeEvent = FoldRejectedEvent | CueEvent | NudgeEvent;

export function recordEvent(pi: ExtensionAPI, event: EpisodeEvent): void {
  pi.appendEntry(EVENT_TYPE, event);
}

export interface EpisodesMeta {
  version: string;
  /** Changes when the prompt section or a tool description changes. */
  promptHash: string;
  pi: string;
  settings: ReturnType<typeof episodesSettings>;
}

function packageVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const OWN_TOOLS = new Set([FOLD_TOOL, 'recall', 'ask', FORK_TOOL]);

/** Written at session start, only when it differs from the last one, so resuming adds nothing. */
export function recordMeta(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const tools = pi
    .getAllTools()
    .filter((tool) => OWN_TOOLS.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const meta: EpisodesMeta = {
    version: packageVersion(),
    promptHash: createHash('sha256')
      .update(EPISODES_SECTION)
      .update(JSON.stringify(tools))
      .digest('hex')
      .slice(0, 12),
    pi: VERSION,
    settings: episodesSettings(pi.getSettings())
  };

  const last = ctx.sessionManager
    .getEntries()
    .findLast((entry) => entry.type === 'custom' && entry.customType === META_TYPE);
  if (last?.type === 'custom' && JSON.stringify(last.data) === JSON.stringify(meta)) return;
  pi.appendEntry(META_TYPE, meta);
}
