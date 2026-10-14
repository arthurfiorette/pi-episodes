import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Usage } from '@earendil-works/pi-ai';
import {
  ASK_TOOL,
  activeBranch,
  appliedFoldHandles,
  type CompactionEntry,
  compactions as compactionEntries,
  customMessages,
  FOLD_TOOL,
  FORK_TOOL,
  type ForkArchive,
  isAskDetails,
  isFoldDetails,
  isForkDetails,
  isRecallDetails,
  isThrottledError,
  RECALL_TOOL,
  REMINDER_TYPE,
  type Request,
  readForkArchives,
  readSession,
  requests as requestsOf,
  type SessionEntry,
  type ToolResultRef,
  textOf,
  toolCalls,
  toolResults,
  usageEntries
} from './jsonl.js';
import type {
  AskMetric,
  ChecksJson,
  CompactionMetric,
  FoldMetric,
  ForkMetric,
  InputSeriesMarker,
  InputSeriesPoint,
  MetricsJson,
  RecallMetric,
  RejectedFold,
  TokenTotals,
  TrialCategory,
  TrialRecord
} from './types.js';

/** DESIGN 9, rubric e1: the staleness line recall and ask prepend to their results. */
export const STALENESS_LINE = /^(ep|fk)-[0-9a-f]{8} predates changes to: /m;
/** pi's argument validation, an unknown tool, or pi-episodes rejecting a made-up `since`. */
const TOOL_SCHEMA_ERROR =
  /^Validation failed for tool "|^Tool \S+ not found|since must be a turn stamp|does not exist; the latest stamp is/m;

export interface ComputeMetricsOptions {
  sessionPath: string;
  trialRecord: Pick<TrialRecord, 'steps'> & Partial<Pick<TrialRecord, 'category' | 'flags'>>;
  checks?: ChecksJson;
}

export function emptyTotals(): TokenTotals {
  return { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0 };
}

export function totalsOf(usage: Usage): TokenTotals {
  return {
    input: usage.input,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cacheWrite1h: usage.cacheWrite1h ?? 0,
    output: usage.output,
    reasoning: usage.reasoning ?? 0
  };
}

export function addTotals(into: TokenTotals, usage: Usage): void {
  into.input += usage.input;
  into.cacheRead += usage.cacheRead;
  into.cacheWrite += usage.cacheWrite;
  into.cacheWrite1h += usage.cacheWrite1h ?? 0;
  into.output += usage.output;
  into.reasoning += usage.reasoning ?? 0;
}

