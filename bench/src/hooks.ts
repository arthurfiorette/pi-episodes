import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  type AnswerContext,
  assembleChecks,
  type CheckContext,
  type EscapeRoots,
  escapedTreeFlags,
  finalItems,
  readValidateJson,
  runFinalChecks,
  runStepChecks,
  type SessionOutcome,
  scoreAnswer
} from './checks.js';
import { readForkArchives, readSession, textOf } from './jsonl.js';
import { Logger } from './log.js';
import {
  archiveFinalTree,
  diffTrees,
  ensureNodeModulesTemplate,
  ensureReferenceClone,
  referenceCloneDir,
  type SetupOptions,
  setupTrialRepo,
  snapshotForChecks,
  type TrialRepo,
  teardownTrial
} from './repo.js';
import type {
  AgentDiff,
  AnswerCheck,
  FlagHit,
  Hooks,
  Scenario,
  SnapshotChecks,
  ToolCallRecord,
  TrialContext,
  TrialFinal,
  TrialScores,
  ValidateJson
} from './types.js';

/** Reference clone and `node_modules` template, built once per run per reference dir (DESIGN 5.1). */
interface Prepared {
  refClone: string;
  nodeModulesTemplate?: string;
}

/** What `setup` leaves for the later hooks of the same trial. */
interface TrialState {
  repo: TrialRepo;
  validate?: ValidateJson;
  /** Tree of the previous goal step's snapshot; the per-step `no_src_change` rule diffs against it. */
  previousTree?: string;
  stepChecks: SnapshotChecks[];
  /** Diff of each goal step alone, for the `diff` probe extractors. */
  stepDiffs: Record<string, AgentDiff>;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Tool calls with their result text, from every entry in the file (abandoned branches included:
 * an escape on a branch is still an escape) and from fork transcripts.
 */
export function sessionToolCalls(sessionFile: string): ToolCallRecord[] {
  const messages: AgentMessage[] = [];
  for (const entry of readSession(sessionFile).entries) {
    if (entry.type === 'message') messages.push(entry.message);
  }
  for (const archive of readForkArchives(sessionFile).values()) messages.push(...archive.messages);
  return toolCallRecords(messages);
}

export function toolCallRecords(messages: readonly AgentMessage[]): ToolCallRecord[] {
  const outputs = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'toolResult') outputs.set(message.toolCallId, textOf(message.content));
  }
  const records: ToolCallRecord[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type !== 'toolCall') continue;
      const record: ToolCallRecord = { name: block.name, input: block.arguments };
      const output = outputs.get(block.id);
      if (output !== undefined) record.output = output;
      records.push(record);
    }
  }
  return records;
}

/** DESIGN 5.5 inputs the tree cannot tell: caps, overflow and infra from the run loop, escapes from the session. */
function sessionOutcome(trial: TrialContext, escaped: FlagHit[]): SessionOutcome {
  const outcome: SessionOutcome = {};
  if (escaped.length > 0) outcome.sessionFlags = escaped;
  const category = trial.harness?.category;
  const ends = trial.record.steps.map((step) => step.end);
  if (category === 'infra') outcome.infra = true;
  if (category === 'context_overflow') outcome.contextOverflow = true;
  if (category === 'timeout' || ends.includes('timeout')) outcome.timeout = true;
  if (category === 'turn_cap' || ends.includes('turn_cap')) outcome.turnCap = true;
  return outcome;
}

/**
 * Scores every aside and probe step; a skipped step scores as an empty answer. `fixed` answers
 * were scored by the run loop without `validate.json`; the result here replaces that.
 */
function answerChecks(trial: TrialContext, context: AnswerContext): AnswerCheck[] {
  const checks: AnswerCheck[] = [];
  for (const step of trial.scenario.steps) {
    if (step.kind === 'goal' || step.answer === undefined) continue;
    const result = trial.record.steps.find((candidate) => candidate.id === step.id);
    const check = scoreAnswer(step, result?.answer ?? '', context);
    if (result !== undefined && check.pass !== undefined) result.answerPass = check.pass;
    checks.push(check);
  }
  return checks;
}

/** The `trial.json` scores of a `checks.json`; `bench check` and `bench judge` rewrite them from here too. */
export function scoresOf(checks: {
  steps: SnapshotChecks[];
  scoreCode?: number;
  scoreProbe?: number;
  pass?: boolean;
}): TrialScores {
  const scores: TrialScores = { scoreStep: {} };
  for (const step of checks.steps) {
    if (step.stepId !== undefined) scores.scoreStep[step.stepId] = step.score;
  }
  if (checks.scoreCode !== undefined) scores.scoreCode = checks.scoreCode;
  if (checks.scoreProbe !== undefined) scores.scoreProbe = checks.scoreProbe;
  if (checks.pass !== undefined) scores.pass = checks.pass;
  return scores;
}

