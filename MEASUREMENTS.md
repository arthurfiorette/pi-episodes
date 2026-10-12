# Measurements

What to measure before believing that folding beats compaction, and how. Nothing here has been run yet.

The order follows the post: try the note before asking the model to notice anything. `/fold` separates the two questions, so note quality comes before boundary detection. Cheap scripted checks come first, so a broken mechanism is not mistaken for a bad model.

Most of these need nothing but session files. Every session pi writes is a JSONL file with the full transcript; `pi-episodes` adds turn stamps, fold and fork records (on the tool results, with handle, stamp range, token counts, open items and files), the `context_edit` entries that hide spans, and the open-items reminders. A short script over those files gives most numbers below. The ones that need a human are marked.

Runs vary a lot between attempts. Unless a section says otherwise, run each condition at least 3 times per task and report the spread, not only the mean.

<br />

## 0. Fold mechanics

**Question.** Does the fold tool do what the model asked, and does the model use it as instructed?

**Method.** Script over session files with folds, real model.

**Report.**
- Rejected folds, by error (`since` made up, compacted or already folded, after the call, behind a note or summary, nothing to fold), and whether the retry that followed was correct. The errors name the earliest foldable stamp, so the retry should be right the first time.
- Folds not alone in their response.
- Folds called in the response that should have been the final reply (the prompt says not to).
- Note size in tokens and the note-to-span ratio. A note over a third of its span saved little.
- Folds of spans under 2k tokens (the prompt's threshold).
- Notes with no first line naming a question and an outcome, and notes missing an Open section where work was left.

**Pass.** Rejections rare and recovered on the first retry; no fold right before a final reply.

<br />

## 1. Cache

**Question.** Do the cache claims in the README hold?

**Why.** They are reasoning about provider behavior, not measured. Cheap to check.

**Method.** Script over session files. Same long episode, 15+ turns, then a fold. Run on Anthropic with an API key and with OAuth, each with the anchor breakpoint on (default) and off (handler disabled).

**Report.**
- `cacheWrite` on the request after the fold, both conditions, next to `cacheRead` on ordinary requests before it. With OAuth, `cacheRead` on ordinary requests must not drop when the identity block loses its breakpoint.
- For each fold, the tokens between the anchor and `since`: the extra write a fold pays when one user request holds several episodes.
- Fork child turns: `cacheRead` close to the parent prefix size on every turn after the first.
- `ask` within the cache lifetime of its thread: `cacheRead` close to the thread size.

**Pass.** Smaller write after a fold with the anchor; equal reads elsewhere; forks and warm asks read the prefix from cache.

<br />

## 2. Note sufficiency

**Question.** Can the next step proceed from `B + fold(E)` alone? (Post: "Can the model write a note that keeps the caveats, given the template?")

**Why.** This is the post's smallest experiment, and the one the "query works" failure is about. A note that reads well but drops the condition is worse than no fold.

**Method.** Half scripted, half human. After a real episode, run the same probe three ways on copies of the session: no fold, `/fold`, and pi's `/compact`. The probe is a task that depends on something inside the span: once a fact the note should carry, once a detail only the archive has.

**Report.** For each probe and condition: continues correctly from context, goes back (`recall` or `ask`) and then continues correctly, or proceeds on a wrong assumption. A human judge scores each note on the template: headline specific enough to tell the episode from similar ones, conditions kept, rejected paths named, handled user messages listed, open items with a next step.

**Pass.** On facts the note should carry, no more wrong assumptions after `/fold` than with no fold, and fewer than after `/compact`. On archive-only details, the agent goes back rather than guesses. At least 5 probes per condition.

<br />

## 3. Kept user messages

**Question.** After a fold, does a user message kept from inside the span read as already handled?

**Why.** User messages stay verbatim, but every reply to them is gone. A kept question ("why is it failing?") or request ("also add a test") can look unanswered.

**Method.** Script plus a short human pass. In sessions with folds whose spans contain user messages, check the turns after the fold: did the agent act on a kept message again (answer it a second time, redo the change)?

**Report.** Kept messages listed under the note's Handled section; kept messages re-acted on; re-acted on although listed.

**Pass.** Re-acting near zero when the note lists the message.

<br />

## 4. Postcompletion steps and the open-items reminder

**Question.** Do trailing steps survive a fold, and does the reminder help?

**Why.** Altmann and Trafton describe the step after the main goal (take the card after the cash) as one people forget "more often than chance", because the goal that cued it is satisfied. For an agent: remove the debug flag, restore the pinned version, run the formatter. The prompt asks for them under Open, and the harness repeats Open items on the next prompt after a fold.

**Method.** Script plus a short human pass. Find spans where a temporary change was made (a `console.log`, a skipped test, a pinned dependency, a `.only`). Check whether the note lists its reversal under Open and whether it was reversed before the session ended. Run with `episodes.openReminder` on and off, and on the same tasks with pi's compaction instead of folds.

**Report.** Listed and reversed, listed and not reversed, not listed and reversed anyway, forgotten; per condition.

**Pass.** "Forgotten" near zero with the reminder on, and lower than with compaction.

<br />

## 5. Boundary agreement

**Question.** Does the model fold where a person would? (Post: "Can the model tell when an episode is over and where it started, without me saying so?")

**Why.** Zacks and Swallow report that "observers generally agree on the locations of event boundaries", and that older adults whose segmentation deviated from the group's remembered less of what they watched. Whether that carries over to an agent's own work is the open question; if the model's folds land in odd places, notes and recall are working on the wrong spans.

**Method.** Offline, on fixed transcripts, so the model and the humans judge the same sessions.

1. Take 5 to 10 real sessions of 50+ turns, run without the extension, with stamps added.
2. Give annotators the episode definition from the system prompt, word for word. Zacks and Swallow note that "observers adjust the temporal grain of their segmentation based on explicit instructions", so without the same definition their disagreement measures the instructions, not the model. Two annotators, independently; their agreement is the ceiling.
3. Annotators mark, on the stamps, where they would fold and with which `since`.
4. For the model: at each stamp k, send the transcript up to k with the system prompt and ask whether to fold now, and with which `since`.

**Report.**
- Share of human boundaries the model marked within ±2 turns.
- Share of model boundaries no human boundary is near.
- `since` error in turns, signed: positive means the model folded too little, negative that it reached back into the previous episode.
- Lateness: turns between the human boundary and the model's first "fold now". Tokens that accumulate in that gap are the cost of noticing late.

**Pass.** Agreement with humans at or near human-to-human agreement; median lateness under three turns.

<br />

## 6. Interruptions and returning

**Question.** When the user changes the subject mid-episode, is the episode parked with its next step, and picked up later?

**Why.** Altmann and Trafton's interruption lag: people resume well when they link the suspended goal to a cue before switching. The prompt asks the model to fold at a subject change with the next step under Open, and to say what it returns to.

**Method.** Scripted user turns on real tasks: interrupt an episode at a random point with an unrelated question, answer it, then say "back to it".

**Report.** Folded at the interruption, with the next concrete step under Open; resumed at the right step without redoing finished work; resumed after first recalling or asking the archive.

<br />

## 7. Going back

**Question.** Does the agent use the archive when it should, and not when it should not? (Post: "Does the agent go back to the archive when it should, and does surfacing notes on file touch help or just add noise?")

**Why.** Without a cue, Altmann and Trafton's model does not guess; it falls back on "planning from scratch". For an agent that is re-reading files and re-running commands an archived span already holds. The prompt names four triggers for going back; each is a measurable event.

**Method.** Script over session files, with a short human pass.

1. Find every trigger after a fold: an edit to a file in a fold's file list, a tool output containing an error string from an archived span, a command an archived span already ran, a rejected approach being tried again.
2. Check whether a `recall` or `ask` with a matching query came within the next three turns.
3. Count re-derivation: reads and commands that repeat an archived span's work with no recall before them.
4. List every `recall` and `ask` that no trigger preceded.

**Report.**
- Hit rate: triggers followed by a recall or ask.
- After a compaction: recalls that hit compacted-turn threads (`cp-`), and whether those hits held something the summary had dropped.
- Re-derivation count, per fold.
- Spurious rate: recalls and asks with no trigger, and how many returned nothing.
- File-touch cue: followed by a recall or ask on that handle, or ignored. The cue is capped at two threads per file; the ignored rate at caps of one, two and five threads shows whether the cap is right. Separately for spans that only read the file.

**Pass.** Hit rate well above a control run without the triggers in the prompt; re-derivation lower than with compaction. Spurious asks rare, since each is a model call.

<br />

## 8. Staleness

**Question.** When a file a span relied on changes later, does the agent notice before acting on the span's conclusion?

**Method.** Script. Every `recall` and `ask` result records whether a staleness line was added. For each one, check whether the agent re-read the file before acting on the thread's answer.

**Report.** Staleness lines shown and followed by a re-read; shown and ignored; conclusions acted on from a stale thread that turned out wrong (human judged).

<br />

## 9. Cost and outcome against compaction

**Question.** Is `tokens carried per turn + cost of going back` lower with folds than with compaction, at equal outcome? And does a smaller, state-shaped context make the main line reason better, or is that an intuition left over from when windows were small? (Post's first open question.)

**Why.** Everything above measures parts. This measures the whole, and whether the work is as good: a cheaper run that fails more is a loss.

**Method.** Three conditions on the same tasks: no extension, extension with compaction enabled, extension with compaction disabled. Tasks must be long enough that both folds and compaction happen: at least twice the compaction threshold in total tokens. Human judged, or test suites as judge where the task has them. At least 5 tasks, 3 runs each.

**Report.** Per task and condition:
- Context tokens per request, summed over the run (what the model attends over); pi records `input + cacheRead` on every assistant message.
- Cache writes in tokens, and the share of requests that were a full write of the prefix.
- Tokens spent by `ask`, `fork` and compaction summaries.
- Number of folds, median span size, share of folds under 2k tokens.
- Task passed or not; turns to finish; corrections the user had to make.

**Pass.** Lower summed context per task at an equal or better pass rate.

<br />

## 10. Fork against a clean subagent

**Question.** Does the fork anchor on the parent's wrong guesses more than a clean subagent would, and does it finish in fewer turns? (Post's last open question.)

**Method.** Same delegated task ("make it build", "find where X is defined") from the same parent state, once as `fork`, once as a clean subagent with a prompt the parent writes. Human judged, 3+ runs each.

**Report.**
- Turns and tokens to finish, split into input, cache read, cache write and output.
- Re-reads: files the child reads that the parent had already read.
- Anchoring: when the parent held a wrong guess at fork time, did the child repeat it? Needs tasks seeded with a wrong guess on purpose.
- Clarifications: times the clean subagent had to ask back or re-derive something the parent knew.

**Pass.** Fewer re-reads and clarifications than the clean subagent, with no rise in anchoring on seeded wrong guesses.

<br />

## Keeping notes on what was found

Record results here, under the measurement, with the date, the model, the number of sessions and the number: not "it works", but "7 of 9 folds within ±2 turns of a human boundary, median lateness 2, 1 spurious; n = 4 sessions, claude-sonnet-4-5, 2026-10". A later prompt change should be checked against the same tasks.

<br />

## References

- Zacks & Swallow, *Event Segmentation*, Current Directions in Psychological Science 16(2), 2007. Observers generally agree on boundary locations; the agreed coarse boundaries mark the end of subgoals; older adults whose segmentation deviated from the group's remembered less; the grain of segmentation follows instructions.
- Kurby & Zacks, *Segmentation in the perception and memory of events*, Trends in Cognitive Sciences 12(2), 2008. Event models are updated at boundaries, which frees information from working memory; recall holds up when boundary content is kept; fine-grained segmentation goes with better recall of detail than coarse.
- Altmann & Trafton, *Memory for goals: an activation-based model*, Cognitive Science 26, 2002. A suspended goal is resumed only through a cue encoded with it before suspension; cues work when obvious and not shared by many goals; without one, people plan from scratch; postcompletion steps are forgotten more often than chance; the interruption lag is when the cue can be formed.
