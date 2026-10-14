import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type Api,
  type AssistantMessage,
  fauxAssistantMessage,
  getSystemMessageText,
  type Model,
  type SystemMessage
} from '@earendil-works/pi-ai';
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  VERSION as PI_VERSION,
  SessionManager,
  SettingsManager
} from '@earendil-works/pi-coding-agent';
import { CACHE_DIR, DEFAULT_PI_MODELS_PATH } from './config.js';
import { createFauxDriver, type FauxDriver, type FauxScript } from './faux.js';
import { ConfigError } from './fields.js';
import {
  episodesToolDescriptions,
  isThrottledError,
  promptIdFrom,
  promptIdFromSystemMessage,
  sha256
} from './jsonl.js';
import type { Logger } from './log.js';
import type {
  ConditionSpec,
  ModelSpec,
  PiSettings,
  ProviderKind,
  RunConfig,
  Step,
  StepCaps,
  StepDriveResult,
  TrialAudit
} from './types.js';

export { PI_VERSION };

/** `pi.registerProvider` from an inline factory shows up as `<inline:N>` in the extension paths. */
const SYNTHETIC_PATH_RE = /^<.*>$/;

// ---------------------------------------------------------------------------
// Isolated environment (DESIGN 6)
// ---------------------------------------------------------------------------

export interface IsolatedDirs {
  /** Empty; `HOME` points here. */
  home: string;
  /** Holds only `settings.json`; `PI_CODING_AGENT_DIR` and the SDK `agentDir` point here. */
  agent: string;
  /** `npm_config_cache`; seeded only by the template install (DESIGN 5.1). */
  npmCache: string;
}

/** Creates `home/` and `agent/` under `root`. `settings.json` is written by `writeSettings`. */
export function createIsolatedDirs(root: string, npmCache = join(CACHE_DIR, 'npm')): IsolatedDirs {
  const dirs = { home: join(root, 'home'), agent: join(root, 'agent'), npmCache };
  mkdirSync(dirs.home, { recursive: true });
  mkdirSync(dirs.agent, { recursive: true });
  return dirs;
}

/**
 * Environment the agent and its shell commands run in. pi reads `HOME` (`~/.agents/skills`,
 * trust checks), `PI_CODING_AGENT_DIR`, `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK` and `PI_TELEMETRY`
 * (docs/environment-variables.md); the npm and git variables only reach the agent's child
 * processes, which inherit `process.env` through pi's bash tool. The git identity exists
 * because the isolated `HOME` has no `.gitconfig`, and sealing the repo needs one.
 */
export function isolatedEnv(dirs: IsolatedDirs): Record<string, string> {
  return {
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    PI_CODING_AGENT_DIR: dirs.agent,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    npm_config_offline: 'true',
    npm_config_cache: dirs.npmCache,
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'bench',
    GIT_AUTHOR_EMAIL: 'bench@localhost',
    GIT_COMMITTER_NAME: 'bench',
    GIT_COMMITTER_EMAIL: 'bench@localhost'
  };
}

/**
 * Applies `isolatedEnv` to this process; pi's bash tool copies `process.env` at spawn time, so
 * this is process-wide and set once per run, before any trial. Returns the restore function.
 * Resolve `~` paths (scenario sources, cache dirs) before calling this.
 */
export function applyIsolatedEnv(dirs: IsolatedDirs): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(isolatedEnv(dirs))) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

// ---------------------------------------------------------------------------
// Settings (identical for A and B)
// ---------------------------------------------------------------------------

/**
 * Settings written to `<agent>/settings.json` and handed to `SettingsManager.inMemory`. Cache
 * warming is off: pi's default re-sends the prompt near the cache TTL as `usage` entries
 * outside the model's turns, more often for the larger prompts, so it would bias A against B
 * (DESIGN 2, 6).
 */
export function buildSettings(config: RunConfig, extra: Partial<PiSettings> = {}): PiSettings {
  const settings: PiSettings = {
    defaultProjectTrust: 'always',
    cacheWarming: 'off',
    retry: {
      enabled: true,
      maxRetries: config.retry.maxRetries,
      baseDelayMs: config.retry.baseDelayMs,
      provider: { maxRetries: 0 }
    },
    compaction: {
      enabled: true,
      ...(Object.keys(config.compactionOverrides).length > 0
        ? { modelOverrides: config.compactionOverrides }
        : {})
    }
  };
  return mergeSettings(settings, extra);
}

