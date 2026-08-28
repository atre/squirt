export interface GuardStats {
  /** rewritten + blocked */
  total: number;
  rewritten: number;
  blocked: number;
}

/**
 * Count tally guard.log lines at or after `sinceMs`. Line shape:
 * `<ISO ts> <hook> <blocked|rewritten>`; only `pre-bash` lines count —
 * that hook owns the log-dump rewrite (squirt's own guard retired 2026-08-23).
 */
export function guardStats(logText: string, sinceMs: number): GuardStats {
  const stats: GuardStats = { total: 0, rewritten: 0, blocked: 0 };
  for (const line of logText.split('\n')) {
    const [ts, hook, kind] = line.split(' ');
    if (!ts || hook !== 'pre-bash') continue;
    const t = Date.parse(ts);
    if (Number.isNaN(t) || t < sinceMs) continue;
    stats.total++;
    if (kind === 'rewritten') stats.rewritten++;
    else stats.blocked++;
  }
  return stats;
}

const DURATION_RE = /^(\d+)([smhd])$/;

/** Parse "7d" / "12h" / "30m" / "45s" into milliseconds. */
export function parseDuration(s: string): number {
  const m = DURATION_RE.exec(s);
  if (!m) throw new Error(`--since expects <n>[smhd], got ${JSON.stringify(s)}`);
  const n = Number(m[1]);
  const unit: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return n * unit[m[2]];
}
