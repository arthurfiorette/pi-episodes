import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { archiveDir, type Thread, ThreadIndex } from './archive.js';
import { messageText } from './messages.js';
import { excerpt, RecallIndex, type RecallMatch, type SearchableThread } from './search.js';
import { readStamp, stampLabel } from './stamps.js';
import type { EpisodeState } from './state.js';
import { type RecallDetails, recallRenderers } from './ui.js';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;

export function createMatcher(
  query: string,
  regex: boolean
): (line: string) => { index: number; length: number } | undefined {
  if (regex) {
    const pattern = new RegExp(query, 'i');
    return (line) => {
      const match = pattern.exec(line);
      return match ? { index: match.index, length: match[0].length } : undefined;
    };
  }
  const needle = query.toLowerCase();
  return (line) => {
    const index = line.toLowerCase().indexOf(needle);
    return index < 0 ? undefined : { index, length: needle.length };
  };
}

/**
 * Greps every line a thread held, for quoted and regex queries. Lines are attributed to the
 * newest stamp seen so far, which is the turn the model would cite to find its way back.
 */
export function grepThreads(
  threads: readonly SearchableThread[],
  match: (line: string) => { index: number; length: number } | undefined
): RecallMatch[] {
  const matches: RecallMatch[] = [];
  for (const thread of threads) {
    let turn: string | undefined;
    for (const message of thread.messages) {
      const stamp = readStamp(message);
      for (const line of messageText(message).split('\n')) {
        const hit = match(line);
        if (!hit) continue;
        matches.push({
          handle: thread.handle,
          turn: stamp !== undefined ? stampLabel(stamp) : turn,
          role: message.role,
          line: excerpt(line, hit.index, hit.length)
        });
      }
      if (stamp !== undefined) turn = stampLabel(stamp);
    }
  }
  return matches;
}

export function formatMatch(match: RecallMatch): string {
  return `${match.handle} ${match.turn ?? '-'} ${match.role}: ${match.line}`;
}

/** Matches past the limit go to a file the agent can grep or read in part, not into context. */
async function spill(
  dir: string | undefined,
  query: string,
  matches: readonly RecallMatch[]
): Promise<string> {
  const target = dir ?? join(tmpdir(), 'pi-episodes');
  await mkdir(target, { recursive: true });
  const name = `recall-${Date.now()}-${query.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.txt`;
  const file = join(target, name);
  await writeFile(file, `${matches.map(formatMatch).join('\n')}\n`);
  return file;
}

/** Which files an archived thread touched have changed since it was archived. */
export async function staleness(
  state: EpisodeState,
  threads: readonly Thread[]
): Promise<string[]> {
  const snapshots = state.snapshots;
  const records = threads.flatMap((thread) =>
    thread.record.treeAfter && thread.record.files.length > 0 ? [thread.record] : []
  );
  if (!snapshots || records.length === 0) return [];

  const now = await snapshots.snapshot();
  if (!now) return [];

  const notes: string[] = [];
  for (const record of records) {
    const changed = await snapshots.diff(record.treeAfter!, now, record.files);
    if (changed && changed.length > 0) {
      notes.push(
        `${record.handle} predates changes to: ${changed.map((change) => relative(state.cwd, change.path)).join(', ')}. Conclusions about those files may no longer hold.`
      );
    }
  }
  return notes;
}

const RecallParams = Type.Object({
  query: Type.String({
    description:
      'Words to find, such as an error code, symbol, path or a few words of what happened. Wrap it in double quotes to match that exact text instead.'
  }),
  handle: Type.Optional(
    Type.String({ description: 'Only search this archived thread, such as "ep-1a2b3c4d".' })
  ),
  regex: Type.Optional(
    Type.Boolean({
      description: 'Treat query as a case-insensitive regular expression, matched per line.'
    })
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_LIMIT,
      description: `Matches to return, default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}. The rest go to a file.`
    })
  )
});

export function registerRecall(pi: ExtensionAPI, state: EpisodeState): void {
  pi.registerTool<typeof RecallParams, RecallDetails>({
    name: 'recall',
    label: 'Recall',
    description:
      'Search the archived threads (folded spans and finished forks): tool outputs, your own messages and reasoning, commands and their arguments. Ranked by relevance: messages holding every word come first, in any order, and rare words such as error codes weigh more than common ones. Returns the best line of each match with the thread handle and turn it came from; matches past the limit go to a file. A "quoted" query or regex matches exact text per line instead. Cheap, no model call. Query for the specific thing you need; it is not a way to read a span back.',
    promptSnippet: 'Search archived threads (folded spans, forks) by keyword or exact text',
    parameters: RecallParams,
    renderCall: recallRenderers.renderCall,
    renderResult: recallRenderers.renderResult,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const index = new ThreadIndex(ctx.sessionManager, state.forkArchives);
      let threads: Thread[];
      if (params.handle) {
        const thread = await index.find(params.handle);
        if (!thread) throw new Error(`No archived thread ${params.handle}.`);
        threads = [thread];
      } else {
        threads = await index.onBranch();
      }

      if (threads.length === 0) {
        return {
          content: [{ type: 'text', text: 'Nothing is archived on this branch yet.' }],
          details: { query: params.query, threads: 0, shown: 0, total: 0 }
        };
      }

      const quoted = /^"(.+)"$/s.exec(params.query.trim())?.[1];
      let all: RecallMatch[];
      let partial = false;
      if (params.regex || quoted !== undefined) {
        let matcher: ReturnType<typeof createMatcher>;
        try {
          matcher = createMatcher(params.regex ? params.query : quoted!, params.regex === true);
        } catch (error) {
          throw new Error(`Invalid regular expression: ${(error as Error).message}`);
        }
        all = grepThreads(threads, matcher);
      } else {
        // Built on the first recall of the session and only ever added to.
        state.recallIndex ??= new RecallIndex();
        state.recallIndex.add(threads);
        ({ matches: all, partial } = state.recallIndex.search(
          params.query,
          new Set(threads.map((thread) => thread.handle))
        ));
      }

      const limit = params.limit ?? DEFAULT_LIMIT;
      const matches = all.slice(0, limit);
      const total = all.length;
      const details: RecallDetails = {
        query: params.query,
        threads: threads.length,
        shown: matches.length,
        total
      };
      if (total === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No match for "${params.query}" in ${threads.length} archived thread(s): ${threads.map((thread) => thread.handle).join(', ')}.`
            }
          ],
          details
        };
      }

      const hitThreads = threads.filter((thread) =>
        matches.some((found) => found.handle === thread.handle)
      );
      // Staleness goes first: a cue only works if it is seen before the matches are acted on.
      const lines = [
        ...(await staleness(state, hitThreads)),
        ...(partial ? ['No message holds every word of the query; these hold some of them.'] : []),
        ...matches.map(formatMatch)
      ];
      if (total > matches.length) {
        const file = await spill(archiveDir(ctx.sessionManager), params.query, all);
        lines.push(
          `... ${total - matches.length} more matches. All ${total} are in ${file}; grep it or read a slice rather than the whole file. A narrower query is usually better.`
        );
        details.file = file;
      }

      return { content: [{ type: 'text', text: lines.join('\n') }], details };
    }
  });
}
