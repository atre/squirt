import { createHash } from 'node:crypto';
import { mask } from './mask.js';
import type { ClusterOptions, ClusterResult, Level, Signature, TaggedLine, TimeRange } from './types.js';

// Leading timestamp, optionally wrapped in [] — ISO 8601 (kubectl --timestamps,
// most app loggers) or syslog "Aug 16 09:18:00". Followed by separator junk.
const TS_PREFIX =
  /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|[A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2})\]?[\s:|-]*/;
const LEVEL_RE = /\b(FATAL|PANIC|CRITICAL|CRIT|ERROR|ERR|WARNING|WARN|INFO|DEBUG|TRACE)\b/;
// Body-scan fallback may only assign ERROR/WARN family — "user asked for INFO"
// is not an INFO line. INFO/DEBUG/TRACE come from a leading token or JSON field.
const LEVEL_BODY_RE = /\b(FATAL|PANIC|CRITICAL|CRIT|ERROR|ERR|WARNING|WARN)\b/;
// The level token when it is the leading decoration of the message:
// "ERROR msg", "[error] msg", "level=info msg", "app.ERROR: msg", "INFO: msg".
const LEVEL_PREFIX =
  /^(?:\[?(?:level|lvl|severity)=)?[\[(]?(?:[\w.]+\.)?(FATAL|PANIC|CRITICAL|CRIT|ERROR|ERR|WARNING|WARN|INFO|DEBUG|TRACE)[\])]?:?\s+/i;
// Stack-trace bodies and wrapped lines attach to the signature above them
// instead of polluting the digest with one-off "signatures".
const CONTINUATION = /^(\s+\S|at |Caused by|Traceback|\.\.\.|File ")/;
// The folded line worth surfacing: the root cause, not the frame list.
const DETAIL = /^\s*(Caused by:|[\w.]*(Error|Exception):)/;
const ANSI_SGR = /\x1b\[[0-9;]*m/g;
// kubectl logs --prefix: "[pod/api-7f9/app] msg" (also "[pod/api-7f9] msg").
const POD_PREFIX = /^\[pod\/([^\/\]\s]+)(?:\/[^\]\s]+)?\]\s+/;
// logfmt key=value token: bare word or a quoted string (escapes allowed).
const KV_RE = /(\w[\w.-]*)=("(?:[^"\\]|\\.)*"|\S+)/;

// Hard per-line cap: base64 dumps / minified stacks stay linear through masking.
const MAX_LINE = 4000;
// Pretty-printed JSON objects span multiple lines; cap so a stream that never
// closes its braces doesn't buffer forever.
const MAX_JSON_BUF = 200;

const LEVEL_MAP: Record<string, Level> = {
  FATAL: 'ERROR',
  PANIC: 'ERROR',
  CRITICAL: 'ERROR',
  CRIT: 'ERROR',
  ERROR: 'ERROR',
  ERR: 'ERROR',
  WARNING: 'WARN',
  WARN: 'WARN',
  INFO: 'INFO',
  DEBUG: 'DEBUG',
  TRACE: 'DEBUG',
};

export const SEVERITY: Record<Level, number> = { ERROR: 0, WARN: 1, OTHER: 2, INFO: 3, DEBUG: 4 };

// Time histogram: fixed bucket count, bucket width doubles (buckets merge
// pairwise) whenever a timestamp lands past the end — constant memory per
// signature regardless of input span. Rendered as a sparkline.
export const HIST_BUCKETS = 120;

// Epoch ms for the timestamp formats TS_PREFIX / parseJson produce; syslog
// has no year, assume the current one.
export function toEpoch(ts: string): number | undefined {
  const syslog = /^[A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2}$/.test(ts);
  const t = syslog ? Date.parse(`${ts.replace(/ {2,}/g, ' ')} ${new Date().getFullYear()}`) : Date.parse(ts);
  return Number.isNaN(t) ? undefined : t;
}

/** Stable signature id: sha1(`${level} ${template}`), 4 hex chars. */
export function sigId(level: Level, template: string): string {
  return createHash('sha1').update(`${level} ${template}`).digest('hex').slice(0, 4);
}

interface Parsed {
  ts?: string;
  level: Level;
  message: string;
}

function levelFromString(s: string): Level | undefined {
  const m = LEVEL_RE.exec(s.toUpperCase());
  return m ? LEVEL_MAP[m[1]] : undefined;
}

