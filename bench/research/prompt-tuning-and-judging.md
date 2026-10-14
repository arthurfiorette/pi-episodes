# Prompt tuning with the benchmark, and judging trajectories

Research report for `bench/PLAN.md` phase 1. Covers: comparing system-prompt variants, LLM-as-judge for the five targets in `MEASUREMENTS.md`, post-hoc self-explanation probes, automatic "should have folded" detection, and the scorecard. Ends with concrete recommendations. Sources are inline; arXiv ids are given where they exist.

Local facts this report relies on:

- `src/prompt.ts`: one system-prompt section (`EPISODES_SECTION`), byte-stable per session; tool descriptions in `src/fold.ts`, `src/recall.ts`, `src/ask.ts`, `src/fork.ts`.
- Fold results carry `FoldDetails` (`src/archive.ts`): `handle, since, until, firstEntryId, lastEntryId, messages, tokens, headline, open, keptUserTurns, files, treeAfter`. Recall/ask results start with staleness lines of the form `<handle> predates changes to: <paths>. Conclusions about those files may no longer hold.` (`src/recall.ts:100`). The open-items reminder is a `custom_message` with `customType: "episodes-open"` (`src/reminder.ts`).
- pi's session file records the system prompt sections and tool declarations as system messages, and `context_edit` entries are branch-relative, so branching before a fold shows the span as the model saw it (`~/dev/pi/packages/coding-agent/docs/session-format.md`, "ContextEditEntry" and "Tree Structure").

<br />

## 1. Comparing prompt variants

### Paired evaluation and how many runs

Treat each comparison as an experiment on the same scenario set. Miller, *Adding Error Bars to Evals* (Anthropic, 2024, arXiv:2411.00640) gives the formulas: compute the per-item difference between variants, take its standard error (paired SE), and cluster the SE when items come in groups. Paired SE is smaller than the unpaired one whenever scores on the same item are positively correlated, which they are here (a hard scenario is hard under both prompts). Clustering matters: in their examples, clustered SEs were up to 3x the naive ones. Report pairwise difference, SE, 95% CI and correlation (their Table 5), not two means.

How many runs: Bjarnason, Silva, Monperrus, *On Randomness in Agentic Evals* (2026, arXiv:2602.07150) collected 60,000 SWE-Bench-Verified trajectories. Single-run pass@1 moved 2.2 to 6.0 points depending on which run you looked at, with SD above 1.5 points even at temperature 0; trajectories diverge within the first few percent of tokens. Their power table: detecting a 2-point improvement at p<0.05 with 80% power needs about 9 runs per agent; a 1-point improvement needs 36. SWE-rebench (arXiv:2505.20411) runs each model 5 times and reports SEM and pass@5. tau-bench (arXiv:2406.12045) reports pass^k (all k runs pass) as the reliability number. *Consistency Amplifies* (arXiv:2603.25764, 10 tasks x 5 runs) found task-interpretation errors are deterministic: when Claude misread a task it failed 5/5, when it read it right it passed 5/5. So between-task variance dominates, and more scenarios buy more than more runs per scenario.

Consequences for pi-episodes:

- The primary metric for prompt tuning is continuous (summed context tokens, folds per 100 turns), not pass/fail, so power is better than the binary numbers above suggest. Pass rate is a guardrail, not the thing being optimized.
- Unit of analysis: (scenario, run index). Both variants run the same scenario set with the same run count. Compute the paired difference per scenario (mean over runs), then a cluster-robust SE across scenarios. With 5 scenarios you have 4 degrees of freedom; only large effects will clear. Plan 8 to 10 scenarios x 3 runs per model for a prompt decision, and run a power calculation from pilot variance before the full grid (Miller gives the formula; the agentic-randomness paper gives a table).
- Report pass^3 next to mean pass rate.

### Holdout scenarios

DSPy's GEPA docs separate `trainset` (used to rewrite the prompt), `valset` (used to pick the winner) and a final test set that influenced neither (https://dspy.ai/current/getting-started/gepa-optimization/). The same split applies to hand tuning: the person editing `prompt.ts` reads transcripts from tuning scenarios only; held-out scenarios are seen as numbers. Shankar et al., *Who Validates the Validators?* (UIST 2024, arXiv:2404.12272) document "criteria drift": graders change their criteria while grading. For us: freeze the rubric and the scenario set before a comparison run; change them only between rounds, and re-judge everything after a rubric change.

Holdouts should differ in surface features (different parser family, different file names, different trap kind) so a prompt that mentions nothing scenario-specific cannot overfit by accident. After a prompt is accepted, a holdout may move into the tuning set and a new holdout is written.

