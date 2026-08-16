# squirt

[![CI](https://github.com/atre/squirt/actions/workflows/ci.yml/badge.svg)](https://github.com/atre/squirt/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Log triage compressor. Pipe in thousands of raw log lines, get back a ~20-line
digest: unique message templates with counts, severity, a time sparkline, and
first/last-seen.
Built so an AI session (or a human) reads the digest instead of the firehose —
2,000 lines become 20, and the rare error buried on page 7 surfaces to the top.

## Install

Node ≥ 20. Straight from GitHub (not on npm):

```bash
npm install -g github:atre/squirt
```

Or from source: `git clone … && cd squirt && npm install && npm link`.

## Usage

```
kubectl logs -n scrap deploy/scraper --since=1h | squirt
docker logs api 2>&1 | squirt --json
squirt /var/log/app.log --top 10 --level warn

squirt k8s -n scrap deploy/scraper --since 1h     # runs kubectl logs (--prefix --timestamps --all-containers)
squirt docker api --since 1h                      # runs docker logs (stdout+stderr, --timestamps)
squirt journal nginx --since -1h                  # runs journalctl -u nginx

squirt diff before.log after.log                  # what's new / grown in after.log
squirt snap pre-deploy < before.log               # save a baseline (scoped to cwd, --scope to override)
squirt diff pre-deploy < after.log                # compare against it
```

Output:

```
14 signatures · 8,412 lines (96 folded)
[ERROR] ×312  09:14→10:02  ▁▁▂█▃▁▁▁▁▁  pg pool timeout connecting to <ip>
  ↳ pg pool timeout connecting to 10.0.3.4:5432
  ⤷ Caused by: ETIMEDOUT
[WARN] ×2,100  09:00→10:02  ▅▆▅▅▄▆█▃▅▆  retry <n> of <n> for job <n>
...
```

`squirt diff`:

```
1 new · 0 grown · 2 gone · 4 unchanged  (vs before.log; after: 674 lines)
[ERROR] +×30  09:59  ▁▁▁▁▁▁▁▁▁█  redis: connection refused <ip>
  ↳ redis: connection refused 10.0.4.1:6379
```

`+` = new signature, `×5→×120` = count grew ≥3× (and ≥5).

## How it works

1. JSON lines (pino, zap, logrus, slog…): take `level`/`msg`/`time` from the
   object. Otherwise strip a leading timestamp (ISO, `[…]`, syslog — kept for
   first/last-seen) and the leading level token.
2. Mask variables — uuids, urls, emails, quoted strings, paths, ips, hex ids,
   numbers — so lines that differ only in data collapse into one template.
   ANSI colour and kubectl `--prefix` pod tags are stripped first.
3. Fold stack-trace continuation lines into the signature above them; the
   first `Caused by:` / `FooError:` line is surfaced as `⤷` detail.
4. Bucket timestamps into a sparkline (10 buckets over the whole input:
   right-edge spike = "started recently", flat = "always there").
5. Sort by severity, then count. `--json` for machine consumption.

## Flags

| Flag | Meaning |
|---|---|
| `--json` | machine-readable output |
| `--top <n>` | max signatures shown (default 20) |
| `--level <lvl>` | minimum severity: `error`, `warn`, `other`, `info`, `debug` |
| `--grep <re>` | only signatures whose template or sample matches |
| `--sample <n>` | keep up to n distinct samples for ERROR signatures |
| `--tokens <n>` | budget mode: drop non-error samples, then shrink `--top`, until the digest fits ~n tokens (chars/4) |
| `--mask <re>` | extra masking rule, repeatable; matches become `<mask>` |
| `--merge` | multi-file input: tag samples with the source file (`↳ [api.log] …`) |
| `--scope <s>` | snapshot scope for `snap`/`diff` (default: cwd) |
| `-` | read stdin (can be mixed with files, once) |

## `--json` schema

Stable within a major version; new fields may be added, existing ones are not
renamed or removed.

```jsonc
{
  "lines": 8412, "folded": 96, "totalSignatures": 14,
  "time": { "start": "…ISO…", "end": "…ISO…" },        // absent if no timestamps
  "signatures": [{                                     // top N, sorted
    "template": "pg pool timeout connecting to <ip>",
    "level": "ERROR",                                  // ERROR|WARN|OTHER|INFO|DEBUG
    "count": 312,
    "firstSeen": "…", "lastSeen": "…",                 // as written in the log
    "sample": "…", "samples": ["…"],                   // samples: extras from --sample
    "detail": "Caused by: ETIMEDOUT",                  // first root-cause continuation line
    "source": "api-7f9",                               // pod (kubectl --prefix) or file (--merge)
    "spark": [0,0,1,9,2,0,0,0,0,0]                     // ≤10 time buckets over the input span
  }]
}
```

`squirt diff --json`: `{ baseline, lines, unchanged, gone: [{template, level, count}],
changes: [signature + { change: "new"|"grown", before: <count> }] }`.
Snapshots live in `~/.squirt/<scope>-<hash>/<name>.json` (`SQUIRT_HOME` overrides).

## For AI sessions

`skills/squirt/SKILL.md` is a drop-in Claude Code skill ("when logs > 200
lines, pipe through squirt"); `.claude-snippet.md` is the two-line CLAUDE.md
version. The value only materialises if the agent reaches for squirt on its
own — install one of them.

## Status

Phases 1–4 of [PLAN.md](PLAN.md) shipped: digest, sources, diff/snap,
filters, sparkline, token budget. Phase 5 is the ideas backlog.

## Development

```
npm install
npm run build   # tsc → dist/
npm test        # node --test
npm link        # install the `squirt` command globally
```

Zero runtime dependencies — Node ≥ 20 built-ins only.
