import { SEVERITY } from './cluster.js';
import { renderText, sparkBuckets, type RenderOptions } from './render.js';
import type { ClusterResult, Level, Signature } from './types.js';

export type Baseline = (Pick<Signature, 'template' | 'level' | 'count'> & { id?: string })[];

/** A signature counts as "grown" when its count multiplied by this or more. */
export const GROWTH_FACTOR = 3;
const GROWTH_MIN = 5;

export interface DiffEntry extends Signature {
  change: 'new' | 'grown';
  before: number;
}

export interface DiffResult {
  after: ClusterResult;
  entries: DiffEntry[];
  gone: Baseline;
  unchanged: number;
}

const keyOf = (s: { level: string; template: string }): string => `${s.level} ${s.template}`;

export function diff(baseline: Baseline, after: ClusterResult): DiffResult {
  const before = new Map(baseline.map((s) => [keyOf(s), s.count]));
  const seen = new Set<string>();
  const entries: DiffEntry[] = [];
  let unchanged = 0;

  for (const sig of after.signatures) {
    const k = keyOf(sig);
    seen.add(k);
    const prev = before.get(k);
    if (prev === undefined) entries.push({ ...sig, change: 'new', before: 0 });
    else if (sig.count >= GROWTH_MIN && sig.count >= prev * GROWTH_FACTOR) entries.push({ ...sig, change: 'grown', before: prev });
    else unchanged++;
  }
  // Severity first, then new before grown, then count — "what's new" is the question.
  entries.sort(
    (a, b) => SEVERITY[a.level] - SEVERITY[b.level] || (a.change === 'new' ? 0 : 1) - (b.change === 'new' ? 0 : 1) || b.count - a.count,
  );
  const gone = baseline.filter((s) => !seen.has(keyOf(s)));
  return { after, entries, gone, unchanged };
}

export function renderDiffText(d: DiffResult, opts: RenderOptions, label: string): string {
  const news = d.entries.filter((e) => e.change === 'new').length;
  const grown = d.entries.length - news;
  const head = `${news} new · ${grown} grown · ${d.gone.length} gone · ${d.unchanged} unchanged  (vs ${label}; after: ${d.after.lines} lines)`;
  if (d.entries.length === 0) return `${head}\nnothing new.`;

  // Reuse the digest renderer (level/grep/tokens/top all apply) on the changed
  // set; "+" marks new signatures, "×5→×120" grown ones.
  const shown: ClusterResult = { ...d.after, signatures: d.entries };
  const mark = (s: Signature): string => {
    const e = s as DiffEntry;
    return e.change === 'new' ? '+' : `×${e.before}→`;
  };
  const body = renderText(shown, { ...opts, mark }).split('\n').slice(1);
  return [head, ...body].join('\n');
}

/** Fleet Finding shape for new ERROR/WARN signatures — `pulse diff` / `/ship` step 2. */
export interface Finding {
  id: string;
  scope: 'log';
  severity: 'crit' | 'warn';
  title: string;
  detail: string;
  hint: string;
}

const FINDING_SEVERITY: Partial<Record<Level, 'crit' | 'warn'>> = { ERROR: 'crit', WARN: 'warn' };

export function toFindings(d: DiffResult, label: string): Finding[] {
  const findings: Finding[] = [];
  for (const e of d.entries) {
    if (e.change !== 'new') continue;
    const severity = FINDING_SEVERITY[e.level];
    if (!severity) continue;
    findings.push({
      id: `log:${e.id}`,
      scope: 'log',
      severity,
      title: `${e.template.slice(0, 80)} ×${e.count} (new since ${label})`,
      detail: e.sample,
      hint: `squirt --show ${e.id}`,
    });
  }
  return findings;
}

export function renderDiffJson(d: DiffResult, opts: RenderOptions, label: string): string {
  return JSON.stringify(
    {
      baseline: label,
      lines: d.after.lines,
      unchanged: d.unchanged,
      gone: d.gone,
      changes: d.entries.slice(0, opts.top).map((e) => {
        const { hist: _hist, novel: _novel, ...rest } = e;
        const spark = sparkBuckets(e, d.after);
        return spark ? { ...rest, spark } : rest;
      }),
      findings: toFindings(d, label),
    },
    null,
    2,
  );
}
