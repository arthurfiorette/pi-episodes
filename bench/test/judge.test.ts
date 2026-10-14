import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mergeJudgedProbes, parseJudgeArgs, runJudge } from '../src/commands/judge.js';
import { activeBranch, readForkArchives, readSession } from '../src/jsonl.js';
import {
  analyzeTrial,
  askJudge,
  cohenKappa,
  evidenceInInput,
  foldExtract,
  JUDGE_PROMPT_TAIL,
  JUDGE_SYSTEM_PROMPT,
  judgeExtracts,
  judgePrompt,
  judgeTrial,
  kappaReport,
  loadJudgeConfig,
  markerTokens,
  modelFamily,
  noteSection,
  nullCheck,
  pickJudgeModel,
  readLabels,
  relPath,
  sameFamily,
  scriptRubrics,
  type TrialInput,
  tokens
} from '../src/judge.js';
import type {
  ChecksJson,
  JudgeExtract,
  JudgeJson,
  RubricItem,
  Scenario,
  Step,
  StepResult,
  TrialAudit,
  TrialRecord
} from '../src/types.js';

const fixtures = fileURLToPath(new URL('./fixtures/sessions', import.meta.url));
const miniChain = fileURLToPath(new URL('./fixtures/mini-chain', import.meta.url));

function steps(list: [id: string, kind: StepResult['kind'], requests: number][]): StepResult[] {
  return list.map(([id, kind, count], index) => ({
    id,
    kind,
    startedAt: new Date(index * 60_000).toISOString(),
    end: 'settled',
    requests: count,
    toolCalls: {},
    compactions: 0,
    retries: 0,
    errors: []
  }));
}

function scenarioOf(
  stepSpecs: (Partial<Step> & { id: string; kind: Step['kind'] })[],
  traps: Scenario['traps'] = {},
  finalTraps: string[] = []
): Scenario {
  return {
    id: 'test',
    dir: '/test',
    repo: { source: '/test' },
    features: [],
    revertOrder: [],
    steps: stepSpecs.map((spec) => ({ prompt: '', text: spec.id, ...spec })),
    final: { traps: finalTraps, allowedSchemaChanges: [] },
    variants: [],
    traps,
    layout: { dir: 'test/{id}', test: 'index.test.js' }
  };
}

function load(
  name: string,
  record: StepResult[],
  scenario: Scenario,
  options: { condition?: string; checks?: ChecksJson } = {}
): TrialInput {
  const path = join(fixtures, `${name}.jsonl`);
  const session = readSession(path);
  const input: TrialInput = {
    id: name,
    branch: activeBranch(session.entries),
    cwd: session.header?.cwd ?? '',
    scenario,
    trialRecord: { steps: record, condition: options.condition ?? 'B@abc' },
    archives: readForkArchives(path)
  };
  if (options.checks) input.checks = options.checks;
  return input;
}

function finalChecks(traps: Record<string, boolean>): ChecksJson {
  return {
    steps: [],
    final: { snapshot: 'final', fixtures: {}, variants: {}, traps, flags: [], score: 1 },
    answers: [],
    category: 'passed',
    flags: []
  };
}

function byRubric(items: readonly RubricItem[], rubric: string): RubricItem[] {
  return items.filter((item) => item.rubric === rubric);
}

function one(items: readonly RubricItem[], rubric: string, subject: RegExp | string): RubricItem {
  const found = byRubric(items, rubric).filter((item) =>
    typeof subject === 'string' ? item.subject === subject : subject.test(item.subject)
  );
  assert.equal(
    found.length,
    1,
    `${rubric} ${subject}: ${JSON.stringify(found.map((item) => item.subject))}`
  );
  return found[0]!;
}

const BOUNDARY_STEPS = steps([
  ['goal-1', 'goal', 4],
  ['aside', 'aside', 1],
  ['goal-2', 'goal', 6],
  ['probe-1', 'probe', 1]
]);
const BOUNDARY_SCENARIO = scenarioOf(
  [
    {
      id: 'goal-1',
      kind: 'goal',
      endEvent: 'tests_pass',
      trailing: ['console.log in src/add.js'],
      trap: 'debug-print',
      mustCarry: [{ fact: 'mul lives in src/add.js next to add', condition: 'only when exported' }],
      rejected: ['a separate mul.js module']
    },
    { id: 'aside', kind: 'aside', answer: { kind: 'fixed', pattern: '5' } },
    { id: 'goal-2', kind: 'goal', endEvent: 'tests_pass', trailing: ['run the tests'] },
    { id: 'probe-1', kind: 'probe', answer: { kind: 'abstain' } }
  ],
  { 'debug-print': { files: ['src/add.js'], mustBeUnchanged: false, grep: 'console\\.' } },
  ['debug-print']
);

