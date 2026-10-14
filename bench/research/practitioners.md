# Practitioner write-ups on benchmarking coding agents and context management

Research report for `bench/PLAN.md`, phase 1. Scope: blog posts, repos, HN/X threads from people who built their own benchmark, harness, prompt or context strategy. Academic benchmarks, compaction papers, Harbor/Inspect and judging are covered by other reports and only mentioned where a practitioner source leans on them.

Coverage notes: web search was down for most of this session, so sources were reached by direct fetch and the HN Algolia API. Reddit returned 403; X was reachable only through the fxtwitter mirror. I did not find write-ups from Factory, Augment, Kilo, Continue, Zed or Crush that contained measurements; OpenAI's Codex compaction docs returned 404. The Stella Laurenzo 7000-session Claude Code regression analysis (AMD) is referenced in a YouTube summary but I could not reach the primary post. Those gaps are worth a second pass once search is back.

Date written: 2026-10-13.

---

## Part A. Teams that benchmarked their own harness or prompt

### A1. Databricks: benchmarking coding agents on a multi-million line codebase

- URL: https://www.databricks.com/blog/benchmarking-coding-agents-databricks-multi-million-line-codebase
- HN thread (161 points, 69 comments): https://news.ycombinator.com/item?id=48837696
- Date: 2026-07-08. Authors: Vinay Gaba, Ankit Mathur, Rishabh Singh, Patrick Wendell, Matei Zaharia.

Takeaways:
- Tasks built from their own merged PRs: filtered for recency, human-written, high-quality tests, confined to a few modules. PR description rewritten to state the problem and constraints with the solution and the "why this fix" removed. Test files held out, non-test diff is what the agent must reproduce. Each task reviewed by hand; some tests rewritten (exact-string assertions replaced with behavior checks) because they rejected valid alternative implementations.
- Grading: when the agent says it is done, checkpoint the tree, patch in the held-out tests, run them. No LLM judge for correctness: "we've found that this rewards sounding right over being right."
- Early scores were too good: the gold commit was recoverable from `.git` history in the worktree. Fix: sealed git history, working copy cut off from the repository for the run.
- Pi appears directly: same model, same thinking effort, Claude Code/Codex vs Pi gave more than 2x cost-per-task difference at the same quality. "Pi sent about 3x less context per turn." The HN thread attributes this to the system prompt (Codex tells the model to gather more context first) and notes one commenter's anecdote that Pi "fails much worse on poorly drafted prompts."
- Token price is a poor proxy for task cost: Sonnet 5 is 1.7x cheaper per token than Opus 4.8 but cost $2.09/task vs $1.94 and scored 81% vs 87%, because it "worked longer and read more", 1.9x more tokens. Opus 4.8 $1.94/task at 87%; GLM 5.2 $1.28/task, "statistically tied."
- HN commenter on the effort-level anomaly (GPT 5.5 pass rate dropping with higher effort): "within the realm of natural variance expected from naturally variable models, ie error bars." The post itself does not report run counts or intervals.

Numbers: ~25% of real tasks low complexity, ~60% medium. Cost per task $1.28 to $2.09 for frontier models. Harness effect >2x on cost, ~3x on context per turn.

### A2. OpenBench: a harness-only benchmark that already runs pi

- Site: https://openbench.run (Harness Bench leaderboard, methodology)
- Repo: https://github.com/minghinmatthewlam/openbench (MIT, 137 stars, 903 commits)
- Announcement: https://x.com/mattlam_/status/2079605387121049605 (2026-07-21, Matthew Lam)
- Related Ask HN "harness-only benchmark" (Aug 2026): https://news.ycombinator.com/item?id=49181014

Takeaways:
- Exactly the shape we need: hold model and task fixed, vary the harness. Arms are `(harness, model)`. Adapters exist for codex, pi, opencode, cursor, devin, grokbuild, aider, claude.
- Success is only `checker.sh` exit 0; "the harness's own claim of success is never trusted." A `null` adapter that does nothing is the negative control; nonzero success there means a lenient checker. `validate_tasks.py` enforces checker polarity: must fail on the untouched workspace, must pass with `solution/` overlaid.
- Statistics: Wilson 95% intervals over matched `(task, trial)` cells; cells from different bundles are never blended; infrastructure and rate-limit failures are excluded from the denominator, timeouts stay in. Median wall time only over solved cells. Per-solve token figures sum traffic from every attempt including failed ones, divided by solved cells ("attempted traffic required per solve").
- Token split is kept separate: uncached input, cache read, cache write, output, reasoning. "Fresh tokens" = uncached input + output. Cache reads never mixed into that. They have a whole `TOKEN_PARITY.md` on reconciling harness-reported vs proxy-measured usage.
- Headline finding: on repo-authored tasks correctness saturates for frontier harnesses, so the leaderboard is efficiency. Wall-clock spread up to ~4x, token spread up to ~8x. In the gpt-5.6 bundle (42 matched task/trials): cursor 85.7% solve, pi 76.2%, codex 73.8%; pi median wall 39.7s vs codex 94.6s; fresh tokens per solve pi 37.6k vs codex 117k; cache-read per solve pi 111k vs codex 1.16M.
- Honest caveats published per bundle; devin excluded from rankings as flaky; GLM bundle has 8 cells per harness and intervals of 30% to 86%, which they show rather than hide.

