# Benchmark plan for pi-episodes

Working plan. Subagents read this before starting; the sections "Context", "Goal" and "Constraints" are the shared ground. "Status" is updated by the coordinator as phases finish.

## Context

- **pi** is a coding agent (CLI + TUI + SDK), source at `~/dev/pi`, published as `@earendil-works/pi-coding-agent@1.1.0`. Extensions are TypeScript modules loaded with `pi -e <path>` or installed with `pi install <path>`. Docs: `~/dev/pi/packages/coding-agent/docs/*.md` (`sdk.md`, `extensions.md`, `cli.md`, `cli-integration.md`, `json.md`, `session-format.md`, `settings.md`, `compaction.md`).
- **pi-episodes** (`~/dev/pi-episodes`, package `pi-episodes`) is an extension that replaces compaction-by-default with episodes: the model stamps turns, calls `fold(since, note)` when an episode of work is finished, which removes the span from context and archives it; `recall(query)` greps the archive; `ask(handle, question)` resumes an archived thread for one answer; `fork(task)` runs a copy of the agent with the parent's context. Pi's compaction stays on as a last resort. Read `~/dev/pi-episodes/README.md` and `~/dev/pi-episodes/MEASUREMENTS.md` (what we want to measure, numbered 1 to 9). Design source: `~/dev/place/src/content/blog/subagents-forks-collapsing-context.mdx`.
- The only lever we have to make pi-episodes work better is its prompt (`~/dev/pi-episodes/src/prompt.ts`) and tool descriptions. The benchmark must therefore double as a way to compare prompt variants.
- Session files: pi writes a JSONL per session (`docs/session-format.md`); every assistant message carries `usage` (input, output, cacheRead, cacheWrite, cost). pi-episodes adds turn stamps, fold/recall/ask/fork tool results with details, and `context_edit` entries. The SDK (`createAgentSession`) can drive a session programmatically; `~/dev/pi-episodes/test/session.test.ts` shows the pattern with pi's faux provider.

## Goal

A benchmark that answers: with the same model, same skills, same everything, does pi + pi-episodes finish the same long coding work with fewer tokens, fewer turns, more predictable results, and at least the same correctness as plain pi 1.1.0? And secondarily: how often does the model fold, recall, ask, fork, and where, so prompt changes can be compared.

- **Conditions**: A = plain pi (compaction on, default). B = pi + pi-episodes (compaction still on, as a last resort). Nothing else differs.
- **Models**: a swappable list (several providers; Anthropic and OpenAI models at least, plus thinking levels). Same scenarios, same charts, per model.
- **Repeated runs**: models are nondeterministic; one run tells nothing. The design must say how many runs, how to report spread, and how to compare conditions without being fooled by luck.
- **Repo under test**: `~/dev/ts-json-schema-generator` (vega/ts-json-schema-generator), TypeScript, ~55 NodeParsers and matching TypeFormatters that all extend the same interfaces. The task shape we want is "implement a goal that splits into sub-goals, with build/test loops", not "fix this one bug". Full test suite takes about 10 minutes (lots of fixtures, including vega-lite). Hours-long benchmark runs are acceptable; optimize later.
- **Scenarios**: long sessions. Two or more goals chained in one session so the second reuses what the first learned (and so folds nest: a big fold of goal 1, then goal 2). Probes at the end that depend on earlier work, and traps (temporary changes that must be reverted) are wanted; see MEASUREMENTS.md.
- **Outputs**: per model and condition: pass rate, turns, wall time, tokens (input, cacheRead, cacheWrite, output), cost, variance across runs; counts and timing of fold/recall/ask/fork; compaction events. Plus trajectory-level judgments (LLM as judge, with the coordinator doing the classification, not the user) and a post-run probe where the model is asked why it did or did not fold/recall at given points, as a diagnostic for prompt tuning (note: self-explanations are not reliable evidence; treat as hints).
- Running the repo in a git worktree per trial is fine.

## Constraints