/** Shallow merge with `compaction` and `retry` merged one level deeper. */
export function mergeSettings(base: Partial<PiSettings>, extra: Partial<PiSettings>): PiSettings {
  const merged: PiSettings = { ...base, ...extra };
  if (extra.compaction) merged.compaction = { ...base.compaction, ...extra.compaction };
  if (extra.retry) merged.retry = { ...base.retry, ...extra.retry };
  return merged;
}

export function writeSettings(dirs: IsolatedDirs, settings: PiSettings): string {
  const path = join(dirs.agent, 'settings.json');
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return path;
}

// ---------------------------------------------------------------------------
// System prompt audit (DESIGN 2); the prompt id itself lives in jsonl.ts
// ---------------------------------------------------------------------------

/**
 * Hash of the rendered system message with the `<cwd>` section normalized: every trial runs in
 * its own scratch directory, and the audit must agree across the trials of a cell.
 */
export function systemPromptHash(message: SystemMessage): string {
  const sections = { ...message.sections };
  if (typeof sections.cwd === 'string') sections.cwd = '<cwd>\n.\n</cwd>';
  return sha256(getSystemMessageText({ ...message, sections }));
}

/** The leading system message of the session's active branch, persisted on the first request. */
export function findSystemMessage(session: AgentSession): SystemMessage | undefined {
  for (const entry of session.sessionManager.getBranch()) {
    if (entry.type === 'message' && entry.message.role === 'system') return entry.message;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Session creation (DESIGN 5.1 step 5)
// ---------------------------------------------------------------------------

export interface TrialSessionOptions {
  model: ModelSpec;
  condition: ConditionSpec;
  /** The sealed trial repo. */
  cwd: string;
  /** Session JSONL goes to `<sessionDir>`; pi-episodes writes `<file>.episodes/` next to it. */
  sessionDir: string;
  dirs: IsolatedDirs;
  settings: PiSettings;
  /** Credentials for real providers; never `~/.pi/agent/auth.json`. */
  authPath: string;
  /** pi `models.json` with custom endpoints, from `resolvePiModelsPath`; `null` loads none. Unused by `faux`. */
  modelsPath: string | null;
  provider: ProviderKind;
  /** Required when `provider` is `faux`. */
  fauxScript?: FauxScript;
}

export interface TrialSession {
  session: AgentSession;
  /** Static fields; `completeAudit` fills the prompt fields after the first step. */
  audit: TrialAudit;
  /** Present for faux sessions. */
  faux?: FauxDriver;
}

/**
 * The runtime every real-provider session, preflight and judge call goes through: the bench's
 * credentials and, when `modelsPath` is set, its `models.pi.json`. pi swallows a broken file
 * (bad JSON, schema, a provider without `baseUrl`) and reports the provider as unknown later;
 * here it is the error. The catalog cache pi keeps next to `modelsPath` goes to `bench/cache`
 * so nothing is written into `bench/config`.
 */
export async function createModelRuntime(
  authPath: string,
  modelsPath: string | null
): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    modelsPath,
    authPath,
    modelsStorePath: join(CACHE_DIR, 'models-store.json')
  });
  const error = runtime.getError();
  if (error !== undefined) {
    throw new ConfigError(modelsPath === null ? error : `${modelsPath}: ${error}`);
  }
  return runtime;
}

/**
 * Resolves `provider/modelId` and checks its credentials; `ConfigError` names what is missing:
 * the provider (neither built into pi nor in `models.pi.json`), the model, or the key.
 */
