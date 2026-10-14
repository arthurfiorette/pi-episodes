import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getSystemMessageText } from '@earendil-works/pi-ai';
import { parseStamp as parseStampSrc, readStamp } from '../../src/stamps.js';
import {
  activeBranch,
  appliedFoldHandles,
  compactions,
  contextEdits,
  customEntries,
  customMessages,
  FOLD_APPLIED_TYPE,
  isFoldDetails,
  isForkDetails,
  isThrottledText,
  parseSession,
  parseStamp,
  promptIdFrom,
  promptIdFromSession,
  promptIdFromSystemMessage,
  REMINDER_TYPE,
  readForkArchives,
  readSession,
  requests,
  type SessionEntry,
  sha256,
  stampOf,
  stamps,
  systemMessages,
  textOf,
  toolCalls,
  toolResults,
  usageEntries
} from '../src/jsonl.js';

const fixtures = fileURLToPath(new URL('./fixtures/sessions', import.meta.url));
const episodes = join(fixtures, 'b-episodes.jsonl');

test('readSession parses the header and entries, activeBranch walks parentId from the last entry', () => {
  const session = readSession(episodes);
  assert.equal(session.header?.type, 'session');
  assert.equal(session.header?.version, 3);
  assert.ok(session.entries.length > 40);
  assert.ok(session.entries.every((entry) => entry.type === 'message' || 'parentId' in entry));

  // A linear session: the branch is every entry, in file order.
  const branch = activeBranch(session.entries);
  assert.deepEqual(
    branch.map((entry) => entry.id),
    session.entries.map((entry) => entry.id)
  );
  assert.equal(branch[0]?.parentId, null);
});

test('activeBranch follows the last entry and drops abandoned branches', () => {
  const entry = (id: string, parentId: string | null, text: string): SessionEntry => ({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: text, timestamp: 0 }
  });
  const entries = [
    entry('a', null, 'root'),
    entry('b', 'a', 'first branch'),
    entry('c', 'b', 'first branch leaf'),
    entry('d', 'a', 'second branch'),
    entry('e', 'd', 'second branch leaf')
  ];
  assert.deepEqual(
    activeBranch(entries).map((e) => e.id),
    ['a', 'd', 'e']
  );
});

test('typed accessors over the episodes session', () => {
  const branch = activeBranch(readSession(episodes).entries);
  const main = requests(branch);
  assert.equal(main.length, 17);
  assert.deepEqual(
    main.map((request) => request.index),
    [...Array(17).keys()]
  );
  assert.ok(main.every((request) => typeof request.message.usage.totalTokens === 'number'));

  const byName = (name: string) => toolCalls(branch, name).length;
  assert.equal(byName('bash'), 5);
  assert.equal(byName('fold'), 4);
  assert.equal(byName('recall'), 3);
  assert.equal(byName('ask'), 1);
  assert.equal(byName('fork'), 1);
  assert.equal(toolCalls(branch).length, 15);
  const shared = toolCalls(branch, 'fold').filter((ref) => ref.siblings.length > 0);
  assert.equal(shared.length, 1);
  assert.equal(shared[0]?.siblings[0]?.name, 'bash');

  const folds = toolResults(branch, 'fold');
  assert.equal(folds.length, 4);
  assert.deepEqual(
    folds.map((result) => result.message.isError),
    [false, true, true, false]
  );
  assert.ok(folds.every((result) => result.call?.name === 'fold'));
  assert.ok(folds.every((result) => result.requestIndex >= 0));
  const applied = folds.filter((result) => isFoldDetails(result.message.details));
  assert.equal(applied.length, 2);
  assert.deepEqual(
    appliedFoldHandles(branch),
    new Set(applied.map((r) => (r.message.details as { handle: string }).handle))
  );
  assert.equal(customEntries(branch, FOLD_APPLIED_TYPE).length, 2);

  const fork = toolResults(branch, 'fork')[0];
  assert.ok(fork && isForkDetails(fork.message.details));
  assert.equal(fork.message.details.turns, 2);
  assert.ok(fork.message.usage);

  assert.equal(compactions(branch).length, 0);
  assert.equal(contextEdits(branch).length, 6 + 16);
  assert.equal(customMessages(branch, REMINDER_TYPE).length, 1);
  assert.equal(customMessages(branch).length, 1);
  assert.match(
    textOf(customMessages(branch, REMINDER_TYPE)[0]!.content),
    /^Open items from work folded/
  );
});

