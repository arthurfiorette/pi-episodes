/**
 * `charts.html`: a static page of inline SVG, one block of four charts per model (DESIGN 8.3).
 * No scripts, no external assets; the small helpers below draw axes, scales and legends.
 */
import type { LoadedTrial } from './report.js';
import { geomean, median } from './stats.js';
import type { InputSeriesMarker, MetricsJson, ReportJson, TrialRecord } from './types.js';

export interface ChartTrial {
  trial: Pick<TrialRecord, 'model' | 'condition' | 'chain' | 'runIndex' | 'trialId'>;
  metrics: MetricsJson;
}

const WIDTH = 860;
const HEIGHT = 320;
const MARGIN = { top: 24, right: 24, bottom: 48, left: 72 };
const COLORS = { a: '#d1495b', b: '#1f77b4' };
const MARKERS: Record<InputSeriesMarker | 'recall', { glyph: string; label: string }> = {
  fold: { glyph: 'triangle', label: 'fold' },
  compaction: { glyph: 'cross', label: 'compaction' },
  ask: { glyph: 'diamond', label: 'ask' },
  fork: { glyph: 'square', label: 'fork' },
  recall: { glyph: 'circle', label: 'recall' }
};

export interface Scale {
  (value: number): number;
  domain: [number, number];
  range: [number, number];
}

export function linearScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 === 0 ? 1 : d1 - d0;
  const scale = ((value: number) => r0 + ((value - d0) / span) * (r1 - r0)) as Scale;
  scale.domain = domain;
  scale.range = range;
  return scale;
}

/** Round tick positions covering the domain, about `count` of them. */
export function ticks(domain: [number, number], count = 5): number[] {
  const [lo, hi] = domain;
  if (!(hi > lo)) return [lo];
  const rough = (hi - lo) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= rough) ?? magnitude;
  const result: number[] = [];
  for (let tick = Math.ceil(lo / step) * step; tick <= hi + step / 1000; tick += step)
    result.push(Number(tick.toFixed(10)));
  return result;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTick(value: number): string {
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(0)}k`;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function axes(
  x: Scale,
  y: Scale,
  labels: { x: string; y: string },
  xTicks?: { value: number; label: string }[]
): string {
  const bottom = y.range[0];
  const left = x.range[0];
  const parts: string[] = [];
  parts.push(`<line x1="${left}" y1="${bottom}" x2="${x.range[1]}" y2="${bottom}" stroke="#333"/>`);
  parts.push(`<line x1="${left}" y1="${y.range[1]}" x2="${left}" y2="${bottom}" stroke="#333"/>`);
  for (const tick of xTicks ??
    ticks(x.domain).map((value) => ({ value, label: formatTick(value) }))) {
    const px = x(tick.value);
    parts.push(`<line x1="${px}" y1="${bottom}" x2="${px}" y2="${bottom + 4}" stroke="#333"/>`);
    parts.push(
      `<text x="${px}" y="${bottom + 16}" text-anchor="middle" font-size="10">${escapeHtml(tick.label)}</text>`
    );
  }
  for (const tick of ticks(y.domain)) {
    const py = y(tick);
    parts.push(`<line x1="${left - 4}" y1="${py}" x2="${x.range[1]}" y2="${py}" stroke="#eee"/>`);
    parts.push(
      `<text x="${left - 6}" y="${py + 3}" text-anchor="end" font-size="10">${formatTick(tick)}</text>`
    );
  }
  parts.push(
    `<text x="${(left + x.range[1]) / 2}" y="${bottom + 34}" text-anchor="middle" font-size="11">${escapeHtml(labels.x)}</text>`
  );
  parts.push(
    `<text transform="translate(14 ${(bottom + y.range[1]) / 2}) rotate(-90)" text-anchor="middle" font-size="11">${escapeHtml(labels.y)}</text>`
  );
  return parts.join('');
}

function legend(
  items: { label: string; color: string; glyph?: string }[],
  x: number,
  y: number
): string {
  return items
    .map((item, index) => {
      const cy = y + index * 14;
      const mark = item.glyph
        ? glyph(item.glyph, x + 6, cy - 3, item.color)
        : `<line x1="${x}" y1="${cy - 3}" x2="${x + 12}" y2="${cy - 3}" stroke="${item.color}" stroke-width="2"/>`;
      return `${mark}<text x="${x + 18}" y="${cy}" font-size="10">${escapeHtml(item.label)}</text>`;
    })
    .join('');
}

function glyph(kind: string, cx: number, cy: number, color: string, size = 4): string {
  switch (kind) {
    case 'triangle':
      return `<polygon points="${cx},${cy - size} ${cx + size},${cy + size} ${cx - size},${cy + size}" fill="${color}"/>`;
    case 'cross':
      return `<path d="M${cx - size},${cy - size} L${cx + size},${cy + size} M${cx - size},${cy + size} L${cx + size},${cy - size}" stroke="${color}" stroke-width="1.5"/>`;
    case 'diamond':
      return `<polygon points="${cx},${cy - size} ${cx + size},${cy} ${cx},${cy + size} ${cx - size},${cy}" fill="${color}"/>`;
    case 'square':
      return `<rect x="${cx - size}" y="${cy - size}" width="${size * 2}" height="${size * 2}" fill="${color}"/>`;
    default:
      return `<circle cx="${cx}" cy="${cy}" r="${size - 1}" fill="none" stroke="${color}" stroke-width="1.5"/>`;
  }
}

function svg(body: string, title: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-label="${escapeHtml(title)}" font-family="system-ui, sans-serif">${body}</svg>`;
}

