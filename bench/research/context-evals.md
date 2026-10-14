# How context management in coding agents has been evaluated

Research report for `bench/PLAN.md`, phase 1. Written 2026-10-14. Sources are URLs and arXiv ids; numbers are copied from the sources, not recomputed.

Numbering note: the brief refers to MEASUREMENTS.md "2 and 7" (probes, traps), "#5" (outcome parity) and "#6" (fork vs clean subagent). In the current file those are: probes = §2 (note sufficiency), traps = §4 (postcompletion steps), going back = §7, outcome parity = §9 (cost and outcome against compaction), fork vs clean subagent = §10. This report uses the file's current numbers.

## 1. Published evaluations of compaction and condensation

### 1.1 OpenHands context condenser (April 2025)

Source: https://www.openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents (Calvin Smith). Condenser code: https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/context/condenser/llm_summarizing_condenser.py, docs https://docs.openhands.dev/sdk/arch/condenser.

- Mechanism: `LLMSummarizingCondenser`. Triggers on event count (`max_size`; defaults differ by version: 100 in the old config, 120 in the SDK arch docs, 240 in the current SDK class), keeps the first `keep_first` events verbatim (1, 4 or 2 by version), summarizes the middle, keeps the tail so the view drops to `max_size // 2` events. Summary prompt tracks USER_CONTEXT, COMPLETED, PENDING, CURRENT_STATE, CODE_STATE, TESTS, CHANGES, DEPS, VERSION_CONTROL_STATUS (prompt reproduced in arXiv:2508.21433 Appendix E). OpenHands also ships an `observation_masking` condenser (`attention_window`, default 100 events).
- Tasks: "a subset of SWE-bench Verified". Subset size, model, and number of runs are not stated.
- Metrics: solve rate; average API cost per turn (plotted against turn index); total cost, total tokens, completion time, number of turns.
- Held fixed: same agent (CodeActAgent) with and without the condenser; several "breakpoints" (condensation thresholds) tried, "trends hold regardless of the breakpoints chosen".
- Headline: condensed agent solves 54% vs baseline 53%; per-turn cost settles at "less than half" of baseline once condensation kicks in; condensation uses fewer total tokens and less wall time; the only loss is more turns, because a turn is spent condensing.
- Gaps: no n, no confidence interval, one run. A 1 pp solve-rate difference on an unstated subset is noise. The per-turn-cost chart is the only quantitative figure.

### 1.2 JetBrains Research, "The Complexity Trap" (arXiv:2508.21433, NeurIPS 2025 DL4C workshop)

Sources: https://arxiv.org/abs/2508.21433 (v3, Oct 2025), code https://github.com/JetBrains-Research/the-complexity-trap, data https://huggingface.co/datasets/JetBrains-Research/the-complexity-trap, blog https://blog.jetbrains.com/research/2025/12/efficient-context-management.

- Setup: SWE-agent on SWE-bench Verified (n = 500), turn limit 250, agent temperature 0.8, summarizer temperature 0. Five model configurations: Qwen3-32B (thinking and not), Qwen3-Coder-480B, Gemini 2.5 Flash (thinking budget 800 and 0). One run per instance per condition. Generality probe on OpenHands v0.43.0 with Gemini 2.5 Flash on a 50-instance slice.
- Conditions: Raw Agent (no management); Observation Masking (replace tool observations older than M = 10 turns with a placeholder, reasoning and actions kept); LLM-Summary (OpenHands-style prompt, summarize N = 21 turns at once, keep the last M = 10). The hybrid used masking during accumulation and summary as a last resort (N = 43, M = W = 10).
- Metrics: solve rate (%); instance cost in USD (API-reported for Gemini; for self-hosted Qwen computed post hoc from per-turn token usage at Alibaba list price, which has no cache discount, so Qwen costs are inflated); mean trajectory length in turns. Statistics: paired nonparametric bootstrap over the same 500 instances, B = 10,000, 95% percentile CIs, two-sided p with significance at p < 0.05 (Appendix C.1).
- Headline numbers (Table 1 / Table 4, change vs Raw Agent):
  - Qwen3-Coder 480B: solve 53.4 → 54.8 masking (+1.4 pp, CI [-1.6, 4.4], p = 0.39) and 53.8 summary (+0.4 pp, CI [-3.0, 3.8]); cost 1.29 → 0.61 (-52.7%) and 0.64 (-50.4%), both p < 10^-4.
  - Gemini 2.5 Flash: solve 32.8 → 35.6 / 36.0 (not significant); cost -56.1% / -41.5%.
  - Gemini 2.5 Flash thinking: solve 40.4 → 36.4 masking (-4.0 pp, p = 0.04) and 31.4 summary (-9.0 pp, p < 10^-4); cost -57%.
  - Qwen3-32B thinking: trajectories too short (median 15 turns) for either strategy to do anything.