### Versioning with hashes

Pi already persists the prompt: the first request writes a system message with every section and tool declaration, and later changes patch sections by name (session-format.md, "SessionMessageEntry"). So a prompt id can be derived from any session file after the fact. Define

    prompt_id = sha256(EPISODES_SECTION + "\n" + join(tool descriptions for fold, recall, ask, fork))[:12]

and have the runner write it into the run manifest and `bench/prompts/<prompt_id>.md` (full text, once). A git commit of `prompt.ts` is not enough: tool descriptions live in other files, and the hash also guards the "byte-identical for the whole session" requirement in `prompt.ts`. Langfuse-style versions plus labels (https://langfuse.com/docs/prompt-management/features/prompt-version-control) is the same idea with a server; not needed here.

### Tools

| Tool | What it does | Fit for pi-episodes |
| --- | --- | --- |
| promptfoo (https://github.com/promptfoo/promptfoo; now part of OpenAI per its README) | Matrix of prompts x test cases, assertions (`llm-rubric`, `select-best`, `g-eval`, `trajectory:goal-success`), CI gates | Built around prompt in, output out. Our unit is a multi-hour pi session with a repo. Could wrap only the judge stage (judge inputs as test vars). A small TypeScript script over JSONL does the same with less ceremony. Skip. |
| DSPy MIPROv2 (Opsahl-Ong et al. 2024) | Bayesian search over instructions and demos | Needs hundreds of rollouts; ours cost dollars and hours each. Skip. |
| DSPy GEPA (Agrawal et al., ICLR 2026, arXiv:2507.19457; https://dspy.ai/api/optimizers/GEPA/overview/) | Samples full trajectories (reasoning, tool calls, tool outputs), reflects in natural language on (prompt, trajectory, score, feedback), proposes edits, keeps a Pareto front. Up to 35x fewer rollouts than GRPO, +10% over MIPROv2; `auto="light"` tries about 6 candidates. | The optimizer loop still needs tens of rollouts; not affordable while a rollout is an hours-long session. What transfers is the reflection step done by hand: give a strong model (prompt, extract of a failing trajectory, judge verdicts) and ask for a diagnosis and one proposed edit; a human applies it and it enters the comparison as one candidate. The DSPy docs say it directly: "Learning each model's quirks by hand is slow, and the work doesn't transfer." Optimized prompts are per model. |
| Anthropic prompt improver (console, https://claude.com/blog/prompt-improver) | Rewrites a prompt with CoT sections, XML, examples; reports +30% on a classification test | Designed for single-turn task prompts. It would lengthen the section (paid on every request) and restructure it. Skip for the agent prompt; usable to draft judge prompts. |
| OpenAI evals API graders (https://developers.openai.com/api/docs/guides/graders) | `string_check`, `text_similarity`, `score_model`, `label_model` (labels + `passing_labels`), `python` | OpenAI-hosted; we need judges from more than one provider. Skip the service, keep the shape: a `label_model` grader with `passing_labels=["PASS"]` is the binary-judge primitive. |

### Prompt changes that help one model and hurt another

Evidence that this is normal, not an edge case:

- Sclar et al., *Quantifying Language Models' Sensitivity to Spurious Features in Prompt Design* (ICLR 2024, arXiv:2310.11324): meaning-preserving format changes move accuracy by up to 76 points (LLaMA-2-13B), median spread 7.5 points across tasks, GPT-3.5-turbo median 6.4 and max 56.2. "Format performance only weakly correlates between models."
- PromptBridge (arXiv:2512.01420): "model drifting", a prompt tuned on one model losing effectiveness on another, "is both common and severe".
- Vendor guides say so about tool triggering specifically, which is what fold/recall are. OpenAI's GPT-4.1 guide: the model follows instructions "more closely and more literally", "a single sentence firmly and unequivocally clarifying your desired behavior is almost always sufficient", and migration is expected (https://developers.openai.com/api/docs/guides/latest-model/gpt-4.1). Anthropic's Claude 4.x best practices: "above and beyond" behavior must now be requested explicitly; Opus 4.5 "is more responsive to the system prompt ... if your prompts were designed to reduce undertriggering on tools or skills, Claude Opus 4.5 may now overtrigger"; later Opus notes say the model "does not silently generalize an instruction" and that emphatic "You MUST use this tool" prompting causes overtriggering (https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices and per-model pages).

Expect: the same sentence makes one model fold too often and another not at all. The benchmark must therefore report behavior counts per model, and the acceptance rule must be per model (section 5). Do not fork the prompt per model until the data shows a specific conflict; when it does, keep a small per-model override map (one sentence, keyed by model id) that is hashed into `prompt_id`.

<br />

## 2. LLM-as-judge for agent trajectories

### Findings to design around

Agreement and biases. Zheng et al., *Judging LLM-as-a-judge with MT-Bench and Chatbot Arena* (NeurIPS 2023, arXiv:2306.05685): GPT-4 agreed with humans above 80%, the human-human level, after mitigations. Biases found: position (most judges favor the first candidate; swap and keep only consistent verdicts), verbosity (a "repetitive list" attack fooled every judge, GPT-4 least), self-enhancement, and weak math/reasoning (failure 14/20 default, 6/20 with CoT, 3/20 with a reference answer). Panickssery, Bowman, Feng (NeurIPS 2024, arXiv:2404.13076): self-preference is linearly correlated with self-recognition; fine-tuning for recognition increases the bias. A follow-up (arXiv:2504.03846) finds harmful self-preference persists exactly when the judge model is itself wrong as a generator. Dubois et al., *Length-Controlled AlpacaEval* (COLM 2024, arXiv:2404.04475): regressing out length raised correlation with Chatbot Arena from 0.94 to 0.98 and cut gameability by verbosity prompts.

Rubric form. Husain's guide (https://hamel.dev/blog/posts/llm-judge/, FAQ at https://hamel.dev/blog/posts/evals-faq/): binary pass/fail with a written critique; Likert scales make "3 vs 4" a judgment call, need larger samples, and annotators sit in the middle; track gradual progress as several binary checks. Plan 100 to 200 human labels per failure mode when the judge replaces humans at scale. Cook et al., TICK (arXiv:2410.03608): decomposing an instruction into YES/NO checklist questions raised exact agreement with human preferences from 46.4% to 52.2% over direct scoring, and giving the checklist to human raters raised their inter-annotator agreement (Krippendorff's alpha 0.194 to 0.256).

Trajectories. Zhuge et al., *Agent-as-a-Judge* (ICML 2025, arXiv:2410.10934): on DevAI (55 tasks, 365 hierarchical requirements), a judge that can inspect the workspace reached about 90% alignment with the human consensus, against about 70% for a transcript-only LLM judge, at up to tens of minutes per task. The transferable point: give the judge the artifacts (files on disk, test output), not just the text. Deshpande et al., TRAIL (Patronus, arXiv:2505.08638): 148 human-annotated OpenTelemetry traces from GAIA and SWE-bench with a taxonomy (reasoning, system execution, planning/coordination); the best model, Gemini 2.5 Pro, scored 11%, and the paper's finding is that "modern long context LLMs perform poorly at trace debugging". Do not hand a judge a 200k-token session and ask where it should have folded. Cut a window around one decision and ask one binary question.

Gaming. Zhu et al., *Establishing Best Practices for Building Rigorous Agentic Benchmarks* (arXiv:2507.02825): a do-nothing agent passes 38% of tau-bench airline tasks (unsolvable tasks are "passed" by leaving state unchanged), and WebArena's LLM judge accepts an empty reply on tasks labeled N/A. Every judge here needs a null-agent check: run condition A (plain pi, which never folds) through the same rubrics; any rubric that gives plain pi a pass on a fold-quality question is broken. tau-bench itself grades by comparing database state to a goal state, which is the model for our (d) and (e): check disk and session state, not prose.

Sub-goal progress. AgentBoard (NeurIPS 2024, arXiv:2401.13178) scores a progress rate against annotated subgoals with regex matching. Our scenarios are scripted with known steps, so progress per step is a script check, not a judge.

Calibration with a small human set. Treat each judge as a binary classifier: label a set by hand, report confusion matrix and Cohen's kappa, pick the judge prompt and model with the best kappa, and keep the labeled set as a regression test for the judge. At our scale (tens of sessions, each yielding a handful of items per rubric) 30 to 50 labeled items per rubric is realistic, which is enough to catch a broken rubric but not to certify a 5-point agreement difference; say so in the scorecard. If the item count grows to hundreds, prediction-powered inference (Angelopoulos et al. 2023; PRECISE, AAAI 2026, arXiv:2601.18777) combines the small gold set with the large judged set into an unbiased estimate with error bars.

Judge configuration that follows from the above:

- Judge model is never the model under test (self-preference). Use one Anthropic and one OpenAI judge on the calibration set; use the better one for the run and report disagreement counts.
- Temperature 0, one binary question per call, JSON out: `{ "answer": "PASS" | "FAIL", "evidence": "<verbatim quote>", "reason": "<one line>" }`. Reject a verdict whose `evidence` string does not occur in the input (cheap faithfulness check).
- Inputs are extracts, not whole sessions; tool results truncated to head and tail (2k chars each); the judge is told what was truncated.
- No scales, no weighted composites. Several binary checks per target.

### Rubrics for the five targets

Common extract for a fold `F` (from `FoldDetails` on the fold tool result and the session entries):

- `note`: the `note` argument of the fold call.
- `span`: messages between `firstEntryId` and `lastEntryId`, rendered `[tNN] role: text`, tool results truncated.
- `before`: the 3 stamped messages before `since`; `after`: the 3 assistant turns after the fold result.
- `siblings`: headlines of the other folds in the session.
- `script`: for scripted scenarios, the step the fold belongs to, with its `must_carry`, `rejected`, `trailing`, `user_messages` lists (section 4 defines the scenario fields).

(a) Boundary quality: fold at a topic boundary, not mid-episode.

| Check | How | Inputs |
| --- | --- | --- |
| a1 fold follows an end event | Script: the scenario's end event for that step (test pass, user topic change) occurred at stamp e; fold call stamp f satisfies 0 <= f - e <= 3 (lateness) | `script`, stamps |
| a2 `since` is the episode start | Script: `since` within +-2 of the step's first stamp; sign of the error recorded (MEASUREMENTS #5) | `script`, `since` |
| a3 no fold before the end event | Script: no fold with `since` inside a step whose end event has not occurred | `script`, all folds |
| a4 nothing in the span was needed verbatim | Script: no `read` of a file in `files` and no repeated command (normalized) in `after` without a preceding `recall` | `files`, `after` |
| a5 judge (unscripted sessions only) | "Was the question in the note's first line answered or parked before this fold? Quote the message that answers or parks it." | `note` first line, `span` last 5 messages, `after` |

a1 to a4 are scripts; a5 is the only model call, and only when there is no script.

(b) Note sufficiency.

| Check | How | Inputs |
| --- | --- | --- |
| b1 headline names question and outcome | Judge: "Does the first line name a question and how it ended? Quote it." | `note` line 1 |
| b2 headline is distinguishable | Judge: "Given these sibling headlines, could a reader tell this episode apart from each of them?" | `note` line 1, `siblings` |
| b3 facts carried, per fact | Judge, one call per `must_carry` item: "Is this fact present in the note: (i) with its condition, (ii) without the condition, (iii) absent? Quote." Three-way, reported as two binaries (present; condition kept) | `note`, one fact with its condition |
| b4 rejected paths named | Judge, one call per `rejected` item: "Does the note say this approach was rejected and why?" | `note`, one item |
| b5 handled user messages listed | Script: each stamp in `keptUserTurns` appears in the note's Handled section | `note`, `keptUserTurns` |
| b6 trailing steps under Open | Script: regex for each `trailing` marker in `details.open` | `open`, `trailing` |
| b7 functional probe (the one that matters) | Judge on the probe continuation: "Given the probe task and the next 5 turns, did the agent (A) continue correctly from context, (B) call recall/ask then continue correctly, (C) proceed on a wrong assumption? Quote the turn that decides it." | probe prompt, next 5 turns with tool calls, the fact the probe depends on and its truth |

b1 to b6 are diagnostic (which part of the template fails); b7 is the outcome MEASUREMENTS #2 asks for. Note length is never an input to a verdict; MEASUREMENTS #0 already penalizes note/span ratio.

(c) Going back when a trigger occurred.

| Check | How | Inputs |
| --- | --- | --- |
| c1 trigger detection | Script (MEASUREMENTS #7): edit to a path in any fold's `files`; a tool result containing an error string that occurs in an archived span; a normalized command that an archived span ran; a user message naming a handle or a path in `files` | session, archive |
| c2 recall or ask within 3 turns | Script: a `recall`/`ask` call whose query shares a token (path, symbol, error code) with the trigger | trigger text, next 3 assistant turns |
| c3 re-derivation when no recall | Script: a `read` of the same path or the same command within 3 turns | same |
| c4 proceeded correctly from memory | Judge, only when c2 and c3 are both false: "The agent acted without consulting the archive. Does its action contradict anything in this note's Learned or Decided section? Quote." | trigger, `note` sections, next 3 turns |
| c5 rejected path retried | Judge, one call per `rejected` item: "Do these turns attempt the approach described here?" | `rejected` item, next 5 turns after the trigger |
| c6 spurious recall | Script: `recall`/`ask` with no c1 trigger in the previous 3 turns, and whether it returned 0 matches (`RecallDetails.total`) | session |

(d) Temporary change reverted.

| Check | How | Inputs |
| --- | --- | --- |
| d1 trap present at fold time | Script: the scenario's trap marker (`it.only`, `console.log("DEBUG`, a pinned version string) is in the working tree at `treeAfter` | snapshot at `treeAfter` |
| d2 listed under Open | Script: trap keyword matches `details.open` | `open` |
| d3 reminder shown | Script: the next `episodes-open` custom message contains the handle | session |
| d4 reverted by session end | Script: marker absent from the final working tree, and the final test run does not use `.only` | final tree |
| d5 attempted revert failed | Judge, only when d4 fails and there is an edit to the trap file after the fold: "Did these edits try to remove the marker?" | the edits |

Classification into listed/reverted cells is arithmetic on d2 and d4 (MEASUREMENTS #4). No judge is needed for the normal path.

(e) Acted on a stale conclusion.

| Check | How | Inputs |
| --- | --- | --- |
| e1 staleness line shown | Script: a recall/ask result text matches `^(ep|fk)-[0-9a-f]{8} predates changes to: (.+)\.` | tool results |
| e2 re-read before acting | Script: a `read` of any listed path occurs before the next `edit`/`write`/`bash` that touches that path | next turns |
| e3 action relied on the stale thread | Judge, only when e2 fails: "The thread said X about file P; P changed since. Does any action in these turns assume X? Quote the action and the line of X it assumes." | staleness line, the recall/ask result lines, next 3 assistant turns, current content of P (head) |
| e4 the stale assumption was wrong | Script when the scenario planted the change (the scenario knows what changed and whether X still holds); judge otherwise, with e3's quote and the current file | scenario, file |

Cost: per session, roughly (folds x 8) + (triggers x 1) + (staleness lines x 1) judge calls, each 3 to 15k input tokens. Tens of calls per session, not hundreds.

<br />

## 3. Post-hoc self-explanation

### What the evidence says

- Turpin et al., *Language Models Don't Always Say What They Think* (NeurIPS 2023, arXiv:2305.04388): biasing features (answer always "(A)" in the few-shot examples, a suggested answer) changed answers, dropping accuracy by up to 36%, and the explanations never mentioned the feature. Explanations were "plausible yet misleading".
- Lanham et al., *Measuring Faithfulness in Chain-of-Thought Reasoning* (Anthropic, 2023, arXiv:2307.13702): truncating or corrupting the CoT often leaves the answer unchanged, so the stated reasoning was produced after the answer was already determined; faithfulness varies by task, and "as models become larger and more capable, they produce less faithful reasoning on most tasks we study".
- Chen et al., *Reasoning Models Don't Always Say What They Think* (Anthropic, 2025, arXiv:2505.05410; https://www.anthropic.com/research/reasoning-models-dont-say-think): Claude 3.7 Sonnet verbalized a hint it had used 25% of the time, DeepSeek R1 39%; outcome-based RL raised faithfulness then plateaued; unfaithful CoTs tended to be longer.
- Chen et al., *Do Models Explain Themselves? Counterfactual Simulatability* (ICML 2024, arXiv:2307.08678): humans reading GPT-3.5/4 explanations could not reliably predict the model's answers on related counterfactual inputs; explanations were imprecise. Dehghanighobadi et al., *Can LLMs Explain Themselves Counterfactually?* (EMNLP 2025): when models write their own counterfactual explanation, their prediction on that counterfactual often disagrees with the explanation.
- Binder et al., *Looking Inward* (2024, arXiv:2410.13787): models predict some simple properties of their own behavior better than another model can, but this does not hold for more complex behaviors.

A fold decision is exactly the kind of thing these results apply to: a choice influenced by many features of a long context, explained afterward in a sentence. Two extra problems are specific to pi-episodes. First, at the end of a run the span around turn 12 is folded or compacted, so the model answering "why didn't you fold at t12?" cannot see t12; it reconstructs from the note. Second, the question itself is a hint (Turpin's "suggested answer"): it tells the model that not folding was the wrong call.

### Protocol: replay, forced choice, counterfactual, repeat

The usable version measures behavior at the decision point instead of asking for an explanation. Pi's session tree makes it cheap: branch from the entry before the assistant message at stamp k; the branch sees the same system prompt, tools and messages the model saw, including unfolded spans (context edits are branch-relative). The prefix is shared with the original run, so Anthropic cache reads apply.

For each decision point k in a set D (scripted boundaries, observed folds, and two random non-boundary stamps per session as controls):

1. P1, forced choice, N=5 samples at the run's temperature: append a user message "Decide now, in one line: fold (give since) or continue. Do not do anything else." Record the fraction that says fold, and the `since` values. Compare with what the original run did at k. 5/5 "continue" at a scripted boundary means the definition in the prompt does not cover this case; 2/5 means the decision is a coin flip and the prompt is underdetermined there; 5/5 "fold" with the original run continuing means the failure was elsewhere (the model had another plan in flight; look at its thinking block at k if present).
2. P2, counterfactual on the prompt: same branch point, but the system section replaced by a minimal-pair variant (one sentence changed) via a system-message patch, then P1 again. This measures sensitivity of the decision to one sentence without rerunning the session. The cache is lost for that branch; accept it. Compare fold fractions across variants at the same k.
3. P3, explanation after the fact, with state restored: show the model its actual next action at k and ask "Which sentence of the episodes section were you following or setting aside, and what in the context made you do that? Quote both." Count which sentences get named across runs. Treat as a hint list for the human doing the prompt edit, never as a measurement. Discard answers whose quote is not in the context (same check as the judge).
4. Controls: P1 at non-boundary stamps must mostly say "continue"; if the probe says "fold" everywhere, the probe wording is biased and its boundary results mean nothing.
5. Repeat across the 3 runs of the same scenario at the equivalent decision point (the script's event, located by the detector in section 4). Report "P1 fold fraction at boundary e: 11/15 across 3 runs" next to the behavioral number "folded within 3 turns of e in 1/3 runs".

Cost per decision point: P1 is 5 short completions on a cached prefix; P2 is one full prefix write per variant; P3 is one completion. Choose |D| per session around 6 to 10.

Report probe results in their own scorecard column, labeled as probes. They never enter the accept/reject rule.

<br />

## 4. Automatic "should have folded" points

### Event segmentation and dialogue segmentation

Zacks and Swallow (2007) and Kurby and Zacks (2008) (already cited in MEASUREMENTS.md) place boundaries at subgoal ends and show that the grain follows instructions. Kumar et al. (Cognitive Science 2023) show Bayesian surprise from a language model predicts human boundaries in story listening. Michelmann et al., *Large language models can segment narrative events similarly to humans* (arXiv:2301.10297; Behavior Research Methods 2025): GPT-3 boundaries were closer to the human consensus than individual annotators were. Panela et al. (Communications Psychology 2025, https://www.nature.com/articles/s44271-025-00359-7): GPT-4 at temperature 0 produced boundaries that humans agreed with more than they agreed with each other. So an LLM given the episode definition verbatim is a defensible reference segmenter, with the caveat that it is itself a judge and needs the same calibration.

Dialogue topic segmentation: TextTiling (Hearst 1997) scores lexical cohesion across a sliding window and places boundaries at depth minima; dialogue variants replace the lexical score with coherence models (Xing and Carenini 2021; DialSTART arXiv:2305.02747), evaluated by Pk and WindowDiff. SuperDialseg (EMNLP 2023, arXiv:2305.08371) found ChatGPT with a trivial prompt beat the unsupervised methods on two of three datasets. Def-DTS (ACL Findings 2025) reports GPT-4 label agreement with gold of kappa 0.43 to 0.49 on open-domain dialogue, 0.98 on a synthetic concatenation set. Lexical cohesion is a poor fit for agent transcripts: tool outputs share vocabulary (file names, test names) across episodes, so cohesion stays high across a subgoal end. Skip TextTiling as ground truth.

### Cheap signals in a pi transcript

These are event-structure heuristics that can be scripted over session files and that map onto the prompt's own definition of an episode end:

1. Status flip: a bash result matching a fail pattern (`error TS\d+`, `FAIL`, non-zero exit) for a normalized command, followed by a result for the same command matching a pass pattern. The pass is the end event. This is the "build loop" boundary.
2. Topic change: a user message that shares no identifier (path, symbol, error code, handle) with the last 5 tool calls. The prompt says this ends the episode unless it is a brief aside; "aside" is detectable as the next user message resuming the previous identifiers within 2 turns.
3. Working-set shift: the set of paths touched in a 5-turn window has Jaccard similarity below 0.2 with the previous window. This is TextTiling on file paths instead of words, and robust to log noise.
4. Assistant goal statement after a pass ("Now I will", "Next,"): weak and model-specific; do not use.

### Ground truth for the scripted benchmark

In our benchmark the user turns are scripted and each step's end event is designed in. The ground truth is therefore the script plus a detector that locates the stamp in the actual run. Scenario format fields:

    steps:
      - id: parsers
        prompt: "Implement NodeParser for X and Y with tests."
        end_event: { kind: tests_pass, command: "npx jest test/x" }   # detector 1
        must_carry: [{ fact: "...", condition: "..." }]
        rejected: ["..."]
        trailing: ["remove it.only in test/x.test.ts"]
      - id: aside
        prompt: "Unrelated: what does Config.expose do?"
        end_event: { kind: user_topic_change }                        # detector 2
        aside: true

The detector gives the expected end stamp e and start stamp s for each step; MEASUREMENTS #5's metrics (hits within +-2, lateness, signed `since` error) are computed against (s, e). Add boundaries per 100 turns for both script and model to show over- and under-segmentation. Validate the detectors once on a handful of sessions against a human, and against the LLM segmenter (same definition), and record the agreement; after that, the detectors run alone. Reserve the LLM segmenter and human annotators for unscripted real sessions (MEASUREMENTS #5 as written).

<br />

## 5. Reporting: the prompt scorecard

Kohavi's experimentation practice (Kohavi, Tang, Xu, *Trustworthy Online Controlled Experiments*, 2020; survey at https://ai.stanford.edu/~ronnyk/2009controlledExperimentsOnTheWebSurvey.pdf): one overall evaluation criterion that drives the ship decision, guardrail metrics that must not degrade, everything else for debugging; and a decision rule written before the experiment. Husain: no composite scores ("3.2 to 3.7" tells nobody what changed). Public eval reports that do this well: tau-bench's leaderboard shows pass^1 to pass^4 per model; SWE-rebench shows resolved %, SEM and pass@5 from 5 runs; AgentBoard shows success, progress rate and grounding accuracy side by side; Miller's Table 5 shows the paired difference, SE, 95% CI and correlation per eval; Langfuse's experiment view shows per-item outputs of two prompt versions side by side with scores.

Scorecard contents, one per (candidate prompt, baseline prompt) pair:

1. Header: `prompt_id` old and new, the diff of the section text, models and thinking levels, scenario ids (tuning vs held-out), runs per cell, dates, judge model ids, judge kappa on the calibration set, pi and pi-episodes versions.
2. Primary metric, per model: summed context tokens per task (input + cacheRead over all requests), paired difference with 95% CI, and the per-scenario differences (because effects are task-level).
3. Guardrails, per model, each with its margin stated in advance: pass rate (paired difference CI must not go below the margin), pass^3, turns, cost, wall time, compaction events, rejected folds, spurious recalls, traps forgotten (d-cells), stale conclusions acted on (e3 fails).
4. Behavior counts per 100 turns, per model: folds, folds under 2k tokens, recalls, asks, forks, re-derivations, triggers hit (c2 / c1), reminder shown.
5. Judge pass rates per rubric item with n, per model, tuning and held-out separately.
6. Probe column: P1 fold fraction at scripted boundaries and at controls, labeled as probes.
7. Decision: accept, reject, or "insufficient runs" with the run count a power calculation says is needed. Rule: accept only if the primary improves on every model (CI excludes zero) or improves on some and is flat on the rest, and no guardrail crosses its margin on any model, on the held-out scenarios as well as the tuning ones. A change that helps one model and hurts another is rejected or becomes a per-model override, never a silent average.

Store the scorecard as markdown next to the run manifests, and append the summary line MEASUREMENTS.md asks for ("7 of 9 folds within +-2 turns ... n = 4 sessions, model, date") under the relevant measurement.

<br />

## Recommendations for pi-episodes

### Judge rubrics

```yaml
judge:
  model: not the model under test; calibrate claude and gpt judges on 30-50 hand labels per rubric, report kappa
  temperature: 0
  output: { answer: PASS|FAIL, evidence: verbatim quote, reason: one line }
  reject_if: evidence not a substring of the input
  inputs: extracts only; tool results cut to 2k head + 2k tail

a_boundary:               # scripted unless the session is unscripted
  a1_after_end_event:  script, 0 <= fold_stamp - end_stamp <= 3
  a2_since_at_start:   script, |since - start_stamp| <= 2, signed error kept
  a3_no_early_fold:    script
  a4_nothing_needed_verbatim: script, no read of fold.files / repeated command in next 3 turns without recall
  a5_question_closed:  judge, unscripted only; inputs: note line 1, last 5 span messages, next 3 turns

b_note:
  b1_headline_names_question_and_outcome: judge; inputs: note line 1
  b2_headline_distinct: judge; inputs: note line 1, sibling headlines
  b3_fact_present / b3_condition_kept: judge per must_carry item; inputs: note, the fact + condition
  b4_rejected_named: judge per rejected item; inputs: note, the item
  b5_handled_listed: script, keptUserTurns in Handled
  b6_trailing_under_open: script, regex on details.open
  b7_probe_outcome: judge, A continue | B went back then correct | C wrong assumption;
                    inputs: probe prompt, next 5 turns, the fact and its truth

c_going_back:
  c1_trigger: script (file in fold.files edited; archived error string reappears; archived command rerun; handle/path named by user)
  c2_recall_within_3: script, query shares a path/symbol/error token with the trigger
  c3_rederived: script, same read or command within 3 turns
  c4_contradicts_note: judge only if !c2 && !c3; inputs: trigger, note Learned+Decided, next 3 turns
  c5_rejected_retried: judge per rejected item; inputs: item, next 5 turns
  c6_spurious: script, recall/ask with no trigger in previous 3 turns; record total == 0

d_reverted:
  d1_trap_present_at_fold: script on snapshot treeAfter
  d2_listed_under_open: script
  d3_reminder_shown: script, episodes-open message names the handle
  d4_reverted_at_end: script on final tree
  d5_attempt_failed: judge only if !d4 and the trap file was edited after the fold

e_staleness:
  e1_line_shown: script, /^(ep|fk)-[0-9a-f]{8} predates changes to: /
  e2_reread_before_acting: script
  e3_relied_on_stale: judge only if !e2; inputs: staleness line, result lines, next 3 turns, head of the file now
  e4_assumption_wrong: script when the scenario planted the change, else judge with e3's quote
```

Null check for every rubric: condition A sessions must score FAIL on b, c, d2/d3 and have no items for a and e; otherwise the extractor or rubric is wrong.

### Probe protocol

1. Decision points per session: scripted end stamps, observed fold stamps, two random non-boundary stamps.
2. Branch the session before the assistant message at each point (same prompt bytes, same model and thinking level, cached prefix).
3. P1: "Decide now, in one line: fold (give since) or continue." 5 samples. Record fold fraction and `since`.
4. P2: one-sentence prompt variants at the same point, P1 again. Report per-variant fold fraction. This is the cheap way to test wording before a full rerun.
5. P3: show the actual action, ask which sentence it followed or set aside, with quotes. Hint list only.
6. Controls must say "continue"; otherwise discard the probe results for that session.
7. Aggregate across the 3 runs per scenario; print next to the behavioral metric. Never in the accept rule.

### Prompt-variant comparison procedure

1. Freeze: scenario set (tuning + held-out), rubrics, judge prompts, judge model, decision rule, margins. Write them into the run manifest before any session runs.
2. Hash: `prompt_id` for baseline and candidate; store full texts.
3. Run: same scenarios, same models, same run count for both prompts, interleaved in time (A1 B1 A2 B2) so provider drift lands on both.
4. Score: scripts first (sections 2 and 4), then judges on extracts, then probes.
5. Analyze: per-model paired differences across scenarios, cluster-robust SE across scenarios, 95% CI; pass^3 next to pass rate; held-out reported separately.
6. Decide by the rule in section 5. If "insufficient runs", the scorecard says how many more.
7. Reflect (GEPA's useful half, by hand): for the worst-scoring rubric items, give a strong model the prompt, the extract, and the verdicts, ask for a diagnosis and one proposed edit; a human picks at most one or two edits per round; each becomes the next candidate.
8. After acceptance: rotate one held-out scenario into tuning, write a new held-out, append the one-line result to MEASUREMENTS.md.

### What to skip, and why

- DSPy MIPROv2/GEPA as an optimizer loop: each rollout is an hours-long session; the loop needs tens to hundreds. Keep only the reflection step.
- promptfoo, OpenAI evals, Langfuse: built around prompt-in/output-out or hosted on one provider; our unit is a pi session plus a repo, and judges must span providers. A TypeScript scorer over JSONL is smaller.
- Anthropic prompt improver on the agent section: it lengthens and restructures; the section must stay short and byte-stable.
- Likert scales and composite scores: lower agreement, more samples, nothing actionable (Husain; TICK).
- Whole-session judging ("where should it have folded?"): long-trace reasoning is where judges are weakest (TRAIL, 11% for the best model). Use scripts for localization and judges for one binary question on an extract.
- The same model as judge for its own runs (Panickssery et al.).
- End-of-run "why didn't you fold at t12?": the model cannot see t12 any more, and the question is a hint (Turpin). Use the replayed forced choice instead.
- TextTiling on transcripts: tool logs defeat lexical cohesion; the script knows the boundaries anyway.
- A full Agent-as-a-Judge agent: its gain comes from reading the workspace, which d and e get from snapshots and the final tree at zero model calls.
- Prediction-powered inference: only worth it past a few hundred judged items per rubric.
