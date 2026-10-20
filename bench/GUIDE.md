# Benchmark guide

Technical background for whoever changes the benchmark or tunes the prompt next, human or agent. [README.md](README.md) says how to run it; this file says why it is built this way, how the pieces underneath work, which traps were already hit, and how to test a prompt change. Facts about Harbor and DeepSWE here were checked against Harbor 0.24.0 and `datacurve/deep-swe-1-1` in October 2026. Both move fast: when this file and a [reference](#references) disagree, the reference wins, and this file should be fixed.

Findings from actual runs do not go here. They go in [OBSERVATIONS.md](../OBSERVATIONS.md), with the prompt hash they ran with. What to measure, and why, is in [MEASUREMENTS.md](../MEASUREMENTS.md).

<br />

## What the benchmark is for

pi-episodes has no trained model behind it. The only levers are the prompt section in `src/prompt.ts`, the tool descriptions, and harness behavior (stamps, cues, nudges). The benchmark exists to answer, for a given prompt version and model:

- Does the agent fold, and where? Zero folds means the prompt failed, whatever else the numbers say.
- Does it send fewer tokens and carry a smaller context than plain pi on the same task?
- Is the work as good: pass rate, share of tests passing, consistency across attempts?
- What does the extension cost when it does nothing: prompt section, tool definitions, stamps?

It compares two arms that differ only in pi-episodes being installed. Decisions behind that:

- **Compaction stays on in both arms.** pi's compaction is the last resort when the window fills; the extension is meant to work before that point, not to replace it. A run where the episodes arm compacts as often as plain pi is a run where folding did not happen.
- **The baseline is pi itself**, through Harbor's own pi adapter, not another agent. Same pi version, model, thinking level, packages and env in both arms, generated from one job file by `scripts/run.ts`, so one arm cannot be edited alone.
- **Models are a list.** The same job runs any model the provider exposes. Results are always read per model; never pool models.
- **Repeated attempts.** Agent runs vary a lot between attempts on the same task. One attempt per task shows behavior (folds happened or not); pass rate needs several.

<br />

## Why DeepSWE, and what else was considered

The useful task shape is long: enough work that the context fills and finished sub-episodes (exploration, a debugging loop, a first implementation) pile up behind the current one. Short tasks finish before there is anything to fold, so both arms look the same.

| Dataset | Shape | Verdict |
| --- | --- | --- |
| [DeepSWE](https://github.com/datacurve-ai/deep-swe) v1.1, `datacurve/deep-swe-1-1` | 113 features written from scratch for this benchmark, in 91 real repositories, five languages; hidden behavior tests; 30 to 170 agent steps per task on the published board | **Used.** Long enough for compaction pressure, contamination-resistant, maintained leaderboard, Harbor format |
| [SWE-bench Verified](https://www.swebench.com), SWE-bench Pro, [SWE-PolyBench](https://github.com/amazon-science/SWE-PolyBench) | One merged issue each | Too short; at most a "no regression on short tasks" check |
| [Terminal-Bench](https://github.com/harbor-framework/terminal-bench) | Terminal tasks across domains, mostly short | Not coding-in-a-repo; pi already has published numbers there |
| [SWE-Marathon](https://github.com/abundant-ai/swe-marathon) | 20 greenfield builds (a C compiler, product clones), 2 to 10 hours, ~100M tokens per trial, k=8 recommended | Right horizon, wrong shape and cost: one comparison would take billions of tokens. A headline run on two tasks at most |
| [Long-Horizon Terminal-Bench](https://github.com/zli12321/LHTB) | 46/77 tasks, mostly science, games and professional workflows; dense rewards | Few software tasks, and its numbers need its own patched Harbor (continue-until-timeout) |
| `scale-ai/swe-atlas-qna` | Codebase question answering | Not agentic coding |

DeepSWE's limit for this purpose: one goal per task. Folds happen inside a single feature, between sub-episodes, never between unrelated goals. The planned multi-step task covers the other case (see [Next steps](#next-steps)).

Facts about DeepSWE that matter here (from the downloaded `task.toml` files):

- Languages: 34 Go, 34 Python, 35 TypeScript, 5 JavaScript, 5 Rust. `jobs/deep-swe.yaml` takes up to 8 per language with seed 1 (34 tasks); the seed keeps the selection stable across runs and machines.
- Agent: 90 minutes (`timeout_sec = 5400`), 2 CPUs and 8 GB requested, `network_mode = "no-network"` during the agent phase.
- Environment: a prebuilt image per task on `public.ecr.aws/d3j8x8q7/swe-bench-202605`, amd64 only, ~3.7 GB each.
- Verifier: a separate container (`environment_mode = "separate"`), no network, 30 minutes. A `[[verifier.collect]]` hook runs `git diff --binary <base> HEAD` in the agent container, and the verifier applies that patch to a clean copy. That is why every instruction ends with "commit everything when you are done": uncommitted work is not graded.
- Reward: `reward.json` with `reward` (1 only if every test passes), `f2p_total`/`f2p_passed` (tests the feature must make pass), `p2p_total`/`p2p_passed` (tests that must keep passing), `f2p`, `p2p` and `partial` (share of all tests passing). The report uses `reward` for pass rate and `partial` as a less noisy secondary.
- The README says grading v1.1 needs Pier, datacurve's Harbor fork. Not true for Harbor 0.24.0: the oracle agent scored 1.0 on `arktype-json-schema-refs-dependencies` (25/25 f2p, 1679/1679 p2p) on stock Harbor.

<br />

## Why Harbor

[Harbor](https://harborframework.com) runs agents on tasks in sandboxes, in parallel, and writes every trial to disk in one format. It is the runner behind Terminal-Bench, and DeepSWE and most current agent datasets ship in its task format.

- It already has a pi adapter (`harbor.agents.installed.pi.Pi`), which both arms subclass. [`badlogic/pi-terminal-bench`](https://github.com/badlogic/pi-terminal-bench) is the older standalone adapter it replaced; nothing to take from it.
- [Pier](https://github.com/datacurve-ai/pier) is datacurve's fork, made for per-agent network allowlists and the collect hook. Stock Harbor now has both (`extra_allowed_hosts`, `[[verifier.collect]]`), so the upstream project is used.
- pi's own eval package (`packages/evals` in the [pi repository](https://github.com/earendil-works/pi)) does paired docs-lift comparisons in containers, but has no external datasets or graders.

### The pi adapter

Read [`src/harbor/agents/installed/pi.py`](https://github.com/harbor-framework/harbor/blob/main/src/harbor/agents/installed/pi.py) before changing `agents/pi_bench.py`. What it does:

- **Install**: `nvm` with Harbor's default Node (22 in 0.24.0), then `npm install -g @earendil-works/pi-coding-agent@<version>`. pi-episodes therefore runs on Node 22, which is why `engines.node` is `>=22.19.0` (pi's own minimum).
- **Run**: `pi --print --mode json --session-dir <logs>/pi/sessions --provider X --model Y [--thinking L] <instruction>`, adding `--continue` when resuming a multi-step task. The session JSONL lands in the trial's `agent/pi/sessions/`, which is what `scripts/stats.ts` reads.
- **Model connection**: the provider's API key is forwarded automatically. If it sees `<PROVIDER>_BASE_URL`, it assumes a custom OpenAI-style endpoint and writes its own `models.json` with a `harbor-endpoint` provider, which needs a `model_api` kwarg. `packageProvider: true` in a job file turns that off for providers that come from a pi package. When it does write `models.json` (or MCP config), it moves pi's config dir to `/tmp/harbor-pi-agent`; `PiBench._pi()` follows it so `pi install` lands in the dir pi reads.
- **Trajectory**: converts the session to ATIF (`trajectory.json`) and sums usage into `result.json`. It skips `custom` entries, so episode events never reach Harbor's viewer; that is why `populate_context_post_run` puts the stats in `agent_result.metadata`.

`PiEpisodes` adds one step to install: unpack the `pnpm pack` tarball into `~/.pi-episodes`, `npm install --omit=dev --omit=peer` (pi provides its own packages to extensions), then `pi install` that directory.

### Other Harbor behavior the runner depends on

- **Job config.** `scripts/run.ts` writes a [job config](https://docs.harborframework.com/jobs/configs) with one agent entry per model and arm. `task_names` are `fnmatch` globs over task names.
- **Trial order and concurrency.** Harbor builds trials as attempts → tasks → agents (agents innermost, see `job_plan.py`), so all arms and models of one task start together, and a slow hour at the provider hits both arms. `concurrency` is `n_concurrent_trials`: the total number of trials running at once, not per agent.
- **Environment variables.** See [Environment variables](https://docs.harborframework.com/jobs/environment-variables). `agents[].env` reaches only the agent phase; `${VAR}` is filled from the host or `--env-file`. Harbor redacts values of names matching `KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH` before writing configs (`utils/env.py`); the runner also keeps literal secrets out of `bench/.out` by passing them through the process environment.
- **Network.** See [Network policies](https://docs.harborframework.com/tasks/network-policies). Setup runs with the environment's baseline (open), so installs work; `[agent] network_mode = "no-network"` applies during `agent.run()`. `extra_allowed_hosts` turns it into an allowlist (`trial/network_policy.py`); on Docker that needs a Linux kernel with nftables, which Docker Desktop's VM has. Without the model's host in `allowedHosts`, the agent cannot reach any model that is not already allowed.
- **Results.** Each trial writes `result.json` (`verifier_result.rewards`, `agent_result` with tokens, cost and `metadata`, `exception_info`, timings), `config.json`, `trial.log`, `agent/`, `verifier/` and `artifacts/`. `harbor view <dir>` browses them.
- **Multi-step tasks.** See [Multi-step](https://docs.harborframework.com/tasks/multi-step). Steps with their own instruction, tests and `workdir/setup.sh`; `resume_trajectory: true` keeps one pi session across steps (the adapter passes `--continue`). Not used by DeepSWE; it is the base for the planned multi-step job.
- **Hub.** [Uploads](https://docs.harborframework.com/harbor-hub/upload) are private by default. [Leaderboards](https://docs.harborframework.com/harbor-hub/leaderboards) are created by the dataset's owner and never compute scores; rows are files you write, which is what `rows.yaml` is for, on a dataset you publish yourself.

<br />

## Traps already hit

| Symptom | Cause | Fix in place |
| --- | --- | --- |
| Trial fails in seconds with `toomanyrequests: Rate exceeded` | ECR Public limits anonymous image pulls | The runner pre-pulls at most four images concurrently, with retries and a shared exponential cooldown on rate limits, before Harbor starts |
| Episodes arm fails at install with `EBADDEVENGINES` | `devEngines` said Node `>=24.16` with `onFail: "error"`; the adapter installs Node 22 | Requirements lowered to pi's own `>=22.19.0`, `onFail: "warn"`. Keep the runtime requirement at or below what the adapter installs |
| `npm:pi-episodes@0.3.0` fails to install | That version was never published | Use `episodes: local` (packs the working tree) or a version that exists and includes the stats (`fca51a8` or later) |
| Warning "Artifact sources overlap: '/logs/artifacts' and '/logs/artifacts/model.patch'" | DeepSWE declares the patch as an artifact inside Harbor's default artifacts dir | Harmless; the patch is still collected |
| `CancelledError` in both arms, no reward | The job was interrupted (Ctrl-C) | Rerun; the report counts it as an error, not a result |
| Very slow trials on a Mac | DeepSWE images are amd64, emulated on Apple Silicon | Compare timings only within one machine; run the real jobs on an amd64 host |
| Verifier failures at high concurrency | Each task asks for 8 GB and verification starts a second container | Keep `concurrency × 8 GB` near the memory Docker has |
| Docker startup fails with `all predefined address pools have been fully subnetted` | Compose allocates a network per environment; Docker's default subnet pools are too small for high concurrency | Configure a non-overlapping `default-address-pools` range split into `/24` networks, restart Docker, and remove only confirmed stale job networks; see README |

<br />

## Reading results correctly

`scripts/report.ts` implements these; keep them when changing it.

- **The task is the unit.** Attempts on one task are correlated. Intervals are 95% percentile bootstrap over tasks (2000 resamples, fixed seed), not over trials.
- **Arms are paired by task.** Differences are computed per task, then summarized, only over tasks both arms ran.
- **Ratios are geometric means.** Tokens, cost, time and peak context compare as the geometric mean over tasks of episodes / pi, so one huge task does not dominate.
- **Errors score 0** and are listed separately. Infrastructure errors (pulls, cancellations, out-of-memory) should be rerun, not counted.
- **Never average across prompt hashes.** Every episodes session writes `episodes-meta` with the extension version and a hash of the prompt section and tool descriptions. The report groups by it and warns when one arm mixes hashes.
- **Overhead is separate from folding.** Before the first fold, the episodes arm is always larger: the prompt section and four tool definitions add about 2.7k tokens to every request (measured on the first request of a Haiku run: 3,265 vs 5,952), plus stamps. `overhead` in the stats says how much of a token difference is that.
- **Sizes.** With 34 tasks the pass-rate interval is around ±15 points even at 3 attempts. Paired token and context ratios are much tighter and readable from one attempt. A pass-rate difference inside its interval is not a result.

Cost of a run: trials = tasks × attempts × 2 arms × models. One trial takes 20 to 75 minutes (image pull and install, up to 90 minutes of agent, up to 30 of verifier). Wall time ≈ trials × average minutes / concurrency, plus the first image pull (~125 GB for 34 tasks).

<br />

## Tuning the prompt

The loop that turns runs into prompt changes:

1. **Edit** `src/prompt.ts` or a tool description. Read the token-budget comment at the top of `EPISODES_SECTION` first: every sentence is paid on every request, each fact has one home (when and why in the prompt, how to call in the tool description), and any wording change changes the prompt hash.
2. **Check** with `pnpm test` and `pnpm test-types`. `test/session.test.ts` runs real pi sessions with a scripted model, so it catches broken mechanics, not behavior.
3. **Run** the same tasks, model and machine as the previous run. One attempt per task is enough to see whether folding changed; use more before claiming anything about pass rate.
4. **Report** with `pnpm bench:report <run-dir> --format md` (or `--format table` for console tables), comparing against the previous run with the same tasks and model.
5. **Read transcripts.** The numbers say that something changed; only the episodes arm's session files (`bench/runs/<job>/<trial>/agent/pi/sessions/*.jsonl`) say why. Look for where the model considered folding and decided against it (its reasoning usually says so), finished sub-episodes that stayed in context, notes that dropped a condition or open item, and recalls that came back empty or should have happened.
6. **Log** what was seen and what changed in [OBSERVATIONS.md](../OBSERVATIONS.md), with the prompt hash before and after.

Where the numbers come from:

- `episodeStats()` in `src/stats.ts` (exported as `pi-episodes/stats`) computes everything from a session's entries: fold, fork, recall and ask records on tool results, `episodes-event` custom entries (fold rejections, cues, nudges) and `episodes-meta`. `/episodes stats` in pi and `scripts/session.ts` call the same function, so a number seen in a live session is the one in the report.
- It also reads plain pi sessions: no folds, but requests, context per request and compactions. `scripts/session.ts` zeroes `overhead.prompt` when there is no `episodes-meta`.
- pi stores custom entries with `pi.appendEntry()` and never sends them to the model; see pi's [session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md) and [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) docs.

What one run can and cannot tell: a single trial shows whether and where the model folds and what its notes look like. Token and context changes need a handful of paired tasks. Pass rate needs the full sample with several attempts.

<br />

## Next steps

Not built yet, in rough order of value:

- **`--arm episodes`**: run only the episodes arm and pair it in the report with an earlier baseline job on the same tasks, model and machine. The baseline does not depend on the prompt, so each prompt iteration would cost half.
- **`--episodes <git-ref>`**: pack another commit from a temporary worktree, to compare two prompt versions directly instead of each against plain pi.
- **A multi-step job** on [vega/ts-json-schema-generator](https://github.com/vega/ts-json-schema-generator), where one session works through several related goals and folds happen between goals. Design so far: base commit `0934c18`; revert fixes and hand them back as issue reports, one Harbor step each, graded by the fix's own fixture in `test/valid-data`, held out until the step's verifier runs. Candidate fixes, all of which reverse-apply cleanly except the last: `f4b9d90` (tuple rest element as a type alias), `8d536a4` (`Required<T>` and `-?`), `eb8abd7` (types referenced only in `additionalItems`), `32c3be6` (recursive discriminated union), `de2ea6e` (generic indexed access constraint), `75d1e26` (annotations lost through indexed access; revert by hand in `factory/parser.ts`, `withJsDoc(chainNodeParser)` back to `chainNodeParser`). Steps 1 and 3 share tuple rest elements and steps 2, 5 and 6 share mapped and indexed-access types, so later steps have a reason to recall earlier ones. Add a trailing-step trap (permission to skip the slow `test/vega-lite` suite while iterating, checked at the end) and a final step of questions about earlier steps, checked against per-step diffs. The full suite takes about 10 minutes; `FAST_TEST=1` skips type checking. Per-step stats need `episodeStats()` over the branch prefix up to each step's user message.
- **SWE-Marathon** for one headline run on two tasks, once a prompt version is worth it.

<br />

## References

Read these for current details; this file is a summary of them as of October 2026.

Harbor:
- Site and docs: https://harborframework.com, https://docs.harborframework.com (index for agents: https://docs.harborframework.com/llms.txt)
- Task format: [overview](https://docs.harborframework.com/tasks/overview), [environment](https://docs.harborframework.com/tasks/environment), [verifier](https://docs.harborframework.com/tasks/verifier), [multi-step](https://docs.harborframework.com/tasks/multi-step), [network policies](https://docs.harborframework.com/tasks/network-policies)
- Jobs and agents: [job configs](https://docs.harborframework.com/jobs/configs), [environment variables](https://docs.harborframework.com/jobs/environment-variables), [custom agents](https://docs.harborframework.com/agents/custom-agents)
- Hub: [datasets](https://hub.harborframework.com/datasets), [upload](https://docs.harborframework.com/harbor-hub/upload), [leaderboards](https://docs.harborframework.com/harbor-hub/leaderboards)
- Source: https://github.com/harbor-framework/harbor. Files read for this benchmark: `src/harbor/agents/installed/pi.py`, `agents/installed/base.py`, `agents/installed/node_install.py`, `agents/model_connection.py`, `agents/options.py`, `models/agent/context.py`, `models/trial/result.py`, `models/job/config.py`, `job_plan.py`, `trial/network_policy.py`, `utils/env.py`
- Older pi adapter: https://github.com/badlogic/pi-terminal-bench
- Terminal-Bench task examples: https://github.com/harbor-framework/terminal-bench

DeepSWE:
- Repository and task format: https://github.com/datacurve-ai/deep-swe
- Leaderboard and blog: https://deepswe.datacurve.ai, https://deepswe.datacurve.ai/blog/deepswe
- Paper: https://arxiv.org/abs/2607.07946
- Dataset: https://huggingface.co/datasets/datacurve/deep-swe, `datacurve/deep-swe-1-1` on the Harbor Hub
- Pier: https://github.com/datacurve-ai/pier

Other benchmarks considered:
- Compendium of agent benchmarks: https://github.com/philschmid/ai-agent-benchmark-compendium
- SWE-Marathon: https://github.com/abundant-ai/swe-marathon, https://www.swe-marathon.org, paper https://arxiv.org/abs/2606.07682
- Long-Horizon Terminal-Bench: https://github.com/zli12321/LHTB, https://zli12321.github.io/LHTB, paper https://arxiv.org/abs/2607.08964
- SWE-bench: https://www.swebench.com; SWE-PolyBench: https://github.com/amazon-science/SWE-PolyBench

pi:
- Repository: https://github.com/earendil-works/pi
- Docs used: [session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md), [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), [JSON mode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md), [CLI integration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli-integration.md), [settings](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md) (compaction), [environment variables](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/environment-variables.md) (`PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`, `PI_OFFLINE`), [packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)

This project:
- The design: https://arthur.place/subagents-forks-collapsing-context
- [MEASUREMENTS.md](../MEASUREMENTS.md): what to measure, and the papers behind the prompt (event segmentation, goal activation)
- [OBSERVATIONS.md](../OBSERVATIONS.md): what runs showed, by prompt hash
- `src/prompt.ts`: the prompt section and its token-budget rules
