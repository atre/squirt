# squirt — plan

The problem: debugging sessions start with `kubectl logs` / `docker logs` /
tailing files. Thousands of raw lines are ~95% duplicates, the rare error is
buried, and in an AI session every line costs context tokens. squirt compresses
the firehose into a signature digest once, at the source.

## Phase 1 — core (scaffolded)

- [x] stdin + file input
- [x] timestamp strip + first/last-seen per signature
- [x] severity guess (FATAL/PANIC/ERR→ERROR, etc.)
- [x] variable masking: uuid, url, email, ip, hex, number
- [x] stack-trace continuation folding
- [x] text digest + `--json`, `--top`
- [x] JSON-lines log detection: if a line parses as JSON, use its
      `level`/`msg`/`time` fields instead of regex guessing
- [x] bracketed / syslog timestamps; leading level token stripped from template
- [x] streaming input (readline) — constant memory on big files

## Phase 2 — sources

Shell out so users don't have to remember the incantation:

- `squirt k8s -n <ns> [deploy/<name>] [--since 1h]` → `kubectl logs`
  (multi-pod: merge streams, tag signature samples with pod name)
- `squirt docker <container> [--since 1h]` → `docker logs`
- `squirt journal <unit>` → `journalctl -u`

## Phase 3 — baseline diff

The single highest-value debugging question is "what's new since the deploy":

- `squirt snap <name>` — save the current signature set (`~/.squirt/<name>.json`,
  keyed by cwd or an explicit `--scope`)
- `squirt diff <name>` — digest input, show only signatures absent from the
  snapshot (or with a large count jump)

## Phase 4 — niceties

- `--level warn` minimum-severity filter
- time-bucketed sparkline per signature (spot "started at 09:14")
- `--merge` for multi-file input with per-file provenance
- custom mask rules via `~/.squirt/rules` (append-only, same order caveat)

## Non-goals

- Not a log store or shipper — one-shot compression only.
- No daemon, no config file required, no runtime npm deps.
