import type { AgentMessage } from '@earendil-works/pi-agent-core';
import MiniSearch, { type SearchResult } from 'minisearch';
import { messageText } from './messages.js';
import { readStamp, stampLabel } from './stamps.js';

const LINE_WIDTH = 240;
/** About 500 tokens. A long tool output is split so one log does not read as one document. */
const CHUNK_CHARS = 2000;

export interface RecallMatch {
  handle: string;
  turn: string | undefined;
  role: string;
  line: string;
}

export interface SearchableThread {
  handle: string;
  messages: readonly AgentMessage[];
}

interface Chunk {
  id: number;
  handle: string;
  turn: string | undefined;
  role: string;
  text: string;
}

export function excerpt(line: string, index: number, length: number): string {
  const text = line.trim();
  if (text.length <= LINE_WIDTH) return text;
  const offset = line.length - line.trimStart().length;
  const center = Math.max(0, index - offset);
  const start = Math.max(0, Math.min(center - LINE_WIDTH / 3, text.length - LINE_WIDTH));
  const end = Math.min(text.length, start + Math.max(LINE_WIDTH, length));
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
}

/**
 * Words as code writes them. `src/client/api.ts(12,5)` yields the path itself and its parts, so
 * both `api.ts` and `client` find it; `createMatcher` also yields `create` and `matcher`.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const word of text.split(/[\s"'`()[\]{}<>,;=|]+/)) {
    const token = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!token) continue;
    tokens.push(token);
    const parts = token
      .split(/[^\p{L}\p{N}]+|(?<=\p{Ll})(?=\p{Lu})/u)
      .filter((part) => part && part !== token);
    tokens.push(...parts);
  }
  return tokens;
}

const lower = (term: string) => term.toLowerCase();
/**
 * Only plain words get typo tolerance and prefixes: `regen` should find `regenerate`, but
 * `TS2323` must never find `TS2322`.
 */
const isWord = (term: string, min: number) => term.length >= min && /^\p{L}+$/u.test(term);

/** Ids continue from `firstId`, so they stay positions in the index's chunk list. */
function chunks(handle: string, messages: readonly AgentMessage[], firstId: number): Chunk[] {
  const out: Chunk[] = [];
  let turn: string | undefined;
  for (const message of messages) {
    const stamp = readStamp(message);
    const label = stamp !== undefined ? stampLabel(stamp) : turn;
    let text = '';
    const flush = () => {
      if (text.trim()) {
        out.push({ id: firstId + out.length, handle, turn: label, role: message.role, text });
      }
      text = '';
    };
    for (const line of messageText(message).split('\n')) {
      if (text && text.length + line.length > CHUNK_CHARS) flush();
      text += `${line}\n`;
    }
    flush();
    if (stamp !== undefined) turn = stampLabel(stamp);
  }
  return out;
}

/** The line of a chunk holding the most matched terms, cut around the first of them. */
function bestLine(chunk: Chunk, terms: readonly string[]): string {
  let best = { line: '', hits: -1, index: 0, length: 0 };
  for (const line of chunk.text.split('\n')) {
    const words = new Set(tokenize(line).map(lower));
    const hits = terms.filter((term) => words.has(term)).length;
    if (hits <= best.hits) continue;
    const text = line.toLowerCase();
    const first = terms
      .map((term) => ({ index: text.indexOf(term), length: term.length }))
      .filter((found) => found.index >= 0)
      .sort((a, b) => a.index - b.index)[0];
    best = { line, hits, index: first?.index ?? 0, length: first?.length ?? 0 };
  }
  return excerpt(best.line, best.index, best.length);
}

/**
 * Ranked keyword search over archived threads (BM25+ through MiniSearch): words in any order,
 * rarer words weigh more. Threads never change once archived, so each is indexed once per
 * session and nothing is ever re-indexed; branches are a filter on the handle.
 */
export class RecallIndex {
  private readonly index = new MiniSearch<Chunk>({
    fields: ['text'],
    tokenize,
    processTerm: lower,
    searchOptions: {
      prefix: (term) => isWord(term, 3),
      fuzzy: (term) => (isWord(term, 5) ? 0.2 : false)
    }
  });
  /** Indexed by chunk id. */
  private readonly chunks: Chunk[] = [];
  private readonly indexed = new Set<string>();

  add(threads: readonly SearchableThread[]): void {
    for (const thread of threads) {
      if (this.indexed.has(thread.handle)) continue;
      this.indexed.add(thread.handle);
      const added = chunks(thread.handle, thread.messages, this.chunks.length);
      this.chunks.push(...added);
      this.index.addAll(added);
    }
  }

  /**
   * Chunks holding every word of the query, best first. When none does, chunks holding any of
   * them, with `partial` set so the caller can say so.
   */
  search(
    query: string,
    handles: ReadonlySet<string>
  ): { matches: RecallMatch[]; partial: boolean } {
    const filter = (result: SearchResult) => handles.has(this.chunks[result.id]!.handle);
    let partial = false;
    let results = this.index.search(query, { combineWith: 'AND', filter });
    if (results.length === 0) {
      results = this.index.search(query, { combineWith: 'OR', filter });
      partial = results.length > 0;
    }
    const matches = results.map((result) => {
      const chunk = this.chunks[result.id]!;
      return {
        handle: chunk.handle,
        turn: chunk.turn,
        role: chunk.role,
        line: bestLine(chunk, result.terms)
      };
    });
    return { matches, partial };
  }
}
