# Benchmark

Runs the same tasks with plain pi and with pi + pi-episodes, then compares pass rate, tokens, cost, time and context size. It runs on [Harbor](https://harborframework.com), the runner behind Terminal-Bench, using Harbor's own pi adapter for both arms.

- **Arms.** `pi` is Harbor's pi adapter. `pi-episodes` is the same adapter with pi-episodes installed. Both get the same pi version, model, thinking level, packages and environment variables, all generated from one job file, so neither arm can be edited on its own.
- **Tasks.** [DeepSWE](https://deepswe.datacurve.ai) v1.1 (`datacurve/deep-swe-1-1`): 113 long features in real open-source repositories, graded by hidden behavior tests in a separate verifier. Agent budget is 90 minutes per task. The default job samples up to 8 tasks per language (34 in all) with a fixed seed.
- **Numbers.** Harbor records reward, tokens, cost and time per trial. After each trial, both arms read their pi session file with `episodeStats()` (the same code as `/episodes stats`) and attach the result to the trial's `result.json`. Plain pi sessions give requests, context per request and compactions; the episodes arm also gives folds, recalls, asks and forks.

If you are an agent or a new maintainer about to change the benchmark or the prompt, read [GUIDE.md](GUIDE.md) first. It explains why the benchmark is built this way, how the upstream pieces work, the traps already hit, and how a prompt change is tested, and it links every source it relies on. What the runs showed so far is logged in [OBSERVATIONS.md](../OBSERVATIONS.md).

<br />

## Setup

Needs Docker, [uv](https://docs.astral.sh/uv/) and this repository's dependencies.

```sh
uv tool install harbor   # tested with 0.24.0
pnpm install
cp bench/.env.example bench/.env   # API keys; git-ignored
```

`bench/.env` is read by Harbor on the host. A variable reaches the sandbox only if a config names it under `env`. Harbor forwards the key of the selected model's provider to the pi adapter automatically (`ANTHROPIC_API_KEY` for `anthropic/...`, and so on).

On Windows, use Docker Desktop's Linux containers. In PowerShell, copy the environment template with `Copy-Item bench/.env.example bench/.env`. If `harbor --version` is not found after installation, run `uv tool update-shell` and restart the terminal. The runner enables Python UTF-8 mode so Harbor can read agent logs regardless of the Windows code page. The host scripts handle Windows paths and package-manager shims; native Windows Harbor execution still needs a smoke test. WSL2 is the fallback if Harbor itself fails on Windows.

At high concurrency, Docker's default subnet pools can run out before CPU or RAM does: Harbor creates a Compose network per environment, with additional networks for separate verifiers. If startup fails with `all predefined address pools have been fully subnetted`, configure smaller subnets in Docker Desktop's **Settings > Docker Engine**, merging this into the existing configuration:

```json
{
  "default-address-pools": [
    { "base": "10.240.0.0/16", "size": 24 }
  ]
}
```

This provides 256 `/24` networks. Choose a base that does not overlap your LAN, VPN, WSL, or other routed networks. Restart Docker to apply it; existing networks retain their old subnets. On Windows, the Linux-engine configuration is also stored in `%UserProfile%/.docker/daemon.json`. Verify the active setting with `docker info --format '{{json .DefaultAddressPools}}'`. Do not use a global network prune while other workloads are running.

### Local settings

`bench/local.yaml` (git-ignored) overrides any key of a job file: models, thinking level, concurrency, sandbox provider. Start from [`local.example.yaml`](local.example.yaml).

It also takes extra pi packages and environment variables, applied to both arms. A model provider that ships as a pi package, for example, looks like this:

```yaml
models:
  - example-provider/some-model
packages:
  - npm:pi-example-provider@1.0.0
packageProvider: true
env:
  EXAMPLE_PROVIDER_URL: ${EXAMPLE_PROVIDER_URL}
  EXAMPLE_PROVIDER_API_KEY: ${EXAMPLE_PROVIDER_API_KEY}
allowedHosts:
  - llm.example.com
```

- `packages` takes any `pi install` source (`npm:`, `git:`, a path inside the sandbox). They are installed after pi, before the agent runs.
- `env` sets variables for pi in both arms. `${VAR}` is filled in by Harbor from `bench/.env` or the shell, so the value stays out of committed files. Literal values of secret-looking names (`*KEY*`, `*TOKEN*`, `*SECRET*`, ...) are also kept out of the generated config: the runner passes them to Harbor through its environment, and Harbor redacts them in the job's own `config.json`.
- `packageProvider: true` says the model's provider comes from one of the packages. Without it, Harbor's pi adapter treats any `<PROVIDER>_BASE_URL` it sees as a custom OpenAI-style endpoint and writes its own model config for it.
- `allowedHosts` is needed because DeepSWE blocks the network while the agent runs. Harbor turns that into an allowlist with these hosts. Installing pi and the packages happens before, with the network open.
- A package can bring hooks of its own, such as its own compaction or retries. Both arms load it, so the comparison stays fair, but the baseline is then pi with that package rather than bare pi.

<br />

## Running

```sh
pnpm bench:run deep-swe --dry-run          # validate the generated config, run nothing
pnpm bench:run deep-swe --model haiku --limit 1 --attempts 1   # one model, task and attempt
pnpm bench:run deep-swe --task 'datacurve/arktype-*'           # only tasks matching a glob
pnpm bench:run deep-swe                    # the full job
pnpm bench:run deep-swe -- --upload        # and upload trials to Harbor Hub as they finish
```

`--model`, `--task`, `--limit` and `--attempts` narrow the job file's selection; `pnpm bench:run` without arguments lists them. Flags after `--` go to `harbor run` as is. Before starting, the runner:

1. reads `bench/jobs/<job>.yaml` and applies `bench/local.yaml`;
2. downloads the dataset to `bench/.cache` once, to pick tasks by language;
3. packs this checkout with `pnpm pack` when `episodes: local`, so the episodes arm runs the working tree, not a release;
4. pulls up to four task images concurrently with retries and a shared exponential cooldown on rate limits (ECR Public rate-limits anonymous pulls, and a refused pull fails the trial);
5. writes the Harbor config to `bench/.out/<job>-<time>.json` and runs it.

Results go to `bench/runs/<job>-<time>/`. A full default run is 34 tasks × 3 attempts × 2 arms = 204 trials per model, each up to 90 minutes; set `concurrency` to what the machine and the model's rate limits take.

While Harbor runs in an interactive terminal, type **q** followed by **Enter**, or press **Ctrl+C**, to abort. On macOS/Linux, the runner allows Harbor up to 30 seconds for graceful cancellation; on Windows, it terminates Harbor's process tree because Node cannot deliver a graceful Unix signal there. After an abort or abnormal exit, it removes leftover Docker containers and networks belonging to that run, including verifier containers and network sidecars. Images and existing result files are retained, but interrupted trials may lose final logs or results. Wait for cleanup to finish before closing the terminal; force-killing the runner bypasses cleanup.

<br />

## Reading the results

```sh
pnpm bench:report bench/runs/<job>-<time>
harbor view bench/runs                      # Harbor's trial and trajectory viewer
```

The report prints and writes `report.md`, plus `trials.csv` (one row per trial) and `rows.yaml` (Harbor Hub leaderboard rows with their trial IDs) into the job directory. It has three tables:

| Table | Columns |
| --- | --- |
| Episodes against plain pi, per model | Change in pass rate with its interval; tasks where episodes passed more or less often; change in tokens, cost, time and peak context |
| Per arm | Pass rate and interval; consistency (tasks whose attempts all agreed); median tokens, output, minutes, peak context; mean cost, requests, compactions |
| Episodes | Folds, tokens folded, tokens not sent because of folds, fold errors, recalls, asks, forks, extension version and prompt hash |

How to read them:

- **Tasks are the unit.** Attempts on one task are not independent, so intervals are 95% bootstrap over tasks (2000 resamples, fixed seed), and the arms are compared on the tasks both ran.
- **Changes in tokens, cost and time are ratios.** Each is the geometric mean over tasks of episodes / pi, so one huge task does not dominate.
- **Errors count as failures.** A trial without a reward (agent crash, timeout before the verifier) scores 0 and is listed under Errors. Infrastructure errors such as image pulls should be rerun, not counted.
- **Only compare matching prompt hashes.** Every episodes session records the extension's version and a hash of its prompt and tool descriptions. The report warns when one arm mixes hashes; a prompt change is a new run.
- **Three attempts is the minimum.** With 34 tasks, an interval on pass rate is still around ±15 points. A difference inside it is not a result.

`harbor upload bench/runs/<job>` puts a job on Harbor Hub. Leaderboards on the Hub belong to the dataset's owner, so `rows.yaml` is only usable on a dataset you publish yourself.

<br />

## Files

| Path | What it is |
| --- | --- |
| `GUIDE.md` | Why the benchmark is built this way, how Harbor and DeepSWE work underneath, known traps, the prompt-tuning loop, references |
| `jobs/*.yaml` | Job definitions: dataset, task selection, attempts, default models, pi version |
| `local.example.yaml` | Template for the git-ignored `local.yaml` |
| `agents/pi_bench.py` | The two Harbor agents (`PiBench`, `PiEpisodes`), subclasses of Harbor's pi adapter |
| `scripts/run.ts` | Builds the Harbor config and runs it |
| `scripts/stats.ts`, `scripts/session.ts` | Episode stats of one session file, as JSON |
| `scripts/report.ts` | The comparison report |

To add a benchmark, add a job file. Any Harbor dataset works; `languages` and `sample` only apply to datasets whose `task.toml` has a `language` field, and `tasks` takes name globs instead.

<br />

## Known limits

- **Apple Silicon.** DeepSWE images are amd64 only and run under emulation, which is slower. Time comparisons are only valid within one machine.
- **Node on PATH.** Harbor's pi adapter installs Node with nvm and puts it first on `PATH`, so the agent's shell may run a different Node than a JavaScript task's image ships. Both arms are affected the same way.
- **One goal per task.** DeepSWE tasks are a single feature each, so folds happen inside one goal rather than between goals. A multi-step task, where one session works through several related goals, is the next job to add.