- Never modify `~/dev/pi`; never run `npm run build`/`npm test` there; it has no `node_modules`, do not install there. Read-only reference.
- `~/dev/pi-episodes`: pnpm, TypeScript, biome (`pnpm lint-fix`, `pnpm test-types`, `pnpm test`, `pnpm build`). Do not commit. Do not stage files.
- Temp dir: `/private/var/folders/qn/39h52ty90358d4l9tn8362700000gn/T/opencode`.
- `~/dev/ts-json-schema-generator` is the user's clone; do not modify its working tree. Clone or worktree elsewhere for experiments.
- No API keys are configured for benchmarking yet; nothing should be run against a paid model in this phase. Use pi's faux provider for any harness tests.
- Writing style for reports: concise, concrete, sourced (URLs or file paths). No marketing prose. Say what to adopt and what not to, with reasons.

## Layout

Everything for the benchmark lives under `~/dev/pi-episodes/bench/`: this plan, `research/`, `DESIGN.md`, the runner source, scenarios, and results. The coordinator (main session) cannot fold its own context, so it delegates investigation, implementation and review to subagents and keeps plans and findings in files here.

## Phases

1. Research (parallel subagents; reports in `bench/research/*.md`): methodology.md, context-evals.md, harnesses.md, tasks.md, prompt-tuning-and-judging.md, practitioners.md (blogs, GitHub repos, X/HN/Reddit threads).
2. Design doc `bench/DESIGN.md`: methodology, metrics, scenario format, statistics, runner architecture, what is forked/reused.
3. Implement `bench/` runner and scenario 1 (+ held-out checks) in pi-episodes; harness tests with faux provider.
4. Pilot run on one model (user supplies key), fix, then full grid.
5. Review pass by subagents.

## Phase 3 work split

`bench/DESIGN.md` is the spec. Modules live in `bench/src/`, subcommands in `bench/src/commands/<name>.ts`, tests in `bench/test/`. Each implementation subagent owns the files listed for it and does not edit others' files; shared types go in `bench/src/types.ts` (scaffold) and may be extended by appending, never by changing existing fields. Run `pnpm lint-fix`, `pnpm test-types` and `pnpm bench:test` before finishing; fix only errors in your own files and report the rest.

| Owner | Files |
|---|---|
| scaffold | `package.json` scripts, root `tsconfig.json` include, `.npmignore`, `bench/src/{types,config,scenario,log,cli}.ts`, `bench/src/commands/*.ts` stubs, `bench/test/fixtures/mini-chain/`, `bench/config/*.json`, `.gitignore` entries |
| I1 repo+checks | `bench/src/{repo,checks}.ts`, `bench/src/commands/{validate,check}.ts`, `bench/scenarios/*`, tests for checks and validate |
| I2 session+plan+run | `bench/src/{session,plan,faux}.ts`, `bench/src/commands/run.ts`, `bench/test/scripts/*`, self-tests 1 to 4 and 9 |
| I3 analysis | `bench/src/{jsonl,metrics,stats,report,charts}.ts`, `bench/src/commands/report.ts`, self-tests 5, 7, 8 |
| I4 judge | `bench/src/judge.ts`, `bench/src/commands/judge.ts`, self-test 10 |
| I5 integration | wires `run` to `repo`, `checks`, `metrics`; end-to-end faux run on `mini-chain`; `bench/README.md` |

## Status

