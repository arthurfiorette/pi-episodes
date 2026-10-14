// Prints the episode stats of one pi session file as JSON. Called by the Harbor agents
// after each trial: `tsx bench/scripts/stats.ts <session.jsonl>`.
import { sessionNumbers } from './session.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: tsx bench/scripts/stats.ts <session.jsonl>');
  process.exit(2);
}
process.stdout.write(`${JSON.stringify(sessionNumbers(file))}\n`);
