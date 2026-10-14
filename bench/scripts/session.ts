import { SessionManager } from '@earendil-works/pi-coding-agent';
import { type EpisodesMeta, META_TYPE } from '../../src/events.js';
import { type EpisodeStats, episodeStats } from '../../src/stats.js';

export interface SessionNumbers {
  /** What pi-episodes ran with; null when the session ran without it. */
  episodes: EpisodesMeta | null;
  stats: EpisodeStats;
}

/**
 * The same numbers `/episodes stats` shows, for a session file written anywhere. Plain pi
 * sessions read too: no folds, but requests, context per request and compactions.
 */
export function sessionNumbers(file: string): SessionNumbers {
  const session = SessionManager.open(file);
  const branch = session.getBranch();
  const meta = branch.findLast(
    (entry) => entry.type === 'custom' && entry.customType === META_TYPE
  );
  const stats = episodeStats(branch, session.getCwd());
  // episodeStats counts the prompt section as sent; without the extension nothing was.
  if (!meta) stats.overhead.prompt = 0;
  return {
    episodes: meta?.type === 'custom' ? (meta.data as EpisodesMeta) : null,
    stats
  };
}
