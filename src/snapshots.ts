import { execFile } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const TIMEOUT_MS = 15_000;
const MAX_BUFFER = 64 * 1024 * 1024;

export interface DiskChange {
  status: string;
  /** Absolute path. */
  path: string;
}

interface Repo {
  root: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Content-addressed snapshots of the working tree, so a fold can say what changed on disk
 * during its span. `since` is chosen after the fact, so one is taken for every stamp.
 *
 * Git does the work through a private index and a private object store that borrows the
 * repository's objects as an alternate: the user's index, stash and `.git/objects` are never
 * written, and unchanged files are not hashed again.
 */
export class Snapshots {
  private readonly cwd: string;
  private readonly dir: string;
  private readonly trees = new Map<number, Promise<string | undefined>>();
  private repo: Promise<Repo | undefined> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  /** A snapshot that is queued but has not started, shared by everyone who asks meanwhile. */
  private waiting: Promise<string | undefined> | undefined;
  private disabled = false;

  constructor(cwd: string, sessionId: string) {
    this.cwd = cwd;
    this.dir = join(tmpdir(), `pi-episodes-${sessionId}-${process.pid}`);
  }

  /** Starts recording the working tree for `stamp` without waiting for it. */
  recordAt(stamp: number): void {
    if (!this.trees.has(stamp)) this.trees.set(stamp, this.snapshot());
  }

  treeAt(stamp: number): Promise<string | undefined> {
    return this.trees.get(stamp) ?? Promise.resolve(undefined);
  }

  /** Resolves once every snapshot started so far has been written. */
  async settled(): Promise<void> {
    await this.queue;
  }

  /** Writes the current working tree, untracked files included, as a git tree object. */
  snapshot(): Promise<string | undefined> {
    if (this.waiting) return this.waiting;
    // One private index is shared by every snapshot, so they must not overlap.
    const next = this.queue.then(() => {
      this.waiting = undefined;
      return this.writeTree();
    });
    this.waiting = next;
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Files that differ between two trees, or `undefined` when git could not tell. */
  async diff(
    from: string,
    to: string,
    paths?: readonly string[]
  ): Promise<DiskChange[] | undefined> {
    const repo = await this.resolveRepo();
    if (!repo) return undefined;
    if (from === to) return [];

    const args = ['diff', '--name-status', '--no-renames', '-z', from, to];
    if (paths) {
      // A path outside the work tree makes git fail the whole command.
      const inside = paths.filter((path) => path.startsWith(repo.root + sep));
      if (inside.length === 0) return [];
      args.push('--', ...inside);
    }

    try {
      const { stdout } = await run('git', args, {
        cwd: repo.root,
        env: repo.env,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER
      });
      const fields = stdout.split('\0').filter(Boolean);
      const changes: DiskChange[] = [];
      for (let index = 0; index + 1 < fields.length; index += 2) {
        changes.push({ status: fields[index]!, path: join(repo.root, fields[index + 1]!) });
      }
      return changes;
    } catch {
      return undefined;
    }
  }

  async dispose(): Promise<void> {
    await this.queue;
    await rm(this.dir, { recursive: true, force: true });
  }

  private async writeTree(): Promise<string | undefined> {
    if (this.disabled) return undefined;
    const repo = await this.resolveRepo();
    if (!repo) return undefined;

    const options = { cwd: repo.root, env: repo.env, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER };
    try {
      await run('git', ['add', '-A'], options);
      const { stdout } = await run('git', ['write-tree'], options);
      return stdout.trim() || undefined;
    } catch {
      // A repo where snapshots fail once (huge tree, broken index) will keep failing and
      // slowing down every turn, so stop trying for this session.
      this.disabled = true;
      return undefined;
    }
  }

  private resolveRepo(): Promise<Repo | undefined> {
    this.repo ??= this.prepare();
    return this.repo;
  }

  private async prepare(): Promise<Repo | undefined> {
    try {
      const { stdout } = await run(
        'git',
        ['rev-parse', '--show-toplevel', '--git-path', 'index', '--git-path', 'objects'],
        { cwd: this.cwd, timeout: TIMEOUT_MS }
      );
      const [gitRoot, index, objects] = stdout.trim().split('\n');
      if (!gitRoot || !index || !objects) return undefined;
      // Git prints forward slashes on Windows; paths from tools use the native separator.
      const root = resolve(gitRoot);

      const absolute = (path: string) => (isAbsolute(path) ? path : join(this.cwd, path));
      const indexFile = join(this.dir, 'index');
      const objectDir = join(this.dir, 'objects');
      await mkdir(objectDir, { recursive: true });
      // Starting from a copy of the real index gives git cached stat data, so `add -A`
      // only hashes files that actually changed instead of the whole repository.
      await copyFile(absolute(index), indexFile).catch(() => undefined);

      return {
        root,
        env: {
          ...process.env,
          GIT_INDEX_FILE: indexFile,
          GIT_OBJECT_DIRECTORY: objectDir,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: absolute(objects)
        }
      };
    } catch {
      return undefined;
    }
  }
}
