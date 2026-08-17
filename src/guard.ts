export interface GuardStats {
  /** rewritten + blocked */
  total: number;
  rewritten: number;
  blocked: number;
}

/**
 * Count guard.log lines at or after `sinceMs`. Line shape: `<ISO ts> rewrite|block <command>`;
 * lines from older guards (`<ISO ts> <command>`, no kind) count as blocks.
 */
export function guardStats(logText: string, sinceMs: number): GuardStats {
  const stats: GuardStats = { total: 0, rewritten: 0, blocked: 0 };
  for (const line of logText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space === -1) continue;
    const t = Date.parse(line.slice(0, space));
    if (Number.isNaN(t) || t < sinceMs) continue;
    stats.total++;
    if (line.startsWith('rewrite ', space + 1)) stats.rewritten++;
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
