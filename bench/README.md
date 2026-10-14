# Benchmark runner

Measures pi + pi-episodes (condition B) against plain pi (condition A) on chained coding tasks in [ts-json-schema-generator](https://github.com/vega/ts-json-schema-generator): same model, same prompts, same sealed repo; only the extension differs. The methodology, metrics, statistics and decision rules are in [DESIGN.md](DESIGN.md); the sources behind them are in [research/](research/); the working plan and status are in [PLAN.md](PLAN.md).

## Prerequisites

- Node >= 24.16 and pnpm (`pnpm install` at the repo root; the runner uses pi's packages from `node_modules`, nothing else).
- A clone of ts-json-schema-generator at the path named in `bench/scenarios/<id>/scenario.json` (`repo.source`, default `~/dev/ts-json-schema-generator`). It is only read: the runner clones it once into `bench/cache/repo/<hash>` at the scenario's `baseCommit` and copies that per trial.
- Network once, for `npm ci` of the template `node_modules` into `bench/cache/node_modules-<lockfile sha>`. Trials run with `npm_config_offline=true` against the cache seeded by that install.
- Credentials for real models, and optionally a `models.pi.json` for proxies: see the next section. The self-tests and the faux run need neither credentials nor network.

## Credentials and custom endpoints

Credentials come from `bench/config/auth.json` (gitignored; copy `auth.example.json`, pi's `auth.json` format with `{ "type": "api_key", "key": "..." }` per provider) or from the provider's environment variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, see pi's `docs/providers.md`). The runner never reads `~/.pi`. The preflight before the first trial fails the run when a configured model has no credential, and `trial.json` records which kind was used (`authKind`: `api-key`, `env`, `oauth`).

To run against a proxy or an OpenAI- or Anthropic-compatible server, create `bench/config/models.pi.json` from `models.pi.example.json`. It is pi's `models.json` (pi's `docs/models.md`, "Configure a compatible endpoint"): one entry per provider with `baseUrl`, `api`, `apiKey` and a `models` list, loaded by every real-provider session and by the judge when the file exists, and never when it does not (`~/.pi/agent/models.json` is not read either). `api` is the wire protocol the endpoint speaks: `anthropic-messages`, `openai-responses`, `openai-completions` or `google-generative-ai`. The file is tracked, so `apiKey` must be an environment reference (`"$MY_PROXY_KEY"`), which pi resolves at request time; a literal key belongs in `auth.json` under the provider's name instead. Then list the model in `models.json` as `<provider>/<id>`, for example `anthropic-proxy/claude-sonnet-4-5`.

Two fields of each model entry matter for the measurement:

- `contextWindow` and `maxTokens`: pi defaults them to 128000 and 16384 when omitted. The window drives compaction (DESIGN 5), and `maxTokens` caps every response, so an understated value changes the agent's behavior in both conditions and the trial audit would record the wrong window.
- `cost`, in USD per million tokens (`input`, `output`, `cacheRead`, `cacheWrite`): pi defaults it to zero when omitted, and every dollar figure in `metrics.json` and the report is then zero. Token counts are unaffected.

The preflight loads the file before any repo is built and fails with the file's own error when it is invalid, when a provider entry lacks `api` or `baseUrl`, or when a `models.json` entry names a provider that is neither built into pi nor defined there. `manifest.json` records the file's path and the sha256 of its content (`piModels`); `--resume` refuses to continue when the content changed, like it does for the extension's prompt id. Each `trial.json` audit carries the resolved model's `baseUrl`, `contextWindow` and `maxTokens`.

## Commands

All commands run from the repo root as `pnpm bench <command>`; `pnpm bench --help` lists them.

```
bench run [--config path] [--models a,b] [--scenarios x,y] [--runs N] [--parallel N]
          [--conditions A,B] [--run-id id] [--resume id] [--keep] [--provider faux]
bench validate <scenario> [--repeat N] [--skip-suite] [--keep] [--quiet]
bench check <run-id> [--trial id] [--config path]
bench report <run-id> [--compare other-run-id] [--out dir] [--reps N] [--seed N]
bench judge <run-id> [--rubrics a,b,c,d,e,probes] [--null-check] [--kappa]
            [--judge provider/model] [--config path] [--labels path]
bench probe <run-id> [--trial id] [--points boundary,fold,control]
```

`bench <command> --help` prints that command's usage.

`run` expands models x conditions x scenarios x runs into an interleaved plan (DESIGN 8.4), drives each trial through pi's SDK with an isolated `HOME` and agent dir, runs the checks between goal steps and at the end, and writes everything under `bench/results/<run-id>/`. Defaults come from `bench/config/run.json` and `bench/config/models.json`; the flags override them for one run. Before the first trial it checks every model's credentials (skipped with `--provider faux`) and builds the reference clone and `node_modules` template per scenario, so a missing key or checkout fails at once.

```sh
# Pilot: one model, one chain, 5 runs per condition, two trials at a time
pnpm bench run --models sonnet-4-5-med --scenarios fn-utils --runs 5 --parallel 2 --run-id pilot-1

# Continue an interrupted run; trials marked running or interrupted are restarted, done ones
# are kept. The manifest is the config: only --parallel, --keep and --provider are accepted.
pnpm bench run --resume pilot-1 --parallel 1

# Full grid as configured in run.json
pnpm bench run --run-id grid-1
```

Exit codes: 0 when every trial is done and no cell ran out of infra reruns; 1 when trials are left pending or a cell is `insufficient` (an infra trial with no rerun left, DESIGN 5.6); 130 after SIGINT or SIGTERM, which kills the child processes, aborts the live sessions, marks running trials `interrupted` in `plan.json` and removes the scratch dir unless `--keep`. Four infra trials in a row stop the run early with the last error in the message; fix the environment and `--resume`.

`validate` runs the two-sided gate on a scenario (DESIGN 11): on the sealed tree the held-out and variant fixtures fail and `tsc` passes; with the reference implementation restored everything passes; no `AGENTS.md`, `.pi/` or leaked fixture names in the sealed tree. It writes `bench/scenarios/<id>/validate.json`, which the checks read for the expected test counts and the pre-change error strings of `fixed` probes. Three rounds by default; a round runs the full suite twice (about 60 to 70 s each on this machine).

```sh
pnpm bench validate fn-utils
pnpm bench validate mapped-types --repeat 1 --skip-suite   # quick, keeps the last suite counts
```

`check` regrades finished trials from `final-tree.tar.gz` with the run's own config and rewrites `checks.json`, `trial.json` and `metrics.json` (the report reads the last one); step checks, answers and session-derived state (caps, escapes) are kept from the original run. Use it after changing `checks.ts` or a scenario's fixtures.

`report` writes `report.md`, `report.json` and `charts.html` into the run dir (or `--out`): one table per model with per-chain and pooled rows, the H1 to H3 verdict (planned n = the run's `runsPerCell`), the variance note, fold mechanics and the category table with infra trials, their error texts and the count of terminal provider errors per condition. `--reps` sets the bootstrap resamples (default 10000).

`judge` runs the script rubrics and the LLM-judged ones (DESIGN 9); the judge model is chosen per trial from `bench/judge/judge.json` as the first one outside the trial model's family (`--judge` overrides), and judged probe answers are written back into `checks.json` and `metrics.json`. `probe` is the phase-2 fold-point probe (DESIGN 10).

## Config files

- `bench/config/run.json`: scenarios, conditions, `runsPerCell`, `parallel`, caps, `checks.fullSuite` (`goal-steps`, `chain-end` or `never`), retry settings, `compactionOverrides`, optional `heldOut`. The schema is `RunConfig` in `src/types.ts`; unknown keys are rejected.
- `bench/config/models.json`: `[{ "label", "model": "provider/modelId", "thinking" }]`. The label names result directories.
- `bench/config/models.faux.json`: the labels used with `--provider faux`.
- `bench/config/auth.json`: credentials (gitignored; `auth.example.json` is the shape).
- `bench/config/models.pi.json`: optional pi `models.json` with custom endpoints (`models.pi.example.json` is the shape); see "Credentials and custom endpoints".
- Conditions live in `run.json`: `{ "id": "A" }` is plain pi, `{ "id": "B", "extension": "../../src/index.ts" }` loads pi-episodes from that path (relative to `bench/config/`). A condition with an extension is named `B@<prompt-id>` in results, where the prompt id is a 12-hex hash of the extension's `<episodes>` prompt section and its four tool descriptions, taken from a dry run at startup and verified on every trial.

## Results layout

```
bench/results/<run-id>/
  manifest.json      config as run, pi version, pi-episodes commit, prompt ids, models.pi.json hash, machine, env, start and end
  plan.json          ordered trials with status (pending, running, done, infra, interrupted); --resume reads it
  run.log            the run's own log
  prompts/<prompt-id>.md
  trials/<model>__<condition>__<chain>__r<NN>/
    trial.json       audit (model id, endpoint, window, settings, tools, system prompt hash, extension paths), steps, category, flags
    stdout.log       JSON lines: step starts and ends, checks, cap hits
    session.jsonl    pi's session, plus session.episodes/ when forks happened
    checks.json      per-step and final snapshot checks, answers, score_code, score_probe, category
    metrics.json     tokens, cost, requests, folds, recalls, asks, forks, compactions, input series (DESIGN 7)
    final.diff  final-tree.tar.gz  snapshots/step-<id>.diff
  report.md  report.json  charts.html
```

Everything scratch lives under `<tmp>/pi-bench/<run-id>/`: the run's `home` and `agent` dirs and one `<trial-id>/` per trial (the sealed repo, the session and the check snapshots), deleted at teardown unless `--keep` is given. Infra trials keep their results dir and get one rerun each, at most two per cell (DESIGN 5.6).

## Adding a scenario

1. Create `bench/scenarios/<id>/` with `scenario.json`, prompts under `steps/`, and `variants/<id>/main.ts` for each variant fixture. The format is DESIGN section 4 and the type `Scenario` in `src/types.ts`; `bench/scenarios/README.md` lists the conventions (feature commits and ranges, fixture layout, traps, `validate.json`).
2. `pnpm bench validate <id>`. The gate must be green three times; it also generates each variant's `schema.json` from the reference implementation.
3. Add the id to `scenarios` in `run.json` (and to `heldOut` if it must stay out of prompt tuning).

`bench/test/fixtures/mini-chain/` is the smallest working example: a repo with no git history, held-out fixtures shipped under `fixtures/`, and `commands` overrides so the checks run with `node --test` instead of `tsc` and `tsx`.

## Faux self-test

The harness runs end to end without a model: `--provider faux` replaces the provider with a scripted one whose responses come from `bench/test/scripts/<chain>.ts`.

```sh
pnpm bench run --provider faux --scenarios mini-chain --models faux --runs 1 --conditions A,B --run-id e2e-faux --keep
pnpm bench report e2e-faux
pnpm bench check e2e-faux
```

The same run is `bench/test/e2e.test.ts`; `pnpm bench:test` runs it with the rest of the harness tests (isolation, step loop, caps, infra reruns, resume, checks and flags, metrics, stats, report).

## Comparing prompt variants

The only lever on pi-episodes is its prompt and tool descriptions, so each B run is tagged with its prompt id. To compare two variants: run the grid once per variant (the prompt id changes when `src/prompt.ts` or the tool descriptions change; `--resume` refuses to continue a run whose prompt id moved), then

```sh
pnpm bench report grid-v2 --compare grid-v1
```

The comparison block pairs the runs by chain, reports the token ratio and score difference between the two B conditions, and separates the tuning chains from the held-out ones so a variant tuned on `fn-utils` and `expr-parsers` is judged on `mapped-types`. Several B conditions can also be listed in one `run.json` (different `extension` paths); the report then produces one table per B condition.

## Where to read more

- [DESIGN.md](DESIGN.md): hypotheses and decision rules (1), conditions and prompt ids (2), scenario format and the three chains (4), trial lifecycle, checks, flags and categories (5), isolation (6), metrics (7), statistics (8), judging (9), runner modules (11), faux self-tests (12), risks (13).
- [research/](research/): methodology, context evaluations, harnesses, task sources, prompt tuning and judging, practitioner reports.
- `MEASUREMENTS.md` at the repo root: what the benchmark is meant to measure, numbered 1 to 9.