- 2026-10-13: phase 1 started.
- 2026-10-14: phase 2 done: `bench/DESIGN.md` written (pre-registered endpoints and decision rules, three chains spelled out, trial lifecycle, metrics, statistics, judging, phase-2 probe, runner modules and CLI, faux self-tests, budget, implementation checklist). Next: phase 3a runner core.
- 2026-10-14: phase 3 integration (I5) done. `bench/src/hooks.ts` wires `run` to `repo.ts` (reference clone and `node_modules` template once per run, trial setup and seal, snapshots, `final.diff`, `final-tree.tar.gz`, teardown honoring `--keep`), `checks.ts` (step and final checks, `escaped_tree` from the session JSONL, probe answers, `checks.json`) and `metrics.ts` (`metrics.json` written after the category is merged). `--provider faux` reads `bench/config/models.faux.json`; `--scenarios` accepts ids under `bench/scenarios/`, the self-test chains under `bench/test/fixtures/`, and paths; `bench check` resolves scenario dirs through the run's manifest. The faux end-to-end run (`run`, `report`, `check`, `--resume`) is `bench/test/e2e.test.ts`; `bench --help` lists the six commands with descriptions; `bench/README.md` written. Tests: 72 in `pnpm bench:test` (12 files), all green; `pnpm test`, `pnpm test-types`, `pnpm lint`, `pnpm build` green. Validation: all three scenarios have the three-round gate green with suite counts (sealed 374 / 376 / 375 for `fn-utils` / `expr-parsers` / `mapped-types`, restored 379, about 61 to 66 s per suite run). Not done: `compaction_end` reasons are not carried into `metrics.compactions[].reason` (`driveStep` logs them to `stdout.log` only); judge wiring (I4, `bench/src/judge.ts`, `bench/judge/`) and `probe` are stubs; phase 4 pilot needs a key.
- 2026-10-14: phase 5 review fixes applied (`research/review-validity.md`, `research/review-robustness.md`). Blockers: `bench check` clones `node_modules` instead of symlinking (R1, test runs a package through the regraded tree); preflight of credentials, reference clone and template before the first trial, exit 1 on an exhausted cell, stop after 4 consecutive infra trials (R2); test-infrastructure trap files (`test/utils.ts`, the vega-lite test) and non-allowed `schema.json` restored from the reference clone in the check snapshot only, `src/` trap files never restored and their traps scored from the diff grep alone, all dropped from `harness_tampering` (V1, DESIGN 5.3/5.4 amended). Should-fix: `cacheWarming: "off"` and `usage` entries summed (V2); one `isThrottledError` in `jsonl.ts`, infra only for 429/5xx, other terminal errors leave the step settled and are counted as `errors.terminal` per condition (V3/R4, DESIGN 5.6); verdict's planned n = manifest `runsPerCell`, and a run planned below 10 per cell is a pilot: every model `insufficient` with the reason "pilot-sized run (n < 10), read the n column and the variance note", tables kept (V4, DESIGN 1/8.4); `escaped_tree` covers the tmp root and `..` traversal with the repo as the allowed subtree (V5); `bench check` rewrites `trial.json` and `metrics.json` (V6); one `promptIdFrom` in `jsonl.ts`, fixture id `3ad2a3039322` (V7/R3); folds without `episodes-fold-applied` count as rejected (V8); infra trials counted and listed in the report (V9); judge chosen per trial by model family (V10, `bench/judge/README.md`); `hardcoded` on string literals only (V11); judged probe verdicts merged into `checks.json`/`metrics.json` (V12); `mergeCategory` deleted (R5); SIGINT/SIGTERM handling with `interrupted` plan status (R6); worker wrapping, `allSettled`, unhandled-rejection logging (R7); scratch under `<tmp>/pi-bench/<run-id>/<trial-id>` (R8); `--resume` rejects other options (R9); judge usage and `--help` (R10). Nits done: compaction reasons in `metrics.compactions[].reason`, leftover requests to the last step with requests, `type-class-touched` on the goal-2 diff, DESIGN 2/4/9 wording (tools-section lines, probe-3 text, a1/a3 end event, report-time audit refusal), `PROMPTS_DIR` dropped, `any` in scaffold test, stamp parsing pinned to `src/stamps.ts`, suite skipped for infra trials, `check` uses the manifest config, reference-clone race, `cvRatio` bounds withheld under n=5. Deferred: V16 (c6 window; a recall right before its triggering edit would become spurious, contradicting c2), V18 (`registered-before` on the goal-1 tree: extractors are sync), R11 (scenario hash in the manifest), R12 (type overlaps), R18 (tests read the operator's `run.json`), R19 (timing margins), R21 (manifest validation), R24 (`debug-print` trap text needs `import ts` in `ChainNodeParser.ts`). Tests: 99 in `pnpm bench:test` (13 files), green twice; `pnpm test` 45, `pnpm test-types`, `pnpm lint`, `pnpm build` green; faux CLI run `e2e-fix` (run, report, check, judge --null-check) and a SIGINT + `--resume` round trip verified, dirs deleted. Next: phase 4 pilot (needs a key).
