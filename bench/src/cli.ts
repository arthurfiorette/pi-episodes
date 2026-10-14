import { ArgsError } from './args.js';
import { run as check } from './commands/check.js';
import { run as judge } from './commands/judge.js';
import { run as probe } from './commands/probe.js';
import { run as report } from './commands/report.js';
import { run as runCommand } from './commands/run.js';
import { run as validate } from './commands/validate.js';
import { ConfigError } from './fields.js';

interface Command {
  run: (argv: string[]) => Promise<number>;
  usage: string;
  description: string;
}

const COMMANDS: Record<string, Command> = {
  run: {
    run: runCommand,
    usage:
      'run [--config path] [--models a,b] [--scenarios x,y] [--runs N] [--parallel N] [--conditions A,B] [--run-id id] [--resume id] [--keep] [--provider faux]',
    description:
      'Run the trial grid (models x conditions x scenarios x runs) into bench/results/<run-id>; --provider faux uses scripted models.'
  },
  validate: {
    run: validate,
    usage: 'validate <scenario> [--repeat N] [--skip-suite] [--keep] [--quiet]',
    description:
      'Two-sided gate on a scenario: held-out tests fail on the sealed tree and pass with the reference; writes validate.json.'
  },
  check: {
    run: check,
    usage: 'check <run-id> [--trial id] [--config path]',
    description: 'Regrade finished trials from final-tree.tar.gz and rewrite checks.json.'
  },
  report: {
    run: report,
    usage: 'report <run-id> [--compare other-run-id] [--out dir] [--reps N] [--seed N]',
    description: 'Per-model tables, verdicts and charts: report.md, report.json, charts.html.'
  },
  judge: {
    run: judge,
    usage:
      'judge <run-id> [--rubrics a,b,c,d,e,probes] [--null-check] [--kappa] [--judge provider/model] [--config path] [--labels path]',
    description: 'LLM-as-judge rubrics over trial transcripts; writes judge.json per trial.'
  },
  probe: {
    run: probe,
    usage: 'probe <run-id> [--trial id] [--points boundary,fold,control]',
    description: 'Fold-point probe on B trials (phase 2): ask the model why it did or did not fold.'
  }
};

function usage(): string {
  const lines = Object.values(COMMANDS).flatMap((command) => [
    `  bench ${command.usage}`,
    `      ${command.description}`
  ]);
  return ['Usage: pnpm bench <command> [options]', '', 'Commands:', ...lines, ''].join('\n');
}

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === '--help' || name === '-h' || name === 'help') {
    process.stdout.write(usage());
    return name === undefined ? 2 : 0;
  }
  const command = COMMANDS[name];
  if (command === undefined) {
    process.stderr.write(`bench: unknown command "${name}"\n\n${usage()}`);
    return 2;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(`Usage: pnpm bench ${command.usage}\n\n  ${command.description}\n`);
    return 0;
  }
  try {
    return await command.run(rest);
  } catch (error) {
    if (error instanceof ArgsError) {
      process.stderr.write(`bench ${name}: ${error.message}\n\n  bench ${command.usage}\n`);
      return 2;
    }
    if (error instanceof ConfigError) {
      process.stderr.write(`bench ${name}: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

process.exitCode = await main(process.argv.slice(2));
