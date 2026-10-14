<p align="center">
   <b>Using this package?</b> Please consider <a href="https://github.com/sponsors/arthurfiorette" target="_blank">donating</a> to support my open source work ❤️
  <br />
  <sup>
   Help pi-episodes grow! Star and share this amazing repository with your friends and co-workers!
  </sup>
</p>

<br />

<p align="center" title="My take on subagents, forks and collapsing context">
  <a href="https://arthur.place/subagents-forks-collapsing-context">
    <img src="https://raw.githubusercontent.com/arthurfiorette/pi-episodes/main/assets/cover.jpg" width="640" alt="A red thread winds through a landscape of papers, maps, and filing drawers." />
  </a>
</p>

# Pi Episodes

**Fold finished work out of the context instead of compacting it.** A [pi](https://github.com/earendil-works/pi) package that lets the agent close an episode, such as a build loop, into a short note while the full span stays archived, searchable and askable.

> [!NOTE]
> This package implements the post **[My take on subagents, forks and collapsing context](https://arthur.place/subagents-forks-collapsing-context)**. The post makes the argument, the research behind it and the open questions; this README covers how the package behaves.

Compaction summarizes the whole session at once, when the window fills. `pi-episodes` asks the agent to summarize one piece of work when that work ends: "the build passes, where was I?". The span leaves the context, a note takes its place, and the agent can still search it or question it later. The same archive backs `fork`, which runs a copy of the agent with its current context instead of a subagent that starts from an empty prompt. Pi's own compaction stays as the fallback.

The terms, as in the post: an **episode** is one span of work around a local question. A **fold** replaces a finished episode with a short **note** plus a **handle** that points back to the archived span. A **fork** runs a copy of the agent with the parent's current context. **recall** searches the archive without a model call, and **ask** puts one question to an archived thread.

**Requirements:** Node.js 22.19+ and pi 1.1+. [The post](https://arthur.place/subagents-forks-collapsing-context) · [Get started](#get-started) · [How it works](#how-it-works) · [Tools](#tools) · [Prompt caching](#prompt-caching) · [Limitations](#limitations) · [Measurements](MEASUREMENTS.md)

<br />

## Get started

1. Install the package:

   ```sh
   pi install npm:pi-episodes
   ```

2. Start pi and work as usual. The agent sees four new tools and a short system prompt section that explains when to use them.

3. To try the note format before trusting the model to notice boundaries on its own, fold by hand after a finished loop. `/fold` lists the turns that can still be folded, newest first with a preview; you pick where the span starts and the agent writes the note. `/fold t13` skips the list. The run ends on the fold. Without a dialog to pick in (print mode), the agent picks the span:

   ```text
   /fold
   /fold t13
   ```

   `/episodes` lists what is archived on the current branch, and `/episodes stats` shows what the folds did to it (see [Numbers](#numbers)).

4. Then give it a task that depends on something inside the fold, and watch what it does with the note: carry on from it, go back with `recall` or `ask`, or guess. That is the smallest experiment the post suggests, and [MEASUREMENTS.md](MEASUREMENTS.md) builds from there.

If you try it, [open an issue](https://github.com/arthurfiorette/pi-episodes/issues) with what the agent did with its notes. How it feels after a week of real work says more than any benchmark so far.

<br />

## How it works

Every user message and tool result gets a **turn stamp** such as `[t12]`, appended as its own text block when the message is saved. Stamps are written once and never edited, so they never change bytes that are already in the prompt cache. They are for the model, which names them in `since`; the transcript hides them.

When an episode is done, the agent calls `fold(since: "t13", note: "...")`, where `t13` is the first stamped message inside the episode. If that is a tool result, the span starts at the response that made the call, so a tool call never loses its result. From there up to the fold call, the span leaves the model's context:

| In the span | After the fold |
| --- | --- |
| Assistant responses and tool results | Removed from context, kept in the session file |
| User messages | Kept verbatim with their stamps, so a mid-episode correction still reads as one; pastes over 4,000 characters are cut, with a pointer to the archive |
| Extension messages | Removed |
| The fold call and its result | Kept; the result is the note |

The harness extends the note with what changed on disk during the span, the stamps of the user messages that stayed, and a handle such as `ep-1a2b3c4d` that points at the archive. Disk changes come from a working tree diff, so files a shell command generated are listed too; files ignored by git are not.

Nothing is deleted. A fold appends `context_edit` entries to the session, which only change what the model sees from then on; `/tree`, exports and the session file still hold the full span. A fold cannot reach back past the previous note or a compaction summary, so notes on one line never contain each other. A summary can still mention old stamps; folding from one is refused with the earliest stamp that can be folded from, so the retry is right the first time.

On screen, the folded messages stay where they were. What marks the fold is its own block (`▸ ep-1a2b3c4d t13-t27  4 messages, ~41k tokens archived`, with the note behind ctrl+o), a notification, and the footer status. The range is the stamps the span covered, so you can see which turns left the model's context. See [Limitations](#limitations) for why the span itself does not collapse.

A fold happens when the main goal of an episode is met, which is when trailing steps ("remove the debug flag") and parked work are most easily forgotten. So on the next prompt you send after a fold, the harness adds one short message listing the open items of the notes folded since the last such reminder, newest first and capped at about 300 tokens. It is appended once, never edited, so it does not disturb the prompt cache. Turn it off or change the cap in pi's `settings.json`:

```json
{ "episodes": { "openReminder": false, "openReminderMaxTokens": 300 } }
```

<br />

## Tools

| Tool | What it does | Cost |
| --- | --- | --- |
| `fold(since, note)` | Replaces the span starting at `since` with `note` and archives it. | One tool call. With Anthropic, the cache is rewritten from the newest fold note or user message before the span (see [Prompt caching](#prompt-caching)). |
| `recall(query)` | Searches the archived spans, forks and compacted turns on the current branch: tool outputs, the agent's own messages and reasoning, tool arguments. Results are ranked with BM25+ ([MiniSearch](https://github.com/lucaong/minisearch)): messages holding every word first, in any order, rare words such as error codes weighing more than common ones, with prefixes and small typos tolerated on plain words but never on codes or paths. A `"quoted"` query or `regex: true` matches exact text per line instead. Returns the best line of each match with its handle and turn. With a handle, it searches that thread on any branch. Matches past the limit (30 by default, 200 at most) are written to a file next to the fork transcripts, so a broad query costs a path, not the context. | No model call. |
| `ask(handle, question)` | Resumes an archived fold or fork with everything it held, asks one question, returns only the answer. Compacted turns cannot be asked: they filled the window when they were compacted. | One model call over the thread's context, cached if the provider still has it. |
| `fork(task)` | Runs a copy of the agent, starting from its current context, until the task is done, and returns its final note plus what changed on disk. Tool calls go through the parent's tools, hooks and permissions. | The child's prefix is the parent's, so it reads from the parent's cache while that is alive; each child turn re-reads the whole prefix at the cached price, and parallel forks each write their own tail. |

Two cues help the agent go back when it does not know it should:

- **File touch:** when `read`, `edit` or `write` touches a file that a folded span or fork changed or used, the result names the thread, at most the two newest ones, once for each thread and file. It fires on edits after the change is made, and not at all for files touched through the shell; spans that only read a file trigger it too.
- **Staleness:** `recall` and `ask` start their result with the files a thread relied on that have changed since it was archived.

`fork` is meant for long work that continues the agent's own, such as making the build pass. Inside, the fork folds its own finished episodes the same way, so a long build loop does not stay in its context either; its result lists those folds, and the archive becomes a tree: the fork's thread holds what it saw at the end, and each fold inside it is a thread of its own. It is deliberately not a reviewer: a review is useful because it does not share the author's assumptions. The other half of the post, a separate agent consulted on purpose and handed the user's requests without the agent's reasoning, is not built here; the prompt only tells the model how to brief one if it has such a tool.

While a fork runs, a widget above the editor shows its turn, elapsed time and current tool. `ctrl+shift+e` or `/forks` opens an overlay with the forks started in this pi process, running or finished, and the child's transcript as it grows: tab switches fork, arrows scroll, esc closes. After a restart, `/episodes`, `recall` and `ask` still reach earlier forks; the overlay does not.

<br />

### Compacted turns

Pi's compaction replaces the oldest turns with a summary. With `pi-episodes`, those turns become one more archived thread, `cp-1a2b3c4d`, holding what the summary replaced as the model saw it (spans folded before stay in their own threads). `recall` searches them like folds and forks, so an exact error string the summary left out can still be found; `ask` cannot resume them, since they filled the context window. The file-touch cue covers the files pi's compaction recorded as modified.

The summary is pi's text and cannot name that handle, so right after a compaction the harness adds one short message saying where the compacted turns went. Compaction has just rewritten the whole prompt, so it costs no cache. Turn it off with `{ "episodes": { "compactionNotice": false } }`.

<br />

## Prompt caching

Each request reads and refreshes only its longest matching cache entry. During a long episode, the entry where the episode started is no longer the longest match, so it expires, and the fold that ends the episode would rewrite everything before it.

With Anthropic, `pi-episodes` keeps a cache breakpoint on the newest fold note or user message, whichever is later. A fold cannot start before the latest note, so that is the closest point before the next fold that is already known; the fold rewrites the cache from there on. When one user request holds several episodes, the anchor sits on that request and a fold also rewrites the episodes before it in the same request; how much that costs in practice is measurement 1 in [MEASUREMENTS.md](MEASUREMENTS.md). With an API key, pi leaves one of the four breakpoints free and it is used. With OAuth all four are taken, so the breakpoint of the required "You are Claude Code" block moves instead. Anthropic caches tools, then system, then messages, and the system prompt's own breakpoint already covers that block, so nothing that was cached before stops being cached.

`ask` and `fork` send the same session id, prompt, tools and thinking settings as the main thread, so their message prefixes match it; see [Limitations](#limitations) for what of pi's request pipeline they skip.

<br />

## Numbers

The footer shows context per request as a small graph of the last 16 requests, next to what is archived on the branch:

```text
episodes ▃▄▅▆▇▂▃▄▅▆▂▃ 2 folded (~41k), 1 fork(s)
```

Each bar is the context one main-thread request was sent with, scaled to the largest bar shown. The bar after a fold is green and the one after a compaction is yellow, so the drops can be told apart.

`/episodes stats` prints the rest for the current branch, a line per thing that happened:

```text
context per request  ▃▄▅▆▇▂▃▄▅▆▂▃▄▅▆▇▂▃
folds 2, median ~18k, notes ~1k (1 span picked by you)
fold errors 1, next fold succeeded after 1
context ~41k folded, ~380k fewer tokens sent since, compactions 0
cache missed after fold avg ~24k, anchor placed 2/2, anchor to span start avg ~3k
recall 3 (1 empty), ask 1, stale 1 (re-read 1)
cues 2, followed 1 (1 read-only)
forks 1, 6 turns, $0.12
added by the extension ~2k (stamps ~1k, cues ~0, reminders and notices ~1k), prompt ~1k per request
```

Token counts are estimates (about four characters a token), except the request sizes and the cache miss after each fold (input plus cache write, so it compares across providers that do and do not report cache writes), which come from the provider's usage. The anchor lines only appear with providers that take cache breakpoints, such as Anthropic. "Fewer tokens sent" counts each fold's span minus its note on every later request, until a compaction. A cue is followed when a `recall` matching that thread, or an `ask` of it, comes within the next three responses.

The numbers are read from the session entries alone, so older and resumed sessions show them too. Most come from the records already on the tool results; what has no record of its own is written as `episodes-event` entries (fold errors with their cause, and each file-touch cue), and an `episodes-meta` entry at session start records the version, a hash of the prompt and tool descriptions, pi's version and the settings. Pi never sends these entries to the model. Scripts outside pi can compute the same numbers from a session file:

```ts
import { episodeStats, statsLines } from 'pi-episodes/stats';

const stats = episodeStats(branchEntries, cwd);
```

To measure what the cache anchor saves, turn it off with `{ "episodes": { "cacheAnchor": false } }`. [MEASUREMENTS.md](MEASUREMENTS.md) says which of its questions these numbers answer and which still need a person.

<br />

## What is stored where

| Data | Location |
| --- | --- |
| Stamps, notes, fold and fork records, open-item reminders, compaction notices | The session file: on the messages and tool results themselves, plus a marker entry per applied fold and a custom message per reminder or notice. Compacted-turn threads are derived from pi's compaction entries; nothing extra is stored |
| Measurement events and run metadata | The session file, as `episodes-event` and `episodes-meta` custom entries, which are never sent to the model |
| Fork transcripts | `<session>.episodes/<handle>.json` next to the session file, or memory for `--no-session` |
| Recall overflow | `<session>.episodes/recall-<time>-<query>.txt`, or the OS temp directory for `--no-session` |
| Recall search index | Memory only: built on the first ranked `recall` of a session from the archive, then added to as threads are archived |
| Working tree snapshots | A private git index and object store in the OS temp directory, using the repository's objects read-only; removed when the session ends. The repository's index, stash and `.git/objects` are never written |

<br />

## Limitations

- Prompting is the only way the model learns the habit; there is no training behind it. Expect folds to be late, early or missing caveats until the prompt is tuned against real sessions. [MEASUREMENTS.md](MEASUREMENTS.md) lists what to measure, in order.
- A snapshot (`git add -A` and `git write-tree` against the private index) runs in the background for every stamped message, and the next tool call waits for it. Unchanged files are not hashed again, but large untracked files are, every time they change.
- `git add -A` runs the repository's clean filters, so with Git LFS it writes into `.git/lfs/objects` and can be slow on large files. Changes inside submodules show only as the submodule having changed.
- Snapshots only live as long as the session. After a restart, a fold that reaches back past it lists the files that `read`, `edit` and `write` touched instead of a diff, and older threads get no staleness notes. Outside a git repository that is always the case.
- The disk diff is the working tree's, not the agent's. Files you edit in another window while an episode runs are listed in its note as changed. Parallel forks share one working tree the same way.
- Forks run without pi's compaction or run-level retry, so `fork` refuses to start when the context is over 70% full. A fork is stopped after 30 minutes (`episodes.forkTimeoutMs` in pi's settings). A stopped or aborted fork still returns its record, so `recall` and `ask` reach what it did. The transcript is written after every turn, so a crash mid-fork keeps the file, though nothing in the session points at it yet.
- A fork runs its tools through pi's `executeTool`, which reaches only callable tools. Tools the parent declares but only the model can call, such as `codemode`, stay declared (so the cache matches) but return an error in the fork, and the child is told which ones up front.
- Requests made by `ask` and `fork` go through pi's model registry, not the main agent loop. They skip other extensions' `context`, `before_provider_request` and `before_provider_headers` hooks, pi's attribution headers and the `blockImages` setting. Extensions that rewrite requests or must add headers do not apply to them, and the prefix only matches the main thread's when none are in use.
- Inside a fork, `fork` is unavailable. A fork can `fold` only its own turns, not the parent's it started from. Its folds are kept in the fork's transcript file, as threads of their own that `recall` and `ask` reach under their `ep-` handle; they get no working-tree diff of their own, since the fork's result carries one for all of its work.
- `!` command output inside a span cannot be removed by pi's context edits and stays in context.
- Stamps are part of the saved messages. The transcript hides them on user messages and on tool results whose tool has a renderer of its own; tools that use pi's default rendering still show them on resumed sessions, and so do session pickers.
- **Folded messages do not collapse in the transcript**, the way a subagent's work shows as one block. Pi's TUI rebuilds the transcript from the session entries and ignores `context_edit`, which only shapes the model's view. Extensions can render their own tool calls, custom messages and custom entries, but cannot hide, dim or re-render earlier user, assistant or tool messages, and the chat container is not exposed. Collapsing the span needs a change in pi: render a run of omitted entries as one expandable row, rebuild the chat when a `context_edit` entry is appended, and ideally let the edit carry a label such as the fold's handle. Pi's own overflow recovery omits failed attempts with the same mechanism and leaves them on screen too, so the change is useful on its own. Not sent as a PR yet.

<br />

## Acknowledgements

The design follows [the post](https://arthur.place/subagents-forks-collapsing-context), and through it the research it leans on: Event Segmentation Theory (Zacks & Swallow 2007; Kurby & Zacks 2008) and the goal-activation model (Altmann & Trafton 2002). [MEASUREMENTS.md](MEASUREMENTS.md) turns each into something to measure. The cover image is the post's.

Several details of `fork` were taken from [pi-subagents](https://github.com/nicobailon/pi-subagents) by Nico Bailon, after comparing the two: the live view of a running child (its fleet inspector overlay and status widget), the wall-clock timeout, writing the child's transcript as it grows rather than at the end, and showing tokens and cost on the result card. `pi-episodes` does not depend on it or register its tools. The two make different bets: a pi-subagents child is a full pi session with its own system prompt and agent definition, while a fork is a copy of the running agent that keeps the parent's prompt, tools and folded view byte for byte, so its requests hit the parent's prompt cache. If you want agents with their own prompts, background runs, chains or worktree isolation, use pi-subagents.

<br />

## Contributing

1. Use Node.js 22.19+ (`.nvmrc` has 24) and pnpm 12, then install dependencies with `pnpm install`.
2. Run `pnpm test-types`, `pnpm test` and `pnpm lint-ci`. The session tests run the extension inside a real pi session against pi's faux provider, so no API key is needed.
3. Run `pnpm build` and load the result with `pi -e .` to try it by hand.

<br />

## License

[MIT](LICENSE).
