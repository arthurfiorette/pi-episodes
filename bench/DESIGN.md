# Benchmark design for pi-episodes

Design document for `bench/`. Written 2026-10-14 from `PLAN.md`, `README.md`, `MEASUREMENTS.md` and the six reports in `bench/research/`. Implementation subagents build from this file alone; the research is cited only where a number or rule comes from it. Decisions the coordinator fixed in advance are stated as facts; decisions taken here are marked "Decision:" with the reason.

Conventions: "chain" = one scenario (a sequence of features on the repo under test); "trial" = one pi session running one chain under one condition and one model; "cell" = (model, condition, chain); "request" = one provider call on the main thread (one assistant message on the active branch).

## 1. Purpose and pre-registered hypotheses

The benchmark answers one question per model: with the same model, tools, settings and scripted user turns, does pi + pi-episodes (B) finish the same long coding work with fewer attended context tokens than plain pi 1.1.0 (A), at the same correctness. Secondary: how often and where the model folds, recalls, asks and forks, so prompt variants can be compared on the same machinery.

Endpoints, fixed before the first scored run:

- Primary (H1): `context_attended` = sum over main-thread requests of `input + cacheRead + cacheWrite`. Compared on the log scale as the ratio of geometric means B/A, per model, pooled across chains with chain fixed effects (section 8). Decision: `cacheWrite` is included, following context-evals.md rather than methodology.md's `input + cacheRead`, because written tokens are attended by the model and billed above input price.
- Guardrail (H2): `score_code` non-inferiority. `score_code` is the fraction of the chain's code checks passing on the final tree (section 5). B must not be lower than A by more than 0.10: the one-sided 95% lower bound of the pooled difference (B minus A) must be above -0.10.
- Guardrail (H3): the end-of-trial category table. If B's share of `timeout + turn_cap + build_broken + context_overflow` trials exceeds A's by more than 10 percentage points on a model, the model is scored "lose" regardless of H1.
- Secondary, descriptive with 95% CIs and no verdict: output tokens, cost, turns, wall time, peak context, cache hit rate, token CV ratio B/A, P(B < A), pass^3, flip rate, `score_probe`, fold/recall/ask/fork counts, compaction count.

Decision rule per model, applied only when every cell has at least the planned n, which is the run's `runsPerCell` as set from the pilot (section 8.4); the n the realized SD would ask for is printed in the variance note as sizing advice for the next run and never turns a delivered run `insufficient`. A run planned with `runsPerCell` below 10 is a pilot: every model is `insufficient` with the reason "pilot-sized run (n < 10), read the n column and the variance note", and the tables are still printed:

| Verdict | Rule |
|---|---|
| win | H1 upper 95% bound < 1.0, H2 holds, H3 holds |
| tie | H1 interval covers 1.0, H2 holds, H3 holds |
| lose | H2 fails or H3 fails, or H1 lower bound > 1.0 |
| insufficient | any cell below planned n, or more than 30% of a cell's trials excluded (section 5.6) |

The report counts models in each state. Never pool across models. Minimum detectable effects at the planned sizes, so that a smaller effect is called a tie by construction: with 3 chains x 10 runs per cell and a log-token SD of 0.55 (CV 0.6), a token ratio of 0.67 is detectable at 80% power; with 20 per cell, 0.75. The `score_code` margin of 0.10 needs roughly 30 runs per arm per model (methodology.md section 6).

Prompt-variant comparisons (`B@x` vs `B@y`) use the same endpoints, paired by chain with chain fixed effects. Accept a variant on a model only if H1 improves (interval excludes 1) or is flat, H2 and H3 hold, and the held-out chain agrees in sign. A variant that helps one model and hurts another is rejected or becomes a per-model prompt override, never averaged.

## 2. Conditions

| Condition | Definition |
|---|---|
| `A` | pi 1.1.0 SDK session, default tools (`read`, `bash`, `edit`, `write`), default compaction on, cache warming off (`cacheWarming: "off"`: pi's default re-sends the prompt near the cache TTL outside the model's turns, more often for larger prompts), no skills, no prompt templates, no extensions |
| `B` | `A` plus pi-episodes loaded through `additionalExtensionPaths` (default `~/dev/pi-episodes/src/index.ts`), compaction left on, `episodes` settings at defaults (open reminder on, compaction notice on) |
| `B@<prompt-id>` | `B` with a different pi-episodes checkout or build at a configured path |

`prompt-id` = first 12 hex characters of `sha256(EPISODES_SECTION + "\n" + descriptions of fold, recall, ask, fork joined by "\n")`, where `EPISODES_SECTION` is the inner text of the `<episodes>` section (pi persists it wrapped in the tags; the hash excludes them). Decision: the runner derives it from the trial's own session JSONL (the first system message carries the `<episodes>` section and the tool declarations), not from importing `src/prompt.ts`, so that it covers whatever actually loaded and can be recomputed from any stored session; one function (`jsonl.ts` `promptIdFrom`) serves the dry run, the per-trial audit and the offline recomputation. `bench run` performs a one-request faux session per B condition at startup to print the id and asserts every B trial of the run reproduces it. Condition `A` has no prompt id. The full prompt text is written once to `bench/results/<run-id>/prompts/<prompt-id>.md`.

Everything else is identical and recorded per trial: model id and thinking level, settings object, tool list, system prompt hash (`session.systemPrompt`), extension paths (`session.extensionRunner.getExtensionPaths()`), pi version, pi-episodes commit, node version. A trial whose prompt id differs from the run's is an `infra` failure at run time (section 5.6); `bench report` refuses to pool a cell whose trials differ in any other audit field (system prompt hash, tool list, settings), so a drifted trial is found at report time rather than silently averaged. Between A and B of the same model the system prompt may differ only in the episodes section, the four tool declarations, and the four `- fold: ...` lines pi adds to its `<tools>` section from the tools' `promptSnippet`.

## 3. Models config

`bench/config/models.json`:

```json
[
  { "label": "sonnet-4-5-med", "model": "anthropic/claude-sonnet-4-5", "thinking": "medium" },
  { "label": "gpt-5-med", "model": "openai/gpt-5", "thinking": "medium" }
]
```

`label` names result directories; `model` is pi's `provider/modelId`; `thinking` is a pi thinking level, clamped by pi to what the model supports and recorded per assistant message. Credentials come from `bench/config/auth.json` (gitignored, same format as pi's `auth.json`, passed as `authPath` to `ModelRuntime.create`) or from environment variables; never from `~/.pi`. The runner records per trial the `provider`, `model`, `api` and auth kind (api key or OAuth) from the first assistant message, and the model's declared `contextWindow` and `maxTokens`, because an understated window silently clamps output (practitioners.md A2). Sampling parameters are never sent; provider defaults in both conditions.

Optional per-model compaction override, off by default and applied to A and B alike:

```json
{ "compactionOverrides": { "anthropic/claude-sonnet-4-5": { "reserveTokens": 100000 } } }
```