function figure(title: string, body: string, caption: string): string {
  return `<figure><figcaption><strong>${escapeHtml(title)}</strong> ${escapeHtml(caption)}</figcaption>${svg(body, title)}</figure>`;
}

function empty(title: string, caption: string): string {
  return figure(
    title,
    `<text x="${WIDTH / 2}" y="${HEIGHT / 2}" text-anchor="middle" font-size="12">no data</text>`,
    caption
  );
}

function sideOf(condition: string, conditionA: string): 'a' | 'b' {
  return condition === conditionA ? 'a' : 'b';
}

// ---------------------------------------------------------------------------
// Chart 1: attended tokens per request
// ---------------------------------------------------------------------------

function attendedChart(
  trials: readonly ChartTrial[],
  conditionA: string,
  conditionB: string
): string {
  const title = 'Attended tokens per request';
  const caption =
    'faint line per trial, bold median per condition; triangles mark folds, crosses compactions';
  const series = trials.map((trial) => ({
    side: sideOf(trial.trial.condition, conditionA),
    points: trial.metrics.inputSeries
  }));
  const maxIndex = Math.max(0, ...series.map((s) => s.points.length - 1));
  const maxTokens = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.attended)));
  if (series.every((s) => s.points.length === 0)) return empty(title, caption);
  const x = linearScale([0, Math.max(1, maxIndex)], [MARGIN.left, WIDTH - MARGIN.right]);
  const y = linearScale([0, maxTokens], [HEIGHT - MARGIN.bottom, MARGIN.top]);
  const parts: string[] = [axes(x, y, { x: 'request index', y: 'input + cacheRead + cacheWrite' })];
  const markers: string[] = [];
  for (const s of series) {
    const path = s.points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.index).toFixed(1)},${y(p.attended).toFixed(1)}`)
      .join(' ');
    parts.push(
      `<path d="${path}" fill="none" stroke="${COLORS[s.side]}" stroke-opacity="0.25" stroke-width="1"/>`
    );
    for (const p of s.points) {
      for (const marker of p.markers) {
        if (marker === 'fold' || marker === 'compaction')
          markers.push(
            glyph(MARKERS[marker].glyph, x(p.index), y(p.attended), COLORS[s.side], 3.5)
          );
      }
    }
  }
  for (const side of ['a', 'b'] as const) {
    const own = series.filter((s) => s.side === side);
    if (own.length === 0) continue;
    const medians: string[] = [];
    for (let index = 0; index <= maxIndex; index++) {
      const values = own.flatMap((s) => {
        const point = s.points[index];
        return point ? [point.attended] : [];
      });
      if (values.length === 0) continue;
      medians.push(
        `${medians.length === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(median(values)).toFixed(1)}`
      );
    }
    parts.push(
      `<path d="${medians.join(' ')}" fill="none" stroke="${COLORS[side]}" stroke-width="2.5"/>`
    );
  }
  parts.push(...markers);
  parts.push(
    legend(
      [
        { label: `${conditionA} median`, color: COLORS.a },
        { label: `${conditionB} median`, color: COLORS.b },
        { label: 'fold', color: '#333', glyph: 'triangle' },
        { label: 'compaction', color: '#333', glyph: 'cross' }
      ],
      WIDTH - MARGIN.right - 130,
      MARGIN.top + 10
    )
  );
  return figure(title, parts.join(''), caption);
}

// ---------------------------------------------------------------------------
// Chart 2: context_attended per trial, dots per cell
// ---------------------------------------------------------------------------

function tokensChart(
  trials: readonly ChartTrial[],
  chains: readonly string[],
  conditionA: string,
  conditionB: string
): string {
  const title = 'context_attended per trial';
  const caption =
    'one dot per trial, grouped by chain and condition; the bar is the geometric mean of the cell';
  const groups = chains.flatMap((chain) =>
    [conditionA, conditionB].map((condition) => ({
      chain,
      condition,
      side: sideOf(condition, conditionA),
      values: trials
        .filter((t) => t.trial.chain === chain && t.trial.condition === condition)
        .map((t) => t.metrics.contextAttended)
    }))
  );
  const all = groups.flatMap((g) => g.values);
  if (all.length === 0) return empty(title, caption);
  const x = linearScale([-0.5, groups.length - 0.5], [MARGIN.left, WIDTH - MARGIN.right]);
  const y = linearScale([0, Math.max(1, ...all)], [HEIGHT - MARGIN.bottom, MARGIN.top]);
  const xTicks = groups.map((g, i) => ({
    value: i,
    label: `${g.chain} ${g.condition.split('@')[0]}`
  }));
  const parts: string[] = [axes(x, y, { x: 'cell', y: 'context_attended' }, xTicks)];
  groups.forEach((g, i) => {
    const cx = x(i);
    g.values.forEach((value, j) => {
      const jitter = ((j % 5) - 2) * 4;
      parts.push(
        `<circle cx="${(cx + jitter).toFixed(1)}" cy="${y(value).toFixed(1)}" r="3.5" fill="${COLORS[g.side]}" fill-opacity="0.6"/>`
      );
    });
    const positive = g.values.filter((v) => v > 0);
    if (positive.length > 0) {
      const gy = y(geomean(positive));
      parts.push(
        `<line x1="${cx - 16}" y1="${gy.toFixed(1)}" x2="${cx + 16}" y2="${gy.toFixed(1)}" stroke="${COLORS[g.side]}" stroke-width="3"/>`
      );
    }
  });
  parts.push(
    legend(
      [
        { label: conditionA, color: COLORS.a },
        { label: conditionB, color: COLORS.b }
      ],
      WIDTH - MARGIN.right - 130,
      MARGIN.top + 10
    )
  );
  return figure(title, parts.join(''), caption);
}

// ---------------------------------------------------------------------------
// Chart 3: score_step and score_code by step
// ---------------------------------------------------------------------------

function scoresChart(
  trials: readonly ChartTrial[],
  conditionA: string,
  conditionB: string
): string {
  const title = 'score_step and score_code';
  const caption = 'mean score per step and on the final tree, A beside B';
  const steps: string[] = [];
  for (const trial of trials) {
    for (const id of Object.keys(trial.metrics.scoreStep)) if (!steps.includes(id)) steps.push(id);
  }
  const columns = [...steps, 'score_code'];
  const value = (trial: ChartTrial, column: string) =>
    column === 'score_code' ? trial.metrics.scoreCode : trial.metrics.scoreStep[column];
  const bars = columns.flatMap((column, index) =>
    [conditionA, conditionB].map((condition, offset) => {
      const values = trials
        .filter((t) => t.trial.condition === condition)
        .map((t) => value(t, column))
        .filter((v): v is number => v !== undefined);
      return {
        column,
        index,
        offset,
        side: sideOf(condition, conditionA),
        mean: values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : undefined,
        n: values.length
      };
    })
  );
  if (bars.every((bar) => bar.mean === undefined)) return empty(title, caption);
  const x = linearScale([-0.5, columns.length - 0.5], [MARGIN.left, WIDTH - MARGIN.right]);
  const y = linearScale([0, 1], [HEIGHT - MARGIN.bottom, MARGIN.top]);
  const slot = (x(1) - x(0)) / 2.6;
  const parts: string[] = [
    axes(
      x,
      y,
      { x: 'step', y: 'score' },
      columns.map((column, i) => ({ value: i, label: column }))
    )
  ];
  for (const bar of bars) {
    if (bar.mean === undefined) continue;
    const bx = x(bar.index) + (bar.offset - 0.5) * slot - slot / 2;
    const top = y(bar.mean);
    parts.push(
      `<rect x="${bx.toFixed(1)}" y="${top.toFixed(1)}" width="${slot.toFixed(1)}" height="${(y(0) - top).toFixed(1)}" fill="${COLORS[bar.side]}" fill-opacity="0.8"/>`
    );
    parts.push(
      `<text x="${(bx + slot / 2).toFixed(1)}" y="${(top - 3).toFixed(1)}" text-anchor="middle" font-size="9">${bar.mean.toFixed(2)} (n=${bar.n})</text>`
    );
  }
  parts.push(
    legend(
      [
        { label: conditionA, color: COLORS.a },
        { label: conditionB, color: COLORS.b }
      ],
      WIDTH - MARGIN.right - 130,
      MARGIN.top + 10
    )
  );
  return figure(title, parts.join(''), caption);
}

// ---------------------------------------------------------------------------
// Chart 4: event timeline, one row per B trial
// ---------------------------------------------------------------------------

function timelineChart(trials: readonly ChartTrial[], conditionB: string): string {
  const title = 'Event timeline (B trials)';
  const caption =
    'one row per B trial; markers at the request index of each fold, recall, ask, fork and compaction';
  const rows = trials.filter((t) => t.trial.condition === conditionB);
  if (rows.length === 0) return empty(title, caption);
  const maxIndex = Math.max(1, ...rows.map((t) => t.metrics.requests - 1));
  const x = linearScale([0, maxIndex], [MARGIN.left + 90, WIDTH - MARGIN.right]);
  const y = linearScale([-0.5, rows.length - 0.5], [MARGIN.top, HEIGHT - MARGIN.bottom]);
  const parts: string[] = [];
  const bottom = HEIGHT - MARGIN.bottom;
  parts.push(
    `<line x1="${x.range[0]}" y1="${bottom}" x2="${x.range[1]}" y2="${bottom}" stroke="#333"/>`
  );
  for (const tick of ticks(x.domain)) {
    parts.push(
      `<line x1="${x(tick)}" y1="${bottom}" x2="${x(tick)}" y2="${bottom + 4}" stroke="#333"/>`
    );
    parts.push(
      `<text x="${x(tick)}" y="${bottom + 16}" text-anchor="middle" font-size="10">${formatTick(tick)}</text>`
    );
  }
  parts.push(
    `<text x="${(x.range[0] + x.range[1]) / 2}" y="${bottom + 34}" text-anchor="middle" font-size="11">request index</text>`
  );
  rows.forEach((trial, i) => {
    const cy = y(i);
    const label = `${trial.trial.chain} r${String(trial.trial.runIndex).padStart(2, '0')}`;
    parts.push(
      `<text x="${x.range[0] - 6}" y="${(cy + 3).toFixed(1)}" text-anchor="end" font-size="9">${escapeHtml(label)}</text>`
    );
    parts.push(
      `<line x1="${x.range[0]}" y1="${cy.toFixed(1)}" x2="${x(Math.max(0, trial.metrics.requests - 1)).toFixed(1)}" y2="${cy.toFixed(1)}" stroke="#ccc"/>`
    );
    const events: { index: number; kind: keyof typeof MARKERS }[] = [
      ...trial.metrics.folds.map((f) => ({ index: f.requestIndex, kind: 'fold' as const })),
      ...trial.metrics.recalls.map((r) => ({ index: r.requestIndex, kind: 'recall' as const })),
      ...trial.metrics.asks.map((a) => ({ index: a.requestIndex, kind: 'ask' as const })),
      ...trial.metrics.forks.map((f) => ({ index: f.requestIndex, kind: 'fork' as const })),
      ...trial.metrics.compactions.map((c) => ({
        index: c.requestIndex,
        kind: 'compaction' as const
      }))
    ];
    for (const event of events) {
      if (event.index < 0) continue;
      parts.push(
        glyph(
          MARKERS[event.kind].glyph,
          x(event.index),
          cy,
          event.kind === 'compaction' ? '#d1495b' : COLORS.b,
          4
        )
      );
    }
  });
  parts.push(
    legend(
      (Object.keys(MARKERS) as (keyof typeof MARKERS)[]).map((kind) => ({
        label: MARKERS[kind].label,
        color: kind === 'compaction' ? '#d1495b' : COLORS.b,
        glyph: MARKERS[kind].glyph
      })),
      WIDTH - MARGIN.right - 110,
      MARGIN.top + 10
    )
  );
  return figure(title, parts.join(''), caption);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function renderCharts(
  report: ReportJson,
  trialsByModel: readonly (LoadedTrial | ChartTrial)[]
): string {
  const sections = report.models.map((model) => {
    const trials = trialsByModel.filter(
      (t) =>
        t.trial.model === model.model &&
        (t.trial.condition === model.conditionA || t.trial.condition === model.conditionB)
    );
    const usable = trials.filter((t) => t.metrics.category !== 'infra');
    const chains = model.rows.map((row) => row.chain);
    return [
      `<section><h2>${escapeHtml(model.model)}: ${escapeHtml(model.conditionA)} vs ${escapeHtml(model.conditionB)}</h2>`,
      `<p>Verdict: <strong>${model.verdict.verdict}</strong>. ${usable.length} trials shown (infra excluded).</p>`,
      attendedChart(usable, model.conditionA, model.conditionB),
      tokensChart(usable, chains, model.conditionA, model.conditionB),
      scoresChart(usable, model.conditionA, model.conditionB),
      timelineChart(usable, model.conditionB),
      '</section>'
    ].join('\n');
  });
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>bench charts: ${escapeHtml(report.runId)}</title>`,
    '<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem}figure{margin:1.5rem 0}figcaption{margin-bottom:.5rem;font-size:.9rem}svg{border:1px solid #ddd;max-width:100%;height:auto}</style>',
    '</head><body>',
    `<h1>bench charts: ${escapeHtml(report.runId)}</h1>`,
    `<p>Generated ${escapeHtml(report.generatedAt)}.</p>`,
    ...sections,
    '</body></html>',
    ''
  ].join('\n');
}
