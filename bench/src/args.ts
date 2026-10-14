export class ArgsError extends Error {}

/**
 * Parsed command line: `--key value` and `--key=value` set options, names listed in `flags`
 * never take a value, `--` ends option parsing, everything else is positional.
 */
export class Args {
  readonly positionals: string[];
  private readonly options: Map<string, string | true>;

  constructor(positionals: string[], options: Map<string, string | true>) {
    this.positionals = positionals;
    this.options = options;
  }

  has(name: string): boolean {
    return this.options.has(name);
  }

  flag(name: string): boolean {
    const value = this.options.get(name);
    if (value === undefined) return false;
    if (value !== true) throw new ArgsError(`--${name} takes no value`);
    return true;
  }

  string(name: string): string | undefined {
    const value = this.options.get(name);
    if (value === undefined) return undefined;
    if (value === true) throw new ArgsError(`--${name} needs a value`);
    return value;
  }

  number(name: string): number | undefined {
    const value = this.string(name);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (Number.isNaN(parsed)) throw new ArgsError(`--${name} must be a number, got ${value}`);
    return parsed;
  }

  /** Comma-separated list. */
  list(name: string): string[] | undefined {
    const value = this.string(name);
    return value
      ?.split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  /** Throws when an option outside `known` was given. */
  assertKnown(known: readonly string[]): void {
    const unknown = [...this.options.keys()].filter((name) => !known.includes(name));
    if (unknown.length > 0) {
      throw new ArgsError(
        `unknown option${unknown.length > 1 ? 's' : ''} ${unknown.map((name) => `--${name}`).join(', ')}`
      );
    }
  }
}

export function parseArgs(argv: readonly string[], flags: readonly string[] = []): Args {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf('=');
    if (equals !== -1) {
      options.set(arg.slice(2, equals), arg.slice(equals + 1));
      continue;
    }
    const name = arg.slice(2);
    const next = argv[index + 1];
    if (flags.includes(name) || next === undefined || next.startsWith('--')) {
      options.set(name, true);
    } else {
      options.set(name, next);
      index++;
    }
  }
  return new Args(positionals, options);
}
