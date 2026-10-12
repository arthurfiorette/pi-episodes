import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hideStamp } from '../src/display.js';

test('hides the trailing stamp of a user message, and only that', () => {
  assert.equal(
    hideStamp('can you recall without an ep id?[t21]'),
    'can you recall without an ep id?'
  );
  assert.equal(hideStamp('line one\n\nline two\n[t3]\n'), 'line one\n\nline two');
  assert.equal(hideStamp('what happened at [t12] earlier?'), 'what happened at [t12] earlier?');
});
