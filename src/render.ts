import { HIST_BUCKETS, SEVERITY } from './cluster.js';
import type { ClusterResult, Level, Signature } from './types.js';

export interface RenderOptions {
  top: number;
  /** Minimum severity: only signatures at this level or worse are shown. */
  level?: Level;
  /** Only signatures whose template or sample matches. */
  grep?: RegExp;
  /** Approximate token budget (chars/4); the digest shrinks to fit. */
  tokens?: number;
  /** Max output lines; the digest shrinks to fit, same degrade ladder as `tokens`. */
  maxLines?: number;
  /** Text inserted before the count, e.g. "+" for new signatures in a diff. */
  mark?: (sig: Signature) => string;
  /** Drop the `↳ sample` line entirely (⤷ detail still shows). */
  noSample?: boolean;
}

const SPARK_COLS = 10;
const SPARK_CHARS = '▁▂▃▄▅▆▇█';

function hhmm(ts?: string): string {
  const m = ts?.match(/\d{2}:\d{2}/);
  return m ? m[0] : '';
}

// Date part of a timestamp: "08-15" for ISO, "Aug 16" for syslog, '' if none.
function day(ts?: string): string {
  const iso = ts?.match(/^\d{4}-(\d{2}-\d{2})/);
  if (iso) return iso[1];
  const sys = ts?.match(/^([A-Z][a-z]{2} {1,2}\d{1,2}) /);
  return sys ? sys[1] : '';
}

// "09:14→10:02", or "08-15 23:10→08-16 01:02" when the span crosses midnight.
function span(first?: string, last?: string): string {
  const f = hhmm(first);
  const l = hhmm(last);
  if (!f || !l) return f;
  const fd = day(first);
  const ld = day(last);
  if (fd && ld && fd !== ld) return `${fd} ${f}→${ld} ${l}`;
  return f !== l ? `${f}→${l}` : f;
}

/** Collapse the fine histogram into ≤10 time buckets spanning the whole input. */
export function sparkBuckets(sig: Signature, result: ClusterResult): number[] | undefined {
  if (!sig.hist || !result.time) return undefined;
  const used = Math.min(HIST_BUCKETS, Math.floor((result.time.end - result.time.start) / result.time.bucketMs) + 1);
  const cols = Math.min(SPARK_COLS, used);
  const out = new Array<number>(cols).fill(0);
  for (let i = 0; i < used; i++) out[Math.floor((i * cols) / used)] += sig.hist[i];
  return out;
}

function spark(buckets: number[] | undefined): string {
  if (!buckets || buckets.length < 2) return '';
  const max = Math.max(...buckets);
  if (max === 0) return '';
  return buckets
    .map((n) => (n === 0 ? SPARK_CHARS[0] : SPARK_CHARS[1 + Math.floor(((SPARK_CHARS.length - 2) * n) / max)]))
    .join('');
}

export function parseLevel(s: string): Level {
  const l = s.toUpperCase();
  const map: Record<string, Level> = { ERROR: 'ERROR', ERR: 'ERROR', WARN: 'WARN', WARNING: 'WARN', OTHER: 'OTHER', INFO: 'INFO', DEBUG: 'DEBUG', TRACE: 'DEBUG' };
  if (!(l in map)) throw new Error(`--level expects one of error|warn|other|info|debug, got ${s}`);
  return map[l];
}

/** Apply --level / --grep. Returns the visible signatures and the total before filtering. */
export function filterSignatures(result: ClusterResult, opts: RenderOptions): { visible: Signature[]; total: number } {
  let visible = result.signatures;
  if (opts.level) {
    const max = SEVERITY[opts.level];
    visible = visible.filter((s) => SEVERITY[s.level] <= max);
  }
  if (opts.grep) {
    const re = opts.grep;
    visible = visible.filter((s) => re.test(s.template) || re.test(s.sample));
  }
  return { visible, total: result.signatures.length };
}

/** True when any visible signature is at `level` or worse — `--fail-on`. */
export function shouldFail(result: ClusterResult, level: Level): boolean {
  const max = SEVERITY[level];
  return result.signatures.some((s) => SEVERITY[s.level] <= max);
}

interface Layout {
  top: number;
  samples: 'all' | 'error' | 'none';
  detail: boolean;
}

function pct(count: number, lines: number): string {
  if (lines <= 0) return '';
  const p = Math.round((count / lines) * 100);
  return ` (${p === 0 ? '<1' : p}%)`;
}