// pino/bunyan numeric levels: 10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal
function levelFromNumber(n: number): Level {
  if (n >= 50) return 'ERROR';
  if (n >= 40) return 'WARN';
  if (n >= 30) return 'INFO';
  return 'DEBUG';
}

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

// JSON-lines (pino, bunyan, zap, logrus, slog, structlog…): trust the fields
// instead of regex-guessing, and drop the envelope from the template. Also
// handles pretty-printed objects joined across lines by the caller.
function parseJson(raw: string): Parsed | undefined {
  if (raw[0] !== '{' || raw[raw.length - 1] !== '}') return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const o = obj as Record<string, unknown>;

  const rawLevel = pick(o, ['level', 'lvl', 'severity', 'levelname']);
  let level: Level = 'OTHER';
  if (typeof rawLevel === 'number') level = levelFromNumber(rawLevel);
  else if (typeof rawLevel === 'string') level = levelFromString(rawLevel) ?? 'OTHER';

  const rawTs = pick(o, ['time', 'timestamp', 'ts', '@timestamp', 'asctime']);
  let ts: string | undefined;
  if (typeof rawTs === 'string') ts = rawTs;
  else if (typeof rawTs === 'number' && Number.isFinite(rawTs)) {
    // seconds vs milliseconds epoch
    const ms = rawTs < 1e11 ? rawTs * 1000 : rawTs;
    ts = new Date(ms).toISOString();
  }

  const msg = pick(o, ['msg', 'message', 'event', 'log']);
  const err = pick(o, ['err', 'error', 'exception']);
  const errText =
    typeof err === 'string'
      ? err
      : err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string'
        ? ((err as Record<string, unknown>).message as string)
        : undefined;

  let message = typeof msg === 'string' ? msg : msg !== undefined ? JSON.stringify(msg) : '';
  if (errText && !message.includes(errText)) message = message ? `${message}: ${errText}` : errText;
  // Nothing recognisable: fall back to the raw object so the line isn't lost.
  if (!message) message = raw;
  return { ts, level, message };
}

// logfmt (level=info msg="…" dur=12ms): a line is logfmt when it starts with
// ≥2 contiguous key=value pairs. level|lvl and time|ts are lifted out; the
// rest stays in order as the message, quotes and all (mask() handles them).
function parseLogfmt(raw: string): Parsed | undefined {
  const pairs: { key: string; raw: string }[] = [];
  let idx = 0;
  while (idx < raw.length) {
    const m = KV_RE.exec(raw.slice(idx));
    if (!m || m.index !== 0) break;
    pairs.push({ key: m[1], raw: m[0] });
    idx += m[0].length;
    while (raw[idx] === ' ') idx++;
  }
  if (pairs.length < 2) return undefined;

  let level: Level = 'OTHER';
  let ts: string | undefined;
  const rest: string[] = [];
  for (const p of pairs) {
    const val = p.raw.slice(p.key.length + 1);
    if ((p.key === 'level' || p.key === 'lvl') && level === 'OTHER') level = levelFromString(val) ?? 'OTHER';
    else if ((p.key === 'time' || p.key === 'ts') && ts === undefined) ts = val.replace(/^"|"$/g, '');
    else rest.push(p.raw);
  }
  return { ts, level, message: rest.join(' ') };
}

function parseText(raw: string): Parsed {
  const tsMatch = TS_PREFIX.exec(raw);
  const ts = tsMatch?.[1];
  let rest = tsMatch ? raw.slice(tsMatch[0].length) : raw;

  let level: Level = 'OTHER';
  const prefix = LEVEL_PREFIX.exec(rest);
  if (prefix) {
    level = LEVEL_MAP[prefix[1].toUpperCase()];
    rest = rest.slice(prefix[0].length);
  } else {
    const m = LEVEL_BODY_RE.exec(rest.slice(0, 120).toUpperCase());
    level = m ? LEVEL_MAP[m[1]] : 'OTHER';
  }
  return { ts, level, message: rest };
}

function tokenize(template: string): string[] {
  return template.split(' ');
}

const isPlaceholder = (t: string): boolean => /^<.*>$/.test(t);

