import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { CompactionModelOverride, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { Logger } from './log.js';

export type { ThinkingLevel };

/** pi's settings object; not exported by name from the package, so derived here. */
export type PiSettings = ReturnType<SettingsManager['getSettings']>;

// ---------------------------------------------------------------------------
// Config: bench/config/models.json and bench/config/run.json (DESIGN 3, 11)
// ---------------------------------------------------------------------------

export interface ModelSpec {
  /** Names result directories. */
  label: string;
  /** pi's `provider/modelId`. */
  model: string;
  thinking: ThinkingLevel;
}

export interface ConditionSpec {
  id: string;
  /**
   * pi-episodes entry point loaded through `additionalExtensionPaths`, resolved against the
   * config file's directory. Absent for plain pi.
   */
  extension?: string;
}

export type FullSuiteFrequency = 'goal-steps' | 'chain-end' | 'never';

export interface RunCaps {
  goalStepMinutes: number;
  otherStepMinutes: number;
  goalStepTurns: number;
  trialHours: number;
}

export interface RunConfig {
  scenarios: string[];
  conditions: ConditionSpec[];
  runsPerCell: number;
  parallel: number;
  caps: RunCaps;
  checks: { fullSuite: FullSuiteFrequency };
  retry: { maxRetries: number; baseDelayMs: number };
  /** Keyed by `provider/modelId`; goes into `settings.compaction.modelOverrides` of A and B alike. */
  compactionOverrides: Record<string, CompactionModelOverride>;
  /**
   * Scenario ids never read during prompt tuning (DESIGN 4, chain C); `bench report --compare`
   * separates them from the tuning chains. Default `["mapped-types"]` when absent.
   */
  heldOut?: string[];
}

// ---------------------------------------------------------------------------
// Scenario: bench/scenarios/<id>/scenario.json (DESIGN 4)
// ---------------------------------------------------------------------------

export interface RepoSpec {
  /** Absolute after loading; `~/` and paths relative to the scenario dir are resolved. */
  source: string;
  /** Absent when `source` is a plain directory without git history (mini-chain). */
  baseCommit?: string;
}

/** Where fixtures live in the repo under test; `{id}` is the fixture or variant id. */
export interface FixtureLayout {
  /** Default `test/valid-data/{id}`. */
  dir: string;
  /** Test file inside the fixture dir. Default `index.test.ts`. */
  test: string;
}

export interface Feature {
  id: string;
  /** Upstream commit whose `srcPaths` diff is reverted at setup. Absent when the repo has no history (mini-chain). */
  commit?: string;
  pr?: number;
  srcPaths: string[];
  /** Fixture dirs deleted at setup and copied back from the reference clone at check time. */
  fixturesAdded: string[];
  /** Fixture dirs rolled back to `<commit>^` at setup and restored at check time. */
  fixturesModified: string[];
}

export type StepKind = 'goal' | 'aside' | 'probe';

export interface StepChecks {
  tsc: boolean;
  fixtures: string[];
  variants: string[];
  /** `config` follows `run.json` `checks.fullSuite`. */
  suite: 'config' | 'always' | 'never';
}

export interface MustCarry {
  fact: string;
  condition: string;
}

export type ProbeAnswer =
  | { kind: 'fixed'; pattern: string }
  // `key` names an extractor in checks.ts that derives the expected value from the trial's
  // own diff or logs (DESIGN 4, "diff" probes).
  | { kind: 'diff'; key: string }
  | { kind: 'abstain' }
  | { kind: 'judge'; rubric: string };

export interface Step {
  id: string;
  kind: StepKind;
  /** Prompt file relative to the scenario dir, as written in `scenario.json`. */
  prompt: string;
  /** Resolved prompt: file content, plus trap text and repo note where they apply. */
  text: string;
  feature?: string;
  terse?: boolean;
  endEvent?: string;
  checks?: StepChecks;
  answer?: ProbeAnswer;
  mustCarry?: MustCarry[];
  rejected?: string[];
  trailing?: string[];
  /** Key into `Scenario.traps`; the matching trap text is appended to `text`. */
  trap?: string;
}

export interface Variant {
  id: string;
  feature: string;
  /** Root type for the generated `schema.json`; absent when the variant dir ships its own test file. */
  rootType?: string;
}

export interface TrapSpec {
  files: string[];
  mustBeUnchanged: boolean;
  grep?: string;
  /** Prompt text; defaults to `TRAP_TEXTS[id]` in scenario.ts. */
  text?: string;
}

export interface ScenarioFinal {
  traps: string[];
  allowedSchemaChanges: string[];
}

/** Check command overrides; the mini-chain self-test uses them so `tsc`/`tsx` are not required. */
export interface ScenarioCommands {
  typecheck?: string;
  /** `{file}` is replaced with the fixture's test file. */
  fixture?: string;
  suite?: string;
}

export interface Scenario {
  id: string;
  /** Absolute path of the scenario directory. */
  dir: string;
  repo: RepoSpec;
  features: Feature[];
  revertOrder: string[];
  steps: Step[];
  final: ScenarioFinal;
  variants: Variant[];
  traps: Record<string, TrapSpec>;
  /** Defaults applied by the loader. */
  layout: FixtureLayout;
  commands?: ScenarioCommands;
}

// ---------------------------------------------------------------------------
// Trials: plan.json, trial.json, checks.json, metrics.json (DESIGN 5, 7, 11)
// ---------------------------------------------------------------------------

export interface TrialId {
  /** `ModelSpec.label`. */
  model: string;
  /** `A` or `B@<prompt-id>`. */
  condition: string;
  /** Scenario id. */
  chain: string;
  runIndex: number;
}

/** `interrupted`: the trial was running when the process was stopped by a signal; `--resume` restarts it. */
export type PlanStatus = 'pending' | 'running' | 'done' | 'infra' | 'interrupted';

export interface PlanEntry extends TrialId {
  status: PlanStatus;
  /** Relative to the run dir: `trials/<model>__<condition>__<chain>__r<NN>`. */
  trialDir: string;
  /** `trialDir` of the infra trial this entry replaces. */
  rerunOf?: string;
}

export type TrialCategory =
  | 'passed'
  | 'checks_failed'
  | 'build_broken'
  | 'timeout'
  | 'turn_cap'
  | 'context_overflow'
  | 'stopped_early'
  | 'flagged'
  | 'infra';

export type TrialFlag =
  | 'no_src_change'
  | 'harness_tampering'
  | 'trap_left'
  | 'hardcoded'
  | 'escaped_tree';

export type StepEnd = 'settled' | 'timeout' | 'turn_cap' | 'error' | 'skipped';

export interface StepResult {
  id: string;
  kind: StepKind;
  startedAt: string;
  endedAt?: string;
  /** Agent wall time; excludes the checks that run after the step. */
  durationMs?: number;
  end: StepEnd;
  requests: number;
  toolCalls: Record<string, number>;
  compactions: number;
  /** One per successful compaction, in order; metrics matches them to `compaction` entries by position. */
  compactionEvents?: { reason: string; tokensBefore: number }[];
  retries: number;
  errors: string[];
  /** Final assistant text of an aside or probe step. */
  answer?: string;
  /** Probe or aside scored by pattern now, judge later. */
  answerPass?: boolean;
  /** `score_step[k]` for goal steps. */
  score?: number;
}

export interface TrialAudit {
  model: string;
  provider: string;
  modelId: string;
  /** The endpoint the requests went to; tells a proxy from `models.pi.json` apart from the direct provider. */
  baseUrl?: string;
  api?: string;
  authKind?: 'api-key' | 'oauth' | 'env' | 'faux' | 'unknown';
  thinking: ThinkingLevel;
  contextWindow?: number;
  maxTokens?: number;
  settings: PiSettings;
  tools: string[];
  systemPromptHash: string;
  extensionPaths: string[];
  promptId?: string;
  piVersion: string;
  episodesCommit?: string;
  episodesDirty?: boolean;
  nodeVersion: string;
}

export interface TrialRecord extends TrialId {
  runId: string;
  /** Directory name: `<model>__<condition>__<chain>__r<NN>`. */
  trialId: string;
  rerunOf?: string;
  startedAt: string;
  endedAt?: string;
  /** Git tree hash of the sealed repo after setup. */
  baseTree?: string;
  audit?: TrialAudit;
  steps: StepResult[];
  category?: TrialCategory;
  flags: TrialFlag[];
  /** Reason when `category` is `infra`. */
  error?: string;
}

// ---------------------------------------------------------------------------
// checks.json (DESIGN 5.3)
// ---------------------------------------------------------------------------

export interface CommandOutcome {
  command: string;
  exitCode: number | null;
  durationMs: number;
  head: string;
  tail: string;
}

export type FixtureOutcome = 'pass' | 'fail' | 'load_error';

export interface FlagHit {
  flag: TrialFlag;
  /** Matching lines, quoted. */
  lines: string[];
}

export interface SnapshotChecks {
  /** `step-<k>` or `final`. */
  snapshot: string;
  stepId?: string;
  build?: CommandOutcome & { pass: boolean };
  fixtures: Record<string, FixtureOutcome>;
  variants: Record<string, FixtureOutcome>;
  suite?: CommandOutcome & { pass: boolean; tests: number; fail: number; expectedMin: number };
  /** Trap id to reverted (true = pass). */
  traps: Record<string, boolean>;
  flags: FlagHit[];
  score: number;
  /** Per-fixture and per-variant command outputs, keyed by id. */
  commands?: Record<string, CommandOutcome>;
}

export interface AnswerCheck {
  stepId: string;
  kind: ProbeAnswer['kind'];
  answer: string;
  /** Undefined until a judge scores `abstain` and `judge` answers. */
  pass?: boolean;
  expected?: string;
}

export interface ChecksJson {
  steps: SnapshotChecks[];
  final?: SnapshotChecks;
  answers: AnswerCheck[];
  scoreCode?: number;
  scoreProbe?: number;
  pass?: boolean;
  category: TrialCategory;
  flags: TrialFlag[];
}

// ---------------------------------------------------------------------------
// metrics.json (DESIGN 7)
// ---------------------------------------------------------------------------

export interface TokenTotals {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
  reasoning: number;
}

export type InputSeriesMarker = 'fold' | 'compaction' | 'ask' | 'fork';

export interface InputSeriesPoint {
  index: number;
  stepId: string;
  /** `input + cacheRead + cacheWrite` of that request. */
  attended: number;
  markers: InputSeriesMarker[];
}

export interface FoldMetric {
  handle: string;
  since: string;
  until?: string;
  requestIndex: number;
  messages: number;
  tokens: number;
  noteTokens: number;
  noteSpanRatio: number;
  under2k: boolean;
  files: string[];
  /** The fold call shared its assistant message with other content. */
  notAlone: boolean;
  /** The fold was the last tool call before the step's final assistant text. */
  beforeFinalReply: boolean;
  /** `cacheWrite` of the request after the fold. */
  cacheWriteAfter?: number;
}

export interface RejectedFold {
  requestIndex: number;
  error: string;
}

export interface RecallMetric {
  requestIndex: number;
  query: string;
  total: number;
  regex: boolean;
  quoted: boolean;
  stalenessLines: number;
}

export interface AskMetric {
  requestIndex: number;
  handle: string;
  usage?: TokenTotals;
}

export interface ForkMetric {
  requestIndex: number;
  handle: string;
  turns: number;
  usage?: TokenTotals;
  folds: number;
}

export interface CompactionMetric {
  requestIndex: number;
  tokensBefore: number;
  summaryUsage?: TokenTotals;
  reason?: string;
  /** `cacheWrite` of the request after the compaction. */
  cacheWriteAfter?: number;
}

export interface MetricsJson {
  requests: number;
  turns: number;
  toolCalls: Record<string, number>;
  tokens: TokenTotals;
  /** `ok` when `input+cacheRead+cacheWrite+output == totalTokens` on every request. */
  tokenBasis: 'ok' | 'suspect';
  contextAttended: number;
  contextAttendedAll: number;
  peakContext: number;
  cacheHitRate: { overall: number; medianPerRequest: number; shareBelowHalf: number };
  cost: {
    total: number;
    /** `cacheWarm`: pi's cache-warming requests (`usage` entries), zero with the runner's settings. */
    overhead: { fold: number; ask: number; fork: number; compaction: number; cacheWarm: number };
  };
  wallTimeS: number;
  timeToFirstFold?: { seconds: number; requestIndex: number };
  compactions: CompactionMetric[];
  folds: FoldMetric[];
  rejectedFolds: RejectedFold[];
  recalls: RecallMetric[];
  asks: AskMetric[];
  forks: ForkMetric[];
  reminders: number;
  /** `terminal`: assistant messages with `stopReason: "error"` that are not a 429 or 5xx (DESIGN 5.6). */
  errors: { throttled: number; toolSchema: number; terminal: number };
  inputSeries: InputSeriesPoint[];
  category: TrialCategory;
  flags: TrialFlag[];
  scoreStep: Record<string, number>;
  scoreCode?: number;
  scoreProbe?: number;
  pass?: boolean;
}

// ---------------------------------------------------------------------------
// repo.ts and checks.ts (DESIGN 5.1, 5.3, 5.4, 11)
// ---------------------------------------------------------------------------

export interface DiffFile {
  path: string;
  /** `git diff-tree --name-status` letter: A, M, D, T (mode change). */
  status: string;
}

/** Unified diff between two trees of the trial repo; untracked files are included (see repo.ts). */
export interface AgentDiff {
  fromTree: string;
  toTree: string;
  text: string;
  files: DiffFile[];
}

/** A copy of the agent's tree for checks, with the tree hash it was taken from. */
export interface Snapshot {
  dir: string;
  tree: string;
}

/** One tool call from the session, as the runner records it; `output` is the tool result text. */
export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  output?: string;
}

