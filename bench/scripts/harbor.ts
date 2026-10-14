import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const command = (file: string, args: string[]) =>
  execute(file, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });

interface Container {
  Id: string;
  Mounts: { Source: string }[];
  Config: { Labels?: Record<string, string> | null };
}

/** Remove only this run's mounted containers and their exact Compose project siblings. */
export async function cleanupRun(
  runDir: string,
  run: (file: string, args: string[]) => Promise<{ stdout: string }> = command
): Promise<void> {
  const normalize = (path: string) => {
    const hostPath = path
      .replaceAll('\\', '/')
      .replace(/^\/(?:run\/desktop\/mnt\/host|host_mnt)\/([a-z])(?=\/|$)/i, '$1:');
    const normalized = posix.normalize(hostPath).replace(/\/$/, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const root = normalize(resolve(runDir));
  const ids = (await run('docker', ['ps', '-aq'])).stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.length === 0) return;
  let inspected: string;
  try {
    inspected = (await run('docker', ['inspect', ...ids])).stdout;
  } catch (error) {
    // Docker still returns the surviving entries when a listed container disappears.
    const detail = error as { stdout?: string; stderr?: string };
    if (!detail.stdout || !/No such (?:object|container)/i.test(detail.stderr ?? '')) throw error;
    inspected = detail.stdout;
  }
  const containers = JSON.parse(inspected) as Container[];
  const owned = containers.filter((container) =>
    container.Mounts.some(({ Source }) => {
      const source = normalize(Source);
      return source === root || source.startsWith(`${root}/`);
    })
  );
  const projects = new Set(
    owned.flatMap((container) => {
      const project = container.Config.Labels?.['com.docker.compose.project'];
      return project ? [project] : [];
    })
  );
  const scoped = containers.filter(
    (container) =>
      owned.includes(container) ||
      projects.has(container.Config.Labels?.['com.docker.compose.project'] ?? '')
  );
  if (scoped.length > 0) await run('docker', ['rm', '-f', ...scoped.map(({ Id }) => Id)]);
  for (const project of projects) {
    const networks = (
      await run('docker', [
        'network',
        'ls',
        '-q',
        '--filter',
        `label=com.docker.compose.project=${project}`
      ])
    ).stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (networks.length > 0) await run('docker', ['network', 'rm', ...networks]);
  }
}

export async function runHarbor(
  args: string[],
  env: NodeJS.ProcessEnv,
  cleanupDocker = false
): Promise<number> {
  // Harbor reads UTF-8 agent logs without an encoding; Windows otherwise uses CP1252.
  env = { ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  let runDir: string | undefined;
  if (cleanupDocker) {
    // Resolve passthrough config overrides before choosing any cleanup scope.
    const printed = await execute('harbor', [...args, '--print-config'], {
      env,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8'
    });
    const config = JSON.parse(printed.stdout) as {
      jobs_dir: string;
      job_name: string;
      environment?: { type?: string };
    };
    // Harbor omits default-valued fields from --print-config; Docker is the default.
    if ((config.environment?.type ?? 'docker') === 'docker') {
      runDir = resolve(config.jobs_dir, config.job_name);
      if (existsSync(runDir)) throw new Error(`Refusing to launch into existing run ${runDir}`);
    }
  }
  const stdin = process.stdin;
  const interactive = Boolean(stdin.isTTY);
  const wasFlowing = stdin.readableFlowing;
  let interrupted = false;
  let closed = false;
  let failure: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let termination: Promise<void> | undefined;
  let input: Transform | undefined;
  let child: ReturnType<typeof spawn> | undefined;

  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child?.pid || closed) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        failure = error;
        child.kill(signal);
      }
    }
  };

  const abort = (signal: 'SIGINT' | 'SIGTERM') => {
    // Repeated signals must not bypass the subprocess wait or Docker cleanup.
    if (interrupted) return;
    interrupted = true;
    if (closed || !child?.pid) return;
    if (process.platform === 'win32') {
      console.error('Aborting Harbor forcibly on Windows; final logs may be lost.');
      termination = command('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'])
        .then(() => {})
        .catch((error: unknown) => {
          failure = error;
          child?.kill();
        });
    } else {
      signalGroup(signal);
      timer = setTimeout(() => signalGroup('SIGKILL'), 30_000);
    }
  };
  // Unix children have their own group, so each interrupt is forwarded exactly once.
  const onInt = () => abort('SIGINT');
  const onTerm = () => abort('SIGTERM');

  try {
    child = spawn('harbor', args, {
      env,
      detached: process.platform !== 'win32',
      stdio: [interactive ? 'pipe' : 'inherit', 'inherit', 'inherit']
    });
    const completion = new Promise<number>((done) => {
      child!.once('error', (error) => {
        failure = error;
      });
      child!.once('close', (code) => {
        closed = true;
        if (timer) clearTimeout(timer);
        done(code ?? 1);
      });
    });
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    if (interactive && child.stdin) {
      console.error('Type q then Enter, or press Ctrl+C, to abort Harbor.');
      input = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          if (chunk.toString().trim() === 'q') {
            abort('SIGINT');
            callback();
          } else {
            callback(null, chunk);
          }
        }
      });
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') {
          failure = error;
          abort('SIGINT');
        }
      });
      stdin.pipe(input).pipe(child.stdin);
    }
    const status = await completion;
    await termination;
    if (runDir && (interrupted || status !== 0 || failure)) await cleanupRun(runDir);
    if (failure) throw failure;
    return interrupted ? 130 : status;
  } finally {
    if (timer) clearTimeout(timer);
    if (input) {
      stdin.unpipe(input);
      input.destroy();
    }
    try {
      if (interactive) {
        if (wasFlowing !== true) stdin.pause();
        else stdin.resume();
      }
    } finally {
      process.removeListener('SIGINT', onInt);
      process.removeListener('SIGTERM', onTerm);
    }
  }
}