// Merge near-duplicate templates (same level, ≤2 tokens differ) — opt-in
// (`--fuzzy`), bounded to the top 50 signatures per level (O(k²) on that).
function mergeNear(signatures: Signature[]): Signature[] {
  const byLevel = new Map<Level, Signature[]>();
  for (const s of signatures) {
    const arr = byLevel.get(s.level);
    if (arr) arr.push(s);
    else byLevel.set(s.level, [s]);
  }
  const removed = new Set<Signature>();

  for (const sigs of byLevel.values()) {
    const candidates = [...sigs].sort((a, b) => b.count - a.count).slice(0, 50);
    for (let i = 0; i < candidates.length; i++) {
      const a = candidates[i];
      if (removed.has(a)) continue;
      for (let j = i + 1; j < candidates.length; j++) {
        const b = candidates[j];
        if (removed.has(b)) continue;
        const at = tokenize(a.template);
        const bt = tokenize(b.template);
        if (at.length !== bt.length) continue;
        const diffIdx: number[] = [];
        for (let k = 0; k < at.length && diffIdx.length <= 2; k++) if (at[k] !== bt[k]) diffIdx.push(k);
        if (diffIdx.length === 0 || diffIdx.length > 2) continue;

        const winner = a.count >= b.count ? a : b;
        const loser = winner === a ? b : a;
        const wt = tokenize(winner.template);
        const lt = tokenize(loser.template);
        for (const k of diffIdx) wt[k] = isPlaceholder(wt[k]) ? wt[k] : isPlaceholder(lt[k]) ? lt[k] : '<*>';
        winner.template = wt.join(' ');
        winner.count += loser.count;
        winner.id = sigId(winner.level, winner.template);
        if (loser.firstSeen && (!winner.firstSeen || loser.firstSeen < winner.firstSeen)) winner.firstSeen = loser.firstSeen;
        if (loser.lastSeen && (!winner.lastSeen || loser.lastSeen > winner.lastSeen)) winner.lastSeen = loser.lastSeen;
        if (loser.hist) {
          if (!winner.hist) winner.hist = loser.hist;
          else for (let h = 0; h < winner.hist.length; h++) winner.hist[h] += loser.hist[h];
        }
        removed.add(loser);
        if (loser === a) break;
      }
    }
  }
  return signatures.filter((s) => !removed.has(s));
}

