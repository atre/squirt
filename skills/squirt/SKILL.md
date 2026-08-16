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
1. `squirt … --level warn` — errors/warnings only.
2. Interesting signature? `squirt … --grep '<re>' --sample 5` — more samples of just that one.
3. "What changed since the deploy?" — `squirt diff before.log after.log`, or
   `squirt snap pre` before / `squirt diff pre` after (scoped to cwd, `--scope` to override).
4. Machine-readable: `--json` (schema in README).

## Reading the digest

```
14 signatures · 8,412 lines (96 folded)
[ERROR] ×312  09:14→10:02  ▁▁▂█▃▁▁▁▁▁  pg pool timeout connecting to <ip>
  ↳ pg pool timeout connecting to 10.0.3.4:5432        ← sample (raw)
  ⤷ Caused by: ETIMEDOUT                                ← first root-cause line from the folded stack
```

- Sorted by severity, then count. `<ip> <n> <str> <path> <uuid> <hex> <url> <email>` are masked variables.
- Sparkline = 10 time buckets over the whole input; a spike at the right end
  means "started recently", flat means "always there".
- `[pod-name]` before a sample = which pod (kubectl `--prefix`) or file (`--merge`) it first came from.
- Add ad-hoc masking with `--mask '<re>'` when a variable slips through and splits one signature into many.

## Don't

- Don't raise `--top` above ~40; use `--grep` / `--level` to reach a specific signature.
- Don't paste the digest back with raw lines appended — the digest is the artifact.