/** What the generator did for a held-out fixture on the sealed tree (`bench validate`). */
export interface PreChangeOutcome {
  threw: boolean;
  /** Error message when it threw; otherwise the root definition's `description` if there is one. */
  message?: string;
  schema?: unknown;
}

/** `<scenario>/validate.json`, written by `bench validate`; `checks.ts` reads it for expected counts. */
export interface ValidateJson {
  scenario: string;
  baseCommit?: string;
  validatedAt: string;
  repeats: number;
  /** Full-suite test counts on the sealed tree (held-out fixtures absent) and with reference src restored. */
  suiteTests: { sealed: number; restored: number };
  suiteDurationMs: { sealed: number; restored: number };
  /** Tests per held-out fixture, from the restored run. */
  fixtureTests: Record<string, number>;
  /** Root type per held-out fixture, parsed from its test file. */
  fixtureRootTypes: Record<string, string>;
  preChange: Record<string, PreChangeOutcome>;
  ok: boolean;
  failures: string[];
}

// ---------------------------------------------------------------------------
// Session, plan and run (I2). Appended; nothing above this line changed.
// ---------------------------------------------------------------------------

export type ProviderKind = 'real' | 'faux';

/** Per-step caps handed to the step driver (DESIGN 5.2). */
export interface StepCaps {
  wallMs: number;
  /** Assistant messages; absent for aside and probe steps. */
  turns?: number;
}