/** `input + cacheRead + cacheWrite`: what the model attended on that request. */
export function attended(usage: Usage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

export function usageInvariantHolds(usage: Usage): boolean {
  return usage.input + usage.cacheRead + usage.cacheWrite + usage.output === usage.totalTokens;
}

/** Rough token count of a note, the same chars/4 pi-episodes uses for spans. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Step id per request index from the trial record's per-step request counts. */
export function stepIdsByRequest(
  steps: readonly { id: string; requests: number }[],
  count: number
): string[] {
  const ids: string[] = [];
  for (const step of steps) {
    for (let n = 0; n < step.requests && ids.length < count; n++) ids.push(step.id);
  }
  // Requests the harness did not attribute (retries, the synthetic message after an abort)
  // belong to the last step that made a request; skipped steps made none.
  const last = steps.findLast((step) => step.requests > 0)?.id ?? steps.at(-1)?.id ?? '';
  while (ids.length < count) ids.push(last);
  return ids;
}

function archiveTurns(archive: ForkArchive): number {
  return archive.messages.filter((message: AgentMessage) => message.role === 'assistant').length;
}

function archiveAttended(archive: ForkArchive): number {
  let sum = 0;
  for (const message of archive.messages) {
    if (message.role === 'assistant') sum += attended(message.usage);
  }
  return sum;
}

export function computeMetrics(options: ComputeMetricsOptions): MetricsJson {
  const session = readSession(options.sessionPath);
  return metricsFromEntries(session.entries, readForkArchives(options.sessionPath), options);
}

export function metricsFromEntries(
  entries: readonly SessionEntry[],
  archives: ReadonlyMap<string, ForkArchive>,
  options: Omit<ComputeMetricsOptions, 'sessionPath'>
): MetricsJson {
  const branch = activeBranch(entries);
  const requests = requestsOf(branch);
  const stepIds = stepIdsByRequest(options.trialRecord.steps, requests.length);

  const toolCallCounts: Record<string, number> = {};
  const sharedResponse = new Set<string>();
  for (const ref of toolCalls(branch)) {
    toolCallCounts[ref.call.name] = (toolCallCounts[ref.call.name] ?? 0) + 1;
    if (ref.siblings.length > 0) sharedResponse.add(ref.call.id);
  }

  const tokens = emptyTotals();
  let tokenBasis: MetricsJson['tokenBasis'] = 'ok';
  let contextAttended = 0;
  let peakContext = 0;
  let cacheRead = 0;
  let mainCost = 0;
  let throttled = 0;
  let terminal = 0;
  const hitRates: number[] = [];
  for (const request of requests) {
    const usage = request.message.usage;
    addTotals(tokens, usage);
    if (!usageInvariantHolds(usage)) tokenBasis = 'suspect';
    const seen = attended(usage);
    contextAttended += seen;
    cacheRead += usage.cacheRead;
    peakContext = Math.max(peakContext, seen);
    if (seen > 0) hitRates.push(usage.cacheRead / seen);
    mainCost += usage.cost.total;
    if (request.message.stopReason === 'error') {
      if (isThrottledError(request.message)) throttled++;
      else terminal++;
    }
  }

  // Requests pi made outside the model's turns (cache warming); off in the runner's settings,
  // summed so an old session with warming on is still readable.
  let cacheWarmCost = 0;
  let cacheWarmAttended = 0;
  for (const entry of usageEntries(branch)) {
    cacheWarmCost += entry.usage.cost.total;
    cacheWarmAttended += attended(entry.usage);
  }

  const requestAfter = (position: number): Request | undefined =>
    requests.find((request) => request.position > position);
  const firstUser = branch.find(
    (entry) => entry.type === 'message' && entry.message.role === 'user'
  );
  const originMs = firstUser
    ? new Date(firstUser.timestamp).getTime()
    : branch[0]
      ? new Date(branch[0].timestamp).getTime()
      : 0;

  const folds: FoldMetric[] = [];
  const rejectedFolds: RejectedFold[] = [];
  let foldOutputCost = 0;
  let timeToFirstFold: MetricsJson['timeToFirstFold'];
  // A fold result without its `episodes-fold-applied` entry never changed the context: pi
  // drops the whole edit batch when any draft is invalid.
  const applied = appliedFoldHandles(branch);
  for (const result of toolResults(branch, FOLD_TOOL)) {
    const text = textOf(result.message.content);
    if (result.message.isError || !isFoldDetails(result.message.details)) {
      rejectedFolds.push({ requestIndex: result.requestIndex, error: text.split('\n')[0] ?? '' });
      continue;
    }
    const details = result.message.details;
    if (!applied.has(details.handle)) {
      rejectedFolds.push({ requestIndex: result.requestIndex, error: 'edits not applied' });
      continue;
    }
    const call = result.call;
    const caller = requests[result.requestIndex];
    if (caller) foldOutputCost += caller.message.usage.cost.output;
    const note = typeof call?.arguments.note === 'string' ? call.arguments.note : '';
    const noteTokens = estimateTokens(note);
    const next = requestAfter(result.position);
    const fold: FoldMetric = {
      handle: details.handle,
      since: details.since,
      requestIndex: result.requestIndex,
      messages: details.messages,
      tokens: details.tokens,
      noteTokens,
      noteSpanRatio: noteTokens / Math.max(details.tokens, 1),
      under2k: details.tokens < 2000,
      files: details.files,
      notAlone: sharedResponse.has(result.message.toolCallId),
      beforeFinalReply:
        next !== undefined && !next.message.content.some((block) => block.type === 'toolCall')
    };
    if (details.until !== undefined) fold.until = details.until;
    if (next) fold.cacheWriteAfter = next.message.usage.cacheWrite;
    folds.push(fold);
    if (!timeToFirstFold) {
      timeToFirstFold = {
        seconds: (new Date(result.entry.timestamp).getTime() - originMs) / 1000,
        requestIndex: result.requestIndex
      };
    }
  }

  const recalls: RecallMetric[] = toolResults(branch, RECALL_TOOL).map((result) => {
    const details = isRecallDetails(result.message.details) ? result.message.details : undefined;
    const args = result.call?.arguments ?? {};
    const query = typeof args.query === 'string' ? args.query : (details?.query ?? '');
    const text = textOf(result.message.content);
    return {
      requestIndex: result.requestIndex,
      query,
      total: result.message.isError ? 0 : (details?.total ?? 0),
      regex: args.regex === true,
      quoted: /^"(.+)"$/s.test(query.trim()),
      stalenessLines: text.split('\n').filter((line) => STALENESS_LINE.test(line)).length
    };
  });

  let askCost = 0;
  let askAttended = 0;
  const asks: AskMetric[] = toolResults(branch, ASK_TOOL).map((result) => {
    const details = isAskDetails(result.message.details) ? result.message.details : undefined;
    const args = result.call?.arguments ?? {};
    const ask: AskMetric = {
      requestIndex: result.requestIndex,
      handle: details?.handle ?? (typeof args.handle === 'string' ? args.handle : '')
    };
    const usage = result.message.usage;
    if (usage) {
      ask.usage = totalsOf(usage);
      askCost += usage.cost.total;
      askAttended += attended(usage);
    }
    return ask;
  });

  let forkCost = 0;
  let forkAttended = 0;
  const forks: ForkMetric[] = toolResults(branch, FORK_TOOL).flatMap((result) => {
    if (!isForkDetails(result.message.details)) return [];
    const details = result.message.details;
    const archive = archives.get(details.handle);
    const fork: ForkMetric = {
      requestIndex: result.requestIndex,
      handle: details.handle,
      turns: archive ? archiveTurns(archive) : details.turns,
      folds: archive?.folds?.length ?? 0
    };
    const usage = details.usage ?? result.message.usage;
    if (usage) {
      fork.usage = totalsOf(usage);
      forkCost += usage.cost.total;
    }
    forkAttended += archive ? archiveAttended(archive) : usage ? attended(usage) : 0;
    return [fork];
  });

  let compactionCost = 0;
  let compactionAttended = 0;
  const reasons = options.trialRecord.steps.flatMap((step) => step.compactionEvents ?? []);
  const compactions: CompactionMetric[] = compactionEntries(branch).map(
    (entry: CompactionEntry, index) => {
      const position = branch.indexOf(entry);
      const next = requestAfter(position);
      const metric: CompactionMetric = {
        // The first request that ran on the summary; the compaction sits before it.
        requestIndex: next?.index ?? requests.length,
        tokensBefore: entry.tokensBefore
      };
      const reason = reasons[index]?.reason;
      if (reason !== undefined) metric.reason = reason;
      if (entry.usage) {
        metric.summaryUsage = totalsOf(entry.usage);
        compactionCost += entry.usage.cost.total;
        compactionAttended += attended(entry.usage);
      }
      if (next) metric.cacheWriteAfter = next.message.usage.cacheWrite;
      return metric;
    }
  );

  const markers = new Map<number, Set<InputSeriesMarker>>();
  const mark = (index: number, marker: InputSeriesMarker) => {
    if (index < 0 || index >= requests.length) return;
    let set = markers.get(index);
    if (!set) {
      set = new Set();
      markers.set(index, set);
    }
    set.add(marker);
  };
  for (const fold of folds) mark(fold.requestIndex, 'fold');
  for (const compaction of compactions) mark(compaction.requestIndex, 'compaction');
  for (const ask of asks) mark(ask.requestIndex, 'ask');
  for (const fork of forks) mark(fork.requestIndex, 'fork');
  const inputSeries: InputSeriesPoint[] = requests.map((request) => ({
    index: request.index,
    stepId: stepIds[request.index] ?? '',
    attended: attended(request.message.usage),
    markers: [...(markers.get(request.index) ?? [])]
  }));

  const toolSchema = toolResults(branch).filter(
    (result: ToolResultRef) =>
      result.message.isError && TOOL_SCHEMA_ERROR.test(textOf(result.message.content))
  ).length;

  let wallTimeMs = 0;
  for (const step of options.trialRecord.steps) {
    if (step.durationMs !== undefined) wallTimeMs += step.durationMs;
    else if (step.endedAt !== undefined) {
      wallTimeMs += new Date(step.endedAt).getTime() - new Date(step.startedAt).getTime();
    }
  }

  const checks = options.checks;
  const scoreStep: Record<string, number> = {};
  for (const step of options.trialRecord.steps) {
    if (step.score !== undefined) scoreStep[step.id] = step.score;
  }
  for (const snapshot of checks?.steps ?? []) {
    if (snapshot.stepId !== undefined) scoreStep[snapshot.stepId] = snapshot.score;
  }
  const category: TrialCategory = checks?.category ?? options.trialRecord.category ?? 'infra';

  const metrics: MetricsJson = {
    requests: requests.length,
    turns: requests.length,
    toolCalls: toolCallCounts,
    tokens,
    tokenBasis,
    contextAttended,
    contextAttendedAll:
      contextAttended + forkAttended + askAttended + compactionAttended + cacheWarmAttended,
    peakContext,
    cacheHitRate: {
      overall: contextAttended > 0 ? cacheRead / contextAttended : 0,
      medianPerRequest: median(hitRates),
      shareBelowHalf:
        hitRates.length > 0 ? hitRates.filter((rate) => rate < 0.5).length / hitRates.length : 0
    },
    cost: {
      total: mainCost + askCost + forkCost + compactionCost + cacheWarmCost,
      overhead: {
        fold: foldOutputCost,
        ask: askCost,
        fork: forkCost,
        compaction: compactionCost,
        cacheWarm: cacheWarmCost
      }
    },
    wallTimeS: wallTimeMs / 1000,
    compactions,
    folds,
    rejectedFolds,
    recalls,
    asks,
    forks,
    reminders: customMessages(branch, REMINDER_TYPE).length,
    errors: { throttled, toolSchema, terminal },
    inputSeries,
    category,
    flags: checks?.flags ?? options.trialRecord.flags ?? [],
    scoreStep
  };
  if (timeToFirstFold) metrics.timeToFirstFold = timeToFirstFold;
  if (checks?.scoreCode !== undefined) metrics.scoreCode = checks.scoreCode;
  if (checks?.scoreProbe !== undefined) metrics.scoreProbe = checks.scoreProbe;
  if (checks?.pass !== undefined) metrics.pass = checks.pass;
  return metrics;
}

/**
 * `metrics.json` of a trial dir from its `session.jsonl`; `bench run`, `bench check` and
 * `bench judge` all write it through here so a regrade or a judged probe reaches the report.
 * Undefined when the trial has no session.
 */
export function writeMetricsJson(
  trialDir: string,
  trialRecord: ComputeMetricsOptions['trialRecord'],
  checks?: ChecksJson
): MetricsJson | undefined {
  const sessionPath = join(trialDir, 'session.jsonl');
  if (!existsSync(sessionPath)) return undefined;
  const metrics = computeMetrics(
    checks === undefined ? { sessionPath, trialRecord } : { sessionPath, trialRecord, checks }
  );
  writeFileSync(join(trialDir, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
  return metrics;
}
