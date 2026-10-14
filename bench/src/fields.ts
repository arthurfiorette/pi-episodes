import { readFileSync } from 'node:fs';

/** A config or scenario file failed validation; the message names the file and field. */
export class ConfigError extends Error {}

type Reader<T> = (value: unknown, where: string) => T;

export function readJsonFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`${path}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`${path}: invalid JSON: ${(error as Error).message}`);
  }
}

function show(value: unknown): string {
  const text = value === undefined ? 'undefined' : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

export function readObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${where}: expected an object, got ${show(value)}`);
  }
  return value as Record<string, unknown>;
}

export function readString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError(`${where}: expected a non-empty string, got ${show(value)}`);
  }
  return value;
}

export function readBoolean(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${where}: expected true or false, got ${show(value)}`);
  }
  return value;
}

export function readNumber(
  value: unknown,
  where: string,
  options: { min?: number; integer?: boolean } = {}
): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new ConfigError(`${where}: expected a number, got ${show(value)}`);
  }
  if (options.integer && !Number.isInteger(value)) {
    throw new ConfigError(`${where}: expected an integer, got ${show(value)}`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new ConfigError(`${where}: expected at least ${options.min}, got ${show(value)}`);
  }
  return value;
}

export function readEnum<T extends string>(
  value: unknown,
  where: string,
  options: readonly T[]
): T {
  if (typeof value !== 'string' || !(options as readonly string[]).includes(value)) {
    throw new ConfigError(
      `${where}: expected one of ${options.map((option) => JSON.stringify(option)).join(', ')}, got ${show(value)}`
    );
  }
  return value as T;
}

export function readArray<T>(value: unknown, where: string, read: Reader<T>): T[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${where}: expected an array, got ${show(value)}`);
  }
  return value.map((item, index) => read(item, `${where}[${index}]`));
}

export function readStringArray(value: unknown, where: string): string[] {
  return readArray(value, where, readString);
}

export function readRecord<T>(value: unknown, where: string, read: Reader<T>): Record<string, T> {
  const object = readObject(value, where);
  const result: Record<string, T> = {};
  for (const [key, item] of Object.entries(object)) result[key] = read(item, `${where}.${key}`);
  return result;
}

export function readOptional<T>(value: unknown, where: string, read: Reader<T>): T | undefined {
  return value === undefined ? undefined : read(value, where);
}

/** Reject keys the type does not declare, so a misspelled field fails instead of being ignored. */
export function rejectUnknownKeys(
  object: Record<string, unknown>,
  where: string,
  known: readonly string[]
): void {
  const unknown = Object.keys(object).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw new ConfigError(
      `${where}: unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}`
    );
  }
}

export function requireUnique(items: readonly string[], where: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item)) throw new ConfigError(`${where}: duplicate ${JSON.stringify(item)}`);
    seen.add(item);
  }
}

/** Usable as one segment of a trial directory name: `<model>__<condition>__<chain>__r<NN>`. */
export function requireIdentifier(value: string, where: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(value) || value.includes('__')) {
    throw new ConfigError(
      `${where}: ${JSON.stringify(value)} must match [A-Za-z0-9._@-] and must not contain "__"`
    );
  }
  return value;
}
