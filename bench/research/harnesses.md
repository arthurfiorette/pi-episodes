# Harness research: what to fork, what to reuse, what pi already gives us

Research subagent report, 2026-10-14. Scope: open-source benchmark harnesses we could fork or reuse (part A), and what pi itself offers to drive benchmark runs (part B). Read-only; nothing in `~/dev/pi` was modified.

Our runner must: load pi with and without pi-episodes, drive several user prompts in one session, run each trial in a fresh git worktree of ts-json-schema-generator, run a 10-minute test suite as checker, repeat N times, swap models and thinking levels. The user writes TypeScript.

## Verdict

Write our own runner in TypeScript on top of the pi SDK. Do not fork any of the candidates.

Reasons, in order of weight:

1. Every candidate that supports arbitrary CLI agents (Harbor, Inspect sandbox bridge, promptfoo `exec:`, the small CLI-agent benches) models a trial as one instruction in, one result out, inside a container. Multi-prompt scripted sessions exist only as Harbor's multi-step tasks (one pi process per step, resumed with `--continue`) or Inspect solver chains. None drives "prompt 1, wait, prompt 2" against a live session while also letting us read pi's own session JSONL, which is where fold/recall/ask/fork, `context_edit`, and compaction evidence live.
2. pi's SDK already does the hard part: `createAgentSession` with an isolated `agentDir`, in-memory settings, a per-trial session dir, and `await session.prompt(p1); await session.prompt(p2)` resolving when each run settles (part B.1). The runner is a loop over (scenario, condition, model, repetition) that creates a worktree, runs that, runs the test suite, and parses the JSONL. That is a few hundred lines.
3. pi's own `packages/evals` (private, MIT repo) is a paired A/B runner with exactly our shape: control vs treatment, runs-per-variant, alternating order, fresh isolation per arm, native session JSONL saved, paired lift report with token/tool/time/cost deltas and "blocked pairs withhold the headline". It cannot be imported (not published) and it is Docker-and-root-drop heavy, but `src/plan.ts`, `src/report.ts`, and the session-driving code in `src/harness.ts` are the templates to copy.
4. The Python harnesses buy us Docker sandboxing, concurrency on cloud sandboxes, and a results viewer. We need none of those for a single-machine, worktree-per-trial, hours-long run, and the cost is a second language plus a container image that must carry a built ts-json-schema-generator with node_modules.

What to reuse from the candidates, by name:

- Harbor: task layout (`instruction.md`, `task.toml`, `tests/test.sh` writing `reward.txt`, `steps/step-N/` for milestones), `n_attempts`, and ATIF as an export format if we ever want their viewer. Harbor's own `pi` agent (`src/harbor/agents/installed/pi.py`) is the reference for turning a pi session JSONL into per-step metrics, including how it walks the entry tree to the active branch and sums `compaction`/`branch_summary` usage. If we later want cloud scale, Harbor is the one to plug into, via a `Pi` subclass that adds `--extension`.
- Inspect: `epochs` with `pass_at_k` / `at_least_n` reducers and the `.eval` log plus `inspect view` are a good reference for reporting. `sandbox_agent_bridge()` is how to put pi under a model proxy for exact token accounting if pi's own usage fields were ever in doubt (they are not; see B.3).
- Aider benchmark: one `results.json` per trial directory and a separate `--stats` pass that aggregates; `--tries` feedback loop; record `commit_hash` (dirty flag) of the harness in every result.
- ZhMax/harness-bench-fast: `--attempts K` with both pass@k and pass^k printed; checkpoint the JSON output after each completed task so a crash loses nothing.
- usamadar/coding-agent-benchmark: isolate the agent's config dir per benchmark (`CODEX_HOME`, Claude `--setting-sources local --strict-mcp-config`) so personal MCP servers, skills, and settings do not leak into runs. For pi this is `PI_CODING_AGENT_DIR` plus `HOME` (B.6).
- SWE-bench: the `FAIL_TO_PASS` / `PASS_TO_PASS` split for the checker: tests that must flip, tests that must not break.
- promptfoo: only if the prompt-variant A/B grows into many variants and we want its table UI; a `file://` custom provider that shells out to our runner is about 150 lines. Not now.

## Part A: candidates

Licenses and status checked against the GitHub API on 2026-10-14.

