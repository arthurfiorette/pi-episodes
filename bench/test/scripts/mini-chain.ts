/**
 * Faux script for `bench/test/fixtures/mini-chain`. Goal-1 adds `mul` to `src/add.js` with a
 * test and runs it; the aside and the probe are answered; goal-2 adds `sub`. Under B the model
 * also folds goal-1 once its test passes, and in goal-2 recalls the fold once with a hit and
 * once with a query that finds nothing.
 */
import type { JsonObject } from '@earendil-works/pi-ai';
import {
  type FauxScript,
  type FauxScriptInfo,
  type FauxStep,
  fauxAssistantMessage,
  fauxToolCall,
  lastText
} from '../../src/faux.js';

const ADD_MUL = `export function add(a, b) {
  return a + b;
}

export function mul(a, b) {
  return a * b;
}
`;

const MUL_TEST = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mul } from '../src/add.js';

test('mul', () => {
  assert.equal(mul(2, 3), 6);
  assert.equal(mul(0, 9), 0);
});
`;

const SUB_TEST = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sub } from '../src/add.js';

test('sub', () => {
  assert.equal(sub(5, 3), 2);
});
`;

const STAMP = /\[(t\d+)\]\s*$/;

function tool(name: string, args: JsonObject): FauxStep {
  return () => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
}

export function steps(info: FauxScriptInfo): FauxStep[] {
  // Stamp of the first tool result in goal-1: the span to fold starts there, so the user
  // message that opened the goal stays in context.
  let since = 't2';
  const goal1: FauxStep[] = [
    tool('read', { path: 'src/add.js' }),
    (context) => {
      since = STAMP.exec(lastText(context))?.[1] ?? since;
      return fauxAssistantMessage(fauxToolCall('write', { path: 'src/add.js', content: ADD_MUL }), {
        stopReason: 'toolUse'
      });
    },
    tool('write', { path: 'test/mul.test.js', content: MUL_TEST }),
    tool('bash', { command: 'node --test test/mul.test.js' }),
    ...(info.episodes
      ? [
          (): ReturnType<FauxStep> =>
            fauxAssistantMessage(
              fauxToolCall('fold', {
                since,
                note: 'Added mul(a, b) to src/add.js next to add; test/mul.test.js passes.\n- Open: none.'
              }),
              { stopReason: 'toolUse' }
            )
        ]
      : []),
    () => fauxAssistantMessage('Added `mul` to `src/add.js` with a test in `test/mul.test.js`.')
  ];
  const aside: FauxStep[] = [() => fauxAssistantMessage('`add(2, 3)` returns 5.')];
  const goal2: FauxStep[] = [
    ...(info.episodes
      ? [tool('recall', { query: 'mul' }), tool('recall', { query: 'zzz-nothing-matches-this' })]
      : []),
    tool('edit', {
      path: 'src/add.js',
      edits: [
        {
          oldText: 'export function mul(a, b) {\n  return a * b;\n}\n',
          newText:
            'export function mul(a, b) {\n  return a * b;\n}\n\nexport function sub(a, b) {\n  return a - b;\n}\n'
        }
      ]
    }),
    tool('write', { path: 'test/sub.test.js', content: SUB_TEST }),
    tool('bash', { command: 'node --test test/sub.test.js' }),
    () => fauxAssistantMessage('Added `sub` to `src/add.js` with `test/sub.test.js`.')
  ];
  const probe: FauxStep[] = [() => fauxAssistantMessage('I added `mul` to `src/add.js`.')];
  return [...goal1, ...aside, ...goal2, ...probe];
}

const script: FauxScript = { steps };
export default script;
