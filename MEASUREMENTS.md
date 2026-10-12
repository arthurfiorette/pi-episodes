# Measurements

What to measure before believing that folding beats compaction, and how. Nothing here has been run yet. The order is the order to run them in: each one only makes sense if the previous ones look fine.

Most of these need nothing but session files. Every session pi writes is a JSONL file with the full transcript; `pi-episodes` adds turn stamps, fold and fork records (on the tool results, with handle, span, token counts, files) and the `context_edit` entries that hide spans. A short script over those files gives most numbers below. The ones that need a human are marked.

The research the design borrows from measures segmentation by **agreement between observers** and judges memory by **what can be recalled later**. The same two ideas run through this list: does the model fold where a person would, and does the note let the task continue as if the span were still there.

<br />

## 1. Boundary agreement

**Question.** Does the model fold where a person would? (Post: "Can the model tell when an episode is over and where it started, without me saying so?")

**Why this first.** In the event segmentation literature, observers agree on boundary locations to a surprising degree, and people whose boundaries deviate from the group's remember less later. If the model's folds land in odd places, nothing downstream can be good.

**Method.** Human in the loop.

1. Take 5 to 10 real sessions of 50+ turns, run without the extension.
2. Mark by hand, on the stamps, where you would have folded and with which `since`. Two people, independently, if possible; their agreement is the ceiling.
3. Replay the same tasks with the extension, same model, and record every fold: the stamp it was called at and its `since`.
4. Score each model fold against the nearest human mark.

**Report.**
- Share of human boundaries the model folded within ±2 turns.
- Share of model folds that no human boundary is near (spurious folds).
- `since` error in turns, signed: positive means the model folded too little, negative that it reached back into the previous episode.
- Lateness: turns between the human boundary and the model's fold. The tokens that accumulate in that gap are the cost of noticing late.

**Pass.** Agreement with humans at or near human-to-human agreement. Lateness under three turns on median.

<br />

## 2. Note sufficiency

**Question.** Can the next step proceed from `B + fold(E)` alone? (Post: "Can the model write a note that keeps the caveats, given the template?")

**Why.** This is the post's smallest experiment, and the one the "query works" failure is about. A note that reads well but drops the condition is worse than no fold.

**Method.** Half scripted, half human.

1. After a real episode, `/fold` it.
2. Give the agent a task that depends on something inside the span: once on a fact the note should carry, once on a detail only the archive has.
3. Record what the agent does: continues correctly from the note, calls `recall` or `ask` and then continues correctly, or proceeds on a wrong assumption.

**Report.** For each probe, one of three outcomes. Per note, a human judge scores the template sections with yes or no: headline specific enough to tell this episode from similar ones, conditions kept, rejected paths named, open items present, trailing steps present.

**Pass.** No "wrong assumption" outcome on facts the note should carry. On archive-only details, the agent goes back rather than guesses.

<br />

## 3. Going back: does the agent use the archive when it should?

**Question.** Does the agent go back to the archive when it should, and not when it should not? (Post: "Does the agent go back to the archive when it should, and does surfacing notes on file touch help or just add noise?")

**Why.** The post treats going back as the system working, not as a failure. But the goal-activation model says a suspended goal is retrieved only through a cue; without one the agent will guess. The prompt names four triggers (retrying a rejected path, editing a file a note points at, a known error string, "we already checked that"). Each one is a measurable event.

**Method.** Script over session files, with a short human pass.

1. In sessions with folds, find every occurrence of a trigger after the fold: an edit to a file in a fold's file list, a tool output containing an error string from an archived span, a command that an archived span already ran.
2. For each, check whether a `recall` or `ask` with a matching query came within the next three turns.
3. Separately, list every `recall` and `ask` that no trigger preceded.

**Report.**
- Hit rate: triggers followed by a recall or ask.
- Spurious rate: recalls and asks with no trigger, and how many returned nothing.
- For the file-touch cue: how often an `[episodes]` cue in a tool result was followed by a recall or ask on that handle, versus ignored. The cue is capped at two threads per file; the ignored rate at one, two, and (temporarily uncapped) five threads tells whether the cap is right.

**Pass.** Hit rate well above a control run without the triggers in the prompt. Spurious recalls cheap enough not to matter; spurious asks rare, since each is a model call.

<br />

## 4. Cost: tokens carried, tokens written, tokens spent going back

**Question.** Is `tokens carried per turn + cost of going back` lower with folds than with compaction, at equal outcome?

**Method.** Script over session files. Three conditions on the same tasks: no extension, extension loaded, extension loaded with compaction disabled.