- Other findings: observation tokens are ~84% of a SWE-agent turn. Summaries lengthen trajectories by ~15% (Gemini Flash 52 turns vs 44 masking vs 50 raw); summaries "act as a reinforcing signal, encouraging the agent to keep going". Summary generation itself is up to 7.2% of instance cost and cannot reuse the agent's cache. A critic-enhanced summary (reflections added to the summary) did not improve solve rate and elongated trajectories further. The masking window M is scaffold-specific: M = 10 from SWE-agent "degrades drastically" on OpenHands, which needed M = 58. Hybrid on SWE-bench Verified-50: +2.6 pp over Raw, 7% cheaper than masking, 11% cheaper than summary.
- Stated limitations: fixed, non-adaptive triggers "ignoring semantic boundaries or agent subgoals". That is exactly the gap pi-episodes targets.

### 1.3 ACON, Agent Context Optimization (arXiv:2510.00615, ICML 2026)

Source: https://arxiv.org/abs/2510.00615 (KAIST / Microsoft), code https://github.com/microsoft/acon.

- Idea: an LLM compressor for history and for single large observations, whose prompt ("compression guideline") is optimized in natural language from contrastive pairs (task succeeds uncompressed, fails compressed). Then distilled into smaller models.
- Tasks: AppWorld (168 test-normal tasks), OfficeBench, 8-objective QA; all 10+ steps. Not coding.
- Metrics (Appendix B.2): task accuracy; Steps; Peak tokens = max context length over any step, excluding the system prompt; Dependency = Σ_t (n_in^(t) + 2 n_out^(t)) · n_out^(t) / 2 (area under the context-size curve, a proxy for cumulative generation cost); API cost at list price.
- Headline: peak tokens down 26 to 54% "while largely preserving task performance". AppWorld with gpt-4.1: no compression 56.0% accuracy, 9.93k peak; ACON 56.5%, 7.33k peak; FIFO truncation 45.8%; retrieval 27.4%; LLMLingua 39.3%; plain prompting 43.5%. Small agent models gain 20 to 46% from compression "by mitigating context distraction".
- Baselines ACON cites: Smith 2025 (OpenHands), Context-Folding (2510.11967), AgentFold (2510.24699), MEM1 (2506.15841). Appendix A notes that history compression invalidates the KV cache and that the field "faces a trade-off" nobody has measured end to end.

### 1.4 AgentDiet, trajectory reduction (arXiv:2509.23586, FSE 2026)

Source: https://arxiv.org/abs/2509.23586 (Xiao, Gao, Peng, Xiong; Peking University / ByteDance).

- Setup: Trae Agent with Claude 4 Sonnet and Gemini 2.5 Pro. A separate cheap "reflection" LLM (GPT-5 mini) rewrites one step at a time, with a sliding window: at step s it may reduce step s - a (a = 2) given b = 1 steps of context, only if the step is over θ = 500 tokens and only if the saving exceeds θ. Hyperparameters tuned by hill climbing on 100 SWE-bench Verified instances, then evaluated on 200 held-out instances plus Multi-SWE-bench Flash (300 instances, 7 languages). Step limit 50 / 100. Total experiment cost ≈ US$2000. One run per condition.
- Metrics (§4.2.4): Keep% = Σ l_reduced / Σ l_orig over processed steps; I and O = accumulated input and output tokens, normalized so Original = 1; $ = agent cost and $+ = reflection overhead, both normalized, computed from list prices including the cached-input discount; Pass%; Step = mean steps over all instances; PStep = mean steps over passed instances ("an increase in steps indicates that some information is inappropriately reduced").
- Headline (Table 4): input tokens -39.9% to -59.7%; agent cost -28.6% to -44.1%; after overhead, total cost -21.1% to -35.9%. Pass%: 64.5 → 66.5 (SWE-bench, Claude), 50.5 → 52.0 (Gemini), 40.0 → 39.0 and 21.7 → 22.7 (Multi-SWE). Gemini 2.5 Pro on Multi-SWE: instances hitting the 100-step limit fell from 66 to 26 because shorter context stopped a loop of invalid tool calls.
- Finding that matters most for pi-episodes (§2.3.2): they first tried an `erase` tool so the agent could reduce its own trajectory. "Even with powerful LLMs such as Claude 4 Sonnet and Gemini 2.5 Pro, the agent often persisted with the original task without calling erase, despite explicit prompts", including a `#reflection` user turn that said to call only `erase`. They concluded self-reduction "would require careful fine-tuning" and moved reduction to an external module. pi-episodes relies on the model calling `fold` on its own; this is the strongest published evidence that it may not.
- Trivial baselines: deleting all processed tokens (Delete) kept Pass% at 58 vs 65, with Step +14%; the agent re-fetches what it lost. They note the Complexity Trap's masking is "a variant of the Delete baseline" with a = 10.

### 1.5 Context-Folding and AgentFold (RL-trained folding agents)