| Candidate | License | Lang | Arbitrary CLI agent | Multi-prompt in one session | Repeats | Sandbox per trial | Status |
|---|---|---|---|---|---|---|---|
| Harbor | Apache-2.0 | Python | yes (`BaseInstalledAgent`), has `pi` | multi-step tasks, one process per step with `--continue` | `n_attempts` | Docker or cloud sandbox | active, 6.1k stars |
| Terminal-Bench 1.x | Apache-2.0 | Python | yes (`BaseAgent.perform_task` over tmux) | no | `--n-attempts` | Docker | superseded by Harbor, last push 2026-07 |
| Inspect AI | MIT | Python | yes via `sandbox_agent_bridge()` | solver chain can exec many times | `--epochs` + reducers | Docker compose or local | active |
| SWE-bench harness | MIT | Python | no agent runner at all | n/a | n/a | Docker per instance (grading only) | active |
| mini-swe-agent / SWE-agent | MIT | Python | no, own agent only | no | rerun | Docker or local | active |
| OpenHands eval | MIT | Python | no, OpenHands agents only | `fake_user_response_fn` | rerun | Docker runtime | active |
| HAL harness | none | Python | Python function only | no | `--run_id` | `--docker`, `--vm` | archived 2026-07 |
| promptfoo | MIT | TypeScript | `exec:`, `file://*.js`, `opencode:sdk`, `anthropic:claude-agent-sdk` | `_conversation` (template-level, serial) | `--repeat N` | `copy_working_dir` temp copy | active, 26k stars |
| Braintrust / LangSmith SDKs | proprietary SaaS, OSS SDKs | TS/Python | wraps any `task` fn | whatever the fn does | `num_repetitions` (LangSmith) | none | active |
| METR task-standard / vivaria | MIT | Python / TS | vivaria agents only | no | vivaria runs | Docker | archived 2026-10, METR moved to Inspect |
| Aider benchmark | Apache-2.0 | Python | no, aider only | `--tries` feedback loop | rerun dirs | Docker image | active |
| pi `packages/evals` | MIT (repo) | TypeScript | pi only, via SDK | yes (`PiCodingAgentInput` steps) | `--runs-per-variant` | Docker + uid drop | in-repo, private package |

### Harbor (Terminal-Bench 2.0 framework)

