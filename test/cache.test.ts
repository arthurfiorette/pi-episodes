import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchorBreakpoint, cacheAnchor } from '../src/cache.js';
import { assistant, call, result, user } from './helpers.js';

const marker = { type: 'ephemeral' };

function payload(oauth: boolean) {
  const system = [{ type: 'text', text: 'system prompt', cache_control: marker }];
  if (oauth) {
    system.unshift({
      type: 'text',
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
      cache_control: marker
    });
  }
  return {
    system,
    tools: [{ name: 'read' }, { name: 'bash', cache_control: marker }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'go' },
          { type: 'text', text: '[t1]' }
        ]
      },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'f1', name: 'fold' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'f1', content: 'note' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'continuing' }] },
      { role: 'user', content: [{ type: 'text', text: 'next', cache_control: marker }] }
    ]
  };
}

function breakpoints(value: ReturnType<typeof payload>): number {
  return JSON.stringify(value).split('"cache_control"').length - 1;
}

test('adds a breakpoint after the latest note when one is free', () => {
  const value = payload(false);
  assert.equal(anchorBreakpoint(value, { toolUseId: 'f1' }), value);
  assert.deepEqual(value.messages[2]!.content[0], {
    type: 'tool_result',
    tool_use_id: 'f1',
    content: 'note',
    cache_control: marker
  });
  assert.equal(breakpoints(value), 4);
});

test('with OAuth, moves the identity breakpoint instead of exceeding four', () => {
  const value = payload(true);
  assert.equal(anchorBreakpoint(value, { toolUseId: 'f1' }), value);
  assert.equal(value.system[0]!.cache_control, undefined);
  assert.equal(value.system[1]!.cache_control, marker);
  assert.equal(breakpoints(value), 4);
});

test('leaves the payload alone when there is nothing to do', () => {
  assert.equal(anchorBreakpoint(payload(false), undefined), undefined);
  assert.equal(anchorBreakpoint(payload(false), { toolUseId: 'unknown' }), undefined);
  assert.equal(anchorBreakpoint({ input: [], model: 'gpt' }, { toolUseId: 'f1' }), undefined);

  const tail = payload(false);
  tail.messages[2]!.content[0] = { ...tail.messages[2]!.content[0]!, cache_control: marker };
  assert.equal(anchorBreakpoint(tail, { toolUseId: 'f1' }), undefined);

  const uncached = payload(false);
  uncached.system[0] = { type: 'text', text: 'system prompt' } as (typeof uncached.system)[0];
  delete (uncached.tools[1] as Record<string, unknown>).cache_control;
  delete (uncached.messages[4]!.content[0] as Record<string, unknown>).cache_control;
  assert.equal(anchorBreakpoint(uncached, { toolUseId: 'f1' }), undefined);
});

test('anchors on a stamped user message when no note is newer', () => {
  const value = payload(false);
  assert.equal(anchorBreakpoint(value, { stamp: '[t1]' }), value);
  assert.deepEqual(value.messages[0]!.content[1], {
    type: 'text',
    text: '[t1]',
    cache_control: marker
  });
});

test('the anchor is the newest note or stamped user message', () => {
  const note = result('f1', 'fold', 'note', 3);
  assert.deepEqual(cacheAnchor([user('go', 1), assistant(call('f1', 'fold')), note]), {
    toolUseId: 'f1'
  });
  assert.deepEqual(
    cacheAnchor([user('go', 1), assistant(call('f1', 'fold')), note, user('next', 4)]),
    {
      stamp: '[t4]'
    }
  );
  assert.equal(cacheAnchor([user('unstamped')]), undefined);
});

test('takes the TTL of the conversation breakpoint and matches rewritten tool ids', () => {
  const value = payload(false);
  const tail = { type: 'ephemeral', ttl: '5m' };
  value.system[0]!.cache_control = { type: 'ephemeral', ttl: '1h' } as typeof marker;
  value.messages[4]!.content[0] = { type: 'text', text: 'next', cache_control: tail };
  value.messages[2]!.content[0] = {
    type: 'tool_result',
    tool_use_id: 'call_1_fc_2',
    content: 'note'
  };

  assert.equal(anchorBreakpoint(value, { toolUseId: 'call_1|fc_2' }), value);
  assert.equal((value.messages[2]!.content[0] as Record<string, unknown>).cache_control, tail);
});