/** What `driveStep` observed beyond the stored `StepResult` fields. */
export interface StepDriveResult extends StepResult {
  /** Assistant messages with `stopReason: "error"` and a 429 or 5xx text (DESIGN 5.6). */
  throttled: number;
  /** pi reported an overflow compaction that failed (DESIGN 5.5 `context_overflow`). */
  overflow: boolean;
}

/** The harness's own view of how the trial ended; merged with the checks' view per DESIGN 5.5. */
export interface HarnessOutcome {
  category?: 'infra' | 'timeout' | 'turn_cap' | 'context_overflow';
  error?: string;
}

export interface TrialScores {
  scoreStep: Record<string, number>;
  scoreCode?: number;
  scoreProbe?: number;
  pass?: boolean;
}

/** `trial.json`: the record plus what the run loop adds at the end. */
export interface TrialJson extends TrialRecord {
  harness?: HarnessOutcome;
  scores?: TrialScores;
}

/** Everything a hook may need about the trial being run. `record` is mutated as steps finish. */
export interface TrialContext {
  record: TrialRecord;
  scenario: Scenario;
  model: ModelSpec;
  condition: ConditionSpec;
  config: RunConfig;
  runDir: string;
  /** Absolute results dir of the trial: `<runDir>/trials/<trialId>`. */
  trialDir: string;
  /** Scratch root for the trial: `<tmpRoot>/pi-bench/<run-id>/<trial-id>`; `repoDir` lives below it. */
  tmpDir: string;
  /** The system temp dir the run works under; paths under it outside the repo are `escaped_tree`. */
  tmpRoot?: string;
  keep: boolean;
  /** The run loop's view of the trial so far; `finalize` folds it into `checks.json` (DESIGN 5.5). */
  harness?: HarnessOutcome;
  /** The session JSONL pi is writing, once the first entry is persisted; `finalize` reads tool calls from it. */
  sessionFile?: string;
  /** The trial's `stdout.log` writer. */
  log?: Logger;
}