- Scaling Long-Horizon LLM Agent via Context-Folding, arXiv:2510.11967 (ByteDance Seed, ICML 2026), https://context-folding.github.io, code https://github.com/sunnweiwei/FoldAgent. The agent branches into a sub-trajectory for a subtask and folds it back to a summary; trained with FoldGRPO. Tasks: BrowseComp-Plus (N = 150) and SWE-bench Verified (N = 500). Metrics: pass@1, peak length, max length, number of tool calls, Finish rate (completion within the context limit), Scope (branch on-topic accuracy). Headline: Seed-OSS-36B folding agent at 32K active context × up to 10 branches reaches 62.0% / 58.0% vs ReAct with 327K context at 47.8% / 55.2% (54.0 / 57.4 with GRPO) and vs a summary agent at 52.7 / 55.0. The folding agent makes more tool calls (19.2 vs 10.8 on BrowseComp-Plus, 96.5 vs 49.5 on SWE-bench). "Active context 10× smaller" is peak context, not total tokens; the paper does not report total tokens or wall time. Everything is RL-trained, so it says little about prompt-only folding.
- AgentFold, arXiv:2510.24699 (Alibaba Tongyi). Web agent that "folds" at each step at multiple granularities; SFT only. 36.2% on BrowseComp with a 30B-A3B model. Web search, not coding; no compaction baseline on the same model reported in the abstract.

### 1.6 Anthropic: context editing, memory tool, Claude Code compaction

