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
// instead of regex-guessing, and drop the envelope from the template.
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

export async function cluster(
  lines: Iterable<string | TaggedLine> | AsyncIterable<string | TaggedLine>,
  opts: ClusterOptions = {},
): Promise<ClusterResult> {
  const groups = new Map<string, Signature>();
  const maxSamples = Math.max(1, opts.samples ?? 1);
  const extraMasks = opts.masks ?? [];
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

  for await (const line of lines) {
    const tagged = typeof line === 'string' ? { text: line } : line;
    let raw = tagged.text.trimEnd().replace(ANSI_SGR, '');
    if (!raw.trim()) continue;
    total++;

    let source = tagged.source;
    const podMatch = POD_PREFIX.exec(raw);
    if (podMatch) {
      source = podMatch[1];
      raw = raw.slice(podMatch[0].length);
    }

    // JSON-lines never emit stack-trace continuations; an indented line after a
    // JSON record is a new (pretty-printed) record, not a fold target.
    if (last && !lastWasJson && CONTINUATION.test(raw)) {
      folded++;
      if (last.detail === undefined && DETAIL.test(raw)) last.detail = raw.trim().slice(0, 200);
      continue;
    }

    const json = parseJson(raw);
    lastWasJson = json !== undefined;
    const { ts, level, message } = json ?? parseText(raw);

    const template = mask(message, extraMasks).replace(/\s+/g, ' ').trim().slice(0, 200);
    const key = `${level} ${template}`;
    const sample = message.trim().slice(0, 300);

    let sig = groups.get(key);
    if (!sig) {
      sig = { template, level, count: 0, sample };
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
        const idx = bucketOf(t);
        (sig.hist ??= new Array<number>(HIST_BUCKETS).fill(0))[idx]++;
      }
    }
    last = sig;
  }

  const signatures = [...groups.values()].sort(
    (a, b) => SEVERITY[a.level] - SEVERITY[b.level] || b.count - a.count,
  );
  const result: ClusterResult = { lines: total, folded, signatures };
  if (time) result.time = time;
  return result;
}