test('stamps are read from user messages and tool results only', () => {
  const branch = activeBranch(readSession(episodes).entries);
  const found = stamps(branch);
  const values = [...found.values()];
  assert.equal(values[0], 1);
  // Three user prompts plus 15 tool results on the main thread; the fork child's own messages
  // took stamps from the same counter, so the last read result is t19.
  assert.equal(values.length, 18);
  assert.equal(Math.max(...values), 19);
  for (const entry of branch) {
    if (entry.type !== 'message') continue;
    const stamp = stampOf(entry.message);
    if (entry.message.role === 'assistant' || entry.message.role === 'system') {
      assert.equal(stamp, undefined);
    } else {
      assert.equal(typeof stamp, 'number');
    }
  }
  assert.equal(parseStamp('t12'), 12);
  assert.equal(parseStamp('[t3]'), 3);
  assert.equal(parseStamp('7'), 7);
  assert.equal(parseStamp('banana'), undefined);
  // The copies in jsonl.ts (so any stored session can be analyzed) match src/stamps.ts.
  for (const value of ['t12', '[t3]', '7', ' T4 ', 'banana']) {
    assert.equal(parseStamp(value), parseStampSrc(value), value);
  }
  for (const entry of branch) {
    if (entry.type === 'message') assert.equal(stampOf(entry.message), readStamp(entry.message));
  }
  // textOf drops the trailing stamp block.
  const user = branch.find((entry) => entry.type === 'message' && entry.message.role === 'user');
  assert.ok(user?.type === 'message' && user.message.role === 'user');
  assert.equal(textOf(user.message.content), 'make it build');
  assert.equal(textOf(user.message.content, { keepStamp: true }), 'make it build\n[t1]');
});

test('the prompt id is recomputed from the persisted system message with the DESIGN 2 formula', () => {
  const session = readSession(episodes);
  const systems = systemMessages(activeBranch(session.entries));
  assert.equal(systems.length, 1);
  const system = systems[0]!;
  const section = system.sections?.episodes;
  assert.equal(typeof section, 'string');
  assert.match(
    section as string,
    /^<episodes>\nEvery user message and tool result ends with a turn stamp/
  );
  const descriptions = ['fold', 'recall', 'ask', 'fork'].map(
    (name) => system.toolsAdded!.find((tool) => tool.name === name)!.description
  );
  // sha256(EPISODES_SECTION + "\n" + descriptions): the section's inner text, without the
  // `<episodes>` tags pi wraps it in. This is the id in the trial dir names of a run.
  const inner = (section as string).replace(/^<episodes>\n/, '').replace(/\n<\/episodes>$/, '');
  const expected = sha256(`${inner}\n${descriptions.join('\n')}`).slice(0, 12);
  assert.equal(expected, '3ad2a3039322');
  assert.equal(promptIdFrom(getSystemMessageText(system), descriptions), expected);
  assert.equal(promptIdFromSystemMessage(system), expected);
  assert.equal(promptIdFromSession(session.entries), expected);
  // Same extension build, same id, across sessions.
  assert.equal(
    promptIdFromSession(readSession(join(fixtures, 'b-compaction.jsonl')).entries),
    expected
  );
  // Plain pi has no episodes section.
  assert.equal(
    promptIdFromSession(readSession(join(fixtures, 'a-plain.jsonl')).entries),
    undefined
  );
  assert.equal(promptIdFrom(getSystemMessageText(system), descriptions.slice(1)), undefined);
});

test('isThrottledText: 429 and 5xx status codes, not other numbers', () => {
  for (const text of [
    'HTTP 429 Too Many Requests: rate limit exceeded',
    '503 Service Unavailable',
    'status: 529',
    'overloaded_error: Overloaded',
    'Request failed with status code 502',
    'internal server error'
  ]) {
    assert.equal(isThrottledText(text), true, text);
  }
  for (const text of [
    'HTTP 400 Bad Request: invalid transcript at line 512',
    'request too large: 512 KB',
    'tool_use ids must be unique (600 tokens were skipped)',
    'invalid_request_error: messages.12: unexpected role'
  ]) {
    assert.equal(isThrottledText(text), false, text);
  }
});

test('usageEntries: cache-warming requests are separate entries, none in the fixtures', () => {
  assert.equal(usageEntries(activeBranch(readSession(episodes).entries)).length, 0);
  const entries: SessionEntry[] = [
    {
      type: 'usage',
      id: 'u1',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      kind: 'cache_warm',
      provider: 'anthropic',
      model: 'x',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 100,
        cacheWrite: 0,
        totalTokens: 102,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 }
      }
    }
  ];
  assert.equal(usageEntries(entries).length, 1);
  assert.equal(usageEntries(entries, 'cache_warm').length, 1);
  assert.equal(usageEntries(entries, 'other').length, 0);
});

test('fork archives are read from <session>.episodes', () => {
  const archives = readForkArchives(episodes);
  assert.equal(archives.size, 1);
  const [handle, archive] = [...archives.entries()][0]!;
  assert.match(handle, /^fk-[0-9a-f]{8}$/);
  assert.equal(archive.handle, handle);
  assert.equal(archive.messages.filter((message) => message.role === 'assistant').length, 2);
  const fork = toolResults(activeBranch(readSession(episodes).entries), 'fork')[0];
  assert.ok(fork && isForkDetails(fork.message.details));
  assert.equal(fork.message.details.handle, handle);
  assert.equal(readForkArchives(join(fixtures, 'a-plain.jsonl')).size, 0);
});

test('parseSession tolerates blank and malformed lines', () => {
  const session = parseSession(
    '{"type":"session","version":3,"id":"x","timestamp":"t","cwd":"/"}\n\nnot json\n'
  );
  assert.equal(session.header?.id, 'x');
  assert.deepEqual(session.entries, []);
});
