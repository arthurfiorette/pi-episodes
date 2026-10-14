# Benchmark methodology and statistics for coding agents

Research report for `bench/PLAN.md`, phase 1. Written 2026-10-14. Every claim with a number has a URL next to it; where I compute something myself, the formula and inputs are shown so the coordinator can redo it.

Short version: no existing benchmark answers "same model, harness A vs harness B, long sessions, few tasks, many runs". The closest designs are the SWE-bench Verified rerun studies (Bjarnason et al. 2026; Liu & Han 2026) and Terminal-Bench's five-trials-per-task rule. The statistics we need are ordinary: runs are the unit of randomness, scenarios are fixed strata, tokens are the primary endpoint on a log scale, pass rate is a non-inferiority gate, and a pilot sets N.

## 1. How the main benchmarks define trial, task, score, and handle nondeterminism

### SWE-bench Verified

- Task: a GitHub issue plus the repo at the pre-fix commit. 500 instances filtered by human annotators from the 2,294-instance SWE-bench ([OpenAI, 2024](https://openai.com/index/introducing-swe-bench-verified/)).
- Score: the agent's patch is applied, then the gold `test_patch` is applied, then `FAIL_TO_PASS` tests (must now pass) and `PASS_TO_PASS` tests (must still pass) run. "Resolved" requires both sets to be 100% green; partial credit exists in the grader (`PARTIAL`) but the leaderboard counts only `FULL` ([grading.py](https://github.com/SWE-bench/SWE-bench/blob/main/swebench/harness/grading.py)). The agent never sees the test patch; it is injected at grading time.
- Trial: one attempt per instance. The leaderboard reports `% Resolved` from a single run; submissions must include per-instance trajectories, and best-of-k systems must show all rollouts plus the selection mechanism ([SWE-bench/experiments](https://github.com/SWE-bench/experiments)).
- Nondeterminism: not handled by the benchmark. The "bash-only" view runs every model through mini-SWE-agent; releases 1.x set temperature 0.0, releases 2.x do not set temperature at all ([swebench.com/verified](https://www.swebench.com/verified)). Epoch AI's independent runs use 484 of 500 instances, no network, git history after the issue removed, a 2M uncached-token budget, and report standard errors ([epoch.ai](https://epoch.ai/benchmarks/swe-bench-verified)).
- Cost: not on the official leaderboard.

### Terminal-Bench 2.0 and Harbor

- Task: a Docker environment, an instruction, hidden pytest tests, and a human reference solution. 89 tasks in 2.0, each validated by three reviewers ([paper, ICLR 2026](https://arxiv.org/abs/2601.11868)).
- Score: binary per trial; all tests in the task must pass. No partial credit, no LLM judge.
- Trial: "each trial is one agent's attempt at solving a single task". The paper ran every model/agent combination at least five times (32,155 trials total); the leaderboard requires `--k 5` (five runs per task) and reports mean pass rate with a ± that is the standard error ([tbench.ai](https://www.tbench.ai/leaderboard/terminal-bench/2.0); [pi-terminal-bench README](https://github.com/badlogic/pi-terminal-bench)). Third-party sites running the same tasks on mini-SWE-agent report `avg@3` ([themodelgap.com](https://themodelgap.com/benchmarks/terminal-bench-4-0)).
- The paper's Table 2 reports input and output tokens next to resolution rate per (model, agent) pair, so the cost dimension is visible even though the headline is pass rate.
- Harbor is the runner: tasks, agents, environments (Docker, Daytona, Modal), verifiers; `--n-attempts k` gives pass@k; each trial writes `trial_result.json` with reward, timing, and `usage_info` (tokens, cost) ([harborframework.com](https://www.harborframework.com/docs/tutorials/running-terminal-bench); [Harbor TB docs](https://mintlify.wiki/harbor-framework/harbor/examples/terminal-bench)). `pi` already has a Harbor adapter ([badlogic/pi-terminal-bench](https://github.com/badlogic/pi-terminal-bench)), including a patch for a Harbor `docker cp` bug that breaks the verifier when the agent creates `/tests`.
- Terminal-Bench 4.0 recalibrated per-task CPU/memory/timeouts following Anthropic's infrastructure-noise study and moved to a flat 8-hour agent timeout so frontier models "never or rarely" hit it ([tbench.ai news](https://www.tbench.ai/news/terminal-bench-4-0)).

### Aider polyglot

- Task: 225 Exercism exercises in six languages, the hardest subset of 697 ([aider leaderboard](https://aider.chat/docs/leaderboards/)).
- Score: `pass_rate_2`, the share of exercises whose unit tests all pass after two attempts; after the first failure the model sees the test output and tries once more. `pass_rate_1` is also reported. `--tries` defaults to 2 ([benchmark.py](https://github.com/Aider-AI/aider/blob/bdb4d9ff/benchmark/benchmark.py)).
- Trial: one run of the 225 exercises per leaderboard row. No repeats; no error bars. The leaderboard YAML carries `seconds_per_case`, `prompt_tokens`, `completion_tokens`, `total_cost`, `test_timeouts`, `exhausted_context_windows`, `percent_cases_well_formed` ([polyglot_leaderboard.yml](https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/polyglot_leaderboard.yml)).
- Nondeterminism: `use_temperature: true` (default) sends `temperature=0`; reasoning models get `use_temperature: false` and provider defaults ([adv-model-settings](https://aider.chat/docs/config/adv-model-settings.html); [test_models.py](https://github.com/Aider-AI/aider/blob/3ec8ec5a/tests/basic/test_models.py)). Contributors who rerun report "some fluctuations" between runs without quantifying them ([PR #3908](https://github.com/Aider-AI/aider/pull/3908)).
- Not relevant to us beyond its cost columns: the two-attempt-with-feedback protocol grades on tests the model is then shown, which our held-out design must avoid.

### METR time horizon (HCAST, RE-Bench, SWAA)

- Task: 170 tasks with human baseline times; agent runs are binarized via a task-specific threshold ([Kwa et al. 2025](https://arxiv.org/abs/2503.14499)).
- Trial: 8 runs per (agent, task) in the paper; the current pipeline launches 6 independent runs per task and flags reward hacks automatically plus by hand ([metr.org/time-horizons](https://metr.org/time-horizons/)). HCAST ran "at least 5 times" per agent per task ([HCAST](https://metr.org/hcast.pdf)).
- Score: a logistic fit of P(success) against log human time; the horizon is where the fit crosses 50% (or 80%).
- Uncertainty: 10,000-sample three-level hierarchical bootstrap over task families, then tasks, then runs. The paper notes error bars on individual models are wide but highly correlated across models, so the trend is better determined than any single horizon. Token usage per run is in the public analysis repo ([eval-analysis-public](https://github.com/METR/eval-analysis-public)).

### HAL (Princeton Holistic Agent Leaderboard)

- Three axes: models, scaffolds, benchmarks. 21,730 rollouts across 9 benchmarks and 9 models, about $40,000 ([Kapoor et al., ICLR 2026](https://arxiv.org/abs/2510.11977)).
- Cost: every run logs tokens and dollars through Weave; the leaderboard shows accuracy-vs-cost Pareto frontiers, with the frontier constrained to be convex because two agents can be mixed by randomization ([hal.cs.princeton.edu](https://hal.cs.princeton.edu/); [AI Agents That Matter](https://arxiv.org/abs/2407.01502)).
- Trial: single run per task for most cells. The paper says so directly: "we were forced to rely on single runs without statistical validation for most evaluations." Error bars on the plots are min-max over the few cells that were repeated.
- Documented drift sources: providers swapped weights behind stable endpoints (Together's DeepSeek R1 endpoint silently became R1-0528), OpenRouter may route the same model to FP4 or FP8 providers per request, rate-limit errors become silent false negatives, and latency numbers are unreliable under parallel execution.
- A follow-up on the HAL harness, "Towards a Science of AI Agent Reliability", runs each task K=5 times at temperature 0 and reports outcome consistency, trajectory consistency, and resource consistency (exp of minus the mean coefficient of variation of cost, time, and API calls across runs) ([arXiv 2602.16666](https://arxiv.org/abs/2602.16666)).

### SWE-bench Pro and Pro V2

- Task: 1,865 problems across 41 repos; public (731, GPL-licensed repos), held-out (858, private, to detect overfitting to the public set), commercial (276, private startup code) ([Scale, 2025](https://arxiv.org/abs/2509.16941)).
- Score: resolve rate under the same FAIL_TO_PASS / PASS_TO_PASS rule; "Pass@1"; models run under a single SWE-agent scaffold with a 250-turn limit and uncapped cost. The leaderboard shows a 95% binomial margin ([scaleapi.github.io](https://scaleapi.github.io/SWE-bench_Pro-os/)).
- V2 (2026-10-12) is the most thorough anti-leak protocol published: images built from sanitized bundles (no fixing commit, refs, stashes, hooks, or test files), a probe that checks this from inside the sandbox before every run, network locked to the model endpoint during the agent phase, grading on a pristine image from the captured diff (which caught a model forging a Go module checksum and another editing the module cache), hidden-test paths restored and agent edits to fixtures reverted before the test patch is applied, and a two-sided gate (reference patch passes, empty patch fails) on every task ([Scale Labs](https://labs.scale.com/blog/swe-bench-pro-v2)). V2 attributes the remaining public/private gap to training-time exposure.

### Multi-SWE-bench

- 1,632 instances (2,132 in the NeurIPS version) across Java, TS, JS, Go, Rust, C, C++; three scaffolds (MagentLess, MSWE-agent, MopenHands) times 9 to 12 models ([arXiv 2504.02605](https://arxiv.org/abs/2504.02605)).
- Score: resolved rate, plus file-level localization accuracy and average cost in dollars per issue. All leaderboard rows are Pass@1, single run, `hints_text` not used ([multi-swe-bench.github.io](https://multi-swe-bench.github.io/)).
- Useful finding for scenario design: resolved rate drops sharply for patches over 600 tokens or touching more than one file.

### tau-bench and pass^k

- tau-bench introduced pass^k: with n trials per task and c successes, pass^k = E_task[C(c,k)/C(n,k)], the probability that k i.i.d. trials all succeed; pass@k = 1 − E_task[C(n−c,k)/C(n,k)]. At k=1 both equal the mean per-trial success rate. gpt-4o's retail pass^1 was about 61% and pass^8 under 25% ([Yao et al. 2024](https://arxiv.org/abs/2406.12045)).
- Anthropic's agent-eval guide adopts the same vocabulary (task, trial, grader, transcript, outcome) and recommends pass@k when one success is enough and pass^k when consistency is the product ([Anthropic, Jan 2026](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)).

### Summary table

| Benchmark | Runs per task | Headline metric | Error bars | Cost reported | Hidden tests |
|---|---|---|---|---|---|
| SWE-bench Verified | 1 | % resolved | no | no | yes (test patch injected at grading) |
| Terminal-Bench 2.0 | ≥5 required | mean pass rate | SE over trials | tokens in paper; cost in Harbor results | yes |
| Aider polyglot | 1 | pass_rate_2 | no | yes (tokens, $, seconds) | no (tests shown on retry) |
| METR | 6 to 8 | 50% time horizon | hierarchical bootstrap | tokens in repo | task-specific scorers |
| HAL | 1 (mostly) | accuracy + cost Pareto | min-max where repeated | yes, by default | per benchmark |
| SWE-bench Pro | 1 | pass@1 | binomial 95% | no | yes, with V2 anti-leak protocol |
| Multi-SWE-bench | 1 | resolved rate | no | avg $ per issue | yes |
| tau-bench | n (3 to 8) | pass^1 | no | no | DB state comparison |

The pattern: the benchmarks with a cost axis (HAL, Aider, Multi-SWE) run once; the one that repeats (Terminal-Bench) requires five runs because a single run is noise. Nobody does both repeats and cost as a first-class comparison except the two rerun papers in section 3.

## 2. Statistics for evals

### Miller's recommendations (Anthropic, 2024)

[Adding Error Bars to Evals](https://arxiv.org/abs/2411.00640) and the [blog summary](https://www.anthropic.com/research/statistical-approach-to-model-evals) make five recommendations:

1. Report the standard error of the mean (SE = SD/√n) and a 95% CI of ±1.96 SE.
2. When questions come in related clusters, compute clustered SEs on the unit of randomization. On DROP the clustered SE was 3.05× the naive one; on MGSM 1.88×; on RACE-H 1.10×. Formula (eq. 4): SE²_clustered = SE²_naive + (1/n²) Σ_c Σ_i Σ_{j≠i} (s_ic − s̄)(s_jc − s̄).
3. Reduce variance by resampling answers (K draws per question cut the conditional-variance term by K) and, where available, by scoring next-token probabilities. Miller advises against lowering temperature to reduce variance.
4. When comparing two models on the same questions, analyze paired differences: SE_paired = √(SE_A² + SE_B² − 2 SE_A SE_B Corr(s_A, s_B)). Frontier models' per-question scores correlate 0.3 to 0.7, so pairing is "free" variance reduction.
5. Power analysis before building an eval. The worked example: detecting a 3-point difference at 80% power and α=0.05 with a paired variance parameter of 1/9 needs about 969 questions.

How much of this transfers to us. Miller's variance comes from sampling questions out of a question universe. Our design has 3 to 6 fixed scenarios and many runs each; the dominant variance is the run, not the scenario draw, and with so few scenarios between-scenario variance cannot be estimated meaningfully. The right reading: scenarios are fixed strata (we make claims about these scenarios), runs are the random unit, and recommendation 3 (resample) is the lever, not recommendation 5 (more questions). Recommendation 4 applies at the scenario level (block by scenario), not at the run level, because an A run and a B run share no seed and are not a pair. Recommendation 2 applies if we ever pool runs across scenarios with a naive SE: runs within a scenario are correlated through the scenario, so cluster by scenario or do not pool.

### Variance decomposition for agent runs

For a mean score over T tasks with R runs each, Var ≈ σ²_between/T + σ²_within/(T·R). More runs shrink only the second term. Two independent lines of work quantify the split:

- ICC (between-task variance / total): 0.30 to 0.77 on GAIA, 0.50 to 0.71 on FRAMES, converging by 8 to 16 trials on structured tasks and ≥32 on complex reasoning ([Mustahsan et al. 2025](https://arxiv.org/abs/2512.06710)). ICC 0.30 means 70% of the observed variance is run-to-run noise.
- A generalizability-theory decomposition of three agent-trace benchmarks found the agent main effect under 3% of variance and the agent-by-task interaction 7 to 23% ([Srinivasan 2026](https://arxiv.org/abs/2608.11323)). A reviewer flagged internal inconsistencies in that paper's tables ([pith.science](https://pith.science/paper/2608.11323)), so take the magnitudes as indicative, but the message that the condition effect is task-dependent is consistent with the harness studies in section 4. Consequence for us: report per-scenario deltas, and do not assume one pooled number describes every scenario.

### Pairing

- Run-level pairing needs a shared source of randomness. API models do not offer it: OpenAI's `seed` is documented as best effort, and inference is not batch-invariant (section 3). So A and B runs are independent samples within a scenario. Use unpaired two-sample tests within a scenario and block by scenario across scenarios.
- McNemar's exact test is the right test when each task has exactly one run per condition and outcomes are paired by task; Liu & Han use it with a Newcombe interval and a TOST equivalence test at δ=5 points ([What Does a Harness Buy?](https://arxiv.org/abs/2610.04433)). It does not apply to our many-runs-per-scenario design.
- Probe measurements (MEASUREMENTS.md §2: same session copied, then probed under no-fold / `/fold` / `/compact`) are a genuine paired design because the three arms share the prefix. Use paired tests there.

### Tests to use for our shape (two conditions, same model, same scenario, N runs each)

| Quantity | Per scenario | Pooled across scenarios |
|---|---|---|
| Pass (binary) | two proportions with Wilson CIs; difference with Newcombe interval; Fisher's exact for p | Cochran-Mantel-Haenszel stratified by scenario, or a logistic regression with scenario fixed effects; report the pooled risk difference with CI |
| Graded score (fraction of held-out checks passed) | Welch t-test or Mann-Whitney; mean difference with bootstrap CI | regression with scenario fixed effects |
| Tokens, cost, wall time (positive, skewed) | log-transform; Welch t on log values gives a ratio of geometric means with CI; Mann-Whitney as a check; also report the probability that a random B run beats a random A run (A12 / Cliff's δ) | log-ratio regression with scenario fixed effects (equivalent to an inverse-variance weighted mean of per-scenario log ratios); show the per-scenario ratios so heterogeneity is visible |
| Turns | same as tokens (near-Poisson, lower CV) | same |
| Variance ("more predictable") | ratio of CVs or of log-SDs with a bootstrap CI; Brown-Forsythe test on log tokens | per scenario only |
| Reliability | pass^k with k=3 and 5 (tau-bench estimator), flip rate 2c(n−c)/(n(n−1)) | mean over scenarios |

Bootstrap: percentile bootstrap over runs within a scenario (10,000 resamples) is adequate for every row above. A cluster bootstrap over scenarios (resample scenarios, then runs within them, as METR does) only makes sense with a dozen or more scenarios; with 3 to 6 it mostly reports that we have few scenarios. Treat scenarios as fixed and say so.

Bradley-Terry / Elo: appropriate when many systems are compared through pairwise preferences, which is the Chatbot Arena setting ([Chiang et al. 2024](https://arxiv.org/abs/2403.04132)). It adds nothing for two conditions with objective metrics, and if we later compare several prompt variants we still have direct metrics per run, so a stratified regression on those beats a judge-based BT model. Keep the LLM judge for trajectory labels, not for the ranking.

Multiple comparisons: pre-register one primary endpoint (section 7). Everything else is secondary; apply Holm's correction within the secondary family or present them as descriptive with CIs and no p-values.

### How many runs

Pass rate, two independent proportions, α=0.05 two-sided, 80% power, n per arm:

n = (1.96·√(2·p̄(1−p̄)) + 0.84·√(p_A(1−p_A) + p_B(1−p_B)))² / Δ²

| p_A → p_B | Δ | n per arm |
|---|---|---|
| 0.50 → 0.60 | 10 pts | ≈ 390 |
| 0.70 → 0.80 | 10 pts | ≈ 290 |
| 0.80 → 0.90 | 10 pts | ≈ 200 |
| 0.50 → 0.70 | 20 pts | ≈ 93 |
| 0.70 → 0.90 | 20 pts | ≈ 62 |
| 0.50 → 0.80 | 30 pts | ≈ 40 |

Turned around: with 50 runs per arm pooled over scenarios the minimum detectable pass-rate difference is about 25 points at mid pass rates; with 100 per arm about 18 to 20 points. A 10-point pass-rate claim is out of reach for a benchmark that runs hours-long sessions. This is why pass rate must be a gate, not the primary endpoint.

Tokens, on the log scale. Let CV be the within-scenario coefficient of variation of total tokens; σ_log = √ln(1+CV²). A B/A ratio ρ gives Δ = |ln ρ|. n per arm = 2·(1.96+0.84)²·σ²/Δ² ≈ 15.7·σ²/Δ².

| CV | σ_log | ρ = 0.8 (20% fewer tokens) | ρ = 0.7 (30% fewer) | ρ = 0.5 (half) |
|---|---|---|---|---|
| 0.25 | 0.25 | 19 | 8 | 2 |
| 0.40 | 0.39 | 47 | 18 | 5 |
| 0.60 | 0.55 | 95 | 37 | 10 |
| 1.00 | 0.83 | 218 | 86 | 23 |

n is per arm, pooled across scenarios (5 scenarios × 10 runs = 50). Published CVs for coding-agent tokens on a fixed task: 26% (cumulative input, astropy) and 142% (sympy) under greedy decoding across 50 runs ([AgentReplay, 2026](https://www.alphaxiv.org/abs/2609.32283)); within-query cost CV "routinely above 0.3" with a 9.7× spread between cheapest and dearest run on Terminal-Bench 2.0 tasks ([Price Reversal, 2026](https://arxiv.org/html/2603.23971v2)); Claude Code cost CV 7 to 10% and Codex 18 to 41% over four attempts on the same ticket ([dosu.dev](https://dosu.dev/blog/claude-code-vs-codex-token-costs)); wall-time SD about half the mean on SWE-bench-verified-mini (357 s ± 177 s) ([kvit.app](https://blog.kvit.app/posts/variance-claude-vibe/)). Long chained sessions will sit at the high end because early divergence compounds (section 3). Plan for CV 0.6 to 1.0 until the pilot says otherwise: a 30% token reduction then needs roughly 40 to 90 runs per arm in total; a 20% reduction, 100 to 220.

Turns have CVs of 9 to 29% in the AgentReplay data, so turn counts resolve smaller differences than tokens do.

Non-inferiority on correctness. With 50 runs per arm and p≈0.75, the 95% half-width on a difference of proportions is about 0.17; with a graded score (fraction of, say, 8 held-out checks) whose SD is roughly half that of a Bernoulli, about 0.09. So "B is not worse than A by more than 10 points" is demonstrable with the graded score at N=50 per arm if the observed difference is near zero, and not demonstrable with the binary pass at that N. Use both, lead with the graded score.

## 3. Variance of agent runs

### Published numbers

- 10 reruns of each of 12 (model, scaffold, temperature) cells on SWE-bench Verified: single-run pass@1 spreads of 2.2 to 6.0 points, run-to-run SD 0.7 to 1.8 points, and the SD did not fall at temperature 0 (Qwen3-32B on nano-agent: 0.7 at T=0.6, 1.2 at T=0). Trajectories diverge within the first 1% of tokens; T=0 moves the median first-divergence from token 5 to token 56 but does not remove it. pass@5 − pass^5 gaps up to 24.9 points. Power table: 9 runs per agent to detect a 2-point gain at the median SD of 1.5, 36 runs for 1 point. Compaction was excluded from the study and named as future work ([Bjarnason et al., ICLR 2026 workshop](https://arxiv.org/abs/2602.07150)).
- Three production harnesses, five models, SWE-bench Verified, with reruns: rerunning a cell flips 13% of task outcomes at the median, the same share as swapping the harness; the tasks a harness wins in one run are not the ones it wins in the next (5 splits repeat, 7 reverse). With 14% discordance, 45 tasks detect a 12.9-point gap half the time and nothing at 80% power; 447 tasks resolve 5.2 points ([Liu & Han 2026](https://arxiv.org/abs/2610.04433)).
- 45 SWE-bench-verified-mini cases × 10 runs × 2 assistants: 18 of 45 (Claude Code) and 19 of 45 (Vibe) cases flip between pass and fail across runs; pass-at-least-once 64%, mean 40%, pass-all-ten 24%; passing patches for one case range 716 to 5,703 bytes; median within-case CV of patch size 38 to 46% ([kvit.app](https://blog.kvit.app/posts/variance-claude-vibe/)).
- 584 runs of six agents on six open-weight endpoints on one ML task, 52 runs per pairing: identical runs of one pairing varied more than the pairings differed (pairing means spanned 0.0095 AUC; median within-pairing SD 0.0107); resolving the agent differences would take tens to over a hundred runs each; cost differed more than 20× between two agents on the same model, mostly through the prompt cache ([Ariño de la Rubia & Pafka 2026](https://www.scholarfeed.org/paper/2609.33812); sizing rule 16·sd²/gap² per arm summarized at [agentpatterns.ai](https://agentpatterns.ai/verification/size-agent-comparisons-by-run-variance/)).
- Infrastructure alone: Terminal-Bench 2.0 scores differ by 6 points (p<0.01) between strict per-task resource limits and uncapped; infra error rate 5.8% strict, 2.1% at 3× headroom, 0.5% uncapped; SWE-bench moved 1.54 points from 1× to 5× RAM over 227 problems × 10 samples; pass rates fluctuate with time of day via API latency ([Anthropic, Feb 2026](http://anthropic.com/engineering/infrastructure-noise)).
- Outcome consistency "remains low across all models" at K=5, T=0, and token usage across runs has high variance, especially on GAIA ([Science of AI Agent Reliability](https://arxiv.org/abs/2602.16666)).

### Best of N vs mean of N

Terminal-Bench, METR and the rerun papers report the mean over runs (pass@1 estimated from all runs). "AI Agents That Matter" argues accuracy "can be improved by scientifically meaningless methods such as retrying", which is what a best-of-N headline is ([Kapoor et al.](https://arxiv.org/abs/2407.01502)). SWE-bench requires best-of-k submissions to disclose all rollouts and the selector. Anthropic's Sonnet 4.5 post reports running multiple iterations per SWE-bench Verified case without publishing the spread ([noted by kvit.app](https://blog.kvit.app/posts/variance-claude-vibe/)). Practice to copy: mean over all runs as the estimate, pass@k and pass^k as the envelope, never a best-of-N as the headline.

### Temperature and seeds

- Temperature 0 does not give determinism for API models. The cause is lack of batch invariance: matmul, RMSNorm, and attention kernels reduce in a different order depending on batch size, and batch size depends on server load, so the same request gets different numerics on different calls. 1,000 greedy completions of one prompt on Qwen3-235B produced 80 distinct outputs, identical for the first 102 tokens; batch-invariant kernels made all 1,000 identical at a 62% throughput cost ([Thinking Machines, Sep 2025](https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/)). vLLM and SGLang have since added batch-invariant modes; a scheduling alternative (LLM-42) is proposed in [arXiv 2601.17768](https://arxiv.org/html/2601.17768v1). None of this is available on Anthropic or OpenAI endpoints.
- Reasoning models do not expose temperature at all; the reliability paper keeps provider defaults for them ([arXiv 2602.16666](https://arxiv.org/abs/2602.16666)). Aider turns temperature off for the GPT-5 family and Claude 4.x ([adv-model-settings](https://aider.chat/docs/config/adv-model-settings.html)).
- Miller advises against lowering temperature for variance reduction because it changes what is measured ([arXiv 2411.00640](https://arxiv.org/abs/2411.00640)). Bjarnason et al. found T=0 did not reduce run-to-run SD on SWE-bench Verified. For DeepSWE-preview T=1.0 scored 31.4% vs 20.4% at T=0, so forcing T=0 can also just make a model worse.
- Mini-SWE-agent 2.x and the three harnesses in Liu & Han send no sampling parameters; "decoding is whatever the provider does by default". pi does the same unless `samplingParams` is set in the model config, and those fields apply only to OpenAI-compatible APIs (`~/dev/pi/packages/coding-agent/docs/models.md`).

Recommendation: leave sampling at provider defaults, identical in A and B, record what was sent, and get precision from N, not from T.

## 4. Harness-level comparisons with the model fixed

### What exists

- Terminal-Bench 2.0, Table 2: the same model under different agents, at least five trials each. Claude Opus 4.5: Terminus 2 57.8% ± 2.5 with 3.9M input tokens; Claude Code 52.1% ± 2.5 with 256.9M; OpenHands 51.9% ± 2.9 with 151.4M. Gemini 2.5 Pro: +17% resolution under Terminus 2 vs OpenHands. The paper's reading: model choice matters more than scaffold for score, while token use differs by one to two orders of magnitude ([arXiv 2601.11868](https://arxiv.org/abs/2601.11868)).
- Liu & Han, SWE-bench Verified, Claude Code vs mini-SWE-agent vs OpenCode, five models: the heaviest and lightest harness are equivalent within 5 points on 447 tasks (TOST at δ=5); the only effects that clear the noise are losses (OpenCode trailing by 4.7 to 9.2 points, half of it from an output cap with no re-prompt). Cost per task differs up to 3× on the same model, set by the preamble each harness re-sends every step (16,581 tokens Claude Code, 7,025 OpenCode, 829 mini-SWE-agent) multiplied by step count; 96 to 99% of input tokens are cache hits; cache pricing scales the bill and does not reorder it. Controls: version pinned per arm, 300 steps for every trial, no network beyond the model endpoint (an audit found 71% of web-enabled runs fetched the upstream fix), reasoning effort pinned where the API allows, Harbor 0.22.0 with one container per trial, the same verifier. Metrics beyond pass rate: how each trial ended (own stop, output cap, context overflow, step/time cap, infra), steps, input tokens per step and its slope, compaction events, cost split into cache-hit, cache-miss and output ([arXiv 2610.04433](https://arxiv.org/abs/2610.04433)).
- The Scaffold Effect (Vats & Golev 2026): 3 harnesses × 2 models × 50 Terminal-Bench Pro tasks, one run per cell; 0 to 8 point pass-rate gaps with intervals covering zero, and 40× tokens per solved task (OpenCode 1.1M to 1.5M vs Goose 28k to 37k), driven by per-turn context volume and ten times as many no-action turns, not by turn count (22 to 27 vs 18 to 25). Failure types followed the harness: reasoning stops, verification failures, timeouts and idle loops ([summarized at weaveresearch.ai](https://www.weaveresearch.ai/blog/ai-model-vs-agent-harness); arXiv 2607.22585).
- HAL: double-digit cross-scaffold gaps on SWE-bench Verified Mini under SWE-Agent vs the HAL generalist (34 points for Claude Sonnet 4.5, nearly 48 for o4-mini); third-party monitoring reports 11 to 15 points of scaffold-only variation; adding one search subagent flipped a model ordering on SWE-bench Pro. The position paper "Stop Comparing LLM Agents Without Disclosing the Harness" argues the harness-by-model interaction is routinely larger than the model deltas papers report ([arXiv 2605.23950](https://arxiv.org/html/2605.23950v1)).
- Longitudinal: 35 consecutive releases of one harness on a fixed model brought no significant score gain while nearly doubling token use (Ben Sghaier et al. 2026, arXiv 2607.03691, cited in Liu & Han).

### What to take from them

- Hold everything fixed that these papers held fixed: harness version, step cap, wall-clock cap, network, reasoning effort, verifier, runner. Interleave A and B in time.
- Expect the pass-rate difference between A and B to sit inside rerun noise, and expect the token difference to be the measurable effect. That matches our goal and our power budget.
- Record how every trial ended. The harness effects that were real were all ways to lose (output cap without recovery, context overflow, offline tool). For us the analogue is a compaction that drops state, a fold that drops a caveat, or a trap left unreverted; each needs its own column.
- Report input tokens per request against request index (Liu & Han, Figure 4). For pi-episodes this is the direct picture of what folding does: the A line climbs and cliffs at compaction, the B line should drop at each fold. pi records `input + cacheRead` per assistant message, so this comes free from session files.

## 5. Known pitfalls and how benchmarks guard against them

### Contamination

- SWE-bench+: 32.67% of SWE-Agent+GPT-4's passing patches had the solution in the issue text or comments; 31.08% passed on weak tests; filtering both dropped the resolve rate from 12.47% to 3.97%; over 94% of issues predate the models' cutoffs ([Aleithan et al. 2024](https://arxiv.org/abs/2410.06992)).
- SWE-Bench Illusion: models name the buggy file from the issue text alone up to 76% of the time on Verified vs 53% on repos outside the benchmark; function reproduction is more verbatim on Verified ([Liang et al. 2025](https://arxiv.org/abs/2506.12286)). A replication with Claude models found 3× better localization on Verified than on BeetleBox or SWE-rebench ([Prathifkumar et al. 2025](https://arxiv.org/pdf/2512.10218)).
- Mitigations in use: copyleft and private repos (SWE-bench Pro), tasks created after cutoffs and refreshed continuously (SWE-bench-Live, 1,319 tasks from issues since 2024; SWE-rebench), held-out splits to detect overfitting (Pro's 858 private tasks; "AI Agents That Matter" argues every agent benchmark needs a holdout at the intended level of generality).
- For us: `vega/ts-json-schema-generator` is a public MIT repo and is in training data. Any goal that mirrors a real upstream PR risks recall. Invent the goals (a parser/formatter pair for a construct the repo does not support, with a spec written by us), check that nothing similar exists in upstream history, and keep one scenario unseen during prompt tuning.

### Test leakage and weak tests

- SWE-bench injects the test patch at grading time; Epoch strips git history after the issue and blocks network because the fix is in the subsequent history ([epoch.ai](https://epoch.ai/benchmarks/swe-bench-verified)); SWE-bench issue #465 documented git-history leakage of gold patches. SWE-bench Pro V2 sanitizes bundles, probes from inside the sandbox, locks the network, and regrades on a pristine image after restoring hidden-test paths and reverting agent edits to fixtures ([Scale Labs](https://labs.scale.com/blog/swe-bench-pro-v2)). HAL's log analysis found agents searching HuggingFace for the benchmark's gold answers ([arXiv 2510.11977](https://arxiv.org/abs/2510.11977)).
- Weak tests: 7.8% of "resolved" SWE-bench patches fail the developer-written suite and 29.6% behave differently from the gold patch, inflating resolve rates by 6.2 points ([Wang et al. 2025](https://arxiv.deeppaper.ai/papers/2503.15223v1/similar)). OpenAI's audit of 138 o3 failures on Verified attributed 59.4% to test flaws (cited in [arXiv 2603.21454](https://arxiv.org/pdf/2603.21454v1)). Test overfitting: code refined against generated tests passes them and fails the hidden ones ([Investigating Test Overfitting on SWE-bench](https://dl.acm.org/doi/pdf/10.1145/3803437.3805574)).
- Two-sided gate (SWE-bench Pro V2; also Anthropic's guide: investigate any task at 0% as a broken task or grader): the reference solution must pass and an empty diff must fail, checked before any scored run.

### Flaky tests, timeouts, environment drift

- Flaky verifiers: Multi-SWE-bench and SWE-bench Pro have humans check "relevance and flakiness"; SWE-rebench V2 prefers structured JUnit XML over stdout parsing because test ordering varies across runs in some languages ([arXiv 2602.23866](https://ar5iv.labs.arxiv.org/html/2602.23866)). Practical rule: run the hidden checks several times on the oracle solution and on the empty diff before trusting them.
- Timeouts: Terminal-Bench, Liu & Han, and Epoch all score a trial that hits a step, time, context, or output cap as a failure and record which cap ended it; infrastructure errors are a separate category, not scored, with a pre-registered rerun rule. The swebench-pro reproduction doc formalizes WIN / LOSS / INCOMPLETE where INCOMPLETE must carry corroborating fault evidence or is reclassified LOSS, "committed in advance so it can't be selectively invoked" ([kimjune01/swebench-pro METHODOLOGY](https://github.com/kimjune01/swebench-pro/blob/main/docs/METHODOLOGY.md)).
- Resource limits change what is measured (section 3). Anthropic's recommendation: specify a guaranteed allocation and a separate kill threshold, calibrate the band so floor and ceiling scores are within noise (3× worked for TB 2.0), document the enforcement method, and run on multiple days to average time-of-day effects ([anthropic.com/engineering/infrastructure-noise](http://anthropic.com/engineering/infrastructure-noise)).
- Provider drift: weights swapped behind stable endpoints, FP4/FP8 routing, silent rate-limit failures ([HAL](https://arxiv.org/abs/2510.11977)). Pin dated model snapshot IDs, record the provider and the `system_fingerprint` or equivalent per request if the API returns one, and rerun the baseline in the same batch as the candidate rather than comparing against last month's numbers.

## 6. Recommendations for pi-episodes

### Units and scoring

- Scenario: a fixed base commit of a clone of `ts-json-schema-generator` plus a scripted sequence of user turns (goal 1, goal 2, interruption, probes, "back to it", final). Scenarios are fixed strata; we claim results about these scenarios.
- Trial: one pi session for one scenario under one condition, in its own git worktree, from the same base commit, same model snapshot, same settings. Cell = (model, condition, scenario).
- Grade: run after the session ends, outside the worktree the agent saw, on a fresh checkout with the agent's diff applied (SWE-bench Pro V2 style). Agent edits to test files are reverted first. Three groups of held-out checks, each written before any scored run and gated two-sided (oracle passes, empty diff fails, three oracle runs agree):
  - new tests that must pass (FAIL_TO_PASS analogue, one set per goal),
  - the existing suite, or the subset we pin (PASS_TO_PASS analogue; the full suite is ~10 minutes, acceptable),
  - probes and traps as explicit checks (the temporary change is reverted; the probe answer is correct), one row each.
- Per-trial outputs: `pass` (all checks green), `score` (fraction of checks green, weighted equally), end-of-trial category (completed, step cap, wall-clock cap, context overflow, provider error, infra), turns, requests, input/cacheRead/cacheWrite/output tokens, cost, wall time, counts and positions of fold/recall/ask/fork, compaction events, and the per-request `input + cacheRead` series.

### Primary and secondary endpoints (fix before the pilot)

- Primary: total input tokens attended (sum over requests of `input + cacheRead`), B vs A, as a ratio of geometric means with a 95% CI, pooled across scenarios with scenario fixed effects. This is the number the extension exists to move and the one with the most statistical power.
- Correctness gate: B's `score` must not be lower than A's by more than δ = 0.10 (one-sided 95% bound on the difference, pooled with scenario fixed effects). Report binary `pass` with Newcombe intervals alongside, knowing it will be wide.
- Secondary, with Holm correction across the family: cost, output tokens, turns, wall time, cache writes, pass^3, flip rate, token CV ratio (predictability), compaction count, re-derivation count (MEASUREMENTS §7).
- Decision rule, stated in advance: B "wins" on a model if the primary ratio's CI lies below 1 and the correctness gate holds; "ties" if the CI covers 1 and the gate holds; "loses" otherwise. Report the count of models in each state; do not pool across models.

### Runs per cell

- Pilot: one model, one scenario, 5 runs per condition (10 sessions). Purpose: measure within-cell SD of log tokens and the pass rate, find infra failure modes, check the checks. Do not read B vs A from it.
- Then compute N from the pilot CV with the table in section 2. Expected answer: 10 to 20 runs per cell. Minimum 10 per cell regardless (Bjarnason et al. needed 9 runs to see a 2-point pass-rate change at SD 1.5; our token effect is larger but our CV is too).
- Budget check: 3 models × 2 conditions × 3 scenarios × 10 runs = 180 sessions. At one to three hours each with 4 to 8 in parallel this is days, not weeks. Add scenarios before adding runs beyond 20 per cell; the harness literature says effects are scenario-dependent, and a fourth scenario tells us more than a thirtieth run.
- Interleave A and B (alternate, or randomize order within blocks of 2) and spread each cell over at least two days.

### What to report, per model

Table, one row per scenario plus a pooled row:

| scenario | n_A / n_B | score A / B (mean ± CI) | pass A / B (Wilson) | Δpass (Newcombe) | tokens attended ratio B/A (CI) | P(B < A) | turns ratio (CI) | wall ratio (CI) | cost ratio (CI) | pass^3 A / B | flip A / B | folds / recalls / asks / forks per B run | compactions A / B | end-of-trial categories |

Plus two plots per model: input tokens per request vs request index (one faint line per trial, bold median per condition), and score vs tokens per trial (both conditions, the HAL-style cost-accuracy view).

Plus a variance note: run-to-run SD of log tokens per cell, so the next person can size their N.

### Controls

- Identical across A and B: model snapshot ID, provider, thinking level, pi version 1.1.0, system prompt apart from the extension's additions, tools, skills, settings, sampling (provider defaults, nothing sent), step cap, wall-clock cap, node and pnpm versions, lockfile, base commit, scripted user turns.
- Network: the agent may need the registry for installs; pin the lockfile and prefer an offline cache. Block everything else, in particular GitHub, so the agent cannot fetch upstream history.
- Git: shallow clone or history truncated at the base commit, no upstream remote, so `git log` cannot reveal a later implementation.
- Hidden checks live outside the worktree; the agent's prompt says tests will be run but not which.
- Caps: generous wall clock (Terminal-Bench 4.0 uses 8 hours so frontier models rarely hit it) and a step cap high enough that A's compaction and B's folds both happen; a capped trial scores 0 and is labeled with its cap.
- Infra failures (provider 5xx storms, Docker, disk) are INCOMPLETE and rerun byte-identically; the rule and the evidence needed are written down before the first scored run, as in the swebench-pro doc.
- Resource limits: if trials run in containers, set a floor and a kill ceiling with headroom (Anthropic's 3× calibration), and keep them equal across A and B.
- Record per request: model id returned by the API, usage fields, timestamps. pi already writes `usage` on every assistant message and `context_edit` entries for folds (`docs/session-format.md`).

### LLM judge

Use it for trajectory labels only (did the agent re-derive archived work, did it act on a stale conclusion, was the fold note sufficient), with a rubric, on all trials, and calibrate on a human-labeled sample of 20 to 40 trials reporting agreement, as Terminal-Bench did with Docent (93% κ on calibration, 90% agreement vs 120 human-labeled traces) and HAL does. Never use it for pass/fail. The post-run self-explanation probe is a diagnostic, not evidence, as PLAN.md already says.

### Prompt-variant comparisons

Same machinery, same primary endpoint. Tune the prompt on scenarios 1 and 2, confirm on scenario 3 which nobody looked at while tuning (the holdout rule from "AI Agents That Matter"). A variant that only wins on the tuning scenarios is overfit.

### Reuse

- Harbor as the runner, via the existing `pi-terminal-bench` adapter, if we want container isolation, `--n-attempts`, per-trial `trial_result.json` with tokens and cost, and later Terminal-Bench as a sanity check for pi itself. Watch the `upload_dir` bug noted in that repo. If worktrees on the host are enough for phase 3, Harbor can wait; the SDK (`createAgentSession`) plus a worktree per trial is simpler.
- SWE-bench's grading convention (FAIL_TO_PASS + PASS_TO_PASS, patch applied to a clean tree) and SWE-bench Pro V2's anti-leak list.
- Terminal-Bench's five-runs minimum and its ± convention, Liu & Han's end-of-trial categories and per-request token plot, HAL's cost-accuracy plot.
- tau-bench's pass^k estimator; rerun-bench's flip-rate and cost-CV summaries ([pypi rerun-bench](https://pypi.org/project/rerun-bench/)) as a reference implementation of the reliability columns.
- Miller's paired and clustered formulas for the probe experiments (MEASUREMENTS §2), which are paired.

### Do not reuse

- Single-run pass@1 as a headline, and best-of-N anywhere.
- Temperature 0 as a determinism or variance-reduction device.
- Naive binomial SE over pooled runs across scenarios: runs cluster by scenario, so either stratify or cluster.
- McNemar at the run level: there are no pairs.
- Bradley-Terry / Elo over judge preferences for two conditions.
- Aider's retry-with-test-feedback protocol: our checks must stay hidden.
- Existing SWE-bench tasks on this repo, or goals copied from upstream PRs: recall risk.
- A cluster bootstrap over 3 to 5 scenarios as if they were a sample of tasks; say the scenarios are fixed instead.

### Minimum detectable effects to put in DESIGN.md

With 3 scenarios × 10 runs per cell (30 per arm per model) and a pilot CV of 0.6 on tokens: detectable token ratio about 0.67 (a third fewer tokens) at 80% power; turns, with CV 0.25, about 0.84; graded-score non-inferiority margin about 0.10 (one-sided 95%, score SD ≈ 0.22); binary pass-rate difference about 30 points (not useful). With 20 runs per cell (60 per arm): token ratio about 0.75, turns about 0.88, score margin about 0.07, pass difference about 22 points. Anything smaller than these is a tie by construction, and the design doc should say so before the first run.

Worked inputs for the numbers above: Δ_tokens = √(15.7·0.55²/n) = 0.40 (n=30) or 0.28 (n=60); Δ_turns = √(15.7·0.246²/n) = 0.18 or 0.13; score margin = 1.645·0.22·√(2/n); pass difference = √(2.93/n) at p̄ ≈ 0.75.
