import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStamp, readStamp, unstampedText, withStamp } from '../src/stamps.js';
import { result, user } from './helpers.js';

test('stamps are a trailing block that leaves the original text intact', () => {
  assert.deepEqual(withStamp('hello', 3), [
    { type: 'text', text: 'hello' },
    { type: 'text', text: '[t3]' }
  ]);
  assert.equal(readStamp(user('hello', 3)), 3);
  assert.equal(readStamp(result('c', 'bash', 'out', 12)), 12);
});

test('text that only looks like a stamp is not one', () => {
  assert.equal(readStamp(user('[t3]')), undefined);
  assert.equal(readStamp(result('c', 'bash', 'see [t3]')), undefined);
});

test('since accepts the forms the model is likely to write', () => {
  assert.equal(parseStamp('t12'), 12);
  assert.equal(parseStamp('[t12]'), 12);
  assert.equal(parseStamp(' T12 '), 12);
  assert.equal(parseStamp('12'), 12);
  assert.equal(parseStamp('turn 12'), undefined);
});

test('a copied stamp is replaced, not kept next to the new one', () => {
  assert.deepEqual(withStamp(withStamp('hello', 3), 9), [
    { type: 'text', text: 'hello' },
    { type: 'text', text: '[t9]' }
  ]);
  assert.equal(unstampedText(withStamp('hello', 3)), 'hello');
});