/** `repo.ts`, `checks.ts` and the session JSONL behind the `Hooks` contract of `bench run`. */
export function createHooks(): Hooks {
  const prepared = new Map<string, Promise<Prepared>>();
  const states = new WeakMap<TrialContext, TrialState>();

  // Keyed by the reference dir, not the scenario: the three chains share one clone, and with
  // `parallel 2` two trials ask for it at the same moment.
  const prepare = (scenario: Scenario, log: Logger): Promise<Prepared> => {
    const key = referenceCloneDir(scenario);
    let pending = prepared.get(key);
    if (pending === undefined) {
      pending = (async () => {
        const refClone = await ensureReferenceClone(scenario, log);
        const template = await ensureNodeModulesTemplate(refClone, log);
        return template === undefined ? { refClone } : { refClone, nodeModulesTemplate: template };
      })();
      prepared.set(key, pending);
      pending.catch(() => prepared.delete(key));
    }
    return pending;
  };

  const logOf = (trial: TrialContext): Logger => trial.log ?? new Logger({ stderr: false });

  const stateOf = (trial: TrialContext): TrialState => {
    const state = states.get(trial);
    if (state === undefined) throw new Error(`${trial.record.trialId}: setup did not run`);
    return state;
  };

  // The final snapshot diffs against the sealed tree, not the last step's: a chain that ends
  // right after its last goal step has an empty step diff, which is not `no_src_change`.
  const checkContext = (state: TrialState, log: Logger, perStep: boolean): CheckContext => {
    const context: CheckContext = { trial: state.repo, log };
    if (perStep && state.previousTree !== undefined) context.previousTree = state.previousTree;
    if (state.validate !== undefined) context.validate = state.validate;
    return context;
  };

  return {
    async prepare(scenarios, log) {
      for (const scenario of scenarios) await prepare(scenario, log);
    },

    async setup(trial) {
      const log = logOf(trial);
      const { refClone, nodeModulesTemplate } = await prepare(trial.scenario, log);
      const options: SetupOptions = { refClone, log };
      if (nodeModulesTemplate !== undefined) options.nodeModulesTemplate = nodeModulesTemplate;
      const repo = await setupTrialRepo(trial.scenario, trial.tmpDir, options);
      const validate = readValidateJson(trial.scenario.dir);
      states.set(trial, {
        repo,
        ...(validate === undefined ? {} : { validate }),
        stepChecks: [],
        stepDiffs: {}
      });
      return { repoDir: repo.repoDir, baseTree: repo.baseTree };
    },

    async afterGoalStep(trial, step, result) {
      const state = stateOf(trial);
      const log = logOf(trial).child({ step: step.id });
      const items = step.checks ?? { fixtures: [], variants: [] };
      const snapshot = await snapshotForChecks(
        state.repo,
        join(trial.tmpDir, 'snapshots', `step-${step.id}`),
        { fixtures: items.fixtures, variants: items.variants }
      );
      const checks = await runStepChecks(
        snapshot,
        trial.scenario,
        step,
        trial.config,
        checkContext(state, log, true)
      );
      const diff = await diffTrees(
        state.repo.repoDir,
        state.previousTree ?? state.repo.baseTree,
        snapshot.tree
      );
      mkdirSync(join(trial.trialDir, 'snapshots'), { recursive: true });
      writeFileSync(join(trial.trialDir, 'snapshots', `step-${step.id}.diff`), diff.text);
      state.stepDiffs[step.id] = diff;
      state.stepChecks.push(checks);
      state.previousTree = snapshot.tree;
      log.info('step checks', {
        score: checks.score,
        build: checks.build?.pass,
        fixtures: checks.fixtures,
        variants: checks.variants,
        suite: checks.suite?.pass,
        flags: checks.flags.map((hit) => hit.flag),
        files: diff.files.length
      });
      return { ...result, score: checks.score };
    },

    async finalize(trial) {
      const state = stateOf(trial);
      const log = logOf(trial);
      const snapshot = await snapshotForChecks(
        state.repo,
        join(trial.tmpDir, 'snapshots', 'final'),
        finalItems(trial.scenario)
      );
      // An infra trial leaves every denominator (DESIGN 5.6); its minutes of full suite next
      // to the other worker's agent would buy nothing.
      const config =
        trial.harness?.category === 'infra'
          ? { ...trial.config, checks: { fullSuite: 'never' as const } }
          : trial.config;
      const final = await runFinalChecks(
        snapshot,
        trial.scenario,
        config,
        checkContext(state, log, false)
      );
      const archive = await archiveFinalTree(state.repo, trial.trialDir);

      const toolCalls =
        trial.sessionFile !== undefined && existsSync(trial.sessionFile)
          ? sessionToolCalls(trial.sessionFile)
          : [];
      const roots: EscapeRoots = { repoDir: state.repo.repoDir };
      if (trial.tmpRoot !== undefined) roots.tmpRoot = trial.tmpRoot;
      const escaped = escapedTreeFlags(toolCalls, roots);
      for (const hit of escaped) log.warn('escaped tree', { lines: hit.lines });

      const answerContext: AnswerContext = {
        scenario: trial.scenario,
        finalDiff: archive.diff,
        stepDiffs: state.stepDiffs,
        snapshotDir: snapshot.dir,
        toolCalls
      };
      if (state.validate !== undefined) answerContext.validate = state.validate;
      const answers = answerChecks(trial, answerContext);

      const checks = assembleChecks(
        state.stepChecks,
        final,
        answers,
        sessionOutcome(trial, escaped)
      );
      writeJson(join(trial.trialDir, 'checks.json'), checks);
      log.info('final checks', {
        category: checks.category,
        flags: checks.flags,
        scoreCode: checks.scoreCode,
        scoreProbe: checks.scoreProbe,
        pass: checks.pass,
        files: archive.diff.files.length
      });
      const result: TrialFinal = {
        category: checks.category,
        flags: checks.flags,
        scores: scoresOf(checks),
        checks
      };
      return result;
    },

    async teardown(trial) {
      teardownTrial(trial.tmpDir, trial.keep);
    }
  };
}