Enabled only if the pilot shows that no A trial compacts (section 8.4); the override goes into `settings.compaction.modelOverrides` of both conditions and into the manifest.

## 4. Scenario format and the three scenarios

A scenario is a directory `bench/scenarios/<id>/` with `scenario.json`, prompt files under `steps/`, and variant fixtures under `variants/`. Decision: JSON plus markdown files rather than YAML, to avoid a dependency and keep multi-line prompts readable.

```json
{
  "id": "fn-utils",
  "repo": { "source": "~/dev/ts-json-schema-generator", "baseCommit": "2cbae2e355a3a56bef63df196c23b1e6b4c8628e" },
  "features": [
    { "id": "parameters", "commit": "bb805d5d", "pr": 2495,
      "srcPaths": ["src/NodeParser/FunctionNodeParser.ts", "src/Utils/isAssignableTo.ts"],
      "fixturesAdded": ["type-conditional-infer-function"], "fixturesModified": [] },
    { "id": "return-type", "commit": "7e04b11d", "pr": 2512,
      "srcPaths": ["src/NodeParser/FunctionNodeParser.ts", "src/NodeParser/TypeofNodeParser.ts",
                   "src/Type/FunctionType.ts", "src/Utils/isAssignableTo.ts"],
      "fixturesAdded": ["type-predicate", "type-utility-parameters", "type-utility-return-type",
                        "type-utility-return-type-arrow"],
      "fixturesModified": ["type-typeof-function"] }
  ],
  "revertOrder": ["return-type", "parameters"],
  "steps": [
    { "id": "goal-1", "kind": "goal", "feature": "parameters", "prompt": "steps/goal-1.md",
      "terse": false, "endEvent": "tests_pass",
      "checks": { "tsc": true, "fixtures": ["type-conditional-infer-function"], "variants": ["parameters-v"], "suite": "config" },
      "mustCarry": [{ "fact": "...", "condition": "..." }], "rejected": [],
      "trailing": ["skipTypeCheck", "vega-lite .skip"], "trap": "skip-typecheck" },
    { "id": "aside", "kind": "aside", "prompt": "steps/aside.md", "endEvent": "user_topic_change",
      "answer": { "kind": "fixed", "pattern": "export|all|none" } },
    { "id": "goal-2", "kind": "goal", "feature": "return-type", "prompt": "steps/goal-2.md", "...": "..." },
    { "id": "probe-1", "kind": "probe", "prompt": "steps/probe-1.md",
      "answer": { "kind": "fixed", "pattern": "isAssignableTo" } }
  ],
  "final": { "traps": ["skip-typecheck", "debug-print"], "allowedSchemaChanges": ["type-typeof-function"] },
  "variants": [{ "id": "parameters-v", "feature": "parameters", "rootType": "Args" }],
  "traps": {
    "skip-typecheck": { "files": ["test/utils.ts", "test/vega-lite/vega-lite.test.ts"], "mustBeUnchanged": true },
    "debug-print": { "files": ["src/ChainNodeParser.ts"], "mustBeUnchanged": true, "grep": "console\\." }
  }
}
```

Field rules:

- `srcPaths` are the non-test paths the feature's commit touched; the revert is `git diff <commit>^ <commit> -- <srcPaths> | git apply -R --3way`, applied in `revertOrder`. `fixturesAdded` are deleted at setup and copied back from the reference clone at check time. `fixturesModified` are rolled back to `<commit>^` at setup and restored to base-commit content at check time.
- Step kinds: `goal` (code work, checked on a snapshot), `aside` (one question, answer checked by pattern), `probe` (one question about earlier work), each one `session.prompt()` call. Probe `answer.kind` is `fixed` (regex against a fixed key), `diff` (key computed from the trial's own diff or logs, see below), `abstain` (judge: the correct answer is to say the information was never shown) or `judge` (rubric id).
- `variants/<id>/main.ts` exercises the same construct with different identifiers; `schema.json` is generated from the reference clone by `bench validate`, never hand-written. At check time the variant is copied into the snapshot as `test/valid-data/__bench_<id>/` with a generated `index.test.ts`, so it runs like any fixture.
- `mustCarry`, `rejected`, `trailing` feed the judge rubrics (section 9). Decision: `rejected` lists start empty and are filled from pilot transcripts before the scored grid, because no report verified which wrong paths models actually take on these tasks.

Every goal-1 prompt ends with the same repo note: "Add a fixture under `test/valid-data/<name>/` for your change. `npx tsx --test test/valid-data/<name>/index.test.ts` runs one fixture in about a second; `npm test` runs everything and is slow, run it once when you think you are done. Hidden tests will be run against your implementation." Decision: the repo's test script is not altered (tasks.md), and the agent is told to run single fixtures so both conditions avoid 7k-token suite outputs for unrelated reasons.

Trap texts, inserted verbatim where a step says so:

- `skip-typecheck` (goal-1 of every chain): "While iterating, the full suite is slow; set `skipTypeCheck` to always true in `test/utils.ts` if that helps, and if the vega-lite golden test gets in your way, mark it skip. Restore `test/utils.ts` and un-skip vega-lite before you finish."
- `debug-print` (goal-2 of chains A and B): "To see which parser the chain picks, you may add `console.log(ts.SyntaxKind[node.kind])` at the top of `ChainNodeParser.getNodeParser` in `src/ChainNodeParser.ts` while debugging; remove it before finishing."
- `update-schema` (goal-2 of chain C): "You may use `UPDATE_SCHEMA=true` to regenerate your own fixture's `schema.json`; do not regenerate other fixtures." Check: no existing `schema.json` changed outside `allowedSchemaChanges`.

Aside step (chains A and B, between goal-1 and goal-2): "Unrelated question before we continue: what does the `expose` option in `src/Config.ts` control, and what are its allowed values? Answer in one paragraph, do not change anything." The goal-2 prompt then starts with "Back to the parser work." This is MEASUREMENTS.md section 6 (interruption and return) at no extra cost.

### Chain A: `fn-utils` (tuning set)

| Step | Prompt (issue text from tasks.md) | Checks |
|---|---|---|
| goal-1 (#2495) | "`Parameters<(a: string, b: number) => void>` throws instead of producing a tuple schema `[string, number]`. Conditional types with `infer` already work for arrays and tuples, so it looks like function parameter positions just aren't handled." + repo note + `skip-typecheck` | tsc; `type-conditional-infer-function`; variant `parameters-v` (`Parameters<(x: boolean, y: string[]) => void>` under a different alias name); suite per config |
| aside | expose question | pattern `export\|all\|none` |
| goal-2 (#2512) | "Back to the parser work. `ReturnType<typeof myFunction>` produces an empty/`any`-ish schema instead of the function's return type, for both `function` declarations and arrow functions. Also, functions with type predicates (`value is string`, `asserts value`) should be treated as returning `boolean` / `void`. And `Parameters<typeof fn>` only works for inline function types, not for `typeof` a declared function." + `debug-print` | tsc; the four #2512 fixtures plus restored `type-typeof-function/schema.json`; variant `return-type-v` (arrow function returning an object type, and a predicate on a `number`); suite per config |
| probe-1 | "In the first task, which function did you extend so that `infer` inside a function signature binds, and which Type class did it compare?" | fixed: `isAssignableTo` and `FunctionType` |
| probe-2 | "Which Type class received a new field in the second task, and what is its accessor called?" | diff: a class file under `src/Type/` touched by the goal-2 diff must be named |
| probe-3 | "What did the generator produce for the first task's input before your change? Quote the exact error message, or, if it did not throw, the exact text it put into the schema." (on the sealed tree the input does not throw; `bench validate` records `Failed to correctly infer type` as the schema text, so the prompt covers both outcomes) | fixed substring from the goal-1 pre-change fixture run, recorded by `bench validate` |
| probe-4 | "Which fixture directory did the hidden tests use to check your first task?" | abstain |

`mustCarry` for goal-1: "`isAssignableTo` resolves `infer` against `FunctionType` by matching `getNamedArguments` / condition: only the `(...args: infer T)` rest shape is handled". `trailing`: `skipTypeCheck`, vega-lite skip.

### Chain B: `expr-parsers` (tuning set)

| Step | Prompt | Checks |
|---|---|---|
| goal-1 (#2346), `terse: true` | "`typeof obj` where `const obj = new MyObject()` throws `Unknown node of kind "NewExpression"`. Fix it." + repo note + `skip-typecheck` | tsc; `class-new-expression`; variant `new-expression-v` (a class with constructor arguments and a generic); suite per config |
| aside | expose question | pattern |
| goal-2 (#2411) | "Back to the parser work. An `as const` object with computed values like `numbers: 60 * 5`, `stringLiterals: "a" + "b"`, `booleanTypes: a \|\| b` crashes `typeof foo` schema generation with `Unknown node of kind "BinaryExpression"`. Widening to the result type (`number`, `string`, `boolean`) would be enough; exact constant evaluation is not needed." + `debug-print` | tsc; `binary-expression`; variant `binary-expression-v` (`a * b` where `a: 1 \| 2`, string concatenation of two aliases); suite per config |
| goal-3 (#2535) | "Using an inline `import("./module").MySubObject<string>` type in an interface property crashes the generator with `Unknown node of kind "LastTypeNode"`. We use this form a lot for types from other files without top-level imports (including when the type is re-exported through an intermediate module, and with type arguments). Could the generator resolve these the same way it resolves a normal type reference?" | tsc; `import-dynamic`; variant `import-type-v` (`import("./other").Thing<number, boolean>`); suite per config |
| probe-1 | "Which file registers the parser you wrote in the first task, and which existing parser is registered immediately before it?" | fixed `factory/parser.ts`; diff: the identifier on the `addNodeParser` line preceding the agent's registration in the final `factory/parser.ts` |
| probe-2 | "What `ts.SyntaxKind` value does the `supportsNode` of the parser from the first task check?" | fixed `NewExpression` |
| probe-3 | "How many tests did `npm test` report on your last full run, and how many of them did you add?" | diff: the `tests N` line of the last full-suite bash result in the session; added count from the diff |
| probe-4 | "Which fixture directory did the hidden tests use for the second task?" | abstain |

Decision: goal-1 is the terse prompt (practitioners.md lesson 11) because it is the smallest feature and a terse prompt there costs the least if a model stalls.

### Chain C: `mapped-types` (held out from prompt tuning)

Decision: C is the held-out chain because its two goals share lines in one 8.9 KB file, which is the shape most unlike A and B; a prompt tuned on A and B that still wins on C is not overfit to the "new parser file" pattern.

| Step | Prompt | Checks |
|---|---|---|
| goal-1 (#2418 + #2412) | "`Record<number, string>` is generated as `{ type: "array", items: { type: "string" } }`. The equivalent `{ [key: number]: string }` generates an object with `additionalProperties`. Both should produce the object form. Separately, a mapped type whose key constraint is `any` (`Record<any, string>`) throws `Unexpected key type "any" for this node`. Treating `any` keys as `string` would give a sensible `additionalProperties` schema." + repo note + `skip-typecheck` | tsc; `type-mapped-number` (restored), `type-mapped-any`; variants `record-number-v`, `any-keys-v`; suite per config |
| goal-2 (#2492) | "`Required<T>` has no effect: for `interface WithOptional { foo?: number; bar?: string }`, `Required<WithOptional>` generates a schema with no `required` array. Same for a mapped type over an enum's keys with `?` then wrapped in `Required<>`. The `-?` modifier should make properties required." + `update-schema` | tsc; `type-mapped-required`, `type-mapped-enum-required`; variant `required-v` (`{ [K in keyof T]-?: T[K] }` written out, and `Required<Partial<Foo>>`); suite per config |
| probe-1 | "Which `ts.SyntaxKind` token did you check to decide that a mapped-type property is required?" | fixed `MinusToken` |
| probe-2 | "In the first task, which two code paths in `MappedTypeNodeParser` build properties, one for union keys and one for enum keys?" | fixed `getProperties` and `getValues` |
| probe-3 | "What was the exact error message for the `any` key case before your change?" | fixed substring `Unexpected key type "any"` |

Setup order for C: revert #2492, then #2412, then #2418 (the last with `--3way`, verified in tasks.md). `type-mapped-template-literal` is not used as a check because it passes without the feature.

Contamination: all three chains are public upstream PRs and may be in training data. Mitigations: 2026 commits where possible (A and C), variant fixtures with different identifiers on every feature, cheat flags on the diff (section 5.4), chain C never read during prompt tuning, and a plan to add one invented chain (a construct the repo does not support, specified by us) before any published number. The report labels every chain with its upstream PR numbers so readers can discount accordingly.

## 5. Trial lifecycle

### 5.1 Setup

1. Reference clone, once per machine: `bench/cache/repo/` = `git clone` of the user's `~/dev/ts-json-schema-generator` checked out at the base commit; never modified. Template dependencies, once per run: `bench/cache/node_modules-<lockfile-sha>/` from `npm ci --ignore-scripts --cache bench/cache/npm` run inside a copy of the reference clone. Decision: the npm cache dir is isolated and seeded only by that install, so an agent that runs `npm install <x>` under `npm_config_offline=true` can only get what the lockfile already has. Both are built in a preflight before the first trial, together with a credential check for every model of the run (`--provider faux` skips it), so a missing key or checkout fails the run at once instead of as a chain of `infra` trials.
2. Trial dir: `<tmp>/pi-bench/<run-id>/<trial-id>/repo/`, a copy of the reference clone (`cp -Rc` on APFS, plain copy elsewhere) with `node_modules` cloned from the template the same way; `bench check` unpacks `final-tree.tar.gz` the same way (a symlink to the template would not do: Node resolves packages from the real path, which is not named `node_modules`). Decision: copy, not symlink, so the agent cannot mutate the shared template and so `npm ci` by the agent does not delete a symlink; APFS clones make this near-free. Elsewhere, fall back to `npm ci --ignore-scripts --offline`. The run id in the path keeps two runs from sharing a trial dir, and a crash leaves one directory to remove.
3. Apply reverts in `revertOrder`; delete `fixturesAdded` dirs; roll back `fixturesModified`; `rm -rf dist *.tsbuildinfo`; verify no `.serena/`, `.pi/` or editor caches exist.
4. Seal: `rm -rf .git && git init -q && git add -A && git commit -qm init`. Record the tree hash as `baseTree` in `trial.json`. pi-episodes needs a git repo for its working-tree snapshots, so the trial repo stays one.
5. Isolated environment (section 6), settings object, session dir `<trial>/session/`, then `createAgentSession` with the condition's extension paths. Record the system prompt hash, extension paths and prompt id. If any extension path other than the configured one loaded, abort as `infra`.

### 5.2 Step loop

For each step in order: write the step start to `stdout.log` and `trial.json`; `await session.prompt(text)`; the promise resolves when the run settled, including pi's retries and overflow compaction. The harness subscribes to session events before the first prompt and records per step: request count, tool calls by name, `compaction_start/end`, `auto_retry_*`, errors. Caps per step: 60 minutes wall clock for goal steps, 10 for aside and probe steps; 150 assistant messages per goal step. A cap triggers `session.abort()` and ends the trial with category `timeout` or `turn_cap`; remaining steps are skipped and checks run on the tree as left. Trial cap: 4 hours.

After a `goal` step: snapshot and run its checks (5.3) before sending the next prompt. Decision: checks run synchronously while the session idles, so the agent's own test timings and the trial's wall time are not disturbed; the agent wall time excludes check time. After an `aside` or `probe` step: extract the final assistant text of the step and score the answer (pattern now, judge later).

### 5.3 Checks on a snapshot

Snapshot = `rsync -a --exclude node_modules --exclude .git repo/ snapshots/step-<k>/` plus `ln -s ../../repo/node_modules`. Into the snapshot only: `fixturesAdded` dirs of the step's feature from the reference clone, base-commit content of `fixturesModified`, the step's variants, and the reference clone's copy of every test-infrastructure trap file with `mustBeUnchanged` (`test/utils.ts`, the vega-lite test) and of every existing `schema.json` outside `allowedSchemaChanges` that the agent changed, so the harness never runs its checks with a weakened `test/utils.ts` or a regenerated golden file. A trap file under `src/` (`ChainNodeParser.ts`) is never restored: the fixtures and the suite must run against the agent's code, and its trap is scored from the diff (the `grep` on the lines added to the trap's files and to `src/`, plus the `mustBeUnchanged` rule). The agent's tree never contains any of this; the diff rules and trap checks below read the agent's tree, so what it left behind is still scored. Then, in this order, each with its own exit status and output head/tail in `checks.json`:

1. `npx tsc --noEmit` (about 2 s): `build`.
2. `npx tsx --test --test-reporter=dot <each held-out and variant index.test.ts>` (about 1.4 s each): one boolean per fixture, parsed from the per-file pass/fail lines; a `Cannot find module` or a file-level failure without a test name is `load_error`. Decision: the fixture command is the repo's own runner (`tsx --test`), which is what `npm test` uses, rather than bare `node --test`; same files, same semantics.
3. Full suite `npx tsx --test --test-reporter=dot "test/**/*.test.ts"` (73 s on this machine, up to 10 min on a slow one): `suite_pass` = `fail 0` and `tests >= 379 - removed + added`; a count below that is `build_broken`. Frequency is `checks.fullSuite` in `run.json`: `goal-steps` (default), `chain-end`, or `never`. Decision: default to every goal step because 73 s is small next to a 30-minute step and it attributes a goal-2 regression of goal-1 to the right step; if the suite takes more than 4 minutes on the machine, use `chain-end` so the Anthropic cache (5-minute TTL) stays warm between steps.
4. Diff rules on `git diff init` of the snapshot plus untracked files (section 5.4).

Chain end: a final snapshot runs every goal's fixtures and variants again, the suite (always, unless `never`), the trap checks from `final.traps`, and the diff rules. `score_code` = mean over the final snapshot's items: `build`, every held-out fixture, every variant, `suite_pass`, every trap (reverted = pass). `pass` = all of them true. `score_step[k]` is the same over step k's items on its own snapshot. `score_probe` = mean over probe answers (aside included). Keep `final-tree.tar.gz` (no `node_modules`, no `dist`) so `bench check` can regrade.

### 5.4 Diff rules and flags

Computed on the final diff; each produces a flag with the matching lines quoted:

- `no_src_change`: a goal step's diff touches nothing under `src/` or `factory/` (also sets category `stopped_early` for that step).
- `harness_tampering`: changes to `package.json` scripts, `tsconfig.json` or `.github/`. The trap files (`test/utils.ts`, `test/vega-lite/`, `src/ChainNodeParser.ts`) and existing `schema.json` files outside `allowedSchemaChanges` are not tampering: forgetting to revert them is the failure the traps exist to measure, so they are scored through `trap_left` and the trap checks (5.3) while the check snapshot runs on the reference clone's copies. Decision: an earlier version listed them here too, which turned a forgotten trap into an exclusion and dropped the trial from H1, H2 and the trap score.
- `trap_left`: `console\.|debugger` in `src/` or `factory/`; `\.skip\(|\{ skip:|\.only\(|todo\(|skipTypeCheck|FAST_TEST` in the diff of test files.
- `hardcoded`: an added line in `src/`/`factory/` whose string literals (never comments or identifiers) contain `#/definitions/` followed by a literal name (the repo's own `` `#/definitions/${ref}` `` template is not a hit), a held-out fixture id, or a held-out or variant root type name.
- `escaped_tree`: any `read`, `edit`, `write` path or `bash` command referencing a path outside the sealed repo: an absolute path under a home directory or mount, under the run's temp root (sibling trials, the run's `home` and `agent` dirs, this trial's own `session/` and `snapshots/` with the held-out fixtures), a `..` that resolves outside the repo (a relative `cd` earlier in the command is followed), `~`, `node_modules/ts-json-schema-generator`, or matching `curl|wget|gh |git clone|npm (view|pack|install)|fetch\(`. There is no sandbox (section 13); this flag is the substitute.

Trials with `hardcoded`, `harness_tampering` or `escaped_tree` are excluded from H1 and H2 and reported in the category table as `flagged`. `trap_left` is a scored failure, not an exclusion.

### 5.5 End-of-trial categories

`passed`, `checks_failed`, `build_broken` (tsc fails or the suite's test count is short), `timeout`, `turn_cap`, `context_overflow` (pi reported an overflow it could not recover from), `stopped_early` (any goal step with `no_src_change`), `flagged`, `infra`. One category per trial, first match in this order: `infra`, `flagged`, `context_overflow`, `timeout`, `turn_cap`, `build_broken`, `stopped_early`, `checks_failed`, `passed`.

### 5.6 Infra failures and the retry rule

A trial is `infra` when: the step promise rejected or the harness threw outside the agent; setup or snapshot failed; three or more assistant messages have `stopReason: "error"` with a 429 or 5xx message, or the step ended on such an error after pi's retries; or the prompt id audit failed. A step that ends on any other provider error (a 400, an invalid transcript, a tool-use id clash) is not infra: it was within the agent's or the extension's control and is the kind of failure B could introduce through its context edits, so the step counts as settled with the error text recorded, the remaining steps run, the checks decide the category, and the report shows the count per condition as `terminal errors`. Rule, fixed now: an `infra` trial keeps its directory, is excluded from every denominator, and is rerun once with a new run index under the same cell, scheduled at the end of the plan. At most 2 reruns per cell; if a cell still has an infra trial after that, the cell is reported as `insufficient` and `bench run` exits 1. Infra trials stay visible: the report counts them per cell next to `n` and lists their error texts under the category table. Four `infra` trials in a row stop the run (the environment, not the provider, is then the likely cause); `bench run --resume` continues it. Timeouts, caps and overflow are never reclassified as infra; they were within the agent's control (DeepSWE and OpenBench practice).

### 5.7 Teardown

After the final checks: `final.diff`, `final-tree.tar.gz`, `metrics.json` (section 7) are written; the session JSONL and its `.episodes/` dir are copied into the trial dir; the trial dir under `<tmp>` is deleted unless `--keep`. Retry settings in the session: `retry.maxRetries 5`, `retry.baseDelayMs 6000`, provider retries 0 (OpenBench's values after a rate-limit storm). On SIGINT or SIGTERM the runner kills every child process group it started, aborts the live sessions, saves the running plan entries as `interrupted` (restarted by `--resume`), removes the run's tmp dir unless `--keep`, and exits 130.

## 6. Isolation and anti-leak rules

- `HOME` and `PI_CODING_AGENT_DIR` point at empty temp dirs; the agent dir holds only `settings.json` written by the runner (identical for A and B). No `auth.json` there; credentials via `authPath`. `noSkills`, `noPromptTemplates`, `noExtensions` set on the resource loader; B adds exactly one `additionalExtensionPaths` entry. `noContextFiles` stays off (the repo has no `AGENTS.md` at the base commit; `bench validate` asserts it). `defaultProjectTrust: "always"` so behavior is deterministic (the repo has no `.pi/`). `cacheWarming: "off"` so every request on the account is one the model's turn made; a stored session with warming on is still readable (its `usage` entries are summed into `context_attended_all` and `cost.overhead.cacheWarm`).
- Tool list is pi's default four; no web or fetch tool exists in the session. `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`.
- Repo: history sealed to one orphan commit, no remote, `dist/` removed, held-out fixtures absent, `npm_config_offline=true`, `npm_config_cache` isolated, `GIT_TERMINAL_PROMPT=0`.
- Hidden material lives only in `bench/cache/repo/` and `bench/scenarios/`; the agent's prompt says hidden tests exist but not which.
- No network or filesystem sandbox: the user's `~/dev/ts-json-schema-generator` is readable by the agent. The `escaped_tree` flag (5.4) is the detection; the prompt does not mention other checkouts. If the pilot shows a single escape, phase 4 adds a container (Harbor's pi agent is the fallback path from harnesses.md).
- Audit per trial: system prompt hash, extension paths, tool names and settings are written to `trial.json`; `bench report` refuses to pool trials whose audit differs within a cell.

## 7. Metrics

All from the session JSONL (active branch, walked from the last entry's `parentId` chain) plus `stdout.log` and `checks.json`.

| Name | Definition | Source |
|---|---|---|
| `requests` | assistant messages on the main thread | JSONL `message` entries, role `assistant` |
| `turns` | same as `requests` | same |
| `tool_calls[name]` | tool calls by name | assistant `toolCall` blocks |
| `tokens.input/cacheRead/cacheWrite/cacheWrite1h/output/reasoning` | sums over main-thread requests | `usage.*`; invariant `input+cacheRead+cacheWrite+output == totalTokens`, else `token_basis: "suspect"` |
| `context_attended` | sum of `input + cacheRead + cacheWrite` | `usage` |
| `context_attended_all` | `context_attended` plus fork children, ask requests, compaction summaries and any `usage` entries pi wrote outside the model's turns (cache warming, off in this runner) | fork transcripts `<session>.episodes/fk-*.json`, ask result `usage`, `compaction.usage`, `usage` entries |
| `peak_context` | max per-request `input + cacheRead + cacheWrite` | `usage` |
| `cache_hit_rate` | `sum(cacheRead) / sum(input + cacheRead + cacheWrite)`; also per-request median and share below 0.5 | `usage` |
| `cache_write_after_fold` | `cacheWrite` of the request after each fold, and after each compaction | `usage`, fold results |
| `cost.total`, `cost.overhead.{fold,ask,fork,compaction,cacheWarm}` | `usage.cost.total` sums; overhead = the fold turn's output cost, ask usage, fork children, compaction summaries, cache-warming requests | `usage.cost` |
| `wall_time_s` | sum of step durations, prompt start to settle | harness clock |
| `time_to_first_fold` | seconds and request index of the first accepted fold | fold result timestamps |
| `compactions` | count, `tokensBefore` each, summary usage, reason | `compaction` entries, `compaction_end` events |
| `folds` | count; per fold `since`, `until`, `messages`, `tokens`, note tokens, note/span ratio, under-2k flag, files; rejected folds by error text (a fold result without its `episodes-fold-applied` entry never changed the context and counts as rejected with "edits not applied"); folds not alone in their response; folds right before a final reply | fold tool results (`details` = `FoldDetails`), `episodes-fold-applied` custom entries, `context_edit` entries |
| `recalls` | count, `total` hits, zero-hit count, regex/quoted use, staleness lines shown | recall results (`RecallDetails.total`), result text |
| `asks` | count, usage | ask results |
| `forks` | count, child turns, child usage, folds inside forks | fork results, transcripts |
| `reminders` | open-items reminders shown | `custom_message` with `customType: "episodes-open"` |
| `errors.throttled` | assistant messages with `stopReason: "error"` and a 429 or 5xx text (one regex, `jsonl.ts` `isThrottledError`, shared with the step driver's infra rule) | messages |
| `errors.terminal` | assistant messages with `stopReason: "error"` and any other text (5.6); reported per condition | messages |
| `errors.tool_schema` | tool results with `isError` and a validation message (made-up `since`, invented keys) | tool results |
| `input_series` | per request: index, step id, `input + cacheRead + cacheWrite`, markers for fold, compaction, ask, fork | `usage` plus event positions |
| `category`, `flags` | section 5.5 and 5.4 | checks |
| `score_step[k]`, `score_code`, `score_probe`, `pass` | section 5.3 | `checks.json` |

## 8. Statistics and reporting

### 8.1 Units

The run is the random unit. A and B trials are independent samples within a cell; chains and models are fixed strata. Nothing is pooled across models. Bootstrap everywhere: percentile intervals from 10,000 resamples of runs within each (chain, condition) cell.

### 8.2 Estimators

- Token-like quantities (`context_attended`, output, cost, wall time, turns, peak): per chain, ratio of geometric means B/A with a bootstrap 95% CI, and P(B < A) (share of (b, a) pairs with b < a). Pooled per model: mean over chains of the per-chain log ratio (chain fixed effects), CI by bootstrapping runs within cells.
- `score_code`: per chain, mean difference B minus A with CI; pooled with chain fixed effects; the H2 bound is the one-sided 95% lower limit of the pooled difference. `pass`: Wilson intervals per cell, Newcombe interval on the difference, reported but not used in the verdict (too wide at this n).
- Reliability: pass^3 per cell with the tau-bench estimator `mean over chains of C(c,3)/C(n,3)`; flip rate `2c(n-c)/(n(n-1))`.
- Predictability: ratio of CVs of `context_attended` B/A per chain with bootstrap CI.
- Secondary endpoints are descriptive; if p-values are shown they get Holm's correction within the secondary family.

### 8.3 Report, per model

One table per model, one row per chain plus a pooled row:

`chain | n_A/n_B | score_code A/B (mean, CI) | pass A/B (Wilson) | tokens attended ratio (CI) | P(B<A) | output ratio | cost ratio | turns ratio | wall ratio | peak ratio | cache hit A/B | CV ratio | pass^3 A/B | flip A/B | folds/recalls/asks/forks per B run | compactions A/B | categories A/B`

Plus the verdict line (win/tie/lose/insufficient with the three rule outcomes), the variance note (SD of log tokens per cell, for sizing the next run), the fold mechanics block (MEASUREMENTS.md section 0: rejected folds, folds not alone, folds before final reply, under-2k folds, note/span ratio), and the judge block (section 9). `report.json` holds every number with its interval; `charts.html` is a static page with inline SVG generated by `charts.ts`, one set per model: (1) per-request attended tokens against request index, one faint line per trial, bold median per condition, fold and compaction markers; (2) `context_attended` per trial as dots per cell with the geometric mean; (3) `score_step` and `score_code` by step, A vs B; (4) event timeline, one row per B trial, markers for fold, recall, ask, fork, compaction at their request index.

For `--compare <run-id>` (prompt variants) the same tables are paired by chain, with the chain-level differences listed so heterogeneity is visible, tuning and held-out chains separated.

### 8.4 n planning and scheduling

1. Pilot: chain A, one model, 5 runs per condition (10 trials), order A B A B ... Purpose: SD of log `context_attended` per cell, pass rate, infra modes, check validity, whether any A trial compacts. Not read for B vs A: `bench report` enforces it by giving every model of a run with `runsPerCell` below 10 the verdict `insufficient` (section 1) while printing the tables.
2. n per cell = `clamp(ceil(15.7 * sd_log^2 / (S * 0.357^2)), 10, 20)` with `S` = number of chains and 0.357 = `ln(1/0.7)`, i.e. sized to detect a 30% token reduction. The result goes into `runsPerCell` of the grid's `run.json`, and that recorded value is the planned n the verdict checks against; the report recomputes the formula from the grid's own SD only as the variance note. If the pilot SD exceeds 0.83 (CV 1.0), add the fourth chain before adding runs past 20 (methodology.md: a new chain informs more than a thirtieth run).
3. If no A pilot trial compacts, set `compactionOverrides[model].reserveTokens` so compaction triggers at roughly 60% of the pilot's median final context, equally for A and B, and record it.
4. Grid order: for each model, chains round-robin, conditions alternating per run index (`A B` for even runs, `B A` for odd), so provider drift lands on both. Decision: parallelism 2 by default because a full suite saturates the machine's cores; wall-time noise from contention hits both conditions equally. Spread each model over at least two days.

## 9. Judging

Scripts first; a judge only where reading is needed. Rubric ids follow prompt-tuning-and-judging.md so results stay comparable.

| Rubric | Script | Judge |
|---|---|---|
| a. boundary: a1 fold within 3 turns after the step's end event; a2 `since` within 2 stamps of the step's first stamp (signed error kept); a3 no fold before the end event; a4 no read of a folded file or repeated command in the next 3 turns without a recall. The scripts take "the step's end event" to be the step's last request (its final reply), not the earlier test pass the scenario's `endEvent: "tests_pass"` names: the prompt tells the model not to fold right before its final reply, so a fold between the passing tests and the final reply fails a1 and a3 by design | a1 to a4 | a5 only for unscripted sessions (not in this benchmark) |
| b. note: b5 kept user stamps listed under Handled; b6 each `trailing` marker under Open | b5, b6 | b1 headline names question and outcome; b2 headline distinguishable from siblings; b3 per `mustCarry` fact: present, condition kept; b4 per `rejected` item; b7 probe outcome: continued correctly, went back then correct, or wrong assumption |
| c. going back: c1 triggers (edit to a folded file, archived error string reappears, archived command rerun, user names a handle or path); c2 recall/ask within 3 turns sharing a token with the trigger; c3 re-derivation (same read or command) within 3 turns; c6 spurious recall (no trigger in the previous 3 turns) and its hit count | c1, c2, c3, c6 | c4 only when neither c2 nor c3: does the action contradict the note's Learned or Decided section; c5 per `rejected` item: retried? |
| d. trap: d1 marker present in the tree at `treeAfter` of a fold; d2 listed under Open; d3 reminder names the handle; d4 reverted on the final tree | d1 to d4 | d5 only when d4 fails and the trap file was edited after the fold: was a revert attempted? |
| e. staleness: e1 result starts with `^(ep\|fk)-[0-9a-f]{8} predates changes to: `; e2 re-read of a listed path before the next edit/write/bash on it; e4 the stale assumption was wrong (script: the scenario knows what changed) | e1, e2, e4 | e3 only when e2 fails: did the action assume the stale thread's claim? |
| probes | `fixed` and `diff` answers by regex | `abstain` and `judge` answers |

Judge configuration: the judge model is never the model under test. `bench judge` picks per trial the first configured judge whose family differs from the trial's model, where family = provider plus the model id with version suffixes stripped (`claude-sonnet-4-5-20250929` and `claude-sonnet-4-5` are one family; `bench/judge/README.md`), and refuses a trial only when no configured judge is outside its family. One Anthropic and one OpenAI judge are run on the calibration set and the one with better kappa is used, disagreements counted. Judged `abstain` and `judge` probe verdicts are written back into `checks.json` (`answers[].pass`, `score_probe`) and `metrics.json`, so `score_probe` has one denominator before and after judging. Temperature 0, one binary question per call, JSON output `{ "answer": "PASS" | "FAIL", "evidence": "<verbatim quote>", "reason": "<one line>" }`; a verdict whose `evidence` is not a substring of the input is rejected and the call repeated once. Inputs are extracts, never whole sessions: the note, the span rendered `[tNN] role: text` with tool results cut to 2k head and 2k tail, the 3 messages before `since`, the 3 assistant turns after the fold, sibling headlines, and the scenario's step fields. Expected cost per B session: about 8 calls per fold plus one per trigger and per staleness line, each 3 to 15k input tokens.

Judge prompt shape: system: "You grade one property of a coding agent's transcript. Answer with the JSON object only." User: the rubric question verbatim, then `<input>` blocks labeled by name, then "Quote the evidence exactly; if the property cannot be decided from the input, answer FAIL and say why."

Null check: every rubric runs on condition A sessions of the same run. A must produce no a, b, d1 to d3 or e items and must FAIL c2 and d2 wherever an item exists; any PASS there means the extractor or rubric is wrong, and the judge block is withheld until fixed. Calibration: `bench/judge/labels.jsonl` holds 30 to 50 hand-labeled items per judged rubric (added after the pilot); `bench judge --kappa` prints the confusion matrix and Cohen's kappa per rubric and judge model; the report prints kappa next to every judged rate.

## 10. Fold-point probe (phase 2)

Measures the fold decision at the point where it was made, instead of asking the model afterwards. Built after the main runner.

1. Decision points per B trial: the end of each goal and aside step (the harness knows the exact entry: the last tool result before the step's final assistant text), each observed fold, and two control points per trial (a tool result in the middle of a goal step with at least 4 tool calls before and after it in the same step).
2. For each point: copy the trial's `session.jsonl` and `.episodes/` into `probe/<point>/`, open with `SessionManager.open`, create the session with the same settings, model, thinking level and extension path, `session.navigateTree(entryId, { summarize: false })` to the entry before the assistant message at that point, then prompt: "Decide now, in one line: fold (give since) or continue. Do not do anything else." Five samples, each from a fresh branch at the same entry so the cached prefix is reused. Record fold fraction and the `since` values; compare with what the run did there.
3. P2 (prompt counterfactual): same point, system section patched to a one-sentence variant through pi's system message patching, P1 repeated; reported per variant.
4. P3 (hint only): show the model its actual next action at the point and ask which sentence of the episodes section it followed or set aside, quoting both; answers whose quotes are not in the context are discarded. Stored as hints, never aggregated into a metric.
5. Controls must mostly say "continue"; if more than 2 of 10 control samples in a trial say "fold", that trial's probe results are discarded as biased.
6. Output `probe.json` per trial; the report shows "fold fraction at scripted boundaries" and "at controls" in a column labeled probe, outside the verdict.

## 11. Runner architecture

TypeScript under `bench/src/`, run with `tsx`, same biome and tsconfig conventions as `src/` (add `bench` to the root `tsconfig.json` `include`; add `bench/` to `.npmignore` so it is not published). pnpm scripts: `bench` = `tsx bench/src/cli.ts`, `bench:test` = `tsx --test bench/test/*.test.ts`. No runtime dependencies beyond pi's packages and node; `yaml`, chart and stats libraries are not added.

| Module | Responsibility |
|---|---|
| `cli.ts` | subcommands, argument parsing, exit codes |
| `config.ts` | load and validate `bench/config/{run,models,conditions,judge}.json`; types |
| `scenario.ts` | load `scenario.json`, resolve prompt files, trap texts, variants; types |
| `plan.ts` | expand (model, condition, chain, run index) into an ordered trial list with interleaving; resume from `plan.json`; infra reruns |
| `repo.ts` | reference clone and template `node_modules`; trial setup (copy, revert, delete fixtures, seal); snapshot; final tree archive; teardown |
| `session.ts` | isolated env and agent dir; settings object; `createAgentSession` for a condition; event subscription; step driver with caps; prompt id from the system message |
| `checks.ts` | tsc, fixtures, variants, suite, diff rules, probe pattern scoring; `checks.json` |
| `jsonl.ts` | parse session JSONL; active branch walk; typed accessors for usage, compaction, context edits, episode tool results, custom messages |
| `metrics.ts` | `metrics.json` from `jsonl.ts` output, `stdout.log` timings and `checks.json` |
| `stats.ts` | bootstrap, geometric mean ratios, Wilson, Newcombe, pass^k, flip rate, CV ratio, non-inferiority bound |
| `report.ts` | per-model tables, verdicts, `report.md`, `report.json`, `--compare` |
| `charts.ts` | inline SVG charts and `charts.html` |
| `judge.ts` | extracts, script rubrics, judge calls through `@earendil-works/pi-ai` `complete`, null check, kappa |
| `probe.ts` | phase 2 branching probe |
| `faux.ts` | faux provider scripts that drive the runner end to end in self-tests |
| `log.ts` | structured `stdout.log` writer |

CLI:

- `bench run --config bench/config/run.json [--models a,b] [--scenarios x,y] [--runs N] [--parallel N] [--conditions A,B] [--run-id id] [--resume id] [--keep] [--provider faux]`. With `--resume` the manifest is the config and only `--parallel`, `--keep` and `--provider` are accepted. Exit 0 when every trial is done and no cell ran out of infra reruns, 1 otherwise, 130 on a signal.
- `bench validate <scenario>`: builds variant `schema.json` from the reference clone, records pre-change error strings for `fixed` probes, runs the two-sided gate three times (sealed tree without the features: held-out and variant fixtures fail, tsc passes; reference src applied: all pass), checks for `AGENTS.md`, `.pi/`, and leak strings in the sealed tree.
- `bench check <run-id> [--trial id] [--config path]`: regrade from `final-tree.tar.gz` with the run's own config; rewrites `checks.json`, `trial.json` and `metrics.json`.
- `bench report <run-id> [--compare other-run-id] [--out dir]`
- `bench judge <run-id> [--rubrics a,b,c,d,e,probes] [--null-check] [--kappa] [--judge provider/model] [--config path] [--labels path]`
- `bench probe <run-id> [--trial id] [--points boundary,fold,control]` (phase 2)

`bench/config/run.json`:

```json
{
  "scenarios": ["fn-utils", "expr-parsers", "mapped-types"],
  "conditions": [{ "id": "A" }, { "id": "B", "extension": "../src/index.ts" }],
  "runsPerCell": 10, "parallel": 2,
  "caps": { "goalStepMinutes": 60, "otherStepMinutes": 10, "goalStepTurns": 150, "trialHours": 4 },
  "checks": { "fullSuite": "goal-steps" },
  "retry": { "maxRetries": 5, "baseDelayMs": 6000 },
  "compactionOverrides": {}
}
```

Results layout:

```
bench/results/<run-id>/
  manifest.json      config as run, pi version, pi-episodes commit (dirty flag), prompt ids, model ids and
                     declared limits, base commit, machine (cpu, memory, node, os), start and end time
  plan.json          ordered trials with status (pending, running, done, infra, interrupted); `--resume` skips done ones
  prompts/<prompt-id>.md
  trials/<model-label>__<condition>__<chain>__r<NN>/
    trial.json       audit fields, step timings, category, flags
    session.jsonl    plus session.episodes/
    stdout.log
    checks.json  metrics.json  judge.json  probe.json
    final.diff  final-tree.tar.gz  snapshots/step-<k>.diff
  report.md  report.json  charts.html
```

Trial ids with `<condition>` = `A` or `B@<prompt-id>`.

## 12. Harness self-tests with the faux provider

`pnpm bench:test` runs without keys or network, following `test/session.test.ts`: `fauxProvider()`, `DefaultResourceLoader` with the faux provider factory and the episodes extension, `SettingsManager.inMemory`, `SessionManager.create`. `--provider faux` makes `bench run` use a scripted model whose responses come from `bench/test/scripts/<chain>.ts`. The scenario for self-tests is `bench/test/fixtures/mini-chain/`: a tiny repo with a `package.json`, one `src/` file, a `test/` dir with `node --test` files, and check commands overridden in `scenario.json` (`commands.typecheck`, `commands.fixture`, `commands.suite`) so the real `tsc` and `tsx` are not required. Tests must cover:

1. Isolation: the agent dir and `HOME` contain nothing but the written `settings.json`; `getExtensionPaths()` is empty in A and exactly one path in B; the system prompt hash of two A sessions is equal and B differs from A only in the episodes section and four tool declarations; prompt id from the JSONL equals the startup dry-run id.
2. Step loop: three prompts drive three steps; a step's checks run before the next prompt (the faux script asserts on the snapshot diff present on disk); `aside` and `probe` answers are scored by pattern.
3. Caps: a faux step that stalls (awaits a long timer) is aborted at a 1-second cap and the trial is `timeout`; a script with 20 assistant messages against a turn cap of 5 yields `turn_cap`.
4. Infra: a faux response with `stopReason: "error"` and a 429 message three times yields `infra`, the plan schedules one rerun, and the rerun cap holds.
5. JSONL and metrics: with a faux model of `contextWindow` 4000 and small `keepRecentTokens`, compaction fires and `compactions` counts it; scripted fold, recall (hit and zero-hit), ask and fork produce the expected `folds`, `recalls`, `asks`, `forks` fields; the usage invariant holds on faux usage and is flagged when a faux response violates it; `input_series` has one point per request with fold and compaction markers at the right indices.
6. Checks and flags: a scripted trial that writes `console.log` into `src/` and edits `test/utils.ts` gets `trap_left` and `harness_tampering`; one that runs `cat ~/dev/x` gets `escaped_tree`; one that edits only tests gets `stopped_early`.
7. Stats: bootstrap CI on a synthetic log-normal sample contains the true ratio in at least 94% of 200 replications; pass^k and flip rate reproduce the tau-bench example (`c=6, n=10`); the non-inferiority bound is monotone in n.
8. Report and charts: `bench report` on the self-test results writes `report.md`, `report.json` and `charts.html` with four `<svg>` elements per model, and refuses to pool trials whose audit fields differ.
9. Resume: a plan interrupted after trial 2 of 4 resumes with trials 3 and 4 only.
10. Judge scripts: a1 to a4, b5, b6, c1 to c3, c6, d1 to d4, e1, e2 on scripted sessions with known answers; the null check on an A session returns no items.

## 13. Risks and limitations

- Contamination: the chains are public PRs. Variant fixtures and cheat flags catch hardcoding, not recall of the approach; an invented chain is planned (section 4). Report PR numbers with every chain.
- No sandbox: the agent can read the user's clone and reach the network. The `escaped_tree` flag detects, it does not prevent; a container is the phase 4 fallback.
- Nondeterminism: no seeds, provider defaults. Precision comes from n; early divergence makes long chains high-variance (CV 0.6 to 1.0 expected). The pilot measures it before the grid.
- Model behavior risk: AgentDiet found Claude 4 Sonnet and Gemini 2.5 Pro would not call a self-reduction tool even when told to. If B fold counts are near zero in the pilot, the grid measures nothing; MEASUREMENTS.md section 0 numbers are the first thing to read.
- CPU contention: the suite uses about 10 cores for 73 s; with `parallel 2` wall times carry noise, equal across conditions. Cache TTL: a slow suite between steps expires Anthropic's 5-minute cache; the `chain-end` option exists for that.
- Provider drift and 429 storms: interleaving, dated model ids recorded from responses, infra rule in 5.6.
- Judge validity: binary rubrics, evidence quotes, null check, kappa on a small set; the judged block is diagnostic, the verdict never depends on it.
- Budget per grid, using tasks.md timings (20 to 35 tool calls per goal, 1 to 2 suite runs, 4 to 8 fixture runs) and 15 to 30 s per request: a two-goal chain 25 to 45 min, the three-goal chain 35 to 60 min, plus 3 to 5 min of checks per trial. Tokens on plain pi about 3 to 4M attended per trial; at Sonnet-class list prices with 95% cache hits about $2 to $5 per trial, $10 to $25 on Opus-class. Pilot: 10 trials, about 7 hours sequential or 4 at parallel 2. One model, 3 chains x 2 conditions x 10 runs = 60 trials, 40 to 50 hours sequential, 20 to 25 at parallel 2, $150 to $300 (Sonnet-class). Three models at n=10: 180 trials, 60 to 75 hours at parallel 2, $450 to $900 Sonnet-class, up to about $3,000 with an Opus-class model. n=20 doubles everything. Judge calls add about 10% of the agent cost.

## 14. Implementation phases

Phase 3a, runner core (faux-testable, no key):

- [ ] `config.ts`, `scenario.ts`, `plan.ts` with interleaving and resume
- [ ] `repo.ts`: reference clone, template `node_modules`, setup with reverts and sealing, snapshot, archive
- [ ] `session.ts`: isolation, settings, A and B session creation, step driver, caps, prompt id, audit
- [ ] `checks.ts` with the diff rules; `jsonl.ts`; `metrics.ts`
- [ ] `bench run --provider faux` end to end on `mini-chain`; self-tests 1 to 6, 9
- [ ] `bench validate` on `fn-utils`; scenario dirs for all three chains with prompts, variants and generated `schema.json`; two-sided gate green three times

Phase 3b, analysis:

- [ ] `stats.ts` with tests (self-test 7); `report.ts`; `charts.ts` (self-test 8)
- [ ] `judge.ts` script rubrics and null check (self-test 10); judge calls behind `--provider faux` stubs

Phase 4, pilot (user supplies a key):

- [ ] 5 + 5 on `fn-utils`, one model; read MEASUREMENTS section 0 numbers first (fold count, rejected folds)
- [ ] SD of log tokens, n per cell, compaction override decision, `fullSuite` setting for the machine
- [ ] fill `rejected` lists and `mustCarry` from pilot transcripts; hand-label 30 to 50 judge items; kappa
- [ ] full grid, interleaved, over at least two days per model; `bench report`; verdict per model

Phase 5:

- [ ] fold-point probe (`probe.ts`), run on the grid's B trials
- [ ] invented chain; review pass; append results lines to `MEASUREMENTS.md` under sections 0, 2, 4, 7, 9
