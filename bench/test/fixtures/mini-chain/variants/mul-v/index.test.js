import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mul } from '../../../src/add.js';

test('mul-v', () => {
  assert.equal(mul(0.5, 4), 2);
  assert.equal(mul(7, 1), 7);
});