- https://github.com/laude-institute/harbor, docs at https://docs.harborframework.com. Apache-2.0, Python, uv-managed.
- Task: directory with `instruction.md`, `task.toml`, `environment/Dockerfile` (or compose), `tests/test.sh` that writes `/logs/verifier/reward.txt` (or `reward.json` for multi-dimensional), optional `solution/solve.sh`. Multi-step: `steps/step-N/{instruction.md,tests/,solution/,workdir/setup.sh}` declared as `[[steps]]` in `task.toml` with `min_reward` early stopping and `multi_step_reward_strategy = "mean" | "final"` (https://docs.harborframework.com/tasks/multi-step).
- Agent: `BaseInstalledAgent` installs and runs the CLI inside the task container (`install()`, `run(instruction, environment, context)`, `populate_context_post_run`), `BaseAgent` keeps the loop outside. Custom agents are passed as `-a module:Class`. Built-in `pi` agent exists: it runs `pi --print --mode json --session-dir <logs>/pi/sessions [--continue] --provider P --model M [--extension ...] [--thinking L] <instruction>`, pipes stdout minus `message_update` to `pi.txt`, then converts the newest session JSONL on the active branch to ATIF with per-step `Metrics(prompt_tokens=input+cacheRead+cacheWrite, completion_tokens, cached_tokens, cost_usd, extra={cache_write_tokens, reasoning_tokens})`; `compaction` and `branch_summary` entries become agent steps with `pi_event_type` (`src/harbor/agents/installed/pi.py`). `PiOptions` exposes `thinking`, `model_api`, `max_turns` only. It sets `PI_CODING_AGENT_DIR=/tmp/harbor-pi-agent` only when a custom endpoint or MCP is configured, and copies skills to `$HOME/.agents/skills`.
- Multi-turn: multi-step tasks plus `--resume-trajectory` (`agents[].resume_trajectory: true`) make each step a new pi process continuing the prior session. There is also a simulated-user mode (`--user-agent ... --bridge acp`) but the ACP bridge supports only claude-code, gemini-cli, codex, opencode as targets.
- Repeats: `n_attempts`. No seeds. Model: `-m provider/model`, passed through to the agent.
- Sandbox: `environment.type` docker (default), podman, daytona, modal, e2b, and about twenty more. One container per trial.
- Metrics: per trial `result.json` (`TrialResult` in `src/harbor/models/trial/result.py`) with `verifier_result`, `agent_result` (`n_input_tokens` including cache, `n_output_tokens`, `n_cache_tokens`, `cost_usd`), `TimingInfo { started_at, finished_at }` for `environment_setup`, `agent_setup`, `agent_execution`, `verifier`, and `step_results[]` with the same per step; `agent/trajectory.json` (ATIF); whatever logs the agent wrote. Results under `jobs/<job_name>/`, `harbor view` for browsing, Harbor Hub for upload and leaderboards, `regrade` to re-run a verifier without re-running the agent.
- Effort for pi: a `Pi` subclass that appends `--extension <path>` (and installs pi-episodes into the image) is 20 to 40 lines of Python. The real cost is the Docker image with a built ts-json-schema-generator, the Python toolchain, and the loss of direct SDK access (no in-process events, no faux provider for harness tests). Multi-step also restarts the pi process per step, so any in-memory extension state must survive a session reload.

### Terminal-Bench 1.x harness

- https://github.com/laude-institute/terminal-bench. Apache-2.0, Python. Task = `tasks/<name>/{task.yaml,Dockerfile,solution.sh,run-tests.sh,tests/}`; agents subclass `BaseAgent` and drive a tmux session inside the container. Replaced by Harbor for TB 2.0 (the Harbor README has a migration note). Nothing here that Harbor does not do better.

### Inspect AI (UK AISI)

- https://github.com/UKGovernmentBEIS/inspect_ai, docs https://inspect.aisi.org.uk. MIT, Python.
- Task: Python `Task(dataset, solver, scorer, sandbox, epochs, ...)`; samples carry `input`, `target`, `files`, `metadata`. Config layering: task, `task_with()`, `eval()`, CLI flags; `--run-config` YAML for reproducible runs.
- Agent: native `react()` agents, or any external process via `sandbox_agent_bridge()`: a proxy inside the sandbox on port 13131 that speaks OpenAI Completions, OpenAI Responses, Anthropic, and Gemini and forwards to the eval's model, so every model call the agent makes lands in the Inspect transcript with usage. By default the bridge drops the agent's generation params (`temperature`, `max_tokens`, reasoning effort) and routes all model names to the eval model unless `model_aliases` maps them; `forward_generation_config=True` restores pass-through. `inspect_swe` (https://github.com/meridianlabs-ai/inspect_swe, MIT) ships `claude_code()` and `codex_cli()` agents built this way; no pi agent.
- Multi-turn: the solver controls the loop, so a solver can `sandbox().exec(["pi","--mode","json","--continue",...])` per prompt. Nothing built in for scripted user turns on CLI agents.
- Repeats: `--epochs N` with reducers `mean`, `median`, `mode`, `max`, `at_least_{n}`, `pass_at_{k}`, `pass_k_{k}`. Seeds only as a generation param. Model: `--model provider/name`, `--model-role grader=...` for judges.
- Sandbox: `sandbox="docker"` (compose per sample), `local`, extensions for k8s etc. `--max-sandboxes`, `--max-samples`.
- Metrics and storage: `.eval` log per run with model usage per sample, limits (`token_limit`, `time_limit`, `cost_limit`, `turn_limit`), `inspect view` viewer, `inspect log` and dataframe export (`samples_df`, `messages_df`).
- Effort for pi: Dockerfile with pi and the repo, a `models.json` pointing pi's provider `baseUrl` at the bridge port, a 40-line solver. Python again, and the bridge's model rewriting means pi's price table is bypassed by Inspect's own cost config, which complicates "same cost at list price" accounting. Strong reporting, wrong language and the wrong unit of work for us.

### SWE-bench harness

- https://github.com/SWE-bench/SWE-bench. MIT, Python. The harness only grades: `python -m swebench.harness.run_evaluation --predictions_path preds.jsonl --run_id X` builds a Docker image per instance, applies `model_patch`, runs the test spec and reports resolved by `FAIL_TO_PASS` and `PASS_TO_PASS`. No agent runner, no multi-turn, no tokens. Reuse only the FAIL_TO_PASS / PASS_TO_PASS idea for the checker.

### mini-swe-agent and SWE-agent

- https://github.com/SWE-agent/mini-swe-agent (MIT) and https://github.com/SWE-agent/SWE-agent (MIT), Python. Batch: `mini-extra swebench` and `sweagent run-batch --config x.yaml --instances.type file --instances.path instances.yaml --num_workers N`. Trajectory format `mini-swe-agent-1.1`: JSON with `info.model_stats` (`instance_cost`, `api_calls`), `info.config`, `info.exit_status`, and `messages` in OpenAI shape; SWE-agent writes `trajectories/<user>/<run>/<id>/<id>.traj`. Environment: local or Docker. Only their own agent loop; no hook for an external CLI. Not reusable for pi beyond the "one trajectory file per instance plus `preds.json`" layout.

### OpenHands evaluation harness

- https://github.com/All-Hands-AI/OpenHands, `evaluation/benchmarks/*/run_infer.py`, docs https://docs.openhands.dev/openhands/usage/developers/evaluation-harness. MIT. Pattern: `process_instance(instance, metadata) -> EvalOutput(instance_id, instruction, test_result, history, metrics, error)` run through `run_evaluation(instances, metadata, output_file, num_workers, process_instance)` into `output.jsonl`; `metrics` carries `accumulated_cost` and token totals; `EvalMetadata` includes `condenser_config`, since they benchmark their own context condensers. Multi-turn via `fake_user_response_fn`. OpenHands agents only, in their Docker runtime. The condenser-as-parameter design is the closest analogue to our compaction-vs-episodes comparison, but the code is unusable for pi.

### HAL harness (Princeton)

- https://github.com/princeton-pli/hal-harness. No license file; archived July 2026. `hal-eval --benchmark X --agent_dir d --agent_function main.run -A model_name=...`, agent = Python `run(input: dict) -> dict`, cost via Weave, `--docker` / `--vm`, `--continue_run`. Skip.

### promptfoo

- https://github.com/promptfoo/promptfoo. MIT, TypeScript. Providers relevant to us: `exec: <command>`, `file://provider.ts` (return `{ output, tokenUsage, cost, metadata }`), `opencode:sdk`, `anthropic:claude-agent-sdk`, `openai:codex-sdk`; guide "Evaluate Coding Agents" (https://www.promptfoo.dev/docs/guides/evaluate-coding-agents/) covers `copy_working_dir` (fresh copy per eval step), `--repeat 3`, `--no-cache`, `trajectory:step-count` assertions over OTEL traces, `llm-rubric` judges. Multi-turn is the `_conversation` template variable (forces concurrency 1) or `storeOutputAs`, both at prompt-template level, not "wait for an agent run then send the next prompt to the same session". Results in SQLite, `promptfoo view` compares evals. It is a reasonable reporting shell for prompt-variant A/B once a custom provider wraps our runner, but its one-call-one-output model and in-process assertions fit badly with hour-long trials and a 10-minute checker.

### Braintrust and LangSmith eval SDKs

- Braintrust TS `Eval(name, { data, task, scores })`, LangSmith `evaluate(target, data, evaluators, num_repetitions)`. Both store runs in their hosted service with experiment diffing. They wrap whatever our `task` function does; they add nothing for driving pi and introduce a vendor dependency for result storage. Not needed; a local JSONL plus a small report script covers us.

### METR task standard and vivaria

- https://github.com/METR/task-standard (MIT, archived) and https://github.com/METR/vivaria (MIT, archived). `TaskFamily` Python class with `get_tasks`, `get_instructions`, `start`, `score(t, submission)` or `intermediate_score`; Docker driver; agent runs as the `agent` user. METR now defines tasks in Inspect. Skip.

### Aider benchmark harness

- https://github.com/Aider-AI/aider/blob/main/benchmark/benchmark.py. Apache-2.0, Python. `./benchmark/benchmark.py <run-name> --model M --edit-format F --tries 2 --threads 10 --exercises-dir polyglot-benchmark`, must run inside its Docker image (`AIDER_DOCKER` check). Drives aider's `Coder` in-process, not a CLI. Per exercise `.aider.results.json` (`tests_outcomes` per try, `cost`, `duration`, `prompt_tokens`, `completion_tokens`, malformed-response counters) and `.aider.chat.history.md`; `--stats` aggregates to a YAML record with `pass_rate_1`, `pass_rate_2`, `total_cost`, `seconds_per_case`, `commit_hash`. Reuse the result-file-per-trial plus separate stats pass, and the practice of recording the harness commit hash with a dirty marker.

### Benchmarks built around CLI agents (Claude Code, Codex, OpenCode, pi)

- https://github.com/vanonselenp/harness-bench (no license): bash runner, six harness/model cells including `pi.dev`, five runs each, hidden test suite, `metrics.json` hand-filled. Methodology notes are sensible (medians over five runs, record auth path per run). Pattern only.
- https://github.com/thakoreh/agent-bench (`pip install cli-agent-bench`): `.agent-bench.yaml` with `command`/`args` per agent, copies the project to a temp dir, runs the agent as a subprocess, scrapes tokens from stdout, scores tests plus lint, SQLite history. Single prompt per run.
- https://github.com/twaldin/harness (MIT, archived): `RunSpec -> RunResult` adapters for thirteen CLIs including `pi` (model normalization to `openai-codex/gpt-5.4`), cost and token parsing per CLI, TS and Python APIs, `harness run --json`. Explicitly does not manage worktrees. Archived, but the pi adapter shows how others invoke pi headlessly.
- https://github.com/usamadar/coding-agent-benchmark (MIT): `tasks/<name>/{metadata.json,prompt.md,repo/,tests/}` with hidden tests, `results/<timestamp>/summary.json` plus per-task JSON; isolates agent config (`CODEX_HOME`, Claude `--setting-sources local --strict-mcp-config --no-chrome`). Single prompt.
- https://github.com/ZhMax/harness-bench-fast (MIT): `run-cli --cli-command '...' --attempts 5 --pass@ 1 --pass^ 5 --json-output results.json`, mechanical verifiers only, checkpointed output, `export-harbor`. Single prompt, Python.
- https://github.com/redhat-et/coding_agent_bench: a Harbor wrapper with validated recipes per agent including Pi against vLLM; leaderboards for SWE-bench Verified, SWE-bench Pro, TB 2.0 with cost columns. Confirms Harbor's `pi` agent works end to end.
- https://github.com/frixaco/harness-bench: Bun web app that runs amp/opencode/claude/codex/pi/droid in parallel, one git worktree per agent, PTY streaming, reviewer compare. Interactive tool, not a measurement harness.
- https://github.com/joaquinhuigomez/agent-eval (referenced from the ECC skill): task YAML with pinned commit, git worktree per run, `--runs 3`, pass rate / cost / time / consistency table. Closest in spirit to our worktree-per-trial design; single prompt.

None of these drive a scripted multi-prompt session, and none reads pi's session file for compaction or extension evidence.

### pi's own `packages/evals`

- `~/dev/pi/packages/evals` (`@earendil-works/pi-evals`, `"private": true`, repo MIT). README: paired documentation-lift evals, `without_docs` vs `with_docs`, `--runs-per-variant N` (or `PI_EVAL_RUNS_PER_VARIANT`), each arm in a fresh container, `.eval/<timestamp>_<id>/{protocol.json,expected-runs.json,observations.jsonl,tasks/*/vitest.json,<variant>/sessions/*/session.jsonl,report.json,report.txt}`.
- `src/plan.ts`: `createTaskPlan(cases, model, runsPerVariant)` expands to `(case, variant, model, runNumber)` and alternates variant order by run number to reduce order bias.
- `src/report.ts`: pairs exact arms, computes `controlPassRate`, `treatmentPassRate`, `lift`, flags (`no-lift`, `negative-delta`, `control-saturated`, `treatment-saturated`, `flaky`), paired deltas for `totalTokens`, `toolCalls`, `totalMs`, `estimatedCostUsd`, and `blockedPairs`; any blocked pair withholds the headline.
- `src/harness.ts`: `PiCodingAgentInput = string | Array<{ type: "prompt"; content } | { type: "reload" }>`, so multi-prompt sessions are already a first-class input. It isolates with `HOME`, `USERPROFILE`, `PI_CODING_AGENT_DIR` (`applyIsolatedEnvironment`), copies only the needed host credential into an `InMemoryCredentialStore` (`readStoredCredential(provider, authPath)`), builds `ModelRuntime.create({ credentials })`, `createAgentSessionServices({ cwd, modelRuntime, resourceLoaderOptions: { extensionFactories } })`, `SessionManager.create(workspace, join(root, "sessions"))`, `createAgentSessionFromServices({ services, sessionManager, model, thinkingLevel: "off", tools })`, asserts no unexpected extensions loaded, drives `await session.prompt(step.content)` per step, then reads `session.getSessionStats()` for `tokens.{input,output,cacheRead,cacheWrite,total}`, `toolCalls`, `cost`, and hashes the effective system prompt.
- Dependencies: `vitest-evals` 0.15.0 and `@vitest-evals/core`. Not published, so copy the ~150 relevant lines rather than import.

## Part B: what pi offers

File paths are under `~/dev/pi/packages/coding-agent` unless stated.

### B.1 Driving a multi-prompt session

SDK (`docs/sdk.md`, `src/core/sdk.ts`):

- `const { session } = await createAgentSession({ cwd, agentDir, model, thinkingLevel, settingsManager, sessionManager, resourceLoader, tools, noTools, excludeTools, customTools })`. `prompt()` "resolves after the run finishes, including automatic retries" (`docs/sdk.md` Prompting). Sequential prompts in one session are just `await session.prompt(p1); await session.prompt(p2);`; this is exactly what `src/modes/print-mode.ts` lines 131-137 and `packages/evals/src/harness.ts` lines 374-380 do. A prompt sent while streaming must choose `streamingBehavior: "steer" | "followUp"` (`PromptOptions`, `src/core/agent-session.ts` line 314) or it rejects.
- Completion signals: subscribe before prompting; `message_end` is the authoritative message, `agent_end` closes one low-level run, `agent_settled` means no more automatic work (retries, overflow compaction, queued messages). Use `agent_settled` or just the resolved `prompt()` promise. `abort()`, `waitForIdle()`, `session.reload()`, `session.compact()` exist.
- Isolation without touching `~/.pi`: pass `agentDir` (sdk.ts line 52; `createAgentSession` then uses `join(agentDir, "auth.json")` and `models.json` from there, lines 196-198), `settingsManager: SettingsManager.inMemory({ compaction: {...}, defaultThinkingLevel, ... })` (`src/core/settings-manager.ts` line 357), `sessionManager: SessionManager.create(cwd, sessionDir)` (`src/core/session-manager.ts` line 1755; `SessionManager.open(path, sessionDir)` line 1766, `SessionManager.continueRecent(cwd, sessionDir)` line 1793, `SessionManager.inMemory(cwd)` line 1804). `ModelRuntime.create({ credentials | authPath, modelsPath, allowModelNetwork })` (`src/core/model-runtime.ts` line 109) lets the harness use host credentials while keeping `agentDir` empty, as `packages/evals/src/harness.ts` does. The lower-level pair `createAgentSessionServices({ cwd, agentDir, settingsManager, modelRuntime, resourceLoaderOptions })` and `createAgentSessionFromServices({ services, sessionManager, model, thinkingLevel, tools, noTools, customTools })` (`src/core/agent-session-services.ts` lines 37-65, 135, 214) are exported from the package index. `pi-episodes/test/session.test.ts` lines 64-92 shows the same with the faux provider.

CLI:

- `pi --mode json "prompt 1" "prompt 2" "prompt 3"` runs the prompts sequentially in one session; positional messages become `parsed.messages` (`src/cli/args.ts` line 266), the first is merged with piped stdin and `@file` content (`src/cli/initial-message.ts`), the rest are sent one after another in `runPrintMode` (`src/modes/print-mode.ts` lines 131-137). `docs/cli-integration.md`: "All prompts are supplied when the process starts. The process streams events for that run and then exits; it does not accept later commands." Stdin is therefore not a sequential prompt channel. Harbor's multi-step approach, `pi --mode json --session-dir D "p1"` then `pi --mode json --session-dir D --continue "p2"`, also works because `--continue` resumes the most recent session in that directory.
- For true interleaving (prompt, run checker, decide the next prompt) use `--mode rpc` with `RpcClient` from the package (`docs/cli-integration.md`, `examples/rpc-client.ts`): `promptAndWait()` installs the listener before sending and waits for `agent_settled`.
- Relevant flags (`docs/cli.md`): `--session-dir <dir>` (beats `PI_CODING_AGENT_SESSION_DIR` and the `sessionDir` setting), `--session-id <id>`, `--no-session`, `-e/--extension <path>` (repeatable), `-ne/--no-extensions` (explicit `-e` still loads), `--skill`, `-ns/--no-skills`, `-np/--no-prompt-templates`, `-nc/--no-context-files`, `--system-prompt`, `--append-system-prompt`, `--model provider/id[:thinking]`, `--provider`, `--thinking`, `--api-key`, `-a/--approve` or `-na/--no-approve` for project trust. Env: `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY` (`docs/environment-variables.md` lines 81-86).
- Print and JSON modes cannot ask for project trust; with the default `defaultProjectTrust: "ask"` the repo's `.pi/` resources are skipped unless `--approve` is given or `defaultProjectTrust: "always"` is set in the agent-dir settings (`docs/security.md` lines 75-82). Context files (`AGENTS.md`) load regardless.

### B.2 Shrinking the context window so compaction triggers earlier

Two levers, both without touching `~/.pi` when `agentDir` / `PI_CODING_AGENT_DIR` points at a bench directory:

1. `compaction.modelOverrides` in `settings.json` or `SettingsManager.inMemory({...})`. Trigger is `contextTokens > contextWindow - reserveTokens` (`src/core/compaction/compaction.ts` line 267-270, `docs/compaction.md`). Per-model override keyed by exact `provider/modelId`:

   ```json
   {
     "compaction": {
       "enabled": true,
       "reserveTokens": 16384,
       "keepRecentTokens": 20000,
       "modelOverrides": {
         "anthropic/claude-sonnet-4-5": { "reserveTokens": 150000, "keepRecentTokens": 20000 }
       }
     }
   }
   ```

   With a 200k window that compacts above 50k tokens. Caveat from `docs/compaction.md` line 457: `reserveTokens` "also influences summarization output limits, capped by the model's maximum output tokens"; the summary request uses `maxTokens = min(floor(0.8 * reserveTokens), model.maxTokens)` (`compaction.ts` lines 712-714) and the split-span variant `0.5 * reserveTokens` (line 1090), so a large reserve only raises the cap to the model max; it does not break anything. Values must be non-negative safe integers; `enabled` is global. `test/suite/agent-session-compaction-model-overrides.test.ts` exercises exactly this with `models: [{ id: "faux-1", contextWindow: 4000 }]` and `modelOverrides: { "faux/faux-1": { reserveTokens: 2000, keepRecentTokens: 150 } }`.

2. `models.json` `modelOverrides` on a built-in provider, which changes the model's `contextWindow` itself (and therefore also what the footer and any extension sees). Schema `src/core/model-config.ts` lines 51-65 (`ModelOverrideSchema`: `name`, `reasoning`, `thinkingLevelMap`, `input`, `inputLimits`, `cost`, `promptCache`, `contextWindow`, `maxTokens`, `samplingParams`, `samplingParamsByThinkingLevel`, `headers`, `compat`), applied as the topmost layer in `src/core/provider-composer.ts` lines 553-575. A provider entry must contain at least one of `baseUrl`, `headers`, `compat`, `modelOverrides`, `models` (line 321).

   ```json
   {
     "providers": {
       "anthropic": {
         "modelOverrides": {
           "claude-sonnet-4-5": { "contextWindow": 60000 }
         }
       }
     }
   }
   ```

   Prefer option 1 for the benchmark: it leaves the model metadata truthful and keeps condition A and B on the same `settings.json`. Use option 2 only if pi-episodes reads `model.contextWindow` to decide when to fold and we want that to move with the budget.

### B.3 Evidence of compaction, usage fields, and the price table

Session file (`docs/session-format.md`):

- `{"type":"compaction", id, parentId, timestamp, summary, firstKeptEntryId, tokensBefore, usage?, details?, fromHook?, systemMessage?}`. `details` for the built-in compaction is `{ readFiles, modifiedFiles }`; `fromHook: true` marks an extension-provided summary. Count these on the active branch for "compaction events"; sum `usage` for summarization cost.
- `{"type":"context_edit", targetId, replacement}` is what pi-episodes writes when it removes a span; `branch_summary`, `custom`, `custom_message`, `usage` (kind `cache_warm`), `model_change`, `thinking_level_change` are the other entry types. Entries form a tree; walk from the last entry's `parentId` chain to get the active branch, as Harbor's `_active_session_events` does.
- Assistant messages record `provider`, `model`, `api`, `stopReason`, `thinkingLevel`, and `usage`.

Live events (`docs/json.md`): `compaction_start { reason: "manual" | "threshold" | "overflow" }`, `compaction_end { reason, result: { summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter, usage, details }, aborted, willRetry, errorMessage? }`, `summarization_retry_*`, `auto_retry_start/end`, `tool_execution_end { durationMs }`, `turn_start/turn_end`, `agent_settled`. Extension-side: `session_before_compact` (`event.reason`, `preparation.tokensBefore`, `preparation.settings`) and `session_compact_failed`.

Usage (`~/dev/pi/packages/ai/src/types.ts` lines 446-467):

```ts
interface Usage {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  cacheWrite1h?: number;   // Anthropic only, subset of cacheWrite at 1h retention
  reasoning?: number;      // subset of output, when the provider reports it
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
```

Cost is computed client-side by `calculateCost(model, usage)` (`packages/ai/src/models.ts` lines 1206-1226) from `model.cost` (`input`, `output`, `cacheRead`, `cacheWrite` in USD per million, optional `tiers[]` with `inputTokensAbove`); 1h cache writes are billed at 2x input. The price table is the generated catalog `packages/ai/src/models.generated.ts` (built by `packages/ai/scripts/generate-models.ts`, which pulls models.dev and hard-codes OpenAI list prices in `OPENAI_STANDARD_COSTS`), overlaid at runtime by pi.dev catalog data and `models.json` overrides. OAuth providers price at list: `openai-codex` models use `OPENAI_STANDARD_COSTS` (`generate-models.ts` lines 3116-3152) and Anthropic subscription auth uses the same `anthropic` model entries. So `usage.cost.total` in the JSONL is list price regardless of how the key was obtained. `session.getSessionStats()` (`src/core/agent-session.ts` line 4208) sums usage over all entries including compacted-away history, `usage` entries, and `compaction`/`branch_summary` usage, and counts `toolCalls`, `userMessages`, `assistantMessages`. Turn count: `turn_end` events, or assistant messages on the active branch.

### B.4 pi's test suite harness

`test/suite/harness.ts` (`createHarness(options)`) with the faux provider from `packages/ai/src/providers/faux.ts`:

- Options: `models?: FauxModelDefinition[]` (e.g. `{ id, contextWindow, maxTokens }`), `settings?: Partial<Settings>`, `tools?: AgentTool[]`, `initialActiveToolNames`, `allowedToolNames`, `excludedToolNames`, `resourceLoader`, `extensionFactories?: Array<InlineExtension | ...>`, `withConfiguredAuth`, `modelsJson?: Record<string, unknown>` (written to a temp `models.json` and loaded through `createModelRegistry`), `sessionManager` (default `SessionManager.inMemory()`).
- Returns `session`, `sessionManager`, `settingsManager`, `faux` with `setResponses(steps)` / `appendResponses` / `getPendingResponseCount()`, `events: AgentSessionEvent[]`, `eventsOfType("compaction_end")`, `tempDir`, `cleanup()`.
- Faux responses are `FauxResponseStep`: either a prebuilt `fauxAssistantMessage(text | fauxToolCall(name, args), { stopReason, errorMessage, usage })` or a function `(context, options) => AssistantMessage` that can assert on the request (`test/suite/agent-session-compaction-model-overrides.test.ts` lines 72-80 and 119-120). Overflow recovery is simulated with `stopReason: "error", errorMessage: "prompt is too long"`.
- `test/suite/README.md`: no real providers, keys, or network; deterministic. `pi-episodes/test/session.test.ts` already follows the same pattern with `fauxProvider()`, `DefaultResourceLoader({ extensionFactories: [(pi) => pi.registerProvider(faux.provider), episodes] })`, and a scripted list of steps with assertions on each request's visible transcript.

Reusable for harness self-tests: the runner's "drive N prompts, read JSONL, compute metrics" path can be exercised with a faux model whose steps emit `fold`/`recall` tool calls and a tiny `contextWindow` so compaction fires, with no API key. `test/suite/harness.ts` itself imports from `../../src/...` and `../utilities.ts`, so it cannot be imported from outside the pi repo; replicate the ~60 lines that matter (`registerFauxProvider`, `SettingsManager.inMemory`, `SessionManager.create`, `createAgentSession`).

### B.5 Listing models and providers, thinking level, temperature and seed

- `ModelRuntime` (`src/core/model-runtime.ts`): `getProviders()` line 441, `getModels(providerId?)` line 449, `getModel(providerId, modelId)` line 453, `getAvailable(providerId?)` line 489 (models whose provider has usable auth), `getAvailableSnapshot()`, `checkAuth(providerId)`, `getAllModels()`. Each `Model` carries `provider`, `id`, `api`, `reasoning`, `contextWindow`, `maxTokens`, `cost`, `thinkingLevelMap`. CLI: `pi --list-models [search]`.
- Thinking: `createAgentSession({ thinkingLevel })` or `session.setThinkingLevel(level)` (line 2637), CLI `--thinking off|minimal|low|medium|high|xhigh|max` or `--model id:high`; settings `defaultThinkingLevel`, `modelThinkingLevels` keyed by `provider/modelId`, `thinkingBudgets`. Levels are clamped to the model with `clampThinkingLevel`; `getSupportedThinkingLevels(model)` (`packages/ai/src/models.ts` line 1230) tells which apply. The level is persisted per session as a `thinking_level_change` entry and on each assistant message as `thinkingLevel`.
- Temperature and seed: no setting or CLI flag in the coding agent (grep for `temperature` in `packages/coding-agent/src` finds nothing). `StreamOptions.temperature` and `samplingParams` exist at the `pi-ai` layer (`packages/ai/src/types.ts` line 224-232) but `samplingParams` is honored only by `openai-completions`, `openai-responses`, `azure-openai-responses`; `models.json` can set `samplingParams` / `samplingParamsByThinkingLevel` per model for those APIs (`docs/models.md` "Configure sampling by thinking level"). For Anthropic the only hook is an extension handling `before_provider_request` (`src/core/extensions/types.ts` line 901) and patching `payload`. No seed support anywhere. Plan for repetition, not determinism.

### B.6 Resource discovery for a given `PI_CODING_AGENT_DIR`

From `docs/configuration.md` and `src/core/resource-loader.ts`:

- Agent dir (`PI_CODING_AGENT_DIR` or SDK `agentDir`): `settings.json`, `models.json`, `auth.json`, `mcp.json`, `keybindings.json`, `AGENTS.md` / `AGENTS.override.md` / `CLAUDE.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `extensions/`, `skills/`, `prompts/`, `themes/`. Settings `extensions`, `skills`, `prompts`, `packages` add more paths; `-builtin:<name>` disables a built-in extension.
- Project (cwd, after trust): `.pi/settings.json`, `.pi/mcp.json`, `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, `.pi/extensions/`, `.pi/skills/`, `.pi/prompts/`, `.pi/themes/`. Context files `AGENTS.md` / `CLAUDE.md` from cwd upward, no trust needed.
- Skills are also discovered from `~/.agents/skills/` (HOME-based, not agent-dir based) and `.agents/skills/` up to the repo root (`docs/skills.md` line 61). So isolation needs `HOME` as well as `PI_CODING_AGENT_DIR`; `packages/evals/src/harness.ts` `applyIsolatedEnvironment` sets `HOME`, `USERPROFILE`, `PI_CODING_AGENT_DIR`, and Harbor's pi agent copies skills into `$HOME/.agents/skills`.
- SDK control: `DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths, additionalSkillPaths, additionalPromptTemplatePaths, extensionFactories, noExtensions, disabledBuiltinExtensions, noSkills, noPromptTemplates, noThemes, noContextFiles, systemPrompt, appendSystemPrompt, skillsOverride, extensionsOverride, agentsFilesOverride })` (`src/core/resource-loader.ts` lines 276-313). `session.extensionRunner.getExtensionPaths()` lists what loaded; `packages/evals` asserts nothing unexpected is there.

Recipe for identical A and B: one bench agent dir (`bench/agent-dir/` with `settings.json`, `models.json`, `skills/`, no `auth.json`; credentials via `ModelRuntime.create({ credentials })` from the host `auth.json` or env), `HOME` pointed at an empty dir, `noContextFiles` off so the repo's `AGENTS.md` loads in both, project trust decided once (`--approve` or `defaultProjectTrust: "always"` in the bench settings), and condition B adds exactly one `additionalExtensionPaths: ["~/dev/pi-episodes/src/index.ts"]` (or `-e` on the CLI). Record `session.systemPrompt` and `getExtensionPaths()` per trial as the audit that the two conditions differ only there.
