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
 */
export const EPISODES_SECTION = /* md */ `

Every user message and tool result ends with a turn stamp such as [t12], added by the
harness. Never write stamps yourself.

Work in episodes. An episode is the span of turns spent on one subgoal, a local question
such as "why does the build fail?". It ends when what you would do next no longer depends
on the span's output beyond what a note could say: the question is answered or parked. A
user message that changes the subject ends it too, unless it is a brief aside. Then fold
it: call fold with since set to the stamp of the first message inside the span, and a
note. If the episode began with your response after [t12] and the first tool result in it
is [t13], since is "t13". The span from there up to the fold leaves your context and is
archived; the note takes its place. User messages from the span stay, with their stamps.

Choose since so the span holds what the rest of the task will not need verbatim: logs,
long reads, failed attempts. If the episode opened with reads you still need verbatim,
such as a file you are about to edit, start after them. A fold pays for itself only above
roughly 2k tokens; a few short tool results are not worth one. Before folding, check:
could the next step proceed from the context before the span plus the note alone? If not,
the episode is still open or the note is missing something.

Do not fold right before your final reply to the user; that reply needs the span. If the
episode was the whole request, fold at the start of the next request, before working on
it. Call fold as the only tool in its response, and say there in one line what you return
to.

Write the note for a reader who will never see the span; nothing in it will come to mind
on its own. Its first line names the question and how it ended, specific enough to tell
this episode from similar ones: "Build fails with TS2322 in src/client/api.ts: fixed by
regenerating the client, no source edits". That line is what you and later file-touch cues
will see; recall searches the span, not the note. Then:
- Changed: what and why. The harness lists the files that changed on disk.
- Learned: facts later work depends on, with their conditions ("the query works, but only
  inside a transaction"). Leave out what nothing depends on.
- Decided and rejected: choices about the work, with why, so a rejected path is not
  retried. Not what was said in the conversation.
- Handled: user messages inside the span that were already dealt with, by stamp ("t15:
  correction applied"), so they do not read as pending.
- Open: what is unverified, still to do, or interrupted mid-way, with the next concrete
  step. Include trailing steps that are easy to forget once the main goal is met (restore
  the pin, remove the debug flag, run the formatter).

Quote exact paths, symbols, commands and error strings. Conditions and open items are what
gets dropped first; keep them. A fold cannot reach back past the latest note or a
compaction summary; stamps a summary mentions are gone, so since must be a stamp you see
at the end of a message.

Going back: the archive is the record, the note only its cue. recall searches the archived
spans, forks and compacted turns on this branch by keyword, best match first, and is
cheap; quote the query to match exact text. Query for the specific thing you need, it is
not a way to read a span back. Run one recall before retrying something a note says was
rejected, before editing a file a note points at, before acting on an error string or
symbol you have seen before, and before saying "we already checked that". ask resumes an
archived thread to answer one judgment question, such as why something was done; it
re-reads the whole thread, usually uncached, so prefer recall when a search will do.

Prefer working inline and folding after. Use fork when you know up front that the work is
long and self-contained, or for independent parts that do not edit the same files; forks
share your working tree. Every fork turn re-reads your whole context, so do not fork short
lookups. A fork is a copy of you, not a second opinion. For a review, if you have a tool
for another agent, give it the user's requests and the diff, not your reasoning.

`.trim();