export interface TrialSetup {
  /** The sealed repo the agent works in (session cwd). */
  repoDir: string;
  /** Git tree hash of the sealed repo. */
  baseTree: string;
}

/** The checks' view of the end of a trial; the harness merges in timeout, turn_cap and infra. */
export interface TrialFinal {
  category: TrialCategory;
  flags: TrialFlag[];
  scores: TrialScores;
  /** What `finalize` wrote to `checks.json`; `metrics.json` is computed from it. */
  checks?: ChecksJson;
}

/**
 * How `bench run` reaches `repo.ts`, `checks.ts` and `metrics.ts` without importing them. The
 * integration owner wires the real modules; the run tests use an in-memory fake.
 */
export interface Hooks {
  /** Before the first trial: reference clone and `node_modules` template per scenario. Throwing aborts the run. */
  prepare?(scenarios: readonly Scenario[], log: Logger): Promise<void>;
  /** DESIGN 5.1: reference clone, trial copy, reverts, seal. Throwing makes the trial `infra`. */
  setup(trial: TrialContext): Promise<TrialSetup>;
  /** DESIGN 5.3: snapshot and checks after a goal step; returns `result` with `score` filled. */
  afterGoalStep(trial: TrialContext, step: Step, result: StepResult): Promise<StepResult>;
  /** DESIGN 5.3 chain end: final snapshot, diff rules, `checks.json`, `metrics.json`. */
  finalize(trial: TrialContext): Promise<TrialFinal>;
  /** DESIGN 5.7: delete the scratch dir unless `trial.keep`. Always called, even after `infra`. */
  teardown(trial: TrialContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Analysis: report.json and charts (I3, DESIGN 8). Appended; nothing above this line changed.
// ---------------------------------------------------------------------------

/** A number with its 95% interval where one exists; `NaN` is written as `null` in report.json. */
export interface Estimate {
  value: number;
  lower?: number;
  upper?: number;
}

/** One condition's side of a cell row (or of the pooled row). */
export interface ConditionSummary {
  condition: string;
  /** Trials in the denominators: everything but `infra`. */
  n: number;
  /** Infra trials of the cell, outside every denominator but shown (DESIGN 5.6). */
  infra: number;
  /** `trial id: error` per infra trial. */
  infraErrors: string[];
  /** Sum of `errors.terminal` over the `n` trials. */
  terminalErrors: number;
  /** Trials excluded from H1 and H2 (`flagged`). */
  excluded: number;
  /** Trials used for H1 and H2: `n - excluded`. */
  used: number;
  scoreCode: Estimate;
  /** Wilson interval of `pass`. */
  pass: Estimate & { c: number };
  /** Mean over trials of `cacheHitRate.overall`. */
  cacheHit: number;
  passPow3?: number;
  flip?: number;
  /** Mean compactions per run. */
  compactions: number;
  categories: Partial<Record<TrialCategory, number>>;
  /** Mean per run; only meaningful for B. */
  episodes: { folds: number; recalls: number; asks: number; forks: number };
  /** Geometric mean of `context_attended` over the used trials. */
  tokensGeomean: number;
  /** SD of log `context_attended` over the used trials (variance note). */
  sdLogTokens: number;
}

/** One row of the per-model table: a chain, or the pooled row (`chain: "pooled"`). */
export interface ChainRow {
  chain: string;
  pooled: boolean;
  heldOut: boolean;
  a: ConditionSummary;
  b: ConditionSummary;
  /** B minus A; `lowerOneSided` is the one-sided 95% bound used by H2. */
  scoreCodeDiff: Estimate & { lowerOneSided: number };
  /** Newcombe interval of pass B minus pass A. */
  passDiff: Estimate;
  /** Ratios of geometric means B/A. */
  tokens: Estimate;
  pBelow: number;
  output: Estimate;
  cost: Estimate;
  turns: Estimate;
  wall: Estimate;
  peak: Estimate;
  cvRatio: Estimate;
}

export type VerdictKind = 'win' | 'tie' | 'lose' | 'insufficient';

export interface Verdict {
  verdict: VerdictKind;
  h1: { ratio: Estimate; outcome: 'below' | 'covers' | 'above' | 'none' };
  h2: { lowerOneSided: number; margin: number; holds: boolean };
  h3: { shareA: number; shareB: number; margin: number; holds: boolean };
  plannedN: number;
  reasons: string[];
}

export interface FoldMechanics {
  trials: number;
  folds: number;
  rejected: number;
  notAlone: number;
  beforeFinalReply: number;
  under2k: number;
  noteSpanRatioMedian?: number;
  timeToFirstFoldMedianS?: number;
  firstFoldRequestMedian?: number;
  reminders: number;
  recalls: {
    count: number;
    zeroHit: number;
    regex: number;
    quoted: number;
    stalenessLines: number;
  };
  asks: number;
  forks: { count: number; turns: number; foldsInside: number };
  toolSchemaErrors: number;
}

export interface VarianceCell {
  chain: string;
  condition: string;
  n: number;
  sdLog: number;
}

export interface ModelReport {
  model: string;
  conditionA: string;
  conditionB: string;
  promptId?: string;
  rows: ChainRow[];
  pooled: ChainRow;
  verdict: Verdict;
  variance: { cells: VarianceCell[]; sdLogPooled: number; plannedN: number };
  foldMechanics: FoldMechanics;
  /** Trials with `tokenBasis: "suspect"`, by condition. */
  suspectTokens: Record<string, number>;
  judge?: unknown;
}

export interface CompareRow {
  chain: string;
  heldOut: boolean;
  /** `this` is the run being reported, `other` the `--compare` run. */
  nThis: number;
  nOther: number;
  /** Ratio of geometric means other/this. */
  tokens: Estimate;
  pBelow: number;
  scoreCodeDiff: Estimate & { lowerOneSided: number };
  foldsPerRun: { this: number; other: number };
  passPow3: { this?: number; other?: number };
}

export interface CompareModel {
  model: string;
  conditionThis: string;
  conditionOther: string;
  rows: CompareRow[];
  pooledTuning?: CompareRow;
  pooledHeldOut?: CompareRow;
  /** Held-out chains agree in sign with the tuning chains on the token ratio. */
  heldOutAgrees?: boolean;
}

export interface ReportJson {
  runId: string;
  generatedAt: string;
  heldOut: string[];
  conditions: string[];
  models: ModelReport[];
  compare?: { runId: string; models: CompareModel[] };
}

// ---------------------------------------------------------------------------
// Judge: judge.json, bench/judge/judge.json, labels (I4, DESIGN 9). Appended; nothing above
// this line changed.
// ---------------------------------------------------------------------------

/**
 * Rubric ids from DESIGN 9. `b3` is "fact present", `b3c` "condition kept" (the two binaries
 * of the three-way b3 question); `probes` holds the judged `abstain` and `judge` answers.
 */
export type RubricId =
  | 'a1'
  | 'a2'
  | 'a3'
  | 'a4'
  | 'b1'
  | 'b2'
  | 'b3'
  | 'b3c'
  | 'b4'
  | 'b5'
  | 'b6'
  | 'b7'
  | 'c1'
  | 'c2'
  | 'c3'
  | 'c4'
  | 'c5'
  | 'c6'
  | 'd1'
  | 'd2'
  | 'd3'
  | 'd4'
  | 'd5'
  | 'e1'
  | 'e2'
  | 'e3'
  | 'e4'
  | 'probes';

/** `pending`: needs the judge or data the scenario lacks; `invalid`: the judge's evidence was not in the input twice. */
export type RubricPass = boolean | 'pending' | 'invalid';

export interface JudgeVerdict {
  answer: 'PASS' | 'FAIL';
  /** Verbatim substring of the input blocks. */
  evidence: string;
  reason: string;
}

export type JudgeItemVerdict =
  | (JudgeVerdict & { status: 'ok'; attempts: number })
  | { status: 'invalid'; attempts: number; reason: string };

export interface RubricItem {
  rubric: RubricId;
  /** Fold handle, trigger id, trap id, step id or recall id the item is about. */
  subject: string;
  pass: RubricPass;
  evidence: string;
  /** Request (assistant message index on the main thread) the item is anchored at; -1 when none. */
  requestIndex: number;
  /** The signed number a rubric keeps: a1 lateness in turns, a2 `since` error in stamps, c6 hit count. */
  value?: number;
  /** Judge verdicts by judge model; `pass` follows the active judge. */
  verdicts?: Record<string, JudgeItemVerdict>;
}

export interface JudgeExtractBlock {
  name: string;
  text: string;
}

/** One judge question with its input blocks; the user prompt is built from these verbatim. */
export interface JudgeExtract {
  rubric: RubricId;
  subject: string;
  requestIndex: number;
  question: string;
  blocks: JudgeExtractBlock[];
}

export interface RubricSummary {
  /** Items with `pass: true`. */
  pass: number;
  /** Items decided (`pass` boolean); pending and invalid items are not in it. */
  total: number;
  pending: number;
  invalid: number;
  items: RubricItem[];
}

export interface NullCheckResult {
  /** Condition A trials checked. */
  trials: number;
  ok: boolean;
  problems: string[];
}

/** `trials/<id>/judge.json`. */
export interface JudgeJson {
  generatedAt: string;
  judgeModel?: string;
  /** Absent when `withheld`. */
  rubrics?: Record<string, RubricSummary>;
  /** The null check failed on this run; no rubric totals are reported until the extractor is fixed. */
  withheld?: boolean;
  reason?: string;
  /** Judge calls were refused (judge model equals the trial model); script rubrics stand. */
  refused?: string;
}

/** `bench/judge/judge.json`. */
export interface JudgeConfig {
  /** `provider/modelId`, first is the default judge. */
  models: string[];
  /** Absolute after loading. */
  authPath: string;
}

/** One line of `bench/judge/labels.jsonl`. */
export interface JudgeLabel {
  run: string;
  trial: string;
  rubric: string;
  subject: string;
  label: 'PASS' | 'FAIL';
  note?: string;
}

export interface KappaCell {
  rubric: string;
  model: string;
  n: number;
  /** Confusion matrix with PASS as the positive class: rows human, columns judge. */
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  agreement: number;
  /** Cohen's kappa; null when chance agreement is 1 (every label and verdict identical). */
  kappa: number | null;
}
