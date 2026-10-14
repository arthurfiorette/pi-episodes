import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ArgsError, parseArgs } from '../args.js';
import { renderCharts } from '../charts.js';
import { RESULTS_DIR } from '../config.js';
import { buildReport, ReportError } from '../report.js';

const OPTIONS = ['compare', 'out', 'reps', 'seed'];

/** A run id under `bench/results/`, or a path to a results dir. */
export function resolveRunDir(id: string): string {
  const direct = resolve(id);
  if (existsSync(join(direct, 'trials'))) return direct;
  return join(RESULTS_DIR, id);
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  args.assertKnown(OPTIONS);
  const runId = args.positionals[0];
  if (runId === undefined) throw new ArgsError('missing <run-id>');
  if (args.positionals.length > 1)
    throw new ArgsError(`unexpected argument ${args.positionals[1]}`);

  const runDir = resolveRunDir(runId);
  const compare = args.string('compare');
  const outDir = args.string('out') ?? runDir;
  const reps = args.number('reps');
  const seed = args.number('seed');

  try {
    const built = buildReport(runDir, {
      ...(compare === undefined ? {} : { compare: resolveRunDir(compare) }),
      ...(reps === undefined ? {} : { reps }),
      ...(seed === undefined ? {} : { seed })
    });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'report.md'), built.markdown);
    writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(built.report, null, 2)}\n`);
    writeFileSync(join(outDir, 'charts.html'), renderCharts(built.report, built.trials));
    for (const warning of built.warnings) process.stderr.write(`bench report: ${warning}\n`);
    for (const model of built.report.models) {
      process.stdout.write(`${model.model} ${model.conditionB}: ${model.verdict.verdict}\n`);
    }
    process.stdout.write(`${join(outDir, 'report.md')}\n`);
    return 0;
  } catch (error) {
    if (error instanceof ReportError) {
      process.stderr.write(`bench report: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
