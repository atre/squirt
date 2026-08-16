/** Count guard.log lines ("<ISO ts> <command>") at or after `sinceMs`. */
export function guardStats(logText: string, sinceMs: number): number {
  let count = 0;
  for (const line of logText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space === -1) continue;
    const t = Date.parse(line.slice(0, space));
    if (!Number.isNaN(t) && t >= sinceMs) count++;
  }
  return count;
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
