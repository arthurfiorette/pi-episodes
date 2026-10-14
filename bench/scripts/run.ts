// Builds a Harbor job config from a bench job file plus bench/local.yaml, then runs it.
//
//   pnpm bench:run <job> [--dry-run] [-- <harbor run flags>]
//
// Every model gets two agents that differ only in pi-episodes being installed, so the
// arms cannot drift apart by editing one of them.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, matchesGlob, resolve } from 'node:path';
import { parse } from 'yaml';

const BENCH = resolve(import.meta.dirname, '..');
const REPO = resolve(BENCH, '..');

interface BenchConfig {
  dataset: { name: string; ref?: string };
  languages?: string[];
  /** Tasks per language, picked with a fixed seed so every run gets the same ones. */
  sample?: { perLanguage: number; seed: number };
  tasks?: string[];
  attempts: number;
  models: string[];
  thinking?: string;
  pi: string;
  episodes: string;
  concurrency: number;
  environment: string;
  packages?: string[];
  packageProvider?: boolean;
  env?: Record<string, string>;
  allowedHosts?: string[];
}

/** pi's own network calls that are not part of the work. Both arms, so they cannot differ. */
const PI_ENV = { PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' };
/** Harbor's own rule for env names it redacts before writing configs. */
const SENSITIVE = /(KEY|SECRET|TOKEN(?!S)|PASSWORD|CREDENTIAL|AUTH)/i;

/**
 * Keeps literal secrets out of the generated config file: each becomes `${NAME}` in the
 * file and is handed to Harbor through its process environment instead.
 */
function hideSecrets(env: Record<string, string>, secrets: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(env).map(([name, value]) => {
      if (!SENSITIVE.test(name) || /^\$\{\w+\}$/.test(value)) return [name, value];
      secrets[name] = value;
      return [name, `\${${name}}`];
    })
  );
}

function load(job: string): BenchConfig {
  const file = join(BENCH, 'jobs', `${job}.yaml`);
  if (!existsSync(file)) {
    const known = readdirSync(join(BENCH, 'jobs')).map((name) => basename(name, '.yaml'));
    throw new Error(`No job "${job}". Known: ${known.join(', ')}`);
  }
  const local = join(BENCH, 'local.yaml');
  return {
    ...(parse(readFileSync(file, 'utf8')) as BenchConfig),
    ...(existsSync(local) ? (parse(readFileSync(local, 'utf8')) as Partial<BenchConfig>) : {})
  };
}

function harbor(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const result = spawnSync('harbor', args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** Mulberry32: a small seeded generator, so the sample does not change between runs. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(items: readonly T[], count: number, random: () => number): T[] {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, count);
}

interface TaskInfo {
  name: string;
  language: string | undefined;
  image: string | undefined;
}

/** Every task of the dataset, from a local copy downloaded on first use. */
function datasetTasks(dataset: BenchConfig['dataset']): TaskInfo[] {
  const dir = join(BENCH, '.cache', dataset.name.split('/').at(-1)!);
  if (!existsSync(dir)) {
    const spec = dataset.ref ? `${dataset.name}@${dataset.ref}` : dataset.name;
    if (harbor(['datasets', 'download', spec, '-o', join(BENCH, '.cache')]) !== 0) {
      throw new Error(`Could not download ${spec}`);
    }
  }
  return readdirSync(dir)
    .sort()
    .flatMap((task) => {
      const toml = join(dir, task, 'task.toml');
      if (!existsSync(toml)) return [];
      const text = readFileSync(toml, 'utf8');
      const name = /^name = "([^"]+)"/m.exec(text)?.[1];
      if (!name) return [];
      return [
        {
          name,
          language: /^language = "([^"]+)"/m.exec(text)?.[1],
          image: /^docker_image = "([^"]+)"/m.exec(text)?.[1]
        }
      ];
    });
}

/** Tasks with one of the languages; with a sample, at most `perLanguage` of each. */
function tasksByLanguage(
  tasks: readonly TaskInfo[],
  languages: readonly string[],
  sample: BenchConfig['sample']
): string[] {
  const random = sample ? seeded(sample.seed) : undefined;
  // Languages in the configured order, so adding one does not reshuffle the others' picks.
  const names = languages.flatMap((language) => {
    const matching = tasks.filter((task) => task.language === language).map((task) => task.name);
    return random && sample ? pick(matching, sample.perLanguage, random) : matching;
  });
  if (names.length === 0) throw new Error(`No task has language ${languages.join('/')}`);
  return names.sort();
}

/**
 * Pulls task images one at a time before Harbor starts. Registries such as ECR Public
 * rate-limit anonymous pulls, and a refused pull mid-run fails the trial as an error.
 */
function prepull(images: readonly string[]): void {
  for (const image of images) {
    if (spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status === 0)
      continue;
    for (let attempt = 1; ; attempt++) {
      console.error(`pulling ${image} (${attempt})`);
      if (spawnSync('docker', ['pull', '--quiet', image], { stdio: 'inherit' }).status === 0) break;
      if (attempt === 5) throw new Error(`Could not pull ${image}`);
      spawnSync('sleep', [String(attempt * 15)]);
    }
  }
}