test('j-boundary: a fold after the step end passes a1-a4, a mid-step fold fails a1, a3 and a4', () => {
  const items = scriptRubrics(
    load('j-boundary', BOUNDARY_STEPS, BOUNDARY_SCENARIO, {
      checks: finalChecks({ 'debug-print': true })
    })
  );
  const handles = [...new Set(byRubric(items, 'a1').map((item) => item.subject))];
  assert.equal(handles.length, 2);
  const [first, second] = handles as [string, string];

  // Fold 1: since t2 (goal-1's first result), called at r5, two turns after goal-1 ended at r3.
  assert.equal(one(items, 'a1', first).pass, true);
  assert.equal(one(items, 'a1', first).value, 2);
  assert.equal(one(items, 'a2', first).pass, true);
  assert.equal(one(items, 'a2', first).value, 0);
  assert.equal(one(items, 'a3', first).pass, true);
  assert.equal(one(items, 'a4', first).pass, true);
  // Fold 2: since t8 inside goal-2, called at r8 before goal-2's final reply at r10, and its
  // archived command is rerun at r9 without a recall.
  assert.equal(one(items, 'a1', second).pass, false);
  assert.equal(one(items, 'a1', second).value, -2);
  assert.equal(one(items, 'a2', second).pass, true);
  assert.equal(one(items, 'a2', second).value, 0);
  assert.equal(one(items, 'a3', second).pass, false);
  assert.match(one(items, 'a3', second).evidence, /before the end event of goal step goal-2/);
  assert.equal(one(items, 'a4', second).pass, false);
  assert.match(one(items, 'a4', second).evidence, /reran "echo \\"sub: 1 failing\\"" at r9/);

  // b5: t5 (the aside) is kept inside fold 1's span and listed under Handled; t6, the prompt
  // the fold answers, is not a handled message.
  assert.deepEqual(
    byRubric(items, 'b5').map((item) => [item.subject, item.pass]),
    [[`${first}:t5`, true]]
  );
  // b6: both trailing markers are under Open.
  assert.equal(one(items, 'b6', `${first}:console.log in src/add.js`).pass, true);
  assert.equal(one(items, 'b6', `${second}:run the tests`).pass, true);

  // c: the edit at r7 touches fold 1's file with no recall anywhere; the rerun at r9 repeats
  // fold 2's command and error line.
  assert.deepEqual(
    byRubric(items, 'c1').map((item) => item.subject),
    [
      `edit@r7:${first}:src/add.js`,
      `command@r9:${second}:echo "sub: 1 failing"`,
      `error@r9:${second}:sub: 1 failing`
    ]
  );
  assert.ok(byRubric(items, 'c2').every((item) => item.pass === false));
  assert.equal(one(items, 'c3', `edit@r7:${first}:src/add.js`).pass, true);
  assert.equal(one(items, 'c3', `command@r9:${second}:echo "sub: 1 failing"`).pass, false);
  assert.equal(byRubric(items, 'c6').length, 0);

  // d: the trap file is in fold 1's files (proxy), named under Open, the reminder names the
  // handle, and checks.json says it was reverted.
  const d1 = one(items, 'd1', `${first}:debug-print`);
  assert.equal(d1.pass, true);
  assert.match(d1.evidence, /proxy .*src\/add\.js in the fold's files/);
  assert.equal(one(items, 'd2', `${first}:debug-print`).pass, true);
  const d3 = one(items, 'd3', `${first}:debug-print`);
  assert.equal(d3.pass, true);
  assert.match(d3.evidence, new RegExp(`reminder names ${first}`));
  assert.equal(one(items, 'd4', 'debug-print').pass, true);
  assert.equal(byRubric(items, 'e1').length, 0);
});

test('d1 reads the tree at treeAfter when the objects are available', () => {
  const withTree = (content: string | undefined, baseTree?: string) => {
    const input = load('j-boundary', BOUNDARY_STEPS, BOUNDARY_SCENARIO);
    if (baseTree !== undefined) input.trialRecord.baseTree = baseTree;
    input.readTreeFile = (tree, path) =>
      path === 'src/add.js' ? (tree === 'base' ? 'export const add = 1;\n' : content) : undefined;
    return scriptRubrics(input);
  };
  const found = withTree("export const mul = 1;\nconsole.log('debug');\n");
  const d1 = one(found, 'd1', /:debug-print$/);
  assert.equal(d1.pass, true);
  assert.match(d1.evidence, /^tree [0-9a-f]{12}: src\/add\.js matches \/console\\\.\//);
  assert.equal(byRubric(found, 'd2').length, 1);

  const clean = withTree('export const mul = 1;\n');
  assert.equal(one(clean, 'd1', /:debug-print$/).pass, false);
  assert.match(
    one(clean, 'd1', /:debug-print$/).evidence,
    /^tree [0-9a-f]{12}: no trap file matches/
  );
  assert.equal(byRubric(clean, 'd2').length, 0);
  assert.equal(byRubric(clean, 'd3').length, 0);

  // A trap without a grep needs the sealed tree to compare against.
  const scenario = scenarioOf(
    BOUNDARY_SCENARIO.steps.map((step) =>
      step.trap === undefined ? step : { ...step, trap: 'unchanged' }
    ),
    { unchanged: { files: ['src/add.js'], mustBeUnchanged: true } },
    ['unchanged']
  );
  const input = load('j-boundary', BOUNDARY_STEPS, scenario);
  input.trialRecord.baseTree = 'base';
  input.readTreeFile = (tree, path) => (path === 'src/add.js' ? `${tree}-content` : undefined);
  assert.match(
    one(scriptRubrics(input), 'd1', /:unchanged$/).evidence,
    /differs from the sealed tree/
  );
  delete input.trialRecord.baseTree;
  assert.match(one(scriptRubrics(input), 'd1', /:unchanged$/).evidence, /^proxy/);
});

test('j-boundary: judge extracts cover b1-b4, b7, probes, c4 and c5 with the right blocks', () => {
  const input = load('j-boundary', BOUNDARY_STEPS, BOUNDARY_SCENARIO);
  const extracts = judgeExtracts(input);
  const rubrics = (id: string) => extracts.filter((extract) => extract.rubric === id);
  assert.equal(rubrics('b1').length, 2);
  assert.deepEqual(
    rubrics('b1')[0]!.blocks.map((block) => block.name),
    ['headline']
  );
  assert.equal(rubrics('b1')[0]!.blocks[0]!.text, 'mul added to src/add.js: tests pass (2/2).');
  assert.equal(rubrics('b2').length, 2);
  assert.match(rubrics('b2')[0]!.blocks[1]!.text, /^- Sub added to src\/add\.js/);
  assert.equal(rubrics('b3').length, 1);
  assert.equal(rubrics('b3c').length, 1);
  assert.deepEqual(
    rubrics('b3')[0]!.blocks.map((block) => block.name),
    ['note', 'fact', 'condition']
  );
  assert.equal(rubrics('b4').length, 1);
  assert.equal(rubrics('b4')[0]!.blocks[1]!.text, 'a separate mul.js module');
  const b7 = rubrics('b7');
  assert.equal(b7.length, 1);
  assert.equal(b7[0]!.subject, 'probe-1');
  assert.equal(b7[0]!.blocks[0]!.text, 'which file holds mul?');
  assert.match(b7[0]!.blocks[2]!.text, /^\[r11\] assistant: mul is in src\/add\.js\./);
  assert.equal(rubrics('probes').length, 1);
  // c4 only for the edit trigger that neither recalled nor re-derived.
  const c4 = rubrics('c4');
  assert.equal(c4.length, 1);
  assert.match(c4[0]!.subject, /^edit@r7:/);
  assert.match(
    c4[0]!.blocks[1]!.text,
    /^learned: mul lives in src\/add\.js next to add, only when exported\./
  );
  assert.match(c4[0]!.blocks[2]!.text, /\[r7\] assistant: edit\(/);
  assert.doesNotMatch(c4[0]!.blocks[2]!.text, /\[t12\] user/);
  assert.equal(rubrics('c5').length, 1);
  assert.equal(rubrics('d5').length, 0);
  assert.equal(rubrics('e3').length, 0);

  // The common fold extract of DESIGN 9, for a5 and for reading a fold by hand.
  const analysis = analyzeTrial(input);
  const blocks = foldExtract(analysis, analysis.folds[0]!);
  assert.deepEqual(
    blocks.map((block) => block.name),
    ['note', 'span', 'before', 'after', 'siblings', 'step']
  );
  assert.match(blocks[1]!.text, /^\[r0\] assistant: write\(/);
  assert.match(blocks[1]!.text, /\[t5\] user: quick aside/);
  assert.match(blocks[2]!.text, /\[t1\] user: implement mul$/);
  assert.match(blocks[3]!.text, /^\[r6\] assistant: bash/);
  assert.match(blocks[5]!.text, /"trailing": \[\s*"console\.log in src\/add\.js"/);
});

const TRIGGER_STEPS = steps([
  ['goal-1', 'goal', 4],
  ['goal-2', 'goal', 6],
  ['aside', 'aside', 6],
  ['goal-3', 'goal', 4]
]);
const TRIGGER_SCENARIO = scenarioOf([
  { id: 'goal-1', kind: 'goal', endEvent: 'tests_pass' },
  { id: 'goal-2', kind: 'goal', endEvent: 'tests_pass' },
  { id: 'aside', kind: 'aside', answer: { kind: 'fixed', pattern: 'x' } },
  { id: 'goal-3', kind: 'goal', endEvent: 'tests_pass' }
]);

test('j-triggers: recall after a trigger, spurious recall, staleness followed by a re-read or not', () => {
  const input = load('j-triggers', TRIGGER_STEPS, TRIGGER_SCENARIO);
  const items = scriptRubrics(input);
  const handle = one(items, 'a1', /^ep-/).subject;
  assert.equal(one(items, 'a1', handle).value, 1);

  const triggers = byRubric(items, 'c1').map((item) => item.subject);
  assert.deepEqual(triggers, [
    `edit@r7:${handle}:src/app.js`,
    `command@r8:${handle}:echo "error TS2322 in src/app.js"`,
    `error@r8:${handle}:error TS2322 in src/app.js`,
    `user@r16:${handle}:src/app.js`,
    `edit@r18:${handle}:src/app.js`
  ]);
  // The recall at r6 shares "app.js" with the edit at r7; the one at r16 shares the path the
  // user named and the edit at r18.
  const c2 = one(items, 'c2', `edit@r7:${handle}:src/app.js`);
  assert.equal(c2.pass, true);
  assert.match(c2.evidence, /recall\("app\.js TS2322"\) at r6 shares app\.js/);
  assert.equal(one(items, 'c2', `user@r16:${handle}:src/app.js`).pass, true);
  assert.equal(one(items, 'c2', `edit@r18:${handle}:src/app.js`).pass, true);
  // The read at r17 follows the recall at r16, so it is not a re-derivation.
  assert.equal(one(items, 'c3', `edit@r18:${handle}:src/app.js`).pass, true);

  const c6 = byRubric(items, 'c6');
  assert.deepEqual(
    c6.map((item) => [item.requestIndex, item.pass, item.value]),
    [
      [6, true, 4],
      [12, false, 0],
      [16, true, 2]
    ]
  );
  assert.match(c6[1]!.evidence, /no trigger in r9-r15, 0 hit\(s\)/);

  const e1 = byRubric(items, 'e1');
  assert.deepEqual(
    e1.map((item) => item.subject),
    [`recall@r6:${handle}`, `recall@r16:${handle}`]
  );
  const stale1 = one(items, 'e2', `recall@r6:${handle}`);
  assert.equal(stale1.pass, false);
  assert.match(stale1.evidence, /edit on src\/app\.js at r7 with no read of it/);
  const stale2 = one(items, 'e2', `recall@r16:${handle}`);
  assert.equal(stale2.pass, true);
  assert.match(stale2.evidence, /read src\/app\.js before edit on it at r18/);
  assert.deepEqual(
    byRubric(items, 'e4').map((item) => [item.subject, item.pass]),
    [[`recall@r6:${handle}`, 'pending']]
  );

  const e3 = judgeExtracts(input).filter((extract) => extract.rubric === 'e3');
  assert.equal(e3.length, 1);
  assert.equal(e3[0]!.subject, `recall@r6:${handle}`);
  assert.deepEqual(
    e3[0]!.blocks.map((block) => block.name),
    ['staleness', 'result', 'turns']
  );
  assert.match(e3[0]!.blocks[2]!.text, /^\[r7\] assistant: edit\(/);
});

const EPISODES_STEPS = steps([
  ['goal-1', 'goal', 5],
  ['aside', 'aside', 10],
  ['probe-1', 'probe', 2]
]);
const EPISODES_SCENARIO = scenarioOf(
  [
    {
      id: 'goal-1',
      kind: 'goal',
      endEvent: 'tests_pass',
      trap: 'debug-flag',
      trailing: ['debug flag']
    },
    { id: 'aside', kind: 'aside', answer: { kind: 'fixed', pattern: 'x' } },
    { id: 'probe-1', kind: 'probe', answer: { kind: 'abstain' } }
  ],
  { 'debug-flag': { files: ['a.txt'], mustBeUnchanged: true, grep: 'debug' } },
  ['debug-flag']
);

test('b-episodes: a fold right before the final reply fails a1 and a3; recalls with no trigger are spurious', () => {
  const items = scriptRubrics(load('b-episodes', EPISODES_STEPS, EPISODES_SCENARIO));
  const [first, second] = byRubric(items, 'a1').map((item) => item.subject) as [string, string];
  assert.equal(one(items, 'a1', first).pass, false);
  assert.equal(one(items, 'a1', first).value, -1);
  assert.equal(one(items, 'a3', first).pass, false);
  // The second fold sits in the aside, not a goal step: no a3 item.
  assert.equal(byRubric(items, 'a3').length, 1);
  assert.equal(one(items, 'a1', second).pass, false);
  // The read of a.txt at r15 is within 3 turns of the second fold, which archived a.txt.
  assert.equal(one(items, 'a4', first).pass, true);
  assert.equal(one(items, 'a4', second).pass, false);
  assert.equal(one(items, 'b6', `${first}:debug flag`).pass, true);
  // Three recalls and an ask with no trigger near them.
  assert.deepEqual(
    byRubric(items, 'c6').map((item) => [item.pass, item.value]),
    [
      [false, 2],
      [false, 0],
      [false, 2],
      [false, undefined]
    ]
  );
  assert.equal(byRubric(items, 'c1').length, 0);
  assert.equal(one(items, 'd1', `${first}:debug-flag`).pass, true);
  assert.equal(one(items, 'd2', `${first}:debug-flag`).pass, true);
  assert.equal(one(items, 'd3', `${first}:debug-flag`).pass, true);
  assert.equal(one(items, 'd4', 'debug-flag').pass, 'pending');
  // Staleness lines on both recalls with hits and on the ask; nothing acted on a.txt later.
  assert.equal(byRubric(items, 'e1').length, 3);
  assert.ok(byRubric(items, 'e2').every((item) => item.pass === true));
  assert.equal(byRubric(items, 'e4').length, 0);
});

test('null check: a plain pi session yields no a, b, d1-d3 or e items; a folding "A" trial is reported', () => {
  const plainScenario = scenarioOf(
    [
      { id: 'goal-1', kind: 'goal', endEvent: 'tests_pass', trap: 'debug-flag' },
      { id: 'probe-1', kind: 'probe', answer: { kind: 'abstain' } }
    ],
    { 'debug-flag': { files: ['a.txt'], mustBeUnchanged: true } },
    ['debug-flag']
  );
  const plain = load(
    'a-plain',
    steps([
      ['goal-1', 'goal', 4],
      ['probe-1', 'probe', 2]
    ]),
    plainScenario,
    { condition: 'A' }
  );
  const items = scriptRubrics(plain);
  assert.deepEqual(
    items.map((item) => [item.rubric, item.pass]),
    [['d4', 'pending']]
  );
  assert.deepEqual(
    judgeExtracts(plain).map((extract) => extract.rubric),
    ['probes']
  );
  const ok = nullCheck([plain, load('b-episodes', EPISODES_STEPS, EPISODES_SCENARIO)]);
  assert.deepEqual(ok, { trials: 1, ok: true, problems: [] });

  const bad = nullCheck([
    load('b-episodes', EPISODES_STEPS, EPISODES_SCENARIO, { condition: 'A' })
  ]);
  assert.equal(bad.ok, false);
  assert.equal(bad.trials, 1);
  assert.ok(
    bad.problems.some((problem) => /a1 item ep-[0-9a-f]{8} on a condition A trial/.test(problem))
  );
  assert.ok(bad.problems.some((problem) => /b1 judge extract/.test(problem)));
});

test('judgePrompt follows the DESIGN 9 shape and evidenceInInput checks the blocks only', () => {
  const extract: JudgeExtract = {
    rubric: 'b1',
    subject: 'ep-00000000',
    requestIndex: 3,
    question: 'Does the first line name a question and how it ended? Quote it.',
    blocks: [
      { name: 'headline', text: 'Build fails with TS2322:\n  fixed by regenerating the client' },
      { name: 'siblings', text: '- Looked back' }
    ]
  };
  const prompt = judgePrompt(extract);
  assert.equal(prompt.system, JUDGE_SYSTEM_PROMPT);
  assert.ok(
    prompt.system.startsWith(
      "You grade one property of a coding agent's transcript. Answer with the JSON object only."
    )
  );
  assert.ok(prompt.user.startsWith(`${extract.question}\n\n<input name="headline">\nBuild fails`));
  assert.ok(prompt.user.includes('</input>\n\n<input name="siblings">\n- Looked back\n</input>'));
  assert.ok(prompt.user.endsWith(`\n\n${JUDGE_PROMPT_TAIL}`));
  assert.equal(evidenceInInput('fixed by regenerating', extract), true);
  assert.equal(evidenceInInput('TS2322: fixed by regenerating', extract), true);
  assert.equal(evidenceInInput('Quote it', extract), false);
  assert.equal(evidenceInInput('   ', extract), false);
});

function stubJudge(
  answers: (string | { answer: 'PASS' | 'FAIL'; evidence: string })[],
  calls: string[] = []
) {
  const queue = [...answers];
  return async (request: { system: string; user: string }): Promise<string> => {
    calls.push(request.user);
    const next = queue.shift();
    if (next === undefined) throw new Error('no stub answer left');
    if (typeof next === 'string') return next;
    return JSON.stringify({ ...next, reason: 'stub' });
  };
}

test('askJudge accepts a verdict whose evidence is in the input, retries once otherwise, then marks invalid', async () => {
  const extract: JudgeExtract = {
    rubric: 'b1',
    subject: 'x',
    requestIndex: 0,
    question: 'Q?',
    blocks: [{ name: 'headline', text: 'mul added to src/add.js: tests pass (2/2).' }]
  };
  const calls: string[] = [];
  const good = await askJudge(
    extract,
    stubJudge(
      [
        '```json\n{"answer": "pass", "evidence": "tests pass (2/2)", "reason": "names outcome"}\n```'
      ],
      calls
    )
  );
  assert.deepEqual(good, {
    status: 'ok',
    attempts: 1,
    answer: 'PASS',
    evidence: 'tests pass (2/2)',
    reason: 'names outcome'
  });
  assert.equal(calls.length, 1);

  const retried = await askJudge(
    extract,
    stubJudge(
      [
        { answer: 'FAIL', evidence: 'not in the input' },
        { answer: 'FAIL', evidence: 'mul added' }
      ],
      calls
    )
  );
  assert.deepEqual(retried, {
    status: 'ok',
    attempts: 2,
    answer: 'FAIL',
    evidence: 'mul added',
    reason: 'stub'
  });
  assert.equal(calls.length, 3);

  const invalid = await askJudge(
    extract,
    stubJudge([{ answer: 'PASS', evidence: 'made up' }, 'no json here'], calls)
  );
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.attempts, 2);
  assert.match(invalid.reason, /no JSON verdict/);
  assert.equal(calls.length, 5);
});

test('judgeTrial fills judged items, refuses when the judge model equals the trial model, keeps other verdicts', async () => {
  const input = load('j-boundary', BOUNDARY_STEPS, BOUNDARY_SCENARIO);
  const extracts = judgeExtracts(input);
  const calls: string[] = [];
  // One PASS per extract, quoting the first line of the first block.
  const callModel = async (request: { system: string; user: string }) => {
    calls.push(request.user);
    const block = /<input name="[^"]+">\n([^\n]*)/.exec(request.user)?.[1] ?? '';
    return JSON.stringify({ answer: 'PASS', evidence: block, reason: 'stub' });
  };
  const judged = await judgeTrial(input, {
    judgeModel: 'anthropic/judge',
    trialModel: 'openai/under-test',
    callModel
  });
  assert.equal(judged.judgeModel, 'anthropic/judge');
  assert.equal(judged.refused, undefined);
  assert.equal(calls.length, extracts.length);
  const b1 = judged.rubrics!.b1!;
  assert.deepEqual([b1.pass, b1.total, b1.pending, b1.invalid], [2, 2, 0, 0]);
  assert.equal(b1.items[0]!.verdicts!['anthropic/judge']!.status, 'ok');
  assert.equal(judged.rubrics!.a1!.total, 2);
  assert.equal(judged.rubrics!.d4!.pending, 1);

  // A dated alias of the judge is still the judge's family: refused.
  const refused = await judgeTrial(input, {
    judgeModel: 'anthropic/judge',
    trialModel: 'anthropic/judge-20250929',
    callModel: async () => {
      throw new Error('must not be called');
    },
    previous: judged
  });
  assert.equal(
    refused.refused,
    "judge model anthropic/judge is the trial model's family (anthropic/judge)"
  );
  assert.equal(refused.rubrics!.b1!.pending, 2);
  assert.equal(refused.rubrics!.b1!.total, 0);
  assert.equal(refused.rubrics!.a1!.total, 2);
  // The earlier judge's verdicts are carried over for kappa.
  assert.equal(refused.rubrics!.b1!.items[0]!.verdicts!['anthropic/judge']!.status, 'ok');

  const scriptsOnly = await judgeTrial(input, { groups: ['a', 'd'] });
  assert.deepEqual(Object.keys(scriptsOnly.rubrics!), [
    'a1',
    'a2',
    'a3',
    'a4',
    'd1',
    'd2',
    'd3',
    'd4'
  ]);
});

test('model families and the per-trial judge choice (DESIGN 9: never the model under test)', () => {
  assert.equal(modelFamily('anthropic/claude-sonnet-4-5-20250929'), 'anthropic/claude-sonnet-4-5');
  assert.equal(modelFamily('anthropic/claude-sonnet-4-5@20250929'), 'anthropic/claude-sonnet-4-5');
  assert.equal(modelFamily('openai/gpt-5-2025-08-07'), 'openai/gpt-5');
  assert.equal(modelFamily('openai/gpt-5-mini'), 'openai/gpt-5-mini');
  assert.equal(modelFamily('google/gemini-2.5-pro-preview'), 'google/gemini-2.5-pro');
  assert.equal(modelFamily('anthropic/claude-3-5-sonnet-latest'), 'anthropic/claude-3-5-sonnet');
  assert.equal(
    sameFamily('anthropic/claude-sonnet-4-5', 'anthropic/claude-sonnet-4-5-20250929'),
    true
  );
  assert.equal(sameFamily('anthropic/claude-sonnet-4-5', 'openai/gpt-5'), false);
  assert.equal(sameFamily('openai/gpt-5', 'openai/gpt-5-mini'), false);

  const models = ['anthropic/claude-sonnet-4-5', 'openai/gpt-5'];
  assert.equal(pickJudgeModel(models, 'anthropic/claude-sonnet-4-5-20250929'), 'openai/gpt-5');
  assert.equal(pickJudgeModel(models, 'openai/gpt-5'), 'anthropic/claude-sonnet-4-5');
  assert.equal(pickJudgeModel(models, 'faux/faux-1'), 'anthropic/claude-sonnet-4-5');
  assert.equal(pickJudgeModel(models, undefined), 'anthropic/claude-sonnet-4-5');
  assert.equal(pickJudgeModel(['openai/gpt-5'], 'openai/gpt-5-2025-08-07'), undefined);
  assert.equal(pickJudgeModel(models, 'openai/gpt-5', 'openai/gpt-5'), 'openai/gpt-5');
});

test('mergeJudgedProbes writes judged abstain answers into checks.json and recomputes score_probe', () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-judge-'));
  try {
    const checks: ChecksJson = {
      steps: [],
      answers: [
        { stepId: 'aside', kind: 'fixed', answer: '5', pass: true },
        { stepId: 'probe-1', kind: 'fixed', answer: 'x', pass: false },
        { stepId: 'probe-4', kind: 'abstain', answer: 'I was not shown it' }
      ],
      scoreProbe: 0.5,
      category: 'passed',
      flags: []
    };
    writeFileSync(join(root, 'checks.json'), JSON.stringify(checks));
    writeFileSync(
      join(root, 'trial.json'),
      JSON.stringify({ steps: [{ id: 'probe-4', kind: 'probe', end: 'settled', requests: 1 }] })
    );
    const judged: JudgeJson = {
      generatedAt: '',
      rubrics: {
        probes: {
          pass: 1,
          total: 1,
          pending: 0,
          invalid: 0,
          items: [
            {
              rubric: 'probes',
              subject: 'probe-4',
              pass: true,
              evidence: 'not shown',
              requestIndex: 9
            }
          ]
        }
      }
    };
    assert.equal(mergeJudgedProbes(root, checks, judged), true);
    const written = JSON.parse(readFileSync(join(root, 'checks.json'), 'utf8')) as ChecksJson;
    assert.equal(written.answers[2]!.pass, true);
    assert.equal(written.scoreProbe, 2 / 3);
    const trial = JSON.parse(readFileSync(join(root, 'trial.json'), 'utf8'));
    assert.equal(trial.steps[0].answerPass, true);
    assert.equal(trial.scores.scoreProbe, 2 / 3);
    // Idempotent; pending or invalid verdicts change nothing.
    assert.equal(mergeJudgedProbes(root, written, judged), false);
    judged.rubrics!.probes!.items[0]!.pass = 'pending';
    assert.equal(mergeJudgedProbes(root, checks, judged), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cohenKappa and kappaReport on a tiny labels set', () => {
  assert.equal(cohenKappa(5, 0, 0, 5), 1);
  assert.equal(cohenKappa(0, 5, 5, 0), -1);
  assert.equal(cohenKappa(0, 0, 0, 0), null);
  assert.equal(cohenKappa(4, 0, 0, 0), null);
  // 3 agreements of 4 with balanced labels: po 0.75, pe 0.5, kappa 0.5.
  assert.ok(Math.abs(cohenKappa(2, 1, 0, 1)! - 0.5) < 1e-12);

  const labels = [
    { run: 'r', trial: 't1', rubric: 'b1', subject: 'ep-1', label: 'PASS' as const },
    { run: 'r', trial: 't1', rubric: 'b1', subject: 'ep-2', label: 'FAIL' as const },
    { run: 'r', trial: 't2', rubric: 'b1', subject: 'ep-3', label: 'PASS' as const },
    { run: 'r', trial: 't2', rubric: 'b1', subject: 'ep-4', label: 'FAIL' as const },
    { run: 'r', trial: 't2', rubric: 'b2', subject: 'ep-3', label: 'PASS' as const },
    { run: 'r', trial: 't9', rubric: 'b1', subject: 'missing', label: 'PASS' as const }
  ];
  const item = (subject: string, verdicts: Record<string, 'PASS' | 'FAIL'>): RubricItem => ({
    rubric: 'b1',
    subject,
    pass: verdicts.m1 === 'PASS',
    evidence: '',
    requestIndex: 0,
    verdicts: Object.fromEntries(
      Object.entries(verdicts).map(([model, answer]) => [
        model,
        { status: 'ok' as const, attempts: 1, answer, evidence: 'x', reason: '' }
      ])
    )
  });
  const judgeJson = (items: RubricItem[]): JudgeJson => ({
    generatedAt: '',
    judgeModel: 'm1',
    rubrics: {
      b1: { pass: 0, total: 0, pending: 0, invalid: 0, items },
      b2: {
        pass: 1,
        total: 1,
        pending: 0,
        invalid: 0,
        items: [{ rubric: 'b2', subject: 'ep-3', pass: true, evidence: '', requestIndex: 0 }]
      }
    }
  });
  const files: Record<string, JudgeJson> = {
    t1: judgeJson([
      item('ep-1', { m1: 'PASS', m2: 'PASS' }),
      item('ep-2', { m1: 'PASS', m2: 'FAIL' })
    ]),
    t2: judgeJson([
      item('ep-3', { m1: 'PASS', m2: 'PASS' }),
      item('ep-4', { m1: 'FAIL', m2: 'FAIL' })
    ])
  };
  const cells = kappaReport(labels, (_run, trial) => files[trial]);
  assert.deepEqual(
    cells.map((cell) => [
      cell.rubric,
      cell.model,
      cell.n,
      cell.tp,
      cell.fp,
      cell.fn,
      cell.tn,
      cell.kappa
    ]),
    [
      ['b1', 'm1', 4, 2, 1, 0, 1, 0.5],
      ['b1', 'm2', 4, 2, 0, 0, 2, 1],
      // b2 has no verdicts map: the file's judge model and `pass` stand in.
      ['b2', 'm1', 1, 1, 0, 0, 0, null]
    ]
  );
});

test('note sections, tokens and relPath', () => {
  const note = [
    'Build fails: fixed.',
    '- Changed: src/a.ts',
    '- Learned: x works, but only inside a transaction',
    '- Decided and rejected: kept y; rejected z because slow',
    '- Handled: t15: correction applied',
    '- Open: remove the debug flag',
    '  in vite.config.ts',
    '',
    'trailing text'
  ].join('\n');
  assert.equal(noteSection(note, 'learned'), 'x works, but only inside a transaction');
  assert.equal(noteSection(note, 'decided'), 'kept y; rejected z because slow');
  assert.equal(noteSection(note, 'handled'), 't15: correction applied');
  assert.equal(noteSection(note, 'open'), 'remove the debug flag in vite.config.ts');
  assert.equal(noteSection('Open: none', 'open'), undefined);
  assert.equal(noteSection('nothing', 'open'), undefined);
  assert.deepEqual(
    [...tokens('echo "error TS2322 in src/api.ts"')],
    ['ts2322', 'src/api.ts', 'api.ts', 'api']
  );
  assert.deepEqual(markerTokens('vega-lite .skip'), ['vega-lite', 'skip']);
  assert.deepEqual(markerTokens('run the tests'), ['run', 'tests']);
  assert.equal(relPath('/var/x/repo', '/private/var/x/repo/src/a.ts'), 'src/a.ts');
  assert.equal(relPath('/var/x/repo', '/var/x/repo/src/a.ts'), 'src/a.ts');
  assert.equal(relPath('/var/x/repo', 'src/a.ts'), 'src/a.ts');
  assert.equal(relPath('/var/x/repo', '/elsewhere/a.ts'), '/elsewhere/a.ts');
});

function writeTrial(
  runDir: string,
  id: string,
  fixture: string,
  record: Partial<TrialRecord> & Pick<TrialRecord, 'condition' | 'steps'>
): void {
  const dir = join(runDir, 'trials', id);
  mkdirSync(dir, { recursive: true });
  cpSync(join(fixtures, `${fixture}.jsonl`), join(dir, 'session.jsonl'));
  if (existsSync(join(fixtures, `${fixture}.episodes`))) {
    cpSync(join(fixtures, `${fixture}.episodes`), join(dir, 'session.episodes'), {
      recursive: true
    });
  }
  const trial: TrialRecord = {
    runId: 'run-1',
    trialId: id,
    model: 'faux',
    chain: 'mini-chain',
    runIndex: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    flags: [],
    category: 'passed',
    ...record
  };
  writeFileSync(join(dir, 'trial.json'), JSON.stringify(trial));
}

test('bench judge writes judge.json per trial and judge-summary.json, withholds on a failed null check, computes kappa', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-judge-'));
  try {
    const runDir = join(root, 'run-1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'manifest.json'),
      JSON.stringify({ runId: 'run-1', scenarios: [{ id: 'mini-chain', dir: miniChain }] })
    );
    writeTrial(runDir, 'faux__A__mini-chain__r01', 'a-plain', {
      condition: 'A',
      steps: steps([
        ['goal-1', 'goal', 4],
        ['probe-1', 'probe', 2]
      ])
    });
    writeTrial(runDir, 'faux__B@abc__mini-chain__r01', 'j-boundary', {
      condition: 'B@abc',
      steps: BOUNDARY_STEPS,
      audit: { model: 'faux/faux-1' } as unknown as TrialAudit
    });
    const configPath = join(root, 'judge.json');
    writeFileSync(
      configPath,
      JSON.stringify({ models: ['anthropic/judge-1'], authPath: 'bench/config/auth.json' })
    );
    const labelsPath = join(root, 'labels.jsonl');
    writeFileSync(labelsPath, '');
    const out: string[] = [];
    const err: string[] = [];
    const deps = {
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      callModel: async (request: { system: string; user: string }) => {
        const block = /<input name="[^"]+">\n([^\n]*)/.exec(request.user)?.[1] ?? '';
        return JSON.stringify({ answer: 'FAIL', evidence: block, reason: 'stub' });
      }
    };
    const options = parseJudgeArgs([runDir, '--config', configPath, '--labels', labelsPath]);
    assert.equal(await runJudge(options, deps), 0);
    assert.ok(out.some((line) => /null check on 1 condition A trial\(s\): ok/.test(line)));
    const a = JSON.parse(
      readFileSync(join(runDir, 'trials', 'faux__A__mini-chain__r01', 'judge.json'), 'utf8')
    ) as JudgeJson;
    assert.equal(a.judgeModel, 'anthropic/judge-1');
    assert.deepEqual(Object.keys(a.rubrics!), ['d4']);
    const b = JSON.parse(
      readFileSync(join(runDir, 'trials', 'faux__B@abc__mini-chain__r01', 'judge.json'), 'utf8')
    ) as JudgeJson;
    assert.equal(b.withheld, undefined);
    assert.equal(b.rubrics!.b1!.total, 2);
    assert.equal(b.rubrics!.b1!.pass, 0);
    assert.equal(b.rubrics!.a1!.pass, 1);
    const summary = JSON.parse(readFileSync(join(runDir, 'judge-summary.json'), 'utf8')) as {
      withheld: boolean;
      conditions: Record<
        string,
        { trials: number; rubrics: Record<string, { pass: number; total: number }> }
      >;
    };
    assert.equal(summary.withheld, false);
    assert.equal(summary.conditions['B@abc']!.rubrics.a1!.total, 2);
    assert.equal(summary.conditions.A!.trials, 1);

    // Rubric filter: only script groups, no model calls.
    const scriptsOnly = parseJudgeArgs([runDir, '--config', configPath, '--rubrics', 'a,d']);
    const { callModel: _unused, ...noModel } = deps;
    assert.equal(await runJudge(scriptsOnly, noModel), 0);
    const filtered = JSON.parse(
      readFileSync(join(runDir, 'trials', 'faux__B@abc__mini-chain__r01', 'judge.json'), 'utf8')
    ) as JudgeJson;
    assert.deepEqual(Object.keys(filtered.rubrics!), [
      'a1',
      'a2',
      'a3',
      'a4',
      'd1',
      'd2',
      'd3',
      'd4'
    ]);

    // Kappa against two labels, one agreeing with the stubbed FAIL verdicts and one not.
    const handle = b.rubrics!.b1!.items[0]!.subject;
    writeFileSync(
      labelsPath,
      [
        JSON.stringify({
          run: 'run-1',
          trial: 'faux__B@abc__mini-chain__r01',
          rubric: 'b1',
          subject: handle,
          label: 'FAIL'
        }),
        JSON.stringify({
          run: 'run-1',
          trial: 'faux__B@abc__mini-chain__r01',
          rubric: 'b1',
          subject: b.rubrics!.b1!.items[1]!.subject,
          label: 'PASS'
        })
      ].join('\n')
    );
    assert.equal(await runJudge(options, deps), 0);
    const kappa = parseJudgeArgs([
      runDir,
      '--config',
      configPath,
      '--labels',
      labelsPath,
      '--kappa'
    ]);
    assert.equal(await runJudge(kappa, deps), 0);
    assert.ok(out.some((line) => /^2 label\(s\) for run-1/.test(line)));
    const cells = (
      JSON.parse(readFileSync(join(runDir, 'judge-kappa.json'), 'utf8')) as {
        cells: { rubric: string; n: number; tn: number; fn: number }[];
      }
    ).cells;
    assert.deepEqual(
      cells.map((cell) => [cell.rubric, cell.n, cell.tn, cell.fn]),
      [['b1', 2, 1, 1]]
    );
    assert.equal(readLabels(labelsPath).length, 2);

    // A condition A trial that folds breaks the null check: everything is withheld.
    writeTrial(runDir, 'faux__A__mini-chain__r02', 'b-episodes', {
      condition: 'A',
      steps: steps([
        ['goal-1', 'goal', 5],
        ['aside', 'aside', 10],
        ['probe-1', 'probe', 2]
      ])
    });
    assert.equal(await runJudge(options, deps), 1);
    assert.ok(
      err.some((line) => /rubric or extractor invalid|null check: /.test(line)) ||
        out.some((line) => /rubric or extractor invalid/.test(line))
    );
    const withheld = JSON.parse(
      readFileSync(join(runDir, 'trials', 'faux__B@abc__mini-chain__r01', 'judge.json'), 'utf8')
    ) as JudgeJson;
    assert.equal(withheld.withheld, true);
    assert.equal(withheld.rubrics, undefined);
    assert.match(withheld.reason!, /null check failed: .*a1 item ep-/);
    const nullOnly = parseJudgeArgs([runDir, '--config', configPath, '--null-check']);
    assert.equal(await runJudge(nullOnly, deps), 1);

    const config = loadJudgeConfig(configPath);
    assert.deepEqual(config.models, ['anthropic/judge-1']);
    assert.ok(config.authPath.endsWith('/bench/config/auth.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