export function resolveModel(
  runtime: ModelRuntime,
  model: string,
  authPath: string,
  modelsPath: string | null
): Model<Api> {
  const [providerId, ...rest] = model.split('/');
  if (runtime.getProvider(providerId!) === undefined) {
    throw new ConfigError(
      `unknown model ${model}: provider ${providerId} is not built into pi${modelsPath === null ? `; define it in ${DEFAULT_PI_MODELS_PATH}` : ` and not defined in ${modelsPath}`}`
    );
  }
  const found = runtime.getModel(providerId!, rest.join('/'));
  if (found === undefined) {
    throw new ConfigError(
      `unknown model ${model}: provider ${providerId} has no model ${rest.join('/')}; see pi --list-models${modelsPath === null ? '' : ` or ${modelsPath}`}`
    );
  }
  if (!runtime.hasConfiguredAuth(found.provider)) {
    throw new ConfigError(
      `no credentials for ${found.provider}: add them to ${authPath} or the environment`
    );
  }
  return found;
}

/**
 * Before any trial repo is built: every model of the run must resolve and have credentials,
 * so a missing key fails the run at once instead of as a chain of `infra` trials.
 */
export async function preflightModels(
  models: readonly ModelSpec[],
  authPath: string,
  modelsPath: string | null
): Promise<void> {
  const runtime = await createModelRuntime(authPath, modelsPath);
  for (const spec of models) resolveModel(runtime, spec.model, authPath, modelsPath);
}

export async function createTrialSession(options: TrialSessionOptions): Promise<TrialSession> {
  const { cwd, dirs, settings } = options;
  mkdirSync(options.sessionDir, { recursive: true });
  const episodes = options.condition.extension !== undefined;

  let faux: FauxDriver | undefined;
  if (options.provider === 'faux') {
    if (options.fauxScript === undefined) {
      throw new ConfigError('provider faux needs a script');
    }
    faux = createFauxDriver(options.fauxScript, { episodes, cwd });
  }
  const fauxDriver = faux;

  const settingsManager = SettingsManager.inMemory(settings, { projectTrusted: true });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: dirs.agent,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noExtensions: true,
    ...(episodes ? { additionalExtensionPaths: [options.condition.extension!] } : {}),
    ...(fauxDriver
      ? { extensionFactories: [(pi) => pi.registerProvider(fauxDriver.handle.provider)] }
      : {})
  });
  await resourceLoader.reload();
  const loaded = resourceLoader.getExtensions();
  if (loaded.errors.length > 0) {
    throw new Error(
      `extension load failed: ${loaded.errors.map((error) => `${error.path}: ${error.error}`).join('; ')}`
    );
  }

  const modelRuntime = await createModelRuntime(
    options.authPath,
    fauxDriver ? null : options.modelsPath
  );
  const model: Model<Api> = fauxDriver
    ? fauxDriver.handle.getModel()
    : resolveModel(modelRuntime, options.model.model, options.authPath, options.modelsPath);

  const { session } = await createAgentSession({
    cwd,
    agentDir: dirs.agent,
    model,
    thinkingLevel: options.model.thinking,
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.create(cwd, options.sessionDir),
    settingsManager
  });
  await session.bindExtensions({});

  const auth = modelRuntime.getProviderAuthStatus(model.provider);
  const authKind: TrialAudit['authKind'] = fauxDriver
    ? 'faux'
    : modelRuntime.isUsingOAuth(model.provider)
      ? 'oauth'
      : auth.source === 'environment'
        ? 'env'
        : auth.source === 'stored'
          ? 'api-key'
          : 'unknown';

  // Taken from the model object the runtime resolved, so a `models.pi.json` entry's declared
  // window, output cap and endpoint are what the trial records, not the built-in catalog's.
  const audit: TrialAudit = {
    model: `${model.provider}/${model.id}`,
    provider: model.provider,
    modelId: model.id,
    baseUrl: model.baseUrl,
    authKind,
    thinking: session.thinkingLevel,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    settings: session.settingsManager.getSettings(),
    tools: session.getActiveToolNames(),
    systemPromptHash: '',
    extensionPaths: session.extensionRunner.getExtensionPaths(),
    piVersion: PI_VERSION,
    nodeVersion: process.version,
    ...episodesCommit(options.condition)
  };

  const result: TrialSession = { session, audit };
  if (fauxDriver) result.faux = fauxDriver;
  return result;
}

