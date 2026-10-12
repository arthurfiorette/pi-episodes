import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { convertToLlm, type SessionManager } from '@earendil-works/pi-coding-agent';
import { headline, planFold, renderNote, USER_TEXT_CAP } from '../src/fold.js';
import { readStamp } from '../src/stamps.js';
import { assistant, call, result, session, user } from './helpers.js';

function apply(manager: SessionManager, edits: ReturnType<typeof planFold>['edits']): void {
  for (const edit of edits) manager.appendContextEdit(edit.targetId, edit.replacement);
}

function roles(messages: readonly AgentMessage[]): string[] {
  return messages.filter((message) => message.role !== 'system').map((message) => message.role);
}

/** Every tool call must be followed by its result, or the provider rejects the request. */
function assertPaired(messages: readonly AgentMessage[]): void {
  const llm = convertToLlm([...messages]);
  const results = new Set(
    llm.flatMap((message) => (message.role === 'toolResult' ? [message.toolCallId] : []))
  );
  const calls = new Set(
    llm.flatMap((message) =>
      message.role === 'assistant'
        ? message.content.flatMap((block) => (block.type === 'toolCall' ? [block.id] : []))
        : []
    )
  );
  assert.deepEqual([...results].sort(), [...calls].sort());
}

const buildLoop = [
  user('add the claim endpoint', 1),
  assistant('reading', call('c1', 'read', { path: 'src/claim.ts' })),
  result('c1', 'read', 'export function claim() {}', 2),
  assistant(call('c2', 'bash', { command: 'pnpm build' })),
  result('c2', 'bash', 'src/client/api.ts(12,5): error TS2322', 3),
  user('do not edit generated files', 4),
  assistant(call('c3', 'bash', { command: 'pnpm generate && pnpm build' })),
  result('c3', 'bash', 'build passed', 5),
  assistant('The build passes.', call('f1', 'fold', { since: 't2' }))
];

test('folds from the response behind since and keeps user messages from the span', () => {
  const { manager, ids } = session(buildLoop);
  // t3 is the first build output; the span starts at the response that ran the build.
  const plan = planFold(manager.buildSessionProjection().entries, 'f1', 3);

  assert.match(plan.handle, /^ep-[0-9a-f]{8}$/);
  assert.equal(plan.anchorStamp, 2);
  assert.equal(plan.firstEntryId, ids[3]);
  assert.equal(plan.lastEntryId, ids[7]);
  assert.deepEqual(plan.keptUserTurns, ['t4']);
  assert.equal(plan.omitted.length, 4);
  assert.deepEqual(
    plan.edits.map((edit) => [edit.targetId, edit.replacement]),
    [ids[3], ids[4], ids[6], ids[7]].map((id) => [id, null])
  );

  apply(manager, plan.edits);
  manager.appendMessage(result('f1', 'fold', 'note', 6));
  const view = manager.buildSessionProjection().messages;

  assert.deepEqual(roles(view), [
    'user',
    'assistant',
    'toolResult',
    'user',
    'assistant',
    'toolResult'
  ]);
  assert.equal(readStamp(view.filter((message) => message.role === 'user')[1]!), 4);
  assertPaired(view);
});

test('a stamp on one result of a parallel batch folds the whole batch', () => {
  const { manager, ids } = session([
    user('go', 1),
    assistant(call('a', 'read', { path: 'a.ts' }), call('b', 'read', { path: 'b.ts' })),
    result('a', 'read', 'a', 2),
    result('b', 'read', 'b', 3),
    assistant(call('c', 'bash')),
    result('c', 'bash', 'out', 4),
    assistant(call('f', 'fold'))
  ]);

  const plan = planFold(manager.buildSessionProjection().entries, 'f', 3);
  assert.equal(plan.anchorStamp, 1);
  assert.equal(plan.firstEntryId, ids[1]);
  assert.equal(plan.omitted.length, 5);

  apply(manager, plan.edits);
  manager.appendMessage(result('f', 'fold', 'note'));
  assertPaired(manager.buildSessionProjection().messages);
});

