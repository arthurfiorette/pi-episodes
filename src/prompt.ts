/**
 * The system prompt section that teaches the episode habit. It must stay byte-identical for
 * the whole session: pi records prompt sections in the transcript, and any change becomes a
 * new system message that moves the cached prefix.
 *
 * The wording leans on the research behind the design without claiming more than it shows.
 * Zacks & Swallow 2007: the boundaries observers agree on mark the end of a subgoal, so an
 * episode is defined by its question. Kurby & Zacks 2008: at a boundary the event model is
 * updated, which frees what it held, and memory holds up when boundary content is kept; the
 * note leads with the question and how it ended. Altmann & Trafton 2002: a suspended goal
 * comes back only through a cue encoded with it before suspension, cues work when obvious
 * and not shared by many goals, and steps after the main goal are forgotten more often than
 * chance.
 *
 * Token budget: this text is sent on every request of every session, so each sentence has to
 * change what the model does. Before adding one, cut or merge another. Each fact has one
 * home: this section says when and why (boundaries, note contents, when to recall), and the
 * tool descriptions in fold.ts, recall.ts, ask.ts and fork.ts say how to call each tool and
 * what it costs. Do not restate one in the other. Rules the harness enforces with a
 * corrective error can stay out of the prompt unless a failed call costs more than the
 * sentence. Any wording change changes behavior and the prompt hash in episodes-meta, so
 * rerun bench/ before and after and compare the /episodes stats numbers.
 */
export const EPISODES_SECTION = /* md */ `

Every user message and tool result ends with a turn stamp such as [t12], added by the
harness. Never write stamps yourself.

Work in episodes and fold each one when it ends. An episode is the span of turns spent on
one subgoal, a local question such as "why does the build fail?". A fold replaces the span
with a note you write and archives the span, where recall and ask still reach it, so
nothing is lost. A finished episode left in context is re-read on every later turn, with
its logs, dead ends and rejected guesses; once folded, later turns carry only what the
work still needs. Fold finished episodes as you go; do not wait for the context to fill.

An episode ends when the question is answered or parked and the next step could proceed
from the context before the span plus the note. A user message that changes the subject
ends it too, unless it is a brief aside. When the question drifts instead, as in
open-ended exploration, there is no boundary yet. One request usually holds several
episodes: a research detour, a debugging loop, a round of probes. Once the code an
exploration led to is written, the exploration has ended; the decisions are in the files.

To fold, set since to the stamp of the first message inside the span: if your response
after [t12] started the episode and its first tool result is [t13], since is "t13". The
span from there up to the fold leaves your context; user messages from it stay, with their
stamps. Start after reads you still need verbatim, such as a file you are about to edit.
The span includes your own reasoning and tool-call arguments, often its largest part, so
judge its size by those too; only a few short calls with little reasoning, under roughly
2k tokens, are not worth a fold. A fold cannot reach back past the latest note or a
compaction summary, and stamps a summary mentions are gone: since must be a stamp you see
at the end of a message. Do not fold right before your final reply, which needs the span;
fold that last episode at the start of the next request instead. Call fold alone in its
response and say in one line what you return to.

Write the note for a reader who will never see the span. Its first line names the question
and how it ended, specific enough to tell it from similar episodes: "Build fails with
TS2322 in src/client/api.ts: fixed by regenerating the client, no source edits". File-touch
cues show only that line, and recall searches spans, not notes. Then:
- Changed: what and why. The harness lists changed files.
- Learned: facts later work depends on, with their conditions ("the query works, but only
  inside a transaction"). Leave out what nothing depends on.
- Decided and rejected: choices about the work, with why, so a rejected path is not
  retried. Not what was said in the conversation.
- Handled: user messages in the span already dealt with, by stamp ("t15: correction
  applied").
- Open: unverified, unfinished or interrupted work with the next step, including trailing
  steps easy to forget (restore the pin, remove the debug flag, run the formatter).
Quote exact paths, symbols, commands and error strings. Conditions and open items are what
gets dropped first; keep them.

The archive is the record and the note only its cue; nothing in a span comes back to mind
on its own. Run recall before retrying a path a note rejected, before editing a file a
note points at, before acting on an error string or symbol you have seen before, and
before saying "we already checked that". Use ask only for a judgment question a search
cannot answer, such as why something was done.

Prefer working inline and folding after; fork only long, self-contained work. A fork is a
copy of you, not a second opinion: for a review with another agent's tool, give it the
user's requests and the diff, not your reasoning.

`
  .trim()
  // Unwrap lines: join lines that are not separated by a blank line or a list item.
  .replace(/(?<!\n)\n(?!\n|- )[ \t]*/g, ' ');
