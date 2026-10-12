import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecallIndex, tokenize } from '../src/search.js';
import { assistant, call, result, user } from './helpers.js';

const build = {
  handle: 'ep-1',
  messages: [
    assistant(call('c1', 'bash', { command: 'pnpm build' })),
    result(
      'c1',
      'bash',
      [
        'error in src/server/routes.ts: unused import',
        'error in src/server/db.ts: unused import',
        'src/client/api.ts(12,5): error TS2322',
        'error in src/server/auth.ts: unused import'
      ].join('\n'),
      2
    ),
    user('do not hand edit generated files', 3),
    assistant('Rather than edit it,\nI will regenerate the client from the OpenAPI spec.')
  ]
};

const lint = {
  handle: 'ep-2',
  messages: [
    assistant(call('c2', 'bash', { command: 'pnpm lint' })),
    result('c2', 'bash', 'error: unused variable in createMatcher', 5)
  ]
};

const all = new Set(['ep-1', 'ep-2']);

function index() {
  const recall = new RecallIndex();
  recall.add([build, lint]);
  return recall;
}

test('splits paths and identifiers into the whole and its parts', () => {
  assert.deepEqual(tokenize('src/client/api.ts(12,5):'), [
    'src/client/api.ts',
    'src',
    'client',
    'api',
    'ts',
    '12',
    '5'
  ]);
  assert.deepEqual(tokenize('createMatcher'), ['createMatcher', 'create', 'Matcher']);
});

test('cites the line holding every query word, not the first line holding one', () => {
  const { matches, partial } = index().search('error TS2322', all);
  assert.equal(partial, false);
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0], {
    handle: 'ep-1',
    turn: 't2',
    role: 'toolResult',
    line: 'src/client/api.ts(12,5): error TS2322'
  });
});

test('matches words in any order across the lines of one message', () => {
  const { matches } = index().search('openapi regenerate client', all);
  assert.equal(matches[0]?.role, 'assistant');
  assert.match(matches[0]!.line, /regenerate the client from the OpenAPI spec/);
});

test('finds a file by name and an identifier by its parts', () => {
  assert.equal(index().search('api.ts', all).matches[0]?.handle, 'ep-1');
  assert.equal(index().search('matcher', all).matches[0]?.handle, 'ep-2');
});

test('tolerates prefixes and typos on words but never on codes', () => {
  assert.equal(index().search('regen', all).matches.length, 1);
  assert.equal(index().search('generted', all).matches.length, 1);
  assert.equal(index().search('TS2323', all).matches.length, 0);
});

test('falls back to any word when no message holds them all, and says so', () => {
  const { matches, partial } = index().search('TS2322 kubernetes', all);
  assert.equal(partial, true);
  assert.match(matches[0]!.line, /TS2322/);
});

test('searches only the given handles, and indexes each thread once', () => {
  const recall = index();
  recall.add([build, lint]);
  const { matches } = recall.search('unused', new Set(['ep-2']));
  assert.deepEqual(
    matches.map((match) => match.handle),
    ['ep-2']
  );
});
