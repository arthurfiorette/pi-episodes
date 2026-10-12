import { realpathSync } from 'node:fs';
import type { ContextEditEntryDraft, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ForkArchive } from './archive.js';
import { Snapshots } from './snapshots.js';
import { readStamp } from './stamps.js';

export interface PendingFold {
  handle: string;
  messages: number;
  tokens: number;
  edits: ContextEditEntryDraft[];
}

/** Per-session runtime state. Everything durable lives in the session file instead. */
export class EpisodeState {
  nextStamp = 1;
  /**
   * The working directory with symlinks resolved, so paths from file tools compare equal to
   * the ones git reports (on macOS the temp directory alone is behind a symlink).
   */
  cwd = process.cwd();
  snapshots: Snapshots | undefined;
  /** Context edits computed by a fold call, emitted at the end of its turn. */
  readonly pendingFolds = new Map<string, PendingFold>();
  /** `handle:path` pairs already surfaced, so a folded thread is pointed at once per file. */
  readonly surfaced = new Set<string>();
  /** Fork transcripts for sessions that have no file to write them next to. */
  readonly forkArchives = new Map<string, ForkArchive>();
  /** Set by /fold so the requested fold ends the run instead of continuing the task. */
  manualFold = false;
  /** Forks in progress, for the footer status. */
  runningForks = 0;

  reset(ctx: ExtensionContext): void {
    void this.snapshots?.dispose();
    this.cwd = realpathOr(ctx.cwd);
    this.snapshots = new Snapshots(this.cwd, ctx.sessionManager.getSessionId());
    this.pendingFolds.clear();
    this.surfaced.clear();
    this.forkArchives.clear();
    this.manualFold = false;
    this.runningForks = 0;

    // Stamps must stay unique across every branch of the session file, so `since` always
    // resolves to exactly one message.
    let max = 0;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== 'message') continue;
      max = Math.max(max, readStamp(entry.message) ?? 0);
    }
    this.nextStamp = max + 1;
  }

  async dispose(): Promise<void> {
    await this.snapshots?.dispose();
    this.snapshots = undefined;
  }
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