export async function cluster(
  lines: Iterable<string | TaggedLine> | AsyncIterable<string | TaggedLine>,
  opts: ClusterOptions = {},
): Promise<ClusterResult> {
  const groups = new Map<string, Signature>();
  const maxSamples = Math.max(1, opts.samples ?? 1);
  const extraMasks = opts.masks ?? [];
  const sampleCap = opts.wide ? 2000 : 300;
  const showLimit = opts.showLimit ?? 20;
  const shown: string[] = [];
  const firstEpoch = new Map<string, number>();
  let total = 0;
  let folded = 0;
  let last: Signature | undefined;
  let lastWasJson = false;
  let time: TimeRange | undefined;

  const bucketOf = (t: number): number => {
    if (!time) time = { start: t, end: t, bucketMs: 1000 };
    if (t < time.start) return 0; // out-of-order (merged streams): clamp
    if (t > time.end) time.end = t;
    let idx = Math.floor((t - time.start) / time.bucketMs);
    while (idx >= HIST_BUCKETS) {
      time.bucketMs *= 2;
      for (const sig of groups.values()) {
        if (!sig.hist) continue;
        const merged = new Array<number>(HIST_BUCKETS).fill(0);
        for (let i = 0; i < HIST_BUCKETS; i++) merged[i >> 1] += sig.hist[i];
        sig.hist = merged;
      }
      idx = Math.floor((t - time.start) / time.bucketMs);
    }
    return idx;
  };

  function handleRecord(raw: string, source: string | undefined): void {
    // JSON-lines never emit stack-trace continuations; an indented line after a
    // JSON record is a new (pretty-printed) record, not a fold target.
    if (last && !lastWasJson && CONTINUATION.test(raw)) {
      folded++;
      if (last.detail === undefined && DETAIL.test(raw)) last.detail = raw.trim().slice(0, 200);
      return;
    }

    const json = parseJson(raw);
    const logfmt = json ? undefined : parseLogfmt(raw);
    lastWasJson = json !== undefined;
    const { ts, level, message } = json ?? logfmt ?? parseText(raw);

    const template = mask(message, extraMasks).replace(/\s+/g, ' ').trim().slice(0, 200);
    const key = `${level} ${template}`;
    const sample = message.trim().slice(0, sampleCap);

    let sig = groups.get(key);
    // sha1 only on first sight of a template — not once per line (hot path).
    if (opts.show && (sig?.id ?? sigId(level, template)) === opts.show && shown.length < showLimit) shown.push(message.trim());
    if (!sig) {
      sig = { id: sigId(level, template), template, level, count: 0, sample };
      if (source) sig.source = source;
      groups.set(key, sig);
    } else if (level === 'ERROR' && maxSamples > 1 && sample !== sig.sample) {
      const extra = (sig.samples ??= []);
      if (extra.length < maxSamples - 1 && !extra.includes(sample)) extra.push(sample);
    }
    sig.count++;
    if (ts) {
      if (!sig.firstSeen) sig.firstSeen = ts;
      sig.lastSeen = ts;
      const t = toEpoch(ts);
      if (t !== undefined) {
        if (!firstEpoch.has(key)) firstEpoch.set(key, t);
        const idx = bucketOf(t);
        (sig.hist ??= new Array<number>(HIST_BUCKETS).fill(0))[idx]++;
      }
    }
    last = sig;
  }

  const countBraces = (s: string): number => {
    let d = 0;
    for (const ch of s) {
      if (ch === '{') d++;
      else if (ch === '}') d--;
    }
    return d;
  };

  let jsonBuf: { raw: string; source: string | undefined }[] | undefined;
  let jsonDepth = 0;

  for await (const line of lines) {
    const tagged = typeof line === 'string' ? { text: line } : line;
    let raw = tagged.text.trimEnd().replace(ANSI_SGR, '');
    if (!raw.trim()) continue;
    total++;

    if (total === 1 && raw.includes('\0')) {
      throw new Error('input looks binary (NUL byte in first line) — refusing to digest');
    }
    if (raw.length > MAX_LINE) raw = `${raw.slice(0, MAX_LINE)}…`;

    let source = tagged.source;
    const podMatch = POD_PREFIX.exec(raw);
    if (podMatch) {
      source = podMatch[1];
      raw = raw.slice(podMatch[0].length);
    }

    if (jsonBuf) {
      jsonBuf.push({ raw, source });
      jsonDepth += countBraces(raw);
      if (jsonDepth <= 0) {
        const buf = jsonBuf;
        jsonBuf = undefined;
        handleRecord(
          buf.map((b) => b.raw).join('\n'),
          buf[0].source,
        );
      } else if (jsonBuf.length >= MAX_JSON_BUF) {
        const buf = jsonBuf;
        jsonBuf = undefined;
        for (const b of buf) handleRecord(b.raw, b.source);
      }
      continue;
    }

    // A line that is (or ends with) an opening brace starts a pretty-printed
    // JSON object — buffer until the braces balance.
    if (raw.trim() === '{' || raw.endsWith('{')) {
      jsonBuf = [{ raw, source }];
      jsonDepth = countBraces(raw);
      continue;
    }

    handleRecord(raw, source);
  }
  if (jsonBuf) {
    const buf: { raw: string; source: string | undefined }[] = jsonBuf;
    for (const b of buf) handleRecord(b.raw, b.source);
  }

  let signatures = [...groups.values()];
  if (opts.fuzzy) signatures = mergeNear(signatures);

  // Rare-signature promotion: a single ERROR occurrence in the last 5% of the
  // stream is the thing that broke — bubble it above high-count noise.
  if (time) {
    const novelFloor = time.start + 0.95 * (time.end - time.start);
    for (const sig of signatures) {
      if (sig.level !== 'ERROR' || sig.count !== 1) continue;
      const epoch = firstEpoch.get(`${sig.level} ${sig.template}`);
      if (epoch !== undefined && epoch >= novelFloor) sig.novel = true;
    }
  }

  signatures.sort(
    (a, b) =>
      SEVERITY[a.level] - SEVERITY[b.level] || (a.novel ? 0 : 1) - (b.novel ? 0 : 1) || b.count - a.count,
  );
  const result: ClusterResult = { lines: total, folded, signatures };
  if (time) result.time = time;
  if (opts.show) result.shown = shown;
  return result;
}
