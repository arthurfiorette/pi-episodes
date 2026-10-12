import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ThreadRecord } from '../src/archive.js';
import { reminderText } from '../src/reminder.js';

function record(handle: string, open: string): ThreadRecord {
  return {
    kind: 'fold',
    handle,
    since: 't1',
    firstEntryId: 'a',
    lastEntryId: 'b',
    messages: 2,
    tokens: 100,
    headline: `episode ${handle}`,
    open,
    keptUserTurns: [],
    files: []
  };
}

test('lists the newest threads first and stays within the token budget', () => {
  const text = reminderText([record('ep-1', 'old item'), record('ep-2', 'new item')], 300)!;
  const lines = text.split('\n');
  assert.match(lines[1]!, /^- ep-2 \(episode ep-2\): new item$/);
  assert.match(lines[2]!, /^- ep-1/);

  const tight = reminderText(
    [record('ep-1', 'x'.repeat(200)), record('ep-2', 'y'.repeat(200))],
    60
  )!;
  assert.ok(tight.length <= 60 * 4 + 80);
  assert.match(tight, /older thread\(s\) with open items/);
  assert.equal(reminderText([], 300), undefined);
});