function renderWith(result: ClusterResult, opts: RenderOptions, layout: Layout, note?: string): string {
  const { visible, total } = filterSignatures(result, opts);
  const out: string[] = [];
  const foldNote = result.folded ? ` (${result.folded} folded)` : '';
  const sigCount = visible.length === total ? `${total}` : `${visible.length}/${total}`;
  out.push(`${sigCount} signatures · ${result.lines} lines${foldNote}`);

  for (const sig of visible.slice(0, layout.top)) {
    const when = span(sig.firstSeen, sig.lastSeen);
    const sp = spark(sparkBuckets(sig, result));
    out.push(
      `[${sig.level}] #${sig.id} ${opts.mark?.(sig) ?? ''}×${sig.count}${pct(sig.count, result.lines)}${when ? `  ${when}` : ''}${sp ? `  ${sp}` : ''}  ${sig.template}`,
    );
    const showSample = !opts.noSample && (layout.samples === 'all' || (layout.samples === 'error' && sig.level === 'ERROR'));
    if (showSample) {
      if (sig.source || sig.sample !== sig.template) out.push(`  ↳ ${sig.source ? `[${sig.source}] ` : ''}${sig.sample}`);
      for (const s of sig.samples ?? []) out.push(`  ↳ ${s}`);
    }
    if (layout.detail && sig.detail) out.push(`  ⤷ ${sig.detail}`);
  }

  const hidden = visible.length - layout.top;
  if (hidden > 0) out.push(`… ${hidden} more signatures (raise --top)`);
  if (note) out.push(note);
  return out.join('\n');
}

const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

export function renderText(result: ClusterResult, opts: RenderOptions | number): string {
  const o: RenderOptions = typeof opts === 'number' ? { top: opts } : opts;
  const full: Layout = { top: o.top, samples: 'all', detail: true };
  if (!o.tokens && !o.maxLines) return renderWith(result, o, full);

  // Budget mode: degrade in order of least information lost first —
  // non-error samples → shrink top (down to 3) → all samples → top 1.
  const candidates: Layout[] = [full, { ...full, samples: 'error' }];
  for (let t = Math.floor(o.top * 0.7); t > 3; t = Math.floor(t * 0.7)) candidates.push({ top: t, samples: 'error', detail: true });
  candidates.push(
    { top: 3, samples: 'error', detail: true },
    { top: 3, samples: 'none', detail: true },
    { top: 2, samples: 'none', detail: false },
    { top: 1, samples: 'none', detail: false },
  );

  const fits = (s: string): boolean =>
    (!o.tokens || estimateTokens(s) <= o.tokens) && (!o.maxLines || s.split('\n').length <= o.maxLines);

  let last = '';
  for (const c of candidates) {
    const note = c === full ? undefined : o.tokens ? `(fit to --tokens ${o.tokens})` : `(fit to ${o.maxLines} lines)`;
    last = renderWith(result, o, c, note);
    if (fits(last)) return last;
  }
  return last;
}

/** Red-only, ≤10 lines, `''` when nothing at WARN+ — for hooks/CI line budgets. */
export function renderBrief(result: ClusterResult): string {
  const { visible } = filterSignatures(result, { top: Infinity, level: 'WARN' });
  if (visible.length === 0) return '';
  const rows = visible.slice(0, 9).map((sig) => {
    const when = span(sig.firstSeen, sig.lastSeen);
    return `[${sig.level}] #${sig.id} ×${sig.count}${when ? `  ${when}` : ''}  ${sig.template}`;
  });
  return [`${visible.length} signatures · ${result.lines} lines`, ...rows].join('\n');
}

export function renderJson(result: ClusterResult, opts: RenderOptions | number): string {
  const o: RenderOptions = typeof opts === 'number' ? { top: opts } : opts;
  const { visible, total } = filterSignatures(result, o);
  return JSON.stringify(
    {
      lines: result.lines,
      folded: result.folded,
      totalSignatures: total,
      time: result.time ? { start: new Date(result.time.start).toISOString(), end: new Date(result.time.end).toISOString() } : undefined,
      signatures: visible.slice(0, o.top).map((s) => {
        const { hist: _hist, novel: _novel, ...rest } = s;
        const spark = sparkBuckets(s, result);
        return spark ? { ...rest, spark } : rest;
      }),
    },
    null,
    2,
  );
}
