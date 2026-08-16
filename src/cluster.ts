import { mask } from './mask.js';
import type { ClusterResult, Level, Signature } from './types.js';

// Leading timestamp, optionally wrapped in [] — ISO 8601 (kubectl --timestamps,
// most app loggers) or syslog "Aug 16 09:18:00". Followed by separator junk.
const TS_PREFIX =
  /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|[A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2})\]?[\s:|-]*/;
const LEVEL_RE = /\b(FATAL|PANIC|CRITICAL|CRIT|ERROR|ERR|WARNING|WARN|INFO|DEBUG|TRACE)\b/;
// The level token when it is the leading decoration of the message:
// "ERROR msg", "[error] msg", "level=info msg", "app.ERROR: msg", "INFO: msg".
const LEVEL_PREFIX =
  /^(?:\[?(?:level|lvl|severity)=)?[\[(]?(?:[\w.]+\.)?(FATAL|PANIC|CRITICAL|CRIT|ERROR|ERR|WARNING|WARN|INFO|DEBUG|TRACE)[\])]?:?\s+/i;
// Stack-trace bodies and wrapped lines attach to the signature above them
// instead of polluting the digest with one-off "signatures".
const CONTINUATION = /^(\s+\S|at |Caused by|Traceback|\.\.\.|File ")/;

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

const SEVERITY: Record<Level, number> = { ERROR: 0, WARN: 1, OTHER: 2, INFO: 3, DEBUG: 4 };

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
    level = levelFromString(rest.slice(0, 120)) ?? 'OTHER';
  }
  return { ts, level, message: rest };
}

export async function cluster(lines: Iterable<string> | AsyncIterable<string>): Promise<ClusterResult> {
  const groups = new Map<string, Signature>();
  let total = 0;
  let folded = 0;
  let last: Signature | undefined;

  for await (const line of lines) {
    const raw = line.trimEnd();
    if (!raw.trim()) continue;
    total++;

    if (last && CONTINUATION.test(raw)) {
      folded++;
      continue;
    }

    const { ts, level, message } = parseJson(raw) ?? parseText(raw);

    const template = mask(message).replace(/\s+/g, ' ').trim().slice(0, 200);
    const key = `${level} ${template}`;

    let sig = groups.get(key);
    if (!sig) {
      sig = { template, level, count: 0, sample: message.trim().slice(0, 300) };
      groups.set(key, sig);
    }
    sig.count++;
    if (ts) {
      if (!sig.firstSeen) sig.firstSeen = ts;
      sig.lastSeen = ts;
    }
    last = sig;
  }

  const signatures = [...groups.values()].sort(
    (a, b) => SEVERITY[a.level] - SEVERITY[b.level] || b.count - a.count,
  );
  return { lines: total, folded, signatures };
}
