# Observations

A log of what was tried, what the sessions and benchmarks showed, and what changed because of it. [MEASUREMENTS.md](MEASUREMENTS.md) says what to measure; this file records what the measurements and the transcripts actually said, so a later prompt or harness change starts from the evidence instead of memory. Newest entries last. Each entry names the prompt hash from `episodes-meta` where one is known, so sessions can be matched to the prompt they ran with.

## 2026-10-14: first benchmark, prompt hash 447f84c05728 and the version after it

### Setup

- `bench/` with DeepSWE tasks, pi against pi plus pi-episodes, one attempt per task.
- Run 1: arktype only, Claude Haiku, prompt hash `447f84c05728` (the section as of `7c3a8ff`). Cancelled before the end; the transcript is still useful.
- Run 2: five tasks (arktype, aiomonitor, fd, go-git, csstree), GPT-6 Luna, a prompt one edit newer than `447f84c05728`.

### What the Haiku transcript showed

The run reached ~188k tokens of context after 42 responses without a fold. Breakdown of that context:

| Part | Tokens |
| --- | --- |
| Assistant output, almost all thinking | ~152k |
| Tool call arguments (file writes, probes) | ~22k |
| Tool results | ~34k |

Every response's output stayed in context because the whole task is one user turn, and the model's own reasoning was about 80% of what it was paying for. The prompt described what to fold as "logs, long reads, failed attempts", all tool output, and tool outputs here were small (1-9k characters). Judged by what it could see, the spans looked small.

The model considered folding exactly once, at t27 with ~85k of context, and decided against it:

> "I'm aware I've been exploring for a while and context is moderate in size, but since my design reasoning so far is captured in my own thinking, I don't need to fold anything yet."

It read fold as a way to save information, not as a way to free context. Nothing in that prompt said what a finished episode costs if it stays.

Two folds it missed:

- t43 to t48, "why does the recursive `$ref` throw?": answered (`finalize` resolves aliases eagerly), fix chosen (a lazy `narrow`), next step was to rerun a probe. About 19k tokens including one 13k thinking block. The exact shape of the prompt's own example.
- t23 to t41, research into ark internals (alias.ts, scope.ts, thunks, `lazilyResolve`) and the design built on it. None of those files were edited, the alias approach was later dropped, and once json.ts and the other files were written the design reasoning was in them. Roughly 65-70k tokens. The prompt had no way to say "planning ends when the code it led to is on disk".

Why the wording did not fire: in a benchmark the task is one user message, so "if the episode was the whole request, fold at the start of the next one" let the model read the whole feature as one episode. The prompt's cautions against folding (2k minimum, reads still needed, not before the final reply, the whole-request rule, drift, reach-back) outnumbered the one instruction to fold. And the only moment it thought about folding was the switch from planning to implementing; at the debugging boundary it went straight to the fix.

### What the five-task GPT-6 run showed

Paired per task, the episodes arm used 2.05x the tokens (geomean; input plus cache read plus cache write summed over requests). Uncached input 1.39x, output 1.42x. Where the extra went:

- 66%: larger tool results carried in context. An unbounded `grep -R` without excluding `node_modules` (45k characters, mostly minified JS), running the whole mocha suite twice (12.7k tokens each, both hitting pi's 50KB truncation), reading 500-line slices where the baseline read targeted ones.
- 25%: more requests, 252 against 198. go-git also wrote its own test file and spent about ten requests on it.
- 9%: the fixed overhead, exactly +1,517 tokens on the first request of every task (the prompt section plus four tool definitions).

The episodes arm read more before its first edit in 5 of 5 tasks. Sign test p≈0.03 one-sided, on a metric with large run-to-run variance and no within-arm variance measured.

Fold fired once in five runs; recall, ask and fork never. The one fold (arktype, `since: "t2"`, request 11, four requests before the first edit) cut context from 32.8k to 4.4k and the harness estimated it saved 1.28M tokens. Its note said "No changes yet. Open: implement all requested features, test, commit." and the model re-read ~26k characters of the same files right after. So the model folded the reads it still needed and kept the dumps it did not.

The model's visible reasoning never mentioned folding or episodes in any of the five runs. Most reasoning was encrypted or summarized, so this is weak evidence.

Test results: both arms 0% pass on every task, so outcome cannot move either way on this task set. Partial scores: aiomonitor +21 points, go-git −5, csstree −0.4, the rest equal.

Cache hit rate 94-95% in the episodes arm against 91-94% baseline; the extension does not hurt caching. The snapshot hook (`git add -A` per stamped message) cost nothing measurable.

csstree hit the 90-minute timeout with the log cut mid-JSON and no `tool_execution_end`; pi's 120s tool timeout never fired. Probably the container or pi died, not the extension. `AgentTimeoutError` is in `exclude_exceptions`, so it was never retried.

### Hypothesis that did not survive review

The first reading of the GPT-6 result was that the prompt's opening, "Work in episodes and fold each one when it ends", reads as an instruction to reorganize the workflow and so pushes the model to explore more up front, and that the fix was to wrap the section in an XML tag and open with a scope limit ("do not add exploration, file reads, tests, or planning to create episodes"). Two reviews of that proposal, one on model behavior and one on fidelity to the post, both said not to ship it:

- pi already wraps every custom section in `<name>` tags (`<episodes>…</episodes>`), so a second tag does nothing.
- A model reorganizing around folding would fold. It folded once. Nothing in the section suggests an unbounded grep or running the whole suite; those are default habits.
- "Do not add exploration…" prohibits something the model is not doing on purpose, makes the nouns more salient, and "tests" reads as "do not run tests". "These rules manage context from work you already perform" demotes the section to housekeeping, and folding is the behavior most sensitive to priority.
- "Summarize the cause instead of carrying the output" is not "fold"; a model following it writes a summary message and keeps the output.
- A fold is contiguous from `since` to now. A 45k grep in the middle of reads the model still needs cannot be folded on its own. Nothing in any prompt version targets the 66%; only bounding output at the source does.
- For the reads-before-first-edit metric, the four runs that never called fold are already a sham-tools control: prompt and tools present, mechanics inactive. What is missing is attempts, not another arm.
- "A user message that changes the subject ends it too" is the interruption cue MEASUREMENTS.md §6 depends on. "Once the code an exploration led to is written, the exploration has ended" is the post's own example (read the ORM docs, write the query, keep only the query) and the one named boundary that avoids the re-read-after-fold failure. Both proposed cuts would have lost something the post argues for.

### Prompt changes made, in order

1. Token trim (about 1,075 to 833 tokens). Each fact given one home: the section says when and why, the tool descriptions say how to call and what it costs. Three lines were cut and then put back on review because each guarded a known failure: "Query for the specific thing you need; it is not a way to read a span back" (in the recall description, after a session where the model called `recall(".")`), "Leave out what nothing depends on" (notes get longer without it, and every note is re-read on every later turn), "Conditions and open items are what gets dropped first; keep them" (the "query works" failure from the post).
2. A first paragraph on why to fold: a finished episode left in context is re-read on every later turn; fold as you go, do not wait for the context to fill. Aimed at the Haiku misreading.
3. "The span includes your own reasoning and tool-call arguments, usually its largest part; after a fold they are gone unless the note holds what they decided." The fact the Haiku run lacked. Moved next to the fold definition on review.
4. "One request usually holds several episodes: a research detour, a debugging loop, a round of probes." Aimed at the whole-request reading.
5. After the GPT-6 run and the reviews: "Work in episodes and fold each one when it ends" → "Fold each episode when it ends"; "so nothing is lost" dropped; the usual moments named ("a search or test run whose output you have finished reading; a diagnosis done and editing about to start; tests green after a fix loop"); the open-ended-exploration carve-out replaced with "A search or test run is finished once you have its answer, even mid-exploration; what stays open is the question you are still forming, not the output you have already read"; the written-code boundary reworded so it cannot read as sequencing ("The reads and searches that led to an edit are finished once the edit is made; the decisions are in the files").
6. The source stays wrapped at 90 columns and is unwrapped at load, one line per paragraph and list item. Each line break where a space would go is about one token.

The section is now about 1,010 tokens. None of these changes has been benchmarked yet.

### Harness change made

Heavy-result nudge (`heavyResultNudge`, on by default; `heavyResultTokens`, 8000). A tool result over the threshold ends with:

```
[episodes] This result is ~12k tokens. Fold the span it belongs to once you have taken what you need from it.
```

Reasoning: the prompt's boundary test is abstract and far back; a result this size is the concrete thing to fold, and the line is read at the moment the model is about to use it. It would have fired three times in the GPT-6 run, on the three results that caused most of the overrun. It names no stamp, because the one fold on record that chose its own start folded reads it still needed. A growth-based trigger ("every 30k tokens since the last fold") was considered and dropped: context size says nothing about where a boundary is, so it would land mid-subgoal most of the time and be learned as noise.

Each nudge is an `episodes-event`; `/episodes stats` reports `heavy-result nudges N, folded after M`, where followed means an applied fold within three responses whose span holds the nudged result.

### Open

- Rerun the five tasks with 3 attempts each, arms: pi, previous prompt, current prompt; then current prompt with `heavyResultNudge: false`. The runner takes two arms per job, so this is two or three jobs sharing the pi arm.
- Pick at least some tasks pi sometimes passes; at 0% in both arms, outcome cannot move.
- Treat `AgentTimeoutError` as an infrastructure error and retry it, or the time metric stays meaningless.
- Over-folding signals to watch once folds start happening: folds under 2k going up, and reads of files the just-folded span had read, within the next three responses. The second is not in the stats yet.
- The 66% from oversized tool results is not addressed by anything here. A prompt line about bounding searches and test runs would target it, but that is tool-use advice rather than episode advice and may not belong in this section.
- MEASUREMENTS.md does not mention the nudge yet.