/** Extension paths that were loaded from disk, without inline factories such as the faux provider. */
export function loadedExtensionPaths(audit: Pick<TrialAudit, 'extensionPaths'>): string[] {
  return audit.extensionPaths.filter((path) => !SYNTHETIC_PATH_RE.test(path));
}

/**
 * After the first step: hash of the system prompt the model actually received, the tool
 * declarations it carried, the prompt id, and the `api` of the first assistant message.
 * Returns the problem when the session has no system message yet.
 */
export function completeAudit(session: AgentSession, audit: TrialAudit): string | undefined {
  const system = findSystemMessage(session);
  if (system === undefined) return 'no system message in the session';
  audit.systemPromptHash = systemPromptHash(system);
  audit.tools = (system.toolsAdded ?? []).map((tool) => tool.name);
  const promptId = promptIdFromSystemMessage(system);
  if (promptId !== undefined) audit.promptId = promptId;
  for (const entry of session.sessionManager.getBranch()) {
    if (entry.type === 'message' && entry.message.role === 'assistant') {
      audit.api = entry.message.api;
      break;
    }
  }
  return undefined;
}

/** Commit of the extension's checkout; dirty when its own directory has uncommitted changes. */
function episodesCommit(
  condition: ConditionSpec
): Pick<TrialAudit, 'episodesCommit' | 'episodesDirty'> {
  if (condition.extension === undefined) return {};
  const dir = dirname(condition.extension);
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  try {
    return {
      episodesCommit: git(['rev-parse', 'HEAD']),
      episodesDirty: git(['status', '--porcelain', '--', dir]) !== ''
    };
  } catch {
    return {};
  }
}

/** Lets pi-episodes flush its archive, then disposes the session. */
export async function closeTrialSession(session: AgentSession): Promise<void> {
  try {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  } finally {
    session.dispose();
  }
}

// ---------------------------------------------------------------------------
// Step driver (DESIGN 5.2, 5.6)
// ---------------------------------------------------------------------------

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

/**
 * Sends one step's prompt and records what pi did until the run settled, including retries and
 * overflow compaction. A cap aborts the session and ends the step as `timeout` or `turn_cap`.
 * `error` means the step ended on a 429 or 5xx after pi's retries, or the prompt rejected; the
 * run loop turns that into `infra` (DESIGN 5.6). Any other terminal provider error leaves the
 * step `settled` with the text in `errors`: it was within the agent's or the extension's
 * control, so the checks decide the category.
 */
