import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mul } from '../../../src/add.js';

test('mul', () => {
  assert.equal(mul(2, 3), 6);
  assert.equal(mul(-2, 3), -6);
  assert.equal(mul(0, 9), 0);
});
