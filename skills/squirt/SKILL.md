---
name: squirt
description: Compress raw logs into a compact signature digest before reading them. Use whenever log output (kubectl/docker/journalctl/files/CI) would exceed ~200 lines — pipe it through `squirt` instead of reading raw lines into context.
---

# squirt — keep raw logs out of context

Raw logs are ~95% duplicates. `squirt` clusters them into templates
(`×count`, severity, sparkline, first/last-seen, one sample, root cause) so
you read ~20 lines instead of thousands. Never `cat`/`tail -n 2000` a log
into context when squirt is available.

## Do this

```sh
kubectl logs -n <ns> deploy/<name> --since=1h | squirt        # or: squirt k8s -n <ns> deploy/<name> --since 1h
docker logs <ctr> 2>&1 | squirt                                # or: squirt docker <ctr> --since 1h
squirt journal <unit> --since -1h                              # journalctl -u
squirt /var/log/app.log --level warn                           # files; "-" = stdin, mixable
squirt <file> --tokens 800                                     # hard budget: digest shrinks to fit
```

Triage flow:
1. `squirt … --level warn` — errors/warnings only. Or `squirt … --brief` for a
   ≤10-line red-only digest that's silent when nothing is at warn+.
2. Interesting signature? `squirt … --grep '<re>' --sample 5` — more samples of just that one.
   Or grab its id from the digest (`#a3f1`) and `squirt … --show a3f1` to dump the raw lines behind it.
3. "What changed since the deploy?" — `squirt diff before.log after.log`, or
   `squirt snap pre` before / `squirt diff pre` after (scoped to cwd, `--scope` to override).
4. Machine-readable: `--json` (schema in README). CI gate: `--fail-on error` exits 1 if any
   visible signature is ERROR or worse.

## Reading the digest

```
14 signatures · 8,412 lines (96 folded)
[ERROR] #a3f1 ×312 (4%)  09:14→10:02  ▁▁▂█▃▁▁▁▁▁  pg pool timeout connecting to <ip>
  ↳ pg pool timeout connecting to 10.0.3.4:5432        ← sample (raw)
  ⤷ Caused by: ETIMEDOUT                                ← first root-cause line from the folded stack
```

- Sorted by severity, then count (a lone ERROR very late in the stream bubbles
  above high-count noise — likely the thing that broke). `<ip> <n> <str>
  <path> <uuid> <hex> <sha> <b64> <ts> <v> <url> <email>` are masked variables.
- `#a3f1` is a stable id (same input → same id) — pass it to `--show` to drill in.
- Sparkline = 10 time buckets over the whole input; a spike at the right end
  means "started recently", flat means "always there".
- `[pod-name]` before a sample = which pod (kubectl `--prefix`) or file (`--merge`) it first came from.
- Add ad-hoc masking with `--mask '<re>'` when a variable slips through and splits one signature into many.
  `--fuzzy` merges near-duplicate templates (same level, ≤2 tokens differ) as a broader net.

## Don't

- Don't raise `--top` above ~40; use `--grep` / `--level` to reach a specific signature.
- Don't paste the digest back with raw lines appended — the digest is the artifact.

## Guard hook

If raw `kubectl logs` / `docker logs` / `journalctl` keeps landing in context
anyway, install the guard once: `squirt init --claude` (or `--global`). It
rewrites those commands to pipe through squirt automatically and only blocks
when a rewrite would be unsafe (`-f`/`--follow`). `squirt guard-stats` shows
how many dumps it's prevented.