export async function driveStep(
  session: AgentSession,
  step: Step,
  caps: StepCaps,
  log: Logger
): Promise<StepDriveResult> {
  const result: StepDriveResult = {
    id: step.id,
    kind: step.kind,
    startedAt: new Date().toISOString(),
    end: 'settled',
    requests: 0,
    toolCalls: {},
    compactions: 0,
    compactionEvents: [],
    retries: 0,
    errors: [],
    throttled: 0,
    overflow: false
  };
  let lastAssistant: AssistantMessage | undefined;
  let aborting = false;
  const abort = (end: 'timeout' | 'turn_cap', why: string) => {
    if (aborting) return;
    aborting = true;
    result.end = end;
    log.warn('step cap hit', { cap: end, why });
    session.abort().catch((error: unknown) => {
      log.warn('abort failed', { error: error instanceof Error ? error.message : String(error) });
    });
  };

  const onEvent = (event: AgentSessionEvent) => {
    switch (event.type) {
      case 'message_end': {
        if (event.message.role !== 'assistant') break;
        const message = event.message;
        lastAssistant = message;
        // After an abort pi records a cut-off or synthetic error message; neither is a request
        // the model answered.
        if (message.stopReason === 'aborted' || aborting) break;
        result.requests++;
        for (const block of message.content) {
          if (block.type === 'toolCall') {
            result.toolCalls[block.name] = (result.toolCalls[block.name] ?? 0) + 1;
          }
        }
        if (message.stopReason === 'error') {
          result.errors.push(message.errorMessage ?? 'unknown error');
          if (isThrottledError(message)) result.throttled++;
        }
        if (caps.turns !== undefined && result.requests >= caps.turns) {
          abort('turn_cap', `${result.requests} assistant messages`);
        }
        break;
      }
      case 'compaction_start':
        log.info('compaction start', { reason: event.reason });
        break;
      case 'compaction_end':
        if (event.result !== undefined && !event.aborted) {
          result.compactions++;
          result.compactionEvents!.push({
            reason: event.reason,
            tokensBefore: event.result.tokensBefore
          });
        }
        if (event.reason === 'overflow' && event.result === undefined && !event.aborted) {
          result.overflow = true;
          result.errors.push(`context overflow: ${event.errorMessage ?? 'compaction failed'}`);
        }
        log.info('compaction end', {
          reason: event.reason,
          ok: event.result !== undefined,
          tokensBefore: event.result?.tokensBefore
        });
        break;
      case 'auto_retry_start':
        result.retries++;
        log.warn('retry', {
          attempt: event.attempt,
          max: event.maxAttempts,
          error: event.errorMessage
        });
        break;
      case 'auto_retry_end':
        if (!event.success && event.finalError !== undefined) {
          log.warn('retry exhausted', { attempt: event.attempt, error: event.finalError });
        }
        break;
      default:
        break;
    }
  };

  const unsubscribe = session.subscribe(onEvent);
  const timer = setTimeout(() => abort('timeout', `${caps.wallMs} ms`), caps.wallMs);
  const started = performance.now();
  log.info('step start', { kind: step.kind, wallMs: caps.wallMs, turns: caps.turns });
  try {
    await session.prompt(step.text);
  } catch (error) {
    result.end = 'error';
    result.errors.push(
      `prompt rejected: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timer);
    unsubscribe();
    result.durationMs = Math.round(performance.now() - started);
    result.endedAt = new Date().toISOString();
  }

  if (result.end === 'settled' && lastAssistant !== undefined && isThrottledError(lastAssistant)) {
    result.end = 'error';
  }
  if (lastAssistant !== undefined && step.kind !== 'goal') {
    const answer = assistantText(lastAssistant);
    if (answer.length > 0) result.answer = answer;
  }
  log.info('step end', {
    end: result.end,
    requests: result.requests,
    durationMs: result.durationMs,
    compactions: result.compactions,
    retries: result.retries,
    errors: result.errors.length
  });
  return result;
}

// ---------------------------------------------------------------------------
// Startup dry run (DESIGN 2)
// ---------------------------------------------------------------------------

export interface DryRunResult {
  promptId: string;
  /** The rendered system prompt the faux request carried. */
  systemPrompt: string;
  toolDescriptions: string[];
}

/**
 * One faux request in an empty repo under the condition's extension, to learn the prompt id
 * the run expects from every B trial. Throws when the condition loads no episodes section.
 * The scratch dir sits next to `dirs.home`, inside the run's tmp dir.
 */
export async function dryRunPromptId(
  condition: ConditionSpec,
  model: ModelSpec,
  dirs: IsolatedDirs,
  settings: PiSettings,
  authPath: string
): Promise<DryRunResult> {
  const root = mkdtempSync(join(dirname(dirs.home), 'dry-run-'));
  const cwd = join(root, 'repo');
  mkdirSync(cwd);
  try {
    const trial = await createTrialSession({
      model,
      condition,
      cwd,
      sessionDir: join(root, 'session'),
      dirs,
      settings,
      authPath,
      modelsPath: null,
      provider: 'faux',
      fauxScript: { steps: [() => fauxAssistantMessage('ok')] }
    });
    try {
      await trial.session.prompt('hello');
      const system = findSystemMessage(trial.session);
      if (system === undefined) throw new Error('dry run produced no system message');
      const toolDescriptions = episodesToolDescriptions(system.toolsAdded ?? []);
      const systemPrompt = getSystemMessageText(system);
      const promptId =
        toolDescriptions === undefined ? undefined : promptIdFrom(systemPrompt, toolDescriptions);
      if (promptId === undefined || toolDescriptions === undefined) {
        throw new ConfigError(
          `condition ${condition.id}: ${condition.extension} loaded no episodes section or tools`
        );
      }
      return { promptId, systemPrompt, toolDescriptions };
    } finally {
      await closeTrialSession(trial.session);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
