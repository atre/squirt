# squirt

Log triage compressor. Pipe in thousands of raw log lines, get back a ~20-line
digest: unique message templates with counts, severity, and first/last-seen.
Built so an AI session (or a human) reads the digest instead of the firehose —
2,000 lines become 20, and the rare error buried on page 7 surfaces to the top.

## Usage

```
kubectl logs -n scrap deploy/scraper --since=1h | squirt
docker logs api 2>&1 | squirt --json
squirt /var/log/app.log --top 10
```

Output:

```
14 signatures · 8,412 lines · 96 continuation lines folded
[ERROR] ×312  09:14→10:02  pg pool timeout connecting to <ip>
  ↳ pg pool timeout connecting to 10.0.3.4:5432
[WARN] ×2,100  09:00→10:02  retry <n> of <n> for job <n>
...
```

## How it works

1. JSON lines (pino, zap, logrus, slog…): take `level`/`msg`/`time` from the
   object. Otherwise strip a leading timestamp (ISO, `[…]`, syslog — kept for
   first/last-seen) and the leading level token.
2. Mask variables — uuids, urls, emails, ips, hex ids, numbers — so lines that
   differ only in data collapse into one template.
3. Fold stack-trace continuation lines into the signature above them.
4. Sort by severity, then count. `--json` for machine consumption.

## Flags

| Flag | Meaning |
|---|---|
| `--json` | machine-readable output |
| `--top <n>` | max signatures shown (default 20) |

## Status

MVP: stdin + file input only. Direct `k8s` / `docker` sources and baseline
diffing ("what's new since the deploy") are next — see [PLAN.md](PLAN.md).

## Development

```
npm install
npm run build   # tsc → dist/
npm test        # node --test
npm link        # install the `squirt` command globally
```

Zero runtime dependencies — Node ≥ 20 built-ins only.