test('refuses to reach behind an earlier fold note', () => {
  const { manager } = session([
    user('go', 1),
    assistant(call('x', 'bash')),
    result('x', 'bash', 'out', 2),
    assistant(call('f0', 'fold')),
    result('f0', 'fold', 'first note', 3),
    assistant(call('y', 'bash')),
    result('y', 'bash', 'out', 4),
    assistant(call('f1', 'fold'))
  ]);
  const entries = manager.buildSessionProjection().entries;

  assert.throws(() => planFold(entries, 'f1', 2), /behind an earlier fold note/);
  // The note's own stamp would fold the note itself.
  assert.throws(() => planFold(entries, 'f1', 3), /behind an earlier fold note/);
  assert.equal(planFold(entries, 'f1', 4).anchorStamp, 3);
});

test('rejects stamps that are missing, after the call, or leave nothing to fold', () => {
  const { manager } = session(buildLoop);
  const entries = manager.buildSessionProjection().entries;

  assert.throws(() => planFold(entries, 'f1', 99), /not in the current context/);
  assert.throws(() => planFold(entries, 'missing', 2), /called fold is not in the current context/);

  const { manager: late } = session([
    user('go', 1),
    assistant(call('x', 'bash')),
    result('x', 'bash', 'out', 2),
    user('one more thing', 3),
    assistant(call('f', 'fold'))
  ]);
  assert.throws(
    () => planFold(late.buildSessionProjection().entries, 'f', 3),
    /holds no responses/
  );
});

test('rejects a second fold call in the same response', () => {
  const { manager } = session([
    user('go', 1),
    assistant(call('x', 'bash')),
    result('x', 'bash', 'out', 2),
    assistant(call('f1', 'fold'), call('f2', 'fold'))
  ]);
  const entries = manager.buildSessionProjection().entries;

  assert.throws(() => planFold(entries, 'f2', 2), /Only one fold per response/);
  assert.equal(planFold(entries, 'f1', 2).anchorStamp, 1);
});

test('caps long user messages in the span but keeps their stamp', () => {
  const paste = 'x'.repeat(USER_TEXT_CAP + 500);
  const { manager, ids } = session([
    user('go', 1),
    assistant(call('x', 'bash')),
    result('x', 'bash', 'out', 2),
    user(paste, 3),
    assistant(call('y', 'bash')),
    result('y', 'bash', 'out', 4),
    assistant(call('f', 'fold'))
  ]);
  const plan = planFold(manager.buildSessionProjection().entries, 'f', 2);
  const edit = plan.edits.find((candidate) => candidate.targetId === ids[3]);

  assert.ok(edit?.replacement);
  const content = edit.replacement.content as { type: string; text: string }[];
  assert.match(content[0]!.text, /500 more characters of this message are in ep-/);
  assert.equal(content.at(-1)!.text, '[t3]');
});

test('omits extension messages inside the span', () => {
  const { manager, ids } = session([
    user('go', 1),
    assistant(call('x', 'bash')),
    result('x', 'bash', 'out', 2)
  ]);
  manager.appendCustomMessageEntry('episodes-fold-request', 'fold now', true);
  const foldId = manager.appendMessage(assistant(call('f', 'fold')));
  const plan = planFold(manager.buildSessionProjection().entries, 'f', 1);

  assert.equal(plan.firstEntryId, ids[0]);
  assert.equal(plan.anchorStamp, undefined);
  assert.equal(plan.edits.length, 3);
  assert.ok(!plan.edits.some((edit) => edit.targetId === foldId));
});

test('renders the note with disk changes, kept turns and the handle', () => {
  const text = renderNote({
    handle: 'ep-12345678',
    since: 't2',
    messages: 4,
    tokens: 41_000,
    note: '## Changed\nregenerated src/client',
    changes: [{ status: 'M', path: '/repo/src/client/api.ts' }],
    touched: [],
    keptUserTurns: ['t4'],
    cwd: '/repo'
  });

  assert.match(text, /^\[fold ep-12345678: 4 messages from t2 on, ~41k tokens, archived\]/);
  assert.match(text, /Changed on disk \(working tree diff\):\nM src\/client\/api\.ts/);
  assert.match(text, /stay above with their stamps: t4\./);
  assert.match(text, /ask\("ep-12345678"/);
  assert.equal(headline('## Changed\nregenerated'), 'Changed');
});
