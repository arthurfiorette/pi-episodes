import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  trial?: string;
  step?: string;
}

export interface LogRecord extends LogContext {
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

export interface LoggerOptions {
  /** JSON lines are appended here; the parent directory is created. Omit for stderr only. */
  file?: string;
  context?: LogContext;
  /** Default true. */
  stderr?: boolean;
  /** Records below this level are dropped. Default `info` on stderr, everything in the file. */
  stderrLevel?: LogLevel;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Structured `stdout.log` writer: one JSON object per line in the file, a terse line on stderr. */
export class Logger {
  readonly file: string | undefined;
  private readonly context: LogContext;
  private readonly stderr: boolean;
  private readonly stderrLevel: LogLevel;

  constructor(options: LoggerOptions = {}) {
    this.file = options.file;
    this.context = options.context ?? {};
    this.stderr = options.stderr ?? true;
    this.stderrLevel = options.stderrLevel ?? 'info';
    if (this.file !== undefined) mkdirSync(dirname(this.file), { recursive: true });
  }

  /** Same file and stderr setting, with `context` merged over this logger's. */
  child(context: LogContext): Logger {
    const options: LoggerOptions = {
      context: { ...this.context, ...context },
      stderr: this.stderr,
      stderrLevel: this.stderrLevel
    };
    if (this.file !== undefined) options.file = this.file;
    return new Logger(options);
  }

  log(level: LogLevel, msg: string, data: Record<string, unknown> = {}): void {
    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      ...this.context,
      msg,
      ...data
    };
    if (this.file !== undefined) appendFileSync(this.file, `${JSON.stringify(record)}\n`);
    if (this.stderr && LEVEL_RANK[level] >= LEVEL_RANK[this.stderrLevel]) {
      process.stderr.write(`${formatTerse(record)}\n`);
    }
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.log('debug', msg, data);
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.log('info', msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.log('warn', msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.log('error', msg, data);
  }
}

export function formatTerse(record: LogRecord): string {
  const { ts, level, trial, step, msg, ...data } = record;
  const scope = [trial, step].filter((part) => part !== undefined).join(' ');
  const pairs = Object.entries(data)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  return [
    ts.slice(11, 19),
    level.toUpperCase().padEnd(5),
    scope.length > 0 ? `[${scope}]` : undefined,
    msg,
    ...pairs
  ]
    .filter((part) => part !== undefined)
    .join(' ');
}