- Managing context on the Claude Developer Platform (2025-09-29): https://claude.com/resources/articles/context-management (originally anthropic.com/news/context-management). Context editing clears stale tool results; memory tool is a client-side file store. "On an internal evaluation set for agentic search", memory + context editing improved performance by 39% over baseline, context editing alone by 29%. "In a 100-turn web search evaluation", context editing let agents finish workflows that otherwise fail from context exhaustion "while reducing token consumption by 84%". No task count, model, runs, or definition of "performance".
- Claude Opus 4.5 announcement: "context management and memory" plus subagents raised a fetch-enabled BrowseComp-Plus from 70.48% to 85.30% (footnote 4), averaged over 5 trials. https://www.anthropic.com/news/claude-opus-4-5
- Effective context engineering for AI agents (2025-09-29): https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents. Names three long-horizon levers: compaction, structured note-taking, sub-agents. Tool result clearing is "the safest, lightest touch". No measurements beyond citing the multi-agent post and Chroma.
- Claude Code behavior (docs, not evals): https://code.claude.com/docs/en/context-window and https://code.claude.com/docs/en/how-claude-code-works. Micro-compaction clears old tool results inline; auto-compaction summarizes when near the limit, re-reads up to five recently modified files after compaction, caps re-injected skills at 5k tokens each / 25k total. The session-management post (https://claude.com/blog/using-claude-code-session-management-and-1m-context) says "bad compacts can happen when the model can't predict the direction your work is going" and that "due to context rot, the model is at its least intelligent point when compacting". A third-party source-code analysis (https://claude-code-explain.helmcode.com/context-compaction) lists a 20k-token compaction output cap and a 3-failure circuit breaker. Anthropic has published no compaction eval.
- Cursor summarization is described only in docs (https://docs.cursor.com/en/agent/chat/summarization), no eval.

### 1.7 Factory: probe-based compaction evaluation (December 2025)

Source: https://factory.ai/news/evaluating-compression, follow-up https://factory.com/articles/coding-agent-context-compaction (2026-09-24), method post https://factory.com/news/compressing-context (2025-07-21).

- Conditions: Factory's anchored iterative summary (structured sections for intent, file modifications, decisions, next steps; each compaction summarizes only the newly truncated span and merges it), OpenAI `/responses/compact`, Anthropic Claude SDK compaction (regenerates the whole summary each time). Same conversation prefixes fed to all three.
- Data: "hundreds of compression points" over 36,611 messages from opted-in production coding sessions.
- Method: at each compression point generate four probes from the truncated history (Recall: "what was the original error?"; Artifact: "which files did we modify?"; Continuation: "what next?"; Decision: "what did we decide about X?"). GPT-5.2 judge scores six dimensions 0 to 5 with rubrics (accuracy, context awareness, artifact trail, completeness, continuity, instruction following); overall = unweighted mean. Judge is blind to the method.
- Headline: overall Factory 3.70, Anthropic 3.44, OpenAI 3.35. Artifact trail is the weakest dimension for all three (2.45 / 2.33 / 2.19): "a session that produces a fluent summary can still lose track of which files changed." Compression ratios 98.6% / 98.7% / 99.3%. Their stated lesson: "The right optimization target is not tokens per request. It is tokens per task."
- Gaps: vendor-run; LLM judge with no human agreement check; no CIs; probes and judge both LLM-generated; measures probe answers, not whether the task finished. The September 2026 article adds a test they recommend: include a correction after the summary and "verify that the new instruction replaces the stale decision instead of living beside it ambiguously".

### 1.8 Letta / MemGPT memory evaluations

- Letta Leaderboard (2025-05-29): https://www.letta.com/blog/letta-leaderboard/, docs https://docs.letta.com/leaderboard, code https://github.com/letta-ai/letta-leaderboard (archived into Letta-Evals). Synthetic fictional QA so the model has no prior knowledge. Four tasks: core memory read (facts in context), archival read (facts only in external store, agent must search), memory write (a simulated user tells facts over chat, agent must store them, question later), memory update (a contradicting fact arrives, agent must edit its memory block, same question asked again). Grader: prompted GPT-4.1 as in SimpleQA. There is "a penalty for extraneous memory operations" so models that over-search score lower. Run with `--repeat=3`. Claude Sonnet 4 and GPT-4.1 on top; o-series worse than GPT-4.1.
- "Is a filesystem all you need?" (2025-08-12): https://www.letta.com/blog/benchmarking-ai-agent-memory. Letta with gpt-4o-mini and grep / semantic search / open / close over LoCoMo histories stored as files scores 74.0% vs Mem0's best 68.5%. Their point: "an agent's memory quality depends more on the agentic system's ability to manage context and call tools than on the memory tools themselves." Also documents the Mem0 vs Letta LoCoMo dispute.
- Recovery-Bench (2025-08-27): https://www.letta.com/blog/recovery-bench/, https://github.com/letta-ai/recovery-bench. A weak agent fails a Terminal-Bench task; the recovery agent starts from the corrupted environment, optionally with the failed action history. Mean score drops from 26.3% (fresh) to 11.2% (recovery), a 57% relative decrease. Rankings change (GPT-5 first on recovery, third-ranked Claude 4 Sonnet first on fresh). Providing only the environment already hurts; adding the failed history hurts more ("context pollution from errors in the action history"). This is the closest measured evidence on inherited context, relevant to §10.

### 1.9 Chroma, "Context Rot" (July 2025)

Source: https://research.trychroma.com/context-rot (Hong, Troynikov, Huber), code https://github.com/chroma-core/context-rot. 18 models, temperature 0, GPT-4.1 judge aligned to humans.

- Design principle: hold task difficulty fixed and vary only input length. Four NIAH extensions (8 input lengths × 11 needle positions): needle-question similarity, distractors, needle-haystack similarity, haystack structure. Plus LongMemEval focused vs full, and a repeated-words copy task.
- Results reported as curves, not single numbers: performance falls with input length in every experiment; lower needle-question similarity makes the fall steeper; one distractor already reduces accuracy and four compound it; shuffled haystacks are easier than coherent ones for all 18 models; needle position did not matter in the NIAH variant. Claude models abstain under ambiguity; GPT models hallucinate.
- LongMemEval: 306 cleaned questions (knowledge update, temporal, multi-session). Focused prompt ≈ 300 tokens (only the relevant turns) vs full ≈ 113k tokens. "Across all models, we see significantly higher performance on focused prompts"; the gap is largest for Claude Opus 4 / Sonnet 4 because they abstain. Thinking mode narrows but does not close the gap. This is the direct experiment for "does removing irrelevant history help": same facts, less noise, better answers.

## 2. Benchmarks that test long-horizon memory in agents

| Benchmark | Source | Shape | Chained inside one session? | How "did it remember X" is scored | Probes / traps |
| --- | --- | --- | --- | --- | --- |
| LongMemEval (ICLR 2025) | arXiv:2410.10813, https://github.com/xiaowu0162/longmemeval | 500 questions over ~50 synthetic chat sessions (~115k tokens in LongMemEval_S) | No: history is given, one question at the end | Answer vs gold, LLM judge; question types: single-session user/assistant/preference, multi-session, temporal, knowledge-update, abstention (`_abs` ids) | Probes yes. Knowledge-update questions are a trap: the later statement must override the earlier one. Abstention questions test not guessing. Long-context LLMs drop 30 to 60% vs focused. |
| LoCoMo (ACL 2024) | arXiv:2402.17753, https://snap-research.github.io/locomo | 10 public conversations, ~300 turns each, 1,986 QA pairs (paper: 50 conversations, 7,512 questions); 5 categories incl. adversarial | No | QA F1 / LLM judge; event summarization | Adversarial category = unanswerable probes. Known label errors; vendor scores are not comparable across harnesses (Mem0 vs Zep vs Letta disputes). |
| MemoryAgentBench (ICLR 2026) | arXiv:2507.05257, https://github.com/HUST-AI-HYZ/MemoryAgentBench | Context fed incrementally in chunks over turns; then questions | Partly: test-time learning (rules taught early, used later) and conflict resolution (later facts override) | Exact / substring match; Recall@5 for recsys | Four competencies: accurate retrieval, test-time learning, long-range understanding, conflict resolution. Conflict resolution is the "trap" analogue. |
| MemBench (ACL 2025 Findings) | arXiv:2506.21605 | Participation vs observation scenarios; factual vs reflective memory; 10k and 100k sessions | No | Multiple choice accuracy; read/write time; "capacity" = length at which accuracy collapses | Shows FullMemory 0.647 → 0.489 (10k → 100k) vs RetrievalMemory 0.692 → 0.833: more raw context, lower accuracy. |
| LongMemEval-V2 (2026) | arXiv:2605.12493 | 451 questions over up to 500 web-agent trajectories (115M tokens) | No | Static state recall, dynamic state tracking, workflow knowledge, environment gotchas, premise awareness | Closest to "memory of prior agent work"; gotchas ≈ caveats a note must carry. |
| Letta Leaderboard | see §1.8 | Facts told over chat, question later; contradicting fact, question again | Yes (write then read; update then read) | SimpleQA-style grading, penalty for extraneous memory ops | Update task is a trap. Penalty for spurious operations maps to §7 spurious rate. |
| τ-bench | arXiv:2406.12045, https://github.com/sierra-research/tau-bench | Simulated user + tools + policy, one task per episode | Multi-turn within a task, not across tasks | End database state vs gold; pass^k = fraction of tasks solved in all k iid trials (pass^1 = mean success) | No probes. The reliability metric is the reusable part: gpt-4o retail pass^1 0.604 → pass^4 0.383. |
| Vending-Bench | arXiv:2502.15840, https://andonlabs.com/evals/vending-bench | One run > 20M tokens; agent sees last 30k tokens plus memory tools and a sub-agent | Yes by construction (orders placed early must be remembered) | Net worth; "days until sales stop"; 5 runs per model | Failures ("forgetting orders", "meltdown loops") show no correlation with the context-full point. GPT-4o-mini did better with 10k memory than 60k. |
| Recovery-Bench | see §1.8 | Start from another agent's failed state | Yes (inherits prior trajectory) | Terminal-Bench reward | A trap of the "inherited wrong state" kind. |
| BrowseComp-Plus | https://huggingface.co/datasets/Tevatron/browsecomp-plus-corpus, used by arXiv:2510.11967 | One long search task with a fixed corpus | Within one task | Exact answer | None. |
| LoCoBench (Salesforce) | arXiv:2509.09614 | 8,000 prompts, 10K to 1M tokens, 10 languages; categories include "multi-session development" | No: single-prompt long-context, not an agent loop | LCBS 0 to 5 from 17 metrics (compilation, tests, style, "information coverage utilization") | None. Despite the name, not a session benchmark. |
| SWE-bench Verified / Multimodal / Pro | https://www.swebench.com | One issue per episode | No | Hidden tests | None. No "SWE-bench Long" exists; LongCodeBench (arXiv:2505.07897) is long-prompt code QA. |

Takeaways for scenario design:

- No published benchmark chains two coding goals in one session so that goal 2 depends on what goal 1 found, then probes at the end. The closest are MemoryAgentBench's test-time learning, Letta's write-then-read, and Vending-Bench's order tracking. The pi-episodes scenario is new; design it so each probe has a gold answer scripted in advance (as LongMemEval does) rather than judged post hoc.
- Probe taxonomy to copy: Factory's four probe types (recall, artifact, continuation, decision) plus LongMemEval's two special types (knowledge-update: the fact changed later; abstention: the answer is not in the history, correct behavior is to say so or to go look). MEASUREMENTS §2 already has the split "fact the note should carry" vs "detail only the archive has"; the abstention category is the third case worth adding (fact in neither note nor archive).
- No benchmark scores "temporary change must be reverted". Nearest analogues: LongMemEval knowledge updates, MemoryAgentBench conflict resolution, Factory's recommended "include a correction after compaction and check the stale decision is replaced". Keep §4's trap design; score each trap binary (reverted / not) and also record "listed under Open".

## 3. Metrics for context efficiency

Names and formulas in use, with where they come from. pi records `input`, `cacheRead`, `cacheWrite`, `output`, `cost` per assistant message (PLAN.md), so all of these are computable from session files.

| Metric | Definition | Used by |
| --- | --- | --- |
| Solve rate / Pass% | share of tasks passing hidden tests | all SWE-bench work |
| Instance cost ($) | USD per task, API-reported or list price with cached-input discount | Complexity Trap (Table 1), AgentDiet ($ and $+), ACON |
| Accumulated input tokens, I | Σ over requests of prompt tokens; AgentDiet normalizes so baseline = 1 | AgentDiet; pi-episodes §9 "context tokens per request, summed over the run" is the same thing with `input + cacheRead + cacheWrite` |
| Peak tokens | max prompt size over any request, system prompt excluded | ACON, Context-Folding ("peak length") |
| Dependency | Σ_t (n_in + 2 n_out) · n_out / 2 | ACON (from LightThinker, MEM1) |
| Keep% | tokens kept / tokens processed by the reducer | AgentDiet; analogous to note-to-span ratio in §0 |
| Overhead cost, $+ | cost of the management calls (summaries, reflection) separate from agent cost | AgentDiet; Complexity Trap Table 2 (summary cost = 0.65 to 7.2% of instance cost) |
| Steps / PStep | mean turns over all tasks / over passed tasks | AgentDiet; Complexity Trap reports mean trajectory length |
| Finish rate | share of runs that end within the context limit | Context-Folding |
| pass^k | fraction of tasks solved in all k iid trials; pass^1 = mean | τ-bench; adopted in Anthropic model cards |
| Aptitude / unreliability | P90 score over repeated runs / P90 minus P10 | Laban et al. arXiv:2505.06120 |
| KV-cache hit rate | cached input tokens / all input tokens, per request | Manus (https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus): "the single most important metric for a production-stage AI agent"; agent input:output ratio ≈ 100:1; cached Sonnet input is 10× cheaper. Claude Code transcript analysis in https://github.com/anthropics/claude-code/issues/74318 measured ~95% of input tokens as cache hits over 6.8B tokens and found subagent prefixes re-billed at write rate instead of read rate; the author estimates subagent prompt cost could drop ~14% with better breakpoints. |
| Compression ratio | 1 - summary tokens / replaced tokens | Factory (98.6 to 99.3%); Factory argues it is the wrong target |
| Probe score | 0 to 5 per dimension, LLM judge with rubric | Factory |
| Tokens per correct answer | tokens consumed / correct probe answers | Bench'd memory leaderboard (https://benchd.ai) |

Formulas to fix for pi-episodes, so numbers line up with prior work:

- `context_attended = Σ_requests (input + cacheRead + cacheWrite)`; report absolute and normalized to condition A = 1 (AgentDiet's I).
- `cache_hit = cacheRead / (input + cacheRead + cacheWrite)` per request; report median and the share of requests with hit < 0.5 ("full write" in §9).
- `cost_agent` = Σ `usage.cost` on main-line assistant messages; `cost_overhead` = Σ cost of fold notes (the fold turn's output), `ask`, `fork` children, compaction summaries. Report both, as AgentDiet's $ and $+.
- `peak_context = max_requests (input + cacheRead + cacheWrite)`.
- `steps` and `psteps` (turns on passed runs only).
- `pass^k` with k = number of runs per task (3 minimum in MEASUREMENTS; 5 gives usable P90/P10).
- Statistics: paired bootstrap over tasks (and over runs within task), B = 10,000, report 95% percentile CI and two-sided p, as in arXiv:2508.21433 Appendix C.1. With 5 tasks × 3 runs the CI on solve rate will be roughly ±25 pp; solve rate can only be a non-inferiority check at that scale. Token and cost metrics are continuous and paired, so they can show a difference with far fewer tasks.

## 4. Does a smaller, cleaner context improve reasoning? Effect sizes

Controlled studies of length alone (same facts, more filler):

- Lost in the Middle (Liu et al., TACL 2024, arXiv:2307.03172): GPT-3.5-Turbo, 20 documents (~4k tokens): 75.8% with the answer first, 53.8% at position 10, 63.2% last; closed-book 56.1%. So the worst position is below not reading anything. Claude-1.3: 59.9 / 56.8 / 60.1.
- NoLiMa (ICML 2025, arXiv:2502.05167, https://github.com/adobe-research/NoLiMa): GPT-4o 99.3% at ≤1k → 69.7% at 32k → 56.0% at 128k; GPT-4.1 97.0 → 79.8 (32k) → 64.7 (128k); Llama 3.3 70B 97.3 → 42.7 at 32k. "Effective length" (≥ 85% of base) is 16k for GPT-4.1, 8k for GPT-4o, 2k for Llama 3.3 70B. 11 of 13 models lose half their accuracy at 32k. Mechanism: no literal match between question and needle.
- LongMemEval (arXiv:2410.10813): long-context LLMs show a 30 to 60% drop on LongMemEval_S (~115k tokens) vs the oracle (relevant turns only).
- Chroma Context Rot (§1.9): focused ≈ 300 tokens vs full ≈ 113k on 306 LongMemEval questions; all 18 models better on focused, Claude 4 largest gap through abstention; thinking narrows it.
- MemBench: FullMemory accuracy 0.647 at 10k → 0.489 at 100k; retrieval-based memory 0.692 → 0.833.

Irrelevant and distracting content (not just length):

- Shi et al. 2023, GSM-IC (arXiv:2302.00093): adding one irrelevant sentence to grade-school math problems; macro accuracy (consistent across all distractor variants) falls below 30% for most prompting methods on models that solve the base problems at ~80%. Mitigations: self-consistency, "ignore irrelevant information" instruction, exemplars that contain distractors.
- Chroma distractors: a single topically related distractor lowers accuracy at every length; four compound; the effect grows with length.
- Laban et al. 2025, LLMs Get Lost in Multi-Turn Conversation (arXiv:2505.06120, ICLR 2026): 15 models, 6 tasks, 200k simulated conversations. Same instructions delivered in shards over turns instead of at once: average -39%; aptitude (P90) -15%; unreliability (P90 - P10) +112%. GPT-4.1 code task: 96.6 → 72.6. Models "make assumptions in early turns and prematurely attempt to generate final solutions, on which they overly rely" and do not recover. This is the published number behind "more predictable results" in the PLAN goal: multi-turn drift shows up first as variance, not as mean.
- LangChain single-agent benchmark (https://www.langchain.com/blog/react-agent-benchmarking, follow-up https://www.langchain.com/blog/benchmarking-multi-agent-architectures): a tool-calling agent on τ-bench retail "falls off sharply" with two or more distractor tool domains added, "even if that context was irrelevant to the target task"; removing the supervisor's handoff messages from a sub-agent's context improved it: "clutter in the context can have outsized impacts on agent reliability".

Agent-level outcome studies (what to expect for §9's solve-rate column):

- Frontier models on SWE-bench-class tasks: compaction or masking gives parity within ±3 pp with n = 500 and no significant gain (Complexity Trap: +1.4 and +0.4 pp for Qwen3-Coder; AgentDiet: -1.0 to +2.0 pp; ACON gpt-4.1 AppWorld 56.0 vs 56.5). Where management hurt, it was with thinking-mode Gemini Flash (-4 and -9 pp, significant).
- Weaker or long-context-fragile models gain: ACON +20 to 46% for small LMs; AgentDiet cut Gemini 2.5 Pro's step-limit failures from 66 to 26 of 300; Vending-Bench GPT-4o-mini with 10k memory beat 60k.
- Anthropic internal: context editing +29% on an agentic search eval; with memory +39%. Unverifiable.
- Context-Folding: 32k active beats 327k ReAct by 14 pp (BrowseComp-Plus) and 3 pp (SWE-bench), but after RL.

Expectation for pi-episodes §9: on solve rate, plan for parity. The honest prior from controlled coding-agent studies is a difference of a few points either way, under the noise floor of a 5-task benchmark. The places where the literature predicts a real, measurable improvement are (a) probe accuracy on facts from earlier work (Chroma focused vs full, LongMemEval), (b) run-to-run variance (Laban, τ-bench pass^k), (c) weaker models and thinking-off configurations, and (d) failure modes tied to long context (loops, step-limit hits, refusing to answer). Build the scenario so those are primary outcomes and solve rate is a gate.

## 5. Subagent and fork designs: what has been measured

- Anthropic, How we built our multi-agent research system (2025-06-13): https://www.anthropic.com/engineering/multi-agent-research-system. Orchestrator spawns clean-context subagents with written briefs. Internal research eval: Opus 4 lead + Sonnet 4 subagents beat single-agent Opus 4 by 90.2%. On BrowseComp, token usage alone explains 80% of performance variance; tool calls and model choice bring it to 95%. Agents use ~4× chat tokens, multi-agent ~15×. Explicitly: "most coding tasks involve fewer truly parallelizable tasks than research". Vague briefs ("research the semiconductor shortage") made subagents duplicate each other's searches; each brief needs objective, output format, tool guidance, boundaries. Appendix: when the lead approaches its limit it "can spawn fresh subagents with clean contexts while maintaining continuity through careful handoffs"; evaluate state-mutating agents on end state at checkpoints, not on the path. Subagents should write artifacts to a filesystem and return references "to minimize the game of telephone".
- Cognition, Don't Build Multi-Agents (2025-06-12): https://cognition.com/blog/dont-build-multi-agents. Two principles: share full agent traces, not just messages; actions carry implicit decisions, so parallel writers conflict. No measurements. Recommends a single thread plus a compressor model for long tasks.
- Cognition, Multi-Agents: What's Actually Working (2026-04-22): https://cognition.com/blog/multi-agents-working. Three findings with partial numbers. (1) A reviewer with no shared context catches an average of 2 bugs per Devin PR, ~58% severe; "this technique works best when the coding and review agents do not share any context", citing Context Rot: a clean context "makes the agent smarter because of the math of attention". (2) "Smart friend" delegation: "a reasonable 80/20 solution is to just share a fork of the full context of the primary model with the smart model"; broad questions ("what should I do?") beat narrow ones; the smart model should say "go read file X and ask again" instead of guessing. (3) Manager/child Devins: "agents assume they share state with their children when they don't"; cross-agent communication "doesn't happen by default". So: fork when the child must continue the parent's work; clean context when the child must judge it.
- Claude Code docs: a subagent "starts fresh unless it's a fork, which starts with a copy of your conversation so far" (https://code.claude.com/docs/en/how-claude-code-works, https://code.claude.com/docs/en/sub-agents, https://code.claude.com/docs/en/agent-sdk/subagents). Fork mode is on by default in interactive sessions since v2.1.232 (per https://agentpatterns.ai/patterns/multi-agent/forked-vs-fresh-subagents, citing the changelog). Prompt caching page (https://code.claude.com/docs/en/prompt-caching): a fork "inherits the parent's system prompt, tools, and conversation history exactly, so its first request reads the parent's cache"; a fresh subagent gets only the Agent tool's prompt string. No published comparison of fork vs fresh outcomes.
- LangChain, Benchmarking Multi-Agent Architectures (2025-06-10): https://www.langchain.com/blog/benchmarking-multi-agent-architectures, code https://github.com/hinthornw/mabench. gpt-4o on 100 τ-bench retail tasks with 0 to 6 distractor domains. Single agent best with ≤1 distractor, then "falls off sharply"; swarm > supervisor because the supervisor's "translation" of sub-agent output loses information; supervisor tokens flat as distractors grow, single agent's tokens grow. Fixes that recovered ~50%: remove handoff messages from the sub-agent's context; let the supervisor forward the sub-agent reply verbatim.
- Recovery-Bench (§1.8): inheriting the failed trajectory in context hurts beyond inheriting the corrupted environment. The nearest published number for the "anchoring on the parent's wrong guesses" question in §10.
- Manus (via https://www.philschmid.de/context-engineering-part-2): "If every sub-agent shares the same context, you pay a massive KV-cache penalty and confuse the model"; "share memory by communicating, don't communicate by sharing memory".

No paper or post reports a controlled fork-vs-brief comparison with turns, tokens, re-reads and anchoring measured. §10 would be the first. The literature supports these hypotheses for it: forks win on re-reads and clarifications and on first-turn cache reads; clean subagents win on independent judgment (review, audit) and on avoiding inherited wrong assumptions; brief quality dominates clean-subagent outcomes (Anthropic), so the brief the parent writes must be logged and judged too.

## Recommendations for pi-episodes

Adopt verbatim (names and formulas) so results compare with prior work:

1. Solve rate and instance cost (USD) with paired bootstrap, B = 10,000, 95% percentile CI, two-sided p, from arXiv:2508.21433 Appendix C.1. Report asymmetric CIs.
2. AgentDiet's I / O / $ / $+ / Pass% / Step / PStep, normalized to condition A = 1. Our "context tokens attended" = I with `input + cacheRead + cacheWrite`. Split overhead ($+) into fold notes, ask, fork children, compaction.
3. ACON's Peak tokens (max per-request prompt, system prompt excluded). Skip Dependency unless cheap; nobody else reports it.
4. τ-bench pass^k with k = runs per task; Laban's aptitude (P90) and unreliability (P90 - P10) once there are ≥ 5 runs.
5. KV-cache hit rate per request = cacheRead / (input + cacheRead + cacheWrite); Manus's name for it. Report the first child turn of every fork and the request after every fold separately (§1).
6. Factory's four probe types and 0-to-5 rubric dimensions for §2, plus LongMemEval's knowledge-update and abstention probe types. Pre-write gold answers; have the LLM judge grade against gold, and spot-check judge agreement with a human on ~30 probes (Chroma did >99% alignment, Factory did none).
7. Letta's penalty for extraneous memory operations as the scoring rule for §7's spurious rate.
8. Trajectory length in turns per condition, because summaries elongated trajectories by ~15% in arXiv:2508.21433 and notes may do the same.

Expectations the prior results set:

- Versus no management at all: 40 to 60% fewer accumulated input tokens and about half the cost (Complexity Trap -50 to -57% cost; AgentDiet -39.9 to -59.7% input tokens, -21 to -36% cost after overhead). Condition A already compacts, so the gap between A and B will be smaller: the Complexity Trap measured summary vs masking at 7 to 11% cost apart, and the OpenHands blog's own gain over raw is "less than half" per turn only late in the run. A 10 to 30% reduction in context tokens over A is a realistic target; more only if folds fire early and often.
- Solve rate: parity within ±3 pp for frontier models; possible loss with thinking-mode models (Gemini Flash thinking -4 / -9 pp). Treat solve rate as a non-inferiority gate, not the headline.
- Where improvement is plausible and measurable: probe accuracy on earlier facts, run-to-run variance, step-limit or loop failures, and weaker models.
- Fork vs clean subagent: expect fewer re-reads and higher first-turn cache reads for forks; expect clean subagents to do better on review-type tasks and worse when the brief is thin.

What prior evaluations got wrong, to avoid:

- One run per condition, no CI (OpenHands, Factory, Anthropic numbers, AgentDiet). MEASUREMENTS already requires 3 runs; make it 5 for anything reported as variance.
- Token counts instead of billed cost, or list price without the cache discount (Complexity Trap's Qwen costs; AgentDiet's critics note the headline is "computed from token accounting rather than invoices"). pi has `usage.cost`; use it, and also report tokens by class so provider pricing changes do not invalidate the comparison.
- "Active context 10× smaller" while tool calls doubled (Context-Folding). Always show peak context next to accumulated tokens and turns.
- Compression ratio as the target (OpenAI compact 99.3% yet lowest quality in Factory's test). Score what the agent can do after the fold, not how small the note is; §0's note-to-span ratio is a sanity check, not a goal.
- Window / threshold tuned on one scaffold and reused on another (M = 10 vs 58). pi-episodes' 2k-token fold threshold and the open-reminder cap are hyperparameters; sweep them on the pilot before the grid.
- Assuming the model will manage its own context when asked. AgentDiet's `erase` experiment found Claude 4 Sonnet and Gemini 2.5 Pro would not call it even under an explicit "only call erase" instruction. §0 (folds not called, folds in the wrong place) is therefore the first thing to measure, before any cost claim; if fold rates are near zero the rest of the grid measures nothing.
- Summaries that mask the failure signal (Complexity Trap §4.4; Factory's artifact-trail scores 2.2 to 2.5 of 5). Add an artifact probe ("which files changed?") and compare it to `git diff` from the worktree; pi-episodes already appends disk changes to the note, which is a testable advantage.
- Letting the compressing model pick what to keep with no checklist (Factory's finding that structured sections beat freeform). The note template in the prompt is that checklist; §2's human scoring against the template is the right test.
- Judging multi-agent runs by path instead of end state (Anthropic appendix). For §10 compare final worktree and tests, then count re-reads and clarifications from the transcripts.
- Reporting internal evals with no task count or definition (Anthropic 90.2%, 84%, 39%). Record n, model, date and prompt hash with every number, as MEASUREMENTS "Keeping notes" already asks.
