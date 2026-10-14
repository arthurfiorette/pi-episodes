import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sub } from '../../../src/add.js';

test('sub', () => {
  assert.equal(sub(5, 3), 2);
  assert.equal(sub(3, 5), -2);
});
