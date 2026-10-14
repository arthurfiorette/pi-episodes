import assert from 'node:assert/strict';
import { test } from 'node:test';
import { episodeStats, sparkline, statsLines } from '../src/stats.js';

test('the graph scales to the largest request shown and keeps the newest', () => {
  const points = [100, 200, 400, 800, 100].map((tokens) => ({ tokens }));
  assert.equal(sparkline(points, 5), '▁▂▄█▁');
  assert.equal(sparkline(points, 2), '█▁');
  const marked = sparkline(
    [{ tokens: 10 }, { tokens: 5, after: 'fold' as const }],
    2,
    (bar, point) => (point.after ? `<${bar}>` : bar)
  );
  assert.equal(marked, '█<▄>');
});

test('an empty session says only what the extension costs', () => {
  const lines = statsLines(episodeStats([], '/repo'));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^added by the extension ~0 .*prompt ~\d+(k)? per request$/);
});