/** `local` packs this checkout (prepack builds it); anything else is a pi package source. */
function episodesSource(episodes: string): string {
  if (episodes !== 'local') return episodes;
  const out = join(BENCH, '.out');
  mkdirSync(out, { recursive: true });
  const packed = spawnSync('pnpm', ['pack', '--pack-destination', out], {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  });
  if (packed.status !== 0) throw new Error('pnpm pack failed');
  const tarball = packed.stdout.trim().split('\n').at(-1)!;
  return resolve(out, basename(tarball));
}

function stamp(): string {
  return new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
}

function harborConfig(
  job: string,
  config: BenchConfig,
  tasks: string[] | undefined,
  episodes: string,
  secrets: Record<string, string>
) {
  const kwargs = {
    version: config.pi,
    ...(config.thinking ? { thinking: config.thinking } : {}),
    packages: config.packages ?? [],
    package_provider: config.packageProvider ?? false
  };
  const shared = {
    env: hideSecrets({ ...PI_ENV, ...config.env }, secrets),
    extra_allowed_hosts: config.allowedHosts ?? []
  };

  return {
    job_name: `${job}-${stamp()}`,
    jobs_dir: join(BENCH, 'runs'),
    n_attempts: config.attempts,
    n_concurrent_trials: config.concurrency,
    environment: { type: config.environment },
    datasets: [
      {
        name: config.dataset.name,
        ...(config.dataset.ref ? { ref: config.dataset.ref } : {}),
        ...(tasks ? { task_names: tasks } : {})
      }
    ],
    agents: config.models.flatMap((model) => [
      { import_path: 'pi_bench:PiBench', model_name: model, kwargs, ...shared },
      {
        import_path: 'pi_bench:PiEpisodes',
        model_name: model,
        kwargs: { ...kwargs, episodes },
        ...shared
      }
    ])
  };
}

const USAGE = `usage: pnpm bench:run <job> [options] [-- <harbor run flags>]

  --model <part>     only models containing <part>; repeatable
  --task <glob>      only these tasks, instead of the job's selection; repeatable
  --limit <n>        only the first n selected tasks
  --attempts <n>     attempts per task and arm, instead of the job's
  --dry-run          validate the config, run nothing`;

const VALUED = new Set(['--model', '--task', '--limit', '--attempts']);

/** Every value given for a flag that takes one, as in `--model a --model b`. */
function values(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, index) => (arg === flag && args[index + 1] ? [args[index + 1]!] : []));
}

function main(): number {
  const separator = process.argv.indexOf('--');
  const own = separator === -1 ? process.argv.slice(2) : process.argv.slice(2, separator);
  const passthrough = separator === -1 ? [] : process.argv.slice(separator + 1);
  const job = own.find((arg, index) => !arg.startsWith('-') && !VALUED.has(own[index - 1] ?? ''));
  if (!job) {
    console.error(USAGE);
    return 2;
  }
  const dryRun = own.includes('--dry-run');

  const config = load(job);
  const models = values(own, '--model');
  if (models.length > 0) {
    config.models = config.models.filter((model) => models.some((part) => model.includes(part)));
    if (config.models.length === 0)
      throw new Error(`No configured model matches ${models.join(', ')}`);
  }
  const attempts = values(own, '--attempts')[0];
  if (attempts) config.attempts = Number(attempts);
  const limit = values(own, '--limit')[0];

  const all = datasetTasks(config.dataset);
  const picked = values(own, '--task');
  let tasks =
    (picked.length > 0 ? picked : undefined) ??
    config.tasks ??
    (config.languages ? tasksByLanguage(all, config.languages, config.sample) : undefined);
  if (limit) {
    tasks = (tasks ?? all.map((task) => task.name)).slice(0, Number(limit));
  }
  const episodes =
    dryRun && config.episodes === 'local'
      ? join(BENCH, '.out', 'pi-episodes.tgz')
      : episodesSource(config.episodes);
  const secrets: Record<string, string> = {};
  const harborJob = harborConfig(job, config, tasks, episodes, secrets);

  if (!dryRun && config.environment === 'docker') {
    const selected = all.filter(
      (task) => !tasks || tasks.some((pattern) => matchesGlob(task.name, pattern))
    );
    prepull([...new Set(selected.flatMap((task) => (task.image ? [task.image] : [])))]);
  }

  const out = join(BENCH, '.out');
  mkdirSync(out, { recursive: true });
  const file = join(out, `${harborJob.job_name}.json`);
  writeFileSync(file, `${JSON.stringify(harborJob, null, 2)}\n`);
  console.error(
    `${harborJob.job_name}: ${harborJob.datasets[0]!.task_names?.length ?? 'all'} tasks × ${config.attempts} attempts × ${harborJob.agents.length} agents, config ${file}`
  );

  const envFile = join(BENCH, '.env');
  return harbor(
    [
      'run',
      '-c',
      file,
      ...(existsSync(envFile) ? ['--env-file', envFile] : []),
      ...(dryRun ? ['--dry-run'] : []),
      ...passthrough
    ],
    {
      ...process.env,
      ...secrets,
      PYTHONPATH: [join(BENCH, 'agents'), process.env.PYTHONPATH].filter(Boolean).join(':')
    }
  );
}

process.exit(main());