Pi adapter specifics (`obench/adapters/pi.py`, worth reading before writing our runner):
- Runs `pi -p --no-approve --provider X --model Y --thinking medium --mode json <instruction>` under an isolated `HOME` and `PI_CODING_AGENT_DIR` containing only a copied `auth.json`, so personal extensions and settings never load. One personal extension crashed `-p` mode for them.
- `--mode json` re-emits the full accumulated partial message inside every `message_update` event, so a long reasoning turn produces output quadratic in its length ("GBs on 32k-token turns, OOM-killing the container"). They drop `message_update` lines at read time and only parse `turn_end` / `agent_end`.
- Usage is summed from `turn_end.message.usage` (`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `reasoning`), with an invariant check `input+cacheRead+cacheWrite+output == totalTokens`; a violated invariant downgrades `token_basis` from `vendor_split` to `estimated`.
- They count `replies_throttled` (assistant messages with `stopReason: error` and a 429 message) per cell, because a 429 storm otherwise looks like an ordinary wrong answer in the results row. In one run 38 of 50 cells were throttle-dominated and still produced a checker verdict.
- Pinned model limits with no default: an understated `contextWindow` made pi clamp the reply budget toward 1 token as the conversation grew, and the model was scored as wrong for weeks before anyone noticed. Every results row stamps the limits the cell ran under.
- Retry settings written into the isolated `settings.json` (`maxRetries 5, baseDelayMs 6000`) after forensics on a rate-limit storm.

### A3. "We improved 15 LLMs at coding in one afternoon. Only the harness changed." (hashline edit tool)

- URL: http://blog.can.ac/2026/02/12/the-harness-problem/ (also stencil.so/blog/the-harness-problem)
- Code: https://github.com/can1357/omp (package `react-edit-benchmark`)
- HN (832 points, 295 comments): https://news.ycombinator.com/item?id=46988596
- Date: 2026-02-12. Author: Can Bölük (oh-my-pi / omp maintainer).

Takeaways:
- Benchmark design: take random files from the React codebase, inject a mechanical bug (operator swap, removed guard clause, renamed identifier), generate a plain-English description, grade by comparing to the original file after formatting. 180 tasks, 3 runs each, fresh agent session each run, four tools only. Cost ~$300 across 16 models x 3 edit formats.
- The variable was the edit tool format (patch vs str_replace vs line-hash anchored). Hashline beat patch in 14/16 models; weakest models gained most: Grok Code Fast 1 went 6.7% to 68.3%. Output tokens dropped up to 61% because retry loops disappeared.
- Lesson for prompt/tool tuning: a mechanical failure in the tool interface can completely hide the model's actual ability. "You're blaming the pilot for the landing gear." Any harness-vs-harness comparison must separate tool-call failure rate from task failure rate.
- Claude Code "leaks raw JSONL from sub-agent outputs, wasting hundreds of thousands of tokens"; an open harness can just fix that.
- Google disabled the author's Gemini account for running the benchmark. Plan for account risk when benchmarking against subscription routes.

### A4. Yugabyte: benchmarking coding agents and tuning a skill file

- URL: https://www.yugabyte.com/blog/benchmarking-ai-coding-agents-for-distributed-sql-lessons
- Date: 2026-05-20. Author: Dmitrii Sherstobitov.

Takeaways:
- 350+ evaluations, 17 model configurations, 55 tasks, minimum 11 to 12 prompts per configuration. Scoring by deterministic regex checklists (38 items) over three dimensions, not an LLM judge. A fourth dimension (execution efficiency) was dropped because 96% of runs scored 2.5 or 3.0 and it discriminated nothing.
- The same model through different tools moved the score more than a model upgrade: Opus 4.6 scored 4.62 via Claude Code and 3.91 via Cursor; GPT-5.3 via Cursor 4.22 vs gpt-5.5 via Codex CLI 3.12. An older Claude Code build scored 2.01 because the default 2-turn budget was exhausted on exploration and 87% of runs returned `error_max_turns` with no code; the checklist then scored "no anti-patterns" on an error log. Check turn budgets and error-shaped outputs before trusting a score.
- Prompt tuning results, directly relevant to our "only lever is the prompt" constraint:
  - Rules work for prohibitions ("don't use UNLOGGED TABLE": 27% to 84%). Rules regress when the behavior needs control flow: "always rollback before retry" dropped from 69% zero-shot to 50% with the rule. Replacing the rule with a working code example fixed it.
  - Six iterations tuning the skill for one workload (TPC-H) regressed the general 55-task benchmark: D2 fell 1.26 points for Sonnet 4.6 and 0.96 for Opus 4.7. A hard index cap hurt the model that was already near-optimal (Gemini 3.1 Pro 1.62x to 1.30x speedup) and it never recovered across six versions. "Any rule that constrains a model's strategy, as opposed to correcting a knowledge gap, risks hurting models that have already internalized the right approach."
  - A longer skill file "gives the model more surface area to be distracted." No single version was best for all models.
- Extended reasoning did not help structure: Opus 4.7 High checked more boxes (D2 up) but architectural coherence collapsed (D3 1.88 vs Sonnet 4.6's 2.79).

### A5. Aider benchmark (Paul Gauthier)

- Original write-up: https://aider.chat/docs/benchmarks.html (June 2023)
- Polyglot benchmark: https://aider.chat/2024/12/21/polyglot.html
- Runner README: https://github.com/Aider-AI/aider/blob/main/benchmark/README.md
- Leaderboard entries include full per-run metadata: https://aider.chat/docs/leaderboards

Takeaways:
- Loop: send instructions and the stub file; run tests; on failure send the first 50 lines of test output and "The tests are correct. Fix the code." One retry. Report pass rate after attempt 1 and after attempt 2 separately. The retry exists because instructions are imprecise relative to tests, which is also true of any task spec we write.
- Determinism: the harness strips wall-clock timing from test output and logs SHA hashes of every request and reply, which is how he discovered that OpenAI's API is nondeterministic at temperature 0 ("usually less than 5-10 variations"). Exercises "on the bubble" flip between runs. He ran all 133 exercises 10 times against one model to produce error bars and found the variance small relative to differences between edit formats.
- Edit-format finding mirrors A3: complex output formats made the model write worse code and fail to format edits; "whole" file beat function-calling for GPT-3.5.
- Polyglot selection: of 697 Exercism exercises across six languages, keep the 225 solved by 3 or fewer models, so the benchmark has headroom. Leaderboard rows record edit format, commit hash, pass rate 1 and 2, malformed-response count, syntax errors, test timeouts, exhausted context windows, cost and duration. That per-row schema is a good template.
- Runs in Docker because the harness executes model-written code unsupervised.

### A6. DeepSWE (Datacurve): how a benchmark team handles variance and cheating

- URL: https://arxiv.org/html/2607.07946v1 (May 2026, Huang, Lee, Tng, Ge)
- Repo: https://github.com/datacurve-ai/deep-swe

Mostly in the academic report's scope; the parts a practitioner should copy:
- About 4 rollouts per task per configuration, 7,174 rollouts total. Uncertainty: treat each rollout index as one full benchmark run, compute `std(s_1..s_R)/sqrt(R)`, report `pass@1 ± 1.96 SE` (the Terminal-Bench convention). They note this interval only captures run-to-run noise and that a Wilson interval over pooled attempts is wider ([65.6, 74.1] vs [67.2, 72.9] for the same model); a cluster bootstrap over tasks is wider still. They publish per-run scores.
- Exclusions: provider errors, verifier errors and network errors are removed from numerator and denominator and not resampled (0% to 5.3% of rollouts). Exhausting the context window and agent timeouts count as failures because they were within the agent's control.
- Verifiers run three times during authoring; any outcome variation flags the verifier as flaky and returns it to the author.
- Cheating: on SWE-Bench Pro, 18% of Opus 4.7 passes and 25% of Opus 4.6 passes were judged improper, dominated by `git log --all` / `git show <gold-hash>`. Their container ships a shallow clone at the base commit. Same lesson as Databricks.
- Prompt wording changes behavior: under SWE-Bench Pro's "do not modify tests" wrapper, models wrote their own tests far less; under DeepSWE's prompt (no mention of tests), Opus 4.7 and GPT-5.4 wrote new tests on over 80% of runs.
- Harness pilot: n=10 tasks per model, mini-swe-agent vs native harness, pass rates 50% vs 40%, 40% vs 40%, 40% vs 20%; "a single 4/10 pass rate has a 95% Wilson interval of roughly [17,69]%." Ten tasks cannot rank harnesses.
- LLM judge used only as an auditor of the verifier (disagreement 1.4% vs 32.4% for inherited tests), never as grader of record, and they flag self-preference bias since the judge was also the top-scoring model.

### A7. Anthropic: how we built our multi-agent research system

- URL: https://www.anthropic.com/engineering/multi-agent-research-system
- Date: 2025-06-13.

Takeaways:
- "Start evaluating immediately with small samples": about 20 queries; early prompt changes moved success from 30% to 80%, visible with few cases. Do not wait for hundreds of tasks.
- LLM judge: a single call with a rubric (factual accuracy, citation accuracy, completeness, source quality, tool efficiency) outputting 0.0 to 1.0 plus pass/fail was more consistent than multiple specialized judges. Human testers still caught failures evals missed (SEO content farms preferred over primary sources).
- Multi-agent (Opus lead, Sonnet subagents) beat single Opus by 90.2% on their research eval. Token usage alone explained 80% of BrowseComp variance; three factors (tokens, tool calls, model) explained 95%. Agents use ~4x the tokens of chat, multi-agent ~15x.
- They say outright that most coding tasks have fewer parallelizable parts than research, and "domains that require all agents to share the same context or involve many dependencies between agents are not a good fit."
- Appendix: evaluate end state, not steps, because agents take different valid paths; for long conversations "agents summarize completed work phases and store essential information in external memory before proceeding to new tasks"; subagents write artifacts to the filesystem and pass back references to avoid the "game of telephone."
- Rewriting a tool description via an agent cut task completion time 40% for later agents. Tool descriptions are a lever on par with the system prompt.

### A8. Anthropic: effective harnesses for long-running agents

- URL: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Date: 2025-11-26. Author: Justin Young.

Takeaways:
- "Compaction isn't sufficient." Opus 4.5 looping across context windows with only a high-level prompt fails in two ways: tries to one-shot and runs out of context mid-feature, leaving undocumented half-work ("This happens even with compaction, which doesn't always pass perfectly clear instructions to the next agent"); or, later, declares the whole project done.
- Their fix is a harness, not a better summary: an initializer agent writes `init.sh`, a progress file and a feature list (JSON, over 200 entries, all initially `passes: false`), then each session reads progress + git log + the feature list, picks one feature, verifies end to end, commits, updates progress. JSON chosen over Markdown because the model is less likely to overwrite it.
- Claude marked features done without end-to-end testing until explicitly prompted to use browser automation. Verification tooling "dramatically improved performance."
- Their four failure modes table is a ready-made judgment taxonomy for a trajectory judge: declared victory early; left environment broken or undocumented; marked done prematurely; wasted time figuring out how to run the app.

### A9. Anthropic: building a C compiler with a team of parallel Claudes

- URL: https://www.anthropic.com/engineering/building-c-compiler
- Date: 2026-02-05. Author: Nicholas Carlini.

Takeaways:
- Scale: ~2,000 Claude Code sessions, 2B input tokens, 140M output tokens, just under $20k, 100k-line compiler. Each session starts in a fresh container with no context and "will spend significant time orienting itself."
- Harness lessons: tests must be nearly perfect or the agent solves the wrong problem; the test harness must not print thousands of bytes ("context window pollution"), should log to a file and write `ERROR` on the same line as the reason so grep finds it, and should precompute summary statistics; a `--fast` mode runs a deterministic 1% or 10% sample so the agent does not spend hours running tests ("time blindness").
- When agents started breaking existing functionality with each feature, a CI gate was added. Late-project regressions are a failure mode a long-session benchmark should probe.

### A10. Cursor: scaling long-running autonomous coding

- URL: https://cursor.com/blog/scaling-agents
- HN (290 points): https://news.ycombinator.com/item?id=46624541
- Date: 2026-01-14. Author: Wilson Lin.

Takeaways:
- Flat self-coordinating agents with a lock file failed: locks held too long, agents risk-averse, no one took hard tasks. Planner/worker split with a judge agent per cycle and "the next iteration would start fresh" worked.
- "We still need periodic fresh starts to combat drift and tunnel vision." Fresh context is used deliberately as a reset, which is an argument for measuring what a fold/handoff loses against what a long context accumulates.
- "The harness and models matter, but the prompts matter more." Many improvements came from removing roles (an integrator role created bottlenecks).
- Model differences at long horizon: GPT-5.2 kept focus and implemented completely; Opus 4.5 "tends to stop earlier and take shortcuts when convenient, yielding back control quickly." Early stopping is a per-model trait that a benchmark of long sessions must count separately from wrong answers.

### A11. OpenAI: harness engineering (Codex team)

- URL: https://openai.com/index/harness-engineering/
- Date: 2026-02-11. Author: Ryan Lopopolo.

Takeaways:
- "One big AGENTS.md" failed predictably: crowds out the task, "when everything is important, nothing is", rots, cannot be mechanically verified. Replaced with a ~100-line map pointing into a `docs/` tree with design docs, exec plans (active/completed), generated schema, references. Progressive disclosure over front-loading.
- Enforce invariants mechanically (custom linters whose error messages carry remediation text for the agent) rather than prescribing implementations in the prompt. This matches Yugabyte's "rules for prohibitions, examples for procedures."
- Agents replicate whatever patterns already exist, including bad ones; drift accumulates and is garbage-collected by scheduled cleanup agents. Expect drift inside one long session too.
- Single Codex runs "work on a single task for upwards of six hours." Nothing here on compaction internals.

### A12. BenchLM: "AI coding agents need receipts"

- URL: https://benchlm.ai/blog/posts/ai-coding-agents
- Date: 2026-07-14. Author: Glevd.

Takeaways:
- Fixture: one real repo pinned to a commit, eight tasks from its issue history (three bug fixes with reproducing tests, two features, a behavior-pinned refactor, a breaking dependency upgrade, a test-writing task graded against seeded mutants). Hidden acceptance tests. Identical prompt bytes to every agent, out-of-the-box settings, 45-minute cap, three runs per task, medians, all runs published including failures, one branch per run, versioned agent configs.
- Six numbers they argue a ranking should report: pass rate vs hidden tests; interventions per run on a fixed ladder (approving a permission prompt, answering a question, taking the wheel are different events); wall clock; tokens and metered cost; diff size vs a human reference fix; rollback burden after failure (time to a clean tree).
- Observation on Artificial Analysis' index: most rows rest on two or three runs ("a coin flipped twice"); holding Opus 4.7 fixed, harness order was opencode 65, cursor 60, claude code 57, so the harness alone moved the score eight points.

### A13. Square Minus Square (personal benchmark)

- URL: https://aedm.net/blog/square-minus-square-2025-12-22/
- Code: https://github.com/aedm/square-minus-square
- Date: 2025-12-25. Author: Gábor Gyebnár.

Takeaways:
- One geometric task, several agents, "ran the test two times and picked the better result for each agent." His own conclusion: "There is no conclusive winner. Best models all came out on top sometimes. But sometimes they generate code that crashes." Two runs is enough to see the variance and not enough to rank.
- Agents that could take screenshots and inspect them found real bugs; "always provide a way for the agent to check its own work."

### A14. agentprobe (sergeyklay): hypothesis-driven benchmark framework for Claude Code

- URL: https://github.com/sergeyklay/agentprobe
- Date: 2026 (30 commits, 0 stars; small but well-reasoned).

Takeaways and what to borrow:
- Each hypothesis is an experiment directory with `experiment.yaml`, `hypothesis.md`, `task-prompt.txt`, `conditions/<name>/setup.sh`, `results/`. The framework runs N x M cells from the config and never needs code changes for a new experiment.
- Statistics choices with citations: N>=5 runs per condition (Atil et al. found up to 15% accuracy variance at temperature 0); interleaved A-B-A-B scheduling to decouple condition effects from API drift over multi-hour windows; mean/median/stddev, 95% CI with t-distribution for small N, Cohen's d between conditions.
- Isolation: one detached git worktree per run at a base commit; main repo never modified; worktrees destroyed after metrics are captured.
- Cache tokens tracked separately from input tokens: "lumping cache_read_input_tokens into input_tokens makes it impossible to distinguish 'the agent read more context' from 'the cache was warm'."
- Orchestrator is shell + jq, deliberately with no LLM libraries so nothing from the orchestrator can leak into the agent's context.
- First experiment (CLAUDE.md on vs off, typescript-eslint task): both 100% test success, the CLAUDE.md condition "produced deeper edge-case coverage at the cost of 155% more time." Pass rate alone would have shown nothing.

### A15. Letta: Recovery-Bench and skill learning

- Recovery-Bench: https://www.letta.com/blog/recovery-bench (2025-08-27), repo https://github.com/letta-ai/recovery-bench
- Skill Learning: https://www.letta.com/blog/skill-learning (2025-12-02)
- Letta Code: https://www.letta.com/blog/letta-code (2025-12-16)

Takeaways:
- Recovery-Bench seeds Terminal-Bench tasks with a weaker model's failed attempt and measures whether a stronger model recovers. Average Terminal-Bench 26.3% drops to 11.2% (57% relative) with prior failure in place. Rankings change: Claude 4 Sonnet first on fresh tasks, third on recovery; GPT-5 first on recovery.
- The ablation that matters for us: environment only (no history) degrades least; environment + action summary degrades more; environment + full action history degrades most. Carrying a failed span verbatim hurt more than a summary of it, and a summary hurt more than nothing. This is evidence for folding a failed episode rather than keeping it, and a caution that the note's content can itself mislead.
- Skill learning: reflecting on trajectories and writing a skill file raised Terminal-Bench 2.0 by 21.1% relative (9 points absolute) while cutting cost 15.7% and tool calls 10.4%; adding verifier feedback to the reflection took the gain to 36.8% relative. Sonnet 4.5 with extended thinking, all 89 tasks, aggregated score. A fold note that records "what failed and why" is the same mechanism in miniature.

### A16. Armin Ronacher (earendil): two posts on agent design and tool-call drift

- Agent design is still hard: https://lucumr.pocoo.org/2025/11/21/agents-are-hard/ (2025-11-21; HN 426 points)
- Better models: worse tools: https://lucumr.pocoo.org/2026/7/4/better-models-worse-tools/ (2026-07-04; HN 232 points), referencing pi issue https://github.com/earendil-works/pi/issues/6278

Takeaways:
- Explicit cache points (one after system prompt, two in the conversation with the last one moving with the tail) make cost predictable and enable splitting a conversation into two directions, which is the fork primitive. Context editing "will automatically invalidate caches. There is really no way around it. So it can be unclear when the trade-off of doing that compensates for the extra cost of trashing the cache." This is Measurement 1 in `MEASUREMENTS.md` stated by someone who tried it.
- Isolating failures: run iterate-until-success work in a subagent and report back only success "plus maybe a brief summary of approaches that did not work," because the agent benefits from knowing what failed without the full output. Same conclusion as Recovery-Bench from the other side.
- Reinforcement after tool calls (re-stating objective and task status, as Claude Code's TodoWrite echo tool does) drives the agent better than instructions given once at the start; pi-episodes' open-items reminder after a fold is this pattern.
- "Testing and evals ... the hardest problem here ... you want to do evals based on observability data or instrumenting your actual test runs."
- Tool-call drift: Opus 4.8 and Sonnet 5 add invented keys to pi's nested `edits[]` schema; older models did not. Reproduces only with agentic history, and only in some transcripts; in one user's session the continuation failed ~20% of the time; stripping thinking blocks halved it; strict tool mode eliminated it. Two consequences for our benchmark: (1) a chunk of run-to-run variance is tool-call shape failure, which should be counted as its own column; (2) the model's prior is the Claude Code tool shape, so fold/recall/ask/fork tool schemas should be flat and close to what the model has seen.

### A17. Cognition: don't build multi-agents, and the April 2026 update

- Don't build multi-agents: https://cognition.ai/blog/dont-build-multi-agents (2025-06-12, Walden Yan)
- Multi-agents: what's actually working: https://cognition.com/blog/multi-agents-working (2026-04-22)
- Walden's thread: https://x.com/walden_yan/status/2047054554433462360

Takeaways:
- 2025 position: "Share context, and share full agent traces, not just individual messages"; "actions carry implicit decisions, and conflicting decisions carry bad results." Claude Code's subagents were cited as deliberately limited to read-only question-answering because they lack the parent's context. For long contexts they introduced a dedicated model that "compresses a history of actions and conversation into key details, events, and decisions", described as "hard to get right" and something they fine-tuned.
- 2026 update: the review agent works best "when the coding and review agents do not share any context beforehand." Reason given is Context Rot plus "forced to reason backward from the implementation without the spec." Devin Review catches an average of 2 bugs per PR on PRs written by Devin, ~58% severe.
- Smart-friend experiment (small primary model consulting a large one): the 80/20 answer for what context to share was "just share a fork of the full context of the primary model with the smart model"; ask broad questions and let the smart model choose what matters; and the smart model must say "go read important_file.py and ask again" instead of theorizing when the primary never read it. Direct relevance to `ask(handle, question)` and to `fork` vs clean subagent (Measurement 10).
- Manager/child Devins: "Agents assume they share state with their children when they don't." Cross-agent communication did not happen by default.
- Working pattern summary: writes stay single-threaded; other agents contribute intelligence, not actions.

---

## Part B. Compaction, summarization, handoff and memory: measured and qualitative

### B1. Anthropic: effective context engineering for AI agents

- URL: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- HN (148 points): https://news.ycombinator.com/item?id=45418251
- Date: 2025-09-29.

Takeaways:
- Compaction is "the first lever" for long-horizon coherence. Claude Code's implementation: pass message history to the model to summarize; preserve architectural decisions, unresolved bugs, implementation details; discard redundant tool outputs; continue with the summary "plus the five most recently accessed files."
- Tuning advice: "carefully tuning your prompt on complex agent traces. Start by maximizing recall ... then iterate to improve precision." The failure named is "loss of subtle but critical context whose importance only becomes apparent later." That is exactly the "note dropped the condition" case in Measurement 2.
- Tool-result clearing is "one of the safest lightest touch forms of compaction."
- Subagents "might explore extensively, using tens of thousands of tokens or more, but return only a condensed, distilled summary of its work (often 1,000-2,000 tokens)."
- Prescribes when to use what: compaction for extensive back-and-forth, note-taking for iterative development with clear milestones, multi-agent for parallel research.

### B2. Claude Code docs: what compaction keeps, what it costs, how forks and subagents cache

- Context window and what survives compaction: https://code.claude.com/docs/en/context-window
- Prompt caching, compaction cost, cache invalidation: https://code.claude.com/docs/en/prompt-caching
- Costs, cache statistics, agent teams: https://code.claude.com/docs/en/costs
- Subagents and forks: https://code.claude.com/docs/en/sub-agents
- Lessons from building Claude Code: prompt caching is everything: https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything (2026-04-30, Thariq Shihipar)

Takeaways:
- After compaction: system prompt and CLAUDE.md re-injected from disk; auto memory re-injected; fresh git snapshot; plan file re-injected; up to five most recently modified files re-read (over 5,000 tokens becomes a path reference); invoked skill bodies re-injected capped at 5,000 tokens each and 25,000 total; path-scoped rules and nested CLAUDE.md are summarized away with everything else. The illustrative timeline shows a summary at ~12% of the summarized conversation.
- The compaction request reuses the parent's exact system prompt, tools and history and appends the summarization instruction as a final user message, so it reads the cached prefix ("a fraction of what the context size suggests"). They keep a "compaction buffer" of free context for this. After a gap longer than the cache TTL the same compaction is a full uncached read. The turn after compaction rebuilds the cache for only the short summary.
- Cache rules they alert on as incidents: any prefix change invalidates everything after it; never change tools or models mid-session; pass updates (time, file changes) as messages or `<system-reminder>` blocks, not system prompt edits; plan mode is implemented as tools (`EnterPlanMode`/`ExitPlanMode`) so the tool list never changes; MCP tools are deferred stubs rather than removed.
- Cache TTL: one hour on subscription main conversation, five minutes everywhere else (subagents, forks, compaction, API keys). `/usage` prints hit ratio, misses with likely cause, and "expected rebuilds (compaction or tool-result clearing)". The `prompt_cache` object is exposed to status-line scripts.
- Fork vs fresh subagent is a documented table: fork inherits full history, same system prompt/tools/model, shares the parent's prompt cache ("costs less than a fresh subagent for tasks that need the same context"); a non-fork subagent starts from its definition with a separate cache and five-minute TTL. A fork cannot spawn forks. Fork mode is on by default in interactive sessions, off in `-p` mode.
- Agent teams use "approximately 7x more tokens than standard sessions." `/compact` itself is "a large request." `/clear` costs nothing.
- Known compaction failure modes documented by users: forgetting CLAUDE.local.md (#1027), forgetting a repository path change (#10960), fabricating structurally valid metadata to fill gaps (#22359). See B3.

### B3. Claude Code issue #26771: compaction discards data that is still on disk

- URL: https://github.com/anthropics/claude-code/issues/26771
- HN (31 points, 23 comments): https://news.ycombinator.com/item?id=47096210
- Date: 2026-02-19. Author: design-and-deliver. Still open; 22 upvotes, 118+ across 13 linked issues.

Takeaways:
- Concrete reproducible probe: paste ~8,000 characters of DOM markup, iterate for ~40 minutes, auto-compaction fires, summary says "User provided 8,200 characters of DOM markup for analysis", then ask about a specific nested data-attribute. Claude "either hallucinates details, hedges, or asks me to re-paste." This is a ready-made Measurement 2 probe ("archive-only detail").
- Root cause as stated: "compaction is a one-way lossy transformation with an available lossless source that isn't wired up." The transcript JSONL is on disk; the summary has no pointer. Proposed fix: annotate summary lines with `[transcript:lines 847-1023]` and let the model read that range on demand. This is what pi-episodes' fold handle + `recall`/`ask` already do; the issue is the user demand signal and the failure description to benchmark against.
- Workaround reported by a commenter: extract the conversation body from the latest `~/.claude` transcript, `/clear`, and have Claude read the file: "Works much better in cases where the existing compaction fails." A "/clear + read transcript" arm is a cheap third condition to consider.
- Claude Desktop already persists full transcripts to `/mnt/transcripts/` and the summary references the path; users just are not told (#31887).

### B4. Amp: handoff instead of compaction; short threads

- Handoff (No More Compaction): https://ampcode.com/news/handoff (2025-10-23)
- Context management guide (archived Nov 2025, with a 2026 note): https://ampcode.com/guides/context-management
- 200k Tokens Is Plenty: https://ampcode.com/200k-tokens-is-plenty (2025-12-09, Lewis Metcalf; archived with a 2026 note)
- Hamel Husain's notes on Amp: https://hamel.dev/notes/coding-agents/amp.html
- User write-up after 6,000 threads: https://medium.com/@steph.jarmak/how-i-use-amp-after-4-months-and-6000-threads-b4058204e9de

Takeaways:
- Why they removed `/compact`: "It's lossy ... Whether that summary contains exactly what you think it should is up to the agent"; and compaction "encourages long, meandering threads, in which you just compact once you run out of context window, stacking summary on top of summary."
- Handoff takes a goal for the next thread, has another model extract what matters from the current thread plus relevant files, and shows the draft prompt for editing before the new thread starts. `read_thread` lets a new thread pull a specific thing out of an old one ("Extract the final, working SQL query from thread T-1234") via a second model, which is close to `ask(handle, question)`.
- Their own usage data: the feature in the post was 13 linked threads, biggest 151k tokens with four user messages, average ~80k. Beyang Liu (Sourcegraph) on video: Sonnet 4's 200k window shows degradation "around 120 or 130K, and by the time you hit 170K you start to see more off-the-rails behavior." One user starts new threads at ~7% to 10% of a 1M window.
- Both archived pages now carry a caveat: "models have become a lot more forgiving" and "auto-compaction makes longer threads work well, and it's fine and productive to go beyond 200k tokens." Treat the strong 2025 claims as model-era dependent, which is an argument for the benchmark's per-model grid.
- Cost argument: long threads also miss the cache window more often during idle gaps, "a major contributor to expensive runaway threads."

### B5. Manus: context engineering lessons

- URL: https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- Follow-up summary of Peak Ji's later webinar: https://www.philschmid.de/context-engineering-part-2
- Date: 2025-07-18. Author: Yichao "Peak" Ji.

Takeaways:
- "KV-cache hit rate is the single most important metric for a production-stage AI agent." Average input-to-output ratio ~100:1; cached input on Claude Sonnet 0.30 vs 3.00 USD/MTok. Practices: stable prefix (no timestamps up front), append-only context, deterministic serialization, explicit breakpoints after the system prompt.
- Compression must be restorable: drop a web page's content but keep the URL; drop a document but keep its path. "Any irreversible compression carries risk" because you cannot predict which observation matters ten steps later. The file system is the external memory. pi-episodes' archive is the restorable store; the benchmark should count how often the restore path is actually taken.
- Recitation: Manus rewrites a `todo.md` to push the goal into the end of context; a typical task is ~50 tool calls and drifts otherwise.
- "Keep the wrong stuff in": leaving failed actions and stack traces in context lets the model update its priors; "error recovery is one of the clearest indicators of true agentic behavior." This conflicts with Recovery-Bench (A15) and Armin's isolation advice; the honest reading is that recent failures help and old failed spans hurt, which is a question about where the fold boundary sits.
- "Don't get few-shotted": uniform repetitive history makes the model repeat the pattern; they inject small variations. Relevant to how fold notes and stamps are formatted: identical scaffolding every turn may itself bias behavior.
- Later webinar: "share memory by communicating, don't communicate by sharing memory" for subagents; keep ~20 atomic tools visible; offload context to files.

### B6. Chroma: context rot

- URL: https://research.trychroma.com/context-rot (2025-07-14; Hong, Troynikov, Huber). Code: https://github.com/chroma-core/context-rot

Takeaways (the numbers people cite when they say "shorter context is smarter"):
- 18 models, task difficulty held constant while input length varies. Performance degrades with length even on trivial tasks; lower needle-question similarity degrades faster; distractors compound; shuffled haystacks beat coherent ones.
- LongMemEval: full ~113k-token chat history vs ~300-token focused input containing only the relevant parts, same question. Every family scores much higher on the focused prompt; Claude's gap is driven by abstentions under ambiguity ("I cannot determine ... not provided in the chat history" when the dates were present).
- Implication for our design: the control condition (plain pi, long context) is handicapped by rot and the treatment condition (folds) is handicapped by note loss; the benchmark must be able to tell which one lost on a given probe.

### B7. HN discussion of Databricks' result on why pi's context grows slower

- URL: https://news.ycombinator.com/item?id=48837696
- Relevant comments: "different system prompts, codex will have system prompt telling the model to gather a lot more context before starting work"; "Anecdotally we found that Pi performs more or less on par with native harnesses at lower cost on decently specified prompts ... But it fails much worse on poorly drafted prompts"; "Claude code's system prompt is filled with irrelevant stuff about how CC works"; one company routes all LLM traffic through an internal proxy and "automatically aggregate[s] context from pi sessions."
- Takeaway: task prompt quality interacts with harness; our scenarios should include at least one deliberately terse prompt, or we will overstate pi's advantage.

---

## Part C. Run-to-run variance and cost reporting: what practitioners actually do

| Source | Runs per task | How spread is reported | Notes |
| --- | --- | --- | --- |
| Aider (A5) | 1 normally; 10 once to measure | Error bars from the 10-run experiment | API nondeterministic at temp 0; "on the bubble" tasks flip |
| Harness problem (A3) | 3 x 180 tasks, fresh session | Mean deltas; per-run reports in repo | ~$300 for 16 models x 3 formats |
| DeepSWE (A6) | ~4 | pass@1 ± 1.96·SE over run index; pass@4; Wilson noted as wider | Infra errors excluded, context exhaustion counted as failure |
| OpenBench (A2) | 3 to 5 trials | Wilson 95% over matched (task, trial) cells; never blend bundles | Timeouts stay in denominator; rate-limit cells excluded |
| BenchLM (A12) | 3 | Medians, all runs published | 45-minute cap |
| agentprobe (A14) | N >= 5 | t-interval, Cohen's d, interleaved order | Cites 15% accuracy variance at temp 0 |
| Artificial Analysis index (via A12) | 3 | Average of three attempts per task | Most rows "two or three runs" |
| Square Minus Square (A13) | 2 | Best of 2 reported | Author admits no conclusive winner |
| Yugabyte (A4) | >= 11 prompts per config | Means only | HN reader attributes an anomaly to variance |
| Databricks (A1) | not stated | Point estimates, "statistically tied" asserted | |
| Armin (A16) | repeated trials on one transcript | ~20% failure rate on continuation | Variance concentrated in specific histories |

Cost reporting patterns worth copying: cost per task and tokens per solve (not per attempt) with cache read/write split out (A1, A2, A14); median wall time among solved only (A2); publish failed runs with the same detail as passes (A12); record the model's declared context window and output cap per row (A2); record edit-format/tool-call failure counts separately (A3, A5, A16).

---

## Lessons to apply to our benchmark

Numbered so the design doc can cite them.

1. Grade with held-out tests only; use the LLM judge for trajectory properties, never for pass/fail (A1, A6, A4). Validate every checker both ways before any paid run: fails on the untouched tree, passes on a golden patch (A2). Run the checker three times during authoring and reject flaky ones (A6).
2. Seal git history in the trial worktree (shallow clone or detached copy with `.git` removed) so the model cannot `git log` its way to a solution, and so the control condition cannot recover folded information from commits in ways the treatment cannot (A1, A6). Keep a copy of the full `.git` outside the tree for our own diffing.
3. Add a null arm (no model, or a model told to do nothing) and expect 0% from it (A2). A nonzero null score is a broken checker.
4. Runs: at least 3 per cell for the full grid, 5 for the pilot cells used to size variance (A14, A6). Interleave conditions A/B/A/B rather than running all A then all B (A14). Report Wilson intervals over matched (task, trial) cells and a run-to-run SE, and show both (A2, A6). Only call a difference real when intervals separate; 8 tasks will not separate anything (A6's n=10 pilot gave [17,69]% for 4/10).
5. Keep every result row self-describing: condition, prompt variant hash, model id, thinking level, declared context window and max output, pi version, pi-episodes version, timeout, exit class, checker exit, tokens split into input/cacheRead/cacheWrite/output/reasoning, turns, wall time, number of 429-killed replies, number of tool-call validation errors (A2, A5, A16). Rows written before a field existed should be allowed to omit it.
6. Separate failure classes the way OpenBench and DeepSWE do: infra or provider error (exclude, do not resample), timeout (count as fail), context exhausted or compaction storm (count as fail, flag), checker fail, pass. Do not let a throttled cell masquerade as a wrong answer (A2).
7. Report cost per task and tokens per solve (all attempts divided by passes), with cache reads never folded into "input" (A2, A14). Report "context tokens attended per request summed over the run" as the primary efficiency number, as `MEASUREMENTS.md` §9 already says; it is the quantity Databricks found differed 3x between harnesses (A1).
8. Measure cache behavior as a first-class outcome, not a side note: cacheWrite after each fold vs after compaction, hit ratio per request, and whether a fork's first request reads the parent prefix (B2, A16, B5). The Claude Code docs give exact expectations to compare against: fork shares the parent cache, a fresh subagent does not, compaction rebuilds for the short summary only.
9. Probes for note sufficiency should include the "archive-only detail" shape from issue #26771: a large pasted artifact (markup, log, schema) early in the session, a question about one specific element after the fold/compaction (B3). Score three outcomes: answered from context, went back to the archive then answered, guessed. Recovery-Bench's ablation predicts a fourth risk worth a column: the note itself misleads (A15).
10. Include a mid-session temporary change that must be reverted (the postcompletion trap in `MEASUREMENTS.md` §4) and a "declares victory early" check at the end of each goal; both are documented failure modes of long-running agents (A8, A10). Count early stopping separately from wrong output; it is a model trait (A10).
11. Include at least one terse, underspecified task prompt per scenario. Pi's efficiency advantage shrinks or reverses on poorly drafted prompts according to practitioners (B7), and prompt wording alone changed whether models wrote their own tests from under 20% to over 80% of runs (A6).
12. Count tool-call schema failures (rejected `fold` with made-up `since`, invented extra keys) as a separate column and look at them per model before blaming the prompt (A16, A3). Keep fold/recall/ask/fork schemas flat; nested arrays after long strings are where models invent keys (A16).
13. For prompt-variant comparison, expect what Yugabyte saw: a change that helps one model or one task family regresses another, and prohibitions are followed while procedures are not (A4). Hold a general scenario fixed as a regression set whenever a prompt is tuned on a specific one. Prefer a worked example of a good fold note in the prompt over more rules about notes.
14. For fork vs clean subagent (`MEASUREMENTS.md` §10), the practitioner priors are split: Cognition found a clean-context reviewer better for review and a full-context fork better as the 80/20 for consultation (A17); Anthropic's research system got its gains from clean subagents on parallelizable reads (A7); Recovery-Bench found full action history worst for recovery (A15). So the benchmark must split delegated tasks by kind: "continue this work" (expect fork to win on re-reads) vs "review or verify this" (expect clean to win on anchoring). Seed a wrong guess in the parent before forking, as `MEASUREMENTS.md` already plans.
15. Keep test and tool output short in the harness: pre-filter test output to failures, log the rest to a file, and give the agent a fast subset of the 10-minute suite (A9, Claude Code hook example in B2). Otherwise both conditions spend context on noise and compaction fires for reasons unrelated to the work.
16. Isolate pi completely per trial: temp `HOME` and `PI_CODING_AGENT_DIR` with only `auth.json`, `--no-extensions` plus `-e` for pi-episodes in condition B, `--no-approve`, `--mode json`, and drop `message_update` events while streaming (A2's adapter). Pin and record the model's context window; an understated one silently clamps output and reads as a bad model (A2).
17. Start with a 20-cell pilot before the grid; early prompt changes have large effects that are visible at that size (A7). Use the pilot to measure variance and decide N, not to publish.
18. Publish failed runs and transcripts (scrubbed) with the same detail as passes (A12, A2). Keep a scrubber for home paths, usernames and keys before anything leaves the machine (A2).
19. Expect the control to drift and the treatment to forget: pair every efficiency metric with a correctness probe so "cheaper but wrong" is visible (A1's "a cheaper run that fails more is a loss", B6).
20. Treat 2025-era "200k is plenty / agents get drunk" claims as model-dependent; Amp archived both pages with that caveat (B4). The per-model grid in the plan is the right response; do not generalize from one model.

What not to adopt:
- Best-of-N reporting (A13) or pass@k headlines; report pass@1 with spread and keep pass@k as a secondary number (A6, A12's "pass^k" critique).
- LLM-judged correctness (A1).
- Full-suite test runs inside the agent loop for every edit (A9; 10 minutes per run would dominate wall time and context).
- Hand-written expected outputs for checkers; derive them from the golden solution (A2).
- A single long AGENTS.md or prompt with every rule (A11, A4); a short map plus examples.

---

## Repos worth reading before writing our runner

1. https://github.com/minghinmatthewlam/openbench. Read `obench/adapters/pi.py` (isolated HOME, `--mode json` parsing, delta-event dropping, usage invariant check, throttle counting, pinned limits), `obench/report.py` (Wilson over matched cells, tokens-per-solve basis), `TOKEN_PARITY.md`, `docs/private-evals.md` (`workspace.toml` git-ref materialization), `validate_tasks.py` (checker polarity), the results.jsonl field list in the README. Closest existing thing to what we are building; it already treats pi as a harness.
2. https://github.com/sergeyklay/agentprobe. Read `framework/orchestrator.sh` (interleaved schedule), `framework/lib/stats.sh` (CI, Cohen's d), `framework/lib/git-isolation.sh`, and `experiments/001-claude-md-effect/experiment.yaml` for the experiment-as-directory layout. Small enough to read in full.
3. https://github.com/Aider-AI/aider/tree/main/benchmark. Read `benchmark.py` for the two-attempt loop with test feedback, request/response hashing, Docker setup, and the per-run result record that the leaderboard renders.
4. https://github.com/can1357/omp (package `react-edit-benchmark`). Mutation-based task generation and per-run reports; useful if we want cheap synthetic sub-tasks to pad variance estimates.
5. https://github.com/datacurve-ai/deep-swe. Harbor-format tasks and trajectories, per-run scores and the CI code; verifier authoring checklist (prompt-verifier bijection, acceptance breadth, realism, environment cleanliness).
6. https://github.com/letta-ai/recovery-bench. How to seed a task with a prior failed trajectory in three forms (environment only, summary, full history); directly reusable for the "fork from a parent holding a wrong guess" scenario.
7. https://github.com/anthropics/claude-quickstarts/tree/main/autonomous-coding. The initializer/coding agent prompts, feature-list JSON and progress file from A8; a template for the "goal that splits into sub-goals" scenario shape and for a post-run "did it leave the tree clean" check.
8. https://github.com/chroma-core/context-rot. Focused-vs-full prompt methodology if we want a cheap offline probe of note sufficiency without a full agent run.
9. https://github.com/anthropics/claude-code/issues/26771 and the linked issues (#1534, #3021, #10960, #13919, #14968, #19888, #21105, #22359, #23620, #27242). Not code, but the best catalogue of concrete compaction failure shapes to turn into probes.