**Report.** Per task:
- Context tokens per request, summed over the run (what the model attends over). Pi records `input + cacheRead` on every assistant message.
- Cache writes, in tokens, and the share of requests that were a full write of the prefix. A fold should show as one write from the anchor on, not of everything.
- Tokens spent by `ask` and `fork` (recorded as `usage` on their tool results) and by compaction summaries.
- Number of folds, median span size in tokens, and the share of folds under 2k tokens (over-folding).

**Pass.** Lower summed context per task at equal outcome (measured in 5), and no fold that rewrites more than the span plus the open episode.

<br />

## 5. Outcome parity

**Question.** Does a smaller, state-shaped context make the main line reason better, or is that an intuition left over from when windows were small? (Post's first open question.)

**Why.** Everything above measures cost. This one measures whether the work is as good. Without it, a cheaper run that fails more is a loss.

**Method.** Human judged, or test suites as judge where the task has them. Same tasks as 4, both conditions, 3+ runs each because variance between runs is large.

**Report.** Task passed or not; turns to finish; number of times the user had to correct the agent. Report both the mean and the spread; one run per condition says nothing.

**Pass.** No worse than compaction on pass rate. Any improvement is a bonus, not the bar.

<br />

## 6. Fork against a clean subagent

**Question.** Does the fork anchor on the parent's wrong guesses more than a clean subagent would, and does it finish in fewer turns? (Post's last open question.)

**Method.** Same delegated task ("make it build", "find where X is defined") from the same parent state, once as `fork`, once as a clean subagent with a prompt the parent writes. Human judged, 3+ runs each.

**Report.**
- Turns and tokens to finish.
- Re-reads: files the child reads that the parent had already read.
- Anchoring: when the parent held a wrong guess at fork time, did the child repeat it? Needs tasks seeded with a wrong guess on purpose.
- Clarifications: times the clean subagent had to ask back or re-derive something the parent knew.

**Pass.** Fewer re-reads and clarifications than the clean subagent, with no rise in anchoring on seeded wrong guesses.

<br />

## 7. Postcompletion steps

**Question.** Do trailing steps survive a fold?

**Why.** The goal-activation model's postcompletion error: the step after the main goal (take the card after the cash) is the one most often forgotten, because the goal that cued it is satisfied. For an agent that is "remove the debug flag", "restore the pinned version", "run the formatter". The prompt asks for them under "Open".

**Method.** Script plus a short human pass. In sessions with folds, find spans where a temporary change was made (a `console.log`, a skipped test, a pinned dependency, a `.only`). Check whether the note lists its reversal under "Open" and whether it was reversed before the session ended.

**Report.** Listed and reversed, listed and not reversed, not listed and reversed anyway, forgotten.

**Pass.** "Forgotten" near zero. This is also a case where compaction likely does badly, so it is worth running both conditions.

<br />

## 8. Staleness

**Question.** When a file a span relied on changes later, does the agent notice before acting on the span's conclusion?

**Method.** Script. Every `recall` and `ask` result records whether a staleness line was added. For each one, check whether the agent re-read the file before acting on the thread's answer.

**Report.** Staleness lines shown, followed by a re-read; shown and ignored; conclusions acted on from a stale thread that turned out wrong (human judged).

<br />

## 9. Cache breakpoint check

**Question.** Does the moved breakpoint do what the README says?

**Why.** This is the one claim in the README that is pure reasoning about Anthropic's cache; nothing has been measured. It is cheap to check and embarrassing to get wrong.

**Method.** Script over session files, Anthropic with OAuth. Two conditions: breakpoint moved (default) and not moved (disable the handler). Same long episode, 15+ turns, then a fold.

**Report.** `cacheWrite` on the request after the fold, in both conditions, next to `cacheRead` on ordinary requests before it. Also `cacheRead` on ordinary requests in both conditions: it must not drop when the identity block loses its breakpoint.

**Pass.** Smaller write after the fold with the breakpoint moved; equal reads elsewhere.

<br />

## Keeping notes on what was found

Record results here, under the measurement, with the date, the model, the number of sessions and the number: not "it works", but "7 of 9 folds within ±2 turns of a human boundary, median lateness 2, 1 spurious; n = 4 sessions, claude-sonnet-4-5, 2026-10". A later prompt change should be checked against the same tasks.

<br />

## References

- Zacks & Swallow, *Event Segmentation*, Current Directions in Psychological Science 16(2), 2007. Boundaries are agreed on across observers; people who segment "well" remember more.
- Kurby & Zacks, *Segmentation in the perception and memory of events*, Trends in Cognitive Sciences 12(2), 2008. Boundaries as prediction failures; working memory cleared at boundaries; fine-grained segmentation gives better recall of detail than coarse.
- Altmann & Trafton, *Memory for goals: an activation-based model*, Cognitive Science 26, 2002. A suspended goal is resumed only through a cue encoded with it before suspension; cues must be obvious and prime few distractors; postcompletion error; the interruption lag.
